'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const app = read('public/app.js');
const server = read('server.js');
const adminStorage = read('lib/server/admin-storage-routes.js');
const connectorJobs = read('lib/server/storage-connector-job-service.js');

test('1.69.6 successful Google setup updates the remote locally instead of forcing a blocking connector probe', () => {
  const start = app.indexOf('function connectorConfigRender(data)');
  const end = app.indexOf('async function pasteConnectorOAuthCallback', start);
  assert.ok(start >= 0 && end > start);
  const block = app.slice(start, end);
  assert.match(block, /rememberConfiguredStorageRemote\(data\.remote\)/);
  const completed = block.slice(block.indexOf("if(data.status==='completed')"));
  assert.doesNotMatch(completed.slice(0, completed.indexOf("if(data.status==='remote-exists')")), /refreshStorageConnectors\(true\)/);
  const direct = block.slice(block.indexOf("if(data.status==='google-direct-completed')"), block.indexOf("if(data.status==='google-credentials')"));
  assert.doesNotMatch(direct, /refreshStorageConnectors\(true\)/);
});

test('1.69.6 connector API bounds optional rclone probing and exposes a neutral pending snapshot', () => {
  assert.match(connectorJobs, /configurationProbeWaitMs = 4000/);
  assert.match(connectorJobs, /async function probeForConfiguration\(\)/);
  assert.match(connectorJobs, /Promise\.race\(\[probePromise,\s*timeout\]\)/);
  assert.match(connectorJobs, /capabilities:\{ available:false, error:null, pending:true \}/);
  const routeStart = adminStorage.indexOf("adminRouter.get('/storage/connectors', requireFullAdmin");
  const routeEnd = adminStorage.indexOf("adminRouter.post('/storage/connectors'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = adminStorage.slice(routeStart, routeEnd);
  assert.match(route, /probeForConfiguration\(\)/);
  assert.match(route, /pending:\s*!!capabilities\.pending/);
  assert.match(route, /try\s*\{\s*connectors = connectorStore\(\)\.map\(publicConnector\)\.filter\(Boolean\);\s*\}\s*catch \(_\)\s*\{\}/);
  assert.match(route, /try\s*\{\s*jobs = pruneJobs\(\)\.map\(publicJob\)\.filter\(Boolean\);\s*\}\s*catch \(_\)\s*\{\}/);
});

test('1.69.6 connector UI renders pending runtime probes without a red load failure', () => {
  const start = app.indexOf('function renderStorageConnectors(data)');
  const end = app.indexOf('async function refreshStorageConnectors(forceProbe)', start);
  const block = app.slice(start, end);
  assert.match(block, /const pending = !!\(data && data\.capabilities && data\.capabilities\.pending\)/);
  assert.match(block, /t\('connector\.runtimeChecking'\)/);
  assert.match(app, /connector\.remoteConfiguredReady/);
  assert.match(app, /Destination rclone configurée et vérifiée/);
});
