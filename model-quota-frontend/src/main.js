import './styles.css';
import { createRepository } from './core/storage.js';
import { createLogger } from './core/logger.js';
import { createQuotaService } from './core/service.js';
import { initTheme } from './core/theme.js';
import { renderApp } from './ui/app.js';
import { renderMini } from './ui/mini.js';
import { renderBall } from './ui/ball.js';
import { renderPet } from './ui/pet.js';
import { renderChatPanel, renderAnalysisPanel } from './ui/panels.js';

initTheme();

const root = document.querySelector('#app');
const repo = createRepository();
const logger = createLogger(repo);
const service = createQuotaService({ repo, logger });

// 入口路由：浏览器弹窗用 ?view=mini 查询参数；桌面壳各窗口用哈希区分
// （#mini 迷你速览 / #ball 经典悬浮球 / #pet 桌宠 / #panel-* 功能弹窗；
// 查询参数在 WebView 内嵌资产下会被剥离，故统一用哈希）
const view = new URLSearchParams(window.location.search).get('view')
  || (window.location.hash === '#mini' ? 'mini' : null)
  || (window.location.hash === '#ball' ? 'ball' : null)
  || (window.location.hash === '#pet' ? 'pet' : null);
const panelMatch = window.location.hash.match(/^#panel-(chat|analysis)$/);
if (panelMatch) {
  if (panelMatch[1] === 'chat') renderChatPanel({ root, repo });
  else renderAnalysisPanel({ root, repo });
} else if (view === 'mini') {
  renderMini({ root, repo, logger, service });
} else if (view === 'ball') {
  renderBall({ root, repo, logger, service });
} else if (view === 'pet') {
  renderPet({ root, repo });
} else {
  renderApp({ root, repo, logger, service });
}
