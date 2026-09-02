import { describe, it, expect, vi } from 'vitest';
import { createRepository, memoryStorage, normalizeProviderConfig } from '../src/core/storage.js';
import { createLogger } from '../src/core/logger.js';
import { createQuotaService } from '../src/core/service.js';

const okBody = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
};

const okResponse = () => ({ ok: true, status: 200, json: async () => okBody });

function setup(fetchImpl) {
  const repo = createRepository(memoryStorage());
  const logger = createLogger(repo);
  const service = createQuotaService({ repo, logger, fetchImpl });
  return { repo, logger, service };
}

function deepseekProvider(overrides = {}) {
  return normalizeProviderConfig({
    name: 'DeepSeek 主账号',
    type: 'deepseek',
    apiKey: 'sk-test-1234567890',
    baseUrl: 'https://api.deepseek.com',
    planTotalQuota: '300',
    usedQuota: '90',
    ...overrides,
  });
}

describe('createQuotaService.refreshProvider', () => {
  it('DeepSeek 查询成功：更新 lastQuery 并写入成功日志', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const { repo, logger, service } = setup(fetchImpl);
    const cfg = repo.saveProvider(deepseekProvider());

    const updated = await service.refreshProvider(cfg.id);

    expect(updated.lastQuery.status).toBe('ok');
    expect(updated.lastQuery.balance).toBe(110);
    expect(updated.lastQuery.currency).toBe('CNY');
    expect(repo.getProvider(cfg.id).lastQuery.balance).toBe(110);

    const logs = logger.list();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      providerName: 'DeepSeek 主账号',
      status: 'ok',
      balance: 110,
      remainingQuota: 210, // 300 - 90 自动推导
      error: null,
    });
  });

  it('查询失败：记录错误信息且日志不含 API Key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const { repo, logger, service } = setup(fetchImpl);
    const cfg = repo.saveProvider(deepseekProvider());

    const updated = await service.refreshProvider(cfg.id);

    expect(updated.lastQuery.status).toBe('failed');
    expect(updated.lastQuery.error).toContain('API Key 无效');
    expect(updated.lastQuery.balance).toBeNull();

    const log = logger.list()[0];
    expect(log.status).toBe('failed');
    expect(log.error).toContain('API Key 无效');
    expect(JSON.stringify(logger.list())).not.toContain('sk-test-1234567890');
  });

  it('不支持自动查询的类型：标记 unsupported，不发起请求也不写日志', async () => {
    const fetchImpl = vi.fn();
    const { repo, logger, service } = setup(fetchImpl);
    const cfg = repo.saveProvider(deepseekProvider({ type: 'custom', apiKey: '' }));

    const updated = await service.refreshProvider(cfg.id);

    expect(updated.lastQuery.status).toBe('unsupported');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.list()).toHaveLength(0);
  });

  it('供应商不存在时返回 null', async () => {
    const { service } = setup(vi.fn());
    expect(await service.refreshProvider('no-such-id')).toBeNull();
  });
});

describe('createQuotaService.refreshAll', () => {
  it('刷新所有启用的供应商，跳过已停用的', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const { repo, logger, service } = setup(fetchImpl);
    const on = repo.saveProvider(deepseekProvider({ name: '启用中' }));
    const off = repo.saveProvider(deepseekProvider({ name: '已停用', enabled: false }));

    const results = await service.refreshAll();

    expect(results.map((p) => p.id).sort()).toEqual([on.id].sort());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(repo.getProvider(off.id).lastQuery).toBeNull();
    expect(logger.list()).toHaveLength(1);
  });

  it('部分供应商失败不影响其他供应商刷新', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url, init) =>
      init.headers.Authorization.includes('key-a')
        ? Promise.resolve(okResponse())
        : Promise.reject(new TypeError('Failed to fetch')),
    );
    const { repo, service } = setup(fetchImpl);
    const good = repo.saveProvider(deepseekProvider({ apiKey: 'key-a-0000000001' }));
    const bad = repo.saveProvider(deepseekProvider({ name: '坏网络', apiKey: 'key-b-0000000002' }));

    const results = await service.refreshAll();

    const byId = Object.fromEntries(results.map((p) => [p.id, p]));
    expect(byId[good.id].lastQuery.status).toBe('ok');
    expect(byId[bad.id].lastQuery.status).toBe('failed');
  });

  it('未配置 API Key 的 DeepSeek 也会记录失败原因', async () => {
    const fetchImpl = vi.fn();
    const { repo, logger, service } = setup(fetchImpl);
    const cfg = repo.saveProvider(deepseekProvider({ apiKey: '' }));

    const updated = await service.refreshProvider(cfg.id);

    expect(updated.lastQuery.status).toBe('failed');
    expect(updated.lastQuery.error).toContain('API Key');
    expect(logger.list()[0].status).toBe('failed');
  });
});

describe('Coding Plan 供应商刷新（智谱 / MiniMax）', () => {
  const zhipuOkBody = {
    success: true,
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, usage: 100000, currentValue: 32500, percentage: 32.5 },
        { type: 'TOKENS_LIMIT', unit: 6, usage: 500000, currentValue: 100000, percentage: 20 },
        { type: 'TIME_LIMIT', unit: 0, usage: 100, currentValue: 24, percentage: 24 },
      ],
    },
  };

  it('智谱供应商：lastQuery 带用量百分比与额度数值，日志正常记录', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => zhipuOkBody });
    const repo = createRepository(memoryStorage());
    const logger = createLogger(repo);
    const service = createQuotaService({ repo, logger, fetchImpl });
    const cfg = repo.saveProvider(
      normalizeProviderConfig({ name: '智谱 Coding', type: 'zhipu', apiKey: 'zp-key-123456', baseUrl: 'https://open.bigmodel.cn' }),
    );

    const updated = await service.refreshProvider(cfg.id);

    expect(updated.lastQuery.status).toBe('ok');
    expect(updated.lastQuery.usage).toMatchObject({
      windowUsedPercent: 32.5,
      weeklyUsedPercent: 20,
      monthlyUsedPercent: 24,
      weeklyUsed: 100000,
      weeklyTotal: 500000,
    });
    expect(updated.lastQuery.balance).toBeNull();

    const log = logger.list()[0];
    expect(log.status).toBe('ok');
    expect(log.providerName).toBe('智谱 Coding');
    expect(JSON.stringify(logger.list())).not.toContain('zp-key-123456');
  });

  it('火山方舟供应商：双凭证查询成功并记录，日志不含 SK', async () => {
    const volcBody = {
      Result: {
        Status: 'Normal',
        QuotaUsage: [
          { Level: 'session', Percent: 32.5, ResetTimestamp: 1756848000 },
          { Level: 'weekly', Percent: 45, ResetTimestamp: 1757366400 },
        ],
      },
    };
    const fetchImpl = vi.fn().mockImplementation((_url, init) => {
      // 验证请求确实携带 SigV4 签名头
      if (!init.headers.authorization || !init.headers['x-date']) {
        return Promise.reject(new TypeError('missing signature headers'));
      }
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(volcBody) });
    });
    const repo = createRepository(memoryStorage());
    const logger = createLogger(repo);
    const service = createQuotaService({ repo, logger, fetchImpl });
    const cfg = repo.saveProvider(
      normalizeProviderConfig({
        name: '火山方舟 Coding',
        type: 'volcengine',
        apiKey: 'AKLT-svc-test-0001',
        apiSecret: 'sk-volc-svc-secret-0002',
      }),
    );

    const updated = await service.refreshProvider(cfg.id);

    expect(updated.lastQuery.status).toBe('ok');
    expect(updated.lastQuery.usage.windowUsedPercent).toBe(32.5);
    expect(updated.lastQuery.usage.weeklyUsedPercent).toBe(45);
    expect(updated.lastQuery.extraLine).toBe('套餐：Coding Plan');
    expect(fetchImpl.mock.calls[0][0]).toContain('Action=GetCodingPlanUsage');

    const log = logger.list()[0];
    expect(log.status).toBe('ok');
    expect(JSON.stringify(logger.list())).not.toContain('sk-volc-svc-secret-0002');
  });

  it('MiniMax 供应商：openplatform 端点查询并记录', async () => {
    const minimaxBody = {
      model_remains: [
        {
          model_name: 'general',
          current_interval_remaining_percent: 60,
          current_interval_usage_count: 400,
          current_interval_total_count: 1000,
          current_interval_status: 1,
          end_time: 1756848000000,
          current_weekly_remaining_percent: 80,
          current_weekly_usage_count: 2000,
          current_weekly_total_count: 10000,
          current_weekly_status: 1,
          weekly_end_time: 1757366400000,
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(minimaxBody),
      json: async () => minimaxBody,
    });
    const repo = createRepository(memoryStorage());
    const logger = createLogger(repo);
    const service = createQuotaService({ repo, logger, fetchImpl });
    const cfg = repo.saveProvider(
      normalizeProviderConfig({ name: 'MiniMax 套餐', type: 'minimax', apiKey: 'mm-coding-key', baseUrl: 'https://api.minimaxi.com' }),
    );

    const updated = await service.refreshProvider(cfg.id);

    expect(updated.lastQuery.usage.windowUsedPercent).toBe(40);
    expect(updated.lastQuery.usage.weeklyUsedPercent).toBe(20);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains');
    expect(logger.list()[0].status).toBe('ok');
  });
});
