// v0.5.0 真机验证：密钥迁移/凭据读写、后端调度、托盘命令、桌宠播报
// 前置：exe 已带 --remote-debugging-port=9223 启动，主窗与桌宠窗已加载
const list = await (await fetch('http://localhost:9223/json')).json();
const pages = list.filter((t) => t.type === 'page');
console.log('TARGETS:', pages.map((p) => p.url).join(' | '));

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

async function evalJson(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  return JSON.parse(res.result.value);
}

const mainTarget = pages.find((p) => !/#(pet|mini|ball|panel-)/.test(p.url)) || pages[0];
const petTarget = pages.find((p) => p.url.includes('#pet'));
const main = await connect(mainTarget);

// —— 1. 桌面环境与密钥迁移 ——
const mig = await evalJson(main, `(async () => {
  const invoke = globalThis.__TAURI__.core.invoke;
  const list = JSON.parse(localStorage.getItem('mqc.providers') || '[]');
  const withKey = list.filter(p => p.hasSecret);
  const plaintext = list.filter(p => p.apiKey || p.apiSecret);
  // 逐个确认凭据管理器里真的有
  const checks = [];
  for (const p of withKey) checks.push({ id: p.id.slice(0, 8), has: await invoke('quota_secret_has', { providerId: p.id }) });
  const keyringReadable = [];
  for (const p of withKey.slice(0, 2)) {
    const s = await invoke('quota_secret_get', { providerId: p.id });
    keyringReadable.push({ id: p.id.slice(0, 8), keyPrefix: (s?.apiKey || '').slice(0, 3), hasSecretField: !!(s?.apiSecret) });
  }
  return JSON.stringify({ total: list.length, hasSecret: withKey.length, plaintextLeft: plaintext.length, checks, keyringReadable });
})()`);
console.log('MIGRATION:', mig);

// —— 2. 凭据命令往返（测试条目，最后清理）——
const roundtrip = await evalJson(main, `(async () => {
  const invoke = globalThis.__TAURI__.core.invoke;
  const tid = 'cdp-test-entry';
  await invoke('quota_secret_set', { providerId: tid, apiKey: 'sk-test-abc', apiSecret: 'sec-xyz' });
  const got = await invoke('quota_secret_get', { providerId: tid });
  const has = await invoke('quota_secret_has', { providerId: tid });
  await invoke('quota_secret_delete', { providerId: tid });
  const after = await invoke('quota_secret_has', { providerId: tid });
  return JSON.stringify({ got, has, deletedOk: after === false });
})()`);
console.log('SECRET-ROUNDTRIP:', roundtrip);

// —— 3. 托盘命令（32×32 纯色 RGBA）——
const tray = await evalJson(main, `JSON.stringify((async () => {
  const invoke = globalThis.__TAURI__.core.invoke;
  const rgba = Array.from({ length: 32 * 32 * 4 }, (_, i) => (i % 4 === 3 ? 255 : 34));
  await invoke('update_tray_status', { rgba, width: 32, height: 32, tooltip: '桌看 · CDP 验证' });
  return 'update_tray_status ok';
})())`);
console.log('TRAY:', tray);

// —— 4. 后端调度：记下当前设置，设 1 分钟间隔 ——
const sched = await evalJson(main, `(async () => {
  const invoke = globalThis.__TAURI__.core.invoke;
  const s = JSON.parse(localStorage.getItem('mqc.settings') || '{}');
  await invoke('set_refresh_schedule', { enabled: true, intervalMinutes: 1 });
  const before = JSON.parse(localStorage.getItem('mqc.logs') || '[]').length;
  return JSON.stringify({ savedAutoRefresh: s.autoRefreshMinutes ?? 0, logsBefore: before, now: Date.now() });
})()`);
console.log('SCHED-ARM:', sched);

// 等 70 秒让后端时钟触发
await new Promise((r) => setTimeout(r, 70000));

const schedFired = await evalJson(main, `JSON.stringify({
  logsAfter: JSON.parse(localStorage.getItem('mqc.logs') || '[]').length,
  lastQueryTime: (JSON.parse(localStorage.getItem('mqc.providers') || '[]').map(p => p.lastQuery?.time).filter(Boolean).sort().at(-1)) || null,
  now: Date.now(),
})`);
console.log('SCHED-FIRED:', schedFired);

// —— 5. 恢复用户原有刷新间隔设置 ——
const restored = await evalJson(main, `(async () => {
  const invoke = globalThis.__TAURI__.core.invoke;
  const s = JSON.parse(localStorage.getItem('mqc.settings') || '{}');
  await invoke('set_refresh_schedule', { enabled: (s.autoRefreshMinutes ?? 0) > 0, intervalMinutes: s.autoRefreshMinutes ?? 0 });
  return 'restored to ' + (s.autoRefreshMinutes ?? 0) + 'min';
})()`);
console.log('SCHED-RESTORE:', restored);

// —— 6. 桌宠播报：主窗 emit → 桌宠窗气泡 ——
await evalJson(main, `JSON.stringify(globalThis.__TAURI__.event.emit('pet-speak', {
  lines: ['CDP 测试供应商：余额过低（5.00）', '第二家：本周用量已达 92%'],
  recoveries: ['恢复测试账户'],
}))`);
console.log('PET-SPEAK emitted');

if (petTarget) {
  await new Promise((r) => setTimeout(r, 800));
  const pet = await connect(petTarget);
  const bubble = await evalJson(pet, `JSON.stringify({
    visible: !document.querySelector('.pet-bubble')?.hidden,
    text: (document.querySelector('.pet-bubble')?.textContent || '').slice(0, 80),
  })`);
  console.log('PET-BUBBLE:', bubble);
  const shot = await pet.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync('shots/verify-pet-bubble.png', Buffer.from(shot.data, 'base64'));
  console.log('SAVED: shots/verify-pet-bubble.png');
  pet.close();
} else {
  console.log('PET-TARGET: 桌宠窗未开启（跳过气泡检查）');
}

// 主窗截图（验收设置页/卡片密钥行）
const mainShot = await main.send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync('shots/verify-main.png', Buffer.from(mainShot.data, 'base64'));
console.log('SAVED: shots/verify-main.png');

main.close();
process.exit(0);
