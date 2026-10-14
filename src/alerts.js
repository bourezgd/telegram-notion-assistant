import { checkHabits } from './habits.js';
import { checkBills } from './bills.js';
import { notion, tg } from './api.js';
import { budgetLeft, cfg, DAY, DUE_GRACE_MS, EDIT_LOOKBACK_MS, MAX_CALLS_PER_RUN, MSG_TTL_MS, on, SENT_TTL_MS, SOURCES, SUBREQ_RESERVE } from './core.js';
import { checkMedicines } from './docs.js';
import { checkEvents } from './events.js';
import { isWeekend, nextWorkday, withJiha } from './jihat.js';
import { say } from './messages.js';
import { checkMorning } from './morning.js';
import { checkChildNudge, checkMemories } from './diary.js';
import { checkPrayers } from './prayer.js';
import { checkQuota } from './quota.js';
import { STEP, createNext, jihaOf } from './repeat.js';
import { checkReview, localHourOf } from './review.js';
import { checkSpiritual } from './spirit.js';
import { addDays, fmtTime, localDate, zonedToUtc } from './time.js';
import { editMessage, esc, plainText, view } from './view.js';
import { checkWeekly } from './weekly.js';

// ───────────────────────── التنبيهات الدورية ─────────────────────────

// الحالة في KV (مفتاح واحد):
//   sent: { "<id>:<start>": وقت الإرسال }            — ما نُبّه عنه حتى لا يتكرر
//   msgs: { "<id>": { mid, start, sig, t } }         — آخر رسالة لكل مهمة، لتحديثها عند تعديل Notion
//   prayers: { "<date>:<prayer>": { sent, reminded, done, mids } } — تنبيهات الصلاة
export async function loadState(env) {
  const s = (await env.STATE.get('state', 'json')) || {};
  return { sent: s.sent || {}, msgs: s.msgs || {}, prayers: s.prayers || {}, anchors: s.anchors || {} };
}
// KV المجاني: 1000 كتابة يوميًا، لذا نكتب فقط عند التغيير.
// الحفظ يدمج مع أحدث نسخة في KV بدل الكتابة فوقها: تشغيل آخر متداخل (Notion بطيء) أو زر ضُغط أثناء
// التشغيل قد يكون حفظ علامات «أُرسل» بعد أن قرأنا الحالة، ومحوها يعيد إرسال التنبيه نفسه كل دقيقة.
export async function saveState(env, state, fresh) {
  const cur = fresh || await loadState(env), now = Date.now();
  const sent = { ...cur.sent, ...state.sent };
  for (const [k, t] of Object.entries(sent)) if (now - t > SENT_TTL_MS) delete sent[k]; // 0 = أُفرج عنه (release)
  const msgs = { ...cur.msgs, ...state.msgs };
  for (const [k, m] of Object.entries(msgs)) if (now - m.t > MSG_TTL_MS) delete msgs[k];
  const prayers = { ...cur.prayers };
  for (const [k, p] of Object.entries(state.prayers)) {
    const c = prayers[k];
    prayers[k] = !c ? p : { ...c, ...p, sent: c.sent || p.sent, reminded: c.reminded || p.reminded, done: c.done || p.done,
      mids: [...new Set([...(c.mids || []), ...(p.mids || [])])] };
  }
  const oldest = addDays(localDate(now, env.TZ_NAME), -2);
  for (const k of Object.keys(prayers)) if (k.slice(0, 10) < oldest) delete prayers[k];
  Object.assign(state, { sent, msgs, prayers, anchors: { ...cur.anchors, ...state.anchors } });
  return env.STATE.put('state', JSON.stringify(state));
}

// يحجز تنبيهًا قبل إرساله ويحفظ الحجز فورًا. يتحقق أولًا من أحدث حالة في KV، لأن تشغيلًا متداخلًا
// ربما أرسله بعد أن قرأنا الحالة في بداية تشغيلنا. يُرجع false إن كان قد أُرسل.
export async function claim(env, state, key, now) {
  if (state.sent[key]) return false;
  const fresh = await loadState(env);
  if (fresh.sent[key]) { state.sent[key] = fresh.sent[key]; return false; }
  state.sent[key] = now;
  await saveState(env, state, fresh); // بلا قراءة ثانية: أضيق نافذة ممكنة بين التحقق والكتابة
  return true;
}
// تعذّر الإرسال مؤقتًا بعد الحجز ← تُعاد المحاولة في الدقيقة التالية (الرفض الدائم لا يُفرج عنه حتى لا يُعاد كل دقيقة)
export async function release(env, state, key) {
  state.sent[key] = 0;
  await saveState(env, state);
}

export async function checkDue(env) {
  const now = Date.now();
  // نبض للتأكد أن التشغيل الدوري حيّ (/status) — كتابة كل 30 دقيقة على الأكثر
  if (now - Number(await env.STATE.get('lastrun') || 0) > 30 * 60e3) await env.STATE.put('lastrun', String(now));
  const state = await loadState(env);
  let changed = false, calls = 0;
  // نسخة للمقارنة: أي تعديل على الحالة يُحفظ في النهاية ولو فشل جزء بعد الإرسال (وإلا تتكرر الرسالة كل دقيقة)
  let snap = JSON.stringify(state);

  // 0) الصلاة أولًا حتى لا يتأخر الأذان خلف تنبيهات كثيرة، وتُحفظ فورًا: لو تعطّل Notion بعدها
  // لا يُعاد إرسال نفس الأذان كل دقيقة
  // وإن فشل (تلغرام مثلًا) نحفظ ما تغيّر قبل الفشل ونكمل بقية التشغيل
  let pr = { calls: 0, changed: true };
  if (on('prayer')) try { pr = await checkPrayers(env, state, now); } catch (err) { await reportError(env, 'الصلاة', err); }
  calls += pr.calls;
  if (pr.changed) { await saveState(env, state); snap = JSON.stringify(state); }

  // كل جزء معزول عن غيره: فشل أحدها (عادة لا تُرسل، استعلام Notion يُرفض) يُبلَّغ عنه ولا يوقف البقية.
  const part = async (name, fn) => { try { return await fn(); } catch (err) { await reportError(env, name, err); } };
  try {

  // 0ب) الأذكار والورد ورمضان (أوقاتها مرتبطة بالصلاة)
  if (on('prayer') && await part('الأذكار', () => checkSpiritual(env, state, now))) changed = true;
  // 0ج) العادات في أوقاتها
  if (await part('العادات', () => checkHabits(env, state, now))) changed = true;

  // 1) ما عُدّل في Notion خلال الدقائق الأخيرة ← تحديث رسالته في تلغرام إن كانت قد أُرسلت
  await part('تحديث الرسائل', async () => {
    const edited = await withJiha(env, (await Promise.all(Object.keys(SOURCES).map(kind => queryItems(env, kind, {
      timestamp: 'last_edited_time', last_edited_time: { on_or_after: new Date(now - EDIT_LOOKBACK_MS).toISOString() },
    })))).flat());
    for (const item of edited) {
      const msg = state.msgs[item.id];
      if (!msg || calls >= MAX_CALLS_PER_RUN) continue;
      const v = view(item, msg.start, env);
      if (v.sig === msg.sig) continue;
      await editMessage(env, msg.mid, v);
      calls++;
      msg.sig = v.sig; changed = true;
    }
  });

  // 2) ما حلّ موعده ← رسالة مستقلة بأزرار
  const due = (await Promise.all(Object.keys(SOURCES).map(kind => queryItems(env, kind, { and: [
    { property: SOURCES[kind].date, date: { on_or_after: new Date(now - 2 * DAY).toISOString() } },
    { property: SOURCES[kind].date, date: { on_or_before: new Date(now + 2 * DAY).toISOString() } },
    ...SOURCES[kind].closed.map(s => ({ property: SOURCES[kind].status, select: { does_not_equal: s } })),
  ] })))).flat().sort((a, b) => a.alertAt - b.alertAt);
  await withJiha(env, due);

  // نسخ مكررة مفتوحة (نفس العنوان والموعد والجهة) — من خطأ التكرار السابق أو إضافة مرتين: نُبقي واحدة
  // (ما عليه «تكرار تلقائي» أولًا حتى لا ينقطع التكرار) وننقل الباقي إلى سلة Notion (تُسترجع خلال 30 يومًا)
  const groups = new Map();
  // بالوقت الفعلي لا بنص الموعد: الموعد نفسه قد يُكتب ‎+01:00 أو Z
  for (const i of due) { const k = `${i.kind}|${i.title}|${i.alertAt}|${jihaOf(i.raw)}`; groups.set(k, [...(groups.get(k) || []), i]); }
  for (const g of groups.values()) {
    const keep = g.find(i => i.auto) || g[0];
    for (const i of g) {
      if (i === keep || budgetLeft() < SUBREQ_RESERVE) continue;
      due.splice(due.indexOf(i), 1);
      await part('حذف نسخة مكررة', () => notion(env, 'PATCH', `pages/${i.id}`, { in_trash: true }));
      calls++;
    }
  }

  for (const item of due) {
    const key = `${item.id}:${item.start}`;
    if (state.sent[key] || now < item.alertAt) continue;
    if (calls >= MAX_CALLS_PER_RUN || budgetLeft() < SUBREQ_RESERVE) break; // الباقي في الدقيقة التالية
    // مهمة جهة لا نعمل لها في العطلة ← تُرحَّل بصمت إلى أول يوم عمل بنفس الساعة
    if (item.weekdayOnly && isWeekend(item.localDate, env)) {
      const to = nextWorkday(item.localDate, env);
      await notion(env, 'PATCH', `pages/${item.id}`, { properties: { [SOURCES[item.kind].date]: { date: item.hasTime
        ? { start: `${to}T${fmtTime(Date.parse(item.start), env)}:00`, time_zone: env.TZ_NAME } : { start: to } } } });
      calls++; state.sent[key] = now; changed = true;
      continue;
    }
    if (!await claim(env, state, key, now)) continue;
    changed = true;
    // كل عنصر معزول: فشله يُبلَّغ عنه ونكمل بالبقية. العطل المؤقت (الخدمة لا تستجيب) يُعاد في الدقيقة التالية،
    // أما الرفض الدائم (مثل رسالة يرفضها تلغرام) فلا يُعاد كل دقيقة
    try {
      // عنصر متكرر تلقائيًا: نُنشئ موعده التالي لحظة حلول الحالي (وفشله لا يمنع تنبيه الحالي)
      if (item.auto && STEP[item.repeat]) {
        calls += 3;
        await createNext(env, item, state).catch(async err => {
          if (err.transient) throw err;
          await reportError(env, `تكرار «${item.title}»`, err);
        });
      }
      if (now - item.alertAt <= DUE_GRACE_MS) {
        const v = view(item, item.start, env);
        const sent = await tg(env, 'sendMessage', {
          chat_id: env.TELEGRAM_CHAT_ID, text: v.text, parse_mode: 'HTML',
          disable_web_page_preview: true, reply_markup: v.markup,
        });
        calls++;
        state.msgs[item.id] = { mid: sent.message_id, start: item.start, sig: v.sig, t: now };
      }
    } catch (err) {
      if (err.transient) await release(env, state, key);
      await reportError(env, `تنبيه «${item.title}»`, err);
      if (err.transient) break; // الخدمة لا تستجيب: نكمل الباقي في الدقيقة التالية
    }
  }

  // 2ب) المواعيد الطبية: تذكير مساء اليوم السابق
  if (localHourOf(now, env) >= Number(env.HEALTH_EVE_HOUR || 20)) {
    const tomorrow = addDays(localDate(now, env.TZ_NAME), 1);
    for (const item of due.filter(i => i.kind === 'health' && i.localDate === tomorrow)) {
      const key = `eve:${item.id}:${item.start}`;
      if (state.sent[key] || calls >= MAX_CALLS_PER_RUN) continue;
      const when = item.hasTime ? fmtTime(Date.parse(item.start), env) : '';
      await say(env, [`🩺 <b>غدًا${when ? ` ${when}` : ''}: ${esc(item.title)}</b>`,
        item.person ? `👤 ${esc(item.person)}` : '', item.place ? `🏥 ${esc(item.place)}` : '', item.notes ? `📝 ${esc(item.notes.slice(0, 300))}` : '',
        `<a href="${esc(item.url)}">فتح في Notion</a>`].filter(Boolean).join('\n'));
      calls++; state.sent[key] = now; changed = true;
    }
  }

  // 2ب) تذكيرات الدواء
  if (budgetLeft() >= SUBREQ_RESERVE && await checkMedicines(env, state, now)) changed = true;

  for (const [k, t] of Object.entries(state.sent)) if (now - t > SENT_TTL_MS) { delete state.sent[k]; changed = true; }
  for (const [k, m] of Object.entries(state.msgs)) if (now - m.t > MSG_TTL_MS) { delete state.msgs[k]; changed = true; }
    // دورة سليمة ← ينتهي العطل المؤقت إن كان
    if (await env.STATE.get('err_first')) await env.STATE.delete('err_first');
  } catch (err) {
    await reportError(env, 'التنبيهات', err);
  } finally {
    // ما أُرسل قبل الخطأ يُحفظ حتى لا يتكرر
    if (changed || JSON.stringify(state) !== snap) await saveState(env, state);
  }

  // 3) مراجعة المساء، التقرير الأسبوعي، المناسبات — كلٌّ مستقل عن الآخر
  // كلٌّ منها مُعلَّم في KV بعد النجاح، فتأجيله لدقيقة لاحقة آمن
  for (const [name, fn, need, feature] of [['الملخص الصباحي', checkMorning, 14], ['مراجعة المساء', checkReview, 8], ['التقرير الأسبوعي', checkWeekly, 14], ['المناسبات', checkEvents, 8], [`ذكريات ${cfg.child}`, checkMemories, 6, 'child'], ['تذكير صور الطفل', checkChildNudge, 4, 'child'], ['الحصة الشهرية', checkQuota, 8, 'jihat'], ['الرواتب والفواتير', checkBills, 10, 'money']]) {
    if (budgetLeft() < need || (feature && !on(feature))) continue;
    try { await fn(env, now); } catch (err) { await reportError(env, name, err); }
  }
}

// إشعار بالعطل مرة كل 6 ساعات على الأكثر (مثلًا: سُحب إذن Notion أو تعطّل مؤقتًا)
// العطل المؤقت (Notion أو تلغرام لا يستجيب) لا يُبلَّغ عنه إلا إن استمر TRANSIENT_GRACE_MS
export const TRANSIENT_GRACE_MS = 10 * 60e3;
export async function reportError(env, where, err) {
  console.error(where, err);
  const msg = String(err.message || err).slice(0, 300);
  let since = 0;
  if (err?.transient) {
    since = Number(await env.STATE.get('err_first') || 0);
    if (!since) {
      await env.STATE.put('err_first', String(Date.now()), { expirationTtl: 3600 });
      await env.STATE.put('last_err', JSON.stringify({ where, msg: msg.slice(0, 200), at: Date.now() }), { expirationTtl: 7 * 24 * 3600 });
      return;
    }
    if (Date.now() - since < TRANSIENT_GRACE_MS) return;
  }
  if (await env.STATE.get('err_notice')) return;
  await env.STATE.put('err_notice', '1', { expirationTtl: 6 * 3600 });
  await env.STATE.put('last_err', JSON.stringify({ where, msg: msg.slice(0, 200), at: Date.now() }), { expirationTtl: 7 * 24 * 3600 });
  const text = err?.transient
    ? `⚠️ <b>${/Telegram/.test(msg) ? 'تلغرام' : 'Notion'} لا يستجيب منذ ${Math.round((Date.now() - since) / 60e3)} دقيقة</b> (${esc(where)})\n<code>${esc(msg)}</code>\n<i>العطل من جهة الخدمة لا من البوت. أواصل المحاولة كل دقيقة، وتصلك التنبيهات الفائتة حين يعود (ما لم يمضِ عليها أكثر من 3 ساعات).</i>`
    : `⚠️ <b>عطل في ${esc(where)}</b>\n<code>${esc(msg)}</code>\n<i>سأواصل المحاولة كل دقيقة، ولن أكرّر هذا الإشعار قبل 6 ساعات.</i>`;
  await say(env, text).catch(() => {});
}

export async function queryItems(env, kind, filter) {
  const src = SOURCES[kind];
  const items = [];
  let cursor;
  do {
    const page = await notion(env, 'POST', `data_sources/${src.ds}/query`, { filter, start_cursor: cursor, page_size: 100 });
    for (const p of page.results) {
      const item = parsePage(p, kind, env);
      if (item) items.push(item);
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return items;
}

export function parsePage(p, kind, env) {
  const src = SOURCES[kind];
  const props = p.properties;
  const date = props[src.date]?.date;
  if (!date?.start) return null;
  if (src.types && !src.types.includes(props['النوع']?.select?.name)) return null;
  const hasTime = date.start.includes('T');
  // الموعد الطبي: التنبيه قبله بمدة (للتحضّر والطريق)
  const lead = kind === 'health' && hasTime ? Number(env.HEALTH_LEAD_MIN || 120) * 60e3 : 0;
  return {
    id: p.id.replace(/-/g, ''), kind, url: p.url, start: date.start, end: date.end, hasTime,
    localDate: hasTime ? localDate(Date.parse(date.start), env.TZ_NAME) : date.start.slice(0, 10),
    // المواعيد بلا ساعة تُنبَّه في DATE_ONLY_HOUR بتوقيت المستخدم
    alertAt: hasTime ? Date.parse(date.start) - lead : zonedToUtc(date.start, `${env.DATE_ONLY_HOUR || 8}:00`, env.TZ_NAME),
    title: plainText(props[src.title]) || '(بلا عنوان)',
    status: props[src.status]?.select?.name || null,
    priority: (src.priority && props[src.priority]?.select?.name) || null,
    notes: plainText(props[src.notes]),
    repeat: props[src.repeat]?.select?.name || null,
    auto: props[src.auto]?.checkbox === true,
    person: props['الشخص']?.select?.name || null,
    place: plainText(props['الطبيب/المكان']),
    raw: props,
  };
}
