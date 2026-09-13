import { collectAlerts, STATUS_LABELS } from '../core/status.js';

// 托盘/任务栏动态图标：底色按全局健康度变化（绿=正常 / 琥珀=提醒 / 红=异常 / 灰=无数据），
// 白字 ZK 为品牌标识（桌看 · ZhuoKan）。32×32 RGBA 经 update_tray_status 交给 Rust 同步
// 更新托盘与主窗大图标；网页版（无 __TAURI__）为空操作。
// 纯函数 computeTrayStatus 单测覆盖，drawIcon 依赖 Canvas 仅桌面壳真实环境使用。

const SIZE = 32;
const LEVEL_COLORS = {
  ok: [34, 197, 94],
  warn: [245, 158, 11],
  error: [239, 68, 68],
  idle: [148, 163, 184],
};

// 计算托盘状态：level 决定底色；tooltip 为多行摘要（Windows 上限 128 字符，截断）
export function computeTrayStatus(providers, settings) {
  const enabled = (providers || []).filter((p) => p.enabled !== false);
  const alerts = collectAlerts(enabled, settings);

  let level = 'ok';
  if (!enabled.length) level = 'idle';
  else if (alerts.some((a) => a.level === 'error')) level = 'error';
  else if (alerts.length) level = 'warn';

  const lines = alerts.length
    ? [
        `桌看 · ${alerts.length} 项需关注`,
        ...alerts.slice(0, 2).map((a) => `· ${a.name}【${STATUS_LABELS[a.level]}】${a.reasons[0] || ''}`),
      ]
    : ['桌看 · 额度全部正常'];
  return { level, tooltip: lines.join('\n').slice(0, 127) };
}

// 圆角方块底（严重度色）+ 居中白字 ZK，返回 RGBA 像素数组；Canvas 不可用返回 null
function drawIcon({ level }) {
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

  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = "bold 15px 'Segoe UI', sans-serif";
  ctx.fillText('ZK', SIZE / 2, SIZE / 2 + 1);
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
