import './styles.css';
import { createRepository } from './core/storage.js';
import { createLogger } from './core/logger.js';
import { createQuotaService } from './core/service.js';
import { initTheme } from './core/theme.js';
import { secretsAvailable, readSecret, migrateSecretsToKeyring } from './core/secrets.js';
import { renderApp } from './ui/app.js';
import { renderMini } from './ui/mini.js';
import { renderBall } from './ui/ball.js';
import { renderPet } from './ui/pet.js';
import { renderChatPanel, renderAnalysisPanel } from './ui/panels.js';

initTheme();

const root = document.querySelector('#app');
const repo = createRepository();
const logger = createLogger(repo);
// 桌面版：刷新时经凭据管理器解析密钥（记录中只有 hasSecret 标记）；浏览器版走默认（记录明文字段）
const service = createQuotaService({
  repo,
  logger,
  resolveSecrets: secretsAvailable()
    ? async (cfg) => {
        if (!cfg.hasSecret) return { apiKey: cfg.apiKey || '', apiSecret: cfg.apiSecret || '' };
        try {
          const s = await readSecret(cfg.id);
          return { apiKey: s?.apiKey || '', apiSecret: s?.apiSecret || '' };
        } catch {
          return { apiKey: '', apiSecret: '' };
        }
      }
    : undefined,
});

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
  // 主窗：桌面版先把存量明文密钥迁入系统凭据管理器（失败不阻塞，明文保留下次重试），再渲染
  const boot = async () => {
    if (secretsAvailable()) {
      try {
        await migrateSecretsToKeyring(repo);
      } catch {
        /* 迁移失败继续明文运行 */
      }
    }
    renderApp({ root, repo, logger, service });
  };
  void boot();
}
