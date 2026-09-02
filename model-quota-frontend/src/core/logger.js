import { sanitizeText } from './mask.js';

// 需求第 8 条：记录最近查询日志，最多保留 MAX_LOG_ENTRIES 条。
// 日志结构中不包含 API Key 字段；错误信息写入前统一脱敏。
export const MAX_LOG_ENTRIES = 100;

export function createLogger(repo) {
  function add(entry, secrets = []) {
    const record = {
      id: entry.id || `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      providerId: entry.providerId || null,
      providerName: entry.providerName || '(未知供应商)',
      time: entry.time || new Date().toISOString(),
      status: entry.status || 'unknown',
      balance: entry.balance ?? null,
      remainingQuota: entry.remainingQuota ?? null,
      error: entry.error ? sanitizeText(entry.error, secrets) : null,
    };
    repo.saveLogs([record, ...repo.listLogs()].slice(0, MAX_LOG_ENTRIES));
    return record;
  }

  return {
    add,
    list: () => repo.listLogs(),
    clear: () => repo.saveLogs([]),
  };
}
