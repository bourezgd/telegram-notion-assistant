// اختبارات «📊 الحصة الشهرية لكل جهة».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const jiha = (w, name, order, weekend = true) => w.add('jihat', { 'الاسم': P.title(name), 'ترتيب العرض': P.num(order), 'العمل في العطلة': P.check(weekend) });
const qtask = (w, title, start, qty, jid, extra = {}) => w.add('task', {
  'المهمة': P.title(title), 'الموعد': P.date(start), 'الحالة': P.select('للقيام بها'), 'الكمية': P.num(qty), 'الجهة': P.rel([jid]), ...extra,
});
const daily = { 'التكرار': P.select('يومي') };

test('/quota: المنجز من المخطط لكل جهة، مع إسقاط التكرار حتى آخر الشهر والمستحق حتى اليوم', async () => {
  const w = createWorld({ now: '2026-09-25T11:00:00Z' }); // 12:00 بالجزائر
  const alpha = jiha(w, 'Alpha', 2), echo = jiha(w, 'Palm Platform — المنصة', 1);
  // Alpha: 3 أخبار فيديو يوميًا — 24 و25 منجزة، 26 آخر نسخة (تكرار تلقائي)
  qtask(w, '3 أخبار فيديو', '2026-09-24T11:00:00.000+01:00', 3, alpha, { ...daily, 'الحالة': P.select('منجزة') });
  qtask(w, '3 أخبار فيديو', '2026-09-25T11:00:00.000+01:00', 3, alpha, { ...daily, 'الحالة': P.select('منجزة') });
  qtask(w, '3 أخبار فيديو', '2026-09-26T11:00:00.000+01:00', 3, alpha, { ...daily, 'تكرار تلقائي': P.check(true) });
  // Palm: 2 متداول اليوم ولم يُنجز، وملغاة لا تُحسب
  qtask(w, '2 متداول', '2026-09-25T10:00:00.000+01:00', 2, echo, { ...daily, 'تكرار تلقائي': P.check(true) });
  qtask(w, '2 متداول', '2026-09-23T10:00:00.000+01:00', 2, echo, { ...daily, 'الحالة': P.select('ملغاة') });
  // بلا كمية أو بلا جهة: خارج الحساب
  w.add('task', { 'المهمة': P.title('اجتماع'), 'الموعد': P.date('2026-09-25T09:00:00.000+01:00'), 'الحالة': P.select('منجزة'), 'الجهة': P.rel([alpha]) });
  await w.text('/quota');
  const msg = w.flush().find(m => m.text?.includes('الحصة الشهرية'));
  const t = msg.text;
  assert.match(t, /سبتمبر/);
  assert.match(t, /اليوم 25 من 30/);
  // Palm أولًا (ترتيب العرض 1): 0 من 2×6 (25..30)، مستحق 2 ← 🔴
  assert.match(t, /🔴 <b>Palm Platform<\/b>: 0\/12 \(0%\) · المستحق حتى اليوم 2/);
  // Alpha: 3×7 (24..30) = 21، منجز 6 من مستحق 6 ← 🟢
  assert.match(t, /🟢 <b>Alpha<\/b>: 6\/21 \(29%\) · المستحق حتى اليوم 6/);
  assert.match(t, /أخبار فيديو 6\/21/);
  assert.ok(t.indexOf('Palm') < t.indexOf('Alpha'));
  assert.match(t, /تأخّر عند: Palm Platform/);
  assert.deepEqual(w.buttons(msg).map(b => b.callback_data), ['qt|-1']);
  w.restore();
});

test('◀️ الشهر الماضي: الحصيلة الكاملة بلا إسقاط لما بعد الشهر', async () => {
  const w = createWorld({ now: '2026-09-25T11:00:00Z' });
  const z = jiha(w, 'برنامج زاد', 7);
  qtask(w, 'كتابة 10 حلقات من زاد', '2026-08-10T09:00:00.000+01:00', 10, z, { 'الحالة': P.select('منجزة') });
  qtask(w, 'تصوير 5 حلقات', '2026-08-20T09:00:00.000+01:00', 5, z);
  await w.text('الحصص');
  await w.press('qt|-1', w.nextMid);
  const t = w.texts(w.flush()).at(-1);
  assert.match(t, /أوت/);
  assert.match(t, /الشهر كاملًا/);
  assert.match(t, /🔴 <b>برنامج زاد<\/b>: 10\/15 \(67%\)/);
  w.restore();
});

test('التنبيه التلقائي: يوم 1 حصيلة الشهر الماضي مرة واحدة، ويوم 15 فقط إن تأخرت جهة', async () => {
  const w = createWorld({ now: '2026-10-01T08:30:00Z' }); // 09:30 — قبل الموعد
  const z = jiha(w, 'Alpha', 1);
  qtask(w, 'حوارات', '2026-09-07T16:30:00.000+01:00', 1, z, { 'الحالة': P.select('منجزة') });
  await w.cron();
  assert.equal(w.flush().filter(m => m.text?.includes('الحصة الشهرية')).length, 0);
  w.now = Date.parse('2026-10-01T09:05:00Z');
  await w.cron();
  const sent = w.flush().filter(m => m.text?.includes('حصيلة الحصة الشهرية'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /سبتمبر[\s\S]*Alpha<\/b>: 1\/1/);
  w.now += 60e3;
  await w.cron();
  assert.equal(w.flush().filter(m => m.text?.includes('الحصة الشهرية')).length, 0);

  // يوم 15: كل شيء في الموعد ← لا تنبيه
  w.now = Date.parse('2026-10-15T09:05:00Z');
  qtask(w, 'حوارات', '2026-10-12T16:30:00.000+01:00', 1, z, { 'الحالة': P.select('منجزة') });
  await w.cron();
  assert.equal(w.flush().filter(m => m.text?.includes('الحصة الشهرية')).length, 0);
  w.restore();
});

test('جهة لا تعمل في العطلة: الإسقاط لا يحسب الجمعة والسبت', async () => {
  const w = createWorld({ now: '2026-09-24T11:00:00Z' }); // الخميس 24 سبتمبر
  const alpha = jiha(w, 'Alpha', 1, false);
  qtask(w, '3 أخبار فيديو', '2026-09-24T11:00:00.000+01:00', 3, alpha, { ...daily, 'تكرار تلقائي': P.check(true) });
  await w.text('/quota');
  // 24، ثم 27–30 (بدون الجمعة 25 والسبت 26) = 5 أيام × 3
  assert.match(w.texts(w.flush()).join('\n'), /Alpha<\/b>: 0\/15/);
  w.restore();
});
