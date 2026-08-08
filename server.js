'use strict';

/*
 * Direct-Xfer — direct HTTP file sharing, single server.
 * The whole backend lives in this file (config, settings, network, auth, routes).
 * The static web interface is served from ./public.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const https = require('https');
// selfsigned is optional: only needed to auto-generate a self-signed TLS cert.
let selfsigned = null;
try { selfsigned = require('selfsigned'); } catch (_) { selfsigned = null; }
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');
const { Readable, Transform } = require('stream');
const express = require('express');
// Archiver 8 is ESM-only. Load its ZIP class lazily so this CommonJS server
// remains compatible while using the maintained API.
let ZipArchiveClass = null;
async function newZipArchive(options) {
  if (!ZipArchiveClass) ({ ZipArchive: ZipArchiveClass } = await import('archiver'));
  return new ZipArchiveClass(options);
}
const QRCode = require('qrcode');
// nodemailer is optional: e-mail notifications are off by default and the app
// must still boot if the module is somehow missing (degrades to webhook-only).
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }
// Web Push (browser notifications) — optional, like nodemailer. When the module is
// absent the feature stays disabled and everything else works unchanged.
let webpush = null;
try { webpush = require('web-push'); } catch (_) { webpush = null; }
const pkg = require('./package.json');

// Application identity.
const APP_NAME = 'Direct-Xfer';
// Version: single source = package.json. Copyright year.
const APP_VERSION = pkg.version;
const APP_YEAR = 2026;
// Per-request values used while rendering public HTML. Keeping the CSP nonce in
// AsyncLocalStorage avoids threading it through every page-rendering helper while
// still giving every response its own unpredictable value.
const requestContext = new AsyncLocalStorage();
// Release date of the running version: mtime of package.json (bumped with the
// version, and preserved when the file is copied into the Docker image). Null if
// it can't be read. Used by the "About" dialog.
const RELEASE_DATE = (() => {
  try { return fs.statSync(path.join(__dirname, 'package.json')).mtime.toISOString(); }
  catch (_) { return null; }
})();

// ===================================================================
//  CONFIGURATION (environment variables)
// ===================================================================

function int(value, def) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : def;
}
function bool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

const PORT = int(process.env.PORT, 55750);
const BIND = process.env.BIND || '0.0.0.0';

// Native HTTPS (feature: serve TLS directly, so secure-context features — the
// WebCrypto used by encrypted shares, secret notes and E2E reception — work
// without a reverse proxy). Priority: a provided cert/key (TLS_CERT + TLS_KEY) >
// an auto-generated self-signed cert (TLS_SELF_SIGNED=true, cached under DATA_DIR).
const TLS_CERT = (process.env.TLS_CERT || '').trim();
const TLS_KEY = (process.env.TLS_KEY || '').trim();
const TLS_SELF_SIGNED = bool(process.env.TLS_SELF_SIGNED);

// Returns { key, cert } for HTTPS, or null to fall back to plain HTTP. A provided
// pair wins; otherwise a self-signed cert is generated once and reused.
function loadTlsOptions() {
  const TLS_DIR = path.join(DATA_DIR, 'tls'); // DATA_DIR is set by the time this runs
  if (TLS_CERT && TLS_KEY) {
    try {
      return { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
    } catch (e) {
      console.error('[tls] could not read TLS_CERT/TLS_KEY — falling back to HTTP:', e.message);
      return null;
    }
  }
  if (!TLS_SELF_SIGNED) return null;
  const certFile = path.join(TLS_DIR, 'cert.pem');
  const keyFile = path.join(TLS_DIR, 'key.pem');
  // Reuse a previously generated cert while it is still valid (> 30 days left).
  try {
    const cert = fs.readFileSync(certFile);
    const key = fs.readFileSync(keyFile);
    const x = new crypto.X509Certificate(cert);
    if (new Date(x.validTo).getTime() - Date.now() > 30 * 86400000) return { cert, key };
  } catch (_) { /* regenerate below */ }
  if (!selfsigned) {
    console.error('[tls] TLS_SELF_SIGNED is set but the "selfsigned" module is unavailable — falling back to HTTP.');
    return null;
  }
  try {
    const attrs = [{ name: 'commonName', value: LOCAL_IP || os.hostname() || 'direct-xfer' }];
    const altNames = [
      { type: 2, value: os.hostname() || 'localhost' },
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
    ];
    if (LOCAL_IP) altNames.push({ type: 7, ip: LOCAL_IP });
    const pems = selfsigned.generate(attrs, { keySize: 2048, days: 825, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] });
    fs.mkdirSync(TLS_DIR, { recursive: true });
    fs.writeFileSync(certFile, pems.cert, { mode: 0o600 });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    console.log('[tls] generated a self-signed certificate (cached in ' + TLS_DIR + ').');
    return { cert: pems.cert, key: pems.private };
  } catch (e) {
    console.error('[tls] self-signed generation failed — falling back to HTTP:', e.message);
    return null;
  }
}

// Host filesystem, mounted read-only inside the container (/:/host:ro).
// Shares reference the real file path DIRECTLY (e.g. /home/me/movie.mp4),
// with no copy, no symlink, no staging folder.
const HOST_ROOT = path.resolve(process.env.HOST_ROOT || '/host');
// Persistent data (shares, generated password).
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');

const PUBLIC_HOST = (process.env.PUBLIC_HOST || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

// Host LAN IP, to be provided: behind Docker's bridge network,
// the container only sees its internal IP (e.g. 192.168.80.2), not the host's.
const LOCAL_IP = (() => {
  const v = (process.env.LOCAL_IP || '').trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v : '';
})();

// trust proxy: "true"/"1" => 1 hop (NPM), an integer => n hops, otherwise false.
function parseTrustProxy(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || ['false', '0', 'no', 'off'].includes(s)) return false;
  if (['true', 'yes', 'on'].includes(s)) return 1;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : false;
}
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

// Initial value of auto-shutdown (then controlled from the admin interface).
const SHUTDOWN_AFTER_DOWNLOAD = bool(process.env.SHUTDOWN_AFTER_DOWNLOAD);

const SESSION_TTL_MS = int(process.env.SESSION_TTL_HOURS, 8) * 3600 * 1000;
const MAX_ZIP_BYTES = int(process.env.MAX_ZIP_BYTES, 20 * 1024 ** 3); // 20 GiB; set 0 to disable
const MAX_CONCURRENT_ZIPS = Math.max(1, int(process.env.MAX_CONCURRENT_ZIPS, 2));

// Optional at-rest encryption of the metadata store (shares.json). When set, the
// file — which holds host paths, filenames, hostnames and password hashes — is
// written as an AES-256-GCM envelope instead of plaintext JSON. The key is
// derived from this secret; without it the file cannot be read (startup aborts).
const DATA_KEY = (process.env.DATA_KEY || '').trim();

// Destination folder for incoming files (reception links).
// Mount a WRITABLE host folder here in the container (e.g. -v /path/incoming:/Direct-Xfer).
const INBOX_DIR = path.resolve(process.env.INBOX_DIR || '/Direct-Xfer');
const MAX_UPLOAD_BYTES = int(process.env.MAX_UPLOAD_BYTES, 10 * 1024 ** 3); // 10 GiB; set 0 to disable
const MAX_CONCURRENT_UPLOADS = Math.max(1, int(process.env.MAX_CONCURRENT_UPLOADS, 8));
const UPLOAD_IDLE_TIMEOUT_MS = Math.max(15000, int(process.env.UPLOAD_IDLE_TIMEOUT_SECONDS, 120) * 1000);
// Ciphertext blobs of end-to-end-encrypted download shares (opaque; the server
// never holds the key). Lives under DATA_DIR so the existing volume/permissions apply.
const ENC_DIR = path.join(DATA_DIR, 'enc');
try { fs.mkdirSync(ENC_DIR, { recursive: true }); } catch (_) {}
// Feature 5 — burn-after-read secret notes: opaque ciphertext blobs (the server
// never holds the key), deleted on first read. Kept under DATA_DIR.
const SECRETS_DIR = path.join(DATA_DIR, 'secrets');
try { fs.mkdirSync(SECRETS_DIR, { recursive: true }); } catch (_) {}

// Photos tab — all managed image bytes live under one configurable root. Full
// images are copied here (the source file remains untouched); Mini and Micro are
// generated in the browser. The legacy paths remain readable for upgrades.
const IMAGE_STORE_DIR = path.resolve(process.env.IMAGES_DIR || path.join(DATA_DIR, 'images'));
const FULL_IMAGES_DIR = path.join(IMAGE_STORE_DIR, 'Full');
const THUMBS_DIR = path.join(IMAGE_STORE_DIR, 'Mini');
const MICROS_DIR = path.join(IMAGE_STORE_DIR, 'Micro');
const PHOTO_HISTORY_DIR = path.join(IMAGE_STORE_DIR, 'History');
const PHOTO_VERSIONS_DIR = path.join(IMAGE_STORE_DIR, 'Versions');
const ADAPTIVE_IMAGES_DIR = path.join(IMAGE_STORE_DIR, 'Adaptive');
const LEGACY_IMAGES_DIR = path.join(DATA_DIR, 'images');
const LEGACY_THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const LEGACY_MICROS_DIR = path.join(DATA_DIR, 'micros');
const LEGACY_PHOTO_HISTORY_DIR = path.join(DATA_DIR, 'photo-history');
for (const dir of [IMAGE_STORE_DIR, FULL_IMAGES_DIR, THUMBS_DIR, MICROS_DIR, PHOTO_HISTORY_DIR, PHOTO_VERSIONS_DIR, ADAPTIVE_IMAGES_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// Startup storage check: warn (console banner + login page) when the reception
// folder (/Direct-Xfer) or the images folder (/Images) was left un-configured in
// docker-compose.yml. Two cases are caught:
//   1. The bind mount is still the "/PATH/TO/CONFIGURE" placeholder — Docker
//      happily creates that literal host folder and mounts it, so a device check
//      alone can't see it; we read the mount's SOURCE from /proc/self/mountinfo
//      (field 4 = the host path the volume points at) and match the placeholder.
//   2. No dedicated volume at all — the folder lives on the container's ephemeral
//      overlay (same device as "/"), so its contents are LOST on recreation.
// Only meaningful inside the container we ship.
const IN_CONTAINER = (() => { try { return fs.existsSync('/.dockerenv'); } catch (_) { return false; } })();
const PLACEHOLDER_SRC = '/PATH/TO/CONFIGURE';
// Bold-red ANSI wrapper for the startup log (Docker logs / terminals render it;
// disabled when NO_COLOR is set — https://no-color.org).
const USE_COLOR = !process.env.NO_COLOR;
function red(s) { return USE_COLOR ? `\x1b[1;31m${s}\x1b[0m` : s; }
function storageIsEphemeral(dir) {
  try { return fs.statSync(dir).dev === fs.statSync('/').dev; }
  catch (_) { return false; } // can't stat → don't nag; the writability checks cover it
}
// The bind-mount SOURCE root for the mount whose mount point is exactly `dir`, or
// null when `dir` is not itself a mount point. mountinfo fields 1-6 are positional:
// field 4 (index 3) is the source root, field 5 (index 4) the target. NOTE: the
// source root is the path RELATIVE to the backing filesystem's root — it equals the
// full host path only when the source lives on the host root fs. When the source is
// on a separate disk/share, only the sub-path is visible (the host mountpoint of
// that disk is not exposed inside the container). We keep the LAST match, since a
// later mount at the same point shadows earlier ones.
function mountSourceRoot(dir) {
  let lines;
  try { lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n'); }
  catch (_) { return null; }
  let root = null;
  for (const line of lines) {
    const f = line.split(' ');
    if (f.length >= 5 && f[4] === dir) root = f[3];
  }
  return root;
}
function folderUnconfigured(dir) {
  const src = mountSourceRoot(dir);
  if (src !== null) {
    // Mounted: flag only if the source is still the compose placeholder.
    return src === PLACEHOLDER_SRC || src.startsWith(PLACEHOLDER_SRC + '/');
  }
  // Not its own mount point → not backed by a dedicated volume → ephemeral overlay.
  return storageIsEphemeral(dir);
}
const STORAGE_SETUP = {
  inboxUnconfigured: IN_CONTAINER && folderUnconfigured(INBOX_DIR),
  imagesUnconfigured: IN_CONTAINER && folderUnconfigured(IMAGE_STORE_DIR),
};
// Startup-banner suffix showing where a container folder lives on the host. It
// resolves the enclosing mount (so /data/images under the /data mount reports its
// real host path) and flags the /PATH/TO/CONFIGURE placeholder. When the source is
// on a separate host disk/share, mountinfo only exposes the sub-path relative to
// that disk — if that sub-path is just the container path itself, there is nothing
// truthful to show, so we say so rather than echo a misleading value. Empty outside
// the container (dev machines).
function hostMountNote(dir) {
  if (!IN_CONTAINER) return '';
  let d = dir;
  for (;;) {
    const src = mountSourceRoot(d);
    if (src !== null) {
      const rel = dir.slice(d.length); // '' when d === dir, else '/sub/path'
      const hostPath = ((src === '/' ? '' : src) + rel) || '/';
      if (src === PLACEHOLDER_SRC || src.startsWith(PLACEHOLDER_SRC + '/')) return red(`  ← ${hostPath}  ⚠ placeholder`);
      // hostPath === dir means the source sits on a separate disk/share whose host
      // mountpoint isn't visible from inside the container (only the sub-path is).
      if (hostPath === dir) return '  ← mounted host volume (exact host path only visible via `docker inspect`)';
      return `  ← host ${hostPath}`;
    }
    const parent = path.dirname(d);
    if (parent === d) return '  (no volume — inside the container)';
    d = parent;
  }
}
const PHOTO_HISTORY_MAX = 50;
const IMAGE_MAX_BYTES = 40 * 1024 * 1024; // per uploaded image (PWA image links)
const THUMB_MAX_BYTES = 2 * 1024 * 1024;  // per client-generated thumbnail
const MICRO_MAX_BYTES = 1024 * 1024;       // per client-generated micro image

// Feature 2 — optional antivirus scan of received files via a co-located clamd
// (ClamAV daemon). Enabled by setting CLAMAV_HOST (e.g. "clamav"). Infected
// uploads are quarantined and never delivered; a security alert is dispatched.
const CLAMAV_HOST = (process.env.CLAMAV_HOST || '').trim();
const CLAMAV_PORT = int(process.env.CLAMAV_PORT, 3310);
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
function clamavEnabled() { return !!CLAMAV_HOST; }

// Persistent transfer journal (JSONL, one record per finished transfer). Kept
// separate from the in-memory "recent history" so it survives beyond the last
// 50 entries and can be exported. Soft-capped: trimmed to the tail on startup.
const MAX_LOG_BYTES = int(process.env.MAX_LOG_BYTES, 8 * 1024 * 1024); // 0 = unlimited

// Access to the admin interface: restricted to the local network by default
// (auto-detected). Set ADMIN_ALLOW_ANY=true to allow it from any network.
const ADMIN_ALLOW_ANY = bool(process.env.ADMIN_ALLOW_ANY);

// Allowlist of IPs permitted to reach the admin (IPv4 IP or CIDR,
// separated by commas/spaces). Empty = disabled. When set,
// ONLY these IPs (plus loopback) can reach the admin — useful behind a
// reverse proxy (set TRUST_PROXY there to see the real visitor IP).
const ADMIN_ALLOWED_IPS = parseIpList(process.env.ADMIN_ALLOWED_IPS);

// Webhook notifications (optional): URL called via POST on every
// complete download or received file. Format auto-detected (Discord / Slack /
// ntfy) or forced via WEBHOOK_FORMAT (discord | slack | ntfy | json).
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '').trim();
const WEBHOOK_FORMAT = (process.env.WEBHOOK_FORMAT || '').trim().toLowerCase();

// E-mail (SMTP) notifications (optional): when SMTP_URL is set in the environment
// (e.g. smtps://user:pass@smtp.example.com:465), it overrides the UI SMTP fields.
// EMAIL_FROM / EMAIL_TO set the default sender / recipient.
const SMTP_URL = (process.env.SMTP_URL || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || '').trim();
const EMAIL_TO = (process.env.EMAIL_TO || '').trim();

// Update check: at startup, compare the running version against the newest
// published tag of this Docker image. UPDATE_IMAGE names the image whose tag is
// the reference ("latest"); set UPDATE_CHECK=false to disable.
const UPDATE_IMAGE = (process.env.UPDATE_IMAGE || 'manixqc/direct-xfer:latest').trim();
const UPDATE_CHECK = String(process.env.UPDATE_CHECK == null ? 'true' : process.env.UPDATE_CHECK)
  .trim()
  .toLowerCase() !== 'false';
const _updColon = UPDATE_IMAGE.lastIndexOf(':');
const UPDATE_REPO = _updColon > 0 ? UPDATE_IMAGE.slice(0, _updColon) : UPDATE_IMAGE;
const UPDATE_TAG = _updColon > 0 ? UPDATE_IMAGE.slice(_updColon + 1) : 'latest';

fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
} catch (_) {}

// --- Admin password hashing (scrypt via built-in crypto; no plaintext at rest) ---
// The password file only ever holds a salted hash: "scrypt$<saltB64>$<hashB64>".
// The password is verified, never recovered.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function parseHash(stored) {
  const m = /^scrypt\$([^$]+)\$([^$]+)$/.exec(String(stored || '').trim());
  if (!m) return null;
  try {
    return { salt: Buffer.from(m[1], 'base64'), hash: Buffer.from(m[2], 'base64') };
  } catch (_) {
    return null;
  }
}
function verifyPassword(plain, rec) {
  if (!rec || !rec.hash || !rec.hash.length) return false;
  let cand;
  try {
    cand = crypto.scryptSync(String(plain), rec.salt, rec.hash.length);
  } catch (_) {
    return false;
  }
  return cand.length === rec.hash.length && crypto.timingSafeEqual(cand, rec.hash);
}

// ---- Admin accounts (multi-account: one 'owner' + any number of 'admin') ------
// Accounts live in the persisted store: state.meta.accounts = [ {
//   id, username, ah:"scrypt$..", role:'owner'|'admin', totp:{…}|null,
//   pwChanged:bool, createdAt, createdBy, lastLoginAt } ]. The owner may manage
// accounts; every account is otherwise a full admin. 2FA is per account.
const ADMIN_USERNAME = ((process.env.ADMIN_USERNAME || 'admin').trim() || 'admin').slice(0, 40);
let envOwnerHash = null;                    // parsed hash from ADMIN_PASSWORD (owner override)
let adminPwFromEnv = false;                 // true if the owner password is set via ADMIN_PASSWORD
let ADMIN_PASSWORD_GENERATED = false;
let ADMIN_PASSWORD_FRESH = false;
let ADMIN_PASSWORD_PLAINTEXT_ONCE = null;   // shown once at first launch, then null
// A fixed dummy hash so login timing is similar whether or not the username exists.
const DUMMY_PW_REC = parseHash(hashPassword(crypto.randomBytes(8).toString('hex')));

function normUsername(u) { return String(u || '').trim().toLowerCase().slice(0, 40); }
function accountList() { return (state.meta && Array.isArray(state.meta.accounts)) ? state.meta.accounts : []; }
function findAccountByName(username) {
  const n = normUsername(username);
  return accountList().find((a) => normUsername(a.username) === n) || null;
}
function getAccountById(id) { return accountList().find((a) => a.id === id) || null; }
function ownerAccount() { return accountList().find((a) => a.role === 'owner') || null; }
function newAccountId() { return crypto.randomBytes(8).toString('hex'); }

// Effective password record for verifying an account (owner honors ADMIN_PASSWORD).
function accountPwRec(acc) {
  if (acc && acc.role === 'owner' && adminPwFromEnv && envOwnerHash) return envOwnerHash;
  return parseHash(acc && acc.ah);
}
// True if the account must change its password before using the app.
function accountNeedsPwChange(acc) {
  if (!acc) return false;
  if (acc.role === 'owner' && adminPwFromEnv) return false; // env-managed
  return !acc.pwChanged;
}

// Resolves the admin accounts on startup. Migrates a legacy single-admin setup
// (admin-password.txt, then state.meta.ah + state.meta.totp) into an owner account.
function initAccounts() {
  if (!state.meta) state.meta = {};

  // One-time migration of an old admin-password.txt into state.meta.ah.
  const legacyFile = path.join(DATA_DIR, 'admin-password.txt');
  try {
    const raw = fs.readFileSync(legacyFile, 'utf8').trim();
    const alreadyMigrated = Array.isArray(state.meta.accounts) && state.meta.accounts.length;
    if (raw && !state.meta.ah && !alreadyMigrated) {
      state.meta.ah = parseHash(raw) ? raw : hashPassword(raw);
      persistNow();
      console.log('[config] migrated admin password into the data store; removed admin-password.txt.');
    }
    fs.unlinkSync(legacyFile);
  } catch (_) { /* no legacy file */ }

  // ADMIN_PASSWORD overrides the OWNER account's password (session-only, not stored).
  const fromEnv = (process.env.ADMIN_PASSWORD || '').trim();
  if (fromEnv) { envOwnerHash = parseHash(hashPassword(fromEnv)); adminPwFromEnv = true; }

  // Already on the accounts model.
  if (Array.isArray(state.meta.accounts) && state.meta.accounts.length) {
    // Keep the owner's login name in sync with ADMIN_USERNAME when env-managed.
    if (adminPwFromEnv) { const o = ownerAccount(); if (o) o.username = ADMIN_USERNAME; }
    ADMIN_PASSWORD_GENERATED = !adminPwFromEnv;
    return;
  }

  // Migrate a single legacy admin (state.meta.ah [+ state.meta.totp]) → owner account.
  const legacyHash = (state.meta.ah && parseHash(state.meta.ah)) ? state.meta.ah : null;
  let ownerHash = legacyHash;
  if (!ownerHash) {
    if (adminPwFromEnv) {
      // Owner password comes from ADMIN_PASSWORD (env override): it is never used
      // for login while that variable is set. Store a random placeholder hash and
      // do NOT advertise a generated password — printing one would be misleading
      // (it can never be used to log in) and pointless.
      ownerHash = hashPassword(crypto.randomBytes(12).toString('base64url'));
    } else {
      // Nothing stored → generate an owner password, shown once at first launch.
      const pw = crypto.randomBytes(12).toString('base64url');
      ownerHash = hashPassword(pw);
      ADMIN_PASSWORD_FRESH = true;
      ADMIN_PASSWORD_PLAINTEXT_ONCE = pw;
    }
  }
  const owner = {
    id: newAccountId(),
    username: ADMIN_USERNAME,
    ah: ownerHash,
    role: 'owner',
    totp: (state.meta.totp && state.meta.totp.secret) ? state.meta.totp : null,
    pwChanged: legacyHash ? !!getSettings().pwChanged : false,
    createdAt: Date.now(),
    createdBy: 'system',
    lastLoginAt: 0,
  };
  state.meta.accounts = [owner];
  delete state.meta.ah;    // now lives inside the account
  delete state.meta.totp;  // 2FA is now per account
  persistNow(); // durable so the (possibly generated) owner survives an immediate restart
  ADMIN_PASSWORD_GENERATED = !adminPwFromEnv;
}

// ===================================================================
//  UTILITIES: safe paths + bounded concurrency
// ===================================================================

// True if `target` equals `root` or is strictly contained in it (no `..`).
function withinRoot(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  const segments = rel.split(path.sep);
  return !segments.includes('..');
}

// Resolves a user-provided sub-path, neutralizing any traversal.
function resolveWithin(root, sub) {
  const raw = String(sub == null ? '' : sub).replace(/\\/g, '/');
  const normalized = path.posix.normalize('/' + raw).replace(/^\/+/, '');
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  // `sub` is untrusted, but it is normalized above (posix.normalize strips any
  // `..` that would climb past the leading `/`) and the resolved path is
  // rejected below by withinRoot() if it still escapes `root`. Nothing derived
  // from `target` is used before that check.
  const target = path.resolve(root, normalized);
  if (!withinRoot(root, target)) {
    const err = new Error('Path outside the allowed root');
    err.code = 'EPATH';
    throw err;
  }
  return target;
}

// Checks that the REAL path (symlinks resolved) stays within the real root.
async function assertRealWithin(root, target) {
  const realRoot = await fs.promises.realpath(root);
  const realTarget = await fs.promises.realpath(target);
  if (!withinRoot(realRoot, realTarget)) {
    const err = new Error('Path outside the root (symlink)');
    err.code = 'EPATH';
    throw err;
  }
  return realTarget;
}

// Real host path (absolute POSIX) of a container path located under HOST_ROOT.
// e.g. /host/home/me/movie.mp4  ->  /home/me/movie.mp4   ;   HOST_ROOT itself -> '/'.
function containerToHost(containerAbs) {
  const rel = path.relative(HOST_ROOT, containerAbs).split(path.sep).join('/');
  return '/' + rel;
}

// Real container path matching a host path, with anti-traversal guard.
function hostToContainer(hostPath) {
  return resolveWithin(HOST_ROOT, hostPath);
}

// Runs `fn` with at most `limit` concurrent executions.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(size).fill(0).map(async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ===================================================================
//  NETWORK: IP detection + port test (check-host.net)
// ===================================================================

let publicIpCache = { value: null, at: 0 };
const PUBLIC_IP_TTL = 5 * 60 * 1000;

// Only exposes a local IP if the operator provided it via LOCAL_IP. Inside
// a container, auto-detection would only return the Docker bridge internal IP
// (misleading): so without LOCAL_IP, no local IP is displayed.
function getLocalIPv4s() {
  return LOCAL_IP ? [{ iface: 'lan', address: LOCAL_IP }] : [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts = {}, timeoutMs = 7000) {
  const txt = await fetchText(url, opts, timeoutMs);
  return JSON.parse(txt);
}

// --- Update check (reads the Docker Hub tags of UPDATE_IMAGE) ---
let updateState = { current: APP_VERSION, latest: null, available: false, checkedAt: 0, error: null };

// Compares two "x.y.z" versions -> -1 | 0 | 1 (missing parts count as 0).
function compareSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.');
  const pb = String(b).replace(/^v/, '').split('.');
  for (let i = 0; i < 3; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Resolves the newest published version. Prefers the version tag that shares the
// reference tag's digest ("what latest points to"), else the highest semver tag.
// Non-fatal: on any failure the previous state is kept.
async function checkForUpdate() {
  if (!updateCheckEnabled()) return;
  try {
    const url = `https://hub.docker.com/v2/repositories/${UPDATE_REPO}/tags?page_size=100`;
    const data = await fetchJson(url, {}, 8000);
    const results = Array.isArray(data && data.results) ? data.results : [];
    const isSemver = (n) => /^v?\d+\.\d+\.\d+$/.test(n);
    const ref = results.find((tg) => tg && tg.name === UPDATE_TAG);
    const refDigest = ref && ref.digest;

    let latest = null;
    if (refDigest) {
      const matches = results
        .filter((tg) => tg && tg.name !== UPDATE_TAG && isSemver(tg.name) && tg.digest === refDigest)
        .map((tg) => tg.name.replace(/^v/, ''));
      if (matches.length) latest = matches.sort(compareSemver).pop();
    }
    if (!latest) {
      const all = results.filter((tg) => tg && isSemver(tg.name)).map((tg) => tg.name.replace(/^v/, ''));
      if (all.length) latest = all.sort(compareSemver).pop();
    }

    if (latest) {
      updateState = {
        current: APP_VERSION,
        latest,
        available: compareSemver(latest, APP_VERSION) > 0,
        checkedAt: Date.now(),
        error: null,
      };
    } else {
      updateState = { ...updateState, checkedAt: Date.now(), error: 'no-version-tags' };
    }
  } catch (e) {
    updateState = { ...updateState, checkedAt: Date.now(), error: (e && e.message) || 'check-failed' };
  }
}

let publicIpInFlight = null;
async function getPublicIP(force = false) {
  const now = Date.now();
  if (!force && publicIpCache.value && now - publicIpCache.at < PUBLIC_IP_TTL) {
    return publicIpCache.value;
  }
  // Merges concurrent calls into a single network request.
  if (publicIpInFlight) return publicIpInFlight;
  publicIpInFlight = (async () => {
    const sources = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
    for (const url of sources) {
      try {
        const txt = (await fetchText(url)).trim();
        const ip = txt.split('\n')[0].trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          publicIpCache = { value: ip, at: Date.now() };
          return ip;
        }
      } catch (_) {
        // next source
      }
    }
    return publicIpCache.value;
  })();
  try {
    return await publicIpInFlight;
  } finally {
    publicIpInFlight = null;
  }
}

// Non-blocking: serves the cache and refreshes in the background if stale.
function getPublicIPCached() {
  const now = Date.now();
  if (!publicIpCache.value || now - publicIpCache.at >= PUBLIC_IP_TTL) {
    getPublicIP(true).catch(() => {});
  }
  return publicIpCache.value;
}

// Interprets a check-host node result: true/false/null (pending).
function nodeState(value) {
  if (value == null) return null;
  const obj = Array.isArray(value) ? value[0] : value;
  if (obj == null) return null;
  if (typeof obj !== 'object') return false;
  if (obj.error) return false;
  return obj.time !== undefined || obj.address !== undefined;
}

async function checkPort(ip, port) {
  if (!ip) return { open: null, error: 'unknown-ip' };
  try {
    const start = await fetchJson(
      `https://check-host.net/check-tcp?host=${encodeURIComponent(ip + ':' + port)}&max_nodes=3`,
      { headers: { Accept: 'application/json' } }
    );
    if (!start || start.ok === 0 || !start.request_id) {
      return { open: null, error: 'service-unavailable' };
    }
    const rid = start.request_id;
    for (let i = 0; i < 8; i++) {
      await sleep(1400);
      let results;
      try {
        results = await fetchJson(`https://check-host.net/check-result/${rid}`, {
          headers: { Accept: 'application/json' },
        });
      } catch (_) {
        continue;
      }
      if (!results) continue;
      const entries = Object.entries(results);
      if (entries.length === 0) continue;
      const states = entries.map(([, v]) => nodeState(v));
      const pending = states.filter((s) => s === null).length;
      const openCount = states.filter((s) => s === true).length;
      if (openCount > 0) return { open: true, openNodes: openCount, total: entries.length };
      if (pending === 0) return { open: false, openNodes: 0, total: entries.length };
    }
    return { open: null, error: 'timeout' };
  } catch (e) {
    return { open: null, error: e.message };
  }
}

// --- IP geolocation (country) ---
const geoCache = new Map(); // ip -> { country, countryCode, flag, at }
const GEO_TTL = 60 * 60 * 1000;

function isPrivateIp(ip) {
  const v = String(ip || '').replace(/^::ffff:/i, '');
  if (!v || v === '127.0.0.1' || v === '::1') return true;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  if (/^f[cd]/i.test(v)) return true; // IPv6 unique local
  return false;
}

// --- Server local network (auto-detection of subnets) ---
function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  const n = ((parseInt(p[0], 10) << 24) | (parseInt(p[1], 10) << 16) | (parseInt(p[2], 10) << 8) | parseInt(p[3], 10)) >>> 0;
  return Number.isFinite(n) ? n : null;
}
function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
function maskToPrefix(mask) {
  const m = ipToInt(mask);
  if (m == null) return null;
  let count = 0, x = m >>> 0;
  for (let i = 0; i < 32; i++) { if ((x >>> 31) & 1) count++; x = (x << 1) >>> 0; }
  return count;
}

let localNetsCache = null;
function getLocalNets() {
  if (localNetsCache) return localNetsCache;
  const nets = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      let prefix = null;
      let addr = ni.address;
      if (ni.cidr) {
        const parts = ni.cidr.split('/');
        addr = parts[0];
        prefix = parseInt(parts[1], 10);
      } else if (ni.netmask) {
        prefix = maskToPrefix(ni.netmask);
      }
      if (!Number.isFinite(prefix) || prefix == null) continue;
      const base = ipToInt(addr);
      if (base == null) continue;
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      nets.push({ base: (base & mask) >>> 0, mask, cidr: intToIp((base & mask) >>> 0) + '/' + prefix });
    }
  }
  localNetsCache = nets;
  return nets;
}

// True if the IP belongs to the server's local network (loopback, detected
// subnet, or private range as a safety net).
function isLocalNetwork(ip) {
  const v = String(ip || '').replace(/^::ffff:/i, '');
  // Fail closed when the peer address is unavailable. Treating an empty or
  // unknown address as local would bypass the LAN-only admin guard.
  if (!v || v === 'unknown') return false;
  if (v === '127.0.0.1' || v === '::1') return true;
  const n = ipToInt(v);
  if (n != null) {
    for (const net of getLocalNets()) {
      if (((n & net.mask) >>> 0) === net.base) return true;
    }
  }
  return isPrivateIp(v);
}

// --- IP allowlist for the admin (IPv4 IP or CIDR) ---
function parseIpList(str) {
  const out = [];
  for (const raw of String(str || '').split(/[\s,]+/)) {
    const item = raw.trim();
    if (!item) continue;
    const slash = item.indexOf('/');
    const base = ipToInt(slash === -1 ? item : item.slice(0, slash));
    if (base == null) continue; // invalid entry -> ignored
    let prefix = slash === -1 ? 32 : parseInt(item.slice(slash + 1), 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) prefix = 32;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    out.push({ base: (base & mask) >>> 0, mask });
  }
  return out;
}
function ipInList(ip, list) {
  const n = ipToInt(String(ip || '').replace(/^::ffff:/i, ''));
  if (n == null) return false;
  for (const net of list) if (((n & net.mask) >>> 0) === net.base) return true;
  return false;
}
function isLoopback(ip) {
  const v = String(ip || '').replace(/^::ffff:/i, '');
  return v === '::1' || v.startsWith('127.');
}

// Emoji flag from the ISO-3166 country code (regional indicators).
function flagFromCode(cc) {
  const c = String(cc || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (c.length !== 2) return '🌐';
  const base = 0x1f1e6;
  return c.split('').map((ch) => String.fromCodePoint(base + ch.charCodeAt(0) - 65)).join('');
}

async function geolocate(ip) {
  const clean = String(ip || '').replace(/^::ffff:/i, '');
  if (isPrivateIp(clean)) return { country: 'Local network', countryCode: null, flag: '🏠' };
  // Privacy: when geolocation is disabled, make no external lookup.
  if (getSettings().geoLookup === false) return { country: null, countryCode: null, flag: '🌐' };

  const cached = geoCache.get(clean);
  if (cached && Date.now() - cached.at < GEO_TTL) return cached;

  let g = { country: null, countryCode: null, flag: '🌐', at: Date.now() };
  // 1) ipwho.is (HTTPS, no key)
  try {
    const d = await fetchJson(
      `https://ipwho.is/${encodeURIComponent(clean)}?fields=success,country,country_code,flag`,
      {},
      5000
    );
    if (d && d.success) {
      g = {
        country: d.country || null,
        countryCode: d.country_code || null,
        flag: (d.flag && d.flag.emoji) || flagFromCode(d.country_code),
        at: Date.now(),
      };
    }
  } catch (_) {}
  // No plaintext-HTTP fallback: visitor IPs and country access decisions must
  // never cross the network without transport encryption.
  geoCache.set(clean, g);
  return g;
}

// ===================================================================
//  ACTIVE TRANSFERS: transfers in progress (IP + country)
// ===================================================================

const activeTransfers = new Map(); // id -> transfer
const TRANSFER_STALL_MS = Math.max(15000, Math.min(10 * 60 * 1000, Number(process.env.TRANSFER_STALL_MS) || 45000));
const HISTORY_MAX = 2000; // persistent transfer history kept in shares.json
const AUDIT_MAX = 500;  // most recent admin audit entries kept (state.audit, shares.json)
let historyViewRevision = 0; // IP labels/privacy settings that affect rendered records

// Country from the cache (no network call), otherwise null.
function geoSync(ip) {
  const clean = String(ip || '').replace(/^::ffff:/i, '');
  if (isPrivateIp(clean)) return { country: 'Local network', countryCode: null, flag: '🏠' };
  const c = geoCache.get(clean);
  return c && Date.now() - c.at < GEO_TTL ? c : null;
}

// --- Feature 11: per-link geo/IP access rules -------------------------------
// A share may allow/deny access by country (ISO codes) and/or by IP/CIDR. IP
// rules are the hard boundary (synchronous). Country allowlists fail closed when
// a public IP cannot be located; denylists remain best-effort. Local addresses are
// always allowed so administrators can test links from their own network.
function hasAccessRules(s) {
  return !!(s && ((s.ipMode && Array.isArray(s.ipList) && s.ipList.length)
    || (s.geoMode && Array.isArray(s.geoCountries) && s.geoCountries.length)));
}
async function linkAccessReason(req, s) {
  const ip = clientIp(req);
  if (isLoopback(ip)) return null;
  if (s.ipMode && Array.isArray(s.ipList) && s.ipList.length) {
    const inList = ipInList(ip, parseIpList(s.ipList.join(',')));
    if (s.ipMode === 'allow' && !inList) return 'ip';
    if (s.ipMode === 'deny' && inList) return 'ip';
  }
  if (s.geoMode && Array.isArray(s.geoCountries) && s.geoCountries.length) {
    if (isPrivateIp(ip)) return null;
    let g = geoSync(ip);
    if (!g) { try { g = await geolocate(ip); } catch (_) {} }
    const cc = g && g.countryCode ? String(g.countryCode).toUpperCase() : null;
    if (!cc && s.geoMode === 'allow') return 'geo';
    if (cc) {
      const inList = s.geoCountries.includes(cc);
      if (s.geoMode === 'allow' && !inList) return 'geo';
      if (s.geoMode === 'deny' && inList) return 'geo';
    }
  }
  return null;
}
// Validates create/edit input and mutates the target share's access-rule fields
// (deleting them when a mode is 'off'/empty).
function applyAccessRules(target, body) {
  if (body.geoMode !== undefined) {
    if (body.geoMode === 'allow' || body.geoMode === 'deny') {
      target.geoMode = body.geoMode;
      target.geoCountries = (String(body.geoCountries || '').toUpperCase().match(/[A-Z]{2}/g) || []).slice(0, 100);
    } else { delete target.geoMode; delete target.geoCountries; }
  }
  if (body.ipMode !== undefined) {
    if (body.ipMode === 'allow' || body.ipMode === 'deny') {
      target.ipMode = body.ipMode;
      target.ipList = String(body.ipList || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 100);
    } else { delete target.ipMode; delete target.ipList; }
  }
}

function startTransfer(req, meta, expectedBytes) {
  const id = crypto.randomBytes(6).toString('hex');
  const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
  const t = {
    id,
    shareId: meta.shareId,
    name: meta.name,
    type: meta.type,
    direction: meta.direction || 'down', // 'down' = download, 'up' = upload
    ip,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    bytes: 0,
    expectedBytes: expectedBytes || 0,
    country: null,
    countryCode: null,
    flag: null,
    ownerId: null,
    ownerName: null,
    abort: null, // set by the caller to allow aborting
  };
  const transferShare = meta.shareId ? getById(meta.shareId) : null;
  if (transferShare) {
    t.ownerId = transferShare.ownerId || null;
    t.ownerName = transferShare.ownerName || null;
  }
  // Country: immediate if cached/LAN, otherwise filled in once geolocation answers.
  const g = geoSync(ip);
  if (g) {
    t.country = g.country;
    t.countryCode = g.countryCode;
    t.flag = g.flag;
  } else {
    geolocate(ip)
      .then((geo) => {
        t.country = geo.country;
        t.countryCode = geo.countryCode;
        t.flag = geo.flag;
      })
      .catch(() => {});
  }
  // Nominative sub-link: attribute this transfer to a recipient when the request
  // came in on a recipient token (see indexRecipients / recordStat).
  const rtok = req && req.params && req.params.token;
  const rc = rtok ? recipientByToken.get(rtok) : null;
  if (rc && rc.recipient) { t.recipientToken = rc.recipient.token; t.recipientName = rc.recipient.name; }
  activeTransfers.set(id, t);
  return t;
}

// Guesses the webhook format from the URL (otherwise generic JSON).
function autoWebhookFormat(url) {
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return 'discord';
  if (/hooks\.slack\.com/i.test(url)) return 'slack';
  if (/ntfy\b/i.test(url)) return 'ntfy';
  return 'json';
}

// Result of the most recent webhook call, surfaced on the dashboard.
let lastWebhook = null; // { at, ok, status, event, error }

// The webhook actually used: the WEBHOOK_URL env var takes precedence over the
// UI-configured one (so env-driven deployments aren't overridden from the UI).
function effectiveWebhook() {
  if (WEBHOOK_URL) return { url: WEBHOOK_URL, format: WEBHOOK_FORMAT || autoWebhookFormat(WEBHOOK_URL), fromEnv: true };
  const s = getSettings();
  const url = String(s.webhookUrl || '').trim();
  return { url, format: (s.webhookFormat || '') || (url ? autoWebhookFormat(url) : ''), fromEnv: false };
}

// Low-level POST to a webhook. Returns a promise resolving to { ok, status, error }
// and records the result in lastWebhook. `payload` carries structured JSON fields.
function sendWebhook(url, format, message, kind, payload) {
  const fmt = format || autoWebhookFormat(url);
  let body, contentType = 'application/json';
  if (fmt === 'ntfy') { body = message; contentType = 'text/plain; charset=utf-8'; }
  else if (fmt === 'slack') body = JSON.stringify({ text: message });
  else if (fmt === 'discord') body = JSON.stringify({ content: message });
  else body = JSON.stringify({ app: APP_NAME, event: kind, message, ...(payload || {}) });
  const finish = (ok, status, error) => {
    lastWebhook = { at: Date.now(), ok, status, event: kind, error };
    if (!ok) console.error('[webhook] failed:', error);
    return { ok, status, error };
  };
  try {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': contentType }, body, signal: AbortSignal.timeout(5000) })
      .then((res) => finish(res.ok, res.status, res.ok ? null : 'HTTP ' + res.status))
      .catch((e) => finish(false, 0, e.message));
  } catch (e) {
    return Promise.resolve(finish(false, 0, e.message));
  }
}

// Whether an event kind should be notified, per the per-event toggles.
function notifyEnabled(kind) {
  const s = getSettings();
  if (kind === 'received') return s.notifyUploads !== false;
  if (kind === 'downloaded') return s.notifyDownloads !== false;
  if (kind === 'message') return s.notifyMessages !== false;
  return true;
}

// Notifies the admin over every configured channel (webhook + e-mail).
function notify(kind, info) {
  if (!notifyEnabled(kind)) return;
  const where = info.country ? ` · ${info.country}` : '';
  let subject, message;
  if (kind === 'message') {
    const onFile = info.file ? ` [${info.file}]` : '';
    subject = `${APP_NAME} — Message on "${info.name}"`;
    message = `💬 ${APP_NAME} — Message on "${info.name}"${onFile}: ${info.text} — ${info.ip}${where}`;
  } else {
    const label = kind === 'received' ? 'File received' : 'File downloaded';
    const icon = kind === 'received' ? '📥' : '⬇️';
    subject = `${APP_NAME} — ${label}: ${info.name}`;
    message = `${icon} ${APP_NAME} — ${label}: "${info.name}" (${formatBytes(info.bytes)}) — ${info.ip}${where}`;
  }
  dispatch(kind, subject, message, {
    name: info.name, bytes: info.bytes, ip: info.ip, country: info.country || null, file: info.file || null,
  }); // fire-and-forget
}

// Feature 4 — "link likely leaked" detection. Per share, keep an in-memory rolling
// window of completed-download signals; when the distinct-country count crosses
// the configured threshold, fire ONE alert (then a cooldown of the same window).
// In-memory only (a live heuristic) — resets on restart, never bloats shares.json.
const leakTrackers = new Map(); // shareId -> { events: [{cc, ip, at}], alertedAt }
const LEAK_MAX_EVENTS = 10000; // per-share cap so a scraped link can't grow unbounded
// Drops leak trackers for shares that no longer exist or whose window has fully
// elapsed, so the map doesn't accumulate stale entries over the process lifetime.
function pruneLeakTrackers() {
  const windowMs = Math.max(1, Number(getSettings().leakAlertWindowHours) || 24) * 3600 * 1000;
  const now = Date.now();
  for (const [id, tr] of leakTrackers) {
    const live = tr.events.some((e) => now - e.at < windowMs);
    if (!live && now - tr.alertedAt > windowMs) leakTrackers.delete(id);
    else if (!getById(id)) leakTrackers.delete(id); // share revoked/deleted
  }
}
function noteLeakSignal(t) {
  const s = getSettings();
  if (!s.leakAlertEnabled || !t || !t.shareId) return;
  const windowMs = Math.max(1, Number(s.leakAlertWindowHours) || 24) * 3600 * 1000;
  const threshold = Math.max(2, Math.floor(Number(s.leakAlertCountries) || 3));
  const now = Date.now();
  let tr = leakTrackers.get(t.shareId);
  if (!tr) { tr = { events: [], alertedAt: 0 }; leakTrackers.set(t.shareId, tr); }
  tr.events.push({ cc: t.countryCode || null, ip: t.ip, at: now });
  tr.events = tr.events.filter((e) => now - e.at < windowMs);
  // Bound memory on a hot/scraped link: only the tail matters for distinct-country
  // and distinct-IP counting, and the cap is far above any sane threshold.
  if (tr.events.length > LEAK_MAX_EVENTS) tr.events = tr.events.slice(-LEAK_MAX_EVENTS);
  const countries = new Set(tr.events.map((e) => e.cc).filter(Boolean));
  const ips = new Set(tr.events.map((e) => e.ip));
  if (countries.size >= threshold && now - tr.alertedAt > windowMs) {
    tr.alertedAt = now;
    const sh = getById(t.shareId);
    const name = sh ? (sh.name || sh.id) : t.shareId;
    const list = [...countries].slice(0, 12).join(', ');
    const message = `🚨 ${APP_NAME} — Link possibly leaked: "${name}" was downloaded from ${countries.size} countries `
      + `(${ips.size} distinct IPs) in ${Math.round(windowMs / 3600000)}h — ${list}`;
    dispatch('leak', `${APP_NAME} — Link possibly leaked: ${name}`, message, {
      name, token: sh ? sh.token : null, countries: countries.size, ips: ips.size, list: [...countries],
    });
    logAudit('leak-alert', { username: 'system', detail: `${name}: ${countries.size} countries, ${ips.size} IPs` });
  }
}

// --- E-mail (SMTP) notifications --------------------------------------------
let lastEmail = null;        // { at, ok, error } — surfaced on the dashboard
let mailerCache = null;      // { key, transport } — rebuilt when the config changes

// The effective SMTP config: the SMTP_URL env var wins over the UI fields.
function effectiveEmail() {
  const s = getSettings();
  const to = EMAIL_TO || String(s.smtpTo || '').trim();
  const from = EMAIL_FROM || String(s.smtpFrom || '').trim() || String(s.smtpUser || '').trim();
  if (SMTP_URL) return { fromEnv: true, url: SMTP_URL, to, from };
  return {
    fromEnv: false,
    host: String(s.smtpHost || '').trim(),
    port: Number(s.smtpPort) || 587,
    secure: !!s.smtpSecure,
    user: String(s.smtpUser || '').trim(),
    pass: String(s.smtpPass || ''),
    to, from,
  };
}
// True when e-mail can actually be sent (module present, enabled, and addressed).
function emailConfigured() {
  if (!nodemailer) return false;
  if (!getSettings().emailEnabled && !SMTP_URL) return false;
  const e = effectiveEmail();
  if (!e.to) return false;
  return SMTP_URL ? true : !!e.host;
}
// Builds (and caches) a nodemailer transport for the current config.
function getMailer() {
  if (!nodemailer) return null;
  const e = effectiveEmail();
  const key = JSON.stringify([e.url || '', e.host || '', e.port || '', e.secure || false, e.user || '', e.pass ? 'set' : '']);
  if (mailerCache && mailerCache.key === key) return mailerCache.transport;
  const transport = e.url
    ? nodemailer.createTransport(e.url)
    : nodemailer.createTransport({
        host: e.host, port: e.port, secure: e.secure,
        auth: e.user ? { user: e.user, pass: e.pass } : undefined,
      });
  mailerCache = { key, transport };
  return transport;
}
// Sendable = transport reachable + a From address; a default recipient is only
// needed for notifications (sendMail can be given an explicit recipient, e.g. the
// "e-mail this link" action).
function emailSendable() {
  if (!nodemailer) return false;
  if (!getSettings().emailEnabled && !SMTP_URL) return false;
  const e = effectiveEmail();
  if (!e.from) return false;
  return SMTP_URL ? true : !!e.host;
}
// Sends one e-mail (best-effort). `toOverride` targets a specific recipient (the
// "e-mail this link" action); without it, the configured notification recipient is
// used. Returns { ok, error }.
async function sendMail(subject, text, toOverride) {
  const e = effectiveEmail();
  const tx = getMailer();
  const to = (toOverride && String(toOverride).trim()) || e.to;
  if (!tx || !to || !e.from) { lastEmail = { at: Date.now(), ok: false, error: 'not-configured' }; return lastEmail; }
  try {
    await tx.sendMail({ from: e.from, to, subject, text });
    lastEmail = { at: Date.now(), ok: true, error: null };
  } catch (err) {
    lastEmail = { at: Date.now(), ok: false, error: err.message };
    console.error('[email] send failed:', err.message);
  }
  return lastEmail;
}

// Dispatches a notification to every configured channel (webhook + e-mail),
// honoring the per-event toggles. `subject` is the e-mail subject line; the
// webhook receives `message` (its single-string body) and structured `payload`.
function dispatch(kind, subject, message, payload) {
  if (!notifyEnabled(kind)) return;
  const wh = effectiveWebhook();
  if (wh.url) sendWebhook(wh.url, wh.format, message, kind, payload || {});
  if (emailConfigured()) sendMail(subject, message);
  if (webPushActive()) sendWebPush(kind, subject, message, payload || {});
}

// ===================================================================
//  WEB PUSH (browser notifications) — optional (web-push module)
// ===================================================================
// VAPID keys are generated once and persisted in state.meta (encrypted at rest
// with DATA_KEY). Subscriptions live in state.meta.pushSubs. Sending fans out to
// every stored subscription; endpoints that report Gone (404/410) are pruned.

// VAPID contact "sub": a mailto or https URI (push services require a valid one).
// Prefer a configured e-mail, else fall back to a stable project URL.
function vapidSubject() {
  const s = getSettings();
  const email = String(s.smtpFrom || s.smtpTo || process.env.EMAIL_FROM || process.env.EMAIL_TO || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'mailto:' + email;
  return 'https://github.com/ManixQC/Direct-Xfer';
}

// Returns the VAPID key pair, generating and persisting it on first use.
function getVapidKeys() {
  if (!webpush) return null;
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  const v = state.meta.vapid;
  if (v && v.publicKey && v.privateKey) return v;
  const keys = webpush.generateVAPIDKeys();
  state.meta.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  persist();
  return state.meta.vapid;
}

function pushSubs() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!Array.isArray(state.meta.pushSubs)) state.meta.pushSubs = [];
  return state.meta.pushSubs;
}

// Live channel = module present, VAPID keys exist, and at least one subscription.
function webPushActive() {
  return !!(webpush && state.meta && state.meta.vapid && pushSubs().length);
}

function dropPushSub(endpoint) {
  const subs = pushSubs();
  const i = subs.findIndex((x) => x.endpoint === endpoint);
  if (i !== -1) { subs.splice(i, 1); return true; }
  return false;
}

// Fans a notification out to a set of subscriptions (default: all). Fire-and-forget;
// a Gone endpoint (404/410) is pruned so dead subscriptions never accumulate.
function sendWebPush(kind, title, body, payload, subs) {
  if (!webpush) return 0;
  const keys = getVapidKeys();
  if (!keys) return 0;
  const targets = subs || pushSubs().slice();
  if (!targets.length) return 0;
  const data = JSON.stringify({
    title: title || APP_NAME,
    body: body || '',
    kind: kind || '',
    url: payload && payload.url ? String(payload.url) : '/',
    token: payload && payload.token ? String(payload.token) : null,
    ts: Date.now(),
  });
  const opts = { vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 };
  for (const sub of targets) {
    webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, data, opts)
      .catch((err) => {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) { if (dropPushSub(sub.endpoint)) persist(); }
        else console.error('[webpush] send failed:', code || (err && err.message));
      });
  }
  return targets.length;
}

const DAY_MS = 86400000;

// Feature 5 — proactive "link expiring soon" alerts. Once per link, within the
// configured window before expiry, sends one webhook and stamps the share
// (expiryWarnedAt) so the warning is never repeated.
function checkExpiringShares() {
  const s = getSettings();
  if (!s.notifyExpiring) return;
  if (!effectiveWebhook().url && !emailConfigured() && !webPushActive()) return;
  const now = Date.now();
  const windowMs = Math.max(1, Number(s.expiryWarnHours) || 24) * 3600 * 1000;
  let changed = false;
  for (const sh of listShares()) {
    if (sh.revoked || !sh.expiresAt || sh.expiryWarnedAt) continue;
    if (sh.expiresAt <= now || sh.expiresAt - now > windowMs) continue;
    if (!isActive(sh, now)) continue; // scheduled / quota-exhausted → skip
    const hrs = Math.max(1, Math.round((sh.expiresAt - now) / 3600000));
    const when = new Date(sh.expiresAt).toISOString();
    const message = `⏳ ${APP_NAME} — Link expiring in ~${hrs}h: "${sh.name}" (${when})`;
    dispatch('expiring', `${APP_NAME} — Link expiring soon: ${sh.name}`, message, {
      name: sh.name, token: sh.token, type: sh.type, expiresAt: sh.expiresAt, hoursLeft: hrs,
    });
    sh.expiryWarnedAt = now;
    changed = true;
  }
  if (changed) persist();
}

// Reads the transfer journal and sums activity since `sinceTs`: overall totals
// plus per-link volume. Best-effort; a missing/rotated journal yields zeros.
function aggregateJournalSince(sinceTs) {
  const out = { transfers: 0, bytes: 0, up: 0, down: 0, perLink: new Map() };
  // Bounded tail read (matches the pre-existing 40000-line cap) so the digest never
  // loads a huge journal fully into memory.
  let lines = readLogTail(16 * 1024 * 1024);
  if (lines.length > 40000) lines = lines.slice(-40000);
  for (const line of lines) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    const ts = r.endedAt || r.startedAt || 0;
    if (ts < sinceTs) continue;
    const bytes = r.bytes || 0;
    out.transfers += 1;
    out.bytes += bytes;
    if (r.direction === 'up') out.up += bytes; else out.down += bytes;
    const key = r.shareId || r.name || '?';
    const name = r.name || (r.shareId ? String(r.shareId) : '?');
    const cur = out.perLink.get(key) || { name, bytes: 0, count: 0 };
    cur.bytes += bytes; cur.count += 1;
    out.perLink.set(key, cur);
  }
  return out;
}

// Feature 9 — periodic activity digest. Sends a recap over the webhook every
// `digestDays` days (cadence tracked in state.meta.lastDigestAt). `force` bypasses
// both the enabled flag and the cadence (used by the "send now" test button).
function maybeSendDigest(force) {
  const s = getSettings();
  if (!force && !s.digestEnabled) return { skipped: 'disabled' };
  if (!effectiveWebhook().url && !emailConfigured()) return { skipped: 'no-channel' };
  const now = Date.now();
  const everyMs = Math.max(1, Number(s.digestDays) || 7) * DAY_MS;
  const last = (state.meta && state.meta.lastDigestAt) || 0;
  if (!force && last && now - last < everyMs) return { skipped: 'not-due' };

  const since = last || now - everyMs;
  const agg = aggregateJournalSince(since);
  const topLinks = [...agg.perLink.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  const soonMs = 7 * DAY_MS;
  const expiring = listShares()
    .filter((sh) => sh.expiresAt && sh.expiresAt > now && sh.expiresAt - now <= soonMs && isActive(sh, now))
    .sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 8)
    .map((sh) => ({ name: sh.name, expiresAt: sh.expiresAt }));

  const days = Math.round((now - since) / DAY_MS) || Number(s.digestDays) || 7;
  const lines = [
    `📊 ${APP_NAME} — Activity digest (last ${days}d)`,
    `• Transfers: ${agg.transfers} · Volume: ${formatBytes(agg.bytes)} (↓ ${formatBytes(agg.down)} / ↑ ${formatBytes(agg.up)})`,
  ];
  if (topLinks.length) {
    lines.push('• Top links: ' + topLinks.map((l) => `${l.name} (${formatBytes(l.bytes)})`).join(', '));
  }
  if (expiring.length) {
    lines.push('• Expiring soon: ' + expiring.map((e) => `${e.name} (${new Date(e.expiresAt).toISOString().slice(0, 10)})`).join(', '));
  } else {
    lines.push('• Expiring soon: none');
  }
  const message = lines.join('\n');
  dispatch('digest', `${APP_NAME} — Activity digest`, message, {
    days, transfers: agg.transfers, bytes: agg.bytes, up: agg.up, down: agg.down,
    topLinks, expiring,
  });
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  state.meta.lastDigestAt = now;
  persist();
  return { ok: true, transfers: agg.transfers, bytes: agg.bytes };
}

// --- Persistent transfer journal (append-only JSONL) + per-link aggregates ---

// Appends one finished-transfer record to transfers.log (best-effort, async).
function appendLog(record) {
  if (!dataWritable()) return;
  fs.appendFile(LOG_FILE, JSON.stringify(record) + '\n', (err) => {
    if (err) console.error('[log] append failed:', err.message);
  });
}

// On startup, if the journal grew past MAX_LOG_BYTES, keep only the tail (whole
// lines). Bounds disk use without a second rotated file to read back on export.
function trimLogIfNeeded() {
  if (!MAX_LOG_BYTES) return;
  let sz;
  try {
    sz = fs.statSync(LOG_FILE).size;
  } catch (_) {
    return; // no log yet
  }
  if (sz <= MAX_LOG_BYTES) return;
  try {
    const buf = fs.readFileSync(LOG_FILE);
    const keep = buf.slice(buf.length - Math.floor(MAX_LOG_BYTES / 2)); // keep newest half
    const nl = keep.indexOf(0x0a); // drop the partial first line
    const clean = nl >= 0 ? keep.slice(nl + 1) : keep;
    fs.writeFileSync(LOG_FILE + '.tmp', clean, { mode: 0o600 });
    fs.renameSync(LOG_FILE + '.tmp', LOG_FILE);
    console.log('[log] transfers.log trimmed to the most recent entries.');
  } catch (e) {
    console.error('[log] trim failed:', e.message);
  }
}

// Updates the per-share aggregate for a finished transfer. Name/type are
// snapshotted so stats stay meaningful after the share is revoked.
function recordStat(t, completed) {
  const key = t.shareId || 'unknown';
  const dir = (t.direction || 'down') === 'up' ? 'up' : 'down';
  const share = getById(t.shareId);
  const cur = state.stats[key] || {
    name: (share && share.name) || t.name || key,
    type: (share && share.type) || t.type || dir,
    count: 0, bytes: 0, up: 0, down: 0, completed: 0, interrupted: 0, lastAt: 0,
  };
  if (share && share.name) cur.name = share.name; // keep the current name fresh
  cur.count += 1;
  cur.bytes += t.bytes || 0;
  cur[dir] += 1;
  if (completed) cur.completed += 1; else cur.interrupted += 1;
  cur.lastAt = Date.now();
  state.stats[key] = cur;
  // Per-recipient aggregate for nominative sub-links.
  if (t.recipientToken) {
    const rc = recipientByToken.get(t.recipientToken);
    if (rc && rc.recipient) {
      const rs = rc.recipient.stats || { count: 0, bytes: 0, completed: 0, interrupted: 0, lastAt: 0 };
      rs.count += 1;
      rs.bytes += t.bytes || 0;
      if (completed) rs.completed += 1; else rs.interrupted += 1;
      rs.lastAt = Date.now();
      if (t.ip) rs.lastIp = t.ip;
      if (t.country) rs.lastCountry = t.country;
      rc.recipient.stats = rs;
    }
  }
}

// Feature 4 — records that a recipient opened their nominative link (a "read
// receipt"): first-seen + last-seen timestamps and where from. Called on the
// landing page GET; downloads are tracked separately via recordStat().
function recordRecipientView(req) {
  const tok = req && req.params && req.params.token;
  if (!tok) return;
  const rc = recipientByToken.get(tok);
  if (!rc || !rc.recipient) return;
  const r = rc.recipient;
  const now = Date.now();
  if (!r.viewedAt) r.viewedAt = now; // first open
  r.lastViewAt = now;
  const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
  if (ip) {
    r.lastViewIp = ip;
    const g = geoSync(ip);
    if (g) r.lastViewCountry = g.country;
  }
  scheduleFlush();
}

// Ends a transfer and archives it in the history (completed or not).
function endTransfer(t, completed, reason = null) {
  if (!t) return;
  activeTransfers.delete(t.id);
  const endedAt = Date.now();
  const durationMs = endedAt - t.startedAt;
  const record = {
    id: t.id,
    shareId: t.shareId || null,
    ownerId: t.ownerId || null,
    ownerName: t.ownerName || null,
    recipientName: t.recipientName || null,
    name: t.name,
    type: t.type,
    isZip: !!t.isZip,
    direction: t.direction || 'down',
    ip: t.ip,
    country: t.country,
    countryCode: t.countryCode,
    flag: t.flag,
    bytes: t.bytes,
    durationMs,
    startedAt: t.startedAt,
    endedAt,
    completed: !!completed,
    reason: completed ? null : String(reason || t.failureReason || 'interrupted').slice(0, 80),
    avgBps: durationMs > 0 ? Math.round((t.bytes / durationMs) * 1000) : 0,
  };
  state.history.unshift(record);
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  pruneHistory();             // drop records past the retention window (if any)
  recordStat(t, completed);   // per-link aggregate (persisted in shares.json)
  appendLog(record);          // durable, exportable journal (transfers.log)
  scheduleFlush(); // persists the history + stats (deferred write)
  // Only notifies "interesting" and complete transfers (t.notify),
  // to avoid spam on partial Range requests.
  if (completed && t.notify) {
    notify(t.direction === 'up' ? 'received' : 'downloaded', {
      name: t.name, ip: t.ip, country: t.country, bytes: t.bytes,
    });
  }
  if (completed && (t.direction || 'down') === 'down') noteLeakSignal(t); // feature 4
  // One-time link: a complete download (not a partial Range chunk) revokes the
  // share so the URL stops working. `t.notify` guarantees a full-file/zip download.
  if (completed && t.notify && (t.direction || 'down') === 'down' && t.shareId) {
    const sh = getById(t.shareId);
    if (sh && sh.burnAfterDownload && !sh.revoked) {
      sh.revoked = true;
      sh.burnedAt = Date.now();
      logAudit('share-burned', { username: 'system', detail: (sh.type || 'share') + ' ' + (sh.name || '') + ' (one-time link)' });
      persist();
    }
  }
}

// Optional admin-assigned nickname for a visitor IP (shown next to the IP in the
// live-transfers and history views). Disabled when keepIpNames is off.
function ipNameFor(ip) {
  if (getSettings().keepIpNames === false) return null;
  return (ip && state.ipNames && state.ipNames[ip]) || null;
}

// Privacy: mask the host part of an IP (last IPv4 octet / trailing IPv6 groups)
// when anonymizeIps is enabled. Applied to what the admin UI sees, so nicknames
// key on the same (masked) value and still resolve.
function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '');
  if (!s) return s;
  if (s.indexOf(':') > -1) return s.split(':').slice(0, 3).join(':') + '::';
  const p = s.split('.');
  if (p.length === 4) { p[3] = 'x'; return p.join('.'); }
  return s;
}
function pubIp(ip) {
  return getSettings().anonymizeIps ? maskIp(ip) : ip;
}

// Drops history records older than historyRetentionDays (0 = no age limit) and
// always enforces the hard cap so an imported/legacy store cannot grow forever.
function pruneHistory() {
  const days = Math.floor(Number(getSettings().historyRetentionDays));
  const before = state.history.length;
  if (Number.isFinite(days) && days > 0) {
    const cutoff = Date.now() - days * 86400000;
    state.history = state.history.filter((r) => (r.endedAt || r.startedAt || 0) >= cutoff);
  }
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  return state.history.length !== before;
}

function listTransfers(allowedShareIds) {
  const now = Date.now();
  return [...activeTransfers.values()]
    .filter((t) => !allowedShareIds || allowedShareIds.has(t.shareId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((t) => {
      const durationMs = now - t.startedAt;
      const lastActivity = t.lastActivity || t.startedAt;
      const idleMs = Math.max(0, now - lastActivity);
      const ip = pubIp(t.ip);
      return {
        id: t.id,
        name: t.name,
        type: t.type,
        direction: t.direction || 'down',
        ip,
        ipName: ipNameFor(ip),
        country: t.country,
        countryCode: t.countryCode,
        flag: t.flag,
        bytes: t.bytes,
        expectedBytes: t.expectedBytes || 0,
        isZip: !!t.isZip,
        zipTotalBytes: t.zipTotalBytes || 0,
        zipProcessedBytes: t.zipProcessedBytes || 0,
        durationMs,
        lastActivity,
        idleMs,
        stalled: durationMs >= TRANSFER_STALL_MS && idleMs >= TRANSFER_STALL_MS,
        stallThresholdMs: TRANSFER_STALL_MS,
        avgBps: durationMs > 0 ? Math.round((t.bytes / durationMs) * 1000) : 0,
      };
    });
}

function listHistory(allowedShareIds) {
  return state.history.filter((r) => !allowedShareIds || allowedShareIds.has(r.shareId)).map((r) => {
    const ip = pubIp(r.ip);
    return { ...r, ip, ipName: ipNameFor(ip) };
  });
}

// Tiny change detector used by the periodic admin poll. Returning the full
// 2,000-entry history there would waste bandwidth and repeatedly serialize a
// large payload even when nothing changed.
function historyMeta(allowedShareIds) {
  let count = 0;
  let latest = null;
  for (const record of state.history) {
    if (allowedShareIds && !allowedShareIds.has(record.shareId)) continue;
    count++;
    if (!latest) latest = record;
  }
  return {
    count,
    latestId: latest ? latest.id : null,
    latestAt: latest ? (latest.endedAt || latest.startedAt || 0) : 0,
    viewRevision: historyViewRevision,
  };
}

function canSeePhotoHistory(req, record) {
  if (!record) return false;
  return req.session.role !== 'operator' || (!!record.ownerId && record.ownerId === req.session.accountId);
}

function visiblePhotoHistory(req) {
  const items = Array.isArray(state.photoHistory) ? state.photoHistory : [];
  return items.filter((record) => canSeePhotoHistory(req, record)).slice(0, PHOTO_HISTORY_MAX);
}

function photoHistoryMeta(req) {
  const items = visiblePhotoHistory(req);
  const latest = items[0];
  return {
    count: items.length,
    latestId: latest ? latest.id : null,
    latestAt: latest ? latest.revokedAt : 0,
  };
}

// ===================================================================
//  STORE: shares + settings (persisted in shares.json)
// ===================================================================

const STORE_FILE = path.join(DATA_DIR, 'shares.json');
const STORE_TMP = STORE_FILE + '.tmp';
// Persistent, exportable transfer journal (append-only JSONL).
const LOG_FILE = path.join(DATA_DIR, 'transfers.log');

const DEFAULT_SETTINGS = {
  shutdownAfterDownload: !!SHUTDOWN_AFTER_DOWNLOAD,
  linkBase: '',
  imageBase: '', // optional separate domain for direct image links (Images page); '' = use linkBase
  imageHotlinkHosts: [], // anti-hotlink allowlist of referring hosts; [] = allow any site
  pwChanged: false, // set to true after the mandatory password change on first login
  idleLockMinutes: 0, // auto-lock the admin UI after N minutes of inactivity (0 = off)
  // Notifications (webhook). The WEBHOOK_URL env var, when set, overrides webhookUrl.
  webhookUrl: '',
  webhookFormat: '', // '' = auto-detect from the URL
  notifyDownloads: true,
  notifyUploads: true,
  notifyMessages: true,
  // Proactive "link expiring soon" alert (feature 5). Fires once per link, this
  // many hours before its expiry, over the effective webhook.
  notifyExpiring: false,
  expiryWarnHours: 24,
  notifySecurity: false, // alert on sensitive events (login, lockout, settings change, …)
  // Periodic activity digest (feature 9): a recap sent every N days over the
  // webhook (volume transferred, links nearing expiry, per-link activity).
  digestEnabled: false,
  digestDays: 7,
  // E-mail (SMTP) notifications. When enabled, the same events that go to the
  // webhook are also e-mailed. The SMTP_URL env var, when set, overrides these.
  emailEnabled: false,
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false, // true = implicit TLS (port 465); false = STARTTLS
  smtpUser: '',
  smtpPass: '',
  smtpFrom: '',
  smtpTo: '',
  // Defaults pre-filled into the "new share" picker.
  defaultExpiry: 0, // seconds (0 = never)
  defaultMaxDownloads: 0, // 0 = unlimited
  defaultRateKBps: 0, // 0 = unlimited
  defaultAllowZip: true,
  defaultRequirePassword: false, // pre-require a password on new links
  defaultStartDelayHours: 0, // pre-fill a deferred activation (now + N hours)
  defaultAllowPreview: true, // allow in-browser preview on new shares
  defaultBurnAfterDownload: false, // pre-enable one-time (burn-after-download) links
  defaultShowQr: false, // auto-open the QR code right after creating a share
  defaultShareDir: '', // starting folder for the "new share" picker ('' = last used / root)
  // Defaults pre-filled into the "reception link" picker.
  defaultMaxFiles: 0, // 0 = unlimited
  defaultMaxFileBytes: 0, // 0 = unlimited
  defaultMaxTotalBytes: 0, // 0 = unlimited
  defaultAllowExt: '', // comma list, '' = any
  defaultBlockExt: '', // comma list, '' = none
  defaultEncrypt: false, // pre-enable E2E encryption on reception links
  // Security.
  maxLoginAttempts: 5, // failed admin logins before a temporary lockout
  lockoutMinutes: 5, // lockout duration
  sessionHours: 0, // admin session lifetime (0 = SESSION_TTL env default)
  httpsWarning: true, // warn in the admin UI when served over plain HTTP off-LAN
  tokenBytes: 24, // random bytes for share/recipient link tokens (12–48)
  requireTwoFactor: false, // force every admin account to set up 2FA
  adminAllowedIps: '', // UI IP/CIDR allowlist for the admin (used when the env var is unset)
  // Global limits.
  globalRateKBps: 0, // hard server-wide download cap (0 = unlimited)
  maxUploadBytes: 0, // per received file cap (0 = use MAX_UPLOAD_BYTES env default)
  maxZipBytes: 0, // cap on a folder .zip download (0 = use MAX_ZIP_BYTES env default)
  // Maintenance.
  updateCheck: true, // check for a newer version at startup (UPDATE_CHECK env can force off)
  // History / privacy.
  historyRetentionDays: 0, // auto-purge history older than N days (0 = keep all)
  logRetentionDays: 0, // purge transfers.log entries older than N days (0 = keep all)
  inboxRetentionDays: 0, // delete received files older than N days (0 = never)
  anonymizeIps: false, // mask the last octet/hextet of IPs shown to the admin
  keepIpNames: true, // store per-IP visitor nicknames
  // Interface.
  brandName: '', // '' = the built-in app name
  accentColor: '', // '' = default accent (#3b82f6)
  adminLang: '', // default admin UI language ('' = browser)
  publicLang: '', // default public-page language ('' = visitor's browser/cookie)
  receptionBanner: '', // default note/banner pre-filled on new reception links
  // Privacy: geolocate visitor IPs (external lookups). Off = no external calls.
  geoLookup: false,
  // Feature 5 — bandwidth cap by time-of-day window. When enabled, downloads are
  // additionally throttled to scheduleRateKBps (tighter of this / per-link /
  // global cap) while the local time is inside [scheduleStart, scheduleEnd).
  // The window may wrap past midnight (e.g. 08:00 → 02:00 = daytime + evening).
  scheduleRateEnabled: false,
  scheduleRateKBps: 0, // cap inside the window (0 = unlimited inside the window)
  scheduleStart: '08:00', // HH:MM (24h, server-local time)
  scheduleEnd: '18:00', // HH:MM; outside the window only the global/per-link caps apply
  // Feature 7 — anti-abuse on public download endpoints.
  publicRateLimit: true, // per-IP request rate limit on public download routes
  publicRateMax: 600, // high enough for chunked uploads while limiting floods
  publicRateWindowMin: 1, // sliding window length (minutes)
  challengeEnabled: false, // require a solved proof-of-work before large downloads
  challengeMinMB: 200, // files at least this large trigger the challenge (MB)
  challengeBits: 16, // proof-of-work difficulty (leading zero bits, 8–24)
  // Feature 4 — "link likely leaked" alert: fires a one-shot notification when a
  // single link is downloaded from at least N distinct countries within a window.
  leakAlertEnabled: false,
  leakAlertCountries: 3, // distinct countries within the window that trigger the alert
  leakAlertWindowHours: 24, // rolling window + re-alert cooldown
  // Feature 8 — custom branding / watermark on public pages.
  publicLogo: '', // data: URL of a custom logo (replaces the built-in mark); '' = default
  legalNotice: '', // confidentiality/legal banner shown on every public page
  watermarkPreviews: false, // overlay the visitor IP / recipient name on image & video previews
  publicTheme: 'dark', // default public-page theme: 'dark', or 'auto' (follow the device) / 'light'
  themeColor: '', // mobile browser UI color (<meta name=theme-color>); '' = derive from accent/bg
  // Feature 9 — quick expiry presets offered in the link modals (comma list of
  // durations like "1h,6h,1d,7d,30d"). "Never" is always offered first.
  expiryPresets: '1h,1d,7d,30d',
  // Scheduled full backup + one-click restore. A backup bundles the whole store
  // (shares + settings), the transfer journal and the secret notes into one file,
  // encrypted with DATA_KEY when set. Pushed to a local folder, WebDAV or S3.
  backupEnabled: false,
  backupInterval: 'daily', // 'daily' | 'weekly'
  backupHour: 3, // local hour (0–23) the scheduled backup runs
  backupWeekday: 0, // 0=Sun … 6=Sat, for the weekly interval
  backupRetention: 7, // keep the last N backups (0 = keep all) — enforced for local & S3
  backupDestType: 'local', // 'local' | 'webdav' | 's3'
  backupLocalDir: '', // a writable (mounted) folder, e.g. /backups
  backupWebdavUrl: '', // collection URL, e.g. https://dav.example.com/direct-xfer/
  backupWebdavUser: '',
  backupWebdavPass: '', // sensitive: never returned to the client
  backupS3Endpoint: '', // e.g. https://s3.us-east-1.amazonaws.com (or a MinIO host)
  backupS3Region: 'us-east-1',
  backupS3Bucket: '',
  backupS3Prefix: '', // key prefix, e.g. backups/
  backupS3Key: '', // access key id
  backupS3Secret: '', // secret access key — sensitive: never returned to the client
};

// state.stats: per-share aggregate totals (kept even after a share is revoked),
// keyed by share id -> { name, type, count, bytes, up, down, completed,
// interrupted, lastAt }. Cheap to keep and always available for per-link stats,
// while the full journal lives in transfers.log.
let state = { version: 1, shares: [], settings: { ...DEFAULT_SETTINGS }, history: [], photoHistory: [], stats: {}, meta: {}, audit: [], ipNames: {} };

function photoHistoryCount(value) {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(value) || 0)));
}

function normalizePhotoHistory(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((r) => r && /^[a-f0-9]{16}$/.test(String(r.id || '')))
    .slice(0, PHOTO_HISTORY_MAX)
    .map((r) => ({
      id: String(r.id),
      name: String(r.name || 'Image').replace(/[\r\n\t]+/g, ' ').slice(0, 200),
      ext: /^(jpg|png|gif|webp|bmp|avif)$/.test(String(r.ext || '').toLowerCase()) ? String(r.ext).toLowerCase() : 'jpg',
      size: Math.max(0, Number(r.size) || 0),
      createdAt: Math.max(0, Number(r.createdAt) || 0),
      revokedAt: Math.max(0, Number(r.revokedAt) || 0),
      ownerId: r.ownerId ? String(r.ownerId).slice(0, 128) : null,
      ownerName: r.ownerName ? String(r.ownerName).replace(/[\r\n\t]+/g, ' ').slice(0, 80) : null,
      metadataRemoved: !!r.metadataRemoved,
      fullViews: photoHistoryCount(r.fullViews),
      fullVisitors: photoHistoryCount(r.fullVisitors),
      thumbViews: photoHistoryCount(r.thumbViews),
      thumbVisitors: photoHistoryCount(r.thumbVisitors),
      microViews: photoHistoryCount(r.microViews),
      microVisitors: photoHistoryCount(r.microVisitors),
      preview: !!r.preview,
      previewSize: Math.max(0, Number(r.previewSize) || 0),
    }));
}
const byToken = new Map();
const byId = new Map();
const recipientByToken = new Map(); // recipient sub-token -> { share, recipient }

function reindex() {
  byToken.clear();
  byId.clear();
  recipientByToken.clear();
  for (const s of state.shares) {
    byToken.set(s.token, s);
    byId.set(s.id, s);
    indexRecipients(s);
  }
}

// Registers a share's nominative sub-links (recipients): each token resolves to
// the parent share for routing, and back to the recipient for attribution.
function indexRecipients(s) {
  if (!Array.isArray(s.recipients)) return;
  for (const r of s.recipients) {
    if (!r || !r.token) continue;
    byToken.set(r.token, s);
    recipientByToken.set(r.token, { share: s, recipient: r });
  }
}

let writeChain = Promise.resolve();
let dirty = false;
let flushTimer = null;

// --- Optional at-rest encryption of shares.json (DATA_KEY) --------------------
// The key is derived from DATA_KEY via scrypt; the random salt is stored in the
// envelope and the derived key is cached so scrypt runs once (not on every write).
// A random 12-byte IV per write keeps AES-GCM safe with the reused key.
let encKeyCache = null; // { salt: Buffer, key: Buffer }
function deriveDataKey(salt) {
  if (encKeyCache && encKeyCache.salt.equals(salt)) return encKeyCache.key;
  const key = crypto.scryptSync(DATA_KEY, salt, 32);
  encKeyCache = { salt, key };
  return key;
}
function encryptStore(json) {
  const salt = (encKeyCache && encKeyCache.salt) || crypto.randomBytes(16);
  const key = deriveDataKey(salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return JSON.stringify({
    dxenc: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: enc.toString('base64'),
  });
}
function decryptStore(env) {
  const key = deriveDataKey(Buffer.from(env.salt, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
}
// Serializes `state` for disk: an encrypted envelope when DATA_KEY is set,
// otherwise pretty-printed JSON (unchanged legacy format).
function serializeState() {
  const json = JSON.stringify(state, null, 2);
  return DATA_KEY ? encryptStore(json) : json;
}
// Parses a store file (encrypted envelope or plaintext JSON). Throws a coded
// error if the file is encrypted but DATA_KEY is missing/wrong, so the caller can
// abort rather than silently overwrite encrypted data with an empty store.
function deserializeStore(raw) {
  const obj = JSON.parse(raw);
  if (obj && obj.dxenc) {
    if (!DATA_KEY) { const e = new Error('data-key-required'); e.code = 'DATA_KEY_REQUIRED'; throw e; }
    try { return JSON.parse(decryptStore(obj)); }
    catch (_) { const e = new Error('data-key-invalid'); e.code = 'DATA_KEY_INVALID'; throw e; }
  }
  return obj; // plaintext (or a plaintext file to be migrated on next write)
}

function storeLoad() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = deserializeStore(raw);
    if (parsed && Array.isArray(parsed.shares)) {
      state = {
        version: 1,
        shares: parsed.shares,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        history: Array.isArray(parsed.history) ? parsed.history.slice(0, HISTORY_MAX) : [],
        photoHistory: normalizePhotoHistory(parsed.photoHistory),
        stats: parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {},
        meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
        audit: Array.isArray(parsed.audit) ? parsed.audit.slice(0, AUDIT_MAX) : [],
        ipNames: parsed.ipNames && typeof parsed.ipNames === 'object' ? parsed.ipNames : {},
      };
    }
  } catch (e) {
    // Encrypted store that can't be opened: abort instead of starting empty and
    // overwriting it on the first write (which would destroy all shares/settings).
    if (e.code === 'DATA_KEY_REQUIRED') {
      console.error('[store] shares.json is encrypted but DATA_KEY is not set. Refusing to start (would overwrite your data). Set the DATA_KEY environment variable to the key used to encrypt it.');
      process.exit(1);
    }
    if (e.code === 'DATA_KEY_INVALID') {
      console.error('[store] shares.json could not be decrypted — DATA_KEY is wrong or the file is corrupt. Refusing to start.');
      process.exit(1);
    }
    if (e.code !== 'ENOENT') console.error('[store] could not read shares.json:', e.message);
  }
  reindex();
}

function persist() {
  writeChain = writeChain
    .then(
      () =>
        new Promise((resolve) => {
          // Snapshot captured at write time so a queued write never persists a
          // stale state over a fresher one (e.g. a just-changed admin hash).
          const snapshot = serializeState();
          fs.writeFile(STORE_TMP, snapshot, { mode: 0o600 }, (err) => {
            if (err) {
              console.error('[store] temp write failed:', err.message);
              return resolve();
            }
            fs.rename(STORE_TMP, STORE_FILE, (err2) => {
              if (err2) console.error('[store] rename failed:', err2.message);
              resolve();
            });
          });
        })
    )
    .catch((e) => console.error('[store] persistence error:', e));
  return writeChain;
}

// Synchronous, durable write — used for critical data (the admin password hash)
// so it is guaranteed on disk immediately, never lost to async/debounce timing.
function persistNow() {
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    fs.writeFileSync(STORE_TMP, serializeState(), { mode: 0o600 });
    fs.renameSync(STORE_TMP, STORE_FILE);
    return true;
  } catch (e) {
    console.error('[store] durable write failed:', e.message);
    return false;
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty) {
      dirty = false;
      persist();
    }
  }, 3000);
  if (flushTimer.unref) flushTimer.unref();
}

async function flushNow() {
  if (dirty) {
    dirty = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    persist();
  }
  await writeChain;
}

function isActive(s, now = Date.now()) {
  if (!s || s.revoked) return false;
  if (s.disabled) return false; // manually paused by the admin (reversible, unlike revoke)
  if (s.startsAt && now < s.startsAt) return false; // deferred activation (not yet live)
  if (s.expiresAt && now > s.expiresAt) return false;
  if (s.maxDownloads != null && s.downloads >= s.maxDownloads) return false;
  // PWA image links may be configured with a total view cap. The limit covers
  // Full, Mini and Micro together, so embedding a smaller variant cannot bypass it.
  if (s.type === 'photo' && Number(s.maxViews) > 0) {
    const ps = photoStatsOf(s);
    const totalViews = (Number(ps.full.v) || 0) + (Number(ps.thumb.v) || 0) + (Number(ps.micro.v) || 0);
    if (totalViews >= Number(s.maxViews)) return false;
  }
  return true;
}
// A share that only becomes active later (scheduled), not yet live.
function isScheduled(s, now = Date.now()) {
  return !!(s && !s.revoked && !s.disabled && s.startsAt && now < s.startsAt);
}

// Public URL prefix for a share, by type: download (/s/), reception (/u/) or
// collaboration (/c/). Collab links are bidirectional (browse + upload).
function linkPrefix(s) {
  if (!s) return '/s/';
  if (s.type === 'inbox') return '/u/';
  if (s.type === 'collab') return '/c/';
  if (s.type === 'photo') return '/i/'; // direct image link (Photos tab)
  if (s.type === 'album') return '/g/'; // public image gallery (feature 18)
  return '/s/';
}

function listShares() {
  return state.shares.slice();
}
function getByToken(token) {
  if (!token) return undefined;
  return byToken.get(token);
}
function getById(id) {
  if (!id) return undefined;
  return byId.get(id);
}

// Random link token; length (in bytes) is configurable (12–48, default 24) so
// admins can make the public /s/ and /u/ URLs harder to guess.
function newToken() {
  const n = Math.floor(Number(getSettings().tokenBytes));
  const bytes = Number.isFinite(n) ? Math.min(48, Math.max(12, n)) : 24;
  return crypto.randomBytes(bytes).toString('base64url');
}

function addShare(share) {
  const rec = Object.assign(
    {
      id: crypto.randomBytes(8).toString('hex'),
      token: newToken(),
      createdAt: Date.now(),
      downloads: 0,
      revoked: false,
      expiresAt: null,
      maxDownloads: null,
    },
    share
  );
  state.shares.push(rec);
  byToken.set(rec.token, rec);
  byId.set(rec.id, rec);
  persist();
  return rec;
}

function uniquePhotoPaths(paths) {
  return [...new Set((paths || []).filter(Boolean).map((p) => path.resolve(p)))];
}

function safeManagedImageName(name) {
  const value = String(name || '');
  return /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : null;
}

function safePhotoToken(token) {
  const value = String(token || '');
  return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

function photoOriginalPaths(photo) {
  const name = photo && safeManagedImageName(photo.imgPath);
  return name ? uniquePhotoPaths([path.join(FULL_IMAGES_DIR, name), path.join(LEGACY_IMAGES_DIR, name)]) : [];
}

function photoAdaptivePath(token, format) {
  const safeToken = safePhotoToken(token);
  const ext = String(format || '').toLowerCase();
  if (!safeToken || !/^(webp|avif)$/.test(ext)) return null;
  return path.join(ADAPTIVE_IMAGES_DIR, safeToken + '.' + ext);
}

function photoVersionDir(token) {
  const safeToken = safePhotoToken(token);
  return safeToken ? path.join(PHOTO_VERSIONS_DIR, safeToken) : null;
}

function photoVariantPaths(token, variant) {
  const safeToken = safePhotoToken(token);
  if (!safeToken) return [];
  const current = variant === 'micro' ? MICROS_DIR : THUMBS_DIR;
  const legacy = variant === 'micro' ? LEGACY_MICROS_DIR : LEGACY_THUMBS_DIR;
  return uniquePhotoPaths([path.join(current, safeToken + '.jpg'), path.join(legacy, safeToken + '.jpg')]);
}

function firstExistingPhotoFile(paths) {
  for (const candidate of paths || []) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
  }
  return null;
}

function unlinkPhotoFiles(paths) {
  for (const candidate of uniquePhotoPaths(paths)) fs.unlink(candidate, () => {});
}

async function copyPhotoFile(source, destination) {
  const tmp = destination + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    await fs.promises.copyFile(source, tmp);
    await fs.promises.rename(tmp, destination);
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch (_) {}
    throw e;
  }
}

async function copyFirstExistingPhotoFile(sources, destination) {
  try { if ((await fs.promises.stat(destination)).isFile()) return false; } catch (_) {}
  for (const source of uniquePhotoPaths(sources)) {
    if (source === path.resolve(destination)) continue;
    try {
      if (!(await fs.promises.stat(source)).isFile()) continue;
      await copyPhotoFile(source, destination);
      return true;
    } catch (_) {}
  }
  return false;
}

function newStoredImageName(name) {
  return crypto.randomBytes(12).toString('hex') + '.' + photoExt({ name });
}

async function copyHostPhotoToStore(item) {
  const source = hostToContainer(item.hostPath);
  await assertRealWithin(HOST_ROOT, source);
  const storedName = newStoredImageName(item.name);
  await copyPhotoFile(source, path.join(FULL_IMAGES_DIR, storedName));
  return storedName;
}

function photoHistoryPreviewPath(id) {
  return /^[a-f0-9]{16}$/.test(String(id || '')) ? path.join(PHOTO_HISTORY_DIR, id + '.jpg') : null;
}

function photoHistoryPreviewPaths(id) {
  if (!/^[a-f0-9]{16}$/.test(String(id || ''))) return [];
  return uniquePhotoPaths([photoHistoryPreviewPath(id), path.join(LEGACY_PHOTO_HISTORY_DIR, id + '.jpg')]);
}

function deletePhotoHistoryPreview(record) {
  for (const previewPath of photoHistoryPreviewPaths(record && record.id)) {
    try { fs.unlinkSync(previewPath); } catch (e) { if (e.code !== 'ENOENT') console.error('[photo-history] preview delete failed:', e.message); }
  }
}

function archiveRevokedPhoto(photo) {
  if (!photo || photo.type !== 'photo') return;
  if (!Array.isArray(state.photoHistory)) state.photoHistory = [];
  const stats = photoStatsOf(photo);
  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(photo.name || 'Image').replace(/[\r\n\t]+/g, ' ').slice(0, 200),
    ext: photoExt(photo),
    size: Math.max(0, Number(photo.size) || 0),
    createdAt: Math.max(0, Number(photo.createdAt) || 0),
    revokedAt: Date.now(),
    ownerId: photo.ownerId || null,
    ownerName: photo.ownerName || null,
    metadataRemoved: !!photo.metadataRemoved,
    fullViews: photoHistoryCount(stats.full.v),
    fullVisitors: photoHistoryCount(Array.isArray(stats.full.u) ? stats.full.u.length : 0),
    thumbViews: photoHistoryCount(stats.thumb.v),
    thumbVisitors: photoHistoryCount(Array.isArray(stats.thumb.u) ? stats.thumb.u.length : 0),
    microViews: photoHistoryCount(stats.micro.v),
    microVisitors: photoHistoryCount(Array.isArray(stats.micro.u) ? stats.micro.u.length : 0),
    preview: false,
    previewSize: 0, // bytes the retained history copy takes on disk
  };
  const destination = photoHistoryPreviewPath(record.id);
  for (const source of [...photoVariantPaths(photo.token, 'micro'), ...photoVariantPaths(photo.token, 'thumb')]) {
    try {
      if (!fs.statSync(source).isFile()) continue;
      fs.copyFileSync(source, destination);
      record.preview = true;
      try { record.previewSize = fs.statSync(destination).size; } catch (_) {}
      break;
    } catch (_) {}
  }
  state.photoHistory.unshift(record);
  while (state.photoHistory.length > PHOTO_HISTORY_MAX) deletePhotoHistoryPreview(state.photoHistory.pop());
}

function removeShare(id, persistAfter = true) {
  const i = state.shares.findIndex((s) => s.id === id);
  if (i === -1) return false;
  const [removed] = state.shares.splice(i, 1);
  if (removed) {
    byToken.delete(removed.token);
    byId.delete(removed.id);
    if (Array.isArray(removed.recipients)) {
      for (const r of removed.recipients) { byToken.delete(r.token); recipientByToken.delete(r.token); }
    }
    if (removed.encPath) fs.unlink(removed.encPath, () => {}); // drop the ciphertext blob
    if (removed.type === 'photo') {
      archiveRevokedPhoto(removed);
      unlinkPhotoFiles(photoVariantPaths(removed.token, 'thumb')); // drop Mini
      unlinkPhotoFiles(photoVariantPaths(removed.token, 'micro')); // drop Micro
      unlinkPhotoFiles(photoOriginalPaths(removed)); // drop the managed Full copy; never touches the source file
      unlinkPhotoFiles([photoAdaptivePath(removed.token, 'webp'), photoAdaptivePath(removed.token, 'avif')]);
      const versionsDir = photoVersionDir(removed.token);
      if (versionsDir) fs.rm(versionsDir, { recursive: true, force: true }, () => {});
    }
  }
  if (persistAfter) persist();
  return true;
}

// Upgrade existing installations without breaking live links. Copies legacy
// originals/variants/history into the configured Images tree in the background;
// old files remain in place so the migration is non-destructive.
async function migrateLegacyPhotoStorage() {
  let copied = 0, stateChanged = false;
  for (const photo of state.shares || []) {
    if (!photo || photo.type !== 'photo') continue;
    try {
      const managedName = safeManagedImageName(photo.imgPath);
      if (managedName) {
        if (await copyFirstExistingPhotoFile(photoOriginalPaths(photo), path.join(FULL_IMAGES_DIR, managedName))) copied += 1;
      } else if (photo.hostPath) {
        const source = hostToContainer(photo.hostPath);
        await assertRealWithin(HOST_ROOT, source);
        const storedName = newStoredImageName(photo.name);
        await copyPhotoFile(source, path.join(FULL_IMAGES_DIR, storedName));
        photo.imgPath = storedName;
        copied += 1;
        stateChanged = true;
      }
      const token = safePhotoToken(photo.token);
      if (token && photo.thumb && await copyFirstExistingPhotoFile(photoVariantPaths(token, 'thumb'), path.join(THUMBS_DIR, token + '.jpg'))) copied += 1;
      if (token && photo.micro && await copyFirstExistingPhotoFile(photoVariantPaths(token, 'micro'), path.join(MICROS_DIR, token + '.jpg'))) copied += 1;
    } catch (e) {
      console.error('[images] could not migrate ' + String(photo.name || photo.id || 'photo') + ':', e.message);
    }
  }
  for (const record of state.photoHistory || []) {
    if (!record || !record.preview) continue;
    const destination = photoHistoryPreviewPath(record.id);
    if (destination && await copyFirstExistingPhotoFile(photoHistoryPreviewPaths(record.id), destination)) copied += 1;
  }
  if (stateChanged) await persist();
  if (copied) console.log(`[images] migrated ${copied} file(s) into ${IMAGE_STORE_DIR}`);
}

// Effective limits: a UI setting (when > 0) overrides the env default at runtime.
function effMaxUpload() { const s = Math.floor(Number(getSettings().maxUploadBytes)) || 0; return s > 0 ? s : MAX_UPLOAD_BYTES; }
function effMaxZip() { const s = Math.floor(Number(getSettings().maxZipBytes)) || 0; return s > 0 ? s : MAX_ZIP_BYTES; }
// Update check: on unless the env var forces it off or the admin disabled it.
function updateCheckEnabled() { return UPDATE_CHECK && getSettings().updateCheck !== false; }

function incrementDownloads(id) {
  const s = getById(id);
  if (!s) return;
  s.downloads = (s.downloads || 0) + 1;
  scheduleFlush();
}

// Per-type view + unique-visitor tracking for direct image links (Images page):
// `kind` is 'full' (the image) or 'thumb' (the thumbnail). Debounced, and the
// unique-IP list is bounded so a hotlinked image can't grow the store unbounded.
function photoStatsOf(s) {
  if (!s.pstats || typeof s.pstats !== 'object') s.pstats = {};
  if (!s.pstats.full) s.pstats.full = { v: 0, u: [] };
  if (!s.pstats.thumb) s.pstats.thumb = { v: 0, u: [] };
  if (!s.pstats.micro) s.pstats.micro = { v: 0, u: [] };
  if (!Array.isArray(s.pstats.recent)) s.pstats.recent = [];
  return s.pstats;
}
const PHOTO_UNIQUE_VISITOR_MAX = 10000;
function photoVisitorSet(st) {
  if (!Array.isArray(st.u)) st.u = [];
  if (st.u.length > PHOTO_UNIQUE_VISITOR_MAX) st.u = st.u.slice(-PHOTO_UNIQUE_VISITOR_MAX);
  if (!st._visitorSet) {
    Object.defineProperty(st, '_visitorSet', {
      value: new Set(Array.isArray(st.u) ? st.u : []),
      enumerable: false,
      configurable: true,
    });
  }
  return st._visitorSet;
}
function notePhotoView(s, req, kind) {
  if (!s || s.type !== 'photo') return;
  // Don't count the owner/admin's own loads — the browser sends the admin session
  // cookie on same-origin image requests (Mini/Micro generation loads the Full once,
  // the lightbox and the gallery previews load copies too). These counters are for
  // public visitors, not for managing the images; otherwise every new image starts
  // with a phantom "1 view" on the Full copy right after its variants are generated.
  if (getSession(req)) return;
  const allStats = photoStatsOf(s);
  const st = allStats[kind];
  if (!st) return;
  const now = Date.now();
  st.v = (st.v || 0) + 1;
  st.lastAt = now;
  if (kind === 'full') s.downloads = (s.downloads || 0) + 1; // keep the generic counter in sync
  const rawIp = clientIp(req);
  const ip = maskIp(rawIp);
  const visitors = photoVisitorSet(st);
  if (ip && Array.isArray(st.u) && !visitors.has(ip)) {
    st.u.push(ip);
    visitors.add(ip);
    if (st.u.length > PHOTO_UNIQUE_VISITOR_MAX) visitors.delete(st.u.shift());
  }
  const geo = geoSync(rawIp) || {};
  allStats.recent.unshift({
    at: now,
    kind,
    ip: ip || null,
    country: geo.country || null,
    countryCode: geo.countryCode || null,
    flag: geo.flag || null,
  });
  if (allStats.recent.length > 100) allStats.recent.length = 100;
  if (s.notifyFirstView && !s.firstViewNotifiedAt) {
    s.firstViewNotifiedAt = now;
    s.firstViewKind = kind;
    s.firstViewIp = ip || null;
    try { notifyFirstPhotoView(s, req, kind, ip, geo); } catch (_) {}
  }
  scheduleFlush();
}

// Files backing a share. A file share may hold several files (a "collection");
// older single-file shares (no `items`) are normalized to a one-file list.
function shareItems(s) {
  if (!s) return null;
  if (Array.isArray(s.items) && s.items.length) {
    return s.items.map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type || 'file' }));
  }
  if (s.type === 'file') return [{ hostPath: s.hostPath, name: s.name, size: s.size, type: 'file' }];
  return null;
}
// Clamps a query index to a valid item position (defaults to 0).
function clampIndex(v, len) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n < len ? n : 0;
}

// Is the data folder writable? (otherwise persistence fails —
// e.g. /data volume mounted as root with a non-root container).
function dataWritable() {
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function getSettings() {
  return { ...state.settings };
}
function setSettings(patch) {
  state.settings = { ...state.settings, ...(patch || {}) };
  mailerCache = null; // rebuild the SMTP transport if any mail setting changed
  persist();
  return getSettings();
}
// Settings for the admin UI, with derived "managed by env" flags so the UI can
// disable the fields the environment already controls. `pwChanged` is internal.
// `lite` (used by the periodic poll) drops the possibly-large custom logo data URL — up
// to ~256 KB — which the admin UI only needs when the Configuration modal is open
// (it re-fetches the full settings then). A `publicLogoSet` flag is always sent.
function settingsForClient(req, lite) {
  const s = getSettings();
  const role = req && req.session && req.session.role;
  const fullAdmin = role === 'owner' || role === 'admin';
  delete s.pwChanged;
  const hasPass = !!s.smtpPass;
  delete s.smtpPass; // never expose the SMTP password to the client
  const hasDavPass = !!s.backupWebdavPass;
  const hasS3Secret = !!s.backupS3Secret;
  delete s.backupWebdavPass; // sensitive backup credentials never leave the server
  delete s.backupS3Secret;
  const webhookUrlSet = !!(WEBHOOK_URL || s.webhookUrl);
  // Webhook URLs commonly contain an embedded secret. Operators and auditors
  // only need to know whether one is configured, never its value.
  if (!fullAdmin) delete s.webhookUrl;
  const publicLogoSet = !!s.publicLogo;
  if (lite) delete s.publicLogo; // keep the frequent poll small
  return {
    ...s,
    publicLogoSet,
    webhookUrlSet,
    webhookFromEnv: !!WEBHOOK_URL,
    dataEncrypted: !!DATA_KEY,
    emailFromEnv: !!SMTP_URL,
    emailAvailable: !!nodemailer,
    emailSendable: emailSendable(), // can e-mail an arbitrary recipient (the "e-mail this link" action)
    webPushAvailable: !!webpush, // the web-push module is installed on the server
    webPushSubs: pushSubs().length, // how many browsers are currently subscribed
    smtpPassSet: hasPass,
    backupWebdavPassSet: hasDavPass,
    backupS3SecretSet: hasS3Secret,
    lastBackup: (state.meta && state.meta.lastBackup) || null,
    allowlistFromEnv: ADMIN_ALLOWED_IPS.length > 0,
    updateCheckEnv: !UPDATE_CHECK, // env forces the update check off
    role: (req && req.session && req.session.role) || null, // current account's role (UI gating)
    appName: APP_NAME,
  };
}

storeLoad();
initAccounts();
trimLogIfNeeded();
pruneHistory();
setImmediate(() => migrateLegacyPhotoStorage().catch((e) => console.error('[images] migration failed:', e.message)));

// ===================================================================
//  LIFECYCLE: auto-shutdown after download
// ===================================================================

const bus = new EventEmitter();

function onDownloadComplete(info) {
  const settings = getSettings();
  if (!settings.shutdownAfterDownload) return;
  setSettings({ shutdownAfterDownload: false }); // one-shot: avoids a loop on restart
  console.log(
    `[lifecycle] complete download finished (${(info && info.name) || '?'}) — ` +
      'shutdown requested (auto-shutdown enabled in the interface).'
  );
  bus.emit('shutdown', info || {});
}

// ===================================================================
//  AUTH: sessions, CSRF, brute-force protection
// ===================================================================

const sessions = new Map(); // sid -> { csrf, expires }
const loginAttempts = new Map(); // ip -> { fails: number[], lockUntil }
const unlockFails = new Map(); // ip -> { fails:[timestamps], lockUntil } (public link passwords)
const UNLOCK_MAX_FAILS = 8;
// After maxLoginAttempts() failed admin logins within FAIL_WINDOW_MS, the IP is
// locked out for lockMs(). The window is sliding: only failures from the last
// FAIL_WINDOW_MS count. Both thresholds are configurable (see settings).
const FAIL_WINDOW_MS = 5 * 60 * 1000;
function maxLoginFails() {
  const n = Math.floor(Number(getSettings().maxLoginAttempts));
  return Number.isFinite(n) && n >= 1 ? Math.min(100, n) : 5;
}
function lockMs() {
  const n = Math.floor(Number(getSettings().lockoutMinutes));
  return (Number.isFinite(n) && n >= 1 ? Math.min(1440, n) : 5) * 60 * 1000;
}
// Admin session lifetime: the sessionHours setting overrides the SESSION_TTL env
// default (0 = keep the env default).
function sessionTtlMs() {
  const h = Math.floor(Number(getSettings().sessionHours));
  return Number.isFinite(h) && h > 0 ? Math.min(720, h) * 3600 * 1000 : SESSION_TTL_MS;
}
// Marks cookies "Secure" ONLY when the browser connection is actually HTTPS.
// req.protocol honors X-Forwarded-Proto behind the trusted proxy. This avoids a
// blanket Secure flag that a browser silently drops over plain HTTP (which broke
// auth — the session cookie was never stored/sent — behind an HTTP-facing setup).
function secureCookie(req) {
  return req && req.protocol === 'https' ? '; Secure' : '';
}

function clientIp(req) {
  // Express resolves req.ip according to the configured trust-proxy policy.
  // Reading the left-most X-Forwarded-For value directly lets a client spoof
  // its address when a numeric proxy-hop policy is used.
  if (TRUST_PROXY && req && req.ip) return req.ip;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) {
        // A malformed percent escape is an invalid cookie, not a server error.
        try { out[k] = decodeURIComponent(v); } catch (_) {}
      }
    }
  }
  return out;
}

// --- Optional per-link access password protection ---
function makeSharePassword(pw) {
  // scrypt hash (salt embedded in the string); no separate pwSalt needed.
  return { pwHash: hashPassword(pw) };
}
function checkSharePassword(s, pw) {
  if (!s || !s.pwHash) return true;
  if (!pw) return false;
  const rec = parseHash(s.pwHash);
  if (rec) return verifyPassword(pw, rec); // scrypt (current format)
  // Legacy salted SHA-256 (shares created before the upgrade).
  const h = crypto.createHash('sha256').update((s.pwSalt || '') + ':' + pw).digest('hex');
  return timingSafeEqualStr(h, s.pwHash);
}
// Per-link unlock cookie, signed with a volatile secret (reset on restart).
const UNLOCK_SECRET = crypto.randomBytes(32);
function unlockValue(s) {
  return crypto.createHmac('sha256', UNLOCK_SECRET).update(s.token + ':' + s.pwHash).digest('hex');
}
function isUnlocked(req, s) {
  if (!s.pwHash) return true;
  const c = parseCookies(req)['dxu_' + s.token];
  return !!c && timingSafeEqualStr(c, unlockValue(s));
}
function setUnlockCookie(req, res, s) {
  // Path covers the whole /s/ (or /u/) space so nominative sub-link tokens share
  // the unlock; the cookie name is per-link (dxu_<token>) and HMAC-bound, so it
  // still only unlocks this specific link.
  const rel = linkPrefix(s);
  res.setHeader(
    'Set-Cookie',
    `dxu_${s.token}=${unlockValue(s)}; HttpOnly; SameSite=Lax; Path=${rel}; Max-Age=86400${secureCookie(req)}`
  );
}

// --- Feature 7: anti-abuse on public download endpoints ---

// Per-IP sliding-window rate limiter for public download requests. Each entry is
// the list of recent request timestamps (ms) for that IP; pruned lazily on read
// and by a periodic sweep so the map stays bounded.
const publicHits = new Map();
const publicMessageHits = new Map();
const PUBLIC_MESSAGE_WINDOW_MS = 60000;
const PUBLIC_MESSAGE_MAX = 5;
const PUBLIC_MESSAGE_DUP_MS = 30000;
const PUBLIC_MESSAGE_NOTIFY_COOLDOWN_MS = 15000;

function publicMessageDecision(req, token, text, file) {
  const ip = clientIp(req);
  const key = `${token}|${ip}`;
  const now = Date.now();
  if (!publicMessageHits.has(key) && publicMessageHits.size >= 10000) {
    const oldest = publicMessageHits.keys().next();
    if (!oldest.done) publicMessageHits.delete(oldest.value);
  }
  const rec = publicMessageHits.get(key) || { hits: [], lastHash: '', lastAt: 0, lastNotifyAt: 0 };
  rec.hits = rec.hits.filter((t) => now - t < PUBLIC_MESSAGE_WINDOW_MS);
  const hash = crypto.createHash('sha256').update(`${text}\n${file || ''}`).digest('hex');
  if (rec.lastHash === hash && now - rec.lastAt < PUBLIC_MESSAGE_DUP_MS) {
    publicMessageHits.set(key, rec);
    return { duplicate: true, notify: false, retryAfter: 0 };
  }
  if (rec.hits.length >= PUBLIC_MESSAGE_MAX) {
    publicMessageHits.set(key, rec);
    return {
      duplicate: false,
      notify: false,
      retryAfter: Math.max(1, Math.ceil((PUBLIC_MESSAGE_WINDOW_MS - (now - rec.hits[0])) / 1000)),
    };
  }
  rec.hits.push(now);
  rec.lastHash = hash;
  rec.lastAt = now;
  const notify = now - rec.lastNotifyAt >= PUBLIC_MESSAGE_NOTIFY_COOLDOWN_MS;
  if (notify) rec.lastNotifyAt = now;
  publicMessageHits.set(key, rec);
  return { duplicate: false, notify, retryAfter: 0 };
}

function publicRateRetryAfter(req) {
  const s = getSettings();
  if (!s.publicRateLimit) return 0;
  const windowMs = Math.max(1, Math.floor(Number(s.publicRateWindowMin) || 1)) * 60000;
  const max = Math.max(1, Math.floor(Number(s.publicRateMax) || 600));
  const ip = clientIp(req);
  const now = Date.now();
  const arr = (publicHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    publicHits.set(ip, arr);
    return Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
  }
  arr.push(now);
  publicHits.set(ip, arr);
  return 0;
}
setInterval(() => {
  const windowMs = Math.max(1, Math.floor(Number(getSettings().publicRateWindowMin) || 1)) * 60000;
  const now = Date.now();
  for (const [ip, arr] of publicHits) {
    const keep = arr.filter((t) => now - t < windowMs);
    if (keep.length) publicHits.set(ip, keep); else publicHits.delete(ip);
  }
  for (const [key, rec] of publicMessageHits) {
    rec.hits = (rec.hits || []).filter((t) => now - t < PUBLIC_MESSAGE_WINDOW_MS);
    if (rec.hits.length || now - (rec.lastAt || 0) < PUBLIC_MESSAGE_DUP_MS) publicMessageHits.set(key, rec);
    else publicMessageHits.delete(key);
  }
  pruneLeakTrackers();
}, 60000).unref();

// Proof-of-work challenge gating large downloads. The signing secret is volatile
// (reset on restart ⇒ any outstanding pass simply has to be re-solved). No third
// party is involved: the browser hashes locally and posts the solution back.
const POW_SECRET = crypto.randomBytes(32);
function powIpKey(req) {
  // Bind a solved pass to a coarse (masked) IP so it can't trivially be replayed
  // from another client, while tolerating last-octet churn from some carriers.
  return maskIp(clientIp(req));
}
function powSign(parts) {
  return crypto.createHmac('sha256', POW_SECRET).update(parts.join('.')).digest('hex');
}
function powBits() {
  return Math.min(24, Math.max(8, Math.floor(Number(getSettings().challengeBits) || 16)));
}
function challengeRequired(sizeBytes) {
  const s = getSettings();
  if (!s.challengeEnabled) return false;
  const min = Math.max(1, Math.floor(Number(s.challengeMinMB) || 200)) * 1024 * 1024;
  return Number(sizeBytes) >= min;
}
// A SHA-256 whose leading `bits` bits are zero counts as a valid solution.
function powSolutionOk(nonce, sol, bits) {
  const dig = crypto.createHash('sha256').update(String(nonce) + String(sol)).digest();
  let count = 0;
  for (const byte of dig) {
    if (byte === 0) { count += 8; continue; }
    count += Math.clz32(byte) - 24; // leading zeros within this byte
    break;
  }
  return count >= bits;
}
function hasValidPow(req) {
  const c = parseCookies(req)['dxpow'];
  if (!c) return false;
  const dot = c.indexOf('.');
  if (dot < 0) return false;
  const exp = c.slice(0, dot), sig = c.slice(dot + 1);
  if (!exp || !sig || Date.now() > Number(exp)) return false;
  return timingSafeEqualStr(sig, powSign(['pass', exp, powIpKey(req)]));
}
function issuePowCookie(req, res) {
  const exp = Date.now() + 30 * 60000; // pass valid 30 min
  const val = exp + '.' + powSign(['pass', String(exp), powIpKey(req)]);
  res.setHeader('Set-Cookie', `dxpow=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800${secureCookie(req)}`);
}
// A ZIP download's size isn't known up front, so when the challenge is enabled we
// treat every archive as a "large download" and gate it. Returns true (and serves
// the interstitial) when the visitor still needs to solve the challenge.
function challengeGateZip(req, res) {
  if (getSettings().challengeEnabled && req.method === 'GET' && !hasValidPow(req)) {
    res.status(200).type('html').send(challengePage(pickLang(req)));
    return true;
  }
  return false;
}

function createSession(req, res, account) {
  const sid = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, {
    csrf,
    expires: Date.now() + sessionTtlMs(),
    accountId: account ? account.id : null,
    username: account ? account.username : null,
    role: account ? account.role : null,
  });
  const maxAge = Math.floor(sessionTtlMs() / 1000);
  // SameSite=Lax (not Strict): an installed PWA launched from the Android home
  // screen (WebAPK) or a Web Share Target POST is a *cross-site* top-level
  // navigation, and a Strict cookie is withheld there — so the relaunch arrives
  // unauthenticated and the workspace looks reset. Lax is still sent on top-level
  // GET navigations while remaining withheld on cross-site subrequests/POSTs, and
  // every mutating route additionally verifies an X-CSRF-Token (requireAuth /
  // requireAppAuth) plus, under /app, an exact same-origin check — so Lax does not
  // weaken CSRF protection.
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie(req)}`);
  return { sid, csrf };
}

// --- Admin audit log (state.audit; most recent first, capped at AUDIT_MAX) ---
function logAudit(action, opts) {
  opts = opts || {};
  const acc = opts.account || null;
  const entry = {
    at: Date.now(),
    action: action,
    actor: acc ? acc.username : (opts.username || null),
    actorId: acc ? acc.id : null,
    role: acc ? acc.role : null,
    ip: opts.ip || null,
    detail: opts.detail != null ? String(opts.detail).slice(0, 300) : null,
  };
  if (!Array.isArray(state.audit)) state.audit = [];
  state.audit.unshift(entry);
  if (state.audit.length > AUDIT_MAX) state.audit.length = AUDIT_MAX;
  scheduleFlush();
  maybeSecurityAlert(entry); // Feature 4: notify on sensitive events (opt-in)
  return entry;
}

// Feature 4 — admin security alerts. Notifies (webhook + e-mail) on a handful of
// sensitive audited events when settings.notifySecurity is on. Best-effort and
// wrapped in try/catch so a notification failure never breaks the audited action.
function maybeSecurityAlert(entry) {
  try {
    if (!getSettings().notifySecurity) return;
    const a = entry.action;
    let title = null;
    if (a === 'login') title = 'New admin login';
    else if ((a === 'login-fail' || a === 'login-2fa-fail') && entry.detail === 'locked-out') title = 'Brute-force lockout';
    else if (a === 'settings-changed') title = 'Settings changed';
    else if (a === 'collab-created' && /delete allowed/.test(entry.detail || '')) title = 'Collaboration link with deletion enabled';
    else if (a === 'account-created') title = 'Admin account created';
    else if (a === 'account-deleted') title = 'Admin account deleted';
    if (!title) return;
    const who = entry.actor ? ` by ${entry.actor}` : '';
    const where = entry.ip ? ` — ${entry.ip}` : '';
    const detail = entry.detail && entry.detail !== 'locked-out' ? ': ' + entry.detail : '';
    dispatch('security', `${APP_NAME} — ${title}`, `🔐 ${APP_NAME} — ${title}${who}${detail}${where}`,
      { action: a, actor: entry.actor || null, ip: entry.ip || null, detail: entry.detail || null });
  } catch (_) { /* never let an alert break the audited action */ }
}
// Audit an action performed by the currently-authenticated account (from req).
function auditReq(req, action, detail) {
  const s = (req && req.session) || {};
  logAudit(action, {
    account: s.accountId ? getAccountById(s.accountId) : null,
    username: s.username,
    ip: clientIp(req),
    detail: detail,
  });
}

function destroySession(req, res) {
  const { sid } = parseCookies(req);
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie(req)}`);
}

function getSession(req) {
  const { sid } = parseCookies(req);
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(sid);
    return null;
  }
  // A session whose account was deleted is no longer valid.
  if (s.accountId && !getAccountById(s.accountId)) {
    sessions.delete(sid);
    return null;
  }
  return { sid, csrf: s.csrf, expires: s.expires, accountId: s.accountId, username: s.username, role: s.role };
}

function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'not-authenticated' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const token = req.headers['x-csrf-token'];
    if (!token || !timingSafeEqualStr(token, s.csrf)) {
      return res.status(403).json({ error: 'invalid-csrf' });
    }
  }
  req.session = s;
  next();
}

// Only the owner account may manage accounts.
function requireOwner(req, res, next) {
  if (req.session && req.session.role === 'owner') return next();
  return res.status(403).json({ error: 'owner-only' });
}

// Verifies a login against a named account (brute-force lockout is per-IP, so it
// protects regardless of which username is tried). Returns the resolved account
// on success. 2FA is per account.
function attemptLogin(req, res, username, password, totp) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { fails: [], lockUntil: 0 };
  if (rec.lockUntil && now < rec.lockUntil) {
    return { ok: false, locked: true, retryAfter: Math.ceil((rec.lockUntil - now) / 1000) };
  }
  // Records a failed attempt (bad password OR bad 2FA code) and returns whether locked.
  const recordFail = () => {
    rec.fails.push(now);
    rec.fails = rec.fails.filter((ts) => now - ts < FAIL_WINDOW_MS);
    if (rec.fails.length >= maxLoginFails()) { rec.lockUntil = now + lockMs(); rec.fails = []; }
    loginAttempts.set(ip, rec);
    return rec.lockUntil > now;
  };
  const retryAfter = () => (rec.lockUntil > now ? Math.ceil((rec.lockUntil - now) / 1000) : undefined);

  const acc = findAccountByName(username);
  // Verify against the account (or a dummy record when unknown) to keep timing flat.
  const passOk = verifyPassword(password || '', acc ? accountPwRec(acc) : DUMMY_PW_REC);
  if (!acc || !passOk) {
    const locked = recordFail();
    logAudit('login-fail', { username: normUsername(username), ip, detail: locked ? 'locked-out' : null });
    return { ok: false, locked, retryAfter: retryAfter() };
  }
  // Password OK. When the account has 2FA, also require a valid TOTP / recovery code.
  if (twoFactorEnabledFor(acc)) {
    if (!totp) return { ok: false, totpRequired: true };
    if (!verifyTotpOrRecoveryFor(acc, totp)) {
      const locked = recordFail();
      logAudit('login-2fa-fail', { account: acc, ip, detail: locked ? 'locked-out' : null });
      return { ok: false, totpInvalid: true, locked, retryAfter: retryAfter() };
    }
  }
  loginAttempts.delete(ip);
  acc.lastLoginAt = now;
  scheduleFlush();
  const sess = createSession(req, res, acc);
  logAudit('login', { account: acc, ip });
  return { ok: true, sid: sess.sid, csrf: sess.csrf, account: acc };
}

// Changes an account's password (durable synchronous write). Marks it as changed
// so the forced first-login change no longer applies.
function setAccountPassword(acc, newPw) {
  acc.ah = hashPassword(newPw);
  acc.pwChanged = true;
  return persistNow();
}

// --- Optional TOTP 2FA (RFC 6238, built-in crypto), per account ---------------
// account.totp = { secret:<base32>, enabled:bool, recovery:[<scrypt hash>,…] }
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(n % 1000000).padStart(6, '0');
}
function verifyTotp(secret, token, win = 1) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const key = base32decode(secret);
  const counter = Math.floor(Date.now() / 30000);
  for (let i = -win; i <= win; i++) {
    if (timingSafeEqualStr(totpAt(key, counter + i), t)) return true;
  }
  return false;
}
function twoFactorEnabledFor(acc) {
  return !!(acc && acc.totp && acc.totp.enabled && acc.totp.secret);
}
// Accepts a live TOTP code or a one-time recovery code (consumed) for an account.
function verifyTotpOrRecoveryFor(acc, input) {
  const tf = acc && acc.totp;
  if (!tf || !tf.enabled) return false;
  if (verifyTotp(tf.secret, input)) return true;
  const codes = Array.isArray(tf.recovery) ? tf.recovery : [];
  const cand = String(input || '').replace(/\s/g, '').toLowerCase();
  for (let i = 0; i < codes.length; i++) {
    const rec = parseHash(codes[i]);
    if (rec && verifyPassword(cand, rec)) {
      codes.splice(i, 1); // one-time use
      persistNow();
      return true;
    }
  }
  return false;
}

// Invalidates every session of a given account except the given one (used after a
// password change so the account's other sessions are logged out).
function clearOtherSessionsOfAccount(accountId, keepSid) {
  for (const [sid, s] of sessions) {
    if (sid !== keepSid && s.accountId === accountId) sessions.delete(sid);
  }
}
// Invalidates all sessions of an account (used when the account is deleted).
function clearSessionsOfAccount(accountId) {
  for (const [sid, s] of sessions) if (s.accountId === accountId) sessions.delete(sid);
}

// Auto-remove shares that expired more than this long ago (quota-exhausted shares
// are kept for review). A day's grace keeps recently-expired links briefly visible.
const SHARE_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;
const authCleanup = setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now > s.expires) sessions.delete(sid);
  for (const [ip, r] of loginAttempts) {
    // Drop failures that fell out of the sliding window, then forget idle IPs.
    if (r.fails) r.fails = r.fails.filter((ts) => now - ts < FAIL_WINDOW_MS);
    if ((!r.lockUntil || now > r.lockUntil) && (!r.fails || r.fails.length === 0)) {
      loginAttempts.delete(ip);
    }
  }
  for (const [ip, r] of unlockFails) {
    if (Array.isArray(r.fails)) r.fails = r.fails.filter((ts) => now - ts < FAIL_WINDOW_MS);
    if ((!r.lockUntil || now > r.lockUntil) && (!r.fails || r.fails.length === 0)) unlockFails.delete(ip);
  }
  // Avoid unbounded growth of the geo cache (one entry per visiting IP).
  for (const [ip, g] of geoCache) if (now - g.at > GEO_TTL) geoCache.delete(ip);
  // Auto-remove shares that expired more than SHARE_PURGE_GRACE_MS ago.
  const expiredIds = state.shares
    .filter((sh) => sh && sh.expiresAt && now - sh.expiresAt > SHARE_PURGE_GRACE_MS)
    .map((sh) => sh.id);
  let purgedShares = 0;
  for (const id of expiredIds) if (removeShare(id, false)) purgedShares++;
  if (purgedShares) persist();
}, 60 * 1000);
if (authCleanup.unref) authCleanup.unref();

// ===================================================================
//  RENDERING of public pages (systematic HTML escaping)
// ===================================================================

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Serializes an object for embedding inside an inline <script> tag. Escapes `<`
// (and the U+2028/U+2029 line separators) so a value containing `</script>` — e.g.
// an uploaded/host file name — can't break out of the script element. The strict
// CSP already blocks inline execution, but this keeps the embed safe on its own.
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// One CSV cell: RFC-4180 quoting AND spreadsheet formula-injection defense. A cell
// starting with = + - @ (or a control char Excel treats as a formula lead) is
// prefixed with an apostrophe, because journal/audit fields include untrusted
// uploader-supplied filenames \u2014 a name like =HYPERLINK(...) must not execute when
// the admin opens the export in Excel/LibreOffice.
function csvField(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

const PAGE_STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  background:#0f1220;color:#e7e9f3;min-height:100vh;display:flex;flex-direction:column}
a{color:#8ab4ff}
.wrap{max-width:1240px;margin:0 auto;padding:32px 20px;width:100%;flex:1}
.card{background:#1a1e33;border:1px solid #2a3050;border-radius:14px;padding:28px;margin:18px 0}
h1{font-size:1.4rem;margin:0 0 4px;word-break:break-word}
.muted{color:#9aa3c7;font-size:.9rem}
.btn{display:inline-block;background:#3b6ef6;color:#fff;text-decoration:none;
  padding:12px 22px;border-radius:10px;font-weight:600;margin-top:8px}
.btn:hover{background:#2f5de0}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #2a3050;font-size:.92rem}
th{color:#9aa3c7;font-weight:600}
td.size{white-space:nowrap;color:#9aa3c7}
.crumbs{margin:0 0 8px;font-size:.9rem;color:#9aa3c7;word-break:break-all}
.crumbs .crumb{color:#8ab4ff;text-decoration:none}
.crumbs .crumb:hover{text-decoration:underline}
.crumbs .crumb.active{color:#9aa3c7;font-weight:600}
.collab-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:6px 0 10px}
.collab-bar-actions{display:flex;gap:8px;flex-wrap:wrap}
.collab-list{display:flex;flex-direction:column;gap:2px;margin:6px 0 14px;border:1px solid #2a3050;border-radius:12px;overflow:hidden}
.cl-row{display:flex;align-items:center;gap:10px;padding:9px 12px;background:#151a2e;border-bottom:1px solid #222846}
.cl-row:last-child{border-bottom:none}
.cl-row.cl-up{background:#12172a}
.cl-ico{flex:0 0 auto;width:1.3em;text-align:center}
.cl-name{flex:1;min-width:0;word-break:break-all;color:#e8ebfb;text-decoration:none}
a.cl-name:hover{text-decoration:underline;color:#8ab4ff}
.cl-size{flex:0 0 auto;white-space:nowrap;font-size:.82rem;margin-right:4px}
.cl-empty{padding:16px;text-align:center}
.ico{display:inline-block;width:1.2em;text-align:center;margin-right:6px}
.brandbar{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 20px;border-bottom:1px solid #2a3050}
.bb-name{font-weight:700;font-size:1.05rem;color:#8ab4ff;display:inline-flex;align-items:center;gap:8px}
.bb-logo{width:26px;height:26px}
.langsel{display:inline-flex;align-items:center;gap:5px;font-size:.8rem;white-space:nowrap}
.langsel-ico{opacity:.7;margin-right:1px}
.langsel a{color:#9aa3c7;text-decoration:none;padding:3px 9px;border-radius:8px;border:1px solid #2a3050}
.langsel a:hover{color:#e7e9f3;border-color:#3b6ef6}
.langsel .active{color:#fff;font-weight:700;padding:3px 9px;border-radius:8px;background:#3b6ef6;border:1px solid #3b6ef6}
.langsel a.pending{color:#ffd166;border-color:#ffd166}
.langsel a.pending::after{content:'';display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:#ffd166;vertical-align:middle}
.brandbar-tools{display:inline-flex;align-items:center;gap:8px}
.themesel{background:#0f1220;color:#e7e9f3;border:1px solid #2a3050;border-radius:8px;padding:4px 8px;font-size:.8rem;cursor:pointer}
footer{text-align:center;padding:16px;color:#6b7398;font-size:.8rem}
.preview{margin:14px 0;display:flex;justify-content:center;position:relative}
.preview img,.preview video{max-width:100%;max-height:70vh;border-radius:12px;background:#0d1226;border:1px solid #2a3050}
.preview-audio{display:block}
.preview-audio audio{width:100%}
.wm-overlay{position:absolute;inset:0;pointer-events:none;background-repeat:repeat;background-position:center;border-radius:12px;mix-blend-mode:screen;z-index:2}
.legal-banner{display:flex;align-items:center;justify-content:center;gap:8px;
  padding:9px 16px;background:#3a2a12;color:#ffd8a8;border-bottom:1px solid #5a4320;
  font-size:.85rem;font-weight:600;text-align:center}
.legal-ico{flex:none}
.render-card{max-width:900px}
.render-out{margin-top:14px}
pre.code{background:#0d1226;border:1px solid #2a3050;border-radius:10px;padding:14px 16px;
  overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;
  line-height:1.5;color:#c8d0f0;white-space:pre;tab-size:2}
pre.code code{font:inherit;color:inherit;background:none;padding:0}
.tok-c{color:#6b7398;font-style:italic}
.tok-s{color:#9ece6a}
.tok-n{color:#ff9e64}
.tok-k{color:#7aa2f7;font-weight:600}
.md-body{line-height:1.65;word-wrap:break-word}
.md-body h1,.md-body h2,.md-body h3,.md-body h4{line-height:1.3;margin:1.1em 0 .5em}
.md-body h1{font-size:1.5rem;border-bottom:1px solid #2a3050;padding-bottom:.3em}
.md-body h2{font-size:1.25rem;border-bottom:1px solid #2a3050;padding-bottom:.25em}
.md-body p{margin:.7em 0}
.md-body ul,.md-body ol{margin:.7em 0;padding-left:1.6em}
.md-body li{margin:.25em 0}
.md-body code{background:#0d1226;border:1px solid #2a3050;border-radius:5px;padding:1px 5px;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em}
.md-body pre.code{margin:.8em 0}
.md-body blockquote{margin:.7em 0;padding:.2em 1em;border-left:3px solid #3b6ef6;color:#9aa3c7}
.md-body a{color:#8ab4ff}
.md-body hr{border:0;border-top:1px solid #2a3050;margin:1.2em 0}
.md-body img{max-width:100%}
.dxp-stage{position:relative;margin:14px 0;background:#0d1226;border:1px solid #2a3050;border-radius:12px;overflow:hidden}
.dxp-stage video{display:block;width:100%;max-height:70vh;background:#000}
.dxp-now{font-weight:600;margin:6px 0 10px;word-break:break-all}
.dxp-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px}
.dxp-track{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid #2a3050;border-radius:9px;cursor:pointer;transition:border-color .15s,background .15s}
.dxp-track:hover{border-color:#3b6ef6}
.dxp-track.active{background:rgba(59,110,246,.14);border-color:#3b6ef6}
.dxp-ico{flex:none}
.dxp-name{word-break:break-all;font-size:.92rem}
.file-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btn-ghost{background:transparent;border:1px solid #2a3050;color:#bcd2ff}
.filelist td{vertical-align:middle}
.fl-name{word-break:break-all}
.fl-size{white-space:nowrap;color:#9aa3c7;text-align:right}
.fl-act{white-space:nowrap;text-align:right}
.row-act{display:inline-block;margin-left:10px;color:#8ab4ff;text-decoration:none;font-size:.9rem}
.row-act:hover{text-decoration:underline}
.fl-controls{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 2px}
.fl-acts{display:inline-flex;gap:14px;align-items:center;flex-wrap:wrap}
.sel-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 2px;padding:8px 12px;border:1px solid #2a3050;border-radius:10px;background:#141830;font-size:.9rem;color:#9aa3c7}
.sel-cb{margin-right:8px;vertical-align:middle;accent-color:#3b6ef6}
.file-sums{margin-top:12px;text-align:center}
.fl-search{width:100%;margin:8px 0 2px;padding:10px 12px;border-radius:10px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font:inherit;font-size:.92rem}
.fl-search:focus{outline:none;border-color:#3b6ef6}
.fl-noresult{margin:12px 0}
.view-toggle{display:inline-flex;border:1px solid #2a3050;border-radius:9px;overflow:hidden}
.vt-btn{background:transparent;border:0;color:#9aa3c7;padding:7px 13px;font-size:.85rem;cursor:pointer;font-family:inherit}
.vt-btn:hover{color:#e7e9f3}
.vt-btn.active{background:#3b6ef6;color:#fff}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin:14px 0 4px}
.g-tile{display:flex;flex-direction:column;text-decoration:none;color:#cdd8f5;border:1px solid #2a3050;border-radius:12px;overflow:hidden;background:#151a2e}
.g-tile:hover{border-color:#3b6ef6}
.g-media{position:relative;display:block;aspect-ratio:1/1;background:#0d1226}
.g-media img,.g-media video{width:100%;height:100%;object-fit:cover;display:block}
.g-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:1.7rem;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.6);pointer-events:none}
.g-cap{padding:7px 9px;font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.has-gallery[data-view="list"] .gallery{display:none}
.has-gallery[data-view="gallery"] .list-view{display:none}
td{word-break:break-word}
.btn.block{display:block;width:100%;text-align:center;margin-top:6px}
.inbox-head{display:flex;align-items:center;gap:14px;margin-bottom:4px}
.inbox-badge{flex:0 0 auto;width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:1.55rem;background:linear-gradient(180deg,#1f2a4d,#182238);border:1px solid #2a3050}
.inbox-head-txt h1{margin:0}
.inbox-head-txt .muted{margin:3px 0 0}
.up-drop{display:flex;flex-direction:column;align-items:center;gap:6px;border:2px dashed #33406b;border-radius:16px;padding:32px 20px;text-align:center;margin:18px 0;cursor:pointer;transition:border-color .15s,background .15s}
.up-drop:hover{border-color:#3b6ef6;background:rgba(59,110,246,.05)}
.up-drop.drag{border-color:#3b6ef6;background:rgba(59,110,246,.1)}
.up-drop-ico{font-size:2rem;line-height:1;color:#8ab4ff}
.up-drop-title{font-weight:600;font-size:1rem}
.up-drop-sub{color:#9aa3c7;font-size:.82rem}
.btn.ghost{background:transparent;border:1px solid #2a3050;color:#bcd2ff;font-weight:600}
.btn.ghost:hover{border-color:#3b6ef6;background:rgba(59,110,246,.08)}
.btn.sm{padding:8px 14px;font-size:.85rem;margin-top:0}
.btn.xs{padding:5px 10px;font-size:.78rem;margin-top:0}
.btn.danger{background:transparent;border:1px solid #5a2a2a;color:#e79a9a;font-weight:600}
.btn.danger:hover{border-color:#e06c6c;background:rgba(224,108,108,.1)}
.up-modes{display:flex;gap:10px;justify-content:center;margin:2px 0 4px;flex-wrap:wrap}
.up-folder-current{text-align:center;margin:8px 0 0;font-size:.84rem;color:#8ab4ff;word-break:break-word}
.up-limits{text-align:center;margin:8px 0 0;font-size:.82rem}
.inbox-note{display:flex;gap:10px;align-items:flex-start;background:rgba(59,110,246,.08);border:1px solid #2a3050;border-left:3px solid #3b6ef6;border-radius:10px;padding:12px 14px;margin:14px 0 4px}
.inbox-note-ico{flex:0 0 auto;font-size:1.1rem;line-height:1.3}
.inbox-note-txt{font-size:.9rem;color:#cdd8f5;word-break:break-word}
.up-msg-label{display:block;font-size:.82rem;color:#9aa3c7;margin:6px 0 4px}
.up-msg{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font:inherit;font-size:.92rem;resize:vertical;margin-bottom:10px}
.up-msg:focus{outline:none;border-color:#3b6ef6}
.enc-banner{display:flex;gap:10px;align-items:center;background:rgba(56,211,155,.09);border:1px solid #2a3050;border-left:3px solid #38d39b;border-radius:10px;padding:11px 14px;margin:14px 0 8px;font-size:.9rem;color:#cdeee0}
.enc-ico{flex:0 0 auto}
.enc-bar-wrap{margin:12px 0}
.up-warn{background:rgba(255,192,97,.1);border:1px solid #4a3f22;border-left:3px solid #ffc061;border-radius:10px;padding:12px 14px;margin:14px 0;font-size:.88rem;line-height:1.4;color:#f2d9a8}
.uprow.skip{opacity:.7}
.upcancel{flex:0 0 auto;align-self:center;width:26px;height:26px;padding:0;border-radius:8px;border:1px solid #2a3050;background:transparent;color:#9aa3c7;font-size:.9rem;line-height:1;cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.upcancel:hover{color:#ff6b81;border-color:#ff6b81;background:rgba(255,107,129,.08)}
.up-list-tools{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 0}
.up-list-count{font-size:.85rem}
.up-list{display:flex;flex-direction:column;gap:10px;margin:12px 0 16px}
.uprow{display:flex;align-items:flex-start;gap:12px;background:#151a2e;border:1px solid #2a3050;border-radius:12px;padding:12px 14px}
.upicon{flex:0 0 auto;font-size:1.3rem;line-height:1.25}
.upmain{flex:1;min-width:0}
.uptop{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.upname{font-weight:600;word-break:break-all;font-size:.92rem}
.upbar{height:7px;background:#2a3050;border-radius:5px;overflow:hidden;margin:8px 0 6px}
.upbar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3b6ef6,#5b8dff);border-radius:5px;transition:width .2s}
.upmeta{display:flex;gap:4px 14px;flex-wrap:wrap;font-size:.76rem;color:#6b7398;font-variant-numeric:tabular-nums}
.upmeta .upspeed{color:#8ab4ff}
.upstatus{flex:0 0 auto;color:#9aa3c7;font-size:.82rem;font-variant-numeric:tabular-nums}
.upmsg{width:100%;margin-top:8px;padding:7px 10px;border-radius:8px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font:inherit;font-size:.85rem}
.upmsg:focus{outline:none;border-color:#3b6ef6}
.upmsg:disabled{opacity:.6}
.upstatus.ok{color:#38d39b}
.upstatus.err{color:#ff6b81}
.err{color:#ff6b81;font-size:.9rem;margin:8px 0}
input.pw{width:100%;padding:12px 14px;margin:12px 0;border-radius:10px;border:1px solid #2a3050;background:#0f1220;color:#e7e9f3;font-size:1rem}
input.pw:focus{outline:none;border-color:#3b6ef6}
@media(max-width:600px){
.wrap{padding:22px 14px}
.card{padding:20px 16px}
.brandbar{padding:12px 14px}
th,td{padding:9px 6px;font-size:.86rem}
.btn{padding:12px 20px}
}
`;

// Language of public pages, by priority:
//   ?lang=xx (explicit choice) > "lang" cookie > Accept-Language > en.
function pickLang(req) {
  const supported = ['fr', 'en', 'es'];
  const q = String((req && req.query && req.query.lang) || '').toLowerCase();
  if (supported.includes(q)) return q;
  const cookies = parseCookies(req);
  const c = String(cookies.lang || '').toLowerCase();
  if (supported.includes(c)) return c;
  const al = String((req && req.headers && req.headers['accept-language']) || '').toLowerCase();
  for (const part of al.split(',')) {
    const code = part.trim().slice(0, 2);
    if (supported.includes(code)) return code;
  }
  // Admin-configured default public language (falls back to English).
  const def = String(getSettings().publicLang || '').toLowerCase();
  if (supported.includes(def)) return def;
  return 'en';
}

const PUB = {
  fr: {
    download: '⬇ Télécharger',
    preview: '👁 Aperçu',
    vidUnsupported: 'Aperçu impossible dans ce navigateur pour ce format — le codec n’est pas pris en charge.',
    downloadAllZip: '⬇ Tout télécharger (.zip)',
    checksums: '🔐 Empreintes (.sha256)',
    selectZip: '⬇ Télécharger la sélection (.zip)',
    selectedWord: 'sélectionné(s)',
    playerLabel: '▶ Lecteur',
    noMedia: 'Aucun fichier audio ou vidéo à lire dans ce dossier.',
    backToFiles: '← Retour aux fichiers',
    subsOff: 'Sous-titres désactivés',
    filesWord: 'fichiers',
    itemsWord: 'éléments',
    browseLabel: 'Parcourir',
    zipLabel: '⬇ .zip',
    viewList: '☰ Liste',
    viewGallery: '▦ Galerie',
    size: 'Taille',
    name: 'Nom',
    emptyFolder: 'Dossier vide',
    searchPh: '🔍 Filtrer par nom…',
    noResult: 'Aucun fichier ne correspond.',
    footer: `${APP_NAME} · © ${APP_YEAR} · v${APP_VERSION}`,
    shareGone: 'Ce partage n\'existe pas ou a été révoqué.',
    notYetActive: 'Ce lien n\'est pas encore disponible.',
    fileNotFound: 'Fichier introuvable.',
    readError: 'Erreur de lecture du fichier.',
    notFound: 'Introuvable.',
    fileUnavailable: 'Fichier indisponible.',
    hotlinkBlocked: 'Ce lien d\'image est protégé contre le hotlink.',
    albumTitle: 'Galerie d\'images',
    albumCount: '{n} images',
    albumEmpty: 'Aucune image dans cette galerie.',
    photoMetadataRemoved: 'EXIF/GPS supprimés',
    folderUnavailable: 'Dossier indisponible.',
    folderNotFound: 'Dossier introuvable.',
    zipError: 'Erreur de compression.',
    pageNotFound: 'Page introuvable.',
    tooManyReq: 'Trop de requêtes. Merci de patienter un instant avant de réessayer.',
    accessDenied: 'Accès refusé depuis votre emplacement ou votre réseau.',
    chalTitle: 'Vérification avant téléchargement',
    chalIntro: 'Pour protéger ce lien contre les abus, votre navigateur doit résoudre un petit défi. Cela se fait automatiquement, sans aucun tiers.',
    chalWorking: 'Calcul en cours…',
    chalVerify: 'Vérification…',
    chalFail: 'La vérification a échoué. Rechargez la page pour réessayer.',
    chalNoJs: 'JavaScript est requis pour vérifier ce téléchargement.',
    rawView: '📄 Version brute',
    zipEntries: 'entrées dans l\'archive',
    archiveEmpty: 'Archive vide.',
    archiveUnreadable: 'Impossible de lire le contenu de cette archive.',
    archiveTruncated: 'Liste tronquée (trop d\'entrées).',
    previewTruncated: 'Aperçu tronqué : fichier trop volumineux.',
    adminLanOnly: "L'interface d'administration n'est accessible que depuis le réseau local.",
    inboxIntro: 'Envoyez un ou plusieurs fichiers.',
    inboxHint: 'Cliquez ou glissez vos fichiers ici',
    inboxHint2: 'Sélection multiple acceptée',
    inboxSend: 'Envoyer',
    inboxPickFiles: '📄 Fichiers',
    inboxPickFolder: '📁 Dossier',
    newFolder: '📁 Nouveau dossier',
    newFolderPrompt: 'Nom du nouveau dossier :',
    folderCreated: 'Dossier créé',
    folderCreateFail: 'Impossible de créer le dossier.',
    folderInvalid: 'Ce nom de dossier est invalide.',
    folderExists: 'Un dossier ou un fichier porte déjà ce nom.',
    folderBusy: 'Attendez la fin de l’envoi avant de changer de dossier.',
    uploadDestination: 'Destination : {path}',
    msgLabel: 'Message (facultatif)',
    senderLabel: 'Votre nom',
    senderPh: 'Pour classer votre envoi (facultatif)',
    msgPh: 'Un mot pour accompagner votre envoi…',
    limitPerFile: 'Max {v} par fichier',
    limitQuota: 'Quota : {v} restants sur {t}',
    limitFiles: '{v} fichiers restants sur {t}',
    limitAllow: 'Types autorisés : {v}',
    limitBlock: 'Types bloqués : {v}',
    langPending: "Sera appliqué à la fin de l'envoi en cours.",
    themeLabel: 'Thème', themeDark: 'Sombre', themeLight: 'Clair', themeAuto: 'Auto',
    pwPrompt: 'Ce lien est protégé. Saisissez le mot de passe pour continuer.',
    pwField: 'Mot de passe',
    pwSubmit: 'Déverrouiller',
    pwWrong: 'Mot de passe incorrect.',
    encInboxBanner: 'Ce dépôt est chiffré de bout en bout dans votre navigateur.',
    encPassLabel: 'Phrase secrète de chiffrement',
    encPassPh: 'Phrase communiquée par le destinataire',
    encEncrypting: 'chiffrement…',
    encPassRequired: 'Saisissez d’abord la phrase secrète de chiffrement.',
    encKeyMissing: 'Ce lien est incomplet (clé manquante).',
    encDlTitle: 'Fichier chiffré',
    encDlIntro: 'Ce fichier est chiffré de bout en bout. Il sera déchiffré dans votre navigateur.',
    encDlPassLabel: 'Phrase secrète',
    encDlBtn: '🔓 Déchiffrer et télécharger',
    encDlWorking: 'Déchiffrement…',
    encDlDownloading: 'Téléchargement du fichier chiffré…',
    encDlBadKey: 'Clé ou phrase secrète incorrecte, ou fichier altéré.',
    encDlKeyMissing: 'Ce lien est incomplet (clé de déchiffrement manquante).',
    encDlReady: 'Terminé — le téléchargement devrait démarrer.',
    collabIntro: 'Dossier partagé : téléchargez et déposez des fichiers.',
    collabDelete: '🗑 Supprimer',
    collabDeleteConfirm: 'Supprimer « {n} » ? Cette action est irréversible.',
    collabDeleted: 'Supprimé',
    collabDeleteFail: 'Échec de la suppression',
    collabUploaded: 'Envoyé',
    collabUploadFail: 'Échec de l’envoi',
    collabParent: '⬆ Dossier parent',
    collabRefresh: '↻ Actualiser',
    collabHome: 'Racine',
    secretTitle: 'Note secrète',
    secretIntro: 'Ce message est chiffré de bout en bout et sera détruit dès sa première lecture.',
    secretReveal: '🔓 Révéler le secret',
    secretPassLabel: 'Phrase secrète',
    secretPassPh: 'Communiquée séparément',
    secretWorking: 'Déchiffrement…',
    secretBadKey: 'Clé ou phrase secrète incorrecte.',
    secretKeyMissing: 'Ce lien est incomplet (clé manquante).',
    secretGone: 'Ce secret a déjà été lu ou a expiré — il n’existe plus.',
    secretOneShot: '⚠ Ce secret ne peut être lu qu’une seule fois : une mauvaise clé ne pourra pas être réessayée.',
    secretCopy: '📋 Copier',
    copied: 'Copié !',
  },
  en: {
    download: '⬇ Download',
    preview: '👁 Preview',
    vidUnsupported: 'This format can’t be previewed in your browser — the codec isn’t supported.',
    downloadAllZip: '⬇ Download all (.zip)',
    checksums: '🔐 Checksums (.sha256)',
    selectZip: '⬇ Download selection (.zip)',
    selectedWord: 'selected',
    playerLabel: '▶ Player',
    noMedia: 'No audio or video files to play in this folder.',
    backToFiles: '← Back to files',
    subsOff: 'Subtitles off',
    filesWord: 'files',
    itemsWord: 'items',
    browseLabel: 'Browse',
    zipLabel: '⬇ .zip',
    viewList: '☰ List',
    viewGallery: '▦ Gallery',
    size: 'Size',
    name: 'Name',
    emptyFolder: 'Empty folder',
    searchPh: '🔍 Filter by name…',
    noResult: 'No file matches.',
    footer: `${APP_NAME} · © ${APP_YEAR} · v${APP_VERSION}`,
    shareGone: 'This share does not exist or has been revoked.',
    notYetActive: 'This link is not available yet.',
    fileNotFound: 'File not found.',
    readError: 'File read error.',
    notFound: 'Not found.',
    fileUnavailable: 'File unavailable.',
    hotlinkBlocked: 'This image link is hotlink-protected.',
    albumTitle: 'Image gallery',
    albumCount: '{n} images',
    albumEmpty: 'No images in this gallery.',
    photoMetadataRemoved: 'EXIF/GPS removed',
    folderUnavailable: 'Folder unavailable.',
    folderNotFound: 'Folder not found.',
    zipError: 'Compression error.',
    pageNotFound: 'Page not found.',
    tooManyReq: 'Too many requests. Please wait a moment before trying again.',
    accessDenied: 'Access denied from your location or network.',
    chalTitle: 'Verification before download',
    chalIntro: 'To protect this link from abuse, your browser must solve a small challenge. It runs automatically, with no third party involved.',
    chalWorking: 'Working…',
    chalVerify: 'Verifying…',
    chalFail: 'Verification failed. Reload the page to try again.',
    chalNoJs: 'JavaScript is required to verify this download.',
    rawView: '📄 Raw version',
    zipEntries: 'entries in the archive',
    archiveEmpty: 'Empty archive.',
    archiveUnreadable: 'Could not read this archive\'s contents.',
    archiveTruncated: 'Listing truncated (too many entries).',
    previewTruncated: 'Preview truncated: file too large.',
    adminLanOnly: 'The admin interface is only reachable from the local network.',
    inboxIntro: 'Send one or more files.',
    inboxHint: 'Click or drop your files here',
    inboxHint2: 'Multiple files supported',
    inboxSend: 'Send',
    inboxPickFiles: '📄 Files',
    inboxPickFolder: '📁 Folder',
    newFolder: '📁 New folder',
    newFolderPrompt: 'New folder name:',
    folderCreated: 'Folder created',
    folderCreateFail: 'Could not create the folder.',
    folderInvalid: 'This folder name is invalid.',
    folderExists: 'A folder or file already uses this name.',
    folderBusy: 'Wait for the upload to finish before changing folders.',
    uploadDestination: 'Destination: {path}',
    msgLabel: 'Message (optional)',
    senderLabel: 'Your name',
    senderPh: 'To file your deposit (optional)',
    msgPh: 'A note to go with your upload…',
    limitPerFile: 'Max {v} per file',
    limitQuota: 'Quota: {v} left of {t}',
    limitFiles: '{v} files left of {t}',
    limitAllow: 'Allowed types: {v}',
    limitBlock: 'Blocked types: {v}',
    langPending: 'Will apply once the current transfer finishes.',
    themeLabel: 'Theme', themeDark: 'Dark', themeLight: 'Light', themeAuto: 'Auto',
    pwPrompt: 'This link is protected. Enter the password to continue.',
    pwField: 'Password',
    pwSubmit: 'Unlock',
    pwWrong: 'Incorrect password.',
    encInboxBanner: 'This deposit is end-to-end encrypted in your browser.',
    encPassLabel: 'Encryption passphrase',
    encPassPh: 'Passphrase provided by the recipient',
    encEncrypting: 'encrypting…',
    encPassRequired: 'Enter the encryption passphrase first.',
    encKeyMissing: 'This link is incomplete (missing key).',
    encDlTitle: 'Encrypted file',
    encDlIntro: 'This file is end-to-end encrypted. It will be decrypted in your browser.',
    encDlPassLabel: 'Passphrase',
    encDlBtn: '🔓 Decrypt & download',
    encDlWorking: 'Decrypting…',
    encDlDownloading: 'Downloading ciphertext…',
    encDlBadKey: 'Wrong key or passphrase, or corrupted file.',
    encDlKeyMissing: 'This link is incomplete (missing decryption key).',
    encDlReady: 'Done — your download should start.',
    collabIntro: 'Shared folder: download and drop files.',
    collabDelete: '🗑 Delete',
    collabDeleteConfirm: 'Delete “{n}”? This cannot be undone.',
    collabDeleted: 'Deleted',
    collabDeleteFail: 'Delete failed',
    collabUploaded: 'Uploaded',
    collabUploadFail: 'Upload failed',
    collabParent: '⬆ Parent folder',
    collabRefresh: '↻ Refresh',
    collabHome: 'Home',
    secretTitle: 'Secret note',
    secretIntro: 'This message is end-to-end encrypted and will be destroyed as soon as it is read once.',
    secretReveal: '🔓 Reveal the secret',
    secretPassLabel: 'Passphrase',
    secretPassPh: 'Shared separately',
    secretWorking: 'Decrypting…',
    secretBadKey: 'Wrong key or passphrase.',
    secretKeyMissing: 'This link is incomplete (missing key).',
    secretGone: 'This secret has already been read or has expired — it no longer exists.',
    secretOneShot: '⚠ This secret can only be viewed once: a wrong key cannot be retried.',
    secretCopy: '📋 Copy',
    copied: 'Copied!',
  },
  es: {
    download: '⬇ Descargar',
    preview: '👁 Vista previa',
    vidUnsupported: 'Este formato no se puede previsualizar en tu navegador — el códec no es compatible.',
    downloadAllZip: '⬇ Descargar todo (.zip)',
    checksums: '🔐 Sumas (.sha256)',
    selectZip: '⬇ Descargar selección (.zip)',
    selectedWord: 'seleccionado(s)',
    playerLabel: '▶ Reproductor',
    noMedia: 'No hay archivos de audio o vídeo para reproducir en esta carpeta.',
    backToFiles: '← Volver a los archivos',
    subsOff: 'Subtítulos desactivados',
    filesWord: 'archivos',
    itemsWord: 'elementos',
    browseLabel: 'Explorar',
    zipLabel: '⬇ .zip',
    viewList: '☰ Lista',
    viewGallery: '▦ Galería',
    size: 'Tamaño',
    name: 'Nombre',
    emptyFolder: 'Carpeta vacía',
    searchPh: '🔍 Filtrar por nombre…',
    noResult: 'Ningún archivo coincide.',
    footer: `${APP_NAME} · © ${APP_YEAR} · v${APP_VERSION}`,
    shareGone: 'Esta compartición no existe o ha sido revocada.',
    notYetActive: 'Este enlace aún no está disponible.',
    fileNotFound: 'Archivo no encontrado.',
    readError: 'Error al leer el archivo.',
    notFound: 'No encontrado.',
    fileUnavailable: 'Archivo no disponible.',
    hotlinkBlocked: 'Este enlace de imagen está protegido contra el hotlinking.',
    albumTitle: 'Galería de imágenes',
    albumCount: '{n} imágenes',
    albumEmpty: 'No hay imágenes en esta galería.',
    photoMetadataRemoved: 'EXIF/GPS eliminados',
    folderUnavailable: 'Carpeta no disponible.',
    folderNotFound: 'Carpeta no encontrada.',
    zipError: 'Error de compresión.',
    pageNotFound: 'Página no encontrada.',
    tooManyReq: 'Demasiadas solicitudes. Espera un momento antes de volver a intentarlo.',
    accessDenied: 'Acceso denegado desde tu ubicación o red.',
    chalTitle: 'Verificación antes de descargar',
    chalIntro: 'Para proteger este enlace del abuso, tu navegador debe resolver un pequeño desafío. Se ejecuta automáticamente, sin ningún tercero.',
    chalWorking: 'Calculando…',
    chalVerify: 'Verificando…',
    chalFail: 'La verificación falló. Recarga la página para volver a intentarlo.',
    chalNoJs: 'Se requiere JavaScript para verificar esta descarga.',
    rawView: '📄 Versión sin procesar',
    zipEntries: 'entradas en el archivo',
    archiveEmpty: 'Archivo vacío.',
    archiveUnreadable: 'No se pudo leer el contenido de este archivo.',
    archiveTruncated: 'Lista truncada (demasiadas entradas).',
    previewTruncated: 'Vista previa truncada: archivo demasiado grande.',
    adminLanOnly: 'La interfaz de administración solo es accesible desde la red local.',
    inboxIntro: 'Envía uno o varios archivos.',
    inboxHint: 'Haz clic o arrastra tus archivos aquí',
    inboxHint2: 'Selección múltiple admitida',
    inboxSend: 'Enviar',
    inboxPickFiles: '📄 Archivos',
    inboxPickFolder: '📁 Carpeta',
    newFolder: '📁 Nueva carpeta',
    newFolderPrompt: 'Nombre de la nueva carpeta:',
    folderCreated: 'Carpeta creada',
    folderCreateFail: 'No se pudo crear la carpeta.',
    folderInvalid: 'Este nombre de carpeta no es válido.',
    folderExists: 'Ya existe una carpeta o un archivo con este nombre.',
    folderBusy: 'Espera a que termine el envío antes de cambiar de carpeta.',
    uploadDestination: 'Destino: {path}',
    msgLabel: 'Mensaje (opcional)',
    senderLabel: 'Tu nombre',
    senderPh: 'Para archivar tu envío (opcional)',
    msgPh: 'Unas palabras para acompañar tu envío…',
    limitPerFile: 'Máx. {v} por archivo',
    limitQuota: 'Cuota: {v} de {t} disponibles',
    limitFiles: '{v} de {t} archivos disponibles',
    limitAllow: 'Tipos permitidos: {v}',
    limitBlock: 'Tipos bloqueados: {v}',
    langPending: 'Se aplicará al finalizar el envío en curso.',
    themeLabel: 'Tema', themeDark: 'Oscuro', themeLight: 'Claro', themeAuto: 'Auto',
    pwPrompt: 'Este enlace está protegido. Introduce la contraseña para continuar.',
    pwField: 'Contraseña',
    pwSubmit: 'Desbloquear',
    pwWrong: 'Contraseña incorrecta.',
    encInboxBanner: 'Este depósito se cifra de extremo a extremo en tu navegador.',
    encPassLabel: 'Frase de cifrado',
    encPassPh: 'Frase facilitada por el destinatario',
    encEncrypting: 'cifrando…',
    encPassRequired: 'Introduce primero la frase de cifrado.',
    encKeyMissing: 'Este enlace está incompleto (falta la clave).',
    encDlTitle: 'Archivo cifrado',
    encDlIntro: 'Este archivo está cifrado de extremo a extremo. Se descifrará en tu navegador.',
    encDlPassLabel: 'Frase secreta',
    encDlBtn: '🔓 Descifrar y descargar',
    encDlWorking: 'Descifrando…',
    encDlDownloading: 'Descargando el archivo cifrado…',
    encDlBadKey: 'Clave o frase incorrecta, o archivo alterado.',
    encDlKeyMissing: 'Este enlace está incompleto (falta la clave de descifrado).',
    encDlReady: 'Listo — la descarga debería comenzar.',
    collabIntro: 'Carpeta compartida: descarga y deposita archivos.',
    collabDelete: '🗑 Eliminar',
    collabDeleteConfirm: '¿Eliminar «{n}»? Esta acción no se puede deshacer.',
    collabDeleted: 'Eliminado',
    collabDeleteFail: 'Error al eliminar',
    collabUploaded: 'Enviado',
    collabUploadFail: 'Error al enviar',
    collabParent: '⬆ Carpeta superior',
    collabRefresh: '↻ Actualizar',
    collabHome: 'Inicio',
    secretTitle: 'Nota secreta',
    secretIntro: 'Este mensaje está cifrado de extremo a extremo y se destruirá en cuanto se lea una vez.',
    secretReveal: '🔓 Revelar el secreto',
    secretPassLabel: 'Frase de contraseña',
    secretPassPh: 'Comunicada por separado',
    secretWorking: 'Descifrando…',
    secretBadKey: 'Clave o frase de contraseña incorrecta.',
    secretKeyMissing: 'Este enlace está incompleto (falta la clave).',
    secretGone: 'Este secreto ya se ha leído o ha caducado — ya no existe.',
    secretOneShot: '⚠ Este secreto solo puede verse una vez: una clave incorrecta no podrá reintentarse.',
    secretCopy: '📋 Copiar',
    copied: '¡Copiado!',
  },
};

// Display name for the app: the admin-configured brand, or the built-in name.
function brandName() {
  const b = getSettings().brandName;
  return (typeof b === 'string' && b.trim()) ? b.trim() : APP_NAME;
}
// Optional accent-color override, injected as a CSS variable on public pages.
function accentStyleVar() {
  const c = getSettings().accentColor;
  return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim())) ? c.trim() : '';
}
// Feature 8 — custom logo (data: URL) for the public brand bar, falling back to
// the built-in mark. Validated the same way as on save.
function publicLogoSrc() {
  const v = getSettings().publicLogo;
  return (typeof v === 'string' && /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v.trim()))
    ? v.trim() : '/logo.svg';
}
// Feature 8 — confidentiality/legal banner shown on every public page.
function legalNoticeHtml() {
  const v = getSettings().legalNotice;
  if (typeof v !== 'string' || !v.trim()) return '';
  return `<div class="legal-banner"><span class="legal-ico" aria-hidden="true">⚠️</span><span>${esc(v.trim())}</span></div>`;
}
// Feature 8 — text to overlay on image/video previews (visitor IP, or the
// recipient's name for a nominative sub-link). '' when watermarking is off.
function previewWatermark(req, tk) {
  if (!getSettings().watermarkPreviews) return '';
  const rc = tk ? recipientByToken.get(tk) : null;
  if (rc && rc.recipient && rc.recipient.name) return String(rc.recipient.name).slice(0, 60);
  return String(pubIp(clientIp(req)) || '').slice(0, 60);
}
// A tiled, semi-transparent SVG (data: URI) repeating the watermark text
// diagonally — used as a CSS background over previews.
function watermarkOverlay(text) {
  if (!text) return '';
  const t = esc(String(text)).slice(0, 120);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="170">`
    + `<text x="50%" y="50%" fill="rgba(255,255,255,0.30)" font-family="sans-serif" font-size="17" `
    + `font-weight="700" text-anchor="middle" dominant-baseline="middle" transform="rotate(-30 150 85)">${t}</text></svg>`;
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  return `<span class="wm-overlay" aria-hidden="true" style="background-image:url('${uri}')"></span>`;
}

// Feature 1 — public-page theme. The stylesheet's neutral palette is remapped to
// CSS variables so a light set can override it; 'auto' follows the device via
// prefers-color-scheme, 'dark'/'light' force one. Accent + semantic colors are
// untouched (they read on both). Built once per request (cheap string work).
const THEME_NEUTRALS = {
  '#0f1220': '--p-bg', '#e7e9f3': '--p-text', '#1a1e33': '--p-card', '#2a3050': '--p-border',
  '#9aa3c7': '--p-muted', '#8ab4ff': '--p-link', '#0d1226': '--p-inset', '#151a2e': '--p-row',
  '#6b7398': '--p-faint', '#c8d0f0': '--p-codetext', '#e8ebfb': '--p-strong',
  '#222846': '--p-border2', '#12172a': '--p-row2',
};
const THEME_DARK = ':root{--p-bg:#0f1220;--p-text:#e7e9f3;--p-card:#1a1e33;--p-border:#2a3050;'
  + '--p-muted:#9aa3c7;--p-link:#8ab4ff;--p-inset:#0d1226;--p-row:#151a2e;--p-faint:#6b7398;'
  + '--p-codetext:#c8d0f0;--p-strong:#e8ebfb;--p-border2:#222846;--p-row2:#12172a}';
const THEME_LIGHT = ':root{--p-bg:#f4f6fb;--p-text:#1a1e2e;--p-card:#ffffff;--p-border:#dde1ec;'
  + '--p-muted:#5a6280;--p-link:#2f5de0;--p-inset:#eef1f8;--p-row:#f7f8fc;--p-faint:#7b83a0;'
  + '--p-codetext:#2a2f45;--p-strong:#1a1e2e;--p-border2:#e6e9f2;--p-row2:#f0f2f8}';
// Default theme when the visitor has made no explicit choice. Dark is the default;
// admins can still pin 'light' or make it follow the device ('auto') as the default.
function publicThemeMode() {
  const v = getSettings().publicTheme;
  return ['auto', 'dark', 'light'].includes(v) ? v : 'dark';
}
function publicStyleBlock() {
  let css = PAGE_STYLE.replace(':root{color-scheme:light dark}', '');
  for (const hex of Object.keys(THEME_NEUTRALS)) css = css.split(hex).join(`var(${THEME_NEUTRALS[hex]})`);
  const ac = accentStyleVar();
  if (ac) css = css.replace(/#3b6ef6/g, 'var(--ac)');
  const acDecl = ac ? `:root{--ac:${ac}}` : '';
  // Both palettes are always shipped so a visitor can switch client-side (the
  // choice lands on <html data-theme="…">, applied before first paint). Dark is
  // the base; data-theme="light" forces light; "auto" follows the device.
  const lightInner = THEME_LIGHT.replace(':root{', '').replace(/}$/, '');
  const theme =
    ':root{color-scheme:dark}' + THEME_DARK
    + ':root[data-theme="light"]{color-scheme:light;' + lightInner + '}'
    + ':root[data-theme="auto"]{color-scheme:light dark}'
    + '@media (prefers-color-scheme:light){:root[data-theme="auto"]{' + lightInner + '}}';
  return theme + acDecl + css;
}
// Feature 9 — mobile browser UI color: an explicit themeColor, else the accent,
// else the page background (per current theme).
function themeColorValue() {
  const t = String(getSettings().themeColor || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t;
  const ac = accentStyleVar();
  if (ac) return ac;
  return publicThemeMode() === 'light' ? '#f4f6fb' : '#0f1220';
}

function pageShell(lang, title, bodyHtml) {
  const L = PUB[lang] || PUB.en;
  const ctx = requestContext.getStore();
  const nonceAttr = ctx && ctx.cspNonce ? ` nonce="${esc(ctx.cspNonce)}"` : '';
  // Every public page fragment is generated by this server. Attach the response
  // nonce to both inline configuration blocks and external scripts so the CSP
  // remains strict without breaking encrypted shares, secrets or collaboration.
  const nonceBody = nonceAttr
    ? String(bodyHtml || '').replace(/<script(?=[\s>])/g, `<script${nonceAttr}`)
    : String(bodyHtml || '');
  const langLink = (code, label) =>
    code === lang
      ? `<span class="active">${label}</span>`
      : `<a href="?lang=${code}" data-lang="${code}" rel="nofollow">${label}</a>`;
  const langsel = `<span class="langsel" data-lang-pending-msg="${esc(
    L.langPending
  )}"><span class="langsel-ico" aria-hidden="true">🌐</span>${langLink('fr', 'FR')}${langLink('en', 'EN')}${langLink('es', 'ES')}</span>`;
  const themesel = `<select class="themesel" aria-label="${esc(L.themeLabel)}" title="${esc(L.themeLabel)}">`
    + `<option value="dark">${esc(L.themeDark)}</option>`
    + `<option value="light">${esc(L.themeLight)}</option>`
    + `<option value="auto">${esc(L.themeAuto)}</option>`
    + `</select>`;
  return `<!doctype html><html lang="${lang}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<script${nonceAttr}>(function(){var d=${JSON.stringify(publicThemeMode())};var t;try{t=localStorage.getItem('dx-theme');}catch(e){}if(t!=='light'&&t!=='dark'&&t!=='auto')t=d;document.documentElement.setAttribute('data-theme',t);})();</script>
<meta name="theme-color" content="${esc(themeColorValue())}">
<link rel="icon" href="${esc(publicLogoSrc())}">
<title>${esc(title)}</title>
<style>${publicStyleBlock()}</style>
</head><body>
<header class="brandbar"><span class="bb-name"><img class="bb-logo" src="${esc(publicLogoSrc())}" alt="">${esc(brandName())}</span><span class="brandbar-tools">${langsel}${themesel}</span></header>
${legalNoticeHtml()}
<div class="wrap">${nonceBody}</div>
<footer>${esc(L.footer)}</footer>
<script${nonceAttr}>
// Language switch: if an upload is in progress (reception page, see reception.js),
// we don't navigate immediately — that would cut the ongoing transfer. We store
// the choice (cookie) and target URL, and reception.js triggers navigation once
// the upload finishes. With no active transfer (normal page), the link navigates right away,
// as before.
(function () {
  var sel = document.querySelector('.langsel');
  var msg = sel ? sel.getAttribute('data-lang-pending-msg') : '';
  var links = document.querySelectorAll('.langsel a[data-lang]');
  Array.prototype.forEach.call(links, function (a) {
    a.addEventListener('click', function (e) {
      if (!window.__dxTransferActive) return;
      e.preventDefault();
      document.cookie = 'lang=' + this.getAttribute('data-lang') + '; Path=/; Max-Age=31536000; SameSite=Lax';
      window.__dxPendingLangUrl = this.getAttribute('href');
      Array.prototype.forEach.call(links, function (b) {
        b.classList.remove('pending');
        b.removeAttribute('title');
      });
      this.classList.add('pending');
      if (msg) this.setAttribute('title', msg);
    });
  });
})();
// Theme switch (client-side, persisted). Dark is the default; the choice is
// applied to <html data-theme> and stored under 'dx-theme'.
(function () {
  var sel = document.querySelector('.themesel');
  if (!sel) return;
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  sel.value = cur;
  sel.addEventListener('change', function () {
    var v = this.value;
    if (v !== 'light' && v !== 'auto') v = 'dark';
    try { localStorage.setItem('dx-theme', v); } catch (e) {}
    document.documentElement.setAttribute('data-theme', v);
  });
})();
</script>
</body></html>`;
}

// --- Thumbnail gallery, shared by folder and collection pages ---
// media: [{ href, src, name, kind }] with kind 'image' | 'video'.
// Sources are deferred via data-src: with a lot of files, eagerly setting
// src="…" on every <video preload="metadata"> (or every <img>) fires that many
// requests the instant the page loads — even for tiles hidden behind the List
// view — which is what made large shares feel unresponsive. GALLERY_SCRIPT
// below fills in the real src only as tiles actually scroll into view.
function galleryHtml(media, wm) {
  const wmHtml = watermarkOverlay(wm);
  const tiles = media
    .map((m) => {
      const inner = m.kind === 'video'
        ? `<span class="g-media"><video data-src="${esc(m.src)}" preload="none" muted playsinline></video><span class="g-play">▶</span>${wmHtml}</span>`
        : `<span class="g-media"><img data-src="${esc(m.src)}" alt="">${wmHtml}</span>`;
      return `<a class="g-tile" data-name="${esc(String(m.name).toLowerCase())}" href="${esc(m.href)}" target="_blank" rel="noopener" title="${esc(m.name)}">${inner}<span class="g-cap">${esc(m.name)}</span></a>`;
    })
    .join('');
  return `<div class="gallery">${tiles}</div>`;
}

// Search box + client-side filter (hides list rows and gallery tiles by name).
// Shared by folderPage and collectionPage. The card gets the class `has-search`.
function searchBox(L) {
  return `<input type="search" class="fl-search" autocomplete="off" spellcheck="false" placeholder="${esc(L.searchPh)}" aria-label="${esc(L.searchPh)}">`;
}
const SEARCH_SCRIPT = `<script>(function(){
  var card=document.querySelector('.has-search'); if(!card) return;
  var input=card.querySelector('.fl-search'); if(!input) return;
  var rows=card.querySelectorAll('[data-name]');
  var none=card.querySelector('.fl-noresult');
  function apply(){
    var q=input.value.trim().toLowerCase(), shown=0;
    Array.prototype.forEach.call(rows,function(el){
      var hit = !q || el.getAttribute('data-name').indexOf(q)!==-1;
      el.style.display = hit ? '' : 'none';
      if(hit) shown++;
    });
    if(none) none.style.display = (q && shown===0) ? '' : 'none';
  }
  input.addEventListener('input', apply);
})();</script>`;
// Feature 6 — selective multi-file download. Adds a checkbox to each row and a
// "download selection (.zip)" toolbar that POSTs the picked items to the
// share's zip-select endpoint (a hidden form → a normal browser download).
const SELECT_SCRIPT = `<script>(function(){
  var card=document.querySelector('.has-select'); if(!card) return;
  var action=card.getAttribute('data-zipsel'); if(!action) return;
  var rows=card.querySelectorAll('[data-rel],[data-idx]');
  var bar=card.querySelector('.sel-bar'); var btn=card.querySelector('.sel-zip'); var count=card.querySelector('.sel-count');
  if(!bar||!btn) return;
  Array.prototype.forEach.call(rows,function(tr){
    var td=tr.querySelector('td'); if(!td) return;
    var cb=document.createElement('input'); cb.type='checkbox'; cb.className='sel-cb'; cb.setAttribute('aria-label','select');
    td.insertBefore(cb, td.firstChild);
    cb.addEventListener('change', update);
  });
  function picked(){ return Array.prototype.filter.call(card.querySelectorAll('.sel-cb'),function(c){return c.checked;}); }
  function update(){ var n=picked().length; if(count)count.textContent=n; bar.style.display=n?'':'none'; }
  btn.addEventListener('click', function(){
    var sel=[], idx=[];
    picked().forEach(function(c){
      var tr=c.closest('[data-rel],[data-idx]'); if(!tr) return;
      if(tr.hasAttribute('data-rel')) sel.push(tr.getAttribute('data-rel'));
      else idx.push(tr.getAttribute('data-idx'));
    });
    if(!sel.length && !idx.length) return;
    var f=document.createElement('form'); f.method='POST'; f.action=action; f.style.display='none';
    function add(name,val){ var i=document.createElement('input'); i.type='hidden'; i.name=name; i.value=val; f.appendChild(i); }
    if(sel.length) add('sel', sel.join('\\n'));
    if(idx.length) add('idx', idx.join('\\n'));
    document.body.appendChild(f); f.submit();
    setTimeout(function(){ try{document.body.removeChild(f);}catch(e){} },1500);
  });
})();</script>`;
function viewToggle(L) {
  return `<div class="view-toggle" role="group">`
    + `<button type="button" class="vt-btn active" data-view="list">${esc(L.viewList)}</button>`
    + `<button type="button" class="vt-btn" data-view="gallery">${esc(L.viewGallery)}</button>`
    + `</div>`;
}
// Selection toolbar (feature 6): hidden until at least one row is ticked.
function selectBar(L) {
  return `<div class="sel-bar" style="display:none"><span class="sel-count">0</span> ${esc(L.selectedWord)}`
    + ` <button type="button" class="btn sm sel-zip">${esc(L.selectZip)}</button></div>`;
}
// Toggles List/Gallery on the card and remembers the choice (localStorage);
// also lazily assigns gallery thumbnail sources as tiles near the viewport.
const GALLERY_SCRIPT = `<script>(function(){
  var card=document.querySelector('.has-gallery'); if(!card) return;
  var btns=card.querySelectorAll('.vt-btn');
  function set(v){ card.setAttribute('data-view',v);
    Array.prototype.forEach.call(btns,function(x){x.classList.toggle('active',x.getAttribute('data-view')===v);});
    try{localStorage.setItem('dxview',v);}catch(e){} }
  Array.prototype.forEach.call(btns,function(b){ b.addEventListener('click',function(){set(b.getAttribute('data-view'));}); });
  try{ if(localStorage.getItem('dxview')==='gallery') set('gallery'); }catch(e){}

  var lazy=card.querySelectorAll('.g-media [data-src]');
  function load(el){
    var src=el.getAttribute('data-src');
    if(!src) return;
    el.src=src; el.removeAttribute('data-src');
    if(el.tagName==='VIDEO') el.preload='metadata';
  }
  if('IntersectionObserver' in window && lazy.length){
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(!entry.isIntersecting) return;
        load(entry.target);
        io.unobserve(entry.target);
      });
    }, { rootMargin:'400px 0px', threshold:0.01 });
    Array.prototype.forEach.call(lazy,function(el){ io.observe(el); });
  } else {
    Array.prototype.forEach.call(lazy,load); // no IO support: load everything upfront
  }
})();</script>`;

// Optional admin message banner shown on public download pages (feature).
function shareNoteHtml(share) {
  if (!share || !share.note) return '';
  return `<div class="inbox-note"><span class="inbox-note-ico">💬</span><div class="inbox-note-txt">${esc(share.note).replace(/\n/g, '<br>')}</div></div>`;
}

function collectionPage(lang, share, items, tk, wm) {
  const L = PUB[lang] || PUB.en;
  tk = tk || share.token; // token actually visited (main link or a recipient sub-link)
  const allowZip = zipAllowed(share);
  const media = [];
  const rows = items
    .map((it, i) => {
      if (it.type === 'folder') {
        const browse = `/s/${tk}/item/${i}/browse`;
        const zip = `/s/${tk}/item/${i}/zip`;
        const zipAct = allowZip ? `<a class="row-act" href="${esc(zip)}" rel="noopener">${esc(L.zipLabel)}</a>` : '';
        return `<tr data-name="${esc(String(it.name).toLowerCase())}" data-idx="${i}"><td class="fl-name"><span class="ico">📁</span> <a href="${esc(browse)}">${esc(it.name)}</a></td><td class="fl-size">—</td><td class="fl-act"><a class="row-act" href="${esc(browse)}">${esc(L.browseLabel)}</a>${zipAct}</td></tr>`;
      }
      const dl = `/s/${tk}/download?i=${i}`;
      const info = share.noPreview ? null : previewInfo(it.name);
      if (info && (info.kind === 'image' || info.kind === 'video')) {
        const url = `/s/${tk}/view?i=${i}`;
        media.push({ href: url, src: url, name: it.name, kind: info.kind });
      }
      const rk = share.noPreview ? null : renderKind(it.name);
      const view = rk
        ? `<a class="row-act" href="/s/${tk}/render?i=${i}" target="_blank" rel="noopener">${esc(L.preview)}</a>`
        : (info
          ? `<a class="row-act" href="/s/${tk}/view?i=${i}" target="_blank" rel="noopener">${esc(L.preview)}</a>`
          : '');
      return `<tr data-name="${esc(String(it.name).toLowerCase())}" data-idx="${i}"><td class="fl-name"><span class="ico">📄</span> ${esc(it.name)}</td><td class="fl-size">${esc(formatBytes(it.size))}</td><td class="fl-act">${view}<a class="row-act" href="${esc(dl)}" download rel="noopener">${esc(L.download)}</a></td></tr>`;
    })
    .join('');
  const hasGallery = media.length > 0;
  const hasSearch = items.length > 4;
  const hasSelect = allowZip && items.length > 1;
  const selBar = hasSelect ? selectBar(L) : '';
  const controls = `<div class="fl-controls"><span class="fl-acts">${
    allowZip ? `<a class="row-act" href="/s/${tk}/all.zip">${esc(L.downloadAllZip)}</a>` : ''
  }<a class="row-act" href="/s/${tk}/sha256">${esc(L.checksums)}</a></span>${hasGallery ? viewToggle(L) : ''}</div>${hasSearch ? searchBox(L) : ''}`;
  const body = `
<div class="card${hasGallery ? ' has-gallery' : ''}${hasSearch ? ' has-search' : ''}${hasSelect ? ' has-select' : ''}" data-view="list" data-zipsel="/s/${esc(tk)}/zip-select">
  <h1><span class="ico">📦</span>${esc(share.name)}</h1>
  <p class="muted">${items.length} ${esc(L.itemsWord)}</p>
  ${shareNoteHtml(share)}
  ${controls}
  ${selBar}
  ${hasGallery ? galleryHtml(media, wm) : ''}
  <div class="list-view"><table class="filelist"><tbody>${rows}</tbody></table></div>
  ${hasSearch ? `<p class="fl-noresult muted" style="display:none">${esc(L.noResult)}</p>` : ''}
</div>${hasGallery ? GALLERY_SCRIPT : ''}${hasSearch ? SEARCH_SCRIPT : ''}${hasSelect ? SELECT_SCRIPT : ''}`;
  return pageShell(lang, share.name, body);
}

function filePage(lang, share, downloadUrl, tk, wm) {
  const L = PUB[lang] || PUB.en;
  tk = tk || share.token; // token actually visited (main link or a recipient sub-link)
  const info = share.noPreview ? null : previewInfo(share.name);
  const viewUrl = `/s/${tk}/view`;
  const wmHtml = watermarkOverlay(wm);
  let preview = '';
  if (info && info.kind === 'image') {
    preview = `<div class="preview"><img src="${esc(viewUrl)}" alt="${esc(share.name)}" loading="lazy">${wmHtml}</div>`;
  } else if (info && info.kind === 'video') {
    preview = `<div class="preview"><video src="${esc(viewUrl)}" controls preload="metadata" playsinline onerror="this.style.display='none';var f=this.parentNode.querySelector('.vfallback');if(f)f.style.display='block';"></video>${wmHtml}<p class="vfallback muted" style="display:none">${esc(L.vidUnsupported)} <a href="${esc(downloadUrl)}" download>${esc(L.download)}</a></p></div>`;
  } else if (info && info.kind === 'audio') {
    preview = `<div class="preview preview-audio"><audio src="${esc(viewUrl)}" controls preload="metadata"></audio></div>`;
  }
  const rk = share.noPreview ? null : renderKind(share.name);
  const openBtn = rk
    ? `<a class="btn btn-ghost" href="/s/${tk}/render" target="_blank" rel="noopener">${esc(L.preview)}</a>`
    : (info && (info.kind === 'pdf' || info.kind === 'text')
      ? `<a class="btn btn-ghost" href="${esc(viewUrl)}" target="_blank" rel="noopener">${esc(L.preview)}</a>`
      : '');
  const body = `
<div class="card">
  <h1><span class="ico">📄</span>${esc(share.name)}</h1>
  <p class="muted">${esc(L.size)} : ${formatBytes(share.size)}</p>
  ${shareNoteHtml(share)}
  ${preview}
  <div class="file-actions">${openBtn}<a class="btn" href="${esc(downloadUrl)}" download rel="noopener">${esc(L.download)}</a></div>
  <p class="file-sums"><a class="row-act" href="/s/${tk}/sha256">${esc(L.checksums)}</a></p>
</div>`;
  return pageShell(lang, share.name, body);
}

// Public page for an end-to-end-encrypted download share: the ciphertext is
// fetched and decrypted entirely in the visitor's browser (dxdecrypt.js).
function encDecryptPage(lang, share, token) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    token: token || share.token,
    mode: share.encMode || 'key',
    strings: {
      working: L.encDlWorking, downloading: L.encDlDownloading,
      badKey: L.encDlBadKey, keyMissing: L.encDlKeyMissing, ready: L.encDlReady,
    },
  };
  const passField = share.encMode === 'pass'
    ? `<label class="up-msg-label" for="enc-pass">${esc(L.encDlPassLabel)}</label>`
      + `<input type="password" id="enc-pass" class="up-msg" autocomplete="off">`
    : '';
  const body = `
<div class="card">
  <div class="enc-banner"><span class="enc-ico">🔒</span><span>${esc(L.encDlIntro)}</span></div>
  <h1><span class="ico">🔒</span>${esc(share.name)}</h1>
  ${passField}
  <button type="button" id="enc-go" class="btn block">${esc(L.encDlBtn)}</button>
  <div class="upbar enc-bar-wrap" id="enc-barwrap" style="display:none"><i id="enc-bar"></i></div>
  <p id="enc-status" class="up-limits muted"></p>
</div>
<script>window.DX_ENC=${jsonForScript(cfg)};</script>
<script src="/dxcrypto.js"></script>
<script src="/dxdecrypt.js"></script>`;
  return pageShell(lang, share.name, body);
}

// Feature 5 — burn-after-read secret page. The ciphertext is fetched once (which
// burns it server-side) and decrypted entirely in the browser (dxsecret.js).
function secretPage(lang, token, mode) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    token,
    mode: mode || 'key',
    strings: {
      working: L.secretWorking, badKey: L.secretBadKey, keyMissing: L.secretKeyMissing,
      gone: L.secretGone, copied: L.copied, copy: L.secretCopy, oneShot: L.secretOneShot,
    },
  };
  const passField = mode === 'pass'
    ? `<label class="up-msg-label" for="secret-pass">${esc(L.secretPassLabel)}</label>`
      + `<input type="password" id="secret-pass" class="up-msg" autocomplete="off" placeholder="${esc(L.secretPassPh)}">`
    : '';
  const body = `
<div class="card">
  <div class="enc-banner"><span class="enc-ico">🔥</span><span>${esc(L.secretIntro)}</span></div>
  <h1><span class="ico">🔑</span>${esc(L.secretTitle)}</h1>
  ${passField}
  <button type="button" id="secret-go" class="btn block">${esc(L.secretReveal)}</button>
  <textarea id="secret-out" class="up-msg secret-out" rows="4" readonly style="display:none"></textarea>
  <button type="button" id="secret-copy" class="btn ghost sm" style="display:none">${esc(L.secretCopy)}</button>
  <p id="secret-status" class="up-limits muted"></p>
</div>
<script>window.DX_SECRET=${jsonForScript(cfg)};</script>
<script src="/dxcrypto.js"></script>
<script src="/dxsecret.js"></script>`;
  return pageShell(lang, L.secretTitle, body);
}

function buildCrumbs(share, relSub, browseBase) {
  const parts = relSub ? relSub.split('/').filter(Boolean) : [];
  const items = [`<a href="${esc(browseBase)}">${esc(share.name)}</a>`];
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    items.push(`<a href="${esc(browseBase + '/' + encodePath(acc))}">${esc(p)}</a>`);
  }
  return items.join(' / ');
}

function folderPage(lang, share, relSub, entries, links, wm) {
  const L = PUB[lang] || PUB.en;
  const crumbHtml = buildCrumbs(share, relSub, links.browseBase);
  const media = [];
  const rows = entries
    .map((e) => {
      if (e.isDir) {
        return `<tr data-name="${esc(String(e.name).toLowerCase())}" data-rel="${esc(e.rel)}"><td><span class="ico">📁</span><a href="${esc(links.browse(e.rel))}">${esc(
          e.name
        )}</a></td><td class="size">—</td><td class="fl-act"></td></tr>`;
      }
      const info = share.noPreview ? null : previewInfo(e.name);
      let previewLink = '';
      if (info && (info.kind === 'image' || info.kind === 'video')) {
        const url = links.file(e.rel) + '?view=1'; // inline (not attachment) for thumbnails
        media.push({ href: url, src: url, name: e.name, kind: info.kind });
      }
      const rk = share.noPreview ? null : renderKind(e.name);
      if (rk) {
        const url = links.file(e.rel) + '?render=1';
        previewLink = `<a class="row-act" href="${esc(url)}" target="_blank" rel="noopener">${esc(L.preview)}</a>`;
      } else if (info) {
        const url = links.file(e.rel) + '?view=1';
        previewLink = `<a class="row-act" href="${esc(url)}" target="_blank" rel="noopener">${esc(L.preview)}</a>`;
      }
      return `<tr data-name="${esc(String(e.name).toLowerCase())}" data-rel="${esc(e.rel)}"><td><span class="ico">📄</span>${esc(e.name)}</td><td class="size">${formatBytes(
        e.size
      )}</td><td class="fl-act">${previewLink}<a class="row-act" href="${esc(
        links.file(e.rel)
      )}" download rel="noopener">${esc(L.download)}</a></td></tr>`;
    })
    .join('');
  const emptyRow = entries.length
    ? ''
    : `<tr><td colspan="3" class="muted">${esc(L.emptyFolder)}</td></tr>`;
  const zipBtn = zipAllowed(share)
    ? `<a class="btn sm" href="${esc(links.zip(relSub))}" rel="noopener">${esc(L.downloadAllZip)}</a>`
    : '<span></span>';
  const hasGallery = media.length > 0;
  const hasSearch = entries.length > 4;
  const hasPlayable = !share.noPreview && entries.some((e) => {
    if (e.isDir) return false;
    const i = previewInfo(e.name);
    return i && (i.kind === 'video' || i.kind === 'audio');
  });
  const playerUrl = (relSub ? links.browse(relSub) : links.browseBase) + '?player=1';
  const playerBtn = hasPlayable ? `<a class="row-act" href="${esc(playerUrl)}">${esc(L.playerLabel)}</a>` : '';
  const sumsBtn = `<a class="row-act" href="${esc(links.sha256(relSub))}">${esc(L.checksums)}</a>`;
  const hasSelect = zipAllowed(share) && entries.length > 1;
  const selBar = hasSelect ? selectBar(L) : '';
  const controls = `<div class="fl-controls"><span class="fl-acts">${zipBtn}${sumsBtn}${playerBtn}</span>${hasGallery ? viewToggle(L) : ''}</div>${hasSearch ? searchBox(L) : ''}`;
  const body = `
<div class="card${hasGallery ? ' has-gallery' : ''}${hasSearch ? ' has-search' : ''}${hasSelect ? ' has-select' : ''}" data-view="list" data-zipsel="${esc(links.zip(relSub).replace(/\/zip(\/|$).*/, '/zip-select'))}">
  <h1><span class="ico">📁</span>${esc(share.name)}</h1>
  <p class="crumbs">${crumbHtml}</p>
  ${relSub ? '' : shareNoteHtml(share)}
  ${controls}
  ${selBar}
  ${hasGallery ? galleryHtml(media, wm) : ''}
  <div class="list-view"><table>
    <thead><tr><th>${esc(L.name)}</th><th>${esc(L.size)}</th><th></th></tr></thead>
    <tbody>${rows}${emptyRow}</tbody>
  </table></div>
  ${hasSearch ? `<p class="fl-noresult muted" style="display:none">${esc(L.noResult)}</p>` : ''}
</div>${hasGallery ? GALLERY_SCRIPT : ''}${hasSearch ? SEARCH_SCRIPT : ''}${hasSelect ? SELECT_SCRIPT : ''}`;
  return pageShell(lang, share.name, body);
}

function errorPage(lang, code, message) {
  const body = `
<div class="card">
  <h1>${esc(code)}</h1>
  <p class="muted">${esc(message)}</p>
</div>`;
  return pageShell(lang, String(code), body);
}

// Public image gallery (feature 18): a lightweight, theme-aware grid of an
// album's member images. Each thumbnail links to the full-size image. All URLs
// are same-origin (/i/<token>…) so they always load and stay hotlink-safe.
function albumPage(lang, album, members, req) {
  const L = PUB[lang] || PUB.en;
  const title = album.name || (L.albumTitle || 'Gallery');
  const cells = members.map((m) => {
    const full = '/i/' + m.token + '/auto?w=1920';
    const thumb = '/i/' + m.token + '/auto?w=480';
    const privacy = m.metadataRemoved ? `<span class="gal-privacy">🛡 ${esc(L.photoMetadataRemoved || 'EXIF/GPS removed')}</span>` : '';
    return `<a class="gal-cell" href="${esc(full)}" target="_blank" rel="noopener" title="${esc(m.name || '')}">`
      + `<img loading="lazy" src="${esc(thumb)}" alt="${esc(m.name || '')}">${privacy}</a>`;
  }).join('');
  const countTxt = (L.albumCount || '{n} images').replace('{n}', members.length);
  const body = `
<style>
  .gal-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  .gal-head h1 { margin:0; font-size:1.4rem; word-break:break-word; }
  .gallery-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .gal-cell { position:relative; display:block; aspect-ratio:1/1; border-radius:10px; overflow:hidden; background:var(--card-2,rgba(127,127,127,.12)); }
  .gal-cell img { width:100%; height:100%; object-fit:cover; display:block; transition:transform .2s ease; }
  .gal-cell:hover img { transform:scale(1.05); }
  .gal-privacy { position:absolute; left:7px; bottom:7px; max-width:calc(100% - 14px); padding:4px 7px; border-radius:999px; background:rgba(8,24,18,.86); color:#d9ffe9; font-size:.72rem; font-weight:700; line-height:1.2; }
  .gal-empty { text-align:center; padding:36px 0; }
</style>
<div class="card">
  <div class="gal-head"><h1>${esc(title)}</h1><span class="muted">${esc(countTxt)}</span></div>
  ${members.length ? `<div class="gallery-grid">${cells}</div>` : `<p class="gal-empty muted">${esc(L.albumEmpty || 'No images.')}</p>`}
</div>`;
  return pageShell(lang, title, body);
}

// Human-readable summary of a reception link's limits (for the public page).
// The "files left" and "quota left" segments are wrapped in spans with fixed
// ids (up-limit-files / up-limit-quota) so reception.js can refresh just
// those numbers after each upload, instead of only reflecting the counts at
// the time the page was first rendered. Each part is pre-escaped here since
// the caller now inserts the joined string as raw HTML (to allow the spans).
function inboxLimitsText(L, s) {
  const parts = [];
  if (s.maxFileBytes > 0) parts.push(esc(L.limitPerFile.replace('{v}', formatBytes(s.maxFileBytes))));
  if (s.maxTotalBytes > 0) {
    const left = Math.max(0, s.maxTotalBytes - (s.bytesReceived || 0));
    const txt = L.limitQuota.replace('{v}', formatBytes(left)).replace('{t}', formatBytes(s.maxTotalBytes));
    parts.push(`<span id="up-limit-quota">${esc(txt)}</span>`);
  }
  if (s.maxFiles > 0) {
    const txt = L.limitFiles.replace('{v}', Math.max(0, s.maxFiles - (s.downloads || 0))).replace('{t}', s.maxFiles);
    parts.push(`<span id="up-limit-files">${esc(txt)}</span>`);
  }
  if (Array.isArray(s.allowExt) && s.allowExt.length) parts.push(esc(L.limitAllow.replace('{v}', s.allowExt.join(', '))));
  if (Array.isArray(s.blockExt) && s.blockExt.length) parts.push(esc(L.limitBlock.replace('{v}', s.blockExt.join(', '))));
  return parts.join(' · ');
}

// Feature 3 — playlist player for the audio/video files of a folder. Auto-loads
// sibling subtitles (.vtt/.srt) for videos and auto-advances through the list.
function mediaPlayerPage(lang, share, entries, links, wm) {
  const L = PUB[lang] || PUB.en;
  const relByName = new Map(entries.filter((e) => !e.isDir).map((e) => [e.name, e.rel]));
  const items = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const info = previewInfo(e.name);
    if (!info || (info.kind !== 'video' && info.kind !== 'audio')) continue;
    const subs = info.kind === 'video'
      ? subtitleTracksFor(e.name, entries).map((tr) => ({
          src: links.file(relByName.get(tr.name)) + '?vtt=1', label: tr.label, lang: tr.lang || 'und',
        }))
      : [];
    items.push({ name: e.name, src: links.file(e.rel) + '?view=1', dl: links.file(e.rel), kind: info.kind, subs });
  }
  const cfg = { items, strings: { subsOff: L.subsOff } };
  const backUrl = links.browseBase;
  if (!items.length) {
    const empty = `<div class="card"><h1><span class="ico">🎬</span>${esc(share.name)}</h1>`
      + `<p class="muted">${esc(L.noMedia)}</p><div class="file-actions"><a class="btn" href="${esc(backUrl)}">${esc(L.backToFiles)}</a></div></div>`;
    return pageShell(lang, share.name, empty);
  }
  const list = items.map((m, i) =>
    `<li class="dxp-track" data-i="${i}"><span class="dxp-ico">${m.kind === 'video' ? '🎬' : '🎵'}</span><span class="dxp-name">${esc(m.name)}</span></li>`
  ).join('');
  const body = `
<div class="card render-card">
  <h1><span class="ico">▶</span>${esc(share.name)}</h1>
  <div class="dxp-stage">
    <video id="dxp-video" controls playsinline preload="metadata"></video>
    ${watermarkOverlay(wm)}
  </div>
  <p id="dxp-now" class="muted dxp-now"></p>
  <ol class="dxp-list">${list}</ol>
  <div class="file-actions"><a class="btn btn-ghost" href="${esc(backUrl)}">${esc(L.backToFiles)}</a><a id="dxp-dl" class="btn" download rel="noopener">${esc(L.download)}</a></div>
</div>
<script>window.DX_PLAYER=${jsonForScript(cfg)};</script>
<script src="/dxplayer.js"></script>`;
  return pageShell(lang, share.name, body);
}

// Public reception page (file upload by the visitor).
function inboxPage(lang, share) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    maxFiles: share.maxFiles || 0,
    maxFileBytes: share.maxFileBytes || 0,
    maxTotalBytes: share.maxTotalBytes || 0,
    bytesReceived: share.bytesReceived || 0,
    filesReceived: share.downloads || 0,
    allowExt: Array.isArray(share.allowExt) ? share.allowExt : [],
    blockExt: Array.isArray(share.blockExt) ? share.blockExt : [],
    // Localized templates, reused client-side to refresh the "left" counts
    // in place after each upload instead of just reflecting page-load values.
    limitFilesTpl: L.limitFiles,
    limitQuotaTpl: L.limitQuota,
    enc: share.encrypted ? { on: true, mode: share.encMode || 'key' } : null,
    encStrings: share.encrypted ? { encrypting: L.encEncrypting, passRequired: L.encPassRequired, keyMissing: L.encKeyMissing } : null,
    groupBySender: !!share.groupBySender, // ask the visitor for a name → per-sender subfolder
    folderStrings: {
      prompt: L.newFolderPrompt, created: L.folderCreated, fail: L.folderCreateFail,
      invalid: L.folderInvalid, exists: L.folderExists, busy: L.folderBusy,
      destination: L.uploadDestination,
    },
  };
  const accept = cfg.allowExt.length ? ` accept="${esc(cfg.allowExt.map((e) => '.' + e).join(','))}"` : '';
  const limits = inboxLimitsText(L, share);
  const limitsHtml = limits ? `<p class="up-limits muted">${limits}</p>` : '';
  // Admin instructions shown to the visitor (multi-line, plain text).
  const noteHtml = share.note
    ? `<div class="inbox-note"><span class="inbox-note-ico">💬</span><div class="inbox-note-txt">${esc(share.note).replace(/\n/g, '<br>')}</div></div>`
    : '';
  // End-to-end encryption banner + (passphrase mode) a passphrase field.
  const encHtml = share.encrypted
    ? `<div class="enc-banner"><span class="enc-ico">🔒</span><span>${esc(L.encInboxBanner)}</span></div>`
      + (share.encMode === 'pass'
        ? `<label class="up-msg-label" for="up-passphrase">${esc(L.encPassLabel)}</label>`
          + `<input type="password" id="up-passphrase" class="up-msg" autocomplete="off" placeholder="${esc(L.encPassPh)}">`
        : '')
    : '';
  const cryptoScript = share.encrypted ? '<script src="/dxcrypto.js"></script>' : '';
  const body = `
<div class="card inbox-card">
  <div class="inbox-head">
    <span class="inbox-badge">📥</span>
    <div class="inbox-head-txt">
      <h1>${esc(share.name)}</h1>
      <p class="muted">${esc(L.inboxIntro)}</p>
    </div>
  </div>
  ${noteHtml}
  ${encHtml}
  ${share.groupBySender ? `<label class="up-msg-label" for="up-sender">${esc(L.senderLabel)}</label><input type="text" id="up-sender" class="up-msg" maxlength="60" autocomplete="name" placeholder="${esc(L.senderPh)}">` : ''}
  <label class="up-drop" id="up-drop">
    <input type="file" id="up-input" multiple hidden${accept}>
    <span class="up-drop-ico">⬆</span>
    <span class="up-drop-title">${esc(L.inboxHint)}</span>
    <span class="up-drop-sub">${esc(L.inboxHint2)}</span>
  </label>
  <input type="file" id="up-input-dir" webkitdirectory directory multiple hidden>
  <div class="up-modes">
    <button type="button" id="up-pick-files" class="btn ghost sm">${esc(L.inboxPickFiles)}</button>
    <button type="button" id="up-pick-dir" class="btn ghost sm">${esc(L.inboxPickFolder)}</button>
    <button type="button" id="up-new-folder" class="btn ghost sm">${esc(L.newFolder)}</button>
  </div>
  <p id="up-folder-current" class="up-folder-current" hidden></p>
  ${limitsHtml}
  <div id="up-list-tools" class="up-list-tools" hidden>
    <span id="up-list-count" class="up-list-count muted"></span>
    <button type="button" id="up-clear" class="btn ghost sm"></button>
  </div>
  <div id="up-list" class="up-list"></div>
  <label class="up-msg-label" for="up-message">${esc(L.msgLabel)}</label>
  <textarea id="up-message" class="up-msg" rows="2" maxlength="2000" placeholder="${esc(L.msgPh)}"></textarea>
  <button type="button" id="up-send" class="btn block" disabled>${esc(L.inboxSend)}</button>
</div>
<script>window.DX_INBOX=${jsonForScript(cfg)};</script>
${cryptoScript}
<script src="/reception.js"></script>`;
  return pageShell(lang, share.name, body);
}

// Collaboration page: a live, two-way shared folder. The visitor browses/downloads
// the current contents (fetched from /c/:token/list and refreshed live), uploads
// new files (chunked, resumable — same protocol as reception links) and, when the
// link allows it, deletes items. Driven by /dxcollab.js.
function collabPage(lang, share) {
  const L = PUB[lang] || PUB.en;
  const cfg = {
    token: share.token,
    allowDelete: !!share.allowDelete,
    allowZip: share.allowZip !== false,
    maxFileBytes: share.maxFileBytes || 0,
    maxTotalBytes: share.maxTotalBytes || 0,
    maxFiles: share.maxFiles || 0,
    allowExt: Array.isArray(share.allowExt) ? share.allowExt : [],
    blockExt: Array.isArray(share.blockExt) ? share.blockExt : [],
    strings: {
      download: L.download, del: L.collabDelete, delConfirm: L.collabDeleteConfirm,
      deleted: L.collabDeleted, delFail: L.collabDeleteFail, uploaded: L.collabUploaded,
      uploadFail: L.collabUploadFail, parent: L.collabParent, refresh: L.collabRefresh,
      empty: L.emptyFolder, home: L.collabHome, name: L.name, size: L.size,
      error: L.readError, quota: L.limitQuota, newFolder: L.newFolder,
      folderPrompt: L.newFolderPrompt, folderCreated: L.folderCreated,
      folderFail: L.folderCreateFail, folderInvalid: L.folderInvalid,
      folderExists: L.folderExists, folderBusy: L.folderBusy,
    },
  };
  const accept = cfg.allowExt.length ? ` accept="${esc(cfg.allowExt.map((e) => '.' + e).join(','))}"` : '';
  const limits = inboxLimitsText(L, share);
  const limitsHtml = limits ? `<p class="up-limits muted">${limits}</p>` : '';
  const noteHtml = share.note
    ? `<div class="inbox-note"><span class="inbox-note-ico">💬</span><div class="inbox-note-txt">${esc(share.note).replace(/\n/g, '<br>')}</div></div>`
    : '';
  const zipBtn = cfg.allowZip
    ? `<a class="btn ghost sm" id="cl-zip" href="/c/${esc(share.token)}/zip" rel="noopener">${esc(L.downloadAllZip)}</a>` : '';
  const sumsBtn = `<a class="btn ghost sm" href="/c/${esc(share.token)}/sha256" rel="noopener">${esc(L.checksums)}</a>`;
  const body = `
<div class="card collab-card">
  <div class="inbox-head">
    <span class="inbox-badge">🔁</span>
    <div class="inbox-head-txt">
      <h1>${esc(share.name)}</h1>
      <p class="muted">${esc(L.collabIntro)}</p>
    </div>
  </div>
  ${noteHtml}
  <div class="collab-bar">
    <p class="crumbs" id="cl-crumbs"></p>
    <div class="collab-bar-actions">${zipBtn}${sumsBtn}<button type="button" id="cl-new-folder" class="btn ghost sm">${esc(L.newFolder)}</button><button type="button" id="cl-refresh" class="btn ghost sm">${esc(L.collabRefresh)}</button></div>
  </div>
  <div id="cl-list" class="collab-list"></div>
  ${limitsHtml}
  <label class="up-drop" id="up-drop">
    <input type="file" id="up-input" multiple hidden${accept}>
    <span class="up-drop-ico">⬆</span>
    <span class="up-drop-title">${esc(L.inboxHint)}</span>
    <span class="up-drop-sub">${esc(L.inboxHint2)}</span>
  </label>
  <input type="file" id="up-input-dir" webkitdirectory directory multiple hidden>
  <div class="up-modes">
    <button type="button" id="up-pick-files" class="btn ghost sm">${esc(L.inboxPickFiles)}</button>
    <button type="button" id="up-pick-dir" class="btn ghost sm">${esc(L.inboxPickFolder)}</button>
  </div>
  <div id="up-list" class="up-list"></div>
</div>
<script>window.DX_COLLAB=${jsonForScript(cfg)};</script>
<script src="/dxcollab.js"></script>`;
  return pageShell(lang, share.name, body);
}

// Password entry page for a protected link.
function passwordPage(lang, s, error, token) {
  const L = PUB[lang] || PUB.en;
  // Use the token actually being visited: a nominative sub-link keeps its own
  // token through the unlock, so downloads stay attributed to that recipient.
  const rel = linkPrefix(s) + (token || s.token);
  const body = `
<div class="card">
  <h1><span class="ico">🔒</span>${esc(s.name)}</h1>
  <p class="muted">${esc(L.pwPrompt)}</p>
  ${error ? `<p class="err">${esc(L.pwWrong)}</p>` : ''}
  <form method="post" action="${esc(rel)}/unlock">
    <input class="pw" type="password" name="password" required autofocus placeholder="${esc(L.pwField)}">
    <button class="btn" type="submit">${esc(L.pwSubmit)}</button>
  </form>
</div>`;
  return pageShell(lang, s.name, body);
}

// Feature 7 — interstitial shown before a large download when the visitor has no
// valid proof-of-work pass. /dxpow.js solves the challenge in the browser and
// reloads the page (the pass rides in a cookie), continuing to the download.
function challengePage(lang) {
  const L = PUB[lang] || PUB.en;
  const body = `
<div class="card">
  <h1><span class="ico">🛡️</span>${esc(L.chalTitle)}</h1>
  <p class="muted">${esc(L.chalIntro)}</p>
  <div class="upbar enc-bar-wrap" id="pow-barwrap"><i id="pow-bar" style="width:0"></i></div>
  <p id="pow-status" class="up-limits muted" data-verify="${esc(L.chalVerify)}" data-fail="${esc(L.chalFail)}">${esc(L.chalWorking)}</p>
  <noscript><p class="err">${esc(L.chalNoJs)}</p></noscript>
</div>
<script src="/dxpow.js"></script>`;
  return pageShell(lang, L.chalTitle, body);
}

// ===================================================================
//  PUBLIC ROUTES: download (no authentication)
// ===================================================================

const downloadRouter = express.Router();

// Stores an explicit language choice (?lang=xx) in a cookie, to keep
// the language while browsing a shared folder.
downloadRouter.use((req, res, next) => {
  // Token-bearing public pages and JSON responses can reveal share names and
  // metadata. Individual immutable image routes explicitly override this.
  res.setHeader('Cache-Control', 'no-store');
  const q = String((req.query && req.query.lang) || '').toLowerCase();
  if (['fr', 'en', 'es'].includes(q)) {
    res.setHeader('Set-Cookie', `lang=${q}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  next();
});

// Feature 7 — per-IP rate limit on actual transfer requests (downloads, uploads,
// zips). Landing pages and inline previews (/view, thumbnails) are not counted so
// browsing a gallery never trips it; the proof-of-work endpoints are exempt too.
downloadRouter.use((req, res, next) => {
  const p = req.path;
  if (p.startsWith('/dx/')) return next(); // never throttle solving the challenge
  const isTransfer =
    /\/(download|enc|upload)(?:\/|$)/.test(p) ||
    /\/file\//.test(p) ||
    /(?:^|\/)zip(?:\/|$)/.test(p) ||
    /\.zip$/.test(p) ||
    /^\/c\/[^/]+\/(list|delete|folder)$/.test(p) || // collab control endpoints
    /^\/u\/[^/]+\/folder$/.test(p); // reception folder creation
  if (!isTransfer) return next();
  const retry = publicRateRetryAfter(req);
  if (!retry) return next();
  res.setHeader('Retry-After', String(retry));
  // JSON for fetch/XHR endpoints (uploads, collab list/delete); an HTML page for
  // plain browser file navigations.
  if (req.method === 'POST' || /^\/c\/[^/]+\/list$/.test(p)) {
    return res.status(429).json({ error: 'rate-limited', retryAfter: retry });
  }
  const lang = pickLang(req);
  const L = PUB[lang] || PUB.en;
  return res.status(429).type('html').send(errorPage(lang, 429, L.tooManyReq));
});

// Feature 11 — per-link geo/IP access rules, enforced centrally for every /s, /u
// and /c sub-path so a download/upload endpoint can't be hit directly to bypass it.
downloadRouter.use(async (req, res, next) => {
  const m = /^\/(s|u|c)\/([^/]+)/.exec(req.path);
  if (!m) return next();
  const s = getByToken(m[2]);
  if (!s || !hasAccessRules(s)) return next();
  let reason = null;
  try { reason = await linkAccessReason(req, s); }
  catch (_) { reason = s.geoMode === 'allow' ? 'geo' : null; }
  if (!reason) return next();
  const p = req.path;
  if (req.method === 'POST' || /\/(list|upload|upload-status|delete)(?:\/|$)/.test(p)) {
    return res.status(403).json({ error: 'access-denied' });
  }
  const lang = pickLang(req);
  const L = PUB[lang] || PUB.en;
  return res.status(403).type('html').send(errorPage(lang, 403, L.accessDenied || 'Access denied.'));
});

// Feature 7 — proof-of-work endpoints (public, no token). GET issues a signed
// challenge; POST verifies the browser's solution and sets the short-lived pass
// cookie. Registered before /s and /u so they never shadow these.
const powJsonParser = express.json({ limit: '4kb' });
downloadRouter.get('/dx/pow', (req, res) => {
  const bits = powBits();
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + 120000; // 2 minutes to solve
  res.setHeader('Cache-Control', 'no-store');
  res.json({ nonce, bits, exp, sig: powSign([nonce, String(exp), String(bits), powIpKey(req)]) });
});
downloadRouter.post('/dx/pow/verify', powJsonParser, (req, res) => {
  const b = req.body || {};
  const nonce = String(b.nonce || ''), exp = String(b.exp || ''), bits = String(b.bits || ''), sig = String(b.sig || ''), sol = String(b.sol || '');
  if (!nonce || !exp || !bits || !sig) return res.status(400).json({ error: 'bad-request' });
  if (Date.now() > Number(exp)) return res.status(400).json({ error: 'expired' });
  if (!timingSafeEqualStr(sig, powSign([nonce, exp, bits, powIpKey(req)]))) return res.status(400).json({ error: 'bad-sig' });
  const nb = Math.min(24, Math.max(8, Number(bits) || 16));
  if (!powSolutionOk(nonce, sol, nb)) return res.status(400).json({ error: 'bad-solution' });
  issuePowCookie(req, res);
  res.json({ ok: true });
});

function sendError(req, res, code, key) {
  const lang = pickLang(req);
  const L = PUB[lang] || PUB.en;
  res.status(code).type('html').send(errorPage(lang, code, L[key] || key));
}

function requireActiveShare(req, res) {
  const s = getByToken(req.params.token);
  // Scheduled (deferred activation): not yet live — say when, instead of "gone".
  if (s && isScheduled(s)) {
    const lang = pickLang(req);
    const L = PUB[lang] || PUB.en;
    const when = new Date(s.startsAt).toLocaleString(lang);
    res.status(403).type('html').send(errorPage(lang, 403, (L.notYetActive || 'Not available yet.') + ' — ' + when));
    return null;
  }
  if (!s || !isActive(s)) {
    sendError(req, res, 404, 'shareGone');
    return null;
  }
  if (s.pwHash && !isUnlocked(req, s)) {
    res.status(401).type('html').send(passwordPage(pickLang(req), s, false, req.params.token));
    return null;
  }
  if (!recordAndCheckVisitor(s, req)) { // feature 5: N-distinct-visitor cap reached
    sendError(req, res, 404, 'shareGone');
    return null;
  }
  // Feature 16 — per-recipient overrides on a nominative sub-link (own expiry /
  // download cap, on top of the share's). Only applies when visited via a
  // recipient token.
  const rc = recipientByToken.get(req.params.token);
  if (rc && rc.recipient) {
    const r = rc.recipient;
    if (r.expiresAt && Date.now() >= r.expiresAt) { sendError(req, res, 404, 'shareGone'); return null; }
    if (r.maxDownloads > 0 && ((r.stats && r.stats.completed) || 0) >= r.maxDownloads) { sendError(req, res, 404, 'shareGone'); return null; }
  }
  return s;
}

// Feature 5 — track distinct (masked) visitor IPs and enforce a per-link cap.
// Returns false (and revokes the share) once a NEW visitor arrives beyond the
// limit; an IP already counted always passes, so a visitor keeps their access.
function recordAndCheckVisitor(s, req) {
  const cap = Math.max(0, Math.floor(Number(s.maxVisitors) || 0));
  if (cap <= 0) return true; // unlimited
  const ip = maskIp(clientIp(req));
  if (!Array.isArray(s.visitors)) s.visitors = [];
  if (s.visitors.includes(ip)) return true; // already one of the counted visitors
  if (s.visitors.length >= cap) { // this new visitor would exceed the cap → revoke
    if (!s.revoked) {
      s.revoked = true;
      s.burnedAt = Date.now();
      logAudit('share-visitor-limit', { username: 'system', detail: (s.type || 'share') + ' ' + (s.name || '') + ` (${cap} visitors)` });
      persist();
    }
    return false;
  }
  s.visitors.push(ip);
  scheduleFlush();
  return true;
}

// Distinct-visitor set is bounded so a scraped/leaked link can't grow shares.json
// without limit; the unique-visitor count saturates at this many.
const VISITORS_MAX = 20000;
function recordVisitorIp(s, ip) {
  if (!Array.isArray(s.visitors)) s.visitors = [];
  if (s.visitors.includes(ip)) return false;
  if (s.visitors.length < VISITORS_MAX) s.visitors.push(ip);
  return true;
}
// A "view" = one load of a link's public landing page (any link type). Bumps the
// total view count AND records the distinct (masked) visitor IP. Called only at
// the landing GET, so downloads / previews / range chunks don't inflate the count.
function bumpViews(s, req) {
  if (!s) return;
  s.views = (s.views || 0) + 1;
  recordVisitorIp(s, maskIp(clientIp(req)));
  scheduleFlush();
}

// Safe in-browser preview: maps a file extension to a renderable kind + MIME.
// Excludes anything scriptable (html, svg, ...) — those stay download-only.
function previewInfo(filename) {
  const ext = (String(filename).split('.').pop() || '').toLowerCase();
  const images = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
  const videos = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska' };
  const audios = { mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac' };
  const texts = ['txt', 'md', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'js', 'mjs', 'cjs', 'ts', 'css', 'py', 'sh', 'bash', 'c', 'h', 'cpp', 'hpp', 'cc', 'java', 'go', 'rs', 'rb', 'php', 'sql', 'toml'];
  if (images[ext]) return { kind: 'image', contentType: images[ext] };
  if (videos[ext]) return { kind: 'video', contentType: videos[ext] };
  if (audios[ext]) return { kind: 'audio', contentType: audios[ext] };
  if (ext === 'pdf') return { kind: 'pdf', contentType: 'application/pdf' };
  if (texts.includes(ext)) return { kind: 'text', contentType: 'text/plain; charset=utf-8' };
  return null;
}

// Photos tab helpers. An image content type (or null if the file isn't a
// supported image), and a clean lowercase extension for the direct /i/<token>.ext
// URL (jpeg → jpg; unknown → jpg).
function imageContentType(filename) {
  const info = previewInfo(filename);
  return info && info.kind === 'image' ? info.contentType : null;
}
function photoExt(s) {
  const e = (String((s && s.name) || '').split('.').pop() || '').toLowerCase();
  if (e === 'jpeg') return 'jpg';
  return /^(jpg|png|gif|webp|bmp|avif)$/.test(e) ? e : 'jpg';
}

// Reads pixel dimensions from an image file's header — no image library needed.
// Supports PNG, JPEG, GIF, WEBP and BMP; returns { w, h } or null (e.g. AVIF).
function imageDimensions(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n < 24) return null;
    const b = buf.subarray(0, n);
    // PNG: 8-byte signature, then IHDR width/height (big-endian uint32) at 16/20.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    }
    // GIF: "GIF8", logical screen width/height (little-endian uint16) at 6/8.
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
      return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    }
    // BMP: "BM", 32-bit width/height at 18/22 (height may be stored negative).
    if (b[0] === 0x42 && b[1] === 0x4d) {
      return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
    }
    // WEBP: "RIFF"...."WEBP" then a VP8 / VP8L / VP8X chunk.
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8 ' && n >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L' && n >= 25) {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X' && n >= 30) {
        return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
      }
      return null;
    }
    // JPEG: walk the segment markers to a Start-Of-Frame; dims are big-endian at +5/+7.
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o + 9 < n) {
        if (b[o] !== 0xff) { o++; continue; }
        let marker = b[o + 1];
        while (marker === 0xff && o + 1 < n) { o++; marker = b[o + 1]; }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
        }
        const len = b.readUInt16BE(o + 2);
        if (len < 2) return null;
        o += 2 + len;
      }
      return null;
    }
    return null;
  } catch (_) { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
}

// Reads a privacy-conscious subset of EXIF/GPS metadata without an image library.
// The parser is deliberately bounded and defensive: only TIFF data embedded in
// JPEG APP1, PNG eXIf or WEBP EXIF chunks is inspected, and malformed offsets are
// ignored instead of escaping the file buffer.
function parseExifTiff(tiff) {
  if (!Buffer.isBuffer(tiff) || tiff.length < 8) return null;
  const little = tiff.toString('ascii', 0, 2) === 'II';
  const big = tiff.toString('ascii', 0, 2) === 'MM';
  if (!little && !big) return null;
  const u16 = (o) => {
    if (o < 0 || o + 2 > tiff.length) return null;
    return little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o);
  };
  const i32 = (o) => {
    if (o < 0 || o + 4 > tiff.length) return null;
    return little ? tiff.readInt32LE(o) : tiff.readInt32BE(o);
  };
  const u32 = (o) => {
    if (o < 0 || o + 4 > tiff.length) return null;
    return little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o);
  };
  if (u16(2) !== 42) return null;

  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const groups = { root: {}, exif: {}, gps: {} };
  const seen = new Set();

  function readValue(entry, type, count) {
    const unit = typeSize[type];
    if (!unit || !Number.isFinite(count) || count < 0 || count > 4096) return null;
    const bytes = unit * count;
    const valueOffset = bytes <= 4 ? entry + 8 : u32(entry + 8);
    if (valueOffset === null || valueOffset < 0 || valueOffset + bytes > tiff.length) return null;
    if (type === 2) return tiff.toString('utf8', valueOffset, valueOffset + bytes).replace(/\0+$/g, '').trim();
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const o = valueOffset + i * unit;
      let value = null;
      if (type === 1 || type === 7) value = tiff[o];
      else if (type === 3) value = u16(o);
      else if (type === 4) value = u32(o);
      else if (type === 9) value = i32(o);
      else if (type === 5 || type === 10) {
        const n = type === 10 ? i32(o) : u32(o);
        const d = type === 10 ? i32(o + 4) : u32(o + 4);
        value = n === null || d === null || d === 0 ? null : n / d;
      }
      out.push(value);
    }
    return count === 1 ? out[0] : out;
  }

  function readIfd(offset, groupName, depth) {
    if (!Number.isFinite(offset) || offset < 8 || offset + 2 > tiff.length || depth > 4) return;
    const key = groupName + ':' + offset;
    if (seen.has(key)) return;
    seen.add(key);
    const count = u16(offset);
    if (count === null || count > 512 || offset + 2 + count * 12 > tiff.length) return;
    const group = groups[groupName];
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      const tag = u16(entry), type = u16(entry + 2), valueCount = u32(entry + 4);
      if (tag === null || type === null || valueCount === null) continue;
      const value = readValue(entry, type, valueCount);
      group[tag] = value;
      if (groupName === 'root' && tag === 0x8769 && Number.isFinite(value)) readIfd(value, 'exif', depth + 1);
      if (groupName === 'root' && tag === 0x8825 && Number.isFinite(value)) readIfd(value, 'gps', depth + 1);
    }
  }

  readIfd(u32(4), 'root', 0);
  const root = groups.root, exif = groups.exif, gps = groups.gps;
  const str = (value) => typeof value === 'string' && value ? value : null;
  const num = (value) => Number.isFinite(value) ? value : null;
  const first = (value) => Array.isArray(value) ? value[0] : value;
  const coord = (parts, ref) => {
    if (!Array.isArray(parts) || parts.length < 3 || !parts.slice(0, 3).every(Number.isFinite)) return null;
    let value = parts[0] + parts[1] / 60 + parts[2] / 3600;
    if (/^[SW]$/i.test(String(ref || ''))) value *= -1;
    return Number(value.toFixed(7));
  };
  const lat = coord(gps[0x0002], first(gps[0x0001]));
  const lon = coord(gps[0x0004], first(gps[0x0003]));
  let altitude = num(gps[0x0006]);
  if (altitude !== null && Number(first(gps[0x0005])) === 1) altitude *= -1;
  const gpsTime = Array.isArray(gps[0x0007]) && gps[0x0007].length >= 3
    ? gps[0x0007].slice(0, 3).map((v) => Number.isFinite(v) ? String(Math.floor(v)).padStart(2, '0') : '00').join(':')
    : null;
  const gpsDate = str(gps[0x001d]);

  const result = {
    camera: {
      make: str(root[0x010f]), model: str(root[0x0110]), lensMake: str(exif[0xa433]),
      lensModel: str(exif[0xa434]), software: str(root[0x0131]),
    },
    capture: {
      dateTimeOriginal: str(exif[0x9003]) || str(exif[0x9004]) || str(root[0x0132]),
      exposureTime: num(exif[0x829a]), fNumber: num(exif[0x829d]), iso: num(first(exif[0x8827])),
      focalLength: num(exif[0x920a]), focalLength35mm: num(exif[0xa405]),
      exposureBias: num(exif[0x9204]), flash: num(exif[0x9209]), orientation: num(root[0x0112]),
      width: num(exif[0xa002]), height: num(exif[0xa003]), whiteBalance: num(exif[0xa403]),
      exposureMode: num(exif[0xa402]), sceneType: num(exif[0xa406]),
      description: str(root[0x010e]), artist: str(root[0x013b]), copyright: str(root[0x8298]),
    },
    gps: lat !== null && lon !== null ? {
      latitude: lat, longitude: lon, altitude: altitude === null ? null : Number(altitude.toFixed(2)),
      direction: num(gps[0x0011]), directionRef: str(gps[0x0010]),
      dateTimeUtc: gpsDate ? gpsDate.replace(/:/g, '-') + (gpsTime ? ' ' + gpsTime + ' UTC' : '') : gpsTime,
    } : null,
  };
  const hasCamera = Object.values(result.camera).some((v) => v !== null);
  const hasCapture = Object.values(result.capture).some((v) => v !== null);
  return hasCamera || hasCapture || result.gps ? result : null;
}

function readPhotoMetadata(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const max = Math.min(stat.size, 4 * 1024 * 1024);
    if (max < 8) return { found: false, format: null, camera: {}, capture: {}, gps: null };
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    const b = buf.subarray(0, n);
    let tiff = null, format = null;

    if (b[0] === 0xff && b[1] === 0xd8) {
      format = 'JPEG';
      let o = 2;
      while (o + 4 <= b.length) {
        if (b[o] !== 0xff) { o += 1; continue; }
        const marker = b[o + 1];
        if (marker === 0xda || marker === 0xd9) break;
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
        const len = b.readUInt16BE(o + 2);
        if (len < 2 || o + 2 + len > b.length) break;
        const start = o + 4, end = o + 2 + len;
        if (marker === 0xe1 && end - start >= 6 && b.toString('ascii', start, start + 6) === 'Exif\0\0') {
          tiff = b.subarray(start + 6, end); break;
        }
        o += 2 + len;
      }
    } else if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      format = 'WEBP';
      let o = 12;
      while (o + 8 <= b.length) {
        const kind = b.toString('ascii', o, o + 4);
        const size = b.readUInt32LE(o + 4);
        const start = o + 8, end = start + size;
        if (end > b.length) break;
        if (kind === 'EXIF') {
          tiff = b.subarray(start, end);
          if (tiff.length >= 6 && tiff.toString('ascii', 0, 6) === 'Exif\0\0') tiff = tiff.subarray(6);
          break;
        }
        o = end + (size % 2);
      }
    } else if (b.length >= 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
      format = 'PNG';
      let o = 8;
      while (o + 12 <= b.length) {
        const size = b.readUInt32BE(o);
        const kind = b.toString('ascii', o + 4, o + 8);
        const start = o + 8, end = start + size;
        if (end + 4 > b.length) break;
        if (kind === 'eXIf') { tiff = b.subarray(start, end); break; }
        o = end + 4;
      }
    } else if (b.toString('ascii', 0, 2) === 'II' || b.toString('ascii', 0, 2) === 'MM') {
      format = 'TIFF'; tiff = b;
    }

    const parsed = tiff ? parseExifTiff(tiff) : null;
    return parsed
      ? { found: true, format, camera: parsed.camera, capture: parsed.capture, gps: parsed.gps }
      : { found: false, format, camera: {}, capture: {}, gps: null };
  } catch (_) {
    return { found: false, format: null, camera: {}, capture: {}, gps: null };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Feature 3 — subtitles. Converts SubRip (.srt) to WebVTT (what <track> needs);
// .vtt is already fine. Cheap text transform, no dependency.
const SUBTITLE_MAX_BYTES = 4 * 1024 * 1024;
function srtToVtt(src) {
  const body = String(src)
    .replace(/\r+/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2'); // comma → dot in timecodes
  return /^WEBVTT/.test(body.trim()) ? body : 'WEBVTT\n\n' + body;
}
// Given a media filename and the sibling directory listing, find matching subtitle
// files: <base>.vtt / <base>.srt, optionally with a language tag (<base>.en.srt).
function subtitleTracksFor(mediaName, entries) {
  const dot = mediaName.lastIndexOf('.');
  const base = (dot > 0 ? mediaName.slice(0, dot) : mediaName).toLowerCase();
  const out = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const n = String(e.name);
    const m = /^(.*)\.(vtt|srt)$/i.exec(n);
    if (!m) continue;
    const stem = m[1].toLowerCase();
    if (stem === base) { out.push({ name: n, lang: '', label: m[2].toUpperCase() }); continue; }
    // <base>.<lang> form (e.g. movie.en.srt)
    if (stem.startsWith(base + '.')) {
      const lang = stem.slice(base.length + 1);
      if (/^[a-z]{2,3}([-_][a-z]{2,4})?$/i.test(lang)) out.push({ name: n, lang, label: lang.toUpperCase() });
    }
  }
  return out;
}

// Feature 6 — richer, server-rendered previews (Markdown, highlighted code, ZIP
// listing). Kept separate from previewInfo (which drives raw inline serving via
// /view); this decides which files get a rendered /render page instead.
const CODE_EXTS = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'py', 'sh', 'bash', 'zsh',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'java', 'go', 'rs', 'rb', 'php', 'sql', 'toml', 'ini', 'conf',
  'yml', 'yaml', 'json', 'xml', 'html', 'htm', 'lua', 'pl', 'kt', 'swift', 'r', 'dart'];
function renderKind(filename) {
  const ext = (String(filename).split('.').pop() || '').toLowerCase();
  if (ext === 'zip') return 'archive';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (CODE_EXTS.includes(ext)) return 'code';
  const name = String(filename);
  if (/(^|\/)(dockerfile|makefile)$/i.test(name)) return 'code';
  return null;
}

// A cross-language keyword set — enough for a lightweight, grammar-free highlight
// that colors keywords/strings/comments/numbers without pulling in a big lib.
const CODE_KEYWORDS = new Set(('await async function return if else for while do switch case break continue ' +
  'const let var new class extends super this import from export default try catch finally throw typeof ' +
  'instanceof in of void delete yield public private protected static get set interface enum implements ' +
  'package def elif except with as pass lambda global nonlocal print None True False and or not is ' +
  'struct impl fn mut pub use mod match trait where self crate func type map range chan go defer select ' +
  'end then begin nil echo require include namespace foreach elseif fun val when object override ' +
  'int float double char bool boolean string void long short unsigned signed enum union sizeof').split(/\s+/));

// Escape then tokenize the ESCAPED text in a single left-to-right pass, so span
// wrapping never breaks HTML and strings correctly swallow their contents (a
// `//` inside a quote is not mistaken for a comment). Grammar-free but effective.
// Groups: 1 block comment, 2 line comment, 3 string, 4 number, 5 word.
const CODE_TOKEN_RE = /(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*|#[^\n]*)|(&quot;(?:[^&\n]|&(?!quot;))*?&quot;|&#39;(?:[^&\n]|&(?!#39;))*?&#39;|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b)|(\b[A-Za-z_]\w*\b)/g;
function highlightCode(text) {
  return esc(text).replace(CODE_TOKEN_RE, (m, c1, c2, c3, c4, c5) => {
    if (c1 || c2) return `<span class="tok-c">${m}</span>`;
    if (c3) return `<span class="tok-s">${m}</span>`;
    if (c4) return `<span class="tok-n">${m}</span>`;
    if (c5) return CODE_KEYWORDS.has(c5) ? `<span class="tok-k">${m}</span>` : m;
    return m;
  });
}

// Minimal, safe Markdown → HTML. Everything is HTML-escaped first; only a known
// set of inline/block constructs is then re-introduced. No raw HTML passthrough.
function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${esc(u)}" target="_blank" rel="noopener nofollow">${t}</a>`);
  const out = [];
  let inCode = false, codeBuf = [], listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (let raw of lines) {
    const fence = /^```/.test(raw);
    if (fence) {
      if (inCode) { out.push(`<pre class="code">${esc(codeBuf.join('\n'))}</pre>`); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (/^\s*$/.test(raw)) { closeList(); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(raw))) { closeList(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(raw)) { closeList(); out.push('<hr>'); continue; }
    if ((m = /^\s*>\s?(.*)$/.exec(raw))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(raw))) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = /^\s*\d+\.\s+(.*)$/.exec(raw))) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (inCode) out.push(`<pre class="code">${esc(codeBuf.join('\n'))}</pre>`);
  closeList();
  return out.join('\n');
}

// Feature 6 — list a ZIP's entries by parsing its End-Of-Central-Directory record
// and central directory, without extracting anything (no external dependency).
// Returns { entries: [{name, size, dir}], truncated } or null if not a valid ZIP.
async function readZipEntries(absPath, maxEntries = 2000) {
  let fh;
  try {
    fh = await fs.promises.open(absPath, 'r');
    const st = await fh.stat();
    const size = st.size;
    if (size < 22) return null;
    // EOCD is in the last 64KB (comment can push it up, but never beyond 65557 B).
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) return null; // ZIP64 not supported by this lightweight parser
    // Cap the central-directory read: a crafted/corrupt EOCD can declare a bogus
    // 4 GB cdSize, and Buffer.alloc(cdSize) would try to grab it all. 16 MB holds
    // tens of thousands of entries — far past the maxEntries we actually list.
    const allocSize = Math.min(cdSize, Math.max(0, size - cdOffset), 16 * 1024 * 1024);
    if (allocSize <= 0) return null;
    const cd = Buffer.alloc(allocSize);
    await fh.read(cd, 0, allocSize, cdOffset);
    const entries = [];
    let p = 0, truncated = false;
    for (let n = 0; n < total && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const uncomp = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      const dir = name.endsWith('/');
      if (entries.length < maxEntries) entries.push({ name, size: dir ? 0 : uncomp, dir });
      else { truncated = true; }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, truncated, count: total };
  } catch (_) {
    return null;
  } finally {
    if (fh) try { await fh.close(); } catch (_) {}
  }
}

// Reads at most maxBytes from a file WITHOUT loading the whole thing into memory.
// Shared host files can be arbitrarily large, so the text-preview features must
// never `readFile()` them whole. Returns { buf, truncated }.
async function readFileCapped(abs, maxBytes) {
  let fh;
  try {
    fh = await fs.promises.open(abs, 'r');
    const size = (await fh.stat()).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const { bytesRead } = await fh.read(buf, off, want - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return { buf: off === want ? buf : buf.subarray(0, off), truncated: size > maxBytes };
  } finally {
    if (fh) try { await fh.close(); } catch (_) {}
  }
}

// --- Feature 18: full-text search across shared / received text files ---------
// On-demand and bounded (no background index): each search walks the files behind
// the active links and greps text files for the query, with hard caps on files,
// results, per-file bytes and total time so it can never runaway.
const SEARCH_TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'toml',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm', 'py', 'sh', 'bash', 'zsh',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'java', 'go', 'rs', 'rb', 'php', 'sql', 'lua', 'pl', 'kt', 'swift', 'r', 'dart',
]);
const SEARCH_MAX_FILES = 4000;             // stop scanning after this many files
const SEARCH_MAX_RESULTS = 200;            // stop after this many matching files
const SEARCH_FILE_CAP = 2 * 1024 * 1024;   // read at most 2 MB per file
const SEARCH_TIME_MS = 8000;               // overall time budget

function isSearchableText(name) {
  return SEARCH_TEXT_EXTS.has((String(name).split('.').pop() || '').toLowerCase());
}
// Recursively walks a real directory (never following symlinks — Dirent.isFile/
// isDirectory are false for symlinks, so cycles and escapes are skipped) invoking
// onFile(absPath, relPath) for each searchable text file, until the budget stops.
async function walkTextFiles(absDir, relBase, budget, onFile) {
  if (budget.stop()) return;
  let ents;
  try { ents = await fs.promises.readdir(absDir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (budget.stop()) return;
    if (e.name.startsWith('.')) continue; // skip dotfiles / .dxparts etc.
    const abs = path.join(absDir, e.name);
    const rel = relBase ? relBase + '/' + e.name : e.name;
    if (e.isDirectory()) await walkTextFiles(abs, rel, budget, onFile);
    else if (e.isFile() && isSearchableText(e.name)) { budget.files += 1; await onFile(abs, rel); }
  }
}
// Reads a file (capped) and, if it contains `needle` (case-insensitive), pushes a
// result with the first match's line number, a trimmed snippet and the match count.
async function grepFile(abs, rel, needle, meta, results) {
  let text;
  try { text = (await readFileCapped(abs, SEARCH_FILE_CAP)).buf.toString('utf8'); } catch (_) { return; }
  const lc = text.toLowerCase();
  const pos = lc.indexOf(needle);
  if (pos < 0) return;
  const line = text.slice(0, pos).split('\n').length;
  const start = Math.max(0, pos - 40), end = Math.min(text.length, pos + needle.length + 80);
  const snippet = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
  let count = 0, i = pos;
  while (i >= 0 && count < 999) { count += 1; i = lc.indexOf(needle, i + needle.length); }
  results.push({ shareId: meta.id, shareName: meta.name, type: meta.type, token: meta.token, file: rel, line, matches: count, snippet: snippet.slice(0, 240) });
}

// Feature 6 — build the full rendered-preview page (Markdown / highlighted code /
// ZIP listing) for a file. `downloadUrl` powers the download button; `viewUrl`,
// when given, offers a "raw" fallback link. Text content is capped at 2 MB.
const RENDER_MAX_BYTES = 2 * 1024 * 1024;
async function buildRenderPage(lang, title, name, abs, kind, downloadUrl, viewUrl) {
  const L = PUB[lang] || PUB.en;
  const dlBtn = `<a class="btn" href="${esc(downloadUrl)}" download rel="noopener">${esc(L.download)}</a>`;
  const rawBtn = viewUrl ? `<a class="btn btn-ghost" href="${esc(viewUrl)}" target="_blank" rel="noopener">${esc(L.rawView)}</a>` : '';
  let inner = '';
  if (kind === 'archive') {
    const z = await readZipEntries(abs);
    if (!z) {
      inner = `<p class="muted">${esc(L.archiveUnreadable)}</p>`;
    } else if (!z.entries.length) {
      inner = `<p class="muted">${esc(L.archiveEmpty)}</p>`;
    } else {
      const rows = z.entries.map((e) =>
        `<tr><td class="fl-name"><span class="ico">${e.dir ? '📁' : '📄'}</span> ${esc(e.name)}</td>`
        + `<td class="fl-size">${e.dir ? '—' : esc(formatBytes(e.size))}</td></tr>`).join('');
      const note = z.truncated ? `<p class="muted sm">${esc(L.archiveTruncated)}</p>` : '';
      inner = `<p class="muted">${z.count} ${esc(L.zipEntries)}</p>`
        + `<div class="list-view"><table class="filelist"><tbody>${rows}</tbody></table></div>${note}`;
    }
  } else {
    let capped;
    try { capped = await readFileCapped(abs, RENDER_MAX_BYTES); } catch (_) { capped = { buf: Buffer.alloc(0), truncated: false }; }
    const tooBig = capped.truncated;
    const text = capped.buf.toString('utf8');
    const note = tooBig ? `<p class="muted sm">${esc(L.previewTruncated)}</p>` : '';
    if (kind === 'markdown') inner = `<div class="md-body">${renderMarkdown(text)}</div>${note}`;
    else inner = `<pre class="code hl"><code>${highlightCode(text)}</code></pre>${note}`;
  }
  const body = `
<div class="card render-card">
  <h1><span class="ico">${kind === 'archive' ? '🗜️' : kind === 'markdown' ? '📝' : '📄'}</span>${esc(name)}</h1>
  <div class="file-actions">${rawBtn}${dlBtn}</div>
  <div class="render-out">${inner}</div>
</div>`;
  return pageShell(lang, title || name, body);
}

// Streams a file, with support for Range requests.
// Caps a stream's throughput to `bps` bytes/second (per-link bandwidth limit),
// pacing on the cumulative average so the overall rate converges to the target.
class Throttle extends Transform {
  constructor(bps) {
    super();
    this.bps = bps;
    this.sent = 0;
    this.startAt = Date.now();
  }
  _transform(chunk, _enc, cb) {
    this.sent += chunk.length;
    const delay = (this.sent / this.bps) * 1000 - (Date.now() - this.startAt);
    if (delay > 5) setTimeout(() => cb(null, chunk), delay);
    else cb(null, chunk);
  }
}

// Feature 5 — bandwidth cap tied to a time-of-day window. Returns the cap in
// bytes/s that currently applies from the schedule (0 = no schedule cap right
// now), handling windows that wrap past midnight (start > end).
function scheduleRateBps(now = new Date()) {
  const s = getSettings();
  if (!s.scheduleRateEnabled) return 0;
  const kbps = Math.max(0, Math.floor(Number(s.scheduleRateKBps) || 0));
  if (kbps <= 0) return 0; // "unlimited inside the window" ⇒ nothing to cap
  const toMin = (v) => {
    const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(v).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = toMin(s.scheduleStart), end = toMin(s.scheduleEnd);
  if (start === null || end === null || start === end) return 0; // misconfigured / empty window
  const cur = now.getHours() * 60 + now.getMinutes();
  const inWindow = start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
  return inWindow ? kbps * 1024 : 0;
}

// Download bandwidth cap (bytes/s) applied to a transfer: the tighter of the
// per-link cap, the global server-wide cap and the current scheduled cap.
// 0 = unlimited.
function rateForMeta(meta) {
  let r = 0;
  if (meta && meta.shareId) {
    const s = getById(meta.shareId);
    if (s && s.rateBps > 0) r = s.rateBps;
  }
  const g = Math.max(0, Math.floor(Number(getSettings().globalRateKBps) || 0)) * 1024;
  if (g > 0) r = r > 0 ? Math.min(r, g) : g;
  const sched = scheduleRateBps();
  if (sched > 0) r = r > 0 ? Math.min(r, sched) : sched;
  return r;
}

function streamFile(req, res, absPath, filename, onServed, transferMeta, serveOpts = {}) {
  fs.stat(absPath, (err, st) => {
    if (err || !st.isFile()) return sendError(req, res, 404, 'fileNotFound');

    const total = st.size;
    // Feature 7 — gate large downloads behind a proof-of-work challenge. Only for
    // real download requests (serveOpts.challenge), never inline previews, and
    // only on the initial GET (a solved pass rides in a cookie thereafter).
    if (serveOpts.challenge && req.method === 'GET' && challengeRequired(total) && !hasValidPow(req)) {
      return res.status(200).type('html').send(challengePage(pickLang(req)));
    }
    res.setHeader('Accept-Ranges', 'bytes');
    const inline = !!serveOpts.inline;
    res.setHeader('Content-Type', inline && serveOpts.contentType ? serveOpts.contentType : 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') + `; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    // Direct image links use an explicit short public cache for hotlinking;
    // everything else stays no-store.
    res.setHeader('Cache-Control', serveOpts.cacheControl || 'no-store');

    let start = 0;
    let end = total - 1;
    let status = 200;

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && !(m[1] === '' && m[2] === '')) {
        if (m[1] === '') {
          const suffix = parseInt(m[2], 10);
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = parseInt(m[1], 10);
          end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
        }
        if (isNaN(start) || isNaN(end) || start > end || start >= total || total === 0) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      }
    }

    res.status(status);
    res.setHeader('Content-Length', end - start + 1);

    // Is the WHOLE file delivered in a single GET response? Quotas, notifications
    // and auto-shutdown are committed only after the response finishes cleanly.
    // HEAD, byte ranges and interrupted responses must never consume a download.
    const isFullGet = req.method === 'GET' && start === 0 && end >= total - 1;
    if (isFullGet) {
      res.on('finish', () => {
        // Inline image responses still need their per-copy view counters updated;
        // only real attachment downloads trigger the global completion hook.
        if (onServed) onServed();
        if (!inline) onDownloadComplete({ type: 'file', name: filename });
      });
    }

    // HEAD or empty file: no stream to open.
    if (req.method === 'HEAD' || end < start) {
      return res.end();
    }

    const rateBps = rateForMeta(transferMeta);
    const stream = fs.createReadStream(absPath, {
      start,
      end,
      // Smaller chunks when throttling so the rate stays smooth (no long bursts).
      highWaterMark: rateBps > 0 ? Math.min(256 * 1024, Math.max(16 * 1024, Math.floor(rateBps / 10))) : undefined,
    });
    const throttle = rateBps > 0 ? new Throttle(rateBps) : null;
    const transfer = transferMeta ? startTransfer(req, transferMeta, end - start + 1) : null;
    if (transfer) {
      transfer.notify = isFullGet; // only notify a complete download
      transfer.abort = () => {
        try { stream.destroy(); if (throttle) throttle.destroy(); res.destroy(); } catch (_) {}
      };
      stream.on('data', (chunk) => { transfer.bytes += chunk.length; transfer.lastActivity = Date.now(); });
    }
    stream.on('error', () => {
      if (transfer) transfer.failureReason = 'read-error';
      if (!res.headersSent) sendError(req, res, 500, 'readError');
      else res.destroy();
    });
    // 'close' always fires at the end; res.writableFinished distinguishes completed/interrupted.
    res.on('close', () => {
      stream.destroy();
      if (throttle) throttle.destroy();
      endTransfer(transfer, res.writableFinished, res.writableFinished ? null : (transfer && transfer.failureReason) || 'connection-closed');
    });
    if (throttle) stream.pipe(throttle).pipe(res);
    else stream.pipe(res);
  });
}

// Wraps a file as a readable stream that (a) opens the descriptor lazily — only
// when the archiver actually starts reading this entry, so thousands of queued
// files don't exhaust the open-file limit — and (b) reports each chunk's size via
// onBytes as it is read from disk. This is what drives the .zip progress bar and
// ETA: archiver's own 'progress' event is unreliable for a live, piped download.
function countingFileStream(absPath, onBytes) {
  return Readable.from((async function* () {
    const fh = await fs.promises.open(absPath, 'r');
    try {
      while (true) {
        const buf = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        if (onBytes) onBytes(bytesRead);
        yield bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
      }
    } finally {
      await fh.close();
    }
  })());
}

// Recursively adds a folder to the archive, never following symlinks. The total
// is discovered during this same walk so large trees are not scanned twice.
async function addDirToArchive(archive, absDir, baseInZip, onBytes, onFileSize) {
  let dirents;
  try {
    dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const d of dirents) {
    if (d.isSymbolicLink()) continue; // anti-escape
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    // d.name is an actual directory entry returned by fs.readdir() on absDir
    // (already validated upstream), not attacker-supplied text — the OS never
    // returns '..' or path-separator-bearing names as dirents.
    const abs = path.join(absDir, d.name);
    const nameInZip = baseInZip ? baseInZip + '/' + d.name : d.name;
    if (d.isDirectory()) {
      await addDirToArchive(archive, abs, nameInZip, onBytes, onFileSize);
    } else if (d.isFile()) {
      let date, size = 0;
      try {
        const st = await fs.promises.stat(abs);
        date = st.mtime;
        size = st.size;
      } catch (_) {}
      if (onFileSize) onFileSize(size);
      archive.append(countingFileStream(abs, onBytes), { name: nameInZip, date });
    }
  }
}

let activeZipStreams = 0;
function beginZipStream(res) {
  if (activeZipStreams >= MAX_CONCURRENT_ZIPS) {
    res.removeHeader('Content-Disposition');
    res.setHeader('Retry-After', '5');
    res.status(429).json({ error: 'too-many-zips' });
    return false;
  }
  activeZipStreams++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeZipStreams = Math.max(0, activeZipStreams - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  return true;
}

async function streamZip(req, res, absDir, zipName, onServed, transferMeta) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName + '.zip')}`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') return res.end();
  if (!beginZipStream(res)) return;

  const archive = await newZipArchive({ zlib: { level: 6 } });
  const rateBps = rateForMeta(transferMeta);
  const throttle = rateBps > 0 ? new Throttle(rateBps) : null;
  const transfer = transferMeta ? startTransfer(req, transferMeta, 0) : null;
  if (transfer) {
    transfer.notify = true; // a zip = complete download
    transfer.isZip = true;
    transfer.zipTotalBytes = 0; // combined uncompressed size (filled in below)
    transfer.zipProcessedBytes = 0; // uncompressed bytes read so far (from the archiver)
    transfer.abort = () => {
      try { archive.destroy(); if (throttle) throttle.destroy(); res.destroy(); } catch (_) {}
    };
  }
  let zipBytes = 0;
  const maxZip = effMaxZip();

  archive.on('error', (err) => {
    if (transfer) transfer.failureReason = 'zip-error';
    console.error('[zip] error:', err.message);
    if (!res.headersSent) sendError(req, res, 500, 'zipError');
    else res.destroy();
  });
  archive.on('warning', (w) => {
    if (w.code !== 'ENOENT') console.warn('[zip] warning:', w.message);
  });
  archive.on('data', (chunk) => {
    if (transfer) { transfer.bytes += chunk.length; transfer.lastActivity = Date.now(); }
    if (maxZip > 0) {
      zipBytes += chunk.length;
      if (zipBytes > maxZip) {
        if (transfer) transfer.failureReason = 'zip-too-large';
        archive.abort();
        res.destroy();
      }
    }
  });

  res.on('close', () => {
    archive.destroy();
    if (throttle) throttle.destroy();
    endTransfer(transfer, res.writableFinished, res.writableFinished ? null : (transfer && transfer.failureReason) || 'connection-closed');
  });
  res.on('finish', () => {
    if (onServed) onServed();
    onDownloadComplete({ type: 'folder-zip', name: zipName });
  });
  if (throttle) archive.pipe(throttle).pipe(res);
  else archive.pipe(res);

  try {
    await addDirToArchive(
      archive,
      absDir,
      '',
      (n) => { if (transfer) { transfer.zipProcessedBytes += n; transfer.lastActivity = Date.now(); } },
      (n) => { if (transfer) transfer.zipTotalBytes += n; }
    );
    await archive.finalize();
  } catch (e) {
    if (transfer) transfer.failureReason = 'zip-error';
    console.error('[zip] traversal aborted:', e.message);
    archive.destroy();
  }
}

// Streams a ZIP built from an explicit list of files (a share collection).
async function streamZipFiles(req, res, items, zipName, onServed, transferMeta) {
  if (challengeGateZip(req, res)) return;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName + '.zip')}`);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') return res.end();
  if (!beginZipStream(res)) return;

  const archive = await newZipArchive({ zlib: { level: 6 } });
  const rateBps = rateForMeta(transferMeta);
  const throttle = rateBps > 0 ? new Throttle(rateBps) : null;
  const transfer = transferMeta ? startTransfer(req, transferMeta, 0) : null;
  if (transfer) {
    transfer.notify = true;
    transfer.isZip = true;
    transfer.zipTotalBytes = 0; // combined uncompressed size (filled in below)
    transfer.zipProcessedBytes = 0; // uncompressed bytes read so far (from the archiver)
    transfer.abort = () => { try { archive.destroy(); if (throttle) throttle.destroy(); res.destroy(); } catch (_) {} };
  }
  let zipBytes = 0;
  const maxZip = effMaxZip();
  archive.on('error', (err) => {
    if (transfer) transfer.failureReason = 'zip-error';
    console.error('[zip] error:', err.message);
    if (!res.headersSent) sendError(req, res, 500, 'zipError');
    else res.destroy();
  });
  archive.on('warning', (w) => { if (w.code !== 'ENOENT') console.warn('[zip] warning:', w.message); });
  archive.on('data', (chunk) => {
    if (transfer) { transfer.bytes += chunk.length; transfer.lastActivity = Date.now(); }
    if (maxZip > 0) {
      zipBytes += chunk.length;
      if (zipBytes > maxZip) { if (transfer) transfer.failureReason = 'zip-too-large'; archive.abort(); res.destroy(); }
    }
  });
  res.on('close', () => { archive.destroy(); if (throttle) throttle.destroy(); endTransfer(transfer, res.writableFinished, res.writableFinished ? null : (transfer && transfer.failureReason) || 'connection-closed'); });
  res.on('finish', () => {
    if (onServed) onServed();
    onDownloadComplete({ type: 'collection-zip', name: zipName });
  });
  if (throttle) archive.pipe(throttle).pipe(res);
  else archive.pipe(res);
  try {
    const used = new Map();
    const uniq = (name) => {
      const seen = used.get(name);
      if (seen != null) {
        const n = seen + 1;
        used.set(name, n);
        const dot = name.lastIndexOf('.');
        return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      }
      used.set(name, 0);
      return name;
    };
    const onBytes = (n) => { if (transfer) { transfer.zipProcessedBytes += n; transfer.lastActivity = Date.now(); } };
    for (const it of items) {
      let abs, st;
      try {
        abs = hostToContainer(it.hostPath);
        await assertRealWithin(HOST_ROOT, abs);
        st = await fs.promises.stat(abs);
      } catch (_) {
        continue;
      }
      const label = it.name || path.basename(abs);
      if (st.isDirectory()) {
        await addDirToArchive(
          archive,
          abs,
          uniq(label),
          onBytes,
          (n) => { if (transfer) transfer.zipTotalBytes += n; }
        );
      } else if (st.isFile()) {
        if (transfer) transfer.zipTotalBytes += st.size;
        archive.append(countingFileStream(abs, onBytes), { name: uniq(label), date: st.mtime });
      }
    }
    await archive.finalize();
  } catch (e) {
    console.error('[zip] collection aborted:', e.message);
    archive.destroy();
  }
}

async function listDir(absDir) {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const d of dirents) {
    if (d.isDirectory()) {
      dirs.push({ name: d.name, isDir: true });
    } else if (d.isFile() || d.isSymbolicLink()) {
      files.push({ name: d.name, isDir: false, size: null });
    }
  }
  await mapLimit(files, 32, async (f) => {
    try {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      // f.name comes from the fs.readdir() call above, not from user input.
      f.size = (await fs.promises.stat(path.join(absDir, f.name))).size;
    } catch (_) {}
  });
  const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  dirs.sort((a, b) => coll.compare(a.name, b.name));
  files.sort((a, b) => coll.compare(a.name, b.name));
  return [...dirs, ...files];
}

downloadRouter.get('/s/:token', (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  recordRecipientView(req); // read receipt for nominative sub-links (no-op otherwise)
  bumpViews(s, req); // live views / unique-visitors counter (admin page)
  if (s.encrypted) return res.type('html').send(encDecryptPage(pickLang(req), s, req.params.token));
  const tk = req.params.token; // preserve the visited token (main link or a sub-link)
  const wm = previewWatermark(req, tk);
  if (s.type === 'file') {
    const items = shareItems(s);
    if (items.length > 1) return res.type('html').send(collectionPage(pickLang(req), s, items, tk, wm));
    if (items[0].type === 'folder') return res.redirect(302, `/s/${tk}/item/0/browse`);
    return res.type('html').send(filePage(pickLang(req), s, `/s/${tk}/download`, tk, wm));
  }
  return res.redirect(302, `/s/${tk}/browse`);
});

// Ciphertext blob of an encrypted download share (opaque; decrypted in-browser).
downloadRouter.get('/s/:token/enc', (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || !s.encrypted || !s.encPath) return sendError(req, res, 404, 'notFound');
  streamFile(req, res, s.encPath, path.basename(s.encPath), () => incrementDownloads(s.id), {
    shareId: s.id,
    name: s.name,
    type: 'file',
  }, { challenge: true });
});

downloadRouter.get('/s/:token/download', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const items = shareItems(s);
  const item = items[clampIndex(req.query.i, items.length)];
  try {
    const abs = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, abs);
    streamFile(req, res, abs, item.name, () => incrementDownloads(s.id), {
      shareId: s.id,
      name: item.name,
      type: 'file',
    }, { challenge: true });
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

// In-browser preview: serves the file inline with its real MIME type. Does NOT
// count as a download and is not tracked as a transfer (viewing != downloading).
downloadRouter.get('/s/:token/view', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const items = shareItems(s);
  const idx = clampIndex(req.query.i, items.length);
  const item = items[idx];
  // Preview disabled on this share ⇒ force a download instead of an inline view.
  if (s.noPreview) return res.redirect(302, `/s/${req.params.token}/download?i=${idx}`);
  const info = previewInfo(item.name);
  if (!info) return res.redirect(302, `/s/${req.params.token}/download?i=${idx}`);
  try {
    const abs = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, abs);
    streamFile(req, res, abs, item.name, null, null, { inline: true, contentType: info.contentType });
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

// Photos tab — direct image links (no relay HTML page). /i/<token>[.ext] serves
// the full image; /thumb and /micro serve the two generated sizes. A missing
// variant falls back without immutable caching, so generation can replace it.
// Direct image tokens are stable, but links can be revoked. Keep a short public
// cache for hotlink performance without leaving revoked images cached for a year.
const PHOTO_PUBLIC_CACHE = 'public, max-age=3600';

// --- Anti-hotlink (feature 19) ---------------------------------------------
// When imageHotlinkHosts is non-empty, only requests whose Referer host matches
// the allowlist (or the server's own host, or that carry no Referer at all —
// i.e. a direct visit) are served. Subdomains of a listed host are allowed too.
function parseHotlinkHosts(input) {
  const parts = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[\s,;]+/);
  const out = [];
  for (const raw of parts) {
    if (typeof raw !== 'string') continue;
    let h = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^\/\//, '');
    h = h.split('/')[0].split('?')[0].replace(/:\d+$/, '').replace(/^\*\./, '');
    if (h && h.length <= 253 && /^[a-z0-9.-]+$/.test(h) && !out.includes(h)) out.push(h);
    if (out.length >= 50) break;
  }
  return out;
}
function hotlinkRefererHost(req) {
  const ref = req.headers.referer || req.headers.referrer || '';
  if (!ref) return null;
  try { return new URL(ref).hostname.toLowerCase(); } catch (_) { return null; }
}
function hotlinkAllowed(req, share) {
  // A PWA-created image may carry its own explicit policy. An empty array means
  // protection disabled for that image; absence of the property inherits the
  // instance-wide Images setting for backwards compatibility.
  const list = share && Object.prototype.hasOwnProperty.call(share, 'hotlinkHosts')
    ? share.hotlinkHosts
    : getSettings().imageHotlinkHosts;
  if (!Array.isArray(list) || !list.length) return true; // protection off
  const host = hotlinkRefererHost(req);
  if (!host) return true; // direct navigation / privacy-stripped Referer
  const self = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (self && (host === self || host.endsWith('.' + self))) return true; // same site
  return list.some((h) => host === h || host.endsWith('.' + h));
}

async function servePhoto(req, res, variant) {
  let token = String(req.params.token || '');
  const dot = token.lastIndexOf('.');
  if (dot > 0) token = token.slice(0, dot); // strip a cosmetic /i/<token>.jpg extension
  const s = getByToken(token);
  if (!s || s.type !== 'photo' || !isActive(s)) return sendError(req, res, 404, 'fileNotFound');
  // Reject foreign embeds before password/visitor processing so a blocked site
  // cannot probe protected images or consume visitor-limit capacity.
  if (!hotlinkAllowed(req, s)) return sendError(req, res, 403, 'hotlinkBlocked');
  if (s.pwHash && !isUnlocked(req, s)) {
    return res.status(401).type('html').send(passwordPage(pickLang(req), s, false, token));
  }
  if (!recordAndCheckVisitor(s, req)) return sendError(req, res, 404, 'fileNotFound');
  const kind = variant || 'full';
  const restrictedCache = !!s.pwHash || Number(s.maxViews) > 0 || !!s.expiresAt;
  const candidates = variant === 'micro'
    ? [
        ...photoVariantPaths(token, 'micro').map((file) => ({ ready: s.micro, file, immutable: true })),
        ...photoVariantPaths(token, 'thumb').map((file) => ({ ready: s.thumb, file, immutable: false })),
      ]
    : (variant === 'thumb'
        ? photoVariantPaths(token, 'thumb').map((file) => ({ ready: s.thumb, file, immutable: true }))
        : []);
  for (const candidate of candidates) {
    if (!candidate.ready) continue;
    try {
      if ((await fs.promises.stat(candidate.file)).isFile()) {
        return streamFile(req, res, candidate.file, token + '.jpg', () => notePhotoView(s, req, kind), null, {
          inline: true,
          contentType: 'image/jpeg',
          cacheControl: restrictedCache ? 'no-store' : (candidate.immutable ? PHOTO_PUBLIC_CACHE : 'no-store'),
        });
      }
    } catch (_) {}
  }
  try {
    let abs = firstExistingPhotoFile(photoOriginalPaths(s));
    if (!abs) {
      abs = hostToContainer(s.hostPath);
      await assertRealWithin(HOST_ROOT, abs);
    }
    const ct = imageContentType(s.imgPath || s.name) || 'application/octet-stream';
    streamFile(req, res, abs, s.name, () => notePhotoView(s, req, kind), null, {
      inline: true,
      contentType: ct,
      cacheControl: restrictedCache || variant ? 'no-store' : PHOTO_PUBLIC_CACHE,
    });
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
}
async function serveAdaptivePhoto(req, res) {
  let token = String(req.params.token || '');
  const dot = token.lastIndexOf('.');
  if (dot > 0) token = token.slice(0, dot);
  const s = getByToken(token);
  if (!s || s.type !== 'photo' || !isActive(s)) return sendError(req, res, 404, 'fileNotFound');

  const width = Math.max(0, Math.min(10000, parseInt(req.query.w, 10) || parseInt(req.headers.width, 10) || parseInt(req.headers['viewport-width'], 10) || 0));
  const saveData = String(req.headers['save-data'] || '').toLowerCase() === 'on';
  const ect = String(req.headers.ect || '').toLowerCase();
  const slow = saveData || /(^|-)2g$/.test(ect) || ect === 'slow-2g';
  if (slow || (width && width <= 320)) return servePhoto(req, res, 'micro');
  if (width && width <= 900) return servePhoto(req, res, 'thumb');

  const accept = String(req.headers.accept || '');
  let format = null;
  if (/image\/avif/i.test(accept) && s.adaptiveAvif) format = 'avif';
  else if (/image\/webp/i.test(accept) && s.adaptiveWebp) format = 'webp';
  if (!format) return servePhoto(req, res, null);

  const file = photoAdaptivePath(token, format);
  try {
    if (!file || !(await fs.promises.stat(file)).isFile()) {
      if (format === 'avif') delete s.adaptiveAvif; else delete s.adaptiveWebp;
      scheduleFlush();
      return servePhoto(req, res, null);
    }
    if (!hotlinkAllowed(req, s)) return sendError(req, res, 403, 'hotlinkBlocked');
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).type('html').send(passwordPage(pickLang(req), s, false, token));
    if (!recordAndCheckVisitor(s, req)) return sendError(req, res, 404, 'fileNotFound');
    const restrictedCache = !!s.pwHash || Number(s.maxViews) > 0 || !!s.expiresAt;
    res.setHeader('Accept-CH', 'DPR, Width, Viewport-Width, Save-Data, ECT');
    res.setHeader('Vary', 'Accept, Save-Data, Width, Viewport-Width, DPR, ECT');
    return streamFile(req, res, file, token + '.' + format, () => notePhotoView(s, req, 'full'), null, {
      inline: true,
      contentType: 'image/' + format,
      cacheControl: restrictedCache ? 'no-store' : PHOTO_PUBLIC_CACHE,
    });
  } catch (_) {
    return servePhoto(req, res, null);
  }
}
downloadRouter.get('/i/:token/auto', serveAdaptivePhoto);
downloadRouter.get('/i/:token/thumb', (req, res) => servePhoto(req, res, 'thumb'));
downloadRouter.get('/i/:token/micro', (req, res) => servePhoto(req, res, 'micro'));
downloadRouter.get('/i/:token', (req, res) => servePhoto(req, res, null));

// Public image gallery (feature 18): renders an album's still-active members.
downloadRouter.get('/g/:token', (req, res) => {
  const lang = pickLang(req);
  const s = getByToken(String(req.params.token || ''));
  if (!s || s.type !== 'album' || !isActive(s)) return sendError(req, res, 404, 'shareGone');
  if (s.pwHash && !isUnlocked(req, s)) {
    return res.status(401).type('html').send(passwordPage(lang, s, false, req.params.token));
  }
  if (!recordAndCheckVisitor(s, req)) return sendError(req, res, 404, 'shareGone');
  const members = (Array.isArray(s.members) ? s.members : [])
    .map((tok) => getByToken(tok))
    .filter((m) => m && m.type === 'photo' && isActive(m));
  s.views = (s.views || 0) + 1; scheduleFlush(); // count gallery page loads
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(albumPage(lang, s, members, req));
});

function albumInviteHash(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}
function activeAlbumInvite(album, secret) {
  if (!album || album.type !== 'album' || !Array.isArray(album.collaborators)) return null;
  const hash = albumInviteHash(secret);
  const now = Date.now();
  return album.collaborators.find((entry) => entry && !entry.disabled && entry.tokenHash === hash && (!entry.expiresAt || entry.expiresAt > now)) || null;
}
function albumCollaborationPage(lang, album, members, invite, secret) {
  const L = PUB[lang] || PUB.en;
  const title = album.name || L.albumTitle || 'Gallery';
  const canUpload = invite.role === 'contributor' || invite.role === 'manager';
  const canManage = invite.role === 'manager';
  const base = '/g/' + encodeURIComponent(album.token) + '/c/' + encodeURIComponent(secret);
  const cells = members.map((m) => {
    const full = '/i/' + m.token + '/auto?w=1920';
    const thumb = '/i/' + m.token + '/auto?w=480';
    const remove = canManage ? `<button class="collab-remove" type="button" data-token="${esc(m.token)}">×</button>` : '';
    const privacy = m.metadataRemoved ? `<span class="gal-privacy">🛡 ${esc(L.photoMetadataRemoved || 'EXIF/GPS removed')}</span>` : '';
    return `<div class="gal-cell-wrap"><a class="gal-cell" href="${esc(full)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(thumb)}" alt="${esc(m.name || '')}">${privacy}</a>${remove}</div>`;
  }).join('');
  const remaining = invite.maxFiles > 0 ? Math.max(0, invite.maxFiles - (invite.usedFiles || 0)) : null;
  const upload = canUpload ? `<div class="collab-upload"><h2>${lang === 'fr' ? 'Ajouter des images' : lang === 'es' ? 'Añadir imágenes' : 'Add images'}</h2><input id="collab-files" type="file" accept="image/*" multiple><button id="collab-send" class="btn" type="button">${lang === 'fr' ? 'Envoyer' : lang === 'es' ? 'Enviar' : 'Upload'}</button><p id="collab-status" class="muted"></p>${remaining === null ? '' : `<p class="muted">${remaining} ${lang === 'fr' ? 'fichier(s) restant(s)' : lang === 'es' ? 'archivo(s) restantes' : 'file(s) remaining'}</p>`}</div>` : '';
  const script = canUpload || canManage ? `<script>(function(){const base=${JSON.stringify(base)};const status=document.getElementById('collab-status');const btn=document.getElementById('collab-send');if(btn)btn.onclick=async()=>{const files=[...document.getElementById('collab-files').files];if(!files.length)return;btn.disabled=true;let ok=0;for(const file of files){status.textContent=(ok+1)+'/'+files.length+'…';const r=await fetch(base+'/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});if(r.ok)ok++;else{let e={};try{e=await r.json()}catch(_){ }status.textContent='Erreur: '+(e.error||r.status);break;}}btn.disabled=false;if(ok===files.length)location.reload();};document.querySelectorAll('.collab-remove').forEach(b=>b.onclick=async()=>{if(!confirm('Retirer cette image de l’album ?'))return;const r=await fetch(base+'/remove/'+encodeURIComponent(b.dataset.token),{method:'POST'});if(r.ok)location.reload();});})();</script>` : '';
  return pageShell(lang, title, `<style>.gal-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:16px}.gal-head h1{margin:0;font-size:1.4rem;word-break:break-word}.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.gal-cell-wrap{position:relative}.gal-cell{position:relative;display:block;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:rgba(127,127,127,.12)}.gal-cell img{width:100%;height:100%;object-fit:cover;display:block}.gal-privacy{position:absolute;left:7px;bottom:7px;max-width:calc(100% - 14px);padding:4px 7px;border-radius:999px;background:rgba(8,24,18,.86);color:#d9ffe9;font-size:.72rem;font-weight:700;line-height:1.2}.collab-remove{position:absolute;right:5px;top:5px;border:0;border-radius:999px;background:#b91c1c;color:white;width:30px;height:30px;font-size:20px}.collab-upload{margin:0 0 18px;padding:16px;border:1px solid rgba(127,127,127,.25);border-radius:12px}.collab-upload input{display:block;margin:10px 0;max-width:100%}</style><div class="card"><div class="gal-head"><h1>${esc(title)}</h1><span class="muted">${esc(invite.label || invite.role)}</span></div>${upload}<div class="gallery-grid">${cells}</div></div>${script}`);
}

downloadRouter.get('/g/:token/c/:secret', (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  const invite = activeAlbumInvite(album, req.params.secret);
  if (!album || !invite || !isActive(album)) return sendError(req, res, 404, 'shareGone');
  const members = (Array.isArray(album.members) ? album.members : []).map(getByToken).filter((m) => m && m.type === 'photo' && isActive(m));
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(albumCollaborationPage(pickLang(req), album, members, invite, req.params.secret));
});
downloadRouter.post('/g/:token/c/:secret/upload', (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  const invite = activeAlbumInvite(album, req.params.secret);
  if (!album || !invite || !isActive(album) || !['contributor', 'manager'].includes(invite.role)) return res.status(404).json({ error: 'not-found' });
  if (invite.maxFiles > 0 && (invite.usedFiles || 0) >= invite.maxFiles) return res.status(409).json({ error: 'file-limit' });
  const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!type.startsWith('image/')) return res.status(415).json({ error: 'image-required' });
  const rawName = String(req.query.name || 'image.jpg').replace(/[\/\r\n\t]+/g, ' ').trim().slice(0, 120);
  let ext = (rawName.split('.').pop() || mimeExt || '').toLowerCase(); if (ext === 'jpeg') ext = 'jpg';
  if (!PWA_IMG_EXT.test(ext)) return res.status(415).json({ error: 'unsupported-image' });
  const max = Math.min(IMAGE_MAX_BYTES, invite.maxFileBytes > 0 ? invite.maxFileBytes : IMAGE_MAX_BYTES);
  const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
  const dest = path.join(FULL_IMAGES_DIR, fname);
  streamToFileBounded(req, res, dest, max, (size) => {
    const dims = imageDimensions(dest);
    const share = { type: 'photo', name: rawName || ('image.' + ext), imgPath: fname, ext, size, contributedViaAlbum: album.token, contributedByInviteId: invite.id };
    stampPhotoUploadDevice(share, req, 'collaborator');
    if (dims) { share.w = dims.w; share.h = dims.h; }
    if (album.ownerId) share.ownerId = album.ownerId;
    if (album.ownerDeviceId) share.ownerDeviceId = album.ownerDeviceId;
    share.ownerName = album.ownerName || 'Album';
    const rec = addShare(share);
    if (!Array.isArray(album.members)) album.members = [];
    album.members.push(rec.token);
    invite.usedFiles = (invite.usedFiles || 0) + 1; invite.lastUsedAt = Date.now();
    persistNow();
    res.status(201).json({ ok: true, token: rec.token, url: '/i/' + rec.token + '.' + photoExt(rec) });
  });
});
downloadRouter.post('/g/:token/c/:secret/remove/:imageToken', (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  const invite = activeAlbumInvite(album, req.params.secret);
  if (!album || !invite || invite.role !== 'manager') return res.status(404).json({ error: 'not-found' });
  const token = String(req.params.imageToken || '');
  const before = Array.isArray(album.members) ? album.members.length : 0;
  album.members = (album.members || []).filter((t) => t !== token);
  if (album.members.length === before) return res.status(404).json({ error: 'not-found' });
  const photo = getByToken(token);
  if (photo && photo.type === 'photo' && photo.contributedViaAlbum === album.token) removeShare(photo.id, false);
  persistNow(); res.json({ ok: true });
});

// Feature 6 — rendered preview (Markdown, highlighted code, ZIP listing) for an
// indexed item of a file/collection share. Falls back to the raw /view otherwise.
downloadRouter.get('/s/:token/render', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const items = shareItems(s);
  const idx = clampIndex(req.query.i, items.length);
  const item = items[idx];
  if (s.noPreview) return res.redirect(302, `/s/${req.params.token}/download?i=${idx}`);
  const kind = renderKind(item.name);
  if (!kind) return res.redirect(302, `/s/${req.params.token}/view?i=${idx}`);
  try {
    const abs = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, abs);
    const viewUrl = previewInfo(item.name) ? `/s/${req.params.token}/view?i=${idx}` : '';
    const html = await buildRenderPage(pickLang(req), s.name, item.name, abs, kind, `/s/${req.params.token}/download?i=${idx}`, viewUrl);
    res.type('html').send(html);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

// Whether "download everything as .zip" is allowed for this share (default: yes).
function zipAllowed(s) {
  return !!s && s.allowZip !== false;
}

// Download every file of a collection as a single ZIP.
downloadRouter.get('/s/:token/all.zip', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'file') return sendError(req, res, 404, 'notFound');
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  const items = shareItems(s);
  streamZipFiles(req, res, items, s.name || 'files', () => incrementDownloads(s.id), {
    shareId: s.id,
    name: s.name || 'files',
    type: 'collection-zip',
  });
});

// --- Folder serving, shared by top-level folder shares and folder items inside a
//     collection. `base` is the URL prefix used to build links (`/s/<t>` or
//     `/s/<t>/item/<i>`); `label` is the folder name shown in the header. ---
async function serveFolderBrowse(req, res, s, folderRoot, sub, base, label) {
  const absDir = resolveWithin(folderRoot, sub);
  await assertRealWithin(folderRoot, absDir);
  const st = await fs.promises.stat(absDir);
  if (!st.isDirectory()) {
    return streamFile(req, res, absDir, path.basename(absDir), () => incrementDownloads(s.id), {
      shareId: s.id,
      name: path.basename(absDir),
      type: 'file',
    }, { challenge: true });
  }
  const entries = await listDir(absDir);
  const browseBase = `${base}/browse`;
  const joinRel = (child) => (sub ? sub.replace(/\/+$/, '') + '/' + child : child);
  const links = {
    browseBase,
    browse: (rel) => `${browseBase}/${encodePath(rel)}`,
    file: (rel) => `${base}/file/${encodePath(rel)}`,
    zip: (rel) => (rel ? `${base}/zip/${encodePath(rel)}` : `${base}/zip`),
    sha256: (rel) => (rel ? `${base}/sha256/${encodePath(rel)}` : `${base}/sha256`),
  };
  const withRel = entries.map((e) => ({ ...e, rel: joinRel(e.name) }));
  const view = label && label !== s.name ? { ...s, name: label } : s;
  const wm = previewWatermark(req, req.params.token);
  // Feature 3 — ?player=1 opens a playlist player for the audio/video in this folder.
  if (req.query.player && !s.noPreview) {
    return res.type('html').send(mediaPlayerPage(pickLang(req), view, withRel, links, wm));
  }
  res.type('html').send(folderPage(pickLang(req), view, sub, withRel, links, wm));
}

async function serveFolderFile(req, res, s, folderRoot, sub) {
  const abs = resolveWithin(folderRoot, sub);
  await assertRealWithin(folderRoot, abs);
  const name = path.basename(abs);
  // Feature 3 — ?vtt=1 serves a sibling subtitle as WebVTT (converting .srt).
  if (req.query.vtt) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'vtt' || ext === 'srt') {
      let raw = '';
      // Subtitles are small; cap the read so a huge misnamed .srt can't OOM us.
      try { raw = (await readFileCapped(abs, SUBTITLE_MAX_BYTES)).buf.toString('utf8'); }
      catch (_) { return sendError(req, res, 404, 'fileNotFound'); }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(ext === 'srt' ? srtToVtt(raw) : (/^﻿?WEBVTT/.test(raw) ? raw : 'WEBVTT\n\n' + raw));
    }
  }
  // ?render=1 shows a rendered preview (Markdown / highlighted code / ZIP list).
  if (req.query.render && !s.noPreview) {
    const kind = renderKind(name);
    if (kind) {
      const downloadUrl = req.originalUrl.replace(/[?&]render=1/, '');
      const viewUrl = previewInfo(name) ? req.originalUrl.replace(/render=1/, 'view=1') : '';
      const html = await buildRenderPage(pickLang(req), s.name, name, abs, kind, downloadUrl, viewUrl);
      return res.type('html').send(html);
    }
  }
  // ?view=1 serves the file inline (gallery thumbnail / open-in-tab preview) and
  // is NOT counted as a download or tracked as a transfer — mirrors /s/:token/view.
  const info = req.query.view && !s.noPreview ? previewInfo(name) : null;
  if (info) {
    return streamFile(req, res, abs, name, null, null, { inline: true, contentType: info.contentType });
  }
  streamFile(req, res, abs, name, () => incrementDownloads(s.id), {
    shareId: s.id,
    name,
    type: 'file',
  }, { challenge: true });
}

async function serveFolderZip(req, res, s, folderRoot, sub, label) {
  if (challengeGateZip(req, res)) return;
  const absDir = resolveWithin(folderRoot, sub);
  await assertRealWithin(folderRoot, absDir);
  const st = await fs.promises.stat(absDir);
  if (!st.isDirectory()) return sendError(req, res, 404, 'folderNotFound');
  const zipName = sub ? path.basename(absDir) : label;
  streamZip(req, res, absDir, zipName, () => incrementDownloads(s.id), {
    shareId: s.id,
    name: zipName,
    type: 'zip',
  });
}

// --- Feature 7: SHA-256 integrity manifests ---------------------------------
// Streaming SHA-256 of one file (no size limit, constant memory).
function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(abs);
    rs.on('error', reject);
    rs.on('data', (c) => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}
// Collects { rel, abs } for every file under rootAbs (recursively). `baseRel`
// prefixes the relative paths (so a folder item keeps its name in the manifest).
async function collectFiles(rootAbs, baseRel) {
  const out = [];
  async function walk(dir, rel) {
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) out.push({ rel: r, abs });
    }
  }
  await walk(rootAbs, baseRel || '');
  return out;
}
// Sends a `sha256sum`-compatible manifest ("<hex>  <path>\n") as a download, so
// the recipient can verify integrity after transfer (e.g. `sha256sum -c`).
async function sendSha256Manifest(res, files, downloadName) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  let out = '';
  for (const f of files) {
    try { out += `${await sha256File(f.abs)}  ${f.rel}\n`; } catch (_) {}
  }
  res.send(out || '# no files\n');
}
// Builds the file list backing a share (files + recursively-walked folders).
async function shareManifestFiles(s, folderRoot, sub) {
  if (folderRoot != null) {
    const absDir = resolveWithin(folderRoot, sub || '');
    await assertRealWithin(folderRoot, absDir);
    return collectFiles(absDir, '');
  }
  // file / collection share
  const items = shareItems(s) || [];
  const files = [];
  for (const it of items) {
    const abs = hostToContainer(it.hostPath);
    try {
      if ((await fs.promises.stat(abs)).isDirectory()) files.push(...(await collectFiles(abs, it.name)));
      else files.push({ rel: it.name, abs });
    } catch (_) {}
  }
  return files;
}

// Feature 6 — turns a list of selected relative paths (under folderRoot) into
// zip items. Each path is validated to stay within the root; missing entries are
// silently skipped. Capped to avoid abuse.
async function selectionToItems(folderRoot, rels) {
  const items = [];
  for (const rel of (Array.isArray(rels) ? rels : []).slice(0, 5000)) {
    if (typeof rel !== 'string' || !rel) continue;
    let abs;
    try { abs = resolveWithin(folderRoot, rel); await assertRealWithin(folderRoot, abs); } catch (_) { continue; }
    let st; try { st = await fs.promises.stat(abs); } catch (_) { continue; }
    items.push({ hostPath: containerToHost(abs), name: path.basename(rel), size: st.isFile() ? st.size : null, type: st.isDirectory() ? 'folder' : 'file' });
  }
  return items;
}
function parseSelList(v) { return String(v || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5000); }
const selParser = express.urlencoded({ extended: false, limit: '512kb' });

// Resolves a folder item of a collection from :idx; sends 404 and returns null
// if the share isn't a collection or the item isn't a folder.
function collectionFolderItem(req, res, s) {
  const items = shareItems(s);
  const idx = clampIndex(req.params.idx, items ? items.length : 0);
  const item = items && items[idx];
  if (!item || item.type !== 'folder') {
    sendError(req, res, 404, 'notFound');
    return null;
  }
  return { item, idx };
}

downloadRouter.get(['/s/:token/browse', '/s/:token/browse/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'folder') return sendError(req, res, 404, 'notFound');
  try {
    await serveFolderBrowse(req, res, s, hostToContainer(s.hostPath), req.params[0] || '', `/s/${req.params.token}`, s.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

downloadRouter.get('/s/:token/file/*', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'folder') return sendError(req, res, 404, 'notFound');
  try {
    await serveFolderFile(req, res, s, hostToContainer(s.hostPath), req.params[0] || '');
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

downloadRouter.get(['/s/:token/zip', '/s/:token/zip/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'folder') return sendError(req, res, 404, 'notFound');
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  try {
    await serveFolderZip(req, res, s, hostToContainer(s.hostPath), req.params[0] || '', s.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

// SHA-256 checksum manifest for a download share (file, collection or folder).
downloadRouter.get(['/s/:token/sha256', '/s/:token/sha256/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  try {
    const files = s.type === 'folder'
      ? await shareManifestFiles(s, hostToContainer(s.hostPath), req.params[0] || '')
      : await shareManifestFiles(s, null);
    await sendSha256Manifest(res, files, (s.name || 'files') + '.sha256');
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

// Feature 6 — download a selection of files as one .zip (folder or collection).
downloadRouter.post('/s/:token/zip-select', selParser, async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s) return;
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  let items = [];
  if (s.type === 'folder') {
    items = await selectionToItems(hostToContainer(s.hostPath), parseSelList(req.body.sel));
  } else if (s.type === 'file') {
    const all = shareItems(s) || [];
    items = parseSelList(req.body.idx)
      .map((n) => all[parseInt(n, 10)]).filter(Boolean)
      .map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type }));
  } else {
    return sendError(req, res, 404, 'notFound');
  }
  if (!items.length) return sendError(req, res, 400, 'notFound');
  streamZipFiles(req, res, items, (s.name || 'selection'), () => incrementDownloads(s.id),
    { shareId: s.id, name: s.name || 'selection', type: 'collection-zip' });
});

// --- Folder items inside a collection (a `file`-type share with folder items) ---
downloadRouter.get(['/s/:token/item/:idx/browse', '/s/:token/item/:idx/browse/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const r = collectionFolderItem(req, res, s);
  if (!r) return;
  try {
    await serveFolderBrowse(req, res, s, hostToContainer(r.item.hostPath), req.params[0] || '', `/s/${req.params.token}/item/${r.idx}`, r.item.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

downloadRouter.get('/s/:token/item/:idx/file/*', async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'file') return sendError(req, res, 404, 'notFound');
  const r = collectionFolderItem(req, res, s);
  if (!r) return;
  try {
    await serveFolderFile(req, res, s, hostToContainer(r.item.hostPath), req.params[0] || '');
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

downloadRouter.get(['/s/:token/item/:idx/zip', '/s/:token/item/:idx/zip/*'], async (req, res) => {
  const s = requireActiveShare(req, res);
  if (!s || s.type !== 'file') return sendError(req, res, 404, 'notFound');
  if (!zipAllowed(s)) return sendError(req, res, 404, 'notFound');
  const r = collectionFolderItem(req, res, s);
  if (!r) return;
  try {
    await serveFolderZip(req, res, s, hostToContainer(r.item.hostPath), req.params[0] || '', r.item.name);
  } catch (e) {
    sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'folderUnavailable');
  }
});

// --- File reception (reception links) ---

function safeUploadName(name) {
  let n = String(name || '').replace(/\\/g, '/');
  n = n.split('/').pop() || ''; // basename only
  n = n
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join('');
  n = n.replace(/^\.+/, '').trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (n.length > 200) n = n.slice(-200);
  return n;
}

// Normalizes an extension list (array or "jpg, png ..." string) to lowercase
// bare extensions (no dot, alphanumerics only), de-duplicated and capped.
function normExtList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  const out = [];
  for (let e of arr) {
    e = String(e || '').trim().toLowerCase().replace(/^\*?\.?/, '').replace(/[^a-z0-9]/g, '');
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= 40) break;
  }
  return out;
}

// Extension (lowercase, no dot) of a filename/relative path, '' if none.
function fileExt(name) {
  const b = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

// Reception-link quota/filter gate. Returns null when allowed, otherwise an
// error code. sizeHint is the announced size (Content-Length); 0 if unknown.
function inboxRejectReason(s, name, sizeHint) {
  const ext = fileExt(name);
  const block = Array.isArray(s.blockExt) ? s.blockExt : [];
  const allow = Array.isArray(s.allowExt) ? s.allowExt : [];
  if (block.length && block.includes(ext)) return 'ext-blocked';
  if (allow.length && !allow.includes(ext)) return 'ext-not-allowed';
  if (s.maxFiles > 0 && (s.downloads || 0) >= s.maxFiles) return 'max-files';
  if (s.maxFileBytes > 0 && sizeHint > 0 && sizeHint > s.maxFileBytes) return 'file-too-large';
  if (s.maxTotalBytes > 0 && sizeHint > 0 && (s.bytesReceived || 0) + sizeHint > s.maxTotalBytes) return 'quota-full';
  return null;
}

// HTTP status for each reception rejection reason.
function inboxRejectStatus(reason) {
  if (reason === 'ext-blocked' || reason === 'ext-not-allowed') return 415;
  if (reason === 'file-too-large' || reason === 'quota-full') return 413;
  if (reason === 'max-files') return 409;
  return 400;
}

// Sanitizes a client-supplied relative path (folder upload). Returns
// { dirSegs, filename } with each segment cleaned and traversal removed, or
// null if unusable. Depth is capped to keep trees sane.
function safeUploadRelPath(rel) {
  const parts = String(rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) return null;
  const filename = safeUploadName(parts.pop());
  const dirSegs = parts.map((p) => safeUploadName(p)).filter((p) => p && p !== 'file').slice(0, 20);
  return { dirSegs, filename };
}

// Folder creation is stricter than file-name cleanup: reject invalid or
// platform-reserved names instead of silently rewriting them, so the visitor
// always knows the exact folder that was created.
function safeUploadFolderName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw || raw.length > 120 || raw === '.' || raw === '..') return null;
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(raw) || /[. ]$/.test(raw)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(raw)) return null;
  return raw;
}

function safeUploadParentSegments(rel) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (!raw) return [];
  if (raw.length > 2000) return null;
  const parts = raw.split('/');
  if (parts.length > 20 || parts.some((part) => !safeUploadFolderName(part))) return null;
  return parts;
}

// Feature 2 — when a reception link groups by sender, received files land in a
// <sender>/<YYYY-MM-DD>/ subfolder. Returns those path segments (or [] when off).
// The sender name comes from the visitor (?sender=), sanitized to one safe
// segment; empty falls back to "anonymous".
function senderSubdirSegs(s, req) {
  if (!s || !s.groupBySender) return [];
  let sender = String((req.query && req.query.sender) || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60);
  if (!sender) sender = 'anonymous';
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return [sender, date];
}

// Atomically reserves a destination name with an empty placeholder. A separate
// access-then-write check is racy: simultaneous uploads with the same name can
// both select it and truncate each other.
async function reserveUniqueUploadPath(dir, filename) {
  const realDir = await assertRealWithin(INBOX_DIR, dir);
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(realDir, filename);
  let i = 1;
  while (true) {
    try {
      const handle = await fs.promises.open(candidate, 'wx', 0o600);
      await handle.close();
      return candidate;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
    candidate = i > 9999
      ? path.join(realDir, `${base}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`)
      : path.join(realDir, `${base} (${i})${ext}`);
    i++;
  }
}

// Serializes the final quota check and counter update for one reception link.
// Node can process several completed uploads concurrently; without this small
// critical section they can all observe the same remaining quota and exceed it.
const shareUploadLocks = new Map();
async function withShareUploadLock(shareId, fn) {
  const previous = shareUploadLocks.get(shareId) || Promise.resolve();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(() => hold);
  shareUploadLocks.set(shareId, current);
  await previous.catch(() => {});
  try { return await fn(); }
  finally {
    release();
    if (shareUploadLocks.get(shareId) === current) shareUploadLocks.delete(shareId);
  }
}

// --- Resumable uploads: one .part file per upload, keyed by a client-supplied id ---
const PARTS_DIR = path.join(INBOX_DIR, '.dxparts');
// Feature 8 — moderation queue: files uploaded to a moderated link wait here
// until an admin approves (moved to the target folder) or rejects (deleted).
const PENDING_DIR = path.join(INBOX_DIR, '.dxpending');

// Records a pending (awaiting-moderation) upload: stashes the finished file under
// PENDING_DIR and adds its metadata to state.meta.pending. Returns true on success.
async function stashPending(s, srcPart, rel, req) {
  try { await fs.promises.mkdir(PENDING_DIR, { recursive: true }); } catch (_) {}
  const id = crypto.randomBytes(9).toString('hex');
  let pendingReal;
  try { pendingReal = await assertRealWithin(INBOX_DIR, PENDING_DIR); }
  catch (_) { return false; }
  const dest = path.join(pendingReal, id);
  try { await fs.promises.rename(srcPart, dest); }
  catch (_) {
    try { await fs.promises.copyFile(srcPart, dest); await fs.promises.unlink(srcPart); }
    catch (e) { return false; }
  }
  let size = 0;
  try { size = (await fs.promises.stat(dest)).size; } catch (_) {}
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!Array.isArray(state.meta.pending)) state.meta.pending = [];
  const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
  state.meta.pending.unshift({ id, shareId: s.id, shareName: s.name, name: rel || 'file', size, ip: pubIp(ip), at: Date.now() });
  if (state.meta.pending.length > 2000) state.meta.pending.length = 2000;
  persist();
  return true;
}

// Feature 2 — scans a file via clamd's INSTREAM protocol. Resolves
// { infected, virus } | { infected:false } | { error }. Fails open (returns
// { error }) so a scanner outage never silently drops uploads — the caller
// decides what to do on error (here: let the file through, but log it).
function scanFile(absPath) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { socket.destroy(); } catch (_) {} resolve(r); };
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    let reply = '';
    const handle = () => {
      if (/FOUND/.test(reply)) { const m = /:\s*(.+?)\s+FOUND/.exec(reply); finish({ infected: true, virus: m ? m[1] : 'malware' }); }
      else if (/\bOK\b/.test(reply)) finish({ infected: false });
      else if (/ERROR/.test(reply)) finish({ error: reply.trim() });
    };
    socket.setTimeout(180000, () => finish({ error: 'timeout' }));
    socket.on('error', (e) => finish({ error: e.message }));
    socket.on('data', (d) => { reply += d.toString('utf8'); handle(); });
    socket.on('end', () => handle());
    socket.on('close', () => finish({ error: reply.trim() || 'no-reply' }));
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const rs = fs.createReadStream(absPath, { highWaterMark: 64 * 1024 });
      rs.on('data', (chunk) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length, 0);
        socket.write(len); socket.write(chunk);
      });
      rs.on('end', () => { const z = Buffer.alloc(4); z.writeUInt32BE(0, 0); socket.write(z); });
      rs.on('error', () => finish({ error: 'read-error' }));
    });
  });
}
// Moves an infected upload to the quarantine folder and alerts the admin.
async function quarantineFile(src, name, s, virus, req) {
  try { await fs.promises.mkdir(QUARANTINE_DIR, { recursive: true }); } catch (_) {}
  const dest = path.join(QUARANTINE_DIR, crypto.randomBytes(8).toString('hex') + '-' + safeUploadName(name));
  try { await fs.promises.rename(src, dest); } catch (_) { try { await fs.promises.unlink(src); } catch (e) {} }
  logAudit('upload-infected', { username: 'system', ip: clientIp(req), detail: (s.name || s.id) + ': ' + name + ' [' + virus + ']' });
  dispatch('security', `${APP_NAME} — Infected upload blocked`,
    `🦠 ${APP_NAME} — Infected upload blocked on "${s.name || ''}": ${name} [${virus}]`,
    { share: s.name || null, name, virus });
}
// Scans a finished upload part when antivirus is enabled. Returns true if it is
// safe to deliver; false if it was infected (already quarantined + alerted).
async function scanGate(part, name, s, req) {
  if (!clamavEnabled()) return true;
  const r = await scanFile(part);
  if (r.infected) { await quarantineFile(part, name, s, r.virus, req); return false; }
  if (r.error) console.error('[clamav] scan error (delivering unscanned):', r.error);
  return true;
}
function safeUploadId(id) {
  return /^[A-Za-z0-9_-]{6,64}$/.test(String(id || '')) ? String(id) : null;
}
function scopedUploadId(s, id) {
  return crypto.createHash('sha256').update(String(s.id)).update('\0').update(id).digest('hex');
}
function partPath(s, id) {
  return path.join(PARTS_DIR, scopedUploadId(s, id));
}
// Periodically drop abandoned partials (an interrupted upload never resumed).
setInterval(() => {
  fs.readdir(PARTS_DIR, (err, names) => {
    if (err) return;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const n of names) {
      const p = path.join(PARTS_DIR, n);
      fs.stat(p, (e, st) => { if (!e && st.mtimeMs < cutoff) fs.unlink(p, () => {}); });
    }
  });
}, 3600 * 1000).unref();

// Feature 1 — chunked uploads: all chunk requests of one upload share a SINGLE
// transfer (keyed by upload id) so the admin live view / history show one
// advancing row instead of one per chunk. `stoppedUploads` blocks further chunks
// after an admin stop (so the client can't silently restart the upload).
const uploadTransfers = new Map(); // upload id -> transfer (spans chunk requests)
const stoppedUploads = new Map();  // upload id -> expiry ms
const uploadsInFlight = new Set();  // upload ids whose chunk is currently being written
let activePublicUploads = 0;

function beginPublicUpload(req, res) {
  if (activePublicUploads >= MAX_CONCURRENT_UPLOADS) {
    req.resume();
    res.setHeader('Retry-After', '5');
    res.status(429).json({ error: 'too-many-uploads' });
    return false;
  }
  activePublicUploads++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activePublicUploads = Math.max(0, activePublicUploads - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
    const err = new Error('upload-timeout');
    err.code = 'UPLOAD_TIMEOUT';
    req.destroy(err);
  });
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of uploadTransfers) {
    if (now - (t.lastActivity || t.startedAt) > 5 * 60 * 1000) { // upload abandoned mid-way
      uploadTransfers.delete(id);
      uploadsInFlight.delete(id);
      try { endTransfer(t, false, 'timeout'); } catch (_) {}
    }
  }
  for (const [id, exp] of stoppedUploads) if (exp < now) stoppedUploads.delete(id);
}, 60 * 1000).unref();

// Hourly webhook housekeeping: proactive expiry alerts (feature 5) and the
// periodic activity digest (feature 9). Both are no-ops unless enabled + a
// webhook is configured. Runs once shortly after boot, then every hour.
function webhookHousekeeping() {
  try { checkExpiringShares(); } catch (e) { console.error('[expiry-alert]', e.message); }
  try { maybeSendDigest(false); } catch (e) { console.error('[digest]', e.message); }
  try { purgeOldLog(); } catch (e) { console.error('[log-retention]', e.message); }
  try { purgeOldInbox(); } catch (e) { console.error('[inbox-retention]', e.message); }
  try { purgeExpiredFiles(); } catch (e) { console.error('[file-expiry]', e.message); }
  try { purgeExpiredSecrets(); } catch (e) { console.error('[secrets]', e.message); }
  try { maybeRunScheduledBackup(); } catch (e) { console.error('[backup]', e.message); }
}

// ===================================================================
//  Scheduled full backup + one-click restore
// ===================================================================
// A backup bundles the whole store (shares + settings), the transfer journal and
// the secret notes into a single file, encrypted with DATA_KEY when it is set.
// It is pushed to a local folder, a WebDAV collection, or an S3-compatible bucket.

// Filesystem/URL-safe timestamp: YYYYMMDD-HHMMSS (local time).
function backupStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function backupFilename() { return `direct-xfer-backup-${backupStamp()}.dxbackup`; }

// Gathers everything worth restoring into one object.
function buildBackupBundle() {
  const secrets = {};
  try {
    for (const f of fs.readdirSync(SECRETS_DIR)) {
      try { secrets[f] = fs.readFileSync(path.join(SECRETS_DIR, f)).toString('base64'); } catch (_) {}
    }
  } catch (_) {}
  let journal = '';
  try { journal = fs.readFileSync(LOG_FILE, 'utf8'); } catch (_) {} // bounded by MAX_LOG_BYTES/trim
  return {
    app: APP_NAME, kind: 'dxbackup', v: 1, appVersion: APP_VERSION,
    createdAt: Date.now(), encrypted: !!DATA_KEY,
    store: state, journal, secrets,
  };
}

// Bundle → on-the-wire string. Reuses the store's AES-256-GCM envelope (DATA_KEY)
// so a backup is encrypted exactly like shares.json at rest.
function serializeBackup(bundle) {
  const json = JSON.stringify(bundle);
  return DATA_KEY ? encryptStore(json) : json;
}
function parseBackup(raw) {
  const obj = JSON.parse(raw);
  let bundle = obj;
  if (obj && obj.dxenc) {
    if (!DATA_KEY) { const e = new Error('data-key-required'); e.code = 'DATA_KEY_REQUIRED'; throw e; }
    try { bundle = JSON.parse(decryptStore(obj)); }
    catch (_) { const e = new Error('data-key-invalid'); e.code = 'DATA_KEY_INVALID'; throw e; }
  }
  if (!bundle || bundle.kind !== 'dxbackup' || !bundle.store || !Array.isArray(bundle.store.shares)) {
    const e = new Error('invalid-backup'); e.code = 'INVALID_BACKUP'; throw e;
  }
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
  const res = await fetch(base + encodeURIComponent(filename), { method: 'PUT', headers, body: buf, signal: AbortSignal.timeout(120000) });
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
  const res = await fetch(s.backupS3Endpoint.replace(/\/+$/, '') + encPath, {
    method: 'PUT',
    headers: { Authorization: authorization, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, 'Content-Type': 'application/octet-stream' },
    body: buf, signal: AbortSignal.timeout(120000),
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
    return { filename, dest: 'local:' + s.backupLocalDir, size: buf.length, encrypted: !!DATA_KEY };
  }
  if (dest === 'webdav') {
    if (!s.backupWebdavUrl) throw new Error('no-webdav-url');
    await putBackupWebdav(s, filename, buf);
    return { filename, dest: 'webdav', size: buf.length, encrypted: !!DATA_KEY };
  }
  if (dest === 's3') {
    if (!s.backupS3Endpoint || !s.backupS3Bucket || !s.backupS3Key || !s.backupS3Secret) throw new Error('s3-incomplete');
    await putBackupS3(s, filename, buf);
    return { filename, dest: 's3', size: buf.length, encrypted: !!DATA_KEY };
  }
  throw new Error('bad-dest');
}

function setBackupStatus(st) {
  if (!state.meta) state.meta = {};
  state.meta.lastBackup = st;
  scheduleFlush();
}

// Runs a backup, records status, notifies and audits. `who` is 'system' or 'admin'.
async function performBackup(who) {
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
    setBackupStatus({ at: Date.now(), ok: false, dest: getSettings().backupDestType, file: null, size: 0, encrypted: !!DATA_KEY, error: msg });
    dispatch('backup', `${APP_NAME} — backup FAILED`, `⚠️ ${APP_NAME} — backup failed: ${msg}`, { error: msg });
    logAudit('backup-failed', { username: who || 'system', detail: msg });
    return { ok: false, error: msg };
  }
}

// Called hourly by webhookHousekeeping: runs the backup when the schedule is due.
function maybeRunScheduledBackup() {
  const s = getSettings();
  if (!s.backupEnabled) return;
  const now = new Date();
  if (now.getHours() !== Math.floor(Number(s.backupHour) || 0)) return;
  if (s.backupInterval === 'weekly' && now.getDay() !== Math.floor(Number(s.backupWeekday) || 0)) return;
  const last = (state.meta && state.meta.lastBackup && state.meta.lastBackup.at) || 0;
  const minGap = s.backupInterval === 'weekly' ? 6 * DAY_MS : 20 * 3600 * 1000; // avoid double-runs
  if (now.getTime() - last < minGap) return;
  performBackup('system');
}

// Destructive: replaces the whole store, journal and secret notes from a bundle.
function applyRestore(bundle) {
  const p = bundle.store || {};
  if (!Array.isArray(p.shares)) { const e = new Error('invalid-backup'); e.code = 'INVALID_BACKUP'; throw e; }
  state = {
    version: 1,
    shares: p.shares,
    settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
    history: Array.isArray(p.history) ? p.history.slice(0, HISTORY_MAX) : [],
    photoHistory: normalizePhotoHistory(p.photoHistory),
    stats: (p.stats && typeof p.stats === 'object') ? p.stats : {},
    meta: (p.meta && typeof p.meta === 'object') ? p.meta : {},
    audit: Array.isArray(p.audit) ? p.audit.slice(0, AUDIT_MAX) : [],
    ipNames: (p.ipNames && typeof p.ipNames === 'object') ? p.ipNames : {},
  };
  historyViewRevision++;
  reindex();
  persistNow();
  setImmediate(() => migrateLegacyPhotoStorage().catch((e) => console.error('[images] restore migration failed:', e.message)));
  if (typeof bundle.journal === 'string') { try { fs.writeFileSync(LOG_FILE, bundle.journal, { mode: 0o600 }); } catch (_) {} }
  if (bundle.secrets && typeof bundle.secrets === 'object') {
    try { fs.mkdirSync(SECRETS_DIR, { recursive: true }); } catch (_) {}
    for (const [name, b64] of Object.entries(bundle.secrets)) {
      const safe = path.basename(String(name)); // never let a bundled name escape SECRETS_DIR
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(safe)) continue;
      try { fs.writeFileSync(path.join(SECRETS_DIR, safe), Buffer.from(String(b64), 'base64'), { mode: 0o600 }); } catch (_) {}
    }
  }
}

// Feature 5 — drop secret notes whose expiry has passed (unread ones).
function purgeExpiredSecrets() {
  const m = state.meta && state.meta.secrets;
  if (!m) return;
  const now = Date.now();
  for (const token of Object.keys(m)) {
    if (m[token] && m[token].expiresAt && now > m[token].expiresAt) {
      try { fs.unlinkSync(path.join(SECRETS_DIR, token + '.dxe')); } catch (_) {}
      delete m[token];
    }
  }
}
setTimeout(webhookHousekeeping, 60 * 1000).unref();
setInterval(webhookHousekeeping, 3600 * 1000).unref();

// Purge transfers.log entries older than logRetentionDays (0 = keep all). Rewrites
// the journal keeping only recent lines (complements the size-based trim).
function purgeOldLog() {
  const days = Math.floor(Number(getSettings().logRetentionDays)) || 0;
  if (days <= 0) return;
  const cutoff = Date.now() - days * DAY_MS;
  let lines;
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n'); } catch (_) { return; }
  const nonEmpty = lines.filter(Boolean);
  const kept = nonEmpty.filter((line) => {
    try { const r = JSON.parse(line); return (r.endedAt || r.startedAt || 0) >= cutoff; } catch (_) { return false; }
  });
  if (kept.length === nonEmpty.length) return; // nothing to drop
  try {
    fs.writeFileSync(LOG_FILE + '.tmp', kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600 });
    fs.renameSync(LOG_FILE + '.tmp', LOG_FILE);
  } catch (e) { console.error('[log] retention purge failed:', e.message); }
}

// Reads at most maxBytes from the END of the transfer journal and returns the
// complete lines it contains (dropping a leading partial line). The dashboard only
// needs the recent tail, so this avoids loading a multi-hundred-MB transfers.log
// fully into memory (and blocking the event loop) just to keep the last N lines.
function readLogTail(maxBytes) {
  let fh;
  try {
    fh = fs.openSync(LOG_FILE, 'r');
    const size = fs.fstatSync(fh).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    if (want > 0) fs.readSync(fh, buf, 0, want, size - want);
    let text = buf.toString('utf8');
    if (want < size) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); } // drop the partial first line
    return text.split('\n');
  } catch (_) {
    return [];
  } finally {
    if (fh !== undefined) try { fs.closeSync(fh); } catch (_) {}
  }
}

// Non-blocking variant for HTTP handlers. Reading and parsing a busy 8–16 MB
// journal must not pause downloads and uploads on Node's single event loop.
async function readLogTailAsync(maxBytes) {
  let fh;
  try {
    fh = await fs.promises.open(LOG_FILE, 'r');
    const size = (await fh.stat()).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    if (want > 0) await fh.read(buf, 0, want, size - want);
    let text = buf.toString('utf8');
    if (want < size) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text.split('\n');
  } catch (_) {
    return [];
  } finally {
    if (fh) try { await fh.close(); } catch (_) {}
  }
}

// Delete received files older than inboxRetentionDays (0 = never). Walks INBOX_DIR,
// skips the .dxparts staging area, removes stale files and prunes empty folders.
// Destructive — off by default; applies to reception & collaboration uploads.
function purgeOldInbox() {
  const days = Math.floor(Number(getSettings().inboxRetentionDays)) || 0;
  if (days <= 0) return;
  const cutoff = Date.now() - days * DAY_MS;
  const walk = (dir, top) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (top && e.name === '.dxparts') continue; // resumable-upload staging
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, false);
        try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch (_) {}
      } else if (e.isFile()) {
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
      }
    }
  };
  walk(INBOX_DIR, true);
}

// Per-file expiry (PWA "self-destruct"): a visitor may ask that THEIR uploaded file
// be deleted after a delay. We record absolutePath -> expiresAt in state.meta and a
// housekeeping pass removes files whose time has come. Independent of the global
// inboxRetentionDays sweep above (which is mtime-based and off by default).
const MAX_FILE_EXPIRE_SEC = 90 * 24 * 3600; // clamp: at most 90 days
function clampExpireSec(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_FILE_EXPIRE_SEC, n);
}
function fileExpiryMap() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!state.meta.fileExpiry || typeof state.meta.fileExpiry !== 'object') state.meta.fileExpiry = {};
  return state.meta.fileExpiry;
}
function recordFileExpiry(absPath, sec) {
  if (!absPath || sec <= 0) return;
  const map = fileExpiryMap();
  map[absPath] = Date.now() + sec * 1000;
  if (Object.keys(map).length > 20000) { // sane cap; drop the soonest-expired stale keys
    const now = Date.now();
    for (const k of Object.keys(map)) { if (map[k] <= now) delete map[k]; }
  }
  persist();
}
function purgeExpiredFiles() {
  const map = (state.meta && state.meta.fileExpiry) || null;
  if (!map) return;
  const now = Date.now();
  let changed = false;
  for (const p of Object.keys(map)) {
    const exp = map[p];
    if (!exp || exp <= now) {
      try { fs.unlinkSync(p); } catch (_) {}
      delete map[p]; changed = true;
    } else {
      try { fs.statSync(p); } catch (_) { delete map[p]; changed = true; } // file already gone
    }
  }
  if (changed) persist();
}

// Reception page: the visitor uploads files.
downloadRouter.get('/u/:token', (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || s.type !== 'inbox' || !isActive(s)) return sendError(req, res, 404, 'shareGone');
  if (s.pwHash && !isUnlocked(req, s)) {
    return res.status(401).type('html').send(passwordPage(pickLang(req), s, false, req.params.token));
  }
  bumpViews(s, req); // live views / unique-visitors counter (admin page)
  res.type('html').send(inboxPage(pickLang(req), s));
});

// ===================================================================
//  COLLABORATION LINKS (/c/:token) — a live, two-way shared folder:
//  visitors browse + download AND upload, and (optionally) delete.
//  Files live under INBOX_DIR/<relDir> (the only writable location).
// ===================================================================
function collabRoot(s) { return resolveWithin(INBOX_DIR, s.relDir || ''); }

// Recursively sums the byte size of a folder (best-effort; used to keep the
// soft quota counter honest when a visitor deletes a subfolder).
async function folderBytes(dir) {
  let total = 0;
  let ents;
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await folderBytes(p);
      else if (e.isFile()) total += (await fs.promises.stat(p)).size;
    } catch (_) {}
  }
  return total;
}

// Resolves an active, unlocked collab share for the current request, or sends the
// appropriate page/error and returns null.
function requireActiveCollab(req, res) {
  const s = getByToken(req.params.token);
  if (!s || s.type !== 'collab' || !isActive(s)) { sendError(req, res, 404, 'shareGone'); return null; }
  if (s.pwHash && !isUnlocked(req, s)) {
    res.status(401).type('html').send(passwordPage(pickLang(req), s, false, req.params.token));
    return null;
  }
  return s;
}

downloadRouter.get('/c/:token', (req, res) => {
  const s = requireActiveCollab(req, res);
  if (!s) return;
  bumpViews(s, req); // live views / unique-visitors counter (admin page)
  res.type('html').send(collabPage(pickLang(req), s));
});

// Live JSON listing of the collab folder (polled by the client for live updates).
downloadRouter.get('/c/:token/list', async (req, res) => {
  const s = requireActiveCollab(req, res);
  if (!s) return;
  const root = collabRoot(s);
  try { await fs.promises.mkdir(root, { recursive: true }); } catch (_) {}
  const sub = String(req.query.sub || '');
  let absDir;
  try {
    absDir = resolveWithin(root, sub);
    await assertRealWithin(root, absDir);
    if (!(await fs.promises.stat(absDir)).isDirectory()) return res.status(404).json({ error: 'not-dir' });
  } catch (_) { return res.status(404).json({ error: 'not-found' }); }
  const entries = await listDir(absDir);
  const joinRel = (child) => (sub ? sub.replace(/\/+$/, '') + '/' + child : child);
  res.json({
    sub,
    allowDelete: !!s.allowDelete,
    allowZip: s.allowZip !== false,
    bytesReceived: s.bytesReceived || 0,
    maxTotalBytes: s.maxTotalBytes || 0,
    entries: entries.map((e) => ({ name: e.name, isDir: e.isDir, size: e.size, rel: joinRel(e.name) })),
  });
});

downloadRouter.get(['/c/:token/file', '/c/:token/file/*'], async (req, res) => {
  const s = requireActiveCollab(req, res);
  if (!s) return;
  try { await serveFolderFile(req, res, s, collabRoot(s), req.params[0] || ''); }
  catch (e) { sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable'); }
});

downloadRouter.get(['/c/:token/zip', '/c/:token/zip/*'], async (req, res) => {
  const s = requireActiveCollab(req, res);
  if (!s) return;
  if (s.allowZip === false) return sendError(req, res, 404, 'notFound');
  try { await serveFolderZip(req, res, s, collabRoot(s), req.params[0] || '', s.name); }
  catch (_) { sendError(req, res, 404, 'folderNotFound'); }
});

downloadRouter.get(['/c/:token/sha256', '/c/:token/sha256/*'], async (req, res) => {
  const s = requireActiveCollab(req, res);
  if (!s) return;
  try {
    const files = await shareManifestFiles(s, collabRoot(s), req.params[0] || '');
    await sendSha256Manifest(res, files, (s.name || 'files') + '.sha256');
  } catch (_) { sendError(req, res, 404, 'folderNotFound'); }
});

downloadRouter.post('/c/:token/zip-select', selParser, async (req, res) => {
  const s = requireActiveCollab(req, res);
  if (!s) return;
  if (s.allowZip === false) return sendError(req, res, 404, 'notFound');
  const items = await selectionToItems(collabRoot(s), parseSelList(req.body.sel));
  if (!items.length) return sendError(req, res, 400, 'notFound');
  streamZipFiles(req, res, items, (s.name || 'selection'), () => incrementDownloads(s.id),
    { shareId: s.id, name: s.name || 'selection', type: 'collection-zip' });
});

// --- Feature 5: burn-after-read secret notes (/x/:token) --------------------
// Returns the live metadata for a secret, lazily purging it if expired.
function secretMeta(token) {
  const m = state.meta && state.meta.secrets;
  const rec = m && m[token];
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) { destroySecret(token); return null; }
  return rec;
}
// Removes a secret's ciphertext and metadata (the "burn").
function destroySecret(token) {
  try { fs.unlinkSync(path.join(SECRETS_DIR, token + '.dxe')); } catch (_) {}
  if (state.meta && state.meta.secrets && state.meta.secrets[token]) {
    delete state.meta.secrets[token];
    persistNow();
  }
}
downloadRouter.get('/x/:token', (req, res) => {
  const meta = secretMeta(req.params.token);
  if (!meta) return sendError(req, res, 404, 'secretGone');
  res.type('html').send(secretPage(pickLang(req), req.params.token, meta.mode));
});
// Hands out the ciphertext exactly once, then burns it. The whole handler is
// synchronous (no await) so two racing requests can't both read the secret.
downloadRouter.get('/x/:token/blob', (req, res) => {
  const token = req.params.token;
  const meta = secretMeta(token);
  if (!meta) return res.status(404).json({ error: 'gone' });
  let buf = null;
  try { buf = fs.readFileSync(path.join(SECRETS_DIR, token + '.dxe')); } catch (_) {}
  destroySecret(token); // burn-after-read
  if (!buf) return res.status(404).json({ error: 'gone' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

// Delete a file/subfolder from the collab folder — only when the link allows it.
const collabDeleteParser = express.json({ limit: '8kb' });
downloadRouter.post('/c/:token/delete', collabDeleteParser, async (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || s.type !== 'collab' || !isActive(s)) return res.status(403).json({ error: 'revoked' });
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
  if (!s.allowDelete) return res.status(403).json({ error: 'delete-disabled' });
  const rel = String((req.body && req.body.path) || '');
  if (!rel) return res.status(400).json({ error: 'missing-path' });
  const root = collabRoot(s);
  let abs;
  try {
    abs = resolveWithin(root, rel);
    await assertRealWithin(root, abs);
  } catch (_) { return res.status(400).json({ error: 'invalid-path' }); }
  if (path.resolve(abs) === path.resolve(root)) return res.status(400).json({ error: 'invalid-path' });
  try {
    const st = await fs.promises.stat(abs);
    let freed = 0;
    if (st.isDirectory()) { freed = await folderBytes(abs); await fs.promises.rm(abs, { recursive: true, force: true }); }
    else { freed = st.size; await fs.promises.unlink(abs); }
    s.bytesReceived = Math.max(0, (s.bytesReceived || 0) - freed);
    scheduleFlush();
    logAudit('collab-delete', { username: 'visitor', ip: clientIp(req), detail: (s.name || s.id) + ': ' + rel });
    res.json({ ok: true });
  } catch (_) { res.status(404).json({ error: 'not-found' }); }
});

// Share types that accept uploads: reception links and collaboration links.
function acceptsUpload(s) { return !!s && (s.type === 'inbox' || s.type === 'collab'); }

// Creates one visitor-requested folder below the share's writable root. Parent
// folders must already exist (except the optional sender/date prefix managed by
// the server), and real-path checks prevent a symlink from escaping INBOX_DIR.
const uploadFolderParser = express.json({ limit: '4kb' });
async function handleCreateUploadFolder(req, res) {
  const s = getByToken(req.params.token);
  if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });

  const body = req.body || {};
  const name = safeUploadFolderName(body.name);
  const parentSegs = safeUploadParentSegments(body.parent);
  if (!name || parentSegs === null) return res.status(400).json({ error: 'invalid-folder' });

  try {
    const root = resolveWithin(INBOX_DIR, s.relDir || '');
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const rootReal = await assertRealWithin(INBOX_DIR, root);

    // Reception links may add a server-managed <sender>/<date> prefix. Build it
    // one segment at a time and reject symlinks before entering them.
    const senderSegs = s.type === 'inbox' ? senderSubdirSegs(s, req) : [];
    let uploadRoot = rootReal;
    for (const segment of senderSegs) {
      const next = path.join(uploadRoot, segment);
      try { await fs.promises.mkdir(next, { mode: 0o700 }); }
      catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
      const st = await fs.promises.lstat(next);
      if (!st.isDirectory() || st.isSymbolicLink()) { const e = new Error('invalid-folder'); e.code = 'EPATH'; throw e; }
      uploadRoot = await assertRealWithin(rootReal, next);
    }

    const parent = resolveWithin(uploadRoot, parentSegs.join('/'));
    const parentReal = await assertRealWithin(uploadRoot, parent);
    if (!(await fs.promises.stat(parentReal)).isDirectory()) return res.status(400).json({ error: 'invalid-folder' });

    const target = path.join(parentReal, name);
    await fs.promises.mkdir(target, { mode: 0o700 }); // atomic: EEXIST is reported below
    await assertRealWithin(uploadRoot, target);

    const rel = [...parentSegs, name].join('/');
    logAudit('upload-folder-created', {
      username: 'visitor', ip: clientIp(req), detail: (s.name || s.id) + ': ' + rel,
    });
    res.status(201).json({ ok: true, name, path: rel });
  } catch (e) {
    if (e && e.code === 'EEXIST') return res.status(409).json({ error: 'folder-exists' });
    if (e && e.code === 'ENOENT') return res.status(404).json({ error: 'parent-not-found' });
    if (e && (e.code === 'EPATH' || e.code === 'ENOTDIR' || e.code === 'EINVAL')) {
      return res.status(400).json({ error: 'invalid-folder' });
    }
    res.status(500).json({ error: 'folder-create-failed' });
  }
}
downloadRouter.post('/u/:token/folder', uploadFolderParser, handleCreateUploadFolder);
downloadRouter.post('/c/:token/folder', uploadFolderParser, handleCreateUploadFolder);

// Resume support: how many bytes of this upload id are already on disk.
function handleUploadStatus(req, res) {
  const s = getByToken(req.params.token);
  if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
  const id = safeUploadId(req.query.id);
  let offset = 0;
  if (id) { try { offset = fs.statSync(partPath(s, id)).size; } catch (_) {} }
  res.json({ offset });
}
downloadRouter.get('/u/:token/upload-status', handleUploadStatus);
downloadRouter.get('/c/:token/upload-status', handleUploadStatus);

// Explicitly abandon a resumable upload. The PWA calls this only when the user
// removes a queued item; ordinary network aborts keep the .part for later resume.
async function handleUploadCancel(req, res) {
  const s = getByToken(req.params.token);
  if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
  const id = safeUploadId(req.query.id);
  if (!id) return res.status(400).json({ error: 'invalid-id' });
  const uploadId = scopedUploadId(s, id);
  stoppedUploads.set(uploadId, Date.now() + 3600 * 1000);
  const transfer = uploadTransfers.get(uploadId);
  if (transfer && typeof transfer.abort === 'function') {
    try { transfer.abort(); } catch (_) {}
  } else {
    uploadsInFlight.delete(uploadId);
    uploadTransfers.delete(uploadId);
    try { await fs.promises.unlink(partPath(s, id)); }
    catch (e) { if (e && e.code !== 'ENOENT') return res.status(500).json({ error: 'write-error' }); }
    if (transfer) endTransfer(transfer, false, 'stopped');
  }
  res.json({ ok: true });
}
downloadRouter.post('/u/:token/upload-cancel', handleUploadCancel);
downloadRouter.post('/c/:token/upload-cancel', handleUploadCancel);

// Receiving a file. Resumable: the body carries the bytes FROM ?offset= to the end;
// they are appended to a .part file keyed by ?id=, moved into the destination tree
// once it reaches ?size=. An interrupted upload keeps its .part so the visitor can
// resume from the current offset. Legacy single-shot (no id) still works. The path
// comes via ?path= (folder upload, tree preserved) or ?name= (single file). Shared
// by reception links (/u/) and collaboration links (/c/).
async function handleUpload(req, res) {
  const s = getByToken(req.params.token);
  if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
  if (!beginPublicUpload(req, res)) return;

  const relRaw = req.query.path != null ? req.query.path : req.query.name;
  const parsed = safeUploadRelPath(relRaw) || { dirSegs: [], filename: 'file' };
  const relForCheck = [...parsed.dirSegs, parsed.filename].join('/');
  const senderSegs = senderSubdirSegs(s, req); // Feature 2: <sender>/<date>/ prefix (or [])

  const declared = parseInt(req.query.size, 10);
  const clen = parseInt(req.headers['content-length'], 10);
  const total = Number.isFinite(declared) && declared > 0 ? declared
    : (Number.isFinite(clen) && clen > 0 ? clen : 0);
  const id = safeUploadId(req.query.id);
  const uploadId = id ? scopedUploadId(s, id) : null;
  const expireSec = clampExpireSec(req.query.expire); // optional per-file self-destruct

  // Quota / filter gate (uses the announced total size).
  const reason = inboxRejectReason(s, relForCheck, total);
  if (reason) { req.resume(); return res.status(inboxRejectStatus(reason)).json({ error: reason }); }

  const displayName = parsed.dirSegs.length ? parsed.dirSegs.join('/') + '/' + parsed.filename : parsed.filename;
  const maxUp = effMaxUpload(); // per-file cap (UI setting overrides the env default)

  // Moves a completed .part into the destination tree, updates counters, replies.
  const finalize = async (part, transfer) => {
    uploadsInFlight.delete(uploadId); // append is done; release the per-id chunk lock
    // Antivirus (feature 2): scan before anything is delivered or queued.
    if (clamavEnabled() && !(await scanGate(part, parsed.filename, s, req))) {
      if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
      endTransfer(transfer, false, 'infected');
      if (!res.headersSent) res.status(422).json({ error: 'infected' });
      return;
    }
    // Moderation queue: divert to the pending area instead of the target folder.
    if (s.moderated) {
      const ok = await stashPending(s, part, [...parsed.dirSegs, parsed.filename].join('/'), req);
      if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
      endTransfer(transfer, !!ok, ok ? null : 'write-error');
      if (!res.headersSent) {
        if (ok) res.json({ ok: true, complete: true, moderated: true, name: parsed.filename });
        else res.status(500).json({ error: 'write-error' });
      }
      return;
    }
    let dir;
    try {
      dir = resolveWithin(INBOX_DIR, [s.relDir || '', ...senderSegs, ...parsed.dirSegs].join('/'));
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (_) {
      endTransfer(transfer, false, 'inbox-dir');
      if (!res.headersSent) res.status(500).json({ error: 'inbox-dir' });
      return;
    }
    const outcome = await withShareUploadLock(s.id, async () => {
      let size = 0;
      try { size = (await fs.promises.stat(part)).size; }
      catch (_) { return { error: 'write-error' }; }
      const finalReason = inboxRejectReason(s, relForCheck, size);
      if (finalReason) return { error: finalReason };
      let target;
      try { target = await reserveUniqueUploadPath(dir, parsed.filename); }
      catch (_) { return { error: 'write-error' }; }
      try {
        await fs.promises.rename(part, target);
      } catch (_) {
        try { await fs.promises.copyFile(part, target); await fs.promises.unlink(part); }
        catch (e) {
          try { await fs.promises.unlink(target); } catch (_) {}
          return { error: 'write-error' };
        }
      }
      s.bytesReceived = (s.bytesReceived || 0) + size;
      incrementDownloads(s.id);
      return { target, size };
    });
    if (outcome.error) {
      try { await fs.promises.unlink(part); } catch (_) {}
      if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
      endTransfer(transfer, false, outcome.error);
      if (!res.headersSent) res.status(outcome.error === 'write-error' ? 500 : inboxRejectStatus(outcome.error)).json({ error: outcome.error });
      return;
    }
    const target = outcome.target;
    if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
    if (expireSec > 0) { try { recordFileExpiry(target, expireSec); } catch (_) {} } // schedule self-destruct
    if (s.type === 'inbox') { try { emitInboxEvent(s, { type: 'received', name: path.basename(target), dest: s.name || '', at: Date.now() }); } catch (_) {} }
    endTransfer(transfer, true);
    if (!res.headersSent) {
      res.json({
        ok: true, complete: true, name: path.basename(target),
        filesReceived: s.downloads || 0, bytesReceived: s.bytesReceived || 0,
      });
    }
  };

  // --- Resumable / chunked path: append one chunk to a stable .part file ---
  if (id && total > 0) {
    const part = partPath(s, id);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (stoppedUploads.has(uploadId)) { req.resume(); return res.status(403).json({ error: 'stopped' }); }
    try { await fs.promises.mkdir(PARTS_DIR, { recursive: true }); } catch (_) {}
    let onDisk = 0;
    try { onDisk = (await fs.promises.stat(part)).size; } catch (_) {}
    if (offset !== onDisk) { req.resume(); return res.status(409).json({ error: 'offset-mismatch', offset: onDisk }); }

    // Serialize chunks of the SAME upload id: two concurrent chunk requests would
    // both pass the offset check above and then interleave their appends, corrupting
    // the .part. The lock is released on every exit path (finalize / fail / the
    // "chunk stored, more to come" reply). The client uploads chunks sequentially,
    // so a well-behaved uploader never sees this.
    if (uploadsInFlight.has(uploadId)) { req.resume(); return res.status(409).json({ error: 'busy', offset: onDisk }); }
    uploadsInFlight.add(uploadId);

    // One transfer per upload id, reused across every chunk request.
    let transfer = uploadTransfers.get(uploadId);
    if (!transfer) {
      transfer = startTransfer(req, { shareId: s.id, name: displayName, type: 'inbox', direction: 'up' }, total);
      transfer.notify = true;
      transfer.uploadId = uploadId;
      uploadTransfers.set(uploadId, transfer);
    }
    transfer.lastActivity = Date.now();
    transfer.bytes = offset; // cumulative baseline; this chunk adds on top

    if (onDisk >= total) { // already complete (client retrying after a lost reply)
      transfer.bytes = total; req.resume();
      return finalize(part, transfer);
    }

    const ws = fs.createWriteStream(part, { flags: 'a' }); // append from the current offset
    let failed = false, reqEnded = false, written = offset;

    const fail = (reason2, keepPart) => {
      if (failed) return; failed = true;
      uploadsInFlight.delete(uploadId); // release the per-id chunk lock on any failure
      try { req.unpipe(ws); ws.destroy(); if (!req.destroyed) req.resume(); } catch (_) {}
      if (!keepPart) { // discard on rejection/stop; keep on a network drop (for resume)
        fs.unlink(part, () => {});
        uploadTransfers.delete(uploadId);
        endTransfer(transfer, false, reason2 || 'aborted');
      }
      if (!res.headersSent) { try { res.status(inboxRejectStatus(reason2)).json({ error: reason2 || 'aborted' }); } catch (_) {} }
    };
    // Admin stop → block further chunks and drop the partial.
    transfer.abort = () => { stoppedUploads.set(uploadId, Date.now() + 3600 * 1000); fail('stopped', false); };

    req.on('end', () => { reqEnded = true; });
    req.on('close', () => { if (!reqEnded && !failed) fail('aborted', true); }); // keep .part for resume
    req.on('data', (chunk) => {
      written += chunk.length; transfer.bytes += chunk.length; transfer.lastActivity = Date.now();
      if (written > total) return fail('file-too-large', false);
      if (maxUp > 0 && written > maxUp) return fail('too-large', false);
      if (s.maxFileBytes > 0 && written > s.maxFileBytes) return fail('file-too-large', false);
      if (s.maxTotalBytes > 0 && (s.bytesReceived || 0) + written > s.maxTotalBytes) return fail('quota-full', false);
    });
    req.on('aborted', () => fail('aborted', true));
    req.on('error', () => fail('aborted', true));
    ws.on('error', () => fail('write-error', true));
    ws.on('finish', () => {
      if (failed) return;
      if (written < total) { // chunk stored, more to come: keep the transfer alive
        uploadsInFlight.delete(uploadId); // release so the next chunk of this upload can proceed
        if (!res.headersSent) res.status(409).json({ error: 'incomplete', offset: written });
        return;
      }
      finalize(part, transfer);
    });
    req.pipe(ws);
    return;
  }

  // --- Legacy single-shot path (no id) ---
  const moderated = !!s.moderated;
  let dir, target, finalName;
  if (moderated) {
    // Stream into a temp file under the pending area; stashPending finalizes it.
    try { await fs.promises.mkdir(PENDING_DIR, { recursive: true }); } catch (_) {}
    let pendingReal;
    try { pendingReal = await assertRealWithin(INBOX_DIR, PENDING_DIR); }
    catch (_) { return res.status(500).json({ error: 'inbox-dir' }); }
    target = path.join(pendingReal, 'tmp-' + crypto.randomBytes(8).toString('hex'));
    finalName = parsed.filename;
  } else {
    try {
      dir = resolveWithin(INBOX_DIR, [s.relDir || '', ...senderSegs, ...parsed.dirSegs].join('/'));
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (e) { return res.status(500).json({ error: 'inbox-dir' }); }
    try { target = await reserveUniqueUploadPath(dir, parsed.filename); }
    catch (_) { return res.status(500).json({ error: 'write-error' }); }
    finalName = path.basename(target);
  }
  const displayName2 = parsed.dirSegs.length ? parsed.dirSegs.join('/') + '/' + finalName : finalName;
  const ws = fs.createWriteStream(target, { flags: 'w' });
  const transfer = startTransfer(req, { shareId: s.id, name: displayName2, type: 'inbox', direction: 'up' }, total);
  transfer.notify = true;
  let failed = false, reqEnded = false;
  const fail = (reason2) => {
    if (failed) return; failed = true;
    try { req.unpipe(ws); ws.destroy(); if (!req.destroyed) req.resume(); } catch (_) {}
    fs.unlink(target, () => {});
    endTransfer(transfer, false, reason2 || 'aborted');
    if (!res.headersSent) { try { res.status(inboxRejectStatus(reason2)).json({ error: reason2 || 'aborted' }); } catch (_) {} }
  };
  transfer.abort = () => fail('stopped');
  req.on('end', () => { reqEnded = true; });
  req.on('close', () => { if (!reqEnded && !failed) fail('aborted'); });
  req.on('data', (chunk) => {
    transfer.bytes += chunk.length; transfer.lastActivity = Date.now();
    if (maxUp > 0 && transfer.bytes > maxUp) return fail('too-large');
    if (s.maxFileBytes > 0 && transfer.bytes > s.maxFileBytes) return fail('file-too-large');
    if (s.maxTotalBytes > 0 && (s.bytesReceived || 0) + transfer.bytes > s.maxTotalBytes) return fail('quota-full');
  });
  req.on('aborted', () => fail('aborted'));
  req.on('error', () => fail('aborted'));
  ws.on('error', () => fail('write-error'));
  ws.on('finish', async () => {
    if (failed) return;
    // Antivirus (feature 2): scan the finished file before delivering/queuing it.
    if (clamavEnabled() && !(await scanGate(target, finalName, s, req))) {
      endTransfer(transfer, false, 'infected');
      if (!res.headersSent) res.status(422).json({ error: 'infected' });
      return;
    }
    if (moderated) {
      const ok = await stashPending(s, target, displayName2, req);
      endTransfer(transfer, !!ok, ok ? null : 'write-error');
      if (!res.headersSent) {
        if (ok) res.json({ ok: true, moderated: true, name: finalName });
        else res.status(500).json({ error: 'write-error' });
      }
      return;
    }
    const finalReason = await withShareUploadLock(s.id, async () => {
      const reason3 = inboxRejectReason(s, relForCheck, transfer.bytes);
      if (reason3) return reason3;
      s.bytesReceived = (s.bytesReceived || 0) + transfer.bytes;
      incrementDownloads(s.id);
      return null;
    });
    if (finalReason) {
      failed = true;
      fs.unlink(target, () => {});
      endTransfer(transfer, false, finalReason);
      if (!res.headersSent) res.status(inboxRejectStatus(finalReason)).json({ error: finalReason });
      return;
    }
    endTransfer(transfer, true);
    if (!res.headersSent) res.json({ ok: true, name: finalName, filesReceived: s.downloads || 0, bytesReceived: s.bytesReceived || 0 });
  });
  req.pipe(ws);
}
downloadRouter.post('/u/:token/upload', handleUpload);
downloadRouter.post('/c/:token/upload', handleUpload);

// Unlocking a password-protected link (form on the access page).
const unlockParser = express.urlencoded({ extended: false, limit: '4kb' });
function unlockHandler(req, res) {
  const s = getByToken(req.params.token);
  if (!s || !isActive(s)) return sendError(req, res, 404, 'shareGone');
  // Redirect back to the token the visitor is actually on (main link or a
  // nominative sub-link), so a recipient stays on their own sub-link and their
  // downloads keep being attributed to them.
  const rel = linkPrefix(s) + req.params.token;
  if (!s.pwHash) return res.redirect(302, rel);

  // Brute-force protection: locks the IP after too many failed attempts.
  const ip = clientIp(req);
  const now = Date.now();
  const rec = unlockFails.get(ip) || { fails: [], lockUntil: 0 };
  if (!Array.isArray(rec.fails)) rec.fails = [];
  rec.fails = rec.fails.filter((ts) => now - ts < FAIL_WINDOW_MS);
  if (rec.lockUntil && now < rec.lockUntil) {
    return res.status(429).type('html').send(passwordPage(pickLang(req), s, true, req.params.token));
  }
  const entered = String((req.body && req.body.password) || '');
  if (!checkSharePassword(s, entered)) {
    rec.fails.push(now);
    if (rec.fails.length >= UNLOCK_MAX_FAILS) {
      rec.lockUntil = now + lockMs();
      rec.fails = [];
    }
    unlockFails.set(ip, rec);
    return res.status(401).type('html').send(passwordPage(pickLang(req), s, true, req.params.token));
  }
  unlockFails.delete(ip);
  // Upgrade a legacy SHA-256 link hash to scrypt on first successful unlock.
  if (!parseHash(s.pwHash)) {
    s.pwHash = hashPassword(entered);
    delete s.pwSalt;
    scheduleFlush();
  }
  setUnlockCookie(req, res, s);
  res.redirect(302, rel);
}
downloadRouter.post('/s/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/u/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/c/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/i/:token/unlock', unlockParser, unlockHandler);
downloadRouter.post('/g/:token/unlock', unlockParser, unlockHandler);

// A visitor attaches a short message to a reception link (kept with the link,
// shown to the admin). Optional and independent from the file uploads.
const messageParser = express.json({ limit: '8kb' });
downloadRouter.post('/u/:token/message', messageParser, (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || s.type !== 'inbox' || !isActive(s)) return res.status(403).json({ error: 'revoked' });
  if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
  const text = String((req.body && req.body.message) || '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'empty' });
  // Optional per-file tag: the visitor-facing path of the file this note is about.
  const file = String((req.body && req.body.file) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 512);
  const decision = publicMessageDecision(req, s.token, text, file);
  if (decision.duplicate) return res.json({ ok: true, duplicate: true, notified: false });
  if (decision.retryAfter) {
    res.setHeader('Retry-After', String(decision.retryAfter));
    return res.status(429).json({ error: 'rate-limited', retryAfter: decision.retryAfter });
  }
  const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
  const geo = geoSync(ip) || {};
  if (!Array.isArray(s.messages)) s.messages = [];
  s.messages.unshift({ at: Date.now(), ip, country: geo.country || null, flag: geo.flag || '🌐', text, file: file || null });
  if (s.messages.length > 50) s.messages.length = 50; // keep the most recent
  persistNow(); // durable: a message must survive a restart
  geolocate(ip).catch(() => {}); // warm the cache for the admin view
  if (decision.notify) notify('message', { name: s.name, ip, country: geo.country, text, file: file || null });
  res.json({ ok: true, notified: decision.notify });
});

// ===================================================================
//  ADMIN ROUTES: protected API
// ===================================================================

const adminRouter = express.Router();
adminRouter.use(requireAuth);
// Authenticated API responses can contain paths, identities and configuration.
// Do not leave those responses in browser or intermediary caches.
adminRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Enforce the mandatory first-login/reset password change on the server. The UI
// prompt alone is not an authorization boundary and can be bypassed with direct
// API calls.
adminRouter.use((req, res, next) => {
  const acc = req.session && req.session.accountId ? getAccountById(req.session.accountId) : null;
  if (!accountNeedsPwChange(acc)) return next();
  if (req.path === '/session' || req.path === '/password' || req.path === '/logout') return next();
  return res.status(403).json({ error: 'password-change-required' });
});

// --- Granular roles (feature) -----------------------------------------------
// owner/admin: full access. operator: create links + manage ONLY their own,
// no global settings/accounts. auditor: read-only everywhere.
function ownsShare(req, s) {
  const role = req.session && req.session.role;
  // Auditors are globally read-only, but may inspect every link.
  if (role === 'owner' || role === 'admin' || role === 'auditor') return true;
  return !!(s && s.ownerId && s.ownerId === req.session.accountId);
}
function stampOwner(share, req) {
  share.ownerId = req.session.accountId || null;
  share.ownerName = req.session.username || null;
  return share;
}
function requireFullAdmin(req, res, next) {
  const role = req.session && req.session.role;
  if (role === 'owner' || role === 'admin') return next();
  return res.status(403).json({ error: 'forbidden' });
}
function requireAuditAccess(req, res, next) {
  const role = req.session && req.session.role;
  if (role === 'owner' || role === 'admin' || role === 'auditor') return next();
  return res.status(403).json({ error: 'forbidden' });
}
// Authorization gate applied to every /api admin route (after requireAuth).
adminRouter.use((req, res, next) => {
  const role = req.session.role;
  if (role === 'owner' || role === 'admin') return next();
  const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (role === 'auditor') return isRead ? next() : res.status(403).json({ error: 'read-only' });
  if (role === 'operator') {
    if (isRead) return next();
    const p = req.path;
    // Global admin surfaces an operator can't change.
    if (/^\/(settings|accounts|ip-names|backup-now|backup-test|shutdown|history|network\/port-check)\b/.test(p)) return res.status(403).json({ error: 'forbidden' });
    if (/^\/(webhook-test|email-test|digest-test)\b/.test(p)) return res.status(403).json({ error: 'forbidden' });
    if (/^\/shares\/(export|import)\b/.test(p)) return res.status(403).json({ error: 'forbidden' });
    // Per-share ownership for /shares/:id/... (create routes are handled inline).
    const m = /^\/shares\/([^/]+)/.exec(p);
    if (m && !['bulk', 'export', 'import'].includes(m[1])) {
      const s = getById(m[1]);
      if (s && !ownsShare(req, s)) return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  }
  // Unknown or corrupted roles never inherit administrative privileges.
  return res.status(403).json({ error: 'forbidden' });
});

function externalProto(req) {
  // req.protocol already honors X-Forwarded-Proto only when the peer is a
  // configured trusted proxy. Never accept that header independently.
  return req && req.protocol === 'https' ? 'https' : 'http';
}

// True when a Host header value (optionally with a port) is a bare IP literal
// rather than a domain name. Behind a reverse proxy the forwarded Host is often
// the container's LAN IP (e.g. "192.168.50.11:55750"); such a value must NOT be
// used as the default link base — only a real domain name may override the
// public IP.
function hostIsIpLiteral(host) {
  let h = String(host || '').trim();
  if (!h) return false;
  if (h[0] === '[') return true; // "[::1]:443" — bracketed IPv6 literal
  const c = h.indexOf(':');
  if (c !== -1 && c === h.lastIndexOf(':')) h = h.slice(0, c); // strip :port (IPv4/hostname)
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h); // IPv4 literal
}

// Normalizes an admin-entered domain/URL to an origin. '' if empty, null if invalid.
function normalizeLinkBase(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) {
    s = (/:\d+$/.test(s) ? 'http://' : 'https://') + s;
  }
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return null;
  }
}

// Link URL base: configured domain > PUBLIC_URL > reverse-proxy domain > PUBLIC_HOST > public IP > local IP.
// The reverse-proxy Host is honored ONLY when it is a real domain name; a bare
// IP (typically the container's LAN IP) is skipped so the default remains the
// public IP — a shareable link outside the local network.
function primaryBase(req) {
  const configured = getSettings().linkBase;
  if (configured) return configured;
  if (PUBLIC_URL) return PUBLIC_URL;
  // Behind a reverse proxy, the request host can be the real external domain —
  // but only if it actually is a domain. If the proxy forwards a bare IP as
  // Host, ignore it and fall through to the public IP below.
  if (TRUST_PROXY) {
    const host = String(req.get('host') || '').trim();
    // A request Host is untrusted input. Restrict it to a plain hostname/IP and
    // optional port before embedding it into links shown to the administrator.
    let validHost = false;
    if (/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
      try { validHost = !!new URL(`http://${host}`).hostname; } catch (_) {}
    }
    if (validHost && !hostIsIpLiteral(host)) return `${externalProto(req)}://${host}`;
  }
  if (PUBLIC_HOST) return `http://${PUBLIC_HOST}:${PORT}`;
  // Default: public IP, for a link shareable outside the local network.
  const ip = getPublicIPCached();
  if (ip) return `http://${ip}:${PORT}`;
  const locals = getLocalIPv4s();
  if (locals.length) return `http://${locals[0].address}:${PORT}`;
  return '';
}

function decorateShare(s, req) {
  const active = isActive(s);
  const items = shareItems(s);
  const rel = linkPrefix(s) + s.token;
  const base = primaryBase(req);
  return {
    id: s.id,
    token: s.token,
    type: s.type,
    name: s.name,
    hostPath: s.hostPath,
    relDir: s.relDir,
    size: s.size,
    createdAt: s.createdAt,
    startsAt: s.startsAt || null,
    expiresAt: s.expiresAt,
    maxDownloads: s.maxDownloads,
    downloads: s.downloads || 0,
    maxVisitors: s.maxVisitors || 0, // 0 = unlimited (feature 5)
    uniqueVisitors: Array.isArray(s.visitors) ? s.visitors.length : 0,
    views: s.views || 0, // total landing-page loads (all link types), live on the admin card
    favorite: s.type === 'photo' ? !!s.favorite : false,
    // Images page — direct image links (full-size + thumbnail), no relay page.
    // They can use their own optional domain (imageBase), else the main link base.
    photo: s.type === 'photo' ? (() => {
      const ib = getSettings().imageBase || base;
      const ps = photoStatsOf(s);
      return {
        ext: photoExt(s),
        imgUrl: ib ? ib + '/i/' + s.token + '.' + photoExt(s) : ('/i/' + s.token + '.' + photoExt(s)),
        thumbUrl: ib ? ib + '/i/' + s.token + '/thumb' : ('/i/' + s.token + '/thumb'),
        microUrl: ib ? ib + '/i/' + s.token + '/micro' : ('/i/' + s.token + '/micro'),
        hasThumb: !!s.thumb,
        hasMicro: !!s.micro,
        fullViews: ps.full.v || 0,
        fullVisitors: Array.isArray(ps.full.u) ? ps.full.u.length : 0,
        thumbViews: ps.thumb.v || 0,
        thumbVisitors: Array.isArray(ps.thumb.u) ? ps.thumb.u.length : 0,
        microViews: ps.micro.v || 0,
        microVisitors: Array.isArray(ps.micro.u) ? ps.micro.u.length : 0,
        w: s.w || null,
        h: s.h || null,
        uploadDeviceName: photoUploadDeviceName(s),
        metadataRemoved: !!s.metadataRemoved,
      };
    })() : null,
    // Shareable image gallery (feature 18): a public /g/<token> page over member images.
    album: s.type === 'album' ? (() => {
      const ib = getSettings().imageBase || base;
      return {
        count: Array.isArray(s.members) ? s.members.length : 0,
        members: Array.isArray(s.members) ? s.members.slice(0, 500) : [],
        url: ib ? ib + '/g/' + s.token : ('/g/' + s.token),
      };
    })() : null,
    itemCount: items ? items.length : null,
    items: items ? items.map((it) => ({ name: it.name, size: it.size, type: it.type })) : null,
    collection: !!s.collection, // true = a genuine multi-file bundle (keep listing its files even at 1)
    adminNote: s.adminNote || null, // private admin comment (never sent to visitors)
    disabled: !!s.disabled, // manually paused (reversible) — active is false while paused

    active,
    scheduled: isScheduled(s),
    hasPassword: !!s.pwHash,
    encrypted: !!s.encrypted, // end-to-end encrypted (server holds only ciphertext)
    encMode: s.encrypted ? (s.encMode || 'key') : null,
    allowZip: s.allowZip !== false, // false = "download all as .zip" disabled
    noPreview: !!s.noPreview, // true = in-browser preview disabled
    burnAfterDownload: !!s.burnAfterDownload, // one-time link (revokes after 1st complete DL)
    burnedAt: s.burnedAt || null, // when a one-time link actually burned
    tags: Array.isArray(s.tags) ? s.tags : [], // feature 9: admin labels for grouping/filtering
    // Feature 11 — geo/IP access rules.
    geoMode: s.geoMode || null,
    geoCountries: Array.isArray(s.geoCountries) ? s.geoCountries : [],
    ipMode: s.ipMode || null,
    ipList: Array.isArray(s.ipList) ? s.ipList : [],
    ownerId: s.ownerId || null, // account that created the link (role scoping)
    ownerName: s.ownerName || null,
    note: s.note || '', // optional admin message shown to the visitor
    rateKBps: s.rateBps > 0 ? Math.round(s.rateBps / 1024) : 0, // 0 = unlimited
    path: rel,
    url: base ? base + rel : null,
    // Reception-link quotas / filters (undefined on non-inbox shares).
    inbox: s.type === 'inbox' ? {
      maxFiles: s.maxFiles || 0,
      maxFileBytes: s.maxFileBytes || 0,
      maxTotalBytes: s.maxTotalBytes || 0,
      bytesReceived: s.bytesReceived || 0,
      allowExt: Array.isArray(s.allowExt) ? s.allowExt : [],
      blockExt: Array.isArray(s.blockExt) ? s.blockExt : [],
      note: s.note || '',
      messages: Array.isArray(s.messages) ? s.messages : [],
      groupBySender: !!s.groupBySender,
      moderated: !!s.moderated,
      encrypted: !!s.encrypted,
      encMode: s.encrypted ? (s.encMode || 'key') : null,
      // Live name of the mobile companion device that created this reception link
      // (null when created from the browser admin). Reflects in-app renames.
      deviceName: shareCreatorDeviceName(s),
    } : undefined,
    // Collaboration-link settings (undefined on other share types).
    collab: s.type === 'collab' ? {
      relDir: s.relDir,
      allowDelete: !!s.allowDelete,
      allowZip: s.allowZip !== false,
      maxFileBytes: s.maxFileBytes || 0,
      maxTotalBytes: s.maxTotalBytes || 0,
      maxFiles: s.maxFiles || 0,
      bytesReceived: s.bytesReceived || 0,
      allowExt: Array.isArray(s.allowExt) ? s.allowExt : [],
      blockExt: Array.isArray(s.blockExt) ? s.blockExt : [],
      note: s.note || '',
      moderated: !!s.moderated,
    } : undefined,
    // Feature 8: files awaiting moderation for this link (id, name, size, ip, at).
    pending: (Array.isArray(state.meta && state.meta.pending) ? state.meta.pending : [])
      .filter((p) => p.shareId === s.id)
      .map((p) => ({ id: p.id, name: p.name, size: p.size, ip: p.ip, at: p.at })),
    recipients: Array.isArray(s.recipients) ? s.recipients.map((r) => ({
      token: r.token,
      name: r.name,
      createdAt: r.createdAt || null,
      path: '/s/' + r.token,
      url: base ? base + '/s/' + r.token : null,
      downloads: (r.stats && r.stats.completed) || 0,
      stats: r.stats || null,
      // Per-recipient overrides (feature 16) — null = inherit the share's.
      expiresAt: r.expiresAt || null,
      maxDownloads: r.maxDownloads || null,
      // Read-receipt fields (feature 4).
      viewed: !!r.viewedAt,
      viewedAt: r.viewedAt || null,
      lastViewAt: r.lastViewAt || null,
      lastViewIp: r.lastViewIp ? pubIp(r.lastViewIp) : null,
      lastViewCountry: r.lastViewCountry || null,
      lastDownloadAt: (r.stats && r.stats.lastAt) || null,
    })) : [],
    // Per-link aggregate stats (see state.stats).
    stats: state.stats[s.id] || null,
  };
}

function externalTarget(req, baseOverride) {
  const proxyHost = TRUST_PROXY ? req.get('host') : '';
  const override = normalizeLinkBase(baseOverride || '') || '';
  const explicit =
    override ||
    getSettings().linkBase ||
    PUBLIC_URL ||
    (proxyHost && !hostIsIpLiteral(proxyHost) ? `${externalProto(req)}://${proxyHost}` : '');
  if (explicit) {
    try {
      const u = new URL(explicit.includes('://') ? explicit : `http://${explicit}`);
      const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
      return { host: u.hostname, port, label: `${u.protocol}//${u.host}` };
    } catch (_) {}
  }
  return null;
}

// Current account for this request (guaranteed present: getSession validated it).
function currentAccount(req) { return getAccountById(req.session.accountId); }

adminRouter.get('/session', (req, res) => {
  const acc = currentAccount(req);
  res.json({
    authenticated: true,
    csrf: req.session.csrf,
    mustChangePassword: accountNeedsPwChange(acc),
    username: acc ? acc.username : req.session.username,
    role: acc ? acc.role : req.session.role,
  });
});

adminRouter.post('/logout', (req, res) => {
  auditReq(req, 'logout');
  destroySession(req, res);
  res.json({ ok: true });
});

// Change the CURRENT account's password.
adminRouter.post('/password', (req, res) => {
  const acc = currentAccount(req);
  if (!acc) return res.status(401).json({ error: 'not-authenticated' });
  const body = req.body || {};
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (next.length < 8) return res.status(400).json({ error: 'too-short' });
  const forced = accountNeedsPwChange(acc);
  // The env-managed owner password can't be changed here (managed via ADMIN_PASSWORD).
  if (acc.role === 'owner' && adminPwFromEnv) return res.status(409).json({ error: 'env-managed' });
  // On the forced first-login change the login already proved the password.
  if (!forced && !verifyPassword(current, accountPwRec(acc))) {
    return res.status(403).json({ error: 'invalid-current-password' });
  }
  const persisted = setAccountPassword(acc, next); // durable synchronous write
  clearOtherSessionsOfAccount(acc.id, req.session.sid); // log out this account's other sessions
  auditReq(req, 'password-changed');
  res.json({ ok: true, persisted });
});

// --- Optional TOTP 2FA (per account, disabled by default) ---
adminRouter.get('/2fa/status', (req, res) => {
  res.json({ enabled: twoFactorEnabledFor(currentAccount(req)) });
});
// Starts enrollment for the current account: fresh secret (not yet active) + one-time
// recovery codes, shown ONCE. Enabling requires verifying a code from the app.
adminRouter.post('/2fa/setup', (req, res) => {
  const acc = currentAccount(req);
  if (!acc) return res.status(401).json({ error: 'not-authenticated' });
  if (twoFactorEnabledFor(acc)) return res.status(409).json({ error: 'already-enabled' });
  const secret = base32encode(crypto.randomBytes(20));
  const recoveryPlain = [];
  for (let i = 0; i < 8; i++) recoveryPlain.push(crypto.randomBytes(5).toString('hex'));
  acc.totp = { secret, enabled: false, recovery: recoveryPlain.map(hashPassword) };
  persistNow();
  const label = encodeURIComponent(APP_NAME + ':' + acc.username);
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(APP_NAME)}&digits=6&period=30`;
  res.json({ secret, otpauth, recoveryCodes: recoveryPlain });
});
adminRouter.post('/2fa/enable', (req, res) => {
  const acc = currentAccount(req);
  const tf = acc && acc.totp;
  if (!tf || !tf.secret) return res.status(400).json({ error: 'no-setup' });
  if (tf.enabled) return res.json({ ok: true });
  if (!verifyTotp(tf.secret, String((req.body && req.body.code) || ''))) {
    return res.status(400).json({ error: 'invalid-code' });
  }
  tf.enabled = true;
  persistNow();
  auditReq(req, '2fa-enabled');
  res.json({ ok: true });
});
// Disabling requires the current password (so a hijacked session can't silently remove 2FA).
adminRouter.post('/2fa/disable', (req, res) => {
  const acc = currentAccount(req);
  if (!acc) return res.status(401).json({ error: 'not-authenticated' });
  if (!verifyPassword(String((req.body && req.body.password) || ''), accountPwRec(acc))) {
    return res.status(403).json({ error: 'invalid-current-password' });
  }
  acc.totp = null;
  persistNow();
  auditReq(req, '2fa-disabled');
  res.json({ ok: true });
});

// ---- Account management (owner only) + audit log ----
function decorateAccount(a) {
  return {
    id: a.id, username: a.username, role: a.role,
    twoFactor: twoFactorEnabledFor(a),
    pwChanged: !!a.pwChanged,
    createdAt: a.createdAt || null, createdBy: a.createdBy || null,
    lastLoginAt: a.lastLoginAt || 0,
    isEnvManaged: a.role === 'owner' && adminPwFromEnv,
  };
}
adminRouter.get('/accounts', requireOwner, (req, res) => {
  res.json({ accounts: accountList().map(decorateAccount), self: req.session.accountId });
});
adminRouter.post('/accounts', requireOwner, (req, res) => {
  const body = req.body || {};
  const username = normUsername(body.username);
  const password = String(body.password || '');
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'invalid-username' });
  if (password.length < 8) return res.status(400).json({ error: 'too-short' });
  if (findAccountByName(username)) return res.status(409).json({ error: 'username-taken' });
  // Role: full 'admin', 'operator' (own links only) or read-only 'auditor'.
  const role = ['admin', 'operator', 'auditor'].includes(body.role) ? body.role : 'admin';
  const acc = {
    id: newAccountId(), username, ah: hashPassword(password), role,
    totp: null, pwChanged: true, createdAt: Date.now(),
    createdBy: req.session.username, lastLoginAt: 0,
  };
  accountList().push(acc);
  persistNow();
  auditReq(req, 'account-created', 'user=' + username);
  res.status(201).json({ account: decorateAccount(acc) });
});
adminRouter.post('/accounts/:id/password', requireOwner, (req, res) => {
  const acc = getAccountById(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not-found' });
  if (acc.role === 'owner' && adminPwFromEnv) return res.status(409).json({ error: 'env-managed' });
  const password = String((req.body && req.body.password) || '');
  if (password.length < 8) return res.status(400).json({ error: 'too-short' });
  acc.ah = hashPassword(password);
  acc.pwChanged = false; // force the target account to set its own password next login
  persistNow();
  clearSessionsOfAccount(acc.id); // any active session of that account is logged out
  auditReq(req, 'password-reset', 'user=' + acc.username);
  res.json({ ok: true });
});
// Rename an account (including the owner). Blocked for an env-managed owner, whose
// login name follows ADMIN_USERNAME.
adminRouter.post('/accounts/:id/username', requireOwner, (req, res) => {
  const acc = getAccountById(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not-found' });
  if (acc.role === 'owner' && adminPwFromEnv) return res.status(409).json({ error: 'env-managed' });
  const username = normUsername((req.body && req.body.username) || '');
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'invalid-username' });
  const existing = findAccountByName(username);
  if (existing && existing.id !== acc.id) return res.status(409).json({ error: 'username-taken' });
  const old = acc.username;
  if (old === username) return res.json({ account: decorateAccount(acc) });
  acc.username = username;
  persistNow();
  for (const s of sessions.values()) if (s.accountId === acc.id) s.username = username; // keep sessions in sync
  auditReq(req, 'account-renamed', old + ' → ' + username);
  res.json({ account: decorateAccount(acc) });
});
adminRouter.delete('/accounts/:id', requireOwner, (req, res) => {
  const acc = getAccountById(req.params.id);
  if (!acc) return res.status(404).json({ error: 'not-found' });
  if (acc.role === 'owner') return res.status(400).json({ error: 'cannot-delete-owner' });
  if (acc.id === req.session.accountId) return res.status(400).json({ error: 'cannot-delete-self' });
  const list = accountList();
  list.splice(list.indexOf(acc), 1);
  persistNow();
  clearSessionsOfAccount(acc.id);
  auditReq(req, 'account-deleted', 'user=' + acc.username);
  res.json({ ok: true });
});
// Recent audit entries (any authenticated admin may read).
adminRouter.get('/audit', requireAuditAccess, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  res.json({ entries: (state.audit || []).slice(0, limit) });
});

// Feature 4 — export the full admin audit log (JSON or CSV) for archival / SIEM.
adminRouter.get('/audit/export', requireAuditAccess, (req, res) => {
  const entries = state.audit || [];
  const stamp = new Date().toISOString().slice(0, 10);
  const fmt = String(req.query.format || 'json').toLowerCase() === 'csv' ? 'csv' : 'json';
  auditReq(req, 'audit-exported', `${entries.length} entr(y/ies) as ${fmt}`);
  if (fmt === 'csv') {
    const rows = [['at', 'iso', 'action', 'actor', 'role', 'ip', 'detail'].join(',')];
    for (const e of entries) {
      rows.push([e.at, new Date(e.at).toISOString(), e.action, e.actor, e.role, e.ip, e.detail].map(csvField).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-audit-${stamp}.csv"`);
    return res.send('﻿' + rows.join('\r\n')); // BOM so Excel reads UTF-8
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-audit-${stamp}.json"`);
  res.send(JSON.stringify({ app: APP_NAME, exportedAt: Date.now(), entries }, null, 2));
});

adminRouter.get('/shares', (req, res) => {
  let all = listShares();
  // Operators only see the links they created; admins/owner/auditors see all.
  if (req.session.role === 'operator') all = all.filter((s) => ownsShare(req, s));
  const allowedShareIds = req.session.role === 'operator' ? new Set(all.map((s) => s.id)) : null;
  const shares = all
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => decorateShare(s, req));
  res.json({
    shares,
    base: primaryBase(req),
    settings: settingsForClient(req, true), // lite: omit the custom-logo data URL from the periodic poll
    transfers: listTransfers(allowedShareIds),
    historyMeta: historyMeta(allowedShareIds),
    photoHistoryMeta: photoHistoryMeta(req),
  });
});

// History is loaded separately from the periodic shares poll. This keeps the
// live UI lightweight while still returning the complete retained list on change.
adminRouter.get('/history', (req, res) => {
  let allowedShareIds = null;
  if (req.session.role === 'operator') {
    const owned = listShares().filter((s) => ownsShare(req, s));
    allowedShareIds = new Set(owned.map((s) => s.id));
  }
  res.json({
    history: listHistory(allowedShareIds),
    meta: historyMeta(allowedShareIds),
  });
});

adminRouter.get('/photos/history', (req, res) => {
  const history = visiblePhotoHistory(req).map((record) => {
    const previewFile = record.preview ? firstExistingPhotoFile(photoHistoryPreviewPaths(record.id)) : null;
    const hasPreview = !!previewFile;
    // Backfill the retained-copy size for records archived before it was recorded.
    let previewSize = record.previewSize || 0;
    if (hasPreview && !previewSize) { try { previewSize = fs.statSync(previewFile).size; } catch (_) {} }
    return {
      id: record.id,
      name: record.name,
      ext: record.ext,
      size: record.size,
      createdAt: record.createdAt,
      revokedAt: record.revokedAt,
      ownerName: record.ownerName,
      metadataRemoved: !!record.metadataRemoved,
      fullViews: record.fullViews,
      fullVisitors: record.fullVisitors,
      thumbViews: record.thumbViews,
      thumbVisitors: record.thumbVisitors,
      microViews: record.microViews,
      microVisitors: record.microVisitors,
      previewSize: hasPreview ? previewSize : 0,
      previewUrl: hasPreview ? '/api/photos/history/' + record.id + '/preview' : null,
    };
  });
  res.json({ history, meta: photoHistoryMeta(req) });
});

adminRouter.get('/photos/history/:id/preview', (req, res) => {
  const record = (state.photoHistory || []).find((item) => item && item.id === req.params.id);
  if (!record || !canSeePhotoHistory(req, record) || !record.preview) return res.status(404).json({ error: 'not-found' });
  const previewPath = firstExistingPhotoFile(photoHistoryPreviewPaths(record.id));
  if (!previewPath) return res.status(404).json({ error: 'not-found' });
  streamFile(req, res, previewPath, record.name || 'preview.jpg', null, null, { inline: true, contentType: 'image/jpeg' });
});

// Remove one revoked-image history entry and its retained preview. Operators can
// only delete their own records; the global role gate keeps auditors read-only.
adminRouter.delete('/photos/history/:id', (req, res) => {
  const items = Array.isArray(state.photoHistory) ? state.photoHistory : [];
  const index = items.findIndex((record) => record && record.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'not-found' });
  const record = items[index];
  if (!canSeePhotoHistory(req, record)) return res.status(403).json({ error: 'forbidden' });
  items.splice(index, 1);
  deletePhotoHistoryPreview(record);
  persistNow();
  auditReq(req, 'photo-history-deleted', record.name || record.id);
  res.json({ ok: true, id: record.id, meta: photoHistoryMeta(req) });
});

adminRouter.delete('/photos/history', (req, res) => {
  const purgeAll = req.session.role === 'owner' || req.session.role === 'admin';
  const removed = [], kept = [];
  for (const record of (state.photoHistory || [])) {
    if (purgeAll || (record.ownerId && record.ownerId === req.session.accountId)) removed.push(record);
    else kept.push(record);
  }
  for (const record of removed) deletePhotoHistoryPreview(record);
  state.photoHistory = kept;
  persistNow();
  auditReq(req, 'photo-history-purged', String(removed.length));
  res.json({ ok: true, count: removed.length, meta: photoHistoryMeta(req) });
});


// Priority 3 dashboard helpers ------------------------------------------------
function dashboardDelta(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  return {
    delta: c - p,
    pct: p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : (c === 0 ? 0 : null),
  };
}

function finalizeTransferPeriodMetrics(m) {
  const out = { ...m };
  out.successRate = out.transfers ? Math.round((out.completed / out.transfers) * 100) : 0;
  out.avgBps = out.durationMs > 0 ? Math.round(out.throughputBytes / (out.durationMs / 1000)) : 0;
  delete out.durationMs;
  delete out.throughputBytes;
  return out;
}

function buildTransferComparison(days, current, previous) {
  if (!days || days <= 0) return { available: false, days: 0 };
  return {
    available: true,
    days,
    current,
    previous,
    changes: {
      transfers: dashboardDelta(current.transfers, previous.transfers),
      bytes: dashboardDelta(current.bytes, previous.bytes),
      successRate: { delta: current.successRate - previous.successRate, pct: null },
      avgBps: dashboardDelta(current.avgBps, previous.avgBps),
    },
  };
}

function buildImageComparison(days, current, previous) {
  if (!days || days <= 0) return { available: false, days: 0 };
  return {
    available: true,
    days,
    current,
    previous,
    changes: {
      images: dashboardDelta(current.images, previous.images),
      bytes: dashboardDelta(current.bytes, previous.bytes),
      avgSize: dashboardDelta(current.avgSize, previous.avgSize),
    },
  };
}

function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

const photoDuplicateCaches = new Map();
async function analyzePhotoDuplicates(photos, publicPhotoUrl, previewPhotoUrl) {
  const MAX_PHOTOS = 2500;
  const MAX_HASH_FILES = 500;
  const selected = photos.slice(0, MAX_PHOTOS);
  const signature = selected.map((s) => `${s.token}:${Number(s.size) || 0}:${s.imgPath || ''}`).sort().join('|');
  const cached = photoDuplicateCaches.get(signature);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;

  const bySize = new Map();
  for (const s of selected) {
    const size = Math.max(0, Number(s.size) || 0);
    if (!size || !s.imgPath) continue;
    const abs = path.resolve(FULL_IMAGES_DIR, s.imgPath);
    const root = path.resolve(FULL_IMAGES_DIR) + path.sep;
    if (!abs.startsWith(root)) continue;
    const row = { share: s, abs, size };
    const arr = bySize.get(size) || [];
    arr.push(row); bySize.set(size, arr);
  }

  const hashes = new Map();
  let hashedFiles = 0;
  let truncated = photos.length > MAX_PHOTOS;
  for (const rows of bySize.values()) {
    if (rows.length < 2) continue;
    for (const row of rows) {
      if (hashedFiles >= MAX_HASH_FILES) { truncated = true; break; }
      hashedFiles += 1;
      try {
        const hash = await hashFileSha256(row.abs);
        const key = `${row.size}:${hash}`;
        const arr = hashes.get(key) || [];
        arr.push(row); hashes.set(key, arr);
      } catch (_) {}
    }
    if (hashedFiles >= MAX_HASH_FILES) break;
  }

  const groups = [];
  let duplicateFiles = 0, reclaimableBytes = 0;
  for (const [key, rows] of hashes) {
    if (rows.length < 2) continue;
    const size = rows[0].size;
    const reclaimable = size * (rows.length - 1);
    duplicateFiles += rows.length - 1;
    reclaimableBytes += reclaimable;
    groups.push({
      id: key.slice(key.indexOf(':') + 1, key.indexOf(':') + 13),
      count: rows.length,
      size,
      reclaimableBytes: reclaimable,
      items: rows.slice(0, 8).map(({ share: s }) => ({
        name: s.name, token: s.token,
        url: publicPhotoUrl(s), previewUrl: previewPhotoUrl(s),
      })),
    });
  }
  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  const data = {
    groups: groups.slice(0, 12),
    groupCount: groups.length,
    duplicateFiles,
    reclaimableBytes,
    scanned: selected.length,
    hashedFiles,
    truncated,
    generatedAt: Date.now(),
  };
  photoDuplicateCaches.set(signature, { at: Date.now(), data });
  if (photoDuplicateCaches.size > 8) photoDuplicateCaches.delete(photoDuplicateCaches.keys().next().value);
  return data;
}

function estimateImageOptimization(rows) {
  const webpRatios = { jpg: 0.80, png: 0.60, bmp: 0.25 };
  const avifRatios = { jpg: 0.65, png: 0.45, bmp: 0.15, webp: 0.80 };
  const analyze = (ratios) => {
    const candidates = [];
    let sourceBytes = 0, estimatedBytes = 0;
    for (const r of rows) {
      const ratio = ratios[r.ext];
      const bytes = Math.max(0, Number(r.fullSize) || 0);
      if (!ratio || bytes < 64 * 1024) continue;
      const estimated = Math.round(bytes * ratio);
      const savings = Math.max(0, bytes - estimated);
      sourceBytes += bytes; estimatedBytes += estimated;
      candidates.push({
        name: r.name, token: r.token, format: r.ext, bytes,
        estimatedBytes: estimated, estimatedSavings: savings,
        previewUrl: r.previewUrl, url: r.url,
      });
    }
    candidates.sort((a, b) => b.estimatedSavings - a.estimatedSavings);
    return {
      eligible: candidates.length,
      sourceBytes,
      estimatedBytes,
      estimatedSavings: Math.max(0, sourceBytes - estimatedBytes),
      candidates: candidates.slice(0, 10),
    };
  };
  return { webp: analyze(webpRatios), avif: analyze(avifRatios), estimated: true };
}

// Images dashboard — analytics for the Images section, mirroring /api/dashboard
// but built from photo shares + the revoked-image history. Image views are not
// journaled (they're cheap cumulative counters), so view/visitor/storage figures
// are lifetime/current state; only the "added" timeline honors the period.
adminRouter.get('/photos/dashboard', async (req, res) => {
  const DAY_MS = 86400000;
  const now = Date.now();
  const filters = photoDashboardQueryOptions(req, now);
  const days = filters.days;
  const cutoff = filters.cutoff;
  const chartDays = days > 0 ? days : 365;
  const operatorScoped = req.session.role === 'operator';
  const fileSize = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };

  const allPhotos = listShares().filter((s) => s.type === 'photo' && (!operatorScoped || ownsShare(req, s)));
  const cohortFilters = { ...filters, cutoff: 0 };
  const filteredAllPhotos = allPhotos.filter((s) => photoMatchesDashboardFilters(s, cohortFilters, now));
  const photos = filteredAllPhotos.filter((s) => !cutoff || (s.createdAt || 0) >= cutoff);
  const history = visiblePhotoHistory(req).filter((r) => {
    if (filters.cutoff && (r.createdAt || 0) < filters.cutoff) return false;
    if (filters.format && String(r.ext || '').toLowerCase() !== filters.format) return false;
    if (filters.q && ![r.name, r.ext].filter(Boolean).join(' ').toLowerCase().includes(filters.q)) return false;
    return true;
  });
  const activePhotos = photos.filter((s) => isActive(s, now));
  const expiredPhotos = photos.filter((s) => !s.revoked && !!s.expiresAt && now > s.expiresAt);
  const otherInactivePhotos = photos.filter((s) => !isActive(s, now) && !expiredPhotos.includes(s));
  const imageBase = getSettings().imageBase || primaryBase(req) || '';
  const publicPhotoUrl = (s) => (imageBase ? imageBase : '') + '/i/' + s.token + '.' + photoExt(s);
  const previewPhotoUrl = (s) => '/i/' + s.token + (s.micro ? '/micro' : s.thumb ? '/thumb' : '.' + photoExt(s));

  // Pre-seed the "images added" chart buckets (oldest → newest).
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const created = [];
  const dayIndex = new Map();
  for (let i = chartDays - 1; i >= 0; i--) {
    const bucket = { day: dayKey(now - i * DAY_MS), count: 0 };
    dayIndex.set(bucket.day, bucket);
    created.push(bucket);
  }

  const variantViews = { full: 0, thumb: 0, micro: 0 };
  const storageByVariant = { full: 0, mini: 0, micro: 0 };
  const storageByFormatMap = new Map();
  const storageLifecycle = { active: 0, expired: 0, inactive: 0, reclaimable: 0 };
  const visitorSet = new Set(); // global unique masked IPs across every variant
  const userMap = new Map();
  let withMini = 0, withMicro = 0, addedInPeriod = 0, totalViews = 0;
  const imgRows = [];

  for (const s of photos) {
    const ps = photoStatsOf(s);
    const views = (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0);
    variantViews.full += ps.full.v || 0;
    variantViews.thumb += ps.thumb.v || 0;
    variantViews.micro += ps.micro.v || 0;
    totalViews += views;
    const uniq = new Set();
    for (const arr of [ps.full.u, ps.thumb.u, ps.micro.u]) {
      if (Array.isArray(arr)) for (const ip of arr) { uniq.add(ip); visitorSet.add(ip); }
    }
    if (s.thumb) withMini += 1;
    if (s.micro) withMicro += 1;
    if ((s.createdAt || 0) >= cutoff) addedInPeriod += 1;
    // Storage: the managed Full copy (share.size) plus the generated variant files.
    const fullBytes = Math.max(0, Number(s.size) || 0);
    const miniBytes = s.thumb ? fileSize(path.join(THUMBS_DIR, s.token + '.jpg')) : 0;
    const microBytes = s.micro ? fileSize(path.join(MICROS_DIR, s.token + '.jpg')) : 0;
    const managedBytes = fullBytes + miniBytes + microBytes;
    storageByVariant.full += fullBytes;
    storageByVariant.mini += miniBytes;
    storageByVariant.micro += microBytes;
    const ext = photoExt(s);
    const fmt = storageByFormatMap.get(ext) || { format: ext, bytes: 0, count: 0 };
    fmt.bytes += managedBytes; fmt.count += 1; storageByFormatMap.set(ext, fmt);
    const expired = !s.revoked && !!s.expiresAt && now > s.expiresAt;
    if (isActive(s, now)) storageLifecycle.active += managedBytes;
    else if (expired) { storageLifecycle.expired += managedBytes; storageLifecycle.reclaimable += managedBytes; }
    else { storageLifecycle.inactive += managedBytes; storageLifecycle.reclaimable += managedBytes; }
    const bucket = dayIndex.get(dayKey(s.createdAt || now));
    if (bucket) { bucket.count += 1; bucket.bytes = (bucket.bytes || 0) + managedBytes; }
    const ownerName = s.ownerName || '—';
    let owner = userMap.get(ownerName);
    if (!owner) { owner = { user: ownerName, images: 0, active: 0, expired: 0, inactive: 0, bytes: 0, views: 0, visitorSet: new Set() }; userMap.set(ownerName, owner); }
    owner.images += 1; owner.bytes += managedBytes; owner.views += views;
    if (isActive(s, now)) owner.active += 1; else if (expired) owner.expired += 1; else owner.inactive += 1;
    for (const ip of uniq) owner.visitorSet.add(ip);
    imgRows.push({
      name: s.name, token: s.token, ext, fullSize: fullBytes, size: managedBytes, views, visitors: uniq.size,
      ownerName, createdAt: s.createdAt || 0, active: isActive(s, now), expired, expiresAt: s.expiresAt || null,
      url: publicPhotoUrl(s), previewUrl: previewPhotoUrl(s),
    });
  }
  // Revoked images were "added" too — count them in the timeline.
  for (const r of history) {
    const bucket = dayIndex.get(dayKey(r.createdAt || 0));
    if (bucket) { bucket.count += 1; bucket.bytes = (bucket.bytes || 0) + Math.max(0, Number(r.size) || 0) + Math.max(0, Number(r.previewSize) || 0); }
  }
  let cumulativeBytes = 0;
  created.forEach((bucket) => { cumulativeBytes += bucket.bytes || 0; bucket.cumulativeBytes = cumulativeBytes; });

  const byViews = (a, b) => b.views - a.views;
  const topImages = imgRows.slice().sort(byViews).slice(0, 8);
  const topVisitors = imgRows.slice().filter((r) => r.visitors > 0).sort((a, b) => b.visitors - a.visitors).slice(0, 6);
  const storageByFormat = [...storageByFormatMap.values()].sort((a, b) => b.bytes - a.bytes);
  const largestImages = imgRows.slice().sort((a, b) => b.size - a.size).slice(0, 10);
  const linkRow = (s) => {
    const ps = photoStatsOf(s);
    const uniq = new Set();
    for (const arr of [ps.full.u, ps.thumb.u, ps.micro.u]) if (Array.isArray(arr)) for (const ip of arr) uniq.add(ip);
    return {
      name: s.name, token: s.token, createdAt: s.createdAt || 0, expiresAt: s.expiresAt || null,
      views: (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0), visitors: uniq.size,
      url: publicPhotoUrl(s), previewUrl: previewPhotoUrl(s),
    };
  };
  const activeLinks = activePhotos.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8).map(linkRow);
  const expiredLinks = expiredPhotos.slice().sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0)).slice(0, 8).map(linkRow);

  const expiringSoon = activePhotos
    .filter((s) => s.expiresAt && s.expiresAt > now && s.expiresAt - now <= 7 * DAY_MS && isActive(s))
    .sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 8)
    .map((s) => ({ name: s.name, token: s.token, expiresAt: s.expiresAt }));

  const recentRevoked = history.slice()
    .sort((a, b) => (b.revokedAt || 0) - (a.revokedAt || 0)).slice(0, 6)
    .map((r) => ({
      name: r.name, revokedAt: r.revokedAt,
      views: (r.fullViews || 0) + (r.thumbViews || 0) + (r.microViews || 0),
      visitors: Math.max(r.fullVisitors || 0, r.thumbVisitors || 0, r.microVisitors || 0),
    }));


  const periodMs = days > 0 ? days * DAY_MS : 0;
  const previousStart = periodMs ? cutoff - periodMs : 0;
  const cohortMetrics = (items) => {
    const bytes = items.reduce((sum, s) => sum + Math.max(0, Number(s.size) || 0), 0);
    return { images: items.length, bytes, avgSize: items.length ? Math.round(bytes / items.length) : 0 };
  };
  const currentCohort = periodMs ? filteredAllPhotos.filter((s) => (s.createdAt || 0) >= cutoff) : photos;
  const previousCohort = periodMs ? filteredAllPhotos.filter((s) => (s.createdAt || 0) >= previousStart && (s.createdAt || 0) < cutoff) : [];
  const comparison = buildImageComparison(days, cohortMetrics(currentCohort), cohortMetrics(previousCohort));
  const users = [...userMap.values()].map((u) => ({
    user: u.user, images: u.images, active: u.active, expired: u.expired, inactive: u.inactive,
    bytes: u.bytes, views: u.views, visitors: u.visitorSet.size,
  })).sort((a, b) => b.bytes - a.bytes || b.views - a.views).slice(0, 12);
  const duplicates = await analyzePhotoDuplicates(photos, publicPhotoUrl, previewPhotoUrl);
  const optimization = estimateImageOptimization(imgRows);

  // Disk space of the Images volume (full admins only, like the main dashboard).
  let storage = null;
  try {
    if (!operatorScoped && typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(IMAGE_STORE_DIR);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      storage = { total, free, used: Math.max(0, total - free), path: IMAGE_STORE_DIR };
    }
  } catch (_) { storage = null; }


  const alerts = [];
  if (storage && storage.total > 0) {
    const usedPct = Math.round((storage.used / storage.total) * 100);
    if (usedPct >= 90) alerts.push({ level: 'critical', code: 'image-disk-critical', params: { pct: usedPct, free: formatBytes(storage.free) } });
    else if (usedPct >= 80) alerts.push({ level: 'warning', code: 'image-disk-warning', params: { pct: usedPct, free: formatBytes(storage.free) } });
  }
  if (duplicates.groupCount > 0) alerts.push({
    level: duplicates.reclaimableBytes >= 100 * 1024 * 1024 ? 'warning' : 'info',
    code: 'duplicates', params: { n: duplicates.duplicateFiles, groups: duplicates.groupCount, space: formatBytes(duplicates.reclaimableBytes) },
  });
  const bestSavings = Math.max(optimization.webp.estimatedSavings || 0, optimization.avif.estimatedSavings || 0);
  if (bestSavings >= 25 * 1024 * 1024) alerts.push({ level: 'info', code: 'optimization', params: { space: formatBytes(bestSavings) } });
  if (storageLifecycle.reclaimable >= 250 * 1024 * 1024) alerts.push({ level: 'warning', code: 'image-reclaimable', params: { space: formatBytes(storageLifecycle.reclaimable) } });
  if (comparison.available && comparison.previous.bytes > 0 && comparison.current.bytes > comparison.previous.bytes * 2 && comparison.current.bytes - comparison.previous.bytes >= 100 * 1024 * 1024) {
    alerts.push({ level: 'warning', code: 'image-growth', params: { pct: comparison.changes.bytes.pct == null ? '—' : comparison.changes.bytes.pct } });
  }

  res.json({
    period: days,
    totals: {
      images: photos.length,
      active: activePhotos.length,
      expired: expiredPhotos.length,
      inactive: otherInactivePhotos.length,
      revoked: history.length,
      views: totalViews,
      fullViews: variantViews.full, thumbViews: variantViews.thumb, microViews: variantViews.micro,
      visitors: visitorSet.size,
      withMini, withMicro, addedInPeriod,
      storageBytes: storageByVariant.full + storageByVariant.mini + storageByVariant.micro,
    },
    variantViews,
    activeVsRevoked: { active: activePhotos.length, revoked: history.length },
    linkStatus: { active: activePhotos.length, expired: expiredPhotos.length, inactive: otherInactivePhotos.length },
    filters: { status: filters.status, format: filters.format, q: filters.q },
    storageByVariant: operatorScoped ? null : storageByVariant,
    storageAnalysis: operatorScoped ? null : { byFormat: storageByFormat, largestImages, lifecycle: storageLifecycle },
    comparison, users, duplicates, optimization, alerts,
    created, topImages, topVisitors, activeLinks, expiredLinks, expiringSoon, recentRevoked,
    storage, generatedAt: now,
  });
});

// Export the currently filtered Images dashboard as CSV.
adminRouter.get('/photos/dashboard/export.csv', (req, res) => {
  const now = Date.now();
  const filters = photoDashboardQueryOptions(req, now);
  const operatorScoped = req.session.role === 'operator';
  const photos = listShares().filter((s) => s.type === 'photo' && (!operatorScoped || ownsShare(req, s)))
    .filter((s) => photoMatchesDashboardFilters(s, filters, now));
  const imageBase = getSettings().imageBase || primaryBase(req) || '';
  const rows = photos.map((s) => {
    const ps = photoStatsOf(s);
    const uniq = new Set();
    for (const arr of [ps.full.u, ps.thumb.u, ps.micro.u]) if (Array.isArray(arr)) for (const ip of arr) uniq.add(ip);
    const expired = !s.revoked && !!s.expiresAt && now > s.expiresAt;
    const status = isActive(s, now) ? 'active' : expired ? 'expired' : 'inactive';
    return {
      name: s.name, token: s.token, format: photoExt(s), status, createdAt: s.createdAt || 0, expiresAt: s.expiresAt || 0,
      bytes: Math.max(0, Number(s.size) || 0), views: (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0),
      visitors: uniq.size, mini: !!s.thumb, micro: !!s.micro,
      url: (imageBase ? imageBase : '') + '/i/' + s.token + '.' + photoExt(s),
    };
  });
  const cols = ['name', 'token', 'format', 'status', 'createdAt', 'expiresAt', 'bytes', 'views', 'visitors', 'mini', 'micro', 'url'];
  const out = [cols.join(',')];
  for (const r of rows) out.push([
    r.name, r.token, r.format, r.status, new Date(r.createdAt || 0).toISOString(), r.expiresAt ? new Date(r.expiresAt).toISOString() : '',
    r.bytes, r.views, r.visitors, r.mini ? '1' : '0', r.micro ? '1' : '0', r.url,
  ].map(csvField).join(','));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-images-dashboard-${stamp}.csv"`);
  res.send('\uFEFF' + out.join('\r\n'));
});

// Rename a visitor by IP: set (or clear, when empty) a nickname shown next to the
// IP in the live-transfers and history views. Stored globally, keyed by IP.
adminRouter.post('/ip-names', (req, res) => {
  const b = req.body || {};
  const ip = String(b.ip || '').trim();
  if (!ip) return res.status(400).json({ error: 'missing-ip' });
  const name = String(b.name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60);
  // Nicknames disabled: accept the request but don't store anything.
  if (getSettings().keepIpNames === false) return res.json({ ok: true, ip, name: null, disabled: true });
  if (!state.ipNames || typeof state.ipNames !== 'object') state.ipNames = {};
  if (name) state.ipNames[ip] = name; else delete state.ipNames[ip];
  historyViewRevision++;
  persist();
  auditReq(req, name ? 'ip-named' : 'ip-unnamed', ip + (name ? ' \u2192 ' + name : ''));
  res.json({ ok: true, ip, name: name || null });
});

// Clear every stored visitor nickname at once (privacy housekeeping).
adminRouter.delete('/ip-names', (req, res) => {
  const n = state.ipNames ? Object.keys(state.ipNames).length : 0;
  state.ipNames = {};
  historyViewRevision++;
  persist();
  auditReq(req, 'ip-names-cleared', n + ' nickname(s)');
  res.json({ ok: true, cleared: n });
});

adminRouter.get('/settings', (req, res) => {
  res.json(settingsForClient(req));
});

// Validates a settings object (from the config form OR an imported file) and
// returns { patch } to apply, or { error } on the first invalid field.
function computeSettingsPatch(body) {
  body = body || {};
  const patch = {};
  const nnum = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const clampNum = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  if (typeof body.shutdownAfterDownload === 'boolean') {
    patch.shutdownAfterDownload = body.shutdownAfterDownload;
  }
  if (typeof body.linkBase === 'string') {
    const norm = normalizeLinkBase(body.linkBase);
    if (norm === null) return { error: 'invalid-domain' };
    patch.linkBase = norm; // '' = auto-detection
  }
  if (typeof body.imageBase === 'string') {
    const norm = normalizeLinkBase(body.imageBase);
    if (norm === null) return { error: 'invalid-domain' };
    patch.imageBase = norm; // '' = fall back to linkBase
  }
  if (body.imageHotlinkHosts !== undefined) {
    patch.imageHotlinkHosts = parseHotlinkHosts(body.imageHotlinkHosts); // [] = allow any site
  }
  if (body.idleLockMinutes !== undefined) {
    const n = Math.floor(Number(body.idleLockMinutes));
    patch.idleLockMinutes = Number.isFinite(n) ? Math.min(1440, Math.max(0, n)) : 0; // 0 = off, cap 24h
  }
  // Notifications (webhook). Ignored while WEBHOOK_URL is set by the environment.
  if (typeof body.webhookUrl === 'string') {
    const u = body.webhookUrl.trim();
    if (u && !/^https?:\/\//i.test(u)) return { error: 'invalid-webhook' };
    patch.webhookUrl = u.slice(0, 500);
  }
  if (typeof body.webhookFormat === 'string') {
    patch.webhookFormat = ['', 'auto', 'discord', 'slack', 'ntfy', 'json'].includes(body.webhookFormat)
      ? (body.webhookFormat === 'auto' ? '' : body.webhookFormat) : '';
  }
  if (typeof body.notifyDownloads === 'boolean') patch.notifyDownloads = body.notifyDownloads;
  if (typeof body.notifyUploads === 'boolean') patch.notifyUploads = body.notifyUploads;
  if (typeof body.notifyMessages === 'boolean') patch.notifyMessages = body.notifyMessages;
  // Proactive expiry alerts (feature 5) and periodic digest (feature 9).
  if (typeof body.notifyExpiring === 'boolean') patch.notifyExpiring = body.notifyExpiring;
  if (body.expiryWarnHours !== undefined) patch.expiryWarnHours = clampNum(body.expiryWarnHours, 1, 8760, 24); // cap 1y
  if (typeof body.digestEnabled === 'boolean') patch.digestEnabled = body.digestEnabled;
  if (body.digestDays !== undefined) patch.digestDays = clampNum(body.digestDays, 1, 90, 7);
  if (typeof body.notifySecurity === 'boolean') patch.notifySecurity = body.notifySecurity;
  // E-mail (SMTP) notifications (feature 2). Ignored while SMTP_URL is set by env.
  const emailStr = (v, max) => String(v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  if (typeof body.emailEnabled === 'boolean') patch.emailEnabled = body.emailEnabled;
  if (typeof body.smtpHost === 'string') patch.smtpHost = emailStr(body.smtpHost, 200);
  if (body.smtpPort !== undefined) patch.smtpPort = clampNum(body.smtpPort, 1, 65535, 587);
  if (typeof body.smtpSecure === 'boolean') patch.smtpSecure = body.smtpSecure;
  if (typeof body.smtpUser === 'string') patch.smtpUser = emailStr(body.smtpUser, 200);
  if (typeof body.smtpPass === 'string') patch.smtpPass = String(body.smtpPass).slice(0, 200); // kept as-is (may contain spaces)
  if (typeof body.smtpFrom === 'string') patch.smtpFrom = emailStr(body.smtpFrom, 200);
  if (typeof body.smtpTo === 'string') patch.smtpTo = emailStr(body.smtpTo, 400);
  // Defaults for new links.
  if (body.defaultExpiry !== undefined) patch.defaultExpiry = nnum(body.defaultExpiry);
  if (body.defaultMaxDownloads !== undefined) patch.defaultMaxDownloads = nnum(body.defaultMaxDownloads);
  if (body.defaultRateKBps !== undefined) patch.defaultRateKBps = nnum(body.defaultRateKBps);
  if (typeof body.defaultAllowZip === 'boolean') patch.defaultAllowZip = body.defaultAllowZip;
  if (typeof body.defaultRequirePassword === 'boolean') patch.defaultRequirePassword = body.defaultRequirePassword;
  if (body.defaultStartDelayHours !== undefined) patch.defaultStartDelayHours = clampNum(body.defaultStartDelayHours, 0, 17520, 0); // cap 2y
  if (typeof body.defaultAllowPreview === 'boolean') patch.defaultAllowPreview = body.defaultAllowPreview;
  if (typeof body.defaultBurnAfterDownload === 'boolean') patch.defaultBurnAfterDownload = body.defaultBurnAfterDownload;
  if (typeof body.defaultShowQr === 'boolean') patch.defaultShowQr = body.defaultShowQr;
  // Starting folder for the new-share picker. Stored as-is (trimmed); the /api/browse
  // endpoint re-validates the HOST_ROOT boundary when the picker actually opens it.
  if (typeof body.defaultShareDir === 'string') patch.defaultShareDir = body.defaultShareDir.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 4096);
  // Reception-link defaults.
  if (body.defaultMaxFiles !== undefined) patch.defaultMaxFiles = nnum(body.defaultMaxFiles);
  if (body.defaultMaxFileBytes !== undefined) patch.defaultMaxFileBytes = nnum(body.defaultMaxFileBytes);
  if (body.defaultMaxTotalBytes !== undefined) patch.defaultMaxTotalBytes = nnum(body.defaultMaxTotalBytes);
  if (typeof body.defaultAllowExt === 'string') patch.defaultAllowExt = normExtList(body.defaultAllowExt).join(', ');
  if (typeof body.defaultBlockExt === 'string') patch.defaultBlockExt = normExtList(body.defaultBlockExt).join(', ');
  if (typeof body.defaultEncrypt === 'boolean') patch.defaultEncrypt = body.defaultEncrypt;
  // Security.
  if (body.maxLoginAttempts !== undefined) patch.maxLoginAttempts = clampNum(body.maxLoginAttempts, 1, 100, 5);
  if (body.lockoutMinutes !== undefined) patch.lockoutMinutes = clampNum(body.lockoutMinutes, 1, 1440, 5);
  if (body.sessionHours !== undefined) patch.sessionHours = clampNum(body.sessionHours, 0, 720, 0); // 0 = env default, cap 30d
  if (typeof body.httpsWarning === 'boolean') patch.httpsWarning = body.httpsWarning;
  if (body.tokenBytes !== undefined) patch.tokenBytes = clampNum(body.tokenBytes, 12, 48, 24);
  if (typeof body.requireTwoFactor === 'boolean') patch.requireTwoFactor = body.requireTwoFactor;
  if (typeof body.adminAllowedIps === 'string') {
    // Keep only tokens parseIpList accepts (IPv4 / CIDR); store as a clean string
    // (uiAdminAllowedIps re-parses it into matcher objects at request time).
    const toks = body.adminAllowedIps.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    patch.adminAllowedIps = toks.filter((tok) => parseIpList(tok).length > 0).join(', ').slice(0, 500);
  }
  // Global limits.
  if (body.globalRateKBps !== undefined) patch.globalRateKBps = nnum(body.globalRateKBps);
  if (body.maxUploadBytes !== undefined) patch.maxUploadBytes = nnum(body.maxUploadBytes);
  if (body.maxZipBytes !== undefined) patch.maxZipBytes = nnum(body.maxZipBytes);
  // Maintenance.
  if (typeof body.updateCheck === 'boolean') patch.updateCheck = body.updateCheck;
  // History / privacy.
  if (body.historyRetentionDays !== undefined) patch.historyRetentionDays = clampNum(body.historyRetentionDays, 0, 3650, 0);
  if (body.logRetentionDays !== undefined) patch.logRetentionDays = clampNum(body.logRetentionDays, 0, 3650, 0);
  if (body.inboxRetentionDays !== undefined) patch.inboxRetentionDays = clampNum(body.inboxRetentionDays, 0, 3650, 0);
  if (typeof body.anonymizeIps === 'boolean') patch.anonymizeIps = body.anonymizeIps;
  if (typeof body.keepIpNames === 'boolean') patch.keepIpNames = body.keepIpNames;
  // Interface.
  if (typeof body.brandName === 'string') patch.brandName = body.brandName.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
  if (typeof body.accentColor === 'string') {
    const c = body.accentColor.trim();
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return { error: 'invalid-color' };
    patch.accentColor = c;
  }
  const langOk = (v) => ['', 'fr', 'en', 'es'].includes(v);
  if (typeof body.adminLang === 'string' && langOk(body.adminLang)) patch.adminLang = body.adminLang;
  if (typeof body.publicLang === 'string' && langOk(body.publicLang)) patch.publicLang = body.publicLang;
  if (typeof body.receptionBanner === 'string') patch.receptionBanner = body.receptionBanner.replace(/\r\n/g, '\n').trim().slice(0, 2000);
  // Privacy.
  if (typeof body.geoLookup === 'boolean') patch.geoLookup = body.geoLookup;
  // Feature 5 — scheduled bandwidth cap.
  if (typeof body.scheduleRateEnabled === 'boolean') patch.scheduleRateEnabled = body.scheduleRateEnabled;
  if (body.scheduleRateKBps !== undefined) patch.scheduleRateKBps = nnum(body.scheduleRateKBps);
  const hhmm = (v, dflt) => {
    const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(v).trim());
    if (!m) return dflt;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return dflt;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  };
  if (body.scheduleStart !== undefined) patch.scheduleStart = hhmm(body.scheduleStart, '08:00');
  if (body.scheduleEnd !== undefined) patch.scheduleEnd = hhmm(body.scheduleEnd, '18:00');
  // Feature 7 — anti-abuse.
  if (typeof body.publicRateLimit === 'boolean') patch.publicRateLimit = body.publicRateLimit;
  if (body.publicRateMax !== undefined) patch.publicRateMax = clampNum(body.publicRateMax, 1, 100000, 600);
  if (body.publicRateWindowMin !== undefined) patch.publicRateWindowMin = clampNum(body.publicRateWindowMin, 1, 1440, 1);
  if (typeof body.challengeEnabled === 'boolean') patch.challengeEnabled = body.challengeEnabled;
  if (body.challengeMinMB !== undefined) patch.challengeMinMB = clampNum(body.challengeMinMB, 1, 1048576, 200);
  if (body.challengeBits !== undefined) patch.challengeBits = clampNum(body.challengeBits, 8, 24, 16);
  if (typeof body.leakAlertEnabled === 'boolean') patch.leakAlertEnabled = body.leakAlertEnabled;
  if (body.leakAlertCountries !== undefined) patch.leakAlertCountries = clampNum(body.leakAlertCountries, 2, 100, 3);
  if (body.leakAlertWindowHours !== undefined) patch.leakAlertWindowHours = clampNum(body.leakAlertWindowHours, 1, 720, 24);
  // Feature 8 — branding / watermark.
  if (typeof body.publicLogo === 'string') {
    const v = body.publicLogo.trim();
    if (v && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v)) return { error: 'invalid-logo' };
    if (v.length > 262144) return { error: 'logo-too-large' }; // ~256 KB data URL cap
    patch.publicLogo = v;
  }
  if (typeof body.legalNotice === 'string') patch.legalNotice = body.legalNotice.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
  if (typeof body.watermarkPreviews === 'boolean') patch.watermarkPreviews = body.watermarkPreviews;
  if (typeof body.publicTheme === 'string') patch.publicTheme = ['auto', 'dark', 'light'].includes(body.publicTheme) ? body.publicTheme : 'dark';
  if (typeof body.themeColor === 'string') {
    const c = body.themeColor.trim();
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return { error: 'invalid-color' };
    patch.themeColor = c;
  }
  // Feature 9 — expiry presets: keep only well-formed duration tokens (Nh/Nd/Nw/Nmo),
  // de-duplicated, max 8. Empty falls back to the default set client-side.
  if (typeof body.expiryPresets === 'string') {
    const seen = new Set();
    const toks = body.expiryPresets.split(/[,\s]+/).map((x) => x.trim().toLowerCase())
      .filter((x) => /^\d{1,4}(h|d|w|mo)$/.test(x) && !seen.has(x) && seen.add(x));
    patch.expiryPresets = toks.slice(0, 8).join(',');
  }
  // Scheduled backup + restore.
  const oneLine = (v, max) => String(v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  if (typeof body.backupEnabled === 'boolean') patch.backupEnabled = body.backupEnabled;
  if (typeof body.backupInterval === 'string') patch.backupInterval = body.backupInterval === 'weekly' ? 'weekly' : 'daily';
  if (body.backupHour !== undefined) patch.backupHour = clampNum(body.backupHour, 0, 23, 3);
  if (body.backupWeekday !== undefined) patch.backupWeekday = clampNum(body.backupWeekday, 0, 6, 0);
  if (body.backupRetention !== undefined) patch.backupRetention = clampNum(body.backupRetention, 0, 3650, 7);
  if (typeof body.backupDestType === 'string') patch.backupDestType = ['local', 'webdav', 's3'].includes(body.backupDestType) ? body.backupDestType : 'local';
  if (typeof body.backupLocalDir === 'string') patch.backupLocalDir = oneLine(body.backupLocalDir, 500);
  if (typeof body.backupWebdavUrl === 'string') {
    const u = body.backupWebdavUrl.trim();
    if (u && !/^https?:\/\//i.test(u)) return { error: 'invalid-webdav' };
    patch.backupWebdavUrl = u.slice(0, 500);
  }
  if (typeof body.backupWebdavUser === 'string') patch.backupWebdavUser = oneLine(body.backupWebdavUser, 200);
  if (typeof body.backupWebdavPass === 'string') patch.backupWebdavPass = String(body.backupWebdavPass).slice(0, 400); // kept as-is
  if (typeof body.backupS3Endpoint === 'string') {
    const u = body.backupS3Endpoint.trim();
    if (u && !/^https?:\/\//i.test(u)) return { error: 'invalid-s3-endpoint' };
    patch.backupS3Endpoint = u.slice(0, 500);
  }
  if (typeof body.backupS3Region === 'string') patch.backupS3Region = oneLine(body.backupS3Region, 60) || 'us-east-1';
  if (typeof body.backupS3Bucket === 'string') patch.backupS3Bucket = oneLine(body.backupS3Bucket, 200);
  if (typeof body.backupS3Prefix === 'string') patch.backupS3Prefix = oneLine(body.backupS3Prefix, 200);
  if (typeof body.backupS3Key === 'string') patch.backupS3Key = oneLine(body.backupS3Key, 200);
  if (typeof body.backupS3Secret === 'string') patch.backupS3Secret = String(body.backupS3Secret).slice(0, 200);
  return { patch };
}

adminRouter.post('/settings', (req, res) => {
  const r = computeSettingsPatch(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  const patch = r.patch;
  // persisted=false ⇒ applied in memory but /data not writable (lost on restart).
  setSettings(patch);
  if (patch.anonymizeIps !== undefined || patch.keepIpNames !== undefined) historyViewRevision++;
  if (patch.historyRetentionDays !== undefined) pruneHistory();
  auditReq(req, 'settings-changed', Object.keys(patch).join(', '));
  res.json({ ...settingsForClient(req), persisted: dataWritable() });
});

// Export the current configuration as a JSON file (settings only — no shares,
// history or accounts). Handy for backup or cloning across instances.
adminRouter.get('/settings/export', requireFullAdmin, (req, res) => {
  const s = getSettings();
  delete s.pwChanged;
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-settings-${stamp}.json"`);
  auditReq(req, 'settings-exported', '');
  res.send(JSON.stringify({ app: APP_NAME, exportedAt: Date.now(), settings: s }, null, 2));
});

// Import a settings file previously produced by /settings/export. Unknown keys
// are ignored; every value is re-validated through computeSettingsPatch.
adminRouter.post('/settings/import', (req, res) => {
  const body = req.body || {};
  const incoming = (body && typeof body.settings === 'object' && body.settings) ? body.settings : body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'invalid-file' });
  const r = computeSettingsPatch(incoming);
  if (r.error) return res.status(400).json({ error: r.error });
  setSettings(r.patch);
  pruneHistory();
  auditReq(req, 'settings-imported', Object.keys(r.patch).length + ' key(s)');
  res.json({ ...settingsForClient(req), persisted: dataWritable(), imported: Object.keys(r.patch).length });
});

// Sends a test notification to verify the webhook works. Uses the URL from the
// request (so an unsaved value can be tested); falls back to the effective one.
adminRouter.post('/webhook-test', async (req, res) => {
  const body = req.body || {};
  const eff = effectiveWebhook();
  const url = (WEBHOOK_URL || String(body.url || '').trim() || eff.url); // env wins
  if (!url) return res.status(400).json({ error: 'no-url' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid-webhook' });
  const format = WEBHOOK_URL ? eff.format : (String(body.format || '') || autoWebhookFormat(url));
  const result = await sendWebhook(url, format === 'auto' ? '' : format, `✅ ${APP_NAME} — webhook test OK`, 'test', {});
  res.json(result);
});

// Sends the periodic digest immediately (feature 9), ignoring the schedule and
// the enabled flag — used by the "Send digest now" button to preview it.
adminRouter.post('/digest-test', (req, res) => {
  const r = maybeSendDigest(true);
  if (r && r.skipped === 'no-channel') return res.status(400).json({ error: 'no-channel' });
  res.json(r || { ok: true });
});

// Sends a test e-mail to verify the SMTP configuration (feature 2).
adminRouter.post('/email-test', async (req, res) => {
  if (!nodemailer) return res.status(400).json({ error: 'no-module' });
  if (!emailConfigured()) return res.status(400).json({ error: 'not-configured' });
  const r = await sendMail(`${APP_NAME} — e-mail test OK`, `✅ ${APP_NAME}: your SMTP notification settings work.`);
  if (r && r.ok) res.json({ ok: true });
  else res.status(400).json({ error: r && r.error ? r.error : 'send-failed' });
});

// --- Web Push (browser notifications) ---
// The public VAPID key the browser needs to subscribe (generated on first call).
adminRouter.get('/push/vapid', (req, res) => {
  if (!webpush) return res.status(400).json({ error: 'no-module' });
  const keys = getVapidKeys();
  res.json({ publicKey: keys.publicKey, subs: pushSubs().length });
});

// Store a browser's PushSubscription (deduplicated by endpoint).
adminRouter.post('/push/subscribe', (req, res) => {
  if (!webpush) return res.status(400).json({ error: 'no-module' });
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid-subscription' });
  }
  const subs = pushSubs();
  const rec = {
    endpoint: sub.endpoint.slice(0, 2000),
    keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) },
    accountId: req.session.accountId || null,
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    createdAt: Date.now(),
  };
  const i = subs.findIndex((x) => x.endpoint === rec.endpoint);
  if (i !== -1) subs[i] = { ...subs[i], ...rec }; else subs.push(rec);
  if (subs.length > 200) subs.splice(0, subs.length - 200); // sane cap
  persist();
  auditReq(req, 'push-subscribed', rec.ua);
  res.json({ ok: true, subs: subs.length });
});

// Remove a browser's subscription (on "disable" / permission revoked).
adminRouter.post('/push/unsubscribe', (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '').trim();
  if (!endpoint) return res.status(400).json({ error: 'missing-endpoint' });
  const removed = dropPushSub(endpoint);
  if (removed) { persist(); auditReq(req, 'push-unsubscribed', ''); }
  res.json({ ok: true, removed });
});

// Fire a test notification to the current account's subscribed browsers.
adminRouter.post('/push/test', (req, res) => {
  if (!webpush) return res.status(400).json({ error: 'no-module' });
  const mine = pushSubs().filter((x) => !x.accountId || x.accountId === req.session.accountId);
  if (!mine.length) return res.status(400).json({ error: 'no-subscription' });
  const sent = sendWebPush('test', `${APP_NAME} — test`, '🔔 Web Push notifications are working.', null, mine);
  res.json({ ok: true, sent });
});

// --- Scheduled backup + restore endpoints ---
// Run a backup NOW to the configured destination (uses the SAVED settings).
adminRouter.post('/backup-now', async (req, res) => {
  const r = await performBackup(req.session && req.session.username ? 'admin' : 'admin');
  if (r.ok) return res.json({ result: r, lastBackup: (state.meta && state.meta.lastBackup) || null });
  res.status(400).json({ error: r.error, lastBackup: (state.meta && state.meta.lastBackup) || null });
});

// Verify the destination is reachable/writable by pushing a tiny test object.
adminRouter.post('/backup-test', async (req, res) => {
  const s = getSettings();
  const dest = s.backupDestType || 'local';
  const name = `direct-xfer-test-${backupStamp()}.txt`;
  const buf = Buffer.from(`Direct-Xfer backup destination test — ${new Date().toISOString()}\n`);
  try {
    if (dest === 'local') {
      if (!s.backupLocalDir) return res.status(400).json({ error: 'no-local-dir' });
      await fs.promises.mkdir(s.backupLocalDir, { recursive: true });
      const p = path.join(s.backupLocalDir, name);
      await fs.promises.writeFile(p, buf, { mode: 0o600 });
      await fs.promises.unlink(p).catch(() => {});
    } else if (dest === 'webdav') {
      if (!s.backupWebdavUrl) return res.status(400).json({ error: 'no-webdav-url' });
      await putBackupWebdav(s, name, buf);
    } else if (dest === 's3') {
      if (!s.backupS3Endpoint || !s.backupS3Bucket || !s.backupS3Key || !s.backupS3Secret) return res.status(400).json({ error: 's3-incomplete' });
      await putBackupS3(s, name, buf);
    }
    res.json({ ok: true, dest });
  } catch (e) { res.status(400).json({ error: String((e && e.message) || e).slice(0, 200) }); }
});

// Build a full backup and stream it to the admin as a download (offline copy).
// Owner-only: the file contains every secret, password hash and note.
adminRouter.get('/backup/download', requireOwner, (req, res) => {
  const buf = Buffer.from(serializeBackup(buildBackupBundle()), 'utf8');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${backupFilename()}"`);
  res.setHeader('Cache-Control', 'no-store');
  auditReq(req, 'backup-download', `${buf.length} bytes${DATA_KEY ? ' (encrypted)' : ' (PLAINTEXT)'}`);
  res.send(buf);
});

// One-click restore from an uploaded backup file. Destructive: replaces the store,
// journal and secret notes. Owner-only. The body is the raw backup file (sent as
// octet-stream so the upstream JSON parser leaves the stream untouched).
adminRouter.post('/restore', requireOwner, (req, res) => {
  const chunks = []; let size = 0; let aborted = false;
  const MAX = 128 * 1024 * 1024;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX) { aborted = true; if (!res.headersSent) res.status(413).json({ error: 'too-large' }); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let bundle;
    try { bundle = parseBackup(Buffer.concat(chunks).toString('utf8')); }
    catch (e) {
      const code = e.code === 'DATA_KEY_REQUIRED' ? 'data-key-required'
        : e.code === 'DATA_KEY_INVALID' ? 'data-key-invalid'
        : e.code === 'INVALID_BACKUP' ? 'invalid-backup' : 'parse-error';
      return res.status(400).json({ error: code });
    }
    try { applyRestore(bundle); }
    catch (_) { return res.status(400).json({ error: 'invalid-backup' }); }
    auditReq(req, 'restore', `backup from ${new Date(bundle.createdAt || 0).toISOString()}, ${state.shares.length} link(s)`);
    res.json({ ok: true, shares: state.shares.length, createdAt: bundle.createdAt || null });
  });
  req.on('error', () => { if (!res.headersSent) res.status(400).json({ error: 'read-error' }); });
});

// Feature 4 — export every link's configuration (paths, quotas, expiries,
// passwords, recipients — NOT the files themselves) as a JSON file, for backup
// or migrating links to another instance.
adminRouter.get('/shares/export', requireFullAdmin, (req, res) => {
  const shares = listShares();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-shares-${stamp}.json"`);
  auditReq(req, 'shares-exported', shares.length + ' share(s)');
  res.send(JSON.stringify({ app: APP_NAME, exportedAt: Date.now(), shares }, null, 2));
});

// Feature 8 — export the CURRENT links list with their live state & counters (name,
// type, URL, dates, downloads, visitors, tags…) as CSV or JSON. Distinct from the
// config export above (which is for migrating link definitions).
adminRouter.get('/shares/list-export', (req, res) => {
  const rows = listShares().filter((s) => ownsShare(req, s)).map((s) => decorateShare(s, req));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  auditReq(req, 'links-exported', rows.length + ' link(s)');
  if (String(req.query.format || 'csv').toLowerCase() === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-links-${stamp}.json"`);
    return res.send(JSON.stringify({ app: APP_NAME, exportedAt: Date.now(), links: rows }, null, 2));
  }
  const cols = ['name', 'type', 'url', 'created', 'expires', 'active', 'downloads', 'maxDownloads', 'uniqueVisitors', 'maxVisitors', 'views', 'tags'];
  const out = [cols.join(',')];
  for (const s of rows) {
    out.push([
      s.name, s.type, s.url || '',
      new Date(s.createdAt).toISOString(),
      s.expiresAt ? new Date(s.expiresAt).toISOString() : '',
      s.active ? '1' : '0',
      s.downloads || 0, s.maxDownloads || '', s.uniqueVisitors || 0, s.maxVisitors || '', s.views || 0,
      (s.tags || []).join(' '),
    ].map(csvField).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-links-${stamp}.csv"`);
  res.send('﻿' + out.join('\r\n')); // BOM so Excel reads UTF-8
});

// Detailed statistics for one active share or shared image. The response combines
// persistent aggregates with the retained transfer history, live activity and,
// for direct images, per-variant access counters and on-disk copy metadata.
adminRouter.get('/shares/:id/stats-detail', async (req, res) => {
  const s = getById(req.params.id);
  if (!s || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });

  const now = Date.now();
  const decorated = decorateShare(s, req);
  const aggregate = state.stats[s.id] || {
    name: s.name || '', type: s.type || '', count: 0, bytes: 0, up: 0, down: 0,
    completed: 0, interrupted: 0, lastAt: 0,
  };
  const retained = (state.history || [])
    .filter((r) => r && r.shareId === s.id)
    .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));
  const live = [...activeTransfers.values()]
    .filter((t) => t && t.shareId === s.id)
    .map((t) => ({
      id: t.id,
      name: t.name || s.name || '',
      direction: t.direction === 'up' ? 'up' : 'down',
      bytes: t.bytes || 0,
      expectedBytes: t.expectedBytes || 0,
      startedAt: t.startedAt || 0,
      lastActivity: t.lastActivity || t.startedAt || 0,
      ip: pubIp(t.ip || ''),
      ipName: ipNameFor(pubIp(t.ip || '')),
      country: t.country || null,
      flag: t.flag || null,
      recipient: t.recipientName || null,
    }));

  const totalDurationMs = retained.reduce((sum, r) => sum + Math.max(0, Number(r.durationMs) || 0), 0);
  const retainedBytes = retained.reduce((sum, r) => sum + Math.max(0, Number(r.bytes) || 0), 0);
  const completed = Number(aggregate.completed) || 0;
  const count = Number(aggregate.count) || 0;
  const successRate = count ? Math.round((completed / count) * 1000) / 10 : 0;

  const countryMap = new Map();
  const clientMap = new Map();
  for (const r of retained) {
    const countryKey = r.countryCode || r.country || 'unknown';
    const country = countryMap.get(countryKey) || {
      code: r.countryCode || null,
      name: r.country || 'Unknown',
      flag: r.flag || null,
      count: 0,
      bytes: 0,
    };
    country.count += 1;
    country.bytes += Math.max(0, Number(r.bytes) || 0);
    countryMap.set(countryKey, country);

    const displayIp = pubIp(r.ip || '') || '—';
    const clientKey = ipNameFor(displayIp) || displayIp;
    const client = clientMap.get(clientKey) || { label: clientKey, count: 0, bytes: 0 };
    client.count += 1;
    client.bytes += Math.max(0, Number(r.bytes) || 0);
    clientMap.set(clientKey, client);
  }

  const dayMs = 86400000;
  const timelineStart = new Date(now);
  timelineStart.setHours(0, 0, 0, 0);
  timelineStart.setTime(timelineStart.getTime() - 13 * dayMs);
  const timeline = Array.from({ length: 14 }, (_, i) => {
    const at = timelineStart.getTime() + i * dayMs;
    return { at, day: new Date(at).toISOString().slice(0, 10), count: 0, bytes: 0, completed: 0, interrupted: 0, up: 0, down: 0 };
  });
  for (const r of retained) {
    const at = Number(r.endedAt || r.startedAt) || 0;
    const idx = Math.floor((at - timelineStart.getTime()) / dayMs);
    if (idx < 0 || idx >= timeline.length) continue;
    const point = timeline[idx];
    point.count += 1;
    point.bytes += Math.max(0, Number(r.bytes) || 0);
    point[r.completed ? 'completed' : 'interrupted'] += 1;
    point[r.direction === 'up' ? 'up' : 'down'] += 1;
  }

  const items = shareItems(s) || [];
  const logicalBytes = items.reduce((sum, item) => sum + Math.max(0, Number(item.size) || 0), 0)
    || Math.max(0, Number(s.size) || 0);
  const status = s.disabled ? 'paused' : isScheduled(s) ? 'scheduled' : isActive(s) ? 'active' : 'inactive';
  const quota = [];
  if (s.maxDownloads > 0) quota.push({ kind: 'downloads', used: s.downloads || 0, max: s.maxDownloads });
  if (s.maxVisitors > 0) quota.push({ kind: 'visitors', used: Array.isArray(s.visitors) ? s.visitors.length : 0, max: s.maxVisitors });
  if ((s.type === 'inbox' || s.type === 'collab') && s.maxTotalBytes > 0) quota.push({ kind: 'bytes', used: s.bytesReceived || 0, max: s.maxTotalBytes });
  if ((s.type === 'inbox' || s.type === 'collab') && s.maxFiles > 0) quota.push({ kind: 'files', used: s.downloads || 0, max: s.maxFiles });

  let image = null;
  if (s.type === 'photo') {
    const ps = photoStatsOf(s);
    const metaFor = async (kind) => {
      let file = null;
      if (kind === 'full') {
        file = firstExistingPhotoFile(photoOriginalPaths(s));
        if (!file && s.hostPath) {
          try { file = hostToContainer(s.hostPath); await assertRealWithin(HOST_ROOT, file); } catch (_) { file = null; }
        }
      } else {
        file = firstExistingPhotoFile(photoVariantPaths(s.token, kind));
      }
      let size = kind === 'full' ? (Number(s.size) || null) : null;
      let dim = kind === 'full' && s.w && s.h ? { w: s.w, h: s.h } : null;
      if (file) {
        try { size = fs.statSync(file).size; } catch (_) {}
        try { dim = imageDimensions(file) || dim; } catch (_) {}
      }
      const st = ps[kind] || { v: 0, u: [] };
      return {
        kind,
        views: Number(st.v) || 0,
        visitors: Array.isArray(st.u) ? st.u.length : 0,
        lastAt: Number(st.lastAt) || 0,
        size: size || 0,
        w: dim && dim.w ? dim.w : null,
        h: dim && dim.h ? dim.h : null,
        present: !!file,
      };
    };
    const variants = {
      full: await metaFor('full'),
      thumb: await metaFor('thumb'),
      micro: await metaFor('micro'),
    };
    const recentViews = (Array.isArray(ps.recent) ? ps.recent : []).slice(0, 50).map((v) => ({
      at: Number(v.at) || 0,
      kind: ['full', 'thumb', 'micro'].includes(v.kind) ? v.kind : 'full',
      ip: v.ip || null,
      country: v.country || null,
      countryCode: v.countryCode || null,
      flag: v.flag || null,
    }));
    image = {
      ext: photoExt(s),
      totalViews: variants.full.views + variants.thumb.views + variants.micro.views,
      totalVisitors: variants.full.visitors + variants.thumb.visitors + variants.micro.visitors,
      totalStorageBytes: variants.full.size + variants.thumb.size + variants.micro.size,
      variants,
      recentViews,
    };
  }

  const recent = retained.slice(0, 50).map((r) => {
    const displayIp = pubIp(r.ip || '');
    return {
      at: r.endedAt || r.startedAt || 0,
      startedAt: r.startedAt || 0,
      direction: r.direction === 'up' ? 'up' : 'down',
      name: r.name || '',
      recipient: r.recipientName || null,
      ip: displayIp || null,
      ipName: ipNameFor(displayIp),
      country: r.country || null,
      countryCode: r.countryCode || null,
      flag: r.flag || null,
      bytes: r.bytes || 0,
      durationMs: r.durationMs || 0,
      avgBps: r.avgBps || 0,
      completed: !!r.completed,
      reason: r.reason || null,
    };
  });

  res.json({
    share: {
      id: s.id,
      name: s.name || '',
      type: s.type || '',
      status,
      active: isActive(s),
      createdAt: s.createdAt || 0,
      startsAt: s.startsAt || 0,
      expiresAt: s.expiresAt || 0,
      ownerName: s.ownerName || null,
      url: s.type === 'photo' && decorated.photo ? decorated.photo.imgUrl : decorated.url,
      path: s.hostPath || s.relDir || null,
      tags: Array.isArray(s.tags) ? s.tags : [],
      itemCount: items.length || decorated.itemCount || 0,
      logicalBytes,
      views: Number(s.views) || 0,
      uniqueVisitors: Array.isArray(s.visitors) ? s.visitors.length : 0,
      downloads: Number(s.downloads) || 0,
    },
    aggregate: {
      count,
      bytes: Number(aggregate.bytes) || 0,
      up: Number(aggregate.up) || 0,
      down: Number(aggregate.down) || 0,
      completed,
      interrupted: Number(aggregate.interrupted) || 0,
      lastAt: Number(aggregate.lastAt) || 0,
      firstAt: retained.length ? (retained[retained.length - 1].startedAt || retained[retained.length - 1].endedAt || 0) : 0,
      successRate,
      averageBytes: count ? Math.round((Number(aggregate.bytes) || 0) / count) : 0,
      averageBps: totalDurationMs > 0 ? Math.round((retainedBytes / totalDurationMs) * 1000) : 0,
    },
    quota,
    live,
    timeline,
    countries: [...countryMap.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes).slice(0, 12),
    clients: [...clientMap.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes).slice(0, 12),
    recent,
    image,
  });
});

// Feature 14 — per-link access log: the recent transfer-journal entries for one
// link (who / when / from where), newest first. Owner-scoped, bounded.
adminRouter.get('/shares/:id/log', async (req, res) => {
  const s = getById(req.params.id);
  if (!s || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });
  const lines = await readLogTailAsync(8 * 1024 * 1024);
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < 200; i--) {
    const line = lines[i];
    if (!line || line.indexOf(s.id) === -1) continue; // cheap prefilter before JSON.parse
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (r.shareId !== s.id) continue;
    entries.push({
      at: r.endedAt || r.startedAt || 0,
      direction: r.direction || 'down',
      name: r.name || '',
      recipient: r.recipientName || null,
      ip: r.ip ? pubIp(r.ip) : null,
      country: r.country || null,
      flag: r.flag || null,
      bytes: r.bytes || 0,
      completed: !!r.completed,
    });
  }
  res.json({ shareId: s.id, name: s.name, entries });
});

// Feature 4 — import a shares-config file produced by /shares/export. Each record
// gets a fresh id; its token is kept when free (so existing links keep working)
// or regenerated on collision. mode:'replace' clears current links first, else
// records are merged in. Files/ciphertext blobs are NOT transferred.
adminRouter.post('/shares/import', (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body.shares) ? body.shares : (Array.isArray(body) ? body : null);
  if (!incoming) return res.status(400).json({ error: 'invalid-file' });
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace') state.shares = [];
  const tokens = new Set(state.shares.map((s) => s.token));
  let added = 0, skipped = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object' || !['file', 'folder', 'inbox'].includes(raw.type) || !raw.name) { skipped += 1; continue; }
    const rec = { ...raw };
    rec.id = crypto.randomBytes(8).toString('hex');
    if (!rec.token || tokens.has(rec.token)) rec.token = newToken();
    tokens.add(rec.token);
    if (typeof rec.downloads !== 'number') rec.downloads = 0;
    rec.revoked = !!rec.revoked;
    delete rec.expiryWarnedAt; // re-arm expiry alerts on the destination instance
    // Regenerate recipient sub-tokens that would collide with an existing one.
    if (Array.isArray(rec.recipients)) {
      for (const r of rec.recipients) {
        if (!r || typeof r !== 'object') continue;
        if (!r.token || tokens.has(r.token)) r.token = newToken();
        tokens.add(r.token);
      }
    }
    state.shares.push(rec);
    added += 1;
  }
  reindex();
  persistNow();
  auditReq(req, 'shares-imported', `${added} added, ${skipped} skipped (${mode})`);
  res.json({ ok: true, added, skipped, total: state.shares.length, persisted: dataWritable() });
});

// Resolves one host path to a share item, enforcing the HOST_ROOT boundary.
// Throws an Error whose .code is a client-facing reason ('missing-path',
// 'invalid-path', 'not-found', 'unsupported-type').
async function resolveHostItem(reqPath) {
  const p = String(reqPath || '').trim();
  if (!p) { const e = new Error('missing-path'); e.code = 'missing-path'; throw e; }
  let abs;
  try {
    abs = hostToContainer(p);
    await assertRealWithin(HOST_ROOT, abs);
  } catch (_) { const e = new Error('invalid-path'); e.code = 'invalid-path'; throw e; }
  let st;
  try {
    st = await fs.promises.stat(abs);
  } catch (_) { const e = new Error('not-found'); e.code = 'not-found'; throw e; }
  const type = st.isDirectory() ? 'folder' : st.isFile() ? 'file' : null;
  if (!type) { const e = new Error('unsupported-type'); e.code = 'unsupported-type'; throw e; }
  return { hostPath: containerToHost(abs), name: path.basename(abs) || 'share', size: type === 'file' ? st.size : null, type };
}
// Accepts either a single `path` or a `paths` array, returns a de-duplicated,
// trimmed list of host paths.
function reqPathList(body) {
  const raw = Array.isArray(body.paths) ? body.paths : (body.path != null ? [body.path] : []);
  return [...new Set(raw.map((p) => String(p || '').trim()).filter(Boolean))];
}

adminRouter.post('/shares', async (req, res) => {
  const body = req.body || {};
  // One path (legacy) or several (multi-select in the picker). A single folder
  // stays a browsable folder share; anything else becomes a 'file' share whose
  // items[] carry the selection (files and/or folders — a "collection").
  const reqPaths = reqPathList(body);
  if (!reqPaths.length) return res.status(400).json({ error: 'missing-path' });
  let resolved;
  try {
    resolved = [];
    for (const p of reqPaths) resolved.push(await resolveHostItem(p));
  } catch (e) {
    return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' });
  }

  const first = resolved[0];
  const type = resolved.length > 1 ? 'file' : first.type; // a bundle is a 'file' collection
  const share = {
    type,
    hostPath: first.hostPath,
    name: first.name || first.hostPath || 'share',
    size: type === 'file' ? first.size : null,
    startsAt: parseStartsAt(body.startsAt),
    expiresAt: parseExpiry(body.expiresInSeconds),
    maxDownloads: parseMaxDownloads(body.maxDownloads),
  };
  if (type === 'file') share.items = resolved.map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type }));
  // Mark a genuine multi-file bundle so the admin keeps showing its file list even
  // after it is whittled down to a single remaining item (a plain single-file share
  // is indistinguishable by item count alone).
  if (resolved.length > 1) share.collection = true;
  const password = String(body.password || '');
  // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
  // makeSharePassword() returns a fixed-shape { pwHash } object (a scrypt hash
  // of `password`, not `password` or any client-controlled keys) — there is no
  // attacker-controlled key set here, so no mass-assignment / exfiltration path.
  if (password) Object.assign(share, makeSharePassword(password));
  const rateKBps = Math.max(0, parseInt(body.rateKBps, 10) || 0); // per-link download cap (KB/s)
  if (rateKBps > 0) share.rateBps = rateKBps * 1024;
  // "Download all as .zip" is allowed by default; stored only when disabled.
  if (body.allowZip === false) share.allowZip = false;
  // In-browser preview is allowed by default; stored only when disabled.
  if (body.noPreview === true) share.noPreview = true;
  // One-time link: revoke the share after the first complete download.
  if (body.burnAfterDownload === true) share.burnAfterDownload = true;
  // Optional admin message shown to the visitor on the download page.
  if (typeof body.note === 'string') {
    const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 2000);
    if (note) share.note = note;
  }
  // Feature 5 — auto-revoke after N distinct visitors (0 / absent = unlimited).
  const maxVisitors = Math.max(0, parseInt(body.maxVisitors, 10) || 0);
  if (maxVisitors > 0) share.maxVisitors = maxVisitors;
  applyAccessRules(share, body); // feature 11 — geo/IP rules

  stampOwner(share, req);
  const rec = addShare(share);
  auditReq(req, 'share-created', share.type + ' ' + (share.name || ''));
  res.status(201).json({ share: decorateShare(rec, req) });
});

// Photos tab — create one direct-image link per host image path. The full image
// is copied into the configured Images/Full folder; the read-only source stays
// untouched. Mini and Micro are generated by the browser and uploaded separately.
adminRouter.post('/photos', async (req, res) => {
  const paths = reqPathList(req.body || {});
  if (!paths.length) return res.status(400).json({ error: 'missing-path' });
  const created = [], errors = [];
  for (const p of paths) {
    let item;
    try { item = await resolveHostItem(p); } catch (e) { errors.push({ path: p, error: e.code || 'invalid-path' }); continue; }
    if (item.type !== 'file' || !imageContentType(item.name)) { errors.push({ path: p, error: 'not-image' }); continue; }
    let imgPath;
    try { imgPath = await copyHostPhotoToStore(item); }
    catch (_) { errors.push({ path: p, error: 'image-copy-failed' }); continue; }
    const share = { type: 'photo', hostPath: item.hostPath, imgPath, name: item.name, size: item.size, expiresAt: parseExpiry(req.body.expiresInSeconds) };
    stampPhotoUploadDevice(share, req, 'host');
    stampOwner(share, req);
    try { created.push(decorateShare(addShare(share), req)); }
    catch (_) {
      unlinkPhotoFiles([path.join(FULL_IMAGES_DIR, imgPath)]);
      errors.push({ path: p, error: 'image-copy-failed' });
    }
  }
  if (!created.length) return res.status(400).json({ error: (errors[0] && errors[0].error) || 'no-images', errors });
  auditReq(req, 'photos-created', created.length + ' image(s)');
  res.status(201).json({ created, errors });
});

// Stores the browser-generated thumbnail (a small JPEG) for a photo link. The
// body is the raw image bytes (Content-Type not JSON, so the upstream json parser
// ignores it and the stream reaches here). Capped at 1 MB.
adminRouter.post('/photos/:id/thumb', (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type !== 'photo' || !ownsShare(req, s)) { req.resume(); return res.status(404).json({ error: 'not-found' }); }
  const tmp = path.join(THUMBS_DIR, s.token + '.tmp');
  const dest = path.join(THUMBS_DIR, s.token + '.jpg');
  const ws = fs.createWriteStream(tmp);
  let size = 0, failed = false;
  const fail = (code) => { if (failed) return; failed = true; try { ws.destroy(); } catch (_) {} fs.unlink(tmp, () => {}); if (!res.headersSent) res.status(code || 500).json({ error: 'thumb-failed' }); };
  req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) fail(413); });
  req.on('error', () => fail(400));
  ws.on('error', () => fail(500));
  ws.on('finish', () => {
    if (failed) return;
    if (size === 0) return fail(400);
    fs.rename(tmp, dest, (err) => {
      if (err) return fail(500);
      s.thumb = true; scheduleFlush();
      res.json({ ok: true });
    });
  });
  req.pipe(ws);
});

// Stores the micro image, generated at half the thumbnail dimensions.
adminRouter.post('/photos/:id/micro', (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type !== 'photo' || !ownsShare(req, s)) { req.resume(); return res.status(404).json({ error: 'not-found' }); }
  const tmp = path.join(MICROS_DIR, s.token + '.tmp');
  const dest = path.join(MICROS_DIR, s.token + '.jpg');
  const ws = fs.createWriteStream(tmp);
  let size = 0, failed = false;
  const fail = (code) => { if (failed) return; failed = true; try { ws.destroy(); } catch (_) {} fs.unlink(tmp, () => {}); if (!res.headersSent) res.status(code || 500).json({ error: 'micro-failed' }); };
  req.on('data', (c) => { size += c.length; if (size > MICRO_MAX_BYTES) fail(413); });
  req.on('error', () => fail(400));
  ws.on('error', () => fail(500));
  ws.on('finish', () => {
    if (failed) return;
    if (size === 0) return fail(400);
    fs.rename(tmp, dest, (err) => {
      if (err) return fail(500);
      s.micro = true; scheduleFlush();
      res.json({ ok: true });
    });
  });
  req.pipe(ws);
});

// Streams one image selected in the authenticated host-file picker back to the
// admin browser so it can be re-encoded locally before sharing. This endpoint is
// used only when the Images-page EXIF/GPS cleaning option is enabled: the source
// file remains untouched and no public link exists until the cleaned bytes return.
adminRouter.post('/photos/source', async (req, res) => {
  const requested = String((req.body && req.body.path) || '').trim();
  if (!requested) return res.status(400).json({ error: 'missing-path' });
  let item;
  try { item = await resolveHostItem(requested); }
  catch (e) { return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' }); }
  const contentType = item.type === 'file' ? imageContentType(item.name) : null;
  if (!contentType) return res.status(415).json({ error: 'not-image' });
  if (!Number.isFinite(item.size) || item.size <= 0) return res.status(400).json({ error: 'empty-image' });
  if (item.size > IMAGE_MAX_BYTES) return res.status(413).json({ error: 'image-too-large', maxBytes: IMAGE_MAX_BYTES });

  let source;
  try {
    source = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, source);
  } catch (_) { return res.status(400).json({ error: 'invalid-path' }); }

  res.status(200);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(item.size));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Direct-Xfer-Filename', encodeURIComponent(item.name || 'image'));
  const stream = fs.createReadStream(source);
  stream.on('error', (error) => {
    if (!res.headersSent) res.status(500).json({ error: 'image-read-failed' });
    else res.destroy(error);
  });
  stream.pipe(res);
});

// Create an image link from raw uploaded bytes (drag-drop / paste on the Images
// page — the file isn't necessarily on the read-only host FS). Mirrors /app/image
// but under the admin session; Mini/Micro are generated and uploaded separately.
adminRouter.post('/photos/upload', (req, res) => {
  let ext = (String(req.query.name || 'image.jpg').split('.').pop() || '').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (!PWA_IMG_EXT.test(ext)) return res.status(400).json({ error: 'not-image' });
  const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
  const dest = path.join(FULL_IMAGES_DIR, fname);
  streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size) => {
    const name = String(req.query.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120) || ('image.' + ext);
    const share = { type: 'photo', name, imgPath: fname, ext, size };
    if (String(req.query.metadataRemoved || '') === '1') share.metadataRemoved = true;
    stampPhotoUploadDevice(share, req, 'web');
    stampOwner(share, req);
    const dim = imageDimensions(dest);
    if (dim && dim.w > 0 && dim.h > 0) { share.w = dim.w; share.h = dim.h; }
    const rec = addShare(share);
    auditReq(req, 'photo-uploaded', name);
    res.status(201).json({ share: decorateShare(rec, req) });
  });
});

// Create a shareable image gallery (feature 18) from selected image links. Stores
// the member image tokens; the public /g/<token> page renders the live ones.
adminRouter.post('/photos/album', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const name = String(req.body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120) || 'Gallery';
  const members = [];
  for (const id of ids) {
    const m = getById(String(id));
    if (m && m.type === 'photo' && ownsShare(req, m) && !members.includes(m.token)) members.push(m.token);
    if (members.length >= 500) break; // sanity cap
  }
  if (!members.length) return res.status(400).json({ error: 'no-images' });
  const share = { type: 'album', name, members, expiresAt: parseExpiry(req.body.expiresInSeconds) };
  stampOwner(share, req);
  const rec = addShare(share);
  auditReq(req, 'album-created', name + ' · ' + members.length);
  res.status(201).json({ share: decorateShare(rec, req) });
});

// Download the selected original images as one ZIP. The selection is capped so
// the query string and archive stay bounded; the archive itself is streamed and
// never buffered in memory.
adminRouter.get('/photos/download.zip', async (req, res) => {
  const ids = [...new Set(String(req.query.ids || '').split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (!ids.length) return res.status(400).json({ error: 'empty' });
  const files = [];
  const usedNames = new Set();
  for (const id of ids) {
    const photo = getById(id);
    if (!photo || photo.type !== 'photo' || !ownsShare(req, photo)) continue;
    let file = firstExistingPhotoFile(photoOriginalPaths(photo));
    if (!file && photo.hostPath) {
      try {
        file = hostToContainer(photo.hostPath);
        await assertRealWithin(HOST_ROOT, file);
      } catch (_) { file = null; }
    }
    try { if (!file || !(await fs.promises.stat(file)).isFile()) continue; } catch (_) { continue; }
    let name = path.basename(String(photo.name || ('image.' + photoExt(photo))))
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || ('image.' + photoExt(photo));
    const stem = path.basename(name, path.extname(name));
    const ext = path.extname(name);
    let candidate = name, n = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${stem}-${n++}${ext}`;
    usedNames.add(candidate.toLowerCase());
    files.push({ file, name: candidate });
  }
  if (!files.length) return res.status(404).json({ error: 'not-found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('direct-xfer-images.zip')}`);
  res.setHeader('Cache-Control', 'no-store');
  const archive = await newZipArchive({ zlib: { level: 6 } });
  archive.on('warning', (w) => { if (w.code !== 'ENOENT') console.warn('[photos-zip] warning:', w.message); });
  archive.on('error', (err) => {
    console.error('[photos-zip] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'zip-failed' }); else res.destroy();
  });
  res.on('close', () => archive.destroy());
  archive.pipe(res);
  files.forEach((item) => archive.file(item.file, { name: item.name }));
  auditReq(req, 'photos-downloaded', files.length + ' image(s)');
  await archive.finalize();
});

// Pixel dimensions + byte size of a photo's three copies (Full / Mini / Micro),
// read from the file headers on disk (no image library). The original's dims are
// cached on the share; the variant metadata is cheap enough to read on demand.
// `w`/`h` stay at the top level for backward compatibility with older clients.
adminRouter.get('/photos/:id/dims', async (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type !== 'photo' || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });
  const full = { w: s.w || null, h: s.h || null, size: s.size || null };
  try {
    let abs = firstExistingPhotoFile(photoOriginalPaths(s));
    if (!abs) { abs = hostToContainer(s.hostPath); await assertRealWithin(HOST_ROOT, abs); }
    if (!(s.w && s.h)) {
      const dim = imageDimensions(abs);
      if (dim && dim.w > 0 && dim.h > 0) { s.w = dim.w; s.h = dim.h; scheduleFlush(); full.w = dim.w; full.h = dim.h; }
    }
    if (!full.size) { try { full.size = fs.statSync(abs).size; } catch (_) {} }
  } catch (_) {}
  // Mini / Micro: size + dims straight from the stored variant files (if present).
  const variantMeta = (variant, present) => {
    if (!present) return null;
    const file = firstExistingPhotoFile(photoVariantPaths(s.token, variant));
    if (!file) return null;
    let size = null;
    try { size = fs.statSync(file).size; } catch (_) {}
    const dim = imageDimensions(file);
    return { w: (dim && dim.w) || null, h: (dim && dim.h) || null, size };
  };
  res.json({
    w: full.w, h: full.h,
    full,
    thumb: variantMeta('thumb', s.thumb),
    micro: variantMeta('micro', s.micro),
  });
});


// EXIF/GPS details are loaded only when the administrator asks for them. Keeping
// this separate from /shares and /dims avoids parsing every image during gallery
// polling and prevents sensitive coordinates from appearing in routine payloads.
adminRouter.get('/photos/:id/metadata', async (req, res) => {
  const photo = getById(req.params.id);
  if (!photo || photo.type !== 'photo' || !ownsShare(req, photo)) return res.status(404).json({ error: 'not-found' });
  let file = firstExistingPhotoFile(photoOriginalPaths(photo));
  if (!file && photo.hostPath) {
    try {
      file = hostToContainer(photo.hostPath);
      await assertRealWithin(HOST_ROOT, file);
    } catch (_) { file = null; }
  }
  if (!file) return res.status(404).json({ error: 'file-unavailable' });
  const metadata = readPhotoMetadata(file);
  res.json({
    name: photo.name || '',
    deviceName: photoUploadDeviceName(photo),
    source: photo.uploadSource || null,
    metadataRemoved: !!photo.metadataRemoved,
    ...metadata,
  });
});

adminRouter.delete('/shares/:id', (req, res) => {
  const s = getById(req.params.id);
  const ok = removeShare(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not-found' });
  auditReq(req, 'share-revoked', s ? ((s.type || 'share') + ' ' + (s.name || '')) : req.params.id);
  res.json({ ok: true });
});

// Duplicate a share into a brand-new link. Only configuration is copied:
// identity, counters, visitors, logs, recipient links and received data are reset.
// Managed image files are physically copied so revoking either image cannot break
// the other one. Encrypted shares and secret notes remain intentionally excluded.
adminRouter.post('/shares/:id/clone', async (req, res) => {
  const source = getById(req.params.id);
  if (!source || !ownsShare(req, source)) return res.status(404).json({ error: 'not-found' });
  if (source.encrypted || source.type === 'secret') return res.status(400).json({ error: 'cannot-clone' });

  const requestedName = String((req.body && req.body.name) || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 200);
  const suffix = String((req.body && req.body.nameSuffix) || '(copy)')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 40);
  const nextName = requestedName || (((source.name || 'Share') + ' ' + suffix).trim().slice(0, 200));
  if (!nextName) return res.status(400).json({ error: 'invalid-name' });

  const clone = JSON.parse(JSON.stringify(source));
  for (const key of [
    'id', 'token', 'createdAt', 'downloads', 'revoked', 'disabled',
    'burnedAt', 'burnedReason', 'visitors', 'views', 'expiryWarnedAt',
    'messages', 'pending', 'recipients', 'encPath', 'ownerId', 'ownerName',
    'pstats', 'bytesReceived',
  ]) delete clone[key];

  clone.name = nextName;
  // A direct image URL derives its extension from the display name. Preserve the
  // actual source format even when the user enters a name without an extension.
  if (source.type === 'photo') {
    const ext = photoExt(source);
    const baseName = nextName.replace(/\.(?:jpe?g|png|gif|webp|bmp|avif)$/i, '').trim() || 'Image';
    clone.name = (baseName + '.' + ext).slice(0, 200);
  }
  clone.downloads = 0;
  clone.revoked = false;

  let freshInboxDir = null;
  const copiedPhotoFiles = [];

  try {
    if (source.type === 'inbox' || source.type === 'collab') {
      const base = nextName
        .replace(/[^A-Za-z0-9 _.-]/g, '_')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 50) || source.type;
      clone.relDir = base + '-' + crypto.randomBytes(3).toString('hex');
      clone.bytesReceived = 0;
      freshInboxDir = resolveWithin(INBOX_DIR, clone.relDir);
      await fs.promises.mkdir(freshInboxDir, { recursive: true });
    }

    if (source.type === 'photo') {
      let original = firstExistingPhotoFile(photoOriginalPaths(source));
      if (!original && source.hostPath) {
        try {
          const candidate = hostToContainer(source.hostPath);
          await assertRealWithin(HOST_ROOT, candidate);
          if ((await fs.promises.stat(candidate)).isFile()) original = candidate;
        } catch (_) {}
      }
      if (!original) return res.status(409).json({ error: 'image-missing' });

      // Reserve the final identity before copying token-bound Mini/Micro files.
      do { clone.id = crypto.randomBytes(8).toString('hex'); } while (getById(clone.id));
      do { clone.token = newToken(); } while (getByToken(clone.token));
      clone.createdAt = Date.now();

      const storedName = newStoredImageName(clone.name || source.name || source.imgPath || 'image.jpg');
      const fullDestination = path.join(FULL_IMAGES_DIR, storedName);
      await copyPhotoFile(original, fullDestination);
      copiedPhotoFiles.push(fullDestination);
      clone.imgPath = storedName;

      clone.thumb = false;
      if (source.thumb) {
        const thumbDestination = path.join(THUMBS_DIR, clone.token + '.jpg');
        if (await copyFirstExistingPhotoFile(photoVariantPaths(source.token, 'thumb'), thumbDestination)) {
          clone.thumb = true;
          copiedPhotoFiles.push(thumbDestination);
        }
      }

      clone.micro = false;
      if (source.micro) {
        const microDestination = path.join(MICROS_DIR, clone.token + '.jpg');
        if (await copyFirstExistingPhotoFile(photoVariantPaths(source.token, 'micro'), microDestination)) {
          clone.micro = true;
          copiedPhotoFiles.push(microDestination);
        }
      }
    }

    stampOwner(clone, req);
    const record = addShare(clone);
    auditReq(req, 'share-cloned', (source.name || source.id) + ' → ' + record.id);
    return res.status(201).json({ share: decorateShare(record, req) });
  } catch (error) {
    for (const file of copiedPhotoFiles) {
      try { await fs.promises.unlink(file); } catch (_) {}
    }
    if (freshInboxDir) {
      try { await fs.promises.rmdir(freshInboxDir); } catch (_) {}
    }
    console.error('[clone] could not duplicate share:', error.message);
    return res.status(500).json({ error: 'clone-failed' });
  }
});

// E-mail a link to a recipient via the configured SMTP (best-effort). Needs a
// sendable SMTP config (host/url + From); a default notification recipient is not
// required.
adminRouter.post('/shares/:id/email', async (req, res) => {
  if (!emailSendable()) return res.status(400).json({ error: 'email-not-configured' });
  const s = getById(req.params.id);
  if (!s) return res.status(404).json({ error: 'not-found' });
  const to = String((req.body && req.body.to) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'invalid-email' });
  const base = primaryBase(req);
  const url = (base || '') + linkPrefix(s) + s.token;
  const note = String((req.body && req.body.message) || '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
  const subject = `${APP_NAME} — ${s.name || 'Link'}`;
  const text = `${note ? note + '\n\n' : ''}${s.name || 'Link'}\n${url}\n\n— ${APP_NAME}`;
  const r = await sendMail(subject, text, to);
  if (r && r.ok) { auditReq(req, 'share-emailed', (s.name || s.id) + ' → ' + to); return res.json({ ok: true }); }
  res.status(400).json({ error: (r && r.error) || 'send-failed' });
});

// Feature 3 — edit an existing link in place (without recreating it / changing its
// URL): extend or change the expiry, password, quota, speed, .zip/preview toggles,
// deferred start, one-time flag and name. Only provided fields are touched.
adminRouter.patch('/shares/:id', (req, res) => {
  const s = getById(req.params.id);
  if (!s) return res.status(404).json({ error: 'not-found' });
  const body = req.body || {};
  const changed = [];

  if (typeof body.name === 'string') {
    const nm = body.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
    if (nm && nm !== s.name) { s.name = nm; changed.push('name'); }
  }
  if (body.expiresInSeconds !== undefined) {
    const next = parseExpiry(body.expiresInSeconds); // null = never
    if (next !== s.expiresAt) {
      s.expiresAt = next;
      delete s.expiryWarnedAt; // re-arm the "expiring soon" alert for the new date
      changed.push('expiresAt');
    }
  }
  if (body.startsAt !== undefined) {
    s.startsAt = parseStartsAt(body.startsAt); // null = active immediately
    changed.push('startsAt');
  }
  if (body.maxDownloads !== undefined) {
    s.maxDownloads = parseMaxDownloads(body.maxDownloads); // null = unlimited
    changed.push('maxDownloads');
  }
  if (body.rateKBps !== undefined) {
    const kb = Math.max(0, parseInt(body.rateKBps, 10) || 0);
    if (kb > 0) s.rateBps = kb * 1024; else delete s.rateBps;
    changed.push('rateKBps');
  }
  if (typeof body.allowZip === 'boolean') {
    if (body.allowZip) delete s.allowZip; else s.allowZip = false;
    changed.push('allowZip');
  }
  if (typeof body.noPreview === 'boolean') {
    if (body.noPreview) s.noPreview = true; else delete s.noPreview;
    changed.push('noPreview');
  }
  if (typeof body.burnAfterDownload === 'boolean') {
    if (body.burnAfterDownload) s.burnAfterDownload = true; else delete s.burnAfterDownload;
    changed.push('burnAfterDownload');
  }
  if (body.maxVisitors !== undefined) {
    const mv = Math.max(0, parseInt(body.maxVisitors, 10) || 0);
    if (mv > 0) s.maxVisitors = mv; else delete s.maxVisitors;
    changed.push('maxVisitors');
  }
  // Password: absent key = keep; '' = clear; non-empty = set (re-hashed).
  if (typeof body.password === 'string') {
    if (body.password === '') {
      if (s.pwHash) { delete s.pwHash; delete s.pwSalt; changed.push('password-cleared'); }
      // Visitor deletion requires a password — clearing it must disable deletion
      // too, so an unprotected collab link never allows deletes.
      if (s.allowDelete) { delete s.allowDelete; changed.push('allowDelete-off'); }
    } else {
      Object.assign(s, makeSharePassword(body.password));
      changed.push('password-set');
    }
  }

  if (typeof body.note === 'string') {
    const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 2000);
    if (note !== (s.note || '')) {
      if (note) s.note = note; else delete s.note;
      changed.push('note');
    }
  }
  // Private admin note (never shown to visitors — for the admin's own reference).
  if (typeof body.adminNote === 'string') {
    const an = body.adminNote.replace(/\r\n/g, '\n').trim().slice(0, 1000);
    if (an !== (s.adminNote || '')) {
      if (an) s.adminNote = an; else delete s.adminNote;
      changed.push('adminNote');
    }
  }
  // Pause / resume: temporarily deactivate the link without deleting it (reversible).
  if (typeof body.disabled === 'boolean' && body.disabled !== !!s.disabled) {
    if (body.disabled) s.disabled = true; else delete s.disabled;
    changed.push(body.disabled ? 'disabled' : 'enabled');
  }
  if (Array.isArray(body.tags)) {
    const tags = normalizeTags(body.tags);
    if (tags.join(' ') !== (Array.isArray(s.tags) ? s.tags : []).join(' ')) {
      if (tags.length) s.tags = tags; else delete s.tags;
      changed.push('tags');
    }
  }
  if (s.type === 'photo' && typeof body.favorite === 'boolean' && body.favorite !== !!s.favorite) {
    if (body.favorite) s.favorite = true; else delete s.favorite;
    changed.push(body.favorite ? 'favorite' : 'unfavorite');
  }

  if (body.geoMode !== undefined || body.ipMode !== undefined) {
    applyAccessRules(s, body); // feature 11 — geo/IP rules
    changed.push('access');
  }

  if (changed.length) persistNow();
  auditReq(req, 'share-edited', (s.name || s.id) + ': ' + changed.join(', '));
  res.json({ share: decorateShare(s, req) });
});

// Normalizes admin tags: trimmed, de-duplicated (case-insensitive), capped.
function normalizeTags(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [], seen = new Set();
  for (let tag of arr) {
    tag = String(tag || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30);
    const k = tag.toLowerCase();
    if (tag && !seen.has(k)) { seen.add(k); out.push(tag); }
    if (out.length >= 20) break;
  }
  return out;
}

// Feature 9 — bulk actions on several links at once: revoke, extend/replace the
// expiry, or add/remove a tag. Body: { ids:[...], action, expiresInSeconds?, tag? }.
adminRouter.post('/shares/bulk', (req, res) => {
  const b = req.body || {};
  let ids = Array.isArray(b.ids) ? b.ids.slice(0, 1000) : [];
  // Operators may only act on links they own.
  if (req.session.role === 'operator') ids = ids.filter((id) => ownsShare(req, getById(id)));
  const action = String(b.action || '');
  if (!ids.length) return res.status(400).json({ error: 'empty' });
  let count = 0;
  if (action === 'revoke') {
    for (const id of ids) { if (removeShare(id)) count += 1; }
  } else if (action === 'extend') {
    const next = parseExpiry(b.expiresInSeconds); // null = never
    for (const id of ids) { const s = getById(id); if (s) { s.expiresAt = next; delete s.expiryWarnedAt; count += 1; } }
    persistNow();
  } else if (action === 'tag-add' || action === 'tag-remove') {
    const tag = normalizeTags([b.tag])[0];
    if (!tag) return res.status(400).json({ error: 'invalid-tag' });
    for (const id of ids) {
      const s = getById(id); if (!s) continue;
      const cur = Array.isArray(s.tags) ? s.tags : [];
      if (action === 'tag-add') { if (!cur.some((x) => x.toLowerCase() === tag.toLowerCase())) { s.tags = [...cur, tag].slice(0, 20); count += 1; } }
      else { const nt = cur.filter((x) => x.toLowerCase() !== tag.toLowerCase()); if (nt.length !== cur.length) { if (nt.length) s.tags = nt; else delete s.tags; count += 1; } }
    }
    persistNow();
  } else if (action === 'favorite' || action === 'unfavorite') {
    const enabled = action === 'favorite';
    for (const id of ids) {
      const s = getById(id);
      if (!s || s.type !== 'photo') continue;
      if (!!s.favorite === enabled) continue;
      if (enabled) s.favorite = true; else delete s.favorite;
      count += 1;
    }
    persistNow();
  } else if (action === 'album-add') {
    const album = getById(String(b.albumId || ''));
    if (!album || album.type !== 'album' || !ownsShare(req, album)) return res.status(404).json({ error: 'album-not-found' });
    const members = Array.isArray(album.members) ? album.members.slice(0, 500) : [];
    for (const id of ids) {
      const s = getById(id);
      if (!s || s.type !== 'photo' || !ownsShare(req, s) || members.includes(s.token)) continue;
      if (members.length >= 500) break;
      members.push(s.token);
      count += 1;
    }
    album.members = members;
    persistNow();
  } else {
    return res.status(400).json({ error: 'invalid-action' });
  }
  auditReq(req, 'shares-bulk', `${action}: ${count}/${ids.length}`);
  res.json({ ok: true, count });
});

// Append one or more files/folders to an existing file share (a collection).
// Accepts a single `path` (legacy) or a `paths` array (multi-select). Already-
// present items are skipped; a 409 is returned only when nothing new was added.
adminRouter.post('/shares/:id/items', async (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type !== 'file') return res.status(404).json({ error: 'not-found' });
  const reqPaths = reqPathList(req.body || {});
  if (!reqPaths.length) return res.status(400).json({ error: 'missing-path' });
  let resolved;
  try {
    resolved = [];
    for (const p of reqPaths) resolved.push(await resolveHostItem(p));
  } catch (e) {
    return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' });
  }
  if (!Array.isArray(s.items)) s.items = [{ hostPath: s.hostPath, name: s.name, size: s.size, type: 'file' }];
  let added = 0;
  for (const it of resolved) {
    if (s.items.some((x) => x.hostPath === it.hostPath)) continue; // skip duplicates
    s.items.push({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type });
    added += 1;
  }
  if (!added) return res.status(409).json({ error: 'already-added' });
  s.collection = true; // it now bundles several files
  persist();
  res.status(201).json({ share: decorateShare(s, req), added });
});

// Remove one file from a collection (the last remaining file cannot be removed).
adminRouter.delete('/shares/:id/items/:idx', (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type !== 'file' || !Array.isArray(s.items)) return res.status(404).json({ error: 'not-found' });
  const idx = parseInt(req.params.idx, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= s.items.length) return res.status(404).json({ error: 'not-found' });
  if (s.items.length <= 1) return res.status(400).json({ error: 'last-item' });
  s.items.splice(idx, 1);
  s.hostPath = s.items[0].hostPath;
  s.name = s.items[0].name;
  s.size = (s.items[0].type || 'file') === 'folder' ? null : s.items[0].size;
  s.collection = true; // stays a collection even once a single file remains (so the admin keeps listing it)
  persist();
  res.json({ share: decorateShare(s, req) });
});

// Feature 16 — reorder a collection's items (drag & drop). `order` is a permutation
// of the current indices. Only the display/listing order changes; the link's name
// and URL are untouched.
adminRouter.patch('/shares/:id/items/order', (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type !== 'file' || !Array.isArray(s.items) || s.items.length < 2) return res.status(404).json({ error: 'not-found' });
  const n = s.items.length;
  const order = Array.isArray(req.body && req.body.order) ? req.body.order.map((v) => parseInt(v, 10)) : null;
  if (!order || order.length !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n) || new Set(order).size !== n) {
    return res.status(400).json({ error: 'bad-order' });
  }
  s.items = order.map((i) => s.items[i]);
  persist();
  auditReq(req, 'items-reordered', (s.name || s.id));
  res.json({ share: decorateShare(s, req) });
});

// Feature 18 — full-text search across the text files behind the active links the
// caller owns. On-demand and bounded (files / results / bytes / time). Encrypted
// shares and secret notes are skipped (the server only holds ciphertext).
adminRouter.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'query-too-short' });
  const needle = q.toLowerCase();
  const results = [];
  const budget = {
    files: 0,
    deadline: Date.now() + SEARCH_TIME_MS,
    stop() { return this.files >= SEARCH_MAX_FILES || results.length >= SEARCH_MAX_RESULTS || Date.now() > this.deadline; },
  };
  for (const s of listShares()) {
    if (budget.stop()) break;
    if (s.revoked || s.encrypted || s.type === 'secret' || !ownsShare(req, s)) continue;
    try {
      if (s.type === 'file') {
        for (const it of shareItems(s)) {
          if (budget.stop()) break;
          let abs;
          try { abs = hostToContainer(it.hostPath); await assertRealWithin(HOST_ROOT, abs); } catch (_) { continue; }
          if ((it.type || 'file') === 'folder') await walkTextFiles(abs, it.name, budget, (a, r) => grepFile(a, r, needle, s, results));
          else if (isSearchableText(it.name)) { budget.files += 1; await grepFile(abs, it.name, needle, s, results); }
        }
      } else if (s.type === 'folder') {
        let abs;
        try { abs = hostToContainer(s.hostPath); await assertRealWithin(HOST_ROOT, abs); } catch (_) { continue; }
        await walkTextFiles(abs, '', budget, (a, r) => grepFile(a, r, needle, s, results));
      } else if (s.type === 'inbox' || s.type === 'collab') {
        let root;
        try { root = resolveWithin(INBOX_DIR, s.relDir || ''); } catch (_) { continue; }
        await walkTextFiles(root, '', budget, (a, r) => grepFile(a, r, needle, s, results));
      }
    } catch (_) {}
  }
  res.json({
    query: q,
    results,
    scanned: budget.files,
    truncated: results.length >= SEARCH_MAX_RESULTS || budget.files >= SEARCH_MAX_FILES || Date.now() > budget.deadline,
  });
});

// --- Nominative sub-links (recipients) -------------------------------------
// One token per person for the same file/folder, so downloads are attributed
// individually. Sub-tokens are independent random tokens (not derived from the
// main token) and resolve to the parent share for all /s/ routes.
adminRouter.post('/shares/:id/recipients', (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type === 'inbox') return res.status(404).json({ error: 'not-found' });
  const b = req.body || {};
  let names = Array.isArray(b.names) ? b.names : String(b.name || b.names || '').split(/[\n,]/);
  names = names.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 50);
  if (!names.length) return res.status(400).json({ error: 'empty' });
  if (!Array.isArray(s.recipients)) s.recipients = [];
  const seen = new Set(s.recipients.map((r) => r.name.toLowerCase()));
  const added = [];
  for (const name of names) {
    if (name.length > 100 || seen.has(name.toLowerCase())) continue;
    const r = { token: newToken(), name, createdAt: Date.now(), stats: null };
    s.recipients.push(r);
    byToken.set(r.token, s);
    recipientByToken.set(r.token, { share: s, recipient: r });
    seen.add(name.toLowerCase());
    added.push(name);
  }
  if (!added.length) return res.status(409).json({ error: 'exists' });
  persist();
  auditReq(req, 'recipients-added', (s.name || s.id) + ': ' + added.join(', '));
  res.status(201).json({ share: decorateShare(s, req) });
});

adminRouter.delete('/shares/:id/recipients/:rtoken', (req, res) => {
  const s = getById(req.params.id);
  if (!s || !Array.isArray(s.recipients)) return res.status(404).json({ error: 'not-found' });
  const i = s.recipients.findIndex((r) => r.token === req.params.rtoken);
  if (i === -1) return res.status(404).json({ error: 'not-found' });
  const [r] = s.recipients.splice(i, 1);
  byToken.delete(r.token);
  recipientByToken.delete(r.token);
  persist();
  auditReq(req, 'recipient-removed', (s.name || s.id) + ': ' + (r.name || ''));
  res.json({ share: decorateShare(s, req) });
});

// Feature 16 — per-recipient overrides on a nominative sub-link: its own expiry
// and/or download cap (on top of the parent share's limits).
adminRouter.patch('/shares/:id/recipients/:rtoken', (req, res) => {
  const s = getById(req.params.id);
  if (!s || !Array.isArray(s.recipients)) return res.status(404).json({ error: 'not-found' });
  const r = s.recipients.find((x) => x.token === req.params.rtoken);
  if (!r) return res.status(404).json({ error: 'not-found' });
  const b = req.body || {};
  const changed = [];
  if (b.expiresInSeconds !== undefined) {
    const next = parseExpiry(b.expiresInSeconds); // null = never
    if (next) r.expiresAt = next; else delete r.expiresAt;
    changed.push('expiry');
  }
  if (b.maxDownloads !== undefined) {
    const n = Math.floor(Number(b.maxDownloads));
    if (Number.isFinite(n) && n > 0) r.maxDownloads = n; else delete r.maxDownloads;
    changed.push('maxDownloads');
  }
  persist();
  auditReq(req, 'recipient-updated', (s.name || s.id) + ': ' + (r.name || '') + ' (' + changed.join(', ') + ')');
  res.json({ share: decorateShare(s, req) });
});

// Clear the message list of a reception link (the notes left by senders). The
// uploaded files on disk and the received/quota counters are left untouched.
adminRouter.delete('/shares/:id/messages', (req, res) => {
  const s = getById(req.params.id);
  if (!s || s.type !== 'inbox') return res.status(404).json({ error: 'not-found' });
  const n = Array.isArray(s.messages) ? s.messages.length : 0;
  s.messages = [];
  persistNow(); // messages are persisted synchronously; clearing must be durable too
  auditReq(req, 'inbox-messages-cleared', (s.name || s.id) + ': ' + n + ' message(s)');
  res.json({ share: decorateShare(s, req) });
});

// Creating a reception link (the visitor will be able to upload files).
adminRouter.post('/inbox', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim() || 'Reception';
  // Destination sub-folder (sanitized) under INBOX_DIR.
  let relDir = name
    .replace(/[^A-Za-z0-9 _.-]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60);
  if (!relDir) relDir = 'reception';

  // Quotas & filters (all optional; 0 / empty = no limit).
  const nn = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const inbox = {
    type: 'inbox',
    name,
    relDir,
    startsAt: parseStartsAt(body.startsAt),
    expiresAt: parseExpiry(body.expiresInSeconds),
    maxFiles: nn(body.maxFiles),
    maxFileBytes: nn(body.maxFileBytes),
    maxTotalBytes: nn(body.maxTotalBytes),
    allowExt: normExtList(body.allowExt),
    blockExt: normExtList(body.blockExt),
    groupBySender: !!body.groupBySender, // file uploads into <sender>/<date>/ subfolders
    moderated: !!body.moderated, // feature 8: uploads wait for admin approval
    bytesReceived: 0,
  };
  // Instructions shown to visitors; falls back to the configured default banner.
  const note = (String(body.note || '').replace(/\r\n/g, '\n').trim()
    || String(getSettings().receptionBanner || '')).slice(0, 2000);
  if (note) inbox.note = note;
  // End-to-end encryption: the server only ever sees ciphertext, so filename-based
  // filters can't apply (names are encrypted) — drop them for encrypted links.
  if (body.encrypted) {
    inbox.encrypted = true;
    inbox.encMode = body.encMode === 'pass' ? 'pass' : 'key';
    inbox.allowExt = [];
    inbox.blockExt = [];
  }
  const password = String(body.password || '');
  // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
  // Same fixed-shape { pwHash } object as above — no client-controlled keys.
  if (password) Object.assign(inbox, makeSharePassword(password));
  applyAccessRules(inbox, body); // feature 11 — geo/IP rules
  stampOwner(inbox, req);
  const rec = addShare(inbox);
  auditReq(req, 'inbox-created', (inbox.encrypted ? 'encrypted ' : '') + inbox.name);
  res.status(201).json({ share: decorateShare(rec, req) });
});

// Feature 8 — moderation queue. Approve moves a pending upload into the link's
// target folder (counting it); reject deletes it. Pending metadata lives in
// state.meta.pending; the files themselves under PENDING_DIR.
adminRouter.post('/pending/:id/approve', async (req, res) => {
  const list = (state.meta && state.meta.pending) || [];
  const i = list.findIndex((p) => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not-found' });
  const p = list[i];
  const src = path.join(PENDING_DIR, p.id);
  const s = getById(p.shareId);
  if (!s) { try { fs.unlinkSync(src); } catch (_) {} list.splice(i, 1); persist(); return res.status(404).json({ error: 'share-gone' }); }
  if (!ownsShare(req, s)) return res.status(403).json({ error: 'forbidden' }); // operators: own links only
  const rootDir = s.type === 'collab' ? collabRoot(s) : resolveWithin(INBOX_DIR, s.relDir || '');
  const segs = String(p.name || 'file').split('/');
  const fname = safeUploadName(segs.pop());
  const subdir = segs.map(safeUploadName).filter(Boolean).join('/');
  const outcome = await withShareUploadLock(s.id, async () => {
    let size = Number(p.size) || 0;
    try { size = (await fs.promises.stat(src)).size; }
    catch (_) { return { error: 'write-error' }; }
    const reason = inboxRejectReason(s, p.name || fname, size);
    if (reason) return { error: reason };
    let dir;
    try { dir = resolveWithin(rootDir, subdir); await fs.promises.mkdir(dir, { recursive: true }); }
    catch (_) { return { error: 'inbox-dir' }; }
    let dest;
    try { dest = await reserveUniqueUploadPath(dir, fname); }
    catch (_) { return { error: 'write-error' }; }
    try { await fs.promises.rename(src, dest); }
    catch (_) {
      try { await fs.promises.copyFile(src, dest); await fs.promises.unlink(src); }
      catch (e) { try { await fs.promises.unlink(dest); } catch (_) {} return { error: 'write-error' }; }
    }
    s.bytesReceived = (s.bytesReceived || 0) + size;
    incrementDownloads(s.id);
    return { ok: true };
  });
  if (outcome.error) {
    const status = outcome.error === 'inbox-dir' || outcome.error === 'write-error' ? 500 : inboxRejectStatus(outcome.error);
    return res.status(status).json({ error: outcome.error });
  }
  list.splice(i, 1);
  persist();
  auditReq(req, 'pending-approved', (s.name || s.id) + ': ' + p.name);
  res.json({ ok: true });
});
adminRouter.post('/pending/:id/reject', (req, res) => {
  const list = (state.meta && state.meta.pending) || [];
  const i = list.findIndex((p) => p.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not-found' });
  if (req.session.role === 'operator' && !ownsShare(req, getById(list[i].shareId))) return res.status(403).json({ error: 'forbidden' });
  try { fs.unlinkSync(path.join(PENDING_DIR, req.params.id)); } catch (_) {}
  const [p] = list.splice(i, 1);
  persist();
  auditReq(req, 'pending-rejected', p ? ((p.shareName || '') + ': ' + p.name) : req.params.id);
  res.json({ ok: true });
});

// Creating a collaboration link: a two-way shared folder. Visitors can browse +
// download AND upload; deletion by the visitor is opt-in (allowDelete). The folder
// lives under INBOX_DIR with a unique suffix so links never share a directory.
adminRouter.post('/collab', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim() || 'Collaboration';
  const base = name.replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/^\.+/, '').trim().slice(0, 50) || 'collab';
  const relDir = base + '-' + crypto.randomBytes(3).toString('hex'); // unique per link
  const nn = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
  const password = String(body.password || '');
  const collab = {
    type: 'collab',
    name,
    relDir,
    startsAt: parseStartsAt(body.startsAt),
    expiresAt: parseExpiry(body.expiresInSeconds),
    // Visitor deletion is only allowed on a password-protected link (it lets an
    // unauthenticated visitor remove files) — mirrors the greyed-out UI checkbox.
    allowDelete: !!body.allowDelete && !!password,
    maxFiles: nn(body.maxFiles),
    maxFileBytes: nn(body.maxFileBytes),
    maxTotalBytes: nn(body.maxTotalBytes),
    allowExt: normExtList(body.allowExt),
    blockExt: normExtList(body.blockExt),
    moderated: !!body.moderated, // feature 8: uploads wait for admin approval
    bytesReceived: 0,
  };
  if (body.allowZip === false) collab.allowZip = false; // "download all as .zip" (default on)
  const note = (String(body.note || '').replace(/\r\n/g, '\n').trim()
    || String(getSettings().receptionBanner || '')).slice(0, 2000);
  if (note) collab.note = note;
  // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
  // Same fixed-shape { pwHash } object as elsewhere — no client-controlled keys.
  if (password) Object.assign(collab, makeSharePassword(password));
  applyAccessRules(collab, body); // feature 11 — geo/IP rules
  try { fs.mkdirSync(collabRoot(collab), { recursive: true }); } catch (_) {}
  stampOwner(collab, req);
  const rec = addShare(collab);
  auditReq(req, 'collab-created', collab.name + (collab.allowDelete ? ' (delete allowed)' : ''));
  res.status(201).json({ share: decorateShare(rec, req) });
});

// Create an end-to-end-encrypted download share. The request body is the opaque
// ciphertext (a DXE1 container built by the admin's browser); the server never
// sees the key or the plaintext. Metadata travels as query params. The body is
// NOT JSON, so express.json() upstream ignores it and the stream reaches here.
adminRouter.post('/enc-share', (req, res) => {
  const mode = req.query.mode === 'pass' ? 'pass' : 'key';
  const label = String(req.query.label || '').trim().slice(0, 200) || 'Encrypted file';
  const id = crypto.randomBytes(12).toString('hex');
  const dest = path.join(ENC_DIR, id + '.dxe');
  const ws = fs.createWriteStream(dest);
  let size = 0, failed = false;
  const fail = (code) => {
    if (failed) return;
    failed = true;
    try { ws.destroy(); } catch (_) {}
    fs.unlink(dest, () => {});
    if (!res.headersSent) res.status(code || 500).json({ error: 'write-error' });
  };
  const maxUp = effMaxUpload();
  req.on('data', (c) => {
    size += c.length;
    if (maxUp > 0 && size > maxUp) fail(413);
  });
  req.on('aborted', () => fail(400));
  req.on('error', () => fail(400));
  ws.on('error', () => fail(500));
  ws.on('finish', () => {
    if (failed) return;
    if (size === 0) return fail(400);
    const share = {
      type: 'file',
      name: label,
      size,
      encrypted: true,
      encMode: mode,
      encPath: dest,
      startsAt: parseStartsAt(req.query.startsAt),
      expiresAt: parseExpiry(req.query.expiresInSeconds),
      maxDownloads: parseMaxDownloads(req.query.maxDownloads),
    };
    stampOwner(share, req);
    const rec = addShare(share);
    auditReq(req, 'enc-share-created', mode + ' ' + label);
    res.status(201).json({ share: decorateShare(rec, req) });
  });
  req.pipe(ws);
});

// Feature 5 — store a burn-after-read secret note. The body is the opaque DXE
// ciphertext (built in the admin's browser); the server never sees the key or
// the plaintext. Metadata travels as query params. Returns a one-time token.
adminRouter.post('/secret', (req, res) => {
  const mode = req.query.mode === 'pass' ? 'pass' : 'key';
  const token = crypto.randomBytes(18).toString('base64url');
  const dest = path.join(SECRETS_DIR, token + '.dxe');
  const ws = fs.createWriteStream(dest, { mode: 0o600 });
  let size = 0, failed = false;
  const fail = (code) => {
    if (failed) return; failed = true;
    try { ws.destroy(); } catch (_) {}
    fs.unlink(dest, () => {});
    if (!res.headersSent) res.status(code || 500).json({ error: 'write-error' });
  };
  req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) fail(413); }); // secrets are small
  req.on('aborted', () => fail(400));
  req.on('error', () => fail(400));
  ws.on('error', () => fail(500));
  ws.on('finish', () => {
    if (failed) return;
    if (size === 0) return fail(400);
    if (!state.meta || typeof state.meta !== 'object') state.meta = {};
    if (!state.meta.secrets || typeof state.meta.secrets !== 'object') state.meta.secrets = {};
    state.meta.secrets[token] = {
      mode, size, createdAt: Date.now(),
      expiresAt: parseExpiry(req.query.expiresInSeconds),
    };
    persistNow();
    auditReq(req, 'secret-created', mode);
    const base = primaryBase(req);
    const rel = '/x/' + token;
    res.status(201).json({ token, path: rel, url: base ? base + rel : null, mode });
  });
  req.pipe(ws);
});

// QR code (SVG) for a link, generated locally (no third-party service).
adminRouter.get('/qr', async (req, res) => {
  const data = String(req.query.data || '');
  if (!data || data.length > 1024) return res.status(400).json({ error: 'invalid-data' });
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1 });
    res.type('image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    // Defense in depth: the `qrcode` package renders `data` purely as QR
    // modules (<path>/<rect> geometry) and never echoes it back as text, so
    // there's no injection surface here — but block MIME-sniffing anyway in
    // case a browser is ever tricked into treating this as something else.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: 'qr-failed' });
  }
});

// Aborting a transfer in progress (upload or download).
adminRouter.post('/transfers/:id/stop', (req, res) => {
  const t = activeTransfers.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not-found' });
  if (req.session.role === 'operator' && !ownsShare(req, getById(t.shareId))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  t.failureReason = 'stopped';
  if (typeof t.abort === 'function') {
    try { t.abort(); } catch (_) {}
  }
  res.json({ ok: true });
});

// Per-link statistics (aggregates), including links that were later revoked.
adminRouter.get('/stats', (req, res) => {
  const ids = Object.keys(state.stats).filter((id) => req.session.role !== 'operator' || ownsShare(req, getById(id)));
  const rows = ids.map((id) => {
    const st = state.stats[id];
    return { shareId: id, exists: byId.has(id), ...st };
  });
  rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  res.json({ stats: rows });
});

// Priority 2 dashboard filters and storage analysis.
function dashboardQueryOptions(req, now = Date.now()) {
  const dq = String(req.query.days || '30');
  const days = ['1', '7', '30', '90', '365'].includes(dq) ? parseInt(dq, 10) : (dq === 'all' || dq === '0' ? 0 : 30);
  const direction = ['up', 'down'].includes(String(req.query.direction || '')) ? String(req.query.direction) : '';
  const status = ['completed', 'interrupted'].includes(String(req.query.status || '')) ? String(req.query.status) : '';
  const allowedTypes = new Set(['file', 'folder', 'inbox', 'collab', 'secret', 'photo']);
  const type = allowedTypes.has(String(req.query.type || '')) ? String(req.query.type) : '';
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  return { days, cutoff: days > 0 ? now - days * 86400000 : 0, direction, status, type, q };
}

function dashboardRecordMatches(r, filters) {
  if (!r) return false;
  if (filters.direction && (r.direction === 'up' ? 'up' : 'down') !== filters.direction) return false;
  if (filters.status && (r.completed ? 'completed' : 'interrupted') !== filters.status) return false;
  if (filters.type && String(r.type || '') !== filters.type) return false;
  if (filters.q) {
    const rawIp = String(r.ip || '').replace(/^::ffff:/i, '');
    const shownIp = pubIp(rawIp);
    const hay = [r.name, r.shareId, r.recipientName, r.country, r.countryCode, shownIp, ipNameFor(shownIp)]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(filters.q)) return false;
  }
  return true;
}

function photoDashboardQueryOptions(req, now = Date.now()) {
  const dq = String(req.query.days || '30');
  const days = ['1', '7', '30', '90', '365'].includes(dq) ? parseInt(dq, 10) : (dq === 'all' || dq === '0' ? 0 : 30);
  const status = ['active', 'expired', 'inactive'].includes(String(req.query.status || '')) ? String(req.query.status) : '';
  const format = /^(jpg|png|gif|webp|bmp|avif)$/.test(String(req.query.format || '').toLowerCase()) ? String(req.query.format).toLowerCase() : '';
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  return { days, cutoff: days > 0 ? now - days * 86400000 : 0, status, format, q };
}

function photoMatchesDashboardFilters(s, filters, now) {
  if (!s || s.type !== 'photo') return false;
  if (filters.cutoff && (s.createdAt || 0) < filters.cutoff) return false;
  if (filters.format && photoExt(s) !== filters.format) return false;
  if (filters.status) {
    const expired = !s.revoked && !!s.expiresAt && now > s.expiresAt;
    const active = isActive(s, now);
    const status = active ? 'active' : expired ? 'expired' : 'inactive';
    if (status !== filters.status) return false;
  }
  if (filters.q && ![s.name, s.token, photoExt(s)].filter(Boolean).join(' ').toLowerCase().includes(filters.q)) return false;
  return true;
}

let receptionStorageScanCache = { at: 0, data: null };
async function scanReceptionStorage() {
  const now = Date.now();
  if (receptionStorageScanCache.data && now - receptionStorageScanCache.at < 60000) return receptionStorageScanCache.data;
  const MAX_ENTRIES = 25000;
  const stack = [INBOX_DIR];
  const byExt = new Map();
  const largest = [];
  let entries = 0, files = 0, directories = 0, managedBytes = 0, partialBytes = 0, partialFiles = 0, stalePartialBytes = 0, stalePartialFiles = 0;
  let truncated = false;
  while (stack.length && entries < MAX_ENTRIES) {
    const dir = stack.pop();
    let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const item of items) {
      if (++entries > MAX_ENTRIES) { truncated = true; break; }
      if (item.isSymbolicLink()) continue;
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) { directories += 1; stack.push(abs); continue; }
      if (!item.isFile()) continue;
      let st;
      try { st = await fs.promises.stat(abs); } catch (_) { continue; }
      const size = Math.max(0, Number(st.size) || 0);
      files += 1; managedBytes += size;
      const ext = (path.extname(item.name).slice(1).toLowerCase() || '(sans extension)').slice(0, 16);
      const e = byExt.get(ext) || { ext, bytes: 0, count: 0 };
      e.bytes += size; e.count += 1; byExt.set(ext, e);
      const rel = path.relative(INBOX_DIR, abs).split(path.sep).join('/');
      largest.push({ name: rel || item.name, bytes: size, modifiedAt: Number(st.mtimeMs) || 0 });
      largest.sort((a, b) => b.bytes - a.bytes);
      if (largest.length > 10) largest.length = 10;
      if (/(?:\.part|\.partial|\.tmp|\.upload)$/i.test(item.name)) {
        partialFiles += 1; partialBytes += size;
        if (now - (Number(st.mtimeMs) || now) > 24 * 60 * 60 * 1000) { stalePartialFiles += 1; stalePartialBytes += size; }
      }
    }
  }
  if (stack.length) truncated = true;
  const data = {
    managedBytes, files, directories, partialBytes, partialFiles, stalePartialBytes, stalePartialFiles,
    byExtension: [...byExt.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    largestFiles: largest, scannedEntries: entries, truncated, generatedAt: now,
  };
  receptionStorageScanCache = { at: now, data };
  return data;
}

// Lightweight real-time dashboard feed. Unlike /api/dashboard this endpoint
// never reads the transfer journal, so it can be polled every few seconds.
adminRouter.get('/dashboard/live', (req, res) => {
  let allowedShareIds = null;
  if (req.session.role === 'operator') {
    const owned = listShares().filter((s) => ownsShare(req, s));
    allowedShareIds = new Set(owned.map((s) => s.id));
  }
  const transfers = listTransfers(allowedShareIds);
  res.json({ transfers, stalledCount: transfers.filter((t) => t.stalled).length, stallThresholdMs: TRANSFER_STALL_MS, generatedAt: Date.now() });
});

// Aggregated analytics for the dashboard. Reads the full transfer journal
// (transfers.log) plus the per-link aggregates and produces ready-to-plot
// series. On-demand only — never part of the periodic shares poll.
adminRouter.get('/dashboard', async (req, res) => {
  const DAY_MS = 86400000;
  const now = Date.now();
  const filters = dashboardQueryOptions(req, now);
  const days = filters.days;
  const cutoff = filters.cutoff;
  const operatorScoped = req.session.role === 'operator';
  const visibleShares = operatorScoped ? listShares().filter((s) => ownsShare(req, s)) : null;
  const visibleShareIds = operatorScoped ? new Set(visibleShares.map((s) => s.id)) : null;
  const chartDays = days > 0 ? days : 365; // "all" shows the last year on historical charts
  const dayKey = (ts) => {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };

  // Pre-seed the chart buckets (oldest → newest) so the chart is continuous.
  const daily = [];
  const dayIndex = new Map();
  for (let i = chartDays - 1; i >= 0; i--) {
    const bucket = { day: dayKey(now - i * DAY_MS), count: 0, bytes: 0, up: 0, down: 0, completed: 0, interrupted: 0, durationMs: 0, throughputBytes: 0, successRate: 0, avgBps: 0 };
    dayIndex.set(bucket.day, bucket);
    daily.push(bucket);
  }

  // Only the recent tail is needed; readLogTail bounds both the read and the memory
  // (~16 MB max) instead of loading the whole journal just to keep the last lines.
  let lines = await readLogTailAsync(16 * 1024 * 1024);
  if (lines.length > 40000) lines = lines.slice(-40000); // bound the parse work

  const SMALL = 10 * 1024 * 1024;      // < 10 MB  → "small"
  const LARGE = 1024 * 1024 * 1024;    // ≥ 1 GB   → "large"
  const totals = { transfers: 0, bytes: 0, completed: 0, interrupted: 0, up: 0, down: 0 };
  const previousRaw = { transfers: 0, bytes: 0, completed: 0, interrupted: 0, up: 0, down: 0, durationMs: 0, throughputBytes: 0 };
  const previousCutoff = days > 0 ? cutoff - days * DAY_MS : 0;
  const userMap = new Map();
  const last24h = { transfers: 0, bytes: 0, completed: 0, interrupted: 0, up: 0, down: 0 };
  const last24Cutoff = now - DAY_MS;
  let last24Dur = 0, last24DurCount = 0, last24Bytes = 0;
  const recentErrors = [];
  const ips = new Set();
  const countryMap = new Map(); // code -> { country, code, flag, count, bytes }
  const clientMap = new Map();  // ip -> { down, downCount, up, upCount }
  const fileMap = new Map();    // name -> { count, bytes } (downloads)
  const linkMap = new Map();    // shareId -> { name, type, count, bytes }
  const sizeDist = { small: 0, medium: 0, large: 0 };
  const heat = new Array(168).fill(0); // day-of-week (0=Sun) * 24 + hour
  let sumDur = 0, cntDur = 0, sumBytesTh = 0, sumDurTh = 0;

  for (const line of lines) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (visibleShareIds && !visibleShareIds.has(r.shareId)) continue;
    if (!dashboardRecordMatches(r, filters)) continue;
    const ts = r.endedAt || r.startedAt || now;
    const bytes = Math.max(0, Number(r.bytes) || 0);
    const up = r.direction === 'up';

    // Priority dashboard metrics always cover the last 24 hours, independently
    // from the 7/30/90/all chart selector.
    if (ts >= last24Cutoff) {
      last24h.transfers += 1;
      last24h.bytes += bytes;
      if (up) last24h.up += 1; else last24h.down += 1;
      if (r.completed) last24h.completed += 1; else last24h.interrupted += 1;
      if (r.completed && r.durationMs > 0) {
        last24Dur += r.durationMs;
        last24DurCount += 1;
        last24Bytes += bytes;
      }
    }
    if (!r.completed) {
      const ip = pubIp(r.ip || '');
      recentErrors.push({
        id: r.id || null,
        name: r.name || '—',
        direction: up ? 'up' : 'down',
        type: r.type || null,
        bytes,
        durationMs: Math.max(0, Number(r.durationMs) || 0),
        at: ts,
        ip,
        ipName: ipNameFor(ip),
        reason: String(r.reason || 'interrupted').slice(0, 80),
      });
    }

    if (days > 0 && ts >= previousCutoff && ts < cutoff) {
      previousRaw.transfers += 1; previousRaw.bytes += bytes;
      if (up) previousRaw.up += 1; else previousRaw.down += 1;
      if (r.completed) {
        previousRaw.completed += 1;
        if (r.durationMs > 0) { previousRaw.durationMs += r.durationMs; previousRaw.throughputBytes += bytes; }
      } else previousRaw.interrupted += 1;
    }
    if (ts < cutoff) continue; // outside the selected period
    totals.transfers += 1;
    totals.bytes += bytes;
    if (up) totals.up += 1; else totals.down += 1;
    if (r.completed) totals.completed += 1; else totals.interrupted += 1;
    if (r.ip) ips.add(r.ip);
    const linkedShare = r.shareId ? getById(r.shareId) : null;
    const ownerName = r.ownerName || (linkedShare && linkedShare.ownerName) || '—';
    let user = userMap.get(ownerName);
    if (!user) { user = { user: ownerName, transfers: 0, bytes: 0, completed: 0, interrupted: 0, up: 0, down: 0, shares: 0 }; userMap.set(ownerName, user); }
    user.transfers += 1; user.bytes += bytes;
    if (up) user.up += 1; else user.down += 1;
    if (r.completed) user.completed += 1; else user.interrupted += 1;

    if (r.ip) {
      let c = clientMap.get(r.ip);
      if (!c) { c = { down: 0, downCount: 0, up: 0, upCount: 0 }; clientMap.set(r.ip, c); }
      if (up) { c.up += bytes; c.upCount += 1; } else { c.down += bytes; c.downCount += 1; }
    }

    const ck = r.countryCode || r.country || '??';
    let c = countryMap.get(ck);
    if (!c) {
      c = { country: r.country || '—', code: r.countryCode || '', flag: r.flag || '🌐', count: 0, bytes: 0 };
      countryMap.set(ck, c);
    }
    c.count += 1; c.bytes += bytes;

    // File-size distribution (per transfer).
    if (bytes < SMALL) sizeDist.small += 1; else if (bytes < LARGE) sizeDist.medium += 1; else sizeDist.large += 1;

    // Usage heatmap (local day-of-week × hour).
    const dt = new Date(ts);
    heat[dt.getDay() * 24 + dt.getHours()] += 1;

    // Average duration + overall throughput (completed transfers only).
    if (r.completed && r.durationMs > 0) { sumDur += r.durationMs; cntDur += 1; sumBytesTh += bytes; sumDurTh += r.durationMs; }

    // Top downloaded files (by name) and top links (by share).
    if (!up && r.name) { const f = fileMap.get(r.name) || { count: 0, bytes: 0 }; f.count += 1; f.bytes += bytes; fileMap.set(r.name, f); }
    if (r.shareId) {
      let l = linkMap.get(r.shareId);
      if (!l) { l = { shareId: r.shareId, name: r.name || null, type: r.type || 'down', count: 0, bytes: 0 }; linkMap.set(r.shareId, l); }
      l.count += 1; l.bytes += bytes;
    }

    const bucket = dayIndex.get(dayKey(ts));
    if (bucket) {
      bucket.count += 1; bucket.bytes += bytes;
      if (up) bucket.up += 1; else bucket.down += 1;
      if (r.completed) {
        bucket.completed += 1;
        if (r.durationMs > 0) { bucket.durationMs += r.durationMs; bucket.throughputBytes += bytes; }
      } else bucket.interrupted += 1;
    }
  }

  daily.forEach((bucket) => {
    bucket.successRate = bucket.count ? Math.round((bucket.completed / bucket.count) * 100) : 0;
    bucket.avgBps = bucket.durationMs > 0 ? Math.round(bucket.throughputBytes / (bucket.durationMs / 1000)) : 0;
  });

  totals.avgDurationMs = cntDur ? Math.round(sumDur / cntDur) : 0;
  totals.avgBps = sumDurTh > 0 ? Math.round(sumBytesTh / (sumDurTh / 1000)) : 0;
  totals.uniqueIps = ips.size;
  last24h.avgDurationMs = last24DurCount ? Math.round(last24Dur / last24DurCount) : 0;
  last24h.avgBps = last24Dur > 0 ? Math.round(last24Bytes / (last24Dur / 1000)) : 0;
  last24h.successRate = last24h.transfers ? Math.round((last24h.completed / last24h.transfers) * 100) : 0;
  recentErrors.sort((a, b) => b.at - a.at);
  if (recentErrors.length > 10) recentErrors.length = 10;
  totals.activeShares = visibleShares ? visibleShares.length : listShares().length;

  const byBytes = (a, b) => b.bytes - a.bytes;
  const countries = [...countryMap.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  // Top links from the journal window; the current name is resolved at read time.
  const topLinks = [...linkMap.values()]
    .map((l) => { const s = getById(l.shareId); return { name: (s && s.name) || l.name || l.shareId, type: (s && s.type) || l.type, bytes: l.bytes, count: l.count }; })
    .sort(byBytes).slice(0, 6);
  const topFiles = [...fileMap.entries()].map(([name, f]) => ({ name, count: f.count, bytes: f.bytes })).sort(byBytes).slice(0, 6);
  const topDownloaders = [...clientMap.entries()]
    .map(([ip, c]) => ({ ip, name: ipNameFor(ip), bytes: c.down, count: c.downCount }))
    .filter((c) => c.bytes > 0).sort(byBytes).slice(0, 5);
  const topUploaders = [...clientMap.entries()]
    .map(([ip, c]) => ({ ip, name: ipNameFor(ip), bytes: c.up, count: c.upCount }))
    .filter((c) => c.bytes > 0).sort(byBytes).slice(0, 5);


  const shareCountByOwner = new Map();
  for (const s of (visibleShares || listShares())) {
    const owner = s.ownerName || '—';
    shareCountByOwner.set(owner, (shareCountByOwner.get(owner) || 0) + 1);
  }
  for (const [owner, count] of shareCountByOwner) {
    let user = userMap.get(owner);
    if (!user) { user = { user: owner, transfers: 0, bytes: 0, completed: 0, interrupted: 0, up: 0, down: 0, shares: 0 }; userMap.set(owner, user); }
    user.shares = count;
  }
  const users = [...userMap.values()].map((u) => ({
    ...u, successRate: u.transfers ? Math.round((u.completed / u.transfers) * 100) : 0,
  })).sort((a, b) => b.bytes - a.bytes || b.transfers - a.transfers).slice(0, 12);
  const currentPeriod = finalizeTransferPeriodMetrics({
    transfers: totals.transfers, bytes: totals.bytes, completed: totals.completed, interrupted: totals.interrupted,
    up: totals.up, down: totals.down, durationMs: sumDurTh, throughputBytes: sumBytesTh,
  });
  const previousPeriod = finalizeTransferPeriodMetrics(previousRaw);
  const comparison = buildTransferComparison(days, currentPeriod, previousPeriod);

  // ---- Shares snapshot (current state, not period-based) ----
  const allShares = visibleShares || listShares();
  const soonMs = 7 * DAY_MS;
  const expiringSoon = allShares
    .filter((s) => s.expiresAt && s.expiresAt > now && s.expiresAt - now <= soonMs && isActive(s))
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, 8)
    .map((s) => ({ name: s.name, type: s.type, expiresAt: s.expiresAt, token: s.token }));
  let protectedCount = 0, encryptedCount = 0;
  allShares.forEach((s) => { if (s.pwHash) protectedCount += 1; if (s.encrypted) encryptedCount += 1; });
  const sharesSnap = {
    total: allShares.length,
    protected: protectedCount, open: allShares.length - protectedCount,
    encrypted: encryptedCount, plain: allShares.length - encryptedCount,
    expiringSoon,
  };

  // ---- Security ----
  const audit = !operatorScoped && Array.isArray(state.audit) ? state.audit : [];
  const failCutoff = now - (days > 0 ? days : 365) * DAY_MS;
  let failedLogins = 0;
  const recentLogins = [];
  for (const e of audit) {
    if ((e.action === 'login-fail' || e.action === 'login-2fa-fail') && e.at >= failCutoff) failedLogins += 1;
    else if (e.action === 'login' && recentLogins.length < 10) recentLogins.push({ actor: e.actor, ip: e.ip, at: e.at });
  }
  const lockedIps = [];
  if (!operatorScoped) {
    for (const [ip, r] of loginAttempts) if (r.lockUntil && r.lockUntil > now) lockedIps.push({ ip, until: r.lockUntil, kind: 'admin' });
    for (const [ip, r] of unlockFails) if (r.lockUntil && r.lockUntil > now) lockedIps.push({ ip, until: r.lockUntil, kind: 'link' });
  }
  const accts = operatorScoped ? [] : accountList();
  const security = {
    failedLogins,
    lockedIps,
    recentLogins,
    twoFA: {
      total: accts.length,
      enabled: accts.filter((a) => twoFactorEnabledFor(a)).length,
      accounts: accts.map((a) => ({ username: a.username, role: a.role, twoFactor: twoFactorEnabledFor(a) })),
    },
  };

  // ---- Storage (free/used on the reception volume + managed-file analysis) ----
  let storage = null;
  let storageAnalysis = null;
  try {
    if (operatorScoped) throw new Error('restricted');
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(INBOX_DIR);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      storage = { total, free, used: Math.max(0, total - free), path: INBOX_DIR };
    }
    storageAnalysis = await scanReceptionStorage();
  } catch (_) { storage = null; storageAnalysis = null; }

  // ---- Webhook status ----
  const webhook = operatorScoped ? { configured: false, restricted: true } : effectiveWebhook().url
    ? { configured: true, lastAt: lastWebhook ? lastWebhook.at : null, lastOk: lastWebhook ? lastWebhook.ok : null, lastError: lastWebhook ? lastWebhook.error : null, lastEvent: lastWebhook ? lastWebhook.event : null }
    : { configured: false };

  // ---- E-mail status ----
  const email = operatorScoped ? { configured: false, restricted: true } : emailConfigured()
    ? { configured: true, lastAt: lastEmail ? lastEmail.at : null, lastOk: lastEmail ? lastEmail.ok : null, lastError: lastEmail ? lastEmail.error : null }
    : { configured: false };


  const alerts = [];
  if (storage && storage.total > 0) {
    const usedPct = Math.round((storage.used / storage.total) * 100);
    if (usedPct >= 90) alerts.push({ level: 'critical', code: 'disk-critical', params: { pct: usedPct, free: formatBytes(storage.free) } });
    else if (usedPct >= 80) alerts.push({ level: 'warning', code: 'disk-warning', params: { pct: usedPct, free: formatBytes(storage.free) } });
  }
  const failureRate = totals.transfers ? Math.round((totals.interrupted / totals.transfers) * 100) : 0;
  if (totals.transfers >= 5 && failureRate >= 25) alerts.push({ level: failureRate >= 50 ? 'critical' : 'warning', code: 'failure-rate', params: { pct: failureRate, n: totals.interrupted } });
  if (comparison.available && previousPeriod.interrupted > 0 && totals.interrupted >= previousPeriod.interrupted * 2 && totals.interrupted - previousPeriod.interrupted >= 3) {
    alerts.push({ level: 'warning', code: 'failure-increase', params: { current: totals.interrupted, previous: previousPeriod.interrupted } });
  }
  if (storageAnalysis && storageAnalysis.stalePartialFiles > 0) alerts.push({ level: 'warning', code: 'stale-parts', params: { n: storageAnalysis.stalePartialFiles, space: formatBytes(storageAnalysis.stalePartialBytes || 0) } });
  if (security.lockedIps && security.lockedIps.length) alerts.push({ level: 'critical', code: 'locked-ips', params: { n: security.lockedIps.length } });
  if (webhook.configured && webhook.lastAt && webhook.lastOk === false) alerts.push({ level: 'warning', code: 'webhook-failed', params: {} });
  if (email.configured && email.lastAt && email.lastOk === false) alerts.push({ level: 'warning', code: 'email-failed', params: {} });

  res.json({
    period: days, filters: { direction: filters.direction, status: filters.status, type: filters.type, q: filters.q },
    totals, last24h, recentErrors, daily, countries, topLinks, topFiles, topDownloaders, topUploaders,
    sizeDist, heatmap: heat, heatMax: Math.max(0, ...heat),
    shares: sharesSnap, security, storage, storageAnalysis, webhook, email,
    comparison, users, alerts, generatedAt: now,
  });
});

// Export the currently filtered transfer dashboard as CSV.
adminRouter.get('/dashboard/export.csv', async (req, res) => {
  const now = Date.now();
  const filters = dashboardQueryOptions(req, now);
  const operatorScoped = req.session.role === 'operator';
  const visibleShareIds = operatorScoped
    ? new Set(listShares().filter((s) => ownsShare(req, s)).map((s) => s.id))
    : null;
  let lines = await readLogTailAsync(64 * 1024 * 1024);
  if (lines.length > 150000) lines = lines.slice(-150000);
  const rows = [];
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (visibleShareIds && !visibleShareIds.has(r.shareId)) continue;
    if (!dashboardRecordMatches(r, filters)) continue;
    const ts = r.endedAt || r.startedAt || 0;
    if (filters.cutoff && ts < filters.cutoff) continue;
    rows.push(r);
  }
  const cols = ['endedAt', 'direction', 'status', 'type', 'name', 'shareId', 'recipient', 'ip', 'clientName', 'country', 'bytes', 'durationMs', 'avgBps', 'reason'];
  const out = [cols.join(',')];
  for (const r of rows) {
    const ip = pubIp(String(r.ip || '').replace(/^::ffff:/i, ''));
    out.push([
      new Date(r.endedAt || r.startedAt || 0).toISOString(), r.direction || 'down', r.completed ? 'completed' : 'interrupted',
      r.type || '', r.name || '', r.shareId || '', r.recipientName || '', ip, ipNameFor(ip) || '', r.country || '',
      r.bytes || 0, r.durationMs || 0, r.avgBps || 0, r.reason || '',
    ].map(csvField).join(','));
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-dashboard-${stamp}.csv"`);
  res.send('\uFEFF' + out.join('\r\n'));
});

// Export the persistent transfer journal (transfers.log) as CSV or JSON.
adminRouter.get('/transfers/export', requireFullAdmin, (req, res) => {
  const fmt = String(req.query.format || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
  let lines = [];
  try {
    lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    lines = []; // no journal yet
  }
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch (_) {}
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  if (fmt === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-transfers-${stamp}.json"`);
    return res.send(JSON.stringify(records, null, 2));
  }

  const cols = ['endedAt', 'direction', 'name', 'shareId', 'ip', 'country', 'bytes', 'durationMs', 'avgBps', 'completed'];
  const out = [cols.join(',')];
  for (const r of records) {
    out.push([
      new Date(r.endedAt || 0).toISOString(),
      r.direction || '', r.name || '', r.shareId || '', r.ip || '',
      r.country || '', r.bytes || 0, r.durationMs || 0, r.avgBps || 0,
      r.completed ? '1' : '0',
    ].map(csvField).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-transfers-${stamp}.csv"`);
  res.send('\uFEFF' + out.join('\r\n')); // BOM so Excel reads UTF-8
});

// Purge the transfer history: clears the in-app list (state.history) AND the
// durable journal (transfers.log) so exports don't resurrect it. Per-share
// aggregate stats are kept. Active transfers are untouched.
adminRouter.delete('/history', requireFullAdmin, (req, res) => {
  const removed = state.history.length;
  state.history = [];
  try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {}
  persist();
  auditReq(req, 'history-cleared', removed + ' record(s)');
  res.json({ ok: true, cleared: removed });
});

// Graceful server shutdown requested from the admin interface. We answer first,
// then trigger the shutdown on the next tick so the response reaches the browser.
adminRouter.post('/shutdown', (req, res) => {
  auditReq(req, 'server-shutdown');
  res.json({ ok: true });
  console.log('[lifecycle] shutdown requested from the admin interface.');
  setTimeout(() => shutdown('admin-request'), 250);
});

adminRouter.get('/browse', async (req, res) => {
  const reqPath = String(req.query.path || '/'); // real host path (absolute)
  let absDir;
  try {
    absDir = hostToContainer(reqPath);
    await assertRealWithin(HOST_ROOT, absDir);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'host-inaccessible', root: '/' });
    return res.status(400).json({ error: 'invalid-path' });
  }

  let st;
  try {
    st = await fs.promises.stat(absDir);
  } catch (e) {
    return res.status(404).json({ error: 'not-found' });
  }
  if (!st.isDirectory()) return res.status(400).json({ error: 'not-a-folder' });

  let dirents;
  try {
    dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch (e) {
    return res.status(403).json({ error: 'read-failed' });
  }

  const entries = [];
  for (const d of dirents) {
    const isDir = d.isDirectory();
    const isFile = d.isFile();
    if (!isDir && !isFile) continue;
    entries.push({
      name: d.name,
      isDir,
      isFile,
      size: null,
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal,javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
      // d.name is a dirent from fs.readdir(absDir) above (absDir itself was
      // already validated), not user-supplied text.
      path: containerToHost(path.join(absDir, d.name)),
    });
  }

  const files = entries.filter((e) => e.isFile);
  await mapLimit(files, 32, async (e) => {
    try {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal,javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
      // e.name likewise comes from fs.readdir(), not from the request.
      e.size = (await fs.promises.stat(path.join(absDir, e.name))).size;
    } catch (_) {}
  });
  entries.forEach((e) => delete e.isFile);

  const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return coll.compare(a.name, b.name);
  });

  const cwd = containerToHost(absDir);
  res.json({
    root: '/',
    cwd,
    parent: cwd === '/' ? null : containerToHost(path.dirname(absDir)),
    entries,
  });
});

// In-browser preview of an arbitrary host file, used by the admin file picker
// (before any share exists). Mirrors /s/:token/view but scoped to the admin
// session instead of a share, and restricted to safe, renderable kinds.
adminRouter.get('/preview', async (req, res) => {
  const reqPath = String(req.query.path || '');
  let absFile;
  try {
    absFile = hostToContainer(reqPath);
    await assertRealWithin(HOST_ROOT, absFile);
  } catch (e) {
    return res.status(400).json({ error: 'invalid-path' });
  }
  let st;
  try {
    st = await fs.promises.stat(absFile);
  } catch (e) {
    return res.status(404).json({ error: 'not-found' });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not-a-file' });
  const name = path.basename(absFile);
  const info = previewInfo(name);
  if (!info || (info.kind !== 'video' && info.kind !== 'image' && info.kind !== 'audio')) {
    return res.status(415).json({ error: 'unsupported' });
  }
  streamFile(req, res, absFile, name, null, null, { inline: true, contentType: info.contentType });
});

adminRouter.get('/network', async (req, res) => {
  const locals = getLocalIPv4s();
  const publicIp = await getPublicIP().catch(() => null);
  const target = externalTarget(req);
  res.json({
    port: PORT,
    locals,
    publicIp,
    base: primaryBase(req),
    publicUrl: PUBLIC_URL || null,
    behindProxy: !!TRUST_PROXY,
    testLabel: target ? target.label : publicIp ? `${publicIp}:${PORT}` : null,
  });
});

adminRouter.post('/network/port-check', async (req, res) => {
  // Optional `base` override lets the Images page test its own domain (imageBase).
  const target = externalTarget(req, (req.body && typeof req.body.base === 'string') ? req.body.base : '');
  let host;
  let port;
  let label;
  if (target) {
    host = target.host;
    port = target.port;
    label = target.label;
  } else {
    host = await getPublicIP().catch(() => null);
    port = PORT;
    label = host ? `${host}:${port}` : null;
  }
  if (!host) return res.json({ open: null, error: 'unknown-target', host: null, port, label: null });
  const result = await checkPort(host, port);
  res.json({ ...result, host, port, label });
});

// Reverse-proxy diagnostic: inspects the forwarding headers actually received on
// THIS admin request and reports whether the proxy is wired correctly (real
// visitor IP, HTTPS propagation, host) against the server's TRUST_PROXY setting.
adminRouter.get('/network/proxy-check', (req, res) => {
  const requestedBase = typeof req.query.base === 'string' ? req.query.base.trim() : '';
  const testedBase = requestedBase ? normalizeLinkBase(requestedBase) : null;
  const h = req.headers || {};
  const pick = (name) => (h[name] != null ? String(h[name]) : null);
  // Relevant forwarding headers (only the ones actually present are returned).
  const names = [
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port',
    'x-real-ip', 'forwarded', 'via', 'x-forwarded-server', 'cf-connecting-ip',
    'cf-ray', 'x-forwarded-ssl', 'x-scheme',
  ];
  const headers = {};
  for (const n of names) { const v = pick(n); if (v) headers[n] = v.slice(0, 300); }

  const remoteAddr = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '') || null;
  const xffRaw = pick('x-forwarded-for') || '';
  const forwardedForChain = xffRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const xfProto = (pick('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const proxyDetected = !!(xffRaw || headers['x-real-ip'] || headers['forwarded'] || xfProto ||
    headers['cf-connecting-ip'] || headers['via'] || headers['x-forwarded-server']);

  // Best-effort identification of the proxy software from its fingerprints.
  let detectedProxy = null;
  if (headers['cf-connecting-ip'] || headers['cf-ray']) detectedProxy = 'Cloudflare';
  else if (/traefik/i.test(headers['x-forwarded-server'] || '') || headers['x-forwarded-server']) detectedProxy = 'Traefik';
  else if (/\bvarnish\b/i.test(headers['via'] || '')) detectedProxy = 'Varnish';
  else if (headers['via']) detectedProxy = headers['via'];

  // Each check carries a stable `code` + `params`; the admin UI localizes them.
  const checks = [];
  const add = (level, code, params) => checks.push({ level, code, params: params || {} });

  if (proxyDetected && !TRUST_PROXY) {
    add('bad', 'proxy-untrusted', { peer: remoteAddr || '?' });
  } else if (!proxyDetected && TRUST_PROXY) {
    add('warn', 'trust-no-headers', {});
  } else if (proxyDetected && TRUST_PROXY) {
    add('ok', 'proxy-ok', { ip: clientIp(req) });
  } else {
    add('ok', 'direct', { ip: remoteAddr || '?' });
  }

  // HTTPS propagation.
  if (xfProto === 'https' && req.protocol !== 'https') {
    add('bad', 'https-not-trusted', {});
  } else if (xfProto === 'https' && req.protocol === 'https') {
    add('ok', 'https-ok', {});
  } else if (proxyDetected && !xfProto) {
    add('warn', 'no-proto', {});
  }

  // Host propagation.
  if (headers['x-forwarded-host'] && headers['x-forwarded-host'] !== pick('host')) {
    add('info', 'host-diff', { pub: headers['x-forwarded-host'], internal: pick('host') || '?' });
  }

  // Peer sanity.
  if (proxyDetected && remoteAddr && !isPrivateIp(remoteAddr)) {
    add('warn', 'public-peer', { ip: remoteAddr });
  }
  if (forwardedForChain.length > 1) {
    add('info', 'multi-hop', { n: forwardedForChain.length, chain: forwardedForChain.join(' → ') });
  }

  // Large-upload reminder (not detectable from headers, always relevant here).
  add('info', 'buffering', {});

  const verdict = checks.some((c) => c.level === 'bad') ? 'bad'
    : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';

  res.json({
    verdict,
    trustProxy: !!TRUST_PROXY,
    trustProxyValue: TRUST_PROXY ? String(TRUST_PROXY) : null,
    proxyDetected,
    detectedProxy,
    remoteAddr,
    remoteIsPrivate: remoteAddr ? isPrivateIp(remoteAddr) : null,
    clientIp: clientIp(req),
    protocol: req.protocol,
    secure: req.protocol === 'https',
    testedBase,
    host: pick('host'),
    forwardedForChain,
    headers,
    checks,
  });
});

function parseExpiry(seconds) {
  const n = parseInt(seconds, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Date.now() + n * 1000;
}
// Deferred activation: absolute epoch-ms start time. A past/invalid value means
// "active now" (no deferral) → null. Capped at ~2 years out.
function parseStartsAt(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= Date.now()) return null;
  return Math.min(n, Date.now() + 2 * 365 * 86400000);
}
function parseMaxDownloads(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ===================================================================
//  EXPRESS APPLICATION
// ===================================================================

// Determines whether an IP is allowed to reach the admin.
// UI-configured admin allowlist (used only when the env var is unset). Parsed
// lazily and cached until the raw string changes.
let uiAllowCache = { raw: null, list: [] };
function uiAdminAllowedIps() {
  const raw = String(getSettings().adminAllowedIps || '');
  if (raw !== uiAllowCache.raw) uiAllowCache = { raw, list: parseIpList(raw) };
  return uiAllowCache.list;
}
// Priority: env ADMIN_ALLOWED_IPS > UI allowlist > ADMIN_ALLOW_ANY > local network.
// Loopback is always allowed so the admin can never fully lock themselves out
// from the host itself.
function isAdminAllowed(ip) {
  if (ADMIN_ALLOWED_IPS.length) return isLoopback(ip) || ipInList(ip, ADMIN_ALLOWED_IPS);
  const ui = uiAdminAllowedIps();
  if (ui.length) return isLoopback(ip) || ipInList(ip, ui);
  if (ADMIN_ALLOW_ANY) return true;
  return isLocalNetwork(ip);
}

// Restricts access to the admin (to the local network by default).
// Public pages (download, reception, /logo.svg) do not go through here.
function adminGuard(req, res, next) {
  if (isAdminAllowed(clientIp(req))) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'admin-lan-only' });
  const lang = pickLang(req);
  res.status(403).type('html').send(errorPage(lang, 403, (PUB[lang] || PUB.en).adminLanOnly));
}

// nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage
// No `csurf`/`csrf` package here on purpose — CSRF is handled by a custom
// double-submit token: every session gets a random `csrf` value (see
// startSession()), the client must echo it back in the `X-CSRF-Token` header
// on every non-GET/HEAD/OPTIONS request, and requireAuth() rejects the
// request (timing-safe comparison) if it's missing or wrong. See
// getSession()/requireAuth() above.
const app = express();
app.disable('x-powered-by');
app.disable('etag');
if (TRUST_PROXY) app.set('trust proxy', TRUST_PROXY);

// Common security headers.
app.use((req, res, next) => {
  const cspNonce = crypto.randomBytes(18).toString('base64');
  requestContext.run({ cspNonce }, () => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; ` +
        "img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
    );
    next();
  });
});

// Public downloads and receptions (no authentication).
app.use('/', downloadRouter);

// Public resources (logo + reception page script),
// used by the public pages AND the admin interface (outside the network restriction).
app.get('/logo.svg', (req, res) => {
  res.type('image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'public', 'logo.svg'));
});
app.get('/reception.js', (req, res) => {
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'reception.js'));
});
// Browser-side crypto libs for end-to-end-encrypted download shares AND
// encrypted reception links. Served publicly (outside the admin network
// restriction) because the public download/reception pages load them.
app.get('/dxcrypto.js', (req, res) => {
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'dxcrypto.js'));
});
app.get('/dxdecrypt.js', (req, res) => {
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'dxdecrypt.js'));
});
// Feature 7 — proof-of-work solver for the download challenge interstitial.
app.get('/dxpow.js', (req, res) => {
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'dxpow.js'));
});
// Feature 3 — playlist media player driver.
app.get('/dxplayer.js', (req, res) => {
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'dxplayer.js'));
});
// Public drivers for burn-after-read secret notes and collaboration links.
// They must stay outside adminGuard because remote visitors load them directly.
app.get('/dxsecret.js', (req, res) => {
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'dxsecret.js'));
});
app.get('/dxcollab.js', (req, res) => {
  res.type('text/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'dxcollab.js'));
});

// Companion PWA — a mobile "send" app (photos / documents / files → a reception
// link), served at /app. A paired device receives a revocable HttpOnly cookie that
// authorizes ONLY this PWA surface — never /api or the admin interface. Pairing itself
// still requires a valid admin session and the normal admin IP allowlist.
function pwaDeviceOwnerMap() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!state.meta.pwaDeviceOwners || typeof state.meta.pwaDeviceOwners !== 'object' || Array.isArray(state.meta.pwaDeviceOwners)) {
    state.meta.pwaDeviceOwners = {};
  }
  return state.meta.pwaDeviceOwners;
}
function rememberPwaDeviceOwner(device) {
  if (!device || !device.id) return false;
  const creator = (device.createdByAccountId && getAccountById(device.createdByAccountId)) || findAccountByName(device.createdBy || '');
  if (!creator) return false;
  const owners = pwaDeviceOwnerMap();
  const previous = owners[device.id];
  const next = { accountId: creator.id, username: creator.username || device.createdBy || null, updatedAt: Date.now() };
  if (previous && previous.accountId === next.accountId && previous.username === next.username) return false;
  owners[device.id] = next;
  return true;
}
function pwaDeviceOwnerAccount(deviceId) {
  deviceId = String(deviceId || '');
  if (!deviceId) return null;
  const current = Array.isArray(state.meta && state.meta.pwaDevices)
    ? state.meta.pwaDevices.find((device) => device && device.id === deviceId)
    : null;
  if (current) {
    const creator = (current.createdByAccountId && getAccountById(current.createdByAccountId)) || findAccountByName(current.createdBy || '');
    if (creator) return creator;
  }
  const remembered = pwaDeviceOwnerMap()[deviceId];
  return remembered && remembered.accountId ? getAccountById(remembered.accountId) : null;
}
function pwaDevices() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!Array.isArray(state.meta.pwaDevices)) state.meta.pwaDevices = [];
  const cutoff = Date.now() - 400 * 86400000;
  let changed = false;
  // Record the account behind every capability before old device records are pruned.
  // This durable index lets a replacement/reinstalled PWA recover links created by
  // the previous device credential instead of opening an apparently empty workspace.
  for (const d of state.meta.pwaDevices) {
    if (!d || !d.id) continue;
    if (!d.createdByAccountId && d.createdBy) {
      const creator = findAccountByName(d.createdBy);
      if (creator) { d.createdByAccountId = creator.id; changed = true; }
    }
    if (rememberPwaDeviceOwner(d)) changed = true;
  }
  state.meta.pwaDevices = state.meta.pwaDevices.filter((d) => d && d.id && d.hash && (d.createdAt || 0) > cutoff);
  // Devices created before 1.23.1 did not have their own CSRF token. Upgrade
  // them lazily so existing pairings remain valid without weakening mutations.
  for (const d of state.meta.pwaDevices) {
    if (!d.csrf || !/^[A-Za-z0-9_-]{32,128}$/.test(String(d.csrf))) {
      d.csrf = crypto.randomBytes(32).toString('base64url');
      changed = true;
    }
  }
  const owners = pwaDeviceOwnerMap();
  const ownerIds = Object.keys(owners);
  if (ownerIds.length > 500) {
    ownerIds.sort((a, b) => Number(owners[b] && owners[b].updatedAt || 0) - Number(owners[a] && owners[a].updatedAt || 0));
    for (const id of ownerIds.slice(500)) { delete owners[id]; changed = true; }
  }
  if (changed) scheduleFlush();
  return state.meta.pwaDevices;
}

function cleanDeviceLabel(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || null;
}
function requestClientDeviceName(req, source) {
  if (req && req.pwaDevice && req.pwaDevice.name) return cleanDeviceLabel(req.pwaDevice.name);
  if (source === 'host') return 'Serveur · fichier hôte';
  const ua = String((req && req.headers && req.headers['user-agent']) || '');
  let browser = '';
  if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome\//i.test(ua) || /CriOS\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';
  let platform = '';
  if (/Android/i.test(ua)) platform = 'Android';
  else if (/iPhone|iPad|iPod/i.test(ua)) platform = 'iOS';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';
  const prefix = source === 'collaborator' ? 'Collaborateur' : 'Web';
  return cleanDeviceLabel([prefix, browser, platform].filter(Boolean).join(' · ')) || prefix;
}
function stampPhotoUploadDevice(share, req, source) {
  if (!share || share.type !== 'photo') return share;
  const label = requestClientDeviceName(req, source);
  if (label) share.uploadDeviceName = label;
  if (source) share.uploadSource = String(source).slice(0, 32);
  return share;
}
// Live name of the paired PWA device that created a share, resolved from its stable
// ownerDeviceId. Reading the current device.name (not a snapshot) means a rename done
// in the companion app is reflected everywhere the creator device is shown. Returns
// null for links created from a browser admin session or that predate device stamping.
function shareCreatorDeviceName(share) {
  if (!share || !share.ownerDeviceId) return null;
  const device = pwaDevices().find((d) => d.id === share.ownerDeviceId);
  return (device && cleanDeviceLabel(device.name)) || null;
}
function photoUploadDeviceName(share) {
  if (!share || share.type !== 'photo') return null;
  const stored = cleanDeviceLabel(share.uploadDeviceName);
  if (stored) return stored;
  return shareCreatorDeviceName(share);
}

function pwaSecretHash(secret) { return crypto.createHash('sha256').update(String(secret)).digest('hex'); }
function validatePwaDeviceCredential(raw, touch = true, allowLocked = false) {
  raw = String(raw || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const id = raw.slice(0, dot), secret = raw.slice(dot + 1);
  if (!/^[a-f0-9]{24}$/i.test(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) return null;
  const device = pwaDevices().find((d) => d.id === id);
  if (!device || !timingSafeEqualStr(device.hash, pwaSecretHash(secret))) return null;
  if (device.sessionLockedAt && !allowLocked) return null;
  if (touch && Date.now() - (device.lastUsedAt || 0) > 3600000) {
    device.lastUsedAt = Date.now();
    scheduleFlush();
  }
  return device;
}
function getPwaDevice(req, touch = true, allowLocked = false) {
  return validatePwaDeviceCredential(parseCookies(req).dxpwa || '', touch, allowLocked);
}
function appendSetCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  if (!current) return res.setHeader('Set-Cookie', value);
  if (Array.isArray(current)) return res.setHeader('Set-Cookie', current.concat(value));
  return res.setHeader('Set-Cookie', [current, value]);
}
function setPwaDeviceCookie(req, res, id, secret) {
  const maxAge = 365 * 86400;
  // SameSite=Lax so the durable device capability survives a home-screen WebAPK
  // launch and a Web Share Target (both cross-site top-level navigations, where a
  // Strict cookie would be dropped and the device would appear unpaired / its
  // images and albums "reset"). Mutations under /app still require the per-device
  // X-CSRF-Token and an exact same-origin Origin header, so Lax is CSRF-safe here.
  appendSetCookie(res, `dxpwa=${id}.${secret}; HttpOnly; SameSite=Lax; Path=/app; Max-Age=${maxAge}${secureCookie(req)}`);
}
function clearPwaDeviceCookie(req, res) {
  appendSetCookie(res, `dxpwa=; HttpOnly; SameSite=Lax; Path=/app; Max-Age=0${secureCookie(req)}`);
}
function createPwaDevice(name, createdBy) {
  const id = crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const creator = findAccountByName(createdBy);
  const device = {
    id,
    hash: pwaSecretHash(secret),
    csrf: crypto.randomBytes(32).toString('base64url'),
    name: String(name || 'Direct-Xfer PWA').replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Direct-Xfer PWA',
    createdAt: now,
    lastUsedAt: now,
    createdBy: createdBy || null,
    createdByAccountId: creator ? creator.id : null,
  };
  const list = pwaDevices();
  list.push(device);
  while (list.length > 30) list.shift();
  scheduleFlush();
  return { device, secret };
}
function issuePwaDevice(req, res, name, createdBy) {
  const issued = createPwaDevice(name, createdBy);
  setPwaDeviceCookie(req, res, issued.device.id, issued.secret);
  return issued.device;
}

// One-time QR pairing tickets are kept only in memory. They expire after five
// minutes and are consumed atomically, so a captured QR cannot be reused.
const pwaPairTickets = new Map();
function prunePwaPairTickets() {
  const now = Date.now();
  for (const [ticket, meta] of pwaPairTickets) if (!meta || meta.expiresAt <= now) pwaPairTickets.delete(ticket);
}
app.get('/app/device/claim', (req, res) => {
  prunePwaPairTickets();
  const ticket = String(req.query.ticket || '');
  const meta = pwaPairTickets.get(ticket);
  if (!meta || !/^[A-Za-z0-9_-]{32,128}$/.test(ticket)) {
    return res.status(410).type('html').send(errorPage(pickLang(req), 410, 'Pairing link expired or already used.'));
  }
  pwaPairTickets.delete(ticket);
  const device = issuePwaDevice(req, res, meta.name || 'Direct-Xfer PWA (QR)', meta.createdBy);
  logAudit('pwa-device-paired', { username: meta.createdBy || 'admin', ip: clientIp(req), detail: device.name + ' (QR)' });
  res.redirect(303, '/app/?paired=1');
});

// Canonical installation resources deliberately live outside /app. Some reverse
// proxies and identity gateways attach redirects to protected /app paths; Chrome
// refuses a service-worker script after ANY redirect, even when the final response
// is HTTP 200. These aliases are immutable public assets only — no API or private
// data is exposed — and are served directly by Express with exact MIME headers.
function sendPwaInstallAsset(res, filename, contentType, serviceWorker) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (serviceWorker) res.setHeader('Service-Worker-Allowed', '/app/');
  return res.sendFile(path.join(__dirname, 'pwa', filename));
}
app.get('/direct-xfer-pwa.webmanifest', (req, res) => sendPwaInstallAsset(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8', false));
app.get('/direct-xfer-pwa-en.webmanifest', (req, res) => sendPwaInstallAsset(res, 'manifest-en.webmanifest', 'application/manifest+json; charset=utf-8', false));
app.get('/direct-xfer-pwa-es.webmanifest', (req, res) => sendPwaInstallAsset(res, 'manifest-es.webmanifest', 'application/manifest+json; charset=utf-8', false));
app.get('/direct-xfer-pwa-sw.js', (req, res) => sendPwaInstallAsset(res, 'sw.js', 'application/javascript; charset=utf-8', true));

// Only static PWA resources are public. The application document itself now
// requires either an administrator session or an already-paired device. A new
// mobile visit is sent to /app/login, a dedicated administrator sign-in screen.
const PWA_PUBLIC_ASSET_PATHS = new Set([
  '/app.css',
  '/app.js',
  '/login.css',
  '/login.js',
  '/login-vault.js',
  '/theme-init.js',
  '/sw.js',
  '/manifest.webmanifest',
  '/manifest-en.webmanifest',
  '/manifest-es.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.svg',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/screenshot-mobile.png',
  '/screenshot-wide.png',
  '/launch',
  '/launch.html',
]);
function isPublicPwaAssetRequest(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && PWA_PUBLIC_ASSET_PATHS.has(req.path);
}
function pwaNetworkGuard(req, res, next) {
  if (isPublicPwaAssetRequest(req) || getPwaDevice(req, false)) return next();
  return adminGuard(req, res, next);
}

function pwaHttpsInstallUrl() {
  const origin = normalizedOrigin(PUBLIC_URL);
  return origin.startsWith('https://') ? origin + '/app' : '';
}

// Installability diagnostics used by the mobile login and PWA. PUBLIC_URL is
// already the externally advertised base, so returning its HTTPS /app URL does
// not reveal any private configuration.
app.get('/app/install-info', pwaNetworkGuard, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ secure: req.secure, httpsUrl: pwaHttpsInstallUrl(), requiresTrustedHttps: true });
});

function safePwaNext(raw) {
  const value = String(raw || '/app/');
  if (!/^\/app(?:\/|\?|$)/.test(value) || value.startsWith('//') || /[\r\n]/.test(value)) return '/app/';
  return value === '/app' ? '/app/' : value;
}

// The bare /app entry is intentionally a login entry point. The installed PWA
// and existing paired devices keep using /app/ directly.
app.get('/app', adminGuard, (req, res, next) => {
  if (req.originalUrl.split('?')[0].endsWith('/')) return next();
  const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const destination = '/app/' + q;
  res.redirect(302, '/app/login?next=' + encodeURIComponent(destination));
});

// Dedicated mobile administrator login. An active admin session proceeds to the
// requested PWA URL; otherwise the compact mobile login document is served.
app.get('/app/login', adminGuard, (req, res) => {
  const destination = safePwaNext(req.query.next);
  if (getSession(req)) return res.redirect(302, destination);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'pwa', 'login.html'));
});

function normalizedOrigin(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return '';
    return u.origin;
  } catch (_) {
    return '';
  }
}

// Browser mutations under /app must originate from the exact Direct-Xfer
// origin. SameSite cookies alone are insufficient because sibling subdomains
// are "same-site" while still being different, potentially hostile origins.
function validAppMutationOrigin(req) {
  const supplied = normalizedOrigin(req.headers.origin);
  if (!supplied || supplied === 'null') return false;
  const allowed = new Set();
  const host = String(req.get('host') || '').trim();
  if (/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    const requestOrigin = normalizedOrigin(`${externalProto(req)}://${host}`);
    if (requestOrigin) allowed.add(requestOrigin);
  }
  const publicOrigin = normalizedOrigin(PUBLIC_URL);
  if (publicOrigin) allowed.add(publicOrigin);
  return allowed.has(supplied);
}

function requireAppAuth(req, res, next) {
  if (isPublicPwaAssetRequest(req)) return next();
  const session = getSession(req);
  let device = getPwaDevice(req);
  if (!device && session) {
    const lockedDevice = getPwaDevice(req, false, true);
    if (lockedDevice && lockedDevice.sessionLockedAt) {
      delete lockedDevice.sessionLockedAt;
      lockedDevice.lastUsedAt = Date.now();
      scheduleFlush();
      device = lockedDevice;
    }
  }
  if (session || device) {
    req.pwaSession = session;
    req.pwaDevice = device;
    req.pwaAuthMode = device ? 'cookie' : 'session';
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating) {
      // Browser cookie/session requests must be exact same-origin.
      if (!validAppMutationOrigin(req)) return res.status(403).json({ error: 'invalid-origin' });
      const csrf = String(req.headers['x-csrf-token'] || '');
      const deviceCsrfOk = !!(device && csrf && timingSafeEqualStr(csrf, device.csrf));
      const sessionCsrfOk = !!(session && csrf && timingSafeEqualStr(csrf, session.csrf));
      if (!deviceCsrfOk && !sessionCsrfOk) return res.status(403).json({ error: 'invalid-csrf' });

      // A paired device keeps its deliberately narrow PWA capability. Requests
      // authenticated through the admin session retain the normal role and
      // forced-password-change invariants.
      if (!deviceCsrfOk) {
        const acc = session && session.accountId ? getAccountById(session.accountId) : null;
        if (!session || !['owner', 'admin', 'operator'].includes(session.role)) {
          return res.status(403).type('text').send('Forbidden');
        }
        if (accountNeedsPwChange(acc)) return res.status(403).json({ error: 'password-change-required' });
      }
    }
    return next();
  }
  const accept = req.headers.accept || '';
  if (req.method === 'GET' && accept.includes('text/html')) {
    // Preserve the complete query string: Web Share Target batches use ?shared=<id>
    // and remain recoverable after the administrator signs in on mobile.
    return res.redirect(302, '/app/login?next=' + encodeURIComponent(safePwaNext(req.originalUrl)));
  }
  return res.status(401).type('text').send('Authentication required');
}
// JSON body parser for the /app login route — small, since it only carries
// credentials, never file data.
const appLoginParser = express.json({ limit: '8kb' });

// Dedicated browser-PWA login. Besides creating the administrator session, bind
// the browser to a durable PWA device capability. A normal /api/login could leave
// the installed app in session-only mode; when Android later discarded that cookie,
// device-owned images and albums appeared to reset even though the files remained.
app.post('/app/login', adminGuard, appLoginParser, (req, res) => {
  const body = req.body || {};
  const result = attemptLogin(req, res, body.username || '', body.password || '', body.totp || '');
  if (!result.ok) {
    if (result.locked) return res.status(429).json({ error: 'too-many-attempts', retryAfter: result.retryAfter });
    if (result.totpRequired) return res.status(401).json({ error: 'totp-required' });
    if (result.totpInvalid) return res.status(401).json({ error: 'invalid-totp' });
    return res.status(401).json({ error: 'invalid-password', hints: loginHints() });
  }
  const acc = result.account;
  if (!acc || !['owner', 'admin', 'operator'].includes(acc.role)) {
    if (result.sid) sessions.delete(result.sid);
    destroySession(req, res);
    return res.status(403).json({ error: 'role-forbidden' });
  }

  let device = getPwaDevice(req, false, true);
  const existingDeviceOwner = device ? (pwaDeviceCreatorAccount(device) || pwaDeviceOwnerAccount(device.id)) : null;
  // A browser may retain a dxpwa cookie while a different account signs in. Never
  // transfer that capability between accounts: issue a separate device identity so
  // one operator cannot inherit another account's workspace on a shared phone.
  if (device && existingDeviceOwner && existingDeviceOwner.id !== acc.id) device = null;
  if (device) {
    delete device.sessionLockedAt;
    device.lastUsedAt = Date.now();
    device.createdBy = acc.username || device.createdBy || null;
    device.createdByAccountId = acc.id;
    // Do NOT overwrite the name of an already-paired device on re-login: the login page
    // always sends a default deviceName, which used to clobber a custom rename on every
    // sign-in. The name is only set when the device is first issued, or via explicit rename.
    rememberPwaDeviceOwner(device);
    scheduleFlush();
  } else {
    const label = String(body.deviceName || requestClientDeviceName(req, 'pwa') || 'Direct-Xfer PWA')
      .replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Direct-Xfer PWA';
    device = issuePwaDevice(req, res, label, acc.username || null);
  }
  const migrated = migratePwaRecordsForAccount(acc);
  req.session = { sid: result.sid, csrf: result.csrf, accountId: acc.id, username: acc.username, role: acc.role };
  auditReq(req, 'pwa-login-bound', `${device.name}; migrated=${migrated}`);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    csrf: result.csrf,
    mustChangePassword: accountNeedsPwChange(acc),
    username: acc.username,
    role: acc.role,
    paired: true,
    device: publicPwaDevice(device, device.id),
  });
});

app.use('/app', pwaNetworkGuard, requireAppAuth);

const pwaJsonParser = express.json({ limit: '8kb' });

// Ends the browser session without deleting local IndexedDB data, public links or
// the paired-device record. The device capability is locked server-side and is
// automatically unlocked only after a fresh administrator login reaches /app.
app.post('/app/session/logout', pwaJsonParser, (req, res) => {
  const session = req.pwaSession || getSession(req);
  const device = req.pwaDevice || getPwaDevice(req, false, true);
  const keys = [];
  if (device) {
    device.sessionLockedAt = Date.now();
    keys.push('dev:' + device.id);
  }
  if (session && session.accountId) keys.push('acc:' + session.accountId);
  for (const key of keys) {
    const streams = inboxEventSubs.get(key);
    if (streams) {
      for (const stream of streams) { try { stream.end(); } catch (_) {} }
      inboxEventSubs.delete(key);
    }
  }
  if (session) {
    req.session = session;
    auditReq(req, 'logout', device ? 'PWA session locked: ' + device.name : 'PWA session');
  } else if (device) {
    logAudit('logout', { username: 'PWA: ' + device.name, ip: clientIp(req), detail: 'PWA session locked' });
  }
  destroySession(req, res);
  persistNow();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, paired: !!device });
});

// QR code (SVG) for a reception link, generated locally (no third-party service).
// Gated by the same /app auth (paired device or admin session) as the rest of the
// PWA API. Mirrors the admin /qr route: the `qrcode` package renders `data` purely
// as QR modules (<path>/<rect> geometry) and never echoes it back as text, so there
// is no injection surface — nosniff is set as defense in depth.
app.get('/app/qr', async (req, res) => {
  const data = String(req.query.data || '');
  if (!data || data.length > 1024) return res.status(400).json({ error: 'invalid-data' });
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1 });
    res.type('image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    res.send(svg);
  } catch (e) {
    res.status(500).json({ error: 'qr-failed' });
  }
});

// ===================================================================
//  PWA live inbox events — Server-Sent Events (SSE) + owner-scoped push
// ===================================================================
// A device/account that created reception links can watch its inboxes live and,
// optionally, get a browser push when a file lands (even with the app closed).
// The upload itself is anonymous (/u/), so the finalize step looks up the share's
// recorded owner and fans an event out to that owner's live streams + push subs.
const inboxEventSubs = new Map(); // ownerKey -> Set<res>
function pwaOwnerKeys(req) {
  const k = [];
  if (req.pwaDevice && req.pwaDevice.id) k.push('dev:' + req.pwaDevice.id);
  if (req.pwaSession && req.pwaSession.accountId) k.push('acc:' + req.pwaSession.accountId);
  return k;
}
function ownerKeysForShare(s) {
  const k = [];
  if (s && s.ownerDeviceId) k.push('dev:' + s.ownerDeviceId);
  if (s && s.ownerId) k.push('acc:' + s.ownerId);
  return k;
}
function notifyFirstPhotoView(s, req, kind, ip, geo) {
  if (!s || s.type !== 'photo') return;
  const variant = kind === 'thumb' ? 'Mini' : kind === 'micro' ? 'Micro' : 'Full';
  const where = geo && geo.country ? ' · ' + geo.country : '';
  const body = `"${s.name || 'Image'}" · ${variant}${ip ? ' · ' + ip : ''}${where}`;
  const title = `${APP_NAME} — First image view`;
  const payload = { name: s.name || '', token: s.token, variant: kind, ip: ip || null, country: geo && geo.country || null, url: '/app/#images' };
  const wh = effectiveWebhook();
  if (wh.url) sendWebhook(wh.url, wh.format, `👁 ${title}: ${body}`, 'image-first-view', payload);
  if (emailConfigured()) sendMail(title, `👁 ${title}: ${body}`);
  const evt = { type: 'image-first-view', title, body, name: s.name || '', token: s.token, variant: kind, at: Date.now() };
  emitPwaOwnerEvent(s, evt, true);
  logAudit('image-first-view', { username: 'system', ip: clientIp(req), detail: `${s.name || s.token} · ${variant}` });
}
function sendPwaPush(keys, evt) {
  if (!webpush || !keys.length) return;
  const activeKeys = keys.filter((key) => {
    if (!key.startsWith('dev:')) return true;
    const device = pwaDevices().find((d) => d.id === key.slice(4));
    return !!(device && !device.sessionLockedAt);
  });
  if (!activeKeys.length) return;
  const subs = pushSubs().filter((x) => Array.isArray(x.ownerKeys) && x.ownerKeys.some((k) => activeKeys.includes(k)));
  if (subs.length) sendWebPush(evt.kind || 'pwa', evt.title || APP_NAME, evt.body || '', { url: evt.url || '/app/', token: evt.token || null }, subs);
}
function emitPwaOwnerEvent(s, evt, push) {
  const keys = ownerKeysForShare(s);
  if (!keys.length) return;
  const frame = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const k of keys) {
    const set = inboxEventSubs.get(k);
    if (set) for (const res of set) { try { res.write(frame); } catch (_) {} }
  }
  if (push) {
    try { sendPwaPush(keys, { kind: evt.type || 'pwa', title: evt.title || APP_NAME, body: evt.body || '', url: '/app/#images', token: evt.token || null }); } catch (_) {}
  }
}
// Called from the (anonymous) upload finalize when a file lands on an inbox.
function emitInboxEvent(s, evt) {
  emitPwaOwnerEvent(s, evt, false);
  const keys = ownerKeysForShare(s);
  try { sendPwaPush(keys, { kind: 'inbox', title: APP_NAME, body: (evt.name ? evt.name + ' — ' : '') + (evt.dest || ''), url: '/app/' }); } catch (_) {}
}

// Live event stream for the signed-in device/account (cookie-authenticated).
app.get('/app/events', (req, res) => {
  const keys = pwaOwnerKeys(req);
  if (!keys.length) return res.status(403).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // keep proxies (nginx) from buffering the stream
  });
  res.write('retry: 5000\n\n');
  res.write(': connected\n\n');
  for (const k of keys) { if (!inboxEventSubs.has(k)) inboxEventSubs.set(k, new Set()); inboxEventSubs.get(k).add(res); }
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    for (const k of keys) { const set = inboxEventSubs.get(k); if (set) { set.delete(res); if (!set.size) inboxEventSubs.delete(k); } }
  });
});

// Public VAPID key so the PWA can create a push subscription.
app.get('/app/push/vapid', (req, res) => {
  if (!webpush) return res.status(400).json({ error: 'no-module' });
  const keys = getVapidKeys();
  res.json({ publicKey: keys ? keys.publicKey : '' });
});
// Store an owner-scoped push subscription for this device/account.
app.post('/app/push/subscribe', pwaJsonParser, (req, res) => {
  if (!webpush) return res.status(400).json({ error: 'no-module' });
  const keys = pwaOwnerKeys(req);
  if (!keys.length) return res.status(403).json({ error: 'forbidden' });
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid-subscription' });
  }
  const subs = pushSubs();
  const rec = {
    endpoint: sub.endpoint.slice(0, 2000),
    keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) },
    ownerKeys: keys, pwa: true,
    accountId: (req.pwaSession && req.pwaSession.accountId) || null,
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
    createdAt: Date.now(),
  };
  const i = subs.findIndex((x) => x.endpoint === rec.endpoint);
  if (i !== -1) subs[i] = { ...subs[i], ...rec }; else subs.push(rec);
  if (subs.length > 300) subs.splice(0, subs.length - 300);
  persist();
  res.json({ ok: true });
});
app.post('/app/push/unsubscribe', pwaJsonParser, (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '').trim();
  if (!endpoint) return res.status(400).json({ error: 'missing-endpoint' });
  const removed = dropPushSub(endpoint);
  if (removed) persist();
  res.json({ ok: true, removed });
});

// Create a reception link from the PWA. Reachable by a paired device OR an admin
// session (the /app gate already enforced auth, origin and CSRF). Only a JSON
// object with a NAME is accepted — quotas, geo/IP rules, moderation, encryption,
// passwords stay admin-panel-only. The new link shows up in the admin like any
// other, and is returned so the app can select it.
app.post('/app/inbox', pwaJsonParser, (req, res) => {
  if (!req.is('application/json') || !req.body || Array.isArray(req.body) || typeof req.body !== 'object') {
    return res.status(415).json({ error: 'json-required' });
  }
  const name = String((req.body && req.body.name) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) || 'Réception';
  const dirBase = name.replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/^\.+/, '').trim().slice(0, 50) || 'reception';
  const inbox = {
    type: 'inbox',
    name,
    relDir: dirBase + '-' + crypto.randomBytes(3).toString('hex'), // unique folder (no collisions)
    startsAt: null,
    expiresAt: null,
    maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0,
    allowExt: [], blockExt: [],
    groupBySender: false,
    moderated: false,
    bytesReceived: 0,
  };
  const banner = String(getSettings().receptionBanner || '').slice(0, 2000);
  if (banner) inbox.note = banner;
  // Ownership: an admin session stamps its account; a device records its own name.
  stampPwaRecordOwner(req, inbox);
  try { fs.mkdirSync(resolveWithin(INBOX_DIR, inbox.relDir), { recursive: true }); } catch (_) {}
  const rec = addShare(inbox);
  const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
  logAudit('inbox-created', { username: who, ip: clientIp(req), detail: 'via PWA — ' + name });
  const dec = decorateShare(rec, req);
  res.status(201).json({ token: rec.token, name: rec.name, url: dec.url || (primaryBase(req) + '/u/' + rec.token) });
});

// Create an image link from the PWA. The request body is the raw image bytes (a
// phone photo isn't on the read-only host FS), stored under Images/Full; a photo
// share is created so /i/<token> serves it directly. The thumbnail is uploaded
// separately (generated on the device). URLs use the Images domain when set.
const PWA_IMG_EXT = /^(jpg|png|gif|webp|bmp|avif)$/;
function pwaDeviceCreatorAccount(device) {
  if (!device) return null;
  return (device.createdByAccountId && getAccountById(device.createdByAccountId)) || findAccountByName(device.createdBy || '');
}
function stampPwaRecordOwner(req, share) {
  if (!share) return share;
  if (req.pwaSession) {
    share.ownerId = req.pwaSession.accountId || null;
    share.ownerName = req.pwaSession.username || null;
  }
  if (req.pwaDevice) {
    share.ownerDeviceId = req.pwaDevice.id;
    const creator = pwaDeviceCreatorAccount(req.pwaDevice);
    // A device capability is delegated by an account. Persist both identities so
    // losing/replacing the HttpOnly device cookie never makes its records disappear.
    if (!share.ownerId && creator) share.ownerId = creator.id;
    if (!share.ownerName) share.ownerName = (creator && creator.username) || req.pwaDevice.name || 'PWA';
    rememberPwaDeviceOwner(req.pwaDevice);
  }
  return share;
}
function pwaImgOwner(req, share) { return stampPwaRecordOwner(req, share); }
function migratePwaRecordsForAccount(account) {
  if (!account || !account.id) return 0;
  let changed = 0;
  for (const share of state.shares || []) {
    if (!share || !share.ownerDeviceId || share.ownerId) continue;
    const owner = pwaDeviceOwnerAccount(share.ownerDeviceId);
    if (!owner || owner.id !== account.id) continue;
    share.ownerId = account.id;
    if (!share.ownerName || share.ownerName === 'PWA') share.ownerName = account.username || share.ownerName;
    changed += 1;
  }
  if (changed) scheduleFlush();
  return changed;
}
function pwaDeviceCanManageRecord(device, share) {
  if (!device || !share) return false;
  const creator = pwaDeviceCreatorAccount(device);
  if (share.ownerDeviceId && share.ownerDeviceId === device.id) {
    if (!share.ownerId && creator) {
      share.ownerId = creator.id;
      if (!share.ownerName || share.ownerName === 'PWA') share.ownerName = creator.username || share.ownerName;
      scheduleFlush();
    }
    return true;
  }

  // The account, not a disposable browser cookie, is the durable ownership root.
  // A replacement PWA credential issued to the same account therefore inherits
  // the records of its previous credential and self-heals their legacy ownerId.
  if (creator && share.ownerDeviceId) {
    const previousOwner = pwaDeviceOwnerAccount(share.ownerDeviceId);
    if (previousOwner && previousOwner.id === creator.id) {
      if (!share.ownerId) {
        share.ownerId = creator.id;
        if (!share.ownerName || share.ownerName === 'PWA') share.ownerName = creator.username || share.ownerName;
        scheduleFlush();
      }
      return true;
    }
  }
  if (creator && share.ownerId && share.ownerId === creator.id) return true;
  const creatorName = normUsername((creator && creator.username) || device.createdBy || '');
  if (creatorName && share.ownerName && normUsername(share.ownerName) === creatorName) return true;

  // Very old photo records predate both ownerId and ownerDeviceId. They were
  // globally manageable before account scoping existed; preserve that behavior
  // only for devices paired by an owner/admin, never for an operator device.
  if (!share.ownerId && !share.ownerDeviceId && creator && (creator.role === 'owner' || creator.role === 'admin')) return true;
  return false;
}
// True when the PWA caller acts with administrator authority — either a logged-in
// owner/admin session, or a device that was paired by an owner/admin account (that
// device is the administrator's own device). Used so the PWA mirrors the web admin
// and lists EVERY link, not only those created from the PWA.
function pwaViewerIsAdmin(req) {
  const session = req.pwaSession;
  if (session && (session.role === 'owner' || session.role === 'admin')) return true;
  const creator = req.pwaDevice ? pwaDeviceCreatorAccount(req.pwaDevice) : null;
  return !!(creator && (creator.role === 'owner' || creator.role === 'admin'));
}
function canManagePwaImage(req, share) {
  const session = req.pwaSession;
  if (session && (session.role === 'owner' || session.role === 'admin')) return true;
  if (session && session.role === 'operator' && share.ownerId === session.accountId) return true;
  if (pwaDeviceCanManageRecord(req.pwaDevice, share)) return true;
  // A device paired by an owner/admin account manages every link like the web admin
  // (reception, share and image links), including ones created on the standard version.
  const creator = req.pwaDevice ? pwaDeviceCreatorAccount(req.pwaDevice) : null;
  return !!(creator && (creator.role === 'owner' || creator.role === 'admin'));
}
function pwaImageCreatePayload(req, rec) {
  return pwaPhotoPayload(req, rec);
}
function pwaPhotoPayload(req, share) {
  const ib = getSettings().imageBase || primaryBase(req) || '';
  const stats = photoStatsOf(share);
  let changed = false;
  const readDims = (wKey, hKey, paths) => {
    let w = Math.max(0, Number(share[wKey]) || 0);
    let h = Math.max(0, Number(share[hKey]) || 0);
    if (!w || !h) {
      const file = firstExistingPhotoFile(paths);
      const dims = file ? imageDimensions(file) : null;
      if (dims && dims.w > 0 && dims.h > 0) {
        w = dims.w; h = dims.h; share[wKey] = w; share[hKey] = h; changed = true;
      }
    }
    return { w: w || null, h: h || null };
  };
  const fullPaths = photoOriginalPaths(share);
  const thumbPaths = photoVariantPaths(share.token, 'thumb');
  const microPaths = photoVariantPaths(share.token, 'micro');
  const full = readDims('w', 'h', fullPaths);
  const thumb = readDims('thumbW', 'thumbH', thumbPaths);
  const micro = readDims('microW', 'microH', microPaths);
  const readBytes = (sizeKey, paths) => {
    let bytes = Math.max(0, Number(share[sizeKey]) || 0);
    if (!bytes) {
      const file = firstExistingPhotoFile(paths);
      try {
        if (file) bytes = Math.max(0, fs.statSync(file).size || 0);
      } catch (_) {}
      if (bytes) { share[sizeKey] = bytes; changed = true; }
    }
    return bytes || null;
  };
  const fullBytes = readBytes('size', fullPaths);
  const thumbBytes = readBytes('thumbSize', thumbPaths);
  const microBytes = readBytes('microSize', microPaths);
  const uniqueVisitors = new Set();
  for (const variant of [stats.full, stats.thumb, stats.micro]) {
    if (variant && Array.isArray(variant.u)) for (const ip of variant.u) uniqueVisitors.add(ip);
  }
  const totalViews = (stats.full.v || 0) + (stats.thumb.v || 0) + (stats.micro.v || 0);
  if (changed) scheduleFlush();
  const now = Date.now();
  const active = isActive(share, now);
  const expired = !!share.expiresAt && now > share.expiresAt;
  return {
    token: share.token,
    name: share.name,
    createdAt: share.createdAt || 0,
    expiresAt: share.expiresAt || null,
    active,
    expired,
    disabled: !!share.disabled,
    status: active ? 'active' : expired ? 'expired' : share.disabled ? 'disabled' : 'inactive',
    imgUrl: ib + '/i/' + share.token + '.' + photoExt(share),
    thumbUrl: ib + '/i/' + share.token + '/thumb',
    microUrl: ib + '/i/' + share.token + '/micro',
    favorite: !!share.favorite,
    tags: Array.isArray(share.tags) ? share.tags.slice(0, 20) : [],
    note: share.adminNote || '',
    clientHash: share.clientHash || null,
    maxViews: Math.max(0, Number(share.maxViews) || 0),
    hasPassword: !!share.pwHash,
    hotlinkHosts: Object.prototype.hasOwnProperty.call(share, 'hotlinkHosts') && Array.isArray(share.hotlinkHosts) ? share.hotlinkHosts.slice(0, 50) : null,
    notifyFirstView: !!share.notifyFirstView,
    firstViewNotifiedAt: share.firstViewNotifiedAt || null,
    retentionReason: share.retentionReason || null,
    metadataRemoved: !!share.metadataRemoved,
    autoUrl: ib + '/i/' + share.token + '/auto',
    previewUrls: {
      auto: '/app/image/' + encodeURIComponent(share.token) + '/preview/auto',
      full: '/app/image/' + encodeURIComponent(share.token) + '/preview/full',
      thumb: '/app/image/' + encodeURIComponent(share.token) + '/preview/thumb',
      micro: '/app/image/' + encodeURIComponent(share.token) + '/preview/micro',
    },
    adaptive: { webp: !!share.adaptiveWebp, avif: !!share.adaptiveAvif },
    versionCount: Array.isArray(share.versions) ? share.versions.length : 0,
    totals: { views: totalViews, visitors: uniqueVisitors.size, bytes: (fullBytes || 0) + (thumbBytes || 0) + (microBytes || 0) },
    variants: {
      full: { ...full, bytes: fullBytes, ready: true, views: stats.full.v || 0, visitors: Array.isArray(stats.full.u) ? stats.full.u.length : 0 },
      thumb: { ...thumb, bytes: thumbBytes, ready: !!share.thumb, views: stats.thumb.v || 0, visitors: Array.isArray(stats.thumb.u) ? stats.thumb.u.length : 0 },
      micro: { ...micro, bytes: microBytes, ready: !!share.micro, views: stats.micro.v || 0, visitors: Array.isArray(stats.micro.u) ? stats.micro.u.length : 0 },
    },
  };
}


// Authenticated owner preview for PWA image cards. Public /i/ URLs intentionally
// count views and visitors; management previews must never alter those counters,
// even when Images uses another hostname and the admin session cookie is absent
// from that public request.
app.get('/app/image/:token/preview/:variant', async (req, res) => {
  const share = pwaPhotoByToken(req, req.params.token);
  if (!share || !isActive(share)) return sendError(req, res, 404, 'fileNotFound');

  const requested = String(req.params.variant || '').toLowerCase();
  if (!['auto', 'full', 'thumb', 'micro'].includes(requested)) {
    return sendError(req, res, 400, 'fileNotFound');
  }

  let variant = requested;
  let adaptiveFile = null;
  let adaptiveType = null;
  if (requested === 'auto') {
    const width = Math.max(0, Math.min(10000,
      parseInt(req.query.w, 10) || parseInt(req.headers.width, 10) ||
      parseInt(req.headers['viewport-width'], 10) || 0));
    const saveData = String(req.headers['save-data'] || '').toLowerCase() === 'on';
    const ect = String(req.headers.ect || '').toLowerCase();
    const slow = saveData || /(^|-)2g$/.test(ect) || ect === 'slow-2g';
    if (slow || (width && width <= 320)) variant = 'micro';
    else if (width && width <= 900) variant = 'thumb';
    else {
      const accept = String(req.headers.accept || '');
      const format = /image\/avif/i.test(accept) && share.adaptiveAvif ? 'avif'
        : /image\/webp/i.test(accept) && share.adaptiveWebp ? 'webp'
          : null;
      if (format) {
        const file = photoAdaptivePath(share.token, format);
        try {
          if (file && (await fs.promises.stat(file)).isFile()) {
            adaptiveFile = file;
            adaptiveType = 'image/' + format;
          }
        } catch (_) {}
      }
      variant = 'full';
    }
  }

  if (adaptiveFile) {
    return streamFile(req, res, adaptiveFile, share.token + path.extname(adaptiveFile), null, null, {
      inline: true,
      contentType: adaptiveType,
      cacheControl: 'no-store',
    });
  }

  const candidates = variant === 'micro'
    ? [
        ...photoVariantPaths(share.token, 'micro').map((file) => ({ ready: share.micro, file })),
        ...photoVariantPaths(share.token, 'thumb').map((file) => ({ ready: share.thumb, file })),
      ]
    : variant === 'thumb'
      ? photoVariantPaths(share.token, 'thumb').map((file) => ({ ready: share.thumb, file }))
      : [];
  for (const candidate of candidates) {
    if (!candidate.ready) continue;
    try {
      if ((await fs.promises.stat(candidate.file)).isFile()) {
        return streamFile(req, res, candidate.file, share.token + '.jpg', null, null, {
          inline: true,
          contentType: 'image/jpeg',
          cacheControl: 'no-store',
        });
      }
    } catch (_) {}
  }

  try {
    let original = firstExistingPhotoFile(photoOriginalPaths(share));
    if (!original) {
      original = hostToContainer(share.hostPath);
      await assertRealWithin(HOST_ROOT, original);
    }
    return streamFile(req, res, original, share.name, null, null, {
      inline: true,
      contentType: imageContentType(share.imgPath || share.name) || 'application/octet-stream',
      cacheControl: 'no-store',
    });
  } catch (e) {
    return sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
  }
});

function pwaImagesForRequest(req, { limit = 200, includeInactive = false } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
  return listShares()
    .filter((share) => share && share.type === 'photo' && canManagePwaImage(req, share) && (includeInactive || isActive(share)))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, boundedLimit)
    .map((share) => pwaPhotoPayload(req, share));
}

app.get('/app/images', (req, res) => {
  const images = pwaImagesForRequest(req, {
    limit: req.query.limit,
    includeInactive: String(req.query.includeInactive || '') === '1',
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ images });
});

app.get('/app/image/:token/stats', (req, res) => {
  const share = getByToken(req.params.token);
  if (!share || share.type !== 'photo' || !isActive(share) || !canManagePwaImage(req, share)) {
    return res.status(404).json({ error: 'not-found' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(pwaPhotoPayload(req, share));
});

function pwaPhotoByToken(req, token) {
  const share = getByToken(String(token || ''));
  return share && share.type === 'photo' && canManagePwaImage(req, share) ? share : null;
}
function applyPwaPhotoSettings(share, body) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const changed = [];
  if (body.name !== undefined) {
    const name = String(body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120);
    if (name && name !== share.name) { share.name = name; changed.push('name'); }
  }
  if (body.expiresInSeconds !== undefined) {
    share.expiresAt = parseExpiry(body.expiresInSeconds);
    delete share.expiryWarnedAt;
    changed.push('expiry');
  }
  if (body.maxViews !== undefined) {
    const n = Math.max(0, Math.min(1000000000, Math.floor(Number(body.maxViews) || 0)));
    if (n) share.maxViews = n; else delete share.maxViews;
    changed.push('maxViews');
  }
  if (typeof body.password === 'string') {
    if (body.password) Object.assign(share, makeSharePassword(body.password.slice(0, 256)));
    else { delete share.pwHash; delete share.pwSalt; }
    changed.push(body.password ? 'password-set' : 'password-cleared');
  }
  if (body.hotlinkHosts !== undefined) {
    share.hotlinkHosts = parseHotlinkHosts(body.hotlinkHosts); // explicit [] disables protection for this image
    changed.push(share.hotlinkHosts.length ? 'hotlink-protected' : 'hotlink-off');
  }
  if (typeof body.notifyFirstView === 'boolean') {
    const was = !!share.notifyFirstView;
    if (body.notifyFirstView) share.notifyFirstView = true; else delete share.notifyFirstView;
    if (body.notifyFirstView && !was) {
      delete share.firstViewNotifiedAt; delete share.firstViewKind; delete share.firstViewIp;
    }
    changed.push(body.notifyFirstView ? 'first-view-notify-on' : 'first-view-notify-off');
  }
  if (Array.isArray(body.tags) || typeof body.tags === 'string') {
    const tags = normalizeTags(body.tags);
    if (tags.length) share.tags = tags; else delete share.tags;
    changed.push('tags');
  }
  if (typeof body.note === 'string') {
    const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 1000);
    if (note) share.adminNote = note; else delete share.adminNote;
    changed.push('note');
  }
  if (typeof body.favorite === 'boolean') {
    if (body.favorite) share.favorite = true; else delete share.favorite;
    changed.push(body.favorite ? 'favorite' : 'unfavorite');
  }
  if (typeof body.disabled === 'boolean') {
    if (body.disabled) share.disabled = true; else delete share.disabled;
    changed.push(body.disabled ? 'disabled' : 'enabled');
  }
  return changed;
}

app.get('/app/image/duplicate', (req, res) => {
  const hash = String(req.query.hash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ error: 'invalid-hash' });
  const share = listShares().find((item) => item && item.type === 'photo' && item.clientHash === hash && canManagePwaImage(req, item));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ duplicate: !!share, image: share ? pwaPhotoPayload(req, share) : null });
});

app.post('/app/image/:token/settings', pwaJsonParser, (req, res) => {
  const share = pwaPhotoByToken(req, req.params.token);
  if (!share) return res.status(404).json({ error: 'not-found' });
  const changed = applyPwaPhotoSettings(share, req.body);
  if (changed.length) persistNow();
  const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
  logAudit('image-edited', { username: who, ip: clientIp(req), detail: share.name + ': ' + changed.join(', ') });
  res.json({ ok: true, image: pwaPhotoPayload(req, share) });
});

app.post('/app/images/bulk', pwaJsonParser, (req, res) => {
  const body = req.body || {};
  const tokens = [...new Set(Array.isArray(body.tokens) ? body.tokens.map(String) : [])].slice(0, 200);
  if (!tokens.length) return res.status(400).json({ error: 'empty' });
  const action = String(body.action || 'settings');
  let count = 0;
  for (const token of tokens) {
    const share = pwaPhotoByToken(req, token);
    if (!share) continue;
    if (action === 'revoke') {
      if (removeShare(share.id, false)) count += 1;
    } else {
      const changed = applyPwaPhotoSettings(share, body.settings || body);
      if (changed.length) count += 1;
    }
  }
  if (count) persistNow();
  res.json({ ok: true, count });
});

function canManagePwaAlbum(req, album) {
  if (!album || album.type !== 'album') return false;
  const session = req.pwaSession;
  if (session && (session.role === 'owner' || session.role === 'admin')) return true;
  if (session && session.role === 'operator' && album.ownerId === session.accountId) return true;
  return pwaDeviceCanManageRecord(req.pwaDevice, album);
}
function pwaAlbumPayload(req, album) {
  const base = getSettings().imageBase || primaryBase(req) || '';
  const members = (Array.isArray(album.members) ? album.members : []).map((token) => getByToken(token)).filter((s) => s && s.type === 'photo');
  return {
    token: album.token,
    name: album.name,
    createdAt: album.createdAt || 0,
    expiresAt: album.expiresAt || null,
    active: isActive(album),
    count: members.length,
    url: base + '/g/' + album.token,
    views: Number(album.views) || 0,
    hasPassword: !!album.pwHash,
    tags: Array.isArray(album.tags) ? album.tags.slice(0, 20) : [],
    note: album.adminNote || '',
    collaboration: {
      invitations: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && (!x.expiresAt || x.expiresAt > Date.now())).length : 0,
      readers: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && x.role === 'reader').length : 0,
      contributors: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && x.role === 'contributor').length : 0,
      managers: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && x.role === 'manager').length : 0,
    },
  };
}
app.get('/app/albums', (req, res) => {
  const albums = listShares().filter((s) => s && s.type === 'album' && canManagePwaAlbum(req, s))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((s) => pwaAlbumPayload(req, s));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ albums });
});
app.post('/app/albums', pwaJsonParser, (req, res) => {
  const body = req.body || {};
  const tokens = [...new Set(Array.isArray(body.tokens) ? body.tokens.map(String) : [])].slice(0, 500);
  const members = tokens.map((token) => pwaPhotoByToken(req, token)).filter(Boolean).map((s) => s.token);
  if (!members.length) return res.status(400).json({ error: 'no-images' });
  const name = String(body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120) || 'Album';
  const album = { type: 'album', name, members, expiresAt: parseExpiry(body.expiresInSeconds) };
  stampPwaRecordOwner(req, album);
  if (typeof body.password === 'string' && body.password) Object.assign(album, makeSharePassword(body.password.slice(0, 256)));
  const tags = normalizeTags(body.tags || []); if (tags.length) album.tags = tags;
  const note = String(body.note || '').trim().slice(0, 1000); if (note) album.adminNote = note;
  const rec = addShare(album);
  res.status(201).json({ album: pwaAlbumPayload(req, rec) });
});
app.post('/app/album/:token/settings', pwaJsonParser, (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
  const body = req.body || {};
  if (body.name !== undefined) {
    const name = String(body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120);
    if (name) album.name = name;
  }
  if (body.expiresInSeconds !== undefined) album.expiresAt = parseExpiry(body.expiresInSeconds);
  if (typeof body.password === 'string') {
    if (body.password) Object.assign(album, makeSharePassword(body.password.slice(0, 256)));
    else { delete album.pwHash; delete album.pwSalt; }
  }
  const tags = body.tags !== undefined ? normalizeTags(body.tags) : null;
  if (tags) { if (tags.length) album.tags = tags; else delete album.tags; }
  if (typeof body.note === 'string') { const note = body.note.trim().slice(0, 1000); if (note) album.adminNote = note; else delete album.adminNote; }
  persistNow();
  res.json({ ok: true, album: pwaAlbumPayload(req, album) });
});

function publicAlbumInvite(entry) {
  return { id: entry.id, label: entry.label || '', role: entry.role, createdAt: entry.createdAt, expiresAt: entry.expiresAt || null, maxFiles: entry.maxFiles || 0, maxFileBytes: entry.maxFileBytes || 0, usedFiles: entry.usedFiles || 0, disabled: !!entry.disabled };
}
app.get('/app/album/:token/invitations', (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ invitations: (album.collaborators || []).map(publicAlbumInvite) });
});
app.post('/app/album/:token/invitations', pwaJsonParser, (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
  const body = req.body || {};
  const role = ['reader', 'contributor', 'manager'].includes(String(body.role)) ? String(body.role) : 'contributor';
  const secret = crypto.randomBytes(32).toString('base64url');
  const entry = {
    id: crypto.randomBytes(8).toString('hex'), tokenHash: albumInviteHash(secret), role,
    label: String(body.label || role).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80), createdAt: Date.now(),
    expiresAt: parseExpiry(body.expiresInSeconds), maxFiles: Math.max(0, Math.min(10000, Math.floor(Number(body.maxFiles) || 0))),
    maxFileBytes: Math.max(0, Math.min(IMAGE_MAX_BYTES, Math.floor(Number(body.maxFileBytes) || 0))), usedFiles: 0,
  };
  if (!Array.isArray(album.collaborators)) album.collaborators = [];
  album.collaborators.push(entry); persistNow();
  const base = getSettings().imageBase || primaryBase(req) || '';
  res.status(201).json({ invitation: publicAlbumInvite(entry), url: base + '/g/' + album.token + '/c/' + secret });
});
app.post('/app/album/:token/invitations/:id/revoke', pwaJsonParser, (req, res) => {
  const album = getByToken(String(req.params.token || ''));
  if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
  const entry = (album.collaborators || []).find((x) => x && x.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'not-found' });
  entry.disabled = true; entry.revokedAt = Date.now(); persistNow(); res.json({ ok: true });
});

// Owner-scoped automatic image retention rules (PWA feature 24). Rules are
// disabled by default and are stored separately per administrator account/device.
function pwaRetentionRuleStore() {
  if (!state.meta || typeof state.meta !== 'object') state.meta = {};
  if (!state.meta.pwaImageRetentionRules || typeof state.meta.pwaImageRetentionRules !== 'object') state.meta.pwaImageRetentionRules = {};
  return state.meta.pwaImageRetentionRules;
}
function primaryPwaOwnerKey(req) {
  // Prefer the signed-in account. PWA-created images are account-owned (ownerId is
  // set — see stampPwaRecordOwner), so retention rules must use the same account
  // key or they would never match the photos.
  if (req.pwaSession && req.pwaSession.accountId) return 'acc:' + req.pwaSession.accountId;
  if (req.pwaDevice) {
    // A paired device's images are ALSO account-owned (ownerId = the account that
    // paired it). Resolve that same account key here so that in the common
    // device-only state (admin session expired, device still paired) retention
    // keeps matching the device's images instead of silently targeting an empty
    // 'dev:<id>' scope. Fall back to the device key only for an unlinked device.
    const creator = pwaDeviceCreatorAccount(req.pwaDevice);
    if (creator && creator.id) return 'acc:' + creator.id;
    if (req.pwaDevice.id) return 'dev:' + req.pwaDevice.id;
  }
  return null;
}
function ownerKeyForPhoto(photo) {
  if (photo && photo.ownerId) return 'acc:' + photo.ownerId;
  // Legacy photos may carry only a device id (ownerId not yet self-healed). Resolve
  // the device's owning account so they map to the same key as their retention
  // rules; keep the device key for a device with no owning account.
  if (photo && photo.ownerDeviceId) {
    const device = pwaDevices().find((d) => d.id === photo.ownerDeviceId);
    const creator = device && pwaDeviceCreatorAccount(device);
    if (creator && creator.id) return 'acc:' + creator.id;
    return 'dev:' + photo.ownerDeviceId;
  }
  return null;
}
function normalizePwaRetentionRules(input) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    enabled: !!b.enabled,
    maxAgeDays: Math.max(0, Math.min(3650, Number(b.maxAgeDays) || 0)),
    inactiveDays: Math.max(0, Math.min(3650, Number(b.inactiveDays) || 0)),
    maxViews: Math.max(0, Math.min(1000000000, Math.floor(Number(b.maxViews) || 0))),
    maxStorageMB: Math.max(0, Math.min(1048576, Number(b.maxStorageMB) || 0)),
  };
}
function photoLastPublicViewAt(photo) {
  const ps = photoStatsOf(photo);
  return Math.max(Number(ps.full.lastAt) || 0, Number(ps.thumb.lastAt) || 0, Number(ps.micro.lastAt) || 0, Number(photo.createdAt) || 0);
}
function photoManagedBytes(photo) {
  const paths = [...photoOriginalPaths(photo), ...photoVariantPaths(photo.token, 'thumb'), ...photoVariantPaths(photo.token, 'micro')];
  const seen = new Set(); let total = 0;
  for (const file of paths) {
    if (!file || seen.has(file)) continue; seen.add(file);
    try { const st = fs.statSync(file); if (st.isFile()) total += Math.max(0, Number(st.size) || 0); } catch (_) {}
  }
  return total;
}
function runPwaImageRetentionForOwner(ownerKey, rules, now = Date.now()) {
  rules = normalizePwaRetentionRules(rules);
  if (!ownerKey || !rules.enabled) return { checked: 0, revoked: 0, bytesFreed: 0, reasons: {} };
  const photos = listShares().filter((s) => s && s.type === 'photo' && !s.revoked && ownerKeyForPhoto(s) === ownerKey);
  const revoke = new Map();
  const totalViews = (photo) => { const ps = photoStatsOf(photo); return (Number(ps.full.v) || 0) + (Number(ps.thumb.v) || 0) + (Number(ps.micro.v) || 0); };
  const ageMs = rules.maxAgeDays * DAY_MS;
  const inactiveMs = rules.inactiveDays * DAY_MS;
  for (const photo of photos) {
    if (ageMs && now - (Number(photo.createdAt) || now) >= ageMs) revoke.set(photo.id, 'age');
    else if (inactiveMs && now - photoLastPublicViewAt(photo) >= inactiveMs) revoke.set(photo.id, 'inactive');
    else if (rules.maxViews && totalViews(photo) >= rules.maxViews) revoke.set(photo.id, 'views');
  }
  if (rules.maxStorageMB > 0) {
    const cap = rules.maxStorageMB * 1024 * 1024;
    const live = photos.filter((p) => !revoke.has(p.id)).map((p) => ({ photo: p, bytes: photoManagedBytes(p), lastAt: photoLastPublicViewAt(p) }));
    let used = live.reduce((n, x) => n + x.bytes, 0);
    live.sort((a, b) => a.lastAt - b.lastAt || (a.photo.createdAt || 0) - (b.photo.createdAt || 0));
    for (const item of live) {
      if (used <= cap) break;
      revoke.set(item.photo.id, 'storage'); used -= item.bytes;
    }
  }
  let revoked = 0, bytesFreed = 0; const reasons = {};
  for (const photo of photos) {
    const reason = revoke.get(photo.id); if (!reason) continue;
    const bytes = photoManagedBytes(photo);
    photo.retentionReason = reason; photo.retentionRevokedAt = now;
    if (removeShare(photo.id, false)) {
      revoked += 1; bytesFreed += bytes; reasons[reason] = (reasons[reason] || 0) + 1;
      logAudit('image-retention-revoked', { username: 'system', detail: `${photo.name || photo.token} · ${reason}` });
    }
  }
  if (revoked) persistNow();
  return { checked: photos.length, revoked, bytesFreed, reasons };
}
function runAllPwaImageRetention() {
  const store = pwaRetentionRuleStore();
  for (const [ownerKey, rules] of Object.entries(store)) {
    try { runPwaImageRetentionForOwner(ownerKey, rules); } catch (e) { console.error('[pwa-image-retention]', ownerKey, e.message); }
  }
}
app.get('/app/images/retention', (req, res) => {
  const key = primaryPwaOwnerKey(req); if (!key) return res.status(403).json({ error: 'owner-required' });
  const rules = normalizePwaRetentionRules(pwaRetentionRuleStore()[key]);
  const owned = listShares().filter((s) => s && s.type === 'photo' && ownerKeyForPhoto(s) === key);
  const bytes = owned.reduce((n, p) => n + photoManagedBytes(p), 0);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ rules, summary: { images: owned.length, bytes } });
});
app.post('/app/images/retention', pwaJsonParser, (req, res) => {
  const key = primaryPwaOwnerKey(req); if (!key) return res.status(403).json({ error: 'owner-required' });
  const rules = normalizePwaRetentionRules(req.body || {});
  pwaRetentionRuleStore()[key] = rules; persistNow();
  const result = req.body && req.body.runNow ? runPwaImageRetentionForOwner(key, rules) : { checked: 0, revoked: 0, bytesFreed: 0, reasons: {} };
  res.json({ ok: true, rules, result });
});
setInterval(runAllPwaImageRetention, 5 * 60 * 1000).unref();
setTimeout(runAllPwaImageRetention, 30 * 1000).unref?.();

app.get('/app/images/dashboard', (req, res) => {
  const now = Date.now();
  const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days + 1);
  const series = Array.from({ length: days }, (_, i) => ({ at: start.getTime() + i * 86400000, created: 0, views: 0 }));
  const photos = listShares().filter((s) => s && s.type === 'photo' && canManagePwaImage(req, s));
  let totalViews = 0, totalVisitors = 0, totalBytes = 0;
  for (const photo of photos) {
    const ps = photoStatsOf(photo);
    const views = (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0);
    totalViews += views;
    const visitors = new Set();
    for (const st of [ps.full, ps.thumb, ps.micro]) if (Array.isArray(st.u)) for (const ip of st.u) visitors.add(ip);
    totalVisitors += visitors.size;
    totalBytes += Math.max(0, Number(photo.size) || 0) + Math.max(0, Number(photo.thumbSize) || 0) + Math.max(0, Number(photo.microSize) || 0);
    const cidx = Math.floor(((photo.createdAt || 0) - start.getTime()) / 86400000);
    if (cidx >= 0 && cidx < series.length) series[cidx].created += 1;
    for (const ev of Array.isArray(ps.recent) ? ps.recent : []) {
      const idx = Math.floor(((ev.at || 0) - start.getTime()) / 86400000);
      if (idx >= 0 && idx < series.length) series[idx].views += 1;
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ totals: { images: photos.length, views: totalViews, visitors: totalVisitors, bytes: totalBytes }, series, generatedAt: now });
});

function streamToFileBounded(req, res, dest, maxBytes, onDone) {
  const ws = fs.createWriteStream(dest);
  let size = 0, failed = false;
  const fail = (code) => {
    if (failed) return; failed = true;
    try { req.unpipe(ws); ws.destroy(); if (!req.destroyed) req.resume(); } catch (_) {}
    fs.unlink(dest, () => {});
    if (!res.headersSent) res.status(code || 500).json({ error: code === 413 ? 'too-large' : 'write-error' });
  };
  req.on('data', (c) => { size += c.length; if (size > maxBytes) fail(413); });
  req.on('aborted', () => fail(400));
  req.on('error', () => fail(400));
  ws.on('error', () => fail(500));
  ws.on('finish', () => {
    if (failed) return;
    if (size === 0) { fs.unlink(dest, () => {}); if (!res.headersSent) res.status(400).json({ error: 'empty' }); return; }
    onDone(size);
  });
  req.pipe(ws);
}
function archiveCurrentPhotoVersion(photo) {
  const source = firstExistingPhotoFile(photoOriginalPaths(photo));
  if (!source) return null;
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const dir = path.join(photoVersionDir(photo.token), id); fs.mkdirSync(dir, { recursive: true });
  const ext = photoExt(photo);
  fs.copyFileSync(source, path.join(dir, 'full.' + ext));
  const thumb = firstExistingPhotoFile(photoVariantPaths(photo.token, 'thumb')); if (thumb) fs.copyFileSync(thumb, path.join(dir, 'thumb.jpg'));
  const micro = firstExistingPhotoFile(photoVariantPaths(photo.token, 'micro')); if (micro) fs.copyFileSync(micro, path.join(dir, 'micro.jpg'));
  for (const fmt of ['webp', 'avif']) { const src = photoAdaptivePath(photo.token, fmt); try { if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, 'adaptive.' + fmt)); } catch (_) {} }
  const version = { id, at: Date.now(), name: photo.name, ext, size: photo.size || 0, w: photo.w || null, h: photo.h || null, metadataRemoved: !!photo.metadataRemoved, thumb: !!photo.thumb, thumbSize: photo.thumbSize || 0, thumbW: photo.thumbW || null, thumbH: photo.thumbH || null, micro: !!photo.micro, microSize: photo.microSize || 0, microW: photo.microW || null, microH: photo.microH || null, adaptiveWebp: !!photo.adaptiveWebp, adaptiveAvif: !!photo.adaptiveAvif };
  if (!Array.isArray(photo.versions)) photo.versions = [];
  photo.versions.unshift(version);
  while (photo.versions.length > 10) { const old = photo.versions.pop(); fs.rm(path.join(photoVersionDir(photo.token), old.id), { recursive: true, force: true }, () => {}); }
  return version;
}
function restorePhotoVersion(photo, version) {
  const dir = path.join(photoVersionDir(photo.token), version.id);
  const full = firstExistingPhotoFile([path.join(dir, 'full.' + version.ext)]); if (!full) return false;
  archiveCurrentPhotoVersion(photo);
  const newName = crypto.randomBytes(12).toString('hex') + '.' + version.ext;
  fs.copyFileSync(full, path.join(FULL_IMAGES_DIR, newName));
  unlinkPhotoFiles(photoOriginalPaths(photo)); photo.imgPath = newName; photo.ext = version.ext; photo.name = version.name; photo.size = version.size; photo.w = version.w; photo.h = version.h;
  if (version.metadataRemoved) photo.metadataRemoved = true; else delete photo.metadataRemoved;
  const thumb = path.join(dir, 'thumb.jpg'); try { fs.copyFileSync(thumb, path.join(THUMBS_DIR, photo.token + '.jpg')); photo.thumb = true; photo.thumbSize = version.thumbSize; photo.thumbW = version.thumbW; photo.thumbH = version.thumbH; } catch (_) { delete photo.thumb; }
  const micro = path.join(dir, 'micro.jpg'); try { fs.copyFileSync(micro, path.join(MICROS_DIR, photo.token + '.jpg')); photo.micro = true; photo.microSize = version.microSize; photo.microW = version.microW; photo.microH = version.microH; } catch (_) { delete photo.micro; }
  for (const fmt of ['webp', 'avif']) { const src = path.join(dir, 'adaptive.' + fmt), dest = photoAdaptivePath(photo.token, fmt); try { fs.copyFileSync(src, dest); photo[fmt === 'webp' ? 'adaptiveWebp' : 'adaptiveAvif'] = true; } catch (_) { delete photo[fmt === 'webp' ? 'adaptiveWebp' : 'adaptiveAvif']; try { fs.unlinkSync(dest); } catch (_) {} } }
  return true;
}
app.get('/app/image/:token/versions', (req, res) => {
  const photo = pwaPhotoByToken(req, req.params.token); if (!photo) return res.status(404).json({ error: 'not-found' });
  res.setHeader('Cache-Control', 'no-store'); res.json({ versions: (photo.versions || []).map((v) => ({ id: v.id, at: v.at, name: v.name, size: v.size, w: v.w, h: v.h, metadataRemoved: !!v.metadataRemoved })) });
});
app.post('/app/image/:token/restore/:versionId', pwaJsonParser, (req, res) => {
  const photo = pwaPhotoByToken(req, req.params.token); if (!photo) return res.status(404).json({ error: 'not-found' });
  const version = (photo.versions || []).find((v) => v.id === req.params.versionId); if (!version || !restorePhotoVersion(photo, version)) return res.status(404).json({ error: 'version-not-found' });
  persistNow(); res.json({ ok: true, image: pwaPhotoPayload(req, photo) });
});
app.post('/app/image/:token/replace', (req, res) => {
  const photo = pwaPhotoByToken(req, req.params.token); if (!photo) return res.status(404).json({ error: 'not-found' });
  let ext = (String(req.query.name || photo.name || 'image.jpg').split('.').pop() || '').toLowerCase(); if (ext === 'jpeg') ext = 'jpg';
  if (!PWA_IMG_EXT.test(ext)) return res.status(400).json({ error: 'not-image' });
  const fname = crypto.randomBytes(12).toString('hex') + '.' + ext; const dest = path.join(FULL_IMAGES_DIR, fname);
  streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size) => {
    try { archiveCurrentPhotoVersion(photo); } catch (e) { fs.unlink(dest, () => {}); return res.status(500).json({ error: 'archive-failed' }); }
    unlinkPhotoFiles(photoOriginalPaths(photo)); unlinkPhotoFiles(photoVariantPaths(photo.token, 'thumb')); unlinkPhotoFiles(photoVariantPaths(photo.token, 'micro')); unlinkPhotoFiles([photoAdaptivePath(photo.token, 'webp'), photoAdaptivePath(photo.token, 'avif')]);
    photo.imgPath = fname; photo.ext = ext; photo.size = size; photo.name = String(req.query.name || photo.name).replace(/[\/\r\n\t]+/g, ' ').trim().slice(0, 120) || photo.name;
    if (String(req.query.metadataRemoved || '') === '1') photo.metadataRemoved = true; else delete photo.metadataRemoved;
    const dims = imageDimensions(dest); if (dims) { photo.w = dims.w; photo.h = dims.h; }
    delete photo.thumb; delete photo.micro; delete photo.adaptiveWebp; delete photo.adaptiveAvif; delete photo.thumbSize; delete photo.microSize;
    photo.replacedAt = Date.now(); persistNow(); res.json({ ok: true, image: pwaPhotoPayload(req, photo) });
  });
});
app.post('/app/image/:token/adaptive/:format', (req, res) => {
  const photo = pwaPhotoByToken(req, req.params.token); const fmt = String(req.params.format || '').toLowerCase();
  if (!photo || !/^(webp|avif)$/.test(fmt)) return res.status(404).json({ error: 'not-found' });
  const dest = photoAdaptivePath(photo.token, fmt);
  streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size) => {
    const dims = imageDimensions(dest); photo[fmt === 'webp' ? 'adaptiveWebp' : 'adaptiveAvif'] = true; photo[fmt === 'webp' ? 'adaptiveWebpSize' : 'adaptiveAvifSize'] = size;
    if (dims) { photo[fmt === 'webp' ? 'adaptiveWebpW' : 'adaptiveAvifW'] = dims.w; photo[fmt === 'webp' ? 'adaptiveWebpH' : 'adaptiveAvifH'] = dims.h; }
    persistNow(); res.json({ ok: true, bytes: size, w: dims && dims.w, h: dims && dims.h });
  });
});

app.post('/app/image', (req, res) => {
  let ext = (String(req.query.name || 'image.jpg').split('.').pop() || '').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (!PWA_IMG_EXT.test(ext)) return res.status(400).json({ error: 'not-image' });
  const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
  const dest = path.join(FULL_IMAGES_DIR, fname);
  streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size) => {
    const name = String(req.query.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120) || ('image.' + ext);
    const fileDims = imageDimensions(dest);
    const queryW = Math.max(0, Math.min(100000, parseInt(req.query.w, 10) || 0));
    const queryH = Math.max(0, Math.min(100000, parseInt(req.query.h, 10) || 0));
    const dims = queryW && queryH ? { w: queryW, h: queryH } : fileDims;
    const share = { type: 'photo', name, imgPath: fname, ext, size };
    if (String(req.query.metadataRemoved || '') === '1') share.metadataRemoved = true;
    stampPhotoUploadDevice(share, req, 'pwa');
    const clientHash = String(req.query.clientHash || '').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(clientHash)) share.clientHash = clientHash;
    if (dims) { share.w = dims.w; share.h = dims.h; }
    pwaImgOwner(req, share);
    const rec = addShare(share);
    const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
    logAudit('image-created', { username: who, ip: clientIp(req), detail: 'via PWA — ' + name });
    res.status(201).json(pwaImageCreatePayload(req, rec));
  });
});
app.post('/app/image/:token/thumb', (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || s.type !== 'photo' || !canManagePwaImage(req, s)) return res.status(404).json({ error: 'not-found' });
  const dest = path.join(THUMBS_DIR, s.token + '.jpg');
  streamToFileBounded(req, res, dest, THUMB_MAX_BYTES, (size) => {
    const dims = imageDimensions(dest);
    s.thumb = true;
    s.thumbSize = size;
    if (dims) { s.thumbW = dims.w; s.thumbH = dims.h; }
    scheduleFlush();
    res.json({ ok: true, w: dims ? dims.w : null, h: dims ? dims.h : null, bytes: size });
  });
});
app.post('/app/image/:token/micro', (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || s.type !== 'photo' || !canManagePwaImage(req, s)) return res.status(404).json({ error: 'not-found' });
  const dest = path.join(MICROS_DIR, s.token + '.jpg');
  streamToFileBounded(req, res, dest, MICRO_MAX_BYTES, (size) => {
    const dims = imageDimensions(dest);
    s.micro = true;
    s.microSize = size;
    if (dims) { s.microW = dims.w; s.microH = dims.h; }
    scheduleFlush();
    res.json({ ok: true, w: dims ? dims.w : null, h: dims ? dims.h : null, bytes: size });
  });
});
// Revoke a share the PWA created — a reception link (inbox) or an image link
// (photo). Authorization reuses the per-image ownership rules: only the account
// or paired device that created it (or an owner/admin session) may revoke it.
// Received files under INBOX_DIR are intentionally left in place; only the link
// and, for images, the managed image copies are removed.
app.post('/app/share/:token/revoke', (req, res) => {
  const s = getByToken(req.params.token);
  const revocableTypes = ['photo', 'inbox', 'file', 'folder'];
  if (!s || !revocableTypes.includes(s.type) || !canManagePwaImage(req, s)) {
    return res.status(404).json({ error: 'not-found' });
  }
  const kind = s.type === 'photo' ? 'image' : s.type === 'inbox' ? 'reception' : 'share';
  const label = kind + ' ' + (s.name || '');
  removeShare(s.id);
  const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
  logAudit('share-revoked', { username: who, ip: clientIp(req), detail: 'via PWA — ' + label });
  res.json({ ok: true });
});

// ---- Server-file shares: the standard Direct-Xfer function, exposed to the PWA. ----
// Browsing the whole read-only host filesystem and turning a file/folder into a public
// /s or /f link is an administrator capability, so these require a logged-in admin
// session (not a bare paired device). They already pass the PWA network guard, and
// mutations already require CSRF via requireAppAuth.
function pwaHostAdminSession(req, res) {
  const session = req.pwaSession || getSession(req);
  const role = session && session.role;
  if (!session || !['owner', 'admin', 'operator'].includes(role)) {
    res.status(403).json({ error: 'admin-required' });
    return null;
  }
  return session;
}

app.get('/app/host/browse', async (req, res) => {
  if (!pwaHostAdminSession(req, res)) return;
  const reqPath = String(req.query.path || '/');
  let absDir;
  try {
    absDir = hostToContainer(reqPath);
    await assertRealWithin(HOST_ROOT, absDir);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'host-inaccessible', root: '/' });
    return res.status(400).json({ error: 'invalid-path' });
  }
  let st;
  try { st = await fs.promises.stat(absDir); } catch (_) { return res.status(404).json({ error: 'not-found' }); }
  if (!st.isDirectory()) return res.status(400).json({ error: 'not-a-folder' });
  let dirents;
  try { dirents = await fs.promises.readdir(absDir, { withFileTypes: true }); } catch (_) { return res.status(403).json({ error: 'read-failed' }); }
  const entries = [];
  for (const d of dirents) {
    const isDir = d.isDirectory();
    const isFile = d.isFile();
    if (!isDir && !isFile) continue;
    entries.push({
      name: d.name,
      isDir,
      isFile,
      size: null,
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal,javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
      // d.name is a dirent from fs.readdir(absDir) (absDir already validated), not user text.
      path: containerToHost(path.join(absDir, d.name)),
    });
  }
  const files = entries.filter((e) => e.isFile);
  await mapLimit(files, 32, async (e) => {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal,javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
    try { e.size = (await fs.promises.stat(path.join(absDir, e.name))).size; } catch (_) {}
  });
  entries.forEach((e) => delete e.isFile);
  const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : coll.compare(a.name, b.name)));
  const cwd = containerToHost(absDir);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ root: '/', cwd, parent: cwd === '/' ? null : containerToHost(path.dirname(absDir)), entries });
});

app.post('/app/host/shares', pwaJsonParser, async (req, res) => {
  if (!pwaHostAdminSession(req, res)) return;
  const body = req.body || {};
  const reqPaths = reqPathList(body);
  if (!reqPaths.length) return res.status(400).json({ error: 'missing-path' });
  let resolved;
  try { resolved = []; for (const p of reqPaths) resolved.push(await resolveHostItem(p)); }
  catch (e) { return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' }); }
  const first = resolved[0];
  const type = resolved.length > 1 ? 'file' : first.type; // a multi-select bundle is a 'file' collection
  const share = {
    type,
    hostPath: first.hostPath,
    name: first.name || first.hostPath || 'share',
    size: type === 'file' ? first.size : null,
    expiresAt: parseExpiry(body.expiresInSeconds),
    maxDownloads: parseMaxDownloads(body.maxDownloads),
  };
  if (type === 'file') share.items = resolved.map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type }));
  if (resolved.length > 1) share.collection = true;
  const password = String(body.password || '');
  // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
  if (password) Object.assign(share, makeSharePassword(password));
  if (typeof body.note === 'string') {
    const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 2000);
    if (note) share.note = note;
  }
  const maxVisitors = Math.max(0, parseInt(body.maxVisitors, 10) || 0);
  if (maxVisitors > 0) share.maxVisitors = maxVisitors;
  stampPwaRecordOwner(req, share);
  const rec = addShare(share);
  const who = (req.pwaSession && req.pwaSession.username) || 'PWA';
  logAudit('share-created', { username: who, ip: clientIp(req), detail: 'via PWA — ' + share.type + ' ' + (share.name || '') });
  res.status(201).json({ share: decorateShare(rec, req) });
});

app.get('/app/host/shares', (req, res) => {
  // Listing existing links is read-only, so an admin's paired device may see them even
  // without a live session (unlike FS browse / create above, which stay session-only).
  if (!pwaViewerIsAdmin(req)) return res.status(403).json({ error: 'admin-required' });
  const list = state.shares
    .filter((s) => s && (s.type === 'file' || s.type === 'folder') && canManagePwaImage(req, s))
    .map((s) => decorateShare(s, req))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 500);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ shares: list });
});

// All reception (inbox) links the caller can manage — including ones created on the
// standard web version — so they are visible/manageable from the PWA.
app.get('/app/receptions', (req, res) => {
  const list = state.shares
    .filter((s) => s && s.type === 'inbox' && canManagePwaImage(req, s))
    .map((s) => {
      const dec = decorateShare(s, req);
      return {
        token: s.token,
        name: s.name || 'Réception',
        url: dec.url,
        createdAt: s.createdAt || 0,
        expiresAt: s.expiresAt || null,
        bytesReceived: Number(s.bytesReceived) || 0,
        owned: canManagePwaImage(req, s),
      };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 500);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ receptions: list });
});
// Files received on a reception link the caller owns. Server-backed on purpose:
// the received content survives any client-side storage loss (IndexedDB/localStorage
// eviction, WebAPK relaunch, reconnection) because the server is the source of truth.
function inboxReceivedFiles(share) {
  const root = resolveWithin(INBOX_DIR, share.relDir || '');
  const files = [];
  const walk = (dir, relPrefix, top) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (top && e.name === '.dxparts') continue; // resumable-upload staging area
      const abs = path.join(dir, e.name);
      const rel = relPrefix ? relPrefix + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(abs, rel, false); if (files.length >= 5000) return; continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(abs); } catch (_) { continue; }
      files.push({ name: e.name, path: rel, size: st.size, mtime: Math.round(st.mtimeMs) });
      if (files.length >= 5000) return;
    }
  };
  try { walk(root, '', true); } catch (_) {}
  files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return files;
}
app.get('/app/inbox/:token/files', (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || (s.type !== 'inbox' && s.type !== 'collab') || !canManagePwaImage(req, s)) {
    return res.status(404).json({ error: 'not-found' });
  }
  const files = inboxReceivedFiles(s);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token: s.token, name: s.name || '', count: files.length, files });
});
app.get('/app/inbox/:token/file', (req, res) => {
  const s = getByToken(req.params.token);
  if (!s || (s.type !== 'inbox' && s.type !== 'collab') || !canManagePwaImage(req, s)) {
    return res.status(404).json({ error: 'not-found' });
  }
  const rel = String(req.query.path || '');
  if (/(^|\/)\.dxparts(\/|$)/.test(rel)) return res.status(404).json({ error: 'not-found' });
  let abs;
  try { abs = resolveWithin(resolveWithin(INBOX_DIR, s.relDir || ''), rel); }
  catch (_) { return res.status(400).json({ error: 'invalid-path' }); }
  let st;
  try { st = fs.statSync(abs); } catch (_) { return res.status(404).json({ error: 'not-found' }); }
  if (!st.isFile()) return res.status(404).json({ error: 'not-found' });
  const filename = path.basename(abs);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  const stream = fs.createReadStream(abs);
  stream.on('error', () => { if (res.headersSent) res.destroy(); else res.status(500).end(); });
  stream.pipe(res);
});
function publicPwaDevice(d, currentId) {
  return {
    id: d.id,
    name: d.name || 'Direct-Xfer PWA',
    createdAt: d.createdAt || null,
    lastUsedAt: d.lastUsedAt || d.createdAt || null,
    current: d.id === currentId,
  };
}
app.get('/app/device/status', (req, res) => {
  const session = getSession(req);
  const device = req.pwaDevice || getPwaDevice(req);
  const devices = session ? pwaDevices().map((d) => publicPwaDevice(d, device && device.id)) : [];
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    paired: !!device,
    adminSession: !!session,
    // Prefer the admin-session token when both cookies are present so admin-only
    // device-management actions continue to work. A paired-only device receives
    // its own CSRF token.
    csrf: session ? session.csrf : device ? device.csrf : null,
    device: device ? publicPwaDevice(device, device.id) : null,
    devices,
  });
});
app.post('/app/device/pairing', adminGuard, pwaJsonParser, async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not-authenticated' });
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
  prunePwaPairTickets();
  const ticket = crypto.randomBytes(36).toString('base64url');
  const name = String((req.body && req.body.name) || 'Direct-Xfer PWA (QR)').replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Direct-Xfer PWA (QR)';
  const expiresAt = Date.now() + 5 * 60 * 1000;
  pwaPairTickets.set(ticket, { expiresAt, createdBy: session.username || null, name });
  const host = String(req.get('host') || '');
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) { pwaPairTickets.delete(ticket); return res.status(400).json({ error: 'invalid-host' }); }
  const claimUrl = `${externalProto(req)}://${host}/app/device/claim?ticket=${encodeURIComponent(ticket)}`;
  try {
    const qrSvg = await QRCode.toString(claimUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, claimUrl, qrSvg, expiresAt });
  } catch (_) {
    pwaPairTickets.delete(ticket);
    res.status(500).json({ error: 'qr-error' });
  }
});

app.post('/app/device/register', adminGuard, pwaJsonParser, (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not-authenticated' });
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
  const device = issuePwaDevice(req, res, (req.body && req.body.name) || 'Direct-Xfer PWA', session.username || null);
  req.session = session;
  auditReq(req, 'pwa-device-paired', device.name);
  res.json({ ok: true, device: publicPwaDevice(device, device.id) });
});
app.post('/app/device/revoke', pwaJsonParser, (req, res) => {
  const session = getSession(req);
  const current = req.pwaDevice || getPwaDevice(req, false);
  let id = String((req.body && req.body.id) || '');
  const revokeShares = !!(req.body && req.body.revokeShares);

  const perform = () => {
    if (!id && current) id = current.id;
    if (!id) return res.status(400).json({ error: 'missing-id' });
    const list = pwaDevices();
    const found = list.find((d) => d.id === id);
    state.meta.pwaDevices = list.filter((d) => d.id !== id);
    let revokedShares = 0;
    if (revokeShares) {
      const owned = state.shares.filter((s) => s && s.ownerDeviceId === id).map((s) => s.id);
      for (const shareId of owned) if (removeShare(shareId, false)) revokedShares += 1;
    }
    // Device-scoped push subscriptions and live streams must not survive a
    // revocation, regardless of whether its public links are also removed.
    const ownerKey = 'dev:' + id;
    let pushScopesRemoved = 0;
    state.meta.pushSubs = pushSubs().map((sub) => {
      if (!Array.isArray(sub.ownerKeys)) return sub;
      const ownerKeys = sub.ownerKeys.filter((key) => key !== ownerKey);
      pushScopesRemoved += sub.ownerKeys.length - ownerKeys.length;
      return { ...sub, ownerKeys };
    }).filter((sub) => !Array.isArray(sub.ownerKeys) || sub.ownerKeys.length > 0);
    const streams = inboxEventSubs.get(ownerKey);
    if (streams) {
      for (const stream of streams) { try { stream.end(); } catch (_) {} }
      inboxEventSubs.delete(ownerKey);
    }
    persist();
    if (current && current.id === id) clearPwaDeviceCookie(req, res);
    if (session) {
      req.session = session;
      auditReq(req, 'pwa-device-revoked', `${found ? found.name : id}; shares=${revokedShares}; push-scopes=${pushScopesRemoved}`);
    }
    return res.json({ ok: true, revokedShares });
  };

  // A paired device can always revoke itself. Revoking a different device is an
  // admin action and must still satisfy the admin IP allowlist + CSRF protection.
  if (!id || (current && id === current.id)) return perform();
  if (!session) return res.status(401).json({ error: 'not-authenticated' });
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
  return adminGuard(req, res, perform);
});

// Rename a paired device. A device can always rename itself (mutation CSRF is
// already enforced by requireAppAuth); renaming a different device is an admin
// action guarded by the admin IP allowlist + session CSRF, mirroring revoke.
app.post('/app/device/rename', pwaJsonParser, (req, res) => {
  const session = getSession(req);
  const current = req.pwaDevice || getPwaDevice(req, false);
  const name = String((req.body && req.body.name) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'invalid-name' });
  let id = String((req.body && req.body.id) || '');

  const perform = () => {
    if (!id && current) id = current.id;
    if (!id) return res.status(400).json({ error: 'missing-id' });
    const device = pwaDevices().find((d) => d.id === id);
    if (!device) return res.status(404).json({ error: 'not-found' });
    device.name = name;
    scheduleFlush();
    if (session) {
      req.session = session;
      auditReq(req, 'pwa-device-renamed', device.name);
    } else {
      logAudit('pwa-device-renamed', { username: 'PWA: ' + device.name, ip: clientIp(req), detail: 'device renamed' });
    }
    return res.json({ ok: true, device: publicPwaDevice(device, current && current.id) });
  };

  if (!id || (current && id === current.id)) return perform();
  if (!session) return res.status(401).json({ error: 'not-authenticated' });
  const csrf = req.headers['x-csrf-token'];
  if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
  return adminGuard(req, res, perform);
});

const pwaIndexTemplate = fs.readFileSync(path.join(__dirname, 'pwa', 'index.html'), 'utf8');
function pwaImageBootstrapMarkup(req) {
  const payload = JSON.stringify({ images: pwaImagesForRequest(req, { limit: 500, includeInactive: true }) });
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  return `<template id="dx-image-bootstrap" data-encoding="base64">${encoded}</template>`;
}
function setPwaDocumentHeaders(res) {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self)');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie, Authorization');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self' blob:; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
}

// The authenticated image inventory is embedded in the navigation document. This
// makes a manual refresh deterministic even when IndexedDB is temporarily blocked,
// a reverse proxy delays /app/images, or an older service-worker response races the
// freshly uploaded record. The payload is base64 inside an inert template: it never
// executes and cannot break out into markup.
app.get(['/app/', '/app/index.html'], (req, res) => {
  setPwaDocumentHeaders(res);
  const html = pwaIndexTemplate.replace('<!--DX_IMAGE_BOOTSTRAP-->', pwaImageBootstrapMarkup(req));
  res.send(html);
});

app.use('/app', express.static(path.join(__dirname, 'pwa'), {
  index: 'index.html',
  extensions: ['html'],
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self)');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
      "media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self' blob:; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    if (filePath.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/app/');
  },
}));

// Non-enumerating diagnostic hints for a failed login. Based ONLY on server
// configuration/state (never on whether the entered username exists), so they
// leak nothing about which accounts are present — they just help the operator
// understand a persistent "invalid password" (env-managed owner, non-persistent
// /data). The frontend maps each code to a localized sentence.
function loginHints() {
  const hints = [];
  if (adminPwFromEnv) hints.push('env-owner'); // owner login uses ADMIN_PASSWORD
  if (!dataWritable()) hints.push('no-persist'); // accounts/pw changes don't survive a restart
  return hints;
}

// Login (local network only by default). 256kb comfortably fits a shares-config
// import (hundreds of link records) while staying bounded; all /api routes are
// gated by adminGuard (IP allowlist) before this parser ever runs.
const jsonParser = express.json({ limit: '256kb' });
app.post('/api/login', adminGuard, jsonParser, (req, res) => {
  const username = (req.body && req.body.username) || '';
  const password = (req.body && req.body.password) || '';
  const totp = (req.body && req.body.totp) || '';
  const result = attemptLogin(req, res, username, password, totp);
  if (result.ok) {
    const acc = result.account;
    return res.json({
      ok: true, csrf: result.csrf,
      mustChangePassword: accountNeedsPwChange(acc),
      username: acc.username, role: acc.role,
    });
  }
  if (result.locked) {
    return res.status(429).json({ error: 'too-many-attempts', retryAfter: result.retryAfter });
  }
  // Password is valid but a 2FA code is needed (or the one given is wrong).
  if (result.totpRequired) return res.status(401).json({ error: 'totp-required' });
  if (result.totpInvalid) return res.status(401).json({ error: 'invalid-totp' });
  return res.status(401).json({ error: 'invalid-password', hints: loginHints() });
});

// Public metadata (version, year) — for the footer.
app.get('/api/meta', (req, res) => {
  res.json({
    version: APP_VERSION,
    year: APP_YEAR,
    releaseDate: RELEASE_DATE,
    update: {
      available: !!updateState.available,
      latest: updateState.available ? updateState.latest : null,
      url: updateState.available ? `https://hub.docker.com/r/${UPDATE_REPO}` : null,
    },
    // Login-page setup warning: are the reception / images folders still on the
    // container's ephemeral filesystem (default, un-mapped volume)? Booleans only.
    setup: {
      inboxUnconfigured: STORAGE_SETUP.inboxUnconfigured,
      imagesUnconfigured: STORAGE_SETUP.imagesUnconfigured,
    },
  });
});

// Admin API (local network + password).
app.use('/api', adminGuard, jsonParser, adminRouter);

// The Images admin surface is a client-routed sub-page of the SPA (URL /images).
// Serving the same index.html here means a direct hit or a reload on /images lands on
// the app — which reads the URL and opens the Images page — instead of a 404. It sits
// behind adminGuard, the same network/allowlist gate as the rest of the interface.
app.get('/images', adminGuard, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Independent dashboards page, protected by the same admin network guard.
app.get('/dashboards', adminGuard, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static web interface (local network by default).
app.use(
  adminGuard,
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    extensions: ['html'],
    dotfiles: 'ignore',
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// 404.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not-found' });
  sendError(req, res, 404, 'pageNotFound');
});

// Global error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload-too-large' });
  }
  console.error('[server] unhandled error:', err && err.message);
  if (res.headersSent) return res.destroy();
  res.status(500).json({ error: 'server-error' });
});

const tlsOptions = loadTlsOptions();
const server = tlsOptions
  ? https.createServer(tlsOptions, app).listen(PORT, BIND, () => printStartupBanner())
  : app.listen(PORT, BIND, () => printStartupBanner());
const SERVER_SCHEME = tlsOptions ? 'https' : 'http';
server.headersTimeout = 65 * 1000;
server.requestTimeout = 0; // no limit: large downloads possible

// ===================================================================
//  STARTUP, NETWORK DETECTION, GRACEFUL SHUTDOWN
// ===================================================================

// Detects an Unraid host. The host filesystem is usually mounted read-only at
// HOST_ROOT. We try two things: (1) OS-level markers, visible when the real root
// is mounted (/:/host); (2) a fallback for when HOST_ROOT points at Unraid's
// user-share tree instead (e.g. /mnt/user:/host), where those OS files are out of
// reach — there we recognize the default Unraid shares as a signature.
function isUnraidHost() {
  // (1) Root-of-host mount: OS-level Unraid markers are directly visible. Several
  // independent ones (any hit = Unraid) so it still works if one path is
  // unreadable by the unprivileged runtime user (e.g. the FAT flash under /boot).
  const rootMarkers = [
    ['usr', 'local', 'emhttp'], // Unraid webGUI root (always present on Unraid)
    ['boot', 'config'],         // Unraid config on the USB flash
    ['etc', 'unraid-version'],  // version stamp
    ['var', 'local', 'emhttp'], // emhttp runtime state
  ];
  for (const parts of rootMarkers) {
    try { if (fs.existsSync(path.join(HOST_ROOT, ...parts))) return true; } catch (_) {}
  }
  // (2) HOST_ROOT points at the user-share tree (/mnt/user or /mnt/user0): the OS
  // files above aren't reachable, so match Unraid's default shares instead —
  // appdata + system + one of domains/isos is a strong, Unraid-specific signature.
  try {
    const has = (name) => fs.existsSync(path.join(HOST_ROOT, name));
    if (has('appdata') && has('system') && (has('domains') || has('isos'))) return true;
  } catch (_) {}
  return false;
}
// Unraid version string, if readable. Tries /etc/unraid-version (which looks like
// version="6.12.10"), then emhttp's var.ini. Returns '' when unavailable.
function unraidVersion() {
  try {
    const raw = fs.readFileSync(path.join(HOST_ROOT, 'etc', 'unraid-version'), 'utf8');
    const m = /version\s*=\s*"?([^"\s]+)"?/i.exec(raw);
    if (m) return m[1];
  } catch (_) {}
  try {
    const ini = fs.readFileSync(path.join(HOST_ROOT, 'var', 'local', 'emhttp', 'var.ini'), 'utf8');
    const m = /^\s*version\s*=\s*"?([^"\s]+)"?/im.exec(ini);
    if (m) return m[1];
  } catch (_) {}
  return '';
}
// The runtime user/group the process actually ended up as (after the entrypoint's
// su-exec drop). Returns '' on platforms without getuid.
function runtimeUidGid() {
  try {
    if (typeof process.getuid === 'function') return `${process.getuid()}:${process.getgid()}`;
  } catch (_) {}
  return '';
}

function printStartupBanner() {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │        Direct-Xfer — HTTP file sharing       │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log(`  • Version          : v${APP_VERSION}`);
  // The server binds to BIND (all interfaces by default). For the banner we show
  // the address admins actually reach: the LAN IP when LOCAL_IP is set and BIND
  // is a wildcard, keeping the real bind in parentheses for accuracy. When BIND
  // is a wildcard and LOCAL_IP is absent, we flag that 0.0.0.0 is NOT the LAN IP.
  const wildcardBind = BIND === '0.0.0.0' || BIND === '::';
  let shownHost = BIND;
  let bindNote = '';
  if (wildcardBind) {
    if (LOCAL_IP) {
      shownHost = LOCAL_IP;
      bindNote = `  (bind ${BIND} — all interfaces)`;
    } else {
      bindNote = '  (all interfaces — NOT the LAN IP; set LOCAL_IP to display it)';
    }
  }
  const scheme = (typeof SERVER_SCHEME !== 'undefined' && SERVER_SCHEME) || 'http';
  console.log(`  • Listening on     : ${scheme}://${shownHost}:${PORT}${bindNote}`);
  if (scheme === 'https') console.log('  • TLS              : on' + (TLS_CERT && TLS_KEY ? ' (provided cert)' : ' (self-signed — browsers will warn once)'));
  let hostRootOk = false;
  try {
    hostRootOk = fs.statSync(HOST_ROOT).isDirectory();
  } catch (_) {}
  console.log(
    `  • Host FS (ro)     : ${HOST_ROOT}` +
      (hostRootOk ? '' : red('  ⚠ NOT FOUND (add the  /:/host:ro  mount)'))
  );
  const dataOk = dataWritable();
  console.log(
    `  • Data             : ${DATA_DIR}${hostMountNote(DATA_DIR)}` +
      (dataOk
        ? ''
        : red('  ⚠ not writable — passwords/shares/settings will not persist. Fix the host folder ownership: on Unraid set PUID/PGID (e.g. 99/100) to match the appdata owner, otherwise chown the mapped /data to the container user (e.g. chown -R 1000:1000), or add :z on SELinux hosts.'))
  );
  let imagesOk = false;
  try { fs.accessSync(IMAGE_STORE_DIR, fs.constants.W_OK); imagesOk = true; } catch (_) {}
  console.log(
    `  • Images           : ${IMAGE_STORE_DIR}${hostMountNote(IMAGE_STORE_DIR)}` +
      (imagesOk ? '' : red('  ⚠ not writable — Full, Mini and Micro copies cannot be saved. Fix the Images volume ownership or PUID/PGID.'))
  );
  if (isUnraidHost()) {
    const ver = unraidVersion();
    const uidGid = runtimeUidGid();
    console.log(
      `  • Unraid detected  : ${ver ? 'v' + ver : 'yes'}` +
        (uidGid ? `  (running as ${uidGid})` : '')
    );
    // PUID/PGID are consumed by the entrypoint, but Docker also exposes them to
    // the process — so their presence here tells us whether the operator set them.
    const puid = (process.env.PUID || '').trim();
    const pgid = (process.env.PGID || '').trim();
    if (!puid || !pgid) {
      if (!dataOk) {
        // Not configured AND /data can't be written: this is the actual failure.
        console.log(red('  ⚠  PUID/PGID NOT set — the container defaulted to 1000:1000, but Unraid'));
        console.log(red('     appdata is usually owned by nobody:users (99:100), so /data is not'));
        console.log(red('     writable and the admin password/settings will NOT persist.'));
        console.log(red('     Fix: set PUID=99 and PGID=100 (or the appdata owner) on the container.'));
      } else {
        // Not configured but /data happens to be writable: nudge, not an alarm.
        console.log(red('  ⚠  PUID/PGID not set — recommended on Unraid: set PUID=99 and PGID=100'));
        console.log(red('     (or your appdata owner) so files stay owned by the right user.'));
      }
    } else {
      console.log(`  • PUID/PGID        : ${puid}:${pgid}`);
    }
  }
  let inboxOk = false;
  try {
    inboxOk = fs.statSync(INBOX_DIR).isDirectory();
  } catch (_) {}
  console.log(
    `  • Reception        : ${INBOX_DIR}${hostMountNote(INBOX_DIR)}` +
      (inboxOk ? '' : red('  ⚠ not mounted (mount a writable host folder here)'))
  );
  if (STORAGE_SETUP.inboxUnconfigured || STORAGE_SETUP.imagesUnconfigured) {
    console.log(red('  ⚠  Storage not configured — these folders are still at the docker-compose'));
    console.log(red('     default (/PATH/TO/CONFIGURE placeholder) or lack a persistent volume:'));
    if (STORAGE_SETUP.inboxUnconfigured) console.log(red(`       ${INBOX_DIR}  (received files)`));
    if (STORAGE_SETUP.imagesUnconfigured) console.log(red(`       ${IMAGE_STORE_DIR}  (self-hosted images)`));
    console.log(red('     Point them at real, writable host folders in docker-compose.yml.'));
  }
  if (ADMIN_ALLOWED_IPS.length) {
    console.log(`  • Admin access     : IP allowlist (${ADMIN_ALLOWED_IPS.length} entr${ADMIN_ALLOWED_IPS.length > 1 ? 'ies' : 'y'})`);
    if (!TRUST_PROXY) {
      console.log(red('      ⚠ set TRUST_PROXY behind a reverse proxy so the real visitor IP is evaluated'));
    }
  } else {
    console.log(
      `  • Admin access     : ${ADMIN_ALLOW_ANY ? 'ALL NETWORKS (ADMIN_ALLOW_ANY)' : 'local network only'}`
    );
  }
  if (PUBLIC_URL) console.log(`  • Public URL       : ${PUBLIC_URL}  (reverse proxy)`);
  if (TRUST_PROXY) console.log(`  • Reverse proxy    : enabled (trust proxy = ${TRUST_PROXY})`);
  if (getSettings().shutdownAfterDownload) {
    console.log('  • Auto-shutdown    : ARMED (stops after the next complete download)');
  }

  const ownerName = (ownerAccount() && ownerAccount().username) || ADMIN_USERNAME;
  if (adminPwFromEnv) {
    // Ground truth: when ADMIN_PASSWORD is set it overrides the stored owner hash
    // at every login, so we never print a generated password here (it would be a
    // password that can never actually be used to log in).
    console.log(`  • Owner account    : ${ownerName} (password via ADMIN_PASSWORD)`);
  } else if (ADMIN_PASSWORD_FRESH) {
    console.log('');
    console.log(`  • Owner account    : ${ownerName}`);
    console.log('  ⚠  Owner password generated automatically:');
    console.log('     ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
    console.log(`       ${ADMIN_PASSWORD_PLAINTEXT_ONCE}`);
    console.log('     ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
    console.log(`     Log in as "${ownerName}". Save it now — only a salted hash is stored.`);
    if (!dataWritable()) {
      // The freshly generated password can't be saved, so it will be a DIFFERENT
      // random password on the next restart — i.e. unusable after a reboot.
      console.log(red('  ⚠  /data is NOT writable — this password will be REGENERATED on the next'));
      console.log(red('     restart (so it won\'t work after a reboot). Fix /data ownership'));
      console.log(red('     (Unraid: set PUID/PGID to the appdata owner, e.g. 99/100), or set a'));
      console.log(red('     fixed ADMIN_PASSWORD.'));
    }
  } else {
    console.log('');
    console.log(`  • Owner account    : ${ownerName}`);
    console.log('  • Owner password   : set previously (stored as a salted hash).');
    console.log('    If lost, set the ADMIN_PASSWORD variable to override it.');
  }
  console.log('');
  detectNetwork();
  if (UPDATE_CHECK) {
    checkForUpdate();
    const h = setInterval(checkForUpdate, 12 * 60 * 60 * 1000);
    if (h && h.unref) h.unref();
  }
}

async function detectNetwork() {
  // Detects the public IP (caches it for links). The external-access test
  // is NOT run at startup: it triggers on demand from the interface.
  try {
    const ip = await getPublicIP();
    if (ip) console.log(`  • Public IP detected : ${ip}`);
    else console.log(red('  ⚠  Public IP not detected (no outbound Internet access?).'));
    console.log('');
  } catch (e) {
    console.log(red(`  ⚠  Network detection failed: ${e.message}`));
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET')) {
    console.warn('[server] client stream interrupted:', err.code);
    return;
  }
  console.error('[server] uncaught exception:', err && err.stack ? err.stack : err);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] shutting down (${signal})…`);
  server.close(async () => {
    try {
      await flushNow(); // ensures the last transfer's history is written
    } catch (_) {}
    console.log('[server] server closed.');
    process.exit(0);
  });
  try {
    await flushNow();
  } catch (_) {}
  setTimeout(() => {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  }, 2000).unref();
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Auto-shutdown: the first complete download triggers the shutdown.
bus.on('shutdown', () => shutdown('download-complete'));
