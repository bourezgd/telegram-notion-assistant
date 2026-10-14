import { tg } from './api.js';
import { mainButtons } from './buttons.js';
import { SOURCES, URGENT } from './core.js';
import { STEP } from './repeat.js';
import { fmtDay, fmtTime } from './time.js';

// ───────────────────────── العرض ─────────────────────────

export const NO_BUTTONS = { inline_keyboard: [] };
export const CLOSED_HEAD = {
  'منجزة': '✅ <b>تمّت</b>', 'تم': '✅ <b>تمّت</b>', 'ملغاة': '❌ <b>أُلغيت</b>',
  'لم تُنجز': '⛔ <b>لم تُنجز</b>', 'مؤجل': '⏸ <b>أُوقفت</b>',
  'مُنفّذة': '✅ <b>نُفّذت</b>', 'مؤرشفة': '📦 <b>أُرشفت</b>',
};

// شكل الرسالة حسب حالة المهمة الآن في Notion؛ sentStart = الموعد الذي أُرسلت الرسالة من أجله
export function view(item, sentStart, env) {
  let text, markup = NO_BUTTONS;
  if (SOURCES[item.kind].closed.includes(item.status)) {
    text = `${CLOSED_HEAD[item.status] || esc(item.status)}\n<s>${esc(item.title)}</s>`;
  } else if (item.start !== sentStart) {
    text = `⏰ <b>أُجّلت إلى ${esc(whenText(item, env))}</b>\n${esc(item.title)}`;
  } else {
    text = renderItem(item, env);
    markup = mainButtons(item);
  }
  return { text, markup, sig: hash(text + JSON.stringify(markup)) };
}

export const editMessage = (env, messageId, v) => tg(env, 'editMessageText', {
  chat_id: env.TELEGRAM_CHAT_ID, message_id: messageId, text: v.text, parse_mode: 'HTML',
  disable_web_page_preview: true, reply_markup: v.markup,
});

export function whenText(item, env) {
  return item.hasTime ? `${fmtDay(Date.parse(item.start), env)} ${fmtTime(Date.parse(item.start), env)}` : fmtDay(item.start, env);
}

export function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33 ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function renderItem(item, env) {
  const src = SOURCES[item.kind];
  const when = item.hasTime ? fmtTime(Date.parse(item.start), env) : 'اليوم';
  const repeat = STEP[item.repeat] ? ` · 🔁 ${esc(item.repeat)}` : '';
  const lines = [
    `${src.icon} <b>${esc(item.title)}</b>`,
    `🕘 ${esc(when)}${repeat}${URGENT.includes(item.priority) ? ` · ❗ ${esc(item.priority)}` : ''}${item.person ? ` · 👤 ${esc(item.person)}` : ''}`,
  ];
  if (item.jiha) lines.push(`🏢 ${esc(item.jiha)}`);
  if (item.place) lines.push(`🏥 ${esc(item.place)}`);
  if (item.notes) lines.push(`📝 ${esc(item.notes.slice(0, 300))}`);
  lines.push(`<a href="${esc(item.url)}">فتح في Notion</a>`);
  return lines.join('\n');
}

// اختصار العنوان ليتّسع في نصف عرض الزر: بلا أقواس، وما بعد «:» إن وُجد، ويُقطع عند نهاية كلمة
export function shortTitle(title, max = 20) {
  let t = title.replace(/\s*[(（][^)）]*[)）]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const colon = t.indexOf(':');
  if (colon > 0 && t.length - colon > 6) t = t.slice(colon + 1).trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  let out = space > max / 2 ? cut.slice(0, space) : t.slice(0, max);
  // لا ننهي بحرف جرّ أو رابط
  for (let prev; prev !== out;) { prev = out; out = out.replace(/[\s+،,.:-]+$/, '').replace(/\s(في|من|عن|على|إلى|الى|و|مع|ل|ب)$/, ''); }
  return out + '…';
}

export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const plainText = prop => (prop?.title || prop?.rich_text || []).map(t => t.plain_text).join('').trim();
