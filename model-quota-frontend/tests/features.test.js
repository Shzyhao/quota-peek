import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountNotesPage } from '../src/ui/notesView.js';
import { mountAgentSettingsCard, agentSettingsCard } from '../src/ui/agentSettings.js';
import { summarizeSessions, isPhoneActive, setPhoneActive } from '../src/core/phone.js';
import { saveChatConfig } from '../src/core/chat.js';
import { appendClipboardNote, MAX_NOTE_CHARS } from '../src/core/notes.js';

describe('saveChatConfig 合并语义（防 Agent 设置被清空）', () => {
  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  it('只传部分字段时未传字段保留服务端现值', async () => {
    const full = { profiles: [{ id: 'p', name: 'A', base_url: 'u', models: ['m'] }], active_profile_id: 'p', active_model: 'm', persona: '', agent_prompt: '我的提示词', skills: [{ id: 's1', name: '技能', path: 'C:/x.md' }] };
    const saved = [];
    globalThis.__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd, args) => {
          if (cmd === 'chat_get_config') return JSON.parse(JSON.stringify(full));
          if (cmd === 'chat_save_config') { saved.push(args.cfg); return null; }
          return null;
        }),
        Channel: vi.fn(),
      },
      event: { emit: vi.fn(), listen: vi.fn(async () => () => {}) },
    };
    await saveChatConfig({ profiles: full.profiles, active_profile_id: 'p', active_model: 'm', persona: '' });
    expect(saved).toHaveLength(1);
    expect(saved[0].agent_prompt).toBe('我的提示词'); // 未传字段保留
    expect(saved[0].skills).toEqual([{ id: 's1', name: '技能', path: 'C:/x.md' }]);
  });
});

describe('便签单条长度截断', () => {
  it('超长文本截断到上限', () => {
    const big = 'x'.repeat(MAX_NOTE_CHARS + 1000);
    const list = appendClipboardNote([], big);
    expect(list[0].text.length).toBeLessThanOrEqual(MAX_NOTE_CHARS + 12);
    expect(list[0].text).toContain('超长已截断');
    const short = appendClipboardNote([], '短文本');
    expect(short[0].text).toBe('短文本');
  });
});

describe('手机推送内容截断', () => {
  it('单条消息截断到 4000 字符', () => {
    const sessions = [{ id: 's', title: 't', updatedAt: 1, messages: [{ role: 'user', content: 'y'.repeat(6000), time: 1 }] }];
    localStorage.setItem('mqc.chat.sessions', JSON.stringify(sessions));
    const out = summarizeSessions();
    expect(out[0].messages[0].content.length).toBe(4000);
  });
});

function stubTauri({ clipboard = '剪贴板内容A' } = {}) {
  let cfg = { agent_prompt: '', skills: [], profiles: [] };
  const calls = { writeText: [], openNote: [], importSkill: [], saveCfg: [] };
  globalThis.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd === 'clipboard_read_text') return clipboard;
        if (cmd === 'clipboard_write_text') { calls.writeText.push(args?.text); return null; }
        if (cmd === 'open_note_window') { calls.openNote.push(1); return null; }
        if (cmd === 'chat_get_config') return JSON.parse(JSON.stringify(cfg));
        if (cmd === 'chat_save_config') { calls.saveCfg.push(args.cfg); cfg = { ...cfg, ...args.cfg }; return null; }
        if (cmd === 'agent_import_skill') {
          calls.importSkill.push(args);
          return { id: `sk${calls.importSkill.length}`, name: `手册${calls.importSkill.length}`, path: `C:\\cfg\\skills\\sk${calls.importSkill.length}.md` };
        }
        if (cmd === 'agent_delete_skill') return null;
        return null;
      }),
      Channel: vi.fn(),
    },
    event: { emit: vi.fn(), listen: vi.fn(async () => () => {}) },
  };
  return { calls, getCfg: () => cfg };
}

function mountPage() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});
afterEach(() => {
  delete globalThis.__TAURI__;
});

describe('notesView 便签页', () => {
  it('「记录当前剪贴板」→ 列表出现记录并可删除；「打开便签小窗」发命令', async () => {
    const tauri = stubTauri();
    const root = mountPage();
    mountNotesPage(root);
    await vi.waitFor(() => expect(root.querySelector('[data-role="notes-add-current"]')).toBeTruthy());

    root.querySelector('[data-role="notes-open-window"]').click();
    await vi.waitFor(() => expect(tauri.calls.openNote).toHaveLength(1));

    root.querySelector('[data-role="notes-add-current"]').click();
    await vi.waitFor(() => expect(root.querySelectorAll('.note-item')).toHaveLength(1));
    expect(root.querySelector('.note-text').textContent).toBe('剪贴板内容A');
    expect(JSON.parse(localStorage.getItem('mqc.notes.clipboard'))[0].text).toBe('剪贴板内容A');

    root.querySelector('[data-role="note-del"]').click();
    await vi.waitFor(() => expect(root.querySelectorAll('.note-item')).toHaveLength(0));
  });

  it('点记录文本复制全文（桌面版走 arboard 写剪贴板）', async () => {
    localStorage.setItem('mqc.notes.clipboard', JSON.stringify([
      { id: 'n1', text: '要复制的内容', time: 1 },
    ]));
    const tauri = stubTauri();
    const root = mountPage();
    mountNotesPage(root);
    await vi.waitFor(() => expect(root.querySelectorAll('.note-item')).toHaveLength(1));

    root.querySelector('[data-role="note-copy"]').click();
    await vi.waitFor(() => expect(tauri.calls.writeText).toEqual(['要复制的内容']));
  });

  it('其他窗口写入的记录经 storage 事件同步', async () => {
    stubTauri();
    const root = mountPage();
    mountNotesPage(root);
    await vi.waitFor(() => expect(root.querySelector('.notes-list')).toBeTruthy());
    expect(root.querySelectorAll('.note-item')).toHaveLength(0);

    localStorage.setItem('mqc.notes.clipboard', JSON.stringify([{ id: 'n9', text: '别窗写入', time: 1 }]));
    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'mqc.notes.clipboard' }));
    await vi.waitFor(() => expect(root.querySelectorAll('.note-item')).toHaveLength(1));
  });
});

describe('agentSettings Agent 设置卡', () => {
  it('模板含提示词与技能区块；预设提示词保存回写配置', async () => {
    const tauri = stubTauri();
    expect(agentSettingsCard()).toContain('Agent 设置');

    const root = mountPage();
    root.innerHTML = agentSettingsCard();
    mountAgentSettingsCard(root);
    await vi.waitFor(() => expect(root.querySelector('[data-role="agent-prompt"]')).toBeTruthy());

    root.querySelector('[data-role="agent-prompt"]').value = '回复带步骤';
    root.querySelector('[data-role="agent-prompt-save"]').click();
    await vi.waitFor(() => {
      const saved = tauri.calls.saveCfg[tauri.calls.saveCfg.length - 1];
      expect(saved.agent_prompt).toBe('回复带步骤');
    });
  });

  it('导入技能（多选文件）→ 条目入库持久化；重复名称跳过；删除同步移除', async () => {
    const tauri = stubTauri();
    const root = mountPage();
    root.innerHTML = agentSettingsCard();
    mountAgentSettingsCard(root);
    await vi.waitFor(() => expect(root.querySelector('[data-role="agent-skill-import"]')).toBeTruthy());

    globalThis.__TAURI__.dialog = { open: vi.fn(async () => ['C:\\a.md', 'C:\\b.md']) };
    root.querySelector('[data-role="agent-skill-import"]').click();
    await vi.waitFor(() => expect(root.querySelectorAll('.agent-skill-item')).toHaveLength(2));
    expect(root.querySelector('[data-role="agent-hint"]').textContent).toContain('已导入 2');
    const cfg = tauri.getCfg();
    expect(cfg.skills).toHaveLength(2);

    // 删除第一个
    root.querySelector('[data-role="agent-skill-del"]').click();
    await vi.waitFor(() => expect(root.querySelectorAll('.agent-skill-item')).toHaveLength(1));
    expect(tauri.getCfg().skills).toHaveLength(1);
  });
});

describe('phone 会话摘要（手机关联推送内容）', () => {
  it('剥离附件与工具卡，只留文字消息，裁到最近 60 条 / 5 个会话', () => {
    const sessions = [];
    for (let s = 0; s < 7; s++) {
      sessions.push({
        id: `s${s}`, title: `会话${s}`, updatedAt: s,
        messages: Array.from({ length: 70 }, (_, i) => ({
          role: i % 2 ? 'assistant' : 'user',
          content: `s${s}-m${i}`,
          time: i,
          ...(i === 5 ? { attachments: [{ name: 'a.pdf', content: '很长的正文' }] } : {}),
          ...(i === 6 ? { tool: { name: 'x', ok: true } } : {}),
        })),
      });
    }
    localStorage.setItem('mqc.chat.sessions', JSON.stringify(sessions));
    const out = summarizeSessions();
    expect(out).toHaveLength(5);
    expect(out[0].title).toBe('会话0'); // 输入即数组顺序，取前 5
    const msgs = out[0].messages;
    expect(msgs).toHaveLength(60);
    expect(msgs.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(JSON.stringify(msgs)).not.toContain('很长的正文');
  });

  it('手机开关读写 localStorage；坏数据返回空数组', () => {
    expect(isPhoneActive()).toBe(false);
    setPhoneActive(true);
    expect(isPhoneActive()).toBe(true);
    localStorage.setItem('mqc.chat.sessions', '{{{bad json');
    expect(summarizeSessions()).toEqual([]);
  });
});
