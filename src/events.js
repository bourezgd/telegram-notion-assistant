import { DAY, DS } from './core.js';
import { say } from './messages.js';
import { queryAll } from './money.js';
import { addDays, fmtDay, localDate, pastLocalTime, shortDay } from './time.js';
import { esc, plainText } from './view.js';

// ───────────────────────── المناسبات العائلية ─────────────────────────
//
// من «🎂 المناسبات العائلية»: تذكير يوميّ الساعة EVENTS_TIME قبل 7 أيام، وقبل يوم، ويوم المناسبة،
// وقبل 30 يومًا لما عليه «يحتاج هدية». العمر/عدد السنوات يُحسب من سنة التاريخ الأصلي.
// /events أو «المناسبات»: كل المناسبات القادمة مرتّبة.

export const EVENT_ICON = { 'عيد ميلاد': '🎂', 'عيد زواج': '💍', 'ذكرى': '🕰️', 'موعد مهم': '📌' };
export const EVENT_OFFSETS = [0, 1, 7];
export const GIFT_OFFSET = 30;

// «بعد يوم / يومين / 3 أيام / 15 يومًا»
export const inDaysText = n => n === 1 ? 'بعد يوم' : n === 2 ? 'بعد يومين' : n <= 10 ? `بعد ${n} أيام` : `بعد ${n} يومًا`;
export const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

// أقرب تكرار سنوي للتاريخ ابتداءً من اليوم (29 فبراير ← 28 في السنوات غير الكبيسة)
export function nextAnniversary(dateStr, today) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const ty = Number(today.slice(0, 4));
  for (const yy of [ty, ty + 1]) {
    const s = `${yy}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysIn(yy, m))).padStart(2, '0')}`;
    if (s >= today) return { date: s, years: yy - y };
  }
}

export async function loadEvents(env, today) {
  const rows = await queryAll(env, DS.events, null);
  return rows.map(p => {
    const pr = p.properties, start = pr['التاريخ']?.date?.start;
    if (!start) return null;
    const next = nextAnniversary(start.slice(0, 10), today);
    return {
      id: p.id, url: p.url, title: plainText(pr['المناسبة']) || '(بلا عنوان)', person: plainText(pr['الشخص']),
      type: pr['النوع']?.select?.name || 'موعد مهم', gift: pr['يحتاج هدية']?.checkbox === true, note: plainText(pr['تذكير/هدية']),
      next: next.date, years: next.years, days: daysBetween(today, next.date),
    };
  }).filter(Boolean).sort((a, b) => a.days - b.days);
}

export function yearsText(e) {
  const n = e.years;
  if (n <= 0) return '';
  const w = n === 1 ? 'سنة واحدة' : n === 2 ? 'سنتان' : n <= 10 ? `${n} سنوات` : `${n} سنة`;
  if (e.type === 'عيد ميلاد') return `يُتمّ ${w}`;
  if (e.type === 'عيد زواج') return `${w} من الزواج`;
  return `مرّت ${w}`;
}

export function eventMessage(e, env, off = e.days) {
  const icon = EVENT_ICON[e.type] || '📌';
  const when = e.days === 0 ? 'اليوم' : e.days === 1 ? 'غدًا' : e.days === 7 ? 'بعد أسبوع' : e.days === 30 ? 'بعد شهر' : inDaysText(e.days);
  const head = off === GIFT_OFFSET ? `🎁 <b>${when}: ${esc(e.title)}</b> — وقت تجهيز الهدية` : `${icon} <b>${when}: ${esc(e.title)}</b>${e.days === 0 ? ' 🎉' : ''}`;
  const lines = [head, `📆 ${esc(fmtDay(e.next, env))}${yearsText(e) ? ` · ${esc(yearsText(e))}` : ''}`];
  if (e.person) lines.push(`👤 ${esc(e.person)}`);
  if (e.gift && e.days > 0) lines.push(`🎁 ${esc(e.note || 'لا تنسَ الهدية')}`);
  lines.push(`<a href="${esc(e.url)}">فتح في Notion</a>`);
  return lines.join('\n');
}

export async function checkEvents(env, now) {
  if (!pastLocalTime(now, env, env.EVENTS_TIME || '09:00')) return;
  const today = localDate(now, env.TZ_NAME);
  if ((await env.STATE.get('evday')) === today) return;
  // كل تذكير (مناسبة، موعدها، مسافته) يُرسل مرة؛ وإن فات يومه (تعطّل البوت) يُتدارك ما دام قبل التذكير الذي يليه
  const sent = (await env.STATE.get('evsent', 'json')) || {};
  for (const e of await loadEvents(env, today)) {
    const offsets = [...(e.gift ? [GIFT_OFFSET] : []), ...EVENT_OFFSETS].sort((a, b) => b - a); // 30، 7، 1، 0
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i], nextOff = offsets[i + 1] ?? -1, key = `${e.id}:${e.next}:${off}`;
      if (e.days <= off && e.days > nextOff && !sent[key]) {
        await say(env, eventMessage(e, env, off));
        sent[key] = today;
      }
    }
  }
  for (const [k, d] of Object.entries(sent)) if (d < addDays(today, -60)) delete sent[k];
  await env.STATE.put('evsent', JSON.stringify(sent));
  await env.STATE.put('evday', today, { expirationTtl: 3 * 24 * 3600 });
}

export async function eventsList(env) {
  const today = localDate(Date.now(), env.TZ_NAME);
  const list = await loadEvents(env, today);
  if (!list.length) return '🎂 لا مناسبات مسجّلة في Notion.';
  const lines = ['🎂 <b>المناسبات القادمة</b>', ''];
  for (const e of list) {
    const when = e.days === 0 ? '<b>اليوم</b>' : e.days === 1 ? '<b>غدًا</b>' : inDaysText(e.days);
    lines.push(`${EVENT_ICON[e.type] || '📌'} <b>${esc(e.title)}</b>${e.gift ? ' 🎁' : ''}`,
      `     ${esc(shortDay(e.next))} · ${when}${yearsText(e) ? ` · ${esc(yearsText(e))}` : ''}`);
  }
  return lines.join('\n');
}
