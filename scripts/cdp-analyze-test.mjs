// CDP 文件分析链路验证：主窗上下文 invoke analyze_files，流式收 PipelineEvent
const list = await (await fetch('http://localhost:9223/json')).json();
const target = list.find((t) => t.type === 'page' && t.url.includes('5180/') && !t.url.includes('#'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((r) => { ws.onopen = r; });

const r = await send('Runtime.evaluate', {
  expression: `
(async () => {
  const { invoke, Channel } = globalThis.__TAURI__.core;
  return await new Promise((resolve) => {
    const events = [];
    let text = '';
    const ch = new Channel();
    ch.onmessage = (ev) => {
      events.push(ev.type);
      if (ev.type === 'Tokens') text += (ev.data && ev.data.text) || '';
      if (ev.type === 'Done') resolve('OK events=' + [...new Set(events)].join(',') + ' len=' + text.length + ' head=' + text.slice(0, 100));
      if (ev.type === 'Error') resolve('PIPE-ERROR: ' + JSON.stringify(ev.data));
    };
    invoke('analyze_files', {
      paths: ['D:/ZCode Code/模型额度查询/模型额度查询/README.md'],
      save: false,
      custom: '用两句话概括这个项目',
      onEvent: ch,
    }).catch((e) => resolve('INVOKE-ERR: ' + e));
  });
})()
`,
  awaitPromise: true,
  returnByValue: true,
});
console.log('ANALYZE:', r.result.value);
// 顺带验证历史写入
const h = await send('Runtime.evaluate', {
  expression: `(async () => { const l = await globalThis.__TAURI__.core.invoke('analyze_get_history'); return 'history entries=' + l.length + ' first=' + (l[0] && l[0].source_file); })()`,
  awaitPromise: true,
  returnByValue: true,
});
console.log('HISTORY:', h.result.value);
ws.close();
process.exit(0);
