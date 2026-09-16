// 模型配置核心：供应商（多预设模型）结构归一、模型下拉展开、模型配置 ↔ 额度查询
// 双向同步。配置主体存 pet-config.json（Rust，chat_get/save_config），密钥在凭据
// 管理器（api:<profileId>）；额度查询供应商存 localStorage，密钥在 quota:<providerId>。
// 同步以 Base URL 去重（已存在跳过），密钥经 chat_copy_key 在 keyring 内部复制、
// 明文不过前端。纯函数与 IO 分离（deps 注入）便于单测与网页版降级。

import { PROVIDER_TYPES } from './providers.js';
import { normalizeProviderConfig, newId } from './storage.js';
import { hasSecret } from './secrets.js';
import {
  getChatConfig, saveChatConfig, copyKeyEntry, buildProfileFromProvider, importableProviders,
} from './chat.js';

/// Base URL 归一化比较键：小写 + 去尾部斜杠
export function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

/// 由 Base URL 推断额度供应商类型（与类型注册表的 defaultBaseUrl 匹配，
/// 忽略尾部 /v1 版本段——同一服务的 OpenAI 兼容端点常带 /v1 而注册表不带；
/// 匹配不上回退 custom，用户可在供应商表单里改）
export function inferProviderType(baseUrl) {
  const stripVer = (u) => u.replace(/\/v\d+$/, '');
  const nb = stripVer(normalizeBaseUrl(baseUrl));
  if (!nb) return 'custom';
  const hit = PROVIDER_TYPES.find((t) => stripVer(normalizeBaseUrl(t.defaultBaseUrl)) === nb);
  return hit ? hit.type : 'custom';
}

/// 单个模型供应商结构归一：models 数组（旧 model 字段并入）、地址去尾斜杠
export function normalizeProfile(p) {
  const models = ((p?.models?.length ? p.models : (p?.model ? [p.model] : [])) || [])
    .map((m) => String(m).trim())
    .filter(Boolean);
  return {
    id: String(p?.id || ''),
    name: String(p?.name || '').trim(),
    base_url: String(p?.base_url || '').trim().replace(/\/+$/, ''),
    models,
  };
}

/// 展开 供应商 × 预设模型 为下拉选项（对话页自由切换用）
export function listModelChoices(profiles) {
  const out = [];
  for (const p of (profiles || []).map(normalizeProfile)) {
    for (const model of p.models) {
      out.push({ profileId: p.id, name: p.name, model, label: `${p.name} · ${model}` });
    }
  }
  return out;
}

/// 下拉选项值编码 / 解码（profileId 与模型名以 "||" 连接，模型名里不会有该序列）
export const selectionValue = (profileId, model) => `${profileId}||${model}`;

export function parseSelectionValue(v) {
  const s = String(v || '');
  const i = s.indexOf('||');
  if (i < 0) return { profileId: null, model: null };
  return { profileId: s.slice(0, i), model: s.slice(i + 2) };
}

/// 解析当前生效选择：active_profile_id 失效回退首家；active_model 不在预设内回退首个。
/// 兼容 snake_case（Rust 配置原样）与 camelCase（视图层配置对象）两种键名。
export function resolveActiveSelection(cfg) {
  const activeId = cfg?.active_profile_id ?? cfg?.activeProfileId ?? null;
  const activeModel = cfg?.active_model ?? cfg?.activeModel ?? null;
  const profiles = (cfg?.profiles || []).map(normalizeProfile);
  const prof = profiles.find((p) => p.id === activeId) || profiles[0];
  if (!prof) return { profileId: null, model: null };
  const model = prof.models.includes(activeModel) ? activeModel : prof.models[0];
  return { profileId: prof.id, model: model ?? null };
}

/// 双向同步（幂等，Base URL 去重）：
/// 1) 模型配置 → 额度查询：新地址补一条供应商（类型推断），key 复制到 quota 条目；
/// 2) 额度查询 → 模型配置：OpenAI 兼容可查类型且已存 Key 的供应商补一条模型供应商，
///    key 复制到 api 条目（无 Key 的跳过，避免造出不可用配置）。
/// 返回 { addedProviders, addedProfiles }（新增名称列表，供界面提示）。
export async function syncModelsAndQuota(repo, deps = {}) {
  const {
    getCfg = getChatConfig,
    saveCfg = saveChatConfig,
    copyKey = copyKeyEntry,
    hasQuotaKey = hasSecret,
    genId = newId,
  } = deps;
  const addedProviders = [];
  const addedProfiles = [];

  const cfg = await getCfg();
  const profiles = (cfg.profiles || []).map(normalizeProfile);
  const knownBases = new Set(
    repo.listProviders().map((p) => normalizeBaseUrl(p.baseUrl)).filter(Boolean),
  );

  for (const prof of profiles) {
    const nb = normalizeBaseUrl(prof.base_url);
    if (!nb || knownBases.has(nb)) continue;
    knownBases.add(nb);
    const id = genId();
    const provider = normalizeProviderConfig({
      id,
      name: prof.name || nb,
      type: inferProviderType(prof.base_url),
      baseUrl: prof.base_url,
      chatModel: prof.models[0] || '',
      apiKey: '',
      apiSecret: '',
    });
    // key 在 keyring 内部复制（api:profileId → quota:新id）；无 Key 也照样加供应商
    provider.hasSecret = !!(await copyKey(`api:${prof.id}`, `quota:${id}`).catch(() => false));
    repo.saveProvider(provider);
    addedProviders.push(provider.name);
  }

  // 刷新列表（上面可能已新增）；仅同步启用中、非双凭证、已存 Key 的供应商
  const freshCfg = { ...cfg, profiles };
  let cfgDirty = false;
  for (const p of importableProviders(repo.listProviders())) {
    const prof = normalizeProfile(buildProfileFromProvider(p));
    const nb = normalizeBaseUrl(prof.base_url);
    if (!nb || !prof.models.length) continue;
    if (profiles.some((x) => normalizeBaseUrl(x.base_url) === nb)) continue;
    if (!(await hasQuotaKey(p.id).catch(() => false))) continue;
    const copied = await copyKey(`quota:${p.id}`, `api:${prof.id}`).catch(() => false);
    if (!copied) continue; // 源条目读不出 Key：不造不可用配置，下次再试
    profiles.push(prof);
    cfgDirty = true;
    addedProfiles.push(prof.name);
  }
  if (cfgDirty) {
    // active_profile_id 失效（对应配置已删）时归位首家，避免选中残留 id
    const validActive = profiles.some((p) => p.id === freshCfg.active_profile_id)
      ? freshCfg.active_profile_id
      : profiles[0]?.id ?? null;
    await saveCfg({ ...freshCfg, profiles, active_profile_id: validActive });
  }
  return { addedProviders, addedProfiles };
}
