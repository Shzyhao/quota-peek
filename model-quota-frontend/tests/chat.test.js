import { describe, it, expect } from 'vitest';
import {
  loadHistory, saveHistory, clearHistory, buildQuotaContext, buildOutgoingMessages,
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

describe('会话存储', () => {
  it('空存储返回空数组', () => {
    expect(loadHistory(memoryStorage())).toEqual([]);
  });

  it('损坏 JSON 返回空数组而不抛错', () => {
    const s = memoryStorage();
    s.setItem('mqc.chat.messages', '{oops');
    expect(loadHistory(s)).toEqual([]);
  });

  it('保存超过上限只留最近 100 条', () => {
    const s = memoryStorage();
    const msgs = Array.from({ length: 130 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const saved = saveHistory(msgs, s);
    expect(saved).toHaveLength(100);
    expect(saved[0].content).toBe('m30');
    expect(loadHistory(s)).toHaveLength(100);
  });

  it('clearHistory 清空', () => {
    const s = memoryStorage();
    saveHistory([{ role: 'user', content: 'hi' }], s);
    clearHistory(s);
    expect(loadHistory(s)).toEqual([]);
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
