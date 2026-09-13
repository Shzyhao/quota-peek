import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountChatPage } from '../src/ui/chatView.js';

// 会话管理 UI 测试：stub chat_get_config 让 mountChatPage 走桌面分支
function stubTauri({ readFile } = {}) {
  globalThis.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd === 'chat_get_config') return { profiles: [], active_profile_id: null, persona: '' };
        if (cmd === 'chat_has_key') return false;
        if (cmd === 'chat_read_file') {
          if (readFile) return readFile(args?.path);
          return { name: 'stub.txt', content: '内容'.repeat(10), truncated: false, chars: 20 };
        }
        return null;
      }),
      Channel: vi.fn(),
    },
    event: { emit: vi.fn(), listen: vi.fn(async () => () => {}) },
    dialog: { open: vi.fn(async () => ['D:\doc\报告.pdf', 'D:\doc\数据.csv']) },
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

describe('chatView 会话附件', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  it('选择文件后显示附件 chips，可移除', async () => {
    stubTauri();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] } });
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-attach"]')).toBeTruthy());

    root.querySelector('[data-role="chat-attach"]').click();
    await vi.waitFor(() => {
      const box = root.querySelector('[data-role="chat-attachments"]');
      expect(box.hidden).toBe(false);
      expect(box.querySelectorAll('.chat-attach-chip')).toHaveLength(2);
    });
    // 移除一个
    root.querySelector('[data-role="chat-attach-del"]').click();
    expect(root.querySelectorAll('.chat-attach-chip')).toHaveLength(1);
  });

  it('解析失败时附件不加入并提示', async () => {
    stubTauri({ readFile: () => { throw new Error('解析失败：损坏的 PDF'); } });
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] } });
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-attach"]')).toBeTruthy());

    root.querySelector('[data-role="chat-attach"]').click();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-role="chat-attachments"]').hidden).toBe(true);
      const hint = root.querySelector('[data-role="chat-test-result"]');
      expect(hint.textContent).toContain('解析失败');
    });
  });

  it('Agent 开关切换并持久化', async () => {
    stubTauri();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] } });
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-agent-toggle"]')).toBeTruthy());

    const toggle = root.querySelector('[data-role="chat-agent-toggle"]');
    expect(toggle.classList.contains('active')).toBe(false);
    toggle.click();
    expect(toggle.classList.contains('active')).toBe(true);
    expect(localStorage.getItem('mqc.chat.agent')).toBe('1');
    toggle.click();
    expect(localStorage.getItem('mqc.chat.agent')).toBe('0');
  });
});

describe('chatView ⚡ 只读自动批准开关', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  it('Agent 模式开启时才显示；切换持久化', async () => {
    stubTauri();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] } });
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-agent-toggle"]')).toBeTruthy());

    const ro = root.querySelector('[data-role="agent-readonly-toggle"]');
    expect(ro.hidden).toBe(true); // Agent 未开时隐藏
    root.querySelector('[data-role="chat-agent-toggle"]').click();
    expect(ro.hidden).toBe(false);
    expect(ro.classList.contains('active')).toBe(false);

    ro.click();
    expect(ro.classList.contains('active')).toBe(true);
    expect(localStorage.getItem('mqc.chat.agentAutoReadonly')).toBe('1');
    ro.click();
    expect(localStorage.getItem('mqc.chat.agentAutoReadonly')).toBe('0');
  });
});
