// اختبارات «🔍 صورة ← بيانات» وتذكيرات الدواء.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const reply = obj => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });

// صورة ← 🔍 ← بطاقة التأكيد (يُرجع رقم البطاقة)
async function extract(w, doc, extra) {
  const calls = [];
  w.gemini = body => { calls.push(body); return reply(doc); };
  await w.photo(null, extra);
  const card = w.nextMid;
  await w.press('ph|d', card);
  return { card, calls, out: w.texts(w.flush()).join('\n') };
}

test('وصل شراء ← بطاقة تأكيد ← مصروف في المالية بتاريخ الوصل وفئته', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z', geminiKey: 'good-key' });
  const { card, calls, out } = await extract(w, { kind: 'expense', summary: 'تذكرة Uno', title: 'مشتريات Uno', amount: 2350.5, category: 'تغذية', date: '2026-09-24' });
  assert.equal(calls[0].contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.match(out, /وصل شراء[\s\S]*مشتريات Uno[\s\S]*تغذية/);
  assert.equal(w.of('fin').length, 0, 'لا حفظ قبل التأكيد');
  await w.press('ph|ok', card);
  const [row] = w.of('fin');
  assert.equal(row.props['المبلغ (دج)'].number, 2350.5);
  assert.equal(row.props['الفئة'].select.name, 'تغذية');
  assert.equal(row.props['الحساب'].select.name, 'منزلي');
  assert.equal(row.props['التاريخ'].date.start, '2026-09-24');
  await w.press('ph|ok', card);
  assert.equal(w.of('fin').length, 1, 'الضغط مرتين لا يكرّر');
  w.restore();
});

test('فاتورة سونلغاز ← تذكير قبل آخر أجل بيومين الساعة 10:00', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z', geminiKey: 'good-key' });
  const { card, out } = await extract(w, { kind: 'bill', summary: 'فاتورة كهرباء', title: 'فاتورة سونلغاز', amount: 4520, due_date: '2026-10-10' });
  assert.match(out, /فاتورة للدفع[\s\S]*آخر أجل/);
  await w.press('ph|rb', card);
  const [r] = w.of('reminder');
  assert.match(r.props['التذكير'].title[0].plain_text, /دفع فاتورة سونلغاز/);
  assert.equal(r.props['التاريخ'].date.start, '2026-10-08T10:00:00.000+01:00');
  w.restore();
});

test('بطاقة موعد طبي ← اختيار الشخص ← موعد في الملف الصحي بمكانه ونوعه', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z', geminiKey: 'good-key' });
  const { card, out } = await extract(w, { kind: 'appointment', summary: 'موعد تحاليل', title: 'تحاليل الدم', date: '2026-10-02', time: '8:30', medical: true, appt_type: 'تحاليل/أشعة', place: 'مخبر الأمل' });
  assert.match(out, /لمن؟/);
  await w.press('ph|p:الزوجة', card);
  assert.match(w.texts(w.flush()).join('\n'), /👤 الزوجة/);
  await w.press('ph|ok', card);
  const [h] = w.of('health');
  assert.equal(h.props['النوع'].select.name, 'تحاليل/أشعة');
  assert.equal(h.props['الشخص'].select.name, 'الزوجة');
  assert.equal(h.props['الطبيب/المكان'].rich_text[0].plain_text, 'مخبر الأمل');
  assert.equal(h.props['التاريخ'].date.start, '2026-10-02T08:30:00.000+01:00');
  w.restore();
});

test('وصفة طبية ← صفّ دواء لكل دواء بمدته وأوقاته، ثم تذكير في كل وقت وينتهي بانتهاء المدة', async () => {
  const w = createWorld({ now: '2026-09-25T06:00:00Z', geminiKey: 'good-key' });
  const { card, out } = await extract(w, { kind: 'prescription', summary: 'وصفة', title: 'وصفة طبية', person: 'مريم', place: 'د. بن علي',
    medicines: [{ name: 'Doliprane 150', dose: '5 مل', per_day: 3, days: 3, instructions: 'بعد الأكل' }, { name: 'Vitamine D', dose: '2 قطرات', per_day: 1, days: null }] });
  assert.match(out, /Doliprane 150[\s\S]*08:00 و14:00 و20:00[\s\S]*3 أيام/);
  await w.press('ph|ok', card);
  const meds = w.of('health');
  assert.equal(meds.length, 2);
  const d = meds.find(m => m.props['العنوان'].title[0].plain_text === 'Doliprane 150');
  assert.equal(d.props['النوع'].select.name, 'دواء');
  assert.equal(d.props['الحالة'].select.name, 'مستمر');
  assert.deepEqual(d.props['التاريخ'].date, { start: '2026-09-25', end: '2026-09-27' });
  assert.equal(d.props['الأوقات'].rich_text[0].plain_text, '08:00، 14:00، 20:00');
  assert.equal(d.props['الشخص'].select.name, 'مريم');
  w.flush();

  // 08:00 بالجزائر = 07:00Z
  w.now = Date.parse('2026-09-25T07:00:30Z');
  await w.cron();
  const doses = w.flush().filter(m => m.method === 'sendMessage' && m.text.includes('وقت الدواء'));
  assert.deepEqual(doses.map(m => m.text.split('\n')[0]).sort(), ['💊 <b>وقت الدواء: Doliprane 150</b>']);
  await w.cron();
  assert.equal(w.flush().filter(m => m.text?.includes('وقت الدواء')).length, 0, 'لا يتكرر');
  w.now = Date.parse('2026-09-25T08:00:30Z'); // 09:00: فيتامين د
  await w.cron();
  assert.match(w.texts(w.flush()).join('\n'), /Vitamine D/);
  await w.press('md|ok', w.nextMid);

  // بعد انتهاء المدة: تُغلق تلقائيًا
  w.now = Date.parse('2026-09-28T07:00:30Z');
  await w.cron();
  assert.equal(d.props['الحالة'].select.name, 'تم');
  assert.equal(w.flush().filter(m => m.text?.includes('Doliprane')).length, 0);
  w.restore();
});

test('ملف PDF ← استخراج فقط (بلا زر مريم)، ووثيقة غير معروفة لا تُحفظ', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  await w.post({ message: { message_id: 99, date: Math.floor(w.now / 1000), chat: { id: 1 }, document: { file_id: 'pdf1', file_name: 'facture.pdf', mime_type: 'application/pdf', file_size: 50000 } } });
  const ask = w.flush().find(m => m.method === 'sendMessage');
  assert.deepEqual(w.buttons(ask).map(b => b.text), ['🔍 استخراج بيانات', '✖️ تجاهل']);
  const calls = [];
  w.gemini = body => { calls.push(body); return reply({ kind: 'other', summary: 'صورة منظر طبيعي', title: 'منظر' }); };
  await w.press('ph|d', w.nextMid);
  assert.equal(calls[0].contents[0].parts[1].inline_data.mime_type, 'application/pdf');
  assert.match(w.texts(w.flush()).join('\n'), /منظر طبيعي/);
  w.restore();
});

test('بلا مفتاح Gemini ← يُطلب المفتاح', async () => {
  const w = createWorld();
  await w.photo();
  await w.press('ph|d', w.nextMid);
  assert.match(w.texts(w.flush()).join('\n'), /تحتاج مفتاح Gemini/);
  w.restore();
});

test('صورة الوثيقة لا تُرفع إلى أي مكان حتى مع ربط Drive: البيانات فقط في Notion', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  await w.text('⚙️');
  await w.press('st|dr', w.nextMid);
  await w.text('https://script.google.com/macros/s/AKfycbTEST_123/exec');
  w.flush();
  const { card } = await extract(w, { kind: 'expense', summary: 'تذكرة', title: 'صيدلية النور', amount: 870, category: 'صحة' });
  await w.press('ph|ok', card);
  assert.equal(w.of('fin').length, 1);
  assert.equal(w.drive.calls.filter(c => c.action === 'upload').length, 0);
  assert.equal(w.flush().filter(m => /Drive/.test(m.text || '') && m.reply_markup?.inline_keyboard?.length).length, 0);
  w.restore();
});
