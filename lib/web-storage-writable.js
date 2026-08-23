'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cleanRelativePath, connectorErrorCode, connectorHttpStatus } = require('./storage-connectors');

function connectorStatus(error) {
  const raw = String(error && error.code || 'connector-failed');
  if (raw === 'EINVAL' || raw === 'invalid-share') return 400;
  return connectorHttpStatus(connectorErrorCode(error), { public:true });
}

function createWebStorageWritableTools(options = {}) {
  const service = options.storageConnectorService, shareMeta = options.shareMeta, joinedPath = options.joinedPath, stat = options.stat, invalidate = options.invalidate;
  if (!service || typeof service.exportFile !== 'function' || typeof service.mkdir !== 'function' || typeof service.remove !== 'function') throw new TypeError('storageConnectorService writable methods are required');
  if (typeof shareMeta !== 'function' || typeof joinedPath !== 'function' || typeof stat !== 'function') throw new TypeError('web storage share tools are required');
  let activeOperations = 0;
  async function withActiveOperation(callback) {
    activeOperations += 1;
    try { return await callback(); }
    finally { activeOperations = Math.max(0, activeOperations - 1); }
  }
  function isBusyForStateReplacement() { return activeOperations > 0; }

  function writableMeta(share) {
    const meta = shareMeta(share);
    if (!meta || !share || !share.webStorage || meta.readOnly) throw Object.assign(new Error(meta && meta.readOnly ? 'connector-read-only' : 'invalid-web-storage-share'), { code:meta && meta.readOnly ? 'read-only' : 'invalid-share' });
    if (!meta.isDir) throw Object.assign(new Error('web-storage-root-not-directory'), { code:'not-dir' });
    return meta;
  }
  async function exists(share, relative) {
    try { return await stat(share, relative, { fresh:true }); }
    catch (error) { if (['remote-not-found','connector-not-found'].includes(String(error && error.code)) || /not found/i.test(String(error && error.message || ''))) return null; throw error; }
  }
  async function reserveUnique(share, relativeDir, filename) {
    writableMeta(share);
    const dir = cleanRelativePath(relativeDir || ''), safeName = cleanRelativePath(filename, false);
    if (dir === null || safeName === null || safeName.includes('/')) throw Object.assign(new Error('invalid-remote-path'), { code:'EINVAL' });
    const ext = path.posix.extname(safeName), base = safeName.slice(0, safeName.length - ext.length);
    for (let i=0;i<=9999;i++) {
      const name=i===0?safeName:`${base} (${i})${ext}`, rel=[dir,name].filter(Boolean).join('/');
      if (!(await exists(share, rel))) return rel;
    }
    return [dir, `${base}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`].filter(Boolean).join('/');
  }
  async function publishFile(share, localPath, relative, options = {}) {
    return withActiveOperation(async () => {
      const meta=writableMeta(share), full=joinedPath(share,relative);
      if (full===null) throw Object.assign(new Error('invalid-remote-path'),{code:'EINVAL'});
      const result = await service.exportFile(meta,localPath,full,options);
      if (typeof invalidate === 'function') invalidate(share, relative, false);
      return result;
    });
  }
  async function mkdir(share, relative, options = {}) {
    return withActiveOperation(async () => {
      const meta=writableMeta(share), full=joinedPath(share,relative);
      if (full===null || !cleanRelativePath(relative,false)) throw Object.assign(new Error('invalid-remote-path'),{code:'EINVAL'});
      const result = await service.mkdir(meta,full,options);
      if (typeof invalidate === 'function') invalidate(share, relative, false);
      return result;
    });
  }
  async function remove(share, relative, options = {}) {
    return withActiveOperation(async () => {
      const meta=writableMeta(share), full=joinedPath(share,relative);
      if (full===null || !cleanRelativePath(relative,false)) throw Object.assign(new Error('invalid-remote-path'),{code:'EINVAL'});
      const result = await service.remove(meta,full,options);
      if (typeof invalidate === 'function') invalidate(share, relative, true);
      return result;
    });
  }
  async function metrics(share, relative, options = {}) {
    return withActiveOperation(async () => {
      const meta=writableMeta(share), full=joinedPath(share,relative);
      if (full===null || !cleanRelativePath(relative,false)) throw Object.assign(new Error('invalid-remote-path'),{code:'EINVAL'});
      if (typeof service.metrics==='function') return service.metrics(meta,full,options);
      const row=await stat(share,relative,{fresh:true});
      return row&&row.isDir?{bytes:0,files:0}:{bytes:Math.max(0,Number(row&&row.size)||0),files:row?1:0};
    });
  }
  const TRACKED_MAX = 20000;
  function trackedStore(share, create = false) {
    if (!share || typeof share !== 'object') return null;
    const existing = share.webStorageUploaded;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
    if (!create) return null;
    share.webStorageUploaded = Object.create(null);
    return share.webStorageUploaded;
  }
  function trackPublished(share, relative, size) {
    const rel = cleanRelativePath(relative, false);
    if (rel === null) return false;
    const store = trackedStore(share, true);
    if (!Object.prototype.hasOwnProperty.call(store, rel) && Object.keys(store).length >= TRACKED_MAX) return false;
    Object.defineProperty(store, rel, { value:Math.max(0, Number(size) || 0), writable:true, enumerable:true, configurable:true });
    return true;
  }
  function releaseTracked(share, relative) {
    const rel = cleanRelativePath(relative, false), store = trackedStore(share, false);
    if (rel === null || !store) return 0;
    const prefix = rel + '/';
    let bytes = 0, changed = false;
    for (const [key, value] of Object.entries(store)) {
      if (key !== rel && !key.startsWith(prefix)) continue;
      bytes += Math.max(0, Number(value) || 0);
      delete store[key]; changed = true;
    }
    if (changed && Object.keys(store).length === 0) delete share.webStorageUploaded;
    return bytes;
  }
  function sanitizeTracked(share) {
    if (!share || typeof share !== 'object') return 0;
    const source = trackedStore(share, false);
    if (!source) { delete share.webStorageUploaded; return 0; }
    const limit = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(share.bytesReceived) || 0)));
    const clean = Object.create(null);
    let count = 0, total = 0;
    for (const [rawKey, rawValue] of Object.entries(source)) {
      if (count >= TRACKED_MAX) break;
      const rel = cleanRelativePath(rawKey, false), size = Number(rawValue);
      if (rel === null || !Number.isSafeInteger(size) || size < 0) continue;
      if (total + size > limit) continue;
      Object.defineProperty(clean, rel, { value:size, writable:true, enumerable:true, configurable:true });
      total += size; count += 1;
    }
    if (count) share.webStorageUploaded = clean; else delete share.webStorageUploaded;
    return total;
  }
  return {
    writableMeta, exists, reserveUnique, publishFile, mkdir, remove, metrics,
    trackPublished, releaseTracked, sanitizeTracked, isBusyForStateReplacement,
  };
}

function parseUploadByteCount(value) {
  const raw = String(value == null ? '' : value);
  if (!/^\d+$/.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function createWebStorageUploadHandler(options = {}) {
  const tools = options.tools, d = options.deps || {};
  if (!tools || !d.PARTS_DIR) throw new TypeError('web storage upload dependencies are required');
  const must = ['safeUploadRelPath','safeUploadId','scopedUploadId','partPath','completedUploadReceipt','rememberCompletedUpload','cleanSenderName','senderSubdirSegs','senderTaggedName','uploadSenderKey','inboxRejectReason','perSenderRejectReason','inboxRejectStatus','beginPublicUpload','effMaxUpload','startTransfer','endTransfer','withShareUploadLock','clamavEnabled','scanGate','inboxContentReason','rejectSuspendedUploadFinalize','hashFileSha256','applyReceptionAccountingState','persistNow','finalizeReceptionAccountingEffects','recordRansomwareEvent'];
  for (const key of must) if (typeof d[key] !== 'function') throw new TypeError(`missing upload dependency: ${key}`);

  async function finalize(req, res, s, ctx, part, transfer) {
    if (ctx.uploadId) d.uploadsInFlight.delete(ctx.uploadId);
    const finishFail = async (code, status, removePart) => {
      if (removePart) { try { await fs.promises.unlink(part); } catch (_) {} }
      if (transfer && transfer.uploadId) d.uploadTransfers.delete(transfer.uploadId);
      d.endTransfer(transfer, false, code);
      if (!res.headersSent) res.status(status).json({ error:code, offset:removePart ? undefined : transfer && transfer.bytes });
    };
    if (d.clamavEnabled() && !(await d.scanGate(part, ctx.parsed.filename, s, req))) return finishFail('infected', 422, true);
    if (await d.inboxContentReason(s, part)) return finishFail('content-blocked', 415, true);
    if (await d.rejectSuspendedUploadFinalize(s, part, transfer, res)) return;
    let size;
    try { size = (await fs.promises.stat(part)).size; }
    catch (_) { return finishFail('write-error', 500, false); }
    let sha = ctx.clientSha256;
    if (sha) {
      try { sha = await d.hashFileSha256(part); }
      catch (_) { return finishFail('hash-failed', 500, false); }
      if (sha !== ctx.clientSha256) return finishFail('hash-mismatch', 409, true);
    }
    const result = await d.withShareUploadLock(s.id, async () => {
      const finalReason = d.inboxRejectReason(s, ctx.relForCheck, size) || d.perSenderRejectReason(s, req, ctx.senderName, size);
      if (finalReason) return { error:finalReason };
      const storeName = s.tagBySender && ctx.senderName ? d.senderTaggedName(ctx.senderName, ctx.parsed.filename) : ctx.parsed.filename;
      const remoteDir = [...ctx.senderSegs, ...ctx.parsed.dirSegs].join('/');
      let remoteRel;
      try { remoteRel = await tools.reserveUnique(s, remoteDir, storeName); }
      catch (error) { return { error:String(error && error.code || 'connector-failed'), connector:true }; }
      try { await tools.publishFile(s, part, remoteRel); }
      catch (error) { return { error:String(error && error.code || 'connector-failed'), connector:true, remoteRel }; }
      const before = JSON.parse(JSON.stringify(s));
      const accounting = d.applyReceptionAccountingState(s, { size, senderKey:d.uploadSenderKey(s, req, ctx.senderName), sha:'', dest:'', expireSec:0 });
      if (typeof tools.trackPublished === 'function') tools.trackPublished(s, remoteRel, size);
      if (!d.persistNow()) {
        try { await tools.remove(s, remoteRel, { isDir:false }); } catch (_) {}
        if (typeof d.restorePlainObject === 'function') d.restorePlainObject(s, before);
        return { error:'write-error' };
      }
      return { accounting, remoteRel };
    });
    if (result.error) {
      if (result.connector && ctx.uploadId) {
        if (transfer && transfer.uploadId) d.uploadTransfers.delete(transfer.uploadId);
        d.endTransfer(transfer, false, result.error);
        if (!res.headersSent) return res.status(connectorStatus({ code:result.error })).json({ error:result.error, offset:size });
        return;
      }
      const keepForRetry = !!ctx.uploadId && result.error === 'write-error';
      return finishFail(result.error, result.connector ? connectorStatus({ code:result.error }) : result.error === 'write-error' ? 503 : d.inboxRejectStatus(result.error), !keepForRetry);
    }
    try { await fs.promises.unlink(part); } catch (_) {}
    if (transfer && transfer.uploadId) d.uploadTransfers.delete(transfer.uploadId);
    d.finalizeReceptionAccountingEffects(s, result.accounting);
    d.recordRansomwareEvent(req, 'upload', result.remoteRel, 1);
    if (typeof d.scheduleSearchReindex === 'function') d.scheduleSearchReindex();
    if (transfer) transfer.sender = ctx.senderName || null;
    if (s.type === 'inbox' && typeof d.emitInboxEvent === 'function') {
      try { d.emitInboxEvent(s, { type:'received', name:path.posix.basename(result.remoteRel), dest:s.name || '', at:Date.now(), sender:ctx.senderName || undefined }); } catch (_) {}
    }
    d.endTransfer(transfer, true);
    const response = { ok:true, complete:true, name:path.posix.basename(result.remoteRel), path:result.remoteRel, filesReceived:s.downloads || 0, bytesReceived:s.bytesReceived || 0, webStorage:true };
    d.rememberCompletedUpload(ctx.uploadId, size, ctx.relForCheck, response);
    if (!res.headersSent) res.json(response);
  }

  return async function handleWebStorageUpload(req, res, s) {
    if (!s.webStorage || s.moderated || s.encrypted) { req.resume(); return res.status(409).json({ error:s.moderated ? 'web-storage-moderation-unavailable' : 'web-storage-encryption-unavailable' }); }
    const senderName = d.cleanSenderName(req);
    if (s.requireSenderName && !senderName) { req.resume(); return res.status(400).json({ error:'sender-required' }); }
    const parsed = d.safeUploadRelPath(req.query.path != null ? req.query.path : req.query.name);
    if (!parsed) { req.resume(); return res.status(400).json({ error:'invalid-name' }); }
    const relForCheck = [...parsed.dirSegs, parsed.filename].join('/'), senderSegs = d.senderSubdirSegs(s, req);
    const hasDeclaredSize = req.query.size != null;
    const declared = hasDeclaredSize ? parseUploadByteCount(req.query.size) : null;
    const contentLength = req.headers['content-length'] == null ? null : parseUploadByteCount(req.headers['content-length']);
    const id = d.safeUploadId(req.query.id);
    if ((hasDeclaredSize && declared === null) || (id && declared === null)) { req.resume(); return res.status(400).json({ error:'invalid-size' }); }
    const total = declared !== null ? declared : (contentLength !== null ? contentLength : 0);
    const uploadId = id ? d.scopedUploadId(s, id) : null, clientSha256 = d.validSha256Hex ? d.validSha256Hex(req.query.sha256) : '';
    const receipt = d.completedUploadReceipt(uploadId);
    if (receipt) {
      req.resume();
      if (receipt.size !== total || receipt.path !== relForCheck) return res.status(409).json({ error:'upload-id-conflict', offset:receipt.size, complete:true });
      return res.json({ ...receipt.response, ok:true, complete:true, duplicate:true });
    }
    if (uploadId && d.stoppedUploads && d.stoppedUploads.has(uploadId)) { req.resume(); return res.status(403).json({ error:'stopped' }); }
    const reason = d.inboxRejectReason(s, relForCheck, total) || d.perSenderRejectReason(s, req, senderName, total);
    if (reason) { req.resume(); return res.status(d.inboxRejectStatus(reason)).json({ error:reason }); }
    if (!d.beginPublicUpload(req, res)) return;
    try { await fs.promises.mkdir(d.PARTS_DIR, { recursive:true, mode:0o700 }); }
    catch (_) { req.resume(); return res.status(503).json({ error:'write-error' }); }
    const part = id ? d.partPath(s, id) : path.join(d.PARTS_DIR, `web-${s.id}-${crypto.randomBytes(10).toString('hex')}.part`);
    let offset = 0;
    try { offset = id ? (await fs.promises.stat(part)).size : 0; } catch (_) {}
    const requestedOffset = Math.max(0, Number(req.query.offset) || 0);
    if (id && requestedOffset !== offset) { req.resume(); return res.status(409).json({ error:'offset-mismatch', offset }); }
    if (offset > total) { try { await fs.promises.unlink(part); } catch (_) {} req.resume(); return res.status(409).json({ error:'upload-size-mismatch', offset:0 }); }
    if (uploadId && d.uploadsInFlight.has(uploadId)) { req.resume(); return res.status(409).json({ error:'upload-busy', offset }); }

    let transfer = uploadId ? d.uploadTransfers.get(uploadId) : null;
    if (transfer && (String(transfer.name || '') !== relForCheck || Number(transfer.expectedBytes || 0) !== total)) {
      req.resume(); return res.status(409).json({ error:'upload-id-conflict', offset });
    }
    if (uploadId) d.uploadsInFlight.add(uploadId);
    if (!transfer) {
      transfer = d.startTransfer(req, { shareId:s.id, name:relForCheck, type:s.type, direction:'up' }, total);
      transfer.notify = true; transfer.uploadId = uploadId;
      if (uploadId) d.uploadTransfers.set(uploadId, transfer);
    }
    transfer.lastActivity = Date.now(); transfer.bytes = offset;
    if (offset > 0) { transfer.resumed = true; transfer.resumeOffset = Math.max(Number(transfer.resumeOffset) || 0, offset); }

    let failed = false, written = offset, reqEnded = false;
    const fail = (code, keep = !!id) => {
      if (failed) return; failed = true;
      if (uploadId) d.uploadsInFlight.delete(uploadId);
      try { req.unpipe(ws); ws.destroy(); if (!req.destroyed) req.resume(); } catch (_) {}
      if (!keep) {
        try { fs.unlink(part, () => {}); } catch (_) {}
        if (uploadId) d.uploadTransfers.delete(uploadId);
        d.endTransfer(transfer, false, code);
      }
      if (!res.headersSent) res.status(code === 'aborted' ? 499 : d.inboxRejectStatus(code)).json({ error:code, offset:written });
    };
    const ws = fs.createWriteStream(part, { flags:offset ? 'a' : 'w', mode:0o600 });
    transfer.abort = () => {
      if (uploadId && d.stoppedUploads) d.stoppedUploads.set(uploadId, Date.now() + 3600 * 1000);
      if (!failed) return fail('stopped', false);
      if (uploadId) { d.uploadsInFlight.delete(uploadId); d.uploadTransfers.delete(uploadId); }
      try { fs.unlink(part, () => {}); } catch (_) {}
      d.endTransfer(transfer, false, 'stopped');
    };
    req.on('end', () => { reqEnded = true; });
    req.on('close', () => { if (!reqEnded && !failed) fail('aborted', true); });
    req.on('aborted', () => fail('aborted', true));
    req.on('error', () => fail('aborted', true));
    ws.on('error', () => fail('write-error', true));
    const maxUp = d.effMaxUpload();
    req.on('data', (chunk) => {
      if (failed) return;
      written += chunk.length; transfer.bytes += chunk.length; transfer.lastActivity = Date.now();
      if (written > total) fail('file-too-large', false);
      else if (maxUp > 0 && written > maxUp) fail('too-large', false);
      else if (s.maxFileBytes > 0 && written > s.maxFileBytes) fail('file-too-large', false);
    });
    ws.on('finish', () => {
      if (failed) return;
      if (written < total) {
        if (uploadId) d.uploadsInFlight.delete(uploadId);
        if (!res.headersSent) res.status(409).json({ error:'incomplete', offset:written });
        return;
      }
      void finalize(req, res, s, { uploadId, parsed, relForCheck, senderName, senderSegs, clientSha256 }, part, transfer).catch(async (error) => {
        if (uploadId) { d.uploadsInFlight.delete(uploadId); d.uploadTransfers.delete(uploadId); }
        d.endTransfer(transfer, false, 'write-error');
        if (!uploadId) { try { await fs.promises.unlink(part); } catch (_) {} }
        if (!res.headersSent) res.status(503).json({ error:'write-error', offset:written });
      });
    });
    req.pipe(ws);
  };
}

module.exports={createWebStorageWritableTools,createWebStorageUploadHandler,connectorStatus};
