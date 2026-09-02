// API Key 脱敏：界面与日志中一律不允许出现明文。
const SK_TOKEN_PATTERN = /\bsk-[A-Za-z0-9_-]{6,}\b/g;

export function maskApiKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••••';
  return `${s.slice(0, 4)}••••••${s.slice(-4)}`;
}

// 从错误信息中移除可能泄漏的 API Key：先按完整密钥替换，再兜底替换 sk- 形式的 token。
export function sanitizeText(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    const s = String(secret ?? '').trim();
    if (s.length >= 4) out = out.split(s).join('***');
  }
  return out.replace(SK_TOKEN_PATTERN, (m) => `${m.slice(0, 3)}***`);
}
