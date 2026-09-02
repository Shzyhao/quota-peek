import { describe, it, expect } from 'vitest';
import { createRepository, memoryStorage, normalizeProviderConfig } from '../src/core/storage.js';
import { createLogger, MAX_LOG_ENTRIES } from '../src/core/logger.js';

function setup() {
  const repo = createRepository(memoryStorage());
  return { repo, logger: createLogger(repo) };
}

describe('createLogger', () => {
  it('记录一次查询：包含供应商、时间、状态、余额、剩余额度', () => {
    const { repo, logger } = setup();
    const record = logger.add({
      providerId: 'p1',
      providerName: 'DeepSeek 主账号',
      time: '2026-09-01T10:00:00.000Z',
      status: 'ok',
      balance: 110,
      remainingQuota: 210,
      error: null,
    });

    expect(repo.listLogs()).toEqual([record]);
    expect(record.providerName).toBe('DeepSeek 主账号');
    expect(record.status).toBe('ok');
    expect(record.balance).toBe(110);
    expect(record.remainingQuota).toBe(210);
  });

  it('日志结构中不存在 API Key 字段，错误信息写入前脱敏', () => {
    const { logger } = setup();
    const record = logger.add(
      {
        providerId: 'p1',
        providerName: 'DS',
        status: 'failed',
        balance: null,
        remainingQuota: null,
        error: '请求失败，key=sk-abcdefgh12345678 被拒绝',
      },
      ['sk-abcdefgh12345678'],
    );

    expect(Object.keys(record)).not.toContain('apiKey');
    expect(record.error).not.toContain('sk-abcdefgh12345678');
    expect(record.error).toContain('***');
  });

  it('最新日志排在最前，且最多保留 MAX_LOG_ENTRIES 条', () => {
    const { logger } = setup();
    for (let i = 0; i < MAX_LOG_ENTRIES + 20; i++) {
      logger.add({ providerId: `p${i}`, providerName: `P${i}`, status: 'ok', balance: i, time: new Date(2026, 0, 1, 0, 0, i).toISOString() });
    }
    const logs = logger.list();
    expect(logs).toHaveLength(MAX_LOG_ENTRIES);
    expect(logs[0].providerName).toBe(`P${MAX_LOG_ENTRIES + 19}`);
  });

  it('clear 清空日志', () => {
    const { logger } = setup();
    logger.add({ providerId: 'p1', providerName: 'A', status: 'ok' });
    expect(logger.list()).toHaveLength(1);
    logger.clear();
    expect(logger.list()).toEqual([]);
  });
});

describe('normalizeProviderConfig 与日志联动', () => {
  it('未填写剩余额度时服务层可用总额度-已用推导（数据链路冒烟）', () => {
    const { repo, logger } = setup();
    const cfg = normalizeProviderConfig({ name: 'DS', type: 'deepseek', planTotalQuota: '300', usedQuota: '90' });
    repo.saveProvider(cfg);
    logger.add({ providerId: cfg.id, providerName: cfg.name, status: 'ok', balance: 110, remainingQuota: 210 });
    const log = logger.list()[0];
    expect(log.remainingQuota).toBe(210);
  });
});
