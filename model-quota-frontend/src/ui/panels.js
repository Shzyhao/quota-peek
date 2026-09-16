// 独立功能弹窗（#panel-chat / #panel-analysis / #panel-schedule）：从桌宠气泡菜单打开的
// 小型功能窗，复用主窗对应页的自挂载组件；自绘标题栏（可拖动 + 收起按钮）。

import { chatView, mountChatPage } from './chatView.js';
import { analysisView, mountAnalysisPage } from './analysisView.js';
import { scheduleView, mountSchedulePage } from './scheduleView.js';
import { mountVoicePage } from './voiceView.js';

function panelShell(root, title, body) {
  document.documentElement.classList.add('panel-mode');
  root.innerHTML = `
    <div class="panel-shell">
      <header class="panel-head" data-role="panel-head">
        <b>${title}</b>
        <button class="panel-close" data-role="panel-close" title="收起（桌宠旁可再次打开）">✕</button>
      </header>
      <div class="panel-body"><div class="panel-root" data-role="panel-root"></div></div>
    </div>`;
  // 标题栏手动拖动：拖动起止通知桌面壳，桌宠按初始偏移跟随面板一起移动
  const head = root.querySelector('[data-role="panel-head"]');
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    globalThis.__TAURI__?.event?.emit?.('panel-drag-start');
    globalThis.__TAURI__?.window?.getCurrentWindow?.()?.startDragging?.();
  });
  globalThis.addEventListener?.('mouseup', () => {
    // 原生拖动循环内鼠标在窗外松开时本事件可能收不到——桌面壳在下次
    // panel-drag-start / open_panel 时会复位跟随状态，此处尽力而为
    globalThis.__TAURI__?.event?.emit?.('panel-drag-end');
  });
  root.querySelector('[data-role="panel-close"]').addEventListener('click', () => {
    globalThis.__TAURI__?.window?.getCurrentWindow?.()?.hide();
  });
}

export function renderChatPanel({ root, repo }) {
  panelShell(root, '对话 · 桌看', '');
  // 面板模式：只留会话与对话内容，模型/语音配置回主窗设置（panel 选项隐藏配置入口）
  mountChatPage(root.querySelector('[data-role="panel-root"]'), { repo, panel: true });
}

export function renderVoicePanel({ root, repo }) {
  panelShell(root, '语音对话 · 桌看', '');
  mountVoicePage(root.querySelector('[data-role="panel-root"]'), { repo });
}

export function renderAnalysisPanel({ root }) {
  panelShell(root, '文件分析 · 桌看', '');
  mountAnalysisPage(root.querySelector('[data-role="panel-root"]'));
}

export function renderSchedulePanel({ root, repo }) {
  panelShell(root, '日程 · 桌看', '');
  const host = root.querySelector('[data-role="panel-root"]');
  const mountPage = () => mountSchedulePage(host, { repo });
  mountPage();
  // 主窗改动跨窗同步：storage 事件只在本窗以外写入时触发，整页重挂载即可
  // （mountSchedulePage 的监听挂在自建子节点上，重挂载不堆积）
  globalThis.addEventListener?.('storage', (e) => {
    if (e?.key === 'mqc.schedules') mountPage();
  });
}
