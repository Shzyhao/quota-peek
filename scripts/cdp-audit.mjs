// UI 体检截图：遍历主窗各页 + 桌宠菜单 + 功能弹窗 + 迷你窗，存 shots/audit-*.png
// 用法：node --use-system-ca scripts/cdp-audit.mjs
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180/') && !t.url.includes('#pet') && !t.url.includes('#panel') && !t.url.includes('#mini'));

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const m = ++id;
    pending.set(m, { resolve, reject });
    ws.send(JSON.stringify({ id: m, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg.result);
    }
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return { ws, opened, send, close: () => { ws.close(); } };
}

const shot = async (send, name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`shots/audit-${name}.png`, Buffer.from(s.data, 'base64'));
  console.log('shot', name);
};

// —— 主窗各页 ——
{
  const conn = connect(main);
  await conn.opened;
  const { send, close } = conn;
  await send('Page.enable');
  const views = ['home', 'chat', 'analysis', 'overview', 'providers', 'logs', 'settings'];
  for (const v of views) {
    await send('Runtime.evaluate', { expression: `location.hash = '#/${v}'; void 0` });
    await sleep(v === 'chat' || v === 'analysis' ? 1500 : 900);
    await shot(send, `main-${v}`);
  }
  close();
}

// —— 桌宠窗：常态 + 菜单 + 换装 ——
{
  const pet = list.find((t) => t.url.includes('#pet'));
  const petConn = connect(pet);
  await petConn.opened;
  const { send, close } = petConn;
  await send('Page.enable');
  await sleep(600);
  await shot(send, 'pet-idle');
  await send('Runtime.evaluate', { expression: `document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true })); void 0` });
  await sleep(400);
  await shot(send, 'pet-menu');
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-menu=skins]')?.click(); void 0` });
  await sleep(400);
  await shot(send, 'pet-skins');
  // 切回默认皮肤状态
  await send('Runtime.evaluate', { expression: `document.querySelector('.pet-menu')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); void 0` });
  close();
}

// —— 功能弹窗（先触发打开再截） ——
{
  const pet = list.find((t) => t.url.includes('#pet'));
  const petConn = connect(pet);
  await petConn.opened;
  const { send, close } = petConn;
  await send('Runtime.evaluate', { expression: `document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true })); void 0` });
  await sleep(250);
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-menu=analysis]')?.click(); void 0` });
  await sleep(2500);
  close();
}
{
  const l2 = await (await fetch('http://localhost:9223/json')).json();
  const panelA = l2.find((t) => t.url.includes('panel-analysis'));
  if (panelA) {
    const paConn = connect(panelA);
    await paConn.opened;
    const { send, close } = paConn;
    await sleep(500);
    await shot(send, 'panel-analysis');
    close();
  } else console.log('panel-analysis missing');
}
{
  // 打开对话面板
  const pet = list.find((t) => t.url.includes('#pet'));
  const petConn = connect(pet);
  await petConn.opened;
  const { send, close } = petConn;
  await send('Runtime.evaluate', { expression: `document.querySelector('.pet-stage').dispatchEvent(new MouseEvent('click', { bubbles: true })); void 0` });
  await sleep(250);
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-menu=chat]')?.click(); void 0` });
  await sleep(2000);
  close();
}
{
  const l2 = await (await fetch('http://localhost:9223/json')).json();
  const panelC = l2.find((t) => t.url.includes('panel-chat'));
  if (panelC) {
    const pcConn = connect(panelC);
    await pcConn.opened;
    const { send, close } = pcConn;
    await sleep(500);
    await shot(send, 'panel-chat');
    close();
  } else console.log('panel-chat missing');
}
console.log('audit done');
process.exit(0);
