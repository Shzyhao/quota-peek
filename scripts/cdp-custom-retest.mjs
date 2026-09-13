// 重测：正斜杠 asset URL 的自定义形象端到端（设置页预览 + 桌宠窗）
const fs = await import('node:fs');
const path = await import('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.find((t) => t.type === 'page' && t.url.startsWith('http://tauri.localhost/') && !t.url.includes('#pet') && !t.url.includes('#panel'));
const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const m = ++id;
  pending.set(m, { resolve });
  ws.send(JSON.stringify({ id: m, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => { ws.onopen = r; });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

// 清残留 + 导入新副本 + 用正斜杠 URL 激活（与 petSettings 组件同逻辑）
await evalJs(`(async () => {
  localStorage.removeItem('mqc.pet.customModel');
  localStorage.removeItem('mqc.pet.customModels');
  const { invoke } = globalThis.__TAURI__.core;
  const res = await invoke('pet_import_model', { src: ${JSON.stringify(path.resolve('tmp-mymodel-haru'))} });
  const sample = globalThis.__TAURI__.core.convertFileSrc('X');
  const base = sample.slice(0, sample.lastIndexOf('/') + 1);
  const url = base + encodeURIComponent(res.abs_path).replaceAll('%5C', '/').replaceAll('%3A', ':');
  const entry = { id: 'custom-fixed', name: res.name, url, runtime: res.runtime };
  localStorage.setItem('mqc.pet.customModels', JSON.stringify([entry]));
  localStorage.setItem('mqc.pet.customModel', JSON.stringify(entry));
  return JSON.stringify({ name: res.name, urlHead: url.slice(0, 90) });
})()`);
await sleep(1000);

// 设置页：等 storage 同步 + 预览（storage 事件只有其他窗口改动才触发本页——本页自己改的需手动刷组件）
await evalJs(`location.hash = '#/settings'; location.reload(); void 0`);
await sleep(5500);
console.log('current label:', await evalJs(`document.querySelector('[data-role=pet-current]')?.textContent`));
console.log('preview canvas (main):', await evalJs(`!!document.querySelector('[data-role=pet-preview] canvas')`));
console.log('preview error hint:', await evalJs(`document.querySelector('[data-role=pet-preview] .pet-preview-hint')?.textContent?.slice(0, 80) || null`));
const shot1 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/custom-04-settings-fixed.png', Buffer.from(shot1.data, 'base64'));

// 桌宠窗
const l2 = await (await fetch('http://localhost:9223/json')).json();
const pet = l2.find((t) => t.url.includes('#pet'));
const ws2 = new WebSocket(pet.webSocketDebuggerUrl);
let id2 = 0;
const pending2 = new Map();
const send2 = (method, params = {}) => new Promise((resolve) => {
  const m = ++id2;
  pending2.set(m, { resolve });
  ws2.send(JSON.stringify({ id: m, method, params }));
});
ws2.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending2.has(msg.id)) {
    pending2.get(msg.id).resolve(msg.result);
    pending2.delete(msg.id);
  }
};
await new Promise((r) => { ws2.onopen = r; });
await sleep(3500);
console.log('pet state:', await send2('Runtime.evaluate', {
  expression: `JSON.stringify({ err: !!document.querySelector('.pet-error'), canvas: !!document.querySelector('.pet-stage canvas') })`,
  returnByValue: true,
}).then((r) => r.result.value));
const shot2 = await send2('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/custom-05-pet-fixed.png', Buffer.from(shot2.data, 'base64'));
ws2.close();
ws.close();
process.exit(0);
