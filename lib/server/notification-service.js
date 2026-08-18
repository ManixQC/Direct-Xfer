'use strict';

/**
 * Notification subsystem: webhook, SMTP, Web Push, aggregation, leak alerts,
 * expiry reminders and periodic activity digests.
 *
 * The service receives its dependencies explicitly so it can follow the current
 * persisted state even after a restore replaces the root state object.
 */
function createNotificationService(deps) {
  const {
    APP_NAME, WEBHOOK_URL, WEBHOOK_FORMAT, SMTP_URL, EMAIL_FROM, EMAIL_TO,
    nodemailer, webpush, getSettings, formatBytes, persist, persistNow,
    getById, getByToken, notificationAccountIdForShare, notificationAdminAccountIds,
    pushSubscriptionsForAccountIds, noteCenterServiceState, noteExpiredPushSub,
    shareFirstUseDeadline, shareInactiveDeadline, isActive, listShares,
    addShareCenterNotification, logAudit, readLogTail, getState,
  } = deps;

  // Resolve persisted state on demand. Restore can replace the root object, so
  // services must never retain a stale state reference.
  const currentState = () => getState();
  function ensureMeta() {
    const root = currentState();
    if (!root.meta || typeof root.meta !== 'object') root.meta = {};
    return root.meta;
  }

  // Guesses the webhook format from the URL (otherwise generic JSON).
  function autoWebhookFormat(url) {
    if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return 'discord';
    if (/hooks\.slack\.com/i.test(url)) return 'slack';
    if (/ntfy\b/i.test(url)) return 'ntfy';
    return 'json';
  }

  // Result of the most recent webhook call, surfaced on the dashboard.
  let lastWebhook = null; // { at, ok, status, event, error }

  // The webhook actually used: the WEBHOOK_URL env var takes precedence over the
  // UI-configured one (so env-driven deployments aren't overridden from the UI).
  function effectiveWebhook() {
    if (WEBHOOK_URL) return { url: WEBHOOK_URL, format: WEBHOOK_FORMAT || autoWebhookFormat(WEBHOOK_URL), fromEnv: true };
    const s = getSettings();
    const url = String(s.webhookUrl || '').trim();
    return { url, format: (s.webhookFormat || '') || (url ? autoWebhookFormat(url) : ''), fromEnv: false };
  }

  // Low-level POST to a webhook. Returns a promise resolving to { ok, status, error }
  // and records the result in lastWebhook. `payload` carries structured JSON fields.
  function sendWebhook(url, format, message, kind, payload) {
    const fmt = format || autoWebhookFormat(url);
    let body, contentType = 'application/json';
    if (fmt === 'ntfy') { body = message; contentType = 'text/plain; charset=utf-8'; }
    else if (fmt === 'slack') body = JSON.stringify({ text: message });
    else if (fmt === 'discord') body = JSON.stringify({ content: message });
    else body = JSON.stringify({ app: APP_NAME, event: kind, message, ...(payload || {}) });
    const finish = (ok, status, error) => {
      lastWebhook = { at: Date.now(), ok, status, event: kind, error };
      if (!ok) console.error('[webhook] failed:', error);
      return { ok, status, error };
    };
    try {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body, signal: AbortSignal.timeout(5000) })
        .then((res) => finish(res.ok, res.status, res.ok ? null : 'HTTP ' + res.status))
        .catch((e) => finish(false, 0, e.message));
    } catch (e) {
      return Promise.resolve(finish(false, 0, e.message));
    }
  }

  // Whether an event kind should be notified, per the per-event toggles.
  function notifyEnabled(kind) {
    const s = getSettings();
    if (kind === 'received') return s.notifyUploads !== false;
    if (kind === 'downloaded') return s.notifyDownloads !== false;
    if (kind === 'message') return s.notifyMessages !== false;
    return true;
  }

  // Optional anti-spam aggregation. When notifyAggregateSeconds > 0,
  // received/downloaded events for the SAME link within a rolling window are coalesced
  // into ONE "N files received/downloaded" notification instead of one per event.
  // Unique messages and other kinds are never batched. In-memory only (like the leak
  // trackers): a restart at worst drops a pending digest, never a real file.
  const notifyBuckets = new Map(); // "kind\0shareId" -> { kind, name, count, bytes, ips:Set, countries:Set, last, timer }
  const NOTIFY_BUCKET_MAX = 2000; // bound memory if thousands of distinct links are hot at once
  function notifyAggregateMs() {
    return Math.max(0, Math.min(3600, Math.floor(Number(getSettings().notifyAggregateSeconds) || 0))) * 1000;
  }
  function flushNotifyBucket(key) {
    const b = notifyBuckets.get(key);
    if (!b) return;
    notifyBuckets.delete(key);
    if (b.timer) { clearTimeout(b.timer); b.timer = null; }
    if (b.count <= 1) { emitNotify(b.kind, b.last); return; } // a lone event → the normal message
    const label = b.kind === 'received' ? 'files received' : 'downloads';
    const icon = b.kind === 'received' ? '📥' : '⬇️';
    const name = b.name || '';
    const where = b.countries.size ? ` · ${[...b.countries].slice(0, 6).join(', ')}` : '';
    const subject = `${APP_NAME} — ${b.count} ${label}: ${name}`;
    const message = `${icon} ${APP_NAME} — ${b.count} ${label} on "${name}" (${formatBytes(b.bytes)}) from ${b.ips.size} IP(s)${where}`;
    dispatch(b.kind, subject, message, { name, kind: b.kind, count: b.count, bytes: b.bytes, ips: b.ips.size, aggregated: true, shareId: b.last && b.last.shareId || null }, { suppressWebPush:!!(b.last && b.last.suppressWebPush) });
  }
  function notify(kind, info) {
    if (!notifyEnabled(kind)) return;
    info = info || {};
    const win = notifyAggregateMs();
    // Only per-link file events are batchable; unique free-text messages stay immediate.
    if (win > 0 && (kind === 'received' || kind === 'downloaded') && info.shareId) {
      const key = kind + '\0' + info.shareId;
      let b = notifyBuckets.get(key);
      if (!b) {
        if (notifyBuckets.size >= NOTIFY_BUCKET_MAX) { emitNotify(kind, info); return; } // safety valve
        b = { kind, name: info.name || '', count: 0, bytes: 0, ips: new Set(), countries: new Set(), last: info, timer: null };
        notifyBuckets.set(key, b);
        b.timer = setTimeout(() => flushNotifyBucket(key), win);
        if (b.timer.unref) b.timer.unref();
      }
      b.count += 1;
      b.bytes += Math.max(0, Number(info.bytes) || 0);
      if (info.ip) b.ips.add(info.ip);
      if (info.country) b.countries.add(info.country);
      if (info.name) b.name = info.name;
      b.last = info;
      return;
    }
    emitNotify(kind, info);
  }

  // Notifies the admin over every configured channel (webhook + e-mail).
  function emitNotify(kind, info) {
    if (!notifyEnabled(kind)) return;
    const where = info.country ? ` · ${info.country}` : '';
    let subject, message;
    if (kind === 'message') {
      const onFile = info.file ? ` [${info.file}]` : '';
      subject = `${APP_NAME} — Message on "${info.name}"`;
      message = `💬 ${APP_NAME} — Message on "${info.name}"${onFile}: ${info.text} — ${info.ip}${where}`;
    } else {
      const label = kind === 'received' ? 'File received' : 'File downloaded';
      const icon = kind === 'received' ? '📥' : '⬇️';
      const from = (kind === 'received' && info.sender) ? ` — from ${info.sender}` : '';
      subject = `${APP_NAME} — ${label}: ${info.name}`;
      message = `${icon} ${APP_NAME} — ${label}: "${info.name}" (${formatBytes(info.bytes)})${from} — ${info.ip}${where}`;
    }
    dispatch(kind, subject, message, {
      name: info.name, bytes: info.bytes, ip: info.ip, country: info.country || null, file: info.file || null, sender: info.sender || null,
      shareId: info.shareId || null,
    }, { suppressWebPush:!!info.suppressWebPush }); // fire-and-forget
  }

  // "link likely leaked" detection. Per share, keep an in-memory rolling
  // window of completed-download signals; when the distinct-country count crosses
  // the configured threshold, fire ONE alert (then a cooldown of the same window).
  // In-memory only (a live heuristic) — resets on restart, never bloats shares.json.
  const leakTrackers = new Map(); // shareId -> { events: [{cc, ip, at}], alertedAt }
  const LEAK_MAX_EVENTS = 10000; // per-share cap so a scraped link can't grow unbounded
  // Drops leak trackers for shares that no longer exist or whose window has fully
  // elapsed, so the map doesn't accumulate stale entries over the process lifetime.
  function pruneLeakTrackers() {
    const windowMs = Math.max(1, Number(getSettings().leakAlertWindowHours) || 24) * 3600 * 1000;
    const now = Date.now();
    for (const [id, tr] of leakTrackers) {
      const live = tr.events.some((e) => now - e.at < windowMs);
      if (!live && now - tr.alertedAt > windowMs) leakTrackers.delete(id);
      else if (!getById(id)) leakTrackers.delete(id); // share revoked/deleted
    }
  }
  function noteLeakSignal(t) {
    const s = getSettings();
    if (!s.leakAlertEnabled || !t || !t.shareId) return;
    const windowMs = Math.max(1, Number(s.leakAlertWindowHours) || 24) * 3600 * 1000;
    const threshold = Math.max(2, Math.floor(Number(s.leakAlertCountries) || 3));
    const now = Date.now();
    let tr = leakTrackers.get(t.shareId);
    if (!tr) { tr = { events: [], alertedAt: 0 }; leakTrackers.set(t.shareId, tr); }
    tr.events.push({ cc: t.countryCode || null, ip: t.ip, at: now });
    tr.events = tr.events.filter((e) => now - e.at < windowMs);
    // Bound memory on a hot/scraped link: only the tail matters for distinct-country
    // and distinct-IP counting, and the cap is far above any sane threshold.
    if (tr.events.length > LEAK_MAX_EVENTS) tr.events = tr.events.slice(-LEAK_MAX_EVENTS);
    const countries = new Set(tr.events.map((e) => e.cc).filter(Boolean));
    const ips = new Set(tr.events.map((e) => e.ip));
    if (countries.size >= threshold && now - tr.alertedAt > windowMs) {
      tr.alertedAt = now;
      const sh = getById(t.shareId);
      const name = sh ? (sh.name || sh.id) : t.shareId;
      const list = [...countries].slice(0, 12).join(', ');
      const message = `🚨 ${APP_NAME} — Link possibly leaked: "${name}" was downloaded from ${countries.size} countries `
        + `(${ips.size} distinct IPs) in ${Math.round(windowMs / 3600000)}h — ${list}`;
      dispatch('leak', `${APP_NAME} — Link possibly leaked: ${name}`, message, {
        name, token: sh ? sh.token : null, shareId: sh ? sh.id : t.shareId, countries: countries.size, ips: ips.size, list: [...countries],
      });
      logAudit('leak-alert', { username: 'system', detail: `${name}: ${countries.size} countries, ${ips.size} IPs` });
    }
  }

  // --- E-mail (SMTP) notifications --------------------------------------------
  let lastEmail = null;        // { at, ok, error } — surfaced on the dashboard
  let mailerCache = null;      // { key, transport } — rebuilt when the config changes

  // The effective SMTP config: the SMTP_URL env var wins over the UI fields.
  function effectiveEmail() {
    const s = getSettings();
    const to = EMAIL_TO || String(s.smtpTo || '').trim();
    const from = EMAIL_FROM || String(s.smtpFrom || '').trim() || String(s.smtpUser || '').trim();
    if (SMTP_URL) return { fromEnv: true, url: SMTP_URL, to, from };
    return {
      fromEnv: false,
      host: String(s.smtpHost || '').trim(),
      port: Number(s.smtpPort) || 587,
      secure: !!s.smtpSecure,
      user: String(s.smtpUser || '').trim(),
      pass: String(s.smtpPass || ''),
      to, from,
    };
  }
  // True when e-mail can actually be sent (module present, enabled, and addressed).
  function emailConfigured() {
    if (!nodemailer) return false;
    if (!getSettings().emailEnabled && !SMTP_URL) return false;
    const e = effectiveEmail();
    if (!e.to) return false;
    return SMTP_URL ? true : !!e.host;
  }
  // Builds (and caches) a nodemailer transport for the current config.
  function getMailer() {
    if (!nodemailer) return null;
    const e = effectiveEmail();
    const key = JSON.stringify([e.url || '', e.host || '', e.port || '', e.secure || false, e.user || '', e.pass || '']);
    if (mailerCache && mailerCache.key === key) return mailerCache.transport;
    const transport = e.url
      ? nodemailer.createTransport(e.url)
      : nodemailer.createTransport({
          host: e.host, port: e.port, secure: e.secure,
          auth: e.user ? { user: e.user, pass: e.pass } : undefined,
        });
    mailerCache = { key, transport };
    return transport;
  }
  // Sendable = transport reachable + a From address; a default recipient is only
  // needed for notifications (sendMail can be given an explicit recipient, e.g. the
  // "e-mail this link" action).
  function resetMailerCache() {
    const cached = mailerCache && mailerCache.transport;
    mailerCache = null;
    if (cached && typeof cached.close === 'function') { try { cached.close(); } catch (_) {} }
  }

  function emailSendable() {
    if (!nodemailer) return false;
    if (!getSettings().emailEnabled && !SMTP_URL) return false;
    const e = effectiveEmail();
    if (!e.from) return false;
    return SMTP_URL ? true : !!e.host;
  }
  // Sends one e-mail (best-effort). `toOverride` targets a specific recipient (the
  // "e-mail this link" action); without it, the configured notification recipient is
  // used. Returns { ok, error }.
  async function sendMail(subject, text, toOverride) {
    const e = effectiveEmail();
    const tx = getMailer();
    const to = (toOverride && String(toOverride).trim()) || e.to;
    if (!tx || !to || !e.from) { lastEmail = { at: Date.now(), ok: false, error: 'not-configured' }; return lastEmail; }
    try {
      await tx.sendMail({ from: e.from, to, subject, text });
      lastEmail = { at: Date.now(), ok: true, error: null };
    } catch (err) {
      lastEmail = { at: Date.now(), ok: false, error: err.message };
      console.error('[email] send failed:', err.message);
    }
    return lastEmail;
  }

  // Dispatches a notification to every configured channel (webhook + e-mail),
  // honoring the per-event toggles. `subject` is the e-mail subject line; the
  // webhook receives `message` (its single-string body) and structured `payload`.
  function dispatch(kind, subject, message, payload, opts = {}) {
    if (!notifyEnabled(kind)) return;
    payload = payload || {};
    const wh = effectiveWebhook();
    if (wh.url) sendWebhook(wh.url, wh.format, message, kind, payload);
    if (emailConfigured()) sendMail(subject, message);
    if (webPushActive() && !opts.suppressWebPush) {
      let accountIds = Array.isArray(opts.pushAccountIds) ? opts.pushAccountIds.map(String).filter(Boolean) : null;
      if (accountIds === null) {
        // Web Push subscriptions are personal/account-scoped. Never fan a share event
        // to every browser merely because webhook/e-mail are instance-wide channels.
        let share = null;
        if (payload.shareId) share = getById(String(payload.shareId));
        if (!share && payload.token) share = getByToken(String(payload.token));
        accountIds = share ? [notificationAccountIdForShare(share)].filter(Boolean) : notificationAdminAccountIds();
      }
      sendWebPush(kind, subject, message, payload, pushSubscriptionsForAccountIds(accountIds));
    }
  }

  // ===================================================================
  //  WEB PUSH (browser notifications) — optional (web-push module)
  // ===================================================================
  // VAPID keys are generated once and persisted in state.meta (encrypted at rest
  // with DATA_KEY). Subscriptions live in state.meta.pushSubs. Sending fans out to
  // every stored subscription; endpoints that report Gone (404/410) are pruned.

  // VAPID contact "sub": a mailto or https URI (push services require a valid one).
  // Prefer a configured e-mail, else fall back to a stable project URL.
  function vapidSubject() {
    const s = getSettings();
    const email = String(s.smtpFrom || s.smtpTo || process.env.EMAIL_FROM || process.env.EMAIL_TO || '').trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'mailto:' + email;
    return 'https://github.com/ManixQC/Direct-Xfer';
  }

  // Returns the VAPID key pair, generating and persisting it on first use.
  function getVapidKeys() {
    if (!webpush) return null;
    const meta = ensureMeta();
    const v = meta.vapid;
    if (v && v.publicKey && v.privateKey) return v;
    const keys = webpush.generateVAPIDKeys();
    const previous = meta.vapid;
    meta.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    if (!persistNow()) { if (previous) meta.vapid = previous; else delete meta.vapid; return null; }
    return meta.vapid;
  }

  function pushSubs() {
    const meta = ensureMeta();
    if (!Array.isArray(meta.pushSubs)) meta.pushSubs = [];
    return meta.pushSubs;
  }

  // Live channel = module present, VAPID keys exist, and at least one subscription.
  function webPushActive() {
    const root = currentState();
    return !!(webpush && root.meta && root.meta.vapid && pushSubs().length);
  }

  function dropPushSub(endpoint) {
    const subs = pushSubs();
    const i = subs.findIndex((x) => x.endpoint === endpoint);
    if (i !== -1) { subs.splice(i, 1); return true; }
    return false;
  }

  // Fans a notification out to a set of subscriptions (default: all). Fire-and-forget;
  // a Gone endpoint (404/410) is pruned so dead subscriptions never accumulate.
  function sendWebPush(kind, title, body, payload, subs) {
    if (!webpush) return 0;
    const keys = getVapidKeys();
    if (!keys) return 0;
    const targets = subs || pushSubs().slice();
    if (!targets.length) return 0;
    const data = JSON.stringify({
      title: title || APP_NAME,
      body: body || '',
      kind: kind || '',
      url: payload && payload.url ? String(payload.url) : '/',
      token: payload && payload.token ? String(payload.token) : null,
      testId: payload && payload.testId ? String(payload.testId).slice(0, 96) : null,
      openCenter: !!(payload && payload.openCenter),
      panel: payload && payload.panel ? String(payload.panel).slice(0, 32) : '',
      destinationUrl: payload && payload.destinationUrl ? String(payload.destinationUrl).slice(0, 4096) : '',
      ts: Date.now(),
    });
    const opts = { vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600, urgency: 'high', timeout: 15000 };
    for (const sub of targets) {
      webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, data, opts)
        .then(() => { try { noteCenterServiceState('web-push-delivery', true, 'Service Push rétabli'); } catch (_) {} })
        .catch((err) => {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) { noteExpiredPushSub(sub, code); if (dropPushSub(sub.endpoint)) persist(); }
          else {
            try { noteCenterServiceState('web-push-delivery', false, `Service Push indisponible${code ? ` (${code})` : ''}`); } catch (_) {}
            console.error('[webpush] send failed:', code || (err && err.message));
          }
        });
    }
    return targets.length;
  }

  // Same transport as sendWebPush(), but await one endpoint so the PWA's diagnostic
  // button can distinguish a browser-side subscription problem from a push-service
  // rejection. Never return subscription keys or the vendor response body to clients.
  async function sendWebPushAwaited(kind, title, body, payload, sub) {
    if (!webpush || !sub) return { ok: false, error: 'no-module', statusCode: 0, sentAt: 0 };
    const keys = getVapidKeys();
    if (!keys) return { ok: false, error: 'no-vapid', statusCode: 0, sentAt: 0 };
    const sentAt = Date.now();
    const data = JSON.stringify({
      title: title || APP_NAME,
      body: body || '',
      kind: kind || '',
      url: payload && payload.url ? String(payload.url) : '/',
      token: payload && payload.token ? String(payload.token) : null,
      testId: payload && payload.testId ? String(payload.testId).slice(0, 96) : null,
      openCenter: !!(payload && payload.openCenter),
      panel: payload && payload.panel ? String(payload.panel).slice(0, 32) : '',
      destinationUrl: payload && payload.destinationUrl ? String(payload.destinationUrl).slice(0, 4096) : '',
      ts: sentAt,
    });
    const opts = { vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 120, urgency: 'high', timeout: 15000 };
    try {
      const result = await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, data, opts);
      try { noteCenterServiceState('web-push-delivery', true, 'Service Push rétabli'); } catch (_) {}
      return { ok: true, statusCode: Number(result && result.statusCode) || 201, sentAt };
    } catch (err) {
      const statusCode = Number(err && err.statusCode) || 0;
      if (statusCode === 404 || statusCode === 410) { noteExpiredPushSub(sub, statusCode); if (dropPushSub(sub.endpoint)) persist(); }
      else {
        try { noteCenterServiceState('web-push-delivery', false, `Service Push indisponible${statusCode ? ` (${statusCode})` : ''}`); } catch (_) {}
        console.error('[webpush] awaited send failed:', statusCode || (err && err.message));
      }
      return { ok: false, error: statusCode === 404 || statusCode === 410 ? 'stale-subscription' : 'push-service-rejected', statusCode, sentAt };
    }
  }

  const DAY_MS = 86400000;

  // Proactive "link expiring soon" alerts. Once per link, within the
  // configured window before expiry, sends one webhook and stamps the share
  // (expiryWarnedAt) so the warning is never repeated.
  function checkExpiringShares() {
    const settings = getSettings();
    const now = Date.now();
    let changed = false;
    for (const sh of listShares()) {
      if (sh.revoked) continue;
      const own = sh.expiryReminderHours == null ? null : Number(sh.expiryReminderHours);
      const leadHours = own === 0 ? 0 : own > 0 ? own : (settings.notifyExpiring ? Math.max(1, Number(settings.expiryWarnHours) || 24) : 0);
      if (!leadHours) continue;
      const fixedDeadline = Number(sh.expiresAt) || 0;
      const firstUseDeadline = Number(shareFirstUseDeadline(sh)) || 0;
      const inactiveDeadline = Number(shareInactiveDeadline(sh)) || 0;
      const candidates = [];
      if (fixedDeadline > now) candidates.push({ kind: 'fixed', at: fixedDeadline, warned: !!sh.expiryWarnedAt });
      if (firstUseDeadline > now) candidates.push({ kind: 'first-use', at: firstUseDeadline, warned: Number(sh.firstUseExpiryWarnedDeadline) === firstUseDeadline });
      if (inactiveDeadline > now) candidates.push({ kind: 'inactive', at: inactiveDeadline, warned: Number(sh.inactiveExpiryWarnedDeadline) === inactiveDeadline });
      if (!candidates.length) continue;
      candidates.sort((a, b) => a.at - b.at);
      const deadline = candidates[0];
      if (deadline.warned) continue;
      const windowMs = leadHours * 3600 * 1000;
      if (deadline.at - now > windowMs) continue;
      if (!isActive(sh, now)) continue; // scheduled / quota-exhausted → skip
      const hrs = Math.max(1, Math.round((deadline.at - now) / 3600000));
      const when = new Date(deadline.at).toISOString();
      const message = `⏳ ${APP_NAME} — Link expiring in ~${hrs}h: "${sh.name}" (${when})`;
      dispatch('expiring', `${APP_NAME} — Link expiring soon: ${sh.name}`, message, {
        name: sh.name, token: sh.token, shareId: sh.id, type: sh.type, expiresAt: deadline.at, hoursLeft: hrs, reason: deadline.kind,
      });
      addShareCenterNotification(sh, 'link-expiring-soon', { expiresAt:deadline.at, count:hrs, reason:deadline.kind, dedupeKey:`expiring:${sh.id}:${deadline.at}` });
      if (deadline.kind === 'inactive') sh.inactiveExpiryWarnedDeadline = deadline.at;
      else if (deadline.kind === 'first-use') sh.firstUseExpiryWarnedDeadline = deadline.at;
      else sh.expiryWarnedAt = now;
      changed = true;
    }
    if (changed) persist();
  }

  // Reads the transfer journal and sums activity since `sinceTs`: overall totals
  // plus per-link volume. Best-effort; a missing/rotated journal yields zeros.
  function aggregateJournalSince(sinceTs) {
    const out = { transfers: 0, bytes: 0, up: 0, down: 0, perLink: new Map() };
    // Bounded tail read (matches the pre-existing 40000-line cap) so the digest never
    // loads a huge journal fully into memory.
    let lines = readLogTail(16 * 1024 * 1024);
    if (lines.length > 40000) lines = lines.slice(-40000);
    for (const line of lines) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch (_) { continue; }
      const ts = r.endedAt || r.startedAt || 0;
      if (ts < sinceTs) continue;
      const bytes = r.bytes || 0;
      out.transfers += 1;
      out.bytes += bytes;
      if (r.direction === 'up') out.up += bytes; else out.down += bytes;
      const key = r.shareId || r.name || '?';
      const name = r.name || (r.shareId ? String(r.shareId) : '?');
      const cur = out.perLink.get(key) || { name, bytes: 0, count: 0 };
      cur.bytes += bytes; cur.count += 1;
      out.perLink.set(key, cur);
    }
    return out;
  }

  // Periodic activity digest. Sends a recap over the webhook every
  // `digestDays` days (cadence tracked in state.meta.lastDigestAt). `force` bypasses
  // both the enabled flag and the cadence (used by the "send now" test button).
  function maybeSendDigest(force) {
    const s = getSettings();
    if (!force && !s.digestEnabled) return { skipped: 'disabled' };
    if (!effectiveWebhook().url && !emailConfigured()) return { skipped: 'no-channel' };
    const now = Date.now();
    const everyMs = Math.max(1, Number(s.digestDays) || 7) * DAY_MS;
    const root = currentState();
    const last = (root.meta && root.meta.lastDigestAt) || 0;
    if (!force && last && now - last < everyMs) return { skipped: 'not-due' };

    const since = last || now - everyMs;
    const agg = aggregateJournalSince(since);
    const topLinks = [...agg.perLink.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    const soonMs = 7 * DAY_MS;
    const expiring = listShares()
      .filter((sh) => sh.expiresAt && sh.expiresAt > now && sh.expiresAt - now <= soonMs && isActive(sh, now))
      .sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 8)
      .map((sh) => ({ name: sh.name, expiresAt: sh.expiresAt }));

    const days = Math.round((now - since) / DAY_MS) || Number(s.digestDays) || 7;
    const lines = [
      `📊 ${APP_NAME} — Activity digest (last ${days}d)`,
      `• Transfers: ${agg.transfers} · Volume: ${formatBytes(agg.bytes)} (↓ ${formatBytes(agg.down)} / ↑ ${formatBytes(agg.up)})`,
    ];
    if (topLinks.length) {
      lines.push('• Top links: ' + topLinks.map((l) => `${l.name} (${formatBytes(l.bytes)})`).join(', '));
    }
    if (expiring.length) {
      lines.push('• Expiring soon: ' + expiring.map((e) => `${e.name} (${new Date(e.expiresAt).toISOString().slice(0, 10)})`).join(', '));
    } else {
      lines.push('• Expiring soon: none');
    }
    const message = lines.join('\n');
    dispatch('digest', `${APP_NAME} — Activity digest`, message, {
      days, transfers: agg.transfers, bytes: agg.bytes, up: agg.up, down: agg.down,
      topLinks, expiring,
    });
    const meta = ensureMeta();
    meta.lastDigestAt = now;
    persist();
    return { ok: true, transfers: agg.transfers, bytes: agg.bytes };
  }


  function getLastWebhook() { return lastWebhook; }
  function getLastEmail() { return lastEmail; }
  function clearRuntimeState() {
    for (const b of notifyBuckets.values()) if (b && b.timer) { try { clearTimeout(b.timer); } catch (_) {} }
    notifyBuckets.clear();
    leakTrackers.clear();
    resetMailerCache();
    lastWebhook = null;
    lastEmail = null;
  }

  return {
    autoWebhookFormat, effectiveWebhook, sendWebhook, notifyEnabled, notify, emitNotify,
    pruneLeakTrackers, noteLeakSignal, effectiveEmail, emailConfigured, resetMailerCache, emailSendable,
    sendMail, dispatch, vapidSubject, getVapidKeys, pushSubs, webPushActive, dropPushSub,
    sendWebPush, sendWebPushAwaited, checkExpiringShares, aggregateJournalSince, maybeSendDigest,
    getLastWebhook, getLastEmail, clearRuntimeState,
  };
}

module.exports = { createNotificationService };
