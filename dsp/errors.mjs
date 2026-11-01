// 上游业务码 → 语义 + 处理动作（来自官方前端枚举，见 docs/recon 报告）
export const DEEPSEEK_CODE = {
  0: 'OK',
  40002: 'MISSING_TOKEN',
  40003: 'INVALID_TOKEN',
  40006: 'REQUEST_DECRYPT_FAILED',
  40007: 'REQUEST_DECRYPT_NOT_ALLOWED',
  40012: 'USER_IS_BANNED',
  40029: 'IP_ACCESS_RESTRICTED',
  50006: 'MUTED',
  40300: 'POW_HEADER_ERROR',
  40301: 'INVALID_POW_RESPONSE',
  40303: 'CHALLENGE_REQUIRED',
  40304: 'CHALLENGE_FAILED',
};

// action: rotate(换账号) / refresh_token(重新登录) / retry_pow(重算 PoW) / challenge(走浏览器) / fatal
export const ACTIONS = {
  MISSING_TOKEN: 'refresh_token',
  INVALID_TOKEN: 'refresh_token',
  USER_IS_BANNED: 'rotate',
  IP_ACCESS_RESTRICTED: 'rotate',
  MUTED: 'rotate',
  POW_HEADER_ERROR: 'retry_pow',
  INVALID_POW_RESPONSE: 'retry_pow',
  CHALLENGE_REQUIRED: 'challenge',
  CHALLENGE_FAILED: 'challenge',
  REQUEST_DECRYPT_FAILED: 'fatal',
  REQUEST_DECRYPT_NOT_ALLOWED: 'fatal',
};

export class UpstreamError extends Error {
  constructor({ status, code, msg, body, path }) {
    super(msg || `upstream error ${code ?? status}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.msg = msg;
    this.body = body;
    this.path = path;
    this.codeName = DEEPSEEK_CODE[code] ?? (status ? `HTTP_${status}` : 'UNKNOWN');
    this.action = ACTIONS[this.codeName] ?? (status === 429 ? 'rotate' : 'fatal');
  }
  /** 映射成 OpenAI 风格错误体，方便客户端统一处理 */
  toOpenAI() {
    const type =
      this.action === 'rotate' ? 'rate_limit_error' : this.codeName.includes('TOKEN') ? 'authentication_error' : 'upstream_error';
    return { error: { message: `${this.codeName}: ${this.msg ?? ''}`.trim(), type, code: this.code ?? this.status } };
  }
}

/** 业务响应（HTTP 200 + body.code）也要当错误处理——WAF 之外最常见的坑 */
export function bizError(path, status, json) {
  if (!json || typeof json !== 'object') return null;
  const data = json.data && typeof json.data === 'object' ? json.data : json;
  const code = data.code ?? json.code;
  if (code === 0 || code === undefined || code === null) {
    const bc = data.biz_code ?? json.biz_code;
    if (bc && bc !== 0) return new UpstreamError({ status, code: bc, msg: data.biz_msg ?? json.biz_msg, body: json, path });
    return null;
  }
  return new UpstreamError({ status, code, msg: data.msg ?? json.msg, body: json, path });
}
