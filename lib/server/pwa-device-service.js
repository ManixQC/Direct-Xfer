'use strict';

/**
 * PWA device/capability domain: durable pairing ownership, bearer-cookie
 * validation, PWA request authorization, install discovery and device metadata.
 * Restored state is always resolved through getState() so backup restore cannot
 * leave the service attached to an obsolete root object.
 */
function createPwaDeviceService(deps = {}) {
  const {
    PUBLIC_URL, rootDir, crypto, path, getState, getAccountById, findAccountByName,
    scheduleFlush, persistNow, timingSafeEqualStr, parseCookies, secureCookie,
    getSession, adminGuard, externalProto, accountNeedsPwChange, auditReq, logAudit,
    clientIp, destroySession, addCenterNotification, pubIp,
    getInboxEventSubs = () => null,
  } = deps;
  if (typeof getState !== 'function') throw new TypeError('pwa-device-service requires getState');
  if (!crypto || typeof crypto.randomBytes !== 'function') throw new TypeError('pwa-device-service requires crypto');
  if (!path || !rootDir) throw new TypeError('pwa-device-service requires rootDir/path');
  const state = new Proxy(Object.create(null), {
    get(_target, key) { const root = getState(); return root ? root[key] : undefined; },
    set(_target, key, value) { const root = getState(); if (!root) throw new Error('pwa-state-unavailable'); root[key] = value; return true; },
  });
  const pwaPairTickets = new Map();
  const PWA_PUBLIC_DEVICE_COOKIE = 'dxpwaid';
  const PWA_INSTALL_HEARTBEAT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
  const PWA_AUTH_ERROR_PASSWORD_CHANGE_REQUIRED = 'password-change-required';
  const PWA_PUBLIC_ASSET_PATHS = new Set([
    '/app.css','/app.js','/dlp-local.js','/login.css','/login.js','/login-vault.js','/theme-init.js',
    '/admin-advanced.js','/admin-audit-connectors.js','/mobile-intelligence.js','/sw.js',
    '/manifest.webmanifest','/manifest-en.webmanifest','/manifest-es.webmanifest','/icon.svg','/icon-192.png','/icon-512.png',
    '/icon-maskable.svg','/icon-maskable-192.png','/icon-maskable-512.png','/apple-touch-icon.png',
    '/screenshot-mobile.png','/screenshot-wide.png','/launch','/launch.html',
  ]);
  // Compatibility adapter for the few device operations that must close live PWA
  // streams. The event service owns the Map; this service never owns HTTP responses.
  const inboxEventSubs = {
    get(key) { const map = getInboxEventSubs(); return map && typeof map.get === 'function' ? map.get(key) : undefined; },
    delete(key) { const map = getInboxEventSubs(); return !!(map && typeof map.delete === 'function' && map.delete(key)); },
  };
function pwaDeviceOwnerMap() {
  if (!state.meta || typeof state.meta !== 'object' || Array.isArray(state.meta)) state.meta = {};
  if (!state.meta.pwaDeviceOwners || typeof state.meta.pwaDeviceOwners !== 'object' || Array.isArray(state.meta.pwaDeviceOwners)) {
    state.meta.pwaDeviceOwners = {};
  }
  return state.meta.pwaDeviceOwners;
}

function rememberPwaDeviceOwner(device) {
  if (!device || !device.id) return false;
  // Once a durable account id exists, never fall back to a recycled username. A
  // deleted account named "alice" must not transfer an old bearer device to a new
  // account that later happens to reuse the same username.
  const creator = device.createdByAccountId ? getAccountById(device.createdByAccountId) : findAccountByName(device.createdBy || '');
  if (!creator) return false;
  const owners = pwaDeviceOwnerMap();
  const previous = owners[device.id];
  const next = { accountId: creator.id, username: creator.username || device.createdBy || null, updatedAt: Date.now() };
  if (previous && previous.accountId === next.accountId && previous.username === next.username) return false;
  owners[device.id] = next;
  return true;
}

function pwaDeviceOwnerAccount(deviceId) {
  deviceId = String(deviceId || '');
  if (!deviceId) return null;
  const current = Array.isArray(state.meta && state.meta.pwaDevices)
    ? state.meta.pwaDevices.find((device) => device && device.id === deviceId)
    : null;
  if (current) {
    const creator = current.createdByAccountId ? getAccountById(current.createdByAccountId) : findAccountByName(current.createdBy || '');
    if (creator) return creator;
    if (current.createdByAccountId) return null;
  }
  const remembered = pwaDeviceOwnerMap()[deviceId];
  return remembered && remembered.accountId ? getAccountById(remembered.accountId) : null;
}

function pwaDeviceResolvedAccount(device) {
  if (!device) return null;
  return pwaDeviceCreatorAccount(device) || pwaDeviceOwnerAccount(device.id);
}

function pwaSessionResolvedAccount(session) {
  if (!session) return null;
  return (session.accountId && getAccountById(session.accountId)) || findAccountByName(session.username || '');
}

function samePwaAccount(session, device) {
  const sa = pwaSessionResolvedAccount(session), da = pwaDeviceResolvedAccount(device);
  return !!(sa && da && String(sa.id) === String(da.id));
}

function cleanupPwaCapabilityScopes(deviceIds, accountId = null) {
  const ids = new Set((deviceIds || []).map((id) => String(id || '')).filter(Boolean));
  const accountKey = accountId ? 'acc:' + String(accountId) : null;
  const deviceKeys = new Set([...ids].map((id) => 'dev:' + id));
  let pushRemoved = 0;
  if (state.meta && Array.isArray(state.meta.pushSubs)) {
    state.meta.pushSubs = state.meta.pushSubs.map((sub) => {
      if (!sub) return null;
      const wasAccount = !!(accountId && String(sub.accountId || '') === String(accountId));
      const oldKeys = Array.isArray(sub.ownerKeys) ? sub.ownerKeys : [];
      const ownerKeys = oldKeys.filter((key) => key !== accountKey && !deviceKeys.has(String(key)));
      const removedKeys = oldKeys.length - ownerKeys.length;
      if (!wasAccount && !removedKeys) return sub;
      const next = { ...sub, ownerKeys };
      if (wasAccount) next.accountId = null;
      if (!next.accountId && !ownerKeys.length) { pushRemoved += 1; return null; }
      return next;
    }).filter(Boolean);
  }
  for (const key of [...deviceKeys, ...(accountKey ? [accountKey] : [])]) {
    // inboxEventSubs is initialized before any HTTP/account mutation can invoke this
    // helper; guard anyway for startup/test harnesses that only evaluate fragments.
    try {
      const streams = inboxEventSubs.get(key);
      if (streams) { for (const stream of streams) { try { stream.end(); } catch (_) {} } inboxEventSubs.delete(key); }
    } catch (_) {}
  }
  return pushRemoved;
}

function pwaDevices() {
  if (!state.meta || typeof state.meta !== 'object' || Array.isArray(state.meta)) state.meta = {};
  if (!Array.isArray(state.meta.pwaDevices)) state.meta.pwaDevices = [];
  const cutoff = Date.now() - 400 * 86400000;
  let changed = false;
  // Record the account behind every capability before old device records are pruned.
  // This durable index lets a replacement/reinstalled PWA recover links created by
  // the previous device credential instead of opening an apparently empty workspace.
  for (const d of state.meta.pwaDevices) {
    if (!d || !d.id) continue;
    if (!d.createdByAccountId && d.createdBy) {
      const creator = findAccountByName(d.createdBy);
      if (creator) { d.createdByAccountId = creator.id; changed = true; }
    }
    if (rememberPwaDeviceOwner(d)) changed = true;
  }
  const beforeDevices = state.meta.pwaDevices.slice();
  state.meta.pwaDevices = state.meta.pwaDevices.filter((d) => d && d.id && d.hash && (d.createdAt || 0) > cutoff && !!pwaDeviceResolvedAccount(d));
  const keptIds = new Set(state.meta.pwaDevices.map((d) => String(d.id)));
  const prunedIds = beforeDevices.filter((d) => d && d.id && !keptIds.has(String(d.id))).map((d) => String(d.id));
  if (prunedIds.length) { cleanupPwaCapabilityScopes(prunedIds); changed = true; }
  // Devices created before 1.23.1 did not have their own CSRF token. Upgrade
  // them lazily so existing pairings remain valid without weakening mutations.
  for (const d of state.meta.pwaDevices) {
    if (!d.csrf || !/^[A-Za-z0-9_-]{32,128}$/.test(String(d.csrf))) {
      d.csrf = crypto.randomBytes(32).toString('base64url');
      changed = true;
    }
  }
  const owners = pwaDeviceOwnerMap();
  const ownerIds = Object.keys(owners);
  if (ownerIds.length > 500) {
    ownerIds.sort((a, b) => Number(owners[b] && owners[b].updatedAt || 0) - Number(owners[a] && owners[a].updatedAt || 0));
    for (const id of ownerIds.slice(500)) { delete owners[id]; changed = true; }
  }
  if (changed) scheduleFlush();
  return state.meta.pwaDevices;
}

function cleanDeviceLabel(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || null;
}

function requestClientDeviceName(req, source) {
  if (req && req.pwaDevice && req.pwaDevice.name) return cleanDeviceLabel(req.pwaDevice.name);
  if (source === 'host') return 'Serveur · fichier hôte';
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  let browser = '';
  if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) || /CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';
  let platform = '';
  if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';
  const prefix = source === 'collaborator' ? 'Collaborateur' : 'Web';
  return cleanDeviceLabel([prefix, browser, platform].filter(Boolean).join(' · ')) || prefix;
}

function stampPhotoUploadDevice(share, req, source) {
  if (!share || share.type !== 'photo') return share;
  const label = requestClientDeviceName(req, source);
  if (label) share.uploadDeviceName = label;
  if (source) share.uploadSource = String(source).slice(0, 32);
  return share;
}

function shareCreatorDeviceName(share) {
  if (!share || !share.ownerDeviceId) return null;
  const device = pwaDevices().find((d) => d.id === share.ownerDeviceId);
  return (device && cleanDeviceLabel(device.name)) || null;
}

function photoUploadDeviceName(share) {
  if (!share || share.type !== 'photo') return null;
  const stored = cleanDeviceLabel(share.uploadDeviceName);
  if (stored) return stored;
  return shareCreatorDeviceName(share);
}

function pwaSecretHash(secret) { return crypto.createHash('sha256').update(String(secret)).digest('hex'); }

function validatePwaDeviceCredential(raw, touch = true, allowLocked = false) {
  raw = String(raw || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const id = raw.slice(0, dot), secret = raw.slice(dot + 1);
  if (!/^[a-f0-9]{24}$/i.test(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
  const device = pwaDevices().find((d) => d.id === id);
  if (!device || !timingSafeEqualStr(device.hash, pwaSecretHash(secret))) return null;
  // A device capability is delegated by an account, not a standalone immortal
  // bearer token. If that account was deleted, the credential is dead immediately.
  if (!pwaDeviceResolvedAccount(device)) return null;
  if (device.sessionLockedAt && !allowLocked) return null;
  if (touch && Date.now() - (device.lastUsedAt || 0) > 3600000) {
    device.lastUsedAt = Date.now();
    scheduleFlush();
  }
  return device;
}

function getPwaDevice(req, touch = true, allowLocked = false) {
  return validatePwaDeviceCredential(parseCookies(req).dxpwa || '', touch, allowLocked);
}

function appendSetCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  if (!current) return res.setHeader('Set-Cookie', value);
  if (Array.isArray(current)) return res.setHeader('Set-Cookie', current.concat(value));
  return res.setHeader('Set-Cookie', [current, value]);
}

function setPwaPublicDeviceMarker(req, res, id) {
  const maxAge = 365 * 86400;
  id = String(id || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return;
  // This cookie is identification-only: it contains the random device id, never the
  // PWA bearer secret or CSRF token. Path=/ lets public share/reception pages tell an
  // owner's own paired device from an external visitor without widening /app auth.
  appendSetCookie(res, `${PWA_PUBLIC_DEVICE_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie(req)}`);
}

function clearPwaPublicDeviceMarker(req, res) {
  appendSetCookie(res, `${PWA_PUBLIC_DEVICE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie(req)}`);
}

function getPwaPublicDevice(req) {
  const id = String(parseCookies(req)[PWA_PUBLIC_DEVICE_COOKIE] || '');
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  return pwaDevices().find((d) => d && d.id === id) || null;
}

function ensurePwaPublicDeviceMarker(req, res, device) {
  if (!device || !device.id) return;
  const current = String(parseCookies(req)[PWA_PUBLIC_DEVICE_COOKIE] || '');
  if (current !== String(device.id)) setPwaPublicDeviceMarker(req, res, device.id);
}

function setPwaDeviceCookie(req, res, id, secret) {
  const maxAge = 365 * 86400;
  // SameSite=Lax so the durable device capability survives a home-screen WebAPK
  // launch and a Web Share Target (both cross-site top-level navigations, where a
  // Strict cookie would be dropped and the device would appear unpaired / its
  // images and albums "reset"). Mutations under /app still require the per-device
  // X-CSRF-Token and an exact same-origin Origin header, so Lax is CSRF-safe here.
  appendSetCookie(res, `dxpwa=${id}.${secret}; HttpOnly; SameSite=Lax; Path=/app; Max-Age=${maxAge}${secureCookie(req)}`);
  setPwaPublicDeviceMarker(req, res, id);
}

function clearPwaDeviceCookie(req, res) {
  appendSetCookie(res, `dxpwa=; HttpOnly; SameSite=Lax; Path=/app; Max-Age=0${secureCookie(req)}`);
  clearPwaPublicDeviceMarker(req, res);
}

function createPwaDevice(name, createdBy) {
  const id = crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const creator = findAccountByName(createdBy);
  const device = {
    id,
    hash: pwaSecretHash(secret),
    csrf: crypto.randomBytes(32).toString('base64url'),
    name: String(name || 'Direct-Xfer PWA').replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Direct-Xfer PWA',
    createdAt: now,
    lastUsedAt: now,
    createdBy: createdBy || null,
    createdByAccountId: creator ? creator.id : null,
  };
  const list = pwaDevices();
  const before = list.slice();
  list.push(device);
  const removedIds = [];
  while (list.length > 30) { const old = list.shift(); if (old && old.id) removedIds.push(String(old.id)); }
  // A bearer credential must never be handed to the browser before the record
  // backing it is durable. Roll the list back on write failure; runtime scopes for
  // evicted devices are cleaned only AFTER the successful commit.
  if (!persistNow()) {
    state.meta.pwaDevices = before;
    return null;
  }
  if (removedIds.length) cleanupPwaCapabilityScopes(removedIds);
  return { device, secret };
}

function issuePwaDevice(req, res, name, createdBy) {
  const issued = createPwaDevice(name, createdBy);
  if (!issued) return null;
  setPwaDeviceCookie(req, res, issued.device.id, issued.secret);
  if (req) { issued.device.platform = detectClientPlatform(req.headers && req.headers['user-agent']); issued.device.userAgent = String(req.headers && req.headers['user-agent'] || '').slice(0, 500); scheduleFlush(); }
  const creator = pwaDeviceCreatorAccount(issued.device) || findAccountByName(createdBy || '');
  if (creator && creator.id) addCenterNotification(creator.id, 'pwa-device-paired', { device:issued.device.name, username:creator.username || createdBy || '', ip:req ? pubIp(clientIp(req)) : null, dedupeKey:`pwa-device-paired:${issued.device.id}` });
  return issued.device;
}

function prunePwaPairTickets() {
  const now = Date.now();
  for (const [ticket, meta] of pwaPairTickets) if (!meta || meta.expiresAt <= now) pwaPairTickets.delete(ticket);
}

function sendPwaInstallAsset(res, filename, contentType, serviceWorker) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (serviceWorker) res.setHeader('Service-Worker-Allowed', '/app/');
  return res.sendFile(path.join(rootDir, 'pwa', filename));
}

function isPublicPwaAssetRequest(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && PWA_PUBLIC_ASSET_PATHS.has(req.path);
}

function pwaNetworkGuard(req, res, next) {
  if (isPublicPwaAssetRequest(req)) return next();
  const session = getSession(req);
  const device = getPwaDevice(req, false);
  // A paired credential may bypass the admin IP allowlist only for the SAME account
  // as a coincident session. A stale account-B cookie next to account-A's session
  // must not accidentally grant account A remote PWA network access.
  if (device && (!session || samePwaAccount(session, device))) return next();
  return adminGuard(req, res, next);
}

function pwaHttpsInstallUrl() {
  const origin = normalizedOrigin(PUBLIC_URL);
  return origin.startsWith('https://') ? origin + '/app' : '';
}

function pwaDetectionOrigin(req) {
  const host = String((req && req.get && req.get('host')) || '').split(',')[0].trim();
  if (!host || /[\r\n]/.test(host)) return '';
  try { return new URL(`${externalProto(req)}://${host}`).origin; } catch (_) { return ''; }
}

function safePwaNext(raw) {
  const value = String(raw || '/app/');
  if (!/^\/app(?:\/|\?|$)/.test(value) || value.startsWith('//') || /[\r\n]/.test(value)) return '/app/';
  return value === '/app' ? '/app/' : value;
}

function normalizedOrigin(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return '';
    return u.origin;
  } catch (_) {
    return '';
  }
}

function validAppMutationOrigin(req) {
  const supplied = normalizedOrigin(req.headers.origin);
  if (!supplied || supplied === 'null') return false;
  const allowed = new Set();
  const host = String(req.get('host') || '').trim();
  if (/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    const requestOrigin = normalizedOrigin(`${externalProto(req)}://${host}`);
    if (requestOrigin) allowed.add(requestOrigin);
  }
  const publicOrigin = normalizedOrigin(PUBLIC_URL);
  if (publicOrigin) allowed.add(publicOrigin);
  return allowed.has(supplied);
}

function requireAppAuth(req, res, next) {
  if (isPublicPwaAssetRequest(req)) return next();
  const session = getSession(req);
  let device = getPwaDevice(req, false);
  // Never mix two principals from the same browser. A stale dxpwa cookie belonging
  // to account B is ignored while account A's admin session is active; otherwise a
  // request could authorize with A but stamp/manage records as device B.
  if (device && session && !samePwaAccount(session, device)) device = null;
  if (!device && session) {
    const lockedDevice = getPwaDevice(req, false, true);
    if (lockedDevice && lockedDevice.sessionLockedAt && samePwaAccount(session, lockedDevice)) {
      delete lockedDevice.sessionLockedAt;
      lockedDevice.lastUsedAt = Date.now();
      scheduleFlush();
      device = lockedDevice;
    }
  }
  if (device && Date.now() - (device.lastUsedAt || 0) > 3600000) { device.lastUsedAt = Date.now(); scheduleFlush(); }
  if (session || device) {
    req.pwaSession = session;
    req.pwaDevice = device;
    req.pwaAuthMode = device ? 'cookie' : 'session';
    if (device) ensurePwaPublicDeviceMarker(req, res, device);
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating) {
      // Browser cookie/session requests must be exact same-origin.
      if (!validAppMutationOrigin(req)) return res.status(403).json({ error: 'invalid-origin' });
      const csrf = String(req.headers['x-csrf-token'] || '');
      const deviceCsrfOk = !!(device && csrf && timingSafeEqualStr(csrf, device.csrf));
      const sessionCsrfOk = !!(session && csrf && timingSafeEqualStr(csrf, session.csrf));
      if (!deviceCsrfOk && !sessionCsrfOk) return res.status(403).json({ error: 'invalid-csrf' });

      // A paired device keeps its deliberately narrow PWA capability. Requests
      // authenticated through the admin session retain the normal role and
      // forced-password-change invariants.
      if (!deviceCsrfOk) {
        const acc = session && session.accountId ? getAccountById(session.accountId) : null;
        if (!session || !['owner', 'admin', 'operator'].includes(session.role)) {
          return res.status(403).type('text').send('Forbidden');
        }
        if (accountNeedsPwChange(acc)) return res.status(403).json({ error: PWA_AUTH_ERROR_PASSWORD_CHANGE_REQUIRED });
      }
    }
    return next();
  }
  const accept = req.headers.accept || '';
  if (req.method === 'GET' && accept.includes('text/html')) {
    // Preserve the complete query string: Web Share Target batches use ?shared=<id>
    // and remain recoverable after the administrator signs in on mobile.
    return res.redirect(302, '/app/login?next=' + encodeURIComponent(safePwaNext(req.originalUrl)));
  }
  return res.status(401).type('text').send('Authentication required');
}

function pwaCurrentAccount(req) {
  if (req.pwaSession && req.pwaSession.accountId) return getAccountById(req.pwaSession.accountId);
  const creator = req.pwaDevice ? pwaDeviceCreatorAccount(req.pwaDevice) : null;
  return creator || null;
}

function bindPwaDeviceForLogin(req, res, acc, deviceName) {
  let device = getPwaDevice(req, false, true);
  const existingOwner = device ? (pwaDeviceCreatorAccount(device) || pwaDeviceOwnerAccount(device.id)) : null;
  if (device && existingOwner && existingOwner.id !== acc.id) device = null;
  if (device) {
    delete device.sessionLockedAt;
    device.lastUsedAt = Date.now();
    device.createdBy = acc.username || device.createdBy || null;
    device.createdByAccountId = acc.id;
    rememberPwaDeviceOwner(device);
    scheduleFlush();
  } else {
    const label = String(deviceName || requestClientDeviceName(req, 'pwa') || 'Direct-Xfer PWA')
      .replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Direct-Xfer PWA';
    device = issuePwaDevice(req, res, label, acc.username || null);
  }
  return device;
}

function lockPwaSessionHandler(req, res) {
  const automatic = /\/app\/session\/lock(?:\?|$)/.test(String(req.originalUrl || ''));
  const session = req.pwaSession || getSession(req);
  const device = req.pwaDevice || null;
  const keys = [];
  if (device) {
    device.sessionLockedAt = Date.now();
    keys.push('dev:' + device.id);
  }
  if (session && session.accountId) keys.push('acc:' + session.accountId);
  for (const key of keys) {
    const streams = inboxEventSubs.get(key);
    if (streams) {
      for (const stream of streams) { try { stream.end(); } catch (_) {} }
      inboxEventSubs.delete(key);
    }
  }
  if (session) {
    req.session = session;
    auditReq(req, automatic ? 'pwa-auto-lock' : 'logout', device ? 'PWA session locked: ' + device.name : 'PWA session');
  } else if (device) {
    logAudit(automatic ? 'pwa-auto-lock' : 'logout', { username: 'PWA: ' + device.name, ip: clientIp(req), detail: 'PWA session locked' });
  }
  destroySession(req, res);
  persistNow();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, paired: !!device });
}

function pwaDeviceCreatorAccount(device) {
  if (!device) return null;
  return device.createdByAccountId ? getAccountById(device.createdByAccountId) : findAccountByName(device.createdBy || '');
}

function stampPwaRecordOwner(req, share) {
  if (!share) return share;
  if (req.pwaSession) {
    share.ownerId = req.pwaSession.accountId || null;
    share.ownerName = req.pwaSession.username || null;
  }
  if (req.pwaDevice) {
    share.ownerDeviceId = req.pwaDevice.id;
    const creator = pwaDeviceCreatorAccount(req.pwaDevice);
    // A device capability is delegated by an account. Persist both identities so
    // losing/replacing the HttpOnly device cookie never makes its records disappear.
    if (!share.ownerId && creator) share.ownerId = creator.id;
    if (!share.ownerName) share.ownerName = (creator && creator.username) || req.pwaDevice.name || 'PWA';
    rememberPwaDeviceOwner(req.pwaDevice);
  }
  return share;
}

function migratePwaRecordsForAccount(account) {
  if (!account || !account.id) return 0;
  let changed = 0;
  for (const share of state.shares || []) {
    if (!share || !share.ownerDeviceId || share.ownerId) continue;
    const owner = pwaDeviceOwnerAccount(share.ownerDeviceId);
    if (!owner || owner.id !== account.id) continue;
    share.ownerId = account.id;
    if (!share.ownerName || share.ownerName === 'PWA') share.ownerName = account.username || share.ownerName;
    changed += 1;
  }
  if (changed) scheduleFlush();
  return changed;
}

function pwaHostAdminSession(req, res) {
  const session = req.pwaSession || getSession(req);
  const role = session && session.role;
  if (!session || !['owner', 'admin', 'operator'].includes(role)) {
    res.status(403).json({ error: 'admin-required' });
    return null;
  }
  return session;
}

function detectClientPlatform(ua) {
  ua = String(ua || '').toLowerCase();
  if (/android/.test(ua)) return 'android';
  if (/iphone|ipad|ipod|macintosh.*mobile/.test(ua)) return 'ios';
  if (/windows/.test(ua)) return 'windows';
  if (/macintosh|mac os x/.test(ua)) return 'macos';
  if (/linux|x11/.test(ua)) return 'linux';
  return 'other';
}

function updatePwaDeviceClientInfo(device, req) {
  if (!device || !req) return false;
  const ua = String(req.headers && req.headers['user-agent'] || '').slice(0, 500);
  const version = String(req.query && req.query.version || '').replace(/[^0-9A-Za-z._+-]/g, '').slice(0, 40);
  const build = String(req.query && req.query.build || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  const platform = detectClientPlatform(ua);
  const standalone = String(req.query && req.query.standalone || '') === '1';
  let changed = false;
  for (const [key, value] of [['platform',platform],['userAgent',ua],['appVersion',version],['appBuild',build]]) {
    if (value && device[key] !== value) { device[key] = value; changed = true; }
  }
  if (standalone) {
    const now = Date.now();
    if (!device.installedStandaloneSeenAt || now - Number(device.installedStandaloneSeenAt || 0) > 3600000) {
      device.installedStandaloneSeenAt = now;
      changed = true;
    }
  }
  if (changed) scheduleFlush();
  return changed;
}

function publicPwaDevice(d, currentId) {
  return {
    id: d.id,
    name: d.name || 'Direct-Xfer PWA',
    createdAt: d.createdAt || null,
    lastUsedAt: d.lastUsedAt || d.createdAt || null,
    platform: d.platform || detectClientPlatform(d.userAgent || ''),
    appVersion: d.appVersion || null,
    appBuild: d.appBuild || null,
    current: d.id === currentId,
  };
}

  return {
    PWA_INSTALL_HEARTBEAT_MAX_AGE_MS, PWA_AUTH_ERROR_PASSWORD_CHANGE_REQUIRED, PWA_PUBLIC_ASSET_PATHS, pwaPairTickets,
    pwaDeviceOwnerMap, rememberPwaDeviceOwner, pwaDeviceOwnerAccount, pwaDeviceResolvedAccount,
    pwaSessionResolvedAccount, samePwaAccount, cleanupPwaCapabilityScopes, pwaDevices,
    cleanDeviceLabel, requestClientDeviceName, stampPhotoUploadDevice, shareCreatorDeviceName, photoUploadDeviceName,
    pwaSecretHash, validatePwaDeviceCredential, getPwaDevice, appendSetCookie,
    setPwaPublicDeviceMarker, clearPwaPublicDeviceMarker, getPwaPublicDevice, ensurePwaPublicDeviceMarker,
    setPwaDeviceCookie, clearPwaDeviceCookie, createPwaDevice, issuePwaDevice, prunePwaPairTickets,
    sendPwaInstallAsset, isPublicPwaAssetRequest, pwaNetworkGuard, pwaHttpsInstallUrl, pwaDetectionOrigin,
    safePwaNext, normalizedOrigin, validAppMutationOrigin, requireAppAuth, pwaCurrentAccount,
    bindPwaDeviceForLogin, lockPwaSessionHandler,
    pwaDeviceCreatorAccount, stampPwaRecordOwner, migratePwaRecordsForAccount, pwaHostAdminSession,
    detectClientPlatform, updatePwaDeviceClientInfo, publicPwaDevice,
  };
}

module.exports = { createPwaDeviceService };
