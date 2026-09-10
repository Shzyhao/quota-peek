// CDP 对话链路端到端验证：在主窗页面上下文里直接 invoke 命令
// 1) 保存 profile + 密钥（keyring）2) chat_send 流式收 token 3) 输出回复摘要
const list = await (await fetch('http://localhost:9223/json')).json();
const target = list.find((t) => t.type === 'page' && t.url.includes('5180/') && !t.url.includes('#'));
if (!target) { console.error('main window target not found'); process.exit(1); }

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

async function pageEval(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const key = process.argv[2];
if (!key) { console.error('usage: node cdp-chat-test.mjs <apikey>'); process.exit(1); }

// 1) 配置 + 密钥
const cfgResult = await pageEval(`
(async () => {
  const invoke = globalThis.__TAURI__.core.invoke;
  const cfg = {
    profiles: [{ id: 'ptest', name: 'DeepSeek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' }],
    active_profile_id: 'ptest',
    persona: '',
  };
  await invoke('chat_save_config', { cfg });
  await invoke('chat_set_key', { profileId: 'ptest', key: ${JSON.stringify(key)} });
  const hasKey = await invoke('chat_has_key', { profileId: 'ptest' });
  return 'config saved, hasKey=' + hasKey;
})()
`);
console.log('CONFIG:', cfgResult);

// 2) 流式对话
const chatResult = await pageEval(`
(async () => {
  const { invoke, Channel } = globalThis.__TAURI__.core;
  return await new Promise((resolve) => {
    let text = '';
    const ch = new Channel();
    ch.onmessage = (ev) => {
      if (ev.type === 'token') text += (ev.data && ev.data.text) || '';
      else if (ev.type === 'done') resolve('DONE usage=' + JSON.stringify(ev.data && ev.data.usage) + ' len=' + text.length + ' text=' + text.slice(0, 120));
      else if (ev.type === 'error') resolve('ERROR: ' + (ev.data && ev.data.message));
      else if (ev.type === 'cancelled') resolve('CANCELLED len=' + text.length);
    };
    invoke('chat_send', {
      messages: [{ role: 'user', content: '用一句话介绍你自己，15字以内' }],
      onEvent: ch,
    }).catch((e) => resolve('SEND-ERR: ' + e));
  });
})()
`);
console.log('CHAT:', chatResult);
ws.close();
process.exit(0);
