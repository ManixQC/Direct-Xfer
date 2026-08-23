'use strict';

const crypto = require('crypto');

const VALID_SESSION_ROLES = new Set(['owner', 'admin', 'operator', 'auditor']);

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
    getAccountById,
    clientIp,
    parseCookies,
    secureCookie,
    timingSafeEqualStr,
    closeStreamsForSession = () => {},
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
  const sessions = new Map();

  function sessionTtlMs() {
    const hours = Math.floor(Number(getSettings().sessionHours));
    return Number.isFinite(hours) && hours > 0
      ? Math.min(720, hours) * 60 * 60 * 1000
      : fallbackTtlMs;
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

  function createSession(req, res, account) {
    pruneDeadSessions();
    // Rotate any administrator session already presented by this browser. Login
    // must create a fresh principal rather than leave the previous sid valid in
    // parallel until expiry (session-fixation / stale-session hardening).
    const previousSid = parseCookies(req).sid;
    if (previousSid) invalidateSessionSid(previousSid);
    const sid = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    const authenticatedAt = Date.now();
    const ttlMs = sessionTtlMs();

    sessions.set(sid, {
      csrf,
      expires: authenticatedAt + ttlMs,
      authenticatedAt,
      lastSeenAt: authenticatedAt,
      accountId: account ? account.id : null,
      username: account ? account.username : null,
      role: account ? account.role : null,
      ip: clientIp(req),
      ua: String((req && req.headers && req.headers['user-agent']) || '').slice(0, 400),
    });

    // SameSite=Lax is required for installed PWA top-level navigation / Web
    // Share Target launches. Mutating API requests are still protected by the
    // explicit X-CSRF-Token check below.
    const maxAge = Math.floor(ttlMs / 1000);
    res.setHeader(
      'Set-Cookie',
      `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie(req)}`
    );
    return { sid, csrf, authenticatedAt };
  }

  function destroySession(req, res) {
    const { sid } = parseCookies(req);
    if (sid) invalidateSessionSid(sid);
    res.setHeader(
      'Set-Cookie',
      `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie(req)}`
    );
  }

  function getSession(req) {
    const { sid } = parseCookies(req);
    if (!sid) return null;
    const session = sessions.get(sid);
    if (!sessionRecordIsValid(sid, session)) return null;

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

  function cleanup(now = Date.now()) {
    pruneDeadSessions(now);
  }

  return {
    sessionTtlMs,
    invalidateSessionSid,
    pruneDeadSessions,
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
    cleanup,
  };
}

module.exports = { createSessionService };
