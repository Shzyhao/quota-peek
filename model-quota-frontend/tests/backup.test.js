import { describe, it, expect } from 'vitest';
import { createRepository, memoryStorage, normalizeProviderConfig } from '../src/core/storage.js';
import { createLogger } from '../src/core/logger.js';
import { buildBackup, parseBackup, applyBackup } from '../src/core/backup.js';

function repoWithData() {
  const repo = createRepository(memoryStorage());
  repo.saveProvider(
    normalizeProviderConfig({ name: 'DeepSeek', type: 'deepseek', apiKey: 'sk-backup-key', planTotalQuota: '300' }),
  );
  repo.saveLogs([{ id: 'l1', providerName: 'DeepSeek', time: '2026-09-02T10:00:00.000Z', status: 'ok', balance: 110, remainingQuota: 210, error: null }]);
  repo.saveSettings({ ...repo.loadSettings(), lowBalanceThreshold: 20 });
  return repo;
}

describe('buildBackup', () => {
  it('导出完整的备份结构', () => {
    const repo = repoWithData();
    const backup = buildBackup(repo);

    expect(backup.app).toBe('model-quota-frontend');
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBeTruthy();
    expect(backup.providers).toHaveLength(1);
    expect(backup.providers[0].apiKey).toBe('sk-backup-key'); // 备份文件需要可恢复，保留密钥
    expect(backup.logs).toHaveLength(1);
    expect(backup.settings.lowBalanceThreshold).toBe(20);
  });
});

describe('parseBackup', () => {
  it('合法 JSON 且结构匹配 → ok', () => {
    const backup = buildBackup(repoWithData());
    const parsed = parseBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(true);
    expect(parsed.backup.providers).toHaveLength(1);
  });

  it('非法 JSON → 报错', () => {
    expect(parseBackup('{broken')).toMatchObject({ ok: false });
    expect(parseBackup('not json at all')).toMatchObject({ ok: false });
  });

  it('结构不匹配（非本应用备份）→ 报错', () => {
    expect(parseBackup('{"foo":1}')).toMatchObject({ ok: false });
    expect(parseBackup('{"app":"other-app","providers":[]}')).toMatchObject({ ok: false });
    expect(parseBackup('{"app":"model-quota-frontend","providers":"not-array"}')).toMatchObject({ ok: false });
  });
});

describe('applyBackup', () => {
  it('覆盖导入：供应商归一化、日志与设置写入', () => {
    const source = repoWithData();
    const backup = buildBackup(source);

    const target = createRepository(memoryStorage());
    target.saveProvider(normalizeProviderConfig({ name: '旧数据', type: 'custom' }));

    const result = applyBackup(target, backup);

    expect(result).toEqual({ providers: 1, logs: 1 });
    expect(target.listProviders().map((p) => p.name)).toEqual(['DeepSeek']);
    expect(target.getProvider(backup.providers[0].id).apiKey).toBe('sk-backup-key');
    expect(target.listLogs()).toHaveLength(1);
    expect(target.loadSettings().lowBalanceThreshold).toBe(20);
    expect(target.loadSettings().autoRefreshMinutes).toBe(0); // 缺省字段由默认值补齐
  });

  it('缺少 logs/settings 字段时安全降级', () => {
    const target = createRepository(memoryStorage());
    applyBackup(target, {
      app: 'model-quota-frontend',
      version: 1,
      providers: [{ id: 'x1', name: 'A', type: 'custom' }],
    });
    expect(target.listProviders()).toHaveLength(1);
    expect(target.listLogs()).toEqual([]);
    expect(target.loadSettings().lowBalanceThreshold).toBe(10);
  });
});

describe('repository 批量与清空', () => {
  it('saveProviders 整体覆盖，clearAll 清空业务数据', () => {
    const repo = repoWithData();
    repo.saveProviders([]);
    expect(repo.listProviders()).toEqual([]);

    const repo2 = repoWithData();
    repo2.clearAll();
    expect(repo2.listProviders()).toEqual([]);
    expect(repo2.listLogs()).toEqual([]);
    expect(repo2.loadSettings()).toMatchObject({ lowBalanceThreshold: 10 }); // 回到默认
  });
});

describe('备份与日志脱敏约定', () => {
  it('导入后的日志继续满足“无密钥字段”约束', () => {
    const repo = createRepository(memoryStorage());
    applyBackup(repo, {
      app: 'model-quota-frontend',
      version: 1,
      providers: [],
      logs: [{ id: 'l1', providerName: 'X', status: 'ok', time: '2026-09-02T00:00:00.000Z' }],
    });
    const logger = createLogger(repo);
    expect(Object.keys(logger.list()[0])).not.toContain('apiKey');
  });
});
