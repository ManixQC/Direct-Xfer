'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');

// Archiver 8 is ESM-only. Keep the loader inside the download boundary so ZIP
// implementation details do not leak back into the composition root.
let ZipArchiveClass = null;
async function createZipArchive(options) {
  if (!ZipArchiveClass) ({ ZipArchive: ZipArchiveClass } = await import('archiver'));
  return new ZipArchiveClass(options);
}

function createDownloadService(deps = {}) {
  const {
    MAX_ZIP_BYTES = 20 * 1024 ** 3,
    MAX_CONCURRENT_ZIPS = 2,
    HOST_ROOT,
    WEB_STORAGE_STREAM_IDLE_MS = 120000,
    getState,
    getSettings,
    getById,
    maskIp,
    clientIp,
    scheduleFlush,
    persistNow,
    sendError,
    challengeRequired,
    hasValidPow,
    challengePage,
    pickLang,
    noteCenterSharedFileSignature,
    commitManagedIpDownload,
    onDownloadComplete,
    noteBytesServed,
    startTransfer,
    endTransfer,
    noteCenterConcurrentDownloadStart,
    claimOneTimeDownload,
    releaseOneTimeDownload,
    challengeGateZip,
    assertRealWithin,
    hostToContainer,
    storageConnectorService,
    connectorErrorCode,
    webStorageShareMeta,
    webStorageJoinedPath,
    webStorageStat,
    webStorageEtag,
    parseWebStorageRange,
    incrementDownloads,
    zipArchiveFactory = createZipArchive,
  } = deps;

  if (typeof getSettings !== 'function' || typeof startTransfer !== 'function' || typeof endTransfer !== 'function') {
    throw new TypeError('createDownloadService requires getSettings, startTransfer and endTransfer');
  }

  // Shared download pacing. Per-link caps apply to aggregate link traffic rather
  // than each connection independently; global/scheduled caps share the same
  // reservation coordinator.
  const sharedThrottleStates = new Map();
  let sharedThrottleLastPruneAt = 0;
  function sharedThrottleState(key, bps, now = Date.now()) {
    const cleanBps = Number(bps);
    let st = sharedThrottleStates.get(key);
    if (!st) {
      st = { nextAt:now, lastSeenAt:now, bps:cleanBps };
      sharedThrottleStates.set(key, st);
    } else if (Number(st.bps) !== cleanBps) {
      st.nextAt = now;
      st.bps = cleanBps;
    }
    st.lastSeenAt = now;
    if (now - sharedThrottleLastPruneAt > 5 * 60 * 1000) {
      sharedThrottleLastPruneAt = now;
      for (const [k, v] of sharedThrottleStates) {
        if (!v || (now - Number(v.lastSeenAt || 0) > 10 * 60 * 1000 && Number(v.nextAt || 0) <= now)) sharedThrottleStates.delete(k);
      }
    }
    return st;
  }

  class Throttle extends Transform {
    constructor(constraints) {
      super();
      this.constraintSource = constraints;
      this.timer = null;
    }
    currentConstraints() {
      let raw = this.constraintSource;
      if (typeof raw === 'function') {
        try { raw = raw(); } catch (_) { raw = []; }
      }
      return (Array.isArray(raw) ? raw : [])
        .filter((c) => c && c.key && Number.isFinite(Number(c.bps)) && Number(c.bps) > 0)
        .map((c) => ({ key:String(c.key), bps:Number(c.bps) }));
    }
    _transform(chunk, _enc, cb) {
      const constraints = this.currentConstraints();
      if (!constraints.length) return cb(null, chunk);
      const now = Date.now();
      const reservations = [];
      let targetAt = now;
      for (const c of constraints) {
        const st = sharedThrottleState(c.key, c.bps, now);
        const previousNextAt = Number(st.nextAt) || now;
        const base = Math.max(now, previousNextAt);
        const finishAt = base + (chunk.length / c.bps) * 1000;
        reservations.push({ st, previousNextAt, finishAt });
        if (finishAt > targetAt) targetAt = finishAt;
      }
      for (const item of reservations) {
        item.st.nextAt = item.finishAt;
        item.st.lastSeenAt = now;
      }
      this.pendingReservations = reservations;
      const releaseChunk = () => {
        this.timer = null;
        this.pendingReservations = null;
        cb(null, chunk);
      };
      const delay = Math.max(0, targetAt - now);
      if (delay > 5) this.timer = setTimeout(releaseChunk, delay);
      else releaseChunk();
    }
    _destroy(err, cb) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      // If a throttled stream is cancelled while its current chunk is still
      // waiting, do not leave a phantom reservation that can stall the next
      // download for the entire abandoned chunk duration. Only rewind a state
      // when this transform still owns the tail reservation; if another stream
      // has already queued behind it, its reservation remains authoritative.
      if (Array.isArray(this.pendingReservations)) {
        const now = Date.now();
        for (const item of this.pendingReservations) {
          if (item && item.st && item.st.nextAt === item.finishAt) {
            item.st.nextAt = Math.max(now, Number(item.previousNextAt) || now);
            item.st.lastSeenAt = now;
          }
        }
      }
      this.pendingReservations = null;
      cb(err);
    }
  }

  function scheduleRateBps(now = new Date()) {
    const s = getSettings();
    if (!s.scheduleRateEnabled) return 0;
    const kbps = Math.max(0, Math.floor(Number(s.scheduleRateKBps) || 0));
    if (kbps <= 0) return 0;
    const toMin = (v) => {
      const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(v).trim());
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const start = toMin(s.scheduleStart), end = toMin(s.scheduleEnd);
    if (start === null || end === null || start === end) return 0;
    const cur = now.getHours() * 60 + now.getMinutes();
    const inWindow = start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
    return inWindow ? kbps * 1024 : 0;
  }

  function rateConstraintsForMeta(meta) {
    const out = [];
    if (meta && meta.shareId) {
      const s = getById(meta.shareId);
      if (s && Number(s.rateBps) > 0) out.push({ key:`link:${s.id}`, bps:Number(s.rateBps) });
    }
    const g = Math.max(0, Math.floor(Number(getSettings().globalRateKBps) || 0)) * 1024;
    if (g > 0) out.push({ key:'global-download', bps:g });
    const sched = scheduleRateBps();
    if (sched > 0) out.push({ key:'scheduled-download', bps:sched });
    return out;
  }

  function rateForMeta(meta) {
    const constraints = rateConstraintsForMeta(meta);
    return constraints.length ? Math.min(...constraints.map((c) => c.bps)) : 0;
  }

  // Managed browser/PWA resume sessions persist only completed byte intervals.
  const RESUME_DOWNLOAD_TTL_MS = 7 * 86400000;
  const RESUME_DOWNLOAD_MAX = 500;
  function downloadResumeStore() {
    const state = getState();
    if (!state.meta || typeof state.meta !== 'object') state.meta = {};
    if (!state.meta.downloadResumeSessions || typeof state.meta.downloadResumeSessions !== 'object' || Array.isArray(state.meta.downloadResumeSessions)) {
      state.meta.downloadResumeSessions = {};
    }
    return state.meta.downloadResumeSessions;
  }
  function validDownloadResumeId(value) {
    const id = String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{32,64}$/.test(id) ? id : null;
  }
  function downloadFileFingerprint(absPath, stat, shareId) {
    return crypto.createHash('sha256').update([
      'direct-xfer-resume-v1', String(shareId || ''), path.resolve(absPath), String(stat.size),
      String(Math.trunc(stat.mtimeMs || 0)), String(Math.trunc(stat.ctimeMs || 0)), String(stat.ino || 0),
    ].join('\0')).digest('hex');
  }
  function downloadFileEtag(stat) {
    const raw = `${Number(stat.size) || 0}-${Math.trunc(Number(stat.mtimeMs) || 0)}-${Math.trunc(Number(stat.ctimeMs) || 0)}-${Number(stat.ino) || 0}`;
    return `"dx-${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 24)}"`;
  }
  function pruneDownloadResumeSessions(now = Date.now()) {
    const store = downloadResumeStore();
    const rows = Object.entries(store);
    let changed = false;
    for (const [id, session] of rows) {
      const ttl = session && session.finalized ? Math.min(RESUME_DOWNLOAD_TTL_MS, 86400000) : RESUME_DOWNLOAD_TTL_MS;
      if (!session || now - Number(session.updatedAt || session.createdAt || 0) > ttl) {
        delete store[id]; changed = true;
      }
    }
    const remaining = Object.entries(store).sort((a, b) => Number(b[1].updatedAt || 0) - Number(a[1].updatedAt || 0));
    for (const [id] of remaining.slice(RESUME_DOWNLOAD_MAX)) { delete store[id]; changed = true; }
    if (changed && typeof scheduleFlush === 'function') scheduleFlush();
    return store;
  }
  function mergeDownloadRanges(ranges, start, end) {
    const all = (Array.isArray(ranges) ? ranges : [])
      .concat([[Math.max(0, Number(start) || 0), Math.max(0, Number(end) || 0)]])
      .filter((row) => Array.isArray(row) && Number.isSafeInteger(row[0]) && Number.isSafeInteger(row[1]) && row[0] <= row[1])
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const row of all) {
      const last = merged[merged.length - 1];
      if (last && row[0] <= last[1] + 1) last[1] = Math.max(last[1], row[1]);
      else merged.push([row[0], row[1]]);
    }
    return merged.slice(0, 2048);
  }
  function downloadRangesComplete(ranges, total) {
    return total === 0 || (Array.isArray(ranges) && ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= total - 1);
  }
  function downloadRangesCoveredBytes(ranges, total) {
    const cap = Math.max(0, Number(total) || 0);
    if (!cap || !Array.isArray(ranges)) return 0;
    const rows = ranges.map((row) => {
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[1]) || row[0] > row[1]) return null;
      const from = Math.max(0, Math.min(cap - 1, row[0]));
      const to = Math.max(0, Math.min(cap - 1, row[1]));
      return to >= from ? [from, to] : null;
    }).filter(Boolean).sort((a, b) => a[0] - b[0]);
    let bytes = 0, from = -1, to = -1;
    for (const row of rows) {
      if (from < 0) { from = row[0]; to = row[1]; continue; }
      if (row[0] <= to + 1) { to = Math.max(to, row[1]); continue; }
      bytes += to - from + 1; from = row[0]; to = row[1];
    }
    if (from >= 0) bytes += to - from + 1;
    return Math.min(cap, bytes);
  }
  function getDownloadResumeSession(req, absPath, stat, transferMeta, filename, resumeScope) {
    const id = validDownloadResumeId(req.headers['x-direct-xfer-resume-id']);
    const scope = String((transferMeta && transferMeta.shareId) || resumeScope || '').trim().slice(0, 240);
    if (!id || !scope) return { id:null, session:null };
    const share = transferMeta && transferMeta.shareId ? getById(transferMeta.shareId) : null;
    if (share && share.burnAfterDownload) return { id, error:'resume-unavailable-one-time' };
    const store = pruneDownloadResumeSessions();
    const fingerprint = downloadFileFingerprint(absPath, stat, scope);
    let session = store[id];
    if (session && (session.fingerprint !== fingerprint || String(session.scope || session.shareId || '') !== scope)) return { id, error:'resume-id-conflict' };
    if (session && session.finalized) return { id, error:'resume-already-complete' };
    if (!session) {
      session = store[id] = {
        id, fingerprint, scope, shareId:(transferMeta && transferMeta.shareId) || null, filename:String(filename || '').slice(0, 240),
        total:stat.size, ranges:[], quotaIp:(transferMeta && transferMeta.shareId) ? maskIp(clientIp(req)) : null,
        createdAt:Date.now(), updatedAt:Date.now(), finalized:false,
      };
      if (typeof scheduleFlush === 'function') scheduleFlush();
    } else {
      const validRanges = Array.isArray(session.ranges) && session.ranges.every((row) =>
        Array.isArray(row) && Number.isSafeInteger(row[0]) && Number.isSafeInteger(row[1]) && row[0] >= 0 && row[0] <= row[1] && row[1] < stat.size
      );
      if (!validRanges) {
        session.ranges = [];
        session.updatedAt = Date.now();
        if (typeof scheduleFlush === 'function') scheduleFlush();
      }
    }
    return { id, session };
  }
  function completeManagedDownload(req, session, onServed, transferMeta, total, filename) {
    if (!session || session.finalized) return false;
    session.finalized = true;
    session.completedAt = Date.now();
    session.updatedAt = Date.now();
    if (onServed) onServed();
    if (transferMeta) {
      if (transferMeta.shareId && typeof commitManagedIpDownload === 'function') commitManagedIpDownload(getById(transferMeta.shareId), session.quotaIp);
      if (typeof onDownloadComplete === 'function') onDownloadComplete({ type:'file', name:filename });
      if (transferMeta.shareId && typeof noteBytesServed === 'function') noteBytesServed(transferMeta.shareId, total);
      const logical = startTransfer(req, { ...transferMeta, resumed:true }, total);
      logical.bytes = total;
      logical.notify = true;
      logical.resumed = true;
      if (typeof noteCenterConcurrentDownloadStart === 'function') noteCenterConcurrentDownloadStart(logical);
      endTransfer(logical, true, null);
    }
    if (!(typeof persistNow === 'function' && persistNow()) && typeof scheduleFlush === 'function') scheduleFlush();
    return true;
  }

  function streamFile(req, res, absPath, filename, onServed, transferMeta, serveOpts = {}) {
    fs.stat(absPath, (err, st) => {
      if (err || !st.isFile()) return sendError(req, res, 404, 'fileNotFound');
      const total = st.size;
      const etag = downloadFileEtag(st);
      if (transferMeta && transferMeta.shareId && typeof noteCenterSharedFileSignature === 'function') {
        const sigShare = getById(transferMeta.shareId);
        if (sigShare) noteCenterSharedFileSignature(sigShare, absPath, filename, st);
      }
      if (serveOpts.challenge && req.method === 'GET' && challengeRequired(total) && !hasValidPow(req)) {
        return res.status(200).type('html').send(challengePage(pickLang(req)));
      }
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', st.mtime.toUTCString());
      const resumableAllowed = !!(
        (transferMeta && transferMeta.shareId && !(getById(transferMeta.shareId) || {}).burnAfterDownload) || serveOpts.resumable
      );
      res.setHeader('X-Direct-Xfer-Resumable', resumableAllowed ? '1' : '0');
      res.setHeader('Accept-Ranges', 'bytes');
      const inline = !!serveOpts.inline;
      res.setHeader('Content-Type', inline && serveOpts.contentType ? serveOpts.contentType : 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + `; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Cache-Control', serveOpts.cacheControl || 'no-store');

      let start = 0, end = total - 1, status = 200;
      const ifRange = String(req.headers['if-range'] || '').trim();
      const range = ifRange && ifRange !== etag && ifRange !== st.mtime.toUTCString() ? null : req.headers.range;
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

      const managedResume = req.method === 'GET'
        ? getDownloadResumeSession(req, absPath, st, transferMeta, filename, resumableAllowed ? serveOpts.resumeScope : null)
        : { id:null, session:null };
      if (managedResume.error) {
        for (const header of ['Content-Range','Content-Length','Content-Disposition','Content-Type']) res.removeHeader(header);
        return res.status(409).json({ error:managedResume.error });
      }
      if (managedResume.id) res.setHeader('X-Direct-Xfer-Resume-Id', managedResume.id);

      const isFullGet = !managedResume.session && req.method === 'GET' && start === 0 && end >= total - 1;
      let burnClaim = null;
      if (isFullGet && !inline && transferMeta && transferMeta.shareId) {
        const claimed = claimOneTimeDownload(transferMeta.shareId);
        if (claimed === false) return res.status(409).type('text/plain').send('One-time link is already being downloaded.');
        burnClaim = claimed;
      }
      if (isFullGet) {
        res.on('finish', () => {
          if (onServed) onServed();
          if (!inline) {
            if (typeof onDownloadComplete === 'function') onDownloadComplete({ type:'file', name:filename });
            if (transferMeta && transferMeta.shareId && typeof noteBytesServed === 'function') noteBytesServed(transferMeta.shareId, total);
          }
        });
      }

      if (req.method === 'HEAD' || end < start) {
        if (isFullGet && req.method === 'GET' && transferMeta) {
          const emptyTransfer = startTransfer(req, transferMeta, 0);
          emptyTransfer.notify = true;
          if (burnClaim) emptyTransfer.burnClaim = burnClaim;
          let emptyEnded = false;
          const finishEmpty = (completed, reason) => {
            if (emptyEnded) return;
            emptyEnded = true;
            endTransfer(emptyTransfer, completed, reason || null);
          };
          res.on('finish', () => finishEmpty(true, null));
          res.on('close', () => { if (!res.writableFinished) finishEmpty(false, 'connection-closed'); });
        } else if (burnClaim) releaseOneTimeDownload(transferMeta && transferMeta.shareId, burnClaim);
        return res.end();
      }

      const rateBps = rateForMeta(transferMeta);
      const stream = fs.createReadStream(absPath, {
        start,
        end,
        highWaterMark:rateBps > 0 ? Math.min(256 * 1024, Math.max(1024, Math.floor(rateBps / 10))) : undefined,
      });
      const throttle = rateBps > 0 ? new Throttle(() => rateConstraintsForMeta(transferMeta)) : null;
      const managedSession = managedResume.session || null;
      const managedPriorRanges = managedSession && Array.isArray(managedSession.ranges)
        ? managedSession.ranges.filter((row) => Array.isArray(row) && row[1] >= start && row[0] <= end).slice().sort((a, b) => Number(a[0]) - Number(b[0]))
        : [];
      const managedBaselineBytes = managedSession ? downloadRangesCoveredBytes(managedSession.ranges, total) : 0;
      const transfer = transferMeta
        ? startTransfer(req, { ...transferMeta, resumed:!!managedSession && (managedBaselineBytes > 0 || start > 0), resumeOffset:managedSession && (managedBaselineBytes > 0 || start > 0) ? start : 0, transient:!!managedSession }, managedSession ? total : end - start + 1)
        : null;
      if (transfer) {
        transfer.notify = isFullGet;
        if (managedSession) transfer.progressBytes = managedBaselineBytes;
        if (burnClaim) transfer.burnClaim = burnClaim;
        if (transfer.notify && typeof noteCenterConcurrentDownloadStart === 'function') noteCenterConcurrentDownloadStart(transfer);
        transfer.abort = () => { try { stream.destroy(); if (throttle) throttle.destroy(); res.destroy(); } catch (_) {} };
        let managedCursor = start;
        stream.on('data', (chunk) => {
          transfer.bytes += chunk.length;
          if (managedSession) {
            const chunkStart = managedCursor;
            const chunkEnd = Math.min(end, chunkStart + chunk.length - 1);
            let overlap = 0;
            for (const row of managedPriorRanges) {
              if (row[0] > chunkEnd) break;
              if (row[1] < chunkStart) continue;
              overlap += Math.max(0, Math.min(chunkEnd, row[1]) - Math.max(chunkStart, row[0]) + 1);
            }
            const novel = Math.max(0, chunkEnd - chunkStart + 1 - overlap);
            transfer.progressBytes = Math.min(total, Math.max(0, Number(transfer.progressBytes) || 0) + novel);
            managedCursor = chunkEnd + 1;
          }
          transfer.lastActivity = Date.now();
        });
      }
      stream.on('error', () => {
        if (transfer) transfer.failureReason = 'read-error';
        if (!res.headersSent) sendError(req, res, 500, 'readError'); else res.destroy();
      });
      if (managedResume.session && req.method === 'GET') {
        res.on('finish', () => {
          const session = managedResume.session;
          if (session.finalized) return;
          session.ranges = mergeDownloadRanges(session.ranges, start, end);
          session.updatedAt = Date.now();
          if (downloadRangesComplete(session.ranges, total)) completeManagedDownload(req, session, onServed, transferMeta, total, filename);
          else if (typeof scheduleFlush === 'function') scheduleFlush();
        });
      }
      res.on('close', () => {
        stream.destroy();
        if (throttle) throttle.destroy();
        endTransfer(transfer, res.writableFinished, res.writableFinished ? null : (transfer && transfer.failureReason) || 'connection-closed');
      });
      if (throttle) stream.pipe(throttle).pipe(res); else stream.pipe(res);
    });
  }

  function countingFileStream(absPath, onBytes) {
    return Readable.from((async function* () {
      const stream = fs.createReadStream(absPath, { highWaterMark:64 * 1024 });
      try {
        for await (const buf of stream) {
          if (onBytes) onBytes(buf.length);
          yield buf;
        }
      } finally { stream.destroy(); }
    })());
  }

  async function addDirToArchive(archive, absDir, baseInZip, onBytes, onFileSize, onMember) {
    let dirents;
    try { dirents = await fs.promises.readdir(absDir, { withFileTypes:true }); }
    catch (_) { return; }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(absDir, d.name);
      const nameInZip = baseInZip ? baseInZip + '/' + d.name : d.name;
      if (d.isDirectory()) await addDirToArchive(archive, abs, nameInZip, onBytes, onFileSize, onMember);
      else if (d.isFile()) {
        let date, size = 0;
        try { const st = await fs.promises.stat(abs); date = st.mtime; size = st.size; } catch (_) {}
        if (onFileSize) onFileSize(size);
        if (onMember) onMember(nameInZip, size);
        archive.append(countingFileStream(abs, onBytes), { name:nameInZip, date });
      }
    }
  }

  let activeZipStreams = 0;
  function beginZipStream(res) {
    if (activeZipStreams >= MAX_CONCURRENT_ZIPS) {
      res.removeHeader('Content-Disposition');
      res.setHeader('Retry-After', '5');
      res.status(429).json({ error:'too-many-zips' });
      return null;
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
    return release;
  }

  function failZipResponse(req, res, archive, releaseZipSlot, error) {
    try { if (archive && typeof archive.destroy === 'function') archive.destroy(); } catch (_) {}
    if (typeof releaseZipSlot === 'function') releaseZipSlot();
    const message = error && error.message ? error.message : String(error || 'zip-error');
    console.error('[zip] aborted:', message);
    if (res.headersSent) {
      try { res.destroy(); } catch (_) {}
      return;
    }
    for (const name of ['Content-Disposition','Content-Length','Content-Range']) {
      try { res.removeHeader(name); } catch (_) {}
    }
    return sendError(req, res, 500, 'zipError');
  }
  function effectiveMaxZip() {
    const s = Math.floor(Number(getSettings().maxZipBytes)) || 0;
    return s > 0 ? s : MAX_ZIP_BYTES;
  }

  async function streamZip(req, res, absDir, zipName, onServed, transferMeta) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName + '.zip')}`);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') return res.end();
    let burnClaim = null;
    if (transferMeta && transferMeta.shareId) {
      const claimed = claimOneTimeDownload(transferMeta.shareId);
      if (claimed === false) return res.status(409).type('text/plain').send('One-time link is already being downloaded.');
      burnClaim = claimed;
    }
    const releaseZipSlot = beginZipStream(res);
    if (!releaseZipSlot) {
      if (burnClaim) releaseOneTimeDownload(transferMeta && transferMeta.shareId, burnClaim);
      return;
    }
    let archive;
    let zipFailed = false;
    const failZip = (error) => {
      if (zipFailed) return;
      zipFailed = true;
      return failZipResponse(req, res, archive, releaseZipSlot, error);
    };
    try { archive = await zipArchiveFactory({ zlib:{ level:6 } }); }
    catch (e) {
      if (burnClaim) releaseOneTimeDownload(transferMeta && transferMeta.shareId, burnClaim);
      return failZip(e);
    }
    const rateBps = rateForMeta(transferMeta);
    const throttle = rateBps > 0 ? new Throttle(() => rateConstraintsForMeta(transferMeta)) : null;
    const transfer = transferMeta ? startTransfer(req, transferMeta, 0) : null;
    if (transfer) {
      transfer.notify = true;
      if (burnClaim) transfer.burnClaim = burnClaim;
      if (typeof noteCenterConcurrentDownloadStart === 'function') noteCenterConcurrentDownloadStart(transfer);
      transfer.isZip = true;
      transfer.zipTotalBytes = 0;
      transfer.zipProcessedBytes = 0;
      transfer.members = [];
      transfer.membersTruncated = false;
      transfer.abort = () => { try { archive.destroy(); if (throttle) throttle.destroy(); res.destroy(); } catch (_) {} };
    }
    let zipBytes = 0;
    const maxZip = effectiveMaxZip();
    archive.on('error', (err) => {
      if (transfer) transfer.failureReason = 'zip-error';
      failZip(err);
    });
    archive.on('warning', (w) => { if (w.code !== 'ENOENT') console.warn('[zip] warning:', w.message); });
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
      if (typeof onDownloadComplete === 'function') onDownloadComplete({ type:'folder-zip', name:zipName });
      if (transferMeta && transferMeta.shareId && typeof noteBytesServed === 'function') noteBytesServed(transferMeta.shareId, transfer ? transfer.bytes : 0);
    });
    if (throttle) archive.pipe(throttle).pipe(res); else archive.pipe(res);
    try {
      await addDirToArchive(
        archive, absDir, '',
        (n) => { if (transfer) { transfer.zipProcessedBytes += n; transfer.lastActivity = Date.now(); } },
        (n) => { if (transfer) transfer.zipTotalBytes += n; },
        (name, size) => { if (!transfer) return; if (transfer.members.length < 500) transfer.members.push({ name:String(name).slice(0,240), size:Math.max(0,Number(size)||0) }); else transfer.membersTruncated = true; },
      );
      await archive.finalize();
    } catch (e) {
      if (transfer) transfer.failureReason = 'zip-error';
      failZip(e);
    }
  }

  async function streamZipFiles(req, res, items, zipName, onServed, transferMeta) {
    if (typeof challengeGateZip === 'function' && challengeGateZip(req, res)) return;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName + '.zip')}`);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') return res.end();
    let burnClaim = null;
    if (transferMeta && transferMeta.shareId) {
      const claimed = claimOneTimeDownload(transferMeta.shareId);
      if (claimed === false) return res.status(409).type('text/plain').send('One-time link is already being downloaded.');
      burnClaim = claimed;
    }
    const releaseZipSlot = beginZipStream(res);
    if (!releaseZipSlot) {
      if (burnClaim) releaseOneTimeDownload(transferMeta && transferMeta.shareId, burnClaim);
      return;
    }
    let archive;
    let zipFailed = false;
    const failZip = (error) => {
      if (zipFailed) return;
      zipFailed = true;
      return failZipResponse(req, res, archive, releaseZipSlot, error);
    };
    try { archive = await zipArchiveFactory({ zlib:{ level:6 } }); }
    catch (e) {
      if (burnClaim) releaseOneTimeDownload(transferMeta && transferMeta.shareId, burnClaim);
      return failZip(e);
    }
    const rateBps = rateForMeta(transferMeta);
    const throttle = rateBps > 0 ? new Throttle(() => rateConstraintsForMeta(transferMeta)) : null;
    const transfer = transferMeta ? startTransfer(req, transferMeta, 0) : null;
    if (transfer) {
      transfer.notify = true;
      if (burnClaim) transfer.burnClaim = burnClaim;
      if (typeof noteCenterConcurrentDownloadStart === 'function') noteCenterConcurrentDownloadStart(transfer);
      transfer.isZip = true;
      transfer.zipTotalBytes = 0;
      transfer.zipProcessedBytes = 0;
      transfer.members = [];
      transfer.membersTruncated = false;
      transfer.abort = () => { try { archive.destroy(); if (throttle) throttle.destroy(); res.destroy(); } catch (_) {} };
    }
    let zipBytes = 0;
    const maxZip = effectiveMaxZip();
    archive.on('error', (err) => {
      if (transfer) transfer.failureReason = 'zip-error';
      failZip(err);
    });
    archive.on('warning', (w) => { if (w.code !== 'ENOENT') console.warn('[zip] warning:', w.message); });
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
      if (typeof onDownloadComplete === 'function') onDownloadComplete({ type:'collection-zip', name:zipName });
      if (transferMeta && transferMeta.shareId && typeof noteBytesServed === 'function') noteBytesServed(transferMeta.shareId, transfer ? transfer.bytes : 0);
    });
    if (throttle) archive.pipe(throttle).pipe(res); else archive.pipe(res);
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
          if (it.containerPath) {
            const allowedRoot = path.resolve(it.allowedRoot || HOST_ROOT);
            abs = path.resolve(it.containerPath);
            abs = await assertRealWithin(allowedRoot, abs);
          } else {
            abs = hostToContainer(it.hostPath);
            abs = await assertRealWithin(HOST_ROOT, abs);
          }
          st = await fs.promises.stat(abs);
        } catch (_) { continue; }
        const label = it.name || path.basename(abs);
        if (st.isDirectory()) {
          const zipLabel = uniq(label);
          await addDirToArchive(
            archive, abs, zipLabel, onBytes,
            (n) => { if (transfer) transfer.zipTotalBytes += n; },
            (name, size) => { if (!transfer) return; if (transfer.members.length < 500) transfer.members.push({ name:String(name).slice(0,240), size:Math.max(0,Number(size)||0) }); else transfer.membersTruncated = true; },
          );
        } else if (st.isFile()) {
          if (transfer) transfer.zipTotalBytes += st.size;
          const zipLabel = uniq(label);
          if (transfer) {
            if (transfer.members.length < 500) transfer.members.push({ name:String(zipLabel).slice(0,240), size:Math.max(0,Number(st.size)||0) });
            else transfer.membersTruncated = true;
          }
          archive.append(countingFileStream(abs, onBytes), { name:zipLabel, date:st.mtime });
        }
      }
      await archive.finalize();
    } catch (e) {
      if (transfer) transfer.failureReason = 'zip-error';
      failZip(e);
    }
  }

  function sendWebStorageStreamError(req, res, status) {
    if (res.headersSent) { res.destroy(); return; }
    for (const name of ['Content-Length','Content-Range','Content-Disposition','ETag','Last-Modified','Accept-Ranges','X-Direct-Xfer-Resumable']) {
      try { res.removeHeader(name); } catch (_) {}
    }
    return sendError(req, res, status, 'fileUnavailable');
  }

  function serveWebStorageFile(req, res, s, relative, options = {}) {
    return (async () => {
      const meta = webStorageShareMeta(s);
      const full = webStorageJoinedPath(s, relative);
      if (!meta || full === null) return sendError(req, res, 404, 'fileUnavailable');
      let stat;
      try { stat = await webStorageStat(s, relative, { fresh:!!req.headers['if-range'] }); }
      catch (error) {
        const code = connectorErrorCode(error);
        return sendError(req, res, ['remote-not-found','connector-not-found'].includes(code) ? 404 : 503, 'fileUnavailable');
      }
      if (stat.isDir) return sendError(req, res, 404, 'notFound');
      const total = Math.max(0, Number(stat.size) || 0);
      if (options.challenge && req.method === 'GET' && challengeRequired(total) && !hasValidPow(req)) {
        return res.status(200).type('html').send(challengePage(pickLang(req)));
      }
      const filename = String(options.filename || stat.name || s.name || 'download').replace(/[\r\n\0]/g, ' ').slice(0,240) || 'download';
      const inline = !!options.inline, countStats = options.countStats !== false;
      const etag = webStorageEtag(s, stat, relative);
      if (etag) res.setHeader('ETag', etag);
      const modifiedAt = stat.modTime ? Date.parse(String(stat.modTime)) : NaN;
      if (Number.isFinite(modifiedAt)) res.setHeader('Last-Modified', new Date(modifiedAt).toUTCString());
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Direct-Xfer-Resumable', '0');
      res.setHeader('Content-Type', inline && options.contentType ? options.contentType : 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + `; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('Cache-Control', 'no-store');
      const range = parseWebStorageRange(req, total, etag);
      if (range.error) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      const { start, end, status } = range;
      if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.status(status);
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      const fullGet = req.method === 'GET' && start === 0 && end >= total - 1;
      let burnClaim = null;
      if (fullGet && !inline && countStats) {
        const claimed = claimOneTimeDownload(s.id);
        if (claimed === false) return res.status(409).type('text/plain').send('One-time link is already being downloaded.');
        burnClaim = claimed;
      }
      if (req.method === 'HEAD') return res.end();

      const expected = Math.max(0, end - start + 1);
      const transfer = !inline ? startTransfer(req, { shareId:s.id, name:filename, type:'web-storage' }, expected) : null;
      if (transfer) {
        transfer.notify = fullGet;
        if (burnClaim) transfer.burnClaim = burnClaim;
        if (transfer.notify && typeof noteCenterConcurrentDownloadStart === 'function') noteCenterConcurrentDownloadStart(transfer);
      }
      let child;
      try { child = storageConnectorService.streamFile(meta, full, { offset:start, count:expected }); }
      catch (_) {
        if (burnClaim) releaseOneTimeDownload(s.id, burnClaim);
        endTransfer(transfer, false, 'connector-failed');
        return sendWebStorageStreamError(req, res, 503);
      }
      let stderr = '', childDone = false, childOk = false, outputDone = false, responseFinished = false, responseClosed = false, finalized = false;
      let idleTimer = null;
      const touchIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch (_) {}
          if (transfer) transfer.failureReason = 'timeout';
        }, WEB_STORAGE_STREAM_IDLE_MS);
        if (idleTimer.unref) idleTimer.unref();
      };
      const finalize = () => {
        if (finalized || !childDone || (!responseFinished && !responseClosed)) return;
        finalized = true;
        if (idleTimer) clearTimeout(idleTimer);
        const completed = childOk && responseFinished && (!transfer || transfer.bytes === expected);
        if (completed && !inline && countStats && typeof noteBytesServed === 'function') noteBytesServed(s.id, expected);
        if (completed && fullGet && !inline && countStats) {
          if (typeof incrementDownloads === 'function') incrementDownloads(s.id);
          if (typeof onDownloadComplete === 'function') onDownloadComplete({ type:'file', name:filename });
        }
        endTransfer(transfer, completed, completed ? null : (transfer && transfer.failureReason) || (childOk ? 'connection-closed' : 'connector-failed'));
        if (burnClaim && !transfer) releaseOneTimeDownload(s.id, burnClaim);
      };
      if (transfer) transfer.abort = () => { try { child.kill('SIGTERM'); res.destroy(); } catch (_) {} };
      child.stdout.on('data', (chunk) => { if (transfer) { transfer.bytes += chunk.length; transfer.lastActivity = Date.now(); } touchIdle(); });
      child.stderr.on('data', (chunk) => { if (stderr.length < 16384) stderr += Buffer.from(chunk).toString('utf8').slice(0, 16384 - stderr.length); });
      child.once('error', (error) => {
        childDone = true; childOk = false;
        if (transfer) transfer.failureReason = error && error.code === 'ENOENT' ? 'rclone-unavailable' : 'connector-failed';
        if (!res.headersSent) sendWebStorageStreamError(req, res, 503); else res.destroy();
        finalize();
      });
      const maybeEndResponse = () => {
        if (!childDone || !outputDone || res.writableEnded || res.destroyed) return;
        if (childOk) res.end();
        else if (!res.headersSent) sendWebStorageStreamError(req, res, 502); else res.destroy();
      };
      child.once('close', (code) => {
        childDone = true;
        childOk = code === 0;
        if (!childOk && transfer && !transfer.failureReason) transfer.failureReason = 'connector-failed';
        maybeEndResponse();
        finalize();
      });
      res.once('finish', () => { responseFinished = true; finalize(); });
      res.once('close', () => {
        responseClosed = true;
        if (!res.writableFinished) { try { child.kill('SIGTERM'); } catch (_) {} }
        finalize();
      });
      touchIdle();
      const rateBps = inline ? 0 : rateForMeta({ shareId:s.id });
      const throttle = rateBps > 0 ? new Throttle(() => rateConstraintsForMeta({ shareId:s.id })) : null;
      const output = throttle || child.stdout;
      output.once('end', () => { outputDone = true; maybeEndResponse(); });
      if (throttle) child.stdout.pipe(throttle);
      output.pipe(res, { end:false });
    })().catch(() => { if (!res.headersSent) sendWebStorageStreamError(req, res, 503); else res.destroy(); });
  }

  function clearRuntimeState() {
    sharedThrottleStates.clear();
    sharedThrottleLastPruneAt = 0;
    // Restore is rejected while tracked transfers are active. Resetting this
    // counter as well prevents a stale ZIP slot from surviving an earlier
    // initialization failure or an emergency runtime reset.
    activeZipStreams = 0;
  }

  return {
    streamFile,
    streamZip,
    streamZipFiles,
    serveWebStorageFile,
    createZipArchive,
    // Exposed for focused unit tests and diagnostics; routes should use the
    // higher-level streaming methods above.
    validDownloadResumeId,
    pruneDownloadResumeSessions,
    downloadFileEtag,
    mergeDownloadRanges,
    downloadRangesComplete,
    downloadRangesCoveredBytes,
    rateConstraintsForMeta,
    rateForMeta,
    clearRuntimeState,
  };
}

module.exports = { createDownloadService };
