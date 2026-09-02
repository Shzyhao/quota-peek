import { describe, it, expect, vi } from 'vitest';
import { queryDeepSeekBalance, DEEPSEEK_DEFAULT_BASE_URL } from '../src/core/deepseek.js';

const okBody = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
};

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('queryDeepSeekBalance', () => {
  it('成功时归一化官方返回字段', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    const result = await queryDeepSeekBalance({ apiKey: 'sk-test-key', fetchImpl });

    expect(result).toEqual({
      status: 'ok',
      balance: 110,
      currency: 'CNY',
      grantedBalance: 10,
      toppedUpBalance: 100,
      isAvailable: true,
    });
  });

  it('使用官方默认地址并携带 Bearer 鉴权头，URL 中不出现密钥', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    await queryDeepSeekBalance({ apiKey: 'sk-test-key', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${DEEPSEEK_DEFAULT_BASE_URL}/user/balance`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer sk-test-key');
    expect(url).not.toContain('sk-test-key');
  });

  it('自定义 baseUrl 末尾斜杠会被规范化', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(okBody));
    await queryDeepSeekBalance({ apiKey: 'sk-test-key', baseUrl: 'https://api.deepseek.com/', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.deepseek.com/user/balance');
  });

  it('401 时抛出鉴权错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ error: { message: 'Authentication Fails' } }, 401));
    await expect(queryDeepSeekBalance({ apiKey: 'sk-bad', fetchImpl })).rejects.toMatchObject({
      code: 'auth',
      message: expect.stringContaining('API Key 无效'),
    });
  });

  it('其他非 2xx 状态抛出 HTTP 错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({}, 500));
    await expect(queryDeepSeekBalance({ apiKey: 'sk-x', fetchImpl })).rejects.toMatchObject({ code: 'http' });
  });

  it('网络异常转换为网络错误', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(queryDeepSeekBalance({ apiKey: 'sk-x', fetchImpl })).rejects.toMatchObject({ code: 'network' });
  });

  it('返回体缺少余额信息时抛出解析错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ is_available: true, balance_infos: [] }));
    await expect(queryDeepSeekBalance({ apiKey: 'sk-x', fetchImpl })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('返回体不是 JSON 时抛出解析错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    await expect(queryDeepSeekBalance({ apiKey: 'sk-x', fetchImpl })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('未配置 API Key 时不发起请求', async () => {
    const fetchImpl = vi.fn();
    await expect(queryDeepSeekBalance({ apiKey: '', fetchImpl })).rejects.toMatchObject({ code: 'missing_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
