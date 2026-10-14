// اختبارات العادات ونمو مريم ورزنامة التلقيح.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';

const habit = (w, name, time, extra = {}) => w.add('habits', { 'العادة': P.title(name), 'الوقت': P.text(time), 'نشطة': P.check(true), ...extra });
const sent = (w, s) => w.flush().filter(m => (m.method === 'sendMessage' || m.method === 'sendPhoto') && (m.text || m.caption || '').includes(s));

test('العادة: تذكير في وقتها مرة واحدة، «✅ فعلتها» تبني السلسلة يومًا بعد يوم، وتنقطع إن فات يوم', async () => {
  const w = createWorld({ now: '2026-10-05T06:00:30Z' }); // 07:00
  const id = habit(w, 'رياضة', '07:00');
  await w.cron();
  const [m] = sent(w, 'رياضة');
  assert.match(m.text, /يومك الأول/);
  await w.cron();
  assert.equal(sent(w, 'رياضة').length, 0);
  await w.press(`hb|d|${id}|2026-10-05`, w.nextMid);
  assert.equal(w.pages[id].props['السلسلة'].number, 1);
  // اليوم التالي
  w.now = Date.parse('2026-10-06T06:00:30Z');
  await w.cron();
  assert.match(sent(w, 'رياضة')[0].text, /السلسلة: يوم — لا تقطعها/);
  await w.press(`hb|d|${id}|2026-10-06`, w.nextMid);
  assert.equal(w.pages[id].props['السلسلة'].number, 2);
  assert.match(w.texts(w.flush()).at(-1), /🔥 السلسلة: يومان — أطول سلسلة لك/);
  // فات يوم 7 ← يوم 8 تبدأ من جديد
  w.now = Date.parse('2026-10-08T06:00:30Z');
  await w.cron();
  assert.match(sent(w, 'رياضة')[0].text, /ابدأ سلسلة جديدة \(أطولها يومان\)/);
  await w.press(`hb|d|${id}|2026-10-08`, w.nextMid);
  assert.equal(w.pages[id].props['السلسلة'].number, 1);
  assert.equal(w.pages[id].props['أطول سلسلة'].number, 2);
  assert.equal(w.pages[id].props['مجموع الأيام'].number, 3);
  w.restore();
});

test('عادة أيام محددة (الجمعة): السلسلة تستمر من جمعة إلى جمعة، ولا تذكير في غيرها', async () => {
  const w = createWorld({ now: '2026-10-02T08:00:30Z' }); // الجمعة 09:00
  const id = habit(w, 'الجري', '09:00', { 'الأيام': { type: 'multi_select', multi_select: [{ name: 'الجمعة' }] } });
  await w.cron();
  await w.press(`hb|d|${id}|2026-10-02`, w.nextMid);
  w.now = Date.parse('2026-10-03T08:00:30Z'); // السبت
  w.flush();
  await w.cron();
  assert.equal(sent(w, 'الجري').length, 0);
  w.now = Date.parse('2026-10-09T08:00:30Z'); // الجمعة التالية
  await w.cron();
  assert.match(sent(w, 'الجري')[0].text, /السلسلة: يوم/);
  await w.press(`hb|d|${id}|2026-10-09`, w.nextMid);
  assert.equal(w.pages[id].props['السلسلة'].number, 2);
  w.restore();
});

test('/habits: إضافة عادة بالكتابة، والقائمة بأزرار إنجاز اليوم', async () => {
  const w = createWorld({ now: '2026-10-05T10:00:00Z' });
  await w.text('/habits');
  const mid = w.nextMid;
  assert.match(w.texts(w.flush()).join('\n'), /لا عادات بعد/);
  await w.press('hb|new|0|0', mid);
  await w.text('قراءة 10 صفحات 22:00');
  const [h] = w.of('habits');
  assert.equal(h.props['العادة'].title[0].plain_text, 'قراءة 10 صفحات');
  assert.equal(h.props['الوقت'].rich_text[0].plain_text, '22:00');
  const out = w.flush().filter(m => m.method === 'editMessageText').at(-1);
  assert.match(out.text, /أُضيفت «قراءة 10 صفحات» — تذكير كل يوم 22:00[\s\S]*▫️ <b>قراءة 10 صفحات<\/b> · 22:00/);
  assert.equal(w.buttons(out)[0].text, '✅ قراءة 10 صفحات');
  w.restore();
});

test('إضافة عادة بصيغة حرّة: التكرار خلال اليوم، التذكير الثاني، والأيام', async () => {
  const w = createWorld({ now: '2026-10-05T10:00:00Z' });
  await w.text('/habits');
  const mid = w.nextMid;
  const add = async t => { await w.press('hb|new|0|0', mid); await w.text(t); return w.flush().filter(m => m.method === 'editMessageText').at(-1); };
  let out = await add('شرب الماء كل ساعتين من 8 إلى 22');
  let h = w.of('habits').find(x => x.props['العادة'].title[0].plain_text === 'شرب الماء');
  assert.equal(h.props['الوقت'].rich_text[0].plain_text, '08:00');
  assert.equal(h.props['كل (ساعات)'].number, 2);
  assert.equal(h.props['حتى'].rich_text[0].plain_text, '22:00');
  assert.match(out.text, /أُضيفت «شرب الماء» — تذكير كل يوم، كل ساعتين 08:00–22:00/);
  out = await add('قصة لمريم 21:00 وذكّرني بعد ساعة');
  h = w.of('habits').find(x => x.props['العادة'].title[0].plain_text === 'قصة لمريم');
  assert.equal(h.props['الوقت'].rich_text[0].plain_text, '21:00');
  assert.equal(h.props['إعادة التذكير (دقائق)'].number, 60);
  assert.match(out.text, /كل يوم 21:00، وتذكير ثانٍ بعد ساعة/);
  out = await add('سورة الكهف كل جمعة 10:00');
  h = w.of('habits').find(x => x.props['العادة'].title[0].plain_text === 'سورة الكهف');
  assert.deepEqual(h.props['الأيام'].multi_select.map(o => o.name), ['الجمعة']);
  assert.match(out.text, /تذكير الجمعة 10:00/);
  w.restore();
});

test('✏️ تعديل العادة: الساعة، التكرار وحدّه، الأيام، التذكير الثاني، الاسم، الإيقاف والحذف', async () => {
  const w = createWorld({ now: '2026-10-05T10:00:00Z' }); // الاثنين
  const id = habit(w, 'رياضة', '07:00', { 'السلسلة': { type: 'number', number: 4 } });
  await w.text('/habits');
  const mid = w.nextMid;
  const list = w.flush().at(-1);
  assert.ok(w.buttons(list).some(b => b.callback_data === `hb|e|${id}|0`));
  const last = () => w.flush().filter(m => m.method === 'editMessageText').at(-1);
  await w.press(`hb|e|${id}|0`, mid);
  assert.match(last().text, /✏️ <b>رياضة<\/b>[\s\S]*🕘 الساعة: 07:00[\s\S]*📅 الأيام: كل يوم/);
  // الساعة بالكتابة
  await w.press(`hb|et|${id}|0`, mid);
  await w.text('08:30');
  assert.equal(w.pages[id].props['الوقت'].rich_text[0].plain_text, '08:30');
  assert.match(last().text, /✅ حُفظ[\s\S]*🕘 الساعة: 08:30/);
  // التكرار كل ساعتين حتى 20:00
  await w.press(`hb|er|${id}|2`, mid);
  assert.equal(w.pages[id].props['كل (ساعات)'].number, 2);
  assert.match(last().text, /حتى أي ساعة/);
  await w.press(`hb|eu|${id}|20`, mid);
  assert.equal(w.pages[id].props['حتى'].rich_text[0].plain_text, '20:00');
  assert.match(last().text, /🔁 التكرار: كل ساعتين حتى 20:00/);
  await w.press(`hb|er|${id}|0`, mid);
  assert.equal(w.pages[id].props['كل (ساعات)'].number, null);
  // الأيام: أيام العمل ثم إزالة الأحد
  await w.press(`hb|ed|${id}|work`, mid);
  assert.deepEqual(w.pages[id].props['الأيام'].multi_select.map(o => o.name).sort(), ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'].sort());
  assert.match(last().text, /الحالية: أيام العمل/);
  await w.press(`hb|eg|${id}|0`, mid);
  assert.deepEqual(w.pages[id].props['الأيام'].multi_select.map(o => o.name).sort(), ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'].sort());
  await w.press(`hb|ed|${id}|all`, mid);
  assert.deepEqual(w.pages[id].props['الأيام'].multi_select, []);
  // التذكير الثاني
  await w.press(`hb|em|${id}|30`, mid);
  assert.equal(w.pages[id].props['إعادة التذكير (دقائق)'].number, 30);
  assert.match(last().text, /⏰ التذكير الثاني: بعد 30 دقيقة/);
  // الاسم
  await w.press(`hb|en|${id}|0`, mid);
  await w.text('تمارين الضغط');
  assert.equal(w.pages[id].props['العادة'].title[0].plain_text, 'تمارين الضغط');
  // إيقاف مؤقت: السلسلة باقية، ولا تذكير، وتظهر في القائمة كمتوقفة
  await w.press(`hb|ep|${id}|0`, mid);
  assert.equal(w.pages[id].props['نشطة'].checkbox, false);
  assert.equal(w.pages[id].props['السلسلة'].number, 4);
  w.now = Date.parse('2026-10-06T07:30:30Z');
  w.flush();
  await w.cron();
  assert.equal(sent(w, 'تمارين الضغط').length, 0);
  await w.press('hb|x|0|0', mid);
  assert.match(last().text, /⏸️ <b>تمارين الضغط<\/b> <i>\(متوقفة\)<\/i>/);
  await w.press(`hb|ep|${id}|1`, mid);
  assert.equal(w.pages[id].props['نشطة'].checkbox, true);
  // حذف بتأكيد
  await w.press(`hb|ex|${id}|0`, mid);
  assert.match(last().text, /حذف «تمارين الضغط»/);
  assert.equal(w.of('habits').length, 1);
  await w.press(`hb|ey|${id}|0`, mid);
  assert.equal(w.of('habits').length, 0);
  assert.match(last().text, /🗑️ حُذفت «تمارين الضغط»/);
  w.restore();
});

test('نمو مريم: «نمو 8.4 70 44» يُسجَّل بعمرها ويُرسل رسمًا بيانيًا مع المقارنة بمتوسط منظمة الصحة', async () => {
  const w = createWorld({ now: '2026-09-05T10:00:00Z' });
  await w.text('نمو 7.9 68');
  w.now = Date.parse('2026-10-05T10:00:00Z');
  w.flush();
  await w.text('قياس 8.4 كغ 70 سم 44');
  const rows = w.of('growth');
  assert.equal(rows.length, 2);
  const r = rows.find(x => x.props['التاريخ'].date.start === '2026-10-05');
  assert.equal(r.props['الوزن (كغ)'].number, 8.4);
  assert.equal(r.props['الطول (سم)'].number, 70);
  assert.equal(r.props['محيط الرأس (سم)'].number, 44);
  assert.equal(r.props['العمر (أشهر)'].number, 10);
  const [album] = w.flush().filter(m => m.method === 'sendMediaGroup');
  assert.equal(album.media.length, 2, 'رسمان منفصلان: الوزن والطول (محور واحد لكل منهما)');
  for (const m of album.media) assert.match(m.media, /^https:\/\/quickchart\.io\/chart\?/);
  assert.equal(JSON.parse(decodeURIComponent(album.media[0].media.split('&c=')[1])).options.scales.yAxes.length, 1);
  const photo = { caption: album.media[0].caption };
  assert.match(photo.caption, /الوزن: <b>8\.4 كغ<\/b> \(\+0\.5 كغ منذ[\s\S]*المتوسط لعمرها 8\.5/);
  assert.match(photo.caption, /الطول: <b>70 سم<\/b> \(\+2 سم/);
  assert.match(photo.caption, /10 أشهر/);
  w.restore();
});

test('رزنامة التلقيح: القادمة فقط تُضاف إلى الملف الصحي (تطعيم · مريم)، ولا تتكرر', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z' }); // مريم 9 أشهر و20 يومًا
  await w.text('/vaccines');
  const m = w.flush().find(x => x.text?.includes('رزنامة تلقيح مريم'));
  assert.match(m.text, /✔️ <b>4 أشهر<\/b>[\s\S]*\(مضى\)/);
  assert.match(m.text, /📅 <b>11 شهرًا<\/b>/);
  assert.equal(w.buttons(m)[0].text, '✅ أضف 4 مواعيد قادمة إلى الملف الصحي');
  await w.press('vc|add', w.nextMid);
  const rows = w.of('health');
  assert.equal(rows.length, 4);
  const r11 = rows.find(r => r.props['التاريخ'].date.start === '2026-11-05');
  assert.match(r11.props['العنوان'].title[0].plain_text, /تلقيح 11 شهرًا: .*ROR/);
  assert.equal(r11.props['النوع'].select.name, 'تطعيم');
  assert.equal(r11.props['الشخص'].select.name, 'مريم');
  await w.press('vc|add', w.nextMid);
  assert.equal(w.of('health').length, 4, 'لا تكرار');
  w.restore();
});

test('شرب الماء كل ساعتين 08:00–22:00: تذكير في كل وقت، ويكتمل اليوم بإنجاز الأوقات الثمانية', async () => {
  const w = createWorld({ now: '2026-10-05T07:00:30Z' }); // 08:00
  const id = habit(w, 'شرب الماء', '08:00', { 'كل (ساعات)': P.num(2), 'حتى': P.text('22:00') });
  await w.cron();
  const [m] = sent(w, 'شرب الماء');
  assert.match(m.text, /شرب الماء<\/b> — 0\/8 اليوم/);
  await w.press(w.buttons(m)[0].callback_data, w.nextMid);
  assert.match(w.texts(w.flush()).at(-1), /1\/8 اليوم/);
  // 10:00: تذكير ثانٍ
  w.now = Date.parse('2026-10-05T09:00:30Z');
  await w.cron();
  const [m2] = sent(w, 'شرب الماء');
  assert.match(m2.text, /1\/8 اليوم/);
  // أكمل البقية من القائمة
  for (let i = 0; i < 7; i++) await w.press(`hb|d|${id}|2026-10-05|m`, 1);
  assert.equal(w.pages[id].props['السلسلة'].number, 1);
  assert.equal(w.pages[id].props['آخر إنجاز'].date.start, '2026-10-05');
  w.now = Date.parse('2026-10-05T11:00:30Z');
  await w.cron();
  assert.equal(sent(w, 'شرب الماء').length, 0, 'اكتمل اليوم ← لا تذكير');
  w.restore();
});

test('قراءة قصة لمريم 21:00 مع تذكير ثانٍ بعد ساعة إن لم تُسجَّل، ولا ثانٍ إن سُجّلت', async () => {
  const w = createWorld({ now: '2026-10-05T20:00:30Z' }); // 21:00
  const id = habit(w, 'قراءة قصة لمريم', '21:00', { 'إعادة التذكير (دقائق)': P.num(60) });
  await w.cron();
  assert.equal(sent(w, 'قراءة قصة لمريم').length, 1);
  w.now = Date.parse('2026-10-05T21:00:30Z'); // 22:00
  await w.cron();
  const [again] = sent(w, 'قراءة قصة لمريم');
  assert.match(again.text, /⏰ <b>لم تُسجَّل بعد:<\/b> <b>قراءة قصة لمريم<\/b>/);
  await w.press(w.buttons(again)[0].callback_data, w.nextMid);
  assert.equal(w.pages[id].props['السلسلة'].number, 1);
  // اليوم التالي: أُنجزت في وقتها ← لا تذكير ثانٍ
  w.now = Date.parse('2026-10-06T20:00:30Z');
  await w.cron();
  const [m] = sent(w, 'قراءة قصة لمريم');
  await w.press(w.buttons(m)[0].callback_data, w.nextMid);
  w.now = Date.parse('2026-10-06T21:00:30Z');
  await w.cron();
  assert.equal(sent(w, 'قراءة قصة لمريم').length, 0);
  assert.equal(w.pages[id].props['السلسلة'].number, 2);
  w.restore();
});
