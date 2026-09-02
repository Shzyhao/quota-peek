import { evaluateProvider, remainingQuotaOf } from '../core/status.js';
import { escapeHtml, formatMoney, formatNumber, formatDateTime } from './format.js';

// 迷你小窗口视图（?view=mini）：紧凑列表 + 微型进度条，主题跟随全局（mqc.theme）。
export function renderMini({ root, repo, logger, service }) {
  let busy = false;

  const clampPercent = (v) => Math.max(0, Math.min(100, v));
  const fillLevel = (v) => (v >= 90 ? 'error' : v >= 80 ? 'warn' : 'ok');

  async function refreshAll() {
    if (busy) return;
    busy = true;
    render();
    try {
      await service.refreshAll();
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    const providers = repo.listProviders();
    const settings = repo.loadSettings();
    const rank = { error: 0, warn: 1, ok: 2, neutral: 3 };
    const sorted = [...providers].sort(
      (a, b) => rank[evaluateProvider(a, settings).level] - rank[evaluateProvider(b, settings).level],
    );
    const lastTimes = providers.map((p) => p.lastQuery?.time).filter(Boolean).sort();
    const latest = lastTimes.length ? formatDateTime(lastTimes.at(-1)) : '—';

    root.innerHTML = `
      <div class="mini">
        <header class="mini-head">
          <span>模型额度一览</span>
          <button class="btn small" data-action="refresh-all" ${busy ? 'disabled' : ''}>${busy ? '刷新中…' : '刷新'}</button>
        </header>
        <ul class="mini-list">
          ${
            sorted
              .map((p) => {
                const health = evaluateProvider(p, settings);
                const last = p.lastQuery;
                const usage = last && last.status === 'ok' ? last.usage : null;
                const main = usage
                  ? `5h ${usage.windowUsedPercent == null ? '—' : `${usage.windowUsedPercent}%`}${p.expiryDate ? ` · ${escapeHtml(p.expiryDate)}` : ''}`
                  : `${last && last.status === 'ok' ? formatMoney(last.balance, last.currency) : '—'} · 剩余 ${formatNumber(remainingQuotaOf(p))}${p.expiryDate ? ` · ${escapeHtml(p.expiryDate)}` : ''}`;
                const barPercent = usage
                  ? usage.windowUsedPercent
                  : Number(p.planTotalQuota) > 0 && remainingQuotaOf(p) != null
                    ? (remainingQuotaOf(p) / Number(p.planTotalQuota)) * 100
                    : null;
                // 用量型按已用分档；余额型 barPercent 是「剩余占比」，需按已用（100-剩余）分档
                const fillCls = usage
                  ? fillLevel(barPercent)
                  : fillLevel(barPercent == null ? null : 100 - barPercent);
                return `
              <li class="mini-item level-${health.level}">
                <span class="dot level-${health.level}" title="${escapeHtml(health.label)}"></span>
                <div class="mini-main">
                  <span class="mini-name">${escapeHtml(p.name)}</span>
                  <span class="mini-sub">${main}</span>
                  ${barPercent != null ? `<div class="progress mini-bar"><div class="fill ${fillCls}" style="width:${clampPercent(barPercent)}%"></div></div>` : ''}
                </div>
                <span class="mini-status">${escapeHtml(health.label)}</span>
              </li>`;
              })
              .join('') || '<li class="mini-empty">暂无供应商，请到主界面添加</li>'
          }
        </ul>
        <footer class="mini-foot">最近更新：${latest}</footer>
      </div>`;
  }

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="refresh-all"]');
    if (btn && !btn.disabled) void refreshAll();
  });

  // 每 30 秒重绘一次（同步主界面/其他小窗口写入的数据）
  setInterval(render, 30000);
  render();

  return { refreshAll, render };
}
