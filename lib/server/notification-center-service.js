'use strict';

/**
 * In-app notification center domain: durable per-account history, deduplication,
 * category preferences, custom threshold rules, traffic/security heuristics and
 * system-health/lifecycle notifications. Transport delivery stays in
 * notification-service.js; browser/PWA delivery stays in pwa-notification-service.js.
 *
 * Dependencies are explicit and restored state is resolved through getState() so
 * a backup restore cannot leave this service attached to an obsolete root object.
 */
function createNotificationCenterService(deps) {
  const {
    APP_VERSION, DATA_DIR, PUBLIC_URL, TRUST_PROXY, STORAGE_SETUP,
    getState, getSettings, scheduleFlush, persist, persistNow,
    accountList, getAccountById, shareOwnerAccount,
    getPwaDevice, pwaDeviceCreatorAccount, pwaDeviceOwnerAccount, pwaDeviceResolvedAccount, pwaDevices,
    getById, getByToken, listShares, isActive, shareEffectiveExpiry, decorateShare,
    formatBytes, flagFromCode, pubIp, parseMaxVisitors, centerPublicVisitorDeviceLabel,
    pendingUsageForShare, photoStatsOf, dataWritable, emitLiveActivity, checkExpiringShares,
    pushSubs, getActiveTransfers, getSearchIndexError, getAuditKeyMigrationStatus,
    webPushAvailable, getDlpOcrUnavailableNotedAt,
  } = deps;
  const fs = require('fs');
  const crypto = require('crypto');
  const DAY_MS = 86400000;

  // Preserve the original field-oriented implementation while always targeting
  // the current restored root state. Accesses such as state.meta are forwarded.
  const state = new Proxy(Object.create(null), {
    get(_target, key) { const root = getState(); return root ? root[key] : undefined; },
    set(_target, key, value) { const root = getState(); if (!root) throw new Error('notification-state-unavailable'); root[key] = value; return true; },
  });

const NOTIFICATION_CENTER_MAX_PER_ACCOUNT = 500;
const NOTIFICATION_DEDUPE_MAX_PER_ACCOUNT = 5000;
function centerDedupeDefaultWindow(type) {
  const map = {
    'system-problem': 6 * 3600 * 1000,
    'admin-login-unusual': 30 * 24 * 3600 * 1000,
    'dlp-detected': 2 * 60 * 1000,
    'dlp-blocked': 2 * 60 * 1000,
    'ocr-failed': 6 * 3600 * 1000,
    'index-failed': 6 * 3600 * 1000,
  };
  return Math.max(0, Number(map[type]) || 0);
}
function notificationDedupeStore() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!state.meta.notificationDedupe || typeof state.meta.notificationDedupe !== 'object' || Array.isArray(state.meta.notificationDedupe)) {
    state.meta.notificationDedupe = {};
    // Seed the independent ledger from currently-visible notifications so deleting
    // an existing alert after an upgrade does not immediately make it reappear.
    for (const n of Array.isArray(state.meta.notifications) ? state.meta.notifications : []) {
      if (!n || !n.accountId || !n.dedupeKey) continue;
      const accountId = String(n.accountId), dedupeKey = String(n.dedupeKey).slice(0, 240);
      const id = crypto.createHash('sha256').update(accountId + '\0' + dedupeKey).digest('hex');
      state.meta.notificationDedupe[id] = {
        accountId, dedupeKey, at: Math.max(0, Number(n.at) || Date.now()),
        windowMs: Math.max(0, Number(n.dedupeWindowMs) || centerDedupeDefaultWindow(n.type)),
      };
    }
  }
  const now = Date.now(), rows = Object.entries(state.meta.notificationDedupe).filter(([, r]) => r && r.accountId && r.dedupeKey);
  // `link-unused` is one alert per inactivity spell. Older builds stored a 7-day
  // window, which made the same untouched link reappear every week after deletion.
  for (const [, r] of rows) if (String(r.dedupeKey || '').startsWith('unused:')) r.windowMs = 0;
  // Expired windowed entries no longer suppress a genuinely new event.
  for (const [id, r] of rows) {
    const windowMs = Math.max(0, Number(r.windowMs) || 0);
    if (windowMs > 0 && now - Math.max(0, Number(r.at) || 0) > windowMs) delete state.meta.notificationDedupe[id];
  }
  // Bound permanent/active dedupe history per account independently.
  const byAccount = new Map();
  for (const [id, r] of Object.entries(state.meta.notificationDedupe)) {
    const key = String(r.accountId || ''); if (!key) { delete state.meta.notificationDedupe[id]; continue; }
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push([id, r]);
  }
  for (const rows2 of byAccount.values()) {
    rows2.sort((a,b) => Number(b[1].at || 0) - Number(a[1].at || 0));
    for (const [id] of rows2.slice(NOTIFICATION_DEDUPE_MAX_PER_ACCOUNT)) delete state.meta.notificationDedupe[id];
  }
  return state.meta.notificationDedupe;
}
function notificationDedupeId(accountId, dedupeKey) {
  return crypto.createHash('sha256').update(String(accountId) + '\0' + String(dedupeKey)).digest('hex');
}
function notificationDedupeSeen(accountId, dedupeKey, now, windowMs) {
  const store = notificationDedupeStore();
  const id = notificationDedupeId(accountId, dedupeKey), prev = store[id];
  windowMs = Math.max(0, Number(windowMs) || 0); now = Math.max(0, Number(now) || Date.now());
  if (prev) {
    const prevAt = Math.max(0, Number(prev.at) || 0);
    if (windowMs === 0 || now - prevAt <= windowMs) return true;
  }
  store[id] = { accountId:String(accountId), dedupeKey:String(dedupeKey).slice(0,240), at:now, windowMs };
  return false;
}
function clearNotificationDedupeForAccount(accountId) {
  accountId = String(accountId || '');
  const store = notificationDedupeStore();
  let removed = 0;
  for (const [id, r] of Object.entries(store)) if (String(r.accountId) === accountId) { delete store[id]; removed += 1; }
  return removed;
}
const NOTIFICATION_READ_STATE_VERSION = 1;
const NOTIFICATION_CATEGORY_SCHEMA_VERSION = 3;
const NOTIFICATION_ACTIVITY_CATEGORY_BY_TYPE = {
  'new-country':'visitors', 'visitor-device-new':'visitors',
  'view-threshold':'thresholds', 'download-threshold':'thresholds',
  'high-download-volume':'traffic', 'link-viral':'traffic',
};
const NOTIFICATION_SYSTEM_CATEGORY_BY_TYPE = {
  'system-problem':'system_health', 'service-unavailable':'system_health', 'service-restored':'system_health',
  'config-save-failed':'system_health', 'server-crash-recovered':'system_health',
  'retention-file-deleted':'maintenance', 'cleanup-complete':'maintenance',
  'public-ip-changed':'network',
  'server-restarted':'restarts', 'server-clean-shutdown':'restarts',
  'update-available':'updates', 'update-installed':'updates',
};
function migratedNotificationCategory(n) {
  const category = String((n && n.category) || 'system_health');
  const type = String((n && n.type) || '');
  if (category === 'activity') return NOTIFICATION_ACTIVITY_CATEGORY_BY_TYPE[type] || 'traffic';
  if (category === 'system') return NOTIFICATION_SYSTEM_CATEGORY_BY_TYPE[type] || 'system_health';
  return category;
}
function notificationCenterStore() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  const before = Array.isArray(state.meta.notifications) ? state.meta.notifications : [];
  // One-time migration: notifications created by versions that did not know about
  // Lu/Non-lu are historical, not newly-arrived alerts. Mark them read so upgrading
  // does not suddenly show a badge of hundreds of old notifications. Once the
  // marker is stored, any future row lacking readAt is intentionally considered new.
  let readStateMigrated = false;
  if (Number(state.meta.notificationReadStateVersion || 0) < NOTIFICATION_READ_STATE_VERSION) {
    const migratedAt = Date.now();
    for (const n of before) if (n && n.id && n.accountId && !(Number(n.readAt) > 0)) n.readAt = Math.max(1, Number(n.at) || migratedAt);
    state.meta.notificationReadStateVersion = NOTIFICATION_READ_STATE_VERSION;
    readStateMigrated = true;
  }
  // Category migrations: 1.44.1 split Activity into Visitors/Thresholds/Traffic;
  // 1.44.3 splits the former broad System bucket into system health, maintenance,
  // network, restarts and updates. Reclassify stored rows once so filters and
  // per-account preferences remain coherent after an upgrade.
  let categorySchemaMigrated = false;
  // Normalize legacy categories defensively on every restored-store pass, not only
  // while advancing the schema marker. A backup/import can reintroduce an old
  // `activity` or `system` row after this instance already recorded schema v3;
  // leaving it untouched makes the row disappear from the new category filters.
  for (const n of before) {
    if (!n) continue;
    const currentCategory = String(n.category || 'system_health');
    const nextCategory = migratedNotificationCategory(n);
    if (nextCategory !== currentCategory) { n.category = nextCategory; categorySchemaMigrated = true; }
  }
  if (Number(state.meta.notificationCategorySchemaVersion || 0) < NOTIFICATION_CATEGORY_SCHEMA_VERSION) {
    state.meta.notificationCategorySchemaVersion = NOTIFICATION_CATEGORY_SCHEMA_VERSION;
    categorySchemaMigrated = true;
  }
  // Defensive normalization for restored/legacy stores. The cap is PER account:
  // a noisy account must never evict another account's notification history.
  const valid = before.filter((n) => n && n.id && n.accountId);
  valid.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  const counts = new Map();
  const normalized = valid.filter((n) => {
    const key = String(n.accountId);
    const count = counts.get(key) || 0;
    if (count >= NOTIFICATION_CENTER_MAX_PER_ACCOUNT) return false;
    counts.set(key, count + 1);
    return true;
  });
  const changed = readStateMigrated || categorySchemaMigrated || !Array.isArray(state.meta.notifications) || normalized.length !== before.length || normalized.some((n, i) => before[i] !== n);
  state.meta.notifications = normalized;
  // A GET used to clean an oversized/corrupt restored store only in RAM. If the
  // process restarted before another unrelated mutation, discarded rows returned.
  if (changed) scheduleFlush();
  return state.meta.notifications;
}
function trimNotificationCenterAccount(accountId, list = notificationCenterStore()) {
  accountId = String(accountId || '');
  if (!accountId) return list;
  let seen = 0;
  state.meta.notifications = list.filter((n) => {
    if (String(n.accountId) !== accountId) return true;
    seen += 1;
    return seen <= NOTIFICATION_CENTER_MAX_PER_ACCOUNT;
  });
  return state.meta.notifications;
}
function notificationAccountIdForShare(s) {
  const account = shareOwnerAccount(s);
  return account && account.id ? String(account.id) : (s && s.ownerId ? String(s.ownerId) : null);
}
// Asynchronous GeoIP/push/transfer callbacks may outlive a backup restore. Never
// let an object detached from the current state create a ghost notification or
// contaminate in-memory traffic heuristics for a newly restored share with the
// same id. Direct-Xfer's live share paths use the canonical state object, so
// identity is a reliable and stricter guard than id/token equality here.
function currentShareRef(s) {
  if (!s || !s.id) return null;
  try { return getById(String(s.id)) === s ? s : null; } catch (_) { return null; }
}
function centerTrackerIpKey(rawIp) {
  const ip = String(rawIp || '').replace(/^::ffff:/i, '').trim();
  return ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32) : '';
}
function centerNotificationDefaults(type) {
  const map = {
    'image-first-view':['images','info'], 'share-first-download':['shares','success'], 'inbox-first-deposit':['receptions','success'],
    'transfer-complete':['transfers','success'], 'transfer-failed':['transfers','warning'], 'link-expired':['shares','warning'],
    'link-expiring-soon':['shares','warning'], 'download-limit-reached':['shares','warning'], 'reception-quota-reached':['receptions','warning'],
    'link-new-visitor':['shares','info'], 'new-country':['visitors','info'], 'view-threshold':['thresholds','success'],
    'download-threshold':['thresholds','success'], 'custom-alert-rule':['thresholds','success'], 'unusual-activity':['security','warning'], 'repeated-downloads':['security','warning'],
    'password-failures':['security','warning'], 'link-auto-disabled':['security','warning'], 'dlp-detected':['security','warning'],
    'dlp-blocked':['security','critical'], 'ocr-failed':['search','warning'], 'index-failed':['search','critical'],
    'pwa-device-paired':['pwa','success'], 'pwa-device-revoked':['pwa','warning'], 'admin-login':['security','info'],
    'admin-login-unusual':['security','warning'], 'system-problem':['system_health','critical'], 'update-available':['updates','info'],
    'update-installed':['updates','success'],
    'received-file-ready':['receptions','success'], 'download-abandoned':['transfers','warning'], 'upload-abandoned':['transfers','warning'],
    'resume-impossible':['transfers','warning'], 'protected-link-first-access':['security','info'], 'password-recovered':['security','success'],
    'visitor-device-new':['visitors','info'], 'simultaneous-downloads':['security','warning'], 'high-download-volume':['traffic','warning'],
    'link-viral':['traffic','warning'], 'link-unused':['shares','info'], 'shared-file-replaced':['shares','info'], 'image-full-replaced':['images','info'],
    'image-variant-regenerated':['images','success'], 'retention-file-deleted':['maintenance','info'], 'cleanup-complete':['maintenance','success'],
    'service-unavailable':['system_health','warning'], 'service-restored':['system_health','success'], 'config-save-failed':['system_health','critical'],
    'server-restarted':['restarts','info'], 'server-clean-shutdown':['restarts','info'], 'server-crash-recovered':['system_health','critical'],
    'public-ip-changed':['network','warning'], 'push-subscription-expired':['pwa','warning'], 'push-subscription-repaired':['pwa','success'],
    'push-permission-revoked':['pwa','warning'], 'security-anomaly':['security','critical'], 'auth-credential-changed':['security','warning'],
  };
  return map[type] || ['system_health','info'];
}
function notificationAdminAccountIds() {
  return accountList().filter((a) => a && (a.role === 'owner' || a.role === 'admin')).map((a) => String(a.id));
}
function notificationAccountIdsForRequest(req) {
  // /app deliberately gives a paired-device cookie precedence over a coincident
  // admin-session cookie. requireAppAuth can intentionally clear req.pwaDevice in
  // that mixed-cookie case, so resolve the dxpwa cookie again instead of silently
  // falling back to a different administrator session.
  let dev = req && req.pwaDevice;
  if (!dev && req && typeof getPwaDevice === 'function') {
    try { dev = getPwaDevice(req, false); } catch (_) { dev = null; }
  }
  if (dev) {
    const acc = pwaDeviceCreatorAccount(dev) || pwaDeviceOwnerAccount(dev.id);
    return acc && acc.id ? [String(acc.id)] : [];
  }
  const sess = req && (req.pwaSession || req.session);
  if (sess && sess.accountId) return [String(sess.accountId)];
  // Never broadcast a request-scoped alert when ownership cannot be resolved.
  return [];
}
function publicNotification(n) {
  return {
    id:n.id, type:n.type, at:n.at, category:n.category || 'system_health', severity:n.severity || 'info',
    // Respect the CURRENT privacy setting too. A notification created before IP
    // anonymization was enabled must not keep exposing its historical full IP.
    name:n.name || '', token:n.token || null, variant:n.variant || null, ip:n.ip ? pubIp(n.ip) : null, country:n.country || null, flag:n.flag || '🌐',
    bytes:Number(n.bytes)||0, count:Number(n.count)||0, limit:Number(n.limit)||0, threshold:Number(n.threshold)||0,
    expiresAt:Number(n.expiresAt)||0, reason:n.reason || null, detail:n.detail || null, sender:n.sender || null,
    device:n.device || null, username:n.username || null, version:n.version || null, latest:n.latest || null,
    source:n.source || null, action:n.action || null, url:n.url || null,
    durationMs:Math.max(0, Number(n.durationMs)||0), previous:n.previous || null, current:n.current || null,
    groupCount:Math.max(1, Number(n.groupCount)||1), groupFirstAt:Math.max(0, Number(n.groupFirstAt)||Number(n.at)||0),
    priority:n.priority || 'normal', priorityReason:n.priorityReason || null,
    readAt:Math.max(0, Number(n.readAt)||0), unread:!(Number(n.readAt)>0),
  };
}
function enrichCenterNotificationGeo(accountId, id, rawIp, geo) {
  if (!geo || !geo.country) return false;
  accountId = String(accountId || ''); id = String(id || '');
  if (!accountId || !id) return false;
  const rec = notificationCenterStore().find((n) => String(n.accountId) === accountId && String(n.id) === id);
  if (!rec) return false; // deletion while GeoIP was in flight must stay deleted
  let changed = false;
  if (!rec.country) { rec.country = String(geo.country).slice(0,100); changed = true; }
  const flag = geo.flag || flagFromCode(geo.countryCode) || null;
  if (flag && (!rec.flag || rec.flag === '🌐')) { rec.flag = String(flag).slice(0,16); changed = true; }
  if (!rec.ip && rawIp) { rec.ip = String(pubIp(String(rawIp).replace(/^::ffff:/i,'')) || '').slice(0,100) || null; changed = true; }
  if (changed) scheduleFlush();
  return changed;
}
// Categories an account may opt out of. Security, Maintenance and System health are
// deliberately excluded: critical security/maintenance/system-health alerts are never silenceable.
const NOTIFICATION_ACTIVITY_SPLIT_CATEGORIES = ['visitors','thresholds','traffic'];
const NOTIFICATION_MUTABLE_CATEGORIES = ['images','shares','receptions','transfers','search','pwa','visitors','thresholds','traffic','network','restarts','updates'];
function normalizeMutedNotificationCategories(list) {
  const raw = (Array.isArray(list) ? list : []).map(String);
  const expanded = raw.includes('activity') ? raw.concat(NOTIFICATION_ACTIVITY_SPLIT_CATEGORIES) : raw;
  return [...new Set(expanded.filter((c) => NOTIFICATION_MUTABLE_CATEGORIES.includes(c)))];
}
function accountMutedNotificationCategories(accountId) {
  const acc = getAccountById(String(accountId || ''));
  const raw = acc && Array.isArray(acc.notifMutedCategories) ? acc.notifMutedCategories : [];
  // Legacy 1.44.0 preference compatibility: muting Activity means all three new
  // subcategories stay muted until the user explicitly changes them. Persist the
  // normalized form too: 1.44.3 briefly allowed Maintenance to be muted, and merely
  // ignoring that stale value leaves account exports/backups carrying a preference
  // that the current UI can no longer represent.
  const clean = normalizeMutedNotificationCategories(raw);
  if (acc && (raw.length !== clean.length || raw.some((value, i) => String(value) !== clean[i]))) {
    acc.notifMutedCategories = clean;
    scheduleFlush();
  }
  return clean;
}
function notificationCategoryMuted(accountId, category) {
  category = String(category || '');
  if (!NOTIFICATION_MUTABLE_CATEGORIES.includes(category)) return false; // security/maintenance/system health always on
  return accountMutedNotificationCategories(accountId).includes(category);
}
function setAccountMutedNotificationCategories(accountId, list) {
  accountId = String(accountId || '');
  const acc = getAccountById(accountId);
  if (!acc) return null;
  const previous = Array.isArray(acc.notifMutedCategories) ? acc.notifMutedCategories.slice() : null;
  const previousClean = normalizeMutedNotificationCategories(previous || []);
  const clean = normalizeMutedNotificationCategories(list);
  const newlyMuted = new Set(clean.filter((category) => !previousClean.includes(category)));

  // Muting a category must take effect immediately, including for notifications
  // that were already queued/unread when the preference changed. Keep the rows as
  // history, but mark them read so re-enabling the category later cannot replay a
  // stale badge/sound/toast. The read-state mutation is persisted atomically with
  // the account preference and rolled back together if the store write fails.
  const changedReadState = [];
  if (newlyMuted.size) {
    const readAt = Date.now();
    for (const n of notificationCenterStore()) {
      if (!n || String(n.accountId) !== accountId || Number(n.readAt) > 0) continue;
      if (!newlyMuted.has(String(n.category || 'system_health'))) continue;
      changedReadState.push({ n, previous:n.readAt });
      n.readAt = readAt;
    }
  }

  acc.notifMutedCategories = clean;
  if (persistNow()) return clean;
  if (previous) acc.notifMutedCategories = previous; else delete acc.notifMutedCategories;
  for (const row of changedReadState) row.n.readAt = row.previous;
  return null;
}

// Account-scoped custom notification rules. Rules can target one
// owned link or every owned compatible link and fire once per link when the
// configured threshold is crossed. Runtime trigger state is kept on the account
// so restarts do not re-notify the same threshold.
const CUSTOM_NOTIFICATION_RULE_METRICS = ['views','downloads','bytes_served','received_bytes'];
const CUSTOM_NOTIFICATION_RULE_MAX = 50;
const CUSTOM_NOTIFICATION_RULE_TRIGGER_MAX = 5000;
function customNotificationMetricCompatible(metric, share) {
  if (!share) return false;
  if (metric === 'received_bytes') return share.type === 'inbox' || share.type === 'collab';
  if (metric === 'downloads' || metric === 'bytes_served') return !['inbox','collab','photo','album','secret'].includes(share.type);
  if (metric === 'views') return !['secret'].includes(share.type);
  return false;
}
function customNotificationMetricValue(metric, share) {
  if (!share) return 0;
  if (metric === 'views') return centerTotalViews(share);
  if (metric === 'downloads') return Math.max(0, Number(share.downloads) || 0);
  if (metric === 'bytes_served') return Math.max(0, Number(share.bytesServed) || 0);
  if (metric === 'received_bytes') {
    const pending = pendingUsageForShare(share);
    return Math.max(0, Number(share.bytesReceived) || 0) + Math.max(0, Number(pending.bytes) || 0);
  }
  return 0;
}
function normalizeCustomNotificationRule(raw, accountId) {
  if (!raw || typeof raw !== 'object') return null;
  const metric = String(raw.metric || '');
  if (!CUSTOM_NOTIFICATION_RULE_METRICS.includes(metric)) return null;
  const threshold = Math.max(0, Math.floor(Number(raw.threshold) || 0));
  if (!threshold || !Number.isSafeInteger(threshold)) return null;
  const shareId = raw.shareId ? String(raw.shareId).slice(0, 120) : null;
  const id = raw.id ? String(raw.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : crypto.randomBytes(9).toString('hex');
  const triggered = {};
  if (raw.triggered && typeof raw.triggered === 'object' && !Array.isArray(raw.triggered)) {
    const entries = Object.entries(raw.triggered)
      .filter(([key, at]) => key && Number(at) > 0)
      .sort((a,b) => Number(b[1]) - Number(a[1]))
      .slice(0, CUSTOM_NOTIFICATION_RULE_TRIGGER_MAX);
    for (const [key, at] of entries) triggered[String(key).slice(0,120)] = Math.max(0, Number(at) || 0);
  }
  return {
    id, accountId:String(accountId || ''), metric, threshold, shareId,
    label:String(raw.label || '').replace(/[\r\n\t]+/g,' ').trim().slice(0,100),
    enabled:raw.enabled !== false,
    createdAt:Math.max(0, Number(raw.createdAt) || Date.now()),
    updatedAt:Math.max(0, Number(raw.updatedAt) || Number(raw.createdAt) || Date.now()),
    triggered,
  };
}
function accountCustomNotificationRules(accountId) {
  const acc = getAccountById(String(accountId || ''));
  if (!acc) return [];
  const raw = Array.isArray(acc.notificationRules) ? acc.notificationRules : [];
  const clean = raw.map((r) => normalizeCustomNotificationRule(r, acc.id)).filter(Boolean).slice(0, CUSTOM_NOTIFICATION_RULE_MAX);
  const changed = !Array.isArray(acc.notificationRules) || JSON.stringify(raw) !== JSON.stringify(clean);
  if (changed) {
    acc.notificationRules = clean;
    scheduleFlush();
  } else if (!Array.isArray(acc.notificationRules)) {
    acc.notificationRules = clean;
  }
  // Return the account-owned objects, not the freshly normalized copies. Runtime
  // trigger mutations must land on state.accounts so scheduleFlush()/persistNow()
  // can actually preserve them across restarts and dedupe-store maintenance.
  return acc.notificationRules;
}
function publicCustomNotificationRule(rule) {
  return { id:rule.id, metric:rule.metric, threshold:rule.threshold, shareId:rule.shareId || null, label:rule.label || '', enabled:rule.enabled !== false, createdAt:rule.createdAt, updatedAt:rule.updatedAt };
}
function customNotificationRuleTargets(accountId) {
  accountId = String(accountId || '');
  const now = Date.now();
  return listShares().filter((share) => share && !share.revoked && isActive(share, now) && String(notificationAccountIdForShare(share) || '') === accountId)
    .map((share) => ({ id:share.id, token:share.token || null, name:share.name || share.token || share.id, type:share.type, metrics:CUSTOM_NOTIFICATION_RULE_METRICS.filter((m) => customNotificationMetricCompatible(m, share)) }))
    .filter((target) => target.metrics.length)
    .sort((a,b) => String(a.name).localeCompare(String(b.name), 'fr', { sensitivity:'base', numeric:true }));
}
function upsertCustomNotificationRule(accountId, body) {
  const acc = getAccountById(String(accountId || ''));
  if (!acc) return { error:'account-not-found' };
  const metric = String(body && body.metric || '');
  if (!CUSTOM_NOTIFICATION_RULE_METRICS.includes(metric)) return { error:'invalid-metric' };
  const threshold = Math.max(0, Math.floor(Number(body && body.threshold) || 0));
  if (!threshold || !Number.isSafeInteger(threshold)) return { error:'invalid-threshold' };
  const shareId = body && body.shareId ? String(body.shareId).slice(0,120) : null;
  const rules = accountCustomNotificationRules(acc.id);
  const beforeRules = JSON.parse(JSON.stringify(rules));
  const requestedId = String(body && body.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0,64);
  const cleanLabel = String(body && body.label || '').replace(/[\r\n\t]+/g,' ').trim().slice(0,100);
  let rule = requestedId ? rules.find((r) => r.id === requestedId) : null;
  // A stale editor must never recreate a rule that another session/device already
  // deleted. Treat an unknown explicit ID as a missing resource, not as a create.
  if (requestedId && !rule) return { error:'rule-not-found' };
  if (shareId) {
    const share = getById(shareId);
    const sameExistingTarget = !!(rule && String(rule.shareId || '') === shareId);
    // A new rule cannot be attached to an expired/paused/missing link that the
    // target picker deliberately hides. For an existing stale rule we still allow
    // a client to DISABLE it, even after its link moved to trash or expired.
    if (!share) {
      if (!(sameExistingTarget && body && body.enabled === false)) return { error:'invalid-target' };
    } else {
      if (String(notificationAccountIdForShare(share) || '') !== String(acc.id) || !customNotificationMetricCompatible(metric, share)) return { error:'invalid-target' };
      if (!isActive(share, Date.now()) && !(sameExistingTarget && body && body.enabled === false)) return { error:'inactive-target' };
    }
  }
  // Double-clicks/retries on the create button used to create identical rules with
  // distinct IDs, which then emitted duplicate center notifications. Treat an
  // exact no-ID create as idempotent while still allowing deliberate edits by ID.
  if (!requestedId) {
    const duplicate = rules.find((r) => r.metric === metric && Number(r.threshold) === threshold && String(r.shareId || '') === String(shareId || '') && String(r.label || '') === cleanLabel);
    if (duplicate) {
      const desiredEnabled = body && body.enabled !== false;
      if (duplicate.enabled !== desiredEnabled) {
        duplicate.enabled = desiredEnabled;
        duplicate.updatedAt = Date.now();
        duplicate.triggered = {}; // intentionally re-arm when Add re-enables a disabled identical rule
        if (!persistNow()) { acc.notificationRules = beforeRules; return { error:'write-error' }; }
      }
      return { rule:publicCustomNotificationRule(duplicate), duplicate:true };
    }
  }
  if (!rule && rules.length >= CUSTOM_NOTIFICATION_RULE_MAX) return { error:'too-many-rules' };
  const now = Date.now();
  if (!rule) {
    rule = normalizeCustomNotificationRule({ metric, threshold, shareId, label:cleanLabel, enabled:body && body.enabled, createdAt:now, updatedAt:now }, acc.id);
    rules.push(rule);
  } else {
    rule.metric = metric; rule.threshold = threshold; rule.shareId = shareId;
    rule.label = cleanLabel;
    rule.enabled = body && body.enabled !== false; rule.updatedAt = now;
    rule.triggered = {}; // editing a rule deliberately re-arms its threshold
  }
  acc.notificationRules = rules.slice(0, CUSTOM_NOTIFICATION_RULE_MAX);
  if (!persistNow()) { acc.notificationRules = beforeRules; return { error:'write-error' }; }
  return { rule:publicCustomNotificationRule(rule) };
}
function deleteCustomNotificationRule(accountId, id) {
  const acc = getAccountById(String(accountId || '')); if (!acc) return false;
  const current = accountCustomNotificationRules(acc.id);
  const beforeRules = JSON.parse(JSON.stringify(current));
  const before = current.length;
  acc.notificationRules = current.filter((r) => r.id !== String(id || ''));
  if (acc.notificationRules.length === before) return false;
  if (!persistNow()) { acc.notificationRules = beforeRules; return null; }
  return true;
}
function pruneCustomNotificationRuleStateForShareId(shareId) {
  const id = String(shareId || '');
  if (!id) return { rulesRemoved:0, triggerEntriesRemoved:0 };
  let rulesRemoved = 0, triggerEntriesRemoved = 0, changed = false;
  for (const acc of accountList()) {
    if (!acc) continue;
    const rules = accountCustomNotificationRules(acc.id);
    const next = [];
    for (const rule of rules) {
      if (!rule) continue;
      if (rule.shareId && String(rule.shareId) === id) {
        rulesRemoved += 1; changed = true; continue;
      }
      if (rule.triggered && Object.prototype.hasOwnProperty.call(rule.triggered, id)) {
        delete rule.triggered[id]; triggerEntriesRemoved += 1; changed = true;
      }
      next.push(rule);
    }
    if (next.length !== rules.length) acc.notificationRules = next;
  }
  if (changed) scheduleFlush();
  return { rulesRemoved, triggerEntriesRemoved };
}
const NOTIFICATION_GROUP_WINDOW_MS = 10 * 60 * 1000;
const NOTIFICATION_GROUPABLE_TYPES = new Set(['transfer-complete','transfer-failed','received-file-ready','download-abandoned','upload-abandoned','resume-impossible','link-new-visitor','new-country','image-first-view']);
function notificationGroupKey(type, data) {
  if (!NOTIFICATION_GROUPABLE_TYPES.has(String(type || ''))) return null;
  const target = String((data && (data.token || data.name || data.source)) || '').trim();
  if (!target) return null;
  return [String(type), target, String((data && data.reason) || '')].join(':').slice(0,240);
}
function adaptiveNotificationPriority(accountId, type, data, severity, now) {
  const category = String((data && data.category) || centerNotificationDefaults(type)[0]);
  const rows = notificationCenterStore().filter((n) => n && String(n.accountId) === String(accountId) && Number(n.at) >= now - 15*60*1000);
  const sameTarget = rows.filter((n) => n.type === type && (!data.token || String(n.token || '') === String(data.token))).reduce((n,row)=>n+Math.max(1,Number(row.groupCount)||1),0);
  const securityBurst = rows.filter((n) => String(n.category) === 'security').reduce((n,row)=>n+Math.max(1,Number(row.groupCount)||1),0);
  if ((['transfer-failed','upload-abandoned','download-abandoned','resume-impossible'].includes(type) && sameTarget >= 2) || (category === 'security' && securityBurst >= 3)) {
    return { severity:'critical', priority:'urgent', reason:'repeated-failures' };
  }
  if (severity === 'critical') return { severity, priority:'urgent', reason:null };
  if (severity === 'warning') return { severity, priority:'high', reason:null };
  if (NOTIFICATION_GROUPABLE_TYPES.has(type) && sameTarget >= 5) return { severity, priority:'low', reason:'routine-burst' };
  return { severity, priority:'normal', reason:null };
}
function mergeGroupedNotification(rec, data, now, priority) {
  const previousAt = Number(rec.at) || now;
  rec.at = now; rec.groupCount = Math.max(1, Number(rec.groupCount)||1) + 1;
  rec.groupFirstAt = Math.max(0, Number(rec.groupFirstAt)||previousAt);
  rec.bytes = Math.max(0, Number(rec.bytes)||0) + Math.max(0, Number(data.bytes)||0);
  if (data.count) rec.count = Math.max(0, Number(rec.count)||0) + Math.max(0, Number(data.count)||0);
  for (const key of ['ip','country','flag','detail','reason','sender','device','username','source','action','url','variant']) if (data[key] != null) rec[key] = String(data[key]).slice(0, key === 'detail' ? 500 : 160);
  rec.readAt = null; rec.priority = priority.priority; rec.priorityReason = priority.reason;
  if (priority.severity === 'critical') rec.severity = 'critical';
  return rec;
}
function addCenterNotification(accountId, type, data = {}) {
  accountId = String(accountId || '');
  if (!accountId || !type) return null;
  const [defaultCategory, defaultSeverity] = centerNotificationDefaults(type);
  const category = String(data.category || defaultCategory).slice(0, 40);
  // Respect the account's per-category opt-outs. The check runs before
  // the dedupe ledger is touched so a muted category never leaves suppression state
  // behind that would swallow the first alert after it is re-enabled.
  if (notificationCategoryMuted(accountId, category)) return null;
  const list = notificationCenterStore();
  const now = Number(data.at) || Date.now();
  const dedupeKey = data.dedupeKey ? String(data.dedupeKey).slice(0, 240) : null;
  const dedupeWindowMs = Math.max(0, Number(data.dedupeWindowMs) || 0);
  if (dedupeKey && notificationDedupeSeen(accountId, dedupeKey, now, dedupeWindowMs)) {
    return list.find((n) => String(n.accountId) === accountId && n.dedupeKey === dedupeKey) || null;
  }
  const priority = adaptiveNotificationPriority(accountId, String(type), data, String(data.severity || defaultSeverity), now);
  const groupKey = notificationGroupKey(type, data);
  if (groupKey) {
    const grouped = list.find((n) => n && String(n.accountId) === accountId && n.groupKey === groupKey && !(Number(n.readAt)>0) && now - Number(n.at || 0) <= NOTIFICATION_GROUP_WINDOW_MS);
    if (grouped) { mergeGroupedNotification(grouped, data, now, priority); persist(); return grouped; }
  }
  const rec = {
    id:crypto.randomBytes(12).toString('hex'), accountId, type:String(type).slice(0,80), at:now,
    category, severity:String(priority.severity || data.severity || defaultSeverity).slice(0,20), priority:priority.priority, priorityReason:priority.reason,
    name:String(data.name || '').slice(0,240), token:data.token ? String(data.token).slice(0,160) : null,
    variant:data.variant ? String(data.variant).slice(0,24) : null, ip:data.ip ? String(data.ip).slice(0,100) : null,
    country:data.country ? String(data.country).slice(0,100) : null, flag:data.flag ? String(data.flag).slice(0,16) : '🌐',
    bytes:Math.max(0, Number(data.bytes)||0), count:Math.max(0, Number(data.count)||0), limit:Math.max(0, Number(data.limit)||0), threshold:Math.max(0, Number(data.threshold)||0),
    expiresAt:Math.max(0, Number(data.expiresAt)||0), reason:data.reason ? String(data.reason).slice(0,120) : null,
    detail:data.detail ? String(data.detail).replace(/[\r\n\t]+/g,' ').slice(0,500) : null, sender:data.sender ? String(data.sender).slice(0,120) : null,
    device:data.device ? String(data.device).slice(0,160) : null, username:data.username ? String(data.username).slice(0,120) : null,
    version:data.version ? String(data.version).slice(0,40) : null, latest:data.latest ? String(data.latest).slice(0,40) : null,
    source:data.source ? String(data.source).slice(0,120) : null, action:data.action ? String(data.action).slice(0,80) : null,
    url:data.url ? String(data.url).slice(0,500) : null, durationMs:Math.max(0, Number(data.durationMs)||0),
    previous:data.previous ? String(data.previous).slice(0,180) : null, current:data.current ? String(data.current).slice(0,180) : null,
    // New center entries start unread. readAt is server-owned and is changed only
    // when an authenticated client actually opens its notification panel.
    readAt:null,
    groupKey, groupCount:1, groupFirstAt:now,
    dedupeKey, dedupeWindowMs,
  };
  list.unshift(rec);
  trimNotificationCenterAccount(accountId, list);
  persist();
  return rec;
}
function addShareCenterNotification(s, type, data = {}) {
  s = currentShareRef(s);
  if (!s) return null;
  const accountId = notificationAccountIdForShare(s);
  if (!accountId) return null;
  const payload = { name:s.name || data.name || '', token:s.token || data.token || null, ...data };
  // Generic link lifecycle/activity events default to the Shares category, but an
  // inbox/photo is managed from Receptions/Images. Scope those generic events to
  // the resource's real section so filters and per-category mute preferences do
  // not accidentally silence (or expose) the wrong family of notifications.
  if (!payload.category) {
    const [defaultCategory] = centerNotificationDefaults(type);
    if (defaultCategory === 'shares' && s && s.type === 'inbox') payload.category = 'receptions';
    else if (defaultCategory === 'shares' && s && s.type === 'photo') payload.category = 'images';
  }
  return addCenterNotification(accountId, type, payload);
}

function evaluateCustomNotificationRulesForShare(s) {
  s = currentShareRef(s);
  if (!s || s.revoked) return 0;
  const accountId = notificationAccountIdForShare(s); if (!accountId) return 0;
  const rules = accountCustomNotificationRules(accountId); let fired = 0, changed = false;
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !customNotificationMetricCompatible(rule.metric, s)) continue;
    if (rule.shareId && String(rule.shareId) !== String(s.id)) continue;
    const value = customNotificationMetricValue(rule.metric, s);
    const key = String(s.id);
    // A custom rule is one-shot per link for a given rule revision. Some
    // metrics (especially received_bytes) can legitimately fall after retention,
    // rejection or cleanup. Falling below the threshold must NOT silently re-arm
    // the rule, otherwise the same threshold can notify repeatedly. Editing the
    // rule explicitly clears `triggered` and is the deliberate re-arm path.
    if (value < rule.threshold) continue;
    if (rule.triggered && rule.triggered[key]) continue;
    const isBytes = rule.metric === 'bytes_served' || rule.metric === 'received_bytes';
    const rec = addCenterNotification(accountId, 'custom-alert-rule', {
      name:s.name || s.token || s.id, token:s.token || null, category:'thresholds', severity:'success',
      count:isBytes ? 0 : value, bytes:isBytes ? value : 0,
      threshold:isBytes ? 0 : rule.threshold, limit:isBytes ? rule.threshold : 0,
      reason:rule.metric, source:rule.label || null,
      dedupeKey:`custom-rule:${rule.id}:${rule.updatedAt}:${s.id}:${rule.threshold}`,
    });
    if (!rec) continue; // muted category: keep it armed for when Thresholds is re-enabled
    if (!rule.triggered || typeof rule.triggered !== 'object') rule.triggered = {};
    rule.triggered[key] = Date.now();
    const keys = Object.keys(rule.triggered);
    if (keys.length > CUSTOM_NOTIFICATION_RULE_TRIGGER_MAX) keys.sort((a,b)=>Number(rule.triggered[b]||0)-Number(rule.triggered[a]||0)).slice(CUSTOM_NOTIFICATION_RULE_TRIGGER_MAX).forEach((id)=>delete rule.triggered[id]);
    changed = true; fired += 1;
  }
  if (changed) scheduleFlush();
  return fired;
}
function addAdminCenterNotification(type, data = {}, accountIds) {
  // `undefined` means a deliberate system-wide admin broadcast. An explicit empty
  // array means "no resolved owner" and MUST stay empty; treating [] like an
  // omitted argument leaked request-scoped DLP alerts to every administrator.
  const ids = Array.isArray(accountIds) ? accountIds.map(String) : notificationAdminAccountIds();
  const out = [];
  for (const accountId of [...new Set(ids)]) {
    const rec = addCenterNotification(accountId, type, data);
    if (rec) out.push(rec);
  }
  return out;
}
function addRequestCenterNotification(req, type, data = {}) {
  return addAdminCenterNotification(type, data, notificationAccountIdsForRequest(req));
}
function addFirstViewCenterNotification(s, evt, geo) {
  return addShareCenterNotification(s, 'image-first-view', {
    at:Number(evt.at)||Date.now(), variant:evt.variant || 'full', ip:evt.ip || null, country:evt.country || null,
    flag:(geo && geo.flag) || '🌐', url:'/app/#images', dedupeKey:`image-first-view:${s.token || s.id}:${Number(evt.at)||0}`,
  });
}
function enrichFirstViewCenterNotification(s, rawIp, geo) {
  s = currentShareRef(s);
  if (!s || !geo || !geo.country) return false;
  const accountId = notificationAccountIdForShare(s);
  if (!accountId) return false;
  const list = notificationCenterStore();
  const rec = list.find((n) => String(n.accountId) === accountId && n.type === 'image-first-view' && String(n.token || '') === String(s.token || ''));
  if (!rec) return false; // Respect a user deletion; enrichment must never recreate it.
  let changed = false;
  if (!rec.country) { rec.country = String(geo.country).slice(0,100); changed = true; }
  const flag = geo.flag || flagFromCode(geo.countryCode) || null;
  if (flag && (!rec.flag || rec.flag === '🌐')) { rec.flag = String(flag).slice(0,16); changed = true; }
  if (!rec.ip && rawIp) { rec.ip = String(pubIp(String(rawIp).replace(/^::ffff:/i,'')) || '').slice(0,100) || null; changed = true; }
  if (s.firstViewPushPending && !s.firstViewPushPending.country) {
    s.firstViewPushPending.country = String(geo.country).slice(0,100);
    changed = true;
  }
  if (changed) scheduleFlush();
  return changed;
}
const CENTER_MILESTONES = [10, 50, 100, 500, 1000, 5000, 10000];
const centerActivityTrackers = new Map();
const centerRepeatedDownloadTrackers = new Map();
const CENTER_TRACKER_IDLE_MS = 60 * 60 * 1000;
const CENTER_ACTIVITY_TRACKER_MAX = 2000;
const CENTER_REPEAT_TRACKER_MAX = 5000;
let centerTrackerLastPruneAt = 0;
function pruneCenterTrackers(now = Date.now(), force = false) {
  if (!force && now - centerTrackerLastPruneAt < 5 * 60 * 1000 && centerActivityTrackers.size <= CENTER_ACTIVITY_TRACKER_MAX && centerRepeatedDownloadTrackers.size <= CENTER_REPEAT_TRACKER_MAX) return;
  centerTrackerLastPruneAt = now;
  const prune = (map, max) => {
    for (const [key, tr] of map) if (!tr || now - Math.max(0, Number(tr.lastSeenAt) || 0) > CENTER_TRACKER_IDLE_MS) map.delete(key);
    if (map.size <= max) return;
    const oldest = [...map.entries()].sort((a,b) => Number(a[1].lastSeenAt || 0) - Number(b[1].lastSeenAt || 0));
    for (const [key] of oldest.slice(0, map.size - max)) map.delete(key);
  };
  prune(centerActivityTrackers, CENTER_ACTIVITY_TRACKER_MAX);
  prune(centerRepeatedDownloadTrackers, CENTER_REPEAT_TRACKER_MAX);
}
function centerShareEligibleForVisitorNotification(s) {
  return !!(s && s.type !== 'photo' && s.type !== 'album' && s.type !== 'collab' && s.type !== 'secret');
}
function centerTotalViews(s) {
  if (!s) return 0;
  if (s.type === 'photo') {
    const ps = photoStatsOf(s);
    return (Number(ps.full.v)||0) + (Number(ps.thumb.v)||0) + (Number(ps.micro.v)||0);
  }
  return Math.max(0, Number(s.views)||0);
}
function noteCenterCountry(s, rawIp, geo) {
  s = currentShareRef(s);
  if (!s || !geo || !geo.country || getSettings().geoLookup === false) return false;
  // Countries must be real ISO-3166 codes. The previous fallback to the country
  // label could turn "Local network" (or any provider label) into a fake country.
  const code = String(geo.countryCode || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 2) return false;
  if (!Array.isArray(s.centerNotificationCountries)) s.centerNotificationCountries = [];
  if (s.centerNotificationCountries.includes(code)) return false;
  const rec = addShareCenterNotification(s, 'new-country', {
    ip:rawIp ? pubIp(String(rawIp).replace(/^::ffff:/i,'')) : null, country:geo.country || null, flag:geo.flag || flagFromCode(geo.countryCode) || '🌐',
    dedupeKey:`country:${s.id}:${code}`,
  });
  if (!rec) return false; // muted Visitors stays armed for the next visit after re-enable
  s.centerNotificationCountries.push(code);
  if (s.centerNotificationCountries.length > 250) s.centerNotificationCountries = s.centerNotificationCountries.slice(-250);
  scheduleFlush();
  return true;
}
function maybeCenterViewThreshold(s) {
  s = currentShareRef(s);
  if (!s) return;
  const views = centerTotalViews(s);
  if (!Array.isArray(s.centerViewMilestones)) s.centerViewMilestones = [];
  let changed = false;
  for (const threshold of CENTER_MILESTONES) {
    if (views < threshold || s.centerViewMilestones.includes(threshold)) continue;
    const rec = addShareCenterNotification(s, 'view-threshold', { count:views, threshold, dedupeKey:`views:${s.id}:${threshold}` });
    if (!rec) continue; // a muted Thresholds category must not consume the milestone
    s.centerViewMilestones.push(threshold); changed = true;
  }
  if (changed) scheduleFlush();
}
function maybeCenterDownloadMilestone(s) {
  s = currentShareRef(s);
  if (!s || s.type === 'inbox' || s.type === 'collab' || s.type === 'photo') return;
  const count = Math.max(0, Number(s.downloads)||0);
  if (!Array.isArray(s.centerDownloadMilestones)) s.centerDownloadMilestones = [];
  let changed = false;
  for (const threshold of CENTER_MILESTONES) {
    if (count < threshold || s.centerDownloadMilestones.includes(threshold)) continue;
    const rec = addShareCenterNotification(s, 'download-threshold', { count, threshold, dedupeKey:`downloads:${s.id}:${threshold}` });
    if (!rec) continue;
    s.centerDownloadMilestones.push(threshold); changed = true;
  }
  if (changed) scheduleFlush();
}
function noteCenterActivity(s, kind, rawIp) {
  s = currentShareRef(s);
  if (!s) return;
  const now = Date.now(), windowMs = 5 * 60 * 1000;
  pruneCenterTrackers(now);
  let tr = centerActivityTrackers.get(s.id);
  if (!tr) { tr = { events:[], alertedAt:0, lastSeenAt:now }; centerActivityTrackers.set(s.id, tr); }
  tr.lastSeenAt = now;
  tr.events.push({ at:now, kind:String(kind||'activity'), ipKey:centerTrackerIpKey(rawIp) });
  tr.events = tr.events.filter((e) => now - e.at <= windowMs).slice(-500);
  const uniqueIps = new Set(tr.events.map((e) => e.ipKey).filter(Boolean)).size;
  if (now - tr.alertedAt < 30 * 60 * 1000) return;
  if (tr.events.length >= 20 && (uniqueIps >= 5 || tr.events.length >= 50)) {
    const rec = addShareCenterNotification(s, 'unusual-activity', { count:tr.events.length, detail:`${tr.events.length} activités / 5 min · ${uniqueIps} IP`, dedupeKey:`activity:${s.id}:${Math.floor(now/(30*60*1000))}` });
    if (rec) tr.alertedAt = now;
  }
}
function noteCenterRepeatedDownload(s, rawIp) {
  s = currentShareRef(s);
  if (!s || !rawIp) return;
  const ipKey = centerTrackerIpKey(rawIp);
  if (!ipKey) return;
  const displayIp = pubIp(String(rawIp).replace(/^::ffff:/i,'')), key = `${s.id}\0${ipKey}`, now = Date.now(), windowMs = 10 * 60 * 1000;
  pruneCenterTrackers(now);
  let tr = centerRepeatedDownloadTrackers.get(key);
  if (!tr) { tr = { hits:[], alertedAt:0, lastSeenAt:now }; centerRepeatedDownloadTrackers.set(key, tr); }
  tr.lastSeenAt = now;
  tr.hits.push(now); tr.hits = tr.hits.filter((t) => now - t <= windowMs).slice(-100);
  if (tr.hits.length >= 5 && now - tr.alertedAt >= 30 * 60 * 1000) {
    const rec = addShareCenterNotification(s, 'repeated-downloads', { ip:displayIp, count:tr.hits.length, detail:`${tr.hits.length} téléchargements / 10 min`, dedupeKey:`repeat-download:${s.id}:${ipKey}:${Math.floor(now/(30*60*1000))}` });
    if (rec) tr.alertedAt = now;
  }
}
function maybeCenterReceptionQuota(s) {
  s = currentShareRef(s);
  if (!s || (s.type !== 'inbox' && s.type !== 'collab')) return;
  const pending = pendingUsageForShare(s);
  const usedFiles = Number(s.downloads || 0) + pending.files;
  const usedBytes = Number(s.bytesReceived || 0) + pending.bytes;
  let reason = null, limit = 0, count = 0;
  if (Number(s.maxFiles) > 0 && usedFiles >= Number(s.maxFiles)) { reason='files'; limit=Number(s.maxFiles); count=usedFiles; }
  else if (Number(s.maxTotalBytes) > 0 && usedBytes >= Number(s.maxTotalBytes)) { reason='bytes'; limit=Number(s.maxTotalBytes); count=usedBytes; }
  if (!reason) return;
  addShareCenterNotification(s, 'reception-quota-reached', { reason, limit, count, bytes:usedBytes, dedupeKey:`reception-quota:${s.id}:${reason}:${limit}` });
}
function noteCenterAutoDisabled(s, reason) {
  s = currentShareRef(s);
  if (!s) return;
  reason = reason || 'automatic';
  // A link can be reconfigured and legitimately hit the same kind of limit again.
  // Include the active limit in the event identity so e.g. 10→20 downloads creates
  // a second auto-disable notification instead of being suppressed forever.
  let trigger = '';
  if (reason === 'download-limit') trigger = String(Math.max(0, Number(s.maxDownloads) || 0));
  else if (reason === 'visitor-limit') trigger = String(parseMaxVisitors(s.maxVisitors));
  else if (reason === 'bandwidth-limit') trigger = String(Math.max(0, Number(s.maxBytesServed) || 0));
  else if (reason === 'one-time-download') trigger = String(Math.max(0, Number(s.burnedAt) || Date.now()));
  addShareCenterNotification(s, 'link-auto-disabled', { reason, dedupeKey:`auto-disabled:${s.id}:${reason}:${trigger}` });
}

const centerVolumeTrackers = new Map();
const CENTER_HIGH_DOWNLOAD_VOLUME_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB, within the 15-minute traffic window
const centerViralTrackers = new Map();
const CENTER_UNUSED_MS = 30 * DAY_MS;
function noteCenterVisitorDevice(s, req) {
  s = currentShareRef(s);
  if (!s || !req || !centerShareEligibleForVisitorNotification(s)) return;
  const ua = String(req.headers && req.headers['user-agent'] || '').trim();
  if (!ua) return;
  if (!Array.isArray(s.centerVisitorAgents)) s.centerVisitorAgents = [];
  const key = crypto.createHash('sha256').update(ua).digest('hex').slice(0,16);
  if (s.centerVisitorAgents.includes(key)) return;
  const rec = addShareCenterNotification(s, 'visitor-device-new', { device:centerPublicVisitorDeviceLabel(req), detail:ua.slice(0,180), dedupeKey:`visitor-agent:${s.id}:${key}` });
  if (!rec) return;
  s.centerVisitorAgents.push(key); if (s.centerVisitorAgents.length > 250) s.centerVisitorAgents = s.centerVisitorAgents.slice(-250);
  scheduleFlush();
}
function noteCenterConcurrentDownloadStart(transfer) {
  if (!transfer || !transfer.shareId || !transfer.notify || (transfer.direction || 'down') !== 'down') return;
  const s = getById(transfer.shareId);
  if (!s) return;
  const ips = new Set(); let count = 0;
  for (const t of getActiveTransfers().values()) {
    // Only full/ZIP downloads count. Range previews are active transfers too, but
    // they are deliberately marked notify=false and must never trigger this alert.
    if (!t || t.shareId !== s.id || (t.direction || 'down') !== 'down' || !t.notify) continue;
    count += 1; if (t.ip) { const ipKey = centerTrackerIpKey(t.ip); if (ipKey) ips.add(ipKey); }
  }
  if (count >= 3 && ips.size >= 2) addShareCenterNotification(s, 'simultaneous-downloads', {
    count, detail:`${count} téléchargements simultanés · ${ips.size} IP`,
    dedupeKey:`simul:${s.id}:${Math.floor(Date.now()/(10*60000))}`, dedupeWindowMs:10*60000,
  });
}
function noteCenterHighVolume(s, bytes) {
  s = currentShareRef(s);
  if (!s) return;
  const now=Date.now(), win=15*60000, key=String(s.id); let tr=centerVolumeTrackers.get(key);
  if (!tr) { tr={events:[],alertedAt:0,lastSeenAt:now}; centerVolumeTrackers.set(key,tr); }
  tr.lastSeenAt=now; tr.events.push({at:now,bytes:Math.max(0,Number(bytes)||0)}); tr.events=tr.events.filter(e=>now-e.at<=win).slice(-500);
  if (centerVolumeTrackers.size > 2000) {
    for (const [k,v] of [...centerVolumeTrackers].sort((a,b)=>(a[1].lastSeenAt||0)-(b[1].lastSeenAt||0)).slice(0,centerVolumeTrackers.size-1800)) centerVolumeTrackers.delete(k);
  }
  const total=tr.events.reduce((a,e)=>a+e.bytes,0);
  if (total >= CENTER_HIGH_DOWNLOAD_VOLUME_BYTES && now-tr.alertedAt>30*60000) {
    const rec=addShareCenterNotification(s,'high-download-volume',{bytes:total,count:tr.events.length,detail:`${formatBytes(total)} / 15 min`,dedupeKey:`high-volume:${s.id}:${Math.floor(now/(30*60000))}`}); if(rec) tr.alertedAt=now;
  }
}
function noteCenterViral(s, kind) {
  s = currentShareRef(s);
  if (!s) return;
  const now=Date.now(), win=10*60000, key=String(s.id); let tr=centerViralTrackers.get(key);
  if (!tr) { tr={events:[],alertedAt:0,lastSeenAt:now}; centerViralTrackers.set(key,tr); }
  tr.lastSeenAt=now; tr.events.push({at:now,kind:String(kind||'event')}); tr.events=tr.events.filter(e=>now-e.at<=win).slice(-1000);
  if (centerViralTrackers.size > 2000) {
    for (const [k,v] of [...centerViralTrackers].sort((a,b)=>(a[1].lastSeenAt||0)-(b[1].lastSeenAt||0)).slice(0,centerViralTrackers.size-1800)) centerViralTrackers.delete(k);
  }
  if (tr.events.length >= 30 && now-tr.alertedAt>60*60000) {
    const rec=addShareCenterNotification(s,'link-viral',{count:tr.events.length,detail:`${tr.events.length} activités / 10 min`,dedupeKey:`viral:${s.id}:${Math.floor(now/3600000)}`,dedupeWindowMs:3600000}); if(rec) tr.alertedAt=now;
  }
}
function quickSharedFileFingerprint(absPath, st) {
  let fd = null;
  try {
    const size = Math.max(0, Number(st && st.size) || 0), chunk = 64 * 1024;
    const h = crypto.createHash('sha256'); h.update(String(size) + '\0');
    fd = fs.openSync(absPath, 'r');
    const first = Buffer.allocUnsafe(Math.min(chunk, size));
    if (first.length) { const n = fs.readSync(fd, first, 0, first.length, 0); h.update(first.subarray(0, n)); }
    if (size > chunk) { const tail = Buffer.allocUnsafe(Math.min(chunk, size)); const pos = Math.max(0, size - tail.length); const n = fs.readSync(fd, tail, 0, tail.length, pos); h.update(tail.subarray(0, n)); }
    return h.digest('hex').slice(0, 24);
  } catch (_) { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch (_) {} }
}
function noteCenterSharedFileSignature(s, absPath, filename, st) {
  s = currentShareRef(s);
  if (!s || s.type !== 'file' || !st) return;
  const size=Math.max(0,Number(st.size)||0), sig=`${size}:${Math.floor(Number(st.mtimeMs)||0)}`;
  if (!s.centerFileSignature) { s.centerFileSignature=sig; s.centerFileFingerprint=quickSharedFileFingerprint(absPath,st); scheduleFlush(); return; }
  if (s.centerFileSignature === sig) return;
  const previous=s.centerFileSignature, previousSize=Math.max(0,parseInt(String(previous).split(':')[0],10)||0), previousFp=s.centerFileFingerprint||null;
  const currentFp=quickSharedFileFingerprint(absPath,st);
  s.centerFileSignature=sig;
  // Upgrade old records without a content fingerprint. A size change is a real
  // replacement; a same-size mtime change is only a baseline until content can be compared.
  if (!previousFp && previousSize === size) { s.centerFileFingerprint=currentFp; scheduleFlush(); return; }
  if (previousFp && currentFp && previousFp === currentFp) { s.centerFileFingerprint=currentFp; scheduleFlush(); return; } // mtime/touch only
  s.centerFileFingerprint=currentFp; scheduleFlush();
  const detail = previousSize !== size ? `${formatBytes(previousSize)} → ${formatBytes(size)}` : 'Contenu modifié';
  addShareCenterNotification(s,'shared-file-replaced',{name:filename||s.name||'',detail,bytes:size,dedupeKey:`file-replaced:${s.id}:${currentFp||sig}`});
}
function noteCenterCleanup(files, bytes, source) {
  files=Math.max(0,Number(files)||0); bytes=Math.max(0,Number(bytes)||0); if (!files) return;
  addAdminCenterNotification('cleanup-complete',{count:files,bytes,source:source||'cleanup',detail:`${files} fichier(s) · ${formatBytes(bytes)} récupérés`,dedupeKey:`cleanup:${source}:${Math.floor(Date.now()/3600000)}`,dedupeWindowMs:3600000});
}
function centerHealthLedger() {
  if (!state.meta || typeof state.meta!=='object') state.meta={};
  if (!state.meta.notificationServiceHealth || typeof state.meta.notificationServiceHealth!=='object') state.meta.notificationServiceHealth={};
  return state.meta.notificationServiceHealth;
}
function noteCenterServiceState(key, ok, detail) {
  const store=centerHealthLedger(), prev=store[key];
  const stateNow=ok?'ok':'down'; if (prev && prev.state===stateNow) return;
  store[key]={state:stateNow,at:Date.now()}; persist();
  if (!prev) { if (!ok) addAdminCenterNotification('service-unavailable',{source:key,detail,dedupeKey:`service-down:${key}:${Math.floor(Date.now()/(6*3600000))}`,dedupeWindowMs:6*3600000}); return; }
  addAdminCenterNotification(ok?'service-restored':'service-unavailable',{source:key,detail,dedupeKey:`service-${stateNow}:${key}:${Date.now()}`});
}
function pushSubAccountIds(sub) {
  const out=[];
  if (sub && sub.accountId && getAccountById(String(sub.accountId))) out.push(String(sub.accountId));
  for (const raw of (sub && Array.isArray(sub.ownerKeys) ? sub.ownerKeys : [])) {
    const k = String(raw || '');
    if (k.startsWith('acc:')) { const id=k.slice(4); if (getAccountById(id)) out.push(id); continue; }
    if (k.startsWith('dev:')) {
      const d=pwaDevices().find(x=>x&&x.id===k.slice(4));
      const a=d&&pwaDeviceResolvedAccount(d); if(a&&a.id) out.push(String(a.id));
    }
  }
  // Pre-account browser subscriptions had no scope. They historically belonged to
  // the sole owner, so keep that compatibility without broadcasting them to every
  // later-created admin/operator account.
  if (!out.length && sub && !sub.accountId && (!Array.isArray(sub.ownerKeys) || !sub.ownerKeys.length)) {
    const owner = accountList().find((a) => a && a.role === 'owner'); if (owner && owner.id) out.push(String(owner.id));
  }
  return [...new Set(out)];
}
function pushSubscriptionsForAccountIds(accountIds) {
  const wanted = new Set((accountIds || []).map((id) => String(id || '')).filter((id) => id && getAccountById(id)));
  if (!wanted.size) return [];
  return pushSubs().filter((sub) => pushSubAccountIds(sub).some((id) => wanted.has(String(id))));
}
function noteExpiredPushSub(sub, statusCode) {
  const ids=pushSubAccountIds(sub); if (!ids.length) return;
  addAdminCenterNotification('push-subscription-expired',{device:sub&&sub.ua||'navigateur',detail:`Endpoint Push expiré (${statusCode||410})`,dedupeKey:`push-expired:${crypto.createHash('sha256').update(String(sub&&sub.endpoint||'')).digest('hex').slice(0,16)}`},ids);
}
function checkCenterLinkStates() {
  const now = Date.now();
  const centerExpiryLeadMs = 24 * 3600 * 1000;
  for (const s of listShares()) {
    if (!s || s.revoked) continue;
    const deadline = Number(shareEffectiveExpiry(s)) || 0;
    // The in-app center is independent from webhook/e-mail reminder settings.
    // Previously this warning was only added by checkExpiringShares(), meaning a
    // user who disabled external expiry alerts also lost the center notification.
    if (deadline && deadline > now && deadline - now <= centerExpiryLeadMs && isActive(s, now)) {
      const hrs = Math.max(1, Math.round((deadline - now) / 3600000));
      addShareCenterNotification(s, 'link-expiring-soon', {
        expiresAt:deadline, count:hrs, reason:'effective', dedupeKey:`expiring:${s.id}:${deadline}`,
      });
    }
    if (deadline && now >= deadline && Number(s.centerExpiredDeadline) !== deadline) {
      const rec = addShareCenterNotification(s, 'link-expired', { expiresAt:deadline, reason:deadline === Number(s.expiresAt||0) ? 'fixed' : 'dynamic', dedupeKey:`expired:${s.id}:${deadline}` });
      if (rec) { s.centerExpiredDeadline = deadline; scheduleFlush(); }
    }
    const lastUse=Math.max(Number(s.lastUseAt)||0,Number(s.lastViewAt)||0,Number(s.createdAt)||0);
    if (lastUse && now-lastUse>=CENTER_UNUSED_MS) addShareCenterNotification(s,'link-unused',{count:Math.floor((now-lastUse)/DAY_MS),detail:`Aucune activité depuis ${Math.floor((now-lastUse)/DAY_MS)} jours`,dedupeKey:`unused:${s.id}:${Math.floor(lastUse/DAY_MS)}`});
    if (s.type !== 'inbox' && s.type !== 'collab' && s.type !== 'photo' && Number(s.maxDownloads) > 0 && Number(s.downloads||0) >= Number(s.maxDownloads)) {
      addShareCenterNotification(s, 'download-limit-reached', { count:Number(s.downloads)||0, limit:Number(s.maxDownloads), dedupeKey:`download-limit:${s.id}:${s.maxDownloads}` });
      noteCenterAutoDisabled(s, 'download-limit');
    }
    maybeCenterReceptionQuota(s);
    // Periodic scans must not make a newly-created "all links" rule fire against
    // stale historical links. Event-driven calls still evaluate a link at the
    // exact moment it reaches a threshold, including its final allowed download.
    if (isActive(s, now)) evaluateCustomNotificationRulesForShare(s);
  }
}
function purgeDeprecatedAuditKeyRecommendation() {
  if (!state.meta || typeof state.meta !== 'object') return 0;
  let removed = 0;
  if (Array.isArray(state.meta.notifications)) {
    const before = state.meta.notifications.length;
    state.meta.notifications = state.meta.notifications.filter((n) => !(n && n.type === 'system-problem' && (n.dedupeKey === 'system:audit-key-local' || String(n.detail || '').includes('AUDIT_HMAC_KEY recommandé'))));
    removed += before - state.meta.notifications.length;
  }
  const ledger = state.meta.notificationDedupe;
  if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
    for (const [id, rec] of Object.entries(ledger)) {
      if (rec && rec.dedupeKey === 'system:audit-key-local') { delete ledger[id]; removed += 1; }
    }
  }
  if (removed) persist();
  return removed;
}
function diskFreeThresholds() {
  const warn = Math.max(0, Math.min(50, Math.floor(Number(getSettings().diskFreeWarnPercent) || 0)));
  return { warn, critical: warn > 0 ? Math.max(1, Math.floor(warn / 2)) : 0 };
}
function checkCenterSystemHealth() {
  const searchIndexError = getSearchIndexError();
  const auditKeyMigrationStatus = getAuditKeyMigrationStatus();
  // 1.40.3+: the built-in /data/audit-chain.key is sufficient and must not
  // produce a warning. Remove stale recommendations created by older builds.
  purgeDeprecatedAuditKeyRecommendation();
  const ids = notificationAdminAccountIds();
  if (!ids.length) return;
  const warn = (key, detail, severity='warning') => addAdminCenterNotification('system-problem', { severity, detail, dedupeKey:`system:${key}`, dedupeWindowMs:6*3600*1000 }, ids);
  if (!dataWritable()) warn('data-not-writable', '/data non inscriptible', 'critical');
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(DATA_DIR), total=Number(st.blocks)*Number(st.bsize), free=Number(st.bavail)*Number(st.bsize);
      if (total > 0) { const pct=Math.round((free/total)*100), limits=diskFreeThresholds(); if (limits.warn > 0 && pct <= limits.critical) warn('disk-critical', `Espace disque libre ${pct}% (seuil ${limits.warn}%)`, 'critical'); else if (limits.warn > 0 && pct <= limits.warn) warn('disk-low', `Espace disque libre ${pct}% (seuil ${limits.warn}%)`, 'warning'); }
    }
  } catch (_) {}
  if (searchIndexError) warn('search-index', `Index de recherche: ${String(searchIndexError).slice(0,220)}`, 'critical');
  if (auditKeyMigrationStatus && auditKeyMigrationStatus.ok === false) warn('audit-key-migration', `Migration de clé d’audit: ${auditKeyMigrationStatus.reason || auditKeyMigrationStatus.error || 'échec'}`, 'critical');
  if (pushSubs().length && !webPushAvailable()) warn('webpush-module', 'Abonnements Push présents mais module Web Push indisponible', 'critical');
  const reverseProxyOk = !(PUBLIC_URL && !TRUST_PROXY);
  if (!reverseProxyOk) warn('reverse-proxy-trust', 'PUBLIC_URL est configuré mais TRUST_PROXY est désactivé', 'warning');
  noteCenterServiceState('reverse-proxy', reverseProxyOk, reverseProxyOk ? 'Reverse proxy rétabli' : 'Reverse proxy mal configuré');
  const pushOk = !(pushSubs().length && !webPushAvailable()); noteCenterServiceState('web-push', pushOk, pushOk ? 'Service Push rétabli' : 'Service Push indisponible');
  const indexOk = !searchIndexError; noteCenterServiceState('search-index', indexOk, indexOk ? 'Index de recherche rétabli' : `Index de recherche indisponible: ${String(searchIndexError).slice(0,160)}`);
  const dlpOk = !(getSettings().dlpEnabled !== false && getSettings().dlpScanOcr !== false && getDlpOcrUnavailableNotedAt() && Date.now()-getDlpOcrUnavailableNotedAt() < 6*3600*1000);
  noteCenterServiceState('dlp', dlpOk, dlpOk ? 'Service DLP rétabli' : 'Service DLP OCR indisponible');
  if (STORAGE_SETUP && (STORAGE_SETUP.inboxUnconfigured || STORAGE_SETUP.imagesUnconfigured)) warn('storage-config', 'Stockage persistant Réception/Images non configuré', 'critical');
}
function noteCenterLifecycleStart() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  const now=Date.now(), prev=state.meta.notificationRuntime;
  if (prev && prev.startedAt) {
    if (prev.clean) {
      const downtime=Math.max(0, now-Math.max(Number(prev.shutdownAt)||Number(prev.startedAt)||now,0));
      addAdminCenterNotification('server-restarted',{version:APP_VERSION,durationMs:downtime,detail:`Redémarrage détecté · indisponibilité ~${Math.round(downtime/1000)} s`,dedupeKey:`restart:${now}`});
      emitLiveActivity('system', { name:'server-restarted', status:'restarted', detail:`v${APP_VERSION} · downtime ~${Math.round(downtime/1000)} s` });
    } else {
      // An unclean stop has no shutdown timestamp, so downtime is unknowable.
      // Do not mislabel the previous process uptime as an outage duration.
      addAdminCenterNotification('server-crash-recovered',{version:APP_VERSION,detail:'Le démarrage précédent ne s’est pas terminé proprement',dedupeKey:`crash-recovered:${Number(prev.startedAt)||0}`});
      emitLiveActivity('system', { name:'server-crash-recovered', status:'recovered', detail:`v${APP_VERSION}` });
    }
  }
  state.meta.notificationRuntime={startedAt:now,clean:false,version:APP_VERSION};
  persistNow();
}
function noteCenterCleanShutdown(signal) {
  if (!state.meta || typeof state.meta !== 'object') state.meta={};
  const now=Date.now();
  // Record the clean stop durably, but do not create a user-facing notification
  // here. The service is already going offline, and the next startup emits the
  // single useful `server-restarted` notification with the measured downtime.
  // Emitting both produced two Restart notifications for one intentional restart.
  const prev=state.meta.notificationRuntime||{};
  state.meta.notificationRuntime={...prev,startedAt:Number(prev.startedAt)||now,clean:true,shutdownAt:now,shutdownSignal:String(signal||'shutdown').slice(0,40),version:APP_VERSION};
  emitLiveActivity('system', { name:'server-shutdown', status:'clean', detail:String(signal || 'shutdown').slice(0,40) });
  persistNow();
}
function noteCenterInstalledVersion() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  const previous = state.meta.notificationLastAppVersion ? String(state.meta.notificationLastAppVersion) : '';
  if (previous && previous !== APP_VERSION) { addAdminCenterNotification('update-installed', { version:APP_VERSION, detail:`${previous} → ${APP_VERSION}`, dedupeKey:`installed:${APP_VERSION}` }); emitLiveActivity('system', { name:'update-installed', status:'updated', detail:`${previous} → ${APP_VERSION}` }); }
  if (previous !== APP_VERSION) { state.meta.notificationLastAppVersion = APP_VERSION; persist(); }
}
function notificationLinkUrlForRequest(n, req, accountId) {
  if (!req || !n || !n.token) return null;
  const share = getByToken(String(n.token));
  if (!share || !isActive(share)) return null;
  // Never derive a management notification link from another account's share,
  // even if a restored/corrupt notification happens to carry its token.
  if (String(notificationAccountIdForShare(share) || '') !== String(accountId || '')) return null;
  const decorated = decorateShare(share, req);
  if (share.type === 'photo' && decorated.photo && decorated.photo.imgUrl) return decorated.photo.imgUrl;
  return decorated.url || null;
}
function notificationManageUrlForRequest(n, req, accountId) {
  if (!req || !n || !n.token) return null;
  const share = getByToken(String(n.token));
  if (!share || String(notificationAccountIdForShare(share) || '') !== String(accountId || '')) return null;
  const isPwa = String(req.path || req.originalUrl || '').startsWith('/app/');
  if (isPwa) return `/app/?action=${share.type === 'photo' || share.type === 'album' ? 'images' : 'shares'}&focus=${encodeURIComponent(share.token)}`;
  if (share.type === 'photo' || share.type === 'album') return `/images?image=${encodeURIComponent(share.token)}&from=notification`;
  return `/?focusShare=${encodeURIComponent(share.id)}&from=notification`;
}
function notificationsForAccount(accountId, req) {
  accountId = String(accountId || '');
  if (!accountId) return [];
  const muted = new Set(accountMutedNotificationCategories(accountId));
  return notificationCenterStore()
    .filter((n) => String(n.accountId) === accountId)
    // Apply preferences again at delivery time. addCenterNotification already
    // blocks future muted events, but this second gate also hides a notification
    // that was queued immediately before the user muted its category (or restored
    // from an older backup). This closes the timing window that could still expose
    // an Updates alert after the user unchecked “Mises à jour”.
    .filter((n) => !muted.has(String((n && n.category) || 'system_health')))
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .map((n) => ({ ...publicNotification(n), linkUrl:notificationLinkUrlForRequest(n, req, accountId), manageUrl:notificationManageUrlForRequest(n, req, accountId) }));
}
function markNotificationsReadForAccount(accountId, requestedIds, persistAfter = true) {
  accountId = String(accountId || '');
  if (!accountId) return { marked:0, readAt:0, ids:[], existingIds:[] };
  // New clients send only the rows actually visible under the current filters/page.
  // Missing ids keeps backwards compatibility with older clients that marked all.
  const wanted = Array.isArray(requestedIds)
    ? new Set(requestedIds.map((id) => String(id || '').slice(0, 128)).filter(Boolean).slice(0, NOTIFICATION_CENTER_MAX_PER_ACCOUNT))
    : null;
  const list = notificationCenterStore();
  const readAt = Date.now();
  const changed = [];
  for (const n of list) {
    if (String(n.accountId) !== accountId || Number(n.readAt) > 0) continue;
    if (wanted && !wanted.has(String(n.id))) continue;
    changed.push({ n, previous:n.readAt });
    n.readAt = readAt;
  }
  if (changed.length && persistAfter && !persistNow()) {
    for (const row of changed) row.n.readAt = row.previous;
    const notifications = notificationsForAccount(accountId);
    return {
      error:'write-error', marked:0, readAt:0,
      ids:notifications.filter((n) => !n.unread).map((n) => String(n.id)),
      existingIds:notifications.map((n) => String(n.id)),
    };
  }
  // Return authoritative read/existence ids, not only rows changed by this call.
  // A client may hold a stale pre-read GET, or a row deleted by another client.
  // This lets it reconcile both states without re-adding rows it already deleted.
  const notifications = notificationsForAccount(accountId);
  const ids = notifications.filter((n) => !n.unread).map((n) => String(n.id));
  const existingIds = notifications.map((n) => String(n.id));
  return { marked:changed.length, readAt:changed.length ? readAt : 0, ids, existingIds };
}
function deleteNotificationForAccount(accountId, id, persistAfter = true) {
  accountId = String(accountId || ''); id = String(id || '');
  const list = notificationCenterStore();
  const beforeList = list.slice();
  const next = list.filter((n) => !(String(n.accountId) === accountId && String(n.id) === id));
  if (next.length === beforeList.length) return false;
  state.meta.notifications = next;
  if (persistAfter && !persistNow()) { state.meta.notifications = beforeList; return null; }
  return true;
}
function clearNotificationsForAccount(accountId, persistAfter = true) {
  accountId = String(accountId || '');
  const list = notificationCenterStore();
  const beforeList = list.slice();
  const next = list.filter((n) => String(n.accountId) !== accountId);
  const removed = beforeList.length - next.length;
  if (!removed) return 0;
  state.meta.notifications = next;
  if (persistAfter && !persistNow()) { state.meta.notifications = beforeList; return null; }
  return removed;
}

  function clearRuntimeState() {
    centerActivityTrackers.clear();
    centerRepeatedDownloadTrackers.clear();
    centerVolumeTrackers.clear();
    centerViralTrackers.clear();
    centerTrackerLastPruneAt = 0;
  }

  return {
    NOTIFICATION_MUTABLE_CATEGORIES, CUSTOM_NOTIFICATION_RULE_METRICS,
    clearNotificationDedupeForAccount, notificationAccountIdForShare, notificationAdminAccountIds,
    notificationAccountIdsForRequest, publicNotification, enrichCenterNotificationGeo,
    accountMutedNotificationCategories, setAccountMutedNotificationCategories,
    accountCustomNotificationRules, publicCustomNotificationRule, customNotificationRuleTargets,
    upsertCustomNotificationRule, deleteCustomNotificationRule, pruneCustomNotificationRuleStateForShareId,
    addCenterNotification, addShareCenterNotification, evaluateCustomNotificationRulesForShare,
    addAdminCenterNotification, addRequestCenterNotification, addFirstViewCenterNotification, enrichFirstViewCenterNotification,
    pruneCenterTrackers, centerShareEligibleForVisitorNotification, centerTotalViews, noteCenterCountry,
    maybeCenterViewThreshold, maybeCenterDownloadMilestone, noteCenterActivity, noteCenterRepeatedDownload,
    maybeCenterReceptionQuota, noteCenterAutoDisabled, noteCenterVisitorDevice, noteCenterConcurrentDownloadStart,
    noteCenterHighVolume, noteCenterViral, noteCenterSharedFileSignature, noteCenterCleanup,
    noteCenterServiceState, pushSubAccountIds, pushSubscriptionsForAccountIds, noteExpiredPushSub, checkCenterLinkStates,
    diskFreeThresholds, checkCenterSystemHealth, noteCenterLifecycleStart, noteCenterCleanShutdown,
    noteCenterInstalledVersion, notificationsForAccount, markNotificationsReadForAccount,
    deleteNotificationForAccount, clearNotificationsForAccount, clearRuntimeState,
  };
}

module.exports = { createNotificationCenterService };
