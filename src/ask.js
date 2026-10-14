import { queryItems } from './alerts.js';
import { answer, notion, tg } from './api.js';
import { cfg, COMMON, DS, rt, SOURCES } from './core.js';
import { loadEvents, yearsText } from './events.js';
import { dropDraft, getDraft, say } from './messages.js';
import { FIN, queryAll } from './money.js';
import { DIARY } from './diary.js';
import { PRAYERS, TRACKER } from './prayer.js';
import { QTY_PROP } from './quota.js';
import { STEP } from './repeat.js';
import { geminiKey } from './settings.js';
import { addDays, addMonths, fmtTime, localDate, zonedToUtc } from './time.js';
import { NO_BUTTONS, editMessage, esc, plainText } from './view.js';
import { geminiModels } from './voice.js';
import { JIHA_PROP } from './weekly.js';

// ───────────────────────── 💬 اسأل مساعدك (Gemini) ─────────────────────────
// الخصوصية (KV ask_privacy): { health, money } — false (الافتراضي) = لا يُرسل إلى Gemini
export const askPrivacy = async env => ({ health: false, money: false, ...((await env.STATE.get('ask_privacy', 'json')) || {}) });
//
// سؤال مكتوب (ينتهي بـ ؟ أو يبدأ بأداة سؤال، أو /ask، أو زر «💬 سؤال» تحت اقتراح الإضافة) أو صوتي ←
// لقطة مختصرة من بيانات Notion (المهام والمواعيد والطبي حول اليوم، الأفكار المفتوحة، المالية، الميزانية،
// المناسبات، الصلاة، يوميات الطفل) ← Gemini يجيب منها وحدها. آخر 3 أسئلة تُحفظ 20 دقيقة للمتابعة.
// callback: q|<فعل>

export const ASK_BTN = '💬 اسأل';
export const ASK_RE = /[؟?]\s*$|^(كم|متى|ماذا|ماهي|ماهو|ما هي|ما هو|هل|أين|اين|وين|كيف|لماذا|علاش|واش|شحال|قداش|وقتاش|شكون|من هو|من هي|لخّص|لخص|قارن|حلّل|حلل)\s/;
export const isQuestion = text => ASK_RE.test(text) && text.length >= 6;
export const CHAT_TTL_S = 20 * 60;

// كل الاستدعاءات النصية لـ Gemini: أفضل نموذج متاح، والانتقال لغيره عند الازدحام
export async function geminiText(env, contents, { system, temperature = 0.3 } = {}) {
  let lastErr;
  for (const model of await geminiModels(env)) {
    rt.subreq++;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents, generationConfig: { temperature } }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (text) return text;
      lastErr = new Error('لم يُرجع Gemini جوابًا');
      continue;
    }
    lastErr = new Error(json.error?.message || `Gemini ${res.status}`);
    if (![429, 500, 503].includes(res.status)) break;
  }
  throw lastErr;
}

// لقطة البيانات: أسطر مختصرة حتى تبقى سريعة وقليلة الكلفة
export async function assistantContext(env, now) {
  const tz = env.TZ_NAME, today = localDate(now, tz);
  const utc = d => new Date(zonedToUtc(d, '00:00', tz)).toISOString();
  const range = (kind, a, b) => queryItems(env, kind, { and: [
    { property: SOURCES[kind].date, date: { on_or_after: utc(a) } },
    { property: SOURCES[kind].date, date: { before: utc(b) } },
  ] }).catch(() => []);
  const lastMonthFirst = addMonths(today.slice(0, 8) + '01', -1);
  // الخصوصية: الملف الطبي والمالية لا يُرسلان إلى Gemini إلا إن فُعّلا من ⚙️
  const priv = await askPrivacy(env);
  const [tasks, reminders, health, ideas, jihat, money, budget, tracker, nour, events] = await Promise.all([
    range('task', addDays(today, -10), addDays(today, 22)),
    range('reminder', addDays(today, -30), addDays(today, 61)),
    priv.health ? range('health', addDays(today, -60), addDays(today, 121)) : [],
    notion(env, 'POST', `data_sources/${SOURCES.idea.ds}/query`, { page_size: 100 }).then(r => r.results).catch(() => []),
    notion(env, 'POST', `data_sources/${DS.jihat}/query`, { page_size: 100 }).then(r => r.results).catch(() => []),
    priv.money ? queryAll(env, FIN.ds, { property: FIN.date, date: { on_or_after: lastMonthFirst } }).catch(() => []) : [],
    priv.money ? queryAll(env, DS.budget, null).catch(() => []) : [],
    notion(env, 'POST', `data_sources/${TRACKER.ds}/query`, { filter: { property: TRACKER.date, date: { on_or_after: addDays(today, -13) } }, page_size: 20 }).then(r => r.results).catch(() => []),
    notion(env, 'POST', `data_sources/${DIARY.ds}/query`, { sorts: [{ property: DIARY.date, direction: 'descending' }], page_size: 40 }).then(r => r.results).catch(() => []),
    loadEvents(env, today).catch(() => []),
  ]);
  const jName = Object.fromEntries(jihat.map(p => [p.id, plainText(Object.values(p.properties).find(x => x.type === 'title')).split(' — ')[0]]));
  const when = i => i.hasTime ? `${i.localDate} ${fmtTime(Date.parse(i.start), env)}` : i.localDate;
  const itemLine = i => [when(i), i.title, i.status || '', i.repeat && STEP[i.repeat] ? `تكرار: ${i.repeat}` : '',
    i.priority ? `أولوية: ${i.priority}` : '', i.raw?.[QTY_PROP]?.number ? `الكمية: ${i.raw[QTY_PROP].number}` : '', i.person ? `الشخص: ${i.person}` : '', i.place ? `المكان: ${i.place}` : '',
    (i.raw?.[JIHA_PROP]?.relation || []).map(r => jName[r.id]).filter(Boolean).map(n => `الجهة: ${n}`).join(' '),
    i.notes ? `ملاحظات: ${i.notes.slice(0, 120)}` : ''].filter(Boolean).join(' | ');
  const sortT = l => l.sort((a, b) => a.alertAt - b.alertAt);
  const S = [];
  S.push(`## المهام (${addDays(today, -10)} ← ${addDays(today, 21)})`, ...sortT(tasks).map(itemLine));
  S.push('## المواعيد والتذكيرات', ...sortT(reminders).map(itemLine));
  S.push('## المواعيد الطبية', ...(priv.health ? sortT(health).map(itemLine) : ['(مستثناة للخصوصية)']));
  S.push('## الأفكار', ...ideas.map(p => {
    const pr = p.properties;
    return [plainText(pr[SOURCES.idea.title]), pr[COMMON.status]?.select?.name || '', pr[SOURCES.idea.date]?.date?.start?.slice(0, 10) || '', `أُضيفت ${p.created_time?.slice(0, 10) || ''}`].filter(Boolean).join(' | ');
  }));
  if (!priv.money) S.push('## المالية والميزانية', '(مستثناة للخصوصية)');
  else S.push(`## المالية (منذ ${lastMonthFirst}، بالدينار)`, ...money.map(r => {
    const p = r.properties;
    return [(p[FIN.date]?.date?.start || '').slice(0, 10), p[FIN.type]?.select?.name || '', p[FIN.amount]?.number ?? '', p[FIN.cat]?.select?.name || '', p[FIN.acc]?.select?.name || '', plainText(p[FIN.title])].join(' | ');
  }).sort());
  if (priv.money) S.push('## الميزانية الشهرية', ...budget.map(b => {
    const p = b.properties;
    return [plainText(Object.values(p).find(x => x.type === 'title')), p['النوع']?.select?.name || '', p['المبلغ (دج)']?.number ?? ''].join(' | ');
  }));
  S.push('## المناسبات العائلية', ...events.map(e => `${e.next} (بعد ${e.days} يومًا) | ${e.title} | ${e.type}${e.person ? ` | ${e.person}` : ''}${yearsText(e) ? ` | ${yearsText(e)}` : ''}${e.gift ? ' | تحتاج هدية' : ''}`));
  S.push('## الصلاة (آخر أسبوعين، ✓ = صُلّيت)', ...tracker.map(r => {
    const p = r.properties;
    return `${(p[TRACKER.date]?.date?.start || '').slice(0, 10)}: ${PRAYERS.map(x => `${x.name} ${p[x.name]?.checkbox ? '✓' : '✗'}`).join(' ')}`;
  }).sort());
  if (cfg.child) S.push(`## يوميات ${cfg.child} (${cfg.girl ? 'ابنته' : 'ابنه'}، وُلد${cfg.girl ? 'ت' : ''} ${cfg.birth || '؟'}) — آخر الصور`, ...nour.map(r => {
    const p = r.properties;
    return [(p[DIARY.date]?.date?.start || '').slice(0, 10), plainText(p['العمر']), plainText(p[DIARY.note]) || plainText(p[DIARY.title]), p['مفضّلة']?.checkbox ? '⭐' : ''].filter(Boolean).join(' | ');
  }));
  return S.join('\n');
}

// Markdown بسيط من Gemini ← HTML تلغرام
export function mdToHtml(md) {
  return esc(md)
    .replace(/^#{1,6}\s*(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)\*(\S[^*\n]*?)\*(?=\s|$)/g, '$1<i>$2</i>')
    .replace(/^\s*[*-]\s+/gm, '• ');
}

export async function onAsk(env, question, mid = null, head = '') {
  const key = await geminiKey(env);
  if (!key) return say(env, '💬 «اسأل مساعدك» يحتاج مفتاح Gemini: اضغط <b>⚙️</b> ثم «🔑 إضافة مفتاح Gemini».');
  env = { ...env, GEMINI_API_KEY: key };
  const status = mid ? { message_id: mid } : await say(env, '💬 أبحث في بياناتك…');
  if (mid) await editMessage(env, mid, { text: `${head}💬 أبحث في بياناتك…`, markup: NO_BUTTONS });
  try {
    const now = Date.now(), today = localDate(now, env.TZ_NAME);
    const data = await assistantContext(env, now);
    const week = [...Array(7)].map((_, i) => `${addDays(today, i)} ${new Intl.DateTimeFormat('ar-DZ', { weekday: 'long', timeZone: 'UTC' }).format(new Date(addDays(today, i) + 'T12:00:00Z'))}`).join('، ');
    const system = [
      `أنت مساعد شخصي لمستخدم من ${cfg.country}${cfg.about ? ` (${cfg.about})` : ''}${cfg.child ? `، لديه ${cfg.girl ? 'ابنة' : 'ابن'} اسم${cfg.girl ? 'ها' : 'ه'} ${cfg.child}` : ''}. تجيب بالعربية بإيجاز ودقة ودفء، وتفهم اللهجة المحلية.`,
      `الآن: ${today} الساعة ${fmtTime(now, env)} بالتوقيت المحلي. الأيام: ${week}.`,
      'اعتمد فقط على البيانات أدناه (مصدرها Notion). إن لم تجد الجواب فيها فقل ذلك بوضوح ولا تخترع. المبالغ بالعملة المحلية (دج).',
      'قسم مكتوب فيه «مستثناة للخصوصية» لم يُرسل إليك: إن سُئلت عنه فقل إنه مستثنى ويمكن تفعيله من ⚙️ ← «🔒 خصوصية اسأل».',
      'للحسابات (مجاميع، نسب، مقارنات) احسب بعناية من الأسطر. رتّب القوائم بالوقت. لا تذكر معرّفات تقنية.',
      'التنسيق: نص قصير لتلغرام، يمكنك استعمال **غامق** وقوائم تبدأ بـ «•». بلا جداول. لا تتجاوز 15 سطرًا إلا إن طُلب التفصيل.',
      '', '# البيانات', data,
    ].join('\n');
    const history = (await env.STATE.get('chat', 'json')) || [];
    const contents = [...history.flatMap(h => [{ role: 'user', parts: [{ text: h.q }] }, { role: 'model', parts: [{ text: h.a }] }]), { role: 'user', parts: [{ text: question }] }];
    const answerText = await geminiText(env, contents, { system });
    await env.STATE.put('chat', JSON.stringify([...history, { q: question, a: answerText }].slice(-3)), { expirationTtl: CHAT_TTL_S });
    const html = mdToHtml(answerText);
    const full = head + html;
    return editMessage(env, status.message_id, { text: (full.length > 3900 ? full.slice(0, 3900) + '…' : full), markup: NO_BUTTONS });
  } catch (err) {
    return editMessage(env, status.message_id, { text: `⚠️ تعذّر الجواب:\n<code>${esc(String(err.message).slice(0, 250))}</code>`, markup: NO_BUTTONS });
  }
}

// زر «💬 سؤال» تحت اقتراح الإضافة: النص الذي كُتب يصبح سؤالًا
export async function onAskButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const d = await getDraft(env);
  if (!d?.title || d.mid !== cb.message.message_id) {
    await answer(env, cb.id, 'انتهت صلاحية هذه الرسالة');
    return tg(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: cb.message.message_id, reply_markup: NO_BUTTONS });
  }
  await answer(env, cb.id);
  await dropDraft(env);
  return onAsk(env, d.title, d.mid);
}
