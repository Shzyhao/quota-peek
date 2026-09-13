// 设置页「桌宠形象」卡：Live2D 预览画布 + 当前形象显示 + 内置皮肤切换 +
// 自定义形象导入（选文件夹 → Rust 复制到应用数据目录 → asset 协议加载）。
// 修改经 localStorage storage 事件同步到桌宠窗。

import {
  SKINS, currentSkin, clearActiveCustom, getActiveCustom,
  listCustomModels, addCustomModel, loadRuntimeScript, activeModelUrl, activeRuntime,
} from './live2d.js';
import { escapeHtml } from './format.js';

function hashSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/// 构造 asset 协议 URL：convertFileSrc 会把整条 Windows 路径编码成单一 URL 段
/// （反斜杠 → %5C），模型加载器解析 moc/贴图等相对路径时目录前缀会整段丢失。
/// 这里改为正斜杠路径段形式，保证相对路径解析保留目录。
function toAssetUrl(absPath) {
  const sample = globalThis.__TAURI__.core.convertFileSrc('X');
  const base = sample.slice(0, sample.lastIndexOf('/') + 1);
  return base + encodeURIComponent(absPath).replaceAll('%5C', '/').replaceAll('%3A', ':');
}

/// 当前形象的展示名
function activeDisplayName() {
  const custom = getActiveCustom();
  if (custom) return `${custom.name}（自定义导入）`;
  const skin = SKINS.find((s) => s.id === currentSkin());
  return `22 娘 · ${skin?.label || '默认'} 皮肤`;
}

export function petAppearanceCard() {
  return `
    <section class="settings-card">
      <h3>桌宠形象</h3>
      <div class="pet-appearance" data-role="pet-appearance">
        <div class="pet-preview" data-role="pet-preview">
          <span class="pet-preview-hint">形象加载中…</span>
        </div>
        <div class="pet-appearance-info">
          <p class="pet-current" data-role="pet-current"></p>
          <label class="pet-skin-label">内置皮肤（22 娘）
            <select data-role="pet-skin-select"></select>
          </label>
          <div class="pet-appearance-actions">
            <button class="btn primary" data-action="pet-import">导入自定义形象</button>
            <button class="btn" data-action="pet-reset" data-role="pet-reset">恢复内置形象</button>
          </div>
          <label class="setting-toggle"><input type="checkbox" data-role="pet-chatter"> 桌宠主动搭话 —— 闲聊额度状态与时段问候（拟人化；深夜 23:00–08:00 自动安静，约半小时一句）</label>
          <p class="settings-hint">支持 Cubism 2 / 3 / 4 模型文件夹（含 model3.json 或 model.json），
          也可直接选入口文件；导入后模型复制到本应用数据目录，不上传任何服务器。
          自定义模型请确认来源授权允许桌面使用。</p>
        </div>
      </div>
    </section>`;
}

export function mountPetAppearanceCard(root) {
  const card = root.querySelector('[data-role="pet-appearance"]');
  if (!card) return;
  const previewEl = card.querySelector('[data-role="pet-preview"]');
  const currentEl = card.querySelector('[data-role="pet-current"]');
  const skinSelect = card.querySelector('[data-role="pet-skin-select"]');
  const resetBtn = card.querySelector('[data-role="pet-reset"]');
  let loadingToken = 0;

  // 皮肤下拉
  skinSelect.innerHTML = SKINS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  syncState();

  // 主动搭话开关（桌宠窗每分钟读一次 localStorage，无需跨窗事件）
  const chatterToggle = card.querySelector('[data-role="pet-chatter"]');
  chatterToggle.checked = localStorage.getItem('mqc.pet.chatter') !== '0';
  chatterToggle.addEventListener('change', () => {
    localStorage.setItem('mqc.pet.chatter', chatterToggle.checked ? '1' : '0');
  });

  function syncState() {
    const custom = getActiveCustom();
    currentEl.innerHTML = `当前形象：<b>${escapeHtml(activeDisplayName())}</b>`;
    if (!custom) skinSelect.value = currentSkin();
    skinSelect.disabled = !!custom;
    resetBtn.disabled = !custom;
  }

  // 预览（每次状态变化重建；旧 pixi 应用销毁防泄漏）
  async function renderPreview() {
    const token = ++loadingToken;
    previewEl.innerHTML = '<span class="pet-preview-hint">形象加载中…</span>';
    if (previewEl.__petApp) {
      try { previewEl.__petApp.destroy(true, { children: true }); } catch { /* 忽略 */ }
      previewEl.__petApp = null;
    }
    try {
      const runtime = activeRuntime();
      await loadRuntimeScript(runtime);
      const [pixi, l2d] = await Promise.all([
        import('pixi.js'),
        runtime === 'cubism2'
          ? import('pixi-live2d-display/cubism2')
          : import('pixi-live2d-display/cubism4'),
      ]);
      if (token !== loadingToken) return;
      window.PIXI = pixi;
      const { Application } = pixi;
      const app = new Application({
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        width: previewEl.clientWidth || 170,
        height: previewEl.clientHeight || 210,
      });
      app.ticker.maxFPS = 24;
      previewEl.__petApp = app;
      previewEl.appendChild(app.view);

      const model = await l2d.Live2DModel.from(activeModelUrl());
      if (token !== loadingToken) return;
      previewEl.querySelector('.pet-preview-hint')?.remove();
      app.stage.addChild(model);
      // 内容包围盒适配：占预览区高度 78%、水平居中、底部贴底
      const H = app.renderer.height / (window.devicePixelRatio || 1);
      const W = app.renderer.width / (window.devicePixelRatio || 1);
      model.anchor.set(0.5, 1);
      model.scale.set(Math.min(W / model.width, H / model.height));
      model.position.set(W / 2, H);
      const res = app.renderer.resolution || 1;
      for (let i = 0; i < 2; i++) {
        model.updateTransform();
        const b = model.getBounds();
        const bh = b.height / res;
        if (!bh) break;
        const adjust = (H * 0.78) / bh;
        if (Math.abs(adjust - 1) > 0.01) model.scale.set(model.scale.x * adjust);
        model.updateTransform();
        const b2 = model.getBounds();
        model.position.x += W / 2 - (b2.x + b2.width / 2) / res;
        model.position.y += H - (b2.y + b2.height) / res;
      }
    } catch (err) {
      console.error('[pet-preview] 加载失败', err);
      if (token === loadingToken) {
        previewEl.innerHTML = `<span class="pet-preview-hint">预览加载失败<br>${escapeHtml(String(err?.message || err)).slice(0, 80)}</span>`;
      }
    }
  }

  // 皮肤切换（切皮肤即回到内置形象）
  skinSelect.addEventListener('change', () => {
    clearActiveCustom();
    localStorage.setItem('mqc.pet.skin', skinSelect.value);
    syncState();
    void renderPreview();
  });

  // 恢复内置
  resetBtn.addEventListener('click', () => {
    clearActiveCustom();
    syncState();
    void renderPreview();
  });

  // 导入：选模型文件夹（或入口文件）→ Rust 复制到应用数据目录 → 激活
  card.querySelector('[data-action="pet-import"]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const dialog = globalThis.__TAURI__?.dialog;
    if (!dialog?.open) return;
    try {
      btn.disabled = true;
      const picked = await dialog.open({
        directory: true,
        multiple: false,
        title: '选择 Live2D 模型文件夹（含 model3.json 或 model.json）',
      });
      if (!picked) return;
      btn.textContent = '导入中…';
      const { invoke } = globalThis.__TAURI__.core;
      const res = await invoke('pet_import_model', { src: picked });
      const entry = {
        id: `custom-${hashSeed(res.abs_path)}`,
        name: res.name,
        url: toAssetUrl(res.abs_path),
        runtime: res.runtime,
      };
      addCustomModel(entry);
      setActiveCustom(entry);
      syncState();
      await renderPreview();
    } catch (err) {
      currentEl.innerHTML = `<b style="color:var(--error)">导入失败：${escapeHtml(String(err?.message || err)).slice(0, 100)}</b>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '导入自定义形象';
    }
  });

  void renderPreview();
}
