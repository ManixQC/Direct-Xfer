'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { createNotificationCenterService } = require('../lib/server/notification-center-service');
const { createPwaNotificationService } = require('../lib/server/pwa-notification-service');
const { createNotificationService } = require('../lib/server/notification-service');

function makeCenterHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-notification-center-'));
  let state = {
    meta:{ accounts:[{ id:'owner-1', username:'owner', role:'owner' }] },
    shares:[],
  };
  let cookieDevice = null;
  let publicIp = (ip) => ip;
  const settings = { geoLookup:true, diskFreeWarnPercent:0, dlpEnabled:false, dlpScanOcr:false };
  const service = createNotificationCenterService({
    APP_VERSION:'1.69.6', DATA_DIR:tmp, PUBLIC_URL:'', TRUST_PROXY:false,
    STORAGE_SETUP:{ inboxUnconfigured:false, imagesUnconfigured:false },
    getState:() => state, getSettings:() => settings,
    scheduleFlush:() => {}, persist:() => true, persistNow:() => true,
    accountList:() => state.meta.accounts,
    getAccountById:(id) => state.meta.accounts.find((a) => a.id === id) || null,
    shareOwnerAccount:(share) => state.meta.accounts.find((a) => a.id === share.ownerId) || null,
    getPwaDevice:() => cookieDevice,
    pwaDeviceCreatorAccount:(device) => device && state.meta.accounts.find((a) => a.id === device.accountId) || null,
    pwaDeviceOwnerAccount:() => null,
    pwaDeviceResolvedAccount:() => null, pwaDevices:() => [],
    getById:(id) => state.shares.find((share) => share.id === id) || null,
    getByToken:(token) => state.shares.find((share) => share.token === token) || null,
    listShares:() => state.shares, isActive:() => true,
    shareEffectiveExpiry:(share) => Number(share.expiresAt) || 0,
    decorateShare:(share) => ({ url:`/s/${share.token}`, photo:{ imgUrl:`/i/${share.token}` } }),
    formatBytes:(n) => `${Number(n) || 0} B`, flagFromCode:() => '', pubIp:(ip) => publicIp(ip),
    parseMaxVisitors:(value) => Math.max(0, Number(value) || 0),
    centerPublicVisitorDeviceLabel:() => 'Browser',
    pendingUsageForShare:() => ({ files:0, bytes:0 }),
    photoStatsOf:() => ({ full:{v:0}, thumb:{v:0}, micro:{v:0} }),
    dataWritable:() => true, emitLiveActivity:() => {}, checkExpiringShares:() => {},
    pushSubs:() => [], getActiveTransfers:() => new Map(),
    getSearchIndexError:() => null, getAuditKeyMigrationStatus:() => null,
    webPushAvailable:() => true, getDlpOcrUnavailableNotedAt:() => 0,
  });
  return {
    tmp, service, settings,
    get state() { return state; },
    replaceState(next) { state = next; },
    setCookieDevice(device) { cookieDevice = device; },
    setPublicIp(fn) { publicIp = fn; },
  };
}

test('notification center and PWA push domains are extracted from server.js', () => {
  const server = read('server.js');
  const app = read('lib/server/notification-application.js');
  const center = read('lib/server/notification-center-service.js');
  const pwa = read('lib/server/pwa-notification-service.js');
  assert.match(server, /createNotificationApplication/);
  assert.doesNotMatch(server, /createNotificationCenterService/);
  assert.doesNotMatch(server, /createPwaNotificationService/);
  assert.match(app, /createNotificationCenterService/);
  assert.match(app, /createPwaNotificationService/);
  for (const name of ['addCenterNotification','notificationDedupeStore','evaluateCustomNotificationRulesForShare','checkCenterSystemHealth']) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\b`), `${name} should not live in server.js`);
    assert.match(center, new RegExp(`function\\s+${name}\\b`));
  }
  for (const name of ['sendPwaPush','deliverPendingFirstViewPush','notifyFirstPhotoView']) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\b`), `${name} should not live in server.js`);
    assert.match(pwa, new RegExp(`function\\s+${name}\\b`));
  }
  assert.doesNotMatch(server, /function\s+maybeSecurityAlert\b/);
  assert.doesNotMatch(server, /function\s+maybeNotifyDownloadThreshold\b/);
  assert.ok(fs.statSync(path.join(ROOT, 'server.js')).size < 680000, 'server.js should shrink substantially after notification extraction');
});

test('durable dedupe survives deleting the visible notification and restore swaps target the new state root', () => {
  const h = makeCenterHarness();
  try {
    const first = h.service.addCenterNotification('owner-1', 'update-available', { latest:'2.0', dedupeKey:'update:2.0' });
    assert.ok(first);
    assert.equal(h.service.deleteNotificationForAccount('owner-1', first.id), true);
    assert.equal(h.service.addCenterNotification('owner-1', 'update-available', { latest:'2.0', dedupeKey:'update:2.0' }), null,
      'deleting an alert must not erase its independent permanent dedupe ledger');

    const oldState = h.state;
    const restored = { meta:{ accounts:[{ id:'owner-1', username:'owner', role:'owner' }] }, shares:[] };
    h.replaceState(restored);
    const afterRestore = h.service.addCenterNotification('owner-1', 'system-problem', { detail:'restored-state-check' });
    assert.ok(afterRestore);
    assert.equal(restored.meta.notifications.length, 1);
    assert.equal((oldState.meta.notifications || []).length, 0, 'service must not retain the pre-restore state root');
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('muting a category does not poison dedupe state and custom rules stay one-shot', () => {
  const h = makeCenterHarness();
  try {
    assert.deepEqual(h.service.setAccountMutedNotificationCategories('owner-1', ['updates']), ['updates']);
    assert.equal(h.service.addCenterNotification('owner-1', 'update-available', { dedupeKey:'update:future' }), null);
    assert.equal(Object.values(h.state.meta.notificationDedupe || {}).some((r) => r && r.dedupeKey === 'update:future'), false);
    assert.deepEqual(h.service.setAccountMutedNotificationCategories('owner-1', []), []);
    assert.ok(h.service.addCenterNotification('owner-1', 'update-available', { dedupeKey:'update:future' }), 'first event after re-enable should be visible');

    const share = { id:'s1', token:'tok1', ownerId:'owner-1', type:'file', name:'file', downloads:5, views:0, bytesServed:0 };
    h.state.shares.push(share);
    const rule = h.service.upsertCustomNotificationRule('owner-1', { metric:'downloads', threshold:5, shareId:'s1', label:'Five downloads' });
    assert.ok(rule);
    assert.equal(h.service.evaluateCustomNotificationRulesForShare(share), 1);
    assert.equal(h.service.evaluateCustomNotificationRulesForShare(share), 0, 'same rule revision must not re-fire for the same share');
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('PWA first-view push remains pending without a target and clears only after provider acceptance', async () => {
  let state = { shares:[] };
  let subs = [];
  const service = createPwaNotificationService({
    APP_NAME:'Direct-Xfer', getState:() => state,
    getPwaDevice:() => null, pwaDeviceCreatorAccount:() => null, pwaDeviceOwnerAccount:() => null, pwaDevices:() => [],
    pushSubs:() => subs, ownerKeysForShare:() => ['acc:owner-1'],
    sendWebPush:() => 1, sendWebPushAwaited:async () => ({ ok:true, statusCode:201 }), webPushAvailable:() => true,
    effectiveWebhook:() => ({ url:'' }), sendWebhook:() => {}, emailConfigured:() => false, sendMail:() => {},
    addFirstViewCenterNotification:() => {}, emitPwaOwnerEvent:() => 0,
    persist:() => true, scheduleFlush:() => {}, logAudit:() => {}, clientIp:() => '127.0.0.1',
  });
  const share = { id:'photo-1', token:'photo-token', type:'photo', name:'Photo', notifyFirstView:true,
    firstViewPushPending:{ at:Date.now(), variant:'full', attempts:0 } };
  state.shares.push(share);
  assert.equal(await service.deliverPendingFirstViewPush(share), 0);
  assert.equal(share.firstViewPushPending.lastFailure, 'no-subscription');
  subs = [{ endpoint:'https://push.invalid/1', keys:{}, ownerKeys:['acc:owner-1'], lang:'en' }];
  assert.equal(await service.deliverPendingFirstViewPush(share), 1);
  assert.equal(share.firstViewPushPending, undefined);
  assert.equal(share.firstViewPushAcceptedCount, 1);
  assert.match(service.localizedPwaPush({ kind:'test' }, 'es').title, /Prueba de notificaciones push/);
});

test('download-goal threshold policy lives in notification-service and fires once', () => {
  let centerCalls = 0;
  let audits = 0;
  const transport = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'',
    nodemailer:null, webpush:null, getSettings:() => ({ notifySecurity:true }), formatBytes:(n) => `${n} B`,
    persist:() => true, persistNow:() => true, getById:() => null, getByToken:() => null,
    notificationAccountIdForShare:() => 'owner-1', notificationAdminAccountIds:() => ['owner-1'],
    pushSubscriptionsForAccountIds:() => [], noteCenterServiceState:() => {}, noteExpiredPushSub:() => {},
    shareFirstUseDeadline:() => 0, shareInactiveDeadline:() => 0, isActive:() => true, listShares:() => [],
    addShareCenterNotification:() => { centerCalls++; }, logAudit:() => { audits++; }, readLogTail:() => [],
    getState:() => ({ meta:{} }),
  });
  const share = { id:'s1', token:'tok', type:'file', name:'file', downloads:5, notifyDownloadThreshold:5 };
  transport.maybeNotifyDownloadThreshold(share);
  transport.maybeNotifyDownloadThreshold(share);
  assert.ok(Number(share.downloadThresholdNotifiedAt) > 0);
  assert.equal(centerCalls, 1);
  assert.equal(audits, 1);
});


test('request-scoped center alerts keep paired PWA identity ahead of a coincident admin session', () => {
  const h = makeCenterHarness();
  try {
    h.state.meta.accounts.push({ id:'owner-2', username:'second', role:'admin' });
    h.setCookieDevice({ id:'dev-2', accountId:'owner-2' });
    const ids = h.service.notificationAccountIdsForRequest({ pwaDevice:null, session:{ accountId:'owner-1' } });
    assert.deepEqual(ids, ['owner-2']);
    const rows = h.service.addRequestCenterNotification({ pwaDevice:null, session:{ accountId:'owner-1' } }, 'dlp-blocked', { detail:'mixed-cookie' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].accountId, 'owner-2');
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('detached pre-restore share objects cannot create ghost center notifications', () => {
  const h = makeCenterHarness();
  try {
    const oldShare = { id:'s1', token:'tok', ownerId:'owner-1', type:'file', name:'before' };
    h.state.shares.push(oldShare);
    h.replaceState({
      meta:{ accounts:[{ id:'owner-1', username:'owner', role:'owner' }] },
      shares:[{ id:'s1', token:'tok', ownerId:'owner-1', type:'file', name:'restored' }],
    });
    assert.equal(h.service.addShareCenterNotification(oldShare, 'transfer-complete', { bytes:1 }), null);
    assert.equal((h.state.meta.notifications || []).length, 0);
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('traffic heuristics use private ephemeral IP identity, not masked display IPs', () => {
  const h = makeCenterHarness();
  try {
    const share = { id:'s1', token:'tok', ownerId:'owner-1', type:'file', name:'file' };
    h.state.shares.push(share);
    h.setPublicIp(() => '10.0.0.0');
    // Five distinct clients hidden behind the same anonymized display value should
    // still count as five distinct IPs for unusual-activity detection.
    for (let i = 0; i < 20; i += 1) h.service.noteCenterActivity(share, 'download', `10.0.0.${(i % 5) + 1}`);
    assert.ok((h.state.meta.notifications || []).some((n) => n.type === 'unusual-activity'));

    h.state.meta.notifications = [];
    // Conversely, five different clients in that same masked subnet must not be
    // combined into one person's repeated-download counter.
    for (let i = 1; i <= 5; i += 1) h.service.noteCenterRepeatedDownload(share, `10.0.0.${i}`);
    assert.equal((h.state.meta.notifications || []).some((n) => n.type === 'repeated-downloads'), false);
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});

test('browser push transport deduplicates endpoints and removes every stale duplicate', async () => {
  let sends = 0;
  const state = { meta:{ pushSubs:[
    { endpoint:'https://push.invalid/same', keys:{} },
    { endpoint:'https://push.invalid/same', keys:{} },
    { endpoint:'', keys:{} },
  ] } };
  const transport = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'',
    nodemailer:null,
    webpush:{
      generateVAPIDKeys:() => ({ publicKey:'pub', privateKey:'priv' }),
      sendNotification:async () => { sends += 1; return { statusCode:201 }; },
    },
    getSettings:() => ({}), formatBytes:(n) => `${n} B`, persist:() => true, persistNow:() => true,
    getById:() => null, getByToken:() => null, notificationAccountIdForShare:() => null,
    notificationAdminAccountIds:() => [], pushSubscriptionsForAccountIds:() => [], noteCenterServiceState:() => {}, noteExpiredPushSub:() => {},
    shareFirstUseDeadline:() => 0, shareInactiveDeadline:() => 0, isActive:() => true, listShares:() => [],
    addShareCenterNotification:() => null, logAudit:() => {}, readLogTail:() => [], getState:() => state,
  });
  assert.equal(transport.sendWebPush('test', 'title', 'body', {}, state.meta.pushSubs), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.equal(transport.dropPushSub('https://push.invalid/same'), true);
  assert.equal(state.meta.pushSubs.some((sub) => sub.endpoint === 'https://push.invalid/same'), false);
});

test('PWA push targeting sends one message per unique endpoint and records unresolved owners', async () => {
  let sends = 0;
  const pwaState = { shares:[] };
  let subs = [
    { endpoint:'https://push.invalid/same', keys:{}, ownerKeys:['acc:owner-1'], lang:'fr' },
    { endpoint:'https://push.invalid/same', keys:{}, ownerKeys:['acc:owner-1'], lang:'en' },
  ];
  let ownerKeys = ['acc:owner-1'];
  const service = createPwaNotificationService({
    APP_NAME:'Direct-Xfer', getState:() => pwaState, getPwaDevice:() => null,
    pwaDeviceCreatorAccount:() => null, pwaDeviceOwnerAccount:() => null, pwaDevices:() => [], pushSubs:() => subs,
    ownerKeysForShare:() => ownerKeys, sendWebPush:() => 1,
    sendWebPushAwaited:async () => { sends += 1; return { ok:true, statusCode:201 }; }, webPushAvailable:() => true,
    effectiveWebhook:() => ({ url:'' }), sendWebhook:() => {}, emailConfigured:() => false, sendMail:() => {},
    addFirstViewCenterNotification:() => {}, emitPwaOwnerEvent:() => 0, persist:() => true, scheduleFlush:() => {}, logAudit:() => {}, clientIp:() => '127.0.0.1',
  });
  assert.equal(service.pwaPushTargets(['acc:owner-1']).length, 1);
  const result = await service.sendPwaPushAwaited(['acc:owner-1'], { kind:'test' });
  assert.deepEqual(result, { targeted:1, accepted:1, failed:0 });
  assert.equal(sends, 1);

  ownerKeys = [];
  const share = { id:'p1', token:'pt', type:'photo', firstViewPushPending:{ at:Date.now(), attempts:0 } };
  pwaState.shares.push(share);
  assert.equal(await service.deliverPendingFirstViewPush(share), 0);
  assert.equal(share.firstViewPushPending.lastFailure, 'owner-unresolved');
  assert.equal(share.firstViewPushPending.attempts, 1);
});


test('transport initialization failures stay best-effort instead of rejecting notification callers', async () => {
  const state = { meta:{} };
  const mail = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'',
    nodemailer:{ createTransport:() => { throw new Error('bad smtp config'); } }, webpush:null,
    getSettings:() => ({ emailEnabled:true, smtpHost:'smtp.invalid', smtpFrom:'from@example.com', smtpTo:'to@example.com' }),
    formatBytes:String, persist:() => true, persistNow:() => true, getById:() => null, getByToken:() => null,
    notificationAccountIdForShare:() => null, notificationAdminAccountIds:() => [], pushSubscriptionsForAccountIds:() => [],
    noteCenterServiceState:() => {}, noteExpiredPushSub:() => {}, shareFirstUseDeadline:() => 0, shareInactiveDeadline:() => 0,
    isActive:() => true, listShares:() => [], addShareCenterNotification:() => null, logAudit:() => {}, readLogTail:() => [], getState:() => state,
  });
  const result = await mail.sendMail('subject', 'body');
  assert.equal(result.ok, false);
  assert.match(result.error, /bad smtp config/);
  assert.doesNotThrow(() => mail.dispatch('security', 'subject', 'body', {}));

  const push = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'', nodemailer:null,
    webpush:{ generateVAPIDKeys:() => { throw new Error('vapid unavailable'); }, sendNotification:() => { throw new Error('should-not-run'); } },
    getSettings:() => ({}), formatBytes:String, persist:() => true, persistNow:() => true, getById:() => null, getByToken:() => null,
    notificationAccountIdForShare:() => null, notificationAdminAccountIds:() => [], pushSubscriptionsForAccountIds:() => [],
    noteCenterServiceState:() => {}, noteExpiredPushSub:() => {}, shareFirstUseDeadline:() => 0, shareInactiveDeadline:() => 0,
    isActive:() => true, listShares:() => [], addShareCenterNotification:() => null, logAudit:() => {}, readLogTail:() => [], getState:() => ({ meta:{ pushSubs:[{ endpoint:'https://push.invalid/x', keys:{} }] } }),
  });
  assert.equal(push.sendWebPush('test', 'title', 'body', {}, [{ endpoint:'https://push.invalid/x', keys:{} }]), 0);
});


test('muted notification categories do not consume durable milestone and visitor markers', () => {
  const h = makeCenterHarness();
  try {
    const share = { id:'s1', token:'tok', ownerId:'owner-1', type:'file', name:'file', downloads:10, views:10 };
    h.state.shares.push(share);
    h.service.setAccountMutedNotificationCategories('owner-1', ['thresholds','visitors']);
    h.service.maybeCenterDownloadMilestone(share);
    h.service.maybeCenterViewThreshold(share);
    h.service.noteCenterCountry(share, '203.0.113.10', { country:'Canada', countryCode:'CA' });
    h.service.noteCenterVisitorDevice(share, { headers:{ 'user-agent':'AuditBrowser/1.0' } });
    assert.deepEqual(share.centerDownloadMilestones || [], []);
    assert.deepEqual(share.centerViewMilestones || [], []);
    assert.deepEqual(share.centerNotificationCountries || [], []);
    assert.deepEqual(share.centerVisitorAgents || [], []);

    h.service.setAccountMutedNotificationCategories('owner-1', []);
    h.service.maybeCenterDownloadMilestone(share);
    h.service.maybeCenterViewThreshold(share);
    h.service.noteCenterCountry(share, '203.0.113.10', { country:'Canada', countryCode:'CA' });
    h.service.noteCenterVisitorDevice(share, { headers:{ 'user-agent':'AuditBrowser/1.0' } });
    assert.ok(share.centerDownloadMilestones.includes(10));
    assert.ok(share.centerViewMilestones.includes(10));
    assert.ok(share.centerNotificationCountries.includes('CA'));
    assert.equal(share.centerVisitorAgents.length, 1);
  } finally { fs.rmSync(h.tmp, { recursive:true, force:true }); }
});


test('digest aggregation normalizes restored journal numbers instead of concatenating strings', () => {
  const now = Date.now();
  const transport = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'', nodemailer:null, webpush:null,
    getSettings:() => ({}), formatBytes:String, persist:() => true, persistNow:() => true, getById:() => null, getByToken:() => null,
    notificationAccountIdForShare:() => null, notificationAdminAccountIds:() => [], pushSubscriptionsForAccountIds:() => [],
    noteCenterServiceState:() => {}, noteExpiredPushSub:() => {}, shareFirstUseDeadline:() => 0, shareInactiveDeadline:() => 0,
    isActive:() => true, listShares:() => [], addShareCenterNotification:() => null, logAudit:() => {},
    readLogTail:() => [
      JSON.stringify({ endedAt:String(now), bytes:'100', direction:'down', shareId:'s1', name:'A' }),
      JSON.stringify({ endedAt:now, bytes:'200', direction:'up', shareId:'s1', name:'A' }),
      JSON.stringify({ endedAt:now, bytes:'not-a-number', direction:'down', shareId:'s2', name:'B' }),
    ],
    getState:() => ({ meta:{} }),
  });
  const agg = transport.aggregateJournalSince(now - 1000);
  assert.equal(agg.transfers, 3);
  assert.equal(agg.bytes, 300);
  assert.equal(agg.down, 100);
  assert.equal(agg.up, 200);
  assert.equal(agg.perLink.get('s1').bytes, 300);
});

test('notification transport exposes in-flight Web Push work to state replacement coordination', async () => {
  let resolveDelivery;
  const state = { meta:{ pushSubs:[{ endpoint:'https://push.invalid/in-flight', keys:{} }] } };
  const transport = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'',
    nodemailer:null,
    webpush:{
      generateVAPIDKeys:() => ({ publicKey:'pub', privateKey:'priv' }),
      sendNotification:() => new Promise((resolve) => { resolveDelivery = resolve; }),
    },
    getSettings:() => ({}), formatBytes:String, persist:() => true, persistNow:() => true,
    getById:() => null, getByToken:() => null, notificationAccountIdForShare:() => null,
    notificationAdminAccountIds:() => [], pushSubscriptionsForAccountIds:() => [], noteCenterServiceState:() => {}, noteExpiredPushSub:() => {},
    shareFirstUseDeadline:() => 0, shareInactiveDeadline:() => 0, isActive:() => true, listShares:() => [],
    addShareCenterNotification:() => null, logAudit:() => {}, readLogTail:() => [], getState:() => state,
  });

  assert.equal(transport.isBusyForStateReplacement(), false);
  assert.equal(transport.sendWebPush('test', 'title', 'body', {}, state.meta.pushSubs), 1);
  assert.equal(transport.isBusyForStateReplacement(), true);
  resolveDelivery({ statusCode:201 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.isBusyForStateReplacement(), false);
});

test('PWA first-view delivery remains busy until its complete state mutation window closes', async () => {
  let resolvePush;
  const share = {
    id:'photo-1', token:'photo-token', type:'photo', notifyFirstView:true,
    firstViewPushPending:{ at:Date.now(), attempts:0, variant:'full' },
  };
  const state = { shares:[share] };
  const service = createPwaNotificationService({
    APP_NAME:'Direct-Xfer', getState:() => state, getPwaDevice:() => null,
    pwaDeviceCreatorAccount:() => null, pwaDeviceOwnerAccount:() => null, pwaDevices:() => [],
    pushSubs:() => [{ endpoint:'https://push.invalid/photo', keys:{}, ownerKeys:['acc:owner-1'], lang:'fr' }],
    ownerKeysForShare:() => ['acc:owner-1'], sendWebPush:() => 1,
    sendWebPushAwaited:() => new Promise((resolve) => { resolvePush = resolve; }), webPushAvailable:() => true,
    effectiveWebhook:() => ({ url:'' }), sendWebhook:() => {}, emailConfigured:() => false, sendMail:() => {},
    addFirstViewCenterNotification:() => {}, emitPwaOwnerEvent:() => 0, persist:() => true,
    scheduleFlush:() => {}, logAudit:() => {}, clientIp:() => '127.0.0.1',
  });

  const job = service.deliverPendingFirstViewPush(share);
  assert.equal(service.isBusyForStateReplacement(), true);
  resolvePush({ ok:true, statusCode:201 });
  assert.equal(await job, 1);
  assert.equal(service.isBusyForStateReplacement(), false);
  assert.equal(share.firstViewPushPending, undefined);
});

test('awaited stale Push pruning remains inside the state-replacement barrier', async () => {
  const state = { meta:{ pushSubs:[{ endpoint:'https://push.invalid/stale', keys:{} }] } };
  let transport = null;
  let busyDuringPrune = false;
  transport = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'', nodemailer:null,
    webpush:{
      generateVAPIDKeys:() => ({ publicKey:'pub', privateKey:'priv' }),
      sendNotification:async () => { const error = new Error('gone'); error.statusCode = 410; throw error; },
    },
    getSettings:() => ({}), formatBytes:String, persist:() => true, persistNow:() => true,
    getById:() => null, getByToken:() => null, notificationAccountIdForShare:() => null,
    notificationAdminAccountIds:() => [], pushSubscriptionsForAccountIds:() => [], noteCenterServiceState:() => {},
    noteExpiredPushSub:() => { busyDuringPrune = transport.isBusyForStateReplacement(); },
    shareFirstUseDeadline:() => 0, shareInactiveDeadline:() => 0, isActive:() => true, listShares:() => [],
    addShareCenterNotification:() => null, logAudit:() => {}, readLogTail:() => [], getState:() => state,
  });
  const result = await transport.sendWebPushAwaited('test', 'title', 'body', {}, state.meta.pushSubs[0]);
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 410);
  assert.equal(busyDuringPrune, true);
  assert.equal(transport.isBusyForStateReplacement(), false);
  assert.equal(state.meta.pushSubs.length, 0);
});
