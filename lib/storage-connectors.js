'use strict';

// Storage connectors are intentionally implemented on top of rclone instead of
// embedding seven unrelated cloud SDKs in Direct-Xfer. rclone provides one
// audited, well-documented transport for SFTP, SMB, WebDAV, Google Drive,
// OneDrive, Dropbox and Box, while credentials remain in its protected config
// file rather than shares.json or the browser.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const tls = require('tls');
const { spawn } = require('child_process');

const CONNECTOR_TYPES = new Set([
  'sftp', 'smb', 'webdav', 'google-drive', 'onedrive', 'dropbox', 'box',
]);

const RCLONE_BACKENDS = Object.freeze({
  'sftp':'sftp', 'smb':'smb', 'webdav':'webdav', 'google-drive':'drive',
  'onedrive':'onedrive', 'dropbox':'dropbox', 'box':'box',
});
const OAUTH_CONNECTOR_TYPES = new Set(['google-drive', 'onedrive', 'dropbox', 'box']);
const GOOGLE_DRIVE_RCLONE_SCOPES = Object.freeze({ limited:'drive.file', readonly:'drive.readonly', full:'drive' });
function normalizeGoogleDriveRcloneScope(value, fallback = GOOGLE_DRIVE_RCLONE_SCOPES.limited) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  for (const [mode, scope] of Object.entries(GOOGLE_DRIVE_RCLONE_SCOPES)) {
    const uri = `https://www.googleapis.com/auth/${scope}`;
    if (raw === mode || raw === scope || raw === uri) return scope;
  }
  return '';
}

function connectorBackendType(value) {
  const type = String(value || '').trim().toLowerCase();
  return CONNECTOR_TYPES.has(type) ? RCLONE_BACKENDS[type] : null;
}

function classifyRcloneFailure(stderr, fallback = 'connector-failed') {
  const text = String(stderr || '').toLowerCase();
  if (!text) return fallback;
  if (
    text.includes('x509: certificate signed by unknown authority') ||
    text.includes('certificate signed by unknown authority') ||
    text.includes('unknown certificate authority') ||
    text.includes('unable to get local issuer certificate') ||
    text.includes('certificate verify failed')
  ) return 'connector-tls-ca-untrusted';
  if (
    text.includes('failed to save config') ||
    text.includes('failed to load config file') ||
    text.includes('failed to create config') ||
    text.includes('could not create config') ||
    text.includes("couldn't create config") ||
    text.includes('rclone.conf') && (
      text.includes('no such file or directory') ||
      text.includes('permission denied') ||
      text.includes('access is denied') ||
      text.includes('read-only file system')
    )
  ) return 'connector-config-storage';
  if (
    text.includes('invalid character') && text.includes('token') ||
    text.includes('failed to parse token') ||
    text.includes('invalid oauth token') ||
    text.includes('empty token found')
  ) return 'connector-token-invalid';
  if (
    text.includes('accessnotconfigured') ||
    text.includes('api has not been used') ||
    text.includes('drive api') && text.includes('disabled') ||
    text.includes('enable it by visiting')
  ) return 'connector-api-disabled';
  if (
    text.includes("didn't find section in config file") ||
    text.includes('did not find section in config file') ||
    text.includes('config section not found') ||
    text.includes('failed to find config section')
  ) return 'remote-not-found';
  if (
    text.includes('invalid_grant') ||
    text.includes('token has been expired or revoked') ||
    text.includes('authentication failed') ||
    text.includes('failed to authenticate') ||
    text.includes('invalid credentials') ||
    text.includes('unauthorized') ||
    /(?:^|\D)401(?:\D|$)/.test(text)
  ) return 'connector-auth-failed';
  if (
    text.includes('permission denied') ||
    text.includes('access denied') ||
    text.includes('forbidden') ||
    /(?:^|\D)403(?:\D|$)/.test(text)
  ) return 'connector-forbidden';
  if (
    text.includes('directory not found') ||
    text.includes('file not found') ||
    text.includes('object not found') ||
    text.includes('item not found') ||
    /(?:^|\D)404(?:\D|$)/.test(text)
  ) return 'connector-not-found';
  if (
    text.includes('too many requests') ||
    text.includes('rate limit') ||
    text.includes('ratelimit') ||
    /(?:^|\D)429(?:\D|$)/.test(text)
  ) return 'connector-rate-limited';
  if (
    text.includes('connection refused') ||
    text.includes('network is unreachable') ||
    text.includes('no such host') ||
    text.includes('name resolution') ||
    text.includes('tls handshake timeout') ||
    text.includes('dial tcp')
  ) return 'connector-unreachable';
  return fallback;
}

function sanitizeRcloneDiagnostic(value) {
  let text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!text) return '';
  // Diagnostics may be returned to an authenticated administrator. Keep them
  // useful without ever reflecting OAuth tokens, bearer credentials or JSON
  // blobs that rclone could mention in an error.
  text = text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/ig, '$1[redacted]')
    .replace(/([?&](?:access_token|refresh_token|client_secret|code)=)[^&\s]+/ig, '$1[redacted]')
    .replace(/(\b(?:access_token|refresh_token|client_secret)\b\s*(?:=|:)\s*[\"']?)[^\"'\s,}]+/ig, '$1[redacted]')
    .replace(/\{[^{}]{0,65536}\"access_token\"[^{}]{0,65536}\}/ig, '[oauth-token-redacted]')
    .replace(/\bdxr_[A-Za-z0-9_-]{8,}\b/g, 'dxr_[redacted]')
    .replace(/\bdxc_[A-Za-z0-9_-]{8,}\b/g, 'dxc_[redacted]');
  return text.slice(0, 500);
}

function enrichRcloneError(error, stage) {
  const current = error instanceof Error ? error : new Error(String(error || 'rclone failed'));
  if (!current.rcloneStage) current.rcloneStage = String(stage || 'rclone');
  const diagnostic = sanitizeRcloneDiagnostic(current.rcloneStderr || current.message);
  if (diagnostic) current.rcloneDiagnostic = diagnostic;
  if (!current.code || current.code === 'connector-failed') {
    if (current.rcloneStage === 'google-rclone-config-write') current.code = 'connector-config-write-failed';
    else if (current.rcloneStage === 'google-rclone-verify') current.code = 'connector-google-probe-failed';
  }
  return current;
}

const CONNECTOR_PUBLIC_ERROR_CODES = new Set([
  'rclone-unavailable', 'remote-not-found', 'connector-not-found', 'connector-failed',
  'connector-cancelled', 'connector-terminated', 'connector-timeout', 'connector-staging-unavailable',
  'connector-auth-failed', 'connector-forbidden', 'connector-unreachable', 'connector-rate-limited',
  'connector-response', 'connector-tls-ca-untrusted', 'connector-config-storage', 'connector-token-invalid',
  'connector-api-disabled', 'connector-config-write-failed', 'connector-google-probe-failed',
  'connector-rollback-failed', 'read-only', 'not-file', 'not-dir', 'invalid-source', 'name-exhausted',
  'infected', 'server-restarted',
]);
function connectorErrorCode(error) {
  const code = String(error && error.code || 'connector-failed');
  return CONNECTOR_PUBLIC_ERROR_CODES.has(code) ? code : 'connector-failed';
}
function connectorHttpStatus(errorOrCode, options = {}) {
  const code = typeof errorOrCode === 'string' ? errorOrCode : connectorErrorCode(errorOrCode);
  if (code === 'remote-not-found' || code === 'connector-not-found') return 404;
  if (code === 'read-only') return 409;
  if (code === 'connector-timeout') return options.public ? 503 : 504;
  if (['rclone-unavailable','connector-config-storage','connector-unreachable','connector-rate-limited','connector-cancelled','connector-terminated','connector-staging-unavailable'].includes(code)) return 503;
  return 502;
}

function safeRcloneErrorDetail(error) {
  if (!error || typeof error !== 'object') return null;
  const stage = String(error.rcloneStage || '').slice(0, 80);
  const code = String(error.code || 'connector-failed').slice(0, 120);
  const diagnostic = sanitizeRcloneDiagnostic(error.rcloneDiagnostic || error.rcloneStderr || error.message);
  const exitCode = Number.isInteger(error.exitCode) ? error.exitCode : null;
  if (!stage && !diagnostic && exitCode === null) return null;
  return { stage, code, exitCode, diagnostic };
}

function classifyOAuthFailure(output, fallback = 'oauth-failed') {
  const text = String(output || '').toLowerCase();
  if (!text) return fallback;
  if (
    text.includes('address already in use') ||
    text.includes('only one usage of each socket address') ||
    text.includes('forbidden by its access permissions') ||
    text.includes('failed to start auth webserver') ||
    text.includes('failed to start oauth webserver') ||
    (text.includes('53682') && (text.includes('bind') || text.includes('listen tcp')))
  ) return 'oauth-loopback-port-unavailable';
  if (
    text.includes('invalid_client') ||
    text.includes('unauthorized_client') ||
    text.includes('oauth client was deleted') ||
    text.includes('client id') && text.includes('invalid')
  ) return 'oauth-invalid-client';
  if (
    text.includes('access_denied') ||
    text.includes('authorization denied') ||
    text.includes('authorisation denied') ||
    text.includes('user denied') ||
    text.includes('cancelled by user') ||
    text.includes('canceled by user')
  ) return 'oauth-access-denied';
  if (
    text.includes('failed to get token') ||
    text.includes('failed to exchange') ||
    text.includes('token exchange') ||
    text.includes('oauth2: cannot fetch token') ||
    text.includes('invalid_grant')
  ) return 'oauth-token-exchange-failed';
  if (
    text.includes('connection refused') ||
    text.includes('network is unreachable') ||
    text.includes('no such host') ||
    text.includes('tls handshake timeout') ||
    text.includes('dial tcp')
  ) return 'oauth-provider-unreachable';
  return fallback;
}

function cleanRemoteName(value) {
  const remote = String(value || '').trim().replace(/:$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote) ? remote : null;
}

function cleanRelativePath(value, allowEmpty = true) {
  const normalized = String(value == null ? '' : value).replace(/\\/g, '/');
  const raw = normalized.trim();
  // Never silently retarget a remote object by trimming its actual path. Cloud
  // backends may permit leading/trailing spaces, so ambiguous paths are rejected.
  if (raw !== normalized) return null;
  if (!raw) return allowEmpty ? '' : null;
  // Control characters are legal in some remote filesystems but are unsafe in
  // logs, job labels and Content-Disposition values. Reject them consistently
  // instead of letting rclone return an entry the UI cannot safely address.
  if (/[\0-\x1f\x7f]/.test(raw) || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return allowEmpty ? '' : null;
  if (parts.some((part) => part === '.' || part === '..' || part.length > 255)) return null;
  const out = parts.join('/');
  return out.length <= 4096 ? out : null;
}

function normalizeConnector(input, previous) {
  const src = input && typeof input === 'object' ? input : {};
  const old = previous && typeof previous === 'object' ? previous : {};
  const type = String(src.type == null ? old.type || '' : src.type).trim().toLowerCase();
  const remote = cleanRemoteName(src.remote == null ? old.remote : src.remote);
  const root = cleanRelativePath(src.root == null ? old.root || '' : src.root);
  const name = String(src.name == null ? old.name || '' : src.name)
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  if (!CONNECTOR_TYPES.has(type)) throw Object.assign(new Error('invalid-connector-type'), { code:'EINVAL' });
  if (!remote) throw Object.assign(new Error('invalid-connector-remote'), { code:'EINVAL' });
  if (root === null) throw Object.assign(new Error('invalid-connector-root'), { code:'EINVAL' });
  if (!name) throw Object.assign(new Error('invalid-connector-name'), { code:'EINVAL' });
  return {
    id: String(old.id || src.id || '').slice(0, 64),
    name,
    type,
    remote,
    root,
    readOnly: src.readOnly == null ? !!old.readOnly : !!src.readOnly,
    createdAt: Number(old.createdAt || src.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

function remoteSpec(connector, relative) {
  const rel = cleanRelativePath(relative);
  if (rel === null) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
  const pieces = [connector.root, rel].filter(Boolean);
  return `${connector.remote}:${pieces.join('/')}`;
}

function safeLocalTarget(root, relative) {
  const rel = cleanRelativePath(relative, false);
  if (rel === null || rel.split('/').some((segment) => segment.toLowerCase().startsWith('.dx'))) {
    throw Object.assign(new Error('invalid-local-path'), { code:'EINVAL' });
  }
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw Object.assign(new Error('invalid-local-path'), { code:'EINVAL' });
  }
  return target;
}

async function secureLocalParent(root, target) {
  const base = path.resolve(root);
  const parent = path.dirname(path.resolve(target));
  const rel = path.relative(base, parent);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
    throw Object.assign(new Error('invalid-local-path'), { code:'EINVAL' });
  }
  await fs.promises.mkdir(base, { recursive:true, mode:0o700 });
  const realBase = await fs.promises.realpath(base);
  let current = base;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('unsafe-local-parent'), { code:'EINVAL' });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      try { await fs.promises.mkdir(current, { mode:0o700 }); }
      catch (mkdirError) { if (!mkdirError || mkdirError.code !== 'EEXIST') throw mkdirError; }
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('unsafe-local-parent'), { code:'EINVAL' });
    }
    const realCurrent = await fs.promises.realpath(current);
    if (realCurrent !== realBase && !realCurrent.startsWith(realBase + path.sep)) {
      throw Object.assign(new Error('unsafe-local-parent'), { code:'EINVAL' });
    }
  }
}

async function publishImportNoClobber(temporary, initialTarget) {
  const parsed = path.parse(initialTarget);
  for (let n = 0; n < 10000; n++) {
    const target = n === 0 ? initialTarget : path.join(parsed.dir, `${parsed.name} (${n})${parsed.ext}`);
    try {
      // A hard link publishes the fully downloaded temporary file atomically and
      // fails with EEXIST instead of overwriting a concurrent import.
      await fs.promises.link(temporary, target);
      await fs.promises.unlink(temporary);
      return target;
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      if (error && ['EXDEV','EPERM','EACCES','ENOTSUP'].includes(error.code)) {
        try {
          await fs.promises.copyFile(temporary, target, fs.constants.COPYFILE_EXCL);
          await fs.promises.unlink(temporary);
          return target;
        } catch (copyError) {
          if (copyError && copyError.code === 'EEXIST') continue;
          throw copyError;
        }
      }
      throw error;
    }
  }
  throw Object.assign(new Error('connector-import-name-exhausted'), { code:'name-exhausted' });
}

class StorageConnectorService {
  constructor(options = {}) {
    this.bin = String(options.bin || process.env.RCLONE_BIN || 'rclone');
    this.configPath = path.resolve(options.configPath || process.env.RCLONE_CONFIG || '/data/rclone/rclone.conf');
    this.importRoot = path.resolve(options.importRoot || '/Direct-Xfer/Imports');
    this.timeoutMs = Math.max(5000, Number(options.timeoutMs) || 5 * 60 * 1000);
    this.caBundlePath = path.resolve(options.caBundlePath || process.env.DIRECT_XFER_RCLONE_CA_BUNDLE || path.join(path.dirname(this.configPath), 'direct-xfer-ca-bundle.pem'));
    this.customCaPath = String(options.customCaPath || process.env.DIRECT_XFER_RCLONE_CA_FILE || '').trim();
    this.customCaDir = path.resolve(options.customCaDir || process.env.DIRECT_XFER_RCLONE_CA_DIR || path.join(path.dirname(this.configPath), 'ca'));
    this._rcloneCaBundle = '';
    this._tlsTrustPromise = null;
    // Serialize Direct-Xfer initiated rclone.conf mutations. rclone protects its own
    // writes, but a replace operation spans several commands and must be atomic from
    // Direct-Xfer's point of view so two admin requests cannot interleave them.
    this._configMutationTail = Promise.resolve();
  }

  _withConfigMutation(task) {
    const run = this._configMutationTail.then(() => task(), () => task());
    this._configMutationTail = run.catch(() => {});
    return run;
  }

  async _ensureConfigStorage() {
    const dir = path.dirname(this.configPath);
    try {
      await fs.promises.mkdir(dir, { recursive:true, mode:0o700 });
      const dirStat = await fs.promises.lstat(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('unsafe rclone config directory');
      try { await fs.promises.chmod(dir, 0o700); } catch (_) {}
      try {
        const stat = await fs.promises.lstat(this.configPath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe rclone config file');
        try { await fs.promises.chmod(this.configPath, 0o600); } catch (_) {}
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      return dir;
    } catch (error) {
      const failed = new Error(`rclone config storage unavailable: ${String(error && error.message || error)}`);
      failed.code = 'connector-config-storage';
      failed.rcloneStage = 'rclone-config-storage';
      failed.rcloneDiagnostic = sanitizeRcloneDiagnostic(error && error.message || error);
      throw failed;
    }
  }

  async _runRcloneStage(stage, args, options = {}) {
    try { return await this.run(args, options); }
    catch (error) { throw enrichRcloneError(error, stage); }
  }

  async _ensureTlsTrust() {
    if (this._tlsTrustPromise) return this._tlsTrustPromise;
    this._tlsTrustPromise = (async () => {
      const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
      const certificates = new Map();
      const addPem = (value) => {
        const matches = String(value || '').match(certificatePattern) || [];
        for (const certificate of matches) {
          const normalized = `${certificate.trim()}\n`;
          const digest = crypto.createHash('sha256').update(normalized).digest('hex');
          if (!certificates.has(digest)) certificates.set(digest, normalized);
        }
      };
      const addFile = async (file) => {
        const candidate = String(file || '').trim();
        if (!candidate || path.resolve(candidate) === this.caBundlePath) return;
        try { addPem(await fs.promises.readFile(candidate, 'utf8')); } catch (_) {}
      };

      // Node ships a maintained public-root set even in minimal/self-contained
      // deployments. Merge it with the host/container roots instead of disabling
      // certificate verification when a slim image has an incomplete CA store.
      for (const certificate of tls.rootCertificates || []) addPem(certificate);
      const systemCandidates = [
        process.env.SSL_CERT_FILE,
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/pki/tls/certs/ca-bundle.crt',
        '/etc/ssl/ca-bundle.pem',
        '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
        this.customCaPath,
      ];
      for (const candidate of systemCandidates) await addFile(candidate);
      try {
        const names = await fs.promises.readdir(this.customCaDir);
        for (const name of names.sort()) {
          if (!/\.(?:pem|crt|cer)$/i.test(name)) continue;
          await addFile(path.join(this.customCaDir, name));
        }
      } catch (_) {}

      if (!certificates.size) return { available:false, path:'' };
      try {
        await fs.promises.mkdir(path.dirname(this.caBundlePath), { recursive:true, mode:0o700 });
        const content = Array.from(certificates.values()).join('\n');
        let current = '';
        try { current = await fs.promises.readFile(this.caBundlePath, 'utf8'); } catch (_) {}
        if (current !== content) {
          const temporary = `${this.caBundlePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
          await fs.promises.writeFile(temporary, content, { mode:0o600, flag:'wx' });
          try { await fs.promises.rename(temporary, this.caBundlePath); }
          catch (error) {
            try { await fs.promises.unlink(this.caBundlePath); } catch (_) {}
            try { await fs.promises.rename(temporary, this.caBundlePath); }
            catch (renameError) { try { await fs.promises.unlink(temporary); } catch (_) {} throw renameError; }
          }
        }
        try { await fs.promises.chmod(this.caBundlePath, 0o600); } catch (_) {}
        this._rcloneCaBundle = this.caBundlePath;
        return { available:true, path:this.caBundlePath, certificates:certificates.size };
      } catch (_) {
        // A read-only/custom deployment may prevent creation of the merged bundle.
        // Keep the platform trust store as a safe fallback; never disable TLS.
        this._rcloneCaBundle = '';
        return { available:false, path:'' };
      }
    })();
    return this._tlsTrustPromise;
  }

  commandEnv() {
    const env = {};
    // Use an allow-list rather than trying to keep a deny-list synchronized with
    // every future Direct-Xfer secret. RCLONE_* covers encrypted configuration
    // and backend environment settings; the remaining names are only needed for
    // executable discovery, certificates, locale and proxies.
    const safeNames = new Set([
      'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
      'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ]);
    for (const [name, value] of Object.entries(process.env)) {
      const upper = name.toUpperCase();
      if (upper === 'RCLONE_CONFIG' || upper === 'RCLONE_ASK_PASSWORD') continue;
      if (safeNames.has(upper) || upper.startsWith('RCLONE_')) env[name] = value;
    }
    env.RCLONE_CONFIG = this.configPath;
    env.RCLONE_ASK_PASSWORD = 'false';
    if (this._rcloneCaBundle) env.SSL_CERT_FILE = this._rcloneCaBundle;
    return env;
  }

  async run(args, options = {}) {
    await this._ensureTlsTrust();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || this.timeoutMs);
    const maxOutput = Math.max(4096, Number(options.maxOutput) || 4 * 1024 * 1024);
    return new Promise((resolve, reject) => {
      // A configured JavaScript wrapper is executed explicitly with the current
      // Node runtime. This keeps test/custom rclone adapters portable on Windows,
      // where shebang + chmod does not make an extensionless script executable,
      // while avoiding shell:true and its command-injection/quoting hazards.
      const nodeWrapper = /\.(?:c|m)?js$/i.test(this.bin) && fs.existsSync(this.bin);
      const command = nodeWrapper ? process.execPath : this.bin;
      const commandArgs = nodeWrapper ? [this.bin, ...args] : args;
      const child = spawn(command, commandArgs, {
        env:this.commandEnv(), stdio:['ignore', 'pipe', 'pipe'], windowsHide:true,
      });
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), settled = false, timedOut = false, forceKillTimer = null;
      const append = (current, chunk) => {
        if (current.length >= maxOutput) return current;
        const room = maxOutput - current.length;
        return Buffer.concat([current, chunk.subarray(0, room)]);
      };
      child.stdout.on('data', (chunk) => { stdout = append(stdout, Buffer.from(chunk)); });
      child.stderr.on('data', (chunk) => { stderr = append(stderr, Buffer.from(chunk)); });
      const terminate = () => {
        try { child.kill('SIGTERM'); } catch (_) {}
        if (!forceKillTimer) forceKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1500).unref();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, timeoutMs);
      const abort = () => terminate();
      if (options.signal) {
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once:true });
      }
      child.once('error', (error) => {
        if (settled) return; settled = true; clearTimeout(timer); if (forceKillTimer) clearTimeout(forceKillTimer);
        if (options.signal) options.signal.removeEventListener('abort', abort);
        error.code = error.code === 'ENOENT' ? 'rclone-unavailable' : (error.code || 'connector-failed');
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return; settled = true; clearTimeout(timer); if (forceKillTimer) clearTimeout(forceKillTimer);
        if (options.signal) options.signal.removeEventListener('abort', abort);
        const out = stdout.toString('utf8'), err = stderr.toString('utf8').trim();
        if (code === 0) return resolve({ stdout:out, stderr:err });
        const error = new Error((err || `rclone exited with code ${code}`).slice(0, 1000));
        error.code = options.signal && options.signal.aborted ? 'connector-cancelled'
          : timedOut ? 'connector-timeout'
          : signal ? 'connector-terminated'
          : classifyRcloneFailure(err, 'connector-failed');
        error.exitCode = code;
        error.rcloneStderr = err.slice(0, 4096);
        if (error.code === 'connector-tls-ca-untrusted') {
          // A custom root may be added after this diagnostic is shown. Force the
          // next retry to rebuild the merged bundle without requiring a restart.
          this._tlsTrustPromise = null;
          this._rcloneCaBundle = '';
        }
        reject(error);
      });
    });
  }

  async capabilities() {
    try {
      const result = await this.run(['version'], { timeoutMs:10000, maxOutput:64 * 1024 });
      const first = result.stdout.split(/\r?\n/).find(Boolean) || 'rclone';
      return { available:true, version:first.trim(), configPath:this.configPath };
    } catch (error) {
      return { available:false, error:error.code || 'rclone-unavailable', configPath:this.configPath };
    }
  }

  async configuredRemotes() {
    const result = await this.run(['listremotes'], { timeoutMs:15000, maxOutput:128 * 1024 });
    return result.stdout.split(/\r?\n/).map(cleanRemoteName).filter(Boolean);
  }

  async googleRemoteInfo(remoteName) {
    const remote = cleanRemoteName(remoteName);
    if (!remote) throw Object.assign(new Error('invalid-rclone-config'), { code:'EINVAL' });
    let content = '';
    try {
      const stat = await fs.promises.stat(this.configPath);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
      content = await fs.promises.readFile(this.configPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    const values = Object.create(null);
    let active = false;
    for (const line of content.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (section) {
        active = section[1] === remote;
        continue;
      }
      if (!active || /^\s*[#;]/.test(line) || !line.includes('=')) continue;
      const index = line.indexOf('=');
      const key = line.slice(0, index).trim().toLowerCase();
      const value = line.slice(index + 1).trim();
      if (key && !(key in values)) values[key] = value;
    }
    if (!Object.keys(values).length || String(values.type || '').trim().toLowerCase() !== 'drive') return null;
    const configuredShort = normalizeGoogleDriveRcloneScope(values.scope || GOOGLE_DRIVE_RCLONE_SCOPES.full, GOOGLE_DRIVE_RCLONE_SCOPES.full);
    const configuredScope = configuredShort ? `https://www.googleapis.com/auth/${configuredShort}` : '';
    let grantedScope = '';
    const rawToken = String(values.token || '').trim();
    if (rawToken.startsWith('{') && rawToken.length <= 1024 * 1024) {
      try {
        const token = JSON.parse(rawToken);
        grantedScope = String(token && token.scope || '').trim().slice(0, 4096);
      } catch (_) {}
    }
    const tokenUrl = String(values.token_url || '').trim();
    const broker = /\/v1\/google\/token\/?$/i.test(tokenUrl) || /^dxc_[A-Za-z0-9_-]{8,240}$/.test(String(values.client_id || '').trim());
    return { remote, type:'google-drive', configuredScope, grantedScope, broker };
  }

  // rclone exposes an application-friendly, non-interactive configuration state
  // machine. Direct-Xfer keeps the opaque state server-side and only returns a
  // sanitized question to the authenticated admin UI. This lets first-time users
  // configure a remote without dropping to a terminal.
  _configParameterArgs(connectorType, parameters) {
    const type = String(connectorType || '').trim().toLowerCase();
    const source = parameters && typeof parameters === 'object' ? parameters : {};
    if (type !== 'google-drive') return [];
    const clientId = String(source.client_id || '').trim();
    const clientSecret = String(source.client_secret || '').trim();
    const requestedScope = normalizeGoogleDriveRcloneScope(source.scope);
    if (!requestedScope) throw Object.assign(new Error('invalid-google-drive-scope'), { code:'invalid-google-drive-scope' });
    const args = ['scope', requestedScope];
    // Normal Google Drive sign-in needs no administrator-supplied JSON. When no
    // custom OAuth client is configured, keep only the least-privilege scope and
    // let rclone use its built-in Google client. A custom pair remains supported.
    if (!clientId && !clientSecret) return args;
    if (!clientId || clientId.length > 1024 || /[\x00-\x20\x7f]/.test(clientId) || !clientId.toLowerCase().endsWith('.apps.googleusercontent.com')) {
      throw Object.assign(new Error('invalid-google-client-id'), { code:'oauth-google-client-id-required' });
    }
    if (!clientSecret || clientSecret.length > 2048 || /[\r\n\0]/.test(clientSecret)) {
      throw Object.assign(new Error('invalid-google-client-secret'), { code:'oauth-google-client-secret-required' });
    }
    return [...args, 'client_id', clientId, 'client_secret', clientSecret];
  }

  async configCreateStart(remoteName, connectorType, options = {}) {
    const remote = cleanRemoteName(remoteName);
    const backend = connectorBackendType(connectorType);
    if (!remote || !backend) throw Object.assign(new Error('invalid-rclone-config'), { code:'EINVAL' });
    return this._withConfigMutation(async () => {
      await this._ensureConfigStorage();
      const existing = await this.configuredRemotes();
      if (existing.includes(remote)) throw Object.assign(new Error('rclone-remote-exists'), { code:'remote-exists' });
      const args = ['config', 'create', remote, backend, ...this._configParameterArgs(connectorType, options.parameters), '--non-interactive'];
      // OAuth providers have sensible normal defaults. Skipping --all takes users
      // directly to account authorization instead of forcing them through every
      // advanced backend option first. Password/host based transports still use the
      // full wizard because those fields are the configuration itself.
      if (!OAUTH_CONNECTOR_TYPES.has(String(connectorType || '').toLowerCase())) args.push('--all');
      const result = await this.run(args, { timeoutMs:30000, maxOutput:1024 * 1024 });
      return this.parseConfigQuestion(result.stdout);
    });
  }

  async configContinue(remoteName, state, answer, options = {}) {
    const remote = cleanRemoteName(remoteName);
    const opaqueState = String(state || '');
    if (!remote || !opaqueState || opaqueState.length > 8192) {
      throw Object.assign(new Error('invalid-rclone-config-state'), { code:'EINVAL' });
    }
    return this._withConfigMutation(async () => {
      const args = [
        'config', 'update', remote, ...this._configParameterArgs(options.connectorType, options.parameters),
        '--continue', '--state', opaqueState,
        '--result', String(answer == null ? '' : answer), '--non-interactive',
      ];
      if (options.all) args.push('--all');
      const result = await this.run(args, { timeoutMs:30000, maxOutput:1024 * 1024 });
      return this.parseConfigQuestion(result.stdout);
    });
  }

  // rclone's non-interactive config protocol can emit transition states which
  // contain a State but no Option. Those states are not questions for the user;
  // the caller must continue them with an empty result until a real question (or
  // completion) is reached. In particular OAuth commonly goes
  // config_is_local -> *oauth-remote -> config_token.
  async configContinueToQuestion(remoteName, state, answer, options = {}) {
    let next = await this.configContinue(remoteName, state, answer, options);
    for (let i = 0; i < 12 && next && !next.done && next.state && !next.option; i++) {
      if (next.error) {
        throw Object.assign(new Error(next.error), { code:'connector-config-error' });
      }
      next = await this.configContinue(remoteName, next.state, '', options);
    }
    if (next && !next.done && next.state && !next.option) {
      throw Object.assign(new Error('rclone config transition limit exceeded'), { code:'connector-config-transition' });
    }
    return next;
  }

  // Prepare the exact headless OAuth command rclone generated for this remote.
  // The second argument to `rclone authorize` is an encoded config map containing
  // non-default backend settings (client ID/secret, tenant, region, etc.). Using
  // a generic `rclone authorize <backend>` silently discards those settings.
  async prepareOAuthAuthorization(remoteName, connectorType, state, options = {}) {
    const backend = connectorBackendType(connectorType);
    if (!backend || !OAUTH_CONNECTOR_TYPES.has(String(connectorType || '').toLowerCase())) {
      throw Object.assign(new Error('oauth-not-supported'), { code:'oauth-not-supported' });
    }
    const question = await this.configContinueToQuestion(remoteName, state, 'false', options);
    if (!question || question.done || String(question.option && question.option.Name || '') !== 'config_token') {
      throw Object.assign(new Error('rclone OAuth token step missing'), { code:'oauth-token-step-missing' });
    }
    const help = String(question.option && question.option.Help || '');
    const match = help.match(/(?:^|\n)\s*rclone\s+authorize\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'\r\n]+))(?:\s+(?:"([A-Za-z0-9+/_=-]+)"|'([A-Za-z0-9+/_=-]+)'|([A-Za-z0-9+/_=-]+)))?/i);
    if (!match) throw Object.assign(new Error('rclone OAuth authorize command missing'), { code:'oauth-authorize-command-missing' });
    const commandBackend = String(match[1] || match[2] || match[3] || '').trim();
    const configBlob = String(match[4] || match[5] || match[6] || '').trim();
    if (commandBackend !== backend) {
      throw Object.assign(new Error('rclone OAuth backend mismatch'), { code:'oauth-authorize-backend-mismatch' });
    }
    if (configBlob && (configBlob.length > 1024 * 1024 || !/^[A-Za-z0-9+/_=-]+$/.test(configBlob))) {
      throw Object.assign(new Error('invalid rclone OAuth config blob'), { code:'oauth-authorize-config-invalid' });
    }
    return { question, authorizeArgs:configBlob ? [backend, configBlob] : [backend] };
  }

  parseConfigQuestion(raw) {
    const text = String(raw || '').trim();
    if (!text) return { done:true, state:'', option:null, error:'' };
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (_) { throw Object.assign(new Error('invalid-rclone-config-response'), { code:'connector-response' }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('invalid-rclone-config-response'), { code:'connector-response' });
    }
    const state = String(parsed.State || '');
    const option = parsed.Option && typeof parsed.Option === 'object' ? parsed.Option : null;
    return {
      done:!state, state, option, error:String(parsed.Error || '').slice(0,1000),
      result:parsed.Result == null ? '' : String(parsed.Result),
    };
  }

  _googleServiceAccountDir() {
    return path.resolve(path.dirname(this.configPath), 'service-accounts');
  }

  _googleServiceAccountPath(remoteName) {
    const remote = cleanRemoteName(remoteName);
    if (!remote) throw Object.assign(new Error('invalid-rclone-remote'), { code:'EINVAL' });
    return path.join(this._googleServiceAccountDir(), `${remote}.json`);
  }

  async _snapshotFile(file) {
    try {
      const [data, stat] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
      return { exists:true, data, mode:stat.mode & 0o777 };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { exists:false, data:null, mode:0 };
      throw error;
    }
  }

  async _restoreFile(file, snapshot, defaultMode) {
    const snap = snapshot || { exists:false };
    if (!snap.exists) {
      try { await fs.promises.unlink(file); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      return;
    }
    await fs.promises.mkdir(path.dirname(file), { recursive:true, mode:0o700 });
    const tmp = `${file}.restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.promises.writeFile(tmp, snap.data, { mode:snap.mode || defaultMode || 0o600, flag:'wx' });
      await fs.promises.rename(tmp, file);
      try { await fs.promises.chmod(file, snap.mode || defaultMode || 0o600); } catch (_) {}
    } finally {
      try { await fs.promises.unlink(tmp); } catch (_) {}
    }
  }

  async _ensureGoogleServiceAccountDir() {
    const dir = this._googleServiceAccountDir();
    await fs.promises.mkdir(dir, { recursive:true, mode:0o700 });
    const stat = await fs.promises.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw Object.assign(new Error('unsafe-google-service-account-dir'), { code:'google-service-account-storage-unsafe' });
    }
    try { await fs.promises.chmod(dir, 0o700); } catch (_) {}
    return dir;
  }

  _normalizeGoogleServiceAccount(input) {
    let parsed = input;
    if (typeof parsed === 'string') {
      if (!parsed || parsed.length > 1024 * 1024) throw Object.assign(new Error('invalid-google-service-account'), { code:'google-service-account-invalid' });
      try { parsed = JSON.parse(parsed); } catch (_) { throw Object.assign(new Error('invalid-google-service-account'), { code:'google-service-account-invalid' }); }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('invalid-google-service-account'), { code:'google-service-account-invalid' });
    const type = String(parsed.type || '').trim();
    const clientEmail = String(parsed.client_email || '').trim().toLowerCase();
    const privateKey = String(parsed.private_key || '');
    const tokenUri = String(parsed.token_uri || '').trim();
    const authUri = String(parsed.auth_uri || '').trim();
    const certUri = String(parsed.auth_provider_x509_cert_url || '').trim();
    const clientCertUri = String(parsed.client_x509_cert_url || '').trim();
    const universeDomain = String(parsed.universe_domain || 'googleapis.com').trim().toLowerCase();
    const clientId = String(parsed.client_id || '').trim();
    if (type !== 'service_account' || !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(clientEmail)) {
      throw Object.assign(new Error('invalid-google-service-account'), { code:'google-service-account-invalid' });
    }
    if (privateKey.length < 100 || privateKey.length > 64 * 1024 || !/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(privateKey)) {
      throw Object.assign(new Error('invalid-google-service-account-key'), { code:'google-service-account-invalid' });
    }
    try {
      const key = crypto.createPrivateKey({ key:privateKey, format:'pem' });
      if (key.asymmetricKeyType !== 'rsa') throw new Error('not-rsa');
    } catch (_) {
      throw Object.assign(new Error('invalid-google-service-account-key'), { code:'google-service-account-invalid' });
    }
    if (clientId && !/^\d{10,32}$/.test(clientId)) throw Object.assign(new Error('invalid-google-service-account-client-id'), { code:'google-service-account-invalid' });
    if (tokenUri && tokenUri !== 'https://oauth2.googleapis.com/token' && tokenUri !== 'https://accounts.google.com/o/oauth2/token') {
      throw Object.assign(new Error('invalid-google-service-account-token-uri'), { code:'google-service-account-invalid' });
    }
    if (authUri && authUri !== 'https://accounts.google.com/o/oauth2/auth') throw Object.assign(new Error('invalid-google-service-account-auth-uri'), { code:'google-service-account-invalid' });
    if (certUri && certUri !== 'https://www.googleapis.com/oauth2/v1/certs') throw Object.assign(new Error('invalid-google-service-account-cert-uri'), { code:'google-service-account-invalid' });
    if (clientCertUri && !clientCertUri.startsWith('https://www.googleapis.com/robot/v1/metadata/x509/')) throw Object.assign(new Error('invalid-google-service-account-client-cert-uri'), { code:'google-service-account-invalid' });
    if (universeDomain !== 'googleapis.com') throw Object.assign(new Error('invalid-google-service-account-universe'), { code:'google-service-account-invalid' });
    const projectId = String(parsed.project_id || '').trim();
    if (projectId && (projectId.length > 256 || /[\x00-\x20\x7f]/.test(projectId))) throw Object.assign(new Error('invalid-google-service-account-project'), { code:'google-service-account-invalid' });
    // Persist only the standard Google fields with security-sensitive endpoints pinned
    // to Google. A crafted JSON file cannot redirect JWT/token traffic to another host.
    const clean = {
      type:'service_account',
      project_id:projectId,
      private_key_id:String(parsed.private_key_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 512),
      private_key:privateKey,
      client_email:clientEmail,
      client_id:clientId,
      auth_uri:'https://accounts.google.com/o/oauth2/auth',
      token_uri:tokenUri || 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url:'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url:clientCertUri,
      universe_domain:'googleapis.com',
    };
    return { credentials:clean, clientEmail };
  }

  validateGoogleServiceAccount(credentials) {
    const normalized = this._normalizeGoogleServiceAccount(credentials);
    return { clientEmail:normalized.clientEmail };
  }

  async _writeGoogleServiceAccountFile(remote, normalized) {
    await this._ensureGoogleServiceAccountDir();
    const file = this._googleServiceAccountPath(remote);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(normalized.credentials), { mode:0o600, flag:'wx' });
      try { await fs.promises.chmod(tmp, 0o600); } catch (_) {}
      await fs.promises.rename(tmp, file);
      try { await fs.promises.chmod(file, 0o600); } catch (_) {}
      return file;
    } finally {
      try { await fs.promises.unlink(tmp); } catch (_) {}
    }
  }

  async _deleteRemoteUnlocked(remoteName) {
    const remote = cleanRemoteName(remoteName);
    if (!remote) throw Object.assign(new Error('invalid-rclone-remote'), { code:'EINVAL' });
    let deleted = true;
    try { await this.run(['config', 'delete', remote], { timeoutMs:15000, maxOutput:128 * 1024 }); }
    catch (error) { if (error && error.code === 'remote-not-found') deleted = false; else throw error; }
    try { await fs.promises.unlink(this._googleServiceAccountPath(remote)); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    return deleted;
  }

  _googleDirectArgs(remote, file, options) {
    const args = ['config', 'create', remote, 'drive', 'service_account_file', file, 'scope', options.readOnly ? 'drive.readonly' : 'drive', 'root_folder_id', options.rootFolderId];
    if (options.resourceKey) args.push('resource_key', options.resourceKey);
    if (options.impersonate) args.push('impersonate', options.impersonate);
    // All required values are supplied, so defaults can be accepted without entering
    // OAuth. Do not use `config create --no-output` here: older rclone builds (still
    // common in Docker/Linux distributions) do not expose that flag. Direct-Xfer
    // captures stdout internally anyway, so suppressing successful config output is
    // unnecessary and would make first-time connector setup version-dependent.
    return args;
  }

  async _createAndProbeGoogleRemote(remote, normalized, options) {
    const file = await this._writeGoogleServiceAccountFile(remote, normalized);
    try {
      await this.run(this._googleDirectArgs(remote, file, options), { timeoutMs:30000, maxOutput:1024 * 1024 });
      // Creating a config file is not proof that Google accepted the key or that the
      // folder was shared correctly. A real list probe turns setup failures into an
      // immediate, actionable error instead of a broken connector saved as success.
      await this.run(['lsf', `${remote}:`, '--max-depth', '1'], { timeoutMs:45000, maxOutput:256 * 1024 });
      return file;
    } catch (error) {
      try { await this._deleteRemoteUnlocked(remote); } catch (_) {}
      throw error;
    }
  }

  async createGoogleServiceAccountRemote(remoteName, credentials, options = {}) {
    const remote = cleanRemoteName(remoteName);
    if (!remote) throw Object.assign(new Error('invalid-rclone-config'), { code:'EINVAL' });
    // Validate all untrusted inputs before acquiring the config mutation lock.
    const normalized = this._normalizeGoogleServiceAccount(credentials);
    const rootFolderId = String(options.rootFolderId || '').trim();
    if (!/^[A-Za-z0-9_-]{10,256}$/.test(rootFolderId)) throw Object.assign(new Error('google-drive-folder-required'), { code:'google-drive-folder-required' });
    const resourceKey = String(options.resourceKey || '').trim();
    if (resourceKey && !/^[A-Za-z0-9_-]{1,256}$/.test(resourceKey)) throw Object.assign(new Error('google-drive-resource-key-invalid'), { code:'google-drive-folder-invalid' });
    const impersonate = String(options.impersonate || '').trim().toLowerCase();
    if (impersonate && (!/^[^@\s]+@[^@\s]+$/.test(impersonate) || impersonate.length > 320)) {
      throw Object.assign(new Error('google-drive-impersonate-invalid'), { code:'google-drive-impersonate-invalid' });
    }
    const directOptions = { rootFolderId, resourceKey, readOnly:!!options.readOnly, impersonate };
    const replace = options.replace === true;

    return this._withConfigMutation(async () => {
      const existing = await this.configuredRemotes();
      const exists = existing.includes(remote);
      if (exists && !replace) throw Object.assign(new Error('rclone-remote-exists'), { code:'remote-exists' });

      // Snapshot both the rclone config and the managed key. Any failure after this
      // point restores the exact previous bytes so "replace" never destroys a working
      // remote because Google/network verification of the new credentials failed.
      const configSnapshot = await this._snapshotFile(this.configPath);
      const keyPath = this._googleServiceAccountPath(remote);
      const keySnapshot = await this._snapshotFile(keyPath);
      let tempRemote = '';
      try {
        if (exists && replace) {
          const suffix = `-dxcheck-${crypto.randomBytes(5).toString('hex')}`;
          tempRemote = `${remote.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
          await this._createAndProbeGoogleRemote(tempRemote, normalized, directOptions);
          await this._deleteRemoteUnlocked(tempRemote);
          tempRemote = '';
          await this._deleteRemoteUnlocked(remote);
        }
        await this._createAndProbeGoogleRemote(remote, normalized, directOptions);
        return { remote, clientEmail:normalized.clientEmail, rootFolderId, resourceKey, readOnly:directOptions.readOnly, impersonate:impersonate || '', verified:true };
      } catch (error) {
        if (tempRemote) { try { await this._deleteRemoteUnlocked(tempRemote); } catch (_) {} }
        let rollbackError = null;
        try { await this._restoreFile(this.configPath, configSnapshot, 0o600); } catch (restoreError) { rollbackError = restoreError; }
        try { await this._restoreFile(keyPath, keySnapshot, 0o600); } catch (restoreError) { rollbackError = rollbackError || restoreError; }
        if (rollbackError) {
          const failed = Object.assign(new Error('connector replacement rollback failed'), { code:'connector-rollback-failed', cause:error });
          throw failed;
        }
        throw error;
      }
    });
  }

  async createGoogleOAuthTokenRemote(remoteName, credentials = {}, options = {}) {
    const remote = cleanRemoteName(remoteName);
    if (!remote) throw Object.assign(new Error('invalid-rclone-config'), { code:'EINVAL' });
    const clientId = String(credentials.clientId || '').trim();
    const clientSecret = String(credentials.clientSecret || '').trim();
    const token = credentials.token && typeof credentials.token === 'object' ? credentials.token : null;
    if (!clientId || !clientId.toLowerCase().endsWith('.apps.googleusercontent.com')) throw Object.assign(new Error('invalid-google-client-id'), { code:'oauth-google-client-id-required' });
    if (!clientSecret) throw Object.assign(new Error('invalid-google-client-secret'), { code:'oauth-google-client-secret-required' });
    if (!token || !String(token.access_token || '').trim() || !String(token.refresh_token || '').trim()) throw Object.assign(new Error('invalid-google-oauth-token'), { code:'oauth-token-missing' });
    const replace = options.replace === true;
    const requestedScope = normalizeGoogleDriveRcloneScope(options.scope);
    if (!requestedScope) throw Object.assign(new Error('invalid-google-drive-scope'), { code:'invalid-google-drive-scope' });
    const tokenJson = JSON.stringify(token);
    if (tokenJson.length > 1024 * 1024) throw Object.assign(new Error('google-oauth-token-too-large'), { code:'oauth-token-missing' });
    return this._withConfigMutation(async () => {
      await this._ensureConfigStorage();
      const existing = await this.configuredRemotes();
      const exists = existing.includes(remote);
      if (exists && !replace) throw Object.assign(new Error('rclone-remote-exists'), { code:'remote-exists' });
      const configSnapshot = await this._snapshotFile(this.configPath);
      try {
        if (exists) await this._deleteRemoteUnlocked(remote);
        // When an OAuth token is supplied, rclone's config state machine otherwise
        // defaults to replacing that token and starts a second OAuth authorization.
        // Direct-Xfer already completed OAuth, so explicitly keep the supplied token.
        // --obscure also prevents long base64-like client secrets from being mistaken
        // for already-obscured values by rclone's config parser.
        await this._runRcloneStage('google-rclone-config-write', [
          'config','create',remote,'drive',
          'client_id',clientId,'client_secret',clientSecret,
          'scope',requestedScope,'token',tokenJson,
          'config_refresh_token','false','--obscure'
        ], { timeoutMs:30000, maxOutput:1024 * 1024 });
        await this._runRcloneStage('google-rclone-verify', ['lsf', `${remote}:`, '--max-depth', '1'], { timeoutMs:45000, maxOutput:256 * 1024 });
        return { remote, verified:true };
      } catch (error) {
        let rollbackError = null;
        try { await this._restoreFile(this.configPath, configSnapshot, 0o600); } catch (restoreError) { rollbackError = restoreError; }
        if (rollbackError) throw Object.assign(new Error('connector replacement rollback failed'), { code:'connector-rollback-failed', cause:error });
        throw error;
      }
    });
  }

  async createGoogleBrokerRemote(remoteName, credentials = {}, options = {}) {
    const remote = cleanRemoteName(remoteName);
    if (!remote) throw Object.assign(new Error('invalid-rclone-config'), { code:'EINVAL' });
    const clientId = String(credentials.clientId || '').trim();
    const clientSecret = String(credentials.clientSecret || '').trim();
    const tokenUrl = String(credentials.tokenUrl || '').trim();
    const token = credentials.token && typeof credentials.token === 'object' ? credentials.token : null;
    if (!/^dxc_[A-Za-z0-9_-]{8,240}$/.test(clientId) || !/^[A-Za-z0-9_-]{20,512}$/.test(clientSecret)) {
      throw Object.assign(new Error('invalid broker credential'), { code:'oauth-broker-credential-invalid' });
    }
    let parsedTokenUrl;
    try { parsedTokenUrl = new URL(tokenUrl); } catch (_) { throw Object.assign(new Error('invalid broker token url'), { code:'oauth-broker-credential-invalid' }); }
    const localTokenUrl = parsedTokenUrl.protocol === 'http:' && ['localhost','127.0.0.1','::1'].includes(parsedTokenUrl.hostname);
    if ((parsedTokenUrl.protocol !== 'https:' && !localTokenUrl) || parsedTokenUrl.username || parsedTokenUrl.password || parsedTokenUrl.hash || parsedTokenUrl.search || !parsedTokenUrl.pathname.endsWith('/v1/google/token')) {
      throw Object.assign(new Error('invalid broker token url'), { code:'oauth-broker-credential-invalid' });
    }
    if (!token || !String(token.access_token || '').trim() || !String(token.refresh_token || '').startsWith('dxr_')) {
      throw Object.assign(new Error('invalid broker token'), { code:'oauth-broker-credential-invalid' });
    }
    const tokenJson = JSON.stringify(token);
    if (tokenJson.length > 1024 * 1024) throw Object.assign(new Error('broker token too large'), { code:'oauth-broker-credential-invalid' });
    const replace = options.replace === true;
    const requestedScope = normalizeGoogleDriveRcloneScope(options.scope || credentials.scope);
    if (!requestedScope) throw Object.assign(new Error('invalid-google-drive-scope'), { code:'invalid-google-drive-scope' });
    return this._withConfigMutation(async () => {
      await this._ensureConfigStorage();
      const existing = await this.configuredRemotes();
      const exists = existing.includes(remote);
      if (exists && !replace) throw Object.assign(new Error('rclone-remote-exists'), { code:'remote-exists' });
      const configSnapshot = await this._snapshotFile(this.configPath);
      try {
        if (exists) await this._deleteRemoteUnlocked(remote);
        // The broker has already performed Google OAuth. Without
        // config_refresh_token=false, `rclone config create` sees the supplied token
        // and defaults to replacing it, which starts a second local OAuth flow and
        // makes remote/broker setup fail immediately after Google sign-in.
        await this._runRcloneStage('google-rclone-config-write', [
          'config','create',remote,'drive',
          'client_id',clientId,'client_secret',clientSecret,
          'scope',requestedScope,'token_url',parsedTokenUrl.toString(),'token',tokenJson,
          'config_refresh_token','false','--obscure'
        ], { timeoutMs:30000, maxOutput:1024 * 1024 });
        await this._runRcloneStage('google-rclone-verify', ['lsf', `${remote}:`, '--max-depth', '1'], { timeoutMs:45000, maxOutput:256 * 1024 });
        return { remote, verified:true, broker:true };
      } catch (error) {
        let rollbackError = null;
        try { await this._restoreFile(this.configPath, configSnapshot, 0o600); } catch (restoreError) { rollbackError = restoreError; }
        if (rollbackError) throw Object.assign(new Error('connector replacement rollback failed'), { code:'connector-rollback-failed', cause:error });
        throw error;
      }
    });
  }

  async deleteRemote(remoteName) {
    return this._withConfigMutation(() => this._deleteRemoteUnlocked(remoteName));
  }

  // Run an OAuth-capable rclone command while keeping rclone's loopback
  // listener private to the Direct-Xfer host. The browser-facing provider URL is
  // resolved server-side from rclone's /auth endpoint, then a validated loopback
  // callback can be relayed back to that listener from a browser on another
  // machine. This helper deliberately never exposes OAuth tokens to the browser.
  _startOAuthProcess(commandArgs, options = {}, parseSuccess) {
    const timeoutMs = Math.max(30000, Number(options.timeoutMs) || 10 * 60 * 1000);
    const args = Array.isArray(commandArgs) ? commandArgs.map((value) => String(value)) : [];
    if (!args.length || args.some((value) => value.length > 1024 * 1024)) {
      throw Object.assign(new Error('invalid OAuth command arguments'), { code:'oauth-authorize-config-invalid' });
    }
    const nodeWrapper = /\.(?:c|m)?js$/i.test(this.bin) && fs.existsSync(this.bin);
    const command = nodeWrapper ? process.execPath : this.bin;
    const childArgs = nodeWrapper ? [this.bin, ...args] : args;
    const child = spawn(command, childArgs, { env:this.commandEnv(), stdio:['ignore','pipe','pipe'], windowsHide:true });
    let stdout = '', stderr = '', transcript = '', settled = false, localAuthUrl = '', providerAuthUrl = '';
    let expectedState = '', listenerHost = '', listenerPort = '', resolvingProvider = false, earlyError = null, callbackRelayPromise = null;
    const maxOutput = 4 * 1024 * 1024;
    const append = (current, chunk) => (current + Buffer.from(chunk).toString('utf8')).slice(-maxOutput);
    const isLoopbackHost = (host) => ['127.0.0.1','localhost','::1'].includes(String(host || '').toLowerCase());
    const oauthError = (code, message) => Object.assign(new Error(message || code), { code });
    let forceKillTimer = null;
    const terminate = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      if (!forceKillTimer) forceKillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1500).unref();
    };

    const resolveProviderUrl = (url) => {
      if (resolvingProvider || providerAuthUrl || earlyError) return;
      let parsed;
      try { parsed = new URL(url); } catch (_) { earlyError=oauthError('oauth-local-url-invalid'); terminate(); return; }
      if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname) || parsed.username || parsed.password || parsed.hash || parsed.pathname !== '/auth') {
        earlyError=oauthError('oauth-local-url-invalid'); terminate(); return;
      }
      expectedState = String(parsed.searchParams.get('state') || '');
      listenerHost = parsed.hostname;
      listenerPort = parsed.port || '80';
      if (!expectedState || expectedState.length > 4096) { earlyError=oauthError('oauth-state-missing'); terminate(); return; }
      resolvingProvider = true;
      const req = http.get({ hostname:listenerHost, port:Number(listenerPort), path:parsed.pathname + parsed.search, headers:{ Accept:'text/html,*/*;q=0.8' } }, (res) => {
        const location = String(res.headers.location || '').trim();
        res.resume(); resolvingProvider = false;
        let target;
        try { target = new URL(location); } catch (_) { target = null; }
        if (!(res.statusCode >= 300 && res.statusCode < 400) || !target || target.protocol !== 'https:' || target.username || target.password) {
          earlyError=oauthError('oauth-provider-url-missing'); terminate(); return;
        }
        const providerState = String(target.searchParams.get('state') || '');
        if (providerState && providerState !== expectedState) { earlyError=oauthError('oauth-state-mismatch'); terminate(); return; }
        providerAuthUrl = target.toString();
        if (typeof options.onUrl === 'function') options.onUrl(providerAuthUrl);
      });
      req.setTimeout(5000, () => req.destroy(oauthError('oauth-local-auth-timeout')));
      req.once('error', (error) => {
        if (earlyError || providerAuthUrl) return;
        resolvingProvider = false;
        earlyError=oauthError('oauth-local-auth-unreachable', error && error.message); terminate();
      });
    };

    const detectUrl = () => {
      const match = transcript.match(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/auth\?[^\s<>'"]+/i);
      if (match && match[0] !== localAuthUrl) {
        localAuthUrl = match[0];
        resolveProviderUrl(localAuthUrl);
      }
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); transcript = append(transcript, chunk); detectUrl(); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); transcript = append(transcript, chunk); detectUrl(); });
    const timer = setTimeout(terminate, timeoutMs);
    const promise = new Promise((resolve, reject) => {
      child.once('error', (error) => {
        if (settled) return; settled = true; clearTimeout(timer); if (forceKillTimer) clearTimeout(forceKillTimer);
        error.code = error.code === 'ENOENT' ? 'rclone-unavailable' : (error.code || 'oauth-failed');
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) return; settled = true; clearTimeout(timer); if (forceKillTimer) clearTimeout(forceKillTimer); detectUrl();
        if (earlyError) return reject(earlyError);
        if (code !== 0) {
          const error = new Error('rclone authorization failed');
          error.code = classifyOAuthFailure(`${stderr}\n${stdout}`, 'oauth-failed');
          return reject(error);
        }
        try {
          const value = typeof parseSuccess === 'function'
            ? parseSuccess({ stdout, stderr, transcript, authUrl:providerAuthUrl })
            : { stdout, stderr, authUrl:providerAuthUrl };
          resolve(value);
        } catch (error) {
          if (!error.code) error.code = 'oauth-failed';
          reject(error);
        }
      });
    });

    const acceptCallback = (value) => {
      if (callbackRelayPromise) return callbackRelayPromise;
      if (!providerAuthUrl || !localAuthUrl || !expectedState || !listenerHost || !listenerPort) {
        return Promise.reject(oauthError('oauth-callback-not-ready'));
      }
      const raw = String(value || '').trim();
      if (!raw || raw.length > 32768) return Promise.reject(oauthError('oauth-callback-invalid'));
      let callback;
      try { callback = new URL(raw); } catch (_) { return Promise.reject(oauthError('oauth-callback-invalid')); }
      const callbackPort = callback.port || (callback.protocol === 'http:' ? '80' : '');
      if (callback.protocol !== 'http:' || !isLoopbackHost(callback.hostname) || callbackPort !== listenerPort || callback.username || callback.password || callback.hash || callback.pathname !== '/') {
        return Promise.reject(oauthError('oauth-callback-invalid'));
      }
      if (String(callback.searchParams.get('state') || '') !== expectedState) return Promise.reject(oauthError('oauth-callback-state'));
      if (!callback.searchParams.has('code') && !callback.searchParams.has('error')) return Promise.reject(oauthError('oauth-callback-invalid'));
      callbackRelayPromise = new Promise((resolve, reject) => {
        const req = http.get({ hostname:listenerHost, port:Number(listenerPort), path:callback.pathname + callback.search, headers:{ Accept:'text/html,*/*;q=0.8' } }, (res) => {
          res.resume();
          res.once('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 400) resolve({ ok:true });
            else { callbackRelayPromise=null; reject(oauthError('oauth-callback-rejected')); }
          });
        });
        req.setTimeout(5000, () => req.destroy(oauthError('oauth-callback-timeout')));
        req.once('error', (error) => { callbackRelayPromise=null; reject(oauthError(error && error.code === 'oauth-callback-timeout' ? error.code : 'oauth-callback-unreachable')); });
      });
      return callbackRelayPromise;
    };

    return {
      child, promise, cancel:terminate, acceptCallback,
      getAuthUrl:() => providerAuthUrl,
      getLocalAuthUrl:() => localAuthUrl,
    };
  }

  // Preferred OAuth path for Direct-Xfer. Continue the *same* non-interactive
  // rclone config state with config_is_local=true. This keeps every option already
  // collected for the remote (notably Google client_id/client_secret) in the same
  // configuration transaction and avoids parsing a generated `rclone authorize`
  // command from help text.
  startOAuthConfigAuthorization(remoteName, state, options = {}) {
    const remote = cleanRemoteName(remoteName);
    const opaqueState = String(state || '');
    if (!remote || !opaqueState || opaqueState.length > 8192) {
      throw Object.assign(new Error('invalid-rclone-config-state'), { code:'EINVAL' });
    }
    const args = [
      'config', 'update', remote, ...this._configParameterArgs(options.connectorType, options.parameters),
      '--continue', '--state', opaqueState,
      '--result', 'true', '--non-interactive',
    ];
    if (options.all) args.push('--all');
    return this._startOAuthProcess(args, options, ({ stdout }) => {
      const question = this.parseConfigQuestion(stdout);
      if (question && question.error) {
        throw Object.assign(new Error(question.error), { code:'connector-config-error' });
      }
      return { question };
    });
  }

  // Legacy/manual OAuth authorization path retained for older flows and the
  // advanced "rclone authorize" fallback shown in the UI.
  startOAuthAuthorization(connectorType, options = {}) {
    const backend = connectorBackendType(connectorType);
    if (!backend || !OAUTH_CONNECTOR_TYPES.has(String(connectorType || '').toLowerCase())) {
      throw Object.assign(new Error('oauth-not-supported'), { code:'oauth-not-supported' });
    }
    const requestedAuthorizeArgs = Array.isArray(options.authorizeArgs) ? options.authorizeArgs.map((value) => String(value)) : [backend];
    if (
      requestedAuthorizeArgs.length < 1 || requestedAuthorizeArgs.length > 2 ||
      requestedAuthorizeArgs[0] !== backend ||
      requestedAuthorizeArgs.some((value) => !value || value.length > 1024 * 1024) ||
      (requestedAuthorizeArgs[1] && !/^[A-Za-z0-9+/_=-]+$/.test(requestedAuthorizeArgs[1]))
    ) {
      throw Object.assign(new Error('invalid OAuth authorize arguments'), { code:'oauth-authorize-config-invalid' });
    }
    const args = ['authorize', ...requestedAuthorizeArgs, '--auth-no-open-browser'];
    return this._startOAuthProcess(args, options, ({ stdout, transcript, authUrl }) => {
      let token = '';
      const marked = transcript.match(/Paste the following into your remote machine[^>]*--->\s*([\s\S]*?)\s*<---End paste/i);
      if (marked) token = marked[1].trim();
      if (!token) {
        const candidates = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
        token = candidates.find((line) => { try { const x=JSON.parse(line); return x && typeof x === 'object' && (x.access_token || x.refresh_token); } catch (_) { return false; } }) || '';
      }
      if (!token || token.length > 1024 * 1024) {
        throw Object.assign(new Error('rclone authorization token missing'), { code:'oauth-token-missing' });
      }
      return { token, authUrl };
    });
  }

  async test(connector) {
    const remotes = await this.configuredRemotes();
    if (!remotes.includes(connector.remote)) throw Object.assign(new Error('rclone-remote-not-found'), { code:'remote-not-found' });
    const result = await this.run(['lsjson', remoteSpec(connector, ''), '--max-depth', '1', '--stat'], { timeoutMs:30000, maxOutput:512 * 1024 });
    let info = null;
    try { info = JSON.parse(result.stdout || 'null'); } catch (_) {}
    return { ok:true, remote:connector.remote, info };
  }

  async list(connector, relative) {
    const base = cleanRelativePath(relative);
    if (base === null) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
    const result = await this.run([
      'lsjson', remoteSpec(connector, base), '--max-depth', '1', '--no-mimetype', '--no-modtime',
    ], { timeoutMs:60000, maxOutput:8 * 1024 * 1024 });
    let rows;
    try { rows = JSON.parse(result.stdout || '[]'); }
    catch (_) { throw Object.assign(new Error('invalid-rclone-response'), { code:'connector-response' }); }
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
    return rows.slice(0, 5000).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const returnedPath = cleanRelativePath(row.Path || row.Name || '', false);
      const safeName = String(row.Name || path.posix.basename(String(row.Path || ''))).trim().slice(0, 255);
      if (returnedPath === null || !safeName || /[\0-\x1f\x7f]/.test(safeName)) return null;
      // rclone's lsjson Path is relative to the directory passed to lsjson.
      // Return a connector-root-relative path so a file selected after navigating
      // into a subdirectory can be imported without silently dropping that prefix.
      // `lsjson` paths are relative to the directory passed to the command.
      // Always prefix the requested base. Heuristics based on the returned name
      // break for a child whose name happens to equal the parent directory name.
      const fullPath = base ? cleanRelativePath(base + '/' + returnedPath, false) : returnedPath;
      if (fullPath === null) return null;
      return {
        name:safeName, path:fullPath, isDir:!!row.IsDir,
        size:Math.max(0, Number(row.Size) || 0),
        id:row.ID == null ? null : String(row.ID).slice(0, 300),
      };
    }).filter(Boolean);
  }

  async stat(connector, relative) {
    const rel = cleanRelativePath(relative);
    if (rel === null) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
    const result = await this.run([
      'lsjson', remoteSpec(connector, rel), '--stat', '--no-mimetype',
    ], { timeoutMs:60000, maxOutput:1024 * 1024 });
    let row;
    try { row = JSON.parse(result.stdout || 'null'); }
    catch (_) { throw Object.assign(new Error('invalid-rclone-response'), { code:'connector-response' }); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw Object.assign(new Error('remote-not-found'), { code:'remote-not-found' });
    }
    const safeName = String(row.Name || path.posix.basename(rel) || (row.IsDir ? connector.name : '') || '').trim().slice(0, 255);
    if (!safeName || /[\0-\x1f\x7f]/.test(safeName)) {
      throw Object.assign(new Error('invalid-rclone-response'), { code:'connector-response' });
    }
    return {
      name:safeName,
      path:rel,
      isDir:!!row.IsDir,
      size:Math.max(0, Number(row.Size) || 0),
      id:row.ID == null ? null : String(row.ID).slice(0, 300),
      modTime:row.ModTime == null ? null : String(row.ModTime).slice(0, 80),
    };
  }

  // Starts an rclone command whose stdout is consumed as a stream instead of
  // buffered in memory. Used by public web-storage links so large cloud objects
  // are relayed directly to the visitor without first copying them to disk.
  spawnStream(args) {
    const nodeWrapper = /\.(?:c|m)?js$/i.test(this.bin) && fs.existsSync(this.bin);
    const command = nodeWrapper ? process.execPath : this.bin;
    const commandArgs = nodeWrapper ? [this.bin, ...args] : args;
    const child = spawn(command, commandArgs, {
      env:this.commandEnv(), stdio:['ignore', 'pipe', 'pipe'], windowsHide:true,
    });
    return child;
  }

  streamFile(connector, relative, options = {}) {
    const rel = cleanRelativePath(relative, false);
    if (rel === null) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
    const offset = Math.max(0, Number(options.offset) || 0);
    const count = options.count == null ? null : Math.max(0, Number(options.count) || 0);
    const args = ['cat', remoteSpec(connector, rel)];
    if (offset > 0) args.push('--offset', String(offset));
    if (count !== null) args.push('--count', String(count));
    return this.spawnStream(args);
  }

  stagingRoot() { return path.join(this.importRoot, '.dxconnector-import-staging'); }

  async ensureStagingRoot() {
    await fs.promises.mkdir(this.importRoot, { recursive:true, mode:0o700 });
    const rootStat = await fs.promises.lstat(this.importRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw Object.assign(new Error('unsafe-import-root'), { code:'EINVAL' });
    }
    const staging = this.stagingRoot();
    try {
      const stat = await fs.promises.lstat(staging);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('unsafe-import-staging'), { code:'EINVAL' });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      await fs.promises.mkdir(staging, { mode:0o700 });
    }
    const realRoot = await fs.promises.realpath(this.importRoot);
    const realStaging = await fs.promises.realpath(staging);
    if (realStaging !== realRoot && !realStaging.startsWith(realRoot + path.sep)) {
      throw Object.assign(new Error('unsafe-import-staging'), { code:'EINVAL' });
    }
    return realStaging;
  }

  async cleanupStaleImports() {
    // Startup housekeeping must be side-effect free when storage connectors have
    // never been used. The old implementation called ensureStagingRoot(), which
    // created an empty `Imports` folder in the user's reception directory merely
    // by starting Direct-Xfer. Only inspect/clean a staging tree that already
    // exists; importFile() still creates it lazily when an actual import begins.
    let rootStat;
    try { rootStat = await fs.promises.lstat(this.importRoot); }
    catch (error) { if (error && error.code === 'ENOENT') return 0; throw error; }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw Object.assign(new Error('unsafe-import-root'), { code:'EINVAL' });
    }
    const staging = this.stagingRoot();
    let stagingStat;
    try { stagingStat = await fs.promises.lstat(staging); }
    catch (error) { if (error && error.code === 'ENOENT') return 0; throw error; }
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      throw Object.assign(new Error('unsafe-import-staging'), { code:'EINVAL' });
    }
    const realRoot = await fs.promises.realpath(this.importRoot);
    const realStaging = await fs.promises.realpath(staging);
    if (realStaging !== realRoot && !realStaging.startsWith(realRoot + path.sep)) {
      throw Object.assign(new Error('unsafe-import-staging'), { code:'EINVAL' });
    }
    let entries = [];
    try { entries = await fs.promises.readdir(realStaging, { withFileTypes:true }); } catch (_) { return 0; }
    let removed = 0;
    for (const entry of entries) {
      if (!entry || !/^job-[A-Za-z0-9-]{12,100}$/.test(entry.name)) continue;
      try { await fs.promises.rm(path.join(realStaging, entry.name), { recursive:true, force:true }); removed += 1; } catch (_) {}
    }
    // Remove only our own now-empty staging directory. If that makes the default
    // Imports root empty too, prune it as well so upgrades clean the old pollution.
    // A directory containing any user/imported file is never removed.
    try { if ((await fs.promises.readdir(realStaging)).length === 0) await fs.promises.rmdir(realStaging); } catch (_) {}
    try { if ((await fs.promises.readdir(this.importRoot)).length === 0) await fs.promises.rmdir(this.importRoot); } catch (_) {}
    return removed;
  }

  async importFile(connector, remotePath, localRelative, options = {}) {
    const source = remoteSpec(connector, remotePath);
    let target = safeLocalTarget(this.importRoot, localRelative);
    await secureLocalParent(this.importRoot, target);
    const stagingRoot = await this.ensureStagingRoot();
    const staging = await fs.promises.mkdtemp(path.join(stagingRoot, `job-${crypto.randomBytes(8).toString('hex')}-`));
    const temporary = path.join(staging, 'payload');
    try {
      await this.run(['copyto', source, temporary, '--checksum', '--retries', '3', '--low-level-retries', '10'], {
        timeoutMs:options.timeoutMs || 24 * 60 * 60 * 1000, signal:options.signal,
      });
      const stat = await fs.promises.lstat(temporary);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('connector-import-not-file'), { code:'not-file' });
      if (typeof options.beforePublish === 'function') {
        await options.beforePublish(temporary, { source, target, size:stat.size });
      }
      // Re-check immediately before publication: the target directory may have
      // changed while a long remote transfer or antivirus scan was running.
      await secureLocalParent(this.importRoot, target);
      target = await publishImportNoClobber(temporary, target);
      try { await fs.promises.chmod(target, 0o600); } catch (_) {}
      return { source, target, size:stat.size };
    } catch (error) { throw error; }
    finally { try { await fs.promises.rm(staging, { recursive:true, force:true }); } catch (_) {} }
  }

  async exportFile(connector, localPath, remotePath, options = {}) {
    if (connector.readOnly) throw Object.assign(new Error('connector-read-only'), { code:'read-only' });
    const stat = await fs.promises.stat(localPath);
    if (!stat.isFile()) throw Object.assign(new Error('connector-export-not-file'), { code:'not-file' });
    const target = remoteSpec(connector, remotePath);
    await this.run(['copyto', localPath, target, '--checksum', '--immutable', '--retries', '3', '--low-level-retries', '10'], {
      timeoutMs:options.timeoutMs || 24 * 60 * 60 * 1000, signal:options.signal,
    });
    return { source:localPath, target, size:stat.size };
  }


  async mkdir(connector, remotePath, options = {}) {
    if (connector.readOnly) throw Object.assign(new Error('connector-read-only'), { code:'read-only' });
    const rel = cleanRelativePath(remotePath, false);
    if (rel === null) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
    const target = remoteSpec(connector, rel);
    await this.run(['mkdir', target], { timeoutMs:options.timeoutMs || 60000, signal:options.signal });
    return { target };
  }

  async remove(connector, remotePath, options = {}) {
    if (connector.readOnly) throw Object.assign(new Error('connector-read-only'), { code:'read-only' });
    const rel = cleanRelativePath(remotePath, false);
    if (rel === null) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
    const target = remoteSpec(connector, rel);
    const command = options.isDir ? 'purge' : 'deletefile';
    await this.run([command, target, '--retries', '3', '--low-level-retries', '10'], {
      timeoutMs:options.timeoutMs || 10 * 60 * 1000, signal:options.signal,
    });
    return { target };
  }

  async metrics(connector, remotePath, options = {}) {
    const rel = cleanRelativePath(remotePath, false);
    if (rel === null) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
    const result = await this.run(['size', remoteSpec(connector, rel), '--json'], {
      timeoutMs:options.timeoutMs || 10 * 60 * 1000, signal:options.signal, maxOutput:256 * 1024,
    });
    let row;
    try { row = JSON.parse(result.stdout || '{}'); }
    catch (_) { throw Object.assign(new Error('invalid-rclone-response'), { code:'connector-response' }); }
    return { bytes:Math.max(0, Number(row && row.bytes) || 0), files:Math.max(0, Number(row && row.count) || 0) };
  }
}

module.exports = {
  CONNECTOR_TYPES,
  OAUTH_CONNECTOR_TYPES,
  connectorBackendType,
  StorageConnectorService,
  cleanRemoteName,
  cleanRelativePath,
  normalizeConnector,
  normalizeGoogleDriveRcloneScope, GOOGLE_DRIVE_RCLONE_SCOPES, safeRcloneErrorDetail,
  connectorErrorCode, connectorHttpStatus,
  remoteSpec,
  safeLocalTarget,
  secureLocalParent,
  publishImportNoClobber,
};
