// تكرار التنبيه نفسه كل دقيقة: التشغيلات المتداخلة حين يبطؤ Notion، والكتابة فوق الحالة من نسخة قديمة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, P } from './harness.mjs';
import { loadState, saveState } from '../src/alerts.js';

const count = (w, s) => w.sent.filter(m => m.method === 'sendMessage' && String(m.text).includes(s)).length;

test('Notion بطيء والتشغيلات تتداخل: أذكار الصباح تُرسل مرة واحدة', async () => {
  const w = createWorld({ now: '2026-10-03T06:10:00Z' }); // السبت 07:10 — بعد الفجر بأكثر من 40 دقيقة
  await w.overlappingCrons(5);
  assert.equal(count(w, 'أذكار الصباح'), 1);
  w.restore();
});

test('Notion بطيء والتشغيلات تتداخل: تنبيه المهمة يُرسل مرة واحدة', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  w.add('task', { 'المهمة': P.title('3 أخبار فيديو'), 'الموعد': P.date('2026-09-25T10:00:00.000Z'), 'الحالة': P.select('للقيام بها') });
  await w.overlappingCrons(5);
  assert.equal(count(w, '3 أخبار فيديو'), 1);
  w.restore();
});

test('«✅ قرأتها» توقف الأذكار نهائيًا ولو ضاعت علامة الإرسال من الحالة', async () => {
  const w = createWorld({ now: '2026-10-03T06:10:00Z' });
  await w.cron();
  assert.equal(count(w, 'أذكار الصباح'), 1);
  await w.press('sp|am|2026-10-03', w.nextMid);
  // علامة «أُرسلت» تضيع (قراءة قديمة من KV أو كتابة فوقها) — المتتبع في Notion يبقى المرجع
  const s = JSON.parse(w.kv.state);
  delete s.sent['adk:am:2026-10-03'];
  w.kv.state = JSON.stringify(s);
  for (let i = 0; i < 3; i++) { w.now += 60e3; await w.cron(); }
  assert.equal(count(w, 'أذكار الصباح'), 1);
  w.restore();
});

test('حفظ نسخة قديمة من الحالة (زر ضُغط أثناء التشغيل) لا يمحو ما أُرسل', async () => {
  const w = createWorld({ now: '2026-09-25T10:00:30Z' });
  w.add('task', { 'المهمة': P.title('منشور يومي'), 'الموعد': P.date('2026-09-25T10:00:00.000Z'), 'الحالة': P.select('للقيام بها') });
  const stale = await loadState(w.env); // قُرئت قبل التنبيه
  await w.cron();
  assert.equal(count(w, 'منشور يومي'), 1);
  await saveState(w.env, stale);        // ثم حُفظت فوقه
  w.now += 60e3;
  await w.cron();
  assert.equal(count(w, 'منشور يومي'), 1);
  w.restore();
});
