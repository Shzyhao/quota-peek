import { getProviderType } from './providers.js';
import { sanitizeText } from './mask.js';
import { remainingQuotaOf } from './status.js';

// 刷新编排：
// - 支持自动查询的类型（当前为 DeepSeek）调用官方 API，成功/失败都更新 lastQuery 并写日志；
// - 不支持自动查询的类型只标记状态，不发起任何请求、不写日志（没有真正发生查询）；
// - 手动刷新单个 / 一键刷新全部 / 定时刷新（由 UI 层按设置调度 refreshAll）。
export function createQuotaService({ repo, logger, fetchImpl } = {}) {
  const getFetch = () => fetchImpl || globalThis.fetch;

  function markUnsupported(cfg) {
    const updated = {
      ...cfg,
      lastQuery: { time: new Date().toISOString(), status: 'unsupported', balance: null, currency: null, error: null },
    };
    repo.saveProvider(updated);
    return updated;
  }

  async function refreshProvider(id) {
    const cfg = repo.getProvider(id);
    if (!cfg) return null;
    const type = getProviderType(cfg.type);

    if (!type.autoQuery) {
      return cfg.lastQuery && cfg.lastQuery.status === 'unsupported' ? cfg : markUnsupported(cfg);
    }

    const time = new Date().toISOString();
    const secrets = [cfg.apiKey, cfg.apiSecret].filter(Boolean);
    try {
      const result = await type.query({
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        baseUrl: cfg.baseUrl || type.defaultBaseUrl,
        fetchImpl: getFetch(),
      });
      const updated = {
        ...cfg,
        lastQuery: {
          time,
          status: 'ok',
          balance: result.balance,
          currency: result.currency,
          isAvailable: result.isAvailable ?? null,
          usage: result.usage ?? null,
          extraLine: result.extraLine ?? null,
          error: null,
        },
      };
      repo.saveProvider(updated);
      logger.add(
        {
          providerId: cfg.id,
          providerName: cfg.name,
          time,
          status: 'ok',
          balance: result.balance,
          remainingQuota: remainingQuotaOf(updated),
          error: null,
        },
        [cfg.apiKey, cfg.apiSecret].filter(Boolean),
      );
      return updated;
    } catch (err) {
      const message = sanitizeText(err?.message || String(err), [cfg.apiKey, cfg.apiSecret].filter(Boolean));
      const updated = {
        ...cfg,
        lastQuery: { time, status: 'failed', balance: null, currency: null, usage: null, extraLine: null, error: message },
      };
      repo.saveProvider(updated);
      logger.add(
        {
          providerId: cfg.id,
          providerName: cfg.name,
          time,
          status: 'failed',
          balance: null,
          remainingQuota: remainingQuotaOf(updated),
          error: message,
        },
        [cfg.apiKey, cfg.apiSecret].filter(Boolean),
      );
      return updated;
    }
  }

  // 一键刷新：跳过已停用的供应商
  async function refreshAll() {
    const targets = repo.listProviders().filter((p) => p.enabled !== false);
    const results = await Promise.all(targets.map((p) => refreshProvider(p.id)));
    return results.filter(Boolean);
  }

  return { refreshProvider, refreshAll };
}
