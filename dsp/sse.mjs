// DeepSeek Web SSE 解析 + delta(op/path/value) 应用 + OpenAI 兼容块生成
//
// 上游协议（来自前端产物）：
//   事件: ready | delta | close | finish | title | toast | update_session | hint | ...
//   delta.data 是 JSON-Patch 风格操作数组: [{op:"SET"|"APPEND", path:"/fragments/0/content", value:"..."}]

/** @returns {AsyncGenerator<{event:string, data:any}>} */
export async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  let event = '';
  let dataLines = [];

  const flush = () => {
    if (!dataLines.length && !event) return null;
    const raw = dataLines.join('\n');
    let data = raw;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* 保留原始文本 */ }
    const evt = { event: event || 'message', data };
    event = '';
    dataLines = [];
    return evt;
  };

  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        const evt = flush();
        if (evt) yield evt;
        continue;
      }
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      // 其余（id:/retry:/注释行）忽略
    }
  }
  const tail = flush();
  if (tail) yield tail;
}

export function applyPatch(root, op) {
  if (!op || typeof op !== 'object') return root;
  // 批量补丁
  if (op.o === 'BATCH' || op.op === 'BATCH') {
    const list = Array.isArray(op.v) ? op.v : Array.isArray(op.p) ? op.p : [];
    for (const sub of list) applyPatch(root, sub);
    return root;
  }
  const rawPath = op.p ?? op.path;
  if (!rawPath || typeof rawPath !== 'string') return root;

  const tokens = rawPath.split('/').filter((t) => t !== '');
  if (!tokens.length) return root;

  const step = (obj, key) => {
    if (obj == null) return null;
    if (key === '-1') return Array.isArray(obj) ? obj[obj.length - 1] : undefined;
    return obj[key];
  };

  let cur = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i] === '-1' && Array.isArray(cur) ? cur.length - 1 : tokens[i];
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
    if (cur == null) return root;
  }

  const lastKey = tokens[tokens.length - 1] === '-1' && Array.isArray(cur)
    ? cur.length - 1
    : tokens[tokens.length - 1];

  const kind = String(op.o ?? op.op ?? 'SET').toUpperCase();
  const value = op.v !== undefined ? op.v : op.value;

  if (kind === 'APPEND' || kind === 'append') {
    const prev = cur[lastKey];
    if (typeof prev === 'string') cur[lastKey] = prev + (value == null ? '' : String(value));
    else if (Array.isArray(prev)) prev.push(...(Array.isArray(value) ? value : [value]));
    else cur[lastKey] = value;
  } else {
    cur[lastKey] = value;
  }
  return root;
}

/** 兼容旧名 */
export const applyOp = applyPatch;

/** 从 DeepSeek 网页版消息对象里取正文/思考 */
export function extractText(msg) {
  const resp = msg && msg.response ? msg.response : msg;
  if (!resp || typeof resp !== 'object') return { content: '', reasoning: '' };
  let content = '';
  let reasoning = '';
  const frags = Array.isArray(resp.fragments) ? resp.fragments : [];
  for (const f of frags) {
    if (!f || typeof f !== 'object') continue;
    const type = String(f.type ?? '').toUpperCase();
    const text = typeof f.content === 'string' ? f.content : '';
    if (!text) continue;
    if (type.includes('THINK')) reasoning += text;
    else content += text;
  }
  if (!content && typeof resp.content === 'string') content = resp.content;
  if (!reasoning && typeof resp.thinking_content === 'string') reasoning = resp.thinking_content;
  return { content, reasoning };
}

export const sseData = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
export const SSE_DONE = 'data: [DONE]\n\n';

export function openAIChunk({ id, model, delta, finishReason = null, index = 0 }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index, delta, finish_reason: finishReason }],
  };
}
