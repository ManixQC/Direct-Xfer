'use strict';

function finiteMetric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dashboardDelta(current, previous) {
  const c = finiteMetric(current);
  const p = finiteMetric(previous);
  return {
    delta: c - p,
    pct: p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : (c === 0 ? 0 : null),
  };
}

function finalizeTransferPeriodMetrics(metrics) {
  const out = { ...metrics };
  for (const key of ['transfers', 'bytes', 'completed', 'interrupted', 'up', 'down', 'durationMs', 'throughputBytes']) {
    out[key] = Math.max(0, finiteMetric(out[key]));
  }
  out.successRate = out.transfers ? Math.max(0, Math.min(100, Math.round((out.completed / out.transfers) * 100))) : 0;
  out.avgBps = out.durationMs > 0 ? Math.max(0, Math.round(out.throughputBytes / (out.durationMs / 1000))) : 0;
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

/**
 * Registers dashboard, activity and transfer administration routes.
 *
 * Route modules receive domain services from the composition root. Mutable persisted
 * state is resolved per request through getState(), so backup restore cannot leave
 * handlers bound to a stale state object.
 */
function attachAdminDashboardRoutes(deps = {}) {
  const {
    APP_VERSION,
    DAY_MS,
    LOG_FILE,
    TRANSFER_STALL_MS,
    TRUST_PROXY,
    accountList,
    activeTransfers,
    adminRouter,
    auditReq,
    authService,
    byId,
    crypto,
    csvField,
    dashboardQueryOptions,
    dashboardRecordMatches,
    effectiveWebhook,
    emailConfigured,
    formatBytes,
    fs,
    getById,
    getLastEmail,
    getLastWebhook,
    getState,
    ipNameFor,
    isActive,
    listShares,
    listTransfers,
    openLiveActivityStream,
    openPresenceStream,
    ownsShare,
    path,
    persistNow,
    pwaAdminHealth,
    presenceSessionValidator,
    presenceSnapshot,
    recentActivityPayload,
    pubIp,
    readLogTailAsync,
    requestActiveTransferStop,
    requireAuditAccess,
    requireFullAdmin,
    systemHealthService,
    twoFactorEnabledFor,
    unlockFails,
  } = deps;

  if (!adminRouter || typeof adminRouter.get !== 'function') throw new TypeError('attachAdminDashboardRoutes requires adminRouter');
  if (typeof getState !== 'function') throw new TypeError('attachAdminDashboardRoutes requires getState()');
  if (!pwaAdminHealth
    || typeof pwaAdminHealth.healthPayload !== 'function'
    || typeof pwaAdminHealth.recordHealthHistory !== 'function'
    || typeof pwaAdminHealth.bucketHealthHistory !== 'function'
    || typeof pwaAdminHealth.attachHealthRoute !== 'function') {
    throw new TypeError('attachAdminDashboardRoutes requires complete pwaAdminHealth service');
  }
  const requiredSystemHealthMethods = [
    'buildGlobalStorageReport',
    'diskFreeThresholds',
    'fileCategoryOf',
    'scanReceptionStorage',
    'serverHealthDeepSnapshot',
    'serverHealthJobSummary',
    'serverHealthShareSummary',
    'serverHealthReceptionVolume',
  ];
  if (!systemHealthService || !Array.isArray(systemHealthService.FILE_CATEGORY_ORDER)
    || requiredSystemHealthMethods.some((name) => typeof systemHealthService[name] !== 'function')) {
    throw new TypeError('attachAdminDashboardRoutes requires complete systemHealthService');
  }
  const {
    FILE_CATEGORY_ORDER,
    buildGlobalStorageReport,
    diskFreeThresholds,
    fileCategoryOf,
    scanReceptionStorage,
    serverHealthDeepSnapshot,
    serverHealthJobSummary,
    serverHealthShareSummary,
    serverHealthReceptionVolume,
  } = systemHealthService;
  // Keep every health-system admin endpoint under the dashboard route boundary.
  // A failed attach is a startup wiring error: silently continuing would leave the
  // PWA health page installed but its API missing.
  if (pwaAdminHealth.attachHealthRoute(adminRouter) !== true) {
    throw new TypeError('attachAdminDashboardRoutes could not attach PWA health routes');
  }
  const state = new Proxy(Object.create(null), {
    get(_target, prop) { const current = getState(); return current ? current[prop] : undefined; },
    set(_target, prop, value) { const current = getState(); if (!current) throw new Error('admin state unavailable'); current[prop] = value; return true; },
    has(_target, prop) { const current = getState(); return !!current && prop in current; },
    ownKeys() { const current = getState(); return current ? Reflect.ownKeys(current) : []; },
    getOwnPropertyDescriptor(_target, prop) {
      const current = getState();
      if (!current || !Object.prototype.hasOwnProperty.call(current, prop)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: current[prop] };
    },
  });

  adminRouter.post('/transfers/:id/stop', (req, res) => {
    const t = activeTransfers.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not-found' });
    if (req.session.role === 'operator' && !ownsShare(req, getById(t.shareId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const stopped = requestActiveTransferStop(t);
    if (!stopped.ok) return res.status(stopped.error === 'not-found' ? 404 : stopped.error === 'not-stoppable' ? 409 : 500).json({ error:stopped.error });
    if (!stopped.alreadyRequested) auditReq(req, 'transfer-stopped', `${t.name || t.shareId || t.id} · ${t.direction || 'transfer'}`);
    res.json(stopped);
  });
  
  adminRouter.get('/stats', (req, res) => {
    const ids = Object.keys(state.stats).filter((id) => req.session.role !== 'operator' || ownsShare(req, getById(id)));
    const rows = ids.map((id) => {
      const st = state.stats[id];
      return { shareId: id, exists: byId.has(id), ...st };
    });
    rows.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    res.json({ stats: rows });
  });
  
  adminRouter.get('/activity/stream', requireAuditAccess, (req, res) => { openLiveActivityStream(res, req.session.sid, 500); });
  
  adminRouter.get('/activity/recent', requireAuditAccess, (req, res) => { res.json(recentActivityPayload(req.query.limit)); });
  
  adminRouter.get('/shares/presence', (req, res) => {
    const scope = { seeAll: req.session.role !== 'operator', accountId: req.session.accountId };
    res.json(presenceSnapshot(scope));
  });
  
  adminRouter.get('/shares/presence/stream', (req, res) => {
    const seeAll = req.session.role !== 'operator';
    const streamRoles = seeAll ? ['owner', 'admin', 'auditor'] : ['owner', 'admin', 'operator', 'auditor'];
    openPresenceStream(res, { seeAll, accountId: req.session.accountId }, presenceSessionValidator(req.session.sid, streamRoles));
  });
  
  adminRouter.get('/dashboard/live', (req, res) => {
    let allowedShareIds = null;
    if (req.session.role === 'operator') {
      const owned = listShares().filter((s) => ownsShare(req, s));
      allowedShareIds = new Set(owned.map((s) => s.id));
    }
    const transfers = listTransfers(allowedShareIds);
    res.json({ transfers, stalledCount: transfers.filter((t) => t.stalled).length, stallThresholdMs: TRANSFER_STALL_MS, generatedAt: Date.now() });
  });
  
  adminRouter.get('/server-health-dashboard', requireFullAdmin, async (req, res) => {
    const now = Date.now();
    const range = ['24h','7d','30d'].includes(String(req.query.range || '')) ? String(req.query.range) : '24h';
    const health = pwaAdminHealth.healthPayload();
    pwaAdminHealth.recordHealthHistory(false, health);
    const history = pwaAdminHealth.bucketHealthHistory(range, now);
    const transfers = listTransfers(null);
    const active = transfers.filter((t) => !t.completed && !t.finishedAt);
    const stalled = active.filter((t) => t.stalled);
    const speeds = active.map((t) => Math.max(0, Number(t.bps || t.speedBps || t.avgBps) || 0));
    let deep = null; try { deep = await serverHealthDeepSnapshot(); } catch (_) { deep = { error:'unavailable' }; }
    const shares = serverHealthShareSummary(now);
    const workload = {
      shares,
      transfers:{ active:active.length, stalled:stalled.length, aggregateBps:speeds.reduce((a,b)=>a+b,0), totalListed:transfers.length },
      connectorJobs:serverHealthJobSummary(),
    };
    const alerts = [];
    const addAlert = (severity, code, detail) => alerts.push({ severity, code, detail });
    const pct = (v) => (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
    const incomplete = [];
    const cpuPct = pct(health.cpu && health.cpu.percent), ramPct = pct(health.memory && health.memory.percent);
    const eventP95 = health.eventLoop && health.eventLoop.supported !== false ? pct(health.eventLoop.p95Ms) : null;
    if (cpuPct === null) incomplete.push('cpu');
    if (ramPct === null) incomplete.push('memory');
    if (!health.disk || pct(health.disk.percent) === null) incomplete.push('disk');
    if (health.eventLoop && health.eventLoop.supported !== false && eventP95 === null) incomplete.push('event-loop');
    if (deep && deep.error) { incomplete.push('deep'); addAlert('warning','monitoring-incomplete','deep-probes'); }
  
    if (cpuPct !== null && cpuPct >= 90) addAlert('critical','cpu-high',Math.round(cpuPct)); else if (cpuPct !== null && cpuPct >= 80) addAlert('warning','cpu-high',Math.round(cpuPct));
    if (ramPct !== null && ramPct >= 95) addAlert('critical','ram-high',Math.round(ramPct)); else if (ramPct !== null && ramPct >= 85) addAlert('warning','ram-high',Math.round(ramPct));
    if (eventP95 !== null && eventP95 >= 250) addAlert('critical','event-loop-lag',Math.round(eventP95)); else if (eventP95 !== null && eventP95 >= 100) addAlert('warning','event-loop-lag',Math.round(eventP95));
    if (stalled.length) addAlert(stalled.length >= 3 ? 'critical':'warning','stalled-transfers',stalled.length);
    if (shares.backingMissing) addAlert('warning','missing-sources',shares.backingMissing);
    if (deep && deep.security && deep.security.audit && !deep.security.audit.ok) addAlert('critical','audit-integrity',deep.security.audit.reason || 'failed');
    if (deep && deep.tls && deep.tls.diagnostics && ['bad','warn'].includes(deep.tls.diagnostics.status)) addAlert(deep.tls.diagnostics.status==='bad'?'critical':'warning','tls-health',deep.tls.diagnostics.reason || deep.tls.diagnostics.status);
    if (deep && deep.backup && deep.backup.enabled && deep.backup.last && deep.backup.last.ok === false) addAlert('warning','backup-failed',deep.backup.last.error || 'failed');
    if (deep && deep.backup && deep.backup.enabled && !deep.backup.last) addAlert('warning','backup-never','never');
    if (deep && deep.backup && deep.backup.enabled && deep.backup.last && deep.backup.last.ok !== false) {
      const maxAge = deep.backup.interval === 'weekly' ? 8 * 24 * 3600 * 1000 : 30 * 3600 * 1000;
      if (Number(deep.backup.last.at) > 0 && now - Number(deep.backup.last.at) > maxAge) addAlert('warning','backup-stale',Math.round((now-Number(deep.backup.last.at))/3600000));
    }
    if (deep && deep.connectors && deep.connectors.jobs && deep.connectors.jobs.failedRecent24h) addAlert('warning','connector-failures',deep.connectors.jobs.failedRecent24h);
    if (deep && deep.connectors && deep.connectors.configured > 0 && !(deep.connectors.capabilities && deep.connectors.capabilities.available)) addAlert('warning','connector-runtime','rclone-unavailable');
    if (deep && deep.search && deep.search.error) addAlert('warning','search-health',deep.search.error);
    if (deep && deep.storage && deep.storage.setup && (deep.storage.setup.inboxUnconfigured || deep.storage.setup.imagesUnconfigured)) addAlert('warning','storage-setup','mount-unconfigured');
  
    // Volume availability is per path, but capacity is per filesystem. Several
    // Direct-Xfer roots commonly share one physical disk; count that disk only once
    // in the global score instead of turning a single 95%-full filesystem into three
    // separate critical incidents.
    let capacityEvaluated = false;
    if (deep && deep.storage && Array.isArray(deep.storage.volumes)) {
      const capacityGroups = new Map();
      const limits = deep.storage.thresholds || diskFreeThresholds();
      for (const volume of deep.storage.volumes) {
        if (!volume) continue;
        if (volume.probing && ['probe-timeout','probe-pending'].includes(String(volume.error || ''))) {
          incomplete.push('storage:' + String(volume.label || 'volume'));
          addAlert('warning','storage-probe-timeout',volume.label || 'volume');
          if (!volume.stale) continue;
        }
        if (!volume.configured) {
          if (volume.kind === 'backup' && deep.backup && deep.backup.enabled && deep.backup.destination === 'local') addAlert('critical','backup-volume','not-configured');
          continue;
        }
        if (!volume.exists || volume.readable === false || volume.writable === false || !volume.directory) {
          const reason = !volume.exists ? 'missing' : !volume.directory ? 'not-directory' : volume.readable === false ? 'unreadable' : 'read-only';
          addAlert('critical','storage-volume',volume.label + ':' + reason);
          continue;
        }
        if (volume.symlink) addAlert('warning','storage-symlink',volume.label);
        if (!volume.disk || pct(volume.disk.percent) === null || !(Number(volume.disk.total) > 0)) continue;
        capacityEvaluated = true;
        const key = process.platform === 'win32' ? 'win:' + String(path.parse(path.resolve(volume.path || '.')).root || volume.path || volume.label).toLowerCase() : (volume.device !== null && volume.device !== undefined ? 'dev:' + String(volume.device) : 'path:' + String(volume.path || volume.label));
        const row = capacityGroups.get(key) || { labels:[], freePct:100, usedPct:0 };
        row.labels.push(volume.label); row.usedPct = Math.max(row.usedPct, pct(volume.disk.percent) || 0); row.freePct = Math.min(row.freePct, Math.max(0, 100 - (pct(volume.disk.percent) || 0)));
        capacityGroups.set(key,row);
      }
      if (Number(limits.warn) > 0) for (const row of capacityGroups.values()) {
        if (row.freePct <= Number(limits.critical)) addAlert('critical','storage-capacity',row.labels.join(',') + ':' + Math.round(row.freePct) + '% free');
        else if (row.freePct <= Number(limits.warn)) addAlert('warning','storage-capacity',row.labels.join(',') + ':' + Math.round(row.freePct) + '% free');
      }
    }
    // If the deeper filesystem probe is unavailable, retain a bounded fallback for
    // the data directory using the same configured free-space thresholds.
    if (!capacityEvaluated && health.disk && pct(health.disk.percent) !== null) {
      const limits = diskFreeThresholds(), freePct = Math.max(0, 100 - pct(health.disk.percent));
      if (Number(limits.warn) > 0 && freePct <= Number(limits.critical)) addAlert('critical','disk-high',Math.round(health.disk.percent));
      else if (Number(limits.warn) > 0 && freePct <= Number(limits.warn)) addAlert('warning','disk-high',Math.round(health.disk.percent));
    }
  
    const forwardedHeadersPresent = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded'] || req.headers['x-forwarded-proto'] || req.headers['x-forwarded-host']);
    if (forwardedHeadersPresent && !TRUST_PROXY) addAlert('warning','proxy-untrusted','forwarded-headers-not-trusted');
  
    const critical = alerts.filter((a)=>a.severity==='critical').length, warning = alerts.filter((a)=>a.severity==='warning').length;
    let score = 100 - critical*25 - warning*8;
    for (const metric of [cpuPct, ramPct, health.disk&&health.disk.percent]) { const n=pct(metric); if (n!==null && n>70) score -= Math.min(8, Math.round((n-70)/4)); }
    if (incomplete.length) score = Math.min(score, 92);
    score = Math.max(0, Math.min(100, score));
    const status = critical ? 'critical' : warning ? 'warning' : (incomplete.length || score < 90) ? 'attention' : 'healthy';
    const completeness = { complete:incomplete.length === 0, missing:[...new Set(incomplete)] };
    const edge = {
      protocol:req.protocol, secure:!!req.secure, host:req.get('host')||null,
      forwardedHeadersPresent, proxyDetected:!!(TRUST_PROXY && forwardedHeadersPresent), forwardedTrusted:!!TRUST_PROXY,
      forwardedProto:String(req.headers['x-forwarded-proto']||'').split(',')[0].trim()||null,
      forwardedHost:String(req.headers['x-forwarded-host']||'').split(',')[0].trim()||null,
      forwardedPort:String(req.headers['x-forwarded-port']||'').split(',')[0].trim()||null,
    };
    res.setHeader('Cache-Control','no-store');
    res.json({ generatedAt:now, version:APP_VERSION, status, score, completeness, health, history, workload, deep, alerts, edge });
  });
  
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
    const last24Ips = new Set();
    const last24Cutoff = now - DAY_MS;
    let last24Dur = 0, last24DurCount = 0, last24Bytes = 0;
    const recentErrors = [];
    const ips = new Set();
    const countryMap = new Map(); // code -> { country, code, flag, count, bytes }
    const clientMap = new Map();  // ip -> { down, downCount, up, upCount }
    const fileMap = new Map();    // name -> { count, bytes } (downloads)
    const fileTypeTraffic = new Map(); // broad category -> transfer traffic
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
        if (r.ip) last24Ips.add(pubIp(r.ip));
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
      const trafficCategory = fileCategoryOf(r.name || '');
      const ft = fileTypeTraffic.get(trafficCategory) || { category:trafficCategory, transfers:0, bytes:0, upBytes:0, downBytes:0, completed:0, interrupted:0 };
      ft.transfers += 1; ft.bytes += bytes; if (up) ft.upBytes += bytes; else ft.downBytes += bytes;
      if (r.completed) ft.completed += 1; else ft.interrupted += 1; fileTypeTraffic.set(trafficCategory, ft);
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
    last24h.uniqueVisitors = last24Ips.size;
    last24h.sharesCreated = (visibleShares || listShares()).filter((s) => Number(s && s.createdAt || 0) >= last24Cutoff).length;
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
      lockedIps.push(...authService.lockedLoginIps(now));
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
      const receptionVolume = await serverHealthReceptionVolume();
      if (receptionVolume && receptionVolume.disk) {
        storage = { ...receptionVolume.disk, path:receptionVolume.path };
      }
      storageAnalysis = await scanReceptionStorage();
    } catch (_) { storage = null; storageAnalysis = null; }
    let storageReport = null;
    if (!operatorScoped) { try { storageReport = await buildGlobalStorageReport(); } catch (_) { storageReport = null; } }
    const fileTypeStats = FILE_CATEGORY_ORDER.map((category) => {
      const traffic = fileTypeTraffic.get(category) || { transfers:0, bytes:0, upBytes:0, downBytes:0, completed:0, interrupted:0 };
      const stored = storageReport && Array.isArray(storageReport.fileCategories) ? storageReport.fileCategories.find((r) => r.category === category) : null;
      return { category, storageBytes:stored ? stored.bytes : 0, files:stored ? stored.count : 0, transfers:traffic.transfers || 0, trafficBytes:traffic.bytes || 0, upBytes:traffic.upBytes || 0, downBytes:traffic.downBytes || 0, completed:traffic.completed || 0, interrupted:traffic.interrupted || 0 };
    }).filter((r) => r.storageBytes || r.files || r.transfers || r.trafficBytes);
  
    // ---- Webhook status ----
    const webhook = operatorScoped ? { configured: false, restricted: true } : effectiveWebhook().url
      ? { configured: true, lastAt: getLastWebhook() ? getLastWebhook().at : null, lastOk: getLastWebhook() ? getLastWebhook().ok : null, lastError: getLastWebhook() ? getLastWebhook().error : null, lastEvent: getLastWebhook() ? getLastWebhook().event : null }
      : { configured: false };
  
    // ---- E-mail status ----
    const email = operatorScoped ? { configured: false, restricted: true } : emailConfigured()
      ? { configured: true, lastAt: getLastEmail() ? getLastEmail().at : null, lastOk: getLastEmail() ? getLastEmail().ok : null, lastError: getLastEmail() ? getLastEmail().error : null }
      : { configured: false };
  
  
    const alerts = [];
    if (storage && storage.total > 0) {
      const usedPct = Math.round((storage.used / storage.total) * 100);
      const freePct = Math.max(0, 100 - usedPct), diskLimits = diskFreeThresholds();
      if (diskLimits.warn > 0 && freePct <= diskLimits.critical) alerts.push({ level: 'critical', code: 'disk-critical', params: { pct: usedPct, free: formatBytes(storage.free) } });
      else if (diskLimits.warn > 0 && freePct <= diskLimits.warn) alerts.push({ level: 'warning', code: 'disk-warning', params: { pct: usedPct, free: formatBytes(storage.free) } });
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
      shares: sharesSnap, security, storage, storageAnalysis, storageReport, fileTypeStats, webhook, email,
      comparison, users, alerts, generatedAt: now,
    });
  });
  
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
  
  adminRouter.delete('/history', requireFullAdmin, (req, res) => {
    const removed = state.history.length;
    const previousHistory = state.history;
    const backup = `${LOG_FILE}.clear-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let hadLog = false;
    try {
      if (fs.existsSync(LOG_FILE)) { fs.renameSync(LOG_FILE, backup); hadLog = true; }
      fs.writeFileSync(LOG_FILE, '', { mode:0o600 });
    } catch (e) {
      try { if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE); } catch (_) {}
      try { if (hadLog && fs.existsSync(backup)) fs.renameSync(backup, LOG_FILE); } catch (_) {}
      console.error('[history] could not stage journal purge:', e.message);
      return res.status(500).json({ error:'write-error' });
    }
    state.history = [];
    if (!persistNow()) {
      state.history = previousHistory;
      try { if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE); } catch (_) {}
      try { if (hadLog && fs.existsSync(backup)) fs.renameSync(backup, LOG_FILE); } catch (e) { console.error('[history] journal rollback failed:', e.message); }
      return res.status(503).json({ error:'write-error' });
    }
    try { if (hadLog && fs.existsSync(backup)) fs.unlinkSync(backup); } catch (e) { console.error('[history] old journal cleanup failed:', e.message); }
    auditReq(req, 'history-cleared', removed + ' record(s)');
    res.json({ ok: true, cleared: removed });
  });
}

module.exports = { attachAdminDashboardRoutes };
