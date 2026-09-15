// v0.10.0 真机验证：日程与待办 —— 月历页渲染、面板窗增删、提醒同步（schedule.json）、
// Rust 调度到点触发、桌宠气泡播报。
// 前置：旧进程已杀干净；exe 带 --remote-debugging-port=9223 启动；桌宠窗已开启。
// 用法：node scripts/cdp-verify-v0100-schedule.mjs
const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { join } = await import('node:path');

const CFG_DIR = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'com.modelquota.desktop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const list = await (await fetch('http://localhost:9223/json')).json();
const pages = list.filter((t) => t.type === 'page');
console.log('TARGETS:', pages.map((p) => p.url).join(' | '));

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  return new Promise((r) => { ws.onopen = r; }).then(() => ({ send, close: () => ws.close() }));
}

async function evalJson(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) return { __err: '页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400) };
  const v = res.result?.value;
  if (typeof v !== 'string' || v === '') return { __err: 'evaluate 空结果（连接可能失效）' };
  try { return JSON.parse(v); } catch { return { __err: '非 JSON: ' + String(v).slice(0, 80) }; }
}

// WebView2 CDP 的长连接在新建窗口后可能失稳：每步用全新的临时连接，
// 且对 evaluate 结果做一次重试（连接刚建时就发请求偶发空结果）
async function withPage(urlPart, fn) {
  const t = urlPart === '__main__' ? await findMain() : await findPage(urlPart);
  if (!t) return fn(null, null);
  const run = async () => {
    const cdp = await connect(t);
    try { return await fn(cdp, t); } finally { try { cdp.close(); } catch {} }
  };
  const first = await run();
  if (first && first.__err) return run(); // 二次尝试
  return first;
}

const findPage = async (part) => {
  const l = await (await fetch('http://localhost:9223/json')).json();
  return l.find((t) => t.type === 'page' && t.url.includes(part));
};

// 主窗必须按「非功能窗」正则匹配：根 URL 是所有窗口 URL 的子串，
// 用 includes 找主窗会误中桌宠/面板窗（曾把桌宠窗 hash 改成 #/schedule）
const findMain = async () => {
  const l = await (await fetch('http://localhost:9223/json')).json();
  return l.find((t) => t.type === 'page' && !/#(pet|mini|ball|panel-)/.test(t.url));
};

const mainUrl = () => pages.find((p) => !/#(pet|mini|ball|panel-)/.test(p.url))?.url || '';

// —— 0. 就绪等待：等主窗渲染完成、桌宠窗加载（冷启动时 CDP 端口先于页面就绪） ——
{
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    await sleep(2000);
    try {
      ready = await withPage('__main__', async (main) => {
        const st = await evalJson(main, `JSON.stringify({ booted: !!document.querySelector('.sidebar') })`);
        return st.booted === true;
      });
      const petT = await findPage('#pet');
      ready = ready === true && !!petT;
    } catch { ready = false; }
  }
  check('应用就绪（主窗渲染 + 桌宠窗加载）', ready === true);
  await sleep(1500);
}

// —— 1. 主窗日程页渲染 ——
await withPage('__main__', async (main) => {
  await evalJson(main, `JSON.stringify((() => { location.hash = '#/schedule'; return 'ok'; })())`);
  await sleep(1000);
});
const ui = await withPage('__main__', async (main) => await evalJson(main, `JSON.stringify({
  title: document.querySelector('[data-role="view-title"]')?.textContent,
  cells: document.querySelectorAll('.calendar-cell').length,
  today: !!document.querySelector('.calendar-cell.today'),
  weeknames: document.querySelectorAll('.calendar-weekname').length,
  addBtn: !!document.querySelector('[data-sch="add"]'),
  upcoming: document.querySelectorAll('.sch-up-list li').length,
})`));
check('主窗日程页渲染', ui.cells === 42 && ui.today && ui.weeknames === 7 && ui.addBtn,
  `cells=${ui.cells} today=${ui.today} title=${ui.title}`);

// 截图（视觉验收用）
await withPage('__main__', async (main) => {
  const shotMain = await main.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('shots/v0100-main-schedule.png', Buffer.from(shotMain.data, 'base64'));
});

// —— 2. 桌宠菜单打开日程面板，面板内新增一条 ——
const petOpen = !!(await findPage('#pet'));
check('桌宠窗存在', petOpen);
if (petOpen) {
  await withPage('#pet', async (pet) => {
    const emit = `JSON.stringify(globalThis.__TAURI__.event.emit('pet-panel', 'schedule'))`;
    await evalJson(pet, emit);
    await sleep(1200);
    await evalJson(pet, emit); // 若有残留面板先收起，再开保证可见
  });
  await sleep(3000);
  const panelTarget = await findPage('#panel-schedule');
  check('日程面板窗打开', !!panelTarget);
  if (panelTarget) {
    await withPage('#panel-schedule', async (panel) => {
      await sleep(800);
      const panelUi = await evalJson(panel, `JSON.stringify({
        cells: document.querySelectorAll('.calendar-cell').length,
        dayHead: !!document.querySelector('.schedule-day-head'),
      })`);
      check('面板窗月历渲染', panelUi.cells === 42 && panelUi.dayHead, `cells=${panelUi.cells}`);

      // 新增：今天 + 1 小时的一条日程（不用于到点验证，仅测表单链路）
      const addRes = await evalJson(panel, `(() => {
        document.querySelector('[data-sch="add"]').click();
        const $ = (n) => document.querySelector('.sch-form [name="'+n+'"]');
        if (!$('title')) return JSON.stringify({ err: '表单未打开' });
        const now = new Date(Date.now() + 3600 * 1000);
        const p = (x) => String(x).padStart(2, '0');
        $('title').value = 'CDP 表单测试';
        $('date').value = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
        $('time').value = p(now.getHours()) + ':' + p(now.getMinutes());
        $('remindLead').value = '5';
        document.querySelector('.sch-form [data-action="save"]').click();
        const list = JSON.parse(localStorage.getItem('mqc.schedules') || '[]');
        return JSON.stringify({ count: list.length, last: list[list.length - 1]?.title, lead: list[list.length - 1]?.remindLead });
      })()`);
      check('面板表单新增日程', addRes.last === 'CDP 表单测试' && addRes.lead === 5, JSON.stringify(addRes));

      const rowUi = await evalJson(panel, `JSON.stringify({
        rows: document.querySelectorAll('.sch-item').length,
        title: document.querySelector('.sch-title')?.textContent || '',
      })`);
      check('面板当日列表显示新日程', rowUi.rows >= 1 && rowUi.title.includes('CDP 表单测试'), rowUi.title);

      const shotPanel = await panel.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync('shots/v0100-panel-schedule.png', Buffer.from(shotPanel.data, 'base64'));
    });

    // —— 3. 提醒链路：直接注入一条 15 秒后到期的任务（绕过 UI，验证 Rust 调度 + 桌宠气泡） ——
    await withPage('#pet', async (pet) => {
      await evalJson(pet, `JSON.stringify((() => {
        window.__dueLog = [];
        globalThis.__TAURI__.event.listen('schedule-due', (e) => { window.__dueLog = window.__dueLog.concat(e.payload || []); });
        return 'armed';
      })())`);
    });
    const wantKey = `cdp-rt@${Date.now() + 15 * 1000}`;
    const inject = await withPage('__main__', async (main) => await evalJson(main, `(async () => {
      try {
        await globalThis.__TAURI__.core.invoke('set_schedule_reminders', { tasks: [{
          key: ${JSON.stringify(wantKey)}, id: 'cdp-rt', title: 'CDP 到点提醒', note: '调度链路验证',
          dueAt: ${Date.now() + 15 * 1000}, at: ${Date.now() + 15 * 1000}, timeText: 'NOW',
        }] });
        return JSON.stringify('injected');
      } catch (e) { return JSON.stringify('ERR:' + (e?.message || e)); }
    })()`));
    check('提醒任务注入', inject === 'injected', JSON.stringify(inject).slice(0, 120));

    let fired = null;
    for (let i = 0; i < 24 && !fired; i++) {
      await sleep(5000);
      const log = await withPage('#pet', async (pet) => await evalJson(pet, `JSON.stringify(window.__dueLog || [])`));
      if (Array.isArray(log) && log.some((t) => t.key === wantKey)) fired = log.filter((t) => t.key === wantKey);
    }
    check('Rust 调度到点触发 schedule-due', !!fired, fired ? JSON.stringify(fired) : '120s 内未触发');

    if (fired) {
      await withPage('#pet', async (pet) => {
        await sleep(600);
        const bubble = await evalJson(pet, `JSON.stringify({
          text: document.querySelector('.pet-bubble').textContent,
        })`);
        check('桌宠气泡播报提醒', (bubble.text || '').includes('CDP 到点提醒'), (bubble.text || '').slice(0, 60));
        const shotPet = await pet.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync('shots/v0100-pet-remind.png', Buffer.from(shotPet.data, 'base64'));
      });
    }
  }
}

// —— 4. 持久化与清理 ——
const sj = join(CFG_DIR, 'schedule.json');
if (existsSync(sj)) {
  try {
    const data = JSON.parse(readFileSync(sj, 'utf8'));
    check('schedule.json 持久化', Array.isArray(data.tasks) && Array.isArray(data.fired),
      `tasks=${data.tasks.length} fired=${data.fired.length} (fired 应含 cdp-rt@*)`);
    check('已触发集合记录', (data.fired || []).some((k) => String(k).startsWith('cdp-rt@')), (data.fired || []).join(','));
  } catch (e) {
    check('schedule.json 持久化', false, String(e).slice(0, 80));
  }
} else {
  check('schedule.json 持久化', false, '文件不存在: ' + sj);
}

// 清理：移除测试日程（localStorage），队列清空（queue-low → 主窗自动回填真实数据）
await withPage('__main__', async (main) => {
  await evalJson(main, `JSON.stringify((() => {
    const list = JSON.parse(localStorage.getItem('mqc.schedules') || '[]')
      .filter((s) => !String(s.title).startsWith('CDP '));
    localStorage.setItem('mqc.schedules', JSON.stringify(list));
    return list.length;
  })())`);
  const cleaned = await evalJson(main, `(async () => {
    await globalThis.__TAURI__.core.invoke('set_schedule_reminders', { tasks: [] });
    return JSON.stringify('cleaned');
  })()`);
  check('清理测试数据', cleaned === 'cleaned', JSON.stringify(cleaned).slice(0, 120));
});
await sleep(1500); // 等 queue-low → 主窗回填

const pass = results.filter((r) => r.ok).length;
console.log(`\nRESULT: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
