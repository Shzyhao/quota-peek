// 复盘实证①：Agent 挂起未确认后再发消息 —— 是否永久卡死
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.filter((t) => t.type === 'page').find((p) => !/#(pet|mini|ball|panel-)/.test(p.url));
const ws = new WebSocket(main.webSocketDebuggerUrl);
let i = 0;
const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++i; pend.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };

// 开 Agent（只读自动批准关）
await ev(`location.hash = "#/chat"; location.reload()`);
await new Promise((r) => setTimeout(r, 2500));
await ev(`(function(){ var t = document.querySelector("[data-role=chat-agent-toggle]"); if (!t.classList.contains("active")) t.click(); return "on"; })()`);

// 发起一个写文件任务（高危）→ 挂起
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "把「x」写入 D:/stuck-test.txt"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 10000));
console.log('STEP1-挂起:', await ev(`(function(){ var c = document.querySelector(".chat-tool-card.pending"); return JSON.stringify({ pending: !!c }); })()`));

// 模拟“用户没理睬确认卡”→ 重载页面（pending UI 丢失，Rust pending 仍在）
await ev(`location.reload()`);
await new Promise((r) => setTimeout(r, 2500));
await ev(`location.hash = "#/chat"`);
await new Promise((r) => setTimeout(r, 800));

// 再发一条普通消息 → 预期报「Agent 正在执行中」错误 = 卡死实证
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "帮我看看时间"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 3000));
console.log('STEP2-卡死实证:', await ev(`(function(){ var b = document.querySelectorAll(".chat-bubble .chat-text"); var last = b.length ? b[b.length-1].textContent : null; return JSON.stringify({ lastBubble: last, pendingStill: !!document.querySelector(".chat-tool-card.pending") }); })()`));

// 清理：直接调 agent_resolve(false) 解除挂起 + 清会话
await ev(`(async function(){ await window.__TAURI__.core.invoke("agent_resolve", {}); return "x"; })()`);
const cleanup = await ev(`(async function(){
  try {
    var ch = new window.__TAURI__.Channel();
    ch.onmessage = function(){};
    var r = await window.__TAURI__.core.invoke("agent_resolve", { approved: false, onEvent: ch });
    return "resolved:" + JSON.stringify(r);
  } catch (e) { return "resolve-err: " + e; }
})()`);
console.log('STEP3-解除:', cleanup);
await new Promise((r) => setTimeout(r, 1500));
// 再发一次验证恢复
await ev(`(function(){ document.querySelector("[data-role=chat-input]").value = "现在几点？"; document.querySelector("[data-role=chat-send]").click(); return "sent"; })()`);
await new Promise((r) => setTimeout(r, 6000));
console.log('STEP4-恢复后:', await ev(`(function(){ var b = document.querySelectorAll(".chat-bubble .chat-text"); return JSON.stringify({ lastBubble: b.length ? b[b.length-1].textContent.slice(0, 60) : null }); })()`));

// 清理测试数据与设置
await ev(`(function(){
  var raw = JSON.parse(localStorage.getItem("mqc.chat.sessions") || "[]");
  var act = JSON.parse(localStorage.getItem("mqc.chat.activeSession") || "null");
  localStorage.setItem("mqc.chat.sessions", JSON.stringify(raw.map(function(s){ return s.id === act ? Object.assign({}, s, { messages: [], title: "新的对话" }) : s; })));
  localStorage.setItem("mqc.chat.agent", "0");
  return "cleaned";
})()`);
ws.close(); process.exit(0);
