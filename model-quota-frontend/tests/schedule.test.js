import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRepository, memoryStorage } from '../src/core/storage.js';
import {
  normalizeScheduleItem, todayStr,
  upsertSchedule, removeSchedule, toggleScheduleDone,
  expandInstances, upcomingInstances, syncScheduleReminders,
} from '../src/core/schedule.js';

// 固定「现在」：2026-09-15 12:00 本地时间，避免测试随真实时间漂移
function fixedNow() {
  return new Date(2026, 8, 15, 12, 0, 0, 0).getTime();
}
const DAY = 24 * 60 * 60 * 1000;
const NOW = fixedNow();
const dateStr = (ms) => {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const timeStr = (ms) => {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe('normalizeScheduleItem', () => {
  it('表单输入转换为规范结构', () => {
    const r = normalizeScheduleItem({ title: ' 周会 ', date: '2026-09-16', time: '15:00', remindLead: '15', repeat: 'weekly', note: ' 带笔记本 ' });
    expect(r.ok).toBe(true);
    expect(r.item).toMatchObject({
      title: '周会', date: '2026-09-16', time: '15:00', remindLead: 15, repeat: 'weekly', note: '带笔记本', done: false,
    });
    expect(r.item.id).toBeTruthy();
    expect(r.item.createdAt).toBeTruthy();
  });

  it('时间留空 = 全天待办，提醒提前量归零', () => {
    const r = normalizeScheduleItem({ title: '买菜', date: '2026-09-16', time: '', remindLead: 30 });
    expect(r.ok).toBe(true);
    expect(r.item.time).toBeNull();
    expect(r.item.remindLead).toBe(0);
  });

  it('非法档位与未知重复回退默认', () => {
    const r = normalizeScheduleItem({ title: 'x', date: '2026-09-16', time: '10:00', remindLead: 7, repeat: 'yearly' });
    expect(r.ok).toBe(true);
    expect(r.item.remindLead).toBe(0);
    expect(r.item.repeat).toBe('none');
  });

  it('标题缺失 / 日期或时间格式非法 → 报错', () => {
    expect(normalizeScheduleItem({ title: '  ', date: '2026-09-16' })).toMatchObject({ ok: false });
    expect(normalizeScheduleItem({ title: 'x', date: '2026-9-6' })).toMatchObject({ ok: false });
    expect(normalizeScheduleItem({ title: 'x', date: '2026-13-01' })).toMatchObject({ ok: false });
    expect(normalizeScheduleItem({ title: 'x', date: '2026-09-16', time: '25:00' })).toMatchObject({ ok: false });
    expect(normalizeScheduleItem({ title: 'x', date: '2026-09-16', time: '9:00' })).toMatchObject({ ok: false });
  });

  it('编辑时保留原 id / createdAt / done', () => {
    const created = normalizeScheduleItem({ title: '旧', date: '2026-09-15', time: '08:00' }).item;
    const edited = normalizeScheduleItem({ title: '新标题', date: '2026-09-15', time: '09:00', done: true }, created);
    expect(edited.ok).toBe(true);
    expect(edited.item.id).toBe(created.id);
    expect(edited.item.createdAt).toBe(created.createdAt);
    expect(edited.item.done).toBe(true);
    expect(edited.item.title).toBe('新标题');
  });
});

describe('日程 CRUD（repo 层）', () => {
  let repo;
  beforeEach(() => { repo = createRepository(memoryStorage()); });

  it('upsert 新增与更新', () => {
    const r1 = upsertSchedule(repo, { title: 'A', date: '2026-09-16', time: '10:00' });
    const r2 = upsertSchedule(repo, { title: 'B', date: '2026-09-17' });
    expect(repo.listSchedules()).toHaveLength(2);
    upsertSchedule(repo, { title: 'A2', date: '2026-09-16', time: '11:00' }, r1.item);
    const list = repo.listSchedules();
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.id === r1.item.id).title).toBe('A2');
    expect(list.find((s) => s.id === r2.item.id).title).toBe('B');
  });

  it('校验失败不写入', () => {
    const r = upsertSchedule(repo, { title: '', date: '2026-09-16' });
    expect(r.ok).toBe(false);
    expect(repo.listSchedules()).toHaveLength(0);
  });

  it('removeSchedule 删除', () => {
    const r = upsertSchedule(repo, { title: 'A', date: '2026-09-16', time: '10:00' });
    removeSchedule(repo, r.item.id);
    expect(repo.listSchedules()).toHaveLength(0);
  });

  it('toggleScheduleDone 切换完成', () => {
    const r = upsertSchedule(repo, { title: 'A', date: '2026-09-16' });
    toggleScheduleDone(repo, r.item.id, true);
    expect(repo.listSchedules()[0].done).toBe(true);
    toggleScheduleDone(repo, r.item.id, false);
    expect(repo.listSchedules()[0].done).toBe(false);
  });

  it('todayStr 输出本地当天 YYYY-MM-DD', () => {
    expect(todayStr(new Date(2026, 8, 5, 7, 3))).toBe('2026-09-05');
  });
});

describe('expandInstances（重复展开）', () => {
  // 2026-09-15 是周二；2026-09-30 是 9 月最后一天
  const win = { fromMs: NOW, toMs: NOW + 7 * DAY };

  it('单次日程：dueAt = 开始时刻 − 提前量，key = id@dueAt', () => {
    const items = [{ id: 'a1', title: '周会', date: '2026-09-16', time: '15:00', remindLead: 15, repeat: 'none', note: '' }];
    const out = expandInstances(items, win);
    expect(out).toHaveLength(1);
    const start = new Date(2026, 8, 16, 15, 0).getTime();
    expect(out[0].dueAt).toBe(start - 15 * 60 * 1000);
    expect(out[0].at).toBe(start);
    expect(out[0].key).toBe(`a1@${out[0].dueAt}`);
    expect(timeStr(out[0].at)).toBe('15:00');
  });

  it('无时间待办 / 已完成不产生提醒', () => {
    const items = [
      { id: 't1', title: '全天待办', date: '2026-09-16', time: null, remindLead: 0, repeat: 'none', done: false },
      { id: 'd1', title: '已完成', date: '2026-09-16', time: '10:00', remindLead: 0, repeat: 'none', done: true },
    ];
    expect(expandInstances(items, win)).toHaveLength(0);
  });

  it('每天重复：窗口内逐日展开并按 dueAt 升序', () => {
    const items = [{ id: 'r1', title: '站会', date: '2026-09-16', time: '09:30', remindLead: 0, repeat: 'daily' }];
    const out = expandInstances(items, win);
    expect(out).toHaveLength(7);
    expect(dateStr(out[0].at)).toBe('2026-09-16');
    expect(dateStr(out[6].at)).toBe('2026-09-22');
    expect(out[0].dueAt).toBeLessThanOrEqual(out[6].dueAt);
  });

  it('每周重复：间隔 7 天', () => {
    const items = [{ id: 'w1', title: '周报', date: '2026-09-16', time: '10:00', remindLead: 0, repeat: 'weekly' }];
    const out = expandInstances(items, { fromMs: NOW, toMs: NOW + 10 * DAY });
    expect(out.map((x) => dateStr(x.at))).toEqual(['2026-09-16', '2026-09-23']);
  });

  it('每月重复：31 日遇小月顺延且不重复触发', () => {
    const items = [{ id: 'm1', title: '账单日', date: '2026-01-31', time: '09:00', remindLead: 0, repeat: 'monthly' }];
    // 2-5 月窗口：1/31 → 2/31 归一为 3/3（2026 年 2 月 28 天），3/31 正常，4/31 归一为 5/1
    const from = new Date(2026, 1, 1).getTime();
    const out = expandInstances(items, { fromMs: from, toMs: from + 120 * DAY });
    const dates = out.map((x) => dateStr(x.at));
    expect(dates[0]).toBe('2026-03-03');
    // 归一化日期必须严格递增（无重复触发）
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] > dates[i - 1]).toBe(true);
    }
  });

  it('窗口边界：fromMs 之前不产出，toMs 边界含当天', () => {
    const items = [{ id: 'r1', title: '站会', date: '2026-09-10', time: '23:50', remindLead: 0, repeat: 'daily' }];
    // NOW = 09-15 12:00 → 当天 23:50 在窗口内，09-15 之前的不产出
    const out = expandInstances(items, win);
    expect(dateStr(out[0].at)).toBe('2026-09-15');
    expect(out).toHaveLength(7);
  });

  it('提前量把开始时刻尚未到期的日程拉进提醒窗口', () => {
    const items = [{ id: 'l1', title: '早鸟', date: '2026-09-15', time: '12:30', remindLead: 60, repeat: 'none' }];
    // 开始 09-15 12:30（晚于 NOW），提前 60 分 → due 09-15 11:30，落在 [NOW-1天, NOW] 内
    const out = expandInstances(items, { fromMs: NOW - DAY, toMs: NOW });
    expect(out).toHaveLength(1);
    expect(dateStr(out[0].dueAt)).toBe('2026-09-15');
    expect(timeStr(out[0].dueAt)).toBe('11:30');
  });

  it('limit 截断总数', () => {
    const items = [{ id: 'r1', title: '心跳', date: '2026-09-01', time: '00:00', remindLead: 0, repeat: 'daily' }];
    const out = expandInstances(items, { fromMs: NOW, toMs: NOW + 365 * DAY, limit: 5 });
    expect(out).toHaveLength(5);
  });
});

describe('upcomingInstances', () => {
  it('按时间取最近的几条（跨多条日程）', () => {
    const items = [
      { id: 'b', title: '晚', date: '2026-09-15', time: '20:00', remindLead: 0, repeat: 'none', done: false },
      { id: 'a', title: '午', date: '2026-09-15', time: '13:00', remindLead: 0, repeat: 'none', done: false },
      { id: 'c', title: '明', date: '2026-09-16', time: '09:00', remindLead: 0, repeat: 'none', done: false },
      { id: 'past', title: '已过', date: '2026-09-15', time: '08:00', remindLead: 0, repeat: 'none', done: false },
    ];
    const out = upcomingInstances(items, { fromMs: NOW, count: 2 });
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('syncScheduleReminders', () => {
  let captured;
  beforeEach(() => {
    captured = [];
    globalThis.__TAURI__ = { core: { invoke: (cmd, args) => { captured.push([cmd, args]); return Promise.resolve(); } } };
  });
  afterEach(() => { delete globalThis.__TAURI__; });

  it('桌面版：把窗口内实例同步给 set_schedule_reminders（含 timeText）', () => {
    const repo = createRepository(memoryStorage());
    // 动态取「明天」（硬编码日期会随时间推移掉出 7 天同步窗口，成为时间炸弹）
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const p2 = (x) => String(x).padStart(2, '0');
    const tDate = `${tomorrow.getFullYear()}-${p2(tomorrow.getMonth() + 1)}-${p2(tomorrow.getDate())}`;
    const r = normalizeScheduleItem({ title: '周会', date: tDate, time: '15:00', remindLead: 5 });
    repo.saveSchedule(r.item);
    syncScheduleReminders(repo); // upsert 内部也会同步，这里手动构造精确计数
    expect(captured).toHaveLength(1);
    const [cmd, { tasks }] = captured[0];
    expect(cmd).toBe('set_schedule_reminders');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('周会');
    expect(tasks[0].timeText).toBe('15:00');
    expect(tasks[0].key).toContain('@');
  });

  it('增删改都会自动重同步', () => {
    const repo = createRepository(memoryStorage());
    const r = upsertSchedule(repo, { title: 'x', date: '2026-09-16', time: '10:00' });
    removeSchedule(repo, r.item.id);
    expect(captured).toHaveLength(2);
    const [, { tasks }] = captured[1];
    expect(tasks).toHaveLength(0);
  });

  it('网页版（无 __TAURI__）为空操作', () => {
    delete globalThis.__TAURI__;
    const repo = createRepository(memoryStorage());
    upsertSchedule(repo, { title: 'x', date: '2026-09-16', time: '10:00' });
    expect(captured).toHaveLength(0);
  });
});
