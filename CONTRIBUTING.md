# 参与贡献

欢迎 Issue 和 PR！这是个刻意保持简单的小工具，提改动前请先读一遍《模型额度查询要求.md》里的原则：**尽量简单，不做复杂系统**。

## 开发环境

- Node.js ≥ 22（建议 24；jsdom 依赖的 undici 在 Node 20 上缺少所需 API）
- Rust stable（仅桌面壳需要，配合 Tauri 2）
- 网页版不需要 Rust，只跑前端即可

## 本地开发

```bash
# 网页版（只需 Node）
cd model-quota-frontend
npm install
npm run dev          # http://localhost:5173

# 测试（150 个用例）
npm test

# 桌面版（需 Rust 工具链）
cd ..
npm install
npm run desktop:dev
```

## 改动要求

1. **测试必须全绿**：`npm test`（改动核心逻辑请同步补测试）
2. **安全红线**：
   - 不引入任何真实 API Key / 密钥（测试一律用占位值如 `sk-test-1234567890`）
   - API Key 在界面与日志中保持脱敏，新功能不得回显明文
   - 不使用爬虫、模拟登录或绕过验证的方式获取数据（无官方接口的供应商标记「不支持自动查询」转手动维护）
3. **风格**：原生 JS、无 UI 框架、不引重量级依赖；注释说明「为什么」而不是「做了什么」

## 提交流程

1. Fork 并拉分支：`feat/xxx` 或 `fix/xxx`
2. 提交 PR，描述清楚改了什么、为什么；有界面改动请附截图
3. CI（前端测试 + 桌面壳编译检查）通过后合并

## 新增供应商适配器

参考 `model-quota-frontend/src/core/deepseek.js` 的结构（错误转换、脱敏、超时处理），并在 `tests/` 补对应测试；接口调研结论记录到 `model-quota-frontend/README.md` 的调研表。
