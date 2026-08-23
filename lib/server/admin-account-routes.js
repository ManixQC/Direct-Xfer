'use strict';

/**
 * Account-scoped administrator routes: current session, notifications,
 * credential changes, TOTP enrollment and owner account management.
 */
function attachAdminAccountRoutes(deps = {}) {
  const {
    adminRouter,
    requireOwner,
    authService,
    sessionService,
    getAccountById,
    accountNeedsPwChange,
    adminPwFromEnv,
    notificationsForAccount,
    markNotificationsReadForAccount,
    deleteNotificationForAccount,
    clearNotificationsForAccount,
    accountMutedNotificationCategories,
    getNotificationMutableCategories,
    setAccountMutedNotificationCategories,
    accountCustomNotificationRules,
    publicCustomNotificationRule,
    customNotificationRuleTargets,
    getCustomNotificationRuleMetrics,
    upsertCustomNotificationRule,
    deleteCustomNotificationRule,
    auditReq,
    persistNow,
    crypto,
    appName,
    accountList,
    normalizeUsername,
    findAccountByName,
    newAccountId,
    hashPassword,
    sendPasswordWorkError,
    getPwaPairTickets,
    pwaDeviceResolvedAccount,
    cleanupPwaCapabilityScopes,
    clearNotificationDedupeForAccount,
    syncLiveActivityCache,
    reindex,
    shareLogicalBytesCache,
    trashItems,
    getState,
    replaceState,
  } = deps;

  const requiredFunctions = {
    requireOwner,
    getAccountById,
    accountNeedsPwChange,
    notificationsForAccount,
    markNotificationsReadForAccount,
    deleteNotificationForAccount,
    clearNotificationsForAccount,
    accountMutedNotificationCategories,
    setAccountMutedNotificationCategories,
    accountCustomNotificationRules,
    publicCustomNotificationRule,
    customNotificationRuleTargets,
    getNotificationMutableCategories,
    getCustomNotificationRuleMetrics,
    getPwaPairTickets,
    upsertCustomNotificationRule,
    deleteCustomNotificationRule,
    auditReq,
    persistNow,
    accountList,
    normalizeUsername,
    findAccountByName,
    newAccountId,
    hashPassword,
    sendPasswordWorkError,
    pwaDeviceResolvedAccount,
    cleanupPwaCapabilityScopes,
    clearNotificationDedupeForAccount,
    syncLiveActivityCache,
    reindex,
    trashItems,
    getState,
    replaceState,
  };
  if (!adminRouter) throw new TypeError('admin-account-routes requires adminRouter');
  if (!authService || !sessionService) throw new TypeError('admin-account-routes requires authService/sessionService');
  if (!crypto || typeof crypto.randomBytes !== 'function') throw new TypeError('admin-account-routes requires crypto');
  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== 'function') throw new TypeError(`admin-account-routes requires ${name}()`);
  }

  const {
    verifyCurrentPassword,
    setAccountPassword,
    base32encode,
    verifyTotp,
    twoFactorEnabledFor,
  } = authService;
  const {
    destroySession,
    clearOtherSessionsOfAccount,
    clearSessionsOfAccount,
  } = sessionService;

  function currentAccount(req) {
    return getAccountById(req.session.accountId);
  }

  function decorateAccount(account) {
    return {
      id: account.id,
      username: account.username,
      role: account.role,
      twoFactor: twoFactorEnabledFor(account),
      pwChanged: !!account.pwChanged,
      createdAt: account.createdAt || null,
      createdBy: account.createdBy || null,
      lastLoginAt: account.lastLoginAt || 0,
      isEnvManaged: account.role === 'owner' && adminPwFromEnv,
    };
  }

  function renameAccountReferences(accountId, oldUsername, newUsername) {
    accountId = String(accountId || '');
    let changed = 0;
    const state = getState();
    const touchShare = (share) => {
      if (!share) return;
      if (String(share.ownerId || '') === accountId
          || (!share.ownerId && normalizeUsername(share.ownerName || '') === normalizeUsername(oldUsername || ''))) {
        if (share.ownerName !== newUsername) {
          share.ownerName = newUsername;
          changed += 1;
        }
      }
    };
    for (const share of state.shares || []) touchShare(share);
    for (const record of trashItems()) {
      if (!record) continue;
      touchShare(record.share);
      if (String(record.ownerId || '') === accountId
          || (!record.ownerId && normalizeUsername(record.ownerName || '') === normalizeUsername(oldUsername || ''))) {
        if (record.ownerName !== newUsername) {
          record.ownerName = newUsername;
          changed += 1;
        }
      }
    }
    const devices = state.meta && Array.isArray(state.meta.pwaDevices) ? state.meta.pwaDevices : [];
    for (const device of devices) {
      if (device && String(device.createdByAccountId || '') === accountId && device.createdBy !== newUsername) {
        device.createdBy = newUsername;
        changed += 1;
      }
    }
    const owners = state.meta && state.meta.pwaDeviceOwners;
    if (owners && typeof owners === 'object') {
      for (const metadata of Object.values(owners)) {
        if (metadata && String(metadata.accountId || '') === accountId && metadata.username !== newUsername) {
          metadata.username = newUsername;
          metadata.updatedAt = Date.now();
          changed += 1;
        }
      }
    }
    const pwaPairTickets = getPwaPairTickets();
    try {
      for (const metadata of pwaPairTickets.values()) {
        if (metadata && String(metadata.createdByAccountId || '') === accountId) metadata.createdBy = newUsername;
      }
    } catch (_) {}
    return changed;
  }

  function transferAccountOwnedShares(fromAccount, toAccount) {
    if (!fromAccount || !toAccount || !fromAccount.id || !toAccount.id) return 0;
    const state = getState();
    const fromId = String(fromAccount.id);
    const fromName = normalizeUsername(fromAccount.username || '');
    let moved = 0;
    const touch = (share) => {
      if (!share) return false;
      const owned = String(share.ownerId || '') === fromId
        || (!share.ownerId && fromName && normalizeUsername(share.ownerName || '') === fromName);
      if (!owned) return false;
      share.ownerId = toAccount.id;
      share.ownerName = toAccount.username || null;
      if (share.ownerDeviceId) delete share.ownerDeviceId;
      moved += 1;
      return true;
    };
    for (const share of state.shares || []) touch(share);
    for (const record of trashItems()) {
      if (!record) continue;
      if (touch(record.share)) {
        record.ownerId = toAccount.id;
        record.ownerName = toAccount.username || null;
      } else if (String(record.ownerId || '') === fromId) {
        record.ownerId = toAccount.id;
        record.ownerName = toAccount.username || null;
      }
    }
    return moved;
  }

  function revokePwaCapabilitiesForAccount(account) {
    if (!account || !account.id) return { devices: 0, push: 0, tickets: 0 };
    const state = getState();
    const accountId = String(account.id);
    const username = String(account.username || '');
    const devices = Array.isArray(state.meta && state.meta.pwaDevices) ? state.meta.pwaDevices : [];
    const removedIds = [];
    const kept = [];
    for (const device of devices) {
      if (!device) continue;
      const owner = pwaDeviceResolvedAccount(device);
      const matches = (owner && String(owner.id) === accountId)
        || String(device.createdByAccountId || '') === accountId
        || (!!username && String(device.createdBy || '') === username);
      if (matches) {
        if (device.id) removedIds.push(String(device.id));
      } else {
        kept.push(device);
      }
    }
    if (state.meta && typeof state.meta === 'object') state.meta.pwaDevices = kept;
    const pushRemoved = cleanupPwaCapabilityScopes(removedIds, accountId);
    const owners = state.meta && state.meta.pwaDeviceOwners;
    if (owners && typeof owners === 'object') {
      for (const [id, metadata] of Object.entries(owners)) {
        if (removedIds.includes(String(id)) || (metadata && String(metadata.accountId || '') === accountId)) {
          delete owners[id];
        }
      }
    }
    let tickets = 0;
    const pwaPairTickets = getPwaPairTickets();
    try {
      for (const [ticket, metadata] of pwaPairTickets) {
        if (metadata && (
          String(metadata.createdByAccountId || '') === accountId
          || (!!username && String(metadata.createdBy || '') === username
          ))) {
          pwaPairTickets.delete(ticket);
          tickets += 1;
        }
      }
    } catch (_) {}
    return { devices: removedIds.length, push: pushRemoved, tickets };
  }

  adminRouter.get('/session', (req, res) => {
    const account = currentAccount(req);
    res.json({
      authenticated: true,
      csrf: req.session.csrf,
      mustChangePassword: accountNeedsPwChange(account),
      username: account ? account.username : req.session.username,
      role: account ? account.role : req.session.role,
    });
  });

  adminRouter.get('/notifications', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ notifications: notificationsForAccount(req.session.accountId, req), generatedAt: Date.now() });
  });
  adminRouter.post('/notifications/read', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const result = markNotificationsReadForAccount(req.session.accountId, req.body && req.body.ids);
    if (result.error) return res.status(503).json({ error: result.error });
    return res.json({ ok: true, ...result });
  });
  adminRouter.delete('/notifications/:id', (req, res) => {
    const id = String(req.params.id || '').slice(0, 128);
    if (!id) return res.status(400).json({ error: 'missing-id' });
    const removed = deleteNotificationForAccount(req.session.accountId, id);
    if (removed === null) return res.status(503).json({ error: 'write-error' });
    return res.json({ ok: true, removed });
  });
  adminRouter.delete('/notifications', (req, res) => {
    const removed = clearNotificationsForAccount(req.session.accountId);
    if (removed === null) return res.status(503).json({ error: 'write-error' });
    return res.json({ ok: true, removed });
  });
  adminRouter.get('/notifications/prefs', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      mutedCategories: accountMutedNotificationCategories(req.session.accountId),
      mutable: getNotificationMutableCategories(),
    });
  });
  adminRouter.post('/notifications/prefs', (req, res) => {
    const muted = setAccountMutedNotificationCategories(
      req.session.accountId,
      (req.body && req.body.mutedCategories) || [],
    );
    if (!muted) return res.status(503).json({ error: 'write-error' });
    auditReq(req, 'notification-prefs-changed', muted.length ? muted.join(', ') : 'none muted');
    return res.json({ ok: true, mutedCategories: muted });
  });

  adminRouter.get('/notification-rules', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      rules: accountCustomNotificationRules(req.session.accountId).map(publicCustomNotificationRule),
      targets: customNotificationRuleTargets(req.session.accountId),
      metrics: getCustomNotificationRuleMetrics(),
    });
  });
  adminRouter.post('/notification-rules', (req, res) => {
    const result = upsertCustomNotificationRule(req.session.accountId, req.body || {});
    if (result.error) {
      const status = result.error === 'write-error' ? 503
        : result.error === 'too-many-rules' ? 409
          : result.error === 'rule-not-found' ? 404 : 400;
      return res.status(status).json(result);
    }
    const rule = result.rule || {};
    const action = result.duplicate ? 'notification-rule-reused'
      : ((req.body && req.body.id) ? 'notification-rule-updated' : 'notification-rule-created');
    auditReq(
      req,
      action,
      `${rule.metric || 'rule'} >= ${rule.threshold || 0}${rule.shareId ? ` · share=${rule.shareId}` : ''}`,
    );
    return res.json({ ok: true, ...result });
  });
  adminRouter.delete('/notification-rules/:id', (req, res) => {
    const removed = deleteCustomNotificationRule(req.session.accountId, req.params.id);
    if (removed === null) return res.status(503).json({ error: 'write-error' });
    if (removed) auditReq(req, 'notification-rule-deleted', String(req.params.id || '').slice(0, 64));
    return res.json({ ok: true, removed });
  });

  adminRouter.post('/logout', (req, res) => {
    // Invalidate before auditing so this session's SSE feed is no longer
    // authorized when the logout audit event is broadcast.
    destroySession(req, res);
    auditReq(req, 'logout');
    res.json({ ok: true });
  });

  adminRouter.post('/password', async (req, res) => {
    const account = currentAccount(req);
    if (!account) return res.status(401).json({ error: 'not-authenticated' });
    const body = req.body || {};
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    if (next.length < 8) return res.status(400).json({ error: 'too-short' });
    const forced = accountNeedsPwChange(account);
    if (account.role === 'owner' && adminPwFromEnv) return res.status(409).json({ error: 'env-managed' });
    let verifiedCredentialHash;
    if (!forced) {
      const currentCheck = await verifyCurrentPassword(account, current);
      if (!currentCheck.ok) return sendPasswordWorkError(res, currentCheck.error);
      if (!currentCheck.match) return res.status(403).json({ error: 'invalid-current-password' });
      verifiedCredentialHash = currentCheck.credentialHash;
    }
    if (!sessionService.isSessionActive(req.session.sid, [req.session.role])) {
      return res.status(401).json({ error: 'not-authenticated' });
    }
    const persisted = await setAccountPassword(account, next, {
      beforeCommit: () => sessionService.isSessionActive(req.session.sid, [req.session.role]),
      ...(forced ? {} : { expectedHash: verifiedCredentialHash }),
    });
    if (!persisted.ok) {
      if (persisted.error === 'write-error') return res.status(503).json({ error: 'write-error' });
      if (persisted.error === 'account-changed') return res.status(409).json({ error: 'account-changed' });
      if (persisted.error === 'not-authorized') return res.status(401).json({ error: 'not-authenticated' });
      return sendPasswordWorkError(res, persisted.error);
    }
    clearOtherSessionsOfAccount(account.id, req.session.sid);
    auditReq(req, 'password-changed');
    return res.json({ ok: true, persisted: true });
  });

  adminRouter.get('/2fa/status', (req, res) => {
    res.json({ enabled: twoFactorEnabledFor(currentAccount(req)) });
  });
  adminRouter.post('/2fa/setup', async (req, res) => {
    const account = currentAccount(req);
    if (!account) return res.status(401).json({ error: 'not-authenticated' });
    if (twoFactorEnabledFor(account)) return res.status(409).json({ error: 'already-enabled' });
    // Capture the enrollment record before asynchronous recovery-code hashing.
    // Concurrent setup/enable/disable requests must not overwrite one another.
    const initialTotp = account.totp || null;
    const secret = base32encode(crypto.randomBytes(20));
    const recoveryPlain = [];
    for (let i = 0; i < 8; i += 1) recoveryPlain.push(crypto.randomBytes(5).toString('hex'));
    const recoveryResults = await Promise.all(recoveryPlain.map((code) => hashPassword(code)));
    const failedRecovery = recoveryResults.find((result) => !result.ok);
    if (failedRecovery) return sendPasswordWorkError(res, failedRecovery.error);
    if (!sessionService.isSessionActive(req.session.sid, [req.session.role]) || getAccountById(account.id) !== account) {
      return res.status(401).json({ error: 'not-authenticated' });
    }
    if ((account.totp || null) !== initialTotp) {
      return res.status(409).json({ error: 'account-changed' });
    }
    const previousTotp = account.totp || null;
    account.totp = { secret, enabled: false, recovery: recoveryResults.map((result) => result.hash) };
    if (!persistNow()) {
      account.totp = previousTotp;
      return res.status(503).json({ error: 'write-error' });
    }
    const label = encodeURIComponent(`${appName}:${account.username}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(appName)}&digits=6&period=30`;
    return res.json({ secret, otpauth, recoveryCodes: recoveryPlain });
  });
  adminRouter.post('/2fa/enable', (req, res) => {
    const account = currentAccount(req);
    const twoFactor = account && account.totp;
    if (!twoFactor || !twoFactor.secret) return res.status(400).json({ error: 'no-setup' });
    if (twoFactor.enabled) return res.json({ ok: true });
    if (!verifyTotp(twoFactor.secret, String((req.body && req.body.code) || ''))) {
      return res.status(400).json({ error: 'invalid-code' });
    }
    twoFactor.enabled = true;
    if (!persistNow()) {
      twoFactor.enabled = false;
      return res.status(503).json({ error: 'write-error' });
    }
    auditReq(req, '2fa-enabled');
    return res.json({ ok: true });
  });
  adminRouter.post('/2fa/disable', async (req, res) => {
    const account = currentAccount(req);
    if (!account) return res.status(401).json({ error: 'not-authenticated' });
    const currentCheck = await verifyCurrentPassword(account, String((req.body && req.body.password) || ''));
    if (!currentCheck.ok) return sendPasswordWorkError(res, currentCheck.error);
    if (!currentCheck.match) return res.status(403).json({ error: 'invalid-current-password' });
    if (account.ah !== currentCheck.credentialHash) {
      return res.status(409).json({ error: 'account-changed' });
    }
    if (!sessionService.isSessionActive(req.session.sid, [req.session.role]) || getAccountById(account.id) !== account) {
      return res.status(401).json({ error: 'not-authenticated' });
    }
    const previousTotp = account.totp;
    account.totp = null;
    if (!persistNow()) {
      account.totp = previousTotp;
      return res.status(503).json({ error: 'write-error' });
    }
    auditReq(req, '2fa-disabled');
    return res.json({ ok: true });
  });

  adminRouter.get('/accounts', requireOwner, (req, res) => {
    res.json({ accounts: accountList().map(decorateAccount), self: req.session.accountId });
  });
  adminRouter.post('/accounts', requireOwner, async (req, res) => {
    const body = req.body || {};
    const username = normalizeUsername(body.username);
    const password = String(body.password || '');
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'invalid-username' });
    if (password.length < 8) return res.status(400).json({ error: 'too-short' });
    if (findAccountByName(username)) return res.status(409).json({ error: 'username-taken' });
    const role = ['admin', 'operator', 'auditor'].includes(body.role) ? body.role : 'admin';
    const passwordHash = await hashPassword(password);
    if (!passwordHash.ok) return sendPasswordWorkError(res, passwordHash.error);
    if (!sessionService.isSessionActive(req.session.sid, ['owner'])) {
      return res.status(401).json({ error: 'not-authenticated' });
    }
    // Hashing yields to the event loop. Re-check uniqueness after it finishes so
    // concurrent owner requests cannot create duplicate usernames.
    if (findAccountByName(username)) return res.status(409).json({ error: 'username-taken' });
    const account = {
      id: newAccountId(),
      username,
      ah: passwordHash.hash,
      role,
      totp: null,
      pwChanged: true,
      createdAt: Date.now(),
      createdBy: req.session.username,
      lastLoginAt: 0,
    };
    const accounts = accountList();
    accounts.push(account);
    if (!persistNow()) {
      accounts.splice(accounts.indexOf(account), 1);
      return res.status(503).json({ error: 'write-error' });
    }
    auditReq(req, 'account-created', `user=${username}`);
    return res.status(201).json({ account: decorateAccount(account) });
  });
  adminRouter.post('/accounts/:id/password', requireOwner, async (req, res) => {
    const account = getAccountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not-found' });
    if (account.role === 'owner' && adminPwFromEnv) return res.status(409).json({ error: 'env-managed' });
    const password = String((req.body && req.body.password) || '');
    if (password.length < 8) return res.status(400).json({ error: 'too-short' });
    if (!sessionService.isSessionActive(req.session.sid, ['owner'])) {
      return res.status(401).json({ error: 'not-authenticated' });
    }
    const passwordUpdate = await setAccountPassword(account, password, {
      pwChanged: false,
      beforeCommit: () => sessionService.isSessionActive(req.session.sid, ['owner']),
    });
    if (!passwordUpdate.ok) {
      if (passwordUpdate.error === 'write-error') return res.status(503).json({ error: 'write-error' });
      if (passwordUpdate.error === 'account-changed') return res.status(409).json({ error: 'account-changed' });
      if (passwordUpdate.error === 'not-authorized') return res.status(401).json({ error: 'not-authenticated' });
      return sendPasswordWorkError(res, passwordUpdate.error);
    }
    if (!sessionService.isSessionActive(req.session.sid, ['owner'])) {
      return res.status(401).json({ error: 'not-authenticated' });
    }
    clearSessionsOfAccount(account.id);
    auditReq(req, 'password-reset', `user=${account.username}`);
    return res.json({ ok: true });
  });

  adminRouter.post('/accounts/:id/username', requireOwner, (req, res) => {
    const account = getAccountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not-found' });
    if (account.role === 'owner' && adminPwFromEnv) return res.status(409).json({ error: 'env-managed' });
    const username = normalizeUsername((req.body && req.body.username) || '');
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ error: 'invalid-username' });
    const existing = findAccountByName(username);
    if (existing && existing.id !== account.id) return res.status(409).json({ error: 'username-taken' });
    const old = account.username;
    if (old === username) return res.json({ account: decorateAccount(account) });
    account.username = username;
    const renamedRefs = renameAccountReferences(account.id, old, username);
    if (!persistNow()) {
      account.username = old;
      renameAccountReferences(account.id, username, old);
      return res.status(500).json({ error: 'write-error' });
    }
    sessionService.updateAccountUsername(account.id, username);
    auditReq(req, 'account-renamed', `${old} → ${username}; refs=${renamedRefs}`);
    return res.json({ account: decorateAccount(account) });
  });

  adminRouter.delete('/accounts/:id', requireOwner, (req, res) => {
    const account = getAccountById(req.params.id);
    if (!account) return res.status(404).json({ error: 'not-found' });
    if (account.role === 'owner') return res.status(400).json({ error: 'cannot-delete-owner' });
    if (account.id === req.session.accountId) return res.status(400).json({ error: 'cannot-delete-self' });

    const beforeState = JSON.parse(JSON.stringify(getState()));
    const pwaPairTickets = getPwaPairTickets();
    const beforeTickets = new Map(pwaPairTickets);
    const successor = getAccountById(req.session.accountId);
    const transferredShares = transferAccountOwnedShares(account, successor);
    const pwaRevoked = revokePwaCapabilitiesForAccount(account);
    const accounts = accountList();
    accounts.splice(accounts.indexOf(account), 1);
    clearNotificationsForAccount(account.id, false);
    clearNotificationDedupeForAccount(account.id);

    if (!persistNow()) {
      replaceState(beforeState);
      syncLiveActivityCache();
      reindex();
      shareLogicalBytesCache.clear();
      pwaPairTickets.clear();
      for (const [ticket, metadata] of beforeTickets) pwaPairTickets.set(ticket, metadata);
      return res.status(503).json({ error: 'write-error' });
    }

    clearSessionsOfAccount(account.id);
    auditReq(
      req,
      'account-deleted',
      `user=${account.username}; transferredShares=${transferredShares}; pwaDevices=${pwaRevoked.devices}; push=${pwaRevoked.push}; pairingTickets=${pwaRevoked.tickets}`,
    );
    return res.json({ ok: true });
  });
}

module.exports = { attachAdminAccountRoutes };
