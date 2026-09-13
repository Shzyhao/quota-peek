import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectRuntimeFromEntry, modelUrlFor, currentSkin, getActiveCustom,
  setActiveCustom, clearActiveCustom, listCustomModels, addCustomModel,
  activeModelUrl, activeRuntime,
} from '../src/ui/live2d.js';

beforeEach(() => {
  localStorage.clear();
});

describe('运行时推断', () => {
  it('*.model3.json → cubism4', () => {
    expect(detectRuntimeFromEntry('hiyori_t10.model3.json')).toBe('cubism4');
    expect(detectRuntimeFromEntry('Sub/MODEL3.JSON')).toBe('cubism4');
  });

  it('model.json → cubism2', () => {
    expect(detectRuntimeFromEntry('model.json')).toBe('cubism2');
    expect(detectRuntimeFromEntry('22/model.json')).toBe('cubism2');
  });
});

describe('内置皮肤', () => {
  it('默认皮肤 URL 指向共享根目录', () => {
    expect(modelUrlFor('0default')).toBe('/assets/live2d/22/model.json');
  });

  it('其他皮肤指向 skins 子目录', () => {
    expect(modelUrlFor('xmas')).toBe('/assets/live2d/22/skins/xmas/model.json');
  });

  it('非法 skin 回退默认', () => {
    localStorage.setItem('mqc.pet.skin', 'not-exist');
    expect(currentSkin()).toBe('0default');
  });
});

describe('自定义形象状态', () => {
  const entry = { id: 'custom-abc', name: '我的模型', url: 'asset://x/model3.json', runtime: 'cubism4' };

  it('默认无自定义 → 内置 URL 与运行时', () => {
    expect(getActiveCustom()).toBeNull();
    expect(activeModelUrl()).toBe('/assets/live2d/22/model.json');
    expect(activeRuntime()).toBe('cubism2');
  });

  it('激活自定义后 URL 与运行时跟随', () => {
    setActiveCustom(entry);
    expect(getActiveCustom()).toEqual(entry);
    expect(activeModelUrl()).toBe(entry.url);
    expect(activeRuntime()).toBe('cubism4');
  });

  it('addCustomModel 去重；清除激活回到内置', () => {
    addCustomModel(entry);
    addCustomModel({ ...entry });
    expect(listCustomModels()).toHaveLength(1);
    clearActiveCustom();
    expect(getActiveCustom()).toBeNull();
    expect(activeRuntime()).toBe('cubism2');
  });

  it('损坏的自定义 JSON 不抛错', () => {
    localStorage.setItem('mqc.pet.customModel', '{oops');
    expect(getActiveCustom()).toBeNull();
  });
});
