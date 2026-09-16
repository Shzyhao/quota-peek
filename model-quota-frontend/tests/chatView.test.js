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

  it('Agent 无输入栏开关（默认开启，设置页控制）；朗读/发送为图标按钮', async () => {
    localStorage.removeItem('mqc.chat.agent');
    localStorage.removeItem('mqc.chat.agentAutoReadonly');
    stubTauri();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] } });
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-send"]')).toBeTruthy());

    // Agent / 只读开关按钮已移除（默认开启，改在主窗「设置 · 对话 Agent」控制）
    expect(root.querySelector('[data-role="chat-agent-toggle"]')).toBeNull();
    expect(root.querySelector('[data-role="agent-readonly-toggle"]')).toBeNull();
    // 其余操作按钮保留且为单字符图标（无文字）
    for (const role of ['chat-mic', 'chat-attach', 'chat-voice-toggle', 'chat-send', 'chat-stop']) {
      const btn = root.querySelector(`[data-role="${role}"]`);
      expect(btn).toBeTruthy();
      expect(btn.textContent.trim().length).toBeLessThanOrEqual(2);
    }
    // 设置页读取的默认值约定：未设置时 Agent 开、只读自动批准开
    expect(localStorage.getItem('mqc.chat.agent')).toBeNull();
    expect(localStorage.getItem('mqc.chat.agentAutoReadonly')).toBeNull();
  });

  it('panel 模式不渲染配置区，工具栏只留内容相关控件', async () => {
    localStorage.removeItem('mqc.chat.agent');
    localStorage.removeItem('mqc.chat.agentAutoReadonly');
    stubTauri();
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: { listProviders: () => [] }, panel: true });
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-send"]')).toBeTruthy());

    // 配置区与配置入口完全不进 DOM
    expect(root.querySelector('.chat-config')).toBeNull();
    for (const role of ['chat-config-toggle', 'chat-test', 'chat-profile', 'chat-session-del']) {
      expect(root.querySelector(`[data-role="${role}"]`)).toBeNull();
    }
    // 内容相关控件保留
    expect(root.querySelector('[data-role="chat-session"]')).toBeTruthy();
    expect(root.querySelector('[data-role="chat-session-new"]')).toBeTruthy();
    expect(root.querySelector('[data-role="chat-clear"]')).toBeTruthy();
    expect(root.querySelector('[data-role="chat-messages"]')).toBeTruthy();
  });
});

// ——— 语音对话（麦克风点按说话 + 回复朗读） ———

function voiceStubTauri({ chatSendCapture, voiceHasKey = true } = {}) {
  globalThis.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd === 'chat_get_config') {
          return {
            profiles: [{ id: 'p1', name: 'GLM', base_url: 'https://x.example', model: 'glm-4' }],
            active_profile_id: 'p1',
            persona: '',
          };
        }
        if (cmd === 'chat_has_key') return false;
        if (cmd === 'voice_secret_has') return voiceHasKey;
        if (cmd === 'voice_transcribe') return '你好呀桌宠';
        if (cmd === 'voice_speak') return btoa('fake-mp3');
        if (cmd === 'chat_send') {
          chatSendCapture?.push(args);
          // 模拟流式回复后完成
          setTimeout(() => {
            args?.onEvent?.onmessage?.({ type: 'token', data: { text: '**你好**呀' } });
            args?.onEvent?.onmessage?.({ type: 'done', data: { usage: null } });
          }, 0);
          return null;
        }
        return null;
      }),
      Channel: vi.fn(),
    },
    event: { emit: vi.fn(), listen: vi.fn(async () => () => {}) },
  };
}

function fakeVoiceDeps() {
  const state = { node: null };
  const ctx = {
    sampleRate: 16000,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createScriptProcessor: () => {
      const node = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
      state.node = node;
      return node;
    },
    createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
    destination: {},
    close: vi.fn(async () => {}),
  };
  class AudioContext {
    constructor() { return ctx; }
  }
  let now = 100000;
  return {
    deps: {
      AudioContext,
      targetSampleRate: 16000,
      getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
      now: () => now,
    },
    advance: (ms) => { now += ms; },
    pushChunk: (d) => state.node?.onaudioprocess?.({ inputBuffer: { getChannelData: () => d } }),
  };
}

describe('chatView 语音对话', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    localStorage.setItem('mqc.chat.sessions', JSON.stringify([{
      id: 's1', title: '测试会话', createdAt: 1, updatedAt: 1, messages: [],
    }]));
    localStorage.setItem('mqc.chat.activeSession', 's1');
  });
  afterEach(() => {
    delete globalThis.__TAURI__;
    delete globalThis.Audio;
  });

  function mount(repo) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountChatPage(root, { repo: repo || { listProviders: () => [] } });
    return root;
  }

  it('麦克风与朗读开关渲染；朗读开关默认开且可持久化', async () => {
    voiceStubTauri();
    const root = mount();
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-voice-toggle"]')).toBeTruthy());
    expect(root.querySelector('[data-role="chat-mic"]').textContent).toBe('🎙');

    const toggle = root.querySelector('[data-role="chat-voice-toggle"]');
    expect(toggle.classList.contains('active')).toBe(true); // autoRead 默认开
    toggle.click();
    expect(toggle.classList.contains('active')).toBe(false);
    expect(JSON.parse(localStorage.getItem('mqc.voice.config')).autoRead).toBe(false);
  });

  it('未配置语音服务时点麦克风给出配置指引', async () => {
    voiceStubTauri({ voiceHasKey: false });
    const root = mount();
    await vi.waitFor(() => expect(root.querySelector('[data-role="chat-mic"]')).toBeTruthy());
    root.querySelector('[data-role="chat-mic"]').click();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-role="chat-test-result"]').textContent).toContain('语音服务');
    });
    // 配置面板自动展开引导
    expect(root.querySelector('.chat-config').hidden).toBe(false);
  });

  it('录音→识别→自动发送全链路；桌宠同步 recording/idle 状态', async () => {
    localStorage.setItem('mqc.chat.agent', '0'); // 语音链路测试走纯对话通道
    vi.useFakeTimers();
    try {
      const sends = [];
      voiceStubTauri({ chatSendCapture: sends });
      const f = fakeVoiceDeps();
      const root = document.createElement('div');
      document.body.appendChild(root);
      mountChatPage(root, { repo: { listProviders: () => [] }, voiceDeps: f.deps });
      await vi.waitFor(() => expect(root.querySelector('[data-role="chat-mic"]')).toBeTruthy());

      const mic = root.querySelector('[data-role="chat-mic"]');
      mic.click(); // 开始录音
      await vi.waitFor(() => expect(mic.classList.contains('recording')).toBe(true));
      expect(globalThis.__TAURI__.event.emit).toHaveBeenCalledWith('pet-chat-status', { state: 'recording' });
      f.pushChunk(new Float32Array(1600));
      f.advance(2500); // 录满 2.5 秒（超过 400ms 下限）

      mic.click(); // 再点 = 停止 → 识别 → 自动发送
      await vi.waitFor(() => expect(sends).toHaveLength(1));
      const msgs = sends[0].messages;
      expect(msgs[msgs.length - 1].content).toBe('你好呀桌宠');
      expect(mic.classList.contains('recording')).toBe(false);
      const states = globalThis.__TAURI__.event.emit.mock.calls
        .filter(([ev]) => ev === 'pet-chat-status')
        .map(([, p]) => p.state);
      expect(states).toContain('transcribing');
      expect(states).toContain('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('回复完成后自动朗读（朗读文本经 markdown 清洗）', async () => {
    localStorage.setItem('mqc.chat.agent', '0'); // 朗读测试走纯对话通道
    const speakCalls = [];
    class FakeAudio {
      constructor(src) { FakeAudio.instances.push(this); this.src = src; }
      async play() {}
      pause() { this.onpause?.(); }
    }
    FakeAudio.instances = [];
    globalThis.Audio = FakeAudio;
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
    globalThis.__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd, args) => {
          if (cmd === 'chat_get_config') {
            return { profiles: [{ id: 'p1', name: 'GLM', base_url: 'https://x', model: 'glm-4' }], active_profile_id: 'p1', persona: '' };
          }
          if (cmd === 'voice_secret_has') return true;
          if (cmd === 'voice_speak') { speakCalls.push(args); return btoa('fake-mp3'); }
          if (cmd === 'chat_send') {
            setTimeout(() => {
              args?.onEvent?.onmessage?.({ type: 'token', data: { text: '**你好**呀' } });
              args?.onEvent?.onmessage?.({ type: 'done', data: { usage: null } });
            }, 0);
            return null;
          }
          return null;
        }),
        Channel: vi.fn(),
      },
      event: { emit: vi.fn(), listen: vi.fn(async () => () => {}) },
    };

    const root = mount();
    // 等配置异步加载完成（否则 doSend 会因"未配置模型"提前返回）
    await vi.waitFor(() => {
      expect(root.querySelector('[data-role="chat-profile"]').textContent).toContain('GLM');
    });
    const input = root.querySelector('[data-role="chat-input"]');
    input.value = '跟我说句话';
    root.querySelector('[data-role="chat-send"]').click();

    await vi.waitFor(() => expect(speakCalls).toHaveLength(1));
    expect(speakCalls[0].text).toBe('你好呀'); // markdown 加粗已清洗
    expect(FakeAudio.instances).toHaveLength(1);
    const states = globalThis.__TAURI__.event.emit.mock.calls
      .filter(([ev]) => ev === 'pet-chat-status')
      .map(([, p]) => p.state);
    expect(states).toContain('speaking');
  });
});
