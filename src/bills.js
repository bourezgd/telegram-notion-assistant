import { answer, notion, tg } from './api.js';
import { DAY, DS } from './core.js';
import { daysIn } from './events.js';
import { FIN, fmtDa, guessCat, queryAll, saveMoney } from './money.js';
import { MONTH_NAME } from './quota.js';
import { addDays, addMonths, localDate, pastLocalTime } from './time.js';
import { NO_BUTTONS, editMessage, esc, plainText } from './view.js';
import { say } from './messages.js';

// ───────────────────────── 💸 الرواتب والفواتير والتحليل الشهري ─────────────────────────
//
// من «📋 الميزانية الشهرية»، لكل بند له «يوم الاستحقاق» (مرة يوميًا الساعة QUOTA_TIME):
// • دخل (راتب): إن مضى على موعده يومان ولم يُسجَّل في «💰 المالية» هذا الشهر ← تنبيه بأزرار «✅ قبضته» (يُسجَّل)
//   و«⏰ بعد 3 أيام» و«🚫 ليس هذا الشهر».
// • مصروف ثابت (فاتورة/اشتراك/كراء): تذكير قبل موعده بيومين ويوم الموعد، ما لم يُسجَّل دفعه؛ «💸 دفعته» يسجّله
//   ويحدّث «آخر دفع». «الدورية» (شهري، كل شهرين، كل 3 أشهر، سنوي) تُحسب من «آخر دفع».
// يوم 1: تحليل شهري للشهر الماضي مقارنةً بالذي قبله (بلا Gemini: الأرقام لا تغادر Notion).
// • بعد تسجيل أي مصروف: «🔁 اجعلها دورية» ← شهر / 3 أشهر / 6 أشهر / سنة ← يُحفظ بندًا (مصروف ثابت) بيوم الدفع
//   ودوريته، ويُذكَّر به بعد المدة بتكرار. وكل مصروف لاحق يطابق اسمه يحدّث «آخر دفع» تلقائيًا.
// • ⚙️ ← «🧾 الفواتير والاشتراكات» (أو /bills): القائمة وموعد كلٍّ القادم، مع 🗑️ لحذف ما لن يُدفع بعد الآن.
// KV: bill:<id>:<YYYY-MM> = «done» أو تاريخ إعادة التذكير. callback: bl|<فعل>|<id>

const PERIOD = { 'شهري': 1, 'كل شهرين': 2, 'كل 3 أشهر': 3, 'كل 6 أشهر': 6, 'سنوي': 12 };
const PERIOD_NAME = { 1: 'شهري', 2: 'كل شهرين', 3: 'كل 3 أشهر', 6: 'كل 6 أشهر', 12: 'سنوي' };
const PERIOD_LABEL = { 1: 'كل شهر', 2: 'كل شهرين', 3: 'كل 3 أشهر', 6: 'كل 6 أشهر', 12: 'كل سنة' };
const INCOME_GRACE_DAYS = 2, BILL_LEAD_DAYS = 2;

function budgetItem(p) {
  const pr = p.properties;
  return {
    id: p.id.replace(/-/g, ''), name: plainText(pr['البند']), type: pr['النوع']?.select?.name,
    amount: pr['المبلغ (دج)']?.number || 0, day: pr['يوم الاستحقاق']?.number || null,
    period: PERIOD[pr['الدورية']?.select?.name] || 1, lastPaid: pr['آخر دفع']?.date?.start?.slice(0, 10) || null,
  };
}

// تاريخ استحقاق البند في شهر today (أو null إن لم يكن هذا الشهر حسب الدورية)
function dueThisMonth(b, today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  if (b.lastPaid) {
    const next = addMonths(b.lastPaid.slice(0, 8) + '01', b.period);
    if (next.slice(0, 7) > today.slice(0, 7)) return null; // دُفع لهذه الدورة
  }
  return `${today.slice(0, 8)}${String(Math.min(b.day, daysIn(y, m))).padStart(2, '0')}`;
}
// موعد الاستحقاق القادم (للعرض)
function nextDue(b, today) {
  const base = b.lastPaid ? addMonths(b.lastPaid.slice(0, 8) + '01', b.period) : today.slice(0, 8) + '01';
  let first = base < today.slice(0, 8) + '01' ? today.slice(0, 8) + '01' : base;
  const at = f => `${f.slice(0, 8)}${String(Math.min(b.day, daysIn(Number(f.slice(0, 4)), Number(f.slice(5, 7))))).padStart(2, '0')}`;
  if (at(first) < today && !b.lastPaid) first = addMonths(first, 1);
  return at(first);
}
const sameName = (a, b) => { a = a.trim().toLowerCase(); b = b.trim().toLowerCase(); return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)); };
const isSub = b => b.type === 'مصروف ثابت' && b.day;

// مصروف سُجّل ← إن طابق اشتراكًا/فاتورة دورية يُحدَّث «آخر دفع» (يُرجع البند أو null)
export async function touchSubscription(env, desc, date) {
  const subs = (await queryAll(env, DS.budget, null).catch(() => [])).map(budgetItem).filter(isSub);
  const b = subs.find(x => sameName(x.name, desc));
  if (!b) return null;
  await notion(env, 'PATCH', `pages/${b.id}`, { properties: { 'آخر دفع': { date: { start: date } } } });
  await env.STATE.put(`bill:${b.id}:${date.slice(0, 7)}`, 'done', { expirationTtl: 40 * 24 * 3600 });
  b.lastPaid = date;
  return b;
}

export const subscriptionLine = (b, today) => `🔁 <b>${esc(b.name)}</b> — ${PERIOD_LABEL[b.period] || 'دوري'} · القادم ${nextDue(b, today).split('-').reverse().slice(0, 2).map(Number).join('/')}`;

// ⚙️ ← «🧾 الفواتير والاشتراكات»
export async function billsView(env) {
  const today = localDate(Date.now(), env.TZ_NAME);
  const subs = (await queryAll(env, DS.budget, null)).map(budgetItem).filter(isSub);
  const lines = ['🧾 <b>الفواتير والاشتراكات الدورية</b>', ''];
  if (!subs.length) lines.push('لا شيء بعد. بعد تسجيل أي فاتورة أو اشتراك (💸 إنفاق) اضغط «🔁 اجعلها دورية».');
  for (const b of subs.sort((x, y) => nextDue(x, today).localeCompare(nextDue(y, today)))) {
    lines.push(`• <b>${esc(b.name)}</b> — ${fmtDa(b.amount)} · ${PERIOD_LABEL[b.period]} · يوم ${b.day}`, `     ⏳ القادم: ${nextDue(b, today).split('-').reverse().slice(0, 2).map(Number).join('/')}${b.lastPaid ? ` · آخر دفع ${b.lastPaid.split('-').reverse().slice(0, 2).map(Number).join('/')}` : ''}`);
  }
  if (subs.length) lines.push('', '<i>🗑️ احذف ما قررت ألا تدفعه بعد الآن — يتوقف تذكيره.</i>');
  return { text: lines.join('\n'), markup: { inline_keyboard: subs.map(b => [{ text: `🗑️ ${b.name.slice(0, 28)}`, callback_data: `bl|dq|${b.id}` }]) } };
}

// هل سُجّل البند في المالية هذا الشهر؟ (البيان يحتوي اسم البند أو اسمه دون «راتب»)
function recorded(b, rows) {
  const want = b.type === 'دخل' ? 'دخل' : 'مصروف';
  const keys = [b.name, b.name.replace(/^راتب\s+/, '')].filter(k => k.length >= 3).map(k => k.toLowerCase());
  return rows.some(r => r.properties[FIN.type]?.select?.name === want
    && keys.some(k => plainText(r.properties[FIN.title]).toLowerCase().includes(k)));
}

export async function checkBills(env, now) {
  if (!pastLocalTime(now, env, env.QUOTA_TIME || '10:00')) return;
  const today = localDate(now, env.TZ_NAME);
  if ((await env.STATE.get('billday')) === today) return;
  const items = (await queryAll(env, DS.budget, null)).map(budgetItem).filter(b => b.day && b.name && ['دخل', 'مصروف ثابت'].includes(b.type));
  if (items.length) {
    const rows = await queryAll(env, FIN.ds, { property: FIN.date, date: { on_or_after: today.slice(0, 8) + '01' } });
    for (const b of items) {
      const due = dueThisMonth(b, today);
      if (!due) continue;
      const key = `bill:${b.id}:${today.slice(0, 7)}`, mark = await env.STATE.get(key);
      if (mark === 'done' || (mark && mark > today) || recorded(b, rows)) continue;
      const ttl = { expirationTtl: 40 * 24 * 3600 };
      if (b.type === 'دخل' && today >= addDays(due, INCOME_GRACE_DAYS)) {
        await say(env, `💸 <b>لم يُسجَّل «${esc(b.name)}» هذا الشهر</b>\n💰 ${fmtDa(b.amount)} · موعده يوم ${b.day}`, { inline_keyboard: [
          [{ text: '✅ قبضته — سجّله', callback_data: `bl|in|${b.id}` }],
          [{ text: '⏰ بعد 3 أيام', callback_data: `bl|snz|${b.id}` }, { text: '🚫 ليس هذا الشهر', callback_data: `bl|skip|${b.id}` }],
        ] });
        await env.STATE.put(key, addDays(today, 1), ttl); // لا يتكرر قبل الغد (إلا بالأزرار)
      } else if (b.type === 'مصروف ثابت' && today >= addDays(due, -BILL_LEAD_DAYS)) {
        const left = Math.round((Date.parse(due) - Date.parse(today)) / DAY);
        const when = left > 1 ? `بعد ${left === 2 ? 'يومين' : `${left} أيام`}` : left === 1 ? 'غدًا' : left === 0 ? '<b>اليوم</b>' : `متأخر ${-left === 1 ? 'يومًا' : `${-left} أيام`}`;
        await say(env, `🧾 <b>${esc(b.name)}</b> — يستحق ${when} (يوم ${b.day})\n💰 ${fmtDa(b.amount)}`, { inline_keyboard: [
          [{ text: '💸 دفعته — سجّله', callback_data: `bl|out|${b.id}` }, { text: '⏰ غدًا', callback_data: `bl|tmr|${b.id}` }],
        ] });
        await env.STATE.put(key, addDays(today, 1), ttl);
      }
    }
  }
  // يوم 1: تحليل الشهر الماضي
  if (today.slice(8) === '01' && !(await env.STATE.get(`analysis:${today.slice(0, 7)}`))) {
    await say(env, await monthAnalysis(env, now, -1));
    await env.STATE.put(`analysis:${today.slice(0, 7)}`, '1', { expirationTtl: 40 * 24 * 3600 });
  }
  await env.STATE.put('billday', today, { expirationTtl: 3 * 24 * 3600 });
}

export async function onBillButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, act, id] = String(cb.data).split('|');
  if (!/^[0-9a-f]{32}$/.test(id || '')) return answer(env, cb.id, 'زر غير صالح');
  const mid = cb.message.message_id, today = localDate(Date.now(), env.TZ_NAME);
  // بعد تسجيل مصروف: «🔁 اجعلها دورية» ← اختيار المدة (id = قيد المالية)
  if (act === 'mk') {
    await answer(env, cb.id);
    const periods = [1, 3, 6, 12].map(n => ({ text: PERIOD_LABEL[n], callback_data: `bl|p${n}|${id}` }));
    return tg(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: mid, reply_markup: { inline_keyboard: [periods.slice(0, 2), periods.slice(2), [{ text: '✖️ لا', callback_data: `bl|nx|${id}` }]] } });
  }
  if (act === 'nx') {
    await answer(env, cb.id);
    return tg(env, 'editMessageReplyMarkup', { chat_id: env.TELEGRAM_CHAT_ID, message_id: mid, reply_markup: NO_BUTTONS });
  }
  if (/^p(1|3|6|12)$/.test(act)) {
    const n = Number(act.slice(1));
    const f = (await notion(env, 'GET', `pages/${id}`)).properties;
    const name = plainText(f[FIN.title]), amount = f[FIN.amount]?.number || 0, paid = (f[FIN.date]?.date?.start || today).slice(0, 10);
    const props = {
      'البند': { title: [{ type: 'text', text: { content: name } }] }, 'النوع': { select: { name: 'مصروف ثابت' } },
      'المبلغ (دج)': { number: amount }, 'يوم الاستحقاق': { number: Number(paid.slice(8)) },
      'الدورية': { select: { name: PERIOD_NAME[n] } }, 'آخر دفع': { date: { start: paid } },
    };
    const existing = (await queryAll(env, DS.budget, null)).map(budgetItem).find(x => x.type === 'مصروف ثابت' && sameName(x.name, name));
    const page = existing ? await notion(env, 'PATCH', `pages/${existing.id}`, { properties: props })
      : await notion(env, 'POST', 'pages', { parent: { type: 'data_source_id', data_source_id: DS.budget }, properties: props });
    await answer(env, cb.id, '🔁 حُفظت');
    const b = budgetItem(page);
    return editMessage(env, mid, { text: `${(cb.message.text || '').split('\n').slice(0, 3).map(esc).join('\n')}\n\n${subscriptionLine(b, today)}\n<i>سأذكّرك قبل موعدها بيومين. للحذف: ⚙️ ← 🧾 الفواتير والاشتراكات.</i>`, markup: NO_BUTTONS });
  }
  if (act === 'dq' || act === 'dy' || act === 'dn') {
    if (act === 'dn') { await answer(env, cb.id); return editMessage(env, mid, await billsView(env)); }
    const b = budgetItem(await notion(env, 'GET', `pages/${id}`));
    if (act === 'dq') {
      await answer(env, cb.id);
      return editMessage(env, mid, { text: `🗑️ حذف «${esc(b.name)}» (${fmtDa(b.amount)} · ${PERIOD_LABEL[b.period]})؟\nلن يصلك تذكير به بعد الآن.`, markup: { inline_keyboard: [[{ text: 'نعم، احذفه', callback_data: `bl|dy|${id}` }, { text: 'لا', callback_data: `bl|dn|${id}` }]] } });
    }
    await notion(env, 'PATCH', `pages/${id}`, { in_trash: true });
    await answer(env, cb.id, 'حُذف');
    const v = await billsView(env);
    return editMessage(env, mid, { text: `✅ حُذف «${esc(b.name)}».\n\n${v.text}`, markup: v.markup });
  }
  const b = budgetItem(await notion(env, 'GET', `pages/${id}`));
  const key = `bill:${id}:${today.slice(0, 7)}`, ttl = { expirationTtl: 40 * 24 * 3600 };
  if (act === 'snz' || act === 'tmr') {
    await env.STATE.put(key, addDays(today, act === 'snz' ? 3 : 1), ttl);
    await answer(env, cb.id, 'سأذكّرك');
    return editMessage(env, mid, { text: `⏰ سأذكّرك بـ«${esc(b.name)}» ${act === 'snz' ? 'بعد 3 أيام' : 'غدًا'}.`, markup: NO_BUTTONS });
  }
  if (act === 'skip') {
    await env.STATE.put(key, 'done', ttl);
    await answer(env, cb.id);
    return editMessage(env, mid, { text: `🚫 لا تذكير بـ«${esc(b.name)}» هذا الشهر.`, markup: NO_BUTTONS });
  }
  await answer(env, cb.id);
  await env.STATE.put(key, 'done', ttl);
  if (act === 'out') await notion(env, 'PATCH', `pages/${id}`, { properties: { 'آخر دفع': { date: { start: today } } } });
  const kind = act === 'in' ? 'income' : 'expense';
  const cat = kind === 'income' ? (/راتب|أجر|اجر/.test(b.name) ? 'راتب' : 'عمل حر') : (guessCat('expense', b.name) || 'فواتير');
  return saveMoney(env, { kind, amount: b.amount, desc: b.name, mid }, cat);
}

// ── 📉 التحليل الشهري: الشهر (offset) مقارنةً بالذي قبله، محسوبًا محليًا
async function monthRows(env, first) {
  const next = addMonths(first, 1);
  const rows = await queryAll(env, FIN.ds, { and: [
    { property: FIN.date, date: { on_or_after: first } }, { property: FIN.date, date: { before: next } },
  ] });
  const t = { expense: 0, income: 0, byCat: {}, items: [] };
  for (const r of rows) {
    const p = r.properties, n = p[FIN.amount]?.number || 0, type = p[FIN.type]?.select?.name;
    if (type === 'مصروف') {
      t.expense += n;
      const c = p[FIN.cat]?.select?.name || 'أخرى';
      t.byCat[c] = (t.byCat[c] || 0) + n;
      t.items.push([plainText(p[FIN.title]), n]);
    } else if (type === 'دخل') t.income += n;
  }
  t.items.sort((a, b) => b[1] - a[1]);
  return t;
}

export async function monthAnalysis(env, now, offset = -1) {
  const today = localDate(now, env.TZ_NAME);
  const first = addMonths(today.slice(0, 8) + '01', offset), prevFirst = addMonths(first, -1);
  const [cur, prev, budget] = await Promise.all([monthRows(env, first), monthRows(env, prevFirst), queryAll(env, DS.budget, null).catch(() => [])]);
  const budgetOut = budget.map(budgetItem).filter(b => b.type === 'مصروف ثابت').reduce((a, b) => a + b.amount, 0);
  const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
  const sign = n => n > 0 ? `+${n}%` : `${n}%`;
  const lines = [`📉 <b>تحليل ${esc(MONTH_NAME(first))}</b>${offset === 0 ? ' <i>(حتى اليوم)</i>' : ''}`, ''];
  if (!cur.expense && !cur.income) return lines.concat('لا قيود مالية مسجّلة في هذا الشهر.').join('\n');
  const dExp = pct(cur.expense, prev.expense);
  lines.push(`💸 المصاريف: <b>${fmtDa(cur.expense)}</b>${dExp !== null ? ` (${sign(dExp)} عن ${esc(MONTH_NAME(prevFirst))})` : ''}`);
  if (budgetOut) lines.push(`${cur.expense > budgetOut ? '⚠️' : '✅'} الميزانية: ${fmtDa(budgetOut)} — ${cur.expense > budgetOut ? `تجاوزتها بـ ${fmtDa(cur.expense - budgetOut)}` : `بقي ${fmtDa(budgetOut - cur.expense)}`}`);
  lines.push(`💵 الدخل: <b>${fmtDa(cur.income)}</b>`);
  if (cur.income) {
    const saved = cur.income - cur.expense;
    lines.push(`${saved >= 0 ? '🟢' : '🔴'} ${saved >= 0 ? 'الادخار' : 'العجز'}: ${fmtDa(Math.abs(saved))} (${Math.round(Math.abs(saved) / cur.income * 100)}% من الدخل)`);
  }
  // الفئات التي تغيّرت بوضوح (≥ 20% و≥ 2000 دج)
  const cats = [...new Set([...Object.keys(cur.byCat), ...Object.keys(prev.byCat)])]
    .map(c => ({ c, a: cur.byCat[c] || 0, b: prev.byCat[c] || 0 }))
    .filter(x => Math.abs(x.a - x.b) >= 2000 && (!x.b || Math.abs(x.a - x.b) / x.b >= 0.2))
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b)).slice(0, 4);
  if (cats.length) {
    lines.push('', '<b>أبرز التغيّرات:</b>');
    for (const x of cats) lines.push(`${x.a > x.b ? '📈' : '📉'} ${esc(x.c)}: ${fmtDa(x.a)}${x.b ? ` (${sign(pct(x.a, x.b))})` : ' (جديدة)'}`);
  }
  const top = Object.entries(cur.byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length) lines.push('', `<b>أكبر الفئات:</b> ${top.map(([c, n]) => `${esc(c)} ${Math.round(n / cur.expense * 100)}%`).join(' · ')}`);
  if (cur.items.length) lines.push(`<b>أكبر المصاريف:</b> ${cur.items.slice(0, 3).map(([t, n]) => `${esc(t)} (${fmtDa(n)})`).join('، ')}`);
  const up = cats.find(x => x.a > x.b);
  if (up) lines.push('', `💡 <i>أكبر زيادة في «${esc(up.c)}» — راجعها إن أردت تخفيض مصاريف الشهر القادم.</i>`);
  return lines.join('\n');
}
