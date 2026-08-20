'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8').replace(/\r\n?/g, '\n');

test('1.67.26 Configuration does not show a red connector error on first-use fallback', () => {
  const start = app.indexOf('async function refreshStorageConnectors(forceProbe)');
  const end = app.indexOf("if ($('connector-add'))", start);
  assert.ok(start >= 0 && end > start);
  const block = app.slice(start, end);
  const summaryCatch = block.indexOf('catch (_)');
  const canonical = block.indexOf("/api/storage/connectors', null, 30000");
  assert.ok(summaryCatch >= 0 && canonical > summaryCatch, 'summary failure must fall back to canonical connector API');
  assert.match(block, /if \(!forceProbe && storageConnectors\.length === 0\)/);
  assert.match(block, /renderStorageConnectors\(\{ connectors:\[\], jobs:\[\], capabilities:\{ skipped:true \}/);
  const firstUseStart = block.indexOf('if (!forceProbe && storageConnectors.length === 0)');
  const firstUseEnd = block.indexOf('// Preserve the last server-confirmed connector snapshot', firstUseStart);
  const firstUse = block.slice(firstUseStart, firstUseEnd);
  assert.doesNotMatch(firstUse, /connector\.loadFail/);
  assert.match(block, /refreshStorageConnectors\(false\)/);
});

test('1.67.26 explicit connector refresh still surfaces a real API failure', () => {
  const start = app.indexOf('async function refreshStorageConnectors(forceProbe)');
  const end = app.indexOf("if ($('connector-add'))", start);
  const block = app.slice(start, end);
  assert.match(block, /connectorStatus\('connector-capability', 'connector\.loadFail', true\)/);
  assert.match(app, /connector-refresh'\)\) \$\('connector-refresh'\)\.addEventListener\('click', \(\) => refreshStorageConnectors\(true\)\)/);
});
