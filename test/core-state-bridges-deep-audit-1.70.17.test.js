'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerBootstrapReferences } = require('../lib/server/bootstrap-reference-registry');
const { createCoreStateBridges } = require('../lib/server/core-state-bridges');
const { createPwaServiceRegistry } = require('../lib/server/pwa-composition-service');

function fullShareService() {
  return {
    shareLogicalBytesCache:new Map(),
    getById() { return null; },
    getByToken() { return null; },
    isActive() { return true; },
    isScheduled() { return false; },
    listShares() { return []; },
    trashItems() { return []; },
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

function application(overrides = {}) {
  return {
    shareService:fullShareService(),
    searchService:{ scheduleReindex() {} },
    photoService:{ photoStatsOf() { return {}; }, photoCacheRevision() { return 0; } },
    transferService:{ activeTransfers:new Map(), listTransfers() { return []; } },
    ...overrides,
  };
}

function bridgesWith(pwaRegistry = createPwaServiceRegistry()) {
  const bootstrapReferences = createServerBootstrapReferences();
  const bridges = createCoreStateBridges({
    bootstrapReferences,
    pwaRegistry,
    getServerScheme:() => 'http',
    clientIp:() => '127.0.0.1',
  });
  return { bootstrapReferences, bridges, pwaRegistry };
}

test('PWA core bridge returns the concrete current device service rather than the deferred registry proxy', () => {
  const { bridges, pwaRegistry } = bridgesWith();
  assert.throws(() => bridges.getPwaDeviceService(), /provider not ready: pwa device service/);

  // Asking Core for a not-yet-bound service must not mutate the deferred PWA
  // capability contract. A minimal device can still bind successfully afterward.
  const incomplete = {};
  assert.strictEqual(pwaRegistry.bind('device', incomplete), incomplete);
  assert.throws(
    () => bridges.getPwaDeviceService(),
    /pwa device service\.photoUploadDeviceName must be an own function/,
  );
});

test('PWA device bridge stays live, preserves identity and never executes replacement accessors', () => {
  const { bridges, pwaRegistry } = bridgesWith();
  const device = {
    marker:'device',
    photoUploadDeviceName() { return this.marker; },
    shareCreatorDeviceName() { return this.marker; },
    pwaDevices() { return [this.marker]; },
  };
  pwaRegistry.bind('device', device);
  assert.strictEqual(bridges.getPwaDeviceService(), device);
  assert.deepEqual(bridges.getPwaDevices(), ['device']);

  device.marker = 'live';
  assert.deepEqual(bridges.getPwaDevices(), ['live']);
  let getterRuns = 0;
  Object.defineProperty(device, 'photoUploadDeviceName', {
    configurable:true,
    get() { getterRuns += 1; return () => 'unsafe'; },
  });
  assert.throws(
    () => bridges.getPwaDeviceService(),
    /photoUploadDeviceName must be an own function/,
  );
  assert.equal(getterRuns, 0);
});

test('share/media bind rejects presentation-surface drift atomically before publication', () => {
  for (const [label, mutate, pattern] of [
    ['share', (app) => { delete app.shareService.shareStatsBaseline; }, /share\.shareStatsBaseline must be an own function/],
    ['photo', (app) => { delete app.photoService.photoCacheRevision; }, /photo\.photoCacheRevision must be an own function/],
  ]) {
    const { bootstrapReferences } = bridgesWith();
    const app = application();
    mutate(app);
    assert.throws(() => bootstrapReferences.bindShareMediaTransfer(app), pattern, label);
    for (const namespace of ['share', 'search', 'photo', 'transfer']) {
      assert.equal(bootstrapReferences.current(namespace), null, `${label}:${namespace}`);
    }
  }
});

test('share whole-service bridge validates live data capability without invoking accessors', () => {
  const { bootstrapReferences, bridges } = bridgesWith();
  const app = application();
  bootstrapReferences.bindShareMediaTransfer(app);
  assert.strictEqual(bridges.getShareService(), app.shareService);

  let getterRuns = 0;
  Object.defineProperty(app.shareService, 'shareLogicalBytesCache', {
    configurable:true,
    get() { getterRuns += 1; return new Map(); },
  });
  assert.throws(
    () => bridges.getShareService(),
    /shareLogicalBytesCache must be an own data property/,
  );
  assert.equal(getterRuns, 0);
});
