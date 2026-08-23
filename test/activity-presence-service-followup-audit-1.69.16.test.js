'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createActivityPresenceService } = require('../lib/server/activity-presence-service');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

function fixture(overrides = {}) {
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
    getTrashItems:() => state.trash,
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
  }
  status(code) { this.statusCode = code; return this; }
  setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; }
  flushHeaders() {}
  write(value) { this.chunks.push(String(value)); return true; }
  end() { this.writableEnded = true; this.emit('finish'); }
}

test('IP anonymization covers socket-address forms and fails closed for malformed restored values', () => {
  const f = fixture();
  assert.equal(f.service.maskIp('203.0.113.42:443'), '203.0.113.x');
  assert.equal(f.service.maskIp('[2001:db8::1]:443'), '2001:db8:0::');
  assert.equal(f.service.maskIp('[fe80::1234%eth0]:55750'), 'fe80:0:0::');
  assert.equal(f.service.maskIp('203.0.113.x'), '203.0.113.x', 'already masked values must remain idempotent');

  const malformed = '203.0.113.42:not-a-port';
  const masked = f.service.maskIp(malformed);
  assert.match(masked, /^anon-[0-9a-f]{12}$/);
  assert.notEqual(masked, malformed, 'anonymization must never echo malformed address-like data verbatim');
  assert.equal(f.service.maskIp(masked), masked, 'fallback pseudonyms must remain stable when projected twice');
});

test('activity byte sanitation produces bounded integer byte counts', () => {
  const f = fixture();
  assert.equal(f.service.sanitizeActivityEvent({ id:'frac', bytes:12.9 }).bytes, 12);
  assert.equal(f.service.sanitizeActivityEvent({ id:'huge', bytes:Number.MAX_VALUE }).bytes, Number.MAX_SAFE_INTEGER);
});

test('presence session validators snapshot the privilege set so a see-all stream fails closed after downgrade', () => {
  let currentRole = 'admin';
  const f = fixture({
    isSessionActive(_sid, roles) { return Array.isArray(roles) && roles.includes(currentRole); },
  });
  const validateSeeAll = f.service.presenceSessionValidator('sid-1', ['owner', 'admin', 'auditor']);
  assert.equal(validateSeeAll(), true);
  currentRole = 'operator';
  assert.equal(validateSeeAll(), false, 'a downgraded operator must not retain a see-all presence stream');

  const callerRoles = ['owner', 'admin'];
  const snapshotted = f.service.presenceSessionValidator('sid-2', callerRoles);
  callerRoles.push('operator');
  assert.equal(snapshotted(), false, 'caller mutation must not widen the validator after creation');
});

test('SSE response error/finish events clean activity and presence timers immediately', () => {
  const f = fixture();
  const activityRes = new FakeResponse();
  const activity = f.service.openLiveActivityStream(activityRes, 'sid-1');
  assert.ok(activity);
  assert.equal(f.service.liveActivityClients.size, 1);
  assert.equal(f.intervals.size, 1);
  activityRes.emit('error', new Error('socket-reset'));
  assert.equal(f.service.liveActivityClients.size, 0);
  assert.equal(f.intervals.size, 0);

  const presenceRes = new FakeResponse();
  const presence = f.service.openPresenceStream(presenceRes, { seeAll:true, accountId:'a1' }, () => true);
  assert.ok(presence);
  assert.equal(f.service.presenceClients.size, 1);
  assert.equal(f.intervals.size, 1);
  presenceRes.emit('finish');
  assert.equal(f.service.presenceClients.size, 0);
  assert.equal(f.intervals.size, 0);
});

test('routes and lifecycle preserve the privilege scope and delegate shutdown cleanup to the owning service', () => {
  const dashboard = read('lib/server/admin-dashboard-routes.js');
  const pwaEvents = read('lib/server/pwa-event-service.js');
  const lifecycle = read('lib/server/lifecycle-service.js');
  const server = read('server.js');
  const httpComposition = read('lib/server/http-pwa-lifecycle-application.js');

  assert.match(dashboard, /seeAll \? \['owner', 'admin', 'auditor'\] : \['owner', 'admin', 'operator', 'auditor'\]/);
  assert.match(dashboard, /presenceSessionValidator\(req\.session\.sid, streamRoles\)/);
  assert.match(pwaEvents, /scope && scope\.seeAll \? \['owner', 'admin', 'auditor'\]/);
  assert.match(pwaEvents, /presenceSessionValidator\(req\.pwaSession\.sid, streamRoles\)/);
  assert.match(lifecycle, /if \(hasActivityPresenceCloser\) \{[\s\S]*closeActivityPresenceStreams\(\);[\s\S]*ownerCleanupSucceeded = true/);
  assert.match(httpComposition, /flushNow,\s*closeActivityPresenceStreams,\s*liveActivityClients:/);
});
