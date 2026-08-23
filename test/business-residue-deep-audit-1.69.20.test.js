'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSettingsService } = require('../lib/server/settings-service');
const { createShareService } = require('../lib/server/share-service');
const { createUploadReceptionService } = require('../lib/server/upload-reception-service');
const { createTransferService } = require('../lib/server/transfer-service');
const { createPhotoService } = require('../lib/server/photo-service');
const { createStorageConnectorJobService } = require('../lib/server/storage-connector-job-service');

function makeSettingsService(initial = {}, runtime = {}) {
  let state = { settings:{ ...initial }, meta:{} };
  let failRead = false;
  const svc = createSettingsService({
    updateCheck:runtime.updateCheck !== false,
    publicIpDiscovery:runtime.publicIpDiscovery !== false,
    maxUploadBytes:runtime.maxUploadBytes == null ? 1024 : runtime.maxUploadBytes,
    getState:() => { if (failRead) throw new Error('state-unavailable'); return state; },
    persist:() => true, persistNow:() => true, onSettingsChanged:() => {}, getServerScheme:() => 'http',
    emailSendable:() => false, pushSubs:() => [], tlsManagedByEnvironment:() => false,
    configuredSelfSignedTls:() => false, configuredHttpsEnabled:() => false,
    localCaStatusForClient:() => ({}), tlsManager:{},
    normalizeLinkBase:(v) => String(v || ''), cleanBrokerUrl:(v) => String(v || ''),
    parseHotlinkHosts:() => [], normalizeShareColor:() => null, normalizeTags:() => [],
    normalizeDescriptionMd:(v) => String(v || ''), normExtList:() => [], ipToInt:() => null,
  });
  return { svc, state, fail() { failRead = true; } };
}

function makeShareService(settings = {}) {
  const state = { shares:[], trash:[], settings:{ ...settings }, stats:{}, meta:{}, undoLog:[] };
  return createShareService({
    HOST_ROOT:'/tmp', INBOX_DIR:'/tmp/inbox', PENDING_DIR:'/tmp/pending', ENC_DIR:'/tmp/enc',
    getState:() => state, getSettings:() => state.settings,
    hostToContainer:(v) => v, containerToHost:(v) => v,
    assertRealWithin:async () => true, resolveWithin:(root, sub) => path.resolve(root, String(sub || '')),
    folderMetrics:async () => ({ bytes:0, files:0 }), resolveHostItem:() => null,
    setSettingsDurable:() => true, pruneHistory:() => {}, bumpHistoryViewRevision:() => {},
  });
}

function makePhotoService(extra = {}) {
  return createPhotoService({
    HOST_ROOT:'/tmp', IMAGE_STORE_DIR:'/tmp/i', FULL_IMAGES_DIR:'/tmp/f', THUMBS_DIR:'/tmp/t', MICROS_DIR:'/tmp/m',
    PHOTO_HISTORY_DIR:'/tmp/h', PHOTO_VERSIONS_DIR:'/tmp/v', ADAPTIVE_IMAGES_DIR:'/tmp/a',
    LEGACY_IMAGES_DIR:'/tmp/li', LEGACY_THUMBS_DIR:'/tmp/lt', LEGACY_MICROS_DIR:'/tmp/lm', LEGACY_PHOTO_HISTORY_DIR:'/tmp/lh',
    getState:() => ({ photoHistory:[] }), listShares:() => [], trashItems:() => [],
    hostToContainer:(v) => v, assertRealWithin:async () => true,
    isActive:(share, now) => !share.revoked && (!share.expiresAt || now <= share.expiresAt),
    ...extra,
  });
}

function makeConnectorService(state, trashItems = () => []) {
  const connectorApi = { capabilities:async()=>({}), configuredRemotes:async()=>[], importFile:async()=>({}), exportFile:async()=>({}) };
  const noop = () => {};
  return createStorageConnectorJobService({
    storageConnectorService:connectorApi, INBOX_DIR:'/tmp/inbox', IMAGE_STORE_DIR:'/tmp/images', HOST_ROOT:'/tmp',
    getState:() => state, trashItems, persist:noop, persistNow:() => true, scheduleFlush:noop, crypto, path,
    withinRoot:() => true, assertRealWithin:async()=>true, hostToContainer:(v)=>v, clientIp:()=>'', cleanConnectorPath:(v)=>v,
    clamavEnabled:() => false, scanFile:async()=>null, quarantineFile:async()=>null,
    connectorErrorCode:() => 'connector-failed', logAudit:noop, getAccountById:() => null, scheduleSearchReindex:noop,
  });
}

test('runtime settings gates reject malformed restored values and fail closed on state read errors', () => {
  const f = makeSettingsService({ maxUploadBytes:'Infinity', updateCheck:'false', publicIpDiscovery:'true' }, { maxUploadBytes:4096 });
  assert.equal(f.svc.effMaxUpload(), 4096);
  assert.equal(f.svc.updateCheckEnabled(), false);
  assert.equal(f.svc.publicIpDiscoveryEnabled(), false);
  f.state.settings.maxUploadBytes = 2048.9;
  f.state.settings.updateCheck = true;
  f.state.settings.publicIpDiscovery = true;
  assert.equal(f.svc.effMaxUpload(), 2048);
  assert.equal(f.svc.updateCheckEnabled(), true);
  assert.equal(f.svc.publicIpDiscoveryEnabled(), true);
  f.fail();
  assert.equal(f.svc.effMaxUpload(), 4096);
  assert.equal(f.svc.updateCheckEnabled(), false);
  assert.equal(f.svc.publicIpDiscoveryEnabled(), false);
});

test('share parsers reject trailing garbage, bound time horizons and keep quota sentinels safe', () => {
  const svc = makeShareService({ newSharesNeverExpire:'false' });
  const now = 1_700_000_000_000;
  const twentyYears = 20 * 365 * 86400000;
  assert.equal(svc.clampIndex('2junk', 5), 0);
  assert.equal(svc.parseExpiry('60junk', now), null);
  assert.equal(svc.parseExpiry(String(30 * 365 * 86400), now), now + twentyYears);
  assert.equal(svc.parseExpiryAt(now + 30 * 365 * 86400000, now), now + twentyYears);
  assert.equal(svc.parseStartsAt(now + 3 * 365 * 86400000, now), now + 2 * 365 * 86400000);
  assert.equal(svc.parseMaxDownloads('4junk'), null);
  assert.equal(svc.parseMaxDownloadsPerIp(Infinity), 1000000);
  assert.equal(svc.parseMaxBytesServed(Infinity), Number.MAX_SAFE_INTEGER);
  assert.equal(svc.parseNewShareExpiry('60', now), now + 60000, 'string "false" must not enable never-expire');
});

test('reception threads filter corrupt restored entries, sanitize projections and stay bounded when configured with zero', () => {
  const svc = createUploadReceptionService({ live:{}, RECEPTION_THREAD_MAX:0, DATA_DIR:'/tmp/data', INBOX_DIR:'/tmp/inbox' });
  const good = { id:' id\n1 ', at:'42', from:'visitor', name:' Alice\n ', text:'hi\0there', ip:'1.2.3.4\n', read:false };
  const share = { type:'inbox', thread:[null, 7, [], { from:'other' }, good] };
  assert.deepEqual(svc.receptionThreadArray(share), [good]);
  assert.deepEqual(svc.publicThreadMessage(good), { id:'id 1', at:42, from:'visitor', name:'Alice', text:'hithere' });
  assert.equal(svc.receptionThreadUnreadCount(share), 1);
  for (let i = 0; i < 205; i++) assert.equal(svc.appendReceptionThreadMessage(share, { id:String(i), at:i, from:'owner', text:'x' }), true);
  assert.equal(share.thread.length, 200);
  assert.equal(svc.appendReceptionThreadMessage(share, null), false);
});

test('transfer dashboard does not misclassify corrupt records and survives privacy helper failures', () => {
  const svc = createTransferService({
    crypto, fs, getState:() => ({ history:[] }), getById:() => null,
    pubIp:() => { throw new Error('mask failed'); }, ipNameFor:() => { throw new Error('name failed'); },
  });
  assert.equal(svc.dashboardRecordMatches({ direction:'sideways', completed:true }, { direction:'down' }), false);
  assert.equal(svc.dashboardRecordMatches({ direction:'down' }, { status:'interrupted' }), false);
  assert.equal(svc.dashboardRecordMatches({ direction:'down', completed:true, name:'Needle', ip:'10.0.0.1' }, { q:'needle' }), true);
  assert.equal(svc.dashboardRecordMatches('bad', {}), false);
});

test('photo dashboard rejects malformed dates and contains restored-record helper failures', () => {
  const now = 1_700_000_000_000;
  const svc = makePhotoService({ isActive:() => { throw new Error('bad restored share'); } });
  assert.equal(svc.photoMatchesDashboardFilters({ type:'photo', name:'a.jpg', createdAt:'bad' }, { cutoff:now - 1000 }, now), false);
  assert.equal(svc.photoMatchesDashboardFilters({ type:'photo', name:'a.jpg', createdAt:now }, { status:'inactive' }, now), true);
  const hostileName = { toString() { throw new Error('stringify'); } };
  assert.doesNotThrow(() => svc.photoMatchesDashboardFilters({ type:'photo', name:hostileName, createdAt:now }, { q:'x' }, now));
});

test('connector inventory refuses corrupt persisted roots instead of silently replacing them', () => {
  const badStore = { meta:{ storageConnectors:{ c1:{} } }, shares:[] };
  assert.throws(() => makeConnectorService(badStore).connectorStore(), /connector-store-invalid/);
  const badMeta = { meta:'broken', shares:[] };
  assert.throws(() => makeConnectorService(badMeta).connectorStore(), /connector-meta-invalid/);
});

test('connector references fail closed when trash cannot be read and public metadata is sanitized', () => {
  const state = { meta:{ storageConnectors:[] }, shares:[{ id:'s1', type:'file', webStorage:{ connectorId:'c1' } }] };
  const brokenTrash = makeConnectorService(state, () => { throw new Error('trash unavailable'); });
  assert.throws(() => brokenTrash.webStorageShareReferencesConnector('c1'), /trash unavailable/);

  const svc = makeConnectorService({ meta:{ storageConnectors:[] }, shares:[] });
  assert.deepEqual(svc.publicConnector({
    id:' c1\n', name:' Cloud\tName ', type:'webdav', remote:'r\n', root:' base\0x ', readOnly:'false',
    createdAt:Infinity, updatedAt:-1,
  }), {
    id:'c1', name:'Cloud Name', type:'webdav', remote:'r', root:'base x', readOnly:true, createdAt:0, updatedAt:0,
  });
});
