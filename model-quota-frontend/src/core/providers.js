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
    defaultChatModel: 'deepseek-chat',
    query: queryDeepSeekBalance,
  },
  {
    type: 'zhipu',
    label: '智谱 GLM Coding Plan',
    autoQuery: true,
    defaultBaseUrl: ZHIPU_DEFAULT_BASE_URL,
    defaultChatModel: 'glm-4.6',
    query: queryZhipuCodingPlan,
  },
  {
    type: 'volcengine',
    label: '火山方舟 Coding Plan',
    autoQuery: true,
    defaultBaseUrl: VOLCENGINE_DEFAULT_BASE_URL,
    defaultChatModel: 'doubao-seed-1-6',
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
    defaultChatModel: 'MiniMax-M2',
    query: queryMiniMaxQuota,
  },
  {
    type: 'moonshot',
    label: 'Kimi / Moonshot（API 余额）',
    autoQuery: true,
    defaultBaseUrl: MOONSHOT_DEFAULT_BASE_URL,
    defaultChatModel: 'kimi-k2-turbo-preview',
    query: queryMoonshotBalance,
  },
  {
    type: 'siliconflow',
    label: '硅基流动 SiliconFlow（余额）',
    autoQuery: true,
    defaultBaseUrl: SILICONFLOW_DEFAULT_BASE_URL,
    defaultChatModel: 'deepseek-ai/DeepSeek-V3',
    query: querySiliconflowBalance,
  },
  {
    type: 'stepfun',
    label: '阶跃星辰 StepFun（余额）',
    autoQuery: true,
    defaultBaseUrl: STEPFUN_DEFAULT_BASE_URL,
    defaultChatModel: 'step-2-16k',
    query: queryStepfunBalance,
  },
  {
    type: 'openrouter',
    label: 'OpenRouter（余额）',
    autoQuery: true,
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    defaultChatModel: 'openrouter/auto',
    query: queryOpenRouterBalance,
  },
  {
    type: 'novita',
    label: 'Novita AI（余额）',
    autoQuery: true,
    defaultBaseUrl: NOVITA_DEFAULT_BASE_URL,
    defaultChatModel: 'deepseek/deepseek-v3',
    query: queryNovitaBalance,
  },
  { type: 'anthropic', label: 'Anthropic Claude（订阅）', autoQuery: false, defaultBaseUrl: 'https://api.anthropic.com', defaultChatModel: '' },
  { type: 'openai', label: 'OpenAI / Codex（订阅）', autoQuery: false, defaultBaseUrl: 'https://api.openai.com', defaultChatModel: 'gpt-4o-mini' },
  { type: 'qwen', label: 'Qwen / 通义（百炼）', autoQuery: false, defaultBaseUrl: 'https://dashscope.aliyuncs.com', defaultChatModel: 'qwen-plus' },
  { type: 'kimi-coding', label: 'Kimi 会员编程套餐（暂不可查）', autoQuery: false, defaultBaseUrl: 'https://api.kimi.com', defaultChatModel: 'kimi-k2-turbo-preview' },
  { type: 'custom', label: '其他（手动维护）', autoQuery: false, defaultBaseUrl: '', defaultChatModel: '' },
];

export function getProviderType(type) {
  return PROVIDER_TYPES.find((t) => t.type === type) || PROVIDER_TYPES[PROVIDER_TYPES.length - 1];
}
