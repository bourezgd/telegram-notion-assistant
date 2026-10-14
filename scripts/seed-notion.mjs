#!/usr/bin/env node
// تعبئة قواعد Notion ببيانات المستخدم الأولية (من مقابلة سكيل الإعداد): الجهات، مصادر الدخل،
// الفواتير والاشتراكات، العادات، والمناسبات العائلية.
//
// الاستعمال (بعد scripts/setup-notion.mjs):
//   NOTION_TOKEN=ntn_xxx node scripts/seed-notion.mjs setup/profile.json
//
// profile.json (كل الأقسام اختيارية):
// {
//   "jihat":  [{ "name": "شركة ألف", "weekend": false }],
//   "income": [{ "name": "راتب شركة ألف", "amount": 50000, "day": 7 }],
//   "bills":  [{ "name": "الكهرباء", "amount": 4000, "day": 10, "period": "كل 3 أشهر", "lastPaid": "2026-08-10" }],
//   "habits": ["رياضة 07:00", "شرب الماء كل ساعتين من 8 إلى 22", "قراءة 21:00 وذكّرني بعد ساعة"],
//   "events": [{ "title": "عيد ميلاد سارة", "date": "2025-03-14", "type": "عيد ميلاد", "person": "سارة", "gift": true }]
// }
// • period: شهري · كل شهرين · كل 3 أشهر · كل 6 أشهر · سنوي — type: عيد ميلاد · عيد زواج · ذكرى · موعد مهم
// • آمن لإعادة التشغيل: ما له نفس العنوان في قاعدته لا يُضاف مرة ثانية.

import { readFileSync } from 'node:fs';
import { habitProps, parseHabit } from '../src/habits.js';

const NOTION_VERSION = '2025-09-03';
const token = process.env.NOTION_TOKEN;
const file = process.argv[2];
if (!token || !file) {
  console.error('الاستعمال: NOTION_TOKEN=ntn_xxx node scripts/seed-notion.mjs setup/profile.json');
  process.exit(1);
}
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const tomlVar = k => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? '';
const env = { WEEKEND_DAYS: tomlVar('WEEKEND_DAYS') || '5,6' };
const profile = JSON.parse(readFileSync(file, 'utf8'));

async function notion(method, path, body) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.code || ''}: ${j.message || JSON.stringify(j).slice(0, 300)}`);
  return j;
}

const title = s => ({ title: [{ type: 'text', text: { content: String(s).slice(0, 100) } }] });
const text = s => ({ rich_text: s ? [{ type: 'text', text: { content: String(s) } }] : [] });
const PERIODS = ['شهري', 'كل شهرين', 'كل 3 أشهر', 'كل 6 أشهر', 'سنوي'];
const EVENT_TYPES = ['عيد ميلاد', 'عيد زواج', 'ذكرى', 'موعد مهم'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// العناوين الموجودة في قاعدة (لتفادي التكرار)
async function titles(ds, prop) {
  const out = new Set();
  let cursor;
  do {
    const r = await notion('POST', `data_sources/${ds}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of r.results) out.add((p.properties[prop]?.title || []).map(t => t.plain_text).join('').trim());
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

async function seed(label, key, prop, items, toProps) {
  if (!items?.length) return;
  const ds = tomlVar(`DS_${key}`);
  if (!ds) { console.error(`❌ DS_${key} فارغ في wrangler.toml — شغّل scripts/setup-notion.mjs أولًا`); process.exitCode = 1; return; }
  const have = await titles(ds, prop);
  for (const [i, item] of items.entries()) {
    const props = toProps(item, i);
    if (!props) continue;
    const name = props[prop].title[0].text.content.trim();
    if (have.has(name)) { console.log(`⏭️  ${label}: «${name}» موجودة`); continue; }
    await notion('POST', 'pages', { parent: { type: 'data_source_id', data_source_id: ds }, properties: props });
    have.add(name);
    console.log(`✅ ${label}: «${name}»`);
  }
}

await seed('جهة', 'JIHAT', 'الاسم', profile.jihat, (j, i) => ({
  'الاسم': title(j.name), 'الحالة': { select: { name: 'نشط' } }, 'العمل في العطلة': { checkbox: !!j.weekend },
  'ترتيب العرض': { number: j.order ?? i + 1 },
}));

await seed('دخل', 'BUDGET', 'البند', profile.income, x => ({
  'البند': title(x.name), 'النوع': { select: { name: 'دخل' } },
  ...(x.amount ? { 'المبلغ (دج)': { number: Number(x.amount) } } : {}),
  ...(x.day ? { 'يوم الاستحقاق': { number: Number(x.day) } } : {}),
}));

await seed('فاتورة/اشتراك', 'BUDGET', 'البند', profile.bills, x => ({
  'البند': title(x.name), 'النوع': { select: { name: 'مصروف ثابت' } },
  ...(x.amount ? { 'المبلغ (دج)': { number: Number(x.amount) } } : {}),
  ...(x.day ? { 'يوم الاستحقاق': { number: Number(x.day) } } : {}),
  'الدورية': { select: { name: PERIODS.includes(x.period) ? x.period : 'شهري' } },
  ...(isDate(x.lastPaid) ? { 'آخر دفع': { date: { start: x.lastPaid } } } : {}),
}));

await seed('عادة', 'HABITS', 'العادة', profile.habits, h => {
  const p = parseHabit(typeof h === 'string' ? h : h.text);
  return p.name ? habitProps(p, env) : null;
});

await seed('مناسبة', 'EVENTS', 'المناسبة', profile.events, e => isDate(e.date) ? {
  'المناسبة': title(e.title), 'التاريخ': { date: { start: e.date } },
  'النوع': { select: { name: EVENT_TYPES.includes(e.type) ? e.type : 'موعد مهم' } },
  ...(e.person ? { 'الشخص': text(e.person) } : {}), 'يحتاج هدية': { checkbox: !!e.gift },
} : (console.error(`⚠️ مناسبة «${e.title}» بلا تاريخ صحيح (YYYY-MM-DD) — تُخطّيت`), null));

console.log('\n✅ اكتملت التعبئة.');
