// 手机关联核心：主窗周期推送对话摘要（服务开启时），桌宠窗推送形象快照。
// 推送频率 3s；开关存 localStorage（mqc.phone.active），Rust 侧只存内存、不落盘。

const tauriCore = () => globalThis.__TAURI__?.core;

export const PHONE_ACTIVE_KEY = 'mqc.phone.active';

export function isPhoneActive() {
  try {
    return globalThis.localStorage?.getItem(PHONE_ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setPhoneActive(on) {
  try {
    globalThis.localStorage?.setItem(PHONE_ACTIVE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/// 会话摘要：最近 5 个会话，每会话最近 60 条文字消息（剥离附件正文与工具卡）
export function summarizeSessions(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem('mqc.chat.sessions');
    const sessions = raw ? JSON.parse(raw) : [];
    return (Array.isArray(sessions) ? sessions : []).slice(0, 5).map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messages: (s.messages || [])
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.tool)
        .slice(-60)
        .map((m) => ({ role: m.role, content: m.content, time: m.time })),
    }));
  } catch {
    return [];
  }
}

/// 启动主窗推送循环（3s 一次，仅服务开启时实际推送）。返回停止函数。
export function startSessionPusher({ intervalMs = 3000 } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (isPhoneActive()) {
      try {
        await tauriCore()?.invoke?.('phone_update_sessions', {
          payload: JSON.stringify(summarizeSessions()),
        });
      } catch {
        /* 服务已关等情况静默 */
      }
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/// 启动桌宠形象快照推送（桌宠窗用）：capture() 返回 dataURL，仅服务开启时推送。
export function startPetImagePusher({ intervalMs = 3000, capture } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (!isPhoneActive()) return;
    try {
      const dataUrl = await capture?.();
      if (dataUrl && String(dataUrl).startsWith('data:image/')) {
        await tauriCore()?.invoke?.('phone_update_pet', { payload: dataUrl });
      }
    } catch {
      /* 快照失败静默（服务已关/渲染未就绪） */
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
