'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServerBootstrapReferences } = require('../lib/server/bootstrap-reference-registry');
const { createCoreStateBridges } = require('../lib/server/core-state-bridges');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');

function shareService(prefix = 'share') {
  return {
    prefix,
    shareLogicalBytesCache:new Map(),
    getById(id) { return `${this.prefix}:${id}`; },
    getByToken() { return null; },
    isActive() { return true; },
    isScheduled() { return false; },
    listShares() { return []; },
    trashItems() { return [this.prefix]; },
    normalizeShareColor(value) { return value || ''; },
    normalizeDescriptionMd(value) { return String(value || ''); },
    shareFirstUseDeadline() { return null; },
    shareInactiveDeadline() { return null; },
    shareEffectiveExpiry() { return null; },
    parseMaxVisitors() { return 0; },
    centerPublicVisitorDeviceLabel() { return ''; },
    displayStatsForShare() { return {}; },
    linkPrefix() { return '/s/'; },
    shareActivityAt() { return null; },
    shareBackingHealthSnapshot() { return {}; },
    shareItems() { return []; },
    shareLastUseAt() { return null; },
    shareLogicalBytes() { return 0; },
    shareLogicalFileCount() { return 0; },
    shareNeedsLogicalBytesScan() { return false; },
    shareStatsBaseline() { return { downloads:0, visitors:0, views:0 }; },
  };
}

function shareMediaApplication(overrides = {}) {
  const activeTransfers = new Map([['one', { id:'one' }]]);
  return {
    shareService:shareService(),
    searchService:{ scheduleReindex() { return 'scheduled'; } },
    photoService:{ photoStatsOf() { return { full:{v:0,u:[]}, thumb:{v:0,u:[]}, micro:{v:0,u:[]} }; }, photoCacheRevision() { return 0; } },
    transferService:{ activeTransfers, listTransfers() { return [...this.activeTransfers.values()]; } },
    ...overrides,
  };
}

function makeBridges() {
  const bootstrapReferences = createServerBootstrapReferences();
  const pwaDevice = {
    marker:'pwa',
    pwaDevices() { return [this.marker]; },
    photoUploadDeviceName() { return null; },
    shareCreatorDeviceName() { return null; },
  };
  const pwaRegistry = {
    current(name) { return name === 'device' ? pwaDevice : null; },
  };
  const bridges = createCoreStateBridges({
    bootstrapReferences,
    pwaRegistry,
    getServerScheme:() => 'https',
    clientIp:() => '127.0.0.1',
  });
  return { bootstrapReferences, pwaDevice, bridges };
}

test('priority 3 centralizes core late bridges without capturing unavailable providers', () => {
  const { bootstrapReferences, pwaDevice, bridges } = makeBridges();
  assert.ok(Object.isFrozen(bridges));
  assert.equal(bridges.getServerScheme(), 'https');
  assert.deepEqual(bridges.getPwaDevices(), ['pwa']);
  assert.strictEqual(bridges.getPwaDeviceService(), pwaDevice);
  assert.throws(() => bridges.getShareService(), /provider not ready: share service/);
  assert.throws(() => bridges.getPhotoService(), /provider not ready: photo service/);
  assert.throws(() => bridges.getActiveTransfers(), /provider not ready: transfer service/);
  assert.throws(() => bridges.isSessionActive('sid'), /bootstrap-reference-not-ready:security\.isSessionActive/);
  assert.throws(() => bridges.parseHotlinkHosts('a.example'), /bootstrap-reference-not-ready:publicHttp\.parseHotlinkHosts/);

  const application = shareMediaApplication();
  bootstrapReferences.bindShareMediaTransfer(application);
  assert.strictEqual(bridges.getShareService(), application.shareService);
  assert.strictEqual(bridges.getPhotoService(), application.photoService);
  assert.strictEqual(bridges.getActiveTransfers(), application.transferService.activeTransfers);
  assert.equal(bridges.getShareById('abc'), 'share:abc');
  assert.deepEqual(bridges.getTrashItems(), ['share']);
});

test('core bridges stay live across provider method/property replacement and preserve receivers', () => {
  const { bootstrapReferences, bridges } = makeBridges();
  const application = shareMediaApplication();
  bootstrapReferences.bindShareMediaTransfer(application);

  application.shareService.prefix = 'changed';
  application.shareService.trashItems = function replacementTrashItems() { return [`${this.prefix}:new`]; };
  assert.deepEqual(bridges.getTrashItems(), ['changed:new']);

  const replacementTransfers = new Map([['two', { id:'two' }]]);
  application.transferService.activeTransfers = replacementTransfers;
  assert.strictEqual(bridges.getActiveTransfers(), replacementTransfers);

  Object.defineProperty(application.transferService, 'activeTransfers', {
    configurable:true,
    get() { throw new Error('accessor must not run'); },
  });
  assert.throws(
    () => bridges.getActiveTransfers(),
    /activeTransfers must be an own data property/,
  );
});

test('security and public HTTP core bridges join the same validated bootstrap registry', () => {
  const { bootstrapReferences, bridges } = makeBridges();
  const sessionService = {
    prefix:'session',
    isSessionActive(sid) { return `${this.prefix}:${sid}`; },
  };
  const publicHttp = {
    prefix:'hotlink',
    parseHotlinkHosts(value) { return [`${this.prefix}:${value}`]; },
  };
  bootstrapReferences.bindSecurity({ sessionService });
  bootstrapReferences.bindPublicHttp(publicHttp);
  assert.equal(bridges.isSessionActive('abc'), 'session:abc');
  assert.deepEqual(bridges.parseHotlinkHosts('cdn.example'), ['hotlink:cdn.example']);

  sessionService.prefix = 'live';
  sessionService.isSessionActive = function replacement(sid) { return `${this.prefix}:new:${sid}`; };
  assert.equal(bridges.isSessionActive('xyz'), 'live:new:xyz');
});

test('share/media bootstrap expansion remains atomic when a newly-added provider contract is invalid', () => {
  const { bootstrapReferences } = makeBridges();
  const application = shareMediaApplication({ photoService:{} });
  assert.throws(
    () => bootstrapReferences.bindShareMediaTransfer(application),
    /photo\.photoStatsOf must be an own function/,
  );
  for (const namespace of ['share', 'search', 'photo', 'transfer']) {
    assert.equal(bootstrapReferences.current(namespace), null, namespace);
  }
});

test('server.js exposes one core bridge facade instead of individual late closures', () => {
  const server = read('server.js');
  const core = read('lib/server/core-state-application.js');
  assert.match(server, /const coreStateBridges = createCoreStateBridges\(\{/);
  assert.match(server, /bridges:coreStateBridges/);
  assert.match(server, /bootstrapReferences\.bindSecurity\(securityAuthApplication\)/);
  assert.match(server, /bootstrapReferences\.bindPublicHttp\(publicHttpApplication\)/);
  for (const legacy of [
    'getShareService:() => shareService',
    'getPhotoService:() => photoService',
    'getPwaDeviceService:() => pwaDeviceService',
    'getTrashItems:() => trashItems()',
    'getPwaDevices:() => pwaDevices()',
    'isSessionActive:(sid, roles) => sessionService.isSessionActive(sid, roles)',
    'getActiveTransfers:() => activeTransfers',
    'parseHotlinkHosts:(...args) => parseHotlinkHosts(...args)',
  ]) assert.ok(!server.includes(legacy), `legacy core bridge remains in server.js: ${legacy}`);
  assert.match(core, /pubIp:activityPresenceService\.pubIp/);
  assert.doesNotMatch(core, /bridges\.pubIp/);
  assert.ok(server.split('\n').length < 710, `server.js should shrink after core bridge extraction (${server.split('\n').length} lines)`);
});

test('Windows runtime integrity manifest protects the core-state bridge boundary', () => {
  const source = read('lib/server/core-state-bridges.js');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ \"lib/server/core-state-bridges\\.js\", \"${hash}\" \\}`));
});
