'use strict';

const crypto = require('crypto');
const https = require('https');

// Password hashing is intentionally expensive, but request-time work must never
// execute on Node's main event loop. Runtime hashes/verifications use the async
// crypto.scrypt API (libuv worker pool) behind a bounded queue so a burst of login
// or public-link unlock attempts cannot create unbounded CPU/memory work.
const MAX_PASSWORD_CHARS = 512;
const SCRYPT_CONCURRENCY = boundedEnvInt('DIRECT_XFER_AUTH_SCRYPT_CONCURRENCY', 2, 1, 8);
const SCRYPT_MAX_QUEUE = boundedEnvInt('DIRECT_XFER_AUTH_SCRYPT_QUEUE', 16, 1, 128);
const BREACH_CHECK_TIMEOUT_MS = boundedEnvInt('DIRECT_XFER_BREACH_CHECK_TIMEOUT_MS', 3000, 500, 10000);
const BREACH_RESPONSE_MAX_BYTES = 1024 * 1024;
const ACCOUNT_PASSWORD_MIN_CHARS = 8;
const ACCOUNT_PASSWORD_SERVICE_TERMS = Object.freeze(['direct-xfer', 'directxfer', 'direct xfer']);
const LOCAL_COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
  '123456', '12345678', '123456789', '1234567890', '111111', '000000',
  'abc123', 'admin', 'administrator', 'letmein', 'welcome', 'welcome1',
  'monkey', 'dragon', 'master', 'login', 'secret', 'changeme', 'iloveyou',
  'sunshine', 'princess', 'football', 'baseball', 'superman', 'trustno1',
]);
let activeScrypt = 0;
const scryptQueue = [];

function boundedEnvInt(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function passwordInputWithinLimit(plain) {
  return String(plain == null ? '' : plain).length <= MAX_PASSWORD_CHARS;
}

function runScrypt(plain, salt, keyLength) {
  return new Promise((resolve) => {
    const run = () => {
      activeScrypt += 1;
      crypto.scrypt(String(plain), salt, keyLength, (error, derivedKey) => {
        activeScrypt -= 1;
        const next = scryptQueue.shift();
        if (next) next();
        if (error) return resolve({ ok: false, error: 'scrypt-failed' });
        return resolve({ ok: true, value: derivedKey });
      });
    };

    if (activeScrypt < SCRYPT_CONCURRENCY) return run();
    if (scryptQueue.length >= SCRYPT_MAX_QUEUE) return resolve({ ok: false, error: 'auth-busy' });
    scryptQueue.push(run);
  });
}

async function hashPassword(plain) {
  if (!passwordInputWithinLimit(plain)) return { ok: false, error: 'password-too-long' };
  const salt = crypto.randomBytes(16);
  const result = await runScrypt(String(plain), salt, 64);
  if (!result.ok) return result;
  return {
    ok: true,
    hash: 'scrypt$' + salt.toString('base64') + '$' + result.value.toString('base64'),
  };
}

// Bootstrap-only compatibility helper. Direct-Xfer must have account hashes ready
// before it starts accepting HTTP traffic. The few calls to this helper occur only
// during startup/migration, before app.listen()/https.listen(), never from a request
// handler. All remotely reachable hashing and verification uses hashPassword() /
// verifyPassword() above and therefore does not block the event loop.
function hashPasswordSyncForStartup(plain) {
  if (!passwordInputWithinLimit(plain)) throw new RangeError('password-too-long');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

function parseHash(stored) {
  const m = /^scrypt\$([^$]+)\$([^$]+)$/.exec(String(stored || '').trim());
  if (!m) return null;
  try {
    const salt = Buffer.from(m[1], 'base64');
    const hash = Buffer.from(m[2], 'base64');
    // Reject malformed records before they can reach scrypt. Existing Direct-Xfer
    // hashes use a 16-byte salt and a 64-byte derived key.
    if (!salt.length || !hash.length || hash.length > 128) return null;
    return { salt, hash };
  } catch (_) {
    return null;
  }
}

async function verifyPassword(plain, rec) {
  if (!rec || !rec.hash || !rec.hash.length) return { ok: true, match: false };
  // Oversized password inputs are rejected before any expensive work. This also
  // keeps unknown-user and known-user timing behavior aligned for abusive inputs.
  if (!passwordInputWithinLimit(plain)) return { ok: true, match: false };
  const result = await runScrypt(String(plain), rec.salt, rec.hash.length);
  if (!result.ok) return result;
  const cand = result.value;
  return {
    ok: true,
    match: cand.length === rec.hash.length && crypto.timingSafeEqual(cand, rec.hash),
  };
}

function compactPasswordPolicyText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function contextualPasswordTerms(context = {}) {
  const candidates = [
    ...ACCOUNT_PASSWORD_SERVICE_TERMS,
    context.username,
    context.email,
    context.displayName,
    ...(Array.isArray(context.extraTerms) ? context.extraTerms : []),
  ];
  const terms = new Set();
  for (const candidate of candidates) {
    const compact = compactPasswordPolicyText(candidate);
    if (compact.length >= 3) terms.add(compact);
  }
  return terms;
}

/**
 * Query the Pwned Passwords range service using k-anonymity. Only the first five
 * hexadecimal characters of the SHA-1 digest leave Direct-Xfer; the plaintext
 * password and full digest never do. Add-Padding reduces response-size leakage.
 */
function checkPwnedPassword(plain, requestFactory = https.request) {
  const digest = crypto.createHash('sha1').update(Buffer.from(String(plain), 'utf8')).digest('hex').toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let request;
    try {
      request = requestFactory({
        protocol: 'https:',
        hostname: 'api.pwnedpasswords.com',
        port: 443,
        method: 'GET',
        path: '/range/' + prefix,
        headers: {
          Accept: 'text/plain',
          'Accept-Encoding': 'identity',
          'Add-Padding': 'true',
          'User-Agent': 'Direct-Xfer-password-policy',
        },
      }, (response) => {
        if (!response || response.statusCode !== 200) {
          if (response && typeof response.resume === 'function') response.resume();
          finish({ ok: false, error: 'password-breach-check-unavailable' });
          return;
        }
        let bytes = 0;
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > BREACH_RESPONSE_MAX_BYTES) {
            if (typeof response.destroy === 'function') response.destroy();
            finish({ ok: false, error: 'password-breach-check-unavailable' });
            return;
          }
          body += chunk;
        });
        response.on('end', () => {
          if (settled) return;
          let count = 0;
          for (const line of body.split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator <= 0) continue;
            if (line.slice(0, separator).trim().toUpperCase() !== suffix) continue;
            count = Math.max(0, Number(line.slice(separator + 1).trim()) || 0);
            break;
          }
          finish({ ok: true, breached: count > 0, count });
        });
        response.on('error', () => finish({ ok: false, error: 'password-breach-check-unavailable' }));
      });
    } catch (_) {
      finish({ ok: false, error: 'password-breach-check-unavailable' });
      return;
    }

    request.setTimeout(BREACH_CHECK_TIMEOUT_MS, () => {
      try { request.destroy(); } catch (_) {}
      finish({ ok: false, error: 'password-breach-check-unavailable' });
    });
    request.on('error', () => finish({ ok: false, error: 'password-breach-check-unavailable' }));
    request.end();
  });
}

/**
 * ASVS L3 account-password policy. No composition rules are imposed: long
 * passphrases remain valid. The policy rejects context-specific choices and uses
 * the HIBP corpus (which contains the common-password population far beyond the
 * ASVS top-3000 floor). A corpus outage fails closed for credential creation or
 * change rather than silently accepting an unchecked password.
 */
async function validateAccountPassword(plain, context = {}, breachChecker = checkPwnedPassword) {
  const value = String(plain == null ? '' : plain);
  if (value.length < ACCOUNT_PASSWORD_MIN_CHARS) return { ok: false, error: 'too-short' };
  if (!passwordInputWithinLimit(value)) return { ok: false, error: 'password-too-long' };

  const normalized = value.normalize('NFKC').toLowerCase();
  if (LOCAL_COMMON_PASSWORDS.has(normalized)) return { ok: false, error: 'password-common' };

  const compact = compactPasswordPolicyText(value);
  for (const term of contextualPasswordTerms(context)) {
    if (compact.includes(term)) return { ok: false, error: 'password-contextual' };
  }

  let breach;
  try { breach = await breachChecker(value); }
  catch (_) { return { ok: false, error: 'password-breach-check-unavailable' }; }
  if (!breach || breach.ok !== true) {
    return { ok: false, error: breach && breach.error || 'password-breach-check-unavailable' };
  }
  if (breach.breached) return { ok: false, error: 'password-breached', breachCount:Math.max(1, Number(breach.count) || 1) };
  return { ok: true };
}

function authScryptStatus() {
  return {
    active: activeScrypt,
    queued: scryptQueue.length,
    concurrency: SCRYPT_CONCURRENCY,
    maxQueue: SCRYPT_MAX_QUEUE,
  };
}

module.exports = {
  MAX_PASSWORD_CHARS,
  ACCOUNT_PASSWORD_MIN_CHARS,
  hashPassword,
  hashPasswordSyncForStartup,
  parseHash,
  verifyPassword,
  passwordInputWithinLimit,
  checkPwnedPassword,
  validateAccountPassword,
  authScryptStatus,
};