// 主窗「便签」页：剪贴板自动记录（最近 20 条，主窗轮询写入）+ 打开独立便签小窗。
// 自挂载组件；记录变化经 storage 事件跨窗同步（多开主窗场景以最新写入为准）。

import {
  loadClipboardNotes, deleteClipboardNote, appendClipboardNote,
  isClipboardAvailable,
} from '../core/notes.js';
import { escapeHtml } from './format.js';

// 与桌面壳 lib.rs 的 BROWSER_ARGS 保持一致（供 JS 创建便签窗使用）
export const BROWSER_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --use-fake-ui-for-media-stream';

export function notesView() {
  return '<div class="notes-page" data-role="notes-root"></div>';
}

export function mountNotesPage(el) {
  const desktop = isClipboardAvailable();
  let notes = loadClipboardNotes();

  el.innerHTML = `
    <div class="notes-toolbar">
      <button class="btn primary" data-role="notes-open-window">📝 打开便签小窗</button>
      <button class="btn" data-role="notes-add-current" title="把当前剪贴板内容立即记为一条">📋 记录当前剪贴板</button>
      <button class="btn danger" data-role="notes-clear" ${notes.length ? '' : 'disabled'}>清空记录</button>
      <span class="settings-hint">电脑上复制的文本会自动记录在这里（保留最近 20 条）</span>
    </div>
    <div class="notes-list" data-role="notes-list"></div>
    ${desktop ? '' : '<p class="settings-hint">剪贴板记录仅在桌面版可用，网页版可手动「记录当前剪贴板」。</p>'}`;

  const $ = (sel) => el.querySelector(sel);

  function persist() {
    localStorage.setItem('mqc.notes.clipboard', JSON.stringify(notes));
  }

  function renderList() {
    const box = $('[data-role="notes-list"]');
    const clearBtn = $('[data-role="notes-clear"]');
    if (clearBtn) clearBtn.disabled = !notes.length;
    box.innerHTML = notes.length
      ? notes.map((n) => `
        <div class="note-item">
          <div class="note-text" title="点击复制全文" data-role="note-copy" data-id="${escapeHtml(n.id)}">${escapeHtml(n.text)}</div>
          <div class="note-meta">
            <span>${new Date(n.time).toLocaleString('zh-CN')}</span>
            <span class="note-actions">
              <button class="btn small" data-role="note-copy" data-id="${escapeHtml(n.id)}">复制</button>
              <button class="btn small danger" data-role="note-del" data-id="${escapeHtml(n.id)}">删除</button>
            </span>
          </div>
        </div>`).join('')
      : '<div class="empty-state"><p>还没有记录。在电脑上复制任意文本，1-2 秒内会出现在这里。</p></div>';
  }

  async function copyText(text, btn) {
    try {
      if (globalThis.__TAURI__?.core?.invoke) {
        // 桌面版走 arboard 写剪贴板（WebView 无焦点也能写）
        await globalThis.__TAURI__.core.invoke('clipboard_write_text', { text });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = old; }, 1000);
      }
    } catch {
      /* 复制失败静默 */
    }
  }

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    const id = btn.dataset.id;
    if (role === 'notes-open-window') {
      // 便签小窗由前端 WebviewWindow API 创建（Rust 命令建窗会死锁）；已存在则聚焦
      const Win = globalThis.__TAURI__?.webviewWindow?.WebviewWindow || globalThis.__TAURI__?.window?.WebviewWindow;
      if (Win && !globalThis.__zkNoteWinCreated) {
        try {
          const win = new Win('note', {
            url: 'index.html#note',
            title: '便签 · 桌看',
            width: 300, height: 360, minWidth: 220, minHeight: 200,
            resizable: true, maximizable: false, decorations: false,
            alwaysOnTop: true, skipTaskbar: true, center: false,
            // 与其他窗口参数一致（不一致会导致 WebView2 环境创建静默半失败）
            additionalBrowserArgs: BROWSER_ARGS,
          });
          await new Promise((resolve) => {
            win.once('tauri://created', resolve);
            win.once('tauri://error', resolve);
          });
          globalThis.__zkNoteWinCreated = true;
        } catch {
          void globalThis.__TAURI__?.core?.invoke?.('open_note_window').catch(() => {});
        }
      } else {
        void globalThis.__TAURI__?.core?.invoke?.('open_note_window').catch(() => {});
      }
    } else if (role === 'notes-add-current') {
      try {
        const text = await globalThis.__TAURI__?.core?.invoke?.('clipboard_read_text');
        notes = appendClipboardNote(notes, String(text || ''));
        persist();
        renderList();
      } catch {
        /* 网页版：剪贴板权限失败静默 */
      }
    } else if (role === 'notes-clear') {
      notes = [];
      persist();
      renderList();
    } else if (role === 'note-copy') {
      const n = notes.find((x) => x.id === id);
      if (n) await copyText(n.text, btn);
    } else if (role === 'note-del') {
      notes = deleteClipboardNote(notes, id);
      persist();
      renderList();
    }
  });

  // 便签小窗/其他主窗写入的记录经 storage 事件同步
  const onStorage = (e) => {
    if (e?.key !== 'mqc.notes.clipboard') return;
    notes = loadClipboardNotes();
    renderList();
  };
  globalThis.addEventListener?.('storage', onStorage);

  renderList();
}
