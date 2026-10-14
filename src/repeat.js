import { notion } from './api.js';
import { SOURCES } from './core.js';
import { nextWorkday } from './jihat.js';
import { addDays, addMonths, fmtTime, localDate } from './time.js';

// ───────────────────────── التكرار التلقائي ─────────────────────────

export const STEP = { 'يومي': [1, 'd'], 'يوم بعد يوم': [2, 'd'], 'أسبوعي': [7, 'd'], 'شهري': [1, 'm'], 'سنوي': [12, 'm'] };

// نسخة جديدة بنفس الخصائص في الموعد التالي، ثم نُطفئ «تكرار تلقائي» في الحالية حتى لا تتكرر مرتين
export async function createNext(env, item, state) {
  const src = SOURCES[item.kind];
  const [n, unit] = STEP[item.repeat];
  const base = item.hasTime ? localDate(Date.parse(item.start), env.TZ_NAME) : item.start.slice(0, 10);
  // اليوم الأصلي للتكرار الشهري/السنوي: 31 ← 28 (فيفري) ← يعود 31 في مارس بدل أن يبقى 28
  state.anchors ||= {};
  const anchor = item.raw['يوم الشهر']?.number || state.anchors[item.id] || Number(base.slice(8, 10));
  let next = unit === 'd' ? addDays(base, n) : addMonths(base, n, anchor);
  if (item.weekdayOnly) next = nextWorkday(next, env);
  const props = copyProps(item.raw);
  props[src.date] = { date: item.hasTime
    ? { start: `${next}T${fmtTime(Date.parse(item.start), env)}:00`, time_zone: env.TZ_NAME }
    : { start: next } };
  props[src.status] = { select: { name: src.open } };
  props[src.auto] = { checkbox: true };
  const created = await notion(env, 'POST', 'pages', { parent: { type: 'data_source_id', data_source_id: src.ds }, properties: props });
  await notion(env, 'PATCH', `pages/${item.id}`, { properties: { [src.auto]: { checkbox: false } } });
  delete state.anchors[item.id];
  if (unit === 'm' && anchor > 28 && !item.raw['يوم الشهر']) state.anchors[created.id.replace(/-/g, '')] = anchor;
}

// ينسخ الخصائص القابلة للكتابة فقط (الصيغ والتجميعات والتواريخ التلقائية تُتجاهل)
export function copyProps(raw) {
  const out = {};
  const rt = arr => arr.map(t => ({ type: 'text', text: { content: t.plain_text } }));
  for (const [name, p] of Object.entries(raw)) {
    switch (p.type) {
      case 'title': out[name] = { title: rt(p.title) }; break;
      case 'rich_text': out[name] = { rich_text: rt(p.rich_text) }; break;
      case 'select': if (p.select) out[name] = { select: { name: p.select.name } }; break;
      case 'multi_select': out[name] = { multi_select: p.multi_select.map(o => ({ name: o.name })) }; break;
      case 'number': out[name] = { number: p.number }; break;
      case 'checkbox': out[name] = { checkbox: p.checkbox }; break;
      case 'relation': out[name] = { relation: p.relation.map(r => ({ id: r.id })) }; break;
      case 'people': out[name] = { people: p.people.map(u => ({ id: u.id })) }; break;
      case 'url': case 'email': case 'phone_number': out[name] = { [p.type]: p[p.type] }; break;
    }
  }
  return out;
}
