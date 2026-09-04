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
- **低额度提醒三选一**：关闭 / 界面弹窗 / **Windows 系统通知（Toast）**——刷新检测到新的余额 / 额度 / 到期 / 查询失败告警时提醒（同一告警只提醒一次，恢复正常后重新计数）；系统通知由桌面壳原生发送，网页版自动回退界面弹窗
- **提醒阈值可调**：余额过低、剩余额度过低、到期提前天数、定时刷新间隔
- **查询日志**：最近 100 条，含供应商、状态、余额、错误信息
- **桌面版**：系统托盘常驻（左键显隐主窗、右键菜单）、关闭窗口驻留托盘继续定时刷新、单实例
- **桌面悬浮球**：置顶透明圆形科技风小窗常驻桌面——蓝 = 全部正常（显示余额合计，≥1 万自动压缩为「x.x万/亿」）、琥珀 = 有低值/临期提醒、红 = 有异常（显示需关注数）；单击在球旁展开迷你速览窗（鼠标移出自动收起），按住拖动可移位并记忆位置，悬停逐条显示告警摘要；主界面顶栏、设置页、托盘菜单三处开关（首次运行默认开启）
- **迷你速览窗**：300×430 无边框紧凑列表（自绘标题栏可拖动、关闭即隐藏），状态点 / 进度条 / 状态文字按告警级别着色
- **深浅双主题**、关键词搜索、状态筛选、JSON 备份导入导出

## 运行

```bash
# 网页版（开发）
cd model-quota-frontend
npm install
npm run dev        # http://localhost:5173

# 测试（162 个用例，Vitest + jsdom）
npm test

# 桌面版（项目根目录）
npm install        # 安装 Tauri CLI
npm run desktop:dev      # 开发模式（热重载）
npm run desktop:build    # 产出独立 exe：src-tauri/target/release/看额度.exe
npm run desktop:dist     # NSIS 安装包（打包器需访问 GitHub，建议开代理）
```

桌面版双击 exe 即用：关闭主窗口后驻留系统托盘（左键托盘图标切换显隐，右键菜单含「迷你小窗」「打开/关闭悬浮球」与「退出」），重复启动不会开出第二个进程。悬浮球默认开启，可在顶栏按钮（开启时高亮）、设置 → 外观、托盘菜单三处随时开关。也可从 [GitHub Releases](https://github.com/Shzyhao/quota-peek/releases) 直接下载编译好的 exe。

> 系统通知提示：若选择了「系统通知」但看不到右下角横幅，请检查 Windows 设置 → 系统 → 通知（含专注助手/勿扰模式）——通知在锁屏、勿扰或应用通知被关闭时只进通知中心不弹横幅。

## 安全

- API Key 界面全程脱敏（首尾 4 位），编辑留空表示沿用原密钥，从不回显明文
- 日志无密钥字段，错误信息写入前统一脱敏
- 仓库内无真实密钥（均为测试占位值）
- ⚠ 备份 JSON 包含 API Key 明文，请妥善保管

## 目录结构

```
├── model-quota-frontend/   # 前端本体（Vite + 原生 JS + Vitest）
│   ├── src/core/           #   核心逻辑：9 家适配器、状态评估、存储、日志、脱敏
│   └── src/ui/             #   界面：应用壳四视图、卡片、迷你窗、悬浮球、确认弹窗
├── src-tauri/              # Tauri 2 桌面壳（托盘 / 关窗驻留 / 单实例 / 悬浮球 / 迷你窗）
├── scripts/gen-icon.mjs    # 应用图标生成（纯 Node）
├── 开发进度报告.md           # 开发历程（12 阶段）与验收记录
├── 模型额度查询要求.md       # 原始需求
└── 私有化桌面版演进规划.md   # 桌面化路线图（托盘/通知/AI 接口自适配）
```

各供应商额度接口调研结论（含 CORS 实测、错误形状、鉴权方式）详见 [model-quota-frontend/README.md](./model-quota-frontend/README.md)。

## 已知限制

- Kimi 会员编程套餐因服务端 CORS 预检 404 无法自动查询（手动维护）
- 桌面版托盘图标暂为静态色；密钥存储在 WebView localStorage（后续规划迁移 Windows 凭据管理器）
- 托盘悬停浮窗在 Windows 不可实现（tray-icon 底层只上报点击、无 hover 回调），速览入口为悬浮球单击与托盘菜单
- 各查询接口为非正式文档端点（有官方插件 / CLI 背书），上游变更需更新适配器

## 开源协议与参与贡献

- 代码以 **[MIT](./LICENSE)** 协议开源，可自由使用、修改与分发（保留版权声明即可）
- 欢迎 [Issue](https://github.com/Shzyhao/quota-peek/issues) 反馈问题、[PR](https://github.com/Shzyhao/quota-peek/pulls) 参与贡献，流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)
- 安全问题请勿开公开 Issue，报告渠道见 [SECURITY.md](./SECURITY.md)
