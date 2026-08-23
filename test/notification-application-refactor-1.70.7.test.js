'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplicationContext } = require('../lib/server/application-context');
const { createPwaServiceRegistry } = require('../lib/server/pwa-composition-service');
const { createNotificationApplication } = require('../lib/server/notification-application');

function makeHarness(options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-notification-app-'));
  const state = {
    settings:{ notifySecurity:true },
    shares:[],
    meta:{ accounts:[{ id:'owner-1', username:'owner', role:'owner' }], pushSubs:[], notifications:[] },
  };
  const applicationContext = options.applicationContext || createApplicationContext();
  const pwaRegistry = options.pwaRegistry || createPwaServiceRegistry();
  let securityAlertHandler = null;
  let shareMediaReads = 0;
  let uploadReads = 0;
  const shareMedia = {
    transferService:{ activeTransfers:new Map(), readLogTail:() => [] },
    photoService:{ photoStatsOf:() => ({ full:{ v:0 }, thumb:{ v:0 }, micro:{ v:0 } }) },
    dlpService:{ getOcrUnavailableNotedAt:() => 0 },
    getSearchIndexError:() => null,
  };
  const upload = { pendingUsageForShare:() => 0 };

  const app = createNotificationApplication({
    applicationContext,
    pwaRegistry,
    platform:{ nodemailer:null, webpush:options.webpush || null },
    config:{
      APP_NAME:'Direct-Xfer', APP_VERSION:'1.70.21', DATA_DIR:tmp,
      PUBLIC_URL:'', TRUST_PROXY:false, STORAGE_SETUP:null,
      WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'',
    },
    state:{
      getState:() => state,
      persist:() => true,
      persistNow:() => true,
      scheduleFlush:() => {},
    },
    settingsService:{ getSettings:() => state.settings },
    accountService:{
      accountList:() => state.meta.accounts,
      getAccountById:(id) => state.meta.accounts.find((row) => row.id === id) || null,
    },
    sharePresentationService:{ decorateShare:(share) => ({ ...share }) },
    activityPresenceService:{ pubIp:(ip) => ip || '', emitLiveActivity:() => {} },
    auditService:{
      logAudit:() => {},
      auditReq:() => {},
      setSecurityAlertHandler:(handler) => { securityAlertHandler = handler; },
      getKeyMigrationStatus:() => null,
    },
    bridges:{
      getById:(id) => state.shares.find((row) => row.id === id) || null,
      getByToken:(token) => state.shares.find((row) => row.token === token) || null,
      isActive:() => true,
      listShares:() => state.shares,
      shareFirstUseDeadline:() => 0,
      shareInactiveDeadline:() => 0,
      shareEffectiveExpiry:() => 0,
      parseMaxVisitors:() => 0,
      centerPublicVisitorDeviceLabel:() => '',
      getShareMediaTransferApplication:() => { shareMediaReads += 1; return shareMedia; },
      getUploadReceptionService:() => { uploadReads += 1; return upload; },
      dataWritable:() => true,
      clientIp:() => '127.0.0.1',
    },
    utils:{ formatBytes:(value) => `${value} B`, flagFromCode:() => '' },
  });

  return {
    tmp, state, app, applicationContext, pwaRegistry,
    get securityAlertHandler() { return securityAlertHandler; },
    get shareMediaReads() { return shareMediaReads; },
    get uploadReads() { return uploadReads; },
  };
}

test('notification application owns transport/center/PWA wiring while late domains stay lazy', () => {
  const h = makeHarness();
  try {
    assert.equal(h.shareMediaReads, 0);
    assert.equal(h.uploadReads, 0);
    assert.strictEqual(h.pwaRegistry.current('notification'), h.app.pwaNotificationService);
    assert.strictEqual(h.securityAlertHandler, h.app.notificationService.maybeSecurityAlert);

    h.app.notificationService.aggregateJournalSince(0);
    assert.equal(h.shareMediaReads, 1, 'transfer journal dependency should resolve only when used');

    h.app.registerApplicationDomains();
    h.app.registerApplicationDomains();
    assert.strictEqual(h.applicationContext.current('notification'), h.app.notificationService);
    assert.strictEqual(h.applicationContext.current('notification-center'), h.app.notificationCenterService);
    assert.strictEqual(h.applicationContext.current('pwa-notification'), h.app.pwaNotificationService);
  } finally {
    fs.rmSync(h.tmp, { recursive:true, force:true });
  }
});

test('notification domain publication preflights conflicts before mutating the application context', () => {
  const context = createApplicationContext();
  const foreign = {};
  context.register('notification-center', foreign);
  const h = makeHarness({ applicationContext:context });
  try {
    assert.throws(() => h.app.registerApplicationDomains(), /notification application domain already registered: notification-center/);
    assert.equal(context.current('notification'), null);
    assert.strictEqual(context.current('notification-center'), foreign);
    assert.equal(context.current('pwa-notification'), null);
  } finally {
    fs.rmSync(h.tmp, { recursive:true, force:true });
  }
});


test('notification application refuses a partially pre-published domain graph even with matching identity', () => {
  const h = makeHarness();
  try {
    h.applicationContext.register('notification', h.app.notificationService);
    assert.throws(
      () => h.app.registerApplicationDomains(),
      /notification application domain already registered: notification/,
    );
    assert.strictEqual(h.applicationContext.current('notification'), h.app.notificationService);
    assert.equal(h.applicationContext.current('notification-center'), null);
    assert.equal(h.applicationContext.current('pwa-notification'), null);
  } finally {
    fs.rmSync(h.tmp, { recursive:true, force:true });
  }
});



test('notification application aggregates transport busy state for restore coordination', async () => {
  let resolveDelivery;
  const h = makeHarness({
    webpush:{
      generateVAPIDKeys:() => ({ publicKey:'pub', privateKey:'priv' }),
      sendNotification:() => new Promise((resolve) => { resolveDelivery = resolve; }),
    },
  });
  try {
    const sub = { endpoint:'https://push.invalid/in-flight', keys:{} };
    assert.equal(h.app.isBusyForStateReplacement(), false);
    assert.equal(h.app.notificationService.sendWebPush('test', 'title', 'body', {}, [sub]), 1);
    assert.equal(h.app.isBusyForStateReplacement(), true);
    resolveDelivery({ statusCode:201 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.app.isBusyForStateReplacement(), false);
  } finally {
    fs.rmSync(h.tmp, { recursive:true, force:true });
  }
});


test('notification application exposes one validated live share/media hook facade', () => {
  const h = makeHarness();
  try {
    const expected = [
      'accountCustomNotificationRules', 'pruneCustomNotificationRuleStateForShareId',
      'addShareCenterNotification', 'maybeNotifyDownloadThreshold', 'maybeCenterDownloadMilestone',
      'maybeCenterReceptionQuota', 'evaluateCustomNotificationRulesForShare', 'noteCenterAutoDisabled',
      'logAudit', 'auditReq', 'addAdminCenterNotification', 'centerShareEligibleForVisitorNotification',
      'noteCenterCountry', 'maybeCenterViewThreshold', 'noteCenterVisitorDevice', 'noteCenterViral',
      'noteCenterActivity', 'enrichFirstViewCenterNotification', 'notifyFirstPhotoView',
      'noteCenterServiceState', 'addRequestCenterNotification', 'noteCenterRepeatedDownload',
      'noteCenterHighVolume', 'notify', 'noteLeakSignal', 'noteCenterSharedFileSignature',
      'noteCenterConcurrentDownloadStart',
    ].sort();
    assert.equal(Object.isFrozen(h.app.shareMediaHooks), true);
    assert.deepEqual(Object.keys(h.app.shareMediaHooks).sort(), expected);

    const hook = h.app.shareMediaHooks.noteCenterActivity;
    h.app.notificationCenterService.marker = 'first';
    h.app.notificationCenterService.noteCenterActivity = function noteCenterActivity(value) {
      return `${this.marker}:${value}`;
    };
    assert.equal(hook('x'), 'first:x', 'hook must preserve the owning service receiver');
    h.app.notificationCenterService.marker = 'second';
    h.app.notificationCenterService.noteCenterActivity = function replacement(value) {
      return `${this.marker.toUpperCase()}:${value}`;
    };
    assert.equal(hook('y'), 'SECOND:y', 'hook must resolve the current method instead of a stale capture');
    delete h.app.notificationCenterService.noteCenterActivity;
    assert.throws(() => hook('z'), /contract changed: notificationCenterService\.noteCenterActivity/);
  } finally {
    fs.rmSync(h.tmp, { recursive:true, force:true });
  }
});
