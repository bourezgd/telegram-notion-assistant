import { queryItems } from './alerts.js';
import { DAY, SOURCES } from './core.js';
import { CANCEL_BTN, draftSummary, showStep } from './messages.js';
import { PRAYERS, prayerTimes } from './prayer.js';
import { fmtTime, localDate, zonedToUtc } from './time.js';

// ───────────────────────── 🧠 الجدولة الذكية ─────────────────────────
//
// في خطوة الساعة عند الإضافة: «🧠 اقترح وقتًا فارغًا» ← أقرب 3 أوقات فارغة في ذلك اليوم (بين SLOT_FROM و SLOT_TO،
// كل نصف ساعة) بعيدًا عن المهام والمواعيد المؤقّتة (نصف ساعة لكل منها، وساعة للمواعيد الطبية) وعن الصلوات
// (من الأذان إلى ما بعده بـ 20 دقيقة)، وبعد الآن بنصف ساعة إن كان اليوم.

const SLOT_MIN = 30;
const busyAround = (start, minutes) => [start - 15 * 60e3, start + minutes * 60e3];

export async function freeSlots(env, date, count = 3) {
  const tz = env.TZ_NAME, from = zonedToUtc(date, '00:00', tz);
  const items = (await Promise.all(['task', 'reminder', 'health'].map(kind => queryItems(env, kind, { and: [
    { property: SOURCES[kind].date, date: { on_or_after: new Date(from - DAY).toISOString() } },
    { property: SOURCES[kind].date, date: { before: new Date(from + 2 * DAY).toISOString() } },
  ] }).catch(() => [])))).flat().filter(i => i.hasTime && i.localDate === date && !SOURCES[i.kind].closed.includes(i.status));
  const times = prayerTimes(date, env);
  const busy = [
    ...items.map(i => busyAround(Date.parse(i.start), i.kind === 'health' ? 60 : SLOT_MIN)),
    ...PRAYERS.map(p => [times[p.key] - 5 * 60e3, times[p.key] + 20 * 60e3]),
  ];
  const earliest = date === localDate(Date.now(), tz) ? Date.now() + 30 * 60e3 : 0;
  const out = [];
  for (let t = zonedToUtc(date, env.SLOT_FROM || '08:00', tz), end = zonedToUtc(date, env.SLOT_TO || '22:00', tz); t <= end && out.length < count; t += SLOT_MIN * 60e3) {
    if (t < earliest) continue;
    const slotEnd = t + SLOT_MIN * 60e3;
    if (busy.some(([a, b]) => t < b && slotEnd > a)) continue;
    out.push(fmtTime(t, env));
  }
  return out;
}

export async function askSmartTime(env, d) {
  const slots = await freeSlots(env, d.date);
  const b = (text, v) => ({ text, callback_data: `a|t|${v}` });
  const text = slots.length
    ? `${draftSummary(d, env)}\n\n🧠 <b>أوقات فارغة في ذلك اليوم</b> (بعيدًا عن مهامك والصلوات):`
    : `${draftSummary(d, env)}\n\n🧠 لا وقت فارغًا بين 08:00 و22:00 في ذلك اليوم — اختر وقتًا بنفسك:`;
  return showStep(env, d, text, { inline_keyboard: [
    ...(slots.length ? [slots.map(t => b(`🕘 ${t}`, t.replace(':', '')))] : []),
    [b('⌨️ وقت آخر', 'type'), b('بلا ساعة محددة', 'none')],
    [CANCEL_BTN],
  ] });
}
