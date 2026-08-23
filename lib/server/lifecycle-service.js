'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

/**
 * Owns the HTTP(S) listener and every process-lifetime concern: startup banner,
 * deferred startup work, TLS rotation, socket draining, fatal errors and signals.
 */
function createLifecycleService(options = {}) {
  const {
    app, config, bootstrap, tlsManager, maintenanceService,
    storageConnectorJobService, pwaEventService, stopPwaApplication, accountService, bus,
    getSettings, dataWritable, initUniversalSearchIndex, flushNow,
    closeActivityPresenceStreams, liveActivityClients, presenceClients,
    loadTlsOptions, refreshLocalTlsServerContext, refreshProvidedTlsServerContext,
    noteCenterLifecycleStart, noteCenterInstalledVersion, checkCenterLinkStates,
    checkCenterSystemHealth, noteCenterCleanShutdown,
    getPublicIP, publicIpDiscoveryEnabled, checkForUpdate,
  } = options;
  if (!app || typeof app.listen !== 'function') throw new TypeError('lifecycle requires app');
  if (!config || typeof config !== 'object') throw new TypeError('lifecycle requires config');
  if (!bootstrap || typeof bootstrap.ensureWindowsPortableFirewallAccess !== 'function') throw new TypeError('lifecycle requires bootstrap');
  if (!tlsManager || typeof loadTlsOptions !== 'function') throw new TypeError('lifecycle requires TLS service');
  if (!maintenanceService || typeof maintenanceService.start !== 'function' || typeof maintenanceService.stop !== 'function') throw new TypeError('lifecycle requires maintenance service');
  if (!storageConnectorJobService || typeof storageConnectorJobService.abortAll !== 'function' || typeof storageConnectorJobService.waitForIdle !== 'function') throw new TypeError('lifecycle requires connector jobs');
  if (!pwaEventService || typeof pwaEventService.clearRuntimeState !== 'function') throw new TypeError('lifecycle requires PWA event service');
  if (typeof stopPwaApplication !== 'function') throw new TypeError('lifecycle requires PWA application cleanup');
  if (!accountService || typeof accountService.ownerLoginUsername !== 'function') throw new TypeError('lifecycle requires account service');
  if (!bus || typeof bus.on !== 'function') throw new TypeError('lifecycle requires event bus');
  if (typeof flushNow !== 'function' || typeof initUniversalSearchIndex !== 'function') throw new TypeError('lifecycle requires persistence and search services');
  const hasActivityPresenceCloser = typeof closeActivityPresenceStreams === 'function';
  const hasLegacyClientRegistries = !!liveActivityClients && !!presenceClients
    && typeof liveActivityClients[Symbol.iterator] === 'function' && typeof presenceClients[Symbol.iterator] === 'function';
  if (!hasActivityPresenceCloser && !hasLegacyClientRegistries) throw new TypeError('lifecycle requires activity/presence stream cleanup');

  const processRef = options.process || process;
  const consoleRef = options.console || console;
  const setTimeoutRef = options.setTimeout || setTimeout;
  const clearTimeoutRef = options.clearTimeout || clearTimeout;
  const setIntervalRef = options.setInterval || setInterval;
  const clearIntervalRef = options.clearInterval || clearInterval;
  const activeHttpSockets = new Set();
  const lifecycleTimers = new Set();
  let server = null;
  let serverScheme = 'http';
  let serverReady = false;
  let started = false;
  let handlersInstalled = false;
  let fatalLifecycleError = false;
  let shuttingDown = false;
  let shutdownPromise = null;
  let shutdownExitCode = 0;

  function errorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  function trackTimer(timer) {
    if (timer) lifecycleTimers.add(timer);
    if (timer && timer.unref) timer.unref();
    return timer;
  }
  function clearLifecycleTimers() {
    for (const timer of lifecycleTimers) {
      try { clearTimeoutRef(timer); } catch (_) {}
      try { clearIntervalRef(timer); } catch (_) {}
    }
    lifecycleTimers.clear();
  }
  function runOptionalTask(label, operation) {
    try {
      Promise.resolve(operation()).catch((error) => {
        consoleRef.warn(`[${label}] optional lifecycle task failed:`, errorMessage(error));
      });
    } catch (error) {
      consoleRef.warn(`[${label}] optional lifecycle task failed:`, errorMessage(error));
    }
  }

  function isUnraidHost() {
    const rootMarkers = [
      ['usr', 'local', 'emhttp'], ['boot', 'config'],
      ['etc', 'unraid-version'], ['var', 'local', 'emhttp'],
    ];
    for (const parts of rootMarkers) {
      try { if (fs.existsSync(path.join(config.HOST_ROOT, ...parts))) return true; } catch (_) {}
    }
    try {
      const has = (name) => fs.existsSync(path.join(config.HOST_ROOT, name));
      return has('appdata') && has('system') && (has('domains') || has('isos'));
    } catch (_) { return false; }
  }
  function unraidVersion() {
    try {
      const raw = fs.readFileSync(path.join(config.HOST_ROOT, 'etc', 'unraid-version'), 'utf8');
      const match = /version\s*=\s*"?([^"\s]+)"?/i.exec(raw);
      if (match) return match[1];
    } catch (_) {}
    try {
      const ini = fs.readFileSync(path.join(config.HOST_ROOT, 'var', 'local', 'emhttp', 'var.ini'), 'utf8');
      const match = /^\s*version\s*=\s*"?([^"\s]+)"?/im.exec(ini);
      if (match) return match[1];
    } catch (_) {}
    return '';
  }
  function runtimeUidGid() {
    try {
      if (typeof processRef.getuid === 'function') return `${processRef.getuid()}:${processRef.getgid()}`;
    } catch (_) {}
    return '';
  }

  async function detectNetwork() {
    try {
      if (!publicIpDiscoveryEnabled()) {
        consoleRef.log('  • Public IP discovery: disabled by privacy setting\n');
        return;
      }
      const ip = await getPublicIP();
      if (ip) consoleRef.log(`  • Public IP detected : ${ip}`);
      else consoleRef.log(config.red('  ⚠  Public IP not detected (no outbound Internet access?).'));
      consoleRef.log('');
    } catch (error) {
      consoleRef.log(config.red(`  ⚠  Network detection failed: ${errorMessage(error)}`));
    }
  }

  function printStartupBanner() {
    try { noteCenterLifecycleStart(); } catch (error) { consoleRef.error('[notification-center] lifecycle start failed:', errorMessage(error)); }
    try { noteCenterInstalledVersion(); } catch (error) { consoleRef.error('[notification-center] version note failed:', errorMessage(error)); }
    try { checkCenterLinkStates(); } catch (error) { consoleRef.error('[notification-center] initial link state check failed:', errorMessage(error)); }
    try { checkCenterSystemHealth(); } catch (error) { consoleRef.error('[notification-center] initial system check failed:', errorMessage(error)); }
    trackTimer(setIntervalRef(() => { try { checkCenterSystemHealth(); } catch (_) {} }, 5 * 60 * 1000));

    consoleRef.log('');
    const bannerTitle = 'Direct-Xfer — HTTP(S) file sharing';
    const bannerSidePadding = 6;
    const bannerInnerWidth = bannerTitle.length + (bannerSidePadding * 2);
    consoleRef.log('  ┌' + '─'.repeat(bannerInnerWidth) + '┐');
    consoleRef.log('  │' + ' '.repeat(bannerSidePadding) + bannerTitle + ' '.repeat(bannerSidePadding) + '│');
    consoleRef.log('  └' + '─'.repeat(bannerInnerWidth) + '┘');
    consoleRef.log(`  • Version          : v${config.APP_VERSION}`);

    const wildcardBind = config.BIND === '0.0.0.0' || config.BIND === '::';
    let shownHost = config.BIND;
    let bindNote = '';
    if (wildcardBind) {
      if (config.LOCAL_IP) {
        shownHost = config.LOCAL_IP;
        bindNote = `  (bind ${config.BIND} — all interfaces)`;
      } else {
        bindNote = '  (all interfaces — NOT the LAN IP; set LOCAL_IP to display it)';
      }
    }
    consoleRef.log(`  • Listening on     : ${serverScheme}://${shownHost}:${config.PORT}${bindNote}`);
    if (serverScheme === 'https') {
      const supplied = tlsManager.config.TLS_CERT && tlsManager.config.TLS_KEY;
      consoleRef.log('  • TLS              : on' + (supplied ? ' (provided cert)' : ' (Direct-Xfer Local CA — trust root once on each LAN client)'));
    }

    let hostRootOk = false;
    try { hostRootOk = fs.statSync(config.HOST_ROOT).isDirectory(); } catch (_) {}
    consoleRef.log(`  • Host FS (ro)     : ${config.HOST_ROOT}` + (hostRootOk ? '' : config.red('  ⚠ NOT FOUND (add the  /:/host:ro  mount)')));
    const dataOk = dataWritable();
    consoleRef.log(
      `  • Data             : ${config.DATA_DIR}${config.hostMountNote(config.DATA_DIR)}` +
      (dataOk ? '' : config.red('  ⚠ not writable — passwords/shares/settings will not persist. Fix the host folder ownership: on Unraid set PUID/PGID (e.g. 99/100) to match the appdata owner, otherwise chown the mapped /data to the container user (e.g. chown -R 1000:1000), or add :z on SELinux hosts.'))
    );
    let imagesOk = false;
    try { fs.accessSync(config.IMAGE_STORE_DIR, fs.constants.W_OK); imagesOk = true; } catch (_) {}
    consoleRef.log(
      `  • Images           : ${config.IMAGE_STORE_DIR}${config.hostMountNote(config.IMAGE_STORE_DIR)}` +
      (imagesOk ? '' : config.red('  ⚠ not writable — Full, Mini and Micro copies cannot be saved. Fix the Images volume ownership or PUID/PGID.'))
    );

    if (isUnraidHost()) {
      const version = unraidVersion();
      const uidGid = runtimeUidGid();
      consoleRef.log(`  • Unraid detected  : ${version ? 'v' + version : 'yes'}` + (uidGid ? `  (running as ${uidGid})` : ''));
      const puid = config.PUID;
      const pgid = config.PGID;
      if (!puid || !pgid) {
        if (!dataOk) {
          consoleRef.log(config.red('  ⚠  PUID/PGID NOT set — the container defaulted to 1000:1000, but Unraid'));
          consoleRef.log(config.red('     appdata is usually owned by nobody:users (99:100), so /data is not'));
          consoleRef.log(config.red('     writable and the admin password/settings will NOT persist.'));
          consoleRef.log(config.red('     Fix: set PUID=99 and PGID=100 (or the appdata owner) on the container.'));
        } else {
          consoleRef.log(config.red('  ⚠  PUID/PGID not set — recommended on Unraid: set PUID=99 and PGID=100'));
          consoleRef.log(config.red('     (or your appdata owner) so files stay owned by the right user.'));
        }
      } else consoleRef.log(`  • PUID/PGID        : ${puid}:${pgid}`);
    }

    let inboxOk = false;
    try { inboxOk = fs.statSync(config.INBOX_DIR).isDirectory(); } catch (_) {}
    consoleRef.log(
      `  • Reception        : ${config.INBOX_DIR}${config.hostMountNote(config.INBOX_DIR)}` +
      (inboxOk ? '' : config.red('  ⚠ not mounted (mount a writable host folder here)'))
    );
    if (bootstrap.storageSetup.inboxUnconfigured || bootstrap.storageSetup.imagesUnconfigured) {
      consoleRef.log(config.red('  ⚠  Storage not configured — these folders are still at the docker-compose'));
      consoleRef.log(config.red('     default (/PATH/TO/CONFIGURE placeholder) or lack a persistent volume:'));
      if (bootstrap.storageSetup.inboxUnconfigured) consoleRef.log(config.red(`       ${config.INBOX_DIR}  (received files)`));
      if (bootstrap.storageSetup.imagesUnconfigured) consoleRef.log(config.red(`       ${config.IMAGE_STORE_DIR}  (self-hosted images)`));
      consoleRef.log(config.red('     Point them at real, writable host folders in docker-compose.yml.'));
    }
    if (config.ADMIN_ALLOWED_IPS.length) {
      consoleRef.log(`  • Admin access     : IP allowlist (${config.ADMIN_ALLOWED_IPS.length} entr${config.ADMIN_ALLOWED_IPS.length > 1 ? 'ies' : 'y'})`);
      if (!config.TRUST_PROXY) consoleRef.log(config.red('      ⚠ set TRUST_PROXY behind a reverse proxy so the real visitor IP is evaluated'));
    } else {
      consoleRef.log(`  • Admin access     : ${config.ADMIN_ALLOW_ANY ? 'ALL NETWORKS (ADMIN_ALLOW_ANY)' : 'local network only'}`);
    }

    const startupSettings = getSettings();
    const startupPublicUrl = startupSettings.linkBase || config.PUBLIC_URL || '';
    if (startupPublicUrl) consoleRef.log(`  • Public URL       : ${startupPublicUrl}${startupSettings.linkBase ? '  (configured)' : '  (reverse proxy)'}`);
    const publicImgUrl = startupSettings.imageBase || startupPublicUrl;
    if (publicImgUrl) consoleRef.log(`  • Public IMG URL   : ${publicImgUrl}${startupSettings.imageBase ? '  (Images)' : '  (same public base)'}`);
    if (config.TRUST_PROXY) consoleRef.log(`  • Reverse proxy    : enabled (trust proxy = ${config.TRUST_PROXY})`);
    if (startupSettings.shutdownAfterDownload) consoleRef.log('  • Auto-shutdown    : ARMED (stops after the next complete download)');

    const ownerName = accountService.ownerLoginUsername();
    if (accountService.isEnvironmentPasswordManaged()) {
      consoleRef.log(`  • Owner account    : ${ownerName} (password via ADMIN_PASSWORD)`);
    } else if (accountService.hasFreshInitialPassword()) {
      consoleRef.log('');
      consoleRef.log(`  • Owner account    : ${ownerName}`);
      if (config.DX_WINDOWS_LAUNCHER_TOKEN) {
        consoleRef.log('  ⚠  Owner password generated automatically; the Windows launcher will display it once.');
      } else {
        consoleRef.log('  ⚠  Owner password generated automatically:');
        consoleRef.log('     ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
        consoleRef.log(`       ${accountService.initialPassword()}`);
        consoleRef.log('     ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
        consoleRef.log(`     Log in as "${ownerName}". Save it now — only a salted hash is stored.`);
      }
      if (!dataWritable()) {
        consoleRef.log(config.red('  ⚠  /data is NOT writable — this password will be REGENERATED on the next'));
        consoleRef.log(config.red('     restart (so it won\'t work after a reboot). Fix /data ownership'));
        consoleRef.log(config.red('     (Unraid: set PUID/PGID to the appdata owner, e.g. 99/100), or set a'));
        consoleRef.log(config.red('     fixed ADMIN_PASSWORD.'));
      }
    } else {
      consoleRef.log('');
      consoleRef.log(`  • Owner account    : ${ownerName}`);
      consoleRef.log('  • Owner password   : set previously (stored as a salted hash).');
      consoleRef.log('    If lost, set the ADMIN_PASSWORD variable to override it.');
    }
    consoleRef.log('');
    void detectNetwork();
    if (config.UPDATE_CHECK) {
      runOptionalTask('update-check', checkForUpdate);
      trackTimer(setIntervalRef(() => runOptionalTask('update-check', checkForUpdate), 12 * 60 * 60 * 1000));
    }
  }

  function closeLegacyActivityPresenceRegistries() {
    if (!hasLegacyClientRegistries) return;
    try {
      for (const client of [...liveActivityClients]) {
        try { if (client && client.res && !client.res.writableEnded) client.res.end(); } catch (_) {}
        liveActivityClients.delete(client);
      }
    } catch (_) {}
    try {
      for (const client of [...presenceClients]) {
        try { if (client && client.res && !client.res.writableEnded) client.res.end(); } catch (_) {}
        presenceClients.delete(client);
      }
    } catch (_) {}
  }

  function closeLiveStreamsForShutdown() {
    let ownerCleanupSucceeded = false;
    if (hasActivityPresenceCloser) {
      try {
        closeActivityPresenceStreams();
        ownerCleanupSucceeded = true;
      } catch (error) {
        try { if (typeof consoleRef.warn === 'function') consoleRef.warn('[server] activity/presence stream cleanup failed:', errorMessage(error)); } catch (_) {}
      }
    }
    // The service-owned closer is authoritative, but a shutdown must still make
    // progress if a future implementation unexpectedly throws. Older embedders
    // expose the registries directly, so use them as a best-effort fallback.
    if (!ownerCleanupSucceeded) closeLegacyActivityPresenceRegistries();
    try { pwaEventService.clearRuntimeState(); } catch (_) {}
  }
  function resetActiveHttpSocketsForShutdown() {
    for (const socket of [...activeHttpSockets]) {
      try {
        if (typeof socket.resetAndDestroy === 'function' && !socket.destroyed) socket.resetAndDestroy();
        else socket.destroy();
      } catch (_) { try { socket.destroy(); } catch (_) {} }
    }
  }
  function markWindowsCleanShutdown(signal) {
    if (!config.DX_WINDOWS_LAUNCHER_TOKEN || !config.DX_WINDOWS_SHUTDOWN_MARKER) return;
    try { fs.writeFileSync(config.DX_WINDOWS_SHUTDOWN_MARKER, String(signal || 'shutdown'), { mode:0o600 }); } catch (_) {}
  }
  function forceProcessExit(code = 0) {
    processRef.exit(Number(code) === 0 ? 0 : 1);
  }
  function settleWithin(promise, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeoutRef(() => {
        if (done) return;
        done = true;
        resolve({ settled:false, ok:false, error:null, value:null });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      Promise.resolve(promise).then((value) => {
        if (done) return;
        done = true;
        clearTimeoutRef(timer);
        resolve({ settled:true, ok:true, error:null, value });
      }, (error) => {
        if (done) return;
        done = true;
        clearTimeoutRef(timer);
        resolve({ settled:true, ok:false, error, value:null });
      });
    });
  }

  async function shutdown(signal, requestedExitCode = 0) {
    if (Number(requestedExitCode) !== 0) shutdownExitCode = 1;
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = new Promise((resolve) => {
      consoleRef.log(`\n[server] shutting down (${signal})…`);
      clearLifecycleTimers();
      if (tlsManager.tlsLeafRotationTimer) {
        try { clearIntervalRef(tlsManager.tlsLeafRotationTimer); } catch (_) {}
        tlsManager.tlsLeafRotationTimer = null;
      }
      try { maintenanceService.stop(); }
      catch (error) {
        shutdownExitCode = 1;
        consoleRef.warn('[server] maintenance timers did not stop cleanly:', error && error.message ? error.message : error);
      }
      try { stopPwaApplication(); }
      catch (error) {
        shutdownExitCode = 1;
        consoleRef.warn('[server] PWA application timers did not stop cleanly:', error && error.message ? error.message : error);
      }
      try { storageConnectorJobService.abortAll(); }
      catch (error) {
        shutdownExitCode = 1;
        consoleRef.warn('[server] connector job cancellation failed:', error && error.message ? error.message : error);
      }
      closeLiveStreamsForShutdown();

      let finished = false;
      let forceTimer = null;
      let hardDeadlineTimer = null;
      const finish = async (forced) => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeoutRef(forceTimer);
        const connectorResult = await settleWithin(
          Promise.resolve().then(() => storageConnectorJobService.waitForIdle(600)),
          700
        );
        const connectorsStopped = connectorResult.settled && connectorResult.ok && connectorResult.value === true;
        if (!connectorsStopped) {
          consoleRef.warn('[server] connector jobs did not fully stop before the shutdown deadline.');
        }
        const flushResult = await settleWithin(Promise.resolve().then(() => flushNow()), 900);
        let persistenceOk = flushResult.settled && flushResult.ok;
        if (!persistenceOk) consoleRef.error('[server] final persistence did not complete cleanly before the shutdown deadline.');
        if (shutdownExitCode === 0 && connectorsStopped && persistenceOk) {
          try {
            noteCenterCleanShutdown(signal);
            const cleanMarkerFlush = await settleWithin(Promise.resolve().then(() => flushNow()), 900);
            persistenceOk = cleanMarkerFlush.settled && cleanMarkerFlush.ok;
            if (!persistenceOk) consoleRef.error('[server] clean-shutdown state did not persist before the shutdown deadline.');
          } catch (error) {
            shutdownExitCode = 1;
            persistenceOk = false;
            consoleRef.error('[server] clean-shutdown state failed:', errorMessage(error));
          }
        }
        const exitCode = shutdownExitCode || (persistenceOk && connectorsStopped ? 0 : 1);
        if (exitCode === 0) markWindowsCleanShutdown(signal);
        if (hardDeadlineTimer) clearTimeoutRef(hardDeadlineTimer);
        consoleRef.log(forced ? '[server] server closed after bounded connection drain.' : '[server] server closed.');
        resolve();
        forceProcessExit(exitCode);
      };

      forceTimer = setTimeoutRef(() => {
        resetActiveHttpSocketsForShutdown();
        try { if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (_) {}
        void finish(true);
      }, 650);
      if (forceTimer.unref) forceTimer.unref();
      hardDeadlineTimer = setTimeoutRef(() => {
        consoleRef.error('[server] shutdown hard deadline reached; forcing process exit.');
        forceProcessExit(shutdownExitCode || 1);
      }, 3000);

      try {
        if (!server) return void finish(true);
        server.close((closeError) => { void finish(Boolean(closeError)); });
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch (error) {
        consoleRef.warn('[server] close initiation failed:', error && error.message ? error.message : error);
        void finish(true);
      }
    });
    return shutdownPromise;
  }

  function requestFatalShutdown(kind, detail) {
    if (fatalLifecycleError) return;
    fatalLifecycleError = true;
    consoleRef.error(`[server] fatal ${kind}:`, detail);
    void shutdown(kind, 1);
  }
  function installHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;
    processRef.on('unhandledRejection', (reason) => {
      requestFatalShutdown('unhandled-rejection', reason && reason.stack ? reason.stack : (reason && reason.message ? reason.message : reason));
    });
    processRef.on('uncaughtException', (error) => {
      if (error && (error.code === 'EPIPE' || error.code === 'ECONNRESET')) {
        consoleRef.warn('[server] client stream interrupted:', error.code);
        return;
      }
      requestFatalShutdown('uncaught-exception', error && error.stack ? error.stack : error);
    });
    processRef.on('SIGINT', () => { void shutdown('SIGINT', 0); });
    processRef.on('SIGTERM', () => { void shutdown('SIGTERM', 0); });
    bus.on('shutdown', () => shutdown('download-complete'));
  }

  function start() {
    if (started) return server;
    started = true;
    installHandlers();
    try {
      maintenanceService.start();
    } catch (error) {
      consoleRef.error('[server] maintenance startup failed:', error && error.message ? error.message : error);
      void shutdown('maintenance-startup-error', 1);
      return null;
    }
    let tlsOptions = null;
    try {
      tlsOptions = loadTlsOptions();
    } catch (error) {
      consoleRef.error('[tls] HTTPS startup failed:', error && error.message ? error.message : error);
      void shutdown('tls-startup-error', 1);
      return null;
    }
    serverScheme = tlsOptions ? 'https' : 'http';
    const onServerListening = () => {
      serverReady = true;
      printStartupBanner();
      trackTimer(setTimeoutRef(() => {
        runOptionalTask('search-index', initUniversalSearchIndex);
      }, 750));
      trackTimer(setTimeoutRef(() => runOptionalTask('windows-firewall', () => bootstrap.ensureWindowsPortableFirewallAccess()), 2500));
    };
    try {
      server = tlsOptions
        ? https.createServer(tlsOptions, app).listen(config.PORT, config.BIND, onServerListening)
        : app.listen(config.PORT, config.BIND, onServerListening);
    } catch (error) {
      consoleRef.error(`[server] listener startup failed on ${config.BIND}:${config.PORT}:`, error && error.message ? error.message : error);
      void shutdown('listener-startup-error', 1);
      return null;
    }
    server.headersTimeout = 65 * 1000;
    server.requestTimeout = 0;
    server.on('error', (error) => {
      consoleRef.error(`[server] server error on ${config.BIND}:${config.PORT}: ${error && (error.code || error.message) ? (error.code || error.message) : error}`);
      if (!serverReady) {
        void shutdown('listener-error', 1);
        return;
      }
      void shutdown('server-error', 1);
    });
    server.on('connection', (socket) => {
      activeHttpSockets.add(socket);
      socket.once('close', () => activeHttpSockets.delete(socket));
    });

    if (['local-ca', 'local-ca-degraded', 'provided'].includes(tlsManager.ACTIVE_TLS_MODE)) {
      tlsManager.tlsLeafRotationTimer = setIntervalRef(() => {
        runOptionalTask('tls-refresh', () => {
          if (tlsManager.ACTIVE_TLS_MODE === 'local-ca' || tlsManager.ACTIVE_TLS_MODE === 'local-ca-degraded') return refreshLocalTlsServerContext(server);
          if (tlsManager.ACTIVE_TLS_MODE === 'provided') return refreshProvidedTlsServerContext(server);
          return false;
        });
      }, tlsManager.config.TLS_REFRESH_INTERVAL_MS);
      if (tlsManager.tlsLeafRotationTimer.unref) tlsManager.tlsLeafRotationTimer.unref();
    }
    return server;
  }

  return Object.freeze({
    start,
    shutdown,
    getServer:() => server,
    getServerScheme:() => serverScheme,
    isStarted:() => started,
    isShuttingDown:() => shuttingDown,
  });
}

module.exports = { createLifecycleService };
