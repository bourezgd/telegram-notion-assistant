import { queryItems } from './alerts.js';
import { answer, notion } from './api.js';
import { DS, SOURCES } from './core.js';
import { daysBetween, daysIn } from './events.js';
import { TASK_WEEKEND_PROP, WEEKEND_PROP, isWeekend } from './jihat.js';
import { say } from './messages.js';
import { STEP } from './repeat.js';
import { addDays, addMonths, localDate, pastLocalTime, zonedToUtc } from './time.js';
import { editMessage, esc, plainText, shortTitle } from './view.js';
import { JIHA_PROP } from './weekly.js';

// ───────────────────────── 📊 الحصة الشهرية لكل جهة ─────────────────────────
//
// من «✅ المهام» ذات «الكمية» والمربوطة بجهة: لكل سلسلة (جهة + عنوان) في الشهر:
//   المخطط = كميات نسخ الشهر (غير الملغاة) + إسقاط التكرار التلقائي حتى آخر الشهر
//   المستحق حتى اليوم = ما حلّ موعده منها · المنجز = كميات «منجزة»
// /quota أو «الحصص»: التقرير، مع زرّي الشهر الماضي/الحالي. تنبيه تلقائي يوم 15 وقبل نهاية الشهر بـ 5 أيام
// إن تأخرت جهة، وتقرير نهائي للشهر الماضي يوم 1. callback: qt|<إزاحة الشهر>

export const QTY_PROP = 'الكمية';
export const MONTH_NAME = d => new Intl.DateTimeFormat('ar-DZ', { month: 'long', timeZone: 'UTC' }).format(new Date(d + 'T12:00:00Z'));
export const nextOf = (date, repeat) => { const [n, u] = STEP[repeat]; return u === 'd' ? addDays(date, n) : addMonths(date, n); };
// «3 أخبار» ← «أخبار» (الرقم في العنوان هو الكمية)
export const unitName = title => shortTitle(title.replace(/^\s*[\d٠-٩]+\s*/, ''), 22);

export async function monthQuota(env, now, offset = 0) {
  const tz = env.TZ_NAME, today = localDate(now, tz);
  const first = addMonths(today.slice(0, 8) + '01', offset), next = addMonths(first, 1), last = addDays(next, -1);
  const upTo = offset < 0 ? last : today; // الشهر الماضي: كل شيء مستحق
  const utc = d => new Date(zonedToUtc(d, '00:00', tz)).toISOString();
  const [items, jihat] = await Promise.all([
    queryItems(env, 'task', { and: [
      { property: SOURCES.task.date, date: { on_or_after: utc(first) } },
      { property: SOURCES.task.date, date: { before: utc(next) } },
      { property: QTY_PROP, number: { is_not_empty: true } },
    ] }),
    notion(env, 'POST', `data_sources/${DS.jihat}/query`, { page_size: 100 }).then(r => r.results).catch(() => []),
  ]);
  const jName = Object.fromEntries(jihat.map(p => [p.id, plainText(Object.values(p.properties).find(x => x.type === 'title')).split(' — ')[0]]));
  const jOrder = Object.fromEntries(jihat.map(p => [p.id, p.properties['ترتيب العرض']?.number ?? 99]));
  const weekdayOnly = Object.fromEntries(jihat.map(p => [p.id, p.properties[WEEKEND_PROP]?.checkbox !== true]));
  const series = {};
  for (const i of items) {
    const q = i.raw[QTY_PROP]?.number || 0;
    const jid = i.raw[JIHA_PROP]?.relation?.[0]?.id;
    if (!q || !jid || i.status === SOURCES.task.cancelled) continue;
    const s = series[`${jid}|${i.title}`] ||= { jid, title: i.title, q, planned: 0, due: 0, done: 0, last: null };
    s.planned += q;
    if (i.localDate <= upTo) s.due += q;
    if (i.status === SOURCES.task.done) s.done += q;
    if (!s.last || i.start > s.last.start) s.last = i;
  }
  // النسخ القادمة التي لم يُنشئها التكرار التلقائي بعد
  for (const s of Object.values(series)) {
    const l = s.last;
    if (!l.auto || !STEP[l.repeat]) continue;
    for (let d = nextOf(l.localDate, l.repeat), n = 0; d <= last && n < 40; d = nextOf(d, l.repeat), n++) {
      if (weekdayOnly[s.jid] && l.raw[TASK_WEEKEND_PROP]?.checkbox !== true && isWeekend(d, env)) continue; // لا عمل لهذه الجهة في العطلة
      s.planned += s.q;
      if (d <= upTo) s.due += s.q;
    }
  }
  const groups = {};
  for (const s of Object.values(series)) {
    const g = groups[s.jid] ||= { name: jName[s.jid] || 'جهة', order: jOrder[s.jid] ?? 99, planned: 0, due: 0, done: 0, series: [] };
    g.planned += s.planned; g.due += s.due; g.done += s.done; g.series.push(s);
  }
  return { first, last, today: upTo, offset, groups: Object.values(groups).sort((a, b) => a.order - b.order) };
}

// 🟢 في الموعد · 🟡 متأخر قليلًا · 🔴 متأخر (نسبة المنجز من المستحق حتى اليوم)
export const paceIcon = g => !g.due ? '⚪' : g.done / g.due >= 0.9 ? '🟢' : g.done / g.due >= 0.7 ? '🟡' : '🔴';

export function quotaView(m, env) {
  const days = daysBetween(m.first, m.last) + 1, day = daysBetween(m.first, m.today) + 1;
  const lines = [`📊 <b>الحصة الشهرية — ${esc(MONTH_NAME(m.first))}</b>`,
    m.offset < 0 ? '<i>الشهر كاملًا</i>' : `<i>اليوم ${day} من ${days}</i>`, ''];
  if (!m.groups.length) lines.push('لا مهام بكمية مربوطة بجهة في هذا الشهر.');
  for (const g of m.groups) {
    const pct = g.planned ? Math.round(g.done / g.planned * 100) : 0;
    lines.push(`${paceIcon(g)} <b>${esc(g.name)}</b>: ${g.done}/${g.planned} (${pct}%)${m.offset < 0 || g.due === g.planned ? '' : ` · المستحق حتى اليوم ${g.due}`}`);
    const parts = g.series.sort((a, b) => b.planned - a.planned).slice(0, 5).map(s => `${esc(unitName(s.title))} ${s.done}/${s.planned}`);
    lines.push(`     ${parts.join(' · ')}`);
  }
  const behind = m.groups.filter(g => g.due && g.done / g.due < 0.9);
  if (m.groups.length) lines.push('', m.offset < 0 ? '🧾 <i>يصلح لمراجعة المستحقات مع كل جهة.</i>' : behind.length ? `⚠️ تأخّر عند: ${behind.map(g => esc(g.name)).join('، ')}` : '🌟 كل الجهات في الموعد.');
  const markup = { inline_keyboard: [[m.offset < 0 ? { text: '▶️ هذا الشهر', callback_data: 'qt|0' } : { text: '◀️ الشهر الماضي', callback_data: 'qt|-1' }]] };
  return { text: lines.join('\n'), markup };
}

export async function onQuotaButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  await answer(env, cb.id);
  const offset = Math.max(-12, Math.min(0, Number(String(cb.data).split('|')[1]) || 0));
  return editMessage(env, cb.message.message_id, quotaView(await monthQuota(env, Date.now(), offset), env));
}

// تنبيهات: يوم 1 (تقرير الشهر الماضي)، يوم 15 وقبل نهاية الشهر بـ 5 أيام (إن تأخرت جهة)
export async function checkQuota(env, now) {
  if (!pastLocalTime(now, env, env.QUOTA_TIME || '10:00')) return;
  const today = localDate(now, env.TZ_NAME);
  if ((await env.STATE.get('quotaday')) === today) return;
  const day = Number(today.slice(8)), lastDay = daysIn(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
  if (day === 1) {
    const m = await monthQuota(env, now, -1);
    if (m.groups.length) await say(env, quotaView(m, env).text.replace('📊 <b>', '📊 <b>حصيلة '), quotaView(m, env).markup);
  } else if (day === 15 || day === lastDay - 5) {
    const m = await monthQuota(env, now, 0);
    if (m.groups.some(g => g.due && g.done / g.due < 0.9)) { const v = quotaView(m, env); await say(env, v.text, v.markup); }
  }
  await env.STATE.put('quotaday', today, { expirationTtl: 3 * 24 * 3600 });
}
