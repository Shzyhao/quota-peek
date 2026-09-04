import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRepository, memoryStorage, normalizeProviderConfig } from '../src/core/storage.js';
import { createLogger } from '../src/core/logger.js';
import { createQuotaService } from '../src/core/service.js';
import { renderApp } from '../src/ui/app.js';
import { renderMini } from '../src/ui/mini.js';
import { PROVIDER_TYPES } from '../src/core/providers.js';
import { openProviderForm } from '../src/ui/form.js';

const okBody = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
};

const zhipuOk = {
  success: true,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, usage: 100000, currentValue: 32500, percentage: 32.5, nextResetTime: 1756848000000 },
      { type: 'TOKENS_LIMIT', unit: 6, usage: 500000, currentValue: 225000, percentage: 45, nextResetTime: 1757366400000 },
      { type: 'TIME_LIMIT', unit: 0, usage: 100, currentValue: 24, percentage: 24 },
    ],
  },
};

function seedApp(providers, { view } = {}) {
  const repo = createRepository(memoryStorage());
  providers.forEach((p) => repo.saveProvider(p));
  const logger = createLogger(repo);
  const service = createQuotaService({ repo, logger });
  window.location.hash = view ? `#/${view}` : '#/overview';
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = renderApp({ root, repo, logger, service });
  return { root, repo, logger, service, app };
}

const deepseek = (overrides = {}) =>
  normalizeProviderConfig({
    name: 'DeepSeek 主账号',
    type: 'deepseek',
    apiKey: 'sk-abcdefghijklmnop',
    baseUrl: 'https://api.deepseek.com',
    planTotalQuota: '300',
    usedQuota: '90',
    ...overrides,
  });

const zhipu = (overrides = {}) =>
  normalizeProviderConfig({
    name: '智谱 Coding Plan',
    type: 'zhipu',
    apiKey: 'zp-zhipu-key-0001',
    baseUrl: 'https://open.bigmodel.cn',
    ...overrides,
  });

beforeEach(() => {
  document.body.innerHTML = '';
  window.location.hash = '#/overview';
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function navTo(root, view) {
  root.querySelector(`[data-action="nav"][data-view="${view}"]`).click();
}

describe('应用壳与导航', () => {
  it('总览页渲染侧边栏、统计卡与供应商卡片，API Key 脱敏', () => {
    const { root } = seedApp([deepseek()]);

    // 侧边栏四个导航项
    const navs = root.querySelectorAll('[data-action="nav"]');
    expect(navs.length).toBe(4);

    // 统计卡
    for (const label of ['余额合计', '供应商', '需要关注', '最近刷新']) {
      expect(root.innerHTML).toContain(label);
    }

    // 卡片脱敏
    expect(root.innerHTML).toContain('sk-a••••••mnop');
    expect(root.innerHTML).not.toContain('sk-abcdefghijklmnop');

    // 卡片必填展示字段（需求第 5 条）
    for (const label of ['余额', '剩余额度', '已用额度', '套餐总额度', '到期时间', '查询状态', '最后更新', 'API Key']) {
      expect(root.innerHTML).toContain(label);
    }
  });

  it('导航切换：供应商（搜索/筛选）、日志、设置', () => {
    const { root } = seedApp([deepseek()]);

    navTo(root, 'providers');
    expect(root.querySelector('[data-search]')).toBeTruthy();
    expect(root.querySelector('[data-filter-status]')).toBeTruthy();
    expect(root.querySelector('[data-action="nav"][data-view="providers"]').classList.contains('active')).toBe(true);
    expect(root.querySelector('[data-role="view-title"]').textContent).toBe('供应商');

    navTo(root, 'logs');
    expect(root.innerHTML).toContain('暂无查询日志');

    navTo(root, 'settings');
    expect(root.querySelector('[data-setting-theme]')).toBeTruthy();
    expect(root.querySelector('[data-action="export-backup"]')).toBeTruthy();
    expect(root.querySelector('[data-action="import-backup"]')).toBeTruthy();
    expect(root.querySelector('[data-role="import-file"]')).toBeTruthy();
    expect(root.querySelector('[data-action="clear-all"]')).toBeTruthy();
  });

  it('余额型供应商有剩余额度进度条（300 总额 / 210 剩余 = 70%）', () => {
    const { root } = seedApp([deepseek()]);
    const fill = root.querySelector('.card .progress .fill');
    expect(fill).toBeTruthy();
    expect(fill.style.width).toBe('70%');
  });
});

describe('搜索与筛选（供应商页）', () => {
  it('关键词搜索实时过滤卡片并保持输入焦点', () => {
    const { root } = seedApp([
      deepseek(),
      deepseek({ id: 'p2', name: 'OpenAI 团队号', type: 'custom', apiKey: '', note: '手动维护' }),
    ]);
    navTo(root, 'providers');
    expect(root.querySelectorAll('.card').length).toBe(2);

    const search = root.querySelector('[data-search]');
    search.value = '团队';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    const cards = root.querySelectorAll('.card');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector('.card-title strong').textContent).toBe('OpenAI 团队号');
    expect(root.innerHTML).toContain('1 / 2 家');
    // 局部刷新后输入框仍在（未被整体重绘破坏）
    expect(root.querySelector('[data-search]').value).toBe('团队');
  });

  it('状态筛选：只看需要关注', () => {
    const { root } = seedApp([
      deepseek(), // 正常
      deepseek({ id: 'p2', name: '低余额号', lastQuery: { time: 'x', status: 'ok', balance: 3, currency: 'CNY', error: null } }),
    ]);
    navTo(root, 'providers');

    const select = root.querySelector('[data-filter-status]');
    select.value = 'attention';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const cards = root.querySelectorAll('.card');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector('.card-title strong').textContent).toBe('低余额号');
  });
});

describe('一键刷新与日志（真实交互流）', () => {
  it('点击「一键刷新全部」：调用官方接口，卡片余额更新、日志生成、进度条变化', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okBody });
    vi.stubGlobal('fetch', fetchImpl);

    const { root, logger } = seedApp([deepseek()]);
    root.querySelector('[data-action="refresh-all"]').click();

    await vi.waitFor(() => {
      expect(root.innerHTML).toContain('¥110.00');
      expect(logger.list()).toHaveLength(1);
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.deepseek.com/user/balance',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer sk-abcdefghijklmnop' } }),
    );
    expect(JSON.stringify(logger.list())).not.toContain('sk-abcdefghijklmnop');

    // 刷新完成后按钮恢复可用（非 busy）
    expect(root.querySelector('[data-action="refresh-all"]').disabled).toBe(false);

    // 日志页展示需求第 8 条要求的列
    navTo(root, 'logs');
    for (const col of ['查询时间', '供应商', '状态', '余额', '剩余额度', '错误信息']) {
      expect(root.innerHTML).toContain(col);
    }
    expect(root.innerHTML).toContain('DeepSeek 主账号');
  });

  it('查询失败时卡片红色异常并展示错误原因', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const { root } = seedApp([deepseek()]);
    root.querySelector('[data-action="refresh-all"]').click();

    await vi.waitFor(() => {
      expect(root.innerHTML).toContain('查询失败');
      expect(root.innerHTML).toContain('API Key 无效');
    });
    expect(root.querySelector('.card').className).toContain('level-error');
  });

  it('智谱 Coding Plan：用量指标 + 双进度条 + 套餐详情', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => zhipuOk }));

    const { root } = seedApp([zhipu()]);
    root.querySelector('[data-action="refresh-all"]').click();

    await vi.waitFor(() => {
      expect(root.innerHTML).toContain('32.5%');
    });

    expect(root.innerHTML).toContain('近 5 小时用量');
    expect(root.innerHTML).toContain('本周用量');
    expect(root.innerHTML).toContain('本周已用');
    expect(root.innerHTML).toContain('本周总额');
    expect(root.innerHTML).toContain('225,000'); // 本周已用数值（formatNumber 千分位分组）
    expect(root.innerHTML).toContain('500,000'); // 本周总额数值
    expect(root.innerHTML).toContain('套餐详情');
    expect(root.innerHTML).toContain('周额度重置于');
    const fills = root.querySelectorAll('.card .progress .fill');
    expect(fills.length).toBe(3); // 5h + 本周 + 本月 MCP
    expect(fills[0].style.width).toBe('32.5%');
    expect(fills[1].style.width).toBe('45%');
    expect(root.innerHTML).not.toContain('zp-zhipu-key-0001');
  });

  it('不支持自动查询的供应商：标记展示且「刷新」禁用', () => {
    const { root } = seedApp([deepseek({ type: 'custom', apiKey: '', name: '手动维护的供应商' })]);

    expect(root.innerHTML).toContain('不支持自动查询');
    const refreshBtn = root.querySelector('[data-action="refresh"]');
    expect(refreshBtn.disabled).toBe(true);
  });
});

describe('危险操作走样式化确认弹窗', () => {
  it('删除供应商：确认后移除，取消则保留', async () => {
    const { root, repo } = seedApp([deepseek()]);

    root.querySelector('[data-action="delete"]').click();
    const overlay = document.querySelector('.confirm-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('.confirm-message').textContent).toContain('DeepSeek 主账号');

    // 先取消
    overlay.querySelector('[data-action="confirm-cancel"]').click();
    await vi.waitFor(() => expect(document.querySelector('.confirm-overlay')).toBeNull());
    expect(repo.listProviders()).toHaveLength(1);

    // 再确认删除
    root.querySelector('[data-action="delete"]').click();
    document.querySelector('[data-action="confirm-accept"]').click();
    await vi.waitFor(() => expect(repo.listProviders()).toHaveLength(0));
    expect(root.innerHTML).toContain('还没有供应商');
  });

  it('清空日志：确认后清空', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okBody }));
    const { root, logger } = seedApp([deepseek()]);

    root.querySelector('[data-action="refresh-all"]').click();
    await vi.waitFor(() => expect(logger.list()).toHaveLength(1));

    navTo(root, 'logs');
    root.querySelector('[data-action="clear-logs"]').click();
    document.querySelector('[data-action="confirm-accept"]').click();

    await vi.waitFor(() => {
      expect(logger.list()).toHaveLength(0);
      expect(root.innerHTML).toContain('暂无查询日志');
    });
  });

  it('清空全部数据：确认后回到空状态', async () => {
    const { root, repo } = seedApp([deepseek()]);
    navTo(root, 'settings');

    root.querySelector('[data-action="clear-all"]').click();
    document.querySelector('[data-action="confirm-accept"]').click();

    await vi.waitFor(() => {
      expect(repo.listProviders()).toHaveLength(0);
    });
    navTo(root, 'overview');
    expect(root.innerHTML).toContain('还没有供应商');
  });
});

describe('设置：主题与阈值', () => {
  it('切换深色主题：<html data-theme> 与持久化同步', () => {
    const { root } = seedApp([deepseek()]);
    navTo(root, 'settings');

    const select = root.querySelector('[data-setting-theme]');
    select.value = 'dark';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('mqc.theme')).toBe('dark');
  });

  it('顶栏快捷键循环切换主题 auto → light → dark', () => {
    const { root } = seedApp([deepseek()]);

    root.querySelector('[data-action="theme-cycle"]').click();
    expect(localStorage.getItem('mqc.theme')).toBe('light');
    root.querySelector('[data-action="theme-cycle"]').click();
    expect(localStorage.getItem('mqc.theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('修改提醒阈值即时生效并持久化', () => {
    const { root, repo } = seedApp([deepseek()]);
    navTo(root, 'settings');

    const input = root.querySelector('[data-setting="lowBalanceThreshold"]');
    input.value = '25';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(repo.loadSettings().lowBalanceThreshold).toBe(25);
  });
});

describe('备份导入（UI 逻辑）', () => {
  it('导入合法备份：确认覆盖后数据生效', async () => {
    const { root, repo, app } = seedApp([]);

    const backupText = JSON.stringify({
      app: 'model-quota-frontend',
      version: 1,
      providers: [{ id: 'imp1', name: '导入的供应商', type: 'custom' }],
      logs: [],
      settings: { lowBalanceThreshold: 30 },
    });

    // 先拿到 Promise（内部等待覆盖确认），再点击确认，最后 await
    const done = app.importFromText(backupText);
    const overlay = document.querySelector('.confirm-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('.confirm-message').textContent).toContain('1 个供应商');
    overlay.querySelector('[data-action="confirm-accept"]').click();

    expect(await done).toBe(true);
    await vi.waitFor(() => {
      expect(repo.listProviders().map((p) => p.name)).toEqual(['导入的供应商']);
    });
    expect(repo.loadSettings().lowBalanceThreshold).toBe(30);
    expect(root.innerHTML).toContain('导入的供应商');
  });

  it('导入非法文件：提示错误且数据不变', async () => {
    const { repo, app } = seedApp([deepseek()]);

    const okP = app.importFromText('{broken json');
    // 错误提示弹窗点「知道了」
    const accept = document.querySelector('[data-action="confirm-accept"]');
    accept.click();
    expect(await okP).toBe(false);
    expect(repo.listProviders()).toHaveLength(1);
  });
});

describe('添加/编辑表单', () => {
  it('通过顶栏「添加供应商」保存后卡片出现', () => {
    const { root, repo } = seedApp([]);
    root.querySelector('[data-action="add"]').click();

    const modal = document.querySelector('.modal-overlay');
    const $ = (name) => modal.querySelector(`[name="${name}"]`);
    $('name').value = '新供应商';
    $('type').value = 'custom';
    modal.querySelector('[data-action="save"]').click();

    expect(root.innerHTML).toContain('新供应商');
    expect(root.innerHTML).toContain('不支持自动查询');
    expect(repo.listProviders()).toHaveLength(1);
  });

  it('名称为空时不允许保存并提示', () => {
    const onSave = vi.fn();
    openProviderForm({ mount: document.body, providerTypes: PROVIDER_TYPES, existing: null, onSave });

    const modal = document.querySelector('.modal-overlay');
    modal.querySelector('[data-action="save"]').click();

    expect(onSave).not.toHaveBeenCalled();
    expect(modal.querySelector('[data-error]').textContent).toContain('供应商名称');
  });

  it('支持自动查询的类型缺少 API Key 时阻止保存', () => {
    const onSave = vi.fn();
    openProviderForm({ mount: document.body, providerTypes: PROVIDER_TYPES, existing: null, onSave });

    const modal = document.querySelector('.modal-overlay');
    modal.querySelector('[name="name"]').value = '没有密钥的 DeepSeek';
    modal.querySelector('[data-action="save"]').click();

    expect(onSave).not.toHaveBeenCalled();
    expect(modal.querySelector('[data-error]').textContent).toContain('API Key');
  });

  it('编辑已有供应商：密钥留空表示沿用原密钥，界面不回显明文', () => {
    const onSave = vi.fn();
    const existing = deepseek({ note: '生产环境' });
    openProviderForm({ mount: document.body, providerTypes: PROVIDER_TYPES, existing, onSave });

    const modal = document.querySelector('.modal-overlay');
    const keyInput = modal.querySelector('[name="apiKey"]');

    expect(keyInput.value).toBe(''); // 不回显明文
    expect(modal.innerHTML).not.toContain('sk-abcdefghijklmnop');
    expect(modal.innerHTML).toContain('sk-a••••••mnop');

    modal.querySelector('[data-action="save"]').click();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '' }));
  });

  it('火山方舟类型：显示双凭证字段，缺少 Secret 时阻止保存', () => {
    const onSave = vi.fn();
    openProviderForm({ mount: document.body, providerTypes: PROVIDER_TYPES, existing: null, onSave });

    const modal = document.querySelector('.modal-overlay');
    const $ = (name) => modal.querySelector(`[name="${name}"]`);

    // 默认（DeepSeek）不显示 Secret 字段
    expect(modal.querySelector('[data-role="secret-field"]').hidden).toBe(true);

    // 切到火山方舟：标签与 Secret 字段出现
    const typeSelect = $('type');
    typeSelect.value = 'volcengine';
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modal.querySelector('[data-role="secret-field"]').hidden).toBe(false);
    expect(modal.querySelector('[data-role="api-label"]').textContent).toBe('AccessKey ID（IAM）');
    expect(modal.querySelector('[name="baseUrl"]').value).toBe('https://open.volcengineapi.com');

    // 只填 AK 不填 SK → 阻止
    $('name').value = '火山方舟 Coding';
    $('apiKey').value = 'AKLT-demo-0001';
    modal.querySelector('[data-action="save"]').click();
    expect(onSave).not.toHaveBeenCalled();
    expect(modal.querySelector('[data-error]').textContent).toContain('Secret Access Key');

    // 双凭证齐全 → 保存
    $('apiSecret').value = 'sk-volc-demo-secret';
    modal.querySelector('[data-action="save"]').click();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'AKLT-demo-0001', apiSecret: 'sk-volc-demo-secret' }));
  });

  it('火山方舟卡片：AK 与 SK 均脱敏显示', () => {
    const volc = deepseek({
      name: '火山方舟套餐',
      type: 'volcengine',
      apiKey: 'AKLT-demo-0001',
      apiSecret: 'sk-volc-demo-secret-0002',
    });
    const { root } = seedApp([volc]);

    expect(root.innerHTML).toContain('AKLT••••••0001');
    expect(root.innerHTML).toContain('sk-v••••••0002');
    expect(root.innerHTML).toContain('Secret Key');
    expect(root.innerHTML).not.toContain('sk-volc-demo-secret-0002');
  });

  it('取消按钮关闭弹窗且不回调', () => {
    const onSave = vi.fn();
    openProviderForm({ mount: document.body, providerTypes: PROVIDER_TYPES, existing: null, onSave });

    const modal = document.querySelector('.modal-overlay');
    modal.querySelector('[data-action="cancel"]').click();

    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});

describe('迷你小窗口视图', () => {
  it('紧凑展示余额与状态点，主题跟随全局', () => {
    localStorage.setItem('mqc.theme', 'dark');
    const repo = createRepository(memoryStorage());
    repo.saveProvider(deepseek({ lastQuery: { time: '2026-09-01T02:00:00.000Z', status: 'ok', balance: 110, currency: 'CNY' } }));
    repo.saveProvider(deepseek({ id: 'p2', name: '手动供应商', type: 'custom', apiKey: '' }));
    const logger = createLogger(repo);
    const service = createQuotaService({ repo, logger });

    const root = document.createElement('div');
    document.body.appendChild(root);
    renderMini({ root, repo, logger, service });

    expect(root.innerHTML).toContain('DeepSeek 主账号');
    expect(root.innerHTML).toContain('¥110.00');
    expect(root.innerHTML).toContain('手动供应商');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull(); // renderMini 不主动改主题（由全局初始化）
    expect(root.querySelectorAll('.dot.level-ok, .dot.level-neutral').length).toBe(2);
  });

  it('迷你窗口刷新调用官方接口并显示用量进度条', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => zhipuOk });
    vi.stubGlobal('fetch', fetchImpl);

    const repo = createRepository(memoryStorage());
    repo.saveProvider(zhipu());
    const logger = createLogger(repo);
    const service = createQuotaService({ repo, logger });

    const root = document.createElement('div');
    document.body.appendChild(root);
    renderMini({ root, repo, logger, service });

    root.querySelector('[data-action="refresh-all"]').click();

    await vi.waitFor(() => {
      expect(root.innerHTML).toContain('32.5%');
    });
    expect(root.querySelector('.mini-bar .fill').style.width).toBe('32.5%');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('低额度提醒（弹窗 / 系统通知 / 关闭）', () => {
  const lowBalanceBody = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] };
  const okBodyHigh = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '500.00' }] };

  it('默认界面弹窗：刷新检测到告警弹窗，同一告警去重，恢复正常后重新计数', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => lowBalanceBody }));
    const { root } = seedApp([deepseek()]);
    root.querySelector('[data-action="refresh-all"]').click();
    await vi.waitFor(() => {
      const modal = document.querySelector('.confirm-modal');
      expect(modal).toBeTruthy();
      expect(modal.textContent).toContain('低额度提醒');
      expect(modal.textContent).toContain('DeepSeek 主账号');
      expect(modal.textContent).toContain('余额过低');
    });
    document.querySelector('.confirm-modal [data-action="confirm-accept"]').click();
    await vi.waitFor(() => expect(document.querySelector('.confirm-modal')).toBeFalsy());

    // 同一告警仍在：再刷新不重复弹窗
    root.querySelector('[data-action="refresh-all"]').click();
    await vi.waitFor(() => expect(root.innerHTML).toContain('¥5.00'));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('.confirm-modal')).toBeFalsy();

    // 恢复正常后重新计数：余额回升刷新不弹，再次跌破后重新弹窗
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => okBodyHigh }));
    root.querySelector('[data-action="refresh-all"]').click();
    await vi.waitFor(() => expect(root.innerHTML).toContain('¥500.00'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => lowBalanceBody }));
    root.querySelector('[data-action="refresh-all"]').click();
    await vi.waitFor(() => expect(document.querySelector('.confirm-modal')).toBeTruthy());
  });

  it('设置为系统通知：桌面壳 emit show-notify 且不弹界面弹窗；网页版回退弹窗', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => lowBalanceBody }));

    // 桌面壳环境：emit 事件、无 confirm-modal
    const emitted = [];
    globalThis.__TAURI__ = { event: { emit: (name, payload) => emitted.push([name, payload]) } };
    try {
      const { root } = seedApp([deepseek()], { view: 'settings' });
      const select = root.querySelector('[data-setting-alertmethod]');
      expect(select).toBeTruthy();
      select.value = 'notify';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(root.querySelector('[data-setting-alertmethod]').value).toBe('notify');

      root.querySelector('[data-action="refresh-all"]').click();
      await vi.waitFor(() => {
        const hit = emitted.find(([name]) => name === 'show-notify');
        expect(hit).toBeTruthy();
        expect(hit[1].title).toContain('低额度提醒');
        expect(hit[1].body).toContain('DeepSeek 主账号');
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(document.querySelector('.confirm-modal')).toBeFalsy();
    } finally {
      delete globalThis.__TAURI__;
      document.body.innerHTML = '';
    }

    // 网页版（无 __TAURI__）选系统通知：回退界面弹窗
    const { root } = seedApp([deepseek()], { view: 'settings' });
    const select = root.querySelector('[data-setting-alertmethod]');
    select.value = 'notify';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    root.querySelector('[data-action="refresh-all"]').click();
    await vi.waitFor(() => expect(document.querySelector('.confirm-modal')).toBeTruthy());
  });

  it('设置为关闭：刷新出告警不提醒', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => lowBalanceBody }));
    const { root } = seedApp([deepseek()], { view: 'settings' });
    const select = root.querySelector('[data-setting-alertmethod]');
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    navTo(root, 'overview');
    root.querySelector('[data-action="refresh-all"]').click();
    await vi.waitFor(() => expect(root.innerHTML).toContain('¥5.00'));
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector('.confirm-modal')).toBeFalsy();
  });
});

describe('桌面悬浮球开关（顶栏按钮 + 设置页）', () => {
  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  it('网页版（无 __TAURI__）：顶栏不渲染悬浮球按钮，设置页不显示悬浮球开关', () => {
    const { root } = seedApp([], { view: 'settings' });
    expect(root.querySelector('[data-action="toggle-ball"]')).toBeNull();
    expect(root.querySelector('[data-ball-toggle]')).toBeNull();
  });

  it('桌面版：状态广播驱动按钮高亮与设置页开关同步；点击/勾选发出 set-ball', async () => {
    const emitted = [];
    const handlers = {};
    globalThis.__TAURI__ = {
      event: {
        emit: (name, payload) => emitted.push([name, payload]),
        listen: async (name, handler) => {
          handlers[name] = handler;
          return () => {};
        },
      },
    };
    const { root } = seedApp([], { view: 'settings' });
    // 启动时请求一次当前状态
    expect(emitted).toContainEqual(['ball-state-request', undefined]);
    // 后端广播「开启」→ 设置页开关勾选
    await handlers['ball-state-changed']({ payload: true });
    expect(root.querySelector('[data-ball-toggle]').checked).toBe(true);
    // 取消勾选 → set-ball(false)
    const toggle = root.querySelector('[data-ball-toggle]');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(emitted).toContainEqual(['set-ball', false]);
    // 广播「关闭」→ 开关取消；顶栏按钮（切回总览）不带 active
    await handlers['ball-state-changed']({ payload: false });
    expect(root.querySelector('[data-ball-toggle]').checked).toBe(false);
    window.location.hash = '#/overview';
    root.dispatchEvent(new Event('hashchange'));
    const btn = root.querySelector('[data-action="toggle-ball"]');
    expect(btn).toBeTruthy();
    expect(btn.classList.contains('active')).toBe(false);
    // 点击顶栏按钮 → set-ball(true)（当前关闭，切换为开）
    btn.click();
    expect(emitted).toContainEqual(['set-ball', true]);
  });
});
