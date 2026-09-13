import { collectAlerts } from './status.js';

// 桌宠主动搭话的拟人化文案：按时段问候 + 额度状态挑一句。纯函数，rng 注入便于测试。
// 返回 null = 此刻不说话（勿扰时段）；说话频率/开关由 pet.js 调用方控制。

export function isQuietHour(now) {
  const h = now.getHours();
  return h >= 23 || h < 8;
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function greetingOf(now) {
  const h = now.getHours();
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function pickChatterLine({ providers = [], settings, now = new Date(), rng = Math.random } = {}) {
  if (isQuietHour(now)) return null;

  const enabled = providers.filter((p) => p.enabled !== false);
  const alerts = collectAlerts(enabled, settings);

  // 有告警：以软提醒为主（语气轻，不重复系统通知的紧迫感）
  if (alerts.length && rng() < 0.6) {
    const a = pick(rng, alerts);
    const reason = a.reasons[0] || '有些状况';
    return pick(rng, [
      `主人，悄悄说～${a.name}那边${reason}，记得留意一下呀`,
      `那个…${a.name}有点状况（${reason}），要不去看看？`,
      `${greetingOf(now)}～不过${a.name}${reason}，我有点担心它呢`,
    ]);
  }

  // 用量型套餐：报最忙的那个
  const usageList = enabled.filter((p) => p.lastQuery?.status === 'ok' && p.lastQuery?.usage);
  if (usageList.length) {
    const busiest = usageList
      .map((p) => {
        const u = p.lastQuery.usage;
        return { name: p.name, v: Math.round(Math.max(u.windowUsedPercent ?? 0, u.weeklyUsedPercent ?? 0)) };
      })
      .sort((a, b) => b.v - a.v)[0];
    if (busiest.v >= 80) {
      return pick(rng, [
        `主人，${busiest.name}已经用到 ${busiest.v}% 啦，省着点用哦！`,
        `小声提醒～${busiest.name}用量 ${busiest.v}% 了，快到红线了呢`,
      ]);
    }
    return pick(rng, [
      `${greetingOf(now)}呀～${enabled.length} 家额度都乖乖的，最忙的${busiest.name}才 ${busiest.v}%`,
      '报告主人～一切正常，我盯着额度呢，放心玩～',
      `${greetingOf(now)}～目前最忙的是${busiest.name}（${busiest.v}%），还很宽裕哦`,
    ]);
  }

  // 余额型：报余额合计
  const withBalance = enabled.filter((p) => p.lastQuery?.status === 'ok' && p.lastQuery?.balance != null);
  if (withBalance.length) {
    const total = Math.round(withBalance.reduce((sum, p) => sum + Number(p.lastQuery.balance), 0));
    return pick(rng, [
      `${greetingOf(now)}～余额合计 ${total}，都好好的呢`,
      '我盯着呢～目前一切正常，主人安心呀',
    ]);
  }

  // 还没有数据
  return pick(rng, [
    `${greetingOf(now)}～我还没查过额度呢，要不去主界面刷新一下？`,
    '主人在忙呀？我在这儿待命，想聊天随时叫我～',
  ]);
}
