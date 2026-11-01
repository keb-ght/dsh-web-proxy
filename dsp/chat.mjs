// OpenAI 请求 → DeepSeek Web 会话编排（含重试/熔断/慢路径唤醒）
import { applyPatch, extractText } from './sse.mjs';
import { parseToolCalls, stripMarkers } from './tool-parser.mjs';
import { prepareImages } from './vision.mjs';
import fs from 'node:fs';
import path from 'node:path';

const DBG_FILE = path.join(process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh'), 'dsh-web-proxy', 'tool-debug.log');
let dbgBytes = 0;
function dbg(tag, obj) {
  try {
    if (dbgBytes === 0) { try { dbgBytes = fs.statSync(DBG_FILE).size; } catch { dbgBytes = 0; } }
    if (dbgBytes > 2 * 1024 * 1024) {           // 超过 2MB 轮转，避免长期运行撑爆磁盘
      fs.renameSync(DBG_FILE, DBG_FILE + '.1');
      dbgBytes = 0;
    }
    const line = `${new Date().toISOString()} ${tag} ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`;
    fs.appendFileSync(DBG_FILE, line);
    dbgBytes += Buffer.byteLength(line);
  } catch { /* ignore */ }
}
import { UpstreamError } from './errors.mjs';

/**
 * 把 OpenAI tools 定义转成提示词协议注入（网页版没有原生 function calling）
 * 模型按约定输出 ```json {"tool":"name","arguments":{...}} ``` 我们再翻译成 tool_calls
 */
const TOOL_START = '<|tool▁calls▁begin|>';
const TOOL_END = '<|tool▁calls▁end|>';

/** 归一化：全角 ｜ → |，▁(U+2581) → _ */
const normTag = (t) => String(t).replace(/\uFF5C/g, '|').replace(/\u2581/g, '_');

/**
 * 把 OpenAI tools 定义转成提示词（网页版没有原生 function calling）
 * 采用 DeepSeek 生态通用的工具调用标记协议，模型输出：
 *   <|tool▁calls▁begin|>[{"name":"bash","arguments":{...}}]<|tool▁calls▁end|>
 */
const CALL_PREFIX = '@@CALL@@';

/** 把模型各种写法的调用对象归一成 {name, arguments(JSON字符串)} */
function normalizeCall(c) {
  if (!c || typeof c !== 'object') return null;
  const name = c.tool ?? c.name ?? c.function?.name;
  if (typeof name !== 'string' || !name) return null;
  let args = c.arguments ?? c.args ?? c.function?.arguments;
  if (args === undefined || args === null) {
    // 模型常把参数拍平到顶层：{"tool":"bash","command":"ls"}
    const { tool, name: _n, function: _f, arguments: _a, args: _r, ...rest } = c;
    args = rest;
  }
  return { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
}

/**
 * 工具菜单：给模型一份"按钮清单"，调用时按一下即可。
 * 不写禁则、不要求记特殊 token —— 越简单越不容易写错。
 */
/**
 * 工具清单：只告诉模型「有什么能用」，不教格式。
 * 模型能自然输出的就让它照常输出；解析器在下面宽容匹配各种形态。
 * 只有参数结构复杂的工具，才补一行参数说明（相当于给它一个"按钮"）。
 */
/**
 * 工具提示词：菜单 + **确定的调用格式**（必须给可照抄的样例，否则模型不知道按钮长什么样）
 */
export function toolsToPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const menu = tools.map((t) => {
    const f = t.function || t;
    const required = f.parameters?.required ?? [];
    const props = f.parameters?.properties ?? {};
    const keys = Object.keys(props);
    const paramText = keys.length
      ? keys.map((k) => `${k}${required.includes(k) ? '(必填)' : ''}:${props[k]?.type ?? 'any'}`).join(', ')
      : '无参数';
    const desc = f.description ? String(f.description).split('\n')[0].slice(0, 50) : '';
    return `- ${f.name}（${paramText}）${desc ? ' — ' + desc : ''}`;
  });

  const first = tools[0].function || tools[0];
  const firstKey = Object.keys(first.parameters?.properties ?? {})[0] ?? 'input';
  const exampleArg = firstKey === 'command' ? 'ls -la /root' : firstKey === 'file_path' ? '/etc/hosts' : '...';

  return [
    '【可用工具】',
    ...menu,
    '',
    '【调用格式 — 需要调用工具时必须照这个写】',
    '只输出一个 JSON 代码块，不要加解释：',
    '```json',
    `{"tool":"${first.name}","arguments":{"${firstKey}":"${exampleArg}"}}`,
    '```',
    '一次调用多个工具时，写成一个 JSON 数组：',
    '```json',
    `[{"tool":"${first.name}","arguments":{"${firstKey}":"${exampleArg}"}}]`,
    '```',
    '关键点：`tool` 写工具名，`arguments` 是参数对象，外层用 ```json 包住。',
    '不需要工具时，直接用自然语言回答，不要输出 JSON 代码块。',
  ].join('\n');
}

/**
 * 从模型输出里提取工具调用
 * 兼容：标记块 / 全角变体 / 下划线变体 / markdown 代码块 / 裸 JSON
 */
export function extractToolCall(text, toolsOrNames = []) {
  const defs = Array.isArray(toolsOrNames) ? toolsOrNames : [];
  const toolNames = defs.map((t) => (typeof t === 'string' ? t : (t.function || t).name)).filter(Boolean);
  const firstParamOf = (name) => {
    const d = defs.find((t) => typeof t !== 'string' && ((t.function || t).name === name));
    const f = d ? (d.function || d) : null;
    const req = f?.parameters?.required ?? [];
    const props = f?.parameters?.properties ?? {};
    return req[0] ?? Object.keys(props)[0] ?? 'input';
  };
  if (!text || typeof text !== 'string') return null;
  const norm = normTag(text);

  // ① 标记协议（ds-free-api 移植版：数组/单对象/XML invoke/JSON修复）
  const tagged = parseToolCalls(text);
  if (tagged && tagged.calls.length) {
    return tagged.calls.length === 1 ? tagged.calls[0] : tagged.calls;
  }

  // ①.0 新协议：@@CALL@@ {...}（可能多行）
  const lineCalls = [...norm.matchAll(/@@CALL@@\s*(\{[\s\S]*?\})(?=\s*@@CALL@@|\s*$|\n)/g)];
  if (lineCalls.length) {
    const calls = lineCalls.map((m) => {
      try { return normalizeCall(JSON.parse(m[1])); } catch { return null; }
    }).filter(Boolean);
    if (calls.length) return calls.length === 1 ? calls[0] : calls;
  }

  // ① 标记包裹（主路径）
  const starts = [normTag(TOOL_START), '<|tool_calls_begin|>', '<|tool_call_begin|>', '<tool_calls>', '<tool_call>'];
  const ends = [normTag(TOOL_END), '<|tool_calls_end|>', '<|tool_call_end|>', '</tool_calls>', '</tool_call>'];
  for (let i = 0; i < starts.length; i++) {
    const a = norm.indexOf(starts[i]);
    if (a < 0) continue;
    const bodyStart = a + starts[i].length;
    const b = norm.indexOf(ends[i], bodyStart);
    const body = (b >= 0 ? norm.slice(bodyStart, b) : norm.slice(bodyStart)).trim();
    // 从 body 里找 JSON 数组
    const arr = body.match(/\[[\s\S]*\]/);
    if (arr) {
      try {
        const parsed = JSON.parse(arr[0]);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const calls = list.map(normalizeCall).filter(Boolean);
        if (calls.length) return calls.length === 1 ? calls[0] : calls;
      } catch { /* 继续尝试其它路径 */ }
    }
  }

  // ①.0 「工具名: `参数`」/「工具名 → 参数」（shell 风格，参数是字符串而非 JSON）
  if (toolNames.length) {
    for (const name of toolNames) {
      const reTick = new RegExp(`(?:^|\\n)[\\s>*\`-]*${name}\\s*[:：]\\s*\`([^\`]+)\``, 'i');
      const mt = norm.match(reTick);
      if (mt && mt[1].trim()) {
        return { name, arguments: JSON.stringify({ [firstParamOf(name)]: mt[1].trim() }) };
      }
    }
    for (const name of toolNames) {
      const re = new RegExp(`(?:^|\\n)[\\s>*\`-]*${name}\\s*(?:→|->|=>)\\s*(.+)$`, 'im');
      const m = norm.match(re);
      if (!m) continue;
      const val = m[1].trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
      if (!val || val.startsWith('{')) continue;
      return { name, arguments: JSON.stringify({ [firstParamOf(name)]: val }) };
    }
  }

  // ①.2 「工具名: {json}」/「工具名({json})」/「工具名 => {json}」
  if (Array.isArray(toolNames) && toolNames.length) {
    const hits = [];
    for (const name of toolNames) {
      const re = new RegExp(`(?:^|\\n)[\\s>*\`-]*${name}\\s*(?:\\(|:\\s*|=>\\s*)(\\{[\\s\\S]*?\\})`, 'i');
      const m = norm.match(re);
      if (!m) continue;
      try { hits.push(normalizeCall({ tool: name, ...JSON.parse(m[1]) })); } catch { /* 跳过 */ }
    }
    const clean = hits.filter(Boolean);
    if (clean.length) return clean.length === 1 ? clean[0] : clean;
  }

  // ①.5 类 DSML / XML 变体（模型常见幻觉格式）
  const xml = extractXmlToolCalls(norm);
  if (xml) return xml;

  // ② markdown 代码块 / 裸 JSON（兜底）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidates = [];
  if (fence) for (const b of fence) candidates.push(b.replace(/```(?:json)?/g, '').trim());
  candidates.push(text.trim());
  for (const raw of candidates) {
    const m = raw.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[0]);
      let list = Array.isArray(parsed) ? parsed : [parsed];
      // JSON 里没写工具名 → 用正文里出现的已知工具名补（模型常写「调用工具：bash」再给参数）
      const hasName = list.some((c) => c && (c.tool || c.name || c.function?.name));
      if (!hasName && Array.isArray(toolNames) && toolNames.length) {
        const found = toolNames.find((n) => new RegExp(`(^|[^\\w-])${n}([^\\w-]|$)`, 'i').test(norm));
        if (found) list = list.map((c) => ({ tool: found, ...c }));
      }
      const calls = list.map(normalizeCall).filter(Boolean);
      if (calls.length) return calls.length === 1 ? calls[0] : calls;
    } catch { /* 不是 JSON */ }
  }
  return null;
}

/**
 * 解析 DSML / XML 风格的工具调用（模型幻觉格式兜底）
 * 形如：<|DSML|>invoke name="bash"><|DSML|>parameter name="command">ls</|DSML|>parameter></|DSML|>invoke>
 */
export function extractXmlToolCalls(norm) {
  const body = norm.match(/<\|DSML\|>\s*calls?>([\s\S]*?)(?:<\|DSML\|>\s*\/?calls?>|<\/\|DSML\|>\s*calls>|$)/i);
  const scope = body ? body[1] : norm;
  const invokes = [...scope.matchAll(/<\|DSML\|>\s*invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)(?=<\|DSML\|>\s*invoke\s+name|<\/\|DSML\|>\s*invoke|$)/gi)];
  if (!invokes.length) return null;
  const calls = [];
  for (const [, name, inner] of invokes) {
    const args = {};
    for (const m of inner.matchAll(/<\|DSML\|>\s*parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)(?:<\/\|DSML\|>\s*parameter|$)/gi)) {
      const val = m[2].trim();
      try { args[m[1]] = JSON.parse(val); } catch { args[m[1]] = val; }
    }
    calls.push({ name, arguments: JSON.stringify(args) });
  }
  return calls.length === 1 ? calls[0] : calls;
}

/** 清理输出里残留的畸形标记（解析失败时避免污染客户端） */
export function stripToolMarkers(text) {
  if (!text || typeof text !== 'string') return text;
  return stripMarkers(text);
}

function legacyStrip(text) {
  const n = normTag(text);
  return n
    // 新协议的调用行（解析失败时清掉，别当正文透传）
    .replace(/^\s*@@CALL@@.*$/gm, '')
    // 含 DSML / tool_call / antml / function_call 关键词的尖括号片段，连同尾巴 calls>/invoke> 一起删
    .replace(/<[^<>]{0,40}(DSML|tool[_ ]?call|antml|function_call)[^<>]{0,40}>\s*(calls?>|invoke>|parameter>)?/gi, '')
    .replace(/<\|tool_calls?_?(begin|end)\|>/gi, '')
    .replace(/<\/?tool_calls?>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 OpenAI messages 里提取图片 URL（data URL 或 http） */
export function extractImageUrls(messages = []) {
  const urls = [];
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'image_url') {
        const u = part.image_url?.url ?? part.image_url;
        if (typeof u === 'string') urls.push(u);
      }
      if (part.type === 'input_image' && typeof part.image_url === 'string') urls.push(part.image_url);
    }
  }
  return urls;
}

/** OpenAI messages → 单条 prompt（网页版只有一个输入框，历史要拍平） */
export function messagesToPrompt(messages = [], tools = null) {
  const sys = [];
  const history = [];
  let current = '';

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const text = typeof m.content === 'string' ? m.content : textOf(m.content);

    if (m.role === 'system') { if (text.trim()) sys.push(text); continue; }

    // 工具结果：agent loop 第二轮就是靠这个继续的，绝不能丢
    if (m.role === 'tool') {
      const label = m.name || m.tool_call_id || 'tool';
      // 语义标记必须明确：模型会把这层 JSON 误当成下一轮调用参数（实测踩过 3 次）
      history.push(`【${label} 的执行结果 — 仅供阅读，不要把它当作下一次调用的参数】\n${text}\n【结果结束】`);
      continue;
    }

    // 带工具调用的 assistant 历史
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c) => `${c.function?.name}(${c.function?.arguments ?? '{}'})`).join(', ');
      history.push(`Assistant 调用了工具: ${calls}`);
      if (text.trim()) history.push(`Assistant: ${text}`);
      continue;
    }

    if (m.role === 'assistant') { history.push(`Assistant: ${text}`); continue; }

    // 最后一条 user 是当前输入（原文直接接在系统提示词后）
    const isLast = i === messages.length - 1;
    if (m.role === 'user') {
      if (isLast) current = text.trim();
      else history.push(`User: ${text}`);
      continue;
    }
  }

  const toolBlock = toolsToPrompt(tools);
  const sysBlock = sys.join('\n\n');
  const parts = [];
  if (toolBlock) parts.push(toolBlock);
  if (sysBlock) parts.push(sysBlock);
  if (history.length) parts.push(history.join('\n\n'));
  if (current) parts.push(current);
  return parts.join('\n\n');
}

function textOf(content) {
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n');
  return content == null ? '' : String(content);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 生成 OpenAI 兼容的 token 流。
 * @returns {AsyncGenerator<{content?:string, reasoning?:string, finish?:string, usage?:object}>}
 */
export async function* runChat({ pool, upstream, browser, model, messages, search = false, thinking = null, tools = null, signal, log = () => {}, onFinish = () => {} }) {
  const prompt = messagesToPrompt(messages, tools);
  if (tools && tools.length) dbg('PROMPT', { n: tools.length, names: tools.map((t) => (t.function || t).name).slice(0, 8) });
  if (!prompt.trim()) throw new UpstreamError({ status: 400, code: 'EMPTY_PROMPT', msg: 'prompt is empty' });

  const imageCache = new Map();   // accountId → fileIds，重试复用
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const acc = pool.pick();
    if (!acc) {
      const waitMs = Math.min(3000, 300 * (attempt + 1));
      await sleep(waitMs);
      lastErr = lastErr ?? new UpstreamError({ status: 429, code: 429, msg: 'no_available_account' });
      continue;
    }
    acc.inflight++;
    try {
      if (!acc.cookies) await upstream.bootstrap(acc);
      // 多模态：图片只传一次（上传结果按账号+URL 缓存，重试不重复传）
      const imageUrls = extractImageUrls(messages);
      if (imageUrls.length && !imageCache.has(acc.id)) {
        const ids = await prepareImages(upstream, acc, imageUrls, log);
        imageCache.set(acc.id, ids);
        log('images_prepared', { count: ids.length, wanted: imageUrls.length });
      }
      const refFileIds = imageCache.get(acc.id) ?? null;
      const session = await upstream.createSession(acc, acc.token);
      log('session', { account: acc.id, sessionId: session.id, model });

      const state = {};
      let sentContent = '';
      let sentReasoning = '';
      let fullText = '';
      let sawAnyEvent = false;
      let finished = false;

      for await (const evt of upstream.completion(acc, acc.token, {
        sessionId: session.id,
        prompt,
        model,
        search,
        thinking,          // null = 用模型默认；true/false = 强制开关
        refFileIds,
        signal,
      })) {
        sawAnyEvent = true;
        if (evt.event === 'ready') {
          log('ready', { responseMessageId: evt.data?.response_message_id, modelType: evt.data?.model_type });
          continue;
        }
        // 真实协议：event=message，data 是 {v:{response:...}} 全量 或 {p,o,v} 增量补丁
        if (evt.event === 'message' || evt.event === 'delta') {
          const d = evt.data || {};
          if (d.v && typeof d.v === 'object' && d.v.response) {
            Object.assign(state, d.v);            // 首包全量 {v:{response:...}}
          } else if (d.p) {
            applyPatch(state, d);                 // 带路径的增量补丁 {p,o,v}
          } else if (d.v !== undefined && typeof d.v === 'string') {
            // 简写增量：{"v":"二"} —— 直接追加到最后一个 fragment，没有 p 字段
            const frags = state.response && Array.isArray(state.response.fragments) ? state.response.fragments : null;
            if (frags && frags.length) {
              const last = frags[frags.length - 1];
              last.content = (typeof last.content === 'string' ? last.content : '') + d.v;
            } else if (state.response) {
              state.response.content = (typeof state.response.content === 'string' ? state.response.content : '') + d.v;
            }
          } else if (Array.isArray(d)) {
            for (const op of d) applyPatch(state, op);   // 旧格式兼容
          }
          const { content, reasoning } = extractText(state);
          if (reasoning.length > sentReasoning.length) {
            yield { reasoning: reasoning.slice(sentReasoning.length) };
            sentReasoning = reasoning;
          }
          if (content.length > sentContent.length) {
            yield { content: content.slice(sentContent.length) };
            sentContent = content;
            fullText = content;
          }
          continue;
        }
        if (evt.event === 'update_parent_message' || evt.event === 'update_file') continue;
        if (evt.event === 'toast') {
          const type = evt.data?.type;
          if (type === 'error' || type === 'warning') {
            throw new UpstreamError({ status: 200, code: evt.data?.finish_reason ?? 'TOAST_ERROR', msg: evt.data?.content ?? 'upstream toast error' });
          }
          log('toast', evt.data);
          continue;
        }
        if (evt.event === 'hint') {
          if (evt.data?.type === 'error') {
            throw new UpstreamError({ status: 200, code: 'HINT_ERROR', msg: evt.data?.content ?? 'upstream hint error' });
          }
          continue;
        }
        if (evt.event === 'title' || evt.event === 'update_session') { log(evt.event, evt.data); continue; }
        if (evt.event === 'finish') {
          finished = true;
          const usage = normalizeUsage(evt.data);
          if (usage) yield { usage };
          continue;
        }
        if (evt.event === 'close') {
          log('close', evt.data);
          const reason = evt.data?.close_behavior ?? evt.data?.close_reason;
          if (reason === 'retry') {
            throw new UpstreamError({ status: 200, code: 'CLOSE_RETRY', msg: 'upstream asked for retry' });
          }
          continue;
        }
      }
      if (tools && tools.length) dbg('OUTPUT', { len: fullText.length, raw: fullText.slice(0, 500) });
      // 空响应（模型什么都没吐）：重试一次，别把空消息交给客户端
      if (!fullText.trim() && attempt < 2) {
        log('empty_response', { attempt, sessionId: session.id });
        acc.inflight--;
        await sleep(300);
        continue;
      }
      acc.lastError = null;
      onFinish(acc);
      const tc = extractToolCall(fullText, Array.isArray(tools) ? tools : []);
      if (tools && tools.length) dbg('PARSED', tc);
      if (tc) {
        yield { toolCall: tc };
        yield { finish: 'tool_calls' };
      } else {
        yield { finish: 'stop' };
      }
      return;
    } catch (e) {
      lastErr = e;
      acc.lastError = e.message;
      const action = e instanceof UpstreamError ? e.action : 'fatal';
      log('error', { account: acc.id, code: e.code ?? e.codeName, action, msg: e.message });

      if (action === 'rotate') acc.cool(e.codeName ?? 'rotate', 120_000);
      else if (action === 'refresh_token') acc.status = 'needs_login';
      else if (action === 'challenge') {
        // 慢路径：真浏览器过一次人机验证，回填 token/smid/cookie
        if (browser?.enabled) {
          try {
            await browser.resolveChallenge(acc);
            continue;
          } catch (be) {
            log('browser_failed', { msg: be.message });
          }
        }
        acc.cool('challenge_required', 300_000);
      } else if (action === 'retry_pow') {
        // upstream.completion 内部已重算过一次，这里只做短退避
        await sleep(200);
      } else if (e?.status === 429) {
        acc.cool('waf_429', 90_000);
      } else {
        await sleep(200);
      }
      if (action === 'fatal') break;
    } finally {
      acc.inflight--;
    }
  }
  throw lastErr ?? new UpstreamError({ status: 502, code: 'NO_ACCOUNT', msg: 'no account could serve the request' });
}

function normalizeUsage(data) {
  if (!data || typeof data !== 'object') return null;
  const acc = data.accumulated_token_usage ?? data.token_usage ?? data.usage;
  if (typeof acc === 'number') {
    return { prompt_tokens: 0, completion_tokens: acc, total_tokens: acc };
  }
  if (acc && typeof acc === 'object') {
    const prompt = acc.prompt_tokens ?? acc.input_tokens ?? 0;
    const completion = acc.completion_tokens ?? acc.output_tokens ?? 0;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }
  return null;
}
