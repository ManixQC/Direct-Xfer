'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE_CATEGORY_ORDER = Object.freeze(['image', 'video', 'audio', 'document', 'archive', 'code', 'other']);
const FILE_CATEGORY_EXTS = Object.freeze({
  image:new Set(['jpg','jpeg','png','gif','webp','avif','bmp','tif','tiff','heic','heif','svg','ico']),
  video:new Set(['mp4','m4v','mkv','mov','avi','webm','wmv','flv','mpeg','mpg','ts','mts','m2ts','3gp']),
  audio:new Set(['mp3','m4a','aac','flac','wav','ogg','opus','wma','aiff','alac']),
  document:new Set(['pdf','doc','docx','docm','xls','xlsx','xlsm','ppt','pptx','pptm','odt','ods','odp','rtf','txt','csv','md','epub']),
  archive:new Set(['zip','7z','rar','tar','gz','tgz','bz2','xz','zst','iso']),
  code:new Set(['js','mjs','cjs','ts','tsx','jsx','py','rb','php','java','c','h','cpp','hpp','cs','go','rs','swift','kt','kts','sh','bash','ps1','html','htm','css','scss','sass','less','json','xml','yaml','yml','toml','ini','env','sql']),
});

/**
 * Owns managed-storage accounting and the cached deep system-health snapshot.
 * Mutable project state is always resolved through getState(), so a restore may
 * replace the root store without leaving this service bound to stale metadata.
 */
function createSystemHealthService(deps = {}) {
  const {
    DATA_DIR,
    FULL_IMAGES_DIR,
    THUMBS_DIR,
    MICROS_DIR,
    PHOTO_HISTORY_DIR,
    PHOTO_VERSIONS_DIR,
    ADAPTIVE_IMAGES_DIR,
    ENC_DIR,
    SECRETS_DIR,
    QUARANTINE_DIR,
    SEARCH_INDEX_FILE,
    SEARCH_OCR_CACHE_FILE,
    LOG_FILE,
    AUDIT_CHAIN_FILE,
    STORE_FILE,
    AUDIT_HEAD_FILE,
    AUDIT_KEY_FILE,
    IMAGE_STORE_DIR,
    INBOX_DIR,
    STORAGE_SETUP = {},
    DATA_KEY = '',
    CLAMAV_HOST = '',
    CLAMAV_PORT = 0,
    SEARCH_OCR_ENABLED = false,
    SEARCH_OCR_LANGS = '',
    PUBLIC_URL = '',
    TRUST_PROXY = false,
    PORT = 0,
    ADMIN_ALLOWED_IPS = [],
    deepCacheMs = 30000,
    fsTimeoutMs = 2500,
    scanCacheMs = 60000,
    scanTimeoutMs = 10000,
    auditVerifyMs = 5 * 60 * 1000,
    backingRefreshLimit = 16,
    getState,
    getSettings,
    getServerScheme,
    getWebpush,
    diagnosticsService,
    connectorJobService,
    verifyAuditChain,
    auditService,
    universalSearchStatus,
    detectSearchOcrTools,
    diskFreeThresholds,
    isBackupInFlight,
    clamavEnabled,
    tlsManager,
    connectorStore,
    pushSubs,
    emailConfigured,
    effectiveWebhook,
    getLastEmail,
    getLastWebhook,
    getLocalIPv4s,
    listShares,
    isScheduled,
    isActive,
    shareEffectiveExpiry,
    shareBackingHealthSnapshot,
    queueShareBackingHealthRefresh,
  } = deps;

  for (const [name, dependency] of Object.entries({
    getState,
    getSettings,
    getServerScheme,
    getWebpush,
    verifyAuditChain,
    universalSearchStatus,
    detectSearchOcrTools,
    diskFreeThresholds,
    isBackupInFlight,
    clamavEnabled,
    connectorStore,
    pushSubs,
    emailConfigured,
    effectiveWebhook,
    getLastEmail,
    getLastWebhook,
    getLocalIPv4s,
    listShares,
    isScheduled,
    isActive,
    shareEffectiveExpiry,
    shareBackingHealthSnapshot,
    queueShareBackingHealthRefresh,
  })) {
    if (typeof dependency !== 'function') throw new TypeError(`system-health-service requires ${name}()`);
  }
  if (!diagnosticsService || typeof diagnosticsService.tlsCertificateDiagnostics !== 'function') {
    throw new TypeError('system-health-service requires diagnosticsService');
  }
  if (!connectorJobService
    || typeof connectorJobService.probeSnapshot !== 'function'
    || typeof connectorJobService.pruneJobs !== 'function'
    || !Number.isFinite(Number(connectorJobService.maxActive))) {
    throw new TypeError('system-health-service requires connectorJobService');
  }
  const connectorProbeSnapshot = connectorJobService.probeSnapshot;
  const pruneConnectorJobs = connectorJobService.pruneJobs;
  const maxActiveConnectorJobs = Math.max(0, Number(connectorJobService.maxActive) || 0);
  if (!auditService || typeof auditService.getIntegrityStatus !== 'function') throw new TypeError('system-health-service requires auditService');
  if (!tlsManager || typeof tlsManager !== 'object') throw new TypeError('system-health-service requires tlsManager');
  for (const [name, value] of Object.entries({
    DATA_DIR,
    FULL_IMAGES_DIR,
    THUMBS_DIR,
    MICROS_DIR,
    PHOTO_HISTORY_DIR,
    PHOTO_VERSIONS_DIR,
    ADAPTIVE_IMAGES_DIR,
    ENC_DIR,
    SECRETS_DIR,
    QUARANTINE_DIR,
    SEARCH_INDEX_FILE,
    SEARCH_OCR_CACHE_FILE,
    LOG_FILE,
    AUDIT_CHAIN_FILE,
    STORE_FILE,
    AUDIT_HEAD_FILE,
    AUDIT_KEY_FILE,
    IMAGE_STORE_DIR,
    INBOX_DIR,
  })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`system-health-service requires ${name}`);
  }

  const boundedDuration = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  };
  const deepCacheDuration = boundedDuration(deepCacheMs, 30000, 0, 10 * 60 * 1000);
  const filesystemTimeout = boundedDuration(fsTimeoutMs, 2500, 100, 30000);
  const storageCacheDuration = boundedDuration(scanCacheMs, 60000, 0, 10 * 60 * 1000);
  const storageScanTimeout = boundedDuration(scanTimeoutMs, 10000, filesystemTimeout, 5 * 60 * 1000);
  const auditVerifyDuration = boundedDuration(auditVerifyMs, 5 * 60 * 1000, 0, 60 * 60 * 1000);
  const backingRefreshBudget = Math.min(128, Math.max(0, Number.isFinite(Number(backingRefreshLimit)) ? Math.floor(Number(backingRefreshLimit)) : 16));
  let runtimeEpoch = 0;

  function serverHealthWithTimeout(promise, ms = filesystemTimeout) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code:'ETIMEDOUT' })), ms);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  function storageScanDeadline() {
    return Date.now() + storageScanTimeout;
  }

  function fileCategoryOf(name) {
    const ext = path.extname(String(name || '')).slice(1).toLowerCase();
    for (const key of FILE_CATEGORY_ORDER) if (key !== 'other' && FILE_CATEGORY_EXTS[key].has(ext)) return key;
    return 'other';
  }

  function categoryRows(map) {
    return FILE_CATEGORY_ORDER.map((category) => {
      const row = map.get(category) || {};
      return { category, bytes:Math.max(0, Number(row.bytes) || 0), count:Math.max(0, Number(row.count) || 0) };
    }).filter((row) => row.bytes || row.count);
  }

  function mergeCategoryRows(target, rows) {
    for (const row of (rows || [])) {
      const key = FILE_CATEGORY_ORDER.includes(row.category) ? row.category : 'other';
      const current = target.get(key) || { bytes:0, count:0 };
      current.bytes += Math.max(0, Number(row.bytes) || 0);
      current.count += Math.max(0, Number(row.count) || 0);
      target.set(key, current);
    }
  }

  async function scanDirUsage(root, options) {
    const settings = options || {};
    const maxEntries = Math.max(100, Number(settings.maxEntries) || 25000);
    const byCategory = new Map();
    const stack = [{ directory:path.resolve(root), configuredRoot:true }];
    const deadline = storageScanDeadline();
    let bytes = 0;
    let files = 0;
    let entries = 0;
    let truncated = false;
    while (stack.length && entries < maxEntries && Date.now() < deadline) {
      const { directory, configuredRoot } = stack.pop();
      if (!configuredRoot) {
        try {
          const directoryStat = await serverHealthWithTimeout(fs.promises.lstat(directory));
          if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
        } catch (error) {
          if (!error || error.code !== 'ENOENT') truncated = true;
          continue;
        }
      }
      let items;
      try { items = await serverHealthWithTimeout(fs.promises.readdir(directory, { withFileTypes:true })); }
      catch (error) {
        if (!error || error.code !== 'ENOENT') truncated = true;
        continue;
      }
      for (const item of items) {
        if (Date.now() >= deadline) { truncated = true; break; }
        if (++entries > maxEntries) { truncated = true; break; }
        if (item.isSymbolicLink()) continue;
        const absolute = path.join(directory, item.name);
        if (item.isDirectory()) { stack.push({ directory:absolute, configuredRoot:false }); continue; }
        if (!item.isFile()) continue;
        let stat;
        try { stat = await serverHealthWithTimeout(fs.promises.lstat(absolute)); }
        catch (error) {
          if (!error || error.code !== 'ENOENT') truncated = true;
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const size = Math.max(0, Number(stat.size) || 0);
        bytes += size;
        files += 1;
        const category = fileCategoryOf(item.name);
        const current = byCategory.get(category) || { bytes:0, count:0 };
        current.bytes += size;
        current.count += 1;
        byCategory.set(category, current);
      }
    }
    if (stack.length || Date.now() >= deadline) truncated = true;
    return { bytes, files, entries, truncated, byCategory:categoryRows(byCategory) };
  }

  async function fileBytes(file) {
    try {
      const stat = await serverHealthWithTimeout(fs.promises.lstat(file));
      return {
        bytes:!stat.isSymbolicLink() && stat.isFile() ? Math.max(0, Number(stat.size) || 0) : 0,
        incomplete:false,
      };
    } catch (error) {
      return { bytes:0, incomplete:!error || error.code !== 'ENOENT' };
    }
  }

  let receptionStorageScanCache = { at:0, data:null };
  let receptionStorageScanPending = null;
  async function scanReceptionStorage() {
    const now = Date.now();
    if (receptionStorageScanCache.data && now - receptionStorageScanCache.at < storageCacheDuration) return receptionStorageScanCache.data;
    if (receptionStorageScanPending) return receptionStorageScanPending;
    const expectedEpoch = runtimeEpoch;
    const pending = scanReceptionStorageUncached(now)
      .then((data) => {
        if (runtimeEpoch === expectedEpoch) receptionStorageScanCache = { at:Date.now(), data };
        return data;
      });
    receptionStorageScanPending = pending;
    try { return await pending; }
    finally {
      if (receptionStorageScanPending === pending) receptionStorageScanPending = null;
    }
  }

  async function scanReceptionStorageUncached(now) {
    const maxEntries = 25000;
    const stack = [{ directory:INBOX_DIR, configuredRoot:true }];
    const deadline = storageScanDeadline();
    const byExtension = new Map();
    const byCategory = new Map();
    const largestFiles = [];
    let entries = 0;
    let files = 0;
    let directories = 0;
    let managedBytes = 0;
    let partialBytes = 0;
    let partialFiles = 0;
    let stalePartialBytes = 0;
    let stalePartialFiles = 0;
    let truncated = false;
    while (stack.length && entries < maxEntries && Date.now() < deadline) {
      const { directory, configuredRoot } = stack.pop();
      if (!configuredRoot) {
        try {
          const directoryStat = await serverHealthWithTimeout(fs.promises.lstat(directory));
          if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
        } catch (error) {
          if (!error || error.code !== 'ENOENT') truncated = true;
          continue;
        }
      }
      let items;
      try { items = await serverHealthWithTimeout(fs.promises.readdir(directory, { withFileTypes:true })); }
      catch (error) {
        if (!error || error.code !== 'ENOENT') truncated = true;
        continue;
      }
      for (const item of items) {
        if (Date.now() >= deadline) { truncated = true; break; }
        if (++entries > maxEntries) { truncated = true; break; }
        if (item.isSymbolicLink()) continue;
        const absolute = path.join(directory, item.name);
        if (item.isDirectory()) {
          directories += 1;
          stack.push({ directory:absolute, configuredRoot:false });
          continue;
        }
        if (!item.isFile()) continue;
        let stat;
        try { stat = await serverHealthWithTimeout(fs.promises.lstat(absolute)); }
        catch (error) {
          if (!error || error.code !== 'ENOENT') truncated = true;
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const size = Math.max(0, Number(stat.size) || 0);
        files += 1;
        managedBytes += size;
        const extension = (path.extname(item.name).slice(1).toLowerCase() || '(sans extension)').slice(0, 16);
        const extensionRow = byExtension.get(extension) || { ext:extension, bytes:0, count:0 };
        extensionRow.bytes += size;
        extensionRow.count += 1;
        byExtension.set(extension, extensionRow);
        const category = fileCategoryOf(item.name);
        const categoryRow = byCategory.get(category) || { bytes:0, count:0 };
        categoryRow.bytes += size;
        categoryRow.count += 1;
        byCategory.set(category, categoryRow);
        const relative = path.relative(INBOX_DIR, absolute).split(path.sep).join('/');
        largestFiles.push({ name:relative || item.name, bytes:size, modifiedAt:Number(stat.mtimeMs) || 0 });
        largestFiles.sort((a, b) => b.bytes - a.bytes);
        if (largestFiles.length > 10) largestFiles.length = 10;
        if (/(?:\.part|\.partial|\.tmp|\.upload)$/i.test(item.name)) {
          partialFiles += 1;
          partialBytes += size;
          if (now - (Number(stat.mtimeMs) || now) > 24 * 60 * 60 * 1000) {
            stalePartialFiles += 1;
            stalePartialBytes += size;
          }
        }
      }
    }
    if (stack.length || Date.now() >= deadline) truncated = true;
    const data = {
      managedBytes,
      files,
      directories,
      partialBytes,
      partialFiles,
      stalePartialBytes,
      stalePartialFiles,
      byExtension:[...byExtension.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
      byCategory:categoryRows(byCategory),
      largestFiles,
      scannedEntries:entries,
      truncated,
      generatedAt:now,
    };
    return data;
  }

  let globalStorageReportCache = { at:0, data:null };
  let globalStorageReportPending = null;
  async function buildGlobalStorageReport() {
    const now = Date.now();
    if (globalStorageReportCache.data && now - globalStorageReportCache.at < storageCacheDuration) return globalStorageReportCache.data;
    if (globalStorageReportPending) return globalStorageReportPending;
    const expectedEpoch = runtimeEpoch;
    const pending = buildGlobalStorageReportUncached(now)
      .then((data) => {
        if (runtimeEpoch === expectedEpoch) globalStorageReportCache = { at:Date.now(), data };
        return data;
      });
    globalStorageReportPending = pending;
    try { return await pending; }
    finally {
      if (globalStorageReportPending === pending) globalStorageReportPending = null;
    }
  }

  async function buildGlobalStorageReportUncached(now) {
    const reception = await scanReceptionStorage();
    const rootFilePaths = [
      SEARCH_INDEX_FILE,
      SEARCH_OCR_CACHE_FILE,
      LOG_FILE,
      AUDIT_CHAIN_FILE,
      STORE_FILE,
      AUDIT_HEAD_FILE,
      AUDIT_KEY_FILE,
    ];
    const [full, mini, micro, history, versions, adaptive, encrypted, secrets, quarantine, rootFileSizes] = await Promise.all([
      scanDirUsage(FULL_IMAGES_DIR),
      scanDirUsage(THUMBS_DIR),
      scanDirUsage(MICROS_DIR),
      scanDirUsage(PHOTO_HISTORY_DIR),
      scanDirUsage(PHOTO_VERSIONS_DIR),
      scanDirUsage(ADAPTIVE_IMAGES_DIR),
      scanDirUsage(ENC_DIR),
      scanDirUsage(SECRETS_DIR),
      scanDirUsage(QUARANTINE_DIR),
      Promise.all(rootFilePaths.map((file) => fileBytes(file))),
    ]);
    const sizeOf = (file) => {
      const usage = rootFileSizes[rootFilePaths.indexOf(file)];
      return usage && Number(usage.bytes) || 0;
    };
    const rootFilesIncomplete = rootFileSizes.some((usage) => usage && usage.incomplete);
    const rootFiles = {
      search:sizeOf(SEARCH_INDEX_FILE) + sizeOf(SEARCH_OCR_CACHE_FILE),
      logs:sizeOf(LOG_FILE) + sizeOf(AUDIT_CHAIN_FILE),
      metadata:sizeOf(STORE_FILE) + sizeOf(AUDIT_HEAD_FILE) + sizeOf(AUDIT_KEY_FILE),
    };
    const components = [
      { key:'reception', bytes:Math.max(0, (reception.managedBytes || 0) - (reception.partialBytes || 0)), files:Math.max(0, (reception.files || 0) - (reception.partialFiles || 0)) },
      { key:'imagesFull', bytes:full.bytes, files:full.files },
      { key:'imagePreviews', bytes:mini.bytes + micro.bytes, files:mini.files + micro.files },
      { key:'imageHistory', bytes:history.bytes + versions.bytes + adaptive.bytes, files:history.files + versions.files + adaptive.files },
      { key:'encrypted', bytes:encrypted.bytes, files:encrypted.files },
      { key:'secrets', bytes:secrets.bytes, files:secrets.files },
      { key:'quarantine', bytes:quarantine.bytes, files:quarantine.files },
      { key:'searchOcr', bytes:rootFiles.search, files:[SEARCH_INDEX_FILE, SEARCH_OCR_CACHE_FILE].filter((file) => sizeOf(file) > 0).length },
      { key:'logs', bytes:rootFiles.logs, files:[LOG_FILE, AUDIT_CHAIN_FILE].filter((file) => sizeOf(file) > 0).length },
      { key:'metadata', bytes:rootFiles.metadata, files:[STORE_FILE, AUDIT_HEAD_FILE, AUDIT_KEY_FILE].filter((file) => sizeOf(file) > 0).length },
      { key:'temporary', bytes:reception.partialBytes || 0, files:reception.partialFiles || 0, reclaimableBytes:reception.stalePartialBytes || 0, reclaimableFiles:reception.stalePartialFiles || 0 },
    ];
    const fileCategories = new Map();
    mergeCategoryRows(fileCategories, reception.byCategory || []);
    mergeCategoryRows(fileCategories, full.byCategory || []);
    const managedBytes = components.reduce((total, component) => total + (Number(component.bytes) || 0), 0);
    const managedFiles = components.reduce((total, component) => total + (Number(component.files) || 0), 0);
    let disk = null;
    try {
      if (fs.promises && typeof fs.promises.statfs === 'function') {
        const stat = await serverHealthWithTimeout(fs.promises.statfs(DATA_DIR));
        const total = stat.blocks * stat.bsize;
        const free = stat.bavail * stat.bsize;
        disk = { total, free, used:Math.max(0, total - free), path:DATA_DIR };
      }
    } catch (_) {}
    const data = {
      managedBytes,
      managedFiles,
      components,
      fileCategories:categoryRows(fileCategories),
      disk,
      reclaimableBytes:reception.stalePartialBytes || 0,
      truncated:!!([
        reception,
        full,
        mini,
        micro,
        history,
        versions,
        adaptive,
        encrypted,
        secrets,
        quarantine,
      ].some((scan) => scan && scan.truncated) || rootFilesIncomplete),
      generatedAt:now,
    };
    return data;
  }

  let serverHealthDeepCache = { at:0, value:null, pending:null };
  let serverHealthAuditCache = { at:0, value:null };
  const serverHealthVolumeCache = new Map();
  const serverHealthVolumePending = new Map();

  async function serverHealthExistingAncestor(target) {
    let probe = target;
    while (probe) {
      try { await serverHealthWithTimeout(fs.promises.lstat(probe)); return probe; }
      catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
    return null;
  }

  async function serverHealthVolumeProbe(label, target, kind) {
    if (!target) return { label, kind, configured:false, path:null, exists:false, readable:false, writable:false, symlink:false, directory:false, device:null, disk:null, error:'not-configured' };
    const out = { label, kind, configured:true, path:String(target), exists:false, readable:false, writable:false, symlink:false, directory:false, device:null, disk:null, error:null };
    try {
      const stat = await serverHealthWithTimeout(fs.promises.lstat(target));
      out.exists = true;
      out.symlink = stat.isSymbolicLink();
      out.directory = stat.isDirectory();
      out.device = Number.isFinite(Number(stat.dev)) ? Number(stat.dev) : null;
      if (out.symlink) {
        try {
          const followed = await serverHealthWithTimeout(fs.promises.stat(target));
          out.directory = followed.isDirectory();
          out.device = Number.isFinite(Number(followed.dev)) ? Number(followed.dev) : out.device;
        } catch (error) { out.error = error && error.code ? String(error.code) : 'symlink-target-unavailable'; }
      }
      const access = await Promise.allSettled([
        serverHealthWithTimeout(fs.promises.access(target, fs.constants.R_OK)),
        serverHealthWithTimeout(fs.promises.access(target, fs.constants.W_OK)),
      ]);
      out.readable = access[0].status === 'fulfilled';
      out.writable = access[1].status === 'fulfilled';
    } catch (error) { out.error = error && error.code ? String(error.code) : 'unavailable'; }
    if (fs.promises && typeof fs.promises.statfs === 'function') {
      try {
        const probe = out.exists ? target : await serverHealthExistingAncestor(target);
        if (probe) {
          const stat = await serverHealthWithTimeout(fs.promises.statfs(probe));
          const blockSize = Math.max(0, Number(stat.bsize) || 0);
          const total = Math.max(0, Number(stat.blocks) || 0) * blockSize;
          const free = Math.max(0, Number(stat.bavail) || 0) * blockSize;
          out.disk = { total, free, used:Math.max(0, total - free), percent:total ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : null };
        }
      } catch (error) { if (!out.error) out.error = error && error.code ? String(error.code) : 'disk-unavailable'; }
    }
    return out;
  }

  async function serverHealthVolume(label, target, kind) {
    const key = String(kind || '') + '\0' + String(target || '');
    const expectedEpoch = runtimeEpoch;
    const cached = serverHealthVolumeCache.get(key) || null;
    if (serverHealthVolumePending.has(key)) {
      return cached
        ? { ...cached, stale:true, probing:true }
        : { label, kind, configured:!!target, path:target ? String(target) : null, exists:false, readable:false, writable:false, symlink:false, directory:false, device:null, disk:null, error:'probe-pending', probing:true };
    }
    const probe = serverHealthVolumeProbe(label, target, kind)
      .then((value) => {
        if (runtimeEpoch === expectedEpoch) serverHealthVolumeCache.set(key, value);
        return value;
      })
      .finally(() => { if (serverHealthVolumePending.get(key) === probe) serverHealthVolumePending.delete(key); });
    serverHealthVolumePending.set(key, probe);
    try { return await serverHealthWithTimeout(probe); }
    catch (error) {
      return cached
        ? { ...cached, stale:true, probing:true, error:cached.error || 'probe-timeout' }
        : { label, kind, configured:!!target, path:target ? String(target) : null, exists:false, readable:false, writable:false, symlink:false, directory:false, device:null, disk:null, error:error && error.code === 'ETIMEDOUT' ? 'probe-timeout' : 'unavailable', probing:true };
    }
  }

  function serverHealthReceptionVolume() {
    return serverHealthVolume('reception', INBOX_DIR, 'reception');
  }

  function serverHealthAuditSnapshot() {
    const now = Date.now();
    if (!serverHealthAuditCache.value || now - serverHealthAuditCache.at >= auditVerifyDuration) {
      let value;
      try { value = verifyAuditChain(); }
      catch (_) { value = { ok:false, reason:'verification-failed', checkedAt:now }; }
      if (!value || typeof value !== 'object' || typeof value.then === 'function') {
        value = { ok:false, reason:'verification-invalid', checkedAt:now };
      }
      serverHealthAuditCache = { at:now, value };
    }
    const verified = serverHealthAuditCache.value || {};
    let live = {};
    try {
      const candidate = auditService.getIntegrityStatus();
      if (candidate && typeof candidate === 'object') live = candidate;
    } catch (_) {}
    const liveFailure = live.checkedAt && live.ok === false;
    return {
      ok:liveFailure ? false : !!verified.ok,
      reason:liveFailure ? (live.reason || 'integrity-failed') : (verified.reason || null),
      entries:Math.max(0, Number(live.entries || verified.entries) || 0),
      head:{ seq:Math.max(0, Number(live.headSeq || verified.headSeq) || 0), hash:String(live.headHash || verified.headHash || '') },
      checkedAt:Number(verified.checkedAt) || serverHealthAuditCache.at,
    };
  }

  function serverHealthShareSummary(now = Date.now()) {
    const out = { total:0, active:0, paused:0, scheduled:0, expired:0, revoked:0, inactive:0, backingMissing:0, backingChecking:0, backingRefreshQueued:0 };
    let refreshBudget = backingRefreshBudget;
    let shares = [];
    try {
      const candidate = listShares();
      if (Array.isArray(candidate)) shares = candidate;
    } catch (_) {}
    for (const share of shares) {
      if (!share) continue;
      out.total += 1;
      try {
        if (share.revoked) out.revoked += 1;
        else if (share.disabled) out.paused += 1;
        else if (isScheduled(share, now)) out.scheduled += 1;
        else if (isActive(share, now)) out.active += 1;
        else {
          const expiry = Number(shareEffectiveExpiry(share)) || Number(share.expiresAt) || 0;
          if (expiry && now > expiry) out.expired += 1;
          else out.inactive += 1;
        }
      } catch (_) { out.inactive += 1; }
      let backing = {};
      try { backing = shareBackingHealthSnapshot(share) || {}; } catch (_) {}
      if (backing.status === 'missing') out.backingMissing += 1;
      else if (backing.status === 'checking') {
        out.backingChecking += 1;
        if (refreshBudget > 0) {
          refreshBudget -= 1;
          out.backingRefreshQueued += 1;
          try {
            const refresh = queueShareBackingHealthRefresh(share);
            if (refresh && typeof refresh.catch === 'function') refresh.catch(() => {});
          } catch (_) {}
        }
      }
    }
    return out;
  }

  function serverHealthJobSummary(now = Date.now()) {
    const out = { total:0, queued:0, running:0, completed:0, failed:0, cancelled:0, failedRecent24h:0, cancelledRecent24h:0 };
    const recentCutoff = now - 24 * 60 * 60 * 1000;
    let jobs = [];
    try {
      const candidate = pruneConnectorJobs();
      if (Array.isArray(candidate)) jobs = candidate;
    } catch (_) {}
    for (const job of jobs) {
      if (!job) continue;
      out.total += 1;
      const key = ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status) ? job.status : null;
      if (key) out[key] += 1;
      const endedAt = Number(job.finishedAt || job.createdAt) || 0;
      if (endedAt >= recentCutoff && job.status === 'failed') out.failedRecent24h += 1;
      if (endedAt >= recentCutoff && job.status === 'cancelled') out.cancelledRecent24h += 1;
    }
    return out;
  }

  function safeCall(fn, fallback) {
    try {
      const value = fn();
      return value === undefined || value === null ? fallback : value;
    } catch (_) { return fallback; }
  }

  async function serverHealthDeepSnapshot() {
    const now = Date.now();
    if (serverHealthDeepCache.value && now - serverHealthDeepCache.at < deepCacheDuration) return serverHealthDeepCache.value;
    if (serverHealthDeepCache.pending) return serverHealthDeepCache.pending;
    const expectedEpoch = runtimeEpoch;
    serverHealthDeepCache.pending = (async () => {
      const settingsCandidate = safeCall(getSettings, {});
      const settings = settingsCandidate && typeof settingsCandidate === 'object' ? settingsCandidate : {};
      const connectorProbeCandidate = await serverHealthWithTimeout(Promise.resolve()
        .then(() => connectorProbeSnapshot()))
        .catch(() => ({ capabilities:{ available:false, error:'unavailable' }, remotes:[] }));
      const connectorProbe = connectorProbeCandidate && typeof connectorProbeCandidate === 'object'
        ? connectorProbeCandidate
        : { capabilities:{ available:false, error:'unavailable' }, remotes:[] };
      const audit = serverHealthAuditSnapshot();
      const tlsDiagnosticsCandidate = safeCall(() => diagnosticsService.tlsCertificateDiagnostics(), { status:'bad', reason:'diagnostic-unavailable', fixable:false });
      const tlsDiagnostics = tlsDiagnosticsCandidate && typeof tlsDiagnosticsCandidate === 'object'
        ? tlsDiagnosticsCandidate
        : { status:'bad', reason:'diagnostic-unavailable', fixable:false };
      const searchCandidate = safeCall(universalSearchStatus, {});
      const search = searchCandidate && typeof searchCandidate === 'object' ? searchCandidate : {};
      const ocr = await serverHealthWithTimeout(Promise.resolve().then(() => detectSearchOcrTools()))
        .catch(() => null);
      const volumeSpecs = [
        ['data', DATA_DIR, 'data'],
        ['images', IMAGE_STORE_DIR, 'images'],
        ['reception', INBOX_DIR, 'reception'],
      ];
      if (settings.backupEnabled && settings.backupDestType === 'local') volumeSpecs.push(['backup', settings.backupLocalDir || '', 'backup']);
      const volumes = await Promise.all(volumeSpecs.map(([label, target, kind]) => serverHealthVolume(label, target, kind)));
      const stateCandidate = safeCall(getState, {});
      const state = stateCandidate && typeof stateCandidate === 'object' ? stateCandidate : {};
      const lastEmailCandidate = safeCall(getLastEmail, null);
      const lastEmail = lastEmailCandidate && typeof lastEmailCandidate === 'object' ? lastEmailCandidate : null;
      const lastWebhookCandidate = safeCall(getLastWebhook, null);
      const lastWebhook = lastWebhookCandidate && typeof lastWebhookCandidate === 'object' ? lastWebhookCandidate : null;
      const subscriptionsCandidate = safeCall(pushSubs, []);
      const subscriptions = Array.isArray(subscriptionsCandidate) ? subscriptionsCandidate : [];
      const connectorsCandidate = safeCall(connectorStore, []);
      const connectors = Array.isArray(connectorsCandidate) ? connectorsCandidate : [];
      const webhookCandidate = safeCall(effectiveWebhook, {});
      const webhook = webhookCandidate && typeof webhookCandidate === 'object' ? webhookCandidate : {};
      const localIpsCandidate = safeCall(getLocalIPv4s, []);
      const localIps = Array.isArray(localIpsCandidate) ? localIpsCandidate : [];
      const thresholdsCandidate = safeCall(diskFreeThresholds, {});
      const thresholds = thresholdsCandidate && typeof thresholdsCandidate === 'object' ? thresholdsCandidate : {};
      const clamavConfigured = !!safeCall(clamavEnabled, false);
      const scheme = String(safeCall(getServerScheme, 'http') || 'http');
      const value = {
        generatedAt:Date.now(),
        storage:{ volumes, setup:{ inboxUnconfigured:!!STORAGE_SETUP.inboxUnconfigured, imagesUnconfigured:!!STORAGE_SETUP.imagesUnconfigured }, thresholds },
        backup:{ enabled:!!settings.backupEnabled, interval:settings.backupInterval || null, hour:Number(settings.backupHour) || 0, weekday:Number(settings.backupWeekday) || 0, retention:Number(settings.backupRetention) || 0, destination:settings.backupDestType || null, inFlight:!!safeCall(isBackupInFlight, false), last:(state.meta && state.meta.lastBackup) || null },
        security:{ audit:{ ok:!!(audit && audit.ok), reason:audit && audit.reason || null, entries:audit && audit.entries || 0, head:audit && audit.head || null, checkedAt:audit && audit.checkedAt || 0 }, dataEncrypted:!!DATA_KEY, dlpEnabled:settings.dlpEnabled !== false, ransomwareProtection:!!settings.ransomwareProtection, clamav:{ configured:clamavConfigured, host:clamavConfigured ? CLAMAV_HOST : null, port:clamavConfigured ? CLAMAV_PORT : null } },
        tls:{ active:scheme === 'https', mode:tlsManager.ACTIVE_TLS_MODE, diagnostics:tlsDiagnostics },
        search:{ ...search, ocrEnabled:!!SEARCH_OCR_ENABLED, ocrLanguages:SEARCH_OCR_LANGS, ocrTools:ocr ? { tesseract:!!ocr.tesseract, pdf:!!ocr.pdftoppm, missingLanguages:ocr.missingLanguages || [] } : null },
        connectors:{ capabilities:{ available:!!(connectorProbe.capabilities && connectorProbe.capabilities.available), version:connectorProbe.capabilities && connectorProbe.capabilities.version || null, error:connectorProbe.capabilities && connectorProbe.capabilities.error ? 'unavailable' : null }, configured:connectors.length, remotes:Array.isArray(connectorProbe.remotes) ? connectorProbe.remotes.length : 0, jobs:serverHealthJobSummary(), maxActive:maxActiveConnectorJobs },
        notifications:{ webPushAvailable:!!safeCall(getWebpush, null), subscriptions:subscriptions.length, emailConfigured:!!safeCall(emailConfigured, false), webhookConfigured:!!webhook.url, lastEmail:lastEmail ? { at:lastEmail.at || 0, ok:!!lastEmail.ok, error:lastEmail.error ? 'failed' : null } : null, lastWebhook:lastWebhook ? { at:lastWebhook.at || 0, ok:!!lastWebhook.ok, status:Number(lastWebhook.status) || 0, event:lastWebhook.event || null, error:lastWebhook.error ? 'failed' : null } : null },
        config:{ publicUrl:PUBLIC_URL || settings.linkBase || null, imageUrl:settings.imageBase || null, trustProxy:!!TRUST_PROXY, port:PORT, scheme, adminAllowlist:ADMIN_ALLOWED_IPS.length, localIps },
        runtime:{ node:process.version, platform:process.platform, arch:process.arch, hostname:os.hostname(), pid:process.pid },
      };
      if (runtimeEpoch === expectedEpoch) serverHealthDeepCache = { at:Date.now(), value, pending:null };
      return value;
    })().catch((error) => {
      if (runtimeEpoch === expectedEpoch) serverHealthDeepCache.pending = null;
      if (serverHealthDeepCache.value) return { ...serverHealthDeepCache.value, stale:true };
      throw error;
    });
    return serverHealthDeepCache.pending;
  }

  function clearRuntimeState() {
    runtimeEpoch += 1;
    receptionStorageScanCache = { at:0, data:null };
    receptionStorageScanPending = null;
    globalStorageReportCache = { at:0, data:null };
    globalStorageReportPending = null;
    serverHealthDeepCache = { at:0, value:null, pending:null };
    serverHealthAuditCache = { at:0, value:null };
    serverHealthVolumeCache.clear();
    serverHealthVolumePending.clear();
  }

  return Object.freeze({
    FILE_CATEGORY_ORDER,
    fileCategoryOf,
    scanDirUsage,
    scanReceptionStorage,
    buildGlobalStorageReport,
    diskFreeThresholds,
    serverHealthVolume,
    serverHealthReceptionVolume,
    serverHealthAuditSnapshot,
    serverHealthShareSummary,
    serverHealthJobSummary,
    serverHealthDeepSnapshot,
    clearRuntimeState,
  });
}

module.exports = { createSystemHealthService };
