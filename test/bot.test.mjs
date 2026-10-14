// اختبارات البوت: تُشغَّل بـ `npm test`، وتمنع النشر إن فشلت (راجع deploy.yml).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const ALG = h => `2026-09-25T${String(h - 1).padStart(2, '0')}`; // ساعة بتوقيت الجزائر ← UTC
const task = (w, title, start, extra = {}) => w.add('task', {
  'المهمة': P.title(title), 'الموعد': P.date(start), 'الحالة': P.select('للقيام بها'), ...extra,
});

test('تنبيه مهمة حلّ موعدها: رسالة واحدة بأزرار، ولا تتكرر', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  task(w, '2 متداول', '2026-09-25T10:00:00.000Z');
  await w.cron();
  const msgs = w.flush().filter(m => m.method === 'sendMessage' && !m.text.includes('🕌'));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /2 متداول/);
  assert.deepEqual(w.buttons(msgs[0]).map(b => b.text), ['✅ تم', '⏰ أجّلها', '❌ ألغها']);
  await w.cron();
  assert.equal(w.flush().filter(m => m.method === 'sendMessage' && m.text.includes('2 متداول')).length, 0);
  w.restore();
});

test('زر ✅ تم يحدّث Notion والرسالة', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  const id = task(w, '3 أخبار', '2026-09-25T10:00:00.000Z');
  await w.cron();
  const mid = w.flush().find(m => m.text?.includes('3 أخبار')).message_id ?? w.nextMid;
  await w.press(`done:${id}`, w.nextMid);
  assert.equal(w.pages[id].props['الحالة'].select.name, 'منجزة');
  assert.match(w.texts(w.flush()).join('\n'), /تمّت/);
  w.restore();
});

test('تعديل المهمة في Notion بعد التنبيه يحدّث رسالتها', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  const id = task(w, 'فيديو ريل', '2026-09-25T10:00:00.000Z');
  await w.cron(); w.flush();
  w.now += 60e3;
  w.edit(id, { 'الحالة': P.select('منجزة') });
  await w.cron();
  const edits = w.flush().filter(m => m.method === 'editMessageText');
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /تمّت/);
  w.restore();
});

test('الإضافة من تلغرام: موعد بتاريخ وساعة وتكرار', async () => {
  const w = createWorld();
  await w.text('➕ إضافة');
  await w.press('a|k|reminder', w.draftMid('draft'));
  await w.text('طبيب الأسنان');
  await w.press('a|d|2026-09-27', w.draftMid('draft'));
  await w.press('a|t|1000', w.draftMid('draft'));
  await w.press('a|r|0', w.draftMid('draft'));
  const [r] = w.of('reminder');
  assert.equal(r.props['التذكير'].title[0].plain_text, 'طبيب الأسنان');
  assert.equal(r.props['التاريخ'].date.start, '2026-09-27T10:00:00.000+01:00');
  assert.equal(r.props['الحالة'].select.name, 'قائم');
  w.restore();
});

test('التكرار التلقائي اليومي يُنشئ نسخة الغد ويطفئ العلامة على الحالية', async () => {
  const w = createWorld({ now: '2026-09-25T08:00:30Z' });
  const id = task(w, '2 فيديو', '2026-09-25T08:00:00.000Z', { 'التكرار': P.select('يومي'), 'تكرار تلقائي': P.check(true) });
  await w.cron();
  const tasks = w.of('task');
  assert.equal(tasks.length, 2);
  const next = tasks.find(t => t.id !== id);
  assert.equal(next.props['الموعد'].date.start, '2026-09-26T09:00:00.000+01:00');
  assert.equal(next.props['تكرار تلقائي'].checkbox, true);
  assert.equal(w.pages[id].props['تكرار تلقائي'].checkbox, false);
  w.restore();
});

test('التكرار الشهري يحافظ على اليوم الأصلي: 31 جانفي ← 28 فيفري ← 31 مارس', async () => {
  const w = createWorld({ now: '2027-01-31T08:00:30Z' });
  task(w, 'روبورتاج', '2027-01-31', { 'التكرار': P.select('شهري'), 'تكرار تلقائي': P.check(true) });
  await w.cron();
  const feb = w.of('task').find(t => t.props['الموعد'].date.start.startsWith('2027-02'));
  assert.equal(feb.props['الموعد'].date.start, '2027-02-28');
  w.now = Date.parse('2027-02-28T08:00:30Z');
  await w.cron();
  assert.ok(w.of('task').some(t => t.props['الموعد'].date.start === '2027-03-31'), 'يعود إلى 31 في مارس');
  w.restore();
});

test('الأذان مرة واحدة، وتعطّل Notion لا يكرره، وإشعار واحد فقط إن استمر العطل أكثر من 10 دقائق', async () => {
  const w = createWorld({ now: '2026-09-25T04:12:30Z' }); // 05:12 فجر الجزائر
  w.notionDown = true;
  for (let i = 0; i < 5; i++) { await w.cron(); w.now += 60e3; }
  let msgs = w.texts(w.flush());
  assert.equal(msgs.filter(t => t.includes('حان وقت صلاة الفجر')).length, 1);
  assert.equal(msgs.filter(t => t.includes('لا يستجيب')).length, 0, 'عطل قصير: لا إزعاج');
  for (let i = 0; i < 8; i++) { await w.cron(); w.now += 60e3; }
  msgs = w.texts(w.flush());
  assert.equal(msgs.filter(t => t.includes('Notion لا يستجيب منذ')).length, 1);
  w.restore();
});

test('مهلة Cloudflare 524 (صفحة نصية) ← رسالة مفهومة بلا إعادة محاولة، وعطل عابر يُنسى بعد عودة Notion', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  w.notionDown = 524;
  await w.cron();
  const last = JSON.parse(w.kv.last_err);
  assert.equal(last.msg, 'Notion 524: انتهت مهلة خادم Notion');
  w.notionDown = false;
  w.now += 60e3;
  await w.cron();
  assert.equal(w.kv.err_first, undefined, 'عاد Notion ← يُمحى بدء العطل');
  // عطل جديد قصير بعدها لا يُبلَّغ عنه
  w.notionDown = 524;
  for (let i = 0; i < 3; i++) { w.now += 60e3; await w.cron(); }
  assert.equal(w.texts(w.flush()).filter(t => t.includes('لا يستجيب')).length, 0);
  w.restore();
});

test('ازدحام عابر (502) في الاستعلام ← إعادة محاولة واحدة تنجح بلا عطل', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  w.add('task', { 'المهمة': P.title('تجربة'), 'الموعد': P.date('2026-09-25T11:00:00.000+01:00'), 'الحالة': P.select('للقيام بها') });
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('api.notion.com') && n++ === 0
    ? { ok: false, status: 502, text: async () => '<html>502</html>' } : realFetch(url, opts));
  await w.cron();
  assert.ok(w.texts(w.flush()).some(t => t.includes('تجربة')));
  assert.equal(w.kv.err_first, undefined);
  w.restore();
});

test('زر ✅ صلّيت يسجّل في متتبع الصلاة', async () => {
  const w = createWorld({ now: '2026-09-25T04:12:30Z' });
  await w.cron();
  await w.press('pr|fajr|2026-09-25', w.nextMid);
  const [row] = w.of('tracker');
  assert.equal(row.props['الفجر'].checkbox, true);
  assert.equal(row.props['التاريخ'].date.start, '2026-09-25');
  w.restore();
});

test('مراجعة المساء: تعرض المفتوح، و«➡️ غدًا» ينقل المهمة', async () => {
  const w = createWorld({ now: '2026-09-25T20:00:30Z' }); // 21:00
  const id = task(w, 'شارجور ديدين', '2026-09-25T13:00:00.000Z');
  w.kv.state = JSON.stringify({ sent: { [`${id}:2026-09-25T13:00:00.000Z`]: 1 } });
  await w.cron();
  const review = w.flush().find(m => m.text?.includes('مراجعة اليوم'));
  assert.ok(review);
  assert.match(review.text, /شارجور ديدين/);
  await w.press('rv|m|0', JSON.parse(w.kv.review).mid);
  assert.equal(w.pages[id].props['الموعد'].date.start, '2026-09-26T13:00:00.000Z');
  w.restore();
});

test('المصاريف: «مصروف 1500 بنزين» ← فئة نقل مقترحة ← قيد في المالية', async () => {
  const w = createWorld();
  await w.text('مصروف 1500 بنزين');
  const card = w.flush().find(m => m.text?.includes('1,500'));
  assert.equal(w.buttons(card)[0].text, '⭐ نقل');
  await w.press(w.buttons(card)[0].callback_data, w.draftMid('fdraft'));
  const [e] = w.of('fin');
  assert.equal(e.props['المبلغ (دج)'].number, 1500);
  assert.equal(e.props['الفئة'].select.name, 'نقل');
  assert.equal(e.props['النوع'].select.name, 'مصروف');
  w.restore();
});

test('نص يبدأ برقم صغير («3 أخبار») لا يُقترح مصروفًا', async () => {
  const w = createWorld();
  await w.text('3 أخبار');
  const card = w.flush().find(m => m.text?.includes('3 أخبار'));
  assert.ok(!w.buttons(card).some(b => b.text.includes('مصروف')));
  w.restore();
});

test('المناسبات: تذكير قبل أسبوع، ويُتدارك في اليوم التالي إن فات', async () => {
  const w = createWorld({ now: '2026-10-18T08:05:00Z' }); // فات يوم 17 (قبل أسبوع)
  w.add('events', { 'المناسبة': P.title('عيد ميلادي'), 'النوع': P.select('عيد ميلاد'), 'التاريخ': P.date('1995-10-24'), 'يحتاج هدية': P.check(false) });
  await w.cron();
  const msgs = w.texts(w.flush()).filter(t => t.includes('عيد ميلادي') && !t.includes('صباح الخير'));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /بعد 6 أيام/);
  assert.match(msgs[0], /يُتمّ 31 سنة/);
  w.now += 60e3; await w.cron();
  assert.equal(w.texts(w.flush()).filter(t => t.includes('عيد ميلادي') && !t.includes('صباح الخير')).length, 0);
  w.restore();
});

test('الموعد الطبي: تذكير مساء اليوم السابق وتنبيه قبله بساعتين، والدواء مستثنى', async () => {
  const w = createWorld({ now: '2026-09-26T19:01:00Z' }); // 20:01
  w.add('health', { 'العنوان': P.title('طبيب الأسنان'), 'التاريخ': P.date('2026-09-27T10:00:00.000+01:00'), 'النوع': P.select('موعد طبي'), 'الحالة': P.select('قادم'), 'الشخص': P.select('مريم') });
  w.add('health', { 'العنوان': P.title('دواء'), 'التاريخ': P.date('2026-09-27T08:00:00.000+01:00'), 'النوع': P.select('دواء'), 'الحالة': P.select('مستمر') });
  await w.cron();
  let msgs = w.texts(w.flush()).filter(t => !t.includes('🕌') && !t.includes('أذكار'));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /غدًا 10:00: طبيب الأسنان/);
  w.now = Date.parse('2026-09-27T07:00:30Z'); // 08:00 = قبل ساعتين
  await w.cron();
  msgs = w.flush().filter(m => m.method === 'sendMessage' && !m.text.includes('🕌') && !m.text.includes('أذكار'));
  assert.equal(msgs.length, 1);
  assert.deepEqual(w.buttons(msgs[0]).map(b => b.text), ['✅ تم', '⏰ أجّلها']);
  w.restore();
});

test('الرسالة الصوتية: بطاقة تأكيد ثم حفظ الموعد', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  w.gemini = () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    transcript: 'ذكّرني غدوة على 3 نعيّط للبنك', kind: 'reminder', title: 'الاتصال بالبنك', date: '2026-09-26', time: '15:00', repeat: 'مرة واحدة',
  }) }] } }] }) });
  await w.voice();
  const card = w.flush().find(m => m.text?.includes('فهمت'));
  assert.match(card.text, /الاتصال بالبنك/);
  assert.equal(w.of('reminder').length, 0, 'لا يُحفظ شيء قبل التأكيد');
  await w.press('vx|s', w.draftMid('vdraft'));
  const [r] = w.of('reminder');
  assert.equal(r.props['التاريخ'].date.start, '2026-09-26T15:00:00.000+01:00');
  w.restore();
});

test('الإعدادات: مفتاح مرفوض لا يُحفظ، والصحيح يُحفظ، ورسالته تُحذف', async () => {
  const w = createWorld();
  await w.text('⚙️');
  await w.press('st|g', w.nextMid);
  await w.text('wrong-key');
  assert.equal(w.kv.gemini_key, undefined);
  await w.text('good-key');
  assert.equal(w.kv.gemini_key, 'good-key');
  assert.equal(w.flush().filter(m => m.method === 'deleteMessage').length, 2);
  w.restore();
});

test('حد الطلبات الخارجية: 60 تنبيهًا في نفس الدقيقة تتوزّع على دقائق دون ضياع أي منها', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  for (let i = 0; i < 60; i++) task(w, `مهمة ${i}`, '2026-09-25T10:00:00.000Z');
  const seen = new Set();
  for (let run = 0; run < 5; run++) {
    const before = w.sent.length;
    await w.cron();
    const calls = w.sent.length - before;
    assert.ok(calls <= 50, `تشغيل ${run}: ${calls} نداء تلغرام`);
    for (const t of w.texts(w.flush())) { const m = t.match(/مهمة (\d+)/); if (m) seen.add(m[1]); }
    w.now += 60e3;
  }
  assert.equal(seen.size, 60);
  w.restore();
});

test('الأمان: سرّ webhook خاطئ ← 403، ومحادثة غريبة تُتجاهل', async () => {
  const w = createWorld();
  const r = await w.post({ message: { message_id: 1, chat: { id: 1 }, text: '/start' } }, 'wrong');
  assert.equal(r.status, 403);
  await w.text('/start', 999);
  assert.equal(w.flush().length, 0);
  w.restore();
});

test('💵 قبض ← 💼 فريلانس ← الاسم ثم المبلغ (أو معًا) ← دخل «عمل حر»', async () => {
  const w = createWorld();
  await w.text('💵 قبض');
  const card = w.flush().find(m => m.text?.includes('قبض مال'));
  assert.ok(w.buttons(card).some(b => b.text === '💼 فريلانس'));
  const mid = w.nextMid;
  await w.press('fx|fl|0', mid);
  assert.match(w.texts(w.flush()).join('\n'), /اسم الفريلانس/);
  await w.text('مونتاج إعلان لشركة النور');
  assert.match(w.texts(w.flush()).join('\n'), /كم المبلغ/);
  await w.text('15 ألف');
  let [row] = w.of('fin');
  assert.equal(row.props['البيان'].title[0].plain_text, 'فريلانس: مونتاج إعلان لشركة النور');
  assert.equal(row.props['المبلغ (دج)'].number, 15000);
  assert.equal(row.props['النوع'].select.name, 'دخل');
  assert.equal(row.props['الفئة'].select.name, 'عمل حر');

  await w.text('💵 قبض');
  await w.press('fx|fl|0', w.nextMid);
  await w.text('تصميم شعار 8000');
  row = w.of('fin').find(r => r.props['البيان'].title[0].plain_text === 'فريلانس: تصميم شعار');
  assert.equal(row.props['المبلغ (دج)'].number, 8000);
  w.restore();
});
