'use strict';

const PRESET_TYPES = new Set(['inbox', 'collab', 'file', 'folder']);
const PRESET_MAX_PER_ACCOUNT = 50;
const PRESET_CONFIG_MAX_KEYS = 60;
const PRESET_CONFIG_MAX_BYTES = 4096;
const PRESET_RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function presetAccountId(req) {
  return (req.session && req.session.accountId) || '__global__';
}

function decoratePreset(preset) {
  const safeConfig = sanitizePresetConfig(preset && preset.config);
  return {
    id: preset && preset.id,
    name: preset && preset.name,
    type: preset && preset.type,
    config: safeConfig || {},
    createdAt: (preset && preset.createdAt) || 0,
  };
}

function sanitizePresetConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Request JSON normally produces plain objects, but restored/legacy state may
  // contain unusual keys. Never retain prototype-control names because a future
  // Object.assign()-style consumer could otherwise turn a harmless preset into a
  // prototype mutation primitive.
  const out = {};
  let keys = 0;
  for (const key of Object.keys(raw)) {
    if (keys >= PRESET_CONFIG_MAX_KEYS) break;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key) || PRESET_RESERVED_KEYS.has(key)) continue;
    const value = raw[key];
    if (typeof value === 'string') out[key] = value.slice(0, 400);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else continue;
    keys += 1;
  }
  if (!keys) return null;
  const json = JSON.stringify(out);
  // The constant is a byte budget for the persisted UTF-8 JSON, not a UTF-16
  // JavaScript character count. Multibyte preset values must not bypass it.
  if (Buffer.byteLength(json, 'utf8') > PRESET_CONFIG_MAX_BYTES) return null;
  return out;
}

/**
 * Registers settings, presets and notification-channel administration routes.
 *
 * Route modules receive domain services/helpers from server.js. Mutable persisted
 * state is resolved per request through getState(), so backup restore cannot leave
 * handlers bound to a stale state object.
 */
function attachAdminSettingsRoutes(deps = {}) {
  const {
    APP_NAME,
    WEBHOOK_URL,
    addCenterNotification,
    adminRouter,
    auditReq,
    autoWebhookFormat,
    bumpHistoryViewRevision,
    computeSettingsPatch,
    crypto,
    effectiveWebhook,
    emailConfigured,
    getSettings,
    getState,
    getVapidKeys,
    maybeSendDigest,
    nodemailer,
    persistNow,
    pruneHistory,
    pushSubs,
    pushSubAccountIds,
    pushSubscriptionsForAccountIds,
    recordUndoable,
    requireFullAdmin,
    rollbackRecordedUndo,
    sendLocalCaCertificate,
    sendMail,
    sendWebPush,
    sendWebhook,
    setSettingsDurable,
    settingsForClient,
    webpush,
  } = deps;

  if (!adminRouter || typeof adminRouter.get !== 'function') throw new TypeError('attachAdminSettingsRoutes requires adminRouter');
  if (typeof getState !== 'function') throw new TypeError('attachAdminSettingsRoutes requires getState()');
  if (typeof pushSubAccountIds !== 'function') throw new TypeError('attachAdminSettingsRoutes requires pushSubAccountIds()');
  if (typeof setSettingsDurable !== 'function') throw new TypeError('attachAdminSettingsRoutes requires setSettingsDurable()');
  const state = new Proxy(Object.create(null), {
    get(_target, prop) { const current = getState(); return current ? current[prop] : undefined; },
    set(_target, prop, value) { const current = getState(); if (!current) throw new Error('admin state unavailable'); current[prop] = value; return true; },
    has(_target, prop) { const current = getState(); return !!current && prop in current; },
    ownKeys() { const current = getState(); return current ? Reflect.ownKeys(current) : []; },
    getOwnPropertyDescriptor(_target, prop) {
      const current = getState();
      if (!current || !Object.prototype.hasOwnProperty.call(current, prop)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: current[prop] };
    },
  });

  function linkPresets() {
    if (!state.meta || typeof state.meta !== 'object' || Array.isArray(state.meta)) state.meta = {};
    if (!Array.isArray(state.meta.linkPresets)) state.meta.linkPresets = [];
    return state.meta.linkPresets;
  }

  adminRouter.post('/ip-names', (req, res) => {
    const b = req.body || {};
    const ip = String(b.ip || '').trim();
    if (!ip) return res.status(400).json({ error: 'missing-ip' });
    const name = String(b.name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
    if (getSettings().keepIpNames === false) return res.json({ ok: true, ip, name: null, disabled: true });
    if (!state.ipNames || typeof state.ipNames !== 'object') state.ipNames = {};
    const before = JSON.parse(JSON.stringify(state.ipNames));
    if (name) state.ipNames[ip] = name; else delete state.ipNames[ip];
    if (!persistNow()) { state.ipNames = before; return res.status(503).json({ error:'write-error' }); }
    bumpHistoryViewRevision();
    auditReq(req, name ? 'ip-named' : 'ip-unnamed', ip + (name ? ' → ' + name : ''));
    res.json({ ok: true, ip, name: name || null });
  });
  
  adminRouter.delete('/ip-names', (req, res) => {
    const n = state.ipNames ? Object.keys(state.ipNames).length : 0;
    const before = state.ipNames || {};
    state.ipNames = {};
    const undoEntry = n ? recordUndoable(req, 'ip-names-cleared', n + ' nickname(s)', { kind: 'ip-names', before, after: {} }) : null;
    if (!persistNow()) { state.ipNames = before; rollbackRecordedUndo(undoEntry); return res.status(503).json({ error:'write-error' }); }
    bumpHistoryViewRevision();
    auditReq(req, 'ip-names-cleared', n + ' nickname(s)');
    res.json({ ok: true, cleared: n });
  });
  
  adminRouter.get('/presets', (req, res) => {
    const acc = presetAccountId(req);
    const type = String(req.query.type || '').trim();
    const mine = linkPresets().filter((p) => p && p.accountId === acc && (!type || p.type === type));
    res.json({ presets: mine.map(decoratePreset) });
  });
  
  adminRouter.post('/presets', (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
    const type = String(body.type || '').trim();
    if (!name) return res.status(400).json({ error: 'missing-name' });
    if (!PRESET_TYPES.has(type)) return res.status(400).json({ error: 'invalid-type' });
    const config = sanitizePresetConfig(body.config);
    if (!config) return res.status(400).json({ error: 'invalid-config' });
    const acc = presetAccountId(req);
    const list = linkPresets();
    const beforePresets = JSON.parse(JSON.stringify(list));
    // Re-saving under an existing name overwrites it instead of piling up duplicates.
    const existingIdx = list.findIndex((p) => p && p.accountId === acc && p.type === type && String(p.name).toLowerCase() === name.toLowerCase());
    if (existingIdx === -1 && list.filter((p) => p && p.accountId === acc).length >= PRESET_MAX_PER_ACCOUNT) {
      return res.status(409).json({ error: 'too-many-presets' });
    }
    const preset = { id: crypto.randomBytes(8).toString('hex'), accountId: acc, name, type, config, createdAt: Date.now() };
    if (existingIdx !== -1) { preset.id = list[existingIdx].id; preset.createdAt = list[existingIdx].createdAt; list[existingIdx] = preset; }
    else list.push(preset);
    if (!persistNow()) { state.meta.linkPresets = beforePresets; return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'link-preset-saved', type + ': ' + name);
    res.status(201).json({ preset: decoratePreset(preset) });
  });
  
  adminRouter.delete('/presets/:id', (req, res) => {
    const acc = presetAccountId(req);
    const list = linkPresets();
    const idx = list.findIndex((p) => p && p.id === req.params.id && p.accountId === acc);
    if (idx === -1) return res.status(404).json({ error: 'not-found' });
    const [removed] = list.splice(idx, 1);
    if (!persistNow()) { list.splice(idx, 0, removed); return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'link-preset-deleted', (removed.type || '') + ': ' + (removed.name || ''));
    res.json({ ok: true });
  });
  
  adminRouter.get('/settings', (req, res) => {
    if (req.session.role === 'operator') return res.status(403).json({ error:'forbidden' });
    res.json(settingsForClient(req, String(req.query && req.query.lite || '') === '1'));
  });
  
  adminRouter.post('/settings', (req, res) => {
    const r = computeSettingsPatch(req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    const patch = r.patch;
    const prevSettings = getSettings();
    const undoBefore = {}; for (const k of Object.keys(patch)) undoBefore[k] = prevSettings[k];
    // Record before the durable settings write so the state mutation and its Undo
    // descriptor land in the same atomic store replacement. Oversized snapshots
    // (notably a custom logo data URL) stay applied but deliberately non-undoable.
    let undoEntry = null;
    if (Object.keys(patch).length && JSON.stringify(undoBefore).length <= 65536) {
      undoEntry = recordUndoable(req, 'settings-changed', Object.keys(patch).join(', '), { kind: 'settings', before: undoBefore, after: patch });
    }
    const historyBefore = Array.isArray(state.history) ? state.history.slice() : [];
    const saved = setSettingsDurable(patch, {
      beforePersist: () => {
        if (patch.historyRetentionDays !== undefined) pruneHistory();
      },
    });
    if (!saved) {
      state.history = historyBefore;
      rollbackRecordedUndo(undoEntry);
      addCenterNotification(req.session.accountId,'config-save-failed',{detail:'Configuration non enregistrée: écriture durable impossible',dedupeKey:`config-save-failed:${Math.floor(Date.now()/3600000)}`,dedupeWindowMs:3600000});
      return res.status(503).json({ error:'write-error', persisted:false });
    }
    if (patch.anonymizeIps !== undefined || patch.keepIpNames !== undefined) bumpHistoryViewRevision();
    auditReq(req, 'settings-changed', Object.keys(patch).join(', '));
    res.json({ ...settingsForClient(req), persisted: true });
  });
  
  adminRouter.get('/tls/local-ca.cer', requireFullAdmin, sendLocalCaCertificate);
  
  adminRouter.get('/settings/export', requireFullAdmin, (req, res) => {
    const s = getSettings();
    delete s.pwChanged;
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-settings-${stamp}.json"`);
    auditReq(req, 'settings-exported', '');
    res.send(JSON.stringify({ app: APP_NAME, exportedAt: Date.now(), settings: s }, null, 2));
  });
  
  adminRouter.post('/settings/import', (req, res) => {
    const body = req.body || {};
    const incoming = (body && typeof body.settings === 'object' && body.settings) ? body.settings : body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'invalid-file' });
    const r = computeSettingsPatch(incoming);
    if (r.error) return res.status(400).json({ error: r.error });
    const historyBefore = Array.isArray(state.history) ? state.history.slice() : [];
    if (!setSettingsDurable(r.patch, { beforePersist: () => pruneHistory() })) {
      state.history = historyBefore;
      addCenterNotification(req.session.accountId,'config-save-failed',{detail:'Import de configuration non enregistré: écriture durable impossible',dedupeKey:`config-save-failed:import:${Math.floor(Date.now()/3600000)}`,dedupeWindowMs:3600000});
      return res.status(503).json({ error:'write-error', persisted:false });
    }
    if (r.patch.anonymizeIps !== undefined || r.patch.keepIpNames !== undefined) bumpHistoryViewRevision();
    auditReq(req, 'settings-imported', Object.keys(r.patch).length + ' key(s)');
    res.json({ ...settingsForClient(req), persisted: true, imported: Object.keys(r.patch).length });
  });
  
  adminRouter.post('/webhook-test', async (req, res) => {
    const body = req.body || {};
    const eff = effectiveWebhook();
    const url = (WEBHOOK_URL || String(body.url || '').trim() || eff.url); // env wins
    if (!url) return res.status(400).json({ error: 'no-url' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid-webhook' });
    const format = WEBHOOK_URL ? eff.format : (String(body.format || '') || autoWebhookFormat(url));
    const result = await sendWebhook(url, format === 'auto' ? '' : format, `✅ ${APP_NAME} — webhook test OK`, 'test', {});
    auditReq(req, 'webhook-tested', result && result.ok ? 'ok' : 'failed');
    res.json(result);
  });
  
  adminRouter.post('/digest-test', (req, res) => {
    const r = maybeSendDigest(true);
    if (r && r.skipped === 'no-channel') { auditReq(req, 'digest-tested', 'no-channel'); return res.status(400).json({ error: 'no-channel' }); }
    auditReq(req, 'digest-tested', r && r.ok === false ? 'failed' : 'ok');
    res.json(r || { ok: true });
  });
  
  adminRouter.post('/email-test', async (req, res) => {
    if (!nodemailer) return res.status(400).json({ error: 'no-module' });
    if (!emailConfigured()) return res.status(400).json({ error: 'not-configured' });
    const r = await sendMail(`${APP_NAME} — e-mail test OK`, `✅ ${APP_NAME}: your SMTP notification settings work.`);
    auditReq(req, 'email-tested', r && r.ok ? 'ok' : String(r && r.error || 'send-failed').slice(0,120));
    if (r && r.ok) res.json({ ok: true });
    else res.status(400).json({ error: r && r.error ? r.error : 'send-failed' });
  });
  
  adminRouter.get('/push/vapid', (req, res) => {
    if (!webpush) return res.status(400).json({ error: 'no-module' });
    const keys = getVapidKeys();
    if (!keys) return res.status(503).json({ error:'write-error' });
    res.json({ publicKey: keys.publicKey, subs: pushSubscriptionsForAccountIds([req.session.accountId]).length });
  });
  
  adminRouter.post('/push/subscribe', (req, res) => {
    if (!webpush) return res.status(400).json({ error: 'no-module' });
    const sub = req.body && req.body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'invalid-subscription' });
    }
    const subs = pushSubs();
    const beforeSubs = JSON.parse(JSON.stringify(subs));
    const rec = {
      endpoint: sub.endpoint.slice(0, 2000),
      keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) },
      accountId: req.session.accountId || null,
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
      createdAt: Date.now(),
    };
    const i = subs.findIndex((x) => x.endpoint === rec.endpoint);
    if (i !== -1) subs[i] = { ...subs[i], ...rec }; else subs.push(rec);
    if (subs.length > 200) subs.splice(0, subs.length - 200); // sane cap
    if (!persistNow()) { state.meta.pushSubs = beforeSubs; return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'push-subscribed', rec.ua);
    res.json({ ok: true, subs: subs.length });
  });
  
  adminRouter.post('/push/unsubscribe', (req, res) => {
    const endpoint = String((req.body && req.body.endpoint) || '').trim();
    if (!endpoint) return res.status(400).json({ error: 'missing-endpoint' });
    const subs = pushSubs();
    const i = subs.findIndex((sub) => sub && sub.endpoint === endpoint && pushSubAccountIds(sub).includes(String(req.session.accountId)));
    const removed = i >= 0;
    if (removed) {
      const [previous] = subs.splice(i, 1);
      if (!persistNow()) { subs.splice(i, 0, previous); return res.status(503).json({ error:'write-error' }); }
      auditReq(req, 'push-unsubscribed', '');
    }
    res.json({ ok: true, removed });
  });
  
  adminRouter.post('/push/test', (req, res) => {
    if (!webpush) return res.status(400).json({ error: 'no-module' });
    const mine = pushSubscriptionsForAccountIds([req.session.accountId]);
    if (!mine.length) return res.status(400).json({ error: 'no-subscription' });
    const sent = sendWebPush('test', `${APP_NAME} — test`, '🔔 Web Push notifications are working.', null, mine);
    auditReq(req, 'push-tested', `sent=${sent}`);
    res.json({ ok: true, sent });
  });
}

module.exports = { attachAdminSettingsRoutes };
