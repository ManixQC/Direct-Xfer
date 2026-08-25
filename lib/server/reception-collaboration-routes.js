'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Registers public reception/collaboration upload routes.
 *
 * This boundary owns visitor-facing reception and collaboration orchestration:
 * folder browsing/mutation, resumable upload endpoints, dedupe handshakes,
 * ransomware gates, upload cancellation/status and reception conversations.
 * Upload accounting/staging primitives are provided by upload-reception-service.
 */
function attachReceptionCollaborationRoutes(deps = {}) {
  const {
    DEDUPE_CHALLENGE_TTL_MS,
    INBOX_DIR,
    PARTS_DIR,
    PENDING_DIR,
    ZIP_SELECTION_MAX,
    acceptsUpload,
    addShareCenterNotification,
    anomalyClientIp,
    anomalyWindows,
    appendReceptionThreadMessage,
    applyReceptionAccountingState,
    assertRealWithin,
    beginPublicUpload,
    blockRansomwareClient,
    bumpSenderStat,
    bumpViews,
    clamavEnabled,
    clampExpireSec,
    cleanConnectorPath,
    cleanSenderName,
    cleanupDedupeChallenges,
    clientIp,
    collabPage,
    collabRoot,
    completedUploadReceipt,
    connectorErrorCode,
    createWebStorageUploadHandler,
    dedupeChallenges,
    deleteFileExpiryForPath,
    downloadRouter,
    effMaxUpload,
    emitInboxEvent,
    emitLiveActivity,
    endTransfer,
    express,
    fileExpiryMap,
    finalizeReceptionAccountingEffects,
    findDedupeCandidate,
    folderBytes,
    geoSync,
    geolocate,
    getByToken,
    getSettings,
    hashFileSha256,
    inboxContentReason,
    inboxPage,
    inboxRejectReason,
    inboxRejectStatus,
    incrementDownloads,
    isAccessApproved,
    isActive,
    isLoopback,
    isUnlocked,
    listDir,
    logAudit,
    makeDedupeRanges,
    notificationAccountIdForShare,
    notify,
    parseSelList,
    partPath,
    passwordPage,
    perSenderRejectReason,
    persistNow,
    pickLang,
    pruneAnomalyEvents,
    pubIp,
    publicMessageDecision,
    publicThreadMessage,
    ransomwareBlocked,
    ransomwareShareBlocked,
    receptionDuplicateReason,
    receptionDuplicateStoredPath,
    receptionHashSeen,
    receptionMetadataPath,
    receptionThreadArray,
    receptionThreadEnabled,
    recordFileExpiry,
    rememberCompletedUpload,
    rememberDedupeFile,
    rememberReceptionHash,
    reserveUniqueUploadPath,
    resolveWithin,
    restorePlainObject,
    restorePublicMessageDecision,
    rollbackAcceptedUploadFile,
    rollbackReceptionAccountingState,
    safeUploadByteCount,
    safeUploadFolderName,
    safeUploadId,
    safeUploadParentSegments,
    safeUploadRelPath,
    scanGate,
    scheduleFlush,
    scheduleSearchReindex,
    scopedUploadId,
    selParser,
    selectionToItems,
    sendError,
    sendSha256Manifest,
    senderSubdirSegs,
    senderTaggedName,
    serveFolderFile,
    serveFolderZip,
    serveWebStorageFile,
    shareManifestFiles,
    snapshotPublicMessageDecision,
    startTransfer,
    stashPending,
    stoppedUploads,
    streamZipFiles,
    suspiciousRansomwareName,
    uploadSenderKey,
    uploadTransfers,
    uploadsInFlight,
    validSha256Hex,
    verifyAndRememberDedupe,
    verifyDedupeProof,
    webStorageConnectorStatus,
    webStorageList,
    webStorageStat,
    webStorageWritable,
    withShareUploadLock,
    live,
  } = deps;

  if (!downloadRouter || typeof downloadRouter.get !== 'function') throw new TypeError('reception-collaboration-routes requires downloadRouter');
  if (!live || typeof live !== 'object') throw new TypeError('reception-collaboration-routes requires live bindings');
  function ransomwareGate(req, res) {
    const share = getByToken(req && req.params && req.params.token);
    const linkRec = share && ransomwareShareBlocked(share.id);
    if (linkRec) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((linkRec.until - Date.now()) / 1000))));
      res.status(423).json({ error:'security-link-suspended', reason:linkRec.reason, until:linkRec.until });
      return false;
    }
    const rec = ransomwareBlocked(clientIp(req));
    if (!rec) return true;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rec.until - Date.now()) / 1000))));
    res.status(423).json({ error: 'security-blocked', reason: rec.reason, until: rec.until });
    return false;
  }
  function recordRansomwareEvent(req, kind, name, count) {
    if (getSettings().ransomwareProtection === false) return null;
    const ip = anomalyClientIp(req);
    if (!ip || isLoopback(ip)) return null;
    const now = Date.now();
    const arr = pruneAnomalyEvents(ip, now);
    const affected = getByToken(req && req.params && req.params.token);
    const shareId = acceptsUpload(affected) ? affected.id : null;
    const event = { at: now, kind, shareId, count: Math.max(1, Number(count) || 1), suspicious: suspiciousRansomwareName(name), name: String(name || '').slice(0, 180) };
    arr.push(event); anomalyWindows.set(ip, arr);
    const deletes60 = arr.filter((e) => e.kind === 'delete' && now - e.at <= 60000).reduce((n, e) => n + e.count, 0);
    const uploads120 = arr.filter((e) => e.kind === 'upload').reduce((n, e) => n + e.count, 0);
    const suspicious120 = arr.filter((e) => e.kind === 'upload' && e.suspicious).reduce((n, e) => n + e.count, 0);
    const cfg = getSettings();
    const configuredDeleteThreshold = Math.floor(Number(cfg.ransomwareDeleteThreshold));
    const deleteThreshold = Number.isFinite(configuredDeleteThreshold)
      ? Math.min(1000, Math.max(5, configuredDeleteThreshold)) : 25;
    const shareDeletes60 = shareId ? arr.filter((e) => e.shareId === shareId && e.kind === 'delete' && now - e.at <= 60000).reduce((n, e) => n + e.count, 0) : 0;
    if (deletes60 >= deleteThreshold) {
      return blockRansomwareClient(req, 'mass-delete', `${deletes60} file(s) / 60 s`, shareDeletes60 >= deleteThreshold ? [shareId] : []);
    }
    // A plain bulk upload is normal for Direct-Xfer. Require ransomware-like names
    // before blocking on upload volume, avoiding false positives on photo backups.
    const configuredUploadThreshold = Math.floor(Number(cfg.ransomwareUploadThreshold));
    const upThreshold = Number.isFinite(configuredUploadThreshold)
      ? Math.min(5000, Math.max(20, configuredUploadThreshold)) : 120;
    if (uploads120 >= upThreshold && suspicious120 >= Math.max(12, Math.floor(uploads120 / 2))) {
      const shareUploads = shareId ? arr.filter((e) => e.shareId === shareId && e.kind === 'upload') : [];
      const shareUploadCount = shareUploads.reduce((n, e) => n + e.count, 0);
      const shareSuspiciousCount = shareUploads.filter((e) => e.suspicious).reduce((n, e) => n + e.count, 0);
      const suspend = shareUploadCount >= upThreshold && shareSuspiciousCount >= Math.max(12, Math.floor(shareUploadCount / 2));
      return blockRansomwareClient(req, 'suspicious-upload-burst', `${uploads120} upload(s), ${suspicious120} ransomware-like name(s) / 120 s`, suspend ? [shareId] : []);
    }
    return null;
  }
  async function rejectSuspendedUploadFinalize(s, file, transfer, res) {
    const blocked = ransomwareShareBlocked(s && s.id);
    if (!blocked) return false;
    try { await fs.promises.unlink(file); } catch (_) {}
    if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
    endTransfer(transfer, false, 'security-link-suspended');
    if (!res.headersSent) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((blocked.until - Date.now()) / 1000))));
      res.status(423).json({ error:'security-link-suspended', reason:blocked.reason, until:blocked.until });
    }
    return true;
  }
  async function folderFileCountCapped(dir, cap) {
    let count = 0;
    async function walk(d) {
      if (count >= cap) return;
      let ents = [];
      try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (count >= cap) return;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else if (e.isFile()) count += 1;
      }
    }
    await walk(dir); return count;
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
    const sub = String(req.query.sub || '');
    if(s.webStorage){const cloudSub=cleanConnectorPath(sub);if(cloudSub===null)return res.status(400).json({error:'invalid-path'});try{const entries=await webStorageList(s,cloudSub);return res.json({sub:cloudSub,allowDelete:!!s.allowDelete,allowZip:false,bytesReceived:s.bytesReceived||0,maxTotalBytes:s.maxTotalBytes||0,entries});}catch(error){return res.status(webStorageConnectorStatus(error)).json({error:connectorErrorCode(error)});}}
    const root = collabRoot(s);
    try { await fs.promises.mkdir(root, { recursive: true }); } catch (_) {}
    let absDir;
    try {
      absDir = resolveWithin(root, sub);
      await assertRealWithin(root, absDir);
      if (!(await fs.promises.stat(absDir)).isDirectory()) return res.status(404).json({ error: 'not-dir' });
    } catch (_) { return res.status(404).json({ error: 'not-found' }); }
    const entries = await listDir(absDir, root);
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
    const s=requireActiveCollab(req,res);if(!s)return;
    if(s.webStorage){const rel=cleanConnectorPath(req.params[0]||'',false);if(rel===null)return sendError(req,res,404,'fileUnavailable');try{const st=await webStorageStat(s,rel);if(st.isDir)return sendError(req,res,404,'fileUnavailable');return serveWebStorageFile(req,res,s,rel,{filename:st.name||path.posix.basename(rel)||'download'});}catch(e){const code=connectorErrorCode(e);return sendError(req,res,(code==='remote-not-found'||code==='connector-not-found')?404:503,'fileUnavailable');}}
    try{await serveFolderFile(req,res,s,collabRoot(s),req.params[0]||'');}catch(e){sendError(req,res,e.code==='ENOENT'?404:403,'fileUnavailable');}
  });
  
  downloadRouter.get(['/c/:token/zip', '/c/:token/zip/*'], async (req, res) => {
    const s = requireActiveCollab(req, res);
    if (!s) return;
    if(s.webStorage)return sendError(req,res,404,'notFound');
    if (s.allowZip === false) return sendError(req, res, 404, 'notFound');
    try { await serveFolderZip(req, res, s, collabRoot(s), req.params[0] || '', s.name); }
    catch (_) { sendError(req, res, 404, 'folderNotFound'); }
  });
  
  downloadRouter.get(['/c/:token/sha256', '/c/:token/sha256/*'], async (req, res) => {
    const s = requireActiveCollab(req, res);
    if (!s) return;
    if(s.webStorage)return sendError(req,res,404,'notFound');
    try {
      const files = await shareManifestFiles(s, collabRoot(s), req.params[0] || '');
      await sendSha256Manifest(res, files, (s.name || 'files') + '.sha256');
    } catch (_) { sendError(req, res, 404, 'folderNotFound'); }
  });
  
  downloadRouter.post('/c/:token/zip-select', selParser, async (req, res) => {
    const s = requireActiveCollab(req, res);
    if (!s) return;
    if(s.webStorage)return sendError(req,res,404,'notFound');
    if (s.allowZip === false) return sendError(req, res, 404, 'notFound');
    const items = await selectionToItems(collabRoot(s), parseSelList(req.body.sel).slice(0, ZIP_SELECTION_MAX));
    if (!items.length) return sendError(req, res, 400, 'notFound');
    streamZipFiles(req, res, items, (s.name || 'selection'), () => incrementDownloads(s.id),
      { shareId: s.id, name: `${s.name || 'selection'} (${items.length} selected)`, type: 'collection-zip' });
  });
  
  
  const collabDeleteParser = express.json({ limit: '8kb' });
  downloadRouter.post('/c/:token/delete', collabDeleteParser, async (req, res) => {
    if (!ransomwareGate(req, res)) return;
    const s = getByToken(req.params.token);
    if (!s || s.type !== 'collab' || !isActive(s)) return res.status(403).json({ error: 'revoked' });
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
    if (!s.allowDelete) return res.status(403).json({ error: 'delete-disabled' });
    const rel = String((req.body && req.body.path) || '');
    if (!rel) return res.status(400).json({ error: 'missing-path' });
    if(s.webStorage){try{const outcome=await withShareUploadLock(s.id,async()=>{const st=await webStorageStat(s,rel,{fresh:true}),metrics=st.isDir?await webStorageWritable.metrics(s,rel):{files:1};const blocked=recordRansomwareEvent(req,'delete',rel,Math.max(1,metrics.files));if(blocked)return{blocked};await webStorageWritable.remove(s,rel,{isDir:!!st.isDir});const freed=webStorageWritable.releaseTracked(s,rel);if(freed)s.bytesReceived=Math.max(0,(s.bytesReceived||0)-freed);scheduleFlush();return{ok:true};});if(outcome.blocked){const blocked=outcome.blocked;res.setHeader('Retry-After',String(Math.max(1,Math.ceil((blocked.until-Date.now())/1000))));return res.status(423).json({error:'security-blocked',reason:blocked.reason,until:blocked.until});}logAudit('collab-delete',{username:'visitor',ip:clientIp(req),detail:(s.name||s.id)+': '+rel});return res.json({ok:true});}catch(error){const code=connectorErrorCode(error);return res.status((code==='remote-not-found'||code==='connector-not-found')?404:webStorageConnectorStatus(error)).json({error:code});}}
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
      // The configured delete threshold is capped at 1000 by settings validation;
      // keep filesystem counting independently bounded even after a corrupt restore.
      const deletedCount = st.isDirectory() ? await folderFileCountCapped(abs, 5000) : 1;
      // Count the requested destructive operation BEFORE carrying it out. If this
      // event crosses the threshold the operation that triggered the alarm is denied.
      const blocked = recordRansomwareEvent(req, 'delete', rel, Math.max(1, deletedCount));
      if (blocked) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((blocked.until - Date.now()) / 1000))));
        return res.status(423).json({ error: 'security-blocked', reason: blocked.reason, until: blocked.until });
      }
      if (st.isDirectory()) { freed = await folderBytes(abs); await fs.promises.rm(abs, { recursive: true, force: true }); }
      else { freed = st.size; await fs.promises.unlink(abs); }
      s.bytesReceived = Math.max(0, (s.bytesReceived || 0) - freed);
      scheduleFlush();
      logAudit('collab-delete', { username: 'visitor', ip: clientIp(req), detail: (s.name || s.id) + ': ' + rel });
      scheduleSearchReindex();
      res.json({ ok: true });
    } catch (_) { res.status(404).json({ error: 'not-found' }); }
  });
  
  
  // Creates one visitor-requested folder below the share's writable root. Parent
  // folders must already exist (except the optional sender/date prefix managed by
  // the server), and real-path checks prevent a symlink from escaping INBOX_DIR.
  const uploadFolderParser = express.json({ limit: '4kb' });
  async function handleCreateUploadFolder(req, res) {
    if (!ransomwareGate(req, res)) return;
    const s = getByToken(req.params.token);
    if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
  
    const body = req.body || {};
    const name = safeUploadFolderName(body.name);
    const parentSegs = safeUploadParentSegments(body.parent);
    if (!name || parentSegs === null) return res.status(400).json({ error: 'invalid-folder' });
    if(s.webStorage){try{const senderSegs=s.type==='inbox'?senderSubdirSegs(s,req):[],rel=[...senderSegs,...parentSegs,name].join('/'),result=await withShareUploadLock(s.id,async()=>{const parent=[...senderSegs,...parentSegs].join('/');if(senderSegs.length)await webStorageWritable.mkdir(s,senderSegs.join('/'));if(parentSegs.length){const pst=await webStorageStat(s,parent,{fresh:true});if(!pst.isDir)return{error:'invalid-folder',status:400};}if(await webStorageWritable.exists(s,rel))return{error:'folder-exists',status:409};await webStorageWritable.mkdir(s,rel);return{ok:true};});if(!result.ok)return res.status(result.status).json({error:result.error});logAudit('upload-folder-created',{username:'visitor',ip:clientIp(req),detail:(s.name||s.id)+': '+rel});return res.status(201).json({ok:true,name,path:[...parentSegs,name].join('/')});}catch(error){const code=connectorErrorCode(error);return res.status((code==='remote-not-found'||code==='connector-not-found')?404:webStorageConnectorStatus(error)).json({error:code});}}
  
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
  
  
  // Global SHA-256 deduplication (#5). The client hashes the exact payload before
  // uploading. The server never reveals the matching source path; it only reports a
  // hit/miss and materializes identical bytes into the requested writable share.
  const dedupeParser = express.json({ limit: '8kb' });
  async function materializeDedupe(req, res, s, body, sha, size, source) {
    const parsed = safeUploadRelPath(body.path) || null;
    if (!parsed) return res.status(400).json({ error: 'invalid-name' });
    const relForCheck = [...parsed.dirSegs, parsed.filename].join('/');
    // Dedupe reuses the visitor's declared name (query + body) exactly like /upload,
    // so the per-sender caps and running totals apply to the same identity.
    const senderName = cleanSenderName(req);
    const gate = inboxRejectReason(s, relForCheck, size) || perSenderRejectReason(s, req, senderName, size);
    if (gate) return res.status(inboxRejectStatus(gate)).json({ error: gate });
  
    // Reuse the same sender/date routing as ordinary reception uploads. The client
    // passes sender in the query string for parity with /upload.
    const senderSegs = senderSubdirSegs(s, req), expireSec = clampExpireSec(body.expire);
    let dir;
    try {
      dir = resolveWithin(INBOX_DIR, [s.relDir || '', ...senderSegs, ...parsed.dirSegs].join('/'));
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (_) { return res.status(500).json({ error: 'inbox-dir' }); }
  
    const outcome = await withShareUploadLock(s.id, async () => {
      const reason = inboxRejectReason(s, relForCheck, size) || perSenderRejectReason(s, req, senderName, size);
      if (reason) return { error: reason };
      let target;
      try { target = await reserveUniqueUploadPath(dir, parsed.filename); }
      catch (_) { return { error: 'write-error' }; }
      try {
        // COPYFILE_FICLONE requests copy-on-write where the filesystem supports it.
        // Otherwise Node performs a local server-side copy; either path avoids WAN upload.
        await fs.promises.copyFile(source, target, fs.constants.COPYFILE_FICLONE || 0);
      } catch (_) {
        try { await fs.promises.unlink(target); } catch (_) {}
        return { error: 'write-error' };
      }
      return { target };
    });
    if (outcome.error) {
      return res.status(outcome.error === 'write-error' ? 500 : inboxRejectStatus(outcome.error)).json({ error: outcome.error });
    }
    // Deduplication must not become a shortcut around the normal receive security
    // pipeline. Scan the materialized copy before it is counted or announced.
    if (clamavEnabled() && !(await scanGate(outcome.target, parsed.filename, s, req))) {
      return res.status(422).json({ error: 'infected' });
    }
    // A disguised executable must be refused here too; otherwise dedupe
    // would smuggle a blocked binary into a share whenever an identical copy already
    // exists server-side (e.g. an image folder that never enforced the executable ban).
    if (await inboxContentReason(s, outcome.target, parsed.filename)) {
      try { await fs.promises.unlink(outcome.target); } catch (_) {}
      return res.status(415).json({ error: 'content-blocked' });
    }
    const committed = await withShareUploadLock(s.id, async () => {
      const reason = inboxRejectReason(s, relForCheck, size) || perSenderRejectReason(s, req, senderName, size);
      if (reason) return { error: reason };
      // Refuse a byte-for-byte duplicate already received on this link.
      // The sha is proof-verified above (it matches the copied source), so pass it
      // straight through instead of re-hashing the freshly materialized file.
      const dupReason = await receptionDuplicateReason(s, outcome.target, sha);
      if (dupReason) return { error: dupReason };
      s.bytesReceived = (s.bytesReceived || 0) + size;
      bumpSenderStat(s, req, senderName, size); // per-sender running total
      incrementDownloads(s.id);
      return { ok: true };
    });
    if (committed.error) {
      try { await fs.promises.unlink(outcome.target); } catch (_) {}
      return res.status(inboxRejectStatus(committed.error)).json({ error: committed.error });
    }
    if (expireSec > 0) { try { recordFileExpiry(outcome.target, expireSec, s, path.basename(outcome.target)); } catch (_) {} }
    addShareCenterNotification(s,'received-file-ready',{name:path.basename(outcome.target),bytes:size,sender:senderName||null,ip:pubIp(clientIp(req)),url:'/app/#receptions',dedupeKey:`received-ready:dedupe:${s.id}:${sha}`});
    if (s.type === 'inbox') {
      try { emitInboxEvent(s, { type: 'received', name: path.basename(outcome.target), dest: s.name || '', at: Date.now(), deduped: true }); } catch (_) {}
    }
    const id = safeUploadId(body.id);
    if (id) { try { await fs.promises.unlink(partPath(s, id)); } catch (_) {} }
    let st;
    try { st = await fs.promises.stat(outcome.target); } catch (_) { st = null; }
    rememberDedupeFile(outcome.target, size, sha, st && st.mtimeMs);
    logAudit('upload-deduped', { username: 'visitor', ip: clientIp(req), detail: (s.name || s.id) + ': ' + relForCheck });
    return res.json({ ok: true, complete: true, deduped: true, name: path.basename(outcome.target), filesReceived: s.downloads || 0, bytesReceived: s.bytesReceived || 0 });
  }
  async function handleUploadDedupe(req, res) {
    const s = getByToken(req.params.token);
    if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
    // Moderated links must still enter the approval queue, so they intentionally use
    // the normal upload path instead of materializing a deduplicated file directly.
    if (s.webStorage) return res.json({ ok:true, deduped:false, reason:'web-storage' });
    if (s.moderated) return res.json({ ok: true, deduped: false, reason: 'moderated' });
  
    cleanupDedupeChallenges();
    const body = req.body || {}, sha = validSha256Hex(body.sha256), size = Number(body.size);
    if (!sha || !Number.isSafeInteger(size) || size < 0 || (effMaxUpload() > 0 && size > effMaxUpload())) {
      return res.status(400).json({ error: 'invalid-dedupe' });
    }
    const parsed = safeUploadRelPath(body.path) || null;
    if (!parsed) return res.status(400).json({ error: 'invalid-name' });
    const relForCheck = [...parsed.dirSegs, parsed.filename].join('/');
    // Fail fast on the same caps the streaming path enforces (materializeDedupe is the
    // authoritative re-check inside the lock, but rejecting here avoids issuing a
    // pointless possession challenge to a sender who is already over quota).
    const gate = inboxRejectReason(s, relForCheck, size) || perSenderRejectReason(s, req, cleanSenderName(req), size);
    if (gate) return res.status(inboxRejectStatus(gate)).json({ error: gate });
  
    // Second leg: prove possession of unpredictable byte ranges from the candidate.
    const challengeId = String(body.challenge || '');
    if (challengeId) {
      const challenge = dedupeChallenges.get(challengeId);
      dedupeChallenges.delete(challengeId); // one attempt only, successful or not
      if (!challenge || challenge.exp <= Date.now() || challenge.shareId !== s.id || challenge.sha !== sha || challenge.size !== size || challenge.ip !== clientIp(req)) {
        return res.status(409).json({ error: 'dedupe-challenge-expired', deduped: false });
      }
      let st;
      try { st = await fs.promises.stat(challenge.source); } catch (_) { st = null; }
      if (!st || !st.isFile() || st.size !== size || !(await verifyDedupeProof(challenge, body.proof))) {
        return res.status(403).json({ error: 'dedupe-proof-failed', deduped: false });
      }
      return materializeDedupe(req, res, s, body, sha, size, challenge.source);
    }
  
    // First leg: a hash match alone is NOT enough to copy cross-share content. Return
    // random byte ranges and require the browser to prove it possesses those bytes.
    const source = await findDedupeCandidate(size, sha);
    if (!source) return res.json({ ok: true, deduped: false });
    if (size === 0) return materializeDedupe(req, res, s, body, sha, size, source);
    const nonce = crypto.randomBytes(24).toString('hex'), ranges = makeDedupeRanges(size, nonce);
    dedupeChallenges.set(nonce, { source, sha, size, shareId: s.id, ip: clientIp(req), exp: Date.now() + DEDUPE_CHALLENGE_TTL_MS, ranges });
    return res.json({ ok: true, deduped: false, challenge: nonce, ranges });
  }
  downloadRouter.post('/u/:token/dedupe', dedupeParser, handleUploadDedupe);
  downloadRouter.post('/c/:token/dedupe', dedupeParser, handleUploadDedupe);
  
  // Resume support: how many bytes of this upload id are already on disk.
  // The PWA also uses this side-effect-free endpoint to validate a reception destination.
  // Returning the upload configuration here avoids loading /u/:token, whose GET is a real
  // public-page view and therefore intentionally calls bumpViews().
  
  function receptionUploadConfig(s) {
    return {
      maxFiles: s.maxFiles || 0,
      maxFileBytes: s.maxFileBytes || 0,
      maxTotalBytes: s.maxTotalBytes || 0,
      bytesReceived: s.bytesReceived || 0,
      filesReceived: s.downloads || 0,
      allowExt: Array.isArray(s.allowExt) ? s.allowExt : [],
      blockExt: Array.isArray(s.blockExt) ? s.blockExt : [],
      enc: s.encrypted ? { on: true, mode: s.encMode || 'key' } : null,
      groupBySender: !!s.groupBySender,
      requireSenderName: !!s.requireSenderName,
      rejectDuplicates: !!s.rejectDuplicates,
      blockExecutables: !!s.blockExecutables,
      moderated: !!s.moderated,
      maxFilesPerUpload: s.maxFilesPerUpload || 0,
      maxFilesPerSender: s.maxFilesPerSender || 0,
      maxBytesPerSender: s.maxBytesPerSender || 0,
    };
  }
  function handleUploadDuplicateCheck(req, res) {
    const s = getByToken(req.params.token);
    if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error:'revoked' });
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error:'locked' });
    const sha = validSha256Hex(req.query.sha256);
    if (!sha) return res.status(400).json({ error:'invalid-sha256' });
    if(s.webStorage){res.setHeader('Cache-Control','no-store');return res.json({duplicate:false,existingName:null,policy:'allow'});}
    const duplicate = receptionHashSeen(s, sha);
    const stored = duplicate ? receptionDuplicateStoredPath(s, sha) : null;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      duplicate,
      existingName: stored ? path.basename(stored) : null,
      policy: s.rejectDuplicates ? 'reject' : 'allow',
    });
  }
  downloadRouter.get('/u/:token/duplicate-check', handleUploadDuplicateCheck);
  downloadRouter.get('/c/:token/duplicate-check', handleUploadDuplicateCheck);
  
  function handleUploadStatus(req, res) {
    const s = getByToken(req.params.token);
    if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
    const id = safeUploadId(req.query.id);
    const receipt = id ? completedUploadReceipt(scopedUploadId(s, id)) : null;
    let offset = 0;
    if (receipt) offset = receipt.size;
    else if (id) { try { offset = fs.statSync(partPath(s, id)).size; } catch (_) {} }
    const payload = receipt ? { offset, complete:true, response:receipt.response } : { offset };
    if (String(req.query.config || '') === '1') payload.config = receptionUploadConfig(s);
    res.json(payload);
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
  
  const webStorageUploadHandler=createWebStorageUploadHandler({tools:webStorageWritable,deps:{PARTS_DIR,safeUploadRelPath,safeUploadId,scopedUploadId,partPath,completedUploadReceipt,rememberCompletedUpload,cleanSenderName,senderSubdirSegs,senderTaggedName,uploadSenderKey,inboxRejectReason,perSenderRejectReason,inboxRejectStatus,beginPublicUpload,effMaxUpload,startTransfer,endTransfer,withShareUploadLock,clamavEnabled,scanGate,inboxContentReason,rejectSuspendedUploadFinalize,hashFileSha256,applyReceptionAccountingState,persistNow,finalizeReceptionAccountingEffects,recordRansomwareEvent,restorePlainObject,scheduleSearchReindex,emitInboxEvent,validSha256Hex,uploadsInFlight,uploadTransfers,stoppedUploads}});
  
  
  // Receiving a file. Resumable: the body carries the bytes FROM ?offset= to the end;
  // they are appended to a .part file keyed by ?id=, moved into the destination tree
  // once it reaches ?size=. An interrupted upload keeps its .part so the visitor can
  // resume from the current offset. Legacy single-shot (no id) still works. The path
  // comes via ?path= (folder upload, tree preserved) or ?name= (single file). Shared
  // by reception links (/u/) and collaboration links (/c/).
  async function handleUpload(req, res) {
    if (!ransomwareGate(req, res)) { req.resume(); return; }
    const s = getByToken(req.params.token);
    if (!acceptsUpload(s) || !isActive(s)) return res.status(403).json({ error: 'revoked' });
    if (s.pwHash && !isUnlocked(req, s)) return res.status(401).json({ error: 'locked' });
    if(s.webStorage)return webStorageUploadHandler(req,res,s);
    // Some links require the visitor to identify themselves.
    const senderName = cleanSenderName(req);
    if (s.requireSenderName && !senderName) { req.resume(); return res.status(400).json({ error: 'sender-required' }); }
  
    const relRaw = req.query.path != null ? req.query.path : req.query.name;
    const parsed = safeUploadRelPath(relRaw) || { dirSegs: [], filename: 'file' };
    const relForCheck = [...parsed.dirSegs, parsed.filename].join('/');
    const senderSegs = senderSubdirSegs(s, req); // <sender>/<date>/ prefix (or [])
  
    const hasDeclaredSize = req.query.size != null;
    const declared = hasDeclaredSize ? safeUploadByteCount(req.query.size) : null;
    const clen = req.headers['content-length'] == null ? null : safeUploadByteCount(req.headers['content-length']);
    const id = safeUploadId(req.query.id);
    if ((hasDeclaredSize && declared === null) || (id && declared === null)) { req.resume(); return res.status(400).json({ error:'invalid-size' }); }
    const total = declared !== null ? declared : (clen !== null ? clen : 0);
    const uploadId = id ? scopedUploadId(s, id) : null;
    const expireSec = clampExpireSec(req.query.expire); // optional per-file self-destruct
    const clientSha256 = validSha256Hex(req.query.sha256);
    const duplicateAction = /^(keep|replace)$/.test(String(req.query.duplicate || '').toLowerCase())
      ? String(req.query.duplicate).toLowerCase() : '';
  
    // Return the original success for an exact retry after a lost response. Reusing
    // the same id for different bytes/path is a client error and must never silently
    // acknowledge the wrong file.
    const completedReceipt = completedUploadReceipt(uploadId);
    if (completedReceipt) {
      req.resume();
      if (completedReceipt.size !== total || completedReceipt.path !== relForCheck) {
        return res.status(409).json({ error:'upload-id-conflict', offset:completedReceipt.size, complete:true });
      }
      return res.json({ ...completedReceipt.response, ok:true, complete:true, duplicate:true });
    }
  
    // Quota / filter gate (uses the announced total size). An exact Replace may
    // reuse an existing logical slot, but the client SHA is only provisional here:
    // the completed bytes are re-hashed before the final quota decision below.
    const preflightReplaceTarget = duplicateAction === 'replace' && clientSha256 ? receptionDuplicateStoredPath(s, clientSha256) : null;
    const preflightReplacingExisting = !!preflightReplaceTarget;
    const reason = inboxRejectReason(s, relForCheck, total, { replacingExisting:preflightReplacingExisting });
    if (reason) { req.resume(); return res.status(inboxRejectStatus(reason)).json({ error: reason }); }
    // Per-sender quota (announced size; re-checked with the real size below).
    const senderReason = perSenderRejectReason(s, req, senderName, total, { replacingExisting:preflightReplacingExisting });
    if (senderReason) { req.resume(); return res.status(inboxRejectStatus(senderReason)).json({ error: senderReason }); }
    if (!beginPublicUpload(req, res)) return;
  
    const displayName = parsed.dirSegs.length ? parsed.dirSegs.join('/') + '/' + parsed.filename : parsed.filename;
    const maxUp = effMaxUpload(); // per-file cap (UI setting overrides the env default)
  
    // Moves a completed .part into the destination tree, updates counters, replies.
    const finalize = async (part, transfer) => {
      uploadsInFlight.delete(uploadId); // append is done; release the per-id chunk lock
      // Antivirus: scan before anything is delivered or queued.
      if (clamavEnabled() && !(await scanGate(part, parsed.filename, s, req))) {
        if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
        endTransfer(transfer, false, 'infected');
        if (!res.headersSent) res.status(422).json({ error: 'infected' });
        return;
      }
      // Reject a disguised executable regardless of its extension.
      if (await inboxContentReason(s, part, parsed.filename)) {
        try { await fs.promises.unlink(part); } catch (_) {}
        if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
        endTransfer(transfer, false, 'content-blocked');
        if (!res.headersSent) res.status(415).json({ error: 'content-blocked' });
        return;
      }
      // A different concurrent upload may have triggered protection while this
      // payload was still transferring/scanning. Never publish it after the link
      // has entered the suspended live.state.
      if (await rejectSuspendedUploadFinalize(s, part, transfer, res)) return;
      // Moderation queue: divert to the pending area instead of the target folder.
      // Keep the same destination/sender/expiry/dedupe semantics a normal reception
      // would apply after the file is approved.
      if (s.moderated) {
        const storeName = (s.tagBySender && senderName) ? senderTaggedName(senderName, parsed.filename) : parsed.filename;
        const destRel = [...senderSegs, ...parsed.dirSegs, storeName].join('/');
        const pending = await stashPending(s, part, [...parsed.dirSegs, parsed.filename].join('/'), req, {
          senderName,
          senderKey: uploadSenderKey(s, req, senderName),
          destRel,
          expireSec,
          sha256: clientSha256,
        });
        if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
        if (!pending.ok) { try { await fs.promises.unlink(part); } catch (_) {} }
        if (transfer) transfer.sender = senderName || null;
        endTransfer(transfer, !!pending.ok, pending.ok ? null : (pending.error || 'write-error'));
        if (!res.headersSent) {
          if (pending.ok) {
            const response = { ok: true, complete: true, moderated: true, name: parsed.filename };
            rememberCompletedUpload(uploadId, total, relForCheck, response);
            res.json(response);
          }
          else res.status(pending.error === 'write-error' ? 500 : inboxRejectStatus(pending.error)).json({ error: pending.error || 'write-error' });
        }
        return;
      }
      let dir;
      try {
        dir = resolveWithin(INBOX_DIR, [s.relDir || '', ...senderSegs, ...parsed.dirSegs].join('/'));
        await fs.promises.mkdir(dir, { recursive: true });
      } catch (_) {
        try { await fs.promises.unlink(part); } catch (_) {}
        if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
        endTransfer(transfer, false, 'inbox-dir');
        if (!res.headersSent) res.status(500).json({ error: 'inbox-dir' });
        return;
      }
      const beforeShare = JSON.parse(JSON.stringify(s));
      const outcome = await withShareUploadLock(s.id, async () => {
        if (ransomwareShareBlocked(s.id)) return { error:'security-link-suspended' };
        let size = 0;
        try { size = (await fs.promises.stat(part)).size; }
        catch (_) { return { error: 'write-error' }; }
        // A client hash is only a performance hint until the complete server-side
        // partial has been hashed. Never let a forged hash select a Replace target.
        let verifiedSha256 = clientSha256;
        if (clientSha256) {
          try { verifiedSha256 = await hashFileSha256(part); } catch (_) { return { error:'hash-failed' }; }
          if (verifiedSha256 !== clientSha256) return { error:'hash-mismatch' };
        }
        // Optionally tag the stored filename with the sender name.
        const storeName = (s.tagBySender && senderName) ? senderTaggedName(senderName, parsed.filename) : parsed.filename;
        const duplicateKnown = verifiedSha256 ? receptionHashSeen(s, verifiedSha256) : false;
        const duplicateTarget = duplicateKnown ? receptionDuplicateStoredPath(s, verifiedSha256) : null;
        if (s.rejectDuplicates && duplicateKnown && (duplicateAction === 'keep' || (duplicateAction === 'replace' && !duplicateTarget))) return { error:'duplicate' };
        const replacingExisting = duplicateAction === 'replace' && !!duplicateTarget;
        const finalReason = inboxRejectReason(s, relForCheck, size, { replacingExisting }) || perSenderRejectReason(s, req, senderName, size, { replacingExisting });
        if (finalReason) return { error: finalReason };
        let target = null, replacedBackup = null, replaced = false;
        let replacedExpiryHad = false, replacedExpiryBefore = null;
        if (duplicateAction === 'replace' && duplicateTarget) {
          target = duplicateTarget;
          const expiryMap = live.state.meta && live.state.meta.fileExpiry && typeof live.state.meta.fileExpiry === 'object' ? live.state.meta.fileExpiry : null;
          const expiryTarget = receptionMetadataPath(target);
          if (expiryMap && Object.prototype.hasOwnProperty.call(expiryMap, expiryTarget)) {
            replacedExpiryHad = true;
            replacedExpiryBefore = JSON.parse(JSON.stringify(expiryMap[expiryTarget]));
          } else if (expiryMap && Object.prototype.hasOwnProperty.call(expiryMap, target)) {
            replacedExpiryHad = true;
            replacedExpiryBefore = JSON.parse(JSON.stringify(expiryMap[target]));
          }
          replacedBackup = target + '.dxreplace-' + crypto.randomBytes(5).toString('hex');
          try { await fs.promises.rename(target, replacedBackup); }
          catch (e) { if (!e || e.code !== 'ENOENT') return { error:'write-error' }; replacedBackup = null; }
        } else {
          try { target = await reserveUniqueUploadPath(dir, storeName); }
          catch (_) { return { error: 'write-error' }; }
        }
        try {
          await fs.promises.rename(part, target);
        } catch (_) {
          try { await fs.promises.copyFile(part, target); await fs.promises.unlink(part); }
          catch (e) {
            try { await fs.promises.unlink(target); } catch (_) {}
            if (replacedBackup) { try { await fs.promises.rename(replacedBackup, target); } catch (_) {} }
            return { error: 'write-error' };
          }
        }
        if (duplicateAction !== 'keep' && duplicateAction !== 'replace') {
          // With no explicit duplicate action, enforce the link's configured duplicate policy.
          // Explicit Keep/Replace choices have already been validated against that policy above.
          const dupReason = await receptionDuplicateReason(s, target, clientSha256);
          if (dupReason) {
            try { await fs.promises.unlink(target); } catch (_) {}
            if (replacedBackup) { try { await fs.promises.rename(replacedBackup, target); } catch (_) {} }
            return { error: dupReason };
          }
        }
        if (duplicateAction === 'replace' && duplicateTarget) {
          // Exact-content replacement does not consume another file/quota slot.
          rememberReceptionHash(s, verifiedSha256, target);
          replaced = true;
          return { target, size, accounting:null, replaced, replacedBackup, replacedExpiryHad, replacedExpiryBefore };
        }
        const accounting = applyReceptionAccountingState(s, {
          size, senderKey:uploadSenderKey(s, req, senderName), sha:verifiedSha256,
          dest:target, expireSec,
        });
        return { target, size, accounting, replaced, replacedBackup };
      });
      if (outcome.error) {
        try { await fs.promises.unlink(part); } catch (_) {}
        if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
        endTransfer(transfer, false, outcome.error);
        if (!res.headersSent) {
          const securityBlock = outcome.error === 'security-link-suspended' ? ransomwareShareBlocked(s.id) : null;
          if (securityBlock) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((securityBlock.until - Date.now()) / 1000))));
          res.status(outcome.error === 'security-link-suspended' ? 423 : outcome.error === 'write-error' ? 500 : inboxRejectStatus(outcome.error)).json({ error: outcome.error });
        }
        return;
      }
      const target = outcome.target;
      if (transfer && transfer.uploadId) uploadTransfers.delete(transfer.uploadId);
      // Replacing an existing file is a new deposit lifecycle for that path: refresh
      // its self-destruct timer (or clear the old one when no expiry was requested).
      if (outcome.replaced) {
        deleteFileExpiryForPath(target);
        if (expireSec > 0) recordFileExpiry(target, expireSec, s, path.basename(target));
      }
      if (!persistNow()) {
        rollbackReceptionAccountingState(s, beforeShare, target);
        if (outcome.replaced) {
          const expiryMap = fileExpiryMap();
          const expiryTarget = receptionMetadataPath(target);
          deleteFileExpiryForPath(target);
          if (outcome.replacedExpiryHad) expiryMap[expiryTarget] = outcome.replacedExpiryBefore;
        }
        if (outcome.replacedBackup) {
          try { await fs.promises.unlink(target); } catch (_) {}
          try { await fs.promises.rename(outcome.replacedBackup, target); } catch (_) {}
        } else await rollbackAcceptedUploadFile(target, part);
        endTransfer(transfer, false, 'write-error');
        if (!res.headersSent) res.status(503).json({ error:'write-error' });
        return;
      }
      if (outcome.accounting) finalizeReceptionAccountingEffects(s, outcome.accounting);
      if (outcome.replacedBackup) { try { await fs.promises.unlink(outcome.replacedBackup); } catch (_) {} }
      if (clientSha256) verifyAndRememberDedupe(target);
      recordRansomwareEvent(req, 'upload', displayName, 1);
      scheduleSearchReindex();
      if (transfer) transfer.sender = senderName || null; // record the visitor's name
      if (s.type === 'inbox') { try { emitInboxEvent(s, { type: 'received', name: path.basename(target), dest: s.name || '', at: Date.now(), sender: senderName || undefined }); } catch (_) {} }
      endTransfer(transfer, true);
      if (!res.headersSent) {
        const response = {
          ok: true, complete: true, name: path.basename(target), replaced: !!outcome.replaced,
          filesReceived: s.downloads || 0, bytesReceived: s.bytesReceived || 0,
        };
        rememberCompletedUpload(uploadId, total, relForCheck, response);
        res.json(response);
      }
    };
  
    // --- Resumable / chunked path: append one chunk to a stable .part file ---
    if (id && total > 0) {
      const part = partPath(s, id);
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      if (stoppedUploads.has(uploadId)) { addShareCenterNotification(s,'resume-impossible',{name:displayName,reason:'stopped',dedupeKey:`resume-impossible:${uploadId}:stopped`,dedupeWindowMs:3600000}); req.resume(); return res.status(403).json({ error: 'stopped' }); }
      try { await fs.promises.mkdir(PARTS_DIR, { recursive: true }); } catch (_) {}
      let onDisk = 0;
      try { onDisk = (await fs.promises.stat(part)).size; } catch (_) {}
      if (offset !== onDisk) { addShareCenterNotification(s,'resume-impossible',{name:displayName,reason:'offset-mismatch',detail:`client=${offset} serveur=${onDisk}`,dedupeKey:`resume-impossible:${uploadId}:offset:${onDisk}`,dedupeWindowMs:3600000}); req.resume(); return res.status(409).json({ error: 'offset-mismatch', offset: onDisk }); }
  
      // Serialize chunks of the SAME upload id: two concurrent chunk requests would
      // both pass the offset check above and then interleave their appends, corrupting
      // the .part. The lock is released on every exit path (finalize / fail / the
      // "chunk stored, more to come" reply). The client uploads chunks sequentially,
      // so a well-behaved uploader never sees this.
      if (uploadsInFlight.has(uploadId)) { req.resume(); return res.status(409).json({ error: 'busy', offset: onDisk }); }
      uploadsInFlight.add(uploadId);
  
      // One transfer per upload id, reused across every chunk request.
      let transfer = uploadTransfers.get(uploadId);
      if (transfer && (String(transfer.name || '') !== displayName || Number(transfer.expectedBytes || 0) !== total)) { uploadsInFlight.delete(uploadId); req.resume(); return res.status(409).json({ error:'upload-id-conflict', offset:onDisk }); }
      if (!transfer) {
        transfer = startTransfer(req, { shareId: s.id, name: displayName, type: 'inbox', direction: 'up' }, total);
        transfer.notify = true;
        transfer.uploadId = uploadId;
        uploadTransfers.set(uploadId, transfer);
      }
      transfer.lastActivity = Date.now();
      transfer.bytes = offset; // cumulative baseline; this chunk adds on top
      if (offset > 0 || onDisk > 0) {
        transfer.resumed = true;
        transfer.resumeOffset = Math.max(Number(transfer.resumeOffset) || 0, offset, onDisk);
      }
  
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
      // Admin/PWA stop must remain effective even BETWEEN resumable chunks. After a
      // network drop `failed` is already true and the previous closure used to turn
      // into a no-op, leaving the partial file + live row around until timeout.
      transfer.abort = () => {
        stoppedUploads.set(uploadId, Date.now() + 3600 * 1000);
        if (!failed) { fail('stopped', false); return; }
        uploadsInFlight.delete(uploadId);
        uploadTransfers.delete(uploadId);
        try { fs.unlink(part, () => {}); } catch (_) {}
        endTransfer(transfer, false, 'stopped');
      };
  
      req.on('end', () => { reqEnded = true; });
      req.on('close', () => { if (!reqEnded && !failed) fail('aborted', true); }); // keep .part for resume
      req.on('data', (chunk) => {
        written += chunk.length; transfer.bytes += chunk.length; transfer.lastActivity = Date.now();
        if (written > total) return fail('file-too-large', false);
        if (maxUp > 0 && written > maxUp) return fail('too-large', false);
        if (s.maxFileBytes > 0 && written > s.maxFileBytes) return fail('file-too-large', false);
        if (s.maxTotalBytes > 0 && (s.bytesReceived || 0) + (preflightReplacingExisting ? 0 : written) > s.maxTotalBytes) return fail('quota-full', false);
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
      // Optionally tag the stored filename with the sender name.
      const storeName = (s.tagBySender && senderName) ? senderTaggedName(senderName, parsed.filename) : parsed.filename;
      try { target = await reserveUniqueUploadPath(dir, storeName); }
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
      // Antivirus: scan the finished file before delivering/queuing it.
      if (clamavEnabled() && !(await scanGate(target, finalName, s, req))) {
        endTransfer(transfer, false, 'infected');
        if (!res.headersSent) res.status(422).json({ error: 'infected' });
        return;
      }
      // Reject a disguised executable regardless of its extension.
      if (await inboxContentReason(s, target, finalName)) {
        failed = true;
        fs.unlink(target, () => {});
        endTransfer(transfer, false, 'content-blocked');
        if (!res.headersSent) res.status(415).json({ error: 'content-blocked' });
        return;
      }
      if (await rejectSuspendedUploadFinalize(s, target, transfer, res)) { failed = true; return; }
      if (moderated) {
        // Legacy single-shot uploads must use the same moderation semantics as the
        // resumable path. stashPending returns { ok, error }, not a boolean; treating
        // any returned object as truthy would acknowledge rejected quota/duplicate
        // uploads as successful and could leave the temp file behind.
        const storeName = (s.tagBySender && senderName) ? senderTaggedName(senderName, parsed.filename) : parsed.filename;
        const destRel = [...senderSegs, ...parsed.dirSegs, storeName].join('/');
        const pending = await stashPending(s, target, [...parsed.dirSegs, parsed.filename].join('/'), req, {
          senderName,
          senderKey: uploadSenderKey(s, req, senderName),
          destRel,
          expireSec,
          sha256: clientSha256,
        });
        if (pending.ok) transfer.pendingModeration = true;
        else { try { await fs.promises.unlink(target); } catch (_) {} }
        transfer.sender = senderName || null;
        endTransfer(transfer, !!pending.ok, pending.ok ? null : (pending.error || 'write-error'));
        if (!res.headersSent) {
          if (pending.ok) {
            const response = { ok: true, moderated: true, name: finalName };
            rememberCompletedUpload(uploadId, transfer.bytes, relForCheck, response);
            res.json(response);
          }
          else res.status(pending.error === 'write-error' ? 500 : inboxRejectStatus(pending.error)).json({ error: pending.error || 'write-error' });
        }
        return;
      }
      const beforeShare = JSON.parse(JSON.stringify(s));
      const accepted = await withShareUploadLock(s.id, async () => {
        if (ransomwareShareBlocked(s.id)) return { error:'security-link-suspended' };
        const reason3 = inboxRejectReason(s, relForCheck, transfer.bytes) || perSenderRejectReason(s, req, senderName, transfer.bytes);
        if (reason3) return { error:reason3 };
        // Refuse a byte-for-byte duplicate already received on this link.
        const dupReason = await receptionDuplicateReason(s, target, clientSha256);
        if (dupReason) return { error:dupReason }; // the outer handler unlinks `target`
        const accounting = applyReceptionAccountingState(s, {
          size:transfer.bytes, senderKey:uploadSenderKey(s, req, senderName), sha:clientSha256,
          dest:target, expireSec,
        });
        return { accounting };
      });
      if (accepted.error) {
        failed = true;
        fs.unlink(target, () => {});
        endTransfer(transfer, false, accepted.error);
        if (!res.headersSent) {
          const securityBlock = accepted.error === 'security-link-suspended' ? ransomwareShareBlocked(s.id) : null;
          if (securityBlock) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((securityBlock.until - Date.now()) / 1000))));
          res.status(accepted.error === 'security-link-suspended' ? 423 : inboxRejectStatus(accepted.error)).json({ error: accepted.error });
        }
        return;
      }
      if (!persistNow()) {
        failed = true;
        rollbackReceptionAccountingState(s, beforeShare, target);
        await rollbackAcceptedUploadFile(target);
        endTransfer(transfer, false, 'write-error');
        if (!res.headersSent) res.status(503).json({ error:'write-error' });
        return;
      }
      finalizeReceptionAccountingEffects(s, accepted.accounting);
      if (clientSha256) verifyAndRememberDedupe(target);
      recordRansomwareEvent(req, 'upload', displayName2, 1);
      scheduleSearchReindex();
      transfer.sender = senderName || null; // record the visitor's name
      if (s.type === 'inbox') { try { emitInboxEvent(s, { type: 'received', name: finalName, dest: s.name || '', at: Date.now(), sender: senderName || undefined }); } catch (_) {} }
      endTransfer(transfer, true);
      if (!res.headersSent) {
        const response = { ok: true, name: finalName, filesReceived: s.downloads || 0, bytesReceived: s.bytesReceived || 0 };
        rememberCompletedUpload(uploadId, transfer.bytes, relForCheck, response);
        res.json(response);
      }
    });
    req.pipe(ws);
  }
  downloadRouter.post('/u/:token/upload', handleUpload);
  downloadRouter.post('/c/:token/upload', handleUpload);
  
  
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
    const decisionSnapshot = snapshotPublicMessageDecision(req, s.token);
    const decision = publicMessageDecision(req, s.token, text, file);
    if (decision.duplicate) return res.json({ ok: true, duplicate: true, notified: false });
    if (decision.retryAfter) {
      res.setHeader('Retry-After', String(decision.retryAfter));
      return res.status(429).json({ error: 'rate-limited', retryAfter: decision.retryAfter });
    }
    const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
    const geo = geoSync(ip) || {};
    const previousMessages = Array.isArray(s.messages) ? JSON.parse(JSON.stringify(s.messages)) : null;
    if (!Array.isArray(s.messages)) s.messages = [];
    s.messages.unshift({ at: Date.now(), ip, country: geo.country || null, flag: geo.flag || '🌐', text, file: file || null });
    if (s.messages.length > 50) s.messages.length = 50; // keep the most recent
    if (!persistNow()) {
      if (previousMessages) s.messages = previousMessages; else delete s.messages;
      restorePublicMessageDecision(decisionSnapshot);
      return res.status(503).json({ error:'write-error' });
    }
    geolocate(ip).catch(() => {}); // warm the cache for the admin view
    emitLiveActivity('visitor', { shareId:s.id, name:s.name, status:'message', detail:file ? 'visitor message · file=' + String(file).slice(0,120) : 'visitor message', ip:pubIp(ip) });
    if (decision.notify) notify('message', { name: s.name, shareId: s.id, ip, country: geo.country, text, file: file || null });
    res.json({ ok: true, notified: decision.notify });
  });
  
  // Two-way reception thread (visitor side). The visitor can read the
  // running conversation and post replies the owner sees in real time.
  const threadParser = express.json({ limit: '8kb' });
  function receptionThreadVisitorGate(req, res, s) {
    if (!s || s.type !== 'inbox' || !isActive(s)) { res.status(404).json({ error: 'gone' }); return false; }
    if (s.pwHash && !isUnlocked(req, s)) { res.status(401).json({ error: 'locked' }); return false; }
    if (s.requestAccess && !isAccessApproved(req, s)) { res.status(401).json({ error: 'access' }); return false; }
    return true;
  }
  downloadRouter.get('/u/:token/thread', (req, res) => {
    const s = getByToken(req.params.token);
    if (!receptionThreadVisitorGate(req, res, s)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: receptionThreadEnabled(s), messages: receptionThreadArray(s).map(publicThreadMessage) });
  });
  downloadRouter.post('/u/:token/thread', threadParser, (req, res) => {
    const s = getByToken(req.params.token);
    if (!receptionThreadVisitorGate(req, res, s)) return;
    if (!receptionThreadEnabled(s)) return res.status(403).json({ error: 'disabled' });
    const name = String((req.body && req.body.name) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
    const text = String((req.body && req.body.text) || '').replace(/\r\n/g, '\n').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'empty' });
    const decisionSnapshot = snapshotPublicMessageDecision(req, s.token);
    const decision = publicMessageDecision(req, s.token, text, 'thread');
    if (decision.retryAfter) {
      res.setHeader('Retry-After', String(decision.retryAfter));
      return res.status(429).json({ error: 'rate-limited', retryAfter: decision.retryAfter });
    }
    if (!decision.duplicate) {
      const ip = String(clientIp(req) || '').replace(/^::ffff:/i, '');
      const geo = geoSync(ip) || {};
      const previousThread = Array.isArray(s.thread) ? JSON.parse(JSON.stringify(s.thread)) : null;
      appendReceptionThreadMessage(s, { id: crypto.randomBytes(8).toString('hex'), at: Date.now(), from: 'visitor', name: name || null, text, ip, country: geo.country || null, flag: geo.flag || '🌐', read: false });
      if (!persistNow()) {
        if (previousThread) s.thread = previousThread; else delete s.thread;
        restorePublicMessageDecision(decisionSnapshot);
        return res.status(503).json({ error: 'write-error' });
      }
      geolocate(ip).catch(() => {});
      emitLiveActivity('visitor', { shareId:s.id, name:s.name, status:'thread-reply', detail:name ? 'visitor thread reply · ' + name : 'visitor thread reply', ip:pubIp(ip) });
      // Consistent with visitor feedback/messages: notify over webhook/e-mail. The
      // owner's live awareness is the unread badge on the reception link (see the
      // thread unread count exposed to the PWA / admin listings).
      if (decision.notify) notify('message', { name: s.name, shareId: s.id, ip, country: geo.country, text: `💬${name ? ` ${name}` : ''}: ${text}`, file: null });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, messages: receptionThreadArray(s).map(publicThreadMessage) });
  });
  
}

module.exports = { attachReceptionCollaborationRoutes };
