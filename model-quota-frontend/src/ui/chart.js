// 轻量 SVG 图表（零依赖）：折线图（多序列）+ 横向条行。
// 配色固定中间亮调，浅色/深色主题下都可读；尺寸随容器宽度（viewBox 自适应）。

export const CHART_COLORS = ['#3b82f6', '#22a06b', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#64748b'];

const fmtNum = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  if (Math.abs(n) >= 100) return String(Math.round(n));
  return n.toFixed(Math.abs(n) < 10 && !Number.isInteger(n) ? 2 : 0);
};

const fmtDay = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/// 多序列折线图。series: [{ name, points: [{ t, b }] }]，返回 SVG 字符串。
/// 单点序列画成圆点；空序列整体显示空态。
export function lineChart(series, { height = 220, yFormatter = fmtNum } = {}) {
  const withPoints = (series || []).filter((s) => s.points?.length);
  if (!withPoints.length) return '';
  const W = 720;
  const H = height;
  const PAD_L = 52;
  const PAD_R = 14;
  const PAD_T = 14;
  const PAD_B = 26;
  const allX = withPoints.flatMap((s) => s.points.map((p) => p.t));
  const allY = withPoints.flatMap((s) => s.points.map((p) => p.b));
  const xMin = Math.min(...allX);
  const xMax = Math.max(...allX);
  let yMin = Math.min(...allY);
  let yMax = Math.max(...allY);
  if (yMin === yMax) { yMin = Math.max(0, yMin - 1); yMax = yMax + 1; }
  else { const pad = (yMax - yMin) * 0.12; yMin = Math.max(0, yMin - pad); yMax = yMax + pad; }
  const spanX = Math.max(1, xMax - xMin);
  const spanY = Math.max(1e-9, yMax - yMin);
  const x = (t) => PAD_L + ((t - xMin) / spanX) * (W - PAD_L - PAD_R);
  const y = (v) => PAD_T + (1 - (v - yMin) / spanY) * (H - PAD_T - PAD_B);

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="趋势图">`);
  // 横向网格 4 条 + y 轴标签
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (spanY * i) / 4;
    const yy = y(v);
    parts.push(`<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="rgba(128,128,128,0.18)" stroke-width="1"/>`);
    parts.push(`<text x="${PAD_L - 6}" y="${yy + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${yFormatter(v)}</text>`);
  }
  // x 轴日期标签（首/中/尾）
  const xTicks = withPoints.some((s) => s.points.length > 1)
    ? [xMin, xMin + spanX / 2, xMax]
    : [xMin];
  for (const t of xTicks) {
    parts.push(`<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${fmtDay(t)}</text>`);
  }
  // 序列
  withPoints.forEach((s, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const pts = s.points;
    if (pts.length === 1) {
      parts.push(`<circle cx="${x(pts[0].t)}" cy="${y(pts[0].b)}" r="4" fill="${color}"><title>${s.name}: ${yFormatter(pts[0].b)}</title></circle>`);
      return;
    }
    const path = pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.b).toFixed(1)}`).join(' ');
    parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    // 首末点标记
    for (const p of [pts[0], pts[pts.length - 1]]) {
      parts.push(`<circle cx="${x(p.t)}" cy="${y(p.b)}" r="3" fill="${color}"><title>${s.name}: ${yFormatter(p.b)}</title></circle>`);
    }
  });
  parts.push('</svg>');
  return parts.join('');
}

/// 图例。series: [{ name, color }]
export function legend(series) {
  return (series || [])
    .map((s, i) => `<span class="chart-legend-item"><span class="chart-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>${s.name}</span>`)
    .join('');
}

/// 横向条行（Token 用量按天）：rows: [{ label, value, max, hint }]
export function barRows(rows, { valueFormatter = fmtNum } = {}) {
  const max = Math.max(1, ...(rows || []).map((r) => r.max ?? r.value));
  return (rows || [])
    .map((r) => `
      <div class="chart-bar-row" title="${r.hint || ''}">
        <span class="chart-bar-label">${r.label}</span>
        <span class="chart-bar-track"><span class="chart-bar-fill" style="width:${Math.min(100, (r.value / max) * 100).toFixed(1)}%"></span></span>
        <span class="chart-bar-value">${valueFormatter(r.value)}</span>
      </div>`)
    .join('');
}
