// اختبارات «📱 لوحتي»: الصفحة، التحقق من initData، والبيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWorld, P } from './harness.mjs';

// initData موقّعة كما يوقّعها تلغرام (بتوكن البوت في الاختبارات: 'bot')
function initData(userId, authDate, token = 'bot') {
  const fields = { auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify({ id: userId, first_name: 'User' }) };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

test('/app تُرجع الصفحة، و/app/data ترفض الطلب بلا توقيع أو بتوقيع مزوّر أو لمستخدم آخر', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z' });
  const page = await w.get('/app');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /telegram-web-app\.js/);
  const now = Math.floor(w.now / 1000);
  assert.equal((await w.get('/app/data')).status, 403);
  assert.equal((await w.get('/app/data', { 'X-Init-Data': initData(1, now, 'wrong-token') })).status, 403, 'توقيع بتوكن آخر');
  assert.equal((await w.get('/app/data', { 'X-Init-Data': initData(999, now) })).status, 403, 'مستخدم غير صاحب البوت');
  assert.equal((await w.get('/app/data', { 'X-Init-Data': initData(1, now - 2 * 86400) })).status, 403, 'توقيع منتهي');
  assert.equal((await w.get('/app/data', { 'X-Init-Data': initData(1, now) })).status, 200);
  w.restore();
});

test('/app/data: المال لستة أشهر وفئات الشهر، إنجاز الأسابيع، الحصص، 30 يومًا من العبادات، العادات، ونمو مريم', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:00Z' });
  w.add('fin', { 'البيان': P.title('سوق'), 'النوع': P.select('مصروف'), 'المبلغ (دج)': P.num(3000), 'الفئة': P.select('تغذية'), 'التاريخ': P.date('2026-09-10') });
  w.add('fin', { 'البيان': P.title('راتب'), 'النوع': P.select('دخل'), 'المبلغ (دج)': P.num(50000), 'الفئة': P.select('راتب'), 'التاريخ': P.date('2026-08-07') });
  w.add('task', { 'المهمة': P.title('أ'), 'الموعد': P.date('2026-09-24T10:00:00.000+01:00'), 'الحالة': P.select('منجزة') });
  w.add('task', { 'المهمة': P.title('ب'), 'الموعد': P.date('2026-09-23T10:00:00.000+01:00'), 'الحالة': P.select('للقيام بها') });
  w.add('tracker', { 'اليوم': P.title('الخميس'), 'التاريخ': P.date('2026-09-24'), 'الفجر': P.check(true), 'الظهر': P.check(true), 'أذكار الصباح': P.check(true), 'الورد (صفحات)': P.num(4) });
  w.add('habits', { 'العادة': P.title('رياضة'), 'نشطة': P.check(true), 'السلسلة': P.num(3), 'أطول سلسلة': P.num(5), 'آخر إنجاز': P.date('2026-09-24') });
  w.add('growth', { 'القياس': P.title('8 كغ'), 'التاريخ': P.date('2026-09-05'), 'الوزن (كغ)': P.num(8), 'الطول (سم)': P.num(69) });
  const r = await w.get('/app/data', { 'X-Init-Data': initData(1, Math.floor(w.now / 1000)) });
  const d = await r.json();
  assert.equal(d.money.months.length, 6);
  assert.deepEqual(d.money.months.at(-1), { key: '2026-09', label: 'سبتمبر', expense: 3000, income: 0 });
  assert.equal(d.money.months.at(-2).income, 50000);
  assert.deepEqual(d.money.byCat, [['تغذية', 3000]]);
  assert.deepEqual(d.weeks.at(-1), { from: '2026-09-19', to: '2026-09-25', done: 1, total: 2 });
  assert.equal(d.days.length, 30);
  assert.deepEqual(d.days.find(x => x.date === '2026-09-24'), { date: '2026-09-24', prayers: 2, am: true, pm: false, wird: 4 });
  assert.deepEqual(d.habits, [{ name: 'رياضة', streak: 3, best: 5, doneToday: false }]);
  assert.equal(d.growth.points[0].weight, 8);
  assert.equal(d.growth.who[0].weight, 3.2);
  // الطلب الثاني من KV (بلا استعلامات Notion)
  const before = w.notionCalls;
  await w.get('/app/data', { 'X-Init-Data': initData(1, Math.floor(w.now / 1000)) });
  assert.equal(w.notionCalls, before);
  w.restore();
});

test('/dashboard: زر يفتح اللوحة داخل تلغرام', async () => {
  const w = createWorld();
  await w.text('/dashboard');
  const m = w.flush().find(x => x.text?.includes('لوحتي'));
  assert.equal(w.buttons(m)[0].web_app.url, 'https://x/app');
  w.restore();
});

test('أزرار الشاشة: «🔥 العادات» و«📱 لوحتي» (يفتح اللوحة بمفتاح يقبله /app/data)', async () => {
  const w = createWorld();
  await w.text('/start');
  const kb = w.flush().find(m => m.reply_markup?.keyboard).reply_markup.keyboard;
  assert.deepEqual(kb[2].map(b => b.text), ['🔥 العادات', '📱 لوحتي']);
  const url = new URL(kb[2][1].web_app.url);
  assert.equal(url.pathname, '/app');
  const k = url.searchParams.get('k');
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal((await w.get('/app/data', { 'X-Dash-Key': k })).status, 200);
  assert.equal((await w.get('/app/data', { 'X-Dash-Key': '0'.repeat(32) })).status, 403);
  await w.text('🔥 العادات');
  assert.match(w.texts(w.flush()).join('\n'), /عاداتي/);
  w.restore();
});
