#!/usr/bin/env node
// إنشاء قواعد Notion الاثنتي عشرة التي يعمل عليها البوت، بنفس الأعمدة التي يقرؤها الكود،
// ثم كتابة معرّفاتها (DS_*) في wrangler.toml.
//
// الاستعمال:
//   NOTION_TOKEN=ntn_xxx node scripts/setup-notion.mjs <رابط أو معرّف صفحة Notion الأم>
//
// • الصفحة الأم: صفحة فارغة في Notion (مثل «🤖 مساعدي») مشارَكة مع الـ Integration
//   (⋯ ← Connections ← اختر الـ Integration).
// • آمن لإعادة التشغيل: كل قاعدة لها معرّف في wrangler.toml تُتخطّى.
// • خيارات «الشخص» في الملف الصحي تُؤخذ من FAMILY وCHILD_NAME في wrangler.toml، فاضبطهما قبل التشغيل.

import { readFileSync, writeFileSync } from 'node:fs';

const TOML = new URL('../wrangler.toml', import.meta.url);
const NOTION_VERSION = '2025-09-03';
const token = process.env.NOTION_TOKEN;
const parentArg = process.argv[2] || process.env.NOTION_PARENT_PAGE;
if (!token || !parentArg) {
  console.error('الاستعمال: NOTION_TOKEN=ntn_xxx node scripts/setup-notion.mjs <رابط صفحة Notion الأم>');
  process.exit(1);
}
const hex = String(parentArg).replace(/-/g, '').match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0];
if (!hex) { console.error('❌ لم أجد معرّف الصفحة في:', parentArg); process.exit(1); }
const parentId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

let toml = readFileSync(TOML, 'utf8');
const tomlVar = k => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? '';

// ── أنواع الأعمدة
const title = () => ({ title: {} });
const text = () => ({ rich_text: {} });
const num = () => ({ number: { format: 'number' } });
const date = () => ({ date: {} });
const check = () => ({ checkbox: {} });
const url = () => ({ url: {} });
const created = () => ({ created_time: {} });
const COLORS = ['gray', 'blue', 'green', 'orange', 'red', 'purple', 'pink', 'yellow', 'brown', 'default'];
const opts = names => names.map((name, i) => ({ name, color: COLORS[i % COLORS.length] }));
const select = (...names) => ({ select: { options: opts(names) } });
const multi = (...names) => ({ multi_select: { options: opts(names) } });
const WEEK = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
const REPEAT = ['مرة واحدة', 'يومي', 'أسبوعي', 'شهري', 'سنوي'];

const family = [...new Set([...(tomlVar('FAMILY') || 'أنا').split(/[,،]/).map(x => x.trim()).filter(Boolean), tomlVar('CHILD_NAME').trim()].filter(Boolean))];

// ── القواعد بترتيب الإنشاء («الجهات» قبل «المهام» لأن المهام ترتبط بها)
const DATABASES = [
  { key: 'JIHAT', name: '🏢 الجهات والمشاريع', icon: '🏢', props: {
    'الاسم': title(), 'الحالة': select('نشط', 'متوقف مؤقتاً', 'منتهي'), 'الأولوية': select('عالية', 'متوسطة', 'منخفضة'),
    'العمل في العطلة': check(), 'ترتيب العرض': num(), 'دوري': text(), 'روابط': url(), 'ملاحظات': text(),
  } },
  { key: 'TASK', name: '✅ المهام', icon: '✅', props: ids => ({
    'المهمة': title(), 'الموعد': date(),
    'الحالة': select('للقيام بها', 'قيد التنفيذ', 'في الانتظار', 'منجزة', 'لم تُنجز', 'ملغاة'),
    'الأولوية': select('عاجلة', 'عالية', 'عادية'), 'الفئة': select('عمل', 'مالي', 'تذكير', 'شخصي/عائلي'),
    'التكرار': select('مرة واحدة', 'يومي', 'يوم بعد يوم', 'أسبوعي', 'شهري', 'سنوي'), 'تكرار تلقائي': check(),
    'الأيام': multi(...WEEK), 'يوم الشهر': num(), 'الكمية': num(), 'في العطلة': check(), 'ملاحظات': text(),
    'الجهة': { relation: { data_source_id: ids.JIHAT, type: 'dual_property', dual_property: {} } },
  }) },
  { key: 'REMINDER', name: '🔔 التذكيرات', icon: '🔔', props: {
    'التذكير': title(), 'التاريخ': date(), 'الحالة': select('قائم', 'تم', 'مؤجل', 'ملغاة'),
    'الأهمية': select('مهم جداً', 'مهم', 'عادي'), 'المجال': select('عمل', 'عائلة', 'مالي', 'إداري/أوراق', 'صحة', 'شخصي', 'ديني'),
    'التكرار': select(...REPEAT), 'تكرار تلقائي': check(), 'مع من / لمن': text(), 'ملاحظات': text(), 'أُضيف في': created(),
  } },
  { key: 'IDEA', name: '💡 الأفكار', icon: '💡', props: {
    'الفكرة': title(), 'التاريخ': date(), 'الحالة': select('جديدة', 'قيد الدراسة', 'مُنفّذة', 'مؤرشفة', 'ملغاة'),
    'التكرار': select(...REPEAT), 'تكرار تلقائي': check(), 'ملاحظات': text(), 'أُضيفت في': created(),
  } },
  { key: 'HEALTH', name: '🩺 الملف الصحي للعائلة', icon: '🩺', props: {
    'العنوان': title(), 'التاريخ': date(), 'النوع': select('موعد طبي', 'دواء', 'تحاليل/أشعة', 'تطعيم', 'ملاحظة/أعراض'),
    'الشخص': select(...family), 'الحالة': select('قادم', 'تم', 'مستمر'), 'الطبيب/المكان': text(), 'الأوقات': text(), 'ملاحظات': text(),
  } },
  { key: 'TRACKER', name: '🕌 متتبع الصلاة والعبادات', icon: '🕌', props: {
    'اليوم': title(), 'التاريخ': date(), 'الفجر': check(), 'الظهر': check(), 'العصر': check(), 'المغرب': check(), 'العشاء': check(),
    'أذكار الصباح': check(), 'أذكار المساء': check(), 'الورد (صفحات)': num(), 'الصيام': select('صائم', 'مفطر بعذر'), 'التراويح': check(), 'ملاحظات': text(),
  } },
  { key: 'FINANCE', name: '💰 المالية', icon: '💰', props: {
    'البيان': title(), 'التاريخ': date(), 'المبلغ (دج)': num(), 'النوع': select('دخل', 'مصروف', 'ادخار', 'دين/قرض'),
    'الفئة': select('راتب', 'عمل حر', 'كراء', 'فواتير', 'تغذية', 'صحة', 'تعليم', 'نقل', 'ملابس', 'ترفيه', 'صدقة/زكاة', 'أخرى'),
    'الحساب': select('شخصي', 'منزلي'), 'ملاحظات': text(),
  } },
  { key: 'BUDGET', name: '📋 الميزانية الشهرية', icon: '📋', props: {
    'البند': title(), 'النوع': select('دخل', 'مصروف ثابت', 'ادخار'), 'المبلغ (دج)': { number: { format: 'number_with_commas' } },
    'يوم الاستحقاق': num(), 'الدورية': select('شهري', 'كل شهرين', 'كل 3 أشهر', 'كل 6 أشهر', 'سنوي'), 'آخر دفع': date(), 'ملاحظات': text(),
  } },
  { key: 'EVENTS', name: '🎂 المناسبات العائلية', icon: '🎂', props: {
    'المناسبة': title(), 'التاريخ': date(), 'النوع': select('عيد ميلاد', 'عيد زواج', 'ذكرى', 'موعد مهم'),
    'الشخص': text(), 'يحتاج هدية': check(), 'تذكير/هدية': text(),
  } },
  { key: 'HABITS', name: '🔥 العادات', icon: '🔥', props: {
    'العادة': title(), 'نشطة': check(), 'الوقت': text(), 'الأيام': multi(...WEEK), 'كل (ساعات)': num(), 'حتى': text(),
    'إعادة التذكير (دقائق)': num(), 'السلسلة': num(), 'أطول سلسلة': num(), 'مجموع الأيام': num(), 'آخر إنجاز': date(),
  } },
  { key: 'DIARY', name: '📸 يوميات الصور', icon: '📸', props: {
    'الوصف': title(), 'التاريخ': date(), 'تاريخ الرفع': date(), 'الملاحظة': text(), 'العمر': text(), 'الصورة': url(),
    'مفضّلة': check(), 'المصدر': select('تلغرام', 'Drive'), 'معرّف Drive': text(), 'معرّف تلغرام': text(),
  } },
  { key: 'GROWTH', name: '📏 النمو', icon: '📏', props: {
    'القياس': title(), 'التاريخ': date(), 'العمر (أشهر)': num(), 'الوزن (كغ)': num(), 'الطول (سم)': num(), 'محيط الرأس (سم)': num(), 'ملاحظات': text(),
  } },
];

async function notion(method, path, body) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.code || ''}: ${j.message || JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// التأكد من الوصول للصفحة الأم
try { await notion('GET', `pages/${parentId}`); } catch (e) {
  console.error(`❌ لا وصول إلى الصفحة الأم (${e.message}).\n   شارك الصفحة مع الـ Integration: ⋯ ← Connections ← اختر الـ Integration.`);
  process.exit(1);
}

const ids = Object.fromEntries(DATABASES.map(d => [d.key, tomlVar(`DS_${d.key}`)]));
for (const d of DATABASES) {
  if (ids[d.key]) { console.log(`⏭️  ${d.name} موجودة (${ids[d.key]})`); continue; }
  const properties = typeof d.props === 'function' ? d.props(ids) : d.props;
  const db = await notion('POST', 'databases', {
    parent: { type: 'page_id', page_id: parentId },
    title: [{ type: 'text', text: { content: d.name } }],
    icon: { type: 'emoji', emoji: d.icon },
    initial_data_source: { properties },
  });
  const ds = db.data_sources?.[0]?.id;
  if (!ds) throw new Error(`لم يُرجع Notion معرّف مصدر البيانات لـ ${d.name}`);
  ids[d.key] = ds;
  toml = toml.replace(new RegExp(`^DS_${d.key}\\s*=\\s*"[^"]*"`, 'm'), `DS_${d.key} = "${ds}"`);
  writeFileSync(TOML, toml);
  console.log(`✅ ${d.name} ← ${ds}`);
}
console.log('\n✅ اكتمل. المعرّفات محفوظة في wrangler.toml — ارفعه إلى GitHub لينشر البوت بها.');
