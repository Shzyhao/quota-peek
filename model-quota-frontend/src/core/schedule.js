// 日程与待办：数据模型、重复规则展开、桌宠提醒同步。
// 数据存 repo（localStorage `mqc.schedules`），同源各窗（主窗 / 日程面板）共享；
// 提醒时钟在 Rust 常驻线程（commands.rs「日程提醒调度」段，schedule.json 持久化），
// 前端只负责把未来一段窗口内的提醒实例同步过去——与定时刷新同一套「后端持钟」设计，
// 不受 WebView 隐藏窗口定时器节流影响。

import { newId } from './storage.js';

export const REPEAT_LABELS = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' };
export const REPEATS = Object.keys(REPEAT_LABELS);

/// 提前提醒档位（分钟）；0 = 准点。仅带时间的日程有意义
export const LEAD_OPTIONS = [0, 5, 10, 15, 30, 60];

/// 提醒实例同步窗口：只同步 [now - MISSED_WINDOW_MS, now + LOOKAHEAD_DAYS 天]。
/// 窗口耗尽后 Rust 发 schedule-queue-low 请求补货（见 syncScheduleReminders）
const LOOKAHEAD_DAYS = 7;
/// 晚于提醒点这么久以内仍算「新鲜错过」→ 立即补报（带 missed 标记）；
/// 再旧（休眠跨夜、长期未开机）的静默吞掉。Rust 侧用同一常量兜底
export const MISSED_WINDOW_MS = 15 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad2 = (x) => String(x).padStart(2, '0');

export function todayStr(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// 表单输入 → 规范日程结构；校验失败返回 { ok:false, error }
export function normalizeScheduleItem(input, existing = null) {
  const title = String(input?.title || '').trim();
  const date = String(input?.date || '').slice(0, 10);
  const time = String(input?.time || '').trim();
  if (!title) return { ok: false, error: '请填写标题' };
  if (!DATE_RE.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime())) {
    return { ok: false, error: '日期无效' };
  }
  if (time && !TIME_RE.test(time)) return { ok: false, error: '时间无效' };
  const repeat = REPEATS.includes(input?.repeat) ? input.repeat : 'none';
  const lead = LEAD_OPTIONS.includes(Number(input?.remindLead)) ? Number(input.remindLead) : 0;
  return {
    ok: true,
    item: {
      id: existing?.id || input?.id || newId(),
      title,
      date,
      time: time || null,
      // 全天待办没有「到点」概念，提醒提前量一并归零
      remindLead: time ? lead : 0,
      repeat,
      note: String(input?.note || '').trim(),
      done: input?.done != null ? input.done === true : existing?.done === true,
      createdAt: existing?.createdAt || input?.createdAt || new Date().toISOString(),
    },
  };
}

// ——— 高层操作（视图层用）：写入后同步提醒到后端 ———

export function upsertSchedule(repo, input, existing = null) {
  const normalized = normalizeScheduleItem(input, existing);
  if (!normalized.ok) return normalized;
  repo.saveSchedule(normalized.item);
  syncScheduleReminders(repo);
  return normalized;
}

export function removeSchedule(repo, id) {
  repo.deleteSchedule(id);
  syncScheduleReminders(repo);
}

export function toggleScheduleDone(repo, id, done) {
  const list = repo.listSchedules();
  const item = list.find((s) => s.id === id);
  if (!item) return;
  item.done = done === true;
  repo.saveSchedules(list);
  syncScheduleReminders(repo);
}

/// 把未来窗口内的提醒实例同步给后端调度线程（非桌面环境为空操作）。
/// 幂等：Rust 侧对相同队列直接忽略，任意窗口在任意时机调用都安全
export function syncScheduleReminders(repo) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const now = Date.now();
  const tasks = expandInstances(repo.listSchedules(), {
    fromMs: now - MISSED_WINDOW_MS,
    toMs: now + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
  }).map(({ key, id, title, note, dueAt, at }) => ({
    key, id, title, note, dueAt, at,
    // HH:mm 文本一并带给后端（Rust 无本地时区库，系统通知回退时直接展示）
    timeText: `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`,
  }));
  invoke('set_schedule_reminders', { tasks }).catch(() => {});
}

// ——— 时间与展开 ———

// 某天的日程开始时刻（本地时区 ms）；time 为 null（全天待办）按 00:00
function startAtMs(date, time) {
  return new Date(`${date}T${time || '00:00'}:00`).getTime();
}

// 按重复规则逐个产出日程开始时刻（本地时区 ms），从 item.date 起无限序列，
// 调用方必须在超出窗口后 break。monthly 走 Date 归一化（如 31 日遇 2 月顺延到 3 月初）
function* occurrences(item) {
  const [y, m, d] = item.date.split('-').map(Number);
  const [hh, mm] = (item.time || '00:00').split(':').map(Number);
  if (item.repeat === 'daily') {
    for (let i = 0; ; i++) yield new Date(y, m - 1, d + i, hh, mm).getTime();
  } else if (item.repeat === 'weekly') {
    for (let i = 0; ; i++) yield new Date(y, m - 1, d + 7 * i, hh, mm).getTime();
  } else if (item.repeat === 'monthly') {
    for (let i = 0; ; i++) yield new Date(y, m - 1 + i, d, hh, mm).getTime();
  } else {
    yield startAtMs(item.date, item.time);
  }
}

/// 把日程列表展开成窗口 [fromMs, toMs] 内的具体提醒实例（按 dueAt 升序）：
/// { key: 'id@dueAt', id, title, note, dueAt, at, lead }。
/// key 供 Rust 记录已触发集合（防重启/补发重复）；at = 原定开始时刻（展示用）。
/// 无时间的待办、已完成的日程不产生提醒
export function expandInstances(items, { fromMs, toMs, limit = 500 } = {}) {
  const out = [];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || !item.time || item.done) continue;
    for (const start of occurrences(item)) {
      const dueAt = start - (item.remindLead || 0) * 60 * 1000;
      if (dueAt > toMs) break;
      if (dueAt >= fromMs) {
        out.push({
          key: `${item.id}@${dueAt}`,
          id: item.id,
          title: item.title,
          note: item.note || '',
          dueAt,
          at: start,
          lead: item.remindLead || 0,
        });
      }
      if (item.repeat === 'none' || out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.dueAt - b.dueAt);
  return out;
}

/// 「接下来」列表：从 fromMs 起未来 horizonDays 内最近的 count 条有时间的日程
export function upcomingInstances(items, { fromMs = Date.now(), horizonDays = 60, count = 5 } = {}) {
  return expandInstances(items, { fromMs, toMs: fromMs + horizonDays * 24 * 60 * 60 * 1000, limit: 500 })
    .slice(0, count);
}
