'use strict';

const { createFdUtils } = require('../fd-utils');

// Transfer lifecycle, accounting and live-transfer telemetry. The service owns
// the mutable active-transfer and one-time-download claim maps so HTTP routes do
// not need to coordinate stream races themselves.
function createTransferService(deps = {}) {
  const {
    crypto,
    fs,
    LOG_FILE,
    MAX_LOG_BYTES = 0,
    HISTORY_MAX = 2000,
    TRANSFER_STALL_MS = 45000,
    getState,
    getSettings,
    getById,
    clientIp,
    geoSync,
    geolocate,
    getRecipientByToken,
    dataWritable,
    emitLiveActivity,
    pubIp,
    ipNameFor,
    schedulePresenceBroadcast,
    scheduleFlush,
    persist,
    logAudit,
    addShareCenterNotification,
    noteCenterCountry,
    noteCenterActivity,
    noteCenterRepeatedDownload,
    noteCenterHighVolume,
    noteCenterViral,
    maybeCenterReceptionQuota,
    noteCenterAutoDisabled,
    notify,
    noteLeakSignal,
  } = deps;

  if (!crypto || !fs || typeof getState !== 'function' || typeof getById !== 'function') {
    throw new TypeError('createTransferService requires crypto, fs, getState and getById');
  }

  let descriptorIo = null;
  const getDescriptorIo = () => descriptorIo || (descriptorIo = createFdUtils(fs));
  const activeTransfers = new Map();
  const oneTimeDownloadClaims = new Map();

  function dashboardSafeString(value) {
    try { return value == null ? '' : String(value); } catch (_) { return ''; }
  }
  function dashboardQueryOptions(req, now = Date.now()) {
    const query = req && req.query && typeof req.query === 'object' && !Array.isArray(req.query) ? req.query : {};
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const dq = dashboardSafeString(query.days || '30');
    const days = ['1', '7', '30', '90', '365'].includes(dq) ? Number(dq) : (dq === 'all' || dq === '0' ? 0 : 30);
    const directionRaw = dashboardSafeString(query.direction || '');
    const direction = ['up', 'down'].includes(directionRaw) ? directionRaw : '';
    const statusRaw = dashboardSafeString(query.status || '');
    const status = ['completed', 'interrupted'].includes(statusRaw) ? statusRaw : '';
    const allowedTypes = new Set(['file', 'folder', 'inbox', 'collab', 'secret', 'photo']);
    const typeRaw = dashboardSafeString(query.type || '');
    const type = allowedTypes.has(typeRaw) ? typeRaw : '';
    const q = dashboardSafeString(query.q || '').trim().toLowerCase().slice(0, 100);
    return { days, cutoff:days > 0 ? current - days * 86400000 : 0, direction, status, type, q };
  }

  function dashboardRecordMatches(r, filters = {}) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    if (filters.direction) {
      const recordDirection = r.direction === 'up' || r.direction === 'down' ? r.direction : '';
      if (recordDirection !== filters.direction) return false;
    }
    if (filters.status) {
      const recordStatus = r.completed === true ? 'completed' : r.completed === false ? 'interrupted' : '';
      if (recordStatus !== filters.status) return false;
    }
    if (filters.type && dashboardSafeString(r.type || '') !== filters.type) return false;
    if (filters.q) {
      const rawIp = dashboardSafeString(r.ip || '').replace(/^::ffff:/i, '');
      let shownIp = rawIp;
      let ipName = null;
      try { if (typeof pubIp === 'function') shownIp = dashboardSafeString(pubIp(rawIp)); } catch (_) { shownIp = ''; }
      try { if (typeof ipNameFor === 'function') ipName = ipNameFor(shownIp); } catch (_) { ipName = null; }
      const hay = [r.name, r.shareId, r.recipientName, r.country, r.countryCode, shownIp, ipName]
        .map(dashboardSafeString).filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(filters.q)) return false;
    }
    return true;
  }


  function recipientRecord(token) {
    try { return typeof getRecipientByToken === 'function' ? getRecipientByToken(token) : null; }
    catch (_) { return null; }
  }

  function claimOneTimeDownload(shareId) {
    const sh = shareId ? getById(shareId) : null;
    if (!sh || !sh.burnAfterDownload) return null;
    if (sh.revoked || oneTimeDownloadClaims.has(sh.id)) return false;
    const claim = crypto.randomBytes(8).toString('hex');
    oneTimeDownloadClaims.set(sh.id, claim);
    return claim;
  }

  function releaseOneTimeDownload(shareId, claim) {
    if (shareId && claim && oneTimeDownloadClaims.get(shareId) === claim) oneTimeDownloadClaims.delete(shareId);
  }

  function startTransfer(req, meta = {}, expectedBytes) {
    const id = crypto.randomBytes(6).toString('hex');
    const ip = String((typeof clientIp === 'function' ? clientIp(req) : '') || '').replace(/^::ffff:/i, '');
    const t = {
      id,
      shareId: meta.shareId,
      name: meta.name,
      type: meta.type,
      direction: meta.direction || 'down',
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
      abort: null,
      resumed: !!meta.resumed,
      resumeOffset: Math.max(0, Number(meta.resumeOffset) || 0),
      transient: !!meta.transient,
      stopRequested: false,
      ended: false,
    };
    const transferShare = meta.shareId ? getById(meta.shareId) : null;
    if (transferShare) {
      t.ownerId = transferShare.ownerId || null;
      t.ownerName = transferShare.ownerName || null;
    }
    let g = null;
    try { g = typeof geoSync === 'function' ? geoSync(ip) : null; } catch (_) {}
    if (g) {
      t.country = g.country;
      t.countryCode = g.countryCode;
      t.flag = g.flag;
    } else if (typeof geolocate === 'function') {
      Promise.resolve().then(() => geolocate(ip)).then((geo) => {
        if (!geo) return;
        t.country = geo.country;
        t.countryCode = geo.countryCode;
        t.flag = geo.flag;
      }).catch(() => {});
    }
    const rtok = req && req.params && req.params.token;
    const rc = rtok ? recipientRecord(rtok) : null;
    if (rc && rc.recipient) {
      t.recipientToken = rc.recipient.token;
      t.recipientName = rc.recipient.name;
    }
    activeTransfers.set(id, t);
    if (!t.transient && typeof emitLiveActivity === 'function') {
      emitLiveActivity('transfer-start', { shareId:t.shareId, name:t.name, direction:t.direction, bytes:0, ip:typeof pubIp === 'function' ? pubIp(t.ip || '') : t.ip, status:'active' });
    }
    if (typeof schedulePresenceBroadcast === 'function') schedulePresenceBroadcast();
    return t;
  }

  function appendLog(record) {
    if (typeof dataWritable === 'function' && !dataWritable()) return;
    if (!LOG_FILE) return;
    fs.appendFile(LOG_FILE, JSON.stringify(record) + '\n', (err) => {
      if (err) console.error('[log] append failed:', err.message);
    });
  }

  function trimLogIfNeeded() {
    if (!MAX_LOG_BYTES || !LOG_FILE) return;
    let sz;
    try { sz = fs.statSync(LOG_FILE).size; }
    catch (_) { return; }
    if (sz <= MAX_LOG_BYTES) return;
    try {
      const buf = fs.readFileSync(LOG_FILE);
      const keep = buf.slice(buf.length - Math.floor(MAX_LOG_BYTES / 2));
      const nl = keep.indexOf(0x0a);
      const clean = nl >= 0 ? keep.slice(nl + 1) : keep;
      fs.writeFileSync(LOG_FILE + '.tmp', clean, { mode: 0o600 });
      fs.renameSync(LOG_FILE + '.tmp', LOG_FILE);
      console.log('[log] transfers.log trimmed to the most recent entries.');
    } catch (e) {
      console.error('[log] trim failed:', e.message);
    }
  }

  // Reads at most maxBytes from the end of the transfer journal and returns
  // complete lines. A line is dropped only when the bounded read really starts
  // in the middle of it; if the byte immediately before the window is a newline,
  // the first line in the window is complete and must be retained.
  function readLogTail(maxBytes) {
    if (!LOG_FILE) return [];
    let fh;
    try {
      fh = fs.openSync(LOG_FILE, 'r');
      const size = fs.fstatSync(fh).size;
      const want = Math.min(size, maxBytes);
      const start = size - want;
      const buf = Buffer.alloc(want);
      let total = 0;
      while (total < want) {
        const bytesRead = fs.readSync(fh, buf, total, want - total, start + total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      let text = buf.subarray(0, total).toString('utf8');
      if (start > 0 && total > 0) {
        const before = Buffer.alloc(1);
        const beforeRead = fs.readSync(fh, before, 0, 1, start - 1);
        if (beforeRead > 0 && before[0] !== 0x0a) {
          const nl = text.indexOf('\n');
          text = nl >= 0 ? text.slice(nl + 1) : '';
        }
      }
      return text.split('\n');
    } catch (_) {
      return [];
    } finally {
      if (fh !== undefined) try { fs.closeSync(fh); } catch (_) {}
    }
  }

  // Non-blocking variant for HTTP handlers so a busy journal read does not
  // pause uploads/downloads on Node's event loop. It uses the service's injected
  // fs implementation and handles short descriptor reads defensively.
  async function readLogTailAsync(maxBytes) {
    if (!LOG_FILE) return [];
    let fd = null;
    let closeFd = null;
    try {
      const io = getDescriptorIo();
      closeFd = io.closeFd;
      const { openFd, statFd, readFd } = io;
      fd = await openFd(LOG_FILE, 'r');
      const size = (await statFd(fd)).size;
      const want = Math.min(size, maxBytes);
      const start = size - want;
      const buf = Buffer.alloc(want);
      let total = 0;
      while (total < want) {
        const result = await readFd(fd, buf, total, want - total, start + total);
        const bytesRead = Math.max(0, Number(result && result.bytesRead) || 0);
        if (!bytesRead) break;
        total += bytesRead;
      }
      let text = buf.subarray(0, total).toString('utf8');
      if (start > 0 && total > 0) {
        const before = Buffer.alloc(1);
        const result = await readFd(fd, before, 0, 1, start - 1);
        if ((Number(result && result.bytesRead) || 0) > 0 && before[0] !== 0x0a) {
          const nl = text.indexOf('\n');
          text = nl >= 0 ? text.slice(nl + 1) : '';
        }
      }
      return text.split('\n');
    } catch (_) {
      return [];
    } finally {
      if (fd !== null && closeFd) try { await closeFd(fd); } catch (_) {}
    }
  }

  function recordStat(t, completed) {
    const state = getState();
    if (!state.stats || typeof state.stats !== 'object') state.stats = {};
    const key = t.shareId || 'unknown';
    const dir = (t.direction || 'down') === 'up' ? 'up' : 'down';
    const share = getById(t.shareId);
    const cur = state.stats[key] || {
      name: (share && share.name) || t.name || key,
      type: (share && share.type) || t.type || dir,
      count: 0, bytes: 0, up: 0, down: 0, completed: 0, interrupted: 0, lastAt: 0,
    };
    if (share && share.name) cur.name = share.name;
    cur.count += 1;
    cur.bytes += t.bytes || 0;
    cur[dir] += 1;
    if (completed) cur.completed += 1; else cur.interrupted += 1;
    cur.lastAt = Date.now();
    state.stats[key] = cur;
    if (t.recipientToken) {
      const rc = recipientRecord(t.recipientToken);
      if (rc && rc.recipient) {
        const rs = rc.recipient.stats || { count:0, bytes:0, completed:0, interrupted:0, lastAt:0 };
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

  function pruneHistory() {
    const state = getState();
    if (!Array.isArray(state.history)) state.history = [];
    const days = Math.floor(Number(typeof getSettings === 'function' ? getSettings().historyRetentionDays : 0));
    const before = state.history.length;
    if (Number.isFinite(days) && days > 0) {
      const cutoff = Date.now() - days * 86400000;
      state.history = state.history.filter((r) => (r.endedAt || r.startedAt || 0) >= cutoff);
    }
    if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    return state.history.length !== before;
  }

  function endTransfer(t, completed, reason = null) {
    if (!t || t.ended) return;
    t.ended = true;
    activeTransfers.delete(t.id);
    if (typeof schedulePresenceBroadcast === 'function') schedulePresenceBroadcast();
    if (t.transient) {
      // Managed range fragments are normally incompatible with one-time links,
      // but never let an unexpected future caller strand the per-share claim.
      if (t.burnClaim && t.shareId) releaseOneTimeDownload(t.shareId, t.burnClaim);
      return;
    }

    const endedAt = Date.now();
    const durationMs = endedAt - t.startedAt;
    const record = {
      id:t.id,
      shareId:t.shareId || null,
      ownerId:t.ownerId || null,
      ownerName:t.ownerName || null,
      recipientName:t.recipientName || null,
      sender:t.sender || null,
      name:t.name,
      type:t.type,
      isZip:!!t.isZip,
      direction:t.direction || 'down',
      ip:t.ip,
      country:t.country,
      countryCode:t.countryCode,
      flag:t.flag,
      bytes:t.bytes,
      durationMs,
      startedAt:t.startedAt,
      endedAt,
      completed:!!completed,
      reason:completed ? null : String(reason || t.failureReason || 'interrupted').slice(0, 80),
      resumed:!!t.resumed,
      resumeOffset:Math.max(0, Number(t.resumeOffset) || 0),
      avgBps:durationMs > 0 ? Math.round((t.bytes / durationMs) * 1000) : 0,
      members:Array.isArray(t.members) && t.members.length ? t.members.slice(0,500) : undefined,
      membersTruncated:!!t.membersTruncated,
    };
    const state = getState();
    if (!Array.isArray(state.history)) state.history = [];
    state.history.unshift(record);
    if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    pruneHistory();
    recordStat(t, completed);
    appendLog(record);

    const meaningfulCompletedTransfer = completed && t.shareId && ((t.direction || 'down') === 'up' || !!t.notify);
    if (meaningfulCompletedTransfer) {
      const sh = getById(t.shareId);
      if (sh) {
        const summary = { at:endedAt, name:String(t.name || sh.name || '').slice(0,240), bytes:Math.max(0,Number(t.bytes)||0), ip:String(t.ip||'').slice(0,80), country:String(t.country||'').slice(0,80) };
        if ((t.direction || 'down') === 'up') sh.lastUpload = summary; else sh.lastDownload = summary;
        sh.lastUseAt = endedAt;
        if (sh.inactiveExpirySeconds) delete sh.inactiveExpiryWarnedDeadline;
        if (!sh.firstUsedAt) {
          sh.firstUsedAt = endedAt;
          const firstUseSeconds = Math.max(0, Number(sh.firstUseExpirySeconds) || 0);
          if (firstUseSeconds > 0) {
            sh.firstUseExpiresAt = endedAt + firstUseSeconds * 1000;
            delete sh.firstUseExpiryWarnedDeadline;
            if (typeof logAudit === 'function') logAudit('share-first-use-expiry-started', { username:'system', detail:(sh.type || 'share') + ' ' + (sh.name || '') + ` (${firstUseSeconds}s)` });
          }
        }
      }
    }

    const centerShare = t.shareId ? getById(t.shareId) : null;
    const centerInteresting = !!(centerShare && (completed ? meaningfulCompletedTransfer : ((t.direction || 'down') === 'up' || !!t.notify)));
    let primaryCenterNotification = null;
    if (centerInteresting) {
      const geo = { country:t.country || null, countryCode:t.countryCode || null, flag:t.flag || null };
      const failureReason = String(reason || t.failureReason || 'interrupted');
      const abandoned = !completed && Number(t.bytes || 0) > 0 && /^(?:aborted|connection-closed|timeout|stopped|cancelled|client-closed)$/.test(failureReason);
      const primaryType = completed ? 'transfer-complete' : abandoned ? ((t.direction || 'down') === 'up' ? 'upload-abandoned' : 'download-abandoned') : 'transfer-failed';
      if (typeof addShareCenterNotification === 'function') {
        primaryCenterNotification = addShareCenterNotification(centerShare, primaryType, {
          name:t.name || centerShare.name || '', bytes:Number(t.bytes)||0, ip:t.ip && typeof pubIp === 'function' ? pubIp(t.ip) : t.ip || null,
          country:t.country || null, flag:t.flag || '🌐', sender:t.sender || null,
          reason:completed ? null : failureReason, detail:(t.direction || 'down') === 'up' ? 'upload' : 'download', durationMs:abandoned ? durationMs : 0,
          dedupeKey:completed ? null : `${primaryType}:${t.id}`,
        });
      }
      if (typeof noteCenterCountry === 'function') noteCenterCountry(centerShare, t.ip, geo);
      if (typeof noteCenterActivity === 'function') noteCenterActivity(centerShare, primaryType, t.ip);
      if (completed && (t.direction || 'down') === 'down') {
        if (typeof noteCenterRepeatedDownload === 'function') noteCenterRepeatedDownload(centerShare, t.ip);
        if (typeof noteCenterHighVolume === 'function') noteCenterHighVolume(centerShare, t.bytes);
        if (typeof noteCenterViral === 'function') noteCenterViral(centerShare, 'download');
      }
      if (completed && (t.direction || 'down') === 'up') {
        if (typeof maybeCenterReceptionQuota === 'function') maybeCenterReceptionQuota(centerShare);
        if (!t.pendingModeration && typeof addShareCenterNotification === 'function') {
          addShareCenterNotification(centerShare, 'received-file-ready', {
            name:t.name || centerShare.name || '', bytes:Number(t.bytes)||0, sender:t.sender||null,
            ip:t.ip && typeof pubIp === 'function' ? pubIp(t.ip) : t.ip || null, country:t.country||null, flag:t.flag||'🌐',
            url:'/app/#receptions', dedupeKey:`received-ready:${t.id}`,
          });
        }
      }
      if (!completed && ['quota-full','max-files'].includes(String(reason || t.failureReason || '')) && typeof maybeCenterReceptionQuota === 'function') {
        maybeCenterReceptionQuota(centerShare);
      }
    }

    if (typeof emitLiveActivity === 'function') {
      emitLiveActivity(completed ? 'transfer-complete' : 'transfer-error', {
        shareId:t.shareId, name:t.name, direction:t.direction || 'down', bytes:t.bytes || 0,
        ip:typeof pubIp === 'function' ? pubIp(t.ip || '') : t.ip || '', status:completed ? 'completed' : 'interrupted',
        detail:completed ? (t.sender ? 'from ' + t.sender : null) : String(reason || t.failureReason || 'interrupted'),
      });
    }
    if (typeof scheduleFlush === 'function') scheduleFlush();
    if (completed && t.notify && typeof notify === 'function') {
      notify(t.direction === 'up' ? 'received' : 'downloaded', {
        name:t.name, ip:t.ip, country:t.country, bytes:t.bytes, sender:t.sender || null, shareId:t.shareId || null,
        suppressWebPush:!!(primaryCenterNotification && primaryCenterNotification.priority === 'low'),
      });
    }
    if (completed && (t.direction || 'down') === 'down' && typeof noteLeakSignal === 'function') noteLeakSignal(t);

    if (t.burnClaim && t.shareId) {
      const sh = getById(t.shareId);
      if (completed && t.notify && (t.direction || 'down') === 'down' && sh && sh.burnAfterDownload && !sh.revoked) {
        sh.revoked = true;
        sh.burnedAt = Date.now();
        if (typeof logAudit === 'function') logAudit('share-burned', { username:'system', detail:(sh.type || 'share') + ' ' + (sh.name || '') + ' (one-time link)' });
        if (typeof noteCenterAutoDisabled === 'function') noteCenterAutoDisabled(sh, 'one-time-download');
        if (typeof persist === 'function') persist();
      }
      releaseOneTimeDownload(t.shareId, t.burnClaim);
    }
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
        const ip = typeof pubIp === 'function' ? pubIp(t.ip) : t.ip;
        return {
          id:t.id, name:t.name, type:t.type, direction:t.direction || 'down', ip,
          ipName:typeof ipNameFor === 'function' ? ipNameFor(ip) : null,
          country:t.country, countryCode:t.countryCode, flag:t.flag,
          bytes:Number.isFinite(t.progressBytes) ? Math.max(0, t.progressBytes) : t.bytes,
          expectedBytes:t.expectedBytes || 0,
          isZip:!!t.isZip,
          zipTotalBytes:t.zipTotalBytes || 0,
          zipProcessedBytes:t.zipProcessedBytes || 0,
          durationMs,
          lastActivity,
          idleMs,
          stalled:durationMs >= TRANSFER_STALL_MS && idleMs >= TRANSFER_STALL_MS,
          stallThresholdMs:TRANSFER_STALL_MS,
          avgBps:durationMs > 0 ? Math.round((t.bytes / durationMs) * 1000) : 0,
          resumed:!!t.resumed,
          stopping:!!t.stopRequested,
          stoppable:typeof t.abort === 'function' && !t.stopRequested && !t.ended,
        };
      });
  }

  function clearRuntimeState() {
    oneTimeDownloadClaims.clear();
    // Restore is refused while transfers are active, but clearing defensively
    // prevents stale telemetry if a caller uses this reset outside restore.
    activeTransfers.clear();
  }

  function requestActiveTransferStop(t) {
    if (!t || t.ended || !activeTransfers.has(t.id)) return { ok:false, error:'not-found' };
    if (t.stopRequested) return { ok:true, stopping:true, alreadyRequested:true };
    if (typeof t.abort !== 'function') return { ok:false, error:'not-stoppable' };
    const previousFailureReason = t.failureReason;
    t.stopRequested = true;
    t.failureReason = 'stopped';
    try {
      t.abort();
      return { ok:true, stopping:true };
    } catch (_) {
      t.stopRequested = false;
      t.failureReason = previousFailureReason;
      return { ok:false, error:'stop-failed' };
    }
  }

  return {
    activeTransfers,
    claimOneTimeDownload,
    releaseOneTimeDownload,
    startTransfer,
    endTransfer,
    listTransfers,
    dashboardQueryOptions,
    dashboardRecordMatches,
    requestActiveTransferStop,
    pruneHistory,
    trimLogIfNeeded,
    readLogTail,
    readLogTailAsync,
    clearRuntimeState,
  };
}

module.exports = { createTransferService };
