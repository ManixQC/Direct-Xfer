'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createSharePresentationService,
  normalizeLinkBase,
} = require('../lib/server/share-presentation-service');

function req(host = 'files.example.test:8443', protocol = 'https') {
  return { protocol, get(name) { return String(name).toLowerCase() === 'host' ? host : ''; } };
}

function shareDomain() {
  return {
    shareLogicalBytesCache:new Map(),
    isActive:() => true,
    isScheduled:() => false,
    shareItems:() => null,
    linkPrefix:(share) => share.type === 'inbox' ? '/u/' : share.type === 'photo' ? '/i/' : share.type === 'album' ? '/g/' : '/s/',
    shareEffectiveExpiry:() => null,
    shareStatsBaseline:() => ({ downloads:0, visitors:0, views:0 }),
    parseMaxVisitors:() => 0,
    shareLogicalBytes:() => 0,
    shareNeedsLogicalBytesScan:() => false,
    shareBackingHealthSnapshot:() => ({ status:'na', checkedAt:0 }),
    shareLogicalFileCount:() => null,
    shareActivityAt:() => 0,
    shareLastUseAt:() => 0,
    shareInactiveDeadline:() => null,
    shareFirstUseDeadline:() => null,
    displayStatsForShare:() => null,
  };
}

function makeService(overrides = {}) {
  let settingsCalls = 0;
  const options = {
    config:{ PUBLIC_URL:'', PUBLIC_HOST:'', PORT:55750, TRUST_PROXY:1 },
    getSettings:() => { settingsCalls += 1; return { linkBase:'', imageBase:'' }; },
    getState:() => ({ meta:{ pending:[] } }),
    getPublicIPCached:() => '203.0.113.10',
    getLocalIPv4s:() => [{ address:'192.168.1.10' }],
    getShareService:() => shareDomain(),
    getPhotoService:() => null,
    getPwaDeviceService:() => null,
    pubIp:(ip) => ip,
    ...overrides,
  };
  const service = createSharePresentationService(options);
  return { service, settingsCalls:() => settingsCalls };
}

test('URL normalization rejects explicit non-HTTP schemes and embedded controls', () => {
  assert.equal(normalizeLinkBase('ftp://files.example.test'), null);
  assert.equal(normalizeLinkBase('file://files.example.test'), null);
  assert.equal(normalizeLinkBase('mailto:user@example.test'), null);
  assert.equal(normalizeLinkBase('javascript:alert(1)'), null);
  assert.equal(normalizeLinkBase('https://user:secret@files.example.test'), null);
  assert.equal(normalizeLinkBase('https://files.example.test\n.evil.test'), null);
  assert.equal(normalizeLinkBase('https://files.example.test/path?q=1'), 'https://files.example.test');
});

test('trusted proxy origin validation is shared by primaryBase and externalTarget', () => {
  const { service } = makeService();
  const malformed = req('files.example.test/path', 'https');
  assert.equal(service.primaryBase(malformed), 'http://203.0.113.10:55750');
  assert.equal(service.externalTarget(malformed), null);
  assert.equal(service.primaryBase(null), 'http://203.0.113.10:55750');
  for (const disguisedIp of ['127.1:55750', '0x7f000001:55750', '2130706433:55750']) {
    const disguised = req(disguisedIp, 'http');
    assert.equal(service.primaryBase(disguised), 'http://203.0.113.10:55750');
    assert.equal(service.externalTarget(disguised), null);
  }
});

test('invalid explicit diagnostic base never falls through to a different target', () => {
  const { service } = makeService({
    config:{ PUBLIC_URL:'https://public.example.test', PUBLIC_HOST:'', PORT:55750, TRUST_PROXY:1 },
  });
  assert.equal(service.externalTarget(req(), 'ftp://wrong.example.test'), null);
  assert.deepEqual(service.externalTarget(req()), {
    host:'public.example.test', port:443, label:'https://public.example.test',
  });
});

test('corrupt restored linkBase is ignored in favor of the next safe primary base', () => {
  const { service } = makeService({
    config:{ PUBLIC_URL:'https://public.example.test/base', PUBLIC_HOST:'', PORT:55750, TRUST_PROXY:1 },
    getSettings:() => ({ linkBase:'ftp://broken.example.test', imageBase:'' }),
  });
  assert.equal(service.primaryBase(req()), 'https://public.example.test/base');
});

test('ordinary share projection does not depend on photo or PWA device services', () => {
  const { service } = makeService({ getState:() => null });
  const projected = service.decorateShare({ id:'file-1', token:'tok', type:'file', name:'a.txt' }, req(), {
    base:'https://files.example.test', pendingByShareId:{ broken:true },
  });
  assert.equal(projected.url, 'https://files.example.test/s/tok');
  assert.equal(projected.photo, null);
  assert.equal(projected.inbox, undefined);
  assert.deepEqual(projected.pending, []);
});

test('type-specific presentation dependencies remain lazy and fail only when needed', () => {
  const { service } = makeService();
  assert.throws(
    () => service.decorateShare({ id:'photo-1', token:'p', type:'photo', name:'p.jpg' }, req()),
    /photo-service is not available/
  );
  assert.throws(
    () => service.decorateShare({ id:'inbox-1', token:'u', type:'inbox', name:'Inbox' }, req()),
    /pwa-device-service is not available/
  );
});

test('one share projection uses one coherent settings snapshot', () => {
  let calls = 0;
  const { service } = makeService({
    getSettings:() => {
      calls += 1;
      return { linkBase:'https://main.example.test', imageBase:'https://img.example.test' };
    },
    getPhotoService:() => ({
      photoStatsOf:() => ({ full:{v:0,u:[]}, thumb:{v:0,u:[]}, micro:{v:0,u:[]} }),
      photoCacheRevision:() => 1,
    }),
    getPwaDeviceService:() => ({ photoUploadDeviceName:() => null, shareCreatorDeviceName:() => null }),
  });
  const projected = service.decorateShare({ id:'photo-1', token:'p', type:'photo', name:'p.jpg' }, req());
  assert.equal(calls, 1);
  assert.equal(projected.url, 'https://main.example.test/i/p');
  assert.equal(projected.photo.imgUrl, 'https://img.example.test/i/p.jpg?v=1');
});



test('corrupt image base and sparse nested rows cannot poison the complete share projection', () => {
  const domain = shareDomain();
  domain.shareItems = () => [null, { name:'ok.txt', size:5, type:'file' }];
  const { service } = makeService({
    getSettings:() => ({ linkBase:'https://files.example.test', imageBase:'javascript:alert(1)' }),
    getState:() => ({ meta:{ pending:[] } }),
    getShareService:() => domain,
    getPhotoService:() => ({
      photoStatsOf:() => ({ full:{v:0,u:[]}, thumb:{v:0,u:[]}, micro:{v:0,u:[]} }),
      photoCacheRevision:() => 1,
    }),
    getPwaDeviceService:() => ({ photoUploadDeviceName:() => null, shareCreatorDeviceName:() => null }),
  });
  const projected = service.decorateShare({
    id:'photo-sparse', token:'p', type:'photo', name:'p.jpg',
    recipients:[null, { token:'r1', name:'Recipient' }],
  }, req(), { pendingByShareId:new Map([['photo-sparse', [null, { id:'pending-1' }]]]) });
  assert.equal(projected.photo.imgUrl, 'https://files.example.test/i/p.jpg?v=1');
  assert.deepEqual(projected.items, [{ name:'ok.txt', size:5, type:'file' }]);
  assert.equal(projected.recipients.length, 1);
  assert.deepEqual(projected.pending, [{ id:'pending-1', name:undefined, size:undefined, ip:undefined, at:undefined }]);
});

test('port-check rejects a malformed explicit base instead of probing the fallback public IP', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib/server/admin-diagnostics-routes.js'), 'utf8');
  const start = source.indexOf("adminRouter.post('/network/port-check'");
  const end = source.indexOf("adminRouter.get('/network/proxy-check'", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /const requestedBase = .*req\.body\.base.*\.trim\(\)/s);
  assert.match(route, /if \(requestedBase && !target\)/);
  assert.match(route, /status\(400\)\.json\(\{ open:null, error:'invalid-target'/);
});
