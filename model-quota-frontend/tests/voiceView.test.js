import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountVoicePage } from '../src/ui/voiceView.js';

describe('voiceView 语音对话面板', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    delete globalThis.__TAURI__;
  });

  function mount() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return mountVoicePage(root, { repo: { listProviders: () => [] } });
  }

  it('渲染骨架：大麦克风 / 会话选择 / 消息区 / 朗读开关', () => {
    mount();
    const mic = document.querySelector('[data-role="voice-mic"]');
    expect(mic).toBeTruthy();
    expect(mic.textContent.trim()).toBe('🎙');
    expect(document.querySelector('[data-role="voice-session"]')).toBeTruthy();
    expect(document.querySelector('[data-role="voice-messages"]')).toBeTruthy();
    expect(document.querySelector('[data-role="voice-read-toggle"]')).toBeTruthy();
    expect(document.querySelector('[data-role="voice-status"]').textContent).toContain('点一下麦克风');
  });

  it('挂载即消费待激活标记（桌宠菜单「语音对话」自动开录入口）', async () => {
    localStorage.setItem('mqc.voice.pendingActivate', String(Date.now()));
    mount();
    // 标记被同步移除（所有权归语音面板，chatView 不再消费）
    expect(localStorage.getItem('mqc.voice.pendingActivate')).toBeNull();
    // 无语音服务配置环境：给出配置指引而非自动开录
    await vi.waitFor(() => {
      expect(document.querySelector('[data-role="voice-status"]').textContent).toContain('语音服务');
    });
  });

  it('过期标记不消费', () => {
    const stale = String(Date.now() - 61 * 1000);
    localStorage.setItem('mqc.voice.pendingActivate', stale);
    mount();
    expect(localStorage.getItem('mqc.voice.pendingActivate')).toBe(stale);
  });

  it('朗读开关切换并持久化', () => {
    mount();
    const toggle = document.querySelector('[data-role="voice-read-toggle"]');
    const before = toggle.classList.contains('active');
    toggle.click();
    expect(toggle.classList.contains('active')).toBe(!before);
    const cfg = JSON.parse(localStorage.getItem('mqc.voice.config') || '{}');
    expect(cfg.autoRead).toBe(!before);
  });
});
