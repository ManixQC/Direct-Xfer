'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const app = read('public/app.js');
const server = read('server.js');

test('1.68.3 successful Google setup updates the remote locally instead of forcing a blocking connector probe', () => {
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

test('1.68.3 connector API bounds optional rclone probing and exposes a neutral pending snapshot', () => {
  assert.match(server, /const CONNECTOR_CONFIG_PROBE_WAIT_MS = 4000/);
  assert.match(server, /async function connectorProbeForConfiguration\(\)/);
  assert.match(server, /Promise\.race\(\[probePromise,\s*timeout\]\)/);
  assert.match(server, /capabilities:\{ available:false, error:null, pending:true \}/);
  const routeStart = server.indexOf("adminRouter.get('/storage/connectors', requireFullAdmin");
  const routeEnd = server.indexOf("adminRouter.post('/storage/connectors'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.match(route, /connectorProbeForConfiguration\(\)/);
  assert.match(route, /pending:!!capabilities\.pending/);
  assert.match(route, /try \{ connectors = connectorStore\(\)\.map\(publicConnector\)\.filter\(Boolean\); \} catch \(_\) \{\}/);
  assert.match(route, /try \{ jobs = pruneConnectorJobs\(\)\.map\(publicConnectorJob\); \} catch \(_\) \{\}/);
});

test('1.68.3 connector UI renders pending runtime probes without a red load failure', () => {
  const start = app.indexOf('function renderStorageConnectors(data)');
  const end = app.indexOf('async function refreshStorageConnectors(forceProbe)', start);
  const block = app.slice(start, end);
  assert.match(block, /const pending = !!\(data && data\.capabilities && data\.capabilities\.pending\)/);
  assert.match(block, /t\('connector\.runtimeChecking'\)/);
  assert.match(app, /connector\.remoteConfiguredReady/);
  assert.match(app, /Destination rclone configurée et vérifiée/);
});
