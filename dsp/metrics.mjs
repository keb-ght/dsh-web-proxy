// 运行指标：给管理界面喂数据
const RING = 300;

export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.requests = 0;
    this.ok = 0;
    this.errors = 0;
    this.streams = 0;
    this.tokensOut = 0;
    this.byCode = new Map();       // codeName -> count
    this.byModel = new Map();      // model -> count
    this.latency = [];             // 最近 RING 条毫秒
    this.recent = [];              // 最近 RING 条事件
    this.seriesByMinute = new Map(); // minuteKey -> {ok, err}
  }

  #minuteKey(t = Date.now()) {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  bump(map, k) { map.set(k, (map.get(k) ?? 0) + 1); }

  recordRequest({ model = 'unknown', stream = false } = {}) {
    this.requests++;
    if (stream) this.streams++;
    this.bump(this.byModel, model);
  }

  recordOk({ model = 'unknown', ms = 0, tokens = 0, account = null, preview = '' } = {}) {
    this.ok++;
    this.tokensOut += tokens || 0;
    this.latency.push(ms);
    if (this.latency.length > RING) this.latency.shift();
    const key = this.#minuteKey();
    const s = this.seriesByMinute.get(key) ?? { ok: 0, err: 0 };
    s.ok++;
    this.seriesByMinute.set(key, s);
    this.pushEvent({ t: Date.now(), level: 'ok', account, model, ms, tokens, preview });
  }

  recordError({ code = 'UNKNOWN', msg = '', account = null, model = 'unknown', ms = 0 } = {}) {
    this.errors++;
    this.bump(this.byCode, code);
    const key = this.#minuteKey();
    const s = this.seriesByMinute.get(key) ?? { ok: 0, err: 0 };
    s.err++;
    this.seriesByMinute.set(key, s);
    this.pushEvent({ t: Date.now(), level: 'error', account, model, code, msg, ms });
  }

  pushEvent(evt) {
    this.recent.unshift(evt);
    if (this.recent.length > RING) this.recent.pop();
  }

  snapshot() {
    const l = [...this.latency].sort((a, b) => a - b);
    const pct = (p) => (l.length ? l[Math.min(l.length - 1, Math.floor((p / 100) * l.length))] : 0);
    const total = this.ok + this.errors;
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      requests: this.requests,
      ok: this.ok,
      errors: this.errors,
      streams: this.streams,
      successRate: total ? Math.round((this.ok / total) * 1000) / 10 : null,
      tokensOut: this.tokensOut,
      latency: { avg: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0, p50: pct(50), p95: pct(95), samples: l.length },
      byCode: Object.fromEntries([...this.byCode].sort((a, b) => b[1] - a[1])),
      byModel: Object.fromEntries(this.byModel),
      series: [...this.seriesByMinute].slice(-30).map(([minute, v]) => ({ minute, ...v })),
    };
  }

  logs(limit = 100) { return this.recent.slice(0, limit); }
}

export const metrics = new Metrics();
