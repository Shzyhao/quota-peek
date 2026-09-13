// 捕获菜单 handler 的运行时异常 + 测试网格路径（data-skin 直点）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9223/json')).json();
const pet = list.find((t) => t.url.includes('#pet'));
const ws = new WebSocket(pet.webSocketDebuggerUrl);
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
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params.args.map((a) => a.value || a.description || '').join(' ');
    if (t.includes('pet') || t.toLowerCase().includes('换') || t.toLowerCase().includes('error')) console.log('[console]', t.slice(0, 260));
  }
};
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

await evalJs(`(function(){
  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push(String(e.message).slice(0, 200)));
  document.querySelector('.pet-menu').hidden = true;
  return 'err hooks on';
})()`);

// 1) actions 菜单点换装
await evalJs(`document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await sleep(300);
console.log('errs after open:', await evalJs(`JSON.stringify(window.__errs)`));
await evalJs(`document.querySelector('[data-menu=skins]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await sleep(500);
console.log('errs after skins-click:', await evalJs(`JSON.stringify(window.__errs)`));
console.log('state:', await evalJs(`JSON.stringify({ menuHidden: document.querySelector('.pet-menu').hidden, view: document.querySelector('.pet-skin-grid') ? 'skins' : 'actions', skin: localStorage.getItem('mqc.pet.skin'), bubble: document.querySelector('.pet-bubble')?.textContent?.slice(0, 40) || null })`));

// 2) 网格路径验证：开 grid，点一个 data-skin
await evalJs(`document.querySelector('[data-role=pet-skin]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await sleep(300);
const gridSkins = await evalJs(`document.querySelectorAll('.pet-skin-grid [data-skin]').length`);
console.log('grid skins:', gridSkins);
if (gridSkins > 0) {
  await evalJs(`document.querySelector('[data-skin=xmas]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(4500);
  console.log('after grid xmas:', await evalJs(`JSON.stringify({ skin: localStorage.getItem('mqc.pet.skin'), errs: window.__errs, menuHidden: document.querySelector('.pet-menu').hidden })`));
}
ws.close();
process.exit(0);
