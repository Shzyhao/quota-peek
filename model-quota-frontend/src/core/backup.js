import { normalizeProviderConfig } from './storage.js';
import { defaultSettings } from './status.js';

// 备份导入/导出：纯前端的数据迁移能力（localStorage 无法多人共享，用 JSON 文件备份）。
// 注意：备份文件包含 API Key 明文（这是备份的意义），UI 中必须提示用户妥善保管。

const BACKUP_APP_ID = 'model-quota-frontend';
const BACKUP_VERSION = 1;

export function buildBackup(repo) {
  return {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    providers: repo.listProviders(),
    logs: repo.listLogs(),
    settings: repo.loadSettings(),
  };
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是有效的 JSON 文件' };
  }
  if (!data || typeof data !== 'object' || data.app !== BACKUP_APP_ID || !Array.isArray(data.providers)) {
    return { ok: false, error: '文件格式不符合备份结构' };
  }
  return { ok: true, backup: data };
}

// 覆盖式导入：校验通过的备份整体替换当前数据（UI 层负责在导入前弹确认框）
export function applyBackup(repo, backup) {
  const providers = backup.providers.map(normalizeProviderConfig);
  repo.saveProviders(providers);
  repo.saveLogs(Array.isArray(backup.logs) ? backup.logs : []);
  repo.saveSettings({ ...defaultSettings(), ...(backup.settings || {}) });
  return { providers: providers.length, logs: Array.isArray(backup.logs) ? backup.logs.length : 0 };
}
