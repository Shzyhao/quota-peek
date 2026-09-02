import { QuotaQueryError } from './errors.js';
import { normalizeBaseUrl as normalize } from './url.js';

// 火山方舟 Coding Plan / Agent Plan 用量查询。
// 官方 OpenAPI（与社区工具 dsh-ark-quota 使用的端点一致）：
//   POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01   Coding Plan
//   POST https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01          Agent Plan（回退）
// 鉴权：火山引擎 IAM AccessKey ID + Secret Access Key，SigV4 签名
// （派生链 Date → Region → Service(ark) → request，与官方 SDK 一致）。
// 注意：凭证是「访问控制 IAM」的访问密钥，不是模型推理用的 Ark API Key。
// CORS 已实测开放（allow-origin: *，允许 X-Date/Authorization/X-Content-Sha256 头）。
export const VOLCENGINE_DEFAULT_BASE_URL = 'https://open.volcengineapi.com';

const API_VERSION = '2024-01-01';
const SERVICE = 'ark';
const REGION = 'cn-beijing';
const CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';
const SIGNED_HEADERS = 'content-type;host;x-content-sha256;x-date';

const encoder = new TextEncoder();

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return hex(new Uint8Array(digest));
}

async function hmac(key, message) {
  // key 为 Uint8Array 或字符串（字符串按 UTF-8 字节解释，与 Node createHmac 一致）
  const keyBytes = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

function apiHost(baseUrl) {
  return new URL(normalize(baseUrl, VOLCENGINE_DEFAULT_BASE_URL)).host;
}

// 火山引擎 SigV4 签名（纯浏览器实现，使用 Web Crypto）
async function signPost({ ak, sk, host, query, timestamp }) {
  const dateStamp = timestamp.slice(0, 8);
  const payloadHash = await sha256Hex('');
  const canonicalRequest = [
    'POST',
    '/',
    query,
    `content-type:${CONTENT_TYPE}`,
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${timestamp}`,
    '',
    SIGNED_HEADERS,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', timestamp, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(sk, dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, 'request');
  const signature = hex(await hmac(kSigning, stringToSign));

  return {
    payloadHash,
    authorization: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
  };
}

async function callOpenApi({ action, ak, sk, host, fetchImpl, now }) {
  const iso = now().toISOString();
  const timestamp =
    iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + 'T' +
    iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + 'Z';
  const query = `Action=${action}&Version=${API_VERSION}`;
  const { payloadHash, authorization } = await signPost({ ak, sk, host, query, timestamp });

  const res = await fetchImpl(`https://${host}/?${query}`, {
    method: 'POST',
    headers: {
      'content-type': CONTENT_TYPE,
      accept: 'application/json',
      'x-date': timestamp,
      'x-content-sha256': payloadHash,
      authorization,
    },
    body: '',
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  // 火山 OpenAPI 的错误放在 ResponseMetadata.Error（HTTP 状态通常仍为 200）
  const err = data?.ResponseMetadata?.Error;
  if (err) {
    const msg = `${err.Code || 'OpenAPI 错误'}${err.Message ? `：${err.Message}` : ''}`;
    if (/signature|accesskey|auth|credential|signin/i.test(String(err.Code || ''))) {
      throw new QuotaQueryError('auth', `密钥或签名无效（${msg}）`);
    }
    throw new QuotaQueryError('http', msg);
  }
  if (!res.ok) {
    throw new QuotaQueryError('http', `查询失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  return data;
}

// Coding Plan：QuotaUsage[] → level: session(近5小时)/weekly/monthly，仅百分比 + 重置时间
function parseCodingPlan(data) {
  const result = data?.Result || {};
  const quotas = Array.isArray(result.QuotaUsage) ? result.QuotaUsage : [];
  const pct = (q) => {
    const v = Number(q?.Percent);
    return Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v)) * 100) / 100 : null;
  };
  const windows = quotas
    .map((q) => ({
      level: q?.Level,
      percent: pct(q),
      resetMs: Number(q?.ResetTimestamp) > 0 ? Number(q.ResetTimestamp) * 1000 : null,
    }))
    .filter((w) => w.level && w.percent != null);
  return windows.length ? { plan: 'Coding Plan', windows } : null;
}

// Agent Plan：AFPFiveHour/AFPWeekly/AFPMonthly 各含 Quota/Used/ResetTime（毫秒）
function parseAgentPlan(data) {
  const result = data?.Result || {};
  const windows = [];
  const add = (w, level) => {
    const quota = Number(w?.Quota);
    const used = Number(w?.Used);
    if (Number.isFinite(quota) && quota > 0) {
      windows.push({
        level,
        percent: Math.round((used / quota) * 10000) / 100,
        resetMs: Number(w?.ResetTime) > 0 ? Number(w.ResetTime) : null,
      });
    }
  };
  add(result.AFPFiveHour, 'session');
  add(result.AFPWeekly, 'weekly');
  add(result.AFPMonthly, 'monthly');
  return windows.length ? { plan: 'Agent Plan', windows } : null;
}

function toUsage(windows) {
  const byLevel = Object.fromEntries(windows.map((w) => [w.level, w]));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    windowUsedPercent: byLevel.session?.percent ?? null,
    weeklyUsedPercent: byLevel.weekly?.percent ?? null,
    monthlyUsedPercent: byLevel.monthly?.percent ?? null,
    // 官方接口只返回百分比，不提供已用/总额数值
    windowUsed: null,
    windowTotal: null,
    weeklyUsed: null,
    weeklyTotal: null,
    monthlyUsed: null,
    monthlyTotal: null,
    windowResetAt: iso(byLevel.session?.resetMs),
    weeklyResetAt: iso(byLevel.weekly?.resetMs),
  };
}

export async function queryVolcengineCodingPlan({
  apiKey,
  apiSecret,
  baseUrl,
  fetchImpl,
  now = () => new Date(),
}) {
  const ak = String(apiKey || '').trim();
  const sk = String(apiSecret || '').trim();
  if (!ak || !sk) {
    throw new QuotaQueryError('missing_key', '未配置 AccessKey ID / Secret Access Key，无法自动查询');
  }

  const host = apiHost(baseUrl);
  const doFetch = fetchImpl || globalThis.fetch;

  let data;
  try {
    data = await callOpenApi({ action: 'GetCodingPlanUsage', ak, sk, host, fetchImpl: doFetch, now });
  } catch (err) {
    if (err instanceof QuotaQueryError) throw err;
    throw new QuotaQueryError('network', `网络错误，无法连接 ${host}：${err?.message || err}`);
  }

  let plan = parseCodingPlan(data);
  if (!plan) {
    // 未订阅 Coding Plan 时回退查询 Agent Plan（GetAFPUsage）
    try {
      data = await callOpenApi({ action: 'GetAFPUsage', ak, sk, host, fetchImpl: doFetch, now });
      plan = parseAgentPlan(data);
    } catch (err) {
      if (err instanceof QuotaQueryError) throw err;
      throw new QuotaQueryError('network', `网络错误，无法连接 ${host}：${err?.message || err}`);
    }
  }
  if (!plan) {
    throw new QuotaQueryError('bad_response', '未获取到套餐用量数据（可能未订阅 Coding Plan / Agent Plan，或密钥缺少方舟只读权限）');
  }

  return {
    status: 'ok',
    balance: null,
    currency: null,
    usage: toUsage(plan.windows),
    extraLine: `套餐：${plan.plan}`,
  };
}
