import { answer, tg } from './api.js';
import { onAsk } from './ask.js';
import { cfg, DRAFT_TTL_S, SOURCES } from './core.js';
import { geminiJSON } from './docs.js';
import { finishAdd, parseTimeText, say, startAdd } from './messages.js';
import { EXPENSE_CATS, INCOME_CATS, fmtDa, guessCat, saveMoney } from './money.js';
import { geminiKey } from './settings.js';
import { addDays, fmtDay, localDate } from './time.js';
import { NO_BUTTONS, editMessage, esc } from './view.js';

// ───────────────────────── الرسائل الصوتية (Gemini) ─────────────────────────
//
// رسالة صوتية ← تُرسل إلى Gemini (صوت OGG مباشرة) ← نص مكتوب + فهم منظَّم (JSON):
// النوع، العنوان، اليوم، الساعة، التكرار، الشخص، المبلغ، الفئة ← بطاقة تأكيد: ✅ حفظ · ✏️ خطوة بخطوة · ✖️ إلغاء.
// لا يُحفظ شيء قبل التأكيد. المفتاح: السرّ GEMINI_API_KEY. callback: vx|<فعل>

export const VOICE_KINDS = ['task', 'reminder', 'idea', 'health', 'expense', 'income', 'question', 'unknown'];
export const VOICE_LABEL = { task: '✅ مهمة', reminder: '📅 موعد', idea: '💡 فكرة', health: '🩺 موعد طبي', expense: '💸 إنفاق', income: '💵 قبض' };
export const GEMINI_SKIP_RE = /image|banana|tts|transcribe|lyria|robotics|computer-use|deep-research|embedding|aqa|live|native-audio|thinking/i;

// أفضل نماذج Flash المتاحة لهذا المفتاح (تُخزَّن يومًا في KV)
export async function geminiModels(env) {
  const cached = await env.STATE.get('gemini_models', 'json');
  if (cached?.length) return cached;
  let names = [];
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    const json = await res.json();
    names = (json.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(n => /^gemini/.test(n) && !GEMINI_SKIP_RE.test(n));
    const score = n => (/flash/.test(n) ? 100 : 0) - (/lite/.test(n) ? 20 : 0) - (/preview|exp/.test(n) ? 30 : 0)
      + parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]) * 10;
    names.sort((a, b) => score(b) - score(a));
  } catch { /* نستعمل الافتراضي */ }
  if (!names.length) names = ['gemini-2.5-flash'];
  names = names.slice(0, 3);
  await env.STATE.put('gemini_models', JSON.stringify(names), { expirationTtl: 24 * 3600 });
  return names;
}

export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function understandVoice(env, audioB64, mime) {
  const now = Date.now(), today = localDate(now, env.TZ_NAME);
  const week = [...Array(8)].map((_, i) => `${addDays(today, i)} = ${new Intl.DateTimeFormat('ar-DZ', { weekday: 'long', timeZone: 'UTC' }).format(new Date(addDays(today, i) + 'T12:00:00Z'))}`).join('، ');
  const prompt = [
    'أنت مساعد شخصي جزائري. استمع للرسالة الصوتية (عربية فصحى أو دارجة جزائرية، وقد تتخلّلها كلمات فرنسية) ثم:',
    '1) اكتبها نصًا كما قيلت في transcript.',
    '2) استخرج ما يريد المتكلّم تسجيله:',
    '- kind: task (مهمة عمل أو شيء يجب فعله) · reminder (موعد أو التزام أو تذكير شخصي) · idea (فكرة) · health (موعد طبي/تحاليل/تطعيم) · expense (مال أنفقه: صرفت، دفعت، شريت) · income (مال قبضه: قبضت، دخل) · question (سؤال يطلب معلومة من بياناته، مثل «واش عندي غدوة؟» أو «شحال صرفت هاد الشهر؟») · unknown.',
    '- title: عنوان قصير واضح بالعربية دون كلمات التوقيت (مثال: «الاتصال بالبنك»). للمال: البيان (مثال: «بنزين»).',
    `- date: بصيغة YYYY-MM-DD. اليوم ${today}. الأيام القادمة: ${week}. «غدوة/غدا» = الغد، «بعد غدوة» = بعد الغد، «الجمعة الجاية» = أقرب جمعة قادمة. اتركه null إن لم يُذكر يوم (وللمال null دائمًا).`,
    '- time: بصيغة HH:MM (24 ساعة). «العشية» ≈ بعد الظهر، «الصباح» ≈ صباحًا، «3 تاع العشية» = 15:00. null إن لم تُذكر ساعة.',
    '- repeat: واحدة من [مرة واحدة، يومي، يوم بعد يوم، أسبوعي، شهري، سنوي] أو null.',
    `- person (للمواعيد الطبية فقط): ${cfg.family.join(' أو ')}، وإلا null.`,
    '- amount (للمال فقط): رقم بالدينار. «ألف» = 1000. تنبيه: «مليون» في الدارجة الجزائرية = 10000 دينار (عشرة آلاف)، و«ألف دورو» = 50 دينار.',
    `- category (للمال فقط): للإنفاق واحدة من [${EXPENSE_CATS.join('، ')}]، وللقبض واحدة من [${INCOME_CATS.join('، ')}]، وإلا null.`,
  ].join('\n');
  const schema = {
    type: 'OBJECT',
    properties: {
      transcript: { type: 'STRING' },
      kind: { type: 'STRING', enum: VOICE_KINDS },
      title: { type: 'STRING' },
      date: { type: 'STRING', nullable: true },
      time: { type: 'STRING', nullable: true },
      repeat: { type: 'STRING', nullable: true },
      person: { type: 'STRING', nullable: true },
      amount: { type: 'NUMBER', nullable: true },
      category: { type: 'STRING', nullable: true },
    },
    required: ['transcript', 'kind', 'title'],
  };
  return geminiJSON(env, [{ text: prompt }, { inline_data: { mime_type: mime, data: audioB64 } }], schema);
}

// تنقية ما فهمه Gemini إلى قيم صالحة لقواعد Notion
export function cleanVoice(v) {
  const kind = VOICE_KINDS.includes(v.kind) ? v.kind : 'unknown';
  const out = { transcript: String(v.transcript || '').slice(0, 500), kind, title: String(v.title || v.transcript || '').trim().slice(0, 200) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.date || '') && !isNaN(Date.parse(v.date))) out.date = v.date;
  if (/^\d{1,2}:\d{2}$/.test(v.time || '')) out.time = parseTimeText(v.time);
  if (SOURCES[kind]?.repeats?.includes(v.repeat)) out.repeat = v.repeat;
  if (SOURCES.health.people.includes(v.person)) out.person = v.person;
  if (kind === 'expense' || kind === 'income') {
    out.amount = Number(v.amount) > 0 ? Math.round(Number(v.amount)) : null;
    const cats = kind === 'income' ? INCOME_CATS : EXPENSE_CATS;
    out.category = cats.includes(v.category) ? v.category : guessCat(kind, out.title);
  }
  return out;
}

export function voiceCard(v, env) {
  const lines = [`🎤 <i>«${esc(v.transcript)}»</i>`, ''];
  if (v.kind === 'unknown') {
    lines.push('🤔 لم أفهم ما تريد تسجيله. اختر «خطوة بخطوة» لإضافته يدويًا.');
  } else if (v.kind === 'expense' || v.kind === 'income') {
    lines.push(`فهمت: <b>${VOICE_LABEL[v.kind]}</b>`, `${v.kind === 'income' ? '💵' : '💸'} <b>${v.amount ? fmtDa(v.amount) : '⚠️ بلا مبلغ'}</b> — ${esc(v.title)}`, `🏷️ ${esc(v.category)}`);
  } else {
    lines.push(`فهمت: <b>${VOICE_LABEL[v.kind]}</b>`, `${SOURCES[v.kind].icon} <b>${esc(v.title)}</b>`);
    lines.push(v.date ? `📆 ${esc(fmtDay(v.date, env))}${v.time ? ` · 🕘 ${v.time}` : ''}` : (v.kind === 'idea' ? '🚫 بلا تذكير' : '⚠️ بلا تاريخ — لن يصلك تنبيه'));
    if (v.repeat && v.repeat !== 'مرة واحدة') lines.push(`🔁 ${esc(v.repeat)}`);
    if (v.person) lines.push(`👤 ${esc(v.person)}`);
  }
  const canSave = v.kind !== 'unknown' && !((v.kind === 'expense' || v.kind === 'income') && !v.amount);
  const row = [];
  if (canSave) row.push({ text: '✅ حفظ', callback_data: 'vx|s' });
  row.push({ text: '✏️ خطوة بخطوة', callback_data: 'vx|m' }, { text: '✖️ إلغاء', callback_data: 'vx|x' });
  return { text: lines.join('\n'), markup: { inline_keyboard: [row] } };
}

export async function onVoice(message, env) {
  if (String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  const key = await geminiKey(env);
  if (!key) return say(env, '🎤 الرسائل الصوتية تحتاج مفتاح Gemini: اضغط <b>⚙️</b> ثم «🔑 إضافة مفتاح Gemini».');
  env = { ...env, GEMINI_API_KEY: key };
  const media = message.voice || message.audio;
  if (media.file_size > 15 * 1024 * 1024) return say(env, '⚠️ الرسالة الصوتية طويلة جدًا.');
  const status = await say(env, '🎤 أستمع…');
  try {
    const file = await tg(env, 'getFile', { file_id: media.file_id });
    const audio = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`).then(r => r.arrayBuffer());
    const v = cleanVoice(await understandVoice(env, toBase64(audio), media.mime_type || 'audio/ogg'));
    if (v.kind === 'question') return onAsk(env, v.transcript, status.message_id, `🎤 <i>«${esc(v.transcript)}»</i>\n\n`);
    await env.STATE.put('vdraft', JSON.stringify({ ...v, mid: status.message_id }), { expirationTtl: DRAFT_TTL_S });
    return editMessage(env, status.message_id, voiceCard(v, env));
  } catch (err) {
    return editMessage(env, status.message_id, { text: `⚠️ تعذّر فهم الرسالة الصوتية:\n<code>${esc(String(err.message).slice(0, 200))}</code>`, markup: NO_BUTTONS });
  }
}

export async function onVoiceButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const act = String(cb.data).split('|')[1];
  const v = await env.STATE.get('vdraft', 'json');
  if (!v || v.mid !== cb.message.message_id) {
    await answer(env, cb.id, 'انتهت صلاحية هذه الرسالة');
    return tg(env, 'editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: NO_BUTTONS });
  }
  await answer(env, cb.id);
  await env.STATE.delete('vdraft');
  if (act === 'x') return editMessage(env, v.mid, { text: `🎤 <i>«${esc(v.transcript)}»</i>\n\n✖️ لم يُحفظ شيء.`, markup: NO_BUTTONS });
  if (act === 'm') {
    await editMessage(env, v.mid, { text: `🎤 <i>«${esc(v.transcript)}»</i>`, markup: NO_BUTTONS });
    return startAdd(env, v.title);
  }
  // حفظ عبر نفس مسارات الإضافة اليدوية
  if (v.kind === 'expense' || v.kind === 'income') {
    return saveMoney(env, { kind: v.kind, amount: v.amount, desc: v.title, mid: v.mid }, v.category);
  }
  return finishAdd(env, { kind: v.kind, title: v.title, date: v.date ?? (v.kind === 'idea' ? null : undefined), time: v.time || null, repeat: v.repeat, person: v.person, mid: v.mid });
}
