'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { photoExt, imageDimensions, readPhotoMetadata } = require('../photo-utils');

/**
 * Managed image boundary for Direct-Xfer.
 *
 * Owns the Photos/Images domain that used to be spread throughout server.js:
 * managed storage paths and legacy migration, Mini/Micro/Adaptive variants,
 * revoked-image history previews, view/visitor accounting, duplicate detection,
 * image payload metadata, edit/cache revisions and version snapshots/restores.
 *
 * HTTP route composition remains in server.js; the stateful image mechanics live
 * here and observe the current root state through getState()/listShares().
 */
function createPhotoService(deps = {}) {
  const {
    HOST_ROOT,
    IMAGE_STORE_DIR,
    FULL_IMAGES_DIR,
    THUMBS_DIR,
    MICROS_DIR,
    PHOTO_HISTORY_DIR,
    PHOTO_VERSIONS_DIR,
    ADAPTIVE_IMAGES_DIR,
    LEGACY_IMAGES_DIR,
    LEGACY_THUMBS_DIR,
    LEGACY_MICROS_DIR,
    LEGACY_PHOTO_HISTORY_DIR,
    PHOTO_HISTORY_MAX = 50,
    DAY_MS = 86400000,
    getState,
    listShares,
    trashItems,
    hostToContainer,
    assertRealWithin,
    getSession = () => null,
    clientIp = () => '',
    maskIp = (ip) => ip,
    geoSync = () => null,
    geolocate = async () => null,
    noteCenterCountry = () => {},
    enrichFirstViewCenterNotification = () => {},
    maybeCenterViewThreshold = () => {},
    evaluateCustomNotificationRulesForShare = () => {},
    noteCenterActivity = () => {},
    notifyFirstPhotoView = () => {},
    pubIp = (ip) => ip,
    flagFromCode = () => null,
    scheduleFlush = () => {},
    persist = async () => true,
    persistNow = () => true,
    restorePlainObject = (target, snapshot) => {
      for (const key of Object.keys(target || {})) delete target[key];
      Object.assign(target, snapshot || {});
    },
    addShareCenterNotification = () => {},
    ownsShare = () => false,
    canManagePwaImage = () => false,
    decorateShare = (photo) => photo,
    getSettings = () => ({}),
    primaryBase = () => '',
    isActive = () => true,
    shareEffectiveExpiry = (photo) => photo && photo.expiresAt,
  } = deps;

  for (const [name, value] of Object.entries({
    HOST_ROOT, IMAGE_STORE_DIR, FULL_IMAGES_DIR, THUMBS_DIR, MICROS_DIR,
    PHOTO_HISTORY_DIR, PHOTO_VERSIONS_DIR, ADAPTIVE_IMAGES_DIR,
    LEGACY_IMAGES_DIR, LEGACY_THUMBS_DIR, LEGACY_MICROS_DIR,
    LEGACY_PHOTO_HISTORY_DIR, getState, listShares, trashItems,
    hostToContainer, assertRealWithin,
  })) {
    if (value == null) throw new TypeError(`createPhotoService requires ${name}`);
  }

  const PHOTO_DAILY_VIEW_DAYS = 70;
  const PHOTO_UNIQUE_VISITOR_MAX = 10000;

  function dashboardPhotoSafeString(value) {
    try { return value == null ? '' : String(value); } catch (_) { return ''; }
  }
  function photoDashboardQueryOptions(req, now = Date.now()) {
    const query = req && req.query && typeof req.query === 'object' && !Array.isArray(req.query) ? req.query : {};
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const dq = dashboardPhotoSafeString(query.days || '30');
    const days = ['1', '7', '30', '90', '365'].includes(dq) ? Number(dq) : (dq === 'all' || dq === '0' ? 0 : 30);
    const statusRaw = dashboardPhotoSafeString(query.status || '');
    const status = ['active', 'expired', 'inactive'].includes(statusRaw) ? statusRaw : '';
    const rawFormat = dashboardPhotoSafeString(query.format || '').toLowerCase();
    const format = /^(jpg|png|gif|webp|bmp|avif)$/.test(rawFormat) ? rawFormat : '';
    const q = dashboardPhotoSafeString(query.q || '').trim().toLowerCase().slice(0, 100);
    return { days, cutoff:days > 0 ? current - days * DAY_MS : 0, status, format, q };
  }

  function photoMatchesDashboardFilters(s, filters = {}, now = Date.now()) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || s.type !== 'photo') return false;
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (filters.cutoff) {
      const createdAt = Number(s.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < filters.cutoff) return false;
    }
    let ext = '';
    try { ext = dashboardPhotoSafeString(photoExt(s)).toLowerCase(); } catch (_) { ext = ''; }
    if (filters.format && ext !== filters.format) return false;
    if (filters.status) {
      const expiresAt = Number(s.expiresAt);
      const expired = !s.revoked && Number.isFinite(expiresAt) && expiresAt > 0 && current > expiresAt;
      let active = false;
      try { active = isActive(s, current) === true; } catch (_) { active = false; }
      const status = active ? 'active' : expired ? 'expired' : 'inactive';
      if (status !== filters.status) return false;
    }
    if (filters.q) {
      const hay = [s.name, s.token, ext].map(dashboardPhotoSafeString).filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(filters.q)) return false;
    }
    return true;
  }

  const adminPhotoVariantWrites = new Set();
  const adminPhotoFullWrites = new Set();
  const managedPhotoHashLocks = new Map();
  const photoDuplicateCaches = new Map();

  function state() { return getState(); }

  function photoHistoryCount(value) {
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(value) || 0)));
  }

  function normalizePhotoHistory(items) {
    if (!Array.isArray(items)) return [];
    return items
      .filter((r) => r && /^[a-f0-9]{16}$/.test(String(r.id || '')))
      .slice(0, PHOTO_HISTORY_MAX)
      .map((r) => ({
        id: String(r.id),
        name: String(r.name || 'Image').replace(/[\r\n\t]+/g, ' ').slice(0, 200),
        ext: /^(jpg|png|gif|webp|bmp|avif)$/.test(String(r.ext || '').toLowerCase()) ? String(r.ext).toLowerCase() : 'jpg',
        size: Math.max(0, Number(r.size) || 0),
        createdAt: Math.max(0, Number(r.createdAt) || 0),
        revokedAt: Math.max(0, Number(r.revokedAt) || 0),
        ownerId: r.ownerId ? String(r.ownerId).slice(0, 128) : null,
        ownerName: r.ownerName ? String(r.ownerName).replace(/[\r\n\t]+/g, ' ').slice(0, 80) : null,
        metadataRemoved: !!r.metadataRemoved,
        fullViews: photoHistoryCount(r.fullViews),
        fullVisitors: photoHistoryCount(r.fullVisitors),
        thumbViews: photoHistoryCount(r.thumbViews),
        thumbVisitors: photoHistoryCount(r.thumbVisitors),
        microViews: photoHistoryCount(r.microViews),
        microVisitors: photoHistoryCount(r.microVisitors),
        preview: !!r.preview,
        previewSize: Math.max(0, Number(r.previewSize) || 0),
      }));
  }

  function canSeePhotoHistory(req, record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const session = req && req.session;
    if (!session || typeof session !== 'object') return false;
    return session.role !== 'operator' || (!!record.ownerId && record.ownerId === session.accountId);
  }

  function visiblePhotoHistory(req) {
    const root = state();
    const items = root && Array.isArray(root.photoHistory) ? root.photoHistory : [];
    return items.filter((record) => canSeePhotoHistory(req, record)).slice(0, PHOTO_HISTORY_MAX);
  }

  function photoHistoryMeta(req) {
    const items = visiblePhotoHistory(req);
    const latest = items[0] || null;
    return {
      count:items.length,
      latestId:latest && latest.id ? latest.id : null,
      latestAt:latest && Number.isFinite(Number(latest.revokedAt)) ? Math.max(0, Number(latest.revokedAt)) : 0,
    };
  }

  function uniquePhotoPaths(paths) {
    return [...new Set((paths || []).filter(Boolean).map((p) => path.resolve(p)))];
  }

  function safeManagedImageName(name) {
    const value = String(name || '');
    return /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : null;
  }

  function safePhotoToken(token) {
    const value = String(token || '');
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
  }

  function photoOriginalPaths(photo) {
    const name = photo && safeManagedImageName(photo.imgPath);
    return name ? uniquePhotoPaths([path.join(FULL_IMAGES_DIR, name), path.join(LEGACY_IMAGES_DIR, name)]) : [];
  }

  function photoAdaptivePath(token, format) {
    const safeToken = safePhotoToken(token);
    const ext = String(format || '').toLowerCase();
    if (!safeToken || !/^(webp|avif)$/.test(ext)) return null;
    return path.join(ADAPTIVE_IMAGES_DIR, safeToken + '.' + ext);
  }

  function photoVersionDir(token) {
    const safeToken = safePhotoToken(token);
    return safeToken ? path.join(PHOTO_VERSIONS_DIR, safeToken) : null;
  }

  function photoVariantPaths(token, variant) {
    const safeToken = safePhotoToken(token);
    if (!safeToken) return [];
    const current = variant === 'micro' ? MICROS_DIR : THUMBS_DIR;
    const legacy = variant === 'micro' ? LEGACY_MICROS_DIR : LEGACY_THUMBS_DIR;
    return uniquePhotoPaths([path.join(current, safeToken + '.jpg'), path.join(legacy, safeToken + '.jpg')]);
  }

  function firstExistingPhotoFile(paths) {
    for (const candidate of paths || []) {
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
    }
    return null;
  }

  function unlinkPhotoFiles(paths) {
    for (const candidate of uniquePhotoPaths(paths)) fs.unlink(candidate, () => {});
  }

  async function copyPhotoFile(source, destination) {
    await fs.promises.mkdir(path.dirname(destination), { recursive:true });
    const tmp = destination + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      await fs.promises.copyFile(source, tmp);
      await fs.promises.rename(tmp, destination);
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch (_) {}
      throw e;
    }
  }

  async function copyFirstExistingPhotoFile(sources, destination) {
    try { if ((await fs.promises.stat(destination)).isFile()) return false; } catch (_) {}
    for (const source of uniquePhotoPaths(sources)) {
      if (source === path.resolve(destination)) continue;
      try {
        if (!(await fs.promises.stat(source)).isFile()) continue;
        await copyPhotoFile(source, destination);
        return true;
      } catch (_) {}
    }
    return false;
  }

  function newStoredImageName(name) {
    return crypto.randomBytes(12).toString('hex') + '.' + photoExt({ name });
  }

  async function copyHostPhotoToStore(item) {
    const source = hostToContainer(item.hostPath);
    await assertRealWithin(HOST_ROOT, source);
    const storedName = newStoredImageName(item.name);
    await copyPhotoFile(source, path.join(FULL_IMAGES_DIR, storedName));
    return storedName;
  }

  function photoHistoryPreviewPath(id) {
    return /^[a-f0-9]{16}$/.test(String(id || '')) ? path.join(PHOTO_HISTORY_DIR, id + '.jpg') : null;
  }

  function photoHistoryPreviewPaths(id) {
    if (!/^[a-f0-9]{16}$/.test(String(id || ''))) return [];
    return uniquePhotoPaths([photoHistoryPreviewPath(id), path.join(LEGACY_PHOTO_HISTORY_DIR, id + '.jpg')]);
  }

  function deletePhotoHistoryPreview(record) {
    for (const previewPath of photoHistoryPreviewPaths(record && record.id)) {
      try { fs.unlinkSync(previewPath); }
      catch (e) { if (e.code !== 'ENOENT') console.error('[photo-history] preview delete failed:', e.message); }
    }
  }

  function stagePhotoHistoryPreviewRemoval(records) {
    const moved = [];
    try {
      for (const record of records || []) {
        for (const previewPath of photoHistoryPreviewPaths(record && record.id)) {
          try { if (!fs.statSync(previewPath).isFile()) continue; }
          catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          const staged = previewPath + '.delete-' + crypto.randomBytes(6).toString('hex');
          fs.renameSync(previewPath, staged);
          moved.push({ from: previewPath, staged });
        }
      }
    } catch (e) {
      for (let i = moved.length - 1; i >= 0; i--) { try { fs.renameSync(moved[i].staged, moved[i].from); } catch (_) {} }
      throw e;
    }
    return {
      rollback() { for (let i = moved.length - 1; i >= 0; i--) { try { fs.renameSync(moved[i].staged, moved[i].from); } catch (_) {} } },
      finalize() { for (const item of moved) { try { fs.unlinkSync(item.staged); } catch (e) { if (e.code !== 'ENOENT') console.error('[photo-history] staged preview cleanup failed:', e.message); } } },
    };
  }

  function archiveRevokedPhoto(photo) {
    if (!photo || photo.type !== 'photo') return;
    const rootState = state();
    if (!Array.isArray(rootState.photoHistory)) rootState.photoHistory = [];
    const stats = photoStatsOf(photo);
    const record = {
      id: crypto.randomBytes(8).toString('hex'),
      name: String(photo.name || 'Image').replace(/[\r\n\t]+/g, ' ').slice(0, 200),
      ext: photoExt(photo),
      size: Math.max(0, Number(photo.size) || 0),
      createdAt: Math.max(0, Number(photo.createdAt) || 0),
      revokedAt: Date.now(),
      ownerId: photo.ownerId || null,
      ownerName: photo.ownerName || null,
      metadataRemoved: !!photo.metadataRemoved,
      fullViews: photoHistoryCount(stats.full.v),
      fullVisitors: photoHistoryCount(Array.isArray(stats.full.u) ? stats.full.u.length : 0),
      thumbViews: photoHistoryCount(stats.thumb.v),
      thumbVisitors: photoHistoryCount(Array.isArray(stats.thumb.u) ? stats.thumb.u.length : 0),
      microViews: photoHistoryCount(stats.micro.v),
      microVisitors: photoHistoryCount(Array.isArray(stats.micro.u) ? stats.micro.u.length : 0),
      preview: false,
      previewSize: 0,
    };
    const destination = photoHistoryPreviewPath(record.id);
    for (const source of [...photoVariantPaths(photo.token, 'micro'), ...photoVariantPaths(photo.token, 'thumb')]) {
      try {
        if (!fs.statSync(source).isFile()) continue;
        fs.copyFileSync(source, destination);
        record.preview = true;
        try { record.previewSize = fs.statSync(destination).size; } catch (_) {}
        break;
      } catch (_) {}
    }
    rootState.photoHistory.unshift(record);
    while (rootState.photoHistory.length > PHOTO_HISTORY_MAX) deletePhotoHistoryPreview(rootState.photoHistory.pop());
    return record;
  }

  async function migrateLegacyPhotoStorage() {
    let copied = 0, stateChanged = false;
    const rootState = state();
    for (const photo of rootState.shares || []) {
      if (!photo || photo.type !== 'photo') continue;
      try {
        const managedName = safeManagedImageName(photo.imgPath);
        if (managedName) {
          if (await copyFirstExistingPhotoFile(photoOriginalPaths(photo), path.join(FULL_IMAGES_DIR, managedName))) copied += 1;
        } else if (photo.hostPath) {
          const source = hostToContainer(photo.hostPath);
          await assertRealWithin(HOST_ROOT, source);
          const storedName = newStoredImageName(photo.name);
          await copyPhotoFile(source, path.join(FULL_IMAGES_DIR, storedName));
          photo.imgPath = storedName;
          copied += 1;
          stateChanged = true;
        }
        const token = safePhotoToken(photo.token);
        if (token && photo.thumb && await copyFirstExistingPhotoFile(photoVariantPaths(token, 'thumb'), path.join(THUMBS_DIR, token + '.jpg'))) copied += 1;
        if (token && photo.micro && await copyFirstExistingPhotoFile(photoVariantPaths(token, 'micro'), path.join(MICROS_DIR, token + '.jpg'))) copied += 1;
      } catch (e) {
        console.error('[images] could not migrate ' + String(photo.name || photo.id || 'photo') + ':', e.message);
      }
    }
    for (const record of rootState.photoHistory || []) {
      if (!record || !record.preview) continue;
      const destination = photoHistoryPreviewPath(record.id);
      if (destination && await copyFirstExistingPhotoFile(photoHistoryPreviewPaths(record.id), destination)) copied += 1;
    }
    if (stateChanged) await persist();
    if (copied) console.log(`[images] migrated ${copied} file(s) into ${IMAGE_STORE_DIR}`);
    return { copied, stateChanged };
  }

  function photoStatsOf(photo) {
    if (!photo.pstats || typeof photo.pstats !== 'object') photo.pstats = {};
    if (!photo.pstats.full) photo.pstats.full = { v: 0, u: [] };
    if (!photo.pstats.thumb) photo.pstats.thumb = { v: 0, u: [] };
    if (!photo.pstats.micro) photo.pstats.micro = { v: 0, u: [] };
    if (!Array.isArray(photo.pstats.recent)) photo.pstats.recent = [];
    return photo.pstats;
  }

  function localDayKey(at) {
    const d = new Date(Number(at) || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function localDayKeys(endAt, days) {
    const out = [];
    const d = new Date(Number(endAt) || Date.now());
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - Math.max(0, days - 1));
    for (let i = 0; i < days; i++) {
      out.push({ key: localDayKey(d.getTime()), at:d.getTime() });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function ensurePhotoDailyViews(photo, now = Date.now()) {
    const ps = photoStatsOf(photo);
    let changed = false;
    if (!ps.dailyViews || typeof ps.dailyViews !== 'object' || Array.isArray(ps.dailyViews)) {
      ps.dailyViews = {};
      for (const ev of ps.recent || []) {
        const at = Number(ev && ev.at) || 0;
        if (!at) continue;
        const key = localDayKey(at);
        ps.dailyViews[key] = (Number(ps.dailyViews[key]) || 0) + 1;
      }
      ps.dailyViewsSeededAt = now;
      changed = true;
    }
    const keep = new Set(localDayKeys(now, PHOTO_DAILY_VIEW_DAYS).map((d) => d.key));
    for (const key of Object.keys(ps.dailyViews)) {
      if (!keep.has(key)) { delete ps.dailyViews[key]; changed = true; }
    }
    return { daily: ps.dailyViews, changed };
  }

  function notePhotoDailyView(photo, at) {
    const snapshot = ensurePhotoDailyViews(photo, at);
    const key = localDayKey(at);
    snapshot.daily[key] = (Number(snapshot.daily[key]) || 0) + 1;
  }

  function photoVisitorSet(st) {
    if (!Array.isArray(st.u)) st.u = [];
    if (st.u.length > PHOTO_UNIQUE_VISITOR_MAX) st.u = st.u.slice(-PHOTO_UNIQUE_VISITOR_MAX);
    // The array can be replaced during normalization/rollback. Tie the cached Set
    // to the exact array object so it can never drift from the durable list.
    if (!st._visitorSet || st._visitorListRef !== st.u) {
      Object.defineProperty(st, '_visitorSet', {
        value: new Set(st.u), enumerable:false, configurable:true, writable:true,
      });
      Object.defineProperty(st, '_visitorListRef', {
        value: st.u, enumerable:false, configurable:true, writable:true,
      });
    }
    return st._visitorSet;
  }

  function notePhotoView(photo, req, kind) {
    if (!photo || photo.type !== 'photo') return;
    if (getSession(req)) return;
    const allStats = photoStatsOf(photo);
    const st = allStats[kind];
    if (!st) return;
    const now = Date.now();
    st.v = (st.v || 0) + 1;
    st.lastAt = now;
    if (kind === 'full') photo.downloads = (photo.downloads || 0) + 1;
    const rawIp = clientIp(req);
    const ip = String(rawIp || '').replace(/^::ffff:/i, '');
    const visitors = photoVisitorSet(st);
    if (ip && Array.isArray(st.u) && !visitors.has(ip)) {
      const legacyMaskedIp = maskIp(ip);
      const legacyIndex = legacyMaskedIp && legacyMaskedIp !== ip ? st.u.indexOf(legacyMaskedIp) : -1;
      if (legacyIndex >= 0) {
        st.u[legacyIndex] = ip;
        visitors.delete(legacyMaskedIp);
        visitors.add(ip);
      } else {
        st.u.push(ip);
        visitors.add(ip);
        if (st.u.length > PHOTO_UNIQUE_VISITOR_MAX) visitors.delete(st.u.shift());
      }
    }
    const geo = geoSync(rawIp) || {};
    noteCenterCountry(photo, rawIp, geo);
    notePhotoDailyView(photo, now);
    const viewEntry = {
      at: now, kind, ip: ip || null, ipFull: !!ip,
      country: geo.country || null, countryCode: geo.countryCode || null, flag: geo.flag || null,
    };
    allStats.recent.unshift(viewEntry);
    if (allStats.recent.length > 100) allStats.recent.length = 100;
    if (ip && (!viewEntry.country || !viewEntry.flag)) {
      geolocate(rawIp).then((resolved) => {
        if (!resolved || !allStats.recent.includes(viewEntry)) return;
        viewEntry.country = resolved.country || null;
        viewEntry.countryCode = resolved.countryCode || null;
        viewEntry.flag = resolved.flag || null;
        noteCenterCountry(photo, rawIp, resolved);
        enrichFirstViewCenterNotification(photo, rawIp, resolved);
        scheduleFlush();
      }).catch(() => {});
    }
    maybeCenterViewThreshold(photo);
    evaluateCustomNotificationRulesForShare(photo);
    noteCenterActivity(photo, 'image-view', rawIp);
    if (photo.notifyFirstView && !photo.firstViewNotifiedAt) {
      photo.firstViewNotifiedAt = now;
      photo.firstViewKind = kind;
      const displayIp = ip ? pubIp(ip) : null;
      photo.firstViewIp = displayIp;
      try { notifyFirstPhotoView(photo, req, kind, displayIp, geo); } catch (_) {}
    }
    scheduleFlush();
  }

  function hashFileSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const input = fs.createReadStream(filePath);
      input.on('error', reject);
      input.on('data', (chunk) => hash.update(chunk));
      input.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async function analyzePhotoDuplicates(photos, publicPhotoUrl, previewPhotoUrl) {
    const MAX_PHOTOS = 2500;
    const MAX_HASH_FILES = 500;
    const selected = photos.slice(0, MAX_PHOTOS);
    const signature = selected.map((s) => `${s.token}:${Number(s.size) || 0}:${s.imgPath || ''}:${s.contentSha256 || ''}:${photoCacheRevision(s)}`).sort().join('|');
    const cached = photoDuplicateCaches.get(signature);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;

    const bySize = new Map();
    for (const s of selected) {
      const size = Math.max(0, Number(s.size) || 0);
      if (!size || !s.imgPath) continue;
      const abs = firstExistingPhotoFile(photoOriginalPaths(s));
      if (!abs) continue;
      const row = { share:s, abs, size };
      const arr = bySize.get(size) || [];
      arr.push(row);
      bySize.set(size, arr);
    }

    const hashes = new Map();
    let hashedFiles = 0;
    let truncated = photos.length > MAX_PHOTOS;
    for (const rows of bySize.values()) {
      if (rows.length < 2) continue;
      for (const row of rows) {
        if (hashedFiles >= MAX_HASH_FILES) { truncated = true; break; }
        hashedFiles += 1;
        try {
          const hash = await hashFileSha256(row.abs);
          const key = `${row.size}:${hash}`;
          const arr = hashes.get(key) || [];
          arr.push(row);
          hashes.set(key, arr);
        } catch (_) {}
      }
      if (hashedFiles >= MAX_HASH_FILES) break;
    }

    const groups = [];
    let duplicateFiles = 0, reclaimableBytes = 0;
    for (const [key, rows] of hashes) {
      if (rows.length < 2) continue;
      const size = rows[0].size;
      const reclaimable = size * (rows.length - 1);
      duplicateFiles += rows.length - 1;
      reclaimableBytes += reclaimable;
      groups.push({
        id: key.slice(key.indexOf(':') + 1, key.indexOf(':') + 13),
        count: rows.length,
        size,
        reclaimableBytes: reclaimable,
        items: rows.slice(0, 8).map(({ share:s }) => ({
          name:s.name, token:s.token, url:publicPhotoUrl(s), previewUrl:previewPhotoUrl(s),
        })),
      });
    }
    groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
    const data = {
      groups:groups.slice(0, 12), groupCount:groups.length, duplicateFiles, reclaimableBytes,
      scanned:selected.length, hashedFiles, truncated, generatedAt:Date.now(),
    };
    photoDuplicateCaches.set(signature, { at:Date.now(), data });
    if (photoDuplicateCaches.size > 8) photoDuplicateCaches.delete(photoDuplicateCaches.keys().next().value);
    return data;
  }

  function estimateImageOptimization(rows) {
    const webpRatios = { jpg:0.80, png:0.60, bmp:0.25 };
    const avifRatios = { jpg:0.65, png:0.45, bmp:0.15, webp:0.80 };
    const analyze = (ratios) => {
      const candidates = [];
      let sourceBytes = 0, estimatedBytes = 0;
      for (const r of rows) {
        const ratio = ratios[r.ext];
        const bytes = Math.max(0, Number(r.fullSize) || 0);
        if (!ratio || bytes < 64 * 1024) continue;
        const estimated = Math.round(bytes * ratio);
        const savings = Math.max(0, bytes - estimated);
        sourceBytes += bytes;
        estimatedBytes += estimated;
        candidates.push({
          name:r.name, token:r.token, format:r.ext, bytes,
          estimatedBytes:estimated, estimatedSavings:savings,
          previewUrl:r.previewUrl, url:r.url,
        });
      }
      candidates.sort((a, b) => b.estimatedSavings - a.estimatedSavings);
      return {
        eligible:candidates.length, sourceBytes, estimatedBytes,
        estimatedSavings:Math.max(0, sourceBytes - estimatedBytes),
        candidates:candidates.slice(0, 10),
      };
    };
    return { webp:analyze(webpRatios), avif:analyze(avifRatios), estimated:true };
  }

  function validSha256(value) { return /^[a-f0-9]{64}$/i.test(String(value || '')); }

  async function acquireManagedPhotoHashResponseLock(res, sha) {
    if (!validSha256(sha)) return () => {};
    const key = String(sha).toLowerCase();
    const previous = managedPhotoHashLocks.get(key) || Promise.resolve();
    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    const tail = previous.then(() => gate);
    managedPhotoHashLocks.set(key, tail);
    await previous;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      openGate();
      if (managedPhotoHashLocks.get(key) === tail) managedPhotoHashLocks.delete(key);
    };
    if (!res || res.destroyed) { release(); return null; }
    res.once('finish', release);
    res.once('close', release);
    return release;
  }

  function managedPhotoCandidates() {
    const out = [];
    const seen = new Set();
    for (const photo of listShares().concat(trashItems().map((rec) => rec && rec.share).filter(Boolean))) {
      if (!photo || photo.type !== 'photo' || seen.has(String(photo.id || ''))) continue;
      seen.add(String(photo.id || ''));
      out.push(photo);
    }
    return out;
  }

  function findManagedPhotoDuplicate(req, sha, size, options) {
    options = options || {};
    if (!validSha256(sha)) return null;
    const expectedSize = Math.max(0, Number(size) || 0);
    return managedPhotoCandidates().find((photo) => {
      if (!photo || photo.type !== 'photo' || String(photo.id) === String(options.excludeId || '')) return false;
      if (expectedSize && Number(photo.size || 0) && Number(photo.size) !== expectedSize) return false;
      const stored = String(photo.contentSha256 || '').toLowerCase();
      if (stored !== String(sha).toLowerCase()) return false;
      return options.pwa ? canManagePwaImage(req, photo) : ownsShare(req, photo);
    }) || null;
  }

  function duplicatePhotoPayload(photo, req, pwa) {
    if (!photo) return null;
    const payload = pwa ? pwaPhotoPayload(req, photo) : decorateShare(photo, req);
    if (!(state().shares || []).some((row) => row && String(row.id) === String(photo.id))) {
      payload.active = false;
      payload.status = 'trash';
      payload.trashed = true;
    }
    return payload;
  }

  async function findManagedPhotoDuplicateDeep(req, sha, size, options) {
    const direct = findManagedPhotoDuplicate(req, sha, size, options);
    if (direct) return direct;
    if (!validSha256(sha)) return null;
    options = options || {};
    const expectedSize = Math.max(0, Number(size) || 0);
    for (const photo of managedPhotoCandidates()) {
      if (!photo || photo.type !== 'photo' || String(photo.id) === String(options.excludeId || '')) continue;
      if (expectedSize && Number(photo.size || 0) !== expectedSize) continue;
      if (options.pwa ? !canManagePwaImage(req, photo) : !ownsShare(req, photo)) continue;
      if (validSha256(photo.contentSha256)) continue;
      const abs = firstExistingPhotoFile(photoOriginalPaths(photo));
      if (!abs) continue;
      try {
        const actual = await hashFileSha256(abs);
        photo.contentSha256 = actual;
        scheduleFlush();
        if (actual.toLowerCase() === String(sha).toLowerCase()) return photo;
      } catch (_) {}
    }
    return null;
  }

  function streamToFileBounded(req, res, dest, maxBytes, onDone) {
    const ws = fs.createWriteStream(dest, { flags:'wx' });
    const contentHash = crypto.createHash('sha256');
    let size = 0, failed = false;
    const fail = (code) => {
      if (failed) return;
      failed = true;
      try { req.unpipe(ws); ws.destroy(); if (!req.destroyed) req.resume(); } catch (_) {}
      fs.unlink(dest, () => {});
      if (!res.headersSent) res.status(code || 500).json({ error:code === 413 ? 'too-large' : 'write-error' });
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (!failed) contentHash.update(chunk);
      if (size > maxBytes) fail(413);
    });
    req.on('aborted', () => fail(400));
    req.on('error', () => fail(400));
    ws.on('error', () => fail(500));
    ws.on('finish', () => {
      if (failed) return;
      if (size === 0) {
        fs.unlink(dest, () => {});
        if (!res.headersSent) res.status(400).json({ error:'empty' });
        return;
      }
      onDone(size, contentHash.digest('hex'));
    });
    req.pipe(ws);
  }

  function photoCacheRevision(photo) {
    return Math.max(1, Number(photo && photo.cacheRevision) || 1);
  }

  function bumpPhotoCacheRevision(photo) {
    photo.cacheRevision = photoCacheRevision(photo) + 1;
    photo.cacheInvalidatedAt = Date.now();
    return photo.cacheRevision;
  }

  function cleanPhotoEditOperations(raw) {
    const source = Array.isArray(raw) ? raw : String(raw || '').split(',');
    return source.map((x) => String(x || '').replace(/[\r\n\t]/g, ' ').trim().slice(0,80)).filter(Boolean).slice(0,20);
  }

  function addPhotoEditHistory(photo, action, operations, detail = {}) {
    if (!Array.isArray(photo.editHistory)) photo.editHistory = [];
    photo.editHistory.unshift({
      at:Date.now(), action:String(action || 'edit').slice(0,40),
      operations:cleanPhotoEditOperations(operations), ...detail,
    });
    if (photo.editHistory.length > 50) photo.editHistory.length = 50;
  }

  function ensurePhotoOriginalVersionMarker(photo) {
    if (!photo || !Array.isArray(photo.versions) || !photo.versions.length || photo.versions.some((v) => v && v.original)) return;
    const archivedActions = Array.isArray(photo.editHistory)
      ? photo.editHistory.filter((h) => h && (h.action === 'edit' || h.action === 'restore')).length
      : 0;
    if (archivedActions <= photo.versions.length) photo.versions[photo.versions.length - 1].original = true;
  }

  function archiveCurrentPhotoVersion(photo, meta = {}) {
    const source = firstExistingPhotoFile(photoOriginalPaths(photo));
    if (!source) return null;
    const versionRoot = photoVersionDir(photo && photo.token);
    if (!versionRoot) throw new Error('invalid-photo-token');
    if (!Array.isArray(photo.versions)) photo.versions = [];
    ensurePhotoOriginalVersionMarker(photo);
    const isOriginal = photo.versions.length === 0;
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const dir = path.join(versionRoot, id);
    fs.mkdirSync(dir, { recursive:true });
    const ext = photoExt(photo);
    try {
      fs.copyFileSync(source, path.join(dir, 'full.' + ext));
      const thumb = firstExistingPhotoFile(photoVariantPaths(photo.token, 'thumb'));
      if (thumb) fs.copyFileSync(thumb, path.join(dir, 'thumb.jpg'));
      const micro = firstExistingPhotoFile(photoVariantPaths(photo.token, 'micro'));
      if (micro) fs.copyFileSync(micro, path.join(dir, 'micro.jpg'));
      for (const fmt of ['webp','avif']) {
        const src = photoAdaptivePath(photo.token, fmt);
        try { if (src && fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, 'adaptive.' + fmt)); } catch (_) {}
      }
    } catch (e) {
      try { fs.rmSync(dir, { recursive:true, force:true }); } catch (_) {}
      throw e;
    }
    const version = {
      id, at:Date.now(), name:photo.name, ext, size:photo.size || 0,
      w:photo.w || null, h:photo.h || null, metadataRemoved:!!photo.metadataRemoved,
      thumb:!!photo.thumb, thumbSize:photo.thumbSize || 0, thumbW:photo.thumbW || null, thumbH:photo.thumbH || null,
      micro:!!photo.micro, microSize:photo.microSize || 0, microW:photo.microW || null, microH:photo.microH || null,
      adaptiveWebp:!!photo.adaptiveWebp, adaptiveAvif:!!photo.adaptiveAvif,
      reason:String(meta.reason || 'edit').slice(0,40), operations:cleanPhotoEditOperations(meta.operations), original:isOriginal,
    };
    if (validSha256(photo.contentSha256)) version.contentSha256 = String(photo.contentSha256).toLowerCase();
    if (photo.dlp && typeof photo.dlp === 'object') version.dlp = JSON.parse(JSON.stringify(photo.dlp));
    photo.versions.unshift(version);
    while (photo.versions.length > 10) {
      let removeIndex = photo.versions.length - 1;
      if (photo.versions[removeIndex] && photo.versions[removeIndex].original) removeIndex -= 1;
      if (removeIndex < 0) break;
      photo.versions.splice(removeIndex, 1);
    }
    return version;
  }

  function cleanupPhotoVersionStorage(photo) {
    if (!photo || !photo.token) return;
    const dir = photoVersionDir(photo.token);
    if (!dir) return;
    const keep = new Set((Array.isArray(photo.versions) ? photo.versions : []).map((v) => String(v && v.id || '')).filter(Boolean));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (keep.has(name) || !/^[A-Za-z0-9_-]{6,96}$/.test(name)) continue;
      try { fs.rmSync(path.join(dir, name), { recursive:true, force:true }); }
      catch (e) { console.error('[photo-version] cleanup failed:', name, e && e.message); }
    }
  }

  function restorePhotoVersion(photo, version) {
    const versionRoot = photoVersionDir(photo && photo.token);
    const versionId = String(version && version.id || '');
    const ext = String(version && version.ext || '').toLowerCase();
    if (!versionRoot || !/^[A-Za-z0-9_-]{6,96}$/.test(versionId) || !/^(jpg|png|gif|webp|bmp|avif)$/.test(ext)) return null;
    const dir = path.join(versionRoot, versionId);
    const full = firstExistingPhotoFile([path.join(dir, 'full.' + ext)]);
    if (!full) return null;
    const before = JSON.parse(JSON.stringify(photo));
    const oldManagedPaths = [
      ...photoOriginalPaths(photo), ...photoVariantPaths(photo.token, 'thumb'), ...photoVariantPaths(photo.token, 'micro'),
      photoAdaptivePath(photo.token, 'webp'), photoAdaptivePath(photo.token, 'avif'),
    ];
    const newName = crypto.randomBytes(12).toString('hex') + '.' + ext;
    const newDest = path.join(FULL_IMAGES_DIR, newName);
    try { fs.copyFileSync(full, newDest); } catch (_) { return null; }
    let archivedVersion = null;
    try { archivedVersion = archiveCurrentPhotoVersion(photo, { reason:'restore', operations:['restore'] }); }
    catch (e) {
      try { fs.unlinkSync(newDest); } catch (_) {}
      restorePlainObject(photo, before);
      throw e;
    }
    photo.imgPath = newName;
    photo.ext = ext;
    photo.name = version.name;
    photo.size = version.size;
    photo.w = version.w;
    photo.h = version.h;
    if (validSha256(version.contentSha256)) photo.contentSha256 = String(version.contentSha256).toLowerCase();
    else delete photo.contentSha256;
    if (version.dlp && typeof version.dlp === 'object') photo.dlp = JSON.parse(JSON.stringify(version.dlp));
    else delete photo.dlp;
    if (version.metadataRemoved) photo.metadataRemoved = true;
    else delete photo.metadataRemoved;
    for (const key of [
      'thumb','thumbSize','thumbW','thumbH','thumbMetaMtimeMs',
      'micro','microSize','microW','microH','microMetaMtimeMs',
      'adaptiveWebp','adaptiveWebpSize','adaptiveWebpW','adaptiveWebpH',
      'adaptiveAvif','adaptiveAvifSize','adaptiveAvifW','adaptiveAvifH',
    ]) delete photo[key];
    photo.restoredAt = Date.now();
    bumpPhotoCacheRevision(photo);
    addPhotoEditHistory(photo, 'restore', ['restore'], {
      versionId:version.id,
      from:{ w:before.w || null, h:before.h || null, size:before.size || 0 },
      to:{ w:photo.w || null, h:photo.h || null, size:photo.size || 0 },
    });
    return { before, oldManagedPaths, archivedVersion, newDest };
  }

  function adminPhotoHasVariantWrite(photoId) {
    const prefix = String(photoId || '') + ':';
    for (const key of adminPhotoVariantWrites) if (String(key).startsWith(prefix)) return true;
    return false;
  }

  function handleAdminPhotoVariantUpload(req, res, photo, kind, maxBytes) {
    const key = `${photo.id}:${kind}`;
    if (adminPhotoFullWrites.has(String(photo.id)) || adminPhotoVariantWrites.has(key)) {
      req.resume();
      return res.status(409).json({ error:'variant-busy' });
    }
    adminPhotoVariantWrites.add(key);
    let released = false;
    const release = () => { if (!released) { released = true; adminPhotoVariantWrites.delete(key); } };
    const isThumb = kind === 'thumb';
    const dir = isThumb ? THUMBS_DIR : MICROS_DIR;
    const token = safePhotoToken(photo.token);
    if (!token) { release(); req.resume(); return res.status(400).json({ error:'invalid-photo' }); }
    const dest = path.join(dir, token + '.jpg');
    const tmp = dest + '.upload-' + crypto.randomBytes(6).toString('hex');
    const ws = fs.createWriteStream(tmp, { flags:'wx' });
    let size = 0, failed = false;
    const fail = (code, error) => {
      if (failed) return;
      failed = true;
      try { req.unpipe(ws); ws.destroy(); if (!req.destroyed) req.resume(); } catch (_) {}
      try { fs.unlinkSync(tmp); } catch (_) {}
      release();
      if (!res.headersSent) res.status(code || 500).json({ error:error || (isThumb ? 'thumb-failed' : 'micro-failed') });
    };
    req.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) fail(413); });
    req.on('aborted', () => fail(400));
    req.on('error', () => fail(400));
    ws.on('error', () => fail(500));
    ws.on('finish', () => {
      if (failed) return;
      if (size === 0) return fail(400);
      const before = JSON.parse(JSON.stringify(photo));
      let backup = null;
      try {
        try {
          if (fs.statSync(dest).isFile()) {
            backup = dest + '.backup-' + crypto.randomBytes(6).toString('hex');
            fs.renameSync(dest, backup);
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        fs.renameSync(tmp, dest);
        const dims = imageDimensions(dest);
        const wasVariant = !!before[kind];
        photo[kind] = true;
        photo[kind + 'Size'] = size;
        if (dims && dims.w > 0 && dims.h > 0) { photo[kind + 'W'] = dims.w; photo[kind + 'H'] = dims.h; }
        else { delete photo[kind + 'W']; delete photo[kind + 'H']; }
        try { photo[kind + 'MetaMtimeMs'] = Math.floor(fs.statSync(dest).mtimeMs || 0); }
        catch (_) { delete photo[kind + 'MetaMtimeMs']; }
        bumpPhotoCacheRevision(photo);
        addPhotoEditHistory(photo, 'variant', ['resize-' + kind], { variant:kind, w:dims && dims.w || null, h:dims && dims.h || null, size });
        if (!persistNow()) {
          restorePlainObject(photo, before);
          try { fs.unlinkSync(dest); } catch (_) {}
          if (backup) { try { fs.renameSync(backup, dest); } catch (_) {} }
          release();
          return res.status(503).json({ error:'write-error' });
        }
        if (backup) { try { fs.unlinkSync(backup); } catch (e) { console.error('[photo-variant] old variant cleanup failed:', e.message); } }
        if (wasVariant) addShareCenterNotification(photo, 'image-variant-regenerated', {
          variant:kind, bytes:size,
          dedupeKey:`variant-regenerated:${photo.id}:${kind}:${Math.floor(Date.now()/60000)}`,
          dedupeWindowMs:60000,
        });
        release();
        res.json({ ok:true, w:dims ? dims.w : null, h:dims ? dims.h : null, bytes:size });
      } catch (_) {
        restorePlainObject(photo, before);
        try { fs.unlinkSync(tmp); } catch (_) {}
        try { fs.unlinkSync(dest); } catch (_) {}
        if (backup) { try { fs.renameSync(backup, dest); } catch (_) {} }
        release();
        if (!res.headersSent) res.status(500).json({ error:isThumb ? 'thumb-failed' : 'micro-failed' });
      }
    });
    req.pipe(ws);
  }

  function handlePhotoAdaptiveUpload(req, res, photo, fmt, maxBytes) {
    const safeFmt = /^(webp|avif)$/.test(String(fmt || '').toLowerCase()) ? String(fmt).toLowerCase() : null;
    const dest = safeFmt ? photoAdaptivePath(photo.token, safeFmt) : null;
    if (!safeFmt || !dest) { req.resume(); return res.status(400).json({ error:'invalid-format' }); }
    const key = `${photo.id}:adaptive-${safeFmt}`;
    if (adminPhotoFullWrites.has(String(photo.id)) || adminPhotoVariantWrites.has(key)) {
      req.resume();
      return res.status(409).json({ error:'variant-busy' });
    }
    adminPhotoVariantWrites.add(key);
    let released = false;
    const release = () => { if (!released) { released = true; adminPhotoVariantWrites.delete(key); } };
    res.once('finish', release);
    res.once('close', release);
    const tmp = dest + '.upload-' + crypto.randomBytes(6).toString('hex');
    streamToFileBounded(req, res, tmp, maxBytes, (size) => {
      const before = JSON.parse(JSON.stringify(photo));
      let backup = null;
      try {
        try {
          if (fs.statSync(dest).isFile()) {
            backup = dest + '.backup-' + crypto.randomBytes(6).toString('hex');
            fs.renameSync(dest, backup);
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        fs.renameSync(tmp, dest);
        const dims = imageDimensions(dest);
        const prefix = safeFmt === 'webp' ? 'adaptiveWebp' : 'adaptiveAvif';
        photo[prefix] = true;
        photo[prefix + 'Size'] = size;
        if (dims && dims.w > 0 && dims.h > 0) { photo[prefix + 'W'] = dims.w; photo[prefix + 'H'] = dims.h; }
        else { delete photo[prefix + 'W']; delete photo[prefix + 'H']; }
        bumpPhotoCacheRevision(photo);
        addPhotoEditHistory(photo, 'variant', ['adaptive-' + safeFmt], { variant:safeFmt, w:dims && dims.w || null, h:dims && dims.h || null, size });
        if (!persistNow()) {
          restorePlainObject(photo, before);
          try { fs.unlinkSync(dest); } catch (_) {}
          if (backup) { try { fs.renameSync(backup, dest); } catch (_) {} }
          return res.status(503).json({ error:'write-error', persisted:false });
        }
        if (backup) { try { fs.unlinkSync(backup); } catch (e) { console.error('[photo-adaptive] old variant cleanup failed:', e && e.message); } }
        res.json({ ok:true, persisted:true, bytes:size, w:dims && dims.w || null, h:dims && dims.h || null, revision:photoCacheRevision(photo) });
      } catch (_) {
        restorePlainObject(photo, before);
        try { fs.unlinkSync(tmp); } catch (_) {}
        try { fs.unlinkSync(dest); } catch (_) {}
        if (backup) { try { fs.renameSync(backup, dest); } catch (_) {} }
        if (!res.headersSent) res.status(500).json({ error:'adaptive-failed' });
      }
    });
  }

  function photoLastPublicViewAt(photo) {
    const ps = photoStatsOf(photo);
    return Math.max(Number(ps.full.lastAt) || 0, Number(ps.thumb.lastAt) || 0, Number(ps.micro.lastAt) || 0, Number(photo.createdAt) || 0);
  }

  function photoManagedBytes(photo) {
    const paths = [
      ...photoOriginalPaths(photo), ...photoVariantPaths(photo.token, 'thumb'), ...photoVariantPaths(photo.token, 'micro'),
      photoAdaptivePath(photo.token, 'webp'), photoAdaptivePath(photo.token, 'avif'),
    ];
    const seen = new Set();
    let total = 0;
    for (const file of paths) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      try { const st = fs.statSync(file); if (st.isFile()) total += Math.max(0, Number(st.size) || 0); } catch (_) {}
    }
    const versionsDir = photoVersionDir(photo && photo.token);
    if (versionsDir) {
      const stack = [versionsDir];
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch (_) { continue; }
        for (const ent of entries) {
          const child = path.join(dir, ent.name);
          try {
            if (ent.isDirectory()) stack.push(child);
            else if (ent.isFile()) total += Math.max(0, Number(fs.statSync(child).size) || 0);
          } catch (_) {}
        }
      }
    }
    return total;
  }

  async function detailedPhotoRecentViews(share, limit = 50) {
    const ps = photoStatsOf(share);
    const recentSource = (Array.isArray(ps.recent) ? ps.recent : []).slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));
    const geoPromises = new Map();
    return Promise.all(recentSource.map(async (v) => {
      let country = v.country || null;
      let countryCode = v.countryCode || null;
      let flag = v.flag || null;
      if (v.ipFull && v.ip && (!country || !flag)) {
        const geoKey = String(v.ip).replace(/^::ffff:/i, '');
        let pending = geoPromises.get(geoKey);
        if (!pending) {
          pending = Promise.resolve(geoSync(geoKey) || geolocate(geoKey)).catch(() => null);
          geoPromises.set(geoKey, pending);
        }
        const resolved = await pending;
        if (resolved) {
          country = country || resolved.country || null;
          countryCode = countryCode || resolved.countryCode || null;
          flag = flag || resolved.flag || null;
        }
      }
      return {
        at:Number(v.at) || 0,
        kind:['full','thumb','micro'].includes(v.kind) ? v.kind : 'full',
        ip:v.ip ? (v.ipFull ? pubIp(v.ip) : v.ip) : null,
        country, countryCode,
        flag:flag || (countryCode ? flagFromCode(countryCode) : null),
      };
    }));
  }

  function pwaPhotoPayload(req, share) {
    const ib = getSettings().imageBase || primaryBase(req) || '';
    const stats = photoStatsOf(share);
    let changed = false;
    const readDims = (wKey, hKey, paths) => {
      let w = Math.max(0, Number(share[wKey]) || 0);
      let h = Math.max(0, Number(share[hKey]) || 0);
      if (!w || !h) {
        const file = firstExistingPhotoFile(paths);
        const dims = file ? imageDimensions(file) : null;
        if (dims && dims.w > 0 && dims.h > 0) {
          w = dims.w; h = dims.h; share[wKey] = w; share[hKey] = h; changed = true;
        }
      }
      return { w:w || null, h:h || null };
    };
    const readBytes = (sizeKey, paths) => {
      let bytes = Math.max(0, Number(share[sizeKey]) || 0);
      if (!bytes) {
        const file = firstExistingPhotoFile(paths);
        try { if (file) bytes = Math.max(0, fs.statSync(file).size || 0); } catch (_) {}
        if (bytes) { share[sizeKey] = bytes; changed = true; }
      }
      return bytes || null;
    };
    const readVariantMeta = (kind, wKey, hKey, sizeKey, mtimeKey, paths) => {
      const file = firstExistingPhotoFile(paths);
      if (!file) return { w:null, h:null, bytes:null };
      let stat = null;
      try { stat = fs.statSync(file); } catch (_) {}
      const diskBytes = stat ? Math.max(0, Number(stat.size) || 0) : 0;
      const diskMtime = stat ? Math.max(0, Math.floor(Number(stat.mtimeMs) || 0)) : 0;
      let w = Math.max(0, Number(share[wKey]) || 0);
      let h = Math.max(0, Number(share[hKey]) || 0);
      let bytes = Math.max(0, Number(share[sizeKey]) || 0);
      const knownMtime = Math.max(0, Number(share[mtimeKey]) || 0);
      const stale = !w || !h || !knownMtime || (diskMtime && knownMtime !== diskMtime) || (diskBytes && bytes !== diskBytes);
      if (stale) {
        const dims = imageDimensions(file);
        if (dims && dims.w > 0 && dims.h > 0) { w = dims.w; h = dims.h; share[wKey] = w; share[hKey] = h; }
        if (diskBytes) { bytes = diskBytes; share[sizeKey] = bytes; }
        if (diskMtime) share[mtimeKey] = diskMtime;
        changed = true;
      }
      return { w:w || null, h:h || null, bytes:bytes || null };
    };
    const fullPaths = photoOriginalPaths(share);
    const thumbPaths = photoVariantPaths(share.token, 'thumb');
    const microPaths = photoVariantPaths(share.token, 'micro');
    const full = readDims('w', 'h', fullPaths);
    const fullBytes = readBytes('size', fullPaths);
    const thumbMeta = readVariantMeta('thumb', 'thumbW', 'thumbH', 'thumbSize', 'thumbMetaMtimeMs', thumbPaths);
    const microMeta = readVariantMeta('micro', 'microW', 'microH', 'microSize', 'microMetaMtimeMs', microPaths);
    const uniqueVisitors = new Set();
    for (const variant of [stats.full, stats.thumb, stats.micro]) {
      if (variant && Array.isArray(variant.u)) for (const ip of variant.u) uniqueVisitors.add(ip);
    }
    const totalViews = (stats.full.v || 0) + (stats.thumb.v || 0) + (stats.micro.v || 0);
    if (changed) scheduleFlush();
    const now = Date.now();
    const active = isActive(share, now);
    const effectiveExpiresAt = shareEffectiveExpiry(share);
    const expired = !!effectiveExpiresAt && now > effectiveExpiresAt;
    const rev = photoCacheRevision(share);
    const qv = '?v=' + encodeURIComponent(rev);
    return {
      token:share.token, name:share.name, createdAt:share.createdAt || 0,
      expiresAt:share.expiresAt || null, effectiveExpiresAt:effectiveExpiresAt || null,
      active, expired, disabled:!!share.disabled,
      status:active ? 'active' : expired ? 'expired' : share.disabled ? 'disabled' : 'inactive',
      imgUrl:ib + '/i/' + share.token + '.' + photoExt(share) + qv,
      thumbUrl:ib + '/i/' + share.token + '/thumb' + qv,
      microUrl:ib + '/i/' + share.token + '/micro' + qv,
      favorite:!!share.favorite, tags:Array.isArray(share.tags) ? share.tags.slice(0,20) : [],
      note:share.adminNote || '', clientHash:share.clientHash || null,
      maxViews:Math.max(0, Number(share.maxViews) || 0), hasPassword:!!share.pwHash,
      hotlinkHosts:Object.prototype.hasOwnProperty.call(share, 'hotlinkHosts') && Array.isArray(share.hotlinkHosts) ? share.hotlinkHosts.slice(0,50) : null,
      notifyFirstView:!!share.notifyFirstView, firstViewNotifiedAt:share.firstViewNotifiedAt || null,
      retentionReason:share.retentionReason || null, metadataRemoved:!!share.metadataRemoved,
      autoUrl:ib + '/i/' + share.token + '/auto' + qv,
      previewUrls:{
        auto:'/app/image/' + encodeURIComponent(share.token) + '/preview/auto' + qv,
        full:'/app/image/' + encodeURIComponent(share.token) + '/preview/full' + qv,
        thumb:'/app/image/' + encodeURIComponent(share.token) + '/preview/thumb' + qv,
        micro:'/app/image/' + encodeURIComponent(share.token) + '/preview/micro' + qv,
      },
      adaptive:{ webp:!!share.adaptiveWebp, avif:!!share.adaptiveAvif },
      cacheRevision:rev,
      versionCount:Array.isArray(share.versions) ? share.versions.length : 0,
      editHistoryCount:Array.isArray(share.editHistory) ? share.editHistory.length : 0,
      totals:{ views:totalViews, visitors:uniqueVisitors.size, bytes:(fullBytes || 0) + (thumbMeta.bytes || 0) + (microMeta.bytes || 0) },
      variants:{
        full:{ ...full, bytes:fullBytes, ready:true, views:stats.full.v || 0, visitors:Array.isArray(stats.full.u) ? stats.full.u.length : 0 },
        thumb:{ w:thumbMeta.w, h:thumbMeta.h, bytes:thumbMeta.bytes, ready:!!share.thumb, views:stats.thumb.v || 0, visitors:Array.isArray(stats.thumb.u) ? stats.thumb.u.length : 0 },
        micro:{ w:microMeta.w, h:microMeta.h, bytes:microMeta.bytes, ready:!!share.micro, views:stats.micro.v || 0, visitors:Array.isArray(stats.micro.u) ? stats.micro.u.length : 0 },
      },
    };
  }

  function pwaImageInventoryForRequest(req, { includeInactive = false } = {}) {
    return listShares()
      .filter((share) => share && share.type === 'photo' && canManagePwaImage(req, share) && (includeInactive || isActive(share)))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function pwaImagesForRequest(req, { limit = 200, offset = 0, includeInactive = false } = {}) {
    const boundedLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 200));
    const boundedOffset = Math.max(0, Math.min(50000, parseInt(offset, 10) || 0));
    const inventory = pwaImageInventoryForRequest(req, { includeInactive });
    return inventory.slice(boundedOffset, boundedOffset + boundedLimit).map((share) => pwaPhotoPayload(req, share));
  }

  async function photoDimensions(photo) {
    const full = { w:photo.w || null, h:photo.h || null, size:photo.size || null };
    let changed = false;
    try {
      let abs = firstExistingPhotoFile(photoOriginalPaths(photo));
      if (!abs && photo.hostPath) {
        abs = hostToContainer(photo.hostPath);
        await assertRealWithin(HOST_ROOT, abs);
      }
      if (abs && !(photo.w && photo.h)) {
        const dim = imageDimensions(abs);
        if (dim && dim.w > 0 && dim.h > 0) {
          photo.w = dim.w; photo.h = dim.h; full.w = dim.w; full.h = dim.h; changed = true;
        }
      }
      if (!full.size && abs) {
        try { full.size = fs.statSync(abs).size; } catch (_) {}
      }
    } catch (_) {}
    const variantMeta = (variant, present) => {
      if (!present) return null;
      const file = firstExistingPhotoFile(photoVariantPaths(photo.token, variant));
      if (!file) return null;
      let size = null;
      try { size = fs.statSync(file).size; } catch (_) {}
      const dim = imageDimensions(file);
      return { w:dim && dim.w || null, h:dim && dim.h || null, size };
    };
    if (changed) scheduleFlush();
    return {
      w:full.w, h:full.h, full,
      thumb:variantMeta('thumb', photo.thumb),
      micro:variantMeta('micro', photo.micro),
    };
  }

  async function photoMetadata(photo) {
    let file = firstExistingPhotoFile(photoOriginalPaths(photo));
    if (!file && photo.hostPath) {
      try {
        file = hostToContainer(photo.hostPath);
        await assertRealWithin(HOST_ROOT, file);
      } catch (_) { file = null; }
    }
    if (!file) return null;
    return readPhotoMetadata(file);
  }

  function clearRuntimeState() {
    adminPhotoVariantWrites.clear();
    adminPhotoFullWrites.clear();
    managedPhotoHashLocks.clear();
    photoDuplicateCaches.clear();
  }

  return {
    photoHistoryCount,
    normalizePhotoHistory,
    canSeePhotoHistory,
    visiblePhotoHistory,
    photoHistoryMeta,
    uniquePhotoPaths,
    safeManagedImageName,
    safePhotoToken,
    photoOriginalPaths,
    photoAdaptivePath,
    photoVersionDir,
    photoVariantPaths,
    firstExistingPhotoFile,
    unlinkPhotoFiles,
    copyPhotoFile,
    copyFirstExistingPhotoFile,
    newStoredImageName,
    copyHostPhotoToStore,
    photoHistoryPreviewPath,
    photoHistoryPreviewPaths,
    deletePhotoHistoryPreview,
    stagePhotoHistoryPreviewRemoval,
    archiveRevokedPhoto,
    migrateLegacyPhotoStorage,
    photoStatsOf,
    localDayKey,
    localDayKeys,
    ensurePhotoDailyViews,
    notePhotoDailyView,
    photoVisitorSet,
    notePhotoView,
    hashFileSha256,
    analyzePhotoDuplicates,
    estimateImageOptimization,
    validSha256,
    acquireManagedPhotoHashResponseLock,
    managedPhotoCandidates,
    findManagedPhotoDuplicate,
    duplicatePhotoPayload,
    findManagedPhotoDuplicateDeep,
    streamToFileBounded,
    photoCacheRevision,
    bumpPhotoCacheRevision,
    cleanPhotoEditOperations,
    addPhotoEditHistory,
    ensurePhotoOriginalVersionMarker,
    archiveCurrentPhotoVersion,
    cleanupPhotoVersionStorage,
    restorePhotoVersion,
    adminPhotoVariantWrites,
    adminPhotoFullWrites,
    adminPhotoHasVariantWrite,
    handleAdminPhotoVariantUpload,
    handlePhotoAdaptiveUpload,
    photoLastPublicViewAt,
    photoManagedBytes,
    detailedPhotoRecentViews,
    pwaPhotoPayload,
    pwaImageInventoryForRequest,
    pwaImagesForRequest,
    photoDimensions,
    photoMetadata,
    photoDashboardQueryOptions,
    photoMatchesDashboardFilters,
    clearRuntimeState,
    getConstants() {
      return { PHOTO_DAILY_VIEW_DAYS, PHOTO_UNIQUE_VISITOR_MAX, PHOTO_HISTORY_MAX, DAY_MS };
    },
  };
}

module.exports = { createPhotoService };
