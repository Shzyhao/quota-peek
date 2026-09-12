// 主窗「对话」页：完整会话 + 模型配置管理（多套 profile / API Key 入凭据管理器 /
// 人设编辑 / 连接测试）。自挂载组件（mountChatPage 由 app.js 在渲染后调用），
// 流式逻辑与存储复用 core/chat.js，与桌宠窗气泡共用同一后端命令。

import {
  loadHistory, saveHistory, clearHistory, buildQuotaContext, buildOutgoingMessages,
  buildProfileFromProvider, importableProviders,
  isChatAvailable, getChatConfig, saveChatConfig, setChatKey, hasChatKey,
  deleteChatKey, testChatConnection, sendChat, cancelChat,
} from '../core/chat.js';
import { escapeHtml } from './format.js';

export function chatView() {
  return '<div class="chat-page" data-role="chat-root"></div>';
}

export function mountChatPage(el, { repo }) {
  let config = { profiles: [], activeProfileId: null, persona: '' };
  let messages = loadHistory();
  let streaming = false;
  // 编辑中的 profile（null = 新建未开始；{...profile, key} = 编辑/新建表单内容）
  let editing = null;
  let testResult = '';

  const desktop = isChatAvailable();
  if (!desktop) {
    el.innerHTML = `
      <div class="empty-state">
        <p>AI 对话仅在桌面版（桌看.exe）中可用——密钥存储与模型请求由桌面壳完成。</p>
        <p>网页版仍可使用额度查询等全部本地功能。</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="chat-toolbar">
      <select data-role="chat-profile" title="当前使用的模型配置"></select>
      <button class="btn" data-role="chat-test">测试连接</button>
      <button class="btn" data-role="chat-config-toggle">模型配置</button>
      <button class="btn danger" data-role="chat-clear" title="清空当前会话记录">清空会话</button>
    </div>
    <div class="chat-config" hidden>
      <div data-role="chat-profiles"></div>
      <div class="chat-import">
        <div class="chat-import-head">
          <b>从额度供应商导入</b>
          <span class="settings-hint">把额度查询里配好的供应商一键变成对话模型（需 OpenAI 兼容接口；火山方舟 IAM 类型不适用），密钥同步写入凭据管理器。模型可在供应商表单的「AI 默认模型」里改。</span>
        </div>
        <div data-role="chat-import-list"></div>
      </div>
      <div class="chat-profile-form" hidden>
        <h4 data-role="chat-form-title">添加配置</h4>
        <label>名称<input data-field="name" placeholder="如 DeepSeek"></label>
        <label>Base URL<input data-field="base_url" placeholder="如 https://api.deepseek.com"></label>
        <label>模型<input data-field="model" placeholder="如 deepseek-chat"></label>
        <label>API Key<input data-field="key" type="password" placeholder="存入 Windows 凭据管理器，不留本地文件"></label>
        <div class="chat-form-actions">
          <button class="btn" data-role="chat-profile-save">保存</button>
          <button class="btn" data-role="chat-profile-cancel">取消</button>
        </div>
      </div>
      <label class="chat-persona-label">桌宠人设（system 提示词，留空用内置默认）
        <textarea data-role="chat-persona" rows="3" placeholder="例：你是一只傲娇的猫娘桌宠…"></textarea>
      </label>
      <button class="btn" data-role="chat-persona-save">保存人设</button>
      <p class="settings-hint" data-role="chat-test-result"></p>
    </div>
    <div class="chat-messages" data-role="chat-messages"></div>
    <div class="chat-input">
      <textarea data-role="chat-input" rows="2" placeholder="和桌宠聊聊（Enter 发送）"></textarea>
      <div class="chat-input-actions">
        <button class="btn primary" data-role="chat-send">发送</button>
        <button class="btn" data-role="chat-stop" hidden>停止</button>
      </div>
    </div>`;

  const $ = (sel) => el.querySelector(sel);
  const $$ = (sel) => el.querySelectorAll(sel);

  // ——— 渲染 ———

  function renderToolbar() {
    const sel = $('[data-role="chat-profile"]');
    sel.innerHTML = config.profiles.length
      ? config.profiles.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === config.activeProfileId ? 'selected' : ''}>${escapeHtml(p.name)} · ${escapeHtml(p.model)}</option>`).join('')
      : '<option value="">（未配置模型）</option>';
  }

  async function renderProfileList() {
    const box = $('[data-role="chat-profiles"]');
    const items = await Promise.all(config.profiles.map(async (p) => {
      const hasKey = await hasChatKey(p.id).catch(() => false);
      const active = p.id === config.activeProfileId;
      return `
        <div class="chat-profile-item ${active ? 'active' : ''}">
          <div class="chat-profile-info">
            <b>${escapeHtml(p.name)}</b>
            <span>${escapeHtml(p.model)}</span>
            <span class="chat-key-state ${hasKey ? 'ok' : 'missing'}">${hasKey ? '✓ 密钥已存' : '✗ 未设密钥'}</span>
          </div>
          <div class="chat-profile-actions">
            ${active ? '' : `<button class="btn" data-role="chat-profile-use" data-id="${escapeHtml(p.id)}">设为当前</button>`}
            <button class="btn" data-role="chat-profile-edit" data-id="${escapeHtml(p.id)}">编辑</button>
            <button class="btn danger" data-role="chat-profile-del" data-id="${escapeHtml(p.id)}">删除</button>
          </div>
        </div>`;
    }));
    box.innerHTML = `
      ${items.join('') || '<p class="settings-hint">还没有模型配置。添加一套 OpenAI 兼容配置（DeepSeek / Kimi / GLM 等）即可开始对话。</p>'}
      <button class="btn" data-role="chat-add-profile">+ 添加配置</button>`;
  }

  function renderMessages() {
    const box = $('[data-role="chat-messages"]');
    const html = messages.map((m) => bubbleHtml(m.role, m.content, m.error));
    if (streaming) html.push('<div class="chat-bubble assistant streaming" data-role="chat-stream"><span class="chat-text"></span><span class="chat-cursor"></span></div>');
    box.innerHTML = html.join('') || '<div class="chat-welcome">和桌宠打个招呼吧 👋<br/><small>对话发起时会自动附上你的额度数据，可以直接问「我还剩多少额度」</small></div>';
    box.scrollTop = box.scrollHeight;
  }

  function bubbleHtml(role, content, error) {
    const cls = role === 'user' ? 'user' : 'assistant';
    return `<div class="chat-bubble ${cls}${error ? ' error' : ''}"><span class="chat-text">${escapeHtml(content)}</span></div>`;
  }

  async function renderImportList() {
    const box = $('[data-role="chat-import-list"]');
    if (!box) return;
    const providers = importableProviders(repo.listProviders());
    const items = providers.map((p) => {
      const prof = buildProfileFromProvider(p);
      const imported = config.profiles.some((x) => x.id === prof.id);
      const ready = !!(prof.model && prof.base_url);
      return `
        <div class="chat-import-item">
          <span class="chat-import-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
          <span class="chat-import-model" title="${escapeHtml(prof.model)}">${escapeHtml(prof.model || '未设模型')}</span>
          <button class="btn ${imported ? '' : 'primary'}" data-role="chat-import" data-id="${escapeHtml(p.id)}" ${ready ? '' : 'disabled'} title="${ready ? '' : '请在供应商表单补全 Base URL / AI 默认模型'}">${imported ? '同步' : '导入'}</button>
        </div>`;
    });
    box.innerHTML = items.join('') || '<p class="settings-hint">暂无可导入的供应商（先在「供应商」页添加）。</p>';
  }

  function renderAll() {
    renderToolbar();
    void renderProfileList();
    void renderImportList();
    renderMessages();
    $('[data-role="chat-persona"]').value = config.persona || '';
  }

  // ——— 配置读写 ———

  async function reloadConfig() {
    const cfg = await getChatConfig();
    // Rust 侧 serde 字段名与这里对齐：profiles / active_profile_id / persona
    config = {
      profiles: cfg.profiles || [],
      activeProfileId: cfg.active_profile_id ?? null,
      persona: cfg.persona || '',
    };
    renderAll();
  }

  async function persistConfig() {
    await saveChatConfig({
      profiles: config.profiles,
      active_profile_id: config.activeProfileId,
      persona: config.persona,
    });
  }

  // ——— 对话 ———

  function setStreaming(on) {
    streaming = on;
    $('[data-role="chat-send"]').hidden = on;
    $('[data-role="chat-stop"]').hidden = !on;
    renderMessages();
  }

  async function doSend(text) {
    if (streaming || !text.trim()) return;
    const profile = config.profiles.find((p) => p.id === config.activeProfileId);
    if (!profile) { testResult = '请先在「模型配置」中添加并启用一套配置'; showTestResult(); return; }

    messages.push({ role: 'user', content: text, time: Date.now() });
    setStreaming(true);
    let reply = '';
    const quotaCtx = buildQuotaContext(repo.listProviders());
    const outgoing = buildOutgoingMessages(
      [...messages.slice(0, -1)], quotaCtx,
    );
    outgoing.push({ role: 'user', content: text });

    const streamEl = () => $('[data-role="chat-stream"] .chat-text');
    await sendChat(outgoing, {
      onToken: (t) => {
        reply += t;
        const node = streamEl();
        if (node) {
          node.textContent = reply;
          $('[data-role="chat-messages"]').scrollTop = 1e9;
        }
      },
      onDone: () => finishExchange(reply, false),
      onError: (msg) => finishExchange(reply || `（请求失败：${msg}）`, true),
      onCancelled: () => finishExchange(reply || '（已停止）', false),
    });
  }

  function finishExchange(reply, error) {
    messages.push({ role: 'assistant', content: reply, error, time: Date.now() });
    saveHistory(messages);
    setStreaming(false);
  }

  function showTestResult() {
    const el2 = $('[data-role="chat-test-result"]');
    if (el2) el2.textContent = testResult;
    if (testResult) {
      const cfgPanel = $('.chat-config');
      if (cfgPanel.hidden) cfgPanel.hidden = false;
    }
  }

  // ——— 事件 ———

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    const id = btn.dataset.id;

    if (role === 'chat-send') {
      const input = $('[data-role="chat-input"]');
      const text = input.value.trim();
      if (text) { input.value = ''; await doSend(text); }
    } else if (role === 'chat-stop') {
      await cancelChat().catch(() => {});
    } else if (role === 'chat-clear') {
      messages = [];
      clearHistory();
      renderMessages();
    } else if (role === 'chat-test') {
      testResult = '测试中…'; showTestResult();
      const r = await testChatConnection().catch((err) => ({ ok: false, message: String(err?.message || err) }));
      testResult = `${r.ok ? '✓' : '✗'} ${r.message || ''}${r.balance ? `（余额 ${r.balance}）` : ''}`;
      showTestResult();
    } else if (role === 'chat-config-toggle') {
      const panel = $('.chat-config');
      panel.hidden = !panel.hidden;
    } else if (role === 'chat-add-profile') {
      editing = { id: null, name: '', base_url: '', model: '', key: '' };
      showProfileForm('添加配置');
    } else if (role === 'chat-profile-edit') {
      const p = config.profiles.find((x) => x.id === id);
      if (p) { editing = { ...p, key: '' }; showProfileForm(`编辑：${p.name}（Key 留空 = 不修改）`); }
    } else if (role === 'chat-profile-use') {
      config.activeProfileId = id;
      await persistConfig();
      renderAll();
    } else if (role === 'chat-import') {
      // 从额度供应商导入/同步：profile 稳定 id 覆盖 = 同步；密钥随导入写入凭据管理器
      testResult = '';
      const p = repo.getProvider(id);
      if (!p) return;
      const prof = buildProfileFromProvider(p);
      if (!prof.model || !prof.base_url) {
        testResult = `「${p.name}」缺少 Base URL 或默认模型：请在供应商表单填写 Base URL 与「AI 默认模型」`;
        showTestResult();
        return;
      }
      config.profiles = config.profiles.filter((x) => x.id !== prof.id);
      config.profiles.push(prof);
      if (!config.activeProfileId) config.activeProfileId = prof.id;
      if (p.apiKey) {
        await setChatKey(prof.id, p.apiKey);
      } else if (!(await hasChatKey(prof.id).catch(() => false))) {
        testResult = `「${p.name}」未存 API Key，导入后无法调用：请在供应商表单补 Key 后再同步`;
        showTestResult();
      }
      config.activeProfileId = prof.id;
      await persistConfig();
      if (!testResult) testResult = `已导入并启用：${p.name} · ${prof.model}`;
      renderAll();
      showTestResult();
    } else if (role === 'chat-profile-del') {
      config.profiles = config.profiles.filter((x) => x.id !== id);
      if (config.activeProfileId === id) config.activeProfileId = config.profiles[0]?.id ?? null;
      await deleteChatKey(id).catch(() => {});
      await persistConfig();
      renderAll();
    } else if (role === 'chat-profile-save') {
      await saveProfileForm();
    } else if (role === 'chat-profile-cancel') {
      editing = null;
      $('.chat-profile-form').hidden = true;
    } else if (role === 'chat-persona-save') {
      config.persona = $('[data-role="chat-persona"]').value.trim();
      await persistConfig();
      testResult = '人设已保存'; showTestResult();
    }
  });

  el.addEventListener('change', async (e) => {
    if (e.target.matches('[data-role="chat-profile"]')) {
      config.activeProfileId = e.target.value || null;
      await persistConfig();
      renderAll();
    }
  });

  el.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-role="chat-input"]') && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (text && !streaming) { e.target.value = ''; void doSend(text); }
    }
  });

  function showProfileForm(title) {
    const form = $('.chat-profile-form');
    form.hidden = false;
    $('[data-role="chat-form-title"]').textContent = title;
    form.querySelector('[data-field="name"]').value = editing?.name || '';
    form.querySelector('[data-field="base_url"]').value = editing?.base_url || '';
    form.querySelector('[data-field="model"]').value = editing?.model || '';
    form.querySelector('[data-field="key"]').value = '';
  }

  async function saveProfileForm() {
    const form = $('.chat-profile-form');
    const name = form.querySelector('[data-field="name"]').value.trim();
    const base_url = form.querySelector('[data-field="base_url"]').value.trim().replace(/\/+$/, '');
    const model = form.querySelector('[data-field="model"]').value.trim();
    const key = form.querySelector('[data-field="key"]').value.trim();
    if (!name || !base_url || !model) { testResult = '名称 / Base URL / 模型不能为空'; showTestResult(); return; }

    let id = editing?.id;
    if (id) {
      const p = config.profiles.find((x) => x.id === id);
      Object.assign(p, { name, base_url, model });
    } else {
      // id 用名称+地址的内容摘要本地生成（稳定去重；后端原样存储不重算）
      id = `p${hashSeed(`${name}${base_url}`)}`;
      if (config.profiles.some((x) => x.id === id)) { testResult = '同名配置已存在'; showTestResult(); return; }
      config.profiles.push({ id, name, base_url, model });
    }
    if (key) await setChatKey(id, key);
    if (!config.activeProfileId) config.activeProfileId = id;
    await persistConfig();
    editing = null;
    form.hidden = true;
    testResult = key ? '已保存，密钥已写入凭据管理器' : '已保存';
    renderAll();
    showTestResult();
  }

  function hashSeed(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // 初始化
  void reloadConfig();
}
