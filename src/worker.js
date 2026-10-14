import { handleApp } from './dashboard.js';
import { onHabitButton } from './habits.js';
import { onVaccineButton } from './growth.js';
import { onBillButton } from './bills.js';
// نقطة الدخول: التشغيل الدوري (cron) وwebhook تلغرام. كل ميزة في ملفها داخل src/.
import { checkDue } from './alerts.js';
import { answer, webhookSecret } from './api.js';
import { onAskButton } from './ask.js';
import { onButton } from './buttons.js';
import { applyConfig, rt } from './core.js';
import { onListButton } from './dayview.js';
import { onMedButton } from './docs.js';
import { onAddButton, onMessage, say } from './messages.js';
import { onMoneyButton } from './money.js';
import { onMorningButton } from './morning.js';
import { onPhoto, onPhotoButton } from './diary.js';
import { onPrayerButton } from './prayer.js';
import { onQuotaButton } from './quota.js';
import { onReviewButton } from './review.js';
import { onSettingsButton } from './settings.js';
import { onRamadanButton, onSpiritButton, onWirdButton } from './spirit.js';
import { esc } from './view.js';
import { onVoice, onVoiceButton } from './voice.js';

export default {
  async scheduled(_event, env, ctx) {
    rt.subreq = 0;
    applyConfig(env);
    ctx.waitUntil(checkDue(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    rt.origin = url.origin;
    applyConfig(env);
    // 📱 اللوحة (Mini App)
    if (request.method === 'GET' && (url.pathname === '/app' || url.pathname === '/app/data')) return handleApp(request, env);
    if (request.method === 'POST' && url.pathname === '/telegram') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      rt.bgCtx = ctx;
      // الصوت يأخذ ثوانٍ مع Gemini: نردّ على تلغرام فورًا ونكمل في الخلفية حتى لا يعيد الإرسال
      const voiceMsg = update.message && (update.message.voice || update.message.audio) ? update.message : null;
      // الصورة (أو ملف صورة) ← بطاقة «لمن؟»؛ الرفع إلى Drive والاستيراد يأخذان ثوانٍ فيكملان في الخلفية
      const m = update.message;
      if (m && (m.photo || (m.document && /^image\/|^application\/pdf$/.test(m.document.mime_type || '')))) {
        await onPhoto(m, env).catch(err => say(env, `⚠️ ${esc(String(err.message).slice(0, 300))}`).catch(() => {}));
        return new Response('ok');
      }
      const slow = update.callback_query && (['ph|n', 'ph|d', 'ph|ok', 'ph|rb', 'st|imp'].includes(String(update.callback_query.data)) || String(update.callback_query.data).startsWith('q|'));
      if (slow) {
        const cb = update.callback_query;
        const job = cb.data === 'st|imp' ? onSettingsButton(cb, env) : cb.data.startsWith('q|') ? onAskButton(cb, env) : onPhotoButton(cb, env);
        ctx.waitUntil(job.catch(err => { console.error(err); return answer(env, cb.id, `⚠️ ${String(err.message).slice(0, 180)}`).catch(() => {}); }));
        return new Response('ok');
      }
      if (voiceMsg) {
        ctx.waitUntil(onVoice(voiceMsg, env).catch(err => { console.error(err); return say(env, `⚠️ ${esc(String(err.message).slice(0, 300))}`).catch(() => {}); }));
        return new Response('ok');
      }
      try {
        const cb = update.callback_query;
        if (cb && String(cb.data).startsWith('a|')) await onAddButton(cb, env);
        else if (cb && String(cb.data).startsWith('pr|')) await onPrayerButton(cb, env);
        else if (cb && String(cb.data).startsWith('rv|')) await onReviewButton(cb, env);
        else if (cb && String(cb.data).startsWith('ls|')) await onListButton(cb, env);
        else if (cb && String(cb.data).startsWith('fx|')) await onMoneyButton(cb, env);
        else if (cb && String(cb.data).startsWith('vx|')) await onVoiceButton(cb, env);
        else if (cb && String(cb.data).startsWith('st|')) await onSettingsButton(cb, env);
        else if (cb && String(cb.data).startsWith('ph|')) await onPhotoButton(cb, env);
        else if (cb && String(cb.data).startsWith('md|')) await onMedButton(cb, env);
        else if (cb && String(cb.data).startsWith('qt|')) await onQuotaButton(cb, env);
        else if (cb && String(cb.data).startsWith('mb|')) await onMorningButton(cb, env);
        else if (cb && String(cb.data).startsWith('sp|')) await onSpiritButton(cb, env);
        else if (cb && String(cb.data).startsWith('wd|')) await onWirdButton(cb, env);
        else if (cb && String(cb.data).startsWith('rm|')) await onRamadanButton(cb, env);
        else if (cb && String(cb.data).startsWith('bl|')) await onBillButton(cb, env);
        else if (cb && String(cb.data).startsWith('hb|')) await onHabitButton(cb, env);
        else if (cb && String(cb.data).startsWith('vc|')) await onVaccineButton(cb, env);
        else if (cb) await onButton(cb, env);
        else if (update.message) await onMessage(update.message, env);
      } catch (err) {
        console.error(err);
        if (update.message) await say(env, `⚠️ ${esc(String(err.message).slice(0, 300))}`).catch(() => {});
        if (update.callback_query) await answer(env, update.callback_query.id, `⚠️ ${String(err.message).slice(0, 180)}`);
      }
      return new Response('ok');
    }
    return new Response('Not found', { status: 404 });
  },
};
