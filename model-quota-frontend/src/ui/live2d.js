// Live2D 形象状态与运行时加载（纯逻辑，桌宠窗与设置页共用）。
// 形象状态：内置 22 娘皮肤（mqc.pet.skin）或自定义导入模型（mqc.pet.customModel，
// 模型文件由 Rust 复制到 app_config_dir/pet-models/，经 asset 协议加载）。

export const RUNTIME_SCRIPTS = {
  cubism2: '/assets/lib/live2d.min.js',        // 提供 window.Live2D
  cubism4: '/assets/lib/live2dcubismcore.min.js', // 提供 window.Live2DCubismCore
};
const RUNTIME_GLOBALS = {
  cubism2: 'Live2D',
  cubism4: 'Live2DCubismCore',
};

// 单例加载指定 runtime 脚本（注入全局对象；cubism2/cubism4 入口在模块求值时
// 检查各自全局对象，必须先加载运行时再 import 库）
export function loadRuntimeScript(runtime) {
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

/// 由模型入口文件名推断运行时：*.model3.json = Cubism 4，model.json = Cubism 2
export function detectRuntimeFromEntry(name) {
  return /model3\.json$/i.test(String(name)) ? 'cubism4' : 'cubism2';
}

/// 内置 22 娘皮肤清单（贴图在 skins/<id>/，moc/动作共享 22/ 根；0default 即根目录模型）
export const SKINS = [
  { id: '0default', label: '默认' },
  { id: 'bls', label: 'BLS' },
  { id: 'bls-summer', label: 'BLS·夏' },
  { id: 'bls-winer', label: 'BLS·冬' },
  { id: 'cba-normal', label: 'CBA' },
  { id: 'cba-super', label: 'CBA·炫' },
  { id: 'deluxe', label: '豪华' },
  { id: 'lover', label: '恋人' },
  { id: 'newyear', label: '新年' },
  { id: 'playwater', label: '玩水' },
  { id: 'school', label: '学院' },
  { id: 'spring', label: '春日' },
  { id: 'summer', label: '夏日' },
  { id: 'summer-normal', label: '夏日·常' },
  { id: 'summer-super', label: '夏日·炫' },
  { id: 'tomo-bukatsu-high', label: '社团·高' },
  { id: 'tomo-bukatsu-low', label: '社团·低' },
  { id: 'vadys', label: '情人节' },
  { id: 'valley', label: '田园' },
  { id: 'xmas', label: '圣诞' },
];
export const SKIN_KEY = 'mqc.pet.skin';

export function modelUrlFor(skin) {
  return skin === '0default'
    ? '/assets/live2d/22/model.json'
    : `/assets/live2d/22/skins/${skin}/model.json`;
}

export function currentSkin() {
  const s = globalThis.localStorage?.getItem(SKIN_KEY);
  return SKINS.some((x) => x.id === s) ? s : '0default';
}

// ——— 自定义形象 ———

export const CUSTOM_LIST_KEY = 'mqc.pet.customModels';
export const CUSTOM_ACTIVE_KEY = 'mqc.pet.customModel';

/// 已导入的自定义模型清单：[{ id, name, url, runtime }]
export function listCustomModels() {
  try {
    const l = JSON.parse(globalThis.localStorage?.getItem(CUSTOM_LIST_KEY) || '[]');
    return Array.isArray(l) ? l.filter((x) => x?.url && x?.runtime) : [];
  } catch {
    return [];
  }
}

export function addCustomModel(entry) {
  const list = listCustomModels();
  if (!list.some((x) => x.id === entry.id)) {
    list.push(entry);
    globalThis.localStorage?.setItem(CUSTOM_LIST_KEY, JSON.stringify(list));
  }
}

/// 当前激活的自定义模型（null = 使用内置形象）
export function getActiveCustom() {
  try {
    const c = JSON.parse(globalThis.localStorage?.getItem(CUSTOM_ACTIVE_KEY) || 'null');
    return c?.url && c?.runtime ? c : null;
  } catch {
    return null;
  }
}

export function setActiveCustom(entry) {
  globalThis.localStorage?.setItem(CUSTOM_ACTIVE_KEY, JSON.stringify(entry));
}

export function clearActiveCustom() {
  globalThis.localStorage?.removeItem(CUSTOM_ACTIVE_KEY);
}

/// 当前生效的模型入口 URL 与运行时
export function activeModelUrl() {
  const c = getActiveCustom();
  return c ? c.url : modelUrlFor(currentSkin());
}

export function activeRuntime() {
  const c = getActiveCustom();
  return c ? c.runtime : 'cubism2';
}
