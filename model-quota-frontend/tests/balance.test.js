import { describe, it, expect, vi } from 'vitest';
import {
  queryStepfunBalance,
  querySiliconflowBalance,
  queryOpenRouterBalance,
  queryNovitaBalance,
  STEPFUN_DEFAULT_BASE_URL,
  SILICONFLOW_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  NOVITA_DEFAULT_BASE_URL,
} from '../src/core/balance.js';

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('StepFun', () => {
  it('解析余额与现金/代金券明细', async () => {
    const body = { object: 'account', balance: 42.5, total_cash_balance: 30, total_voucher_balance: 12.5 };
    const fetchImpl = vi.fn().mockResolvedValue(res(body));
    const r = await queryStepfunBalance({ apiKey: 'sk-step', fetchImpl });

    expect(r.balance).toBe(42.5);
    expect(r.currency).toBe('CNY');
    expect(r.extraLine).toContain('现金 30');
    expect(r.extraLine).toContain('代金券 12.5');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${STEPFUN_DEFAULT_BASE_URL}/v1/accounts`);
    expect(init.headers.Authorization).toBe('Bearer sk-step');
  });
});

describe('SiliconFlow', () => {
  it('国内站解析 totalBalance（CNY）', async () => {
    const body = { code: 20000, data: { balance: '10.5', chargeBalance: '8.0', totalBalance: '18.5', status: 'normal' } };
    const fetchImpl = vi.fn().mockResolvedValue(res(body));
    const r = await querySiliconflowBalance({ apiKey: 'sk-sf', fetchImpl });

    expect(r.balance).toBe(18.5);
    expect(r.currency).toBe('CNY');
    expect(r.extraLine).toContain('充值余额 8');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${SILICONFLOW_DEFAULT_BASE_URL}/v1/user/info`);
  });

  it('国际站（.com Base URL）按 USD 计', async () => {
    const body = { data: { totalBalance: '2.5', chargeBalance: '2.5' } };
    const fetchImpl = vi.fn().mockResolvedValue(res(body));
    const r = await querySiliconflowBalance({ apiKey: 'sk-sf', baseUrl: 'https://api.siliconflow.com', fetchImpl });
    expect(r.currency).toBe('USD');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.siliconflow.com/v1/user/info');
  });
});

describe('OpenRouter', () => {
  it('余额 = 总额度 − 已用（USD）', async () => {
    const body = { data: { total_credits: 100, total_usage: 37.25 } };
    const fetchImpl = vi.fn().mockResolvedValue(res(body));
    const r = await queryOpenRouterBalance({ apiKey: 'sk-or', fetchImpl });

    expect(r.balance).toBe(62.75);
    expect(r.currency).toBe('USD');
    expect(r.extraLine).toContain('总额度 100');
    expect(r.extraLine).toContain('已用 37.25');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${OPENROUTER_DEFAULT_BASE_URL}/api/v1/credits`);
  });
});

describe('Novita AI', () => {
  it('金额单位 0.0001 USD，除以 10000 换算', async () => {
    const body = { availableBalance: 250000, cashBalance: 250000, creditLimit: 0 };
    const fetchImpl = vi.fn().mockResolvedValue(res(body));
    const r = await queryNovitaBalance({ apiKey: 'sk-nv', fetchImpl });

    expect(r.balance).toBe(25);
    expect(r.currency).toBe('USD');
    expect(fetchImpl.mock.calls[0][0]).toBe(`${NOVITA_DEFAULT_BASE_URL}/v3/user/balance`);
  });
});

describe('通用错误处理（四家共用）', () => {
  it('401 → 鉴权错误；缺 Key → 不发请求；网络异常 → 网络错误；缺余额字段 → 解析错误', async () => {
    await expect(queryStepfunBalance({ apiKey: 'x', fetchImpl: vi.fn().mockResolvedValue(res({}, 401)) })).rejects.toMatchObject({ code: 'auth' });
    await expect(queryStepfunBalance({ apiKey: '', fetchImpl: vi.fn() })).rejects.toMatchObject({ code: 'missing_key' });
    await expect(queryOpenRouterBalance({ apiKey: 'x', fetchImpl: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) })).rejects.toMatchObject({ code: 'network' });
    await expect(queryNovitaBalance({ apiKey: 'x', fetchImpl: vi.fn().mockResolvedValue(res({ foo: 1 })) })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('非 401 的非 2xx → http 错误并附响应片段', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ error: 'boom' }, 500));
    await expect(querySiliconflowBalance({ apiKey: 'x', fetchImpl })).rejects.toMatchObject({ code: 'http' });
  });
});
