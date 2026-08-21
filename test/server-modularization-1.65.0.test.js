
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g,'\n').replace(/\r/g,'\n');

test('server entry point delegates large cohesive subsystems to dedicated modules', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/lib\/server\/public-pages'\)/);
  assert.match(server, /require\('\.\/lib\/server\/tls-manager'\)/);
  assert.match(server, /require\('\.\/lib\/server\/network-services'\)/);
  assert.match(server, /require\('\.\/lib\/server\/notification-service'\)/);
  assert.match(server, /require\('\.\/lib\/server\/backup-service'\)/);
  assert.doesNotMatch(server, /const PAGE_STYLE = `/);
  assert.doesNotMatch(server, /function ensureLocalCa\(/);
  assert.doesNotMatch(server, /async function checkPort\(/);
  assert.match(server, /Architecture map/);
  assert.ok(server.split('\n').length < 23000, 'server.js should stay below 23k lines after readability refactor');
});

test('extracted server modules remain CommonJS factories with explicit dependencies', () => {
  const pages = read('lib/server/public-pages.js');
  const tls = read('lib/server/tls-manager.js');
  const network = read('lib/server/network-services.js');
  const notifications = read('lib/server/notification-service.js');
  const backup = read('lib/server/backup-service.js');
  assert.match(pages, /function createPublicPages\(deps\)/);
  assert.match(tls, /function createTlsManager\(deps\)/);
  assert.match(network, /function createNetworkServices\(deps\)/);
  assert.match(notifications, /function createNotificationService\(deps\)/);
  assert.match(backup, /function createBackupService\(deps\)/);
  assert.match(pages, /module\.exports = \{ createPublicPages \}/);
  assert.match(tls, /module\.exports = \{ createTlsManager \}/);
  assert.match(network, /module\.exports = \{ createNetworkServices \}/);
  assert.match(notifications, /module\.exports = \{ createNotificationService \}/);
  assert.match(backup, /module\.exports = \{ createBackupService \}/);
});

test('collaborative album uploads do not reference an orphan mimeExt symbol', () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /\bmimeExt\b/);
  assert.match(server, /const nameExt = \/\\\.\(\[A-Za-z0-9\]\+\)\$\//);
  assert.match(server, /type\.slice\('image\/'.length\)/);
  assert.match(server, /if \(ext === 'jpeg'\) ext = 'jpg'/);
  assert.match(server, /const rawName = requestedName \|\| \('image\.' \+ ext\)/);
});

test('network module keeps exported update state live across checks', async () => {
  const { createNetworkServices } = require('../lib/server/network-services');
  const oldFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({ results: [
        { name:'latest', digest:'sha256:new' },
        { name:'1.69.0', digest:'sha256:new' },
        { name:'1.67.26', digest:'sha256:current' },
        { name:'1.65.0', digest:'sha256:old' },
      ] }),
    });
    const svc = createNetworkServices({
      net: require('node:net'), os: require('node:os'), LOCAL_IP:'', APP_VERSION:'1.67.26', UPDATE_REPO:'owner/repo', UPDATE_TAG:'latest',
      compareSemver:(a,b)=>a.localeCompare(b, undefined, { numeric:true }), updateCheckEnabled:()=>true,
      addAdminCenterNotification:()=>{}, getState:()=>({meta:{}}), persist:()=>{}, maskToPrefix:()=>24,
      ipToInt:()=>null, intToIp:()=>'', isPrivateIp:()=>false, getSettings:()=>({geoLookup:false}),
      flagFromCode:()=>'', noteCenterServiceState:()=>{},
    });
    const live = svc.updateState;
    await svc.checkForUpdate();
    assert.strictEqual(svc.updateState, live);
    assert.equal(live.latest, '1.69.0');
    assert.equal(live.available, true);
  } finally { global.fetch = oldFetch; }
});

test('TLS module reads the current restored state instead of a stale state object', () => {
  const { createTlsManager } = require('../lib/server/tls-manager');
  let current = { settings:{ tlsLocalCa:false, tlsSelfSigned:false } };
  const mgr = createTlsManager({
    fs, path, crypto:require('node:crypto'), os:require('node:os'), net:require('node:net'), tls:require('node:tls'), forge:{},
    bool:(v)=>v === true || v === 'true' || v === '1', isPrivateIp:()=>false,
    BIND:'0.0.0.0', DATA_DIR:path.join(ROOT,'.tmp-test-tls'), PUBLIC_HOST:'', PUBLIC_URL:'', LOCAL_IP:'', getState:()=>current,
  });
  assert.equal(mgr.configuredSelfSignedTls(), false);
  current = { settings:{ tlsLocalCa:true, tlsSelfSigned:false } };
  assert.equal(mgr.configuredSelfSignedTls(), true);
});


test('notification service follows replaced root state and keeps runtime state private', () => {
  const { createNotificationService } = require('../lib/server/notification-service');
  let current = { meta:{} };
  const noop = () => {};
  const svc = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'',
    nodemailer:null, webpush:null, getSettings:()=>({}), formatBytes:n=>String(n), persist:noop, persistNow:()=>true,
    getById:()=>null, getByToken:()=>null, notificationAccountIdForShare:()=>null, notificationAdminAccountIds:()=>[],
    pushSubscriptionsForAccountIds:()=>[], noteCenterServiceState:noop, noteExpiredPushSub:noop,
    shareFirstUseDeadline:()=>0, shareInactiveDeadline:()=>0, isActive:()=>true, listShares:()=>[],
    addShareCenterNotification:noop, logAudit:noop, readLogTail:()=>[], getState:()=>current,
  });
  const first = svc.pushSubs(); first.push({endpoint:'one'});
  assert.equal(current.meta.pushSubs.length, 1);
  current = { meta:{} };
  assert.equal(svc.pushSubs().length, 0);
  assert.equal(svc.autoWebhookFormat('https://hooks.slack.com/services/x'), 'slack');
  svc.clearRuntimeState();
});

test('backup service exposes creation helpers while restore stays in server.js', () => {
  const server = read('server.js');
  const backup = read('lib/server/backup-service.js');
  assert.match(backup, /async function performBackup/);
  assert.match(backup, /async function putBackupS3/);
  assert.match(server, /function restoredAuditEntries/);
  assert.match(server, /function clearRuntimeAfterRestore/);
  assert.doesNotMatch(server, /async function runBackup\(/);
});

test('backup service serializes the current restored state instead of the empty proxy target', () => {
  const { createBackupService } = require('../lib/server/backup-service');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-backup-service-'));
  try {
    let current = { version:1, shares:[{id:'before'}], trash:[], settings:{}, history:[], photoHistory:[], stats:{}, meta:{secrets:{}}, audit:[], ipNames:{}, undoLog:[], activityLog:[] };
    const svc = createBackupService({
      fs, path, crypto, forge:null, DATA_KEY:null, SECRETS_DIR:tmp,
      LOG_FILE:path.join(tmp,'transfers.log'), AUDIT_CHAIN_FILE:path.join(tmp,'audit-chain.log'), AUDIT_HEAD_FILE:path.join(tmp,'audit-head.json'),
      APP_NAME:'Direct-Xfer', APP_VERSION:'1.67.26', getState:()=>current,
      localCaPaths:()=>({}), readLocalCaCertificateOnly:()=>null, localCaFeatureRelevant:()=>false, readManagedTlsFile:()=>'',
      validateLocalCaCertificate:()=>{}, validateLeafCertificate:()=>{}, auditKeyId:()=> 'test-key', ensureAuditChainKey:()=>Buffer.alloc(32),
      encryptStore:x=>x, decryptStore:x=>x, getSettings:()=>({}), scheduleFlush:()=>{}, dispatch:()=>{}, formatBytes:n=>String(n), logAudit:()=>{}, DAY_MS:86400000,
    });
    let roundTrip = svc.parseBackup(svc.serializeBackup(svc.buildBackupBundle()));
    assert.equal(roundTrip.store.shares[0].id, 'before');
    current = { ...current, shares:[{id:'after'}], meta:{secrets:{}} };
    roundTrip = svc.parseBackup(svc.serializeBackup(svc.buildBackupBundle()));
    assert.equal(roundTrip.store.shares[0].id, 'after');
  } finally { fs.rmSync(tmp, {recursive:true,force:true}); }
});

test('SMTP cache is owned by notification service and refreshes when credentials change', async () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /\bmailerCache\b/);
  assert.match(server, /resetMailerCache\(\)/);
  const { createNotificationService } = require('../lib/server/notification-service');
  let settings = { emailEnabled:true, smtpHost:'mail.test', smtpPort:587, smtpSecure:false, smtpUser:'user', smtpPass:'one', smtpTo:'to@test', smtpFrom:'from@test' };
  let created = 0, closed = 0;
  const nodemailer = { createTransport(opts) { created++; return { opts, sendMail:async()=>({}), close:()=>{closed++;} }; } };
  const noop = () => {};
  const svc = createNotificationService({
    APP_NAME:'Direct-Xfer', WEBHOOK_URL:'', WEBHOOK_FORMAT:'', SMTP_URL:'', EMAIL_FROM:'', EMAIL_TO:'', nodemailer, webpush:null,
    getSettings:()=>settings, formatBytes:n=>String(n), persist:noop, persistNow:()=>true, getById:()=>null, getByToken:()=>null,
    notificationAccountIdForShare:()=>null, notificationAdminAccountIds:()=>[], pushSubscriptionsForAccountIds:()=>[], noteCenterServiceState:noop,
    noteExpiredPushSub:noop, shareFirstUseDeadline:()=>0, shareInactiveDeadline:()=>0, isActive:()=>true, listShares:()=>[],
    addShareCenterNotification:noop, logAudit:noop, readLogTail:()=>[], getState:()=>({meta:{}}),
  });
  await svc.sendMail('one','body');
  assert.equal(created, 1);
  await svc.sendMail('two','body');
  assert.equal(created, 1, 'unchanged SMTP config should reuse its transport');
  settings = { ...settings, smtpPass:'two' };
  await svc.sendMail('three','body');
  assert.equal(created, 2, 'password change must rebuild the transport');
  svc.resetMailerCache();
  assert.equal(closed, 1, 'explicit invalidation should close the current transport when supported');
});

test('notification runtime reset clears stale delivery status after a restore', async () => {
  const { createNotificationService } = require('../lib/server/notification-service');
  const noop=()=>{};
  const nodemailer={createTransport:()=>({sendMail:async()=>({})})};
  const settings={emailEnabled:true,smtpHost:'mail.test',smtpPort:587,smtpUser:'u',smtpPass:'p',smtpTo:'to@test',smtpFrom:'from@test'};
  const svc=createNotificationService({APP_NAME:'Direct-Xfer',WEBHOOK_URL:'',WEBHOOK_FORMAT:'',SMTP_URL:'',EMAIL_FROM:'',EMAIL_TO:'',nodemailer,webpush:null,getSettings:()=>settings,formatBytes:n=>String(n),persist:noop,persistNow:()=>true,getById:()=>null,getByToken:()=>null,notificationAccountIdForShare:()=>null,notificationAdminAccountIds:()=>[],pushSubscriptionsForAccountIds:()=>[],noteCenterServiceState:noop,noteExpiredPushSub:noop,shareFirstUseDeadline:()=>0,shareInactiveDeadline:()=>0,isActive:()=>true,listShares:()=>[],addShareCenterNotification:noop,logAudit:noop,readLogTail:()=>[],getState:()=>({meta:{}})});
  await svc.sendMail('x','y');
  assert.equal(svc.getLastEmail().ok,true);
  svc.clearRuntimeState();
  assert.equal(svc.getLastEmail(),null);
  assert.equal(svc.getLastWebhook(),null);
});
