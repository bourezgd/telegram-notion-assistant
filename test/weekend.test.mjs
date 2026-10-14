// اختبارات الجهة في التنبيه وعطلة الجمعة والسبت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const jiha = (w, name, weekend) => w.add('jihat', { 'الاسم': P.title(name), 'العمل في العطلة': P.check(weekend) });
const task = (w, title, start, jid, extra = {}) => w.add('task', {
  'المهمة': P.title(title), 'الموعد': P.date(start), 'الحالة': P.select('للقيام بها'), 'الجهة': P.rel([jid]), ...extra,
});
const alerts = (w, s) => w.flush().filter(m => m.method === 'sendMessage' && m.text.includes(s));

test('التنبيه يذكر الجهة تحت المهمة', async () => {
  const w = createWorld({ now: '2026-09-24T13:00:30Z' }); // الخميس 14:00
  const ai = jiha(w, 'قسم التصميم — مؤسسة النخلة', false);
  task(w, 'تصميم شعار', '2026-09-24T14:00:00.000+01:00', ai, { 'التكرار': P.select('يوم بعد يوم') });
  await w.cron();
  const [m] = alerts(w, 'تصميم شعار');
  assert.match(m.text, /<b>تصميم شعار<\/b>\n🕘 14:00 · 🔁 يوم بعد يوم\n🏢 قسم التصميم\n/);
  w.restore();
});

test('الجمعة والسبت: مهام الزبائن تُرحَّل إلى الأحد بلا تنبيه، ومهام القناة الخاصة تصل', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' }); // الجمعة 11:00
  const alpha = jiha(w, 'Alpha', false), yt = jiha(w, 'قناتي الخاصة', true);
  const t1 = task(w, '3 أخبار فيديو', '2026-09-25T11:00:00.000+01:00', alpha);
  task(w, '2 فيديو + شورت', '2026-09-25T11:00:00.000+01:00', yt);
  w.add('task', { 'المهمة': P.title('شراء الخبز'), 'الموعد': P.date('2026-09-25T11:00:00.000+01:00'), 'الحالة': P.select('للقيام بها') });
  await w.cron();
  const texts = w.texts(w.flush()).filter(t => !t.includes('🕌') && !t.includes('أذكار'));
  assert.equal(texts.length, 2);
  assert.ok(texts.some(t => t.includes('2 فيديو + شورت') && t.includes('🏢 قناتي الخاصة')));
  assert.ok(texts.some(t => t.includes('شراء الخبز')), 'المهام الشخصية بلا جهة تصل');
  assert.equal(w.pages[t1].props['الموعد'].date.start, '2026-09-27T11:00:00.000+01:00', 'رُحّلت إلى الأحد بنفس الساعة');

  // الأحد: يصل تنبيهها
  w.now = Date.parse('2026-09-27T10:00:30Z');
  await w.cron();
  assert.equal(alerts(w, '3 أخبار فيديو').length, 1);
  w.restore();
});

test('التكرار التلقائي اليومي لجهة لا تعمل في العطلة: الخميس ← الأحد', async () => {
  const w = createWorld({ now: '2026-09-24T09:00:30Z' }); // الخميس 10:00
  const echo = jiha(w, 'Palm Platform', false);
  task(w, '2 متداول', '2026-09-24T10:00:00.000+01:00', echo, { 'التكرار': P.select('يومي'), 'تكرار تلقائي': P.check(true) });
  await w.cron();
  const next = w.of('task').find(t => t.props['تكرار تلقائي'].checkbox);
  assert.equal(next.props['الموعد'].date.start, '2026-09-27T10:00:00.000+01:00');
  w.restore();
});

test('مهمة معلّمة «في العطلة» تصل يوم السبت ولو كانت جهتها لا تعمل في العطلة، وتبقى في يومها أسبوعيًا', async () => {
  const w = createWorld({ now: '2026-09-26T14:00:30Z' }); // السبت 15:00
  const alpha = jiha(w, 'Alpha', false);
  task(w, 'برنامج «حصة الأسبوع»', '2026-09-26T15:00:00.000+01:00', alpha,
    { 'التكرار': P.select('أسبوعي'), 'تكرار تلقائي': P.check(true), 'في العطلة': P.check(true) });
  await w.cron();
  const [m] = alerts(w, 'حصة الأسبوع');
  assert.match(m.text, /🏢 Alpha/);
  const next = w.of('task').find(t => t.props['تكرار تلقائي'].checkbox);
  assert.equal(next.props['الموعد'].date.start, '2026-10-03T15:00:00.000+01:00', 'السبت التالي');
  assert.equal(next.props['في العطلة'].checkbox, true, 'الاستثناء يُنسخ للنسخة التالية');
  w.restore();
});

test('🧠 اقترح وقتًا فارغًا: يتجنّب المهام المؤقّتة والصلوات وما قبل الآن', async () => {
  const w = createWorld({ now: '2026-09-28T07:10:00Z' }); // الاثنين 08:10
  w.add('task', { 'المهمة': P.title('3 أخبار'), 'الموعد': P.date('2026-09-28T09:00:00.000+01:00'), 'الحالة': P.select('للقيام بها') });
  w.add('reminder', { 'التذكير': P.title('البنك'), 'التاريخ': P.date('2026-09-28T09:30:00.000+01:00'), 'الحالة': P.select('قائم') });
  await w.text('➕ إضافة');
  await w.press('a|k|task', w.draftMid('draft'));
  await w.text('مونتاج حلقة');
  await w.press('a|d|2026-09-28', w.draftMid('draft'));
  const timeMsg = w.flush().filter(m => m.reply_markup).at(-1);
  assert.equal(w.buttons(timeMsg)[0].text, '🧠 اقترح وقتًا فارغًا');
  await w.press('a|t|smart', w.draftMid('draft'));
  const smart = w.flush().filter(m => m.reply_markup).at(-1);
  // 08:10 + نصف ساعة ← من 08:40: 09:00 و09:30 مشغولان ← 10:00، 10:30، 11:00
  assert.deepEqual(w.buttons(smart).slice(0, 3).map(b => b.text), ['🕘 10:00', '🕘 10:30', '🕘 11:00']);
  await w.press('a|t|1000', w.draftMid('draft'));
  await w.press('a|r|0', w.draftMid('draft'));
  const t = w.of('task').find(x => x.props['المهمة'].title[0].plain_text === 'مونتاج حلقة');
  assert.equal(t.props['الموعد'].date.start, '2026-09-28T10:00:00.000+01:00');
  w.restore();
});
