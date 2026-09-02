import { QuotaQueryError } from './errors.js';
import { normalizeBaseUrl as normalize } from './url.js';

// Kimi / Moonshot 开放平台余额查询（官方文档接口，注意：查的是 API 按量余额，不是会员 Coding 套餐用量）。
//   GET {base}/v1/users/me/balance   Authorization: Bearer <API Key>
// 文档：https://platform.kimi.com/docs/api/balance
export const MOONSHOT_DEFAULT_BASE_URL = 'https://api.moonshot.cn';

const BALANCE_PATH = '/v1/users/me/balance';

export async function queryMoonshotBalance({ apiKey, baseUrl, fetchImpl }) {
  if (!apiKey) {
    throw new QuotaQueryError('missing_key', '未配置 API Key，无法自动查询');
  }
  const endpoint = `${normalize(baseUrl, MOONSHOT_DEFAULT_BASE_URL)}${BALANCE_PATH}`;

  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    throw new QuotaQueryError('network', `网络错误，无法连接 ${endpoint}：${err?.message || err}`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // 保留 data 为 null，交给下方按状态码报错
  }

  if (res.status === 401 || res.status === 403) {
    const msg = data?.error?.message || '';
    throw new QuotaQueryError('auth', `API Key 无效或没有权限（HTTP ${res.status}${msg ? `：${msg}` : ''}）`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || '';
    throw new QuotaQueryError('http', `查询失败（HTTP ${res.status}${msg ? `：${msg}` : ''}）`);
  }
  if (typeof data?.code === 'number' && data.code !== 0) {
    throw new QuotaQueryError('http', `查询失败（code ${data.code}）`);
  }

  const d = data?.data;
  if (!d || d.available_balance == null) {
    throw new QuotaQueryError('bad_response', '接口返回中没有余额信息');
  }

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const voucher = num(d.voucher_balance);
  const cash = num(d.cash_balance);

  return {
    status: 'ok',
    balance: num(d.available_balance),
    currency: 'CNY',
    usage: null,
    extraLine:
      voucher != null || cash != null
        ? `代金券 ${voucher ?? '—'} · 现金 ${cash ?? '—'}`
        : null,
  };
}
