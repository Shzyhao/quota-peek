import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountModelsPage } from '../src/ui/modelsView.js';
import { normalizeProviderConfig } from '../src/core/storage.js';

// 模型配置页测试：invoke 状态化 stub（chat_get/save_config 反映内存态，模拟 Rust 持久化）
function stubTauri() {
  let cfgState = { profiles: [], active_profile_id: null, active_model: null, persona: '' };
  const calls = { setKey: [], deleteKey: [], copyKey: [], saveCfg: [] };
  globalThis.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd, args) => {
        if (cmd === 'chat_get_config') return JSON.parse(JSON.stringify(cfgState));
        if (cmd === 'chat_save_config') { calls.saveCfg.push(args.cfg); cfgState = JSON.parse(JSON.stringify(args.cfg)); return null; }
        if (cmd === 'chat_set_key') { calls.setKey.push(args); return null; }
        if (cmd === 'chat_has_key') return true;
        if (cmd === 'chat_delete_key') { calls.deleteKey.push(args); return null; }
        if (cmd === 'chat_copy_key') { calls.copyKey.push(args); return true; }
        if (cmd === 'voice_secret_has') return false;
        return null;
      }),
      Channel: vi.fn(),
    },
    event: { emit: vi.fn(), listen: vi.fn(async () => () => {}) },
  };
  return { calls, setCfg: (c) => { cfgState = JSON.parse(JSON.stringify(c)); } };
}

function makeRepo() {
  let list = [];
  return {
    listProviders: () => list,
    saveProvider: (p) => { list = [...list.filter((x) => x.id !== p.id), p]; },
    getProvider: (id) => list.find((p) => p.id === id) || null,
  };
}

function mountPage(repo) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountModelsPage(root, { repo });
  return root;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  delete globalThis.__TAURI__;
});

describe('modelsView 模型配置页', () => {
  it('渲染供应商列表（模型标签）与空态提示', async () => {
    const tauri = stubTauri();
    tauri.setCfg({
      profiles: [{ id: 'p1', name: 'GLM', base_url: 'https://open.bigmodel.cn', models: ['glm-4.6', 'glm-4-air'] }],
      active_profile_id: 'p1',
      active_model: 'glm-4.6',
      persona: '',
    });
    const root = mountPage(makeRepo());
    await vi.waitFor(() => {
      expect(root.querySelectorAll('.chat-profile-item')).toHaveLength(1);
    });
    expect(root.querySelectorAll('.chat-model-tag').length).toBe(2);
    expect(root.innerHTML).toContain('glm-4.6');
    expect(root.innerHTML).toContain('https://open.bigmodel.cn');
    expect(root.innerHTML).toContain('✓ 密钥已存');
  });

  it('添加供应商：模型列表编辑（逐行输入+增删行）+ Key 入凭据管理器 + 自动同步额度查询', async () => {
    const tauri = stubTauri();
    const repo = makeRepo();
    const root = mountPage(repo);
    await vi.waitFor(() => expect(root.querySelector('[data-role="model-add"]')).toBeTruthy());

    root.querySelector('[data-role="model-add"]').click();
    const form = root.querySelector('.chat-profile-form');
    await vi.waitFor(() => expect(form.hidden).toBe(false));
    form.querySelector('[data-field="name"]').value = 'Kimi';
    form.querySelector('[data-field="base_url"]').value = 'https://api.moonshot.cn/v1';
    // 列表编辑：默认一行，点「＋ 添加模型」加第二行，逐行填模型名
    expect(root.querySelectorAll('[data-field="model-row"]')).toHaveLength(1);
    root.querySelector('[data-role="model-add-row"]').click();
    const rows = root.querySelectorAll('[data-field="model-row"]');
    expect(rows).toHaveLength(2);
    rows[0].value = 'kimi-k2';
    rows[1].value = 'kimi-k2-mini';
    form.querySelector('[data-field="key"]').value = 'sk-kimi-1';
    root.querySelector('[data-role="model-save"]').click();

    await vi.waitFor(() => expect(tauri.calls.saveCfg.length).toBeGreaterThan(0));
    const saved = tauri.calls.saveCfg[tauri.calls.saveCfg.length - 1];
    expect(saved.profiles[0].models).toEqual(['kimi-k2', 'kimi-k2-mini']);
    expect(saved.active_profile_id).toBe(saved.profiles[0].id);
    expect(tauri.calls.setKey).toEqual([{ profileId: saved.profiles[0].id, key: 'sk-kimi-1' }]);

    // 同步额度查询：新地址 → 补供应商，类型按地址推断
    await vi.waitFor(() => expect(repo.listProviders()).toHaveLength(1));
    const added = repo.listProviders()[0];
    expect(added.type).toBe('moonshot');
    expect(added.name).toBe('Kimi');
    expect(added.chatModel).toBe('kimi-k2');
    expect(added.hasSecret).toBe(true);
    expect(root.querySelector('[data-role="model-hint"]').textContent).toContain('已加入额度查询');
  });

  it('模型列表编辑：删除行剩一行时清空而非移除行；空模型行自动忽略', async () => {
    stubTauri();
    const root = mountPage(makeRepo());
    await vi.waitFor(() => expect(root.querySelector('[data-role="model-add"]')).toBeTruthy());
    root.querySelector('[data-role="model-add"]').click();
    await vi.waitFor(() => expect(root.querySelector('.chat-profile-form').hidden).toBe(false));

    // 仅一行时点删除 = 清空内容保留行
    root.querySelector('[data-role="model-row-del"]').click();
    expect(root.querySelectorAll('[data-field="model-row"]')).toHaveLength(1);
    expect(root.querySelector('[data-field="model-row"]').value).toBe('');

    // 两行删一行
    root.querySelector('[data-role="model-add-row"]').click();
    root.querySelectorAll('[data-role="model-row-del"]')[0].click();
    expect(root.querySelectorAll('[data-field="model-row"]')).toHaveLength(1);
  });

  it('已存在的 Base URL 不重复加入额度查询', async () => {
    const tauri = stubTauri();
    const repo = makeRepo();
    repo.saveProvider(normalizeProviderConfig({ id: 'q1', name: 'Kimi 官方', type: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1' }));
    const root = mountPage(repo);
    await vi.waitFor(() => expect(root.querySelector('[data-role="model-add"]')).toBeTruthy());

    root.querySelector('[data-role="model-add"]').click();
    const form = root.querySelector('.chat-profile-form');
    await vi.waitFor(() => expect(form.hidden).toBe(false));
    form.querySelector('[data-field="name"]').value = 'Kimi 备用名';
    form.querySelector('[data-field="base_url"]').value = 'https://api.moonshot.cn/v1';
    form.querySelector('[data-field="model-row"]').value = 'kimi-k2';
    root.querySelector('[data-role="model-save"]').click();

    await vi.waitFor(() => expect(tauri.calls.saveCfg.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(root.querySelector('[data-role="model-hint"]').textContent).toContain('已保存'));
    expect(repo.listProviders()).toHaveLength(1); // 未新增
    expect(repo.listProviders()[0].name).toBe('Kimi 官方'); // 原记录不动
  });

  it('删除供应商：移出配置并清凭据条目', async () => {
    const tauri = stubTauri();
    tauri.setCfg({
      profiles: [{ id: 'p1', name: 'GLM', base_url: 'https://open.bigmodel.cn', models: ['glm-4.6'] }],
      active_profile_id: 'p1',
      active_model: 'glm-4.6',
      persona: '',
    });
    const root = mountPage(makeRepo());
    await vi.waitFor(() => expect(root.querySelectorAll('.chat-profile-item')).toHaveLength(1));

    root.querySelector('[data-role="model-del"]').click();
    await vi.waitFor(() => expect(root.querySelectorAll('.chat-profile-item')).toHaveLength(0));
    expect(tauri.calls.deleteKey).toEqual([{ profileId: 'p1' }]);
    const saved = tauri.calls.saveCfg[tauri.calls.saveCfg.length - 1];
    expect(saved.profiles).toEqual([]);
    expect(saved.active_profile_id).toBe(null);
    expect(saved.active_model).toBe(null);
  });

  it('语音服务与人设卡随页渲染（从对话页迁移）', async () => {
    stubTauri();
    const root = mountPage(makeRepo());
    await vi.waitFor(() => expect(root.querySelector('[data-role="voice-save"]')).toBeTruthy());
    for (const field of ['voice-asr-base', 'voice-asr-model', 'voice-tts-base', 'voice-tts-model', 'voice-tts-voice', 'voice-key']) {
      expect(root.querySelector(`[data-field="${field}"]`)).toBeTruthy();
    }
    expect(root.querySelector('[data-role="model-persona"]')).toBeTruthy();
    expect(root.querySelector('[data-role="model-persona-save"]')).toBeTruthy();
  });

  it('人设保存回写配置', async () => {
    const tauri = stubTauri();
    const root = mountPage(makeRepo());
    await vi.waitFor(() => expect(root.querySelector('[data-role="model-persona-save"]')).toBeTruthy());
    root.querySelector('[data-role="model-persona"]').value = '你是傲娇猫娘';
    root.querySelector('[data-role="model-persona-save"]').click();
    await vi.waitFor(() => {
      const saved = tauri.calls.saveCfg[tauri.calls.saveCfg.length - 1];
      expect(saved.persona).toBe('你是傲娇猫娘');
    });
  });
});
