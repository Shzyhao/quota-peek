import { PROVIDER_TYPES, getProviderType } from '../core/providers.js';
import { sortProviders, filterProviders, collectAlerts } from '../core/status.js';
import { normalizeProviderConfig } from '../core/storage.js';
import { buildBackup, parseBackup, applyBackup } from '../core/backup.js';
import { getStoredTheme, setStoredTheme, applyTheme, THEMES } from '../core/theme.js';
import { secretsAvailable, readSecret, writeSecret, deleteSecret, migrateSecretsToKeyring, cleanupOrphanSecrets } from '../core/secrets.js';
import { addTombstone } from '../core/models.js';
import { openProviderForm } from './form.js';
import { styledConfirm } from './confirm.js';
import { viewTitle, providerCard, homeView, overviewView, providersView, logsView, settingsView } from './views.js';
import { chatView, mountChatPage } from './chatView.js';
import { modelsView, mountModelsPage } from './modelsView.js';
import { notesView, mountNotesPage } from './notesView.js';
import { agentSettingsCard, mountAgentSettingsCard } from './agentSettings.js';
import { phoneSettingsCard, mountPhoneCard } from './phoneSettings.js';
import { analysisView, mountAnalysisPage } from './analysisView.js';
import { scheduleView, mountSchedulePage } from './scheduleView.js';
import { sessionsView, mountSessionsPage } from './sessionsView.js';
import { syncScheduleReminders } from '../core/schedule.js';
import { mountPetAppearanceCard } from './petSettings.js';
import { updateTrayStatus } from './trayStatus.js';

const NAV_ITEMS = [
  { view: 'home', label: '首页', icon: 'M4 11l8-7 8 7M6 10v9h12v-9' },
  { view: 'schedule', label: '日程', icon: 'M8 3v4M16 3v4M4 9h16M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z' },
  { view: 'chat', label: '对话', icon: 'M4 4h16v12H8l-4 4z' },
  { view: 'models', label: '模型配置', icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM12 12l8-4.5M12 12v9M12 12L4 7.5' },
  { view: 'sessions', label: '会话记录', icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
  { view: 'notes', label: '便签', icon: 'M9 3h6v3H9zM7 4H6a1 1 0 00-1 1v15a1 1 0 001 1h12a1 1 0 001-1V5a1 1 0 00-1-1h-1M9 10h6M9 14h6' },
  { view: 'analysis', label: '文件分析', icon: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M9 13h6M9 17h4' },
  { view: 'overview', label: '额度总览', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { view: 'providers', label: '供应商', icon: 'M4 6h16M4 12h16M4 18h10' },
  { view: 'logs', label: '查询日志', icon: 'M6 4h12v16l-6-3-6 3zM9 9h6' },
  { view: 'settings', label: '设置', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19' },
];

const VIEW_RENDERERS = {
  home: homeView,
  schedule: scheduleView,
  overview: overviewView,
  chat: chatView,
  models: modelsView,
  sessions: sessionsView,
  notes: notesView,
  analysis: analysisView,
  providers: providersView,
  logs: logsView,
  settings: settingsView,
};

function currentView() {
  const hash = (globalThis.location?.hash || '').replace(/^#\/?/, '');
  return VIEW_RENDERERS[hash] ? hash : 'home';
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
  // 悬浮形态：pet（Live2D 桌宠）/ ball（经典悬浮球），由后端 ball-form-changed 事件驱动
  let ballForm = 'pet';
  const tauriEvents = globalThis.__TAURI__?.event;
  const tauriInvoke = globalThis.__TAURI__?.core?.invoke;

  // ——— 数据变化后的统一出口：托盘动态图标 + 低额度提醒 ———
  function afterDataChange() {
    void updateTrayStatus(repo, settings);
    void maybeAlert();
  }

  // ——— 低额度提醒（'' 关闭 / 'popup' 界面弹窗 / 'notify' 系统通知 / 'pet' 桌宠播报）———
  async function maybeAlert() {
    if (!settings.alertMethod) return;
    const alerts = collectAlerts(repo.listProviders(), settings);
    // 恢复检测：从告警集合消失且供应商仍存在的 id 记为恢复（桌宠播报用）
    const recovered = [];
    for (const id of [...alertedIds]) {
      if (!alerts.some((a) => a.id === id)) {
        alertedIds.delete(id);
        const p = repo.getProvider(id);
        if (p) recovered.push(p.name);
      }
    }
    const fresh = alerts.filter((a) => !alertedIds.has(a.id));
    if (!fresh.length && !recovered.length) return;
    fresh.forEach((a) => alertedIds.add(a.id));

    if (settings.alertMethod === 'pet') {
      const petOpen = ballOn && ballForm !== 'ball';
      if (petOpen && tauriEvents) {
        tauriEvents.emit('pet-speak', {
          lines: fresh.map((a) => `${a.name}：${a.reasons.join('；')}`),
          recoveries: recovered,
        });
        return;
      }
      // 桌宠未开启：仅恢复时静默，有新告警才回退界面弹窗
      if (!fresh.length) return;
    }
    if (!fresh.length) return;

    const title = `低额度提醒：${fresh.length} 家需要关注`;
    const body = fresh.map((a) => `【${a.name}】${a.reasons.join('；')}`).join('\n');
    // 界面弹窗前先查窗口原生可见性（注意：Tauri 隐藏窗口时 document.hidden 仍为 false，
    // 必须用 isVisible()）——后台定时刷新场景主窗不可见，弹窗无人能看到，升级为系统通知
    if (settings.alertMethod === 'popup' && tauriEvents) {
      const win = globalThis.__TAURI__?.window?.getCurrentWindow?.();
      const visible = win?.isVisible ? await win.isVisible().catch(() => true) : true;
      if (!visible) {
        tauriEvents.emit('show-notify', { title, body });
        return;
      }
    }
    // 系统通知走桌面壳原生 Toast；网页版（无 __TAURI__）回退界面弹窗
    if (settings.alertMethod === 'notify' && tauriEvents) {
      tauriEvents.emit('show-notify', { title, body });
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
  // 上次同步的调度签名：无关设置（如阈值）变化不重发，避免重置后端刷新倒计时
  let lastScheduleSig = null;

  function scheduleAutoRefresh() {
    const sig = settings.autoRefreshMinutes > 0 ? String(settings.autoRefreshMinutes) : 'off';
    if (tauriInvoke) {
      // 桌面版：时钟在后端常驻线程（refresh.json 持久化，到点 emit backend-refresh-due），
      // 不受 WebView 隐藏窗口定时器节流影响；签名未变不重发，避免重置倒计时
      if (sig !== lastScheduleSig) {
        lastScheduleSig = sig;
        tauriInvoke('set_refresh_schedule', {
          enabled: settings.autoRefreshMinutes > 0,
          intervalMinutes: settings.autoRefreshMinutes,
        }).catch(() => {
          // 同步失败回滚签名：后续设置变化可重试
          lastScheduleSig = null;
        });
      }
      return;
    }
    // 网页版：页面内 setInterval；同签名且计时器在跑则不动（改无关设置不重置倒计时）
    if (sig === lastScheduleSig && autoTimer) return;
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    lastScheduleSig = sig;
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
      afterDataChange();
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
      afterDataChange();
    }
  }

  // ——— 供应商表单 ———
  async function saveProviderFromForm(data) {
    const existing = data.id ? repo.getProvider(data.id) : null;
    const type = getProviderType(data.type);
    const config = normalizeProviderConfig({
      ...data,
      // 密钥先置空，桌面版写入凭据管理器后留 hasSecret 标记；浏览器版在下方回填
      apiKey: '',
      apiSecret: '',
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
    if (secretsAvailable()) {
      // 桌面版：密钥只进系统凭据管理器，本地记录零明文；输入留空 = 沿用已存密钥
      const typedKey = String(data.apiKey || '').trim();
      const typedSecret = String(data.apiSecret || '').trim();
      if (typedKey || typedSecret) {
        const prev = existing?.hasSecret ? await readSecret(existing.id).catch(() => null) : null;
        try {
          await writeSecret(config.id, {
            apiKey: typedKey || prev?.apiKey || '',
            apiSecret: typedSecret || prev?.apiSecret || '',
          });
          config.hasSecret = true;
        } catch {
          // 凭据管理器写入失败：宁可回退明文本地保存，也不能把用户刚输入的密钥丢掉
          config.apiKey = typedKey || prev?.apiKey || '';
          config.apiSecret = typedSecret || prev?.apiSecret || '';
          config.hasSecret = false;
        }
      } else if (existing?.hasSecret) {
        config.hasSecret = true;
      }
    } else {
      // 浏览器版：无系统凭据可用，沿用原行为（密钥随记录存 localStorage）；
      // 输入留空时保留 hasSecret 标记（桌面备份导入到浏览器的记录密钥在凭据管理器里）
      config.apiKey = String(data.apiKey || '').trim() || (existing ? existing.apiKey : '');
      config.apiSecret = String(data.apiSecret || '').trim() || (existing ? existing.apiSecret : '');
      config.hasSecret = !(String(data.apiKey || '').trim() || String(data.apiSecret || '').trim())
        && existing?.hasSecret === true;
    }
    repo.saveProvider(config);
    render();
    afterDataChange();
  }

  function openForm(existing) {
    openProviderForm({
      mount: document.body,
      providerTypes: PROVIDER_TYPES,
      existing,
      // 现有名称列表（编辑时用于排除自身后查重）
      existingNames: repo.listProviders().map((p) => p.name),
      // 连通性测试：直接调用类型适配器，不入库不写日志（失败信息在表单内展示）；
      // 桌面版已存凭据管理器的供应商，测试时输入留空则从凭据管理器解析密钥
      testConnection: async ({ type, apiKey, apiSecret, baseUrl }) => {
        const def = getProviderType(type);
        return def.query({ apiKey, apiSecret, baseUrl, fetchImpl: globalThis.fetch });
      },
      getStoredSecrets: existing?.hasSecret && secretsAvailable() ? () => readSecret(existing.id) : undefined,
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
      a.download = `桌看备份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
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
      message: `将覆盖当前数据：${parsed.backup.providers.length} 个供应商、${(parsed.backup.logs || []).length} 条日志、${(parsed.backup.schedules || []).length} 条日程。此操作不可撤销，确定继续吗？`,
      confirmText: '覆盖导入',
      danger: true,
    });
    if (!ok) return false;
    // 整表覆盖前记下已有凭据条目的供应商 id：导入后被移除的，凭据管理器条目要一并清理
    const previousSecretIds = secretsAvailable()
      ? repo.listProviders().filter((p) => p.hasSecret).map((p) => p.id)
      : [];
    applyBackup(repo, parsed.backup);
    // 桌面版：导入记录中的明文密钥即时搬进凭据管理器并抹掉本地明文
    await migrateSecretsToKeyring(repo).catch(() => {});
    void cleanupOrphanSecrets(previousSecretIds, repo.listProviders().map((p) => p.id));
    settings = repo.loadSettings();
    scheduleAutoRefresh();
    render();
    afterDataChange();
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
    // 该地址由模型配置同步而来时打遗忘标记，避免下次启动被自动同步加回
    if (cfg.baseUrl) addTombstone(cfg.baseUrl);
    if (cfg.hasSecret) void deleteSecret(id).catch(() => {});
    render();
    afterDataChange();
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
    // 桌面版同步清理凭据管理器中对应条目
    if (secretsAvailable()) {
      repo.listProviders().forEach((p) => {
        if (p.hasSecret) void deleteSecret(p.id).catch(() => {});
      });
    }
    repo.clearAll();
    settings = repo.loadSettings();
    uiState.query = '';
    uiState.statusFilter = 'all';
    scheduleAutoRefresh();
    render();
    void updateTrayStatus(repo, settings);
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
    const formSelect = root.querySelector('[data-ball-form]');
    if (formSelect) formSelect.value = ballForm === 'ball' ? 'ball' : 'pet';
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
      ballForm,
    };
    const content = root.querySelector('[data-role="view-content"]');
    if (content) content.innerHTML = VIEW_RENDERERS[view](ctx);
    // 对话/文件分析/日程页是自挂载组件（自带事件与流式状态），模板渲染后初始化
    if (view === 'chat') {
      const chatRoot = content.querySelector('[data-role="chat-root"]');
      if (chatRoot) mountChatPage(chatRoot, { repo });
    } else if (view === 'models') {
      const modelsRoot = content.querySelector('[data-role="models-root"]');
      if (modelsRoot) mountModelsPage(modelsRoot, { repo });
    } else if (view === 'notes') {
      const notesRoot = content.querySelector('[data-role="notes-root"]');
      if (notesRoot) mountNotesPage(notesRoot);
    } else if (view === 'analysis') {
      const analysisRoot = content.querySelector('[data-role="analysis-root"]');
      if (analysisRoot) mountAnalysisPage(analysisRoot);
    } else if (view === 'schedule') {
      const scheduleRoot = content.querySelector('[data-role="schedule-root"]');
      if (scheduleRoot) mountSchedulePage(scheduleRoot, { repo });
    } else if (view === 'sessions') {
      const sessionsRoot = content.querySelector('[data-role="sessions-root"]');
      if (sessionsRoot) mountSessionsPage(sessionsRoot, { repo, onOpen: () => { globalThis.location.hash = '#/chat'; } });
    } else if (view === 'settings') {
      mountPetAppearanceCard(content);
      if (tauriInvoke) {
        mountAgentSettingsCard(content);
        mountPhoneCard(content);
      }
    }
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
            <span>桌看</span>
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
    // 对话 Agent 设置（localStorage，聊天窗口实时读取，改动即时生效）
    const agentModeSel = e.target.closest('[data-chat-agent-mode]');
    if (agentModeSel) {
      localStorage.setItem('mqc.chat.agent', agentModeSel.value);
      return;
    }
    const agentPermSel = e.target.closest('[data-chat-agent-perm]');
    if (agentPermSel) {
      localStorage.setItem('mqc.chat.agentAutoReadonly', agentPermSel.value === 'ro' ? '1' : '0');
      return;
    }
    const ballToggle = e.target.closest('[data-ball-toggle]');
    if (ballToggle) {
      tauriEvents?.emit?.('set-ball', ballToggle.checked);
      return;
    }
    const ballFormSelect = e.target.closest('[data-ball-form]');
    if (ballFormSelect) {
      tauriEvents?.emit?.('set-ball-form', ballFormSelect.value);
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
    // 悬浮形态（桌宠/经典球）同步
    void tauriEvents.listen('ball-form-changed', (e) => {
      ballForm = e.payload === 'ball' ? 'ball' : 'pet';
      syncBallUi();
    });
    tauriEvents.emit('ball-form-request');
    // 后端定时调度（或托盘菜单「立即刷新」）触发的刷新：时钟在 Rust，执行在这里
    void tauriEvents.listen('backend-refresh-due', () => {
      void refreshAll({ silent: true });
    });
    // 日程提醒队列将耗尽（7 天同步窗口用完）：重算未来实例补给后端调度线程
    void tauriEvents.listen('schedule-queue-low', () => {
      syncScheduleReminders(repo);
    });
  }

  // 日程面板窗改动跨窗同步：storage 事件只在本窗以外写入时触发，
  // 停留在日程页时整页重绘；提醒由面板窗自己同步过，这里只管界面
  globalThis.addEventListener?.('storage', (e) => {
    if (e?.key === 'mqc.schedules' && currentView() === 'schedule') renderContentView();
  });

  scheduleAutoRefresh();
  render();
  // 启动只初始化托盘动态图标；不触发提醒（提醒只在刷新产出新告警时出现，
  // 避免每次打开应用都对存量告警重复弹窗）
  void updateTrayStatus(repo, settings);
  // 启动即把日程提醒实例同步给后端调度线程（含应用关闭期间错过的，由 Rust 判定补报）
  syncScheduleReminders(repo);

  return { refreshAll, refreshOne, render, importFromText, exportBackup, deleteProvider, clearAll };
}
