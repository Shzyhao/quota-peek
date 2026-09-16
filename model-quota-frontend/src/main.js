import './styles.css';
import { createRepository } from './core/storage.js';
import { createLogger } from './core/logger.js';
import { createQuotaService } from './core/service.js';
import { initTheme } from './core/theme.js';
import { secretsAvailable, readSecret, migrateSecretsToKeyring } from './core/secrets.js';
import { syncModelsAndQuota } from './core/models.js';
import { renderApp } from './ui/app.js';
import { renderMini } from './ui/mini.js';
import { renderBall } from './ui/ball.js';
import { renderPet } from './ui/pet.js';
import { renderChatPanel, renderAnalysisPanel, renderSchedulePanel, renderVoicePanel } from './ui/panels.js';
import { renderNoteWindow } from './ui/noteWindow.js';
import { isClipboardAvailable, startClipboardWatcher } from './core/notes.js';
import { startSessionPusher } from './core/phone.js';

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
const panelMatch = window.location.hash.match(/^#panel-(chat|analysis|schedule|voice)$/);
if (window.location.hash === '#note') {
  // 便签小窗（独立桌面便签：📌固定 / ×关闭）
  renderNoteWindow({ root });
} else if (panelMatch) {
  if (panelMatch[1] === 'chat') renderChatPanel({ root, repo });
  else if (panelMatch[1] === 'analysis') renderAnalysisPanel({ root, repo });
  else if (panelMatch[1] === 'schedule') renderSchedulePanel({ root, repo });
  else renderVoicePanel({ root, repo });
} else if (view === 'mini') {
  renderMini({ root, repo, logger, service });
} else if (view === 'ball') {
  renderBall({ root, repo, logger, service });
} else if (view === 'pet') {
  renderPet({ root, repo });
} else {
  // 主窗：桌面版先把存量明文密钥迁入系统凭据管理器（失败不阻塞，明文保留下次重试），
  // 再做模型配置 ↔ 额度查询双向同步（模型配置里加的 API 补进供应商列表，
  // 供应商里配好的 OpenAI 兼容 API 变成可切换的对话模型），最后渲染
  const boot = async () => {
    if (secretsAvailable()) {
      try {
        await migrateSecretsToKeyring(repo);
      } catch {
        /* 迁移失败继续明文运行 */
      }
      try {
        await syncModelsAndQuota(repo);
      } catch {
        /* 同步失败不阻塞启动，进「模型配置」页会再试 */
      }
      // 便签：主窗轮询剪贴板（最近 20 条）；手机关联：会话摘要推送到局域网服务
      if (isClipboardAvailable()) startClipboardWatcher();
      startSessionPusher();
    }
    renderApp({ root, repo, logger, service });
  };
  void boot();
}
