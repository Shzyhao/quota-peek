// 桌宠 AI 对话核心：会话存储 + Tauri 命令封装 + 额度上下文注入。
// 纯逻辑与 IPC 分离（invoke/channel 由调用方注入），便于单测与网页版降级。

const HISTORY_KEY = 'mqc.chat.messages';
const HISTORY_LIMIT = 100; // 存储上限：最近 100 条（含 user/assistant）

// ——— 会话存储（localStorage，与额度数据同域共享给桌宠窗） ———

export function loadHistory(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveHistory(messages, storage = globalThis.localStorage) {
  const trimmed = messages.slice(-HISTORY_LIMIT);
  try {
    storage?.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch {
    /* 存储满等异常静默：会话是临时数据 */
  }
  return trimmed;
}

export function clearHistory(storage = globalThis.localStorage) {
  storage?.removeItem(HISTORY_KEY);
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
  msgs.push(...recent.slice(start).map((m) => ({ role: m.role, content: m.content })));
  return msgs;
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
