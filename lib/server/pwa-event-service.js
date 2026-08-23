'use strict';

/**
 * PWA event/SSE domain: owner scopes, live EventSource fan-out, activity and
 * transfer visibility, presence validation and received-file inventory.
 */
function createPwaEventService(deps = {}) {
  const {
    APP_NAME, fs, path, INBOX_DIR, resolveWithin, getAccountById, findAccountByName,
    scheduleFlush, pwaDeviceCreatorAccount, pwaDeviceOwnerAccount, pwaDeviceResolvedAccount,
    pwaDevices, presenceSessionValidator, logAudit, clientIp, sendPwaPush,
    getById, trashItems, pwaViewerIsAdmin, canManagePwaImage, getActiveTransfers, listTransfers,
  } = deps;
  const inboxEventSubs = new Map();
  const activeTransfers = {
    values() { const map = getActiveTransfers(); return map && typeof map.values === 'function' ? map.values() : [][Symbol.iterator](); },
    get(id) { const map = getActiveTransfers(); return map && typeof map.get === 'function' ? map.get(id) : undefined; },
  };
function pwaActivityActor(req) {
  return (req && req.pwaSession && req.pwaSession.username) || (req && req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
}

function activityPrincipal(req) {
  return {
    actor: pwaActivityActor(req),
    accountId: (req && req.pwaSession && req.pwaSession.accountId) || null,
    deviceId: (req && req.pwaDevice && req.pwaDevice.id) || null,
  };
}

function pwaAuditReq(req, action, detail) {
  const account = req && req.pwaSession && req.pwaSession.accountId ? getAccountById(req.pwaSession.accountId)
    : (req && req.pwaDevice ? pwaDeviceCreatorAccount(req.pwaDevice) : null);
  return logAudit(action, { account, username:pwaActivityActor(req), ip:clientIp(req), detail });
}

function pwaPresenceScope(req) {
  const session = req.pwaSession;
  if (session && (session.role === 'owner' || session.role === 'admin' || session.role === 'auditor')) {
    return { seeAll: true, accountId: session.accountId || null };
  }
  if (session && session.role === 'operator' && session.accountId) {
    return { seeAll: false, accountId: session.accountId };
  }
  const creator = req.pwaDevice ? pwaDeviceCreatorAccount(req.pwaDevice) : null;
  if (creator && (creator.role === 'owner' || creator.role === 'admin')) {
    return { seeAll: true, accountId: creator.id || null };
  }
  if (creator && creator.role === 'operator') {
    return { seeAll: false, accountId: creator.id || null };
  }
  return null;
}

function pwaOwnerKeys(req) {
  const k = [];
  if (req.pwaDevice && req.pwaDevice.id) k.push('dev:' + req.pwaDevice.id);
  if (req.pwaSession && req.pwaSession.accountId) k.push('acc:' + req.pwaSession.accountId);
  return k;
}

function shareOwnerAccount(s) {
  if (!s) return null;
  let account = s.ownerId ? getAccountById(String(s.ownerId)) : null;
  // Legacy image records can predate durable ownerId stamping. The PWA already
  // allows those records to be managed through their ownerName/device ancestry;
  // Push routing must resolve ownership the same way or an image can look armed
  // while having zero eligible notification targets.
  if (!account && !s.ownerId && s.ownerDeviceId) account = pwaDeviceOwnerAccount(s.ownerDeviceId);
  if (!account && !s.ownerId && s.ownerName) account = findAccountByName(s.ownerName);
  if (account && !s.ownerId) {
    s.ownerId = account.id;
    if (!s.ownerName) s.ownerName = account.username || null;
    scheduleFlush();
  }
  return account;
}

function ownerKeysForShare(s) {
  const k = [];
  if (s && s.ownerDeviceId) k.push('dev:' + s.ownerDeviceId);
  const account = shareOwnerAccount(s);
  if (account && account.id) {
    const accountId = String(account.id);
    k.push('acc:' + accountId);
    // A photo/reception created from the standard admin UI is account-owned and
    // therefore has no ownerDeviceId. Push subscriptions created by an installed
    // PWA, however, are normally scoped to dev:<device-id>. Fan account-owned
    // events out to the active PWA devices delegated by that same account so the
    // mobile app receives first-view/inbox notifications for standard-created
    // links too. Legacy devices without createdByAccountId are resolved through
    // their stored creator name by pwaDeviceCreatorAccount().
    for (const device of pwaDevices()) {
      if (!device || !device.id || device.sessionLockedAt) continue;
      const creator = pwaDeviceCreatorAccount(device);
      if (creator && String(creator.id) === accountId) k.push('dev:' + device.id);
    }
  }
  return [...new Set(k)];
}

function closePwaEventStreamsForSession(sid) {
  if (!sid || typeof inboxEventSubs === 'undefined') return;
  const doomed = new Set();
  for (const set of inboxEventSubs.values()) for (const res of set) {
    if (res && res.dxPwaSessionSid === sid) doomed.add(res);
  }
  for (const res of doomed) dropPwaEventStream(res);
}

function pwaEventStreamValidator(req) {
  const deviceId = req.pwaDevice && req.pwaDevice.id;
  if (deviceId) {
    const initialOwner = pwaDeviceResolvedAccount(req.pwaDevice);
    const accountId = initialOwner && initialOwner.id;
    return function () {
      if (!accountId) return false;
      const device = pwaDevices().find((d) => d && d.id === deviceId);
      if (!device || device.sessionLockedAt) return false;
      const owner = pwaDeviceResolvedAccount(device);
      return !!(owner && String(owner.id) === String(accountId) && getAccountById(accountId));
    };
  }
  if (req.pwaSession && req.pwaSession.sid) return presenceSessionValidator(req.pwaSession.sid);
  return function () { return false; };
}

function pwaEventStreamAuthorized(res) {
  return !!(res && typeof res.dxPwaEventValidate === 'function' && res.dxPwaEventValidate());
}

function dropPwaEventStream(res) {
  if (!res) return;
  const keys = Array.isArray(res.dxPwaEventKeys) ? res.dxPwaEventKeys : [];
  for (const k of keys) {
    const set = inboxEventSubs.get(k);
    if (set) { set.delete(res); if (!set.size) inboxEventSubs.delete(k); }
  }
  try { if (!res.writableEnded) res.end(); } catch (_) {}
}

function emitPwaOwnerEvent(s, evt, push) {
  const keys = ownerKeysForShare(s);
  if (!keys.length) return 0;
  const frame = 'data: ' + JSON.stringify(evt) + '\n\n';
  const delivered = new Set(); // one EventSource can be indexed by both dev:* and acc:*
  for (const k of keys) {
    const set = inboxEventSubs.get(k);
    if (!set) continue;
    for (const res of [...set]) {
      if (delivered.has(res)) continue;
      if (!pwaEventStreamAuthorized(res)) { dropPwaEventStream(res); continue; }
      try { res.write(frame); delivered.add(res); } catch (_) { dropPwaEventStream(res); }
    }
    if (!set.size) inboxEventSubs.delete(k);
  }
  if (push) {
    try { return sendPwaPush(keys, { kind: evt.type || 'pwa', title: evt.title || APP_NAME, body: evt.body || '', url: evt.url || '/app/#images', token: evt.token || null }); } catch (_) { return 0; }
  }
  return 0;
}

function emitInboxEvent(s, evt) {
  emitPwaOwnerEvent(s, evt, false);
  const keys = ownerKeysForShare(s);
  try { sendPwaPush(keys, { kind: 'inbox', name: evt.name || '', dest: evt.dest || '', url: '/app/' }); } catch (_) {}
}

function pwaActivityShareForId(shareId) {
  if (!shareId) return null;
  const active = getById(String(shareId));
  if (active) return active;
  const trashed = trashItems().find((row) => row && row.share && String(row.share.id) === String(shareId));
  return trashed ? trashed.share : null;
}

function pwaCanSeeActivityEvent(req, event) {
  if (!event) return false;
  const session = req.pwaSession || null;
  // Activity parity: an owner/admin's paired PWA represents that administrator's
  // own workspace and therefore sees the exact same persistent Activity journal
  // as the standard admin UI. Auditor sessions keep the same read-only visibility.
  if (pwaViewerIsAdmin(req) || (session && session.role === 'auditor')) return true;
  if (session && event.accountId && session.accountId && String(event.accountId) === String(session.accountId)) return true;
  // Device identity is retained on activity events so actions such as a permanent
  // purge remain visible even after the referenced share no longer exists in the
  // active list or trash. Match only the exact paired device to avoid widening
  // the bare-device view to unrelated administrative activity.
  if (req.pwaDevice && event.deviceId && String(event.deviceId) === String(req.pwaDevice.id)) return true;
  if (event.shareId) {
    const share = pwaActivityShareForId(event.shareId);
    if (share && canManagePwaImage(req, share)) return true;
  }
  // A bare paired device must not receive unrelated audit/security/system rows.
  // Its activity view is deliberately scoped to records it can manage.
  return false;
}

function pwaCanSeeActiveTransfer(req, transfer) {
  if (!transfer) return false;
  const session = req.pwaSession || null;
  if (pwaViewerIsAdmin(req) || (session && session.role === 'auditor')) return true;
  const share = transfer.shareId ? getById(String(transfer.shareId)) : null;
  return !!(share && canManagePwaImage(req, share));
}

function pwaCanStopActiveTransfer(req, transfer) {
  const session = req.pwaSession || null;
  if (session && session.role === 'auditor') return false;
  return !!(pwaCanSeeActiveTransfer(req, transfer) && transfer && typeof transfer.abort === 'function' && !transfer.stopRequested && !transfer.ended);
}

function pwaLiveTransfersForRequest(req) {
  if (pwaViewerIsAdmin(req) || (req.pwaSession && req.pwaSession.role === 'auditor')) {
    return listTransfers(null).map((row) => ({ ...row, canStop:pwaCanStopActiveTransfer(req, activeTransfers.get(row.id)) }));
  }
  const allowed = new Set();
  for (const transfer of activeTransfers.values()) {
    if (pwaCanSeeActiveTransfer(req, transfer) && transfer.shareId) allowed.add(transfer.shareId);
  }
  return listTransfers(allowed).map((row) => ({ ...row, canStop:pwaCanStopActiveTransfer(req, activeTransfers.get(row.id)) }));
}

function pwaPresenceValidator(req, scope) {
  if (req.pwaSession && req.pwaSession.sid) {
    const streamRoles = scope && scope.seeAll ? ['owner', 'admin', 'auditor'] : ['owner', 'admin', 'operator', 'auditor'];
    return presenceSessionValidator(req.pwaSession.sid, streamRoles);
  }
  // Device-based principal: re-check the actual pairing record and the current
  // delegating account role on every push. A see-all scope captured while an
  // account was owner/admin must not survive a later downgrade to operator.
  const deviceId = req.pwaDevice && req.pwaDevice.id;
  const scopeAccountId = scope && scope.accountId ? String(scope.accountId) : '';
  const seeAll = !!(scope && scope.seeAll);
  return function () {
    if (!deviceId || !scopeAccountId) return false;
    const device = pwaDevices().find((d) => d && d.id === deviceId);
    if (!device || device.sessionLockedAt) return false;
    const owner = pwaDeviceResolvedAccount(device);
    const persisted = owner && owner.id ? getAccountById(owner.id) : null;
    if (!owner || !persisted || String(owner.id) !== scopeAccountId || String(persisted.id || '') !== scopeAccountId) return false;
    const role = String(persisted.role || '');
    return seeAll ? (role === 'owner' || role === 'admin') : (role === 'owner' || role === 'admin' || role === 'operator');
  };
}

function inboxReceivedFiles(share) {
  const root = resolveWithin(INBOX_DIR, share.relDir || '');
  const files = [];
  const walk = (dir, relPrefix, top) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.dx')) continue; // resumable/moderation/connector staging areas
      const abs = path.join(dir, e.name);
      const rel = relPrefix ? relPrefix + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(abs, rel, false); if (files.length >= 5000) return; continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(abs); } catch (_) { continue; }
      files.push({ name: e.name, path: rel, size: st.size, mtime: Math.round(st.mtimeMs) });
      if (files.length >= 5000) return;
    }
  };
  try { walk(root, '', true); } catch (_) {}
  files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return files;
}

  function closePwaEventStreamsForKeys(keys) {
    const doomed = new Set();
    for (const key of Array.isArray(keys) ? keys : []) {
      const set = inboxEventSubs.get(String(key));
      if (!set) continue;
      for (const res of set) doomed.add(res);
    }
    for (const res of doomed) dropPwaEventStream(res);
    return doomed.size;
  }
  function clearRuntimeState() {
    for (const set of inboxEventSubs.values()) for (const res of set) { try { if (!res.writableEnded) res.end(); } catch (_) {} }
    inboxEventSubs.clear();
  }
  return {
    inboxEventSubs, pwaActivityActor, activityPrincipal, pwaAuditReq, pwaPresenceScope,
    pwaOwnerKeys, shareOwnerAccount, ownerKeysForShare, closePwaEventStreamsForSession,
    closePwaEventStreamsForKeys, pwaEventStreamValidator, pwaEventStreamAuthorized,
    dropPwaEventStream, emitPwaOwnerEvent, emitInboxEvent, pwaActivityShareForId,
    pwaCanSeeActivityEvent, pwaCanSeeActiveTransfer, pwaCanStopActiveTransfer,
    pwaLiveTransfersForRequest, pwaPresenceValidator, inboxReceivedFiles, clearRuntimeState,
  };
}

module.exports = { createPwaEventService };
