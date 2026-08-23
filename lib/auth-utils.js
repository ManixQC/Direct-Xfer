'use strict';

const crypto = require('crypto');

// Password hashing is intentionally expensive, but request-time work must never
// execute on Node's main event loop. Runtime hashes/verifications use the async
// crypto.scrypt API (libuv worker pool) behind a bounded queue so a burst of login
// or public-link unlock attempts cannot create unbounded CPU/memory work.
const MAX_PASSWORD_CHARS = 512;
const SCRYPT_CONCURRENCY = boundedEnvInt('DIRECT_XFER_AUTH_SCRYPT_CONCURRENCY', 2, 1, 8);
const SCRYPT_MAX_QUEUE = boundedEnvInt('DIRECT_XFER_AUTH_SCRYPT_QUEUE', 16, 1, 128);
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
  hashPassword,
  hashPasswordSyncForStartup,
  parseHash,
  verifyPassword,
  passwordInputWithinLimit,
  authScryptStatus,
};
