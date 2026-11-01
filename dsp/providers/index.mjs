// Provider 插件点
//
// 设计意图：本项目只自带 manual（自有账号导入）。
// 「批量注册 / 自动登录」这类能力以 provider 接口形式留出插槽，
// 由第三方开发者自行实现并注入，仓库不附带任何实现与默认值。
//
// 接口约定见 docs/PROVIDERS.md
const registry = new Map();

/**
 * @typedef {Object} ProviderContext
 * @property {string} id            期望的账号 id（可空，新建时用）
 * @property {object} [opts]        调用方自定义参数
 * @property {(msg:string, data?:any)=>void} log
 *
 * @typedef {Object} ProviderResult  至少提供 token；其余字段缺失则自动生成/留空
 * @property {string} token
 * @property {string} [deviceId]
 * @property {string} [deviceModel]
 * @property {string} [cookies]
 * @property {string} [userAgent]
 * @property {string} [clientVersion]
 *
 * @typedef {Object} Provider
 * @property {string} name
 * @property {string} [description]
 * @property {(ctx:ProviderContext)=>Promise<ProviderResult|ProviderResult[]>} acquire
 */

/** @param {Provider} provider */
export function registerProvider(provider) {
  if (!provider?.name || typeof provider.acquire !== 'function') {
    throw new Error('provider 必须提供 name 与 acquire()');
  }
  registry.set(provider.name, provider);
  return provider;
}

export function getProvider(name = 'manual') {
  const p = registry.get(name);
  if (!p) throw new Error(`未注册的 provider: ${name}`);
  return p;
}

export function listProviders() {
  return [...registry.values()].map((p) => ({ name: p.name, description: p.description ?? '' }));
}

export async function acquire(name, ctx) {
  return getProvider(name).acquire(ctx);
}
