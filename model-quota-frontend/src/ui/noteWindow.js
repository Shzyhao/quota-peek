// 便签小窗（#note）：无框小窗，顶栏可拖动 + 📌 固定桌面开关 + × 关闭；
// 正文自动保存（localStorage mqc.note.sticky，重开恢复）。关闭 = 隐藏窗口，内容保留。

import { loadStickyNote, saveStickyNote } from '../core/notes.js';

export function renderNoteWindow({ root }) {
  document.documentElement.classList.add('note-mode');
  const saved = loadStickyNote();
  root.innerHTML = `
    <div class="note-shell">
      <header class="note-head" data-role="note-head">
        <button class="note-pin ${saved.pinned ? 'active' : ''}" data-role="note-pin" title="${saved.pinned ? '取消固定（不再置顶）' : '固定在桌面（置顶）'}">📌</button>
        <span class="note-title">便签</span>
        <button class="note-close" data-role="note-close" title="关闭（内容自动保留）">×</button>
      </header>
      <textarea class="note-body" data-role="note-body" placeholder="记点什么…（自动保存）"></textarea>
    </div>`;

  const body = root.querySelector('[data-role="note-body"]');
  body.value = saved.text || '';
  body.focus();
  body.setSelectionRange(body.value.length, body.value.length);

  // 自动保存（防抖 300ms）
  let saveTimer = null;
  body.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveStickyNote({ text: body.value, pinned: isPinned() }), 300);
  });
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveStickyNote({ text: body.value, pinned: isPinned() });
  };

  const pinBtn = root.querySelector('[data-role="note-pin"]');
  const isPinned = () => pinBtn.classList.contains('active');

  function applyPin(pinned) {
    pinBtn.classList.toggle('active', pinned);
    pinBtn.title = pinned ? '取消固定（不再置顶）' : '固定在桌面（置顶）';
    void globalThis.__TAURI__?.core?.invoke?.('note_set_pin', { pinned }).catch(() => {});
    saveStickyNote({ text: body.value, pinned });
  }

  pinBtn.addEventListener('click', () => applyPin(!isPinned()));
  // 打开时同步固定状态（窗口 always_on_top 默认 true，与持久化状态对齐）
  applyPin(saved.pinned === true);

  root.querySelector('[data-role="note-close"]').addEventListener('click', () => {
    saveNow();
    void globalThis.__TAURI__?.window?.getCurrentWindow?.()?.hide?.();
  });

  // 顶栏拖动（自绘标题栏）；拖完保存一次
  const head = root.querySelector('[data-role="note-head"]');
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    globalThis.__TAURI__?.window?.getCurrentWindow?.()?.startDragging?.();
  });
  globalThis.addEventListener?.('beforeunload', saveNow);
}
