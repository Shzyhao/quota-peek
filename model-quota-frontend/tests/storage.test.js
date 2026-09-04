import { describe, it, expect } from 'vitest';
import {
  createRepository,
  memoryStorage,
  normalizeProviderConfig,
} from '../src/core/storage.js';

describe('normalizeProviderConfig', () => {
  it('表单字符串输入转换为规范结构', () => {
    const cfg = normalizeProviderConfig({
      name: '  DeepSeek 主账号  ',
      type: 'deepseek',
      apiKey: ' sk-abc ',
      baseUrl: 'https://api.deepseek.com',
      planTotalQuota: '200',
      usedQuota: '90',
      remainingQuota: '',
      expiryDate: '2026-12-31',
      note: ' 备注 ',
      enabled: true,
    });

    expect(cfg.name).toBe('DeepSeek 主账号');
    expect(cfg.apiKey).toBe('sk-abc');
    expect(cfg.planTotalQuota).toBe(200);
    expect(cfg.usedQuota).toBe(90);
    expect(cfg.remainingQuota).toBeNull();
    expect(cfg.expiryDate).toBe('2026-12-31');
    expect(cfg.note).toBe('备注');
    expect(cfg.enabled).toBe(true);
    expect(cfg.id).toBeTruthy();
  });

  it('非法数字与空日期归一为 null', () => {
    const cfg = normalizeProviderConfig({ name: 'x', planTotalQuota: 'abc', expiryDate: '' });
    expect(cfg.planTotalQuota).toBeNull();
    expect(cfg.expiryDate).toBeNull();
  });

  it('enabled 缺省为 true，显式 false 生效', () => {
    expect(normalizeProviderConfig({ name: 'a' }).enabled).toBe(true);
    expect(normalizeProviderConfig({ name: 'a', enabled: false }).enabled).toBe(false);
  });
});

describe('createRepository', () => {
  it('供应商增删改查', () => {
    const repo = createRepository(memoryStorage());
    expect(repo.listProviders()).toEqual([]);

    const a = normalizeProviderConfig({ name: 'A', type: 'deepseek', apiKey: 'sk-aaaa' });
    const b = normalizeProviderConfig({ name: 'B', type: 'custom' });
    repo.saveProvider(a);
    repo.saveProvider(b);
    expect(repo.listProviders().map((p) => p.name)).toEqual(['A', 'B']);

    repo.saveProvider({ ...a, name: 'A2' });
    expect(repo.listProviders()).toHaveLength(2);
    expect(repo.getProvider(a.id).name).toBe('A2');

    repo.deleteProvider(b.id);
    expect(repo.listProviders().map((p) => p.name)).toEqual(['A2']);
    expect(repo.getProvider(b.id)).toBeNull();
  });

  it('数据写入底层存储（JSON 序列化）', () => {
    const storage = memoryStorage();
    const repo = createRepository(storage);
    repo.saveProvider(normalizeProviderConfig({ name: 'A', apiKey: 'sk-secret' }));
    const raw = JSON.parse(storage.getItem('mqc.providers'));
    expect(raw).toHaveLength(1);
    expect(raw[0].name).toBe('A');
  });

  it('损坏的存储数据不会导致崩溃', () => {
    const storage = memoryStorage();
    storage.setItem('mqc.providers', '{broken json');
    const repo = createRepository(storage);
    expect(repo.listProviders()).toEqual([]);
  });

  it('设置读取时与默认值合并、保存后可回读；旧 alertPopup 自动迁移为 alertMethod', () => {
    const storage = memoryStorage();
    const repo = createRepository(storage);
    expect(repo.loadSettings()).toEqual({
      lowBalanceThreshold: 10,
      lowRemainingPercent: 10,
      expiryWarningDays: 7,
      autoRefreshMinutes: 0,
      alertMethod: 'popup',
    });

    storage.setItem('mqc.settings', JSON.stringify({ autoRefreshMinutes: 30 }));
    expect(repo.loadSettings().autoRefreshMinutes).toBe(30);
    expect(repo.loadSettings().lowBalanceThreshold).toBe(10);

    repo.saveSettings({ ...repo.loadSettings(), lowBalanceThreshold: 20 });
    expect(repo.loadSettings().lowBalanceThreshold).toBe(20);

    // 旧版 alertPopup(bool) 迁移：true → popup，false → 关闭
    storage.setItem('mqc.settings', JSON.stringify({ alertPopup: true }));
    expect(repo.loadSettings().alertMethod).toBe('popup');
    storage.setItem('mqc.settings', JSON.stringify({ alertPopup: false }));
    expect(repo.loadSettings().alertMethod).toBe('');
    // 已有 alertMethod 时以新值为准，alertPopup 不再参与
    storage.setItem('mqc.settings', JSON.stringify({ alertPopup: true, alertMethod: 'notify' }));
    expect(repo.loadSettings().alertMethod).toBe('notify');
  });

  it('日志保存与读取', () => {
    const repo = createRepository(memoryStorage());
    repo.saveLogs([{ id: 'l1', providerName: 'A', status: 'ok' }]);
    expect(repo.listLogs()).toHaveLength(1);
    repo.saveLogs([]);
    expect(repo.listLogs()).toEqual([]);
  });
});
