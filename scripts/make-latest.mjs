// 发布流程辅助：生成 Tauri updater 的 latest.json。
// 用法：先完整构建（npm run desktop:dist，需 TAURI_SIGNING_PRIVATE_KEY 环境变量），
// 再 node scripts/make-latest.mjs → 在 release-assets/ 产出 latest.json，
// 上传到 GitHub Release（资产名必须就叫 latest.json，端点指向 releases/latest/download/latest.json）。
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
const nsisDir = path.join(repoRoot, 'src-tauri/target/release/bundle/nsis');
const outDir = path.join(repoRoot, 'release-assets');

const setupExe = fs.readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe'));
if (!setupExe) {
  console.error(`未找到 NSIS 安装包：${nsisDir} 下没有 *-setup.exe（先跑 npm run desktop:dist）`);
  process.exit(1);
}
const sigFile = path.join(nsisDir, `${setupExe}.sig`);
if (!fs.existsSync(sigFile)) {
  console.error(`未找到签名文件 ${sigFile}（构建时需设置 TAURI_SIGNING_PRIVATE_KEY）`);
  process.exit(1);
}
const signature = fs.readFileSync(sigFile, 'utf8').trim();

// gh release 中文资产名会被剥离且不可逆（2026-09-15 实证）→ 一律重命名为 ASCII
const asciiName = `ZhuoKan_${version}_x64-setup.exe`;

const REPO = 'Shzyhao/quota-peek';
const latest = {
  version,
  notes: `桌看 v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${REPO}/releases/download/v${version}/${asciiName}`,
    },
  },
};

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(nsisDir, setupExe), path.join(outDir, asciiName));
const outPath = path.join(outDir, 'latest.json');
fs.writeFileSync(outPath, JSON.stringify(latest, null, 2));
console.log(`→ ${outPath}`);
console.log(`  安装包: release-assets/${asciiName}（改名不影响签名内容）`);
console.log(`  上传: gh release upload v${version} release-assets/${asciiName} ${outPath} --clobber`);
