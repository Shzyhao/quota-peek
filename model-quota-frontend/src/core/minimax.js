import { QuotaQueryError } from './errors.js';
import { normalizeBaseUrl as normalize } from './url.js';

// MiniMax 额度查询，路由逻辑与官方 CLI（MiniMax-AI/cli 的 mmx quota 命令）一致：
//   - 普通 API Key（sk-api- 前缀）→ GET {base}/account/query_balance     查账户余额
//   - Coding Plan / Token Plan 密钥 → 优先 GET {base}/v1/api/openplatform/coding_plan/remains
//     （cc-switch 同款新端点，取 model_name="general" 条目），
//     不可用时回退官方 CLI 的 GET {base}/v1/token_plan/remains。
// 鉴权：Authorization: Bearer <Key>；错误以 HTTP 200 + {"base_resp":{"status_code":1004,...}} 返回。
// 国内站默认 https://api.minimaxi.com，国际站 https://api.minimax.io（通过 Base URL 切换）。
export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimaxi.com';

const OPENPLATFORM_PATH = '/v1/api/openplatform/coding_plan/remains';
const TOKEN_PLAN_PATH = '/v1/token_plan/remains';
const ACCOUNT_BALANCE_PATH = '/account/query_balance';

async function getJson(endpoint, apiKey, fetchImpl) {
  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new QuotaQueryError('network', `网络错误，无法连接 ${endpoint}：${err?.message || err}`);
  }

  let data = null;
  const text = await res.text().catch(() => '');
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  // MiniMax 的业务错误放在 base_resp 里，HTTP 状态码恒为 200
  const br = data?.base_resp;
  if (br && (br.status_code || br.status_msg)) {
    if (br.status_code === 1004 || br.status_code === 1001) {
      throw new QuotaQueryError('auth', `API Key 无效或未携带（code ${br.status_code}）：${br.status_msg || 'login fail'}`);
    }
    throw new QuotaQueryError('http', `查询失败（code ${br.status_code}）：${br.status_msg || ''}`);
  }
  if (!res.ok) {
    throw new QuotaQueryError('http', `查询失败（HTTP ${res.status}）${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  return data;
}

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 剩余百分比 / 次数 → 已用百分比
function remainingToUsed(remainingPercent, usedCount, totalCount, status) {
  const remaining = Number(remainingPercent);
  if (Number.isFinite(remaining)) return Math.round((100 - remaining) * 100) / 100;
  const total = Number(totalCount);
  const used = Number(usedCount);
  if (Number.isFinite(total) && Number.isFinite(used) && total > 0) {
    return Math.round((used / total) * 10000) / 100;
  }
  if (status === 2) return 100; // 服务端标记已耗尽
  return null;
}

const resetIso = (ms) => {
  const v = Number(ms);
  return Number.isFinite(v) && v > 0 ? new Date(v).toISOString() : null;
};

// 新端点（cc-switch 同款）：model_remains[] 取 model_name === 'general' 的条目，
// 5 小时窗口直接给剩余百分比，周桶仅 current_weekly_status === 1 时有效。
function parseOpenPlatform(data) {
  const rows = Array.isArray(data?.model_remains) ? data.model_remains : [];
  const row = rows.find((r) => r?.model_name === 'general') || null;
  if (!row) {
    throw new QuotaQueryError('bad_response', 'openplatform 接口返回中没有 general 模型条目');
  }

  const weeklyActive = Number(row.current_weekly_status) === 1;
  return {
    status: 'ok',
    balance: null,
    currency: null,
    usage: {
      windowUsedPercent: remainingToUsed(
        row.current_interval_remaining_percent,
        row.current_interval_usage_count,
        row.current_interval_total_count,
        row.current_interval_status,
      ),
      weeklyUsedPercent: weeklyActive
        ? remainingToUsed(
            row.current_weekly_remaining_percent,
            row.current_weekly_usage_count,
            row.current_weekly_total_count,
            row.current_weekly_status,
          )
        : null,
      monthlyUsedPercent: null,
      windowUsed: toNum(row.current_interval_usage_count),
      windowTotal: toNum(row.current_interval_total_count),
      weeklyUsed: weeklyActive ? toNum(row.current_weekly_usage_count) : null,
      weeklyTotal: weeklyActive ? toNum(row.current_weekly_total_count) : null,
      monthlyUsed: null,
      monthlyTotal: null,
      windowResetAt: resetIso(row.end_time),
      weeklyResetAt: weeklyActive ? resetIso(row.weekly_end_time) : null,
    },
    extraLine: '套餐：Coding Plan',
  };
}

// 旧端点（官方 CLI 同款）：套餐内各模型行共享额度池，取「窗口用量占比最高」的一行作为代表。
function parseTokenPlan(data) {
  const rows = Array.isArray(data?.model_remains) ? data.model_remains : null;
  if (!rows || !rows.length) {
    throw new QuotaQueryError('bad_response', '接口返回中没有套餐余量信息');
  }

  const usedRatio = (r) => {
    const remaining = Number(r?.current_interval_remaining_percent);
    if (Number.isFinite(remaining)) return 100 - remaining;
    const total = Number(r?.current_interval_total_count);
    const used = Number(r?.current_interval_usage_count);
    if (Number.isFinite(total) && Number.isFinite(used) && total > 0) return (used / total) * 100;
    return -1;
  };
  const row = rows.reduce((worst, r) => (usedRatio(r) > usedRatio(worst) ? r : worst), rows[0]);

  return {
    status: 'ok',
    balance: null,
    currency: null,
    usage: {
      windowUsedPercent: remainingToUsed(
        row.current_interval_remaining_percent,
        row.current_interval_usage_count,
        row.current_interval_total_count,
        row.current_interval_status,
      ),
      weeklyUsedPercent: remainingToUsed(
        row.current_weekly_remaining_percent,
        row.current_weekly_usage_count,
        row.current_weekly_total_count,
        row.current_weekly_status,
      ),
      monthlyUsedPercent: null,
      windowUsed: toNum(row.current_interval_usage_count),
      windowTotal: toNum(row.current_interval_total_count),
      weeklyUsed: toNum(row.current_weekly_usage_count),
      weeklyTotal: toNum(row.current_weekly_total_count),
      monthlyUsed: null,
      monthlyTotal: null,
      windowResetAt: null,
      weeklyResetAt: null,
    },
    extraLine: row.model_name ? `额度口径：${row.model_name}` : null,
  };
}

async function queryAccountBalance(base, apiKey, fetchImpl) {
  const data = await getJson(`${base}${ACCOUNT_BALANCE_PATH}`, apiKey, fetchImpl);
  if (!data || data.available_amount == null) {
    throw new QuotaQueryError('bad_response', '接口返回中没有余额信息');
  }
  const voucher = toNum(data.voucher_balance);
  const cash = toNum(data.cash_balance);
  return {
    status: 'ok',
    balance: toNum(data.available_amount),
    currency: 'CNY',
    usage: null,
    extraLine:
      voucher != null || cash != null
        ? `代金券 ${voucher ?? '—'} · 现金 ${cash ?? '—'}`
        : null,
  };
}

async function queryCodingPlan(base, apiKey, fetchImpl) {
  // 主用 openplatform 新端点；除鉴权类错误外，失败时回退官方 CLI 的 token_plan 端点
  try {
    return parseOpenPlatform(await getJson(`${base}${OPENPLATFORM_PATH}`, apiKey, fetchImpl));
  } catch (err) {
    if (err instanceof QuotaQueryError && (err.code === 'auth' || err.code === 'missing_key')) throw err;
    return parseTokenPlan(await getJson(`${base}${TOKEN_PLAN_PATH}`, apiKey, fetchImpl));
  }
}

export async function queryMiniMaxQuota({ apiKey, baseUrl, fetchImpl }) {
  if (!apiKey) {
    throw new QuotaQueryError('missing_key', '未配置 API Key，无法自动查询');
  }
  const base = normalize(baseUrl, MINIMAX_DEFAULT_BASE_URL);
  // 与官方 CLI 一致：sk-api- 前缀的普通密钥查账户余额，Coding Plan 密钥查套餐余量
  if (apiKey.startsWith('sk-api-')) {
    return queryAccountBalance(base, apiKey, fetchImpl);
  }
  return queryCodingPlan(base, apiKey, fetchImpl);
}
