'use strict';

/**
 * PWA photo/album domain: ownership checks, image settings, albums, automatic
 * retention and the PWA image bootstrap payload. Low-level file/variant storage
 * remains in photo-service.js.
 */
function createPwaPhotoService(deps = {}) {
  const {
    getState, scheduleFlush, pwaDeviceCreatorAccount, pwaDeviceOwnerAccount, pwaDevices,
    stampPwaRecordOwner, normUsername, pwaPhotoPayload, getByToken, parseExpiry,
    makeSharePassword, parseHotlinkHosts, normalizeTags, getSettings, primaryBase,
    isActive, listShares, photoStatsOf, DAY_MS, photoLastPublicViewAt, photoManagedBytes,
    destroyShareManagedData, detachActiveShare, logAudit, persistNow, scheduleSearchReindex,
    dlpEffectiveAction, pwaImagesForRequest,
  } = deps;
  if (typeof getState !== 'function') throw new TypeError('pwa-photo-service requires getState');
  const state = new Proxy(Object.create(null), {
    get(_target, key) { const root = getState(); return root ? root[key] : undefined; },
    set(_target, key, value) { const root = getState(); if (!root) throw new Error('pwa-photo-state-unavailable'); root[key] = value; return true; },
  });
  const PWA_IMG_EXT = /^(jpg|png|gif|webp|bmp|avif)$/;
  let retentionInterval = null;
  let retentionStartupTimer = null;
function pwaImgOwner(req, share) { return stampPwaRecordOwner(req, share); }

function pwaDeviceCanManageRecord(device, share) {
  if (!device || !share) return false;
  const creator = pwaDeviceCreatorAccount(device);
  if (share.ownerDeviceId && share.ownerDeviceId === device.id) {
    if (!share.ownerId && creator) {
      share.ownerId = creator.id;
      if (!share.ownerName || share.ownerName === 'PWA') share.ownerName = creator.username || share.ownerName;
      scheduleFlush();
    }
    return true;
  }

  // The account, not a disposable browser cookie, is the durable ownership root.
  // A replacement PWA credential issued to the same account therefore inherits
  // the records of its previous credential and self-heals their legacy ownerId.
  if (creator && share.ownerDeviceId) {
    const previousOwner = pwaDeviceOwnerAccount(share.ownerDeviceId);
    if (previousOwner && previousOwner.id === creator.id) {
      if (!share.ownerId) {
        share.ownerId = creator.id;
        if (!share.ownerName || share.ownerName === 'PWA') share.ownerName = creator.username || share.ownerName;
        scheduleFlush();
      }
      return true;
    }
  }
  if (creator && share.ownerId && share.ownerId === creator.id) return true;
  const creatorName = normUsername((creator && creator.username) || device.createdBy || '');
  if (creatorName && share.ownerName && normUsername(share.ownerName) === creatorName) return true;

  // Very old photo records predate both ownerId and ownerDeviceId. They were
  // globally manageable before account scoping existed; preserve that behavior
  // only for devices paired by an owner/admin, never for an operator device.
  if (!share.ownerId && !share.ownerDeviceId && creator && (creator.role === 'owner' || creator.role === 'admin')) return true;
  return false;
}

function pwaViewerIsAdmin(req) {
  const session = req.pwaSession;
  if (session && (session.role === 'owner' || session.role === 'admin')) return true;
  const creator = req.pwaDevice ? pwaDeviceCreatorAccount(req.pwaDevice) : null;
  return !!(creator && (creator.role === 'owner' || creator.role === 'admin'));
}

function canManagePwaImage(req, share) {
  const session = req.pwaSession;
  if (session && (session.role === 'owner' || session.role === 'admin')) return true;
  if (session && session.role === 'operator' && share.ownerId === session.accountId) return true;
  if (pwaDeviceCanManageRecord(req.pwaDevice, share)) return true;
  // A device paired by an owner/admin account manages every link like the web admin
  // (reception, share and image links), including ones created on the standard version.
  const creator = req.pwaDevice ? pwaDeviceCreatorAccount(req.pwaDevice) : null;
  return !!(creator && (creator.role === 'owner' || creator.role === 'admin'));
}

function pwaImageCreatePayload(req, rec) {
  return pwaPhotoPayload(req, rec);
}

function pwaPhotoByToken(req, token) {
  const share = getByToken(String(token || ''));
  return share && share.type === 'photo' && canManagePwaImage(req, share) ? share : null;
}

async function applyPwaPhotoSettings(share, body) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const changed = [];
  if (body.name !== undefined) {
    const name = String(body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120);
    if (name && name !== share.name) { share.name = name; changed.push('name'); }
  }
  if (body.expiresInSeconds !== undefined) {
    share.expiresAt = parseExpiry(body.expiresInSeconds);
    delete share.expiryWarnedAt;
    changed.push('expiry');
  }
  if (body.maxViews !== undefined) {
    const n = Math.max(0, Math.min(1000000000, Math.floor(Number(body.maxViews) || 0)));
    if (n) share.maxViews = n; else delete share.maxViews;
    changed.push('maxViews');
  }
  if (typeof body.password === 'string') {
    if (body.password) { const protectedShare = await makeSharePassword(body.password.slice(0, 256)); if (protectedShare.error) return { changed, error: protectedShare.error }; Object.assign(share, protectedShare); }
    else { delete share.pwHash; delete share.pwSalt; }
    changed.push(body.password ? 'password-set' : 'password-cleared');
  }
  if (body.hotlinkHosts !== undefined) {
    share.hotlinkHosts = parseHotlinkHosts(body.hotlinkHosts); // explicit [] disables protection for this image
    changed.push(share.hotlinkHosts.length ? 'hotlink-protected' : 'hotlink-off');
  }
  if (typeof body.notifyFirstView === 'boolean') {
    const was = !!share.notifyFirstView;
    if (body.notifyFirstView) share.notifyFirstView = true; else delete share.notifyFirstView;
    if (body.notifyFirstView && !was) {
      delete share.firstViewNotifiedAt; delete share.firstViewKind; delete share.firstViewIp;
      delete share.firstViewPushPending; delete share.firstViewPushQueuedAt;
    } else if (!body.notifyFirstView) {
      delete share.firstViewPushPending;
    }
    changed.push(body.notifyFirstView ? 'first-view-notify-on' : 'first-view-notify-off');
  }
  if (Array.isArray(body.tags) || typeof body.tags === 'string') {
    const tags = normalizeTags(body.tags);
    if (tags.length) share.tags = tags; else delete share.tags;
    changed.push('tags');
  }
  if (typeof body.note === 'string') {
    const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 1000);
    if (note) share.adminNote = note; else delete share.adminNote;
    changed.push('note');
  }
  if (typeof body.favorite === 'boolean') {
    if (body.favorite) share.favorite = true; else delete share.favorite;
    changed.push(body.favorite ? 'favorite' : 'unfavorite');
  }
  if (typeof body.disabled === 'boolean') {
    if (body.disabled) share.disabled = true; else delete share.disabled;
    changed.push(body.disabled ? 'disabled' : 'enabled');
  }
  return { changed, error: null };
}

function canManagePwaAlbum(req, album) {
  if (!album || album.type !== 'album') return false;
  const session = req.pwaSession;
  if (session && (session.role === 'owner' || session.role === 'admin')) return true;
  if (session && session.role === 'operator' && album.ownerId === session.accountId) return true;
  return pwaDeviceCanManageRecord(req.pwaDevice, album);
}

function pwaAlbumPayload(req, album) {
  const base = getSettings().imageBase || primaryBase(req) || '';
  const members = (Array.isArray(album.members) ? album.members : []).map((token) => getByToken(token)).filter((s) => s && s.type === 'photo');
  return {
    token: album.token,
    name: album.name,
    createdAt: album.createdAt || 0,
    expiresAt: album.expiresAt || null,
    active: isActive(album),
    count: members.length,
    url: base + '/g/' + album.token,
    views: Number(album.views) || 0,
    hasPassword: !!album.pwHash,
    tags: Array.isArray(album.tags) ? album.tags.slice(0, 20) : [],
    note: album.adminNote || '',
    collaboration: {
      invitations: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && (!x.expiresAt || x.expiresAt > Date.now())).length : 0,
      readers: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && x.role === 'reader').length : 0,
      contributors: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && x.role === 'contributor').length : 0,
      managers: Array.isArray(album.collaborators) ? album.collaborators.filter((x) => x && !x.disabled && x.role === 'manager').length : 0,
    },
  };
}

function publicAlbumInvite(entry) {
  return { id: entry.id, label: entry.label || '', role: entry.role, createdAt: entry.createdAt, expiresAt: entry.expiresAt || null, maxFiles: entry.maxFiles || 0, maxFileBytes: entry.maxFileBytes || 0, usedFiles: entry.usedFiles || 0, disabled: !!entry.disabled };
}

function pwaRetentionRuleStore() {
  if (!state.meta || typeof state.meta !== 'object' || Array.isArray(state.meta)) state.meta = {};
  if (!state.meta.pwaImageRetentionRules || typeof state.meta.pwaImageRetentionRules !== 'object') state.meta.pwaImageRetentionRules = {};
  return state.meta.pwaImageRetentionRules;
}

function primaryPwaOwnerKey(req) {
  // Prefer the signed-in account. PWA-created images are account-owned (ownerId is
  // set — see stampPwaRecordOwner), so retention rules must use the same account
  // key or they would never match the photos.
  if (req.pwaSession && req.pwaSession.accountId) return 'acc:' + req.pwaSession.accountId;
  if (req.pwaDevice) {
    // A paired device's images are ALSO account-owned (ownerId = the account that
    // paired it). Resolve that same account key here so that in the common
    // device-only state (admin session expired, device still paired) retention
    // keeps matching the device's images instead of silently targeting an empty
    // 'dev:<id>' scope. Fall back to the device key only for an unlinked device.
    const creator = pwaDeviceCreatorAccount(req.pwaDevice);
    if (creator && creator.id) return 'acc:' + creator.id;
    if (req.pwaDevice.id) return 'dev:' + req.pwaDevice.id;
  }
  return null;
}

function ownerKeyForPhoto(photo) {
  if (photo && photo.ownerId) return 'acc:' + photo.ownerId;
  // Legacy photos may carry only a device id (ownerId not yet self-healed). Resolve
  // the device's owning account so they map to the same key as their retention
  // rules; keep the device key for a device with no owning account.
  if (photo && photo.ownerDeviceId) {
    const device = pwaDevices().find((d) => d.id === photo.ownerDeviceId);
    const creator = device && pwaDeviceCreatorAccount(device);
    if (creator && creator.id) return 'acc:' + creator.id;
    return 'dev:' + photo.ownerDeviceId;
  }
  return null;
}

function normalizePwaRetentionRules(input) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    enabled: !!b.enabled,
    maxAgeDays: Math.max(0, Math.min(3650, Number(b.maxAgeDays) || 0)),
    inactiveDays: Math.max(0, Math.min(3650, Number(b.inactiveDays) || 0)),
    maxViews: Math.max(0, Math.min(1000000000, Math.floor(Number(b.maxViews) || 0))),
    maxStorageMB: Math.max(0, Math.min(1048576, Number(b.maxStorageMB) || 0)),
  };
}

async function runPwaImageRetentionForOwner(ownerKey, rules, now = Date.now()) {
  rules = normalizePwaRetentionRules(rules);
  if (!ownerKey || !rules.enabled) return { checked: 0, revoked: 0, bytesFreed: 0, reasons: {} };
  const photos = listShares().filter((s) => s && s.type === 'photo' && !s.revoked && ownerKeyForPhoto(s) === ownerKey);
  const revoke = new Map();
  const totalViews = (photo) => { const ps = photoStatsOf(photo); return (Number(ps.full.v) || 0) + (Number(ps.thumb.v) || 0) + (Number(ps.micro.v) || 0); };
  const ageMs = rules.maxAgeDays * DAY_MS;
  const inactiveMs = rules.inactiveDays * DAY_MS;
  for (const photo of photos) {
    if (ageMs && now - (Number(photo.createdAt) || now) >= ageMs) revoke.set(photo.id, 'age');
    else if (inactiveMs && now - photoLastPublicViewAt(photo) >= inactiveMs) revoke.set(photo.id, 'inactive');
    else if (rules.maxViews && totalViews(photo) >= rules.maxViews) revoke.set(photo.id, 'views');
  }
  if (rules.maxStorageMB > 0) {
    const cap = rules.maxStorageMB * 1024 * 1024;
    const live = photos.filter((p) => !revoke.has(p.id)).map((p) => ({ photo: p, bytes: photoManagedBytes(p), lastAt: photoLastPublicViewAt(p) }));
    let used = live.reduce((n, x) => n + x.bytes, 0);
    live.sort((a, b) => a.lastAt - b.lastAt || (a.photo.createdAt || 0) - (b.photo.createdAt || 0));
    for (const item of live) {
      if (used <= cap) break;
      revoke.set(item.photo.id, 'storage'); used -= item.bytes;
    }
  }
  let revoked = 0, bytesFreed = 0; const reasons = {};
  for (const photo of photos) {
    const reason = revoke.get(photo.id); if (!reason) continue;
    const bytes = photoManagedBytes(photo);
    photo.retentionReason = reason; photo.retentionRevokedAt = now;
    try {
      await destroyShareManagedData(photo);
    } catch (e) {
      console.error('[pwa-image-retention] purge failed:', photo.id, e && e.message);
      continue; // keep the active record so a later pass can retry safely
    }
    if (detachActiveShare(photo)) {
      revoked += 1; bytesFreed += bytes; reasons[reason] = (reasons[reason] || 0) + 1;
      logAudit('image-retention-revoked', { username: 'system', detail: `${photo.name || photo.token} · ${reason}` });
    }
  }
  let persisted = true;
  if (revoked) {
    persisted = persistNow();
    if (persisted) { try { scheduleSearchReindex(); } catch (_) {} }
    else console.error('[pwa-image-retention] durable store write failed after managed-data purge; retry scheduled');
  }
  return { checked: photos.length, revoked, bytesFreed, reasons, persisted };
}

async function runAllPwaImageRetention() {
  const store = pwaRetentionRuleStore();
  for (const [ownerKey, rules] of Object.entries(store)) {
    try { await runPwaImageRetentionForOwner(ownerKey, rules); } catch (e) { console.error('[pwa-image-retention]', ownerKey, e.message); }
  }
}

function pwaCanManageHostShare(req, share) {
  if (!share || !['file','folder','collab','web-storage'].includes(share.type)) return false;
  return canManagePwaImage(req, share);
}

function pwaDlpPolicyPayload(req) {
  const settings = getSettings();
  return {
    enabled: settings.dlpEnabled !== false,
    mode: ['warn','block','log','quarantine'].includes(settings.dlpMode) ? settings.dlpMode : 'warn',
    rulesEnabled: settings.dlpRulesEnabled === true,
    actions: {
      low: dlpEffectiveAction({ ...settings, dlpRulesEnabled:true, dlpActionLow:settings.dlpActionLow || 'log' }, { count:1, highest:'low' }),
      medium: dlpEffectiveAction({ ...settings, dlpRulesEnabled:true, dlpActionMedium:settings.dlpActionMedium || 'warn' }, { count:1, highest:'medium' }),
      high: dlpEffectiveAction({ ...settings, dlpRulesEnabled:true, dlpActionHigh:settings.dlpActionHigh || 'quarantine' }, { count:1, highest:'high' }),
      critical: dlpEffectiveAction({ ...settings, dlpRulesEnabled:true, dlpActionCritical:settings.dlpActionCritical || 'block' }, { count:1, highest:'critical' }),
    },
    maxFiles: Math.max(1, Number(settings.dlpMaxFiles) || 100),
    maxFileMB: Math.max(1, Number(settings.dlpMaxFileMB) || 25),
    scanOcr: settings.dlpScanOcr !== false,
    // Editing the global DLP policy is deliberately limited to an owner/admin
    // principal. A paired device belonging to that account is treated the same
    // way as the other administrator-only PWA management surfaces.
    editable: pwaViewerIsAdmin(req),
  };
}

function pwaImageBootstrapMarkup(req) {
  const payload = JSON.stringify({ images: pwaImagesForRequest(req, { limit: 500, includeInactive: true }) });
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  return `<template id="dx-image-bootstrap" data-encoding="base64">${encoded}</template>`;
}

  function startRetentionScheduler() {
    let createdInterval = null;
    let createdStartupTimer = null;
    try {
      if (!retentionInterval) {
        createdInterval = setInterval(() => { runAllPwaImageRetention().catch((e) => console.error('[pwa-image-retention]', e.message)); }, 5 * 60 * 1000);
        retentionInterval = createdInterval;
        if (retentionInterval && typeof retentionInterval.unref === 'function') retentionInterval.unref();
      }
      if (!retentionStartupTimer) {
        createdStartupTimer = setTimeout(() => {
          retentionStartupTimer = null;
          runAllPwaImageRetention().catch((e) => console.error('[pwa-image-retention]', e.message));
        }, 30 * 1000);
        retentionStartupTimer = createdStartupTimer;
        if (retentionStartupTimer && typeof retentionStartupTimer.unref === 'function') retentionStartupTimer.unref();
      }
    } catch (error) {
      // Timer creation can fail under resource pressure. A failed first start must
      // not leak the interval that was already created, otherwise a bootstrap retry
      // would leave an orphaned retention worker running outside lifecycle ownership.
      if (createdStartupTimer) {
        try { clearTimeout(createdStartupTimer); } catch (_) {}
        if (retentionStartupTimer === createdStartupTimer) retentionStartupTimer = null;
      }
      if (createdInterval) {
        try { clearInterval(createdInterval); } catch (_) {}
        if (retentionInterval === createdInterval) retentionInterval = null;
      }
      throw error;
    }
  }
  function stopRetentionScheduler() {
    if (retentionInterval) clearInterval(retentionInterval);
    if (retentionStartupTimer) clearTimeout(retentionStartupTimer);
    retentionInterval = null;
    retentionStartupTimer = null;
  }
  return {
    PWA_IMG_EXT,
    pwaImgOwner, pwaDeviceCanManageRecord, pwaViewerIsAdmin, canManagePwaImage,
    pwaImageCreatePayload, pwaPhotoByToken, applyPwaPhotoSettings, canManagePwaAlbum,
    pwaAlbumPayload, publicAlbumInvite, pwaRetentionRuleStore, primaryPwaOwnerKey,
    ownerKeyForPhoto, normalizePwaRetentionRules, runPwaImageRetentionForOwner,
    runAllPwaImageRetention, pwaCanManageHostShare, pwaDlpPolicyPayload,
    pwaImageBootstrapMarkup, startRetentionScheduler, stopRetentionScheduler,
  };
}

module.exports = { createPwaPhotoService };
