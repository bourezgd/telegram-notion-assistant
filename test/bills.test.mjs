// اختبارات الرواتب والفواتير والتحليل الشهري.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const budget = (w, name, type, amount, day, extra = {}) => w.add('budget', {
  'البند': P.title(name), 'النوع': P.select(type), 'المبلغ (دج)': P.num(amount), ...(day ? { 'يوم الاستحقاق': P.num(day) } : {}), ...extra,
});
const fin = (w, title, type, amount, date, cat = 'أخرى') => w.add('fin', {
  'البيان': P.title(title), 'النوع': P.select(type), 'المبلغ (دج)': P.num(amount), 'الفئة': P.select(cat), 'التاريخ': P.date(date),
});
const sent = (w, s) => w.flush().filter(m => m.method === 'sendMessage' && m.text.includes(s));

test('راتب لم يُسجَّل بعد موعده بيومين ← تنبيه، و«✅ قبضته» يسجّله دخلًا ولا يتكرر', async () => {
  const w = createWorld({ now: '2026-10-08T09:05:00Z' }); // 10:05، يوم 8
  const alpha = budget(w, 'راتب Alpha', 'دخل', 50000, 7);   // موعده 7 ← لم يمضِ يومان
  budget(w, 'راتب العيادة', 'دخل', 35000, 4);               // موعده 4 ← مضى 4 أيام
  budget(w, 'راتب النخلة', 'دخل', 100000, 25);
  await w.cron();
  const msgs = sent(w, 'لم يُسجَّل');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /راتب العيادة[\s\S]*35,000 دج · موعده يوم 4/);
  const id = w.buttons(msgs[0])[0].callback_data.split('|')[2];
  await w.press(`bl|in|${id}`, w.nextMid);
  const [row] = w.of('fin');
  assert.equal(row.props['البيان'].title[0].plain_text, 'راتب العيادة');
  assert.equal(row.props['النوع'].select.name, 'دخل');
  assert.equal(row.props['الفئة'].select.name, 'راتب');
  // اليوم التالي: Alpha صار متأخرًا يومين، والعيادة لا يتكرر
  w.now = Date.parse('2026-10-09T09:05:00Z');
  await w.cron();
  const next = sent(w, 'لم يُسجَّل');
  assert.equal(next.length, 1);
  assert.match(next[0].text, /راتب Alpha/);
  void alpha;
  w.restore();
});

test('راتب سُجّل يدويًا («Alpha» في البيان) ← لا تنبيه، و«⏰ بعد 3 أيام» يؤجّل', async () => {
  const w = createWorld({ now: '2026-10-10T09:05:00Z' });
  budget(w, 'راتب Alpha', 'دخل', 50000, 7);
  const tb = budget(w, 'راتب العيادة', 'دخل', 35000, 4);
  fin(w, 'راتب Alpha أكتوبر', 'دخل', 50000, '2026-10-08', 'راتب');
  await w.cron();
  const msgs = sent(w, 'لم يُسجَّل');
  assert.equal(msgs.length, 1);
  await w.press(`bl|snz|${tb}`, w.nextMid);
  for (const d of ['11', '12']) { w.now = Date.parse(`2026-10-${d}T09:05:00Z`); await w.cron(); }
  assert.equal(sent(w, 'لم يُسجَّل').length, 0);
  w.now = Date.parse('2026-10-13T09:05:00Z');
  await w.cron();
  assert.equal(sent(w, 'لم يُسجَّل').length, 1);
  w.restore();
});

test('فاتورة: تذكير قبل موعدها بيومين، «💸 دفعته» يسجّلها ويحدّث «آخر دفع»، والفصلية لا تتكرر قبل 3 أشهر', async () => {
  const w = createWorld({ now: '2026-10-03T09:05:00Z' });
  const rent = budget(w, 'كراء السكن', 'مصروف ثابت', 35000, 5);
  const gaz = budget(w, 'فاتورة سونلغاز', 'مصروف ثابت', 6000, 5, { 'الدورية': P.select('كل 3 أشهر'), 'آخر دفع': P.date('2026-09-05') });
  budget(w, 'مصروف مريم', 'مصروف ثابت', 20000); // بلا يوم استحقاق ← لا تذكير
  await w.cron();
  const msgs = sent(w, 'يستحق');
  assert.equal(msgs.length, 1, 'سونلغاز دُفعت الشهر الماضي وهي فصلية');
  assert.match(msgs[0].text, /كراء السكن<\/b> — يستحق بعد يومين \(يوم 5\)/);
  await w.press(`bl|out|${rent}`, w.nextMid);
  const [row] = w.of('fin');
  assert.equal(row.props['النوع'].select.name, 'مصروف');
  assert.equal(row.props['الفئة'].select.name, 'كراء');
  assert.equal(w.pages[rent].props['آخر دفع'].date.start, '2026-10-03');
  // ديسمبر: سونلغاز مستحقة (سبتمبر + 3)
  w.now = Date.parse('2026-12-03T09:05:00Z');
  await w.cron();
  assert.ok(sent(w, 'يستحق').some(m => m.text.includes('سونلغاز')));
  void gaz;
  w.restore();
});

test('التحليل الشهري يوم 1: المصاريف والتغيّر، الميزانية، الادخار، وأبرز الفئات', async () => {
  const w = createWorld({ now: '2026-10-01T09:05:00Z' });
  budget(w, 'أكل وشرب', 'مصروف ثابت', 35000);
  fin(w, 'سوق', 'مصروف', 30000, '2026-09-10', 'تغذية');
  fin(w, 'بنزين', 'مصروف', 8000, '2026-09-12', 'نقل');
  fin(w, 'راتب', 'دخل', 100000, '2026-09-25', 'راتب');
  fin(w, 'سوق', 'مصروف', 20000, '2026-08-10', 'تغذية');
  fin(w, 'بنزين', 'مصروف', 8000, '2026-08-12', 'نقل');
  await w.cron();
  const [m] = sent(w, 'تحليل سبتمبر');
  assert.match(m.text, /المصاريف: <b>38,000 دج<\/b> \(\+36% عن أوت\)/);
  assert.match(m.text, /⚠️ الميزانية: 35,000 دج — تجاوزتها بـ 3,000 دج/);
  assert.match(m.text, /🟢 الادخار: 62,000 دج \(62% من الدخل\)/);
  assert.match(m.text, /📈 تغذية: 30,000 دج \(\+50%\)/);
  assert.doesNotMatch(m.text, /📈 نقل/);
  w.now += 60e3;
  await w.cron();
  assert.equal(sent(w, 'تحليل سبتمبر').length, 0, 'مرة واحدة');
  await w.text('/analysis');
  assert.equal(sent(w, 'تحليل سبتمبر').length, 1);
  w.restore();
});

test('«🔁 اجعلها دورية» بعد تسجيل مصروف ← بند بمدته، ويُذكَّر به بعد 3 أشهر، ويتجدد بدفع جديد بنفس الاسم', async () => {
  const w = createWorld({ now: '2026-10-05T10:00:00Z' });
  await w.text('مصروف 2500 اشتراك الإنترنت');
  await w.press('fx|c|2', w.nextMid); // فواتير
  const saved = w.flush().filter(m => m.method === 'editMessageText').at(-1);
  const mk = w.buttons(saved).find(b => b.text.startsWith('🔁'));
  assert.ok(mk, 'زر «اجعلها دورية» بعد تسجيل مصروف');
  await w.press(mk.callback_data, w.nextMid);
  const periods = w.flush().find(m => m.method === 'editMessageReplyMarkup');
  assert.deepEqual(w.buttons(periods).map(b => b.text), ['كل شهر', 'كل 3 أشهر', 'كل 6 أشهر', 'كل سنة', '✖️ لا']);
  await w.press(mk.callback_data.replace('|mk|', '|p3|'), w.nextMid);
  const [b] = w.of('budget');
  assert.equal(b.props['البند'].title[0].plain_text, 'اشتراك الإنترنت');
  assert.equal(b.props['المبلغ (دج)'].number, 2500);
  assert.equal(b.props['يوم الاستحقاق'].number, 5);
  assert.equal(b.props['الدورية'].select.name, 'كل 3 أشهر');
  assert.equal(b.props['آخر دفع'].date.start, '2026-10-05');
  assert.match(w.texts(w.flush()).at(-1), /اشتراك الإنترنت<\/b> — كل 3 أشهر · القادم 5\/1/);

  // نوفمبر وديسمبر: لا تذكير. جانفي 3: قبل الموعد بيومين
  for (const d of ['2026-11-03', '2026-12-03']) { w.now = Date.parse(`${d}T09:05:00Z`); await w.cron(); }
  assert.equal(sent(w, 'اشتراك الإنترنت').length, 0);
  w.now = Date.parse('2027-01-03T09:05:00Z');
  await w.cron();
  assert.match(sent(w, 'اشتراك الإنترنت')[0].text, /يستحق بعد يومين \(يوم 5\)/);

  // دفعه يدويًا بنفس الاسم ← «آخر دفع» يتحدّث ولا يتكرر التذكير
  await w.text('مصروف 2500 اشتراك الإنترنت');
  await w.press('fx|c|2', w.nextMid);
  assert.equal(w.pages[b.id].props['آخر دفع'].date.start, '2027-01-03');
  const after = w.flush().filter(m => m.method === 'editMessageText').at(-1);
  assert.match(after.text, /🔁 <b>اشتراك الإنترنت<\/b> — كل 3 أشهر · القادم 5\/4/);
  assert.ok(!w.buttons(after).some(x => x.text.startsWith('🔁')), 'لا زر «اجعلها دورية» لاشتراك معروف');
  w.now = Date.parse('2027-01-04T09:05:00Z');
  await w.cron();
  assert.equal(sent(w, 'اشتراك الإنترنت').length, 0);
  w.restore();
});

test('⚙️ ← 🧾 الفواتير والاشتراكات: القائمة بمواعيدها، والحذف بعد تأكيد يوقف التذكير', async () => {
  const w = createWorld({ now: '2026-10-10T10:00:00Z' });
  const net = budget(w, 'الإنترنت', 'مصروف ثابت', 2500, 5, { 'الدورية': P.select('شهري'), 'آخر دفع': P.date('2026-10-05') });
  budget(w, 'تأمين السيارة', 'مصروف ثابت', 18000, 20, { 'الدورية': P.select('سنوي'), 'آخر دفع': P.date('2026-03-20') });
  budget(w, 'مصروف مريم', 'مصروف ثابت', 20000);
  await w.text('⚙️');
  const mid = w.nextMid;
  await w.press('st|bills', mid);
  const v = w.flush().filter(m => m.method === 'editMessageText').at(-1);
  assert.match(v.text, /الإنترنت<\/b> — 2,500 دج · كل شهر · يوم 5\n\s+⏳ القادم: 5\/11/);
  assert.match(v.text, /تأمين السيارة<\/b> — 18,000 دج · كل سنة · يوم 20\n\s+⏳ القادم: 20\/3/);
  assert.doesNotMatch(v.text, /مصروف مريم/);
  await w.press(`bl|dq|${net}`, mid);
  assert.match(w.texts(w.flush()).at(-1), /حذف «الإنترنت»/);
  await w.press(`bl|dy|${net}`, mid);
  assert.equal(w.pages[net].trash, true);
  w.now = Date.parse('2026-11-03T09:05:00Z');
  await w.cron();
  assert.equal(sent(w, 'الإنترنت').length, 0);
  w.restore();
});
