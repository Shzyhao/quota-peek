import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  encodeWav, downsampleMono, arrayBufferToBase64, base64ToArrayBuffer,
  speechFriendlyText, loadVoiceConfig, saveVoiceConfig, isVoiceConfigured,
  DEFAULT_VOICE_CONFIG, createVoiceRecorder, transcribeAudio, speakText, stopSpeaking,
} from '../src/core/voice.js';

// ——— WAV 编码 ———

describe('encodeWav', () => {
  it('生成 44 字节头 + 16bit 单声道 PCM 的合法 WAV', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    const buf = encodeWav(samples, 16000);
    const v = new DataView(buf);
    const ascii = (off, n) => String.fromCharCode(...new Uint8Array(buf, off, n));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // 单声道
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16); // 位深
    expect(v.getUint32(40, true)).toBe(8); // data 块 = 4 样本 × 2 字节
    expect(buf.byteLength).toBe(44 + 8);
    expect(v.getInt16(44 + 2 * 1, true)).toBe(Math.round(0.5 * 0x7fff)); // 0.5
    expect(v.getInt16(44 + 2 * 2, true)).toBe(-Math.round(0.5 * 0x8000)); // -0.5
  });

  it('越界采样被钳制到 [-1, 1]', () => {
    const buf = encodeWav(new Float32Array([2, -2]), 16000);
    const v = new DataView(buf);
    expect(v.getInt16(44, true)).toBe(0x7fff);
    expect(v.getInt16(46, true)).toBe(-0x8000);
  });
});

describe('downsampleMono', () => {
  it('48k→16k 时长按比例缩短', () => {
    // 3 个 48k 样本（1, 0, -1）→ 1 个 16k 样本（比值 3，取位置 0 = 1）
    expect(downsampleMono(new Float32Array([1, 0, -1]), 48000, 16000)).toEqual(new Float32Array([1]));
    // 6 个样本 → 2 个：位置 0、3 直接取到样本 0 与 9
    const whole = downsampleMono(new Float32Array([0, 3, 6, 9, 12, 15]), 48000, 16000);
    expect(whole.length).toBe(2);
    expect(whole[0]).toBe(0);
    expect(whole[1]).toBe(9);
  });

  it('非整数比值时线性插值（48k→32k，比值 1.5：位置 1.5 = 1 与 2 的中点）', () => {
    const out = downsampleMono(new Float32Array([0, 1, 2]), 48000, 32000);
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1.5);
  });

  it('目标率不低于源率时原样返回', () => {
    const src = new Float32Array([0.1, 0.2]);
    expect(downsampleMono(src, 16000, 16000)).toBe(src);
    expect(downsampleMono(src, 8000, 16000)).toBe(src);
  });
});

describe('base64 编解码', () => {
  it('round-trip 还原字节', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 77]);
    const b64 = arrayBufferToBase64(bytes.buffer);
    expect(new Uint8Array(base64ToArrayBuffer(b64))).toEqual(bytes);
  });
});

// ——— 朗读文本清洗 ———

describe('speechFriendlyText', () => {
  it('空值与纯文本原样返回', () => {
    expect(speechFriendlyText('')).toBe('');
    expect(speechFriendlyText(null)).toBe('');
    expect(speechFriendlyText('你好呀')).toBe('你好呀');
  });

  it('代码块替换为占位符，行内代码保留内容', () => {
    const t = speechFriendlyText('看这段：\n```js\nconst a = 1;\n```');
    expect(t).toContain('（代码略）');
    expect(t).not.toContain('const');
    expect(speechFriendlyText('用 `npm run build` 构建')).toBe('用 npm run build 构建');
  });

  it('剥掉链接/图片/标题/加粗/列表/引用符号，保留文字', () => {
    const md = [
      '## 重点总结',
      '',
      '- **第一项**很重要',
      '- *第二项斜体*',
      '> 引用一句话',
      '详情[见文档](https://example.com/x)',
      '![截图](https://example.com/a.png)',
    ].join('\n');
    const t = speechFriendlyText(md);
    expect(t).toContain('重点总结');
    expect(t).toContain('第一项很重要');
    expect(t).toContain('第二项斜体');
    expect(t).toContain('引用一句话');
    expect(t).toContain('详情见文档');
    expect(t).toContain('截图');
    expect(t).not.toMatch(/[#>*[\]!]|http/);
  });

  it('表格：分隔行删除，数据行竖线改顿号', () => {
    const t = speechFriendlyText('| 供应商 | 用量 |\n| --- | --- |\n| Z.ai | 80% |');
    expect(t).not.toContain('---');
    expect(t).not.toContain('|');
    expect(t).toContain('Z.ai');
    expect(t).toContain('80%');
  });
});

// ——— 配置 ———

describe('语音配置', () => {
  beforeEach(() => localStorage.clear());

  it('默认预置硅基流动；saveVoiceConfig 做字段级合并', () => {
    expect(loadVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
    expect(DEFAULT_VOICE_CONFIG.asrBaseUrl).toBe('https://api.siliconflow.cn/v1');
    saveVoiceConfig({ autoRead: false, ttsVoice: 'X:ben' });
    const cfg = loadVoiceConfig();
    expect(cfg.autoRead).toBe(false);
    expect(cfg.ttsVoice).toBe('X:ben');
    expect(cfg.asrModel).toBe(DEFAULT_VOICE_CONFIG.asrModel); // 未触及字段保持默认
  });

  it('损坏的存储内容回退默认', () => {
    localStorage.setItem('mqc.voice.config', '{broken json');
    expect(loadVoiceConfig()).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it('isVoiceConfigured 要求 Key 与全部字段', () => {
    expect(isVoiceConfigured(DEFAULT_VOICE_CONFIG, true)).toBe(true);
    expect(isVoiceConfigured(DEFAULT_VOICE_CONFIG, false)).toBe(false);
    expect(isVoiceConfigured({ ...DEFAULT_VOICE_CONFIG, asrBaseUrl: '' }, true)).toBe(false);
  });
});

// ——— 录音器 ———

function fakeRecorderDeps() {
  const stops = [];
  const ctx = {
    sampleRate: 48000,
    createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
    createScriptProcessor: () => {
      const node = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
      ctx.__lastNode = node;
      return node;
    },
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
    destination: {},
    close: vi.fn(async () => {}),
  };
  class AudioContext { constructor() { return ctx; } }
  let now = 1000;
  return {
    deps: {
      AudioContext,
      targetSampleRate: 16000,
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => stops.push(1) }] }),
      now: () => now,
    },
    advance: (ms) => { now += ms; },
    pushChunk: (data) => ctx.__lastNode?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } }),
    stops,
  };
}

describe('createVoiceRecorder', () => {
  it('start→灌入 PCM→stop 得到 16k WAV 与时长；流与上下文全部释放', async () => {
    const f = fakeRecorderDeps();
    const rec = createVoiceRecorder(f.deps);
    await rec.start({});
    f.pushChunk(new Float32Array(4800)); // 0.1s @48k
    f.advance(1200);
    const result = rec.stop();
    expect(result.durationMs).toBe(1200);
    const v = new DataView(base64ToArrayBuffer(result.wavBase64));
    expect(v.getUint32(24, true)).toBe(16000); // 降采样到 16k
    expect(v.getUint32(40, true)).toBe(1600 * 2); // 4800/3 = 1600 样本
    expect(f.stops.length).toBeGreaterThan(0);
  });

  it('未录音时 stop 返回 null；cancel 丢弃且不产生结果', async () => {
    const f = fakeRecorderDeps();
    const rec = createVoiceRecorder(f.deps);
    expect(rec.stop()).toBeNull();
    await rec.start({});
    f.pushChunk(new Float32Array(4800));
    rec.cancel();
    expect(rec.isRecording()).toBe(false);
    expect(rec.stop()).toBeNull();
    expect(f.stops.length).toBeGreaterThan(0);
  });

  it('60 秒自动停止回调触发一次', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeRecorderDeps();
      const onAutoStop = vi.fn();
      const rec = createVoiceRecorder(f.deps);
      await rec.start({ onAutoStop });
      vi.advanceTimersByTime(60000);
      expect(onAutoStop).toHaveBeenCalledTimes(1);
      rec.stop();
      vi.advanceTimersByTime(60000);
      expect(onAutoStop).toHaveBeenCalledTimes(1); // 停止后不再触发
    } finally {
      vi.useRealTimers();
    }
  });
});

// ——— 识别 / 朗读（走 invoke，注入桩） ———

function stubInvoke(handler) {
  globalThis.__TAURI__ = { core: { invoke: vi.fn(handler) } };
}

describe('识别与朗读 IPC', () => {
  it('transcribeAudio 以 camelCase 传参调 voice_transcribe', async () => {
    stubInvoke(async (cmd, args) => (cmd === 'voice_transcribe' ? '识别出的文字' : null));
    const out = await transcribeAudio('QHVuaXR0ZXN0', {
      asrBaseUrl: 'https://x.example/v1', asrModel: 'm1',
    });
    expect(out).toBe('识别出的文字');
    const call = globalThis.__TAURI__.core.invoke.mock.calls[0];
    expect(call[0]).toBe('voice_transcribe');
    expect(call[1]).toEqual({ baseUrl: 'https://x.example/v1', model: 'm1', audioBase64: 'QHVuaXR0ZXN0' });
  });

  it('speakText 合成后播放并在 onended 结束；stopSpeaking 打断中', async () => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
    class FakeAudio {
      constructor(src) { FakeAudio.instances.push(this); this.src = src; this.onended = null; this.onpause = null; this.onerror = null; }
      async play() {}
      pause() { this.onpause?.(); }
    }
    FakeAudio.instances = [];
    stubInvoke(async (cmd) => (cmd === 'voice_speak' ? arrayBufferToBase64(new Uint8Array([1, 2, 3])) : null));

    const first = speakText('第一段', { ttsBaseUrl: 'https://x/v1', ttsModel: 'm', ttsVoice: 'v' }, { Audio: FakeAudio });
    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(1));
    // 第二次朗读自动打断第一次
    const second = speakText('第二段', { ttsBaseUrl: 'https://x/v1', ttsModel: 'm', ttsVoice: 'v' }, { Audio: FakeAudio });
    await expect(first).resolves.toBe('stopped');

    await vi.waitFor(() => expect(FakeAudio.instances.length).toBe(2));
    const a2 = FakeAudio.instances[1];
    expect(a2.src).toBe('blob:test');
    a2.onended();
    await expect(second).resolves.toBe('ended');

    // 播放已结束：手动停返回 false
    expect(stopSpeaking()).toBe(false);
  });
});
