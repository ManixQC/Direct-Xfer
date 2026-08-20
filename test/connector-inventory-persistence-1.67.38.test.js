'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const app = read('public/app.js');
const server = read('server.js');

test('1.68.2 POST/PATCH connector writes return an authoritative no-store inventory', () => {
  const postStart = server.indexOf("adminRouter.post('/storage/connectors'");
  const patchStart = server.indexOf("adminRouter.patch('/storage/connectors/:id'", postStart);
  const deleteStart = server.indexOf("adminRouter.delete('/storage/connectors/:id'", patchStart);
  assert.ok(postStart >= 0 && patchStart > postStart && deleteStart > patchStart);
  const post = server.slice(postStart, patchStart);
  const patch = server.slice(patchStart, deleteStart);
  for (const block of [post, patch]) {
    assert.match(block, /connectorStore\(\)\.map\(publicConnector\)\.filter\(Boolean\)/);
    assert.match(block, /setHeader\('Cache-Control', 'no-store'\)/);
    assert.match(block, /connector:publicConnector\(/);
    assert.match(block, /connectors/);
  }
});

test('1.68.2 connector reads and generic API GETs bypass caches', () => {
  const summary = server.slice(
    server.indexOf("adminRouter.get('/storage/connectors/summary'"),
    server.indexOf("adminRouter.get('/storage/connectors'", server.indexOf("adminRouter.get('/storage/connectors/summary'") + 1)
  );
  assert.match(summary, /Cache-Control', 'no-store'/);
  const apiStart = app.indexOf('async function api(method, url, body, timeoutMs)');
  const apiEnd = app.indexOf('// ------------------------------------------------------------------\n// UI helpers', apiStart);
  const api = app.slice(apiStart, apiEnd);
  assert.match(api, /if \(\['GET', 'HEAD'\]\.includes\(method\)\) opts\.cache = 'no-store'/);
});

test('1.68.2 successful connector save renders the server-confirmed connector before background refresh', () => {
  const start = app.indexOf("if ($('connector-add')) $('connector-add').addEventListener('click'");
  const end = app.indexOf('async function startConnectorTransfer', start);
  const block = app.slice(start, end);
  assert.match(block, /const authoritative = Array\.isArray\(result && result\.connectors\)/);
  assert.match(block, /renderStorageConnectors\(\{ connectors:authoritative/);
  assert.match(block, /const next = storageConnectors\.filter/);
  assert.match(block, /void refreshStorageConnectors\(false\)/);
  assert.doesNotMatch(block, /await refreshStorageConnectors\(/);
});

test('1.68.2 stale connector refreshes cannot overwrite a newer inventory', () => {
  assert.match(app, /let connectorRefreshSerial = 0/);
  const start = app.indexOf('async function refreshStorageConnectors(forceProbe)');
  const end = app.indexOf("if ($('connector-add'))", start);
  const block = app.slice(start, end);
  assert.match(block, /const refreshSerial = \+\+connectorRefreshSerial/);
  assert.match(block, /if \(refreshSerial !== connectorRefreshSerial\) return/);
  assert.match(block, /Summary is advisory only/);
  assert.doesNotMatch(block, /storageConnectors = \[\]/);
  assert.match(block, /Preserve the last server-confirmed connector snapshot/);
});
