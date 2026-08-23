'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApplicationContext } = require('../lib/server/application-context');
const { createShareMediaTransferApplication } = require('../lib/server/share-media-transfer-application');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function fixture(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-share-media-transfer-'));
  const dir = (name) => {
    const value = path.join(tmp, name);
    fs.mkdirSync(value, { recursive:true });
    return value;
  };
  const host = dir('host');
  const inbox = dir('inbox');
  const pending = dir('pending');
  const enc = dir('enc');
  const imageStore = dir('images');
  const full = dir('full');
  const thumbs = dir('thumbs');
  const micros = dir('micros');
  const photoHistory = dir('photo-history');
  const photoVersions = dir('photo-versions');
  const adaptive = dir('adaptive');
  const legacyImages = dir('legacy-images');
  const legacyThumbs = dir('legacy-thumbs');
  const legacyMicros = dir('legacy-micros');
  const legacyHistory = dir('legacy-history');
  const dlp = dir('dlp');
  const data = dir('data');

  const rootState = {
    shares:[], trash:[], settings:{}, history:[], photoHistory:[], stats:{}, meta:{},
    audit:[], ipNames:{}, undoLog:[], activityLog:[], accounts:[],
  };
  const noop = () => {};
  const asyncNoop = async () => null;
  const applicationContext = createApplicationContext();
  const options = {
    applicationContext,
    platform:{ fs, crypto },
    config:{
      HOST_ROOT:host, INBOX_DIR:inbox, PENDING_DIR:pending, ENC_DIR:enc,
      UNDO_DESCRIPTOR_MAX_BYTES:256 * 1024,
      IMAGE_STORE_DIR:imageStore, FULL_IMAGES_DIR:full, THUMBS_DIR:thumbs, MICROS_DIR:micros,
      PHOTO_HISTORY_DIR:photoHistory, PHOTO_VERSIONS_DIR:photoVersions, ADAPTIVE_IMAGES_DIR:adaptive,
      LEGACY_IMAGES_DIR:legacyImages, LEGACY_THUMBS_DIR:legacyThumbs, LEGACY_MICROS_DIR:legacyMicros,
      LEGACY_PHOTO_HISTORY_DIR:legacyHistory, PHOTO_HISTORY_MAX:50,
      DATA_DIR:data, DATA_KEY:Buffer.alloc(32, 7), SEARCH_INDEX_MAX_DOCS:1000,
      DLP_QUARANTINE_DIR:dlp, LOG_FILE:path.join(data, 'transfers.log'),
      MAX_LOG_BYTES:1024 * 1024, HISTORY_MAX:100, TRANSFER_STALL_MS:45000,
      MAX_ZIP_BYTES:1024 * 1024, MAX_CONCURRENT_ZIPS:2, WEB_STORAGE_STREAM_IDLE_MS:1000,
    },
    constants:{ DAY_MS:86400000, UNDO_LOG_MAX:25 },
    state:{
      getState:() => rootState,
      getSettings:() => rootState.settings,
      persist:async () => true,
      persistNow:() => true,
      scheduleFlush:noop,
      setSettingsDurable:() => true,
      encryptStore:(value) => Buffer.from(JSON.stringify(value)),
      deserializeStore:(value) => JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value)),
    },
    paths:{
      hostToContainer:(value) => value,
      containerToHost:(value) => value,
      assertRealWithin:async (_root, value) => value,
      resolveWithin:(_root, value) => value,
    },
    account:{ accountList:() => [], getAccountById:() => null, findAccountByName:() => null, normUsername:(v) => String(v || '').toLowerCase() },
    presentation:{ primaryBase:() => 'http://localhost', decorateShare:(value) => value },
    activity:{
      pubIp:(ip) => ip, maskIp:(ip) => ip, emitLiveActivity:noop, ipNameFor:() => null,
      schedulePresenceBroadcast:noop, bumpHistoryViewRevision:noop,
    },
    network:{ clientIp:() => '127.0.0.1', geoSync:() => null, geolocate:asyncNoop, flagFromCode:() => '' },
    notification:{
      accountCustomNotificationRules:() => [], pruneCustomNotificationRuleStateForShareId:noop,
      addShareCenterNotification:noop, maybeNotifyDownloadThreshold:noop, maybeCenterDownloadMilestone:noop,
      maybeCenterReceptionQuota:noop, evaluateCustomNotificationRulesForShare:noop, noteCenterAutoDisabled:noop,
      logAudit:noop, auditReq:noop, addAdminCenterNotification:noop, centerShareEligibleForVisitorNotification:() => false,
      noteCenterCountry:noop, maybeCenterViewThreshold:noop, noteCenterVisitorDevice:noop, noteCenterViral:noop,
      noteCenterActivity:noop, enrichFirstViewCenterNotification:noop, notifyFirstPhotoView:noop,
      noteCenterServiceState:noop, addRequestCenterNotification:noop, noteCenterRepeatedDownload:noop,
      noteCenterHighVolume:noop, notify:noop, noteLeakSignal:noop, noteCenterSharedFileSignature:noop,
      noteCenterConcurrentDownloadStart:noop,
    },
    pwa:{
      activityPrincipal:() => ({}), pwaDeviceResolvedAccount:() => null, canManagePwaImage:() => false,
      shareOwnerAccount:() => null, getPwaPublicDevice:() => null, pwaDeviceCreatorAccount:() => null,
      pwaDeviceOwnerAccount:() => null, requestClientDeviceName:() => '', cleanDeviceLabel:(v) => String(v || ''),
    },
    bridges:{
      folderMetrics:() => ({ files:0, bytes:0 }), resolveHostItem:() => null,
      webStorageShareMeta:() => null, webStorageStat:asyncNoop, currentAccount:() => null,
      getSession:() => null, validDownloadResumeId:() => null, pruneDownloadResumeSessions:() => ({}),
      ownsShare:() => false, dataWritable:() => true,
    },
  };
  Object.assign(options, overrides);
  return { tmp, applicationContext, options, close:() => fs.rmSync(tmp, { recursive:true, force:true }) };
}

test('1.70.5 share/media/transfer composition owns the six domain factories and late download phase', () => {
  const server = read('server.js');
  const source = read('lib/server/share-media-transfer-application.js');
  assert.match(server, /createShareMediaTransferApplication\(\{/);
  for (const factory of ['createShareService','createPhotoService','createOcrService','createSearchService','createDlpService','createTransferService','createDownloadService']) {
    assert.match(source, new RegExp(`${factory}\\(`), `${factory} should be composed by the new boundary`);
    assert.doesNotMatch(server, new RegExp(`${factory}\\(`), `${factory} should not remain in server.js`);
  }
  assert.match(source, /downloadPhase = 'idle'/);
  assert.match(source, /registerApplicationDomains/);
  assert.match(server, /notification:notificationApplication\.shareMediaHooks/);
  assert.match(server, /pwa:pwaServices\.shareMediaHooks/);
  assert.doesNotMatch(server, /notifyFirstPhotoView/);
});

test('share/media/transfer composition builds live services and registers route domains once composed', () => {
  const fx = fixture();
  try {
    const app = createShareMediaTransferApplication(fx.options);
    assert.equal(typeof app.shareService.getById, 'function');
    assert.equal(typeof app.photoService.photoStatsOf, 'function');
    assert.equal(typeof app.searchService.scheduleReindex, 'function');
    assert.equal(typeof app.transferService.startTransfer, 'function');
    assert.equal(app.getSearchIndexBuilding(), false);
    assert.equal(app.getSearchIndexError(), null);
    assert.deepEqual(app.getUniversalSearchIndex(), { version:3, builtAt:0, docs:[] });

    const download = app.initializeDownloadService({
      publicSecurity:{ challengeRequired:() => false, hasValidPow:() => true, challengeGateZip:() => false },
      pages:{ sendError:() => {}, challengePage:() => '', pickLang:() => 'en' },
      lifecycle:{ onDownloadComplete:() => {} },
      webStorage:{
        storageConnectorService:{}, connectorErrorCode:() => 'connector-error', shareMeta:() => null,
        joinedPath:() => '', stat:async () => null, etag:() => '', parseRange:() => null,
      },
    });
    assert.equal(app.initializeDownloadService({}), download, 'ready download phase must be idempotent');
    app.registerApplicationDomains();
    assert.doesNotThrow(() => app.registerApplicationDomains(), 'domain registration should be idempotent');
    for (const name of ['share','photo','ocr','search','search-compat','dlp','transfer','download']) {
      assert.ok(fx.applicationContext.current(name), `${name} domain should be registered`);
    }
  } finally { fx.close(); }
});

test('download preflight errors remain retryable before runtime construction begins', () => {
  const fx = fixture();
  try {
    const app = createShareMediaTransferApplication(fx.options);
    assert.throws(() => app.initializeDownloadService({ publicSecurity:{}, pages:{}, lifecycle:{}, webStorage:{} }), /requires download/);
    const download = app.initializeDownloadService({
      publicSecurity:{ challengeRequired:() => false, hasValidPow:() => true, challengeGateZip:() => false },
      pages:{ sendError:() => {}, challengePage:() => '', pickLang:() => 'en' },
      lifecycle:{ onDownloadComplete:() => {} },
      webStorage:{
        storageConnectorService:{}, connectorErrorCode:() => 'connector-error', shareMeta:() => null,
        joinedPath:() => '', stat:async () => null, etag:() => '', parseRange:() => null,
      },
    });
    assert.equal(typeof download.streamFile, 'function');
  } finally { fx.close(); }
});

test('media mutation guards participate in restore busy checks and are reset after restore', () => {
  const fx = fixture();
  try {
    const app = createShareMediaTransferApplication(fx.options);
    assert.equal(app.isBusyForStateReplacement(), false);
    app.photoService.adminPhotoFullWrites.add('photo-full');
    app.photoService.adminPhotoVariantWrites.add('photo-variant');
    assert.equal(app.isBusyForStateReplacement(), true);
    app.clearMediaRuntimeState();
    assert.equal(app.photoService.adminPhotoFullWrites.size, 0);
    assert.equal(app.photoService.adminPhotoVariantWrites.size, 0);
    assert.equal(app.isBusyForStateReplacement(), false);
  } finally { fx.close(); }
});

test('complete first-phase contract validation rejects a late adapter before composition starts', () => {
  const fx = fixture();
  try {
    delete fx.options.notification.noteCenterConcurrentDownloadStart;
    assert.throws(
      () => createShareMediaTransferApplication(fx.options),
      /requires notification\.noteCenterConcurrentDownloadStart\(\)/,
    );
    assert.equal(fx.applicationContext.current('share'), null);
  } finally { fx.close(); }
});

test('application-domain batch failure is atomic, fail-closed and cannot be replayed', () => {
  const fx = fixture();
  try {
    const real = fx.applicationContext;
    fx.options.applicationContext = {
      bind:real.bind,
      current:real.current,
      registerMany() { throw new Error('synthetic-registration-failure'); },
    };
    const app = createShareMediaTransferApplication(fx.options);
    app.initializeDownloadService({
      publicSecurity:{ challengeRequired:() => false, hasValidPow:() => true, challengeGateZip:() => false },
      pages:{ sendError:() => {}, challengePage:() => '', pickLang:() => 'en' },
      lifecycle:{ onDownloadComplete:() => {} },
      webStorage:{
        storageConnectorService:{}, connectorErrorCode:() => 'connector-error', shareMeta:() => null,
        joinedPath:() => '', stat:async () => null, etag:() => '', parseRange:() => null,
      },
    });
    assert.throws(() => app.registerApplicationDomains(), /synthetic-registration-failure/);
    for (const name of ['share','photo','ocr','search','search-compat','dlp','transfer','download']) {
      assert.equal(real.current(name), null, `${name} must not be partially published`);
    }
    assert.throws(() => app.registerApplicationDomains(), /previously failed; restart is required/);
  } finally { fx.close(); }
});

test('Windows runtime integrity manifest protects the share/media/transfer composition boundary', () => {
  const rel = 'lib/server/share-media-transfer-application.js';
  const normalized = read(rel);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ "${rel.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}", "${hash}" \\}`));
});
