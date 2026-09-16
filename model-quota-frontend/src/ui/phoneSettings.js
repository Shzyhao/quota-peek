// 设置页「手机关联」卡：局域网只读查看服务 + 二维码。
// 开启后 Rust 起一个随机端口 HTTP 服务（仅内存、不落盘），手机扫码看最新对话
// 与桌宠形象；首次入站连接 Windows 防火墙可能弹授权，选「允许」即可。
// 二维码用 qrcode 包本地生成（无网络请求）。

import QRCode from 'qrcode';
import { phoneServerStart, phoneServerStop, phoneServerStatus } from '../core/phoneService.js';
import { isPhoneActive, setPhoneActive } from '../core/phone.js';

export function phoneSettingsCard() {
  return `
    <section class="settings-card" data-role="phone-card">
      <h3>手机关联</h3>
      <p class="settings-hint">在同一 Wi-Fi 下，用手机扫码或输入地址，即可在手机上查看最近的对话和桌宠形象（只读，约 3 秒刷新；内容只存在本机内存里，关闭即清空）。</p>
      <div class="phone-row">
        <button class="btn primary" data-role="phone-toggle">开启服务</button>
        <span class="settings-hint phone-status" data-role="phone-status">未开启</span>
      </div>
      <div class="phone-qr" data-role="phone-qr" hidden>
        <img data-role="phone-qr-img" alt="手机扫码访问" width="150" height="150">
        <div class="phone-addr">
          <span data-role="phone-addr"></span>
          <button class="btn small" data-role="phone-copy">复制地址</button>
        </div>
      </div>
      <p class="settings-hint">提示：首次开启时 Windows 防火墙可能弹窗，请选择「允许访问」（需勾选专用网络）。</p>
    </section>`;
}

export function mountPhoneCard(root) {
  const card = root.querySelector('[data-role="phone-card"]');
  if (!card) return;
  const $ = (sel) => root.querySelector(sel);
  let info = null; // {active, ip, port}

  function render() {
    const btn = $('[data-role="phone-toggle"]');
    const status = $('[data-role="phone-status"]');
    const qr = $('[data-role="phone-qr"]');
    if (!btn) return;
    const on = info?.active === true;
    btn.textContent = on ? '关闭服务' : '开启服务';
    btn.classList.toggle('danger', on);
    if (on) {
      status.textContent = `已开启 · ${info.ip}:${info.port}`;
      const url = `http://${info.ip}:${info.port}`;
      $('[data-role="phone-addr"]').textContent = url;
      qr.hidden = false;
      void QRCode.toDataURL(url, { width: 300, margin: 1, color: { dark: '#1f2329', light: '#ffffff' } })
        .then((dataUrl) => { $('[data-role="phone-qr-img"]').src = dataUrl; })
        .catch(() => {});
    } else {
      status.textContent = '未开启';
      qr.hidden = true;
    }
  }

  async function refresh() {
    try {
      info = await phoneServerStatus();
    } catch {
      info = { active: false };
    }
    render();
  }

  card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    if (role === 'phone-toggle') {
      btn.disabled = true;
      try {
        if (info?.active) {
          info = await phoneServerStop();
          setPhoneActive(false);
        } else {
          info = await phoneServerStart();
          setPhoneActive(info.active === true);
        }
      } catch {
        /* 状态刷新时回显 */
      }
      btn.disabled = false;
      render();
    } else if (role === 'phone-copy') {
      const addr = $('[data-role="phone-addr"]')?.textContent || '';
      try {
        await navigator.clipboard?.writeText?.(addr);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '复制地址'; }, 1000);
      } catch {
        /* 剪贴板不可用静默 */
      }
    }
  });

  // 服务意外停止（如绑定失败）时状态回显；重挂载时清掉上一轮的定时器
  if (globalThis.__zkPhoneTick) clearInterval(globalThis.__zkPhoneTick);
  globalThis.__zkPhoneTick = setInterval(() => {
    if (isPhoneActive()) void refresh();
  }, 5000);
  void refresh();
}
