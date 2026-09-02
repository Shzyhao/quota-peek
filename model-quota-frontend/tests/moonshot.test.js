import { describe, it, expect, vi } from 'vitest';
import { queryMoonshotBalance, MOONSHOT_DEFAULT_BASE_URL } from '../src/core/moonshot.js';

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const okBody = {
  code: 0,
  data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
  scode: '0x0',
  status: true,
};

describe('queryMoonshotBalance', () => {
  it('成功时解析可用余额并附带代金券/现金明细', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    const r = await queryMoonshotBalance({ apiKey: 'sk-moon', fetchImpl });

    expect(r).toMatchObject({ status: 'ok', balance: 49.58894, currency: 'CNY' });
    expect(r.usage).toBeNull();
    expect(r.extraLine).toContain('代金券');
    expect(r.extraLine).toContain('现金');
  });

  it('使用 Bearer 鉴权与官方端点', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    await queryMoonshotBalance({ apiKey: 'sk-moon', fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${MOONSHOT_DEFAULT_BASE_URL}/v1/users/me/balance`);
    expect(init.headers.Authorization).toBe('Bearer sk-moon');
  });

  it('401 时抛出鉴权错误并携带官方错误信息', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res({ error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } }, 401),
    );
    await expect(queryMoonshotBalance({ apiKey: 'bad', fetchImpl })).rejects.toMatchObject({
      code: 'auth',
      message: expect.stringContaining('Invalid Authentication'),
    });
  });

  it('200 但 code 非 0 → http 错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ code: 1002, status: false }));
    await expect(queryMoonshotBalance({ apiKey: 'x', fetchImpl })).rejects.toMatchObject({ code: 'http' });
  });

  it('返回缺少余额数据 → 解析错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ code: 0, data: null, status: true }));
    await expect(queryMoonshotBalance({ apiKey: 'x', fetchImpl })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('网络异常与缺少 API Key', async () => {
    const network = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(queryMoonshotBalance({ apiKey: 'x', fetchImpl: network })).rejects.toMatchObject({ code: 'network' });
    await expect(queryMoonshotBalance({ apiKey: '', fetchImpl: vi.fn() })).rejects.toMatchObject({ code: 'missing_key' });
  });
});
