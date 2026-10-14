import { DAY } from './core.js';

// ───────────────────────── الوقت ─────────────────────────

// هل تجاوزت الساعة المحلية «HH:MM»؟
export function pastLocalTime(now, env, hhmm) {
  const [hh, mm = 0] = String(hhmm).split(':').map(Number);
  const minutes = Number(new Intl.DateTimeFormat('en-GB', { timeZone: env.TZ_NAME, hour: '2-digit', hourCycle: 'h23' }).format(now)) * 60
    + Number(new Intl.DateTimeFormat('en-GB', { timeZone: env.TZ_NAME, minute: '2-digit' }).format(now));
  return minutes >= hh * 60 + mm;
}

export function localDate(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
export function fmtTime(ms, env) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: env.TZ_NAME, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}
export function fmtDay(msOrDate, env) {
  const d = typeof msOrDate === 'string' ? new Date(msOrDate + 'T12:00:00Z') : new Date(msOrDate);
  const tz = typeof msOrDate === 'string' ? 'UTC' : env.TZ_NAME;
  return new Intl.DateTimeFormat('ar-DZ', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}
export function addDays(dateStr, n) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}
export function addMonths(dateStr, n, anchorDay) {
  const [y, m, d0] = dateStr.split('-').map(Number);
  const d = anchorDay || d0;
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
// «السبت 27/9»
export function shortDay(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  const wd = new Intl.DateTimeFormat('ar-DZ', { timeZone: 'UTC', weekday: 'long' }).format(new Date(dateStr + 'T12:00:00Z'));
  return `${wd} ${d}/${m}`;
}
// «YYYY-MM-DD» + «HH:MM» بتوقيت tz ← طابع زمني UTC
export function zonedToUtc(dateStr, time, tz) {
  const [hh, mm = 0] = String(time).split(':').map(Number);
  const guess = Date.parse(`${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(guess).map(p => [p.type, p.value]));
  const asLocal = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return guess - (asLocal - guess);
}
