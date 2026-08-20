'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const rawApp = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const app = rawApp.replace(/\r\n?/g, '\n');

function extractApiFunction() {
  const start = app.indexOf('async function api(method, url, body, timeoutMs)');
  const end = app.indexOf('// ------------------------------------------------------------------\n// UI helpers', start);
  assert.ok(start >= 0 && end > start, 'api() helper should be present');
  return app.slice(start, end);
}



test('1.68.1 api helper extraction is portable across LF and CRLF checkouts', () => {
  const crlfApp = app.replace(/\n/g, '\r\n');
  const normalized = crlfApp.replace(/\r\n?/g, '\n');
  const start = normalized.indexOf('async function api(method, url, body, timeoutMs)');
  const end = normalized.indexOf('// ------------------------------------------------------------------\n// UI helpers', start);
  assert.ok(start >= 0 && end > start, 'api() helper should be extractable from a CRLF checkout');
});

test('1.68.1 api GET/HEAD never attach a request body even when null is passed as timeout placeholder', async () => {
  const calls = [];
  const context = {
    state:{ authEpoch:1, csrf:'csrf-token' },
    showLogin(){ throw new Error('unexpected-login'); },
    fetchWithTimeout:async (url, opts, timeoutMs) => {
      calls.push({ url, opts, timeoutMs });
      return { status:200, ok:true, async json(){ return { ok:true }; } };
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(extractApiFunction(), context);
  await context.api('get', '/api/storage/connectors/summary', null, 10000);
  await context.api('head', '/probe', { accidental:true }, 5000);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal('body' in call.opts, false, 'GET/HEAD must not carry a body');
    assert.equal(call.opts.headers['Content-Type'], undefined);
    assert.equal(call.opts.headers['X-CSRF-Token'], undefined);
    assert.equal(call.opts.cache, 'no-store');
  }
});

test('1.68.1 connector and web-storage reads still use the shared api helper', () => {
  assert.match(app, /api\('GET','\/api\/storage\/connectors\/summary',null,10000\)/);
  assert.match(app, /api\('GET','\/api\/storage\/connectors',null,30000\)/);
  assert.match(app, /loadWebStoragePath[\s\S]*api\('GET', `\/api\/storage\/connectors\/\$\{encodeURIComponent\(connectorId\)\}\/list/);
});

test('1.68.1 write requests still serialize JSON and include CSRF', async () => {
  const calls = [];
  const context = {
    state:{ authEpoch:1, csrf:'csrf-token' },
    showLogin(){},
    fetchWithTimeout:async (url, opts, timeoutMs) => {
      calls.push({ url, opts, timeoutMs });
      return { status:200, ok:true, async json(){ return { ok:true }; } };
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(extractApiFunction(), context);
  await context.api('POST', '/api/storage/connectors', { name:'Google Drive' }, 120000);
  assert.equal(calls[0].opts.body, JSON.stringify({ name:'Google Drive' }));
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].opts.headers['X-CSRF-Token'], 'csrf-token');
});
