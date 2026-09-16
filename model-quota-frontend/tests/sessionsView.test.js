import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountSessionsPage } from '../src/ui/sessionsView.js';

beforeEach(() => {
  // 会话功能仅桌面版可用：补最小 Tauri 桌面环境
  globalThis.__TAURI__ = { core: { invoke: vi.fn(async () => ({})), Channel: class {} } };
});
afterEach(() => {
  delete globalThis.__TAURI__;
});

// 会话存储直接按 chat.js 的键约定播种（数组 + 独立 activeId 键）
function seed(sessions, activeId) {
  localStorage.setItem('mqc.chat.sessions', JSON.stringify(sessions));
  localStorage.setItem('mqc.chat.activeSession', JSON.stringify(activeId));
}
function readSessions() {
  return JSON.parse(localStorage.getItem('mqc.chat.sessions') || '[]');
}
function readActive() {
  return JSON.parse(localStorage.getItem('mqc.chat.activeSession') || 'null');
}

describe('sessionsView 会话记录页', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  function mount() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const onOpen = vi.fn();
    mountSessionsPage(root, { repo: { listProviders: () => [] }, onOpen });
    return { onOpen };
  }

  function seedTwo() {
    seed(
      [
        { id: 'a', title: '旧会话', messages: [{ role: 'user', content: 'hello' }], createdAt: 1, updatedAt: 1000 },
        { id: 'b', title: '新会话', messages: [], createdAt: 2, updatedAt: 2000 },
      ],
      'b',
    );
  }

  it('渲染会话列表（标题/消息数/行尾图标），当前会话高亮', () => {
    seedTwo();
    const { onOpen } = mount();
    const items = document.querySelectorAll('.session-item');
    expect(items).toHaveLength(2);
    expect(document.querySelector('.session-title').textContent).toBe('新会话'); // 按更新时间倒序
    expect(items[0].classList.contains('active')).toBe(true);
    expect(document.querySelectorAll('[data-role="session-rename"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-role="session-del"]')).toHaveLength(2);
    // 网页版/桌面版回调：默认未触发
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('点击会话行 → 置为当前会话并跳转对话页', () => {
    seedTwo();
    const { onOpen } = mount();
    document.querySelector('[data-role="session-open"][data-id="a"]').click();
    expect(readActive()).toBe('a');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('重命名：行内输入保存后持久化', () => {
    seedTwo();
    mount();
    document.querySelector('[data-role="session-rename"][data-id="a"]').click();
    const input = document.querySelector('[data-role="session-rename-input"]');
    expect(input).toBeTruthy();
    input.value = '  我的自定义名  ';
    document.querySelector('[data-role="session-rename-save"]').click();
    const renamed = readSessions().find((x) => x.id === 'a');
    expect(renamed.title).toBe('我的自定义名');
    // 消息不丢
    expect(renamed.messages).toHaveLength(1);
  });

  it('删除会话（带确认）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // styledConfirm 用自定义弹窗而非 window.confirm——直接 mock 其依赖不可行时退化为 DOM 操作验证
    seedTwo();
    const { } = mount();
    document.querySelector('[data-role="session-del"][data-id="a"]').click();
    // 弹出确认框（styledConfirm 渲染 modal-overlay）
    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    overlay.querySelector('[data-action="confirm-accept"]').click();
    await vi.waitFor(() => expect(readSessions().find((x) => x.id === 'a')).toBeUndefined());
    expect(readSessions()).toHaveLength(1);
  });

  it('＋新对话：创建空会话并置为当前', () => {
    seedTwo();
    const { onOpen } = mount();
    document.querySelector('[data-role="session-new"]').click();
    const sessions = readSessions();
    expect(sessions).toHaveLength(3);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
