'use strict';

const net = require('net');

const { URL } = require('url');
const { loadAndVerifyEvidence } = require('./asvs-l3-evidence');
const { createExternalCryptoProvider } = require('./external-crypto-provider');

const MIN_SECRET_BYTES = 32;
const CRYPTO_PROVIDERS = new Set(['vault', 'kms', 'hsm', 'isolated-vault']);
const MAIL_HEADER_MAX = 998;

function explicitTrustProxyPolicySafe(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const tokens = value.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((token) => {
    const slash = token.lastIndexOf('/');
    const host = slash >= 0 ? token.slice(0, slash) : token;
    const family = net.isIP(host);
    if (!family) return false;
    if (slash < 0) return true;
    const prefixText = token.slice(slash + 1);
    if (!/^\d+$/.test(prefixText)) return false;
    const prefix = Number(prefixText);
    return Number.isInteger(prefix) && prefix > 0 && prefix <= (family === 4 ? 32 : 128);
  });
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim());
}

function splitList(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizedHttpsUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return null;
    parsed.hash = '';
    return parsed;
  } catch (_) {
    return null;
  }
}

function secretBytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}


function normalizedEgressRules(value) {
  const rules = [];
  for (const raw of String(value || '').split(/[\s,;]+/)) {
    const item = raw.trim().toLowerCase();
    if (!item || item === '*') continue;
    if (item.includes('://')) {
      try {
        const parsed = new URL(item);
        if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) continue;
        if (!['https:', 'smtp:', 'smtps:'].includes(parsed.protocol)) continue;
        rules.push({ kind:'origin', protocol:parsed.protocol, hostname:parsed.hostname.toLowerCase(), port:parsed.port || '' });
      } catch (_) {}
      continue;
    }
    const wildcard = item.startsWith('*.');
    const candidate = wildcard ? item.slice(2) : item;
    if (!candidate || candidate.includes('/') || candidate.includes('@')) continue;
    const match = /^(\[[0-9a-f:]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(candidate);
    if (!match) continue;
    const hostname = match[1].replace(/^\[|\]$/g, '').toLowerCase();
    const port = match[2] || '';
    if (!hostname || (port && (Number(port) < 1 || Number(port) > 65535))) continue;
    rules.push({ kind:wildcard ? 'suffix' : 'host', hostname, port });
  }
  return rules;
}

function egressHostMatches(hostname, port, rules, protocol = '') {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  const p = String(port || '');
  const proto = String(protocol || '').toLowerCase();
  if (!host) return false;
  return rules.some((rule) => {
    if (rule.kind === 'origin' && rule.protocol && proto && rule.protocol !== proto) return false;
    if (rule.port && rule.port !== p) return false;
    if (rule.kind === 'suffix') return host !== rule.hostname && host.endsWith('.' + rule.hostname);
    return host === rule.hostname;
  });
}

function isAsvsL3OutboundUrlAllowed(value, options = {}) {
  const enabled = options.enabled === true || options.asvsL3Mode === true;
  if (!enabled) return true;
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch (_) { return false; }
  if (parsed.username || parsed.password || parsed.hash) return false;
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(options.allowHttpLoopback === true && loopback && parsed.protocol === 'http:')) return false;
  const rules = normalizedEgressRules(options.allowlist);
  return egressHostMatches(parsed.hostname, parsed.port, rules, parsed.protocol);
}

function assertAsvsL3OutboundUrl(value, options = {}) {
  if (isAsvsL3OutboundUrlAllowed(value, options)) return new URL(String(value));
  const error = new Error('Outbound destination is not permitted by the ASVS L3 egress policy');
  error.code = 'asvs-l3-egress-denied';
  throw error;
}

function isAsvsL3OutboundHostAllowed(hostname, port, options = {}) {
  const enabled = options.enabled === true || options.asvsL3Mode === true;
  if (!enabled) return true;
  return egressHostMatches(hostname, port, normalizedEgressRules(options.allowlist), options.protocol || '');
}

function assertAsvsL3OutboundHost(hostname, port, options = {}) {
  if (isAsvsL3OutboundHostAllowed(hostname, port, options)) return true;
  const error = new Error('Outbound host is not permitted by the ASVS L3 egress policy');
  error.code = 'asvs-l3-egress-denied';
  throw error;
}

function sanitizeMailHeader(value, max = MAIL_HEADER_MAX) {
  const raw = String(value == null ? '' : value);
  if (/[\r\n\0]/.test(raw)) {
    const error = new Error('Unsafe mail header value');
    error.code = 'unsafe-mail-header';
    throw error;
  }
  return raw.replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, Math.max(1, Math.min(MAIL_HEADER_MAX, Number(max) || MAIL_HEADER_MAX)));
}

function buildAsvsL3Report(config, env = process.env) {
  if (!config || typeof config !== 'object') throw new TypeError('ASVS L3 policy requires config');
  const enabled = config.ASVS_L3_MODE === true || truthy(env.ASVS_L3_MODE);
  const checks = [];
  const add = (id, ok, detail, remediation, manual = false) => {
    checks.push(Object.freeze({ id, ok:!!ok, detail:String(detail || ''), remediation:String(remediation || ''), manual:!!manual }));
  };

  const publicUrl = normalizedHttpsUrl(config.PUBLIC_URL || env.PUBLIC_URL);
  const remoteAuditUrl = normalizedHttpsUrl(config.AUDIT_REMOTE_URL || env.AUDIT_REMOTE_URL);
  const dataKey = String(config.DATA_KEY || env.DATA_KEY || '');
  const auditKey = String(config.AUDIT_HMAC_KEY || env.AUDIT_HMAC_KEY || '');
  const signingConfigured = !!String(config.AUDIT_SIGNING_PRIVATE_KEY || env.AUDIT_SIGNING_PRIVATE_KEY || '').trim()
    || !!String(config.AUDIT_SIGNING_PRIVATE_KEY_FILE || env.AUDIT_SIGNING_PRIVATE_KEY_FILE || '').trim();
  const egressAllowlist = normalizedEgressRules(config.ASVS_L3_EGRESS_ALLOWLIST || env.ASVS_L3_EGRESS_ALLOWLIST);
  const cryptoProvider = String(config.ASVS_L3_CRYPTO_PROVIDER || env.ASVS_L3_CRYPTO_PROVIDER || '').trim().toLowerCase();
  const cryptoCommand = String(config.ASVS_L3_CRYPTO_COMMAND || env.ASVS_L3_CRYPTO_COMMAND || '').trim();
  const hardwareAaguids = splitList(config.ASVS_L3_HARDWARE_AAGUIDS || env.ASVS_L3_HARDWARE_AAGUIDS).map((v) => v.replace(/[^a-f0-9]/g, '')).filter((v) => /^[a-f0-9]{32}$/.test(v));
  const attestationRoots = splitList(config.ASVS_L3_ATTESTATION_ROOT_SHA256 || env.ASVS_L3_ATTESTATION_ROOT_SHA256).map((v) => v.replace(/[^a-f0-9]/g, '')).filter((v) => /^[a-f0-9]{64}$/.test(v));
  const attestationRootFiles = String(config.ASVS_L3_ATTESTATION_ROOT_FILES || env.ASVS_L3_ATTESTATION_ROOT_FILES || '').split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean);
  const clamavHost = String(config.CLAMAV_HOST || env.CLAMAV_HOST || '').trim();
  const clamavSocket = String(config.CLAMAV_SOCKET || env.CLAMAV_SOCKET || '').trim();
  const clamavTls = truthy(config.CLAMAV_TLS || env.CLAMAV_TLS);
  const trustProxy = config.TRUST_PROXY;
  const localTlsConfigured = !!String(env.TLS_CERT || '').trim() || !!String(env.TLS_KEY || '').trim() || truthy(env.TLS_SELF_SIGNED);

  add('transport.public-url', !!publicUrl,
    publicUrl ? `HTTPS origin ${publicUrl.origin}` : 'PUBLIC_URL is not an absolute HTTPS URL',
    'Set PUBLIC_URL=https://<public-host> and terminate TLS with a trusted certificate.');
  add('secrets.data-key', enabled ? !dataKey : secretBytes(dataKey) >= MIN_SECRET_BYTES,
    enabled ? (dataKey ? 'DATA_KEY is present in the application process (forbidden in L3)' : 'No application-process DATA_KEY; external provider owns data key') : `DATA_KEY length=${secretBytes(dataKey)} bytes`,
    enabled ? 'Remove DATA_KEY from the Direct-Xfer process and use ASVS_L3_CRYPTO_COMMAND.' : `Provide DATA_KEY with at least ${MIN_SECRET_BYTES} bytes of high-entropy secret material.`);
  add('secrets.audit-hmac', enabled ? !auditKey : (secretBytes(auditKey) >= MIN_SECRET_BYTES && auditKey !== dataKey),
    enabled ? (auditKey ? 'AUDIT_HMAC_KEY is present in the application process (forbidden in L3)' : 'Audit HMAC key is external-provider owned') : (auditKey === dataKey && auditKey ? 'AUDIT_HMAC_KEY reuses DATA_KEY' : `AUDIT_HMAC_KEY length=${secretBytes(auditKey)} bytes`),
    enabled ? 'Remove AUDIT_HMAC_KEY from the Direct-Xfer process; the isolated crypto provider must expose the audit-hmac handle.' : 'Provide a dedicated AUDIT_HMAC_KEY of at least 32 random bytes, distinct from DATA_KEY.');
  add('secrets.audit-signing', enabled ? !signingConfigured : signingConfigured,
    enabled ? (signingConfigured ? 'Audit private signing key is exposed to the application process (forbidden in L3)' : 'Audit signing operation is delegated to the isolated provider') : (signingConfigured ? 'External Ed25519 audit signing key configured' : 'Audit signing key would be generated locally'),
    enabled ? 'Remove local audit private keys and configure ASVS_L3_CRYPTO_COMMAND.' : 'Provide AUDIT_SIGNING_PRIVATE_KEY or AUDIT_SIGNING_PRIVATE_KEY_FILE from the deployment secret manager.');
  add('uploads.antimalware', !!(clamavHost || clamavSocket),
    clamavSocket ? `ClamAV Unix socket ${clamavSocket}` : (clamavHost ? `ClamAV endpoint ${clamavHost}:${config.CLAMAV_PORT}` : 'ClamAV is not configured'),
    'Configure clamd through CLAMAV_SOCKET or CLAMAV_HOST/CLAMAV_PORT.');
  add('uploads.antimalware-transport', !!clamavSocket || (!!clamavHost && clamavTls),
    clamavSocket ? 'ClamAV uses local Unix-domain IPC' : (clamavTls ? 'ClamAV TCP transport is TLS-protected' : 'ClamAV TCP transport is plaintext'),
    'For L3 use CLAMAV_SOCKET, or set CLAMAV_TLS=true (optionally CLAMAV_TLS_CA_FILE/CLAMAV_TLS_SERVERNAME) for TCP.');
  add('logging.remote-sink', !!remoteAuditUrl,
    remoteAuditUrl ? `Remote audit sink ${remoteAuditUrl.origin}` : 'AUDIT_REMOTE_URL is missing or not HTTPS',
    'Set AUDIT_REMOTE_URL to an HTTPS endpoint on a separate logging system.');
  add('network.egress-allowlist', egressAllowlist.length > 0,
    egressAllowlist.length ? `${egressAllowlist.length} approved outbound host pattern(s)` : 'No outbound host allowlist is declared',
    'Set ASVS_L3_EGRESS_ALLOWLIST to the exact external hosts required by enabled integrations and enforce it at the deployment firewall/proxy.');
  let cryptoProviderVerified = false;
  let cryptoProviderDetail = cryptoProvider ? `Declared crypto provider: ${cryptoProvider}` : 'No isolated crypto provider declared';
  if (enabled && CRYPTO_PROVIDERS.has(cryptoProvider) && cryptoCommand) {
    try {
      const provider = createExternalCryptoProvider({ command:cryptoCommand });
      cryptoProviderVerified = !!provider;
      if (provider) cryptoProviderDetail = `${cryptoProvider}; isolated command self-test passed (${provider.keyId('data')})`;
    } catch (error) { cryptoProviderDetail = String(error && error.message || error); }
  }
  add('crypto.isolated-provider', !enabled || (CRYPTO_PROVIDERS.has(cryptoProvider) && cryptoProviderVerified),
    cryptoProviderDetail,
    'Set ASVS_L3_CRYPTO_PROVIDER and ASVS_L3_CRYPTO_COMMAND to an isolated provider command whose self-test proves non-exportable data/audit keys and encrypt/decrypt/HMAC/sign operations.');
  add('auth.hardware-aaguid-policy', !enabled || hardwareAaguids.length > 0,
    hardwareAaguids.length ? `${hardwareAaguids.length} hardware authenticator AAGUID(s) allowlisted` : 'No hardware authenticator AAGUID allowlist configured',
    'Set ASVS_L3_HARDWARE_AAGUIDS to the approved hardware authenticator AAGUIDs.');
  add('auth.attestation-root-policy', !enabled || (attestationRoots.length > 0 && attestationRootFiles.length > 0),
    attestationRoots.length && attestationRootFiles.length ? `${attestationRoots.length} attestation root fingerprint(s) pinned with ${attestationRootFiles.length} trust-anchor file(s)` : 'WebAuthn attestation root fingerprints/certificates are incomplete',
    'Set ASVS_L3_ATTESTATION_ROOT_SHA256 and ASVS_L3_ATTESTATION_ROOT_FILES to approved hardware authenticator trust anchors.');
  add('transport.external-tls-termination', !enabled || !localTlsConfigured,
    localTlsConfigured ? 'Local TLS key/certificate handling is configured in the Direct-Xfer process' : 'TLS private-key operations are delegated to the verified external edge',
    'For L3 do not set TLS_CERT/TLS_KEY/TLS_SELF_SIGNED in Direct-Xfer; terminate TLS at the hardware-backed verified edge.');
  add('proxy.intermediary-trust', !enabled || explicitTrustProxyPolicySafe(trustProxy),
    explicitTrustProxyPolicySafe(trustProxy) ? `Explicit proxy peer/CIDR trust: ${trustProxy}` : 'L3 requires a non-global explicit proxy peer/CIDR trust list',
    'Configure TRUST_PROXY as the exact IP/CIDR list for the external TLS edge; boolean/numeric hop-count trust is forbidden in L3.');
  add('admin.network-scope', config.ADMIN_ALLOW_ANY !== true,
    config.ADMIN_ALLOW_ANY ? 'ADMIN_ALLOW_ANY=true exposes the administrator surface broadly' : 'ADMIN_ALLOW_ANY is disabled',
    'Disable ADMIN_ALLOW_ANY and use the administrator allowlist/reverse-proxy network policy.');
  const evidence = enabled ? loadAndVerifyEvidence(config, env) : { ok:true, failures:[] };
  add('deployment.signed-evidence', evidence.ok,
    evidence.ok ? 'Signed, release-bound, origin-bound deployment evidence is current and complete' : `Deployment evidence failed: ${(evidence.failures || []).map((row) => row.id).join(', ') || 'unknown'}`,
    'Generate a current ASVS L3 deployment evidence bundle, sign it with the configured Ed25519 evidence key, and set ASVS_L3_EVIDENCE_FILE plus ASVS_L3_EVIDENCE_PUBLIC_KEY(_FILE).');

  const failures = checks.filter((row) => !row.ok);
  return Object.freeze({
    enabled,
    ok:!enabled || failures.length === 0,
    checks:Object.freeze(checks),
    failures:Object.freeze(failures),
    generatedAt:Date.now(),
  });
}

function assertAsvsL3Configuration(config, env = process.env) {
  const report = buildAsvsL3Report(config, env);
  if (!report.enabled || report.ok) return report;
  const error = new Error(`ASVS L3 startup policy failed (${report.failures.length} prerequisite(s)): ${report.failures.map((r) => r.id).join(', ')}`);
  error.code = 'asvs-l3-prerequisites';
  error.report = report;
  throw error;
}

function createAsvsL3TransportGuard(options = {}) {
  const enabled = options.enabled === true;
  const isLoopback = typeof options.isLoopback === 'function' ? options.isLoopback : () => false;
  return function asvsL3TransportGuard(req, res, next) {
    if (!enabled || req.secure) return next();
    const path = String(req.path || req.url || '').split('?')[0];
    const addr = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
    if (path === '/healthz' && isLoopback(addr)) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'close');
    return res.status(426).json({ error:'https-required', asvs:'L3' });
  };
}

module.exports = {
  buildAsvsL3Report,
  assertAsvsL3Configuration,
  createAsvsL3TransportGuard,
  normalizedHttpsUrl,
  splitList,
  normalizedEgressRules,
  isAsvsL3OutboundUrlAllowed,
  assertAsvsL3OutboundUrl,
  isAsvsL3OutboundHostAllowed,
  assertAsvsL3OutboundHost,
  sanitizeMailHeader, explicitTrustProxyPolicySafe,
};
