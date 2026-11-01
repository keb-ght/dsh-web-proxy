import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  // 网关自己的鉴权（给第三方客户端用的 key，可留空表示不校验）
  apiKeys: [],
  upstream: {
    baseUrl: 'https://chat.deepseek.com',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    clientVersion: '1.0.0',
    bundleId: 'com.deepseek.chat',
    platform: 'web',
    locale: 'zh_CN',
    timezoneOffsetSeconds: -28800,
  },
  // 快路径限速：单账号每分钟请求上限，超了排队，避免 40029
  rateLimitPerMinute: 12,
  // PoW 挑战提前刷新余量（前端用 60s）
  powRefreshMarginMs: 60_000,
  accountsFile: path.join(process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh'), 'dsh-web-proxy', 'accounts.json'),
  // 慢路径（浏览器兜底）
  browser: {
    enabled: false,
    cdpUrl: 'http://127.0.0.1:9222',
    channel: 'chrome',
    headless: false,
    timeoutMs: 180_000,
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(file = process.env.DS_PROXY_CONFIG || path.join(ROOT, 'config.json')) {
  let cfg = DEFAULTS;
  if (fs.existsSync(file)) {
    cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  if (process.env.DS_PROXY_PORT) cfg.port = Number(process.env.DS_PROXY_PORT);
  if (process.env.DS_PROXY_HOST) cfg.host = process.env.DS_PROXY_HOST;
  if (process.env.DS_PROXY_KEYS) cfg.apiKeys = process.env.DS_PROXY_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
  return cfg;
}

/** 检查 PoW 依赖是否就位（第三方产物，不随仓库分发） */
export function ensureAssets() {
  const need = [
    path.join(ROOT, 'assets', 'pow-worker.js'),
  ];
  const staticDir = path.join(ROOT, 'assets', 'static');
  let hasWasm = false;
  try {
    hasWasm = fs.readdirSync(staticDir).some((f) => f.endsWith('.wasm'));
  } catch { /* 目录不存在 */ }
  const missing = need.filter((f) => !fs.existsSync(f));
  if (missing.length || !hasWasm) {
    return { ok: false, missing: [...missing, ...(hasWasm ? [] : ['assets/static/*.wasm'])].map((f) => path.relative(ROOT, f)) };
  }
  return { ok: true };
}
