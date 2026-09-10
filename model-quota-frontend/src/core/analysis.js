// 文件分析 IPC 封装：复用桌宠对话的模型配置，事件类型与 Rust PipelineEvent
// （serde tag="type"）对齐——变体名为 PascalCase：Started/Parsing/Tokens/FileDone/Done/Error/Cancelled。

function tauriCore() {
  return globalThis.__TAURI__?.core;
}

export function isAnalysisAvailable() {
  return typeof tauriCore()?.invoke === 'function'
    && typeof tauriCore()?.Channel === 'function';
}

async function invoke(cmd, args) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error('仅桌面版支持文件分析');
  return core.invoke(cmd, args);
}

/// 发起分析：paths 文件绝对路径列表；save=true 时 .ai.md 落盘到源文件旁；
/// custom 自定义指令（可空）；onEvent(ev) 收 PipelineEvent（ev.type / ev.data）。
export function analyzeFiles(paths, { save = false, custom = '', onEvent } = {}) {
  const core = tauriCore();
  if (!core?.invoke || !core.Channel) return Promise.reject(new Error('仅桌面版支持文件分析'));
  return new Promise((resolve, reject) => {
    const channel = new core.Channel();
    channel.onmessage = (ev) => onEvent?.(ev);
    invoke('analyze_files', { paths, save, custom: custom || null, onEvent: channel })
      .catch((e) => reject(new Error(String(e?.message || e))))
      .then(() => resolve());
  });
}

export function analyzeCancel() {
  return invoke('analyze_cancel');
}

export async function getAnalysisHistory() {
  return (await invoke('analyze_get_history')) || [];
}

export function deleteAnalysisHistory(id) {
  return invoke('analyze_delete_history', { id });
}

export function clearAnalysisHistory() {
  return invoke('analyze_clear_history');
}

/// 前端文件选择 input 的 FileList → 路径列表。
/// 浏览器安全模型不给绝对路径（只给 name/相对路径），桌面壳场景用 Tauri
/// dialog 更合适；这里仅作拖拽路径兜底，真正的路径来自 webkitRelativePath
/// 或 Tauri onDragDropEvent 的 paths。
export function pickPaths(inputEl) {
  return [...(inputEl.files || [])].map((f) => f.name);
}
