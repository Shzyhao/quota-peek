import { queryDeepSeekBalance, DEEPSEEK_DEFAULT_BASE_URL } from './deepseek.js';
import { queryZhipuCodingPlan, ZHIPU_DEFAULT_BASE_URL } from './zhipu.js';
import { queryMoonshotBalance, MOONSHOT_DEFAULT_BASE_URL } from './moonshot.js';
import { queryMiniMaxQuota, MINIMAX_DEFAULT_BASE_URL } from './minimax.js';
import { queryVolcengineCodingPlan, VOLCENGINE_DEFAULT_BASE_URL } from './volcengine.js';
import {
  queryStepfunBalance,
  querySiliconflowBalance,
  queryOpenRouterBalance,
  queryNovitaBalance,
  STEPFUN_DEFAULT_BASE_URL,
  SILICONFLOW_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  NOVITA_DEFAULT_BASE_URL,
} from './balance.js';

// 供应商类型注册表：autoQuery = true 表示有公开、可用 API Key 直连的官方额度/余额接口。
// 其余类型按需求第 6 条处理：不使用爬虫/模拟登录，直接标记“不支持自动查询”，额度手动维护。
// needsSecret = true 的类型使用双凭证（IAM AccessKey ID + Secret Access Key）。
export const PROVIDER_TYPES = [
  {
    type: 'deepseek',
    label: 'DeepSeek（API 余额）',
    autoQuery: true,
    defaultBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    query: queryDeepSeekBalance,
  },
  {
    type: 'zhipu',
    label: '智谱 GLM Coding Plan',
    autoQuery: true,
    defaultBaseUrl: ZHIPU_DEFAULT_BASE_URL,
    query: queryZhipuCodingPlan,
  },
  {
    type: 'volcengine',
    label: '火山方舟 Coding Plan',
    autoQuery: true,
    defaultBaseUrl: VOLCENGINE_DEFAULT_BASE_URL,
    query: queryVolcengineCodingPlan,
    needsSecret: true,
    credentialLabel: 'AccessKey ID（IAM）',
    credentialHint: '使用「访问控制 IAM」的访问密钥（不是模型 API Key）。建议创建仅授予方舟用量查询只读权限的子账号密钥。',
  },
  {
    type: 'minimax',
    label: 'MiniMax Coding Plan',
    autoQuery: true,
    defaultBaseUrl: MINIMAX_DEFAULT_BASE_URL,
    query: queryMiniMaxQuota,
  },
  {
    type: 'moonshot',
    label: 'Kimi / Moonshot（API 余额）',
    autoQuery: true,
    defaultBaseUrl: MOONSHOT_DEFAULT_BASE_URL,
    query: queryMoonshotBalance,
  },
  {
    type: 'siliconflow',
    label: '硅基流动 SiliconFlow（余额）',
    autoQuery: true,
    defaultBaseUrl: SILICONFLOW_DEFAULT_BASE_URL,
    query: querySiliconflowBalance,
  },
  {
    type: 'stepfun',
    label: '阶跃星辰 StepFun（余额）',
    autoQuery: true,
    defaultBaseUrl: STEPFUN_DEFAULT_BASE_URL,
    query: queryStepfunBalance,
  },
  {
    type: 'openrouter',
    label: 'OpenRouter（余额）',
    autoQuery: true,
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    query: queryOpenRouterBalance,
  },
  {
    type: 'novita',
    label: 'Novita AI（余额）',
    autoQuery: true,
    defaultBaseUrl: NOVITA_DEFAULT_BASE_URL,
    query: queryNovitaBalance,
  },
  { type: 'anthropic', label: 'Anthropic Claude（订阅）', autoQuery: false, defaultBaseUrl: 'https://api.anthropic.com' },
  { type: 'openai', label: 'OpenAI / Codex（订阅）', autoQuery: false, defaultBaseUrl: 'https://api.openai.com' },
  { type: 'qwen', label: 'Qwen / 通义（百炼）', autoQuery: false, defaultBaseUrl: 'https://dashscope.aliyuncs.com' },
  { type: 'kimi-coding', label: 'Kimi 会员编程套餐（暂不可查）', autoQuery: false, defaultBaseUrl: 'https://api.kimi.com' },
  { type: 'custom', label: '其他（手动维护）', autoQuery: false, defaultBaseUrl: '' },
];

export function getProviderType(type) {
  return PROVIDER_TYPES.find((t) => t.type === type) || PROVIDER_TYPES[PROVIDER_TYPES.length - 1];
}
