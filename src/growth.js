import { answer, notion, tg } from './api.js';
import { cfg, DS, SOURCES } from './core.js';
import { daysBetween } from './events.js';
import { toLatin, say } from './messages.js';
import { queryAll } from './money.js';
import { ageText, richText } from './diary.js';
import { addMonths, fmtDay, localDate } from './time.js';
import { NO_BUTTONS, editMessage, esc } from './view.js';

// ───────────────────────── 📏 نمو الطفل و💉 رزنامة تلقيحها ─────────────────────────
//
// • «نمو 8.4 70 44» (الوزن كغ، الطول سم، محيط الرأس سم — أو بوحداتها «8.4 كغ 70 سم») ← صف في «📏 نمو الطفل»
//   بعمرها بالأشهر، مع الفرق عن القياس السابق ومقارنة بمتوسط منظمة الصحة العالمية للبنات، ورسم بياني (QuickChart).
//   /growth: آخر القياسات والرسم.
// • /vaccines: رزنامة التلقيح الوطنية الجزائرية (2016) محسوبة من تاريخ الميلاد، وزر لإضافة المواعيد القادمة إلى
//   «🩺 الملف الصحي» (نوع «تطعيم») فتصل تذكيراتها كبقية المواعيد الطبية. تُراجع مع الطبيب ودفتر التلقيح.
// callback: vc|add

// متوسط منظمة الصحة العالمية للبنات (الوسيط): الأشهر 0–12 ثم 15، 18، 21، 24
export const WHO_MONTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 21, 24];
// متوسطات منظمة الصحة العالمية (الوزن كغ، الطول سم) للبنات والأولاد حسب CHILD_SEX
const WHO = {
  girl: { weight: [3.2, 4.2, 5.1, 5.8, 6.4, 6.9, 7.3, 7.6, 7.9, 8.2, 8.5, 8.7, 8.9, 9.6, 10.2, 10.9, 11.5], height: [49.1, 53.7, 57.1, 59.8, 62.1, 64.0, 65.7, 67.3, 68.7, 70.1, 71.5, 72.8, 74.0, 77.5, 80.7, 83.7, 86.4] },
  boy: { weight: [3.3, 4.5, 5.6, 6.4, 7.0, 7.5, 7.9, 8.3, 8.6, 8.9, 9.2, 9.4, 9.6, 10.3, 10.9, 11.5, 12.2], height: [49.9, 54.7, 58.4, 61.4, 63.9, 65.9, 67.6, 69.2, 70.6, 72.0, 73.3, 74.5, 75.7, 79.1, 82.3, 85.1, 87.8] },
};
export const whoTable = key => (cfg.girl ? WHO.girl : WHO.boy)[key];
export function whoAt(table, m) {
  if (m <= 0) return table[0];
  for (let i = 1; i < WHO_MONTHS.length; i++) {
    if (m <= WHO_MONTHS[i]) { const a = WHO_MONTHS[i - 1], b = WHO_MONTHS[i]; return table[i - 1] + (table[i] - table[i - 1]) * (m - a) / (b - a); }
  }
  return null; // بعد 24 شهرًا لا مقارنة
}
export const monthsOld = (birth, date) => Math.round(daysBetween(birth, date) / 30.4375 * 10) / 10;
const n1 = x => Math.round(x * 10) / 10;

// «نمو 8.4 70 44» / «قياس 8.4 كغ 70 سم» ← { weight, height, head } أو null
export function parseGrowth(text) {
  const m = toLatin(text).trim().match(/^(?:نمو|قياس|📏)\s+(.+)$/);
  if (!m) return null;
  const out = {}, bare = [];
  for (const t of m[1].matchAll(/(\d+(?:[.,]\d+)?)\s*(كغ|كلغ|kg|كيلو|سم|cm|رأس|راس)?/gi)) {
    const v = Number(t[1].replace(',', '.')), u = (t[2] || '').toLowerCase();
    if (/كغ|كلغ|kg|كيلو/.test(u)) out.weight = v; else if (/رأس|راس/.test(u)) out.head = v; else if (/سم|cm/.test(u)) (out.height ? out.head = v : out.height = v); else bare.push(v);
  }
  for (const v of bare) {
    if (out.weight == null && v >= 1.5 && v <= 40) out.weight = v;
    else if (out.height == null && v > 40 && v <= 130) out.height = v;
    else if (out.head == null && v >= 30 && v <= 60) out.head = v;
  }
  if (out.weight != null && (out.weight < 1.5 || out.weight > 40)) delete out.weight;
  if (out.height != null && (out.height < 40 || out.height > 130)) delete out.height;
  if (out.head != null && (out.head < 30 || out.head > 60)) delete out.head;
  return Object.keys(out).length ? out : null;
}

export async function loadGrowth(env) {
  const rows = await queryAll(env, DS.growth, null);
  return rows.map(r => {
    const p = r.properties;
    return { date: p['التاريخ']?.date?.start?.slice(0, 10), weight: p['الوزن (كغ)']?.number ?? null, height: p['الطول (سم)']?.number ?? null, head: p['محيط الرأس (سم)']?.number ?? null };
  }).filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date));
}

// رسم لمقياس واحد (محور واحد): قياسات الطفل بالأزرق، ومتوسط منظمة الصحة خطًا رماديًا متقطّعًا للمرجع
function chartUrl(list, birth, key) {
  const [label, unit, table] = key === 'weight' ? ['Weight', 'kg', whoTable('weight')] : ['Height', 'cm', whoTable('height')];
  const data = list.filter(r => r[key] != null).map(r => ({ x: monthsOld(birth, r.date), y: r[key] }));
  const maxM = Math.min(24, Math.max(12, Math.ceil(Math.max(0, ...data.map(p => p.x))) + 2));
  const chart = {
    type: 'line',
    data: { datasets: [
      { label: `Child (${unit})`, data, borderColor: '#2a78d6', backgroundColor: '#2a78d6', borderWidth: 2, pointRadius: 4, fill: false, lineTension: 0.2 },
      { label: `WHO median (${cfg.girl ? 'girls' : 'boys'})`, data: WHO_MONTHS.filter(m => m <= maxM).map(m => ({ x: m, y: whoAt(table, m) })), borderColor: '#8a8983', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, fill: false },
    ] },
    options: {
      title: { display: true, text: `${label} (${unit})`, fontColor: '#0b0b0b' },
      legend: { labels: { fontColor: '#52514e' } },
      scales: {
        xAxes: [{ type: 'linear', ticks: { min: 0, max: maxM, stepSize: 1, fontColor: '#52514e' }, gridLines: { color: '#ecebe7' }, scaleLabel: { display: true, labelString: 'Age (months)', fontColor: '#52514e' } }],
        yAxes: [{ ticks: { fontColor: '#52514e' }, gridLines: { color: '#ecebe7' }, scaleLabel: { display: true, labelString: unit, fontColor: '#52514e' } }],
      },
    },
  };
  return `https://quickchart.io/chart?w=700&h=400&bkg=%23fcfcfb&c=${encodeURIComponent(JSON.stringify(chart))}`;
}

function growthText(list, birth, head = `📏 <b>نمو ${cfg.child}</b>`) {
  if (!list.length) return `${head}\nلا قياسات بعد. اكتب مثلًا: <code>نمو 8.4 70 44</code> (الوزن كغ، الطول سم، محيط الرأس سم).`;
  const last = list[list.length - 1], prev = list[list.length - 2];
  const m = monthsOld(birth, last.date);
  const diff = (k, u) => prev?.[k] != null && last[k] != null ? ` (${last[k] - prev[k] >= 0 ? '+' : ''}${n1(last[k] - prev[k])} ${u} منذ ${esc(fmtDay(prev.date, {}))})` : '';
  const lines = [head, `📅 ${esc(fmtDay(last.date, {}))} · ${esc(ageText(birth, last.date))}`];
  const ww = whoAt(whoTable('weight'), m), wh = whoAt(whoTable('height'), m);
  if (last.weight != null) lines.push(`⚖️ الوزن: <b>${last.weight} كغ</b>${diff('weight', 'كغ')}${ww ? ` — المتوسط لعمر${cfg.girl ? 'ها' : 'ه'} ${n1(ww)}` : ''}`);
  if (last.height != null) lines.push(`📏 الطول: <b>${last.height} سم</b>${diff('height', 'سم')}${wh ? ` — المتوسط لعمر${cfg.girl ? 'ها' : 'ه'} ${n1(wh)}` : ''}`);
  if (last.head != null) lines.push(`⭕ محيط الرأس: <b>${last.head} سم</b>${diff('head', 'سم')}`);
  lines.push('<i>المتوسط للبنات حسب منظمة الصحة العالمية؛ التقييم لطبيبها.</i>');
  return lines.join('\n');
}

async function sendGrowth(env, list, birth, head) {
  const text = growthText(list, birth, head);
  const charts = ['weight', 'height'].filter(k => list.some(r => r[k] != null)).map(k => chartUrl(list, birth, k));
  if (charts.length) {
    const ok = await (charts.length === 1
      ? tg(env, 'sendPhoto', { chat_id: env.TELEGRAM_CHAT_ID, photo: charts[0], caption: text, parse_mode: 'HTML' })
      : tg(env, 'sendMediaGroup', { chat_id: env.TELEGRAM_CHAT_ID, media: charts.map((url, i) => ({ type: 'photo', media: url, ...(i ? {} : { caption: text, parse_mode: 'HTML' }) })) })
    ).then(() => true).catch(() => false);
    if (ok) return;
  }
  return say(env, text);
}

export async function onGrowthText(env, g) {
  const birth = cfg.birth, today = localDate(Date.now(), env.TZ_NAME);
  const title = [g.weight != null && `${g.weight} كغ`, g.height != null && `${g.height} سم`, g.head != null && `رأس ${g.head} سم`].filter(Boolean).join(' · ');
  await notion(env, 'POST', 'pages', { parent: { type: 'data_source_id', data_source_id: DS.growth }, properties: {
    'القياس': { title: richText(title) }, 'التاريخ': { date: { start: today } },
    ...(birth ? { 'العمر (أشهر)': { number: monthsOld(birth, today) } } : {}),
    ...(g.weight != null ? { 'الوزن (كغ)': { number: g.weight } } : {}),
    ...(g.height != null ? { 'الطول (سم)': { number: g.height } } : {}),
    ...(g.head != null ? { 'محيط الرأس (سم)': { number: g.head } } : {}),
  } });
  return sendGrowth(env, await loadGrowth(env), birth, `✅ <b>سُجّل قياس ${cfg.child}</b>`);
}

export async function growthView(env) {
  return sendGrowth(env, await loadGrowth(env), cfg.birth);
}

// ── 💉 الرزنامة الوطنية للتلقيح (الجزائر، 2016) — للتأكد مع الطبيب
const VACCINES = [
  [0, 'عند الولادة', 'BCG · التهاب الكبد ب (HBV) · شلل الأطفال الفموي (VPO)'],
  [2, 'شهران', 'الخماسي (DTC-Hib-HBV) · VPO · VPI · المكوّرات الرئوية (PCV)'],
  [4, '4 أشهر', 'الخماسي (DTC-Hib-HBV) · VPO · المكوّرات الرئوية (PCV)'],
  [11, '11 شهرًا', 'الحصبة والنكاف والحصبة الألمانية (ROR)'],
  [12, '12 شهرًا', 'الخماسي (DTC-Hib-HBV) · VPO · المكوّرات الرئوية (PCV)'],
  [18, '18 شهرًا', 'الحصبة والنكاف والحصبة الألمانية (ROR)'],
  [72, '6 سنوات', 'DTC · VPO'],
];

async function vaccineRows(env) {
  return queryAll(env, SOURCES.health.ds, { and: [{ property: 'النوع', select: { equals: 'تطعيم' } }, { property: 'الشخص', select: { equals: `${cfg.child}` } }] }).catch(() => []);
}

export async function vaccinesView(env) {
  const birth = cfg.birth, today = localDate(Date.now(), env.TZ_NAME);
  if (!birth) return { text: `💉 تاريخ ميلاد ${cfg.child} غير مضبوط (CHILD_BIRTH).`, markup: NO_BUTTONS };
  const existing = new Set((await vaccineRows(env)).map(r => r.properties['التاريخ']?.date?.start?.slice(0, 10)));
  const lines = [`💉 <b>رزنامة تلقيح ${cfg.child}</b>`, '<i>حسب الرزنامة الوطنية الجزائرية (2016) — تأكّد من كل موعد مع الطبيب ودفتر التلقيح.</i>', ''];
  let upcoming = 0;
  for (const [m, label, list] of VACCINES) {
    const date = addMonths(birth, m);
    const past = date < today, added = existing.has(date);
    if (!past && !added) upcoming++;
    lines.push(`${past ? '✔️' : added ? '📌' : '📅'} <b>${label}</b> — ${esc(fmtDay(date, {}))} ${date.slice(0, 4)}${past ? ' <i>(مضى)</i>' : added ? ' <i>(في الملف الصحي)</i>' : ''}`, `     ${esc(list)}`);
  }
  lines.push('', '<i>بعدها: 11–13 سنة (dT · VPO) و16–18 سنة (dT).</i>');
  const markup = upcoming ? { inline_keyboard: [[{ text: `✅ أضف ${upcoming} مواعيد قادمة إلى الملف الصحي`, callback_data: 'vc|add' }]] } : NO_BUTTONS;
  return { text: lines.join('\n'), markup };
}

export async function onVaccineButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const birth = cfg.birth, today = localDate(Date.now(), env.TZ_NAME);
  const existing = new Set((await vaccineRows(env)).map(r => r.properties['التاريخ']?.date?.start?.slice(0, 10)));
  let n = 0;
  for (const [m, label, list] of VACCINES) {
    const date = addMonths(birth, m);
    if (date < today || existing.has(date)) continue;
    await notion(env, 'POST', 'pages', { parent: { type: 'data_source_id', data_source_id: SOURCES.health.ds }, properties: {
      'العنوان': { title: richText(`تلقيح ${label}: ${list}`) }, 'النوع': { select: { name: 'تطعيم' } }, 'الحالة': { select: { name: 'قادم' } },
      'الشخص': { select: { name: `${cfg.child}` } }, 'التاريخ': { date: { start: date } },
      'ملاحظات': { rich_text: richText('حسب الرزنامة الوطنية — تأكّد من الموعد مع الطبيب ودفتر التلقيح') },
    } });
    n++;
  }
  await answer(env, cb.id, n ? `أُضيفت ${n}` : 'لا جديد');
  const v = await vaccinesView(env);
  return editMessage(env, cb.message.message_id, { text: `✅ أُضيفت ${n} مواعيد تلقيح إلى «🩺 الملف الصحي» — ستصلك تذكيراتها مساء اليوم السابق وصباح يومها.\n\n${v.text}`, markup: v.markup });
}
