// اختبارات الإعدادات الشخصية: بلا طفل، طفل ذكر، وإيقاف الميزات (DISABLE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './harness.mjs';

test('بلا طفل ومع DISABLE=prayer,money: لا أذان، لا أزرار مال، ولا «صورة للطفل»', async () => {
  const w = createWorld({ now: '2026-09-25T04:12:30Z' }); // وقت الفجر
  Object.assign(w.env, { CHILD_NAME: '', DISABLE: 'prayer,money' });
  await w.cron();
  assert.equal(w.texts(w.flush()).filter(t => t.includes('صلاة')).length, 0);
  await w.text('/start');
  const msgs = w.flush();
  const kb = msgs.find(m => m.reply_markup?.keyboard).reply_markup.keyboard.flat().map(b => b.text);
  assert.ok(!kb.includes('💸 إنفاق') && !kb.includes('💵 قبض'));
  assert.ok(kb.includes('🔥 العادات'));
  assert.doesNotMatch(w.texts(msgs).join('\n'), /مريم|صورة ل/);
  await w.photo();
  const card = w.flush().find(m => m.text?.includes('صورة جديدة'));
  assert.deepEqual(w.buttons(card).map(b => b.callback_data), ['ph|d', 'ph|x']);
  await w.text('نمو 8.4 70');
  assert.equal(w.of('growth').length, 0);
  w.restore();
});

test('طفل ذكر: «يُتمّ» في الملخص الصباحي، ومتوسطات الأولاد في النمو', async () => {
  const w = createWorld({ now: '2026-10-05T06:30:00Z' }); // 07:30 يوم 5
  Object.assign(w.env, { CHILD_NAME: 'آدم', CHILD_SEX: 'boy' });
  await w.cron();
  assert.match(w.texts(w.flush()).join('\n'), /آدم يُتمّ اليوم 10 أشهر[\s\S]*أرسل له صورة/);
  await w.text('نمو 8.4 70');
  const album = w.flush().find(m => m.method === 'sendMediaGroup');
  assert.match(album.media[0].caption, /المتوسط لعمره 9\.2/);
  assert.match(decodeURIComponent(album.media[0].media), /WHO median \(boys\)/);
  w.restore();
});
