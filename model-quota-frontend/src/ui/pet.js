// 桌宠视图（#pet）：Live2D 人物悬浮窗，取代经典悬浮球形态。
// 交互约定与悬浮球一致：拖动（>6px 位移）= 原生窗口拖动；原地单击 = 弹出/收起
// 功能气泡菜单（对话 / 文件分析 / 额度速览 / 换装），菜单项打开锚定桌宠旁的
// 功能弹窗（pet-panel 事件由桌面壳建窗）。底部常驻输入条可直接对话（流式气泡）。
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
import {
  SKINS, currentSkin, modelUrlFor, activeModelUrl, activeRuntime,
  getActiveCustom, setActiveCustom, clearActiveCustom, listCustomModels,
  loadRuntimeScript,
} from './live2d.js';

/// 桌宠内置形象：bilibili 22 娘（Cubism 2.1，Q 版，社区开源 GPL；20 套皮肤）。
/// 自定义形象（用户导入）的状态与运行时加载在 ui/live2d.js。
const MODEL = {
  runtime: 'cubism2',
  idle: 'idle',
  motions: ['tap_body', 'thanking'],
};

/// 输入条高度（人物底部锚点上移量，避免人物被输入条挡住）
const INPUT_BAR_H = 44;
/// 人物内容占窗口可用高度的比例
const PET_SCALE = 0.72;
/// 气泡在回复完成后停留的时长
const BUBBLE_LINGER_MS = 8000;

const emitTauri = (event, payload) => globalThis.__TAURI__?.event?.emit?.(event, payload);

export async function renderPet({ root, repo }) {
  document.documentElement.classList.add('pet-mode');
  root.innerHTML = `
    <div class="pet-stage">
      <div class="pet-menu" hidden></div>
      <div class="pet-bubble" hidden></div>
      <div class="pet-input-bar">
        <input data-role="pet-input" placeholder="和桌宠聊聊…" maxlength="2000">
        <button data-role="pet-skin" title="换装" aria-label="换装">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M9.2 3h5.6l-.9 4.6 4.3 10.2a1 1 0 0 1-.92 1.4H6.72a1 1 0 0 1-.92-1.4l4.3-10.2L9.2 3z"/><path d="M9.2 3c.9 1.2 2 1.8 2.8 1.8S13.9 4.2 14.8 3"/></svg>
        </button>
        <button data-role="pet-send" title="发送" aria-label="发送">➤</button>
      </div>
    </div>`;
  const stage = root.querySelector('.pet-stage');
  const bubble = root.querySelector('.pet-bubble');
  const menu = root.querySelector('.pet-menu');

  // ——— 对话气泡（流式回复展示） ———

  let bubbleTimer = null;
  let streaming = false;

  function showBubble(html, { autoHide = true } = {}) {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    hideMenu();
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
  root.querySelector('[data-role="pet-input"]').addEventListener('focus', hideMenu);
  // 气泡上点击 = 关闭
  bubble.addEventListener('click', hideBubble);

  // ——— 功能气泡菜单（点击桌宠弹出；菜单项打开锚定桌宠的功能弹窗） ———

  function renderMenu(view) {
    if (view === 'skins') {
      const cur = currentSkin();
      menu.innerHTML = `
        <div class="pet-menu-head"><button data-menu="back">‹ 返回</button><b>换装</b><span></span></div>
        ${(() => {
          const customs = listCustomModels();
          const activeCustom = getActiveCustom();
          return `
            ${customs.length ? `<div class="pet-skin-section">我的形象</div>
            <div class="pet-skin-grid">
              ${customs.map((c) => `<button data-custom="${escapeHtml(c.id)}" class="${activeCustom?.id === c.id ? 'cur' : ''}">${escapeHtml(c.name)}</button>`).join('')}
            </div>` : ''}
            <div class="pet-skin-section">内置皮肤 · 22 娘</div>
            <div class="pet-skin-grid">
              ${SKINS.map((s) => `<button data-skin="${s.id}" class="${!activeCustom && s.id === cur ? 'cur' : ''}">${s.label}</button>`).join('')}
            </div>`;
        })()}`;
    } else {
      menu.innerHTML = `
        <div class="pet-menu-head"><b>桌看 · 功能</b><span></span></div>
        <button data-menu="chat">💬 对话</button>
        <button data-menu="analysis">📄 文件分析</button>
        <button data-menu="quota">📊 额度速览</button>
        <button data-menu="skins">👗 换装（切换到下一套）</button>`;
    }
  }

  function showMenu(view = 'actions') {
    renderMenu(view);
    hideBubble();
    menu.hidden = false;
  }

  function hideMenu() {
    menu.hidden = true;
  }

  menu.addEventListener('click', (e) => {
    // 菜单内点击到此为止：showMenu 会重渲染 innerHTML，让冒泡中的 e.target
    // 变成游离节点——root 的 closest('.pet-menu') 保护会失效，必须阻断冒泡
    e.stopPropagation();
    const customBtn = e.target.closest('[data-custom]');
    if (customBtn) {
      const entry = listCustomModels().find((x) => x.id === customBtn.dataset.custom);
      if (entry) void applyCustom(entry);
      return;
    }
    const skinBtn = e.target.closest('[data-skin]');
    if (skinBtn) {
      void applySkin(skinBtn.dataset.skin);
      return;
    }
    const act = e.target.closest('[data-menu]')?.dataset.menu;
    if (!act) return;
    if (act === 'skins') cycleSkin();
    else if (act === 'back') showMenu('actions');
    else if (act === 'chat') { hideMenu(); emitTauri('pet-panel', 'chat'); playPetMotion(); }
    else if (act === 'analysis') { hideMenu(); emitTauri('pet-panel', 'analysis'); }
    else if (act === 'quota') { hideMenu(); emitTauri('ball-clicked'); }
  });

  // 输入条上的换装按钮：任何状态都切到换装视图（菜单开着也切过去），已在换装视图才收起
  root.querySelector('[data-role="pet-skin"]').addEventListener('click', () => {
    if (menu.hidden || !menu.querySelector('.pet-skin-grid')) showMenu('skins');
    else hideMenu();
  });

  // 菜单「换装」= 循环切换：自定义形象在用时先切回内置，否则切到下一套内置皮肤
  // （完整形象选择——含我的形象与全部皮肤——用输入条 👗 打开）
  function cycleSkin() {
    if (getActiveCustom()) {
      void applySkin(currentSkin());
      return;
    }
    const idx = SKINS.findIndex((s) => s.id === currentSkin());
    const next = SKINS[(idx + 1) % SKINS.length];
    void applySkin(next.id);
  }

  // 换装：持久化皮肤 → 热重载模型（不重建 pixi 应用）；串行化防止连点导致模型叠加
  let skinLoading = false;
  async function applySkin(id) {
    if (skinLoading) return;
    skinLoading = true;
    try {
      clearActiveCustom();
      localStorage.setItem(SKIN_KEY, id);
      hideMenu();
      const label = SKINS.find((s) => s.id === id)?.label || id;
      showBubble(`正在换上「${label}」…`, { autoHide: false });
      await reloadModel();
      showBubble(`已换上「${label}」✨`);
      playPetMotion();
    } finally {
      skinLoading = false;
    }
  }

  // 应用自定义形象：写入激活状态并热重载；运行时不同时整窗重载
  async function applyCustom(entry) {
    if (skinLoading) return;
    skinLoading = true;
    try {
      hideMenu();
      showBubble(`正在换上「${entry.name}」…`, { autoHide: false });
      setActiveCustom(entry);
      if (activeRuntime() !== loadedRuntime) {
        // Cubism 2 ↔ 4 运行时切换：热重载跨不过库边界，整窗刷新
        location.reload();
        return;
      }
      await reloadModel();
      showBubble(`已换上「${entry.name}」✨`);
    } finally {
      skinLoading = false;
    }
  }

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
    // 输入条 / 气泡 / 菜单是控件交互区，不进入拖动判定
    if (e.target.closest('.pet-input-bar, .pet-bubble, .pet-menu')) return;
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY };
    dragged = false;
  });
  root.addEventListener('mousemove', (e) => {
    if (!press) return;
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 6) {
      dragged = true;
      press = null;
      hideMenu();
      globalThis.__TAURI__?.window?.getCurrentWindow?.()?.startDragging?.();
    }
  });
  root.addEventListener('mouseup', () => {
    press = null;
  });

  // 原地单击 = 弹出/收起功能气泡菜单（配合随机小动作）。
  // dragged 标记过滤拖动后残留的 click（mousedown 时复位，原生拖动循环常吞掉 click 但不保证）；
  // isConnected 兜底：菜单重渲染后冒泡中的旧 target 已游离，closest 保护会失效
  root.addEventListener('click', (e) => {
    if (!e.target.isConnected) return;
    if (e.target.closest('.pet-input-bar, .pet-bubble, .pet-menu')) return;
    if (dragged) {
      dragged = false;
      return;
    }
    if (menu.hidden) {
      showMenu('actions');
      playPetMotion();
    } else {
      hideMenu();
    }
  });

  // ——— Live2D 渲染 ———

  let modelRef = null;
  let app;
  let Live2DModelClass = null; // 库类引用（动态 import 取得，供换装热重载）
  let loadedRuntime = null;

  // 随机播一个互动动作（说话、点击、分析完成等场景共用；模型加载前调用为空操作；
  // 自定义模型动作组未知，跳过互动动作——idle 由库按模型配置自动循环）
  const playPetMotion = () => {
    if (getActiveCustom()) return;
    const group = MODEL.motions[Math.floor(Math.random() * MODEL.motions.length)];
    modelRef?.motion(group, undefined, 3);
  };

  // 构建并适配模型：按「内容实际包围盒」适配（模型画布自带大片空白，按画布
  // 缩放会导致视觉尺寸失真+悬空）——先粗放，测 bounds，再缩放到目标高度并
  // 平移到水平居中、内容底部贴输入条上方
  async function buildModel() {
    const model = await Live2DModelClass.from(activeModelUrl());
    const availH = stage.clientHeight - INPUT_BAR_H;
    const cx = stage.clientWidth / 2;
    model.anchor.set(0.5, 1);
    model.scale.set(Math.min(stage.clientWidth / model.width, availH / model.height));
    model.position.set(cx, availH);
    app.stage.addChild(model);

    const targetH = availH * PET_SCALE;
    // getBounds 返回物理像素（含 renderer.resolution），换算回逻辑像素再校准
    const res = app.renderer.resolution || 1;
    const logicalBounds = () => {
      const b = model.getBounds();
      return { x: b.x / res, y: b.y / res, width: b.width / res, height: b.height / res };
    };
    for (let i = 0; i < 2; i++) {
      model.updateTransform();
      const b = logicalBounds();
      if (!b.height || !b.width) break;
      // 缩放校准（第二轮收敛 getBounds 的舍入误差）
      const adjust = targetH / b.height;
      if (Math.abs(adjust - 1) > 0.01) model.scale.set(model.scale.x * adjust);
      model.updateTransform();
      const b2 = logicalBounds();
      model.position.x += cx - (b2.x + b2.width / 2);
      model.position.y += availH - (b2.y + b2.height);
    }
    return model;
  }

  // 换装热重载：销毁旧模型换新，pixi 应用与窗口不动
  async function reloadModel() {
    if (!app || !Live2DModelClass) return;
    const old = modelRef;
    modelRef = null;
    try {
      const model = await buildModel();
      if (old) {
        app.stage.removeChild(old);
        old.destroy();
      }
      app.stage.addChild(model);
      modelRef = model;
      if (!getActiveCustom()) model.motion(MODEL.idle, undefined, 3);
    } catch (err) {
      console.error('[pet] 换装失败', err);
      showBubble(`换装失败：${escapeHtml(String(err?.message || err))}`);
      if (old) {
        // 旧模型还挂在台上，恢复引用避免彻底没得看
        modelRef = old;
      }
    }
  }

  try {
    const runtime = activeRuntime();
    loadedRuntime = runtime;
    await loadRuntimeScript(runtime);
    const [pixi, l2d] = await Promise.all([
      import('pixi.js'),
      runtime === 'cubism2'
        ? import('pixi-live2d-display/cubism2')
        : import('pixi-live2d-display/cubism4'),
    ]);
    // 库内部部分代码走全局 PIXI（Ticker 等）
    window.PIXI = pixi;
    Live2DModelClass = l2d.Live2DModel;
    const { Application } = pixi;

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

    const model = await buildModel();
    modelRef = model;

    // 开场播一段 idle（自定义模型的 idle 由库按其配置自动循环）
    if (!getActiveCustom()) model.motion(MODEL.idle, undefined, 3);
  } catch (err) {
    console.error('[pet] Live2D 初始化失败', err);
    // 渲染失败不拦对话：输入条仍可用（stage 保留，错误占位不覆盖输入条）
    const errEl = document.createElement('div');
    errEl.className = 'pet-error';
    errEl.textContent = 'Live2D 渲染不可用，对话功能不受影响';
    stage.appendChild(errEl);
  }

  // 设置页修改形象（皮肤/自定义）跨窗同步：运行时一致时热重载，否则整窗刷新
  globalThis.addEventListener?.('storage', (e) => {
    if (!e.key || !e.key.startsWith('mqc.pet.')) return;
    if (activeRuntime() !== loadedRuntime) {
      location.reload();
      return;
    }
    void reloadModel();
  });

  return {
    app,
    destroy() {
      app?.destroy(true);
    },
  };
}
