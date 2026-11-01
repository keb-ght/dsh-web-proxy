// 模型映射：对外模型名 → 上游 model_type / 思考开关。可在管理界面「设置 → 模型」里改
export const DEFAULT_MODELS = [
  { id: 'deepseek-chat', upstream: 'default', thinking: false, label: 'DeepSeek Chat（默认）', enabled: true },
  { id: 'deepseek-reasoner', upstream: 'expert', thinking: true, label: 'DeepSeek Reasoner（深度思考）', enabled: true },
  { id: 'deepseek-v3', upstream: 'default', thinking: false, label: 'DeepSeek V3', enabled: true },
  { id: 'deepseek-r1', upstream: 'expert', thinking: true, label: 'DeepSeek R1', enabled: true },
  { id: 'deepseek-vision', upstream: 'vision', thinking: false, label: 'DeepSeek Vision（多模态）', enabled: false },
];

export const UPSTREAM_TYPES = ['default', 'expert', 'vision'];

export function normalizeModels(input) {
  const list = Array.isArray(input) && input.length ? input : DEFAULT_MODELS;
  return list
    .filter((m) => m && typeof m.id === 'string' && m.id.trim())
    .map((m) => ({
      id: m.id.trim(),
      upstream: UPSTREAM_TYPES.includes(m.upstream) ? m.upstream : 'default',
      thinking: Boolean(m.thinking),
      label: String(m.label ?? m.id),
      enabled: m.enabled !== false,
    }));
}

export class ModelRegistry {
  constructor(cfg) {
    this.cfg = cfg;
    this.models = normalizeModels(cfg.models);
  }

  reload() { this.models = normalizeModels(this.cfg.models); return this; }

  /** 对外可见（/v1/models） */
  list() { return this.models.filter((m) => m.enabled); }

  all() { return this.models; }

  /** 解析一个对外模型名；未启用/未定义返回 null */
  resolve(id) {
    const hit = this.models.find((m) => m.id === id);
    if (hit) return hit.enabled ? hit : null;
    // 宽松兜底：deepseek-* 里带 reasoner/r1 的当 expert
    if (typeof id === 'string' && id.startsWith('deepseek')) {
      const expert = /reasoner|r1/i.test(id);
      return { id, upstream: expert ? 'expert' : 'default', thinking: expert, label: id, enabled: true, fallback: true };
    }
    return null;
  }

  replace(next) {
    this.cfg.models = normalizeModels(next);
    this.reload();
    return this.all();
  }
}
