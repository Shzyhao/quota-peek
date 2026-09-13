import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeTrayStatus, updateTrayStatus } from '../src/ui/trayStatus.js';
import { createRepository, memoryStorage, normalizeProviderConfig } from '../src/core/storage.js';
import { defaultSettings } from '../src/core/status.js';

const settings = defaultSettings();

const usageProvider = (overrides = {}) =>
  normalizeProviderConfig({
    name: '智谱 Coding Plan',
    type: 'zhipu',
    apiKey: 'zp-key',
    ...overrides,
    lastQuery: {
      time: '2026-09-13T08:00:00.000Z',
      status: 'ok',
      balance: null,
      currency: null,
      usage: {
        windowUsedPercent: 32.5,
        weeklyUsedPercent: 45,
        monthlyUsedPercent: 24,
      },
      ...(overrides.lastQuery || {}),
    },
  });

const balanceProvider = (overrides = {}) =>
  normalizeProviderConfig({
    name: 'DeepSeek 主账号',
    type: 'deepseek',
    apiKey: 'sk-key',
    ...overrides,
    lastQuery: {
      time: '2026-09-13T08:00:00.000Z',
      status: 'ok',
      balance: 110,
      currency: 'CNY',
      usage: null,
      ...(overrides.lastQuery || {}),
    },
  });

describe('computeTrayStatus', () => {
  it('无供应商 → idle 灰、无角标', () => {
    const s = computeTrayStatus([], settings);
    expect(s.level).toBe('idle');
    expect(s.badge).toBeNull();
    expect(s.tooltip).toContain('桌看');
  });

  it('全部正常 → ok 绿；角标取用量型最高值（5h/周取大者）', () => {
    const s = computeTrayStatus([usageProvider(), balanceProvider()], settings);
    expect(s.level).toBe('ok');
    expect(s.badge).toBe(45); // max(32.5, 45)
  });

  it('低余额告警 → warn 琥珀，tooltip 列出供应商', () => {
    const p = balanceProvider({ lastQuery: { time: '2026-09-13T08:00:00.000Z', status: 'ok', balance: 5, currency: 'CNY', usage: null } });
    const s = computeTrayStatus([p], settings);
    expect(s.level).toBe('warn');
    expect(s.tooltip).toContain('1 项需关注');
    expect(s.tooltip).toContain('DeepSeek 主账号');
  });

  it('查询失败 → error 红', () => {
    const p = balanceProvider({ lastQuery: { time: '2026-09-13T08:00:00.000Z', status: 'failed', balance: null, currency: null, error: '401' } });
    expect(computeTrayStatus([p], settings).level).toBe('error');
  });

  it('停用供应商不参与级别与角标', () => {
    const p = usageProvider({ enabled: false });
    const s = computeTrayStatus([p], settings);
    expect(s.level).toBe('idle');
    expect(s.badge).toBeNull();
  });

  it('tooltip 超 128 字符截断（Windows 上限）', () => {
    const ps = Array.from({ length: 6 }, (_, i) =>
      balanceProvider({
        name: `很长很长的供应商名称测试用例第 ${i} 号账户`,
        lastQuery: { time: '2026-09-13T08:00:00.000Z', status: 'ok', balance: 5, currency: 'CNY', usage: null },
      }));
    const s = computeTrayStatus(ps, settings);
    expect(s.tooltip.length).toBeLessThanOrEqual(127);
  });
});

describe('updateTrayStatus', () => {
  let ctxStub;
  beforeEach(() => {
    // jsdom 无 2D 上下文：桩掉 getContext，验证绘制与 IPC 载荷
    const imageData = { data: new Uint8ClampedArray(32 * 32 * 4) };
    ctxStub = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      getImageData: () => imageData,
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStub);
  });

  afterEach(() => {
    delete globalThis.__TAURI__;
    vi.restoreAllMocks();
  });

  it('桌面版：绘制 32×32 RGBA 并调用 update_tray_status', () => {
    const invoke = vi.fn().mockResolvedValue(null);
    globalThis.__TAURI__ = { core: { invoke } };
    const repo = createRepository(memoryStorage());
    repo.saveProvider(usageProvider());

    updateTrayStatus(repo, settings);

    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invoke.mock.calls[0];
    expect(cmd).toBe('update_tray_status');
    expect(args.width).toBe(32);
    expect(args.height).toBe(32);
    expect(args.rgba).toHaveLength(32 * 32 * 4);
    expect(args.tooltip.length).toBeGreaterThan(0);
  });

  it('无用量数据（纯余额型）画三柱条而非数字，图标永不为纯色块', () => {
    const invoke = vi.fn().mockResolvedValue(null);
    globalThis.__TAURI__ = { core: { invoke } };
    const repo = createRepository(memoryStorage());
    repo.saveProvider(balanceProvider());

    updateTrayStatus(repo, settings);

    expect(ctxStub.fillText).not.toHaveBeenCalled();
    // 1 次底色圆角方块 + 3 根柱条
    expect(ctxStub.roundRect).toHaveBeenCalledTimes(4);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('网页版（无 __TAURI__）为空操作', () => {
    const repo = createRepository(memoryStorage());
    expect(() => updateTrayStatus(repo, settings)).not.toThrow();
  });
});
