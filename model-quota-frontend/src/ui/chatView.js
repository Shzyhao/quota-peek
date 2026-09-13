// 主窗「对话」页：完整会话 + 模型配置管理（多套 profile / API Key 入凭据管理器 /
// 人设编辑 / 连接测试）。自挂载组件（mountChatPage 由 app.js 在渲染后调用），
// 流式逻辑与存储复用 core/chat.js，与桌宠窗气泡共用同一后端命令。

import {
  loadSessions, saveSessions, appendToSession, clearActiveMessages, deleteSession, newSession,
  buildQuotaContext, buildOutgoingMessages, attachmentsToText,
  buildProfileFromProvider, importableProviders,
  isChatAvailable, getChatConfig, saveChatConfig, setChatKey, hasChatKey,
  deleteChatKey, testChatConnection, sendChat, cancelChat,
  readChatFile, agentSend, agentResolve, cancelAgent,
} from '../core/chat.js';
import { readSecret } from '../core/secrets.js';
import { escapeHtml } from './format.js';

export function chatView() {
  return '<div class="chat-page" data-role="chat-root"></div>';
}

export function mountChatPage(el, { repo }) {
  let config = { profiles: [], activeProfileId: null, persona: '' };
  // 多会话：sessions 为最近活跃倒序列表，messages 始终是当前会话的消息视图；
  // 空存储播种一个初始会话（两个窗口共享 storage，只有先挂载者播种生效）
  let loaded = loadSessions();
  if (!loaded.sessions.length) {
    const fresh = newSession();
    loaded = saveSessions([fresh], fresh.id);
  }
  let { sessions, activeId } = loaded;
  let messages = sessions.find((s) => s.id === activeId)?.messages ?? [];
  let streaming = false;
  // 会话附件（待发送）：[{name, content, truncated}]
  let attachments = [];
  // Agent 模式：模型可提议系统工具，逐个经确认卡片批准执行
  let agentMode = localStorage.getItem('mqc.chat.agent') === '1';
  let agentRunning = false;
  let agentLive = [];   // 运行中的工具卡片（挂起的提议/已执行结果），不入会话
  let agentHandlers = null;
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
      <select data-role="chat-session" title="切换会话（保留最近 10 个）"></select>
      <button class="btn" data-role="chat-session-new" title="新建会话">＋新对话</button>
      <button class="btn danger" data-role="chat-session-del" title="删除当前会话">删除会话</button>
      <select data-role="chat-profile" title="当前使用的模型配置"></select>
      <button class="btn" data-role="chat-test">测试连接</button>
      <button class="btn" data-role="chat-config-toggle">模型配置</button>
      <button class="btn danger" data-role="chat-clear" title="清空当前会话的聊天记录">清空记录</button>
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
    <div class="chat-attachments" data-role="chat-attachments" hidden></div>
    <div class="chat-input">
      <textarea data-role="chat-input" rows="2" placeholder="和桌宠聊聊（Enter 发送）"></textarea>
      <div class="chat-input-actions">
        <button class="btn" data-role="chat-attach" title="附加文件（pdf / docx / xlsx / txt / csv / json / 代码等文本类）">📎</button>
        <button class="btn agent-toggle${agentMode ? ' active' : ''}" data-role="chat-agent-toggle" title="Agent 模式：AI 可调用系统工具（每次执行都需你批准）">🔧 Agent</button>
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
    const sessionSel = $('[data-role="chat-session"]');
    sessionSel.innerHTML = sessions.length
      ? sessions.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === activeId ? 'selected' : ''}>${escapeHtml(s.title)}</option>`).join('')
      : '<option value="">（无会话）</option>';
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
    const html = messages.map((m) => bubbleHtml(m));
    for (const c of agentLive) {
      if (c.kind === 'proposed' && !c.done) html.push(proposedCardHtml(c));
    }
    if (streaming && !agentMode) html.push('<div class="chat-bubble assistant streaming" data-role="chat-stream"><span class="chat-text"></span><span class="chat-cursor"></span></div>');
    box.innerHTML = html.join('') || '<div class="chat-welcome">和桌宠打个招呼吧 👋<br/><small>对话发起时会自动附上你的额度数据，可以直接问「我还剩多少额度」</small></div>';
    box.scrollTop = box.scrollHeight;
  }

  function bubbleHtml(m) {
    if (m.tool) {
      const t = m.tool;
      return `<div class="chat-tool-card${t.ok ? '' : ' fail'}${t.danger ? ' danger' : ''}">
        <div class="chat-tool-head">🔧 ${escapeHtml(t.name)} <span class="chat-tool-status">${t.ok ? '✓ 已执行' : '✗ 失败/拒绝'}</span></div>
        ${t.output ? `<pre class="chat-tool-out">${escapeHtml(String(t.output).slice(0, 600))}</pre>` : ''}
      </div>`;
    }
    const cls = m.role === 'user' ? 'user' : 'assistant';
    const att = m.attachments?.length
      ? `<div class="chat-attach-list">${m.attachments.map((a) => `<span class="chat-attach-chip">📄 ${escapeHtml(a.name)}</span>`).join('')}</div>`
      : '';
    return `<div class="chat-bubble ${cls}${m.error ? ' error' : ''}">${att}<span class="chat-text">${escapeHtml(m.content)}</span></div>`;
  }

  // 挂起中的工具提议卡（批准/拒绝）
  function proposedCardHtml(c) {
    const argsText = JSON.stringify(c.args ?? {}, null, 2);
    const argsShort = argsText.length > 800 ? `${argsText.slice(0, 800)}…` : argsText;
    return `<div class="chat-tool-card pending${c.danger ? ' danger' : ''}">
      <div class="chat-tool-head">🔧 Agent 请求执行：${escapeHtml(c.name)}${c.danger ? ' <span class="chat-tool-danger-tag">高危</span>' : ''}</div>
      <pre class="chat-tool-out">${escapeHtml(argsShort)}</pre>
      <div class="chat-tool-actions">
        <button class="btn primary" data-role="agent-approve">批准执行</button>
        <button class="btn danger" data-role="agent-deny">拒绝</button>
      </div>
    </div>`;
  }

  function renderAttachments() {
    const box = $('[data-role="chat-attachments"]');
    if (!box) return;
    box.hidden = !attachments.length;
    box.innerHTML = attachments
      .map((a, i) => `<span class="chat-attach-chip">📄 ${escapeHtml(a.name)}${a.truncated ? '（已截断）' : ''}<button data-role="chat-attach-del" data-id="${i}" aria-label="移除附件">×</button></span>`)
      .join('');
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
    renderAttachments();
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

  // 桌宠气泡状态播报：主窗/面板发起对话时，桌宠气泡同步「思考中/回复好啦」
  const emitChatStatus = (state) => globalThis.__TAURI__?.event?.emit?.('pet-chat-status', { state });
  const syncMessages = () => {
    messages = sessions.find((s) => s.id === activeId)?.messages ?? [];
  };

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

    emitChatStatus('thinking');
    const pendingAttachments = attachments;
    attachments = [];
    renderAttachments();
    ({ sessions, activeId } = appendToSession(sessions, activeId, {
      role: 'user',
      content: text,
      attachments: pendingAttachments.length ? pendingAttachments : undefined,
      time: Date.now(),
    }));
    syncMessages();
    setStreaming(true);
    const quotaCtx = buildQuotaContext(repo.listProviders());
    const outgoing = buildOutgoingMessages([...messages.slice(0, -1)], quotaCtx);
    outgoing.push({
      role: 'user',
      content: pendingAttachments.length ? `${text}
${attachmentsToText(pendingAttachments)}` : text,
    });

    if (agentMode) {
      agentRunning = true;
      agentLive = [];
      agentHandlers = makeAgentHandlers();
      await agentSend(outgoing, agentHandlers);
      return;
    }

    let reply = '';
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

  // ——— Agent（单步确认式工具循环）———

  function makeAgentHandlers() {
    return {
      onToolProposed: (data) => {
        agentLive = [{ kind: 'proposed', done: false, ...data }];
        renderMessages();
      },
      onToolResult: (data) => {
        // 提议卡标记完成并移除，结果卡入库（会话历史可回看）
        agentLive = [];
        ({ sessions, activeId } = appendToSession(sessions, activeId, {
          role: 'assistant',
          content: '',
          tool: { name: data.name, ok: !!data.ok, output: String(data.output || ''), danger: !!data.danger },
          time: Date.now(),
        }));
        syncMessages();
        renderMessages();
      },
      onDone: (text) => finishAgent(text, false),
      onError: (msg) => finishAgent(`（Agent 出错：${msg}）`, true),
    };
  }

  function finishAgent(text, error) {
    ({ sessions, activeId } = appendToSession(sessions, activeId, { role: 'assistant', content: text, error, time: Date.now() }));
    syncMessages();
    agentLive = [];
    agentRunning = false;
    agentHandlers = null;
    setStreaming(false);
    emitChatStatus(error ? 'error' : 'replied');
  }

  function finishExchange(reply, error) {
    ({ sessions, activeId } = appendToSession(sessions, activeId, { role: 'assistant', content: reply, error, time: Date.now() }));
    syncMessages();
    setStreaming(false);
    emitChatStatus(error ? 'error' : 'replied');
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
      if (agentRunning) await cancelAgent().catch(() => {});
      else await cancelChat().catch(() => {});
    } else if (role === 'chat-attach') {
      const selected = await globalThis.__TAURI__?.dialog?.open?.({
        multiple: true,
        title: '选择要附加的文件（pdf / docx / xlsx / txt / csv / json / 代码等文本类）',
      });
      if (!selected) return;
      const list = Array.isArray(selected) ? selected : [selected];
      for (const path of list) {
        if (attachments.length >= 4) { testResult = '一条消息最多附加 4 个文件'; showTestResult(); break; }
        try {
          const att = await readChatFile(path);
          if (att) attachments.push(att);
        } catch (e) {
          testResult = String(e?.message || e);
          showTestResult();
        }
      }
      renderAttachments();
    } else if (role === 'chat-attach-del') {
      attachments.splice(Number(id), 1);
      renderAttachments();
    } else if (role === 'chat-agent-toggle') {
      agentMode = !agentMode;
      localStorage.setItem('mqc.chat.agent', agentMode ? '1' : '0');
      btn.classList.toggle('active', agentMode);
    } else if (role === 'agent-approve' || role === 'agent-deny') {
      if (!agentRunning || !agentHandlers) return;
      el.querySelectorAll('.chat-tool-actions button').forEach((b) => (b.disabled = true));
      await agentResolve(role === 'agent-approve', agentHandlers);
    } else if (role === 'chat-clear') {
      ({ sessions, activeId } = clearActiveMessages(sessions, activeId));
      syncMessages();
      renderAll();
    } else if (role === 'chat-session-new') {
      if (streaming) return;
      const fresh = newSession();
      ({ sessions, activeId } = saveSessions([fresh, ...sessions], fresh.id));
      syncMessages();
      renderAll();
    } else if (role === 'chat-session-del') {
      if (streaming) return;
      ({ sessions, activeId } = deleteSession(sessions, activeId, activeId));
      syncMessages();
      renderAll();
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
      // 密钥随导入写入对话凭据管理器：桌面版从额度密钥条目读（记录只有标记），浏览器版读记录明文
      let importKey = p.apiKey || '';
      if (!importKey && p.hasSecret) {
        const s = await readSecret(p.id).catch(() => null);
        importKey = s?.apiKey || '';
      }
      if (importKey) {
        await setChatKey(prof.id, importKey);
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
    if (e.target.matches('[data-role="chat-session"]')) {
      if (streaming) { renderToolbar(); return; } // 流式中不允许切换（渲染会打断流式节点）
      activeId = e.target.value || activeId;
      saveSessions(sessions, activeId);
      syncMessages();
      renderMessages();
      return;
    }
    if (e.target.matches('[data-role="chat-profile"]')) {
      config.activeProfileId = e.target.value || null;
      await persistConfig();
      renderAll();
    }
  });

  // 其他窗口（主窗 ↔ 桌宠面板）的会话变化经 storage 事件同步；流式中忽略，结束后再取
  globalThis.addEventListener?.('storage', (e) => {
    if (!e.key || (e.key !== 'mqc.chat.sessions' && e.key !== 'mqc.chat.activeSession')) return;
    if (streaming) return;
    ({ sessions, activeId } = loadSessions());
    syncMessages();
    renderAll();
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
