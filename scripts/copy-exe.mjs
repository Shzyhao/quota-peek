// 构建后处理：复制 release exe 为「ZhuoKan.exe」（日常固定名）与「ZhuoKan-v{version}.exe」（版本归档名）。
// 版本号取自 src-tauri/tauri.conf.json（与 package.json / Cargo.toml 保持同步）。
// 产物名必须 ASCII：gh release 资产中文名会被剥离（2026-09-15 实证且不可逆），
// 带中文的进程镜像名还会让 PowerShell/tasklist 的名字过滤漏杀（单实例活尸导致新启动秒退）。
import fs from 'node:fs';

const SRC = 'src-tauri/target/release/model-quota-app.exe';
const { version } = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));

fs.copyFileSync(SRC, 'src-tauri/target/release/ZhuoKan.exe');
fs.copyFileSync(SRC, `src-tauri/target/release/ZhuoKan-v${version}.exe`);
console.log(`→ ZhuoKan.exe / ZhuoKan-v${version}.exe`);
