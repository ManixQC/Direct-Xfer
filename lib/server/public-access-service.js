'use strict';

// Public-link access policy and credential boundary.
//
// This service owns the security primitives that decide whether a visitor may
// reach a share: IP/country rules, per-link password verification, signed unlock
// cookies, request-approval cookies and the runtime brute-force state used by the
// public unlock form. HTTP route composition stays in public-share-routes.js.
function createPublicAccessService(deps = {}) {
  const {
    crypto,
    clientIp,
    geoSync,
    geolocate,
    hashPassword,
    parseHash,
    verifyPassword,
    parseCookies,
    secureCookie,
    timingSafeEqualStr,
    linkPrefix,
    isLoopback,
    isPrivateIp,
    parseIpList,
    ipInList,
    errorPage,
    pickLang,
    maxPasswordChars = 256,
    failWindowMs = 5 * 60 * 1000,
    unlockMaxFails = 8,
    maxUnlockEntries = 10000,
    maxUnlockInFlight = 64,
  } = deps;

  for (const [name, value] of Object.entries({
    clientIp, geoSync, geolocate, hashPassword, parseHash, verifyPassword,
    parseCookies, secureCookie, timingSafeEqualStr, linkPrefix, isLoopback,
    isPrivateIp, parseIpList, ipInList,
  })) {
    if (typeof value !== 'function') throw new TypeError(`public-access-service requires ${name}`);
  }
  if (!crypto || typeof crypto.randomBytes !== 'function' || typeof crypto.createHmac !== 'function') {
    throw new TypeError('public-access-service requires crypto');
  }

  const normalizedMaxPasswordChars = Math.max(1, Math.floor(Number(maxPasswordChars) || 256));
  const normalizedFailWindowMs = Math.max(1000, Math.floor(Number(failWindowMs) || 5 * 60 * 1000));
  const normalizedUnlockMaxFails = Math.max(1, Math.floor(Number(unlockMaxFails) || 8));
  const normalizedMaxUnlockEntries = Math.max(100, Math.floor(Number(maxUnlockEntries) || 10000));
  const normalizedMaxUnlockInFlight = Math.max(1, Math.floor(Number(maxUnlockInFlight) || 64));
  const unlockFails = new Map();
  const unlockAuthInFlight = new Set();
  let unlockSecret = crypto.randomBytes(32);

  function normalizedAccessMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    return mode === 'allow' || mode === 'deny' ? mode : '';
  }

  function normalizeCountryCodes(value) {
    const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,;]+/);
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const code = String(item || '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push(code);
      if (out.length >= 100) break;
    }
    return out;
  }

  function normalizeIpEntries(value) {
    const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[\s,]+/);
    return raw.map((entry) => String(entry || '').trim()).filter(Boolean).slice(0, 100);
  }

  function hasAccessRules(share) {
    if (!share) return false;
    const ipMode = normalizedAccessMode(share.ipMode);
    const geoMode = normalizedAccessMode(share.geoMode);
    // An empty allowlist must fail closed. Treating it as "no rule" would turn
    // a malformed/restored security configuration into unrestricted access.
    return ipMode === 'allow' || geoMode === 'allow'
      || (ipMode === 'deny' && Array.isArray(share.ipList) && share.ipList.length > 0)
      || (geoMode === 'deny' && Array.isArray(share.geoCountries) && share.geoCountries.length > 0);
  }

  async function linkAccessReason(req, share) {
    if (!share) return null;
    const ip = clientIp(req);
    if (isLoopback(ip)) return null;

    const ipMode = normalizedAccessMode(share.ipMode);
    if (ipMode) {
      const storedIpList = Array.isArray(share.ipList) ? share.ipList : [];
      if (ipMode === 'allow' && storedIpList.length === 0) return 'ip';
      if (storedIpList.length) {
        let inList = false;
        try { inList = ipInList(ip, parseIpList(storedIpList.join(','))); }
        catch (_) { return ipMode === 'allow' ? 'ip' : null; }
        if (ipMode === 'allow' && !inList) return 'ip';
        if (ipMode === 'deny' && inList) return 'ip';
      }
    }

    const geoMode = normalizedAccessMode(share.geoMode);
    if (geoMode) {
      // Local addresses stay available for administrative/LAN testing, matching
      // the established Direct-Xfer behavior. Public allowlists still fail closed.
      if (isPrivateIp(ip)) return null;
      const countries = normalizeCountryCodes(Array.isArray(share.geoCountries) ? share.geoCountries : []);
      if (geoMode === 'allow' && countries.length === 0) return 'geo';
      if (countries.length) {
        let geo = geoSync(ip);
        if (!geo) {
          try { geo = await geolocate(ip); } catch (_) {}
        }
        const countryCode = geo && geo.countryCode ? String(geo.countryCode).toUpperCase() : null;
        if (!countryCode && geoMode === 'allow') return 'geo';
        if (countryCode) {
          const inList = countries.includes(countryCode);
          if (geoMode === 'allow' && !inList) return 'geo';
          if (geoMode === 'deny' && inList) return 'geo';
        }
      }
    }
    return null;
  }

  function applyAccessRules(target, body = {}) {
    if (!target || typeof target !== 'object') throw new TypeError('target share is required');

    if (body.geoMode !== undefined) {
      const mode = normalizedAccessMode(body.geoMode);
      const countries = normalizeCountryCodes(body.geoCountries);
      if (mode === 'allow' || (mode === 'deny' && countries.length)) {
        target.geoMode = mode;
        target.geoCountries = countries;
      } else {
        delete target.geoMode;
        delete target.geoCountries;
      }
    }

    if (body.ipMode !== undefined) {
      const mode = normalizedAccessMode(body.ipMode);
      const list = normalizeIpEntries(body.ipList);
      if (mode === 'allow' || (mode === 'deny' && list.length)) {
        target.ipMode = mode;
        target.ipList = list;
      } else {
        delete target.ipMode;
        delete target.ipList;
      }
    }
    return target;
  }

  async function makeSharePassword(password) {
    const result = await hashPassword(password);
    return result.ok ? { pwHash: result.hash } : { error: result.error };
  }

  async function checkSharePassword(share, password) {
    if (!share || !share.pwHash) return { ok: true, match: true };
    if (!password) return { ok: true, match: false };
    const record = parseHash(share.pwHash);
    if (record) return verifyPassword(password, record);

    // Fast legacy password hashes are intentionally no longer verified. Recomputing
    // salted SHA-256 with attacker-controlled password input keeps an obsolete,
    // brute-force-friendly verifier reachable from the public unlock endpoint. Fail
    // closed instead; an administrator can set a fresh password, which stores scrypt.
    return { ok: true, match: false };
  }

  async function upgradeLegacySharePassword() {
    // Kept as a compatibility facade for route composition. Legacy fast hashes cannot
    // be upgraded without first verifying the plaintext using the weak algorithm.
    return false;
  }

  function sendPasswordWorkError(res, error) {
    if (error === 'auth-busy') res.setHeader('Retry-After', '1');
    if (error === 'password-too-long') {
      return res.status(400).json({ error:'password-too-long', maxChars:normalizedMaxPasswordChars });
    }
    const busy = error === 'auth-busy';
    return res.status(503).json({ error:busy ? 'auth-busy' : 'auth-unavailable', retryAfter:busy ? 1 : undefined });
  }

  function sendPasswordWorkHtml(req, res, error) {
    if (error === 'auth-busy') res.setHeader('Retry-After', '1');
    const code = error === 'password-too-long' ? 400 : 503;
    const message = code === 400 ? 'Password too long.' : 'Authentication is temporarily busy. Please retry.';
    if (typeof errorPage === 'function' && typeof pickLang === 'function') {
      return res.status(code).type('html').send(errorPage(pickLang(req), code, message));
    }
    return res.status(code).type('html').send(message);
  }

  function appendSetCookie(res, value) {
    let current;
    try { current = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined; } catch (_) {}
    if (current === undefined && res && res.headers && typeof res.headers === 'object') {
      current = res.headers['set-cookie'] !== undefined ? res.headers['set-cookie'] : res.headers['Set-Cookie'];
    }
    if (current == null || current === '') return res.setHeader('Set-Cookie', value);
    const values = Array.isArray(current) ? current.slice() : [String(current)];
    values.push(value);
    return res.setHeader('Set-Cookie', values);
  }

  function unlockValue(share) {
    return crypto.createHmac('sha256', unlockSecret).update(share.token + ':' + share.pwHash).digest('hex');
  }

  function isUnlocked(req, share) {
    if (!share || !share.pwHash) return true;
    const cookie = parseCookies(req)['dxu_' + share.token];
    return !!cookie && timingSafeEqualStr(cookie, unlockValue(share));
  }

  function setUnlockCookie(req, res, share) {
    const rel = linkPrefix(share);
    appendSetCookie(
      res,
      `dxu_${share.token}=${unlockValue(share)}; HttpOnly; SameSite=Lax; Path=${rel}; Max-Age=86400${secureCookie(req)}`
    );
  }

  function accessRequestCookieName(share) {
    return 'dxreq_' + share.token;
  }

  function pendingAccessRequest(req, share) {
    if (!share) return null;
    const id = parseCookies(req)[accessRequestCookieName(share)];
    if (!id || !Array.isArray(share.accessRequests)) return null;
    return share.accessRequests.find((row) => row && row.id === id) || null;
  }

  function isAccessApproved(req, share) {
    const request = pendingAccessRequest(req, share);
    return !!request && request.status === 'approved';
  }

  function setAccessRequestCookie(req, res, share, id) {
    const rel = linkPrefix(share);
    appendSetCookie(
      res,
      `${accessRequestCookieName(share)}=${id}; HttpOnly; SameSite=Lax; Path=${rel}; Max-Age=2592000${secureCookie(req)}`
    );
  }

  function beginUnlockAttempt(req, now = Date.now()) {
    const ip = clientIp(req);
    const existed = unlockFails.has(ip);
    const record = unlockFails.get(ip) || { fails: [], lockUntil: 0 };
    if (!Array.isArray(record.fails)) record.fails = [];
    record.fails = record.fails.filter((timestamp) => now - timestamp < normalizedFailWindowMs);

    if (record.lockUntil && now < record.lockUntil) {
      return { ok: false, reason: 'locked', retryAfter:Math.max(1, Math.ceil((record.lockUntil - now) / 1000)), ip, record, reserved:false };
    }
    if (unlockAuthInFlight.has(ip)) {
      return { ok: false, reason: 'busy', retryAfter:1, ip, record, reserved:false };
    }
    if ((!existed && unlockFails.size >= normalizedMaxUnlockEntries)
      || unlockAuthInFlight.size >= normalizedMaxUnlockInFlight) {
      return { ok: false, reason: 'capacity', retryAfter:1, ip, record, reserved:false };
    }

    // Reserve a bounded failure-state slot before async password work begins.
    // Without this reservation, many simultaneous first attempts could all pass
    // the size check and overshoot the map limit once their failures completed.
    if (!existed) unlockFails.set(ip, record);
    unlockAuthInFlight.add(ip);
    return { ok: true, reason: null, retryAfter:0, ip, record, reserved:!existed };
  }

  function noteUnlockFailure(attempt, lockMs, now = Date.now()) {
    if (!attempt || !attempt.ip || !attempt.record) throw new TypeError('unlock attempt is required');
    const record = attempt.record;
    if (!Array.isArray(record.fails)) record.fails = [];
    record.fails.push(now);
    record.fails = record.fails.filter((timestamp) => now - timestamp < normalizedFailWindowMs);
    const failedCount = record.fails.length;
    const locked = failedCount >= normalizedUnlockMaxFails;
    if (locked) {
      record.lockUntil = now + Math.max(0, Math.floor(Number(lockMs) || 0));
      record.recoveryFailures = failedCount;
      record.fails = [];
    }
    unlockFails.set(attempt.ip, record);
    return { failedCount, locked, at: now, record };
  }

  function noteUnlockSuccess(attempt) {
    if (!attempt || !attempt.ip || !attempt.record) throw new TypeError('unlock attempt is required');
    const record = attempt.record;
    const previousFailures = Math.max(
      Array.isArray(record.fails) ? record.fails.length : 0,
      Math.max(0, Number(record.recoveryFailures) || 0)
    );
    unlockFails.delete(attempt.ip);
    return { previousFailures };
  }

  function finishUnlockAttempt(attempt) {
    if (!attempt || !attempt.ip) return;
    unlockAuthInFlight.delete(attempt.ip);
    if (attempt.reserved && unlockFails.get(attempt.ip) === attempt.record) {
      const record = attempt.record || {};
      const hasFails = Array.isArray(record.fails) && record.fails.length > 0;
      if (!hasFails && !record.lockUntil) unlockFails.delete(attempt.ip);
    }
  }

  function clearRuntimeState() {
    unlockFails.clear();
    unlockAuthInFlight.clear();
    // Unlock cookies are intentionally process-runtime credentials. A committed
    // restore replaces the authoritative share/password state, so rotate the
    // HMAC key instead of allowing a pre-restore browser cookie to remain valid
    // merely because the restored token/password hash happens to match.
    unlockSecret = null;
    unlockSecret = crypto.randomBytes(32);
  }

  function isBusyForStateReplacement() {
    return unlockAuthInFlight.size > 0;
  }

  return {
    hasAccessRules,
    linkAccessReason,
    applyAccessRules,
    makeSharePassword,
    checkSharePassword,
    upgradeLegacySharePassword,
    sendPasswordWorkError,
    sendPasswordWorkHtml,
    isUnlocked,
    setUnlockCookie,
    pendingAccessRequest,
    isAccessApproved,
    setAccessRequestCookie,
    beginUnlockAttempt,
    noteUnlockFailure,
    noteUnlockSuccess,
    finishUnlockAttempt,
    clearRuntimeState,
    isBusyForStateReplacement,
    unlockFails,
    unlockAuthInFlight,
    failWindowMs: normalizedFailWindowMs,
    unlockMaxFails: normalizedUnlockMaxFails,
    maxUnlockEntries: normalizedMaxUnlockEntries,
    maxUnlockInFlight: normalizedMaxUnlockInFlight,
    maxPasswordChars: normalizedMaxPasswordChars,
  };
}

module.exports = { createPublicAccessService };
