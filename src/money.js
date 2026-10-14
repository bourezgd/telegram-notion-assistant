import { subscriptionLine, touchSubscription } from './bills.js';
import { answer, notion, tg } from './api.js';
import { DRAFT_TTL_S, DS } from './core.js';
import { dropDraft, getDraft, say, toLatin } from './messages.js';
import { localDate } from './time.js';
import { NO_BUTTONS, editMessage, esc, plainText } from './view.js';

// ───────────────────────── المصاريف ─────────────────────────
//
// «💸 إنفاق» / «💵 قبض» (مع أزرار الرواتب الجاهزة من الميزانية) أو نص مثل «مصروف 1500 بنزين» / «دفعت 3000 كهرباء» / «دخل 50000 راتب»:
// يُقترح تصنيف (⭐) من الكلمات ← ضغطة لاختيار الفئة ← يُسجَّل في «💰 المالية» بتاريخ اليوم،
// مع ملخص الشهر مقابل «📋 الميزانية الشهرية»، وزرّين: تبديل شخصي/منزلي، و↩️ تراجع.
// «/money» أو «المصاريف»: ملخص الشهر كاملًا. callback: fx|<فعل>|<قيمة>

export const FIN = { get ds() { return DS.finance; }, title: 'البيان', amount: 'المبلغ (دج)', type: 'النوع', cat: 'الفئة', acc: 'الحساب', date: 'التاريخ' };
export const SPEND_BTN = '💸 إنفاق', EARN_BTN = '💵 قبض';
export const EXPENSE_CATS = ['تغذية', 'نقل', 'فواتير', 'كراء', 'صحة', 'تعليم', 'ملابس', 'ترفيه', 'صدقة/زكاة', 'أخرى'];
export const INCOME_CATS = ['راتب', 'عمل حر', 'أخرى'];
export const HOME_CATS = ['تغذية', 'فواتير', 'كراء'];
export const CAT_WORDS = {
  'نقل': 'بنزين وقود مازوت ليصانص طاكسي تاكسي نقل ترامواي تراموي ميترو باص حافلة سيارة تصليح ميكانيك باركينغ طريق كلوندستان',
  'تغذية': 'أكل اكل خبز حليب خضر خضرة فواكه لحم دجاج سمك سوق مشتريات بقالة حانوت مطعم قهوة غداء عشاء فطور سوبيرات سوبرماركت ماء معدني',
  'فواتير': 'كهرباء غاز سونلغاز انترنت إنترنت هاتف فليكسي رصيد اشتراك فاتورة اتصالات موبيليس جيزي أوريدو اوريدو نتفليكس ويفي',
  'كراء': 'كراء إيجار ايجار',
  'صحة': 'دواء أدوية صيدلية طبيب تحاليل أسنان اسنان مستشفى عيادة نظارات',
  'تعليم': 'كتاب كتب دورة مدرسة دروس تكوين روضة أدوات',
  'ملابس': 'ملابس حذاء سروال قميص لباس جاكيت',
  'ترفيه': 'نزهة خرجة سفر هدية ألعاب العاب سينما عطلة',
  'صدقة/زكاة': 'صدقة زكاة تبرع',
};
export const fmtDa = n => `${Math.round(n).toLocaleString('en-US')} دج`;

// «1500» «1,500» «1.500» «5 آلاف» «5k» (بأرقام عربية أيضًا) ← رقم
export function parseAmount(s) {
  const m = toLatin(s).match(/^(\d[\d.,]*)\s*(k|ك|ألف|الف|آلاف|الاف)?\s*(دج|da|دينار)?$/i);
  if (!m) return null;
  let n = Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  if (m[2]) n *= 1000;
  return n > 0 && n < 1e9 ? Math.round(n) : null;
}

// «[مصروف|دفعت|دخل…] 1500 [دج] البيان» ← { kind, amount, desc } أو null
export function parseMoneyText(text) {
  const m = toLatin(text).trim().match(/^(?:(مصروف|مصاريف|صرفت|دفعت|اشتريت|شريت|دخل|قبضت|مدخول)\s+)?(\d[\d.,]*\s*(?:k|ك|ألف|الف|آلاف|الاف)?\s*(?:دج|da|دينار)?)\s+(.+)$/i);
  if (!m) return null;
  const amount = parseAmount(m[2].trim());
  if (!amount) return null;
  return { kind: /^(دخل|قبضت|مدخول)$/.test(m[1] || '') ? 'income' : 'expense', amount, desc: m[3].trim().slice(0, 120), explicit: !!m[1] };
}

export function guessCat(kind, desc) {
  if (kind === 'income') return /راتب|أجر|اجر/.test(desc) ? 'راتب' : 'عمل حر';
  const words = desc.split(/\s+/);
  for (const [cat, list] of Object.entries(CAT_WORDS)) {
    const keys = list.split(' ');
    if (words.some(w => keys.some(k => w === k || w.replace(/^(ال|و|ب|ل)/, '') === k.replace(/^ال/, '')))) return cat;
  }
  return 'أخرى';
}

export const getFDraft = async env => (await env.STATE.get('fdraft', 'json')) || null;
export const putFDraft = (env, d) => env.STATE.put('fdraft', JSON.stringify(d), { expirationTtl: DRAFT_TTL_S });

export function catButtons(d) {
  const cats = d.kind === 'income' ? INCOME_CATS : EXPENSE_CATS;
  const guess = guessCat(d.kind, d.desc);
  const ordered = [guess, ...cats.filter(c => c !== guess)];
  const btns = ordered.map(c => ({ text: c === guess ? `⭐ ${c}` : c, callback_data: `fx|c|${cats.indexOf(c)}` }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 3) rows.push(btns.slice(i, i + 3));
  rows.push([{ text: d.kind === 'income' ? '💸 بل مصروف' : '💵 بل دخل', callback_data: 'fx|k|0' }, { text: '✖️ إلغاء', callback_data: 'fx|x|0' }]);
  return { inline_keyboard: rows };
}
export const draftLine = d => `${d.kind === 'income' ? '💵 دخل' : '💸 مصروف'}: <b>${fmtDa(d.amount)}</b> — ${esc(d.desc)}`;

// بداية التسجيل: mid = رسالة موجودة نعدّلها (من اقتراح الإضافة) أو رسالة جديدة
export async function startMoney(env, parsed, mid) {
  const d = { ...parsed, step: 'cat' };
  const v = { text: `${draftLine(d)}\n\n🏷️ <b>الفئة؟</b>`, markup: catButtons(d) };
  if (mid) { d.mid = mid; await editMessage(env, mid, v); } else d.mid = (await say(env, v.text, v.markup)).message_id;
  await putFDraft(env, d);
  await dropDraft(env); // لا تتعارض مع مسودة إضافة مهمة
}

export async function askMoney(env, kind) {
  const d = { step: 'amount', kind, quick: [] };
  const rows = [];
  if (kind === 'income') {
    // دخول الميزانية المتوقّعة (الرواتب) كأزرار جاهزة بضغطة واحدة
    const budget = await queryAll(env, DS.budget, null).catch(() => []);
    d.quick = budget.filter(b => b.properties['النوع']?.select?.name === 'دخل')
      .map(b => [plainText(b.properties['البند']), b.properties['المبلغ (دج)']?.number || 0]).filter(q => q[1] > 0).slice(0, 8);
    d.quick.forEach(([name, n], i) => rows.push([{ text: `${name} · ${fmtDa(n)}`, callback_data: `fx|q|${i}` }]));
    rows.push([{ text: '💼 فريلانس', callback_data: 'fx|fl|0' }]);
  }
  rows.push([{ text: '✖️ إلغاء', callback_data: 'fx|x|0' }]);
  const text = kind === 'income'
    ? `💵 <b>قبض مال</b>\n${d.quick.length ? 'اختر أحد الرواتب بالأسفل، أو ' : ''}اكتب <b>المبلغ والبيان</b>، مثل:\n<code>20000 مشروع مونتاج</code>`
    : '💸 <b>إنفاق مال</b>\nاكتب <b>المبلغ والبيان</b>، مثل:\n<code>1500 بنزين</code> · <code>3000 كهرباء</code> · <code>5 آلاف سوق</code>';
  d.mid = (await say(env, text, { inline_keyboard: rows })).message_id;
  await putFDraft(env, d);
}

export async function onMoneyButton(cb, env) {
  if (String(cb.message?.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return answer(env, cb.id, 'غير مسموح');
  const [, act, val] = String(cb.data).split('|');
  const mid = cb.message.message_id;

  // أزرار ما بعد الحفظ (تعمل في أي وقت)
  if (act === 'acc' || act === 'del') {
    if (!/^[0-9a-f]{32}$/.test(val)) return answer(env, cb.id, 'زر غير صالح');
    if (act === 'del') {
      await notion(env, 'PATCH', `pages/${val}`, { in_trash: true });
      await answer(env, cb.id, 'حُذف القيد');
      return editMessage(env, mid, { text: '↩️ <b>أُلغي التسجيل</b>', markup: NO_BUTTONS });
    }
    const page = await notion(env, 'GET', `pages/${val}`);
    const acc = page.properties[FIN.acc]?.select?.name === 'منزلي' ? 'شخصي' : 'منزلي';
    await notion(env, 'PATCH', `pages/${val}`, { properties: { [FIN.acc]: { select: { name: acc } } } });
    await answer(env, cb.id, `الحساب: ${acc}`);
    return editMessage(env, mid, await savedView(env, val, page, acc));
  }
  // تحويل اقتراح «أضف كـ…» إلى مصروف
  if (act === 'from') {
    const d = await getDraft(env);
    const parsed = d?.title && parseMoneyText(d.title);
    await answer(env, cb.id);
    if (!parsed) return editMessage(env, mid, { text: '⚠️ لم أجد مبلغًا في النص.', markup: NO_BUTTONS });
    return startMoney(env, parsed, mid);
  }

  const d = await getFDraft(env);
  if (!d || d.mid !== mid) {
    await answer(env, cb.id, 'انتهى هذا التسجيل');
    return tg(env, 'editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: mid, reply_markup: NO_BUTTONS });
  }
  await answer(env, cb.id);
  if (act === 'x') {
    await env.STATE.delete('fdraft');
    return editMessage(env, mid, { text: '✖️ أُلغي التسجيل.', markup: NO_BUTTONS });
  }
  if (act === 'k') {
    d.kind = d.kind === 'income' ? 'expense' : 'income';
    await putFDraft(env, d);
    return editMessage(env, mid, { text: `${draftLine(d)}\n\n🏷️ <b>الفئة؟</b>`, markup: catButtons(d) });
  }
  if (act === 'fl') {
    Object.assign(d, { kind: 'income', step: 'fl_name' });
    await putFDraft(env, d);
    return editMessage(env, mid, {
      text: '💼 <b>فريلانس</b>\nاكتب <b>اسم الفريلانس</b> (العميل أو المشروع)، مثل: <code>مونتاج إعلان لشركة النور</code>\n<i>ويمكنك إضافة المبلغ في نفس الرسالة: <code>مونتاج إعلان 15000</code></i>',
      markup: { inline_keyboard: [[{ text: '✖️ إلغاء', callback_data: 'fx|x|0' }]] },
    });
  }
  if (act === 'q') {
    const q = d.quick?.[Number(val)];
    if (!q) return;
    Object.assign(d, { kind: 'income', desc: q[0], amount: q[1] });
    return saveMoney(env, d, /راتب|أجر|اجر/.test(q[0]) ? 'راتب' : 'عمل حر');
  }
  if (act === 'c') {
    return saveMoney(env, d, (d.kind === 'income' ? INCOME_CATS : EXPENSE_CATS)[Number(val)] || 'أخرى');
  }
}

export async function saveMoney(env, d, cat) {
  const acc = d.kind === 'expense' && HOME_CATS.includes(cat) ? 'منزلي' : 'شخصي';
  const page = await notion(env, 'POST', 'pages', {
    parent: { type: 'data_source_id', data_source_id: FIN.ds },
    properties: {
      [FIN.title]: { title: [{ type: 'text', text: { content: d.desc } }] },
      [FIN.amount]: { number: d.amount },
      [FIN.type]: { select: { name: d.kind === 'income' ? 'دخل' : 'مصروف' } },
      [FIN.cat]: { select: { name: cat } },
      [FIN.acc]: { select: { name: acc } },
      [FIN.date]: { date: { start: d.date || localDate(Date.now(), env.TZ_NAME) } },
    },
  });
  await env.STATE.delete('fdraft');
  // دفعُ اشتراك/فاتورة دورية معروفة ← يُحدَّث «آخر دفع» فيُحسب التذكير القادم منه
  const sub = d.kind === 'expense' ? await touchSubscription(env, d.desc, d.date || localDate(Date.now(), env.TZ_NAME)).catch(() => null) : null;
  await editMessage(env, d.mid, await savedView(env, page.id.replace(/-/g, ''), page, acc, sub));
  return page;
}

export async function savedView(env, id, page, acc, sub = null) {
  const p = page.properties;
  const kind = p[FIN.type]?.select?.name === 'دخل' ? 'income' : 'expense';
  const m = await monthTotals(env, Date.now());
  const lines = [
    `✅ <b>سُجّل ${kind === 'income' ? 'الدخل' : 'المصروف'}</b>`,
    `${kind === 'income' ? '💵' : '💸'} ${fmtDa(p[FIN.amount]?.number || 0)} — ${esc(plainText(p[FIN.title]))}`,
    `🏷️ ${esc(p[FIN.cat]?.select?.name || '')} · ${acc === 'منزلي' ? '🏠 منزلي' : '👤 شخصي'}`,
    '',
    kind === 'income' ? incomeLine(m) : monthLine(m),
  ];
  if (sub) lines.push('', subscriptionLine(sub, localDate(Date.now(), env.TZ_NAME)));
  const rows = [[
    { text: acc === 'منزلي' ? '👤 اجعله شخصي' : '🏠 اجعله منزلي', callback_data: `fx|acc|${id}` },
    { text: '↩️ تراجع', callback_data: `fx|del|${id}` },
  ]];
  if (kind === 'expense' && !sub) rows.push([{ text: '🔁 اجعلها دورية (فاتورة/اشتراك)', callback_data: `bl|mk|${id}` }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

// مجاميع الشهر الحالي + الميزانية
export async function monthTotals(env, now) {
  const today = localDate(now, env.TZ_NAME);
  const first = today.slice(0, 8) + '01';
  const [rows, budget] = await Promise.all([
    queryAll(env, FIN.ds, { property: FIN.date, date: { on_or_after: first } }),
    queryAll(env, DS.budget, null).catch(() => []),
  ]);
  const t = { first, today, expense: 0, income: 0, byCat: {}, top: [], budgetOut: 0, budgetIn: 0, weekExpense: 0 };
  for (const r of rows) {
    const p = r.properties, n = p[FIN.amount]?.number || 0, type = p[FIN.type]?.select?.name;
    if (type === 'مصروف') {
      t.expense += n;
      const c = p[FIN.cat]?.select?.name || 'أخرى';
      t.byCat[c] = (t.byCat[c] || 0) + n;
      t.top.push([plainText(p[FIN.title]), n]);
    } else if (type === 'دخل') t.income += n;
  }
  t.top.sort((a, b) => b[1] - a[1]);
  for (const b of budget) {
    const n = b.properties['المبلغ (دج)']?.number || 0, type = b.properties['النوع']?.select?.name;
    if (type === 'مصروف ثابت') t.budgetOut += n; else if (type === 'دخل') t.budgetIn += n;
  }
  return t;
}

export function monthLine(m) {
  const month = new Intl.DateTimeFormat('ar-DZ', { month: 'long', timeZone: 'UTC' }).format(new Date(m.first + 'T12:00:00Z'));
  if (!m.budgetOut) return `📅 مصاريف ${month}: <b>${fmtDa(m.expense)}</b>`;
  const pct = Math.round(m.expense / m.budgetOut * 100);
  const bar = '▓'.repeat(Math.min(10, Math.round(pct / 10))) + '░'.repeat(Math.max(0, 10 - Math.round(pct / 10)));
  return `📅 مصاريف ${month}: <b>${fmtDa(m.expense)}</b> من ${fmtDa(m.budgetOut)} (${pct}%)\n${bar}${pct > 100 ? ' ⚠️ تجاوزت الميزانية' : ''}`;
}

export function incomeLine(m) {
  const month = new Intl.DateTimeFormat('ar-DZ', { month: 'long', timeZone: 'UTC' }).format(new Date(m.first + 'T12:00:00Z'));
  return `📅 دخل ${month}: <b>${fmtDa(m.income)}</b>${m.budgetIn ? ` من ${fmtDa(m.budgetIn)} متوقّع (${Math.round(m.income / m.budgetIn * 100)}%)` : ''}`;
}

export async function moneySummary(env) {
  const m = await monthTotals(env, Date.now());
  const month = new Intl.DateTimeFormat('ar-DZ', { month: 'long', timeZone: 'UTC' }).format(new Date(m.first + 'T12:00:00Z'));
  const lines = [`💰 <b>مالية ${month}</b>`, '', monthLine(m), `💵 الدخل المسجّل: ${fmtDa(m.income)}${m.budgetIn ? ` من ${fmtDa(m.budgetIn)} متوقّع` : ''}`];
  const net = m.income - m.expense;
  lines.push(`${net >= 0 ? '🟢' : '🔴'} الفارق: ${net >= 0 ? '+' : '−'}${fmtDa(Math.abs(net))}`);
  const cats = Object.entries(m.byCat).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    lines.push('', '<b>حسب الفئة:</b>');
    for (const [c, n] of cats) lines.push(`• ${esc(c)}: ${fmtDa(n)} (${Math.round(n / m.expense * 100)}%)`);
  }
  if (m.top.length) {
    lines.push('', '<b>أكبر المصاريف:</b>');
    for (const [t, n] of m.top.slice(0, 3)) lines.push(`• ${esc(t)}: ${fmtDa(n)}`);
  }
  if (!cats.length && !m.income) lines.push('', 'لا قيود هذا الشهر بعد. سجّل بـ <b>💰 مصروف</b> أو اكتب مثلًا <code>مصروف 1500 بنزين</code>.');
  return lines.join('\n');
}

// استعلام بكل الصفحات (مع تجاوز الترقيم)
export async function queryAll(env, ds, filter) {
  const out = [];
  let cursor;
  do {
    const res = await notion(env, 'POST', `data_sources/${ds}/query`, { ...(filter ? { filter } : {}), start_cursor: cursor, page_size: 100 });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}
