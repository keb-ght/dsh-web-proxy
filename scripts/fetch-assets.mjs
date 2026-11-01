#!/usr/bin/env node
// 首次运行前拉取 PoW 求解依赖（这些是第三方 CDN 产物，不随仓库分发）
//
// 用的是官方前端当前版本的静态资源。版本更新后文件名里的 hash 会变，
// 脚本会自动从 index.html 解析出最新文件名，不需要手改。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const STATIC = path.join(ASSETS, 'static');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CDN = 'https://fe-static.deepseek.com/chat/static';

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  fs.mkdirSync(STATIC, { recursive: true });
  console.log('解析 index.html 以获取当前版本文件名…');

  const html = await fetchText('https://chat.deepseek.com/');
  const mainJs = (html.match(/static\/(main\.[0-9a-f]+\.js)/) || [])[1];
  if (!mainJs) throw new Error('没能从 index.html 找到 main.js');

  const mainSrc = await fetchText(`${CDN}/${mainJs}`);

  // worker chunk：PoW 求解入口
  const worker = (mainSrc.match(/"(?:static\/)?(\d+)\.[0-9a-f]{10}\.js"/) || [])[1];
  // 更稳的做法：找 37627 这个 chunk id
  const workerHash = (mainSrc.match(/37627:"([0-9a-f]+)"/) || [])[1];
  const workerFile = workerHash ? `37627.${workerHash}.js` : null;

  // 依赖 chunk（worker 内部 importScripts 拉的）
  const depHash = (mainSrc.match(/8138:"([0-9a-f]+)"/) || [])[1];

  // wasm
  const wasm = (mainSrc.match(/(sha3_wasm_bg\.[0-9a-f]+\.wasm)/) || [])[1];

  const jobs = [];
  if (workerFile) jobs.push([`${CDN}/${workerFile}`, path.join(ASSETS, 'pow-worker.js'), 'PoW worker']);
  if (wasm) jobs.push([`${CDN}/${wasm}`, path.join(STATIC, wasm), 'sha3 wasm']);

  if (!jobs.length) throw new Error('没解析出任何资源地址，可能上游改版了');

  for (const [url, dest, label] of jobs) {
    process.stdout.write(`  ${label} … `);
    const buf = await fetchBuf(url);
    fs.writeFileSync(dest, buf);
    console.log(`${(buf.length / 1024).toFixed(0)} KB`);
  }

  // worker 依赖 chunk：hash 定义在 worker 文件内部（a.u=e=>"static/"+e+".<hash>.js"）
  const workerPath0 = path.join(ASSETS, 'pow-worker.js');
  if (fs.existsSync(workerPath0)) {
    const wSrc = fs.readFileSync(workerPath0, 'utf8');
    const m = wSrc.match(/a\.u=e=>"static\/"\+e\+"\.([0-9a-f]{10})\.js"/);
    if (m) {
      const depFile = `8138.${m[1]}.js`;
      process.stdout.write(`  worker 依赖 … `);
      const buf = await fetchBuf(`${CDN}/${depFile}`);
      fs.writeFileSync(path.join(STATIC, depFile), buf);
      console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    }
  }

  // worker 里的资源基址改成相对本地
  const workerPath = path.join(ASSETS, 'pow-worker.js');
  if (fs.existsSync(workerPath)) {
    let src = fs.readFileSync(workerPath, 'utf8');
    src = src.replace('a.p="https://fe-static.deepseek.com/chat/"', 'a.p=globalThis.__DS_ASSET_BASE||"https://fe-static.deepseek.com/chat/"');
    src = src.replace(/(static\/8138\.[0-9a-f]+\.js)/g, 'static/$1'.replace('static/', 'static/'));
    fs.writeFileSync(workerPath, src);
  }

  console.log('\n完成。运行 node src/server.mjs 启动。');
}

main().catch((e) => {
  console.error('\n失败:', e.message);
  console.error('可以手动把以下文件放到 assets/ 下：');
  console.error('  pow-worker.js               ← https://fe-static.deepseek.com/chat/static/37627.<hash>.js');
  console.error('  static/8138.<hash>.js       ← worker 依赖');
  console.error('  static/sha3_wasm_bg.<hash>.wasm');
  process.exit(1);
});
