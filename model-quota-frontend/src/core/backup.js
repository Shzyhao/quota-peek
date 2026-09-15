import { normalizeProviderConfig } from './storage.js';
import { normalizeScheduleItem } from './schedule.js';
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
    // v0.10.0 起纳入日程；旧版备份无此字段，导入安全降级为不覆盖
    schedules: repo.listSchedules(),
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
  // 结构非法的日程条目丢弃，其余归一化后写入
  const schedules = (Array.isArray(backup.schedules) ? backup.schedules : [])
    .map((s) => normalizeScheduleItem(s))
    .filter((r) => r.ok)
    .map((r) => r.item);
  repo.saveSchedules(schedules);
  return { providers: providers.length, logs: Array.isArray(backup.logs) ? backup.logs.length : 0, schedules: schedules.length };
}
