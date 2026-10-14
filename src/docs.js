import { claim, release } from './alerts.js';
import { answer, notion, tg } from './api.js';
import { budgetLeft, cfg, HOUR, rt, SOURCES, SUBREQ_RESERVE } from './core.js';
import { daysBetween } from './events.js';
import { finishAdd, parseTimeText, say } from './messages.js';
import { EXPENSE_CATS, fmtDa, guessCat, queryAll, saveMoney } from './money.js';
import { richText } from './diary.js';
import { geminiKey } from './settings.js';
import { addDays, fmtDay, fmtTime, localDate, shortDay, zonedToUtc } from './time.js';
import { NO_BUTTONS, editMessage, esc, plainText } from './view.js';
import { geminiModels, toBase64 } from './voice.js';

// ───────────────────────── 🔍 صورة ← بيانات (Gemini) ─────────────────────────
//
// «🔍 استخراج بيانات» على بطاقة صورة (أو ملف PDF) ← Gemini يقرأ الوثيقة ويصنّفها ← بطاقة تأكيد:
//   🧾 وصل شراء ← مصروف في «💰 المالية» · 🧾 فاتورة للدفع ← تذكير قبل آخر أجل، أو مصروف إن دُفعت
//   📅 بطاقة موعد ← موعد طبي أو تذكير · 💊 وصفة ← صفّ «دواء» لكل دواء بأوقاته ومدته، ثم تذكير يومي في كل وقت
// لا يُحفظ شيء قبل التأكيد. البطاقة في KV تحت ph:<mid> (مع صور الطفل)، والاستخراج في p.x

export const DOC_KINDS = ['expense', 'bill', 'appointment', 'prescription', 'other'];
export const HEALTH_TYPES = ['موعد طبي', 'تحاليل/أشعة', 'تطعيم'];
export const MED_SLOTS = { 1: ['09:00'], 2: ['08:00', '20:00'], 3: ['08:00', '14:00', '20:00'], 4: ['08:00', '12:00', '16:00', '20:00'] };
export const PEOPLE_ROW = () => SOURCES.health.people.map(n => ({ text: `👤 ${n}`, callback_data: `ph|p:${n}` }));

// Gemini مع ملف مرفق وجواب JSON بمخطط، والانتقال لنموذج آخر عند الازدحام
export async function geminiJSON(env, parts, schema) {
  let lastErr;
  for (const model of await geminiModels(env)) {
    rt.subreq++;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      try { return JSON.parse(text); } catch { lastErr = new Error('ردّ Gemini غير مفهوم'); continue; }
    }
    lastErr = new Error(json.error?.message || `Gemini ${res.status}`);
    if (![429, 500, 503].includes(res.status)) break;
  }
  throw lastErr;
}

export async function readDocument(env, b64, mime) {
  const today = localDate(Date.now(), env.TZ_NAME);
  const prompt = [
    'أنت مساعد شخصي في الجزائر. هذه صورة (أو PDF) لوثيقة قد تكون بالعربية أو الفرنسية. صنّفها واستخرج بياناتها:',
    '- kind: expense = وصل/تذكرة شراء مدفوع (ticket de caisse، facture payée، وصل صيدلية…) · bill = فاتورة مطلوب دفعها (سونلغاز، الماء ADE/SEAAL، اتصالات الجزائر، الإنترنت، الكراء…) · appointment = بطاقة أو رسالة أو لقطة شاشة فيها موعد · prescription = وصفة طبية (ordonnance) · other = غير ذلك.',
    '- summary: جملة عربية قصيرة تصف الوثيقة.',
    '- title: عنوان عربي قصير: للمصروف المتجر أو ما اشتُري (مثال «مشتريات Uno»)، للفاتورة «فاتورة سونلغاز»، للموعد «موعد طبيب الأطفال»، للوصفة اسم الطبيب أو «وصفة طبية».',
    `- amount: بالدينار الجزائري رقمًا فقط: للمصروف المجموع المدفوع (Total/Net à payer)، للفاتورة المبلغ المطلوب (Montant à payer). «1.234,50» = 1234.5. null إن لم يوجد.`,
    `- category (للمصروف): واحدة من [${EXPENSE_CATS.join('، ')}]؛ الصيدلية = صحة، المواد الغذائية = تغذية.`,
    `- date: YYYY-MM-DD — تاريخ الوصل، أو تاريخ الموعد. التواريخ في الجزائر تُكتب يوم/شهر/سنة. اليوم ${today}. null إن لم يوجد.`,
    '- time: HH:MM للموعد إن وُجدت، وإلا null.',
    '- due_date: YYYY-MM-DD آخر أجل للدفع (Date limite de paiement) للفاتورة، وإلا null.',
    `- medical: true إن كان الموعد عند طبيب أو عيادة أو مخبر أو للتلقيح. appt_type: واحدة من [${HEALTH_TYPES.join('، ')}] أو null.`,
    cfg.child ? `- person: «${cfg.child}» إن كان المريض رضيعًا أو طفلًا، وإلا null (لا تخمّن).` : '- person: null.',
    '- place: اسم الطبيب أو العيادة أو المخبر أو العنوان إن وُجد، وإلا null.',
    '- medicines (للوصفة فقط): لكل دواء: name كما كُتب، dose (مثل «قرص واحد»، «5 مل»، «ملعقة»)، per_day عدد المرات في اليوم، days مدة العلاج بالأيام (null إن لم تُذكر)، instructions (مثل «بعد الأكل») أو null.',
    'لا تخترع قيمًا غير مكتوبة في الوثيقة.',
  ].join('\n');
  const NS = t => ({ type: t, nullable: true });
  const schema = {
    type: 'OBJECT',
    properties: {
      kind: { type: 'STRING', enum: DOC_KINDS }, summary: { type: 'STRING' }, title: { type: 'STRING' },
      amount: NS('NUMBER'), category: NS('STRING'), date: NS('STRING'), time: NS('STRING'), due_date: NS('STRING'),
      medical: NS('BOOLEAN'), appt_type: NS('STRING'), person: NS('STRING'), place: NS('STRING'),
      medicines: { type: 'ARRAY', nullable: true, items: { type: 'OBJECT', properties: {
        name: { type: 'STRING' }, dose: NS('STRING'), per_day: NS('NUMBER'), days: NS('NUMBER'), instructions: NS('STRING'),
      }, required: ['name'] } },
    },
    required: ['kind', 'summary', 'title'],
  };
  return geminiJSON(env, [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }], schema);
}

// تنقية ما قرأه Gemini
export function cleanDoc(v) {
  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));
  const kind = DOC_KINDS.includes(v.kind) ? v.kind : 'other';
  const x = { kind, summary: String(v.summary || '').slice(0, 300), title: String(v.title || '').trim().slice(0, 150) || 'وثيقة' };
  if (Number(v.amount) > 0) x.amount = Math.round(Number(v.amount) * 100) / 100;
  if (isDate(v.date)) x.date = v.date;
  if (isDate(v.due_date)) x.due = v.due_date;
  const t = v.time && parseTimeText(String(v.time));
  if (t) x.time = t;
  if (kind === 'expense') x.category = EXPENSE_CATS.includes(v.category) ? v.category : guessCat('expense', x.title);
  if (kind === 'bill') x.category = 'فواتير';
  if (kind === 'appointment') { x.medical = v.medical === true || HEALTH_TYPES.includes(v.appt_type); x.htype = HEALTH_TYPES.includes(v.appt_type) ? v.appt_type : 'موعد طبي'; }
  if (SOURCES.health.people.includes(v.person)) x.person = v.person;
  if (v.place) x.place = String(v.place).slice(0, 150);
  if (kind === 'prescription') {
    x.meds = (v.medicines || []).filter(m => m?.name).slice(0, 8).map(m => {
      const perDay = Math.min(Math.max(Math.round(Number(m.per_day) || 1), 1), 4);
      const days = Number(m.days) > 0 ? Math.min(Math.round(Number(m.days)), 90) : null;
      return { name: String(m.name).slice(0, 80), dose: m.dose ? String(m.dose).slice(0, 60) : '', perDay, days, note: m.instructions ? String(m.instructions).slice(0, 80) : '', times: MED_SLOTS[perDay] };
    });
  }
  return x;
}

export const medLine = m => `• <b>${esc(m.name)}</b>${m.dose ? ` — ${esc(m.dose)}` : ''} · ${m.times.join(' و')}${m.days ? ` · ${m.days} ${m.days <= 10 ? 'أيام' : 'يومًا'}` : ' · بلا مدة'}${m.note ? ` · ${esc(m.note)}` : ''}`;

export function docCard(x, env) {
  const X = { text: '✖️ تجاهل', callback_data: 'ph|x' };
  const lines = [], rows = [];
  if (x.kind === 'expense') {
    lines.push('🧾 <b>وصل شراء</b>', x.amount ? `💸 <b>${fmtDa(x.amount)}</b> — ${esc(x.title)}` : `⚠️ لم أجد المبلغ — ${esc(x.title)}`, `🏷️ ${esc(x.category)}${x.date ? ` · 📆 ${esc(shortDay(x.date))}` : ''}`);
    rows.push(x.amount ? [{ text: '✅ سجّل المصروف', callback_data: 'ph|ok' }, X] : [X]);
  } else if (x.kind === 'bill') {
    lines.push(`🧾 <b>فاتورة للدفع:</b> ${esc(x.title)}`, x.amount ? `💰 <b>${fmtDa(x.amount)}</b>` : '⚠️ لم أجد المبلغ', x.due ? `⏳ آخر أجل: ${esc(fmtDay(x.due, env))}` : '⏳ لم أجد آخر أجل للدفع');
    const r = [];
    if (x.due) r.push({ text: '📅 ذكّرني قبل الأجل', callback_data: 'ph|rb' });
    if (x.amount) r.push({ text: '💸 دفعتها، سجّلها', callback_data: 'ph|ok' });
    rows.push(r, [X]);
  } else if (x.kind === 'appointment') {
    lines.push(`${x.medical ? '🩺' : '📅'} <b>${x.medical ? esc(x.htype) : 'موعد'}:</b> ${esc(x.title)}`,
      x.date ? `📆 ${esc(fmtDay(x.date, env))}${x.time ? ` · 🕘 ${x.time}` : ''}` : '⚠️ لم أجد التاريخ');
    if (x.place) lines.push(`🏥 ${esc(x.place)}`);
    if (x.medical) lines.push(x.person ? `👤 ${esc(x.person)}` : '👤 لمن؟ اختر أدناه');
    if (x.medical && !x.person) rows.push(PEOPLE_ROW());
    rows.push([...(x.date ? [{ text: '✅ أضف الموعد', callback_data: 'ph|ok' }] : []), { text: '✏️ خطوة بخطوة', callback_data: 'ph|m' }, X]);
  } else if (x.kind === 'prescription') {
    lines.push(`💊 <b>وصفة طبية</b>${x.place ? ` — ${esc(x.place)}` : ''}`, x.person ? `👤 ${esc(x.person)}` : '👤 لمن؟ اختر أدناه', '');
    if (x.meds.length) lines.push(...x.meds.map(medLine), '', '⚠️ <i>راجع الأسماء والجرعات مع الوصفة قبل التفعيل. الأوقات قابلة للتعديل من Notion (خانة «الأوقات»).</i>');
    else lines.push('⚠️ لم أستطع قراءة الأدوية بوضوح.');
    if (!x.person) rows.push(PEOPLE_ROW());
    rows.push(x.meds.length ? [{ text: '✅ فعّل تذكيرات الدواء', callback_data: 'ph|ok' }, X] : [X]);
  } else {
    lines.push(`🤔 ${esc(x.summary || 'لم أتعرّف على الوثيقة')}`, 'لم أجد فيها وصلًا أو فاتورة أو موعدًا أو وصفة.');
    rows.push(cfg.child ? [{ text: `👶 صورة ل${cfg.child}`, callback_data: 'ph|n' }, X] : [X]);
  }
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

// «🔍 استخراج بيانات»
export async function extractPhoto(env, mid, p) {
  const key = await geminiKey(env);
  if (!key) return editMessage(env, mid, { text: '🔍 قراءة الوثائق تحتاج مفتاح Gemini: اضغط <b>⚙️</b> ثم «🔑 إضافة مفتاح Gemini».', markup: { inline_keyboard: [[{ text: '✖️ تجاهل', callback_data: 'ph|x' }]] } });
  env = { ...env, GEMINI_API_KEY: key };
  await editMessage(env, mid, { text: '🔍 أقرأ الوثيقة…', markup: NO_BUTTONS });
  try {
    const file = await tg(env, 'getFile', { file_id: p.file });
    rt.subreq++;
    const buf = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`).then(r => r.arrayBuffer());
    const mime = p.mime || (/\.png$/i.test(file.file_path) ? 'image/png' : 'image/jpeg');
    p.x = cleanDoc(await readDocument(env, toBase64(buf), mime));
    await env.STATE.put(`ph:${mid}`, JSON.stringify(p), { expirationTtl: 2 * 24 * 3600 });
    return editMessage(env, mid, docCard(p.x, env));
  } catch (err) {
    return editMessage(env, mid, {
      text: `⚠️ تعذّرت قراءة الوثيقة:\n<code>${esc(String(err.message).slice(0, 250))}</code>`,
      markup: { inline_keyboard: [[{ text: '🔁 أعد المحاولة', callback_data: 'ph|d' }, { text: '✖️ تجاهل', callback_data: 'ph|x' }]] },
    });
  }
}

// حفظ ما استُخرج بعد التأكيد. صورة الوثيقة لا تُحفظ في أي مكان: البيانات فقط في Notion
export async function saveDoc(env, mid, p, act) {
  const x = p.x, today = localDate(Date.now(), env.TZ_NAME);
  p.saved = true;
  await env.STATE.put(`ph:${mid}`, JSON.stringify(p), { expirationTtl: 2 * 24 * 3600 });
  let pages = [];
  if (act === 'rb') {
    // تذكير قبل آخر أجل بيومين (أو اليوم إن ضاق الوقت)
    const date = [addDays(x.due, -2), today].sort().pop();
    pages = [await finishAdd(env, { kind: 'reminder', title: `دفع ${x.title}${x.amount ? ` (${fmtDa(x.amount)})` : ''}`, date, time: '10:00', repeat: 'مرة واحدة', mid })];
  } else if (x.kind === 'expense') {
    pages = [await saveMoney(env, { kind: 'expense', amount: x.amount, desc: x.title, mid, date: x.date && x.date <= today ? x.date : null }, x.category)];
  } else if (x.kind === 'bill') {
    pages = [await saveMoney(env, { kind: 'expense', amount: x.amount, desc: x.title, mid }, 'فواتير')];
  } else if (x.kind === 'appointment') {
    pages = [x.medical
      ? await finishAdd(env, { kind: 'health', title: x.title, date: x.date, time: x.time || null, person: x.person, place: x.place, htype: x.htype, mid })
      : await finishAdd(env, { kind: 'reminder', title: x.title, date: x.date, time: x.time || null, repeat: 'مرة واحدة', mid })];
  } else if (x.kind === 'prescription') {
    const links = [];
    for (const m of x.meds) {
      const page = await notion(env, 'POST', 'pages', {
        parent: { type: 'data_source_id', data_source_id: SOURCES.health.ds },
        properties: {
          'العنوان': { title: richText(m.name) },
          'النوع': { select: { name: 'دواء' } },
          'الحالة': { select: { name: 'مستمر' } },
          'التاريخ': { date: m.days ? { start: today, end: addDays(today, m.days - 1) } : { start: today } },
          'الأوقات': { rich_text: richText(m.times.join('، ')) },
          'ملاحظات': { rich_text: richText([m.dose, m.note].filter(Boolean).join(' · ') || '—') },
          ...(x.person ? { 'الشخص': { select: { name: x.person } } } : {}),
          ...(x.place ? { 'الطبيب/المكان': { rich_text: richText(x.place) } } : {}),
        },
      });
      pages.push(page);
      links.push(`${medLine(m)} · <a href="${esc(page.url)}">Notion</a>`);
    }
    await editMessage(env, mid, { text: [`✅ <b>فُعّلت تذكيرات الدواء</b>${x.person ? ` — ${esc(x.person)}` : ''}`, '', ...links, '', '🔔 سأذكّرك في كل وقت، ويتوقف التذكير بانتهاء المدة.'].join('\n'), markup: NO_BUTTONS });
  }
}

// ── تذكيرات الدواء: صفوف «دواء» بحالة «مستمر» في الملف الصحي، في كل وقت من «الأوقات» ما دام اليوم داخل المدة
export const MED_GRACE_MS = 2 * HOUR;

export async function checkMedicines(env, state, now) {
  const rows = await queryAll(env, SOURCES.health.ds, { and: [
    { property: 'النوع', select: { equals: 'دواء' } }, { property: 'الحالة', select: { equals: 'مستمر' } },
  ] });
  const today = localDate(now, env.TZ_NAME);
  let changed = false;
  for (const r of rows) {
    if (budgetLeft() < SUBREQ_RESERVE) break;
    const pr = r.properties, d = pr['التاريخ']?.date;
    const start = d?.start?.slice(0, 10), end = d?.end?.slice(0, 10);
    if (end && end < today) {
      await notion(env, 'PATCH', `pages/${r.id}`, { properties: { 'الحالة': { select: { name: 'تم' } } } });
      continue;
    }
    if (start && start > today) continue;
    const name = plainText(pr['العنوان']), note = plainText(pr['ملاحظات']), person = pr['الشخص']?.select?.name;
    for (const t of plainText(pr['الأوقات']).match(/\d{1,2}:\d{2}/g) || []) {
      const at = zonedToUtc(today, t, env.TZ_NAME), key = `med:${r.id}:${today}:${t}`;
      if (now < at || now - at > MED_GRACE_MS || !await claim(env, state, key, now)) continue;
      changed = true;
      const left = end ? daysBetween(today, end) : null;
      await say(env, [`💊 <b>وقت الدواء: ${esc(name)}</b>`, [person ? `👤 ${esc(person)}` : '', `🕘 ${t}`, note && note !== '—' ? esc(note) : ''].filter(Boolean).join(' · '),
        left === 0 ? '🏁 آخر يوم في العلاج' : left ? `⏳ بقي ${left} ${left <= 10 ? 'أيام' : 'يومًا'}` : ''].filter(Boolean).join('\n'),
        { inline_keyboard: [[{ text: '✅ أُخذ', callback_data: 'md|ok' }]] })
        .catch(async err => { await release(env, state, key); throw err; });
    }
  }
  return changed;
}

export async function onMedButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  await answer(env, cb.id, '✅');
  const head = (cb.message.text || '').split('\n')[0].replace('وقت الدواء: ', '');
  return editMessage(env, cb.message.message_id, { text: `✅ <s>${esc(head.replace(/^💊\s*/, ''))}</s> — أُخذ ${fmtTime(Date.now(), env)}`, markup: NO_BUTTONS });
}
