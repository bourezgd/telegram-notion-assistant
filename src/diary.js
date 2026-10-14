import { answer, notion, tg } from './api.js';
import { cfg, DS, rt, SOURCES } from './core.js';
import { docCard, extractPhoto, saveDoc } from './docs.js';
import { daysIn } from './events.js';
import { say, startAdd } from './messages.js';
import { queryAll } from './money.js';
import { settingsView } from './settings.js';
import { fmtDay, fmtTime, localDate, pastLocalTime } from './time.js';
import { NO_BUTTONS, editMessage, esc, plainText, shortTitle } from './view.js';

// ───────────────────────── 📸 يوميات الطفل ─────────────────────────
//
// صورة تُرسل للبوت ← بطاقة «لمن؟» ← 👶 الطفل ← تُرفع إلى مجلد «صور الطفل» في Google Drive (عبر Apps Script
// من حساب المستخدم: apps-script/drive.gs) ← صفّ في «📸 يوميات الطفل» بتاريخ الالتقاط والعمر ← طلب ملاحظة.
// الرد على بطاقة صورة في أي وقت يغيّر ملاحظتها. الاستيراد من ⚙️ يسجّل صور المجلد الموجودة دفعات.
// «في مثل هذا اليوم»: صور نفس اليوم من السنوات الماضية مع تذكير المناسبات الصباحي.
// KV: drive = {url, secret, folder, folderUrl} · ph:<mid> = بطاقة صورة · pnote = {mid} ننتظر ملاحظتها
// callback: ph|<فعل>

export const DIARY = { get ds() { return DS.diary; }, title: 'الوصف', date: 'التاريخ', note: 'الملاحظة' };
export const PHOTO_TTL_S = 90 * 24 * 3600;
export const IMPORT_BATCH = 15;
// انتظار الملاحظة قصير حتى لا يُحسب نصٌّ لاحق لا علاقة له ملاحظةً (الرد على البطاقة يعمل دائمًا)
export const PNOTE_TTL_S = 15 * 60;
export const DRIVE_CODE_URL = 'https://github.com/bourezgd/telegram-notion-assistant/blob/main/apps-script/drive.gs';

export async function driveCall(env, drive, action, payload = {}) {
  rt.subreq++;
  let res = await fetch(drive.url, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, secret: drive.secret, ...payload }), redirect: 'manual',
  });
  // Apps Script يجيب دائمًا بتحويل إلى script.googleusercontent.com يُقرأ منه الرد بطلب GET
  // (متابعته تلقائيًا تعيد إرسال POST إليه فيرجع صفحة خطأ)
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) { rt.subreq++; res = await fetch(loc); }
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (!json) {
    const title = (body.match(/<title>([^<]*)<\/title>/i)?.[1] || '').trim();
    const hint = /sign in|connexion|تسجيل/i.test(title) || /accounts\.google\.com/.test(loc || '')
      ? 'الكود يطلب تسجيل الدخول: عند النشر اختر Who has access = Anyone'
      : 'تأكد أنك نسخت رابط Web app (ينتهي بـ /exec) بعد Deploy';
    throw new Error(`Google Drive: رد غير متوقع (HTTP ${res.status}${title ? ` · «${title.slice(0, 80)}»` : ''}) — ${hint}`);
  }
  if (!json.ok) throw new Error(json.error === 'unauthorized' ? 'unauthorized' : `Google Drive: ${json.error}`);
  return json;
}

// عمر الطفل في تاريخ معيّن: «8 أشهر و20 يومًا» · «سنة و3 أشهر»
export function ageText(birth, date) {
  if (!birth || !date || date < birth) return '';
  let [y1, m1, d1] = birth.split('-').map(Number);
  const [y2, m2, d2] = date.slice(0, 10).split('-').map(Number);
  let y = y2 - y1, m = m2 - m1, d = d2 - d1;
  if (d < 0) { m--; d += daysIn(y2, m2 - 1 || 12); }
  if (m < 0) { y--; m += 12; }
  if (!y && !m && !d) return 'يوم ولادتها';
  const count = (n, one, two, few, many) => n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
  const parts = [];
  if (y) parts.push(count(y, 'سنة', 'سنتان', 'سنوات', 'سنة'));
  if (m) parts.push(count(m, 'شهر', 'شهران', 'أشهر', 'شهرًا'));
  if (d && !y) parts.push(count(d, 'يوم', 'يومان', 'أيام', 'يومًا'));
  return parts.join(' و');
}

// صورة أو ملف صورة وصل ← بطاقة «لمن؟»
export async function onPhoto(message, env) {
  if (String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) return;
  const doc = message.document;
  const media = message.photo ? message.photo[message.photo.length - 1] : doc;
  if (media.file_size > 20 * 1024 * 1024) return say(env, `⚠️ الملف أكبر من 20 ميغا (حدّ تلغرام للبوتات). ارفعه مباشرة إلى مجلد «صور ${cfg.child}» في Drive ثم استورده من ⚙️.`);
  await env.STATE.delete('pnote');
  const pdf = doc?.mime_type === 'application/pdf';
  const card = await tg(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID, reply_to_message_id: message.message_id, parse_mode: 'HTML',
    text: pdf ? '📄 <b>ملف PDF</b> — أقرأ ما فيه؟' : '📸 <b>صورة جديدة</b> — ماذا أفعل بها؟',
    reply_markup: { inline_keyboard: [
      [...(pdf || !cfg.child ? [] : [{ text: `👶 صورة ل${cfg.child}`, callback_data: 'ph|n' }]), { text: '🔍 استخراج بيانات', callback_data: 'ph|d' }],
      [{ text: '✖️ تجاهل', callback_data: 'ph|x' }],
    ] },
  });
  await env.STATE.put(`ph:${card.message_id}`, JSON.stringify({
    file: media.file_id, name: doc?.file_name || null, mime: doc?.mime_type || null, at: message.date * 1000, note: (message.caption || '').trim().slice(0, 1500),
  }), { expirationTtl: 2 * 24 * 3600 });
}

export function photoCard(p, env, ask) {
  const lines = [`👶 <b>${cfg.child}</b> — صورة محفوظة ✅`, `📅 ${esc(p.dateText)}${p.age ? ` · ${esc(p.age)}` : ''}`];
  if (p.note) lines.push(`📝 ${esc(p.note)}`, ...(isMilestone(p.note) ? ['🌟 <b>لحظة أولى</b> — أُضيفت إلى /milestones'] : []));
  else if (ask) lines.push('', '✍️ <b>اكتب ملاحظة عن هذه الصورة</b> (ماذا حدث؟ أين؟ مع من؟)');
  lines.push(`<a href="${esc(p.driveUrl)}">Drive</a> · <a href="${esc(p.url)}">Notion</a>`);
  const row = [{ text: p.fav ? '⭐ مفضّلة' : '☆ مفضّلة', callback_data: 'ph|f' }];
  row.push(ask && !p.note ? { text: '⏭️ بلا ملاحظة', callback_data: 'ph|s' } : { text: '✏️ الملاحظة', callback_data: 'ph|e' });
  return { text: lines.join('\n'), markup: { inline_keyboard: [row] } };
}

// تاريخ الصورة: EXIF من Drive إن وُجد، وإلا وقت إرسالها
export function photoDate(taken, fallbackMs, env) {
  if (taken && /T\d{2}:\d{2}/.test(taken)) return { prop: { start: taken.slice(0, 19), time_zone: env.TZ_NAME }, day: taken.slice(0, 10), text: `${fmtDay(taken.slice(0, 10), env)} ${taken.slice(0, 4)} · ${taken.slice(11, 16)}` };
  if (taken) return { prop: { start: taken.slice(0, 10) }, day: taken.slice(0, 10), text: `${fmtDay(taken.slice(0, 10), env)} ${taken.slice(0, 4)}` };
  const day = localDate(fallbackMs, env.TZ_NAME);
  return {
    prop: { start: `${day}T${fmtTime(fallbackMs, env)}:00`, time_zone: env.TZ_NAME }, day,
    text: `${fmtDay(day, env)} ${day.slice(0, 4)} · ${fmtTime(fallbackMs, env)}`,
  };
}

export const noteTitle = (note, day) => note ? shortTitle(note.replace(/\n/g, ' '), 60) : `${cfg.child} — ${day}`;
export const richText = s => [{ type: 'text', text: { content: String(s).slice(0, 1900) } }];

export async function onPhotoButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const act = String(cb.data).split('|')[1];
  const mid = cb.message.message_id, key = `ph:${mid}`;
  const p = await env.STATE.get(key, 'json');
  if (!p) {
    await answer(env, cb.id, 'انتهت صلاحية هذه الرسالة');
    return tg(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: mid, reply_markup: NO_BUTTONS });
  }
  if (act === 'x') {
    await answer(env, cb.id);
    await env.STATE.delete(key);
    return tg(env, 'deleteMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_id: mid }).catch(() => {});
  }
  if (act === 'n') {
    if (p.page) return answer(env, cb.id, 'حُفظت من قبل');
    const drive = await env.STATE.get('drive', 'json');
    if (!drive) {
      await answer(env, cb.id);
      return editMessage(env, mid, {
        text: `📸 لحفظ صور ${cfg.child} اربط Google Drive أولًا: اضغط <b>⚙️</b> ثم «📸 ربط Google Drive».\nبعدها اضغط 👶 ${cfg.child} هنا من جديد.`,
        markup: cb.message.reply_markup,
      });
    }
    await answer(env, cb.id, 'أرفع الصورة…');
    await editMessage(env, mid, { text: '⏳ أرفع الصورة إلى Google Drive…', markup: NO_BUTTONS });
    try {
      const file = await tg(env, 'getFile', { file_id: p.file });
      const ext = (file.file_path.match(/\.\w+$/) || ['.jpg'])[0];
      const day = localDate(p.at, env.TZ_NAME);
      const name = p.name || `nour_${day}_${fmtTime(p.at, env).replace(':', '')}${ext}`;
      const up = await driveCall(env, drive, 'upload', { fileUrl: `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, name });
      const when = photoDate(up.taken, p.at, env);
      const age = ageText(cfg.birth, when.day);
      const page = await notion(env, 'POST', 'pages', {
        parent: { type: 'data_source_id', data_source_id: DIARY.ds },
        properties: {
          [DIARY.title]: { title: richText(noteTitle(p.note, when.day)) },
          [DIARY.date]: { date: when.prop },
          'تاريخ الرفع': { date: { start: `${localDate(Date.now(), env.TZ_NAME)}T${fmtTime(Date.now(), env)}:00`, time_zone: env.TZ_NAME } },
          'العمر': { rich_text: age ? richText(age) : [] },
          [DIARY.note]: { rich_text: p.note ? richText(p.note) : [] },
          'الصورة': { url: up.url },
          'المصدر': { select: { name: 'تلغرام' } },
          'معرّف Drive': { rich_text: richText(up.id) },
          'معرّف تلغرام': { rich_text: richText(p.file) },
        },
      });
      Object.assign(p, { page: page.id, url: page.url, driveUrl: up.url, dateText: when.text, day: when.day, age, fav: false });
      await env.STATE.put(key, JSON.stringify(p), { expirationTtl: PHOTO_TTL_S });
      if (!p.note) await env.STATE.put('pnote', JSON.stringify({ mid }), { expirationTtl: PNOTE_TTL_S });
      return editMessage(env, mid, photoCard(p, env, true));
    } catch (err) {
      const msg = err.message === 'unauthorized'
        ? 'رفض الكود كلمة السرّ: شغّل الدالة resetSecret في محرّر Apps Script ثم أعد الربط من ⚙️.'
        : String(err.message).slice(0, 250);
      return editMessage(env, mid, {
        text: `⚠️ لم تُحفظ الصورة:\n<code>${esc(msg)}</code>`,
        markup: { inline_keyboard: [[{ text: '🔁 أعد المحاولة', callback_data: 'ph|n' }, { text: '✖️ تجاهل', callback_data: 'ph|x' }]] },
      });
    }
  }
  if (act === 'd') {
    await answer(env, cb.id, 'أقرأ الوثيقة…');
    return extractPhoto(env, mid, p);
  }
  if (p.x && ['ok', 'rb', 'm'].includes(act) || act?.startsWith('p:')) {
    if (!p.x || p.saved) return answer(env, cb.id, p.saved ? 'حُفظت من قبل' : undefined);
    await answer(env, cb.id);
    if (act.startsWith('p:')) {
      if (SOURCES.health.people.includes(act.slice(2))) p.x.person = act.slice(2);
      await env.STATE.put(key, JSON.stringify(p), { expirationTtl: 2 * 24 * 3600 });
      return editMessage(env, mid, docCard(p.x, env));
    }
    if (act === 'm') {
      await env.STATE.delete(key);
      await editMessage(env, mid, { text: `🔍 ${esc(p.x.summary || p.x.title)}`, markup: NO_BUTTONS });
      return startAdd(env, p.x.title);
    }
    return saveDoc(env, mid, p, act);
  }
  if (!p.page) return answer(env, cb.id);
  if (act === 'f') {
    p.fav = !p.fav;
    await notion(env, 'PATCH', `pages/${p.page}`, { properties: { 'مفضّلة': { checkbox: p.fav } } });
    await env.STATE.put(key, JSON.stringify(p), { expirationTtl: PHOTO_TTL_S });
    await answer(env, cb.id, p.fav ? '⭐ أُضيفت للمفضّلة' : 'أُزيلت من المفضّلة');
    const waiting = (await env.STATE.get('pnote', 'json'))?.mid === mid;
    return editMessage(env, mid, photoCard(p, env, waiting));
  }
  if (act === 's') {
    await answer(env, cb.id);
    await env.STATE.delete('pnote');
    return editMessage(env, mid, photoCard(p, env, false));
  }
  if (act === 'e') {
    await answer(env, cb.id);
    await env.STATE.put('pnote', JSON.stringify({ mid }), { expirationTtl: PNOTE_TTL_S });
    const v = photoCard({ ...p, note: '' }, env, true);
    if (p.note) v.text = v.text.replace('✍️', `📝 الحالية: ${esc(p.note)}\n✍️`);
    return editMessage(env, mid, v);
  }
}

// ملاحظة مكتوبة لصورة (بعد الحفظ، أو بالرد على بطاقتها) ← true إن عولجت
export async function onPhotoNote(message, env, text) {
  const replyMid = message.reply_to_message?.message_id;
  let mid = null, p = null;
  if (replyMid) { p = await env.STATE.get(`ph:${replyMid}`, 'json'); if (p?.page) mid = replyMid; }
  if (!mid) {
    const w = await env.STATE.get('pnote', 'json');
    if (!w) return false;
    p = await env.STATE.get(`ph:${w.mid}`, 'json');
    if (!p?.page) { await env.STATE.delete('pnote'); return false; }
    mid = w.mid;
  }
  p.note = text.slice(0, 1500);
  await notion(env, 'PATCH', `pages/${p.page}`, { properties: { [DIARY.note]: { rich_text: richText(p.note) }, [DIARY.title]: { title: richText(noteTitle(p.note, p.day)) } } });
  await env.STATE.put(`ph:${mid}`, JSON.stringify(p), { expirationTtl: PHOTO_TTL_S });
  await env.STATE.delete('pnote');
  await editMessage(env, mid, photoCard(p, env, false));
  await tg(env, 'setMessageReaction', { chat_id: env.TELEGRAM_CHAT_ID, message_id: message.message_id, reaction: [{ type: 'emoji', emoji: '✍' }] }).catch(() => {});
  return true;
}

// ── ربط Drive (من الإعدادات)
export async function onDriveText(message, env, sd) {
  const url = (message.text || '').trim();
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]+\/exec\/?$/.test(url)) {
    return editMessage(env, sd.mid, {
      text: '⚠️ هذا ليس رابط Web app. يبدأ بـ <code>https://script.google.com/macros/s/</code> وينتهي بـ <code>/exec</code>.\nأرسله من جديد أو ألغِ.',
      markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'st|x' }]] },
    });
  }
  const secret = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
  const drive = { url: url.replace(/\/$/, ''), secret };
  try {
    const r = await driveCall(env, drive, 'ping');
    Object.assign(drive, { folder: r.folder, folderUrl: r.folderUrl });
  } catch (err) {
    const msg = err.message === 'unauthorized'
      ? 'هذا الكود مربوط من قبل بكلمة سرّ أخرى. في محرّر Apps Script اختر الدالة <b>resetSecret</b> واضغط Run، ثم أرسل الرابط من جديد.'
      : `<code>${esc(String(err.message).slice(0, 250))}</code>`;
    return editMessage(env, sd.mid, { text: `❌ تعذّر الاتصال بالكود:\n${msg}`, markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'st|x' }]] } });
  }
  await env.STATE.put('drive', JSON.stringify(drive));
  await env.STATE.delete('sdraft');
  const v = await settingsView(env);
  return editMessage(env, sd.mid, {
    text: `✅ <b>رُبط Google Drive</b> — مجلد <a href="${esc(drive.folderUrl)}">${esc(drive.folder)}</a>\n📸 أرسل صورة ل${cfg.child} الآن، أو استورد صور الموجودة في المجلد.\n\n${v.text}`,
    markup: v.markup,
  });
}

// ── استيراد صور المجلد الموجودة دفعةً دفعة
export async function importDrive(env, mid) {
  const drive = await env.STATE.get('drive', 'json');
  if (!drive) return;
  let r;
  try { r = await driveCall(env, drive, 'scan', { limit: IMPORT_BATCH }); } catch (err) {
    return editMessage(env, mid, { text: `⚠️ تعذّر الاستيراد:\n<code>${esc(String(err.message).slice(0, 250))}</code>`, markup: { inline_keyboard: [[{ text: '🔁 أعد المحاولة', callback_data: 'st|imp' }]] } });
  }
  const done = [];
  for (const f of r.files) {
    const when = photoDate(f.taken, Date.parse(f.created), env);
    await notion(env, 'POST', 'pages', {
      parent: { type: 'data_source_id', data_source_id: DIARY.ds },
      properties: {
        [DIARY.title]: { title: richText(`${cfg.child} — ${when.day}`) },
        [DIARY.date]: { date: when.prop },
        'تاريخ الرفع': { date: { start: localDate(Date.parse(f.created), env.TZ_NAME) } },
        'العمر': { rich_text: ageText(cfg.birth, when.day) ? richText(ageText(cfg.birth, when.day)) : [] },
        'الصورة': { url: f.url },
        'المصدر': { select: { name: 'Drive' } },
        'معرّف Drive': { rich_text: richText(f.id) },
      },
    });
    done.push(f.id);
  }
  if (done.length) await driveCall(env, drive, 'mark', { ids: done });
  const total = Number((await env.STATE.get('drive_imported')) || 0) + done.length;
  await env.STATE.put('drive_imported', String(total));
  const lines = [`📥 <b>استيراد صور ${cfg.child}</b>`, `سُجّلت ${done.length} صورة الآن · المجموع ${total}.`];
  if (r.more) lines.push('', 'بقيت صور أخرى في المجلد.');
  else lines.push('', `✅ انتهى الاستيراد. الصور في «📸 يوميات ${cfg.child}» مرتّبة بتاريخ التقاطها.`, '✍️ يمكنك إضافة الملاحظات من Notion في أي وقت.');
  return editMessage(env, mid, { text: lines.join('\n'), markup: r.more ? { inline_keyboard: [[{ text: '⏭️ الدفعة التالية', callback_data: 'st|imp' }]] } : NO_BUTTONS });
}

// ── «في مثل هذا اليوم»: صور نفس اليوم والشهر من السنوات الماضية (مرة يوميًا مع المناسبات)
export async function checkMemories(env, now) {
  if (!pastLocalTime(now, env, env.EVENTS_TIME || '09:00')) return;
  const today = localDate(now, env.TZ_NAME);
  if ((await env.STATE.get('memday')) === today) return;
  const birthYear = Number(String(cfg.birth || '').slice(0, 4)) || Number(today.slice(0, 4)) - 1;
  const days = [];
  for (let y = Number(today.slice(0, 4)) - 1; y >= birthYear && days.length < 20; y--) days.push(`${y}${today.slice(4)}`);
  if (days.length) {
    const rows = await queryAll(env, DIARY.ds, { or: days.map(d => ({ property: DIARY.date, date: { equals: d } })) });
    rows.sort((a, b) => (b.properties['مفضّلة']?.checkbox === true) - (a.properties['مفضّلة']?.checkbox === true));
    for (const row of rows.slice(0, 3)) {
      const pr = row.properties, day = pr[DIARY.date].date.start.slice(0, 10);
      const years = Number(today.slice(0, 4)) - Number(day.slice(0, 4));
      const note = plainText(pr[DIARY.note]), age = plainText(pr['العمر']), link = pr['الصورة']?.url;
      const caption = [`🕰️ <b>في مثل هذا اليوم قبل ${years === 1 ? 'سنة' : years === 2 ? 'سنتين' : `${years} سنوات`}</b>`,
        age ? `👶 ${cfg.child}: ${esc(age)}` : '', note ? `📝 ${esc(note.slice(0, 700))}` : '',
        [link ? `<a href="${esc(link)}">Drive</a>` : '', `<a href="${esc(row.url)}">Notion</a>`].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
      const tgFile = plainText(pr['معرّف تلغرام']);
      if (tgFile) await tg(env, 'sendPhoto', { chat_id: env.TELEGRAM_CHAT_ID, photo: tgFile, caption, parse_mode: 'HTML' }).catch(() => say(env, caption));
      else await say(env, caption);
    }
  }
  await env.STATE.put('memday', today, { expirationTtl: 3 * 24 * 3600 });
}

// ───────── 🌟 لحظات الطفل الأولى ─────────
// صورة ملاحظتها تبدأ بـ «أول…» (أول ابتسامة، أول سنّ، أول خطوة) أو فيها «لأول مرة» ← لحظة مميزة.
// /milestones: خطّ زمني لها بعمره في كل لحظة.
export const isMilestone = note => /^[\s\p{P}\p{S}]*(أول|اول|أوّل)\s/u.test(note || '') || /لأول مرة|لاول مرة|لأوّل مرة/.test(note || '');

export async function milestonesView(env) {
  const rows = await queryAll(env, DIARY.ds, { or: [
    { property: DIARY.note, rich_text: { starts_with: 'أول' } }, { property: DIARY.note, rich_text: { starts_with: 'اول' } },
    { property: DIARY.note, rich_text: { starts_with: 'أوّل' } }, { property: DIARY.note, rich_text: { contains: 'أول مرة' } },
    { property: DIARY.note, rich_text: { contains: 'اول مرة' } },
  ] });
  const list = rows.map(r => {
    const pr = r.properties;
    return { day: pr[DIARY.date]?.date?.start?.slice(0, 10) || '', note: plainText(pr[DIARY.note]), age: plainText(pr['العمر']) || ageText(cfg.birth, pr[DIARY.date]?.date?.start?.slice(0, 10) || ''), link: pr['الصورة']?.url || r.url };
  }).filter(m => m.day && isMilestone(m.note)).sort((a, b) => a.day.localeCompare(b.day));
  const lines = [`🌟 <b>لحظات ${esc(cfg.child)} الأولى</b>`, ''];
  if (!list.length) lines.push('لا لحظات بعد.', `عند حفظ صورة ل${esc(cfg.child)} اكتب ملاحظة تبدأ بـ «أول…»، مثل: <i>أول ابتسامة</i> · <i>أول سنّ</i> · <i>أول خطوة</i> — فتُضاف هنا تلقائيًا.`);
  for (const m of list) lines.push(`• <a href="${esc(m.link)}">${esc(shortTitle(m.note.replace(/\n/g, ' '), 80))}</a>`, `   <i>${esc(fmtDay(m.day, env))}${m.age ? ` · ${esc(m.age)}` : ''}</i>`);
  if (list.length) lines.push('', `<i>${list.length} لحظة · أضف غيرها بملاحظة تبدأ بـ «أول…»</i>`);
  return lines.join('\n');
}

// ───────── 📸 تذكير التوثيق ─────────
// إن مرّ أسبوع (CHILD_NUDGE_DAYS) بلا صورة جديدة للطفل ← تذكير لطيف الساعة CHILD_NUDGE_TIME، ثم كل أسبوع ما دام الصمت.
export async function checkChildNudge(env, now) {
  if (!cfg.child) return;
  if (!pastLocalTime(now, env, env.CHILD_NUDGE_TIME || '18:00')) return;
  const today = localDate(now, env.TZ_NAME);
  if ((await env.STATE.get('nudgeday')) === today) return;
  await env.STATE.put('nudgeday', today, { expirationTtl: 3 * 24 * 3600 });
  if (!(await env.STATE.get('drive'))) return; // بلا Drive لا تُحفظ الصور أصلًا
  const days = Number(env.CHILD_NUDGE_DAYS || 7);
  const last = await env.STATE.get('nudge_last');
  if (last && Date.parse(today) - Date.parse(last) < days * 864e5) return;
  const since = new Date(now - days * 864e5).toISOString();
  const recent = await notion(env, 'POST', `data_sources/${DIARY.ds}/query`, { filter: { timestamp: 'created_time', created_time: { on_or_after: since } }, page_size: 1 });
  if (recent.results.length) return;
  await env.STATE.put('nudge_last', today, { expirationTtl: 60 * 24 * 3600 });
  const age = ageText(cfg.birth, today);
  const [ha, hi] = cfg.girl ? ['ها', 'ها'] : ['ه', 'ه'];
  await say(env, [`📸 <b>لم نوثّق ${esc(cfg.child)} منذ ${days === 7 ? 'أسبوع' : `${days} أيام`}</b>`, age ? `عمر${ha} اليوم ${esc(age)} — كل يوم يتغيّر في${hi} شيء ✨` : '', `أرسل ل${ha} صورة اليوم مع كلمة عمّا ${cfg.girl ? 'تفعله' : 'يفعله'}.`].filter(Boolean).join('\n'));
}
