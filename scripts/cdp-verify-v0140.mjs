// CDP 验证脚本 v0.14.0：模型配置页 / 对话页工具栏 / 消息操作 / 模型↔额度双向同步
// 用法：先带 --remote-debugging-port=9223 启动应用，再 node scripts/cdp-verify-v0140.mjs
// 每步新建临时 WebSocket 连接（长脚本连接失稳的已知坑）
import { writeFileSync } from 'node:fs';

const BASE = 'http://localhost:9223';
const results = [];
const note = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
};

async function withPage(urlFilter, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const list = await (await fetch(`${BASE}/json`)).json();
      const target = list.find((t) => t.type === 'page' && urlFilter(t.url));
      if (!target) throw new Error('page not found: ' + JSON.stringify(list.map((t) => t.url)));
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      let id = 0;
      const pending = new Map();
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      };
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      try {
        return await fn({
          send,
          ev: async (expr) => {
            const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
            return r.result.value;
          },
        });
      } finally {
        ws.close();
      }
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

// 主窗 = 根 URL 且非桌宠/迷你/面板路由
const isMain = (url) => !/#(pet|mini|ball|panel-)/.test(url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ——— 1. 主窗导航：模型配置入口 ———
await withPage(isMain, async ({ ev }) => {
  const nav = await ev(`JSON.stringify({
    count: document.querySelectorAll('.nav [data-action="nav"]').length,
    models: !!document.querySelector('[data-action="nav"][data-view="models"]'),
    labels: [...document.querySelectorAll('.nav [data-action="nav"] span')].map((s) => s.textContent),
  })`);
  const d = JSON.parse(nav);
  note('导航含「模型配置」页', d.models && d.count === 10, `items=${d.count} labels=${d.labels.join('/')}`);
});

// ——— 2. 模型配置页：供应商列表 + 语音服务 + 人设 ———
await withPage(isMain, async ({ ev, send }) => {
  await ev(`location.hash = '#/models'`);
  await sleep(1200);
  const d = JSON.parse(await ev(`JSON.stringify({
    profileItems: document.querySelectorAll('.chat-profile-item').length,
    modelTags: document.querySelectorAll('.chat-model-tag').length,
    tagTexts: [...document.querySelectorAll('.chat-model-tag')].map((t) => t.textContent),
    addBtn: !!document.querySelector('[data-role="model-add"]'),
    fields: [...document.querySelectorAll('[data-field]')].map((e) => e.dataset.field),
    persona: !!document.querySelector('[data-role="model-persona"]'),
    personaSave: !!document.querySelector('[data-role="model-persona-save"]'),
    keyStates: [...document.querySelectorAll('.chat-key-state')].map((e) => e.textContent.trim()),
    urls: [...document.querySelectorAll('.chat-profile-url')].map((e) => e.textContent),
  })`));
  const need = ['voice-asr-base', 'voice-asr-model', 'voice-tts-base', 'voice-tts-model', 'voice-tts-voice', 'voice-key'];
  const voiceOk = need.every((f) => d.fields.includes(f));
  note('模型配置页渲染', d.addBtn && voiceOk && d.persona && d.personaSave && d.profileItems > 0,
    `供应商=${d.profileItems} 模型标签=${d.modelTags}(${d.tagTexts.join(',')}) 密钥状态=${d.keyStates.join('/')}`);
  note('语音服务卡迁移到模型配置页', voiceOk, '');
  console.log('INFO 供应商地址:', d.urls.join(' | ') || '（无）');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('shots/v0140-models-page.png', Buffer.from(shot.data, 'base64'));
});

// ——— 3. 对话页：工具栏（模型下拉保留 / 测试连接、清空记录移除）+ 消息操作 ———
await withPage(isMain, async ({ ev, send }) => {
  await ev(`location.hash = '#/chat'`);
  await sleep(1200);
  const d = JSON.parse(await ev(`JSON.stringify({
    modelOptions: [...document.querySelectorAll('[data-role="chat-profile"] option')].map((o) => o.textContent),
    modelSelected: document.querySelector('[data-role="chat-profile"]')?.selectedOptions?.[0]?.textContent || '',
    noTest: !document.querySelector('[data-role="chat-test"]'),
    noClear: !document.querySelector('[data-role="chat-clear"]'),
    noConfigToggle: !document.querySelector('[data-role="chat-config-toggle"]'),
    noConfigPanel: !document.querySelector('.chat-config'),
    hasDel: !!document.querySelector('[data-role="chat-session-del"]'),
    hintEl: !!document.querySelector('[data-role="chat-hint"]'),
    bubbles: document.querySelectorAll('.chat-bubble').length,
    userBubbles: document.querySelectorAll('.chat-bubble.user').length,
    toolCards: document.querySelectorAll('.chat-tool-card').length,
    copyBtns: document.querySelectorAll('[data-role="msg-copy"]').length,
    editBtns: document.querySelectorAll('[data-role="msg-edit"]').length,
  })`));
  note('模型下拉（供应商×模型）', d.modelOptions.length > 0, `options=${JSON.stringify(d.modelOptions).slice(0, 200)} selected=${d.modelSelected}`);
  note('测试连接/清空记录/配置入口已移除', d.noTest && d.noClear && d.noConfigToggle && d.noConfigPanel, '');
  note('删除会话保留（主窗）', d.hasDel && d.hintEl, '');
  note('消息操作：复制/编辑按钮', d.bubbles === 0 || (d.copyBtns === d.bubbles && d.editBtns <= d.userBubbles),
    `气泡=${d.bubbles} 用户=${d.userBubbles} 复制钮=${d.copyBtns} 编辑钮=${d.editBtns}`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('shots/v0140-chat-page.png', Buffer.from(shot.data, 'base64'));
});

// ——— 4. 配置结构与双向同步：profile.models / active_model / 供应商补齐 ———
await withPage(isMain, async ({ ev }) => {
  const cfg = JSON.parse(await ev(`(async () => JSON.stringify(await __TAURI__.core.invoke('chat_get_config')))()`));
  const providers = JSON.parse(await ev(`localStorage.getItem('mqc.providers') || '[]'`));
  const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  const profileBases = (cfg.profiles || []).map((p) => p.base_url).filter(Boolean);
  const providerBases = new Set(providers.map((p) => norm(p.baseUrl)).filter(Boolean));
  const missing = profileBases.filter((b) => !providerBases.has(norm(b)));
  const withModels = (cfg.profiles || []).filter((p) => (p.models || []).length > 0).length;
  note('profiles 均含预设模型 models[]', (cfg.profiles || []).length === 0 || withModels === cfg.profiles.length,
    `profiles=${cfg.profiles.length} 带模型=${withModels} active=${cfg.active_profile_id}/${cfg.active_model}`);
  note('模型配置已同步进额度查询（baseUrl 全覆盖）', missing.length === 0,
    `profiles=${profileBases.length} providers=${providers.length} 缺失=${JSON.stringify(missing)}`);
  const provSummary = providers.map((p) => `${p.name}(${p.type}${p.hasSecret ? ',key' : ''})`).join('、');
  console.log('INFO providers:', provSummary || '（空）');
  const profSummary = (cfg.profiles || []).map((p) => `${p.name}[${(p.models || []).join('|')}]`).join('、');
  console.log('INFO profiles:', profSummary || '（空）');
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAILED: ${failed.length}` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
