import { queryItems } from './alerts.js';
import { answer } from './api.js';
import { cfg, DAY, rt, SOURCES } from './core.js';
import { dayView } from './dayview.js';
import { EVENT_ICON, inDaysText, loadEvents } from './events.js';
import { say } from './messages.js';
import { monthLine, monthTotals, queryAll } from './money.js';
import { ageText } from './diary.js';
import { PRAYERS, prayerName, prayerTimes } from './prayer.js';
import { daysToRamadan, getRamadan, hijriText, ramadanDay } from './spirit.js';
import { fmtDay, fmtTime, localDate, pastLocalTime, zonedToUtc } from './time.js';
import { esc, plainText } from './view.js';

// ───────────────────────── ☀️ الملخص الصباحي ─────────────────────────
//
// كل يوم الساعة MORNING_TIME (أو /morning): الطقس (Open-Meteo، بلا مفتاح)، مواعيد الصلاة القادمة، مهام اليوم
// ومواعيده، الأدوية، المناسبات القريبة، مصاريف الشهر، وشهر الطفل الجديد. زر «📋 اليوم» للتفاعل مع المهام.

export const WMO = c => c === 0 ? '☀️ صحو' : c <= 2 ? '🌤️ غائم جزئيًا' : c === 3 ? '☁️ غائم' : c <= 48 ? '🌫️ ضباب'
  : c <= 57 ? '🌦️ رذاذ' : c <= 67 ? '🌧️ مطر' : c <= 77 ? '❄️ ثلج' : c <= 82 ? '🌧️ زخّات مطر' : '⛈️ عواصف رعدية';

export async function weatherLine(env) {
  rt.subreq++;
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${env.CITY_LAT}&longitude=${env.CITY_LNG}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=${encodeURIComponent(env.TZ_NAME)}&forecast_days=1`);
  const d = (await r.json()).daily;
  const rain = d.precipitation_probability_max?.[0];
  return `${WMO(d.weather_code[0])} · ${Math.round(d.temperature_2m_min[0])}° – ${Math.round(d.temperature_2m_max[0])}°${rain >= 30 ? ` · ☔ ${rain}%` : ''}`;
}

export async function morningBrief(env, now) {
  const tz = env.TZ_NAME, today = localDate(now, tz), from = zonedToUtc(today, '00:00', tz);
  const [items, events, meds, weather, money] = await Promise.all([
    Promise.all(['reminder', 'health'].map(kind => queryItems(env, kind, { and: [
      { property: SOURCES[kind].date, date: { on_or_after: new Date(from - DAY).toISOString() } },
      { property: SOURCES[kind].date, date: { before: new Date(from + 2 * DAY).toISOString() } },
    ] }).catch(() => []))).then(l => l.flat().filter(i => i.localDate === today && !SOURCES[i.kind].closed.includes(i.status)).sort((a, b) => a.alertAt - b.alertAt)),
    loadEvents(env, today).catch(() => []),
    queryAll(env, SOURCES.health.ds, { and: [{ property: 'النوع', select: { equals: 'دواء' } }, { property: 'الحالة', select: { equals: 'مستمر' } }] }).catch(() => []),
    weatherLine(env).catch(() => null),
    monthTotals(env, now).catch(() => null),
  ]);
  const times = prayerTimes(today, env);
  const nextPrayers = PRAYERS.filter(p => times[p.key] > now).map(p => `${prayerName(p.key, today)} ${fmtTime(times[p.key], env)}`);
  const lines = [`☀️ <b>صباح الخير — ${esc(fmtDay(today, env))}</b>`];
  if (hijriText(today, env)) lines.push(`<i>${esc(hijriText(today, env))}</i>`);
  if (weather) lines.push(`🌡️ ${weather}`);
  if (nextPrayers.length) lines.push(`🕌 ${nextPrayers.join(' · ')}`);
  const rd = ramadanDay(today, env, await getRamadan(env));
  if (rd) lines.push(`🌙 <b>${rd} رمضان</b> · الإفطار ${fmtTime(times.maghrib, env)}`);
  else { const n = daysToRamadan(today, env); if (n && n <= 30) lines.push(`🌙 رمضان بعد ${n} ${n <= 10 ? 'أيام' : 'يومًا'} تقريبًا`); }

  // الطفل: يوم شهرها الجديد
  const birth = cfg.birth;
  if (birth && birth.slice(8) === today.slice(8) && today > birth) {
    lines.push('', `👶 <b>${esc(cfg.child)} ${cfg.girl ? 'تُتمّ' : 'يُتمّ'} اليوم ${esc(ageText(birth, today))}</b> 🎉 — أرسل ${cfg.girl ? 'لها' : 'له'} صورة اليوم لتوثيقه.`);
  }
  // المناسبات: اليوم وخلال أسبوع
  const soon = events.filter(e => e.days <= 7);
  if (soon.length) {
    lines.push('');
    for (const e of soon) lines.push(`${EVENT_ICON[e.type] || '📌'} ${e.days === 0 ? '<b>اليوم</b>' : e.days === 1 ? 'غدًا' : inDaysText(e.days)}: ${esc(e.title)}${e.gift && e.days > 0 ? ' 🎁' : ''}`);
  }
  // المواعيد فقط (التذكيرات والطبية) — المهام في «📋 اليوم»
  if (items.length) {
    lines.push('', '📅 <b>مواعيد اليوم</b>');
    for (const i of items.slice(0, 10)) lines.push(`<code>${i.hasTime ? fmtTime(Date.parse(i.start), env) : 'اليوم'}</code> ${SOURCES[i.kind].icon} ${esc(i.title)}${i.person ? ` (${esc(i.person)})` : ''}`);
    if (items.length > 10) lines.push(`<i>+ ${items.length - 10} أخرى</i>`);
  }
  // الأدوية الجارية اليوم
  const todayMeds = meds.filter(r => {
    const d = r.properties['التاريخ']?.date;
    return d?.start?.slice(0, 10) <= today && (!d.end || d.end.slice(0, 10) >= today);
  });
  if (todayMeds.length) {
    lines.push('', '💊 <b>أدوية اليوم:</b>');
    for (const r of todayMeds.slice(0, 6)) {
      const pr = r.properties, who = pr['الشخص']?.select?.name;
      lines.push(`• ${esc(plainText(pr['العنوان']))}${who ? ` (${esc(who)})` : ''}: ${esc((plainText(pr['الأوقات']).match(/\d{1,2}:\d{2}/g) || []).join('، '))}`);
    }
  }
  if (money) lines.push('', monthLine(money));
  return { text: lines.join('\n'), markup: { inline_keyboard: [[{ text: '📋 اليوم بالأزرار', callback_data: 'mb|day' }]] } };
}

export async function checkMorning(env, now) {
  if (!pastLocalTime(now, env, env.MORNING_TIME || '07:30')) return;
  const today = localDate(now, env.TZ_NAME);
  if ((await env.STATE.get('mbday')) === today) return;
  // لا نرسل ملخص «الصباح» بعد الظهر (إن تعطّل البوت صباحًا)
  if (!pastLocalTime(now, env, '12:00')) { const v = await morningBrief(env, now); await say(env, v.text, v.markup); }
  await env.STATE.put('mbday', today, { expirationTtl: 3 * 24 * 3600 });
}

export async function onMorningButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  await answer(env, cb.id);
  const v = await dayView(env, 'today');
  return say(env, v.text, v.markup);
}
