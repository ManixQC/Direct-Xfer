'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { createPwaDeviceService } = require('../lib/server/pwa-device-service');
const { createWebauthnService } = require('../lib/server/webauthn-service');
const { createPwaPhotoService } = require('../lib/server/pwa-photo-service');
const { createPwaEventService } = require('../lib/server/pwa-event-service');

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req && req.headers && req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function deviceFixture() {
  let state = { meta: {}, shares: [] };
  const accounts = [
    { id:'acc-owner', username:'owner', role:'owner' },
    { id:'acc-operator', username:'operator', role:'operator' },
  ];
  let persisted = 0;
  const eventSubs = new Map();
  const service = createPwaDeviceService({
    PUBLIC_URL:'https://dx.example.test', rootDir:ROOT, crypto, path,
    getState:() => state,
    getAccountById:(id) => accounts.find((a) => a.id === id) || null,
    findAccountByName:(name) => accounts.find((a) => a.username === name) || null,
    scheduleFlush:() => {}, persistNow:() => { persisted += 1; return true; },
    timingSafeEqualStr, parseCookies, secureCookie:() => '', getSession:() => null,
    adminGuard:(_req, _res, next) => next(), externalProto:() => 'https',
    accountNeedsPwChange:() => false, auditReq:() => {}, logAudit:() => {}, clientIp:() => '127.0.0.1',
    destroySession:() => {}, addCenterNotification:() => {}, pubIp:(ip) => ip,
    getInboxEventSubs:() => eventSubs,
  });
  return { service, accounts, eventSubs, get state(){ return state; }, set state(v){ state=v; }, get persisted(){ return persisted; } };
}

test('PWA domains are composed by the dedicated PWA application bootstrap without server forwarding wrappers', () => {
  const server = read('server.js');
  const application = read('lib/server/pwa-application.js');
  for (const rel of ['pwa-device-service.js','pwa-photo-service.js','webauthn-service.js','pwa-event-service.js','pwa-composition-service.js','pwa-application.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'server', rel)), rel);
  }
  assert.match(server, /const pwaServices = createPwaServiceRegistry\(\)/);
  assert.match(server, /createPwaApplication\(\{/);
  assert.doesNotMatch(server, /createPwaDeviceService\(|createPwaPhotoService\(|createWebauthnService\(|createPwaEventService\(/);
  assert.match(application, /createPwaDeviceService\(/);
  assert.match(application, /createPwaPhotoService\(/);
  assert.match(application, /createWebauthnService\(/);
  assert.match(application, /createPwaEventService\(/);
  for (const name of ['device','photo','webauthn','event']) {
    assert.match(application, new RegExp(`registry\\.bind\\('${name}'`));
  }
  assert.doesNotMatch(server, /function \w+\(\.\.\.args\) \{ return (?:pwaDeviceService|pwaPhotoService|pwaEventService|webauthnService)\./);
});


test('PWA device service keeps ownership durable across root-state replacement', () => {
  const fx = deviceFixture();
  const issued = fx.service.createPwaDevice('Phone', 'owner');
  assert.ok(issued && issued.device && issued.secret);
  assert.equal(fx.service.pwaDeviceOwnerAccount(issued.device.id).id, 'acc-owner');
  assert.equal(fx.service.validatePwaDeviceCredential(`${issued.device.id}.${issued.secret}`, false).id, issued.device.id);

  const copied = JSON.parse(JSON.stringify(fx.state));
  fx.state = copied;
  assert.equal(fx.service.pwaDevices().length, 1);
  assert.equal(fx.service.pwaDeviceOwnerAccount(issued.device.id).id, 'acc-owner');
});

test('PWA device capability cleanup closes only matching event scopes', () => {
  const fx = deviceFixture();
  const a = { ended:0, end(){ this.ended += 1; } };
  const b = { ended:0, end(){ this.ended += 1; } };
  fx.eventSubs.set('dev:deadbeefdeadbeefdeadbeef', new Set([a]));
  fx.eventSubs.set('acc:other', new Set([b]));
  fx.service.cleanupPwaCapabilityScopes(['deadbeefdeadbeefdeadbeef']);
  assert.equal(a.ended, 1);
  assert.equal(b.ended, 0);
  assert.equal(fx.eventSubs.has('dev:deadbeefdeadbeefdeadbeef'), false);
});

test('WebAuthn service owns challenges and passkey/device bindings', () => {
  const devices = [{ id:'a'.repeat(24), name:'Pixel', createdAt:1, lastUsedAt:2 }];
  const service = createWebauthnService({
    APP_NAME:'Direct-Xfer', PUBLIC_URL:'https://dx.example.test', crypto,
    getSession:() => null, getAccountById:() => null, pwaDevices:() => devices, timingSafeEqualStr,
  });
  service.webauthnLoginChallenges.set('x', { at:Date.now(), challenge:'abc' });
  assert.equal(service.webauthnLoginChallenges.size, 1);
  service.clearRuntimeState();
  assert.equal(service.webauthnLoginChallenges.size, 0);

  const passkey = { id:'cred', deviceIds:[] };
  assert.equal(service.bindPasskeyToDevice(passkey, devices[0].id), true);
  assert.equal(service.passkeyBoundToDevice(passkey, devices[0].id), true);
  assert.equal(service.publicPasskey(passkey, devices[0].id).devices[0].name, 'Pixel');
  assert.equal(service.unbindPasskeyDevice(passkey, devices[0].id), true);
});

test('PWA photo service centralizes image ownership, albums and retention policy', async () => {
  let state = { meta:{}, shares:[] };
  const accounts = [{ id:'acc-owner', username:'owner', role:'owner' }];
  const device = { id:'b'.repeat(24), createdByAccountId:'acc-owner', createdBy:'owner' };
  const service = createPwaPhotoService({
    getState:() => state, scheduleFlush:() => {},
    pwaDeviceCreatorAccount:(d) => d && accounts.find((a) => a.id === d.createdByAccountId) || null,
    pwaDeviceOwnerAccount:() => accounts[0], pwaDevices:() => [device],
    stampPwaRecordOwner:(req, share) => { share.ownerId = req.pwaDevice.createdByAccountId; share.ownerDeviceId=req.pwaDevice.id; return share; },
    normUsername:(v) => String(v || '').toLowerCase(),
    pwaPhotoPayload:(_req, rec) => ({ token:rec.token }), getByToken:(tok) => state.shares.find((s) => s.token === tok) || null,
    parseExpiry:() => null, makeSharePassword:async () => ({}), parseHotlinkHosts:() => [], normalizeTags:() => [],
    getSettings:() => ({ imageBase:'https://img.example.test' }), primaryBase:() => 'https://dx.example.test', isActive:() => true,
    listShares:() => state.shares, photoStatsOf:() => ({ full:{v:0}, thumb:{v:0}, micro:{v:0} }), DAY_MS:86400000,
    photoLastPublicViewAt:(p) => p.createdAt || 0, photoManagedBytes:() => 10,
    destroyShareManagedData:async () => {}, detachActiveShare:(p) => { state.shares = state.shares.filter((x) => x !== p); return true; },
    logAudit:() => {}, persistNow:() => true, scheduleSearchReindex:() => {}, dlpEffectiveAction:() => 'log',
    pwaImagesForRequest:() => [],
  });
  const photo = { id:'p1', token:'tok', type:'photo', ownerId:'acc-owner', ownerDeviceId:device.id, name:'x.jpg', createdAt:1 };
  const album = { id:'a1', token:'album', type:'album', ownerId:'acc-owner', ownerDeviceId:device.id, name:'A', members:['tok'], collaborators:[] };
  state.shares.push(photo, album);
  const req = { pwaDevice:device, pwaSession:null };
  assert.equal(service.canManagePwaImage(req, photo), true);
  assert.equal(service.canManagePwaAlbum(req, album), true);
  assert.equal(service.pwaAlbumPayload(req, album).count, 1);
  assert.deepEqual(service.normalizePwaRetentionRules({ enabled:true, maxAgeDays:99999 }).maxAgeDays, 3650);
  assert.equal(service.primaryPwaOwnerKey(req), 'acc:acc-owner');
});

test('PWA event service owns SSE fanout and deduplicates multi-scope responses', () => {
  const account = { id:'acc-owner', username:'owner', role:'owner' };
  const device = { id:'c'.repeat(24), createdByAccountId:account.id };
  const pushes = [];
  const service = createPwaEventService({
    APP_NAME:'Direct-Xfer', fs, path, INBOX_DIR:ROOT, resolveWithin:(_root, rel) => path.join(ROOT, rel || ''),
    getAccountById:(id) => id === account.id ? account : null, findAccountByName:() => account, scheduleFlush:() => {},
    pwaDeviceCreatorAccount:() => account, pwaDeviceOwnerAccount:() => account, pwaDeviceResolvedAccount:() => account,
    pwaDevices:() => [device], presenceSessionValidator:() => () => true, logAudit:() => {}, clientIp:() => '127.0.0.1',
    sendPwaPush:(keys, evt) => { pushes.push({keys,evt}); return keys.length; },
    getById:() => null, trashItems:() => [], pwaViewerIsAdmin:() => true, canManagePwaImage:() => true,
    getActiveTransfers:() => new Map(), listTransfers:() => [],
  });
  const share = { ownerId:account.id, ownerDeviceId:device.id };
  const writes = [];
  const res = { writableEnded:false, dxPwaEventKeys:[`dev:${device.id}`,`acc:${account.id}`], dxPwaEventValidate:() => true, write:(v) => writes.push(v), end(){ this.writableEnded=true; } };
  service.inboxEventSubs.set(`dev:${device.id}`, new Set([res]));
  service.inboxEventSubs.set(`acc:${account.id}`, new Set([res]));
  service.emitPwaOwnerEvent(share, { type:'x' }, false);
  assert.equal(writes.length, 1);
  assert.equal(service.closePwaEventStreamsForKeys([`acc:${account.id}`]), 1);
  assert.equal(res.writableEnded, true);
});
