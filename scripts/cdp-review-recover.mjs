// 循环解除叠加的挂起，验证 Agent 恢复可用
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.filter((t) => t.type === 'page').find((p) => !/#(pet|mini|ball|panel-)/.test(p.url));
const ws = new WebSocket(main.webSocketDebuggerUrl);
let i = 0;
const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++i; pend.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };

let resolved = 0;
for (let n = 0; n < 10; n++) {
  const r = await ev(`(async function(){
    try {
      var ch = new window.__TAURI__.core.Channel();
      ch.onmessage = function(){};
      await window.__TAURI__.core.invoke("agent_resolve", { approved: false, approveChain: false, auto: false, onEvent: ch });
      return "resolved";
    } catch (e) { return "none: " + e; }
  })()`);
  if (!r.startsWith('resolved')) { console.log('round', n, '→', r.slice(0, 60)); break; }
  resolved += 1;
  await new Promise((r2) => setTimeout(r2, 2500));
}
console.log('resolved count:', resolved);
const check = await ev(`(async function(){
  try {
    var ch = new window.__TAURI__.core.Channel();
    ch.onmessage = function(){};
    await window.__TAURI__.core.invoke("agent_send", { messages: [{ role: "user", content: "test" }], onEvent: ch });
    return "agent-send-ok(已恢复)";
  } catch (e) { return "still-stuck: " + e; }
})()`);
console.log('RECOVERY-CHECK:', check);

// 清掉这次 "test" 任务可能产生的挂起/会话
for (let n = 0; n < 10; n++) {
  const r = await ev(`(async function(){
    try {
      var ch = new window.__TAURI__.core.Channel();
      ch.onmessage = function(){};
      await window.__TAURI__.core.invoke("agent_resolve", { approved: false, approveChain: false, auto: false, onEvent: ch });
      return "resolved";
    } catch (e) { return "none"; }
  })()`);
  if (!r.startsWith('resolved')) break;
  await new Promise((r2) => setTimeout(r2, 1500));
}
await ev(`(function(){
  var raw = JSON.parse(localStorage.getItem("mqc.chat.sessions") || "[]");
  var act = JSON.parse(localStorage.getItem("mqc.chat.activeSession") || "null");
  localStorage.setItem("mqc.chat.sessions", JSON.stringify(raw.map(function(s){ return s.id === act ? Object.assign({}, s, { messages: [], title: "新的对话" }) : s; })));
  localStorage.setItem("mqc.chat.agent", "0");
  return "cleaned";
})()`);
ws.close(); process.exit(0);
