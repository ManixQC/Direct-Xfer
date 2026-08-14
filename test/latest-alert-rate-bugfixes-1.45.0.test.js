const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Transform } = require('node:stream');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const admin = read('public/app.js');
const pwa = read('pwa/app.js');

test('custom alert rules stay one-shot when a metric falls below the threshold', () => {
  const fn = server.slice(server.indexOf('function evaluateCustomNotificationRulesForShare'), server.indexOf('function addAdminCenterNotification'));
  assert.match(fn, /if \(value < rule\.threshold\) continue;/);
  assert.doesNotMatch(fn, /delete rule\.triggered\[key\]/);
  assert.match(server, /CUSTOM_NOTIFICATION_RULE_TRIGGER_MAX = 5000/);
});

test('custom rule creation is idempotent and stale explicit IDs cannot recreate deleted rules', () => {
  assert.match(server, /if \(requestedId && !rule\) return \{ error:'rule-not-found' \}/);
  assert.match(server, /const duplicate = rules\.find/);
  assert.match(server, /return \{ rule:publicCustomNotificationRule\(duplicate\), duplicate:true \}/);
  assert.match(server, /result\.error === 'rule-not-found' \? 404/);
});

test('rule target pickers and periodic scans ignore inactive historical links', () => {
  assert.match(server, /listShares\(\)\.filter\(\(share\) => share && !share\.revoked && isActive\(share, now\)/);
  assert.match(server, /if \(isActive\(s, now\)\) evaluateCustomNotificationRulesForShare\(s\)/);
});

test('per-link rate values are validated consistently instead of malformed input disabling the cap', () => {
  assert.match(server, /function parseLinkRateKBps\(v, \{ optional = false \} = \{\}\)/);
  assert.match(server, /!Number\.isFinite\(n\) \|\| !Number\.isInteger\(n\) \|\| n < 0/);
  assert.match(server, /error:'invalid-rate'/);
  assert.match(admin, /Number\.isFinite\(rateKBps\).*Number\.isInteger\(rateKBps\).*rateKBps < 0/s);
  assert.match(pwa, /Number\.isFinite\(next\).*Number\.isInteger\(next\).*next<0/s);
});

test('shared throttle serializes chunks that share the same link bucket', async () => {
  const a = server.indexOf('const sharedThrottleStates = new Map();');
  const b = server.indexOf('// Bandwidth cap tied to a time-of-day window.', a);
  assert.ok(a >= 0 && b > a);
  const code = server.slice(a, b) + '\n;globalThis.__Throttle = Throttle;';
  const ctx = { Transform, Map, Date, Number, String, setTimeout, clearTimeout };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const T = ctx.__Throttle;
  const t0 = Date.now();
  const times = [];
  const one = new T([{ key:'link:x', bps:100000 }]);
  const two = new T([{ key:'link:x', bps:100000 }]);
  await Promise.all([
    new Promise((resolve, reject) => one._transform(Buffer.alloc(10000), null, (e) => { if(e)return reject(e); times.push(Date.now()-t0); resolve(); })),
    new Promise((resolve, reject) => two._transform(Buffer.alloc(10000), null, (e) => { if(e)return reject(e); times.push(Date.now()-t0); resolve(); })),
  ]);
  times.sort((x,y)=>x-y);
  assert.ok(times[0] >= 60, `first chunk was not paced: ${times}`);
  assert.ok(times[1] - times[0] >= 60, `parallel chunks were not aggregated: ${times}`);
});

test('global and scheduled constraints use shared server-wide buckets', () => {
  assert.match(server, /key:'global-download'/);
  assert.match(server, /key:'scheduled-download'/);
  assert.match(server, /new Throttle\(\(\) => rateConstraintsForMeta\(transferMeta\)\)/);
});
