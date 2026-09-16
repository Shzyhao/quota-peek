import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadClipboardNotes, appendClipboardNote, deleteClipboardNote,
  loadStickyNote, saveStickyNote, startClipboardWatcher, CLIP_NOTES_KEY,
} from '../src/core/notes.js';
import { memoryStorage } from '../src/core/storage.js';

describe('notes 剪贴板记录', () => {
  it('appendClipboardNote：新记录置顶、去重（内容相同刷新位置不新增）、超 20 条裁最旧', () => {
    let list = [];
    for (let i = 1; i <= 22; i++) list = appendClipboardNote(list, `内容${i}`, i * 1000);
    expect(list).toHaveLength(20);
    expect(list[0].text).toBe('内容22');
    expect(list[19].text).toBe('内容3');

    // 去重：再追加已存在的「内容22」→ 移到最前、总数不变
    const before = list.length;
    list = appendClipboardNote(list, '内容22', 999999);
    expect(list).toHaveLength(before);
    expect(list[0].text).toBe('内容22');
    expect(new Set(list.map((n) => n.text)).size).toBe(before);
  });

  it('空白内容与非数组输入原样返回', () => {
    expect(appendClipboardNote([], '   ')).toEqual([]);
    expect(appendClipboardNote(null, 'x')).toHaveLength(1);
  });

  it('load/delete/saveSticky 读写 localStorage', () => {
    const s = memoryStorage();
    expect(loadClipboardNotes(s)).toEqual([]);
    let list = appendClipboardNote(loadClipboardNotes(s), 'hello', 1);
    s.setItem(CLIP_NOTES_KEY, JSON.stringify(list));
    expect(loadClipboardNotes(s)[0].text).toBe('hello');
    expect(deleteClipboardNote(list, list[0].id)).toEqual([]);

    expect(loadStickyNote(s)).toEqual({ text: '', pinned: true });
    saveStickyNote({ text: '记事', pinned: true }, s);
    expect(loadStickyNote(s)).toEqual({ text: '记事', pinned: true });
  });
});

describe('startClipboardWatcher（Rust 事件驱动）', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  it('clipboard-changed 事件入库并回调；空载荷忽略', async () => {
    const news = [];
    let handler = null;
    globalThis.__TAURI__ = {
      event: {
        listen: vi.fn(async (_ev, fn) => { handler = fn; return () => {}; }),
      },
    };
    const stop = startClipboardWatcher({ onNewNote: (n) => news.push(n.text) });
    await vi.waitFor(() => expect(handler).toBeTruthy());

    handler({ payload: '第一段复制的内容' });
    expect(news).toEqual(['第一段复制的内容']);
    expect(JSON.parse(localStorage.getItem(CLIP_NOTES_KEY))[0].text).toBe('第一段复制的内容');

    handler({ payload: '   ' }); // 空白忽略
    expect(news).toHaveLength(1);
    expect(localStorage.getItem(CLIP_NOTES_KEY) ? JSON.parse(localStorage.getItem(CLIP_NOTES_KEY)) : []).toHaveLength(1);

    stop();
  });
});
