import { loadState, parsePage, saveState } from './alerts.js';
import { answer, notion } from './api.js';
import { DAY, HOUR, SOURCES, kindOf } from './core.js';
import { withJiha } from './jihat.js';
import { addDays, localDate } from './time.js';
import { NO_BUTTONS, editMessage, view, whenText } from './view.js';

// ───────────────────────── الأزرار ─────────────────────────

// callback_data: <action>:<pageId32>  (≤ 64 بايت)
export function mainButtons(item) {
  const row = [
    { text: '✅ تم', callback_data: `done:${item.id}` },
    { text: '⏰ أجّلها', callback_data: `snooze:${item.id}` },
  ];
  if (SOURCES[item.kind].cancelled) row.push({ text: '❌ ألغها', callback_data: `cancel:${item.id}` });
  return { inline_keyboard: [row] };
}
export function snoozeButtons(id) {
  return { inline_keyboard: [
    [
      { text: 'ساعة', callback_data: `s1h:${id}` },
      { text: '3 ساعات', callback_data: `s3h:${id}` },
      { text: 'غدًا', callback_data: `s1d:${id}` },
    ],
    [{ text: '↩️ رجوع', callback_data: `back:${id}` }],
  ] };
}

export async function onButton(cb, env) {
  const msg = cb.message;
  if (String(msg?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [action, id] = String(cb.data || '').split(':');
  if (!/^[0-9a-f]{32}$/.test(id || '')) return answer(env, cb.id, 'زر غير صالح');

  const page = await notion(env, 'GET', `pages/${id}`);
  const edit = v => editMessage(env, msg.message_id, v);
  if (page.in_trash || page.archived) {
    await answer(env, cb.id, 'حُذفت من Notion');
    return edit({ text: '🗑️ <b>حُذفت من Notion</b>', markup: NO_BUTTONS });
  }
  const kind = kindOf(page);
  const src = SOURCES[kind];
  const item = kind && parsePage(page, kind, env);
  if (!item) return answer(env, cb.id, 'لا موعد لهذا العنصر');
  await withJiha(env, [item]);
  const state = await loadState(env);
  const tracked = state.msgs[id]?.mid === msg.message_id ? state.msgs[id] : null;
  const sentStart = tracked?.start ?? item.start;

  // الرسالة قديمة: عُدّلت المهمة في Notion (أُغلقت أو تغيّر موعدها) ← نعرض حالتها الحالية فقط
  const current = view(item, sentStart, env);
  if (!current.markup.inline_keyboard.length) {
    await answer(env, cb.id, 'تغيّرت هذه المهمة في Notion');
    return edit(current);
  }

  if (action === 'snooze') { await answer(env, cb.id); return edit({ text: current.text, markup: snoozeButtons(id) }); }
  if (action === 'back') { await answer(env, cb.id); return edit(current); }

  let toast;
  if (action === 'done' || action === 'cancel') {
    item.status = action === 'done' ? src.done : src.cancelled;
    await notion(env, 'PATCH', `pages/${id}`, { properties: { [src.status]: { select: { name: item.status } } } });
    toast = action === 'done' ? 'أحسنت! ✅' : 'أُلغيت';
  } else {
    const shift = { s1h: 'hour', s3h: 'hours3', s1d: 'day' }[action];
    if (!shift) return answer(env, cb.id, 'زر غير معروف');
    const date = snoozeDate(item, shift, env);
    const props = { [src.date]: { date } };
    // «مؤجل» في التذكيرات تعني الإيقاف، فنعيدها «قائم» ليصل التنبيه في الموعد الجديد
    if (kind === 'reminder' && item.status !== src.open) props[src.status] = { select: { name: src.open } };
    await notion(env, 'PATCH', `pages/${id}`, { properties: props });
    Object.assign(item, { start: date.start, end: date.end ?? null, hasTime: date.start.includes('T') });
    toast = `أُجّلت إلى ${whenText(item, env)}`;
  }
  const v = view(item, sentStart, env);
  await answer(env, cb.id, toast);
  await edit(v);
  if (tracked) { tracked.sig = v.sig; await saveState(env, state); }
}

// يحسب الموعد الجديد؛ «غدًا» يحافظ على نفس الساعة، و«ساعة» تُحسب من الآن
export function snoozeDate(item, shift, env) {
  const now = Date.now();
  if (shift === 'day') {
    if (!item.hasTime) {
      const today = localDate(now, env.TZ_NAME);
      const base = item.start > today ? item.start : today;
      return { start: addDays(base, 1) };
    }
    let t = Date.parse(item.start);
    do t += DAY; while (t <= now);
    const dur = item.end ? Date.parse(item.end) - Date.parse(item.start) : 0;
    return { start: new Date(t).toISOString(), end: dur > 0 ? new Date(t + dur).toISOString() : null };
  }
  const t = Math.ceil((now + (shift === 'hour' ? 1 : 3) * HOUR) / 60e3) * 60e3;
  return { start: new Date(t).toISOString() };
}
