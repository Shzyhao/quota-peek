// 收尾验证：日志状态 / 调度恢复 / 桌宠播报气泡 / 截图
const list = await (await fetch('http://localhost:9223/json')).json();
const pages = list.filter((t) => t.type === 'page');
const mainTarget = pages.find((p) => !/#(pet|mini|ball|panel-)/.test(p.url));
const petTarget = pages.find((p) => p.url.includes('#pet'));

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  return new Promise((r) => { ws.onopen = r; }).then(() => ({ send, close: () => ws.close() }));
}
async function evalRaw(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result.value;
}

const main = await connect(mainTarget);

// 最近一条日志：凭据管理器密钥的查询是否成功
const lastLog = await evalRaw(main, `JSON.stringify((JSON.parse(localStorage.getItem('mqc.logs')||'[]')).at(-1))`);
console.log('LAST-LOG:', lastLog);

// 确认调度已恢复为用户原设置（0 = 关闭）
const schedCheck = await evalRaw(main, `JSON.stringify((async () => {
  const s = JSON.parse(localStorage.getItem('mqc.settings') || '{}');
  return { autoRefreshMinutes: s.autoRefreshMinutes ?? 0, alertMethod: s.alertMethod };
})())`);
console.log('SETTINGS:', schedCheck);

// 桌宠播报 + 截图
if (petTarget) {
  const emitted = await evalRaw(main, `JSON.stringify(globalThis.__TAURI__.event.emit('pet-speak', {
    lines: ['CDP 测试供应商：余额过低（¥5.00）', '第二家：本周用量已达 92%'],
    recoveries: ['恢复测试账户'],
  }))`);
  console.log('PET-SPEAK emitted:', emitted);
  await new Promise((r) => setTimeout(r, 1000));
  const pet = await connect(petTarget);
  const bubble = await evalRaw(pet, `JSON.stringify({
    visible: !document.querySelector('.pet-bubble')?.hidden,
    text: (document.querySelector('.pet-bubble')?.textContent || '').slice(0, 100),
  })`);
  console.log('PET-BUBBLE:', bubble);
  const { writeFileSync } = await import('node:fs');
  const shot = await pet.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('shots/verify-pet-bubble.png', Buffer.from(shot.data, 'base64'));
  console.log('SAVED: shots/verify-pet-bubble.png');
  pet.close();
} else {
  console.log('PET-TARGET: 桌宠窗未开启');
}

// 主窗截图
const { writeFileSync } = await import('node:fs');
const mainShot = await main.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('shots/verify-main.png', Buffer.from(mainShot.data, 'base64'));
console.log('SAVED: shots/verify-main.png');
main.close();
process.exit(0);
