'use strict';

const { createExternalCryptoProvider } = require('./external-crypto-provider');

// Runtime anti-abuse primitives for public links.
//
// Owns transfer rate limiting, public-message deduplication/throttling and the
// proof-of-work pass used to gate large downloads. Durable share state and HTTP
// route composition remain outside this service.
function createPublicAbuseService(deps = {}) {
  const {
    crypto,
    clientIp,
    getSettings,
    maskIp,
    parseCookies,
    secureCookie,
    timingSafeEqualStr,
    challengePage,
    pickLang,
    pruneLeakTrackers,
    publicMessageWindowMs = 60000,
    publicMessageMax = 5,
    publicMessageDupMs = 30000,
    publicMessageNotifyCooldownMs = 15000,
    cleanupIntervalMs = 60000,
    maxPublicRateEntries = 50000,
    maxPublicMessageEntries = 10000,
    powChallengeTtlMs = 120000,
    powPassTtlMs = 30 * 60000,
    asvsL3Mode = false,
    cryptoProviderCommand = '',
  } = deps;

  for (const [name, value] of Object.entries({
    clientIp, getSettings, maskIp, parseCookies, secureCookie, timingSafeEqualStr,
  })) {
    if (typeof value !== 'function') throw new TypeError(`public-abuse-service requires ${name}`);
  }
  if (!crypto || typeof crypto.randomBytes !== 'function' || typeof crypto.createHmac !== 'function' || typeof crypto.createHash !== 'function') {
    throw new TypeError('public-abuse-service requires crypto');
  }

  const messageWindowMs = Math.max(1000, Math.floor(Number(publicMessageWindowMs) || 60000));
  const messageMax = Math.max(1, Math.floor(Number(publicMessageMax) || 5));
  const messageDupMs = Math.max(0, Math.floor(Number(publicMessageDupMs) || 30000));
  const notifyCooldownMs = Math.max(0, Math.floor(Number(publicMessageNotifyCooldownMs) || 15000));
  const rateEntryLimit = Math.max(100, Math.floor(Number(maxPublicRateEntries) || 50000));
  const messageEntryLimit = Math.max(100, Math.floor(Number(maxPublicMessageEntries) || 10000));
  const challengeTtlMs = Math.max(1000, Math.min(10 * 60000, Math.floor(Number(powChallengeTtlMs) || 120000)));
  const passTtlMs = Math.max(1000, Math.min(24 * 60 * 60000, Math.floor(Number(powPassTtlMs) || 30 * 60000)));
  const publicHits = new Map();
  const publicMessageHits = new Map();
  let powSecret = crypto.randomBytes(32);
  const externalCrypto = asvsL3Mode ? createExternalCryptoProvider({ command:cryptoProviderCommand }) : null;
  if (asvsL3Mode && !externalCrypto) throw new TypeError('public-abuse-service requires isolated L3 crypto provider');

  function cloneMessageRecord(record) {
    if (!record) return null;
    return {
      hits: Array.isArray(record.hits) ? record.hits.slice() : [],
      lastHash: String(record.lastHash || ''),
      lastAt: Number(record.lastAt) || 0,
      lastNotifyAt: Number(record.lastNotifyAt) || 0,
    };
  }

  function snapshotPublicMessageDecision(req, token) {
    const key = `${String(token || '')}|${clientIp(req)}`;
    const had = publicMessageHits.has(key);
    return { key, had, value: had ? cloneMessageRecord(publicMessageHits.get(key)) : null };
  }

  function restorePublicMessageDecision(snapshot) {
    if (!snapshot || !snapshot.key) return;
    if (snapshot.had) publicMessageHits.set(snapshot.key, cloneMessageRecord(snapshot.value));
    else publicMessageHits.delete(snapshot.key);
  }

  function publicMessageDecision(req, token, text, file) {
    const ip = clientIp(req);
    const key = `${token}|${ip}`;
    const now = Date.now();
    if (!publicMessageHits.has(key) && publicMessageHits.size >= messageEntryLimit) {
      // Do not evict an active sender to make room for an unbounded stream of new
      // identities. Under saturation, fail closed and let the periodic sweep free
      // stale entries. This keeps the anti-spam state memory-bounded.
      return { duplicate:false, notify:false, retryAfter:1, overloaded:true };
    }

    const record = publicMessageHits.get(key) || { hits: [], lastHash: '', lastAt: 0, lastNotifyAt: 0 };
    record.hits = (Array.isArray(record.hits) ? record.hits : []).filter((timestamp) => now - timestamp < messageWindowMs);
    const hash = crypto.createHash('sha256').update(`${text}\n${file || ''}`).digest('hex');

    if (record.lastHash === hash && now - record.lastAt < messageDupMs) {
      publicMessageHits.set(key, record);
      return { duplicate: true, notify: false, retryAfter: 0 };
    }
    if (record.hits.length >= messageMax) {
      publicMessageHits.set(key, record);
      return {
        duplicate: false,
        notify: false,
        retryAfter: Math.max(1, Math.ceil((messageWindowMs - (now - record.hits[0])) / 1000)),
      };
    }

    record.hits.push(now);
    record.lastHash = hash;
    record.lastAt = now;
    const notify = now - record.lastNotifyAt >= notifyCooldownMs;
    if (notify) record.lastNotifyAt = now;
    publicMessageHits.set(key, record);
    return { duplicate: false, notify, retryAfter: 0 };
  }

  function publicRateRetryAfter(req) {
    const settings = getSettings() || {};
    if (!settings.publicRateLimit) return 0;
    const windowMs = Math.max(1, Math.floor(Number(settings.publicRateWindowMin) || 1)) * 60000;
    const max = Math.max(1, Math.floor(Number(settings.publicRateMax) || 600));
    const ip = clientIp(req);
    const now = Date.now();
    if (!publicHits.has(ip) && publicHits.size >= rateEntryLimit) return 1;
    const hits = (publicHits.get(ip) || []).filter((timestamp) => now - timestamp < windowMs);
    if (hits.length >= max) {
      publicHits.set(ip, hits);
      return Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000));
    }
    hits.push(now);
    publicHits.set(ip, hits);
    return 0;
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

  function powIpKey(req) {
    return maskIp(clientIp(req));
  }

  function powSign(parts) {
    const payload = `${powSecret.toString('hex')}.${parts.join('.')}`;
    return externalCrypto ? externalCrypto.hmac(payload, 'runtime-hmac') : crypto.createHmac('sha256', powSecret).update(parts.join('.')).digest('hex');
  }

  function powBits() {
    return Math.min(24, Math.max(8, Math.floor(Number((getSettings() || {}).challengeBits) || 16)));
  }

  function challengeRequired(sizeBytes) {
    const settings = getSettings() || {};
    if (!settings.challengeEnabled) return false;
    const min = Math.max(1, Math.floor(Number(settings.challengeMinMB) || 200)) * 1024 * 1024;
    return Number(sizeBytes) >= min;
  }

  function powSolutionOk(nonce, solution, bits) {
    const digest = crypto.createHash('sha256').update(String(nonce) + String(solution)).digest();
    let count = 0;
    for (const byte of digest) {
      if (byte === 0) {
        count += 8;
        continue;
      }
      count += Math.clz32(byte) - 24;
      break;
    }
    return count >= bits;
  }

  function createPowChallenge(req, now = Date.now()) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const bits = powBits();
    const exp = Math.floor(now + challengeTtlMs);
    return { nonce, bits, exp, sig:powSign([nonce, String(exp), String(bits), powIpKey(req)]) };
  }

  function verifyPowChallenge(req, payload, now = Date.now()) {
    const body = payload && typeof payload === 'object' ? payload : {};
    const nonce = body.nonce == null ? '' : String(body.nonce);
    const expText = body.exp == null ? '' : String(body.exp);
    const bitsText = body.bits == null ? '' : String(body.bits);
    const sig = body.sig == null ? '' : String(body.sig);
    // `0` is a legitimate candidate solution; do not collapse it to an empty
    // string with `value || ''` before hashing.
    const solution = body.sol == null ? '' : String(body.sol);
    if (!/^[0-9a-f]{32}$/i.test(nonce) || !/^\d{10,16}$/.test(expText)
      || !/^\d{1,2}$/.test(bitsText) || !/^[0-9a-f]{64}$/i.test(sig) || solution.length > 1024) {
      return { ok:false, error:'bad-request' };
    }
    const exp = Number(expText);
    const bits = Number(bitsText);
    if (!Number.isSafeInteger(exp) || !Number.isInteger(bits) || bits < 8 || bits > 24) return { ok:false, error:'bad-request' };
    if (now > exp) return { ok:false, error:'expired' };
    if (!timingSafeEqualStr(sig, powSign([nonce, expText, bitsText, powIpKey(req)]))) return { ok:false, error:'bad-sig' };
    if (!powSolutionOk(nonce, solution, bits)) return { ok:false, error:'bad-solution' };
    return { ok:true };
  }

  function hasValidPow(req, now = Date.now()) {
    const cookie = parseCookies(req).dxpow;
    if (!cookie) return false;
    const dot = cookie.indexOf('.');
    if (dot < 0) return false;
    const exp = cookie.slice(0, dot);
    const sig = cookie.slice(dot + 1);
    if (!/^\d{10,16}$/.test(exp) || !/^[0-9a-f]{64}$/i.test(sig)) return false;
    const expiry = Number(exp);
    if (!Number.isSafeInteger(expiry) || now > expiry) return false;
    return timingSafeEqualStr(sig, powSign(['pass', exp, powIpKey(req)]));
  }

  function issuePowCookie(req, res, now = Date.now()) {
    const exp = Math.floor(now + passTtlMs);
    const value = exp + '.' + powSign(['pass', String(exp), powIpKey(req)]);
    appendSetCookie(res, `dxpow=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.ceil(passTtlMs / 1000))}${secureCookie(req)}`);
  }

  function challengeGateZip(req, res) {
    const settings = getSettings() || {};
    if (settings.challengeEnabled && req.method === 'GET' && !hasValidPow(req)) {
      if (typeof challengePage !== 'function' || typeof pickLang !== 'function') {
        throw new TypeError('public-abuse-service requires challengePage and pickLang for ZIP challenge gating');
      }
      res.status(200).type('html').send(challengePage(pickLang(req)));
      return true;
    }
    return false;
  }

  function cleanup(now = Date.now()) {
    const settings = getSettings() || {};
    const windowMs = Math.max(1, Math.floor(Number(settings.publicRateWindowMin) || 1)) * 60000;
    for (const [ip, hits] of publicHits) {
      const keep = (Array.isArray(hits) ? hits : []).filter((timestamp) => now - timestamp < windowMs);
      if (keep.length) publicHits.set(ip, keep);
      else publicHits.delete(ip);
    }
    for (const [key, record] of publicMessageHits) {
      record.hits = (Array.isArray(record.hits) ? record.hits : []).filter((timestamp) => now - timestamp < messageWindowMs);
      if (record.hits.length || now - (record.lastAt || 0) < messageDupMs) publicMessageHits.set(key, record);
      else publicMessageHits.delete(key);
    }
    if (typeof pruneLeakTrackers === 'function') pruneLeakTrackers();
  }

  function clearRuntimeState() {
    publicHits.clear();
    publicMessageHits.clear();
    // Proof-of-work challenges/pass cookies are tied to transient runtime
    // security state. Rotate the key after a state restore so credentials issued
    // by the pre-restore world cannot authorize requests in the restored world.
    powSecret = null;
    powSecret = crypto.randomBytes(32);
  }

  const timer = setInterval(cleanup, Math.max(1000, Math.floor(Number(cleanupIntervalMs) || 60000)));
  if (timer && typeof timer.unref === 'function') timer.unref();

  function close() {
    clearInterval(timer);
    publicHits.clear();
    publicMessageHits.clear();
  }

  return {
    snapshotPublicMessageDecision,
    restorePublicMessageDecision,
    publicMessageDecision,
    publicRateRetryAfter,
    powIpKey,
    powSign,
    powBits,
    challengeRequired,
    powSolutionOk,
    createPowChallenge,
    verifyPowChallenge,
    hasValidPow,
    issuePowCookie,
    challengeGateZip,
    cleanup,
    clearRuntimeState,
    close,
    publicMessageDupMs: messageDupMs,
    maxPublicRateEntries: rateEntryLimit,
    maxPublicMessageEntries: messageEntryLimit,
  };
}

module.exports = { createPublicAbuseService };
