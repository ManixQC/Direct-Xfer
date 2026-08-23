'use strict';

const fs = require('fs');
const path = require('path');
const { int, bool, parseTrustProxy, parseIpList } = require('../core-utils');

/**
 * Builds the immutable process configuration. No directory is created here:
 * filesystem mutations belong to bootstrap.js, while this module only parses
 * environment values, derives paths and exposes read-only mount diagnostics.
 */
function createServerConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..'));
  const env = options.env || process.env;
  const packageJson = options.packageJson || require(path.join(rootDir, 'package.json'));

  const APP_NAME = 'Direct-Xfer';
  const APP_VERSION = packageJson.version;
  const APP_YEAR = 2026;
  const RELEASE_DATE = (() => {
    try { return fs.statSync(path.join(rootDir, 'package.json')).mtime.toISOString(); }
    catch (_) { return null; }
  })();

  const PORT = int(env.PORT, 55750);
  const BIND = env.BIND || '0.0.0.0';
  const DX_WINDOWS_LAUNCHER_TOKEN = String(env.DX_WINDOWS_LAUNCHER_TOKEN || '').trim();
  const DX_WINDOWS_SHUTDOWN_MARKER = String(env.DX_WINDOWS_SHUTDOWN_MARKER || '').trim();
  const HOST_ROOT = path.resolve(env.HOST_ROOT || '/host');
  const DATA_DIR = path.resolve(env.DATA_DIR || '/data');
  const PUBLIC_HOST = String(env.PUBLIC_HOST || '').trim();
  const PUBLIC_URL = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const LOCAL_IP = (() => {
    const value = String(env.LOCAL_IP || '').trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) ? value : '';
  })();
  const TRUST_PROXY = parseTrustProxy(env.TRUST_PROXY);
  const SHUTDOWN_AFTER_DOWNLOAD = bool(env.SHUTDOWN_AFTER_DOWNLOAD);
  const SESSION_TTL_MS = int(env.SESSION_TTL_HOURS, 8) * 3600 * 1000;
  const MAX_ZIP_BYTES = int(env.MAX_ZIP_BYTES, 20 * 1024 ** 3);
  const MAX_CONCURRENT_ZIPS = Math.max(1, int(env.MAX_CONCURRENT_ZIPS, 2));
  const DATA_KEY = String(env.DATA_KEY || '').trim();
  const GOOGLE_OAUTH_BROKER_URL_ENV = String(env.DIRECT_XFER_OAUTH_BROKER_URL || '').trim();

  const INBOX_DIR = path.resolve(env.INBOX_DIR || '/Direct-Xfer');
  const PENDING_DIR = path.join(INBOX_DIR, '.dxpending');
  const CONNECTOR_IMPORT_DIR = path.resolve(env.CONNECTOR_IMPORT_DIR || path.join(INBOX_DIR, 'Imports'));
  const RCLONE_CONFIG = path.resolve(env.RCLONE_CONFIG || path.join(DATA_DIR, 'rclone', 'rclone.conf'));
  const RCLONE_BIN = String(env.RCLONE_BIN || '').trim();
  const MAX_UPLOAD_BYTES = int(env.MAX_UPLOAD_BYTES, 10 * 1024 ** 3);
  const MAX_CONCURRENT_UPLOADS = Math.max(1, int(env.MAX_CONCURRENT_UPLOADS, 8));
  const UPLOAD_IDLE_TIMEOUT_MS = Math.max(15000, int(env.UPLOAD_IDLE_TIMEOUT_SECONDS, 120) * 1000);

  const ENC_DIR = path.join(DATA_DIR, 'enc');
  const SECRETS_DIR = path.join(DATA_DIR, 'secrets');
  const IMAGE_STORE_DIR = path.resolve(env.IMAGES_DIR || path.join(DATA_DIR, 'images'));
  const FULL_IMAGES_DIR = path.join(IMAGE_STORE_DIR, 'Full');
  const THUMBS_DIR = path.join(IMAGE_STORE_DIR, 'Mini');
  const MICROS_DIR = path.join(IMAGE_STORE_DIR, 'Micro');
  const PHOTO_HISTORY_DIR = path.join(IMAGE_STORE_DIR, 'History');
  const PHOTO_VERSIONS_DIR = path.join(IMAGE_STORE_DIR, 'Versions');
  const ADAPTIVE_IMAGES_DIR = path.join(IMAGE_STORE_DIR, 'Adaptive');
  const DLP_QUARANTINE_DIR = path.join(DATA_DIR, 'dlp-quarantine');
  const LEGACY_IMAGES_DIR = path.join(DATA_DIR, 'images');
  const LEGACY_THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
  const LEGACY_MICROS_DIR = path.join(DATA_DIR, 'micros');
  const LEGACY_PHOTO_HISTORY_DIR = path.join(DATA_DIR, 'photo-history');
  const PWA_IMG_EXT = /^(jpg|png|gif|webp|bmp|avif)$/;

  const IN_CONTAINER = (() => {
    try { return fs.existsSync('/.dockerenv'); } catch (_) { return false; }
  })();
  const PLACEHOLDER_SRC = '/PATH/TO/CONFIGURE';
  const USE_COLOR = !env.NO_COLOR;
  const red = (text) => USE_COLOR ? `\x1b[1;31m${text}\x1b[0m` : text;
  function storageIsEphemeral(dir) {
    try { return fs.statSync(dir).dev === fs.statSync('/').dev; }
    catch (_) { return false; }
  }
  function mountSourceRoot(dir) {
    let lines;
    try { lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n'); }
    catch (_) { return null; }
    let root = null;
    for (const line of lines) {
      const fields = line.split(' ');
      if (fields.length >= 5 && fields[4] === dir) root = fields[3];
    }
    return root;
  }
  function folderUnconfigured(dir) {
    const source = mountSourceRoot(dir);
    if (source !== null) return source === PLACEHOLDER_SRC || source.startsWith(PLACEHOLDER_SRC + '/');
    return storageIsEphemeral(dir);
  }
  function hostMountNote(dir) {
    if (!IN_CONTAINER) return '';
    let cursor = dir;
    for (;;) {
      const source = mountSourceRoot(cursor);
      if (source !== null) {
        const relative = dir.slice(cursor.length);
        const hostPath = ((source === '/' ? '' : source) + relative) || '/';
        if (source === PLACEHOLDER_SRC || source.startsWith(PLACEHOLDER_SRC + '/')) return red(`  ← ${hostPath}  ⚠ placeholder`);
        if (hostPath === dir) return '  ← mounted host volume (exact host path only visible via `docker inspect`)';
        return `  ← host ${hostPath}`;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return '  (no volume — inside the container)';
      cursor = parent;
    }
  }

  const PHOTO_HISTORY_MAX = 50;
  const IMAGE_MAX_BYTES = 40 * 1024 * 1024;
  const THUMB_MAX_BYTES = 2 * 1024 * 1024;
  const MICRO_MAX_BYTES = 1024 * 1024;
  const CLAMAV_HOST = String(env.CLAMAV_HOST || '').trim();
  const CLAMAV_PORT = int(env.CLAMAV_PORT, 3310);
  const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
  const clamavEnabled = () => !!CLAMAV_HOST;
  const MAX_LOG_BYTES = int(env.MAX_LOG_BYTES, 8 * 1024 * 1024);
  const ADMIN_ALLOW_ANY = bool(env.ADMIN_ALLOW_ANY);
  const ADMIN_ALLOWED_IPS = Object.freeze(
    parseIpList(env.ADMIN_ALLOWED_IPS).map((entry) => Object.freeze(entry))
  );
  const PUID = String(env.PUID || '').trim();
  const PGID = String(env.PGID || '').trim();
  const WEBHOOK_URL = String(env.WEBHOOK_URL || '').trim();
  const WEBHOOK_FORMAT = String(env.WEBHOOK_FORMAT || '').trim().toLowerCase();
  const SMTP_URL = String(env.SMTP_URL || '').trim();
  const EMAIL_FROM = String(env.EMAIL_FROM || '').trim();
  const EMAIL_TO = String(env.EMAIL_TO || '').trim();
  const UPDATE_IMAGE = String(env.UPDATE_IMAGE || 'manixqc/direct-xfer:latest').trim();
  const UPDATE_CHECK = String(env.UPDATE_CHECK == null ? 'true' : env.UPDATE_CHECK).trim().toLowerCase() !== 'false';
  const PUBLIC_IP_DISCOVERY = String(env.PUBLIC_IP_DISCOVERY == null ? 'true' : env.PUBLIC_IP_DISCOVERY).trim().toLowerCase() !== 'false';
  const updateSlash = UPDATE_IMAGE.lastIndexOf('/');
  const updateDigest = UPDATE_IMAGE.lastIndexOf('@');
  const updateColon = UPDATE_IMAGE.lastIndexOf(':');
  const updateTagSeparator = updateDigest === -1 && updateColon > updateSlash ? updateColon : -1;
  const UPDATE_REPO = updateDigest > updateSlash
    ? UPDATE_IMAGE.slice(0, updateDigest)
    : (updateTagSeparator > 0 ? UPDATE_IMAGE.slice(0, updateTagSeparator) : UPDATE_IMAGE);
  const UPDATE_TAG = updateTagSeparator > 0 ? UPDATE_IMAGE.slice(updateTagSeparator + 1) : 'latest';

  // Runtime tuning knobs consumed by domain services. Bounds and defaults are kept
  // identical to their former inline definitions in the composition root so this is
  // a pure relocation of environment parsing into the config owner.
  const TRANSFER_STALL_MS = Math.max(15000, Math.min(10 * 60 * 1000, Number(env.TRANSFER_STALL_MS) || 45000));
  const SEARCH_INDEX_MAX_DOCS = Math.max(1000, int(env.SEARCH_INDEX_MAX_DOCS, 250000));
  const WEB_STORAGE_STAT_CACHE_MS = Math.min(60000, Math.max(1000, int(env.WEB_STORAGE_STAT_CACHE_MS, 15000)));
  const WEB_STORAGE_STREAM_IDLE_MS = Math.min(30 * 60 * 1000, Math.max(10000, int(env.WEB_STORAGE_STREAM_IDLE_MS, 120000)));
  const MAX_ACTIVE_CONNECTOR_JOBS = int(env.MAX_ACTIVE_CONNECTOR_JOBS, 4);

  // Process-local runtime constants (not environment-derived), centralized here so
  // the composition root reads them from serverConfig like every other tuning value.
  const HISTORY_MAX = 2000;                     // persistent transfer history kept in shares.json
  const AUDIT_MAX = 500;                        // most recent admin audit entries kept (state.audit, shares.json)
  const UNDO_DESCRIPTOR_MAX_BYTES = 256 * 1024; // hard cap per serialized reversal snapshot
  const FAIL_WINDOW_MS = 5 * 60 * 1000;         // login/unlock brute-force sliding window
  const ACCESS_REQUESTS_MAX = 200;              // per-link cap so a spammed request form can't bloat shares.json
  const MAX_STORAGE_CONNECTORS = 100;           // hard cap on configured storage connectors

  // Backward-compatible structured views for composition code. The flat keys
  // remain part of serverConfig because domain services still consume that public
  // contract directly; new composition code can depend on coherent groups instead
  // of destructuring dozens of unrelated process constants.
  const groups = Object.freeze({
    app:Object.freeze({ APP_NAME, APP_VERSION, APP_YEAR, RELEASE_DATE }),
    http:Object.freeze({ PORT, BIND, PUBLIC_HOST, PUBLIC_URL, LOCAL_IP, TRUST_PROXY }),
    paths:Object.freeze({
      HOST_ROOT, DATA_DIR, INBOX_DIR, PENDING_DIR, CONNECTOR_IMPORT_DIR, RCLONE_CONFIG,
      ENC_DIR, SECRETS_DIR, IMAGE_STORE_DIR, FULL_IMAGES_DIR, THUMBS_DIR, MICROS_DIR,
      PHOTO_HISTORY_DIR, PHOTO_VERSIONS_DIR, ADAPTIVE_IMAGES_DIR, DLP_QUARANTINE_DIR,
      LEGACY_IMAGES_DIR, LEGACY_THUMBS_DIR, LEGACY_MICROS_DIR, LEGACY_PHOTO_HISTORY_DIR,
      QUARANTINE_DIR,
    }),
    security:Object.freeze({
      SESSION_TTL_MS, FAIL_WINDOW_MS, DATA_KEY, ADMIN_ALLOW_ANY, ADMIN_ALLOWED_IPS,
    }),
    notifications:Object.freeze({ WEBHOOK_URL, WEBHOOK_FORMAT, SMTP_URL, EMAIL_FROM, EMAIL_TO }),
    updates:Object.freeze({ UPDATE_IMAGE, UPDATE_CHECK, PUBLIC_IP_DISCOVERY, UPDATE_REPO, UPDATE_TAG }),
    limits:Object.freeze({
      MAX_ZIP_BYTES, MAX_CONCURRENT_ZIPS, MAX_UPLOAD_BYTES, MAX_CONCURRENT_UPLOADS,
      UPLOAD_IDLE_TIMEOUT_MS, PHOTO_HISTORY_MAX, MAX_LOG_BYTES, TRANSFER_STALL_MS,
      SEARCH_INDEX_MAX_DOCS, MAX_ACTIVE_CONNECTOR_JOBS, HISTORY_MAX, AUDIT_MAX,
      UNDO_DESCRIPTOR_MAX_BYTES, MAX_STORAGE_CONNECTORS,
    }),
    connectors:Object.freeze({
      GOOGLE_OAUTH_BROKER_URL_ENV, RCLONE_BIN, CLAMAV_HOST, CLAMAV_PORT, clamavEnabled,
    }),
    features:Object.freeze({ SHUTDOWN_AFTER_DOWNLOAD }),
  });

  // Keep the legacy enumerable flat config surface byte-for-byte compatible for
  // callers that spread/enumerate it. Structured groups are an additive composition
  // aid, so expose them as a non-enumerable own property instead of leaking them
  // into historical `{ ...serverConfig }` copies.
  const config = {
    rootDir,
    APP_NAME, APP_VERSION, APP_YEAR, RELEASE_DATE,
    PORT, BIND, DX_WINDOWS_LAUNCHER_TOKEN, DX_WINDOWS_SHUTDOWN_MARKER,
    HOST_ROOT, DATA_DIR, PUBLIC_HOST, PUBLIC_URL, LOCAL_IP, TRUST_PROXY,
    SHUTDOWN_AFTER_DOWNLOAD, SESSION_TTL_MS, MAX_ZIP_BYTES, MAX_CONCURRENT_ZIPS,
    DATA_KEY, GOOGLE_OAUTH_BROKER_URL_ENV, INBOX_DIR, PENDING_DIR,
    CONNECTOR_IMPORT_DIR, RCLONE_CONFIG, RCLONE_BIN,
    MAX_UPLOAD_BYTES, MAX_CONCURRENT_UPLOADS,
    UPLOAD_IDLE_TIMEOUT_MS, ENC_DIR, SECRETS_DIR, IMAGE_STORE_DIR,
    FULL_IMAGES_DIR, THUMBS_DIR, MICROS_DIR, PHOTO_HISTORY_DIR,
    PHOTO_VERSIONS_DIR, ADAPTIVE_IMAGES_DIR, DLP_QUARANTINE_DIR,
    LEGACY_IMAGES_DIR, LEGACY_THUMBS_DIR, LEGACY_MICROS_DIR,
    LEGACY_PHOTO_HISTORY_DIR, PWA_IMG_EXT, IN_CONTAINER, PLACEHOLDER_SRC,
    red, folderUnconfigured, hostMountNote,
    PHOTO_HISTORY_MAX, IMAGE_MAX_BYTES, THUMB_MAX_BYTES, MICRO_MAX_BYTES,
    CLAMAV_HOST, CLAMAV_PORT, QUARANTINE_DIR, clamavEnabled, MAX_LOG_BYTES,
    ADMIN_ALLOW_ANY, ADMIN_ALLOWED_IPS, PUID, PGID, WEBHOOK_URL, WEBHOOK_FORMAT,
    SMTP_URL, EMAIL_FROM, EMAIL_TO, UPDATE_IMAGE, UPDATE_CHECK,
    PUBLIC_IP_DISCOVERY, UPDATE_REPO, UPDATE_TAG,
    TRANSFER_STALL_MS, SEARCH_INDEX_MAX_DOCS,
    WEB_STORAGE_STAT_CACHE_MS, WEB_STORAGE_STREAM_IDLE_MS, MAX_ACTIVE_CONNECTOR_JOBS,
    HISTORY_MAX, AUDIT_MAX, UNDO_DESCRIPTOR_MAX_BYTES, FAIL_WINDOW_MS,
    ACCESS_REQUESTS_MAX, MAX_STORAGE_CONNECTORS,
  };
  Object.defineProperty(config, 'groups', {
    enumerable:false,
    configurable:false,
    writable:false,
    value:groups,
  });
  return Object.freeze(config);
}

module.exports = { createServerConfig };
