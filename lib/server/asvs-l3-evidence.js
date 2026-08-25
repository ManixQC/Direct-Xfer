'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVIDENCE_VERSION = 1;
const MAX_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const REQUIRED_DEPLOYMENT_REQUIREMENTS = Object.freeze([
  'V3.7.4', 'V4.1.2', 'V4.1.3', 'V4.2.1', 'V4.2.3', 'V4.2.4',
  'V11.7.1', 'V11.7.2',
  'V12.1.2', 'V12.1.4', 'V12.1.5', 'V12.2.2',
  'V13.2.1', 'V13.2.2', 'V13.2.5', 'V13.3.1', 'V13.3.2', 'V13.3.3',
  'V15.2.1', 'V16.2.2', 'V16.4.2', 'V16.4.3',
]);
const ALLOWED_METHODS = new Set([
  'active-http-probe', 'active-tls-probe', 'dns-ech-probe', 'hsts-preload-api',
  'host-hardening-probe', 'firewall-policy-probe', 'backend-identity-probe',
  'crypto-provider-self-test', 'crypto-provider-acl-probe', 'release-security-scan',
  'clock-source-probe', 'remote-audit-receipt',
]);


const REQUIRED_METHOD = Object.freeze({
  'V3.7.4':'hsts-preload-api',
  'V4.1.2':'active-http-probe', 'V4.1.3':'active-http-probe', 'V4.2.1':'active-http-probe',
  'V4.2.3':'active-http-probe', 'V4.2.4':'active-http-probe',
  'V11.7.1':'host-hardening-probe', 'V11.7.2':'host-hardening-probe',
  'V12.1.2':'active-tls-probe', 'V12.1.4':'active-tls-probe', 'V12.1.5':'dns-ech-probe', 'V12.2.2':'active-tls-probe',
  'V13.2.1':'backend-identity-probe', 'V13.2.2':'backend-identity-probe', 'V13.2.5':'firewall-policy-probe',
  'V13.3.1':'crypto-provider-self-test', 'V13.3.2':'crypto-provider-acl-probe', 'V13.3.3':'crypto-provider-self-test',
  'V15.2.1':'release-security-scan', 'V16.2.2':'clock-source-probe',
  'V16.4.2':'remote-audit-receipt', 'V16.4.3':'remote-audit-receipt',
});

function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function validObservation(id, observation) {
  const o = observation && typeof observation === 'object' && !Array.isArray(observation) ? observation : {};
  switch (id) {
    case 'V3.7.4': return o.preloaded === true && typeof o.domain === 'string' && !!o.domain.trim();
    case 'V4.1.2': return [301,302,307,308].includes(Number(o.userFacingHttpStatus)) && /^https:\/\//i.test(String(o.userFacingLocation || '')) && o.apiHttpRedirected === false;
    case 'V4.1.3': return o.untrustedForwardedHeadersIgnored === true && o.trustedProxyHeadersAuthenticated === true;
    case 'V4.2.1': return o.clTeAmbiguityRejected === true && o.duplicateContentLengthRejected === true && o.messageBoundariesConsistent === true;
    case 'V4.2.3': return o.http2Or3ConnectionHeadersRejected === true;
    case 'V4.2.4': return o.http2Or3CrLfHeadersRejected === true;
    case 'V11.7.1': return o.fullMemoryEncryption === true && o.unauthorizedProcessIsolation === true;
    case 'V11.7.2': return o.processingMinimized === true && o.reencryptedAfterUse === true;
    case 'V12.1.2': return o.forwardSecrecyOnly === true && o.recommendedCipherSuitesOnly === true;
    case 'V12.1.4': return o.revocationCheckingEnabled === true;
    case 'V12.1.5': return o.echEnabled === true;
    case 'V12.2.2': return o.publiclyTrustedCertificate === true && o.hostnameVerified === true;
    case 'V13.2.1': return o.allEnabledBackendsAuthenticated === true && o.credentialsShortLivedOrRotated === true;
    case 'V13.2.2': return o.backendIdentitiesLeastPrivilege === true;
    case 'V13.2.5': return o.egressDefaultDeny === true && o.hostAllowlistSameOrNarrower === true;
    case 'V13.3.1': return o.hardwareBacked === true && o.keyExportable === false && o.keyIsolation === true;
    case 'V13.3.2': return o.leastPrivilege === true && o.keyExtractionDenied === true;
    case 'V13.3.3': return o.allSecretKeyOperationsIsolated === true && o.keyMaterialNeverExported === true;
    case 'V15.2.1': return o.dependencyScanPassed === true && o.containerScanPassed === true && Number(o.criticalFindings) === 0 && Number(o.highFindings) === 0;
    case 'V16.2.2': return o.synchronized === true && Number.isFinite(Number(o.maxOffsetMs)) && Math.abs(Number(o.maxOffsetMs)) <= 1000;
    case 'V16.4.2': return o.remoteImmutable === true && o.retentionEnforced === true;
    case 'V16.4.3': return o.logicallySeparate === true && o.transportTlsVerified === true && o.ingestAuthenticated === true;
    default: return false;
  }
}

function canonicalize(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
}

function evidencePayload(bundle) {
  const copy = { ...bundle };
  delete copy.signature;
  return Buffer.from(canonicalize(copy));
}

function normalizePublicOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return '';
    return url.origin;
  } catch (_) { return ''; }
}

function loadPublicKey(config = {}, env = process.env) {
  let pem = String(config.ASVS_L3_EVIDENCE_PUBLIC_KEY || env.ASVS_L3_EVIDENCE_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim();
  const file = String(config.ASVS_L3_EVIDENCE_PUBLIC_KEY_FILE || env.ASVS_L3_EVIDENCE_PUBLIC_KEY_FILE || '').trim();
  if (!pem && file) pem = fs.readFileSync(path.resolve(file), 'utf8').trim();
  if (!pem) throw Object.assign(new Error('asvs-l3-evidence-public-key-missing'), { code:'ASVS_L3_EVIDENCE_KEY_MISSING' });
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw Object.assign(new Error('asvs-l3-evidence-key-not-ed25519'), { code:'ASVS_L3_EVIDENCE_KEY_INVALID' });
  return key;
}

function verifyEvidenceBundle(bundle, options = {}) {
  const now = Number(options.now) || Date.now();
  const appVersion = String(options.appVersion || '');
  const publicOrigin = normalizePublicOrigin(options.publicUrl || '');
  const failures = [];
  const fail = (id, detail) => failures.push({ id, detail:String(detail || '') });
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return { ok:false, failures:[{ id:'evidence.format', detail:'bundle must be an object' }] };
  if (bundle.evidenceVersion !== EVIDENCE_VERSION) fail('evidence.version', `expected ${EVIDENCE_VERSION}`);
  if (bundle.profile !== 'OWASP-ASVS-5.0.0-L3') fail('evidence.profile', 'unexpected profile');
  if (appVersion && String(bundle.release || '') !== appVersion) fail('evidence.release', `expected ${appVersion}`);
  if (!publicOrigin || normalizePublicOrigin(bundle.publicOrigin) !== publicOrigin) fail('evidence.origin', 'public origin mismatch');
  const generatedAt = Number(bundle.generatedAt) || 0;
  const expiresAt = Number(bundle.expiresAt) || 0;
  if (!generatedAt || generatedAt > now + CLOCK_SKEW_MS) fail('evidence.generated-at', 'invalid/future generatedAt');
  if (!expiresAt || expiresAt <= now) fail('evidence.expired', 'evidence expired');
  if (expiresAt <= generatedAt) fail('evidence.ttl-order', 'expiresAt must be later than generatedAt');
  if (expiresAt - generatedAt > MAX_EVIDENCE_TTL_MS) fail('evidence.ttl', 'evidence validity exceeds seven days');
  if (generatedAt && generatedAt < now - MAX_EVIDENCE_TTL_MS) fail('evidence.generated-stale', 'evidence bundle is older than seven days');

  const rows = Array.isArray(bundle.checks) ? bundle.checks : [];
  const byId = new Map();
  for (const row of rows) {
    const id = String(row && row.id || '');
    if (!id || byId.has(id)) { if (id) fail('evidence.duplicate', id); continue; }
    byId.set(id, row);
  }
  for (const id of REQUIRED_DEPLOYMENT_REQUIREMENTS) {
    const row = byId.get(id);
    if (!row || row.status !== 'pass') { fail(id, 'missing passing deployment evidence'); continue; }
    const method = String(row.method || '');
    if (!ALLOWED_METHODS.has(method) || method !== REQUIRED_METHOD[id]) fail(id, `unexpected evidence method: ${method || 'missing'}`);
    const observedAt = Number(row.observedAt) || 0;
    if (!observedAt || observedAt < now - MAX_EVIDENCE_TTL_MS || observedAt > generatedAt + CLOCK_SKEW_MS || observedAt > now + CLOCK_SKEW_MS) fail(id, 'invalid/stale observation timestamp');
    if (!validObservation(id, row.observation)) fail(id, 'observation does not satisfy the requirement-specific evidence predicate');
    const digest = String(row.digest || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest) || digest !== sha256Canonical(row.observation)) fail(id, 'evidence digest missing/invalid or does not match observation');
  }

  try {
    const key = options.publicKey || loadPublicKey(options.config || {}, options.env || process.env);
    const signature = Buffer.from(String(bundle.signature || ''), 'base64');
    if (!signature.length || !crypto.verify(null, evidencePayload(bundle), key, signature)) fail('evidence.signature', 'signature invalid');
  } catch (error) { fail('evidence.signature', error.message); }
  return Object.freeze({ ok:failures.length === 0, failures:Object.freeze(failures), checks:Object.freeze(rows), generatedAt, expiresAt });
}

function loadAndVerifyEvidence(config = {}, env = process.env, options = {}) {
  const file = String(config.ASVS_L3_EVIDENCE_FILE || env.ASVS_L3_EVIDENCE_FILE || '').trim();
  if (!file) return { ok:false, failures:[{ id:'evidence.file', detail:'ASVS_L3_EVIDENCE_FILE is required' }] };
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
  catch (error) { return { ok:false, failures:[{ id:'evidence.file', detail:String(error && error.message || error) }] }; }
  return verifyEvidenceBundle(bundle, {
    appVersion:String(config.APP_VERSION || options.appVersion || ''),
    publicUrl:String(config.PUBLIC_URL || env.PUBLIC_URL || ''),
    config, env, now:options.now,
  });
}

function signEvidenceBundle(bundle, privateKeyPem) {
  const key = crypto.createPrivateKey(String(privateKeyPem || ''));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('evidence signing key must be Ed25519');
  const copy = { ...bundle };
  delete copy.signature;
  copy.signature = crypto.sign(null, evidencePayload(copy), key).toString('base64');
  return copy;
}

module.exports = {
  EVIDENCE_VERSION, MAX_EVIDENCE_TTL_MS, REQUIRED_DEPLOYMENT_REQUIREMENTS,
  ALLOWED_METHODS, REQUIRED_METHOD, canonicalize, sha256Canonical, validObservation, evidencePayload, verifyEvidenceBundle,
  loadAndVerifyEvidence, signEvidenceBundle, normalizePublicOrigin,
};
