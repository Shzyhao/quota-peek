// 探测菜单点击事件流：capture/bubble 两个阶段记录，定位事件被谁拦截
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
  }
};
await new Promise((r) => { ws.onopen = r; });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

// 关菜单（若开着），重开 actions 视图，装探针
await evalJs(`document.querySelector('.pet-menu').hidden = true; void 0`);
await evalJs(`document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await sleep(300);
await evalJs(`(function(){
  window.__evts = [];
  const rec = (tag) => (e) => window.__evts.push([tag, e.target.tagName, e.target.dataset?.menu || e.target.dataset?.skin || (e.target.className||'').slice(0,16), 'connected=' + e.target.isConnected]);
  document.addEventListener('click', rec('cap'), true);
  document.addEventListener('click', rec('bub'), false);
  return 'probes on, menu view=' + (document.querySelector('.pet-skin-grid') ? 'skins' : 'actions');
})()`);
// 点换装项
await evalJs(`document.querySelector('[data-menu=skins]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await sleep(600);
console.log('events:', await evalJs(`JSON.stringify(window.__evts)`));
console.log('after:', await evalJs(`JSON.stringify({ menuHidden: document.querySelector('.pet-menu').hidden, view: document.querySelector('.pet-skin-grid') ? 'skins' : 'actions', skin: localStorage.getItem('mqc.pet.skin') })`));
ws.close();
process.exit(0);
