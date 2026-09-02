import { QuotaQueryError } from './errors.js';
import { normalizeBaseUrl as normalize } from './url.js';

// 智谱 GLM Coding Plan 用量查询。
// 接口与智谱官方开源插件 glm-plan-usage（zai-org/zai-coding-plugins）使用的完全一致：
//   GET {base}/api/monitor/usage/quota/limit
// 鉴权注意：Authorization 头使用裸 API Key（无 Bearer 前缀），与官方插件保持一致。
// 错误以 HTTP 200 + {"code":401,"msg":"...","success":false} 形式返回，必须检查响应体。
//
// limits[] 条目结构（字段名以官方/社区插件源码为准）：
//   type: "TOKENS_LIMIT"（Token 额度）| "TIME_LIMIT"（MCP 月度）
//   unit: 3 = 近 5 小时窗口，6 = 周额度（TIME_LIMIT 为 0）
//   usage: 总额度数值；currentValue: 已用数值；percentage: 已用百分比（0-100，可能超 100）
//   nextResetTime: 重置时间（毫秒时间戳）
// 文档：https://docs.bigmodel.cn/cn/coding-plan/extension/usage-query-plugin
export const ZHIPU_DEFAULT_BASE_URL = 'https://open.bigmodel.cn';

const USAGE_QUOTA_PATH = '/api/monitor/usage/quota/limit';

// Token 额度的窗口标识（与智谱官方约定一致）
const UNIT_5H = 3;
const UNIT_WEEKLY = 6;

export async function queryZhipuCodingPlan({ apiKey, baseUrl, fetchImpl }) {
  if (!apiKey) {
    throw new QuotaQueryError('missing_key', '未配置 API Key，无法自动查询');
  }
  const endpoint = `${normalize(baseUrl, ZHIPU_DEFAULT_BASE_URL)}${USAGE_QUOTA_PATH}`;

  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(endpoint, {
      method: 'GET',
      headers: { Authorization: apiKey, Accept: 'application/json' },
    });
  } catch (err) {
    throw new QuotaQueryError('network', `网络错误，无法连接 ${endpoint}：${err?.message || err}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new QuotaQueryError('bad_response', '接口返回了无法解析的数据');
  }

  if (data && data.success === false) {
    const msg = data.msg || '未知错误';
    if (data.code === 401 || data.code === 1001) {
      throw new QuotaQueryError('auth', `API Key 无效或未授权（code ${data.code}）：${msg}`);
    }
    throw new QuotaQueryError('http', `查询失败（code ${data.code}）：${msg}`);
  }
  if (!res.ok) {
    throw new QuotaQueryError('http', `查询失败（HTTP ${res.status}）`);
  }

  const payload = data?.data ?? data;
  const limits = Array.isArray(payload?.limits) ? payload.limits : null;
  if (!limits || !limits.length) {
    throw new QuotaQueryError('bad_response', '接口返回中没有套餐限额信息');
  }

  // TOKENS_LIMIT 可能有多条（5 小时窗口与周额度并存），靠 unit 区分；
  // 旧版响应若无 unit 字段，则第一条 TOKENS_LIMIT 视为 5 小时窗口。
  const tokenLimits = limits.filter((l) => l?.type === 'TOKENS_LIMIT');
  const byUnit = (unit) => tokenLimits.find((l) => Number(l.unit) === unit) || null;
  const noUnit = tokenLimits.filter((l) => l.unit == null);
  const windowLimit = byUnit(UNIT_5H) || noUnit[0] || null;
  const weeklyLimit = byUnit(UNIT_WEEKLY);
  const timeLimit = limits.find((l) => l?.type === 'TIME_LIMIT') || null;

  if (!windowLimit && !weeklyLimit && !timeLimit) {
    throw new QuotaQueryError('bad_response', '接口返回中没有可识别的套餐限额（TOKENS_LIMIT / TIME_LIMIT）');
  }

  const pct = (item) => {
    const v = Number(item?.percentage);
    return Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v)) * 100) / 100 : null;
  };
  const count = (item, key) => {
    const v = Number(item?.[key]);
    return Number.isFinite(v) ? v : null;
  };
  const resetIso = (item) => {
    const raw = item?.nextResetTime ?? item?.next_reset_time;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  };

  return {
    status: 'ok',
    balance: null, // 套餐制无余额概念
    currency: null,
    usage: {
      windowUsedPercent: pct(windowLimit),
      weeklyUsedPercent: pct(weeklyLimit),
      monthlyUsedPercent: pct(timeLimit),
      windowUsed: count(windowLimit, 'currentValue'),
      windowTotal: count(windowLimit, 'usage'),
      weeklyUsed: count(weeklyLimit, 'currentValue'),
      weeklyTotal: count(weeklyLimit, 'usage'),
      monthlyUsed: count(timeLimit, 'currentValue'),
      monthlyTotal: count(timeLimit, 'usage'),
      windowResetAt: resetIso(windowLimit),
      weeklyResetAt: resetIso(weeklyLimit),
    },
    extraLine: null,
  };
}
