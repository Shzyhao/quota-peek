// v0.8.0 复测②：强制模型调用只读工具，验证 ⚡ 标记渲染
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.filter((t) => t.type === 'page').find((p) => !/#(pet|mini|ball|panel-)/.test(p.url));
const ws = new WebSocket(main.webSocketDebuggerUrl);
let i = 0;
const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++i; pend.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
const { writeFileSync } = await import('node:fs');

await ev(`location.hash = "#/chat"; location.reload()`);
await new Promise((r) => setTimeout(r, 2500));
console.log('SETUP:', await ev(`(async () => {
  var t = document.querySelector("[data-role=chat-agent-toggle]");
  if (!t.classList.contains("active")) t.click();
  var ro = document.querySelector("[data-role=agent-readonly-toggle]");
  if (!ro.classList.contains("active")) ro.click();
  return "on";
})()`));

await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "请调用工具查询当前的精确时间，不要凭记忆回答"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 22000));
console.log('AUTO-MARK:', await ev(`(function(){ var cards = Array.from(document.querySelectorAll(".chat-tool-card")); var last = cards[cards.length - 1]; return JSON.stringify({ cards: cards.length, lastHasAuto: last ? last.textContent.indexOf("⚡") >= 0 : false, pending: !!document.querySelector(".chat-tool-card.pending"), lastBubble: (function(){ var b = document.querySelectorAll(".chat-bubble .chat-text"); return b.length ? b[b.length-1].textContent.slice(0, 60) : null; })() }); })()`));
writeFileSync('shots/v080-automark2.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

console.log('CLEANUP:', await ev(`(function(){
  var raw = JSON.parse(localStorage.getItem("mqc.chat.sessions") || "[]");
  var act = JSON.parse(localStorage.getItem("mqc.chat.activeSession") || "null");
  localStorage.setItem("mqc.chat.sessions", JSON.stringify(raw.map(function(s){ return s.id === act ? Object.assign({}, s, { messages: [], title: "新的对话" }) : s; })));
  localStorage.setItem("mqc.chat.agent", "0");
  localStorage.setItem("mqc.chat.agentAutoReadonly", "0");
  return "cleaned";
})()`));
ws.close(); process.exit(0);
