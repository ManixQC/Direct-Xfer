'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const shareRoutes = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'admin-share-routes.js'), 'utf8');
const { attachAdminShareCoreRoutes, attachAdminShareRoutes } = require('../lib/server/admin-share-routes');

test('1.69.6 share administration is composed through a dedicated route boundary', () => {
  assert.match(server, /attachAdminShareCoreRoutes\(applicationContext\.route\('adminShareCore'/);
  assert.match(server, /attachAdminShareRoutes\(applicationContext\.route\('adminShare'/);
  assert.doesNotMatch(server, /adminRouter\.post\('\/shares\/pause-all'/);
  assert.doesNotMatch(server, /adminRouter\.post\('\/shares\/web-storage'/);
  assert.match(shareRoutes, /adminRouter\.post\('\/shares\/pause-all', requireFullAdmin/);
  assert.match(shareRoutes, /adminRouter\.post\('\/shares\/web-storage', requireFullAdmin/);
});

test('share route extraction keeps mutable store and search bindings live', () => {
  assert.match(server, /const adminShareRouteLiveBindings = \{/);
  assert.match(server, /set state\(value\) \{ state = value; \}/);
  assert.match(shareRoutes, /live\.state = beforeState/);
  assert.match(shareRoutes, /live\.searchIndexBuilding/);
  assert.match(shareRoutes, /live\.universalSearchIndex/);
});

test('share route module registers the complete extracted route surface without duplicates', () => {
  const registrations = [];
  const adminRouter = {};
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    adminRouter[method] = (...args) => {
      registrations.push(`${method.toUpperCase()} ${Array.isArray(args[0]) ? args[0].join('|') : args[0]}`);
      return adminRouter;
    };
  }
  const dummy = () => {};
  const live = {
    state: { stats:{}, meta:{} },
    searchIndexBuilding:false,
    searchIndexError:null,
    universalSearchIndex:{ docs:[], builtAt:0 },
  };
  const deps = new Proxy({ adminRouter, requireFullAdmin:dummy, live }, {
    get(target, key) { return key in target ? target[key] : dummy; },
  });
  attachAdminShareCoreRoutes(deps);
  attachAdminShareRoutes(deps);
  assert.equal(registrations.length, 63);
  assert.equal(new Set(registrations).size, registrations.length);
  assert.ok(registrations.includes('GET /shares'));
  assert.ok(registrations.includes('GET /history'));
  assert.ok(registrations.includes('POST /shares'));
  assert.ok(registrations.includes('DELETE /shares/:id'));
  assert.ok(registrations.includes('POST /collab'));
  assert.ok(registrations.includes('GET /qr'));
});

test('server.js remains below one MiB after share-route extraction', () => {
  assert.ok(Buffer.byteLength(server, 'utf8') < 1024 * 1024, `server.js is ${Buffer.byteLength(server, 'utf8')} bytes`);
});

test('share core returns cross-boundary helpers and detailed stats keep live bindings separate from live transfers', async () => {
  const registrations = [];
  const adminRouter = {};
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    adminRouter[method] = (...args) => { registrations.push([method, args[0]]); return adminRouter; };
  }
  const stub = () => {};
  const liveBindings = {
    state: { shares:[], history:[], stats:{}, meta:{} },
    searchIndexBuilding:false,
    searchIndexError:null,
    universalSearchIndex:{ docs:[], builtAt:0 },
  };
  const activeTransfers = new Map([
    ['t1', { id:'t1', shareId:'s1', direction:'down', bytes:3, expectedBytes:5, startedAt:1, lastActivity:2, ip:'127.0.0.1' }],
  ]);
  const base = {
    adminRouter,
    requireFullAdmin:stub,
    live:liveBindings,
    activeTransfers,
    decorateShare:() => ({ url:'/s/token', itemCount:1 }),
    shareStatsBaseline:() => ({ at:0, views:0, visitors:0, downloads:0 }),
    pubIp:(ip) => ip,
    ipNameFor:() => '',
    shareItems:() => [{ size:5 }],
    shareEffectiveExpiry:() => 0,
    isScheduled:() => false,
    isActive:() => true,
    parseMaxVisitors:(v) => Number(v) || 0,
    VISITORS_MAX:1000,
  };
  const deps = new Proxy(base, {
    get(target, prop) { return prop in target ? target[prop] : stub; },
  });
  const helpers = attachAdminShareCoreRoutes(deps);
  assert.equal(typeof helpers.resolveHostItem, 'function');
  assert.equal(typeof helpers.reqPathList, 'function');
  assert.equal(typeof helpers.safeReceivedFilePath, 'function');
  assert.equal(typeof helpers.detailedShareStatsPayload, 'function');

  const payload = await helpers.detailedShareStatsPayload(
    { id:'s1', name:'Share', type:'file', size:5, createdAt:1, visitors:[], downloads:0 },
    { query:{ period:'14' } },
  );
  assert.ok(Array.isArray(payload.live));
  assert.equal(payload.live.length, 1);
  assert.equal(payload.live[0].id, 't1');
  assert.notEqual(payload.live, liveBindings);
});

test('share extraction does not depend on the Express app before app construction', () => {
  const start = server.indexOf("attachAdminShareCoreRoutes(applicationContext.route('adminShareCore'");
  const end = server.indexOf("applicationContext.register('share-core-output'", start);
  assert.ok(start >= 0 && end > start);
  const call = server.slice(start, end);
  assert.doesNotMatch(call, /['"]http-application['"]/);
  assert.doesNotMatch(call, /^\s*app,\s*$/m);
  assert.match(server, /const \{ detailedShareStatsPayload, reqPathList, resolveHostItem, safeReceivedFilePath \} = attachAdminShareCoreRoutes\(applicationContext\.route\('adminShareCore'/);
  assert.match(server, /normalizeTags \} = require\('\.\/lib\/server\/admin-share-routes'\)/);
});
