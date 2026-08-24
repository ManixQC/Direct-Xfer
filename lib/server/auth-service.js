'use strict';

const crypto = require('crypto');
const {
  hashPassword,
  parseHash,
  verifyPassword,
} = require('../auth-utils');

const DEFAULT_FAIL_WINDOW_MS = 5 * 60 * 1000;
const KNOWN_DEVICES_MAX = 50;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Owns administrator credential verification, brute-force state and TOTP.
 *
 * The service has no direct dependency on Direct-Xfer's persisted state shape.
 * Account lookup, persistence, auditing and notifications are injected by the
 * composition root (server.js), which keeps this security boundary testable.
 */
function createAuthService(options = {}) {
  const {
    getSettings,
    findAccountByName,
    getAccountById,
    accountPasswordRecord,
    dummyPasswordRecord,
    normalizeUsername,
    clientIp,
    createSession,
    scheduleFlush,
    persistNow,
    logAudit,
    getPwaDevice,
    pwaDeviceResolvedAccount,
    geoSync,
    geolocate,
    addCenterNotification,
    enrichCenterNotificationGeo,
    publicIp,
    flagFromCode,
    failWindowMs = DEFAULT_FAIL_WINDOW_MS,
    passwordHasher = hashPassword,
    passwordParser = parseHash,
    passwordVerifier = verifyPassword,
  } = options;

  const required = {
    getSettings,
    findAccountByName,
    getAccountById,
    accountPasswordRecord,
    normalizeUsername,
    clientIp,
    createSession,
    scheduleFlush,
    persistNow,
    logAudit,
    passwordHasher,
    passwordParser,
    passwordVerifier,
  };
  for (const [name, value] of Object.entries(required)) {
    if (typeof value !== 'function') throw new TypeError(`auth-service requires ${name}()`);
  }

  const safeGetPwaDevice = typeof getPwaDevice === 'function' ? getPwaDevice : () => null;
  const safePwaDeviceResolvedAccount = typeof pwaDeviceResolvedAccount === 'function'
    ? pwaDeviceResolvedAccount
    : () => null;
  const safeGeoSync = typeof geoSync === 'function' ? geoSync : () => null;
  const safeGeolocate = typeof geolocate === 'function' ? geolocate : async () => null;
  const safeAddCenterNotification = typeof addCenterNotification === 'function'
    ? addCenterNotification
    : () => null;
  const safeEnrichCenterNotificationGeo = typeof enrichCenterNotificationGeo === 'function'
    ? enrichCenterNotificationGeo
    : () => {};
  const safePublicIp = typeof publicIp === 'function' ? publicIp : (ip) => ip;
  const safeFlagFromCode = typeof flagFromCode === 'function' ? flagFromCode : () => '';

  const failureWindowMs = Math.max(1000, Number(failWindowMs) || DEFAULT_FAIL_WINDOW_MS);
  if (!dummyPasswordRecord || !dummyPasswordRecord.hash || !dummyPasswordRecord.salt) {
    throw new TypeError('auth-service requires a dummyPasswordRecord');
  }

  const loginAttempts = new Map();
  // Password verification is asynchronous. Only one login from a given source IP
  // may be in the credential-verification phase at a time; otherwise concurrent
  // requests could all observe the same pre-failure state and bypass lockout.
  const loginInFlight = new Set();

  function maxLoginFails() {
    const value = Math.floor(Number(getSettings().maxLoginAttempts));
    return Number.isFinite(value) && value >= 1 ? Math.min(100, value) : 5;
  }

  function lockMs() {
    const value = Math.floor(Number(getSettings().lockoutMinutes));
    return (Number.isFinite(value) && value >= 1 ? Math.min(1440, value) : 5) * 60 * 1000;
  }

  function recordLoginFailure(ip, record, now) {
    record.fails.push(now);
    record.fails = record.fails.filter((timestamp) => now - timestamp < failureWindowMs);
    if (record.fails.length >= maxLoginFails()) {
      record.lockUntil = now + lockMs();
      record.fails = [];
    }
    loginAttempts.set(ip, record);
    return record.lockUntil > now;
  }

  function passwordRecordsEqual(left, right) {
    if (!left || !right || !left.salt || !left.hash || !right.salt || !right.hash) return false;
    if (left.salt.length !== right.salt.length || left.hash.length !== right.hash.length) return false;
    return crypto.timingSafeEqual(left.salt, right.salt)
      && crypto.timingSafeEqual(left.hash, right.hash);
  }

  function loginDeviceKey(req, ip) {
    const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 400);
    return crypto.createHash('sha256').update(ua + '|' + String(ip || '')).digest('hex').slice(0, 24);
  }

  function isNewLoginDevice(account, key) {
    if (!account || !key) return false;
    if (!Array.isArray(account.knownDevices)) account.knownDevices = [];
    if (account.knownDevices.includes(key)) return false;
    account.knownDevices.push(key);
    if (account.knownDevices.length > KNOWN_DEVICES_MAX) {
      account.knownDevices = account.knownDevices.slice(-KNOWN_DEVICES_MAX);
    }
    return true;
  }

  function base32encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return output;
  }

  function base32decode(value) {
    let bits = 0;
    let aggregate = 0;
    const output = [];
    for (const char of String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
      aggregate = (aggregate << 5) | BASE32_ALPHABET.indexOf(char);
      bits += 5;
      if (bits >= 8) {
        output.push((aggregate >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(output);
  }

  function totpAt(key, counter) {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter >>> 0, 4);
    const digest = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = digest[digest.length - 1] & 0xf;
    const number = ((digest[offset] & 0x7f) << 24)
      | ((digest[offset + 1] & 0xff) << 16)
      | ((digest[offset + 2] & 0xff) << 8)
      | (digest[offset + 3] & 0xff);
    return String(number % 1000000).padStart(6, '0');
  }

  // ASVS 5.0 v6.5.5 caps TOTP lifetime at 30 seconds. The default therefore
  // accepts exactly the current time step. Callers may pass an explicit window
  // only for non-authentication diagnostics/tests; authentication uses window=0.
  function matchingTotpCounter(secret, token, window = 0) {
    const candidate = String(token || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(candidate)) return null;
    const key = base32decode(secret);
    const counter = Math.floor(Date.now() / 30000);
    const safeWindow = Math.max(0, Math.min(10, Math.floor(Number(window) || 0)));
    for (let offset = -safeWindow; offset <= safeWindow; offset += 1) {
      const expected = totpAt(key, counter + offset);
      if (expected.length === candidate.length
          && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) {
        return counter + offset;
      }
    }
    return null;
  }

  function verifyTotp(secret, token, window = 0) {
    return matchingTotpCounter(secret, token, window) !== null;
  }

  function twoFactorEnabledFor(account) {
    return !!(account && account.totp && account.totp.enabled && account.totp.secret);
  }

  function consumeTotpFor(account, input) {
    const twoFactor = account && account.totp;
    if (!twoFactor || !twoFactor.enabled || !twoFactor.secret) return { ok: false };
    const matchedCounter = matchingTotpCounter(twoFactor.secret, input, 0);
    if (matchedCounter === null) return { ok: false };

    const previousRaw = twoFactor.lastCounter;
    const previousCounter = Number(previousRaw);
    if (Number.isSafeInteger(previousCounter) && matchedCounter <= previousCounter) {
      return { ok: false, replayed: true };
    }

    // Persist before granting authentication so replay protection survives a
    // process restart. Node executes this mutation/persist block synchronously,
    // so concurrent logins from different source IPs cannot both consume the
    // same counter between the check and update.
    twoFactor.lastCounter = matchedCounter;
    if (persistNow()) return { ok: true };

    if (previousRaw === undefined) delete twoFactor.lastCounter;
    else twoFactor.lastCounter = previousRaw;
    return { ok: false, busy: true };
  }

  async function verifyTotpOrRecoveryFor(account, input) {
    const twoFactor = account && account.totp;
    if (!twoFactor || !twoFactor.enabled) return { ok: false };

    const normalized = String(input || '').replace(/\s/g, '');
    // Six-digit input is unambiguously TOTP. Treat an expired/replayed value as a
    // failed factor instead of falling through to recovery-code work.
    if (/^\d{6}$/.test(normalized)) return consumeTotpFor(account, normalized);

    const codes = Array.isArray(twoFactor.recovery) ? twoFactor.recovery : [];
    const candidate = normalized.toLowerCase();
    // A wrong TOTP must not trigger the expensive recovery-code scrypt loop.
    // Recovery codes have the fixed hexadecimal format generated by DX.
    if (!/^[0-9a-f]{10}$/.test(candidate)) return { ok: false };

    // Iterate over a snapshot. The live recovery array may shrink while an async
    // scrypt comparison is pending because a different IP can consume another
    // code. Snapshot iteration avoids skipping the next code after such a splice.
    for (const storedHash of codes.slice()) {
      if (getAccountById(account.id) !== account || account.totp !== twoFactor || !twoFactor.enabled) {
        return { ok: false };
      }
      const record = passwordParser(storedHash);
      if (!record) continue;
      const checked = await passwordVerifier(candidate, record);
      if (!checked.ok) return { ok: false, busy: true };

      // Another login from a different IP may have consumed this same one-time
      // code while scrypt was running. A concurrent 2FA reset may also have
      // replaced the whole TOTP record. Never accept stale authentication state.
      if (getAccountById(account.id) !== account || account.totp !== twoFactor || !twoFactor.enabled) {
        return { ok: false };
      }
      if (!checked.match) continue;
      const currentIndex = codes.indexOf(storedHash);
      if (currentIndex < 0) return { ok: false };
      const consumed = codes.splice(currentIndex, 1)[0];
      if (persistNow()) return { ok: true };
      codes.splice(currentIndex, 0, consumed);
      return { ok: false };
    }
    return { ok: false };
  }

  async function attemptLogin(req, res, username, password, totp) {
    const ip = String(clientIp(req) || 'unknown');
    const startedAt = Date.now();
    const record = loginAttempts.get(ip) || { fails: [], lockUntil: 0 };
    if (record.lockUntil && startedAt < record.lockUntil) {
      return {
        ok: false,
        locked: true,
        retryAfter: Math.ceil((record.lockUntil - startedAt) / 1000),
      };
    }
    if (loginInFlight.has(ip)) return { ok: false, busy: true, retryAfter: 1 };

    loginInFlight.add(ip);
    try {
      const retryAfter = () => (record.lockUntil > Date.now()
        ? Math.ceil((record.lockUntil - Date.now()) / 1000)
        : undefined);
      let account = findAccountByName(username);
      const verifiedRecord = account ? accountPasswordRecord(account) : dummyPasswordRecord;
      const passwordCheck = await passwordVerifier(password || '', verifiedRecord);
      if (!passwordCheck.ok) return { ok: false, busy: true, retryAfter: 1 };

      if (!account || !passwordCheck.match) {
        const failureAt = Date.now();
        const locked = recordLoginFailure(ip, record, failureAt);
        logAudit('login-fail', {
          username: normalizeUsername(username),
          ip,
          detail: locked ? 'locked-out' : null,
        });
        return { ok: false, locked, retryAfter: retryAfter() };
      }

      // scrypt runs off-thread, so account state may change while verification is
      // pending. Re-read the account and credential before granting a session.
      // This prevents an old password from winning a race with password reset,
      // account deletion, or username rename.
      const currentAccount = getAccountById(account.id);
      const currentRecord = currentAccount ? accountPasswordRecord(currentAccount) : null;
      const usernameStillCurrent = !!currentAccount
        && normalizeUsername(currentAccount.username) === normalizeUsername(username);
      if (!currentAccount || !usernameStillCurrent || !passwordRecordsEqual(verifiedRecord, currentRecord)) {
        const failureAt = Date.now();
        const locked = recordLoginFailure(ip, record, failureAt);
        logAudit('login-fail', {
          username: normalizeUsername(username),
          ip,
          detail: locked ? 'locked-out' : 'credential-changed',
        });
        return { ok: false, locked, retryAfter: retryAfter() };
      }
      account = currentAccount;

      if (twoFactorEnabledFor(account)) {
        if (!totp) return { ok: false, totpRequired: true };
        const secondFactor = await verifyTotpOrRecoveryFor(account, totp);
        if (!secondFactor.ok && secondFactor.busy) {
          return { ok: false, busy: true, retryAfter: 1 };
        }
        if (!secondFactor.ok) {
          const failureAt = Date.now();
          const locked = recordLoginFailure(ip, record, failureAt);
          logAudit('login-2fa-fail', {
            account,
            ip,
            detail: secondFactor.replayed ? 'totp-replay' : (locked ? 'locked-out' : null),
          });
          return { ok: false, totpInvalid: true, locked, retryAfter: retryAfter() };
        }
      }

      // Re-check the account and the verified credential once more after an
      // asynchronous recovery-code check. A password reset must invalidate a
      // login already waiting on second-factor scrypt just as it invalidates
      // sessions that existed before the reset.
      const finalAccount = getAccountById(account.id);
      const finalRecord = finalAccount ? accountPasswordRecord(finalAccount) : null;
      const finalUsernameCurrent = !!finalAccount
        && normalizeUsername(finalAccount.username) === normalizeUsername(username);
      if (!finalAccount || !finalUsernameCurrent || !passwordRecordsEqual(verifiedRecord, finalRecord)) {
        return { ok: false };
      }
      account = finalAccount;

      loginAttempts.delete(ip);
      account.lastLoginAt = Date.now();
      scheduleFlush();
      const session = createSession(req, res, account);

      const deviceKey = loginDeviceKey(req, ip);
      const knownLoginDevice = Array.isArray(account.knownDevices)
        && account.knownDevices.includes(deviceKey);
      const pairedLoginDevice = safeGetPwaDevice(req, false, true);
      const pairedLoginOwner = pairedLoginDevice
        ? safePwaDeviceResolvedAccount(pairedLoginDevice)
        : null;
      const ownPairedDevice = !!(
        pairedLoginOwner && String(pairedLoginOwner.id) === String(account.id)
      );
      const recognizedOwnDevice = knownLoginDevice || ownPairedDevice;
      const newDevice = isNewLoginDevice(account, deviceKey);

      logAudit('login', {
        account,
        ip,
        detail: newDevice ? (ownPairedDevice ? 'paired device' : 'new device') : 'known device',
        suppressSecurityAlert: recognizedOwnDevice,
      });

      const loginGeo = safeGeoSync(ip) || {};
      const notificationData = {
        username: account.username || '',
        ip: safePublicIp(ip),
        country: loginGeo.country || null,
        flag: loginGeo.flag || safeFlagFromCode(loginGeo.countryCode) || '🌐',
      };
      const loginCenterNote = recognizedOwnDevice
        ? null
        : safeAddCenterNotification(account.id, 'admin-login', {
            ...notificationData,
            reason: newDevice ? 'new-device' : 'known-device',
          });
      const unusualCenterNote = !recognizedOwnDevice && newDevice
        ? safeAddCenterNotification(account.id, 'admin-login-unusual', {
            ...notificationData,
            reason: 'new-device',
            dedupeKey: `unusual-login:${account.id}:${deviceKey}`,
            dedupeWindowMs: 30 * 24 * 60 * 60 * 1000,
          })
        : null;

      if (ip && ip !== 'unknown' && !loginGeo.country && getSettings().geoLookup !== false) {
        safeGeolocate(ip).then((resolved) => {
          if (!resolved) return;
          if (loginCenterNote) {
            safeEnrichCenterNotificationGeo(account.id, loginCenterNote.id, ip, resolved);
          }
          if (unusualCenterNote) {
            safeEnrichCenterNotificationGeo(account.id, unusualCenterNote.id, ip, resolved);
          }
        }).catch(() => {});
      }

      return { ok: true, sid: session.sid, csrf: session.csrf, account };
    } finally {
      loginInFlight.delete(ip);
    }
  }

  async function verifyCurrentPassword(account, plain) {
    if (!account || !account.id) return { ok: true, match: false };
    const verifiedRecord = accountPasswordRecord(account);
    if (!verifiedRecord) return { ok: true, match: false };
    const checked = await passwordVerifier(plain || '', verifiedRecord);
    if (!checked.ok || !checked.match) return checked;
    const currentAccount = getAccountById(account.id);
    const currentRecord = currentAccount ? accountPasswordRecord(currentAccount) : null;
    if (currentAccount !== account || !passwordRecordsEqual(verifiedRecord, currentRecord)) {
      return { ok: true, match: false, stale: true };
    }
    return {
      ok: true,
      match: true,
      account: currentAccount,
      // Internal compare-and-swap token for a following credential mutation.
      // Route code never exposes this value to the client.
      credentialHash: currentAccount.ah,
    };
  }

  async function setAccountPassword(
    account,
    newPassword,
    { pwChanged = true, beforeCommit = null, expectedHash = undefined } = {},
  ) {
    if (!account || !account.id) return { ok: false, error: 'account-changed' };
    const previousHash = account.ah;
    const previousPwChanged = account.pwChanged;
    if (expectedHash !== undefined && previousHash !== expectedHash) {
      return { ok: false, error: 'account-changed' };
    }
    const hashed = await passwordHasher(newPassword);
    if (!hashed.ok) return { ok: false, error: hashed.error };

    // Hashing yields to the event loop. Refuse to overwrite a password that was
    // reset/changed, or an account object that was deleted/replaced, while the
    // new scrypt value was being derived.
    const currentAccount = getAccountById(account.id);
    if (currentAccount !== account
        || currentAccount.ah !== previousHash
        || currentAccount.pwChanged !== previousPwChanged) {
      return { ok: false, error: 'account-changed' };
    }
    if (typeof beforeCommit === 'function' && !beforeCommit()) {
      return { ok: false, error: 'not-authorized' };
    }

    account.ah = hashed.hash;
    account.pwChanged = !!pwChanged;
    if (persistNow()) return { ok: true, account };

    account.ah = previousHash;
    account.pwChanged = previousPwChanged;
    return { ok: false, error: 'write-error' };
  }

  function cleanup(now = Date.now()) {
    for (const [ip, record] of loginAttempts) {
      if (Array.isArray(record.fails)) {
        record.fails = record.fails.filter((timestamp) => now - timestamp < failureWindowMs);
      }
      if ((!record.lockUntil || now > record.lockUntil)
          && (!record.fails || record.fails.length === 0)) {
        loginAttempts.delete(ip);
      }
    }
  }

  function clearRuntimeState() {
    loginAttempts.clear();
    loginInFlight.clear();
  }

  function isBusyForStateReplacement() {
    return loginInFlight.size > 0;
  }

  function lockedLoginIps(now = Date.now()) {
    const result = [];
    for (const [ip, record] of loginAttempts) {
      if (record.lockUntil && record.lockUntil > now) {
        result.push({ ip, until: record.lockUntil, kind: 'admin' });
      }
    }
    return result;
  }

  return {
    attemptLogin,
    verifyCurrentPassword,
    setAccountPassword,
    base32encode,
    verifyTotp,
    twoFactorEnabledFor,
    lockMs,
    cleanup,
    clearRuntimeState,
    isBusyForStateReplacement,
    lockedLoginIps,
  };
}

module.exports = { createAuthService };
