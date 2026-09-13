import { describe, it, expect } from 'vitest';
import { pickChatterLine, isQuietHour } from '../src/core/chatter.js';
import { defaultSettings } from '../src/core/status.js';

const settings = defaultSettings();

// 稳定 rng：依次返回给定序列，超出后重复最后一个
function seqRng(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const usageProvider = (windowPct, weeklyPct, name = '智谱 GLM') => ({
  id: 'p1',
  name,
  type: 'zhipu',
  enabled: true,
  lastQuery: { time: '2026-09-13T08:00:00.000Z', status: 'ok', balance: null, currency: null, usage: { windowUsedPercent: windowPct, weeklyUsedPercent: weeklyPct } },
});

const balanceProvider = (balance, name = 'DeepSeek') => ({
  id: 'p2',
  name,
  type: 'deepseek',
  enabled: true,
  lastQuery: { time: '2026-09-13T08:00:00.000Z', status: 'ok', balance, currency: 'CNY', usage: null },
});

describe('isQuietHour', () => {
  it('23:00–08:00 为勿扰时段', () => {
    expect(isQuietHour(new Date(2026, 8, 13, 23, 0))).toBe(true);
    expect(isQuietHour(new Date(2026, 8, 13, 3, 30))).toBe(true);
    expect(isQuietHour(new Date(2026, 8, 13, 8, 0))).toBe(false);
    expect(isQuietHour(new Date(2026, 8, 13, 22, 59))).toBe(false);
  });
});

describe('pickChatterLine', () => {
  it('勿扰时段返回 null', () => {
    expect(pickChatterLine({ providers: [usageProvider(10, 20)], settings, now: new Date(2026, 8, 13, 23, 30) })).toBeNull();
  });

  it('有告警时软提醒包含供应商名与原因', () => {
    const lowBalance = balanceProvider(5);
    const line = pickChatterLine({ providers: [lowBalance], settings, now: new Date(2026, 8, 13, 10, 0), rng: seqRng([0, 0, 0]) });
    expect(line).toContain('DeepSeek');
    expect(line).toContain('余额过低');
  });

  it('用量超 80% 提醒省着用', () => {
    const line = pickChatterLine({ providers: [usageProvider(30, 85)], settings, now: new Date(2026, 8, 13, 10, 0), rng: () => 0.9 });
    expect(line).toContain('85%');
  });

  it('全部正常时报最忙的用量与家数', () => {
    const line = pickChatterLine({ providers: [usageProvider(30, 45), usageProvider(10, 12, 'Kimi')], settings, now: new Date(2026, 8, 13, 10, 0), rng: () => 0.9 });
    expect(line).toContain('智谱 GLM');
    expect(line).toContain('45%');
  });

  it('只有余额时报余额合计', () => {
    const line = pickChatterLine({ providers: [balanceProvider(110.4)], settings, now: new Date(2026, 8, 13, 10, 0), rng: () => 0.4 });
    expect(line).toContain('110');
  });

  it('无数据时引导去刷新或邀请聊天', () => {
    const line = pickChatterLine({ providers: [], settings, now: new Date(2026, 8, 13, 10, 0), rng: () => 0.5 });
    expect(line).toBeTruthy();
  });

  it('停用的供应商不参与播报', () => {
    const p = balanceProvider(5);
    p.enabled = false;
    const line = pickChatterLine({ providers: [p], settings, now: new Date(2026, 8, 13, 10, 0), rng: () => 0.5 });
    expect(line).not.toContain('余额过低');
  });
});
