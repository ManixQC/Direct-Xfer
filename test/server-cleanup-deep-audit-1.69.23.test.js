'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createNetworkServices } = require('../lib/server/network-services');
const { createPhotoService } = require('../lib/server/photo-service');
const { createPublicAccessService } = require('../lib/server/public-access-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('server composition root no longer carries helpers now owned by services', () => {
  const server = read('server.js');
  const shareMediaTransfer = read('lib/server/share-media-transfer-application.js');
  const publicHttp = read('lib/server/public-http-application.js');
  const registrar = read('lib/server/register-application-domains.js');
  for (const name of [
    'geoSync', 'dataWritable', 'recordRecipientView', 'canSeePhotoHistory',
    'visiblePhotoHistory', 'photoHistoryMeta', 'sendPasswordWorkError',
  ]) {
    assert.doesNotMatch(server, new RegExp(`function\\s+${name}\\s*\\(`), name);
  }
  assert.match(read('lib/server/request-utils.js'), /const out = Object\.create\(null\);/, 'cookie parser should not expose Object.prototype magic keys');
  const publication = read('lib/server/application-publication.js');
  assert.match(server, /publishApplicationGraph\(\{/);
  assert.match(publication, /createApplicationDomainEntries\(direct\)/);
  assert.match(registrar, /\['network', requiredValue\(services, 'networkServices', 'services'\)\]/);
  assert.match(shareMediaTransfer, /\['photo', photoService\]/);
  assert.match(publication, /publicHttpApplication/);
  assert.match(publicHttp, /\['public-access', publicAccessService\]/);
  assert.ok(server.split('\n').length < 1900, `server.js should remain a compact composition root (${server.split('\n').length} lines)`);
});

test('PWA password-work errors come from public-access instead of an obsolete admin adapter', () => {
  const pwa = read('lib/server/pwa-application.js');
  const server = read('server.js');
  const adminApplication = read('lib/server/admin-application.js');
  assert.match(pwa, /sendPasswordWorkError:\['public-access', 'sendPasswordWorkError'\]/);
  assert.doesNotMatch(pwa, /sendPasswordWorkError:\['admin-adapters'/);
  const adapterBlock = adminApplication.match(/context\.register\('admin-adapters', \{([\s\S]*?)\n  \}\);/);
  assert.ok(adapterBlock);
  assert.doesNotMatch(adapterBlock[1], /sendPasswordWorkError/);
});

test('network service owns synchronous cached geolocation projection', () => {
  const state = {};
  const service = createNetworkServices({
    net:{}, os:{}, LOCAL_IP:'', APP_VERSION:'1.0.0', UPDATE_REPO:'x/y', UPDATE_TAG:'latest',
    compareSemver:() => 0, updateCheckEnabled:() => false, publicIpDiscoveryEnabled:() => false,
    addAdminCenterNotification:() => {}, getState:() => state, persist:() => {},
    maskToPrefix:() => 24, ipToInt:() => 0, intToIp:() => '0.0.0.0',
    isPrivateIp:(ip) => /^10\./.test(String(ip)), getSettings:() => ({ geoLookup:true }),
    flagFromCode:() => '🌐', noteCenterServiceState:() => {},
  });
  assert.deepEqual(service.geoSync('10.1.2.3'), { country:'Local network', countryCode:null, flag:'🏠' });
  const cached = { country:'Example', countryCode:'EX', flag:'🌐', at:Date.now() };
  service.geoCache.set('203.0.113.9', cached);
  assert.equal(service.geoSync('::ffff:203.0.113.9'), cached);
  service.geoCache.set('203.0.113.10', { ...cached, at:Date.now() - service.GEO_TTL - 1 });
  assert.equal(service.geoSync('203.0.113.10'), null);
});

test('photo history visibility fails closed without a session and respects operator ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-photo-history-audit-'));
  try {
    const state = { photoHistory:[
      { id:'own', ownerId:'a', revokedAt:123 },
      { id:'other', ownerId:'b', revokedAt:456 },
      null,
    ] };
    const deps = {
      HOST_ROOT:root, IMAGE_STORE_DIR:root, FULL_IMAGES_DIR:root, THUMBS_DIR:root, MICROS_DIR:root,
      PHOTO_HISTORY_DIR:root, PHOTO_VERSIONS_DIR:root, ADAPTIVE_IMAGES_DIR:root,
      LEGACY_IMAGES_DIR:root, LEGACY_THUMBS_DIR:root, LEGACY_MICROS_DIR:root, LEGACY_PHOTO_HISTORY_DIR:root,
      PHOTO_HISTORY_MAX:50, getState:() => state, listShares:() => [], trashItems:() => [],
      hostToContainer:(v) => v, assertRealWithin:async (_r,v) => v,
    };
    const service = createPhotoService(deps);
    assert.equal(service.canSeePhotoHistory({}, state.photoHistory[0]), false);
    assert.deepEqual(service.visiblePhotoHistory({ session:{ role:'operator', accountId:'a' } }).map((r) => r.id), ['own']);
    assert.deepEqual(service.visiblePhotoHistory({ session:{ role:'admin', accountId:'a' } }).map((r) => r.id), ['own','other']);
    assert.deepEqual(service.photoHistoryMeta({ session:{ role:'operator', accountId:'a' } }), { count:1, latestId:'own', latestAt:123 });
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

function publicAccessFixture(maxPasswordChars = 64) {
  return createPublicAccessService({
    crypto,
    clientIp:() => '127.0.0.1',
    geoSync:() => null,
    geolocate:async() => null,
    hashPassword:async() => ({ ok:true, hash:'x' }),
    parseHash:() => ({ scheme:'x' }),
    verifyPassword:async() => ({ ok:true }),
    parseCookies:() => Object.create(null),
    secureCookie:() => '',
    timingSafeEqualStr:(a,b) => a === b,
    linkPrefix:() => '/s/',
    isLoopback:() => true,
    isPrivateIp:() => true,
    parseIpList:() => [],
    ipInList:() => false,
    errorPage:() => '',
    pickLang:() => 'en',
    maxPasswordChars,
  });
}

test('public-access owns the JSON password-work error contract', () => {
  const service = publicAccessFixture(37);
  const headers = {};
  const res = {
    code:0, body:null,
    setHeader(k,v) { headers[k] = v; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return body; },
  };
  service.sendPasswordWorkError(res, 'password-too-long');
  assert.equal(res.code, 400);
  assert.deepEqual(res.body, { error:'password-too-long', maxChars:37 });
  service.sendPasswordWorkError(res, 'auth-busy');
  assert.equal(res.code, 503);
  assert.equal(headers['Retry-After'], '1');
  assert.equal(res.body.error, 'auth-busy');
});
