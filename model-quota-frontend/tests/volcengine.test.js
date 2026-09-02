import { describe, it, expect, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { queryVolcengineCodingPlan, VOLCENGINE_DEFAULT_BASE_URL } from '../src/core/volcengine.js';

const FIXED_NOW = () => new Date('2026-09-02T12:00:00Z');

const AK = 'AKLTtest-0000000001';
const SK = 'sk-volc-secret-0000000002';

function res(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

const codingPlanBody = {
  Result: {
    Status: 'Normal',
    UpdateTimestamp: 1756848000,
    QuotaUsage: [
      { Level: 'session', Percent: 32.5, ResetTimestamp: 1756848000 },
      { Level: 'weekly', Percent: 45, ResetTimestamp: 1757366400 },
      { Level: 'monthly', Percent: 10, ResetTimestamp: 1759262400 },
    ],
  },
};

const agentPlanBody = {
  Result: {
    AFPFiveHour: { Quota: 1000, Used: 300, ResetTime: 1756848000000 },
    AFPWeekly: { Quota: 10000, Used: 5000, ResetTime: 1757366400000 },
    AFPMonthly: { Quota: 40000, Used: 8000, ResetTime: 1759262400000 },
  },
};

describe('queryVolcengineCodingPlan · SigV4 签名', () => {
  it('签名与官方参考实现（Node crypto 对拍）完全一致，URL 与请求头正确', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(codingPlanBody));
    await queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl, now: FIXED_NOW });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${VOLCENGINE_DEFAULT_BASE_URL}/?Action=GetCodingPlanUsage&Version=2024-01-01`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-date']).toBe('20260902T120000Z');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=utf-8');

    // 用与火山官方 SDK 相同的参考算法（Node crypto）重算签名，对拍浏览器端实现
    const sha256Hex = (d) => createHash('sha256').update(d, 'utf8').digest('hex');
    const hmacBytes = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest();
    const timestamp = '20260902T120000Z';
    const dateStamp = '20260902';
    const payloadHash = sha256Hex('');
    const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
    const host = 'open.volcengineapi.com';
    const query = 'Action=GetCodingPlanUsage&Version=2024-01-01';
    const canonicalRequest = [
      'POST', '/', query,
      `content-type:${contentType}`,
      `host:${host}`,
      `x-content-sha256:${payloadHash}`,
      `x-date:${timestamp}`,
      '',
      'content-type;host;x-content-sha256;x-date',
      payloadHash,
    ].join('\n');
    const credentialScope = `${dateStamp}/cn-beijing/ark/request`;
    const stringToSign = ['HMAC-SHA256', timestamp, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const kDate = hmacBytes(SK, dateStamp);
    const kRegion = hmacBytes(kDate, 'cn-beijing');
    const kService = hmacBytes(kRegion, 'ark');
    const kSigning = hmacBytes(kService, 'request');
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    const expected =
      `HMAC-SHA256 Credential=${AK}/${credentialScope}, ` +
      'SignedHeaders=content-type;host;x-content-sha256;x-date, ' +
      `Signature=${signature}`;

    expect(init.headers.authorization).toBe(expected);
    // SK 不出现在 URL 中
    expect(url).not.toContain(SK);
  });
});

describe('queryVolcengineCodingPlan · Coding Plan 解析', () => {
  it('session/weekly/monthly 百分比与重置时间正确映射', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(codingPlanBody));
    const r = await queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl, now: FIXED_NOW });

    expect(r.status).toBe('ok');
    expect(r.balance).toBeNull();
    expect(r.extraLine).toBe('套餐：Coding Plan');
    expect(r.usage).toMatchObject({
      windowUsedPercent: 32.5, // session → 近 5 小时窗口
      weeklyUsedPercent: 45,
      monthlyUsedPercent: 10,
      windowUsed: null,
      weeklyTotal: null,
      windowResetAt: new Date(1756848000000).toISOString(),
      weeklyResetAt: new Date(1757366400000).toISOString(),
    });
  });

  it('百分比超过 100 时截断为 100', async () => {
    const body = { Result: { QuotaUsage: [{ Level: 'session', Percent: 130 }] } };
    const fetchImpl = vi.fn().mockResolvedValue(res(body));
    const r = await queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl, now: FIXED_NOW });
    expect(r.usage.windowUsedPercent).toBe(100);
  });
});

describe('queryVolcengineCodingPlan · Agent Plan 回退', () => {
  it('Coding Plan 无数据时自动回退 GetAFPUsage，按 Quota/Used 计算百分比', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res({ Result: { QuotaUsage: [] } })) // Coding Plan 空
      .mockResolvedValueOnce(res(agentPlanBody));
    const r = await queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl, now: FIXED_NOW });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain('Action=GetAFPUsage');
    expect(r.extraLine).toBe('套餐：Agent Plan');
    expect(r.usage).toMatchObject({
      windowUsedPercent: 30, // 300/1000
      weeklyUsedPercent: 50, // 5000/10000
      monthlyUsedPercent: 20, // 8000/40000
      windowResetAt: new Date(1756848000000).toISOString(),
    });
  });

  it('两个接口都无数据 → 解析错误并提示可能原因', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res({ Result: {} }))
      .mockResolvedValueOnce(res({ Result: {} }));
    await expect(
      queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'bad_response', message: expect.stringContaining('未订阅') });
  });
});

describe('queryVolcengineCodingPlan · 错误处理', () => {
  it('ResponseMetadata.Error 且 Code 含 Signature → 鉴权错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res({ ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: 'signature mismatch' } } }),
    );
    await expect(
      queryVolcengineCodingPlan({ apiKey: AK, apiSecret: 'wrong-sk', fetchImpl, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'auth', message: expect.stringContaining('SignatureDoesNotMatch') });
  });

  it('其他 OpenAPI 错误 → http 错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res({ ResponseMetadata: { Error: { Code: 'InternalError', Message: 'boom' } } }),
    );
    await expect(
      queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'http' });
  });

  it('非 200 且无错误体 → http 错误；网络异常 → 网络错误', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(null, 503));
    await expect(
      queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'http' });

    const network = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      queryVolcengineCodingPlan({ apiKey: AK, apiSecret: SK, fetchImpl: network, now: FIXED_NOW }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('缺少 AK 或 SK 时不发起请求', async () => {
    const fetchImpl = vi.fn();
    await expect(queryVolcengineCodingPlan({ apiKey: '', apiSecret: SK, fetchImpl })).rejects.toMatchObject({ code: 'missing_key' });
    await expect(queryVolcengineCodingPlan({ apiKey: AK, apiSecret: '', fetchImpl })).rejects.toMatchObject({ code: 'missing_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
