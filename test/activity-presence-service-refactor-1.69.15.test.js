'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createActivityPresenceService } = require('../lib/server/activity-presence-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function response() {
  const closeHandlers = [];
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    flushHeaders() {},
    write(value) { this.chunks.push(String(value)); return true; },
    end() { this.writableEnded = true; },
    on(name, fn) { if (name === 'close') closeHandlers.push(fn); return this; },
    close() { for (const fn of closeHandlers) fn(); },
  };
}

function fixture(overrides = {}) {
  const state = {
    settings: {},
    history: [],
    activityLog: [],
    ipNames: {},
    shares: [],
    trash: [],
  };
  const settings = { anonymizeIps: false, keepIpNames: true };
  const shares = new Map();
  const transfers = new Map();
  const devices = [];
  const activeSessions = new Set(['sid-1', 'sid-op']);
  let flushes = 0;
  const intervals = new Set();
  const timeouts = new Set();
  const service = createActivityPresenceService({
    crypto,
    getState: () => state,
    getSettings: () => settings,
    scheduleFlush: () => { flushes += 1; },
    getShareById: (id) => shares.get(String(id)) || null,
    getTrashItems: () => state.trash,
    getPwaDevices: () => devices,
    isSessionActive: (sid, roles) => activeSessions.has(sid) && Array.isArray(roles),
    getActiveTransfers: () => transfers,
    now: () => 1700000000000,
    setIntervalRef(fn, ms) { const timer = { fn, ms, unref() {} }; intervals.add(timer); return timer; },
    clearIntervalRef(timer) { intervals.delete(timer); },
    setTimeoutRef(fn, ms) { const timer = { fn, ms, unref() {} }; timeouts.add(timer); return timer; },
    clearTimeoutRef(timer) { timeouts.delete(timer); },
    ...overrides,
  });
  return { service, state, settings, shares, transfers, devices, activeSessions, intervals, timeouts, get flushes() { return flushes; } };
}

test('activity-presence service owns IP privacy, nicknames and transfer-history projection', () => {
  const f = fixture();
  f.state.history.push({ id:'h1', shareId:'s1', ip:'203.0.113.42', startedAt:100 });
  f.state.ipNames['203.0.113.x'] = 'Office';
  f.settings.anonymizeIps = true;

  assert.equal(f.service.maskIp('::ffff:203.0.113.42'), '203.0.113.x');
  assert.equal(f.service.maskIp('2001:db8:abcd:1234::1'), '2001:db8:abcd::');
  assert.equal(f.service.pubIp('203.0.113.42'), '203.0.113.x');
  assert.deepEqual(f.service.listHistory(), [{ id:'h1', shareId:'s1', ip:'203.0.113.x', startedAt:100, ipName:'Office' }]);
  assert.deepEqual(f.service.historyMeta(), { count:1, latestId:'h1', latestAt:100, viewRevision:0 });
  assert.equal(f.service.bumpHistoryViewRevision(), 1);
  assert.equal(f.service.setHistoryViewRevision(7.8), 7);
  assert.equal(f.service.historyMeta().viewRevision, 7);
});

test('activity history sanitation, migration and durable emission stay bounded and privacy-aware', () => {
  const f = fixture();
  f.settings.anonymizeIps = true;
  const migrated = f.service.buildLegacyActivityLog(
    [
      { seq:1, at:200, action:'login', actor:'owner', ip:'203.0.113.9' },
      { seq:2, at:300, action:'push-subscribed', actor:'owner', ip:'203.0.113.10' },
    ],
    [{ id:'t1', shareId:'s1', endedAt:250, name:'file.bin', bytes:10, ip:'198.51.100.8', completed:true, direction:'down' }],
  );
  assert.equal(migrated.length, 2);
  assert.equal(migrated.some((row) => row.status === 'push-subscribed'), false);
  assert.equal(migrated.find((row) => row.status === 'login').ip, '203.0.113.x');

  const event = f.service.emitLiveActivity('audit', {
    name:'changed\nname', status:'changed', detail:'line\tbreak', ip:'198.51.100.7', bytes:-9,
  });
  assert.equal(event.name, 'changed name');
  assert.equal(event.detail, 'line break');
  assert.equal(event.bytes, 0);
  assert.equal(f.state.activityLog[0].id, event.id);
  assert.equal(f.flushes, 1);
});

test('activity SSE snapshot and future events are scoped to an active audit-capable session', () => {
  const f = fixture();
  f.state.activityLog = [
    { id:'new1', at:200, kind:'audit', name:'new', status:'new' },
    { id:'old1', at:100, kind:'audit', name:'old', status:'old' },
  ];
  const res = response();
  const client = f.service.openLiveActivityStream(res, 'sid-1', 500);
  assert.ok(client);
  assert.equal(f.service.liveActivityClients.size, 1);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.chunks[0], /event: snapshot/);
  assert.ok(res.chunks[0].indexOf('old1') < res.chunks[0].indexOf('new1'), 'snapshot should replay oldest to newest');

  f.service.emitLiveActivity('system', { name:'runtime', status:'ok' });
  assert.match(res.chunks.at(-1), /event: activity/);
  assert.match(res.chunks.at(-1), /runtime/);

  f.activeSessions.delete('sid-1');
  const heartbeat = [...f.intervals][0];
  heartbeat.fn();
  assert.equal(res.writableEnded, true);
  assert.equal(f.service.liveActivityClients.size, 0);
});

test('download presence counts only real notifying down-transfers and filters owner scopes', () => {
  const f = fixture();
  f.shares.set('mine', { id:'mine', ownerId:'a1' });
  f.shares.set('other', { id:'other', ownerId:'a2' });
  f.transfers.set('1', { shareId:'mine', direction:'down', notify:true });
  f.transfers.set('2', { shareId:'mine', direction:'down', notify:true });
  f.transfers.set('3', { shareId:'mine', direction:'up', notify:true });
  f.transfers.set('4', { shareId:'mine', direction:'down', notify:false });
  f.transfers.set('5', { shareId:'other', direction:'down', notify:true });

  assert.deepEqual(f.service.presenceSnapshot({ seeAll:false, accountId:'a1' }), { counts:{ mine:2 } });
  assert.deepEqual(f.service.presenceSnapshot({ seeAll:true, accountId:'a1' }), { counts:{ mine:2, other:1 } });
});

test('presence SSE validates principals, emits scoped snapshots and debounces broadcasts', () => {
  const f = fixture();
  f.shares.set('mine', { id:'mine', ownerId:'a1' });
  f.transfers.set('1', { shareId:'mine', direction:'down', notify:true });
  const res = response();
  let valid = true;
  const client = f.service.openPresenceStream(res, { seeAll:false, accountId:'a1' }, () => valid);
  assert.ok(client);
  assert.equal(f.service.presenceClients.size, 1);
  assert.match(res.chunks[0], /"mine":1/);

  f.service.schedulePresenceBroadcast();
  f.service.schedulePresenceBroadcast();
  assert.equal(f.timeouts.size, 1, 'broadcast bursts should collapse to one timer');
  const timer = [...f.timeouts][0];
  timer.fn();
  assert.equal(f.timeouts.size, 1, 'fixture timer remains registered until clear; service state must still debounce internally');
  assert.match(res.chunks.at(-1), /event: presence/);

  valid = false;
  const heartbeat = [...f.intervals][0];
  heartbeat.fn();
  assert.equal(res.writableEnded, true);
  assert.equal(f.service.presenceClients.size, 0);
});

test('service closes stored client objects correctly during restore/shutdown cleanup', () => {
  const f = fixture();
  const activityRes = response();
  const presenceRes = response();
  f.service.openLiveActivityStream(activityRes, 'sid-1');
  f.service.openPresenceStream(presenceRes, { seeAll:true, accountId:'a1' }, () => true);
  assert.equal(f.service.liveActivityClients.size, 1);
  assert.equal(f.service.presenceClients.size, 1);

  f.service.closeLiveActivityClients();
  f.service.closePresenceClients();
  assert.equal(activityRes.writableEnded, true);
  assert.equal(presenceRes.writableEnded, true);
  assert.equal(f.service.liveActivityClients.size, 0);
  assert.equal(f.service.presenceClients.size, 0);
});

test('server and route modules compose activity-presence-service instead of retaining the implementation', () => {
  const server = read('server.js');
  const core = read('lib/server/core-state-application.js');
  const service = read('lib/server/activity-presence-service.js');
  const dashboard = read('lib/server/admin-dashboard-routes.js');
  const pwa = read('lib/server/pwa-routes.js');

  assert.match(server, /createCoreStateApplication\(\{/);
  assert.match(core, /createActivityPresenceService\(\{/);
  assert.doesNotMatch(server, /^function maskIp\(/m);
  assert.doesNotMatch(server, /^function emitLiveActivity\(/m);
  assert.doesNotMatch(server, /^function activeDownloadCounts\(/m);
  assert.doesNotMatch(server, /^function openPresenceStream\(/m);
  assert.match(service, /function buildLegacyActivityLog\(/);
  assert.match(service, /function openLiveActivityStream\(/);
  assert.match(service, /function schedulePresenceBroadcast\(/);
  assert.match(dashboard, /openLiveActivityStream\(res, req\.session\.sid, 500\)/);
  assert.match(dashboard, /res\.json\(presenceSnapshot\(scope\)\)/);
  assert.match(pwa, /res\.json\(presenceSnapshot\(scope\)\)/);
  assert.ok(server.split('\n').length < 3900, 'activity/presence extraction should materially reduce server.js');
});
