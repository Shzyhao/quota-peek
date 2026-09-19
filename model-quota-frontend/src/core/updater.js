// 自动更新核心：Tauri updater 插件（minisign 签名 + GitHub Releases latest.json）。
// 手动「检查更新」按钮 + 启动静默检查（24h 节流）；发现新版本弹确认，同意后
// 下载安装（Windows 走 NSIS 安装器静默升级）并重启。
// 仅桌面版可用；网页版跳过。latest.json 尚未发布时 check() 报错按"无更新"处理。

const tauriCore = () => globalThis.__TAURI__?.core;

const LAST_CHECK_KEY = 'mqc.update.lastCheck';
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;

export function updaterAvailable() {
  return typeof tauriCore()?.invoke === 'function';
}

export function shouldAutoCheck(storage = globalThis.localStorage) {
  try {
    const last = Number(storage?.getItem(LAST_CHECK_KEY) || 0);
    return Date.now() - last > CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

export function markChecked(storage = globalThis.localStorage) {
  try {
    storage?.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

/// 检查更新。返回 { available, version, notes } 或 { available: false }；
/// 端点 404（尚无 latest.json）/网络失败一律降级为无更新，不视为错误。
export async function checkForUpdate() {
  if (!updaterAvailable()) return { available: false };
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return { available: false };
    markChecked();
    return {
      available: true,
      version: update.version || '',
      notes: String(update.body || '').slice(0, 500),
    };
  } catch {
    return { available: false };
  }
}

/// 下载并安装更新（完成后由调用方 relaunch 重启应用）。返回是否成功。
export async function installUpdate({ onProgress } = {}) {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return false;
  let contentLength;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      contentLength = event.data?.contentLength ?? 0;
    } else if (event.event === 'Progress') {
      received += event.data?.chunkLength ?? 0;
      onProgress?.(contentLength ? received / contentLength : 0);
    } else if (event.event === 'Finished') {
      onProgress?.(1);
    }
  });
  return true;
}

export async function relaunchApp() {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

export function currentVersion() {
  try {
    return globalThis.__TAURI__?.app?.getVersion?.() || '';
  } catch {
    return '';
  }
}
