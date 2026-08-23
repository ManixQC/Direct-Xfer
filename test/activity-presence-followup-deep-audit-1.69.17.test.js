'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createActivityPresenceService } = require('../lib/server/activity-presence-service');
const { createPwaEventService } = require('../lib/server/pwa-event-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function activityFixture(overrides = {}) {
  const state = { history:[], activityLog:[], ipNames:{}, trash:[] };
  const settings = { anonymizeIps:true, keepIpNames:true };
  const transfers = new Map();
  const intervals = new Set();
  const timeouts = new Set();
  const service = createActivityPresenceService({
    crypto,
    getState:() => state,
    getSettings:() => settings,
    scheduleFlush:() => {},
    getShareById:() => null,
    getTrashItems:() => [],
    getPwaDevices:() => [],
    isSessionActive:() => true,
    getActiveTransfers:() => transfers,
    setIntervalRef(fn, ms) { const timer={ fn, ms, unref(){} }; intervals.add(timer); return timer; },
    clearIntervalRef(timer) { intervals.delete(timer); },
    setTimeoutRef(fn, ms) { const timer={ fn, ms, unref(){} }; timeouts.add(timer); return timer; },
    clearTimeoutRef(timer) { timeouts.delete(timer); },
    ...overrides,
  });
  return { service, state, settings, transfers, intervals, timeouts };
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
    this.headersSent = false;
  }
  status(code) { this.statusCode = code; return this; }
  setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; }
  flushHeaders() { this.headersSent = true; }
  write(value) { this.chunks.push(String(value)); return true; }
  end() { if (this.writableEnded) return; this.writableEnded = true; this.emit('finish'); }
}

test('hexadecimal IPv4-mapped IPv6 canonicalizes to the same masked IPv4 identity as dotted notation', () => {
  const f = activityFixture();
  const expected = '203.0.113.x';
  assert.equal(f.service.maskIp('::ffff:203.0.113.42'), expected);
  assert.equal(f.service.maskIp('::ffff:cb00:712a'), expected);
  assert.equal(f.service.maskIp('[::ffff:cb00:712a]:443'), expected);
});

test('presence session validator rejects empty/unknown role policies instead of delegating an ambiguous role list', () => {
  const calls = [];
  const f = activityFixture({
    isSessionActive(sid, roles) { calls.push({ sid, roles }); return true; },
  });
  assert.equal(f.service.presenceSessionValidator('sid', [])(), false);
  assert.equal(f.service.presenceSessionValidator('sid', ['bogus'])(), false);
  assert.equal(calls.length, 0, 'invalid policies must fail before session authorization is invoked');
  assert.equal(f.service.presenceSessionValidator('sid', ['admin', 'admin'])(), true);
  assert.deepEqual(calls[0], { sid:'sid', roles:['admin'] });
});

test('paired PWA see-all presence stream loses authorization when its delegating account is downgraded', () => {
  const account = { id:'acc-1', username:'alice', role:'admin' };
  const device = { id:'dev-1', createdByAccountId:'acc-1' };
  const eventService = createPwaEventService({
    pwaDevices:() => [device],
    pwaDeviceCreatorAccount:() => account,
    pwaDeviceResolvedAccount:() => account,
    getAccountById:(id) => String(id) === account.id ? account : null,
    presenceSessionValidator:() => () => true,
  });
  const req = { pwaDevice:device };
  const scope = eventService.pwaPresenceScope(req);
  assert.deepEqual(scope, { seeAll:true, accountId:'acc-1' });
  const validate = eventService.pwaPresenceValidator(req, scope);
  assert.equal(validate(), true);
  account.role = 'operator';
  assert.equal(validate(), false, 'an already-open global stream must close after owner/admin -> operator downgrade');
});

test('paired PWA operator presence stream remains account-scoped and rejects roles not allowed for paired-device presence', () => {
  const account = { id:'acc-2', username:'bob', role:'operator' };
  const device = { id:'dev-2', createdByAccountId:'acc-2' };
  const eventService = createPwaEventService({
    pwaDevices:() => [device],
    pwaDeviceCreatorAccount:() => account,
    pwaDeviceResolvedAccount:() => account,
    getAccountById:(id) => String(id) === account.id ? account : null,
    presenceSessionValidator:() => () => true,
  });
  const req = { pwaDevice:device };
  const scope = eventService.pwaPresenceScope(req);
  assert.deepEqual(scope, { seeAll:false, accountId:'acc-2' });
  const validate = eventService.pwaPresenceValidator(req, scope);
  assert.equal(validate(), true);
  account.role = 'auditor';
  assert.equal(validate(), false);
});

test('SSE cleanup is idempotent across finish, close and error notifications', () => {
  const f = activityFixture();
  const res = new FakeResponse();
  const client = f.service.openPresenceStream(res, { seeAll:true, accountId:'a1' }, () => true);
  assert.ok(client);
  assert.equal(f.service.presenceClients.size, 1);
  assert.equal(f.intervals.size, 1);
  res.emit('finish');
  res.emit('close');
  res.emit('error', new Error('after-finish'));
  assert.equal(f.service.presenceClients.size, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(client.closed, true);
  assert.equal(client.backpressured, false);
  assert.equal(client.pendingPresence, false);
});

test('lifecycle keeps a legacy cleanup fallback when the service-owned closer throws', () => {
  const lifecycle = read('lib/server/lifecycle-service.js');
  assert.match(lifecycle, /let ownerCleanupSucceeded = false/);
  assert.match(lifecycle, /catch \(error\) \{\s*try \{ if \(typeof consoleRef\.warn === 'function'\) consoleRef\.warn\('\[server\] activity\/presence stream cleanup failed:'/);
  assert.match(lifecycle, /if \(!ownerCleanupSucceeded\) closeLegacyActivityPresenceRegistries\(\)/);
});
