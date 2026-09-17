// 主窗「对话」页：完整会话 + 模型下拉切换（多供应商 × 多模型）+ 消息复制/编辑重发。
// 模型与语音的增删改在「模型配置」页（modelsView），本页只做选择与使用；
// 流式逻辑与存储复用 core/chat.js，与桌宠窗气泡共用同一后端命令。
// 自挂载组件（mountChatPage 由 app.js 在渲染后调用）。

import {
  loadSessions, saveSessions, appendToSession, deleteSession, newSession,
  buildQuotaContext, buildOutgoingMessages, attachmentsToText,
  isChatAvailable, getChatConfig, saveChatConfig,
  sendChat, cancelChat, readChatFile, agentSend, agentResolve, cancelAgent, isReadonlyTool,
} from '../core/chat.js';
import { listModelChoices, resolveActiveSelection, selectionValue, parseSelectionValue } from '../core/models.js';
import {
  loadVoiceConfig, saveVoiceConfig, isVoiceConfigured,
  hasVoiceKey, createVoiceRecorder, transcribeAudio, speakText, stopSpeaking, speechFriendlyText,
} from '../core/voice.js';
import { escapeHtml } from './format.js';

export function chatView() {
  return '<div class="chat-page" data-role="chat-root"></div>';
}

export function mountChatPage(el, { repo, voiceDeps, panel = false } = {}) {
  // persona 由「模型配置」页维护，这里只读回填（persist 时原样带回，避免互相覆盖）
  let config = { profiles: [], activeProfileId: null, activeModel: null, persona: '' };
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
  let agentRunning = false;
  let agentLive = [];   // 运行中的工具卡片（挂起的提议/已执行结果），不入会话
  let agentHandlers = null;
  // 编辑中的用户消息（messages 数组下标；null = 不在编辑）
  let editingMsg = null;
  let hint = '';
  // 语音对话：麦克风状态机 idle→recording→transcribing；朗读播放标记；
  // 录音器懒创建（首次点麦克风才申请 getUserMedia，避免挂载即碰媒体设备）
  let voiceConfig = loadVoiceConfig();
  let voiceRecorder = null;
  let voiceState = 'idle';
  let voicePlaying = false;

  // Agent 模式默认开启、只读工具自动批准默认开启——开关在主窗「设置 · 对话 Agent」，
  // 实时读 localStorage：设置页改动即时对所有对话窗口生效（聊天面板无按钮）
  const agentMode = () => localStorage.getItem('mqc.chat.agent') !== '0';
  const autoReadonly = () => localStorage.getItem('mqc.chat.agentAutoReadonly') !== '0';
  let chainApproved = false; // 多步自主：本任务内后续工具调用不再确认

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
      ${panel ? '' : `<button class="btn danger" data-role="chat-session-del" title="删除当前会话">删除会话</button>`}
      <select data-role="chat-profile" title="当前使用的模型（供应商与模型在主窗「模型配置」页管理）"></select>
    </div>
    <p class="settings-hint chat-hint" data-role="chat-hint" hidden></p>
    <div class="chat-messages" data-role="chat-messages"></div>
    <div class="chat-attachments" data-role="chat-attachments" hidden></div>
    <div class="chat-input">
      <textarea data-role="chat-input" rows="2" placeholder="和桌宠聊聊（Enter 发送）"></textarea>
      <div class="chat-input-actions">
        <button class="btn chat-act chat-mic" data-role="chat-mic" title="语音输入：点一下开始说话，再点一下识别并发送">🎙</button>
        <button class="btn chat-act" data-role="chat-attach" title="附加文件（pdf / docx / xlsx / txt / csv / json / 代码等文本类）">📎</button>
        <button class="btn chat-act${voiceConfig.autoRead ? ' active' : ''}" data-role="chat-voice-toggle" title="回复朗读：模型回复完成后自动语音播报（点此开关）">🔊</button>
        <button class="btn chat-act primary" data-role="chat-send" title="发送（Enter）">➤</button>
        <button class="btn chat-act" data-role="chat-stop" title="停止生成" hidden>⏹</button>
      </div>
    </div>`;

  const $ = (sel) => el.querySelector(sel);

  // ——— 渲染 ———

  function renderToolbar() {
    // 模型下拉：供应商 × 预设模型 展平（自由切换）；无配置时引导去「模型配置」页
    const sel = $('[data-role="chat-profile"]');
    if (sel) {
      const choices = listModelChoices(config.profiles);
      const active = resolveActiveSelection(config);
      const activeVal = active.profileId ? selectionValue(active.profileId, active.model) : '';
      sel.innerHTML = choices.length
        ? choices.map((c) => `<option value="${escapeHtml(selectionValue(c.profileId, c.model))}" ${selectionValue(c.profileId, c.model) === activeVal ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')
        : '<option value="">（未配置模型：去主窗「模型配置」页添加）</option>';
    }
    const sessionSel = $('[data-role="chat-session"]');
    sessionSel.innerHTML = sessions.length
      ? sessions.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === activeId ? 'selected' : ''}>${escapeHtml(s.title)}</option>`).join('')
      : '<option value="">（无会话）</option>';
  }

  function renderMessages() {
    const box = $('[data-role="chat-messages"]');
    const html = messages.map((m, idx) => bubbleHtml(m, idx));
    for (const c of agentLive) {
      if (c.kind === 'proposed' && !c.done) html.push(proposedCardHtml(c));
    }
    if (streaming && !agentMode()) html.push('<div class="chat-bubble assistant streaming" data-role="chat-stream"><span class="chat-text"></span><span class="chat-cursor"></span></div>');
    box.innerHTML = html.join('') || '<div class="chat-welcome">和桌宠打个招呼吧 👋<br/><small>对话发起时会自动附上你的额度数据，可以直接问「我还剩多少额度」</small></div>';
    box.scrollTop = box.scrollHeight;
  }

  function bubbleHtml(m, idx) {
    if (m.tool) {
      const t = m.tool;
      return `<div class="chat-tool-card${t.ok ? '' : ' fail'}${t.danger ? ' danger' : ''}">
        <div class="chat-tool-head">🔧 ${escapeHtml(t.name)} <span class="chat-tool-status">${t.ok ? '✓ 已执行' : '✗ 失败/拒绝'}${t.auto ? ' ⚡' : ''}</span></div>
        ${t.output ? `<pre class="chat-tool-out">${escapeHtml(String(t.output).slice(0, 600))}</pre>` : ''}
      </div>`;
    }
    const cls = m.role === 'user' ? 'user' : 'assistant';
    // 编辑态：该条用户消息变为编辑框（保存 = 截断其后历史并重发）
    if (m.role === 'user' && editingMsg === idx) {
      return `<div class="chat-bubble user editing">
        <textarea data-role="msg-edit-box" rows="3">${escapeHtml(m.content)}</textarea>
        <div class="chat-msg-edit-actions">
          <button class="btn primary" data-role="msg-edit-save" data-id="${idx}" title="丢弃这条之后的历史，用新内容重新发送">保存并重发</button>
          <button class="btn" data-role="msg-edit-cancel">取消</button>
        </div>
      </div>`;
    }
    const att = m.attachments?.length
      ? `<div class="chat-attach-list">${m.attachments.map((a) => `<span class="chat-attach-chip">📄 ${escapeHtml(a.name)}</span>`).join('')}</div>`
      : '';
    // 消息操作：复制常显；编辑仅用户消息且非流式（发送中断后即可编辑补发）
    const actions = `
      <div class="chat-msg-actions">
        <button class="chat-msg-act" data-role="msg-copy" data-id="${idx}" title="复制文本">⧉</button>
        ${m.role === 'user' && !streaming ? `<button class="chat-msg-act" data-role="msg-edit" data-id="${idx}" title="编辑并重发">✎</button>` : ''}
      </div>`;
    return `<div class="chat-bubble ${cls}${m.error ? ' error' : ''}">${att}<span class="chat-text">${escapeHtml(m.content)}</span>${actions}</div>`;
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

  function renderAll() {
    renderToolbar();
    renderMessages();
    renderAttachments();
  }

  // ——— 配置读写 ———

  async function reloadConfig() {
    const cfg = await getChatConfig();
    // Rust 侧 serde 字段名与这里对齐：profiles / active_profile_id / active_model / persona
    config = {
      profiles: cfg.profiles || [],
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

  // 整表替换当前会话消息（编辑重发截断用）：同样先重读再改，防跨窗覆盖
  function replaceActiveMessages(next) {
    const fresh = loadSessions();
    const list = fresh.sessions.map((s) => (s.id === activeId ? { ...s, messages: next, updatedAt: Date.now() } : s));
    ({ sessions, activeId } = saveSessions(list, activeId));
    syncMessages();
  }

  function setStreaming(on) {
    streaming = on;
    $('[data-role="chat-send"]').hidden = on;
    $('[data-role="chat-stop"]').hidden = !on;
    renderMessages();
  }

  // 发送一轮对话：调用前保证用户消息已入会话且为 messages 最后一条
  // （doSend 追加新消息；编辑重发则先截断改写历史），两种入口共用本函数
  async function runExchange(text, pendingAttachments) {
    // 激活项失效（已删/残留）时与 Rust 侧一致回退首家，不误报"没有可用模型"
    const active = resolveActiveSelection(config);
    if (!active.profileId) { hint = '还没有可用模型：请到主窗「模型配置」页添加供应商'; showHint(); return; }

    // 新消息打断上一条朗读（简易打断）；录音中不可能走到这里（麦克风入口已挡）
    stopSpeaking();
    voicePlaying = false;
    renderMic();

    emitChatStatus('thinking');
    const quotaCtx = buildQuotaContext(repo.listProviders());
    const outgoing = buildOutgoingMessages([...messages.slice(0, -1)], quotaCtx);
    outgoing.push({
      role: 'user',
      content: pendingAttachments.length ? `${text}
${attachmentsToText(pendingAttachments)}` : text,
    });

    if (agentMode()) {
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

  async function doSend(text) {
    if (streaming || !text.trim()) return;
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
    await runExchange(text, pendingAttachments);
  }

  // ——— 消息编辑重发 / 复制（发送中断后对已有消息仍可用） ———

  async function resendEdited(idx) {
    const box = $('[data-role="msg-edit-box"]');
    const text = (box?.value || '').trim();
    const m = messages[idx];
    if (!m || m.role !== 'user') return;
    if (!text) { hint = '内容不能为空'; showHint(); return; }
    editingMsg = null;
    // 截断：保留这条之前的历史 + 改写后的这条；其后消息（含中断残留的失败回复）丢弃
    const kept = [...messages.slice(0, idx), { ...m, content: text, time: Date.now() }];
    replaceActiveMessages(kept);
    setStreaming(true);
    await runExchange(text, m.attachments || []);
  }

  async function copyMessageText(text, btn) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // WebView 剪贴板 API 不可用时回退 execCommand
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '⧉';
        btn.classList.remove('copied');
      }, 1200);
    } catch {
      hint = '复制失败：剪贴板不可用'; showHint();
    }
  }

  // ——— Agent（单步确认式工具循环）———

  function makeAgentHandlers() {
    return {
      onToolProposed: (data) => {
        // ⚡ 只读自动批准：跳过确认卡直接放行（审计 auto=true）
        if (autoReadonly() && isReadonlyTool(data.name)) {
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

  function showHint() {
    const node = $('[data-role="chat-hint"]');
    if (node) {
      node.textContent = hint;
      node.hidden = !hint;
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
      hint = '语音服务还没配置好：请在主窗「模型配置」页的「语音服务」里保存设置并填入 API Key';
      showHint();
      return;
    }
    voiceRecorder = voiceRecorder || createVoiceRecorder(voiceDeps);
    try {
      await voiceRecorder.start({ onAutoStop: () => finishRecording() });
    } catch (e) {
      voiceRecorder = null;
      hint = micErrorHint(e);
      showHint();
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
      hint = '录音太短啦，点住感觉再说一句话的功夫';
      showHint();
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
        if (!text) { hint = '没听清你说什么，再试一次？'; showHint(); return; }
        const input = $('[data-role="chat-input"]');
        input.value = text;
        if (streaming) {
          hint = '正在回复上一条，识别文字已填入输入框';
          showHint();
          return;
        }
        input.value = '';
        await doSend(text);
      } catch (e) {
        voiceState = 'idle';
        renderMic();
        emitChatStatus('idle');
        hint = `识别失败：${String(e?.message || e)}`;
        showHint();
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
        if (attachments.length >= 4) { hint = '一条消息最多附加 4 个文件'; showHint(); break; }
        try {
          const att = await readChatFile(path);
          if (att) attachments.push(att);
        } catch (err) {
          hint = String(err?.message || err);
          showHint();
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
    } else if (role === 'msg-copy') {
      const m = messages[Number(id)];
      if (m) await copyMessageText(m.content || '', btn);
    } else if (role === 'msg-edit') {
      if (streaming) return;
      editingMsg = Number(id);
      renderMessages();
      const box = $('[data-role="msg-edit-box"]');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    } else if (role === 'msg-edit-save') {
      await resendEdited(Number(id));
    } else if (role === 'msg-edit-cancel') {
      editingMsg = null;
      renderMessages();
    } else if (role === 'agent-approve' || role === 'agent-deny' || role === 'agent-chain') {
      if (!agentRunning || !agentHandlers) return;
      el.querySelectorAll('.chat-tool-actions button').forEach((b) => (b.disabled = true));
      if (role === 'agent-chain') chainApproved = true;
      await agentResolve(role !== 'agent-deny', agentHandlers, { approveChain: role === 'agent-chain' });
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
    }
  });

  el.addEventListener('change', async (e) => {
    if (e.target.matches('[data-role="chat-session"]')) {
      if (streaming) { renderToolbar(); return; } // 流式中不允许切换（渲染会打断流式节点）
      activeId = e.target.value || activeId;
      editingMsg = null;
      saveSessions(sessions, activeId);
      syncMessages();
      renderMessages();
      return;
    }
    if (e.target.matches('[data-role="chat-profile"]')) {
      const sel = parseSelectionValue(e.target.value);
      if (!sel.profileId) return;
      config.activeProfileId = sel.profileId;
      config.activeModel = sel.model;
      await persistConfig();
      return;
    }
  });

  // 其他窗口（主窗 ↔ 桌宠面板）的会话变化经 storage 事件同步；流式中忽略，结束后再取。
  // （语音激活标记 mqc.voice.pendingActivate 的消费已移交给独立语音面板 voiceView）
  globalThis.addEventListener?.('storage', (e) => {
    if (!e.key || (e.key !== 'mqc.chat.sessions' && e.key !== 'mqc.chat.activeSession')) return;
    if (streaming) return;
    ({ sessions, activeId } = loadSessions());
    editingMsg = null;
    syncMessages();
    renderAll();
  });

  el.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-role="chat-input"]') && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (text && !streaming) { e.target.value = ''; void doSend(text); }
    }
    // 编辑框内 Enter = 保存重发（Shift+Enter 换行）
    if (e.target.matches('[data-role="msg-edit-box"]') && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void resendEdited(editingMsg);
    }
  });

  // 初始化
  void reloadConfig();
}
