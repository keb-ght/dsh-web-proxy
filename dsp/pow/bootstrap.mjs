// PoW worker bootstrap: 让浏览器版 worker 源码在 node:worker_threads 里跑起来
// 官方 chunk 假设存在 self / onmessage / postMessage / fetch(file) —— 这里逐项补齐
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const assetBase = 'file://' + path.join(root, 'assets') + '/';

globalThis.self = globalThis;
globalThis.location = { href: assetBase };
self.location = assetBase; // worker 源码里 self.location + "/../../" 当字符串拼
self.rspackChunk_deepseek_chat = [];
globalThis.__DS_ASSET_BASE = assetBase;
globalThis.postMessage = (m) => parentPort.postMessage(m);
globalThis.onmessage = null;

// worker runtime 用 importScripts 拉依赖 chunk（rspack 经典模式）
globalThis.importScripts = (...urls) => {
  for (const u of urls) {
    const p = u.startsWith('file:') ? fileURLToPath(u) : path.join(root, 'assets', u.replace(/^.*?static\//, 'static/'));
    vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: path.basename(p) });
  }
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.startsWith('file:')) {
    const buf = fs.readFileSync(fileURLToPath(url));
    return new Response(buf, { headers: { 'Content-Type': 'application/wasm' } });
  }
  return realFetch(input, init);
};

const src = fs.readFileSync(path.join(root, 'assets/pow-worker.js'), 'utf8');
vm.runInThisContext(src, { filename: 'pow-worker.js' });

parentPort.on('message', (msg) => {
  const handler = globalThis.onmessage;
  if (typeof handler === 'function') handler({ data: msg });
});
