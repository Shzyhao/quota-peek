#!/usr/bin/env node
// 渲染性能验证：桌宠渲染进程 40s CPU 漂移（限帧收益）+ 两帧截图差分（动画存活证明）。
// 用法：node scripts/render-check.mjs
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';

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
const waitTarget = async (match) => {
  for (let i = 0; i < 100; i++) {
    const hit = (await targets()).find(match);
    if (hit) return hit;
    await sleep(300);
  }
  return null;
};
const connect = async (t) => {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, err) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', err, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  return {
    ws,
    send: (method, params = {}) => new Promise((ok) => { const id = ++seq; pending.set(id, ok); ws.send(JSON.stringify({ id, method, params })); }),
  };
};

// 等主窗与桌宠窗就绪
const main = await waitTarget((t) => t.type === 'page' && !/#(pet|mini|ball|panel-)/.test(t.url));
const pet = await waitTarget((t) => t.type === 'page' && /#pet/.test(t.url));
if (!main || !pet) { console.log('窗口 target 不全'); process.exit(1); }
await sleep(12000); // Live2D 加载稳定

// 桌宠渲染进程 = 进程树里父链到 app 且命令行 --type=renderer，取内存较小者（主窗渲染器更大）
const appPids = execSync(`powershell -NoProfile -Command "(Get-Process | Where-Object { $_.ProcessName -like '*model-quota*' } | Select-Object -ExpandProperty Id) -join ','"`).toString().trim().split(',').filter(Boolean).map(Number);
const lines = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedgewebview2.exe'\\" | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress"`).toString();
const procs = JSON.parse(lines.startsWith('[') ? lines : `[${lines}]`);
const browser = procs.find((p) => !p.CommandLine.includes('--type=') && appPids.includes(p.ParentProcessId));
const renderers = procs.filter((p) => p.CommandLine.includes('--type=renderer') && p.ParentProcessId === browser.ProcessId);
const withMem = renderers.map((r) => ({ ...r, memMB: Math.round(Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${r.ProcessId}).WorkingSet64"`).toString().trim()) / 1048576) }));
const cpuOf = (pid) => Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).CPU"`).toString().trim());
const before = new Map(withMem.map((r) => [r.ProcessId, cpuOf(r.ProcessId)]));
await sleep(40000);
for (const r of withMem) {
  const after = cpuOf(r.ProcessId);
  console.log(`渲染进程 ${r.ProcessId}（工作集 ${r.memMB}MB）40s CPU 增量: ${(after - before.get(r.ProcessId)).toFixed(2)}s => ${(((after - before.get(r.ProcessId)) / 40) * 100).toFixed(1)}% 单核`);
}

// 动画存活：两张相隔 600ms 的桌宠截图应有像素差异（共享 idle 呼吸动画）
const petConn = await connect(pet);
await petConn.send('Page.enable');
const shot = async () => (await petConn.send('Page.captureScreenshot', { format: 'png' })).result.data;
const a = Buffer.from(await shot(), 'base64');
await sleep(600);
const b = Buffer.from(await shot(), 'base64');
const diffBytes = Buffer.compare(a, b) !== 0 ? a.length - Buffer.from(b).length : 0;
let differ = false;
if (a.length === b.length) {
  let diff = 0;
  for (let i = 0; i < a.length; i += 97) if (a[i] !== b[i]) diff++;
  differ = diff > 10;
} else {
  differ = true; // 长度不同必然内容不同
}
writeFileSync(`${ROOT}shots/perf-pet-frame1.png`, a);
writeFileSync(`${ROOT}shots/perf-pet-frame2.png`, b);
console.log(`动画存活: ${differ ? '是（两帧存在像素差异）' : '否（两帧完全一致——渲染停了？）'} (采样差 ${diffBytes})`);
try { execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '*model-quota*' } | Stop-Process -Force"`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
process.exit(differ ? 0 : 1);
