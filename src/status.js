import { notion, tg } from './api.js';
import { DAY, HOUR, SOURCES } from './core.js';
import { driveCall } from './diary.js';
import { geminiKey } from './settings.js';
import { hijriText } from './spirit.js';
import { localDate } from './time.js';
import { esc } from './view.js';

// ───────────────────────── 🩺 حالة البوت ─────────────────────────
//
// /status أو ⚙️ ← «🩺 حالة البوت»: فحص حيّ لـ Notion وتلغرام وGemini وDrive، ومتى عمل التشغيل الدوري آخر مرة
// (KV «lastrun» يُحدَّث كل 30 دقيقة على الأكثر توفيرًا لحصة الكتابة)، وآخر عطل، والإصدار المنشور.

export const ago = ms => ms < 60e3 ? 'الآن' : ms < HOUR ? `منذ ${Math.round(ms / 60e3)} دقيقة` : ms < DAY ? `منذ ${Math.round(ms / HOUR)} ساعة` : `منذ ${Math.round(ms / DAY)} يوم`;

export async function statusView(env) {
  const now = Date.now();
  const timed = async (label, fn) => {
    const t = Date.now();
    try { const extra = await fn(); return `✅ ${label}${extra ? ` — ${esc(extra)}` : ''} <i>(${Date.now() - t} ms)</i>`; }
    catch (e) { return `❌ ${label}: <code>${esc(String(e.message).slice(0, 150))}</code>`; }
  };
  const [n, t, g, d, lastrun, lastErr] = await Promise.all([
    timed('Notion', () => notion(env, 'POST', `data_sources/${SOURCES.task.ds}/query`, { page_size: 1 }).then(() => '')),
    timed('تلغرام', async () => {
      const i = await tg(env, 'getWebhookInfo', {});
      if (i?.last_error_date && now / 1000 - i.last_error_date < 24 * 3600) throw new Error(i.last_error_message);
      return i?.pending_update_count ? `${i.pending_update_count} رسالة في الانتظار` : '';
    }),
    (async () => {
      const k = await geminiKey(env);
      if (!k) return '⚪ Gemini: لا مفتاح (الصوت والأسئلة والوثائق معطّلة)';
      return timed('Gemini', async () => {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': k } });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || `HTTP ${r.status}`);
        return (await env.STATE.get('gemini_models', 'json'))?.[0] || '';
      });
    })(),
    (async () => {
      const dr = await env.STATE.get('drive', 'json');
      if (!dr) return '⚪ Google Drive: غير مربوط';
      return timed('Google Drive', () => driveCall(env, dr, 'ping').then(r => r.folder));
    })(),
    env.STATE.get('lastrun'),
    env.STATE.get('last_err', 'json'),
  ]);
  const run = Number(lastrun);
  const lines = ['🩺 <b>حالة البوت</b>', '', n, t, g, d, '',
    !run ? '⚪ التشغيل الدوري: لا بيانات بعد'
      : now - run < 35 * 60e3 ? '✅ التشغيل الدوري يعمل (كل دقيقة)'
      : `❌ التشغيل الدوري متوقف — آخر تشغيل ${ago(now - run)}`,
    lastErr ? `⚠️ آخر عطل (${ago(now - lastErr.at)}): ${esc(lastErr.where)}\n<code>${esc(lastErr.msg)}</code>` : '✅ لا أعطال في آخر 7 أيام',
  ];
  const hToday = hijriText(localDate(now, env.TZ_NAME), env);
  lines.push(hToday ? `📅 التقويم الهجري: ${esc(hToday)}` : '⚠️ التقويم الهجري غير متاح في بيئة التشغيل (رمضان يعتمد على سؤال الرؤية فقط)');
  if (env.GIT_SHA) lines.push(`🏷️ الإصدار: <code>${esc(env.GIT_SHA)}</code>`);
  return { text: lines.join('\n'), markup: { inline_keyboard: [[{ text: '🔄 تحديث', callback_data: 'st|status' }]] } };
}
