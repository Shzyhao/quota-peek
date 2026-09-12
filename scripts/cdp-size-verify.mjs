// 验证菜单「换装」循环切换 + 截取缩小后的桌宠截图
const fs = await import('node:fs');
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result.value;
};
await sleep(3500);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/pet-size-after.png', Buffer.from(shot.data, 'base64'));
console.log('after shot saved');

// 菜单「换装」= 切下一套：开菜单 → 点换装项 → 菜单关闭且皮肤变化
await evalJs(`document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
await sleep(250);
const beforeSkin = await evalJs(`localStorage.getItem('mqc.pet.skin') || '0default'`);
await evalJs(`document.querySelector('[data-menu=skins]').click()`);
await sleep(4500);
const afterSkin = await evalJs(`localStorage.getItem('mqc.pet.skin') || '0default'`);
console.log('menu-skins cycle:', await evalJs(`JSON.stringify({ before: '${beforeSkin}', after: '${afterSkin}', menuHidden: document.querySelector('.pet-menu').hidden, err: !!document.querySelector('.pet-error') })`));
const shot2 = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('shots/pet-size-after-cycled.png', Buffer.from(shot2.data, 'base64'));
await evalJs(`localStorage.setItem('mqc.pet.skin','0default')`);
ws.close();
process.exit(0);
