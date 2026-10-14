import { billsView } from './bills.js';
import { answer, tg } from './api.js';
import { DRIVE_CODE_URL, importDrive } from './diary.js';
import { wirdView } from './spirit.js';
import { statusView } from './status.js';
import { NO_BUTTONS, editMessage, esc } from './view.js';
import { askPrivacy } from './ask.js';
import { cfg } from './core.js';

// ───────────────────────── الإعدادات ─────────────────────────
//
// «⚙️» أو /settings: حالة مفتاح Gemini مع أزرار إضافة/تغيير/حذف. المفتاح المُرسل يُختبر لدى Google قبل
// حفظه في KV، وتُحذف رسالته من المحادثة فورًا. سرّ GITHUB (GEMINI_API_KEY) إن وُجد له الأولوية.
// callback: st|<فعل>

export const SETTINGS_BTN = '⚙️';

export async function geminiKey(env) {
  return env.GEMINI_API_KEY || (await env.STATE.get('gemini_key')) || null;
}
export const maskKey = k => `${k.slice(0, 4)}…${k.slice(-4)}`;

export async function settingsView(env) {
  const kvKey = await env.STATE.get('gemini_key');
  const key = env.GEMINI_API_KEY || kvKey;
  const lines = ['⚙️ <b>الإعدادات</b>', ''];
  lines.push(key
    ? `🎤 مفتاح Gemini: ✅ مضبوط <code>${esc(maskKey(key))}</code>${env.GEMINI_API_KEY ? ' <i>(من أسرار GitHub)</i>' : ''}`
    : '🎤 مفتاح Gemini: ❌ غير مضبوط — الرسائل الصوتية معطّلة');
  const models = key ? await env.STATE.get('gemini_models', 'json') : null;
  if (models?.length) lines.push(`🤖 النموذج: <code>${esc(models[0])}</code>`);
  lines.push('<i>احصل على مفتاح مجاني من aistudio.google.com/apikey</i>');
  const drive = await env.STATE.get('drive', 'json');
  if (cfg.child) lines.push('', drive
    ? `📸 Google Drive: ✅ مربوط — مجلد <a href="${esc(drive.folderUrl)}">${esc(drive.folder)}</a>`
    : `📸 Google Drive: ❌ غير مربوط — صور ${cfg.child} لا تُحفظ`);
  const priv = await askPrivacy(env);
  const onOff = v => v ? '✅ يُرسل' : '🔒 مستثنى';
  lines.push('', `💬 خصوصية «اسأل» (ما يُرسل إلى Gemini): 🩺 الطبي ${onOff(priv.health)} · 💰 المالية ${onOff(priv.money)}`);
  const rows = [[{ text: key ? '🔑 تغيير المفتاح' : '🔑 إضافة مفتاح Gemini', callback_data: 'st|g' }]];
  if (kvKey) rows[0].push({ text: '🗑️ حذف المفتاح', callback_data: 'st|d' });
  if (!cfg.child) { /* لا يوميات صور بلا طفل */ } else if (drive) rows.push([{ text: '📥 استيراد صور المجلد', callback_data: 'st|imp' }], [{ text: '🔗 تغيير الرابط', callback_data: 'st|dr' }, { text: '🗑️ فصل Drive', callback_data: 'st|dd' }]);
  else rows.push([{ text: '📸 ربط Google Drive', callback_data: 'st|dr' }]);
  rows.push([{ text: `🩺 ${priv.health ? 'استثنِ الطبي' : 'أرسل الطبي'}`, callback_data: 'st|ph' }, { text: `💰 ${priv.money ? 'استثنِ المالية' : 'أرسل المالية'}`, callback_data: 'st|pm' }]);
  rows.push([{ text: '🧾 الفواتير والاشتراكات', callback_data: 'st|bills' }]);
  rows.push([{ text: '📿 الأذكار والورد', callback_data: 'st|wird' }, { text: '🩺 حالة البوت', callback_data: 'st|status' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

export async function onSettingsButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const act = String(cb.data).split('|')[1];
  const mid = cb.message.message_id;
  if (act === 'g') {
    await answer(env, cb.id);
    await env.STATE.put('sdraft', JSON.stringify({ step: 'gemini', mid }), { expirationTtl: 600 });
    return editMessage(env, mid, {
      text: '🔑 <b>أرسل مفتاح Gemini الآن</b> في رسالة واحدة.\n\n🔒 سأختبره لدى Google ثم أحذف رسالتك فورًا من المحادثة.',
      markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'st|x' }]] },
    });
  }
  if (act === 'dr') {
    await answer(env, cb.id);
    await env.STATE.put('sdraft', JSON.stringify({ step: 'drive', mid }), { expirationTtl: 1800 });
    return editMessage(env, mid, {
      text: [
        '📸 <b>ربط Google Drive</b> (مرة واحدة، والأسهل من الحاسوب):',
        `1️⃣ افتح <a href="${DRIVE_CODE_URL}">كود الربط</a> وانسخه كاملًا.`,
        '2️⃣ ادخل <a href="https://script.google.com/home">script.google.com</a> ← <b>New project</b> ← احذف الموجود والصق الكود ← 💾 حفظ.\n     <i>من الهاتف: فعّل «Desktop site» من قائمة ⋮ في Chrome. وإن ظهر «unable to open the file» فالسبب تعدّد حسابات Google: افتح نافذة تصفّح متخفّي وسجّل دخولك بحساب واحد.</i>',
        '3️⃣ <b>Deploy ← New deployment</b> ← ⚙️ اختر <b>Web app</b>:\n     Execute as: <b>Me</b> · Who has access: <b>Anyone</b>\n     ← Deploy ← اسمح بالصلاحيات (Advanced ← Go to… ← Allow).',
        '4️⃣ انسخ <b>Web app URL</b> (ينتهي بـ <code>/exec</code>) و<b>أرسله هنا</b>.',
        '',
        '🔒 الصور تبقى في حسابك أنت؛ والكود يقبل الطلبات من هذا البوت فقط (كلمة سرّ تُسجَّل عند أول اتصال).',
      ].join('\n'),
      markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'st|x' }]] },
    });
  }
  if (act === 'ph' || act === 'pm') {
    const priv = await askPrivacy(env);
    const k = act === 'ph' ? 'health' : 'money';
    priv[k] = !priv[k];
    await env.STATE.put('ask_privacy', JSON.stringify(priv));
    await answer(env, cb.id, priv[k] ? 'سيُرسل إلى Gemini مع الأسئلة' : '🔒 مستثنى');
    return editMessage(env, mid, await settingsView(env));
  }
  if (act === 'bills') {
    await answer(env, cb.id);
    return editMessage(env, mid, await billsView(env));
  }
  if (act === 'wird') {
    await answer(env, cb.id);
    return editMessage(env, mid, await wirdView(env));
  }
  if (act === 'status') {
    await answer(env, cb.id, 'أفحص…');
    return editMessage(env, mid, await statusView(env));
  }
  if (act === 'dd') {
    await env.STATE.delete('drive');
    await answer(env, cb.id, 'فُصل Drive');
    return editMessage(env, mid, await settingsView(env));
  }
  if (act === 'imp') {
    await answer(env, cb.id, 'أستورد…');
    await editMessage(env, mid, { text: '📥 أبحث عن صور جديدة في المجلد… (قد يأخذ دقيقة)', markup: NO_BUTTONS });
    return importDrive(env, mid);
  }
  if (act === 'd') {
    await env.STATE.delete('gemini_key');
    await env.STATE.delete('gemini_models');
    await answer(env, cb.id, 'حُذف المفتاح');
    return editMessage(env, mid, await settingsView(env));
  }
  if (act === 'x') {
    await env.STATE.delete('sdraft');
    await answer(env, cb.id);
    return editMessage(env, mid, await settingsView(env));
  }
}

// تُستدعى من onMessage عندما ننتظر المفتاح
export async function onSettingsText(message, env, sd) {
  // أي صيغة مقبولة (تتغيّر صيغ مفاتيح Google)؛ نزيل المسافات والأسطر فقط، والحكم لـ Google
  const key = (message.text || '').replace(/\s+/g, '');
  // حذف رسالة المفتاح من المحادثة أولًا مهما كانت النتيجة
  await tg(env, 'deleteMessage', { chat_id: message.chat.id, message_id: message.message_id }).catch(() => {});
  let res, err;
  try {
    // رأس HTTP لا يقبل إلا ASCII: نص عربي مثلًا يُرفض هنا بدل أن يُسقط البوت
    if (!key || key.length > 500 || /[^\x21-\x7e]/.test(key)) throw new Error('النص المُرسل ليس مفتاحًا صالحًا');
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) err = (await res.json().catch(() => ({}))).error?.message || `HTTP ${res.status}`;
  } catch (e) { err = e.message; }
  if (err) {
    return editMessage(env, sd.mid, {
      text: `❌ لم يُقبل المفتاح (حُذفت رسالتك):\n<code>${esc(String(err).slice(0, 200))}</code>\n\nأرسل مفتاحًا آخر أو ألغِ.`,
      markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'st|x' }]] },
    });
  }
  await env.STATE.put('gemini_key', key);
  await env.STATE.delete('gemini_models');
  await env.STATE.delete('sdraft');
  const v = await settingsView(env);
  return editMessage(env, sd.mid, { text: `✅ <b>حُفظ المفتاح وجُرِّب بنجاح</b> — حُذفت رسالتك من المحادثة.\n🎤 الرسائل الصوتية جاهزة، جرّب الآن.\n\n${v.text}`, markup: v.markup });
}
