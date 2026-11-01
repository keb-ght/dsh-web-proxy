// 多模态：图片上传到网页版，拿 file_id 供 completion 引用
//
// 流程：upload(PoW) → 轮询 status 到 SUCCESS → ref_file_ids 带进 completion
// 注意：PARSING/PENDING 状态下发对话会拿到空流，必须等到 SUCCESS。
import { Upstream } from './upstream.mjs';

const BASE = 'https://chat.deepseek.com';
const UPLOAD_TARGET = '/api/v0/file/upload_file';

function headersFor(upstream, account) {
  return {
    ...upstream.baseHeaders(account, { token: account.token }),
    origin: BASE,
    referer: BASE + '/',
  };
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 单图 8MB 上限

/** data URL / http URL → { buffer, mime, name } */
export async function fetchImage(url, index = 0) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (m) {
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大: ${(buf.length / 1048576).toFixed(1)}MB > 8MB`);
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
    return { buffer: buf, mime, name: `image-${index}.${ext}` };
  }
  if (/^https?:\/\//.test(url)) {
    const r = await fetch(url);
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') || 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片过大: ${(buf.length / 1048576).toFixed(1)}MB > 8MB`);
    return { buffer: buf, mime, name: `image-${index}.${ext}` };
  }
  return null;
}

/** 上传一张图，返回 file_id */
export async function uploadImage(upstream, account, image) {
  const pow = await upstream.solvePow(account, account.token, UPLOAD_TARGET);
  const form = new FormData();
  form.append('file', new Blob([image.buffer], { type: image.mime }), image.name);

  const res = await fetch(BASE + UPLOAD_TARGET, {
    method: 'POST',
    headers: { ...headersFor(upstream, account), 'x-ds-pow-response': pow },
    body: form,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`上传响应非 JSON: ${text.slice(0, 120)}`); }
  const biz = json?.data ?? {};
  if ((biz.biz_code ?? 0) !== 0) throw new Error(`上传失败 code=${biz.biz_code} msg=${biz.biz_msg ?? ''}`);
  const id = biz?.biz_data?.id;
  if (!id) throw new Error('上传成功但没有 file_id');
  return { fileId: id, status: biz?.biz_data?.status ?? 'PENDING' };
}

/** 轮询文件状态直到 SUCCESS（或失败） */
export async function waitForFile(upstream, account, fileId, { timeoutMs = 25_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'PENDING';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const res = await fetch(
        `${BASE}/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        { headers: headersFor(upstream, account) },
      );
      const text = await res.text();
      const json = JSON.parse(text);
      const f = json?.data?.biz_data?.files?.[0];
      last = f?.status ?? last;
      if (last === 'SUCCESS' || last === 'READY') return { ok: true, status: last, info: f };
      if (last === 'FAILED' || last === 'CONTENT_EMPTY' || f?.audit_result === 'reject') {
        return { ok: false, status: last, info: f };
      }
    } catch { /* 继续轮询 */ }
  }
  return { ok: false, status: last };
}

/**
 * 一次性：把若干 URL 变成可用的 file_id 列表
 * @returns {Promise<string[]>}
 */
export async function prepareImages(upstream, account, urls, log = () => {}) {
  const ids = [];
  for (let i = 0; i < urls.length; i++) {
    const img = await fetchImage(urls[i], i);
    if (!img) { log('image_skip', { index: i }); continue; }
    const { fileId } = await uploadImage(upstream, account, img);
    const r = await waitForFile(upstream, account, fileId);
    log('image_ready', { index: i, fileId, status: r.status });
    if (r.ok) ids.push(fileId);
  }
  return ids;
}
