import { describe, it, expect } from 'vitest';
import {
  normalizeBaseUrl, inferProviderType, normalizeProfile, listModelChoices,
  selectionValue, parseSelectionValue, resolveActiveSelection, syncModelsAndQuota,
} from '../src/core/models.js';

describe('normalizeBaseUrl / inferProviderType', () => {
  it('归一化：小写 + 去尾部斜杠', () => {
    expect(normalizeBaseUrl('HTTPS://API.DeepSeek.COM/')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('  https://x.com/// ')).toBe('https://x.com');
    expect(normalizeBaseUrl(null)).toBe('');
  });

  it('按类型注册表推断（容忍 /v1 版本段）；未匹配回退 custom', () => {
    expect(inferProviderType('https://api.deepseek.com')).toBe('deepseek');
    expect(inferProviderType('https://api.siliconflow.cn/v1/')).toBe('siliconflow');
    expect(inferProviderType('https://api.moonshot.cn/v1')).toBe('moonshot');
    expect(inferProviderType('https://my-relay.example.com/v1')).toBe('custom');
    expect(inferProviderType('')).toBe('custom');
  });
});

describe('normalizeProfile / listModelChoices / 选择值', () => {
  it('旧 model 字段并入 models；模型去空白；地址去尾斜杠', () => {
    expect(normalizeProfile({ id: 'a', name: 'A', base_url: 'https://x.com/', model: 'm1' }))
      .toEqual({ id: 'a', name: 'A', base_url: 'https://x.com', models: ['m1'] });
    expect(normalizeProfile({ id: 'a', models: [' m1 ', '', 'm2'] }).models).toEqual(['m1', 'm2']);
    expect(normalizeProfile(null).models).toEqual([]);
  });

  it('展平 供应商 × 预设模型 为下拉选项', () => {
    const choices = listModelChoices([
      { id: 'p1', name: 'GLM', base_url: 'u', models: ['glm-4.6', 'glm-4-air'] },
      { id: 'p2', name: 'K', base_url: 'v', models: ['c'] },
      { id: 'p3', name: '空', base_url: 'w', models: [] },
    ]);
    expect(choices.map((c) => c.label)).toEqual(['GLM · glm-4.6', 'GLM · glm-4-air', 'K · c']);
    expect(choices[0]).toMatchObject({ profileId: 'p1', model: 'glm-4.6' });
  });

  it('选择值编解码 round-trip；非法值返回 null', () => {
    expect(parseSelectionValue(selectionValue('p1', 'glm-4.6'))).toEqual({ profileId: 'p1', model: 'glm-4.6' });
    expect(parseSelectionValue('')).toEqual({ profileId: null, model: null });
  });

  it('resolveActiveSelection：active_model 不在预设内回退首个；profile 失效回退首家', () => {
    const profiles = [
      { id: 'p1', name: 'A', models: ['a1', 'a2'] },
      { id: 'p2', name: 'B', models: ['b1'] },
    ];
    expect(resolveActiveSelection({ profiles, active_profile_id: 'p2', active_model: 'a1' }))
      .toEqual({ profileId: 'p2', model: 'b1' });
    expect(resolveActiveSelection({ profiles, active_profile_id: 'p2', active_model: 'b1' }))
      .toEqual({ profileId: 'p2', model: 'b1' });
    expect(resolveActiveSelection({ profiles })).toEqual({ profileId: 'p1', model: 'a1' });
    expect(resolveActiveSelection({ profiles: [] })).toEqual({ profileId: null, model: null });
  });
});

describe('syncModelsAndQuota 双向同步', () => {
  function makeRepo(providers = []) {
    let list = providers;
    return {
      listProviders: () => list,
      saveProvider: (p) => { list = [...list.filter((x) => x.id !== p.id), p]; },
    };
  }

  // copies：模拟 keyring 条目（api:p2 → key）；copyKey 在条目间复制
  function makeDeps({ cfg = { profiles: [] }, copies = new Map(), quotaKeys = new Set() } = {}) {
    const saved = [];
    let n = 0;
    return {
      deps: {
        getCfg: async () => JSON.parse(JSON.stringify(cfg)),
        saveCfg: async (c) => { saved.push(c); cfg = c; },
        copyKey: async (from, to) => {
          if (!copies.has(from)) return false;
          copies.set(to, copies.get(from));
          return true;
        },
        hasQuotaKey: async (id) => quotaKeys.has(id),
        genId: () => `gen-${++n}`,
      },
      saved,
      copies,
    };
  }

  it('模型配置 → 额度查询：新地址补供应商（类型推断 + key 复制标记），已存在跳过', async () => {
    const repo = makeRepo([{ id: 'q1', name: 'DeepSeek 官方', type: 'deepseek', baseUrl: 'https://api.deepseek.com' }]);
    const { deps, copies } = makeDeps({
      cfg: {
        profiles: [
          { id: 'p1', name: 'DeepSeek', base_url: 'https://api.deepseek.com', models: ['deepseek-chat'] },
          { id: 'p2', name: 'Kimi', base_url: 'https://api.moonshot.cn/v1', models: ['kimi-k2'] },
        ],
      },
      copies: new Map([['api:p2', 'sk-kimi']]),
    });

    const r = await syncModelsAndQuota(repo, deps);
    expect(r.addedProviders).toEqual(['Kimi']);
    expect(repo.listProviders()).toHaveLength(2);
    const added = repo.listProviders().find((p) => p.name === 'Kimi');
    expect(added.type).toBe('moonshot');           // /v1 容差推断
    expect(added.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(added.chatModel).toBe('kimi-k2');       // 首个预设作为 AI 默认模型
    expect(added.hasSecret).toBe(true);            // key 已复制到 quota 条目
    expect(added.enabled).toBe(true);
    expect(copies.get('quota:gen-1')).toBe('sk-kimi');
  });

  it('无 Key 的模型配置也加入额度查询（hasSecret=false）', async () => {
    const repo = makeRepo();
    const { deps } = makeDeps({
      cfg: { profiles: [{ id: 'p1', name: '中转', base_url: 'https://relay.example.com/v1', models: ['m1'] }] },
    });
    const r = await syncModelsAndQuota(repo, deps);
    expect(r.addedProviders).toEqual(['中转']);
    expect(repo.listProviders()[0].type).toBe('custom');
    expect(repo.listProviders()[0].hasSecret).toBe(false);
  });

  it('额度查询 → 模型配置：OpenAI 兼容且已存 Key 的供应商补为模型供应商；无 Key 跳过', async () => {
    const repo = makeRepo([
      { id: 'q1', name: '硅基', type: 'siliconflow', baseUrl: 'https://api.siliconflow.cn', chatModel: 'deepseek-ai/DeepSeek-V3', enabled: true },
      { id: 'q2', name: '无Key家', type: 'deepseek', baseUrl: 'https://api.deepseek.com', enabled: true },
      { id: 'q3', name: '方舟', type: 'volcengine', baseUrl: 'https://open.volcengineapi.com', enabled: true },
    ]);
    const { deps, copies, saved } = makeDeps({
      quotaKeys: new Set(['q1', 'q2', 'q3']),
      copies: new Map([['quota:q1', 'sf-key']]),
    });

    const r = await syncModelsAndQuota(repo, deps);
    expect(r.addedProfiles).toEqual(['硅基']); // q2 无 keyring 条目、q3 双凭证类型都不进
    expect(saved).toHaveLength(1);
    expect(saved[0].profiles[0]).toEqual({
      id: 'prov-q1', name: '硅基', base_url: 'https://api.siliconflow.cn', models: ['deepseek-ai/DeepSeek-V3'],
    });
    expect(saved[0].active_profile_id).toBe('prov-q1'); // 原无激活时落首家
    expect(copies.get('api:prov-q1')).toBe('sf-key');
  });

  it('双向幂等：再跑一次不重复添加', async () => {
    const repo = makeRepo();
    const { deps } = makeDeps({
      cfg: { profiles: [{ id: 'p1', name: 'DeepSeek', base_url: 'https://api.deepseek.com', models: ['deepseek-chat'] }] },
      copies: new Map([['api:p1', 'sk-1']]),
    });
    await syncModelsAndQuota(repo, deps);
    const r2 = await syncModelsAndQuota(repo, deps);
    expect(r2.addedProviders).toEqual([]);
    expect(repo.listProviders()).toHaveLength(1);
  });
});
