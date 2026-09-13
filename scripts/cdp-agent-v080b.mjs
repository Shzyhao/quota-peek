// v0.8.0 复测：⚡ 自动批准标记渲染 + 清理测试数据
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
  if (ro.hidden) return "ro-hidden(bad)";
  if (!ro.classList.contains("active")) ro.click();
  return JSON.stringify({ agent: t.classList.contains("active"), autoRo: ro.classList.contains("active") });
})()`));

await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "今天星期几？"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 20000));
console.log('AUTO-MARK:', await ev(`(function(){ var cards = Array.from(document.querySelectorAll(".chat-tool-card")); return JSON.stringify({ cards: cards.length, hasAutoMark: cards.some(function(c){ return c.textContent.indexOf("⚡") >= 0; }), pending: !!document.querySelector(".chat-tool-card.pending") }); })()`));
writeFileSync('shots/v080-automark.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// 清理测试数据：清空当前会话消息 + 恢复默认设置
console.log('CLEANUP:', await ev(`(function(){
  var raw = JSON.parse(localStorage.getItem("mqc.chat.sessions") || "[]");
  var act = JSON.parse(localStorage.getItem("mqc.chat.activeSession") || "null");
  localStorage.setItem("mqc.chat.sessions", JSON.stringify(raw.map(function(s){ return s.id === act ? Object.assign({}, s, { messages: [], title: "新的对话" }) : s; })));
  localStorage.setItem("mqc.chat.agent", "0");
  localStorage.setItem("mqc.chat.agentAutoReadonly", "0");
  return "cleaned";
})()`));
ws.close(); process.exit(0);
