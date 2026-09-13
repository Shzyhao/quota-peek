// 探测运行中的桌宠窗实际加载的 bundle 是否包含回退逻辑
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
const expr = `(async () => {
  const html = await (await fetch(location.href)).text();
  const files = [...new Set(html.match(/assets\\/index-[A-Za-z0-9_-]+\\.js/g) || [])];
  const out = [];
  for (const f of files) {
    const js = await (await fetch(f)).text();
    out.push(f + ':' + (js.includes('自定义形象不可用') ? 'NEW' : 'OLD'));
  }
  return out.join(', ') || 'no bundles found';
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('served:', r.result?.value, r.exceptionDetails ? JSON.stringify(r.exceptionDetails).slice(0, 200) : '');
ws.close();
process.exit(0);
