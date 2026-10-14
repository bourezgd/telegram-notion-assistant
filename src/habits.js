import { claim, release } from './alerts.js';
import { answer, notion } from './api.js';
import { cfg, DRAFT_TTL_S, DS } from './core.js';
import { weekendDays } from './jihat.js';
import { parseTimeText, say, toLatin } from './messages.js';
import { queryAll } from './money.js';
import { addDays, localDate, zonedToUtc } from './time.js';
import { NO_BUTTONS, editMessage, esc, plainText } from './view.js';

// ───────────────────────── 🔥 العادات بسلاسل ─────────────────────────
//
// من «🔥 العادات» في Notion (نسخة في KV تُحدَّث كل 30 دقيقة): لكل عادة «نشطة» لها «الوقت» تذكير في أيامها
// («الأيام» فارغة = كل يوم) بزرّي «✅ فعلتها» و«⏭️ ليس اليوم». الإنجاز يحدّث «السلسلة» (تزيد إن كان آخر إنجاز
// في يومها المجدول السابق، وإلا تبدأ من 1) و«أطول سلسلة» و«مجموع الأيام» و«آخر إنجاز».
// • متكررة خلال اليوم: «كل (ساعات)» + «حتى» (مثل شرب الماء كل ساعتين 08:00–22:00): تذكير في كل وقت، ويكتمل
//   اليوم (وتزيد السلسلة) حين تُنجز كل أوقاته. KV: hbc:<id>:<تاريخ> = الأوقات المنجزة.
// • «إعادة التذكير (دقائق)»: تذكير ثانٍ إن لم تُنجز بعد كذا دقيقة (مثل قراءة قصة لالطفل بعد ساعة).
// /habits: القائمة مع 🔥، وإنجاز اليوم بضغطة، و«➕ عادة جديدة» (اكتب: «رياضة 07:00»، أو بصيغة حرّة مثل
//   «شرب الماء كل ساعتين من 8 إلى 22» · «قصة لالطفل 21:00 وذكّرني بعد ساعة» · «الجري كل جمعة 09:00»).
// ✏️ بجانب كل عادة: الساعة، التكرار خلال اليوم، الأيام، التذكير الثاني، الاسم، إيقاف/تفعيل، حذف.
// callback: hb|<فعل>|<id>|<تاريخ>[|<الوقت>] · التعديل: hb|e…|<id>|<قيمة>

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const weekdayOf = date => WEEKDAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
const daysWord = n => n === 1 ? 'يوم' : n === 2 ? 'يومان' : n <= 10 ? `${n} أيام` : `${n} يومًا`;

function habitOf(p) {
  const pr = p.properties;
  return {
    id: p.id.replace(/-/g, ''), name: plainText(pr['العادة']), time: parseTimeText(plainText(pr['الوقت']) || '') || null,
    days: (pr['الأيام']?.multi_select || []).map(o => o.name), active: pr['نشطة']?.checkbox === true,
    streak: pr['السلسلة']?.number || 0, best: pr['أطول سلسلة']?.number || 0, total: pr['مجموع الأيام']?.number || 0,
    last: pr['آخر إنجاز']?.date?.start?.slice(0, 10) || null,
    every: pr['كل (ساعات)']?.number || null, until: parseTimeText(plainText(pr['حتى']) || '') || null,
    remind: pr['إعادة التذكير (دقائق)']?.number || null,
  };
}
// أوقات العادة في اليوم: وقت واحد، أو كل «كل (ساعات)» من «الوقت» حتى «حتى» (22:00 افتراضيًا)
export function slotsOf(h) {
  if (!h.time) return [];
  if (!h.every) return [h.time];
  const toMin = t => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  const out = [];
  for (let m = toMin(h.time), end = toMin(h.until || '22:00'); m <= end && out.length < 24; m += h.every * 60) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}
const doneSlots = async (env, id, date) => (await env.STATE.get(`hbc:${id}:${date}`, 'json')) || [];
const scheduledOn = (h, date) => !h.days.length || h.days.includes(weekdayOf(date));
// اليوم المجدول السابق لتاريخ ما (لحساب استمرار السلسلة)
function prevScheduled(h, date) {
  for (let i = 1; i <= 7; i++) { const d = addDays(date, -i); if (scheduledOn(h, d)) return d; }
  return addDays(date, -1);
}
// السلسلة الحيّة: تنقطع إن فات يومها المجدول دون إنجاز
export const liveStreak = (h, today) => !h.last ? 0 : h.last === today || h.last >= prevScheduled(h, today) ? h.streak : 0;

export async function loadHabits(env, fresh) {
  let c = await env.STATE.get('habits', 'json');
  if (fresh || !c || Date.now() - c.at > 30 * 60e3 || Date.now() < c.at) {
    const rows = await queryAll(env, DS.habits, null);
    c = { at: Date.now(), list: rows.map(habitOf).filter(h => h.name) };
    await env.STATE.put('habits', JSON.stringify(c));
  }
  return c.list;
}

function reminderView(h, today, slot, done = [], again = false) {
  const s = liveStreak(h, today), slots = slotsOf(h);
  const progress = slots.length > 1 ? ` — ${done.length}/${slots.length} اليوم` : '';
  const streakLine = s ? `السلسلة: ${daysWord(s)} — لا تقطعها 💪` : h.best ? `ابدأ سلسلة جديدة (أطولها ${daysWord(h.best)})` : 'يومك الأول — ابدأ السلسلة 💪';
  return {
    text: `${again ? '⏰ <b>لم تُسجَّل بعد:</b> ' : '🔥 '}<b>${esc(h.name)}</b>${progress}\n${streakLine}`,
    markup: { inline_keyboard: [[{ text: '✅ فعلتها', callback_data: `hb|d|${h.id}|${today}|${slot}` }, { text: '⏭️ ليس الآن', callback_data: `hb|s|${h.id}|${today}` }]] },
  };
}

// كل دقيقة: تذكير العادة في وقتها (مرة يوميًا)
export async function checkHabits(env, state, now) {
  const today = localDate(now, env.TZ_NAME);
  let changed = false;
  for (const h of await loadHabits(env)) {
    if (!h.active || !h.time || !scheduledOn(h, today) || h.last === today) continue;
    const slots = slotsOf(h), multi = slots.length > 1;
    const grace = multi ? Math.min(h.every * 60, 90) * 60e3 : 3 * 3600e3;
    let done = null;
    for (const slot of slots) {
      const at = zonedToUtc(today, slot, env.TZ_NAME), key = `hab:${h.id}:${today}${multi ? `:${slot}` : ''}`;
      if (now < at || now - at > grace || state.sent[key]) continue;
      done ??= await doneSlots(env, h.id, today);
      if (done.includes(slot) || !await claim(env, state, key, now)) continue;
      changed = true;
      const v = reminderView(h, today, slot, done);
      await say(env, v.text, v.markup).catch(async err => { if (err.transient) await release(env, state, key); throw err; });
    }
    // تذكير ثانٍ إن لم تُنجز (للعادة ذات الوقت الواحد)
    if (h.remind && !multi) {
      const at = zonedToUtc(today, h.time, env.TZ_NAME) + h.remind * 60e3, key = `hab2:${h.id}:${today}`;
      if (now >= at && now - at <= 2 * 3600e3 && await claim(env, state, key, now)) {
        changed = true;
        const v = reminderView(h, today, h.time, [], true);
        await say(env, v.text, v.markup).catch(async err => { if (err.transient) await release(env, state, key); throw err; });
      }
    }
  }
  return changed;
}

async function markDone(env, id, date) {
  const h = habitOf(await notion(env, 'GET', `pages/${id}`));
  if (h.last === date) return h;
  const streak = h.last && h.last >= prevScheduled(h, date) && h.last < date ? h.streak + 1 : 1;
  Object.assign(h, { streak, best: Math.max(h.best, streak), total: h.total + 1, last: date });
  await notion(env, 'PATCH', `pages/${id}`, { properties: {
    'السلسلة': { number: h.streak }, 'أطول سلسلة': { number: h.best }, 'مجموع الأيام': { number: h.total }, 'آخر إنجاز': { date: { start: date } },
  } });
  await loadHabits(env, true);
  return h;
}

export async function habitsView(env) {
  const today = localDate(Date.now(), env.TZ_NAME);
  const all = await loadHabits(env), list = all.filter(h => h.active), paused = all.filter(h => !h.active);
  const lines = ['🔥 <b>عاداتي</b>', ''];
  const rows = [];
  if (!list.length) lines.push('لا عادات بعد. اضغط «➕ عادة جديدة» واكتب مثلًا: <code>رياضة 07:00</code> أو <code>قراءة 10 صفحات 22:00</code>');
  for (const h of list) {
    const s = liveStreak(h, today), done = h.last === today, due = scheduledOn(h, today), slots = slotsOf(h);
    const when = slots.length > 1 ? ` · كل ${h.every === 1 ? 'ساعة' : h.every === 2 ? 'ساعتين' : `${h.every} ساعات`} ${slots[0]}–${slots.at(-1)} (${(await doneSlots(env, h.id, today)).length}/${slots.length})` : h.time ? ` · ${h.time}` : '';
    lines.push(`${done ? '✅' : due ? '▫️' : '➖'} <b>${esc(h.name)}</b>${when}${s ? ` · 🔥 ${s}` : ''}${h.best > 1 ? ` <i>(الأطول ${h.best})</i>` : ''}`);
    const edit = { text: '✏️', callback_data: `hb|e|${h.id}|0` };
    rows.push(due && !done ? [{ text: `✅ ${h.name.slice(0, 24)}`, callback_data: `hb|d|${h.id}|${today}|m` }, edit] : [{ text: `✏️ ${h.name.slice(0, 24)}`, callback_data: edit.callback_data }]);
  }
  for (const h of paused) {
    lines.push(`⏸️ <b>${esc(h.name)}</b> <i>(متوقفة)</i>`);
    rows.push([{ text: `✏️ ${h.name.slice(0, 24)}`, callback_data: `hb|e|${h.id}|0` }]);
  }
  if (all.length) lines.push('', '<i>✏️ لتعديل الساعة أو التكرار أو الأيام أو إيقاف العادة.</i>');
  rows.push([{ text: '➕ عادة جديدة', callback_data: 'hb|new|0|0' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

export async function onHabitButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, act, id, date, slot] = String(cb.data).split('|');
  const mid = cb.message.message_id;
  if (act === 'new') {
    await answer(env, cb.id);
    await env.STATE.put('sdraft', JSON.stringify({ step: 'habit', mid }), { expirationTtl: DRAFT_TTL_S });
    return editMessage(env, mid, { text: `➕ <b>اكتب العادة وساعة تذكيرها</b>، مثل:\n<code>رياضة 07:00</code> · <code>قراءة 10 صفحات 22:00</code>\n<code>شرب الماء كل ساعتين من 8 إلى 22</code>\n<code>قصة ل${cfg.child} 21:00 وذكّرني بعد ساعة</code>\n<code>الجري كل جمعة 09:00</code> · <code>مراجعة البريد أيام العمل 9</code>\n<i>وكل شيء يُعدَّل لاحقًا بزر ✏️.</i>`, markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'hb|x|0|0' }]] } });
  }
  if (act === 'x') { await env.STATE.delete('sdraft'); await answer(env, cb.id); return editMessage(env, mid, await habitsView(env)); }
  if (EDIT_ACTS.includes(act)) return onHabitEdit(cb, env, act, id, date);
  if (!/^[0-9a-f]{32}$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return answer(env, cb.id, 'زر غير صالح');
  if (act === 's') { await answer(env, cb.id); return editMessage(env, mid, { text: `⏭️ ${esc((cb.message.text || '').split('\n')[0].replace(/^(🔥|⏰ لم تُسجَّل بعد:)\s*/, ''))} — ليس الآن.`, markup: NO_BUTTONS }); }
  // العادة المتكررة خلال اليوم: يُسجَّل الوقت، ويكتمل اليوم حين تُنجز كل الأوقات
  const h0 = (await loadHabits(env)).find(x => x.id === id);
  const slots = h0 ? slotsOf(h0) : [];
  const fromList = (cb.message.text || '').startsWith('🔥 عاداتي');
  if (slots.length > 1) {
    const done = await doneSlots(env, id, date);
    const mark = slot && slot !== 'm' && !done.includes(slot) ? slot : slots.find(t => !done.includes(t));
    if (mark && !done.includes(mark)) done.push(mark);
    await env.STATE.put(`hbc:${id}:${date}`, JSON.stringify(done), { expirationTtl: 3 * 24 * 3600 });
    if (done.length < slots.length) {
      await answer(env, cb.id, `${done.length}/${slots.length}`);
      if (fromList) return editMessage(env, mid, await habitsView(env));
      return editMessage(env, mid, { text: `✅ <b>${esc(h0.name)}</b> — ${done.length}/${slots.length} اليوم`, markup: NO_BUTTONS });
    }
  }
  const h = await markDone(env, id, date);
  await answer(env, cb.id, `🔥 ${h.streak}`);
  if (fromList) return editMessage(env, mid, await habitsView(env));
  return editMessage(env, mid, { text: `✅ <b>${esc(h.name)}</b>${slots.length > 1 ? ` — ${slots.length}/${slots.length} اليوم 🎉` : ''}\n🔥 السلسلة: ${daysWord(h.streak)}${h.streak === h.best && h.streak > 1 ? ' — أطول سلسلة لك! 🏆' : ''}`, markup: NO_BUTTONS });
}

// ───────── ✏️ تعديل العادة ─────────

const EDIT_ACTS = ['e', 'et', 'er', 'eu', 'ed', 'eg', 'em', 'en', 'ep', 'ex', 'ey'];
const DAY_ORDER = [6, 0, 1, 2, 3, 4, 5]; // السبت أولًا
const hoursWord = n => n === 1 ? 'ساعة' : n === 2 ? 'ساعتين' : `${n} ساعات`;
const minutesWord = n => n % 60 ? `${n} دقيقة` : hoursWord(n / 60);
const workDays = env => WEEKDAYS.filter((_, i) => !weekendDays(env).includes(i));
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

function daysText(h, env) {
  if (!h.days.length || h.days.length === 7) return 'كل يوم';
  if (sameSet(h.days, workDays(env))) return 'أيام العمل';
  return DAY_ORDER.map(i => WEEKDAYS[i]).filter(d => h.days.includes(d)).join('، ');
}
// وصف مختصر: «كل يوم 22:00» · «كل يوم، كل ساعتين 08:00–22:00» · «…، وتذكير ثانٍ بعد ساعة»
export function describeHabit(h, env) {
  if (!h.time) return 'بلا تذكير';
  const slots = slotsOf(h);
  const when = h.every ? `كل ${hoursWord(h.every)} ${slots[0]}–${slots.at(-1)}` : h.time;
  const again = h.remind && !h.every ? `، وتذكير ثانٍ بعد ${minutesWord(h.remind)}` : '';
  return `${daysText(h, env)}${h.every ? '، ' : ' '}${when}${again}`;
}

function editView(h, env) {
  return {
    text: [
      `✏️ <b>${esc(h.name)}</b>${h.active ? '' : ' <i>(متوقفة)</i>'}`, '',
      `🕘 الساعة: ${h.time || 'بلا تذكير'}`,
      `🔁 التكرار: ${h.every ? `كل ${hoursWord(h.every)} حتى ${h.until || '22:00'}` : 'مرة في اليوم'}`,
      `📅 الأيام: ${daysText(h, env)}`,
      `⏰ التذكير الثاني: ${h.every ? '— (للعادة ذات الوقت الواحد)' : h.remind ? `بعد ${minutesWord(h.remind)}` : 'لا'}`,
      `🔥 السلسلة: ${h.streak} · الأطول ${h.best} · المجموع ${h.total}`,
    ].join('\n'),
    markup: { inline_keyboard: [
      [{ text: '🕘 الساعة', callback_data: `hb|et|${h.id}|0` }, { text: '🔁 التكرار', callback_data: `hb|er|${h.id}|-` }],
      [{ text: '📅 الأيام', callback_data: `hb|ed|${h.id}|-` }, { text: '⏰ التذكير الثاني', callback_data: `hb|em|${h.id}|-` }],
      [{ text: '✏️ الاسم', callback_data: `hb|en|${h.id}|0` }, h.active ? { text: '⏸️ إيقاف مؤقت', callback_data: `hb|ep|${h.id}|0` } : { text: '▶️ تفعيل', callback_data: `hb|ep|${h.id}|1` }],
      [{ text: '🗑️ حذف', callback_data: `hb|ex|${h.id}|0` }, { text: '↩️ العادات', callback_data: 'hb|x|0|0' }],
    ] },
  };
}

function daysView(h, env) {
  const cur = h.days.length ? h.days : WEEKDAYS;
  const dayBtn = i => ({ text: `${cur.includes(WEEKDAYS[i]) ? '✅' : '▫️'} ${WEEKDAYS[i]}`, callback_data: `hb|eg|${h.id}|${i}` });
  return {
    text: `📅 <b>أيام «${esc(h.name)}»</b>\nالحالية: ${daysText(h, env)}\n<i>اضغط يومًا لإضافته أو إزالته.</i>`,
    markup: { inline_keyboard: [
      [{ text: 'كل يوم', callback_data: `hb|ed|${h.id}|all` }, { text: 'أيام العمل', callback_data: `hb|ed|${h.id}|work` }],
      DAY_ORDER.slice(0, 4).map(dayBtn), DAY_ORDER.slice(4).map(dayBtn),
      [{ text: '✔️ تم', callback_data: `hb|e|${h.id}|0` }],
    ] },
  };
}

const ask = (h, text, rows) => ({ text, markup: { inline_keyboard: [...rows, [{ text: '↩️ رجوع', callback_data: `hb|e|${h.id}|0` }]] } });

async function onHabitEdit(cb, env, act, id, val) {
  if (!/^[0-9a-f]{32}$/.test(id)) return answer(env, cb.id, 'زر غير صالح');
  const mid = cb.message.message_id;
  let h = (await loadHabits(env)).find(x => x.id === id);
  if (!h) { await answer(env, cb.id, 'العادة غير موجودة'); return editMessage(env, mid, await habitsView(env)); }
  const show = async (v, note) => { await answer(env, cb.id, note); return editMessage(env, mid, v); };
  const save = async (props, note, view = editView) => {
    await notion(env, 'PATCH', `pages/${id}`, { properties: props });
    h = (await loadHabits(env, true)).find(x => x.id === id) || h;
    return show(view(h, env), note);
  };
  const txt = s => ({ rich_text: s ? [{ type: 'text', text: { content: s } }] : [] });

  if (act === 'e') { await env.STATE.delete('sdraft'); return show(editView(h, env)); }
  if (act === 'et' && val === 'off') return save({ 'الوقت': txt('') }, 'بلا تذكير');
  if (act === 'et' || act === 'en') {
    await env.STATE.put('sdraft', JSON.stringify({ step: 'habit', mode: act === 'et' ? 'time' : 'name', id, mid }), { expirationTtl: DRAFT_TTL_S });
    return show(ask(h, act === 'et'
      ? `🕘 <b>اكتب ساعة «${esc(h.name)}»</b> مثل <code>08:30</code> أو <code>21</code>${h.every ? '\n<i>(هي بداية التكرار خلال اليوم)</i>' : ''}`
      : `✏️ <b>اكتب الاسم الجديد لـ«${esc(h.name)}»</b>`, act === 'et' && h.time ? [[{ text: '🔕 بلا تذكير', callback_data: `hb|et|${id}|off` }]] : []));
  }
  if (act === 'er') {
    if (val === '-') {
      return show(ask(h, `🔁 <b>تكرار «${esc(h.name)}» خلال اليوم</b>`, [
        [{ text: 'مرة في اليوم', callback_data: `hb|er|${id}|0` }, { text: 'كل ساعة', callback_data: `hb|er|${id}|1` }],
        [{ text: 'كل ساعتين', callback_data: `hb|er|${id}|2` }, { text: 'كل 3 ساعات', callback_data: `hb|er|${id}|3` }],
      ]));
    }
    const n = Number(val);
    if (![0, 1, 2, 3].includes(n)) return answer(env, cb.id, 'زر غير صالح');
    if (!n) return save({ 'كل (ساعات)': { number: null } }, 'مرة في اليوم');
    const props = { 'كل (ساعات)': { number: n }, ...(h.time ? {} : { 'الوقت': txt('08:00') }) };
    return save(props, `كل ${hoursWord(n)}`, x => ask(x, `🔁 كل ${hoursWord(n)} من ${x.time}.\n<b>حتى أي ساعة؟</b>`,
      [[18, 20, 21], [22, 23]].map(r => r.map(t => ({ text: `${t}:00${(x.until || '22:00') === `${t}:00` ? ' ✅' : ''}`, callback_data: `hb|eu|${id}|${t}` })))));
  }
  if (act === 'eu') {
    const t = parseTimeText(val);
    if (!t) return answer(env, cb.id, 'زر غير صالح');
    return save({ 'حتى': txt(t) }, `حتى ${t}`);
  }
  if (act === 'ed') {
    if (val === 'all') return save({ 'الأيام': { multi_select: [] } }, 'كل يوم', daysView);
    if (val === 'work') return save({ 'الأيام': { multi_select: workDays(env).map(name => ({ name })) } }, 'أيام العمل', daysView);
    return show(daysView(h, env));
  }
  if (act === 'eg') {
    const d = WEEKDAYS[Number(val)];
    if (!d) return answer(env, cb.id, 'زر غير صالح');
    const cur = h.days.length ? h.days : WEEKDAYS;
    const next = cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d];
    if (!next.length) return answer(env, cb.id, 'اترك يومًا واحدًا على الأقل');
    return save({ 'الأيام': { multi_select: next.length === 7 ? [] : next.map(name => ({ name })) } }, undefined, daysView);
  }
  if (act === 'em') {
    if (val === '-') {
      return show(ask(h, `⏰ <b>تذكير ثانٍ لـ«${esc(h.name)}»</b> إن لم تُسجَّل بعد:${h.every ? '\n<i>(لا يعمل مع التكرار خلال اليوم)</i>' : ''}`, [
        [{ text: 'لا', callback_data: `hb|em|${id}|0` }, { text: 'بعد 30 دقيقة', callback_data: `hb|em|${id}|30` }],
        [{ text: 'بعد ساعة', callback_data: `hb|em|${id}|60` }, { text: 'بعد ساعتين', callback_data: `hb|em|${id}|120` }],
      ]));
    }
    const n = Number(val);
    if (![0, 30, 60, 120].includes(n)) return answer(env, cb.id, 'زر غير صالح');
    return save({ 'إعادة التذكير (دقائق)': { number: n || null } }, n ? `بعد ${minutesWord(n)}` : 'بلا تذكير ثانٍ');
  }
  if (act === 'ep') return save({ 'نشطة': { checkbox: val === '1' } }, val === '1' ? '▶️ فُعّلت' : '⏸️ أُوقفت — السلسلة محفوظة');
  if (act === 'ex') {
    return show(ask(h, `🗑️ <b>حذف «${esc(h.name)}»</b> وسلسلتها نهائيًا؟\n<i>للتوقف المؤقت مع حفظ السلسلة استعمل ⏸️.</i>`,
      [[{ text: '🗑️ نعم، احذف', callback_data: `hb|ey|${id}|0` }]]));
  }
  // ey: الحذف بعد التأكيد
  await notion(env, 'PATCH', `pages/${id}`, { in_trash: true });
  await loadHabits(env, true);
  const v = await habitsView(env);
  return show({ text: `🗑️ حُذفت «${esc(h.name)}»\n\n${v.text}`, markup: v.markup }, 'حُذفت');
}

// ───────── ➕ فهم العادة الجديدة من نص حرّ ─────────

const DAY_STEMS = [['أحد', 'احد'], ['اثنين', 'إثنين', 'اثنان'], ['ثلاثاء'], ['أربعاء', 'اربعاء'], ['خميس'], ['جمعة', 'جمعه'], ['سبت']];
const DAY_RX = `(?:ال)?(?:${DAY_STEMS.flat().join('|')})`;
const T_RX = '(\\d{1,2}(?:[:.]\\d{2})?)';

export function parseHabit(input) {
  let t = ' ' + toLatin(input).replace(/[ً-ْـ]/g, '').replace(/\s+/g, ' ').trim() + ' ';
  const out = { days: [] };
  const cut = (rx, fn) => { const m = t.match(rx); if (m) { fn(m); t = t.replace(m[0], ' ').replace(/\s+/g, ' '); } return m; };
  // «وذكّرني بعد ساعة» / «نبهني مرة أخرى بعد 30 دقيقة»
  cut(/\s(?:و\s?)?(?:ذكرني|نبهني|أعد التذكير|اعد التذكير)\s(?:مرة\s(?:أخرى|اخرى|ثانية)\s)?بعد\s(ساعة ونصف|نصف ساعة|ربع ساعة|ساعتين|ساعتان|ساعة|(\d+)\s?(دقيقة|دقائق|دقيقه|د|ساعات|ساعة|س))(?=\s)/, m => {
    out.remind = m[2] ? Number(m[2]) * (/^س/.test(m[3]) ? 60 : 1) : { 'ساعة ونصف': 90, 'نصف ساعة': 30, 'ربع ساعة': 15, 'ساعتين': 120, 'ساعتان': 120, 'ساعة': 60 }[m[1]];
  });
  // «من 8 إلى 22»
  cut(new RegExp(`\\s(?:من|بين)\\s(?:الساعة\\s)?${T_RX}\\s?(?:إلى|الى|حتى|و|-|–)\\s?(?:الساعة\\s)?${T_RX}(?=\\s)`), m => {
    out.time = parseTimeText(m[1].replace('.', ':')); out.until = parseTimeText(m[2].replace('.', ':'));
  });
  // «كل ساعتين» / «كل 3 ساعات»
  cut(/\sكل\s(ساعتين|ساعتان|ساعة|(\d+)\s?(?:ساعات|ساعة|س))(?=\s)/, m => { out.every = m[2] ? Number(m[2]) : m[1] === 'ساعة' ? 1 : 2; });
  // الأيام
  cut(/\s(?:في\s)?أيام\s(?:العمل|الدوام)(?=\s)/, () => { out.days = 'work'; });
  cut(new RegExp(`\\s(?:كل|يوم|أيام|ايام|يومي)\\s(${DAY_RX}(?:\\s?(?:و|،|,)\\s?${DAY_RX})*)(?:\\sفقط)?(?=\\s)`), m => {
    out.days = [...new Set(m[1].split(/\s?(?:،|,|\s)\s?/).map(w => w.replace(/^و(?=ال|[أا]حد|اثن|ثلا|[أا]رب|خم|جم|سب)/, ''))
      .map(w => DAY_STEMS.findIndex(st => st.some(x => w.replace(/^ال/, '') === x))).filter(i => i >= 0).map(i => WEEKDAYS[i]))];
  });
  cut(/\s(?:كل يوم|يوميا|يوميًا)(?=\s)/, () => {});
  // الساعة في آخر النص: «21:00» · «على الساعة 7 صباحا» · «9 ليلا»
  if (!out.time) {
    cut(new RegExp(`(?<=\\S)\\s(?:على\\s)?(?:الساعة\\s)?${T_RX}\\s?(صباحا|صباح|مساء|مساءا|ليلا|ليل)?\\s$`), m => {
      const tm = parseTimeText(m[1].replace('.', ':'));
      if (!tm) return;
      const h = Number(tm.slice(0, 2));
      out.time = /^(مساء|ليل)/.test(m[2] || '') && h < 12 ? `${String(h + 12).padStart(2, '0')}${tm.slice(2)}` : tm;
    });
  }
  if (out.every && !out.time) out.time = '08:00';
  out.name = t.replace(/(?:\s+و)+\s*$/, '').replace(/\s+/g, ' ').replace(/^[\s،,.:-]+|[\s،,.:-]+$/g, '').slice(0, 80);
  return out;
}

// خصائص صفّ عادة جديدة في Notion من نتيجة parseHabit (تُستعمل أيضًا في scripts/seed-notion.mjs)
export function habitProps(p, env) {
  const txt = s => ({ rich_text: s ? [{ type: 'text', text: { content: s } }] : [] });
  const days = p.days === 'work' ? workDays(env) : p.days;
  return {
    'العادة': { title: [{ type: 'text', text: { content: p.name } }] }, 'نشطة': { checkbox: true },
    ...(p.time ? { 'الوقت': txt(p.time) } : {}),
    ...(p.every ? { 'كل (ساعات)': { number: p.every } } : {}),
    ...(p.until ? { 'حتى': txt(p.until) } : {}),
    ...(p.remind ? { 'إعادة التذكير (دقائق)': { number: p.remind } } : {}),
    ...(days.length && days.length < 7 ? { 'الأيام': { multi_select: days.map(name => ({ name })) } } : {}),
    'السلسلة': { number: 0 }, 'أطول سلسلة': { number: 0 }, 'مجموع الأيام': { number: 0 },
  };
}

// نص العادة الجديدة، أو الساعة/الاسم عند التعديل (من onMessage)
export async function onHabitText(message, env, sd) {
  const text = (message.text || '').trim();
  const txt = s => ({ rich_text: s ? [{ type: 'text', text: { content: s } }] : [] });
  if (sd.mode === 'time' || sd.mode === 'name') {
    let props;
    if (sd.mode === 'time') {
      const time = parseTimeText(text);
      if (!time) return say(env, '⚠️ لم أفهم الساعة. اكتبها مثل <b>08:30</b> أو <b>21</b>.');
      props = { 'الوقت': txt(time) };
    } else {
      if (!text) return say(env, '⚠️ اكتب الاسم.');
      props = { 'العادة': { title: [{ type: 'text', text: { content: text.slice(0, 80) } }] } };
    }
    await notion(env, 'PATCH', `pages/${sd.id}`, { properties: props });
    await env.STATE.delete('sdraft');
    const h = (await loadHabits(env, true)).find(x => x.id === sd.id);
    if (!h) return editMessage(env, sd.mid, await habitsView(env));
    const v = editView(h, env);
    return editMessage(env, sd.mid, { text: `✅ حُفظ.\n\n${v.text}`, markup: v.markup });
  }
  const p = parseHabit(text);
  if (!p.name) return say(env, '⚠️ اكتب اسم العادة.');
  const days = p.days === 'work' ? workDays(env) : p.days;
  await notion(env, 'POST', 'pages', { parent: { type: 'data_source_id', data_source_id: DS.habits }, properties: habitProps(p, env) });
  await env.STATE.delete('sdraft');
  await loadHabits(env, true);
  const v = await habitsView(env);
  const h = { name: p.name, time: p.time || null, every: p.every || null, until: p.until || null, remind: p.remind || null, days: days.length < 7 ? days : [] };
  return editMessage(env, sd.mid, { text: `✅ أُضيفت «${esc(p.name)}»${p.time ? ` — تذكير ${describeHabit(h, env)}` : ''}\n\n${v.text}`, markup: v.markup });
}
