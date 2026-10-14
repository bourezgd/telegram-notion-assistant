import { queryItems } from './alerts.js';
import { answer, tg } from './api.js';
import { DAY, SOURCES } from './core.js';
import { quickAction } from './dayview.js';
import { say } from './messages.js';
import { PRAYERS, trackerRow } from './prayer.js';
import { STEP } from './repeat.js';
import { localDate, zonedToUtc } from './time.js';
import { NO_BUTTONS, editMessage, esc, shortTitle } from './view.js';

// ───────────────────────── مراجعة المساء ─────────────────────────
//
// الساعة REVIEW_HOUR: رسالة واحدة بما بقي مفتوحًا من مهام اليوم ومواعيده (+ المتأخر من الأيام السبعة الماضية)،
// لكل عنصر زرّان: ✅ تمّت، و«➡️ غدًا» (للمرة الواحدة) أو «⛔ لم تُنجز» (للمتكرر، لأن نسخته القادمة موجودة).

export const REVIEW_KINDS = ['task', 'reminder', 'health'];

export async function checkReview(env, now) {
  const today = localDate(now, env.TZ_NAME);
  if (localHourOf(now, env) < Number(env.REVIEW_HOUR || 21)) return 0;
  const prev = await env.STATE.get('review', 'json');
  if (prev?.date === today) return 0;

  const dayStart = zonedToUtc(today, '00:00', env.TZ_NAME);
  let total = 0, done = 0, calls = 0;
  const items = [];
  for (const kind of REVIEW_KINDS) {
    const src = SOURCES[kind];
    const all = await queryItems(env, kind, { and: [
      { property: src.date, date: { on_or_after: new Date(dayStart - 7 * DAY).toISOString() } },
      { property: src.date, date: { on_or_before: new Date(now).toISOString() } },
    ] });
    calls++;
    for (const it of all) {
      const isToday = it.localDate === today;
      if (isToday) { total++; if (it.status === src.done) done++; }
      if (!src.closed.includes(it.status) && it.alertAt <= now) {
        items.push({ id: it.id, kind, title: it.title, late: !isToday, recurring: !!STEP[it.repeat], r: null });
      }
    }
  }
  const row = await trackerRow(env, today, false); calls++;
  const prayed = row ? PRAYERS.filter(p => row.properties[p.name]?.checkbox).length : 0;

  const review = { date: today, total, done, prayed, items: items.slice(0, 20) };
  const v = renderReview(review);
  const msg = await say(env, v.text, v.markup); calls++;
  review.mid = msg.message_id;
  await env.STATE.put('review', JSON.stringify(review), { expirationTtl: 3 * 24 * 3600 });
  return calls;
}

export function renderReview(rv) {
  const left = rv.items.filter(i => !i.r);
  const lines = [`🌙 <b>مراجعة اليوم</b>`, `✅ أنجزت ${rv.done} من ${rv.total} · 🕌 الصلوات ${rv.prayed}/5`];
  if (!rv.items.length) lines.push('', 'أحسنت! لم يبقَ شيء معلّق 🎉');
  else {
    lines.push('', left.length ? `<b>بقي ${left.length}:</b>` : '<b>راجعتَ كل شيء 👍</b>');
    for (const it of rv.items) {
      const mark = { done: '✅', moved: '➡️', missed: '⛔' }[it.r];
      const t = `${it.kind === 'task' ? '' : SOURCES[it.kind].icon + ' '}${esc(it.title)}${it.late ? ' <i>(متأخرة)</i>' : ''}`;
      lines.push(mark ? `${mark} <s>${t}</s>` : `▫️ ${t}`);
    }
  }
  const rows = left.map(it => {
    const i = rv.items.indexOf(it);
    return [
      { text: `✅ ${shortTitle(it.title)}`, callback_data: `rv|d|${i}` },
      it.recurring ? { text: '⛔ لم تُنجز', callback_data: `rv|n|${i}` } : { text: '➡️ غدًا', callback_data: `rv|m|${i}` },
    ];
  });
  if (left.length > 1) rows.push([{ text: '➡️ انقل الباقي لغدٍ', callback_data: 'rv|all|0' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

export async function onReviewButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, action, idx] = String(cb.data).split('|');
  const rv = await env.STATE.get('review', 'json');
  if (!rv || rv.mid !== cb.message.message_id) {
    await answer(env, cb.id, 'انتهت هذه المراجعة');
    return tg(env, 'editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: NO_BUTTONS });
  }
  const targets = action === 'all' ? rv.items.filter(i => !i.r) : [rv.items[Number(idx)]].filter(i => i && !i.r);
  for (const it of targets) {
    // «الكل لغدٍ»: المتكرر نسخته القادمة موجودة، فنُغلق الحالية فقط
    const act = action === 'all' ? (it.recurring ? 'n' : 'm') : action;
    await quickAction(env, it.kind, it.id, act);
    it.r = { d: 'done', n: 'missed', m: 'moved' }[act];
    if (act === 'd') rv.done++;
  }
  await answer(env, cb.id, { d: 'أحسنت ✅', n: 'سُجّلت', m: 'نُقلت لغدٍ', all: 'نُقل الباقي' }[action] || '');
  await env.STATE.put('review', JSON.stringify(rv), { expirationTtl: 3 * 24 * 3600 });
  return editMessage(env, rv.mid, renderReview(rv));
}

export function localHourOf(ms, env) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: env.TZ_NAME, hour: '2-digit', hourCycle: 'h23' }).format(ms));
}
