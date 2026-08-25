'use strict';

// Entry-point HTTP handlers that stay wired directly into the composition root's
// Express pipeline: the credential-free Local-CA trust bootstrap, the admin login
// endpoint, and the unauthenticated liveness/metadata probes. The handler bodies
// (and their security reasoning) live here so server.js keeps only route
// registration and the middleware ordering those routes depend on.
//
// The factory returns the handlers plus loginHints/sendLocalCaCertificate: the
// composition root registers those two into the admin/diagnostics route domains as
// well, so they must be reachable by name and cannot simply attach themselves.
function createRootRoutes(deps = {}) {
  const {
    // Application identity / configuration.
    APP_NAME, APP_VERSION, APP_YEAR, RELEASE_DATE, STORAGE_SETUP, ASVS_L3_MODE = false,
    // Platform primitives.
    fs, crypto, forge,
    // Auth / account state.
    attemptLogin, accountNeedsPwChange, accountService, dataWritable,
    // Live network/update state (kept live by the network service).
    updateState,
    // TLS manager surface used by the Local-CA bootstrap.
    tlsManager, localCaFeatureRelevant, localCaModeActive, localCaPaths,
    validateLocalCaCertificate, certificateFingerprint256,
    readLocalCaCertificateOnly, ensureLocalCa,
  } = deps;

  function nativeTlsRequest(req) { return !!(req && req.socket && req.socket.encrypted); }
  // Loopback-only peer check for the credential-free CA bootstrap below. The Windows
  // launcher/ServerHost routes carry their own isLoopbackRequest in
  // windows-launcher-routes.js; this local copy stays because sendLocalCaCertificate
  // remains in this composition root and must allow the pre-HTTPS loopback fetch.
  function windowsLauncherLoopback(req) {
    const addr = String(req && req.socket && req.socket.remoteAddress || '').toLowerCase().split('%')[0];
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }
  function sendLocalCaCertificate(req, res) {
    if (!localCaFeatureRelevant()) return res.status(409).json({ error:'local-ca-disabled' });
    // The root certificate is public, but bootstrap over plaintext LAN HTTP is not:
    // an on-path peer could replace it. Remote clients may fetch it without sending
    // admin credentials only over the actual native TLS socket, then verify the
    // fingerprint out-of-band. Loopback HTTP remains useful before the HTTPS restart.
    if (!nativeTlsRequest(req) && !windowsLauncherLoopback(req)) {
      return res.status(403).json({ error:'local-ca-download-requires-local-or-https' });
    }
    try {
      const p = localCaPaths();
      // While native Local-CA HTTPS is running, export exactly the trust anchor
      // that signed the certificate currently presented by this listener. A
      // restored/replaced CA on disk is pending until restart and must never be
      // bootstrapped through the still-active old TLS context.
      const ca = (localCaModeActive() && tlsManager.activeTlsCaPem)
        ? (() => {
            const cert = forge.pki.certificateFromPem(tlsManager.activeTlsCaPem);
            validateLocalCaCertificate(cert, null);
            return { certPem:tlsManager.activeTlsCaPem, cert, fingerprint:certificateFingerprint256(tlsManager.activeTlsCaPem), expiresAt:cert.validity.notAfter.getTime(), paths:p };
          })()
        : (fs.existsSync(p.caCert) ? readLocalCaCertificateOnly() : ensureLocalCa());
      const x = new crypto.X509Certificate(ca.certPem);
      res.setHeader('Content-Type', 'application/pkix-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="Direct-Xfer-Local-CA.cer"');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Direct-Xfer-CA-SHA256', ca.fingerprint || '');
      res.send(x.raw);
    } catch (e) {
      console.warn('[tls] local CA download failed:', e.message);
      res.status(500).json({ error:'local-ca-unavailable' });
    }
  }

  // Non-enumerating diagnostic hints for a failed login. Based ONLY on server
  // configuration/state (never on whether the entered username exists), so they
  // leak nothing about which accounts are present — they just help the operator
  // understand a persistent "invalid password" (env-managed owner, non-persistent
  // /data). The frontend maps each code to a localized sentence.
  function loginHints() {
    const hints = [];
    if (accountService.isEnvironmentPasswordManaged()) hints.push('env-owner'); // owner login uses ADMIN_PASSWORD
    if (!dataWritable()) hints.push('no-persist'); // accounts/pw changes don't survive a restart
    return hints;
  }

  // Login (local network only by default). The composition root gates this route
  // with adminGuard (IP allowlist) + a bounded JSON parser before this handler runs.
  async function handleLogin(req, res) {
    const username = (req.body && req.body.username) || '';
    const password = (req.body && req.body.password) || '';
    const totp = (req.body && req.body.totp) || '';
    const result = await attemptLogin(req, res, username, password, totp);
    if (result.ok) {
      const acc = result.account;
      return res.json({
        ok: true, csrf: result.csrf,
        mustChangePassword: accountNeedsPwChange(acc),
        username: acc.username, role: acc.role,
      });
    }
    if (result.busy) { res.setHeader('Retry-After',String(result.retryAfter||1)); return res.status(503).json({error:'auth-busy',retryAfter:result.retryAfter||1}); }
    if (result.locked) {
      return res.status(429).json({ error: 'too-many-attempts', retryAfter: result.retryAfter });
    }
    // Password is valid but a 2FA code is needed (or the one given is wrong).
    if (result.passkeyRequired) return res.status(401).json({ error: 'passkey-required' });
    if (result.totpRequired) return res.status(401).json({ error: 'totp-required' });
    if (result.totpInvalid) return res.status(401).json({ error: 'invalid-totp' });
    return res.status(401).json({ error: 'invalid-password', hints: loginHints() });
  }

  // Unauthenticated liveness probe for Docker HEALTHCHECK / uptime monitors.
  // Deliberately exposes no secrets and no operational counts.
  function handleHealthz(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, app: APP_NAME, version: APP_VERSION, uptime: Math.round(process.uptime()) });
  }

  // Public metadata (version, year, update availability) — for the footer/login page.
  function handleMeta(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      version: APP_VERSION,
      year: APP_YEAR,
      releaseDate: RELEASE_DATE,
      // Application-managed reusable password storage is intentionally disabled in
      // ASVS L3. Normal profiles may use the origin-bound encrypted browser vault.
      loginPasswordStorageAllowed: ASVS_L3_MODE !== true,
      update: {
        available: !!updateState.available,
        latest: updateState.available ? updateState.latest : null,
        url: updateState.available ? 'https://github.com/ManixQC/Direct-Xfer' : null,
      },
      // Login-page setup warning: are the reception / images folders still on the
      // container's ephemeral filesystem (default, un-mapped volume)? Booleans only.
      setup: {
        inboxUnconfigured: STORAGE_SETUP.inboxUnconfigured,
        imagesUnconfigured: STORAGE_SETUP.imagesUnconfigured,
      },
    });
  }

  return { sendLocalCaCertificate, loginHints, handleLogin, handleHealthz, handleMeta };
}

module.exports = { createRootRoutes };
