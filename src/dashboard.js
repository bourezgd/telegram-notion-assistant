import { queryItems } from './alerts.js';
import { cfg, DAY, DS, SOURCES } from './core.js';
import { WHO_MONTHS, loadGrowth, monthsOld, whoTable } from './growth.js';
import { liveStreak, loadHabits } from './habits.js';
import { FIN, queryAll } from './money.js';
import { PRAYERS, TRACKER } from './prayer.js';
import { MONTH_NAME, monthQuota } from './quota.js';
import { TRK } from './spirit.js';
import { addDays, addMonths, localDate, zonedToUtc } from './time.js';
import { APP_HTML } from './app-page.js';

// ───────────────────────── 📱 لوحتي (تطبيق مصغّر داخل تلغرام) ─────────────────────────
//
// GET /app: صفحة اللوحة (تُفتح من زر القائمة بجانب خانة الكتابة، أو /dashboard).
// GET /app/data: البيانات بصيغة JSON، فقط لمن يحمل initData موقّعة من تلغرام لصاحب البوت (TELEGRAM_CHAT_ID)،
// وتُحفظ في KV عشر دقائق حتى تبقى سريعة وخفيفة على Notion.

const DASH_TTL_MS = 10 * 60e3;

// التحقق من توقيع Telegram WebApp initData (HMAC-SHA256 بمفتاح مشتق من توكن البوت)
export async function verifyInitData(initData, env) {
  const p = new URLSearchParams(initData || '');
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const hmac = async (key, data) => crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), enc.encode(data));
  const secret = await hmac(enc.encode('WebAppData'), env.TELEGRAM_BOT_TOKEN);
  const sig = [...new Uint8Array(await hmac(secret, check))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 24 * 3600) return null;
  let user;
  try { user = JSON.parse(p.get('user') || '{}'); } catch { return null; }
  return String(user.id) === String(env.TELEGRAM_CHAT_ID) ? user : null;
}

// مفتاح اللوحة لزر «📱 لوحتي» في لوحة الأزرار: HMAC ثابت من توكن البوت (يتغيّر إن تغيّر التوكن)
export async function dashKey(env) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TELEGRAM_BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('dashboard-key-v1')))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function dashData(env, now = Date.now()) {
  const cached = await env.STATE.get('dash', 'json');
  if (cached && now - cached.at < DASH_TTL_MS && now >= cached.at) return cached.data;
  const tz = env.TZ_NAME, today = localDate(now, tz), first = today.slice(0, 8) + '01', from6 = addMonths(first, -5);
  const utc = d => new Date(zonedToUtc(d, '00:00', tz)).toISOString();
  const [fin, budget, tasks, tracker, quota, habits, growth] = await Promise.all([
    queryAll(env, FIN.ds, { property: FIN.date, date: { on_or_after: from6 } }).catch(() => []),
    queryAll(env, DS.budget, null).catch(() => []),
    queryItems(env, 'task', { and: [
      { property: SOURCES.task.date, date: { on_or_after: utc(addDays(today, -27)) } },
      { property: SOURCES.task.date, date: { before: new Date(Date.parse(utc(today)) + DAY).toISOString() } },
    ] }).catch(() => []),
    queryAll(env, TRACKER.ds, { property: TRACKER.date, date: { on_or_after: addDays(today, -29) } }).catch(() => []),
    monthQuota(env, now, 0).catch(() => null),
    loadHabits(env).catch(() => []),
    loadGrowth(env).catch(() => []),
  ]);

  // المال: 6 أشهر (دخل/مصاريف) وفئات الشهر الجاري
  const months = [...Array(6)].map((_, i) => { const m = addMonths(from6, i); return { key: m.slice(0, 7), label: MONTH_NAME(m), expense: 0, income: 0 }; });
  const byCat = {};
  for (const r of fin) {
    const p = r.properties, d = (p[FIN.date]?.date?.start || '').slice(0, 7), n = p[FIN.amount]?.number || 0, type = p[FIN.type]?.select?.name;
    const m = months.find(x => x.key === d);
    if (!m) continue;
    if (type === 'مصروف') { m.expense += n; if (d === today.slice(0, 7)) { const c = p[FIN.cat]?.select?.name || 'أخرى'; byCat[c] = (byCat[c] || 0) + n; } }
    else if (type === 'دخل') m.income += n;
  }
  const budgetOut = budget.filter(b => b.properties['النوع']?.select?.name === 'مصروف ثابت').reduce((a, b) => a + (b.properties['المبلغ (دج)']?.number || 0), 0);

  // المهام: نسبة الإنجاز لآخر 4 أسابيع (7 أيام تنتهي اليوم)، بما حلّ موعده فقط
  const weeks = [3, 2, 1, 0].map(w => {
    const a = addDays(today, -7 * w - 6), b = addDays(today, -7 * w);
    const list = tasks.filter(i => i.localDate >= a && i.localDate <= b && (i.alertAt <= now || SOURCES.task.closed.includes(i.status)) && i.status !== SOURCES.task.cancelled);
    return { from: a, to: b, done: list.filter(i => i.status === SOURCES.task.done).length, total: list.length };
  });

  // العبادات: آخر 30 يومًا
  const rows = Object.fromEntries(tracker.map(r => [(r.properties[TRACKER.date]?.date?.start || '').slice(0, 10), r.properties]));
  const days = [...Array(30)].map((_, i) => {
    const date = addDays(today, i - 29), p = rows[date];
    return { date, prayers: p ? PRAYERS.filter(x => p[x.name]?.checkbox).length : 0, am: !!p?.[TRK.am]?.checkbox, pm: !!p?.[TRK.pm]?.checkbox, wird: p?.[TRK.wird]?.number || 0 };
  });

  const birth = cfg.birth;
  const data = {
    today, monthLabel: MONTH_NAME(first), child: cfg.child,
    money: { months, byCat: Object.entries(byCat).sort((a, b) => b[1] - a[1]), budgetOut },
    weeks, days,
    quota: (quota?.groups || []).map(g => ({ name: g.name, done: g.done, planned: g.planned, due: g.due })),
    habits: habits.filter(h => h.active).map(h => ({ name: h.name, streak: liveStreak(h, today), best: h.best, doneToday: h.last === today })),
    growth: birth && cfg.child ? {
      points: growth.map(r => ({ m: monthsOld(birth, r.date), weight: r.weight, height: r.height })),
      who: WHO_MONTHS.map((m, i) => ({ m, weight: whoTable('weight')[i], height: whoTable('height')[i] })),
    } : null,
  };
  await env.STATE.put('dash', JSON.stringify({ at: now, data }));
  return data;
}

export async function handleApp(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/app') {
    return new Response(APP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (url.pathname === '/app/data') {
    const k = request.headers.get('X-Dash-Key');
    const ok = (k && k === await dashKey(env)) || await verifyInitData(request.headers.get('X-Init-Data'), env);
    if (!ok) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    const data = await dashData(env);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  return null;
}
