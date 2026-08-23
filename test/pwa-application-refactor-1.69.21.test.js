'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  PWA_ROUTE_FACADE_CONTEXT,
  createPwaDocumentHeaders,
  createPwaRouteFacades,
  createPwaRouteLiveBindings,
  projectContextGroup,
} = require('../lib/server/pwa-application');
const { ROUTE_SERVICE_EXPORTS } = require('../lib/server/pwa-composition-service');

function contextFromRouteMap() {
  const domains = Object.create(null);
  for (const spec of Object.values(PWA_ROUTE_FACADE_CONTEXT)) {
    for (const [exposed, [domainName, propertyName]] of Object.entries(spec)) {
      if (!domains[domainName]) domains[domainName] = Object.create(null);
      if (!Object.prototype.hasOwnProperty.call(domains[domainName], propertyName)) {
        domains[domainName][propertyName] = function dependencyMarker() { return `${domainName}.${propertyName}`; };
      }
      if (exposed === 'activeTransfers') domains[domainName][propertyName] = new Map();
      if (exposed === 'QRCode') domains[domainName][propertyName] = { toString() {} };
    }
  }
  const express = function expressMarker() {};
  express.json = () => 'json-parser';
  express.raw = () => 'raw-parser';
  express.static = () => 'static-parser';
  domains.platform.express = express;
  return {
    domains,
    context: {
      current(name) { return domains[name] || null; },
    },
    express,
  };
}

test('PWA route facade projection is explicit and preserves callable module identity', () => {
  const fx = contextFromRouteMap();
  const locals = {
    appLoginParser:() => {},
    pwaIndexTemplate:'<html></html>',
    pwaJsonParser:() => {},
    pwaNetworkTestParser:() => {},
    pwaNetworkTestPayload:Buffer.alloc(1),
    setPwaDocumentHeaders:() => {},
  };
  const facades = createPwaRouteFacades(fx.context, locals);
  assert.equal(facades.runtime.express, fx.express);
  assert.equal(facades.runtime.express.json(), 'json-parser');
  assert.equal(facades.runtime.pwaIndexTemplate, '<html></html>');
  assert.equal(Object.isFrozen(facades), true);
  assert.equal(Object.isFrozen(facades.runtime), true);
  assert.equal(typeof facades.identity.attemptLogin, 'function');
  assert.ok(facades.activity.activeTransfers instanceof Map);
});

test('PWA context projection rejects missing and accessor-backed dependencies', () => {
  const missing = { current:() => ({}) };
  assert.throws(
    () => projectContextGroup(missing, { x:['domain', 'missing'] }),
    /missing stable missing/
  );

  const source = {};
  Object.defineProperty(source, 'dynamic', { enumerable:true, get:() => 1 });
  const accessor = { current:(name) => name === 'domain' ? source : null };
  assert.throws(
    () => projectContextGroup(accessor, { x:['domain', 'dynamic'] }),
    /missing stable dynamic/
  );
});

test('PWA live bridge reads and writes the current server state instead of snapshotting it', () => {
  let state = { id:1 };
  let building = false;
  let index = { generation:1 };
  let webpush = null;
  const live = createPwaRouteLiveBindings({
    getState:() => state,
    setState:(value) => { state = value; },
    getSearchIndexBuilding:() => building,
    getUniversalSearchIndex:() => index,
    getWebpush:() => webpush,
  });
  assert.equal(live.state.id, 1);
  live.state = { id:2 };
  assert.equal(state.id, 2);
  building = true;
  index = { generation:2 };
  webpush = { enabled:true };
  assert.equal(live.searchIndexBuilding, true);
  assert.equal(live.universalSearchIndex.generation, 2);
  assert.equal(live.webpush.enabled, true);
});

test('PWA document headers remain private, non-cacheable and frame-protected', () => {
  const headers = Object.create(null);
  createPwaDocumentHeaders({ setHeader(name, value) { headers[name] = value; } });
  assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.equal(headers['Vary'], 'Cookie, Authorization');
  assert.equal(headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/);
});

test('every PWA route dependency is provided by a service, context facade or live/bootstrap binding', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'pwa-routes.js'), 'utf8');
  const match = routes.match(/const \{\n    ACTIVITY_HISTORY_MAX,([\s\S]*?)\n  \} = deps;/);
  assert.ok(match, 'route dependency destructuring should remain discoverable');
  const required = new Set(['ACTIVITY_HISTORY_MAX']);
  for (const raw of match[1].split(',')) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) required.add(name);
  }

  const provided = new Set(['app', 'rootDir', 'live']);
  for (const names of Object.values(ROUTE_SERVICE_EXPORTS)) for (const name of names) provided.add(name);
  for (const spec of Object.values(PWA_ROUTE_FACADE_CONTEXT)) for (const name of Object.keys(spec)) provided.add(name);
  for (const name of [
    'appLoginParser', 'pwaIndexTemplate', 'pwaJsonParser', 'pwaNetworkTestParser',
    'pwaNetworkTestPayload', 'setPwaDocumentHeaders',
  ]) provided.add(name);

  const missing = [...required].filter((name) => !provided.has(name));
  assert.deepEqual(missing, [], `uncomposed PWA route dependencies: ${missing.join(', ')}`);
});

test('server delegates PWA bootstrap and no longer owns route facade/parser/template construction', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const application = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'pwa-application.js'), 'utf8');
  assert.match(server, /const pwaApplication = createPwaApplication\(\{/);
  assert.doesNotMatch(server, /const pwaIndexTemplate =|const pwaRouteFacades =|const pwaNetworkTestPayload =/);
  assert.doesNotMatch(server, /createPwaDeviceService\(|createPwaPhotoService\(|createPwaEventService\(|createWebauthnService\(/);
  assert.ok(application.indexOf("attachPwaRoutes({") < application.indexOf("context.register('pwa-device'"),
    'PWA services must only be published after route composition succeeds');
  assert.match(application, /PWA_PUBLIC_ASSET_PATHS instanceof Set/);
  assert.ok(server.split('\n').length < 2400);
});

test('Windows runtime integrity protects the extracted PWA application boundary', () => {
  const crypto = require('node:crypto');
  const rel = 'lib/server/pwa-application.js';
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const host = fs.readFileSync(path.join(ROOT, 'windows-server-host', 'Program.cs'), 'utf8');
  assert.match(host, new RegExp(`\\{ \"${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\", \"${hash}\" \\}`));
});
