'use strict';

/**
 * Periodic housekeeping and destructive-anomaly guard.
 *
 * This boundary owns the minute/hour schedules, retention purges, per-file and
 * secret expiry, and the short-lived ransomware block state. Filesystem and
 * application dependencies remain explicit so the service always reads the live
 * root state, including after a transactional restore.
 */
function createMaintenanceService(deps = {}) {
  const {
    fs, path, crypto,
    APP_NAME, DAY_MS, INBOX_DIR, LOG_FILE, SECRETS_DIR,
    FAIL_WINDOW_MS, GEO_TTL,
    getState, getSettings, persist, persistNow, scheduleFlush,
    sessionCleanup, authCleanup, unlockFails, geoCache, pruneCenterTrackers,
    runExpiredLinkLifecycle, maybeCleanupOrphanPendingFiles,
    trashItems, purgeTrashRecordById, checkCenterLinkStates,
    checkExpiringShares, maybeSendDigest, maybeRunScheduledBackup,
    releaseReceptionManagedBytes, addShareCenterNotification,
    noteCenterCleanup, scheduleSearchReindex,
    notificationAccountIdForShare, receptionMetadataPath,
    safeManagedInboxFilePath, addCenterNotification,
    clientIp, isLoopback, getById, acceptsUpload,
    logAudit, dispatch,
    logger = console,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = deps;

  const MAX_FILE_EXPIRE_SEC = 90 * 24 * 3600;
  const FILE_EXPIRY_MAX = 20000;
  const MAX_RANSOMWARE_BLOCK_MS = 24 * 60 * 60 * 1000;
  const ANOMALY_RECENT_MAX = 100;
  const ANOMALY_IP_MAX = 4096;
  const ANOMALY_EVENTS_PER_IP_MAX = 256;
  const SECRET_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
  const anomalyWindows = new Map();
  const anomalyRecent = [];
  let minuteTimer = null;
  let startupHourlyTimer = null;
  let hourlyTimer = null;
  let maintenanceEpoch = 0;
  let trashPurgePromise = null;
  let expirySizeMap = null;
  let expirySize = 0;

  function rootState() {
    return getState();
  }

  function purgeExpiredSecrets() {
    const root = rootState();
    const secrets = root.meta && root.meta.secrets;
    if (!secrets) return;
    if (typeof secrets !== 'object' || Array.isArray(secrets)) {
      root.meta.secrets = {};
      persist();
      return;
    }
    const now = Date.now();
    let changed = false;
    for (const token of Object.keys(secrets)) {
      const record = secrets[token];
      if (!SECRET_TOKEN_RE.test(String(token))) {
        // Corrupt metadata must never turn an expiry pass into a path traversal.
        // Drop only the unreachable record; do not construct a filesystem path.
        delete secrets[token];
        changed = true;
        continue;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        delete secrets[token];
        changed = true;
        continue;
      }
      const rawExpiry = record.expiresAt;
      if (rawExpiry == null || rawExpiry === '' || rawExpiry === 0) continue;
      const expiry = Number(rawExpiry);
      if (!Number.isFinite(expiry) || expiry <= 0) {
        // Invalid expiry metadata is sanitized to the safe "never expires"
        // value. It is never interpreted as permission to delete ciphertext.
        record.expiresAt = null;
        changed = true;
        continue;
      }
      if (now <= expiry) continue;
      const file = path.join(SECRETS_DIR, token + '.dxe');
      try { fs.unlinkSync(file); }
      catch (error) {
        if (!error || error.code !== 'ENOENT') continue;
      }
      delete secrets[token];
      changed = true;
    }
    if (changed) persist();
  }

  // Complements size-based trimming with the configured chronological retention.
  function purgeOldLog() {
    const days = Math.floor(Number(getSettings().logRetentionDays)) || 0;
    if (days <= 0) return;
    const cutoff = Date.now() - days * DAY_MS;
    let lines;
    try { lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n'); }
    catch (_) { return; }
    const nonEmpty = lines.filter(Boolean);
    const kept = nonEmpty.filter((line) => {
      try {
        const record = JSON.parse(line);
        return (record.endedAt || record.startedAt || 0) >= cutoff;
      } catch (_) {
        return false;
      }
    });
    if (kept.length === nonEmpty.length) return;
    try {
      fs.writeFileSync(LOG_FILE + '.tmp', kept.length ? kept.join('\n') + '\n' : '', { mode:0o600 });
      fs.renameSync(LOG_FILE + '.tmp', LOG_FILE);
    } catch (error) {
      logger.error('[log] retention purge failed:', error.message);
    }
  }

  // Destructive and disabled by default. Staging folders have independent
  // lifecycles and are never entered by the general inbox retention walk.
  function purgeOldInbox() {
    const days = Math.floor(Number(getSettings().inboxRetentionDays)) || 0;
    if (days <= 0) return;
    const cutoff = Date.now() - days * DAY_MS;
    let changed = false;
    let removedFiles = 0;
    let removedBytes = 0;
    let accountingChanged = false;
    const root = rootState();
    const expiryMap = root.meta && root.meta.fileExpiry && typeof root.meta.fileExpiry === 'object' && !Array.isArray(root.meta.fileExpiry)
      ? root.meta.fileExpiry : null;

    const walk = (directory) => {
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes:true }); }
      catch (_) { return; }
      for (const entry of entries) {
        if (entry.name === '.dxparts' || entry.name === '.dxpending' || entry.name.startsWith('.dx')) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(file);
          try { if (fs.readdirSync(file).length === 0) fs.rmdirSync(file); } catch (_) {}
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const stat = fs.statSync(file);
          if (stat.mtimeMs >= cutoff) continue;
          fs.unlinkSync(file);
          changed = true;
          removedFiles += 1;
          const bytes = Math.max(0, Number(stat.size) || 0);
          removedBytes += bytes;
          let retentionShare = null;
          try { retentionShare = releaseReceptionManagedBytes(file, bytes); }
          catch (error) { logger.error('[inbox-retention] reception accounting failed:', error.message); }
          if (retentionShare) {
            accountingChanged = true;
            try {
              addShareCenterNotification(retentionShare, 'retention-file-deleted', {
                name:entry.name,
                bytes,
                reason:'inbox-retention',
                dedupeKey:`retention-delete:inbox:${crypto.createHash('sha1').update(file).digest('hex').slice(0, 12)}:${Math.floor(stat.mtimeMs)}`,
              });
            } catch (error) {
              logger.error('[inbox-retention] deletion notification failed:', error.message);
            }
          }
          const metadataPath = receptionMetadataPath(file);
          if (expiryMap && metadataPath && Object.prototype.hasOwnProperty.call(expiryMap, metadataPath)) {
            delete expiryMap[metadataPath];
            accountingChanged = true;
          }
        } catch (_) {}
      }
    };

    walk(INBOX_DIR);
    if (removedFiles) {
      try { noteCenterCleanup(removedFiles, removedBytes, 'inbox-retention'); }
      catch (error) { logger.error('[inbox-retention] cleanup notification failed:', error.message); }
    }
    if (accountingChanged) persist();
    if (changed) {
      try { scheduleSearchReindex(); } catch (_) {}
    }
  }

  function clampExpireSec(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(MAX_FILE_EXPIRE_SEC, parsed);
  }

  function fileExpiryMap() {
    const root = rootState();
    if (!root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta)) root.meta = {};
    if (!root.meta.fileExpiry || typeof root.meta.fileExpiry !== 'object' || Array.isArray(root.meta.fileExpiry)) root.meta.fileExpiry = {};
    const map = root.meta.fileExpiry;
    if (map !== expirySizeMap) {
      expirySizeMap = map;
      expirySize = Object.keys(map).length;
    }
    return map;
  }

  function fileExpiryTimestamp(record) {
    const value = typeof record === 'number' ? record : Number(record && record.expiresAt);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function enforceFileExpiryLimit(map) {
    if (expirySize <= FILE_EXPIRY_MAX) return;
    const now = Date.now();
    let keys = Object.keys(map);
    for (const key of keys) {
      const expiry = fileExpiryTimestamp(map[key]);
      if (!expiry || expiry <= now) delete map[key];
    }
    keys = Object.keys(map);
    if (keys.length > FILE_EXPIRY_MAX) {
      // Preserve the soonest self-destruct timers. Excess far-future timers are
      // disabled without deleting their files, keeping state growth bounded.
      keys.sort((a, b) => fileExpiryTimestamp(map[a]) - fileExpiryTimestamp(map[b]));
      for (const key of keys.slice(FILE_EXPIRY_MAX)) delete map[key];
    }
    expirySize = Object.keys(map).length;
  }

  function recordFileExpiry(absolutePath, seconds, share, name) {
    const safeSeconds = clampExpireSec(seconds);
    if (!absolutePath || safeSeconds <= 0) return;
    const map = fileExpiryMap();
    const accountId = share ? notificationAccountIdForShare(share) : null;
    const metadataPath = receptionMetadataPath(absolutePath);
    if (!metadataPath) return;
    if (!Object.prototype.hasOwnProperty.call(map, metadataPath)) expirySize += 1;
    map[metadataPath] = {
      expiresAt:Date.now() + safeSeconds * 1000,
      shareId:share && share.id || null,
      accountId:accountId || null,
      name:String(name || path.basename(absolutePath)).slice(0, 240),
    };
    enforceFileExpiryLimit(map);
    persist();
  }

  function purgeExpiredFiles() {
    const root = rootState();
    const map = root.meta && root.meta.fileExpiry;
    if (!map) return;
    if (typeof map !== 'object' || Array.isArray(map)) {
      root.meta.fileExpiry = {};
      expirySizeMap = null;
      expirySize = 0;
      persist();
      return;
    }
    const now = Date.now();
    let changed = false;
    let removedFiles = 0;
    let removedBytes = 0;
    for (const storedPath of Object.keys(map)) {
      const record = map[storedPath];
      const rawExpiry = typeof record === 'number' ? record : Number(record && record.expiresAt);
      const expiry = Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry : 0;
      const managedPath = safeManagedInboxFilePath(storedPath);
      if (!managedPath) {
        delete map[storedPath];
        changed = true;
        continue;
      }
      if (!expiry) {
        // Missing/NaN/negative expiry metadata is corrupt metadata, not a
        // destructive instruction. Remove only the timer and preserve the file.
        delete map[storedPath];
        changed = true;
        continue;
      }
      if (expiry && expiry > now) {
        try { fs.statSync(managedPath); }
        catch (error) {
          if (error && error.code === 'ENOENT') {
            delete map[storedPath];
            changed = true;
          }
        }
        continue;
      }

      let bytes = 0;
      let existed = false;
      try {
        const stat = fs.statSync(managedPath);
        bytes = Math.max(0, Number(stat.size) || 0);
        existed = stat.isFile();
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          delete map[storedPath];
          changed = true;
        }
        continue;
      }
      if (!existed) {
        delete map[storedPath];
        changed = true;
        continue;
      }
      try { fs.unlinkSync(managedPath); }
      catch (error) {
        if (error && error.code === 'ENOENT') {
          delete map[storedPath];
          changed = true;
        }
        continue;
      }

      removedFiles += 1;
      removedBytes += bytes;
      let share = null;
      try { share = releaseReceptionManagedBytes(managedPath, bytes, record && record.shareId); }
      catch (error) { logger.error('[file-expiry] reception accounting failed:', error.message); }
      try {
        if (share) {
          addShareCenterNotification(share, 'retention-file-deleted', {
            name:record && record.name || path.basename(managedPath),
            bytes,
            reason:'self-destruct',
            dedupeKey:`retention-delete:${share.id}:${crypto.createHash('sha1').update(managedPath).digest('hex').slice(0, 12)}:${expiry}`,
          });
        } else if (record && record.accountId) {
          addCenterNotification(record.accountId, 'retention-file-deleted', {
            name:record.name || path.basename(managedPath),
            bytes,
            reason:'self-destruct',
            dedupeKey:`retention-delete:${crypto.createHash('sha1').update(managedPath).digest('hex').slice(0, 12)}:${expiry}`,
          });
        }
      } catch (error) {
        logger.error('[file-expiry] deletion notification failed:', error.message);
      }
      delete map[storedPath];
      changed = true;
    }
    if (removedFiles) {
      try { noteCenterCleanup(removedFiles, removedBytes, 'file-expiry'); }
      catch (error) { logger.error('[file-expiry] cleanup notification failed:', error.message); }
    }
    if (map === expirySizeMap) expirySize = Object.keys(map).length;
    if (changed) {
      persist();
      try { scheduleSearchReindex(); } catch (_) {}
    }
  }

  function anomalyClientIp(request) {
    return String(clientIp(request) || '').replace(/^::ffff:/i, '');
  }

  function ransomwareBlocks() {
    const root = rootState();
    if (!root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta)) root.meta = {};
    if (!root.meta.ransomwareBlocks || typeof root.meta.ransomwareBlocks !== 'object' || Array.isArray(root.meta.ransomwareBlocks)) root.meta.ransomwareBlocks = {};
    return root.meta.ransomwareBlocks;
  }

  function ransomwareShareBlocks() {
    const root = rootState();
    if (!root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta)) root.meta = {};
    if (!root.meta.ransomwareShareBlocks || typeof root.meta.ransomwareShareBlocks !== 'object' || Array.isArray(root.meta.ransomwareShareBlocks)) root.meta.ransomwareShareBlocks = {};
    return root.meta.ransomwareShareBlocks;
  }

  function ransomwareShareBlocked(shareId) {
    const id = String(shareId || '');
    if (!id || getSettings().ransomwareProtection === false) return null;
    const blocks = ransomwareShareBlocks();
    return activeRansomwareRecord(blocks, id);
  }

  function ransomwareBlocked(ip) {
    const clean = String(ip || '').replace(/^::ffff:/i, '');
    if (!clean || isLoopback(clean) || getSettings().ransomwareProtection === false) return null;
    const blocks = ransomwareBlocks();
    return activeRansomwareRecord(blocks, clean);
  }

  function activeRansomwareRecord(blocks, key, now = Date.now()) {
    const record = blocks[key];
    if (!record) return null;
    const until = Number(record.until);
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || !Number.isFinite(until) || until <= now) {
      delete blocks[key];
      scheduleFlush();
      return null;
    }
    if (until > now + MAX_RANSOMWARE_BLOCK_MS) {
      record.until = now + MAX_RANSOMWARE_BLOCK_MS;
      scheduleFlush();
    } else if (record.until !== until) {
      record.until = until;
      scheduleFlush();
    }
    return record;
  }

  function suspiciousRansomwareName(name) {
    const normalized = String(name || '').toLowerCase();
    return /\.(locked|encrypted|crypted|wncry|lockbit|akira|conti|ryuk|maze|phobos|blackcat|darkside)(?:\.|$)/i.test(normalized)
      || /(?:how[_ -]?to[_ -]?decrypt|decrypt[_ -]?instructions|restore[_ -]?files|readme[_ -]?decrypt)/i.test(normalized);
  }

  function pruneAnomalyEvents(ip, now) {
    const events = anomalyWindows.get(ip) || [];
    const kept = events
      .filter((event) => event && Number.isFinite(Number(event.at)) && Number(event.at) <= now && now - Number(event.at) <= 2 * 60 * 1000)
      .slice(-(ANOMALY_EVENTS_PER_IP_MAX - 1));
    if (kept.length) anomalyWindows.set(ip, kept);
    else anomalyWindows.delete(ip);
    if (!anomalyWindows.has(ip) && anomalyWindows.size >= ANOMALY_IP_MAX) {
      const oldest = anomalyWindows.keys().next();
      if (!oldest.done) anomalyWindows.delete(oldest.value);
    }
    return kept;
  }

  function queueTrashRetentionPurge(ids) {
    if (trashPurgePromise || !Array.isArray(ids) || ids.length === 0) return trashPurgePromise;
    const epoch = maintenanceEpoch;
    const job = (async () => {
      let purged = 0;
      for (const id of ids) {
        if (epoch !== maintenanceEpoch) break;
        try {
          const record = await purgeTrashRecordById(id, null);
          if (epoch !== maintenanceEpoch) break;
          if (record) purged += 1;
        } catch (error) {
          logger.error('[maintenance] trash retention purge:', error.message);
        }
      }
      return { purged, aborted:epoch !== maintenanceEpoch };
    })();
    trashPurgePromise = job;
    void job.finally(() => {
      if (trashPurgePromise === job) trashPurgePromise = null;
    });
    return job;
  }

  function pruneExpiredRansomwareBlocks(now = Date.now()) {
    const clientBlocks = ransomwareBlocks();
    const shareBlocks = ransomwareShareBlocks();
    for (const ip of Object.keys(clientBlocks)) activeRansomwareRecord(clientBlocks, ip, now);
    for (const shareId of Object.keys(shareBlocks)) activeRansomwareRecord(shareBlocks, shareId, now);
    for (const ip of [...anomalyWindows.keys()]) pruneAnomalyEvents(ip, now);
  }

  function blockRansomwareClient(request, reason, detail, affectedShareIds) {
    const ip = anomalyClientIp(request);
    if (!ip || isLoopback(ip)) return null;
    const configuredMinutes = Math.floor(Number(getSettings().ransomwareBlockMinutes));
    const minutes = Number.isFinite(configuredMinutes) ? Math.min(1440, Math.max(1, configuredMinutes)) : 30;
    const record = {
      ip,
      at:Date.now(),
      until:Date.now() + minutes * 60000,
      reason,
      detail:String(detail || '').slice(0, 240),
    };
    const ids = [...new Set((Array.isArray(affectedShareIds) ? affectedShareIds : [])
      .map(String).filter(Boolean))];
    const affectedShares = ids.map(getById).filter((share) => acceptsUpload(share));
    if (affectedShares.length && getSettings().ransomwareSuspendLink !== false) {
      record.shareIds = affectedShares.map((share) => share.id);
      record.shareId = record.shareIds[0];
      record.shareName = String(affectedShares[0].name || affectedShares[0].id).slice(0, 160);
      for (const affected of affectedShares) {
        ransomwareShareBlocks()[affected.id] = {
          shareId:affected.id,
          shareName:String(affected.name || affected.id).slice(0, 160),
          at:record.at,
          until:record.until,
          reason,
          detail:record.detail,
          sourceIp:ip,
        };
        try {
          addShareCenterNotification(affected, 'security-anomaly', {
            severity:'critical',
            reason,
            detail:record.detail,
            ip,
            dedupeKey:`ransomware:${affected.id}:${Math.floor(record.at / 60000)}`,
          });
        } catch (error) {
          logger.error('[ransomware] link notification failed:', error.message);
        }
      }
    }
    ransomwareBlocks()[ip] = record;
    anomalyRecent.unshift(record);
    if (anomalyRecent.length > ANOMALY_RECENT_MAX) anomalyRecent.length = ANOMALY_RECENT_MAX;
    try { persistNow(); }
    catch (error) { logger.error('[ransomware] block persistence failed:', error.message); }
    try {
      logAudit('ransomware-blocked', {
        username:'security-guard',
        ip,
        detail:reason + (detail ? ': ' + detail : ''),
      });
    } catch (error) {
      logger.error('[ransomware] audit append failed:', error.message);
    }
    try {
      dispatch(
        'security',
        `${APP_NAME} — suspicious client blocked`,
        `🛡️ ${APP_NAME} — ${ip} blocked for ${minutes} min (${reason})`,
        record,
      );
    } catch (_) {}
    return record;
  }

  function runMinuteHousekeeping() {
    const now = Date.now();
    try { sessionCleanup(now); }
    catch (error) { logger.error('[maintenance] session cleanup:', error.message); }
    try { authCleanup(now); }
    catch (error) { logger.error('[maintenance] auth cleanup:', error.message); }
    try {
      for (const [ip, record] of unlockFails) {
        if (Array.isArray(record.fails)) record.fails = record.fails.filter((timestamp) => now - timestamp < FAIL_WINDOW_MS);
        if ((!record.lockUntil || now > record.lockUntil) && (!record.fails || record.fails.length === 0)) unlockFails.delete(ip);
      }
    } catch (error) { logger.error('[maintenance] unlock cleanup:', error.message); }
    try {
      for (const [ip, geo] of geoCache) {
        if (now - geo.at > GEO_TTL) geoCache.delete(ip);
      }
    } catch (error) { logger.error('[maintenance] geo cleanup:', error.message); }
    try { pruneCenterTrackers(now, true); } catch (_) {}
    Promise.resolve().then(() => runExpiredLinkLifecycle(now))
      .catch((error) => logger.error('[maintenance] expired-link lifecycle:', error.message));
    try { maybeCleanupOrphanPendingFiles(now); }
    catch (error) { logger.error('[maintenance] pending orphan scheduling:', error.message); }
    const trashDays = Math.max(0, Math.floor(Number(getSettings().trashRetentionDays) || 0));
    let trashJob = null;
    if (trashDays > 0) {
      const cutoff = now - trashDays * DAY_MS;
      try {
        const oldIds = trashItems()
          .filter((record) => record && Number(record.deletedAt || 0) > 0 && Number(record.deletedAt) < cutoff)
          .map((record) => record.id);
        trashJob = queueTrashRetentionPurge(oldIds);
      } catch (error) { logger.error('[maintenance] trash retention scan:', error.message); }
    }
    try { pruneExpiredRansomwareBlocks(now); }
    catch (error) { logger.error('[maintenance] ransomware cleanup:', error.message); }
    try { checkCenterLinkStates(); }
    catch (error) { logger.error('[notification-center] link state check failed:', error.message); }
    return trashJob;
  }

  function runHourlyHousekeeping() {
    try { checkExpiringShares(); } catch (error) { logger.error('[expiry-alert]', error.message); }
    try { maybeSendDigest(false); } catch (error) { logger.error('[digest]', error.message); }
    try { purgeOldLog(); } catch (error) { logger.error('[log-retention]', error.message); }
    try { purgeOldInbox(); } catch (error) { logger.error('[inbox-retention]', error.message); }
    try { purgeExpiredFiles(); } catch (error) { logger.error('[file-expiry]', error.message); }
    try { purgeExpiredSecrets(); } catch (error) { logger.error('[secrets]', error.message); }
    try { maybeRunScheduledBackup(); } catch (error) { logger.error('[backup]', error.message); }
  }

  function unref(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function start() {
    if (minuteTimer || startupHourlyTimer || hourlyTimer) return false;
    minuteTimer = unref(setIntervalFn(runMinuteHousekeeping, 60 * 1000));
    startupHourlyTimer = unref(setTimeoutFn(() => {
      startupHourlyTimer = null;
      runHourlyHousekeeping();
    }, 60 * 1000));
    hourlyTimer = unref(setIntervalFn(runHourlyHousekeeping, 60 * 60 * 1000));
    return true;
  }

  function stop() {
    if (minuteTimer) clearIntervalFn(minuteTimer);
    if (startupHourlyTimer) clearTimeoutFn(startupHourlyTimer);
    if (hourlyTimer) clearIntervalFn(hourlyTimer);
    minuteTimer = null;
    startupHourlyTimer = null;
    hourlyTimer = null;
  }

  function clearRuntimeAfterRestore() {
    maintenanceEpoch += 1;
    anomalyWindows.clear();
    anomalyRecent.length = 0;
    expirySizeMap = null;
    expirySize = 0;
  }

  function isStateReplacementBusy() {
    return !!trashPurgePromise;
  }

  return {
    anomalyClientIp,
    anomalyRecent,
    anomalyWindows,
    blockRansomwareClient,
    clampExpireSec,
    clearRuntimeAfterRestore,
    fileExpiryMap,
    isStateReplacementBusy,
    pruneAnomalyEvents,
    purgeExpiredFiles,
    purgeExpiredSecrets,
    purgeOldInbox,
    purgeOldLog,
    ransomwareBlocked,
    ransomwareBlocks,
    ransomwareShareBlocked,
    ransomwareShareBlocks,
    recordFileExpiry,
    runHourlyHousekeeping,
    runMinuteHousekeeping,
    start,
    stop,
    suspiciousRansomwareName,
  };
}

module.exports = { createMaintenanceService };
