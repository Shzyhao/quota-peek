import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRepository, memoryStorage, normalizeProviderConfig } from '../src/core/storage.js';
import { readSecret, writeSecret, deleteSecret, secretsAvailable, migrateSecretsToKeyring } from '../src/core/secrets.js';

// 桌面壳 __TAURI__.core.invoke 桩：记录调用并按命令回放
function stubTauri() {
  const calls = [];
  const store = new Map();
  globalThis.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd, args) => {
        calls.push([cmd, args]);
        const key = `quota_key:${args?.providerId}`;
        if (cmd === 'quota_secret_set') {
          store.set(key, JSON.stringify({ apiKey: args.apiKey, apiSecret: args.apiSecret }));
          return null;
        }
        if (cmd === 'quota_secret_get') {
          const raw = store.get(key);
          return raw ? JSON.parse(raw) : null;
        }
        if (cmd === 'quota_secret_has') return store.has(key);
        if (cmd === 'quota_secret_delete') {
          store.delete(key);
          return null;
        }
        throw new Error(`未知命令 ${cmd}`);
      }),
    },
  };
  return { calls, store };
}

afterEach(() => {
  delete globalThis.__TAURI__;
  vi.restoreAllMocks();
});

describe('secrets（额度密钥凭据管理器）', () => {
  it('浏览器版（无 __TAURI__）：secretsAvailable=false，写读抛错，迁移为空操作', async () => {
    expect(secretsAvailable()).toBe(false);
    await expect(readSecret('p1')).rejects.toThrow();
    await expect(writeSecret('p1', { apiKey: 'k' })).rejects.toThrow();
    const repo = createRepository(memoryStorage());
    expect(await migrateSecretsToKeyring(repo)).toBe(0);
  });

  it('write/read/delete：一条存齐 apiKey+apiSecret，读取归一化', async () => {
    stubTauri();
    await writeSecret('prov-1', { apiKey: 'sk-a', apiSecret: 'sec-b' });
    expect(await readSecret('prov-1')).toEqual({ apiKey: 'sk-a', apiSecret: 'sec-b' });
    // 缺省字段归一为空串
    await writeSecret('prov-2', { apiKey: 'sk-c' });
    expect(await readSecret('prov-2')).toEqual({ apiKey: 'sk-c', apiSecret: '' });
    await deleteSecret('prov-1');
    expect(await readSecret('prov-1')).toBeNull();
  });

  it('迁移：明文密钥搬进凭据管理器并抹掉本地明文、标记 hasSecret', async () => {
    const { calls } = stubTauri();
    const repo = createRepository(memoryStorage());
    repo.saveProvider(normalizeProviderConfig({ name: 'A', type: 'deepseek', apiKey: 'sk-aaa-1111' }));
    repo.saveProvider(normalizeProviderConfig({ name: 'B', type: 'volcengine', apiKey: 'ak-b', apiSecret: 'sk-b-secret' }));
    repo.saveProvider(normalizeProviderConfig({ name: 'C', type: 'custom', apiKey: '' }));

    const moved = await migrateSecretsToKeyring(repo);

    expect(moved).toBe(2);
    // 凭据管理器收到两对密钥
    const sets = calls.filter(([cmd]) => cmd === 'quota_secret_set');
    expect(sets).toHaveLength(2);
    // 本地记录：明文清空 + hasSecret 标记；无密钥的 C 原样保留
    const [a, b, c] = repo.listProviders();
    expect(a.hasSecret).toBe(true);
    expect(a.apiKey).toBe('');
    expect(b.hasSecret).toBe(true);
    expect(b.apiKey).toBe('');
    expect(b.apiSecret).toBe('');
    expect(c.hasSecret).toBe(false);
    // 再跑一次：无明文可迁
    expect(await migrateSecretsToKeyring(repo)).toBe(0);
  });

  it('迁移：凭据管理器写入失败时保留明文原样（下次重试）', async () => {
    globalThis.__TAURI__ = { core: { invoke: vi.fn(async (_cmd, args) => {
      if (args?.providerId === 'fail-id') throw new Error('keyring 不可用');
      return null;
    }) } };
    const repo = createRepository(memoryStorage());
    const okOne = normalizeProviderConfig({ name: 'OK', type: 'deepseek', apiKey: 'sk-ok' });
    const badOne = normalizeProviderConfig({ id: 'fail-id', name: 'BAD', type: 'deepseek', apiKey: 'sk-bad' });
    repo.saveProvider(okOne);
    repo.saveProvider(badOne);

    expect(await migrateSecretsToKeyring(repo)).toBe(1);
    expect(repo.getProvider(okOne.id).hasSecret).toBe(true);
    expect(repo.getProvider('fail-id').apiKey).toBe('sk-bad');
    expect(repo.getProvider('fail-id').hasSecret).toBe(false);
  });

  it('normalizeProviderConfig 保留 hasSecret 标记（备份导入路径）', () => {
    const cfg = normalizeProviderConfig({ name: 'X', type: 'deepseek', hasSecret: true });
    expect(cfg.hasSecret).toBe(true);
    expect(normalizeProviderConfig({ name: 'Y', type: 'deepseek' }).hasSecret).toBe(false);
  });
});
