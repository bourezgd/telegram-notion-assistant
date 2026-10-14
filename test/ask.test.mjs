// اختبارات «💬 اسأل مساعدك»: متى يُعدّ النص سؤالًا، وما يصل إلى Gemini من بيانات، وشكل الجواب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const reply = text => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

// Gemini مزيّف يحفظ الطلبات ويرد بنص ثابت
function withGemini(w, text = '**غدًا** عندك:\n* موعد البنك 15:00') {
  const calls = [];
  w.gemini = body => { calls.push(body); return reply(text); };
  return calls;
}

test('سؤال ينتهي بـ ؟ ← جواب من Gemini بالبيانات، بتنسيق تلغرام', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z', geminiKey: 'good-key' });
  const calls = withGemini(w);
  w.add('reminder', { 'التذكير': P.title('الاتصال بالبنك'), 'التاريخ': P.date('2026-09-26T15:00:00.000+01:00'), 'الحالة': P.select('قادم') });
  w.add('fin', { 'البيان': P.title('بنزين'), 'المبلغ (دج)': P.num(1500), 'النوع': P.select('مصروف'), 'الفئة': P.select('نقل'), 'التاريخ': P.date('2026-09-20') });
  w.add('events', { 'المناسبة': P.title('عيد ميلاد مريم'), 'التاريخ': P.date('2025-12-05'), 'النوع': P.select('عيد ميلاد') });
  await w.text('ماذا عندي غدًا؟');
  assert.equal(calls.length, 1);
  const system = calls[0].systemInstruction.parts[0].text;
  assert.match(system, /2026-09-25/);
  assert.match(system, /2026-09-26 15:00 \| الاتصال بالبنك/);
  assert.doesNotMatch(system, /1500/, 'المالية مستثناة افتراضيًا');
  assert.match(system, /## المالية والميزانية\n\(مستثناة للخصوصية\)/);
  assert.match(system, /عيد ميلاد مريم/);
  assert.equal(calls[0].contents.at(-1).parts[0].text, 'ماذا عندي غدًا؟');
  const out = w.texts(w.flush()).join('\n');
  assert.match(out, /<b>غدًا<\/b> عندك:\n• موعد البنك 15:00/);
  assert.equal(w.of('task').length + w.of('reminder').length, 1, 'السؤال لا يُضاف مهمةً');
  w.restore();
});

test('المتابعة: السؤال التالي يحمل السؤال والجواب السابقين', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  const calls = withGemini(w, 'جواب');
  await w.text('كم صرفت هذا الشهر؟');
  await w.text('وعلى التغذية؟');
  const c = calls[1].contents;
  assert.equal(c.length, 3);
  assert.equal(c[0].parts[0].text, 'كم صرفت هذا الشهر؟');
  assert.equal(c[1].role, 'model');
  w.restore();
});

test('نص عادي ليس سؤالًا ← اقتراح إضافة، وزر «💬 سؤال» يحوّله سؤالًا', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  const calls = withGemini(w, 'لا شيء غدًا');
  await w.text('ما تنساش تشري الخبز');
  assert.equal(calls.length, 0);
  const card = w.flush().find(m => m.text?.includes('إضافة'));
  assert.ok(w.buttons(card).some(b => b.callback_data === 'q|a'));
  await w.press('q|a', w.draftMid('draft'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contents.at(-1).parts[0].text, 'ما تنساش تشري الخبز');
  w.restore();
});

test('/ask والأسئلة بالدارجة، وبلا مفتاح يُطلب المفتاح', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  const calls = withGemini(w, 'جواب');
  await w.text('/ask لخص أسبوعي');
  await w.text('شحال صرفت على البنزين');
  assert.deepEqual(calls.map(c => c.contents.at(-1).parts[0].text), ['لخص أسبوعي', 'شحال صرفت على البنزين']);
  w.restore();

  const w2 = createWorld();
  await w2.text('كم صرفت هذا الشهر؟');
  assert.match(w2.texts(w2.flush()).join('\n'), /يحتاج مفتاح Gemini/);
  w2.restore();
});

test('سؤال صوتي ← يُجاب مباشرة بلا بطاقة حفظ', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  let n = 0;
  w.gemini = () => (n++ === 0
    ? reply(JSON.stringify({ transcript: 'واش عندي غدوة', kind: 'question', title: 'واش عندي غدوة' }))
    : reply('عندك موعد البنك'));
  await w.voice();
  const out = w.texts(w.flush()).join('\n');
  assert.match(out, /«واش عندي غدوة»[\s\S]*عندك موعد البنك/);
  assert.equal(w.kv.vdraft, undefined);
  w.restore();
});

test('Gemini مزدحم (503) ← ينتقل لنموذج آخر، وخطأ المفتاح يظهر للمستخدم', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  w.kv.gemini_models = JSON.stringify(['gemini-a', 'gemini-b']);
  const seen = [];
  w.gemini = body => { seen.push(1); return seen.length === 1 ? { ok: false, status: 503, json: async () => ({ error: { message: 'overloaded' } }) } : reply('تمام'); };
  await w.text('هل عندي مواعيد طبية؟');
  assert.equal(seen.length, 2);
  assert.match(w.texts(w.flush()).join('\n'), /تمام/);
  w.gemini = () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key expired' } }) });
  await w.text('هل عندي مواعيد طبية؟');
  assert.match(w.texts(w.flush()).join('\n'), /تعذّر الجواب[\s\S]*API key expired/);
  w.restore();
});

test('زر «💬 اسأل» في اللوحة: الرسالة التالية سؤال ولو بلا علامة استفهام', async () => {
  const w = createWorld({ geminiKey: 'good-key' });
  const calls = withGemini(w, 'جواب');
  await w.text('/start');
  const kb = w.flush().find(m => m.reply_markup?.keyboard).reply_markup.keyboard;
  assert.deepEqual(kb[0].slice(-2).map(b => b.text), ['💬 اسأل', '⚙️']);
  await w.text('💬 اسأل');
  assert.match(w.texts(w.flush()).join('\n'), /اسألني/);
  await w.text('مواعيد الأسبوع القادم');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contents.at(-1).parts[0].text, 'مواعيد الأسبوع القادم');
  // بعدها يعود النص العادي إلى الإضافة
  await w.text('اشتري حليب');
  assert.equal(calls.length, 1);
  w.restore();
});

test('خصوصية «اسأل»: الطبي والمالية مستثنيان افتراضيًا، ويُفعَّلان من ⚙️', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z', geminiKey: 'good-key' });
  const calls = withGemini(w, 'جواب');
  w.add('fin', { 'البيان': P.title('بنزين'), 'المبلغ (دج)': P.num(1500), 'النوع': P.select('مصروف'), 'الفئة': P.select('نقل'), 'التاريخ': P.date('2026-09-20') });
  w.add('health', { 'العنوان': P.title('طبيب الأسنان'), 'التاريخ': P.date('2026-09-28T10:00:00.000+01:00'), 'النوع': P.select('موعد طبي'), 'الحالة': P.select('قادم') });
  await w.text('كم صرفت؟');
  let sys = calls.at(-1).systemInstruction.parts[0].text;
  assert.doesNotMatch(sys, /طبيب الأسنان|1500/);
  await w.text('⚙️');
  const mid = w.nextMid;
  assert.match(w.texts(w.flush()).join('\n'), /🩺 الطبي 🔒 مستثنى · 💰 المالية 🔒 مستثنى/);
  await w.press('st|pm', mid);
  await w.press('st|ph', mid);
  assert.match(w.texts(w.flush()).at(-1), /🩺 الطبي ✅ يُرسل · 💰 المالية ✅ يُرسل/);
  await w.text('كم صرفت؟');
  sys = calls.at(-1).systemInstruction.parts[0].text;
  assert.match(sys, /2026-09-20 \| مصروف \| 1500 \| نقل/);
  assert.match(sys, /طبيب الأسنان/);
  w.restore();
});
