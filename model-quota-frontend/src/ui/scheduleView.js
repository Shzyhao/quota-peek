// 主窗「日程」页与桌宠日程面板共用的自挂载组件（mountSchedulePage 由 app.js /
// panels.js 在渲染后调用）：月历网格 + 当日待办列表 + 「接下来」 + 新增/编辑表单。
// 数据经 core/schedule.js 存取（localStorage 跨窗共享），改动即时同步后端提醒调度。

import { escapeHtml } from './format.js';
import { styledConfirm } from './confirm.js';
import {
  REPEAT_LABELS, LEAD_OPTIONS, todayStr,
  upsertSchedule, removeSchedule, toggleScheduleDone,
  upcomingInstances,
} from '../core/schedule.js';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function scheduleView() {
  return '<div class="schedule-page" data-role="schedule-root"></div>';
}

const pad2 = (x) => String(x).padStart(2, '0');
const fmtHM = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 「接下来」列表的时刻标签：今天/明天/后天 → 周几 → M月D日
function dayLabel(ms, today) {
  const d = new Date(ms);
  const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day0 - today) / 24 / 60 / 60 / 1000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff < 7) return `周${WEEKDAYS[(d.getDay() + 6) % 7]}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ——— 新增/编辑表单（模态，样式复用供应商表单的 modal 体系）———

function openScheduleForm({ mount, existing, defaultDate, onSaved }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const leadOptions = (cur) => LEAD_OPTIONS.map((m) => `<option value="${m}" ${Number(cur) === m ? 'selected' : ''}>${m === 0 ? '准点提醒' : `提前 ${m} 分钟`}</option>`).join('');
  const repeatOptions = (cur) => Object.entries(REPEAT_LABELS).map(([v, label]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`).join('');

  overlay.innerHTML = `
    <div class="modal form-modal sch-form" role="dialog" aria-modal="true">
      <h2>${existing ? '编辑日程' : '新增日程 / 待办'}</h2>
      <div class="form-grid">
        <label class="full">标题 *<input name="title" placeholder="例如：下午 3 点项目周会" value="${escapeHtml(existing ? existing.title : '')}"></label>
        <label>日期<input name="date" type="date" value="${escapeHtml(existing ? existing.date : defaultDate)}"></label>
        <label>时间<input name="time" type="time" value="${escapeHtml(existing ? existing.time || '' : '')}"></label>
        <label>提醒<select name="remindLead">${leadOptions(existing ? existing.remindLead : 0)}</select></label>
        <label>重复<select name="repeat">${repeatOptions(existing ? existing.repeat : 'none')}</select></label>
        <label class="full">备注<input name="note" placeholder="可选" value="${escapeHtml(existing ? existing.note : '')}"></label>
      </div>
      <p class="settings-hint">时间留空 = 当天待办（勾选完成，不提醒）；填写时间 = 到点由桌宠气泡提醒，桌宠未开启时回退系统通知。</p>
      <p class="form-error" data-error hidden></p>
      <div class="modal-actions">
        <button class="btn" data-action="cancel">取消</button>
        <button class="btn primary" data-action="save">保存</button>
      </div>
    </div>`;

  mount.appendChild(overlay);
  const $ = (name) => overlay.querySelector(`[name="${name}"]`);
  const errorEl = overlay.querySelector('[data-error]');
  const close = () => overlay.remove();

  // 全天待办没有提醒提前量：时间清空时禁用提醒档位
  const timeInput = $('time');
  const leadSelect = $('remindLead');
  const syncLeadEnabled = () => { leadSelect.disabled = !timeInput.value; };
  timeInput.addEventListener('input', syncLeadEnabled);
  syncLeadEnabled();

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-action="save"]').addEventListener('click', () => {
    errorEl.hidden = true;
    const result = onSaved({
      id: existing?.id,
      title: $('title').value,
      date: $('date').value,
      time: timeInput.value,
      remindLead: Number(leadSelect.value),
      repeat: $('repeat').value,
      note: $('note').value,
    });
    if (result && !result.ok) {
      errorEl.textContent = result.error;
      errorEl.hidden = false;
      return;
    }
    close();
  });
}

// ——— 页面主体 ———

export function mountSchedulePage(el, { repo } = {}) {
  // 监听挂在自建子节点上：面板窗 storage 事件会整页重挂载，避免监听器堆积
  const page = document.createElement('div');
  page.className = 'schedule-page';
  el.replaceChildren(page);

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth(); // 0 基
  let selected = todayStr();

  function render() {
    const items = repo.listSchedules();
    const nowMs = Date.now();

    // 月历网格：周一起始，6 行 7 列覆盖整月
    const first = new Date(viewYear, viewMonth, 1);
    const gridStart = new Date(viewYear, viewMonth, 1 - ((first.getDay() + 6) % 7));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const dateStr = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const dayItems = items.filter((s) => s.date === dateStr);
      const dots = dayItems.slice(0, 3).map((s) => `<i class="cal-dot${s.done ? ' done' : ''}${s.time ? '' : ' allday'}"></i>`).join('');
      const extra = dayItems.length > 3 ? `<i class="cal-more">+${dayItems.length - 3}</i>` : '';
      cells.push(`
        <button class="calendar-cell${d.getMonth() !== viewMonth ? ' dim' : ''}${dateStr === todayStr() ? ' today' : ''}${dateStr === selected ? ' sel' : ''}"
                data-sch="pick" data-date="${dateStr}" title="${dateStr}">
          <span class="cal-day">${d.getDate()}</span><span class="cal-dots">${dots}${extra}</span>
        </button>`);
    }

    // 当日列表（过期未完成标记）
    const dayItems = items
      .filter((s) => s.date === selected)
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    const dayRows = dayItems.map((s) => {
      const overdue = s.time && !s.done && new Date(`${s.date}T${s.time}:00`).getTime() < nowMs;
      return `
        <div class="sch-item${s.done ? ' done' : ''}${overdue ? ' overdue' : ''}">
          <input type="checkbox" data-sch="done" data-id="${s.id}" ${s.done ? 'checked' : ''} title="${s.done ? '标记未完成' : '标记完成'}">
          <span class="sch-time">${s.time ? escapeHtml(s.time) : '全天'}</span>
          <span class="sch-title" title="${escapeHtml(s.note || '')}">${escapeHtml(s.title)}${s.repeat !== 'none' ? `<i class="sch-badge">${REPEAT_LABELS[s.repeat]}</i>` : ''}</span>
          <button class="btn small ghost" data-sch="edit" data-id="${s.id}" title="编辑">✎</button>
          <button class="btn small ghost danger" data-sch="del" data-id="${s.id}" title="删除">✕</button>
        </div>`;
    }).join('') || '<p class="sch-empty">当天没有日程，点「＋ 新增」记一条。</p>';

    // 「接下来」：未来的提醒时刻（跨天看最近的几条）
    const upcoming = upcomingInstances(items.filter((s) => !s.done), { fromMs: nowMs, count: 5 });
    const upcomingRows = upcoming.map((t) => `
      <li><span class="sch-up-time">${dayLabel(t.at, new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime())} ${fmtHM(t.at)}</span><span class="sch-up-title">${escapeHtml(t.title)}</span></li>`
    ).join('') || '<li class="sch-empty">近期没有带时间的日程。</li>';

    const selD = new Date(`${selected}T00:00:00`);
    const selectedLabel = `${selD.getMonth() + 1}月${selD.getDate()}日 周${WEEKDAYS[(selD.getDay() + 6) % 7]}`;

    page.innerHTML = `
      <div class="schedule-layout">
        <div class="schedule-cal">
          <div class="schedule-toolbar">
            <div class="schedule-nav">
              <button class="btn icon-btn" data-sch="prev" title="上个月">‹</button>
              <b class="schedule-month">${viewYear} 年 ${viewMonth + 1} 月</b>
              <button class="btn icon-btn" data-sch="next" title="下个月">›</button>
              <button class="btn small" data-sch="today">今天</button>
            </div>
            <button class="btn primary small" data-sch="add">＋ 新增</button>
          </div>
          <div class="calendar-grid">
            ${WEEKDAYS.map((w) => `<div class="calendar-weekname">${w}</div>`).join('')}
            ${cells.join('')}
          </div>
        </div>
        <aside class="schedule-side">
          <section class="schedule-day">
            <div class="schedule-day-head"><b>${escapeHtml(selectedLabel)}</b><span>${dayItems.length} 项</span></div>
            <div class="schedule-day-list">${dayRows}</div>
          </section>
          <section class="schedule-upcoming">
            <div class="schedule-day-head"><b>接下来</b><span>桌宠到点提醒</span></div>
            <ul class="sch-up-list">${upcomingRows}</ul>
          </section>
        </aside>
      </div>`;
  }

  function openForm(existing) {
    openScheduleForm({
      mount: document.body,
      existing,
      defaultDate: selected,
      onSaved: (data) => {
        const prev = data.id ? repo.listSchedules().find((s) => s.id === data.id) || null : null;
        const result = upsertSchedule(repo, data, prev);
        if (result.ok) {
          selected = result.item.date;
          const d = new Date(`${result.item.date}T00:00:00`);
          viewYear = d.getFullYear();
          viewMonth = d.getMonth();
          render();
        }
        return result;
      },
    });
  }

  page.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-sch]');
    if (!btn) return;
    const { sch, id, date } = btn.dataset;
    if (sch === 'prev') {
      viewMonth -= 1;
      if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
      render();
    } else if (sch === 'next') {
      viewMonth += 1;
      if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
      render();
    } else if (sch === 'today') {
      const t = new Date();
      viewYear = t.getFullYear();
      viewMonth = t.getMonth();
      selected = todayStr(t);
      render();
    } else if (sch === 'pick') {
      selected = date;
      render();
    } else if (sch === 'add') {
      openForm(null);
    } else if (sch === 'edit') {
      openForm(repo.listSchedules().find((s) => s.id === id) || null);
    } else if (sch === 'del') {
      const item = repo.listSchedules().find((s) => s.id === id);
      if (!item) return;
      const ok = await styledConfirm({
        mount: document.body,
        title: '删除日程',
        message: `确定删除「${item.title}」吗？该操作不可恢复。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      removeSchedule(repo, id);
      render();
    }
  });

  page.addEventListener('change', (e) => {
    const box = e.target.closest('[data-sch="done"]');
    if (!box) return;
    toggleScheduleDone(repo, box.dataset.id, box.checked);
    render();
  });

  render();
}
