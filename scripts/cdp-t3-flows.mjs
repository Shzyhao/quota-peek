// T3 真机交互全链路：便签窗生命周期 / 模型列表编辑入库 / 跨窗面板
const BASE = 'http://localhost:9223';
const results = [];
const note = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withPage(urlFilter, fn) {
  const list = await (await fetch(`${BASE}/json`)).json();
  const target = list.find((t) => t.type === 'page' && urlFilter(t.url));
  if (!target) throw new Error('page not found: ' + JSON.stringify(list.map((t) => t.url)));
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
        if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 250));
        return r.result.value;
      },
    });
  } finally { ws.close(); }
}
const isMain = (u) => !/#(pet|mini|ball|panel-)/.test(u) && !u.endsWith('#note');
const isNote = (u) => u.endsWith('#note');
const pages = async () => (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page').map((t) => t.url);

// ——— 流程 1：便签窗生命周期 ———
await withPage(isMain, async ({ ev }) => {
  await ev(`localStorage.removeItem('mqc.note.sticky'); location.hash = '#/notes'; 'ok'`);
  await sleep(1000);
  await ev(`document.querySelector('[data-role="notes-open-window"]').click()`);
  await sleep(2200);
});
note('便签窗创建（#note 页面出现）', (await pages()).some((u) => u.endsWith('#note')), '');
await withPage(isNote, async ({ ev }) => {
  const typed = await ev(`(() => {
    const ta = document.querySelector('[data-role="note-body"]');
    ta.value = 'T3生命周期验证内容';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  note('便签窗输入', typed === 'typed', '');
  // 取消固定
  await ev(`document.querySelector('[data-role="note-pin"]').click()`);
  await sleep(500);
  const st1 = JSON.parse(await ev(`(async () => JSON.stringify({ sticky: JSON.parse(localStorage.getItem('mqc.note.sticky')), onTop: await __TAURI__.window.getCurrentWindow().isAlwaysOnTop() }))()`));
  note('取消固定：sticky.pinned=false 且窗口不置顶', st1.sticky.pinned === false && st1.onTop === false, '');
  // 关闭（× = hide，窗口保留）
  await ev(`document.querySelector('[data-role="note-close"]').click()`);
  await sleep(800);
});
await withPage(isMain, async ({ ev }) => {
  // 重开：label 已存在 → invoke focus 路径，内容与固定态恢复
  await ev(`document.querySelector('[data-role="notes-open-window"]').click()`);
  await sleep(1200);
});
await withPage(isNote, async ({ ev }) => {
  const d = JSON.parse(await ev(`(async () => JSON.stringify({
    text: document.querySelector('[data-role="note-body"]').value,
    stickyPinned: JSON.parse(localStorage.getItem('mqc.note.sticky')).pinned,
    pinActive: document.querySelector('[data-role="note-pin"]').classList.contains('active'),
    onTop: await __TAURI__.window.getCurrentWindow().isAlwaysOnTop(),
  }))()`));
  note('重开恢复内容与固定态', d.text === 'T3生命周期验证内容' && d.stickyPinned === false && d.pinActive === false && d.onTop === false,
    `text=${d.text.slice(0, 14)} pinned=${d.stickyPinned} onTop=${d.onTop}`);
  // 恢复默认固定 + 清理测试内容
  await ev(`document.querySelector('[data-role="note-pin"]').click()`);
  await sleep(500);
  await ev(`(() => {
    const ta = document.querySelector('[data-role="note-body"]');
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'cleared';
  })()`);
  await sleep(600);
});

// ——— 流程 2：模型列表编辑入库（UI 添加供应商 → 配置 + 额度查询 + 清理） ———
await withPage(isMain, async ({ ev }) => {
  await ev(`location.hash = '#/models'`);
  await sleep(1200);
  await ev(`document.querySelector('[data-role="model-add"]').click()`);
  await sleep(300);
  await ev(`(() => {
    const form = document.querySelector('.chat-profile-form');
    form.querySelector('[data-field="name"]').value = 'T3测试供应商';
    form.querySelector('[data-field="base_url"]').value = 'https://api.t3test.invalid';
    document.querySelector('[data-role="model-add-row"]').click();
    const rows = document.querySelectorAll('[data-field="model-row"]');
    rows[0].value = 't3-model-a';
    rows[1].value = 't3-model-b';
    return 'filled';
  })()`);
  await ev(`document.querySelector('[data-role="model-save"]').click()`);
  await sleep(1500);
  const d = JSON.parse(await ev(`(async () => {
    const cfg = await __TAURI__.core.invoke('chat_get_config');
    const providers = JSON.parse(localStorage.getItem('mqc.providers') || '[]');
    const prof = cfg.profiles.find((p) => p.name === 'T3测试供应商');
    const prov = providers.find((p) => p.name === 'T3测试供应商');
    return JSON.stringify({
      profModels: prof?.models ?? null,
      provType: prov?.type ?? null,
      provModel: prov?.chatModel ?? null,
      provEnabled: prov?.enabled,
    });
  })()`));
  note('列表编辑入库：配置含两预设模型', d.profModels?.join(',') === 't3-model-a,t3-model-b', `models=${d.profModels}`);
  note('同步额度查询：类型推断+默认模型+启用', d.provType === 'custom' && d.provModel === 't3-model-a' && d.provEnabled === true,
    `type=${d.provType} model=${d.provModel}`);
  // 清理：删配置与供应商 + tombstone
  await ev(`(async () => {
    const cfg = await __TAURI__.core.invoke('chat_get_config');
    cfg.profiles = cfg.profiles.filter((p) => p.name !== 'T3测试供应商');
    if (cfg.active_profile_id && !cfg.profiles.some((p) => p.id === cfg.active_profile_id)) {
      cfg.active_profile_id = cfg.profiles[0]?.id ?? null;
      cfg.active_model = cfg.profiles[0]?.models?.[0] ?? null;
    }
    await __TAURI__.core.invoke('chat_save_config', { cfg });
    const providers = JSON.parse(localStorage.getItem('mqc.providers') || '[]').filter((p) => p.name !== 'T3测试供应商');
    localStorage.setItem('mqc.providers', JSON.stringify(providers));
    const tb = new Set(JSON.parse(localStorage.getItem('mqc.syncTombstones') || '[]'));
    tb.delete('https://api.t3test.invalid');
    localStorage.setItem('mqc.syncTombstones', JSON.stringify([...tb]));
    return 'cleaned';
  })()`);
  await sleep(400);
  const clean = JSON.parse(await ev(`(async () => {
    const cfg = await __TAURI__.core.invoke('chat_get_config');
    return JSON.stringify({ hasFake: cfg.profiles.some((p) => p.name === 'T3测试供应商'), provs: JSON.parse(localStorage.getItem('mqc.providers') || '[]').some((p) => p.name === 'T3测试供应商') });
  })()`));
  note('测试数据清理干净', !clean.hasFake && !clean.provs, '');
});

// ——— 流程 3：跨窗面板（pet-panel 建 panel-chat，聊天 UI 完整） ———
await withPage((u) => u.includes('#pet'), async ({ ev }) => {
  await ev(`__TAURI__.event.emit('pet-panel', 'chat'); 'emitted'`);
  await sleep(2500);
});
const all = await pages();
note('跨窗面板：panel-chat 创建', all.some((u) => u.includes('#panel-chat')), '');
if (all.some((u) => u.includes('#panel-chat'))) {
  await withPage((u) => u.includes('#panel-chat'), async ({ ev }) => {
    const d = JSON.parse(await ev(`JSON.stringify({
      session: !!document.querySelector('[data-role="chat-session"]'),
      modelSel: !!document.querySelector('[data-role="chat-profile"]'),
      modelOptions: document.querySelectorAll('[data-role="chat-profile"] option').length,
      input: !!document.querySelector('[data-role="chat-input"]'),
      noConfig: !document.querySelector('.chat-config') && !document.querySelector('[data-role="chat-test"]'),
    })`));
    note('面板聊天：会话+模型下拉+输入框齐全，无配置面板', d.session && d.modelSel && d.modelOptions >= 1 && d.input && d.noConfig,
      `模型选项=${d.modelOptions}`);
  });
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `T3 FAILED: ${failed}` : 'T3 ALL PASS');
process.exit(failed ? 1 : 0);
