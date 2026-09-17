// 桌宠「语音对话」独立面板（#panel-voice）：点菜单即进入纯语音场景——
// 大麦克风点按说话 → 识别自动发送 → 流式回复 → 自动朗读，与文字对话面板分开。
// 会话数据与文字对话共享（mqc.chat.sessions），模型/语音配置在主窗「对话」页维护。
// 走纯对话通道（sendChat），不接 Agent 工具循环——语音是即问即答场景。

import {
  loadSessions, saveSessions, appendToSession,
  buildQuotaContext, buildOutgoingMessages, getChatConfig, sendChat, cancelChat,
} from '../core/chat.js';
import {
  loadVoiceConfig, saveVoiceConfig, isVoiceConfigured, hasVoiceKey,
  createVoiceRecorder, transcribeAudio, speakText, stopSpeaking, speechFriendlyText,
} from '../core/voice.js';
import { escapeHtml } from './format.js';

export function voiceView() {
  return '<div class="voice-page" data-role="voice-root"></div>';
}

export function mountVoicePage(el, { repo, voiceDeps } = {}) {
  let { sessions, activeId } = loadSessions();
  if (!sessions.length) {
    const fresh = { id: `s-${Date.now()}`, title: '语音对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    ({ sessions, activeId } = saveSessions([fresh], fresh.id));
  }
  let messages = sessions.find((s) => s.id === activeId)?.messages ?? [];
  let streaming = false;
  let voiceState = 'idle';   // idle → recording → transcribing
  let voicePlaying = false;
  let voiceRecorder = null;
  let voiceConfig = loadVoiceConfig();

  const emitChatStatus = (state) => globalThis.__TAURI__?.event?.emit?.('pet-chat-status', { state });

  el.innerHTML = `
    <div class="voice-page">
      <div class="voice-head">
        <select data-role="voice-session" title="切换会话（与文字对话共享记录）"></select>
        <button class="btn chat-act${voiceConfig.autoRead ? ' active' : ''}" data-role="voice-read-toggle" title="回复朗读：回复完成后自动语音播报（点此开关）">🔊</button>
      </div>
      <div class="voice-messages chat-messages" data-role="voice-messages"></div>
      <div class="voice-status" data-role="voice-status">点一下麦克风，开始说话</div>
      <button class="voice-mic" data-role="voice-mic" aria-label="说话">🎙</button>
      <div class="voice-hint">点一下开始说话 · 再点一下发送</div>
    </div>`;

  const $ = (sel) => el.querySelector(sel);

  function syncMessages() {
    messages = sessions.find((s) => s.id === activeId)?.messages ?? [];
  }
  function appendToActiveSession(msg) {
    // 先从 storage 重读最新会话态再追加，防止另一窗口写入被整表覆盖
    const fresh = loadSessions();
    if (!fresh.sessions.length) return;
    ({ sessions, activeId } = appendToSession(fresh.sessions, fresh.activeId, msg));
    syncMessages();
  }

  function bubbleHtml(m) {
    const cls = m.role === 'user' ? 'user' : 'assistant';
    return `<div class="chat-bubble ${cls}${m.error ? ' error' : ''}"><span class="chat-text">${escapeHtml(m.content)}</span></div>`;
  }

  function renderMessages() {
    const box = $('[data-role="voice-messages"]');
    const html = messages.filter((m) => m.content).map((m) => bubbleHtml(m));
    box.innerHTML = html.join('') || '<div class="chat-welcome">按住下方按钮说话就能聊 👋<br/><small>回复会自动附上你的额度数据，也可以直接问「我还剩多少额度」</small></div>';
    box.scrollTop = box.scrollHeight;
  }

  function renderSession() {
    const sel = $('[data-role="voice-session"]');
    if (!sel) return;
    sel.innerHTML = sessions.length
      ? sessions.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === activeId ? 'selected' : ''}>${escapeHtml(s.title)}</option>`).join('')
      : '<option value="">（无会话）</option>';
  }

  function setStatus(text) {
    const el2 = $('[data-role="voice-status"]');
    if (el2) el2.textContent = text || '点一下麦克风，开始说话';
  }

  function renderMic() {
    const mic = $('[data-role="voice-mic"]');
    if (!mic) return;
    mic.classList.toggle('recording', voiceState === 'recording');
    mic.classList.toggle('busy', voiceState === 'transcribing' || voicePlaying || streaming);
    mic.textContent = voiceState === 'recording' ? '⏹' : voiceState === 'transcribing' ? '⏳' : '🎙';
  }

  function renderAll() {
    renderSession();
    renderMessages();
    renderMic();
  }

  // ——— 语音链路：点按说话 → 识别 → 自动发送 → 自动朗读 ———

  function micErrorHint(e) {
    const name = e?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '麦克风权限被拒绝：请检查 Windows 设置 › 隐私 › 麦克风 是否允许桌面应用';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有检测到可用的麦克风设备';
    if (name === 'NotReadableError') return '麦克风被其他应用占用或被系统关闭';
    return `录音失败：${String(e?.message || e)}`;
  }

  async function speakReply(reply) {
    const clean = speechFriendlyText(reply);
    if (!clean || !voiceConfig.autoRead) return;
    voicePlaying = true;
    renderMic();
    setStatus('朗读中…');
    emitChatStatus('speaking');
    try {
      await speakText(clean, loadVoiceConfig());
    } catch {
      /* 朗读失败静默：对话主链路不受影响 */
    }
    voicePlaying = false;
    renderMic();
    setStatus('点一下麦克风，继续说');
    emitChatStatus('idle');
  }

  async function doSend(text) {
    if (streaming || !text.trim()) return;
    const cfg = await getChatConfig();
    // 激活项失效（已删/残留）时与后端一致回退首家，不误报"没有对话模型"
    const profile = cfg.profiles.find((p) => p.id === cfg.active_profile_id) || cfg.profiles[0] || null;
    if (!profile) {
      setStatus('还没有对话模型：请在主窗「模型配置」页添加供应商');
      return;
    }

    stopSpeaking();
    voicePlaying = false;
    emitChatStatus('thinking');
    appendToActiveSession({ role: 'user', content: text, time: Date.now() });
    streaming = true;
    renderMessages();
    renderMic();
    setStatus('想一想…');

    const quotaCtx = buildQuotaContext(repo.listProviders());
    const outgoing = buildOutgoingMessages([...messages.slice(0, -1)], quotaCtx);
    outgoing.push({ role: 'user', content: text });

    let reply = '';
    const finish = (finalText, error) => {
      appendToActiveSession({
        role: 'assistant', content: finalText, error: !!error, time: Date.now(),
      });
      streaming = false;
      renderMessages();
      renderMic();
      emitChatStatus(error ? 'error' : 'replied');
      if (!error && finalText) void speakReply(finalText);
      else setStatus(error ? '出了点问题，再试一次吧' : '点一下麦克风，继续说');
    };

    const streamEl = () => $('[data-role="voice-messages"] .chat-bubble:last-child .chat-text');
    await sendChat(outgoing, {
      onToken: (t) => {
        reply += t;
        const node = streamEl();
        if (node) {
          node.textContent = reply;
          $('[data-role="voice-messages"]').scrollTop = 1e9;
        }
      },
      onDone: () => finish(reply, false),
      onError: (msg) => finish(reply || `（请求失败：${msg}）`, true),
      onCancelled: () => finish(reply || '（已停止）', false),
    });
  }

  async function startRecording() {
    if (voiceState !== 'idle' || streaming) return;
    stopSpeaking();
    voicePlaying = false;
    renderMic();
    const hasKey = await hasVoiceKey().catch(() => false);
    voiceConfig = loadVoiceConfig();
    if (!isVoiceConfigured(voiceConfig, hasKey)) {
      setStatus('语音服务还没配置：请在主窗「模型配置」页的「语音服务」里设置');
      return;
    }
    voiceRecorder = voiceRecorder || createVoiceRecorder(voiceDeps);
    try {
      await voiceRecorder.start({ onAutoStop: () => finishRecording() });
    } catch (e) {
      voiceRecorder = null;
      setStatus(micErrorHint(e));
      return;
    }
    voiceState = 'recording';
    renderMic();
    setStatus('我在听呢，说吧…（再点一下发送）');
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
      setStatus('录音太短啦，再说一句话的功夫');
      return;
    }
    voiceState = 'transcribing';
    renderMic();
    setStatus('让我听听你说了啥…');
    emitChatStatus('transcribing');
    void (async () => {
      try {
        const text = String(await transcribeAudio(result.wavBase64, loadVoiceConfig()) || '').trim();
        voiceState = 'idle';
        renderMic();
        emitChatStatus('idle');
        if (!text) { setStatus('没听清你说什么，再试一次？'); return; }
        await doSend(text);
      } catch (e) {
        voiceState = 'idle';
        renderMic();
        emitChatStatus('idle');
        setStatus(`识别失败：${String(e?.message || e)}`);
      }
    })();
  }

  // ——— 事件 ———
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    if (role === 'voice-mic') {
      if (voiceState === 'idle') await startRecording();
      else finishRecording();
    } else if (role === 'voice-read-toggle') {
      voiceConfig = loadVoiceConfig();
      voiceConfig.autoRead = !voiceConfig.autoRead;
      saveVoiceConfig(voiceConfig);
      btn.classList.toggle('active', voiceConfig.autoRead);
    }
  });

  el.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-role="voice-session"]');
    if (!sel) return;
    activeId = sel.value;
    syncMessages();
    renderMessages();
  });

  // ——— 桌宠菜单入口的自动激活：标记由 pet.js 打开面板前写入（60 秒内有效） ———
  const pendingAt = Number(globalThis.localStorage.getItem('mqc.voice.pendingActivate') || 0);
  if (pendingAt && Date.now() - pendingAt < 60 * 1000) {
    globalThis.localStorage.removeItem('mqc.voice.pendingActivate');
    void startRecording();
  }

  renderAll();

  return {
    destroy() {
      stopSpeaking();
    },
  };
}

