// اختبارات «📿 الأذكار والورد ووضع رمضان».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './harness.mjs';

const tracker = (w, date) => w.of('tracker').find(r => r.props['التاريخ'].date.start === date);
const sentWith = (w, s) => w.flush().filter(m => m.method === 'sendMessage' && m.text.includes(s));

test('أذكار الصباح بعد الفجر مرة واحدة، و«✅ قرأتها» تسجّل وتبني سلسلة 🔥', async () => {
  const w = createWorld({ now: '2026-10-02T04:00:00Z' }); // الجمعة 05:00 — قبل الفجر
  await w.cron();
  assert.equal(sentWith(w, 'أذكار الصباح').length, 0);
  w.now = Date.parse('2026-10-02T06:10:00Z'); // 07:10 — بعد الفجر بأكثر من 40 دقيقة
  await w.cron();
  const [m] = sentWith(w, 'أذكار الصباح');
  assert.ok(m);
  assert.match(m.text, /<blockquote expandable>[\s\S]*سُبْحَانَ اللَّهِ وَبِحَمْدِهِ[\s\S]*×100/);
  assert.match(m.text, /اللَّهُمَّ بِكَ أَصْبَحْنَا/);
  assert.doesNotMatch(m.text, /الكهف/);
  await w.cron();
  assert.equal(sentWith(w, 'أذكار الصباح').length, 0, 'مرة واحدة');
  await w.press('sp|am|2026-10-02', w.nextMid);
  assert.equal(tracker(w, '2026-10-02').props['أذكار الصباح'].checkbox, true);
  await w.press('sp|am|2026-10-03', 1);
  assert.match(w.texts(w.flush()).at(-1), /🔥 2 أيام متتالية/);
  w.restore();
});

test('أذكار المساء بعد العصر بلا سورة الكهف، والإيقاف من /wird يمنعها', async () => {
  const w = createWorld({ now: '2026-10-03T15:45:00Z' }); // السبت 16:45
  await w.cron();
  const [m] = sentWith(w, 'أذكار المساء');
  assert.match(m.text, /أَعُوذُ بِكَلِمَاتِ اللَّهِ التَّامَّاتِ/);
  assert.doesNotMatch(m.text, /الكهف/);
  await w.text('/wird');
  await w.press('wd|adk|0', w.nextMid);
  w.now = Date.parse('2026-10-04T15:45:00Z');
  await w.cron();
  assert.equal(sentWith(w, 'أذكار المساء').length, 0);
  w.restore();
});

test('الورد: الإعداد، التذكير 20:30 برابط المصحف، «✅ قرأته» يتقدّم ويسجّل، والختمة تبدأ من جديد', async () => {
  const w = createWorld({ now: '2026-10-03T10:00:00Z' });
  await w.text('/wird');
  const mid = w.nextMid;
  assert.match(w.texts(w.flush()).join('\n'), /الورد: غير مفعّل/);
  await w.press('wd|p|4', mid);
  await w.press('wd|pg|0', mid);
  await w.text('100');
  assert.match(w.texts(w.flush()).at(-1), /الصفحة 100 · الجزء 5/);

  w.now = Date.parse('2026-10-03T19:31:00Z'); // 20:31
  await w.cron();
  const [m] = sentWith(w, 'وردك اليوم');
  assert.match(m.text, /الصفحات 100–103 · الجزء 5/);
  assert.equal(w.buttons(m)[0].url, 'https://quran.com/page/100');
  await w.press('sp|wd|2026-10-03', w.nextMid);
  assert.equal(JSON.parse(w.kv.wird).page, 104);
  assert.equal(tracker(w, '2026-10-03').props['الورد (صفحات)'].number, 4);

  // آخر الصفحات ← ختمة
  w.kv.wird = JSON.stringify({ page: 603, per: 4, khatmas: 0 });
  await w.press('sp|wd|2026-10-04', 1);
  assert.match(w.texts(w.flush()).at(-1), /ختمت القرآن الكريم/);
  assert.deepEqual(JSON.parse(w.kv.wird), { page: 1, per: 4, khatmas: 1 });
  w.restore();
});

test('رمضان (تقدير أم القرى): السحور قبل الفجر، الإفطار عند المغرب بدعائه وزرّي الصيام، والتراويح', async () => {
  const w = createWorld({ now: '2027-02-10T04:45:00Z' }); // 3 رمضان 1448 تقديرًا — 05:45
  await w.cron();
  const [s] = sentWith(w, 'السحور');
  assert.match(s.text, /3 رمضان[\s\S]*الإمساك \d\d:\d\d · 🕌 الفجر \d\d:\d\d/);

  w.now = Date.parse('2027-02-10T17:35:00Z'); // بعد المغرب بقليل
  await w.cron();
  const [f] = sentWith(w, 'الإفطار');
  assert.match(f.text, /حان وقت الإفطار — 3 رمضان[\s\S]*ذَهَبَ الظَّمَأُ/);
  assert.deepEqual(w.buttons(f).map(b => b.text), ['✅ صلّيت', '🌙 صمت اليوم', '🤒 مفطر بعذر']);
  const fmid = w.nextMid;
  await w.press('rm|f|2027-02-10', fmid);
  assert.equal(tracker(w, '2027-02-10').props['الصيام'].select.name, 'صائم');

  w.now = Date.parse('2027-02-10T19:50:00Z'); // بعد العشاء بـ 45 دقيقة تقريبًا
  await w.cron();
  const [t] = sentWith(w, 'التراويح');
  assert.ok(t);
  await w.press('sp|tar|2027-02-10', w.nextMid);
  assert.equal(tracker(w, '2027-02-10').props['التراويح'].checkbox, true);
  w.restore();
});

test('سؤال الرؤية مساء 29 شعبان: «لا» يؤجّل رمضان يومًا، ثم يوم العيد حصيلة الصيام والقضاء', async () => {
  const w = createWorld({ now: '2027-02-06T17:50:00Z' }); // 29 شعبان 1448 تقديرًا، بعد المغرب
  await w.cron();
  const [q] = sentWith(w, 'هلال رمضان');
  assert.deepEqual(w.buttons(q).map(b => b.text), ['نعم، الصيام غدًا', 'لا، نُتمّ شعبان']);
  await w.press('rm|s0|2027-02-06', w.nextMid);
  assert.equal(JSON.parse(w.kv.ramadan).start, '2027-02-08');

  // 7 فيفري: شعبان 30 ← لا سحور
  w.now = Date.parse('2027-02-07T04:45:00Z');
  await w.cron();
  assert.equal(sentWith(w, 'السحور').length, 0);
  // 8 فيفري = 1 رمضان
  w.now = Date.parse('2027-02-08T04:45:00Z');
  await w.cron();
  assert.match(sentWith(w, 'السحور')[0].text, /1 رمضان/);

  // سجلّ: 27 يومًا صيام، يومان بعذر
  for (let i = 0; i < 29; i++) {
    const d = new Date(Date.parse('2027-02-08T12:00:00Z') + i * 864e5).toISOString().slice(0, 10);
    await w.press(`rm|${i < 27 ? 'f' : 'x'}|${d}`, 1);
  }
  // مساء 29 رمضان: هل ثبت هلال شوال؟ نعم ← العيد غدًا
  w.now = Date.parse('2027-03-08T18:30:00Z');
  w.flush();
  await w.cron();
  const [e] = sentWith(w, 'هلال شوّال');
  assert.ok(e);
  await w.press('rm|e1|2027-03-08', w.nextMid);
  assert.equal(JSON.parse(w.kv.ramadan).end, '2027-03-08');
  // يوم العيد
  w.now = Date.parse('2027-03-09T06:45:00Z');
  await w.cron();
  const [eid] = sentWith(w, 'عيد مبارك');
  assert.match(eid.text, /صمت 27 يومًا · 🤒 عليك قضاء 2 أيام/);
  assert.equal(sentWith(w, 'السحور').length, 0);
  w.restore();
});

test('الجمعة: سورة الكهف بعد صلاة الجمعة بساعة، مرة واحدة، و«✅ قرأتها»', async () => {
  const w = createWorld({ now: '2026-10-02T12:10:00Z' }); // الجمعة 13:10 — الجمعة ≈12:38، لم تمضِ ساعة
  await w.cron();
  assert.equal(sentWith(w, 'سورة الكهف').length, 0);
  w.now = Date.parse('2026-10-02T13:00:00Z'); // 14:00
  await w.cron();
  const [m] = sentWith(w, 'سورة الكهف');
  assert.ok(m);
  assert.equal(m.reply_markup.inline_keyboard[0][0].url, 'https://quran.com/18');
  await w.cron();
  assert.equal(sentWith(w, 'سورة الكهف').length, 0, 'مرة واحدة');
  await w.press('sp|kf|2026-10-02', w.nextMid);
  assert.match(w.texts(w.flush()).at(-1), /قرأت سورة الكهف/);
  // السبت: لا شيء
  w.now = Date.parse('2026-10-03T13:00:00Z');
  await w.cron();
  assert.equal(sentWith(w, 'سورة الكهف').length, 0);
  w.restore();
});

test('«😔 نسيتها» في الأذكار: تُغلق الرسالة بلطف ولا تُسجَّل في المتتبع', async () => {
  const w = createWorld({ now: '2026-10-03T06:10:00Z' }); // السبت 07:10
  await w.cron();
  const [m] = sentWith(w, 'أذكار الصباح');
  assert.deepEqual(w.buttons(m).map(b => b.text), ['✅ قرأتها', '😔 نسيتها']);
  await w.press('sp|amf|2026-10-03', w.nextMid);
  assert.match(w.texts(w.flush()).at(-1), /فاتتك أذكار الصباح اليوم[\s\S]*أذكار المساء بعد العصر/);
  assert.ok(!tracker(w, '2026-10-03')?.props['أذكار الصباح']?.checkbox);
  w.restore();
});
