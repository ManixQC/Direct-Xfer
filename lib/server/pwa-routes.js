'use strict';

const { composePwaRouteDependencies, validatePwaRouteLiveBindings } = require('./pwa-composition-service');

/**
 * Registers the complete HTTP surface for the Direct-Xfer companion PWA.
 *
 * The main server owns domain/state helpers; this module owns only route
 * composition and request/response orchestration. Dependencies are explicit so
 * PWA routes cannot silently reach unrelated module globals. Mutable server
 * bindings are exposed through the small `live` bridge to preserve lexical
 * live-binding semantics without moving persistence ownership into this module.
 */
function attachPwaRoutes(composition = {}) {
  const modernComposition = Object.prototype.hasOwnProperty.call(composition, 'services') ||
    Object.prototype.hasOwnProperty.call(composition, 'facades');
  const deps = modernComposition ? {
    app: composition.app,
    rootDir: composition.rootDir,
    live: validatePwaRouteLiveBindings(composition.live),
    ...composePwaRouteDependencies(composition.services, composition.facades),
  } : composition;
  const {
    ACTIVITY_HISTORY_MAX,
    ASVS_L3_MODE = false,
    CUSTOM_NOTIFICATION_RULE_METRICS,
    FULL_IMAGES_DIR,
    HOST_ROOT,
    IMAGE_MAX_BYTES,
    IMAGE_MAX_PIXELS,
    INBOX_DIR,
    MICRO_MAX_BYTES,
    NOTIFICATION_MUTABLE_CATEGORIES,
    PASSKEY_MANAGEMENT_FRESH_MS,
    PENDING_DIR,
    PWA_IMG_EXT,
    PWA_INSTALL_HEARTBEAT_MAX_AGE_MS,
    QRCode,
    THUMB_MAX_BYTES,
    TRANSFER_STALL_MS,
    UNDO_LOG_MAX,
    WEBAUTHN_CHALLENGE_TTL,
    accountCustomNotificationRules,
    accountList,
    accountMutedNotificationCategories,
    accountNeedsPwChange,
    accountPasskeys,
    acquireManagedPhotoHashResponseLock,
    activeTransfers,
    activityEventForClient,
    activityEventsForClient,
    activityPrincipal,
    addAdminCenterNotification,
    addCenterNotification,
    addPhotoEditHistory,
    addShare,
    addShareCenterNotification,
    addShareDurable,
    adminGuard,
    adminPhotoFullWrites,
    adminPhotoHasVariantWrite,
    albumInviteHash,
    app,
    appLoginParser,
    appendReceptionThreadMessage,
    applyDlpSummary,
    applyNewShareLifetimePolicy,
    applyPwaPhotoSettings,
    applyTrashRestoreAlternative,
    approvePendingModeration,
    archiveCurrentPhotoVersion,
    assertRealWithin,
    attemptLogin,
    auditReq,
    b64u,
    bindPasskeyToDevice,
    bindPwaDeviceForLogin,
    boundedSeconds,
    buildUniversalSearchIndex,
    bumpPhotoCacheRevision,
    canManagePwaAlbum,
    canManagePwaImage,
    cborDecode,
    claimPendingModeration,
    cleanPhotoEditOperations,
    cleanupPhotoVersionStorage,
    clearNotificationsForAccount,
    clearPwaDeviceCookie,
    clearWebauthnChallengesForAccount,
    clearOtherSessionsOfAccount,
    clientIp,
    computeSettingsPatch,
    setSettingsDurable,
    connectorErrorCode,
    containerToHost,
    coseToJwk,
    createSession,
    crypto,
    customNotificationRuleTargets,
    decorateShare,
    deleteCustomNotificationRule,
    deleteFileExpiryForPath,
    deleteNotificationForAccount,
    destroySession,
    detachActiveShare,
    detailedPhotoRecentViews,
    detailedShareStatsPayload,
    dlpDecision,
    dlpScanResolvedItems,
    dlpScanStoredFile,
    duplicatePhotoPayload,
    emitLiveActivity,
    ensurePhotoDailyViews,
    errorPage,
    express,
    externalProto,
    finalizePendingModerationApproval,
    findAccountByName,
    findManagedPhotoDuplicateDeep,
    firstExistingPhotoFile,
    flushPendingFirstViewPushForKeys,
    freshPasskeyManagementAccount,
    fromB64u,
    fs,
    getAccountById,
    getById,
    getByToken,
    getPwaDevice,
    getPwaPublicDevice,
    getSession,
    getSettings,
    getVapidKeys,
    globalMetadataSearch,
    handleAdminPhotoVariantUpload,
    handlePhotoAdaptiveUpload,
    hostToContainer,
    imageContentType,
    imageDimensions,
    inboxEventSubs,
    inboxReceivedFiles,
    inboxRejectStatus,
    invalidateSessionSid,
    isActive,
    issuePwaDevice,
    listShares,
    localDayKey,
    localDayKeys,
    localizedPwaPush,
    lockPwaSessionHandler,
    logAudit,
    loginHints,
    makeSharePassword,
    managedPhotoCandidates,
    mapLimit,
    markNotificationsReadForAccount,
    migratePwaRecordsForAccount,
    normalizePwaPushLang,
    normalizePwaRetentionRules,
    normalizeShareColor,
    normalizeTags,
    notificationAccountIdsForRequest,
    notificationsForAccount,
    openPresenceStream,
    ownerKeyForPhoto,
    ownerThreadMessage,
    parseExpiry,
    parseLinkRateKBps,
    parseMaxDownloads,
    parseMaxVisitors,
    parseNewShareExpiry,
    passkeyBoundToDevice,
    passkeyDeviceIds,
    passkeyTransports,
    phantomAllowCredentials,
    path,
    pendingModerationRows,
    performUndo,
    persist,
    persistNow,
    photoAdaptivePath,
    photoCacheRevision,
    photoManagedBytes,
    photoOriginalPaths,
    photoStatsOf,
    photoVariantPaths,
    photoVersionDir,
    pickLang,
    presenceSnapshot,
    primaryBase,
    primaryPwaOwnerKey,
    prunePwaPairTickets,
    pruneWebauthnChallenges,
    publicAlbumInvite,
    publicCustomNotificationRule,
    publicPasskey,
    publicPwaDevice,
    purgeTrashRecordById,
    pushSubs,
    pwaAlbumPayload,
    pwaAuditReq,
    pwaCanManageHostShare,
    pwaCanSeeActiveTransfer,
    pwaCanSeeActivityEvent,
    pwaDetectionOrigin,
    pwaDeviceCreatorAccount,
    pwaDeviceOwnerAccount,
    pwaDevices,
    pwaDlpPolicyPayload,
    pwaEventStreamValidator,
    pwaHostAdminSession,
    pwaHttpsInstallUrl,
    pwaImageBootstrapMarkup,
    pwaImageCreatePayload,
    pwaImageInventoryForRequest,
    pwaImgOwner,
    pwaIndexTemplate,
    pwaJsonParser,
    pwaLiveTransfersForRequest,
    pwaNetworkGuard,
    pwaNetworkTestParser,
    pwaNetworkTestPayload,
    pwaNotificationAccountId,
    pwaOwnerKeys,
    pwaPairTickets,
    pwaPhotoByToken,
    pwaPhotoPayload,
    pwaPresenceScope,
    pwaPresenceValidator,
    pwaRetentionRuleStore,
    pwaViewerIsAdmin,
    queueShareLogicalBytesRefresh,
    reactivateRevokedShare,
    receptionThreadArray,
    receptionThreadEnabled,
    receptionThreadUnreadCount,
    recordShareChange,
    recordUndoable,
    reindex,
    releasePendingModeration,
    rememberPwaDeviceOwner,
    reqPathList,
    requestActiveTransferStop,
    sanitizeActivityLog,
    requestClientDeviceName,
    requireAppAuth,
    resolveHostItem,
    resolveWithin,
    restorePhotoVersion,
    sanitizeImageMetadataFile,
    restorePlainObject,
    restoreTrashRecord,
    rollbackRecordedUndo,
    runPwaImageRetentionForOwner,
    safePwaNext,
    safeReceivedFilePath,
    scheduleFlush,
    scheduleSearchReindex,
    sendError,
    sendPasswordWorkError,
    sendPwaInstallAsset,
    sendWebPushAwaited,
    serveWebStorageFile,
    setAccountMutedNotificationCategories,
    setPwaDocumentHeaders,
    shareChangeSnapshot,
    shareEffectiveExpiry,
    shareLogicalBytesCache,
    shareNeedsLogicalBytesScan,
    shareReactivationAvailability,
    softDeleteShare,
    stagePendingFileRemoval,
    stampPhotoUploadDevice,
    stampPwaRecordOwner,
    streamFile,
    streamToFileBounded,
    syncLiveActivityCache,
    timingSafeEqualStr,
    trashItems,
    trashPublicRecord,
    trashRestoreAssessment,
    unbindPasskeyDevice,
    undoEntryExecutable,
    undoEntryVisible,
    undoLogItems,
    undoPublicEntry,
    undoRequestAccount,
    universalSearchQuery,
    universalSearchScopedStatus,
    universalSearchShareEligible,
    universalSemanticSearchQuery,
    unlinkManagedPathsStrict,
    updatePwaDeviceClientInfo,
    upsertCustomNotificationRule,
    webStorageConnectorStatus,
    webStorageWalkFiles,
    webauthnLoginChallenges,
    webauthnParseAuthData,
    verifyL3HardwareAttestation,
    l3HardwarePasskeyAllowed,
    webauthnPublicKey,
    webauthnRegChallenges,
    webauthnRp,
    webauthnVerifySignature,
    rootDir,
    live,
  } = deps;

  if (!app || typeof app.get !== 'function' || typeof app.use !== 'function') {
    throw new TypeError('pwa-routes requires an Express app');
  }
  if (!rootDir || typeof rootDir !== 'string') throw new TypeError('pwa-routes requires rootDir');
  if (!live || typeof live !== 'object') throw new TypeError('pwa-routes requires live bindings');
  if (typeof setSettingsDurable !== 'function') throw new TypeError('pwa-routes requires setSettingsDurable()');

  async function enforceL3PwaImageMetadataPolicy(req, dest, ext, size, sha256) {
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

  // Public install/bootstrap and device claim routes

  app.get('/app/device/claim', (req, res) => {
    prunePwaPairTickets();
    const ticket = String(req.query.ticket || '');
    const meta = pwaPairTickets.get(ticket);
    if (!meta || !/^[A-Za-z0-9_-]{32,128}$/.test(ticket)) {
      return res.status(410).type('html').send(errorPage(pickLang(req), 410, 'Pairing link expired or already used.'));
    }
    pwaPairTickets.delete(ticket);
    const pairingAccount = (meta.createdByAccountId && getAccountById(meta.createdByAccountId)) || findAccountByName(meta.createdBy || '');
    if (!pairingAccount || !['owner','admin','operator'].includes(pairingAccount.role)) {
      return res.status(410).type('html').send(errorPage(pickLang(req), 410, 'Pairing link expired or its account no longer exists.'));
    }
    const device = issuePwaDevice(req, res, meta.name || 'Direct-Xfer PWA (QR)', pairingAccount.username);
    if (!device) {
      if (meta.expiresAt > Date.now()) pwaPairTickets.set(ticket, meta);
      return res.status(503).type('html').send(errorPage(pickLang(req), 503, 'Pairing could not be saved. Please retry.'));
    }
    logAudit('pwa-device-paired', { username: pairingAccount.username || 'admin', ip: clientIp(req), detail: device.name + ' (QR)' });
    res.redirect(303, '/app/?paired=1');
  });

  app.get('/direct-xfer-pwa.webmanifest', (req, res) => sendPwaInstallAsset(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8', false));

  app.get('/direct-xfer-pwa-en.webmanifest', (req, res) => sendPwaInstallAsset(res, 'manifest-en.webmanifest', 'application/manifest+json; charset=utf-8', false));

  app.get('/direct-xfer-pwa-es.webmanifest', (req, res) => sendPwaInstallAsset(res, 'manifest-es.webmanifest', 'application/manifest+json; charset=utf-8', false));

  app.get('/direct-xfer-pwa-sw.js', (req, res) => sendPwaInstallAsset(res, 'sw.js', 'application/javascript; charset=utf-8', true));

  app.get('/direct-xfer-pwa-shell.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data: blob:; " +
      "media-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; manifest-src 'self'; frame-src 'self' blob:; " +
      "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    return res.sendFile(path.join(rootDir, 'pwa', 'index.html'));
  });

  app.get('/pwa/install-state', (req, res) => {
    const device = getPwaPublicDevice(req);
    const seenAt = Math.max(0, Number(device && device.installedStandaloneSeenAt) || 0);
    const installed = seenAt > 0 && Date.now() - seenAt <= PWA_INSTALL_HEARTBEAT_MAX_AGE_MS;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ installed });
  });

  app.get('/admin-pwa-detect.webmanifest', (req, res) => {
    const origin = pwaDetectionOrigin(req);
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/manifest+json').json({
      // Keep these URLs aligned with the manifests actually linked by /app/.
      // Direct-Xfer can switch the manifest for FR/EN/ES, and Chromium only
      // considers the first three related applications, so declare exactly those.
      related_applications: origin ? [
        { platform:'webapp', url: origin + '/direct-xfer-pwa.webmanifest' },
        { platform:'webapp', url: origin + '/direct-xfer-pwa-en.webmanifest' },
        { platform:'webapp', url: origin + '/direct-xfer-pwa-es.webmanifest' },
      ] : [],
      prefer_related_applications: false,
    });
  });

  app.get('/.well-known/assetlinks.json', (req, res) => {
    const origin = pwaDetectionOrigin(req);
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/json').json(origin ? [{
      relation: ['delegate_permission/common.query_webapk'],
      target: { namespace:'web', site: origin + '/admin-pwa-detect.webmanifest' },
    }] : []);
  });

  app.get('/app/install-info', pwaNetworkGuard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ secure: req.secure, httpsUrl: pwaHttpsInstallUrl(), requiresTrustedHttps: true });
  });

  app.get('/app', adminGuard, (req, res, next) => {
    if (req.originalUrl.split('?')[0].endsWith('/')) return next();
    const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    const destination = '/app/' + q;
    res.redirect(302, '/app/login?next=' + encodeURIComponent(destination));
  });

  app.get('/app/login', adminGuard, (req, res) => {
    const destination = safePwaNext(req.query.next);
    if (getSession(req)) return res.redirect(302, destination);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(rootDir, 'pwa', 'login.html'));
  });

  // Password and passkey authentication routes

  app.post('/app/login', adminGuard, appLoginParser, async (req, res) => {
    const body = req.body || {};
    const result = await attemptLogin(req, res, body.username || '', body.password || '', body.totp || '');
    if (!result.ok) {
      if (result.busy) { res.setHeader('Retry-After', String(result.retryAfter || 1)); return res.status(503).json({ error: 'auth-busy', retryAfter: result.retryAfter || 1 }); }
      if (result.locked) return res.status(429).json({ error: 'too-many-attempts', retryAfter: result.retryAfter });
      if (result.passkeyRequired) return res.status(401).json({ error: 'passkey-required' });
      if (result.totpRequired) return res.status(401).json({ error: 'totp-required' });
      if (result.totpInvalid) return res.status(401).json({ error: 'invalid-totp' });
      return res.status(401).json({ error: 'invalid-password', hints: loginHints() });
    }
    const acc = result.account;
    if (!acc || !['owner', 'admin', 'operator', 'auditor'].includes(acc.role)) {
      if (result.sid) invalidateSessionSid(result.sid);
      destroySession(req, res);
      return res.status(403).json({ error: 'role-forbidden' });
    }
  
    let device = getPwaDevice(req, false, true);
    const existingDeviceOwner = device ? (pwaDeviceCreatorAccount(device) || pwaDeviceOwnerAccount(device.id)) : null;
    // A browser may retain a dxpwa cookie while a different account signs in. Never
    // transfer that capability between accounts: issue a separate device identity so
    // one operator cannot inherit another account's workspace on a shared phone.
    if (device && existingDeviceOwner && existingDeviceOwner.id !== acc.id) device = null;
    if (device) {
      delete device.sessionLockedAt;
      device.lastUsedAt = Date.now();
      device.createdBy = acc.username || device.createdBy || null;
      device.createdByAccountId = acc.id;
      // Do NOT overwrite the name of an already-paired device on re-login: the login page
      // always sends a default deviceName, which used to clobber a custom rename on every
      // sign-in. The name is only set when the device is first issued, or via explicit rename.
      rememberPwaDeviceOwner(device);
      scheduleFlush();
    } else {
      const label = String(body.deviceName || requestClientDeviceName(req, 'pwa') || 'Direct-Xfer PWA')
        .replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Direct-Xfer PWA';
      device = issuePwaDevice(req, res, label, acc.username || null);
      if (!device) { if (result.sid) invalidateSessionSid(result.sid); destroySession(req, res); return res.status(503).json({ error:'write-error' }); }
    }
    const migrated = migratePwaRecordsForAccount(acc);
    req.session = { sid: result.sid, csrf: result.csrf, accountId: acc.id, username: acc.username, role: acc.role };
    auditReq(req, 'pwa-login-bound', `${device.name}; migrated=${migrated}`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      csrf: result.csrf,
      mustChangePassword: accountNeedsPwChange(acc),
      username: acc.username,
      role: acc.role,
      paired: true,
      device: publicPwaDevice(device, device.id),
    });
  });

  app.post('/app/webauthn/login/options', adminGuard, appLoginParser, (req, res) => {
    pruneWebauthnChallenges();
    const challenge = crypto.randomBytes(32);
    const token = crypto.randomBytes(18).toString('base64url');
    const rp = webauthnRp(req);
    // If a username is offered, scope the allowed credentials to it; otherwise leave
    // it empty for a resident-key (usernameless) ceremony.
    let allow = [];
    const username = String((req.body && req.body.username) || '').trim();
    let accountId = null;
    if (username) {
      // Always perform the same deterministic phantom-credential work, including for
      // valid accounts, so descriptor construction does not expose account existence
      // through an obvious CPU/timing difference.
      const phantom = phantomAllowCredentials(username);
      const account = findAccountByName(username);
      const keys = accountPasskeys(account);
      // Anti-enumeration (ASVS V6.3.8): an eligible account with passkeys gets its
      // real credential list; every other username (unknown, keyless or ineligible
      // role) gets a deterministic phantom list and the SAME 200 response, so passkey
      // /account existence cannot be probed. A non-empty allowCredentials list also
      // prevents the browser from silently selecting another account's resident
      // passkey; the phantom ids match no authenticator and accountId stays null, so
      // the ceremony fails exactly like a wrong passkey and verify rejects it generically.
      if (account && keys.length && ['owner', 'admin', 'operator', 'auditor'].includes(account.role)) {
        accountId = account.id;
        // Keep the network-visible shape independent of the real credential count.
        // Transports are deliberately omitted here because their presence would also
        // distinguish real descriptors from phantom descriptors.
        allow = keys.slice(0, 20).map((p) => ({ type:'public-key', id:p.id }));
        allow.push(...phantom.slice(allow.length, 20));
      } else {
        allow = phantom;
      }
    }
    webauthnLoginChallenges.set(token, { challenge: b64u(challenge), accountId, rpId: rp.id, origin: rp.origin, at: Date.now() });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token, publicKey: { challenge: b64u(challenge), rpId: rp.id, allowCredentials: allow, userVerification: 'required', timeout: 60000 } });
  });

  app.post('/app/webauthn/login/verify', adminGuard, appLoginParser, (req, res) => {
    const body = req.body || {};
    const stored = webauthnLoginChallenges.get(String(body.token || ''));
    if (!stored || Date.now() - stored.at > WEBAUTHN_CHALLENGE_TTL) return res.status(400).json({ error: 'challenge-expired' });
    webauthnLoginChallenges.delete(body.token);
    try {
      const cred = body.credential || {}, resp = cred.response || {};
      if (cred.type !== 'public-key') throw new Error('credential-type');
      const credId = String(cred.id || '');
      const rawCredId = cred.rawId ? b64u(fromB64u(cred.rawId)) : credId;
      if (!credId || !timingSafeEqualStr(credId, rawCredId)) throw new Error('credential-id-mismatch');
      let acc = null, pk = null;
      for (const a of accountList()) { const m = accountPasskeys(a).find((p) => p.id === credId); if (m) { acc = a; pk = m; break; } }
      if (!acc || !pk) return res.status(401).json({ error: 'passkey-unknown' });
      if (ASVS_L3_MODE === true && !l3HardwarePasskeyAllowed(pk)) throw new Error('hardware-passkey-required');
      if (stored.accountId && String(acc.id) !== String(stored.accountId)) throw new Error('account-mismatch');
      if (!['owner', 'admin', 'operator', 'auditor'].includes(acc.role)) return res.status(403).json({ error: 'role-forbidden' });
      const rp = { id: stored.rpId, origin: stored.origin };
      if (!rp.id || !rp.origin) throw new Error('rp-context');
      const clientData = JSON.parse(fromB64u(resp.clientDataJSON).toString('utf8'));
      if (clientData.type !== 'webauthn.get') throw new Error('type');
      if (clientData.challenge !== stored.challenge) throw new Error('challenge');
      if (clientData.origin !== rp.origin) throw new Error('origin');
      if (clientData.crossOrigin === true) throw new Error('cross-origin');
      const authData = fromB64u(resp.authenticatorData);
      const parsed = webauthnParseAuthData(authData);
      if (!parsed.up) throw new Error('user-not-present');
      if (!parsed.uv) throw new Error('user-not-verified');
      if (parsed.rpIdHash.toString('hex') !== crypto.createHash('sha256').update(rp.id).digest('hex')) throw new Error('rpid');
      if (!stored.accountId && !resp.userHandle) throw new Error('user-handle-missing');
      if (resp.userHandle && !timingSafeEqualStr(b64u(fromB64u(resp.userHandle)), b64u(Buffer.from('acct:' + acc.id)))) throw new Error('user-handle');
      const clientDataHash = crypto.createHash('sha256').update(fromB64u(resp.clientDataJSON)).digest();
      const ok = webauthnVerifySignature(pk.publicKeyJwk, pk.alg, Buffer.concat([authData, clientDataHash]), fromB64u(resp.signature));
      if (!ok) throw new Error('signature');
      // Single-device authenticators must keep a strictly increasing counter. A
      // backup-eligible credential is a synchronized multi-device passkey; its
      // counters can legitimately arrive out of order from different devices.
      if (pk.backupEligible === true && !parsed.be) throw new Error('backup-eligibility');
      if (pk.backupEligible === false && parsed.be) throw new Error('backup-eligibility');
      if (typeof pk.backupEligible !== 'boolean') pk.backupEligible = parsed.be;
      if (!parsed.be) {
        if (pk.counter > 0 && parsed.signCount === 0) throw new Error('counter-reset');
        if (parsed.signCount > 0 && pk.counter > 0 && parsed.signCount <= pk.counter) throw new Error('counter');
      }
      if (parsed.signCount > Number(pk.counter || 0)) pk.counter = parsed.signCount;
      pk.lastUsedAt = Date.now();
      const sess = createSession(req, res, acc, { authMethod:'passkey', phishingResistant:true }); // sets the sid cookie
      const device = bindPwaDeviceForLogin(req, res, acc, body.deviceName); // appends the dxpwa cookie
      if (!device) { invalidateSessionSid(sess.sid); destroySession(req, res); return res.status(503).json({ error: 'write-error' }); }
      migratePwaRecordsForAccount(acc);
      bindPasskeyToDevice(pk, device.id);
      scheduleFlush();
      auditReq(req, 'passkey-login', `${device.name}`);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, csrf: sess.csrf, mustChangePassword: accountNeedsPwChange(acc), username: acc.username, role: acc.role, paired: true, device: publicPwaDevice(device, device.id) });
    } catch (e) {
      auditReq(req, 'passkey-login-fail', String(e && e.message || 'error').slice(0, 60));
      res.status(401).json({ error: 'passkey-failed' });
    }
  });

  app.use('/app', pwaNetworkGuard, requireAppAuth);

  app.get('/app/webauthn/passkeys', (req, res) => {
    const acc = freshPasskeyManagementAccount(req, res);
    if (!acc) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ passkeys: accountPasskeys(acc).map((p) => publicPasskey(p, req.pwaDevice && req.pwaDevice.id)) });
  });

  app.post('/app/webauthn/register/options', pwaJsonParser, (req, res) => {
    const acc = freshPasskeyManagementAccount(req, res);
    if (!acc) return;
    if (!req.pwaDevice || !req.pwaDevice.id) return res.status(409).json({ error: 'device-required' });
    pruneWebauthnChallenges();
    const challenge = crypto.randomBytes(32);
    const token = crypto.randomBytes(18).toString('base64url');
    const rp = webauthnRp(req);
    // Only the latest enrollment ceremony for an account/device remains valid.
    // This prevents a prompt left open in another tab from re-enabling biometrics
    // after the administrator has deliberately disabled the feature.
    for (const [oldToken, value] of webauthnRegChallenges) {
      if (String(value && value.accountId || '') === String(acc.id) && value && value.deviceId && timingSafeEqualStr(String(value.deviceId), String(req.pwaDevice.id))) {
        webauthnRegChallenges.delete(oldToken);
      }
    }
    webauthnRegChallenges.set(token, { challenge: b64u(challenge), accountId: acc.id, deviceId: req.pwaDevice.id, rpId: rp.id, origin: rp.origin, at: Date.now() });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      token,
      publicKey: {
        challenge: b64u(challenge),
        rp: { id: rp.id, name: rp.name },
        user: { id: b64u(Buffer.from('acct:' + acc.id)), name: acc.username, displayName: acc.username },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: ASVS_L3_MODE === true
          ? { authenticatorAttachment:'cross-platform', residentKey:'discouraged', userVerification:'required' }
          : { authenticatorAttachment:'platform', residentKey:'preferred', userVerification:'required' },
        // Exclude only credentials already attached to THIS Direct-Xfer device.
        // Excluding every account credential makes a second phone reject creation
        // when Google Password Manager/iCloud has synchronized the first passkey.
        excludeCredentials: accountPasskeys(acc).filter((p) => passkeyBoundToDevice(p, req.pwaDevice.id)).map((p) => ({ type: 'public-key', id: p.id, ...(passkeyTransports(p.transports).length ? { transports: passkeyTransports(p.transports) } : {}) })),
        timeout: 60000,
        attestation: ASVS_L3_MODE === true ? 'direct' : 'none',
      },
    });
  });

  app.post('/app/webauthn/register/verify', pwaJsonParser, (req, res) => {
    const acc = freshPasskeyManagementAccount(req, res);
    if (!acc) return;
    const body = req.body || {};
    const stored = webauthnRegChallenges.get(String(body.token || ''));
    const currentDeviceId = req.pwaDevice && req.pwaDevice.id;
    if (!stored || String(stored.accountId) !== String(acc.id) || !currentDeviceId || !stored.deviceId || !timingSafeEqualStr(String(stored.deviceId), String(currentDeviceId)) || Date.now() - stored.at > WEBAUTHN_CHALLENGE_TTL) return res.status(400).json({ error: 'challenge-expired' });
    webauthnRegChallenges.delete(body.token);
    try {
      const cred = body.credential || {}, resp = cred.response || {};
      if (cred.type !== 'public-key') throw new Error('credential-type');
      const rp = { id: stored.rpId, origin: stored.origin };
      if (!rp.id || !rp.origin) throw new Error('rp-context');
      const clientData = JSON.parse(fromB64u(resp.clientDataJSON).toString('utf8'));
      if (clientData.type !== 'webauthn.create') throw new Error('type');
      if (clientData.challenge !== stored.challenge) throw new Error('challenge');
      if (clientData.origin !== rp.origin) throw new Error('origin');
      if (clientData.crossOrigin === true) throw new Error('cross-origin');
      const attestation = cborDecode(fromB64u(resp.attestationObject)).value;
      const authDataRaw = attestation.get('authData');
      const parsed = webauthnParseAuthData(authDataRaw);
      if (!parsed.up) throw new Error('user-not-present');
      if (!parsed.uv) throw new Error('user-not-verified');
      if (parsed.rpIdHash.toString('hex') !== crypto.createHash('sha256').update(rp.id).digest('hex')) throw new Error('rpid');
      if (!parsed.cose || !parsed.credId) throw new Error('no-key');
      const { jwk, alg } = coseToJwk(parsed.cose);
      if (alg !== -7 && alg !== -257) throw new Error('algorithm');
      webauthnPublicKey(jwk, alg); // reject unusable, weak or algorithm-mismatched keys up front
      const clientDataHash = crypto.createHash('sha256').update(fromB64u(resp.clientDataJSON)).digest();
      const hardware = verifyL3HardwareAttestation(attestation, authDataRaw, clientDataHash, parsed, resp.transports);
      const credId = b64u(parsed.credId);
      const suppliedId = String(cred.id || '');
      const suppliedRawId = cred.rawId ? b64u(fromB64u(cred.rawId)) : suppliedId;
      if (!suppliedId || !timingSafeEqualStr(suppliedId, credId) || !timingSafeEqualStr(suppliedRawId, credId)) throw new Error('credential-id-mismatch');
      if (!Array.isArray(acc.passkeys)) acc.passkeys = [];
      const existing = acc.passkeys.find((p) => p.id === credId);
      if (existing) {
        if (Number(existing.alg) !== Number(alg) || JSON.stringify(existing.publicKeyJwk || {}) !== JSON.stringify(jwk || {})) throw new Error('credential-key-mismatch');
        const changed = bindPasskeyToDevice(existing, currentDeviceId);
        const mergedTransports = passkeyTransports([...(existing.transports || []), ...(resp.transports || [])]);
        const transportsChanged = JSON.stringify(mergedTransports) !== JSON.stringify(passkeyTransports(existing.transports));
        if (transportsChanged) existing.transports = mergedTransports;
        if (changed || transportsChanged) scheduleFlush();
        if (changed) auditReq(req, 'passkey-device-added', existing.name || 'Biometrics');
        return res.json({ ok: true, id: credId, already: true, passkeys: acc.passkeys.map((p) => publicPasskey(p, currentDeviceId)) });
      }
      // A credential id is globally unique. Refuse an impossible collision with a
      // different account instead of making passwordless login ambiguous.
      if (accountList().some((other) => String(other.id) !== String(acc.id) && accountPasskeys(other).some((p) => p.id === credId))) {
        return res.status(409).json({ error: 'credential-conflict' });
      }
      acc.passkeys.push({ id: credId, publicKeyJwk: jwk, alg, counter: parsed.signCount || 0, backupEligible: parsed.be, hardwareBacked:hardware.hardwareBacked === true, aaguid:hardware.aaguid || parsed.aaguid || null, attestationRootSha256:hardware.attestationRootSha256 || null, name: String(body.name || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60) || 'Biometrics', deviceId: currentDeviceId, deviceIds: [currentDeviceId], transports: passkeyTransports(resp.transports), createdAt: Date.now(), lastUsedAt: 0 });
      if (ASVS_L3_MODE && hardware.hardwareBacked === true) acc.l3HardwarePasskeyEnrolled = true;
      if (acc.passkeys.length > 20) acc.passkeys = acc.passkeys.slice(-20);
      scheduleFlush();
      // Factor change (ASVS V7.4.3): a new passkey invalidates the account's other
      // active sessions so any pre-existing weaker-factor session cannot persist.
      clearOtherSessionsOfAccount(acc.id, (req.pwaSession || getSession(req) || {}).sid);
      auditReq(req, 'passkey-added', acc.passkeys[acc.passkeys.length - 1].name);
      addCenterNotification(acc.id, 'auth-credential-changed', { category:'security', severity:'warning', detail:'Passkey added', dedupeKey:`auth-change:passkey-add:${credId}` });
      res.json({ ok: true, id: credId, passkeys: acc.passkeys.map((p) => publicPasskey(p, req.pwaDevice && req.pwaDevice.id)) });
    } catch (e) {
      res.status(400).json({ error: 'invalid-attestation' });
    }
  });

  app.delete('/app/webauthn/passkeys/:id/devices/:deviceId', (req, res) => {
    const acc = freshPasskeyManagementAccount(req, res);
    if (!acc) return;
    const id = String(req.params.id || ''), deviceId = String(req.params.deviceId || '');
    const key = accountPasskeys(acc).find((row) => row && timingSafeEqualStr(String(row.id || ''), id));
    if (!key) return res.status(404).json({ error:'passkey-not-found' });
    const passkeysBefore = JSON.parse(JSON.stringify(accountPasskeys(acc)));
    if (!unbindPasskeyDevice(key, deviceId)) return res.status(404).json({ error:'device-not-found' });
    if (!passkeyDeviceIds(key).length) {
      if (ASVS_L3_MODE && l3HardwarePasskeyAllowed(key) && accountPasskeys(acc).filter((row) => row !== key).filter(l3HardwarePasskeyAllowed).length === 0) {
        acc.passkeys = passkeysBefore;
        return res.status(409).json({ error:'l3-last-hardware-passkey-required' });
      }
      acc.passkeys = accountPasskeys(acc).filter((row) => row !== key);
    }
    if (!persistNow()) { acc.passkeys = passkeysBefore; return res.status(503).json({ error:'write-error' }); }
    clearWebauthnChallengesForAccount(acc.id);
    clearOtherSessionsOfAccount(acc.id, (req.pwaSession || getSession(req) || {}).sid); // ASVS V7.4.3 factor change
    auditReq(req, 'passkey-device-removed', `${(key.name || 'Biometrics')} · ${deviceId.slice(0,12)}`);
    addCenterNotification(acc.id, 'auth-credential-changed', { category:'security', severity:'warning', detail:'Passkey device binding removed', dedupeKey:`auth-change:passkey-device:${id}:${deviceId}` });
    res.setHeader('Cache-Control','no-store');
    res.json({ ok:true, passkeys:accountPasskeys(acc).map((row) => publicPasskey(row, req.pwaDevice && req.pwaDevice.id)) });
  });

  app.delete('/app/webauthn/passkeys/:id', (req, res) => {
    const acc = freshPasskeyManagementAccount(req, res);
    if (!acc) return;
    const id = String(req.params.id || '');
    const before = accountPasskeys(acc).length;
    const target = accountPasskeys(acc).find((p) => p && timingSafeEqualStr(String(p.id || ''), id));
    if (ASVS_L3_MODE && target && l3HardwarePasskeyAllowed(target) && accountPasskeys(acc).filter((p) => p !== target).filter(l3HardwarePasskeyAllowed).length === 0) {
      return res.status(409).json({ error:'l3-last-hardware-passkey-required' });
    }
    if (before) acc.passkeys = acc.passkeys.filter((p) => p.id !== id);
    if (accountPasskeys(acc).length !== before) { scheduleFlush(); clearOtherSessionsOfAccount(acc.id, (req.pwaSession || getSession(req) || {}).sid); auditReq(req, 'passkey-removed', id.slice(0, 24)); addCenterNotification(acc.id, 'auth-credential-changed', { category:'security', severity:'critical', detail:'Passkey removed', dedupeKey:`auth-change:passkey-remove:${id}` }); } // ASVS V7.4.3 factor change
    res.json({ ok: true, passkeys: accountPasskeys(acc).map((p) => publicPasskey(p, req.pwaDevice && req.pwaDevice.id)) });
  });

  app.delete('/app/webauthn/passkeys', (req, res) => {
    const acc = freshPasskeyManagementAccount(req, res);
    if (!acc) return;
    const removed = accountPasskeys(acc).length;
    if (ASVS_L3_MODE && accountPasskeys(acc).some(l3HardwarePasskeyAllowed)) {
      return res.status(409).json({ error:'l3-last-hardware-passkey-required' });
    }
    if (removed) {
      acc.passkeys = [];
      clearWebauthnChallengesForAccount(acc.id);
      scheduleFlush();
      clearOtherSessionsOfAccount(acc.id, (req.pwaSession || getSession(req) || {}).sid); // ASVS V7.4.3 factor change
      auditReq(req, 'passkeys-disabled', `${removed} credential(s)`);
      addCenterNotification(acc.id, 'auth-credential-changed', { category:'security', severity:'critical', detail:`All passkeys disabled (${removed})`, dedupeKey:`auth-change:passkeys-disabled:${Date.now()}` });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, removed, passkeys: [] });
  });

  // Notifications, rules, network diagnostics and authenticated PWA services

  app.get('/app/notifications', (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error: 'owner-unresolved' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ notifications: notificationsForAccount(accountId, req), generatedAt: Date.now() });
  });

  app.post('/app/notifications/read', pwaJsonParser, (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error: 'owner-unresolved' });
    res.setHeader('Cache-Control', 'no-store');
    const result = markNotificationsReadForAccount(accountId, req.body && req.body.ids);
    if (result.error) return res.status(503).json({ error:result.error });
    res.json({ ok:true, ...result });
  });

  app.post('/app/notifications/delete', pwaJsonParser, (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error: 'owner-unresolved' });
    const id = String((req.body && req.body.id) || '').slice(0, 128);
    if (!id) return res.status(400).json({ error: 'missing-id' });
    const removed = deleteNotificationForAccount(accountId, id);
    if (removed === null) return res.status(503).json({ error:'write-error' });
    res.json({ ok: true, removed });
  });

  app.post('/app/notifications/clear', pwaJsonParser, (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error: 'owner-unresolved' });
    const removed = clearNotificationsForAccount(accountId);
    if (removed === null) return res.status(503).json({ error:'write-error' });
    res.json({ ok: true, removed });
  });

  app.get('/app/notifications/prefs', (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error: 'owner-unresolved' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ mutedCategories: accountMutedNotificationCategories(accountId), mutable: NOTIFICATION_MUTABLE_CATEGORIES });
  });

  app.post('/app/notifications/prefs', pwaJsonParser, (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error: 'owner-unresolved' });
    const muted = setAccountMutedNotificationCategories(accountId, (req.body && req.body.mutedCategories) || []);
    if (!muted) return res.status(503).json({ error:'write-error' });
    pwaAuditReq(req, 'notification-prefs-changed', `via PWA — ${muted.length ? muted.join(', ') : 'none muted'}`);
    res.json({ ok: true, mutedCategories: muted });
  });

  app.get('/app/notification-rules', (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error:'owner-unresolved' });
    res.setHeader('Cache-Control','no-store');
    res.json({ rules:accountCustomNotificationRules(accountId).map(publicCustomNotificationRule), targets:customNotificationRuleTargets(accountId), metrics:CUSTOM_NOTIFICATION_RULE_METRICS });
  });

  app.post('/app/notification-rules', pwaJsonParser, (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error:'owner-unresolved' });
    const result = upsertCustomNotificationRule(accountId, req.body || {});
    if (result.error) return res.status(result.error === 'write-error' ? 503 : result.error === 'too-many-rules' ? 409 : result.error === 'rule-not-found' ? 404 : 400).json(result);
    const rule = result.rule || {};
    pwaAuditReq(req, result.duplicate ? 'notification-rule-reused' : ((req.body && req.body.id) ? 'notification-rule-updated' : 'notification-rule-created'), `via PWA — ${rule.metric || 'rule'} >= ${rule.threshold || 0}${rule.shareId ? ' · share=' + rule.shareId : ''}`);
    res.json({ ok:true, ...result });
  });

  app.post('/app/notification-rules/delete', pwaJsonParser, (req, res) => {
    const accountId = pwaNotificationAccountId(req);
    if (!accountId) return res.status(403).json({ error:'owner-unresolved' });
    const id = String(req.body && req.body.id || ''); if (!id) return res.status(400).json({ error:'missing-id' });
    const removed = deleteCustomNotificationRule(accountId, id);
    if (removed === null) return res.status(503).json({ error:'write-error' });
    if (removed) pwaAuditReq(req, 'notification-rule-deleted', 'via PWA — ' + id.slice(0,64));
    res.json({ ok:true, removed });
  });

  app.get('/app/network-test', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const requested = Math.max(0, Math.min(pwaNetworkTestPayload.length, Number(req.query.bytes) || 0));
    if (!requested) return res.json({ ok: true, at: Date.now() });
    res.status(200).type('application/octet-stream');
    res.setHeader('Content-Length', String(requested));
    return res.end(pwaNetworkTestPayload.subarray(0, requested));
  });

  app.post('/app/network-test', pwaNetworkTestParser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, bytes: Buffer.isBuffer(req.body) ? req.body.length : 0, at: Date.now() });
  });

  app.post('/app/session/logout', pwaJsonParser, lockPwaSessionHandler);

  app.post('/app/session/lock', pwaJsonParser, lockPwaSessionHandler);

  app.get('/app/qr', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 1024) return res.status(400).json({ error: 'invalid-data' });
    try {
      const svg = await QRCode.toString(data, { type: 'svg', margin: 1 });
      res.type('image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      res.send(svg);
    } catch (e) {
      res.status(500).json({ error: 'qr-failed' });
    }
  });

  app.get('/app/events', (req, res) => {
    const keys = pwaOwnerKeys(req);
    const validate = pwaEventStreamValidator(req);
    if (!keys.length || !validate()) return res.status(403).end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // keep proxies (nginx) from buffering the stream
    });
    res.dxPwaEventValidate = validate;
    res.dxPwaEventKeys = keys.slice();
    res.dxPwaSessionSid = (!req.pwaDevice && req.pwaSession && req.pwaSession.sid) ? req.pwaSession.sid : null;
    res.write('retry: 5000\n\n');
    res.write(': connected\n\n');
    for (const k of keys) { if (!inboxEventSubs.has(k)) inboxEventSubs.set(k, new Set()); inboxEventSubs.get(k).add(res); }
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      for (const k of keys) { const set = inboxEventSubs.get(k); if (set) { set.delete(res); if (!set.size) inboxEventSubs.delete(k); } }
    };
    const ping = setInterval(() => {
      if (!validate()) { cleanup(); try { if (!res.writableEnded) res.end(); } catch (_) {} return; }
      try { res.write(': ping\n\n'); } catch (_) { cleanup(); }
    }, 25000);
    if (ping.unref) ping.unref();
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  app.get('/app/push/vapid', (req, res) => {
    if (!live.webpush) return res.status(400).json({ error: 'no-module' });
    const keys = getVapidKeys();
    res.json({ publicKey: keys ? keys.publicKey : '' });
  });

  app.post('/app/push/subscribe', pwaJsonParser, async (req, res) => {
    if (!live.webpush) return res.status(400).json({ error: 'no-module' });
    const keys = pwaOwnerKeys(req);
    if (!keys.length) return res.status(403).json({ error: 'forbidden' });
    const sub = req.body && req.body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'invalid-subscription' });
    }
    const subs = pushSubs();
    const rec = {
      endpoint: sub.endpoint.slice(0, 2000),
      keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) },
      ownerKeys: keys, pwa: true,
      accountId: (req.pwaSession && req.pwaSession.accountId) || null,
      lang: normalizePwaPushLang(req.body && req.body.language),
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
      createdAt: Date.now(),
    };
    const deviceKey = req.pwaDevice && req.pwaDevice.id ? 'dev:' + req.pwaDevice.id : null;
    const priorForDevice = deviceKey ? subs.filter((x) => x && x.endpoint !== rec.endpoint && Array.isArray(x.ownerKeys) && x.ownerKeys.includes(deviceKey)) : [];
    // Repair only replaces subscriptions belonging to THIS device. Matching on the
    // account key used to classify a perfectly normal second device as a repair and
    // could leave the old same-device endpoint around for duplicate Push attempts.
    if (priorForDevice.length) {
      const stale = new Set(priorForDevice.map((x) => x.endpoint));
      for (let j=subs.length-1;j>=0;j--) if (subs[j] && stale.has(subs[j].endpoint)) subs.splice(j,1);
    }
    const i = subs.findIndex((x) => x.endpoint === rec.endpoint);
    if (i !== -1) subs[i] = { ...subs[i], ...rec }; else subs.push(rec);
    if (req.pwaDevice) { req.pwaDevice.pushPermissionState = 'granted'; req.pwaDevice.pushPermissionChangedAt = Date.now(); }
    if (subs.length > 300) subs.splice(0, subs.length - 300);
    persist();
    if ((req.body && req.body.repaired === true) || priorForDevice.length) {
      const ids = notificationAccountIdsForRequest(req);
      addAdminCenterNotification('push-subscription-repaired',{device:req.pwaDevice&&req.pwaDevice.name||rec.ua,detail:'Abonnement Push recréé automatiquement',dedupeKey:`push-repaired:${req.pwaDevice&&req.pwaDevice.id||keys.join(',')}:${Math.floor(Date.now()/3600000)}`,dedupeWindowMs:3600000},ids);
    }
    const pendingFlushed = await flushPendingFirstViewPushForKeys(keys);
    pwaAuditReq(req, 'push-subscribed', `via PWA — ${priorForDevice.length ? 'repaired' : 'registered'}${pendingFlushed ? ' · pending=' + pendingFlushed : ''}`);
    res.json({ ok: true, pendingFlushed });
  });

  app.post('/app/push/unsubscribe', pwaJsonParser, (req, res) => {
    const endpoint = String((req.body && req.body.endpoint) || '').trim();
    if (!endpoint) return res.status(400).json({ error: 'missing-endpoint' });
    const ownerKeys = pwaOwnerKeys(req), subs = pushSubs();
    const i = subs.findIndex((sub) => sub && sub.endpoint === endpoint && Array.isArray(sub.ownerKeys) && sub.ownerKeys.some((key) => ownerKeys.includes(key)));
    const removed = i >= 0;
    if (removed) { subs.splice(i, 1); persist(); pwaAuditReq(req, 'push-unsubscribed', 'via PWA'); }
    res.json({ ok: true, removed });
  });

  app.post('/app/push/permission-state', pwaJsonParser, (req, res) => {
    const permission = String((req.body && req.body.permission) || '').toLowerCase();
    if (!['granted','denied','default'].includes(permission)) return res.status(400).json({ error:'invalid-permission' });
    const ids = notificationAccountIdsForRequest(req), device=req.pwaDevice || null;
    const deviceKey = device && device.id ? 'dev:' + device.id : null;
    const hadDeviceSub = !!(deviceKey && pushSubs().some((x) => x && Array.isArray(x.ownerKeys) && x.ownerKeys.includes(deviceKey)));
    const previous = device && device.pushPermissionState ? String(device.pushPermissionState) : (hadDeviceSub ? 'granted' : 'unknown');
    let removed = 0, notified = false;
    if (device) { device.pushPermissionState = permission; device.pushPermissionChangedAt = Date.now(); }
    if (permission === 'denied' && deviceKey) {
      const subs=pushSubs(); for (let j=subs.length-1;j>=0;j--) if (subs[j] && Array.isArray(subs[j].ownerKeys) && subs[j].ownerKeys.includes(deviceKey)) { subs.splice(j,1); removed++; }
    }
    if (permission === 'denied' && previous === 'granted') {
      addAdminCenterNotification('push-permission-revoked',{device:device&&device.name||'PWA',detail:'Permission Notifications retirée dans le navigateur',dedupeKey:`push-permission-denied:${device&&device.id||ids.join(',')}:${Date.now()}`},ids);
      notified = true;
    }
    if (device || removed) persist();
    if (previous !== permission || removed) pwaAuditReq(req, 'push-permission-changed', `via PWA — ${previous} → ${permission}${removed ? ' · subscriptions removed=' + removed : ''}`);
    res.json({ ok:true, notified, removed });
  });

  app.post('/app/push/test', pwaJsonParser, async (req, res) => {
    if (!live.webpush) return res.status(400).json({ error: 'no-module' });
    const endpoint = String((req.body && req.body.endpoint) || '').trim();
    if (!endpoint) return res.status(400).json({ error: 'missing-endpoint' });
    const ownerKeys = pwaOwnerKeys(req);
    const sub = pushSubs().find((x) => x && x.endpoint === endpoint && Array.isArray(x.ownerKeys) && x.ownerKeys.some((k) => ownerKeys.includes(k)));
    if (!sub) return res.status(400).json({ error: 'no-subscription' });
    const testId = String((req.body && req.body.testId) || '').trim().slice(0, 96);
    const testMessage = localizedPwaPush({ kind: 'test' }, sub.lang);
    const result = await sendWebPushAwaited('test', testMessage.title, testMessage.body, { url: '/app/#settings', testId }, sub);
    pwaAuditReq(req, 'push-tested', `via PWA — ${result.ok ? 'ok' : String(result.error || 'send-failed').slice(0,80)}`);
    if (result.ok) return res.json({ ok: true, sent: 1, pushStatus: result.statusCode, testId, sentAt: result.sentAt || Date.now() });
    const httpStatus = result.error === 'stale-subscription' ? 410 : 502;
    return res.status(httpStatus).json({ error: result.error || 'send-failed', pushStatus: result.statusCode || 0 });
  });

  app.post('/app/inbox', pwaJsonParser, (req, res) => {
    if (!req.is('application/json') || !req.body || Array.isArray(req.body) || typeof req.body !== 'object') {
      return res.status(415).json({ error: 'json-required' });
    }
    const name = String((req.body && req.body.name) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80) || 'Réception';
    const dirBase = name.replace(/[^A-Za-z0-9 _.-]/g, '_').replace(/^\.+/, '').trim().slice(0, 50) || 'reception';
    const inbox = {
      type: 'inbox',
      name,
      relDir: dirBase + '-' + crypto.randomBytes(3).toString('hex'), // unique folder (no collisions)
      startsAt: null,
      expiresAt: null,
      maxFiles: 0, maxFileBytes: 0, maxTotalBytes: 0,
      allowExt: [], blockExt: [],
      groupBySender: false,
      moderated: !!req.body.moderated,
      bytesReceived: 0,
    };
    const banner = String(getSettings().receptionBanner || '').slice(0, 2000);
    if (banner) inbox.note = banner;
    // Ownership: an admin session stamps its account; a device records its own name.
    stampPwaRecordOwner(req, inbox);
    try { fs.mkdirSync(resolveWithin(INBOX_DIR, inbox.relDir), { recursive: true }); } catch (_) {}
    const rec = addShare(inbox, req);
    const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
    logAudit('inbox-created', { username: who, ip: clientIp(req), detail: 'via PWA — ' + name });
    const dec = decorateShare(rec, req);
    res.status(201).json({ token: rec.token, name: rec.name, url: dec.url || (primaryBase(req) + '/u/' + rec.token) });
  });

  app.get('/app/image/:token/preview/:variant', async (req, res) => {
    const share = pwaPhotoByToken(req, req.params.token);
    if (!share || !isActive(share)) return sendError(req, res, 404, 'fileNotFound');
  
    const requested = String(req.params.variant || '').toLowerCase();
    if (!['auto', 'full', 'thumb', 'micro'].includes(requested)) {
      return sendError(req, res, 400, 'fileNotFound');
    }
  
    let variant = requested;
    let adaptiveFile = null;
    let adaptiveType = null;
    if (requested === 'auto') {
      const width = Math.max(0, Math.min(10000,
        parseInt(req.query.w, 10) || parseInt(req.headers.width, 10) ||
        parseInt(req.headers['viewport-width'], 10) || 0));
      const saveData = String(req.headers['save-data'] || '').toLowerCase() === 'on';
      const ect = String(req.headers.ect || '').toLowerCase();
      const slow = saveData || /(^|-)2g$/.test(ect) || ect === 'slow-2g';
      if (slow || (width && width <= 320)) variant = 'micro';
      else if (width && width <= 900) variant = 'thumb';
      else {
        const accept = String(req.headers.accept || '');
        const format = /image\/avif/i.test(accept) && share.adaptiveAvif ? 'avif'
          : /image\/webp/i.test(accept) && share.adaptiveWebp ? 'webp'
            : null;
        if (format) {
          const file = photoAdaptivePath(share.token, format);
          try {
            if (file && (await fs.promises.stat(file)).isFile()) {
              adaptiveFile = file;
              adaptiveType = 'image/' + format;
            }
          } catch (_) {}
        }
        variant = 'full';
      }
    }
  
    if (adaptiveFile) {
      return streamFile(req, res, adaptiveFile, share.token + path.extname(adaptiveFile), null, null, {
        inline: true,
        contentType: adaptiveType,
        cacheControl: 'no-store',
      });
    }
  
    const candidates = variant === 'micro'
      ? [
          ...photoVariantPaths(share.token, 'micro').map((file) => ({ ready: share.micro, file })),
          ...photoVariantPaths(share.token, 'thumb').map((file) => ({ ready: share.thumb, file })),
        ]
      : variant === 'thumb'
        ? photoVariantPaths(share.token, 'thumb').map((file) => ({ ready: share.thumb, file }))
        : [];
    for (const candidate of candidates) {
      if (!candidate.ready) continue;
      try {
        if ((await fs.promises.stat(candidate.file)).isFile()) {
          return streamFile(req, res, candidate.file, share.token + '.jpg', null, null, {
            inline: true,
            contentType: 'image/jpeg',
            cacheControl: 'no-store',
          });
        }
      } catch (_) {}
    }
  
    try {
      let original = firstExistingPhotoFile(photoOriginalPaths(share));
      if (!original) {
        original = hostToContainer(share.hostPath);
        await assertRealWithin(HOST_ROOT, original);
      }
      return streamFile(req, res, original, share.name, null, null, {
        inline: true,
        contentType: imageContentType(share.imgPath || share.name) || 'application/octet-stream',
        cacheControl: 'no-store',
      });
    } catch (e) {
      return sendError(req, res, e.code === 'ENOENT' ? 404 : 403, 'fileUnavailable');
    }
  });

  app.get('/app/activity/transfers', (req, res) => {
    const transfers = pwaLiveTransfersForRequest(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ transfers, stalledCount:transfers.filter((row) => row.stalled).length, stallThresholdMs:TRANSFER_STALL_MS, generatedAt:Date.now() });
  });

  app.post('/app/activity/transfers/:id/stop', pwaJsonParser, (req, res) => {
    const transfer = activeTransfers.get(req.params.id);
    if (!transfer || !pwaCanSeeActiveTransfer(req, transfer)) return res.status(404).json({ error:'not-found' });
    const session = req.pwaSession || null;
    if (session && session.role === 'auditor') return res.status(403).json({ error:'forbidden' });
    const stopped = requestActiveTransferStop(transfer);
    if (!stopped.ok) return res.status(stopped.error === 'not-found' ? 404 : stopped.error === 'not-stoppable' ? 409 : 500).json({ error:stopped.error });
    if (!stopped.alreadyRequested) pwaAuditReq(req, 'transfer-stopped', `via PWA — ${transfer.name || transfer.shareId || transfer.id} · ${transfer.direction || 'transfer'}`);
    res.json(stopped);
  });

  app.get('/app/activity/recent', (req, res) => {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 500));
    const visible = (Array.isArray(live.state.activityLog) ? live.state.activityLog : []).filter((event) => pwaCanSeeActivityEvent(req, event));
    const safeVisible = sanitizeActivityLog(visible);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events: activityEventsForClient(safeVisible.slice(0, limit)), retained: safeVisible.length, max: ACTIVITY_HISTORY_MAX });
  });

  app.get('/app/images', (req, res) => {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200));
    const offset = Math.max(0, Math.min(50000, parseInt(req.query.offset, 10) || 0));
    const includeInactive = String(req.query.includeInactive || '') === '1';
    const inventory = pwaImageInventoryForRequest(req, { includeInactive });
    const page = inventory.slice(offset, offset + limit);
    const images = page.map((share) => pwaPhotoPayload(req, share));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ images, offset, limit, total: inventory.length, hasMore: offset + page.length < inventory.length });
  });

  app.get('/app/images/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'query-too-short' });
    // Match the full admin search behaviour on a fresh boot: do not return a
    // misleading empty OCR result merely because the persisted index has not yet
    // been built. Subsequent rebuilds remain asynchronous and serve the last index.
    if (!live.universalSearchIndex.builtAt && !live.searchIndexBuilding) {
      try { await buildUniversalSearchIndex(); } catch (_) {}
    }
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const results = universalSearchQuery(q, req, limit, {
      type: 'photo',
      canAccess: (share) => universalSearchShareEligible(share) && canManagePwaImage(req, share),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ query:q, tokens:[...new Set(results.map((r) => r.token).filter(Boolean))], results,
      builtAt:live.universalSearchIndex.builtAt || 0, building:live.searchIndexBuilding });
  });

  app.get('/app/image/:token/stats', (req, res) => {
    const share = getByToken(req.params.token);
    if (!share || share.type !== 'photo' || !isActive(share) || !canManagePwaImage(req, share)) {
      return res.status(404).json({ error: 'not-found' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(pwaPhotoPayload(req, share));
  });

  app.get('/app/image/:token/stats-detail', async (req, res) => {
    const share = pwaPhotoByToken(req, req.params.token);
    if (!share) return res.status(404).json({ error: 'not-found' });
    const photo = pwaPhotoPayload(req, share);
    const ps = photoStatsOf(share);
    const variants = {};
    let detailedTotalViews = 0, detailedBandwidth = 0;
    for (const kind of ['full', 'thumb', 'micro']) {
      const base = photo.variants && photo.variants[kind] ? photo.variants[kind] : {};
      const variantStats = ps[kind] || {};
      const views = Math.max(0, Number(base.views != null ? base.views : variantStats.v) || 0);
      const bytes = Math.max(0, Number(base.bytes) || 0);
      variants[kind] = {
        ...base,
        views,
        bandwidthBytes: views * bytes,
        lastAt: Number(variantStats.lastAt) || 0,
        present: kind === 'full' ? true : base.ready !== false,
      };
      detailedTotalViews += views; detailedBandwidth += variants[kind].bandwidthBytes;
    }
    for (const variant of Object.values(variants)) variant.viewSharePct = detailedTotalViews ? Math.round((variant.views / detailedTotalViews) * 1000) / 10 : 0;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      token: photo.token,
      name: photo.name || '',
      createdAt: photo.createdAt || 0,
      expiresAt: photo.expiresAt || 0,
      active: photo.active !== false,
      expired: !!photo.expired,
      status: photo.status || (photo.active === false ? 'inactive' : 'active'),
      tags: Array.isArray(photo.tags) ? photo.tags : [],
      note: photo.note || '',
      maxViews: Math.max(0, Number(photo.maxViews) || 0),
      hasPassword: !!photo.hasPassword,
      totals: { ...(photo.totals || { views: 0, visitors: 0, bytes: 0 }), bandwidthBytes:detailedBandwidth },
      variants,
      recentViews: await detailedPhotoRecentViews(share, 50),
    });
  });

  app.get('/app/image/duplicate', (req, res) => {
    const hash = String(req.query.hash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) return res.status(400).json({ error: 'invalid-hash' });
    const share = managedPhotoCandidates().find((item) => item && item.type === 'photo' && (String(item.contentSha256 || '').toLowerCase() === hash || String(item.clientHash || '').toLowerCase() === hash) && canManagePwaImage(req, item));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ duplicate: !!share, image: share ? pwaPhotoPayload(req, share) : null });
  });

  app.post('/app/image/:token/settings', pwaJsonParser, async (req, res) => {
    const share = pwaPhotoByToken(req, req.params.token);
    if (!share) return res.status(404).json({ error: 'not-found' });
    const before = JSON.parse(JSON.stringify(share));
    const settingsResult=await applyPwaPhotoSettings(share,req.body); if(settingsResult.error){restorePlainObject(share,before);return sendPasswordWorkError(res,settingsResult.error);} const changed=settingsResult.changed;
    if (changed.length) {
      if (!persistNow()) { restorePlainObject(share, before); return res.status(503).json({ error:'write-error' }); }
      pwaAuditReq(req, 'image-edited', share.name + ': ' + changed.join(', '));
    }
    res.json({ ok: true, image: pwaPhotoPayload(req, share) });
  });

  app.post('/app/images/bulk', pwaJsonParser, async (req, res) => {
    const body = req.body || {};
    const tokens = [...new Set(Array.isArray(body.tokens) ? body.tokens.map(String) : [])].slice(0, 200);
    if (!tokens.length) return res.status(400).json({ error: 'empty' });
    const action = String(body.action || 'settings');
    const beforeState = JSON.parse(JSON.stringify(live.state));
    const revokedActivity = [];
    let count = 0;
    for (const token of tokens) {
      const share = pwaPhotoByToken(req, token);
      if (!share) continue;
      if (action === 'revoke') {
        const activity = { shareId:share.id, name:share.name, status:'deleted', detail:share.type||'photo', ...activityPrincipal(req) };
        const label='image '+(share.name||'');
        if (softDeleteShare(share.id, req, false, { type:'share-trashed', label })) {
          count += 1;
          revokedActivity.push(activity);
        }
      } else {
        const settingsResult=await applyPwaPhotoSettings(share,body.settings||body);
        if(settingsResult.error){live.state=beforeState;syncLiveActivityCache();reindex();shareLogicalBytesCache.clear();return sendPasswordWorkError(res,settingsResult.error);} if(settingsResult.changed.length)count+=1;
      }
    }
    if (count && !persistNow()) {
      live.state = beforeState; syncLiveActivityCache(); reindex(); shareLogicalBytesCache.clear();
      return res.status(503).json({ error:'write-error' });
    }
    // softDeleteShare(..., false) deliberately defers persistence and therefore
    // cannot publish activity itself. Publish only after the whole batch commits,
    // otherwise a failed bulk revoke would leave phantom deletion events behind.
    if (action === 'revoke') for (const activity of revokedActivity) emitLiveActivity('trash', activity);
    if (count) pwaAuditReq(req, action === 'revoke' ? 'photos-bulk-revoked' : 'photos-bulk-edited', `via PWA — ${count}/${tokens.length}`);
    res.json({ ok: true, count });
  });

  // Push, inbox creation and image-management routes

  app.get('/app/albums', (req, res) => {
    const albums = listShares().filter((s) => s && s.type === 'album' && canManagePwaAlbum(req, s))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((s) => pwaAlbumPayload(req, s));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ albums });
  });

  app.post('/app/albums', pwaJsonParser, async (req, res) => {
    const body = req.body || {};
    const tokens = [...new Set(Array.isArray(body.tokens) ? body.tokens.map(String) : [])].slice(0, 500);
    const members = tokens.map((token) => pwaPhotoByToken(req, token)).filter(Boolean).map((s) => s.token);
    if (!members.length) return res.status(400).json({ error: 'no-images' });
    const name = String(body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120) || 'Album';
    const album = { type: 'album', name, members, expiresAt: parseNewShareExpiry(body.expiresInSeconds) };
    stampPwaRecordOwner(req, album);
    if (typeof body.password === 'string' && body.password) { const protectedShare = await makeSharePassword(body.password.slice(0, 256)); if (protectedShare.error) return sendPasswordWorkError(res, protectedShare.error); Object.assign(album, protectedShare); }
    const tags = normalizeTags(body.tags || []); if (tags.length) album.tags = tags;
    const note = String(body.note || '').trim().slice(0, 1000); if (note) album.adminNote = note;
    const rec = addShare(album, req);
    pwaAuditReq(req, 'album-created', `via PWA — ${rec.name} · ${members.length} image(s)`);
    res.status(201).json({ album: pwaAlbumPayload(req, rec) });
  });

  app.post('/app/album/:token/settings', pwaJsonParser, async (req, res) => {
    const album = getByToken(String(req.params.token || ''));
    if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
    const before = JSON.parse(JSON.stringify(album));
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = String(body.name || '').replace(/[\r\n\t/\\]+/g, ' ').trim().slice(0, 120);
      if (name) album.name = name;
    }
    if (body.expiresInSeconds !== undefined) album.expiresAt = parseExpiry(body.expiresInSeconds);
    if (typeof body.password === 'string') {
      if (body.password) { const protectedShare = await makeSharePassword(body.password.slice(0, 256)); if (protectedShare.error) { for (const key of Object.keys(album)) delete album[key]; Object.assign(album, before); return sendPasswordWorkError(res, protectedShare.error); } Object.assign(album, protectedShare); }
      else { delete album.pwHash; delete album.pwSalt; }
    }
    const tags = body.tags !== undefined ? normalizeTags(body.tags) : null;
    if (tags) { if (tags.length) album.tags = tags; else delete album.tags; }
    if (typeof body.note === 'string') { const note = body.note.trim().slice(0, 1000); if (note) album.adminNote = note; else delete album.adminNote; }
    if (!persistNow()) { for (const key of Object.keys(album)) delete album[key]; Object.assign(album, before); return res.status(503).json({ error:'write-error' }); }
    pwaAuditReq(req, 'album-edited', `via PWA — ${album.name || album.id}`);
    res.json({ ok: true, album: pwaAlbumPayload(req, album) });
  });

  app.get('/app/album/:token/invitations', (req, res) => {
    const album = getByToken(String(req.params.token || ''));
    if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ invitations: (album.collaborators || []).map(publicAlbumInvite) });
  });

  app.post('/app/album/:token/invitations', pwaJsonParser, (req, res) => {
    const album = getByToken(String(req.params.token || ''));
    if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
    const body = req.body || {};
    const role = ['reader', 'contributor', 'manager'].includes(String(body.role)) ? String(body.role) : 'contributor';
    const secret = crypto.randomBytes(32).toString('base64url');
    const entry = {
      id: crypto.randomBytes(8).toString('hex'), tokenHash: albumInviteHash(secret), role,
      label: String(body.label || role).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80), createdAt: Date.now(),
      expiresAt: parseExpiry(body.expiresInSeconds), maxFiles: Math.max(0, Math.min(10000, Math.floor(Number(body.maxFiles) || 0))),
      maxFileBytes: Math.max(0, Math.min(IMAGE_MAX_BYTES, Math.floor(Number(body.maxFileBytes) || 0))), usedFiles: 0,
    };
    if (!Array.isArray(album.collaborators)) album.collaborators = [];
    album.collaborators.push(entry);
    if (!persistNow()) { album.collaborators = album.collaborators.filter((x) => x !== entry); return res.status(503).json({ error:'write-error' }); }
    pwaAuditReq(req, 'album-invitation-created', `via PWA — ${album.name || album.id} · ${entry.role}${entry.label ? ' · ' + entry.label : ''}`);
    const base = getSettings().imageBase || primaryBase(req) || '';
    res.status(201).json({ invitation: publicAlbumInvite(entry), url: base + '/g/' + album.token + '/c/' + secret });
  });

  app.post('/app/album/:token/invitations/:id/revoke', pwaJsonParser, (req, res) => {
    const album = getByToken(String(req.params.token || ''));
    if (!canManagePwaAlbum(req, album)) return res.status(404).json({ error: 'not-found' });
    const entry = (album.collaborators || []).find((x) => x && x.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'not-found' });
    const beforeDisabled = !!entry.disabled, beforeRevokedAt = entry.revokedAt;
    entry.disabled = true; entry.revokedAt = Date.now();
    if (!persistNow()) { entry.disabled = beforeDisabled; if (beforeRevokedAt == null) delete entry.revokedAt; else entry.revokedAt = beforeRevokedAt; return res.status(503).json({ error:'write-error' }); }
    pwaAuditReq(req, 'album-invitation-revoked', `via PWA — ${album.name || album.id} · ${entry.role}${entry.label ? ' · ' + entry.label : ''}`);
    res.json({ ok: true });
  });

  app.get('/app/images/retention', (req, res) => {
    const key = primaryPwaOwnerKey(req); if (!key) return res.status(403).json({ error: 'owner-required' });
    const rules = normalizePwaRetentionRules(pwaRetentionRuleStore()[key]);
    const owned = listShares().filter((s) => s && s.type === 'photo' && ownerKeyForPhoto(s) === key);
    const bytes = owned.reduce((n, p) => n + photoManagedBytes(p), 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ rules, summary: { images: owned.length, bytes } });
  });

  app.post('/app/images/retention', pwaJsonParser, async (req, res) => {
    const key = primaryPwaOwnerKey(req); if (!key) return res.status(403).json({ error: 'owner-required' });
    const rules = normalizePwaRetentionRules(req.body || {});
    const store = pwaRetentionRuleStore();
    const hadPrevious = Object.prototype.hasOwnProperty.call(store, key);
    const previous = hadPrevious ? JSON.parse(JSON.stringify(store[key])) : null;
    store[key] = rules;
    if (!persistNow()) {
      if (hadPrevious) store[key] = previous; else delete store[key];
      return res.status(503).json({ error:'write-error' });
    }
    const result = req.body && req.body.runNow ? await runPwaImageRetentionForOwner(key, rules) : { checked: 0, revoked: 0, bytesFreed: 0, reasons: {}, persisted:true };
    if (result.persisted === false) return res.status(503).json({ ok:false, error:'write-error', rules, result });
    pwaAuditReq(req, 'image-retention-rules-changed', `via PWA — ${rules.enabled ? 'enabled' : 'disabled'}${req.body && req.body.runNow ? ' · run=' + result.revoked + '/' + result.checked : ''}`);
    res.json({ ok: true, rules, result });
  });

  app.get('/app/images/dashboard', (req, res) => {
    const now = Date.now();
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
    const currentDays = localDayKeys(now, days);
    const currentStart = currentDays[0].at;
    const previousEnd = new Date(currentStart); previousEnd.setDate(previousEnd.getDate() - 1);
    const previousDays = localDayKeys(previousEnd.getTime(), days);
    const previousStart = previousDays[0].at;
    const currentIndex = new Map(currentDays.map((d, i) => [d.key, i]));
    const previousKeys = new Set(previousDays.map((d) => d.key));
    const series = currentDays.map((d) => ({ at: d.at, created: 0, views: 0 }));
    const photos = listShares().filter((s) => s && s.type === 'photo' && canManagePwaImage(req, s));
    let totalViews = 0, totalVisitors = 0, totalBytes = 0, dailyChanged = false;
    const comparison = { days, current: { created: 0, views: 0 }, previous: { created: 0, views: 0 } };
    for (const photo of photos) {
      const ps = photoStatsOf(photo);
      const views = (ps.full.v || 0) + (ps.thumb.v || 0) + (ps.micro.v || 0);
      totalViews += views;
      const visitors = new Set();
      for (const st of [ps.full, ps.thumb, ps.micro]) if (Array.isArray(st.u)) for (const ip of st.u) visitors.add(ip);
      totalVisitors += visitors.size;
      totalBytes += Math.max(0, Number(photo.size) || 0) + Math.max(0, Number(photo.thumbSize) || 0) + Math.max(0, Number(photo.microSize) || 0);
  
      const createdAt = Number(photo.createdAt) || 0;
      if (createdAt >= currentStart && createdAt <= now) {
        const idx = currentIndex.get(localDayKey(createdAt));
        if (idx != null) series[idx].created += 1;
        comparison.current.created += 1;
      } else if (createdAt >= previousStart && createdAt < currentStart) comparison.previous.created += 1;
  
      const dailyState = ensurePhotoDailyViews(photo, now); if (dailyState.changed) dailyChanged = true;
      for (const [key, rawCount] of Object.entries(dailyState.daily)) {
        const count = Math.max(0, Number(rawCount) || 0); if (!count) continue;
        const idx = currentIndex.get(key);
        if (idx != null) { series[idx].views += count; comparison.current.views += count; }
        else if (previousKeys.has(key)) comparison.previous.views += count;
      }
    }
    if (dailyChanged) scheduleFlush();
    const pct = (cur, prev) => prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : (cur > 0 ? null : 0);
    comparison.changes = {
      created: { delta: comparison.current.created - comparison.previous.created, pct: pct(comparison.current.created, comparison.previous.created) },
      views: { delta: comparison.current.views - comparison.previous.views, pct: pct(comparison.current.views, comparison.previous.views) },
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json({ totals: { images: photos.length, views: totalViews, visitors: totalVisitors, bytes: totalBytes }, series, comparison, generatedAt: now });
  });

  app.get('/app/image/:token/versions', (req, res) => {
    const photo = pwaPhotoByToken(req, req.params.token); if (!photo) return res.status(404).json({ error: 'not-found' });
    res.setHeader('Cache-Control', 'no-store'); res.json({ current:{ name:photo.name,size:photo.size||0,w:photo.w||null,h:photo.h||null,revision:photoCacheRevision(photo) }, versions: (photo.versions || []).map((v) => ({ id: v.id, at: v.at, name: v.name, size: v.size, w: v.w, h: v.h, metadataRemoved: !!v.metadataRemoved, original:!!v.original, reason:v.reason||'edit', operations:Array.isArray(v.operations)?v.operations:[] })), history:Array.isArray(photo.editHistory)?photo.editHistory.slice(0,50):[] });
  });

  app.get('/app/image/:token/versions/:versionId/preview', (req,res) => {
    const photo=pwaPhotoByToken(req,req.params.token); if(!photo)return res.status(404).end();
    const version=(photo.versions||[]).find((v)=>v.id===req.params.versionId); if(!version)return res.status(404).end();
    const file=firstExistingPhotoFile([path.join(photoVersionDir(photo.token),version.id,'full.'+version.ext)]); if(!file)return res.status(404).end();
    return streamFile(req,res,file,version.name||('version.'+version.ext),null,null,{inline:true,cacheControl:'no-store'});
  });

  app.post('/app/image/:token/restore/:versionId', pwaJsonParser, (req, res) => {
    (async () => {
      const photo = pwaPhotoByToken(req, req.params.token); if (!photo) return res.status(404).json({ error: 'not-found' });
      const mutationKey=String(photo.id);
      if(adminPhotoFullWrites.has(mutationKey)||adminPhotoHasVariantWrite(mutationKey))return res.status(409).json({error:'image-busy'});
      adminPhotoFullWrites.add(mutationKey); let mutationReleased=false; const releaseMutation=()=>{if(!mutationReleased){mutationReleased=true;adminPhotoFullWrites.delete(mutationKey);}}; res.once('finish',releaseMutation);res.once('close',releaseMutation);
      const version = (photo.versions || []).find((v) => v.id === req.params.versionId); if (!version) return res.status(404).json({ error: 'version-not-found' });
      let tx;
      try { tx = restorePhotoVersion(photo, version); }
      catch (e) { return res.status(500).json({ error:'archive-failed' }); }
      if (!tx) return res.status(404).json({ error: 'version-not-found' });
      if (!persistNow()) {
        for (const key of Object.keys(photo)) delete photo[key]; Object.assign(photo, tx.before);
        if (tx.archivedVersion) { try { fs.rmSync(path.join(photoVersionDir(photo.token), tx.archivedVersion.id), { recursive:true, force:true }); } catch (_) {} }
        try { fs.unlinkSync(tx.newDest); } catch (_) {}
        return res.status(503).json({ error:'write-error' });
      }
      cleanupPhotoVersionStorage(photo);
      try { await unlinkManagedPathsStrict(tx.oldManagedPaths); }
      catch (e) { console.error('[pwa-photo-restore] old file cleanup failed:', e && e.message); }
      pwaAuditReq(req, 'image-version-restored', `via PWA — ${photo.name || photo.token} · ${version.id}`);
      res.json({ ok: true, image: pwaPhotoPayload(req, photo) });
    })().catch((e) => { console.error('[pwa-photo-restore]', e && e.message); if (!res.headersSent) res.status(500).json({ error:'restore-failed' }); });
  });

  app.post('/app/image/:token/replace', (req, res) => {
    const photo = pwaPhotoByToken(req, req.params.token); if (!photo) return res.status(404).json({ error: 'not-found' });
    const mutationKey=String(photo.id);
    if(adminPhotoFullWrites.has(mutationKey)||adminPhotoHasVariantWrite(mutationKey)){req.resume();return res.status(409).json({error:'image-busy'});}
    adminPhotoFullWrites.add(mutationKey); let mutationReleased=false; const releaseMutation=()=>{if(!mutationReleased){mutationReleased=true;adminPhotoFullWrites.delete(mutationKey);}}; res.once('finish',releaseMutation);res.once('close',releaseMutation);
    let ext = (String(req.query.name || photo.name || 'image.jpg').split('.').pop() || '').toLowerCase(); if (ext === 'jpeg') ext = 'jpg';
    if (!PWA_IMG_EXT.test(ext)) return res.status(400).json({ error: 'not-image' });
    const fname = crypto.randomBytes(12).toString('hex') + '.' + ext; const dest = path.join(FULL_IMAGES_DIR, fname);
    streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size, sha256) => {
      // ASVS V5.2.6: reject pixel-flood images (small file, enormous decoded pixel area).
      const dxPix = imageDimensions(dest); if (dxPix && dxPix.w * dxPix.h > IMAGE_MAX_PIXELS) { fs.unlink(dest, () => {}); return res.status(413).json({ error:'image-too-many-pixels', maxPixels: IMAGE_MAX_PIXELS }); }
      (async () => {
        let metadata;
        try { metadata = await enforceL3PwaImageMetadataPolicy(req, dest, ext, size, sha256); }
        catch (error) {
          fs.unlink(dest, () => {});
          if (error && error.code === 'image-metadata-consent-required') return res.status(422).json({ error:error.code, consentParameter:'metadataConsent' });
          return res.status(422).json({ error:(error && error.code) || 'image-metadata-sanitization-failed' });
        }
        const finalSize = metadata.size;
        const finalSha256 = metadata.sha256;
        const nextName = String(req.query.name || photo.name).replace(/[\/\r\n\t]+/g, ' ').trim().slice(0, 120) || photo.name;
        let scan = null;
        if (getSettings().dlpEnabled !== false) {
          scan = await dlpScanStoredFile(dest, nextName);
          const dlpBody = { dlpOverride:/^(1|true|yes|on)$/i.test(String(req.query.dlpOverride || '')) };
          if (dlpDecision(req, res, dlpBody, scan, 'pwa-photo-replace', { file:dest, name:nextName })) { fs.unlink(dest, () => {}); return; }
        }
        const hashLock = await acquireManagedPhotoHashResponseLock(res, finalSha256); if (!hashLock) { fs.unlink(dest, () => {}); return; }
        const duplicate = await findManagedPhotoDuplicateDeep(req, finalSha256, finalSize, { pwa:true, excludeId:photo.id });
        if (duplicate && !/^(1|true|yes|on)$/i.test(String(req.query.duplicateOverride || ''))) { fs.unlink(dest, () => {}); return res.status(409).json({ error:'duplicate-content', duplicate:duplicatePhotoPayload(duplicate,req,true), sha256:finalSha256 }); }
        const before = JSON.parse(JSON.stringify(photo));
        const oldManagedPaths = [...photoOriginalPaths(photo), ...photoVariantPaths(photo.token, 'thumb'), ...photoVariantPaths(photo.token, 'micro'), photoAdaptivePath(photo.token, 'webp'), photoAdaptivePath(photo.token, 'avif')];
        const editOperations = cleanPhotoEditOperations(req.query.ops);
        let archivedVersion = null;
        try { archivedVersion = archiveCurrentPhotoVersion(photo, { reason:'edit', operations:editOperations }); } catch (e) { fs.unlink(dest, () => {}); return res.status(500).json({ error: 'archive-failed' }); }
        photo.imgPath = fname; photo.ext = ext; photo.size = finalSize; photo.contentSha256 = finalSha256; photo.name = nextName;
        if (metadata.metadataRemoved) photo.metadataRemoved = true; else delete photo.metadataRemoved; if (metadata.metadataRetentionConsentAt) photo.metadataRetentionConsentAt = metadata.metadataRetentionConsentAt; else delete photo.metadataRetentionConsentAt;
        const dims = imageDimensions(dest); if (dims) { photo.w = dims.w; photo.h = dims.h; }
        delete photo.thumb; delete photo.micro; delete photo.adaptiveWebp; delete photo.adaptiveAvif; delete photo.thumbSize; delete photo.microSize; delete photo.thumbW; delete photo.thumbH; delete photo.microW; delete photo.microH; delete photo.thumbMetaMtimeMs; delete photo.microMetaMtimeMs;
        photo.replacedAt = Date.now();
        bumpPhotoCacheRevision(photo);
        addPhotoEditHistory(photo, 'edit', editOperations.length ? editOperations : ['replace'], { from:{w:before.w||null,h:before.h||null,size:before.size||0}, to:{w:photo.w||null,h:photo.h||null,size:photo.size||0} });
        applyDlpSummary(photo, scan);
        if (!persistNow()) {
          for (const key of Object.keys(photo)) delete photo[key]; Object.assign(photo, before);
          if (archivedVersion) { try { fs.rmSync(path.join(photoVersionDir(photo.token), archivedVersion.id), { recursive:true, force:true }); } catch (_) {} }
          try { fs.unlinkSync(dest); } catch (_) {}
          return res.status(503).json({ error:'write-error' });
        }
        cleanupPhotoVersionStorage(photo);
        try { await unlinkManagedPathsStrict(oldManagedPaths); } catch (e) { console.error('[pwa-photo-replace] old file cleanup failed:', e && e.message); }
        addShareCenterNotification(photo,'image-full-replaced',{name:photo.name,bytes:finalSize,dedupeKey:`image-replaced:${photo.id}:${photo.replacedAt}`});
        pwaAuditReq(req, 'image-replaced', `via PWA — ${photo.name || photo.token} · ${finalSize} bytes`);
        res.json({ ok: true, image: pwaPhotoPayload(req, photo), dlp:scan });
      })().catch(() => { fs.unlink(dest, () => {}); if (!res.headersSent) res.status(500).json({ error:'dlp-scan-failed' }); else res.destroy(); });
    });
  });

  app.post('/app/image/:token/adaptive/:format', (req, res) => {
    const photo = pwaPhotoByToken(req, req.params.token); const fmt = String(req.params.format || '').toLowerCase();
    if (!photo || !/^(webp|avif)$/.test(fmt)) { req.resume(); return res.status(404).json({ error: 'not-found' }); }
    return handlePhotoAdaptiveUpload(req,res,photo,fmt,IMAGE_MAX_BYTES);
  });

  app.post('/app/image', (req, res) => {
    let ext = (String(req.query.name || 'image.jpg').split('.').pop() || '').toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (!PWA_IMG_EXT.test(ext)) return res.status(400).json({ error: 'not-image' });
    const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
    const dest = path.join(FULL_IMAGES_DIR, fname);
    streamToFileBounded(req, res, dest, IMAGE_MAX_BYTES, (size, sha256) => {
      // ASVS V5.2.6: reject pixel-flood images (small file, enormous decoded pixel area).
      const dxPix = imageDimensions(dest); if (dxPix && dxPix.w * dxPix.h > IMAGE_MAX_PIXELS) { fs.unlink(dest, () => {}); return res.status(413).json({ error:'image-too-many-pixels', maxPixels: IMAGE_MAX_PIXELS }); }
      (async () => {
        let metadata;
        try { metadata = await enforceL3PwaImageMetadataPolicy(req, dest, ext, size, sha256); }
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
          if (dlpDecision(req, res, dlpBody, scan, 'pwa-photo-create', { file:dest, name })) { fs.unlink(dest, () => {}); return; }
        }
        const hashLock = await acquireManagedPhotoHashResponseLock(res, finalSha256); if (!hashLock) { fs.unlink(dest, () => {}); return; }
        const duplicate = await findManagedPhotoDuplicateDeep(req, finalSha256, finalSize, { pwa:true });
        if (duplicate && !/^(1|true|yes|on)$/i.test(String(req.query.duplicateOverride || ''))) { fs.unlink(dest, () => {}); return res.status(409).json({ error:'duplicate-content', duplicate:duplicatePhotoPayload(duplicate,req,true), sha256:finalSha256 }); }
        const fileDims = imageDimensions(dest);
        const queryW = Math.max(0, Math.min(100000, parseInt(req.query.w, 10) || 0));
        const queryH = Math.max(0, Math.min(100000, parseInt(req.query.h, 10) || 0));
        const dims = queryW && queryH ? { w: queryW, h: queryH } : fileDims;
        const share = { type: 'photo', name, imgPath: fname, ext, size:finalSize, contentSha256:finalSha256 };
        if (metadata.metadataRemoved) share.metadataRemoved = true; if (metadata.metadataRetentionConsentAt) share.metadataRetentionConsentAt = metadata.metadataRetentionConsentAt;
        applyDlpSummary(share, scan);
        stampPhotoUploadDevice(share, req, 'pwa');
        const clientHash = String(req.query.clientHash || '').toLowerCase();
        if (/^[a-f0-9]{64}$/.test(clientHash)) share.clientHash = clientHash;
        if (dims) { share.w = dims.w; share.h = dims.h; }
        pwaImgOwner(req, share);
        const rec = addShareDurable(share, req);
        if (!rec) { try { fs.unlinkSync(dest); } catch (_) {} return res.status(503).json({ error:'write-error', persisted:false }); }
        const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
        logAudit('image-created', { username: who, ip: clientIp(req), detail: 'via PWA — ' + name });
        res.status(201).json({ ...pwaImageCreatePayload(req, rec), dlp:scan });
      })().catch(() => { fs.unlink(dest, () => {}); if (!res.headersSent) res.status(500).json({ error:'dlp-scan-failed' }); else res.destroy(); });
    });
  });

  app.post('/app/image/:token/thumb', (req, res) => {
    const s = getByToken(req.params.token);
    if (!s || s.type !== 'photo' || !canManagePwaImage(req, s)) { req.resume(); return res.status(404).json({ error: 'not-found' }); }
    return handleAdminPhotoVariantUpload(req,res,s,'thumb',THUMB_MAX_BYTES);
  });

  app.post('/app/image/:token/micro', (req, res) => {
    const s = getByToken(req.params.token);
    if (!s || s.type !== 'photo' || !canManagePwaImage(req, s)) { req.resume(); return res.status(404).json({ error: 'not-found' }); }
    return handleAdminPhotoVariantUpload(req,res,s,'micro',MICRO_MAX_BYTES);
  });

  app.post('/app/share/:token/revoke', pwaJsonParser, (req, res) => {
    const s = getByToken(req.params.token);
    // The PWA lists collaboration links next to file/folder shares and exposes the
    // same Revoke action for them, so the server contract must accept them too.
    const revocableTypes = ['photo', 'inbox', 'collab', 'file', 'folder'];
    if (!s || !revocableTypes.includes(s.type) || !canManagePwaImage(req, s)) {
      // Revocation is durable before the response is sent. If that final response is
      // lost, the browser may retry while the record is already in recoverable trash.
      // Treat that authorized retry as success instead of a misleading 404/failure.
      const alreadyRevoked = trashItems().find((record) => {
        const share = record && record.share;
        return !!(share && share.token === req.params.token && revocableTypes.includes(share.type) && canManagePwaImage(req, share));
      });
      if (alreadyRevoked) {
        return res.json({ ok: true, alreadyRevoked: true, recoverable: true, trashId: alreadyRevoked.id });
      }
      return res.status(404).json({ error: 'not-found' });
    }
    const kind = s.type === 'photo' ? 'image' : s.type === 'inbox' ? 'reception' : 'share';
    const label = kind + ' ' + (s.name || '');
    const revoked = softDeleteShare(s.id, req, true, { type:'share-trashed', label });
    if (revoked === false) return res.status(503).json({ error:'write-error' });
    if (!revoked) return res.status(404).json({ error: 'not-found' });
    const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice ? 'PWA: ' + req.pwaDevice.name : 'PWA');
    logAudit('share-revoked', { username: who, ip: clientIp(req), detail: 'via PWA — ' + label });
    res.json({ ok: true, recoverable: true, trashId: revoked.id });
  });

  app.get('/app/host/browse', async (req, res) => {
    if (!pwaHostAdminSession(req, res)) return;
    const reqPath = String(req.query.path || '/');
    let absDir;
    try {
      absDir = hostToContainer(reqPath);
      await assertRealWithin(HOST_ROOT, absDir);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'host-inaccessible', root: '/' });
      return res.status(400).json({ error: 'invalid-path' });
    }
    let st;
    try { st = await fs.promises.stat(absDir); } catch (_) { return res.status(404).json({ error: 'not-found' }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'not-a-folder' });
    let dirents;
    try { dirents = await fs.promises.readdir(absDir, { withFileTypes: true }); } catch (_) { return res.status(403).json({ error: 'read-failed' }); }
    const entries = [];
    for (const d of dirents) {
      const isDir = d.isDirectory();
      const isFile = d.isFile();
      if (!isDir && !isFile) continue;
      entries.push({
        name: d.name,
        isDir,
        isFile,
        size: null,
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal,javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
        // d.name is a dirent from fs.readdir(absDir) (absDir already validated), not user text.
        path: containerToHost(path.join(absDir, d.name)),
      });
    }
    const files = entries.filter((e) => e.isFile);
    await mapLimit(files, 32, async (e) => {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal,javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
      try { e.size = (await fs.promises.stat(path.join(absDir, e.name))).size; } catch (_) {}
    });
    entries.forEach((e) => delete e.isFile);
    const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : coll.compare(a.name, b.name)));
    const cwd = containerToHost(absDir);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ root: '/', cwd, parent: cwd === '/' ? null : containerToHost(path.dirname(absDir)), entries });
  });

  app.post('/app/host/shares', pwaJsonParser, async (req, res) => {
    if (!pwaHostAdminSession(req, res)) return;
    const body = req.body || {};
    const reqPaths = reqPathList(body);
    if (!reqPaths.length) return res.status(400).json({ error: 'missing-path' });
    let resolved;
    try { resolved = []; for (const p of reqPaths) resolved.push(await resolveHostItem(p)); }
    catch (e) { return res.status(e.code === 'not-found' ? 404 : 400).json({ error: e.code || 'invalid-path' }); }
    const first = resolved[0];
    const type = resolved.length > 1 ? 'file' : first.type; // a multi-select bundle is a 'file' collection
    const share = {
      type,
      hostPath: first.hostPath,
      name: first.name || first.hostPath || 'share',
      size: type === 'file' ? first.size : null,
      expiresAt: parseNewShareExpiry(body.expiresInSeconds),
      maxDownloads: parseMaxDownloads(body.maxDownloads),
    };
    if (share.expiresAt) share.expirySetAt = Date.now();
    const pwaFirstUseExpirySeconds = getSettings().newSharesNeverExpire ? 0 : boundedSeconds(body.firstUseExpirySeconds); if (pwaFirstUseExpirySeconds) share.firstUseExpirySeconds = pwaFirstUseExpirySeconds;
    const parsedPwaRate = parseLinkRateKBps(body.rateKBps, { optional:true });
    if (!parsedPwaRate.ok) return res.status(400).json({ error:'invalid-rate' });
    const pwaRateKBps = parsedPwaRate.value; if (pwaRateKBps > 0) share.rateBps = pwaRateKBps * 1024;
    if (body.burnAfterDownload === true) share.burnAfterDownload = true;
    if (type === 'file') share.items = resolved.map((it) => ({ hostPath: it.hostPath, name: it.name, size: it.size, type: it.type }));
    if (resolved.length > 1) share.collection = true;
    const password = String(body.password || '');
    // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
    if (password) { const protectedShare = await makeSharePassword(password); if (protectedShare.error) return sendPasswordWorkError(res, protectedShare.error); Object.assign(share, protectedShare); }
    if (typeof body.note === 'string') {
      const note = body.note.replace(/\r\n/g, '\n').trim().slice(0, 2000);
      if (note) share.note = note;
    }
    const maxVisitors = parseMaxVisitors(body.maxVisitors);
    if (maxVisitors > 0) share.maxVisitors = maxVisitors;
    // 1.51.0 — PWA parity with the standard dashboard's organization metadata.
    if (body.color !== undefined) {
      const color = normalizeShareColor(body.color);
      if (color === null) return res.status(400).json({ error:'invalid-color' });
      if (color) share.color = color;
    }
    if (typeof body.adminNote === 'string') {
      const adminNote = body.adminNote.replace(/\r\n?/g, '\n').trim().slice(0, 1000);
      if (adminNote) share.adminNote = adminNote;
    }
    if (getSettings().dlpEnabled !== false) {
      const scan = await dlpScanResolvedItems(resolved);
      // A PWA can explicitly confirm a warn policy by resubmitting dlpOverride=true.
      if (dlpDecision(req, res, body, scan, 'pwa-share-create')) return;
      applyDlpSummary(share, scan);
    }
    stampPwaRecordOwner(req, share);
    const rec = addShare(share, req);
    const who = (req.pwaSession && req.pwaSession.username) || 'PWA';
    logAudit('share-created', { username: who, ip: clientIp(req), detail: 'via PWA — ' + share.type + ' ' + (share.name || '') });
    res.status(201).json({ share: decorateShare(rec, req) });
  });

  app.post('/app/host/shares/:token/rate', pwaJsonParser, (req, res) => {
    const session = pwaHostAdminSession(req, res); if (!session) return;
    const share = getByToken(req.params.token);
    if (!share || !['file','folder','web-storage'].includes(share.type)) return res.status(404).json({ error:'not-found' });
    if (session.role === 'operator' && String(share.ownerId || '') !== String(session.accountId || '')) return res.status(403).json({ error:'forbidden' });
    const parsedRate = parseLinkRateKBps(req.body && req.body.rateKBps);
    if (!parsedRate.ok) return res.status(400).json({ error:'invalid-rate' });
    const rateKBps = parsedRate.value;
    const before = Math.max(0, Math.round(Number(share.rateBps || 0) / 1024));
    const beforeFull = JSON.parse(JSON.stringify(share));
    const beforeSnapshot = shareChangeSnapshot(share);
    if (rateKBps > 0) share.rateBps = rateKBps * 1024; else delete share.rateBps;
    if (before !== rateKBps) {
      recordShareChange(share, req, 'edited', ['rateKBps'], beforeSnapshot);
      if (!persistNow()) {
        restorePlainObject(share, beforeFull);
        return res.status(503).json({ error:'write-error' });
      }
      logAudit('share-edited', { username:session.username || 'PWA', ip:clientIp(req), detail:`via PWA — ${share.name || share.id}: rateKBps ${before} → ${rateKBps}` });
    }
    res.json({ ok:true, rateKBps, share:decorateShare(share, req) });
  });

  app.get('/app/host/shares', (req, res) => {
    // Listing existing links is read-only, so an admin's paired device may see them even
    // without a live session (unlike FS browse / create above, which stay session-only).
    if (!pwaViewerIsAdmin(req)) return res.status(403).json({ error: 'admin-required' });
    const source = live.state.shares
      .filter((s) => s && (s.type === 'file' || s.type === 'folder' || s.type === 'collab' || s.type === 'web-storage') && canManagePwaImage(req, s));
    const pending = source.filter((s) => shareNeedsLogicalBytesScan(s) && !shareLogicalBytesCache.get(s.id));
    if (pending.length) void mapLimit(pending, 2, (s) => queueShareLogicalBytesRefresh(s)).catch(() => {});
    const list = source
      .map((s) => decorateShare(s, req))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 500);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ shares: list, metricsPending:pending.length > 0 });
  });

  app.get('/app/host/shares/:token/stats-detail', async (req, res) => {
    const share = getByToken(req.params.token);
    if (!pwaCanManageHostShare(req, share)) return res.status(404).json({ error:'not-found' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await detailedShareStatsPayload(share, req));
    } catch (e) {
      console.error('[pwa share stats-detail] failed:', e && e.message);
      res.status(500).json({ error:'stats-failed' });
    }
  });

  app.post('/app/host/shares/:token/meta', pwaJsonParser, (req, res) => {
    const share = getByToken(req.params.token);
    if (!pwaCanManageHostShare(req, share)) return res.status(404).json({ error:'not-found' });
    const body = req.body || {}, beforeFull = JSON.parse(JSON.stringify(share)), before = shareChangeSnapshot(share), changed = [];
    if (body.color !== undefined) {
      const color = normalizeShareColor(body.color); if (color === null) return res.status(400).json({ error:'invalid-color' });
      if (color !== (share.color || '')) { if (color) share.color=color; else delete share.color; changed.push('color'); }
    }
    if (typeof body.adminNote === 'string') {
      const note = body.adminNote.replace(/\r\n?/g,'\n').trim().slice(0,1000);
      if (note !== (share.adminNote || '')) { if (note) share.adminNote=note; else delete share.adminNote; changed.push('adminNote'); }
    }
    if (typeof body.archived === 'boolean' && body.archived !== !!share.archived) {
      if (body.archived) share.archived=true; else delete share.archived; changed.push('archived');
    }
    if (typeof body.pinned === 'boolean' && body.pinned !== !!share.pinned) {
      if (body.pinned) share.pinned=true; else delete share.pinned; changed.push('pinned');
    }
    if (!changed.length) return res.json({ ok:true, share:decorateShare(share, req) });
    recordShareChange(share, req, 'edited', changed, before);
    if (!persistNow()) { restorePlainObject(share, beforeFull); return res.status(503).json({ error:'write-error' }); }
    scheduleSearchReindex();
    const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice&&('PWA: '+req.pwaDevice.name))||'PWA';
    logAudit('share-edited',{username:who,ip:clientIp(req),detail:'via PWA — '+(share.name||share.id)+': '+changed.join(', ')});
    res.json({ ok:true, share:decorateShare(share, req) });
  });

  app.post('/app/host/shares/:token/reactivate', pwaJsonParser, async (req, res) => {
    const share = getByToken(req.params.token);
    if (!pwaCanManageHostShare(req, share)) return res.status(404).json({ error:'not-found' });
    const result = await reactivateRevokedShare(share, req);
    if (!result.ok) return res.status(result.status || 400).json({ error:result.error || 'reactivate-failed' });
    const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice&&('PWA: '+req.pwaDevice.name))||'PWA';
    logAudit('share-reactivated',{username:who,ip:clientIp(req),detail:'via PWA — '+(share.name||share.id)});
    res.json({ ok:true, share:decorateShare(share, req) });
  });

  app.post('/app/host/shares/:token/clone', pwaJsonParser, async (req, res) => {
    const source = getByToken(req.params.token);
    if (!pwaCanManageHostShare(req, source)) return res.status(404).json({ error:'not-found' });
    // Match the standard dashboard: encrypted links are intentionally not cloned.
    // Reusing the same encrypted payload/key metadata under a second token would make
    // the two links share lifecycle-sensitive ciphertext state.
    if (source.encrypted) return res.status(400).json({ error:'cannot-clone' });
    const availability = await shareReactivationAvailability(source);
    if (!availability.available) return res.status(409).json({ error:'data-missing' });
    const body=req.body||{};
    const requested=String(body.name||'').replace(/[\r\n\t]+/g,' ').trim().slice(0,200);
    const name=requested||((source.name||'Share')+' (copy)').slice(0,200);
    const clone=JSON.parse(JSON.stringify(source));
    for(const key of ['id','token','createdAt','downloads','revoked','disabled','burnedAt','burnedReason','visitors','views','messages','pending','recipients','ownerId','ownerName','ownerDeviceId','pstats','bytesReceived','pinned','archived','autoArchivedAt','favorite','changeHistory','lastViewAt','lastUseAt','lastDownload','lastUpload','firstUsedAt','firstUseExpiresAt','firstUseExpiryWarnedDeadline','expirySetAt','inactiveExpiryWarnedDeadline','statsBaseline','adminComments','editedAt','firstViewNotifiedAt','firstViewKind','firstViewIp','firstViewPushPending','firstViewPushQueuedAt','firstViewPushAcceptedAt','downloadThresholdNotifiedAt','centerFirstDepositAt','centerProtectedFirstAccessAt','centerNotificationCountries','centerViewMilestones','centerDownloadMilestones','centerVisitorAgents','centerExpiredDeadline','receivedHashes','senderStats','webStorageUploaded','expiryWarnedAt','downloadLimitReachedAt','ipDownloads','bytesServed','firstViewPushAcceptedCount','centerFileSignature','centerFileFingerprint','retentionReason','retentionRevokedAt']) delete clone[key];
    clone.name=name; clone.downloads=0; clone.revoked=false;
    let freshDir=null;
    try {
      if(source.type==='collab'&&!source.webStorage){
        const base=name.replace(/[^A-Za-z0-9 _.-]/g,'_').replace(/^\.+/,'').trim().slice(0,50)||'collab';
        clone.relDir=base+'-'+crypto.randomBytes(3).toString('hex'); clone.bytesReceived=0;
        freshDir=resolveWithin(INBOX_DIR,clone.relDir); await fs.promises.mkdir(freshDir,{recursive:true});
      }
      if(source.type==='collab'&&source.webStorage){delete clone.relDir;clone.bytesReceived=0;clone.allowZip=false;}
      stampPwaRecordOwner(req,clone);
      applyNewShareLifetimePolicy(clone);
      const rec=addShare(clone,req,{action:'created-from-duplicate',fields:['name'],before:{name:source.name||''}},false);
      if(!persistNow()){detachActiveShare(rec);throw Object.assign(new Error('write-error'),{code:'WRITE_ERROR'});}
      scheduleSearchReindex();
      const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice&&('PWA: '+req.pwaDevice.name))||'PWA';
      logAudit('share-cloned',{username:who,ip:clientIp(req),detail:'via PWA — '+(source.name||source.id)+' → '+rec.id});
      res.status(201).json({ok:true,share:decorateShare(rec,req)});
    }catch(e){if(freshDir){try{await fs.promises.rmdir(freshDir);}catch(_){}}return res.status(e&&e.code==='WRITE_ERROR'?503:500).json({error:e&&e.code==='WRITE_ERROR'?'write-error':'clone-failed'});}
  });

  app.get('/app/trash', async (req, res) => {
    if (!req.pwaSession && !req.pwaDevice) return res.status(403).json({ error:'auth-required' });
    try {
      const items=await Promise.all(trashItems().filter((rec)=>rec&&rec.share&&canManagePwaImage(req,rec.share)).map(trashPublicRecord));
      res.setHeader('Cache-Control','no-store');
      res.json({items,retentionDays:Math.max(0,Number(getSettings().trashRetentionDays)||0),count:items.length,canPurge:pwaViewerIsAdmin(req),purgeSummary:{bytes:items.reduce((n,r)=>n+Math.max(0,Number(r.purgeImpact&&r.purgeImpact.bytes)||0),0),items:items.length,dependencies:items.reduce((n,r)=>n+Math.max(0,Number(r.purgeImpact&&r.purgeImpact.dependencyCount)||0),0)}});
    } catch (e) { console.error('[pwa trash] impact failed:',e&&e.message); res.status(500).json({error:'trash-impact-failed'}); }
  });

  app.post('/app/trash/:id/restore', pwaJsonParser, async (req, res) => {
    const list=trashItems(); const i=list.findIndex((r)=>r&&r.id===req.params.id);
    if(i<0||!list[i].share||!canManagePwaImage(req,list[i].share))return res.status(404).json({error:'not-found'});
    const original=JSON.parse(JSON.stringify(list[i])); const rec=list[i], assessment=await trashRestoreAssessment(rec);
    if(!assessment.available){
      const alternative=String(req.body&&req.body.alternativePath||'').trim();
      if(!alternative)return res.status(409).json({error:'restore-location-missing',assessment});
      try{if(!await applyTrashRestoreAlternative(rec.share,alternative))return res.status(400).json({error:'invalid-alternative',assessment});}
      catch(_){return res.status(400).json({error:'invalid-alternative',assessment});}
    }
    list.splice(i,1); const sh=restoreTrashRecord(rec);
    recordShareChange(sh,req,'restored',[],null);
    if(!persistNow()){detachActiveShare(sh);list.splice(Math.min(i,list.length),0,original);reindex();shareLogicalBytesCache.clear();return res.status(503).json({error:'write-error'});}
    scheduleSearchReindex();
    const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice&&('PWA: '+req.pwaDevice.name))||'PWA';
    logAudit('share-restored',{username:who,ip:clientIp(req),detail:'via PWA — '+(sh.type||'share')+' '+(sh.name||'')});
    emitLiveActivity('trash',{shareId:sh.id,name:sh.name,status:'restored',detail:sh.type||'share',...activityPrincipal(req)});
    res.json({ok:true,share:decorateShare(sh,req)});
  });

  app.delete('/app/trash/:id', async (req, res) => {
    if (!pwaViewerIsAdmin(req)) return res.status(403).json({ error:'admin-required' });
    const rec=trashItems().find((row)=>row&&row.id===req.params.id);
    if(!rec||!rec.share||!canManagePwaImage(req,rec.share))return res.status(404).json({error:'not-found'});
    try{
      const purged=await purgeTrashRecordById(req.params.id,null);if(!purged)return res.status(404).json({error:'not-found'});
      scheduleSearchReindex();
      const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice&&('PWA: '+req.pwaDevice.name))||'PWA';
      logAudit('trash-purged',{username:who,ip:clientIp(req),detail:'via PWA — '+((purged.share&&purged.share.name)||req.params.id)});
      if (purged.share) emitLiveActivity('trash',{shareId:purged.share.id,name:purged.share.name,status:'purged',detail:purged.share.type||'share',...activityPrincipal(req)});
      res.json({ok:true,persisted:true});
    }catch(e){console.error('[trash] PWA purge failed:',e&&e.message);res.status(e&&e.code==='write-error'?503:500).json({error:e&&e.code==='write-error'?'write-error':'delete-failed',persisted:e&&e.code==='write-error'?false:undefined});}
  });

  app.delete('/app/trash', async (req, res) => {
    if (!pwaViewerIsAdmin(req)) return res.status(403).json({ error:'admin-required' });
    const ids=trashItems().filter((rec)=>rec&&rec.share&&canManagePwaImage(req,rec.share)).map((rec)=>rec.id);
    const purgedActivity=[];
    let count=0,failed=0;
    for(const id of ids){try{const purged=await purgeTrashRecordById(id,null);if(purged){count++;if(purged.share)purgedActivity.push({shareId:purged.share.id,name:purged.share.name,status:'purged',detail:purged.share.type||'share',...activityPrincipal(req)});}}catch(e){failed++;console.error('[trash] PWA purge failed:',id,e&&e.message);}}
    if(count){
      for(const activity of purgedActivity) emitLiveActivity('trash',activity);
      scheduleSearchReindex();const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice&&('PWA: '+req.pwaDevice.name))||'PWA';logAudit('trash-purged-all',{username:who,ip:clientIp(req),detail:`via PWA — ${count}; failed=${failed}`});
    }
    res.status(failed?207:200).json({ok:failed===0,count,failed,persisted:true});
  });

  app.get('/app/undo', (req, res) => {
    const items = undoLogItems().filter((entry) => undoEntryVisible(req, entry)).map((entry) => undoPublicEntry(entry, req));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items, max: UNDO_LOG_MAX });
  });

  // Host shares, trash, undo, search and presence routes

  app.post('/app/undo/:id', pwaJsonParser, (req, res) => {
    const entry = undoLogItems().find((row) => row && row.id === req.params.id);
    if (!entry || !undoEntryVisible(req, entry)) return res.status(404).json({ error:'not-found' });
    if (!undoEntryExecutable(req, entry)) return res.status(403).json({ error:'forbidden' });
    const result = performUndo(entry, req);
    if (!result.ok) return res.status(result.status || 400).json({ error:result.error });
    const account = undoRequestAccount(req);
    const who = (req.pwaSession && req.pwaSession.username) || (req.pwaDevice && ('PWA: ' + req.pwaDevice.name)) || (account && account.username) || 'PWA';
    logAudit('action-undone', { account, username:who, ip:clientIp(req), detail:'via PWA — ' + entry.type + (entry.label ? ': ' + entry.label : '') });
    res.json({ ok:true, entry:undoPublicEntry(entry, req) });
  });

  app.get('/app/search', async (req, res) => {
    if (!req.pwaSession && !req.pwaDevice) return res.status(403).json({ error:'auth-required' });
    const q=String(req.query.q||'').trim(); if(q.length<2)return res.status(400).json({error:'query-too-short'});
    if(!live.universalSearchIndex.builtAt&&!live.searchIndexBuilding){try{await buildUniversalSearchIndex();}catch(_){} }
    const limit=Math.min(100,Math.max(1,parseInt(req.query.limit,10)||60));
    const semantic=/^(1|true|yes|on)$/i.test(String(req.query.semantic||''));
    const session=req.pwaSession||null, creator=req.pwaDevice?pwaDeviceCreatorAccount(req.pwaDevice):null;
    const role=(session&&session.role)||(creator&&creator.role)||''; const username=(session&&session.username)||(creator&&creator.username)||'';
    const canShare=(share)=>!!(share&&canManagePwaImage(req,share));
    let content=[], meta=[]; const warnings=[];
    try {
      content=(semantic?universalSemanticSearchQuery(q,req,limit,{canAccess:canShare}):universalSearchQuery(q,req,limit,{canAccess:canShare})).map((r)=>({...r,scope:'content'}));
    } catch (e) {
      warnings.push('content-index');
      console.error('[pwa search] content query failed:', e && e.message);
    }
    try {
      meta=globalMetadataSearch(q,req,limit,{canShare,role,username,includeAdminMeta:pwaViewerIsAdmin(req),scopes:['links','users','logs']});
    } catch (e) {
      warnings.push('metadata');
      console.error('[pwa search] metadata query failed:', e && e.message);
    }
    const results=meta.concat(content).sort((a,b)=>Number(b.filenameMatchRank||0)-Number(a.filenameMatchRank||0)||Number(b.relevanceScore||b.semanticScore||0)-Number(a.relevanceScore||a.semanticScore||0)||String(a.file||a.shareName||'').localeCompare(String(b.file||b.shareName||''))).slice(0,limit);
    const globalView=pwaViewerIsAdmin(req)||role==='auditor';
    const scopedStatus=universalSearchScopedStatus(canShare,globalView);
    res.setHeader('Cache-Control','no-store');
    res.json({query:q,semantic,scope:'all',results,indexed:scopedStatus.indexed,builtAt:scopedStatus.builtAt||0,building:live.searchIndexBuilding,degraded:warnings.length>0,warnings});
  });

  app.get('/app/shares/presence', (req, res) => {
    const scope = pwaPresenceScope(req);
    if (!scope) return res.status(403).json({ error: 'admin-required' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(presenceSnapshot(scope));
  });

  app.get('/app/shares/presence/stream', (req, res) => {
    const scope = pwaPresenceScope(req);
    if (!scope) return res.status(403).json({ error: 'admin-required' });
    openPresenceStream(res, scope, pwaPresenceValidator(req, scope));
  });

  // Reception threads, moderation, device management and PWA shell

  app.get('/app/receptions', (req, res) => {
    const now = Date.now();
    // The PWA Destination picker must only receive reception links that can still be
    // used. A revoked/deleted link is absent from state.shares; an expired link can
    // still exist there, so filter it explicitly using the effective expiry rules.
    const selectable = live.state.shares
      .filter((s) => s && s.type === 'inbox' && canManagePwaImage(req, s))
      .filter((s) => {
        if (s.revoked) return false;
        const expiry = shareEffectiveExpiry(s);
        return !(expiry && now > expiry);
      });
    // Return every selectable token (not only the 500 detailed rows) so the PWA can
    // safely purge remembered owned destinations that became revoked/expired without
    // mistaking an older-but-still-valid reception for a stale one.
    const activeTokens = selectable.map((s) => s.token);
    const list = selectable
      .map((s) => {
        const dec = decorateShare(s, req);
        return {
          token: s.token,
          name: s.name || 'Réception',
          url: dec.url,
          createdAt: s.createdAt || 0,
          expiresAt: s.expiresAt || null,
          effectiveExpiresAt: shareEffectiveExpiry(s),
          bytesReceived: Number(s.bytesReceived) || 0,
          moderated: !!s.moderated,
          owned: canManagePwaImage(req, s),
          threadCount: receptionThreadArray(s).length,
          threadUnread: receptionThreadUnreadCount(s),  // unread visitor replies
        };
      })
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 500);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ receptions: list, activeTokens });
  });

  app.get('/app/receptions/:token/thread', (req, res) => {
    const s = getByToken(req.params.token);
    if (!s || s.type !== 'inbox' || !canManagePwaImage(req, s)) return res.status(404).json({ error: 'not-found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: receptionThreadEnabled(s), unread: receptionThreadUnreadCount(s), messages: receptionThreadArray(s).map(ownerThreadMessage) });
  });

  app.post('/app/receptions/:token/thread', pwaJsonParser, (req, res) => {
    const s = getByToken(req.params.token);
    if (!s || s.type !== 'inbox' || !canManagePwaImage(req, s)) return res.status(404).json({ error: 'not-found' });
    const text = String(req.body && req.body.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'empty' });
    const previous = Array.isArray(s.thread) ? JSON.parse(JSON.stringify(s.thread)) : null;
    receptionThreadArray(s).forEach((m) => { if (m.from === 'visitor') m.read = true; });
    appendReceptionThreadMessage(s, { id: crypto.randomBytes(8).toString('hex'), at: Date.now(), from: 'owner', name: null, text });
    if (!persistNow()) { if (previous) s.thread = previous; else delete s.thread; return res.status(503).json({ error: 'write-error' }); }
    pwaAuditReq(req, 'reception-thread-reply', `via PWA — ${s.name || s.id}`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ ok: true, unread: receptionThreadUnreadCount(s), messages: receptionThreadArray(s).map(ownerThreadMessage) });
  });

  app.post('/app/receptions/:token/thread/read', pwaJsonParser, (req, res) => {
    const s = getByToken(req.params.token);
    if (!s || s.type !== 'inbox' || !canManagePwaImage(req, s)) return res.status(404).json({ error: 'not-found' });
    let changed = false;
    receptionThreadArray(s).forEach((m) => { if (m.from === 'visitor' && m.read === false) { m.read = true; changed = true; } });
    if (changed && !persistNow()) return res.status(503).json({ error: 'write-error' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, unread: 0 });
  });

  app.get('/app/inbox/:token/pending', (req, res) => {
    const sh = getByToken(req.params.token);
    if (!sh || !['inbox','collab'].includes(sh.type) || !canManagePwaImage(req, sh)) return res.status(404).json({ error:'not-found' });
    const pending = pendingModerationRows().filter((row) => row && row.shareId === sh.id).map((row) => ({
      id: row.id, name: row.name || '', size: Math.max(0, Number(row.size) || 0), ip: row.ip || null, sender: row.sender || null, at: Number(row.at) || 0,
    }));
    res.setHeader('Cache-Control','no-store'); res.json({ token: sh.token, moderated: !!sh.moderated, pending });
  });

  app.post('/app/inbox/:token/pending/:id/approve', pwaJsonParser, async (req, res) => {
    const sh = getByToken(req.params.token);
    if (!sh || !['inbox','collab'].includes(sh.type) || !canManagePwaImage(req, sh)) return res.status(404).json({ error:'not-found' });
    const list = pendingModerationRows(); const row = list.find((item) => item && item.id === req.params.id && item.shareId === sh.id);
    if (!row) return res.status(404).json({ error:'not-found' });
    if (!claimPendingModeration(row.id)) return res.status(409).json({ error:'moderation-busy' });
    const beforeShare = JSON.parse(JSON.stringify(sh));
    const originalIndex = list.findIndex((item) => item && item.id === row.id);
    try {
      const outcome = await approvePendingModeration(sh, row);
      if (outcome.error) return res.status(outcome.error === 'inbox-dir' || outcome.error === 'write-error' ? 500 : inboxRejectStatus(outcome.error)).json({ error:outcome.error });
      if (!persistNow()) {
        restorePlainObject(sh, beforeShare);
        const liveList = pendingModerationRows();
        if (!liveList.some((item) => item && item.id === row.id)) liveList.splice(Math.max(0, Math.min(originalIndex, liveList.length)), 0, row);
        if (outcome.dest) deleteFileExpiryForPath(outcome.dest);
        try { const pendingPath=path.join(PENDING_DIR,String(row.id)); if(outcome.dest&&fs.existsSync(outcome.dest)&&!fs.existsSync(pendingPath))fs.renameSync(outcome.dest,pendingPath); } catch(e){ console.error('[moderation] PWA approval rollback failed:',e.message); }
        return res.status(503).json({error:'write-error'});
      }
      finalizePendingModerationApproval(sh, row, outcome);
      const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice?'PWA: '+req.pwaDevice.name:'PWA');
      logAudit('pending-approved',{username:who,ip:clientIp(req),detail:(sh.name||sh.id)+': '+row.name});
      addShareCenterNotification(sh,'received-file-ready',{name:row.name||sh.name||'',bytes:Number(outcome.size)||0,sender:row.sender||null,ip:row.ip||null,url:'/app/#receptions',dedupeKey:`received-ready:pending:${row.id}`});
      res.json({ok:true});
    } finally { releasePendingModeration(row.id); }
  });

  app.post('/app/inbox/:token/pending/:id/reject', pwaJsonParser, (req, res) => {
    const sh = getByToken(req.params.token);
    if (!sh || !['inbox','collab'].includes(sh.type) || !canManagePwaImage(req, sh)) return res.status(404).json({ error:'not-found' });
    const list=pendingModerationRows(); const row=list.find((item)=>item&&item.id===req.params.id&&item.shareId===sh.id);
    if(!row)return res.status(404).json({error:'not-found'});
    if(!claimPendingModeration(row.id))return res.status(409).json({error:'moderation-busy'});
    const originalIndex=list.findIndex((item)=>item&&item.id===row.id);
    try {
      let staged;
      try { staged=stagePendingFileRemoval(row.id,'pwa-reject'); }
      catch(e){ console.error('[moderation] PWA pending reject stage failed:',e.message); return res.status(500).json({error:'delete-failed'}); }
      const liveIndex=list.findIndex((item)=>item&&item.id===row.id); if(liveIndex>=0)list.splice(liveIndex,1);
      if(!persistNow()){
        if(!list.some((item)=>item&&item.id===row.id))list.splice(Math.max(0,Math.min(originalIndex,list.length)),0,row);
        staged.rollback();
        return res.status(503).json({error:'write-error'});
      }
      staged.finalize();
      const who=(req.pwaSession&&req.pwaSession.username)||(req.pwaDevice?'PWA: '+req.pwaDevice.name:'PWA');
      logAudit('pending-rejected',{username:who,ip:clientIp(req),detail:(sh.name||sh.id)+': '+(row.name||'')}); res.json({ok:true});
    } finally { releasePendingModeration(row.id); }
  });

  app.get('/app/inbox/:token/files', async (req, res) => {
    const s=getByToken(req.params.token);if(!s||(s.type!=='inbox'&&s.type!=='collab')||!canManagePwaImage(req,s))return res.status(404).json({error:'not-found'});
    let files,truncated=false;if(s.webStorage){try{const walked=await webStorageWalkFiles(s,{maxFiles:5000,maxDirs:1000,maxDepth:24});files=walked.files.map((row)=>({name:row.name,path:row.rel,size:row.size,mtime:0}));truncated=!!walked.truncated;}catch(error){return res.status(webStorageConnectorStatus(error)).json({error:connectorErrorCode(error)});}}else files=inboxReceivedFiles(s);
    res.setHeader('Cache-Control','no-store');res.json({token:s.token,name:s.name||'',count:files.length,truncated,files});
  });

  app.get('/app/inbox/:token/file', async (req, res) => {
    const s = getByToken(req.params.token);
    if (!s || (s.type !== 'inbox' && s.type !== 'collab') || !canManagePwaImage(req, s)) {
      return res.status(404).json({ error: 'not-found' });
    }
    const rel = String(req.query.path || '');
    if(s.webStorage)return serveWebStorageFile(req,res,s,rel,{filename:path.posix.basename(rel||'download'),countStats:false});
    const abs = safeReceivedFilePath(s, rel);
    if (!abs) return res.status(404).json({ error: 'not-found' });
    let st;
    try { st = fs.statSync(abs); } catch (_) { return res.status(404).json({ error: 'not-found' }); }
    if (!st.isFile()) return res.status(404).json({ error: 'not-found' });
    const filename = path.basename(abs);
    // The authenticated PWA downloader uses the same persisted Range protocol as
    // public shares, but with an account-scoped identity and without public-share
    // counters or shutdown hooks.
    streamFile(req, res, abs, filename, null, null, {
      resumable:true,
      resumeScope:`pwa-inbox:${s.id}`,
      cacheControl:'no-store',
    });
  });

  app.get('/app/device/status', (req, res) => {
    const session = req.pwaSession || getSession(req);
    const device = req.pwaDevice || null;
    if (device) updatePwaDeviceClientInfo(device, req);
    // A paired PWA is itself an authenticated account-scoped capability.  It must be
    // able to see the other devices paired to the SAME account even when the browser
    // admin session has expired.  Never expose devices belonging to another account.
    const deviceAccount = device ? (pwaDeviceCreatorAccount(device) || pwaDeviceOwnerAccount(device.id)) : null;
    const sessionAccount = session ? ((session.accountId && getAccountById(session.accountId)) || findAccountByName(session.username || '')) : null;
    const visibleAccount = sessionAccount || deviceAccount;
    const devices = visibleAccount ? pwaDevices().filter((d) => {
      const owner = pwaDeviceCreatorAccount(d) || pwaDeviceOwnerAccount(d.id);
      return !!(owner && String(owner.id) === String(visibleAccount.id));
    }).map((d) => publicPwaDevice(d, device && device.id)) : [];
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      paired: !!device,
      adminSession: !!session,
      asvsL3: ASVS_L3_MODE === true,
      passkeyManagement: !!(session && session.authenticatedAt && Date.now() - session.authenticatedAt <= PASSKEY_MANAGEMENT_FRESH_MS),
      biometricEnabled: !!(device && visibleAccount && accountPasskeys(visibleAccount).some((p) => passkeyBoundToDevice(p, device.id))),
      biometricCredentialCount: visibleAccount ? accountPasskeys(visibleAccount).length : 0,
      // Prefer the admin-session token when both cookies are present so admin-only
      // device-management actions continue to work. A paired-only device receives
      // its own CSRF token.
      csrf: session ? session.csrf : device ? device.csrf : null,
      device: device ? publicPwaDevice(device, device.id) : null,
      devices,
      // PWA clients need the active DLP policy so their main reception-upload queue
      // can run the same class of checks locally before the first byte is sent.
      // Only policy knobs are exposed here; no secrets or detector samples leave the server.
      shareDefaults: {
        newSharesNeverExpire: getSettings().newSharesNeverExpire === true,
      },
      dlp: pwaDlpPolicyPayload(req),
    });
  });

  app.post('/app/dlp/settings', pwaJsonParser, (req, res) => {
    if (!pwaViewerIsAdmin(req)) return res.status(403).json({ error:'admin-required' });
    const body = req.body || {};
    const input = {};
    if (typeof body.dlpRulesEnabled === 'boolean') input.dlpRulesEnabled = body.dlpRulesEnabled;
    for (const key of ['dlpActionLow','dlpActionMedium','dlpActionHigh','dlpActionCritical']) {
      if (body[key] !== undefined) input[key] = body[key];
    }
    if (!Object.keys(input).length) return res.status(400).json({ error:'no-settings' });
    const parsed = computeSettingsPatch(input);
    if (parsed.error) return res.status(400).json({ error:parsed.error });
    const allowed = new Set(['dlpRulesEnabled','dlpActionLow','dlpActionMedium','dlpActionHigh','dlpActionCritical']);
    const patch = Object.fromEntries(Object.entries(parsed.patch || {}).filter(([key]) => allowed.has(key)));
    if (!Object.keys(patch).length) return res.status(400).json({ error:'no-settings' });
  
    const previousSettings = getSettings();
    const before = {}; for (const key of Object.keys(patch)) before[key] = previousSettings[key];
    let undoEntry = null;
    if (JSON.stringify(before).length <= 65536) {
      undoEntry = recordUndoable(req, 'settings-changed', Object.keys(patch).join(', '), { kind:'settings', before, after:patch });
    }
    if (!setSettingsDurable(patch)) {
      rollbackRecordedUndo(undoEntry);
      return res.status(503).json({ error:'write-error', persisted:false });
    }
    auditReq(req, 'settings-changed', 'via PWA — ' + Object.keys(patch).join(', '));
    res.setHeader('Cache-Control','no-store');
    res.json({ ok:true, persisted:true, dlp:pwaDlpPolicyPayload(req) });
  });

  app.post('/app/device/pairing', adminGuard, pwaJsonParser, async (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'not-authenticated' });
    const csrf = req.headers['x-csrf-token'];
    if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
    prunePwaPairTickets();
    const ticket = crypto.randomBytes(36).toString('base64url');
    const name = String((req.body && req.body.name) || 'Direct-Xfer PWA (QR)').replace(/[\r\n]+/g, ' ').trim().slice(0, 100) || 'Direct-Xfer PWA (QR)';
    const expiresAt = Date.now() + 5 * 60 * 1000;
    pwaPairTickets.set(ticket, { expiresAt, createdBy: session.username || null, createdByAccountId: session.accountId || null, name });
    const host = String(req.get('host') || '');
    if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) { pwaPairTickets.delete(ticket); return res.status(400).json({ error: 'invalid-host' }); }
    const claimUrl = `${externalProto(req)}://${host}/app/device/claim?ticket=${encodeURIComponent(ticket)}`;
    try {
      const qrSvg = await QRCode.toString(claimUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, claimUrl, qrSvg, expiresAt });
    } catch (_) {
      pwaPairTickets.delete(ticket);
      res.status(500).json({ error: 'qr-error' });
    }
  });

  app.post('/app/device/register', adminGuard, pwaJsonParser, (req, res) => {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'not-authenticated' });
    const csrf = req.headers['x-csrf-token'];
    if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
    const device = issuePwaDevice(req, res, (req.body && req.body.name) || 'Direct-Xfer PWA', session.username || null);
    if (!device) return res.status(503).json({ error:'write-error' });
    req.session = session;
    auditReq(req, 'pwa-device-paired', device.name);
    res.json({ ok: true, device: publicPwaDevice(device, device.id) });
  });

  app.post('/app/device/revoke', pwaJsonParser, (req, res) => {
    const session = getSession(req);
    const current = req.pwaDevice || null;
    let id = String((req.body && req.body.id) || '');
    const revokeShares = !!(req.body && req.body.revokeShares);
  
    const perform = () => {
      if (!id && current) id = current.id;
      if (!id) return res.status(400).json({ error: 'missing-id' });
      const beforeState = JSON.parse(JSON.stringify(live.state));
      const list = pwaDevices();
      const found = list.find((d) => d.id === id);
      const foundAccount = found ? (pwaDeviceCreatorAccount(found) || pwaDeviceOwnerAccount(found.id)) : null;
      live.state.meta.pwaDevices = list.filter((d) => d.id !== id);
      let revokedShares = 0;
      if (revokeShares) {
        const owned = live.state.shares.filter((s) => s && s.ownerDeviceId === id).map((s) => s.id);
        for (const shareId of owned) {
          const share = getById(shareId);
          if (share && softDeleteShare(shareId, req, false, { type:'share-trashed', label:(share.type||'share')+' '+(share.name||'') })) revokedShares += 1;
        }
      }
      // Device-scoped push subscriptions and live streams must not survive a
      // revocation, regardless of whether its public links are also removed.
      const ownerKey = 'dev:' + id;
      let pushScopesRemoved = 0;
      live.state.meta.pushSubs = pushSubs().map((sub) => {
        if (!Array.isArray(sub.ownerKeys)) return sub;
        const ownerKeys = sub.ownerKeys.filter((key) => key !== ownerKey);
        pushScopesRemoved += sub.ownerKeys.length - ownerKeys.length;
        return { ...sub, ownerKeys };
      }).filter((sub) => !Array.isArray(sub.ownerKeys) || sub.ownerKeys.length > 0);
      const streams = inboxEventSubs.get(ownerKey);
      if (streams) {
        for (const stream of streams) { try { stream.end(); } catch (_) {} }
        inboxEventSubs.delete(ownerKey);
      }
      if (!persistNow()) {
        live.state = beforeState; syncLiveActivityCache(); reindex(); shareLogicalBytesCache.clear();
        return res.status(503).json({ error:'write-error' });
      }
      if (foundAccount && foundAccount.id) addCenterNotification(foundAccount.id, 'pwa-device-revoked', { device:found ? found.name : id, username:foundAccount.username || '', reason:revokeShares ? 'device-and-links' : 'device', dedupeKey:`pwa-device-revoked:${id}` });
      if (current && current.id === id) clearPwaDeviceCookie(req, res);
      if (session) {
        req.session = session;
        auditReq(req, 'pwa-device-revoked', `${found ? found.name : id}; shares=${revokedShares}; push-scopes=${pushScopesRemoved}`);
      }
      return res.json({ ok: true, revokedShares });
    };
  
    // A paired device can always revoke itself. Revoking a different device is an
    // admin action and must still satisfy the admin IP allowlist + CSRF protection.
    if (!id || (current && id === current.id)) return perform();
    if (!session) return res.status(401).json({ error: 'not-authenticated' });
    const csrf = req.headers['x-csrf-token'];
    if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
    return adminGuard(req, res, perform);
  });

  app.post('/app/device/rename', pwaJsonParser, (req, res) => {
    const session = getSession(req);
    const current = req.pwaDevice || null;
    const name = String((req.body && req.body.name) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'invalid-name' });
    let id = String((req.body && req.body.id) || '');
  
    const perform = () => {
      if (!id && current) id = current.id;
      if (!id) return res.status(400).json({ error: 'missing-id' });
      const device = pwaDevices().find((d) => d.id === id);
      if (!device) return res.status(404).json({ error: 'not-found' });
      const previousName = device.name;
      device.name = name;
      if (!persistNow()) { device.name = previousName; return res.status(503).json({ error:'write-error' }); }
      if (session) {
        req.session = session;
        auditReq(req, 'pwa-device-renamed', device.name);
      } else {
        logAudit('pwa-device-renamed', { username: 'PWA: ' + device.name, ip: clientIp(req), detail: 'device renamed' });
      }
      return res.json({ ok: true, device: publicPwaDevice(device, current && current.id) });
    };
  
    if (!id || (current && id === current.id)) return perform();
    if (!session) return res.status(401).json({ error: 'not-authenticated' });
    const csrf = req.headers['x-csrf-token'];
    if (!csrf || !timingSafeEqualStr(csrf, session.csrf)) return res.status(403).json({ error: 'invalid-csrf' });
    return adminGuard(req, res, perform);
  });

  app.get(['/app/', '/app/index.html'], (req, res) => {
    setPwaDocumentHeaders(res);
    const html = pwaIndexTemplate.replace('<!--DX_IMAGE_BOOTSTRAP-->', pwaImageBootstrapMarkup(req));
    res.send(html);
  });

  app.use('/app', express.static(path.join(rootDir, 'pwa'), {
    index: 'index.html',
    extensions: ['html'],
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self)');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data: blob:; " +
        "media-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; manifest-src 'self'; frame-src 'self' blob:; " +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
      if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      if (filePath.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/app/');
    },
  }));

}

module.exports = { attachPwaRoutes };
