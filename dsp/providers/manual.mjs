// manual provider：自有账号，token 由人工导入（CLI 参数 / 浏览器登录回收 / 直接写 accounts.json）
import { registerProvider } from './index.mjs';

export const manualProvider = {
  name: 'manual',
  description: '自有账号手动导入（默认）',
  async acquire({ opts = {} }) {
    if (opts.token) {
      return {
        token: opts.token,
        deviceId: opts.deviceId,
        deviceModel: opts.deviceModel,
        cookies: opts.cookies,
        userAgent: opts.userAgent,
        clientVersion: opts.clientVersion,
      };
    }
    // 没有 token 时：交给浏览器慢路径（若启用）
    if (opts.browser?.interactiveLogin) {
      const stub = { deviceId: opts.deviceId, userAgent: opts.userAgent, clientVersion: opts.clientVersion };
      await opts.browser.interactiveLogin(stub);
      return stub;
    }
    throw new Error('manual provider 需要 opts.token，或启用 browser 交互登录');
  },
};

registerProvider(manualProvider);

export default manualProvider;
