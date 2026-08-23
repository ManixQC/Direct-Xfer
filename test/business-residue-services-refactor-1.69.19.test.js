'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createShareService } = require('../lib/server/share-service');
const { createUploadReceptionService } = require('../lib/server/upload-reception-service');
const { createTransferService } = require('../lib/server/transfer-service');
const { createPhotoService } = require('../lib/server/photo-service');
const { createStorageConnectorJobService } = require('../lib/server/storage-connector-job-service');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');

test('point 6 removes small business-policy implementations from server.js', () => {
  const server = read('server.js');
  for (const name of [
    'effMaxUpload', 'updateCheckEnabled', 'publicIpDiscoveryEnabled',
    'clampIndex', 'normalizePwHint', 'parseMaxDownloadsPerIp', 'normalizeShareEmoji',
    'parseMaxBytesServed', 'parseLinkRateKBps', 'zipAllowed',
    'receptionThreadArray', 'publicThreadMessage',
    'ownerThreadMessage', 'appendReceptionThreadMessage', 'receptionThreadUnreadCount',
    'dashboardQueryOptions', 'dashboardRecordMatches', 'photoDashboardQueryOptions',
    'photoMatchesDashboardFilters', 'parseExpiry', 'parseExpiryAt', 'resolveExpiry',
    'resolveNewShareExpiry', 'parseNewShareExpiry', 'applyNewShareLifetimePolicy',
    'parseStartsAt', 'parseMaxDownloads', 'connectorStore', 'publicConnector',
    'getStorageConnector', 'webStorageShareReferencesConnector',
  ]) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\s*\\(`), `${name} should no longer be implemented in server.js`);
  }
  assert.match(read('lib/server/settings-service.js'), /function effMaxUpload\(/);
  assert.match(read('lib/server/share-service.js'), /function parseLinkRateKBps\(/);
  assert.match(read('lib/server/upload-reception-service.js'), /function appendReceptionThreadMessage\(/);
  assert.match(server, /function receptionThreadEnabled\(\.\.\.args\) \{ return uploadReceptionService\.receptionThreadEnabled\(\.\.\.args\); \}/, 'the pre-construction bridge must remain a pure delegation');
  assert.match(read('lib/server/transfer-service.js'), /function dashboardQueryOptions\(/);
  assert.match(read('lib/server/photo-service.js'), /function photoDashboardQueryOptions\(/);
  assert.match(read('lib/server/storage-connector-job-service.js'), /function connectorStore\(/);
});

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

test('share service owns the common share parsers without changing their contracts', () => {
  const svc = makeShareService({ newSharesNeverExpire:false });
  assert.equal(svc.clampIndex('2', 4), 2);
  assert.equal(svc.clampIndex('9', 4), 0);
  assert.equal(svc.normalizePwHint('  hello\nworld  '), 'hello world');
  assert.equal(svc.parseMaxDownloadsPerIp(-1), 0);
  assert.equal(svc.parseMaxDownloadsPerIp(2.9), 2);
  assert.deepEqual(svc.parseLinkRateKBps('1500'), { ok:true, value:1500 });
  assert.deepEqual(svc.parseLinkRateKBps('-1'), { ok:false, value:0 });
  assert.equal(svc.parseMaxBytesServed('12.9'), 12);
  assert.equal(svc.zipAllowed({}), true);
  assert.equal(svc.zipAllowed({ allowZip:false }), false);
  const now = 1_700_000_000_000;
  assert.equal(svc.parseExpiry('60', now), now + 60000);
  assert.equal(svc.parseExpiryAt(now + 1234, now), now + 1234);
  assert.equal(svc.parseStartsAt(now + 5000, now), now + 5000);
  assert.equal(svc.parseMaxDownloads('4'), 4);
});

test('new-share never-expire policy remains centralized in share service', () => {
  const svc = makeShareService({ newSharesNeverExpire:true });
  assert.equal(svc.parseNewShareExpiry('60', 1000), null);
  assert.equal(svc.resolveNewShareExpiry({ expiresAt:2000 }, 1000), null);
  const share = { expiresAt:2, firstUseExpirySeconds:3, inactiveExpirySeconds:4, keep:'yes' };
  assert.equal(svc.applyNewShareLifetimePolicy(share), share);
  assert.deepEqual(share, { keep:'yes' });
});

test('upload reception service owns bounded two-way thread projections', () => {
  const svc = createUploadReceptionService({ live:{}, RECEPTION_THREAD_MAX:2, DATA_DIR:'/tmp/data', INBOX_DIR:'/tmp/inbox' });
  const share = { type:'inbox', thread:[] };
  svc.appendReceptionThreadMessage(share, { id:'1', from:'visitor', read:false, ip:'1.2.3.4' });
  svc.appendReceptionThreadMessage(share, { id:'2', from:'owner', read:true });
  svc.appendReceptionThreadMessage(share, { id:'3', from:'visitor', read:false });
  assert.deepEqual(share.thread.map((m) => m.id), ['2', '3']);
  assert.equal(svc.receptionThreadUnreadCount(share), 1);
  assert.equal(svc.receptionThreadEnabled(share), true);
  assert.deepEqual(svc.publicThreadMessage({ id:'x', at:1, from:'owner', name:'private', text:'ok', ip:'secret' }),
    { id:'x', at:1, from:'owner', name:null, text:'ok' });
});

test('transfer service owns transfer-dashboard query and search policy', () => {
  const svc = createTransferService({
    crypto, fs, getState:() => ({ history:[] }), getById:() => null,
    pubIp:(ip) => ip.replace(/\.\d+$/, '.x'), ipNameFor:(ip) => ip === '10.0.0.x' ? 'office' : '',
  });
  const now = 1_700_000_000_000;
  const filters = svc.dashboardQueryOptions({ query:{ days:'7', direction:'down', status:'completed', type:'file', q:'office' } }, now);
  assert.equal(filters.cutoff, now - 7 * 86400000);
  assert.equal(svc.dashboardRecordMatches({ direction:'down', completed:true, type:'file', ip:'10.0.0.4' }, filters), true);
  assert.equal(svc.dashboardRecordMatches({ direction:'up', completed:true, type:'file', ip:'10.0.0.4' }, filters), false);
});

test('photo service owns image-dashboard query and status policy', () => {
  const svc = createPhotoService({
    HOST_ROOT:'/tmp', IMAGE_STORE_DIR:'/tmp/i', FULL_IMAGES_DIR:'/tmp/f', THUMBS_DIR:'/tmp/t', MICROS_DIR:'/tmp/m',
    PHOTO_HISTORY_DIR:'/tmp/h', PHOTO_VERSIONS_DIR:'/tmp/v', ADAPTIVE_IMAGES_DIR:'/tmp/a',
    LEGACY_IMAGES_DIR:'/tmp/li', LEGACY_THUMBS_DIR:'/tmp/lt', LEGACY_MICROS_DIR:'/tmp/lm', LEGACY_PHOTO_HISTORY_DIR:'/tmp/lh',
    getState:() => ({ photoHistory:[] }), listShares:() => [], trashItems:() => [],
    hostToContainer:(v) => v, assertRealWithin:async () => true,
    isActive:(share, now) => !share.revoked && (!share.expiresAt || now <= share.expiresAt),
  });
  const now = 1_700_000_000_000;
  const filters = svc.photoDashboardQueryOptions({ query:{ days:'30', status:'active', format:'JPG', q:'cover' } }, now);
  assert.equal(filters.format, 'jpg');
  assert.equal(svc.photoMatchesDashboardFilters({ type:'photo', name:'Cover.jpg', token:'abc', createdAt:now - 1000 }, filters, now), true);
  assert.equal(svc.photoMatchesDashboardFilters({ type:'photo', name:'Cover.png', token:'abc', createdAt:now - 1000 }, filters, now), false);
});

test('connector domain service owns persisted connector inventory and share references', () => {
  const state = {
    meta:{ storageConnectors:[{ id:'c1', name:'Cloud', type:'webdav', remote:'r', root:'base', readOnly:false }] },
    shares:[{ id:'s1', name:'Inbox', type:'inbox', webStorage:{ connectorId:'c1' } }],
  };
  const connectorApi = { capabilities:async()=>({}), configuredRemotes:async()=>[], importFile:async()=>({}), exportFile:async()=>({}) };
  const noop = () => {};
  const svc = createStorageConnectorJobService({
    storageConnectorService:connectorApi, INBOX_DIR:'/tmp/inbox', IMAGE_STORE_DIR:'/tmp/images', HOST_ROOT:'/tmp',
    getState:() => state, trashItems:() => [{ share:{ id:'s2', name:'Old', type:'file', webStorage:{ connectorId:'c1' } } }],
    persist:noop, persistNow:() => true, scheduleFlush:noop, crypto, path,
    withinRoot:() => true, assertRealWithin:async()=>true, hostToContainer:(v)=>v, clientIp:()=>'', cleanConnectorPath:(v)=>v,
    clamavEnabled:() => false, scanFile:async()=>null, quarantineFile:async()=>null,
    connectorErrorCode:() => 'connector-failed', logAudit:noop, getAccountById:() => null, scheduleSearchReindex:noop,
  });
  assert.equal(svc.getStorageConnector('c1').name, 'Cloud');
  assert.deepEqual(svc.publicConnector(svc.getStorageConnector('c1')), {
    id:'c1', name:'Cloud', type:'webdav', remote:'r', root:'base', readOnly:false, createdAt:0, updatedAt:0,
  });
  assert.deepEqual(svc.webStorageShareReferencesConnector('c1'), [
    { id:'s1', name:'Inbox', type:'inbox', writable:true, trashed:false },
    { id:'s2', name:'Old', type:'file', writable:false, trashed:true },
  ]);
});
