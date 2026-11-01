// 慢路径：真浏览器兜底（数美/hCaptcha 人机验证，纯 HTTP 复现成本极高）
// 依赖可选：playwright-core。没有安装时本模块全功能降级，不影响快路径。
import { NEW_UUID } from './accounts.mjs';

export function createBrowserResolver(cfg) {
  const enabled = Boolean(cfg.browser?.enabled);
  let browserPromise = null;

  async function loadPlaywright() {
    try {
      return await import('playwright-core');
    } catch {
      throw new Error('playwright-core 未安装：npm i playwright-core（或复用系统 Chrome 的 CDP）');
    }
  }

  async function getContext() {
    if (!enabled) throw new Error('browser path disabled (config.browser.enabled=false)');
    if (browserPromise) return browserPromise;
    browserPromise = (async () => {
      const pw = await loadPlaywright();
      const { chromium } = pw;
      // 优先接管已开的 Chrome（人工登录态/扩展都在里面）
      try {
        const browser = await chromium.connectOverCDP(cfg.browser.cdpUrl);
        const ctx = browser.contexts()[0] ?? (await browser.newContext());
        return { browser, ctx, attached: true };
      } catch {
        const browser = await chromium.launch({
          channel: cfg.browser.channel,
          headless: Boolean(cfg.browser.headless),
        });
        const ctx = await browser.newContext();
        return { browser, ctx, attached: false };
      }
    })();
    return browserPromise;
  }

  /** 让用户在真浏览器里过一次验证/登录，然后回收 token + 设备指纹 + cookie */
  async function interactiveLogin(account, { url = 'https://chat.deepseek.com', timeoutMs } = {}) {
    const limit = timeoutMs ?? cfg.browser.timeoutMs ?? 180_000;
    const { ctx } = await getContext();
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const deadline = Date.now() + limit;
    let token = null;
    while (Date.now() < deadline) {
      token = await page.evaluate(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        // 官方前端把 token 存在 userToken* 键里，值是 JSON
        for (const [k, v] of Object.entries(out)) {
          if (!/token/i.test(k) || !v) continue;
          try {
            const parsed = JSON.parse(v);
            const t = parsed?.value?.token ?? parsed?.token ?? parsed?.value;
            if (typeof t === 'string' && t.length > 20) return { key: k, token: t };
          } catch { /* 非 JSON 忽略 */ }
        }
        return null;
      }).catch(() => null);

      if (token?.token) break;
      await page.waitForTimeout(1500);
    }
    if (!token?.token) {
      await page.close();
      throw new Error('未在超时内捕获到登录 token（请确认已手动完成登录/验证）');
    }

    const cookies = await ctx.cookies(url);
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const deviceId = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (/__ds_remote_feature_did|device/i.test(k)) {
          const v = localStorage.getItem(k) || '';
          const m = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
          if (m) return m[0];
        }
      }
      return '';
    }).catch(() => '');
    const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');

    account.token = token.token;
    account.cookies = cookieStr;
    account.userAgent = ua || account.userAgent;
    account.deviceId = deviceId || account.deviceId || NEW_UUID();
    account.status = 'ready';
    account.cooldownUntil = 0;
    await page.close();
    return { tokenKey: token.key, deviceId: account.deviceId, cookieCount: cookies.length };
  }

  /** 快路径撞到 CHALLENGE_REQUIRED 时调用：打开页面把验证过掉，回收新鲜 cookie/token */
  async function resolveChallenge(account) {
    return interactiveLogin(account, { timeoutMs: cfg.browser.timeoutMs });
  }

  return { get enabled() { return enabled; }, interactiveLogin, resolveChallenge };
}
