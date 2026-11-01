// 工具调用解析 —— 移植自 NIyueeE/ds-free-api 的 tool_parser.rs
//
// 来源: https://github.com/NIyueeE/ds-free-api (GPL-3.0)
// 原文件: src/openai_adapter/response/tool_parser.rs
// 依 GPL-3.0 第 5 条，本文件的衍生版本同样以 GPL-3.0 授权。
// 原实现用 Rust，这里 1:1 翻成 JS。能力：标记定位 + 代码块防误判 + JSON 修复 + XML invoke 兜底

const DEFAULT_STARTS = ['<|tool▁calls▁begin|>', '<|tool_calls_begin|>', '<|tool_call_begin|>', '<tool_calls>', '<tool_call>'];
const DEFAULT_ENDS = ['<|tool▁calls▁end|>', '<|tool_calls_end|>', '<|tool_call_end|>', '</tool_calls>', '</tool_call>'];

/** 全角 ｜ → |，▁(U+2581) → _ */
export const normTag = (t) => String(t ?? '').replace(/\uFF5C/g, '|').replace(/\u2581/g, '_');

/** 代码块内的标签不算调用（避免把示例当指令） */
function isInsideCodeFence(xml, tagPos) {
  const before = xml.slice(0, tagPos);
  return (before.match(/```/g) || []).length % 2 === 1;
}

/** 修复非法反斜杠转义 */
export function repairInvalidBackslashes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const next = s[i + 1];
    if (next === undefined) { out += '\\'; continue; }
    if ('"\\/bfnrtu'.includes(next)) { out += '\\' + next; i++; }
    else { out += '\\\\' + next; i++; }
  }
  return out;
}

/** 给未加引号的 key 补引号 */
export function repairUnquotedKeys(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    out += s[i];
    if ((s[i] === '{' || s[i] === ',') && i + 1 < n) {
      i++;
      while (i < n && /\s/.test(s[i])) { out += s[i]; i++; }
      if (i < n && /[A-Za-z_]/.test(s[i])) {
        const start = i;
        while (i < n && /[A-Za-z0-9_]/.test(s[i])) i++;
        if (i < n && s[i] === ':') {
          out += '"' + s.slice(start, i) + '"';
        } else {
          out += s.slice(start, i);
          continue;
        }
      }
    } else {
      i++;
    }
  }
  return out;
}

/** 两层修复：反斜杠 → 未加引号 key */
export function repairJson(s) {
  const step1 = repairInvalidBackslashes(s);
  try { JSON.parse(step1); return step1; } catch { /* 继续 */ }
  const step2 = repairUnquotedKeys(step1);
  try { JSON.parse(step2); return step2; } catch { /* 放弃 */ }
  return null;
}

function toCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const name = obj.name ?? obj.tool ?? obj.function?.name;
  if (typeof name !== 'string' || !name) return null;
  let args = obj.arguments ?? obj.args ?? obj.function?.arguments;
  if (args === undefined || args === null) {
    const { name: _n, tool: _t, function: _f, arguments: _a, args: _r, ...rest } = obj;
    args = rest;
  }
  return { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) };
}

/** XML invoke 风格：<invoke name="x"><parameter name="y">v</parameter></invoke> */
function parseInvokeCalls(inner) {
  const calls = [];
  const lower = inner.toLowerCase();
  let pos = 0;
  while (true) {
    const s = lower.indexOf('<invoke ', pos);
    if (s < 0) break;
    const nameAttr = inner.slice(s);
    const ni = nameAttr.indexOf('name="');
    if (ni < 0) break;
    const ns = ni + 6;
    const ne = nameAttr.indexOf('"', ns);
    if (ne < 0) break;
    const name = nameAttr.slice(ns, ne);
    const closeTag = '</invoke>';
    const ci = lower.indexOf(closeTag, s);
    // 容错：闭合标签缺失（流式截断）时吃到末尾
    const bodyEnd = ci < 0 ? inner.length : ci + closeTag.length;
    const body = inner.slice(s, bodyEnd);

    const params = {};
    const bl = body.toLowerCase();
    let p = 0;
    while (true) {
      const ps = bl.indexOf('<parameter ', p);
      if (ps < 0) break;
      const pAttr = body.slice(ps);
      const pni = pAttr.indexOf('name="');
      if (pni < 0) break;
      const pns = pni + 6;
      const pne = pAttr.indexOf('"', pns);
      if (pne < 0) break;
      const pname = pAttr.slice(pns, pne);
      const bodyStart = pAttr.indexOf('>');
      if (bodyStart < 0) break;
      const pCloseTag = '</parameter>';
      const pc = pAttr.toLowerCase().indexOf(pCloseTag, bodyStart);
      const valEnd = pc < 0 ? pAttr.length : pc;
      const rawVal = pAttr.slice(bodyStart + 1, valEnd).trim();
      let val;
      try { val = JSON.parse(rawVal); } catch { val = rawVal; }
      params[pname] = val;
      p = ps + (pc < 0 ? pAttr.length : bodyStart + pc + pCloseTag.length);
    }
    calls.push({ name, arguments: JSON.stringify(params) });
    if (ci < 0) break;
    pos = ci + closeTag.length;
  }
  return calls.length ? calls : null;
}

/**
 * 主解析：返回 { calls, remaining } 或 null
 * 路径：标记内 JSON 数组 → 标记内单对象 → 标记内 XML invoke
 */
/** 把 <||DSML|| invoke ...> / </||DSML|| parameter> 归一成标准 XML 标签 */
function normalizeDsml(t) {
  return t
    // 闭合：</|DSML|>x  或  </||DSML|| x  →  </x
    .replace(/<\s*\/\s*\|+\s*DSML\s*\|+\s*>?\s*/gi, '</')
    // 开合：<|DSML|>x  或  <||DSML|| x  →  <x
    .replace(/<\s*\|+\s*DSML\s*\|+\s*>?\s*/gi, '<');
}

export function parseToolCalls(text, { starts = DEFAULT_STARTS, ends = DEFAULT_ENDS } = {}) {
  if (!text || typeof text !== 'string') return null;
  const norm = normalizeDsml(normTag(text));

  // 没有 tool_calls 包裹标记，但有 <invoke>：直接按 XML 解析（模型常用的裸 DSML 形态）
  if (!starts.some((s) => norm.includes(s)) && /<invoke\s/i.test(norm)) {
    if (/```[\s\S]*<invoke\s/i.test(norm)) {
      // 在代码块里出现的 invoke 不算（示例）
      const fenceOpen = (norm.match(/```/g) || []).length;
      if (fenceOpen % 2 === 1) return null;
    }
    const inv = parseInvokeCalls(norm);
    if (inv) return { calls: inv, remaining: '' };
  }

  // 定位起始标签
  let startPos = -1;
  let startTag = '';
  for (const s of starts) {
    const i = norm.indexOf(s);
    if (i >= 0 && (startPos < 0 || i < startPos)) { startPos = i; startTag = s; }
  }
  if (startPos < 0) return null;
  if (isInsideCodeFence(norm, startPos)) return null;

  const afterStart = startPos + startTag.length;

  // 定位结束标签
  let endPos = norm.length;
  let endTagLen = 0;
  for (const e of ends) {
    const i = norm.indexOf(e, afterStart);
    if (i >= 0 && i < endPos) { endPos = i; endTagLen = e.length; }
  }
  const inner = norm.slice(afterStart, endPos);
  const tail = norm.slice(endPos + endTagLen);

  // ① 数组
  const bracketStart = inner.indexOf('[');
  if (bracketStart >= 0) {
    const bracketEnd = inner.lastIndexOf(']');
    const jsonStr = inner.slice(bracketStart, bracketEnd >= 0 ? bracketEnd + 1 : inner.length);
    if (jsonStr.trim() === '[]') return null;
    let arr = null;
    try { arr = JSON.parse(jsonStr); } catch { /* 修复 */ }
    if (!arr) {
      const fixed = repairJson(jsonStr);
      if (fixed) {
        try { arr = JSON.parse(fixed); } catch { /* 继续 */ }
      }
    }
    if (Array.isArray(arr)) {
      const calls = arr.map(toCall).filter(Boolean);
      if (calls.length) return { calls, remaining: norm.slice(0, startPos) + tail };
    }
  }

  // ② 单个对象
  const objStart = inner.indexOf('{');
  if (objStart >= 0) {
    const objEnd = inner.lastIndexOf('}');
    const jsonStr = inner.slice(objStart, objEnd >= 0 ? objEnd + 1 : inner.length);
    let obj = null;
    try { obj = JSON.parse(jsonStr); } catch { /* 修复 */ }
    if (!obj) {
      const fixed = repairJson(jsonStr);
      if (fixed) { try { obj = JSON.parse(fixed); } catch { /* 继续 */ } }
    }
    const call = toCall(obj);
    if (call) return { calls: [call], remaining: norm.slice(0, startPos) + tail };
  }

  // ③ XML invoke
  const inv = parseInvokeCalls(inner);
  if (inv) return { calls: inv, remaining: norm.slice(0, startPos) + tail };

  return null;
}

/** 清理残留标记（解析失败时用） */
export function stripMarkers(text) {
  if (!text || typeof text !== 'string') return text;
  const n = normTag(text);
  return n
    .replace(/<[^<>]{0,40}(DSML|tool[_ ]?call|antml|function_call)[^<>]{0,40}>\s*(calls?>|invoke>|parameter>)?/gi, '')
    .replace(/<\|tool_calls?_?(?:begin|end)\|>/gi, '')
    .replace(/<\/?tool_calls?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
