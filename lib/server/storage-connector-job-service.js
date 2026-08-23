'use strict';

/**
 * Owns storage-connector capability probes and durable import/export jobs.
 *
 * Connector inventory metadata and every mutable runtime primitive used by jobs
 * (controllers, probe cache
 * and in-flight generation) stays private to this service. Persisted job state
 * is always resolved through getState(), so a transactional restore cannot leave
 * the service bound to the previous root object.
 */
function createStorageConnectorJobService(deps = {}) {
  const {
    storageConnectorService,
    connectorStartupCleanup = Promise.resolve(true),
    maxActiveJobs = 4,
    probeCacheMs = 15000,
    configurationProbeWaitMs = 4000,
    jobRetentionMs = 30 * 86400000,
    maxPersistedJobs = 200,
    INBOX_DIR,
    IMAGE_STORE_DIR,
    HOST_ROOT,
    getState,
    trashItems = () => [],
    persist,
    persistNow,
    scheduleFlush,
    crypto,
    path,
    withinRoot,
    assertRealWithin,
    hostToContainer,
    clientIp,
    cleanConnectorPath,
    clamavEnabled,
    scanFile,
    quarantineFile,
    connectorErrorCode,
    logAudit,
    getAccountById,
    scheduleSearchReindex,
    defer = setImmediate,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = Date.now,
    logger = console,
    AbortControllerClass = globalThis.AbortController,
  } = deps;

  if (!storageConnectorService
    || typeof storageConnectorService.capabilities !== 'function'
    || typeof storageConnectorService.configuredRemotes !== 'function'
    || typeof storageConnectorService.importFile !== 'function'
    || typeof storageConnectorService.exportFile !== 'function') {
    throw new TypeError('storage-connector-job-service requires storageConnectorService');
  }
  for (const [name, dependency] of Object.entries({
    getState,
    persist,
    persistNow,
    scheduleFlush,
    withinRoot,
    assertRealWithin,
    hostToContainer,
    clientIp,
    cleanConnectorPath,
    clamavEnabled,
    scanFile,
    quarantineFile,
    connectorErrorCode,
    logAudit,
    getAccountById,
    scheduleSearchReindex,
    defer,
    setTimeoutFn,
    clearTimeoutFn,
    now,
  })) {
    if (typeof dependency !== 'function') throw new TypeError(`storage-connector-job-service requires ${name}()`);
  }
  if (!crypto || typeof crypto.randomBytes !== 'function') throw new TypeError('storage-connector-job-service requires crypto');
  if (!path || typeof path.resolve !== 'function' || !path.posix) throw new TypeError('storage-connector-job-service requires path');
  if (typeof AbortControllerClass !== 'function') throw new TypeError('storage-connector-job-service requires AbortController');
  for (const [name, value] of Object.entries({ INBOX_DIR, IMAGE_STORE_DIR, HOST_ROOT })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`storage-connector-job-service requires ${name}`);
  }

  const boundedInteger = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback;
  };
  const activeLimit = boundedInteger(maxActiveJobs, 4, 1, 64);
  const probeCacheDuration = boundedInteger(probeCacheMs, 15000, 0, 10 * 60 * 1000);
  const configurationWait = boundedInteger(configurationProbeWaitMs, 4000, 100, 30000);
  const retentionDuration = boundedInteger(jobRetentionMs, 30 * 86400000, 60000, 365 * 86400000);
  const persistedJobLimit = boundedInteger(maxPersistedJobs, 200, 10, 2000);

  let probeEpoch = 0;
  let probeCache = { at:0, value:null, pending:null };
  const activeJobs = new Map(); // job id -> { controller, connectorId }


  function connectorStore() {
    const state = getState();
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('connector-state-invalid');
    if (state.meta == null) state.meta = {};
    else if (typeof state.meta !== 'object' || Array.isArray(state.meta)) throw new TypeError('connector-meta-invalid');
    if (state.meta.storageConnectors == null) state.meta.storageConnectors = [];
    else if (!Array.isArray(state.meta.storageConnectors)) throw new TypeError('connector-store-invalid');
    return state.meta.storageConnectors;
  }

  function connectorSafeText(value, max) {
    let text = '';
    try { text = value == null ? '' : String(value); } catch (_) { return ''; }
    return text.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  }
  function connectorTime(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed)) : 0;
  }
  function connectorReadOnly(value) {
    if (value == null) return false;
    if (value === true || value === false) return value;
    return true; // unknown restored values fail safe: never grant writes
  }
  function publicConnector(connector) {
    if (!connector || typeof connector !== 'object' || Array.isArray(connector)) return null;
    const id = connectorSafeText(connector.id, 128);
    const name = connectorSafeText(connector.name, 80);
    const type = connectorSafeText(connector.type, 40);
    const remote = connectorSafeText(connector.remote, 64);
    if (!id || !name || !type || !remote) return null;
    return {
      id, name, type, remote,
      root:connectorSafeText(connector.root, 4096), readOnly:connectorReadOnly(connector.readOnly),
      createdAt:connectorTime(connector.createdAt), updatedAt:connectorTime(connector.updatedAt),
    };
  }

  function getStorageConnector(id) {
    const wanted = connectorSafeText(id, 128);
    if (!wanted) return null;
    return connectorStore().find((item) => item && typeof item === 'object' && !Array.isArray(item) && connectorSafeText(item.id, 128) === wanted) || null;
  }

  function webStorageShareReferencesConnector(connectorId) {
    const id = connectorSafeText(connectorId, 128);
    if (!id) return [];
    const refs = [];
    const seen = new Set();
    const add = (share, trashed) => {
      if (!share || typeof share !== 'object' || Array.isArray(share)) return;
      const webStorage = share.webStorage;
      if (!webStorage || typeof webStorage !== 'object' || Array.isArray(webStorage)) return;
      if (connectorSafeText(webStorage.connectorId, 128) !== id) return;
      const shareId = connectorSafeText(share.id, 128);
      const key = `${trashed ? 'trash' : 'live'}:${shareId || connectorSafeText(share.token, 128)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const type = connectorSafeText(share.type, 40);
      refs.push({
        id:shareId, name:connectorSafeText(share.name, 200), type,
        writable:share.type === 'inbox' || share.type === 'collab', trashed:!!trashed,
      });
    };
    const state = getState();
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('connector-state-invalid');
    if (state.shares != null && !Array.isArray(state.shares)) throw new TypeError('connector-share-index-invalid');
    for (const share of (state.shares || [])) add(share, false);
    const trash = trashItems();
    if (!Array.isArray(trash)) throw new TypeError('connector-trash-index-invalid');
    for (const record of trash) add(record && record.share, true);
    return refs;
  }

  function stableConnectorCode(error, fallback = 'connector-failed') {
    try {
      const code = String(connectorErrorCode(error) || '').trim();
      if (/^[a-z][a-z0-9-]{1,79}$/.test(code)) return code;
    } catch (_) {}
    const direct = String(error && error.code || '').trim();
    return /^[a-z][a-z0-9-]{1,79}$/.test(direct) ? direct : fallback;
  }

  function safeScheduleFlush() {
    try {
      const scheduled = scheduleFlush();
      if (scheduled && typeof scheduled.catch === 'function') scheduled.catch(() => {});
    } catch (_) {}
  }

  function safePersist() {
    try {
      const pending = persist();
      if (pending && typeof pending.catch === 'function') pending.catch(() => safeScheduleFlush());
      return pending !== false;
    } catch (_) {
      return false;
    }
  }

  function safePersistNow() {
    try { return persistNow() === true; } catch (_) { return false; }
  }

  function safeAudit(action, job, connector, detail) {
    try {
      const pending = logAudit(action, {
        username:job.actor || 'system',
        account:job.actorId ? getAccountById(job.actorId) : null,
        ip:job.ip,
        detail:`${connector.name}: ${detail}`,
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (_) {}
  }

  function finiteNonnegative(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function invalidateProbe() {
    probeEpoch += 1;
    probeCache = { at:0, value:null, pending:null };
  }

  function probeFallback() {
    return probeCache.value || {
      capabilities:{ available:false, error:null, pending:true },
      remotes:[],
    };
  }

  async function probeSnapshot() {
    const observedAt = now();
    if (probeCache.value && observedAt - probeCache.at < probeCacheDuration) return probeCache.value;
    if (probeCache.pending) return probeCache.pending;
    const epoch = probeEpoch;
    const pending = (async () => {
      let capabilities;
      let remotes = [];
      try {
        capabilities = await storageConnectorService.capabilities();
        if (!capabilities || typeof capabilities !== 'object') {
          capabilities = { available:false, error:'rclone-unavailable' };
        }
        if (capabilities.available) {
          try {
            const configured = await storageConnectorService.configuredRemotes();
            remotes = Array.isArray(configured) ? configured : [];
          } catch (error) {
            capabilities = { ...capabilities, remotesError:stableConnectorCode(error, 'remote-list-failed') };
          }
        }
      } catch (error) {
        capabilities = { available:false, error:stableConnectorCode(error, 'rclone-unavailable') };
        remotes = [];
      }
      const value = { capabilities, remotes };
      if (epoch === probeEpoch) probeCache = { at:now(), value, pending:null };
      return epoch === probeEpoch ? value : null;
    })();
    probeCache.pending = pending;
    try {
      const value = await pending;
      if (value) return value;
      return probeSnapshot();
    } finally {
      if (probeCache.pending === pending) probeCache.pending = null;
    }
  }

  async function probeForConfiguration() {
    const probePromise = probeSnapshot();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeoutFn(() => resolve(null), configurationWait);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    try {
      const value = await Promise.race([probePromise, timeout]);
      if (value) return value;
      probePromise.catch(() => {});
      return probeFallback();
    } finally {
      if (timer) clearTimeoutFn(timer);
    }
  }

  function jobStore() {
    const state = getState();
    if (!state || typeof state !== 'object') throw new Error('connector-state-unavailable');
    if (!state.meta || typeof state.meta !== 'object') state.meta = {};
    if (!Array.isArray(state.meta.storageConnectorJobs)) state.meta.storageConnectorJobs = [];
    return state.meta.storageConnectorJobs;
  }

  function snapshotJobJournal() {
    const jobs = jobStore();
    return {
      jobs:jobs.slice(),
      entries:jobs
        .filter((job) => job && typeof job === 'object')
        .map((job) => ({ job, snapshot:{ ...job } })),
    };
  }

  function restoreJobJournal(journal) {
    if (!journal || !Array.isArray(journal.jobs)) return;
    for (const entry of journal.entries || []) {
      const job = entry && entry.job;
      const snapshot = entry && entry.snapshot;
      if (!job || typeof job !== 'object' || !snapshot || typeof snapshot !== 'object') continue;
      try {
        for (const key of Object.keys(job)) {
          if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete job[key];
        }
        Object.assign(job, snapshot);
      } catch (_) {}
    }
    const state = getState();
    if (!state || typeof state !== 'object') return;
    if (!state.meta || typeof state.meta !== 'object') state.meta = {};
    state.meta.storageConnectorJobs = journal.jobs;
  }

  function publicJob(job) {
    if (!job || typeof job !== 'object') return null;
    return {
      id:String(job.id || '').slice(0, 128),
      connectorId:String(job.connectorId || '').slice(0, 128),
      connectorName:String(job.connectorName || '').slice(0, 160),
      direction:job.direction === 'export' ? 'export' : 'import',
      status:['queued','running','completed','failed','cancelled'].includes(job.status) ? job.status : 'failed',
      sourceName:String(job.sourceName || '').slice(0, 260),
      targetName:String(job.targetName || '').slice(0, 260),
      size:finiteNonnegative(job.size),
      createdAt:finiteNonnegative(job.createdAt),
      startedAt:finiteNonnegative(job.startedAt) || null,
      finishedAt:finiteNonnegative(job.finishedAt) || null,
      error:job.error ? String(job.error).slice(0, 120) : null,
    };
  }

  function pruneJobs(options = {}) {
    const jobs = jobStore();
    const keepAfter = now() - retentionDuration;
    let changed = false;
    for (const job of jobs) {
      if (job && ['queued','running'].includes(job.status) && !activeJobs.has(job.id)) {
        job.status = 'failed';
        job.error = 'server-restarted';
        job.finishedAt = now();
        changed = true;
      }
    }
    const activeEntries = jobs.reduce(
      (count, job) => count + (job && activeJobs.has(job.id) ? 1 : 0),
      0,
    );
    let inactiveBudget = Math.max(0, persistedJobLimit - activeEntries);
    const kept = jobs.filter((job) => {
      if (!job) return false;
      if (activeJobs.has(job.id)) return true;
      const createdAt = Number(job.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < keepAfter || inactiveBudget <= 0) return false;
      inactiveBudget -= 1;
      return true;
    });
    if (kept.length !== jobs.length) {
      const state = getState();
      state.meta.storageConnectorJobs = kept;
      changed = true;
    }
    if (changed && options.schedule !== false) safeScheduleFlush();
    return getState().meta.storageConnectorJobs;
  }

  async function exportSource(raw) {
    const value = String(raw || '').trim();
    if (!value || value.includes('\0')) throw Object.assign(new Error('invalid-source'), { code:'invalid-source' });
    const resolved = path.resolve(value);
    if (withinRoot(INBOX_DIR, resolved)) {
      const segments = path.relative(INBOX_DIR, resolved).split(path.sep).filter(Boolean);
      if (segments.some((segment) => segment.toLowerCase().startsWith('.dx'))) {
        throw Object.assign(new Error('invalid-source'), { code:'invalid-source' });
      }
      return assertRealWithin(INBOX_DIR, resolved);
    }
    if (withinRoot(IMAGE_STORE_DIR, resolved)) return assertRealWithin(IMAGE_STORE_DIR, resolved);
    return assertRealWithin(HOST_ROOT, hostToContainer(value));
  }

  async function runJob(job, connector, direction, input, entry, jobRequest) {
    const { controller } = entry;
    try {
      if (controller.signal.aborted) throw Object.assign(new Error('connector-cancelled'), { code:'connector-cancelled' });
      job.status = 'running';
      job.startedAt = now();
      if (!safePersist()) throw Object.assign(new Error('write-error'), { code:'write-error' });
      const startupReady = await Promise.resolve(connectorStartupCleanup).catch(() => false);
      if (!startupReady) {
        throw Object.assign(new Error('connector-staging-unavailable'), { code:'connector-staging-unavailable' });
      }

      let result;
      if (direction === 'import') {
        const remotePath = cleanConnectorPath(input.remotePath, false);
        if (remotePath === null) throw Object.assign(new Error('invalid-remote-path'), { code:'invalid-source' });
        const target = cleanConnectorPath(input.target || path.posix.basename(remotePath), false);
        if (target === null) throw Object.assign(new Error('invalid-local-path'), { code:'invalid-source' });
        result = await storageConnectorService.importFile(connector, remotePath, target, {
          signal:controller.signal,
          beforePublish:clamavEnabled() ? async (temporary) => {
            const scan = await scanFile(temporary);
            if (scan.infected) {
              await quarantineFile(
                temporary,
                path.basename(target),
                { id:`connector:${connector.id}`, name:connector.name },
                scan.virus,
                jobRequest,
              );
              throw Object.assign(new Error('infected'), { code:'infected' });
            }
            if (scan.error && logger && typeof logger.warn === 'function') {
              try { logger.warn('[connector] ClamAV scan error; import retained:', scan.error); } catch (_) {}
            }
          } : null,
        });
        job.sourceName = path.posix.basename(remotePath);
        job.targetName = path.basename(result.target);
      } else {
        const local = await exportSource(input.source);
        const remotePath = cleanConnectorPath(input.remotePath || path.basename(local), false);
        if (remotePath === null) throw Object.assign(new Error('invalid-remote-path'), { code:'invalid-source' });
        result = await storageConnectorService.exportFile(connector, local, remotePath, { signal:controller.signal });
        job.sourceName = path.basename(local);
        job.targetName = path.posix.basename(remotePath);
      }

      job.size = finiteNonnegative(result && result.size);
      job.status = 'completed';
      job.error = null;
      safeAudit(`storage-connector-${direction}`, job, connector, `${job.sourceName} -> ${job.targetName} (${job.size} bytes)`);
      try {
        const scheduled = scheduleSearchReindex();
        if (scheduled && typeof scheduled.catch === 'function') scheduled.catch(() => {});
      } catch (_) {}
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = stableConnectorCode(error);
      safeAudit(`storage-connector-${job.status}`, job, connector, `${direction}; ${job.error}`);
    } finally {
      job.finishedAt = now();
      if (activeJobs.get(job.id) === entry) activeJobs.delete(job.id);
      try { pruneJobs({ schedule:false }); } catch (_) {}
      if (!safePersistNow()) safeScheduleFlush();
    }
  }

  function queueJob(req, connector, direction, rawInput) {
    if (direction !== 'import' && direction !== 'export') {
      throw Object.assign(new Error('invalid-direction'), { code:'invalid-job' });
    }
    if (!connector || typeof connector !== 'object' || !connector.id) {
      throw Object.assign(new Error('invalid-connector'), { code:'invalid-job' });
    }
    if (direction === 'export' && connector.readOnly) {
      throw Object.assign(new Error('read-only'), { code:'read-only' });
    }
    if (activeJobs.size >= activeLimit) {
      throw Object.assign(new Error('too-many-connector-jobs'), { code:'connector-capacity' });
    }

    const input = rawInput && typeof rawInput === 'object' ? { ...rawInput } : {};
    const controller = new AbortControllerClass();
    const jobConnector = Object.freeze({ ...connector });
    let requestIp = null;
    try { requestIp = clientIp(req); } catch (_) {}
    const jobRequest = { socket:{ remoteAddress:requestIp } };
    const session = req && req.session && typeof req.session === 'object' ? req.session : {};
    const job = {
      id:crypto.randomBytes(16).toString('hex'),
      connectorId:jobConnector.id,
      connectorName:jobConnector.name,
      direction,
      status:'queued',
      sourceName:path.basename(String(input.source || input.remotePath || '')),
      targetName:path.basename(String(input.target || input.remotePath || '')),
      size:0,
      createdAt:now(),
      startedAt:0,
      finishedAt:0,
      error:null,
      actorId:session.accountId || null,
      actor:session.username || null,
      ip:requestIp,
    };
    const entry = { controller, connectorId:String(jobConnector.id) };
    const previousJournal = snapshotJobJournal();
    activeJobs.set(job.id, entry);
    try {
      jobStore().unshift(job);
      pruneJobs({ schedule:false });
    } catch (error) {
      activeJobs.delete(job.id);
      restoreJobJournal(previousJournal);
      throw error;
    }
    if (!safePersistNow()) {
      activeJobs.delete(job.id);
      restoreJobJournal(previousJournal);
      throw Object.assign(new Error('write-error'), { code:'write-error' });
    }

    try {
      defer(() => {
        void runJob(job, jobConnector, direction, input, entry, jobRequest).catch((error) => {
          if (logger && typeof logger.error === 'function') {
            try { logger.error('[connector] unexpected job failure:', stableConnectorCode(error)); } catch (_) {}
          }
        });
      });
    } catch (_) {
      activeJobs.delete(job.id);
      job.status = 'failed';
      job.error = 'connector-queue-failed';
      job.finishedAt = now();
      if (!safePersistNow()) safeScheduleFlush();
      throw Object.assign(new Error('connector-queue-failed'), { code:'connector-queue-failed' });
    }
    return job;
  }

  function activeCount() {
    return activeJobs.size;
  }

  function isConnectorBusy(connectorId) {
    const id = String(connectorId || '');
    for (const entry of activeJobs.values()) if (entry.connectorId === id) return true;
    return false;
  }

  function cancelJob(id) {
    const entry = activeJobs.get(String(id || ''));
    if (!entry) return false;
    try { entry.controller.abort(); } catch (_) { return false; }
    return true;
  }

  function abortAll() {
    let aborted = 0;
    for (const entry of activeJobs.values()) {
      try { entry.controller.abort(); aborted += 1; } catch (_) {}
    }
    return aborted;
  }

  async function waitForIdle(timeoutMs = 600) {
    const timeout = boundedInteger(timeoutMs, 600, 0, 30000);
    const deadline = Date.now() + timeout;
    while (activeJobs.size && Date.now() < deadline) {
      await new Promise((resolve) => setTimeoutFn(resolve, Math.min(40, Math.max(1, deadline - Date.now()))));
    }
    return activeJobs.size === 0;
  }

  function isBusyForStateReplacement() {
    return activeJobs.size > 0;
  }

  function clearRuntimeAfterRestore() {
    if (activeJobs.size) {
      abortAll();
      throw Object.assign(new Error('connector-jobs-active-during-restore'), { code:'CONNECTOR_JOBS_ACTIVE' });
    }
    invalidateProbe();
    pruneJobs();
  }

  return Object.freeze({
    maxActive:activeLimit,
    connectorStore,
    publicConnector,
    getStorageConnector,
    webStorageShareReferencesConnector,
    invalidateProbe,
    probeSnapshot,
    probeForConfiguration,
    jobStore,
    publicJob,
    pruneJobs,
    exportSource,
    queueJob,
    activeCount,
    isConnectorBusy,
    cancelJob,
    abortAll,
    waitForIdle,
    isBusyForStateReplacement,
    clearRuntimeAfterRestore,
  });
}

module.exports = { createStorageConnectorJobService };
