#!/usr/bin/env node
// v0.9.0 语音对话 E2E（CDP 直连 WebView2）：
//   本地起 mock 语音服务（transcriptions/speech）→ 带 CDP 启动 exe →
//   主窗对话页：配语音服务 → 点麦克风录音 → 再点停止 → mock 识别文本自动发送 →
//   回复完成自动朗读（mock 合成 mp3）→ 桌宠菜单「🎙 语音对话」开面板自动进录音态。
// 用法：node scripts/cdp-verify-v090-voice.mjs
// 前置：npm run desktop:build 已产出 src-tauri/target/release/model-quota-app.exe；
//       脚本会先查杀 model-quota 旧进程，结束时恢复原语音配置并删 mock key。
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = `${fileURLToPath(new URL('..', import.meta.url))}`;
const EXE = `${ROOT}src-tauri/target/release/model-quota-app.exe`;
const CDP_PORT = 9223;
const MOCK_PORT = 9256;
const MOCK_TEXT = 'CDP语音测试：桌宠收到没';
const SHOTS = `${ROOT}shots`;
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

// ——— mock 语音服务：识别回固定文本；合成回合法 WAV（0.5s 静音，Chromium 可解码播放） ———
function wavSilence() {
  const sampleRate = 16000;
  const seconds = 0.5;
  const n = Math.floor(sampleRate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, n * 2, true);
  return Buffer.from(buf);
}
const server = http.createServer((req, res) => {
  if (req.url.endsWith('/audio/transcriptions')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: MOCK_TEXT }));
    });
  } else if (req.url.endsWith('/audio/speech')) {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(wavSilence());
    });
  } else {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`mock 语音服务: http://127.0.0.1:${MOCK_PORT}/v1`);

// ——— CDP 小客户端（Node 原生 WebSocket 直连，cdp-shot.mjs 同款协议） ———
const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, err) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', err, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((ok) => {
    const id = ++seq;
    pending.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(`页面求值失败: ${d.text} ${d.exception?.description || ''}`.trim());
    }
    return r.result?.result?.value;
  };
  return { ws, send, evalJs };
};
const targets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  } catch {
    return []; // 端口尚未就绪（exe 启动中），继续轮询
  }
};
const findTarget = async (match, timeoutMs = 30000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = (await targets()).find((t) => match(t));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
};
const pollEval = async (conn, expression, timeoutMs = 12000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await conn.evalJs(expression)) return true;
    await sleep(250);
  }
  return false;
};
const shot = async (conn, file) => {
  const r = await conn.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}/${file}`, Buffer.from(r.result.data, 'base64'));
};

// ——— 查杀旧实例（单实例插件会把新进程转发给旧的） ———
try {
  execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.ExecutablePath -like '*model-quota*' } | Stop-Process -Force"`, { stdio: 'ignore' });
} catch { /* 没有旧进程 */ }
await sleep(800);

// ——— 带 CDP 启动 exe ———
const proc = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: 'ignore',
  detached: false,
});
try {
  const main = await findTarget((t) => t.type === 'page' && !/#(pet|mini|ball|panel-)/.test(t.url));
  if (!main) throw new Error('主窗 target 未出现');
  const mainConn = await connect(main.webSocketDebuggerUrl);
  await mainConn.send('Page.enable');
  // 等页面与 Tauri IPC 就绪（连接可能早于首次加载完成，过早求值会撞上上下文销毁）
  const mainReady = await pollEval(mainConn, `document.readyState === 'complete' && !!globalThis.__TAURI__?.core?.invoke`, 30000);
  if (!mainReady) throw new Error('主窗页面 30s 未就绪');

  // 备份原语音配置与聊天会话；写入指向 mock 的配置 + mock key
  const prevConfig = await mainConn.evalJs(`localStorage.getItem('mqc.voice.config')`);
  const prevSessions = await mainConn.evalJs(`localStorage.getItem('mqc.chat.sessions')`);
  const chatConfigured = await mainConn.evalJs(`(async () => {
    const c = await globalThis.__TAURI__.core.invoke('chat_get_config');
    return !!(c.active_profile_id && c.profiles?.length);
  })()`);
  check('聊天模型已配置（真实回复链路可用）', !!chatConfigured, chatConfigured ? '' : '未配置对话模型，自动发送后的回复环节降级为软检查');

  await mainConn.evalJs(`localStorage.setItem('mqc.voice.config', ${JSON.stringify(JSON.stringify({
    asrBaseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    asrModel: 'mock-asr',
    ttsBaseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    ttsModel: 'mock-tts',
    ttsVoice: 'mock-voice',
    autoRead: true,
  }))}); 'ok'`);
  await mainConn.evalJs(`globalThis.__TAURI__.core.invoke('voice_secret_set', { key: 'mock-key' }).then(() => 'ok')`);
  const hasKey = await mainConn.evalJs(`globalThis.__TAURI__.core.invoke('voice_secret_has').then(v => v === true)`);
  check('voice_secret_set/has 写读凭据管理器', !!hasKey);

  // 重载主窗使配置生效，切到「对话」页
  await mainConn.evalJs(`location.reload()`);
  await pollEval(mainConn, `document.readyState === 'complete' && !!document.body`, 20000);
  await mainConn.evalJs(`(() => { const nav = [...document.querySelectorAll('[data-action="nav"]')].find(n => n.dataset.view === 'chat'); nav?.click(); return 'ok'; })()`);
  const micReady = await pollEval(mainConn, `!!document.querySelector('[data-role="chat-mic"]')`, 15000);
  check('对话页挂载出麦克风按钮', micReady);

  // 点麦克风开始录音（--use-fake-ui-for-media-stream 自动授权），录满 1.5s 再停
  await mainConn.evalJs(`document.querySelector('[data-role="chat-mic"]').click(); 'ok'`);
  const recording = await pollEval(mainConn, `document.querySelector('[data-role="chat-mic"]')?.classList.contains('recording')`, 10000);
  check('麦克风点击进入录音态（getUserMedia 授权 + PCM 采集）', recording);
  await shot(mainConn, 'v090-voice-1-recording.png');
  await sleep(1500);

  // 再点停止 → 识别（mock）→ 自动发送 → 会话里出现识别文本
  await mainConn.evalJs(`document.querySelector('[data-role="chat-mic"]').click(); 'ok'`);
  const sent = await pollEval(mainConn, `(() => {
    const s = JSON.parse(localStorage.getItem('mqc.chat.sessions') || '[]');
    return s.some(x => (x.messages || []).some(m => m.role === 'user' && m.content === ${JSON.stringify(MOCK_TEXT)}));
  })()`, 15000);
  const micHint = sent ? '' : await mainConn.evalJs(`document.querySelector('[data-role="chat-test-result"]')?.textContent || ''`);
  check('识别文本自动发送进会话（ASR mock → voice_transcribe → doSend）', sent, micHint);
  await shot(mainConn, 'v090-voice-2-sent.png');

  // 回复完成：真实模型回复后自动朗读。硬检查 = 会话出现 assistant 回复；
  // 朗读观察 = mic busy 态（合成+播放期间保持）
  const replied = chatConfigured
    ? await pollEval(mainConn, `(() => {
        const s = JSON.parse(localStorage.getItem('mqc.chat.sessions') || '[]');
        return s.some(x => (x.messages || []).some(m => m.role === 'assistant' && !m.error && m.content && !m.tool));
      })()`, 90000)
    : false;
  check('对话链路回复完成（真实 chat_send）', !!replied, chatConfigured ? '' : '跳过（未配置聊天模型）');
  const spoke = chatConfigured && replied
    ? await pollEval(mainConn, `document.querySelector('[data-role="chat-mic"]')?.classList.contains('busy')`, 20000)
    : false;
  check('回复完成自动朗读（TTS mock → 音频播放中 busy 态）', !!spoke, chatConfigured ? (spoke ? '' : '回复已完成但未观察到 busy 朗读态') : '跳过');
  await shot(mainConn, 'v090-voice-3-reply.png');

  // ——— 桌宠链路：点桌宠 → 菜单含「语音对话」→ 点击 → 面板打开并自动进录音态 ———
  const pet = await findTarget((t) => t.type === 'page' && /#pet/.test(t.url));
  if (!pet) {
    check('桌宠窗存在', false, '#pet target 未找到（悬浮形态可能被关闭）');
  } else {
    const petConn = await connect(pet.webSocketDebuggerUrl);
    await petConn.evalJs(`document.querySelector('.pet-stage')?.click(); 'ok'`);
    await sleep(300);
    const hasVoiceMenu = await petConn.evalJs(`[...document.querySelectorAll('[data-menu="voice"]')].length > 0`);
    check('桌宠菜单含「🎙 语音对话」入口', hasVoiceMenu);
    await shot(petConn, 'v090-voice-4-petmenu.png');

    await petConn.evalJs(`document.querySelector('[data-menu="voice"]')?.click(); 'ok'`);
    // 面板窗出现（首次创建）或已存在（storage 激活）
    const panelTarget = await findTarget((t) => t.type === 'page' && /#panel-chat/.test(t.url), 8000);
    check('语音入口打开对话面板', !!panelTarget);
    if (panelTarget) {
      const panelConn = await connect(panelTarget.webSocketDebuggerUrl);
      const panelRecording = await pollEval(panelConn, `document.querySelector('[data-role="chat-mic"]')?.classList.contains('recording')`, 10000);
      if (!panelRecording) {
        // 失败诊断：面板内的按钮态/提示/标记残留 + 桌宠气泡状态
        const diag = await panelConn.evalJs(`(() => ({
          mic: document.querySelector('[data-role="chat-mic"]')?.className || '(无按钮)',
          hint: document.querySelector('[data-role="chat-test-result"]')?.textContent || '',
          marker: localStorage.getItem('mqc.voice.pendingActivate'),
          input: document.querySelector('[data-role="chat-input"]') ? '有输入框' : '无输入框',
        }))()`);
        const petBubble = await petConn.evalJs(`document.querySelector('.pet-bubble')?.textContent || ''`);
        check('面板自动进入录音态（pendingActivate 激活链）', false, JSON.stringify({ ...diag, petBubble }));
      } else {
        check('面板自动进入录音态（pendingActivate 激活链）', true);
      }
      if (panelRecording) {
        await shot(panelConn, 'v090-voice-5-panel.png'); // 录音态截图
        await sleep(1200); // 录满 1.2s 再停，避免"录音太短"提示弹出配置区
        await panelConn.evalJs(`document.querySelector('[data-role="chat-mic"]').click(); 'ok'`);
      } else {
        await shot(panelConn, 'v090-voice-5-panel.png');
      }
      panelConn.ws.close();
    }
    petConn.ws.close();
  }

  // ——— 清理：取消在途请求、还原语音配置与聊天会话、删 mock key ———
  await mainConn.evalJs(`globalThis.__TAURI__.core.invoke('chat_cancel').catch(() => {}); 'ok'`);
  await sleep(2000); // 等面板侧在途的识别/发送落盘，避免还原后被回写
  await mainConn.evalJs(`localStorage.setItem('mqc.chat.sessions', ${JSON.stringify(prevSessions ?? '')}); 'ok'`);
  await mainConn.evalJs(`localStorage.setItem('mqc.voice.config', ${JSON.stringify(prevConfig ?? '')}); 'ok'`);
  await mainConn.evalJs(`globalThis.__TAURI__.core.invoke('voice_secret_delete').then(() => 'ok')`);
  check('清理 mock key、还原语音配置与聊天会话', true, prevConfig ? '已还原原配置' : '原无配置已置空');
  mainConn.ws.close();
} catch (e) {
  check('E2E 异常中断', false, String(e?.message || e));
} finally {
  server.close();
  try { proc.kill(); } catch { /* 已退出 */ }
  // 兜底关壳（隐藏窗口驻留托盘，必须显式杀）
  await sleep(500);
  try {
    execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.ExecutablePath -like '*model-quota*' } | Stop-Process -Force"`, { stdio: 'ignore' });
  } catch { /* 已退出 */ }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n==== 语音 E2E：${pass}/${results.length} 项通过 ====`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
