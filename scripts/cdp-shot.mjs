// CDP 验证脚本：连接 WebView2 调试端口，检查 #pet 页渲染状态并截图
// 用法：node scripts/cdp-shot.mjs <targetUrl片段> <输出png>
const [,, urlPart, outPng] = process.argv;
const list = await (await fetch('http://localhost:9223/json')).json();
const target = list.find((t) => t.type === 'page' && t.url.includes(urlPart));
if (!target) { console.error('target not found:', urlPart, JSON.stringify(list.map((t) => t.url))); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};

await new Promise((r) => { ws.onopen = r; });

// 页面状态检查
const state = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    url: location.href,
    petMode: document.documentElement.classList.contains('pet-mode'),
    hasCanvas: !!document.querySelector('.pet-stage canvas'),
    coreLoaded: !!globalThis.Live2DCubismCore,
    hasInput: !!document.querySelector('.pet-input-bar input'),
    errorEl: document.querySelector('.pet-error')?.textContent || null,
  })`,
  returnByValue: true,
});
console.log('STATE:', state.result.value);

// 截图（合成器路径，透明内容也能拍到）
const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
console.log('SAVED:', outPng);
ws.close();
process.exit(0);
