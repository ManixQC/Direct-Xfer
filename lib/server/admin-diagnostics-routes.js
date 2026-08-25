'use strict';

/**
 * Registers diagnostics, network, backup/restore and browsing administration routes.
 *
 * Route modules receive domain services from the composition root. Mutable persisted
 * state is resolved per request through getState(), so backup restore cannot leave
 * handlers bound to a stale state object.
 */
function attachAdminDiagnosticsRoutes(deps = {}) {
  const {
    CLAMAV_HOST,
    CLAMAV_PORT,
    DATA_DIR,
    DATA_KEY,
    ASVS_L3_MODE = false,
    HOST_ROOT,
    IMAGE_STORE_DIR,
    INBOX_DIR,
    PORT,
    PUBLIC_URL,
    RENDER_MAX_BYTES,
    SEARCH_OCR_ENABLED,
    SEARCH_OCR_LANGS,
    STORAGE_SETUP,
    TRUST_PROXY,
    adminRouter,
    applyRestore,
    assertRealWithin,
    auditReq,
    auditService,
    backupFilename,
    backupStamp,
    buildBackupBundle,
    checkPort,
    clamavEnabled,
    clearPwaDeviceCookie,
    clearRuntimeAfterRestore,
    clientIp,
    containerToHost,
    destroySession,
    detectSearchOcrTools,
    diagnosticsService,
    effectiveWebhook,
    emailConfigured,
    externalTarget,
    fs,
    getLastEmail,
    getLastWebhook,
    getLocalIPv4s,
    getPublicIP,
    getServer,
    getSettings,
    getState,
    hostToContainer,
    isPrivateIp,
    looksLikeTextBuffer,
    mapLimit,
    normalizeLinkBase,
    parseBackup,
    path,
    performBackup,
    previewInfo,
    primaryBase,
    pushSubs,
    putBackupS3,
    putBackupWebdav,
    pwaDevices,
    readFileCapped,
    refreshLocalTlsServerContext,
    renderKind,
    requireAuditAccess,
    requireFullAdmin,
    requireOwner,
    restoreIsBusy,
    rootDir,
    scheduleSearchReindex,
    serializeBackup,
    shutdown,
    streamFile,
    systemHealthService,
    universalSearchStatus,
    verifyAuditChain,
    webpush,
  } = deps;

  if (!adminRouter || typeof adminRouter.get !== 'function') throw new TypeError('attachAdminDiagnosticsRoutes requires adminRouter');
  if (typeof getState !== 'function') throw new TypeError('attachAdminDiagnosticsRoutes requires getState()');
  if (typeof rootDir !== 'string' || !rootDir) throw new TypeError('attachAdminDiagnosticsRoutes requires rootDir');
  const requiredSystemHealthMethods = ['buildGlobalStorageReport', 'diskFreeThresholds'];
  if (!systemHealthService
    || requiredSystemHealthMethods.some((name) => typeof systemHealthService[name] !== 'function')) {
    throw new TypeError('attachAdminDiagnosticsRoutes requires complete systemHealthService');
  }
  const requiredDiagnosticMethods = [
    'diagnosticTcp',
    'diagnosticWritable',
    'safeDiagnosticFixFor',
    'tlsCertificateDiagnostics',
  ];
  if (!diagnosticsService
    || requiredDiagnosticMethods.some((name) => typeof diagnosticsService[name] !== 'function')) {
    throw new TypeError('attachAdminDiagnosticsRoutes requires complete diagnosticsService');
  }
  const { buildGlobalStorageReport, diskFreeThresholds } = systemHealthService;
  const {
    diagnosticTcp,
    diagnosticWritable,
    safeDiagnosticFixFor,
    tlsCertificateDiagnostics,
  } = diagnosticsService;
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

  adminRouter.post('/backup-now', async (req, res) => {
    const r = await performBackup(req.session && req.session.username ? 'admin' : 'admin');
    if (r.ok) return res.json({ result: r, lastBackup: (state.meta && state.meta.lastBackup) || null });
    res.status(400).json({ error: r.error, lastBackup: (state.meta && state.meta.lastBackup) || null });
  });
  
  adminRouter.post('/backup-test', async (req, res) => {
    const s = getSettings();
    const dest = s.backupDestType || 'local';
    const name = `direct-xfer-test-${backupStamp()}.txt`;
    const buf = Buffer.from(`Direct-Xfer backup destination test — ${new Date().toISOString()}\n`);
    try {
      if (dest === 'local') {
        if (!s.backupLocalDir) return res.status(400).json({ error: 'no-local-dir' });
        await fs.promises.mkdir(s.backupLocalDir, { recursive: true });
        const p = path.join(s.backupLocalDir, name);
        await fs.promises.writeFile(p, buf, { mode: 0o600 });
        await fs.promises.unlink(p).catch(() => {});
      } else if (dest === 'webdav') {
        if (!s.backupWebdavUrl) return res.status(400).json({ error: 'no-webdav-url' });
        await putBackupWebdav(s, name, buf);
      } else if (dest === 's3') {
        if (!s.backupS3Endpoint || !s.backupS3Bucket || !s.backupS3Key || !s.backupS3Secret) return res.status(400).json({ error: 's3-incomplete' });
        await putBackupS3(s, name, buf);
      }
      res.json({ ok: true, dest });
    } catch (e) { res.status(400).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });
  
  adminRouter.get('/backup/download', requireOwner, (req, res) => {
    const buf = Buffer.from(serializeBackup(buildBackupBundle()), 'utf8');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename()}"`);
    res.setHeader('Cache-Control', 'no-store');
    auditReq(req, 'backup-download', `${buf.length} bytes${(ASVS_L3_MODE === true || DATA_KEY) ? ' (encrypted)' : ' (PLAINTEXT)'}`);
    res.send(buf);
  });
  
  // Authorization happens before the streamed body arrives. Keep one request-level
  // claim until parsing/commit finishes so a second restore cannot remain authorized
  // by a session that the first restore is about to invalidate.
  let restoreRequestInFlight = false;
  adminRouter.post('/restore', requireOwner, (req, res) => {
    if (restoreRequestInFlight || restoreIsBusy()) return res.status(409).json({ error: 'transfers-active' });
    restoreRequestInFlight = true;
    let claimReleased = false;
    const releaseClaim = () => {
      if (claimReleased) return;
      claimReleased = true;
      restoreRequestInFlight = false;
    };
    const chunks = []; let size = 0; let aborted = false;
    const MAX = 128 * 1024 * 1024;
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(2 * 60 * 1000, () => {
        aborted = true;
        chunks.length = 0;
        releaseClaim();
        if (!res.headersSent) res.status(408).json({ error:'read-timeout' });
      });
    }
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX) {
        aborted = true;
        chunks.length = 0;
        releaseClaim();
        if (!res.headersSent) res.status(413).json({ error: 'too-large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) { releaseClaim(); return; }
      let bundle;
      try { bundle = parseBackup(Buffer.concat(chunks).toString('utf8')); }
      catch (e) {
        releaseClaim();
        const code = e.code === 'DATA_KEY_REQUIRED' ? 'data-key-required'
          : e.code === 'DATA_KEY_INVALID' ? 'data-key-invalid'
          : e.code === 'INVALID_BACKUP' ? 'invalid-backup' : 'parse-error';
        return res.status(400).json({ error: code });
      }
      // A transfer may have started while the (potentially 128 MB) backup body was
      // arriving. Re-check immediately before the destructive state swap.
      if (restoreIsBusy()) { releaseClaim(); return res.status(409).json({ error: 'transfers-active' }); }
      try { applyRestore(bundle); }
      catch (e) {
        releaseClaim();
        console.error('[restore] failed:', e && e.message);
        if (e && e.code === 'RESTORE_ROLLBACK_FAILED') {
          if (!res.headersSent) res.status(500).json({ error:'restore-recovery-required', reauthRequired:true });
          setTimeout(() => shutdown('restore-rollback-failed', 1), 50);
          return;
        }
        return res.status(400).json({ error: 'invalid-backup' });
      }
      const createdAtNumber = Number(bundle.createdAt);
      const createdAtDate = Number.isFinite(createdAtNumber) && createdAtNumber >= 0 ? new Date(createdAtNumber) : null;
      const createdAt = createdAtDate && Number.isFinite(createdAtDate.getTime()) ? createdAtDate : null;
      try {
        auditReq(req, 'restore', `backup from ${createdAt ? createdAt.toISOString() : 'unknown time'}, ${state.shares.length} link(s)`);
      } catch (error) {
        console.error('[restore] audit append failed after commit:', error && error.message);
      }
      // Authentication/runtime objects belong to the PRE-restore world. Invalidate
      // every session/capability stream so the restored account/password/device state
      // is authoritative on the very next request.
      let resetError = null;
      try { clearRuntimeAfterRestore(); }
      catch (error) { resetError = error; console.error('[restore] runtime reset failed after commit:', error && error.message); }
      try { destroySession(req, res); }
      catch (error) { resetError = resetError || error; console.error('[restore] request session cleanup failed:', error && error.message); }
      try { clearPwaDeviceCookie(req, res); }
      catch (error) { resetError = resetError || error; console.error('[restore] PWA cookie cleanup failed:', error && error.message); }
      releaseClaim();
      if (resetError) {
        if (!res.headersSent) res.status(500).json({ error:'restore-runtime-reset-failed', reauthRequired:true });
        setTimeout(() => shutdown('restore-runtime-reset-failed', 1), 50);
        return;
      }
      res.json({ ok: true, shares: state.shares.length, createdAt:createdAt ? createdAt.getTime() : null, reauthRequired: true });
    });
    req.on('aborted', () => { aborted = true; chunks.length = 0; releaseClaim(); });
    req.on('close', () => {
      if (req.complete) return;
      aborted = true;
      chunks.length = 0;
      releaseClaim();
    });
    req.on('error', () => {
      aborted = true;
      chunks.length = 0;
      releaseClaim();
      if (!res.headersSent) res.status(400).json({ error: 'read-error' });
    });
  });
  
  adminRouter.post('/shutdown', (req, res) => {
    auditReq(req, 'server-shutdown');
    res.json({ ok: true });
    console.log('[lifecycle] shutdown requested from the admin interface.');
    setTimeout(() => shutdown('admin-request'), 250);
  });
  
  adminRouter.get('/browse', async (req, res) => {
    const reqPath = String(req.query.path || '/'); // real host path (absolute)
    let absDir;
    try {
      absDir = hostToContainer(reqPath);
      await assertRealWithin(HOST_ROOT, absDir);
    } catch (e) {
      if (e.code === 'ENOENT') return res.status(404).json({ error: 'host-inaccessible', root: '/' });
      return res.status(400).json({ error: 'invalid-path' });
    }
  
    let st;
    try {
      st = await fs.promises.stat(absDir);
    } catch (e) {
      return res.status(404).json({ error: 'not-found' });
    }
    if (!st.isDirectory()) return res.status(400).json({ error: 'not-a-folder' });
  
    let dirents;
    try {
      dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch (e) {
      return res.status(403).json({ error: 'read-failed' });
    }
  
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
        // d.name is a dirent from fs.readdir(absDir) above (absDir itself was
        // already validated), not user-supplied text.
        path: containerToHost(path.join(absDir, d.name)),
      });
    }
  
    const files = entries.filter((e) => e.isFile);
    await mapLimit(files, 32, async (e) => {
      try {
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal,javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
        // e.name likewise comes from fs.readdir(), not from the request.
        const fileStat = await fs.promises.stat(path.join(absDir, e.name));
        e.size = fileStat.size;
        e.mtimeMs = Math.floor(fileStat.mtimeMs || 0);
      } catch (_) {}
    });
    entries.forEach((e) => delete e.isFile);
  
    const coll = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return coll.compare(a.name, b.name);
    });
  
    const cwd = containerToHost(absDir);
    res.json({
      root: '/',
      cwd,
      parent: cwd === '/' ? null : containerToHost(path.dirname(absDir)),
      entries,
    });
  });
  
  adminRouter.get('/preview', async (req, res) => {
    const reqPath = String(req.query.path || '');
    let absFile;
    try {
      absFile = hostToContainer(reqPath);
      await assertRealWithin(HOST_ROOT, absFile);
    } catch (e) {
      return res.status(400).json({ error: 'invalid-path' });
    }
    let st;
    try {
      st = await fs.promises.stat(absFile);
    } catch (e) {
      return res.status(404).json({ error: 'not-found' });
    }
    if (!st.isFile()) return res.status(400).json({ error: 'not-a-file' });
    const name = path.basename(absFile);
    const info = previewInfo(name);
    const rendered = renderKind(name);
    // Text/code is always returned as inert text/plain. In particular HTML/XML is
    // never served with a scriptable MIME type inside the authenticated admin origin.
    if (rendered === 'text' || rendered === 'code' || rendered === 'markdown') {
      let capped; try { capped = await readFileCapped(absFile, RENDER_MAX_BYTES); } catch (_) { return res.status(500).json({ error:'read-error' }); }
      if (!looksLikeTextBuffer(capped.buf)) return res.status(415).json({ error:'unsupported' });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (capped.truncated) res.setHeader('X-Direct-Xfer-Preview-Truncated', '1');
      return res.send(capped.buf);
    }
    if (!info || !['video','image','audio','pdf'].includes(info.kind)) return res.status(415).json({ error: 'unsupported' });
    if (info.kind === 'pdf') {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    }
    streamFile(req, res, absFile, name, null, null, { inline: true, contentType: info.contentType });
  });
  
  adminRouter.post('/diagnostics/run', requireFullAdmin, async (req, res) => {
    const startedAt = Date.now(); const checks = [];
    const add = (id, group, status, data) => checks.push({ id, group, status, ...(data || {}) });
    const safely = (fn, fallback) => {
      try {
        const value = fn();
        return value === null || value === undefined ? fallback : value;
      } catch (_) { return fallback; }
    };
    const safelyAsync = (fn, fallback) => Promise.resolve().then(fn).catch(() => fallback);
    for (const [id, dir] of [['data-writable', DATA_DIR], ['reception-writable', INBOX_DIR], ['images-writable', IMAGE_STORE_DIR]]) {
      const r = await safelyAsync(() => diagnosticWritable(dir), { ok:false, error:'unavailable' });
      add(id, 'storage', r.ok ? 'ok' : 'bad', { path:dir, error:r.error || null });
    }
    const storageReport = await safelyAsync(() => buildGlobalStorageReport(), null);
    if (storageReport && storageReport.disk && storageReport.disk.total) {
      const pct = Math.round((storageReport.disk.used / storageReport.disk.total) * 100);
      { const freePct=Math.max(0,100-pct), limits=safely(() => diskFreeThresholds(), { warn:0, critical:0 }); add('disk-space', 'storage', limits.warn>0 && freePct<=limits.critical ? 'bad' : limits.warn>0 && freePct<=limits.warn ? 'warn' : 'ok', { pct, free:storageReport.disk.free, total:storageReport.disk.total, warnFreePercent:limits.warn }); }
    } else add('disk-space', 'storage', 'warn', { error:'unavailable' });
    add('storage-mounts', 'storage', (STORAGE_SETUP.inboxUnconfigured || STORAGE_SETUP.imagesUnconfigured) ? 'warn' : 'ok', { inboxUnconfigured:!!STORAGE_SETUP.inboxUnconfigured, imagesUnconfigured:!!STORAGE_SETUP.imagesUnconfigured });
  
    const audit = safely(() => verifyAuditChain(), { ok:false, reason:'verification-failed' });
    add('audit-chain', 'security', audit.ok ? 'ok' : 'bad', { integrity:audit });
    const search = safely(() => universalSearchStatus(), { ready:false, indexed:0, building:false, builtAt:0, error:'unavailable' });
    const searchStatus = search.error ? 'bad' : search.ready ? 'ok' : 'warn';
    add('search-index', 'search', searchStatus, { indexed:search.indexed || 0, building:!!search.building, builtAt:search.builtAt || 0, error:search.error || null,
      fix:searchStatus !== 'ok' ? { action:'search-reindex' } : null });
    const tools = await safelyAsync(() => detectSearchOcrTools(), { tesseract:false, pdftoppm:false, missingLanguages:String(SEARCH_OCR_LANGS || '').split('+').filter(Boolean) });
    add('ocr', 'search', !SEARCH_OCR_ENABLED ? 'info' : (tools.tesseract && !(tools.missingLanguages || []).length) ? 'ok' : 'warn', { enabled:SEARCH_OCR_ENABLED, tesseract:!!tools.tesseract, pdf:!!tools.pdftoppm, langs:SEARCH_OCR_LANGS, missingLanguages:tools.missingLanguages || [] });
  
    if (safely(() => clamavEnabled(), false)) { const c = await safelyAsync(() => diagnosticTcp(CLAMAV_HOST, CLAMAV_PORT, 2500), { ok:false, error:'unavailable' }); add('clamav', 'security', c.ok ? 'ok' : 'bad', { configured:true, host:CLAMAV_HOST, port:CLAMAV_PORT, error:c.error }); }
    else add('clamav', 'security', 'info', { configured:false });
    // The durable local audit key is a supported/default configuration. Only an
    // actual failed key migration is unhealthy; AUDIT_HMAC_KEY is optional.
    const auditKeyMigrationStatus = safely(() => auditService.getKeyMigrationStatus(), null);
    const auditActiveKeyMode = safely(() => auditService.getActiveKeyMode(), 'unavailable');
    const auditKeyStatus = auditKeyMigrationStatus && auditKeyMigrationStatus.ok === false ? 'bad' : 'ok';
    add('audit-key', 'security', auditKeyStatus, { mode:auditActiveKeyMode, migration:auditKeyMigrationStatus, localKeyAccepted:auditActiveKeyMode === 'local-file' });
    add('data-encryption', 'security', (ASVS_L3_MODE === true || DATA_KEY) ? 'ok' : 'info', { enabled:ASVS_L3_MODE === true || !!DATA_KEY, provider:ASVS_L3_MODE === true ? 'external' : (DATA_KEY ? 'local' : 'none') });
    const tlsDiag = safely(() => tlsCertificateDiagnostics(), { status:'bad', reason:'unavailable', fixable:false });
    const tlsFix = safely(() => safeDiagnosticFixFor({ id:'tls-certificate', ...tlsDiag }), null);
    add('tls-certificate', 'security', tlsDiag.status || 'info', { ...tlsDiag, fix:tlsFix });
  
    const wh = safely(() => effectiveWebhook(), {});
    const lastWebhook = safely(() => getLastWebhook(), null);
    const hasEmail = safely(() => emailConfigured(), false);
    const lastEmail = safely(() => getLastEmail(), null);
    const rawSubscriptions = safely(() => pushSubs(), []);
    const subscriptions = Array.isArray(rawSubscriptions) ? rawSubscriptions : [];
    add('webhook', 'notifications', wh.url ? (lastWebhook && lastWebhook.ok === false ? 'warn' : 'ok') : 'info', { configured:!!wh.url, last:lastWebhook });
    add('email', 'notifications', hasEmail ? (lastEmail && lastEmail.ok === false ? 'warn' : 'ok') : 'info', { configured:hasEmail, last:lastEmail });
    add('web-push', 'notifications', webpush ? (subscriptions.length ? 'ok' : 'info') : 'warn', { module:!!webpush, subscriptions:subscriptions.length });
  
    const pwaFiles = ['index.html','app.js','mobile-intelligence.js','dlp-local.js','sw.js','manifest.webmanifest'];
    const missingPwa = pwaFiles.filter((name) => { try { return !fs.statSync(path.join(rootDir,'pwa',name)).isFile(); } catch (_) { return true; } });
    const rawPairedDevices = safely(() => pwaDevices(), []);
    const pairedDevices = Array.isArray(rawPairedDevices) ? rawPairedDevices : [];
    add('pwa-assets', 'pwa', missingPwa.length ? 'bad' : 'ok', { missing:missingPwa, pairedDevices:pairedDevices.length });
    add('pwa-install', 'pwa', STORAGE_SETUP.imagesUnconfigured || STORAGE_SETUP.inboxUnconfigured ? 'warn' : 'ok', { serviceWorker:'/direct-xfer-pwa-sw.js', manifest:'/direct-xfer-pwa.webmanifest' });
  
    const target = safely(() => externalTarget(req), null); let portCheck = null;
    if (target) portCheck = await safelyAsync(() => checkPort(target.host, target.port), { open:null, error:'unavailable' });
    add('public-port', 'network', !target ? 'warn' : portCheck && portCheck.open === true ? 'ok' : portCheck && portCheck.open === false ? 'bad' : 'warn', { target:target ? target.label : null, result:portCheck });
    const proxyDetected = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded'] || req.headers['x-forwarded-proto']);
    const proxyStatus = proxyDetected && !TRUST_PROXY ? 'bad' : (!proxyDetected && TRUST_PROXY ? 'warn' : 'ok');
    const settings = safely(() => getSettings(), {});
    const proxyBase = safely(() => normalizeLinkBase(settings.linkBase || PUBLIC_URL || ''), '');
    const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const xfHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const xfPort = String(req.headers['x-forwarded-port'] || '').split(',')[0].trim();
    add('reverse-proxy', 'network', proxyStatus, { detected:proxyDetected, trustProxy:!!TRUST_PROXY, protocol:req.protocol, secure:!!req.secure, host:req.get('host') || null,
      forwardedProto:xfProto || null, forwardedHost:xfHost || null, forwardedPort:xfPort || null, configuredBase:proxyBase || null });
  
    const summary = { ok:checks.filter((c) => c.status === 'ok').length, warn:checks.filter((c) => c.status === 'warn').length, bad:checks.filter((c) => c.status === 'bad').length, info:checks.filter((c) => c.status === 'info').length };
    auditReq(req, 'diagnostics-run', { code:'diagnostics-run', params:{ ok:summary.ok, warn:summary.warn, bad:summary.bad }, fallback:`ok=${summary.ok} warn=${summary.warn} bad=${summary.bad}` });
    res.json({ checks, summary, startedAt, finishedAt:Date.now(), storageReport });
  });
  
  adminRouter.post('/diagnostics/fix', requireFullAdmin, async (req, res) => {
    const action = String(req.body && req.body.action || '');
    try {
      if (action === 'search-reindex') {
        const requested = auditReq(req, 'diagnostic-fix-requested', { code:'diagnostic-fix-requested', params:{ action }, fallback:'search index rebuild requested' });
        if (!requested) return res.status(503).json({ error:'audit-write-failed', action });
        scheduleSearchReindex();
        return res.json({ ok:true, action, message:'scheduled' });
      }
      if (action === 'tls-refresh') {
        const before = tlsCertificateDiagnostics();
        if (!safeDiagnosticFixFor({ id:'tls-certificate', ...before })) return res.status(409).json({ error:'not-fixable', tls:before });
        // Record intent before mutating the live TLS context. If durable signed
        // audit storage is unavailable, do not perform a security-sensitive fix.
        const requested = auditReq(req, 'diagnostic-fix-requested', { code:'diagnostic-fix-requested', params:{ action, status:before.status, reason:before.reason || '' }, fallback:'TLS certificate refresh requested' });
        if (!requested) return res.status(503).json({ error:'audit-write-failed', action, tls:before });
        const changed = refreshLocalTlsServerContext(getServer());
        const after = tlsCertificateDiagnostics();
        const resolved = after.status === 'ok';
        const audited = auditReq(req, resolved ? 'diagnostic-fix' : 'diagnostic-fix-failed', {
          code:resolved ? 'diagnostic-fix' : 'diagnostic-fix-failed',
          params:{ action, changed:!!changed, status:after.status, error:resolved ? '' : (after.reason || 'not-resolved') },
          fallback:resolved ? 'TLS certificate refresh applied' : 'TLS certificate refresh did not resolve the diagnostic'
        });
        if (!audited) return res.status(503).json({ error:'audit-write-failed', action, changed:!!changed, tls:after });
        return res.status(resolved ? 200 : 409).json({ ok:resolved, action, changed:!!changed, tls:after, error:resolved ? undefined : 'fix-not-resolved' });
      }
      return res.status(400).json({ error:'unsupported-fix' });
    } catch (e) {
      auditReq(req, 'diagnostic-fix-failed', { code:'diagnostic-fix-failed', params:{ action, error:String(e && e.message || e).slice(0,100) }, fallback:'diagnostic fix failed' });
      return res.status(500).json({ error:'fix-failed', detail:String(e && e.message || e).slice(0,160) });
    }
  });
  
  adminRouter.get('/network', requireAuditAccess, async (req, res) => {
    const locals = getLocalIPv4s();
    const publicIp = await getPublicIP().catch(() => null);
    const target = externalTarget(req);
    res.json({
      port: PORT,
      locals,
      publicIp,
      base: primaryBase(req),
      publicUrl: PUBLIC_URL || null,
      behindProxy: !!TRUST_PROXY,
      testLabel: target ? target.label : publicIp ? `${publicIp}:${PORT}` : null,
    });
  });
  
  adminRouter.post('/network/port-check', async (req, res) => {
    // Optional `base` override lets the Images page test its own domain (imageBase).
    // Never replace a malformed explicit target with the server public IP: that
    // would report the status of a different endpoint than the one requested.
    const requestedBase = (req.body && typeof req.body.base === 'string') ? req.body.base.trim() : '';
    const target = externalTarget(req, requestedBase);
    if (requestedBase && !target) {
      return res.status(400).json({ open:null, error:'invalid-target', host:null, port:null, label:null });
    }
    let host;
    let port;
    let label;
    if (target) {
      host = target.host;
      port = target.port;
      label = target.label;
    } else {
      host = await getPublicIP().catch(() => null);
      port = PORT;
      label = host ? `${host}:${port}` : null;
    }
    if (!host) return res.json({ open: null, error: 'unknown-target', host: null, port, label: null });
    const result = await checkPort(host, port);
    auditReq(req, 'network-port-tested', `${label || host + ':' + port} · ${result && result.open === true ? 'open' : result && result.open === false ? 'closed' : 'unknown'}`);
    res.json({ ...result, host, port, label });
  });
  
  adminRouter.get('/network/proxy-check', requireAuditAccess, (req, res) => {
    const requestedBase = typeof req.query.base === 'string' ? req.query.base.trim() : '';
    const testedBase = requestedBase ? normalizeLinkBase(requestedBase) : null;
    const h = req.headers || {};
    const pick = (name) => (h[name] != null ? String(h[name]) : null);
    // Relevant forwarding headers (only the ones actually present are returned).
    const names = [
      'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port',
      'x-real-ip', 'forwarded', 'via', 'x-forwarded-server', 'cf-connecting-ip',
      'cf-ray', 'x-forwarded-ssl', 'x-scheme',
    ];
    const headers = {};
    for (const n of names) { const v = pick(n); if (v) headers[n] = v.slice(0, 300); }
  
    const remoteAddr = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '') || null;
    const xffRaw = pick('x-forwarded-for') || '';
    const forwardedForChain = xffRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const xfProto = (pick('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
    const xfHost = (pick('x-forwarded-host') || '').split(',')[0].trim();
    const xfPort = (pick('x-forwarded-port') || '').split(',')[0].trim();
    const proxyDetected = !!(xffRaw || headers['x-real-ip'] || headers['forwarded'] || xfProto ||
      headers['cf-connecting-ip'] || headers['via'] || headers['x-forwarded-server']);
  
    // Best-effort identification of the proxy software from its fingerprints.
    let detectedProxy = null;
    if (headers['cf-connecting-ip'] || headers['cf-ray']) detectedProxy = 'Cloudflare';
    else if (/traefik/i.test(headers['x-forwarded-server'] || '') || /traefik/i.test(headers['via'] || '')) detectedProxy = 'Traefik';
    else if (headers['x-forwarded-server']) detectedProxy = 'Reverse proxy (' + headers['x-forwarded-server'].slice(0,80) + ')';
    else if (/\bvarnish\b/i.test(headers['via'] || '')) detectedProxy = 'Varnish';
    else if (headers['via']) detectedProxy = headers['via'];
  
    // Each check carries a stable `code` + `params`; the admin UI localizes them.
    const checks = [];
    const add = (level, code, params) => checks.push({ level, code, params: params || {} });
  
    if (proxyDetected && !TRUST_PROXY) {
      add('bad', 'proxy-untrusted', { peer: remoteAddr || '?' });
    } else if (!proxyDetected && TRUST_PROXY) {
      add('warn', 'trust-no-headers', {});
    } else if (proxyDetected && TRUST_PROXY) {
      add('ok', 'proxy-ok', { ip: clientIp(req) });
    } else {
      add('ok', 'direct', { ip: remoteAddr || '?' });
    }
  
    // HTTPS propagation.
    if (xfProto === 'https' && req.protocol !== 'https') {
      add('bad', 'https-not-trusted', {});
    } else if (xfProto === 'https' && req.protocol === 'https') {
      add('ok', 'https-ok', {});
    } else if (proxyDetected && !xfProto) {
      add('warn', 'no-proto', {});
    }
  
    // Host/protocol/port propagation against the configured public base when available.
    if (headers['x-forwarded-host'] && headers['x-forwarded-host'] !== pick('host')) {
      add('info', 'host-diff', { pub: headers['x-forwarded-host'], internal: pick('host') || '?' });
    }
    const proxySettings = getSettings();
    const configuredMainBase = normalizeLinkBase(proxySettings.linkBase || PUBLIC_URL || '');
    const configuredImageBase = normalizeLinkBase(proxySettings.imageBase || '');
    let expected = null;
    try {
      if (testedBase) expected = new URL(testedBase);
      else if (configuredMainBase) expected = new URL(configuredMainBase);
    } catch (_) {}
    if (proxyDetected && !xfHost) add('warn', 'no-forwarded-host', {});
  
    // A proxy-check request always travels through the host used to open the admin
    // interface. When the Images dashboard explicitly tests a distinct imageBase,
    // X-Forwarded-Host therefore still describes the main admin host. Comparing it
    // directly to imageBase would be a false positive. Treat that case as an
    // informational alternate-domain check and validate proto/port against the
    // actually observed configured main base instead.
    let compareExpected = expected;
    let alternatePublicBase = false;
    let observedConfiguredBase = null;
    if (xfHost) {
      const candidateBases = [configuredMainBase, configuredImageBase].filter(Boolean);
      for (const candidate of candidateBases) {
        try {
          const u = new URL(candidate);
          if (u.host.toLowerCase() === xfHost.toLowerCase()) { observedConfiguredBase = u; break; }
        } catch (_) {}
      }
    }
    if (testedBase && expected && xfHost && xfHost.toLowerCase() !== expected.host.toLowerCase()) {
      let testedIsConfiguredAlternate = false;
      try { testedIsConfiguredAlternate = !!configuredImageBase && new URL(configuredImageBase).host.toLowerCase() === expected.host.toLowerCase(); } catch (_) {}
      const currentHost = String(pick('host') || '').split(',')[0].trim().toLowerCase();
      const observedIsCurrentAdminHost = currentHost && xfHost.toLowerCase() === currentHost;
      if (testedIsConfiguredAlternate && (observedConfiguredBase || observedIsCurrentAdminHost)) {
        alternatePublicBase = true;
        compareExpected = observedConfiguredBase || null;
        add('info', 'alternate-public-base', {
          tested: expected.origin,
          observed: observedConfiguredBase ? observedConfiguredBase.origin : ((req.protocol || 'http') + '://' + xfHost),
        });
      }
    }
    if (expected) {
      if (!alternatePublicBase && xfHost && xfHost.toLowerCase() !== expected.host.toLowerCase()) add('warn', 'base-host-mismatch', { expected:expected.host, got:xfHost });
      const protocolExpected = alternatePublicBase ? compareExpected : expected;
      if (xfProto && protocolExpected && xfProto !== protocolExpected.protocol.replace(':','')) add('warn', 'base-proto-mismatch', { expected:protocolExpected.protocol.replace(':',''), got:xfProto });
      const expectedPort = protocolExpected ? (protocolExpected.port || (protocolExpected.protocol === 'https:' ? '443' : '80')) : null;
      if (xfPort && expectedPort && xfPort !== expectedPort) add('warn', 'base-port-mismatch', { expected:expectedPort, got:xfPort });
    }
    if (proxyDetected && !xffRaw && !headers['x-real-ip'] && !headers['cf-connecting-ip'] && !headers['forwarded']) add('warn', 'no-client-ip-header', {});
  
    // Peer sanity.
    if (proxyDetected && remoteAddr && !isPrivateIp(remoteAddr)) {
      add('warn', 'public-peer', { ip: remoteAddr });
    }
    if (forwardedForChain.length > 1) {
      add('info', 'multi-hop', { n: forwardedForChain.length, chain: forwardedForChain.join(' → ') });
    }
  
    // Streaming and large-upload reminders cannot be fully inferred from request
    // headers, but surfacing the Direct-Xfer requirements makes the proxy
    // diagnostic actionable instead of merely reporting forwarding headers.
    add('info', 'sse-streaming', { endpoint:'/api/activity/stream', accelBuffering:'no', heartbeatSeconds:20 });
    add('info', 'buffering', { requestBuffering:false, serverUploadLimit:'application-defined' });
  
    const verdict = checks.some((c) => c.level === 'bad') ? 'bad'
      : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  
    res.json({
      verdict,
      trustProxy: !!TRUST_PROXY,
      trustProxyValue: TRUST_PROXY ? String(TRUST_PROXY) : null,
      proxyDetected,
      detectedProxy,
      remoteAddr,
      remoteIsPrivate: remoteAddr ? isPrivateIp(remoteAddr) : null,
      clientIp: clientIp(req),
      protocol: req.protocol,
      secure: req.protocol === 'https',
      testedBase,
      host: pick('host'),
      forwardedForChain,
      forwardedProto:xfProto || null,
      forwardedHost:xfHost || null,
      forwardedPort:xfPort || null,
      expectedBase: expected ? expected.toString().replace(/\/$/,'') : null,
      observedBase: observedConfiguredBase ? observedConfiguredBase.toString().replace(/\/$/,'') : null,
      alternatePublicBase,
      httpVersion:req.httpVersion || null,
      headers,
      checks,
    });
  });
}

module.exports = { attachAdminDiagnosticsRoutes };
