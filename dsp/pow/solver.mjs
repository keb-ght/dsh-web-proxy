// DeepSeekHashV1 PoW 求解器：复用官方 worker chunk + sha3 wasm
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = path.join(here, 'bootstrap.mjs');

let singleton = null;
function getWorker() {
  if (singleton) return singleton;
  singleton = new Worker(BOOTSTRAP, { type: 'module' });
  singleton.unref();
  singleton.on('error', () => { singleton = null; });
  singleton.on('exit', () => { singleton = null; });
  return singleton;
}

/**
 * @param {{algorithm:string, challenge:string, salt:string, difficulty:number|string, signature:string}} challenge
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{algorithm:string, challenge:string, salt:string, answer:number, signature:string}>}
 */
export function solveChallenge(challenge, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // 卡死的 worker 直接丢弃，下次重建
      singleton?.terminate();
      singleton = null;
      reject(new Error('pow_timeout'));
    }, timeoutMs);

    const onMessage = (m) => {
      if (!m || (m.type !== 'pow-answer' && m.type !== 'pow-error')) return;
      cleanup();
      if (m.type === 'pow-answer') return resolve(m.answer);
      reject(m.error instanceof Error ? m.error : new Error(String(m.error?.message ?? m.error)));
    };
    const onError = (e) => { cleanup(); reject(e); };

    function cleanup() {
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onError);
    }

    w.on('message', onMessage);
    w.on('error', onError);
    w.postMessage({ type: 'pow-challenge', challenge });
  });
}

/** 按前端逻辑封装：base64(JSON) 作为 X-DS-PoW-Response 的值 */
export function buildPowHeader(answerObj, targetPath) {
  const payload = {
    algorithm: answerObj.algorithm,
    challenge: answerObj.challenge,
    salt: answerObj.salt,
    answer: answerObj.answer,
    signature: answerObj.signature,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** 游客模式专用头 */
export function buildGuestPowHeader(answerObj) {
  return Buffer.from(JSON.stringify({ salt: answerObj.salt, answer: answerObj.answer }), 'utf8').toString('base64');
}
