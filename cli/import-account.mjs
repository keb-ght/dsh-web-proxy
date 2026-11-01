#!/usr/bin/env node
// 账号导入 CLI
//   node cli/import-account.mjs --token <userToken> [--id a1] [--device-id <uuid>]
//   node cli/import-account.mjs --browser            # 真浏览器登录后回收 token/指纹/cookie
//   node cli/import-account.mjs --list
import { loadConfig } from '../dsp/config.mjs';
import { AccountPool, NEW_UUID } from '../dsp/accounts.mjs';
import { createBrowserResolver } from '../dsp/browser.mjs';
import '../src/providers/manual.mjs'; // 注册 manual provider

const cfg = loadConfig();
const pool = new AccountPool(cfg).load();

const argv = process.argv.slice(2);
const arg = (name, def = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

if (argv.includes('--list')) {
  for (const a of pool.snapshots()) console.log(JSON.stringify(a));
  process.exit(0);
}

if (argv.includes('--browser')) {
  const browser = createBrowserResolver({ ...cfg, browser: { ...cfg.browser, enabled: true } });
  const account = pool.upsert({ id: arg('id') || NEW_UUID().slice(0, 8), deviceId: arg('device-id') || NEW_UUID() });
  console.log('打开浏览器，请手动完成登录/人机验证…');
  const info = await browser.interactiveLogin(account, { timeoutMs: Number(arg('timeout', 180_000)) });
  pool.save();
  console.log('导入成功：', JSON.stringify({ id: account.id, deviceId: info.deviceId, cookieCount: info.cookieCount, tokenKey: info.tokenKey }));
  process.exit(0);
}

const token = arg('token');
if (!token || token === true) {
  console.error('用法: node cli/import-account.mjs --token <userToken> [--id a1] [--device-id <uuid>] | --browser | --list');
  process.exit(1);
}

const acc = pool.upsert({
  id: arg('id') || NEW_UUID().slice(0, 8),
  token,
  deviceId: arg('device-id') || NEW_UUID(),
  deviceModel: arg('device-model') || '',
  userAgent: arg('user-agent') || '',
});
pool.save();
console.log('已写入', cfg.accountsFile, JSON.stringify(acc.snapshot()));
