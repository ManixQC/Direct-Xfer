const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');

function slice(a, b) {
  const i = server.indexOf(a), j = server.indexOf(b, i + a.length);
  assert.ok(i >= 0, `missing start: ${a}`);
  assert.ok(j > i, `missing end: ${b}`);
  return server.slice(i, j);
}

test('inbox retention excludes upload/moderation staging and releases logical quota only after unlink', () => {
  const fn = slice('function purgeOldInbox()', '// Per-file expiry (PWA');
  assert.match(fn, /e\.name === '\.dxparts' \|\| e\.name === '\.dxpending'/);
  assert.match(fn, /fs\.unlinkSync\(p\)/);
  assert.match(fn, /releaseReceptionManagedBytes\(p, bytes\)/);
});

test('self-destruct retention keeps metadata when disk unlink fails', () => {
  const fn = slice('function purgeExpiredFiles()', '// --- Scheduled backup');
  assert.match(fn, /Keep the timer when deletion fails/);
  assert.match(fn, /continue;/);
  assert.match(fn, /releaseReceptionManagedBytes/);
});

test('PWA session and device principals must resolve to the same account', () => {
  assert.match(server, /function samePwaAccount\(session, device\)/);
  const guard = slice('function pwaNetworkGuard', 'function pwaHttpsInstallUrl');
  assert.match(guard, /samePwaAccount\(session, device\)/);
  const auth = slice('function requireAppAuth', 'function pwaNotificationAccountId');
  assert.match(auth, /samePwaAccount/);
});

test('deleted accounts revoke PWA capabilities and account deletion rolls back on store failure', () => {
  const fn = slice("adminRouter.delete('/accounts/:id'", "// Inspect and clear active anomaly blocks");
  assert.match(fn, /beforeState = JSON\.parse\(JSON\.stringify\(state\)\)/);
  assert.match(fn, /revokePwaCapabilitiesForAccount\(acc\)/);
  assert.match(fn, /if \(!persistNow\(\)\)/);
  assert.match(fn, /state = beforeState/);
});

test('Web Push is account scoped rather than broadcast to every subscription', () => {
  assert.match(server, /function pushSubscriptionsForAccountIds/);
  const pushTest = slice("adminRouter.post('/push/test'", '// --- Scheduled backup');
  assert.match(pushTest, /pushSubscriptionsForAccountIds\(\[req\.session\.accountId\]\)/);
  assert.match(server, /pushSubAccountIds/);
});

test('backup v3 includes audit chain and restore stages external artifacts before commit', () => {
  assert.match(server, /kind:\s*'dxbackup',\s*v:\s*3/);
  assert.match(server, /function restoredAuditEntries/);
  assert.match(server, /function replaceAuditChainForRestore/);
  assert.match(server, /function stageRestoreSecrets/);
  const restore = slice('function applyRestore(bundle)', 'function purgeExpiredSecrets()');
  assert.match(restore, /journalStage/);
  assert.match(restore, /rollbackRestoreSecrets/);
  assert.match(restore, /restoreFileSnapshot\(AUDIT_CHAIN_FILE/);
});

test('burn-after-read secret is not served until ciphertext deletion succeeds', () => {
  const destroy = slice('function destroySecret(token)', "downloadRouter.get('/x/:token'");
  assert.match(destroy, /fs\.unlinkSync/);
  assert.match(destroy, /return false/);
  const blob = slice("downloadRouter.get('/x/:token/blob'", '// Delete a file/subfolder from the collab folder');
  assert.match(blob, /burn-failed/);
  assert.match(blob, /destroySecret/);
});

test('secret creation removes ciphertext when metadata cannot be persisted', () => {
  const fn = slice("adminRouter.post('/secret'", '// QR code (SVG) for a link');
  assert.match(fn, /if \(!persistNow\(\)\)/);
  assert.match(fn, /fs\.unlinkSync\(dest\)/);
});

test('manifest generation and directory listings revalidate real paths against symlink swaps', () => {
  const manifest = slice('async function shareManifestFiles', '// Streams one image');
  assert.match(manifest, /assertRealWithin\(HOST_ROOT/);
  const list = slice('async function listDir', "downloadRouter.get('/s/:token'");
  assert.match(list, /assertRealWithin\(realRoot, candidate\)/);
});

test('an existing corrupt plaintext store aborts startup instead of becoming an empty state', () => {
  const fn = slice('function storeLoad()', 'function persist()');
  assert.match(fn, /INVALID_STORE/);
  assert.match(fn, /process\.exit\(1\)/);
});

test('critical auth mutations roll back when durable persistence fails', () => {
  const pw = slice('function setAccountPassword', '// --- Optional TOTP');
  assert.match(pw, /previousAh/);
  assert.match(pw, /if \(persistNow\(\)\) return true/);
  const routes = slice("adminRouter.post('/2fa/setup'", '// ---- Account management');
  assert.match(routes, /write-error/);
  assert.match(routes, /previousTotp/);
  const create = slice("adminRouter.post('/accounts'", "adminRouter.post('/accounts/:id/password'");
  assert.match(create, /accounts\.splice\(accounts\.indexOf\(acc\), 1\)/);
});

test('settings and notification preferences do not ACK RAM-only mutations', () => {
  assert.match(server, /function setSettingsDurable/);
  const settings = slice("adminRouter.post('/settings'", '// Export the current configuration');
  assert.match(settings, /status\(503\)/);
  const prefs = slice('function setAccountMutedNotificationCategories', '// Account-scoped custom notification rules.');
  assert.match(prefs, /previous/);
  assert.match(prefs, /return null/);
});

test('custom notification rules roll back their account state on persistence failure', () => {
  const fn = slice('function upsertCustomNotificationRule', 'function pruneCustomNotificationRuleStateForShareId');
  assert.match(fn, /beforeRules/);
  assert.match(fn, /error:'write-error'/);
  assert.match(fn, /acc\.notificationRules = beforeRules/);
});

test('config import cannot import arbitrary encrypted blob paths and replace mode keeps old links recoverable', () => {
  const fn = slice("adminRouter.post('/shares/import'", '// Resolves one host path');
  assert.match(fn, /delete rec\.encPath/);
  assert.match(fn, /delete rec\.containerPath/);
  assert.match(fn, /trashItems\(\)\.unshift/);
  assert.match(fn, /state = beforeState/);
});

test('PWA device credentials are persisted before cookies are issued', () => {
  const fn = slice('function createPwaDevice', '// One-time QR pairing tickets');
  assert.match(fn, /if \(!persistNow\(\)\)/);
  assert.match(fn, /return null/);
  assert.match(fn, /setPwaDeviceCookie/);
});

test('PWA device revoke is durable before its credential cookie is cleared', () => {
  const fn = slice("app.post('/app/device/revoke'", '// Rename a paired device');
  assert.match(fn, /beforeState/);
  assert.match(fn, /if \(!persistNow\(\)\)/);
  assert.ok(fn.indexOf('persistNow()') < fn.indexOf('clearPwaDeviceCookie'), 'cookie was cleared before durable revocation');
});

test('manual trash restore rolls back to trash on store failure', () => {
  const fn = slice("adminRouter.post('/trash/:id/restore'", "adminRouter.delete('/trash/:id'");
  assert.match(fn, /original=JSON\.parse/);
  assert.match(fn, /detachActiveShare\(sh\)/);
  assert.match(fn, /status\(503\)/);
});

test('photo replacement persists new metadata before deleting old managed files', () => {
  const std = slice("adminRouter.post('/photos/:id/replace'", '// Streams one image selected');
  assert.ok(std.indexOf('persistNow()') < std.indexOf('unlinkManagedPathsStrict(oldManagedPaths)'), 'standard replacement deletes old bytes before commit');
  assert.match(std, /Object\.assign\(s, before\)/);
  const pwa = slice("app.post('/app/image/:token/replace'", "app.post('/app/image/:token/adaptive");
  assert.ok(pwa.indexOf('persistNow()') < pwa.indexOf('unlinkManagedPathsStrict(oldManagedPaths)'), 'PWA replacement deletes old bytes before commit');
  assert.match(pwa, /Object\.assign\(photo, before\)/);
});

test('photo version trimming preserves the original marker and defers physical deletion until after persistence', () => {
  const fn = slice('function archiveCurrentPhotoVersion', 'function cleanupPhotoVersionStorage');
  assert.match(fn, /ensurePhotoOriginalVersionMarker\(photo\)/);
  assert.match(fn, /if \(photo\.versions\[removeIndex\] && photo\.versions\[removeIndex\]\.original\) removeIndex -= 1/);
  assert.match(fn, /photo\.versions\.splice\(removeIndex, 1\)/);
  const trim = fn.slice(fn.indexOf('while (photo.versions.length > 10)'));
  assert.doesNotMatch(trim, /fs\.rmSync/);
  const cleanup = slice('function cleanupPhotoVersionStorage', 'function restorePhotoVersion');
  assert.match(cleanup, /fs\.rmSync/);
});

test('legacy direct destructive removeShare helper is gone', () => {
  assert.doesNotMatch(server, /function removeShare\s*\(/);
});


test('photo version restore commits metadata before deleting the live image and rolls back on write failure', () => {
  const helper = slice('function restorePhotoVersion', "app.get('/app/image/:token/versions'");
  assert.match(helper, /oldManagedPaths/);
  assert.doesNotMatch(helper, /unlinkPhotoFiles\(/);
  const route = slice("app.post('/app/image/:token/restore/:versionId'", "app.post('/app/image/:token/replace'");
  assert.match(route, /if \(!persistNow\(\)\)/);
  assert.match(route, /Object\.assign\(photo, tx\.before\)/);
  assert.ok(route.indexOf('persistNow()') < route.indexOf('unlinkManagedPathsStrict(tx.oldManagedPaths)'), 'restore deletes old bytes before commit');
});


test('destructive purge and album removal do not report success before durable persistence', () => {
  const albumRemove = slice("downloadRouter.post('/g/:token/c/:secret/remove/:imageToken'", "// Rendered preview");
  assert.match(albumRemove, /if \(!persistNow\(\)\) return res\.status\(503\)/);
  const trash = slice("adminRouter.delete('/trash/:id'", "// Detailed statistics for one active share");
  assert.match(trash, /if\(!persistNow\(\)\)return res\.status\(503\)/);
  assert.match(trash, /persisted:false/);
});

test('PWA retention and adaptive variants surface durable-store failures', () => {
  const retention = slice('async function runPwaImageRetentionForOwner', "app.get('/app/images/dashboard'");
  assert.match(retention, /persisted = persistNow\(\)/);
  assert.match(retention, /result\.persisted === false/);
  const route = slice("app.post('/app/image/:token/adaptive/:format'", "app.post('/app/image',");
  assert.match(route, /handlePhotoAdaptiveUpload\(req,res,photo,fmt/);
  const adaptive = slice('function handlePhotoAdaptiveUpload', "adminRouter.post('/photos/:id/thumb'");
  assert.match(adaptive, /if\(!persistNow\(\)\)/);
  assert.match(adaptive, /res\.status\(503\)/);
  assert.match(adaptive, /restorePlainObject\(s,before\)/);
});
