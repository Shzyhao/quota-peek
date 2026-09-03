import './styles.css';
import { createRepository } from './core/storage.js';
import { createLogger } from './core/logger.js';
import { createQuotaService } from './core/service.js';
import { initTheme } from './core/theme.js';
import { renderApp } from './ui/app.js';
import { renderMini } from './ui/mini.js';
import { renderBall } from './ui/ball.js';

initTheme();

const root = document.querySelector('#app');
const repo = createRepository();
const logger = createLogger(repo);
const service = createQuotaService({ repo, logger });

// 三种入口：浏览器弹窗用 ?view=mini 查询参数；桌面壳迷你窗/悬浮球用 #mini/#ball 哈希（查询参数在 WebView 内嵌资产下会被剥离）
const view = new URLSearchParams(window.location.search).get('view')
  || (window.location.hash === '#mini' ? 'mini' : null)
  || (window.location.hash === '#ball' ? 'ball' : null);
if (view === 'mini') {
  renderMini({ root, repo, logger, service });
} else if (view === 'ball') {
  renderBall({ root, repo, logger, service });
} else {
  renderApp({ root, repo, logger, service });
}
