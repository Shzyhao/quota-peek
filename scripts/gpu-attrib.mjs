#!/usr/bin/env node
// 桌宠 GPU 成本归因实验：同一实例内「桌宠开 → 关（窗口销毁）→ 再开」三段各测 40s
// GPU 进程 CPU 漂移，差值 = Live2D 常驻渲染的真实 GPU 成本。
// 用法：node scripts/gpu-attrib.mjs
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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

// 等 CDP 与页面就绪
const targets = async () => {
  try { return await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch { return []; }
};
let main = null;
for (let i = 0; i < 100; i++) {
  main = (await targets()).find((t) => t.type === 'page' && !/#(pet|mini|ball|panel-)/.test(t.url));
  if (main) break;
  await sleep(300);
}
if (!main) { console.log('主窗 target 未出现'); process.exit(1); }
const ws = new WebSocket(main.webSocketDebuggerUrl);
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
await send('Runtime.enable');
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('页面求值失败');
  return r.result?.result?.value;
};
// 等 app 完全加载（桌宠窗已创建）
for (let i = 0; i < 100; i++) {
  const ready = await evalJs(`!!globalThis.__TAURI__?.core?.invoke && document.readyState === 'complete'`).catch(() => false);
  if (ready) break;
  await sleep(300);
}
await sleep(8000); // 等 Live2D 加载稳定

const findGpuPid = async () => {
  const appPids = execSync(`powershell -NoProfile -Command "(Get-Process | Where-Object { $_.ProcessName -like '*model-quota*' } | Select-Object -ExpandProperty Id) -join ','"`).toString().trim().split(',').filter(Boolean).map(Number);
  const lines = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedgewebview2.exe'\\" | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress"`).toString();
  const procs = JSON.parse(lines.startsWith('[') ? lines : `[${lines}]`);
  const gpu = procs.find((p) => p.CommandLine.includes('--type=gpu-process') && procs.some((b) => b.ProcessId === p.ParentProcessId && appPids.includes(b.ParentProcessId)));
  return gpu?.ProcessId;
};

const measure = async (label, seconds) => {
  const gpuPid = await findGpuPid();
  if (!gpuPid) { console.log(`${label}: 未找到 GPU 进程`); return; }
  const cpu = Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${gpuPid}).CPU"`).toString().trim());
  await sleep(seconds * 1000);
  const cpu2 = Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${gpuPid}).CPU"`).toString().trim());
  console.log(`${label}: GPU ${seconds}s 增量 ${(cpu2 - cpu).toFixed(2)}s => ${(((cpu2 - cpu) / seconds) * 100).toFixed(1)}% 单核`);
};

await measure('桌宠开（Live2D 渲染中）', 40);
await evalJs(`globalThis.__TAURI__.event.emit('set-ball', false); 'ok'`);
await sleep(5000);
await measure('桌宠关（窗口已销毁）', 40);
await evalJs(`globalThis.__TAURI__.event.emit('set-ball', true); 'ok'`);
await sleep(8000);
await measure('桌宠重开（对照）', 40);

try { execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -like '*model-quota*' } | Stop-Process -Force"`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
process.exit(0);
