import { notion } from './api.js';
import { DS, HOUR } from './core.js';
import { addDays } from './time.js';
import { plainText } from './view.js';
import { JIHA_PROP } from './weekly.js';

// ───────────────────────── 🏢 الجهات: اسمها في التنبيه، وعطلة الجمعة والسبت ─────────────────────────
//
// من «🏢 الجهات والمشاريع» (نسخة في KV تُحدَّث كل ساعة): اسم الجهة يظهر تحت المهمة في التنبيه، ومهام الجهات
// التي لم تُعلَّم «العمل في العطلة» لا تُنبَّه أيام WEEKEND_DAYS (الجمعة والسبت): تُرحَّل إلى أول يوم عمل بنفس
// الساعة، والتكرار التلقائي يتخطّى العطلة، والحصة الشهرية لا تحسبها. المهمة المعلّمة «في العطلة» مستثناة.

export const WEEKEND_PROP = 'العمل في العطلة';
export const TASK_WEEKEND_PROP = 'في العطلة'; // استثناء لمهمة بعينها (مثل برنامج أسبوعي يوم السبت)
export const weekendDays = env => String(env.WEEKEND_DAYS ?? '5,6').split(',').filter(x => x.trim() !== '').map(Number);
export const isWeekend = (date, env) => weekendDays(env).includes(new Date(date + 'T12:00:00Z').getUTCDay());
export function nextWorkday(date, env) {
  let d = date;
  for (let i = 0; i < 7 && isWeekend(d, env); i++) d = addDays(d, 1);
  return d;
}

export async function loadJihat(env) {
  let c = await env.STATE.get('jihat2', 'json');
  if (!c || Date.now() - c.at > HOUR || Date.now() < c.at) {
    try {
      const rows = await notion(env, 'POST', `data_sources/${DS.jihat}/query`, { page_size: 100 }).then(r => r.results);
      c = { at: Date.now(), map: Object.fromEntries(rows.map(p => [p.id.replace(/-/g, ''), {
        name: plainText(Object.values(p.properties).find(x => x.type === 'title')).split(' — ')[0],
        weekend: p.properties[WEEKEND_PROP]?.checkbox === true,
      }])) };
      await env.STATE.put('jihat2', JSON.stringify(c));
    } catch { c ||= { at: 0, map: {} }; }
  }
  return c.map;
}

// يضيف للمهام: jiha (الاسم) و weekdayOnly (لا تُنبَّه في العطلة)
export async function withJiha(env, items) {
  if (!items.some(i => i.kind === 'task')) return items;
  const map = await loadJihat(env);
  for (const i of items) {
    const id = i.raw?.[JIHA_PROP]?.relation?.[0]?.id?.replace(/-/g, '');
    const j = id && map[id];
    if (!j) continue;
    i.jiha = j.name;
    i.weekdayOnly = !j.weekend && i.raw[TASK_WEEKEND_PROP]?.checkbox !== true;
  }
  return items;
}
