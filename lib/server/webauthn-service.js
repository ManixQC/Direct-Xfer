'use strict';

const fs = require('fs');
const path = require('path');
const { createExternalCryptoProvider } = require('./external-crypto-provider');

/**
 * WebAuthn/passkey domain for the PWA. Challenge maps and FIDO2 parsing live
 * here instead of in the server composition root.
 */
function createWebauthnService(deps = {}) {
  const { APP_NAME, PUBLIC_URL, crypto, getSession, getAccountById, pwaDevices, timingSafeEqualStr } = deps;
  const asvsL3Mode = deps.ASVS_L3_MODE === true;
  const normalizeHex = (value) => String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  const l3HardwareAaguids = new Set(String(deps.ASVS_L3_HARDWARE_AAGUIDS || '').split(/[\s,;]+/).map(normalizeHex).filter((v) => /^[a-f0-9]{32}$/.test(v) && !/^0+$/.test(v)));
  const l3AttestationRoots = new Set(String(deps.ASVS_L3_ATTESTATION_ROOT_SHA256 || '').split(/[\s,;]+/).map(normalizeHex).filter((v) => /^[a-f0-9]{64}$/.test(v)));
  const l3AttestationRootFiles = String(deps.ASVS_L3_ATTESTATION_ROOT_FILES || '').split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean);
  const l3TrustedAttestationRoots = new Map();
  if (asvsL3Mode && l3AttestationRootFiles.length) {
    for (const file of l3AttestationRootFiles) {
      const pem = fs.readFileSync(path.resolve(file), 'utf8');
      const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (!blocks.length) throw new Error('attestation-root-certificate-missing');
      for (const block of blocks) {
        const cert = new crypto.X509Certificate(block);
        const fingerprint = normalizeHex(cert.fingerprint256);
        if (!l3AttestationRoots.has(fingerprint)) continue;
        if (cert.ca !== true) throw new Error('attestation-root-not-ca');
        l3TrustedAttestationRoots.set(fingerprint, cert);
      }
    }
  }
  const l3CryptoProvider = asvsL3Mode ? createExternalCryptoProvider({ command:deps.ASVS_L3_CRYPTO_COMMAND }) : null;
  if (asvsL3Mode && !l3CryptoProvider) throw new TypeError('webauthn-service requires isolated L3 crypto provider');
  if (!crypto || typeof crypto.createPublicKey !== 'function') throw new TypeError('webauthn-service requires crypto');
  const WEBAUTHN_CHALLENGE_TTL = 5 * 60 * 1000;
  const PASSKEY_MANAGEMENT_FRESH_MS = 10 * 60 * 1000;
  const MIN_RSA_MODULUS_BITS = 3072;
  const webauthnRegChallenges = new Map();
  const webauthnLoginChallenges = new Map();
function pruneWebauthnChallenges() {
  const now = Date.now();
  for (const [k, v] of webauthnRegChallenges) if (now - v.at > WEBAUTHN_CHALLENGE_TTL) webauthnRegChallenges.delete(k);
  for (const [k, v] of webauthnLoginChallenges) if (now - v.at > WEBAUTHN_CHALLENGE_TTL) webauthnLoginChallenges.delete(k);
  if (webauthnRegChallenges.size > 500) webauthnRegChallenges.clear();
  if (webauthnLoginChallenges.size > 500) webauthnLoginChallenges.clear();
}

function clearWebauthnChallengesForAccount(accountId) {
  const wanted = String(accountId || '');
  if (!wanted) return;
  for (const [token, value] of webauthnRegChallenges) {
    if (String(value && value.accountId || '') === wanted) webauthnRegChallenges.delete(token);
  }
  for (const [token, value] of webauthnLoginChallenges) {
    if (String(value && value.accountId || '') === wanted) webauthnLoginChallenges.delete(token);
  }
}

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function fromB64u(str) { return Buffer.from(String(str || ''), 'base64url'); }

// Anti-enumeration for username-scoped passkey login (ASVS V6.3.8). Unknown,
// keyless or ineligible usernames receive a deterministic phantom credential list
// so the options response is indistinguishable from a real account's. The ids are
// stable per username (within the process) and match no authenticator, so the
// ceremony fails exactly like a wrong passkey; a fresh non-empty allowCredentials
// also prevents the browser from silently selecting a different resident passkey.
let phantomCredentialSecret = null;
const LOGIN_ALLOW_CREDENTIALS_COUNT = 20;
function phantomAllowCredentials(username, count = LOGIN_ALLOW_CREDENTIALS_COUNT, offset = 0) {
  if (!phantomCredentialSecret) phantomCredentialSecret = crypto.randomBytes(32);
  const normalized = String(username == null ? '' : username).trim().toLowerCase();
  const wanted = Math.max(0, Math.min(LOGIN_ALLOW_CREDENTIALS_COUNT, Number(count) || 0));
  const start = Math.max(0, Number(offset) || 0);
  const out = [];
  for (let index = 0; index < wanted; index += 1) {
    const material = `webauthn-phantom:${phantomCredentialSecret.toString('hex')}:${normalized}:${start + index}`;
    const id = asvsL3Mode
      ? Buffer.from(l3CryptoProvider.hmac(material, 'runtime-hmac'), 'hex')
      : crypto.createHmac('sha256', phantomCredentialSecret).update(material).digest();
    out.push({ type:'public-key', id:b64u(id) });
  }
  return out;
}

function webauthnRp(req) {
  if (PUBLIC_URL) { try { const u = new URL(PUBLIC_URL); return { id: u.hostname, origin: u.origin, name: APP_NAME }; } catch (_) {} }
  const host = String(req.headers.host || '').split(',')[0].trim() || 'localhost';
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return { id: host.replace(/:\d+$/, ''), origin: `${proto}://${host}`, name: APP_NAME };
}

function cborDecode(buf) {
  let off = 0;
  function len(info) {
    if (info < 24) return info;
    if (info === 24) return buf[off++];
    if (info === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(off)); off += 8; return v; }
    throw new Error('cbor-len');
  }
  function read() {
    const first = buf[off++], major = first >> 5, info = first & 0x1f;
    if (major === 0) return len(info);
    if (major === 1) return -1 - len(info);
    if (major === 2) { const n = len(info); const b = buf.subarray(off, off + n); off += n; return b; }
    if (major === 3) { const n = len(info); const s = buf.subarray(off, off + n).toString('utf8'); off += n; return s; }
    if (major === 4) { const n = len(info); const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
    if (major === 5) { const n = len(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = read(); m.set(k, read()); } return m; }
    if (major === 7) { if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; if (info === 23) return undefined; throw new Error('cbor-simple'); }
    throw new Error('cbor-major');
  }
  const value = read();
  return { value, bytesRead: off };
}

function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw new Error('cose');
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2) {
    const crv = cose.get(-1), x = cose.get(-2), y = cose.get(-3);
    const crvName = crv === 1 ? 'P-256' : crv === 2 ? 'P-384' : crv === 3 ? 'P-521' : null;
    if (!crvName || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('cose-ec');
    return { jwk: { kty: 'EC', crv: crvName, x: b64u(x), y: b64u(y) }, alg };
  }
  if (kty === 3) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('cose-rsa');
    return { jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) }, alg };
  }
  throw new Error('cose-kty');
}

function webauthnParseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new Error('authdata');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  out.up = !!(out.flags & 0x01); out.uv = !!(out.flags & 0x04);
  // Backup-eligible credentials are multi-device passkeys. Their signature
  // counter is not guaranteed to increase globally because each synchronized
  // authenticator can keep its own value.
  out.be = !!(out.flags & 0x08); out.bs = !!(out.flags & 0x10); out.at = !!(out.flags & 0x40);
  if (out.bs && !out.be) throw new Error('backup-state');
  if (out.at) {
    out.aaguid = buf.subarray(37, 53).toString('hex');
    let off = 37 + 16; // skip aaguid
    const credIdLen = buf.readUInt16BE(off); off += 2;
    out.credId = buf.subarray(off, off + credIdLen); off += credIdLen;
    out.cose = cborDecode(buf.subarray(off)).value;
  }
  return out;
}

function webauthnPublicKey(jwk, alg) {
  if (alg === -7) {
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('algorithm-key-mismatch');
  } else if (alg === -257) {
    if (!jwk || jwk.kty !== 'RSA') throw new Error('algorithm-key-mismatch');
  } else {
    throw new Error('algorithm');
  }
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (alg === -257) {
    const bits = Number(key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength || 0);
    // ASVS L3 targets roughly 128-bit classical strength. RSA-2048 is below
    // that target, so new/used RS256 passkeys must provide at least RSA-3072.
    if (!bits || bits < MIN_RSA_MODULUS_BITS) throw new Error('rsa-key-too-small');
  }
  return key;
}

function webauthnVerifySignature(jwk, alg, signedData, signature) {
  const key = webauthnPublicKey(jwk, alg);
  // ES* signatures are DER-encoded (Node's default for EC verify); RS* are PKCS#1.
  return crypto.verify('sha256', signedData, key, signature);
}


function assertCertificateCurrentlyValid(cert, label) {
  const now = Date.now();
  const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > now + 5 * 60 * 1000 || to <= now) throw new Error(`${label}-certificate-expired-or-not-yet-valid`);
}

function assertAttestationKeyMatchesAlg(key, alg) {
  const type = String(key && key.asymmetricKeyType || '');
  const details = key && key.asymmetricKeyDetails || {};
  if (alg === -7) {
    if (type !== 'ec' || !['prime256v1','secp256r1'].includes(String(details.namedCurve || '').toLowerCase())) throw new Error('attestation-algorithm-key-mismatch');
    return;
  }
  if (alg === -257) {
    if (!['rsa','rsa-pss'].includes(type) || Number(details.modulusLength || 0) < MIN_RSA_MODULUS_BITS) throw new Error('attestation-algorithm-key-mismatch');
    return;
  }
  throw new Error('attestation-algorithm-invalid');
}

function resolveTrustedAttestationRoot(chain) {
  if (!chain.length) throw new Error('attestation-chain-empty');
  const last = chain[chain.length - 1];
  const lastFingerprint = normalizeHex(last.fingerprint256);
  if (l3TrustedAttestationRoots.has(lastFingerprint)) return { cert:l3TrustedAttestationRoots.get(lastFingerprint), fingerprint:lastFingerprint };
  for (const [fingerprint, root] of l3TrustedAttestationRoots) {
    try {
      if (String(last.issuer || '') === String(root.subject || '') && last.verify(root.publicKey)) return { cert:root, fingerprint };
    } catch (_) {}
  }
  throw new Error('attestation-root-not-allowed');
}

function verifyL3HardwareAttestation(attestation, authDataRaw, clientDataHash, parsed, transports) {
  if (!asvsL3Mode) return { hardwareBacked:false };
  if (!attestation || !(attestation instanceof Map)) throw new Error('attestation-format');
  if (!l3HardwareAaguids.size || !l3AttestationRoots.size || !l3TrustedAttestationRoots.size) throw new Error('hardware-attestation-policy-missing');
  const aaguid = normalizeHex(parsed && parsed.aaguid);
  if (!aaguid || !l3HardwareAaguids.has(aaguid)) throw new Error('hardware-aaguid-not-allowed');
  if (parsed && parsed.be) throw new Error('syncable-passkey-not-hardware-bound');
  const transportList = passkeyTransports(transports); // informational only; hardware trust comes from attestation/AAGUID, not client-supplied transports
  const fmt = String(attestation.get('fmt') || '');
  const stmt = attestation.get('attStmt');
  if (fmt !== 'packed' || !(stmt instanceof Map)) throw new Error('packed-attestation-required');
  const alg = Number(stmt.get('alg'));
  const sig = stmt.get('sig');
  const chainRaw = stmt.get('x5c');
  if ((alg !== -7 && alg !== -257) || !Buffer.isBuffer(sig) || !Array.isArray(chainRaw) || !chainRaw.length || !chainRaw.every(Buffer.isBuffer)) throw new Error('attestation-statement-invalid');
  const chain = chainRaw.map((der) => new crypto.X509Certificate(der));
  if (chain[0].ca === true) throw new Error('attestation-leaf-must-not-be-ca');
  for (const cert of chain) assertCertificateCurrentlyValid(cert, 'attestation');
  for (let i = 0; i + 1 < chain.length; i += 1) {
    if (chain[i + 1].ca !== true) throw new Error('attestation-intermediate-not-ca');
    if (String(chain[i].issuer || '') !== String(chain[i + 1].subject || '') || !chain[i].verify(chain[i + 1].publicKey)) throw new Error('attestation-chain-invalid');
  }
  assertAttestationKeyMatchesAlg(chain[0].publicKey, alg);
  const trustedRoot = resolveTrustedAttestationRoot(chain);
  assertCertificateCurrentlyValid(trustedRoot.cert, 'attestation-root');
  const signed = Buffer.concat([Buffer.from(authDataRaw), Buffer.from(clientDataHash)]);
  if (!crypto.verify('sha256', signed, chain[0].publicKey, sig)) throw new Error('attestation-signature-invalid');
  return { hardwareBacked:true, aaguid, attestationRootSha256:trustedRoot.fingerprint, transports:transportList };
}

function l3HardwarePasskeyAllowed(passkey) {
  if (!asvsL3Mode) return true;
  if (!passkey || passkey.hardwareBacked !== true || passkey.backupEligible === true) return false;
  return l3HardwareAaguids.has(normalizeHex(passkey.aaguid)) && l3AttestationRoots.has(normalizeHex(passkey.attestationRootSha256));
}

function freshPasskeyManagementAccount(req, res) {
  const session = req.pwaSession || getSession(req);
  const now = Date.now();
  if (!session || !session.authenticatedAt || now - session.authenticatedAt > PASSKEY_MANAGEMENT_FRESH_MS) {
    res.status(401).json({ error: 'recent-auth-required' });
    return null;
  }
  const acc = session.accountId ? getAccountById(session.accountId) : null;
  if (!acc || !['owner', 'admin', 'operator'].includes(acc.role)) {
    res.status(403).json({ error: 'role-forbidden' });
    return null;
  }
  // L3 has no lost-factor recovery path. Initial enrollment may bootstrap the first
  // approved hardware authenticator from a fresh primary-factor session. As soon as
  // one L3 hardware passkey has ever been enrolled, factor management is permanently
  // locked behind a recent phishing-resistant passkey session; deleting the last
  // hardware passkey is also refused by the routes below.
  if (asvsL3Mode) {
    const hasApprovedHardware = accountPasskeys(acc).some((p) => l3HardwarePasskeyAllowed(p));
    const enrollmentLocked = acc.l3HardwarePasskeyEnrolled === true || hasApprovedHardware;
    if (hasApprovedHardware && acc.l3HardwarePasskeyEnrolled !== true) acc.l3HardwarePasskeyEnrolled = true;
    if (enrollmentLocked) {
      const strongAt = Number(session.strongAuthAt) || Number(session.authenticatedAt) || 0;
      if (session.phishingResistant !== true || session.authMethod !== 'passkey' || !strongAt || now - strongAt > PASSKEY_MANAGEMENT_FRESH_MS) {
        res.status(401).json({ error:'reauth-required' });
        return null;
      }
    }
  }
  return acc;
}

function accountPasskeys(acc) { return Array.isArray(acc && acc.passkeys) ? acc.passkeys : []; }

function passkeyTransports(value) {
  const allowed = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);
  return [...new Set((Array.isArray(value) ? value : []).map((v) => String(v || '').toLowerCase()).filter((v) => allowed.has(v)))].slice(0, 6);
}

function passkeyDeviceIds(passkey) {
  if (!passkey || typeof passkey !== 'object') return [];
  const raw = Array.isArray(passkey.deviceIds) ? passkey.deviceIds.slice() : [];
  if (passkey.deviceId) raw.push(passkey.deviceId); // legacy 1.48.1 record
  return [...new Set(raw.map((id) => String(id || '')).filter((id) => /^[a-f0-9]{24}$/i.test(id)))].slice(0, 30);
}

function passkeyBoundToDevice(passkey, deviceId) {
  if (!deviceId) return false;
  return passkeyDeviceIds(passkey).some((id) => timingSafeEqualStr(id, String(deviceId)));
}

function bindPasskeyToDevice(passkey, deviceId) {
  if (!passkey || !deviceId || !/^[a-f0-9]{24}$/i.test(String(deviceId))) return false;
  const ids = passkeyDeviceIds(passkey);
  if (ids.some((id) => timingSafeEqualStr(id, String(deviceId)))) return false;
  ids.push(String(deviceId));
  passkey.deviceIds = ids.slice(-30);
  if (!passkey.deviceId) passkey.deviceId = String(deviceId);
  return true;
}

function publicPasskey(p, currentDeviceId) {
  const deviceIds = passkeyDeviceIds(p);
  const devices = deviceIds.map((id) => {
    const device = pwaDevices().find((row) => row && timingSafeEqualStr(String(row.id || ''), String(id))) || null;
    return {
      id,
      name:device ? (device.name || 'Direct-Xfer PWA') : 'Appareil révoqué',
      platform:device ? (device.platform || device.userAgent || null) : null,
      createdAt:device ? Math.max(0, Number(device.createdAt) || 0) : 0,
      lastUsedAt:device ? Math.max(0, Number(device.lastUsedAt) || 0) : 0,
      current:!!(currentDeviceId && timingSafeEqualStr(String(id), String(currentDeviceId))),
      available:!!device,
    };
  });
  return {
    id: p.id,
    name: p.name || 'Biometrics',
    createdAt: p.createdAt || 0,
    lastUsedAt: p.lastUsedAt || 0,
    currentDevice: passkeyBoundToDevice(p, currentDeviceId),
    deviceCount: deviceIds.length,
    devices,
  };
}

function unbindPasskeyDevice(passkey, deviceId) {
  if (!passkey || !deviceId) return false;
  const before = passkeyDeviceIds(passkey), next = before.filter((id) => !timingSafeEqualStr(String(id), String(deviceId)));
  if (next.length === before.length) return false;
  passkey.deviceIds = next;
  if (passkey.deviceId && timingSafeEqualStr(String(passkey.deviceId), String(deviceId))) passkey.deviceId = next[0] || null;
  if (!passkey.deviceId) delete passkey.deviceId;
  return true;
}

  function clearRuntimeState() {
    webauthnRegChallenges.clear();
    webauthnLoginChallenges.clear();
  }
  return {
    WEBAUTHN_CHALLENGE_TTL, PASSKEY_MANAGEMENT_FRESH_MS, MIN_RSA_MODULUS_BITS, LOGIN_ALLOW_CREDENTIALS_COUNT,
    webauthnRegChallenges, webauthnLoginChallenges,
    pruneWebauthnChallenges, clearWebauthnChallengesForAccount, b64u, fromB64u, phantomAllowCredentials,
    webauthnRp, cborDecode, coseToJwk, webauthnParseAuthData, webauthnPublicKey,
    webauthnVerifySignature, verifyL3HardwareAttestation, l3HardwarePasskeyAllowed, freshPasskeyManagementAccount, accountPasskeys,
    passkeyTransports, passkeyDeviceIds, passkeyBoundToDevice, bindPasskeyToDevice,
    publicPasskey, unbindPasskeyDevice, clearRuntimeState,
  };
}

module.exports = { createWebauthnService };
