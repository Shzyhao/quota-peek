import { getProviderType } from '../core/providers.js';
import {
  evaluateProvider,
  QUERY_STATUS_LABELS,
  remainingQuotaOf,
  daysUntil,
  sortProviders,
  filterProviders,
} from '../core/status.js';
import { maskApiKey } from '../core/mask.js';
import { THEME_LABELS, getStoredTheme } from '../core/theme.js';
import { escapeHtml, formatMoney, formatNumber, formatDateTime } from './format.js';

const LOG_STATUS_LABELS = { ok: '成功', failed: '失败', unsupported: '不支持' };

const VIEW_TITLES = {
  overview: '总览',
  providers: '供应商',
  logs: '查询日志',
  settings: '设置',
};

export function viewTitle(view) {
  return VIEW_TITLES[view] || VIEW_TITLES.overview;
}

const pctText = (v) => (v == null ? '—' : `${v}%`);
const clampPercent = (v) => Math.max(0, Math.min(100, v));

// 进度条填充色：按数值分档 <80 正常 / <90 提醒 / ≥90 告警
function fillLevel(v) {
  if (v == null) return 'none';
  if (v >= 90) return 'error';
  if (v >= 80) return 'warn';
  return 'ok';
}

function barTitle(label, used, total) {
  if (used != null && total != null) return `${label}：已用 ${formatNumber(used)} / 总额 ${formatNumber(total)}`;
  return label;
}

// 重置时间显示为 MM-dd HH:mm（本地时区）
function formatReset(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// invert：数值语义是「剩余占比」时为 true，配色按已用（100-剩余）分档，避免「几乎没用却标红」
function barRow(label, value, { title = '', invert = false } = {}) {
  if (value == null) return '';
  // 显示值保留 1 位小数，避免推导出的 99.9876543210% 之类长小数撑爆数值列
  const pct = Math.round(value * 10) / 10;
  return `
    <div class="bar-row" title="${escapeHtml(title)}">
      <span class="bar-label">${escapeHtml(label)}</span>
      <div class="progress"><div class="fill ${fillLevel(invert ? 100 - value : value)}" style="width:${clampPercent(value)}%"></div></div>
      <span class="bar-value">${pct}%</span>
    </div>`;
}

// Coding Plan 卡片的第三/四个指标：优先接口返回的周额度数值，其次 5 小时窗口，最后手动填写值
function quotaMetricPair(usage, p) {
  if (usage.weeklyTotal != null) {
    return [
      ['本周已用', usage.weeklyUsed],
      ['本周总额', usage.weeklyTotal],
    ];
  }
  if (usage.windowTotal != null) {
    return [
      ['5 小时已用', usage.windowUsed],
      ['5 小时总额', usage.windowTotal],
    ];
  }
  return [
    ['已用额度', p.usedQuota],
    ['套餐总额度', p.planTotalQuota],
  ];
}

function usageDetailText(p) {
  const last = p.lastQuery;
  const usage = last?.usage;
  if (!usage) return last?.extraLine || null;
  const parts = [];
  if (usage.monthlyUsedPercent != null) parts.push(`本月 MCP ${pctText(usage.monthlyUsedPercent)}`);
  if (usage.windowResetAt) parts.push(`5 小时额度重置于 ${formatReset(usage.windowResetAt)}`);
  if (usage.weeklyResetAt) parts.push(`周额度重置于 ${formatReset(usage.weeklyResetAt)}`);
  if (last.extraLine) parts.push(last.extraLine);
  return parts.length ? parts.join(' · ') : null;
}

export function providerCard(p, settings) {
  const type = getProviderType(p.type);
  const health = evaluateProvider(p, settings);
  const last = p.lastQuery;
  const queryStatusKey = p.enabled === false ? 'paused' : last ? last.status : 'none';
  const queryStatusLabel = QUERY_STATUS_LABELS[queryStatusKey] || queryStatusKey;
  const usage = last && last.status === 'ok' ? last.usage : null;

  // 用量可视化：Coding Plan 展示 5h/周/月度进度条；余额型展示剩余额度占比条
  let bars = '';
  if (usage) {
    bars = barRow('近 5 小时', usage.windowUsedPercent, { title: barTitle('近 5 小时', usage.windowUsed, usage.windowTotal) })
      + barRow('本周', usage.weeklyUsedPercent, { title: barTitle('本周', usage.weeklyUsed, usage.weeklyTotal) })
      + barRow('本月 MCP', usage.monthlyUsedPercent, { title: barTitle('本月 MCP', usage.monthlyUsed, usage.monthlyTotal) });
  } else {
    const total = Number(p.planTotalQuota);
    const remaining = remainingQuotaOf(p);
    if (Number.isFinite(total) && total > 0 && remaining != null) {
      bars = barRow('剩余额度', (remaining / total) * 100, { invert: true, title: `剩余 ${formatNumber(remaining)} / 总 ${formatNumber(total)}` });
    }
  }

  // Coding Plan 类套餐没有“余额”概念，指标区改展示套餐用量与额度数值
  const quotaPair = usage ? quotaMetricPair(usage, p) : null;
  const firstMetric = usage
    ? `<div class="metric"><span class="metric-label">近 5 小时用量</span><span class="metric-value">${pctText(usage.windowUsedPercent)}</span></div>`
    : `<div class="metric"><span class="metric-label">余额</span><span class="metric-value">${last && last.status === 'ok' ? formatMoney(last.balance, last.currency) : '—'}</span></div>`;
  const secondMetric = usage
    ? `<div class="metric"><span class="metric-label">本周用量</span><span class="metric-value">${pctText(usage.weeklyUsedPercent)}</span></div>`
    : `<div class="metric"><span class="metric-label">剩余额度</span><span class="metric-value">${formatNumber(remainingQuotaOf(p))}</span></div>`;
  const thirdMetric = quotaPair
    ? `<div class="metric"><span class="metric-label">${escapeHtml(quotaPair[0][0])}</span><span class="metric-value">${formatNumber(quotaPair[0][1])}</span></div>`
    : `<div class="metric"><span class="metric-label">已用额度</span><span class="metric-value">${formatNumber(p.usedQuota)}</span></div>`;
  const fourthMetric = quotaPair
    ? `<div class="metric"><span class="metric-label">${escapeHtml(quotaPair[1][0])}</span><span class="metric-value">${formatNumber(quotaPair[1][1])}</span></div>`
    : `<div class="metric"><span class="metric-label">套餐总额度</span><span class="metric-value">${formatNumber(p.planTotalQuota)}</span></div>`;

  const usageDetail = last && last.status === 'ok' ? usageDetailText(p) : null;

  function expiryText() {
    if (!p.expiryDate) return '—';
    const d = daysUntil(p.expiryDate);
    if (d == null) return escapeHtml(p.expiryDate);
    if (d < 0) return `${escapeHtml(p.expiryDate)}（已到期）`;
    return `${escapeHtml(p.expiryDate)}（${d} 天后）`;
  }

  return `
    <article class="card level-${health.level}">
      <div class="card-head">
        <div class="card-title">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="type-badge">${type.label}</span>
          ${p.enabled === false ? '<span class="type-badge muted">已停用</span>' : ''}
        </div>
        <span class="status-badge ${health.level}">${health.label}</span>
      </div>
      <div class="metrics">
        ${firstMetric}
        ${secondMetric}
        ${thirdMetric}
        ${fourthMetric}
      </div>
      ${bars ? `<div class="bars">${bars}</div>` : ''}
      <div class="meta">
        <div class="meta-row"><span>到期时间</span><b>${expiryText()}</b></div>
        <div class="meta-row"><span>查询状态</span><b>${queryStatusLabel}</b></div>
        <div class="meta-row"><span>最后更新</span><b>${formatDateTime(last ? last.time : null)}</b></div>
          <div class="meta-row"><span>${escapeHtml(type.credentialLabel || 'API Key')}</span><b class="mono">${p.apiKey ? maskApiKey(p.apiKey) : '未配置'}</b></div>
          ${p.apiSecret ? `<div class="meta-row"><span>Secret Key</span><b class="mono">${maskApiKey(p.apiSecret)}</b></div>` : ''}
        ${usageDetail ? `<div class="meta-row"><span>套餐详情</span><b>${escapeHtml(usageDetail)}</b></div>` : ''}
        ${p.note ? `<div class="meta-row"><span>备注</span><b>${escapeHtml(p.note)}</b></div>` : ''}
      </div>
      ${health.reasons.length ? `<ul class="reasons level-${health.level}">${health.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
      <div class="card-actions">
        <button class="btn small" data-action="refresh" data-id="${p.id}" ${!type.autoQuery ? 'disabled' : ''} title="${type.autoQuery ? '调用官方接口刷新额度信息' : '该供应商不支持自动查询，请在「编辑」中手动维护额度信息'}">刷新</button>
        <button class="btn small" data-action="edit" data-id="${p.id}">编辑</button>
        <button class="btn small danger" data-action="delete" data-id="${p.id}">删除</button>
      </div>
    </article>`;
}

function emptyState(text, cta = '') {
  return `
    <div class="empty-state">
      <svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <rect x="7" y="11" width="34" height="27" rx="4"></rect>
        <path d="M7 19h34"></path><path d="M15 11V7"></path><path d="M33 11V7"></path>
        <path d="M17 28l4 4 8-8"></path>
      </svg>
      <p>${escapeHtml(text)}</p>
      ${cta}
    </div>`;
}

// —— 总览 ——
export function overviewView(ctx) {
  const { providers, settings, busy } = ctx;
  const enabled = providers.filter((p) => p.enabled !== false);
  const withBalance = providers.filter((p) => p.lastQuery?.status === 'ok' && p.lastQuery.balance != null);
  const totalBalance = withBalance.reduce((sum, p) => sum + Number(p.lastQuery.balance), 0);
  const alerts = providers.map((p) => evaluateProvider(p, settings));
  const errorCount = alerts.filter((a) => a.level === 'error').length;
  const warnCount = alerts.filter((a) => a.level === 'warn').length;
  const lastTimes = providers.map((p) => p.lastQuery?.time).filter(Boolean).sort();
  const cards = sortProviders(providers, settings).map((p) => providerCard(p, settings)).join('');

  return `
    <div class="stats">
      <div class="stat">
        <span class="stat-label">余额合计</span>
        <b class="stat-value">${withBalance.length ? formatMoney(totalBalance, 'CNY') : '—'}</b>
        <i class="stat-hint">${withBalance.length} 个可查余额账户</i>
      </div>
      <div class="stat">
        <span class="stat-label">供应商</span>
        <b class="stat-value">${providers.length}</b>
        <i class="stat-hint">启用 ${enabled.length} · 手动 ${providers.length - enabled.length}</i>
      </div>
      <div class="stat ${errorCount || warnCount ? 'is-alert' : 'is-ok'}">
        <span class="stat-label">需要关注</span>
        <b class="stat-value">${errorCount + warnCount}</b>
        <i class="stat-hint">${errorCount} 异常 · ${warnCount} 提醒</i>
      </div>
      <div class="stat">
        <span class="stat-label">最近刷新</span>
        <b class="stat-value stat-time">${formatDateTime(lastTimes.at(-1))}</b>
        <i class="stat-hint">${busy ? '正在刷新…' : '定时刷新在设置中配置'}</i>
      </div>
    </div>
    <div class="section-head"><h2>供应商概览</h2></div>
    <div class="cards">
      ${cards || emptyState('还没有供应商，添加后即可自动查询额度。', '<button class="btn primary" data-action="add">＋ 添加供应商</button>')}
    </div>`;
}

// —— 供应商列表（搜索 + 筛选） ——
export function providersView(ctx) {
  const { providers, settings, query, statusFilter } = ctx;
  const filtered = filterProviders(sortProviders(providers, settings), settings, { query, status: statusFilter });
  const cards = filtered.map((p) => providerCard(p, settings)).join('');

  return `
    <div class="toolbar">
      <input class="search-input" data-search type="search" placeholder="搜索名称 / 备注 / 类型…" value="${escapeHtml(query)}" aria-label="搜索供应商">
      <select data-filter-status class="filter-select" aria-label="按状态筛选">
        <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>全部状态</option>
        <option value="attention" ${statusFilter === 'attention' ? 'selected' : ''}>需要关注</option>
        <option value="ok" ${statusFilter === 'ok' ? 'selected' : ''}>正常</option>
        <option value="error" ${statusFilter === 'error' ? 'selected' : ''}>异常</option>
        <option value="warn" ${statusFilter === 'warn' ? 'selected' : ''}>提醒</option>
        <option value="disabled" ${statusFilter === 'disabled' ? 'selected' : ''}>已停用</option>
      </select>
      <span class="toolbar-count" data-role="toolbar-count">${filtered.length} / ${providers.length} 家</span>
    </div>
    <div class="cards" data-cards-container>
      ${cards || emptyState(providers.length ? '没有符合当前搜索 / 筛选条件的供应商。' : '还没有供应商，添加后即可自动查询额度。', providers.length ? '' : '<button class="btn primary" data-action="add">＋ 添加供应商</button>')}
    </div>`;
}

// —— 查询日志 ——
export function logsView(ctx) {
  const { logs } = ctx;
  if (!logs.length) {
    return emptyState('暂无查询日志，点击右上角「一键刷新全部」或单个供应商的「刷新」生成。');
  }
  return `
    <div class="section-head">
      <h2>最近 ${logs.length} 条（本地保留 100 条）</h2>
      <button class="btn small" data-action="clear-logs">清空日志</button>
    </div>
    <div class="table-wrap">
      <table class="log-table">
        <thead>
          <tr><th>查询时间</th><th>供应商</th><th>状态</th><th>余额</th><th>剩余额度</th><th>错误信息</th></tr>
        </thead>
        <tbody>
          ${logs
            .map(
              (l) => `
            <tr>
              <td class="mono">${formatDateTime(l.time)}</td>
              <td>${escapeHtml(l.providerName)}</td>
              <td><span class="log-status ${l.status}">${LOG_STATUS_LABELS[l.status] || l.status}</span></td>
              <td>${formatNumber(l.balance)}</td>
              <td>${formatNumber(l.remainingQuota)}</td>
              <td class="error-cell">${escapeHtml(l.error || '—')}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

// —— 设置 ——
export function settingsView(ctx) {
  const { settings } = ctx;
  const theme = getStoredTheme();
  return `
    <div class="settings-layout">
      <section class="settings-card">
        <h3>提醒阈值与定时刷新</h3>
        <div class="settings-grid">
          <label>余额过低提醒（≤）<input data-setting="lowBalanceThreshold" type="number" min="0" step="0.01" value="${settings.lowBalanceThreshold}"></label>
          <label>剩余额度过低（≤ %）<input data-setting="lowRemainingPercent" type="number" min="0" max="100" value="${settings.lowRemainingPercent}"></label>
          <label>到期提醒（提前天数）<input data-setting="expiryWarningDays" type="number" min="0" value="${settings.expiryWarningDays}"></label>
          <label>定时刷新（分钟，0 = 关闭）<input data-setting="autoRefreshMinutes" type="number" min="0" value="${settings.autoRefreshMinutes}"></label>
        </div>
      </section>

      <section class="settings-card">
        <h3>外观</h3>
        <div class="settings-grid">
          <label>界面主题
            <select data-setting-theme>
              <option value="auto" ${theme === 'auto' ? 'selected' : ''}>跟随系统</option>
              <option value="light" ${theme === 'light' ? 'selected' : ''}>浅色</option>
              <option value="dark" ${theme === 'dark' ? 'selected' : ''}>深色</option>
            </select>
          </label>
        </div>
        <p class="settings-hint">当前生效：${THEME_LABELS[theme]}；深色模式同样作用于迷你小窗口。</p>
      </section>

      <section class="settings-card">
        <h3>数据备份</h3>
        <p class="settings-hint">所有数据保存在本浏览器 localStorage。可导出 JSON 备份，或从备份文件恢复。<br>⚠ 备份文件包含 API Key 明文，请妥善保管，不要分享给他人。</p>
        <div class="settings-actions">
          <button class="btn" data-action="export-backup">⬇ 导出备份</button>
          <button class="btn" data-action="import-backup">⬆ 导入备份</button>
          <input type="file" accept="application/json,.json" hidden data-role="import-file">
          <button class="btn danger" data-action="clear-all">清空全部数据</button>
        </div>
      </section>

      <section class="settings-card">
        <h3>关于</h3>
        <p class="settings-hint">看额度（模型额度查询）· 纯前端本地工具 · 支持自动查询：DeepSeek / 智谱 / 火山方舟 / MiniMax / Kimi / 硅基流动 / StepFun / OpenRouter / Novita。<br>各供应商接口调研与安全说明见项目 README。</p>
      </section>
    </div>`;
}
