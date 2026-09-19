// 用量与趋势数据层：
// 1) AI Token 用量（mqc.usage）：chat_send 的 Done 事件带 prompt/completion tokens，
//    对话页与语音面板完成后记录；按天/按模型汇总供「用量」页展示（文件分析的 token
//    已在分析历史里，页面直接聚合 analyze_get_history，不重复存）。
// 2) 额度趋势快照（mqc.balanceHistory）：每次刷新数据变化后按供应商记余额点，
//    同日同余额去重，单供应商上限 400 点（约够一年以上的日粒度）。
// 纯逻辑与 storage 分离（storage 注入）便于单测。

export const USAGE_KEY = 'mqc.usage';
export const BALANCE_HISTORY_KEY = 'mqc.balanceHistory';
export const MAX_USAGE_ENTRIES = 2000;
export const MAX_BALANCE_POINTS = 400;

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : fallback;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储满等异常静默 */
  }
}

// ——— AI Token 用量 ———

/// 记录一次模型调用用量。tokens 缺失（平台不返回）时整条不入库。
export function recordUsage(entry, storage = globalThis.localStorage) {
  const { profileId, profileName, model, promptTokens, completionTokens, source } = entry || {};
  const p = Number(promptTokens);
  const c = Number(completionTokens);
  if (!Number.isFinite(p) && !Number.isFinite(c)) return null;
  const list = readJson(storage, USAGE_KEY, []);
  list.unshift({
    id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    time: Date.now(),
    source: String(source || 'chat'),
    profileId: String(profileId || ''),
    profileName: String(profileName || ''),
    model: String(model || ''),
    promptTokens: Number.isFinite(p) ? p : 0,
    completionTokens: Number.isFinite(c) ? c : 0,
  });
  writeJson(storage, USAGE_KEY, list.slice(0, MAX_USAGE_ENTRIES));
  return true;
}

export function listUsage(storage = globalThis.localStorage) {
  return readJson(storage, USAGE_KEY, []);
}

const dayKey = (t) => {
  const d = new Date(t);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/// 按天汇总（最近 N 天，升序）：[{ day, prompt, completion, calls }]
export function summarizeUsageByDay(days = 14, storage = globalThis.localStorage, now = Date.now()) {
  const list = listUsage(storage);
  const map = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const t = now - i * 86400000;
    map.set(dayKey(t), { day: dayKey(t), prompt: 0, completion: 0, calls: 0 });
  }
  for (const u of list) {
    const k = dayKey(u.time);
    const row = map.get(k);
    if (!row) continue;
    row.prompt += u.promptTokens || 0;
    row.completion += u.completionTokens || 0;
    row.calls += 1;
  }
  return [...map.values()];
}

/// 按模型汇总（全量记录）：[{ model, profileName, calls, prompt, completion }] 按总量降序
export function summarizeUsageByModel(storage = globalThis.localStorage) {
  const map = new Map();
  for (const u of listUsage(storage)) {
    const k = `${u.model}||${u.profileName}`;
    const row = map.get(k) || { model: u.model, profileName: u.profileName, calls: 0, prompt: 0, completion: 0 };
    row.calls += 1;
    row.prompt += u.promptTokens || 0;
    row.completion += u.completionTokens || 0;
    map.set(k, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, total: r.prompt + r.completion }))
    .sort((a, b) => b.total - a.total);
}

// ——— 额度趋势快照 ———

/// 刷新后调用：对每个余额可查的供应商记一个趋势点。
/// 去重：同供应商同日且余额相同则跳过（余额变化随时记，不变每天至多一个点）。
export function recordBalanceSnapshots(providers, storage = globalThis.localStorage, now = Date.now()) {
  const store = readJson(storage, BALANCE_HISTORY_KEY, {});
  let changed = false;
  const today = dayKey(now);
  for (const p of providers || []) {
    const q = p.lastQuery;
    if (!q || q.status !== 'ok' || q.balance == null || !Number.isFinite(Number(q.balance))) continue;
    const entry = store[p.id] || { name: p.name, currency: q.currency || '', points: [] };
    const last = entry.points[entry.points.length - 1];
    const balance = Number(q.balance);
    if (last && last.b === balance && dayKey(last.t) === today) continue;
    entry.points.push({ t: now, b: balance });
    if (entry.points.length > MAX_BALANCE_POINTS) {
      entry.points = entry.points.slice(-MAX_BALANCE_POINTS);
    }
    entry.name = p.name; // 名称可能被改名
    entry.currency = q.currency || entry.currency || '';
    store[p.id] = entry;
    changed = true;
  }
  // 清掉已删除供应商的历史
  const ids = new Set((providers || []).map((p) => p.id));
  for (const id of Object.keys(store)) {
    if (!ids.has(id)) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) writeJson(storage, BALANCE_HISTORY_KEY, store);
  return changed;
}

/// 读取趋势数据（含总览）：[{ id, name, currency, points: [{ t, b }] }]
export function loadBalanceHistory(storage = globalThis.localStorage) {
  const store = readJson(storage, BALANCE_HISTORY_KEY, {});
  return Object.entries(store).map(([id, e]) => ({
    id,
    name: e.name || id,
    currency: e.currency || '',
    points: (e.points || []).map((pt) => ({ t: pt.t, b: pt.b })),
  }));
}
