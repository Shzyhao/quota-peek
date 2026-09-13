import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountChatPage } from '../src/ui/chatView.js';

// 会话管理 UI 测试：stub chat_get_config 让 mountChatPage 走桌面分支
function stubTauri() {
  globalThis.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd) => {
        if (cmd === 'chat_get_config') return { profiles: [], active_profile_id: null, persona: '' };
        if (cmd === 'chat_has_key') return false;
        return null;
      }),
      Channel: vi.fn(),
    },
    event: { emit: vi.fn(), listen: vi.fn(async () => () => {}) },
  };
}

function readSessions() {
  return JSON.parse(localStorage.getItem('mqc.chat.sessions') || '[]');
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  delete globalThis.__TAURI__;
});

describe('chatView 会话管理', () => {
  it('初始渲染会话选择器；新建/删除会话并持久化到 localStorage', async () => {
    stubTauri();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] } });
    await vi.waitFor(() => {
      const sel = root.querySelector('[data-role="chat-session"]');
      expect(sel).toBeTruthy();
      expect(sel.options).toHaveLength(1);
      expect(sel.options[0].text).toBe('新的对话');
    });

    // 新建 → 两个会话，当前切到新会话
    root.querySelector('[data-role="chat-session-new"]').click();
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-session"]').options).toHaveLength(2));
    expect(readSessions()).toHaveLength(2);

    // 删除当前 → 回到 1 个
    root.querySelector('[data-role="chat-session-del"]').click();
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-session"]').options).toHaveLength(1));
    expect(readSessions()).toHaveLength(1);
  });

  it('旧版 mqc.chat.messages 自动迁移为一个会话', async () => {
    localStorage.setItem('mqc.chat.messages', JSON.stringify([{ role: 'user', content: '旧会话的第一句话' }]));
    stubTauri();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] } });
    await vi.waitFor(() => {
      const sel = root.querySelector('[data-role="chat-session"]');
      expect(sel?.options).toHaveLength(1);
      expect(sel.options[0].text).toBe('旧会话的第一句话');
    });
    expect(localStorage.getItem('mqc.chat.messages')).toBeNull();
    expect(readSessions()[0].messages).toHaveLength(1);
  });
});
