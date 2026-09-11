// 下载 bilibili 22 娘全部皮肤（leeyiding/live2d-bilibili-2233，GPL）。
// 体积优化：moc 与动作文件全皮肤共用（内容一致），只在 22/ 根放一份；
// 每个皮肤目录只含 model.json（路径补丁指向共享 moc/动作）+ 贴图。
// 用法：node scripts/fetch-22-skins.mjs
import fs from 'node:fs';
import path from 'node:path';

// jsDelivr 对该仓库部分文件 404（仓库超其缓存上限），必须用 raw.githubusercontent.com
const BASE = 'https://raw.githubusercontent.com/leeyiding/live2d-bilibili-2233/master/22_model';
const DEST = 'model-quota-frontend/public/assets/live2d/22/skins';
// 0default 已在 22/ 根（默认皮肤），其余皮肤下载到 skins/<id>/
const SKINS = [
  'bls', 'bls-summer', 'bls-winer', 'cba-normal', 'cba-super', 'deluxe', 'lover',
  'newyear', 'playwater', 'school', 'spring', 'summer', 'summer-normal',
  'summer-super', 'tomo-bukatsu-high', 'tomo-bukatsu-low', 'vadys', 'valley', 'xmas',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// raw.githubusercontent 有限速（429）：带退避重试；model.json 已存在的皮肤跳过（断点续传）
async function download(url, dest) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return buf.length;
    }
    if (res.status === 429 && attempt <= 6) {
      await sleep(3000 * attempt);
      continue;
    }
    throw new Error(`${res.status} ${url}`);
  }
}

for (const id of SKINS) {
  const folder = `22-${id}`;
  const dir = path.join(DEST, id);
  if (fs.existsSync(path.join(dir, 'model.json'))) {
    console.log(`skip ${id} (已存在)`);
    continue;
  }
  const cfgRes = await fetch(`${BASE}/${folder}/model.json`);
  if (!cfgRes.ok) { console.error(`FAIL model.json ${id}: ${cfgRes.status}`); process.exit(1); }
  const cfg = await cfgRes.json();

  // 下载贴图（保持相对路径结构）
  let bytes = 0;
  for (const tex of cfg.textures) {
    bytes += await download(`${BASE}/${folder}/${tex}`, path.join(dir, tex));
  }

  // 补丁：moc/动作指向 22/ 根的共享文件（skins/<id>/ 相对上两级即 22/）
  cfg.model = `../../${cfg.model}`;
  for (const group of Object.values(cfg.motions)) {
    for (const m of group) m.file = `../../${m.file}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(cfg));
  console.log(`ok ${id} (${(bytes / 1024).toFixed(0)} KB textures)`);
}
console.log('all skins done');
