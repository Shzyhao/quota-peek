import { collectAlerts, STATUS_LABELS } from '../core/status.js';
import { escapeHtml, formatMoney } from './format.js';

// 大额压缩显示：球内空间有限，≥1 亿显示 x.x亿，≥1 万显示 x.x万，金额修剪尾零
function compactAmount(total, currency) {
  if (total >= 1e8) return `${(total / 1e8).toFixed(1)}亿`;
  if (total >= 1e4) return `${(total / 1e4).toFixed(1)}万`;
  return formatMoney(total, currency)
    .replace('.00', '')
    .replace(/(\.\d)0$/, '$1');
}

// 悬浮球视图（#ball）：桌面常驻置顶圆形小窗。数据取共享 localStorage；
// 单击 = 通知桌面壳在球旁展开迷你窗（网页版无 __TAURI__ 时点击无动作）；拖动 = 手动触发原生窗口拖动。
export function renderBall({ root, repo }) {
  function render() {
    const providers = repo.listProviders();
    const settings = repo.loadSettings();
    const alerts = collectAlerts(providers, settings);

    // 配色分级：有异常告警 → 红；仅有低值/到期类提醒 → 琥珀；全部正常 → 科技蓝
    let level = 'ok';
    if (alerts.some((a) => a.level === 'error')) level = 'error';
    else if (alerts.length) level = 'warn';

    // 主数值优先级：告警数 > 余额合计 > 供应商数
    let num = String(providers.length);
    let label = '供应商';
    if (alerts.length) {
      num = String(alerts.length);
      label = '需关注';
    } else {
      const withBalance = providers.filter((p) => p.lastQuery?.status === 'ok' && p.lastQuery?.balance != null);
      if (withBalance.length) {
        const total = withBalance.reduce((sum, p) => sum + Number(p.lastQuery.balance), 0);
        num = compactAmount(total, withBalance[0].lastQuery.currency);
        label = '余额';
      }
    }

    // 原生 tooltip：告警时逐行列出原因，正常时说明用法
    const tip = alerts.length
      ? `看额度 · ${alerts.length} 项需关注（单击展开速览，拖动移动位置）\n${alerts
          .map((a) => `· ${a.name}【${STATUS_LABELS[a.level]}】${a.reasons.join('；')}`)
          .join('\n')}`
      : '看额度 · 单击展开速览，拖动移动位置';

    root.innerHTML = `
      <div class="ball level-${level}" title="${escapeHtml(tip)}">
        <span class="ball-ring"></span>
        <span class="ball-num${num.length >= 6 ? ' long' : ''}">${num}</span>
        <span class="ball-label">${label}</span>
      </div>`;
  }

  // 手动区分单击与拖动：不用 data-tauri-drag-region（其模态拖拽循环会吞掉 click 事件）。
  // 按下后移动超过阈值 → 调窗口 API 原生拖动；原地松开 → 视为单击，通知桌面壳展开迷你窗。
  const ballEl = () => root.querySelector('.ball');
  let press = null;
  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !ballEl()?.contains(e.target)) return;
    press = { x: e.screenX, y: e.screenY };
  });
  root.addEventListener('mousemove', (e) => {
    if (!press) return;
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 6) {
      press = null;
      globalThis.__TAURI__?.window?.getCurrentWindow?.()?.startDragging?.();
    }
  });
  root.addEventListener('mouseup', () => {
    if (press) {
      // 仅桌面壳（withGlobalTauri）有事件通道；网页版悬浮球路由一般不会被访问
      globalThis.__TAURI__?.event?.emit?.('ball-clicked');
    }
    press = null;
  });

  // 圆形徽章模式：球体填满整个无边框窗口，外观由 .ball 样式呈现
  document.documentElement.classList.add('ball-mode');

  // 与迷你窗同频：定期重绘，同步其他窗口写入的数据
  setInterval(render, 30000);
  render();

  return { render };
}
