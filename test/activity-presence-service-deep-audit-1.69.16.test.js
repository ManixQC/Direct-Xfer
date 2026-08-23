'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createActivityPresenceService } = require('../lib/server/activity-presence-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function response(options = {}) {
  const handlers = new Map();
  const onceHandlers = new Map();
  let writes = 0;
  const addHandler = (collection, name, fn) => {
    if (!collection.has(name)) collection.set(name, new Set());
    collection.get(name).add(fn);
  };
  const removeHandler = (collection, name, fn) => {
    if (collection.has(name)) collection.get(name).delete(fn);
  };
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    writableEnded: false,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    flushHeaders() { this.headersSent = true; },
    write(value) {
      writes += 1;
      if (options.throwOnWrite && writes === options.throwOnWrite) throw new Error('socket-failed');
      this.chunks.push(String(value));
      if (options.falseOnWrite && writes === options.falseOnWrite) return false;
      return true;
    },
    end() { this.writableEnded = true; },
    on(name, fn) { addHandler(handlers, name, fn); return this; },
    once(name, fn) {
      addHandler(handlers, name, fn);
      addHandler(onceHandlers, name, fn);
      return this;
    },
    off(name, fn) {
      removeHandler(handlers, name, fn);
      removeHandler(onceHandlers, name, fn);
      return this;
    },
    removeListener(name, fn) { return this.off(name, fn); },
    emit(name) {
      const current = [...(handlers.get(name) || [])];
      for (const fn of current) {
        if ((onceHandlers.get(name) || new Set()).has(fn)) {
          removeHandler(handlers, name, fn);
          removeHandler(onceHandlers, name, fn);
        }
        fn();
      }
    },
    close() { this.writableEnded = true; this.emit('close'); },
    drain() { this.emit('drain'); },
    get writes() { return writes; },
  };
  return res;
}

function fixture(overrides = {}) {
  const state = { history: [], activityLog: [], ipNames: {}, trash: [] };
  const settings = { anonymizeIps: false, keepIpNames: true };
  const shares = new Map();
  const transfers = new Map();
  const devices = [];
  const sessions = new Set(['audit', 'operator']);
  const intervals = new Set();
  const timeouts = new Set();
  let trashReads = 0;
  let deviceReads = 0;
  const service = createActivityPresenceService({
    crypto,
    getState: () => state,
    getSettings: () => settings,
    scheduleFlush: () => {},
    getShareById: (id) => shares.get(String(id)) || null,
    getTrashItems: () => { trashReads += 1; return state.trash; },
    getPwaDevices: () => { deviceReads += 1; return devices; },
    isSessionActive: (sid) => sessions.has(sid),
    getActiveTransfers: () => transfers,
    now: () => 1700000000000,
    setIntervalRef(fn, ms) { const timer = { fn, ms, unref() {} }; intervals.add(timer); return timer; },
    clearIntervalRef(timer) { intervals.delete(timer); },
    setTimeoutRef(fn, ms) { const timer = { fn, ms, unref() {} }; timeouts.add(timer); return timer; },
    clearTimeoutRef(timer) { timeouts.delete(timer); },
    ...overrides,
  });
  return {
    service, state, settings, shares, transfers, devices, sessions, intervals, timeouts,
    counters: { get trashReads() { return trashReads; }, get deviceReads() { return deviceReads; } },
  };
}

test('IPv6 privacy masking is valid and stable for compressed, loopback and mapped addresses', () => {
  const f = fixture();
  assert.equal(f.service.maskIp('2001:db8::1'), '2001:db8:0::');
  assert.equal(f.service.maskIp('::1'), '0:0:0::');
  assert.equal(f.service.maskIp('fe80::1234:5678'), 'fe80:0:0::');
  assert.equal(f.service.maskIp('2001:0DB8:ABCD:1234::1'), '2001:db8:abcd::');
  assert.equal(f.service.maskIp('::ffff:203.0.113.42'), '203.0.113.x');
  assert.equal(f.service.maskIp('[::ffff:203.0.113.42]'), '203.0.113.x');
  assert.equal(f.service.maskIp('[fe80::1234:5678%eth0]'), 'fe80:0:0::');
  for (const ip of ['2001:db8::1', '::1', 'fe80::1234:5678']) {
    assert.doesNotMatch(f.service.maskIp(ip), /:::/, 'masked IPv6 must never contain an invalid triple colon');
  }
});

test('history projection tolerates malformed rows and preserves nickname/privacy semantics', () => {
  const f = fixture();
  f.state.history = [null, false, 'corrupt', ['also-corrupt'], { id:'h1', shareId:'s1', ip:'2001:db8::1', startedAt:5 }];
  f.settings.anonymizeIps = true;
  f.state.ipNames['2001:db8:0::'] = 'IPv6 office';
  assert.deepEqual(f.service.listHistory(), [
    { id:'h1', shareId:'s1', ip:'2001:db8:0::', startedAt:5, ipName:'IPv6 office' },
  ]);
  assert.deepEqual(f.service.historyMeta(), { count:1, latestId:'h1', latestAt:5, viewRevision:0 });
});

test('activity numeric sanitation never serializes non-finite byte counts', () => {
  const f = fixture();
  assert.equal(f.service.sanitizeActivityEvent({ id:'aaaa', bytes:Infinity }).bytes, 0);
  assert.equal(f.service.sanitizeActivityEvent({ id:'bbbb', bytes:'NaN' }).bytes, 0);
  assert.equal(f.service.sanitizeActivityEvent({ id:'cccc', bytes:Number.MAX_VALUE }).bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(f.service.sanitizeActivityEvent({ id:'dddd', bytes:-1 }).bytes, 0);
});

test('batch activity projection snapshots trash and PWA devices once instead of once per event', () => {
  const f = fixture();
  f.state.trash.push({ share:{ id:'gone', name:'Deleted link', type:'file' } });
  f.devices.push({ id:'dev1', name:'Pixel' });
  const events = [
    { id:'e001', kind:'audit', shareId:'gone', deviceId:'dev1', actor:'PWA: Pixel' },
    { id:'e002', kind:'audit', shareId:'gone', deviceId:'dev1', actor:'PWA: Pixel' },
  ];
  const rows = f.service.activityEventsForClient(events);
  assert.equal(f.counters.trashReads, 1);
  assert.equal(f.counters.deviceReads, 1);
  assert.equal(rows[0].shareName, 'Deleted link');
  assert.equal(rows[0].deviceName, 'Pixel');
  assert.equal(rows[1].shareName, 'Deleted link');
});

test('activity SSE fails closed before emitting a snapshot when the session is already invalid', () => {
  const f = fixture();
  f.state.activityLog = [{ id:'e001', at:1, kind:'audit', name:'secret', status:'secret' }];
  const res = response();
  const client = f.service.openLiveActivityStream(res, 'missing', 500);
  assert.equal(client, null);
  assert.equal(res.statusCode, 403);
  assert.equal(res.writableEnded, true);
  assert.equal(res.chunks.length, 0, 'invalid principals must receive no activity payload');
  assert.equal(f.service.liveActivityClients.size, 0);
});

test('activity snapshots and recent payloads defensively filter ignored/corrupt rows', () => {
  const f = fixture();
  f.state.activityLog = [
    null,
    { id:'keep1', at:3, kind:'audit', name:'login', status:'login' },
    { id:'hide1', at:2, kind:'audit', name:'push-subscribed', status:'push-subscribed' },
  ];
  const recent = f.service.recentActivityPayload(500);
  assert.equal(recent.retained, 1);
  assert.equal(recent.events.length, 1);
  assert.equal(recent.events[0].id, 'keep1');
  const res = response();
  f.service.openLiveActivityStream(res, 'audit', 500);
  assert.match(res.chunks[0], /keep1/);
  assert.doesNotMatch(res.chunks[0], /hide1/);
});

test('activity SSE backpressure is bounded and catches up with one sanitized snapshot after drain', () => {
  const f = fixture();
  const res = response({ falseOnWrite:2 }); // snapshot succeeds; first live event fills the writable buffer
  const client = f.service.openLiveActivityStream(res, 'audit', 500);
  assert.ok(client);
  assert.equal(f.intervals.size, 1);
  f.service.emitLiveActivity('system', { name:'first', status:'ok' });
  assert.equal(f.service.liveActivityClients.size, 1, 'normal Node stream backpressure must not be treated as a socket failure');
  assert.equal(client.backpressured, true);
  const writesAtPressure = res.writes;
  f.service.emitLiveActivity('system', { name:'second', status:'ok' });
  assert.equal(res.writes, writesAtPressure, 'events must be coalesced while the socket is backpressured');
  assert.equal(client.needsActivitySnapshot, true);
  res.drain();
  assert.equal(client.backpressured, false);
  assert.equal(client.needsActivitySnapshot, false);
  assert.equal(f.service.liveActivityClients.size, 1);
  assert.match(res.chunks.at(-1), /event: snapshot/);
  assert.match(res.chunks.at(-1), /first/);
  assert.match(res.chunks.at(-1), /second/);
});

test('a hard activity SSE write failure drops the client and clears its heartbeat timer', () => {
  const f = fixture();
  const res = response({ throwOnWrite:2 });
  f.service.openLiveActivityStream(res, 'audit', 500);
  assert.equal(f.intervals.size, 1);
  f.service.emitLiveActivity('system', { name:'runtime', status:'ok' });
  assert.equal(f.service.liveActivityClients.size, 0);
  assert.equal(f.intervals.size, 0, 'heartbeat must not survive a failed stream');
  assert.equal(res.writableEnded, true);
});

test('presence stream never retains a client when the initial socket write throws', () => {
  const f = fixture();
  f.shares.set('s1', { id:'s1', ownerId:'a1' });
  f.transfers.set('t1', { shareId:'s1', direction:'down', notify:true });
  const res = response({ throwOnWrite:1 });
  const client = f.service.openPresenceStream(res, { seeAll:true, accountId:'a1' }, () => true);
  assert.equal(client, null);
  assert.equal(f.service.presenceClients.size, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(res.writableEnded, true);
});

test('presence SSE coalesces updates during backpressure and sends the latest state after drain', () => {
  const f = fixture();
  f.shares.set('s1', { id:'s1', ownerId:'a1' });
  f.transfers.set('t1', { shareId:'s1', direction:'down', notify:true });
  const res = response({ falseOnWrite:1 });
  const client = f.service.openPresenceStream(res, { seeAll:true, accountId:'a1' }, () => true);
  assert.ok(client);
  assert.equal(client.backpressured, true);
  assert.equal(f.service.presenceClients.size, 1);
  f.transfers.set('t2', { shareId:'s1', direction:'down', notify:true });
  f.service.schedulePresenceBroadcast();
  assert.equal(f.timeouts.size, 1);
  [...f.timeouts][0].fn();
  assert.equal(res.writes, 1, 'presence updates must not pile up writes while backpressured');
  assert.equal(client.pendingPresence, true);
  res.drain();
  assert.equal(client.backpressured, false);
  assert.equal(client.pendingPresence, false);
  assert.equal(f.service.presenceClients.size, 1);
  assert.match(res.chunks.at(-1), /"s1":2/);
});

test('presence payload cannot prototype-pollute the result object through a restored share id', () => {
  const f = fixture();
  const counts = new Map([['__proto__', 2], ['constructor', 1]]);
  const out = f.service.presencePayloadFor({ seeAll:true }, counts);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), true);
  assert.equal(out.__proto__, 2);
  assert.equal(out.constructor, 1);
});

test('closing the last presence stream cancels a pending broadcast and all heartbeat timers', () => {
  const f = fixture();
  const res = response();
  f.service.openPresenceStream(res, { seeAll:true, accountId:'a1' }, () => true);
  f.service.schedulePresenceBroadcast();
  assert.equal(f.intervals.size, 1);
  assert.equal(f.timeouts.size, 1);
  res.close();
  assert.equal(f.service.presenceClients.size, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timeouts.size, 0);
});

test('restore integration resets both activity and presence SSE state, not activity alone', () => {
  const server = read('server.js');
  const restore = read('lib/server/restore-service.js');
  const pwa = read('lib/server/pwa-routes.js');
  assert.match(server, /closeActivityPresenceStreams,/);
  assert.match(restore, /reset\('activity-presence', closeActivityPresenceStreams \|\| closeLiveActivityClients\)/);
  assert.match(pwa, /const safeVisible = sanitizeActivityLog\(visible\)/);
  assert.match(pwa, /activityEventsForClient\(safeVisible\.slice\(0, limit\)\)/);
});
