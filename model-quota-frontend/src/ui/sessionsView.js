// 主窗「会话记录」页：独立的对话历史列表（仿会话侧栏形态）——
// 每行一个会话：标题 + 消息数 + 相对时间，行尾小图标 = 重命名 / 删除；
// 点击行切换到该会话并跳转「对话」页。与桌宠面板经 storage 实时同步。

import {
  loadSessions, saveSessions, newSession, renameSession, deleteSession, isChatAvailable,
} from '../core/chat.js';
import { escapeHtml } from './format.js';
import { styledConfirm } from './confirm.js';

export function sessionsView() {
  return '<div data-role="sessions-root"></div>';
}

function relTime(ts) {
  const diff = Date.now() - (ts || Date.now());
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function mountSessionsPage(el, { repo, onOpen = () => {} } = {}) {
  // 监听挂在自建子节点上，重挂载不堆积
  const page = document.createElement('div');
  page.className = 'sessions-page';
  el.replaceChildren(page);

  const desktop = isChatAvailable();
  let renamingId = null;

  function render() {
    if (!desktop) {
      page.innerHTML = `
        <div class="empty-state">
          <p>对话会话仅在桌面版（桌看）中可用。</p>
        </div>`;
      return;
    }
    const { sessions, activeId } = loadSessions();
    const sorted = [...sessions].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    const rows = sorted.map((s) => {
      const last = (s.messages || []).filter((m) => m.content).at(-1);
      const preview = last ? String(last.content).replace(/\s+/g, ' ').slice(0, 60) : '（空会话）';
      if (renamingId === s.id) {
        return `
        <div class="session-item ${s.id === activeId ? 'active' : ''}">
          <input class="session-rename-input" data-role="session-rename-input" data-id="${escapeHtml(s.id)}" value="${escapeHtml(s.title)}" maxlength="30">
          <div class="session-icons">
            <button class="session-icon ok" data-role="session-rename-save" data-id="${escapeHtml(s.id)}" title="保存重命名">✓</button>
            <button class="session-icon" data-role="session-rename-cancel" title="取消">✕</button>
          </div>
        </div>`;
      }
      return `
      <div class="session-item ${s.id === activeId ? 'active' : ''}">
        <div class="session-main" data-role="session-open" data-id="${escapeHtml(s.id)}" title="打开此对话">
          <div class="session-title">${escapeHtml(s.title)}</div>
          <div class="session-meta">${(s.messages || []).length} 条 · ${escapeHtml(relTime(s.updatedAt || s.createdAt))} · ${escapeHtml(preview)}</div>
        </div>
        <div class="session-icons">
          <button class="session-icon" data-role="session-rename" data-id="${escapeHtml(s.id)}" title="重命名">✎</button>
          <button class="session-icon danger" data-role="session-del" data-id="${escapeHtml(s.id)}" title="删除会话">🗑</button>
        </div>
      </div>`;
    }).join('');

    page.innerHTML = `
      <div class="sessions-toolbar">
        <span class="settings-hint">共 ${sorted.length} 个会话 · 与桌宠对话/语音面板实时同步</span>
        <button class="btn primary small" data-role="session-new">＋ 新对话</button>
      </div>
      <div class="session-list">${rows || '<p class="settings-hint">还没有会话，点「＋ 新对话」开始。</p>'}</div>`;
  }

  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    const id = btn.dataset.id;
    if (role === 'session-new') {
      const fresh = newSession();
      saveSessions([fresh, ...loadSessions().sessions], fresh.id);
      renamingId = null;
      render();
      onOpen();
    } else if (role === 'session-open') {
      const fresh = loadSessions();
      if (fresh.sessions.some((x) => x.id === id)) {
        saveSessions(fresh.sessions, id);
        onOpen();
      }
    } else if (role === 'session-rename') {
      renamingId = id;
      render();
      const input = page.querySelector('[data-role="session-rename-input"]');
      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.stopPropagation();
            page.querySelector('[data-role="session-rename-save"]')?.click();
          } else if (ev.key === 'Escape') {
            renamingId = null;
            render();
          }
        });
      }
    } else if (role === 'session-rename-save') {
      const input = page.querySelector('[data-role="session-rename-input"]');
      const renamed = renameSession(loadSessions().sessions, id, input ? input.value : '');
      saveSessions(renamed, loadSessions().activeId);
      renamingId = null;
      render();
    } else if (role === 'session-rename-cancel') {
      renamingId = null;
      render();
    } else if (role === 'session-del') {
      const item = loadSessions().sessions.find((x) => x.id === id);
      if (!item) return;
      const ok = await styledConfirm({
        mount: document.body,
        title: '删除会话',
        message: `确定删除会话「${item.title}」（${(item.messages || []).length} 条消息）吗？该操作不可恢复。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      deleteSession(loadSessions().sessions, loadSessions().activeId, id);
      renamingId = null;
      render();
    }
  });

  // 其他窗口（桌宠面板）改动会话时实时刷新
  globalThis.addEventListener?.('storage', (e) => {
    if (e?.key === 'mqc.chat.sessions' || e?.key === 'mqc.chat.activeSession') render();
  });

  render();
}
