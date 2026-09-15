// v0.10.0 发布前全模块回归：对话面板（无配置）/ 语音对话 / 额度速览固定模式 /
// 日程面板 / 文件分析面板 / 面板互斥 / 主窗对话页配置仍在 / 桌宠菜单
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { writeFileSync } = await import('node:fs');
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const getTargets = async () => (await (await fetch('http://localhost:9223/json')).json()).filter((t) => t.type === 'page');
const findTarget = async (part) => (await getTargets()).find((t) => t.url.includes(part));

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id; pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  return new Promise((r) => { ws.onopen = r; }).then(() => ({ send, close: () => { try { ws.close(); } catch {} } }));
}
async function evalJson(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) return { __err: JSON.stringify(res.exceptionDetails).slice(0, 200) };
  try { return JSON.parse(res.result?.value); } catch { return { __err: 'empty' }; }
}
async function withPage(part, fn) {
  const t = part === '__main__' ? (await getTargets()).find((t) => !/#(pet|mini|ball|panel-)/.test(t.url)) : await findTarget(part);
  if (!t) return fn(null);
  const cdp = await connect(t);
  try { return await fn(cdp); } finally { cdp.close(); }
}
const vis = `JSON.stringify((async () => ({ v: await globalThis.__TAURI__.window.getCurrentWindow().isVisible() }))())`;

// 0 就绪
let ready = false;
for (let i = 0; i < 20 && !ready; i++) {
  await sleep(2000);
  ready = await withPage('__main__', async (m) => (await evalJson(m, `JSON.stringify({ b: !!document.querySelector('.sidebar') })`)).b === true) && !!(await findTarget('#pet'));
}
check('应用就绪', ready === true);

// 1 桌宠菜单 → 对话面板：无配置入口，有会话/消息/输入/麦克风
await withPage('#pet', async (pet) => {
  await evalJson(pet, `JSON.stringify(globalThis.__TAURI__.event.emit('pet-panel', 'chat'))`);
});
await sleep(2800);
let chatUi = await withPage('#panel-chat', async (c) => await evalJson(c, `(async () => JSON.stringify({
  visible: await globalThis.__TAURI__.window.getCurrentWindow().isVisible(),
  toggleBtn: !!document.querySelector('[data-role="chat-config-toggle"]'),
  testBtn: !!document.querySelector('[data-role="chat-test"]'),
  configHidden: (() => { const el = document.querySelector('.chat-config'); return !el || el.hidden; })(),
  messages: !!document.querySelector('[data-role="chat-messages"]'),
  input: !!document.querySelector('[data-role="chat-input"]'),
  mic: !!document.querySelector('[data-role="chat-mic"]'),
  session: !!document.querySelector('[data-role="chat-session"]'),
  profileSel: !!document.querySelector('[data-role="chat-profile"]'),
}))()`));
check('对话面板无配置入口', chatUi.visible === true && chatUi.toggleBtn === false && chatUi.testBtn === false && chatUi.configHidden === true,
  `toggle=${chatUi.toggleBtn} test=${chatUi.testBtn} configHidden=${chatUi.configHidden}`);
check('对话面板内容区完整', chatUi.messages && chatUi.input && chatUi.mic && chatUi.session && chatUi.profileSel);
let shot = await withPage('#panel-chat', (c) => c.send('Page.captureScreenshot', { format: 'png' }));
writeFileSync('shots/v0100-panel-chat.png', Buffer.from(shot.data, 'base64'));

// 2 语音对话入口：同面板保持显示（force show）
await withPage('#pet', async (pet) => {
  await evalJson(pet, `JSON.stringify(globalThis.__TAURI__.event.emit('pet-voice-chat', 'chat'))`);
});
await sleep(1500);
const voiceUi = await withPage('#panel-chat', async (c) => await evalJson(c, vis));
check('语音对话入口保持面板显示', voiceUi.v === true);

// 3 额度速览：固定模式迷你窗出现并保持
await withPage('#pet', async (pet) => {
  await evalJson(pet, `JSON.stringify(globalThis.__TAURI__.event.emit('pet-quota'))`);
});
await sleep(3000);
const mini = await findTarget('#mini');
let miniState = mini ? await withPage('#mini', async (c) => await evalJson(c, `(async () => JSON.stringify({
  visible: await globalThis.__TAURI__.window.getCurrentWindow().isVisible(),
  rows: document.body.innerHTML.length,
  hasContent: document.body.textContent.length > 20 }))()`)) : { visible: false };
check('额度速览迷你窗出现', !!mini && miniState.visible === true, JSON.stringify(miniState).slice(0, 120));
shot = await withPage('#mini', (c) => c.send('Page.captureScreenshot', { format: 'png' }));
writeFileSync('shots/v0100-mini.png', Buffer.from(shot.data, 'base64'));

// 4 日程面板 + 互斥（打开日程收起对话面板）
await withPage('#pet', async (pet) => {
  await evalJson(pet, `JSON.stringify(globalThis.__TAURI__.event.emit('pet-panel', 'schedule'))`);
});
await sleep(2500);
const sch = await withPage('#panel-schedule', async (c) => await evalJson(c, `(async () => JSON.stringify({
  v: await globalThis.__TAURI__.window.getCurrentWindow().isVisible(),
  cells: document.querySelectorAll('.calendar-cell').length }))()`));
const chatAfterSch = await withPage('#panel-chat', async (c) => await evalJson(c, vis));
check('日程面板打开', sch.v === true && sch.cells === 42);
check('面板互斥：日程打开后对话面板收起', chatAfterSch.v === false);

// 5 文件分析面板
await withPage('#pet', async (pet) => {
  await evalJson(pet, `JSON.stringify(globalThis.__TAURI__.event.emit('pet-panel', 'analysis'))`);
});
await sleep(2500);
const ana = await withPage('#panel-analysis', async (c) => await evalJson(c, `(async () => JSON.stringify({
  v: await globalThis.__TAURI__.window.getCurrentWindow().isVisible(),
  hasInput: !!document.querySelector('input, textarea, [class*="analysis"]') }))()`));
check('文件分析面板打开', ana.v === true, JSON.stringify(ana).slice(0, 120));

// 6 主窗对话页：配置入口仍在（回归）
await withPage('__main__', async (m) => {
  await evalJson(m, `(() => { location.hash = '#/chat'; return 1; })()`);
});
await sleep(1200);
const mainChat = await withPage('__main__', async (m) => await evalJson(m, `JSON.stringify({
  toggleBtn: !!document.querySelector('[data-role="chat-config-toggle"]'),
  testBtn: !!document.querySelector('[data-role="chat-test"]') })`));
check('主窗对话页配置入口仍在', mainChat.toggleBtn === true && mainChat.testBtn === true);
await withPage('__main__', async (m) => { await evalJson(m, `(() => { location.hash = '#/home'; return 1; })()`); });

// 7 汇总
const pass = results.filter(Boolean).length;
console.log(`\nRESULT: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
