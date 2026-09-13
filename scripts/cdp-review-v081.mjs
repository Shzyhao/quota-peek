// v0.8.1 回归验证：P1-1 卡死修复 / P1-2 链中危险工具降级确认
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
await ev(`(function(){ var t = document.querySelector("[data-role=chat-agent-toggle]"); if (!t.classList.contains("active")) t.click(); return "agent-on"; })()`);

// ===== P1-1 回归：挂起未理睬 → 重载 → 再发消息应正常执行（不再卡死） =====
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "把「x」写入 D:/stuck-test2.txt"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 10000));
console.log('STEP1-挂起:', await ev(`JSON.stringify({ pending: !!document.querySelector(".chat-tool-card.pending") })`));
await ev(`location.reload()`);
await new Promise((r) => setTimeout(r, 2500));
await ev(`location.hash = "#/chat"`);
await new Promise((r) => setTimeout(r, 800));
await ev(`(function(){ var t = document.querySelector("[data-role=chat-agent-toggle]"); if (!t.classList.contains("active")) t.click(); return "re-on"; })()`);
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "现在几点了？"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 18000));
const p11 = await ev(`(function(){ var b = document.querySelectorAll(".chat-bubble .chat-text"); return JSON.stringify({ lastBubble: b.length ? b[b.length-1].textContent.slice(0, 70) : null, stuck: b.length ? b[b.length-1].textContent.includes("Agent 正在执行中") : null }); })()`);
console.log('P1-1-回归:', p11);
writeFileSync('shots/v081-p11.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// ===== P1-2 回归：链中危险工具降级确认 =====
// 任务：读 D:/ZCode Code/模型额度查询/模型额度查询/模型额度查询要求.md 然后把内容写入 D:/chain-danger-test.txt
// （先批准链 → 读文件自动执行 → 写文件应弹出确认卡而非自动执行）
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "读取文件 D:/ZCode Code/模型额度查询/模型额度查询/模型额度查询要求.md 的内容，然后把读到的内容原样写入 D:/chain-danger-test.txt"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 12000));
const firstCard = await ev(`(function(){ var c = document.querySelector(".chat-tool-card.pending"); return JSON.stringify({ pending: !!c, head: c ? c.querySelector(".chat-tool-head").textContent.trim().slice(0, 70) : null }); })()`);
console.log('P1-2-第一卡:', firstCard);
if (JSON.parse(firstCard).pending) {
  // 第一个提议可能是 read_text_file（只读）——批准整条链
  await ev(`(function(){ var b = document.querySelector("[data-role=agent-chain]"); if (b) b.click(); return b ? "chain" : "no-chain-btn"; })()`);
  await new Promise((r) => setTimeout(r, 15000));
  // 之后 write_text_file 应重新挂起确认（而非自动执行）
  const dangerCard = await ev(`(function(){ var c = document.querySelector(".chat-tool-card.pending"); return JSON.stringify({ pending: !!c, danger: c ? c.className.includes("danger") : false, head: c ? c.querySelector(".chat-tool-head").textContent.trim().slice(0, 70) : null }); })()`);
  console.log('P1-2-链中危险工具:', dangerCard);
  writeFileSync('shots/v081-chain-danger.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  // 拒绝它，收场
  await ev(`(function(){ var b = document.querySelector("[data-role=agent-deny]"); if (b) b.click(); return "denied"; })()`);
  await new Promise((r) => setTimeout(r, 15000));
}
console.log('P1-2-收场:', await ev(`(function(){ var b = document.querySelectorAll(".chat-bubble .chat-text"); var f = null; try { f = null; } catch(e){} return JSON.stringify({ last: b.length ? b[b.length-1].textContent.slice(0, 90) : null, sendVisible: !document.querySelector("[data-role=chat-send]").hidden }); })()`));

// 清理：循环解除挂起 + 清会话 + 关设置
for (let n = 0; n < 8; n++) {
  const r = await ev(`(async function(){ try { var ch = new window.__TAURI__.core.Channel(); ch.onmessage = function(){}; await window.__TAURI__.core.invoke("agent_resolve", { approved: false, approveChain: false, auto: false, onEvent: ch }); return "resolved"; } catch (e) { return "none"; } })()`);
  if (!r.startsWith('resolved')) break;
  await new Promise((r2) => setTimeout(r2, 1500));
}
await ev(`(function(){ var raw = JSON.parse(localStorage.getItem("mqc.chat.sessions") || "[]"); var act = JSON.parse(localStorage.getItem("mqc.chat.activeSession") || "null"); localStorage.setItem("mqc.chat.sessions", JSON.stringify(raw.map(function(s){ return s.id === act ? Object.assign({}, s, { messages: [], title: "新的对话" }) : s; }))); localStorage.setItem("mqc.chat.agent", "0"); localStorage.setItem("mqc.chat.agentAutoReadonly", "0"); return "cleaned"; })()`);
ws.close(); process.exit(0);
