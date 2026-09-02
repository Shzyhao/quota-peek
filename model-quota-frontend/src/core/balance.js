import { QuotaQueryError } from './errors.js';
import { normalizeBaseUrl as normalize } from './url.js';

// 第三方平台余额查询（与 cc-switch 内置「第三方余额」模板相同的官方接口）：
//   StepFun      GET https://api.stepfun.com/v1/accounts
//   SiliconFlow  GET https://api.siliconflow.cn/v1/user/info（国际站 api.siliconflow.com）
//   OpenRouter   GET https://openrouter.ai/api/v1/credits
//   Novita AI    GET https://api.novita.ai/v3/user/balance（金额单位 0.0001 USD）
// 均为 Bearer 单凭证，浏览器 CORS 已实测开放。

export const STEPFUN_DEFAULT_BASE_URL = 'https://api.stepfun.com';
export const SILICONFLOW_DEFAULT_BASE_URL = 'https://api.siliconflow.cn';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai';
export const NOVITA_DEFAULT_BASE_URL = 'https://api.novita.ai';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function queryBalanceApi({ apiKey, baseUrl, defaultBaseUrl, path, label, parse, fetchImpl }) {
  if (!apiKey) {
    throw new QuotaQueryError('missing_key', '未配置 API Key，无法自动查询');
  }
  const endpoint = `${normalize(baseUrl, defaultBaseUrl)}${path}`;

  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new QuotaQueryError('network', `网络错误，无法连接 ${endpoint}：${err?.message || err}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new QuotaQueryError('auth', `${label} API Key 无效或没有权限（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // 忽略读取失败
    }
    throw new QuotaQueryError('http', `查询失败（HTTP ${res.status}${detail ? `：${detail}` : ''}）`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new QuotaQueryError('bad_response', '接口返回了无法解析的数据');
  }

  const parsed = parse(data);
  if (!parsed || parsed.balance == null) {
    throw new QuotaQueryError('bad_response', '接口返回中没有余额信息');
  }
  return {
    status: 'ok',
    balance: parsed.balance,
    currency: parsed.currency || null,
    usage: null,
    extraLine: parsed.extraLine ?? null,
  };
}

// StepFun：{ balance, total_cash_balance, total_voucher_balance }（元）
export function queryStepfunBalance({ apiKey, baseUrl, fetchImpl }) {
  return queryBalanceApi({
    apiKey,
    baseUrl,
    fetchImpl,
    defaultBaseUrl: STEPFUN_DEFAULT_BASE_URL,
    path: '/v1/accounts',
    label: 'StepFun',
    parse: (body) => {
      const cash = num(body.total_cash_balance);
      const voucher = num(body.total_voucher_balance);
      return {
        balance: num(body.balance),
        currency: 'CNY',
        extraLine: cash != null || voucher != null ? `现金 ${cash ?? '—'} · 代金券 ${voucher ?? '—'}` : null,
      };
    },
  });
}

// SiliconFlow：{ data: { balance, chargeBalance, totalBalance } }；国际站（.com）为 USD
export function querySiliconflowBalance({ apiKey, baseUrl, fetchImpl }) {
  const base = normalize(baseUrl, SILICONFLOW_DEFAULT_BASE_URL);
  const isEn = base.endsWith('.com');
  return queryBalanceApi({
    apiKey,
    baseUrl,
    fetchImpl,
    defaultBaseUrl: SILICONFLOW_DEFAULT_BASE_URL,
    path: '/v1/user/info',
    label: 'SiliconFlow',
    parse: (body) => {
      const d = body?.data ?? body;
      const charge = num(d?.chargeBalance);
      return {
        balance: num(d?.totalBalance),
        currency: isEn ? 'USD' : 'CNY',
        extraLine: charge != null ? `充值余额 ${charge}` : null,
      };
    },
  });
}

// OpenRouter：{ data: { total_credits, total_usage } }（USD），余额 = 总额度 − 已用
export function queryOpenRouterBalance({ apiKey, baseUrl, fetchImpl }) {
  return queryBalanceApi({
    apiKey,
    baseUrl,
    fetchImpl,
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    path: '/api/v1/credits',
    label: 'OpenRouter',
    parse: (body) => {
      const d = body?.data ?? body;
      const total = num(d?.total_credits);
      const used = num(d?.total_usage);
      const balance = total != null && used != null ? total - used : null;
      return {
        balance,
        currency: 'USD',
        extraLine: total != null ? `总额度 ${total} · 已用 ${used ?? '—'}` : null,
      };
    },
  });
}

// Novita AI：{ availableBalance, ... }，金额单位 0.0001 USD，需除以 10000
export function queryNovitaBalance({ apiKey, baseUrl, fetchImpl }) {
  return queryBalanceApi({
    apiKey,
    baseUrl,
    fetchImpl,
    defaultBaseUrl: NOVITA_DEFAULT_BASE_URL,
    path: '/v3/user/balance',
    label: 'Novita AI',
    parse: (body) => {
      const available = num(body.availableBalance);
      return {
        balance: available == null ? null : available / 10000,
        currency: 'USD',
        extraLine: null,
      };
    },
  });
}
