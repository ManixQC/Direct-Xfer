'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSharePresentationService,
  externalProto,
  hostIsIpLiteral,
  normalizeLinkBase,
} = require('../lib/server/share-presentation-service');

const ROOT = path.resolve(__dirname, '..');

function request(host = 'files.example.test:8443', protocol = 'https') {
  return {
    protocol,
    get(name) { return String(name).toLowerCase() === 'host' ? host : ''; },
  };
}

function fixture(config = {}) {
  let settings = { linkBase:'', imageBase:'' };
  let state = { meta:{ pending:[] } };
  let publicIp = '203.0.113.20';
  let localAddresses = [{ address:'192.168.1.20' }];
  const logicalBytesCache = new Map();
  const shareService = {
    isActive:(share) => !share.disabled && !share.revoked,
    isScheduled:(share) => !!share.startsAt,
    shareItems:(share) => Array.isArray(share.items) ? share.items : null,
    linkPrefix:(share) => share.type === 'inbox' ? '/u/' : share.type === 'photo' ? '/i/' : '/s/',
    shareEffectiveExpiry:() => 9000,
    shareStatsBaseline:() => ({ downloads:2, visitors:1, views:3 }),
    parseMaxVisitors:(value) => Math.max(0, Number(value) || 0),
    shareLogicalBytes:() => 2048,
    shareNeedsLogicalBytesScan:() => false,
    shareLogicalBytesCache:logicalBytesCache,
    shareBackingHealthSnapshot:() => ({ status:'ok', checkedAt:10 }),
    shareLogicalFileCount:() => 2,
    shareActivityAt:() => 8000,
    shareLastUseAt:() => 7000,
    shareInactiveDeadline:() => 12000,
    shareFirstUseDeadline:() => 11000,
    displayStatsForShare:() => ({ count:9, bytes:4096 }),
  };
  const photoService = {
    photoStatsOf:() => ({
      full:{ v:10, u:['a','b'] },
      thumb:{ v:6, u:['a'] },
      micro:{ v:2, u:[] },
    }),
    photoCacheRevision:() => 7,
  };
  const pwaDeviceService = {
    photoUploadDeviceName:() => 'Pixel',
    shareCreatorDeviceName:() => 'Tablet',
  };
  const service = createSharePresentationService({
    config:{ PUBLIC_URL:'', PUBLIC_HOST:'', PORT:55750, TRUST_PROXY:1, ...config },
    getSettings:() => settings,
    getState:() => state,
    getPublicIPCached:() => publicIp,
    getLocalIPv4s:() => localAddresses,
    getShareService:() => shareService,
    getPhotoService:() => photoService,
    getPwaDeviceService:() => pwaDeviceService,
    pubIp:(ip) => ip ? `public:${ip}` : ip,
  });
  return {
    service,
    setSettings(value) { settings = value; },
    setState(value) { state = value; },
    setPublicIp(value) { publicIp = value; },
    setLocalAddresses(value) { localAddresses = value; },
  };
}

test('URL helpers preserve normalization and reject proxy IP literals', () => {
  assert.equal(externalProto({ protocol:'https' }), 'https');
  assert.equal(externalProto({ protocol:'http' }), 'http');
  assert.equal(normalizeLinkBase(' example.test/// '), 'https://example.test');
  assert.equal(normalizeLinkBase('example.test:8080'), 'http://example.test:8080');
  assert.equal(normalizeLinkBase('https://example.test/a/b'), 'https://example.test');
  assert.equal(normalizeLinkBase(''), '');
  assert.equal(normalizeLinkBase('http://['), null);
  assert.equal(hostIsIpLiteral('192.168.1.10:55750'), true);
  assert.equal(hostIsIpLiteral('[2001:db8::1]:443'), true);
  assert.equal(hostIsIpLiteral('files.example.test:443'), false);
});

test('primaryBase keeps the configured, proxy, public and local precedence', () => {
  const f = fixture();
  assert.equal(f.service.primaryBase(request()), 'https://files.example.test:8443');
  f.setSettings({ linkBase:'https://configured.example.test', imageBase:'' });
  assert.equal(f.service.primaryBase(request()), 'https://configured.example.test');

  f.setSettings({ linkBase:'', imageBase:'' });
  assert.equal(f.service.primaryBase(request('192.168.1.9:55750', 'http')), 'http://203.0.113.20:55750');
  f.setPublicIp(null);
  assert.equal(f.service.primaryBase(request('192.168.1.9:55750', 'http')), 'http://192.168.1.20:55750');
  f.setLocalAddresses([]);
  assert.equal(f.service.primaryBase(request('192.168.1.9:55750', 'http')), '');

  const advertised = fixture({ PUBLIC_URL:'https://public.example.test' });
  advertised.setSettings({ linkBase:'', imageBase:'' });
  assert.equal(advertised.service.primaryBase(request()), 'https://public.example.test');
});

test('externalTarget honors an explicit base and safe trusted proxy domains', () => {
  const f = fixture();
  assert.deepEqual(f.service.externalTarget(request(), 'https://override.example.test:9443/path'), {
    host:'override.example.test', port:9443, label:'https://override.example.test:9443',
  });
  assert.deepEqual(f.service.externalTarget(request()), {
    host:'files.example.test', port:8443, label:'https://files.example.test:8443',
  });
  assert.equal(f.service.externalTarget(request('192.168.1.9:55750', 'http')), null);
});

test('decorateShare preserves the complete photo projection contract', () => {
  const f = fixture();
  f.setSettings({ linkBase:'', imageBase:'https://images.example.test' });
  f.setState({ meta:{ pending:[{ shareId:'photo-1', id:'pending-1', name:'review.jpg', size:42, ip:'1.2.3.4', at:5 }] } });
  const share = {
    id:'photo-1', token:'photo-token', type:'photo', name:'holiday.jpeg', size:123,
    createdAt:1000, startsAt:2000, expiresAt:3000, downloads:5,
    visitors:['one','two'], views:8, favorite:true, thumb:'thumb', micro:'micro',
    w:1920, h:1080, metadataRemoved:true, versions:[{}], editHistory:[{},{}],
    lastDownload:{ ip:'10.0.0.1', at:6000 }, lastUpload:{ ip:'10.0.0.2', at:6500 },
    recipients:[{ token:'recipient-token', name:'Alice', viewedAt:4000, lastViewIp:'10.0.0.3', stats:{ completed:2, lastAt:5000 } }],
    items:[{ name:'holiday.jpeg', size:123, type:'file', private:'not-projected' }],
    rateBps:2048, pwHash:'hash', pwHint:'hint', tags:['summer'], ownerId:'owner-1', ownerName:'Owner',
  };
  const projected = f.service.decorateShare(share, request());
  assert.equal(projected.url, 'https://files.example.test:8443/i/photo-token');
  assert.equal(projected.downloadsUsed, 5);
  assert.equal(projected.downloads, 3);
  assert.equal(projected.uniqueVisitors, 1);
  assert.equal(projected.views, 5);
  assert.equal(projected.logicalBytes, 2048);
  assert.equal(projected.logicalBytesReady, true);
  assert.deepEqual(projected.backing, { status:'ok', checkedAt:10 });
  assert.equal(projected.lastDownload.ip, 'public:10.0.0.1');
  assert.equal(projected.photo.ext, 'jpg');
  assert.equal(projected.photo.imgUrl, 'https://images.example.test/i/photo-token.jpg?v=7');
  assert.equal(projected.photo.thumbUrl, 'https://images.example.test/i/photo-token/thumb?v=7');
  assert.equal(projected.photo.uploadDeviceName, 'Pixel');
  assert.equal(projected.photo.fullVisitors, 2);
  assert.deepEqual(projected.pending, [{ id:'pending-1', name:'review.jpg', size:42, ip:'1.2.3.4', at:5 }]);
  assert.equal(projected.recipients[0].url, 'https://files.example.test:8443/s/recipient-token');
  assert.equal(projected.recipients[0].lastViewIp, 'public:10.0.0.3');
  assert.deepEqual(projected.items, [{ name:'holiday.jpeg', size:123, type:'file' }]);
  assert.deepEqual(projected.stats, { count:9, bytes:4096 });
});

test('decorateShare reads replaced state and current settings after construction', () => {
  const f = fixture();
  const share = { id:'inbox-1', token:'upload-token', type:'inbox', name:'Inbox', encrypted:true };
  f.setState({ meta:{ pending:[{ shareId:'inbox-1', id:'old', name:'old.txt' }] } });
  assert.equal(f.service.decorateShare(share, request()).pending[0].id, 'old');

  f.setState({ meta:{ pending:[{ shareId:'inbox-1', id:'new', name:'new.txt' }] } });
  f.setSettings({ linkBase:'https://restored.example.test', imageBase:'' });
  const projected = f.service.decorateShare(share, request());
  assert.equal(projected.pending[0].id, 'new');
  assert.equal(projected.url, 'https://restored.example.test/u/upload-token');
  assert.equal(projected.inbox.deviceName, 'Tablet');
  assert.equal(projected.inbox.encMode, 'key');
});

test('server.js composes presentation without retaining its implementation', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const core = fs.readFileSync(path.join(ROOT, 'lib/server/core-state-application.js'), 'utf8');
  assert.match(server, /createCoreStateApplication\(\{/);
  assert.match(core, /createSharePresentationService\(\{/);
  assert.match(core, /getState,/);
  const bridges = fs.readFileSync(path.join(ROOT, 'lib/server/core-state-bridges.js'), 'utf8');
  assert.match(server, /bridges:coreStateBridges/);
  assert.match(bridges, /function getShareService\(\)/);
  assert.match(bridges, /currentService\('share', 'share service'\)/);
  assert.doesNotMatch(server, /^function decorateShare\(/m);
  assert.doesNotMatch(server, /^function primaryBase\(/m);
  assert.doesNotMatch(server, /^function externalTarget\(/m);
  assert.doesNotMatch(server, /^function normalizeLinkBase\(/m);
  assert.ok(server.split('\n').length < 4300, 'presentation extraction should materially reduce server.js');
});
