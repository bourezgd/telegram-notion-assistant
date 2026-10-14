import { queryItems } from './alerts.js';
import { notion } from './api.js';
import { DAY, DS, SOURCES } from './core.js';
import { EVENT_ICON, loadEvents } from './events.js';
import { say } from './messages.js';
import { FIN, fmtDa, queryAll } from './money.js';
import { PRAYERS, TRACKER } from './prayer.js';
import { STEP } from './repeat.js';
import { TRK } from './spirit.js';
import { addDays, fmtDay, localDate, shortDay, zonedToUtc } from './time.js';
import { esc, plainText } from './view.js';

// ───────────────────────── التقرير الأسبوعي ─────────────────────────
//
// كل خميس (WEEKLY_DAY) الساعة WEEKLY_TIME، أو عند الطلب («📊 الأسبوع» / /week / تقرير):
// نسبة إنجاز المهام (ومقارنة بالأسبوع السابق)، الإنجاز حسب الجهة، أكثر ما لم يُنجز، المواعيد،
// الصلاة، الأفكار الجديدة، وأهم ما في الأسبوع القادم.

export const WEEK_BTN = '📊 الأسبوع';
export const JIHA_PROP = 'الجهة';

export async function checkWeekly(env, now) {
  const [hh, mm] = String(env.WEEKLY_TIME || '21:30').split(':').map(Number);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: env.TZ_NAME, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  if (day !== Number(env.WEEKLY_DAY ?? 4) || Number(parts.hour) * 60 + Number(parts.minute) < hh * 60 + mm) return;
  const today = localDate(now, env.TZ_NAME);
  if ((await env.STATE.get('weekly')) === today) return;
  await say(env, await weeklyReport(env, now));
  await env.STATE.put('weekly', today, { expirationTtl: 8 * 24 * 3600 });
}

export async function weeklyReport(env, now) {
  const tz = env.TZ_NAME;
  const today = localDate(now, tz);
  const start = addDays(today, -6), prevStart = addDays(today, -13), nextEnd = addDays(today, 7);
  const utc = d => zonedToUtc(d, '00:00', tz);
  const range = (kind, a, b) => queryItems(env, kind, { and: [
    { property: SOURCES[kind].date, date: { on_or_after: new Date(utc(a) - DAY).toISOString() } },
    { property: SOURCES[kind].date, date: { before: new Date(utc(b) + DAY).toISOString() } },
  ] });
  const inDays = (i, a, b) => i.localDate >= a && i.localDate <= b;

  const [tasks, reminders, jihat, tracker, ideas, money, health] = await Promise.all([
    range('task', prevStart, nextEnd),
    range('reminder', prevStart, nextEnd),
    notion(env, 'POST', `data_sources/${DS.jihat}/query`, { page_size: 100 }).catch(() => ({ results: [] })),
    notion(env, 'POST', `data_sources/${TRACKER.ds}/query`, { filter: { property: TRACKER.date, date: { on_or_after: start } }, page_size: 100 }),
    notion(env, 'POST', `data_sources/${SOURCES.idea.ds}/query`, { filter: { timestamp: 'created_time', created_time: { on_or_after: new Date(utc(start)).toISOString() } }, page_size: 100 }),
    queryAll(env, FIN.ds, { property: FIN.date, date: { on_or_after: start } }).catch(() => []),
    range('health', addDays(today, 1), nextEnd).catch(() => []),
  ]);

  // المهام: هذا الأسبوع مقابل السابق
  const stats = (list, kind) => {
    const done = list.filter(i => i.status === SOURCES[kind].done).length;
    return { done, total: list.length, pct: list.length ? Math.round(done / list.length * 100) : 0 };
  };
  // ما لم يحن موعده بعد (اليوم) لا يُحسب
  const due = i => i.alertAt <= now || SOURCES[i.kind].closed.includes(i.status);
  const week = tasks.filter(i => inDays(i, start, today) && due(i));
  const prev = tasks.filter(i => inDays(i, prevStart, addDays(start, -1)));
  const cur = stats(week, 'task'), old = stats(prev, 'task');
  const bar = p => '▓'.repeat(Math.round(p / 10)) + '░'.repeat(10 - Math.round(p / 10));

  const lines = [
    '📊 <b>التقرير الأسبوعي</b>',
    `<i>${esc(fmtDay(start, env))} ← ${esc(fmtDay(today, env))}</i>`,
    '',
    `✅ <b>المهام:</b> ${cur.done} من ${cur.total} (${cur.pct}%)`,
    `${bar(cur.pct)}${!old.total ? '' : cur.pct === old.pct ? '  ↔️ نفس الأسبوع الماضي' : `  ${cur.pct > old.pct ? '⬆️' : '⬇️'} ${Math.abs(cur.pct - old.pct)}% عن الأسبوع الماضي`}`,
  ];

  // حسب الجهة
  const names = Object.fromEntries(jihat.results.map(p => {
    const title = Object.values(p.properties).find(x => x.type === 'title');
    return [p.id, plainText(title).split(' — ')[0]];
  }));
  const byJiha = {};
  for (const i of week) {
    const ids = i.raw[JIHA_PROP]?.relation?.map(r => r.id) || [];
    for (const name of ids.length ? ids.map(id => names[id] || 'أخرى') : ['بلا جهة']) {
      const g = byJiha[name] ||= { done: 0, total: 0 };
      g.total++; if (i.status === SOURCES.task.done) g.done++;
    }
  }
  const groups = Object.entries(byJiha).sort((a, b) => b[1].total - a[1].total);
  if (groups.length) {
    lines.push('', '<b>حسب الجهة:</b>');
    for (const [name, g] of groups) {
      const p = Math.round(g.done / g.total * 100);
      lines.push(`${p >= 80 ? '🟢' : p >= 50 ? '🟡' : '🔴'} ${esc(name)}: ${g.done}/${g.total} (${p}%)`);
    }
  }

  // أكثر ما لم يُنجز (لم تُنجز أو بقي مفتوحًا بعد موعده)
  const missed = {};
  for (const i of week) if (i.status !== SOURCES.task.done && i.status !== SOURCES.task.cancelled && i.alertAt < now) missed[i.title] = (missed[i.title] || 0) + 1;
  const topMissed = Object.entries(missed).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topMissed.length) {
    lines.push('', '⛔ <b>أكثر ما لم يُنجز:</b>');
    for (const [t, n] of topMissed) lines.push(`• ${esc(t)}${n === 2 ? ' (مرتين)' : n > 2 ? ` (${n} مرات)` : ''}`);
  }

  // المواعيد
  const rs = stats(reminders.filter(i => inDays(i, start, today) && due(i)), 'reminder');
  if (rs.total) lines.push('', `📅 <b>المواعيد والتذكيرات:</b> ${rs.done} من ${rs.total}`);

  // الصلاة
  const rows = tracker.results.filter(r => (r.properties[TRACKER.date]?.date?.start || '') <= today);
  const perPrayer = PRAYERS.map(p => rows.filter(r => r.properties[p.name]?.checkbox).length);
  const prayed = perPrayer.reduce((a, b) => a + b, 0);
  lines.push('', `🕌 <b>الصلاة:</b> ${prayed} من 35 (${Math.round(prayed / 35 * 100)}%)`,
    PRAYERS.map((p, i) => `${p.name} ${perPrayer[i]}/7`).join(' · '));
  const am = rows.filter(r => r.properties[TRK.am]?.checkbox).length, pm = rows.filter(r => r.properties[TRK.pm]?.checkbox).length;
  const pages = rows.reduce((a, r) => a + (r.properties[TRK.wird]?.number || 0), 0);
  if (am || pm || pages) lines.push(`📿 الأذكار: الصباح ${am}/7 · المساء ${pm}/7${pages ? ` · 📖 الورد ${pages} صفحة` : ''}`);

  // المصاريف
  const spent = money.filter(r => r.properties[FIN.type]?.select?.name === 'مصروف' && (r.properties[FIN.date]?.date?.start || '').slice(0, 10) <= today)
    .reduce((a, r) => a + (r.properties[FIN.amount]?.number || 0), 0);
  if (spent) lines.push('', `💸 <b>المصاريف:</b> ${fmtDa(spent)} هذا الأسبوع`);

  // الأفكار
  if (ideas.results.length) lines.push('', `💡 <b>أفكار جديدة:</b> ${ideas.results.length}`);

  // الأسبوع القادم: غير المتكرر فقط (المتكرر معروف)
  const upcoming = [...tasks, ...reminders, ...health]
    .filter(i => inDays(i, addDays(today, 1), nextEnd) && !STEP[i.repeat] && !SOURCES[i.kind].closed.includes(i.status))
    .sort((a, b) => a.alertAt - b.alertAt).slice(0, 6);
  if (upcoming.length) {
    lines.push('', '🔜 <b>الأسبوع القادم:</b>');
    for (const i of upcoming) lines.push(`• ${esc(shortDay(i.localDate))}: ${i.kind === 'task' ? '' : SOURCES[i.kind].icon + ' '}${esc(i.title)}${i.person ? ` (${esc(i.person)})` : ''}`);
  }

  const evs = await loadEvents(env, today).then(l => l.filter(e => e.days >= 1 && e.days <= 7)).catch(() => []);
  if (evs.length) {
    if (!upcoming.length) lines.push('', '🔜 <b>الأسبوع القادم:</b>');
    for (const e of evs) lines.push(`• ${esc(shortDay(e.next))}: ${EVENT_ICON[e.type] || '📌'} ${esc(e.title)}${e.gift ? ' 🎁' : ''}`);
  }

  lines.push('', cur.pct >= 85 ? '🌟 أسبوع ممتاز، بارك الله فيك!' : cur.pct >= 60 ? '👍 أسبوع جيد، واصل.' : cur.total ? '💪 أسبوع جديد وفرصة جديدة.' : '');
  return lines.join('\n').trim();
}
