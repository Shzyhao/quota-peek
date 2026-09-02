// Base URL 规范化：去除首尾空白与末尾斜杠，空值回退默认地址。
export function normalizeBaseUrl(url, fallback = '') {
  const s = String(url || fallback || '').trim();
  return s.replace(/\/+$/, '');
}
