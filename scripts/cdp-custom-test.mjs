// 端到端验证：设置页形象卡 + 自定义形象导入 + 桌宠同步
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
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[page-exception]', JSON.stringify(msg.params.exceptionDetails).slice(0, 250));
  }
};
await new Promise((r) => { ws.onopen = r; });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};
await sleep(2500);

// 1) 设置页形象卡
await evalJs(`location.hash = '#/settings'; void 0`);
await sleep(1200);
console.log('card present:', await evalJs(`!!document.querySelector('[data-role=pet-appearance]')`));
console.log('current label:', await evalJs(`document.querySelector('[data-role=pet-current]')?.textContent`));
await sleep(5000);
console.log('preview canvas:', await evalJs(`!!document.querySelector('[data-role=pet-preview] canvas')`));
const shot1 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/custom-01-settings.png', Buffer.from(shot1.data, 'base64'));

// 2) 导入（模拟用户选了文件夹）：直接调 Rust 命令
const srcDir = path.resolve('tmp-mymodel-haru');
const res = await evalJs(`globalThis.__TAURI__.core.invoke('pet_import_model', { src: ${JSON.stringify(srcDir)} }).catch(e => 'ERR:' + e)`);
console.log('import:', typeof res === 'string' ? res : JSON.stringify({ name: res.name, runtime: res.runtime }));

// 3) 激活自定义形象（与 petSettings 导入成功后的动作一致）
if (typeof res !== 'string') {
  const entry = { id: 'custom-test', name: res.name, url: `convertFileSrc:${res.abs_path}`, runtime: res.runtime };
  // url 需要 convertFileSrc 在页面内求值
  await evalJs(`(async () => {
    const { convertFileSrc } = globalThis.__TAURI__.core;
    const entry = { id: 'custom-test', name: ${JSON.stringify(res.name)}, url: convertFileSrc(${JSON.stringify(res.abs_path)}), runtime: ${JSON.stringify(res.runtime)} };
    localStorage.setItem('mqc.pet.customModels', JSON.stringify([entry]));
    localStorage.setItem('mqc.pet.customModel', JSON.stringify(entry));
  })()`);
  await sleep(4500); // storage 事件 → 桌宠窗重载（cubism2→4 会整窗 reload）
  console.log('active label:', await evalJs(`document.querySelector('[data-role=pet-current]')?.textContent`));
  await sleep(3000);
  console.log('preview canvas (custom):', await evalJs(`!!document.querySelector('[data-role=pet-preview] canvas')`));
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('shots/custom-02-active.png', Buffer.from(shot2.data, 'base64'));
}

// 4) 桌宠窗状态（180×220 + 是否加载自定义）
const l2 = await (await fetch('http://localhost:9223/json')).json();
const pet = l2.find((t) => t.url.includes('#pet'));
if (pet) {
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
  await sleep(2500);
  console.log('pet state:', await send2('Runtime.evaluate', {
    expression: `JSON.stringify({ err: !!document.querySelector('.pet-error'), canvas: !!document.querySelector('.pet-stage canvas'), skin: localStorage.getItem('mqc.pet.skin'), custom: localStorage.getItem('mqc.pet.customModel')?.slice(0, 60) })`,
    returnByValue: true,
  }).then((r) => r.result.value));
  const shot3 = await send2('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('shots/custom-03-pet.png', Buffer.from(shot3.data, 'base64'));
  ws2.close();
}
ws.close();
process.exit(0);
