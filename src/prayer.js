import { loadState, saveState } from './alerts.js';
import { answer, notion } from './api.js';
import { DS, HOUR } from './core.js';
import { say } from './messages.js';
import { IFTAR_DUA, getRamadan, iftarButtons, ramadanDay } from './spirit.js';
import { addDays, fmtDay, fmtTime, localDate } from './time.js';
import { NO_BUTTONS, editMessage } from './view.js';

// ───────────────────────── الصلاة ─────────────────────────
//
// أوقات الصلاة تُحسب فلكيًا داخل البوت (طريقة PrayTimes) بإعدادات الجزائر: الفجر 18°، العشاء 17°، العصر شافعي.
// عند الأذان: رسالة بزر «✅ صلّيت» يسجّل في «🕌 متتبع الصلاة والعادات». وإن لم تُسجَّل خلال
// PRAYER_REMIND_MIN دقيقة: تذكير ثانٍ واحد.

export const TRACKER = { get ds() { return DS.tracker; }, title: 'اليوم', date: 'التاريخ' };
export const PRAYERS = [
  { key: 'fajr', name: 'الفجر' }, { key: 'dhuhr', name: 'الظهر' }, { key: 'asr', name: 'العصر' },
  { key: 'maghrib', name: 'المغرب' }, { key: 'isha', name: 'العشاء' },
];
export const PRAYER_GRACE_MS = 60 * 60e3; // لا تنبيه لأذان مضى عليه أكثر من ساعة

export const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
export const fix = (a, b) => ((a % b) + b) % b;

export function sunPosition(jd) {
  const D = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * D, 360);
  const q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(q + 1.915 * Math.sin(rad(g)) + 0.020 * Math.sin(rad(2 * g)), 360);
  const e = 23.439 - 0.00000036 * D;
  const RA = fix(deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15, 24);
  return { decl: deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L)))), eqt: q / 15 - RA };
}

// أوقات صلوات يوم محلي «YYYY-MM-DD» ← طوابع UTC
export function prayerTimes(dateStr, env) {
  const lat = Number(env.CITY_LAT), lng = Number(env.CITY_LNG);
  let [y, m, d] = dateStr.split('-').map(Number);
  const Y = m <= 2 ? y - 1 : y, M = m <= 2 ? m + 12 : m, A = Math.floor(Y / 100);
  const jd = Math.floor(365.25 * (Y + 4716)) + Math.floor(30.6001 * (M + 1)) + d + 2 - A + Math.floor(A / 4) - 1524.5 - lng / 360;
  const noon = t => fix(12 - sunPosition(jd + t).eqt, 24);
  const angleTime = (angle, t, before) => {
    const { decl } = sunPosition(jd + t);
    const T = deg(Math.acos((-Math.sin(rad(angle)) - Math.sin(rad(decl)) * Math.sin(rad(lat))) / (Math.cos(rad(decl)) * Math.cos(rad(lat))))) / 15;
    return noon(t) + (before ? -T : T);
  };
  const asrAngle = t => -deg(Math.atan(1 / (1 + Math.tan(rad(Math.abs(lat - sunPosition(jd + t).decl))))));
  const hours = {
    fajr: angleTime(18, 5 / 24, true),
    dhuhr: noon(12 / 24),
    asr: angleTime(asrAngle(13 / 24), 13 / 24, false),
    maghrib: angleTime(0.833, 18 / 24, false),
    isha: angleTime(17, 18 / 24, false),
  };
  const offsets = String(env.PRAYER_OFFSETS || '0,0,0,0,0').split(',').map(Number);
  const base = Date.UTC(y, m - 1, d);
  return Object.fromEntries(PRAYERS.map(({ key }, i) =>
    [key, Math.round((base + (hours[key] - lng / 15) * HOUR + (offsets[i] || 0) * 60e3) / 60e3) * 60e3]));
}

export const prayerName = (key, dateStr) =>
  key === 'dhuhr' && new Date(dateStr + 'T12:00:00Z').getUTCDay() === 5 ? 'الجمعة' : PRAYERS.find(p => p.key === key).name;
export const prayButton = (key, date) => ({ inline_keyboard: [[{ text: '✅ صلّيت', callback_data: `pr|${key}|${date}` }]] });

export async function checkPrayers(env, state, now) {
  let calls = 0, changed = false;
  state.prayers ||= {};
  const today = localDate(now, env.TZ_NAME);
  const times = prayerTimes(today, env);
  const remindMs = Number(env.PRAYER_REMIND_MIN || 30) * 60e3;
  for (const { key } of PRAYERS) {
    const at = times[key], id = `${today}:${key}`;
    const p = state.prayers[id] ||= { mids: [] };
    if (!p.sent && now >= at) {
      p.sent = true; changed = true;
      if (now - at > PRAYER_GRACE_MS) { p.done = true; continue; } // فات منذ زمن (مثلًا بعد تعطّل)
      let text = `🕌 <b>حان وقت صلاة ${prayerName(key, today)}</b>\n🕘 ${fmtTime(at, env)}`, markup = prayButton(key, today);
      // رمضان: أذان المغرب = الإفطار
      const rd = key === 'maghrib' ? ramadanDay(today, env, await getRamadan(env)) : 0;
      if (rd) { text = `🌅 <b>حان وقت الإفطار — ${rd} رمضان</b>\n🕘 المغرب ${fmtTime(at, env)}\n🤲 ${IFTAR_DUA}`; markup = iftarButtons(key, today); }
      const msg = await say(env, text, markup);
      p.mids.push(msg.message_id); calls++;
    } else if (p.sent && !p.done && !p.reminded && now >= at + remindMs) {
      p.reminded = true; changed = true;
      // ربما سجّلها في Notion مباشرة (إن تعطّل Notion نذكّر على كل حال)
      const row = await trackerRow(env, today, false).catch(() => null); calls++;
      if (row?.properties[PRAYERS.find(x => x.key === key).name]?.checkbox) { p.done = true; continue; }
      const msg = await say(env, `⏳ <b>لم تسجّل صلاة ${prayerName(key, today)} بعد</b>\nأذّن ${fmtTime(at, env)}`, prayButton(key, today));
      p.mids.push(msg.message_id); calls++;
    }
  }
  for (const k of Object.keys(state.prayers)) if (k.slice(0, 10) < addDays(today, -2)) { delete state.prayers[k]; changed = true; }
  return { calls, changed };
}

// صف اليوم في المتتبع (يُنشأ عند الحاجة)
export async function trackerRow(env, date, create) {
  const res = await notion(env, 'POST', `data_sources/${TRACKER.ds}/query`, {
    filter: { property: TRACKER.date, date: { equals: date } }, page_size: 1,
  });
  if (res.results[0] || !create) return res.results[0] || null;
  return notion(env, 'POST', 'pages', {
    parent: { type: 'data_source_id', data_source_id: TRACKER.ds },
    properties: {
      [TRACKER.title]: { title: [{ type: 'text', text: { content: fmtDay(date, env) } }] },
      [TRACKER.date]: { date: { start: date } },
    },
  });
}

export async function onPrayerButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, key, date] = String(cb.data).split('|');
  const prayer = PRAYERS.find(p => p.key === key);
  if (!prayer || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return answer(env, cb.id, 'زر غير صالح');
  const row = await trackerRow(env, date, true);
  await notion(env, 'PATCH', `pages/${row.id}`, { properties: { [prayer.name]: { checkbox: true } } });
  await answer(env, cb.id, 'تقبّل الله 🤲');

  const state = await loadState(env);
  const p = state.prayers?.[`${date}:${key}`];
  const text = `✅ <b>صلّيت ${prayerName(key, date)}</b> · تقبّل الله\n<i>سُجّلت في متتبع الصلاة</i>`;
  const mids = new Set([cb.message.message_id, ...(p?.mids || [])]);
  // أزرار أخرى في نفس الرسالة (مثل «صمت اليوم» عند الإفطار) تبقى
  const rest = (cb.message.reply_markup?.inline_keyboard || []).filter(r => !r.some(b => String(b.callback_data).startsWith('pr|')));
  for (const mid of mids) await editMessage(env, mid, { text, markup: mid === cb.message.message_id && rest.length ? { inline_keyboard: rest } : NO_BUTTONS });
  if (p) { p.done = true; await saveState(env, state); }
}
