import { getProviderType } from './providers.js';

// 卡片整体健康度（决定颜色）：ok 绿 / warn 橙 / error 红 / neutral 灰
export const STATUS_LABELS = {
  ok: '正常',
  warn: '注意',
  error: '异常',
  neutral: '提示',
};

// “查询状态”字段（对应需求第 5 条）
export const QUERY_STATUS_LABELS = {
  ok: '查询成功',
  failed: '查询失败',
  unsupported: '不支持自动查询',
  paused: '已停用',
  none: '未查询',
};

export function defaultSettings() {
  return {
    lowBalanceThreshold: 10, // 余额（元）低于该值提醒
    lowRemainingPercent: 10, // 剩余额度占总额度百分比低于该值提醒
    expiryWarningDays: 7, // 到期前 N 天提醒
    autoRefreshMinutes: 0, // 定时刷新间隔（分钟），0 = 关闭
    alertPopup: false, // 低额度弹窗提醒：刷新后检测到新的告警时弹窗提示
  };
}

// 弹窗提醒用的告警集合：warn/error 级（余额/额度/到期/查询失败），不含停用与「不支持自动查询」
export function collectAlerts(list, settings = defaultSettings()) {
  return list
    .filter((p) => p.enabled !== false)
    .map((p) => ({ p, health: evaluateProvider(p, settings) }))
    .filter(({ health }) => health.level === 'warn' || health.level === 'error')
    .map(({ p, health }) => ({
      id: p.id,
      name: p.name,
      level: health.level,
      label: health.label,
      reasons: health.reasons,
    }));
}

// 计算距离到期日还有几个自然日（当天到期算 0，已过期为负数）
export function daysUntil(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const target = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((startOfDay(target) - startOfDay(now)) / 86400000);
}

// 剩余额度：优先使用手动填写的值；否则在总额度和已用额度都填写时自动相减。
export function remainingQuotaOf(config) {
  if (config.remainingQuota != null) return Number(config.remainingQuota);
  if (config.planTotalQuota != null && config.usedQuota != null) {
    return Number(config.planTotalQuota) - Number(config.usedQuota);
  }
  return null;
}

// 需求第 7 条：用颜色提示异常情况（查询失败 / 余额过低 / 剩余额度过低 / 即将到期 / 已到期）。
export function evaluateProvider(config, settings = defaultSettings()) {
  const s = { ...defaultSettings(), ...settings };

  if (config.enabled === false) {
    return { level: 'neutral', label: '已停用', reasons: ['该供应商已停用，不参与一键与定时刷新'] };
  }

  const errors = [];
  const warnings = [];
  const last = config.lastQuery || null;

  if (last && last.status === 'failed') {
    errors.push(`查询失败：${last.error || '未知错误'}`);
  }

  const days = daysUntil(config.expiryDate);
  if (days != null) {
    if (days < 0) errors.push(`已于 ${config.expiryDate} 到期`);
    else if (days <= s.expiryWarningDays) warnings.push(`${days} 天后到期（${config.expiryDate}）`);
  }

  if (last && last.status === 'ok' && last.balance != null && last.balance <= s.lowBalanceThreshold) {
    warnings.push(`余额过低（${last.balance}）`);
  }
  if (last && last.status === 'ok' && last.isAvailable === false) {
    warnings.push('官方接口标记该账号当前不可用（is_available=false）');
  }

  // Coding Plan 类套餐：按用量百分比提醒（用量 ≥ 100 − 剩余额度阈值 视为剩余不足）
  const usage = last && last.status === 'ok' ? last.usage : null;
  if (usage) {
    const usageThreshold = 100 - s.lowRemainingPercent;
    if (usage.windowUsedPercent != null && usage.windowUsedPercent >= usageThreshold) {
      warnings.push(`近 5 小时套餐用量已达 ${usage.windowUsedPercent}%`);
    }
    if (usage.weeklyUsedPercent != null && usage.weeklyUsedPercent >= usageThreshold) {
      warnings.push(`本周套餐用量已达 ${usage.weeklyUsedPercent}%`);
    }
  }

  const remaining = remainingQuotaOf(config);
  const total = Number(config.planTotalQuota);
  if (remaining != null && Number.isFinite(total) && total > 0) {
    const pct = (remaining / total) * 100;
    if (pct <= s.lowRemainingPercent) {
      warnings.push(`剩余额度过低（约 ${Math.max(0, Math.round(pct))}%）`);
    }
  }

  if (errors.length) return { level: 'error', label: '异常', reasons: [...errors, ...warnings] };
  if (warnings.length) return { level: 'warn', label: '注意', reasons: warnings };
  if (!getProviderType(config.type).autoQuery) {
    return { level: 'neutral', label: '不支持自动查询', reasons: ['该供应商无公开的官方余额查询 API，额度为手动维护'] };
  }
  return { level: 'ok', label: '正常', reasons: [] };
}

// 列表展示排序：异常 > 提醒 > 正常 > 中性（停用/手动），同级保持原顺序
export function sortProviders(list, settings = defaultSettings()) {
  const rank = { error: 0, warn: 1, ok: 2, neutral: 3 };
  return [...list].sort(
    (a, b) => rank[evaluateProvider(a, settings).level] - rank[evaluateProvider(b, settings).level],
  );
}

// 列表筛选：query 匹配名称/备注/类型标签；status 支持 all/attention/ok/warn/error/neutral/disabled
export function filterProviders(list, settings = defaultSettings(), { query = '', status = 'all' } = {}) {
  const q = String(query).trim().toLowerCase();
  return list.filter((p) => {
    if (q) {
      const haystack = `${p.name} ${p.note || ''} ${getProviderType(p.type).label}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (status === 'all') return true;
    if (status === 'disabled') return p.enabled === false;
    const level = evaluateProvider(p, settings).level;
    if (status === 'attention') return level === 'warn' || level === 'error';
    return level === status;
  });
}
