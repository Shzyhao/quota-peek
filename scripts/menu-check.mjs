#!/usr/bin/env node
// 功能菜单侧边展开验证：点击桌宠 → 菜单应在左侧延伸条（menu-left 类），
// 画布平移 160px（人物原位）、菜单可见且宽 ~152px；关闭后还原（类移除、菜单隐藏）。
// 用法：node scripts/menu-check.mjs
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXE = `${ROOT}src-tauri/target/release/model-quota-app.exe`;
const CDP = 9223;

try {
  execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '*model-quota*' } | Stop-Process -Force"`, { stdio: 'ignore' });
} catch { /* 无实例 */ }
await sleep(800);
const proc = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` },
  stdio: 'ignore',
});

const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch { return []; } };
let pet = null;
for (let i = 0; i < 100; i++) {
  pet = (await targets()).find((t) => t.type === 'page' && /#pet/.test(t.url));
  if (pet) break;
  await sleep(300);
}
if (!pet) { console.log('❌ pet target 不存在'); process.exit(1); }
const ws = new WebSocket(pet.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((ok) => {
  const id = ++seq;
  pending.set(id, ok);
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('求值失败');
  return r.result?.result?.value;
};
await evalJs(`1`);
await sleep(9000); // 等 Live2D 就绪

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
};

// 展开菜单
await evalJs(`document.querySelector('.pet-stage').click(); 'ok'`);
await sleep(1000);
const open = await evalJs(`(() => {
  const stage = document.querySelector('.pet-stage');
  const menu = document.querySelector('.pet-menu');
  const canvas = stage.querySelector('canvas');
  const rect = menu.getBoundingClientRect();
  return {
    visible: menu && !menu.hidden,
    side: stage.classList.contains('menu-left') ? 'left' : stage.classList.contains('menu-right') ? 'right' : 'none',
    canvasShift: getComputedStyle(canvas).transform,
    menuX: Math.round(rect.x), menuW: Math.round(rect.width), menuH: Math.round(rect.height),
    items: [...menu.querySelectorAll('[data-menu]')].map((b) => b.dataset.menu).join(','),
  };
})()`);
check('菜单展开且定位到左侧延伸条', open.visible && open.side === 'left', `side=${open.side} x=${open.menuX} w=${open.menuW}`);
check('人物画布平移 160px（原位不被遮挡）', open.canvasShift.includes('160'), open.canvasShift);
check('菜单条尺寸合理（~152px 宽）', open.menuW >= 140 && open.menuW <= 165, `w=${open.menuW} h=${open.menuH}`);
check('菜单项齐全', ['chat', 'voice', 'analysis', 'quota', 'skins', 'close'].every((k) => open.items.includes(k)), open.items);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${ROOT}shots/menu-left-open.png`, Buffer.from(shot.result.data, 'base64'));

// 收起菜单（点 ×）
await evalJs(`document.querySelector('[data-menu="close"]')?.click(); 'ok'`);
await sleep(1200);
const closed = await evalJs(`(() => {
  const stage = document.querySelector('.pet-stage');
  return {
    hidden: document.querySelector('.pet-menu').hidden,
    sideCleared: !stage.classList.contains('menu-left') && !stage.classList.contains('menu-right'),
    canvasReset: !getComputedStyle(stage.querySelector('canvas')).transform.includes('160'),
  };
})()`);
check('菜单收起且布局还原', closed.hidden && closed.sideCleared && closed.canvasReset, JSON.stringify(closed));

try {
  execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '*model-quota*' } | Stop-Process -Force"`, { stdio: 'ignore' });
} catch { /* 已退出 */ }
const pass = results.filter(Boolean).length;
console.log(`\n==== 菜单布局验证：${pass}/${results.length} 通过 ====`);
process.exit(pass === results.length ? 0 : 1);
