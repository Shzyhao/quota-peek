// 设置页「软件更新」卡：显示当前版本，手动检查更新；发现新版本后一键
// 下载安装（NSIS 静默升级）并重启。更新通道 = GitHub Releases latest.json
// （minisign 签名校验，公钥内置于应用）。

import {
  checkForUpdate, installUpdate, relaunchApp, currentVersion, updaterAvailable,
} from '../core/updater.js';
import { styledConfirm } from './confirm.js';

export function updaterCard() {
  return `
    <section class="settings-card" data-role="updater-card">
      <h3>软件更新</h3>
      <div class="updater-row">
        <span class="settings-hint">当前版本 <b data-role="updater-current">…</b></span>
        <button class="btn" data-role="updater-check">检查更新</button>
      </div>
      <p class="settings-hint" data-role="updater-status">应用启动时每天自动检查一次；也可以手动检查。更新经 minisign 签名校验，从 GitHub Releases 下载。</p>
    </section>`;
}

export function mountUpdaterCard(root) {
  const card = root.querySelector('[data-role="updater-card"]');
  if (!card) return;
  const $ = (sel) => root.querySelector(sel);
  const status = $('[data-role="updater-status"]');
  const checkBtn = $('[data-role="updater-check"]');
  const setStatus = (text) => { status.textContent = text; };
  let busy = false;

  // getVersion() 返回 Promise：异步填充（doCheck 里也经 curRef 读取）
  let cur = '';
  Promise.resolve(currentVersion()).then((v) => {
    cur = v || '';
    const node = $('[data-role="updater-current"]');
    if (node) node.textContent = cur || '（桌面版）';
  }).catch(() => {});
  if (!updaterAvailable()) {
    checkBtn.disabled = true;
    setStatus('网页版不支持应用内更新，请到 GitHub Releases 下载。');
    return;
  }

  async function doCheck({ silent = false } = {}) {
    if (busy) return;
    busy = true;
    checkBtn.disabled = true;
    if (!silent) setStatus('检查中…');
    const result = await checkForUpdate();
    checkBtn.disabled = false;
    busy = false;
    if (!result.available) {
      if (!silent) setStatus(`✓ 已是最新版本${cur ? `（v${cur}）` : ''}`);
      return;
    }
    setStatus(`发现新版本 v${result.version}`);
    const ok = await styledConfirm({
      mount: document.body,
      title: `发现新版本 v${result.version}`,
      message: `当前 v${cur || '？'} → 新版 v${result.version}\n\n${result.notes || '立即下载并安装更新？安装完成后应用会自动重启。'}`,
      confirmText: '立即更新',
      cancelText: '稍后',
    });
    if (!ok) { setStatus(`新版本 v${result.version} 可用，可随时点「检查更新」升级`); return; }
    checkBtn.disabled = true;
    setStatus('下载更新中…');
    try {
      await installUpdate({
        onProgress: (p) => setStatus(p >= 1 ? '下载完成，正在安装…' : `下载更新中… ${Math.round(p * 100)}%`),
      });
      setStatus('安装完成，正在重启…');
      await relaunchApp();
    } catch (err) {
      setStatus(`✗ 更新失败：${String(err?.message || err)}（可到 GitHub Releases 手动下载）`);
      checkBtn.disabled = false;
    }
  }

  card.addEventListener('click', async (e) => {
    if (e.target.closest('[data-role="updater-check"]')) await doCheck();
  });

  // 启动后 3 秒静默检查一次（24h 节流由 core/updater.js 控制；检查不弹窗，
  // 仅在发现新版本时弹确认）
  setTimeout(() => void doCheck({ silent: true }), 3000);
}
