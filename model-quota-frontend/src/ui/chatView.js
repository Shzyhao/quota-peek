// 主窗「对话」页：完整会话 + 模型配置管理（多套 profile / API Key 入凭据管理器 /
// 人设编辑 / 连接测试）。自挂载组件（mountChatPage 由 app.js 在渲染后调用），
// 流式逻辑与存储复用 core/chat.js，与桌宠窗气泡共用同一后端命令。

import {
  loadSessions, saveSessions, appendToSession, clearActiveMessages, deleteSession, newSession,
  buildQuotaContext, buildOutgoingMessages, attachmentsToText,
  buildProfileFromProvider, importableProviders,
  isChatAvailable, getChatConfig, saveChatConfig, setChatKey, hasChatKey,
  deleteChatKey, testChatConnection, sendChat, cancelChat,
  readChatFile, agentSend, agentResolve, cancelAgent, isReadonlyTool,
} from '../core/chat.js';
import { readSecret } from '../core/secrets.js';
import {
  loadVoiceConfig, saveVoiceConfig, isVoiceConfigured,
  hasVoiceKey, setVoiceKey, deleteVoiceKey,
  createVoiceRecorder, transcribeAudio, speakText, stopSpeaking, speechFriendlyText,
} from '../core/voice.js';
import { escapeHtml } from './format.js';

export function chatView() {
  return '<div class="chat-page" data-role="chat-root"></div>';
}

export function mountChatPage(el, { repo, voiceDeps, panel = false } = {}) {
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
  // ⚡ 只读工具自动批准（默认关）：开启后只读类调用跳过确认卡（仍落审计日志）
  let autoReadonly = localStorage.getItem('mqc.chat.agentAutoReadonly') === '1';
  let chainApproved = false; // 多步自主：本任务内后续工具调用不再确认
  let agentRunning = false;
  let agentLive = [];   // 运行中的工具卡片（挂起的提议/已执行结果），不入会话
  let agentHandlers = null;
  // 编辑中的 profile（null = 新建未开始；{...profile, key} = 编辑/新建表单内容）
  let editing = null;
  let testResult = '';
  // 语音对话：麦克风状态机 idle→recording→transcribing；朗读播放标记；
  // 录音器懒创建（首次点麦克风才申请 getUserMedia，避免挂载即碰媒体设备）
  let voiceConfig = loadVoiceConfig();
  let voiceRecorder = null;
  let voiceState = 'idle';
  let voicePlaying = false;
  let voiceKeySet = false;

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
      ${panel ? '' : `
      <button class="btn" data-role="chat-test">测试连接</button>
      <button class="btn" data-role="chat-config-toggle">模型配置</button>`}
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
      <div class="chat-voice-config">
        <div class="chat-import-head">
          <b>语音服务（OpenAI 兼容语音端点）<span class="chat-key-state ${voiceKeySet ? 'ok' : 'missing'}" data-role="chat-voice-key-state"></span></b>
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
          <button class="btn" data-role="chat-voice-save">保存语音设置</button>
          <button class="btn" data-role="chat-voice-test" title="合成一句固定台词试听音色">🔊 试听</button>
          <button class="btn danger" data-role="chat-voice-key-del" hidden>删除 Key</button>
        </div>
      </div>
      <p class="settings-hint" data-role="chat-test-result"></p>
    </div>
    <div class="chat-messages" data-role="chat-messages"></div>
    <div class="chat-attachments" data-role="chat-attachments" hidden></div>
    <div class="chat-input">
      <textarea data-role="chat-input" rows="2" placeholder="和桌宠聊聊（Enter 发送）"></textarea>
      <div class="chat-input-actions">
        <button class="btn chat-mic" data-role="chat-mic" title="语音输入：点一下开始说话，再点一下识别并发送">🎙</button>
        <button class="btn" data-role="chat-attach" title="附加文件（pdf / docx / xlsx / txt / csv / json / 代码等文本类）">📎</button>
        <button class="btn agent-toggle${voiceConfig.autoRead ? ' active' : ''}" data-role="chat-voice-toggle" title="回复朗读：模型回复完成后自动语音播报（可点此开关）">🔊 朗读</button>
        <button class="btn agent-toggle${agentMode ? ' active' : ''}" data-role="chat-agent-toggle" title="Agent 模式：AI 可调用系统工具（每次执行都需你批准）">🔧 Agent</button>
        <button class="btn agent-toggle${autoReadonly ? ' active' : ''}" data-role="agent-readonly-toggle" title="只读工具自动批准：时间/系统信息/列目录/读文件不再弹确认卡（仍记录审计日志）"${agentMode ? '' : ' hidden'}>⚡ 只读自动批准</button>
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
        <div class="chat-tool-head">🔧 ${escapeHtml(t.name)} <span class="chat-tool-status">${t.ok ? '✓ 已执行' : '✗ 失败/拒绝'}${t.auto ? ' ⚡' : ''}</span></div>
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
    // 预览上限 20k 字符（配合 run_command 8k 命令上限，确保命令始终完整可见）；区域本身可滚动
    const over = argsText.length > 20000;
    const argsShown = over ? `${argsText.slice(0, 20000)}…` : argsText;
    return `<div class="chat-tool-card pending${c.danger ? ' danger' : ''}">
      <div class="chat-tool-head">🔧 Agent 请求执行：${escapeHtml(c.name)}${c.danger ? ' <span class="chat-tool-danger-tag">高危</span>' : ''}</div>
      <pre class="chat-tool-out">${escapeHtml(argsShown)}${over ? '\n（预览截断：参数过长，请谨慎批准）' : ''}</pre>
      <div class="chat-tool-actions">
        <button class="btn primary" data-role="agent-approve">批准执行</button>
        <button class="btn primary" data-role="agent-chain" title="批准本任务后续全部工具调用（多步自主，仍受 8 步上限与取消约束）">⚡ 批准整条链</button>
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
  // 追加消息的统一入口：先从 storage 重读最新会话态再追加，
  // 防止另一窗口（主窗/面板）在本地流式期间写入的消息被整表覆盖丢失
  function appendToActiveSession(msg) {
    const fresh = loadSessions();
    ({ sessions, activeId } = appendToSession(fresh.sessions, fresh.activeId, msg));
    syncMessages();
  }

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

    // 新消息打断上一条朗读（简易打断）；录音中不可能走到这里（麦克风入口已挡）
    stopSpeaking();
    voicePlaying = false;
    renderMic();

    emitChatStatus('thinking');
    const pendingAttachments = attachments;
    attachments = [];
    renderAttachments();
    appendToActiveSession({
      role: 'user',
      content: text,
      attachments: pendingAttachments.length ? pendingAttachments : undefined,
      time: Date.now(),
    });
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
      chainApproved = false;
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
        // ⚡ 只读自动批准：跳过确认卡直接放行（审计 auto=true）
        if (autoReadonly && isReadonlyTool(data.name)) {
          void agentResolve(true, makeAgentHandlers(), { auto: true });
          return;
        }
        agentLive = [{ kind: 'proposed', done: false, ...data }];
        renderMessages();
      },
      onToolResult: (data) => {
        // 提议卡移除，结果卡入库（会话历史可回看）
        agentLive = [];
        appendToActiveSession({
          role: 'assistant',
          content: '',
          tool: { name: data.name, ok: !!data.ok, output: String(data.output || ''), danger: !!data.danger, auto: !!data.auto },
          time: Date.now(),
        });
        renderMessages();
      },
      onDone: (text) => finishAgent(text, false),
      onError: (msg) => finishAgent(`（Agent 出错：${msg}）`, true),
    };
  }

  function finishAgent(text, error) {
    appendToActiveSession({ role: 'assistant', content: text, error, time: Date.now() });
    agentLive = [];
    agentRunning = false;
    chainApproved = false;
    agentHandlers = null;
    setStreaming(false);
    emitChatStatus(error ? 'error' : 'replied');
  }

  function finishExchange(reply, error) {
    appendToActiveSession({ role: 'assistant', content: reply, error, time: Date.now() });
    setStreaming(false);
    emitChatStatus(error ? 'error' : 'replied');
    // 回复朗读（bonus 体验）：开关开着且回复正常完成才播；识别/合成失败不打扰对话
    if (!error && reply && loadVoiceConfig().autoRead) void speakReply(reply);
  }

  function showTestResult() {
    const el2 = $('[data-role="chat-test-result"]');
    if (el2) el2.textContent = testResult;
    if (testResult) {
      const cfgPanel = $('.chat-config');
      if (cfgPanel.hidden) cfgPanel.hidden = false;
    }
  }

  // ——— 语音对话（点按说话：录音 → 识别 → 自动发送；回复完成自动朗读） ———

  function renderMic() {
    const mic = $('[data-role="chat-mic"]');
    if (!mic) return;
    mic.classList.toggle('recording', voiceState === 'recording');
    mic.classList.toggle('busy', voiceState === 'transcribing' || voicePlaying);
    mic.textContent = voiceState === 'recording' ? '⏹' : voiceState === 'transcribing' ? '⏳' : '🎙';
  }

  async function refreshVoiceKeyState() {
    try {
      const has = await hasVoiceKey();
      voiceKeySet = !!has;
      const el2 = $('[data-role="chat-voice-key-state"]');
      if (el2) {
        el2.textContent = has ? '✓ Key 已存' : '✗ 未设 Key';
        el2.classList.toggle('ok', has);
        el2.classList.toggle('missing', !has);
      }
      const del = $('[data-role="chat-voice-key-del"]');
      if (del) del.hidden = !has;
    } catch {
      /* 桌面壳不可用（如测试环境），静态占位即可 */
    }
  }

  function micErrorHint(e) {
    const name = e?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风权限被拒绝：请检查 Windows 设置 › 隐私 › 麦克风 是否允许桌面应用';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有检测到可用的麦克风设备';
    if (name === 'NotReadableError') return '麦克风被其他应用占用或被系统关闭';
    return `录音失败：${String(e?.message || e)}`;
  }

  async function handleMicClick() {
    if (voiceState === 'recording') { finishRecording(); return; }
    if (voiceState === 'transcribing') return; // 识别中忽略连点
    // 开始新录音 = 打断当前朗读
    stopSpeaking();
    voicePlaying = false;
    renderMic();
    const hasKey = await hasVoiceKey().catch(() => false);
    if (!isVoiceConfigured(loadVoiceConfig(), hasKey)) {
      testResult = '语音服务还没配置好：请展开「模型配置」，在「语音服务」卡里保存设置并填入 API Key';
      showTestResult();
      return;
    }
    voiceRecorder = voiceRecorder || createVoiceRecorder(voiceDeps);
    try {
      await voiceRecorder.start({ onAutoStop: () => finishRecording() });
    } catch (e) {
      voiceRecorder = null;
      testResult = micErrorHint(e);
      showTestResult();
      return;
    }
    voiceState = 'recording';
    renderMic();
    emitChatStatus('recording');
  }

  function finishRecording() {
    if (voiceState !== 'recording' || !voiceRecorder) return;
    const result = voiceRecorder.stop();
    voiceRecorder = null;
    voiceState = 'idle';
    renderMic();
    emitChatStatus('idle');
    if (!result) return;
    if (result.durationMs < 400) {
      testResult = '录音太短啦，点住感觉再说一句话的功夫';
      showTestResult();
      return;
    }
    voiceState = 'transcribing';
    renderMic();
    emitChatStatus('transcribing');
    void (async () => {
      try {
        const text = String(await transcribeAudio(result.wavBase64, loadVoiceConfig()) || '').trim();
        voiceState = 'idle';
        renderMic();
        emitChatStatus('idle');
        if (!text) { testResult = '没听清你说什么，再试一次？'; showTestResult(); return; }
        const input = $('[data-role="chat-input"]');
        input.value = text;
        if (streaming) {
          testResult = '正在回复上一条，识别文字已填入输入框';
          showTestResult();
          return;
        }
        input.value = '';
        await doSend(text);
      } catch (e) {
        voiceState = 'idle';
        renderMic();
        emitChatStatus('idle');
        testResult = `识别失败：${String(e?.message || e)}`;
        showTestResult();
      }
    })();
  }

  async function speakReply(reply) {
    const clean = speechFriendlyText(reply);
    if (!clean) return;
    voicePlaying = true;
    renderMic();
    emitChatStatus('speaking');
    try {
      await speakText(clean, loadVoiceConfig());
    } catch {
      /* 朗读失败静默：对话主链路不受影响 */
    }
    voicePlaying = false;
    renderMic();
    emitChatStatus('idle');
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
      stopSpeaking();
      voicePlaying = false;
      renderMic();
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
    } else if (role === 'chat-mic') {
      void handleMicClick();
    } else if (role === 'chat-voice-toggle') {
      voiceConfig = saveVoiceConfig({ autoRead: !voiceConfig.autoRead });
      btn.classList.toggle('active', voiceConfig.autoRead);
      // 关朗读顺手停掉正在播的语音
      if (!voiceConfig.autoRead) { stopSpeaking(); voicePlaying = false; renderMic(); }
    } else if (role === 'chat-voice-save') {
      const cfg = {
        asrBaseUrl: $('[data-field="voice-asr-base"]').value.trim().replace(/\/+$/, ''),
        asrModel: $('[data-field="voice-asr-model"]').value.trim(),
        ttsBaseUrl: $('[data-field="voice-tts-base"]').value.trim().replace(/\/+$/, ''),
        ttsModel: $('[data-field="voice-tts-model"]').value.trim(),
        ttsVoice: $('[data-field="voice-tts-voice"]').value.trim(),
      };
      if (!cfg.asrBaseUrl || !cfg.asrModel || !cfg.ttsBaseUrl || !cfg.ttsModel || !cfg.ttsVoice) {
        testResult = '识别/合成的 Base URL、模型和音色都不能为空';
        showTestResult();
        return;
      }
      const key = $('[data-field="voice-key"]').value.trim();
      if (key) await setVoiceKey(key);
      voiceConfig = saveVoiceConfig(cfg);
      $('[data-field="voice-key"]').value = '';
      void refreshVoiceKeyState();
      testResult = key ? '语音设置已保存，Key 已写入凭据管理器' : '语音设置已保存';
      showTestResult();
    } else if (role === 'chat-voice-test') {
      const hasKey = await hasVoiceKey().catch(() => false);
      if (!isVoiceConfigured(loadVoiceConfig(), hasKey)) {
        testResult = '请先保存语音设置并填入 API Key，再试听';
        showTestResult();
        return;
      }
      testResult = '合成试听中…'; showTestResult();
      try {
        const reason = await speakText('你好呀主人，我是你的桌宠，语音服务一切正常！', loadVoiceConfig());
        testResult = reason === 'ended' ? '✓ 试听播放完成' : reason === 'stopped' ? '试听已打断' : '✗ 音频播放失败';
      } catch (e) {
        testResult = `✗ ${String(e?.message || e)}`;
      }
      showTestResult();
    } else if (role === 'chat-voice-key-del') {
      await deleteVoiceKey().catch(() => {});
      await refreshVoiceKeyState();
      testResult = '语音 Key 已删除';
      showTestResult();
    } else if (role === 'chat-agent-toggle') {
      agentMode = !agentMode;
      localStorage.setItem('mqc.chat.agent', agentMode ? '1' : '0');
      btn.classList.toggle('active', agentMode);
      const ro = $('[data-role="agent-readonly-toggle"]');
      if (ro) ro.hidden = !agentMode;
    } else if (role === 'agent-approve' || role === 'agent-deny' || role === 'agent-chain') {
      if (!agentRunning || !agentHandlers) return;
      el.querySelectorAll('.chat-tool-actions button').forEach((b) => (b.disabled = true));
      if (role === 'agent-chain') chainApproved = true;
      await agentResolve(role !== 'agent-deny', agentHandlers, { approveChain: role === 'agent-chain' });
    } else if (role === 'agent-readonly-toggle') {
      autoReadonly = !autoReadonly;
      localStorage.setItem('mqc.chat.agentAutoReadonly', autoReadonly ? '1' : '0');
      btn.classList.toggle('active', autoReadonly);
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

  // 其他窗口（主窗 ↔ 桌宠面板）的会话变化经 storage 事件同步；流式中忽略，结束后再取。
  // 语音激活标记也走 storage：桌宠菜单「语音对话」写入后，已挂载的面板在这里兜底消费
  // （面板窗已存在时不会重新 mount）。主窗/迷你窗也会收到本事件——它们不该消费标记，
  // 更不能删除（抢先删除会让面板永远等不到激活），不满足条件时原样留着等 30s 过期
  const isPanelChat = () => /#panel-chat/.test(globalThis.location?.hash || '');
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === 'mqc.voice.pendingActivate') {
      if (isPanelChat() && Date.now() - Number(e.newValue || 0) < 30000 && voiceState === 'idle') {
        localStorage.removeItem('mqc.voice.pendingActivate');
        void handleMicClick();
      }
      return;
    }
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
  void refreshVoiceKeyState();
  // 桌宠菜单「🎙 语音对话」= 打开聊天面板并自动开始录音：面板窗可能是刚创建的
  // （标记写入早于挂载，storage 事件收不到），挂载时自查待激活标记兜底
  const pendingAt = Number(localStorage.getItem('mqc.voice.pendingActivate') || 0);
  if (pendingAt && Date.now() - pendingAt < 30000 && isPanelChat() && voiceState === 'idle') {
    localStorage.removeItem('mqc.voice.pendingActivate');
    void handleMicClick();
  }
}
