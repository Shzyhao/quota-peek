// 构建后处理：复制 release exe 为「桌看.exe」（日常固定名）与「桌看-v{version}.exe」（版本归档名）。
// 版本号取自 src-tauri/tauri.conf.json（与 package.json / Cargo.toml 保持同步）。
import fs from 'node:fs';

const SRC = 'src-tauri/target/release/model-quota-app.exe';
const { version } = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));

fs.copyFileSync(SRC, 'src-tauri/target/release/桌看.exe');
fs.copyFileSync(SRC, `src-tauri/target/release/桌看-v${version}.exe`);
console.log(`→ 桌看.exe / 桌看-v${version}.exe`);
