'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const { createPublicShareRoutes } = require('../lib/server/public-share-routes');

function fakeExpress() {
  const rows = [];
  const router = {
    use(...args) { rows.push({ method:'use', args }); },
    get(...args) { rows.push({ method:'get', args }); },
    post(...args) { rows.push({ method:'post', args }); },
  };
  const parser = () => (req, res, next) => { if (next) next(); };
  return { express:{ Router:() => router, json:parser, urlencoded:parser }, router, rows };
}
function proxyDeps(extra = {}) {
  const noop = () => {};
  return new Proxy(extra, { get(target, prop) { return prop in target ? target[prop] : noop; } });
}
function makeResponse() {
  const listeners = {};
  return {
    statusCode:200, headers:{}, body:null, ended:false,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
    send(v) { this.body = v; this.ended = true; this.emit('finish'); return this; },
    json(v) { this.body = v; this.ended = true; this.emit('finish'); return this; },
    redirect(code, v) { this.statusCode = code; this.body = v; this.ended = true; this.emit('finish'); return this; },
    end(v) { this.body = v; this.ended = true; this.emit('finish'); return this; },
    once(name, fn) { (listeners[name] ||= []).push(fn); return this; },
    emit(name) { const arr = listeners[name] || []; delete listeners[name]; for (const fn of arr) fn(); },
  };
}
function findRoute(rows, method, signature) {
  return rows.find((row) => row.method === method && (
    row.args[0] === signature || (Array.isArray(row.args[0]) && row.args[0].includes(signature))
  ));
}
function baseDeps(extra = {}) {
  return proxyDeps({
    express: fakeExpress().express,
    PUB:{ en:{ quotaReached:'quota', accessDenied:'denied', tooManyReq:'rate' } },
    pickLang:() => 'en',
    errorPage:(_lang, _code, text) => String(text),
    accessRequestPage:() => 'access-request',
    getSettings:() => ({}),
    getByToken:() => null,
    getState:() => ({ meta:{} }),
    sendError:(_req, res, code, key) => res.status(code).send(key),
    hasAccessRules:() => false,
    linkAccessReason:async() => null,
    clientIp:() => '203.0.113.1',
    ipDownloadQuotaBlocked:() => false,
    bandwidthCapReached:() => false,
    isAccessApproved:() => true,
    isActive:() => true,
    isUnlocked:() => true,
    pendingAccessRequest:() => null,
    recordAndCheckVisitor:() => true,
    shareItems:() => [],
    recipientByToken:new Map(),
    beginUnlockAttempt:() => ({ ok:true, reason:null, ip:'203.0.113.1', record:{ fails:[], lockUntil:0 } }),
    finishUnlockAttempt:() => {},
    noteUnlockFailure:() => ({ failedCount:1, locked:false, at:Date.now() }),
    noteUnlockSuccess:() => ({ previousFailures:0 }),
    upgradeLegacySharePassword:async() => false,
    ...extra,
  });
}

function create(extra = {}) {
  const { express, rows } = fakeExpress();
  const deps = baseDeps({ express, ...extra });
  return { out:createPublicShareRoutes(deps), rows, deps };
}

test('refactor exports every helper still consumed by server.js', () => {
  const { out } = create();
  assert.equal(typeof out.selParser, 'function');
  assert.equal(typeof out.sendSha256Manifest, 'function');
  assert.equal(out.RENDER_MAX_BYTES, 2 * 1024 * 1024);
  const server = read('server.js');
  const adminApplication = read('lib/server/admin-application.js');
  const publicHttp = read('lib/server/public-http-application.js');
  const publication = read('lib/server/application-publication.js');
  assert.match(server, /publishApplicationGraph\(\{/);
  assert.match(publication, /publicHttpApplication/);
  assert.match(publicHttp, /\['public-share', publicShareRoutes\]/);
  assert.match(publication, /attachReceptionCollaborationRoutes\(receptionFacade\)/);
  assert.match(adminApplication, /diagnostics:context\.route\('adminDiagnostics', ROUTE_DOMAINS\.diagnostics/);
  assert.match(adminApplication, /attachAdminDiagnosticsRoutes\(lateRouteDeps\.diagnostics\)/);
  const { ROUTE_DEPENDENCIES } = require('../lib/server/application-context');
  assert.ok(ROUTE_DEPENDENCIES.receptionCollaboration.includes('selParser'));
  assert.ok(ROUTE_DEPENDENCIES.receptionCollaboration.includes('sendSha256Manifest'));
  assert.ok(ROUTE_DEPENDENCIES.adminDiagnostics.includes('RENDER_MAX_BYTES'));
});

test('geo/IP middleware also protects image and gallery routes, including cosmetic image extensions', async () => {
  const photo = { id:'p1', type:'photo', ipMode:'allow', ipList:['198.51.100.1'] };
  const seen = [];
  const { rows } = create({
    getByToken:(token) => { seen.push(token); return token === 'photoToken' ? photo : null; },
    hasAccessRules:() => true,
    linkAccessReason:async() => 'ip',
  });
  const geo = rows.filter((row) => row.method === 'use')[2].args[0];
  const req = { path:'/i/photoToken.jpg', method:'GET', headers:{} };
  const res = makeResponse();
  let next = false;
  await geo(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(seen, ['photoToken']);
});

test('request-access middleware covers reception links and the request endpoint exists for every public link kind', () => {
  const share = { id:'s1', type:'inbox', token:'tok', requestAccess:true };
  const { rows } = create({
    getByToken:(token) => token === 'tok' ? share : null,
    isAccessApproved:() => false,
    isUnlocked:() => true,
  });
  const accessGate = rows.filter((row) => row.method === 'use')[3].args[0];
  const req = { path:'/u/tok', method:'GET', headers:{} };
  const res = makeResponse();
  let next = false;
  accessGate(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, 'access-request');

  const route = findRoute(rows, 'post', '/u/:token/request-access');
  assert.ok(route);
  const signatures = route.args[0];
  for (const sig of ['/s/:token/request-access','/u/:token/request-access','/c/:token/request-access','/i/:token/request-access','/g/:token/request-access']) {
    assert.ok(signatures.includes(sig), sig);
  }
});

test('folder file downloads cannot bypass per-IP quota with preview query fallbacks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-folder-quota-'));
  try {
    const file = path.join(tmp, 'payload.bin');
    fs.writeFileSync(file, 'payload');
    let streamed = false;
    const { out } = create({
      resolveWithin:(root, sub) => path.join(root, sub),
      assertRealWithin:async(_root, candidate) => candidate,
      previewInfo:() => null,
      renderKind:() => null,
      ipDownloadQuotaBlocked:() => true,
      streamFile:() => { streamed = true; },
    });
    const req = { query:{ view:'1' }, originalUrl:'/s/t/file/payload.bin?view=1', method:'GET', headers:{} };
    const res = makeResponse();
    await out.serveFolderFile(req, res, { id:'s1', name:'share' }, tmp, 'payload.bin');
    assert.equal(res.statusCode, 429);
    assert.equal(streamed, false);
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('SHA-256 manifests are included in the public transfer rate limiter', () => {
  const { rows } = create({ publicRateRetryAfter:() => 9 });
  const rate = rows.filter((row) => row.method === 'use')[1].args[0];
  const req = { path:'/s/tok/sha256/sub', method:'GET', headers:{}, query:{} };
  const res = makeResponse();
  let next = false;
  rate(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 429);
  assert.equal(String(res.headers['retry-after']), '9');
});

test('album collaborator maxFiles is reserved before streaming to close concurrent upload race', () => {
  const invite = { id:'i1', role:'contributor', tokenHash:crypto.createHash('sha256').update('secret').digest('hex'), maxFiles:1, usedFiles:0 };
  const album = { id:'a1', token:'album', type:'album', collaborators:[invite], members:[] };
  const pending = [];
  const { rows } = create({
    getByToken:(token) => token === 'album' ? album : null,
    timingSafeEqualStr:(a,b) => a === b,
    PWA_IMG_EXT:/^(?:png|jpg|jpeg|webp)$/i,
    IMAGE_MAX_BYTES:1024 * 1024,
    FULL_IMAGES_DIR:os.tmpdir(),
    streamToFileBounded:(_req, _res, _dest, _max, done) => { pending.push(done); },
  });
  const upload = findRoute(rows, 'post', '/g/:token/c/:secret/upload').args.at(-1);
  const req = { params:{token:'album',secret:'secret'}, query:{name:'x.png'}, headers:{'content-type':'image/png'} };
  const r1 = makeResponse(), r2 = makeResponse();
  upload(req, r1);
  upload(req, r2);
  assert.equal(pending.length, 1);
  assert.equal(r2.statusCode, 409);
  assert.deepEqual(r2.body, { error:'file-limit' });
  // End the first request so the WeakMap reservation is released for later tests.
  r1.emit('close');
});

test('expired/disabled album invite cannot delete contributed images', async () => {
  const invite = { id:'i1', role:'manager', tokenHash:crypto.createHash('sha256').update('secret').digest('hex') };
  const album = { id:'a1', token:'album', type:'album', collaborators:[invite], members:['photo'] };
  let destroyed = false;
  const { rows } = create({
    getByToken:(token) => token === 'album' ? album : token === 'photo' ? { id:'p1', token:'photo', type:'photo', contributedViaAlbum:'album' } : null,
    timingSafeEqualStr:(a,b) => a === b,
    isActive:() => false,
    destroyShareManagedData:async() => { destroyed = true; },
  });
  const remove = findRoute(rows, 'post', '/g/:token/c/:secret/remove/:imageToken').args.at(-1);
  const res = makeResponse();
  await remove({ params:{token:'album',secret:'secret',imageToken:'photo'} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(destroyed, false);
});

test('invalid restored secret tokens are rejected before filesystem access', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-secret-safe-'));
  try {
    const victim = path.join(tmp, 'victim.dxe');
    fs.writeFileSync(victim, 'keep');
    const bad = '../victim';
    const { rows } = create({
      SECRETS_DIR:path.join(tmp, 'secrets'),
      getState:() => ({ meta:{ secrets:{ [bad]:{mode:'key'} } } }),
    });
    const blob = findRoute(rows, 'get', '/x/:token/blob').args.at(-1);
    const res = makeResponse();
    blob({ params:{token:bad} }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('access-request duplicate fingerprint includes email so distinct requests are not silently collapsed', () => {
  const share = { id:'s1', token:'tok', type:'file', requestAccess:true, accessRequests:[] };
  let fingerprint = null;
  const { rows } = create({
    getByToken:(token) => token === 'tok' ? share : null,
    isActive:() => true,
    isUnlocked:() => true,
    pendingAccessRequest:() => null,
    snapshotPublicMessageDecision:() => ({}),
    publicMessageDecision:(_req, _token, text) => { fingerprint = text; return { duplicate:false, retryAfter:0, notify:false }; },
    geoSync:() => ({}), geolocate:async() => ({}), persistNow:() => true,
    setAccessRequestCookie:() => {}, emitLiveActivity:() => {}, linkPrefix:() => '/s/',
  });
  const route = findRoute(rows, 'post', '/s/:token/request-access');
  const handler = route.args.at(-1);
  const req = { params:{token:'tok'}, body:{name:'Alice',email:'alice@example.com',message:'Hi'}, headers:{} };
  const res = makeResponse();
  handler(req, res);
  assert.equal(fingerprint, 'Alice\nalice@example.com\nHi');
  assert.equal(share.accessRequests.length, 1);
});

test('Windows ServerHost manifest matches every runtime source present in the source package', () => {
  const host = read('windows-server-host/Program.cs');
  const rows = [...host.matchAll(/\{ "([^"]+)", "([0-9a-f]{64})" \}/g)].map((m) => ({ rel:m[1], hash:m[2] }));
  assert.ok(rows.length >= 60);
  const missing = [];
  for (const row of rows) {
    const file = path.join(ROOT, row.rel);
    if (!fs.existsSync(file)) { missing.push(row.rel); continue; }
    const normalized = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    const actual = crypto.createHash('sha256').update(normalized).digest('hex');
    assert.equal(actual, row.hash, row.rel);
  }
  // node_modules is intentionally not tracked in the source tree, but GitHub Actions
  // runs npm ci before this test. The Express package metadata may therefore be
  // present (and was hash-checked above) or absent in a source-only archive.
  assert.deepEqual(missing.filter((rel) => rel !== 'node_modules/express/package.json'), []);
});

test('album collaborator upload contains asynchronous finalization exceptions and rolls back the file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-album-finalize-'));
  try {
    const invite = { id:'i1', role:'contributor', tokenHash:crypto.createHash('sha256').update('secret').digest('hex'), usedFiles:0 };
    const album = { id:'a1', token:'album', type:'album', collaborators:[invite], members:[] };
    let done = null;
    let dest = null;
    const { rows } = create({
      getByToken:(token) => token === 'album' ? album : null,
      timingSafeEqualStr:(a,b) => a === b,
      PWA_IMG_EXT:/^(?:png|jpg|jpeg|webp)$/i,
      IMAGE_MAX_BYTES:1024 * 1024,
      FULL_IMAGES_DIR:tmp,
      imageDimensions:() => null,
      stampPhotoUploadDevice:() => {},
      addShare:() => { throw new Error('simulated-finalization-error'); },
      streamToFileBounded:(_req, _res, file, _max, cb) => { dest = file; fs.writeFileSync(file, 'image'); done = cb; },
    });
    const upload = findRoute(rows, 'post', '/g/:token/c/:secret/upload').args.at(-1);
    const res = makeResponse();
    upload({ params:{token:'album',secret:'secret'}, query:{name:'x.png'}, headers:{'content-type':'image/png'} }, res);
    assert.equal(typeof done, 'function');
    assert.doesNotThrow(() => done(5));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error:'write-error' });
    assert.equal(album.members.length, 0);
    assert.equal(invite.usedFiles, 0);
    assert.equal(fs.existsSync(dest), false);
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('unlock handler consumes rejected password work under Express 4 semantics', async () => {
  const share = { id:'s1', token:'tok', type:'file', pwHash:'hash' };
  const { rows } = create({
    getByToken:(token) => token === 'tok' ? share : null,
    isActive:() => true,
    linkPrefix:() => '/s/',
    clientIp:() => '203.0.113.9',
    checkSharePassword:async() => { throw new Error('kdf-failure'); },
    sendPasswordWorkHtml:(_req, res, error) => res.status(503).send(error),
  });
  const route = findRoute(rows, 'post', '/s/:token/unlock');
  const handler = route.args.at(-1);
  const res = makeResponse();
  await assert.doesNotReject(() => handler({ params:{token:'tok'}, body:{password:'pw'}, headers:{} }, res));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body, 'scrypt-failed');
});

test('zip selection contains path/conversion failures instead of rejecting the async Express handler', async () => {
  const share = { id:'s1', token:'tok', type:'folder', name:'folder', hostPath:'bad' };
  const { rows } = create({
    getByToken:(token) => token === 'tok' ? share : null,
    isActive:() => true,
    zipAllowed:() => true,
    recordAndCheckVisitor:() => true,
    hostToContainer:() => { throw Object.assign(new Error('bad-path'), { code:'EACCES' }); },
  });
  const route = findRoute(rows, 'post', '/s/:token/zip-select');
  const handler = route.args.at(-1);
  const res = makeResponse();
  await assert.doesNotReject(() => handler({ params:{token:'tok'}, body:{sel:['x']}, headers:{}, query:{} }, res));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'folderUnavailable');
});
