// فشل جزء واحد (عادة، أذكار، مهمة بعينها) لا يوقف بقية التنبيهات، ولا يُعاد كل دقيقة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const task = (w, title, start) => w.add('task', {
  'المهمة': P.title(title), 'الموعد': P.date(start), 'الحالة': P.select('للقيام بها'),
  'التكرار': P.select('يومي'), 'تكرار تلقائي': P.check(true),
});
const tries = (w, s) => w.sent.filter(m => m.method === 'sendMessage' && String(m.text).includes(s)).length;

test('عادة يفشل إرسالها دائمًا: تنبيهات المهام تصل في وقتها، والعادة لا تُعاد كل دقيقة', async () => {
  const w = createWorld({ now: '2026-10-03T06:59:00Z' }); // السبت 07:59
  w.add('habits', { 'العادة': P.title('شرب الماء'), 'نشطة': P.check(true), 'الوقت': P.text('08:00'), 'كل (ساعات)': P.num(2), 'حتى': P.text('22:00') });
  task(w, 'اغسل أسنانك', '2026-10-03T08:00:00.000+01:00');
  task(w, '2 فيديو + شورت', '2026-10-03T08:30:00.000+01:00');
  let habitTries = 0;
  w.tgFail = (method, body) => method === 'sendMessage' && String(body.text).includes('شرب الماء') && ++habitTries;
  for (let i = 0; i < 60; i++) { await w.cron(); w.now += 60e3; }
  assert.equal(tries(w, 'اغسل أسنانك'), 1);
  assert.equal(tries(w, '2 فيديو + شورت'), 1);
  assert.equal(w.of('task').filter(t => t.props['الموعد'].date.start.startsWith('2026-10-04')).length, 2, 'تجدّدت المهمتان');
  assert.ok(habitTries <= 2, `العادة الفاشلة أُعيدت ${habitTries} مرة`);
  w.restore();
});

test('مهمة يرفض تلغرام تنبيهها: البقية تصل، وهي لا تُعاد كل دقيقة', async () => {
  const w = createWorld({ now: '2026-10-03T06:59:30Z' });
  task(w, 'مهمة معطوبة', '2026-10-03T08:00:00.000+01:00');
  task(w, 'منشور يومي', '2026-10-03T08:00:00.000+01:00');
  task(w, '3 أخبار', '2026-10-03T08:05:00.000+01:00');
  let bad = 0;
  w.tgFail = (method, body) => method === 'sendMessage' && String(body.text).includes('مهمة معطوبة') && ++bad;
  for (let i = 0; i < 30; i++) { await w.cron(); w.now += 60e3; }
  assert.equal(tries(w, 'منشور يومي'), 1);
  assert.equal(tries(w, '3 أخبار'), 1);
  assert.ok(bad <= 2, `المهمة المعطوبة أُعيدت ${bad} مرة`);
  w.restore();
});

test('تلغرام لا يستجيب مؤقتًا: التنبيه يُعاد في الدقيقة التالية ويصل مرة واحدة', async () => {
  const w = createWorld({ now: '2026-10-03T06:59:30Z' });
  task(w, 'منشور يومي', '2026-10-03T08:00:00.000+01:00');
  let down = 3;
  w.tgFail = (method, body) => method === 'sendMessage' && String(body.text).includes('منشور يومي') && down-- > 0 && 'down';
  for (let i = 0; i < 10; i++) { await w.cron(); w.now += 60e3; }
  assert.equal(w.sent.filter(m => m.method === 'sendMessage' && String(m.text).includes('منشور يومي')).length, 1);
  assert.equal(w.of('task').filter(t => t.props['الموعد'].date.start.startsWith('2026-10-04')).length, 1, 'موعد تالٍ واحد');
  w.restore();
});
