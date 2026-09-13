// 分步探测：点击→确认菜单开→测量 × 与首行按钮几何
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
await sleep(2500);

// 若已开则先关，保证从关→开
const wasOpen = await evalJs(`!document.querySelector('.pet-menu').hidden`);
if (wasOpen) await evalJs(`document.querySelector('.pet-menu-close')?.click()`);
await sleep(200);

await evalJs(`document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await sleep(400);
console.log('menu open?', await evalJs(`!document.querySelector('.pet-menu').hidden`));
console.log(await evalJs(`(function(){
  const menu = document.querySelector('.pet-menu');
  const close = document.querySelector('.pet-menu-close');
  const first = menu.querySelector('[data-menu=chat]');
  const mr = menu.getBoundingClientRect();
  const cr = close.getBoundingClientRect();
  const fr = first.getBoundingClientRect();
  const cs = getComputedStyle(close);
  return JSON.stringify({
    menuRect: { w: mr.width, h: mr.height, right: mr.right, top: mr.top },
    close: { w: cr.width, h: cr.height, cx: +( (cr.left + cr.right) / 2 ).toFixed(1), cy: +( (cr.top + cr.bottom) / 2 ).toFixed(1), top: cr.top, right: mr.right - cr.right },
    firstBtn: { w: fr.width, h: fr.height, top: fr.top, cy: +( (fr.top + fr.bottom) / 2 ).toFixed(1), right: fr.right },
    dy: +( (fr.top + fr.bottom) / 2 - (cr.top + cr.bottom) / 2 ).toFixed(1),
    dxCenterVsBtnTextEnd: +( fr.right - cr.right ).toFixed(1),
    closeFont: { size: cs.fontSize, lh: cs.lineHeight, family: cs.fontFamily.slice(0, 30) },
  });
})()`));
ws.close();
process.exit(0);
