import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsage, listUsage, summarizeUsageByDay, summarizeUsageByModel,
  recordBalanceSnapshots, loadBalanceHistory,
  USAGE_KEY, BALANCE_HISTORY_KEY, MAX_USAGE_ENTRIES, MAX_BALANCE_POINTS,
} from '../src/core/usage.js';
import { lineChart, legend, barRows } from '../src/ui/chart.js';

const DAY = 86400000;

beforeEach(() => {
  localStorage.clear();
});

describe('recordUsage 记录与上限', () => {
  it('正常记录；tokens 全缺省不入库；超上限裁最旧', () => {
    expect(recordUsage({ profileId: 'p', model: 'm', source: 'chat' })).toBeNull(); // 无 token 数字
    expect(recordUsage({ promptTokens: 'abc' })).toBeNull();

    for (let i = 0; i < 30; i++) recordUsage({ profileId: 'p', model: 'm', promptTokens: 10, completionTokens: 5, source: 'chat' });
    const list = listUsage();
    expect(list).toHaveLength(30);
    expect(list[0].promptTokens).toBe(10);

    for (let i = 0; i < MAX_USAGE_ENTRIES; i++) {
      recordUsage({ model: 'm', promptTokens: 1, completionTokens: 0 });
    }
    expect(listUsage().length).toBeLessThanOrEqual(MAX_USAGE_ENTRIES);
    expect(listUsage()[0].time).toBeGreaterThanOrEqual(listUsage()[1].time); // 新的在前
  });

  it('字段归一：profileName/model 字符串化，source 缺省 chat', () => {
    recordUsage({ model: 42, promptTokens: 1, completionTokens: 2 });
    const u = listUsage()[0];
    expect(u.model).toBe('42');
    expect(u.source).toBe('chat');
    expect(u.promptTokens).toBe(1);
    expect(u.completionTokens).toBe(2);
  });
});

describe('summarizeUsageByDay / ByModel', () => {
  it('按天汇总（窗口两侧补零行）；按模型汇总降序', () => {
    const now = new Date('2026-09-19T12:00:00').getTime();
    const mk = (daysAgo, prompt, completion, model = 'glm-4.6') => {
      const t = now - daysAgo * DAY;
      const list = JSON.parse(localStorage.getItem(USAGE_KEY) || '[]');
      list.unshift({ id: `u${Math.random()}`, time: t, source: 'chat', profileId: 'p', profileName: '智谱', model, promptTokens: prompt, completionTokens: completion });
      localStorage.setItem(USAGE_KEY, JSON.stringify(list));
    };
    mk(0, 100, 50);
    mk(0, 10, 5, 'deepseek-chat');
    mk(3, 200, 100);

    const days = summarizeUsageByDay(14, localStorage, now);
    expect(days).toHaveLength(14);
    expect(days[13].day).toBe('2026-09-19');
    expect(days[13].prompt).toBe(110);
    expect(days[13].completion).toBe(55);
    expect(days[13].calls).toBe(2);
    expect(days[10].prompt).toBe(200);
    expect(days[days.length - 2].prompt).toBe(0); // 无数据日补零

    const byModel = summarizeUsageByModel();
    expect(byModel[0].model).toBe('glm-4.6'); // 155 > 15
    expect(byModel[0].total).toBe(450); // 100+50+200+100，deepseek-chat 15 排后
    expect(byModel[1].model).toBe('deepseek-chat');
    expect(byModel[1].calls).toBe(1);
  });
});

describe('recordBalanceSnapshots 额度趋势', () => {
  const provider = (id, name, balance, currency = 'CNY') => ({
    id, name, lastQuery: { status: 'ok', balance, currency },
  });

  it('同日同余额去重；余额变化随时记；跨日记点', () => {
    const t0 = new Date('2026-09-19T10:00:00').getTime();
    expect(recordBalanceSnapshots([provider('a', '智谱', 100)], localStorage, t0)).toBe(true);
    // 同日同余额：跳过
    expect(recordBalanceSnapshots([provider('a', '智谱', 100)], localStorage, t0 + 3600000)).toBe(false);
    // 同日余额变化：记
    expect(recordBalanceSnapshots([provider('a', '智谱', 90)], localStorage, t0 + 7200000)).toBe(true);
    // 次日同余额：记（保留时间轴上下文）
    expect(recordBalanceSnapshots([provider('a', '智谱', 90)], localStorage, t0 + DAY)).toBe(true);

    const hist = loadBalanceHistory(localStorage);
    expect(hist).toHaveLength(1);
    expect(hist[0].points.map((p) => p.b)).toEqual([100, 90, 90]);
    expect(hist[0].name).toBe('智谱');
    expect(hist[0].currency).toBe('CNY');
  });

  it('非 ok / 无余额的供应商跳过；删除的供应商历史清除；改名同步', () => {
    const t0 = new Date('2026-09-19T10:00:00').getTime();
    recordBalanceSnapshots([
      provider('a', '智谱', 100),
      { id: 'bad', name: '失败家', lastQuery: { status: 'failed', balance: 1 } },
      { id: 'none', name: '无查询', lastQuery: null },
    ], localStorage, t0);

    // 改名 + 删除 bad
    recordBalanceSnapshots([provider('a', '智谱GLM', 99)], localStorage, t0 + DAY);
    const hist = loadBalanceHistory(localStorage);
    expect(hist).toHaveLength(1);
    expect(hist[0].name).toBe('智谱GLM');
    expect(hist[0].points).toHaveLength(2);
  });

  it('超上限裁最旧点', () => {
    let t = new Date('2026-01-01T10:00:00').getTime();
    for (let i = 0; i < MAX_BALANCE_POINTS + 20; i++) {
      recordBalanceSnapshots([provider('a', 'A', i)], localStorage, t);
      t += DAY;
    }
    const hist = loadBalanceHistory(localStorage);
    expect(hist[0].points.length).toBeLessThanOrEqual(MAX_BALANCE_POINTS);
  });
});

describe('chart.js SVG 图表', () => {
  it('折线图：多序列 path 与网格；空序列返回空串；单点画圆', () => {
    expect(lineChart([])).toBe('');
    expect(lineChart([{ name: 'A', points: [] }])).toBe('');
    const svg = lineChart([
      { name: 'A', points: [{ t: 1, b: 10 }, { t: 2, b: 20 }] },
      { name: 'B', points: [{ t: 1, b: 5 }, { t: 2, b: 8 }] },
    ]);
    expect(svg).toContain('<svg');
    expect(svg.match(/<path /g).length).toBe(2);
    expect(svg).toContain('viewBox="0 0 720');
    const single = lineChart([{ name: 'A', points: [{ t: 1, b: 3 }] }]);
    expect(single).toContain('<circle');
    expect(single).not.toContain('<path');
  });

  it('图例与条行渲染', () => {
    const lg = legend([{ name: '智谱' }, { name: 'DeepSeek' }]);
    expect(lg).toContain('chart-legend-item');
    expect(lg).toContain('智谱');
    const bars = barRows([
      { label: '09-19', value: 50, max: 100, hint: 'x' },
      { label: '09-18', value: 25, max: 100 },
    ]);
    expect(bars.match(/chart-bar-row/g).length).toBe(2);
    expect(bars).toContain('width:50.0%');
  });
});
