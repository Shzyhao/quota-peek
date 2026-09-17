// 便签核心：剪贴板自动记录（最近 20 条）+ 独立便签小窗内容存取。
// 记录存 localStorage（mqc.notes.clipboard），主窗轮询写入、多窗经 storage 事件同步；
// 便签小窗正文存 mqc.note.sticky。纯逻辑与 IPC 分离（deps 注入）便于单测。

export const CLIP_NOTES_KEY = 'mqc.notes.clipboard';
export const STICKY_KEY = 'mqc.note.sticky';
export const MAX_CLIP_NOTES = 20;
// 单条上限：剪贴板可能复制超大文本（整本书/日志），截断防 localStorage 膨胀
export const MAX_NOTE_CHARS = 50000;

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : fallback;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function loadClipboardNotes(storage = globalThis.localStorage) {
  const list = readJson(storage, CLIP_NOTES_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function loadStickyNote(storage = globalThis.localStorage) {
  // 默认固定（📌）——与便签窗默认置顶创建一致
  return readJson(storage, STICKY_KEY, { text: '', pinned: true });
}

export function saveStickyNote(note, storage = globalThis.localStorage) {
  storage?.setItem(STICKY_KEY, JSON.stringify({ text: String(note?.text || ''), pinned: note?.pinned === true }));
}

/// 追加一条剪贴板记录：与最近一条相同则忽略（去抖）；超 20 条裁最旧。
/// 返回更新后的列表（调用方负责写回 storage）。
export function appendClipboardNote(list, text, now = Date.now()) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return Array.isArray(list) ? list : [];
  if (t.length > MAX_NOTE_CHARS) t = `${t.slice(0, MAX_NOTE_CHARS)}…（超长已截断）`;
  const rest = (Array.isArray(list) ? list : []).filter((n) => n.text !== t);
  return [{ id: `n-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: t, time: now }, ...rest].slice(0, MAX_CLIP_NOTES);
}

export function deleteClipboardNote(list, id) {
  return (Array.isArray(list) ? list : []).filter((n) => n.id !== id);
}

// ——— 剪贴板轮询（桌面壳 only）———

export function isClipboardAvailable() {
  return typeof globalThis.__TAURI__?.core?.invoke === 'function';
}

/// 订阅剪贴板变化（Rust 轮询线程 emit clipboard-changed，本端入库去重）。
/// 仅主窗订阅（多窗会重复记录同一内容）。返回停止函数。
export function startClipboardWatcher({ onNewNote } = {}) {
  const unlisten = globalThis.__TAURI__?.event?.listen?.('clipboard-changed', (e) => {
    const t = String(e?.payload ?? '');
    if (!t.trim()) return;
    const list = appendClipboardNote(loadClipboardNotes(), t);
    globalThis.localStorage?.setItem(CLIP_NOTES_KEY, JSON.stringify(list));
    onNewNote?.(list[0]);
  });
  return () => {
    Promise.resolve(unlisten).then((fn) => fn?.()).catch(() => {});
  };
}
