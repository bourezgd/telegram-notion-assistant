// بيئة اختبار: Notion وتلغرام وGemini وKV مزيّفة في الذاكرة، مع ساعة يمكن التحكم بها.
// تُستعمل من ملفات *.test.mjs عبر `npm test` (node --test)، ولا تتصل بأي خدمة حقيقية.

import worker from '../src/worker.js';

export const DS = {
  task: '00000000-0000-4000-8000-000000000001',
  reminder: '00000000-0000-4000-8000-000000000002',
  idea: '00000000-0000-4000-8000-000000000003',
  health: '00000000-0000-4000-8000-000000000004',
  tracker: '00000000-0000-4000-8000-000000000005',
  fin: '00000000-0000-4000-8000-000000000006',
  budget: '00000000-0000-4000-8000-000000000007',
  events: '00000000-0000-4000-8000-000000000008',
  jihat: '00000000-0000-4000-8000-000000000009',
  nour: '00000000-0000-4000-8000-000000000010',
  habits: '00000000-0000-4000-8000-000000000011',
  growth: '00000000-0000-4000-8000-000000000012',
};

// ── بناء قيم الخصائص بصيغة ردود Notion
export const P = {
  title: t => ({ type: 'title', title: [{ plain_text: t }] }),
  text: t => ({ type: 'rich_text', rich_text: t ? [{ plain_text: t }] : [] }),
  select: n => ({ type: 'select', select: n ? { name: n } : null }),
  date: (start, end = null) => ({ type: 'date', date: { start, end } }),
  check: v => ({ type: 'checkbox', checkbox: v }),
  num: n => ({ type: 'number', number: n }),
  rel: ids => ({ type: 'relation', relation: ids.map(id => ({ id })) }),
  url: u => ({ type: 'url', url: u }),
};

const toMs = v => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v);
function cmpDate(value, c) {
  const t = toMs(value);
  if ('equals' in c) return String(value).slice(0, 10) === c.equals;
  if ('on_or_after' in c && !(t >= toMs(c.on_or_after))) return false;
  if ('on_or_before' in c && !(t <= toMs(c.on_or_before))) return false;
  if ('before' in c && !(t < toMs(c.before))) return false;
  if ('after' in c && !(t > toMs(c.after))) return false;
  return true;
}

export function createWorld({ now = '2026-09-25T10:00:00Z', geminiKey } = {}) {
  const w = {
    now: Date.parse(now),
    pages: {},           // id → { ds, props, created, edited, trash }
    sent: [],            // كل نداءات تلغرام
    kv: {},
    gemini: null,        // دالة (body) → { status, json } لمحاكاة Gemini
    notionDown: false,
    nextMid: 1000,
    nextId: 1,
    // Google Drive المزيّف (كود Apps Script): ملفات المجلد وكلمة السرّ المسجّلة وكل الطلبات
    drive: { secret: null, files: [], calls: [], taken: null },
  };
  const realNow = Date.now;
  Date.now = () => w.now;
  w.restore = () => { Date.now = realNow; };

  // ── تحويل خصائص طلب الكتابة إلى صيغة الرد
  function fromRequest(props) {
    const out = {};
    for (const [k, v] of Object.entries(props)) {
      if (v.title) out[k] = { type: 'title', title: v.title.map(x => ({ plain_text: x.text.content })) };
      else if (v.rich_text) out[k] = { type: 'rich_text', rich_text: v.rich_text.map(x => ({ plain_text: x.text.content })) };
      else if ('select' in v) out[k] = P.select(v.select?.name);
      else if ('checkbox' in v) out[k] = P.check(v.checkbox);
      else if ('number' in v) out[k] = P.num(v.number);
      else if (v.relation) out[k] = P.rel(v.relation.map(r => r.id));
      else if ('url' in v) out[k] = P.url(v.url);
      else if (v.multi_select) out[k] = { type: 'multi_select', multi_select: v.multi_select };
      else if (v.date) {
        const { start, end, time_zone } = v.date;
        // الجزائر +01:00 دائمًا (بلا توقيت صيفي)
        out[k] = P.date(time_zone ? `${start}.000+01:00` : start, end ?? null);
      }
    }
    return out;
  }
  function match(page, f) {
    if (!f) return true;
    if (f.and) return f.and.every(x => match(page, x));
    if (f.or) return f.or.some(x => match(page, x));
    if (f.timestamp) return cmpDate(new Date(f.timestamp === 'created_time' ? page.created : page.edited).toISOString(), f[f.timestamp]);
    const p = page.props[f.property];
    if (f.date) return !!p?.date?.start && cmpDate(p.date.start, f.date);
    if (f.select) {
      const v = p?.select?.name ?? null;
      if ('does_not_equal' in f.select) return v !== f.select.does_not_equal;
      if ('equals' in f.select) return v === f.select.equals;
    }
    if (f.checkbox) return (p?.checkbox === true) === f.checkbox.equals;
    return true;
  }
  const api = id => ({ id, url: `https://notion.so/${id}`, in_trash: !!w.pages[id].trash, properties: w.pages[id].props });

  w.add = (kind, props) => {
    const id = (w.nextId++).toString(16).padStart(32, '0');
    w.pages[id] = { ds: DS[kind], kind, props, created: w.now, edited: w.now };
    return id;
  };
  w.edit = (id, props) => { Object.assign(w.pages[id].props, props); w.pages[id].edited = w.now; };
  w.of = kind => Object.entries(w.pages).filter(([, p]) => p.kind === kind && !p.trash).map(([id, p]) => ({ id, ...p }));

  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const res = (status, json, headers = {}) => ({
      ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json),
      headers: { get: k => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => new ArrayBuffer(8),
    });
    // Apps Script الحقيقي: POST على /exec ← 302 إلى googleusercontent، والرد يُقرأ بـ GET فقط
    if (url.startsWith('https://script.google.com/')) {
      if (opts.redirect !== 'manual') return { ok: true, status: 200, text: async () => '<html><title>Error</title></html>', json: async () => { throw new Error('html'); }, headers: { get: () => null } };
      w.drive.pending = body;
      return res(302, null, { location: 'https://script.googleusercontent.com/macros/echo?user_content_key=k' });
    }
    if (url.startsWith('https://script.googleusercontent.com/')) {
      if ((opts.method || 'GET') !== 'GET') return { ok: false, status: 405, text: async () => '<html><title>Page Not Found</title></html>', headers: { get: () => null } };
      return driveReply(w.drive.pending);
    }
    if (url.startsWith('https://api.open-meteo.com/')) {
      w.weatherCalls = (w.weatherCalls || 0) + 1;
      return res(200, { daily: { weather_code: [61], temperature_2m_min: [14.6], temperature_2m_max: [23.2], precipitation_probability_max: [70] } });
    }
    if (url.includes('api.telegram.org/file/')) return res(200, {});
    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop();
      w.sent.push({ method, ...body });
      const result = method === 'getFile' ? { file_path: 'photos/file_7.jpg' } : { message_id: ++w.nextMid };
      return res(200, { ok: true, result });
    }
    function driveReply(body) {
      const d = w.drive;
      d.calls.push(body);
      if (!d.secret && body.action === 'ping') d.secret = body.secret;
      if (body.secret !== d.secret) return res(200, { ok: false, error: 'unauthorized' });
      if (body.action === 'ping') return res(200, { ok: true, folder: 'صور مريم', folderUrl: 'https://drive.google.com/drive/folders/F' });
      if (body.action === 'upload') {
        const f = { id: `d${d.files.length + 1}`, name: body.name, url: `https://drive.google.com/file/d/d${d.files.length + 1}/view`, marked: true, taken: d.taken, created: new Date(w.now).toISOString(), from: body.fileUrl };
        d.files.push(f);
        return res(200, { ok: true, id: f.id, url: f.url, taken: f.taken });
      }
      if (body.action === 'scan') {
        const open = d.files.filter(f => !f.marked);
        return res(200, { ok: true, files: open.slice(0, body.limit).map(({ id, name, url, taken, created }) => ({ id, name, url, taken, created })), more: open.length > body.limit });
      }
      if (body.action === 'mark') { for (const id of body.ids) d.files.find(f => f.id === id).marked = true; return res(200, { ok: true }); }
    }
    if (url.includes('generativelanguage')) {
      if (url.includes('/models?')) {
        const ok = opts.headers?.['x-goog-api-key'] === (geminiKey || 'good-key');
        return ok ? res(200, { models: [{ name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }] })
          : res(400, { error: { message: 'API key not valid' } });
      }
      return w.gemini(body);
    }
    if (url.includes('api.notion.com')) {
      w.notionCalls = (w.notionCalls || 0) + 1;
      // Notion بطيء (مهلة 524 تستغرق ~100 ث): كل طلب يُكمل بعد notionLatency من الساعة المزيّفة،
      // فتتداخل تشغيلات الدقائق المتتالية كما في الواقع (راجع w.advance)
      if (w.notionLatency) await new Promise(r => w.waiters.push({ t: w.now + w.notionLatency, r }));
      // صفحة مهلة Cloudflare أمام Notion (ليست JSON)
      if (w.notionDown === 524) return { ok: false, status: 524, text: async () => 'error code: 524', json: async () => { throw new SyntaxError('Unexpected token'); } };
      if (w.notionDown) return res(502, { message: 'Bad gateway' });
      const path = url.split('/v1/')[1];
      if (path.startsWith('data_sources/')) {
        const ds = path.split('/')[1];
        const results = Object.keys(w.pages).filter(id => w.pages[id].ds === ds && !w.pages[id].trash && match(w.pages[id], body.filter)).map(api);
        return res(200, { results, has_more: false });
      }
      if (path === 'pages' && opts.method === 'POST') {
        const kind = Object.keys(DS).find(k => DS[k] === body.parent.data_source_id);
        return res(200, api(w.add(kind, fromRequest(body.properties))));
      }
      const id = path.split('/')[1];
      if (!w.pages[id]) return res(404, { message: 'not found' });
      if (opts.method === 'PATCH') {
        if (body.in_trash) w.pages[id].trash = true;
        if (body.properties) w.edit(id, fromRequest(body.properties));
      }
      return res(200, api(id));
    }
    throw new Error('unexpected fetch ' + url);
  };

  w.env = {
    NOTION_TOKEN: 'n', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '1', TZ_NAME: 'Africa/Algiers', DATE_ONLY_HOUR: '8',
    CITY_LAT: '36.7538', CITY_LNG: '3.0588', PRAYER_OFFSETS: '0,2,0,3,0', PRAYER_REMIND_MIN: '30',
    REVIEW_HOUR: '21', WEEKLY_DAY: '4', WEEKLY_TIME: '21:30', EVENTS_TIME: '09:00', HEALTH_LEAD_MIN: '120', HEALTH_EVE_HOUR: '20', CHILD_BIRTH: '2025-12-05',
    CHILD_NAME: 'مريم', CHILD_SEX: 'girl', FAMILY: 'أنا,الزوجة', COUNTRY: 'الجزائر',
    ...Object.fromEntries(Object.entries(DS).map(([k, v]) => [`DS_${({ fin: 'finance', nour: 'diary' }[k] || k).toUpperCase()}`, v])),
    ...(geminiKey ? { GEMINI_API_KEY: geminiKey } : {}),
    STATE: {
      get: async (k, type) => w.kv[k] == null ? null : type === 'json' ? JSON.parse(w.kv[k]) : w.kv[k],
      put: async (k, v) => { w.kv[k] = v; },
      delete: async k => { delete w.kv[k]; },
    },
  };

  w.cron = async () => {
    let p;
    await worker.scheduled({}, w.env, { waitUntil: x => { p = x; } });
    await p;
  };
  // Notion البطيء: الطلبات المعلّقة تُكمل حين تبلغ الساعة موعدها
  w.waiters = [];
  const settle = () => new Promise(r => setTimeout(r, 5));
  // يقدّم الساعة ms بخطوات 10 ث، ويُكمل طلبات Notion التي حان موعدها واحدًا تلو الآخر
  w.advance = async ms => {
    for (const end = w.now + ms; w.now < end;) {
      w.now = Math.min(end, w.now + 10e3);
      for (let x; (x = w.waiters.find(y => y.t <= w.now));) { w.waiters.splice(w.waiters.indexOf(x), 1); x.r(); await settle(); }
    }
    await settle();
  };
  // تشغيل كل دقيقة وNotion بطيء، ثم ينتهي البطء وتكتمل كل التشغيلات العالقة
  w.overlappingCrons = async (minutes, latency = 100e3) => {
    w.notionLatency = latency;
    const runs = [];
    for (let i = 0; i < minutes; i++) { runs.push(w.cron()); await w.advance(60e3); }
    w.notionLatency = 0;
    while (w.waiters.length) await w.advance(60e3);
    await Promise.all(runs);
  };
  let secret;
  w.post = async (update, headerSecret) => {
    if (!secret) {
      const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bot'));
      secret = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    const waits = [];
    const r = await worker.fetch(new Request('https://x/telegram', {
      method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': headerSecret ?? secret }, body: JSON.stringify(update),
    }), w.env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    return r;
  };
  // طلب GET (اللوحة) بترويسات اختيارية
  w.get = (path, headers = {}) => worker.fetch(new Request('https://x' + path, { headers }), w.env, { waitUntil: () => {} });
  let umid = 1;
  w.text = (text, chat = 1) => w.post({ message: { message_id: umid++, chat: { id: chat }, text } });
  w.press = (data, message_id, chat = 1) => w.post({ callback_query: { id: 'q', data, message: { message_id, chat: { id: chat } } } });
  w.voice = () => w.post({ message: { message_id: umid++, chat: { id: 1 }, voice: { file_id: 'f', mime_type: 'audio/ogg', file_size: 4000 } } });
  w.photo = (caption, extra = {}) => w.post({ message: { message_id: umid++, date: Math.floor(w.now / 1000), chat: { id: 1 }, photo: [{ file_id: 'small' }, { file_id: 'big', file_size: 90000 }], ...(caption ? { caption } : {}), ...extra } });
  w.reply = (text, toMid) => w.post({ message: { message_id: umid++, chat: { id: 1 }, text, reply_to_message: { message_id: toMid } } });
  // رسائل تلغرام منذ آخر استدعاء
  // (رسالة «حُدّثت أزرار البوت» الآلية تُستبعد)
  w.flush = () => w.sent.splice(0).filter(m => !String(m.text || '').includes('حُدّثت أزرار'));
  w.texts = msgs => msgs.filter(m => m.method === 'sendMessage' || m.method === 'editMessageText').map(m => m.text);
  w.buttons = m => (m.reply_markup?.inline_keyboard || []).flat();
  w.last = method => [...w.sent].reverse().find(m => m.method === method);
  w.draftMid = key => JSON.parse(w.kv[key] || '{}').mid;
  return w;
}
