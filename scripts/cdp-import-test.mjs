// CDP 验证：额度供应商 → 对话模型导入链路
// 用法：node --use-system-ca scripts/cdp-import-test.mjs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch('http://localhost:9223/json')).json();
const main = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180/') && !t.url.includes('#pet') && !t.url.includes('#panel'));
const ws = new WebSocket(main.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const m = ++id;
  pending.set(m, { resolve });
  ws.send(JSON.stringify({ id: m, method, params }));
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => { ws.onopen = r; });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

// seed 三个供应商：chatModel 覆盖样例 / 默认模型样例 / 应被过滤的 IAM 双凭证
const seed = JSON.stringify([
  { id: 'p-seed1', name: 'DeepSeek 主账号', type: 'deepseek', apiKey: 'sk-seed-test', baseUrl: 'https://api.deepseek.com', chatModel: 'deepseek-reasoner', enabled: true, lastQuery: null },
  { id: 'p-seed2', name: '硅基流动', type: 'siliconflow', apiKey: 'sk-sf-test', baseUrl: '', chatModel: '', enabled: true, lastQuery: null },
  { id: 'p-seed3', name: '方舟 IAM', type: 'volcengine', apiKey: 'ak', apiSecret: 'sk', baseUrl: '', chatModel: '', enabled: true, lastQuery: null },
]);
await evalJs(`localStorage.setItem('mqc.providers', ${JSON.stringify(seed)}); location.reload();`);
await sleep(3500);

await evalJs(`location.hash = '#/chat'; void 0`);
await sleep(1000);
await evalJs(`document.querySelector('[data-role=chat-config-toggle]').click()`);
await sleep(500);
console.log('import list:', await evalJs(`(() => { const items = [...document.querySelectorAll('.chat-import-item')]; return items.length + ' 项: ' + items.map(i => i.querySelector('.chat-import-name').textContent + '/' + i.querySelector('.chat-import-model').textContent + '[' + i.querySelector('button').textContent + ']').join(' | ')); })()`));

// 导入 DeepSeek（chatModel 覆盖 → deepseek-reasoner）
await evalJs(`[...document.querySelectorAll('[data-role=chat-import]')][0].click()`);
await sleep(1500);
console.log('after import:', await evalJs(`JSON.stringify({ msg: document.querySelector('[data-role=chat-test-result]').textContent.slice(0, 70), active: document.querySelector('[data-role=chat-profile]')?.selectedOptions?.[0]?.textContent?.slice(0, 40) })`));
console.log('keyring has prov-p-seed1:', await evalJs(`globalThis.__TAURI__.core.invoke('chat_has_key', { profileId: 'prov-p-seed1' }).catch(e => 'ERR:' + e)`));
console.log('profile rows:', await evalJs(`[...document.querySelectorAll('.chat-profile-item')].map(i => i.querySelector('.chat-profile-info b').textContent).join(',')`));
ws.close();
process.exit(0);
