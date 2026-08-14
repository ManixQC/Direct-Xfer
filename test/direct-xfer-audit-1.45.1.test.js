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

function loadThrottle() {
  const a = server.indexOf('const sharedThrottleStates = new Map();');
  const b = server.indexOf('// Bandwidth cap tied to a time-of-day window.', a);
  assert.ok(a >= 0 && b > a);
  const code = server.slice(a, b) + '\n;globalThis.__Throttle = Throttle;';
  const ctx = { Transform, Map, Date, Number, String, Object, Array, Math, setTimeout, clearTimeout };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  return ctx.__Throttle;
}

test('a slow per-link bucket no longer consumes the slower completion time in the faster global bucket', async () => {
  const T = loadThrottle();
  const t0 = Date.now();
  let slowAt = 0, otherAt = 0;
  const slow = new T([{ key:'link:a', bps:100000 }, { key:'global-download', bps:1000000 }]);
  const other = new T([{ key:'link:b', bps:1000000 }, { key:'global-download', bps:1000000 }]);
  await Promise.all([
    new Promise((resolve, reject) => slow._transform(Buffer.alloc(10000), null, (e) => { if (e) return reject(e); slowAt = Date.now()-t0; resolve(); })),
    new Promise((resolve, reject) => other._transform(Buffer.alloc(10000), null, (e) => { if (e) return reject(e); otherAt = Date.now()-t0; resolve(); })),
  ]);
  assert.ok(slowAt >= 65, `slow link was not paced: ${slowAt}ms`);
  assert.ok(otherAt < 70, `unrelated link inherited the slow link delay: ${otherAt}ms`);
});

test('shared throttle reservations reset when a live bucket rate changes', async () => {
  const T = loadThrottle();
  const t0 = Date.now();
  const slow = new T([{ key:'link:edit', bps:1000 }]);
  const fast = new T([{ key:'link:edit', bps:100000 }]);
  const p1 = new Promise((resolve, reject) => slow._transform(Buffer.alloc(100), null, (e) => e ? reject(e) : resolve(Date.now()-t0)));
  const p2 = new Promise((resolve, reject) => fast._transform(Buffer.alloc(100), null, (e) => e ? reject(e) : resolve(Date.now()-t0)));
  const [, fastAt] = await Promise.all([p1, p2]);
  assert.ok(fastAt < 60, `new rate inherited a stale reservation: ${fastAt}ms`);
});

test('throttle accepts a live constraint resolver so long downloads react to settings windows/edits', async () => {
  const T = loadThrottle();
  let bps = 0;
  const t = new T(() => bps > 0 ? [{ key:'link:dynamic', bps }] : []);
  let started = Date.now();
  await new Promise((resolve, reject) => t._transform(Buffer.alloc(1000), null, (e) => e ? reject(e) : resolve()));
  assert.ok(Date.now()-started < 40, 'unlimited first chunk should be immediate');
  bps = 10000;
  started = Date.now();
  await new Promise((resolve, reject) => t._transform(Buffer.alloc(1000), null, (e) => e ? reject(e) : resolve()));
  assert.ok(Date.now()-started >= 65, 'new cap was not applied to the same live throttle');
  assert.match(server, /new Throttle\(\(\) => rateConstraintsForMeta\(transferMeta\)\)/);
});

test('new custom rules cannot target inactive links through a direct API payload', () => {
  const fn = server.slice(server.indexOf('function upsertCustomNotificationRule'), server.indexOf('function deleteCustomNotificationRule'));
  assert.match(fn, /!isActive\(share, Date\.now\(\)\)/);
  assert.match(fn, /error:'inactive-target'/);
  assert.match(fn, /sameExistingTarget.*enabled === false/s, 'an existing stale rule must still be disableable');
});

test('stale custom-rule targets are not mislabeled as all-links rules in either UI', () => {
  assert.match(admin, /notifications\.ruleTargetUnavailable/);
  assert.match(admin, /return row \? row\.name : t\('notifications\.ruleTargetUnavailable'\)/);
  assert.match(pwa, /notificationsRuleTargetUnavailable/);
  assert.match(pwa, /return row\?row\.name:t\('notificationsRuleTargetUnavailable'\)/);
});

test('permanent share purge removes stale alert state and album references', () => {
  const destroy = server.slice(server.indexOf('async function destroyShareManagedData'), server.indexOf('async function purgeTrashRecordById'));
  assert.match(destroy, /pruneCustomNotificationRuleStateForShareId\(sh\.id\)/);
  assert.match(destroy, /trashItems\(\)\.map/);
  assert.match(destroy, /album\.members = album\.members\.filter/);
  const prune = server.slice(server.indexOf('function pruneCustomNotificationRuleStateForShareId'), server.indexOf('function addCenterNotification'));
  assert.match(prune, /rule\.shareId.*=== id/s);
  assert.match(prune, /delete rule\.triggered\[id\]/);
});

test('PWA bulk revoke uses recoverable trash instead of metadata-only removal', () => {
  const bulk = server.slice(server.indexOf("app.post('/app/images/bulk'"), server.indexOf('function canManagePwaAlbum'));
  assert.match(bulk, /softDeleteShare\(share\.id, req, false(?:,|\))/);
  assert.doesNotMatch(bulk, /removeShare\(share\.id/);
});

test('image retention really deletes managed bytes before claiming bytesFreed', () => {
  const fn = server.slice(server.indexOf('async function runPwaImageRetentionForOwner'), server.indexOf('async function runAllPwaImageRetention'));
  assert.match(fn, /detachActiveShare\(photo\)/);
  assert.match(fn, /await destroyShareManagedData\(photo\)/);
  assert.match(fn, /bytesFreed \+= bytes/);
});

test('device share revocation uses trash so revoked-device links remain recoverable', () => {
  const fn = server.slice(server.indexOf("app.post('/app/device/revoke'"), server.indexOf('// A paired device can always revoke itself'));
  assert.match(fn, /softDeleteShare\(shareId, req, false(?:,|\))/);
});

test('image retention storage accounting includes adaptive variants and version snapshots', () => {
  const fn = server.slice(server.indexOf('function photoManagedBytes'), server.indexOf('async function runPwaImageRetentionForOwner'));
  assert.match(fn, /photoAdaptivePath\(photo\.token, 'webp'\)/);
  assert.match(fn, /photoAdaptivePath\(photo\.token, 'avif'\)/);
  assert.match(fn, /photoVersionDir\(photo && photo\.token\)/);
  assert.match(fn, /fs\.readdirSync\(dir, \{ withFileTypes:true \}\)/);
});
