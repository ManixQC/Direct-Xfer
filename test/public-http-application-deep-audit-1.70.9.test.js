'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWebStorageShareTools } = require('../lib/web-storage-share');
const { createWebStorageWritableTools } = require('../lib/web-storage-writable');
const { createPublicHttpApplication } = require('../lib/server/public-http-application');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const noop = () => {};

function publicHttpPreflightOptions(onSecurityInit) {
  function express() {}
  express.Router = () => ({ use:noop, get:noop, post:noop });
  const shareMethods = [
    'zipAllowed', 'parseMaxVisitors', 'linkPrefix', 'shareEffectiveExpiry', 'addShare',
    'bandwidthCapReached', 'bumpViews', 'clampIndex', 'detachActiveShare',
    'destroyShareManagedData', 'getByToken', 'incrementDownloads', 'ipDownloadQuotaBlocked',
    'isActive', 'isScheduled', 'recordAndCheckVisitor', 'recordRecipientView', 'shareItems',
  ];
  const photoMethods = [
    'firstExistingPhotoFile', 'notePhotoView', 'photoAdaptivePath', 'photoCacheRevision',
    'photoOriginalPaths', 'photoVariantPaths', 'streamToFileBounded',
  ];
  const shareService = { recipientByToken:new Map() };
  for (const name of shareMethods) shareService[name] = noop;
  const photoService = {};
  for (const name of photoMethods) photoService[name] = noop;
  return {
    applicationContext:{ current:() => null, registerMany:noop },
    config:{
      APP_NAME:'Direct-Xfer', APP_VERSION:'1.70.20', APP_YEAR:2026,
      WEB_STORAGE_STAT_CACHE_MS:15000, ACCESS_REQUESTS_MAX:100,
      FULL_IMAGES_DIR:'/images/full', HOST_ROOT:'/host', IMAGE_MAX_BYTES:1024,
      PWA_IMG_EXT:'.jpg', SECRETS_DIR:'/data/secrets',
    },
    requestContext:{},
    platform:{ express },
    request:{ clientIp:noop, parseCookies:noop },
    state:{ getState:() => ({}), getSettings:() => ({}), persistNow:() => true, scheduleFlush:noop },
    storage:{ storageConnectorService:{ stat:noop, list:noop, exportFile:noop, mkdir:noop, remove:noop } },
    services:{
      securityAuthApplication:{
        authService:{},
        initializePublicSecurity() { onSecurityInit(); return {}; },
      },
      shareMediaTransferApplication:{
        shareService,
        photoService,
        searchService:{ scheduleReindex:noop },
        initializeDownloadService:noop,
      },
      sharePresentationService:{ primaryBase:noop },
      activityPresenceService:{ pubIp:noop, emitLiveActivity:noop, maskIp:noop },
      networkServices:{ geolocate:noop, geoSync:noop },
      notificationService:{ notify:noop },
      notificationCenterService:{ addShareCenterNotification:noop },
      hostPathService:{ assertRealWithin:noop, hostToContainer:noop, resolveWithin:noop },
    },
    pwa:{ stampPhotoUploadDevice:noop },
    bridges:{ onDownloadComplete:noop, receptionThreadEnabled:noop },
  };
}

test('public HTTP preflight rejects late static wiring errors before public-security initialization', () => {
  let securityInitializations = 0;
  const options = publicHttpPreflightOptions(() => { securityInitializations += 1; });
  delete options.services.notificationService.notify;
  assert.throws(
    () => createPublicHttpApplication(options),
    /notification service\.notify\(\)/,
  );
  assert.equal(securityInitializations, 0, 'public security must remain untouched after a preflight failure');
});

test('Web Storage state-replacement cache reset cannot be repopulated by an older in-flight stat', async () => {
  let calls = 0;
  let resolveFirst;
  const service = {
    async stat() {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { id:`row-${calls}`, size:calls, modTime:`2026-08-23T00:00:0${calls}Z` };
    },
    async list() { return []; },
  };
  const tools = createWebStorageShareTools({ storageConnectorService:service, cacheMs:60000 });
  const share = {
    id:'share-1', type:'web-storage',
    webStorage:{ connectorId:'c1', connectorName:'Cloud', connectorType:'rclone', remote:'cloud', root:'', path:'folder', isDir:true },
  };

  const first = tools.stat(share, 'file.bin');
  assert.equal(tools.isBusyForStateReplacement(), true);
  tools.clearCache();
  resolveFirst({ id:'old-row', size:1, modTime:'2026-08-23T00:00:01Z' });
  await first;
  assert.equal(tools.isBusyForStateReplacement(), false);

  const fresh = await tools.stat(share, 'file.bin');
  assert.equal(calls, 2, 'pre-reset in-flight result must not repopulate the post-reset cache');
  assert.equal(fresh.id, 'row-2');
  await tools.stat(share, 'file.bin');
  assert.equal(calls, 2, 'the fresh generation should still cache normally');
});

test('Web Storage mutating operations hold a restore barrier until the remote operation settles', async () => {
  let releaseExport;
  const service = {
    exportFile:() => new Promise((resolve) => { releaseExport = resolve; }),
    mkdir:async () => ({}),
    remove:async () => ({}),
  };
  const tools = createWebStorageWritableTools({
    storageConnectorService:service,
    shareMeta:() => ({ readOnly:false, isDir:true }),
    joinedPath:(_share, rel) => rel,
    stat:async () => null,
    invalidate:noop,
  });
  const share = { webStorage:{} };
  const publishing = tools.publishFile(share, '/tmp/local.bin', 'remote.bin');
  assert.equal(tools.isBusyForStateReplacement(), true);
  releaseExport({ ok:true });
  await publishing;
  assert.equal(tools.isBusyForStateReplacement(), false);
});

test('restore wiring uses the aggregate public HTTP barrier and runtime reset', () => {
  const lifecycle = read('lib/server/state-lifecycle-application.js');
  const composition = read('lib/server/public-http-application.js');
  assert.match(lifecycle, /shareMediaTransferApplication\.isBusyForStateReplacement\(\)[\s\S]*callLate\(publicHttpProvider, 'publicHttpApplication', 'isBusyForStateReplacement'\)/);
  assert.match(lifecycle, /\['downloads', \(\) => callLate\(publicHttpProvider, 'publicHttpApplication', 'clearRuntimeState'\)\]/);
  assert.match(composition, /\['web-storage-cache', webStorageClearCache\]/);
  assert.match(composition, /\['downloads', clearDownloadRuntimeState\]/);
  assert.match(composition, /isBusyForStateReplacement\(\)[\s\S]*webStorageReadBusy\(\)[\s\S]*webStorageWriteBusy\(\)/);
});
