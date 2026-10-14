import { rt } from './core.js';

// ───────────────────────── واجهات API ─────────────────────────

// عطل مؤقت من جهة الخدمة (ازدحام، مهلة، انقطاع): لا يُبلَّغ عنه إلا إن استمر (reportError)
export const transientError = msg => Object.assign(new Error(msg), { transient: true });
export const isRetryable = status => status === 429 || (status >= 500 && status !== 524);

export async function notion(env, method, path, body) {
  // القراءة والاستعلام تُعاد مرة عند الازدحام؛ الكتابة لا (قد تكون نُفّذت رغم الخطأ). مهلة 524 لا تُعاد (تستغرق ~100 ث)
  const safe = method === 'GET' || /\/query$/.test(path);
  for (let attempt = 0; ; attempt++) {
    rt.subreq++;
    let res, text;
    try {
      res = await fetch(`https://api.notion.com/v1/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2025-09-03',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      text = await res.text();
    } catch (e) {
      if (safe && attempt === 0) continue;
      throw transientError(`Notion: تعذّر الاتصال (${e.message})`);
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* صفحة خطأ HTML/نص من Cloudflare */ }
    if (res.ok && json) return json;
    if (safe && attempt === 0 && isRetryable(res.status)) continue;
    const msg = json?.message || (res.status === 524 ? 'انتهت مهلة خادم Notion' : res.status >= 500 ? 'خادم Notion لا يستجيب' : String(text).slice(0, 80).trim());
    const err = new Error(`Notion ${res.status}: ${msg}`);
    if (res.status === 429 || res.status >= 500 || !json) err.transient = true;
    throw err;
  }
}

export async function tg(env, method, body) {
  rt.subreq++;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!json.ok && (res.status === 429 || res.status >= 500)) throw transientError(`Telegram ${method}: ${json.description}`);
  // تعديل رسالة بنفس محتواها ليس خطأً حقيقيًا
  if (!json.ok && !/message is not modified|message to edit not found/.test(json.description)) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

export const answer = (env, id, text) => tg(env, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });

// سرّ الـ webhook مشتق من توكن البوت (نفس الحساب في deploy.yml) فلا حاجة لسرّ إضافي
export async function webhookSecret(env) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 64);
}
