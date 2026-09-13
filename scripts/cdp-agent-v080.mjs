// v0.8.0 E2E：⚡ 只读自动批准 + 批准整条链（真模型）
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

// 准备：开 Agent + ⚡ 只读自动批准
await ev(`location.hash = "#/chat"; location.reload()`);
await new Promise((r) => setTimeout(r, 2500));
console.log('SETUP:', await ev(`(async () => {
  const t = document.querySelector("[data-role=chat-agent-toggle]");
  if (!t.classList.contains("active")) t.click();
  const ro = document.querySelector("[data-role=agent-readonly-toggle]");
  if (ro.hidden) return "ro-hidden(坏)";
  if (!ro.classList.contains("active")) ro.click();
  return JSON.stringify({ agent: t.classList.contains("active"), autoRo: ro.classList.contains("active") });
})()`));

// 1. 只读自动批准：问时间 → 不应出现确认卡，直接出 ⚡ 结果卡与回答
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "现在几点了？"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 22000));
console.log('AUTO-READONLY:', await ev(`(function(){
  var cards = document.querySelectorAll(".chat-tool-card");
  var texts = document.querySelectorAll(".chat-bubble .chat-text");
  return JSON.stringify({
    pendingCard: !!document.querySelector(".chat-tool-card.pending"),
    toolCards: cards.length,
    anyAuto: [...cards].some(function(c){ return c.textContent.includes("⚡"); }),
    lastBubble: texts.length ? texts[texts.length-1].textContent.slice(0, 80) : null
  });
})()`));

// 2. 链式：写文件 + 读回（两个工具）→ 第一卡批准整条链 → 后续不再挂起
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "把「链式验证OK」写入文件 D:/agent-chain-test.txt，然后读取那个文件告诉我内容"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 12000));
const cardState = await ev(`(function(){ var c = document.querySelector(".chat-tool-card.pending"); return JSON.stringify({ pending: !!c, head: c ? c.querySelector(".chat-tool-head").textContent.trim().slice(0, 60) : null }); })()`);
console.log('CHAIN-CARD:', cardState);
writeFileSync('shots/v080-chain-card.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
console.log('APPROVE-CHAIN:', await ev(`(function(){ var b = document.querySelector("[data-role=agent-chain]"); if (!b) return "no-btn"; b.click(); return "chain-approved"; })()`));
await new Promise((r) => setTimeout(r, 30000));
console.log('CHAIN-RESULT:', await ev(`(function(){
  var cards = [...document.querySelectorAll(".chat-tool-card")];
  var texts = document.querySelectorAll(".chat-bubble .chat-text");
  return JSON.stringify({
    pendingLeft: !!document.querySelector(".chat-tool-card.pending"),
    toolCards: cards.length,
    anyAuto: cards.some(function(c){ return c.textContent.includes("⚡"); }),
    lastBubble: texts.length ? texts[texts.length-1].textContent.slice(0, 100) : null,
    sendVisible: !document.querySelector("[data-role=chat-send]").hidden
  });
})()`));
ws.close(); process.exit(0);
