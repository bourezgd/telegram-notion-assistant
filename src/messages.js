import { askSmartTime } from './schedule.js';
import { habitsView, onHabitText } from './habits.js';
import { dashKey } from './dashboard.js';
import { growthView, onGrowthText, parseGrowth, vaccinesView } from './growth.js';
import { billsView, monthAnalysis } from './bills.js';
import { answer, notion, tg } from './api.js';
import { ASK_BTN, isQuestion, onAsk } from './ask.js';
import { cfg, DRAFT_TTL_S, inBackground, on, rt, SOURCES } from './core.js';
import { dayView } from './dayview.js';
import { eventsList } from './events.js';
import { EARN_BTN, SPEND_BTN, askMoney, getFDraft, moneySummary, parseAmount, parseMoneyText, putFDraft, saveMoney, startMoney } from './money.js';
import { morningBrief } from './morning.js';
import { onDriveText, onPhotoNote } from './diary.js';
import { monthQuota, quotaView } from './quota.js';
import { SETTINGS_BTN, onSettingsText, settingsView } from './settings.js';
import { onWirdPageText, wirdView } from './spirit.js';
import { statusView } from './status.js';
import { addDays, fmtDay, localDate, shortDay, zonedToUtc } from './time.js';
import { NO_BUTTONS, editMessage, esc } from './view.js';
import { weeklyReport } from './weekly.js';

// ───────────────────────── الإضافة من تلغرام ─────────────────────────
//
// «➕ إضافة» (أو كتابة أي نص) ← نوع ← عنوان ← يوم ← ساعة ← تكرار ← يُنشأ في Notion.
// المسودة تُحفظ في KV تحت 'draft' ساعةً واحدة. callback_data: a|<خطوة>|<قيمة>

export const ADD_BTN = '➕ إضافة';
// غيّر الرقم عند تعديل لوحة الأزرار: أول رسالة بعد التحديث تُرسل اللوحة الجديدة تلقائيًا
export const KB_VERSION = '6';
export const HABITS_BTN = '🔥 العادات', APP_BTN = '📱 لوحتي';
export const MAIN_KB = {
  keyboard: [[{ text: '📋 اليوم' }, { text: '📆 غدًا' }, { text: '📊 الأسبوع' }, { text: '💬 اسأل' }, { text: '⚙️' }], [{ text: ADD_BTN }, { text: '💸 إنفاق' }, { text: '💵 قبض' }], [{ text: HABITS_BTN }, { text: APP_BTN }]], resize_keyboard: true, is_persistent: true,
  input_field_placeholder: 'اكتب مهمة أو فكرة… أو اضغط ➕ إضافة',
};
// لوحة الأزرار مع «📱 لوحتي» تفتح التطبيق المصغّر مباشرة (رابط يحمل مفتاح اللوحة، لأن تلغرام لا يرسل initData
// للتطبيق المفتوح من أزرار لوحة الكتابة). إن لم يُعرف عنوان البوت بعد يبقى زرًا نصيًا يرسل رابط اللوحة.
export async function mainKb(env) {
  const kb = on('money') ? MAIN_KB : { ...MAIN_KB, keyboard: MAIN_KB.keyboard.map(r => r.filter(b => !['💸 إنفاق', '💵 قبض'].includes(b.text))) };
  if (!rt.origin) return kb;
  const app = { text: APP_BTN, web_app: { url: `${rt.origin}/app?k=${await dashKey(env)}` } };
  return { ...kb, keyboard: kb.keyboard.map(r => r.map(b => b.text === APP_BTN ? app : b)) };
}
export const CANCEL_BTN = { text: '✖️ إلغاء', callback_data: 'a|x|' };
export const TIMES = [['08:00', '09:00', '10:00'], ['12:00', '14:00', '16:00'], ['18:00', '20:00', '21:00']];

export const getDraft = async env => (await env.STATE.get('draft', 'json')) || null;
export const putDraft = (env, d) => env.STATE.put('draft', JSON.stringify(d), { expirationTtl: DRAFT_TTL_S });
export const dropDraft = env => env.STATE.delete('draft');
export const say = (env, text, markup) => tg(env, 'sendMessage', {
  chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true,
  ...(markup ? { reply_markup: markup } : {}),
});

export async function onMessage(message, env) {
  if (String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  const text = (message.text || '').trim();
  if (!text) return;
  // ننتظر مفتاح Gemini من الإعدادات
  const sd = await env.STATE.get('sdraft', 'json');
  const KB_TEXTS = MAIN_KB.keyboard.flat().map(b => b.text);
  const isCommand = text.startsWith('/') || KB_TEXTS.includes(text);
  if (['gemini', 'drive', 'wirdpage', 'habit'].includes(sd?.step)) {
    // زر من لوحة الأزرار أو أمر ← خروج من الانتظار ومتابعة عادية
    if (isCommand) await env.STATE.delete('sdraft');
    else return sd.step === 'drive' ? onDriveText(message, env, sd) : sd.step === 'wirdpage' ? onWirdPageText(message, env, sd)
      : sd.step === 'habit' ? onHabitText(message, env, sd) : onSettingsText(message, env, sd);
  }
  // بعد «💬 اسأل»: الرسالة التالية سؤال مهما كانت صيغتها
  if (isCommand) await env.STATE.delete('askmode');
  else if (await env.STATE.get('askmode')) { await env.STATE.delete('askmode'); return inBackground(onAsk(env, text.slice(0, 1000))); }
  // ملاحظة لصورة الطفل (بعد حفظها، أو ردًّا على بطاقتها)
  if (isCommand) await env.STATE.delete('pnote');
  else if (await onPhotoNote(message, env, text)) return;
  if (text !== '/start' && (await env.STATE.get('kbv')) !== KB_VERSION) {
    await env.STATE.put('kbv', KB_VERSION);
    await say(env, '🔄 حُدّثت أزرار البوت.', await mainKb(env));
  }

  if (text === '/start' || text === '/help') {
    await dropDraft(env);
    await env.STATE.put('kbv', KB_VERSION);
    return say(env, [
      'أهلًا 👋',
      '• سأرسل لك كل مهمة وموعد من Notion في وقته، مع أزرار ✅ تم · ⏰ أجّلها · ❌ ألغها.',
      `• للإضافة اضغط <b>${ADD_BTN}</b> في الأسفل، أو اكتب النص مباشرة.`,
      '• لاستعراض مهامك: <b>📋 اليوم</b> أو <b>📆 غدًا</b>، وتقرير الأسبوع: <b>📊 الأسبوع</b>.',
      '• للمال: <b>💸 إنفاق</b> أو <b>💵 قبض</b>، أو اكتب مثلًا <code>مصروف 1500 بنزين</code>، وملخص الشهر: /money',
      '• المناسبات العائلية القادمة: /events',
      '• 🎤 أو أرسل <b>رسالة صوتية</b>، مثل: «ذكّرني غدوة على 3 نعيّط للبنك» أو «صرفت 2000 بنزين».',
      '• ☀️ ملخص صباحي كل يوم 07:30 (أو /morning)، و🩺 حالة البوت: /status',
      '• 📿 أذكار الصباح والمساء والورد القرآني ووضع رمضان: /wird',
      '• 📉 تحليل مصاريف الشهر الماضي: /analysis — وتذكير بالرواتب والفواتير حسب «يوم الاستحقاق» في الميزانية',
      '• 📱 <b>لوحتي</b>: رسوم المال والمهام والعبادات والعادات — زر «📱 لوحتي» في الأسفل أو /dashboard',
      `• 🔥 عاداتك بسلاسل: /habits${cfg.child ? ` · 👶 نمو ${esc(cfg.child)}: <code>نمو 8.4 70 44</code> و/growth` : ''} · 🧾 الفواتير والاشتراكات: /bills`,
      '• 📊 حصة كل جهة هذا الشهر (المنجز من المخطط): /quota',
      '• 💬 <b>اسألني</b> عن أي شيء في بياناتك، مثل: «ماذا عندي غدًا؟» · «كم صرفت هذا الشهر على التغذية؟» (أو بالصوت).',
      '• 🔍 أرسل <b>صورة وصل أو فاتورة أو وصفة أو بطاقة موعد</b> فأسجّلها لك (مصروف، تذكير دفع، دواء، موعد).',
      cfg.child ? `• 📸 أرسل <b>صورة ل${esc(cfg.child)}</b> فتُحفظ في Google Drive وفي «📸 يوميات» بتاريخها وعمر${cfg.girl ? 'ها' : 'ه'} وملاحظتك.` : '',
    ].filter(Boolean).join('\n'), await mainKb(env));
  }
  if (text === '/cancel') { await dropDraft(env); await env.STATE.delete('fdraft'); return say(env, 'أُلغيت الإضافة.', await mainKb(env)); }
  if (text === SPEND_BTN || text === '💰 مصروف' || text === '/spend') { await dropDraft(env); return askMoney(env, 'expense'); }
  if (text === EARN_BTN || text === '/earn') { await dropDraft(env); return askMoney(env, 'income'); }
  if (['/dashboard', '/app', 'لوحتي', 'اللوحة', '📱 لوحتي'].includes(text)) {
    return say(env, `📱 <b>لوحتي</b>: المال، إنجاز المهام، الحصص، الصلاة والأذكار، العادات، والعادات — في صفحة واحدة.`,
      { inline_keyboard: [[{ text: '📱 افتح لوحتي', web_app: { url: `${rt.origin}/app` } }]] });
  }
  if (['/habits', 'العادات', 'عاداتي', HABITS_BTN].includes(text)) { const v = await habitsView(env); return say(env, v.text, v.markup); }
  if (cfg.child && ['/growth', 'النمو', `نمو ${cfg.child}`].includes(text)) return growthView(env);
  if (cfg.child && ['/vaccines', 'التلقيح', `تلقيح ${cfg.child}`].includes(text)) { const v = await vaccinesView(env); return say(env, v.text, v.markup); }
  if (['/bills', 'الفواتير', 'الاشتراكات'].includes(text)) { const v = await billsView(env); return say(env, v.text, v.markup); }
  if (['/analysis', 'التحليل', 'تحليل الشهر', 'تحليل'].includes(text)) return say(env, await monthAnalysis(env, Date.now(), -1));
  if (['/month', 'تحليل هذا الشهر'].includes(text)) return say(env, await monthAnalysis(env, Date.now(), 0));
  if (['/wird', '/adhkar', 'الورد', 'الأذكار', 'الاذكار'].includes(text)) { const v = await wirdView(env); return say(env, v.text, v.markup); }
  if (['/status', 'الحالة', 'حالة البوت'].includes(text)) { const v = await statusView(env); return say(env, v.text, v.markup); }
  if (['/morning', 'صباح', 'الملخص', 'ملخص الصباح'].includes(text)) { const v = await morningBrief(env, Date.now()); return say(env, v.text, v.markup); }
  if (['/quota', '/حصص', 'الحصص', 'الحصة', 'الحصة الشهرية', 'الحصص الشهرية'].includes(text)) { const v = quotaView(await monthQuota(env, Date.now()), env); return say(env, v.text, v.markup); }
  if (['/money', 'المصاريف', 'المالية', 'الميزانية', '💰 الشهر'].includes(text)) return say(env, await moneySummary(env));
  if (['/events', 'المناسبات', '🎂 المناسبات'].includes(text)) return say(env, await eventsList(env));
  if ([SETTINGS_BTN, '/settings', 'الإعدادات', 'الاعدادات'].includes(text)) { const v = await settingsView(env); return say(env, v.text, v.markup); }
  if (text === ADD_BTN || text === '/add') return startAdd(env, null);
  if (text === ASK_BTN) {
    await dropDraft(env);
    await env.STATE.put('askmode', '1', { expirationTtl: 600 });
    return say(env, `💬 <b>اسألني</b> عن مهامك، مواعيدك، مصاريفك، صلاتك، المناسبات${cfg.child ? ' أو يوميات الصور' : ''}.\nاكتب سؤالك (أو أرسله صوتيًا)، مثل: <i>ماذا عندي غدًا · كم صرفت هذا الشهر على التغذية · لخّص أسبوعي</i>`);
  }
  if (/^\/(ask|اسأل|سؤال)(@\w+)?(\s|$)/.test(text)) {
    const q = text.replace(/^\/\S+\s*/, '');
    if (!q) return say(env, '💬 اكتب سؤالك بعد الأمر، مثل: <code>/ask كم صرفت هذا الشهر على التغذية؟</code>\nأو اكتبه مباشرة منتهيًا بعلامة ؟');
    await dropDraft(env);
    return inBackground(onAsk(env, q));
  }
  const DAY_CMDS = { '📋 اليوم': 'today', '/today': 'today', '/اليوم': 'today', '📆 غدًا': 'tomorrow', '/tomorrow': 'tomorrow', '/غدا': 'tomorrow', '/غدًا': 'tomorrow' };
  if (DAY_CMDS[text]) { const v = await dayView(env, DAY_CMDS[text]); return say(env, v.text, v.markup); }
  if (['📊 الأسبوع', '/week', '/تقرير', 'تقرير', 'التقرير'].includes(text)) return say(env, await weeklyReport(env, Date.now()));

  const fd = await getFDraft(env);
  // فريلانس: الاسم (ومعه المبلغ اختياريًا) ثم المبلغ
  if (fd?.step === 'fl_name' || fd?.step === 'fl_amount') {
    const nums = [...toLatin(text).matchAll(/\d[\d.,]*\s*(?:k|ك|ألف|الف|آلاف|الاف)?\s*(?:دج|da|دينار)?/gi)];
    const hit = nums.map(m => ({ m, n: parseAmount(m[0].trim()) })).filter(x => x.n >= 100).pop();
    if (fd.step === 'fl_name') {
      fd.name = (hit ? toLatin(text).replace(hit.m[0], ' ') : text).replace(/\s+/g, ' ').trim().slice(0, 100) || fd.name;
      if (!fd.name) return say(env, '⚠️ اكتب اسم الفريلانس.');
    }
    if (!hit) {
      if (fd.step === 'fl_amount') return say(env, '⚠️ اكتب المبلغ بالأرقام، مثل <code>15000</code> أو <code>15 ألف</code>.');
      fd.step = 'fl_amount';
      await putFDraft(env, fd);
      return editMessage(env, fd.mid, {
        text: `💼 <b>فريلانس:</b> ${esc(fd.name)}\n💰 <b>كم المبلغ؟</b> (مثل <code>15000</code>)`,
        markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'fx|x|0' }]] },
      });
    }
    Object.assign(fd, { kind: 'income', amount: hit.n, desc: `فريلانس: ${fd.name}` });
    return saveMoney(env, fd, 'عمل حر');
  }
  if (fd?.step === 'amount') {
    const parsed = parseMoneyText(text);
    if (!parsed) return say(env, `⚠️ اكتب المبلغ ثم البيان، مثل <code>${fd.kind === 'income' ? '20000 مشروع مونتاج' : '1500 بنزين'}</code>.`);
    if (!parsed.explicit && fd.kind) parsed.kind = fd.kind;
    await tg(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: fd.mid, reply_markup: NO_BUTTONS });
    return startMoney(env, parsed, null);
  }

  const d = await getDraft(env);
  if (d?.step === 'title') {
    d.title = text.slice(0, 200);
    return askDate(env, d, true);
  }
  if (d?.step === 'date_text') {
    const date = parseDateText(text, env);
    if (!date) return say(env, '⚠️ لم أفهم التاريخ. اكتبه مثل <b>15/10</b> أو <b>15/10/2026</b>.');
    d.date = date;
    return askTime(env, d, true);
  }
  if (d?.step === 'time_text') {
    const time = parseTimeText(text);
    if (!time) return say(env, '⚠️ لم أفهم الوقت. اكتبه مثل <b>14:30</b> أو <b>9</b>.');
    d.time = time;
    return askRepeat(env, d, true);
  }
  // «نمو 8.4 70 44» ← قياس الطفل
  const growth = cfg.child && parseGrowth(text);
  if (growth) return onGrowthText(env, growth);
  // «مصروف 1500 بنزين» / «دخل 50000 راتب» ← تسجيل مالي مباشر
  const money = parseMoneyText(text);
  if (money?.explicit) return startMoney(env, money, null);
  // «اليوم» / «غدا» وحدها (خارج خطوة كتابة التاريخ) ← استعراض
  if (/^(اليوم)$/.test(text)) { const v = await dayView(env, 'today'); return say(env, v.text, v.markup); }
  if (/^(غدا|غدًا|غداً)$/.test(text)) { const v = await dayView(env, 'tomorrow'); return say(env, v.text, v.markup); }
  // سؤال («كم صرفت هذا الشهر؟») ← المساعد يجيب من بيانات Notion
  if (isQuestion(text)) { await dropDraft(env); return inBackground(onAsk(env, text.slice(0, 1000))); }
  // نص حرّ بلا مسودة ← نقترح إضافته مباشرة (مع خيار طرحه سؤالًا)
  return startAdd(env, text.slice(0, 200));
}

export async function startAdd(env, title) {
  const kinds = Object.entries(SOURCES).map(([k, s]) => ({ text: `${s.icon} ${s.label}`, callback_data: `a|k|${k}` }));
  // نص يبدأ بمبلغ (مثل «1500 بنزين») ← خيار إضافي لتسجيله مصروفًا
  if (title && (parseMoneyText(title)?.amount || 0) >= 10) kinds.push({ text: '💸 مصروف', callback_data: 'fx|from|0' });
  await env.STATE.delete('fdraft');
  const head = title ? `➕ <b>إضافة «${esc(title)}» كـ:</b>` : '➕ <b>ماذا تريد أن تضيف؟</b>';
  const msg = await say(env, head, { inline_keyboard: [kinds, title ? [{ text: '💬 سؤال للمساعد', callback_data: 'q|a' }, CANCEL_BTN] : [CANCEL_BTN]] });
  await putDraft(env, { step: 'kind', title, mid: msg.message_id });
}

export async function onAddButton(cb, env) {
  const msg = cb.message;
  if (String(msg?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, step, value] = String(cb.data).split('|');
  const d = await getDraft(env);
  if (!d || d.mid !== msg.message_id) {
    await answer(env, cb.id, 'انتهت هذه الإضافة');
    return tg(env, 'editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: NO_BUTTONS });
  }
  await answer(env, cb.id);

  if (step === 'x') {
    await dropDraft(env);
    return editMessage(env, d.mid, { text: '✖️ أُلغيت الإضافة.', markup: NO_BUTTONS });
  }
  if (step === 'k' && SOURCES[value]) {
    d.kind = value;
    if (d.title) return askDate(env, d);
    d.step = 'title';
    await putDraft(env, d);
    const the = { task: 'المهمة', reminder: 'الموعد', idea: 'الفكرة', health: 'الموعد الطبي (مثل: طبيب الأسنان)' }[value];
    return editMessage(env, d.mid, { text: `${SOURCES[value].icon} اكتب عنوان ${the}:`, markup: { inline_keyboard: [[CANCEL_BTN]] } });
  }
  if (step === 'd') {
    if (value === 'type') {
      d.step = 'date_text';
      await putDraft(env, d);
      return editMessage(env, d.mid, { text: `${draftSummary(d, env)}\n\n⌨️ اكتب التاريخ، مثل <b>15/10</b> أو <b>15/10/2026</b>:`, markup: { inline_keyboard: [[CANCEL_BTN]] } });
    }
    if (value === 'none') { d.date = null; return finishAdd(env, d); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) { d.date = value; return askTime(env, d); }
  }
  if (step === 't') {
    if (value === 'type') {
      d.step = 'time_text';
      await putDraft(env, d);
      return editMessage(env, d.mid, { text: `${draftSummary(d, env)}\n\n⌨️ اكتب الوقت، مثل <b>14:30</b>:`, markup: { inline_keyboard: [[CANCEL_BTN]] } });
    }
    if (value === 'smart') return askSmartTime(env, d);
    d.time = value === 'none' ? null : `${value.slice(0, 2)}:${value.slice(2)}`;
    return askRepeat(env, d);
  }
  if (step === 'p') {
    d.person = SOURCES.health.people[Number(value)] || null;
    return finishAdd(env, d);
  }
  if (step === 'r') {
    d.repeat = SOURCES[d.kind].repeats[Number(value)] || 'مرة واحدة';
    return finishAdd(env, d);
  }
}

// fresh=true: الخطوة جاءت بعد رسالة نصية من المستخدم ← رسالة جديدة أسفلها بدل تعديل القديمة
export async function showStep(env, d, text, markup, fresh) {
  if (fresh) {
    await tg(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: d.mid, reply_markup: NO_BUTTONS });
    d.mid = (await say(env, text, markup)).message_id;
  } else {
    await editMessage(env, d.mid, { text, markup });
  }
  await putDraft(env, d);
}

export function askDate(env, d, fresh) {
  const today = localDate(Date.now(), env.TZ_NAME);
  const b = (text, v) => ({ text, callback_data: `a|d|${v}` });
  const days = [3, 4, 5, 6, 7, 8].map(i => b(shortDay(addDays(today, i)), addDays(today, i)));
  const other = [b('⌨️ تاريخ آخر', 'type')];
  if (d.kind === 'idea') other.unshift(b('🚫 بلا تذكير', 'none'));
  d.step = 'date';
  return showStep(env, d, `${draftSummary(d, env)}\n\n📆 <b>أيّ يوم؟</b>`, { inline_keyboard: [
    [b('اليوم', today), b('غدًا', addDays(today, 1)), b('بعد غد', addDays(today, 2))],
    days.slice(0, 3), days.slice(3), other, [CANCEL_BTN],
  ] }, fresh);
}

export function askTime(env, d, fresh) {
  const b = (text, v) => ({ text, callback_data: `a|t|${v}` });
  d.step = 'time';
  return showStep(env, d, `${draftSummary(d, env)}\n\n🕘 <b>في أيّ ساعة؟</b>`, { inline_keyboard: [
    [b('🧠 اقترح وقتًا فارغًا', 'smart')],
    ...TIMES.map(row => row.map(t => b(t, t.replace(':', '')))),
    [b('بلا ساعة محددة', 'none'), b('⌨️ وقت آخر', 'type')],
    [CANCEL_BTN],
  ] }, fresh);
}

// «بساعة / بساعتين / بـ 3 ساعات / بـ 30 دقيقة»
export const leadText = min => min % 60 ? `بـ ${min} دقيقة` : min === 60 ? 'بساعة' : min === 120 ? 'بساعتين' : `بـ ${min / 60} ساعات`;

export function askPerson(env, d, fresh) {
  const b = SOURCES.health.people.map((p, i) => ({ text: `👤 ${p}`, callback_data: `a|p|${i}` }));
  d.step = 'person';
  return showStep(env, d, `${draftSummary(d, env)}\n\n👤 <b>لمن الموعد؟</b>`, { inline_keyboard: [b, [CANCEL_BTN]] }, fresh);
}

export function askRepeat(env, d, fresh) {
  if (!SOURCES[d.kind].repeats.length) return askPerson(env, d, fresh);
  const opts = SOURCES[d.kind].repeats.map((r, i) => ({ text: r === 'مرة واحدة' ? '1️⃣ مرة واحدة' : `🔁 ${r}`, callback_data: `a|r|${i}` }));
  const rows = [];
  for (let i = 0; i < opts.length; i += 3) rows.push(opts.slice(i, i + 3));
  d.step = 'repeat';
  return showStep(env, d, `${draftSummary(d, env)}\n\n🔁 <b>التكرار؟</b>`, { inline_keyboard: [...rows, [CANCEL_BTN]] }, fresh);
}

export async function finishAdd(env, d) {
  const src = SOURCES[d.kind];
  const props = {
    [src.title]: { title: [{ type: 'text', text: { content: d.title } }] },
    [src.status]: { select: { name: src.open } },
  };
  if (d.date) {
    props[src.date] = { date: d.time ? { start: `${d.date}T${d.time}:00`, time_zone: env.TZ_NAME } : { start: d.date } };
    if (d.repeat && src.repeats.length) props[src.repeat] = { select: { name: d.repeat } };
    if (d.repeat && d.repeat !== 'مرة واحدة' && src.repeats.length) props[src.auto] = { checkbox: true };
  }
  if (d.kind === 'health') {
    props['النوع'] = { select: { name: d.htype || 'موعد طبي' } };
    if (d.person) props['الشخص'] = { select: { name: d.person } };
    if (d.place) props['الطبيب/المكان'] = { rich_text: [{ type: 'text', text: { content: d.place } }] };
  }
  const page = await notion(env, 'POST', 'pages', { parent: { type: 'data_source_id', data_source_id: src.ds }, properties: props });
  await dropDraft(env);

  const lines = [`✅ <b>أُضيفت إلى Notion</b>`, draftSummary(d, env)];
  if (d.date) {
    if (d.repeat && d.repeat !== 'مرة واحدة') lines.push(`🔁 ${esc(d.repeat)}`);
    const at = d.time ? zonedToUtc(d.date, d.time, env.TZ_NAME) : zonedToUtc(d.date, `${env.DATE_ONLY_HOUR || 8}:00`, env.TZ_NAME);
    lines.push(at < Date.now() ? '⚠️ هذا الموعد مضى، سيصلك تنبيهه الآن.'
      : d.kind === 'health' ? `🔔 سأذكّرك مساء اليوم السابق${d.time ? `، وقبل الموعد ${leadText(Number(env.HEALTH_LEAD_MIN || 120))}` : ''}.` : '🔔 سأذكّرك في موعدها.');
  }
  lines.push(`<a href="${esc(page.url)}">فتح في Notion</a>`);
  await editMessage(env, d.mid, { text: lines.join('\n'), markup: NO_BUTTONS });
  return page;
}

export function draftSummary(d, env) {
  const src = SOURCES[d.kind];
  const lines = [`${src.icon} <b>${esc(d.title)}</b>`];
  if (d.date) lines.push(`📆 ${esc(fmtDay(d.date, env))}${d.time ? ` · 🕘 ${d.time}` : ''}`);
  if (d.person) lines.push(`👤 ${esc(d.person)}`);
  else if (d.date === null) lines.push('🚫 بلا تذكير');
  return lines.join('\n');
}

// ── فهم ما يكتبه المستخدم (أرقام عربية أو لاتينية)
export const toLatin = s => s.replace(/[٠-٩]/g, c => c.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, c => c.charCodeAt(0) - 0x6f0);

export function parseDateText(text, env) {
  const t = toLatin(text).trim();
  const today = localDate(Date.now(), env.TZ_NAME);
  if (/^اليوم$/.test(t)) return today;
  if (/^(غدا|غدًا|غداً)$/.test(t)) return addDays(today, 1);
  if (/^بعد ?غد$/.test(t)) return addDays(today, 2);
  let y, m, d, mt, hadYear = true;
  if ((mt = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [, y, m, d] = mt.map(Number);
  else if ((mt = t.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/))) {
    [, d, m, y] = mt.map(Number);
    if (!y) { y = Number(today.slice(0, 4)); hadYear = false; } else if (y < 100) y += 2000;
  } else return null;
  const iso = (yy) => `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(iso(y) + 'T00:00:00Z');
  if (isNaN(check) || check.getUTCDate() !== d || check.getUTCMonth() + 1 !== m) return null;
  // بلا سنة وقد مضى هذا العام ← السنة القادمة
  return !hadYear && iso(y) < today ? iso(y + 1) : iso(y);
}

export function parseTimeText(text) {
  const t = toLatin(text).trim();
  const mt = t.match(/^(\d{1,2})(?:[:.h ](\d{2}))?$/) || t.match(/^(\d{2})(\d{2})$/);
  if (!mt) return null;
  const h = Number(mt[1]), m = Number(mt[2] || 0);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
