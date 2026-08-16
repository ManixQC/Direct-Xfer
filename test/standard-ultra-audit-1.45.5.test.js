const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const app = read('public/app.js');
const vault = read('public/login-vault.js');

function between(src, start, end) {
  const i = src.indexOf(start), j = src.indexOf(end, i + start.length);
  assert.ok(i >= 0, `missing start: ${start}`);
  assert.ok(j > i, `missing end: ${end}`);
  return src.slice(i, j);
}

test('standard login vault and API client are bounded and recoverable', () => {
  assert.match(vault, /Login vault open timed out/);
  assert.match(vault, /Login vault transaction timed out/);
  assert.match(vault, /}, 3000\);/);
  assert.match(vault, /}, 4000\);/);
  assert.match(app, /function fetchWithTimeout\(/);
  assert.match(app, /function settleWithin\(/);
  const api = between(app, 'async function api(', '// ------------------------------------------------------------------\n// Views');
  assert.match(api, /fetchWithTimeout/);
  assert.match(app, /settleWithin\(persistRememberedAdminLogin/);
});

test('account switches invalidate old responses and clear authenticated DOM state', () => {
  assert.match(app, /authEpoch:\s*0/);
  assert.match(app, /requestAuthEpoch !== state\.authEpoch/);
  const clear = between(app, 'function clearAuthenticatedClientState()', 'function showLogin()');
  assert.match(clear, /querySelectorAll\('\.overlay'\)/);
  assert.match(clear, /state\.allShares = \[\]/);
  assert.match(clear, /state\.activitySource\.close/);
  const refresh = between(app, 'async function refreshShares()', 'function updateLiveDot()');
  assert.match(refresh, /if \(e\.message === 'stale-auth'\) return/);
});

test('share polling is coalesced and folder logical sizes refresh outside the request path', () => {
  assert.match(app, /sharesRefreshPromise/);
  assert.match(app, /sharesRefreshPending/);
  assert.match(server, /function queueShareLogicalBytesRefresh/);
  const shares = between(server, "adminRouter.get('/shares'", "adminRouter.get('/history'");
  assert.match(shares, /void mapLimit\(logicalSizeCandidates, 2, \(s\) => queueShareLogicalBytesRefresh\(s\)\)/);
});

test('operators cannot read global settings and their polling settings are infrastructure-redacted', () => {
  const settings = between(server, 'function settingsForClient(req, lite)', 'storeLoad();');
  assert.match(settings, /if \(role === 'operator'\)/);
  assert.match(settings, /'adminAllowedIps'/);
  assert.match(settings, /'backupLocalDir'/);
  assert.match(server, /adminRouter\.get\('\/settings',[\s\S]*?role === 'operator'[\s\S]*?status\(403\)/);
});

test('admin allowlist and safety limits fail closed on invalid values', () => {
  const fn = between(server, 'function computeSettingsPatch(body)', "adminRouter.post('/settings'");
  assert.match(fn, /error:'invalid-limit'/);
  assert.match(fn, /error:'invalid-admin-ip'/);
  assert.match(fn, /prefix < 0 \|\| prefix > 32/);
});

test('standard share creation and mutations require durable persistence', () => {
  assert.match(server, /function addShareDurable/);
  const patch = between(server, "adminRouter.patch('/shares/:id'", "adminRouter.post('/shares/bulk'");
  assert.match(patch, /const s = JSON\.parse\(JSON\.stringify\(live\)\)/);
  assert.match(patch, /if \(!persistNow\(\)\)/);
  const bulk = between(server, "adminRouter.post('/shares/bulk'", "adminRouter.post('/shares/:id/items'");
  assert.match(bulk, /beforeState/);
  assert.match(bulk, /const commitBulk = \(\) => \{ if \(persistNow\(\)\) return true; rollbackBulk\(\); return false; \};/);
});

test('standard Images full replacement and variants are serialized and durable', () => {
  assert.match(server, /const adminPhotoFullWrites = new Set\(\)/);
  assert.match(server, /function handleAdminPhotoVariantUpload/);
  const replace = between(server, "adminRouter.post('/photos/:id/replace'", '// Streams one image selected');
  assert.match(replace, /adminPhotoHasVariantWrite/);
  assert.match(replace, /if \(!persistNow\(\)\)/);
  assert.ok(replace.indexOf('persistNow()') < replace.indexOf('unlinkManagedPathsStrict(oldManagedPaths)'), 'old bytes removed before durable metadata commit');
});

test('client-side Images CSV protects against spreadsheet formula injection', () => {
  const fn = between(app, 'function exportPhotos(fmt)', "if ($('photos-search'))");
  assert.match(fn, /\^\[=\+\\-@\\t\\r\]/);
  assert.match(fn, /str = "'" \+ str/);
});

test('notification personal mutations roll back and stale public links are not offered', () => {
  const readFn = between(server, 'function markNotificationsReadForAccount', 'function deleteNotificationForAccount');
  assert.match(readFn, /persistNow/);
  assert.match(readFn, /previous/);
  const urlFn = between(server, 'function notificationLinkUrlForRequest', 'function notificationsForAccount');
  assert.match(urlFn, /!share \|\| !isActive\(share\)/);
  assert.match(urlFn, /notificationAccountIdForShare/);
  assert.match(app, /sharesLoaded:\s*false/);
  assert.match(app, /!state\.sharesLoaded && n && n\.linkUrl/);
});

test('manual moderation and direct reception accounting persist before external effects', () => {
  assert.match(server, /function stagePendingFileRemoval/);
  assert.match(server, /function applyReceptionAccountingState/);
  assert.match(server, /function rollbackReceptionAccountingState/);
  const approval = between(server, "adminRouter.post('/pending/:id/approve'", "adminRouter.post('/pending/:id/reject'");
  assert.match(approval, /if \(!persistNow\(\)\)/);
  assert.match(approval, /finalizePendingModerationApproval/);
});

test('public visitor message/access flows snapshot anti-abuse state and duplicate retries reuse pending requests', () => {
  assert.match(server, /function snapshotPublicMessageDecision/);
  assert.match(server, /function restorePublicMessageDecision/);
  const access = between(server, "downloadRouter.post('/s/:token/request-access'", "downloadRouter.post('/s/:token/feedback'");
  assert.match(access, /existing/);
  assert.match(access, /pending/);
  assert.match(access, /persistNow/);
});

test('transfer-history purge stages the journal and rolls back on failed persistence', () => {
  const fn = between(server, "adminRouter.delete('/history'", "adminRouter.post('/shutdown'");
  assert.match(fn, /renameSync/);
  assert.match(fn, /if \(!persistNow\(\)\)/);
  assert.match(fn, /journal rollback failed/);
});

test('dashboard startup does not wait for network diagnostics', () => {
  const init = between(app, 'async function init()', 'document.addEventListener');
  assert.match(init, /startNotificationsPolling\(\)/);
  assert.match(init, /startPolling\(\)/);
  assert.match(init, /void loadNetwork\(\)/);
  assert.doesNotMatch(init, /await loadNetwork\(\)/);
});

test('release is 1.51.2 with refreshed companion shell', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.62.4');
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa308'/);
  assert.doesNotMatch(read('pwa/index.html'), /v=205/);
});
