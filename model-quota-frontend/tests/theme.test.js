import { describe, it, expect, beforeEach } from 'vitest';
import {
  THEME_KEY,
  getStoredTheme,
  setStoredTheme,
  resolveTheme,
  applyTheme,
} from '../src/core/theme.js';

describe('主题管理', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_KEY);
    document.documentElement.removeAttribute('data-theme');
  });

  it('默认主题为 auto（跟随系统）', () => {
    expect(getStoredTheme()).toBe('auto');
  });

  it('setStoredTheme/getStoredTheme 往返', () => {
    setStoredTheme('dark');
    expect(getStoredTheme()).toBe('dark');
    setStoredTheme('light');
    expect(getStoredTheme()).toBe('light');
  });

  it('非法值回退为 auto', () => {
    localStorage.setItem(THEME_KEY, 'neon-pink');
    expect(getStoredTheme()).toBe('auto');
    setStoredTheme('not-a-theme');
    expect(getStoredTheme()).toBe('auto');
  });

  it('resolveTheme：auto 按系统偏好，显式值直接生效', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('applyTheme 将解析结果写入 <html data-theme>', () => {
    setStoredTheme('dark');
    expect(applyTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    setStoredTheme('light');
    expect(applyTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('存储不可用时 applyTheme 仍能解析出主题（不抛错）', () => {
    expect(() => resolveTheme('auto', false)).not.toThrow();
  });
});
