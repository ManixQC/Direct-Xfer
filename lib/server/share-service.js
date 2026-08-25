'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

/**
 * Share domain service for Direct-Xfer.
 *
 * Owns share identity/indexes, tokens and recipients, lifecycle/expiry,
 * logical/backing metrics, statistics/change history, recoverable trash,
 * durable undo, restore/reactivation, managed share storage cleanup,
 * quotas/visitor accounting and expired-link housekeeping.
 *
 * HTTP routes stay in server.js/admin route modules. The service observes the
 * current root store through getState(), so backup restore may replace the root
 * state object without leaving stale closures behind.
 */
function createShareService(deps = {}) {
  const {
    HOST_ROOT,
    INBOX_DIR,
    PENDING_DIR,
    ENC_DIR,
    UNDO_LOG_MAX = 25,
    UNDO_DESCRIPTOR_MAX_BYTES = 256 * 1024,
    asvsL3Mode: ASVS_L3_MODE = false,
    getState,
    getSettings,
    persist = async () => true,
    persistNow = () => true,
    scheduleFlush = () => {},
    hostToContainer,
    containerToHost,
    assertRealWithin,
    resolveWithin,
    folderMetrics,
    resolveHostItem,
    photoStatsOf = () => ({ full:{v:0}, thumb:{v:0}, micro:{v:0} }),
    firstExistingPhotoFile = () => null,
    photoOriginalPaths = () => [],
    photoVariantPaths = () => [],
    photoAdaptivePath = () => null,
    photoVersionDir = () => null,
    uniquePhotoPaths = (items) => [...new Set((items || []).filter(Boolean))],
    webStorageShareMeta = () => null,
    webStorageStat = async () => null,
    accountList = () => [],
    accountCustomNotificationRules = () => [],
    pruneCustomNotificationRuleStateForShareId = () => {},
    scheduleSearchReindex = () => {},
    emitLiveActivity = () => {},
    activityPrincipal = () => ({}),
    getAccountById = () => null,
    findAccountByName = () => null,
    pwaDeviceResolvedAccount = () => null,
    canManagePwaImage = () => false,
    currentAccount = () => null,
    setSettingsDurable,
    pruneHistory,
    bumpHistoryViewRevision,
    addShareCenterNotification = () => {},
    maybeNotifyDownloadThreshold = () => {},
    maybeCenterDownloadMilestone = () => {},
    maybeCenterReceptionQuota = () => {},
    evaluateCustomNotificationRulesForShare = () => {},
    noteCenterAutoDisabled = () => {},
    logAudit = () => {},
    addAdminCenterNotification = () => {},
    clientIp = () => 'unknown',
    maskIp = (ip) => ip,
    geoSync = () => null,
    geolocate = async () => null,
    centerShareEligibleForVisitorNotification = () => false,
    noteCenterCountry = () => {},
    maybeCenterViewThreshold = () => {},
    noteCenterVisitorDevice = () => {},
    noteCenterViral = () => {},
    noteCenterActivity = () => {},
    shareOwnerAccount = () => null,
    getSession = () => null,
    getPwaPublicDevice = () => null,
    pwaDeviceCreatorAccount = () => null,
    pwaDeviceOwnerAccount = () => null,
    requestClientDeviceName = () => '',
    cleanDeviceLabel = (v) => v,
    pubIp = (ip) => ip,
    flagFromCode = () => null,
    validDownloadResumeId = () => null,
    pruneDownloadResumeSessions = () => ({}),
  } = deps;

  for (const [name, value] of Object.entries({
    HOST_ROOT, INBOX_DIR, PENDING_DIR, ENC_DIR, getState, getSettings, hostToContainer,
    containerToHost, assertRealWithin, resolveWithin, folderMetrics, resolveHostItem, setSettingsDurable,
  })) {
    if (value == null) throw new TypeError(`createShareService requires ${name}`);
  }
  if (typeof setSettingsDurable !== 'function') throw new TypeError('createShareService requires setSettingsDurable()');
  if (typeof pruneHistory !== 'function') throw new TypeError('createShareService requires pruneHistory()');
  if (typeof bumpHistoryViewRevision !== 'function') throw new TypeError('createShareService requires bumpHistoryViewRevision()');

  const state = new Proxy({}, {
    get(_target, key) { return getState()[key]; },
    set(_target, key, value) { getState()[key] = value; return true; },
    has(_target, key) { return key in getState(); },
    ownKeys() { return Reflect.ownKeys(getState()); },
    getOwnPropertyDescriptor(_target, key) {
      const current = getState();
      if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
      return { configurable:true, enumerable:true, writable:true, value:current[key] };
    },
  });

  // Runtime epoch invalidates asynchronous work when the root store is replaced
  // (backup restore / rollback). Per-id generation maps alone are insufficient: a
  // restored share can reuse the same id and generation 0, allowing an old scan to
  // repopulate a freshly-cleared cache.
  let runtimeEpoch = 0;
  let activeDestructiveOperations = 0;

  // Shared parsers/projections for HTTP and PWA share creation/editing. Keeping
  // them in the share domain prevents route boundaries from drifting apart.
  const MAX_FUTURE_EXPIRY_MS = 20 * 365 * 86400000;
  const MAX_FUTURE_START_MS = 2 * 365 * 86400000;
  function strictInteger(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  function finiteNow(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  function clampIndex(v, len) {
    const n = strictInteger(v);
    const length = strictInteger(len);
    return n !== null && length !== null && n >= 0 && n < length ? n : 0;
  }
  function normalizePwHint(v) {
    return typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200) : '';
  }
  function parseMaxDownloadsPerIp(v) {
    const n = Number(v);
    if (n === Number.POSITIVE_INFINITY) return 1000000;
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(1000000, Math.floor(n));
  }
  function normalizeShareEmoji(v) {
    const s = String(v || '').replace(/[\r\n\t]/g, '').trim();
    if (!s) return '';
    try {
      const seg = new Intl.Segmenter(undefined, { granularity:'grapheme' });
      return [...seg.segment(s)].slice(0, 2).map((g) => g.segment).join('');
    } catch (_) {
      return [...s].slice(0, 8).join('');
    }
  }
  function parseMaxBytesServed(v) {
    const n = Number(v);
    if (n === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(n));
  }
  const MAX_LINK_RATE_KBPS = Math.floor(Number.MAX_SAFE_INTEGER / 1024);
  function parseLinkRateKBps(v, { optional = false } = {}) {
    if ((v === undefined || v === null || v === '') && optional) return { ok:true, value:0 };
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_LINK_RATE_KBPS) return { ok:false, value:0 };
    return { ok:true, value:n };
  }
  function zipAllowed(s) { return !!s && s.allowZip !== false; }

  function parseExpiry(seconds, now = Date.now()) {
    const current = finiteNow(now);
    const n = strictInteger(seconds);
    if (n === null || n <= 0) return null;
    const boundedSeconds = Math.min(n, Math.floor(MAX_FUTURE_EXPIRY_MS / 1000));
    return current + boundedSeconds * 1000;
  }
  function parseExpiryAt(v, now = Date.now()) {
    const current = finiteNow(now);
    const n = strictInteger(v);
    if (n === null || n <= current) return null;
    return Math.min(n, current + MAX_FUTURE_EXPIRY_MS);
  }
  function resolveExpiry(body, now = Date.now()) {
    if (body && body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== '') return parseExpiryAt(body.expiresAt, now);
    return parseExpiry(body && body.expiresInSeconds, now);
  }
  function newSharesNeverExpireEnabled() {
    try {
      const settings = getSettings();
      return !!settings && settings.newSharesNeverExpire === true;
    } catch (_) { return false; }
  }
  function resolveNewShareExpiry(body, now = Date.now()) {
    return newSharesNeverExpireEnabled() ? null : resolveExpiry(body, now);
  }
  function parseNewShareExpiry(seconds, now = Date.now()) {
    return newSharesNeverExpireEnabled() ? null : parseExpiry(seconds, now);
  }
  function applyNewShareLifetimePolicy(share) {
    if (!share || !newSharesNeverExpireEnabled()) return share;
    for (const key of [
      'expiresAt', 'expirySetAt', 'expiryWarnedAt',
      'firstUseExpirySeconds', 'firstUseExpiresAt', 'firstUseExpiryWarnedDeadline',
      'inactiveExpirySeconds', 'inactiveExpiryWarnedDeadline',
    ]) delete share[key];
    return share;
  }
  function parseStartsAt(v, now = Date.now()) {
    const current = finiteNow(now);
    const n = strictInteger(v);
    if (n === null || n <= current) return null;
    return Math.min(n, current + MAX_FUTURE_START_MS);
  }
  function parseMaxDownloads(v) {
    const n = strictInteger(v);
    if (n === null || n <= 0) return null;
    return n;
  }


  function isBusyForStateReplacement() { return activeDestructiveOperations > 0; }

  function resolveManagedPath(root, candidate) {
    if (!root || !candidate) return null;
    const base = path.resolve(String(root));
    const abs = path.resolve(String(candidate));
    return abs.startsWith(base + path.sep) ? abs : null;
  }

  async function statManagedPath(root, candidate) {
    const abs = resolveManagedPath(root, candidate);
    if (!abs) return null;
    try { await assertRealWithin(root, abs); } catch (_) { return null; }
    try { return { abs, stat: await fs.promises.stat(abs) }; } catch (_) { return null; }
  }

// Records that a recipient opened their nominative link (a "read
// receipt"): first-seen + last-seen timestamps and where from. Called on the
// landing page GET; downloads are tracked separately via recordStat().
function recordRecipientView(req) {
  const tok = req && req.params && req.params.token;
  if (!tok) return;
  const rc = recipientByToken.get(tok);
  if (!rc || !rc.recipient) return;
  const r = rc.recipient;
  const now = Date.now();
  if (!r.viewedAt) r.viewedAt = now; // first open
  r.lastViewAt = now;
  const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
  if (ip) {
    r.lastViewIp = ip;
    const g = geoSync(ip);
    if (g) r.lastViewCountry = g.country;
  }
  scheduleFlush();
}

const byToken = new Map();
const byId = new Map();
const recipientByToken = new Map(); // recipient sub-token -> { share, recipient }

function reindex() {
  byToken.clear();
  byId.clear();
  recipientByToken.clear();
  const shares = Array.isArray(state.shares) ? state.shares : [];
  // Main share tokens always win. Indexing recipients in a second pass prevents
  // a malformed/imported recipient token from shadowing another share's public URL.
  for (const s of shares) {
    if (!s) continue;
    if (s.token && !byToken.has(s.token)) byToken.set(s.token, s);
    if (s.id && !byId.has(s.id)) byId.set(s.id, s);
  }
  for (const s of shares) indexRecipients(s);
}

// Registers a share's nominative sub-links (recipients): each token resolves to
// the parent share for routing, and back to the recipient for attribution.
function indexRecipients(s) {
  if (!s || !Array.isArray(s.recipients)) return;
  for (const r of s.recipients) {
    if (!r || !r.token) continue;
    // Fail closed on collisions. The main URL (or the first valid recipient) keeps
    // ownership of the token instead of allowing a later record to hijack routing.
    if (byToken.has(r.token)) continue;
    byToken.set(r.token, s);
    recipientByToken.set(r.token, { share: s, recipient: r });
  }
}

function isActive(s, now = Date.now()) {
  if (!s || s.revoked) return false;
  if (s.disabled) return false; // manually paused by the admin (reversible, unlike revoke)
  if (s.startsAt && now < s.startsAt) return false; // deferred activation (not yet live)
  if (s.expiresAt && now > s.expiresAt) return false;
  const firstUseDeadline = shareFirstUseDeadline(s);
  if (firstUseDeadline && now > firstUseDeadline) return false;
  const inactiveDeadline = shareInactiveDeadline(s);
  if (inactiveDeadline && now > inactiveDeadline) return false;
  if (s.maxDownloads != null && s.downloads >= s.maxDownloads) return false;
  // PWA image links may be configured with a total view cap. The limit covers
  // Full, Mini and Micro together, so embedding a smaller variant cannot bypass it.
  if (s.type === 'photo' && Number(s.maxViews) > 0) {
    const ps = photoStatsOf(s);
    const totalViews = (Number(ps.full.v) || 0) + (Number(ps.thumb.v) || 0) + (Number(ps.micro.v) || 0);
    if (totalViews >= Number(s.maxViews)) return false;
  }
  return true;
}
// A share that only becomes active later (scheduled), not yet live.
function isScheduled(s, now = Date.now()) {
  return !!(s && !s.revoked && !s.disabled && s.startsAt && now < s.startsAt);
}

// Public URL prefix for a share, by type: download (/s/), reception (/u/) or
// collaboration (/c/). Collab links are bidirectional (browse + upload).
function linkPrefix(s) {
  if (!s) return '/s/';
  if (s.type === 'inbox') return '/u/';
  if (s.type === 'collab') return '/c/';
  if (s.type === 'photo') return '/i/'; // direct image link (Photos tab)
  if (s.type === 'album') return '/g/'; // public image gallery
  return '/s/';
}

function listShares() {
  return state.shares.slice();
}
function getByToken(token) {
  if (!token) return undefined;
  return byToken.get(token);
}
function getById(id) {
  if (!id) return undefined;
  return byId.get(id);
}

// Random link token; compatibility mode keeps the historic 12-byte floor, while
// ASVS L3 enforces >=128 bits of entropy for every non-guessable capability.
function newToken(reservedTokens = null) {
  const n = Math.floor(Number(getSettings().tokenBytes));
  const minimumBytes = ASVS_L3_MODE ? 16 : 12;
  const bytes = Number.isFinite(n) ? Math.min(48, Math.max(minimumBytes, n)) : 24;
  for (let attempt = 0; attempt < 32; attempt++) {
    const token = crypto.randomBytes(bytes).toString('base64url');
    if (!byToken.has(token) && !(reservedTokens && reservedTokens.has(token))) return token;
  }
  throw new Error('share-token-collision');
}
function newShareId() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = crypto.randomBytes(8).toString('hex');
    if (!byId.has(id)) return id;
  }
  throw new Error('share-id-collision');
}
function ensureNewShareIdentity(rec) {
  if (!rec.id || byId.has(rec.id)) rec.id = newShareId();
  if (!rec.token || byToken.has(rec.token)) rec.token = newToken();
  const reserved = new Set([rec.token]);
  if (Array.isArray(rec.recipients)) {
    for (const r of rec.recipients) {
      if (!r || typeof r !== 'object') continue;
      if (!r.token || byToken.has(r.token) || reserved.has(r.token)) r.token = newToken(reserved);
      reserved.add(r.token);
    }
  }
}

function addShare(share, req = null, creationChange = null, persistAfter = true) {
  const rec = Object.assign(
    {
      id: newShareId(),
      token: newToken(),
      createdAt: Date.now(),
      downloads: 0,
      revoked: false,
      expiresAt: null,
      maxDownloads: null,
    },
    share
  );
  ensureNewShareIdentity(rec);
  if (rec.type === 'file' && rec.hostPath) {
    try { const st=fs.statSync(hostToContainer(rec.hostPath)); rec.centerFileSignature=`${Math.max(0,Number(st.size)||0)}:${Math.floor(Number(st.mtimeMs)||0)}`; } catch (_) {}
  }
  state.shares.push(rec);
  byToken.set(rec.token, rec);
  byId.set(rec.id, rec);
  // Shares created from clone/import payloads may already contain nominative
  // recipients. Index them immediately; waiting for a later global reindex makes
  // those recipient URLs return 404 until another mutation or restart.
  indexRecipients(rec);
  // Seed a change-history row only when the caller explicitly describes the
  // creation (clone/import). A plain new link starts with an empty history so its
  // first real edit is entry #1 — creation itself is already recorded by createdAt.
  // Shares that arrive carrying their own changeHistory are never reseeded.
  if (creationChange && (!Array.isArray(rec.changeHistory) || !rec.changeHistory.length)) {
    const cc = typeof creationChange === 'object' ? creationChange : {};
    recordShareChange(rec, req, cc.action || 'created', cc.fields || [], cc.before || null);
  }
  if (persistAfter) persist();
  return rec;
}
function addShareDurable(share, req = null, creationChange = null) {
  const rec = addShare(share, req, creationChange, false);
  if (persistNow()) return rec;
  detachActiveShare(rec);
  return null;
}
function restorePlainObject(target, snapshot) {
  if (!target || !snapshot) return;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, JSON.parse(JSON.stringify(snapshot)));
}

// Dashboard productivity metadata. These fields affect only the administrator
// experience; archiving a share never changes the public link's availability.
const SHARE_CHANGE_HISTORY_MAX = 100;
const SHARE_LOGICAL_BYTES_CACHE_MS = 30 * 1000;
const shareLogicalBytesCache = new Map();
const shareLogicalBytesRefreshes = new Map();
const shareLogicalBytesGeneration = new Map();
// Standard-admin source health (#39). The high-frequency /api/shares poll must
// never block on filesystem I/O, so backing availability is refreshed in the
// background and cached briefly. A generation guard prevents stale scans from
// overwriting a newer result after a share is edited.
const SHARE_BACKING_HEALTH_CACHE_MS = 30 * 1000;
const shareBackingHealthCache = new Map();
const shareBackingHealthRefreshes = new Map();
const shareBackingHealthGeneration = new Map();
function shareBackingHealthRelevant(s) {
  return !!(s && ['file','folder','inbox','collab','photo','album'].includes(s.type));
}
function shareBackingHealthSnapshot(s) {
  if (!shareBackingHealthRelevant(s)) return { status:'na', checkedAt:0 };
  const cached = shareBackingHealthCache.get(s.id);
  if (!cached) return { status:'checking', checkedAt:0 };
  return { status:cached.available ? 'ok' : 'missing', checkedAt:cached.at || 0, reason:cached.reason || null };
}
async function refreshShareBackingHealth(s, force=false, expectedGeneration=null, expectedEpoch=runtimeEpoch) {
  if (!shareBackingHealthRelevant(s)) return { available:true, reason:null };
  const now=Date.now(), cached=shareBackingHealthCache.get(s.id);
  if (!force && cached && now-cached.at < SHARE_BACKING_HEALTH_CACHE_MS) return cached;
  const availability = await shareReactivationAvailability(s).catch(() => ({ available:false, reason:'data-missing' }));
  const row={ at:Date.now(), available:!!availability.available, reason:availability.reason || null };
  if (expectedEpoch === runtimeEpoch && (expectedGeneration == null || (shareBackingHealthGeneration.get(s.id)||0) === expectedGeneration)) shareBackingHealthCache.set(s.id,row);
  return row;
}
function queueShareBackingHealthRefresh(s) {
  if (!shareBackingHealthRelevant(s)) return null;
  const cached=shareBackingHealthCache.get(s.id);
  if (cached && Date.now()-cached.at < SHARE_BACKING_HEALTH_CACHE_MS) return null;
  if (shareBackingHealthRefreshes.has(s.id)) return shareBackingHealthRefreshes.get(s.id);
  const generation=shareBackingHealthGeneration.get(s.id)||0;
  const epoch=runtimeEpoch;
  const job=refreshShareBackingHealth(s,false,generation,epoch).catch(()=>null).finally(()=>{ if(shareBackingHealthRefreshes.get(s.id)===job) shareBackingHealthRefreshes.delete(s.id); });
  shareBackingHealthRefreshes.set(s.id,job); return job;
}
function invalidateShareBackingHealth(id) {
  if (!id) return;
  shareBackingHealthGeneration.set(id,(shareBackingHealthGeneration.get(id)||0)+1);
  shareBackingHealthCache.delete(id); shareBackingHealthRefreshes.delete(id);
}
function shareLogicalBytes(s) {
  if (s && (s.type === 'inbox' || s.type === 'collab')) return Math.max(0, Number(s.bytesReceived) || 0);
  const cached = s && shareLogicalBytesCache.get(s.id);
  if (cached && Number.isFinite(cached.bytes)) return Math.max(0, cached.bytes);
  const items = shareItems(s);
  if (items && items.length) return items.reduce((n, it) => n + Math.max(0, Number(it && it.size) || 0), 0);
  return Math.max(0, Number(s && s.size) || 0);
}
function shareLogicalFileCount(s) {
  if (!s || s.type === 'inbox' || s.type === 'collab' || s.type === 'photo' || s.type === 'album') return null;
  const cached = shareLogicalBytesCache.get(s.id);
  if (cached && Number.isFinite(cached.files)) return Math.max(0, Math.floor(cached.files));
  if (s.type === 'folder') return null; // populated asynchronously by the recursive metrics scan
  const items = shareItems(s);
  if (items && items.length && !items.some((it) => it && it.type === 'folder')) return items.length;
  if (s.type === 'file' && !items) return 1;
  return null;
}
function shareNeedsLogicalBytesScan(s) {
  if (!s || s.type === 'inbox' || s.type === 'collab' || s.type === 'photo' || s.type === 'album') return false;
  if (s.type === 'folder') return true;
  const items = shareItems(s);
  return !!(items && items.some((it) => (it && it.type) === 'folder'));
}
async function refreshShareLogicalBytes(s, force = false, expectedGeneration = null, expectedEpoch = runtimeEpoch) {
  if (!shareNeedsLogicalBytesScan(s)) return shareLogicalBytes(s);
  const now = Date.now();
  const cached = shareLogicalBytesCache.get(s.id);
  if (!force && cached && now - cached.at < SHARE_LOGICAL_BYTES_CACHE_MS) return cached.bytes;
  let total = 0, files = 0;
  const items = s.type === 'folder'
    ? [{ hostPath: s.hostPath, type: 'folder', size: null }]
    : (shareItems(s) || []);
  for (const item of items) {
    if (!item) continue;
    if (item.type !== 'folder') { total += Math.max(0, Number(item.size) || 0); files += 1; continue; }
    try {
      const abs = hostToContainer(item.hostPath);
      await assertRealWithin(HOST_ROOT, abs);
      const metrics = await folderMetrics(abs);
      total += metrics.bytes; files += metrics.files;
    } catch (_) {}
  }
  if (expectedEpoch === runtimeEpoch && (expectedGeneration == null || (shareLogicalBytesGeneration.get(s.id) || 0) === expectedGeneration)) {
    shareLogicalBytesCache.set(s.id, { at: now, bytes: total, files });
  }
  return total;
}
function queueShareLogicalBytesRefresh(s) {
  if (!shareNeedsLogicalBytesScan(s)) return null;
  const cached = shareLogicalBytesCache.get(s.id);
  if (cached && Date.now() - cached.at < SHARE_LOGICAL_BYTES_CACHE_MS) return null;
  if (shareLogicalBytesRefreshes.has(s.id)) return shareLogicalBytesRefreshes.get(s.id);
  const generation = shareLogicalBytesGeneration.get(s.id) || 0;
  const epoch = runtimeEpoch;
  const job = refreshShareLogicalBytes(s, false, generation, epoch).catch(() => shareLogicalBytes(s)).finally(() => {
    if (shareLogicalBytesRefreshes.get(s.id) === job) shareLogicalBytesRefreshes.delete(s.id);
  });
  shareLogicalBytesRefreshes.set(s.id, job);
  return job;
}
function invalidateShareLogicalBytes(id) {
  if (!id) return;
  shareLogicalBytesGeneration.set(id, (shareLogicalBytesGeneration.get(id) || 0) + 1);
  shareLogicalBytesCache.delete(id);
  // Do not let an old scan block a fresh one after the collection changed. Its
  // generation guard prevents it from overwriting the new cache if it finishes last.
  shareLogicalBytesRefreshes.delete(id);
  invalidateShareBackingHealth(id);
}
function shareActivityAt(s) {
  if (!s) return 0;
  const st = state.stats && state.stats[s.id];
  let at = Math.max(Number(s.lastViewAt) || 0, Number(st && st.lastAt) || 0, Number(s.createdAt) || 0);
  if (s.type === 'photo') {
    const ps = photoStatsOf(s);
    at = Math.max(at, Number(ps.full && ps.full.lastAt) || 0, Number(ps.thumb && ps.thumb.lastAt) || 0, Number(ps.micro && ps.micro.lastAt) || 0);
  }
  return at;
}
function normalizeShareColor(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}
function normalizeDescriptionMd(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, 8000);
}
function boundedSeconds(value, maxSeconds = 10 * 365 * 86400) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(maxSeconds, Math.max(60, Math.round(n)));
}
function shareLastUseAt(s) {
  if (!s) return 0;
  // Include the pre-existing transfer aggregate so enabling inactivity expiry on
  // an older, actively used share does not treat it as idle since creation just
  // because lastUseAt was introduced by a newer Direct-Xfer release.
  return Math.max(
    Number(s.lastUseAt) || 0,
    Number(s.lastViewAt) || 0,
    Number(s.lastDownload && s.lastDownload.at) || 0,
    Number(s.lastUpload && s.lastUpload.at) || 0,
    shareActivityAt(s),
    Number(s.createdAt) || 0,
  );
}
function shareFirstUseDeadline(s) {
  if (!s || !s.firstUsedAt) return null;
  const seconds = Math.max(0, Number(s.firstUseExpirySeconds) || 0);
  if (!seconds) return null;
  const stored = Number(s.firstUseExpiresAt) || 0;
  return stored > 0 ? stored : Number(s.firstUsedAt) + seconds * 1000;
}
function shareInactiveDeadline(s) {
  const seconds = Math.max(0, Number(s && s.inactiveExpirySeconds) || 0);
  return seconds > 0 ? shareLastUseAt(s) + seconds * 1000 : null;
}
function shareDownloadLimitDeadline(s) {
  const max = Math.max(0, Number(s && s.maxDownloads) || 0);
  if (!max || Math.max(0, Number(s.downloads) || 0) < max) return null;
  // New transfers stamp the exact crossing time. For an older exhausted share,
  // lastDownload is the safest migration fallback; never invent createdAt because
  // that could make enabling retention purge old data immediately.
  return Number(s.downloadLimitReachedAt) || Number(s.lastDownload && s.lastDownload.at) || null;
}
function shareEffectiveExpiry(s) {
  if (!s) return null;
  const deadlines = [Number(s.expiresAt) || 0, Number(shareFirstUseDeadline(s)) || 0, Number(shareInactiveDeadline(s)) || 0, Number(shareDownloadLimitDeadline(s)) || 0].filter((v) => v > 0);
  return deadlines.length ? Math.min(...deadlines) : null;
}

// 1.35.4 lifecycle migration: releases <=1.35.3 stored the first-use deadline in
// `expiresAt`, mixing an automatic runtime deadline with the administrator's fixed
// expiry. Split that state without making existing links expire sooner. When the
// old deadline is clearly the one generated at first use, move it; otherwise keep
// the fixed deadline too and mirror it as the legacy first-use deadline so the
// effective expiry is unchanged until the administrator edits either rule.
function migrateLegacyFirstUseExpiryState() {
  let changed = false;
  for (const sh of listShares()) {
    if (!sh || !sh.firstUsedAt || !(Number(sh.firstUseExpirySeconds) > 0) || Number(sh.firstUseExpiresAt) > 0) continue;
    const expected = Number(sh.firstUsedAt) + Number(sh.firstUseExpirySeconds) * 1000;
    const current = Number(sh.expiresAt) || 0;
    if (current > 0) {
      sh.firstUseExpiresAt = current;
      const generatedAtFirstUse = Math.abs(current - expected) <= 2000 && Math.abs((Number(sh.expirySetAt) || 0) - Number(sh.firstUsedAt)) <= 5000;
      if (generatedAtFirstUse) {
        delete sh.expiresAt;
        delete sh.expirySetAt;
      }
    } else {
      sh.firstUseExpiresAt = expected;
    }
    delete sh.firstUseExpiryWarnedDeadline;
    changed = true;
  }
  return changed;
}
function shareStatsBaseline(s) {
  const b = s && s.statsBaseline && typeof s.statsBaseline === 'object' ? s.statsBaseline : {};
  return {
    downloads: Math.max(0, Number(b.downloads) || 0), views: Math.max(0, Number(b.views) || 0),
    visitors: Math.max(0, Number(b.visitors) || 0), count: Math.max(0, Number(b.count) || 0),
    bytes: Math.max(0, Number(b.bytes) || 0), up: Math.max(0, Number(b.up) || 0), down: Math.max(0, Number(b.down) || 0),
    completed: Math.max(0, Number(b.completed) || 0), interrupted: Math.max(0, Number(b.interrupted) || 0),
    at: Math.max(0, Number(b.at) || 0),
  };
}
function displayStatsForShare(s) {
  const raw = (state.stats && state.stats[s.id]) || null;
  if (!raw) return null;
  const b = shareStatsBaseline(s);
  return {
    ...raw,
    count: Math.max(0, (Number(raw.count) || 0) - b.count),
    bytes: Math.max(0, (Number(raw.bytes) || 0) - b.bytes),
    up: Math.max(0, (Number(raw.up) || 0) - b.up),
    down: Math.max(0, (Number(raw.down) || 0) - b.down),
    completed: Math.max(0, (Number(raw.completed) || 0) - b.completed),
    interrupted: Math.max(0, (Number(raw.interrupted) || 0) - b.interrupted),
    lastAt: (Number(raw.lastAt) || 0) > b.at ? raw.lastAt : 0,
  };
}

function shareChangeSnapshot(s) {
  return {
    name: s.name || '', expiresAt: s.expiresAt || null, startsAt: s.startsAt || null, disabled: !!s.disabled, revoked: !!s.revoked,
    pinned: !!s.pinned, archived: !!s.archived, autoArchivedAt: Number(s.autoArchivedAt) || null, tags: Array.isArray(s.tags) ? s.tags.slice() : [], color: s.color || '',
    adminNote: s.adminNote || '', note: s.note || '', descriptionMd: s.descriptionMd || '', hasPassword: !!s.pwHash, maxDownloads: s.maxDownloads || null,
    expiryReminderHours: s.expiryReminderHours == null ? null : Number(s.expiryReminderHours), firstUseExpirySeconds: Number(s.firstUseExpirySeconds) || 0, inactiveExpirySeconds: Number(s.inactiveExpirySeconds) || 0,
    maxVisitors: parseMaxVisitors(s.maxVisitors), rateKBps: s.rateBps > 0 ? Math.round(s.rateBps / 1024) : 0,
    allowZip: s.allowZip !== false, noPreview: !!s.noPreview, burnAfterDownload: !!s.burnAfterDownload,
    allowDelete: !!s.allowDelete, favorite: !!s.favorite,
    geoMode: s.geoMode || null, geoCountries: Array.isArray(s.geoCountries) ? s.geoCountries.slice() : [],
    ipMode: s.ipMode || null, ipList: Array.isArray(s.ipList) ? s.ipList.slice() : [],
  };
}
function safeShareChangeValue(v) {
  if (Array.isArray(v)) return v.slice(0, 20);
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  return undefined;
}
function recordShareChange(s, req, action, fields, before) {
  if (!s) return;
  const changed = Array.isArray(fields) ? fields.filter(Boolean).slice(0, 30) : [];
  const after = shareChangeSnapshot(s);
  const diff = {};
  for (const field of changed) {
    // Password history records only presence/absence, never a secret or hash.
    let key = field.startsWith('password-') ? 'hasPassword' : field.replace(/-(set|cleared|off)$/,'');
    if (field === 'enabled') key = 'disabled';
    if (field === 'unfavorite') key = 'favorite';
    if (!(key in after)) continue;
    const prev = before && key in before ? safeShareChangeValue(before[key]) : undefined;
    const next = safeShareChangeValue(after[key]);
    if (prev !== undefined || next !== undefined) diff[key] = { before: prev, after: next };
  }
  const acc = req && req.session ? currentAccount(req) : null;
  const pwaSession = req && req.pwaSession ? req.pwaSession : null;
  const pwaDevice = req && req.pwaDevice ? req.pwaDevice : null;
  const actor = (acc && acc.username)
    || (req && req.session && req.session.username)
    || (pwaSession && pwaSession.username)
    || (pwaDevice && ('PWA: ' + (pwaDevice.name || pwaDevice.id || 'device')))
    || 'system';
  const role = (acc && acc.role)
    || (req && req.session && req.session.role)
    || (pwaSession && pwaSession.role)
    || (pwaDevice ? 'device' : null)
    || 'system';
  const entry = {
    at: Date.now(), action: String(action || 'edited').slice(0, 40), fields: changed,
    actor: String(actor).slice(0, 120), role: String(role).slice(0, 40), diff,
  };
  if (!Array.isArray(s.changeHistory)) s.changeHistory = [];
  s.changeHistory.unshift(entry);
  if (s.changeHistory.length > SHARE_CHANGE_HISTORY_MAX) s.changeHistory.length = SHARE_CHANGE_HISTORY_MAX;
}

// Recoverable trash for manual revocations. Host-mounted source files are never
// moved/deleted; Direct-Xfer-managed data stays in place until permanent purge.
function trashItems() { if (!Array.isArray(state.trash)) state.trash = []; return state.trash; }
function detachActiveShare(s) {
  if (!s) return false; const i=state.shares.findIndex((x)=>x.id===s.id); if(i<0)return false;
  state.shares.splice(i,1); invalidateShareLogicalBytes(s.id); byToken.delete(s.token); byId.delete(s.id);
  if(Array.isArray(s.recipients)) for(const r of s.recipients){ if(r&&r.token){byToken.delete(r.token);recipientByToken.delete(r.token);} }
  return true;
}
function attachActiveShareExact(sh) {
  if (!sh) return false;
  if (!state.shares.some((row) => row && row.id === sh.id)) state.shares.push(sh);
  byId.set(sh.id, sh); byToken.set(sh.token, sh); indexRecipients(sh); invalidateShareLogicalBytes(sh.id);
  return true;
}
function softDeleteShare(id, req, persistAfter=true, undoSpec=null) {
  const sh=getById(id); if(!sh)return null;
  const beforeHistory=Array.isArray(sh.changeHistory)?JSON.parse(JSON.stringify(sh.changeHistory)):null;
  recordShareChange(sh, req, 'revoked', [], null);
  if(!detachActiveShare(sh))return null;
  const deletedBy=(req&&req.session&&req.session.username)||(req&&req.pwaSession&&req.pwaSession.username)||(req&&req.pwaDevice&&('PWA: '+req.pwaDevice.name))||'system';
  const rec={id:crypto.randomBytes(8).toString('hex'),deletedAt:Date.now(),deletedBy,ownerId:sh.ownerId||null,ownerName:sh.ownerName||null,share:sh};
  trashItems().unshift(rec);
  const undoEntry = undoSpec && undoSpec.type
    ? recordUndoable(req, undoSpec.type, undoSpec.label || ((sh.type||'share')+' '+(sh.name||'')), {kind:'restore-trash',trashId:rec.id,shareId:sh.id})
    : null;
  if(persistAfter && !persistNow()) {
    rollbackRecordedUndo(undoEntry);
    const i=trashItems().findIndex((row)=>row&&row.id===rec.id); if(i>=0)trashItems().splice(i,1);
    if(beforeHistory)sh.changeHistory=beforeHistory; else delete sh.changeHistory;
    attachActiveShareExact(sh); reindex(); shareLogicalBytesCache.clear();
    return false;
  }
  if(persistAfter) emitLiveActivity('trash',{shareId:sh.id,name:sh.name,status:'deleted',detail:sh.type||'share',...activityPrincipal(req)});
  try{scheduleSearchReindex();}catch(_){} return rec;
}
function trashRecordVisible(req,rec){ if(!rec||!rec.share)return false; return req.session.role!=='operator'||(!!rec.share.ownerId&&rec.share.ownerId===req.session.accountId); }
async function trashManagedPurgeMetrics(sh) {
  let bytes=0, itemCount=0; const seen=new Set();
  async function addPath(candidate, managedRoot = null) {
    if (!candidate) return;
    let abs = path.resolve(String(candidate));
    if (managedRoot) {
      const managed = await statManagedPath(managedRoot, abs);
      if (!managed) return;
      abs = managed.abs;
    }
    if (seen.has(abs)) return; seen.add(abs);
    let st; try { st=await fs.promises.stat(abs); } catch (_) { return; }
    if (st.isFile()) { bytes+=Math.max(0,Number(st.size)||0); itemCount+=1; return; }
    if (st.isDirectory()) { const m=await folderMetrics(abs); bytes+=Math.max(0,Number(m.bytes)||0); itemCount+=Math.max(0,Number(m.files)||0); }
  }
  if (state.meta && Array.isArray(state.meta.pending)) {
    for (const row of state.meta.pending) {
      if (!row || row.shareId !== sh.id) continue;
      let candidate = null; try { candidate = resolveWithin(PENDING_DIR, String(row.id || '')); } catch (_) {}
      if (candidate) await addPath(candidate, PENDING_DIR);
    }
  }
  if (sh.encPath) await addPath(sh.encPath, ENC_DIR);
  if (sh.type === 'photo') {
    for (const candidate of photoVariantPaths(sh.token,'thumb')) await addPath(candidate);
    for (const candidate of photoVariantPaths(sh.token,'micro')) await addPath(candidate);
    for (const candidate of photoOriginalPaths(sh)) await addPath(candidate);
    await addPath(photoAdaptivePath(sh.token,'webp')); await addPath(photoAdaptivePath(sh.token,'avif'));
    await addPath(photoVersionDir(sh.token));
  }
  if (['inbox','collab'].includes(sh.type) && sh.relDir && !managedInboxDirStillReferenced(sh)) {
    try { await addPath(resolveWithin(INBOX_DIR,sh.relDir), INBOX_DIR); } catch (_) {}
  }
  return { bytes, itemCount };
}
async function trashPurgeImpact(rec) {
  const sh = rec && rec.share || {}, dependencies = [];
  const managed = await trashManagedPurgeMetrics(sh);
  if (sh.type === 'photo') {
    const albums = listShares().filter((row) => row && row.type === 'album' && Array.isArray(row.members) && row.members.includes(sh.token)).length;
    if (albums) dependencies.push(`${albums} album(s)`);
    const versions = Array.isArray(sh.photoVersions) ? sh.photoVersions.length : 0;
    if (versions) dependencies.push(`${versions} version(s)`);
  }
  if (['inbox','collab'].includes(sh.type) && managedInboxDirStillReferenced(sh)) dependencies.push('données partagées avec un autre lien');
  const rules = accountList().reduce((n,acc)=>n+accountCustomNotificationRules(acc.id).filter((rule)=>rule && String(rule.shareId||'')===String(sh.id||'')).length,0);
  if (rules) dependencies.push(`${rules} règle(s) de notification`);
  return { bytes:managed.bytes, itemCount:managed.itemCount, dependencyCount:dependencies.length, dependencies };
}
async function trashPublicRecord(rec){ const sh=rec.share||{}, purgeImpact=await trashPurgeImpact(rec); return {id:rec.id,deletedAt:rec.deletedAt||0,deletedBy:rec.deletedBy||null,shareId:sh.id,name:sh.name||'',type:sh.type||'',ownerName:sh.ownerName||null,createdAt:sh.createdAt||0,logicalBytes:shareLogicalBytes(sh),expiresAt:shareEffectiveExpiry(sh)||null,restorable:true,purgeImpact}; }

async function trashRestoreAlternatives(sh) {
  if (!sh || !['file','folder'].includes(sh.type) || !sh.hostPath) return [];
  const wantDir = sh.type === 'folder', wanted = path.basename(String(sh.hostPath || '')).toLowerCase(), out = [];
  let original; try { original = hostToContainer(sh.hostPath); } catch (_) { return []; }
  const roots = [path.dirname(original), path.dirname(path.dirname(original))];
  for (const root of roots) {
    let entries; try { entries = await fs.promises.readdir(root, { withFileTypes:true }); } catch (_) { continue; }
    for (const ent of entries.slice(0,200)) {
      if (!!ent.isDirectory() !== wantDir) continue;
      const name = String(ent.name || ''), low = name.toLowerCase();
      if (wanted && low !== wanted && !low.includes(wanted.replace(/\.[^.]+$/,''))) continue;
      const abs = path.join(root,name); try { await assertRealWithin(HOST_ROOT,abs); } catch (_) { continue; }
      let host; try { host = containerToHost(abs); } catch (_) { continue; }
      if (host && host !== sh.hostPath && !out.includes(host)) out.push(host);
      if (out.length >= 5) return out;
    }
  }
  return out;
}
async function trashRestoreAssessment(rec) {
  const sh = rec && rec.share; if (!sh) return { available:false, reason:'not-found', alternatives:[] };
  const availability = await shareReactivationAvailability(sh);
  return { available:!!availability.available, reason:availability.reason || null, alternatives:availability.available ? [] : await trashRestoreAlternatives(sh) };
}
async function applyTrashRestoreAlternative(sh, alternativePath) {
  if (!sh || !alternativePath || !['file','folder'].includes(sh.type)) return false;
  const item = await resolveHostItem(String(alternativePath));
  if (!item || (sh.type === 'folder' && item.type !== 'folder') || (sh.type === 'file' && item.type !== 'file')) return false;
  sh.hostPath=item.hostPath; sh.size=item.size == null ? sh.size : item.size;
  if (sh.type === 'file') sh.items=[{hostPath:item.hostPath,name:item.name,size:item.size,type:'file'}];
  invalidateShareLogicalBytes(sh.id); return true;
}

// --- Undoable action log (#89). A bounded, persisted, chronological record of the
// most recent destructive admin actions, each carrying a serializable descriptor
// that performUndo() can reverse. Complements (does not replace) the recoverable
// trash and the ephemeral post-revoke toast: this log is durable, unified across
// action types, and reversible in one click from the admin UI.
function sanitizeUndoLog(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [], seen = new Set();
  for (const row of raw) {
    if (out.length >= UNDO_LOG_MAX) break;
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '');
    if (!/^[a-f0-9]{16}$/i.test(id) || seen.has(id)) continue;
    let undo = cloneUndoDescriptor(row.undo);
    if (!undo || typeof undo !== 'object' || typeof undo.kind !== 'string') continue;
    let bytes = Infinity;
    try { bytes = Buffer.byteLength(JSON.stringify(undo)); } catch (_) {}
    // Keep the action visible even when a legacy/imported descriptor is too large
    // to retain safely. Dropping the whole row made the history silently incomplete.
    if (bytes > UNDO_DESCRIPTOR_MAX_BYTES) undo = { kind:'unavailable', reason:'undo-too-large' };
    seen.add(id);
    out.push({
      id,
      at: Math.max(0, Number(row.at) || 0),
      type: String(row.type || 'action').slice(0, 60),
      label: String(row.label == null ? '' : row.label).slice(0, 200),
      actor: String(row.actor || 'system').slice(0, 120),
      accountId: row.accountId == null ? null : String(row.accountId).slice(0, 120),
      deviceId: row.deviceId == null ? null : String(row.deviceId).slice(0, 120),
      undo,
      undone: !!row.undone,
      undoneAt: Math.max(0, Number(row.undoneAt) || 0),
    });
  }
  return out;
}
function undoLogItems() { if (!Array.isArray(state.undoLog)) state.undoLog = []; return state.undoLog; }
function undoRequestAccount(req) {
  if (!req) return null;
  if (req.session) return (req.session.accountId && getAccountById(req.session.accountId)) || findAccountByName(req.session.username || '') || null;
  if (req.pwaSession) return (req.pwaSession.accountId && getAccountById(req.pwaSession.accountId)) || findAccountByName(req.pwaSession.username || '') || null;
  if (req.pwaDevice) return pwaDeviceResolvedAccount(req.pwaDevice) || null;
  return null;
}
function undoActor(req) {
  return (req && req.session && req.session.username)
      || (req && req.pwaSession && req.pwaSession.username)
      || (req && req.pwaDevice && ('PWA: ' + req.pwaDevice.name))
      || 'system';
}
function cloneUndoDescriptor(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_) { return null; }
}
function rollbackRecordedUndo(entry) {
  if (!entry) return;
  const list = undoLogItems();
  const i = list.findIndex((row) => row && row.id === entry.id);
  if (i >= 0) list.splice(i, 1);
  if (entry.__evictedUndo && list.length < UNDO_LOG_MAX) list.push(entry.__evictedUndo);
}
// Record a reversible action. `undo` is a plain descriptor consumed by performUndo:
//   { kind:'settings', before:{...}, after:{...} } current values must still match `after`
//   { kind:'ip-names', before:{...}, after:{} }    restoring cannot overwrite newer nicknames
//   { kind:'share-assign', shareId, set, unset, expect } only touched fields are conflict-checked
//   { kind:'restore-trash', trashId, shareId }      restore a soft-deleted share from trash
function recordUndoable(req, type, label, undo) {
  if (!undo || !undo.kind) return null;
  // Always detach the history snapshot from live state. Without this clone, restoring
  // an object (notably ipNames) could make later edits mutate the stored Undo payload.
  let descriptor = cloneUndoDescriptor(undo);
  if (!descriptor || !descriptor.kind) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(descriptor)) > UNDO_DESCRIPTOR_MAX_BYTES) descriptor = { kind:'unavailable', reason:'undo-too-large' };
  } catch (_) { return null; }
  const account = undoRequestAccount(req);
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    at: Date.now(),
    type: String(type || 'action').slice(0, 60),
    label: String(label == null ? '' : label).slice(0, 200),
    actor: undoActor(req),
    accountId: account ? account.id : null,
    // Device ownership is intentionally recorded separately from account ownership.
    // A durable paired-device cookie is a narrower capability than an admin session.
    deviceId: req && req.pwaDevice && req.pwaDevice.id ? String(req.pwaDevice.id) : null,
    undo: descriptor,
    undone: false, undoneAt: 0,
  };
  const list = undoLogItems();
  const evicted = list.length >= UNDO_LOG_MAX ? list[list.length - 1] : null;
  list.unshift(entry);
  if (list.length > UNDO_LOG_MAX) list.length = UNDO_LOG_MAX;
  if (evicted) Object.defineProperty(entry, '__evictedUndo', { value: evicted, enumerable: false, configurable: true });
  return entry;
}
function undoRequestSession(req) {
  return (req && req.session) || (req && req.pwaSession) || null;
}
// A real admin session retains the standard role semantics. A bare paired PWA
// device may only see actions that exact device recorded; account ownership alone
// must never turn the durable device cookie into a full administrator capability.
function undoEntryVisible(req, entry) {
  if (!entry) return false;
  const account = undoRequestAccount(req);
  const session = undoRequestSession(req);
  const role = (session && session.role) || '';
  if (role === 'owner' || role === 'admin') return true;
  if (session) return !!(account && entry.accountId && String(entry.accountId) === String(account.id));
  const device = req && req.pwaDevice;
  if (!device || !account) return false;
  // Owner/admin paired devices already have global PWA link-management visibility;
  // keep the history equally informative, while undoEntryExecutable() below still
  // prevents this durable device capability from becoming a settings rollback API.
  if (account.role === 'owner' || account.role === 'admin') return true;
  return !!(entry.accountId && String(entry.accountId) === String(account.id));
}
function undoValuesMatch(actual, expected) { return isDeepStrictEqual(actual, expected); }
function undoAvailability(entry) {
  if (!entry || entry.undone) return { canUndo: false, reason: entry && entry.undone ? 'already-undone' : 'not-found' };
  const u = entry.undo || {};
  if (u.kind === 'settings') {
    // 1.52.0 entries did not store the post-action snapshot. Replaying one after a
    // newer edit could silently clobber that newer configuration, so fail closed.
    if (!u.after || typeof u.after !== 'object') return { canUndo: false, reason: 'legacy-unsafe' };
    const current = getSettings();
    for (const key of Object.keys(u.after)) if (!undoValuesMatch(current[key], u.after[key])) return { canUndo: false, reason: 'state-changed' };
    return { canUndo: true, reason: '' };
  }
  if (u.kind === 'ip-names') {
    const expected = (u.after && typeof u.after === 'object') ? u.after : {};
    return undoValuesMatch(state.ipNames || {}, expected)
      ? { canUndo: true, reason: '' }
      : { canUndo: false, reason: 'state-changed' };
  }
  if (u.kind === 'share-assign') {
    const live = getById(u.shareId);
    if (!live) return { canUndo: false, reason: 'share-gone' };
    if (!u.expect || typeof u.expect !== 'object') return { canUndo: false, reason: 'legacy-unsafe' };
    for (const key of Object.keys(u.expect)) if (!undoValuesMatch(live[key], u.expect[key])) return { canUndo: false, reason: 'state-changed' };
    if (Array.isArray(u.expectUnset)) for (const key of u.expectUnset) if (Object.prototype.hasOwnProperty.call(live, key)) return { canUndo: false, reason: 'state-changed' };
    return { canUndo: true, reason: '' };
  }
  if (u.kind === 'unavailable') return { canUndo:false, reason:String(u.reason || 'undo-unsupported') };
  if (u.kind === 'restore-trash') {
    const rec = trashItems().find((r) => r && r.id === u.trashId);
    if (rec && rec.share) {
      const sh = rec.share;
      const idConflict = !!(sh.id && byId.has(sh.id));
      const tokenConflict = !!(sh.token && byToken.has(sh.token));
      const recipientConflict = Array.isArray(sh.recipients) && sh.recipients.some((r) => r && r.token && byToken.has(r.token));
      // restoreTrashRecord() can generate replacement ids/tokens for a manual
      // restore. Undo must be stricter: silently changing the original URL is not
      // a faithful reversal, so surface the collision instead.
      if (idConflict || tokenConflict || recipientConflict) return { canUndo: false, reason: 'restore-conflict' };
      return { canUndo: true, reason: '' };
    }
    if (u.shareId && getById(u.shareId)) return { canUndo: false, reason: 'already-restored' };
    return { canUndo: false, reason: 'already-purged' };
  }
  return { canUndo: false, reason: 'undo-unsupported' };
}
function undoEntryExecutable(req, entry) {
  if (!undoEntryVisible(req, entry)) return false;
  const session = undoRequestSession(req);
  const role = session && session.role || '';
  const account = undoRequestAccount(req);
  const u = entry && entry.undo || {};
  if (role === 'owner' || role === 'admin') return true;
  if (role === 'auditor') return false;
  if (role === 'operator') {
    // A demoted account must not retain the ability to roll back global settings
    // merely because it created that history entry while it used to be an admin.
    if (u.kind === 'restore-trash') {
      const rec = trashItems().find((row) => row && row.id === u.trashId);
      if (!rec) return true;
      return !!(rec.share && account && rec.share.ownerId && String(rec.share.ownerId) === String(account.id));
    }
    if (u.kind === 'share-assign') {
      const live = getById(u.shareId);
      if (!live) return true;
      return !!(account && live.ownerId && String(live.ownerId) === String(account.id));
    }
    return false;
  }
  // Device-only PWA authentication is deliberately narrow. Its own recoverable
  // revocation may be restored, but it cannot roll back settings, another device's
  // history, or other admin data. The account id is intentionally insufficient here:
  // the durable PWA cookie is a per-device bearer capability, not an admin session.
  if (!(req && req.pwaDevice) || u.kind !== 'restore-trash') return false;
  if (!entry.deviceId || String(entry.deviceId) !== String(req.pwaDevice.id || '')) return false;
  const rec = trashItems().find((row) => row && row.id === u.trashId);
  // If the target was already restored/purged, let performUndo return the precise
  // 410/409 state instead of disguising it as an authorization failure.
  if (!rec) return true;
  return !!(rec.share && canManagePwaImage(req, rec.share));
}
function undoPublicEntry(entry, req) {
  const availability = undoAvailability(entry);
  const executable = !req || undoEntryExecutable(req, entry);
  const canUndo = availability.canUndo && executable;
  const reason = availability.reason || (canUndo ? '' : executable ? '' : 'forbidden');
  return { id: entry.id, at: entry.at || 0, type: entry.type, label: entry.label || '', actor: entry.actor || '', undone: !!entry.undone, undoneAt: entry.undoneAt || 0, canUndo, unavailableReason: reason };
}
function undoUnavailableStatus(reason) {
  if (reason === 'already-purged' || reason === 'already-restored' || reason === 'share-gone') return 410;
  if (reason === 'restore-conflict' || reason === 'state-changed') return 409;
  if (reason === 'undo-unsupported' || reason === 'legacy-unsafe' || reason === 'undo-too-large') return 422;
  return 409;
}
// Reverse a recorded action. The `undone` flag is flipped before the durable write
// so it commits atomically with the reversal, and rolled back on any failure.
function performUndo(entry, req) {
  if (!entry) return { ok: false, error: 'not-found', status: 404 };
  const availability = undoAvailability(entry);
  if (!availability.canUndo) return { ok: false, error: availability.reason || 'unavailable', status: undoUnavailableStatus(availability.reason) };
  const u = entry.undo || {};
  entry.undone = true; entry.undoneAt = Date.now();
  const fail = (error, status) => { entry.undone = false; entry.undoneAt = 0; return { ok: false, error, status }; };
  try {
    if (u.kind === 'settings') {
      if (!u.before || typeof u.before !== 'object') return fail('undo-corrupt', 422);
      const keys = Object.keys(u.before);
      const historyBefore = Array.isArray(state.history) ? state.history.slice() : [];
      const saved = setSettingsDurable(cloneUndoDescriptor(u.before), {
        beforePersist: () => {
          if (keys.includes('historyRetentionDays')) pruneHistory();
        },
      });
      if (!saved) {
        state.history = historyBefore;
        return fail('write-error', 503);
      }
      if (keys.includes('anonymizeIps') || keys.includes('keepIpNames')) bumpHistoryViewRevision();
    } else if (u.kind === 'ip-names') {
      const before = state.ipNames || {};
      state.ipNames = (u.before && typeof u.before === 'object') ? cloneUndoDescriptor(u.before) : {};
      if (!persistNow()) { state.ipNames = before; return fail('write-error', 503); }
      bumpHistoryViewRevision();
    } else if (u.kind === 'share-assign') {
      const live = getById(u.shareId);
      if (!live) return fail('share-gone', 410);
      const rollback = JSON.parse(JSON.stringify(live));
      if (u.set && typeof u.set === 'object') for (const k of Object.keys(u.set)) live[k] = cloneUndoDescriptor(u.set[k]);
      if (Array.isArray(u.unset)) for (const k of u.unset) delete live[k];
      if (!persistNow()) { restorePlainObject(live, rollback); reindex(); return fail('write-error', 503); }
      reindex();
    } else if (u.kind === 'restore-trash') {
      const list = trashItems();
      const i = list.findIndex((r) => r && r.id === u.trashId);
      if (i < 0) return fail(u.shareId && getById(u.shareId) ? 'already-restored' : 'already-purged', 410);
      const original = JSON.parse(JSON.stringify(list[i]));
      const rec = list.splice(i, 1)[0];
      const sh = restoreTrashRecord(rec);
      if (!sh) { list.splice(Math.min(i, list.length), 0, original); return fail('undo-corrupt', 422); }
      recordShareChange(sh, req, 'restored', [], null);
      if (!persistNow()) { detachActiveShare(sh); list.splice(Math.min(i, list.length), 0, original); reindex(); shareLogicalBytesCache.clear(); return fail('write-error', 503); }
      try { scheduleSearchReindex(); } catch (_) {}
      emitLiveActivity('trash', { shareId:sh.id, name:sh.name, status:'restored', detail:'undo' });
    } else {
      return fail('undo-unsupported', 422);
    }
  } catch (e) {
    console.error('[undo] failed:', e && e.message);
    return fail('undo-failed', 500);
  }
  return { ok: true };
}

// 1.51.0 — a one-time/legacy revoked link can be reactivated only while its
// backing data is still present. Reactivation deliberately does NOT reset expiry,
// quotas, counters, passwords or pause state; those are independent lifecycle
// controls and keeping them avoids silently weakening the link configuration.
async function shareReactivationAvailability(sh) {
  if (!sh) return { available:false, reason:'not-found' };
  try {
    if (sh.encrypted && sh.encPath) {
      const managed = await statManagedPath(ENC_DIR, sh.encPath);
      const available = !!(managed && managed.stat && managed.stat.isFile());
      return { available, reason:available ? null : 'data-missing' };
    }
    if (sh.webStorage) { const meta=webStorageShareMeta(sh), st=await webStorageStat(sh,'',{fresh:true}); const available=!!meta&&!!st&&!!st.isDir===!!meta.isDir; return { available, reason:available?null:'data-missing' }; }
    if (sh.type === 'photo') {
      let abs = firstExistingPhotoFile(photoOriginalPaths(sh));
      if (!abs && sh.hostPath) {
        const candidate = hostToContainer(sh.hostPath);
        await assertRealWithin(HOST_ROOT, candidate);
        const st = await fs.promises.stat(candidate);
        if (st.isFile()) abs = candidate;
      }
      return { available:!!abs, reason:abs ? null : 'data-missing' };
    }
    if (sh.type === 'file' || sh.type === 'folder') {
      const items = sh.type === 'folder'
        ? [{ hostPath:sh.hostPath, type:'folder' }]
        : (shareItems(sh) || []);
      if (!items.length) return { available:false, reason:'data-missing' };
      for (const item of items) {
        if (!item || !item.hostPath) return { available:false, reason:'data-missing' };
        const abs = hostToContainer(item.hostPath);
        await assertRealWithin(HOST_ROOT, abs);
        const st = await fs.promises.stat(abs);
        if ((item.type === 'folder' && !st.isDirectory()) || (item.type !== 'folder' && !st.isFile())) return { available:false, reason:'data-missing' };
      }
      return { available:true, reason:null };
    }
    if (sh.type === 'inbox' || sh.type === 'collab') {
      if (!sh.relDir) return { available:false, reason:'data-missing' };
      const root = resolveWithin(INBOX_DIR, sh.relDir);
      await assertRealWithin(INBOX_DIR, root);
      const st = await fs.promises.stat(root);
      return { available:st.isDirectory(), reason:st.isDirectory() ? null : 'data-missing' };
    }
    if (sh.type === 'album') {
      const members = Array.isArray(sh.members) ? sh.members : [];
      for (const token of members) {
        const photo = getByToken(token);
        if (!photo || photo.type !== 'photo') continue;
        const availability = await shareReactivationAvailability(photo);
        if (availability.available) return { available:true, reason:null };
      }
      return { available:false, reason:'data-missing' };
    }
    // Secret notes and metadata-only link types keep their payload in the store.
    return { available:true, reason:null };
  } catch (_) {
    return { available:false, reason:'data-missing' };
  }
}
async function reactivateRevokedShare(sh, req) {
  if (!sh) return { ok:false, status:404, error:'not-found' };
  if (!sh.revoked) return { ok:false, status:409, error:'not-revoked' };
  const availability = await shareReactivationAvailability(sh);
  if (!availability.available) return { ok:false, status:409, error:availability.reason || 'data-missing' };
  const beforeFull = JSON.parse(JSON.stringify(sh));
  const before = shareChangeSnapshot(sh);
  sh.revoked = false;
  delete sh.burnedAt; delete sh.burnedReason;
  recordShareChange(sh, req, 'reactivated', ['revoked'], before);
  if (!persistNow()) { restorePlainObject(sh, beforeFull); return { ok:false, status:503, error:'write-error' }; }
  scheduleSearchReindex();
  return { ok:true, share:sh };
}
function ensureRestoreTokensFree(sh){
  if(!sh)return;
  if(!sh.token||byToken.has(sh.token))sh.token=newToken();
  const reserved=new Set([sh.token]);
  if(Array.isArray(sh.recipients))for(const r of sh.recipients){
    if(!r)continue;
    if(!r.token||byToken.has(r.token)||reserved.has(r.token))r.token=newToken(reserved);
    reserved.add(r.token);
  }
}
function restoreTrashRecord(rec){ if(!rec||!rec.share)return null; const sh=rec.share; if(!sh.id||byId.has(sh.id))sh.id=newShareId(); ensureRestoreTokensFree(sh); state.shares.push(sh); byId.set(sh.id,sh);byToken.set(sh.token,sh);indexRecipients(sh);invalidateShareLogicalBytes(sh.id);return sh; }
function managedInboxDirStillReferenced(sh) {
  if (!sh || !sh.relDir || !['inbox','collab'].includes(sh.type)) return false;
  const rel = String(sh.relDir);
  const same = (other) => !!(other && other !== sh && ['inbox','collab'].includes(other.type) && String(other.relDir || '') === rel);
  if ((state.shares || []).some(same)) return true;
  return trashItems().some((rec) => rec && same(rec.share));
}
async function unlinkManagedPathsStrict(paths) {
  for (const candidate of uniquePhotoPaths(paths || [])) {
    try { await fs.promises.unlink(candidate); }
    catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  }
}
function cleanupDestroyedShareReferences(sh) {
  if (!sh) return;
  if (state.meta && Array.isArray(state.meta.pending)) {
    state.meta.pending = state.meta.pending.filter((row) => !(row && row.shareId === sh.id));
  }
  try { pruneCustomNotificationRuleStateForShareId(sh.id); } catch (_) {}
  if (sh.type === 'photo' && sh.token) {
    const albums = (state.shares || []).concat(trashItems().map((rec) => rec && rec.share).filter(Boolean));
    for (const album of albums) {
      if (!album || album === sh || album.type !== 'album' || !Array.isArray(album.members)) continue;
      const before = album.members.length;
      album.members = album.members.filter((token) => String(token) !== String(sh.token));
      if (album.members.length !== before) album.updatedAt = Date.now();
    }
  }
}

async function destroyShareManagedData(sh, options = {}){
  if(!sh)return;
  const logicalCleanup = options.logicalCleanup !== false;
  const epoch = runtimeEpoch;
  activeDestructiveOperations += 1;
  const assertCurrent = () => {
    if (epoch !== runtimeEpoch) { const e = new Error('share-runtime-replaced'); e.code = 'SHARE_RUNTIME_REPLACED'; throw e; }
  };
  try {
    // Delete physical data FIRST. Unexpected filesystem failures must propagate so a
    // trash/lifecycle caller can keep the record and retry instead of orphaning bytes.
    assertCurrent();
    if (state.meta && Array.isArray(state.meta.pending)) {
      const owned = state.meta.pending.filter((row) => row && row.shareId === sh.id);
      for (const row of owned) {
        assertCurrent();
        let candidate; try { candidate = resolveWithin(PENDING_DIR, String(row.id || '')); }
        catch (_) { continue; }
        const managedPending = await statManagedPath(PENDING_DIR, candidate);
        if (!managedPending) continue;
        try { await fs.promises.unlink(managedPending.abs); }
        catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      }
      assertCurrent();
      if (logicalCleanup && owned.length) state.meta.pending = state.meta.pending.filter((row) => !(row && row.shareId === sh.id));
    }
    if(sh.encPath){
      assertCurrent();
      const managedEnc=await statManagedPath(ENC_DIR,sh.encPath);
      if(managedEnc){try{await fs.promises.unlink(managedEnc.abs);}catch(e){if(!e||e.code!=='ENOENT')throw e;}}
    }
    if(sh.type==='photo'){
      assertCurrent(); await unlinkManagedPathsStrict(photoVariantPaths(sh.token,'thumb'));
      assertCurrent(); await unlinkManagedPathsStrict(photoVariantPaths(sh.token,'micro'));
      assertCurrent(); await unlinkManagedPathsStrict(photoOriginalPaths(sh));
      assertCurrent(); await unlinkManagedPathsStrict([photoAdaptivePath(sh.token,'webp'),photoAdaptivePath(sh.token,'avif')]);
      assertCurrent(); const d=photoVersionDir(sh.token);if(d)await fs.promises.rm(d,{recursive:true,force:true});
    }
    // Reception links created with the same display name can legitimately share a
    // relDir (legacy behaviour). Purging one record must never destroy bytes still
    // referenced by another active/trash link.
    assertCurrent();
    if((sh.type==='inbox'||sh.type==='collab')&&sh.relDir&&!managedInboxDirStillReferenced(sh)){
      const root=resolveWithin(INBOX_DIR,sh.relDir);
      const managedInbox=await statManagedPath(INBOX_DIR,root);
      if(managedInbox) await fs.promises.rm(managedInbox.abs,{recursive:true,force:true});
    }

    // Only after physical destruction succeeds do we erase logical references.
    assertCurrent();
    if (logicalCleanup) cleanupDestroyedShareReferences(sh);
  } finally {
    activeDestructiveOperations = Math.max(0, activeDestructiveOperations - 1);
  }
}
async function purgeTrashRecordById(id,req){
  const list=trashItems();const i=list.findIndex((r)=>r&&r.id===id);if(i<0)return null;
  const rec=list[i];if(req&&!trashRecordVisible(req,rec))return null;
  const previousMarker = rec.purgePendingAt;
  rec.purgePendingAt = Number(rec.purgePendingAt) || Date.now();
  // Two-phase destructive transaction: persist an idempotent purge intent before
  // deleting bytes. If the final store commit fails, keep that intent in memory
  // and on disk so any later persistence/restart retries rather than resurrecting
  // metadata for already-deleted data.
  if (!persistNow()) {
    if (previousMarker === undefined) delete rec.purgePendingAt; else rec.purgePendingAt = previousMarker;
    const error = new Error('write-error'); error.code = 'write-error'; throw error;
  }
  await destroyShareManagedData(rec.share, { logicalCleanup:false });

  const pendingBefore = state.meta && Array.isArray(state.meta.pending) ? JSON.parse(JSON.stringify(state.meta.pending)) : null;
  const albumBefore = [];
  if (rec.share && rec.share.type === 'photo' && rec.share.token) {
    for (const album of (state.shares || []).concat(list.map((row)=>row&&row.share).filter(Boolean))) {
      if (!album || album === rec.share || album.type !== 'album' || !Array.isArray(album.members)) continue;
      if (!album.members.some((token)=>String(token)===String(rec.share.token))) continue;
      albumBefore.push({ album, members:album.members.slice(), updatedAt:album.updatedAt });
    }
  }
  cleanupDestroyedShareReferences(rec.share);
  const liveIndex=list.findIndex((r)=>r&&r.id===id);if(liveIndex>=0)list.splice(liveIndex,1);
  if (!persistNow()) {
    if (pendingBefore && state.meta) state.meta.pending = pendingBefore;
    for (const snap of albumBefore) {
      snap.album.members = snap.members;
      if (snap.updatedAt === undefined) delete snap.album.updatedAt; else snap.album.updatedAt = snap.updatedAt;
    }
    const insertAt = Math.min(Math.max(0, i), list.length);
    if (!list.some((row)=>row&&row.id===id)) list.splice(insertAt,0,rec);
    const error = new Error('write-error'); error.code = 'write-error'; throw error;
  }
  emitLiveActivity('trash',{shareId:rec.share&&rec.share.id,name:rec.share&&rec.share.name,status:'purged'});return rec;
}


// Destructive direct-delete helper removed in 1.45.2. All share removals must
// flow through recoverable trash or destroyShareManagedData(), which waits for
// filesystem deletion before erasing the logical record.


function incrementDownloads(id) {
  const s = getById(id);
  if (!s) return;
  const before = Math.max(0, Number(s.downloads) || 0);
  s.downloads = before + 1;
  const maxDownloads = Math.max(0, Number(s.maxDownloads) || 0);
  if (maxDownloads > 0 && before < maxDownloads && s.downloads >= maxDownloads) s.downloadLimitReachedAt = Date.now();
  if (before === 0 && s.type === 'inbox') {
    s.centerFirstDepositAt = Date.now();
    addShareCenterNotification(s, 'inbox-first-deposit', { count:1, dedupeKey:`inbox-first-deposit:${s.id}` });
  } else if (before === 0 && s.type !== 'collab' && s.type !== 'photo' && s.type !== 'album' && s.type !== 'secret') {
    addShareCenterNotification(s, 'share-first-download', { count:1, dedupeKey:`share-first-download:${s.id}` });
  }
  maybeNotifyDownloadThreshold(s); // download-goal alert (fires once at the goal)
  maybeCenterDownloadMilestone(s);
  maybeCenterReceptionQuota(s);
  evaluateCustomNotificationRulesForShare(s);
  if (s.type !== 'inbox' && s.type !== 'collab' && s.type !== 'photo' && Number(s.maxDownloads) > 0 && s.downloads >= Number(s.maxDownloads)) {
    addShareCenterNotification(s, 'download-limit-reached', { count:s.downloads, limit:Number(s.maxDownloads), dedupeKey:`download-limit:${s.id}:${s.maxDownloads}` });
    noteCenterAutoDisabled(s, 'download-limit');
  }
  scheduleFlush();
}

// Files backing a share. A file share may hold several files (a "collection");
// older single-file shares (no `items`) are normalized to a one-file list.
function shareItems(s) {
  if (!s) return null;
  if (Array.isArray(s.items) && s.items.length) {
    return s.items.map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type || 'file' }));
  }
  if (s.type === 'file') return [{ hostPath: s.hostPath, name: s.name, size: s.size, type: 'file' }];
  return null;
}
// Clamps a query index to a valid item position (defaults to 0).

let expiredLinkLifecyclePromise = null;
let lifecycleEpoch = 0;
async function runExpiredLinkLifecycle(now = Date.now()) {
  // A purge can recurse through large managed directories. The minute timer must
  // never start a second lifecycle pass while the previous one is still running.
  if (expiredLinkLifecyclePromise) return expiredLinkLifecyclePromise;
  const epoch = lifecycleEpoch;
  const job = (async () => {
  if (epoch !== lifecycleEpoch) return { archived:0, purged:0, aborted:true };
  const settings = getSettings();
  const archiveDays = Math.max(0, Math.floor(Number(settings.autoArchiveExpiredDays) || 0));
  const purgeDays = Math.max(0, Math.floor(Number(settings.expiredDataRetentionDays) || 0));
  let changed = false, archived = 0, purged = 0;
  const doomed = [];
  for (const sh of state.shares.slice()) {
    if (epoch !== lifecycleEpoch) return { archived, purged, aborted:true };
    if (!sh) continue;
    const deadline = shareEffectiveExpiry(sh);
    if (!deadline || now <= deadline) continue;
    const ageDays = (now - deadline) / 86400000;
    if (purgeDays > 0 && ageDays >= purgeDays) { doomed.push(sh); continue; }
    if (archiveDays > 0 && ageDays >= archiveDays && !sh.archived) {
      const before = { archived: false };
      sh.archived = true;
      sh.autoArchivedAt = now;
      recordShareChange(sh, null, 'auto-archived', ['archived'], before);
      archived += 1; changed = true;
      logAudit('share-auto-archived', { username: 'system', detail: (sh.type || 'share') + ' ' + (sh.name || '') });
    }
  }
  for (const sh of doomed) {
    if (epoch !== lifecycleEpoch) return { archived, purged, aborted:true };
    try { await destroyShareManagedData(sh); }
    catch (e) { console.error('[maintenance] expired-link data purge failed:', sh.id, e && e.message); continue; }
    if (epoch !== lifecycleEpoch) return { archived, purged, aborted:true };
    if (!detachActiveShare(sh)) continue;
    purged += 1; changed = true;
    emitLiveActivity('trash', { shareId: sh.id, name: sh.name, status: 'purged', detail: 'expired-retention' });
    logAudit('expired-share-purged', { username: 'system', detail: (sh.type || 'share') + ' ' + (sh.name || '') });
  }
  if (epoch !== lifecycleEpoch) return { archived, purged, aborted:true };
  if (changed) {
    const persisted = persistNow();
    if (persisted) {
      try { scheduleSearchReindex(); } catch (_) {}
      if (archived || purged) addAdminCenterNotification('cleanup-complete', { detail: `Liens expirés: ${archived} archivé(s), ${purged} supprimé(s)`, dedupeKey: `expired-lifecycle:${Math.floor(now/3600000)}`, dedupeWindowMs: 3600000 });
    } else console.error('[maintenance] expired-link lifecycle store write failed; retry scheduled');
  }
  return { archived, purged };
  })();
  expiredLinkLifecyclePromise = job;
  try { return await job; }
  finally { if (expiredLinkLifecyclePromise === job) expiredLinkLifecyclePromise = null; }
}

const VISITORS_MAX = 20000;
function parseMaxVisitors(v) {
  const n = Math.floor(Number(v) || 0);
  return Number.isFinite(n) && n > 0 ? Math.min(VISITORS_MAX, n) : 0;
}
// Returns false (and revokes the share) once a NEW visitor arrives beyond the
// limit; an IP already counted always passes, so a visitor keeps their access.
function recordAndCheckVisitor(s, req) {
  const cap = parseMaxVisitors(s.maxVisitors);
  if (s.maxVisitors && Number(s.maxVisitors) !== cap) { s.maxVisitors = cap; scheduleFlush(); }
  if (cap <= 0) return true; // unlimited
  const ip = maskIp(clientIp(req));
  if (!Array.isArray(s.visitors)) s.visitors = [];
  if (s.visitors.includes(ip)) return true; // already one of the counted visitors
  if (s.visitors.length >= cap) { // this new visitor would exceed the cap → revoke
    if (!s.revoked) {
      s.revoked = true;
      s.burnedAt = Date.now();
      logAudit('share-visitor-limit', { username: 'system', detail: (s.type || 'share') + ' ' + (s.name || '') + ` (${cap} visitors)` });
      noteCenterAutoDisabled(s, 'visitor-limit');
      persist();
    }
    return false;
  }
  s.visitors.push(ip);
  scheduleFlush();
  return true;
}

// Distinct-visitor set is bounded so a scraped/leaked link can't grow shares.json
// without limit; the unique-visitor count saturates at VISITORS_MAX.
function recordVisitorIp(s, ip) {
  if (!Array.isArray(s.visitors)) s.visitors = [];
  if (s.visitors.includes(ip)) return false;
  // The unique-visitor store intentionally saturates. Once full, the caller must
  // not treat an unrecorded address as a durable "new visitor" on every request.
  if (s.visitors.length >= VISITORS_MAX) return false;
  s.visitors.push(ip);
  return true;
}
// Per-IP download quota. Counts each download from one masked IP and
// refuses further downloads once the cap is reached; the link stays live for
// everyone else. The per-IP map is bounded like the visitor list so a scraped
// link can't grow shares.json without limit.
function ipDownloadQuotaBlocked(s, req) {
  const cap = Math.max(0, Math.floor(Number(s.maxDownloadsPerIp) || 0));
  if (cap <= 0) return false; // unlimited
  const resumeId = validDownloadResumeId(req.headers['x-direct-xfer-resume-id']);
  const resumeSession = resumeId && pruneDownloadResumeSessions()[resumeId];
  if (resumeSession && String(resumeSession.shareId) === String(s.id) && !resumeSession.finalized) return false;
  // HEAD probes never consume quota. Managed downloads defer the increment until
  // every byte has actually been delivered, so cancelling the first chunk does not
  // spend a download. A bare Range header is not trusted as proof of a continuation:
  // otherwise `Range: bytes=1-` bypasses the per-IP cap almost completely.
  if (req.method === 'HEAD') return false;
  const ip = maskIp(clientIp(req));
  if (!s.ipDownloads || typeof s.ipDownloads !== 'object') s.ipDownloads = {};
  const used = Math.max(0, Number(s.ipDownloads[ip]) || 0);
  if (used >= cap) return true; // this IP has spent its quota
  if (resumeId) return false; // completeManagedDownload commits it exactly once
  const isNewIp = s.ipDownloads[ip] === undefined;
  if (isNewIp && Object.keys(s.ipDownloads).length >= VISITORS_MAX) return false; // map full → fail open
  s.ipDownloads[ip] = used + 1;
  scheduleFlush();
  return false;
}
function commitManagedIpDownload(s, ip) {
  const cap = Math.max(0, Math.floor(Number(s && s.maxDownloadsPerIp) || 0));
  const key = String(ip || '');
  if (!s || cap <= 0 || !key) return;
  if (!s.ipDownloads || typeof s.ipDownloads !== 'object') s.ipDownloads = {};
  if (s.ipDownloads[key] === undefined && Object.keys(s.ipDownloads).length >= VISITORS_MAX) return;
  s.ipDownloads[key] = Math.max(0, Number(s.ipDownloads[key]) || 0) + 1;
}
// Running total of bytes served on a link, updated on each completed
// download.
function noteBytesServed(shareId, bytes) {
  const sh = getById(shareId); if (!sh) return;
  sh.bytesServed = Math.max(0, Number(sh.bytesServed) || 0) + Math.max(0, Number(bytes) || 0);
  evaluateCustomNotificationRulesForShare(sh);
  scheduleFlush();
  // Auto-revoke as soon as the cap is crossed, on ANY download path
  // (single file, folder ZIP, selection ZIP), even routes that don't pre-check it.
  bandwidthCapReached(sh);
}
// Total-bytes-served cap. Once the link has served its cap it
// auto-revokes (mirrors the unique-visitor cap); one download may cross the line.
function bandwidthCapReached(s) {
  const cap = Math.max(0, Number(s.maxBytesServed) || 0);
  if (cap <= 0 || (s.bytesServed || 0) < cap) return false;
  if (!s.revoked) {
    s.revoked = true; s.burnedAt = Date.now();
    logAudit('share-bandwidth-limit', { username: 'system', detail: (s.type || 'share') + ' ' + (s.name || '') });
    noteCenterAutoDisabled(s, 'bandwidth-limit');
    persist();
  }
  return true;
}
function centerPublicVisitIsOwner(s, req) {
  if (!s || !req) return false;
  const owner = shareOwnerAccount(s);
  if (!owner || !owner.id) return false;
  const session = getSession(req);
  if (session && session.accountId && String(session.accountId) === String(owner.id)) return true;
  const device = getPwaPublicDevice(req);
  if (!device) return false;
  const deviceOwner = pwaDeviceCreatorAccount(device) || pwaDeviceOwnerAccount(device.id);
  return !!(deviceOwner && deviceOwner.id && String(deviceOwner.id) === String(owner.id));
}
function centerPublicVisitorDeviceLabel(req) {
  const label = requestClientDeviceName(req, 'visitor');
  return cleanDeviceLabel(label);
}

// A "view" = one load of a link's public landing page (any link type). Bumps the
// total view count AND records the distinct (masked) visitor IP. Called only at
// the landing GET, so downloads / previews / range chunks don't inflate the count.
function bumpViews(s, req) {
  if (!s) return;
  s.views = Math.max(0, Number(s.views) || 0) + 1;
  s.lastViewAt = Date.now();
  s.lastUseAt = s.lastViewAt;
  if (s.inactiveExpirySeconds) delete s.inactiveExpiryWarnedDeadline;
  const rawIp = clientIp(req);
  const masked = maskIp(rawIp);
  const isNewVisitor = recordVisitorIp(s, masked);
  const geo = geoSync(rawIp) || {};
  const ownerVisit = centerPublicVisitIsOwner(s, req);
  if (isNewVisitor && centerShareEligibleForVisitorNotification(s) && !ownerVisit) {
    addShareCenterNotification(s, 'link-new-visitor', {
      ip:rawIp ? pubIp(String(rawIp).replace(/^::ffff:/i,'')) : null, country:geo.country || null, flag:geo.flag || flagFromCode(geo.countryCode) || '🌐',
      device:centerPublicVisitorDeviceLabel(req), dedupeKey:`visitor:${s.id}:${masked}`,
    });
  }
  if (!ownerVisit) noteCenterCountry(s, rawIp, geo);
  // A landing-page visit is often the only request a visitor makes. Do not rely
  // on a later download to warm the GeoIP cache; resolve the first uncached visit
  // asynchronously and create the country notification when it becomes known.
  if (!ownerVisit && rawIp && !geo.country && getSettings().geoLookup !== false) {
    const epoch = runtimeEpoch;
    geolocate(rawIp).then((resolved) => {
      if (!resolved || epoch !== runtimeEpoch || getById(s.id) !== s) return;
      noteCenterCountry(s, rawIp, resolved);
    }).catch(() => {});
  }
  maybeCenterViewThreshold(s);
  evaluateCustomNotificationRulesForShare(s);
  if (!ownerVisit) noteCenterVisitorDevice(s, req);
  noteCenterViral(s, 'view');
  noteCenterActivity(s, 'view', rawIp);
  scheduleFlush();
}

  function clearRuntimeState({ reindexState = true } = {}) {
    runtimeEpoch++;
    shareLogicalBytesCache.clear();
    shareLogicalBytesRefreshes.clear();
    shareLogicalBytesGeneration.clear();
    shareBackingHealthCache.clear();
    shareBackingHealthRefreshes.clear();
    shareBackingHealthGeneration.clear();
    lifecycleEpoch++;
    // Identity-guarded finalizers let a restored state start a fresh lifecycle pass
    // immediately without an older job later clearing the new serialization slot.
    if (activeDestructiveOperations === 0) expiredLinkLifecyclePromise = null;
    if (reindexState) reindex();
  }

  return {
    // owned indexes
    byToken, byId, recipientByToken, reindex, indexRecipients,
    // recipients + identity
    recordRecipientView, listShares, getByToken, getById, newToken,
    addShare, addShareDurable, restorePlainObject, linkPrefix,
    // lifecycle / metrics / stats
    isActive, isScheduled, shareBackingHealthRelevant, shareBackingHealthSnapshot,
    refreshShareBackingHealth, queueShareBackingHealthRefresh, invalidateShareBackingHealth,
    shareLogicalBytes, shareLogicalFileCount, shareNeedsLogicalBytesScan,
    refreshShareLogicalBytes, queueShareLogicalBytesRefresh, invalidateShareLogicalBytes,
    shareActivityAt, normalizeShareColor, normalizeDescriptionMd, boundedSeconds,
    shareLastUseAt, shareFirstUseDeadline, shareInactiveDeadline,
    shareDownloadLimitDeadline, shareEffectiveExpiry, migrateLegacyFirstUseExpiryState,
    shareStatsBaseline, displayStatsForShare, shareChangeSnapshot,
    safeShareChangeValue, recordShareChange,
    // trash / undo / restore
    trashItems, detachActiveShare, attachActiveShareExact, softDeleteShare,
    trashRecordVisible, trashManagedPurgeMetrics, trashPurgeImpact, trashPublicRecord,
    trashRestoreAlternatives, trashRestoreAssessment, applyTrashRestoreAlternative,
    sanitizeUndoLog, undoLogItems, undoRequestAccount, undoActor, cloneUndoDescriptor,
    rollbackRecordedUndo, recordUndoable, undoRequestSession, undoEntryVisible,
    undoValuesMatch, undoAvailability, undoEntryExecutable, undoPublicEntry,
    undoUnavailableStatus, performUndo, shareReactivationAvailability,
    reactivateRevokedShare, ensureRestoreTokensFree, restoreTrashRecord,
    managedInboxDirStillReferenced, unlinkManagedPathsStrict, destroyShareManagedData,
    purgeTrashRecordById,
    // quotas / accounting
    incrementDownloads, shareItems, parseMaxVisitors, recordAndCheckVisitor,
    recordVisitorIp, ipDownloadQuotaBlocked, commitManagedIpDownload, noteBytesServed,
    bandwidthCapReached, centerPublicVisitIsOwner, centerPublicVisitorDeviceLabel,
    bumpViews, runExpiredLinkLifecycle, clearRuntimeState, isBusyForStateReplacement,
    // share input/lifetime normalization
    clampIndex, normalizePwHint, parseMaxDownloadsPerIp, normalizeShareEmoji,
    parseMaxBytesServed, parseLinkRateKBps, zipAllowed, parseExpiry, parseExpiryAt,
    resolveExpiry, resolveNewShareExpiry, parseNewShareExpiry, applyNewShareLifetimePolicy,
    parseStartsAt, parseMaxDownloads,
    // caches intentionally exposed to route composition for nonblocking snapshots
    shareLogicalBytesCache, shareLogicalBytesRefreshes, shareLogicalBytesGeneration,
    shareBackingHealthCache, shareBackingHealthRefreshes, shareBackingHealthGeneration,
    constants: {
      SHARE_CHANGE_HISTORY_MAX,
      SHARE_LOGICAL_BYTES_CACHE_MS,
      SHARE_BACKING_HEALTH_CACHE_MS,
      VISITORS_MAX,
    },
  };
}

module.exports = { createShareService };
