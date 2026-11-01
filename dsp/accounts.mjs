// 账号池：自有账号导入 → 轮转 → 熔断 → 慢路径唤醒
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from './config.mjs';

export const NEW_UUID = () => crypto.randomUUID();

export class Account {
  constructor(raw, cfg) {
    this.id = raw.id;
    this.name = raw.name || '';
    this.enabled = raw.enabled !== false;
    this.token = raw.token ?? null;
    this.deviceId = raw.deviceId || NEW_UUID();
    this.deviceModel = raw.deviceModel || '';
    this.cookies = raw.cookies || '';
    this.userAgent = raw.userAgent || '';
    this.clientVersion = raw.clientVersion || '';
    this.extra = raw.extra || {};
    // 运行态
    this.status = this.token ? 'ready' : 'needs_login';
    this.cooldownUntil = 0;
    this.inflight = 0;
    this.lastError = null;
    this.requestTimestamps = [];
    this.cfg = cfg;
  }

  get available() {
    return this.enabled && this.status === 'ready' && Date.now() >= this.cooldownUntil;
  }

  /** 简单滑动窗口限速：同账号一分钟内请求数 */
  canDispatch(now = Date.now()) {
    const windowMs = 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < windowMs);
    return this.requestTimestamps.length < this.cfg.rateLimitPerMinute;
  }

  markDispatch(now = Date.now()) {
    this.requestTimestamps.push(now);
  }

  cool(reason, ms = 60_000) {
    this.cooldownUntil = Date.now() + ms;
    this.lastError = reason;
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      status: this.status,
      deviceId: this.deviceId,
      inflight: this.inflight,
      cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
      lastError: this.lastError,
      hasToken: Boolean(this.token),
    };
  }
}

export class AccountPool {
  constructor(cfg = loadConfig()) {
    this.cfg = cfg;
    this.accounts = new Map();
    this.cursor = 0;
  }

  load(file = this.cfg.accountsFile) {
    this.accounts.clear();
    if (!fs.existsSync(file)) return this;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data.accounts ?? [];
    for (const raw of list) {
      if (!raw?.id) raw.id = NEW_UUID().slice(0, 8);
      this.accounts.set(raw.id, new Account(raw, this.cfg));
    }
    return this;
  }

  save(file = this.cfg.accountsFile) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const list = [...this.accounts.values()].map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      token: a.token,
      deviceId: a.deviceId,
      deviceModel: a.deviceModel,
      cookies: a.cookies,
      userAgent: a.userAgent,
      clientVersion: a.clientVersion,
      extra: a.extra,
    }));
    // token 是敏感据：文件权限锁到 0600（仅本用户可读）
    fs.writeFileSync(file, JSON.stringify({ accounts: list }, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  }

  upsert(raw) {
    const existing = raw.id ? this.accounts.get(raw.id) : null;
    const acc = existing ?? new Account({ ...raw, id: raw.id || NEW_UUID().slice(0, 8) }, this.cfg);
    Object.assign(acc, {
      name: raw.name ?? acc.name,
      enabled: raw.enabled ?? acc.enabled,
      token: raw.token ?? acc.token,
      deviceId: raw.deviceId ?? acc.deviceId,
      deviceModel: raw.deviceModel ?? acc.deviceModel,
      cookies: raw.cookies ?? acc.cookies,
      userAgent: raw.userAgent ?? acc.userAgent,
      clientVersion: raw.clientVersion ?? acc.clientVersion,
    });
    if (acc.token) acc.status = 'ready';
    this.accounts.set(acc.id, acc);
    return acc;
  }

  /** 轮转取一个可用账号（最少在途优先） */
  pick() {
    const now = Date.now();
    const list = [...this.accounts.values()];
    const usable = list.filter((a) => a.available && a.canDispatch(now));
    if (!usable.length) return null;
    usable.sort((a, b) => a.inflight - b.inflight || (a.requestTimestamps.at(-1) ?? 0) - (b.requestTimestamps.at(-1) ?? 0));
    const acc = usable[0];
    acc.markDispatch(now);
    return acc;
  }

  get(id) { return this.accounts.get(id); }

  remove(id) {
    const ok = this.accounts.delete(id);
    if (ok) this.save();
    return ok;
  }

  setEnabled(id, enabled) {
    const a = this.accounts.get(id);
    if (!a) return null;
    a.enabled = Boolean(enabled);
    this.save();
    return a;
  }

  rename(id, name) {
    const a = this.accounts.get(id);
    if (!a) return null;
    a.name = String(name ?? '').slice(0, 64);
    this.save();
    return a;
  }

  resetDeviceId(id) {
    const a = this.accounts.get(id);
    if (!a) return null;
    a.deviceId = NEW_UUID();
    a.cookies = '';
    this.save();
    return a;
  }

  clearCooldowns() {
    for (const a of this.accounts.values()) {
      a.cooldownUntil = 0;
      a.lastError = null;
      a.requestTimestamps = [];
      if (a.status === 'cooldown' || a.status === 'ready') a.status = a.token ? 'ready' : 'needs_login';
    }
    this.save();
    return this.accounts.size;
  }
  all() { return [...this.accounts.values()]; }
  snapshots() { return this.all().map((a) => a.snapshot()); }
}
