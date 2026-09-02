import { QuotaQueryError } from './errors.js';
import { normalizeBaseUrl as normalize } from './url.js';

// DeepSeek 官方余额查询接口：GET {baseUrl}/user/balance
// 文档：https://api-docs.deepseek.com/zh-cn/zh-cn/api/get-user-balance
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

export function normalizeBaseUrl(url) {
  return normalize(url, DEEPSEEK_DEFAULT_BASE_URL);
}

export async function queryDeepSeekBalance({ apiKey, baseUrl, fetchImpl }) {
  if (!apiKey) {
    throw new QuotaQueryError('missing_key', '未配置 API Key，无法自动查询');
  }
  const endpoint = `${normalizeBaseUrl(baseUrl)}/user/balance`;
  let res;
  try {
    res = await (fetchImpl || globalThis.fetch)(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    throw new QuotaQueryError('network', `网络错误，无法连接 ${endpoint}：${err?.message || err}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      if (body?.error?.message) detail = `：${body.error.message}`;
    } catch {
      // 返回体不是 JSON 时忽略
    }
    if (res.status === 401 || res.status === 403) {
      throw new QuotaQueryError('auth', `API Key 无效或没有权限（HTTP ${res.status}${detail}）`);
    }
    throw new QuotaQueryError('http', `查询失败（HTTP ${res.status}${detail}）`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new QuotaQueryError('bad_response', '接口返回了无法解析的数据');
  }

  const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
  if (!info || info.total_balance == null) {
    throw new QuotaQueryError('bad_response', '接口返回中没有余额信息');
  }

  return {
    status: 'ok',
    balance: Number(info.total_balance),
    currency: info.currency || 'CNY',
    grantedBalance: Number(info.granted_balance ?? 0),
    toppedUpBalance: Number(info.topped_up_balance ?? 0),
    isAvailable: data.is_available === true,
  };
}
