// بوت تنبيهات Notion على تلغرام — يعمل على Cloudflare Workers.
//
// كل دقيقة (cron): يقرأ «✅ المهام» و«🔔 التذكيرات» و«💡 الأفكار» ويرسل رسالة مستقلة لكل عنصر حلّ موعده،
// وتحتها أزرار: ✅ تم · ⏰ أجّلها · ❌ ألغها. وإذا عُدّلت المهمة في Notion بعد إرسالها
// (أُنجزت، أُلغيت، تغيّر موعدها أو عنوانها) تُحدَّث رسالتها في تلغرام.
// عند الضغط على زر (webhook): يحدّث Notion فورًا ويعدّل الرسالة لتُظهر النتيجة.
// زر «➕ إضافة» الثابت: إضافة مهمة / موعد / فكرة إلى Notion مع اختيار اليوم والساعة والتكرار.
// «تكرار تلقائي»: للعناصر المعلَّم عليها يُنشئ البوت الموعد التالي عند حلول الحالي.
// 🕌 الصلاة: تنبيه عند كل أذان بزر «✅ صلّيت» يسجّل في متتبع الصلاة، وتذكير ثانٍ إن لم تُسجَّل.
// 🌙 مراجعة المساء: ما بقي مفتوحًا اليوم، مع ✅ تمّت / ➡️ غدًا لكل عنصر.
// 📋 اليوم / 📆 غدًا: استعراض سريع بالأزرار. 📊 تقرير أسبوعي كل خميس مساءً أو عند الطلب.
// 💰 المصاريف: تسجيل سريع في «💰 المالية» مع ملخص الشهر مقابل الميزانية.
// 🎂 المناسبات العائلية: تذكير قبل أسبوع وقبل يوم ويوم المناسبة (وقبل شهر لما يحتاج هدية).
// 🩺 المواعيد الطبية: تذكير مساء اليوم السابق، وتنبيه قبل الموعد بـ HEALTH_LEAD_MIN دقيقة.
// 🎤 الرسائل الصوتية: يفهمها Gemini ويقترح ما يُسجَّل، ولا يُحفظ شيء قبل التأكيد.
// ⚙️ الإعدادات: إضافة مفتاح Gemini من داخل البوت.
//
// المتغيرات (Secrets): NOTION_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID، واختياريًا GEMINI_API_KEY للرسائل الصوتية
// الإعدادات (vars في wrangler.toml): TZ_NAME, DATE_ONLY_HOUR, CITY_LAT/CITY_LNG, PRAYER_OFFSETS, PRAYER_REMIND_MIN, REVIEW_HOUR, WEEKLY_DAY, WEEKLY_TIME
// التخزين: KV باسم STATE (ما أُرسل حتى لا يتكرر، ومسودة الإضافة الجارية).

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
export const DUE_GRACE_MS = 3 * HOUR;   // لا نرسل تنبيهًا لموعد مضى عليه أكثر من هذا (بعد توقف مثلًا)
export const SENT_TTL_MS = 14 * DAY;    // مدة الاحتفاظ بمفاتيح ما أُرسل
export const MSG_TTL_MS = 7 * DAY;      // مدة متابعة الرسالة لتحديثها عند تعديل المهمة في Notion
export const EDIT_LOOKBACK_MS = 5 * 60e3; // نافذة التقاط تعديلات Notion (تُفحص كل دقيقة؛ التداخل آمن)
export const MAX_CALLS_PER_RUN = 30;
// حد Cloudflare المجاني: 50 طلبًا خارجيًا لكل تشغيل. نعدّها ونؤجّل الأجزاء الاختيارية عند الاقتراب منه
export const SUBREQ_LIMIT = 50, SUBREQ_RESERVE = 12;
export const budgetLeft = () => SUBREQ_LIMIT - rt.subreq;    // حد الطلبات الفرعية في الخطة المجانية 50؛ الباقي يُرسل في الدقيقة التالية
export const DRAFT_TTL_S = 3600;        // مدة صلاحية مسودة الإضافة

// كل مصدر: أسماء خصائصه، الحالات المغلقة، وقيم الأزرار
export const COMMON = { status: 'الحالة', notes: 'ملاحظات', repeat: 'التكرار', auto: 'تكرار تلقائي', cancelled: 'ملغاة' };
export const SOURCES = {
  task: {
    ...COMMON, ds: '', icon: '✅', label: 'مهمة',
    title: 'المهمة', date: 'الموعد', priority: 'الأولوية',
    open: 'للقيام بها', done: 'منجزة', closed: ['منجزة', 'لم تُنجز', 'ملغاة'],
    repeats: ['مرة واحدة', 'يومي', 'يوم بعد يوم', 'أسبوعي', 'شهري', 'سنوي'],
  },
  reminder: {
    ...COMMON, ds: '', icon: '📅', label: 'موعد',
    title: 'التذكير', date: 'التاريخ', priority: 'الأهمية',
    open: 'قائم', done: 'تم', closed: ['تم', 'مؤجل', 'ملغاة'],
    repeats: ['مرة واحدة', 'يومي', 'أسبوعي', 'شهري', 'سنوي'],
  },
  idea: {
    ...COMMON, ds: '', icon: '💡', label: 'فكرة',
    title: 'الفكرة', date: 'التاريخ', priority: null,
    open: 'جديدة', done: 'مُنفّذة', closed: ['مُنفّذة', 'مؤرشفة', 'ملغاة'],
    repeats: ['مرة واحدة', 'يومي', 'أسبوعي', 'شهري', 'سنوي'],
  },
  health: {
    ...COMMON, ds: '', icon: '🩺', label: 'طبي',
    title: 'العنوان', date: 'التاريخ', priority: null,
    open: 'قادم', done: 'تم', cancelled: null, closed: ['تم'],
    repeats: [],
    // المواعيد فقط (الأدوية والملاحظات لها منطق آخر)
    types: ['موعد طبي', 'تحاليل/أشعة', 'تطعيم'],
    people: ['أنا'],
  },
};
// ───────── الإعدادات الشخصية (من متغيرات wrangler.toml، تُطبَّق في بداية كل طلب/تشغيل) ─────────
// معرّفات قواعد Notion (data source ids): DS_TASK … يكتبها scripts/setup-notion.mjs في wrangler.toml
export const DS = { task: '', reminder: '', idea: '', health: '', tracker: '', finance: '', budget: '', jihat: '', events: '', diary: '', habits: '', growth: '' };
// cfg.child: اسم الطفل (فارغ = لا ميزات الطفل: يوميات الصور، النمو، شهره الجديد) · cfg.family: الأشخاص في الملف الصحي
export const cfg = { child: '', birth: '', girl: true, family: ['أنا'], country: 'الجزائر', about: '', off: new Set() };
export function applyConfig(env) {
  for (const k of Object.keys(DS)) DS[k] = env[`DS_${k.toUpperCase()}`] || '';
  for (const k of ['task', 'reminder', 'idea', 'health']) SOURCES[k].ds = DS[k];
  cfg.child = String(env.CHILD_NAME || '').trim();
  cfg.birth = cfg.child ? String(env.CHILD_BIRTH || '').trim() : '';
  cfg.girl = String(env.CHILD_SEX || 'girl').trim() !== 'boy';
  cfg.family = [...new Set([...String(env.FAMILY || 'أنا').split(/[,،]/).map(x => x.trim()).filter(Boolean), ...(cfg.child ? [cfg.child] : [])])];
  cfg.country = String(env.COUNTRY || 'الجزائر').trim();
  cfg.about = String(env.ABOUT_ME || '').trim();
  // ميزات يمكن إيقافها: prayer (الصلاة والأذكار والورد ورمضان) · money (المال والفواتير) · jihat (الجهات والحصص)
  cfg.off = new Set(String(env.DISABLE || '').split(/[,،\s]+/).map(x => x.trim()).filter(Boolean));
  SOURCES.health.people = cfg.family;
}
export const on = feature => !cfg.off.has(feature) && (feature !== 'child' || !!cfg.child);

export const kindOf = page => Object.keys(SOURCES).find(k => page.properties[SOURCES[k].title]);
export const URGENT = ['عاجلة', 'عالية', 'مهم جداً'];

// عمل طويل (Gemini) يكمل بعد الرد على تلغرام حتى لا يعيد إرسال التحديث
export const inBackground = p => { if (!rt.bgCtx) return p; rt.bgCtx.waitUntil(p.catch(err => console.error(err))); };

// حالة مشتركة قابلة للتغيير بين الوحدات
export const rt = { subreq: 0, bgCtx: null, origin: null };
