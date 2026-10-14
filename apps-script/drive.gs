/**
 * 📸 صور الطفل ← Google Drive
 *
 * يستقبل هذا الكود الصور من بوت تلغرام ويحفظها في مجلد «صور الطفل» على Google Drive،
 * ويقرأ تاريخ التقاط الصورة الأصلي (EXIF) إن وُجد، ويساعد البوت على استيراد الصور الموجودة في المجلد.
 *
 * التثبيت (مرة واحدة):
 *   1) script.google.com ← New project ← الصق هذا الملف كاملًا مكان الموجود ← احفظ.
 *   2) Deploy ← New deployment ← النوع Web app:
 *        Execute as: Me   ·   Who has access: Anyone
 *      ← Deploy ← اسمح بالصلاحيات (Drive) ← انسخ «Web app URL» (ينتهي بـ /exec).
 *   3) في البوت: ⚙️ ← «📸 ربط Google Drive» ← أرسل الرابط.
 *
 * الأمان: أول اتصال من البوت يسجّل كلمة سرّ عشوائية في خصائص هذا المشروع، وكل طلب بعدها بدونها يُرفض.
 * إذا أردت ربطه ببوت آخر أو أُعيد إعداد البوت: شغّل الدالة resetSecret من المحرّر مرة واحدة ثم اربطه من جديد.
 */

const FOLDER_NAME = 'صور الطفل'; // غيّر اسم المجلد إن شئت (مثل «صور سارة»)
const MARK = 'nour-diary';            // يُكتب في وصف الملف بعد تسجيله في Notion
const MEDIA_RE = /^(image|video)\//;

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad request' }); }
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SECRET');
  if (!secret && req.action === 'ping' && req.secret && String(req.secret).length >= 32) {
    props.setProperty('SECRET', req.secret);
    secret = req.secret;
  }
  if (!secret || req.secret !== secret) return out_({ ok: false, error: 'unauthorized' });
  try {
    const fn = ACTIONS[req.action];
    if (!fn) return out_({ ok: false, error: 'unknown action' });
    return out_(Object.assign({ ok: true }, fn(req)));
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return ContentService.createTextOutput('📸 صور الطفل: الكود يعمل. أرسل هذا الرابط إلى البوت من ⚙️.');
}

const ACTIONS = {
  // فحص الربط
  ping: function () {
    const f = folder_();
    return { folder: f.getName(), folderUrl: f.getUrl() };
  },

  // رفع صورة للطفل من تلغرام: { fileUrl, name }
  upload: function (req) {
    const blob = UrlFetchApp.fetch(req.fileUrl).getBlob().setName(req.name || ('nour_' + Date.now() + '.jpg'));
    const file = folder_().createFile(blob);
    file.setDescription(MARK);
    return { id: file.getId(), url: file.getUrl(), taken: takenDate_(blob.getBytes(), file.getName()) };
  },

  // صور المجلد (ومجلداته الفرعية) التي لم تُسجَّل بعد: { limit } ← { files, more }
  scan: function (req) {
    const limit = Math.min(Number(req.limit) || 15, 40);
    const files = [];
    let more = false;
    walk_(folder_(), function (file) {
      if (!MEDIA_RE.test(file.getMimeType()) || String(file.getDescription() || '').indexOf(MARK) >= 0) return true;
      if (files.length >= limit) { more = true; return false; }
      const isJpeg = /jpe?g/i.test(file.getMimeType());
      files.push({
        id: file.getId(), name: file.getName(), url: file.getUrl(),
        taken: (isJpeg && takenDate_(file.getBlob().getBytes(), file.getName())) || nameDate_(file.getName()),
        created: file.getDateCreated().toISOString(),
      });
      return true;
    });
    return { files: files, more: more };
  },

  // تعليم الملفات بعد تسجيلها في Notion: { ids }
  mark: function (req) {
    (req.ids || []).forEach(function (id) {
      const f = DriveApp.getFileById(id);
      f.setDescription(((f.getDescription() || '') + ' ' + MARK).trim());
    });
    return { marked: (req.ids || []).length };
  },
};

function resetSecret() {
  PropertiesService.getScriptProperties().deleteProperty('SECRET');
  Logger.log('حُذفت كلمة السرّ. اربط البوت من جديد من ⚙️.');
}

// ── أدوات

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function folder_() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

// يمرّ على الملفات؛ fn تُرجع false للتوقف
function walk_(folder, fn) {
  const files = folder.getFiles();
  while (files.hasNext()) if (fn(files.next()) === false) return false;
  const subs = folder.getFolders();
  while (subs.hasNext()) if (walk_(subs.next(), fn) === false) return false;
  return true;
}

function takenDate_(bytes, name) {
  return exifDate_(bytes) || nameDate_(name);
}

// تاريخ الالتقاط من EXIF (DateTimeOriginal، وإلا DateTime) ← «YYYY-MM-DDTHH:MM:SS» بالتوقيت المحلي للكاميرا
function exifDate_(bytes) {
  const b = function (i) { return bytes[i] & 0xff; };
  if (!bytes || bytes.length < 4 || b(0) !== 0xff || b(1) !== 0xd8) return null;
  let p = 2;
  while (p + 4 < bytes.length && p < 262144) {
    if (b(p) !== 0xff) return null;
    const marker = b(p + 1), len = (b(p + 2) << 8) | b(p + 3);
    if (marker === 0xe1 && b(p + 4) === 0x45 && b(p + 5) === 0x78 && b(p + 6) === 0x69 && b(p + 7) === 0x66) {
      const t = p + 10, le = b(t) === 0x49;
      const u16 = function (i) { return le ? b(t + i) | (b(t + i + 1) << 8) : (b(t + i) << 8) | b(t + i + 1); };
      const u32 = function (i) { return le ? (u16(i) + u16(i + 2) * 65536) : (u16(i) * 65536 + u16(i + 2)); };
      const readIfd = function (off) {
        const tags = {}, n = u16(off);
        for (let k = 0; k < n; k++) { const e = off + 2 + k * 12; tags[u16(e)] = e; }
        return tags;
      };
      const ascii = function (e) {
        const cnt = u32(e + 4), at = cnt > 4 ? u32(e + 8) : e + 8;
        let s = '';
        for (let k = 0; k < Math.min(cnt, 19); k++) s += String.fromCharCode(b(t + at + k));
        const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        return m && m[1] !== '0000' ? m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] : null;
      };
      const ifd0 = readIfd(u32(4));
      if (ifd0[0x8769] !== undefined) {
        const exif = readIfd(u32(ifd0[0x8769] + 8));
        if (exif[0x9003] !== undefined) { const d = ascii(exif[0x9003]); if (d) return d; }
      }
      return ifd0[0x0132] !== undefined ? ascii(ifd0[0x0132]) : null;
    }
    if (marker === 0xda) return null;
    p += 2 + len;
  }
  return null;
}

// من اسم الملف: IMG_20230415_142233 · PXL_20230415… · IMG-20230415-WA0001 · Screenshot_2023-04-15-14-22-33
function nameDate_(name) {
  const m = String(name || '').match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ .T]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?/);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
  const date = m[1] + '-' + m[2] + '-' + m[3];
  return m[4] && +m[4] < 24 && +m[5] < 60 ? date + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') : date;
}
