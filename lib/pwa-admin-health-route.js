'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const HISTORY_SAMPLE_MS = 5 * 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_POINTS = Math.ceil(HISTORY_RETENTION_MS / HISTORY_SAMPLE_MS) + 24;
const HISTORY_RANGES = Object.freeze({
  '24h': { windowMs: 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 },
  '7d': { windowMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
  '30d': { windowMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 2 * 60 * 60 * 1000 },
});

let previousCpu = cpuSnapshot();
let previousCpuAt = Date.now();
let lastCpuPercent = null;
let historyLoaded = false;
let healthHistory = [];
let historyTimer = null;
let processCpuPrevious = process.cpuUsage ? process.cpuUsage() : { user:0, system:0 };
let processCpuAt = process.hrtime.bigint ? process.hrtime.bigint() : BigInt(Date.now()) * 1000000n;
let lastProcessCpuPercent = null;
let eventLoopHistogram = null;
let eventLoopWindowAt = process.hrtime.bigint ? process.hrtime.bigint() : BigInt(Date.now()) * 1000000n;
let lastEventLoopSnapshot = null;
const EVENT_LOOP_SAMPLE_MIN_MS = 1000;
try { eventLoopHistogram = monitorEventLoopDelay({ resolution:20 }); eventLoopHistogram.enable(); } catch (_) {}

function cpuSnapshot() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = (cpu && cpu.times) || {};
    const values = [times.user, times.nice, times.sys, times.idle, times.irq];
    for (const value of values) total += Math.max(0, Number(value) || 0);
    idle += Math.max(0, Number(times.idle) || 0);
  }
  return { idle, total, count: cpus.length };
}

function cpuUsagePercent() {
  const current = cpuSnapshot();
  const now = Date.now();
  const elapsed = now - previousCpuAt;
  if (elapsed < 250) return lastCpuPercent;

  const before = previousCpu;
  const totalDelta = current.total - before.total;
  const idleDelta = current.idle - before.idle;
  previousCpu = current;
  previousCpuAt = now;
  if (!(totalDelta > 0)) return lastCpuPercent;

  lastCpuPercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  return lastCpuPercent;
}


function processCpuPercent() {
  if (!process.cpuUsage || !process.hrtime || !process.hrtime.bigint) return lastProcessCpuPercent;
  const now = process.hrtime.bigint();
  const elapsedUs = Number(now - processCpuAt) / 1000;
  if (!(elapsedUs >= 250000)) return lastProcessCpuPercent;
  const current = process.cpuUsage();
  const usedUs = Math.max(0, (Number(current.user) || 0) - (Number(processCpuPrevious.user) || 0)) +
    Math.max(0, (Number(current.system) || 0) - (Number(processCpuPrevious.system) || 0));
  processCpuPrevious = current;
  processCpuAt = now;
  const cores = Math.max(1, (os.cpus() || []).length);
  lastProcessCpuPercent = Math.max(0, Math.min(100, (usedUs / elapsedUs / cores) * 100));
  return lastProcessCpuPercent;
}

function eventLoopSnapshot() {
  if (!eventLoopHistogram) return { supported:false, meanMs:null, p95Ms:null, p99Ms:null, maxMs:null, windowMs:0 };
  const now = process.hrtime.bigint ? process.hrtime.bigint() : BigInt(Date.now()) * 1000000n;
  const elapsedMs = Math.max(0, Number(now - eventLoopWindowAt) / 1e6);
  // monitorEventLoopDelay() returns near-zero/NaN values immediately after a
  // reset. Multiple consumers (PWA, history sampler, standard dashboard) can
  // read health almost simultaneously, so never reset the histogram until a
  // meaningful observation window has elapsed. Reuse the last complete sample
  // instead of turning a real lag spike into a misleading 0 ms reading.
  if (elapsedMs < EVENT_LOOP_SAMPLE_MIN_MS) {
    return lastEventLoopSnapshot ? { ...lastEventLoopSnapshot, cached:true } : {
      supported:true, meanMs:null, p95Ms:null, p99Ms:null, maxMs:null, windowMs:Math.round(elapsedMs), warming:true,
    };
  }
  const toMs = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) / 1e6 : null;
  try {
    const out = {
      supported:true,
      meanMs:toMs(eventLoopHistogram.mean),
      p95Ms:toMs(eventLoopHistogram.percentile(95)),
      p99Ms:toMs(eventLoopHistogram.percentile(99)),
      maxMs:toMs(eventLoopHistogram.max),
      windowMs:Math.round(elapsedMs),
    };
    // Only commit/reset when the histogram actually contains data.
    if ([out.meanMs, out.p95Ms, out.p99Ms, out.maxMs].some((v) => v !== null)) {
      lastEventLoopSnapshot = out;
      eventLoopHistogram.reset();
      eventLoopWindowAt = now;
      return out;
    }
    return lastEventLoopSnapshot ? { ...lastEventLoopSnapshot, cached:true } : { ...out, warming:true };
  } catch (_) {
    return lastEventLoopSnapshot ? { ...lastEventLoopSnapshot, cached:true } : { supported:false, meanMs:null, p95Ms:null, p99Ms:null, maxMs:null, windowMs:0 };
  }
}

function dataDirectory() {
  const configured = String(process.env.DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);
  const mainFile = require.main && require.main.filename ? require.main.filename : '';
  return path.join(mainFile ? path.dirname(mainFile) : process.cwd(), 'data');
}

function diskSnapshot() {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    let target = dataDirectory();
    while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
    const stat = fs.statfsSync(target);
    const blockSize = Math.max(0, Number(stat.bsize) || 0);
    const total = Math.max(0, Number(stat.blocks) || 0) * blockSize;
    const free = Math.max(0, Number(stat.bavail) || 0) * blockSize;
    return {
      total,
      free,
      used: Math.max(0, total - free),
      percent: total > 0 ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : null,
    };
  } catch (_) {
    return null;
  }
}

function safeLoadAverage() {
  const supported = process.platform !== 'win32';
  let values = [0, 0, 0];
  if (supported) {
    try { values = os.loadavg(); } catch (_) {}
  }
  const count = Math.max(1, (os.cpus() || []).length);
  return {
    supported,
    one: Math.max(0, Number(values[0]) || 0),
    five: Math.max(0, Number(values[1]) || 0),
    fifteen: Math.max(0, Number(values[2]) || 0),
    normalizedOnePercent: supported
      ? Math.max(0, Math.min(1000, ((Number(values[0]) || 0) / count) * 100))
      : null,
  };
}

function healthPayload() {
  const totalMemory = Math.max(0, Number(os.totalmem()) || 0);
  const freeMemory = Math.max(0, Number(os.freemem()) || 0);
  const processMemory = process.memoryUsage ? process.memoryUsage() : {};
  return {
    generatedAt: Date.now(),
    cpu: {
      percent: cpuUsagePercent(),
      count: Math.max(1, (os.cpus() || []).length),
    },
    memory: {
      total: totalMemory,
      free: freeMemory,
      used: Math.max(0, totalMemory - freeMemory),
      percent: totalMemory > 0 ? Math.max(0, Math.min(100, ((totalMemory - freeMemory) / totalMemory) * 100)) : null,
      processRss: Math.max(0, Number(processMemory.rss) || 0),
      processHeapUsed: Math.max(0, Number(processMemory.heapUsed) || 0),
      processHeapTotal: Math.max(0, Number(processMemory.heapTotal) || 0),
      processExternal: Math.max(0, Number(processMemory.external) || 0),
      processArrayBuffers: Math.max(0, Number(processMemory.arrayBuffers) || 0),
    },
    disk: diskSnapshot(),
    uptime: {
      processSeconds: Math.max(0, Math.round(process.uptime())),
      systemSeconds: Math.max(0, Math.round(os.uptime())),
    },
    load: safeLoadAverage(),
    process: {
      cpuPercent: processCpuPercent(),
      pid: process.pid,
    },
    eventLoop: eventLoopSnapshot(),
  };
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function historyFilePath() {
  return path.join(dataDirectory(), 'pwa-admin-health-history.json');
}

function clampMetric(value, max = 100) {
  const n = finiteOrNull(value);
  return n === null ? null : Math.max(0, Math.min(max, n));
}

function normalizeHistoryPoint(point) {
  if (!point || typeof point !== 'object') return null;
  const at = Math.floor(Number(point.at));
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    at,
    cpu: clampMetric(point.cpu),
    ram: clampMetric(point.ram),
    disk: clampMetric(point.disk),
    load: clampMetric(point.load, 1000),
    processRss: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(point.processRss) || 0)),
  };
}

function pruneHealthHistory(now = Date.now()) {
  const cutoff = now - HISTORY_RETENTION_MS;
  healthHistory = healthHistory
    .map(normalizeHistoryPoint)
    .filter((point) => point && point.at >= cutoff && point.at <= now + HISTORY_SAMPLE_MS)
    .sort((a, b) => a.at - b.at)
    .slice(-HISTORY_MAX_POINTS);
  return healthHistory;
}

const HISTORY_FILE_MAX_BYTES = 4 * 1024 * 1024;

function loadHealthHistory() {
  if (historyLoaded) return healthHistory;
  historyLoaded = true;
  const file = historyFilePath();
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('history file is not a regular file');
    if (st.size <= 0 || st.size > HISTORY_FILE_MAX_BYTES) throw new Error('history file has an invalid size');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    healthHistory = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.points) ? raw.points : []);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') console.warn('[health-history] read failed:', error && error.message || error);
    healthHistory = [];
  }
  return pruneHealthHistory();
}

function saveHealthHistory() {
  const dir = dataDirectory();
  const file = historyFilePath();
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2);
  const backup = file + '.previous';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ version: 1, sampleMs: HISTORY_SAMPLE_MS, retentionMs: HISTORY_RETENTION_MS, points: healthHistory });
    if (Buffer.byteLength(payload, 'utf8') > HISTORY_FILE_MAX_BYTES) throw new Error('history payload exceeds size limit');
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(tmp, file); }
    catch (renameError) {
      // Some Windows filesystems/AV filters do not allow an atomic replace. Keep
      // the previous file recoverable instead of deleting it before the retry.
      let backedUp = false;
      try {
        if (fs.existsSync(file)) {
          try { fs.unlinkSync(backup); } catch (_) {}
          fs.renameSync(file, backup);
          backedUp = true;
        }
        fs.renameSync(tmp, file);
        if (backedUp) { try { fs.unlinkSync(backup); } catch (_) {} }
      } catch (fallbackError) {
        if (backedUp && !fs.existsSync(file) && fs.existsSync(backup)) {
          try { fs.renameSync(backup, file); } catch (_) {}
        }
        throw fallbackError;
      }
    }
    return true;
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.warn('[health-history] write failed:', error && error.message || error);
    return false;
  }
}

function historyPointFromHealth(health) {
  return normalizeHistoryPoint({
    at: health && health.generatedAt || Date.now(),
    cpu: health && health.cpu && health.cpu.percent,
    ram: health && health.memory && health.memory.percent,
    disk: health && health.disk && health.disk.percent,
    load: health && health.load && health.load.supported !== false ? health.load.normalizedOnePercent : null,
    processRss: health && health.memory && health.memory.processRss,
  });
}

function recordHealthHistory(force = false, providedHealth = null) {
  loadHealthHistory();
  const now = Date.now();
  // Re-prune before inspecting the last point so a backward system-clock change
  // cannot leave a future timestamp suppressing samples for hours or days.
  pruneHealthHistory(now);
  const last = healthHistory.length ? healthHistory[healthHistory.length - 1] : null;
  if (!force && last && now - last.at < HISTORY_SAMPLE_MS * 0.9) return last;
  const point = historyPointFromHealth(providedHealth || healthPayload());
  if (!point) return null;
  healthHistory.push(point);
  pruneHealthHistory(now);
  saveHealthHistory();
  return point;
}

function startHistorySampler() {
  if (historyTimer) return historyTimer;
  loadHealthHistory();
  recordHealthHistory(false);
  historyTimer = setInterval(() => recordHealthHistory(false), HISTORY_SAMPLE_MS);
  if (historyTimer && typeof historyTimer.unref === 'function') historyTimer.unref();
  return historyTimer;
}

function stopHistorySampler() {
  if (historyTimer) clearInterval(historyTimer);
  historyTimer = null;
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function bucketHealthHistory(range = '24h', now = Date.now()) {
  loadHealthHistory();
  const key = Object.prototype.hasOwnProperty.call(HISTORY_RANGES, range) ? range : '24h';
  const spec = HISTORY_RANGES[key];
  const cutoff = now - spec.windowMs;
  const buckets = new Map();
  for (const point of healthHistory) {
    if (!point || point.at < cutoff || point.at > now + HISTORY_SAMPLE_MS) continue;
    const bucketAt = Math.floor(point.at / spec.bucketMs) * spec.bucketMs;
    if (!buckets.has(bucketAt)) buckets.set(bucketAt, []);
    buckets.get(bucketAt).push(point);
  }
  const points = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([at, rows]) => ({
    at,
    samples: rows.length,
    cpu: average(rows.map((row) => row.cpu)),
    ram: average(rows.map((row) => row.ram)),
    disk: average(rows.map((row) => row.disk)),
    load: average(rows.map((row) => row.load)),
    processRss: average(rows.map((row) => row.processRss)),
  }));
  return { range: key, windowMs: spec.windowMs, bucketMs: spec.bucketMs, points };
}

function adminRole(req) {
  const role = req && req.session && req.session.role;
  return role === 'owner' || role === 'admin';
}

function attachHealthRoute(router) {
  if (!router || typeof router.get !== 'function' || typeof router.use !== 'function') return false;
  if (router.__dxPwaAdminHealthRoute) return true;
  Object.defineProperty(router, '__dxPwaAdminHealthRoute', { value: true, configurable: false });
  startHistorySampler();

  router.get('/pwa-admin-health/history', (req, res) => {
    if (!adminRole(req)) return res.status(403).json({ error: 'admin-required' });
    const range = Object.prototype.hasOwnProperty.call(HISTORY_RANGES, String(req.query && req.query.range || ''))
      ? String(req.query.range)
      : '24h';
    recordHealthHistory(false);
    const history = bucketHealthHistory(range);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      generatedAt: Date.now(),
      sampleMs: HISTORY_SAMPLE_MS,
      retentionMs: HISTORY_RETENTION_MS,
      ...history,
    });
  });

  router.get('/pwa-admin-health', (req, res) => {
    if (!adminRole(req)) return res.status(403).json({ error: 'admin-required' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(healthPayload());
  });
  return true;
}

module.exports = {
  healthPayload,
  cpuSnapshot,
  cpuUsagePercent,
  processCpuPercent,
  eventLoopSnapshot,
  dataDirectory,
  diskSnapshot,
  safeLoadAverage,
  attachHealthRoute,
  historyFilePath,
  normalizeHistoryPoint,
  loadHealthHistory,
  pruneHealthHistory,
  recordHealthHistory,
  bucketHealthHistory,
  startHistorySampler,
  stopHistorySampler,
  HISTORY_SAMPLE_MS,
  HISTORY_RETENTION_MS,
  HISTORY_RANGES,
  HISTORY_FILE_MAX_BYTES,
};
