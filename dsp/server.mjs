// OpenAI 兼容网关 + 管理面（http 原生实现，无第三方依赖）
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig, ensureAssets } from './config.mjs';
import { AccountPool, NEW_UUID } from './accounts.mjs';
import { Upstream } from './upstream.mjs';
import { ModelRegistry, UPSTREAM_TYPES } from './models.mjs';
import { runChat, stripToolMarkers } from './chat.mjs';
import { UpstreamError } from './errors.mjs';
import { openAIChunk, sseData, SSE_DONE } from './sse.mjs';
import { createBrowserResolver } from './browser.mjs';
import { metrics } from './metrics.mjs';
import { listProviders } from './providers/index.mjs';
import { anthropicToMessages, buildMessage, anthropicStream } from './anthropic.mjs';
import './providers/manual.mjs';

const cfg = loadConfig();

// PoW 依赖是第三方产物，不随仓库分发
const assetsCheck = ensureAssets();
if (!assetsCheck.ok) {
  console.error('缺少 PoW 依赖：', assetsCheck.missing.join(', '));
  console.error('先运行：node scripts/fetch-assets.mjs');
}
const pool = new AccountPool(cfg).load();
const models = new ModelRegistry(cfg);
const upstream = new Upstream(cfg, { registry: models });
const browser = createBrowserResolver(cfg);
const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin/ui.html');

const log = (...a) => {
  if (process.env.DS_PROXY_QUIET) return;
  console.log(`[${new Date().toISOString()}]`, ...a);
};

// ── 管理面 token ─────────────────────────────────────────────
const ADMIN_TOKEN_FILE = path.join(ROOT, 'secrets/admin.token');
function loadAdminToken() {
  if (process.env.DS_ADMIN_TOKEN) return process.env.DS_ADMIN_TOKEN;
  try {
    const t = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch { /* 生成 */ }
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(ADMIN_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}
const ADMIN_TOKEN = loadAdminToken();

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};

function authOk(req) {
  if (!cfg.apiKeys.length) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const xkey = String(req.headers['x-api-key'] || '');
  return cfg.apiKeys.includes(bearer) || cfg.apiKeys.includes(xkey);
}

function adminOk(req, url) {
  const h = String(req.headers['x-admin-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(h);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024 * 1024) throw new UpstreamError({ status: 413, code: 'BODY_TOO_LARGE', msg: 'body too large' });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UpstreamError({ status: 400, code: 'BAD_JSON', msg: 'invalid json body' }); }
}

const completionId = () => 'chatcmpl-' + crypto.randomBytes(12).toString('hex');

/**
 * OpenAI reasoning_effort → 上游 thinking_enabled
 * 上游网页版只有「开/关」两态，没有强度分级，所以 low/medium/high/max 都映射为 true。
 * @returns {boolean|null} null = 用模型默认
 */
function mapEffortToThinking(effort) {
  if (effort === undefined || effort === null || effort === '') return null;
  const v = String(effort).toLowerCase();
  // 两档：Default(不思考) / Medium(深度思考)。上游网页版只有开关两态，没有强度分级。
  if (v === 'default' || v === 'none' || v === 'off' || v === 'disabled' || v === 'false') return false;
  return true;
}

// ── 聊天 ────────────────────────────────────────────────────
async function handleChat(req, res) {
  const body = await readBody(req);
  const model = body.model || 'deepseek-chat';
  const stream = body.stream !== false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const search = Boolean(body.search ?? body.web_search ?? body.extra_body?.search);
  // 思考强度：reasoning_effort / thinking / extra_body.reasoning_effort
  const effortRaw = body.reasoning_effort ?? body.extra_body?.reasoning_effort ?? body.thinking?.effort ?? null;
  const thinking = mapEffortToThinking(effortRaw);

  if (!models.resolve(model)) {
    return json(res, 400, { error: { message: `unknown model: ${model}`, type: 'invalid_request_error' } });
  }

  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  metrics.recordRequest({ model, stream });

  let servedBy = null;
  const tools = Array.isArray(body.tools) ? body.tools : null;
  const iter = runChat({
    pool, upstream, browser, model, messages, search, thinking, tools,
    signal: controller.signal,
    log: (tag, data) => { if (tag === 'session') servedBy = data.account; log(tag, JSON.stringify(data)); },
    onFinish: (acc) => { servedBy = acc; },
  });

  if (!stream) {
    let content = '';
    let reasoning = '';
    let usage = null;
    let finish = 'stop';
    let toolCall = null;
    try {
      for await (const part of iter) {
        if (part.content) content += part.content;
        if (part.reasoning) reasoning += part.reasoning;
        if (part.usage) usage = part.usage;
        if (part.toolCall) toolCall = part.toolCall;
        if (part.finish) finish = part.finish;
      }
    } catch (e) {
      const err = e instanceof UpstreamError ? e : new UpstreamError({ status: 502, msg: e.message });
      metrics.recordError({ code: err.codeName, msg: err.msg ?? '', account: servedBy, model, ms: Date.now() - t0 });
      return json(res, err.status === 401 ? 401 : 502, err.toOpenAI());
    }
    metrics.recordOk({ model, ms: Date.now() - t0, tokens: usage?.completion_tokens ?? 0, account: servedBy, preview: content.slice(0, 80) });
    const message = { role: 'assistant', content: toolCall ? null : stripToolMarkers(content) };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCall) {
      const list = Array.isArray(toolCall) ? toolCall : [toolCall];
      message.tool_calls = list.map((c) => ({
        id: 'call_' + crypto.randomBytes(8).toString('hex'),
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    return json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (obj) => res.write(sseData(obj));
  let textLen = 0;

  try {
    write(openAIChunk({ id, model, delta: { role: 'assistant', content: '' } }));
    let usage = null;
    let buffered = '';
    let toolCall = null;
    let pendingFinish = null;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    for await (const part of iter) {
      if (part.reasoning) write(openAIChunk({ id, model, delta: { reasoning_content: part.reasoning } }));
      if (part.content) {
        textLen += part.content.length;
        buffered += part.content;
        // 带 tools 时整段缓冲（工具调用标记可能跨 chunk，半截吐出去会污染客户端）
        if (!hasTools) write(openAIChunk({ id, model, delta: { content: part.content } }));
      }
      if (part.toolCall) toolCall = part.toolCall;
      if (part.usage) usage = part.usage;
      if (part.finish) pendingFinish = part.finish;
    }
    if (toolCall) {
      const list = Array.isArray(toolCall) ? toolCall : [toolCall];
      write(openAIChunk({
        id, model,
        delta: {
          tool_calls: list.map((c, i) => ({
            index: i,
            id: 'call_' + crypto.randomBytes(8).toString('hex'),
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        },
      }));
      write(openAIChunk({ id, model, delta: {}, finishReason: 'tool_calls' }));
    } else {
      if (hasTools && buffered) {
        // 缓冲了但最终不是工具调用（模型正常聊天）→ 补发
        const clean = stripToolMarkers(buffered);
        if (clean) write(openAIChunk({ id, model, delta: { content: clean } }));
      }
      write(openAIChunk({ id, model, delta: {}, finishReason: pendingFinish || 'stop' }));
    }
    if (usage) write({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    metrics.recordOk({ model, ms: Date.now() - t0, tokens: usage?.completion_tokens ?? 0, account: servedBy, preview: `${textLen} chars` });
    res.write(SSE_DONE);
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError({ status: 502, msg: e.message });
    log('stream_error', err.codeName, err.message);
    metrics.recordError({ code: err.codeName, msg: err.msg ?? '', account: servedBy, model, ms: Date.now() - t0 });
    write(err.toOpenAI());
    res.write(SSE_DONE);
  } finally {
    res.end();
  }
}

// ── 网页登录通道：把 chat.deepseek.com 的登录页反代到本机，登录后自动回收 token ──
// 目的：用户不用手动复制 token。页面在我们域下（127.0.0.1:8787），
// 登录成功后 localStorage 里的 userToken 我们能直接读。
const UPSTREAM_ORIGIN = 'https://chat.deepseek.com';
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; }
})();
const PROXY_LOG = path.join(process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh'), 'dsh-web-proxy', 'proxy.log');

const CAPTURE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin', 'capture.js');
function captureScript() {
  try {
    return `<script data-ds-proxy-capture>\n${fs.readFileSync(CAPTURE_FILE, 'utf8')}\n</script>`;
  } catch {
    return '';
  }
}

const FE_STATIC = 'https://fe-static.deepseek.com/chat';

function rewriteHtml(html) {
  // 静态资源改走本机（手机上 CDN 常常加载不出来 → SRI 兜底页）
  html = html.split(FE_STATIC + '/').join('/cd/').split(FE_STATIC + '"').join('/cd/"');
  if (html.includes('data-ds-proxy-capture')) return html;
  const script = captureScript();
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, (m) => m + script);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, script + '</head>');
  return script + html;
}

async function proxyStatic(req, res, url) {
  const rest = url.pathname.replace(/^\/cd\/?/, '');
  const target = `${FE_STATIC}/${rest}${url.search || ''}`;
  const headers = {
    'user-agent': cfg.upstream.userAgent,
    accept: '*/*',
    referer: UPSTREAM_ORIGIN + '/',
  };
  let upstreamRes;
  try {
    upstreamRes = await fetch(target, { headers, redirect: 'follow' });
  } catch (e) {
    return json(res, 502, { error: 'static fetch failed', detail: e.message });
  }
  const out = {
    'content-type': upstreamRes.headers.get('content-type') || 'application/octet-stream',
    'cache-control': 'public, max-age=3600',
  };
  const len = upstreamRes.headers.get('content-length');
  const buf = Buffer.from(await upstreamRes.arrayBuffer());
  out['content-length'] = buf.length;
  res.writeHead(upstreamRes.status, out);
  res.end(buf);
}

async function proxyLogin(req, res, url, { injectHtml = true } = {}) {
  if (url.pathname === '/login/debug' && req.method === 'POST') {
    try {
      const b = await readBody(req);
      fs.appendFileSync(PROXY_LOG, `${new Date().toISOString()} DEBUG ${JSON.stringify(b).slice(0, 500)}\n`);
    } catch { /* ignore */ }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/login/capture' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.token) return json(res, 400, { ok: false, error: 'missing token' });
    const acc = pool.upsert({
      id: NEW_UUID().slice(0, 8),
      name: body.name || '网页登录',
      token: body.token,
      deviceId: body.deviceId || NEW_UUID(),
      userAgent: body.ua || '',
    });
    pool.save();
    return json(res, 200, { ok: true, account: acc.snapshot() });
  }

  const stripped = url.pathname.replace(/^\/login\/?/, '');
  const upstreamPath = (stripped.startsWith('/') ? stripped : '/' + stripped) + (url.search || '');
  const target = UPSTREAM_ORIGIN + upstreamPath;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (['host', 'origin', 'referer', 'accept-encoding', 'connection', 'content-length'].includes(lk)) continue;
    headers[k] = v;
  }
  // WAF 会按 UA 拦（curl/空 UA 直接 429），这里统一用干净的浏览器 UA 出站
  headers['user-agent'] = cfg.upstream.userAgent;
  headers.accept = headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  headers['accept-language'] = headers['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8';
  headers.host = 'chat.deepseek.com';
  headers.origin = UPSTREAM_ORIGIN;
  headers.referer = UPSTREAM_ORIGIN + '/';
  // cookie：我们域收到的就是上游下发的，原样带回
  if (req.headers.cookie) headers.cookie = req.headers.cookie;

  const bodyless = req.method === 'GET' || req.method === 'HEAD';
  let upstreamRes;
  try {
    upstreamRes = await fetch(target, {
      method: req.method,
      headers,
      body: bodyless ? undefined : req,
      redirect: 'manual',
      duplex: bodyless ? undefined : 'half',
    });
  } catch (e) {
    return json(res, 502, { error: 'upstream unreachable', detail: e.message });
  }

  if (upstreamRes.status >= 400) {
    try {
      fs.appendFileSync(PROXY_LOG, `${new Date().toISOString()} ${upstreamRes.status} ${req.method} ${upstreamPath} block=${upstreamRes.headers.get('block-event-id') || '-'} ua=${headers['user-agent']?.slice(0, 40)}\n`);
    } catch { /* ignore */ }
  }

  const out = {};
  for (const [k, v] of upstreamRes.headers) {
    const lk = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection',
         'content-security-policy', 'content-security-policy-report-only',
         'x-frame-options', 'strict-transport-security', 'set-cookie'].includes(lk)) continue;
    out[k] = v;
  }
  out['cache-control'] = 'no-store';
  const rawCookies = upstreamRes.headers.getSetCookie?.() ?? [];
  if (rawCookies.length) {
    out['set-cookie'] = rawCookies.map((c) =>
      c.replace(/;\s*Domain=[^;]+/gi, '').replace(/;\s*Secure/gi, '').replace(/;\s*SameSite=[^;]+/gi, '; SameSite=Lax'));
  }
  if (out.location) out.location = out.location.replace(/^https:\/\/chat\.deepseek\.com/, '');

  const ct = upstreamRes.headers.get('content-type') || '';
  if (injectHtml && ct.includes('text/html')) {
    const text = await upstreamRes.text();
    const patched = rewriteHtml(text);
    const buf = Buffer.from(patched, 'utf8');
    out['content-type'] = ct;
    out['content-length'] = buf.length;
    res.writeHead(upstreamRes.status, out);
    return res.end(buf);
  }

  res.writeHead(upstreamRes.status, out);
  if (upstreamRes.body) {
    for await (const chunk of upstreamRes.body) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
  }
  res.end();
}

// ── Anthropic Messages 兼容 ──────────────────────────────────
async function handleMessages(req, res) {
  const body = await readBody(req);
  const model = body.model || 'deepseek-chat';
  const stream = body.stream !== false;
  const messages = anthropicToMessages(body);
  const id = 'msg_' + crypto.randomBytes(8).toString('hex');
  const t0 = Date.now();
  const controller = new AbortController();
  req.on('close', () => controller.abort());
  metrics.recordRequest({ model, stream });

  let servedBy = null;
  const iter = runChat({
    pool, upstream, browser, model, messages,
    search: Boolean(body.search),
    thinking: mapEffortToThinking(body.reasoning_effort ?? body.thinking?.effort),
    tools: Array.isArray(body.tools) ? body.tools : null,
    signal: controller.signal,
    log: (tag, data) => { if (tag === 'session') servedBy = data.account; },
    onFinish: (acc) => { servedBy = acc; },
  });

  if (!stream) {
    let text = '';
    let reasoning = '';
    let usage = null;
    try {
      for await (const part of iter) {
        if (part.content) text += part.content;
        if (part.reasoning) reasoning += part.reasoning;
        if (part.usage) usage = part.usage;
      }
    } catch (e) {
      const err = e instanceof UpstreamError ? e : new UpstreamError({ status: 502, msg: e.message });
      metrics.recordError({ code: err.codeName, msg: err.msg ?? '', account: servedBy, model, ms: Date.now() - t0 });
      return json(res, 502, { type: 'error', error: { type: 'api_error', message: err.codeName + ': ' + (err.msg ?? err.message) } });
    }
    metrics.recordOk({ model, ms: Date.now() - t0, tokens: usage?.completion_tokens ?? 0, account: servedBy, preview: text.slice(0, 80) });
    return json(res, 200, buildMessage({ id, model, text, reasoning, usage }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let chars = 0;
  try {
    for await (const chunk of anthropicStream({ id, model, iterator: iter })) {
      chars += chunk.length;
      res.write(chunk);
    }
    metrics.recordOk({ model, ms: Date.now() - t0, tokens: 0, account: servedBy, preview: 'anthropic stream' });
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError({ status: 502, msg: e.message });
    metrics.recordError({ code: err.codeName, msg: err.msg ?? '', account: servedBy, model, ms: Date.now() - t0 });
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.codeName } })}\n\n`);
  } finally {
    res.end();
  }
}

// ── 管理 API ────────────────────────────────────────────────
function configView() {
  return {
    host: cfg.host,
    port: cfg.port,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    powRefreshMarginMs: cfg.powRefreshMarginMs,
    apiKeysCount: cfg.apiKeys.length,
    browser: { enabled: cfg.browser.enabled, cdpUrl: cfg.browser.cdpUrl, headless: cfg.browser.headless },
    accountsFile: cfg.accountsFile,
    powCacheSize: upstream.powCache.size,
  };
}

function saveSettings(patch) {
  const file = path.join(ROOT, 'config.json');
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
  const next = { ...disk };
  if (patch.models) next.models = models.all();
  for (const k of ['rateLimitPerMinute', 'powRefreshMarginMs', 'apiKeys', 'host', 'port']) {
    if (patch[k] !== undefined) { next[k] = patch[k]; cfg[k] = patch[k]; }
  }
  if (patch.browser) {
    next.browser = { ...(disk.browser ?? {}), ...patch.browser };
    Object.assign(cfg.browser, patch.browser);
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return configView();
}

async function handleAdmin(req, res, url) {
  const p = url.pathname.replace(/^\/admin\/api/, '');
  const method = req.method;

  if (p === '/ping') return json(res, 200, { ok: true, needsAuth: true });

  if (!adminOk(req, url)) return json(res, 401, { error: 'admin token 无效' });

  if (method === 'GET' && p === '/overview') {
    return json(res, 200, {
      config: configView(),
      accounts: pool.snapshots(),
      metrics: metrics.snapshot(),
      browser: { enabled: browser.enabled },
      providers: listProviders(),
      models: models.all(),
      upstreamTypes: UPSTREAM_TYPES,
    });
  }

  if (method === 'GET' && p === '/logs') {
    return json(res, 200, { logs: metrics.logs(Number(url.searchParams.get('limit') ?? 100)) });
  }

  if (method === 'GET' && p === '/export') {
    // 导出含明文 token，需要显式确认参数，避免误触
    if (url.searchParams.get('confirm') !== '1') {
      return json(res, 400, { error: '导出包含明文 token，请加 ?confirm=1 明确确认' });
    }
    const accounts = pool.all().map((a) => ({ id: a.id, name: a.name, token: a.token, deviceId: a.deviceId, cookies: a.cookies, enabled: a.enabled }));
    const body = JSON.stringify({ accounts }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="accounts.export.json"' });
    return res.end(body);
  }

  if (method === 'POST' && p === '/accounts/import') {
    const body = await readBody(req);
    const items = Array.isArray(body.accounts) ? body.accounts : [body];
    const created = [];
    for (const raw of items) {
      if (!raw?.token) continue;
      const acc = pool.upsert({
        id: raw.id || NEW_UUID().slice(0, 8),
        name: raw.name || '',
        token: raw.token,
        deviceId: raw.deviceId || NEW_UUID(),
        deviceModel: raw.deviceModel || '',
        cookies: raw.cookies || '',
        userAgent: raw.userAgent || '',
      });
      created.push(acc.snapshot());
    }
    pool.save();
    return json(res, 200, { ok: true, created });
  }

  if (method === 'POST' && p === '/cooldowns/clear') {
    const n = pool.clearCooldowns();
    return json(res, 200, { ok: true, cleared: n });
  }

  const m = p.match(/^\/accounts\/([^/]+)(?:\/([a-z-]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const action = m[2] || (method === 'DELETE' ? 'delete' : method === 'PATCH' ? 'patch' : 'get');
    const acc = pool.get(id);
    if (!acc) return json(res, 404, { error: '账号不存在' });

    if (method === 'DELETE' || action === 'delete') {
      pool.remove(id);
      return json(res, 200, { ok: true });
    }
    if (method === 'PATCH' || action === 'patch') {
      const body = await readBody(req);
      if (body.name !== undefined) pool.rename(id, body.name);
      if (body.enabled !== undefined) pool.setEnabled(id, body.enabled);
      return json(res, 200, { ok: true, account: pool.get(id)?.snapshot() });
    }
    if (action === 'probe' && method === 'POST') {
      const t0 = Date.now();
      try {
        const r = await upstream.probe(acc);
        acc.status = 'ready';
        acc.lastError = null;
        pool.save();
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        const err = e instanceof UpstreamError ? e : new UpstreamError({ status: 502, msg: e.message });
        acc.lastError = err.codeName;
        if (err.action === 'refresh_token') acc.status = 'needs_login';
        else if (err.action === 'rotate') acc.cool(err.codeName, 300_000);
        pool.save();
        return json(res, 200, { ok: false, code: err.codeName, msg: err.msg ?? err.message, ms: Date.now() - t0, action: err.action });
      }
    }
    if (action === 'reset-device' && method === 'POST') {
      const a = pool.resetDeviceId(id);
      return json(res, 200, { ok: true, account: a?.snapshot() });
    }
    if (action === 'browser-login' && method === 'POST') {
      if (!browser.enabled) return json(res, 400, { error: '慢路径未启用：先在设置里打开 browser.enabled' });
      try {
        const info = await browser.interactiveLogin(acc);
        pool.save();
        return json(res, 200, { ok: true, ...info, account: acc.snapshot() });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (method === 'GET') return json(res, 200, { account: acc.snapshot() });
  }

  if (method === 'POST' && p === '/settings') {
    const patch = await readBody(req);
    if (patch.models) models.replace(patch.models);
    return json(res, 200, { ok: true, config: saveSettings(patch), models: models.all() });
  }

  if (method === 'POST' && p === '/browser/test') {
    try {
      const b = await browser.interactiveLogin({ deviceId: NEW_UUID() }, { timeoutMs: 20_000 });
      return json(res, 200, { ok: true, ...b });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  return json(res, 404, { error: 'unknown admin route' });
}

// ── HTTP ───────────────────────────────────────────────────
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** 本机回环来源放行（插件内嵌设置页要跨端口 fetch） */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && LOOPBACK_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-token,authorization');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      const html = fs.readFileSync(UI_FILE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (url.pathname.startsWith('/admin/api')) return await handleAdmin(req, res, url);
    if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return await proxyLogin(req, res, url);
    if (url.pathname.startsWith('/cd/')) return await proxyStatic(req, res, url);
    // 登录页依赖的同源资源：上游 API 与静态文件（不注入脚本，纯透传）
    if (url.pathname.startsWith('/api/v0/') || url.pathname.startsWith('/static/')
        || url.pathname === '/manifest.json' || url.pathname === '/favicon.ico') {
      return await proxyLogin(req, res, url, { injectHtml: false });
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      return json(res, 200, {
        ok: true,
        accounts: pool.snapshots(),
        browser: { enabled: browser.enabled },
        models: models.list().map((m) => m.id),
        version: PKG_VERSION,
        loginProxy: true,
        metrics: { requests: metrics.requests, ok: metrics.ok, errors: metrics.errors },
        // 本机回环：给内嵌管理界面自动登录用（只绑 127.0.0.1）
        adminToken: req.headers.host?.startsWith('127.0.0.1') || req.headers.host?.startsWith('localhost') ? ADMIN_TOKEN : undefined,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: models.list().map((m) => ({ id: m.id, object: 'model', owned_by: 'deepseek-web', label: m.label })),
      });
    }
    if (url.pathname.startsWith('/v1/') && !authOk(req)) {
      return json(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await handleChat(req, res);
    // Anthropic Messages：/v1/messages 与 /anthropic/v1/messages 都收（DSH 的 baseURL 指向后者）
    if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/anthropic/v1/messages')) {
      return await handleMessages(req, res);
    }

    return json(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError({ status: 500, msg: e.message });
    if (!res.headersSent) return json(res, 500, err.toOpenAI());
    try { res.end(); } catch { /* ignore */ }
  }
}

/**
 * 定时探活：token 失效时把账号标成 needs_login，别让状态一直假装 ready
 */
function scheduleHealthCheck(ctx) {
  const run = async () => {
    for (const acc of pool.all()) {
      if (!acc.token || !acc.enabled) continue;
      try {
        await upstream.probe(acc);
        if (acc.status !== 'ready') acc.status = 'ready';
        acc.lastError = null;
      } catch (e) {
        const code = e?.codeName ?? e?.code ?? 'PROBE_FAILED';
        acc.lastError = code;
        if (code === 'INVALID_TOKEN' || code === 'MISSING_TOKEN') acc.status = 'needs_login';
      }
    }
    try { pool.save(); } catch { /* ignore */ }
  };
  setTimeout(run, 2500).unref?.();
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

/**
 * 启动反代（可被其它进程复用：DSH 插件就是走这个入口）
 * @param {{port?:number, host?:string, accountsFile?:string, env?:object}} overrides
 */
export function createProxy(overrides = {}) {
  if (overrides.port) cfg.port = overrides.port;
  if (overrides.host) cfg.host = overrides.host;
  if (overrides.accountsFile) cfg.accountsFile = overrides.accountsFile;

  scheduleHealthCheck();
  const server = http.createServer(handler);
  let listenError = null;
  server.on('error', (e) => { listenError = e; });
  server.listen(cfg.port, cfg.host);
  log(`ds-web-proxy listening on http://${cfg.host}:${cfg.port}`);
  log(`管理界面: http://${cfg.host}:${cfg.port}/admin   (token: ${ADMIN_TOKEN})`);
  return {
    server, cfg, pool, upstream, models, metrics, adminToken: ADMIN_TOKEN,
    get listenError() { return listenError; },
  };
}

// 直接 `node src/server.mjs` 跑时自动启动
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createProxy();
  log(`accounts loaded: ${pool.all().length} (file: ${cfg.accountsFile})`);
  if (!cfg.apiKeys.length) log('notice: apiKeys 为空，/v1 不校验网关 key（仅建议本机使用）');
  process.on('SIGINT', () => { log('shutting down'); server.close(() => process.exit(0)); });
}
