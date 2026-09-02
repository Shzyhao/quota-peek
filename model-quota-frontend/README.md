# 模型额度查询（前端）

一个轻量级**纯前端**本地小工具：查询并记录多个大模型供应商的套餐余额、剩余额度和到期时间。基于需求文档《模型额度查询要求.md》开发，按本次任务要求**仅实现前端界面**，其中 **DeepSeek、智谱 GLM Coding Plan、MiniMax、Kimi/Moonshot 四家接入官方接口自动查询**，其余类型标记「不支持自动查询」并手动维护。

技术栈：Vite + 原生 JavaScript（无 UI 框架，代码简单清晰），Vitest + jsdom 做单元/集成测试。

## 运行

```bash
npm install
npm run dev        # 开发模式，打开 http://localhost:5173
npm test           # 运行全部测试（147 个用例）
npm run build      # 生产构建（输出到 dist/）
npm run preview    # 预览生产构建
```

## 功能

- **应用壳与导航**：左侧边栏四视图（总览 / 供应商 / 查询日志 / 设置），hash 路由（`#/overview` 等）；顶栏全局操作（一键刷新、添加供应商、主题切换）。
- **深色模式**：设计 tokens 双主题，支持 跟随系统 / 浅色 / 深色（顶栏一键循环切换或设置页选择），迷你小窗口同步。
- **总览页**：余额合计、供应商数、需关注数、最近刷新四张统计卡 + 按健康度排序（异常 > 提醒 > 正常 > 中性）的供应商卡片。
- **供应商页**：关键词搜索（名称/备注/类型，实时过滤不动焦点）+ 状态筛选（全部/需要关注/正常/异常/提醒/已停用）。
- **用量可视化**：Coding Plan 卡片展示 近 5 小时 / 本周 / 本月 MCP 进度条；余额型卡片展示剩余额度占比条；进度条按 <80 绿 / 80–90 橙 / ≥90 红 分色。
- **供应商配置管理**：添加 / 编辑 / 删除供应商，字段包含供应商名称、类型、API Key、Base URL、套餐总额度、已用额度、剩余额度、到期时间、备注、是否启用（需求 1、2）。删除等危险操作使用**样式化确认弹窗**（含危险红色样式、Esc/遮罩关闭）。
- **自动查询（4 家，均已实测浏览器 CORS 直连）**：
  - **DeepSeek**：`GET https://api.deepseek.com/user/balance`（Bearer），返回余额 / 赠送余额 / 充值余额 / 可用状态；
  - **智谱 GLM Coding Plan**：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（裸 Key，与官方 `glm-plan-usage` 插件同款接口），返回近 5 小时 / 周限额 / MCP 月度**用量百分比**；
  - **MiniMax Coding Plan**：`GET https://api.minimaxi.com/v1/token_plan/remains`（Bearer，与官方 CLI `mmx quota` 同款），返回窗口 / 周剩余百分比（换算为已用%）；`sk-api-` 前缀的普通 API Key 自动路由到 `GET /account/query_balance` 查账户余额；
  - **Kimi / Moonshot**：`GET https://api.moonshot.cn/v1/users/me/balance`（Bearer，官方文档接口），返回可用 / 代金券 / 现金余额。
- **其他供应商**（Anthropic Claude 订阅、OpenAI/Codex 订阅、Qwen/百炼、其他）暂无公开、可 API Key 直连的官方额度接口，按需求第 6 条标记「不支持自动查询」（不用爬虫、不模拟登录），额度信息全部手动维护。调研详情见下方「各家 Coding Plan 额度接口调研」。
- **刷新方式**：单个供应商手动刷新、一键刷新全部、可配置间隔的定时刷新（分钟，0 = 关闭）（需求 4）。
- **卡片展示**：
  - 余额型（DeepSeek/Kimi/MiniMax 普通密钥）：余额、剩余额度、已用额度、套餐总额度、到期时间、查询状态、最后更新时间，并附代金券/现金等明细行（需求 5）；
  - Coding Plan 型（智谱/MiniMax 套餐）：近 5 小时用量、本周用量、已用额度、套餐总额度 + 套餐详情（MCP 月度用量等）。
  - 剩余额度未填写时按「套餐总额度 − 已用额度」自动推导。
- **颜色提示**：查询失败 / 已到期 → 红色；余额过低、剩余额度过低、**套餐用量 ≥ 90%（窗口或周）**、7 天内到期 → 橙色；正常 → 绿色；不支持自动查询 / 已停用 → 灰色。提醒阈值均可在「提醒与定时刷新设置」中调整（需求 7）。
- **查询日志**：记录供应商、查询时间、状态、余额、剩余额度、错误信息，最近 100 条，可一键清空（需求 8）。
- **数据备份（纯前端）**：设置页支持导出/导入 JSON 备份（覆盖式导入带二次确认与结构校验）、清空全部数据。⚠ 备份文件包含 API Key 明文，请妥善保管。
- **迷你小窗口**：点击「迷你窗口」以 360×600 小窗打开 `?view=mini` 紧凑视图，含微型进度条，主题跟随全局（需求 11 的纯前端实现方式）。

## 各家 Coding Plan 额度接口调研（2026-09）

| 供应商 | 套餐 | 查询接口 | 鉴权 | 浏览器 CORS | 本工具结论 |
|---|---|---|---|---|---|
| DeepSeek | API 按量 | `GET api.deepseek.com/user/balance`（[官方文档](https://api-docs.deepseek.com/zh-cn/zh-cn/api/get-user-balance)） | Bearer | ✅ 实测通过 | ✅ 已接入 |
| 智谱 GLM Coding Plan | 个人版订阅 | `GET open.bigmodel.cn/api/monitor/usage/quota/limit`（[官方插件](https://github.com/zai-org/zai-coding-plugins)同款） | 裸 Key（无 Bearer） | ✅ 实测通过 | ✅ 已接入 |
| 火山方舟 Coding Plan | Coding/Agent Plan 订阅 | `POST open.volcengineapi.com/?Action=GetCodingPlanUsage`（官方 OpenAPI，无 Coding 数据时回退 `Action=GetAFPUsage` 查 Agent Plan） | **IAM AK/SK + SigV4 签名**（浏览器端 Web Crypto 实现，与官方 SDK 派生链 Date→Region→Service(ark)→request 一致） | ✅ 实测开放（`allow-origin: *`，允许 X-Date/Authorization/X-Content-Sha256） | ✅ 已接入（双凭证表单） |
| MiniMax Coding Plan | Token Plan 订阅 | 优先 `GET api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（[cc-switch](https://github.com/farion1231/cc-switch) 同款，取 `general` 条目），失败回退官方 CLI 的 `GET /v1/token_plan/remains`；国际站 `api.minimax.io` | Bearer | ✅ 实测通过 | ✅ 已接入（普通 `sk-api-` 密钥自动走 `/account/query_balance`） |
| Kimi / Moonshot | API 按量余额 | `GET api.moonshot.cn/v1/users/me/balance`（[官方文档](https://platform.kimi.com/docs/api/balance)） | Bearer | ✅ 实测通过 | ✅ 已接入（注意查的是 API 余额，非会员 Coding 套餐用量） |
| Kimi 会员编程套餐 | Kimi For Coding 订阅 | `GET api.kimi.com/coding/v1/usages`（cc-switch 同款） | Bearer | ❌ **实测预检 404**（服务端不响应 OPTIONS，浏览器无法跨域） | ❌ 纯前端不可接入；类型保留为「暂不可查」手动维护 |
| 硅基流动 SiliconFlow | API 余额 | `GET api.siliconflow.cn/v1/user/info`（国际站 `.com`；cc-switch 同款） | Bearer | ✅ 实测开放 | ✅ 已接入 |
| 阶跃星辰 StepFun | API 余额 | `GET api.stepfun.com/v1/accounts`（cc-switch 同款） | Bearer | ✅ 实测开放 | ✅ 已接入 |
| OpenRouter | API 余额 | `GET openrouter.ai/api/v1/credits`（cc-switch 同款，余额 = total_credits − total_usage，USD） | Bearer | ✅ 实测开放 | ✅ 已接入 |
| Novita AI | API 余额 | `GET api.novita.ai/v3/user/balance`（cc-switch 同款，单位 0.0001 USD） | Bearer | ✅ 实测开放 | ✅ 已接入 |
| Anthropic Claude | Pro/Max 订阅 | `GET api.anthropic.com/api/oauth/usage`（**非官方**，需 Claude Code OAuth 访问令牌，易 429，见 [issue #31021](https://github.com/anthropics/claude-code/issues/31021)、[#44328](https://github.com/anthropics/claude-code/issues/44328)） | OAuth 短时令牌 | 未知/受限 | ❌ 未接入：非公开 API + OAuth 令牌时效短，不符需求第 6 条 |
| OpenAI Codex | ChatGPT 订阅 | 无公开接口，官方指引为[网页用量页](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | — | — | ❌ 未接入 |
| Gemini CLI | 免费 / AI Pro | `cloudcode-pa.googleapis.com/v1internal`（内部接口，无文档，需 `~/.gemini/tokens.json` 的 OAuth，见 [讨论 #3096](https://github.com/google-gemini/gemini-cli/discussions/3096)） | OAuth | — | ❌ 未接入：内部接口 + OAuth |
| Qwen Code | 百炼 Coding Plan | 无公开额度查询接口（[Qwen OAuth 免费层已于 2026-04 停用](https://github.com/QwenLM/qwen-code/issues/3203)） | — | — | ❌ 未接入 |

> 调研说明：智谱与 MiniMax 的接口虽未列入正式 API 文档，但分别是**智谱官方开源插件**与 **MiniMax 官方 CLI** 正在使用的查询路径，属于官方工具背书的公开端点；两者错误均以 HTTP 200 + 响应体错误码返回（智谱 `success:false`，MiniMax `base_resp.status_code`），适配器已按此处理。CORS 均于 2026-09-01 从浏览器环境实测（OPTIONS 预检通过、允许 `Authorization` 头）。

## 安全说明（对应需求安全要求）

- **API Key 不明文显示**：卡片与编辑弹窗中一律脱敏为 `sk-a••••••0000` 形式；编辑时密钥输入留空表示沿用原密钥，界面从不回显明文。火山方舟的双凭证（AccessKey ID / Secret Access Key）同样脱敏。
- **日志不落密钥**：日志结构中无密钥字段；错误信息写入前统一脱敏（替换完整密钥及 `sk-xxx` 形式的 token），火山方舟场景 AK/SK 均参与脱敏。
- **代码中无真实密钥**：仓库内所有密钥均为测试占位值（如 `sk-test-1234567890`）。
- **数据仅存本地**：所有配置、日志保存在当前浏览器的 `localStorage`（键前缀 `mqc.`），不向任何第三方发送（查询请求只发往所配置的供应商官方 API）。
- **火山方舟凭证安全建议**：该类型使用 IAM 访问密钥（AK/SK），权限远大于模型 API Key。**强烈建议在火山引擎「访问控制 IAM」中创建子用户，仅授予方舟用量查询相关的只读权限，再用该子用户的 AK/SK 接入本工具**，并理解纯前端方案下 SK 保存在本机浏览器 localStorage 中的风险。

> 与原需求文档的差异说明：原文设想「后端 / Windows 凭证保管密钥」，本任务限定**仅前端**，因此密钥保存在浏览器 localStorage 中并全程脱敏；「系统状态栏小窗口」在纯前端范围内以浏览器小窗口（弹窗）形式实现。若后续需要升级为桌面应用（如 Electron + 托盘常驻），核心逻辑（`src/core/`）可直接复用。

## 目录结构

```
├── index.html                 # 入口页面
├── vite.config.js             # Vite + Vitest 配置
├── src/
│   ├── main.js                # 应用入口（主题初始化 + 主界面/迷你窗分流）
│   ├── styles.css             # 设计系统：tokens（浅/深双主题）、应用壳、组件、微交互
│   ├── core/                  # 核心逻辑（纯函数，可独立测试）
│   │   ├── deepseek.js        # DeepSeek 官方余额 API 适配器
│   │   ├── zhipu.js           # 智谱 GLM Coding Plan 用量适配器
│   │   ├── minimax.js         # MiniMax 套餐余量/账户余额适配器
│   │   ├── moonshot.js        # Kimi/Moonshot 余额适配器
│   ├── balance.js         # StepFun/SiliconFlow/OpenRouter/Novita 通用余额适配器
│   ├── volcengine.js      # 火山方舟 Coding/Agent Plan 适配器（SigV4）
│   │   ├── providers.js       # 供应商类型注册表（autoQuery 标记）
│   │   ├── status.js          # 状态评估、排序/筛选、到期天数、剩余额度推导
│   │   ├── storage.js         # localStorage 仓储 + 配置归一化
│   │   ├── logger.js          # 查询日志（脱敏、上限 100 条）
│   │   ├── service.js         # 刷新编排（单个/全部，成功失败都记录）
│   │   ├── theme.js           # 深色模式（auto/light/dark）
│   │   ├── backup.js          # JSON 备份导出/导入
│   │   ├── mask.js            # API Key 脱敏与文本净化
│   │   ├── url.js             # Base URL 规范化
│   │   └── errors.js          # 业务错误类型
│   └── ui/
│       ├── app.js             # 应用壳：侧边栏、hash 路由、全局动作、备份/主题接线
│       ├── views.js           # 总览/供应商/日志/设置视图模板与供应商卡片
│       ├── form.js            # 添加/编辑弹窗
│       ├── confirm.js         # 样式化确认弹窗（Promise 化）
│       ├── mini.js            # 迷你小窗视图
│       └── format.js          # 转义与格式化工具
└── tests/                     # 147 个测试用例（Vitest + jsdom）
    ├── mask.test.js           # 脱敏规则
    ├── deepseek.test.js       # 官方 API 适配（成功/401/网络/解析/缺 key）
    ├── zhipu.test.js          # 智谱适配（用量归一/裸鉴权/体错误码）
    ├── minimax.test.js        # MiniMax 适配（双端点路由/剩余→已用换算）
    ├── moonshot.test.js       # Kimi 适配（余额/代金券现金明细/401）
    ├── balance.test.js       # StepFun/SiliconFlow/OpenRouter/Novita 适配
    ├── volcengine.test.js     # 火山方舟适配（SigV4 签名对拍/双接口回退/错误分类）
    ├── status.test.js         # 提醒规则、排序、筛选
    ├── storage.test.js        # 仓储 CRUD、批量/清空、设置合并
    ├── logger.test.js         # 日志记录、脱敏、上限
    ├── service.test.js        # 刷新编排与日志联动
    ├── theme.test.js          # 深色模式状态与解析
    ├── backup.test.js         # 备份构建/解析/覆盖导入
    ├── confirm.test.js        # 确认弹窗交互与注入防护
    └── app.test.js            # UI 集成（导航/搜索/筛选/刷新/确认/表单/迷你窗）
```

## 各家接口返回示例

**智谱 `GET /api/monitor/usage/quota/limit`**（官方插件口径）：

```json
{
  "success": true,
  "data": {
    "limits": [
      { "type": "TOKENS_LIMIT", "unit": 3, "usage": 100000, "currentValue": 32500, "percentage": 32.5, "nextResetTime": 1756848000000 },
      { "type": "TOKENS_LIMIT", "unit": 6, "usage": 500000, "currentValue": 225000, "percentage": 45 },
      { "type": "TIME_LIMIT", "unit": 0, "usage": 100, "currentValue": 24, "percentage": 24 }
    ]
  }
}
```

- `TOKENS_LIMIT` 有两条，靠 `unit` 区分：**3 = 近 5 小时窗口**、**6 = 周额度**；`usage` 为总额度数值、`currentValue` 为已用数值、`percentage` 为已用百分比（可能超 100，展示时截断）、`nextResetTime` 为重置时间戳（毫秒）；
- `TIME_LIMIT` → MCP 月度用量%；
- 旧版响应若无 `unit` 字段，第一条 `TOKENS_LIMIT` 按官方插件行为视为 5 小时窗口；
- 卡片展示：近 5 小时/本周/本月 MCP 三条进度条 + 本周已用/本周总额数值 + 重置时间（套餐详情行）；
- 错误以 HTTP 200 返回：`{"code":401,"msg":"令牌已过期或验证不正确","success":false}`。

**MiniMax `GET /v1/token_plan/remains`**（官方 CLI 口径）：

```json
{
  "model_remains": [
    {
      "model_name": "MiniMax-M2.5",
      "current_interval_remaining_percent": 68,
      "current_weekly_remaining_percent": 75,
      "current_interval_status": 1
    }
  ]
}
```

- 各模型行取「用量最紧」一行作为代表；`*_remaining_percent` 为**剩余**百分比，工具内换算为已用%；
- `status`：1 正常、2 已耗尽、3 不限；错误以 `base_resp.status_code`（如 1004 登录失败）返回。

**火山方舟 `POST /?Action=GetCodingPlanUsage&Version=2024-01-01`**（官方 OpenAPI）：

- 鉴权：IAM AccessKey ID + Secret Access Key 的 **SigV4 签名**（工具内用浏览器 Web Crypto 实现，派生链 `Date → Region(cn-beijing) → Service(ark) → request`，请求头 `X-Date` / `X-Content-Sha256` / `Authorization`），测试用 Node 官方 crypto 对拍验证签名一致；
- 返回 `Result.QuotaUsage[]`：`Level`（`session` 近 5 小时 / `weekly` / `monthly`）、`Percent`（已用百分比）、`ResetTimestamp`（秒级重置时间）；
- 未订阅 Coding Plan 时自动回退 `Action=GetAFPUsage` 查 Agent Plan（`AFPFiveHour/AFPWeekly/AFPMonthly`，按 `Used/Quota` 计算百分比）；
- 错误位于 `ResponseMetadata.Error`（Code/Message），签名或密钥问题归类为鉴权错误；
- **注意凭证类型**：IAM 访问密钥 ≠ 模型推理的 Ark API Key；建议使用最小权限子账号。

**Kimi `GET /v1/users/me/balance`**：`data.available_balance / voucher_balance / cash_balance`（元）。

**DeepSeek `GET /user/balance`**：`balance_infos[0].total_balance`（元）等；401 → 「API Key 无效」。
