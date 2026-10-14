// اختبارات «📸 يوميات مريم»: ربط Drive، حفظ الصورة، الملاحظة، الاستيراد، وذكريات «في مثل هذا اليوم».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const EXEC = 'https://script.google.com/macros/s/AKfycbTEST_123/exec';

// ربط Drive من الإعدادات
async function link(w) {
  await w.text('⚙️');
  const mid = w.nextMid;
  await w.press('st|dr', mid);
  await w.text(EXEC);
  w.flush();
  return mid;
}

// صورة ← 👶 مريم ← رقم بطاقة الصورة
async function nourPhoto(w, caption) {
  await w.photo(caption);
  const card = w.nextMid;
  await w.press('ph|n', card);
  return card;
}

const rows = w => w.of('nour');

test('ربط Drive: رابط خاطئ يُرفض، والصحيح يُسجّل كلمة سرّ ويظهر في الإعدادات', async () => {
  const w = createWorld();
  await w.text('⚙️');
  const mid = w.nextMid;
  await w.press('st|dr', mid);
  assert.match(w.texts(w.flush()).join('\n'), /Web app/);
  await w.text('https://example.com/x');
  assert.match(w.texts(w.flush()).join('\n'), /ليس رابط Web app/);
  assert.equal(w.kv.drive, undefined);
  await w.text(EXEC);
  const drive = JSON.parse(w.kv.drive);
  assert.equal(drive.url, EXEC);
  assert.ok(drive.secret.length >= 32);
  assert.equal(w.drive.secret, drive.secret);
  assert.match(w.texts(w.flush()).join('\n'), /رُبط Google Drive[\s\S]*✅ مربوط/);
  w.restore();
});

test('كود مربوط بسرّ آخر ← رسالة resetSecret ولا يُحفظ الربط', async () => {
  const w = createWorld();
  w.drive.secret = 'x'.repeat(48);
  await w.text('⚙️');
  await w.press('st|dr', w.nextMid);
  await w.text(EXEC);
  assert.match(w.texts(w.flush()).join('\n'), /resetSecret/);
  assert.equal(w.kv.drive, undefined);
  w.restore();
});

test('صورة لمريم: تُرفع إلى Drive وتُسجّل بعمرها، ثم تُطلب ملاحظة تُحفظ في Notion', async () => {
  const w = createWorld({ now: '2026-09-25T13:30:00Z' }); // 14:30 بتوقيت الجزائر
  await link(w);
  await w.photo();
  const card = w.nextMid;
  const ask = w.flush().find(m => m.method === 'sendMessage');
  assert.match(ask.text, /ماذا أفعل بها/);
  assert.deepEqual(w.buttons(ask).map(b => b.text), ['👶 صورة لمريم', '🔍 استخراج بيانات', '✖️ تجاهل']);

  await w.press('ph|n', card);
  // الملف الكبير هو ما يُرفع، برابط تلغرام
  const up = w.drive.calls.find(c => c.action === 'upload');
  assert.match(up.fileUrl, /api\.telegram\.org\/file\/botbot\/photos\/file_7\.jpg$/);
  assert.equal(up.name, 'nour_2026-09-25_1430.jpg');
  const [row] = rows(w);
  assert.equal(row.props['العمر'].rich_text[0].plain_text, '9 أشهر و20 يومًا');
  assert.equal(row.props['التاريخ'].date.start, '2026-09-25T14:30:00.000+01:00');
  assert.equal(row.props['الصورة'].url, 'https://drive.google.com/file/d/d1/view');
  assert.equal(row.props['معرّف تلغرام'].rich_text[0].plain_text, 'big');
  const saved = w.texts(w.flush()).join('\n');
  assert.match(saved, /صورة محفوظة[\s\S]*9 أشهر و20 يومًا[\s\S]*اكتب ملاحظة/);

  await w.text('أول مرة تجلس وحدها');
  assert.equal(row.props['الملاحظة'].rich_text[0].plain_text, 'أول مرة تجلس وحدها');
  assert.equal(row.props['الوصف'].title[0].plain_text, 'أول مرة تجلس وحدها');
  assert.match(w.texts(w.flush()).join('\n'), /📝 أول مرة تجلس وحدها/);

  // نص لاحق لا يُحسب ملاحظة، بل يعود للإضافة العادية
  await w.text('اشتري حليب');
  assert.equal(row.props['الملاحظة'].rich_text[0].plain_text, 'أول مرة تجلس وحدها');
  assert.match(w.texts(w.flush()).join('\n'), /إضافة «اشتري حليب»/);

  // الرد على بطاقة الصورة يغيّر ملاحظتها في أي وقت
  await w.reply('أول مرة تجلس وحدها في بيت جدتها', card);
  assert.equal(row.props['الملاحظة'].rich_text[0].plain_text, 'أول مرة تجلس وحدها في بيت جدتها');
  w.restore();
});

test('التعليق المكتوب مع الصورة يصبح ملاحظتها، وتاريخ EXIF يُعتمد، و⭐ يعلّمها مفضّلة', async () => {
  const w = createWorld({ now: '2026-09-25T13:30:00Z' });
  await link(w);
  w.drive.taken = '2026-03-10T15:04:00';
  const card = await nourPhoto(w, 'في الحديقة');
  const [row] = rows(w);
  assert.equal(row.props['الملاحظة'].rich_text[0].plain_text, 'في الحديقة');
  assert.equal(row.props['التاريخ'].date.start, '2026-03-10T15:04:00.000+01:00');
  assert.equal(row.props['العمر'].rich_text[0].plain_text, '3 أشهر و5 أيام');
  assert.doesNotMatch(w.texts(w.flush()).join('\n'), /اكتب ملاحظة/);
  assert.equal(w.kv.pnote, undefined);
  await w.press('ph|f', card);
  assert.equal(row.props['مفضّلة'].checkbox, true);
  w.restore();
});

test('بلا ربط Drive: 👶 مريم يطلب الربط أولًا ولا يُسجّل شيئًا', async () => {
  const w = createWorld();
  await w.photo();
  await w.press('ph|n', w.nextMid);
  assert.match(w.texts(w.flush()).join('\n'), /اربط Google Drive/);
  assert.equal(rows(w).length, 0);
  w.restore();
});

test('✖️ تجاهل يحذف البطاقة ولا يُرفع شيء', async () => {
  const w = createWorld();
  await link(w);
  await w.photo();
  await w.press('ph|x', w.nextMid);
  assert.ok(w.flush().some(m => m.method === 'deleteMessage'));
  assert.equal(w.drive.calls.filter(c => c.action === 'upload').length, 0);
  w.restore();
});

test('استيراد صور المجلد: دفعات من 15 بتاريخ التقاطها، ولا يتكرر المستورد', async () => {
  const w = createWorld();
  await link(w);
  for (let i = 1; i <= 20; i++) {
    w.drive.files.push({ id: `old${i}`, name: `IMG_${i}.jpg`, url: `https://drive.google.com/file/d/old${i}/view`, taken: i === 1 ? '2025-12-05T09:10:00' : `2026-02-${String(i).padStart(2, '0')}`, created: '2026-09-01T10:00:00.000Z', marked: false });
  }
  await w.text('⚙️');
  const mid = w.nextMid;
  await w.press('st|imp', mid);
  assert.equal(rows(w).length, 15);
  let out = w.texts(w.flush()).join('\n');
  assert.match(out, /سُجّلت 15 صورة/);
  await w.press('st|imp', mid);
  assert.equal(rows(w).length, 20);
  out = w.texts(w.flush()).join('\n');
  assert.match(out, /انتهى الاستيراد/);
  await w.press('st|imp', mid);
  assert.equal(rows(w).length, 20);
  const first = rows(w).find(r => r.props['معرّف Drive'].rich_text[0].plain_text === 'old1');
  assert.equal(first.props['العمر'].rich_text[0].plain_text, 'يوم ولادتها');
  assert.equal(first.props['المصدر'].select.name, 'Drive');
  w.restore();
});

test('في مثل هذا اليوم: صورة العام الماضي تصل صباحًا مرة واحدة', async () => {
  const w = createWorld({ now: '2027-09-25T07:00:00Z' }); // 08:00 بالجزائر — قبل موعد التذكير
  w.add('nour', {
    'الوصف': P.title('أول ضحكة'), 'التاريخ': P.date('2026-09-25T14:30:00.000+01:00'), 'الملاحظة': P.text('أول ضحكة'),
    'العمر': P.text('9 أشهر و20 يومًا'), 'الصورة': P.url('https://drive.google.com/file/d/d1/view'), 'معرّف تلغرام': P.text('big'),
  });
  await w.cron();
  assert.equal(w.flush().filter(m => m.method === 'sendPhoto').length, 0);
  w.now = Date.parse('2027-09-25T08:05:00Z');
  await w.cron();
  const sent = w.flush().filter(m => m.method === 'sendPhoto');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].photo, 'big');
  assert.match(sent[0].caption, /قبل سنة[\s\S]*9 أشهر و20 يومًا[\s\S]*أول ضحكة/);
  w.now += 60e3;
  await w.cron();
  assert.equal(w.flush().filter(m => m.method === 'sendPhoto').length, 0);
  w.restore();
});
