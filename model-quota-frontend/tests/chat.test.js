import { describe, it, expect } from 'vitest';
import {
  loadSessions, saveSessions, appendToSession, clearActiveMessages, deleteSession,
  newSession, titleFromText, migrateLegacyHistory,
  MAX_SESSIONS, HISTORY_LIMIT,
  buildQuotaContext, buildOutgoingMessages,
  buildProfileFromProvider, importableProviders,
} from '../src/core/chat.js';

// 内存版 storage 桩（不依赖 jsdom localStorage 状态残留）
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

describe('多会话存储', () => {
  it('空存储返回空列表与空 activeId', () => {
    expect(loadSessions(memoryStorage())).toEqual({ sessions: [], activeId: null });
  });

  it('损坏 JSON 不抛错，按空处理', () => {
    const s = memoryStorage();
    s.setItem('mqc.chat.sessions', '{oops');
    expect(loadSessions(s).sessions).toEqual([]);
  });

  it('旧版单会话缓冲自动迁移为 sessions 结构并移除旧键', () => {
    const s = memoryStorage();
    s.setItem('mqc.chat.messages', JSON.stringify([
      { role: 'user', content: '帮我看看额度' },
      { role: 'assistant', content: '好的' },
    ]));
    expect(migrateLegacyHistory(s)).toBe(true);
    const { sessions, activeId } = loadSessions(s);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('帮我看看额度');
    expect(sessions[0].messages).toHaveLength(2);
    expect(activeId).toBe(sessions[0].id);
    expect(s.getItem('mqc.chat.messages')).toBeNull();
  });

  it('追加消息维护标题、时间戳与 100 条上限', () => {
    const s = memoryStorage();
    let { sessions, activeId } = loadSessions(s);
    ({ sessions, activeId } = appendToSession(sessions, activeId, { role: 'user', content: '帮我看看今天的额度用量如何', time: 1000 }, s));
    let active = sessions.find((x) => x.id === activeId);
    expect(active.title).toBe('帮我看看今天的额度用量如何');
    expect(active.updatedAt).toBe(1000);
    const bulk = Array.from({ length: HISTORY_LIMIT + 20 }, (_, i) => ({ role: 'assistant', content: `m${i}`, time: 2000 + i }));
    for (const m of bulk) ({ sessions, activeId } = appendToSession(sessions, activeId, m, s));
    active = sessions.find((x) => x.id === activeId);
    expect(active.messages).toHaveLength(HISTORY_LIMIT);
    expect(active.messages[0].content).toBe('m20');
  });

  it('会话数超过上限按最近活跃淘汰最旧', () => {
    const s = memoryStorage();
    let state = { sessions: [], activeId: null };
    for (let i = 0; i < MAX_SESSIONS + 2; i++) {
      const fresh = newSession(1000 + i);
      fresh.title = `会话${i}`;
      fresh.updatedAt = 1000 + i;
      state = saveSessions([fresh, ...state.sessions], fresh.id, s);
    }
    expect(state.sessions).toHaveLength(MAX_SESSIONS);
    expect(state.sessions.map((x) => x.title)).not.toContain('会话0');
    expect(state.sessions[0].title).toBe('会话11');
  });

  it('saveSessions 持久化 activeId，失效时回退最近会话', () => {
    const s = memoryStorage();
    const a = newSession(1);
    const b = newSession(2);
    let { sessions, activeId } = saveSessions([a, b], a.id, s);
    expect(activeId).toBe(a.id);
    ({ sessions, activeId } = saveSessions(sessions, 'no-such-id', s));
    expect(activeId).toBe(b.id); // b.updatedAt 更新（同 createdAt 时后创建的排前？此处按列表稳定排序回退首个）
  });

  it('deleteSession 删除指定会话，删空自动补新会话', () => {
    const s = memoryStorage();
    const a = newSession(1);
    a.title = 'A';
    const b = newSession(2);
    b.title = 'B';
    let { sessions, activeId } = saveSessions([a, b], a.id, s);
    ({ sessions, activeId } = deleteSession(sessions, activeId, a.id, s));
    expect(sessions.map((x) => x.title)).toEqual(['B']);
    expect(activeId).toBe(b.id);
    ({ sessions } = deleteSession(sessions, activeId, b.id, s));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe('新的对话');
  });

  it('clearActiveMessages 清空消息并重置标题，保留会话', () => {
    const s = memoryStorage();
    let { sessions, activeId } = loadSessions(s);
    ({ sessions, activeId } = appendToSession(sessions, activeId, { role: 'user', content: 'hello world', time: 1 }, s));
    ({ sessions, activeId } = clearActiveMessages(sessions, activeId, s));
    const active = sessions.find((x) => x.id === activeId);
    expect(active.messages).toEqual([]);
    expect(active.title).toBe('新的对话');
  });

  it('appendToSession 无匹配会话时自动新建', () => {
    const s = memoryStorage();
    const { sessions, activeId } = appendToSession([], 'ghost', { role: 'user', content: 'hi', time: 5 }, s);
    expect(sessions).toHaveLength(1);
    expect(activeId).toBe(sessions[0].id);
  });

  it('titleFromText 压缩空白并截断', () => {
    expect(titleFromText('  a \n b  ')).toBe('a b');
    expect(titleFromText('x'.repeat(30))).toHaveLength(19); // 18 + 省略号
    expect(titleFromText('')).toBe('新的对话');
  });
});

describe('附件组装与历史裁剪', () => {
  const att = [
    { name: 'report.pdf', content: 'A'.repeat(50), truncated: false },
    { name: 'data.csv', content: 'B'.repeat(30), truncated: true },
  ];

  it('最后一条用户消息携带完整附件内容', () => {
    const history = [
      { role: 'user', content: '第一轮', attachments: att },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '再帮我看一次', attachments: att },
    ];
    const out = buildOutgoingMessages(history, null);
    const last = out.at(-1);
    expect(last.content).toContain('再帮我看一次');
    expect(last.content).toContain('【附件文件：report.pdf】');
    expect(last.content).toContain('，内容超长已截断】');
    expect(last.content).toContain('A'.repeat(50));
    // 更早轮次的同一附件被省略正文
    expect(out[0].content).toContain('【附件：report.pdf（内容已省略）】');
    expect(out[0].content).not.toContain('AAAA');
  });

  it('历史轮次的附件只保留占位，不再携带正文', () => {
    const history = [
      { role: 'user', content: '看看这个文件', attachments: att },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续' },
    ];
    const out = buildOutgoingMessages(history, null);
    expect(out[0].content).toContain('【附件：report.pdf（内容已省略）】');
    expect(out[0].content).not.toContain('AAAA');
    expect(out.at(-1).content).toBe('继续');
  });

  it('无附件消息不受影响', () => {
    const out = buildOutgoingMessages([{ role: 'user', content: 'hi' }], null);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('额度上下文注入', () => {
  it('无供应商返回 null', () => {
    expect(buildQuotaContext([])).toBeNull();
    expect(buildQuotaContext(null)).toBeNull();
  });

  it('正常供应商生成含余额的 system 消息', () => {
    const ctx = buildQuotaContext([
      { name: 'DeepSeek', type: 'deepseek', lastQuery: { status: 'ok', balance: 42.5, currency: 'CNY' } },
    ]);
    expect(ctx.role).toBe('system');
    expect(ctx.content).toContain('DeepSeek');
    expect(ctx.content).toContain('42.5');
  });

  it('查询失败与未查询供应商也如实说明', () => {
    const ctx = buildQuotaContext([
      { name: 'A', type: 'x', lastQuery: { status: 'failed' } },
      { name: 'B', type: 'y', lastQuery: null },
    ]);
    expect(ctx.content).toContain('查询失败');
    expect(ctx.content).toContain('未查询');
  });
});

describe('发往模型的消息组装', () => {
  it('注入额度上下文在历史之前', () => {
    const history = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const ctx = { role: 'system', content: 'quota' };
    const out = buildOutgoingMessages(history, ctx);
    expect(out[0]).toEqual(ctx);
    expect(out).toHaveLength(4);
    expect(out[1].content).toBe('q1');
  });

  it('历史截断时丢弃开头的孤立 assistant 消息', () => {
    // 构造 12*2+1 条，截断后开头是 assistant
    const history = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `q${i}` });
      history.push({ role: 'assistant', content: `a${i}` });
    }
    history.push({ role: 'assistant', content: 'extra' });
    const out = buildOutgoingMessages(history, null, 10);
    expect(out[0].role).toBe('user');
    expect(out.every((m) => m.role !== 'system')).toBe(true);
  });

  it('无上下文且历史开头是 user 时不丢消息', () => {
    const history = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ];
    const out = buildOutgoingMessages(history, null);
    expect(out).toHaveLength(2);
  });
});

describe('额度供应商 → 对话模型联动', () => {
  it('未设置 chatModel 时回退类型默认模型与默认地址', () => {
    const prof = buildProfileFromProvider({ id: 'abc', name: 'DeepSeek 主账号', type: 'deepseek', baseUrl: '', chatModel: '' });
    expect(prof).toEqual({
      id: 'prov-abc',
      name: 'DeepSeek 主账号',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
  });

  it('供应商自定义的 Base URL 与 chatModel 优先生效', () => {
    const prof = buildProfileFromProvider({
      id: 'x', name: '中转站', type: 'openai', baseUrl: 'https://relay.example.com/v1/', chatModel: 'gpt-x',
    });
    expect(prof.base_url).toBe('https://relay.example.com/v1'); // 去尾部斜杠
    expect(prof.model).toBe('gpt-x');
  });

  it('custom 类型无默认模型时 model 为空串', () => {
    const prof = buildProfileFromProvider({ id: 'c', name: '手动', type: 'custom', baseUrl: '', chatModel: '' });
    expect(prof.model).toBe('');
    expect(prof.base_url).toBe('');
  });

  it('importableProviders 过滤停用与双凭证类型（火山 IAM）', () => {
    const out = importableProviders([
      { id: '1', name: 'A', type: 'deepseek', enabled: true },
      { id: '2', name: '停用', type: 'deepseek', enabled: false },
      { id: '3', name: '方舟', type: 'volcengine', enabled: true },
    ]);
    expect(out.map((p) => p.id)).toEqual(['1']);
  });
});
