'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRuntimeServicesApplication } = require('../lib/server/runtime-services-application');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function noop() {}
function makeContext(existing = new Map()) {
  const domains = new Map(existing);
  const registrations = [];
  return {
    domains,
    registrations,
    current(name) { return domains.get(name); },
    registerMany(entries) {
      const names = new Set();
      for (const [name, value] of entries) {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) throw new TypeError(`invalid ${name}`);
        if (names.has(name) || domains.has(name)) throw new Error(`duplicate ${name}`);
        names.add(name);
      }
      for (const [name, value] of entries) {
        domains.set(name, value);
        registrations.push(name);
      }
      return Object.freeze(entries.map(([name]) => name));
    },
  };
}

function makeOptions(context = makeContext()) {
  const state = { shares:[], trash:[], settings:{}, meta:{}, stats:{} };
  const shareService = {
    restorePlainObject:(value) => value,
    runExpiredLinkLifecycle:noop,
    trashItems:() => [],
    purgeTrashRecordById:async () => true,
    getById:() => null,
  };
  const photoService = { hashFileSha256:async () => '0'.repeat(64) };
  const searchService = { scheduleReindex:noop };
  const transferService = { endTransfer:noop };
  const notificationService = { dispatch:noop, checkExpiringShares:noop, maybeSendDigest:noop };
  const notificationCenterService = {
    addShareCenterNotification:noop,
    evaluateCustomNotificationRulesForShare:noop,
    maybeCenterReceptionQuota:noop,
    notificationAccountIdForShare:() => null,
    notificationAdminAccountIds:() => [],
    pruneCenterTrackers:noop,
    checkCenterLinkStates:noop,
    noteCenterCleanup:noop,
    addCenterNotification:noop,
  };
  return {
    applicationContext:context,
    platform:{ fs, path, crypto, forge:null },
    fd:{
      openFd:async () => ({ close:async () => {} }),
      closeFd:async () => {},
      readFd:async () => ({ bytesRead:0 }),
    },
    config:{
      APP_NAME:'Direct-Xfer', APP_VERSION:'1.70.20', DATA_KEY:null,
      DATA_DIR:'/tmp/dx-runtime-app', SECRETS_DIR:'/tmp/dx-runtime-app/secrets',
      FULL_IMAGES_DIR:'/tmp/dx-runtime-app/images/full', INBOX_DIR:'/tmp/dx-runtime-app/inbox',
      MAX_CONCURRENT_UPLOADS:2, QUARANTINE_DIR:'/tmp/dx-runtime-app/quarantine',
      UPLOAD_IDLE_TIMEOUT_MS:1000, CLAMAV_HOST:'127.0.0.1', CLAMAV_PORT:3310,
      FAIL_WINDOW_MS:60000, clamavEnabled:() => false,
    },
    constants:{ DAY_MS:86400000, LOG_FILE:'/tmp/dx-runtime-app/transfers.log' },
    state:{
      getState:() => state, getSettings:() => state.settings,
      persist:noop, persistNow:noop, scheduleFlush:noop,
      encryptStore:(value) => value, decryptStore:(value) => value,
    },
    request:{ clientIp:() => '127.0.0.1' },
    utils:{ formatBytes:(n) => String(n), isLoopback:() => true },
    pwa:{ emitInboxEvent:noop },
    services:{
      securityAuthApplication:{ sessionService:{ cleanup:noop }, authService:{ cleanup:noop } },
      shareMediaTransferApplication:{ shareService, photoService, searchService, transferService },
      publicHttpApplication:{ unlockFails:new Map() },
      notificationApplication:{ notificationService, notificationCenterService },
      tlsManager:{
        localCaPaths:() => ({ caCert:'/tmp/ca.crt', caKey:'/tmp/ca.key', serverCert:'/tmp/server.crt', serverKey:'/tmp/server.key' }),
        readLocalCaCertificateOnly:() => null, localCaFeatureRelevant:() => false,
        readManagedTlsFile:() => null, validateLocalCaCertificate:() => false,
        validateLeafCertificate:() => false,
      },
      auditService:{
        paths:{ chainFile:'/tmp/audit.chain', headFile:'/tmp/audit.head' },
        auditKeyId:() => 'none', ensureAuditChainKey:() => Buffer.alloc(32), logAudit:noop,
      },
      activityPresenceService:{ emitLiveActivity:noop, maskIp:(v) => v, pubIp:(v) => v },
      networkServices:{ geoCache:new Map(), GEO_TTL:60000 },
      hostPathService:{ assertRealWithin:async () => true, resolveWithin:(root, rel) => path.resolve(root, rel || '') },
    },
  };
}

test('1.70.20 point 3 moves upload, backup and maintenance composition out of server.js', () => {
  const server = read('server.js');
  const composition = read('lib/server/runtime-services-application.js');
  assert.match(server, /require\('\.\/lib\/server\/runtime-services-application'\)/);
  assert.doesNotMatch(server, /require\('\.\/lib\/server\/(?:upload-reception-service|backup-service|maintenance-service)'\)/);
  for (const rel of ['upload-reception-service', 'backup-service', 'maintenance-service']) {
    assert.match(composition, new RegExp(`require\\('\\./${rel}'\\)`));
  }
  assert.match(server, /runtimeServicesApplication = createRuntimeServicesApplication\(\{/);
  assert.ok(server.split('\n').length < 820, `server.js should shrink after point 3 (${server.split('\n').length} lines)`);
});

test('runtime-services composition preserves upload -> backup -> maintenance order and lazy file-expiry bridge', () => {
  const source = read('lib/server/runtime-services-application.js');
  const upload = source.indexOf('const uploadReceptionService = createUploadReceptionService');
  const backup = source.indexOf('const backupService = createBackupService');
  const maintenance = source.indexOf('maintenanceService = createMaintenanceService');
  assert.ok(upload >= 0 && backup > upload && maintenance > backup);
  assert.match(source, /get fileExpiryMap\(\) \{ return method\(requireMaintenanceService\(\), 'fileExpiryMap', 'maintenance service'\); \}/);
  assert.match(source, /get recordFileExpiry\(\) \{ return method\(requireMaintenanceService\(\), 'recordFileExpiry', 'maintenance service'\); \}/);
});

test('runtime-services publishes the three runtime domains only after clean preflight', () => {
  const context = makeContext();
  const app = createRuntimeServicesApplication(makeOptions(context));
  app.registerApplicationDomains();
  assert.deepEqual(context.registrations, ['upload', 'backup', 'maintenance']);
  assert.equal(context.current('upload'), app.uploadReceptionService);
  assert.equal(context.current('backup'), app.backupService);
  assert.equal(context.current('maintenance'), app.maintenanceService);
  app.registerApplicationDomains();
  assert.deepEqual(context.registrations, ['upload', 'backup', 'maintenance']);

  const blocked = makeContext(new Map([['backup', { preexisting:true }]]));
  const blockedApp = createRuntimeServicesApplication(makeOptions(blocked));
  assert.throws(() => blockedApp.registerApplicationDomains(), /already registered: backup/);
  assert.equal(blocked.registrations.length, 0, 'preflight conflict must not partially publish upload');
});

test('ServerHost integrity manifest protects the runtime-services composition boundary', () => {
  const source = read('lib/server/runtime-services-application.js');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ "lib/server/runtime-services-application\\.js", "${hash}" \\}`));
});


test('deep audit: runtime-services rejects a non-callable Local CA path provider during preflight', () => {
  const context = makeContext();
  const options = makeOptions(context);
  options.services.tlsManager.localCaPaths = { caCert:'/tmp/ca.crt' };
  assert.throws(
    () => createRuntimeServicesApplication(options),
    /TLS manager\.localCaPaths\(\)/,
  );
  assert.equal(context.registrations.length, 0);
});

test('deep audit: moved runtime adapters preserve their owning receiver', async () => {
  const options = makeOptions();
  const root = { shares:[], trash:[], settings:{ backupEnabled:false, ransomwareProtection:false }, meta:{}, stats:{} };
  options.state.root = root;
  options.state.getState = function () { assert.equal(this, options.state); return this.root; };
  options.state.getSettings = function () { assert.equal(this, options.state); return this.root.settings; };
  options.state.persist = function () { assert.equal(this, options.state); };
  options.state.persistNow = function () { assert.equal(this, options.state); };
  options.state.scheduleFlush = function () { assert.equal(this, options.state); };
  options.state.encryptStore = function (value) { assert.equal(this, options.state); return value; };
  options.state.decryptStore = function (value) { assert.equal(this, options.state); return value; };

  options.config.clamavEnabled = function () { assert.equal(this, options.config); return false; };
  options.request.clientIp = function () { assert.equal(this, options.request); return '127.0.0.1'; };
  options.utils.isLoopback = function () { assert.equal(this, options.utils); return true; };
  options.utils.formatBytes = function (n) { assert.equal(this, options.utils); return String(n); };
  options.pwa.emitInboxEvent = function () { assert.equal(this, options.pwa); };

  options.fd.openFd = async function () { assert.equal(this, options.fd); return {}; };
  options.fd.readFd = async function (_fd, buffer) {
    assert.equal(this, options.fd);
    buffer[0] = 0x61;
    return { bytesRead:1 };
  };
  options.fd.closeFd = async function () { assert.equal(this, options.fd); };

  const app = createRuntimeServicesApplication(options);
  assert.equal(app.backupService.maybeRunScheduledBackup(), undefined);
  assert.equal(app.maintenanceService.ransomwareBlocked('127.0.0.1'), null);
  assert.equal(await app.uploadReceptionService.scanGate('/tmp/noop', 'noop', { id:'s1' }, {}), true);
  assert.equal(await app.uploadReceptionService.verifyDedupeProof(
    { source:'/tmp/noop', ranges:[{ offset:0, length:1 }] },
    [Buffer.from('a').toString('base64')],
  ), true);
});

test('deep audit: restore invalidates upload receipts, dedupe capabilities and transfer runtime', () => {
  const app = createRuntimeServicesApplication(makeOptions());
  const upload = app.uploadReceptionService;
  upload.rememberCompletedUpload('completed-1', 12, 'old/file.bin', { ok:true });
  upload.dedupeChallenges.set('challenge-1', { exp:Date.now() + 60000 });
  upload.uploadTransfers.set('transfer-1', { id:'transfer-1' });
  upload.stoppedUploads.set('stopped-1', Date.now() + 60000);
  upload.uploadsInFlight.add('in-flight-1');

  const req = { setTimeout:noop };
  const res = { once:noop, setHeader:noop, status() { return this; }, json:noop };
  assert.equal(upload.beginPublicUpload(req, res), true);
  assert.equal(app.hasActiveUploads(), true);
  assert.ok(upload.completedUploadReceipt('completed-1'));

  app.clearUploadRuntimeAfterRestore();
  assert.equal(app.hasActiveUploads(), false);
  assert.equal(upload.completedUploadReceipt('completed-1'), null);
  assert.equal(upload.dedupeChallenges.size, 0);
  assert.equal(upload.uploadTransfers.size, 0);
  assert.equal(upload.stoppedUploads.size, 0);
  assert.equal(upload.uploadsInFlight.size, 0);
});
