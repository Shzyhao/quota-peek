// 复位皮肤到默认并确认桌宠正常
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9223/json')).json();
const pet = list.find((t) => t.url.includes('#pet'));
if (!pet) { console.log('pet window missing'); process.exit(1); }
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result.value;
};
await sleep(3000);
// 点两次换装把皮肤循环到默认（当前是新年）
const cur = await evalJs(`localStorage.getItem('mqc.pet.skin') || '0default'`);
const idx = ['0default', 'bls', 'bls-summer', 'bls-winer', 'cba-normal', 'cba-super', 'deluxe', 'lover', 'newyear'].indexOf(cur);
for (let i = 0; i < (10 - idx) % 10; i++) {
  await evalJs(`document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(250);
  await evalJs(`document.querySelector('[data-menu=skins]').click()`);
  await sleep(3200);
}
console.log('final:', await evalJs(`JSON.stringify({ skin: localStorage.getItem('mqc.pet.skin'), err: !!document.querySelector('.pet-error'), canvas: !!document.querySelector('.pet-stage canvas') })`));
ws.close();
process.exit(0);
