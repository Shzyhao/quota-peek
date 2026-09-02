export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function formatNumber(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  // 千分位分组：大额额度（如 155000000 → 155,000,000）更易读
  return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' };

export function formatMoney(v, currency) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  const symbol = CURRENCY_SYMBOLS[currency] || (currency ? `${currency} ` : '');
  return `${symbol}${n.toFixed(2)}`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
