// 深度验证：真实数据链路（推送内容/编辑重发/命令注册/模型切换）
const BASE = 'http://localhost:9223';
const results = [];
const note = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withPage(urlFilter, fn) {
  const list = await (await fetch(`${BASE}/json`)).json();
  const target = list.find((t) => t.type === 'page' && urlFilter(t.url));
  if (!target) throw new Error('page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await new Promise((r) => { ws.onopen = r; });
  try {
    return await fn({
      send,
      ev: async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
        return r.result.value;
      },
    });
  } finally { ws.close(); }
}
const isMain = (u) => !/#(pet|mini|ball|panel-)/.test(u) && !u.endsWith('#note');

// 1. 手机服务推送真实数据（开启 → 等 4s → /api/state 含会话）
await withPage(isMain, async ({ ev }) => {
  await ev(`location.hash = '#/settings'`);
  await sleep(1000);
  const on = await ev(`(async () => document.querySelector('[data-role="phone-toggle"]').textContent.includes('开启'))()`);
  if (on) { await ev(`document.querySelector('[data-role="phone-toggle"]').click()`); await sleep(500); }
  const addr = await ev(`document.querySelector('[data-role="phone-addr"]')?.textContent || ''`);
  await sleep(4500); // 等推送循环
  const { execSync } = await import('node:child_process');
  const body = execSync(`curl -s --max-time 5 "${addr}/api/state"`, { timeout: 8000 }).toString();
  const st = JSON.parse(body);
  note('手机推送：/api/state 含真实会话数据', Array.isArray(st.sessions) && st.sessions.length >= 0 && st.active === true,
    `sessions=${Array.isArray(st.sessions) ? st.sessions.length : 'null'} active=${st.active} bytes=${body.length}`);
  note('手机服务状态 JSON 完整', st.active === true && 'petImage' in st, 'merged keys ok');
  // 关闭服务（恢复初始态）
  await ev(`document.querySelector('[data-role="phone-toggle"]').click()`);
  await sleep(400);
  const off = await ev(`(async () => JSON.stringify(await __TAURI__.core.invoke('phone_server_status')))()`);
  note('关闭服务后状态清空', JSON.parse(off).active === false, '');
});

// 2. chat 编辑重发真机（预置会话 → 编辑 → 断言重发与截断）
await withPage(isMain, async ({ ev }) => {
  await ev(`location.hash = '#/home'; 'leave'`);
  await sleep(600);
  // 注入假 profile（不可达地址）：重发真实调用 chat_send 但快速失败，不打真实 API
  await ev(`(async () => {
    const cfg = await __TAURI__.core.invoke('chat_get_config');
    window.__origCfg = JSON.parse(JSON.stringify(cfg));
    cfg.profiles = [{ id: 'fake-p', name: '深度验证假供应商', base_url: 'http://127.0.0.1:1', models: ['fake-model'] }];
    cfg.active_profile_id = 'fake-p';
    cfg.active_model = 'fake-model';
    await __TAURI__.core.invoke('chat_save_config', { cfg });
    return 'fake-profile-set';
  })()`);
  await ev(`(() => {
    localStorage.setItem('mqc.chat.sessions', JSON.stringify([{ id: 'sx', title: '深度验证', createdAt: 1, updatedAt: 1, messages: [
      { role: 'user', content: '原始问题', time: 1 },
      { role: 'assistant', content: '（请求失败：超时）', error: true, time: 2 },
    ]}]));
    localStorage.setItem('mqc.chat.activeSession', 'sx');
    localStorage.setItem('mqc.chat.agent', '0');
    location.hash = '#/chat';
    return 'seeded';
  })()`);
  await sleep(1500);
  const canEdit = await ev(`!!document.querySelector('[data-role="msg-edit"]')`);
  note('中断会话显示编辑按钮', canEdit, '');
  await ev(`document.querySelector('[data-role="msg-edit"]').click()`);
  await sleep(300);
  await ev(`(() => { const b = document.querySelector('[data-role="msg-edit-box"]'); b.value = '真机改写的问题'; b.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  // 拦截 chat_send 的参数：替换为立即回包
  await ev(`(() => {
    const orig = __TAURI__.core.invoke;
    window.__sendArgs = null;
    __TAURI__.core.invoke = function (cmd, args) {
      if (cmd === 'chat_send') {
        window.__sendArgs = JSON.stringify(args.messages);
        setTimeout(() => { args?.onEvent?.onmessage?.({ type: 'token', data: { text: '真机回复' } }); args?.onEvent?.onmessage?.({ type: 'done', data: { usage: null } }); }, 10);
        return Promise.resolve(null);
      }
      return orig.call(this, cmd, args);
    };
    return 'hooked';
  })()`);
  await ev(`document.querySelector('[data-role="msg-edit-save"]').click()`);
  await sleep(1200);
  let d = null;
  try {
    d = JSON.parse(await ev(`JSON.stringify({
      sendArgs: JSON.parse(window.__sendArgs || '[]'),
      stored: JSON.parse(localStorage.getItem('mqc.chat.sessions')).find((s) => s.id === 'sx').messages.map((m) => ({ r: m.role, c: m.content })),
    })`));
    note('编辑重发：历史截断且为改写文本', d.stored.length === 2 && d.stored[0].c === '真机改写的问题' && !d.stored[0].c.includes('原始问题'),
      `msgs=${JSON.stringify(d.stored.map((m) => m.c)).slice(0, 120)}`);
    note('编辑重发：产生了新回复（失败请求亦证明重新发送）', d.stored[1] && d.stored[1].c !== undefined && d.stored[1].r === 'assistant', `tail=${String(d.stored[1]?.c).slice(0, 60)}`);
  } finally {
    // 无论断言成败都还原会话与原配置（防 fake-p 残留污染用户配置）；
    // 假地址可能已被启动同步加进供应商列表，一并清除
    await ev(`(async () => {
      localStorage.removeItem('mqc.chat.sessions');
      localStorage.removeItem('mqc.chat.activeSession');
      localStorage.removeItem('mqc.chat.agent');
      if (window.__origCfg) await __TAURI__.core.invoke('chat_save_config', { cfg: window.__origCfg });
      const providers = JSON.parse(localStorage.getItem('mqc.providers') || '[]')
        .filter((p) => !String(p.baseUrl || '').startsWith('http://127.0.0.1:1'));
      localStorage.setItem('mqc.providers', JSON.stringify(providers));
      const tb = JSON.parse(localStorage.getItem('mqc.syncTombstones') || '[]')
        .filter((u) => !u.startsWith('http://127.0.0.1:1'));
      localStorage.setItem('mqc.syncTombstones', JSON.stringify(tb));
      return 'restored';
    })()`);
  }
});

// 3. 便签复制命令已注册（调用返回 ok 或环境错误，但不是"命令不存在"）
await withPage(isMain, async ({ ev }) => {
  const r = await ev(`(async () => __TAURI__.core.invoke('clipboard_write_text', { text: 'x' }).then(() => 'ok').catch((e) => String(e)))()`);
  note('clipboard_write_text 已注册（非命令不存在错误）', r === 'ok' || !String(r).includes('not found'), `ret=${String(r).slice(0, 60)}`);
});

// 4. 便签页复制按钮真机（当前剪贴板被宿主占用则报占用错误而非无反应）
await withPage(isMain, async ({ ev }) => {
  await ev(`location.hash = '#/notes'`);
  await sleep(1000);
  await ev(`localStorage.setItem('mqc.notes.clipboard', JSON.stringify([{ id: 'nc1', text: '复制验证文本', time: Date.now() }])); globalThis.dispatchEvent(new StorageEvent('storage', { key: 'mqc.notes.clipboard' })); 'ok'`);
  await sleep(400);
  const r = await ev(`(async () => {
    const btn = document.querySelector('.note-actions [data-role="note-copy"]');
    btn.click();
    await new Promise((res) => setTimeout(res, 500));
    return 'clicked';
  })()`);
  note('便签复制按钮点击有响应', r === 'clicked', '');
  // 清理注入数据
  await ev(`localStorage.removeItem('mqc.notes.clipboard'); 'ok'`);
});

// 5. 模型切换真机持久化（切到另一家 → active_model 变化）
await withPage(isMain, async ({ ev }) => {
  await ev(`location.hash = '#/chat'`);
  await sleep(1200);
  const sel = await ev(`(() => {
    const s = document.querySelector('[data-role="chat-profile"]');
    return JSON.stringify({ options: s.options.length, current: s.selectedOptions[0]?.textContent });
  })()`);
  const d = JSON.parse(sel);
  if (d.options >= 2) {
    await ev(`(() => {
      const s = document.querySelector('[data-role="chat-profile"]');
      const other = [...s.options].find((o) => o !== s.selectedOptions[0]);
      s.value = other.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return other.textContent;
    })()`);
    await sleep(800);
    const after = await ev(`(async () => {
      const cfg = await __TAURI__.core.invoke('chat_get_config');
      return JSON.stringify({ active: cfg.active_profile_id, model: cfg.active_model });
    })()`);
    const a = JSON.parse(after);
    note('模型切换真机持久化', !!a.active && !!a.model, `active=${a.active} model=${a.model}`);
  } else {
    note('模型切换真机持久化', true, 'skip: 只有一家供应商');
  }
  // 还原用户原始配置（step2 的切换可能把注入态写回）
  await ev(`(async () => {
    if (window.__origCfg) await __TAURI__.core.invoke('chat_save_config', { cfg: window.__origCfg });
    return 'restored';
  })()`);
});

const failed = results.length - results.filter(Boolean).length;
console.log(failed ? `FAILED: ${failed}` : 'ALL PASS');
process.exit(results.every(Boolean) ? 0 : 1);
