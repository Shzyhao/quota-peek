import { describe, it, expect, vi } from 'vitest';
import { queryMiniMaxQuota, MINIMAX_DEFAULT_BASE_URL } from '../src/core/minimax.js';

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

// cc-switch 同款 openplatform 新端点的返回：取 model_name === 'general' 的条目
const openPlatformBody = {
  model_remains: [
    {
      model_name: 'video',
      current_interval_remaining_percent: 99,
      current_weekly_status: 3,
    },
    {
      model_name: 'general',
      current_interval_remaining_percent: 68, // 窗口剩余 68% → 已用 32%
      current_interval_usage_count: 320,
      current_interval_total_count: 1000,
      current_interval_status: 1,
      end_time: 1756848000000,
      current_weekly_remaining_percent: 75,
      current_weekly_usage_count: 2500,
      current_weekly_total_count: 10000,
      current_weekly_status: 1,
      weekly_end_time: 1757366400000,
    },
  ],
};

// 官方 CLI 同款旧端点的返回：多模型行取用量最紧的一行
const tokenPlanBody = {
  model_remains: [
    {
      model_name: 'MiniMax-M2.5',
      current_interval_remaining_percent: 68,
      current_interval_usage_count: 320,
      current_interval_total_count: 1000,
      current_interval_status: 1,
      current_weekly_remaining_percent: 75,
      current_weekly_usage_count: 2500,
      current_weekly_total_count: 10000,
      current_weekly_status: 1,
    },
    {
      model_name: 'MiniMax-M2.5-high',
      current_interval_remaining_percent: 90,
      current_interval_usage_count: 100,
      current_interval_total_count: 1000,
      current_interval_status: 1,
      current_weekly_remaining_percent: 95,
      current_weekly_usage_count: 500,
      current_weekly_total_count: 10000,
      current_weekly_status: 1,
    },
  ],
};

const accountBalanceBody = {
  available_amount: '12.34',
  cash_balance: '10.00',
  voucher_balance: '2.34',
  base_resp: { status_code: 0, status_msg: '' },
};

describe('queryMiniMaxQuota（openplatform 新端点优先）', () => {
  it('解析 general 条目：5h/周已用百分比、次数与重置时间', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(openPlatformBody));
    const r = await queryMiniMaxQuota({ apiKey: 'coding-plan-key', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${MINIMAX_DEFAULT_BASE_URL}/v1/api/openplatform/coding_plan/remains`);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer coding-plan-key');

    expect(r.balance).toBeNull();
    expect(r.extraLine).toBe('套餐：Coding Plan');
    expect(r.usage).toMatchObject({
      windowUsedPercent: 32, // 100 - 68
      weeklyUsedPercent: 25, // 100 - 75（weekly status=1 激活）
      windowUsed: 320,
      windowTotal: 1000,
      weeklyUsed: 2500,
      weeklyTotal: 10000,
      windowResetAt: new Date(1756848000000).toISOString(),
      weeklyResetAt: new Date(1757366400000).toISOString(),
    });
  });

  it('current_weekly_status ≠ 1（如 3 = 无周限额）时周用量为空', async () => {
    const body = {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 50,
          current_weekly_status: 3,
          current_weekly_remaining_percent: 80,
          current_weekly_usage_count: 1,
          current_weekly_total_count: 100,
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(res(body));
    const r = await queryMiniMaxQuota({ apiKey: 'k', fetchImpl });

    expect(r.usage.weeklyUsedPercent).toBeNull();
    expect(r.usage.weeklyUsed).toBeNull();
    expect(r.usage.weeklyResetAt).toBeNull();
  });

  it('鉴权错误不回退旧端点', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res({ base_resp: { status_code: 1004, status_msg: 'login fail' } }),
    );
    await expect(queryMiniMaxQuota({ apiKey: 'bad', fetchImpl })).rejects.toMatchObject({ code: 'auth' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('queryMiniMaxQuota（回退官方 CLI 旧端点）', () => {
  it('openplatform 无 general 条目时回退 token_plan，取用量最紧的一行', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(tokenPlanBody)) // openplatform：无 general → bad_response
      .mockResolvedValueOnce(res(tokenPlanBody)); // 回退 token_plan 成功
    const r = await queryMiniMaxQuota({ apiKey: 'coding-plan-key', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain('/v1/api/openplatform/coding_plan/remains');
    expect(fetchImpl.mock.calls[1][0]).toBe(`${MINIMAX_DEFAULT_BASE_URL}/v1/token_plan/remains`);

    expect(r.usage.windowUsedPercent).toBe(32);
    expect(r.usage.weeklyUsedPercent).toBe(25);
    expect(r.extraLine).toContain('MiniMax-M2.5'); // 最紧一行的模型名，不带 -high
  });

  it('openplatform 404 时回退旧端点', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res({ error: 'not found' }, 404))
      .mockResolvedValueOnce(res(tokenPlanBody));
    const r = await queryMiniMaxQuota({ apiKey: 'k', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.usage.windowUsedPercent).toBe(32);
  });

  it('两个端点都无数据 → 解析错误', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res({ model_remains: [] }))
      .mockResolvedValueOnce(res({ model_remains: [] }));
    await expect(queryMiniMaxQuota({ apiKey: 'k', fetchImpl })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('旧端点：缺少剩余百分比时按次数推导，status=2（耗尽）视为 100%', async () => {
    const body = {
      model_remains: [
        {
          model_name: 'M2',
          current_interval_usage_count: 75,
          current_interval_total_count: 100,
          current_interval_status: 1,
          current_weekly_usage_count: 0,
          current_weekly_total_count: 0,
          current_weekly_status: 2,
        },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res({ model_remains: [] })) // openplatform 无 general
      .mockResolvedValueOnce(res(body)); // token_plan
    const r = await queryMiniMaxQuota({ apiKey: 'k', fetchImpl });

    expect(r.usage.windowUsedPercent).toBe(75); // 75/100
    expect(r.usage.weeklyUsedPercent).toBe(100); // status=2 耗尽
  });
});

describe('queryMiniMaxQuota（sk-api- 普通 API Key → account/query_balance）', () => {
  it('按官方 CLI 的路由规则切换端点并解析字符串余额', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(accountBalanceBody));
    const r = await queryMiniMaxQuota({ apiKey: 'sk-api-regular-key', fetchImpl });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${MINIMAX_DEFAULT_BASE_URL}/account/query_balance`);
    expect(r.balance).toBe(12.34);
    expect(r.currency).toBe('CNY');
    expect(r.extraLine).toContain('代金券');
  });
});

describe('queryMiniMaxQuota（通用错误）', () => {
  it('网络异常与缺少 API Key', async () => {
    const network = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(queryMiniMaxQuota({ apiKey: 'k', fetchImpl: network })).rejects.toMatchObject({ code: 'network' });
    await expect(queryMiniMaxQuota({ apiKey: '', fetchImpl: vi.fn() })).rejects.toMatchObject({ code: 'missing_key' });
  });
});
