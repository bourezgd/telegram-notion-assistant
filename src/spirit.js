import { claim, release } from './alerts.js';
import { answer, notion, tg } from './api.js';
import { cfg, DAY, HOUR } from './core.js';
import { daysBetween } from './events.js';
import { say, toLatin } from './messages.js';
import { TRACKER, prayButton, prayerTimes, trackerRow } from './prayer.js';
import { addDays, fmtDay, fmtTime, localDate, zonedToUtc } from './time.js';
import { NO_BUTTONS, editMessage, esc } from './view.js';

// ───────────────────────── 📿 الأذكار والورد القرآني ووضع رمضان ─────────────────────────
//
// • أذكار الصباح بعد الفجر، وأذكار المساء بعد العصر (بـ ADHKAR_AFTER_MIN دقيقة)، بزر «✅ قرأتها» يسجّل في
//   المتتبع مع سلسلة 🔥 للأيام المتتالية. يوم الجمعة: تذكير بسورة الكهف بعد صلاة الجمعة بـ KAHF_AFTER_MIN دقيقة.
// • الورد القرآني (/wird): صفحات يومية من مصحف المدينة (604 صفحة) الساعة WIRD_TIME، بزر «✅ قرأته» يتقدّم
//   بالصفحات ويسجّلها في المتتبع، مع تقدّم الختمة. KV: wird = { page, per, khatmas, off }
// • وضع رمضان: التاريخ الهجري تقديرًا بتقويم أم القرى (+ HIJRI_OFFSET)، ويُعتمد إعلان الرؤية في الجزائر بسؤال
//   مساء 29 شعبان و29 رمضان (KV: ramadan = { hy, start, end }). في رمضان: تذكير السحور قبل الفجر، أذان المغرب
//   رسالة إفطار بدعائه وزرّي «صمت اليوم / مفطر بعذر»، تذكير التراويح بعد العشاء، زكاة الفطر، وحصيلة يوم العيد.
// callbacks: sp|<فعل>|<تاريخ> · wd|<فعل>|<قيمة> · rm|<فعل>|<تاريخ>

export const ADHKAR = {
  common: [
    ['آية الكرسي', 1, 'https://quran.com/2/255'],
    ['الإخلاص والفلق والناس', 3, 'https://quran.com/112'],
    ['«اللَّهُمَّ أَنْتَ رَبِّي لَا إِلَهَ إِلَّا أَنْتَ، خَلَقْتَنِي وَأَنَا عَبْدُكَ، وَأَنَا عَلَى عَهْدِكَ وَوَعْدِكَ مَا اسْتَطَعْتُ، أَعُوذُ بِكَ مِنْ شَرِّ مَا صَنَعْتُ، أَبُوءُ لَكَ بِنِعْمَتِكَ عَلَيَّ، وَأَبُوءُ بِذَنْبِي فَاغْفِرْ لِي، فَإِنَّهُ لَا يَغْفِرُ الذُّنُوبَ إِلَّا أَنْتَ» <i>(سيّد الاستغفار)</i>', 1],
    ['«بِسْمِ اللَّهِ الَّذِي لَا يَضُرُّ مَعَ اسْمِهِ شَيْءٌ فِي الْأَرْضِ وَلَا فِي السَّمَاءِ وَهُوَ السَّمِيعُ الْعَلِيمُ»', 3],
    ['«رَضِيتُ بِاللَّهِ رَبًّا، وَبِالْإِسْلَامِ دِينًا، وَبِمُحَمَّدٍ ﷺ نَبِيًّا»', 3],
    ['«حَسْبِيَ اللَّهُ لَا إِلَهَ إِلَّا هُوَ عَلَيْهِ تَوَكَّلْتُ وَهُوَ رَبُّ الْعَرْشِ الْعَظِيمِ»', 7],
    ['«يَا حَيُّ يَا قَيُّومُ بِرَحْمَتِكَ أَسْتَغِيثُ، أَصْلِحْ لِي شَأْنِي كُلَّهُ، وَلَا تَكِلْنِي إِلَى نَفْسِي طَرْفَةَ عَيْنٍ»', 1],
    ['«سُبْحَانَ اللَّهِ وَبِحَمْدِهِ»', 100],
    ['«لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ، وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ»', 10],
  ],
  morning: [['«اللَّهُمَّ بِكَ أَصْبَحْنَا، وَبِكَ أَمْسَيْنَا، وَبِكَ نَحْيَا، وَبِكَ نَمُوتُ، وَإِلَيْكَ النُّشُورُ»', 1], ['«أَسْتَغْفِرُ اللَّهَ وَأَتُوبُ إِلَيْهِ»', 100]],
  evening: [['«اللَّهُمَّ بِكَ أَمْسَيْنَا، وَبِكَ أَصْبَحْنَا، وَبِكَ نَحْيَا، وَبِكَ نَمُوتُ، وَإِلَيْكَ الْمَصِيرُ»', 1], ['«أَعُوذُ بِكَلِمَاتِ اللَّهِ التَّامَّاتِ مِنْ شَرِّ مَا خَلَقَ»', 3]],
};
export const IFTAR_DUA = '«ذَهَبَ الظَّمَأُ، وَابْتَلَّتِ الْعُرُوقُ، وَثَبَتَ الْأَجْرُ إِنْ شَاءَ اللَّهُ»';
export const QURAN_PAGES = 604;
export const HIJRI_MONTHS = ['محرّم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان', 'رمضان', 'شوّال', 'ذو القعدة', 'ذو الحجّة'];
export const TRK = { am: 'أذكار الصباح', pm: 'أذكار المساء', wird: 'الورد (صفحات)', fast: 'الصيام', tar: 'التراويح' };
// مصحف المدينة: الجزء 1 صفحات 1–21، ثم كل جزء 20 صفحة (الجزء 30 من 582)
export const juzOf = p => p <= 21 ? 1 : Math.min(30, Math.floor((p - 22) / 20) + 2);
export const counted = n => n === 1 ? '' : ` <i>(×${n})</i>`;

// التاريخ الهجري (أم القرى) مع إزاحة اختيارية بالأيام
// (إن لم تدعم بيئة التشغيل هذا التقويم يُرجع أصفارًا: لا وضع رمضان تقديري، ويبقى إعلان الرؤية يعمل)
export function hijri(dateStr, env) {
  try {
    const d = new Date(Date.parse(dateStr + 'T12:00:00Z') - Number(env.HIJRI_OFFSET || 0) * DAY);
    const [m, day, y] = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric' })
      .format(d).match(/\d+/g).map(Number);
    return m >= 1 && m <= 12 && y > 1400 ? { d: day, m, y } : { d: 0, m: 0, y: 0 };
  } catch { return { d: 0, m: 0, y: 0 }; }
}
export const hijriText = (dateStr, env) => { const h = hijri(dateStr, env); return h.m ? `${h.d} ${HIJRI_MONTHS[h.m - 1]} ${h.y}` : ''; };

// يوم رمضان (1–30) أو 0: إعلان الرؤية المسجّل أولًا، وإلا التقدير الهجري
export function ramadanDay(today, env, r) {
  const h = hijri(today, env);
  if (r?.start && r.hy === h.y) {
    if (today < r.start || (r.end && today > r.end) || daysBetween(r.start, today) >= 30) return 0;
    return daysBetween(r.start, today) + 1;
  }
  return h.m === 9 ? h.d : 0;
}
export const getRamadan = async env => (await env.STATE.get('ramadan', 'json')) || {};

// أيام حتى 1 رمضان (تقديرًا، خلال 60 يومًا) أو null
export function daysToRamadan(today, env) {
  for (let i = 1; i <= 60; i++) { const h = hijri(addDays(today, i), env); if (h.m === 9 && h.d === 1) return i; }
  return null;
}

// سلسلة الأيام المتتالية (KV streak = { key: { last, n } })
export async function bumpStreak(env, key, date) {
  const s = (await env.STATE.get('streak', 'json')) || {};
  const cur = s[key] || { last: null, n: 0 };
  if (cur.last !== date) { cur.n = cur.last === addDays(date, -1) ? cur.n + 1 : 1; cur.last = date; }
  s[key] = cur;
  await env.STATE.put('streak', JSON.stringify(s));
  return cur.n;
}

export async function setTracker(env, date, props) {
  const row = await trackerRow(env, date, true);
  return notion(env, 'PATCH', `pages/${row.id}`, { properties: props });
}

export function adhkarMessage(kind, today, env) {
  const list = [...ADHKAR.common, ...ADHKAR[kind === 'am' ? 'morning' : 'evening']];
  const lines = [kind === 'am' ? '🌅 <b>أذكار الصباح</b>' : '🌇 <b>أذكار المساء</b>', '<blockquote expandable>'
    + list.map(([t, n, url]) => `• ${url ? `<a href="${url}">${t}</a>` : t}${counted(n)}`).join('\n') + '</blockquote>',
    '<i>من «حصن المسلم»</i>'];
  if (kind === 'am' && new Date(today + 'T12:00:00Z').getUTCDay() === 5) {
    lines.push('', '🕌 <b>يوم الجمعة:</b> أكثِر من الصلاة على النبي ﷺ');
  }
  return { text: lines.join('\n'), markup: { inline_keyboard: [[{ text: '✅ قرأتها', callback_data: `sp|${kind}|${today}` }, { text: '😔 نسيتها', callback_data: `sp|${kind}f|${today}` }]] } };
}

export function wirdMessage(w, today) {
  const from = w.page, to = Math.min(QURAN_PAGES, w.page + w.per - 1);
  const pct = Math.round((from - 1) / QURAN_PAGES * 100);
  const bar = '▓'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  return {
    text: [`📖 <b>وردك اليوم:</b> ${from === to ? `الصفحة ${from}` : `الصفحات ${from}–${to}`} · الجزء ${juzOf(from)}`, `${bar} الختمة ${pct}%${w.khatmas ? ` · 🏆 ${w.khatmas} ختمة` : ''}`].join('\n'),
    markup: { inline_keyboard: [
      [{ text: '📖 افتح المصحف', url: `https://quran.com/page/${from}` }],
      [{ text: '✅ قرأته', callback_data: `sp|wd|${today}` }, { text: '⏭️ ليس اليوم', callback_data: `sp|ws|${today}` }],
    ] },
  };
}

// كل دقيقة (بعد الصلاة): الأذكار، الورد، السحور، التراويح، سؤال الرؤية، زكاة الفطر، العيد
export async function checkSpiritual(env, state, now) {
  const today = localDate(now, env.TZ_NAME), times = prayerTimes(today, env);
  const off = (await env.STATE.get('spirit', 'json')) || {};
  const r = await getRamadan(env), rd = ramadanDay(today, env, r);
  let changed = false;
  // الحجز يُحفظ فورًا قبل الإرسال حتى لا يعيده تشغيل متداخل (Notion بطيء)، ويُفرج عنه إن تعذّر الإرسال مؤقتًا فقط
  const once = async (key, at, grace, fn) => {
    if (now < at || now - at > grace || state.sent[key]) return;
    if (!await claim(env, state, key, now)) return;
    changed = true;
    try { await fn(); } catch (err) { if (err.transient) await release(env, state, key); throw err; }
  };
  // «✅ قرأتها» تُسجَّل في المتتبع: هو المرجع، فلا تُرسل الأذكار إن سُجّلت ولو ضاعت علامة الإرسال
  const adhkar = kind => async () => {
    const row = await trackerRow(env, today, false).catch(() => null);
    if (row?.properties?.[TRK[kind]]?.checkbox) return;
    const v = adhkarMessage(kind, today, env);
    return say(env, v.text, v.markup);
  };
  const after = Number(env.ADHKAR_AFTER_MIN || 40) * 60e3;
  if (!off.adhkar) {
    await once(`adk:am:${today}`, times.fajr + after, 3 * HOUR, adhkar('am'));
    await once(`adk:pm:${today}`, times.asr + after, 3 * HOUR, adhkar('pm'));
    // الجمعة: سورة الكهف بعد صلاة الجمعة بساعة
    if (new Date(today + 'T12:00:00Z').getUTCDay() === 5) {
      await once(`kahf:${today}`, times.dhuhr + Number(env.KAHF_AFTER_MIN ?? 60) * 60e3, 5 * HOUR, () => say(env,
        '📖 <b>سورة الكهف</b> — جمعة مباركة\n<i>«من قرأ سورة الكهف يوم الجمعة أضاء له من النور ما بين الجمعتين»</i>',
        { inline_keyboard: [[{ text: '📖 افتح السورة', url: 'https://quran.com/18' }], [{ text: '✅ قرأتها', callback_data: `sp|kf|${today}` }]] }));
    }
  }
  const w = await env.STATE.get('wird', 'json');
  if (w && !w.off) await once(`wird:${today}`, zonedToUtc(today, env.WIRD_TIME || '20:30', env.TZ_NAME), 4 * HOUR, () => { const v = wirdMessage(w, today); return say(env, v.text, v.markup); });

  if (rd) {
    const fajr = fmtTime(times.fajr, env), imsak = fmtTime(times.fajr - 10 * 60e3, env);
    await once(`suhoor:${today}`, times.fajr - Number(env.SUHOOR_LEAD_MIN || 45) * 60e3, 40 * 60e3,
      () => say(env, `🌙 <b>السحور — ${rd} رمضان</b>\n⏳ الإمساك ${imsak} · 🕌 الفجر ${fajr}\n<i>تسحّروا فإن في السحور بركة</i>`));
    await once(`tar:${today}`, times.isha + Number(env.TARAWEEH_AFTER_MIN || 45) * 60e3, 3 * HOUR,
      () => say(env, `🕌 <b>صلاة التراويح</b> — ليلة ${rd + 1 <= 30 ? rd + 1 : rd} رمضان`, { inline_keyboard: [[{ text: '✅ صلّيت التراويح', callback_data: `sp|tar|${today}` }]] }));
    if (rd === 27) await once(`zakat:${today}`, zonedToUtc(today, '10:00', env.TZ_NAME), 8 * HOUR,
      () => say(env, `🤲 <b>زكاة الفطر</b>: تُخرج قبل صلاة العيد عنك وعن كل من تعولهم${cfg.family.length > 1 ? ` (${cfg.family.filter(x => x !== 'أنا').join(' و')})` : ''}.\n<i>قيمتها تعلنها وزارة الشؤون الدينية والأوقاف.</i>`));
  }
  // سؤال الرؤية بعد المغرب: مساء 29 شعبان (ما لم يُسجَّل بدء رمضان) ومساء 29 رمضان (ما لم تُسجَّل نهايته)
  const h = hijri(today, env);
  const askStart = !rd && h.m === 8 && h.d === 29 && !(r.start && r.hy === h.y);
  const askEnd = rd === 29 && !r.end;
  if (askStart || askEnd) {
    await once(`moon:${today}`, times.maghrib + 20 * 60e3, 4 * HOUR, () => say(env, askStart
      ? '🌙 <b>هل أُعلن ثبوت هلال رمضان؟</b>'
      : '🌙 <b>هل أُعلن ثبوت هلال شوّال؟</b>', { inline_keyboard: [askStart
      ? [{ text: 'نعم، الصيام غدًا', callback_data: `rm|s1|${today}` }, { text: 'لا، نُتمّ شعبان', callback_data: `rm|s0|${today}` }]
      : [{ text: 'نعم، العيد غدًا', callback_data: `rm|e1|${today}` }, { text: 'لا، نُتمّ 30 يومًا', callback_data: `rm|e0|${today}` }]] }));
  }
  // يوم العيد: تهنئة وحصيلة الصيام
  const yesterday = addDays(today, -1);
  if (!rd && ramadanDay(yesterday, env, r)) {
    await once(`eid:${today}`, times.fajr + after, 6 * HOUR, async () => {
      const start = r.start && r.hy === hijri(yesterday, env).y ? r.start : addDays(yesterday, 1 - ramadanDay(yesterday, env, r));
      const rows = await notion(env, 'POST', `data_sources/${TRACKER.ds}/query`, { filter: { and: [
        { property: TRACKER.date, date: { on_or_after: start } }, { property: TRACKER.date, date: { on_or_before: yesterday } },
      ] }, page_size: 40 }).then(x => x.results).catch(() => []);
      const fasted = rows.filter(x => x.properties[TRK.fast]?.select?.name === 'صائم').length;
      const excused = rows.filter(x => x.properties[TRK.fast]?.select?.name === 'مفطر بعذر').length;
      const tarw = rows.filter(x => x.properties[TRK.tar]?.checkbox).length;
      await say(env, ['🎉 <b>عيد مبارك! تقبّل الله منّا ومنكم</b>', '',
        `🌙 صمت ${fasted} يومًا${excused ? ` · 🤒 عليك قضاء ${excused} ${excused <= 10 ? 'أيام' : 'يومًا'}` : ''}`,
        tarw ? `🕌 التراويح: ${tarw} ليلة` : null,
        '', '<i>وصيام ستّ من شوّال كصيام الدهر.</i>'].filter(x => x !== null).join('\n'));
    });
  }
  return changed;
}

// زرّا الإفطار تحت أذان المغرب في رمضان
export const iftarButtons = (key, date) => ({ inline_keyboard: [...prayButton(key, date).inline_keyboard,
  [{ text: '🌙 صمت اليوم', callback_data: `rm|f|${date}` }, { text: '🤒 مفطر بعذر', callback_data: `rm|x|${date}` }]] });

export async function onSpiritButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, act, date] = String(cb.data).split('|');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return answer(env, cb.id, 'زر غير صالح');
  const mid = cb.message.message_id;
  if (act === 'am' || act === 'pm') {
    await setTracker(env, date, { [TRK[act]]: { checkbox: true } });
    const n = await bumpStreak(env, act, date);
    await answer(env, cb.id, 'تقبّل الله 🤲');
    return editMessage(env, mid, { text: `✅ <b>${TRK[act]}</b> · تقبّل الله${n > 1 ? `\n🔥 ${n} ${n <= 10 ? 'أيام' : 'يومًا'} متتالية` : ''}`, markup: NO_BUTTONS });
  }
  if (act === 'kf') {
    await answer(env, cb.id, 'تقبّل الله 🤲');
    return editMessage(env, mid, { text: '✅ <b>قرأت سورة الكهف</b> · تقبّل الله', markup: NO_BUTTONS });
  }
  // «😔 نسيتها»: لا يُسجَّل في المتتبع، وتُغلق الرسالة بلطف (السلسلة تنقطع إن لم تُقرأ اليوم)
  if (act === 'amf' || act === 'pmf') {
    const kind = act.slice(0, 2);
    await answer(env, cb.id);
    return editMessage(env, mid, { text: `😔 <b>فاتتك ${TRK[kind]} ${date === localDate(Date.now(), env.TZ_NAME) ? 'اليوم' : `يوم ${esc(fmtDay(date, env))}`}</b>\nلا بأس — ${kind === 'am' ? 'أذكار المساء بعد العصر، و' : ''}نلتقي ${kind === 'am' ? 'صباح الغد' : 'غدًا'} إن شاء الله 🤍`, markup: NO_BUTTONS });
  }
  if (act === 'tar') {
    await setTracker(env, date, { [TRK.tar]: { checkbox: true } });
    await answer(env, cb.id, 'تقبّل الله 🤲');
    return editMessage(env, mid, { text: '✅ <b>صلّيت التراويح</b> · تقبّل الله', markup: NO_BUTTONS });
  }
  if (act === 'wd' || act === 'ws') {
    const w = await env.STATE.get('wird', 'json');
    if (!w) return answer(env, cb.id, 'الورد غير مفعّل');
    if (act === 'ws') { await answer(env, cb.id); return editMessage(env, mid, { text: '⏭️ أُجّل ورد اليوم — نكمل من نفس الصفحة غدًا.', markup: NO_BUTTONS }); }
    const read = Math.min(w.per, QURAN_PAGES - w.page + 1), from = w.page;
    w.page += read;
    let done = false;
    if (w.page > QURAN_PAGES) { w.page = 1; w.khatmas = (w.khatmas || 0) + 1; done = true; }
    await env.STATE.put('wird', JSON.stringify(w));
    const row = await trackerRow(env, date, true);
    await notion(env, 'PATCH', `pages/${row.id}`, { properties: { [TRK.wird]: { number: (row.properties?.[TRK.wird]?.number || 0) + read } } });
    const n = await bumpStreak(env, 'wird', date);
    await answer(env, cb.id, 'تقبّل الله 🤲');
    return editMessage(env, mid, { text: done
      ? `🏆 <b>ختمت القرآن الكريم!</b> تقبّل الله — هذه الختمة رقم ${w.khatmas}.\n🤲 <i>اللهم اجعل القرآن ربيع قلوبنا.</i>\nنبدأ غدًا ختمة جديدة من الفاتحة.`
      : `✅ <b>قرأت ${read === 1 ? `الصفحة ${from}` : `الصفحات ${from}–${from + read - 1}`}</b> · تقبّل الله\n📍 غدًا من الصفحة ${w.page}${n > 1 ? ` · 🔥 ${n} ${n <= 10 ? 'أيام' : 'يومًا'}` : ''}`, markup: NO_BUTTONS });
  }
}

export async function onRamadanButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, act, date] = String(cb.data).split('|');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return answer(env, cb.id, 'زر غير صالح');
  const mid = cb.message.message_id;
  if (act === 'f' || act === 'x') {
    await setTracker(env, date, { [TRK.fast]: { select: { name: act === 'f' ? 'صائم' : 'مفطر بعذر' } } });
    await answer(env, cb.id, act === 'f' ? 'تقبّل الله صيامك 🤲' : 'سُجّل للقضاء');
    const kb = cb.message.reply_markup?.inline_keyboard?.slice(0, -1) || [];
    return tg(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: mid, reply_markup: { inline_keyboard: kb } })
      .then(() => say(env, act === 'f' ? '🌙 <b>تقبّل الله صيامك</b> · سُجّل في المتتبع' : '🤒 سُجّل «مفطر بعذر» — سيُحسب في أيام القضاء.'));
  }
  const r = await getRamadan(env), hy = hijri(date, env).y;
  if (act === 's1' || act === 's0') {
    Object.assign(r, { hy, start: addDays(date, act === 's1' ? 1 : 2), end: null });
    await env.STATE.put('ramadan', JSON.stringify(r));
    await answer(env, cb.id);
    return editMessage(env, mid, { text: act === 's1'
      ? '🌙 <b>رمضان مبارك!</b> الصيام غدًا إن شاء الله.\nسأذكّرك بالسحور قبل الفجر، وبالإفطار عند المغرب، وبالتراويح بعد العشاء.'
      : `🌙 نُتمّ شعبان ثلاثين يومًا — أول رمضان يوم ${esc(fmtDay(r.start, env))}.`, markup: NO_BUTTONS });
  }
  if (act === 'e1' || act === 'e0') {
    const rd = ramadanDay(date, env, r);
    if (!r.start || r.hy !== hy) Object.assign(r, { hy, start: addDays(date, 1 - (rd || 29)) });
    r.end = act === 'e1' ? date : addDays(date, 1);
    await env.STATE.put('ramadan', JSON.stringify(r));
    await answer(env, cb.id);
    return editMessage(env, mid, { text: act === 'e1' ? '🎉 <b>العيد غدًا إن شاء الله</b> — تقبّل الله صيامكم وقيامكم.' : '🌙 نُتمّ رمضان ثلاثين يومًا — العيد بعد غد إن شاء الله.', markup: NO_BUTTONS });
  }
}

// /wird أو /adhkar: الإعدادات
export async function wirdView(env) {
  const w = await env.STATE.get('wird', 'json'), off = (await env.STATE.get('spirit', 'json')) || {};
  const s = (await env.STATE.get('streak', 'json')) || {};
  const today = localDate(Date.now(), env.TZ_NAME);
  const live = k => s[k] && s[k].last >= addDays(today, -1) ? s[k].n : 0;
  const lines = ['📿 <b>الأذكار والورد القرآني</b>', '',
    `🌅🌇 الأذكار: ${off.adhkar ? '⏸️ متوقفة' : `✅ بعد الفجر والعصر بـ ${Number(env.ADHKAR_AFTER_MIN || 40)} دقيقة`}${live('am') ? ` · 🔥 الصباح ${live('am')}` : ''}${live('pm') ? ` · المساء ${live('pm')}` : ''}`];
  if (w && !w.off) {
    const left = QURAN_PAGES - w.page + 1, days = Math.ceil(left / w.per);
    lines.push(`📖 الورد: ✅ ${w.per} ${w.per <= 10 ? (w.per === 1 ? 'صفحة' : 'صفحات') : 'صفحة'} يوميًا الساعة ${esc(env.WIRD_TIME || '20:30')}`,
      `📍 الصفحة ${w.page} · الجزء ${juzOf(w.page)} · تختم بعد ${days} ${days <= 10 ? 'أيام' : 'يومًا'}${w.khatmas ? ` · 🏆 ${w.khatmas}` : ''}${live('wird') ? ` · 🔥 ${live('wird')}` : ''}`);
  } else lines.push('📖 الورد: غير مفعّل — اختر عدد الصفحات يوميًا:');
  lines.push('', '<i>20 صفحة = جزء يوميًا = ختمة في شهر (مثل رمضان)</i>');
  const rows = [
    [1, 2, 4, 5].map(n => ({ text: `${w && !w.off && w.per === n ? '● ' : ''}${n} ص`, callback_data: `wd|p|${n}` })),
    [10, 20].map(n => ({ text: `${w && !w.off && w.per === n ? '● ' : ''}${n} ص${n === 20 ? ' (جزء)' : ''}`, callback_data: `wd|p|${n}` })),
  ];
  if (w && !w.off) rows.push([{ text: '📍 غيّر الصفحة الحالية', callback_data: 'wd|pg|0' }, { text: '⏸️ أوقف الورد', callback_data: 'wd|off|0' }]);
  rows.push([{ text: off.adhkar ? '▶️ فعّل الأذكار' : '⏸️ أوقف الأذكار', callback_data: 'wd|adk|0' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

export async function onWirdButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, act, val] = String(cb.data).split('|');
  const mid = cb.message.message_id;
  const w = (await env.STATE.get('wird', 'json')) || { page: 1, per: 2, khatmas: 0 };
  if (act === 'p') { w.per = Math.min(20, Math.max(1, Number(val) || 2)); w.off = false; await env.STATE.put('wird', JSON.stringify(w)); }
  if (act === 'off') { w.off = true; await env.STATE.put('wird', JSON.stringify(w)); }
  if (act === 'adk') {
    const off = (await env.STATE.get('spirit', 'json')) || {};
    off.adhkar = !off.adhkar;
    await env.STATE.put('spirit', JSON.stringify(off));
  }
  if (act === 'pg') {
    await answer(env, cb.id);
    await env.STATE.put('sdraft', JSON.stringify({ step: 'wirdpage', mid }), { expirationTtl: 600 });
    return editMessage(env, mid, { text: '📍 <b>اكتب رقم الصفحة</b> التي ستبدأ منها (1–604).', markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'wd|x|0' }]] } });
  }
  if (act === 'x') await env.STATE.delete('sdraft');
  await answer(env, cb.id, act === 'p' ? `${w.per} صفحة يوميًا` : undefined);
  return editMessage(env, mid, await wirdView(env));
}

// نص رقم الصفحة (من onMessage)
export async function onWirdPageText(message, env, sd) {
  const n = Number(toLatin((message.text || '').trim()));
  if (!Number.isInteger(n) || n < 1 || n > QURAN_PAGES) return say(env, '⚠️ اكتب رقمًا بين 1 و604.');
  const w = (await env.STATE.get('wird', 'json')) || { page: 1, per: 2, khatmas: 0 };
  w.page = n; w.off = false;
  await env.STATE.put('wird', JSON.stringify(w));
  await env.STATE.delete('sdraft');
  return editMessage(env, sd.mid, await wirdView(env));
}
