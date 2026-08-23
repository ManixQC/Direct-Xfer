'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  return new Proxy(extra, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noop;
    },
  });
}

function makeResponse() {
  return {
    statusCode:200,
    headers:{},
    body:null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    send(v) { this.body = v; return this; },
    json(v) { this.body = v; return this; },
    redirect(code, v) { this.statusCode = code; this.body = v; return this; },
  };
}

function route(rows, method, signature) {
  return rows.find((row) => row.method === method && row.args[0] === signature);
}

test('point 1 public share HTTP surface is outside server.js', () => {
  const server = read('server.js');
  const routes = read('lib/server/public-share-routes.js');
  const publicHttp = read('lib/server/public-http-application.js');
  assert.match(server, /createPublicHttpApplication/);
  assert.match(publicHttp, /createPublicShareRoutes/);
  assert.match(routes, /function createPublicShareRoutes\(deps = \{\}\)/);
  assert.doesNotMatch(server, /downloadRouter\.(?:get|post|put|delete|patch|use)\(/);
  for (const signature of [
    "downloadRouter.get('/s/:token'",
    "downloadRouter.get('/s/:token/download'",
    "downloadRouter.get(['/s/:token/browse', '/s/:token/browse/*']",
    "downloadRouter.get('/i/:token'",
    "downloadRouter.get('/g/:token'",
    "downloadRouter.get('/x/:token'",
    "downloadRouter.post('/s/:token/unlock'",
    "downloadRouter.post(['/s/:token/request-access'",
    "downloadRouter.post('/s/:token/feedback'",
  ]) assert.ok(routes.includes(signature), signature);
});

test('public share route module preserves the complete 33-route public read surface', () => {
  const { express, rows } = fakeExpress();
  const out = createPublicShareRoutes(proxyDeps({
    express,
    getByToken:() => null,
    getState:() => ({ meta:{} }),
    sendError:() => {},
    recipientByToken:new Map(),
    unlockFails:new Map(),
    unlockAuthInFlight:new Set(),
  }));
  const http = rows.filter((row) => row.method === 'get' || row.method === 'post');
  assert.equal(http.length, 33);
  assert.equal(rows.filter((row) => row.method === 'use').length, 4);
  assert.equal(new Set(http.map((row) => row.method + ':' + JSON.stringify(row.args[0]))).size, 33);
  assert.equal(out.ZIP_SELECTION_MAX, 2000);
  assert.equal(typeof out.serveFolderFile, 'function');
  assert.equal(typeof out.shareManifestFiles, 'function');
});

test('burn-after-read secret handlers always use the current restored state root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-public-share-secret-'));
  try {
    const token = 'abcDEF123456';
    const file = path.join(tmp, token + '.dxe');
    fs.writeFileSync(file, Buffer.from('ciphertext'));
    let state = { meta:{ secrets:{ [token]:{ mode:'text' } } } };
    const { express, rows } = fakeExpress();
    const out = createPublicShareRoutes(proxyDeps({
      express,
      SECRETS_DIR:tmp,
      getByToken:() => null,
      getState:() => state,
      sendError:() => {},
      secretPage:() => 'secret-page',
      pickLang:() => 'en',
      persistNow:() => true,
      recipientByToken:new Map(), unlockFails:new Map(), unlockAuthInFlight:new Set(),
    }));
    assert.ok(out.downloadRouter);
    // Replace the state root after route creation. The handler must mutate this
    // live root, not the object that existed during composition.
    state = { meta:{ secrets:{ [token]:{ mode:'text' } } } };
    const blob = route(rows, 'get', '/x/:token/blob');
    const req = { params:{ token } };
    const res = makeResponse();
    blob.args.at(-1)(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, Buffer.from('ciphertext'));
    assert.equal(state.meta.secrets[token], undefined);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});

test('public image hotlink host sanitizer stays bounded and canonical', () => {
  const { express } = fakeExpress();
  const out = createPublicShareRoutes(proxyDeps({
    express,
    getByToken:() => null,
    getState:() => ({ meta:{} }),
    sendError:() => {},
    recipientByToken:new Map(), unlockFails:new Map(), unlockAuthInFlight:new Set(),
  }));
  assert.deepEqual(out.parseHotlinkHosts('HTTPS://*.Example.COM:443/path, cdn.example.net; bad@host'), [
    'example.com', 'cdn.example.net',
  ]);
  assert.equal(out.parseHotlinkHosts(Array.from({length:80}, (_, i) => `h${i}.example`)).length, 50);
});

test('ZIP selection parser remains bounded after extraction', () => {
  const { express } = fakeExpress();
  const out = createPublicShareRoutes(proxyDeps({
    express,
    getByToken:() => null,
    getState:() => ({ meta:{} }),
    sendError:() => {},
    recipientByToken:new Map(), unlockFails:new Map(), unlockAuthInFlight:new Set(),
  }));
  const input = Array.from({ length:2500 }, (_, i) => `folder/file-${i}`).join('\n');
  const parsed = out.parseSelList(input);
  assert.equal(parsed.length, 2000);
  assert.equal(parsed[0], 'folder/file-0');
  assert.equal(parsed.at(-1), 'folder/file-1999');
});
