// 桌宠 AI 对话核心：多会话存储 + Tauri 命令封装 + 额度上下文注入 + 供应商联动。
// 纯逻辑与 IPC 分离（invoke/channel 由调用方注入），便于单测与网页版降级。

import { getProviderType } from './providers.js';

const SESSIONS_KEY = 'mqc.chat.sessions';
const ACTIVE_KEY = 'mqc.chat.activeSession';
const LEGACY_MESSAGES_KEY = 'mqc.chat.messages';
export const HISTORY_LIMIT = 100; // 每个会话保留的消息条数（含 user/assistant）
export const MAX_SESSIONS = 10;   // 会话数上限，超出按最近活跃淘汰最旧

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
    /* 存储满等异常静默：会话是临时数据 */
  }
}

// ——— 多会话存储（localStorage，与额度数据同域共享给桌宠窗） ———

export function newSession(now = Date.now()) {
  return {
    id: `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: '新的对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

// 会话标题取首条用户消息截断
export function titleFromText(text, max = 18) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '新的对话';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// 一次性迁移：旧版单会话缓冲（mqc.chat.messages）→ sessions 结构
export function migrateLegacyHistory(storage = globalThis.localStorage) {
  const legacy = readJson(storage, LEGACY_MESSAGES_KEY, null);
  if (!Array.isArray(legacy) || !legacy.length) return false;
  const firstUser = legacy.find((m) => m.role === 'user');
  const lastTime = legacy[legacy.length - 1]?.time || Date.now();
  const session = {
    ...newSession(lastTime),
    title: titleFromText(firstUser?.content),
    messages: legacy.slice(-HISTORY_LIMIT),
  };
  writeJson(storage, SESSIONS_KEY, [session]);
  writeJson(storage, ACTIVE_KEY, session.id);
  storage?.removeItem(LEGACY_MESSAGES_KEY);
  return true;
}

// 读取会话列表与当前会话 id（activeId 失效时回退最近会话）
export function loadSessions(storage = globalThis.localStorage) {
  migrateLegacyHistory(storage);
  const list = readJson(storage, SESSIONS_KEY, []);
  const sessions = Array.isArray(list) ? list : [];
  const activeId = readJson(storage, ACTIVE_KEY, null);
  return {
    sessions,
    activeId: sessions.some((s) => s.id === activeId) ? activeId : sessions[0]?.id ?? null,
  };
}

// 持久化：按最近活跃排序并裁剪到上限；activeId 不在列表时回退最近会话
export function saveSessions(sessions, activeId, storage = globalThis.localStorage) {
  const sorted = [...(Array.isArray(sessions) ? sessions : [])]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SESSIONS);
  const nextActive = sorted.some((s) => s.id === activeId) ? activeId : sorted[0]?.id ?? null;
  writeJson(storage, SESSIONS_KEY, sorted);
  writeJson(storage, ACTIVE_KEY, nextActive);
  return { sessions: sorted, activeId: nextActive };
}

// 向当前会话追加消息：维护 updatedAt、超过上限裁剪旧消息、首条用户消息自动命名
export function appendToSession(sessions, activeId, message, storage = globalThis.localStorage) {
  const now = message.time || Date.now();
  let list = Array.isArray(sessions) ? [...sessions] : [];
  const idx = list.findIndex((s) => s.id === activeId);
  if (idx < 0) {
    list.unshift({
      ...newSession(now),
      title: message.role === 'user' ? titleFromText(message.content) : '新的对话',
      messages: [message],
    });
  } else {
    const s = list[idx];
    const isFirstUser = s.title === '新的对话' && message.role === 'user';
    list[idx] = {
      ...s,
      title: isFirstUser ? titleFromText(message.content) : s.title,
      updatedAt: now,
      messages: [...s.messages, message].slice(-HISTORY_LIMIT),
    };
  }
  // 附件体积预算：会话序列化超 3MB 时从最旧的消息起省略附件正文（最后一条保持完整），
  // 防止大量附件撑爆 localStorage 导致 saveSessions 静默丢数据
  const BUDGET = 3_000_000;
  const hasContent = (list2) => list2.some((x) => (x.messages || []).some((m) => (m.attachments || []).some((a) => a.content)));
  let raw = JSON.stringify(list);
  let guard = 0;
  while (raw.length > BUDGET && hasContent(list) && guard < 500) {
    guard += 1;
    let stripped = false;
    for (let si = 0; si < list.length && !stripped; si++) {
      const msgs = list[si].messages || [];
      for (let mi = 0; mi < msgs.length && !stripped; mi++) {
        const atts = msgs[mi].attachments || [];
        if (atts.some((a) => a.content)) {
          list[si].messages[mi] = { ...msgs[mi], attachments: atts.map((a) => ({ ...a, content: '' })) };
          stripped = true;
        }
      }
    }
    if (!stripped) break;
    raw = JSON.stringify(list);
  }
  return saveSessions(list, idx < 0 ? list[0].id : activeId, storage);
}

// 清空当前会话的消息（保留会话本身）
export function clearActiveMessages(sessions, activeId, storage = globalThis.localStorage) {
  const now = Date.now();
  const list = (Array.isArray(sessions) ? sessions : []).map((s) =>
    s.id === activeId ? { ...s, title: '新的对话', updatedAt: now, messages: [] } : s,
  );
  return saveSessions(list, activeId, storage);
}

// 删除指定会话；删空时自动补一个新会话，activeId 落到最近会话
export function deleteSession(sessions, activeId, id, storage = globalThis.localStorage) {
  const rest = (Array.isArray(sessions) ? sessions : []).filter((s) => s.id !== id);
  if (!rest.length) {
    const fresh = newSession();
    return saveSessions([fresh], fresh.id, storage);
  }
  return saveSessions(rest, activeId === id ? null : activeId, storage);
}

// ——— 额度供应商 → 对话模型联动 ———

/// 由额度供应商配置生成对话 profile：id 稳定（prov-<供应商id>），
/// 重复导入天然覆盖旧值 = 同步语义。模型取供应商的 chatModel，
/// 未设置时回退类型注册表 defaultChatModel。
export function buildProfileFromProvider(p) {
  const type = getProviderType(p.type);
  return {
    id: `prov-${p.id}`,
    name: p.name,
    base_url: String(p.baseUrl || type.defaultBaseUrl || '').replace(/\/+$/, ''),
    model: p.chatModel || type.defaultChatModel || '',
  };
}

/// 可导入联动供应商过滤：启用中、非双凭证类型（火山 IAM 的密钥不是模型 Key）
export function importableProviders(providers) {
  return (providers || []).filter((p) => {
    if (p.enabled === false) return false;
    return !getProviderType(p.type).needsSecret;
  });
}

// ——— 额度上下文注入 ———

function describeProvider(p) {
  const q = p.lastQuery;
  if (!q || q.status !== 'ok') {
    return `· ${p.name}（${p.type}）：${q?.status === 'failed' ? '查询失败' : '未查询/不支持自动查询'}`;
  }
  const parts = [`· ${p.name}（${p.type}）：余额 ${q.balance ?? '?'} ${q.currency || ''}`.trim()];
  if (q.remainingText) parts.push(`，${q.remainingText}`);
  if (q.expiryDate) parts.push(`，${q.expiryDate} 到期`);
  return parts.join('');
}

/// 生成额度摘要 system 消息（桌宠能回答"我还剩多少额度"）；无数据返回 null
export function buildQuotaContext(providers, now = new Date()) {
  if (!providers?.length) return null;
  const lines = providers.map(describeProvider).join('\n');
  return {
    role: 'system',
    content:
      `以下是用户已配置的大模型供应商额度状态（本地缓存，数据时间 ${now.toLocaleString('zh-CN')}，` +
      `可能过期，仅供回答额度相关问题参考；金额单位跟随各平台返回）：\n${lines}`,
  };
}

/// 组装发往 Rust 的消息序列：额度上下文（若有）+ 最近 N 轮历史。
/// 人设 system 由 Rust 端注入，这里不拼。
export function buildOutgoingMessages(history, quotaContext, maxRounds = 12) {
  const msgs = [];
  if (quotaContext) msgs.push(quotaContext);
  // 历史按轮截断，且从第一条完整消息开始（避免残留孤立 assistant 消息）
  const recent = history.slice(-maxRounds * 2);
  const start = recent[0]?.role === 'assistant' ? 1 : 0;
  const kept = recent.slice(start).map((m, idx, arr) => {
    const isLast = idx === arr.length - 1;
    let content = m.content || '';
    if (m.attachments?.length) {
      content += (content ? '\n' : '') + (isLast ? attachmentsToText(m.attachments) : stubAttachments(m.attachments));
    }
    return { role: m.role, content };
  });
  msgs.push(...kept);
  return msgs;
}

// 附件 → 完整文本块（只随最后一条用户消息发送）
export function attachmentsToText(attachments = []) {
  return attachments
    .map((a) => `【附件文件：${a.name}${a.truncated ? '，内容超长已截断' : ''}】\n${a.content}`)
    .join('\n\n');
}

// 附件 → 占位块（历史轮省略正文，防止反复携带大文本）
function stubAttachments(attachments = []) {
  return attachments.map((a) => `【附件：${a.name}（内容已省略）】`).join('\n');
}

// ——— Tauri IPC 封装（桌面壳 only；网页版无 __TAURI__.core 时 isChatAvailable=false） ———

function tauriCore() {
  return globalThis.__TAURI__?.core;
}

export function isChatAvailable() {
  return typeof tauriCore()?.invoke === 'function'
    && typeof tauriCore()?.Channel === 'function';
}

async function invoke(cmd, args) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error('仅桌面版支持 AI 对话');
  return core.invoke(cmd, args);
}

export async function getChatConfig() {
  return invoke('chat_get_config');
}

export async function saveChatConfig(cfg) {
  return invoke('chat_save_config', { cfg });
}

export async function setChatKey(profileId, key) {
  return invoke('chat_set_key', { profileId, key });
}

export async function hasChatKey(profileId) {
  return invoke('chat_has_key', { profileId });
}

export async function deleteChatKey(profileId) {
  return invoke('chat_delete_key', { profileId });
}

export async function testChatConnection() {
  return invoke('chat_test_connection');
}

export function cancelChat() {
  return invoke('chat_cancel');
}

/// 发起流式对话。回调：onToken(text) 增量、onDone(usage)、onError(message)、onCancelled()。
/// 内部不落历史——调用方在 onDone/onError 时自行追加消息，保持单一职责。
export function sendChat(messages, { onToken, onDone, onError, onCancelled } = {}) {
  const core = tauriCore();
  if (!core?.invoke || !core.Channel) return Promise.reject(new Error('仅桌面版支持 AI 对话'));
  return new Promise((resolve) => {
    const channel = new core.Channel();
    channel.onmessage = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'token') onToken?.(ev.data?.text ?? '');
      else if (ev.type === 'done') { onDone?.(ev.data?.usage ?? null); resolve(); }
      else if (ev.type === 'error') { onError?.(ev.data?.message ?? '请求失败'); resolve(); }
      else if (ev.type === 'cancelled') { onCancelled?.(); resolve(); }
    };
    invoke('chat_send', { messages, onEvent: channel }).catch((e) => {
      onError?.(String(e?.message || e));
      resolve();
    });
  });
}

// ——— 会话附件（桌面壳解析文件为文本） ———

/// 解析本地文件为文本（Rust 侧复用轻析解析器；截断至 8000 字符）。
export async function readChatFile(path) {
  const v = await invoke('chat_read_file', { path });
  return v ? { name: String(v.name || ''), content: String(v.content || ''), truncated: !!v.truncated, chars: v.chars ?? 0 } : null;
}

// ——— Agent（单步确认式工具循环） ———

export function isAgentAvailable() {
  return isChatAvailable();
}

/// 发起 Agent 任务。回调：onToolProposed({callId,name,args,danger})、
/// onToolResult({name,ok,output,durationMs})、onDone(text)、onError(message)。
/// 模型提出工具调用后任务挂起，须经 agentResolve 续跑。
export function agentSend(messages, { onToolProposed, onToolResult, onDone, onError } = {}) {
  const core = tauriCore();
  if (!core?.invoke || !core.Channel) return Promise.reject(new Error('仅桌面版支持 Agent'));
  return new Promise((resolve) => {
    const channel = new core.Channel();
    channel.onmessage = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'tool_proposed') onToolProposed?.(ev.data ?? {});
      else if (ev.type === 'tool_result') onToolResult?.(ev.data ?? {});
      else if (ev.type === 'done') { onDone?.(ev.data?.text ?? ''); resolve(); }
      else if (ev.type === 'error') { onError?.(ev.data?.message ?? '请求失败'); resolve(); }
    };
    invoke('agent_send', { messages, onEvent: channel }).catch((e) => {
      onError?.(String(e?.message || e));
      resolve();
    });
  });
}

/// 对挂起的工具调用作出决定（批准/拒绝），续跑循环；回调同 agentSend。
/// options.approveChain：批准本任务后续全部工具调用（多步自主，Rust 直接执行不再挂起）；
/// options.auto：本次由「只读自动批准」设置触发（审计标记 auto=true）。
export function agentResolve(approved, handlers = {}, { approveChain = false, auto = false } = {}) {
  const core = tauriCore();
  if (!core?.invoke || !core.Channel) return Promise.reject(new Error('仅桌面版支持 Agent'));
  return new Promise((resolve) => {
    const channel = new core.Channel();
    channel.onmessage = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'tool_proposed') handlers.onToolProposed?.(ev.data ?? {});
      else if (ev.type === 'tool_result') handlers.onToolResult?.(ev.data ?? {});
      else if (ev.type === 'done') { handlers.onDone?.(ev.data?.text ?? ''); resolve(); }
      else if (ev.type === 'error') { handlers.onError?.(ev.data?.message ?? '请求失败'); resolve(); }
    };
    invoke('agent_resolve', { approved, approveChain, auto, onEvent: channel }).catch((e) => {
      handlers.onError?.(String(e?.message || e));
      resolve();
    });
  });
}

export function cancelAgent() {
  return invoke('agent_cancel');
}

/// 只读工具（无系统副作用）：开启「⚡ 只读自动批准」后这类调用跳过确认卡。
/// 注意 read_text_file 有隐私属性，但执行仍全程落审计日志。
export function isReadonlyTool(name) {
  return ['get_current_time', 'get_system_info', 'list_directory', 'read_text_file'].includes(name);
}
