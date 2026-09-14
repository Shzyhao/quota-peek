// 语音对话核心：麦克风录音（PCM → 16k 单声道 WAV）→ OpenAI 兼容 /audio/transcriptions
// 识别 → /audio/speech 合成朗读。密钥走桌面壳 keyring（voice_secret_*，条目 voice_key），
// 配置存 localStorage（非敏感）。录音用 ScriptProcessorNode 累积 PCM、停止后整段编码
// WAV（识别服务对 wav 兼容性最好），不做流式识别；朗读整段合成播放，新朗读/新录音
// 会打断上一段（简易打断）。

const tauriCore = () => globalThis.__TAURI__?.core;

async function invoke(cmd, args) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error('仅桌面版支持语音服务');
  return core.invoke(cmd, args);
}

// ——— 密钥（Windows 凭据管理器） ———

export function setVoiceKey(key) {
  return invoke('voice_secret_set', { key });
}

export function hasVoiceKey() {
  return invoke('voice_secret_has');
}

export function deleteVoiceKey() {
  return invoke('voice_secret_delete');
}

// ——— 配置（localStorage，非敏感；Key 永不入 localStorage） ———

export const VOICE_CONFIG_KEY = 'mqc.voice.config';

export const DEFAULT_VOICE_CONFIG = {
  // OpenAI 兼容音频端点，默认预置硅基流动（SenseVoiceSmall 识别免费、CosyVoice2 合成近零成本）
  asrBaseUrl: 'https://api.siliconflow.cn/v1',
  asrModel: 'FunAudioLLM/SenseVoiceSmall',
  ttsBaseUrl: 'https://api.siliconflow.cn/v1',
  ttsModel: 'FunAudioLLM/CosyVoice2-0.5B',
  // 硅基流动音色格式：<model>:<音色名>
  ttsVoice: 'FunAudioLLM/CosyVoice2-0.5B:anna',
  autoRead: true,
};

export function loadVoiceConfig(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(VOICE_CONFIG_KEY);
    return { ...DEFAULT_VOICE_CONFIG, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_VOICE_CONFIG };
  }
}

export function saveVoiceConfig(cfg, storage = globalThis.localStorage) {
  const merged = { ...loadVoiceConfig(storage), ...cfg };
  storage?.setItem(VOICE_CONFIG_KEY, JSON.stringify(merged));
  return merged;
}

export function isVoiceConfigured(cfg, hasKey) {
  return !!hasKey && !!(cfg.asrBaseUrl && cfg.asrModel && cfg.ttsBaseUrl && cfg.ttsModel && cfg.ttsVoice);
}

// ——— 音频编码 ———

/// Float32 采样（-1..1）转 16bit PCM 单声道 WAV 的 ArrayBuffer
export function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const ascii = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率 = 采样率 × 2 字节
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    off += 2;
  }
  return buffer;
}

/// 线性插值降采样（48k→16k 等）；目标率不低于源率时原样返回
export function downsampleMono(samples, fromRate, toRate) {
  if (!fromRate || fromRate <= toRate || !samples.length) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// ——— 录音（点按式：start → stop/cancel） ———

export const MAX_RECORD_MS = 60000;
const TARGET_SAMPLE_RATE = 16000;

/// 录音器工厂。deps 可注入 getUserMedia/AudioContext/now 便于单测。
/// start({ onAutoStop }) 超时自动触发回调（由 UI 决定此刻去 stop）；
/// stop() 返回 { wavBase64, durationMs }，cancel() 丢弃录音。
export function createVoiceRecorder(deps = {}) {
  const getUserMedia = deps.getUserMedia ||
    ((constraints) => globalThis.navigator.mediaDevices.getUserMedia(constraints));
  const AudioCtx = deps.AudioContext || globalThis.AudioContext;
  const now = deps.now || (() => Date.now());
  const targetRate = deps.targetSampleRate ?? TARGET_SAMPLE_RATE;

  let stream = null;
  let ctx = null;
  let source = null;
  let processor = null;
  let chunks = [];
  let sampleRate = targetRate;
  let recording = false;
  let startedAt = 0;
  let autoStopTimer = null;

  function teardown() {
    if (processor) {
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch { /* 已断开 */ }
    }
    if (source) { try { source.disconnect(); } catch { /* 已断开 */ } }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) { try { void ctx.close(); } catch { /* 已关闭 */ } }
    processor = source = stream = ctx = null;
  }

  async function start({ onAutoStop } = {}) {
    if (recording) throw new Error('已在录音中');
    stream = await getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    ctx = new AudioCtx();
    sampleRate = ctx.sampleRate;
    chunks = [];
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode 已废弃但零依赖最稳（AudioWorklet 需独立模块脚本，双窗口加载更繁琐）；
    // 经零增益节点接 destination 触发处理且不外放
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (ev) => {
      if (!recording) return;
      chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    processor.connect(silent);
    silent.connect(ctx.destination);
    recording = true;
    startedAt = now();
    if (onAutoStop) {
      autoStopTimer = setTimeout(() => {
        autoStopTimer = null;
        onAutoStop();
      }, MAX_RECORD_MS);
    }
  }

  function stop() {
    if (!recording) return null;
    recording = false;
    if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
    const durationMs = now() - startedAt;
    let merged = chunks;
    chunks = [];
    teardown();
    const flat = new Float32Array(merged.reduce((a, c) => a + c.length, 0));
    let off = 0;
    for (const c of merged) { flat.set(c, off); off += c.length; }
    merged = null;
    const finalSamples = downsampleMono(flat, sampleRate, targetRate);
    const wav = encodeWav(finalSamples, Math.min(sampleRate, targetRate));
    return { wavBase64: arrayBufferToBase64(wav), durationMs };
  }

  function cancel() {
    if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
    recording = false;
    chunks = [];
    teardown();
  }

  return { start, stop, cancel, isRecording: () => recording };
}

// ——— 识别与朗读 ———

/// 识别：wavBase64 → 文本（Rust 侧请求 OpenAI 兼容 transcriptions）
export async function transcribeAudio(wavBase64, cfg) {
  return invoke('voice_transcribe', {
    baseUrl: cfg.asrBaseUrl,
    model: cfg.asrModel,
    audioBase64: wavBase64,
  });
}

let currentAudio = null;

/// 停止正在播放的朗读。返回是否确有播放被打断
export function stopSpeaking() {
  if (!currentAudio) return false;
  try { currentAudio.pause(); } catch { /* 已停止 */ }
  currentAudio = null;
  return true;
}

/// 合成并播放。resolve('ended'|'stopped'|'error')；同一时刻只有一段朗读在播，
/// 新调用自动打断旧播放。抛错（无 Key/网络失败）由调用方处理。
export async function speakText(text, cfg, deps = {}) {
  stopSpeaking();
  const AudioImpl = deps.Audio || globalThis.Audio;
  const audioB64 = await invoke('voice_speak', {
    baseUrl: cfg.ttsBaseUrl,
    model: cfg.ttsModel,
    voice: cfg.ttsVoice,
    text,
  });
  const blob = new Blob([base64ToArrayBuffer(audioB64)], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const audio = new AudioImpl(url);
  currentAudio = audio;
  const done = new Promise((resolve) => {
    audio.onended = () => resolve('ended');
    audio.onpause = () => resolve('stopped');
    audio.onerror = () => resolve('error');
  });
  try {
    await audio.play();
  } catch {
    if (currentAudio === audio) { URL.revokeObjectURL(url); currentAudio = null; }
    return 'error';
  }
  const reason = await done;
  if (currentAudio === audio) { URL.revokeObjectURL(url); currentAudio = null; }
  return reason;
}

// ——— 朗读文本清洗 ———

/// markdown 回复转朗读友好纯文本：代码块以占位符替代（逐字念代码没有意义），
/// 剥掉强调/链接/标题/引用/表格等排版符号，保留文字内容与自然停顿。
export function speechFriendlyText(md) {
  if (!md) return '';
  let t = String(md);
  t = t.replace(/```[\s\S]*?(```|$)/g, '（代码略）');
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ''); // 表格分隔行
  t = t.replace(/\|/g, '，'); // 其余表格行读作顿开
  t = t.replace(/\*\*\*(.+?)\*\*\*/gs, '$1');
  t = t.replace(/\*\*(.+?)\*\*/gs, '$1');
  t = t.replace(/\*(.+?)\*/gs, '$1');
  t = t.replace(/__(.+?)__/gs, '$1');
  t = t.replace(/_(.+?)_/gs, '$1');
  t = t.replace(/~~(.+?)~~/gs, '$1');
  t = t.replace(/^\s*[-+*]\s+/gm, ''); // 无序列表符号
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
