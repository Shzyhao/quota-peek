// 桌宠视图（#pet）：Live2D 人物悬浮窗，取代经典悬浮球形态。
// 交互约定与悬浮球一致：拖动（>6px 位移）= 原生窗口拖动；原地单击 = 桌宠互动。
// 底部常驻紧凑输入条，可直接与桌宠对话（流式气泡显示回复，会话历史与主窗「对话」页共享）。
//
// 依赖加载顺序是硬约束：pixi-live2d-display 的 cubism2/cubism4 入口在模块求值时
// 就检查各自运行时全局对象（window.Live2D / window.Live2DCubismCore），缺失即抛错
// ——因此运行时脚本（版权原因不入 npm，作为静态资源）必须先于库加载，pixi 系模块
// 全部走动态 import（也让 main/mini/ball 窗口不必背上 pixi 的体积）。

import {
  loadHistory, saveHistory, buildQuotaContext, buildOutgoingMessages,
  isChatAvailable, sendChat, cancelChat,
} from '../core/chat.js';
import { analyzeFiles } from '../core/analysis.js';
import { escapeHtml } from './format.js';

/// 桌宠形象配置：换模型/换皮肤只改这里。
/// runtime 决定运行时脚本与库入口；motions 为模型动作组（点击随机播）；
/// headHit 存在时点击头部优先触发表情（仅 Cubism 4 标准模型有 hit_areas）。
const PET_MODELS = {
  // bilibili 22 娘（Cubism 2.1，Q 版半身，社区开源 GPL，皮肤系统在 leeyiding 仓库）
  mascot22: {
    runtime: 'cubism2',
    url: '/assets/live2d/22/model.json',
    idle: 'idle',
    motions: ['tap_body', 'thanking'],
  },
  // Haru（Live2D 官方示例，Cubism 4，全身写实比例）
  haru: {
    runtime: 'cubism4',
    url: '/assets/live2d/haru/haru_greeter_t03.model3.json',
    idle: 'Idle',
    motions: ['Tap'],
    headHit: 'Head',
  },
};
const MODEL = PET_MODELS.mascot22;

const RUNTIME_SCRIPTS = {
  cubism2: '/assets/lib/live2d.min.js',        // 提供 window.Live2D
  cubism4: '/assets/lib/live2dcubismcore.min.js', // 提供 window.Live2DCubismCore
};
const RUNTIME_GLOBALS = {
  cubism2: 'Live2D',
  cubism4: 'Live2DCubismCore',
};

/// 输入条高度（人物底部锚点上移量，避免人物被输入条挡住）
const INPUT_BAR_H = 44;
/// 气泡在回复完成后停留的时长
const BUBBLE_LINGER_MS = 8000;

// 单例加载指定 runtime 脚本（注入全局对象）
function loadRuntimeScript(runtime) {
  const src = RUNTIME_SCRIPTS[runtime];
  const g = RUNTIME_GLOBALS[runtime];
  if (!loadRuntimeScript.cache) loadRuntimeScript.cache = {};
  if (!loadRuntimeScript.cache[runtime]) {
    loadRuntimeScript.cache[runtime] = new Promise((resolve, reject) => {
      if (globalThis[g]) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Live2D 运行时加载失败：${src}`));
      document.head.appendChild(s);
    });
  }
  return loadRuntimeScript.cache[runtime];
}

export async function renderPet({ root, repo }) {
  document.documentElement.classList.add('pet-mode');
  root.innerHTML = `
    <div class="pet-stage">
      <div class="pet-bubble" hidden></div>
      <div class="pet-input-bar">
        <input data-role="pet-input" placeholder="和桌宠聊聊…" maxlength="2000">
        <button data-role="pet-send" title="发送">➤</button>
      </div>
    </div>`;
  const stage = root.querySelector('.pet-stage');
  const bubble = root.querySelector('.pet-bubble');

  // ——— 对话气泡（流式回复展示） ———

  let bubbleTimer = null;
  let streaming = false;

  function showBubble(html, { autoHide = true } = {}) {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    bubble.innerHTML = html;
    bubble.hidden = false;
    if (autoHide) {
      bubbleTimer = setTimeout(() => { bubble.hidden = true; }, BUBBLE_LINGER_MS);
    }
  }

  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    bubble.hidden = true;
  }

  async function petSend(text) {
    if (streaming || !text.trim()) return;
    if (!isChatAvailable()) {
      showBubble('对话功能需要桌面版');
      return;
    }
    streaming = true;
    showBubble('<span class="pet-typing">…</span>', { autoHide: false });

    const messages = loadHistory();
    messages.push({ role: 'user', content: text, time: Date.now() });
    const quotaCtx = repo ? buildQuotaContext(repo.listProviders()) : null;
    const outgoing = buildOutgoingMessages(messages.slice(0, -1), quotaCtx);
    outgoing.push({ role: 'user', content: text });

    let reply = '';
    await sendChat(outgoing, {
      onToken: (t) => {
        reply += t;
        showBubble(escapeHtml(reply), { autoHide: false });
      },
      onDone: () => {
        messages.push({ role: 'assistant', content: reply, time: Date.now() });
        saveHistory(messages);
        finish(reply || '（空回复）');
      },
      onError: (msg) => {
        messages.push({ role: 'assistant', content: reply, error: true, time: Date.now() });
        saveHistory(messages);
        finish(reply || `（失败：${msg}）`);
      },
      onCancelled: () => finish(reply || '（已停止）'),
    });

    function finish(text) {
      streaming = false;
      showBubble(escapeHtml(text));
      // 说话时来个小动作
      playPetMotion();
    }
  }

  root.querySelector('[data-role="pet-send"]').addEventListener('click', () => {
    const input = root.querySelector('[data-role="pet-input"]');
    const text = input.value.trim();
    if (text) { input.value = ''; void petSend(text); }
  });
  root.querySelector('[data-role="pet-input"]').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const input = e.target;
      const text = input.value.trim();
      if (text && !streaming) { input.value = ''; void petSend(text); }
    }
  });
  // 气泡上点击 = 关闭
  bubble.addEventListener('click', hideBubble);

  // ——— 拖入文件即分析（Tauri 拦截系统拖放转发事件，提供绝对路径） ———
  // 拖到桌宠身上 → 直接发起分析；气泡显示进度与结果尾部，完整结果进历史（主窗「文件分析」页可看）。
  const petWebview = globalThis.__TAURI__?.webview?.getCurrentWebview?.();
  if (petWebview?.onDragDropEvent) {
    void petWebview.onDragDropEvent(async (ev) => {
      const p = ev?.payload;
      if (p?.type !== 'drop' || !p.paths?.length || streaming) return;
      if (!isChatAvailable()) return;
      streaming = true;
      let tail = '';
      showBubble(`开始分析 ${p.paths.length} 个文件…`, { autoHide: false });
      await analyzeFiles(p.paths, {
        onEvent: (e2) => {
          const { type, data } = e2 || {};
          if (type === 'Parsing') {
            showBubble(`解析中：${data?.file ?? ''}`, { autoHide: false });
          } else if (type === 'Tokens') {
            tail = (tail + (data?.text ?? '')).slice(-400);
            showBubble(`${escapeHtml(tail)}<span class="pet-typing">▍</span>`, { autoHide: false });
          } else if (type === 'FileDone') {
            showBubble(`✓ ${data?.file ?? ''} 完成`, { autoHide: false });
          } else if (type === 'Error') {
            showBubble(`✗ ${escapeHtml(data?.message ?? '失败')}`);
          } else if (type === 'Done') {
            showBubble('分析完成！完整结果与历史见主窗「文件分析」页');
            playPetMotion();
          } else if (type === 'Cancelled') {
            showBubble('分析已取消');
          }
        },
      }).catch((err) => showBubble(`分析失败：${escapeHtml(String(err?.message || err))}`));
      streaming = false;
    });
  }

  // ——— 拖动与单击 ———

  let press = null;
  let dragged = false;
  root.addEventListener('mousedown', (e) => {
    // 输入条 / 气泡区域是控件交互区，不进入拖动判定
    if (e.target.closest('.pet-input-bar, .pet-bubble')) return;
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY };
    dragged = false;
  });
  root.addEventListener('mousemove', (e) => {
    if (!press) return;
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 6) {
      dragged = true;
      press = null;
      globalThis.__TAURI__?.window?.getCurrentWindow?.()?.startDragging?.();
    }
  });
  root.addEventListener('mouseup', () => {
    press = null;
  });

  // ——— Live2D 渲染 ———

  let modelRef = null;
  let app;
  // 随机播一个互动动作（说话、点击、分析完成等场景共用；模型加载前调用为空操作）
  const playPetMotion = () => {
    const group = MODEL.motions[Math.floor(Math.random() * MODEL.motions.length)];
    modelRef?.motion(group, undefined, 3);
  };
  try {
    await loadRuntimeScript(MODEL.runtime);
    const [pixi, l2d] = await Promise.all([
      import('pixi.js'),
      MODEL.runtime === 'cubism2'
        ? import('pixi-live2d-display/cubism2')
        : import('pixi-live2d-display/cubism4'),
    ]);
    // 库内部部分代码走全局 PIXI（Ticker 等）
    window.PIXI = pixi;
    const { Application } = pixi;
    const { Live2DModel } = l2d;

    app = new Application({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      width: stage.clientWidth,
      height: stage.clientHeight,
    });
    // 桌宠常驻桌面：限帧降低 GPU 占用
    app.ticker.maxFPS = 30;
    stage.prepend(app.view);

    const model = await Live2DModel.from(MODEL.url);
    app.stage.addChild(model);

    // 等比放大铺满窗口，人物底部居中锚定在输入条上方（悬浮窗不可缩放，一次定位即可）
    const availH = stage.clientHeight - INPUT_BAR_H;
    const fit = Math.min(stage.clientWidth / model.width, availH / model.height);
    model.scale.set(fit);
    model.anchor.set(0.5, 1);
    model.position.set(stage.clientWidth / 2, availH);
    modelRef = model;

    // 开场播一段 idle，随后由 MotionManager 自动循环空闲动作
    model.motion(MODEL.idle, undefined, 3);

    // 原地单击互动：有命中区域的模型（Cubism 4 标准 hit_areas）点击头部优先触发表情，
    // 其余随机播互动动作；22 娘等无标准 hit_areas 的模型统一随机播。
    // dragged 标记过滤拖动后残留的 click（mousedown 时复位，原生拖动循环常吞掉 click 但不保证）
    root.addEventListener('click', (e) => {
      if (e.target.closest('.pet-input-bar, .pet-bubble')) return;
      if (dragged) {
        dragged = false;
        return;
      }
      if (MODEL.headHit) {
        const rect = stage.getBoundingClientRect();
        const hits = model.hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hits.includes(MODEL.headHit)) {
          model.expression();
          model.motion(MODEL.idle, undefined, 3);
          return;
        }
      }
      playPetMotion();
    });
  } catch (err) {
    console.error('[pet] Live2D 初始化失败', err);
    // 渲染失败不拦对话：输入条仍可用（stage 保留，错误占位不覆盖输入条）
    const errEl = document.createElement('div');
    errEl.className = 'pet-error';
    errEl.textContent = 'Live2D 渲染不可用，对话功能不受影响';
    stage.appendChild(errEl);
  }

  return {
    app,
    destroy() {
      app?.destroy(true);
    },
  };
}

