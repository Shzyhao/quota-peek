import { describe, it, expect, vi } from 'vitest';
import { queryZhipuCodingPlan, ZHIPU_DEFAULT_BASE_URL } from '../src/core/zhipu.js';

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// 与智谱官方接口一致的典型结构：TOKENS_LIMIT 有两条（unit=3 五小时 / unit=6 周额度）
const okBody = {
  success: true,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, usage: 100000, currentValue: 32500, percentage: 32.5, nextResetTime: 1756848000000 },
      { type: 'TOKENS_LIMIT', unit: 6, usage: 500000, currentValue: 225000, percentage: 45, nextResetTime: 1757366400000 },
      { type: 'TIME_LIMIT', unit: 0, usage: 100, currentValue: 24, percentage: 24 },
    ],
  },
};

describe('queryZhipuCodingPlan', () => {
  it('按 unit 区分 5 小时窗口（unit=3）与周额度（unit=6），并提取已用/总额与重置时间', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    const r = await queryZhipuCodingPlan({ apiKey: 'zhipu-key', fetchImpl });

    expect(r.status).toBe('ok');
    expect(r.balance).toBeNull(); // 套餐制无余额
    expect(r.usage).toEqual({
      windowUsedPercent: 32.5,
      weeklyUsedPercent: 45,
      monthlyUsedPercent: 24,
      windowUsed: 32500,
      windowTotal: 100000,
      weeklyUsed: 225000,
      weeklyTotal: 500000,
      monthlyUsed: 24,
      monthlyTotal: 100,
      windowResetAt: new Date(1756848000000).toISOString(),
      weeklyResetAt: new Date(1757366400000).toISOString(),
    });
  });

  it('使用官方插件的裸 Authorization 头（无 Bearer 前缀），URL 正确', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    await queryZhipuCodingPlan({ apiKey: 'zhipu-key', fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${ZHIPU_DEFAULT_BASE_URL}/api/monitor/usage/quota/limit`);
    expect(init.headers.Authorization).toBe('zhipu-key');
  });

  it('自定义 baseUrl 末尾斜杠会被规范化', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    await queryZhipuCodingPlan({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  });

  it('旧版响应无 unit 字段时，第一条 TOKENS_LIMIT 视为 5 小时窗口，周额度为空', async () => {
    const legacy = {
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 50, usage: 100000, currentValue: 50000 }] },
    };
    const fetchImpl = vi.fn().mockResolvedValue(res(legacy));
    const r = await queryZhipuCodingPlan({ apiKey: 'k', fetchImpl });

    expect(r.usage.windowUsedPercent).toBe(50);
    expect(r.usage.windowUsed).toBe(50000);
    expect(r.usage.weeklyUsedPercent).toBeNull();
    expect(r.usage.weeklyTotal).toBeNull();
  });

  it('仅周额度（无 unit=3）也能解析', async () => {
    const weeklyOnly = {
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, usage: 500000, currentValue: 100000, percentage: 20 }] },
    };
    const fetchImpl = vi.fn().mockResolvedValue(res(weeklyOnly));
    const r = await queryZhipuCodingPlan({ apiKey: 'k', fetchImpl });

    expect(r.usage.windowUsedPercent).toBeNull();
    expect(r.usage.weeklyUsedPercent).toBe(20);
    expect(r.usage.weeklyUsed).toBe(100000);
  });

  it('percentage 超过 100 时按 100 截断展示', async () => {
    const over = {
      success: true,
      data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 130, usage: 100, currentValue: 130 }] },
    };
    const fetchImpl = vi.fn().mockResolvedValue(res(over));
    const r = await queryZhipuCodingPlan({ apiKey: 'k', fetchImpl });
    expect(r.usage.windowUsedPercent).toBe(100);
  });

  it('HTTP 200 但 success:false 且 code 401 → 鉴权错误（智谱错误放在响应体）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ code: 401, msg: '令牌已过期或验证不正确', success: false }));
    await expect(queryZhipuCodingPlan({ apiKey: 'bad', fetchImpl })).rejects.toMatchObject({
      code: 'auth',
      message: expect.stringContaining('令牌已过期'),
    });
  });

  it('code 1001（未携带 Authorization）→ 鉴权错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res({ code: 1001, msg: 'Header中未收到Authorization参数，无法进行身份验证。', success: false }),
    );
    await expect(queryZhipuCodingPlan({ apiKey: 'x', fetchImpl })).rejects.toMatchObject({ code: 'auth' });
  });

  it('其他业务错误码 → http 错误；非 200 状态码 → http 错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ code: 500, msg: '服务异常', success: false }));
    await expect(queryZhipuCodingPlan({ apiKey: 'x', fetchImpl })).rejects.toMatchObject({ code: 'http' });

    const fetchImpl2 = vi.fn().mockResolvedValue(res({ success: true }, 502));
    await expect(queryZhipuCodingPlan({ apiKey: 'x', fetchImpl: fetchImpl2 })).rejects.toMatchObject({ code: 'http' });
  });

  it('网络异常 → 网络错误；返回缺少 limits → 解析错误；无可识别类型 → 解析错误', async () => {
    const network = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(queryZhipuCodingPlan({ apiKey: 'x', fetchImpl: network })).rejects.toMatchObject({ code: 'network' });

    const noLimits = vi.fn().mockResolvedValue(res({ success: true, data: { limits: [] } }));
    await expect(queryZhipuCodingPlan({ apiKey: 'x', fetchImpl: noLimits })).rejects.toMatchObject({ code: 'bad_response' });

    const unknownType = vi.fn().mockResolvedValue(res({ success: true, data: { limits: [{ type: 'MYSTERY_LIMIT', percentage: 1 }] } }));
    await expect(queryZhipuCodingPlan({ apiKey: 'x', fetchImpl: unknownType })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('未配置 API Key 时不发起请求', async () => {
    const fetchImpl = vi.fn();
    await expect(queryZhipuCodingPlan({ apiKey: '', fetchImpl })).rejects.toMatchObject({ code: 'missing_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
