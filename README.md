# 看额度 · QuotaPeek

一个轻量级本地小工具：查询并记录**多家大模型供应商**的套餐余额、剩余额度和到期时间，托盘常驻，随手看一眼心里有数。

- 中文产品名：**看额度**（原名「模型额度查询」）
- 技术形态：纯前端（Vite + 原生 JS，零 UI 框架）+ **Tauri 2 桌面壳**（Windows 托盘常驻），前端两种形态共用同一套代码
- 数据全部保存在本机（浏览器 localStorage / WebView2 本地存储），无任何服务端

## 功能

- **供应商管理**：添加 / 编辑 / 删除，支持 API Key、Base URL、套餐额度、到期时间、备注、启停
- **自动查询 9 家**（官方或官方工具背书的接口，浏览器直连）：DeepSeek、智谱 GLM Coding Plan、火山方舟 Coding Plan（IAM SigV4 签名）、MiniMax Coding Plan、Kimi/Moonshot、硅基流动、StepFun、OpenRouter、Novita
- **手动维护**：Anthropic / OpenAI / Gemini / Qwen 等无公开 API Key 式接口的供应商，标记「不支持自动查询」并手动记录额度
- **用量可视化**：Coding Plan 卡片展示近 5 小时 / 本周 / 本月 MCP 进度条（<80 绿 / 80–90 橙 / ≥90 红），余额型展示剩余额度占比条
- **低额度弹窗提醒**：设置中开启后，刷新检测到新的余额 / 额度 / 到期 / 查询失败告警时弹窗提示（同一告警只提醒一次，恢复正常后重新计数）
- **提醒阈值可调**：余额过低、剩余额度过低、到期提前天数、定时刷新间隔
- **查询日志**：最近 100 条，含供应商、状态、余额、错误信息
- **桌面版**：系统托盘常驻（左键显隐主窗、右键菜单）、关闭窗口驻留托盘继续定时刷新、托盘迷你小窗速览、单实例
- **深浅双主题**、关键词搜索、状态筛选、JSON 备份导入导出

## 运行

```bash
# 网页版（开发）
cd model-quota-frontend
npm install
npm run dev        # http://localhost:5173

# 测试（150 个用例，Vitest + jsdom）
npm test

# 桌面版（项目根目录）
npm install        # 安装 Tauri CLI
npm run desktop:dev      # 开发模式（热重载）
npm run desktop:build    # 产出独立 exe：src-tauri/target/release/看额度.exe
npm run desktop:dist     # NSIS 安装包（打包器需访问 GitHub，建议开代理）
```

桌面版双击 exe 即用：关闭主窗口后驻留系统托盘（左键托盘图标切换显隐，右键菜单含「迷你小窗」与「退出」），重复启动不会开出第二个进程。

## 安全

- API Key 界面全程脱敏（首尾 4 位），编辑留空表示沿用原密钥，从不回显明文
- 日志无密钥字段，错误信息写入前统一脱敏
- 仓库内无真实密钥（均为测试占位值）
- ⚠ 备份 JSON 包含 API Key 明文，请妥善保管

## 目录结构

```
├── model-quota-frontend/   # 前端本体（Vite + 原生 JS + Vitest）
│   ├── src/core/           #   核心逻辑：9 家适配器、状态评估、存储、日志、脱敏
│   └── src/ui/             #   界面：应用壳四视图、卡片、迷你窗、确认弹窗
├── src-tauri/              # Tauri 2 桌面壳（托盘 / 关窗驻留 / 单实例 / 迷你窗）
├── scripts/gen-icon.mjs    # 应用图标生成（纯 Node）
├── 开发进度报告.md           # 开发历程（9 阶段）与验收记录
├── 模型额度查询要求.md       # 原始需求
└── 私有化桌面版演进规划.md   # 桌面化路线图（托盘/通知/AI 接口自适配）
```

各供应商额度接口调研结论（含 CORS 实测、错误形状、鉴权方式）详见 [model-quota-frontend/README.md](./model-quota-frontend/README.md)。

## 已知限制

- Kimi 会员编程套餐因服务端 CORS 预检 404 无法自动查询（手动维护）
- 桌面版托盘图标暂为静态色；密钥存储在 WebView localStorage（后续规划迁移 Windows 凭据管理器）
- 各查询接口为非正式文档端点（有官方插件 / CLI 背书），上游变更需更新适配器
