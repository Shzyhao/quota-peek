import { describe, it, expect } from 'vitest';
import {
  evaluateProvider,
  daysUntil,
  remainingQuotaOf,
  defaultSettings,
  sortProviders,
  filterProviders,
} from '../src/core/status.js';

const NOW = new Date('2026-09-01T10:00:00');

function config(overrides = {}) {
  return {
    id: 'p1',
    name: 'DeepSeek 主账号',
    type: 'deepseek',
    apiKey: 'sk-xxxxxxxxxxxx',
    baseUrl: '',
    planTotalQuota: null,
    usedQuota: null,
    remainingQuota: null,
    expiryDate: null,
    note: '',
    enabled: true,
    lastQuery: null,
    ...overrides,
  };
}

const okQuery = (balance) => ({
  time: '2026-09-01T09:00:00.000Z',
  status: 'ok',
  balance,
  currency: 'CNY',
  error: null,
});

describe('daysUntil', () => {
  it('计算自然日差', () => {
    expect(daysUntil('2026-09-08', NOW)).toBe(7);
    expect(daysUntil('2026-09-01', NOW)).toBe(0);
    expect(daysUntil('2026-08-25', NOW)).toBe(-7);
  });

  it('空值或非法值返回 null', () => {
    expect(daysUntil('', NOW)).toBeNull();
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil('not-a-date', NOW)).toBeNull();
  });
});

describe('remainingQuotaOf', () => {
  it('优先使用手动填写的剩余额度', () => {
    expect(remainingQuotaOf(config({ planTotalQuota: 100, usedQuota: 90, remainingQuota: 20 }))).toBe(20);
  });

  it('未填写时按总额度减已用额度计算', () => {
    expect(remainingQuotaOf(config({ planTotalQuota: 100, usedQuota: 90 }))).toBe(10);
  });

  it('信息不足时返回 null', () => {
    expect(remainingQuotaOf(config())).toBeNull();
    expect(remainingQuotaOf(config({ planTotalQuota: 100 }))).toBeNull();
  });
});

describe('evaluateProvider', () => {
  const settings = defaultSettings();

  it('正常情况：查询成功且无告警 → ok', () => {
    const r = evaluateProvider(config({ lastQuery: okQuery(50) }), settings);
    expect(r.level).toBe('ok');
    expect(r.label).toBe('正常');
    expect(r.reasons).toEqual([]);
  });

  it('查询失败 → error，理由包含错误信息', () => {
    const r = evaluateProvider(
      config({ lastQuery: { time: 'x', status: 'failed', error: '网络错误', balance: null } }),
      settings,
    );
    expect(r.level).toBe('error');
    expect(r.reasons[0]).toContain('查询失败');
    expect(r.reasons[0]).toContain('网络错误');
  });

  it('已到期 → error', () => {
    const r = evaluateProvider(config({ expiryDate: '2026-08-01', lastQuery: okQuery(50) }), settings);
    expect(r.level).toBe('error');
    expect(r.reasons.join()).toContain('2026-08-01');
    expect(r.reasons.join()).toContain('到期');
  });

  it('7 天内到期 → warn', () => {
    const r = evaluateProvider(config({ expiryDate: '2026-09-05', lastQuery: okQuery(50) }), { ...settings, expiryWarningDays: 7 });
    expect(r.level).toBe('warn');
    expect(r.reasons.join()).toContain('天后到期');
  });

  it('余额过低 → warn', () => {
    const r = evaluateProvider(config({ lastQuery: okQuery(5) }), settings);
    expect(r.level).toBe('warn');
    expect(r.reasons.join()).toContain('余额过低');
  });

  it('剩余额度过低 → warn', () => {
    const r = evaluateProvider(
      config({ planTotalQuota: 100, usedQuota: 96, lastQuery: okQuery(50) }),
      settings,
    );
    expect(r.level).toBe('warn');
    expect(r.reasons.join()).toContain('剩余额度过低');
  });

  it('官方标记不可用 → warn', () => {
    const r = evaluateProvider(config({ lastQuery: { ...okQuery(50), isAvailable: false } }), settings);
    expect(r.level).toBe('warn');
    expect(r.reasons.join()).toContain('不可用');
  });

  it('不支持自动查询的类型 → neutral（不是错误）', () => {
    const r = evaluateProvider(
      config({ type: 'custom', lastQuery: { time: 'x', status: 'unsupported', balance: null } }),
      settings,
    );
    expect(r.level).toBe('neutral');
    expect(r.label).toBe('不支持自动查询');
  });

  it('已停用 → neutral', () => {
    const r = evaluateProvider(config({ enabled: false }), settings);
    expect(r.level).toBe('neutral');
    expect(r.label).toBe('已停用');
  });

  it('多种告警叠加时 error 优先于 warn', () => {
    const r = evaluateProvider(
      config({ expiryDate: '2026-08-01', lastQuery: okQuery(3) }),
      settings,
    );
    expect(r.level).toBe('error');
    expect(r.reasons.length).toBe(2);
  });
});

describe('evaluateProvider 套餐用量提醒（Coding Plan）', () => {
  const settings = defaultSettings(); // 阈值：剩余 10% → 用量 ≥ 90% 提醒

  const usageQuery = (windowUsedPercent, weeklyUsedPercent) => ({
    time: '2026-09-01T09:00:00.000Z',
    status: 'ok',
    balance: null,
    currency: null,
    usage: { windowUsedPercent, weeklyUsedPercent, monthlyUsedPercent: null },
  });

  it('近 5 小时用量达到 90% → warn 并说明用量', () => {
    const r = evaluateProvider(config({ type: 'zhipu', lastQuery: usageQuery(95, 30) }), settings);
    expect(r.level).toBe('warn');
    expect(r.reasons.join()).toContain('近 5 小时套餐用量已达 95%');
    expect(r.reasons.join()).not.toContain('本周');
  });

  it('周用量达到阈值 → warn', () => {
    const r = evaluateProvider(config({ type: 'minimax', lastQuery: usageQuery(20, 91.5) }), settings);
    expect(r.level).toBe('warn');
    expect(r.reasons.join()).toContain('本周套餐用量已达 91.5%');
  });

  it('用量正常 → ok', () => {
    const r = evaluateProvider(config({ type: 'zhipu', lastQuery: usageQuery(40, 50) }), settings);
    expect(r.level).toBe('ok');
    expect(r.reasons).toEqual([]);
  });
});

describe('sortProviders / filterProviders', () => {
  const settings = defaultSettings();

  function build() {
    return [
      config({ id: 'a', name: 'Alpha 正常', type: 'deepseek', lastQuery: okQuery(50) }),
      config({ id: 'b', name: 'Beta 异常', type: 'deepseek', lastQuery: { time: 'x', status: 'failed', error: 'boom' } }),
      config({ id: 'c', name: 'Gamma 提醒', type: 'deepseek', lastQuery: okQuery(3) }), // 余额过低
      config({ id: 'd', name: 'Delta 停用', enabled: false }),
      config({ id: 'e', name: 'Epsilon 手动', type: 'custom', lastQuery: { time: 'x', status: 'unsupported' } }),
    ];
  }

  it('排序：异常 > 提醒 > 正常 > 中性', () => {
    const sorted = sortProviders(build(), settings).map((p) => p.id);
    expect(sorted).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('按关键词过滤：名称 / 备注 / 类型标签', () => {
    const list = [
      ...build().slice(0, 3),
      config({ id: 'f', name: 'Zeta', note: '生产环境主力', type: 'zhipu' }),
    ];
    expect(filterProviders(list, settings, { query: 'beta' }).map((p) => p.id)).toEqual(['b']);
    expect(filterProviders(list, settings, { query: '生产环境' }).map((p) => p.id)).toEqual(['f']);
    expect(filterProviders(list, settings, { query: '智谱' }).map((p) => p.id)).toEqual(['f']);
    expect(filterProviders(list, settings, { query: '不存在的关键词' })).toEqual([]);
  });

  it('按状态过滤：全部 / 需要关注 / 已停用 / 正常', () => {
    const list = build();
    expect(filterProviders(list, settings, { status: 'all' })).toHaveLength(5);
    expect(filterProviders(list, settings, { status: 'attention' }).map((p) => p.id)).toEqual(['b', 'c']);
    expect(filterProviders(list, settings, { status: 'disabled' }).map((p) => p.id)).toEqual(['d']);
    expect(filterProviders(list, settings, { status: 'ok' }).map((p) => p.id)).toEqual(['a']);
  });

  it('关键词与状态可组合', () => {
    const list = build();
    const out = filterProviders(list, settings, { query: 'beta', status: 'attention' });
    expect(out.map((p) => p.id)).toEqual(['b']);
  });
});
