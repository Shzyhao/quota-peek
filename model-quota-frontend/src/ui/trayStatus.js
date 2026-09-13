import { collectAlerts, STATUS_LABELS } from '../core/status.js';

// 托盘动态图标：按当前全局健康度在前端绘制 32×32 RGBA（底色=严重度、白字=最高用量%），
// 连同摘要 tooltip 经 update_tray_status 命令交给 Rust 更新托盘；网页版（无 __TAURI__）为空操作。
// 纯函数 computeTrayStatus 单测覆盖，drawIcon 依赖 Canvas 仅桌面壳真实环境使用。

const SIZE = 32;
// 严重度配色：绿=全部正常 / 琥珀=有提醒 / 红=有异常 / 灰=暂无数据
const LEVEL_COLORS = {
  ok: [34, 197, 94],
  warn: [245, 158, 11],
  error: [239, 68, 68],
  idle: [148, 163, 184],
};

// 计算托盘状态：level 决定底色；badge 取已查询供应商的最高用量%（5h/周取大者，无数据显示纯色块）；
// tooltip 为多行摘要（Windows 上限 128 字符，截断）
export function computeTrayStatus(providers, settings) {
  const enabled = (providers || []).filter((p) => p.enabled !== false);
  const alerts = collectAlerts(enabled, settings);

  let level = 'ok';
  if (!enabled.length) level = 'idle';
  else if (alerts.some((a) => a.level === 'error')) level = 'error';
  else if (alerts.length) level = 'warn';

  let badge = null;
  for (const p of enabled) {
    const usage = p.lastQuery?.status === 'ok' ? p.lastQuery.usage : null;
    if (!usage) continue;
    for (const v of [usage.windowUsedPercent, usage.weeklyUsedPercent]) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        badge = Math.max(badge ?? 0, Math.round(v));
      }
    }
  }
  if (badge != null) badge = Math.min(999, badge);

  const lines = alerts.length
    ? [
        `桌看 · ${alerts.length} 项需关注`,
        ...alerts.slice(0, 2).map((a) => `· ${a.name}【${STATUS_LABELS[a.level]}】${a.reasons[0] || ''}`),
      ]
    : ['桌看 · 额度全部正常'];
  return { level, badge, tooltip: lines.join('\n').slice(0, 127) };
}

// 圆角方块底 + 居中数字（按位数降字号），返回 RGBA 像素数组；Canvas 不可用返回 null
function drawIcon({ level, badge }) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const [r, g, b] = LEVEL_COLORS[level] || LEVEL_COLORS.idle;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.beginPath();
  ctx.roundRect(1, 1, SIZE - 2, SIZE - 2, 8);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fill();

  if (badge != null) {
    const text = String(badge);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${text.length >= 3 ? 13 : text.length === 2 ? 16 : 19}px 'Segoe UI', sans-serif`;
    ctx.fillText(text, SIZE / 2, SIZE / 2 + 1);
  } else {
    // 无用量数据（纯余额型供应商）：画白色三柱条（与应用图标同款 motif），避免纯色块
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    const baseY = SIZE - 7;
    [{ h: 8, x: 7 }, { h: 13, x: 14 }, { h: 18, x: 21 }].forEach(({ h, x }) => {
      ctx.beginPath();
      ctx.roundRect(x, baseY - h, 4.5, h, 2);
      ctx.fill();
    });
  }
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

export function updateTrayStatus(repo, settings) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const status = computeTrayStatus(repo.listProviders(), settings);
  const rgba = drawIcon(status);
  if (!rgba) return;
  invoke('update_tray_status', {
    rgba: Array.from(rgba),
    width: SIZE,
    height: SIZE,
    tooltip: status.tooltip,
  }).catch(() => {});
}
