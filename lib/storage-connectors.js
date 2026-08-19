'use strict';

// Storage connectors are intentionally implemented on top of rclone instead of
// embedding seven unrelated cloud SDKs in Direct-Xfer. rclone provides one
// audited, well-documented transport for SFTP, SMB, WebDAV, Google Drive,
// OneDrive, Dropbox and Box, while credentials remain in its protected config
// file rather than shares.json or the browser.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CONNECTOR_TYPES = new Set([
  'sftp', 'smb', 'webdav', 'google-drive', 'onedrive', 'dropbox', 'box',
]);

function classifyRcloneFailure(stderr, fallback = 'connector-failed') {
  const text = String(stderr || '').toLowerCase();
  if (!text) return fallback;
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
    return env;
  }

  run(args, options = {}) {
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
  StorageConnectorService,
  cleanRemoteName,
  cleanRelativePath,
  normalizeConnector,
  remoteSpec,
  safeLocalTarget,
  secureLocalParent,
  publishImportNoClobber,
};
