// Agent 拒绝路径 E2E：提议高危写文件 → 用户拒绝 → 模型优雅收场
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.filter((t) => t.type === 'page').find((p) => !/#(pet|mini|ball|panel-)/.test(p.url));
const ws = new WebSocket(main.webSocketDebuggerUrl);
let i = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++i; pend.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };

await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "把「测试123」写入文件 D:/agent-deny-test.txt"; return "ok"; })()`);
await ev(`document.querySelector("[data-role=chat-send]").click()`);
await new Promise((r) => setTimeout(r, 9000));
const card = await ev(`(function(){ var c = document.querySelector(".chat-tool-card.pending"); return JSON.stringify({ present: !!c, danger: c ? c.className.includes("danger") : false, head: c ? c.querySelector(".chat-tool-head").textContent.trim().slice(0, 70) : null }); })()`);
console.log('DANGER-CARD:', card);
const { writeFileSync } = await import('node:fs');
writeFileSync('shots/v070-danger.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await ev(`document.querySelector("[data-role=agent-deny]").click()`);
await new Promise((r) => setTimeout(r, 18000));
const after = await ev(`(function(){ var b = document.querySelectorAll(".chat-bubble .chat-text"); return JSON.stringify({ last: b.length ? b[b.length - 1].textContent.slice(0, 130) : null, toolCards: document.querySelectorAll(".chat-tool-card").length, sendVisible: !document.querySelector("[data-role=chat-send]").hidden }); })()`);
console.log('AFTER-DENY:', after);
ws.close(); process.exit(0);
