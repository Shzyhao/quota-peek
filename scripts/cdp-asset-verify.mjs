// 验证正斜杠 asset URL 的相对资源解析
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
const r = await evalJs(`(async () => {
  const abs = JSON.parse(localStorage.getItem('mqc.pet.customModel')).absPath || null;
  // absPath 未存；从 url 反解不可靠，直接重新构造已知路径
  const absPath = 'C:\\\\Users\\\\26892\\\\AppData\\\\Roaming\\\\com.modelquota.desktop\\\\pet-models\\\\tmp-mymodel-haru\\\\haru_greeter_t03.model3.json';
  const sample = globalThis.__TAURI__.core.convertFileSrc('X');
  const base = sample.slice(0, sample.lastIndexOf('/') + 1);
  const url = base + encodeURIComponent(absPath).replaceAll('%5C', '/').replaceAll('%3A', ':');
  const out = { url: url.slice(0, 130) };
  try { const r1 = await fetch(url); out.json = r1.status; } catch (e) { out.json = 'ERR ' + e.message; }
  const moc = url.replace(/[^/]+$/, '') + 'haru_greeter_t03.moc3';
  try { const r2 = await fetch(moc); out.moc = r2.status + ' len=' + (await r2.blob()).length; } catch (e) { out.moc = 'ERR ' + e.message; }
  const tex = url.replace(/[^/]+$/, '') + 'haru_greeter_t03.2048/texture_00.png';
  try { const r3 = await fetch(tex); out.tex = r3.status; } catch (e) { out.tex = 'ERR ' + e.message; }
  return JSON.stringify(out);
})()`);
console.log(r);
ws.close();
process.exit(0);
