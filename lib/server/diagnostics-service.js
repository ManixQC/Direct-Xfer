'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

/**
 * Owns bounded host diagnostics that do not belong to HTTP routing: writable
 * volume probes, TCP reachability and inspection of the certificate served by
 * the live TLS context. TLS collaborators stay injected so the service follows
 * context reloads performed by tls-manager.
 */
function createDiagnosticsService(deps = {}) {
  const {
    tlsCert: TLS_CERT = '',
    tlsKey: TLS_KEY = '',
    tlsDayMs: TLS_DAY_MS = 86400000,
    fsTimeoutMs = 2500,
    tlsManager,
    localCaModeActive,
    readManagedTlsFile,
    localCaPaths,
    localCaStatus,
    validateProvidedTlsPair,
    certificateFingerprint256,
    tlsMaterialFingerprint,
  } = deps;

  if (!tlsManager || typeof tlsManager !== 'object') throw new TypeError('diagnostics-service requires tlsManager');
  for (const [name, dependency] of Object.entries({
    localCaModeActive,
    readManagedTlsFile,
    localCaPaths,
    localCaStatus,
    validateProvidedTlsPair,
    certificateFingerprint256,
    tlsMaterialFingerprint,
  })) {
    if (typeof dependency !== 'function') throw new TypeError(`diagnostics-service requires ${name}()`);
  }
  const parsedFsTimeout = Number(fsTimeoutMs);
  const filesystemTimeout = Number.isFinite(parsedFsTimeout)
    ? Math.min(30000, Math.max(100, parsedFsTimeout))
    : 2500;

  function stableErrorCode(error, fallback = 'unavailable') {
    const code = String(error && error.code || '').trim();
    return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : fallback;
  }

  function withTimeout(promise, timeoutMs = filesystemTimeout) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code:'ETIMEDOUT' })), timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  // The only filesystem mutation performed by the diagnostics domain is this
  // bounded create/delete probe inside an explicitly configured volume.
  async function diagnosticWritable(dir) {
    if (typeof dir !== 'string' || !dir) return { ok:false, error:'not-configured' };
    let probe = null;
    let writePromise = null;
    let writeSettled = false;
    const cleanup = () => probe
      ? fs.promises.unlink(probe).catch(() => {})
      : Promise.resolve();
    try {
      probe = path.join(dir, `.dx-diagnostic-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
      await withTimeout(fs.promises.mkdir(dir, { recursive:true, mode:0o700 }));
      writePromise = fs.promises.writeFile(probe, 'ok', { mode:0o600, flag:'wx' });
      writePromise.then(
        () => { writeSettled = true; },
        () => { writeSettled = true; },
      );
      await withTimeout(writePromise);
      await withTimeout(cleanup());
      return { ok:true };
    } catch (error) {
      if (writePromise && !writeSettled) {
        writePromise.then(cleanup, cleanup).catch(() => {});
      } else {
        await withTimeout(cleanup()).catch(() => {});
      }
      return { ok:false, error:stableErrorCode(error) };
    }
  }

  async function diagnosticTcp(host, port, timeoutMs) {
    const normalizedHost = typeof host === 'string' ? host.trim() : '';
    const normalizedPort = Number(port);
    if (!normalizedHost) return { ok:false, error:'invalid-host' };
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      return { ok:false, error:'invalid-port' };
    }
    return await new Promise((resolve) => {
      let socket = null;
      let done = false;
      const finish = (ok, error) => {
        if (done) return;
        done = true;
        if (socket) {
          try { socket.destroy(); } catch (_) {}
        }
        resolve({ ok, error:error || null });
      };
      try {
        const requestedTimeout = Number(timeoutMs);
        const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
          ? Math.min(30000, Math.max(100, requestedTimeout))
          : 2500;
        socket = net.createConnection({ host:normalizedHost, port:normalizedPort });
        socket.setTimeout(timeout, () => finish(false, 'timeout'));
        socket.once('connect', () => finish(true));
        socket.once('error', (error) => finish(false, stableErrorCode(error)));
      } catch (error) {
        finish(false, stableErrorCode(error));
      }
    });
  }

  function tlsCertificateDiagnostics() {
    const out = {
      mode:tlsManager.ACTIVE_TLS_MODE,
      active:tlsManager.ACTIVE_TLS_MODE !== 'http',
      minProtocol:'TLSv1.2',
      restartRequired:!!tlsManager.tlsCertificateRestartRequired,
    };
    if (!out.active) return { ...out, status:'info', reason:'http-only', fixable:false };
    try {
      // Diagnose the certificate loaded in the live HTTPS context, not merely
      // files that a certificate manager may currently be replacing on disk.
      let certBytes = tlsManager.activeTlsLeafPem ? Buffer.from(tlsManager.activeTlsLeafPem) : null;
      if (!certBytes) {
        if (tlsManager.ACTIVE_TLS_MODE === 'provided' && TLS_CERT) certBytes = fs.readFileSync(TLS_CERT);
        else if (localCaModeActive()) certBytes = readManagedTlsFile(localCaPaths().serverCert);
      }
      if (!certBytes) throw new Error('active certificate unavailable');
      const certificate = new crypto.X509Certificate(certBytes);
      const validFrom = Date.parse(certificate.validFrom) || 0;
      const validTo = Date.parse(certificate.validTo) || 0;
      const now = Date.now();
      const sanText = String(certificate.subjectAltName || '');
      const sans = sanText ? sanText.split(/,\s*/).map((value) => value.trim()).filter(Boolean).slice(0, 50) : [];
      const subject = String(certificate.subject || '');
      const issuer = String(certificate.issuer || '');
      let bits = null;
      let keyType = null;
      let namedCurve = null;
      try {
        keyType = certificate.publicKey && certificate.publicKey.asymmetricKeyType || null;
        const details = certificate.publicKey && certificate.publicKey.asymmetricKeyDetails || {};
        bits = details.modulusLength || null;
        namedCurve = details.namedCurve || null;
      } catch (_) {}
      const expiring = !!(validTo && validTo <= now + 14 * TLS_DAY_MS);
      const expired = !!(validTo && validTo <= now);
      const notYet = !!(validFrom && validFrom > now + 5 * 60000);
      let ca = null;
      let chainValid = null;
      if (localCaModeActive()) {
        const caStatus = localCaStatus(false);
        ca = {
          fingerprint:caStatus.fingerprint || tlsManager.activeTlsCaFingerprint || '',
          expiresAt:caStatus.expiresAt || 0,
          signingAvailable:!!caStatus.signingAvailable,
          error:caStatus.error ? 'unavailable' : null,
        };
        try {
          if (tlsManager.activeTlsCaPem) {
            const caCertificate = new crypto.X509Certificate(tlsManager.activeTlsCaPem);
            chainValid = !!certificate.verify(caCertificate.publicKey);
          }
        } catch (_) { chainValid = false; }
      }

      // Inspect disk material separately. A mismatch is actionable but must not
      // be presented as the certificate currently served to clients.
      let disk = null;
      try {
        if (tlsManager.ACTIVE_TLS_MODE === 'provided' && TLS_CERT && TLS_KEY) {
          const diskCert = fs.readFileSync(TLS_CERT);
          const diskKey = fs.readFileSync(TLS_KEY);
          const parsed = validateProvidedTlsPair(diskCert, diskKey);
          const fingerprint = parsed.fingerprint256 || certificateFingerprint256(diskCert);
          const materialFingerprint = tlsMaterialFingerprint(diskCert, diskKey);
          disk = {
            readable:true,
            valid:true,
            fingerprint,
            materialFingerprint,
            matchesActive:!!materialFingerprint && materialFingerprint === tlsManager.activeProvidedTlsMaterialFingerprint,
          };
        } else if (localCaModeActive()) {
          const paths = localCaPaths();
          const diskCert = readManagedTlsFile(paths.serverCert);
          const diskKey = readManagedTlsFile(paths.serverKey);
          tls.createSecureContext({ cert:diskCert, key:diskKey, minVersion:'TLSv1.2' });
          const parsed = new crypto.X509Certificate(diskCert);
          const fingerprint = parsed.fingerprint256 || certificateFingerprint256(diskCert);
          let signedByActiveCa = null;
          if (tlsManager.activeTlsCaPem) {
            try { signedByActiveCa = !!parsed.verify(new crypto.X509Certificate(tlsManager.activeTlsCaPem).publicKey); }
            catch (_) { signedByActiveCa = false; }
          }
          disk = {
            readable:true,
            valid:signedByActiveCa !== false,
            fingerprint,
            matchesActive:fingerprint === (certificate.fingerprint256 || tlsManager.activeTlsLeafFingerprint || ''),
            signedByActiveCa,
          };
          if (signedByActiveCa === false) throw new Error('managed server certificate is not signed by the active Local CA');
        }
      } catch (error) {
        disk = {
          readable:false,
          valid:false,
          matchesActive:false,
          error:stableErrorCode(error, 'invalid-material'),
        };
      }

      let status = expired || notYet || chainValid === false ? 'bad' : expiring || out.restartRequired ? 'warn' : 'ok';
      let reason = expired ? 'expired' : notYet ? 'not-yet-valid' : chainValid === false ? 'issuer-chain-invalid' : expiring ? 'expiring-soon' : out.restartRequired ? 'restart-required' : null;
      if (tlsManager.ACTIVE_TLS_MODE === 'local-ca-degraded') { status = 'bad'; reason = 'ca-signing-unavailable'; }
      if (disk && (!disk.valid || !disk.matchesActive) && status === 'ok') {
        status = 'warn';
        reason = !disk.valid ? 'disk-material-invalid-active-context-kept' : 'disk-material-pending-reload';
      }
      const fixable = ['local-ca', 'local-ca-degraded'].includes(tlsManager.ACTIVE_TLS_MODE)
        && !out.restartRequired && !!(ca && ca.signingAvailable) && reason !== 'issuer-chain-invalid';
      return {
        ...out,
        status,
        subject,
        issuer,
        sans,
        validFrom,
        validTo,
        fingerprint:certificate.fingerprint256 || tlsManager.activeTlsLeafFingerprint || '',
        serialNumber:certificate.serialNumber || '',
        signatureAlgorithm:certificate.signatureAlgorithm || null,
        publicKeyBits:bits,
        publicKeyType:keyType,
        namedCurve,
        ca,
        chainValid,
        disk,
        fixable,
        reason:reason || (chainValid === true ? 'ok' : null),
      };
    } catch (error) {
      return {
        ...out,
        status:'bad',
        reason:'certificate-read-failed',
        error:stableErrorCode(error),
        fixable:false,
      };
    }
  }

  function safeDiagnosticFixFor(check) {
    if (!check) return null;
    if (check.id === 'search-index' && check.status !== 'ok') return { action:'search-reindex' };
    if (check.id === 'tls-certificate' && check.status !== 'ok' && check.fixable === true) return { action:'tls-refresh' };
    return null;
  }

  return Object.freeze({ diagnosticWritable, diagnosticTcp, tlsCertificateDiagnostics, safeDiagnosticFixFor });
}

module.exports = { createDiagnosticsService };
