// 主题管理：auto（跟随系统）/ light / dark，独立于业务设置存储。
// matchMedia 在 jsdom 等环境可能不存在，全部做了防御。

export const THEME_KEY = 'mqc.theme';
export const THEMES = ['auto', 'light', 'dark'];
export const THEME_LABELS = { auto: '跟随系统', light: '浅色', dark: '深色' };

function readStored() {
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY);
    return THEMES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function getStoredTheme() {
  return readStored();
}

export function setStoredTheme(theme) {
  if (!THEMES.includes(theme)) return;
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    // 存储不可用时仅本次会话生效
  }
}

export function prefersDark() {
  try {
    return typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  } catch {
    return false;
  }
}

export function resolveTheme(stored = readStored(), dark = prefersDark()) {
  return stored === 'auto' ? (dark ? 'dark' : 'light') : stored;
}

// 应用到 <html data-theme="light|dark">，CSS tokens 据此切换
export function applyTheme(stored = readStored()) {
  const resolved = resolveTheme(stored);
  globalThis.document?.documentElement?.setAttribute('data-theme', resolved);
  return resolved;
}

// 初始化：立即应用并监听系统主题变化（仅 auto 模式下跟随）
export function initTheme() {
  applyTheme();
  try {
    if (typeof globalThis.matchMedia === 'function') {
      const mq = globalThis.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        if (readStored() === 'auto') applyTheme();
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    }
  } catch {
    // 忽略：不支持时主题保持静态
  }
  return getStoredTheme();
}
