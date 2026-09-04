import { PROVIDER_TYPES, getProviderType } from '../core/providers.js';
import { sortProviders, filterProviders, collectAlerts } from '../core/status.js';
import { normalizeProviderConfig } from '../core/storage.js';
import { buildBackup, parseBackup, applyBackup } from '../core/backup.js';
import { getStoredTheme, setStoredTheme, applyTheme, THEMES } from '../core/theme.js';
import { openProviderForm } from './form.js';
import { styledConfirm } from './confirm.js';
import { viewTitle, providerCard, overviewView, providersView, logsView, settingsView } from './views.js';

const NAV_ITEMS = [
  { view: 'overview', label: '总览', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { view: 'providers', label: '供应商', icon: 'M4 6h16M4 12h16M4 18h10' },
  { view: 'logs', label: '查询日志', icon: 'M6 4h12v16l-6-3-6 3zM9 9h6' },
  { view: 'settings', label: '设置', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19' },
];

const VIEW_RENDERERS = {
  overview: overviewView,
  providers: providersView,
  logs: logsView,
  settings: settingsView,
};

function currentView() {
  const hash = (globalThis.location?.hash || '').replace(/^#\/?/, '');
  return VIEW_RENDERERS[hash] ? hash : 'overview';
}

export function renderApp({ root, repo, logger, service }) {
  let settings = repo.loadSettings();
  let busy = false;
  let autoTimer = null;
  const uiState = { query: '', statusFilter: 'all' };
  // 本次会话已弹窗提醒过的供应商 id：同一告警只提醒一次，恢复正常后从集合移除（下次再告警会重新计数）
  const alertedIds = new Set();
  // 桌面悬浮球开关状态（仅桌面壳 __TAURI__ 环境使用；由后端 ball-state-changed 事件驱动）
  let ballOn = false;
  const tauriEvents = globalThis.__TAURI__?.event;

  // ——— 低额度提醒（'popup' 界面弹窗 / 'notify' 桌面系统通知 / '' 关闭）———
  async function maybeAlert() {
    if (!settings.alertMethod) return;
    const alerts = collectAlerts(repo.listProviders(), settings);
    for (const id of [...alertedIds]) {
      if (!alerts.some((a) => a.id === id)) alertedIds.delete(id);
    }
    const fresh = alerts.filter((a) => !alertedIds.has(a.id));
    if (!fresh.length) return;
    fresh.forEach((a) => alertedIds.add(a.id));
    const title = `低额度提醒：${fresh.length} 家需要关注`;
    const body = fresh.map((a) => `【${a.name}】${a.reasons.join('；')}`).join('\n');
    // 系统通知走桌面壳原生 Toast；网页版（无 __TAURI__）回退界面弹窗
    if (settings.alertMethod === 'notify' && globalThis.__TAURI__?.event) {
      globalThis.__TAURI__.event.emit('show-notify', { title, body });
      return;
    }
    await styledConfirm({
      mount: document.body,
      title,
      message: body,
      confirmText: '知道了',
      cancelText: '关闭',
      danger: true,
    });
  }

  // ——— 刷新 ———
  function scheduleAutoRefresh() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    if (settings.autoRefreshMinutes > 0) {
      autoTimer = setInterval(() => {
        void refreshAll({ silent: true });
      }, settings.autoRefreshMinutes * 60 * 1000);
    }
  }

  async function refreshAll({ silent = false } = {}) {
    if (busy) return;
    busy = true;
    if (!silent) render();
    try {
      await service.refreshAll();
    } finally {
      busy = false;
      render();
      void maybeAlert();
    }
  }

  async function refreshOne(id) {
    if (busy) return;
    busy = true;
    render();
    try {
      await service.refreshProvider(id);
    } finally {
      busy = false;
      render();
      void maybeAlert();
    }
  }

  // ——— 供应商表单 ———
  function saveProviderFromForm(data) {
    const existing = data.id ? repo.getProvider(data.id) : null;
    const type = getProviderType(data.type);
    const config = normalizeProviderConfig({
      ...data,
      // 编辑时密钥输入留空表示沿用原密钥，前端从不回显明文
      apiKey: data.apiKey || (existing ? existing.apiKey : ''),
      apiSecret: data.apiSecret || (existing ? existing.apiSecret : ''),
      lastQuery: existing ? existing.lastQuery : null,
    });
    if (!type.autoQuery) {
      config.lastQuery = {
        time: new Date().toISOString(),
        status: 'unsupported',
        balance: null,
        currency: null,
        usage: null,
        extraLine: null,
        error: null,
      };
    }
    repo.saveProvider(config);
    render();
  }

  function openForm(existing) {
    openProviderForm({
      mount: document.body,
      providerTypes: PROVIDER_TYPES,
      existing,
      onSave: saveProviderFromForm,
    });
  }

  // ——— 备份 ———
  function exportBackup() {
    try {
      const backup = buildBackup(repo);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const d = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      a.href = url;
      a.download = `看额度备份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch {
      return false;
    }
  }

  async function importFromText(text) {
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      await styledConfirm({
        mount: document.body,
        title: '导入失败',
        message: parsed.error,
        confirmText: '知道了',
        cancelText: '关闭',
      });
      return false;
    }
    const ok = await styledConfirm({
      mount: document.body,
      title: '导入备份',
      message: `将覆盖当前数据：${parsed.backup.providers.length} 个供应商、${(parsed.backup.logs || []).length} 条日志。此操作不可撤销，确定继续吗？`,
      confirmText: '覆盖导入',
      danger: true,
    });
    if (!ok) return false;
    applyBackup(repo, parsed.backup);
    settings = repo.loadSettings();
    scheduleAutoRefresh();
    render();
    return true;
  }

  async function handleImportFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const text = await file.text();
    input.value = '';
    await importFromText(text);
  }

  // ——— 危险操作（样式化确认） ———
  async function deleteProvider(id) {
    const cfg = repo.getProvider(id);
    if (!cfg) return;
    const ok = await styledConfirm({
      mount: document.body,
      title: '删除供应商',
      message: `确定删除「${cfg.name}」吗？该操作不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    repo.deleteProvider(id);
    render();
  }

  async function clearLogs() {
    if (!logger.list().length) return;
    const ok = await styledConfirm({
      mount: document.body,
      title: '清空查询日志',
      message: `将删除全部 ${logger.list().length} 条查询日志，确定吗？`,
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    logger.clear();
    render();
  }

  async function clearAll() {
    const ok = await styledConfirm({
      mount: document.body,
      title: '清空全部数据',
      message: '将删除所有供应商配置、查询日志与设置（界面主题保留）。此操作不可恢复，确定吗？',
      confirmText: '全部清空',
      danger: true,
    });
    if (!ok) return;
    repo.clearAll();
    settings = repo.loadSettings();
    uiState.query = '';
    uiState.statusFilter = 'all';
    scheduleAutoRefresh();
    render();
  }

  // ——— 主题 ———
  function cycleTheme() {
    const order = THEMES;
    const next = order[(order.indexOf(getStoredTheme()) + 1) % order.length];
    setStoredTheme(next);
    applyTheme(next);
    render();
  }

  // ——— 桌面悬浮球开关（顶栏按钮 + 设置页）———
  function syncBallUi() {
    const btn = root.querySelector('[data-action="toggle-ball"]');
    if (btn) btn.classList.toggle('active', ballOn);
    const toggle = root.querySelector('[data-ball-toggle]');
    if (toggle) toggle.checked = ballOn;
  }

  // ——— 渲染 ———
  function renderContentView() {
    const view = currentView();
    const ctx = {
      providers: repo.listProviders(),
      logs: logger.list(),
      settings,
      busy,
      query: uiState.query,
      statusFilter: uiState.statusFilter,
      isDesktop: !!tauriEvents,
      ballVisible: ballOn,
    };
    const content = root.querySelector('[data-role="view-content"]');
    if (content) content.innerHTML = VIEW_RENDERERS[view](ctx);
    const navItems = root.querySelectorAll('[data-action="nav"]');
    navItems.forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    const title = root.querySelector('[data-role="view-title"]');
    if (title) title.textContent = viewTitle(view);
  }

  function render() {
    const view = currentView();
    const theme = getStoredTheme();
    root.innerHTML = `
      <div class="app" data-view="${view}">
        <aside class="sidebar">
          <div class="brand">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 17l5-6 4 4 4-7 5 9"/></svg>
            <span>看额度</span>
          </div>
          <nav class="nav">
            ${NAV_ITEMS.map(
              (item) => `
              <button class="nav-item ${item.view === view ? 'active' : ''}" data-action="nav" data-view="${item.view}">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="${item.icon}"/></svg>
                <span>${item.label}</span>
              </button>`,
            ).join('')}
          </nav>
          <div class="sidebar-foot">
            <button class="btn small ghost" data-action="open-mini" title="在独立小窗口中查看额度信息">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/></svg>
              迷你窗口
            </button>
            <p class="version">本地运行 · 数据不出本机</p>
          </div>
        </aside>
        <main class="main">
          <header class="topbar">
            <h1 data-role="view-title">${viewTitle(view)}</h1>
            <div class="actions">
              <button class="btn icon-btn" data-action="theme-cycle" title="切换主题（当前：${theme === 'auto' ? '跟随系统' : theme === 'light' ? '浅色' : '深色'}）" aria-label="切换主题">◐</button>
              ${tauriEvents ? `<button class="btn icon-btn ${ballOn ? 'active' : ''}" data-action="toggle-ball" title="悬浮球（当前：${ballOn ? '已开启' : '已关闭'}）" aria-label="悬浮球开关"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg></button>` : ''}
              <button class="btn primary ${busy ? 'is-loading' : ''}" data-action="refresh-all" ${busy ? 'disabled' : ''}>
                <span class="btn-spinner" aria-hidden="true"></span>${busy ? '刷新中…' : '↻ 一键刷新全部'}
              </button>
              <button class="btn" data-action="add">＋ 添加供应商</button>
            </div>
          </header>
          <section class="content" data-role="view-content"></section>
        </main>
      </div>`;
    renderContentView();
  }

  // ——— 事件（委托） ———
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const { action, id } = btn.dataset;
    if (action === 'nav') {
      globalThis.location.hash = `#/${btn.dataset.view}`;
      render();
    } else if (action === 'refresh-all') {
      await refreshAll();
    } else if (action === 'refresh') {
      await refreshOne(id);
    } else if (action === 'add') {
      openForm(null);
    } else if (action === 'edit') {
      openForm(repo.getProvider(id));
    } else if (action === 'delete') {
      await deleteProvider(id);
    } else if (action === 'clear-logs') {
      await clearLogs();
    } else if (action === 'open-mini') {
      window.open(`${location.pathname}?view=mini`, 'mqc-mini', 'width=360,height=600');
    } else if (action === 'theme-cycle') {
      cycleTheme();
    } else if (action === 'toggle-ball') {
      tauriEvents?.emit?.('set-ball', !ballOn);
    } else if (action === 'export-backup') {
      exportBackup();
    } else if (action === 'import-backup') {
      root.querySelector('[data-role="import-file"]')?.click();
    } else if (action === 'clear-all') {
      await clearAll();
    }
  });

  root.addEventListener('change', (e) => {
    const ballToggle = e.target.closest('[data-ball-toggle]');
    if (ballToggle) {
      tauriEvents?.emit?.('set-ball', ballToggle.checked);
      return;
    }
    const themeSelect = e.target.closest('[data-setting-theme]');
    if (themeSelect) {
      setStoredTheme(themeSelect.value);
      applyTheme(themeSelect.value);
      render();
      return;
    }
    const alertSelect = e.target.closest('[data-setting-alertmethod]');
    if (alertSelect) {
      settings = { ...settings, alertMethod: alertSelect.value };
      repo.saveSettings(settings);
      render();
      return;
    }
    const importFile = e.target.closest('[data-role="import-file"]');
    if (importFile) {
      void handleImportFile(importFile);
      return;
    }
    const filterSelect = e.target.closest('[data-filter-status]');
    if (filterSelect) {
      uiState.statusFilter = filterSelect.value;
      renderContentView();
      return;
    }
    const toggle = e.target.closest('[data-setting-bool]');
    if (toggle) {
      settings = { ...settings, [toggle.dataset.settingBool]: toggle.checked };
      repo.saveSettings(settings);
      render();
      return;
    }
    const input = e.target.closest('[data-setting]');
    if (!input) return;
    const key = input.dataset.setting;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) return;
    settings = { ...settings, [key]: value };
    repo.saveSettings(settings);
    scheduleAutoRefresh();
    render();
  });

  // 搜索输入：只重绘卡片区与计数，保持输入焦点
  root.addEventListener('input', (e) => {
    const search = e.target.closest('[data-search]');
    if (!search) return;
    uiState.query = search.value;
    const container = root.querySelector('[data-cards-container]');
    if (!container) return;
    const ctx = {
      providers: repo.listProviders(),
      settings,
      busy,
      query: uiState.query,
      statusFilter: uiState.statusFilter,
    };
    const filtered = filterProviders(sortProviders(ctx.providers, ctx.settings), ctx.settings, {
      query: ctx.query,
      status: ctx.statusFilter,
    });
    container.innerHTML =
      filtered.map((p) => providerCard(p, ctx.settings)).join('') ||
      `<div class="empty-state"><p>${ctx.providers.length ? '没有符合当前搜索 / 筛选条件的供应商。' : '还没有供应商。'}</p></div>`;
    const count = root.querySelector('[data-role="toolbar-count"]');
    if (count) count.textContent = `${filtered.length} / ${ctx.providers.length} 家`;
  });

  globalThis.addEventListener('hashchange', render);

  // 桌面壳：订阅悬浮球状态广播（顶栏按钮/设置页开关同步），并请求一次当前状态
  if (tauriEvents?.listen) {
    void tauriEvents.listen('ball-state-changed', (e) => {
      ballOn = e.payload === true;
      syncBallUi();
    });
    tauriEvents.emit('ball-state-request');
  }

  scheduleAutoRefresh();
  render();

  return { refreshAll, refreshOne, render, importFromText, exportBackup, deleteProvider, clearAll };
}
