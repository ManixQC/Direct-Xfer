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

function buildImageComparison(days, current, previous) {
  if (!days || days <= 0) return { available: false, days: 0 };
  return {
    available: true,
    days,
    current,
    previous,
    changes: {
      images: dashboardDelta(current.images, previous.images),
      bytes: dashboardDelta(current.bytes, previous.bytes),
      avgSize: dashboardDelta(current.avgSize, previous.avgSize),
    },
  };
}

/**
 * Registers photo/image administration routes.
 *
 * Route modules receive domain services/helpers from server.js. Mutable persisted
 * state is resolved per request through getState(), so backup restore cannot leave
 * handlers bound to a stale state object.
 */
function attachAdminPhotoRoutes(deps = {}) {
  const {
    ASVS_L3_MODE = false,
    DAY_MS,
    FULL_IMAGES_DIR,
    HOST_ROOT,
    IMAGE_MAX_BYTES,
    IMAGE_MAX_PIXELS,
    IMAGE_STORE_DIR,
    MICROS_DIR,
    MICRO_MAX_BYTES,
    PWA_IMG_EXT,
    THUMBS_DIR,
    acquireManagedPhotoHashResponseLock,
    addPhotoEditHistory,
    addShareCenterNotification,
    addShareDurable,
    adminPhotoFullWrites,
    adminPhotoHasVariantWrite,
    adminRouter,
    analyzePhotoDuplicates,
    applyDlpSummary,
    archiveCurrentPhotoVersion,
    assertRealWithin,
    auditReq,
    bumpPhotoCacheRevision,
    canSeePhotoHistory,
    cleanPhotoEditOperations,
    cleanupPhotoVersionStorage,
    copyHostPhotoToStore,
    createZipArchive,
    crypto,
    csvField,
    decorateShare,
    diskFreeThresholds,
    dlpDecision,
    dlpScanResolvedItems,
    dlpScanStoredFile,
    duplicatePhotoPayload,
    estimateImageOptimization,
    findManagedPhotoDuplicateDeep,
    firstExistingPhotoFile,
    formatBytes,
    fs,
    getById,
    getSettings,
    getState,
    handleAdminPhotoVariantUpload,
    hashFileSha256,
    hostToContainer,
    imageContentType,
    imageDimensions,
    isActive,
    listShares,
    mergeDlpSummaries,
    ownsShare,
    parseNewShareExpiry,
    path,
    persistNow,
    photoAdaptivePath,
    photoCacheRevision,
    photoDashboardQueryOptions,
    photoDimensions,
    photoExt,
    photoHistoryMeta,
    photoHistoryPreviewPaths,
    photoMatchesDashboardFilters,
    photoMetadata,
    photoOriginalPaths,
    photoStatsOf,
    photoUploadDeviceName,
    photoVariantPaths,
    photoVersionDir,
    primaryBase,
    reqPathList,
    resolveHostItem,
    restorePhotoVersion,
    sanitizeImageMetadataFile,
    restorePlainObject,
    stagePhotoHistoryPreviewRemoval,
    stampOwner,
    stampPhotoUploadDevice,
    streamFile,
    streamToFileBounded,
    unlinkManagedPathsStrict,
    unlinkPhotoFiles,
    validSha256,
    visiblePhotoHistory,
  } = deps;

  if (!adminRouter || typeof adminRouter.get !== 'function') throw new TypeError('attachAdminPhotoRoutes requires adminRouter');
  if (typeof getState !== 'function') throw new TypeError('attachAdminPhotoRoutes requires getState()');
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

  async function enforceL3ImageMetadataPolicy(req, dest, ext, size, sha256) {
    if (ASVS_L3_MODE !== true) return { size, sha256, metadataRemoved: String(req.query.metadataRemoved || '') === '1' };
    if (typeof sanitizeImageMetadataFile !== 'function') {
      const error = new Error('metadata-sanitizer-unavailable');
      error.code = 'metadata-sanitizer-unavailable';
      throw error;
    }
    const consent = /^(1|true|yes|on)$/i.test(String(req.query.metadataConsent || ''));
    const result = await sanitizeImageMetadataFile(dest, ext);
    if (!result || result.supported !== true) {
      if (!consent) {
        const error = new Error('image-metadata-consent-required');
        error.code = 'image-metadata-consent-required';
        throw error;
      }
      return { size, sha256, metadataRemoved:false, metadataRetentionConsentAt:Date.now() };
    }
    const stat = await fs.promises.stat(dest);
    const finalSize = Number(stat.size) || 0;
    const finalSha256 = result.changed ? await hashFileSha256(dest) : sha256;
    return { size:finalSize, sha256:finalSha256, metadataRemoved:true, metadataRetentionConsentAt:null };
  }

  adminRouter.get('/photos/history', (req, res) => {
    const history = visiblePhotoHistory(req).map((record) => {
      const previewFile = record.preview ? firstExistingPhotoFile(photoHistoryPreviewPaths(record.id)) : null;
      const hasPreview = !!previewFile;
      // Backfill the retained-copy size for records archived before it was recorded.
      let previewSize = record.previewSize || 0;
      if (hasPreview && !previewSize) { try { previewSize = fs.statSync(previewFile).size; } catch (_) {} }
      return {
        id: record.id,
        name: record.name,
        ext: record.ext,
        size: record.size,
        createdAt: record.createdAt,
        revokedAt: record.revokedAt,
        ownerName: record.ownerName,
        metadataRemoved: !!record.metadataRemoved,
        fullViews: record.fullViews,
        fullVisitors: record.fullVisitors,
        thumbViews: record.thumbViews,
        thumbVisitors: record.thumbVisitors,
        microViews: record.microViews,
        microVisitors: record.microVisitors,
        previewSize: hasPreview ? previewSize : 0,
        previewUrl: hasPreview ? '/api/photos/history/' + record.id + '/preview' : null,
      };
    });
    res.json({ history, meta: photoHistoryMeta(req) });
  });
  
  adminRouter.get('/photos/history/:id/preview', (req, res) => {
    const record = (state.photoHistory || []).find((item) => item && item.id === req.params.id);
    if (!record || !canSeePhotoHistory(req, record) || !record.preview) return res.status(404).json({ error: 'not-found' });
    const previewPath = firstExistingPhotoFile(photoHistoryPreviewPaths(record.id));
    if (!previewPath) return res.status(404).json({ error: 'not-found' });
    streamFile(req, res, previewPath, record.name || 'preview.jpg', null, null, { inline: true, contentType: 'image/jpeg' });
  });
  
  adminRouter.delete('/photos/history/:id', (req, res) => {
    const items = Array.isArray(state.photoHistory) ? state.photoHistory : [];
    const index = items.findIndex((record) => record && record.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'not-found' });
    const record = items[index];
    if (!canSeePhotoHistory(req, record)) return res.status(403).json({ error: 'forbidden' });
    let staged;
    try { staged = stagePhotoHistoryPreviewRemoval([record]); }
    catch (_) { return res.status(500).json({ error:'delete-failed' }); }
    items.splice(index, 1);
    if (!persistNow()) {
      items.splice(Math.min(index, items.length), 0, record); staged.rollback();
      return res.status(503).json({ error:'write-error' });
    }
    staged.finalize();
    auditReq(req, 'photo-history-deleted', record.name || record.id);
    res.json({ ok: true, id: record.id, meta: photoHistoryMeta(req) });
  });
  
  adminRouter.delete('/photos/history', (req, res) => {
    const purgeAll = req.session.role === 'owner' || req.session.role === 'admin';
    const removed = [], kept = [];
    for (const record of (state.photoHistory || [])) {
      if (purgeAll || (record.ownerId && record.ownerId === req.session.accountId)) removed.push(record);
      else kept.push(record);
    }
    if (!removed.length) return res.json({ ok:true, count:0, meta:photoHistoryMeta(req) });
    let staged;
    try { staged = stagePhotoHistoryPreviewRemoval(removed); }
    catch (_) { return res.status(500).json({ error:'delete-failed' }); }
    const previous = state.photoHistory;
    state.photoHistory = kept;
    if (!persistNow()) { state.photoHistory = previous; staged.rollback(); return res.status(503).json({ error:'write-error' }); }
    staged.finalize();
    auditReq(req, 'photo-history-purged', String(removed.length));
    res.json({ ok: true, count: removed.length, meta: photoHistoryMeta(req) });
  });
  
  adminRouter.get('/photos/dashboard', async (req, res) => {
    const DAY_MS = 86400000;
    const now = Date.now();
    const filters = photoDashboardQueryOptions(req, now);
    const days = filters.days;
    const cutoff = filters.cutoff;
    const chartDays = days > 0 ? days : 365;
    const operatorScoped = req.session.role === 'operator';
    const fileSize = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
  
    const allPhotos = listShares().filter((s) => s.type === 'photo' && (!operatorScoped || ownsShare(req, s)));
    const cohortFilters = { ...filters, cutoff: 0 };
    const filteredAllPhotos = allPhotos.filter((s) => photoMatchesDashboardFilters(s, cohortFilters, now));
    const photos = filteredAllPhotos.filter((s) => !cutoff || (s.createdAt || 0) >= cutoff);
    const history = visiblePhotoHistory(req).filter((r) => {
      if (filters.cutoff && (r.createdAt || 0) < filters.cutoff) return false;
      if (filters.format && String(r.ext || '').toLowerCase() !== filters.format) return false;
      if (filters.q && ![r.name, r.ext].filter(Boolean).join(' ').toLowerCase().includes(filters.q)) return false;
      return true;
    });
    const activePhotos = photos.filter((s) => isActive(s, now));
    const expiredPhotos = photos.filter((s) => !s.revoked && !!s.expiresAt && now > s.expiresAt);
    const otherInactivePhotos = photos.filter((s) => !isActive(s, now) && !expiredPhotos.includes(s));
    const imageBase = getSettings().imageBase || primaryBase(req) || '';
    const publicPhotoUrl = (s) => (imageBase ? imageBase : '') + '/i/' + s.token + '.' + photoExt(s);
    const previewPhotoUrl = (s) => '/i/' + s.token + (s.micro ? '/micro' : s.thumb ? '/thumb' : '.' + photoExt(s));
  
    // Pre-seed the "images added" chart buckets (oldest → newest).
    const dayKey = (ts) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const created = [];
    const dayIndex = new Map();
    for (let i = chartDays - 1; i >= 0; i--) {
      const bucket = { day: dayKey(now - i * DAY_MS), count: 0 };
      dayIndex.set(bucket.day, bucket);
      created.push(bucket);
    }
  
    const variantViews = { full: 0, thumb: 0, micro: 0 };
    const storageByVariant = { full: 0, mini: 0, micro: 0 };
    const storageByFormatMap = new Map();
    const storageLifecycle = { active: 0, expired: 0, inactive: 0, reclaimable: 0 };
    const visitorSet = new Set(); // global unique masked IPs across every variant
    const userMap = new Map();
    let withMini = 0, withMicro = 0, addedInPeriod = 0, totalViews = 0;
    const imgRows = [];
  
    for (const s of photos) {
      const ps = photoStatsOf(s);
      const views = (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0);
      variantViews.full += ps.full.v || 0;
      variantViews.thumb += ps.thumb.v || 0;
      variantViews.micro += ps.micro.v || 0;
      totalViews += views;
      const uniq = new Set();
      for (const arr of [ps.full.u, ps.thumb.u, ps.micro.u]) {
        if (Array.isArray(arr)) for (const ip of arr) { uniq.add(ip); visitorSet.add(ip); }
      }
      if (s.thumb) withMini += 1;
      if (s.micro) withMicro += 1;
      if ((s.createdAt || 0) >= cutoff) addedInPeriod += 1;
      // Storage: the managed Full copy (share.size) plus the generated variant files.
      const fullBytes = Math.max(0, Number(s.size) || 0);
      const miniBytes = s.thumb ? fileSize(path.join(THUMBS_DIR, s.token + '.jpg')) : 0;
      const microBytes = s.micro ? fileSize(path.join(MICROS_DIR, s.token + '.jpg')) : 0;
      const managedBytes = fullBytes + miniBytes + microBytes;
      storageByVariant.full += fullBytes;
      storageByVariant.mini += miniBytes;
      storageByVariant.micro += microBytes;
      const ext = photoExt(s);
      const fmt = storageByFormatMap.get(ext) || { format: ext, bytes: 0, count: 0 };
      fmt.bytes += managedBytes; fmt.count += 1; storageByFormatMap.set(ext, fmt);
      const expired = !s.revoked && !!s.expiresAt && now > s.expiresAt;
      if (isActive(s, now)) storageLifecycle.active += managedBytes;
      else if (expired) { storageLifecycle.expired += managedBytes; storageLifecycle.reclaimable += managedBytes; }
      else { storageLifecycle.inactive += managedBytes; storageLifecycle.reclaimable += managedBytes; }
      const bucket = dayIndex.get(dayKey(s.createdAt || now));
      if (bucket) { bucket.count += 1; bucket.bytes = (bucket.bytes || 0) + managedBytes; }
      const ownerName = s.ownerName || '—';
      let owner = userMap.get(ownerName);
      if (!owner) { owner = { user: ownerName, images: 0, active: 0, expired: 0, inactive: 0, bytes: 0, views: 0, visitorSet: new Set() }; userMap.set(ownerName, owner); }
      owner.images += 1; owner.bytes += managedBytes; owner.views += views;
      if (isActive(s, now)) owner.active += 1; else if (expired) owner.expired += 1; else owner.inactive += 1;
      for (const ip of uniq) owner.visitorSet.add(ip);
      imgRows.push({
        name: s.name, token: s.token, ext, fullSize: fullBytes, size: managedBytes, views, visitors: uniq.size,
        ownerName, createdAt: s.createdAt || 0, active: isActive(s, now), expired, expiresAt: s.expiresAt || null,
        url: publicPhotoUrl(s), previewUrl: previewPhotoUrl(s),
      });
    }
    // Revoked images were "added" too — count them in the timeline.
    for (const r of history) {
      const bucket = dayIndex.get(dayKey(r.createdAt || 0));
      if (bucket) { bucket.count += 1; bucket.bytes = (bucket.bytes || 0) + Math.max(0, Number(r.size) || 0) + Math.max(0, Number(r.previewSize) || 0); }
    }
    let cumulativeBytes = 0;
    created.forEach((bucket) => { cumulativeBytes += bucket.bytes || 0; bucket.cumulativeBytes = cumulativeBytes; });
  
    const byViews = (a, b) => b.views - a.views;
    const topImages = imgRows.slice().sort(byViews).slice(0, 8);
    const topVisitors = imgRows.slice().filter((r) => r.visitors > 0).sort((a, b) => b.visitors - a.visitors).slice(0, 6);
    const storageByFormat = [...storageByFormatMap.values()].sort((a, b) => b.bytes - a.bytes);
    const largestImages = imgRows.slice().sort((a, b) => b.size - a.size).slice(0, 10);
    const linkRow = (s) => {
      const ps = photoStatsOf(s);
      const uniq = new Set();
      for (const arr of [ps.full.u, ps.thumb.u, ps.micro.u]) if (Array.isArray(arr)) for (const ip of arr) uniq.add(ip);
      return {
        name: s.name, token: s.token, createdAt: s.createdAt || 0, expiresAt: s.expiresAt || null,
        views: (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0), visitors: uniq.size,
        url: publicPhotoUrl(s), previewUrl: previewPhotoUrl(s),
      };
    };
    const activeLinks = activePhotos.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8).map(linkRow);
    const expiredLinks = expiredPhotos.slice().sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0)).slice(0, 8).map(linkRow);
  
    const expiringSoon = activePhotos
      .filter((s) => s.expiresAt && s.expiresAt > now && s.expiresAt - now <= 7 * DAY_MS && isActive(s))
      .sort((a, b) => a.expiresAt - b.expiresAt).slice(0, 8)
      .map((s) => ({ name: s.name, token: s.token, expiresAt: s.expiresAt }));
  
    const recentRevoked = history.slice()
      .sort((a, b) => (b.revokedAt || 0) - (a.revokedAt || 0)).slice(0, 6)
      .map((r) => ({
        name: r.name, revokedAt: r.revokedAt,
        views: (r.fullViews || 0) + (r.thumbViews || 0) + (r.microViews || 0),
        visitors: Math.max(r.fullVisitors || 0, r.thumbVisitors || 0, r.microVisitors || 0),
      }));
  
  
    const periodMs = days > 0 ? days * DAY_MS : 0;
    const previousStart = periodMs ? cutoff - periodMs : 0;
    const cohortMetrics = (items) => {
      const bytes = items.reduce((sum, s) => {
        const size = Number(s && s.size);
        return sum + (Number.isFinite(size) && size > 0 ? size : 0);
      }, 0);
      return { images: items.length, bytes, avgSize: items.length ? Math.round(bytes / items.length) : 0 };
    };
    const currentCohort = periodMs ? filteredAllPhotos.filter((s) => (s.createdAt || 0) >= cutoff) : photos;
    const previousCohort = periodMs ? filteredAllPhotos.filter((s) => (s.createdAt || 0) >= previousStart && (s.createdAt || 0) < cutoff) : [];
    const comparison = buildImageComparison(days, cohortMetrics(currentCohort), cohortMetrics(previousCohort));
    const users = [...userMap.values()].map((u) => ({
      user: u.user, images: u.images, active: u.active, expired: u.expired, inactive: u.inactive,
      bytes: u.bytes, views: u.views, visitors: u.visitorSet.size,
    })).sort((a, b) => b.bytes - a.bytes || b.views - a.views).slice(0, 12);
    const duplicates = await analyzePhotoDuplicates(photos, publicPhotoUrl, previewPhotoUrl);
    const optimization = estimateImageOptimization(imgRows);
  
    // Disk space of the Images volume (full admins only, like the main dashboard).
    let storage = null;
    try {
      if (!operatorScoped && typeof fs.statfsSync === 'function') {
        const st = fs.statfsSync(IMAGE_STORE_DIR);
        const total = st.blocks * st.bsize;
        const free = st.bavail * st.bsize;
        storage = { total, free, used: Math.max(0, total - free), path: IMAGE_STORE_DIR };
      }
    } catch (_) { storage = null; }
  
  
    const alerts = [];
    if (storage && storage.total > 0) {
      const usedPct = Math.round((storage.used / storage.total) * 100);
      const freePct = Math.max(0, 100 - usedPct), diskLimits = diskFreeThresholds();
      if (diskLimits.warn > 0 && freePct <= diskLimits.critical) alerts.push({ level: 'critical', code: 'image-disk-critical', params: { pct: usedPct, free: formatBytes(storage.free) } });
      else if (diskLimits.warn > 0 && freePct <= diskLimits.warn) alerts.push({ level: 'warning', code: 'image-disk-warning', params: { pct: usedPct, free: formatBytes(storage.free) } });
    }
    if (duplicates.groupCount > 0) alerts.push({
      level: duplicates.reclaimableBytes >= 100 * 1024 * 1024 ? 'warning' : 'info',
      code: 'duplicates', params: { n: duplicates.duplicateFiles, groups: duplicates.groupCount, space: formatBytes(duplicates.reclaimableBytes) },
    });
    const bestSavings = Math.max(optimization.webp.estimatedSavings || 0, optimization.avif.estimatedSavings || 0);
    if (bestSavings >= 25 * 1024 * 1024) alerts.push({ level: 'info', code: 'optimization', params: { space: formatBytes(bestSavings) } });
    if (storageLifecycle.reclaimable >= 250 * 1024 * 1024) alerts.push({ level: 'warning', code: 'image-reclaimable', params: { space: formatBytes(storageLifecycle.reclaimable) } });
    if (comparison.available && comparison.previous.bytes > 0 && comparison.current.bytes > comparison.previous.bytes * 2 && comparison.current.bytes - comparison.previous.bytes >= 100 * 1024 * 1024) {
      alerts.push({ level: 'warning', code: 'image-growth', params: { pct: comparison.changes.bytes.pct == null ? '—' : comparison.changes.bytes.pct } });
    }
  
    res.json({
      period: days,
      totals: {
        images: photos.length,
        active: activePhotos.length,
        expired: expiredPhotos.length,
        inactive: otherInactivePhotos.length,
        revoked: history.length,
        views: totalViews,
        fullViews: variantViews.full, thumbViews: variantViews.thumb, microViews: variantViews.micro,
        visitors: visitorSet.size,
        withMini, withMicro, addedInPeriod,
        storageBytes: storageByVariant.full + storageByVariant.mini + storageByVariant.micro,
      },
      variantViews,
      activeVsRevoked: { active: activePhotos.length, revoked: history.length },
      linkStatus: { active: activePhotos.length, expired: expiredPhotos.length, inactive: otherInactivePhotos.length },
      filters: { status: filters.status, format: filters.format, q: filters.q },
      storageByVariant: operatorScoped ? null : storageByVariant,
      storageAnalysis: operatorScoped ? null : { byFormat: storageByFormat, largestImages, lifecycle: storageLifecycle },
      comparison, users, duplicates, optimization, alerts,
      created, topImages, topVisitors, activeLinks, expiredLinks, expiringSoon, recentRevoked,
      storage, generatedAt: now,
    });
  });
  
  adminRouter.get('/photos/dashboard/export.csv', (req, res) => {
    const now = Date.now();
    const filters = photoDashboardQueryOptions(req, now);
    const operatorScoped = req.session.role === 'operator';
    const photos = listShares().filter((s) => s.type === 'photo' && (!operatorScoped || ownsShare(req, s)))
      .filter((s) => photoMatchesDashboardFilters(s, filters, now));
    const imageBase = getSettings().imageBase || primaryBase(req) || '';
    const rows = photos.map((s) => {
      const ps = photoStatsOf(s);
      const uniq = new Set();
      for (const arr of [ps.full.u, ps.thumb.u, ps.micro.u]) if (Array.isArray(arr)) for (const ip of arr) uniq.add(ip);
      const expired = !s.revoked && !!s.expiresAt && now > s.expiresAt;
      const status = isActive(s, now) ? 'active' : expired ? 'expired' : 'inactive';
      return {
        name: s.name, token: s.token, format: photoExt(s), status, createdAt: s.createdAt || 0, expiresAt: s.expiresAt || 0,
        bytes: Math.max(0, Number(s.size) || 0), views: (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0),
        visitors: uniq.size, mini: !!s.thumb, micro: !!s.micro,
        url: (imageBase ? imageBase : '') + '/i/' + s.token + '.' + photoExt(s),
      };
    });
    const cols = ['name', 'token', 'format', 'status', 'createdAt', 'expiresAt', 'bytes', 'views', 'visitors', 'mini', 'micro', 'url'];
    const out = [cols.join(',')];
    for (const r of rows) out.push([
      r.name, r.token, r.format, r.status, new Date(r.createdAt || 0).toISOString(), r.expiresAt ? new Date(r.expiresAt).toISOString() : '',
      r.bytes, r.views, r.visitors, r.mini ? '1' : '0', r.micro ? '1' : '0', r.url,
    ].map(csvField).join(','));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="direct-xfer-images-dashboard-${stamp}.csv"`);
    res.send('\uFEFF' + out.join('\r\n'));
  });
  
  adminRouter.post('/photos', async (req, res) => {
    const body = req.body || {};
    const paths = reqPathList(body);
    if (!paths.length) return res.status(400).json({ error: 'missing-path' });
    const created = [], errors = [], items = [];
    for (const p of paths) {
      let item;
      try { item = await resolveHostItem(p); } catch (e) { errors.push({ path:p, error:e.code || 'invalid-path' }); continue; }
      if (item.type !== 'file' || !imageContentType(item.name)) { errors.push({ path:p, error:'not-image' }); continue; }
      items.push({ path:p, item });
    }
    if (!items.length) return res.status(400).json({ error:(errors[0] && errors[0].error) || 'no-images', errors });
    // DLP always runs before duplicate detection. A duplicate response must never
    // become a side channel that skips the configured security reaction/logging.
    let dlpScan = null;
    if (getSettings().dlpEnabled !== false) {
      // Scan photos independently so a sensitive image does not incorrectly put the
      // same DLP badge/count on every safe image in the selected batch. Keep the
      // configured batch file cap for the aggregate policy decision.
      const cap = Math.max(1, Number(getSettings().dlpMaxFiles) || 100);
      const scans = [];
      for (let i = 0; i < items.length && i < cap; i++) {
        const one = await dlpScanResolvedItems([items[i].item]);
        items[i].dlpScan = one; scans.push(one);
      }
      dlpScan = mergeDlpSummaries(scans, Math.max(0, items.length - cap));
      if (dlpDecision(req, res, body, dlpScan, 'photos-create')) return;
    }
  
    // Hash the source before copying it into managed storage. This both prevents a
    // needless second stored copy and seeds hashes for future duplicate checks.
    // Acquire every content-hash lock in sorted order before checking existing
    // photos. The deterministic order avoids deadlocks when two batch requests
    // contain the same hashes in a different file order, while holding the locks
    // through the durable create window closes the concurrent-import race.
    for (const entry of items) {
      try {
        const abs = hostToContainer(entry.item.hostPath); await assertRealWithin(HOST_ROOT, abs);
        entry.sha256 = await hashFileSha256(abs);
      } catch (e) { if (e && e.code === 'outside-root') return res.status(400).json({ error:'invalid-path' }); }
    }
    const duplicateOverride = body.duplicateOverride === true || /^(1|true|yes|on)$/i.test(String(body.duplicateOverride || ''));
    const uniqueHashes = Array.from(new Set(items.map((entry) => String(entry.sha256 || '').toLowerCase()).filter(validSha256))).sort();
    for (const sha256 of uniqueHashes) {
      const hashLock = await acquireManagedPhotoHashResponseLock(res, sha256);
      if (!hashLock) return;
    }
    const seenBatchHashes = new Map();
    for (const entry of items) {
      const batchDuplicate = seenBatchHashes.get(String(entry.sha256 || '').toLowerCase()) || null;
      if (batchDuplicate && !duplicateOverride) {
        return res.status(409).json({ error:'duplicate-content', duplicate:null, sha256:entry.sha256, name:entry.item.name, duplicateName:batchDuplicate.item.name });
      }
      const duplicate = await findManagedPhotoDuplicateDeep(req, entry.sha256, entry.item.size, { pwa:false });
      if (duplicate && !duplicateOverride) return res.status(409).json({ error:'duplicate-content', duplicate:duplicatePhotoPayload(duplicate,req,false), sha256:entry.sha256, name:entry.item.name });
      seenBatchHashes.set(String(entry.sha256 || '').toLowerCase(), entry);
    }
    for (const entry of items) {
      const p = entry.path, item = entry.item;
      let imgPath;
      try { imgPath = await copyHostPhotoToStore(item); }
      catch (_) { errors.push({ path:p, error:'image-copy-failed' }); continue; }
      const share = { type:'photo', hostPath:item.hostPath, imgPath, name:item.name, size:item.size, contentSha256:entry.sha256 || null, expiresAt:parseNewShareExpiry(body.expiresInSeconds) };
      applyDlpSummary(share, entry.dlpScan || null);
      stampPhotoUploadDevice(share, req, 'host'); stampOwner(share, req);
      try {
        const rec = addShareDurable(share, req);
        if (!rec) { unlinkPhotoFiles([path.join(FULL_IMAGES_DIR, imgPath)]); errors.push({ path:p, error:'write-error' }); continue; }
        created.push(decorateShare(rec, req));
      } catch (_) { unlinkPhotoFiles([path.join(FULL_IMAGES_DIR, imgPath)]); errors.push({ path:p, error:'image-copy-failed' }); }
    }
    if (!created.length) return res.status(400).json({ error:(errors[0] && errors[0].error) || 'no-images', errors });
    auditReq(req, 'photos-created', created.length + ' image(s)');
    res.status(201).json({ created, errors, dlp:dlpScan });
  });
  
  adminRouter.post('/photos/:id/thumb', (req, res) => {
    const s=getById(req.params.id);
    if(!s||s.type!=='photo'||!ownsShare(req,s)){req.resume();return res.status(404).json({error:'not-found'});}
    return handleAdminPhotoVariantUpload(req,res,s,'thumb',1024*1024);
  });
  
  adminRouter.post('/photos/:id/micro', (req, res) => {
    const s=getById(req.params.id);
    if(!s||s.type!=='photo'||!ownsShare(req,s)){req.resume();return res.status(404).json({error:'not-found'});}
    return handleAdminPhotoVariantUpload(req,res,s,'micro',MICRO_MAX_BYTES);
  });
  
  adminRouter.get('/photos/:id/preview', (req,res) => {
    const photo=getById(req.params.id); if(!photo||photo.type!=='photo'||!ownsShare(req,photo))return res.status(404).end();
    const file=firstExistingPhotoFile(photoOriginalPaths(photo)); if(!file)return res.status(404).end();
    return streamFile(req,res,file,photo.name||('image.'+photoExt(photo)),null,null,{inline:true,cacheControl:'no-store'});
  });
  
  adminRouter.get('/photos/:id/versions', (req, res) => {
    const photo=getById(req.params.id); if(!photo||photo.type!=='photo'||!ownsShare(req,photo))return res.status(404).json({error:'not-found'});
    res.setHeader('Cache-Control','no-store');
    res.json({ current:{name:photo.name,size:photo.size||0,w:photo.w||null,h:photo.h||null,revision:photoCacheRevision(photo)}, versions:(photo.versions||[]).map((v)=>({id:v.id,at:v.at,name:v.name,size:v.size,w:v.w,h:v.h,metadataRemoved:!!v.metadataRemoved,original:!!v.original,reason:v.reason||'edit',operations:Array.isArray(v.operations)?v.operations:[]})), history:Array.isArray(photo.editHistory)?photo.editHistory.slice(0,50):[] });
  });
  
  adminRouter.get('/photos/:id/versions/:versionId/preview', (req,res) => {
    const photo=getById(req.params.id); if(!photo||photo.type!=='photo'||!ownsShare(req,photo))return res.status(404).end();
    const version=(photo.versions||[]).find((v)=>v.id===req.params.versionId); if(!version)return res.status(404).end();
    const file=firstExistingPhotoFile([path.join(photoVersionDir(photo.token),version.id,'full.'+version.ext)]); if(!file)return res.status(404).end();
    return streamFile(req,res,file,version.name||('version.'+version.ext),null,null,{inline:true,cacheControl:'no-store'});
  });
  
  adminRouter.post('/photos/:id/restore/:versionId', async (req,res) => {
    const photo=getById(req.params.id); if(!photo||photo.type!=='photo'||!ownsShare(req,photo))return res.status(404).json({error:'not-found'});
    const mutationKey=String(photo.id);
    if(adminPhotoFullWrites.has(mutationKey)||adminPhotoHasVariantWrite(mutationKey))return res.status(409).json({error:'image-busy'});
    adminPhotoFullWrites.add(mutationKey); let mutationReleased=false; const releaseMutation=()=>{if(!mutationReleased){mutationReleased=true;adminPhotoFullWrites.delete(mutationKey);}}; res.once('finish',releaseMutation);res.once('close',releaseMutation);
    const version=(photo.versions||[]).find((v)=>v.id===req.params.versionId); if(!version)return res.status(404).json({error:'version-not-found'});
    let tx; try{tx=restorePhotoVersion(photo,version);}catch(_){return res.status(500).json({error:'archive-failed'});} if(!tx)return res.status(404).json({error:'version-not-found'});
    if(!persistNow()){restorePlainObject(photo,tx.before);if(tx.archivedVersion){try{fs.rmSync(path.join(photoVersionDir(photo.token),tx.archivedVersion.id),{recursive:true,force:true});}catch(_){}}try{fs.unlinkSync(tx.newDest);}catch(_){}return res.status(503).json({error:'write-error'});}
    cleanupPhotoVersionStorage(photo);
    try{await unlinkManagedPathsStrict(tx.oldManagedPaths);}catch(e){console.error('[photo-restore] cleanup failed:',e&&e.message);}
    auditReq(req,'image-version-restored',(photo.name||photo.id)+' · '+version.id); res.json({ok:true,share:decorateShare(photo,req)});
  });
  
  adminRouter.post('/photos/:id/replace', (req, res) => {
    const s = getById(req.params.id);
    if (!s || s.type !== 'photo' || !ownsShare(req, s)) { req.resume(); return res.status(404).json({ error: 'not-found' }); }
    if (s.encrypted) { req.resume(); return res.status(400).json({ error: 'encrypted' }); }
    const mutationKey = String(s.id);
    if (adminPhotoFullWrites.has(mutationKey) || adminPhotoHasVariantWrite(mutationKey)) { req.resume(); return res.status(409).json({ error:'image-busy' }); }
    adminPhotoFullWrites.add(mutationKey);
    let mutationReleased = false;
    const releaseMutation = () => { if (!mutationReleased) { mutationReleased = true; adminPhotoFullWrites.delete(mutationKey); } };
    res.once('finish', releaseMutation);
    res.once('close', releaseMutation);
    let ext = (String(req.query.name || s.name || 'image.jpg').split('.').pop() || '').toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!PWA_IMG_EXT.test(ext)) { req.resume(); return res.status(400).json({ error: 'not-image' }); }
    const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
    const dest = path.join(FULL_IMAGES_DIR, fname);
    streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size, sha256) => {
      // ASVS V5.2.6: reject pixel-flood images (small file, enormous decoded pixel area).
      const dxPix = imageDimensions(dest); if (dxPix && dxPix.w * dxPix.h > IMAGE_MAX_PIXELS) { fs.unlink(dest, () => {}); return res.status(413).json({ error:'image-too-many-pixels', maxPixels: IMAGE_MAX_PIXELS }); }
      (async () => {
        let metadata;
        try { metadata = await enforceL3ImageMetadataPolicy(req, dest, ext, size, sha256); }
        catch (error) {
          fs.unlink(dest, () => {});
          if (error && error.code === 'image-metadata-consent-required') return res.status(422).json({ error:error.code, consentParameter:'metadataConsent' });
          return res.status(422).json({ error:(error && error.code) || 'image-metadata-sanitization-failed' });
        }
        const finalSize = metadata.size;
        const finalSha256 = metadata.sha256;
        let scan = null;
        if (getSettings().dlpEnabled !== false) {
          scan = await dlpScanStoredFile(dest, s.name);
          const dlpBody = { dlpOverride:/^(1|true|yes|on)$/i.test(String(req.query.dlpOverride || '')) };
          if (dlpDecision(req, res, dlpBody, scan, 'photo-edit', { file:dest, name:s.name })) { fs.unlink(dest, () => {}); return; }
        }
        const hashLock = await acquireManagedPhotoHashResponseLock(res, finalSha256); if (!hashLock) { fs.unlink(dest, () => {}); return; }
        const duplicate = await findManagedPhotoDuplicateDeep(req, finalSha256, finalSize, { pwa:false, excludeId:s.id });
        if (duplicate && !/^(1|true|yes|on)$/i.test(String(req.query.duplicateOverride || ''))) { fs.unlink(dest, () => {}); return res.status(409).json({ error:'duplicate-content', duplicate:duplicatePhotoPayload(duplicate,req,false), sha256:finalSha256 }); }
        const before = JSON.parse(JSON.stringify(s));
        const oldManagedPaths = [...photoOriginalPaths(s), ...photoVariantPaths(s.token, 'thumb'), ...photoVariantPaths(s.token, 'micro'), photoAdaptivePath(s.token, 'webp'), photoAdaptivePath(s.token, 'avif')];
        const editOperations = cleanPhotoEditOperations(req.query.ops);
        let archivedVersion = null;
        try { archivedVersion = archiveCurrentPhotoVersion(s, { reason:'edit', operations:editOperations }); } catch (e) { fs.unlink(dest, () => {}); return res.status(500).json({ error: 'archive-failed' }); }
        s.imgPath = fname; s.ext = ext; s.size = finalSize; s.contentSha256 = finalSha256;
        if (metadata.metadataRemoved) s.metadataRemoved = true; else delete s.metadataRemoved; if (metadata.metadataRetentionConsentAt) s.metadataRetentionConsentAt = metadata.metadataRetentionConsentAt; else delete s.metadataRetentionConsentAt;
        const dims = imageDimensions(dest); if (dims && dims.w > 0 && dims.h > 0) { s.w = dims.w; s.h = dims.h; }
        delete s.thumb; delete s.micro; delete s.adaptiveWebp; delete s.adaptiveAvif; delete s.thumbSize; delete s.microSize; delete s.thumbW; delete s.thumbH; delete s.microW; delete s.microH; delete s.thumbMetaMtimeMs; delete s.microMetaMtimeMs;
        s.editedAt = Date.now();
        bumpPhotoCacheRevision(s);
        addPhotoEditHistory(s, 'edit', editOperations.length ? editOperations : ['replace'], { from:{w:before.w||null,h:before.h||null,size:before.size||0}, to:{w:s.w||null,h:s.h||null,size:s.size||0} });
        applyDlpSummary(s, scan);
        if (!persistNow()) {
          for (const key of Object.keys(s)) delete s[key]; Object.assign(s, before);
          if (archivedVersion) { try { fs.rmSync(path.join(photoVersionDir(s.token), archivedVersion.id), { recursive:true, force:true }); } catch (_) {} }
          try { fs.unlinkSync(dest); } catch (_) {}
          return res.status(503).json({ error:'write-error' });
        }
        cleanupPhotoVersionStorage(s);
        try { await unlinkManagedPathsStrict(oldManagedPaths); } catch (e) { console.error('[photo-edit] old file cleanup failed:', e && e.message); }
        addShareCenterNotification(s,'image-full-replaced',{name:s.name,bytes:finalSize,dedupeKey:`image-replaced:${s.id}:${s.editedAt}`});
        auditReq(req, 'photo-edited', s.name);
        res.status(200).json({ share: decorateShare(s, req), dlp: scan });
      })().catch(() => { fs.unlink(dest, () => {}); if (!res.headersSent) res.status(500).json({ error: 'edit-failed' }); else res.destroy(); });
    });
  });
  
  adminRouter.post('/photos/source', async (req, res) => {
    const requested = String((req.body && req.body.path) || '').trim();
    if (!requested) return res.status(400).json({ error: 'missing-path' });
    let item;
    try { item = await resolveHostItem(requested); }
    catch (e) { return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' }); }
    const contentType = item.type === 'file' ? imageContentType(item.name) : null;
    if (!contentType) return res.status(415).json({ error: 'not-image' });
    if (!Number.isFinite(item.size) || item.size <= 0) return res.status(400).json({ error: 'empty-image' });
    if (item.size > IMAGE_MAX_BYTES) return res.status(413).json({ error: 'image-too-large', maxBytes: IMAGE_MAX_BYTES });
  
    let source;
    try {
      source = hostToContainer(item.hostPath);
      await assertRealWithin(HOST_ROOT, source);
    } catch (_) { return res.status(400).json({ error: 'invalid-path' }); }
  
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(item.size));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Direct-Xfer-Filename', encodeURIComponent(item.name || 'image'));
    const stream = fs.createReadStream(source);
    stream.on('error', (error) => {
      if (!res.headersSent) res.status(500).json({ error: 'image-read-failed' });
      else res.destroy(error);
    });
    stream.pipe(res);
  });
  
  adminRouter.post('/photos/upload', (req, res) => {
    let ext = (String(req.query.name || 'image.jpg').split('.').pop() || '').toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!PWA_IMG_EXT.test(ext)) return res.status(400).json({ error:'not-image' });
    const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
    const dest = path.join(FULL_IMAGES_DIR, fname);
    streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size, sha256) => {
      // ASVS V5.2.6: reject pixel-flood images (small file, enormous decoded pixel area).
      const dxPix = imageDimensions(dest); if (dxPix && dxPix.w * dxPix.h > IMAGE_MAX_PIXELS) { fs.unlink(dest, () => {}); return res.status(413).json({ error:'image-too-many-pixels', maxPixels: IMAGE_MAX_PIXELS }); }
      (async () => {
        let metadata;
        try { metadata = await enforceL3ImageMetadataPolicy(req, dest, ext, size, sha256); }
        catch (error) {
          fs.unlink(dest, () => {});
          if (error && error.code === 'image-metadata-consent-required') return res.status(422).json({ error:error.code, consentParameter:'metadataConsent' });
          return res.status(422).json({ error:(error && error.code) || 'image-metadata-sanitization-failed' });
        }
        const finalSize = metadata.size;
        const finalSha256 = metadata.sha256;
        const name = String(req.query.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120) || ('image.' + ext);
        let scan = null;
        if (getSettings().dlpEnabled !== false) {
          scan = await dlpScanStoredFile(dest, name);
          const dlpBody = { dlpOverride:/^(1|true|yes|on)$/i.test(String(req.query.dlpOverride || '')) };
          if (dlpDecision(req, res, dlpBody, scan, 'photo-upload', { file:dest, name })) { fs.unlink(dest, () => {}); return; }
        }
        const hashLock = await acquireManagedPhotoHashResponseLock(res, finalSha256); if (!hashLock) { fs.unlink(dest, () => {}); return; }
        const duplicate = await findManagedPhotoDuplicateDeep(req, finalSha256, finalSize, { pwa:false });
        if (duplicate && !/^(1|true|yes|on)$/i.test(String(req.query.duplicateOverride || ''))) { fs.unlink(dest, () => {}); return res.status(409).json({ error:'duplicate-content', duplicate:duplicatePhotoPayload(duplicate,req,false), sha256:finalSha256 }); }
        const share = { type:'photo', name, imgPath:fname, ext, size:finalSize, contentSha256:finalSha256 };
        if (metadata.metadataRemoved) share.metadataRemoved = true; if (metadata.metadataRetentionConsentAt) share.metadataRetentionConsentAt = metadata.metadataRetentionConsentAt;
        applyDlpSummary(share, scan);
        stampPhotoUploadDevice(share, req, 'web'); stampOwner(share, req);
        const dim = imageDimensions(dest); if (dim && dim.w > 0 && dim.h > 0) { share.w = dim.w; share.h = dim.h; }
        const rec = addShareDurable(share, req);
        if (!rec) { try { fs.unlinkSync(dest); } catch (_) {} return res.status(503).json({ error:'write-error' }); }
        auditReq(req, 'photo-uploaded', name);
        res.status(201).json({ share:decorateShare(rec, req), dlp:scan });
      })().catch((e) => { fs.unlink(dest, () => {}); if (!res.headersSent) res.status(500).json({ error:'dlp-scan-failed' }); else res.destroy(); });
    });
  });
  
  adminRouter.post('/photos/album', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const name = String(req.body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120) || 'Gallery';
    const members = [];
    for (const id of ids) {
      const m = getById(String(id));
      if (m && m.type === 'photo' && ownsShare(req, m) && !members.includes(m.token)) members.push(m.token);
      if (members.length >= 500) break; // sanity cap
    }
    if (!members.length) return res.status(400).json({ error: 'no-images' });
    const share = { type: 'album', name, members, expiresAt: parseNewShareExpiry(req.body.expiresInSeconds) };
    stampOwner(share, req);
    const rec = addShareDurable(share, req);
    if (!rec) return res.status(503).json({ error:'write-error' });
    auditReq(req, 'album-created', name + ' · ' + members.length);
    res.status(201).json({ share: decorateShare(rec, req) });
  });
  
  adminRouter.get('/photos/download.zip', async (req, res) => {
    const ids = [...new Set(String(req.query.ids || '').split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 100);
    if (!ids.length) return res.status(400).json({ error: 'empty' });
    const files = [];
    const usedNames = new Set();
    for (const id of ids) {
      const photo = getById(id);
      if (!photo || photo.type !== 'photo' || !ownsShare(req, photo)) continue;
      let file = firstExistingPhotoFile(photoOriginalPaths(photo));
      if (!file && photo.hostPath) {
        try {
          file = hostToContainer(photo.hostPath);
          await assertRealWithin(HOST_ROOT, file);
        } catch (_) { file = null; }
      }
      try { if (!file || !(await fs.promises.stat(file)).isFile()) continue; } catch (_) { continue; }
      let name = path.basename(String(photo.name || ('image.' + photoExt(photo))))
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || ('image.' + photoExt(photo));
      const stem = path.basename(name, path.extname(name));
      const ext = path.extname(name);
      let candidate = name, n = 2;
      while (usedNames.has(candidate.toLowerCase())) candidate = `${stem}-${n++}${ext}`;
      usedNames.add(candidate.toLowerCase());
      files.push({ file, name: candidate });
    }
    if (!files.length) return res.status(404).json({ error: 'not-found' });
  
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('direct-xfer-images.zip')}`);
    res.setHeader('Cache-Control', 'no-store');
    const archive = await createZipArchive({ zlib: { level: 6 } });
    archive.on('warning', (w) => { if (w.code !== 'ENOENT') console.warn('[photos-zip] warning:', w.message); });
    archive.on('error', (err) => {
      console.error('[photos-zip] error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'zip-failed' }); else res.destroy();
    });
    res.on('close', () => archive.destroy());
    archive.pipe(res);
    files.forEach((item) => archive.file(item.file, { name: item.name }));
    auditReq(req, 'photos-downloaded', files.length + ' image(s)');
    await archive.finalize();
  });
  
  adminRouter.get('/photos/:id/dims', async (req, res) => {
    const photo = getById(req.params.id);
    if (!photo || photo.type !== 'photo' || !ownsShare(req, photo)) return res.status(404).json({ error:'not-found' });
    res.json(await photoDimensions(photo));
  });
  
  adminRouter.get('/photos/:id/metadata', async (req, res) => {
    const photo = getById(req.params.id);
    if (!photo || photo.type !== 'photo' || !ownsShare(req, photo)) return res.status(404).json({ error:'not-found' });
    const metadata = await photoMetadata(photo);
    if (!metadata) return res.status(404).json({ error:'file-unavailable' });
    res.json({
      name:photo.name || '', deviceName:photoUploadDeviceName(photo), source:photo.uploadSource || null,
      metadataRemoved:!!photo.metadataRemoved, ...metadata,
    });
  });
}

module.exports = { attachAdminPhotoRoutes };
