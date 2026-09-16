// 手机关联服务 IPC 封装（phone.rs）：开关与状态查询。

function tauriCore() {
  return globalThis.__TAURI__?.core;
}

async function invoke(cmd) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error('仅桌面版支持手机关联');
  return core.invoke(cmd);
}

/// 启动服务（幂等）：返回 {active, ip, port}
export function phoneServerStart() {
  return invoke('phone_server_start');
}

/// 关闭服务并清空内存内容：返回 {active:false, ...}
export function phoneServerStop() {
  return invoke('phone_server_stop');
}

export function phoneServerStatus() {
  return invoke('phone_server_status');
}
