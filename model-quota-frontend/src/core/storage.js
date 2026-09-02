import { defaultSettings } from './status.js';

const STORAGE_KEYS = {
  providers: 'mqc.providers',
  logs: 'mqc.logs',
  settings: 'mqc.settings',
};

// 内存存储实现：测试环境注入使用，也在 localStorage 不可用时兜底。
export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function safeStorage() {
  try {
    const probe = '__mqc_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return memoryStorage();
  }
}

export function newId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 表单输入 → 统一的供应商配置结构
export function normalizeProviderConfig(input) {
  return {
    id: input.id || newId(),
    name: String(input.name || '').trim(),
    type: input.type || 'custom',
    apiKey: String(input.apiKey || '').trim(),
    // 双凭证类型（如火山方舟 IAM）的第二凭证：Secret Access Key
    apiSecret: String(input.apiSecret || '').trim(),
    baseUrl: String(input.baseUrl || '').trim(),
    planTotalQuota: toNumberOrNull(input.planTotalQuota),
    usedQuota: toNumberOrNull(input.usedQuota),
    remainingQuota: toNumberOrNull(input.remainingQuota),
    expiryDate: input.expiryDate ? String(input.expiryDate).slice(0, 10) : null,
    note: String(input.note || '').trim(),
    enabled: input.enabled !== false,
    lastQuery: input.lastQuery || null,
  };
}

export function createRepository(storage = safeStorage()) {
  function read(key, fallback) {
    try {
      const raw = storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : fallback;
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    storage.setItem(key, JSON.stringify(value));
  }

  return {
    listProviders: () => read(STORAGE_KEYS.providers, []),

    getProvider: (id) => read(STORAGE_KEYS.providers, []).find((p) => p.id === id) || null,

    saveProvider(config) {
      const list = read(STORAGE_KEYS.providers, []);
      const idx = list.findIndex((p) => p.id === config.id);
      if (idx >= 0) list[idx] = config;
      else list.push(config);
      write(STORAGE_KEYS.providers, list);
      return config;
    },

    deleteProvider(id) {
      const list = read(STORAGE_KEYS.providers, []).filter((p) => p.id !== id);
      write(STORAGE_KEYS.providers, list);
    },

    // 批量覆盖（备份导入用）
    saveProviders(list) {
      write(STORAGE_KEYS.providers, Array.isArray(list) ? list : []);
      return list;
    },

    // 清空全部业务数据（主题等应用级偏好保留）
    clearAll() {
      write(STORAGE_KEYS.providers, []);
      write(STORAGE_KEYS.logs, []);
      write(STORAGE_KEYS.settings, {});
    },

    listLogs: () => read(STORAGE_KEYS.logs, []),

    saveLogs(logs) {
      write(STORAGE_KEYS.logs, logs);
    },

    loadSettings: () => ({ ...defaultSettings(), ...read(STORAGE_KEYS.settings, {}) }),

    saveSettings(settings) {
      write(STORAGE_KEYS.settings, settings);
    },
  };
}
