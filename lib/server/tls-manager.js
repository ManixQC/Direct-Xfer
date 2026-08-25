'use strict';

/**
 * Managed TLS / Local CA subsystem.
 * Owns certificate generation, validation, renewal and live HTTPS context state.
 */
function createTlsManager(deps) {
  const { fs, path, crypto, os, net, tls, forge, bool, isPrivateIp, BIND, DATA_DIR, PUBLIC_HOST, PUBLIC_URL, LOCAL_IP, getState } = deps;
  const ASVS_L3_MODE = deps.ASVS_L3_MODE === true;
  const TLS_MIN_VERSION = 'TLSv1.2';
  // The main server can replace its state object during backup restore. Proxying
  // reads keeps the TLS settings lookup attached to the current state object.
  const state = new Proxy({}, { get(_target, prop) { const current = getState(); return current && current[prop]; } });

const TLS_CERT = (process.env.TLS_CERT || '').trim();
const TLS_KEY = (process.env.TLS_KEY || '').trim();
const TLS_SELF_SIGNED_ENV_SET = Object.prototype.hasOwnProperty.call(process.env, 'TLS_SELF_SIGNED');
const TLS_SELF_SIGNED_ENV = bool(process.env.TLS_SELF_SIGNED);
const TLS_DAY_MS = 86400000;
const TLS_LEAF_VALIDITY_MS = 90 * TLS_DAY_MS;
const TLS_LEAF_RENEW_MS = 14 * TLS_DAY_MS;
const TLS_REFRESH_INTERVAL_MS = 60 * 1000;
let ACTIVE_TLS_MODE = 'http'; // http | provided | local-ca | local-ca-degraded
let activeTlsLeafFingerprint = '';
let activeTlsLeafExpiresAt = 0;
let activeTlsLeafPem = ''; // exact leaf certificate currently loaded in the HTTPS listener
let activeTlsCaFingerprint = '';
let activeTlsCaPem = '';
let activeProvidedTlsExpiresAt = 0;
let activeProvidedTlsMaterialFingerprint = '';
let tlsLeafRotationTimer = null;
let tlsCertificateRestartRequired = false;

function configuredSelfSignedTls() {
  if (TLS_SELF_SIGNED_ENV_SET) return TLS_SELF_SIGNED_ENV;
  try { return !!(state && state.settings && (state.settings.tlsLocalCa || state.settings.tlsSelfSigned)); }
  catch (_) { return false; }
}
function tlsManagedByEnvironment() { return !!(TLS_CERT || TLS_KEY || TLS_SELF_SIGNED_ENV_SET); }
function configuredHttpsEnabled() { return !!(TLS_CERT && TLS_KEY) || configuredSelfSignedTls(); }
function localCaModeActive() { return ACTIVE_TLS_MODE === 'local-ca' || ACTIVE_TLS_MODE === 'local-ca-degraded'; }
function localCaFeatureRelevant() {
  if (localCaModeActive()) return true;
  if (TLS_CERT && TLS_KEY) return false;
  return configuredSelfSignedTls();
}

function tlsDirPath() { return path.join(DATA_DIR, 'tls'); }
function localCaPaths() {
  const dir = tlsDirPath();
  return {
    dir,
    caCert:path.join(dir, 'local-ca-cert.pem'),
    caKey:path.join(dir, 'local-ca-key.pem'),
    serverCert:path.join(dir, 'server-cert.pem'),
    serverKey:path.join(dir, 'server-key.pem'),
    caGenerationMarker:path.join(dir, '.local-ca-generation-pending'),
  };
}
function ensureTlsDirectory(dir = tlsDirPath()) {
  fs.mkdirSync(dir, { recursive:true, mode:0o700 });
  if (process.platform !== 'win32') { try { fs.chmodSync(dir, 0o700); } catch (_) {} }
}
function readManagedTlsFile(file, encoding = null) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(path.basename(file) + ' is not a regular TLS file');
  if (st.size <= 0 || st.size > 2 * 1024 * 1024) throw new Error(path.basename(file) + ' has an invalid size');
  return fs.readFileSync(file, encoding || undefined);
}
function atomicPrivateWrite(file, data, mode) {
  const dir = path.dirname(file); ensureTlsDirectory(dir);
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, data);
    try { fs.fsyncSync(fd); } catch (_) {}
    fs.closeSync(fd); fd = null;
    try { fs.chmodSync(tmp, mode); } catch (_) {}
    if (process.platform === 'win32' && fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, mode); } catch (_) {}
    // Persist the directory entry as well where the platform supports fsync() on
    // directories. Certificate generation is rare, so durability wins over speed.
    if (process.platform !== 'win32') {
      let dfd = null;
      try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); } catch (_) {} finally { if (dfd !== null) try { fs.closeSync(dfd); } catch (_) {} }
    }
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
  }
}
function generateForgeRsaKeyPair(bits=3072) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength:bits, publicExponent:0x10001 });
  const privatePem = pair.privateKey.export({ type:'pkcs1', format:'pem' }).toString();
  const publicPem = pair.publicKey.export({ type:'pkcs1', format:'pem' }).toString();
  return { privateKey:forge.pki.privateKeyFromPem(privatePem), publicKey:forge.pki.publicKeyFromPem(publicPem), privatePem, publicPem };
}
function randomCertSerial() {
  const b = crypto.randomBytes(16); b[0] &= 0x7f; if (b.every((v) => v === 0)) b[15] = 1;
  return b.toString('hex');
}
function certificateFingerprint256(pem) {
  try { return new crypto.X509Certificate(pem).fingerprint256 || ''; } catch (_) { return ''; }
}
function tlsMaterialFingerprint(cert, key) {
  try {
    const h = crypto.createHash('sha256');
    h.update(Buffer.isBuffer(cert) ? cert : Buffer.from(String(cert || '')));
    h.update(Buffer.from([0]));
    h.update(Buffer.isBuffer(key) ? key : Buffer.from(String(key || '')));
    return h.digest('hex');
  } catch (_) { return ''; }
}
function canonicalCertificateIp(ip) {
  const raw = String(ip || '').trim().replace(/^::ffff:/i, '').split('%')[0].replace(/^\[|\]$/g, '');
  if (!raw || !net.isIP(raw)) return '';
  if (net.isIP(raw) === 4) return raw;
  try {
    const host = new URL('http://[' + raw + ']/').hostname;
    return String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  } catch (_) { return raw.toLowerCase(); }
}
function isLanCertificateIp(ip) {
  const v = canonicalCertificateIp(ip);
  if (!v || !net.isIP(v)) return false;
  return isPrivateIp(v) || /^fe[89ab][0-9a-f]:/i.test(v);
}
function normalizeLanCertificateIp(ip) {
  const v = canonicalCertificateIp(ip);
  return isLanCertificateIp(v) ? v : '';
}
function isLanCertificateHostname(name) {
  const h = String(name || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253 || !/^[a-z0-9][a-z0-9.-]*$/i.test(h) || h.includes('..') || h.startsWith('.') || h.endsWith('.')) return false;
  if (!h.includes('.')) return true;
  return /(?:\.local|\.lan|\.home|\.internal|\.localdomain|\.home\.arpa)$/i.test(h);
}
function configuredLanCertificateHostname() {
  const candidates = [];
  if (PUBLIC_URL) { try { candidates.push(String(new URL(PUBLIC_URL).hostname || '').replace(/^\\[|\\]$/g, '')); } catch (_) {} }
  if (PUBLIC_HOST) {
    let h = String(PUBLIC_HOST).trim();
    if (h.startsWith('[')) { const end = h.indexOf(']'); if (end > 0) h = h.slice(1, end); }
    else if ((h.match(/:/g) || []).length === 1) h = h.split(':', 1)[0];
    candidates.push(h);
  }
  for (const raw of candidates) {
    const h = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
    if (isLanCertificateHostname(h)) return h;
  }
  return '';
}
function configuredLanCertificateIp() {
  const candidates = [];
  if (PUBLIC_URL) { try { candidates.push(String(new URL(PUBLIC_URL).hostname || '').replace(/^\\[|\\]$/g, '')); } catch (_) {} }
  if (PUBLIC_HOST) {
    let h = String(PUBLIC_HOST).trim();
    if (h.startsWith('[')) { const end = h.indexOf(']'); if (end > 0) h = h.slice(1, end); }
    else if ((h.match(/:/g) || []).length === 1) h = h.split(':', 1)[0];
    candidates.push(h);
  }
  for (const raw of candidates) { const ip = normalizeLanCertificateIp(raw); if (ip) return ip; }
  return '';
}
function localTlsIdentities() {
  const dns = new Set(['localhost']);
  const ips = new Set(['127.0.0.1', '::1']);
  const configuredHost = configuredLanCertificateHostname();
  if (configuredHost) { dns.add(configuredHost); if (!configuredHost.includes('.')) dns.add(configuredHost + '.local'); }
  // LOCAL_IP is commonly supplied to containers whose os.hostname() is an
  // ephemeral container ID. Do not encode that ID into the certificate: it
  // would cause a needless leaf rotation on every container recreation.
  if (!LOCAL_IP) {
    const host = String(os.hostname() || '').trim().toLowerCase();
    if (isLanCertificateHostname(host)) { dns.add(host); if (!host.includes('.')) dns.add(host + '.local'); }
  }
  const addIp = (value) => { const ip = normalizeLanCertificateIp(value); if (ip) ips.add(ip); };
  addIp(configuredLanCertificateIp());
  if (LOCAL_IP) addIp(LOCAL_IP);
  const wildcard = BIND === '0.0.0.0' || BIND === '::';
  if (!wildcard) addIp(BIND);
  else if (!LOCAL_IP) {
    // LOCAL_IP is an explicit operator override (especially important behind a
    // Docker bridge). When it is supplied, do not leak/retain unrelated private
    // interface addresses in the certificate SAN list.
    for (const entries of Object.values(os.networkInterfaces() || {})) {
      for (const item of entries || []) {
        // Windows frequently exposes temporary/privacy IPv6 addresses whose set
        // changes while the process is running. Encoding every one of them in the
        // leaf SAN makes an otherwise healthy Local-CA certificate look stale and
        // can trigger repeated RSA leaf rotation. Auto-discover stable LAN IPv4
        // addresses only; explicit PUBLIC_URL/PUBLIC_HOST values can still request
        // a specific IPv6 identity.
        if (item && !item.internal && net.isIP(String(item.address || '')) === 4) addIp(item.address);
      }
    }
  }
  return { dns:[...dns].sort(), ips:[...ips].sort() };
}
function certKeyMatches(cert, key) {
  try {
    const pub = cert.publicKey;
    return !!(pub && key && pub.n && key.n && pub.e && key.e && pub.n.compareTo(key.n) === 0 && pub.e.compareTo(key.e) === 0);
  } catch (_) { return false; }
}
function forgeDnEqual(a, b) {
  try {
    const norm = (x) => (x && x.attributes || []).map((v) => [String(v.type || v.name || ''), String(v.value || '')]);
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  } catch (_) { return false; }
}
function rsaPublicKeyBits(key) {
  try { return key && key.n && typeof key.n.bitLength === 'function' ? Number(key.n.bitLength()) : 0; }
  catch (_) { return 0; }
}
function strongRsaCertificateSignature(cert) {
  const oid = String(cert && cert.signatureOid || '');
  return oid === forge.pki.oids.sha256WithRSAEncryption || oid === forge.pki.oids.sha384WithRSAEncryption || oid === forge.pki.oids.sha512WithRSAEncryption;
}
function validateLocalCaCertificate(cert, key = null) {
  const now = Date.now();
  if (cert.validity.notBefore.getTime() > now + 5 * 60000) throw new Error('CA certificate is not valid yet');
  if (cert.validity.notAfter.getTime() <= now) throw new Error('CA certificate has expired');
  if (rsaPublicKeyBits(cert.publicKey) < (ASVS_L3_MODE ? 3072 : 2048)) throw new Error(`CA RSA key is weaker than ${ASVS_L3_MODE ? 3072 : 2048} bits`);
  if (!strongRsaCertificateSignature(cert)) throw new Error('CA certificate uses an unsupported or weak signature algorithm');
  const bc = cert.getExtension('basicConstraints');
  if (!bc || bc.cA !== true) throw new Error('certificate is not a CA');
  if (bc.pathLenConstraint !== undefined && Number(bc.pathLenConstraint) !== 0) throw new Error('CA path length is not restricted to leaf certificates');
  const ku = cert.getExtension('keyUsage');
  if (!ku || ku.keyCertSign !== true) throw new Error('CA certificate cannot sign certificates');
  if (!forgeDnEqual(cert.subject, cert.issuer)) throw new Error('CA certificate is not self-issued');
  try { if (!cert.verify(cert)) throw new Error('invalid self-signature'); }
  catch (e) { throw new Error('CA self-signature is invalid' + (e && e.message ? ': ' + e.message : '')); }
  if (key && !certKeyMatches(cert, key)) throw new Error('certificate/private key mismatch');
}
function readLocalCaCertificateOnly() {
  const p = localCaPaths();
  const certPem = readManagedTlsFile(p.caCert, 'utf8');
  const cert = forge.pki.certificateFromPem(certPem);
  validateLocalCaCertificate(cert, null);
  return { certPem, cert, fingerprint:certificateFingerprint256(certPem), expiresAt:cert.validity.notAfter.getTime(), paths:p };
}
function ensureLocalCa() {
  if (!forge) throw new Error('local CA HTTPS is enabled but node-forge is unavailable');
  const p = localCaPaths(); ensureTlsDirectory(p.dir);
  // CA creation spans two files. A marker makes an interrupted *initial*
  // generation recoverable without mistaking a half-published pair for a
  // previously trusted CA that lost one of its files.
  if (fs.existsSync(p.caGenerationMarker)) {
    console.warn('[tls] recovering an interrupted Local CA generation transaction.');
    for (const file of [p.caCert, p.caKey]) { try { fs.unlinkSync(file); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; } }
    try { fs.unlinkSync(p.caGenerationMarker); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  }
  const haveCert = fs.existsSync(p.caCert), haveKey = fs.existsSync(p.caKey);
  if (haveCert || haveKey) {
    if (!haveCert) { const e = new Error('Direct-Xfer Local CA certificate is missing; restore it from an encrypted Direct-Xfer backup'); e.code='LOCAL_CA_CERT_MISSING'; throw e; }
    if (!haveKey) { const e = new Error('Direct-Xfer Local CA private key is missing; restore it from an encrypted Direct-Xfer backup before certificate renewal'); e.code='LOCAL_CA_KEY_MISSING'; throw e; }
    try {
      const certPem = readManagedTlsFile(p.caCert, 'utf8');
      const keyPem = readManagedTlsFile(p.caKey, 'utf8');
      const cert = forge.pki.certificateFromPem(certPem);
      const key = forge.pki.privateKeyFromPem(keyPem);
      validateLocalCaCertificate(cert, key);
      return { certPem, keyPem, cert, key, fingerprint:certificateFingerprint256(certPem), expiresAt:cert.validity.notAfter.getTime(), paths:p };
    } catch (e) {
      if (e && e.code) throw e;
      throw new Error('Direct-Xfer Local CA is invalid: ' + e.message);
    }
  }
  // Long-lived trust anchor; stronger RSA key and pathLen=0 so it can only sign leaves.
  const keys = generateForgeRsaKeyPair(3072);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = randomCertSerial();
  cert.validity.notBefore = new Date(Date.now() - 5 * 60000);
  cert.validity.notAfter = new Date(Date.now() + 3650 * TLS_DAY_MS);
  const attrs = [
    { name:'commonName', value:'Direct-Xfer Local CA' },
    { name:'organizationName', value:'Direct-Xfer' },
    { name:'organizationalUnitName', value:'Local Network' },
  ];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([
    { name:'basicConstraints', cA:true, pathLenConstraint:0, critical:true },
    { name:'keyUsage', keyCertSign:true, cRLSign:true, critical:true },
    { name:'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert), keyPem = keys.privatePem;
  // Publish the pair under a durable transaction marker. ensureLocalCa() will
  // discard and regenerate this unpublished pair after a power loss/crash.
  atomicPrivateWrite(p.caGenerationMarker, JSON.stringify({pid:process.pid,at:Date.now()}) + '\n', 0o600);
  atomicPrivateWrite(p.caKey, keyPem, 0o600);
  atomicPrivateWrite(p.caCert, certPem, 0o644);
  validateLocalCaCertificate(forge.pki.certificateFromPem(certPem), forge.pki.privateKeyFromPem(keyPem));
  fs.unlinkSync(p.caGenerationMarker);
  console.log('[tls] generated Direct-Xfer Local CA (trust this root once on LAN clients).');
  return { certPem, keyPem, cert, key:keys.privateKey, fingerprint:certificateFingerprint256(certPem), expiresAt:cert.validity.notAfter.getTime(), paths:p };
}
function sanSets(cert) {
  const san = cert.getExtension('subjectAltName');
  const names = new Set(), ips = new Set();
  for (const alt of (san && san.altNames) || []) {
    if (alt.type === 2 && alt.value) names.add(String(alt.value).toLowerCase());
    if (alt.type === 7 && (alt.ip || alt.value)) {
      const normalized = canonicalCertificateIp(alt.ip || alt.value);
      if (normalized) ips.add(normalized);
    }
  }
  return { names, ips };
}
function exactSetEquals(required, actual) { return required.length === actual.size && required.every((v) => actual.has(String(v).toLowerCase())); }
function validateLeafCertificate(cert, key, caCert, identities = null, renewalCheck = true, requireAki = true) {
  const now = Date.now();
  if (!certKeyMatches(cert, key)) throw new Error('server certificate/private key mismatch');
  // ASVS V11.2.3: the managed TLS leaf must provide ~128-bit strength (RSA-3072+).
  // A legacy 2048-bit leaf fails here and is transparently regenerated at 3072 by
  // ensureLocalServerCertificate (existingLeafMatches treats it as not-matching).
  if (rsaPublicKeyBits(cert.publicKey) < 3072) throw new Error('server certificate RSA key is weaker than 3072 bits');
  if (!strongRsaCertificateSignature(cert)) throw new Error('server certificate uses an unsupported or weak signature algorithm');
  if (cert.validity.notBefore.getTime() > now + 5 * 60000) throw new Error('server certificate is not valid yet');
  if (cert.validity.notAfter.getTime() <= now) throw new Error('server certificate has expired');
  if (cert.validity.notAfter.getTime() > caCert.validity.notAfter.getTime()) throw new Error('server certificate outlives its CA');
  if (!forgeDnEqual(cert.issuer, caCert.subject)) throw new Error('server certificate issuer does not match the Local CA');
  try { if (!caCert.verify(cert)) throw new Error('signature verification failed'); }
  catch (e) { throw new Error('server certificate signature is invalid' + (e && e.message ? ': ' + e.message : '')); }
  const bc = cert.getExtension('basicConstraints'); if (bc && bc.cA === true) throw new Error('server certificate is incorrectly marked as a CA');
  const ku = cert.getExtension('keyUsage'); if (!ku || ku.digitalSignature !== true) throw new Error('server certificate lacks digitalSignature key usage');
  const eku = cert.getExtension('extKeyUsage'); if (!eku || eku.serverAuth !== true) throw new Error('server certificate lacks serverAuth usage');
  if (requireAki && !cert.getExtension('authorityKeyIdentifier')) throw new Error('server certificate lacks authorityKeyIdentifier');
  const { names, ips } = sanSets(cert); if (!names.size && !ips.size) throw new Error('server certificate has no subjectAltName');
  if (identities && (!exactSetEquals(identities.dns, names) || !exactSetEquals(identities.ips, ips))) throw new Error('server certificate SANs no longer match current LAN identities');
  if (renewalCheck) {
    const caRemaining = Math.max(0, caCert.validity.notAfter.getTime() - now);
    const windowMs = Math.min(TLS_LEAF_RENEW_MS, Math.max(60 * 60 * 1000, Math.floor(caRemaining / 4)));
    if (cert.validity.notAfter.getTime() <= now + windowMs) throw new Error('server certificate is due for renewal');
  }
}
function existingLeafMatches(ca, identities) {
  const p = ca.paths; if (!fs.existsSync(p.serverCert) || !fs.existsSync(p.serverKey)) return null;
  try {
    const certPem = readManagedTlsFile(p.serverCert, 'utf8'), keyPem = readManagedTlsFile(p.serverKey, 'utf8');
    const cert = forge.pki.certificateFromPem(certPem), key = forge.pki.privateKeyFromPem(keyPem);
    validateLeafCertificate(cert, key, ca.cert, identities, true);
    return { certPem, keyPem, cert, key };
  } catch (_) { return null; }
}
function ensureLocalServerCertificate(ca) {
  if (!forge) throw new Error('node-forge is unavailable');
  const identities = localTlsIdentities();
  const existing = existingLeafMatches(ca, identities); if (existing) return { ...existing, identities };
  const now = Date.now(), maxExpiry = Math.min(now + TLS_LEAF_VALIDITY_MS, ca.cert.validity.notAfter.getTime() - 60 * 60000);
  if (maxExpiry <= now + 10 * 60000) throw new Error('Direct-Xfer Local CA expires too soon to issue a new server certificate');
  const keys = generateForgeRsaKeyPair(3072), cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = randomCertSerial();
  cert.validity.notBefore = new Date(now - 5 * 60000); cert.validity.notAfter = new Date(maxExpiry);
  const cn = identities.dns.find((n) => n !== 'localhost') || identities.ips.find((ip) => ip !== '127.0.0.1' && ip !== '::1') || 'localhost';
  cert.setSubject([{ name:'commonName', value:cn }, { name:'organizationName', value:'Direct-Xfer' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const altNames = [...identities.dns.map((value) => ({type:2,value})), ...identities.ips.map((ip) => ({type:7,ip}))];
  cert.setExtensions([
    { name:'basicConstraints', cA:false, critical:true },
    { name:'keyUsage', digitalSignature:true, keyEncipherment:true, critical:true },
    { name:'extKeyUsage', serverAuth:true }, { name:'subjectAltName', altNames }, { name:'subjectKeyIdentifier' },
    { name:'authorityKeyIdentifier', keyIdentifier:ca.cert.generateSubjectKeyIdentifier().getBytes(), authorityCertIssuer:ca.cert.subject, serialNumber:ca.cert.serialNumber },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert), keyPem = keys.privatePem;
  validateLeafCertificate(cert, keys.privateKey, ca.cert, identities, false);
  atomicPrivateWrite(ca.paths.serverKey, keyPem, 0o600); atomicPrivateWrite(ca.paths.serverCert, certPem, 0o644);
  console.log('[tls] issued a LAN server certificate from Direct-Xfer Local CA for ' + [...identities.dns, ...identities.ips].join(', '));
  return { certPem, keyPem, cert, key:keys.privateKey, identities };
}
function loadExistingLocalLeafDegraded() {
  if (!forge) return null;
  try {
    const ca = readLocalCaCertificateOnly(), p = ca.paths;
    if (!fs.existsSync(p.serverCert) || !fs.existsSync(p.serverKey)) return null;
    const certPem = readManagedTlsFile(p.serverCert, 'utf8'), keyPem = readManagedTlsFile(p.serverKey, 'utf8');
    const cert = forge.pki.certificateFromPem(certPem), key = forge.pki.privateKeyFromPem(keyPem);
    validateLeafCertificate(cert, key, ca.cert, null, false, false);
    return { certPem, keyPem, cert, ca };
  } catch (_) { return null; }
}
function localCaStatus(createIfEnabled=false) {
  const identities = localTlsIdentities(), p = localCaPaths();
  try {
    // If Local CA HTTPS is already active, report the exact root that is in the
    // listener's secure context. Disk material may be a pending restore/replacement
    // and must not make the UI fingerprint disagree with the certificate download
    // or with the current TLS handshake.
    if (localCaModeActive() && activeTlsCaPem) {
      const activeCert = forge.pki.certificateFromPem(activeTlsCaPem);
      validateLocalCaCertificate(activeCert, null);
      const activeFingerprint = activeTlsCaFingerprint || certificateFingerprint256(activeTlsCaPem);
      let signingAvailable = false, error = '';
      try {
        if (!fs.existsSync(p.caCert)) {
          error = 'Local CA certificate is missing on disk; the active HTTPS context remains usable only until restart';
        } else {
          const diskCa = readLocalCaCertificateOnly();
          if (diskCa.fingerprint !== activeFingerprint) {
            tlsCertificateRestartRequired = true;
            error = 'Local CA on disk differs from the active trust anchor; restart required before it is activated';
          } else if (!fs.existsSync(p.caKey)) {
            error = 'Local CA private key is missing';
          } else {
            const key = forge.pki.privateKeyFromPem(readManagedTlsFile(p.caKey, 'utf8'));
            validateLocalCaCertificate(activeCert, key);
            signingAvailable = true;
          }
        }
      } catch (e) { error = e.message; }
      return {
        available:true, signingAvailable, fingerprint:activeFingerprint, identities,
        expiresAt:activeCert.validity.notAfter.getTime(),
        serverExpiresAt:activeTlsLeafExpiresAt || 0, error,
      };
    }

    if (!fs.existsSync(p.caCert) && createIfEnabled && configuredSelfSignedTls()) ensureLocalCa();
    if (!fs.existsSync(p.caCert)) return { available:false, signingAvailable:false, fingerprint:'', identities };
    const ca = readLocalCaCertificateOnly();
    let signingAvailable = false, error = '';
    try {
      if (!fs.existsSync(p.caKey)) error = 'Local CA private key is missing';
      else { const key = forge.pki.privateKeyFromPem(readManagedTlsFile(p.caKey, 'utf8')); validateLocalCaCertificate(ca.cert, key); signingAvailable = true; }
    } catch (e) { error = e.message; }
    let serverExpiresAt = 0;
    try { if (fs.existsSync(p.serverCert)) serverExpiresAt = Date.parse(new crypto.X509Certificate(readManagedTlsFile(p.serverCert)).validTo) || 0; } catch (_) {}
    return { available:true, signingAvailable, fingerprint:ca.fingerprint, identities, expiresAt:ca.expiresAt, serverExpiresAt, error };
  } catch (e) { return { available:false, signingAvailable:false, fingerprint:'', error:e.message, identities }; }
}
// 1.64.2 — the standard /api/shares poll does not need to re-read and
// re-parse CA/key/certificate files every few seconds. Cache this derived UI status
// briefly; diagnostics and TLS activation still call localCaStatus() directly.
let localCaStatusUiCache = { at:0, create:false, value:null };
function localCaStatusForClient(createIfEnabled=false) {
  const now = Date.now();
  if (localCaStatusUiCache.value && localCaStatusUiCache.create === !!createIfEnabled && now - localCaStatusUiCache.at < 15000) return localCaStatusUiCache.value;
  const value = localCaStatus(createIfEnabled);
  localCaStatusUiCache = { at:now, create:!!createIfEnabled, value };
  return value;
}
function invalidateLocalCaStatusUiCache() { localCaStatusUiCache = { at:0, create:false, value:null }; }

function validateProvidedTlsPair(cert, key) {
  try {
    tls.createSecureContext({ cert, key, minVersion:TLS_MIN_VERSION });
    const x = new crypto.X509Certificate(cert), now = Date.now(), from = Date.parse(x.validFrom), to = Date.parse(x.validTo);
    if (ASVS_L3_MODE) {
      const publicKey = x.publicKey;
      const type = String(publicKey && publicKey.asymmetricKeyType || '');
      const details = publicKey && publicKey.asymmetricKeyDetails || {};
      if (type === 'rsa' || type === 'rsa-pss') {
        if (Number(details.modulusLength || 0) < 3072) throw new Error('ASVS L3 requires RSA-3072 or stronger TLS leaf keys');
      } else if (type === 'ec') {
        const curve = String(details.namedCurve || '').toLowerCase();
        if (!['prime256v1','secp256r1','secp384r1','secp521r1'].includes(curve)) throw new Error('ASVS L3 requires an approved P-256-or-stronger EC TLS leaf key');
      } else {
        throw new Error('ASVS L3 TLS leaf key type is not approved');
      }
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('certificate validity could not be parsed');
    if (from > now + 5 * 60000) throw new Error('certificate is not valid yet');
    if (to <= now) throw new Error('certificate has expired');
    return x;
  } catch (e) { throw new Error('provided TLS certificate/key are invalid: ' + e.message); }
}
function loadTlsOptions() {
  if (!!TLS_CERT !== !!TLS_KEY) throw new Error('TLS_CERT and TLS_KEY must both be configured');
  if (TLS_CERT && TLS_KEY) {
    try {
      const cert = fs.readFileSync(TLS_CERT), key = fs.readFileSync(TLS_KEY);
      const x = validateProvidedTlsPair(cert, key);
      ACTIVE_TLS_MODE = 'provided';
      activeTlsLeafFingerprint = x.fingerprint256 || certificateFingerprint256(cert);
      activeTlsLeafPem = cert.toString('utf8');
      activeProvidedTlsMaterialFingerprint = tlsMaterialFingerprint(cert, key);
      activeProvidedTlsExpiresAt = Date.parse(x.validTo) || 0;
      return { cert, key, minVersion:TLS_MIN_VERSION };
    } catch (e) {
      if (/provided TLS certificate\/key/.test(String(e && e.message))) throw e;
      throw new Error('could not read TLS_CERT/TLS_KEY: ' + e.message);
    }
  }
  if (!configuredSelfSignedTls()) { ACTIVE_TLS_MODE = 'http'; return null; }
  try {
    const ca = ensureLocalCa(), leaf = ensureLocalServerCertificate(ca);
    ACTIVE_TLS_MODE = 'local-ca';
    activeTlsCaPem = ca.certPem;
    activeTlsCaFingerprint = ca.fingerprint || certificateFingerprint256(ca.certPem);
    activeTlsLeafFingerprint = certificateFingerprint256(leaf.certPem);
    activeTlsLeafPem = leaf.certPem;
    activeTlsLeafExpiresAt = leaf.cert.validity.notAfter.getTime();
    return { cert:leaf.certPem, key:leaf.keyPem, minVersion:TLS_MIN_VERSION };
  } catch (e) {
    if (ASVS_L3_MODE) throw new Error('local CA certificate setup failed in ASVS L3 mode: ' + e.message);
    const degraded = loadExistingLocalLeafDegraded();
    if (degraded) {
      ACTIVE_TLS_MODE = 'local-ca-degraded';
      activeTlsCaPem = degraded.ca && degraded.ca.certPem || '';
      activeTlsCaFingerprint = degraded.ca && degraded.ca.fingerprint || '';
      activeTlsLeafFingerprint = certificateFingerprint256(degraded.certPem);
      activeTlsLeafPem = degraded.certPem;
      activeTlsLeafExpiresAt = degraded.cert.validity.notAfter.getTime();
      console.error('[tls] Local CA signing is unavailable; using the existing server certificate temporarily:', e.message);
      return { cert:degraded.certPem, key:degraded.keyPem, minVersion:TLS_MIN_VERSION };
    }
    throw new Error('local CA certificate setup failed: ' + e.message);
  }
}
function refreshProvidedTlsServerContext(server) {
  if (!server || ACTIVE_TLS_MODE !== 'provided') return false;
  try {
    const cert = fs.readFileSync(TLS_CERT), key = fs.readFileSync(TLS_KEY);
    const x = validateProvidedTlsPair(cert, key);
    const fingerprint = x.fingerprint256 || certificateFingerprint256(cert);
    const materialFingerprint = tlsMaterialFingerprint(cert, key);
    const providedExpiresAt = Date.parse(x.validTo) || 0;
    // Compare the complete certificate-chain + private-key material, not only
    // the leaf fingerprint. ACME clients can legitimately replace an
    // intermediate chain while keeping the same leaf certificate.
    if (materialFingerprint && materialFingerprint !== activeProvidedTlsMaterialFingerprint) {
      server.setSecureContext({ cert, key, minVersion:TLS_MIN_VERSION });
      activeTlsLeafFingerprint = fingerprint;
      activeTlsLeafPem = cert.toString('utf8');
      activeProvidedTlsMaterialFingerprint = materialFingerprint;
      activeProvidedTlsExpiresAt = providedExpiresAt;
      console.log('[tls] reloaded the provided TLS certificate/key chain without interrupting existing connections.');
      return true;
    }
    if (materialFingerprint && materialFingerprint === activeProvidedTlsMaterialFingerprint) {
      activeProvidedTlsExpiresAt = providedExpiresAt;
    }
  } catch (e) {
    // External ACME/certificate writers may update the two files a fraction of a
    // second apart. Keep serving the last known-good context and retry later.
    console.warn('[tls] provided TLS certificate refresh failed; keeping the current TLS context:', e.message);
  }
  return false;
}
function refreshLocalTlsServerContext(server) {
  if (!server || !['local-ca','local-ca-degraded'].includes(ACTIVE_TLS_MODE) || tlsCertificateRestartRequired) return false;
  const wasDegraded = ACTIVE_TLS_MODE === 'local-ca-degraded';
  try {
    const ca = ensureLocalCa();
    const caFingerprint = ca.fingerprint || certificateFingerprint256(ca.certPem);
    // Never switch trust anchors on a live listener. A restored/manually replaced
    // root must take effect only after an explicit restart so clients are not
    // abruptly presented with an untrusted issuer mid-session.
    if (activeTlsCaFingerprint && caFingerprint && caFingerprint !== activeTlsCaFingerprint) {
      tlsCertificateRestartRequired = true;
      console.warn('[tls] Local CA trust anchor changed on disk; restart required before it is activated.');
      return false;
    }
    const leaf = ensureLocalServerCertificate(ca), fingerprint = certificateFingerprint256(leaf.certPem);
    const leafExpiresAt = leaf.cert.validity.notAfter.getTime();
    let changed = false;
    if (fingerprint && fingerprint !== activeTlsLeafFingerprint) {
      server.setSecureContext({ cert:leaf.certPem, key:leaf.keyPem, minVersion:TLS_MIN_VERSION });
      // Commit observable live-context metadata only after setSecureContext succeeds.
      // Otherwise diagnostics/health could claim a new expiry while the listener is
      // still serving the previous certificate.
      activeTlsLeafFingerprint = fingerprint;
      activeTlsLeafPem = leaf.certPem;
      activeTlsLeafExpiresAt = leafExpiresAt;
      changed = true;
      console.log('[tls] refreshed the active LAN server certificate without interrupting existing connections.');
    } else if (fingerprint && fingerprint === activeTlsLeafFingerprint) {
      activeTlsLeafExpiresAt = leafExpiresAt;
    }
    if (wasDegraded) {
      ACTIVE_TLS_MODE = 'local-ca';
      activeTlsCaPem = ca.certPem;
      activeTlsCaFingerprint = caFingerprint;
      console.log('[tls] Local CA signing key is available again; managed certificate renewal resumed.');
      return true;
    }
    return changed;
  } catch (e) { console.warn('[tls] automatic Local CA certificate refresh failed; keeping the current TLS context:', e.message); }
  return false;
}

  return {
    config: { TLS_CERT, TLS_KEY, TLS_DAY_MS, TLS_REFRESH_INTERVAL_MS },
    configuredSelfSignedTls,
    tlsManagedByEnvironment,
    configuredHttpsEnabled,
    localCaModeActive,
    localCaFeatureRelevant,
    tlsDirPath,
    localCaPaths,
    ensureTlsDirectory,
    readManagedTlsFile,
    atomicPrivateWrite,
    certificateFingerprint256,
    tlsMaterialFingerprint,
    validateLocalCaCertificate,
    readLocalCaCertificateOnly,
    ensureLocalCa,
    validateLeafCertificate,
    localCaStatus,
    localCaStatusForClient,
    invalidateLocalCaStatusUiCache,
    validateProvidedTlsPair,
    loadTlsOptions,
    refreshProvidedTlsServerContext,
    refreshLocalTlsServerContext,
    get ACTIVE_TLS_MODE() { return ACTIVE_TLS_MODE; },
    set ACTIVE_TLS_MODE(value) { ACTIVE_TLS_MODE = value; },
    get activeTlsLeafFingerprint() { return activeTlsLeafFingerprint; },
    set activeTlsLeafFingerprint(value) { activeTlsLeafFingerprint = value; },
    get activeTlsLeafExpiresAt() { return activeTlsLeafExpiresAt; },
    set activeTlsLeafExpiresAt(value) { activeTlsLeafExpiresAt = value; },
    get activeTlsLeafPem() { return activeTlsLeafPem; },
    set activeTlsLeafPem(value) { activeTlsLeafPem = value; },
    get activeTlsCaFingerprint() { return activeTlsCaFingerprint; },
    set activeTlsCaFingerprint(value) { activeTlsCaFingerprint = value; },
    get activeTlsCaPem() { return activeTlsCaPem; },
    set activeTlsCaPem(value) { activeTlsCaPem = value; },
    get activeProvidedTlsExpiresAt() { return activeProvidedTlsExpiresAt; },
    set activeProvidedTlsExpiresAt(value) { activeProvidedTlsExpiresAt = value; },
    get activeProvidedTlsMaterialFingerprint() { return activeProvidedTlsMaterialFingerprint; },
    set activeProvidedTlsMaterialFingerprint(value) { activeProvidedTlsMaterialFingerprint = value; },
    get tlsLeafRotationTimer() { return tlsLeafRotationTimer; },
    set tlsLeafRotationTimer(value) { tlsLeafRotationTimer = value; },
    get tlsCertificateRestartRequired() { return tlsCertificateRestartRequired; },
    set tlsCertificateRestartRequired(value) { tlsCertificateRestartRequired = value; },
  };
}

module.exports = { createTlsManager };

