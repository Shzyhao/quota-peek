import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRepository, memoryStorage, normalizeProviderConfig } from '../src/core/storage.js';
import { renderBall } from '../src/ui/ball.js';

const NOW = new Date().toISOString();

const deepseek = (overrides = {}) =>
  normalizeProviderConfig({
    name: 'DeepSeek 主账号',
    type: 'deepseek',
    apiKey: 'sk-abcdefghijklmnop',
    baseUrl: 'https://api.deepseek.com',
    ...overrides,
  });

function seedBall(providers) {
  const repo = createRepository(memoryStorage());
  providers.forEach((p) => repo.saveProvider(p));
  const root = document.createElement('div');
  document.body.appendChild(root);
  renderBall({ root, repo });
  return { root, repo };
}

describe('悬浮球视图（#ball）', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('ball-mode');
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.documentElement.classList.remove('ball-mode');
  });

  it('无供应商：显示 0 家供应商，正常配色，并进入透明模式', () => {
    const { root } = seedBall([]);
    expect(root.querySelector('.ball.level-ok')).toBeTruthy();
    expect(root.querySelector('.ball-num').textContent).toBe('0');
    expect(root.querySelector('.ball-label').textContent).toBe('供应商');
    expect(document.documentElement.classList.contains('ball-mode')).toBe(true);
  });

  it('有余额数据：球内显示余额合计', () => {
    const { root } = seedBall([
      deepseek({ lastQuery: { status: 'ok', time: NOW, balance: 110.5, currency: 'CNY' } }),
      deepseek({ id: 'p2', name: 'Kimi', lastQuery: { status: 'ok', time: NOW, balance: 89.5, currency: 'CNY' } }),
    ]);
    expect(root.querySelector('.ball-num').textContent).toBe('¥200');
    expect(root.querySelector('.ball-label').textContent).toBe('余额');
  });

  it('大额余额压缩为 x.x万 显示', () => {
    const { root } = seedBall([
      deepseek({ lastQuery: { status: 'ok', time: NOW, balance: 112699.9, currency: 'CNY' } }),
    ]);
    expect(root.querySelector('.ball-num').textContent).toBe('11.3万');
  });

  it('亿级余额压缩为 x.x亿 显示', () => {
    const { root } = seedBall([
      deepseek({ lastQuery: { status: 'ok', time: NOW, balance: 123456789, currency: 'CNY' } }),
    ]);
    expect(root.querySelector('.ball-num').textContent).toBe('1.2亿');
  });

  it('低值提醒（余额过低）：优先显示需关注数量并使用琥珀配色', () => {
    const { root } = seedBall([
      deepseek({ lastQuery: { status: 'ok', time: NOW, balance: 5, currency: 'CNY' } }),
      deepseek({ id: 'p2', name: 'Kimi', lastQuery: { status: 'ok', time: NOW, balance: 500, currency: 'CNY' } }),
    ]);
    expect(root.querySelector('.ball.level-warn')).toBeTruthy();
    expect(root.querySelector('.ball-num').textContent).toBe('1');
    expect(root.querySelector('.ball-label').textContent).toBe('需关注');
  });

  it('查询失败（异常）：使用红色配色', () => {
    const { root } = seedBall([
      deepseek({ lastQuery: { status: 'failed', time: NOW, error: '401 Unauthorized' } }),
      deepseek({ id: 'p2', name: 'Kimi', lastQuery: { status: 'ok', time: NOW, balance: 5, currency: 'CNY' } }),
    ]);
    // 异常与低值同时存在时取最严重级别 → 红
    expect(root.querySelector('.ball.level-error')).toBeTruthy();
    expect(root.querySelector('.ball-num').textContent).toBe('2');
  });

  it('网页版无 __TAURI__ 时点击不报错', () => {
    const { root } = seedBall([]);
    const ball = root.querySelector('.ball');
    expect(() => {
      ball.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      ball.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }).not.toThrow();
  });

  it('桌面壳环境：原地按下松开触发 ball-clicked 事件，移动超过阈值则视为拖动不触发', () => {
    const emitted = [];
    globalThis.__TAURI__ = { event: { emit: (name) => emitted.push(name) } };
    try {
      const { root } = seedBall([]);
      const ball = root.querySelector('.ball');
      // 原地单击 → 触发展开
      ball.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      ball.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(emitted).toEqual(['ball-clicked']);
      // 移动超过阈值 → 判定为拖动（startDragging），不触发单击
      globalThis.__TAURI__.window = { getCurrentWindow: () => ({ startDragging: () => emitted.push('dragging') }) };
      ball.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 10, clientY: 10, screenX: 100, screenY: 100, bubbles: true }));
      root.dispatchEvent(new MouseEvent('mousemove', { screenX: 140, screenY: 130, bubbles: true }));
      ball.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(emitted).toEqual(['ball-clicked', 'dragging']);
    } finally {
      delete globalThis.__TAURI__;
    }
  });
});
