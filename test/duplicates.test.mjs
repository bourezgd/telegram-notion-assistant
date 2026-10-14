// النسخ المكررة من المهمة نفسها: لا تتكاثر مع التكرار التلقائي، وتُنظَّف، و«📋 اليوم» يذكر جهة كل مهمة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const jiha = (w, name) => w.add('jihat', { 'الاسم': P.title(name), 'العمل في العطلة': P.check(true) });
const task = (w, title, start, extra = {}) => w.add('task', {
  'المهمة': P.title(title), 'الموعد': P.date(start), 'الحالة': P.select('للقيام بها'), ...extra,
});
const daily = { 'التكرار': P.select('يومي'), 'تكرار تلقائي': P.check(true) };
const live = (w, title) => w.of('task').filter(t => t.props['المهمة'].title[0].plain_text === title);
const alerts = (w, s) => w.flush().filter(m => m.method === 'sendMessage' && m.text.includes(s));

test('نسختان مفتوحتان من المهمة نفسها: تنبيه واحد، والثانية إلى السلة، وموعد تالٍ واحد', async () => {
  const w = createWorld({ now: '2026-09-29T13:00:30Z' }); // الثلاثاء 14:00
  const ai = jiha(w, 'قسم التصميم');
  for (let i = 0; i < 2; i++) task(w, 'تصميم شعار', '2026-09-29T14:00:00.000+01:00', { ...daily, 'الجهة': P.rel([ai]) });
  task(w, 'تصميم شعار', '2026-09-29T13:00:00.000Z', { ...daily, 'الجهة': P.rel([ai]) }); // نفس الموعد بصيغة UTC
  await w.cron();
  assert.equal(alerts(w, 'تصميم شعار').length, 1);
  const left = live(w, 'تصميم شعار');
  assert.equal(left.filter(t => t.props['الموعد'].date.start.startsWith('2026-09-29')).length, 1, 'بقيت نسخة واحدة اليوم');
  assert.equal(left.filter(t => t.props['الموعد'].date.start.startsWith('2026-09-30')).length, 1, 'وموعد واحد غدًا');
  w.restore();
});

test('الموعد التالي موجود مسبقًا: لا يُنشأ مرة ثانية', async () => {
  const w = createWorld({ now: '2026-09-29T10:00:30Z' });
  const src = task(w, 'منشور يومي', '2026-09-29T11:00:00.000+01:00', daily);
  task(w, 'منشور يومي', '2026-09-30T11:00:00.000+01:00', daily); // أنشأته نسخة مكررة قبلها
  await w.cron();
  assert.equal(live(w, 'منشور يومي').length, 2);
  assert.equal(w.pages[src].props['تكرار تلقائي'].checkbox, false, 'الحالية لم تعد تتكرر');
  w.restore();
});

test('العنوان نفسه في الوقت نفسه لجهتين مختلفتين: ليستا مكررتين', async () => {
  const w = createWorld({ now: '2026-09-29T10:00:30Z' });
  const a = jiha(w, 'Alpha'), b = jiha(w, 'النخلة');
  task(w, '3 أخبار فيديو', '2026-09-29T11:00:00.000+01:00', { ...daily, 'الجهة': P.rel([a]) });
  task(w, '3 أخبار فيديو', '2026-09-29T11:00:00.000+01:00', { ...daily, 'الجهة': P.rel([b]) });
  await w.cron();
  assert.equal(alerts(w, '3 أخبار فيديو').length, 2);
  assert.equal(live(w, '3 أخبار فيديو').length, 4, 'لكل جهة مهمتها وموعدها التالي');
  w.restore();
});

test('«📋 اليوم» يذكر جهة كل مهمة، والمهمة بلا جهة «شخصي»', async () => {
  const w = createWorld({ now: '2026-09-29T07:00:00Z' });
  const yt = jiha(w, 'قناتي الخاصة — المحتوى');
  task(w, '2 فيديو + شورت', '2026-09-29T09:00:00.000+01:00', { 'الجهة': P.rel([yt]) });
  task(w, 'اتصل بالوالدين', '2026-09-29T18:00:00.000+01:00');
  await w.text('/today');
  const text = w.texts(w.flush()).find(t => t.includes('📋'));
  assert.match(text, /2 فيديو \+ شورت · 🏢 قناتي الخاصة\n/);
  assert.match(text, /اتصل بالوالدين · 👤 شخصي/);
  w.restore();
});
