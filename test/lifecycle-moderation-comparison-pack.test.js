'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const server = read('server.js');
const html = read('public/index.html');
const app = read('public/app.js');
const pwaHtml = read('pwa/index.html');
const pwa = read('pwa/app.js');

test('21 — PWA revocations use the recoverable trash instead of hard removal', () => {
  const block = server.slice(server.indexOf("app.post('/app/share/:token/revoke'"), server.indexOf("// ---- Server-file shares", server.indexOf("app.post('/app/share/:token/revoke'")));
  const clientBlock = pwa.slice(pwa.indexOf('function revokeShareRequest(token)'), pwa.indexOf('// ---- Server-file shares', pwa.indexOf('function revokeShareRequest(token)')));
  assert.match(block, /app\.post\('\/app\/share\/:token\/revoke', pwaJsonParser/);
  assert.match(block, /\['photo', 'inbox', 'collab', 'file', 'folder'\]/);
  assert.match(block, /softDeleteShare\(s\.id, req, true, \{ type:'share-trashed', label \}\)/);
  assert.doesNotMatch(block, /removeShare\(s\.id\)/);
  assert.match(block, /alreadyRevoked/);
  assert.match(clientBlock, /application\/json', '\{\}'/);
  assert.doesNotMatch(clientBlock, /application\/json', null/);
  assert.match(server, /adminRouter\.post\('\/trash\/:id\/restore'/);
});

test('22 — expired-link auto archive is configurable and disabled by default', () => {
  assert.match(server, /autoArchiveExpiredDays: 0/);
  assert.match(server, /runExpiredLinkLifecycle/);
  assert.match(server, /sh\.archived = true/);
  assert.match(server, /autoArchivedAt = now/);
  assert.match(html, /id="cfg-auto-archive-expired"/);
  assert.match(app, /autoArchiveExpiredDays/);
});

test('23 — expired managed-data purge is configurable, destructive, and cleans pending moderation bytes', () => {
  assert.match(server, /expiredDataRetentionDays: 0/);
  assert.match(server, /await destroyShareManagedData\(sh\)/);
  assert.match(server, /row\.shareId === sh\.id/);
  assert.match(server, /PENDING_DIR, row\.id/);
  assert.match(html, /id="cfg-expired-data-retention"/);
  assert.match(app, /cfg\.expiredDataRetentionConfirm/);
});

test('22/23 — lifecycle maintenance cannot overlap itself', () => {
  assert.match(server, /let expiredLinkLifecyclePromise = null/);
  assert.match(server, /if \(expiredLinkLifecyclePromise\) return expiredLinkLifecyclePromise/);
  assert.match(server, /finally \{ expiredLinkLifecyclePromise = null; \}/);
});

test('24/25 — smart expiry combines fixed, download and first-use limits in standard and PWA creation', () => {
  assert.match(html, /data-i18n="sh\.smartExpiryHint"/);
  assert.match(pwaHtml, /data-i18n="sharesSmartExpiryHint"/);
  assert.match(pwaHtml, /id="share-first-use"/);
  assert.match(pwa, /firstUseExpirySeconds:/);
  assert.match(server, /pwaFirstUseExpirySeconds/);
  assert.match(server, /maxDownloads: parseMaxDownloads\(body\.maxDownloads\)/);
});

test('26 — reinforced one-time use has a server-side concurrent-download claim', () => {
  assert.match(server, /const oneTimeDownloadClaims = new Map/);
  assert.match(server, /claimOneTimeDownload/);
  assert.match(server, /One-time link is already being downloaded/);
  assert.match(server, /releaseOneTimeDownload/);
  assert.match(server, /transfer\.burnClaim = burnClaim/);
  assert.match(pwaHtml, /id="share-one-time"/);
  assert.match(pwa, /burnAfterDownload:/);
});

test('26 — empty files and ZIP-construction failures cannot leak the one-time claim', () => {
  assert.match(server, /isFullGet && !inline && transferMeta && transferMeta\.shareId/);
  const zipCreates = server.match(/catch \(e\) \{ if \(burnClaim\) releaseOneTimeDownload\(transferMeta && transferMeta\.shareId, burnClaim\); throw e; \}/g) || [];
  assert.equal(zipCreates.length, 2);
});

test('27 — PWA can create moderated receptions and approve/reject pending files', () => {
  assert.match(pwaHtml, /id="create-moderated"/);
  assert.match(pwa, /moderated: !!\(\$\('create-moderated'\)/);
  assert.match(server, /moderated: !!req\.body\.moderated/);
  assert.match(server, /app\.get\('\/app\/inbox\/:token\/pending'/);
  assert.match(server, /app\.post\('\/app\/inbox\/:token\/pending\/:id\/approve'/);
  assert.match(server, /app\.post\('\/app\/inbox\/:token\/pending\/:id\/reject'/);
  assert.match(pwa, /moderateReceivedPending/);
});

test('30 — PWA image dashboard compares 7 or 30 days to the preceding period', () => {
  assert.match(pwaHtml, /id="img-dashboard-period"/);
  assert.match(pwaHtml, /option value="7"/);
  assert.match(pwaHtml, /option value="30"/);
  assert.match(server, /comparison = \{ days, current:/);
  assert.match(server, /const previousDays = localDayKeys\(previousEnd\.getTime\(\), days\)/);
  assert.match(pwa, /imgCompareSummary/);
  assert.match(pwa, /data\.comparison\.changes/);
});

test('PWA shell is advanced while application version remains 1.51.2', () => {
  assert.match(pwa, /APP_VERSION = '1\.62\.2'/);
  assert.match(pwa, /APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa306'/);
  assert.match(pwaHtml, /app\.js\?v=290/);
});
