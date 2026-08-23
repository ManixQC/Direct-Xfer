'use strict';

/**
 * Registers the administrator-facing share lifecycle routes.
 *
 * This boundary owns creation and mutation of download/reception/collaboration
 * links, share recipients/messages/feedback/access requests, bulk operations,
 * search endpoints used by share management, and QR/secret-link creation.
 * Domain services and persistence remain owned by the composition root and are
 * injected explicitly. Mutable store/search bindings are accessed through `live`
 * so restore/reindex operations cannot leave route callbacks with stale snapshots.
 */

// Shared admin/PWA tag normalization. Keep this outside route factories so the
// same validation contract is reused by settings, image metadata and share routes.
function normalizeTags(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [], seen = new Set();
  for (let tag of arr) {
    tag = String(tag || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) { seen.add(key); out.push(tag); }
    if (out.length >= 20) break;
  }
  return out;
}

function attachAdminShareCoreRoutes(deps = {}) {
  const {
    APP_NAME,
    HOST_ROOT,
    INBOX_DIR,
    LOG_FILE,
    SHARE_CHANGE_HISTORY_MAX,
    UNDO_LOG_MAX,
    VISITORS_MAX,
    activeTransfers,
    addShareDurable,
    adminRouter,
    applyAccessRules,
    applyDlpSummary,
    applyTrashRestoreAlternative,
    assertRealWithin,
    auditReq,
    boundedSeconds,
    cleanConnectorPath,
    connectorErrorCode,
    connectorHttpStatus,
    containerToHost,
    crypto,
    csvField,
    decorateShare,
    detachActiveShare,
    detailedPhotoRecentViews,
    displayStatsForShare,
    dlpDecision,
    dlpEffectiveAction,
    dlpScanResolvedItems,
    emitLiveActivity,
    firstExistingPhotoFile,
    fs,
    getById,
    getSettings,
    getStorageConnector,
    hostToContainer,
    imageContentType,
    imageDimensions,
    inboxReceivedFiles,
    ipNameFor,
    isActive,
    isScheduled,
    listShares,
    makeSharePassword,
    newToken,
    normExtList,
    normalizeDescriptionMd,
    normalizePwHint,
    normalizeShareColor,
    normalizeShareEmoji,
    ownsShare,
    parseLinkRateKBps,
    parseMaxBytesServed,
    parseMaxDownloads,
    parseMaxDownloadsPerIp,
    parseMaxVisitors,
    parseStartsAt,
    path,
    performUndo,
    persistNow,
    photoExt,
    photoOriginalPaths,
    photoStatsOf,
    photoVariantPaths,
    pubIp,
    purgeTrashRecordById,
    readLogTailAsync,
    recordShareChange,
    refreshShareBackingHealth,
    refreshShareLogicalBytes,
    reindex,
    requireFullAdmin,
    resolveNewShareExpiry,
    resolveWithin,
    restoreTrashRecord,
    scheduleSearchReindex,
    sendPasswordWorkError,
    serveWebStorageFile,
    shareEffectiveExpiry,
    shareItems,
    shareLogicalBytesCache,
    shareNeedsLogicalBytesScan,
    shareReactivationAvailability,
    shareStatsBaseline,
    stampOwner,
    storageConnectorService,
    syncLiveActivityCache,
    trashItems,
    trashPublicRecord,
    trashRecordVisible,
    trashRestoreAssessment,
    undoEntryExecutable,
    undoEntryVisible,
    undoLogItems,
    undoPublicEntry,
    webStorageConnectorStatus,
    webStorageImportMeta,
    webStorageWalkFiles,
    webStorageWritable,
    SHARE_BACKING_HEALTH_CACHE_MS,
    SHARE_LOGICAL_BYTES_CACHE_MS,
    historyMeta,
    listTransfers,
    mapLimit,
    photoHistoryMeta,
    primaryBase,
    queueShareBackingHealthRefresh,
    queueShareLogicalBytesRefresh,
    settingsForClient,
    shareBackingHealthCache,
    shareBackingHealthRefreshes,
    shareBackingHealthRelevant,
    shareLogicalBytesRefreshes,
    listHistory,
    clearShareRuntimeState,
    live,
  } = deps;

  if (!adminRouter || typeof adminRouter.get !== 'function') throw new TypeError('admin-share-core-routes requires adminRouter');
  if (!live || typeof live !== 'object') throw new TypeError('admin-share-core-routes requires live bindings');

  // High-frequency share/history reads belong to the share administration boundary.
adminRouter.get('/shares', async (req, res) => {
    const requestedScope = String(req.query.scope || 'all').toLowerCase();
    const scope = requestedScope === 'links' || requestedScope === 'images' ? requestedScope : 'all';
    let all = listShares();
    if (scope === 'links') all = all.filter((s) => s.type !== 'photo' && s.type !== 'album');
    else if (scope === 'images') all = all.filter((s) => s.type === 'photo' || s.type === 'album');
    // Operators only see the links they created; admins/owner/auditors see all.
    if (req.session.role === 'operator') all = all.filter((s) => ownsShare(req, s));
    const allowedShareIds = req.session.role === 'operator' ? new Set(all.map((s) => s.id)) : null;
    // Folder sizes cannot be represented by the creation-time stat alone. Never
    // block the high-frequency /shares poll on recursive disk walks: return the last
    // cached value immediately and refresh stale folders in a bounded background job.
    const now = Date.now();
    // Do not launch an I/O wave over the entire library on every poll. Only stale,
    // non-running entries are eligible, and each request warms a bounded batch.
    const logicalSizeCandidates = all.filter((s) => {
      if (!shareNeedsLogicalBytesScan(s) || shareLogicalBytesRefreshes.has(s.id)) return false;
      const cached = shareLogicalBytesCache.get(s.id);
      return !cached || now - cached.at >= SHARE_LOGICAL_BYTES_CACHE_MS;
    }).slice(0, 8);
    if (logicalSizeCandidates.length) void mapLimit(logicalSizeCandidates, 2, (s) => queueShareLogicalBytesRefresh(s)).catch(() => {});
    const backingCandidates = all.filter((s) => {
      if (!shareBackingHealthRelevant(s) || shareBackingHealthRefreshes.has(s.id)) return false;
      const cached = shareBackingHealthCache.get(s.id);
      return !cached || now - cached.at >= SHARE_BACKING_HEALTH_CACHE_MS;
    }).slice(0, 32);
    if (backingCandidates.length) void mapLimit(backingCandidates, 4, (s) => queueShareBackingHealthRefresh(s)).catch(() => {});
  
    // Pending moderation used to scan the complete pending array once per share
    // (O(shares × pending)). Index it once for this response instead.
    const pendingByShareId = new Map();
    for (const row of (Array.isArray(live.state.meta && live.state.meta.pending) ? live.state.meta.pending : [])) {
      if (!row || !row.shareId) continue;
      const bucket = pendingByShareId.get(row.shareId);
      if (bucket) bucket.push(row); else pendingByShareId.set(row.shareId, [row]);
    }
    const base = primaryBase(req);
    const decorateContext = { base, pendingByShareId };
    const shares = all
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => decorateShare(s, req, decorateContext));
    res.json({
      shares,
      base,
      settings: settingsForClient(req, true), // lite: omit the custom-logo data URL from the periodic poll
      transfers: listTransfers(scope === 'all' ? allowedShareIds : new Set(all.map((s) => s.id))),
      historyMeta: historyMeta(allowedShareIds),
      photoHistoryMeta: scope === 'links' ? null : photoHistoryMeta(req),
      trashCount: trashItems().filter((r) => trashRecordVisible(req, r)).length,
    });
  });
  
  // History is loaded separately from the periodic shares poll. This keeps the
  // live UI lightweight while still returning the complete retained list on change.
  adminRouter.get('/history', (req, res) => {
    let allowedShareIds = null;
    if (req.session.role === 'operator') {
      const owned = listShares().filter((s) => ownsShare(req, s));
      allowedShareIds = new Set(owned.map((s) => s.id));
    }
    res.json({
      history: listHistory(allowedShareIds),
      meta: historyMeta(allowedShareIds),
    });
  });
  
  
  
  
  
  // Remove one revoked-image history entry and its retained preview. Operators can
  // only delete their own records; the global role gate keeps auditors read-only.
  
  
  
  
  
  

  adminRouter.get('/shares/export', requireFullAdmin, (req, res) => {
    const shares = listShares();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-shares-${stamp}.json"`);
    auditReq(req, 'shares-exported', shares.length + ' share(s)');
    res.send(JSON.stringify({ app: APP_NAME, exportedAt: Date.now(), shares }, null, 2));
  });

  // Export the CURRENT links list with their live live.state & counters (name,
  // type, URL, dates, downloads, visitors, tags…) as CSV or JSON. Distinct from the
  // config export above (which is for migrating link definitions).
  adminRouter.get('/shares/list-export', (req, res) => {
    const rows = listShares().filter((s) => ownsShare(req, s)).map((s) => decorateShare(s, req));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    auditReq(req, 'links-exported', rows.length + ' link(s)');
    if (String(req.query.format || 'csv').toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-links-${stamp}.json"`);
      return res.send(JSON.stringify({ app: APP_NAME, exportedAt: Date.now(), links: rows }, null, 2));
    }
    const cols = ['name', 'type', 'url', 'created', 'expires', 'active', 'downloads', 'maxDownloads', 'uniqueVisitors', 'maxVisitors', 'views', 'tags'];
    const out = [cols.join(',')];
    for (const s of rows) {
      out.push([
        s.name, s.type, s.url || '',
        new Date(s.createdAt).toISOString(),
        s.expiresAt ? new Date(s.expiresAt).toISOString() : '',
        s.active ? '1' : '0',
        s.downloads || 0, s.maxDownloads || '', s.uniqueVisitors || 0, s.maxVisitors || '', s.views || 0,
        (s.tags || []).join(' '),
      ].map(csvField).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-links-${stamp}.csv"`);
    res.send('﻿' + out.join('\r\n')); // BOM so Excel reads UTF-8
  });

  // Recoverable trash (manual deletions).
  adminRouter.get('/trash',async(req,res)=>{try{const items=await Promise.all(trashItems().filter((r)=>trashRecordVisible(req,r)).map(trashPublicRecord));res.json({items,retentionDays:Math.max(0,Number(getSettings().trashRetentionDays)||0),count:items.length,purgeSummary:{bytes:items.reduce((n,r)=>n+Math.max(0,Number(r.purgeImpact&&r.purgeImpact.bytes)||0),0),items:items.length,dependencies:items.reduce((n,r)=>n+Math.max(0,Number(r.purgeImpact&&r.purgeImpact.dependencyCount)||0),0)}});}catch(e){console.error('[trash] impact failed:',e&&e.message);res.status(500).json({error:'trash-impact-failed'});}});
  adminRouter.get('/trash/:id/change-history',(req,res)=>{const rec=trashItems().find((r)=>r&&r.id===req.params.id);if(!rec||!trashRecordVisible(req,rec)||!rec.share)return res.status(404).json({error:'not-found'});res.json({id:rec.share.id,name:rec.share.name||'',entries:Array.isArray(rec.share.changeHistory)?rec.share.changeHistory.slice(0,SHARE_CHANGE_HISTORY_MAX):[]});});
  adminRouter.post('/trash/:id/restore',async(req,res)=>{
    const list=trashItems(); const i=list.findIndex((r)=>r&&r.id===req.params.id);
    if(i<0||!trashRecordVisible(req,list[i]))return res.status(404).json({error:'not-found'});
    const original=JSON.parse(JSON.stringify(list[i]));
    const rec=list[i], assessment=await trashRestoreAssessment(rec);
    if(!assessment.available){
      const alternative=String(req.body&&req.body.alternativePath||'').trim();
      if(!alternative)return res.status(409).json({error:'restore-location-missing',assessment});
      try{if(!await applyTrashRestoreAlternative(rec.share,alternative))return res.status(400).json({error:'invalid-alternative',assessment});}
      catch(_){return res.status(400).json({error:'invalid-alternative',assessment});}
    }
    list.splice(i,1); const sh=restoreTrashRecord(rec);
    recordShareChange(sh,req,'restored',[],null);
    if(!persistNow()){
      detachActiveShare(sh);
      list.splice(Math.min(i,list.length),0,original);
      reindex(); shareLogicalBytesCache.clear();
      return res.status(503).json({error:'write-error'});
    }
    scheduleSearchReindex();auditReq(req,'share-restored',(sh.type||'share')+' '+(sh.name||''));emitLiveActivity('trash',{shareId:sh.id,name:sh.name,status:'restored'});res.json({ok:true,share:decorateShare(sh,req)});
  });
  adminRouter.delete('/trash/:id',requireFullAdmin,async(req,res)=>{try{const rec=await purgeTrashRecordById(req.params.id,req);if(!rec)return res.status(404).json({error:'not-found'});if(!persistNow())return res.status(503).json({error:'write-error',persisted:false});scheduleSearchReindex();auditReq(req,'trash-purged',rec.share?rec.share.name:req.params.id);res.json({ok:true,persisted:true});}catch(e){console.error('[trash] purge failed:',e&&e.message);res.status(500).json({error:'delete-failed'});}});
  adminRouter.delete('/trash',requireFullAdmin,async(req,res)=>{const ids=trashItems().filter((r)=>trashRecordVisible(req,r)).map((r)=>r.id);let count=0,failed=0;for(const id of ids){try{if(await purgeTrashRecordById(id,req))count++;}catch(e){failed++;console.error('[trash] purge failed:',id,e&&e.message);}}let persisted=true;if(count){persisted=persistNow();if(persisted){scheduleSearchReindex();auditReq(req,'trash-purged-all',`${count}; failed=${failed}`);}}if(!persisted)return res.status(503).json({ok:false,error:'write-error',persisted:false,count,failed});res.status(failed?207:200).json({ok:failed===0,count,failed,persisted:true});});

  // Undoable-action log (#89): list recent destructive actions and reverse one.
  adminRouter.get('/undo', (req, res) => {
    const items = undoLogItems().filter((e) => undoEntryVisible(req, e)).map((entry) => undoPublicEntry(entry, req));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items, max: UNDO_LOG_MAX });
  });
  adminRouter.post('/undo/:id', (req, res) => {
    const entry = undoLogItems().find((e) => e && e.id === req.params.id);
    if (!entry || !undoEntryVisible(req, entry)) return res.status(404).json({ error: 'not-found' });
    if (!undoEntryExecutable(req, entry)) return res.status(403).json({ error: 'forbidden' });
    const r = performUndo(entry, req);
    if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
    auditReq(req, 'action-undone', entry.type + (entry.label ? ': ' + entry.label : ''));
    res.json({ ok: true, entry: undoPublicEntry(entry, req) });
  });

  // Detailed statistics for one active share or shared image. The response combines
  // persistent aggregates with the retained transfer history, live activity and,
  // for direct images, per-variant access counters and on-disk copy metadata.
  async function detailedShareStatsPayload(s, req) {
    const now = Date.now();
    const decorated = decorateShare(s, req);
    const statsBaseline = shareStatsBaseline(s);
    const retainedAll = (live.state.history || [])
      .filter((r) => r && r.shareId === s.id && (!statsBaseline.at || Number(r.endedAt || r.startedAt || 0) > statsBaseline.at))
      .sort((a, b) => (b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));

    const rawPeriod = String((req && req.query && (req.query.period || req.query.days)) || '14').toLowerCase();
    const days = rawPeriod === 'all' || rawPeriod === '0' ? 0 : ([1,7,14,30].includes(Number(rawPeriod)) ? Number(rawPeriod) : 14);
    const spanMs = days ? days * 86400000 : 0;
    const cutoff = days ? now - spanMs : 0;
    const previousCutoff = days ? cutoff - spanMs : 0;
    const retained = days ? retainedAll.filter((r) => Number(r.endedAt || r.startedAt || 0) >= cutoff) : retainedAll;
    const previous = days ? retainedAll.filter((r) => {
      const at = Number(r.endedAt || r.startedAt || 0);
      return at >= previousCutoff && at < cutoff;
    }) : [];

    function aggregateRows(rows) {
      const out = { count:0, bytes:0, up:0, down:0, completed:0, interrupted:0, lastAt:0, firstAt:0, successRate:0, averageBytes:0, averageBps:0, resumed:0 };
      let duration = 0;
      for (const r of rows) {
        out.count += 1;
        out.bytes += Math.max(0, Number(r.bytes) || 0);
        out[r.direction === 'up' ? 'up' : 'down'] += 1;
        out[r.completed ? 'completed' : 'interrupted'] += 1;
        if (r.resumed) out.resumed += 1;
        const at = Number(r.endedAt || r.startedAt) || 0;
        if (!out.lastAt || at > out.lastAt) out.lastAt = at;
        const first = Number(r.startedAt || r.endedAt) || 0;
        if (!out.firstAt || (first && first < out.firstAt)) out.firstAt = first;
        duration += Math.max(0, Number(r.durationMs) || 0);
      }
      out.successRate = out.count ? Math.round((out.completed / out.count) * 1000) / 10 : 0;
      out.averageBytes = out.count ? Math.round(out.bytes / out.count) : 0;
      out.averageBps = duration > 0 ? Math.round((out.bytes / duration) * 1000) : 0;
      return out;
    }

    let aggregate = aggregateRows(retained);
    // Lifetime view preserves the durable aggregate even when old journal rows have
    // already aged out of retention. Average speed/firstAt still use retained rows.
    if (!days) {
      const durable = displayStatsForShare(s) || {};
      const durableCount = Math.max(0, Number(durable.count) || 0);
      aggregate = {
        ...aggregate,
        count: durableCount,
        bytes: Math.max(0, Number(durable.bytes) || 0),
        up: Math.max(0, Number(durable.up) || 0),
        down: Math.max(0, Number(durable.down) || 0),
        completed: Math.max(0, Number(durable.completed) || 0),
        interrupted: Math.max(0, Number(durable.interrupted) || 0),
        lastAt: Math.max(Number(durable.lastAt) || 0, aggregate.lastAt || 0),
      };
      aggregate.successRate = aggregate.count ? Math.round((aggregate.completed / aggregate.count) * 1000) / 10 : 0;
      aggregate.averageBytes = aggregate.count ? Math.round(aggregate.bytes / aggregate.count) : 0;
    }
    const previousAggregate = aggregateRows(previous);
    const pctChange = (current, prior) => {
      current = Number(current) || 0; prior = Number(prior) || 0;
      if (!prior) return current ? 100 : 0;
      return Math.round(((current - prior) / prior) * 1000) / 10;
    };
    const comparison = days ? {
      available: true,
      days,
      previous: previousAggregate,
      delta: {
        countPct: pctChange(aggregate.count, previousAggregate.count),
        bytesPct: pctChange(aggregate.bytes, previousAggregate.bytes),
        completedPct: pctChange(aggregate.completed, previousAggregate.completed),
        interruptedPct: pctChange(aggregate.interrupted, previousAggregate.interrupted),
        successRatePoints: Math.round((aggregate.successRate - previousAggregate.successRate) * 10) / 10,
        speedPct: pctChange(aggregate.averageBps, previousAggregate.averageBps),
      },
    } : { available:false };

    const liveTransfers = [...activeTransfers.values()]
      .filter((t) => t && t.shareId === s.id)
      .map((t) => ({
        id:t.id, name:t.name || s.name || '', direction:t.direction === 'up' ? 'up' : 'down',
        bytes:t.bytes || 0, expectedBytes:t.expectedBytes || 0, startedAt:t.startedAt || 0,
        lastActivity:t.lastActivity || t.startedAt || 0, ip:pubIp(t.ip || ''), ipName:ipNameFor(pubIp(t.ip || '')),
        country:t.country || null, flag:t.flag || null, recipient:t.recipientName || null,
        resumed:!!t.resumed, resumeOffset:Math.max(0, Number(t.resumeOffset) || 0),
      }));

    const countryMap = new Map(), clientMap = new Map(), failureMap = new Map();
    for (const r of retained) {
      const countryKey = r.countryCode || r.country || 'unknown';
      const country = countryMap.get(countryKey) || { code:r.countryCode || null, name:r.country || 'Unknown', flag:r.flag || null, count:0, bytes:0 };
      country.count += 1; country.bytes += Math.max(0, Number(r.bytes) || 0); countryMap.set(countryKey, country);
      const displayIp = pubIp(r.ip || '') || '—';
      const clientKey = ipNameFor(displayIp) || displayIp;
      const client = clientMap.get(clientKey) || { label:clientKey, count:0, bytes:0 };
      client.count += 1; client.bytes += Math.max(0, Number(r.bytes) || 0); clientMap.set(clientKey, client);
      if (!r.completed) {
        const reason = String(r.reason || 'interrupted').slice(0,80);
        const row = failureMap.get(reason) || { reason, count:0, bytes:0, lastAt:0 };
        row.count += 1; row.bytes += Math.max(0, Number(r.bytes) || 0); row.lastAt = Math.max(row.lastAt, Number(r.endedAt || r.startedAt) || 0);
        failureMap.set(reason, row);
      }
    }

    function buildTimeline() {
      if (days === 1) {
        const bucketMs = 3600000, startAt = cutoff;
        const points = Array.from({length:24}, (_,i) => ({ at:startAt+i*bucketMs, day:new Date(startAt+i*bucketMs).toISOString().slice(11,16), count:0, bytes:0, completed:0, interrupted:0, up:0, down:0 }));
        for (const r of retained) { const at=Number(r.endedAt||r.startedAt)||0, idx=Math.min(23,Math.floor((at-startAt)/bucketMs)); if(idx<0)continue; const p=points[idx]; p.count++;p.bytes+=Math.max(0,Number(r.bytes)||0);p[r.completed?'completed':'interrupted']++;p[r.direction==='up'?'up':'down']++; }
        return { granularity:'hour', points };
      }
      let count = days || 30;
      let startAt;
      if (days) {
        count = days;
        startAt = cutoff;
      } else {
        const oldest = retainedAll.length ? Number(retainedAll[retainedAll.length-1].startedAt || retainedAll[retainedAll.length-1].endedAt) || now : now;
        const spanDays = Math.max(1, Math.ceil((now-oldest)/86400000)+1);
        count = Math.min(30, spanDays);
        const bucketDays = Math.max(1, Math.ceil(spanDays/count));
        const bucketMs = bucketDays*86400000;
        startAt = Math.floor(oldest/bucketMs)*bucketMs;
        const points = Array.from({length:count},(_,i)=>({at:startAt+i*bucketMs,day:new Date(startAt+i*bucketMs).toISOString().slice(0,10),count:0,bytes:0,completed:0,interrupted:0,up:0,down:0}));
        for (const r of retainedAll) { const at=Number(r.endedAt||r.startedAt)||0,idx=Math.min(count-1,Math.floor((at-startAt)/bucketMs)); if(idx<0)continue;const p=points[idx];p.count++;p.bytes+=Math.max(0,Number(r.bytes)||0);p[r.completed?'completed':'interrupted']++;p[r.direction==='up'?'up':'down']++; }
        return { granularity:bucketDays===1?'day':'multi-day', bucketDays, points };
      }
      const points=Array.from({length:count},(_,i)=>({at:startAt+i*86400000,day:new Date(startAt+i*86400000).toISOString().slice(0,10),count:0,bytes:0,completed:0,interrupted:0,up:0,down:0}));
      for(const r of retained){const at=Number(r.endedAt||r.startedAt)||0,idx=Math.min(points.length-1,Math.floor((at-startAt)/86400000));if(idx<0)continue;const p=points[idx];p.count++;p.bytes+=Math.max(0,Number(r.bytes)||0);p[r.completed?'completed':'interrupted']++;p[r.direction==='up'?'up':'down']++;}
      return { granularity:'day', points };
    }
    const timelineData = buildTimeline();

    const items = shareItems(s) || [];
    const logicalBytes = items.reduce((sum,item)=>sum+Math.max(0,Number(item.size)||0),0) || Math.max(0,Number(s.size)||0);
    const effectiveExpiresAt = Number(decorated.effectiveExpiresAt) || Number(shareEffectiveExpiry(s)) || 0;
    const expired = !!(effectiveExpiresAt && now > effectiveExpiresAt);
    const status = s.revoked ? 'revoked' : s.disabled ? 'paused' : isScheduled(s) ? 'scheduled' : expired ? 'expired' : isActive(s) ? 'active' : 'inactive';
    const quota=[];
    if(s.maxDownloads>0)quota.push({kind:'downloads',used:s.downloads||0,max:s.maxDownloads});
    { const visitorCap=parseMaxVisitors(s.maxVisitors); if(visitorCap>0)quota.push({kind:'visitors',used:Array.isArray(s.visitors)?Math.min(s.visitors.length,VISITORS_MAX):0,max:visitorCap}); }
    if((s.type==='inbox'||s.type==='collab')&&s.maxTotalBytes>0)quota.push({kind:'bytes',used:s.bytesReceived||0,max:s.maxTotalBytes});
    if((s.type==='inbox'||s.type==='collab')&&s.maxFiles>0)quota.push({kind:'files',used:s.downloads||0,max:s.maxFiles});

    let image=null;
    if(s.type==='photo'){
      const ps=photoStatsOf(s);
      const metaFor=async(kind)=>{
        let file=null;
        if(kind==='full'){file=firstExistingPhotoFile(photoOriginalPaths(s));if(!file&&s.hostPath){try{file=hostToContainer(s.hostPath);await assertRealWithin(HOST_ROOT,file);}catch(_){file=null;}}}
        else file=firstExistingPhotoFile(photoVariantPaths(s.token,kind));
        let size=kind==='full'?(Number(s.size)||null):null,dim=kind==='full'&&s.w&&s.h?{w:s.w,h:s.h}:null;
        if(file){try{size=fs.statSync(file).size;}catch(_){}try{dim=imageDimensions(file)||dim;}catch(_){}}
        const st=ps[kind]||{v:0,u:[]}; const views=Number(st.v)||0;
        return {kind,views,visitors:Array.isArray(st.u)?st.u.length:0,lastAt:Number(st.lastAt)||0,size:size||0,w:dim&&dim.w?dim.w:null,h:dim&&dim.h?dim.h:null,present:!!file,bandwidthBytes:views*Math.max(0,Number(size)||0)};
      };
      const variants={full:await metaFor('full'),thumb:await metaFor('thumb'),micro:await metaFor('micro')};
      const recentViews=await detailedPhotoRecentViews(s,50); const totalViews=variants.full.views+variants.thumb.views+variants.micro.views;
      for(const v of Object.values(variants))v.viewSharePct=totalViews?Math.round((v.views/totalViews)*1000)/10:0;
      const uniqueImageVisitors = new Set();
      for (const kind of ['full','thumb','micro']) { const st=ps[kind]||{}; if (Array.isArray(st.u)) for (const visitor of st.u) if (visitor) uniqueImageVisitors.add(visitor); }
      image={ext:photoExt(s),totalViews,totalVisitors:uniqueImageVisitors.size,totalStorageBytes:variants.full.size+variants.thumb.size+variants.micro.size,totalBandwidthBytes:variants.full.bandwidthBytes+variants.thumb.bandwidthBytes+variants.micro.bandwidthBytes,variants,recentViews};
    }

    const recent=retained.slice(0,50).map((r)=>{const displayIp=pubIp(r.ip||'');return{at:r.endedAt||r.startedAt||0,startedAt:r.startedAt||0,direction:r.direction==='up'?'up':'down',name:r.name||'',recipient:r.recipientName||null,ip:displayIp||null,ipName:ipNameFor(displayIp),country:r.country||null,countryCode:r.countryCode||null,flag:r.flag||null,bytes:r.bytes||0,durationMs:r.durationMs||0,avgBps:r.avgBps||0,completed:!!r.completed,reason:r.reason||null,resumed:!!r.resumed,resumeOffset:Math.max(0,Number(r.resumeOffset)||0)};});

    return {
      period:{days,label:days?String(days)+'d':'all',startAt:cutoff||null,endAt:now,granularity:timelineData.granularity,bucketDays:timelineData.bucketDays||1},
      comparison,
      share:{id:s.id,name:s.name||'',type:s.type||'',status,active:isActive(s),createdAt:s.createdAt||0,startsAt:s.startsAt||0,expiresAt:s.expiresAt||0,effectiveExpiresAt,ownerName:s.ownerName||null,url:s.type==='photo'&&decorated.photo?decorated.photo.imgUrl:decorated.url,path:s.webStorage?(s.webStorage.path||'/'):(s.hostPath||s.relDir||null),tags:Array.isArray(s.tags)?s.tags:[],itemCount:items.length||decorated.itemCount||0,logicalBytes,views:Math.max(0,(Number(s.views)||0)-statsBaseline.views),uniqueVisitors:Math.max(0,(Array.isArray(s.visitors)?s.visitors.length:0)-statsBaseline.visitors),downloads:Math.max(0,(Number(s.downloads)||0)-statsBaseline.downloads)},
      aggregate,
      quota,live:liveTransfers,timeline:timelineData.points,
      countries:[...countryMap.values()].sort((a,b)=>b.count-a.count||b.bytes-a.bytes).slice(0,12),
      clients:[...clientMap.values()].sort((a,b)=>b.count-a.count||b.bytes-a.bytes).slice(0,12),
      failureReasons:[...failureMap.values()].sort((a,b)=>b.count-a.count||b.lastAt-a.lastAt).slice(0,12),
      recent,image,
    };
  }

  // Simulate the public gate for a share without reusing the administrator's
  // cookies/session (#37). This is intentionally a logical visitor probe: it
  // evaluates lifecycle, backing data and access gates while revealing no password,
  // recipient token or filesystem detail.
  adminRouter.get('/shares/:id/visitor-test', async (req, res) => {
    const sh=getById(req.params.id); if(!sh||!ownsShare(req,sh))return res.status(404).json({error:'not-found'});
    const now=Date.now();
    const backing=sh.webStorage?await shareReactivationAvailability(sh).catch(()=>({available:false,reason:'data-missing'})):await refreshShareBackingHealth(sh,true).catch(()=>({available:false,reason:'data-missing',at:Date.now()}));
    let verdict='ready', expectedStatus=200;
    if (sh.revoked) { verdict='revoked'; expectedStatus=404; }
    else if (sh.disabled) { verdict='paused'; expectedStatus=404; }
    else if (isScheduled(sh,now)) { verdict='scheduled'; expectedStatus=404; }
    else if (!isActive(sh,now)) { verdict='inactive'; expectedStatus=404; }
    else if (!backing.available) { verdict='missing-source'; expectedStatus=404; }
    else if (sh.pwHash) { verdict='password-required'; expectedStatus=401; }
    else if (sh.requestAccess) { verdict='approval-required'; expectedStatus=401; }
    const decorated=decorateShare(sh,req);
    auditReq(req,'visitor-test',{code:'visitor-test',params:{shareId:sh.id,verdict},fallback:`${sh.name||sh.id}: ${verdict}`});
    res.json({ok:true,shareId:sh.id,name:sh.name||'',verdict,expectedStatus,path:decorated.path,url:decorated.url||null,backing:{status:backing.available?'ok':'missing',checkedAt:backing.at||Date.now()},hasPassword:!!sh.pwHash,requestAccess:!!sh.requestAccess});
  });

  adminRouter.get('/shares/:id/stats-detail', async (req, res) => {
    const s = getById(req.params.id);
    if (!s || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await detailedShareStatsPayload(s, req));
    } catch (e) {
      console.error('[stats-detail] failed:', e && e.message);
      res.status(500).json({ error: 'stats-failed' });
    }
  });

  // Per-link access log: the recent transfer-journal entries for one
  // link (who / when / from where), newest first. Owner-scoped, bounded.
  adminRouter.get('/shares/:id/log', async (req, res) => {
    const s = getById(req.params.id);
    if (!s || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });
    const lines = await readLogTailAsync(8 * 1024 * 1024);
    const entries = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < 200; i--) {
      const line = lines[i];
      if (!line || line.indexOf(s.id) === -1) continue; // cheap prefilter before JSON.parse
      let r; try { r = JSON.parse(line); } catch (_) { continue; }
      if (r.shareId !== s.id) continue;
      entries.push({
        at: r.endedAt || r.startedAt || 0,
        direction: r.direction || 'down',
        name: r.name || '',
        recipient: r.recipientName || null,
        ip: r.ip ? pubIp(r.ip) : null,
        country: r.country || null,
        flag: r.flag || null,
        bytes: r.bytes || 0,
        completed: !!r.completed,
      });
    }
    res.json({ shareId: s.id, name: s.name, entries });
  });

  // Download history grouped by file for one active share.
  adminRouter.get('/shares/:id/file-history',async(req,res)=>{
    const sh=getById(req.params.id);if(!sh||!ownsShare(req,sh))return res.status(404).json({error:'not-found'});
    const HISTORY_READ_BYTES=32*1024*1024;
    const lines=await readLogTailAsync(HISTORY_READ_BYTES),byFile=new Map(),events=[]; let zipMembersTruncated=false,historyTruncated=false;
    try{historyTruncated=fs.statSync(LOG_FILE).size>HISTORY_READ_BYTES;}catch(_){}
    const add=(r,name,bytes,viaZip)=>{name=String(name||sh.name||'file').slice(0,240);const row=byFile.get(name)||{name,transfers:0,completed:0,interrupted:0,bytes:0,lastAt:0,lastIp:null,lastCountry:null};row.transfers++;row.bytes+=Math.max(0,Number(bytes)||0);if(r.completed)row.completed++;else row.interrupted++;const at=Number(r.endedAt||r.startedAt)||0;if(at>=row.lastAt){row.lastAt=at;row.lastIp=r.ip?pubIp(r.ip):null;row.lastCountry=r.country||null;}byFile.set(name,row);if(events.length<1000)events.push({at,name,completed:!!r.completed,bytes:Math.max(0,Number(bytes)||0),durationMs:Math.max(0,Number(r.durationMs)||0),avgBps:Math.max(0,Number(r.avgBps)||0),ip:r.ip?pubIp(r.ip):null,ipName:r.ip?ipNameFor(pubIp(r.ip)):null,country:r.country||null,flag:r.flag||null,recipient:r.recipientName||null,reason:r.reason||null,viaZip:!!viaZip});};
    for(let i=lines.length-1;i>=0;i--){const line=lines[i];if(!line||line.indexOf(sh.id)===-1)continue;let r;try{r=JSON.parse(line);}catch(_){continue;}if(r.shareId!==sh.id||(r.direction||'down')!=='down')continue;if(Array.isArray(r.members)&&r.members.length){for(const m of r.members)add(r,m&&m.name,m&&m.size,true);if(r.membersTruncated)zipMembersTruncated=true;}else add(r,r.name,Math.max(0,Number(r.bytes)||0),false);}
    res.json({shareId:sh.id,name:sh.name,files:[...byFile.values()].sort((a,b)=>b.lastAt-a.lastAt||b.bytes-a.bytes),events,zipMembersTruncated,historyTruncated});
  });

  function safeReceivedFilePath(share, rel) {
    if (!share || !['inbox','collab'].includes(share.type)) return null;
    rel = String(rel || '');
    if (!rel || /(^|[\\/])\.dx(?:parts|pending)([\\/]|$)/.test(rel)) return null;
    try {
      const root = resolveWithin(INBOX_DIR, share.relDir || '');
      const abs = resolveWithin(root, rel);
      const rootReal = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root);
      const fileReal = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
      if (fileReal === rootReal || !fileReal.startsWith(rootReal + path.sep)) return null;
      return fileReal;
    } catch (_) { return null; }
  }

  // Received-file browser for the admin dashboard (reception & collab
  // links). Lists the files that landed on the link (flagging images), and serves
  // each one for download or — images only — inline so the dashboard can render real
  // thumbnails. Server-backed like the PWA's /app/inbox view, so it survives any
  // client-side storage loss.
  adminRouter.get('/shares/:id/received', async (req, res) => {
    const s=getById(req.params.id);if(!s||(s.type!=='inbox'&&s.type!=='collab')||!ownsShare(req,s))return res.status(404).json({error:'not-found'});
    let files,truncated=false;if(s.webStorage){try{const walked=await webStorageWalkFiles(s,{maxFiles:5000,maxDirs:1000,maxDepth:24});files=walked.files.map((row)=>({name:row.name,path:row.rel,size:row.size,mtime:0,image:!!imageContentType(row.name)}));truncated=!!walked.truncated;}catch(error){return res.status(webStorageConnectorStatus(error)).json({error:connectorErrorCode(error)});}}else files=inboxReceivedFiles(s).map((f)=>({...f,image:!!imageContentType(f.name)}));
    res.setHeader('Cache-Control','no-store');res.json({shareId:s.id,name:s.name||'',count:files.length,truncated,files});
  });
  adminRouter.get('/shares/:id/received-file', async (req, res) => {
    const s = getById(req.params.id);
    if (!s || (s.type !== 'inbox' && s.type !== 'collab') || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });
    const rel = String(req.query.path || '');
    if(s.webStorage){const inline=req.query.inline==='1'||req.query.inline==='true',type=imageContentType(path.posix.basename(rel));return serveWebStorageFile(req,res,s,rel,{filename:path.posix.basename(rel||'download'),inline:inline&&!!type,contentType:type||'application/octet-stream',countStats:false});}
    const abs = safeReceivedFilePath(s, rel);
    if (!abs) return res.status(404).json({ error: 'not-found' });
    let st;
    try { st = fs.statSync(abs); } catch (_) { return res.status(404).json({ error: 'not-found' }); }
    if (!st.isFile()) return res.status(404).json({ error: 'not-found' });
    const filename = path.basename(abs);
    const imgType = imageContentType(filename);
    const inline = req.query.inline === '1' || req.query.inline === 'true';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(st.size));
    // Inline is reserved for images (thumbnails). Any non-image — or an image not
    // asked inline — is served as a download, so no arbitrary content renders inline
    // in the admin origin.
    if (inline && imgType) {
      res.setHeader('Content-Type', imgType);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    }
    const stream = fs.createReadStream(abs);
    stream.on('error', () => { if (res.headersSent) res.destroy(); else res.status(500).end(); });
    stream.pipe(res);
  });

  // Import a shares-config file produced by /shares/export. Each record
  // gets a fresh id; its token is kept when free (so existing links keep working)
  // or regenerated on collision. mode:'replace' clears current links first, else
  // records are merged in. Files/ciphertext blobs are NOT transferred.
  adminRouter.post('/shares/import', (req, res) => {
    const body = req.body || {};
    const incoming = Array.isArray(body.shares) ? body.shares : (Array.isArray(body) ? body : null);
    if (!incoming) return res.status(400).json({ error: 'invalid-file' });
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    // Import mutates a large part of live.state. Keep a snapshot so a durable-write
    // failure cannot leave the running process in a live.state that will disappear on
    // restart. Replace mode moves previous links to recoverable trash instead of
    // silently orphaning their Direct-Xfer-managed inbox data.
    const beforeState = JSON.parse(JSON.stringify(live.state));
    if (mode === 'replace') {
      const now = Date.now();
      for (const oldShare of live.state.shares.slice()) {
        recordShareChange(oldShare, req, 'replaced-by-import', [], null);
        trashItems().unshift({
          id: crypto.randomBytes(8).toString('hex'), deletedAt: now,
          deletedBy: (req.session && req.session.username) || 'system',
          ownerId: oldShare.ownerId || null, ownerName: oldShare.ownerName || null,
          share: oldShare,
        });
      }
      live.state.shares = [];
      shareLogicalBytesCache.clear();
    }
    const tokens = new Set(live.state.shares.map((s) => s.token));
    let added = 0, skipped = 0;
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object' || !['file', 'folder', 'inbox', 'collab', 'web-storage'].includes(raw.type) || !raw.name) { skipped += 1; continue; }
      const rec = { ...raw };
      if (rec.webStorage && ['web-storage','inbox','collab'].includes(rec.type)) {
        const imported=webStorageImportMeta(rec,getStorageConnector(rec.webStorage&&rec.webStorage.connectorId)); if(!imported||((rec.type==='inbox'||rec.type==='collab')&&(imported.readOnly||!imported.isDir))){skipped+=1;continue;}
        rec.webStorage=imported;rec.allowZip=false;delete rec.hostPath;delete rec.relDir;delete rec.items;delete rec.collection;
        if(rec.type==='inbox'||rec.type==='collab'){rec.moderated=false;rec.rejectDuplicates=false;delete rec.encrypted;delete rec.encMode;webStorageWritable.sanitizeTracked(rec);}else delete rec.webStorageUploaded;
      }
      rec.id = crypto.randomBytes(8).toString('hex');
      if (!rec.token || tokens.has(rec.token)) rec.token = newToken();
      tokens.add(rec.token);
      if (typeof rec.downloads !== 'number') rec.downloads = 0;
      rec.revoked = !!rec.revoked;
      if (rec.type === 'collab') { if (rec.allowDelete === true && rec.pwHash) rec.allowDelete = true; else delete rec.allowDelete; }
      delete rec.expiryWarnedAt; // re-arm expiry alerts on the destination instance
      // A configuration export never contains the encrypted blob itself. Never
      // trust/import an absolute encPath from JSON: a crafted config could otherwise
      // make a later purge unlink an arbitrary host path. Imported links therefore
      // fall back to their host source path and must be re-encrypted explicitly.
      delete rec.encPath;
      delete rec.encrypted;
      delete rec.encryptedAt;
      // Never accept request/runtime-only container paths from an imported object.
      delete rec.containerPath;
      if (Array.isArray(rec.items)) rec.items = rec.items.map((it) => it && typeof it === 'object' ? ({ hostPath:it.hostPath, name:it.name, size:it.size, type:it.type || 'file' }) : null).filter(Boolean);
      // Regenerate recipient sub-tokens that would collide with an existing one.
      if (Array.isArray(rec.recipients)) {
        for (const r of rec.recipients) {
          if (!r || typeof r !== 'object') continue;
          if (!r.token || tokens.has(r.token)) r.token = newToken();
          tokens.add(r.token);
        }
      }
      live.state.shares.push(rec);
      added += 1;
    }
    reindex();
    if (!persistNow()) {
      live.state = beforeState;
      syncLiveActivityCache();
      if (typeof clearShareRuntimeState === 'function') clearShareRuntimeState();
      else { reindex(); shareLogicalBytesCache.clear(); }
      return res.status(503).json({ error: 'write-error' });
    }
    auditReq(req, 'shares-imported', `${added} added, ${skipped} skipped (${mode})`);
    res.json({ ok: true, added, skipped, total: live.state.shares.length, persisted: true });
  });

  // Resolves one host path to a share item, enforcing the HOST_ROOT boundary.
  // Throws an Error whose .code is a client-facing reason ('missing-path',
  // 'invalid-path', 'not-found', 'unsupported-type').
  async function resolveHostItem(reqPath) {
    const p = String(reqPath || '').trim();
    if (!p) { const e = new Error('missing-path'); e.code = 'missing-path'; throw e; }
    let abs;
    try {
      abs = hostToContainer(p);
      await assertRealWithin(HOST_ROOT, abs);
    } catch (_) { const e = new Error('invalid-path'); e.code = 'invalid-path'; throw e; }
    let st;
    try {
      st = await fs.promises.stat(abs);
    } catch (_) { const e = new Error('not-found'); e.code = 'not-found'; throw e; }
    const type = st.isDirectory() ? 'folder' : st.isFile() ? 'file' : null;
    if (!type) { const e = new Error('unsupported-type'); e.code = 'unsupported-type'; throw e; }
    return { hostPath: containerToHost(abs), name: path.basename(abs) || 'share', size: type === 'file' ? st.size : null, type };
  }
  // Accepts either a single `path` or a `paths` array, returns a de-duplicated,
  // trimmed list of host paths.
  function reqPathList(body) {
    const raw = Array.isArray(body.paths) ? body.paths : (body.path != null ? [body.path] : []);
    return [...new Set(raw.map((p) => String(p || '').trim()).filter(Boolean))];
  }

  function webStorageConnectorSnapshot(connector) {
    return {
      connectorId:String(connector.id || ''),
      connectorName:String(connector.name || '').slice(0,80),
      connectorType:String(connector.type || '').slice(0,40),
      remote:String(connector.remote || '').slice(0,64),
      root:String(connector.root || '').slice(0,4096),
      readOnly:!!connector.readOnly,
    };
  }

  function webStorageDlpGate(req, res, body, share) {
    const settings = getSettings();
    if (settings.dlpEnabled === false) return false;
    const scan = {
      count:0, highest:null, types:[], findings:[], incomplete:true,
      filesScanned:0, filesSkipped:1, ocrErrors:0, ocrUnavailable:false,
      scanErrors:1, incompleteEntries:0, truncated:false,
    };
    const mode = dlpEffectiveAction(settings, scan);
    if ((mode === 'block' || mode === 'quarantine')) {
      auditReq(req, 'dlp-blocked', { code:'dlp-result', params:{ source:'web-storage-share-create', count:0, highest:'none', incomplete:true, types:'' }, fallback:'web-storage-share-create: remote content was not inspected locally' });
      return res.status(403).json({ error:'dlp-remote-unscanned', dlp:scan }), true;
    }
    if (mode === 'warn' && body.dlpOverride !== true) {
      auditReq(req, 'dlp-warning', { code:'dlp-result', params:{ source:'web-storage-share-create', count:0, highest:'none', incomplete:true, types:'' }, fallback:'web-storage-share-create: remote content was not inspected locally' });
      return res.status(409).json({ error:'dlp-warning', reason:'remote-unscanned', dlp:scan }), true;
    }
    if (mode === 'warn') auditReq(req, 'dlp-overridden', 'web-storage-share-create: remote content was not inspected locally');
    applyDlpSummary(share, scan);
    return false;
  }

  async function applyWebStorageShareOptions(share, body) {
    const color = normalizeShareColor(body.color);
    if (color === null) return 'invalid-color';
    if (color) share.color = color;
    const tags = normalizeTags(body.tags || []); if (tags.length) share.tags = tags;
    const descriptionMd = normalizeDescriptionMd(body.descriptionMd); if (descriptionMd) share.descriptionMd = descriptionMd;
    if (body.expiryReminderHours !== undefined && body.expiryReminderHours !== null && body.expiryReminderHours !== '') {
      const h = Number(body.expiryReminderHours); if (!Number.isFinite(h) || h < 0 || h > 8760) return 'invalid-reminder';
      share.expiryReminderHours = Math.round(h * 10) / 10;
    }
    const forceNeverExpire = getSettings().newSharesNeverExpire === true;
    const firstUseExpirySeconds = forceNeverExpire ? 0 : boundedSeconds(body.firstUseExpirySeconds); if (firstUseExpirySeconds) share.firstUseExpirySeconds = firstUseExpirySeconds;
    const inactiveExpirySeconds = forceNeverExpire ? 0 : boundedSeconds(body.inactiveExpirySeconds); if (inactiveExpirySeconds) share.inactiveExpirySeconds = inactiveExpirySeconds;
    const password = String(body.password || '');
    if (getSettings().defaultRequirePassword && !password) return 'password-required';
    if (password) { const protectedShare = await makeSharePassword(password); if (protectedShare.error) return protectedShare.error; Object.assign(share, protectedShare); }
    if (password) { const hint = normalizePwHint(body.pwHint); if (hint) share.pwHint = hint; }
    const maxDlPerIp = parseMaxDownloadsPerIp(body.maxDownloadsPerIp); if (maxDlPerIp) share.maxDownloadsPerIp = maxDlPerIp;
    const shareEmoji = normalizeShareEmoji(body.emoji); if (shareEmoji) share.emoji = shareEmoji;
    const maxBytesServed = parseMaxBytesServed(body.maxBytesServed); if (maxBytesServed) share.maxBytesServed = maxBytesServed;
    const parsedRate = parseLinkRateKBps(body.rateKBps, { optional:true });
    if (!parsedRate.ok) return 'invalid-rate';
    if (parsedRate.value > 0) share.rateBps = parsedRate.value * 1024;
    // Cloud folders are intentionally never materialized locally merely to build
    // a ZIP. Keep the flag false for both files and folders so PATCH/import paths
    // cannot accidentally advertise a local ZIP capability later.
    share.allowZip = false;
    if (body.noPreview === true) share.noPreview = true;
    if (body.burnAfterDownload === true) share.burnAfterDownload = true;
    if (typeof body.note === 'string') {
      const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 2000); if (note) share.note = note;
    }
    const maxVisitors = parseMaxVisitors(body.maxVisitors); if (maxVisitors > 0) share.maxVisitors = maxVisitors;
    const dlThreshold = Math.max(0, Math.floor(Number(body.notifyDownloadThreshold) || 0)); if (dlThreshold > 0) share.notifyDownloadThreshold = dlThreshold;
    if (body.requestAccess === true) share.requestAccess = true;
    if (body.allowFeedback === true) share.allowFeedback = true;
    applyAccessRules(share, body);
    return null;
  }

  async function createWebWritableShare(req,res,type){
    const body=req.body||{},current=getStorageConnector(body.connectorId);if(!current)return res.status(404).json({error:'connector-not-found'});
    const connector=Object.freeze({...current});if(connector.readOnly)return res.status(409).json({error:'connector-read-only'});
    if(!Object.prototype.hasOwnProperty.call(body,'remotePath'))return res.status(400).json({error:'missing-remote-path'});
    const remotePath=cleanConnectorPath(body.remotePath);if(remotePath===null)return res.status(400).json({error:'invalid-remote-path'});
    let stat;try{stat=await storageConnectorService.stat(connector,remotePath);}catch(error){const code=connectorErrorCode(error);return res.status(connectorHttpStatus(code)).json({error:code});}
    if(!stat.isDir)return res.status(400).json({error:'remote-not-directory'});
    const live=getStorageConnector(connector.id);if(!live||live.remote!==connector.remote||live.root!==connector.root||live.type!==connector.type||!!live.readOnly!==!!connector.readOnly)return res.status(409).json({error:'connector-changed-during-create'});
    const nn=(v)=>{const n=Math.floor(Number(v));return Number.isFinite(n)&&n>0?n:0;},password=String(body.password||'');
    if(getSettings().defaultRequirePassword&&!password)return res.status(400).json({error:'password-required'});
    if(body.moderated===true)return res.status(400).json({error:'web-storage-moderation-unavailable'});
    if(body.encrypted===true)return res.status(400).json({error:'web-storage-encryption-unavailable'});
    const share={type,name:String(body.name||'').replace(/[\r\n\t]+/g,' ').trim().slice(0,240)||(type==='collab'?'Web collaboration':'Web reception'),startsAt:parseStartsAt(body.startsAt),expiresAt:resolveNewShareExpiry(body),maxFiles:nn(body.maxFiles),maxFileBytes:nn(body.maxFileBytes),maxTotalBytes:nn(body.maxTotalBytes),allowExt:normExtList(body.allowExt),blockExt:normExtList(body.blockExt),groupBySender:type==='inbox'&&!!body.groupBySender,tagBySender:!!body.tagBySender,rejectDuplicates:false,requireSenderName:type==='inbox'&&!!body.requireSenderName,blockExecutables:!!body.blockExecutables,maxFilesPerSender:nn(body.maxFilesPerSender),maxBytesPerSender:nn(body.maxBytesPerSender),maxFilesPerUpload:nn(body.maxFilesPerUpload),moderated:false,bytesReceived:0,allowZip:false,allowDelete:type==='collab'&&!!body.allowDelete&&!!password,webStorage:{...webStorageConnectorSnapshot(connector),path:remotePath,isDir:true,sourceId:stat.id||null,sourceName:String(stat.name||'').slice(0,255)}};
    const note=(String(body.note||'').replace(/\r\n/g,'\n').trim()||String(getSettings().receptionBanner||'')).slice(0,2000);if(note)share.note=note;
    if(password){const protectedShare=await makeSharePassword(password);if(protectedShare.error)return sendPasswordWorkError(res,protectedShare.error);Object.assign(share,protectedShare);}applyAccessRules(share,body);if(share.expiresAt)share.expirySetAt=Date.now();
    if(type==='collab'&&webStorageDlpGate(req,res,body,share))return;
    stampOwner(share,req);const rec=addShareDurable(share,req);if(!rec)return res.status(503).json({error:'write-error'});
    auditReq(req,type==='collab'?'collab-created':'inbox-created',`web-storage ${share.name} via ${connector.name}`);
    return res.status(201).json({share:decorateShare(rec,req)});
  }
  adminRouter.post('/inbox/web-storage',requireFullAdmin,(req,res)=>createWebWritableShare(req,res,'inbox'));
  adminRouter.post('/collab/web-storage',requireFullAdmin,(req,res)=>createWebWritableShare(req,res,'collab'));

  adminRouter.post('/shares/web-storage', requireFullAdmin, async (req, res) => {
    const body = req.body || {};
    const currentConnector = getStorageConnector(body.connectorId);
    if (!currentConnector) return res.status(404).json({ error:'connector-not-found' });
    const connector = Object.freeze({ ...currentConnector });
    if (!Object.prototype.hasOwnProperty.call(body, 'remotePath')) return res.status(400).json({ error:'missing-remote-path' });
    const remotePath = cleanConnectorPath(body.remotePath);
    if (remotePath === null) return res.status(400).json({ error:'invalid-remote-path' });
    let stat;
    try { stat = await storageConnectorService.stat(connector, remotePath); }
    catch (error) {
      const code = connectorErrorCode(error);
      return res.status(connectorHttpStatus(code)).json({ error:code });
    }
    const recheckedConnector = getStorageConnector(connector.id);
    if (!recheckedConnector || recheckedConnector.remote !== connector.remote || recheckedConnector.root !== connector.root || recheckedConnector.type !== connector.type) {
      return res.status(409).json({ error:'connector-changed-during-create' });
    }
    const requestedName = String(body.name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
    const share = {
      type:'web-storage',
      name:requestedName || stat.name || path.posix.basename(remotePath) || connector.name || 'cloud-share',
      size:stat.isDir ? null : Math.max(0, Number(stat.size) || 0),
      startsAt:parseStartsAt(body.startsAt),
      expiresAt:resolveNewShareExpiry(body),
      maxDownloads:parseMaxDownloads(body.maxDownloads),
      webStorage:{ ...webStorageConnectorSnapshot(connector), path:remotePath, isDir:!!stat.isDir, sourceId:stat.id || null, sourceName:String(stat.name || '').slice(0,255) },
    };
    if (share.expiresAt) share.expirySetAt = Date.now();
    const optionError = await applyWebStorageShareOptions(share, body);
    if(optionError&&['auth-busy','password-too-long','scrypt-failed'].includes(optionError))return sendPasswordWorkError(res,optionError);
    if(optionError)return res.status(400).json({error:optionError});
    if (webStorageDlpGate(req, res, body, share)) return;
    stampOwner(share, req);
    const rec = addShareDurable(share, req);
    if (!rec) return res.status(503).json({ error:'write-error' });
    auditReq(req, 'share-created', `web-storage ${share.name || ''} via ${connector.name}`);
    res.status(201).json({ share:decorateShare(rec, req) });
  });

  adminRouter.post('/shares', async (req, res) => {
    const body = req.body || {};
    // One path (legacy) or several (multi-select in the picker). A single folder
    // stays a browsable folder share; anything else becomes a 'file' share whose
    // items[] carry the selection (files and/or folders — a "collection").
    const reqPaths = reqPathList(body);
    if (!reqPaths.length) return res.status(400).json({ error: 'missing-path' });
    let resolved;
    try {
      resolved = [];
      for (const p of reqPaths) resolved.push(await resolveHostItem(p));
    } catch (e) {
      return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' });
    }

    const first = resolved[0];
    const type = resolved.length > 1 ? 'file' : first.type; // a bundle is a 'file' collection
    const share = {
      type,
      hostPath: first.hostPath,
      name: first.name || first.hostPath || 'share',
      size: type === 'file' ? first.size : null,
      startsAt: parseStartsAt(body.startsAt),
      expiresAt: resolveNewShareExpiry(body), // instance policy + absolute/relative expiry
      maxDownloads: parseMaxDownloads(body.maxDownloads),
    };
    if (share.expiresAt) share.expirySetAt = Date.now();
    const color = normalizeShareColor(body.color);
    if (color === null) return res.status(400).json({ error: 'invalid-color' });
    if (color) share.color = color;
    const tags = normalizeTags(body.tags || []); if (tags.length) share.tags = tags;
    const descriptionMd = normalizeDescriptionMd(body.descriptionMd); if (descriptionMd) share.descriptionMd = descriptionMd;
    if (body.expiryReminderHours !== undefined && body.expiryReminderHours !== null && body.expiryReminderHours !== '') {
      const h = Number(body.expiryReminderHours); if (!Number.isFinite(h) || h < 0 || h > 8760) return res.status(400).json({ error: 'invalid-reminder' }); share.expiryReminderHours = Math.round(h * 10) / 10;
    }
    const forceNeverExpire = getSettings().newSharesNeverExpire === true;
    const firstUseExpirySeconds = forceNeverExpire ? 0 : boundedSeconds(body.firstUseExpirySeconds); if (firstUseExpirySeconds) share.firstUseExpirySeconds = firstUseExpirySeconds;
    const inactiveExpirySeconds = forceNeverExpire ? 0 : boundedSeconds(body.inactiveExpirySeconds); if (inactiveExpirySeconds) share.inactiveExpirySeconds = inactiveExpirySeconds;
    if (type === 'file') share.items = resolved.map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type }));
    // Mark a genuine multi-file bundle so the admin keeps showing its file list even
    // after it is whittled down to a single remaining item (a plain single-file share
    // is indistinguishable by item count alone).
    if (resolved.length > 1) share.collection = true;
    const password = String(body.password || '');
    // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
    // makeSharePassword() returns a fixed-shape { pwHash } object (a scrypt hash
    // of `password`, not `password` or any client-controlled keys) — there is no
    // attacker-controlled key set here, so no mass-assignment / exfiltration path.
    if (password) { const protectedShare = await makeSharePassword(password); if (protectedShare.error) return sendPasswordWorkError(res, protectedShare.error); Object.assign(share, protectedShare); }
    // A password hint is only meaningful alongside a password.
    if (password) { const hint = normalizePwHint(body.pwHint); if (hint) share.pwHint = hint; }
    // Optional per-IP download quota.
    const maxDlPerIp = parseMaxDownloadsPerIp(body.maxDownloadsPerIp); if (maxDlPerIp) share.maxDownloadsPerIp = maxDlPerIp;
    const shareEmoji = normalizeShareEmoji(body.emoji); if (shareEmoji) share.emoji = shareEmoji;
    const maxBytesServed = parseMaxBytesServed(body.maxBytesServed); if (maxBytesServed) share.maxBytesServed = maxBytesServed;
    const parsedRate = parseLinkRateKBps(body.rateKBps, { optional:true }); // per-link download cap (KB/s)
    if (!parsedRate.ok) return res.status(400).json({ error:'invalid-rate' });
    const rateKBps = parsedRate.value;
    if (rateKBps > 0) share.rateBps = rateKBps * 1024;
    // "Download all as .zip" is allowed by default; stored only when disabled.
    if (body.allowZip === false) share.allowZip = false;
    // In-browser preview is allowed by default; stored only when disabled.
    if (body.noPreview === true) share.noPreview = true;
    // One-time link: revoke the share after the first complete download.
    if (body.burnAfterDownload === true) share.burnAfterDownload = true;
    // Optional admin message shown to the visitor on the download page.
    if (typeof body.note === 'string') {
      const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 2000);
      if (note) share.note = note;
    }
    // Auto-revoke after N distinct visitors (0 / absent = unlimited).
    const maxVisitors = parseMaxVisitors(body.maxVisitors);
    if (maxVisitors > 0) share.maxVisitors = maxVisitors;
    // Download-goal alert — notify once when completed downloads reach N (0 = off).
    const dlThreshold = Math.max(0, Math.floor(Number(body.notifyDownloadThreshold) || 0));
    if (dlThreshold > 0) share.notifyDownloadThreshold = dlThreshold;
    if (body.requestAccess === true) share.requestAccess = true; // locked-until-approved gate
    if (body.allowFeedback === true) share.allowFeedback = true; // moderated visitor feedback
    applyAccessRules(share, body); // geo/IP rules

    let dlpScan = null;
    if (getSettings().dlpEnabled !== false) {
      dlpScan = await dlpScanResolvedItems(resolved);
      if (dlpDecision(req, res, body, dlpScan, 'share-create')) return;
      applyDlpSummary(share, dlpScan);
    }
    stampOwner(share, req);
    const rec = addShareDurable(share, req);
    if (!rec) return res.status(503).json({ error:'write-error' });
    // Prime the folder logical-size cache once, at creation, so the very first
    // /shares listing reports a truthful size instead of zero. The high-frequency
    // poll stays non-blocking because the walk has already happened here.
    if (shareNeedsLogicalBytesScan(rec)) { try { await refreshShareLogicalBytes(rec, true); } catch (_) {} }
    auditReq(req, 'share-created', share.type + ' ' + (share.name || ''));
    res.status(201).json({ share: decorateShare(rec, req) });
  });

  // Helpers below are also consumed by photo/PWA routes that remain outside this
  // route factory. Returning them keeps their dependencies explicit without
  // duplicating path-security or statistics logic in the composition root.
  return { detailedShareStatsPayload, reqPathList, resolveHostItem, safeReceivedFilePath };
}

function attachAdminShareRoutes(deps = {}) {
  const {
    APP_NAME,
    ENC_DIR,
    FULL_IMAGES_DIR,
    HOST_ROOT,
    INBOX_DIR,
    MICROS_DIR,
    PENDING_DIR,
    QRCode,
    SECRETS_DIR,
    SHARE_CHANGE_HISTORY_MAX,
    THUMBS_DIR,
    VISITOR_FEEDBACK_MAX,
    addShare,
    addShareCenterNotification,
    addShareDurable,
    adminRouter,
    appendReceptionThreadMessage,
    applyAccessRules,
    applyDlpSummary,
    applyNewShareLifetimePolicy,
    approvePendingModeration,
    assertRealWithin,
    auditReq,
    boundedSeconds,
    buildUniversalSearchIndex,
    claimPendingModeration,
    collabRoot,
    copyFirstExistingPhotoFile,
    copyPhotoFile,
    crypto,
    currentAccount,
    decorateShare,
    deleteFileExpiryForPath,
    detachActiveShare,
    dlpDecision,
    dlpScanResolvedItems,
    effMaxUpload,
    emailSendable,
    emitLiveActivity,
    finalizePendingModerationApproval,
    firstExistingPhotoFile,
    fs,
    getById,
    getByToken,
    getSettings,
    globalMetadataSearch,
    hostToContainer,
    inboxRejectStatus,
    invalidateShareLogicalBytes,
    isActive,
    isScheduled,
    linkPrefix,
    listShares,
    makeSharePassword,
    newStoredImageName,
    newToken,
    normExtList,
    normalizeDescriptionMd,
    normalizePwHint,
    normalizeShareColor,
    normalizeShareEmoji,
    ownerThreadMessage,
    ownsShare,
    parseExpiry,
    parseExpiryAt,
    parseLinkRateKBps,
    parseMaxBytesServed,
    parseMaxDownloads,
    parseMaxDownloadsPerIp,
    parseMaxVisitors,
    parseNewShareExpiry,
    parseStartsAt,
    path,
    pendingModerationRows,
    persistNow,
    photoAdaptivePath,
    photoExt,
    photoOriginalPaths,
    photoVariantPaths,
    primaryBase,
    pubIp,
    reactivateRevokedShare,
    receptionThreadArray,
    receptionThreadEnabled,
    receptionThreadUnreadCount,
    recordShareChange,
    recordUndoable,
    reindex,
    releasePendingModeration,
    reqPathList,
    requireFullAdmin,
    resolveHostItem,
    resolveNewShareExpiry,
    resolveWithin,
    restorePlainObject,
    rollbackRecordedUndo,
    scheduleSearchReindex,
    sendMail,
    sendPasswordWorkError,
    shareChangeSnapshot,
    shareLogicalBytesCache,
    softDeleteShare,
    stagePendingFileRemoval,
    stampOwner,
    stampPhotoUploadDevice,
    syncLiveActivityCache,
    universalSearchQuery,
    universalSearchScopedStatus,
    universalSearchShareEligible,
    universalSearchStatus,
    universalSemanticSearchQuery,
    clearShareRuntimeState,
    live,
  } = deps;

  if (!adminRouter || typeof adminRouter.get !== 'function') throw new TypeError('admin-share-routes requires adminRouter');
  if (!live || typeof live !== 'object') throw new TypeError('admin-share-routes requires live bindings');

  adminRouter.delete('/shares/:id', (req, res) => {
    const sh=getById(req.params.id); if(!sh||!ownsShare(req,sh))return res.status(404).json({error:'not-found'});
    const undoLabel=(sh.type||'share')+' '+(sh.name||'');
    const rec=softDeleteShare(req.params.id,req,true,{type:'share-trashed',label:undoLabel});
    if(rec===false)return res.status(503).json({error:'write-error'});
    if(!rec)return res.status(404).json({error:'not-found'});
    auditReq(req,'share-trashed',undoLabel);
    res.json({ok:true,trashId:rec.id,recoverable:true});
  });

  // 1.51.0 — reactivate a still-backed revoked link (for example a burned
  // one-time link) without resetting its independent expiry/quota configuration.
  adminRouter.post('/shares/:id/reactivate', async (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error:'not-found' });
    const result = await reactivateRevokedShare(sh, req);
    if (!result.ok) return res.status(result.status || 400).json({ error:result.error || 'reactivate-failed' });
    auditReq(req, 'share-reactivated', (sh.type || 'share') + ' ' + (sh.name || ''));
    emitLiveActivity('share', { shareId:sh.id, name:sh.name, status:'reactivated', detail:sh.type || 'share' });
    res.json({ ok:true, share:decorateShare(sh, req) });
  });

  // Emergency "cut all public access". Pauses every currently-active
  // link at once (reversible, unlike revoke/delete): no files are touched and each
  // link can be resumed individually or all together. Owner/admin only.
  adminRouter.post('/shares/pause-all', requireFullAdmin, (req, res) => {
    const now = Date.now();
    const changed = [];
    for (const s of listShares()) {
      // Scheduled links are public links too: leaving them untouched would let one
      // become live after the emergency pause had already been applied.
      if (!s || s.disabled || (!isActive(s, now) && !isScheduled(s, now))) continue;
      changed.push({ s, disabled:!!s.disabled, panicPaused:!!s.panicPaused });
      s.disabled = true; s.panicPaused = true;
    }
    const paused = changed.length;
    if (paused && !persistNow()) {
      for (const row of changed) { if (row.disabled) row.s.disabled=true; else delete row.s.disabled; if (row.panicPaused) row.s.panicPaused=true; else delete row.s.panicPaused; }
      return res.status(503).json({ error:'write-error' });
    }
    if (paused) {
      auditReq(req, 'shares-paused-all', paused + ' link(s)');
      emitLiveActivity('security', { status: 'paused-all', detail: paused + ' link(s) paused' });
    }
    res.json({ ok: true, paused });
  });

  // Companion to the panic button: lift the pause ONLY on the links it suspended,
  // so a link the admin had intentionally paused beforehand stays paused.
  adminRouter.post('/shares/resume-all', requireFullAdmin, (req, res) => {
    const changed = [];
    for (const s of listShares()) {
      if (s && s.disabled && s.panicPaused) { changed.push({s}); delete s.disabled; delete s.panicPaused; }
    }
    const resumed = changed.length;
    if (resumed && !persistNow()) {
      for (const row of changed) { row.s.disabled=true; row.s.panicPaused=true; }
      return res.status(503).json({ error:'write-error' });
    }
    if (resumed) {
      auditReq(req, 'shares-resumed-all', resumed + ' link(s)');
      emitLiveActivity('security', { status: 'resumed-all', detail: resumed + ' link(s) resumed' });
    }
    res.json({ ok: true, resumed });
  });

  // Duplicate a share into a brand-new link. Only configuration is copied:
  // identity, counters, visitors, logs, recipient links and received data are reset.
  // Managed image files are physically copied so revoking either image cannot break
  // the other one. Encrypted shares and secret notes remain intentionally excluded.
  adminRouter.post('/shares/:id/clone', async (req, res) => {
    const source = getById(req.params.id);
    if (!source || !ownsShare(req, source)) return res.status(404).json({ error: 'not-found' });
    if (source.encrypted || source.type === 'secret') return res.status(400).json({ error: 'cannot-clone' });

    const requestedName = String((req.body && req.body.name) || '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 200);
    const suffix = String((req.body && req.body.nameSuffix) || '(copy)')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 40);
    const nextName = requestedName || (((source.name || 'Share') + ' ' + suffix).trim().slice(0, 200));
    if (!nextName) return res.status(400).json({ error: 'invalid-name' });

    const clone = JSON.parse(JSON.stringify(source));
    for (const key of [
      'id', 'token', 'createdAt', 'downloads', 'revoked', 'disabled',
      'burnedAt', 'burnedReason', 'visitors', 'views', 'expiryWarnedAt', 'downloadLimitReachedAt',
      'messages', 'pending', 'recipients', 'encPath', 'ownerId', 'ownerName', 'ownerDeviceId',
      'pstats', 'bytesReceived', 'pinned', 'archived', 'autoArchivedAt', 'favorite', 'changeHistory', 'lastViewAt', 'lastUseAt', 'lastDownload', 'lastUpload', 'firstUsedAt', 'firstUseExpiresAt', 'firstUseExpiryWarnedDeadline', 'expirySetAt', 'inactiveExpiryWarnedDeadline', 'statsBaseline', 'adminComments', 'editedAt',
      'firstViewNotifiedAt', 'firstViewKind', 'firstViewIp', 'firstViewPushPending', 'firstViewPushQueuedAt', 'firstViewPushAcceptedAt', 'downloadThresholdNotifiedAt',
      'centerFirstDepositAt', 'centerProtectedFirstAccessAt', 'centerNotificationCountries',
      'centerViewMilestones', 'centerDownloadMilestones', 'centerVisitorAgents', 'centerExpiredDeadline',
      'receivedHashes', 'senderStats', 'webStorageUploaded', 'versions', 'editHistory', 'cacheRevision', 'cacheInvalidatedAt',
      'ipDownloads', 'bytesServed', 'firstViewPushAcceptedCount', 'centerFileSignature', 'centerFileFingerprint',
      'retentionReason', 'retentionRevokedAt', 'uploadDeviceName', 'uploadSource',
    ]) delete clone[key];

    clone.name = nextName;
    // A direct image URL derives its extension from the display name. Preserve the
    // actual source format even when the user enters a name without an extension.
    if (source.type === 'photo') {
      const ext = photoExt(source);
      const baseName = nextName.replace(/\.(?:jpe?g|png|gif|webp|bmp|avif)$/i, '').trim() || 'Image';
      clone.name = (baseName + '.' + ext).slice(0, 200);
    }
    clone.downloads = 0;
    clone.revoked = false;

    let freshInboxDir = null;
    const copiedPhotoFiles = [];

    try {
      if ((source.type === 'inbox' || source.type === 'collab') && !source.webStorage) {
        const base = nextName
          .replace(/[^A-Za-z0-9 _.-]/g, '_')
          .replace(/^\.+/, '')
          .trim()
          .slice(0, 50) || source.type;
        clone.relDir = base + '-' + crypto.randomBytes(3).toString('hex');
        clone.bytesReceived = 0;
        freshInboxDir = resolveWithin(INBOX_DIR, clone.relDir);
        await fs.promises.mkdir(freshInboxDir, { recursive: true });
      }
      if(source.webStorage&&(source.type==='inbox'||source.type==='collab')){delete clone.relDir;clone.bytesReceived=0;clone.allowZip=false;}

      if (source.type === 'photo') {
        let original = firstExistingPhotoFile(photoOriginalPaths(source));
        if (!original && source.hostPath) {
          try {
            const candidate = hostToContainer(source.hostPath);
            await assertRealWithin(HOST_ROOT, candidate);
            if ((await fs.promises.stat(candidate)).isFile()) original = candidate;
          } catch (_) {}
        }
        if (!original) return res.status(409).json({ error: 'image-missing' });

        // Reserve the final identity before copying token-bound Mini/Micro files.
        do { clone.id = crypto.randomBytes(8).toString('hex'); } while (getById(clone.id));
        do { clone.token = newToken(); } while (getByToken(clone.token));
        clone.createdAt = Date.now();

        const storedName = newStoredImageName(clone.name || source.name || source.imgPath || 'image.jpg');
        const fullDestination = path.join(FULL_IMAGES_DIR, storedName);
        await copyPhotoFile(original, fullDestination);
        copiedPhotoFiles.push(fullDestination);
        clone.imgPath = storedName;

        clone.thumb = false;
        if (source.thumb) {
          const thumbDestination = path.join(THUMBS_DIR, clone.token + '.jpg');
          if (await copyFirstExistingPhotoFile(photoVariantPaths(source.token, 'thumb'), thumbDestination)) {
            clone.thumb = true;
            copiedPhotoFiles.push(thumbDestination);
          }
        }

        clone.micro = false;
        if (source.micro) {
          const microDestination = path.join(MICROS_DIR, clone.token + '.jpg');
          if (await copyFirstExistingPhotoFile(photoVariantPaths(source.token, 'micro'), microDestination)) {
            clone.micro = true;
            copiedPhotoFiles.push(microDestination);
          }
        }
        for (const fmt of ['webp','avif']) {
          const prefix = fmt === 'webp' ? 'adaptiveWebp' : 'adaptiveAvif';
          for (const suffix of ['', 'Size', 'W', 'H']) delete clone[prefix + suffix];
          if (!source[prefix]) continue;
          const srcAdaptive = photoAdaptivePath(source.token, fmt);
          const dstAdaptive = photoAdaptivePath(clone.token, fmt);
          try {
            if (srcAdaptive && dstAdaptive && (await fs.promises.stat(srcAdaptive)).isFile()) {
              await copyPhotoFile(srcAdaptive, dstAdaptive);
              copiedPhotoFiles.push(dstAdaptive);
              clone[prefix] = true;
              clone[prefix + 'Size'] = Math.max(0, Number(source[prefix + 'Size']) || (await fs.promises.stat(dstAdaptive)).size || 0);
              if (source[prefix + 'W']) clone[prefix + 'W'] = source[prefix + 'W'];
              if (source[prefix + 'H']) clone[prefix + 'H'] = source[prefix + 'H'];
            }
          } catch (_) {
            for (const suffix of ['', 'Size', 'W', 'H']) delete clone[prefix + suffix];
          }
        }
      }

      stampOwner(clone, req);
      if (clone.type === 'photo') stampPhotoUploadDevice(clone, req, 'web');
      applyNewShareLifetimePolicy(clone);
      const record = addShare(clone, req, { action: 'created-from-duplicate', fields: ['name'], before: { name: source.name || '' } }, false);
      if (!persistNow()) { detachActiveShare(record); const e = new Error('write-error'); e.code = 'WRITE_ERROR'; throw e; }
      auditReq(req, 'share-cloned', (source.name || source.id) + ' → ' + record.id);
      return res.status(201).json({ share: decorateShare(record, req) });
    } catch (error) {
      for (const file of copiedPhotoFiles) {
        try { await fs.promises.unlink(file); } catch (_) {}
      }
      if (freshInboxDir) {
        try { await fs.promises.rmdir(freshInboxDir); } catch (_) {}
      }
      console.error('[clone] could not duplicate share:', error.message);
      return res.status(error && error.code === 'WRITE_ERROR' ? 503 : 500).json({ error: error && error.code === 'WRITE_ERROR' ? 'write-error' : 'clone-failed' });
    }
  });

  // E-mail a link to a recipient via the configured SMTP (best-effort). Needs a
  // sendable SMTP config (host/url + From); a default notification recipient is not
  // required.
  adminRouter.post('/shares/:id/email', async (req, res) => {
    if (!emailSendable()) return res.status(400).json({ error: 'email-not-configured' });
    const s = getById(req.params.id);
    if (!s) return res.status(404).json({ error: 'not-found' });
    const to = String((req.body && req.body.to) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'invalid-email' });
    const base = primaryBase(req);
    const url = (base || '') + linkPrefix(s) + s.token;
    const note = String((req.body && req.body.message) || '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
    const subject = `${APP_NAME} — ${s.name || 'Link'}`;
    const text = `${note ? note + '\n\n' : ''}${s.name || 'Link'}\n${url}\n\n— ${APP_NAME}`;
    const r = await sendMail(subject, text, to);
    if (r && r.ok) { auditReq(req, 'share-emailed', (s.name || s.id) + ' → ' + to); return res.json({ ok: true }); }
    res.status(400).json({ error: (r && r.error) || 'send-failed' });
  });

  // Per-share administrator change history. Values are deliberately bounded and
  // password material is never recorded.
  // Reset dashboard statistics without resetting operational quotas. Raw download/
  // visitor counters remain untouched so a reset cannot reopen an exhausted link.
  adminRouter.post('/shares/:id/reset-stats', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const beforeBaseline = sh.statsBaseline ? JSON.parse(JSON.stringify(sh.statsBaseline)) : null;
    const raw = (live.state.stats && live.state.stats[sh.id]) || {};
    sh.statsBaseline = {
      at: Date.now(), downloads: Math.max(0, Number(sh.downloads) || 0), views: Math.max(0, Number(sh.views) || 0),
      visitors: Array.isArray(sh.visitors) ? sh.visitors.length : 0,
      count: Math.max(0, Number(raw.count) || 0), bytes: Math.max(0, Number(raw.bytes) || 0), up: Math.max(0, Number(raw.up) || 0), down: Math.max(0, Number(raw.down) || 0),
      completed: Math.max(0, Number(raw.completed) || 0), interrupted: Math.max(0, Number(raw.interrupted) || 0),
    };
    const expectedBaseline = JSON.parse(JSON.stringify(sh.statsBaseline));
    const undoEntry = recordUndoable(req, 'share-stats-reset', sh.name || sh.id, beforeBaseline
      ? { kind: 'share-assign', shareId: sh.id, set: { statsBaseline: beforeBaseline }, expect: { statsBaseline: expectedBaseline } }
      : { kind: 'share-assign', shareId: sh.id, unset: ['statsBaseline'], expect: { statsBaseline: expectedBaseline } });
    if (!persistNow()) { if (beforeBaseline) sh.statsBaseline = beforeBaseline; else delete sh.statsBaseline; rollbackRecordedUndo(undoEntry); return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'share-stats-reset', sh.name || sh.id);
    res.json({ share: decorateShare(sh, req) });
  });

  const SHARE_ADMIN_COMMENTS_MAX = 100;
  adminRouter.get('/shares/:id/comments', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    res.json({ comments: Array.isArray(sh.adminComments) ? sh.adminComments.slice(0, SHARE_ADMIN_COMMENTS_MAX) : [] });
  });
  adminRouter.post('/shares/:id/comments', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const text = String(req.body && req.body.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'empty-comment' });
    const acc = currentAccount(req);
    const comment = { id: crypto.randomBytes(8).toString('hex'), at: Date.now(), actor: (acc && acc.username) || req.session.username || 'admin', text };
    const beforeComments = Array.isArray(sh.adminComments) ? JSON.parse(JSON.stringify(sh.adminComments)) : null;
    if (!Array.isArray(sh.adminComments)) sh.adminComments = [];
    sh.adminComments.unshift(comment);
    if (sh.adminComments.length > SHARE_ADMIN_COMMENTS_MAX) sh.adminComments.length = SHARE_ADMIN_COMMENTS_MAX;
    if (!persistNow()) { if (beforeComments) sh.adminComments = beforeComments; else delete sh.adminComments; return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'share-comment-added', sh.name || sh.id);
    res.status(201).json({ comment, count: sh.adminComments.length });
  });
  adminRouter.delete('/shares/:id/comments/:cid', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const previousComments = Array.isArray(sh.adminComments) ? JSON.parse(JSON.stringify(sh.adminComments)) : [];
    const before = previousComments.length;
    sh.adminComments = (Array.isArray(sh.adminComments) ? sh.adminComments : []).filter((c) => c && c.id !== req.params.cid);
    if (sh.adminComments.length === before) return res.status(404).json({ error: 'comment-not-found' });
    if (!persistNow()) { sh.adminComments = previousComments; return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'share-comment-deleted', sh.name || sh.id);
    res.json({ ok: true, count: sh.adminComments.length });
  });

  // Two-way reception thread (owner side, standard admin). Same store
  // as the visitor endpoints; posting also clears the unread flag on prior replies.
  adminRouter.get('/shares/:id/thread', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || sh.type !== 'inbox' || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: receptionThreadEnabled(sh), unread: receptionThreadUnreadCount(sh), messages: receptionThreadArray(sh).map(ownerThreadMessage) });
  });
  adminRouter.post('/shares/:id/thread', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || sh.type !== 'inbox' || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    if (req.session.role === 'auditor') return res.status(403).json({ error: 'read-only' });
    const text = String(req.body && req.body.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'empty' });
    const previous = Array.isArray(sh.thread) ? JSON.parse(JSON.stringify(sh.thread)) : null;
    receptionThreadArray(sh).forEach((m) => { if (m.from === 'visitor') m.read = true; });
    appendReceptionThreadMessage(sh, { id: crypto.randomBytes(8).toString('hex'), at: Date.now(), from: 'owner', name: null, text });
    if (!persistNow()) { if (previous) sh.thread = previous; else delete sh.thread; return res.status(503).json({ error: 'write-error' }); }
    auditReq(req, 'reception-thread-reply', sh.name || sh.id);
    res.status(201).json({ ok: true, unread: receptionThreadUnreadCount(sh), messages: receptionThreadArray(sh).map(ownerThreadMessage) });
  });
  adminRouter.post('/shares/:id/thread/read', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || sh.type !== 'inbox' || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    let changed = false;
    receptionThreadArray(sh).forEach((m) => { if (m.from === 'visitor' && m.read === false) { m.read = true; changed = true; } });
    if (changed && !persistNow()) return res.status(503).json({ error: 'write-error' });
    res.json({ ok: true, unread: 0 });
  });
  adminRouter.delete('/shares/:id/thread', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || sh.type !== 'inbox' || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    if (req.session.role === 'auditor') return res.status(403).json({ error: 'read-only' });
    const previous = Array.isArray(sh.thread) ? sh.thread : null;
    if (!previous || !previous.length) return res.json({ ok: true, cleared: 0 });
    const count = previous.length; sh.thread = [];
    if (!persistNow()) { sh.thread = previous; return res.status(503).json({ error: 'write-error' }); }
    auditReq(req, 'reception-thread-cleared', sh.name || sh.id);
    res.json({ ok: true, cleared: count });
  });

  // Access-request moderation. Requests live on each share; this
  // aggregates those the caller owns; approve/deny/delete act on a single one.
  adminRouter.get('/access-requests', (req, res) => {
    const out = [];
    for (const s of listShares()) {
      if (!ownsShare(req, s) || !Array.isArray(s.accessRequests)) continue;
      for (const r of s.accessRequests) {
        out.push({ id: r.id, name: r.name, email: r.email || null, message: r.message || null, at: r.at,
          ip: pubIp(r.ip), country: r.country || null, flag: r.flag || '🌐', status: r.status,
          decidedAt: r.decidedAt || 0, decidedBy: r.decidedBy || null,
          shareId: s.id, shareName: s.name, shareToken: s.token });
      }
    }
    // Pending first, then newest.
    out.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || (b.at || 0) - (a.at || 0));
    res.json({ requests: out.slice(0, 1000), pending: out.filter((r) => r.status === 'pending').length });
  });
  adminRouter.post('/shares/:id/access-requests/:rid/:decision', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const decision = req.params.decision;
    if (decision !== 'approve' && decision !== 'deny') return res.status(400).json({ error: 'bad-decision' });
    const r = (Array.isArray(sh.accessRequests) ? sh.accessRequests : []).find((x) => x && x.id === req.params.rid);
    if (!r) return res.status(404).json({ error: 'request-not-found' });
    const beforeRequest = JSON.parse(JSON.stringify(r));
    r.status = decision === 'approve' ? 'approved' : 'denied';
    r.decidedAt = Date.now();
    r.decidedBy = req.session.username || 'admin';
    if (!persistNow()) { restorePlainObject(r, beforeRequest); return res.status(503).json({ error:'write-error' }); }
    auditReq(req, decision === 'approve' ? 'access-approved' : 'access-denied', `${sh.name || sh.id}: ${r.name || r.id}`);
    // Bonus: a courtesy e-mail to the requester on approval (best-effort; needs SMTP).
    if (decision === 'approve' && r.email) {
      const link = primaryBase(req) + linkPrefix(sh) + sh.token;
      sendMail(`${APP_NAME} — ${sh.name}`, `Your access request for "${sh.name}" was approved. Open: ${link}`, r.email).catch(() => {});
    }
    res.json({ ok: true, request: { id: r.id, status: r.status, decidedAt: r.decidedAt, decidedBy: r.decidedBy } });
  });
  adminRouter.delete('/shares/:id/access-requests/:rid', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const previousRequests = Array.isArray(sh.accessRequests) ? JSON.parse(JSON.stringify(sh.accessRequests)) : [];
    const before = previousRequests.length;
    sh.accessRequests = (Array.isArray(sh.accessRequests) ? sh.accessRequests : []).filter((r) => r && r.id !== req.params.rid);
    if (sh.accessRequests.length === before) return res.status(404).json({ error: 'request-not-found' });
    if (!persistNow()) { sh.accessRequests = previousRequests; return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'access-request-deleted', sh.name || sh.id);
    res.json({ ok: true });
  });

  // Moderated visitor feedback (private to the admin, never public).
  adminRouter.get('/shares/:id/feedback', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const list = (Array.isArray(sh.visitorFeedback) ? sh.visitorFeedback : []).slice(0, VISITOR_FEEDBACK_MAX)
      .map((f) => ({ id: f.id, at: f.at, name: f.name || null, body: f.body,
        country: f.country || null, flag: f.flag || '🌐', ip: pubIp(f.ip), read: !!f.read }));
    res.json({ feedback: list, unread: list.filter((f) => !f.read).length });
  });
  adminRouter.post('/shares/:id/feedback/:fid/read', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const f = (Array.isArray(sh.visitorFeedback) ? sh.visitorFeedback : []).find((x) => x && x.id === req.params.fid);
    if (!f) return res.status(404).json({ error: 'feedback-not-found' });
    const previousRead = !!f.read;
    f.read = !(req.body && req.body.read === false);
    if (!persistNow()) { f.read = previousRead; return res.status(503).json({ error:'write-error' }); }
    res.json({ ok: true, read: !!f.read });
  });
  adminRouter.delete('/shares/:id/feedback/:fid', (req, res) => {
    const sh = getById(req.params.id);
    if (!sh || !ownsShare(req, sh)) return res.status(404).json({ error: 'not-found' });
    const previousFeedback = Array.isArray(sh.visitorFeedback) ? JSON.parse(JSON.stringify(sh.visitorFeedback)) : [];
    const before = previousFeedback.length;
    sh.visitorFeedback = (Array.isArray(sh.visitorFeedback) ? sh.visitorFeedback : []).filter((f) => f && f.id !== req.params.fid);
    if (sh.visitorFeedback.length === before) return res.status(404).json({ error: 'feedback-not-found' });
    if (!persistNow()) { sh.visitorFeedback = previousFeedback; return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'feedback-deleted', sh.name || sh.id);
    res.json({ ok: true });
  });

  adminRouter.get('/shares/:id/change-history', (req, res) => {
    const s = getById(req.params.id);
    if (!s || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });
    res.json({ id: s.id, name: s.name || '', entries: Array.isArray(s.changeHistory) ? s.changeHistory.slice(0, SHARE_CHANGE_HISTORY_MAX) : [] });
  });

  // Edit an existing link in place (without recreating it / changing its
  // URL): extend or change the expiry, password, quota, speed, .zip/preview toggles,
  // deferred start, one-time flag and name. Only provided fields are touched.
  adminRouter.patch('/shares/:id', async (req, res) => {
    const live = getById(req.params.id);
    if (!live || !ownsShare(req, live)) return res.status(404).json({ error: 'not-found' });
    // Edit a detached draft. Validation failures later in this large route must not
    // leave earlier fields mutated in RAM and accidentally persist them on a future write.
    const s = JSON.parse(JSON.stringify(live));
    const body = req.body || {};
    const changed = [];
    const changeBefore = shareChangeSnapshot(s);

    if (typeof body.name === 'string') {
      const nm = body.name.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
      if (nm && nm !== s.name) { s.name = nm; changed.push('name'); }
    }
    if (body.expiresAt !== undefined) {
      // Absolute expiry timestamp (empty/past = never). Takes precedence.
      const next = parseExpiryAt(body.expiresAt);
      if (next !== s.expiresAt) {
        s.expiresAt = next;
        s.expirySetAt = Date.now();
        delete s.expiryWarnedAt; // re-arm the "expiring soon" alert for the new date
        changed.push('expiresAt');
      }
    } else if (body.expiresInSeconds !== undefined) {
      const rawExpiry = Number(body.expiresInSeconds);
      if (!Number.isInteger(rawExpiry) || rawExpiry < 0) return res.status(400).json({ error: 'invalid-duration' });
      const next = parseExpiry(rawExpiry); // 0 = never
      if (next !== s.expiresAt) {
        s.expiresAt = next;
        s.expirySetAt = Date.now();
        delete s.expiryWarnedAt; // re-arm the "expiring soon" alert for the new date
        changed.push('expiresAt');
      }
    }
    if (body.startsAt !== undefined) {
      const next = parseStartsAt(body.startsAt); // null = active immediately
      if (next !== (s.startsAt || null)) { s.startsAt = next; changed.push('startsAt'); }
    }
    if (body.maxDownloads !== undefined) {
      const next = parseMaxDownloads(body.maxDownloads); // null = unlimited
      const previous = s.maxDownloads || null;
      if (next !== previous) {
        const count = Math.max(0, Number(s.downloads) || 0);
        const wasExhausted = Number(previous) > 0 && count >= Number(previous);
        s.maxDownloads = next;
        if (Number(next) > 0 && count >= Number(next)) {
          if (!wasExhausted || !s.downloadLimitReachedAt) s.downloadLimitReachedAt = Date.now();
        } else delete s.downloadLimitReachedAt;
        changed.push('maxDownloads');
      }
    }
    if (body.rateKBps !== undefined) {
      const parsedRate = parseLinkRateKBps(body.rateKBps);
      if (!parsedRate.ok) return res.status(400).json({ error:'invalid-rate' });
      const kb = parsedRate.value;
      const current = s.rateBps > 0 ? Math.round(s.rateBps / 1024) : 0;
      if (kb !== current) { if (kb > 0) s.rateBps = kb * 1024; else delete s.rateBps; changed.push('rateKBps'); }
    }
    if (typeof body.allowZip === 'boolean' && body.allowZip !== (s.allowZip !== false)) {
      if (s.webStorage && body.allowZip) return res.status(400).json({ error:'zip-unavailable-for-web-storage' });
      if (body.allowZip) delete s.allowZip; else s.allowZip = false;
      changed.push('allowZip');
    }
    if (s.webStorage) s.allowZip = false;
    if (typeof body.noPreview === 'boolean' && body.noPreview !== !!s.noPreview) {
      if (body.noPreview) s.noPreview = true; else delete s.noPreview;
      changed.push('noPreview');
    }
    if (typeof body.burnAfterDownload === 'boolean' && body.burnAfterDownload !== !!s.burnAfterDownload) {
      if (body.burnAfterDownload) s.burnAfterDownload = true; else delete s.burnAfterDownload;
      changed.push('burnAfterDownload');
    }
    if (body.maxVisitors !== undefined) {
      const mv = parseMaxVisitors(body.maxVisitors);
      const current = Math.max(0, Number(s.maxVisitors) || 0);
      if (mv !== current) { if (mv > 0) s.maxVisitors = mv; else delete s.maxVisitors; changed.push('maxVisitors'); }
    }
    // Download-goal alert threshold (0 = off). Changing it re-arms the one-shot alert
    // so a new goal can fire again even if a previous one already did.
    if (body.notifyDownloadThreshold !== undefined) {
      const n = Math.max(0, Math.floor(Number(body.notifyDownloadThreshold) || 0));
      const current = Math.max(0, Number(s.notifyDownloadThreshold) || 0);
      if (n !== current) {
        if (n > 0) s.notifyDownloadThreshold = n; else delete s.notifyDownloadThreshold;
        delete s.downloadThresholdNotifiedAt; // re-arm for the new goal
        changed.push('notifyDownloadThreshold');
      }
    }
    // Password: absent key = keep; '' = clear; non-empty = set (re-hashed).
    if (typeof body.password === 'string') {
      if (body.password === '') {
        if (s.pwHash) { delete s.pwHash; delete s.pwSalt; changed.push('password-cleared'); }
        if (s.pwHint) { delete s.pwHint; changed.push('pwHint-cleared'); } // a hint is pointless without a password
        // Visitor deletion requires a password — clearing it must disable deletion
        // too, so an unprotected collab link never allows deletes.
        if (s.allowDelete) { delete s.allowDelete; changed.push('allowDelete-off'); }
      } else {
        const protectedShare = await makeSharePassword(body.password);
        if (protectedShare.error) return sendPasswordWorkError(res, protectedShare.error);
        Object.assign(s, protectedShare);
        changed.push('password-set');
      }
    }
    // Password hint (kept only while the link actually has a password).
    if (typeof body.pwHint === 'string') {
      const hint = normalizePwHint(body.pwHint);
      const next = hint && s.pwHash ? hint : '';
      if (next !== (s.pwHint || '')) { if (next) s.pwHint = next; else delete s.pwHint; changed.push('pwHint'); }
    }
    // Per-IP download quota (0 = unlimited).
    if (body.maxDownloadsPerIp !== undefined) {
      const n = parseMaxDownloadsPerIp(body.maxDownloadsPerIp);
      const current = Math.max(0, Number(s.maxDownloadsPerIp) || 0);
      if (n !== current) { if (n > 0) s.maxDownloadsPerIp = n; else delete s.maxDownloadsPerIp; changed.push('maxDownloadsPerIp'); }
    }
    // Emoji marker (1–2 code points; empty clears it).
    if (typeof body.emoji === 'string') {
      const em = normalizeShareEmoji(body.emoji);
      if (em !== (s.emoji || '')) { if (em) s.emoji = em; else delete s.emoji; changed.push('emoji'); }
    }
    // Total bytes-served cap (0 = unlimited).
    if (body.maxBytesServed !== undefined) {
      const n = parseMaxBytesServed(body.maxBytesServed);
      const current = Math.max(0, Number(s.maxBytesServed) || 0);
      if (n !== current) { if (n > 0) s.maxBytesServed = n; else delete s.maxBytesServed; changed.push('maxBytesServed'); }
    }

    if (typeof body.note === 'string') {
      const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 2000);
      if (note !== (s.note || '')) {
        if (note) s.note = note; else delete s.note;
        changed.push('note');
      }
    }
    // Private admin note (never shown to visitors — for the admin's own reference).
    if (typeof body.adminNote === 'string') {
      const an = body.adminNote.replace(/\r\n/g, '\n').trim().slice(0, 1000);
      if (an !== (s.adminNote || '')) {
        if (an) s.adminNote = an; else delete s.adminNote;
        changed.push('adminNote');
      }
    }
    // Dashboard-only organization flags. Archive hides a link from the default
    // admin list but intentionally leaves the public URL active.
    if (typeof body.pinned === 'boolean' && body.pinned !== !!s.pinned) {
      if (body.pinned) s.pinned = true; else delete s.pinned;
      changed.push('pinned');
    }
    if (typeof body.archived === 'boolean' && body.archived !== !!s.archived) {
      if (body.archived) s.archived = true; else delete s.archived;
      changed.push('archived');
    }
    if (body.color !== undefined) {
      const color = normalizeShareColor(body.color);
      if (color === null) return res.status(400).json({ error: 'invalid-color' });
      if (color !== (s.color || '')) { if (color) s.color = color; else delete s.color; changed.push('color'); }
    }
    if (body.descriptionMd !== undefined) {
      const descriptionMd = normalizeDescriptionMd(body.descriptionMd);
      if (descriptionMd !== (s.descriptionMd || '')) { if (descriptionMd) s.descriptionMd = descriptionMd; else delete s.descriptionMd; changed.push('descriptionMd'); }
    }
    if (body.expiryReminderHours !== undefined) {
      const raw = body.expiryReminderHours;
      if (raw === null || raw === '' || Number(raw) < 0) {
        if (s.expiryReminderHours != null) {
          delete s.expiryReminderHours;
          delete s.expiryWarnedAt; delete s.firstUseExpiryWarnedDeadline; delete s.inactiveExpiryWarnedDeadline;
          changed.push('expiryReminderHours');
        }
      } else {
        const h = Number(raw); if (!Number.isFinite(h) || h > 8760) return res.status(400).json({ error: 'invalid-reminder' });
        const rounded = Math.round(h * 10) / 10;
        if (rounded !== Number(s.expiryReminderHours)) {
          s.expiryReminderHours = rounded;
          delete s.expiryWarnedAt; delete s.firstUseExpiryWarnedDeadline; delete s.inactiveExpiryWarnedDeadline;
          changed.push('expiryReminderHours');
        }
      }
    }
    if (body.firstUseExpirySeconds !== undefined) {
      const seconds = boundedSeconds(body.firstUseExpirySeconds);
      if (seconds !== (Number(s.firstUseExpirySeconds) || 0)) {
        if (seconds) s.firstUseExpirySeconds = seconds; else delete s.firstUseExpirySeconds;
        if (s.firstUsedAt && seconds) s.firstUseExpiresAt = Number(s.firstUsedAt) + seconds * 1000;
        else delete s.firstUseExpiresAt;
        delete s.firstUseExpiryWarnedDeadline;
        changed.push('firstUseExpirySeconds');
      }
    }
    if (body.inactiveExpirySeconds !== undefined) {
      const seconds = boundedSeconds(body.inactiveExpirySeconds);
      if (seconds !== (Number(s.inactiveExpirySeconds) || 0)) { if (seconds) s.inactiveExpirySeconds = seconds; else delete s.inactiveExpirySeconds; changed.push('inactiveExpirySeconds'); }
    }

    // Pause / resume: temporarily deactivate the link without deleting it (reversible).
    if (typeof body.disabled === 'boolean' && body.disabled !== !!s.disabled) {
      if (body.disabled) s.disabled = true; else delete s.disabled;
      delete s.panicPaused; // a manual pause/resume takes the link out of panic-button scope
      changed.push(body.disabled ? 'disabled' : 'enabled');
    }
    // Toggle the access-request gate.
    if (typeof body.requestAccess === 'boolean' && body.requestAccess !== !!s.requestAccess) {
      if (body.requestAccess) s.requestAccess = true; else delete s.requestAccess;
      changed.push(body.requestAccess ? 'requestAccess' : 'requestAccessOff');
    }
    // Toggle the moderated visitor-feedback form.
    if (typeof body.allowFeedback === 'boolean' && body.allowFeedback !== !!s.allowFeedback) {
      if (body.allowFeedback) s.allowFeedback = true; else delete s.allowFeedback;
      changed.push(body.allowFeedback ? 'allowFeedback' : 'allowFeedbackOff');
    }
    // Reception/collaboration rules are editable after creation. This keeps the
    // link identity/token while allowing quotas, filters and safety policy to evolve.
    if (s.type === 'inbox' || s.type === 'collab') {
      let invalidReceptionRule = false;
      const editPositiveInt = (key, value) => {
        if (value === undefined) return;
        const raw = Number(value);
        if (!Number.isFinite(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER) { invalidReceptionRule = true; return; }
        const next = Math.floor(raw);
        const cur = Math.max(0, Number(s[key]) || 0);
        if (next !== cur) { if (next) s[key] = next; else delete s[key]; changed.push(key); }
      };
      editPositiveInt('maxFiles', body.maxFiles);
      editPositiveInt('maxFilesPerUpload', body.maxFilesPerUpload);
      editPositiveInt('maxFileBytes', body.maxFileBytes);
      editPositiveInt('maxTotalBytes', body.maxTotalBytes);
      editPositiveInt('maxFilesPerSender', body.maxFilesPerSender);
      editPositiveInt('maxBytesPerSender', body.maxBytesPerSender);
      if (invalidReceptionRule) return res.status(400).json({ error:'invalid-reception-rule' });
      for (const key of ['allowExt','blockExt']) {
        if (body[key] !== undefined) {
          const next = normExtList(body[key]);
          const cur = Array.isArray(s[key]) ? s[key] : [];
          if (next.join('\0') !== cur.join('\0')) { if (next.length) s[key] = next; else delete s[key]; changed.push(key); }
        }
      }
      if(s.webStorage&&((body.moderated===true)||(body.rejectDuplicates===true)))return res.status(400).json({error:'web-storage-write-policy-unavailable'});
      for (const key of ['groupBySender','tagBySender','rejectDuplicates','requireSenderName','blockExecutables','moderated']) {
        if (typeof body[key] === 'boolean' && body[key] !== !!s[key]) { if (body[key]) s[key] = true; else delete s[key]; changed.push(key); }
      }
      if (s.type === 'collab' && typeof body.allowDelete === 'boolean') {
        const next = !!body.allowDelete && !!s.pwHash;
        if (next !== !!s.allowDelete) { if (next) s.allowDelete = true; else delete s.allowDelete; changed.push('allowDelete'); }
      }
    }

    if (Array.isArray(body.tags)) {
      const tags = normalizeTags(body.tags);
      if (tags.join('\x00') !== (Array.isArray(s.tags) ? s.tags : []).join('\x00')) {
        if (tags.length) s.tags = tags; else delete s.tags;
        changed.push('tags');
      }
    }
    if (s.type === 'photo' && typeof body.favorite === 'boolean' && body.favorite !== !!s.favorite) {
      if (body.favorite) s.favorite = true; else delete s.favorite;
      changed.push(body.favorite ? 'favorite' : 'unfavorite');
    }

    if (body.geoMode !== undefined || body.ipMode !== undefined) {
      const accessBefore = shareChangeSnapshot(s);
      applyAccessRules(s, body); // geo/IP rules
      const accessAfter = shareChangeSnapshot(s);
      for (const key of ['geoMode', 'geoCountries', 'ipMode', 'ipList']) {
        if (JSON.stringify(accessBefore[key]) !== JSON.stringify(accessAfter[key])) changed.push(key);
      }
    }

    if (changed.length) {
      recordShareChange(s, req, 'edited', changed, changeBefore);
      const beforeFull = JSON.parse(JSON.stringify(live));
      restorePlainObject(live, s);
      if (!persistNow()) { restorePlainObject(live, beforeFull); return res.status(503).json({ error:'write-error' }); }
      auditReq(req, 'share-edited', (live.name || live.id) + ': ' + changed.join(', '));
    }
    res.json({ share: decorateShare(live, req) });
  });

  // True extension: add time to the current future expiry instead of replacing it
  // relative to now. An unlimited link starts from now when extended.
  adminRouter.post('/shares/:id/extend', (req, res) => {
    const s = getById(req.params.id);
    if (!s || !ownsShare(req, s)) return res.status(404).json({ error: 'not-found' });
    const rawSeconds = Number(req.body && req.body.seconds);
    if (!Number.isInteger(rawSeconds) || rawSeconds < 60) return res.status(400).json({ error: 'invalid-duration' });
    const seconds = Math.min(3650 * 86400, rawSeconds);
    const beforeFull = JSON.parse(JSON.stringify(s));
    const before = shareChangeSnapshot(s);
    const base = Math.max(Date.now(), Number(s.expiresAt) || 0);
    s.expiresAt = base + seconds * 1000;
    s.expirySetAt = Date.now();
    delete s.expiryWarnedAt;
    recordShareChange(s, req, 'extended', ['expiresAt'], before);
    if (!persistNow()) { restorePlainObject(s, beforeFull); return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'share-extended', `${s.name || s.id}: +${seconds}s`);
    res.json({ share: decorateShare(s, req) });
  });

  // Bulk actions on several links at once: revoke, extend/replace the
  // expiry, or add/remove a tag. Body: { ids:[...], action, expiresInSeconds?, tag? }.
  adminRouter.post('/shares/bulk', (req, res) => {
    const b = req.body || {};
    let ids = Array.isArray(b.ids) ? [...new Set(b.ids.map((id) => String(id || '')).filter(Boolean))].slice(0, 1000) : [];
    // Operators may only act on links they own.
    if (req.session.role === 'operator') ids = ids.filter((id) => ownsShare(req, getById(id)));
    const action = String(b.action || '');
    if (!ids.length) return res.status(400).json({ error: 'empty' });
    const beforeState = JSON.parse(JSON.stringify(live.state));
    const rollbackBulk = () => { live.state = beforeState; syncLiveActivityCache(); if (typeof clearShareRuntimeState === 'function') clearShareRuntimeState(); else { reindex(); shareLogicalBytesCache.clear(); } };
    const commitBulk = () => { if (persistNow()) return true; rollbackBulk(); return false; };
    let count = 0;
    if (action === 'revoke') {
      for (const id of ids) {
        const share = getById(id);
        if (share && softDeleteShare(id, req, false, { type:'share-trashed', label:(share.type||'share')+' '+(share.name||'') })) count += 1;
      }
      if (count && !commitBulk()) return res.status(503).json({ error:'write-error' });
    } else if (action === 'extend' || action === 'extend-by') {
      const rawExpiry = action === 'extend' ? Number(b.expiresInSeconds) : null;
      if (action === 'extend' && (!Number.isInteger(rawExpiry) || rawExpiry < 0)) return res.status(400).json({ error: 'invalid-duration' });
      const replaceExpiry = action === 'extend' ? parseExpiry(rawExpiry) : null;
      const rawAddSeconds = action === 'extend-by' ? Number(b.seconds) : 0;
      if (action === 'extend-by' && (!Number.isInteger(rawAddSeconds) || rawAddSeconds < 60)) return res.status(400).json({ error: 'invalid-duration' });
      const addSeconds = action === 'extend-by' ? Math.min(3650 * 86400, rawAddSeconds) : 0;
      for (const id of ids) {
        const s = getById(id); if (!s) continue;
        const before = shareChangeSnapshot(s);
        s.expiresAt = action === 'extend-by' ? Math.max(Date.now(), Number(s.expiresAt) || 0) + addSeconds * 1000 : replaceExpiry;
        s.expirySetAt = Date.now();
        delete s.expiryWarnedAt; count += 1;
        recordShareChange(s, req, action === 'extend-by' ? 'extended' : 'expiry-changed', ['expiresAt'], before);
      }
      if (count && !commitBulk()) return res.status(503).json({ error:'write-error' });
    } else if (action === 'tag-add' || action === 'tag-remove') {
      const tag = normalizeTags([b.tag])[0];
      if (!tag) return res.status(400).json({ error: 'invalid-tag' });
      for (const id of ids) {
        const s = getById(id); if (!s) continue;
        const before = shareChangeSnapshot(s);
        const cur = Array.isArray(s.tags) ? s.tags : [];
        let touched = false;
        if (action === 'tag-add') { if (!cur.some((x) => x.toLowerCase() === tag.toLowerCase())) { s.tags = [...cur, tag].slice(0, 20); count += 1; touched = true; } }
        else { const nt = cur.filter((x) => x.toLowerCase() !== tag.toLowerCase()); if (nt.length !== cur.length) { if (nt.length) s.tags = nt; else delete s.tags; count += 1; touched = true; } }
        if (touched) recordShareChange(s, req, action, ['tags'], before);
      }
      if (count && !commitBulk()) return res.status(503).json({ error:'write-error' });
    } else if (['pin','unpin','archive','unarchive'].includes(action)) {
      const field = action === 'pin' || action === 'unpin' ? 'pinned' : 'archived';
      const enabled = action === 'pin' || action === 'archive';
      for (const id of ids) {
        const s = getById(id); if (!s || !!s[field] === enabled) continue;
        const before = shareChangeSnapshot(s);
        if (enabled) s[field] = true; else delete s[field];
        recordShareChange(s, req, action, [field], before); count += 1;
      }
      if (count && !commitBulk()) return res.status(503).json({ error:'write-error' });
    } else if (action === 'favorite' || action === 'unfavorite') {
      const enabled = action === 'favorite';
      for (const id of ids) {
        const s = getById(id);
        if (!s || s.type !== 'photo') continue;
        if (!!s.favorite === enabled) continue;
        if (enabled) s.favorite = true; else delete s.favorite;
        count += 1;
      }
      if (count && !commitBulk()) return res.status(503).json({ error:'write-error' });
    } else if (action === 'album-add') {
      const album = getById(String(b.albumId || ''));
      if (!album || album.type !== 'album' || !ownsShare(req, album)) return res.status(404).json({ error: 'album-not-found' });
      const members = Array.isArray(album.members) ? album.members.slice(0, 500) : [];
      for (const id of ids) {
        const s = getById(id);
        if (!s || s.type !== 'photo' || !ownsShare(req, s) || members.includes(s.token)) continue;
        if (members.length >= 500) break;
        members.push(s.token);
        count += 1;
      }
      album.members = members;
      if (count && !commitBulk()) return res.status(503).json({ error:'write-error' });
    } else {
      return res.status(400).json({ error: 'invalid-action' });
    }
    auditReq(req, 'shares-bulk', `${action}: ${count}/${ids.length}`);
    res.json({ ok: true, count });
  });

  // Append one or more files/folders to an existing file share (a collection).
  // Accepts a single `path` (legacy) or a `paths` array (multi-select). Already-
  // present items are skipped; a 409 is returned only when nothing new was added.
  adminRouter.post('/shares/:id/items', async (req, res) => {
    const live = getById(req.params.id);
    if (!live || live.type !== 'file') return res.status(404).json({ error: 'not-found' });
    const s = JSON.parse(JSON.stringify(live));
    const reqPaths = reqPathList(req.body || {});
    if (!reqPaths.length) return res.status(400).json({ error: 'missing-path' });
    let resolved;
    try {
      resolved = [];
      for (const p of reqPaths) resolved.push(await resolveHostItem(p));
    } catch (e) {
      return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' });
    }
    if (getSettings().dlpEnabled !== false) {
      const scan = await dlpScanResolvedItems(resolved);
      if (dlpDecision(req, res, req.body || {}, scan, 'share-add-items')) return;
      if (scan.count) applyDlpSummary(s, scan);
    }
    if (!Array.isArray(s.items)) s.items = [{ hostPath: s.hostPath, name: s.name, size: s.size, type: 'file' }];
    let added = 0;
    for (const it of resolved) {
      if (s.items.some((x) => x.hostPath === it.hostPath)) continue;
      s.items.push({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type }); added += 1;
    }
    if (!added) return res.status(409).json({ error: 'already-added' });
    s.collection = true;
    const before = JSON.parse(JSON.stringify(live));
    restorePlainObject(live, s);
    if (!persistNow()) { restorePlainObject(live, before); return res.status(503).json({ error:'write-error' }); }
    invalidateShareLogicalBytes(live.id); scheduleSearchReindex();
    res.status(201).json({ share: decorateShare(live, req), added });
  });

  // Remove one file from a collection (the last remaining file cannot be removed).
  adminRouter.delete('/shares/:id/items/:idx', (req, res) => {
    const live = getById(req.params.id);
    if (!live || live.type !== 'file' || !Array.isArray(live.items)) return res.status(404).json({ error: 'not-found' });
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= live.items.length) return res.status(404).json({ error: 'not-found' });
    if (live.items.length <= 1) return res.status(400).json({ error: 'last-item' });
    const s = JSON.parse(JSON.stringify(live)), before = JSON.parse(JSON.stringify(live));
    s.items.splice(idx, 1); s.hostPath=s.items[0].hostPath; s.name=s.items[0].name;
    s.size=(s.items[0].type||'file')==='folder'?null:s.items[0].size; s.collection=true;
    restorePlainObject(live, s);
    if (!persistNow()) { restorePlainObject(live, before); return res.status(503).json({ error:'write-error' }); }
    invalidateShareLogicalBytes(live.id); scheduleSearchReindex();
    res.json({ share:decorateShare(live,req) });
  });

  // Reorder a collection's items (drag & drop). `order` is a permutation
  // of the current indices. Only the display/listing order changes; the link's name
  // and URL are untouched.
  adminRouter.patch('/shares/:id/items/order', (req, res) => {
    const live = getById(req.params.id);
    if (!live || live.type !== 'file' || !Array.isArray(live.items) || live.items.length < 2) return res.status(404).json({ error: 'not-found' });
    const n=live.items.length;
    const order=Array.isArray(req.body&&req.body.order)?req.body.order.map((v)=>parseInt(v,10)):null;
    if(!order||order.length!==n||order.some((i)=>!Number.isInteger(i)||i<0||i>=n)||new Set(order).size!==n)return res.status(400).json({error:'bad-order'});
    const before=JSON.parse(JSON.stringify(live));
    live.items=order.map((i)=>live.items[i]);
    if(!persistNow()){restorePlainObject(live,before);return res.status(503).json({error:'write-error'});}
    auditReq(req,'items-reordered',live.name||live.id); res.json({share:decorateShare(live,req)});
  });

  // Indexed universal search. Queries no longer walk the filesystem;
  // they hit the persistent in-memory inverted index and are filtered by share ownership.
  adminRouter.get('/search/status', (req, res) => {
    const role = req.session && req.session.role;
    const globalView = role === 'owner' || role === 'admin' || role === 'auditor';
    const canAccess = (share) => universalSearchShareEligible(share) && ownsShare(req, share);
    res.json(universalSearchScopedStatus(canAccess, globalView));
  });
  adminRouter.post('/search/reindex', requireFullAdmin, (req, res) => {
    if (!live.searchIndexBuilding) buildUniversalSearchIndex().catch(() => {});
    auditReq(req, 'search-reindex', 'manual rebuild requested');
    res.status(202).json({ started: true, ...universalSearchStatus() });
  });
  adminRouter.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'query-too-short' });
    if (!live.universalSearchIndex.builtAt && !live.searchIndexBuilding) {
      try { await buildUniversalSearchIndex(); } catch (_) {}
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const requestedType = String(req.query.type || '').trim().toLowerCase();
    const type = ['file','folder','inbox','collab','photo'].includes(requestedType) ? requestedType : '';
    const semantic = /^(1|true|yes|on)$/i.test(String(req.query.semantic || ''));
    const requestedScope = String(req.query.scope || '').trim().toLowerCase();
    const scope = ['all','content','links','users','logs'].includes(requestedScope) ? requestedScope : (type ? 'content' : 'all');
    let contentResults = [], metadataResults = [];
    const warnings = [];
    if (scope === 'all' || scope === 'content') {
      try {
        contentResults = semantic
          ? universalSemanticSearchQuery(q, req, limit, { type }).map((r) => ({ ...r, scope:'content' }))
          : universalSearchQuery(q, req, limit, { type }).map((r) => ({ ...r, scope:'content' }));
      } catch (e) {
        warnings.push('content-index');
        console.error('[search] content query failed:', e && e.message);
      }
    }
    const metadataScopes = scope === 'all' ? ['links','users','logs'] : (scope === 'content' ? [] : [scope]);
    if (metadataScopes.length) {
      try {
        metadataResults = globalMetadataSearch(q, req, limit, { scopes:metadataScopes });
      } catch (e) {
        warnings.push('metadata');
        console.error('[search] metadata query failed:', e && e.message);
      }
    }
    // Rank all result families together. Exact/prefix filename hits receive the
    // strongest content scores, so an actionable exact filename is never buried
    // behind an approximate OCR/log metadata hit.
    const results = metadataResults.concat(contentResults).sort((a,b) =>
      Number(b.filenameMatchRank || 0) - Number(a.filenameMatchRank || 0)
      || Number(b.relevanceScore || b.semanticScore || 0) - Number(a.relevanceScore || a.semanticScore || 0)
      || String(a.file || a.shareName || '').localeCompare(String(b.file || b.shareName || ''))
    ).slice(0, limit);
    const visibleCount = (live.universalSearchIndex.docs || []).reduce((n, d) => {
      const share = getById(d.shareId);
      const typeOk = !type || String((share && share.type) || d.type || '').toLowerCase() === type;
      return n + (typeOk && universalSearchShareEligible(share) && ownsShare(req, share) ? 1 : 0);
    }, 0);
    res.json({ query:q, results, semantic, scope, scanned:visibleCount, indexed:visibleCount, builtAt:live.universalSearchIndex.builtAt || 0,
      building:live.searchIndexBuilding, truncated:results.length >= limit || !!live.universalSearchIndex.truncated, indexError:live.searchIndexError,
      degraded:warnings.length > 0, warnings });
  });

  // --- Nominative sub-links (recipients) -------------------------------------
  // One token per person for the same file/folder, so downloads are attributed
  // individually. Sub-tokens are independent random tokens (not derived from the
  // main token) and resolve to the parent share for all /s/ routes.
  adminRouter.post('/shares/:id/recipients', (req, res) => {
    const live=getById(req.params.id); if(!live||live.type==='inbox')return res.status(404).json({error:'not-found'});
    const s=JSON.parse(JSON.stringify(live)), b=req.body||{};
    let names=Array.isArray(b.names)?b.names:String(b.name||b.names||'').split(/[\n,]/);
    names=names.map((n)=>String(n||'').trim()).filter(Boolean).slice(0,50); if(!names.length)return res.status(400).json({error:'empty'});
    if(!Array.isArray(s.recipients))s.recipients=[];
    const seen=new Set(s.recipients.map((r)=>String(r.name||'').toLowerCase())),added=[];
    for(const name of names){if(name.length>100||seen.has(name.toLowerCase()))continue; s.recipients.push({token:newToken(),name,createdAt:Date.now(),stats:null});seen.add(name.toLowerCase());added.push(name);}
    if(!added.length)return res.status(409).json({error:'exists'});
    const before=JSON.parse(JSON.stringify(live)); restorePlainObject(live,s);
    if(!persistNow()){restorePlainObject(live,before);return res.status(503).json({error:'write-error'});} reindex();
    auditReq(req,'recipients-added',(live.name||live.id)+': '+added.join(', ')); res.status(201).json({share:decorateShare(live,req)});
  });

  adminRouter.delete('/shares/:id/recipients/:rtoken', (req, res) => {
    const live=getById(req.params.id); if(!live||!Array.isArray(live.recipients))return res.status(404).json({error:'not-found'});
    const i=live.recipients.findIndex((r)=>r.token===req.params.rtoken); if(i===-1)return res.status(404).json({error:'not-found'});
    const before=JSON.parse(JSON.stringify(live)), r=live.recipients[i]; live.recipients.splice(i,1);
    const undoEntry=recordUndoable(req,'recipient-removed',(live.name||live.id)+': '+(r.name||''),{kind:'share-assign',shareId:live.id,set:{recipients:before.recipients},expect:{recipients:JSON.parse(JSON.stringify(live.recipients))}});
    if(!persistNow()){restorePlainObject(live,before);rollbackRecordedUndo(undoEntry);return res.status(503).json({error:'write-error'});} reindex();
    auditReq(req,'recipient-removed',(live.name||live.id)+': '+(r.name||''));
    res.json({share:decorateShare(live,req)});
  });

  // Per-recipient overrides on a nominative sub-link: its own expiry
  // and/or download cap (on top of the parent share's limits).
  adminRouter.patch('/shares/:id/recipients/:rtoken', (req, res) => {
    const live=getById(req.params.id); if(!live||!Array.isArray(live.recipients))return res.status(404).json({error:'not-found'});
    const before=JSON.parse(JSON.stringify(live)); const r=live.recipients.find((x)=>x.token===req.params.rtoken); if(!r)return res.status(404).json({error:'not-found'});
    const b=req.body||{},changed=[];
    if(b.expiresInSeconds!==undefined){const next=parseExpiry(b.expiresInSeconds);if(next)r.expiresAt=next;else delete r.expiresAt;changed.push('expiry');}
    if(b.maxDownloads!==undefined){const n=Math.floor(Number(b.maxDownloads));if(Number.isFinite(n)&&n>0)r.maxDownloads=n;else delete r.maxDownloads;changed.push('maxDownloads');}
    if(!changed.length)return res.json({share:decorateShare(live,req)});
    if(!persistNow()){restorePlainObject(live,before);return res.status(503).json({error:'write-error'});} reindex();
    auditReq(req,'recipient-updated',(live.name||live.id)+': '+(r.name||'')+' ('+changed.join(', ')+')'); res.json({share:decorateShare(live,req)});
  });

  // Clear the message list of a reception link (the notes left by senders). The
  // uploaded files on disk and the received/quota counters are left untouched.
  adminRouter.delete('/shares/:id/messages', (req, res) => {
    const s = getById(req.params.id);
    if (!s || s.type !== 'inbox') return res.status(404).json({ error: 'not-found' });
    const previousMessages = Array.isArray(s.messages) ? JSON.parse(JSON.stringify(s.messages)) : [];
    const n = previousMessages.length;
    s.messages = [];
    if (!persistNow()) { s.messages = previousMessages; return res.status(503).json({ error:'write-error' }); } // messages are persisted synchronously; clearing must be durable too
    auditReq(req, 'inbox-messages-cleared', (s.name || s.id) + ': ' + n + ' message(s)');
    res.json({ share: decorateShare(s, req) });
  });

  // Creating a reception link (the visitor will be able to upload files).
  adminRouter.post('/inbox', async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim() || 'Reception';
    // Destination sub-folder (sanitized) under INBOX_DIR.
    let relDir = name
      .replace(/[^A-Za-z0-9 _.-]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 60);
    if (!relDir) relDir = 'reception';

    // Quotas & filters (all optional; 0 / empty = no limit).
    const nn = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
    const inbox = {
      type: 'inbox',
      name,
      relDir,
      startsAt: parseStartsAt(body.startsAt),
      expiresAt: resolveNewShareExpiry(body), // instance policy + absolute/relative expiry
      maxFiles: nn(body.maxFiles),
      maxFileBytes: nn(body.maxFileBytes),
      maxTotalBytes: nn(body.maxTotalBytes),
      allowExt: normExtList(body.allowExt),
      blockExt: normExtList(body.blockExt),
      groupBySender: !!body.groupBySender, // file uploads into <sender>/<date>/ subfolders
      tagBySender: !!body.tagBySender, // prefix stored filenames with the sender name
      rejectDuplicates: !!body.rejectDuplicates, // refuse a byte-for-byte duplicate
      requireSenderName: !!body.requireSenderName, // visitor must enter a name
      blockExecutables: !!body.blockExecutables, // reject sniffed executables
      maxFilesPerSender: nn(body.maxFilesPerSender), // per-sender file cap (0 = unlimited)
      maxBytesPerSender: nn(body.maxBytesPerSender), // per-sender byte cap (0 = unlimited)
      maxFilesPerUpload: nn(body.maxFilesPerUpload), // max files a visitor may queue in one deposit (0 = unlimited)
      moderated: !!body.moderated, // uploads wait for admin approval
      bytesReceived: 0,
    };
    // Instructions shown to visitors; falls back to the configured default banner.
    const note = (String(body.note || '').replace(/\r\n/g, '\n').trim()
      || String(getSettings().receptionBanner || '')).slice(0, 2000);
    if (note) inbox.note = note;
    // End-to-end encryption: the server only ever sees ciphertext, so filename-based
    // filters can't apply (names are encrypted) — drop them for encrypted links.
    if (body.encrypted) {
      inbox.encrypted = true;
      inbox.encMode = body.encMode === 'pass' ? 'pass' : 'key';
      inbox.allowExt = [];
      inbox.blockExt = [];
    }
    const password = String(body.password || '');
    // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
    // Same fixed-shape { pwHash } object as above — no client-controlled keys.
    if (password) { const protectedShare = await makeSharePassword(password); if (protectedShare.error) return sendPasswordWorkError(res, protectedShare.error); Object.assign(inbox, protectedShare); }
    applyAccessRules(inbox, body); // geo/IP rules
    stampOwner(inbox, req);
    const rec = addShareDurable(inbox, req);
    if (!rec) return res.status(503).json({ error:'write-error' });
    auditReq(req, 'inbox-created', (inbox.encrypted ? 'encrypted ' : '') + inbox.name);
    res.status(201).json({ share: decorateShare(rec, req) });
  });

  // Moderation queue. Approve moves a pending upload into the link's
  // target folder (counting it); reject deletes it. Pending metadata lives in
  // live.state.meta.pending; the files themselves under PENDING_DIR.
  adminRouter.post('/pending/:id/approve', async (req, res) => {
    const list = pendingModerationRows();
    const i = list.findIndex((p) => p && p.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not-found' });
    const p = list[i];
    const s = getById(p.shareId);
    if (!s) {
      let staged;
      try { staged = stagePendingFileRemoval(p.id, 'share-gone'); }
      catch (e) { console.error('[moderation] pending cleanup stage failed:', e.message); return res.status(500).json({ error:'delete-failed' }); }
      list.splice(i, 1);
      if (!persistNow()) {
        list.splice(Math.min(i, list.length), 0, p);
        staged.rollback();
        return res.status(503).json({ error:'write-error' });
      }
      staged.finalize();
      return res.status(404).json({ error: 'share-gone' });
    }
    if (!ownsShare(req, s)) return res.status(403).json({ error: 'forbidden' }); // operators: own links only
    if (!claimPendingModeration(p.id)) return res.status(409).json({ error: 'moderation-busy' });
    const beforeShare = JSON.parse(JSON.stringify(s));
    try {
      const outcome = await approvePendingModeration(s, p);
      if (outcome.error) {
        const status = outcome.error === 'inbox-dir' || outcome.error === 'write-error' ? 500 : inboxRejectStatus(outcome.error);
        return res.status(status).json({ error: outcome.error });
      }
      if (!persistNow()) {
        restorePlainObject(s, beforeShare);
        const liveList = pendingModerationRows();
        if (!liveList.some((row) => row && row.id === p.id)) liveList.splice(Math.min(i, liveList.length), 0, p);
        if (outcome.dest) deleteFileExpiryForPath(outcome.dest);
        try {
          const pendingPath = path.join(PENDING_DIR, String(p.id));
          if (outcome.dest && fs.existsSync(outcome.dest) && !fs.existsSync(pendingPath)) fs.renameSync(outcome.dest, pendingPath);
        } catch (e) { console.error('[moderation] approval file rollback failed:', e.message); }
        return res.status(503).json({ error: 'write-error' });
      }
      finalizePendingModerationApproval(s, p, outcome);
      auditReq(req, 'pending-approved', (s.name || s.id) + ': ' + p.name);
      addShareCenterNotification(s, 'received-file-ready', { name:p.name || s.name || '', bytes:Number(outcome.size)||0, sender:p.sender||null, ip:p.ip || null, url:'/app/#receptions', dedupeKey:`received-ready:pending:${p.id}` });
      res.json({ ok: true });
    } finally { releasePendingModeration(p.id); }
  });
  adminRouter.post('/pending/:id/reject', (req, res) => {
    const list = pendingModerationRows();
    const i = list.findIndex((p) => p && p.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'not-found' });
    const p = list[i];
    if (req.session.role === 'operator' && !ownsShare(req, getById(p.shareId))) return res.status(403).json({ error: 'forbidden' });
    if (!claimPendingModeration(p.id)) return res.status(409).json({ error: 'moderation-busy' });
    try {
      let staged;
      try { staged = stagePendingFileRemoval(p.id, 'reject'); }
      catch (e) { console.error('[moderation] pending reject stage failed:', e.message); return res.status(500).json({ error: 'delete-failed' }); }
      const liveIndex = list.findIndex((row) => row && row.id === p.id);
      if (liveIndex >= 0) list.splice(liveIndex, 1);
      if (!persistNow()) {
        if (!list.some((row) => row && row.id === p.id)) list.splice(Math.min(i, list.length), 0, p);
        staged.rollback();
        return res.status(503).json({ error: 'write-error' });
      }
      staged.finalize();
      auditReq(req, 'pending-rejected', (p.shareName || '') + ': ' + (p.name || ''));
      res.json({ ok: true });
    } finally { releasePendingModeration(p.id); }
  });

  // Creating a collaboration link: a two-way shared folder. Visitors can browse +
  // download AND upload; deletion by the visitor is opt-in (allowDelete). The folder
  // lives under INBOX_DIR with a unique suffix so links never share a directory.
  adminRouter.post('/collab', async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim() || 'Collaboration';
    const base = name.replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/^\.+/, '').trim().slice(0, 50) || 'collab';
    const relDir = base + '-' + crypto.randomBytes(3).toString('hex'); // unique per link
    const nn = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };
    const password = String(body.password || '');
    const collab = {
      type: 'collab',
      name,
      relDir,
      startsAt: parseStartsAt(body.startsAt),
      expiresAt: resolveNewShareExpiry(body), // instance policy + absolute/relative expiry
      // Visitor deletion is only allowed on a password-protected link (it lets an
      // unauthenticated visitor remove files) — mirrors the greyed-out UI checkbox.
      allowDelete: !!body.allowDelete && !!password,
      maxFiles: nn(body.maxFiles),
      maxFileBytes: nn(body.maxFileBytes),
      maxTotalBytes: nn(body.maxTotalBytes),
      allowExt: normExtList(body.allowExt),
      blockExt: normExtList(body.blockExt),
      tagBySender: !!body.tagBySender, // prefix stored filenames with the sender name
      rejectDuplicates: !!body.rejectDuplicates, // refuse a byte-for-byte duplicate
      blockExecutables: !!body.blockExecutables, // reject sniffed executables
      maxFilesPerSender: nn(body.maxFilesPerSender), // per-sender file cap (0 = unlimited)
      maxBytesPerSender: nn(body.maxBytesPerSender), // per-sender byte cap (0 = unlimited)
      maxFilesPerUpload: nn(body.maxFilesPerUpload), // max files a visitor may queue in one deposit (0 = unlimited)
      moderated: !!body.moderated, // uploads wait for admin approval
      bytesReceived: 0,
    };
    if (body.allowZip === false) collab.allowZip = false; // "download all as .zip" (default on)
    const note = (String(body.note || '').replace(/\r\n/g, '\n').trim()
      || String(getSettings().receptionBanner || '')).slice(0, 2000);
    if (note) collab.note = note;
    // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
    // Same fixed-shape { pwHash } object as elsewhere — no client-controlled keys.
    if (password) { const protectedShare = await makeSharePassword(password); if (protectedShare.error) return sendPasswordWorkError(res, protectedShare.error); Object.assign(collab, protectedShare); }
    applyAccessRules(collab, body); // geo/IP rules
    try { fs.mkdirSync(collabRoot(collab), { recursive: true }); } catch (_) {}
    stampOwner(collab, req);
    const rec = addShareDurable(collab, req);
    if (!rec) { try { fs.rmdirSync(collabRoot(collab)); } catch (_) {} return res.status(503).json({ error:'write-error' }); }
    auditReq(req, 'collab-created', collab.name + (collab.allowDelete ? ' (delete allowed)' : ''));
    res.status(201).json({ share: decorateShare(rec, req) });
  });

  // Create an end-to-end-encrypted download share. The request body is the opaque
  // ciphertext (a DXE1 container built by the admin's browser); the server never
  // sees the key or the plaintext. Metadata travels as query params. The body is
  // NOT JSON, so express.json() upstream ignores it and the stream reaches here.
  adminRouter.post('/enc-share', (req, res) => {
    const mode = req.query.mode === 'pass' ? 'pass' : 'key';
    const label = String(req.query.label || '').trim().slice(0, 200) || 'Encrypted file';
    const id = crypto.randomBytes(12).toString('hex');
    const dest = path.join(ENC_DIR, id + '.dxe');
    const ws = fs.createWriteStream(dest);
    let size = 0, failed = false;
    const fail = (code) => {
      if (failed) return;
      failed = true;
      try { ws.destroy(); } catch (_) {}
      fs.unlink(dest, () => {});
      if (!res.headersSent) res.status(code || 500).json({ error: 'write-error' });
    };
    const maxUp = effMaxUpload();
    req.on('data', (c) => {
      size += c.length;
      if (maxUp > 0 && size > maxUp) fail(413);
    });
    req.on('aborted', () => fail(400));
    req.on('error', () => fail(400));
    ws.on('error', () => fail(500));
    ws.on('finish', () => {
      if (failed) return;
      if (size === 0) return fail(400);
      const share = {
        type: 'file',
        name: label,
        size,
        encrypted: true,
        encMode: mode,
        encPath: dest,
        startsAt: parseStartsAt(req.query.startsAt),
        expiresAt: parseNewShareExpiry(req.query.expiresInSeconds),
        maxDownloads: parseMaxDownloads(req.query.maxDownloads),
      };
      stampOwner(share, req);
      const rec = addShareDurable(share, req);
      if (!rec) { try { fs.unlinkSync(dest); } catch (_) {} return res.status(503).json({ error:'write-error' }); }
      auditReq(req, 'enc-share-created', mode + ' ' + label);
      res.status(201).json({ share: decorateShare(rec, req) });
    });
    req.pipe(ws);
  });

  // Store a burn-after-read secret note. The body is the opaque DXE
  // ciphertext (built in the admin's browser); the server never sees the key or
  // the plaintext. Metadata travels as query params. Returns a one-time token.
  adminRouter.post('/secret', (req, res) => {
    const mode = req.query.mode === 'pass' ? 'pass' : 'key';
    const token = crypto.randomBytes(18).toString('base64url');
    const dest = path.join(SECRETS_DIR, token + '.dxe');
    const ws = fs.createWriteStream(dest, { mode: 0o600 });
    let size = 0, failed = false;
    const fail = (code) => {
      if (failed) return; failed = true;
      try { ws.destroy(); } catch (_) {}
      fs.unlink(dest, () => {});
      if (!res.headersSent) res.status(code || 500).json({ error: 'write-error' });
    };
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) fail(413); }); // secrets are small
    req.on('aborted', () => fail(400));
    req.on('error', () => fail(400));
    ws.on('error', () => fail(500));
    ws.on('finish', () => {
      if (failed) return;
      if (size === 0) return fail(400);
      if (!live.state.meta || typeof live.state.meta !== 'object') live.state.meta = {};
      if (!live.state.meta.secrets || typeof live.state.meta.secrets !== 'object') live.state.meta.secrets = {};
      live.state.meta.secrets[token] = {
        mode, size, createdAt: Date.now(),
        expiresAt: parseNewShareExpiry(req.query.expiresInSeconds),
      };
      if (!persistNow()) {
        delete live.state.meta.secrets[token];
        try { fs.unlinkSync(dest); } catch (_) {}
        return res.status(500).json({ error:'write-error' });
      }
      auditReq(req, 'secret-created', mode);
      const base = primaryBase(req);
      const rel = '/x/' + token;
      res.status(201).json({ token, path: rel, url: base ? base + rel : null, mode });
    });
    req.pipe(ws);
  });

  // QR code (SVG) for a link, generated locally (no third-party service).
  adminRouter.get('/qr', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 1024) return res.status(400).json({ error: 'invalid-data' });
    try {
      const svg = await QRCode.toString(data, { type: 'svg', margin: 1 });
      res.type('image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      // Defense in depth: the `qrcode` package renders `data` purely as QR
      // modules (<path>/<rect> geometry) and never echoes it back as text, so
      // there's no injection surface here — but block MIME-sniffing anyway in
      // case a browser is ever tricked into treating this as something else.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      res.send(svg);
    } catch (e) {
      res.status(500).json({ error: 'qr-failed' });
    }
  });
}

module.exports = { attachAdminShareCoreRoutes, attachAdminShareRoutes, normalizeTags };
