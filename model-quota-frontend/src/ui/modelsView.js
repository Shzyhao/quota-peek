// 主窗「模型配置」页：模型供应商（一个供应商预设多个模型，对话/文件分析/Agent
// 共用）+ 语音服务 + 桌宠人设。在这里添加的 API 自动同步到「供应商」额度查询
// （Base URL 已存在则跳过）；额度查询里配好的 OpenAI 兼容供应商也会自动出现。
// 自挂载组件（mountModelsPage 由 app.js 在渲染后调用）。

import {
  getChatConfig, saveChatConfig, setChatKey, hasChatKey, deleteChatKey, isChatAvailable,
} from '../core/chat.js';
import { normalizeProfile, syncModelsAndQuota } from '../core/models.js';
import {
  loadVoiceConfig, saveVoiceConfig, isVoiceConfigured,
  hasVoiceKey, setVoiceKey, deleteVoiceKey, speakText,
} from '../core/voice.js';
import { escapeHtml } from './format.js';

export function modelsView() {
  return '<div class="models-page" data-role="models-root"></div>';
}

export function mountModelsPage(el, { repo } = {}) {
  let config = { profiles: [], activeProfileId: null, activeModel: null, persona: '' };
  // 编辑中的供应商（null = 未编辑；{...profile, key} = 表单内容，key 留空 = 不修改）
  let editing = null;
  let hint = '';
  let voiceKeySet = false;

  if (!isChatAvailable()) {
    el.innerHTML = `
      <div class="empty-state">
        <p>模型配置仅在桌面版（桌看.exe）中可用——密钥存储与模型请求由桌面壳完成。</p>
        <p>网页版仍可使用额度查询等全部本地功能。</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="chat-import">
      <div class="chat-import-head">
        <b>模型供应商（对话 · 文件分析 · Agent 共用）</b>
        <span class="settings-hint">一个供应商可预设多个模型，对话页下拉自由切换。在这里添加的 API 会自动加入「供应商」额度查询（已存在的跳过）；额度查询里配好的 OpenAI 兼容供应商也会自动出现在这里。</span>
      </div>
      <div data-role="model-profiles"></div>
    </div>
    <div class="chat-profile-form" hidden>
      <h4 data-role="model-form-title">添加供应商</h4>
      <label>名称<input data-field="name" placeholder="如 DeepSeek / 硅基流动"></label>
      <label>Base URL<input data-field="base_url" placeholder="如 https://api.deepseek.com（OpenAI 兼容接口）"></label>
      <label>预设模型（第一个为默认）</label>
      <div class="model-list-editor" data-role="model-list"></div>
      <button type="button" class="btn small" data-role="model-add-row">＋ 添加模型</button>
      <label>API Key<input data-field="key" type="password" placeholder="存入 Windows 凭据管理器，不留本地文件（留空 = 不修改）"></label>
      <div class="chat-form-actions">
        <button class="btn" data-role="model-save">保存</button>
        <button class="btn" data-role="model-cancel">取消</button>
      </div>
    </div>
    <div class="chat-voice-config">
      <div class="chat-import-head">
        <b>语音服务（OpenAI 兼容语音端点）<span class="chat-key-state ${voiceKeySet ? 'ok' : 'missing'}" data-role="voice-key-state"></span></b>
        <span class="settings-hint">语音输入与回复朗读共用一套服务，默认预置硅基流动（识别 SenseVoiceSmall 免费、合成 CosyVoice2 近零成本），换其他 OpenAI 兼容服务改地址和模型即可。</span>
      </div>
      <div class="chat-voice-grid">
        <label>识别 Base URL<input data-field="voice-asr-base" placeholder="https://api.siliconflow.cn/v1"></label>
        <label>识别模型<input data-field="voice-asr-model" placeholder="FunAudioLLM/SenseVoiceSmall"></label>
        <label>合成 Base URL<input data-field="voice-tts-base" placeholder="https://api.siliconflow.cn/v1"></label>
        <label>合成模型<input data-field="voice-tts-model" placeholder="FunAudioLLM/CosyVoice2-0.5B"></label>
        <label>音色<input data-field="voice-tts-voice" placeholder="FunAudioLLM/CosyVoice2-0.5B:anna"></label>
        <label>API Key<input data-field="voice-key" type="password" placeholder="存入 Windows 凭据管理器（留空 = 不修改）"></label>
      </div>
      <div class="chat-form-actions">
        <button class="btn" data-role="voice-save">保存语音设置</button>
        <button class="btn" data-role="voice-test" title="合成一句固定台词试听音色">🔊 试听</button>
        <button class="btn danger" data-role="voice-key-del" hidden>删除 Key</button>
      </div>
    </div>
    <label class="chat-persona-label">桌宠人设（system 提示词，留空用内置默认）
      <textarea data-role="model-persona" rows="3" placeholder="例：你是一只傲娇的猫娘桌宠…"></textarea>
    </label>
    <button class="btn" data-role="model-persona-save">保存人设</button>
    <p class="settings-hint" data-role="model-hint"></p>`;

  const $ = (sel) => el.querySelector(sel);

  // ——— 渲染 ———

  async function renderProfileList() {
    const box = $('[data-role="model-profiles"]');
    const items = await Promise.all(config.profiles.map(async (raw) => {
      const p = normalizeProfile(raw);
      const hasKey = await hasChatKey(p.id).catch(() => false);
      return `
        <div class="chat-profile-item">
          <div class="chat-profile-info">
            <b>${escapeHtml(p.name || p.base_url)}</b>
            <span class="chat-model-tags">${p.models.map((m) => `<span class="chat-model-tag">${escapeHtml(m)}</span>`).join('') || '<span class="chat-key-state missing">未设模型</span>'}</span>
            <span class="chat-profile-url">${escapeHtml(p.base_url)}</span>
            <span class="chat-key-state ${hasKey ? 'ok' : 'missing'}">${hasKey ? '✓ 密钥已存' : '✗ 未设密钥'}</span>
          </div>
          <div class="chat-profile-actions">
            <button class="btn" data-role="model-edit" data-id="${escapeHtml(p.id)}">编辑</button>
            <button class="btn danger" data-role="model-del" data-id="${escapeHtml(p.id)}">删除</button>
          </div>
        </div>`;
    }));
    box.innerHTML = `
      ${items.join('') || '<p class="settings-hint">还没有模型供应商。添加一套 OpenAI 兼容 API（DeepSeek / Kimi / GLM / 硅基流动等）即可开始对话，余额也会自动纳入额度查询。</p>'}
      <button class="btn" data-role="model-add">+ 添加供应商</button>`;
  }

  function renderAll() {
    void renderProfileList();
    const persona = $('[data-role="model-persona"]');
    if (persona) persona.value = config.persona || '';
  }

  function showHint(text) {
    hint = text || hint;
    const node = $('[data-role="model-hint"]');
    if (node) node.textContent = hint;
  }

  // ——— 配置读写 ———

  async function reloadConfig() {
    const cfg = await getChatConfig();
    config = {
      profiles: (cfg.profiles || []).map(normalizeProfile),
      activeProfileId: cfg.active_profile_id ?? null,
      activeModel: cfg.active_model ?? null,
      persona: cfg.persona || '',
    };
    renderAll();
  }

  async function persistConfig() {
    await saveChatConfig({
      profiles: config.profiles,
      active_profile_id: config.activeProfileId,
      active_model: config.activeModel,
      persona: config.persona,
    });
  }

  async function refreshVoiceKeyState() {
    try {
      const has = await hasVoiceKey();
      voiceKeySet = !!has;
      const node = $('[data-role="voice-key-state"]');
      if (node) {
        node.textContent = has ? '✓ Key 已存' : '✗ 未设 Key';
        node.classList.toggle('ok', has);
        node.classList.toggle('missing', !has);
      }
      const del = $('[data-role="voice-key-del"]');
      if (del) del.hidden = !has;
    } catch {
      /* 桌面壳不可用（如测试环境），静态占位即可 */
    }
  }

  function hashSeed(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function showForm(title) {
    const form = $('.chat-profile-form');
    form.hidden = false;
    $('[data-role="model-form-title"]').textContent = title;
    form.querySelector('[data-field="name"]').value = editing?.name || '';
    form.querySelector('[data-field="base_url"]').value = editing?.base_url || '';
    renderModelList(editing?.models?.length ? editing.models : ['']);
    form.querySelector('[data-field="key"]').value = editing?.key || '';
  }

  // 预设模型列表编辑：每行一个输入框 + 删除钮；至少保留一行
  function renderModelList(models) {
    const box = $('[data-role="model-list"]');
    box.innerHTML = (models.length ? models : [''])
      .map((m) => `
        <div class="model-row">
          <input data-field="model-row" placeholder="模型名，如 deepseek-chat" value="${escapeHtml(m)}">
          <button type="button" class="btn danger model-row-del" data-role="model-row-del" title="删除该模型">×</button>
        </div>`).join('');
  }

  function readModelList() {
    return [...el.querySelectorAll('[data-field="model-row"]')]
      .map((i) => i.value.trim())
      .filter(Boolean);
  }

  // 原始行值（不过滤空行）：列表编辑增删行时保持用户已输入的内容
  const rawModelRows = () => [...el.querySelectorAll('[data-field="model-row"]')].map((i) => i.value);

  async function saveForm() {
    const form = $('.chat-profile-form');
    const name = form.querySelector('[data-field="name"]').value.trim();
    const base_url = form.querySelector('[data-field="base_url"]').value.trim().replace(/\/+$/, '');
    const models = readModelList();
    const key = form.querySelector('[data-field="key"]').value.trim();
    if (!name || !base_url || !models.length) {
      showHint('名称 / Base URL / 至少一个模型不能为空');
      return;
    }

    let id = editing?.id;
    if (id) {
      const p = config.profiles.find((x) => x.id === id);
      Object.assign(p, { name, base_url, models });
    } else {
      id = `p${hashSeed(`${name}${base_url}`)}`;
      if (config.profiles.some((x) => x.id === id)) { showHint('同名同地址的供应商已存在'); return; }
      config.profiles.push({ id, name, base_url, models });
    }
    if (key) await setChatKey(id, key);
    // 激活项失效（如原配置已删）时落到本供应商
    if (!config.profiles.some((p) => p.id === config.activeProfileId)) config.activeProfileId = id;
    await persistConfig();
    editing = null;
    form.hidden = true;

    // 保存后立即同步额度查询（新地址补供应商 + 密钥复制；已存在跳过）
    let syncNote = '';
    try {
      const r = await syncModelsAndQuota(repo);
      if (r.addedProviders.length) syncNote = `，已加入额度查询：${r.addedProviders.join('、')}`;
    } catch {
      /* 同步失败不阻塞保存，下次进入本页或重启再试 */
    }
    showHint(`${key ? '已保存，密钥已写入凭据管理器' : '已保存'}${syncNote}`);
    await reloadConfig();
  }

  // ——— 事件 ———

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    const id = btn.dataset.id;

    if (role === 'model-add') {
      editing = { id: null, name: '', base_url: '', models: [], key: '' };
      showForm('添加供应商');
    } else if (role === 'model-add-row') {
      renderModelList([...rawModelRows(), '']);
      const rows = el.querySelectorAll('[data-field="model-row"]');
      rows[rows.length - 1]?.focus();
    } else if (role === 'model-row-del') {
      const rows = [...el.querySelectorAll('[data-field="model-row"]')];
      if (rows.length <= 1) { rows[0].value = ''; return; }
      btn.closest('.model-row')?.remove();
    } else if (role === 'model-edit') {
      const p = config.profiles.find((x) => x.id === id);
      if (p) { editing = { ...normalizeProfile(p), key: '' }; showForm(`编辑：${p.name}（Key 留空 = 不修改）`); }
    } else if (role === 'model-del') {
      config.profiles = config.profiles.filter((x) => x.id !== id);
      if (config.activeProfileId === id) config.activeProfileId = config.profiles[0]?.id ?? null;
      if (config.activeModel && !config.profiles.some((p) => p.models.includes(config.activeModel))) {
        config.activeModel = null;
      }
      await deleteChatKey(id).catch(() => {});
      await persistConfig();
      renderAll();
    } else if (role === 'model-save') {
      await saveForm();
    } else if (role === 'model-cancel') {
      editing = null;
      $('.chat-profile-form').hidden = true;
    } else if (role === 'model-persona-save') {
      config.persona = $('[data-role="model-persona"]').value.trim();
      await persistConfig();
      showHint('人设已保存');
    } else if (role === 'voice-save') {
      const cfg = {
        asrBaseUrl: $('[data-field="voice-asr-base"]').value.trim().replace(/\/+$/, ''),
        asrModel: $('[data-field="voice-asr-model"]').value.trim(),
        ttsBaseUrl: $('[data-field="voice-tts-base"]').value.trim().replace(/\/+$/, ''),
        ttsModel: $('[data-field="voice-tts-model"]').value.trim(),
        ttsVoice: $('[data-field="voice-tts-voice"]').value.trim(),
      };
      if (!cfg.asrBaseUrl || !cfg.asrModel || !cfg.ttsBaseUrl || !cfg.ttsModel || !cfg.ttsVoice) {
        showHint('识别/合成的 Base URL、模型和音色都不能为空');
        return;
      }
      const key = $('[data-field="voice-key"]').value.trim();
      if (key) await setVoiceKey(key);
      saveVoiceConfig(cfg);
      $('[data-field="voice-key"]').value = '';
      void refreshVoiceKeyState();
      showHint(key ? '语音设置已保存，Key 已写入凭据管理器' : '语音设置已保存');
    } else if (role === 'voice-test') {
      const hasKey = await hasVoiceKey().catch(() => false);
      if (!isVoiceConfigured(loadVoiceConfig(), hasKey)) {
        showHint('请先保存语音设置并填入 API Key，再试听');
        return;
      }
      showHint('合成试听中…');
      try {
        const reason = await speakText('你好呀主人，我是你的桌宠，语音服务一切正常！', loadVoiceConfig());
        showHint(reason === 'ended' ? '✓ 试听播放完成' : reason === 'stopped' ? '试听已打断' : '✗ 音频播放失败');
      } catch (err) {
        showHint(`✗ ${String(err?.message || err)}`);
      }
    } else if (role === 'voice-key-del') {
      await deleteVoiceKey().catch(() => {});
      await refreshVoiceKeyState();
      showHint('语音 Key 已删除');
    }
  });

  // 初始化：先双向同步（额度供应商 → 模型配置），再渲染
  (async () => {
    try {
      await syncModelsAndQuota(repo);
    } catch {
      /* 同步失败不阻塞页面 */
    }
    await reloadConfig().catch(() => {});
  })();
  void refreshVoiceKeyState();
}
