'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const server = read('server.js');
const pub = read('public/app.js');
const pubHtml = read('public/index.html');
const pubCss = read('public/style.css');
const pwa = read('pwa/app.js');
const pwaHtml = read('pwa/index.html');
const pwaCss = read('pwa/app.css');
const sw = read('pwa/sw.js');

test('22: PWA transfer state persists recovery checkpoints for reopen/background resume', () => {
  for (const token of ['lastCheckpointAt','lastServerOffset','recoveryAttempts','recoveredAt','recoveryReason','checkpointActiveTransfers']) assert.ok(pwa.includes(token), token);
  assert.match(pwa, /setInterval\([^]*checkpointActiveTransfers/);
  assert.match(sw, /lastCheckpointAt/);
  assert.match(sw, /recoveryReason/);
});

test('23: Background Sync diagnostic reports support, registration, permission and failures', () => {
  assert.match(pwaHtml, /id="background-sync-status"/);
  assert.match(pwaHtml, /id="background-sync-refresh"/);
  assert.match(pwaHtml, /id="background-sync-run"/);
  assert.match(pwa, /refreshBackgroundSyncDiagnostic/);
  assert.match(pwa, /periodic-background-sync/);
  assert.match(pwa, /bgSyncPermission/);
  assert.match(pwa, /backgroundFailedAt/);
});

test('24: PWA settings expose an installation-state diagnostic', () => {
  assert.match(pwaHtml, /id="pwa-install-diagnostic"/);
  assert.match(pwa, /refreshPwaInstallDiagnostic/);
  assert.match(pwa, /getInstalledRelatedApps/);
  assert.match(pwa, /\/pwa\/install-state/);
  assert.match(pwa, /isStandaloneApp\(\)/);
});

test('25: passkeys expose linked devices and support per-device revocation', () => {
  assert.match(server, /const devices = deviceIds\.map/);
  assert.match(server, /DELETE'?,?\s*\/app\/webauthn\/passkeys\/|app\.delete\('\/app\/webauthn\/passkeys\/:id\/devices\/:deviceId'/);
  assert.match(server, /unbindPasskeyDevice/);
  assert.match(pwa, /passkey-device-list/);
  assert.match(pwa, /removePasskeyDevice/);
  assert.match(pwaCss, /\.passkey-device-row/);
});

test('27: long operations have visible step/progress feedback with a stale-operation timeout', () => {
  assert.match(pwaHtml, /id="long-operation"/);
  assert.match(pwaHtml, /id="long-operation-progress"/);
  assert.match(pwa, /beginLongOperation/);
  assert.match(pwa, /updateLongOperation/);
  assert.match(pwa, /longOpDlp/);
  assert.match(pwa, /longOpHash/);
  assert.match(pwa, /longOpOcr/);
  assert.match(pwa, /10\*60\*1000/);
});

test('28 + 31: notification grouping and adaptive priority are server-owned and low-priority arrivals stay quiet', () => {
  assert.match(server, /NOTIFICATION_GROUP_WINDOW_MS/);
  assert.match(server, /notificationGroupKey/);
  assert.match(server, /groupCount/);
  assert.match(server, /adaptiveNotificationPriority/);
  assert.match(server, /priority:'urgent'/);
  assert.match(server, /priority:'low'/);
  assert.match(server, /Number\(row\.groupCount\)/);
  assert.match(pub, /fresh\.filter\(\(n\) => n && n\.priority !== 'low'\)/);
  assert.match(pwa, /fresh\.filter\(function\(n\)\{return n&&n\.priority!==['"]low['"]/);
});

test('32: notification clicks deep-link and focus the managed share/image', () => {
  assert.match(server, /notificationManageUrlForRequest/);
  assert.match(server, /focusShare=/);
  assert.match(server, /action=\$\{share\.type/);
  assert.match(pub, /n && n\.manageUrl/);
  assert.match(pub, /focusShareFromLocation/);
  assert.match(pwa, /launchFocusToken/);
  assert.match(pwa, /focusPwaLaunchObject/);
  assert.match(pwa, /launchAction === 'images'/);
  assert.match(pwaCss, /\.notification-focus/);
});

test('33 + 34: advanced activity filters and share correlation are available in standard and PWA', () => {
  for (const id of ['activity-section-actor','activity-section-ip','activity-section-device','activity-section-result','activity-section-period','activity-section-direction','activity-correlate']) assert.ok(pubHtml.includes(`id="${id}"`), id);
  assert.match(pub, /activityResultMatches/);
  assert.match(pub, /renderCorrelatedActivity/);
  assert.match(pub, /e\.shareName\|\|e\.shareId/);
  for (const id of ['server-activity-actor','server-activity-ip','server-activity-device','server-activity-result','server-activity-period','server-activity-direction','server-activity-correlate']) assert.ok(pwaHtml.includes(`id="${id}"`), id);
  assert.match(pwa, /pwaActivityResultMatches/);
  assert.match(server, /shareName:share \? \(share\.name/);
  assert.match(server, /correlationId:event\.shareId/);
});

test('36 + 38: search highlights terms and exact filenames outrank approximate OCR/metadata matches', () => {
  assert.match(pub, /appendSearchHighlight/);
  assert.match(pwa, /appendPwaHighlighted/);
  assert.match(pubCss, /\.search-hit mark/);
  assert.match(pwaCss, /\.share-search-hit mark/);
  assert.match(server, /baseNorm===normalized \? 3/);
  assert.match(server, /Number\(b\.filenameMatchRank \|\| 0\)/);
  assert.match(server, /relevanceScore/);
});

test('39: trash exposes purge impact/dependencies before permanent deletion in both UIs', () => {
  assert.match(server, /function trashPurgeImpact/);
  assert.match(server, /purgeSummary/);
  assert.match(pub, /trash\.purgeConfirmImpact/);
  assert.match(pub, /trashPurgeSummary/);
  assert.match(pwa, /pwaTrashPurgeSummary/);
  assert.match(pwa, /sharesTrashImpact/);
  assert.match(pwa, /sharesTrashDependencies/);
});

test('40: missing original locations return safe restore alternatives and selected restores use the smart path', () => {
  assert.match(server, /trashRestoreAlternatives/);
  assert.match(server, /restore-location-missing/);
  assert.match(server, /alternativePath/);
  assert.match(pub, /restoreTrashSmart/);
  assert.match(pub, /for\(const id of ids\)\{try\{await restoreTrashSmart/);
  assert.match(pwa, /pwaTrashRestoreRequest/);
  assert.match(pwa, /await pwaTrashRestoreRequest\(ids\[i\]\)/);
});

test('wave 2 remains on 1.63.4 while PWA cache/build are advanced coherently', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.63.4');
  assert.match(pwa, /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(pwaHtml, /app\.css\?v=280/);
  assert.match(pwaHtml, /app\.js\?v=297/);
  assert.match(pubHtml, /style\.css\?v=286/);
  assert.match(pubHtml, /app\.js\?v=297/);
});
