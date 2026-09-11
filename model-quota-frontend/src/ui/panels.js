// 独立功能弹窗（#panel-chat / #panel-analysis）：从桌宠气泡菜单打开的
// 小型功能窗，复用主窗对应页的自挂载组件；自绘标题栏（可拖动 + 收起按钮）。

import { chatView, mountChatPage } from './chatView.js';
import { analysisView, mountAnalysisPage } from './analysisView.js';

function panelShell(root, title, body) {
  document.documentElement.classList.add('panel-mode');
  root.innerHTML = `
    <div class="panel-shell">
      <header class="panel-head">
        <b data-tauri-drag-region>${title}</b>
        <button class="panel-close" data-role="panel-close" title="收起（桌宠旁可再次打开）">✕</button>
      </header>
      <div class="panel-body"><div class="panel-root" data-role="panel-root"></div></div>
    </div>`;
  root.querySelector('[data-role="panel-close"]').addEventListener('click', () => {
    globalThis.__TAURI__?.window?.getCurrentWindow?.()?.hide();
  });
}

export function renderChatPanel({ root, repo }) {
  panelShell(root, '对话 · 桌看', '');
  mountChatPage(root.querySelector('[data-role="panel-root"]'), { repo });
}

export function renderAnalysisPanel({ root }) {
  panelShell(root, '文件分析 · 桌看', '');
  mountAnalysisPage(root.querySelector('[data-role="panel-root"]'));
}
