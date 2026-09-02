import './styles.css';
import { createRepository } from './core/storage.js';
import { createLogger } from './core/logger.js';
import { createQuotaService } from './core/service.js';
import { initTheme } from './core/theme.js';
import { renderApp } from './ui/app.js';
import { renderMini } from './ui/mini.js';

initTheme();

const root = document.querySelector('#app');
const repo = createRepository();
const logger = createLogger(repo);
const service = createQuotaService({ repo, logger });

// 两种迷你窗入口：浏览器弹窗用 ?view=mini 查询参数；Tauri 桌面壳用 #mini 哈希（查询参数在 WebView 内嵌资产下不可靠）
const view = new URLSearchParams(window.location.search).get('view')
  || (window.location.hash === '#mini' ? 'mini' : null);
if (view === 'mini') {
  renderMini({ root, repo, logger, service });
} else {
  renderApp({ root, repo, logger, service });
}
