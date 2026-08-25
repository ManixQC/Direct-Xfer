'use strict';

const crypto = require('crypto');

const VALID_SESSION_ROLES = new Set(['owner', 'admin', 'operator', 'auditor']);
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 10;
const SESSION_COOKIE = 'sid';
const SECURE_SESSION_COOKIE = '__Host-sid';

/**
 * Owns Direct-Xfer administrator sessions and CSRF validation.
 *
 * This module deliberately owns the session Map so route code cannot mutate it
 * directly. Account persistence remains outside this service; deleted-account
 * checks are delegated through getAccountById().
 */
function createSessionService(options = {}) {
  const {
    getSettings,
    defaultTtlMs,
    defaultIdleMs = DEFAULT_SESSION_IDLE_MS,
    defaultMaxConcurrentSessions = DEFAULT_MAX_CONCURRENT_SESSIONS,
    getAccountById,
    clientIp,
    parseCookies,
    secureCookie,
    timingSafeEqualStr,
    closeStreamsForSession = () => {},
    asvsL3Mode = false,
    strongAuthFreshMs = 5 * 60 * 1000,
  } = options;

  for (const [name, value] of Object.entries({
    getSettings,
    getAccountById,
    clientIp,
    parseCookies,
    secureCookie,
    timingSafeEqualStr,
  })) {
    if (typeof value !== 'function') throw new TypeError(`session-service requires ${name}()`);
  }

  const fallbackTtlMs = Number.isFinite(Number(defaultTtlMs)) && Number(defaultTtlMs) > 0
    ? Number(defaultTtlMs)
    : 8 * 60 * 60 * 1000;
  const fallbackIdleMs = Number.isFinite(Number(defaultIdleMs)) && Number(defaultIdleMs) > 0
    ? Math.min(fallbackTtlMs, Number(defaultIdleMs))
    : Math.min(fallbackTtlMs, DEFAULT_SESSION_IDLE_MS);
  const fallbackMaxConcurrentSessions = Number.isSafeInteger(Number(defaultMaxConcurrentSessions))
      && Number(defaultMaxConcurrentSessions) >= 1
    ? Math.min(100, Number(defaultMaxConcurrentSessions))
    : DEFAULT_MAX_CONCURRENT_SESSIONS;
  const sessions = new Map();

  function sessionTtlMs() {
    const hours = Math.floor(Number(getSettings().sessionHours));
    return Number.isFinite(hours) && hours > 0
      ? Math.min(720, hours) * 60 * 60 * 1000
      : fallbackTtlMs;
  }

  function sessionIdleMs() {
    const minutes = Math.floor(Number(getSettings().sessionIdleMinutes));
    const configured = Number.isFinite(minutes) && minutes > 0
      ? Math.min(1440, minutes) * 60 * 1000
      : fallbackIdleMs;
    return Math.min(sessionTtlMs(), configured);
  }

  function sessionMaxConcurrent() {
    const configured = Math.floor(Number(getSettings().maxConcurrentSessions));
    return Number.isFinite(configured) && configured >= 1
      ? Math.min(100, configured)
      : fallbackMaxConcurrentSessions;
  }

  function secureCookieSuffix(req) {
    const suffix = String(secureCookie(req) || '');
    return /(?:^|;)\s*Secure(?:;|$)/i.test(suffix) ? (suffix || '; Secure') : suffix;
  }

  function sessionCookieName(req) {
    return /(?:^|;)\s*Secure(?:;|$)/i.test(secureCookieSuffix(req))
      ? SECURE_SESSION_COOKIE
      : SESSION_COOKIE;
  }

  function sessionSidFromRequest(req) {
    const cookies = parseCookies(req) || {};
    // During migration, accept the old unprefixed cookie over HTTPS only when a
    // __Host cookie is not yet present. New responses immediately rotate it.
    return cookies[SECURE_SESSION_COOKIE] || cookies[SESSION_COOKIE] || null;
  }

  function invalidateSessionSid(sid) {
    if (!sid) return false;
    const existed = sessions.delete(sid);
    // Session-only PWA SSE streams must lose access with the underlying browser
    // session. Paired PWA devices are separate durable principals and therefore
    // are not represented by this Map. Do not re-close streams for an already
    // absent sid (for example after prune + login rotation).
    if (existed) {
      try { closeStreamsForSession(sid); } catch (_) {}
    }
    return existed;
  }

  function sessionRecordIsValid(sid, session, now = Date.now()) {
    if (!sid || !session) return false;
    if (now > Number(session.expires || 0)) {
      invalidateSessionSid(sid);
      return false;
    }
    // ASVS 5.0 v7.3.1 requires inactivity expiry independently of the absolute
    // session lifetime. lastSeenAt is updated only after successful validation,
    // so unauthorized/expired requests cannot keep a session alive.
    const lastActivity = Math.max(
      0,
      Number(session.lastSeenAt) || 0,
      Number(session.authenticatedAt) || 0,
    );
    if (!lastActivity || now - lastActivity > sessionIdleMs()) {
      invalidateSessionSid(sid);
      return false;
    }
    if (session.accountId) {
      const account = getAccountById(session.accountId);
      if (!account) {
        invalidateSessionSid(sid);
        return false;
      }
      // Authorization must reflect the current account record, not a role/name
      // snapshot captured at login. Fail closed when persisted role metadata is
      // missing/corrupt instead of retaining the previous privileged role.
      const currentRole = String(account.role || '');
      if (!VALID_SESSION_ROLES.has(currentRole)) {
        invalidateSessionSid(sid);
        return false;
      }
      session.username = account.username || session.username || null;
      session.role = currentRole;
    }
    return true;
  }

  function pruneDeadSessions(now = Date.now()) {
    for (const [sid, session] of sessions) sessionRecordIsValid(sid, session, now);
  }

  function enforceConcurrentSessionLimit(accountId) {
    if (!accountId) return 0;
    const limit = sessionMaxConcurrent();
    const active = [...sessions]
      .filter(([, session]) => session && session.accountId === accountId)
      .sort((left, right) => {
        const leftAt = Number(left[1].authenticatedAt) || 0;
        const rightAt = Number(right[1].authenticatedAt) || 0;
        return leftAt - rightAt;
      });
    let removed = 0;
    // A new session is about to be inserted, so make room for exactly one while
    // preserving the newest existing sessions. Stream cleanup follows normal
    // invalidation semantics for each evicted session.
    while (active.length >= limit) {
      const oldest = active.shift();
      if (oldest && invalidateSessionSid(oldest[0])) removed += 1;
    }
    return removed;
  }

  function createSession(req, res, account, authContext = {}) {
    pruneDeadSessions();
    // Rotate any administrator session already presented by this browser. Login
    // must create a fresh principal rather than leave the previous sid valid in
    // parallel until expiry (session-fixation / stale-session hardening).
    const previousSid = sessionSidFromRequest(req);
    if (previousSid) invalidateSessionSid(previousSid);
    const accountId = account ? account.id : null;
    enforceConcurrentSessionLimit(accountId);
    const sid = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    const authenticatedAt = Date.now();
    const ttlMs = sessionTtlMs();

    const authMethod = String(authContext.authMethod || 'password').slice(0, 40);
    const phishingResistant = authContext.phishingResistant === true;
    sessions.set(sid, {
      csrf,
      expires: authenticatedAt + ttlMs,
      authenticatedAt,
      lastSeenAt: authenticatedAt,
      accountId,
      username: account ? account.username : null,
      role: account ? account.role : null,
      ip: clientIp(req),
      ua: String((req && req.headers && req.headers['user-agent']) || '').slice(0, 400),
      authMethod,
      phishingResistant,
      strongAuthAt: phishingResistant ? authenticatedAt : 0,
    });

    // SameSite=Lax is required for installed PWA top-level navigation / Web
    // Share Target launches. Mutating API requests are still protected by the
    // explicit X-CSRF-Token check below. HTTPS uses the __Host- prefix, which
    // cryptographically couples browser acceptance to Secure + Path=/ + no Domain.
    const maxAge = Math.floor(ttlMs / 1000);
    const suffix = secureCookieSuffix(req);
    const cookieName = sessionCookieName(req);
    const cookies = [
      `${cookieName}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${suffix}`,
    ];
    if (cookieName === SECURE_SESSION_COOKIE) {
      // Remove a pre-upgrade unprefixed cookie so subsequent requests cannot
      // oscillate between two session principals.
      cookies.push(`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${suffix}`);
    }
    res.setHeader('Set-Cookie', cookies.length === 1 ? cookies[0] : cookies);
    return { sid, csrf, authenticatedAt };
  }

  function destroySession(req, res) {
    const sid = sessionSidFromRequest(req);
    if (sid) invalidateSessionSid(sid);
    const suffix = secureCookieSuffix(req);
    const cookieName = sessionCookieName(req);
    const cookies = [
      `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${suffix}`,
    ];
    if (cookieName === SECURE_SESSION_COOKIE) {
      cookies.push(`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${suffix}`);
    }
    res.setHeader('Set-Cookie', cookies.length === 1 ? cookies[0] : cookies);
  }

  function getSession(req) {
    const sid = sessionSidFromRequest(req);
    if (!sid) return null;
    const session = sessions.get(sid);
    if (!sessionRecordIsValid(sid, session)) return null;

    // ASVS L3 contextual session binding: a stolen bearer cookie must not remain
    // useful when moved to a different network/browser context. This is enabled
    // only by the strict profile because NAT/proxy churn can be disruptive in
    // compatibility mode.
    if (asvsL3Mode) {
      const currentIp = String(clientIp(req) || '');
      const currentUa = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 400);
      if (String(session.ip || '') !== currentIp || String(session.ua || '') !== currentUa) {
        invalidateSessionSid(sid);
        return null;
      }
    }

    session.lastSeenAt = Date.now();
    return {
      sid,
      csrf: session.csrf,
      expires: session.expires,
      authenticatedAt: Number(session.authenticatedAt) || 0,
      lastSeenAt: Number(session.lastSeenAt) || 0,
      accountId: session.accountId,
      username: session.username,
      role: session.role,
      ip: session.ip || null,
      ua: session.ua || '',
      authMethod: session.authMethod || 'password',
      phishingResistant: session.phishingResistant === true,
      strongAuthAt: Number(session.strongAuthAt) || 0,
    };
  }

  function requireAuth(req, res, next) {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'not-authenticated' });

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = req.headers['x-csrf-token'];
      if (!token || !timingSafeEqualStr(token, session.csrf)) {
        return res.status(403).json({ error: 'invalid-csrf' });
      }
    }

    req.session = session;
    return next();
  }

  function requireOwner(req, res, next) {
    if (req.session && req.session.role === 'owner') return next();
    return res.status(403).json({ error: 'owner-only' });
  }

  function clearOtherSessionsOfAccount(accountId, keepSid) {
    for (const [sid, session] of sessions) {
      if (sid !== keepSid && session.accountId === accountId) invalidateSessionSid(sid);
    }
  }

  function clearSessionsOfAccount(accountId) {
    for (const [sid, session] of [...sessions]) {
      if (session.accountId === accountId) invalidateSessionSid(sid);
    }
  }

  function clearAllSessions() {
    for (const sid of [...sessions.keys()]) invalidateSessionSid(sid);
  }

  function updateAccountUsername(accountId, username) {
    for (const session of sessions.values()) {
      if (session.accountId === accountId) session.username = username;
    }
  }

  function listSessions(now = Date.now()) {
    pruneDeadSessions(now);
    return [...sessions].map(([sid, session]) => {
      const { csrf: _csrf, ...metadata } = session;
      return { sid, ...metadata };
    });
  }

  function isSessionActive(sid, allowedRoles) {
    const session = sessions.get(sid);
    if (!sessionRecordIsValid(sid, session)) return false;
    return !Array.isArray(allowedRoles) || allowedRoles.includes(session.role);
  }

  function markStrongAuthentication(sid, method = 'passkey', now = Date.now()) {
    const session = sessions.get(sid);
    if (!sessionRecordIsValid(sid, session, now)) return false;
    session.authMethod = String(method || 'passkey').slice(0, 40);
    session.phishingResistant = true;
    session.strongAuthAt = now;
    return true;
  }

  function hasRecentStrongAuthentication(sid, maxAgeMs = strongAuthFreshMs, now = Date.now()) {
    const session = sessions.get(sid);
    if (!sessionRecordIsValid(sid, session, now) || session.phishingResistant !== true) return false;
    const at = Number(session.strongAuthAt) || Number(session.authenticatedAt) || 0;
    const maxAge = Math.max(1000, Number(maxAgeMs) || strongAuthFreshMs);
    return at > 0 && now >= at && now - at <= maxAge;
  }

  function cleanup(now = Date.now()) {
    pruneDeadSessions(now);
  }

  return {
    sessionTtlMs,
    sessionIdleMs,
    sessionMaxConcurrent,
    invalidateSessionSid,
    pruneDeadSessions,
    enforceConcurrentSessionLimit,
    createSession,
    destroySession,
    getSession,
    requireAuth,
    requireOwner,
    clearOtherSessionsOfAccount,
    clearSessionsOfAccount,
    clearAllSessions,
    updateAccountUsername,
    listSessions,
    isSessionActive,
    markStrongAuthentication,
    hasRecentStrongAuthentication,
    cleanup,
  };
}

module.exports = { createSessionService };