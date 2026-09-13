// 清理：解除挂起 + 清会话
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.filter((t) => t.type === 'page').find((p) => !/#(pet|mini|ball|panel-)/.test(p.url));
const ws = new WebSocket(main.webSocketDebuggerUrl);
let i = 0;
const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++i; pend.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const r = await send('Runtime.evaluate', { expression: `(async function(){
  var ch = new window.__TAURI__.Channel();
  ch.onmessage = function(){};
  var out = "";
  try { await window.__TAURI__.core.invoke("agent_resolve", { approved: false, approveChain: false, auto: false, onEvent: ch }); out = "resolved"; }
  catch (e) { out = "resolve-err: " + e; }
  var raw = JSON.parse(localStorage.getItem("mqc.chat.sessions") || "[]");
  var act = JSON.parse(localStorage.getItem("mqc.chat.activeSession") || "null");
  localStorage.setItem("mqc.chat.sessions", JSON.stringify(raw.map(function(s){ return s.id === act ? Object.assign({}, s, { messages: [], title: "新的对话" }) : s; })));
  localStorage.setItem("mqc.chat.agent", "0");
  return out;
})()`, returnByValue: true, awaitPromise: true });
console.log('CLEANUP:', r.result.value);
ws.close(); process.exit(0);
