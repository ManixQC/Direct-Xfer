'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const app = read('public/app.js');
const server = read('server.js');

test('1.68.1 confirmed connector inventory is not replaced by a stale red load error', () => {
  assert.match(app, /let connectorInventoryConfirmed = false/);
  const start = app.indexOf('async function refreshStorageConnectors(forceProbe)');
  const end = app.indexOf("if ($('connector-add'))", start);
  const block = app.slice(start, end);
  assert.match(block, /connectorInventoryConfirmed = true/);
  assert.match(block, /if \(!connectorInventoryConfirmed && storageConnectors\.length === 0\)/);
  assert.match(block, /if \(!connectorInventoryConfirmed && storageConnectors\.length === 0\) \{\s*connectorStatus\('connector-capability', 'connector\.loadFail', true\)/);
});

test('1.68.1 successful POST or PATCH confirms the inventory before background refresh', () => {
  const start = app.indexOf("if ($('connector-add')) $('connector-add').addEventListener('click'");
  const end = app.indexOf('async function startConnectorTransfer', start);
  const block = app.slice(start, end);
  assert.match(block, /if \(authoritative \|\| \(saved && saved\.id\)\) connectorInventoryConfirmed = true/);
  assert.match(block, /void refreshStorageConnectors\(false\)/);
});

test('1.68.1 exact connector POST retries are idempotent', () => {
  const start = server.indexOf("adminRouter.post('/storage/connectors'");
  const end = server.indexOf("adminRouter.patch('/storage/connectors/:id'", start);
  const block = server.slice(start, end);
  assert.match(block, /Exact POST retries are idempotent/);
  assert.match(block, /const existing = list\.find/);
  assert.match(block, /duplicate:true/);
  assert.ok(block.indexOf('const existing = list.find') < block.indexOf("connector.id = crypto.randomBytes"));
});
