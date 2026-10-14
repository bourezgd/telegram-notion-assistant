// اختبارات «☀️ الملخص الصباحي» و«🩺 حالة البوت».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

test('الملخص الصباحي 07:30: التاريخ الهجري، الطقس، الصلوات القادمة، المواعيد دون المهام، الأدوية، شهر مريم — مرة واحدة', async () => {
  const w = createWorld({ now: '2026-10-05T06:00:00Z' }); // 07:00 بالجزائر — قبل الموعد
  w.add('reminder', { 'التذكير': P.title('موعد البنك'), 'التاريخ': P.date('2026-10-05T15:00:00.000+01:00'), 'الحالة': P.select('قائم') });
  for (const t of ['3 أخبار', '2 متداول']) w.add('task', { 'المهمة': P.title(t), 'الموعد': P.date('2026-10-05T10:00:00.000+01:00'), 'الحالة': P.select('للقيام بها'), 'التكرار': P.select('يومي') });
  w.add('health', { 'العنوان': P.title('Doliprane'), 'النوع': P.select('دواء'), 'الحالة': P.select('مستمر'), 'التاريخ': P.date('2026-10-04', '2026-10-08'), 'الأوقات': P.text('08:00، 20:00'), 'الشخص': P.select('مريم') });
  w.add('events', { 'المناسبة': P.title('عيد ميلاد ليلى'), 'النوع': P.select('عيد ميلاد'), 'التاريخ': P.date('1996-10-08'), 'يحتاج هدية': P.check(true) });
  await w.cron();
  assert.equal(w.texts(w.flush()).filter(t => t.includes('صباح الخير')).length, 0);

  w.now = Date.parse('2026-10-05T06:31:00Z');
  await w.cron();
  const briefs = w.flush().filter(m => m.text?.includes('صباح الخير'));
  assert.equal(briefs.length, 1);
  const t = briefs[0].text;
  assert.match(t, /🌧️ مطر · 15° – 23° · ☔ 70%/);
  assert.match(t, /🕌 الظهر \d\d:\d\d · العصر/);
  assert.doesNotMatch(t, /الفجر/, 'الفجر مضى');
  assert.match(t, /مريم تُتمّ اليوم 10 أشهر/);
  assert.match(t, /بعد 3 أيام: عيد ميلاد ليلى 🎁/);
  assert.match(t, /24 ربيع الآخر 1448/);
  assert.match(t, /مواعيد اليوم[\s\S]*<code>15:00<\/code> 📅 موعد البنك/);
  assert.doesNotMatch(t, /أخبار|متداول|مهمة/, 'المهام لا تظهر في الملخص');
  assert.match(t, /Doliprane \(مريم\): 08:00، 20:00/);
  assert.deepEqual(w.buttons(briefs[0]).map(b => b.callback_data), ['mb|day']);
  await w.press('mb|day', w.nextMid);
  assert.match(w.texts(w.flush()).join('\n'), /📋 <b>اليوم/);

  w.now += 60e3;
  await w.cron();
  assert.equal(w.texts(w.flush()).filter(x => x.includes('صباح الخير')).length, 0);
  w.restore();
});

test('بعد الظهر لا يُرسل ملخص «الصباح» المتأخر، و/morning يعمل في أي وقت', async () => {
  const w = createWorld({ now: '2026-10-05T12:30:00Z' });
  await w.cron();
  assert.equal(w.texts(w.flush()).filter(t => t.includes('صباح الخير')).length, 0);
  await w.text('/morning');
  assert.match(w.texts(w.flush()).join('\n'), /صباح الخير/);
  w.restore();
});

test('/status: فحص حيّ لكل خدمة، ونبض التشغيل الدوري، وآخر عطل', async () => {
  const w = createWorld({ now: '2026-10-05T12:30:00Z', geminiKey: 'good-key' });
  await w.text('/status');
  let t = w.texts(w.flush()).join('\n');
  assert.match(t, /✅ Notion/);
  assert.match(t, /✅ تلغرام/);
  assert.match(t, /✅ Gemini/);
  assert.match(t, /⚪ Google Drive: غير مربوط/);
  assert.match(t, /لا بيانات بعد/);

  await w.cron();
  w.notionDown = true;
  w.now += 60e3;
  await w.cron();
  w.notionDown = false;
  w.now += 10 * 60e3;
  await w.text('/status');
  t = w.texts(w.flush()).at(-1);
  assert.match(t, /✅ التشغيل الدوري يعمل/);
  assert.match(t, /آخر عطل \(منذ 10 دقيقة\)[\s\S]*Notion 502/);

  w.now += 2 * 3600e3; // توقّف التشغيل الدوري ساعتين
  await w.text('/status');
  assert.match(w.texts(w.flush()).at(-1), /❌ التشغيل الدوري متوقف — آخر تشغيل منذ 2 ساعة/);
  w.restore();
});
