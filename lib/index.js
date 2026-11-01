// dsh-web-proxy —— DSH 服务端插件（热加载壳）
//
// 设计：插件本身只做「进程监督」，反代跑在独立子进程里。
// 监听 dsp/ 目录，任何文件变更 → 杀掉旧子进程 → 起新子进程。
// 改反代代码 1 秒生效，DSH 不需要重启。
//
// ⚠️ cordis 要求 apply 期间同步注册 effect，所以这里不做 async apply。
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-web-proxy';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'dsp', 'server.mjs');
const WATCH_DIR = path.join(ROOT, 'dsp');
const BASE_PORT = Number(process.env.DSH_WEB_PROXY_PORT || 8787);
const LOG_FILE = path.join(process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh'), 'dsh-web-proxy', 'supervisor.log');

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  try { console.log('[dsh-web-proxy]', msg); } catch { /* ignore */ }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(400, () => done(false));
    s.once('connect', () => done(false));
    s.once('error', () => done(true));
  });
}

async function pickPort() {
  for (let i = 0; i < 8; i++) {
    const p = BASE_PORT + i;
    if (await portFree(p)) return p;
  }
  return BASE_PORT;
}

export default {
  name,
  apply(root) {
    let child = null;
    let watcher = null;
    let timer = null;
    let disposed = false;
    let restartCount = 0;

    const killChild = () => {
      if (!child) return Promise.resolve();
      const old = child;
      child = null;
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        old.once('exit', finish);
        try { old.kill('SIGTERM'); } catch { finish(); }
        setTimeout(() => { try { old.kill('SIGKILL'); } catch {} finish(); }, 1200).unref?.();
      });
    };

    let booting = false;
    const boot = async (reason = 'boot') => {
      if (disposed || booting) return;
      booting = true;
      try {
        const port = await pickPort();
        if (disposed) return;
        logLine(`启动子进程 port=${port} (${reason})`);
        const c = spawn(process.execPath, [ENTRY], {
          cwd: ROOT,
          env: { ...process.env, DS_PROXY_PORT: String(port) },
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child = c;
        c.on('exit', (code, sig) => {
          if (child === c) child = null;
          if (disposed) return;
          logLine(`子进程退出 code=${code} sig=${sig}`);
          if (code !== 0 && !sig) {
            // 真正的异常退出 → 退避重试
            clearTimeout(timer);
            timer = setTimeout(() => boot('retry'), Math.min(5000, 800 * (restartCount + 1)));
          }
        });
        c.on('error', (e) => { logLine('spawn error: ' + (e && e.message)); });
      } catch (e) {
        logLine('boot 失败: ' + (e && e.message));
      } finally {
        booting = false;
      }
    };

    const reload = async (reason) => {
      if (disposed) return;
      restartCount++;
      clearTimeout(timer);
      logLine(`检测到变更（${reason}）→ 重启`);
      await killChild();          // 关键：等子进程真正退出，避免端口竞争
      if (disposed) return;
      await boot('reload');
    };

    // ① 同步注册清理
    root.effect(() => () => {
      disposed = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch {}
      watcher = null;
      killChild();
    });

    // ② 异步启动 + 文件监听
    (async () => {
      await boot('initial');
      try {
        watcher = fs.watch(WATCH_DIR, { recursive: true }, (_evt, file) => {
          if (!file) return;
          if (!/\.(mjs|js|json|html)$/.test(file)) return;
          clearTimeout(timer);
          timer = setTimeout(() => reload(file), 400);   // 去抖：写入会触发多次事件
        });
        logLine(`热加载已开启，监听 ${WATCH_DIR}`);
      } catch (e) {
        logLine('文件监听不可用: ' + (e && e.message));
      }
    })().catch((e) => console.error('[dsh-web-proxy] 启动异常：', e && e.message));
  },
};
