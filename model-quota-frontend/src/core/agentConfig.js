// Agent 设置 IPC 封装：配置复用 chat_get/save_config（PetConfig 含 agent_prompt/skills），
// 技能文件导入/删除走独立命令（复制进配置目录，防源文件移动失效）。

function tauriCore() {
  return globalThis.__TAURI__?.core;
}

async function invoke(cmd, args) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error('仅桌面版支持 Agent 设置');
  return core.invoke(cmd, args);
}

export async function getChatConfig() {
  return invoke('chat_get_config');
}

export async function saveChatConfig(part) {
  // 只改 Agent 相关字段：先取全量，合并后写回（避免覆盖其他窗口刚改的模型配置）
  const full = await invoke('chat_get_config');
  return invoke('chat_save_config', {
    cfg: {
      ...full,
      agent_prompt: part.agent_prompt ?? full.agent_prompt ?? '',
      skills: Array.isArray(part.skills) ? part.skills : (full.skills || []),
    },
  });
}

/// 导入技能文件：复制进配置目录，返回 {id, name, path}
export function agentImportSkill(path) {
  return invoke('agent_import_skill', { path });
}

export function agentDeleteSkill(path) {
  return invoke('agent_delete_skill', { path });
}
