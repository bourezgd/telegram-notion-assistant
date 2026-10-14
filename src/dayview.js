import { parsePage, queryItems } from './alerts.js';
import { answer, notion } from './api.js';
import { snoozeDate } from './buttons.js';
import { DAY, SOURCES } from './core.js';
import { EVENT_ICON, loadEvents, yearsText } from './events.js';
import { withJiha } from './jihat.js';
import { PRAYERS, prayerName, prayerTimes, trackerRow } from './prayer.js';
import { STEP } from './repeat.js';
import { addDays, fmtDay, fmtTime, localDate, zonedToUtc } from './time.js';
import { editMessage, esc, shortTitle } from './view.js';

// ───────────────────────── عرض اليوم / الغد ─────────────────────────
//
// «📋 اليوم» / «📆 غدًا» (أو /اليوم /غدا /today /tomorrow): كل مهام اليوم ومواعيده وأفكاره المؤرّخة مرتّبة بالساعة،
// مع أوقات الصلاة. في عرض اليوم: لكل عنصر مفتوح ✅ و«➡️ غدًا» (أو «⛔» للمتكرر). callback: ls|<فعل>|<نوع>|<id>

export const TODAY_BTN = '📋 اليوم', TOMORROW_BTN = '📆 غدًا';
export const DAY_KINDS = ['task', 'reminder', 'health', 'idea'];
export const KIND_CODE = { task: 't', reminder: 'r', idea: 'i', health: 'h' };
export const CODE_KIND = { t: 'task', r: 'reminder', i: 'idea', h: 'health' };

// نفس منطق مراجعة المساء: تمّت / لم تُنجز / غدًا
export async function quickAction(env, kind, id, act) {
  const src = SOURCES[kind];
  if (act === 'd') {
    return notion(env, 'PATCH', `pages/${id}`, { properties: { [src.status]: { select: { name: src.done } } } });
  }
  if (act === 'n') {
    return notion(env, 'PATCH', `pages/${id}`, { properties: { [src.status]: { select: { name: kind === 'task' ? 'لم تُنجز' : src.cancelled } } } });
  }
  const item = parsePage(await notion(env, 'GET', `pages/${id}`), kind, env);
  const props = { [src.date]: { date: snoozeDate(item, 'day', env) } };
  if (kind === 'reminder' && item.status !== src.open) props[src.status] = { select: { name: src.open } };
  return notion(env, 'PATCH', `pages/${id}`, { properties: props });
}

export async function dayView(env, which) {
  const now = Date.now();
  const today = localDate(now, env.TZ_NAME);
  const date = which === 'today' ? today : addDays(today, 1);
  const from = zonedToUtc(date, '00:00', env.TZ_NAME);
  // نطاق أوسع بيوم من كل جهة ثم تصفية باليوم المحلي (المواعيد بلا ساعة تُقارن كتاريخ)
  const items = (await Promise.all(DAY_KINDS.map(kind => queryItems(env, kind, { and: [
    { property: SOURCES[kind].date, date: { on_or_after: new Date(from - DAY).toISOString() } },
    { property: SOURCES[kind].date, date: { before: new Date(from + 2 * DAY).toISOString() } },
  ] })))).flat().filter(i => i.localDate === date).sort((a, b) => a.alertAt - b.alertAt);
  await withJiha(env, items);

  const times = prayerTimes(date, env);
  const row = which === 'today' ? await trackerRow(env, date, false) : null;
  const prayLine = PRAYERS.map(p => `${prayerName(p.key, date)} ${fmtTime(times[p.key], env)}${row?.properties[p.name]?.checkbox ? ' ✅' : ''}`).join(' · ');

  const events = await loadEvents(env, today).then(l => l.filter(e => e.next === date)).catch(() => []);
  const isClosed = i => SOURCES[i.kind].closed.includes(i.status);
  const counted = items.filter(i => i.kind !== 'idea');
  const done = counted.filter(i => i.status === SOURCES[i.kind].done).length;
  const lines = [
    `${which === 'today' ? '📋' : '📆'} <b>${which === 'today' ? 'اليوم' : 'غدًا'} — ${esc(fmtDay(date, env))}</b>`,
    counted.length ? (which === 'today' ? `✅ أنجزت ${done} من ${counted.length}` : `📌 ${counted.length} في الجدول`) : '',
    `🕌 ${prayLine}`,
    ...events.map(e => `${EVENT_ICON[e.type] || '📌'} <b>${esc(e.title)}</b>${yearsText(e) ? ` · ${esc(yearsText(e))}` : ''}`),
    '',
  ].filter((l, i, a) => l || i === a.length - 1);
  if (!items.length) lines.push(which === 'today' ? 'لا مهام اليوم 🎉' : 'لا شيء غدًا بعد.');
  for (const i of items) {
    const when = i.hasTime ? fmtTime(Date.parse(i.start), env) : 'اليوم';
    const icon = i.kind === 'task' ? '' : `${SOURCES[i.kind].icon} `;
    const mark = isClosed(i) ? (i.status === SOURCES[i.kind].done ? '✅' : '⛔') : '▫️';
    const title = `${icon}${esc(i.title)}${STEP[i.repeat] ? ' 🔁' : ''}`;
    // لكل مهمة جهتها، والمهمة بلا جهة شخصية
    const jiha = i.kind === 'task' ? ` · ${i.jiha ? `🏢 ${esc(i.jiha)}` : '👤 شخصي'}` : '';
    lines.push(`<code>${when}</code> ${mark} ${isClosed(i) ? `<s>${title}</s>` : title}${jiha}`);
  }

  const rows = [];
  if (which === 'today') {
    for (const i of items.filter(x => !isClosed(x)).slice(0, 30)) {
      const c = `${KIND_CODE[i.kind]}|${i.id}`;
      rows.push([
        { text: `✅ ${shortTitle(i.title)}`, callback_data: `ls|d|${c}` },
        STEP[i.repeat] ? { text: '⛔ لم تُنجز', callback_data: `ls|n|${c}` } : { text: '➡️ غدًا', callback_data: `ls|m|${c}` },
      ]);
    }
    rows.push([{ text: '🔄 تحديث', callback_data: 'ls|r|t|0' }]);
  }
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

export async function onListButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, act, code, id] = String(cb.data).split('|');
  if (act !== 'r') {
    if (!CODE_KIND[code] || !/^[0-9a-f]{32}$/.test(id)) return answer(env, cb.id, 'زر غير صالح');
    await quickAction(env, CODE_KIND[code], id, act);
  }
  await answer(env, cb.id, { d: 'أحسنت ✅', n: 'سُجّلت', m: 'نُقلت لغدٍ', r: 'حُدّثت' }[act]);
  return editMessage(env, cb.message.message_id, await dayView(env, 'today'));
}
