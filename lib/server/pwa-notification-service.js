'use strict';

/**
 * PWA notification delivery: account resolution, localized browser Push and
 * durable retry of one-shot image first-view alerts. SSE ownership/event fanout
 * lives in pwa-event-service.js; this service only owns delivery/retry policy.
 */
function createPwaNotificationService(deps) {
  const {
    APP_NAME, getState, getPwaDevice, pwaDeviceCreatorAccount, pwaDeviceOwnerAccount, pwaDevices,
    pushSubs, ownerKeysForShare, sendWebPush, sendWebPushAwaited, webPushAvailable,
    effectiveWebhook, sendWebhook, emailConfigured, sendMail, addFirstViewCenterNotification,
    emitPwaOwnerEvent, persist, scheduleFlush, logAudit, clientIp,
  } = deps;
  const firstViewPushInFlight = new Map();

function currentPhotoRef(share) {
  if (!share || !share.id) return null;
  const root = getState();
  const rows = root && Array.isArray(root.shares) ? root.shares : [];
  return rows.find((row) => row && String(row.id) === String(share.id)) === share ? share : null;
}

function pwaNotificationAccountId(req) {
  // A /app notification request runs in the PWA device's own context: when a paired
  // device cookie is present it is the active principal, even if this browser also
  // carries a *different* admin-session cookie. requireAppAuth deliberately nulls
  // req.pwaDevice in that mixed case (to protect record-stamping), so resolve the
  // device straight from the dxpwa cookie here — otherwise the coincident admin
  // session's notifications would leak into the paired PWA.
  const d = (req && req.pwaDevice) || getPwaDevice(req, false);
  if (d) {
    const account = pwaDeviceCreatorAccount(d) || pwaDeviceOwnerAccount(d.id);
    return account && account.id ? String(account.id) : null;
  }
  if (req && req.pwaSession && req.pwaSession.accountId) return String(req.pwaSession.accountId);
  return null;
}
function pwaPushTargets(keys) {
  if (!webPushAvailable() || !Array.isArray(keys) || !keys.length) return [];
  const activeKeys = keys.filter((key) => {
    if (!key.startsWith('dev:')) return true;
    const device = pwaDevices().find((d) => d.id === key.slice(4));
    return !!(device && !device.sessionLockedAt);
  });
  if (!activeKeys.length) return [];
  const out = [], seen = new Set();
  for (const sub of pushSubs()) {
    const endpoint = String(sub && sub.endpoint || '').trim();
    if (!endpoint || seen.has(endpoint) || !sub || !sub.keys || typeof sub.keys !== 'object') continue;
    if (!Array.isArray(sub.ownerKeys) || !sub.ownerKeys.some((k) => activeKeys.includes(k))) continue;
    seen.add(endpoint); out.push(sub);
  }
  return out;
}
function normalizePwaPushLang(value) {
  const lang = String(value || '').trim().toLowerCase().slice(0, 2);
  return lang === 'en' || lang === 'es' ? lang : 'fr';
}
function localizedPwaPush(evt, language) {
  const lang = normalizePwaPushLang(language);
  const e = evt || {};
  const kind = String(e.kind || e.type || '');
  if (kind === 'image-first-view') {
    const name = String(e.name || 'Image');
    const variants = {
      fr: { full: 'Pleine', thumb: 'Mini', micro: 'Micro' },
      en: { full: 'Full', thumb: 'Mini', micro: 'Micro' },
      es: { full: 'Completa', thumb: 'Mini', micro: 'Micro' },
    };
    const variantKey = e.variant === 'thumb' ? 'thumb' : e.variant === 'micro' ? 'micro' : 'full';
    const variant = variants[lang][variantKey];
    const suffix = (e.ip ? ' · ' + e.ip : '') + (e.country ? ' · ' + e.country : '');
    if (lang === 'en') return { title: `${APP_NAME} — First image view`, body: `“${name}” · ${variant}${suffix}` };
    if (lang === 'es') return { title: `${APP_NAME} — Primera vista de imagen`, body: `«${name}» · ${variant}${suffix}` };
    return { title: `${APP_NAME} — Première vue d’image`, body: `« ${name} » · ${variant}${suffix}` };
  }
  if (kind === 'test') {
    if (lang === 'en') return { title: `${APP_NAME} — Push notification test`, body: '🔔 Direct-Xfer push notifications work on this device.' };
    if (lang === 'es') return { title: `${APP_NAME} — Prueba de notificaciones push`, body: '🔔 Las notificaciones push de Direct-Xfer funcionan en este dispositivo.' };
    return { title: `${APP_NAME} — Test des notifications push`, body: '🔔 Les notifications push Direct-Xfer fonctionnent sur cet appareil.' };
  }
  if (kind === 'inbox') {
    const name = String(e.name || '');
    const dest = String(e.dest || '');
    if (lang === 'en') return { title: `${APP_NAME} — File received`, body: `📥 ${name || 'File'}${dest ? ' received on “' + dest + '”' : ' received'}` };
    if (lang === 'es') return { title: `${APP_NAME} — Archivo recibido`, body: `📥 ${name || 'Archivo'}${dest ? ' recibido en «' + dest + '»' : ' recibido'}` };
    return { title: `${APP_NAME} — Fichier reçu`, body: `📥 ${name || 'Fichier'}${dest ? ' reçu sur « ' + dest + ' »' : ' reçu'}` };
  }
  return { title: e.title || APP_NAME, body: e.body || '' };
}
function sendPwaPush(keys, evt) {
  const subs = pwaPushTargets(keys);
  if (!subs.length) return 0;
  for (const sub of subs) {
    const msg = localizedPwaPush(evt, sub.lang);
    sendWebPush(evt.kind || 'pwa', msg.title, msg.body, {
      url: evt.url || '/app/', token: evt.token || null, testId: evt.testId || null,
      openCenter: !!evt.openCenter, panel: evt.panel || '', destinationUrl: evt.destinationUrl || '',
    }, [sub]);
  }
  return subs.length;
}
async function sendPwaPushAwaited(keys, evt) {
  const subs = pwaPushTargets(keys);
  if (!subs.length) return { targeted: 0, accepted: 0, failed: 0 };
  const results = await Promise.all(subs.map((sub) => {
    const msg = localizedPwaPush(evt, sub.lang);
    return sendWebPushAwaited(
      evt.kind || 'pwa',
      msg.title,
      msg.body,
      {
        url: evt.url || '/app/', token: evt.token || null, testId: evt.testId || null,
        openCenter: !!evt.openCenter, panel: evt.panel || '', destinationUrl: evt.destinationUrl || '',
      },
      sub
    );
  }));
  return {
    targeted: results.length,
    accepted: results.filter((r) => r && r.ok).length,
    failed: results.filter((r) => !r || !r.ok).length,
  };
}
async function deliverPendingFirstViewPush(s) {
  s = currentPhotoRef(s);
  if (!s || s.type !== 'photo' || !s.firstViewPushPending) return 0;
  const key = String(s.token || s.id || '');
  if (firstViewPushInFlight.has(key)) return firstViewPushInFlight.get(key);
  const job = (async () => {
    const pending = s.firstViewPushPending;
    const keys = ownerKeysForShare(s);
    if (!keys.length) {
      pending.attempts = Math.max(0, Number(pending.attempts) || 0) + 1;
      pending.lastAttemptAt = Date.now(); pending.lastFailureAt = Date.now();
      pending.lastFailure = 'owner-unresolved'; scheduleFlush();
      return 0;
    }
    pending.attempts = Math.max(0, Number(pending.attempts) || 0) + 1;
    pending.lastAttemptAt = Date.now();
    const result = await sendPwaPushAwaited(keys, {
      kind: 'image-first-view',
      name: s.name || 'Image',
      variant: pending.variant || 'full',
      ip: pending.ip || null,
      country: pending.country || null,
      url: '/app/#images',
      token: s.token || null,
      // Tapping the push opens the Images panel with the center open.
      openCenter: true,
      panel: 'images',
    });
    if (result.accepted > 0 && s.firstViewPushPending === pending) {
      delete s.firstViewPushPending;
      s.firstViewPushQueuedAt = Date.now();
      s.firstViewPushAcceptedAt = Date.now();
      s.firstViewPushAcceptedCount = result.accepted;
      persist();
      return result.accepted;
    }
    if (s.firstViewPushPending === pending) {
      pending.lastFailureAt = Date.now();
      pending.lastFailure = result.targeted ? 'push-service-rejected' : (webPushAvailable() ? 'no-subscription' : 'push-unavailable');
      scheduleFlush();
    }
    return 0;
  })().finally(() => { firstViewPushInFlight.delete(key); });
  firstViewPushInFlight.set(key, job);
  return job;
}
function notifyFirstPhotoView(s, req, kind, ip, geo) {
  s = currentPhotoRef(s);
  if (!s || s.type !== 'photo') return;
  const variant = kind === 'thumb' ? 'Mini' : kind === 'micro' ? 'Micro' : 'Full';
  const where = geo && geo.country ? ' · ' + geo.country : '';
  const body = `"${s.name || 'Image'}" · ${variant}${ip ? ' · ' + ip : ''}${where}`;
  const title = `${APP_NAME} — First image view`;
  const payload = { name: s.name || '', token: s.token, variant: kind, ip: ip || null, country: geo && geo.country || null, url: '/app/#images' };
  const wh = effectiveWebhook();
  if (wh.url) sendWebhook(wh.url, wh.format, `👁 ${title}: ${body}`, 'image-first-view', payload);
  if (emailConfigured()) sendMail(title, `👁 ${title}: ${body}`);
  const evt = { type: 'image-first-view', title, body, name: s.name || '', token: s.token, variant: kind, at: Date.now(), url: '/app/#images' };
  addFirstViewCenterNotification(s, { ...evt, ip: ip || null, country: geo && geo.country || null }, geo);
  // Persist the one-shot Push BEFORE attempting delivery. The old path considered
  // the alert sent as soon as a matching subscription existed, even if the push
  // provider rejected it moments later. Keep it pending until at least one provider
  // explicitly accepts the message, using the same awaited transport as the working
  // Push diagnostics button.
  s.firstViewPushPending = {
    at: evt.at,
    variant: kind,
    ip: ip || null,
    country: geo && geo.country || null,
    title,
    body,
    attempts: 0,
  };
  emitPwaOwnerEvent(s, evt, false); // SSE refresh is independent of closed-app Push
  deliverPendingFirstViewPush(s).catch((err) => {
    if (s.firstViewPushPending) {
      s.firstViewPushPending.lastFailureAt = Date.now();
      s.firstViewPushPending.lastFailure = String(err && err.message || 'push-send-failed').slice(0, 120);
      scheduleFlush();
    }
  });
  logAudit('image-first-view', { username: 'system', ip: clientIp(req), detail: `${s.name || s.token} · ${variant}` });
}

async function flushPendingFirstViewPushForKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return 0;
  const jobs = [];
  for (const share of ((getState() && getState().shares) || [])) {
    if (!share || share.type !== 'photo' || !share.notifyFirstView || !share.firstViewPushPending) continue;
    const ownerKeys = ownerKeysForShare(share);
    if (!ownerKeys.some((k) => keys.includes(k))) continue;
    jobs.push(deliverPendingFirstViewPush(share));
  }
  if (!jobs.length) return 0;
  const delivered = await Promise.all(jobs);
  return delivered.reduce((sum, n) => sum + (Number(n) || 0), 0);
}

// Called from the (anonymous) upload finalize when a file lands on an inbox.

  function clearRuntimeState() { firstViewPushInFlight.clear(); }

  return {
    pwaNotificationAccountId, pwaPushTargets, normalizePwaPushLang, localizedPwaPush,
    sendPwaPush, sendPwaPushAwaited, deliverPendingFirstViewPush, notifyFirstPhotoView,
    flushPendingFirstViewPushForKeys, clearRuntimeState,
  };
}

module.exports = { createPwaNotificationService };
