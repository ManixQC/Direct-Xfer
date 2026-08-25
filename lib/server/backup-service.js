'use strict';

const { assertAsvsL3OutboundUrl } = require('./asvs-l3-policy');

/**
 * Backup creation and delivery subsystem. Transactional restore is implemented by
 * restore-service.js and receives its cross-service coordination callbacks from
 * the composition root.
 */
function createBackupService(deps) {
  const {
    fs, path, crypto, forge, DATA_KEY, SECRETS_DIR, LOG_FILE, AUDIT_CHAIN_FILE,
    AUDIT_HEAD_FILE, APP_NAME, APP_VERSION, getState, localCaPaths,
    readLocalCaCertificateOnly, localCaFeatureRelevant, readManagedTlsFile,
    validateLocalCaCertificate, validateLeafCertificate, auditKeyId, ensureAuditChainKey,
    encryptStore, decryptStore, getSettings, scheduleFlush, dispatch, formatBytes,
    logAudit, DAY_MS, ASVS_L3_MODE = false, ASVS_L3_EGRESS_ALLOWLIST = '',
  } = deps;

  // Always resolve the current root state explicitly. A restore can replace the
  // whole object, and an opaque Proxy is unsafe for serialization/enumeration.
  const currentState = () => getState();
  const backupEncryptionEnabled = ASVS_L3_MODE === true || !!DATA_KEY;

  // Filesystem/URL-safe timestamp: YYYYMMDD-HHMMSS (local time).
  function backupStamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function backupFilename() { return `direct-xfer-backup-${backupStamp()}.dxbackup`; }

  // Gathers everything worth restoring into one object.
  function readBackupSourceFile(file, optional = false) {
    try { return fs.readFileSync(file); }
    catch (e) {
      if (optional && e && e.code === 'ENOENT') return null;
      const err = new Error('backup-read-failed: ' + path.basename(file));
      err.code = 'BACKUP_READ_FAILED';
      throw err;
    }
  }
  function buildTlsBackupMaterial() {
    if (ASVS_L3_MODE === true) return null; // L3 TLS private keys live at the external hardware-backed TLS edge.
    // A Local CA private key is equivalent to a trust anchor. Never place it in a
    // plaintext .dxbackup. When DATA_KEY protects the whole bundle, preserve the CA
    // so migrations/restores do not force every LAN device to trust a new root.
    if (!DATA_KEY || !forge) return null;
    const p = localCaPaths();
    if (!fs.existsSync(p.caCert)) return null;

    let ca;
    try {
      ca = readLocalCaCertificateOnly();
    } catch (e) {
      // Old/disabled TLS leftovers must not make unrelated encrypted backups fail.
      // If Local CA HTTPS is actually configured/active, fail closed because silently
      // omitting a broken trust anchor would make the backup misleading.
      if (localCaFeatureRelevant()) throw new Error('backup-local-ca-invalid: ' + e.message);
      console.warn('[backup] omitting unusable disabled Local CA material:', e.message);
      return null;
    }

    const out = { localCaCert:Buffer.from(ca.certPem).toString('base64') };
    let hasSigningKey = false, hasUsableLeaf = false;
    if (fs.existsSync(p.caKey)) {
      try {
        const keyPem = readManagedTlsFile(p.caKey, 'utf8');
        const key = forge.pki.privateKeyFromPem(keyPem);
        validateLocalCaCertificate(ca.cert, key);
        out.localCaKey = Buffer.from(keyPem).toString('base64');
        hasSigningKey = true;
      } catch (e) {
        // A valid currently-serving leaf is still worth backing up in degraded
        // recovery mode even if the CA signing key was lost/corrupted.
        console.warn('[backup] omitting invalid Local CA signing key:', e.message);
      }
    }
    if (fs.existsSync(p.serverCert) && fs.existsSync(p.serverKey)) {
      try {
        const certPem = readManagedTlsFile(p.serverCert, 'utf8');
        const keyPem = readManagedTlsFile(p.serverKey, 'utf8');
        const cert = forge.pki.certificateFromPem(certPem);
        const key = forge.pki.privateKeyFromPem(keyPem);
        validateLeafCertificate(cert, key, ca.cert, null, false, false);
        out.serverCert = Buffer.from(certPem).toString('base64');
        out.serverKey = Buffer.from(keyPem).toString('base64');
        hasUsableLeaf = true;
      } catch (e) {
        // The trust anchor is the irreplaceable part. A stale/corrupt leaf is
        // disposable when the signing key is healthy and can be re-issued later.
        console.warn('[backup] omitting invalid Local CA server certificate:', e.message);
      }
    }
    if (!hasSigningKey && !hasUsableLeaf) {
      if (localCaFeatureRelevant()) throw new Error('backup-local-ca-unrecoverable: Local CA signing key is missing and no valid server leaf is available');
      return null;
    }
    return out;
  }
  function buildBackupBundle() {
    const secrets = {};
    const root = currentState();
    const secretRows = root.meta && root.meta.secrets && typeof root.meta.secrets === 'object' ? root.meta.secrets : {};
    for (const token of Object.keys(secretRows)) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(token))) throw new Error('backup-invalid-secret-token');
      const name = token + '.dxe';
      const buf = readBackupSourceFile(path.join(SECRETS_DIR, name), false);
      secrets[name] = buf.toString('base64');
    }
    const journalBuf = readBackupSourceFile(LOG_FILE, true);
    const auditChainBuf = readBackupSourceFile(AUDIT_CHAIN_FILE, true);
    const auditHeadBuf = readBackupSourceFile(AUDIT_HEAD_FILE, true);
    return {
      app: APP_NAME, kind: 'dxbackup', v: 3, appVersion: APP_VERSION,
      createdAt: Date.now(), encrypted: backupEncryptionEnabled,
      store: root, journal: journalBuf ? journalBuf.toString('utf8') : '', secrets,
      tls: buildTlsBackupMaterial(),
      // The signing secret is deliberately NOT exported. On restore the trusted
      // backup entries are re-signed with this instance's current audit key, which
      // also makes migration between installations/keys safe.
      audit: {
        chain: auditChainBuf ? auditChainBuf.toString('base64') : '',
        head: auditHeadBuf ? auditHeadBuf.toString('base64') : '',
        keyId: auditKeyId(ensureAuditChainKey()),
      },
    };
  }

  // Bundle → on-the-wire string. Reuses the store's AES-256-GCM envelope (DATA_KEY)
  // so a backup is encrypted exactly like shares.json at rest.
  function serializeBackup(bundle) {
    const json = JSON.stringify(bundle);
    return backupEncryptionEnabled ? encryptStore(json) : json;
  }
  function parseBackup(raw) {
    const obj = JSON.parse(raw);
    const transportEncrypted = !!(obj && obj.dxenc);
    if (ASVS_L3_MODE === true && !transportEncrypted) {
      const e = new Error('asvs-l3-plaintext-backup-forbidden');
      e.code = 'ASVS_L3_PLAINTEXT_BACKUP_FORBIDDEN';
      throw e;
    }
    let bundle = obj;
    if (obj && obj.dxenc) {
      if (!DATA_KEY && ASVS_L3_MODE !== true) { const e = new Error('data-key-required'); e.code = 'DATA_KEY_REQUIRED'; throw e; }
      try { bundle = JSON.parse(decryptStore(obj)); }
      catch (cause) {
        if (ASVS_L3_MODE === true && cause && (String(cause.code || '').startsWith('asvs-crypto-') || String(cause.code || '').startsWith('ASVS_L3_'))) throw cause;
        const e = new Error('data-key-invalid'); e.code = 'DATA_KEY_INVALID'; e.cause = cause; throw e;
      }
    }
    if (!bundle || bundle.kind !== 'dxbackup' || !bundle.store || !Array.isArray(bundle.store.shares)) {
      const e = new Error('invalid-backup'); e.code = 'INVALID_BACKUP'; throw e;
    }
    Object.defineProperty(bundle, '_transportEncrypted', { value:transportEncrypted, enumerable:false, configurable:false });
    return bundle;
  }

  // --- Destination: local mounted folder (with retention) ---
  async function putBackupLocal(dir, filename, buf, retention) {
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, filename + '.tmp');
    await fs.promises.writeFile(tmp, buf, { mode: 0o600 });
    await fs.promises.rename(tmp, path.join(dir, filename));
    const keep = Math.max(0, Math.floor(Number(retention) || 0));
    if (keep > 0) {
      let names = [];
      try { names = (await fs.promises.readdir(dir)).filter((n) => /^direct-xfer-backup-.*\.dxbackup$/.test(n)); } catch (_) {}
      names.sort(); // timestamped names sort chronologically
      for (const old of names.slice(0, Math.max(0, names.length - keep))) {
        try { await fs.promises.unlink(path.join(dir, old)); } catch (_) {}
      }
    }
  }

  // --- Destination: WebDAV (HTTP PUT + optional Basic auth) ---
  async function putBackupWebdav(s, filename, buf) {
    const base = String(s.backupWebdavUrl || '').replace(/\/+$/, '') + '/';
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (s.backupWebdavUser) headers.Authorization = 'Basic ' + Buffer.from(`${s.backupWebdavUser}:${s.backupWebdavPass || ''}`).toString('base64');
    const target = base + encodeURIComponent(filename);
    assertAsvsL3OutboundUrl(target, { enabled:ASVS_L3_MODE === true, allowlist:ASVS_L3_EGRESS_ALLOWLIST });
    const res = await fetch(target, { method: 'PUT', headers, body: buf, signal: AbortSignal.timeout(120000), redirect:ASVS_L3_MODE === true ? 'error' : 'follow' });
    if (!res.ok) throw new Error(`webdav ${res.status}`);
  }

  // --- Destination: S3-compatible (AWS Signature V4, path-style PUT) ---
  async function putBackupS3(s, filename, buf) {
    const region = s.backupS3Region || 'us-east-1';
    const key = String(s.backupS3Prefix || '').replace(/^\/+|\/+$/g, '');
    const objectKey = (key ? key + '/' : '') + filename;
    const host = new URL(s.backupS3Endpoint).host;
    const encPath = '/' + encodeURIComponent(s.backupS3Bucket) + '/' + objectKey.split('/').map(encodeURIComponent).join('/');
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(buf).digest('hex');
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `PUT\n${encPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + s.backupS3Secret, dateStamp), region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${s.backupS3Key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const target = s.backupS3Endpoint.replace(/\/+$/, '') + encPath;
    assertAsvsL3OutboundUrl(target, { enabled:ASVS_L3_MODE === true, allowlist:ASVS_L3_EGRESS_ALLOWLIST });
    const res = await fetch(target, {
      method: 'PUT',
      headers: { Authorization: authorization, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'Content-Type': 'application/octet-stream' },
      body: buf, signal: AbortSignal.timeout(120000), redirect:ASVS_L3_MODE === true ? 'error' : 'follow',
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`s3 ${res.status} ${t.slice(0, 150)}`); }
  }

  // Build + serialize + push to the configured destination. Throws on any failure.
  async function runBackup(destOverride) {
    const s = getSettings();
    const dest = destOverride || s.backupDestType || 'local';
    const buf = Buffer.from(serializeBackup(buildBackupBundle()), 'utf8');
    const filename = backupFilename();
    if (dest === 'local') {
      if (!s.backupLocalDir) throw new Error('no-local-dir');
      await putBackupLocal(s.backupLocalDir, filename, buf, s.backupRetention);
      return { filename, dest: 'local:' + s.backupLocalDir, size: buf.length, encrypted: backupEncryptionEnabled };
    }
    if (dest === 'webdav') {
      if (!s.backupWebdavUrl) throw new Error('no-webdav-url');
      await putBackupWebdav(s, filename, buf);
      return { filename, dest: 'webdav', size: buf.length, encrypted: backupEncryptionEnabled };
    }
    if (dest === 's3') {
      if (ASVS_L3_MODE === true) throw new Error('asvs-l3-s3-local-signing-forbidden');
      if (!s.backupS3Endpoint || !s.backupS3Bucket || !s.backupS3Key || !s.backupS3Secret) throw new Error('s3-incomplete');
      await putBackupS3(s, filename, buf);
      return { filename, dest: 's3', size: buf.length, encrypted: backupEncryptionEnabled };
    }
    throw new Error('bad-dest');
  }

  function setBackupStatus(st) {
    const root = currentState();
    if (!root.meta || typeof root.meta !== 'object') root.meta = {};
    root.meta.lastBackup = st;
    scheduleFlush();
  }

  let backupInFlight = false;
  // Runs a backup, records status, notifies and audits. `who` is 'system' or 'admin'.
  async function performBackup(who) {
    if (backupInFlight) return { ok:false, error:'backup-busy' };
    backupInFlight = true;
    try {
      const r = await runBackup();
      setBackupStatus({ at: Date.now(), ok: true, dest: r.dest, file: r.filename, size: r.size, encrypted: r.encrypted, error: null });
      dispatch('backup', `${APP_NAME} — backup OK`,
        `💾 ${APP_NAME} — backup saved (${r.filename}, ${formatBytes(r.size)}) → ${r.dest}`,
        { file: r.filename, dest: r.dest, size: r.size });
      logAudit('backup-ok', { username: who || 'system', detail: `${r.filename} → ${r.dest}` });
      return { ok: true, ...r };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      setBackupStatus({ at: Date.now(), ok: false, dest: getSettings().backupDestType, file: null, size: 0, encrypted: backupEncryptionEnabled, error: msg });
      dispatch('backup', `${APP_NAME} — backup FAILED`, `⚠️ ${APP_NAME} — backup failed: ${msg}`, { error: msg });
      logAudit('backup-failed', { username: who || 'system', detail: msg });
      return { ok: false, error: msg };
    } finally {
      backupInFlight = false;
    }
  }

  // Called by maintenance-service's hourly pass when the schedule is due.
  function maybeRunScheduledBackup() {
    const s = getSettings();
    if (!s.backupEnabled) return;
    const now = new Date();
    if (now.getHours() !== Math.floor(Number(s.backupHour) || 0)) return;
    if (s.backupInterval === 'weekly' && now.getDay() !== Math.floor(Number(s.backupWeekday) || 0)) return;
    const root = currentState();
    const last = (root.meta && root.meta.lastBackup && root.meta.lastBackup.at) || 0;
    const minGap = s.backupInterval === 'weekly' ? 6 * DAY_MS : 20 * 3600 * 1000; // avoid double-runs
    if (now.getTime() - last < minGap) return;
    performBackup('system');
  }


  function isBackupInFlight() { return backupInFlight; }

  return {
    backupStamp, backupFilename, buildBackupBundle, serializeBackup, parseBackup,
    putBackupWebdav, putBackupS3, performBackup, maybeRunScheduledBackup, isBackupInFlight,
  };
}

module.exports = { createBackupService };
