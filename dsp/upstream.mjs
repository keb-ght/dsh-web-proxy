// 上游客户端：chat.deepseek.com 网页版 API
import { UpstreamError, bizError } from './errors.mjs';
import { solveChallenge, buildPowHeader } from './pow/solver.mjs';
import { loadConfig } from './config.mjs';
import { parseSSE } from './sse.mjs';

import { ModelRegistry } from './models.mjs';

// 兼容旧引用：默认映射（真实映射由 ModelRegistry 从 config 解析）
export const MODEL_MAP = Object.fromEntries(
  new ModelRegistry({}).all().map((m) => [m.id, { modelType: m.upstream, thinking: m.thinking }]),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Upstream {
  constructor(cfg = loadConfig(), { powCache, registry } = {}) {
    this.cfg = cfg;
    this.registry = registry ?? new ModelRegistry(cfg);
    this.base = cfg.upstream.baseUrl.replace(/\/$/, '');
    this.powCache = powCache ?? new Map(); // key: `${accountId}|${targetPath}`
  }

  baseHeaders(account, { token, json = false } = {}) {
    const u = this.cfg.upstream;
    const h = {
      'User-Agent': account?.userAgent || u.userAgent,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Referer: `${this.base}/`,
      Origin: this.base,
      'x-client-platform': u.platform,
      'x-client-version': account?.clientVersion || u.clientVersion,
      'x-client-bundle-id': u.bundleId,
      'x-client-locale': u.locale,
      'x-client-timezone-offset': String(u.timezoneOffsetSeconds),
    };
    if (account?.deviceId) h['x-device-id'] = account.deviceId;
    if (account?.deviceModel) h['x-device-model'] = account.deviceModel;
    if (account?.cookies) h.Cookie = account.cookies;
    if (json) h['Content-Type'] = 'application/json';
    // 关键：/chat/completion 缺少 Authorization 会被华为云 WAF 直接 429
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  absorbCookies(account, res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    if (!raw.length) return;
    const jar = new Map(
      String(account.cookies || '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((kv) => {
          const i = kv.indexOf('=');
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
    );
    for (const c of raw) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    account.cookies = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(account, path, { method = 'POST', body, token, signal, stream = false, extraHeaders = {} } = {}) {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: { ...this.baseHeaders(account, { token, json: body !== undefined }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: 'manual',
    });
    this.absorbCookies(account, res);

    if (res.status === 429) {
      const text = await res.text().catch(() => '');
      throw new UpstreamError({
        status: 429,
        code: 429,
        msg: /Rate Limit/i.test(text) ? 'waf_rate_limited' : 'waf_blocked',
        body: text.slice(0, 300),
        path,
      });
    }
    if (stream) return res;

    const text = await res.text();
    if (!res.ok && !text.trim().startsWith('{')) {
      throw new UpstreamError({ status: res.status, code: res.status, msg: text.slice(0, 200), path });
    }
    let json;
    try { json = JSON.parse(text); } catch { throw new UpstreamError({ status: res.status, code: res.status, msg: 'bad_json', body: text.slice(0, 200), path }); }
    const err = bizError(path, res.status, json);
    if (err) throw err;
    return json;
  }

  /** 首页 GET：拿 ds_session_id 等 WAF/会话 cookie */
  async bootstrap(account) {
    const res = await fetch(`${this.base}/`, { headers: this.baseHeaders(account), redirect: 'manual' });
    this.absorbCookies(account, res);
    if (res.status === 429) throw new UpstreamError({ status: 429, code: 429, msg: 'waf_blocked', path: '/' });
    return { status: res.status };
  }

  async createSession(account, token) {
    const json = await this.request(account, '/api/v0/chat_session/create', { body: {}, token });
    const s = json?.data?.biz_data?.chat_session;
    if (!s?.id) throw new UpstreamError({ status: 200, code: 'NO_SESSION', msg: 'create_session_failed', body: json, path: '/api/v0/chat_session/create' });
    return s;
  }

  /** PoW 挑战：按 (账号, target_path) 缓存，过期前提前刷新 */
  async getPowChallenge(account, token, targetPath, { force = false } = {}) {
    const key = `${account.id}|${targetPath}`;
    const hit = this.powCache.get(key);
    if (!force && hit && hit.expireAt - this.cfg.powRefreshMarginMs > Date.now()) return hit;

    const json = await this.request(account, '/api/v0/chat/create_pow_challenge', { body: { target_path: targetPath }, token });
    const c = json?.data?.biz_data?.challenge;
    if (!c) throw new UpstreamError({ status: 200, code: 'NO_CHALLENGE', msg: 'pow_challenge_missing', body: json, path: '/api/v0/chat/create_pow_challenge' });
    const challenge = {
      algorithm: c.algorithm,
      challenge: c.challenge,
      salt: c.salt,
      difficulty: c.difficulty,
      signature: c.signature,
      expireAt: c.expire_at ?? c.expireAt,
      expireAfter: c.expire_after ?? c.expireAfter,
    };
    this.powCache.set(key, challenge);
    return challenge;
  }

  // 注意：上游的 PoW 挑战是**一次性**的，复用同一个 challenge 会拿到空响应流。
  // 所以每次 completion 都重新取挑战（多一次 RTT，换取正确性）。
  async solvePow(account, token, targetPath) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const challenge = await this.getPowChallenge(account, token, targetPath, { force: true });
      try {
        const answer = await solveChallenge(challenge, { timeoutMs: 90_000 });
        this.powCache.delete(`${account.id}|${targetPath}`);
        return buildPowHeader(answer, targetPath);
      } catch (e) {
        if (attempt === 1) throw new UpstreamError({ status: 0, code: 'POW_SOLVE_FAILED', msg: e.message, path: targetPath });
        await sleep(150);
      }
    }
    throw new UpstreamError({ status: 0, code: 'POW_SOLVE_FAILED', msg: 'unreachable', path: targetPath });
  }

  /**
   * 发起一次 completion，返回事件流。
   * 401/40003 → refresh_token；40303/40304 → 重算 PoW 重试一次；429/40029 → rotate
   */
  async *completion(account, token, { sessionId, parentMessageId = null, prompt, model = 'deepseek-chat', search = false, thinking = null, refFileIds = null, signal }) {
    const resolved = this.registry.resolve(model) ?? this.registry.resolve('deepseek-chat');
    // 思考开关：显式传入优先（reasoning_effort 映射），否则用模型默认
    const thinkingOn = thinking === null || thinking === undefined ? resolved.thinking : Boolean(thinking);
    const map = { modelType: resolved.upstream };
    const targetPath = '/api/v0/chat/completion';
    let powHeader = await this.solvePow(account, token, targetPath);

    for (let round = 0; round < 3; round++) {
      const body = {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        model_type: map.modelType,
        prompt,
        ref_file_ids: Array.isArray(refFileIds) ? refFileIds : [],
        thinking_enabled: thinkingOn,
        search_enabled: search,
        source: 'default',
        action: null,
        preempt: false,
      };
      const res = await this.request(account, targetPath, {
        body,
        token,
        signal,
        stream: true,
        extraHeaders: { 'X-DS-PoW-Response': powHeader },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        const err = bizError(targetPath, res.status, json) ?? new UpstreamError({ status: res.status, msg: text.slice(0, 200), path: targetPath });
        if (err.action === 'retry_pow' && round === 0) { powHeader = await this.solvePow(account, token, targetPath, { force: true }); continue; }
        if (err.action === 'challenge') {
          // 交给上层慢路径：抛给 server，由 browser.resolveChallenge 处理
          throw err;
        }
        throw err;
      }

      // 成功：把 PoW 头挂进日志用不到，直接读流
      for await (const evt of parseSSE(res.body)) yield evt;

      // 流里可能以 toast/hint 报错（HTTP 200）
      return;
    }
  }

  /** 探活：token 是否有效 + 延迟 */
  async probe(account) {
    const t0 = Date.now();
    const json = await this.request(account, '/api/v0/users/current', { method: 'GET', token: account.token });
    const data = json?.data ?? {};
    return { ok: true, ms: Date.now() - t0, user: data.biz_data ?? data ?? null };
  }

  /** 带 PoW 头的原始完成请求（completion 内部用不到，供调试/自定义头） */
  async rawCompletion(account, token, body, extraHeaders = {}) {
    const url = `${this.base}/api/v0/chat/completion`;
    return fetch(url, {
      method: 'POST',
      headers: { ...this.baseHeaders(account, { token, json: true }), ...extraHeaders },
      body: JSON.stringify(body),
    });
  }
}
