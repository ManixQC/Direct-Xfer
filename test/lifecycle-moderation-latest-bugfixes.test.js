'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const pwa = read('pwa/app.js');

test('pending moderation reserves link, sender and global reception quotas', () => {
  assert.match(server, /function pendingUsageForShare\(s, excludePendingId = null\)/);
  assert.match(server, /const usedFiles = Math\.max\(0, Number\(s\.downloads\) \|\| 0\) \+ pending\.files/);
  assert.match(server, /const usedBytes = Math\.max\(0, Number\(s\.bytesReceived\) \|\| 0\) \+ pending\.bytes/);
  assert.match(server, /function pendingUsageForSender\(s, senderKey, excludePendingId = null\)/);
  assert.match(server, /total \+= pendingReceptionBytes\(excludePendingId\)/);
});

test('recoverable trash still consumes the global reception storage cap', () => {
  const block = server.slice(server.indexOf('function currentReceptionBytes'), server.indexOf('function receptionCapExceeded'));
  assert.match(block, /state\.trash/);
  assert.match(block, /s\.type === 'inbox' \|\| s\.type === 'collab'/);
  assert.match(block, /s\.bytesReceived/);
});

test('moderation queue refuses overflow instead of orphaning old files', () => {
  assert.match(server, /const PENDING_MODERATION_MAX = 2000/);
  assert.match(server, /state\.meta\.pending\.length >= PENDING_MODERATION_MAX\) return \{ error: 'moderation-full' \}/);
  assert.doesNotMatch(server, /state\.meta\.pending\.length\s*=\s*2000/);
  assert.match(server, /async function cleanupOrphanPendingFiles/);
});

test('moderated approval preserves destination, sender quotas, expiry and dedupe semantics', () => {
  assert.match(server, /destRel: String\(opts\.destRel \|\| rel \|\| 'file'\)/);
  assert.match(server, /expireSec: Math\.max\(0, Number\(opts\.expireSec\) \|\| 0\)/);
  assert.match(server, /senderKey/);
  assert.match(server, /perSenderRejectReason\(s, null, row\.sender \|\| '', size, \{ senderKey, excludePendingId: row\.id \}\)/);
  assert.match(server, /const accounting = applyReceptionAccountingState\(s, \{ size, sha, senderKey, dest, expireSec:Math\.max\(0, Number\(row\.expireSec\) \|\| 0\) \}\)/);
  assert.match(server, /verifyAndRememberDedupe\(outcome\.dest\)/);
  assert.match(server, /bumpSenderStatByKey\(s, senderKey, size\)/);
});

test('approval excludes its own pending reservation and moderation actions are claimed once', () => {
  assert.match(server, /inboxRejectReason\(s, row\.name \|\| parsed\.filename, size, \{ excludePendingId: row\.id \}\)/);
  assert.match(server, /const pendingModerationClaims = new Set\(\)/);
  assert.match(server, /if \(!claimPendingModeration\(.*\.id\)\) return res\.status\(409\)/s);
  assert.match(server, /finally \{ releasePendingModeration\(/);
});

test('legacy single-shot moderated uploads honor the structured stash result and all metadata', () => {
  const start = server.indexOf('// --- Legacy single-shot path (no id) ---');
  const end = server.indexOf("downloadRouter.post('/u/:token/upload'", start);
  const block = server.slice(start, end);
  assert.match(block, /const pending = await stashPending/);
  assert.match(block, /senderName,/);
  assert.match(block, /senderKey: uploadSenderKey/);
  assert.match(block, /destRel,/);
  assert.match(block, /expireSec,/);
  assert.match(block, /sha256: clientSha256/);
  assert.match(block, /if \(pending\.ok\)/);
  assert.doesNotMatch(block, /const ok = await stashPending/);
});

test('PWA moderation prevents duplicate approve/reject submissions and surfaces failures', () => {
  assert.match(pwa, /var pendingModerationActions = new Set\(\)/);
  assert.match(pwa, /if \(pendingModerationActions\.has\(key\)\) return/);
  assert.match(pwa, /buttons\.forEach\(function\(btn\)\{ btn\.disabled = true; \}\)/);
  assert.match(pwa, /catch \(_\) \{ toast\(t\('receivedFail'\), 'err'\); \}/);
  assert.match(pwa, /pendingModerationActions\.delete\(key\)/);
});

test('image comparison uses durable daily buckets instead of the capped recent-event list', () => {
  assert.match(server, /PHOTO_DAILY_VIEW_DAYS = 70/);
  assert.match(server, /function ensurePhotoDailyViews/);
  assert.match(server, /function notePhotoDailyView/);
  const start = server.indexOf("app.get('/app/images/dashboard'");
  const end = server.indexOf('function streamToFileBounded', start);
  const block = server.slice(start, end);
  assert.match(block, /ensurePhotoDailyViews\(photo, now\)/);
  assert.match(block, /Object\.entries\(dailyState\.daily\)/);
  assert.doesNotMatch(block, /ps\.recent/);
});

test('download-limit exhaustion participates in effective lifecycle expiry and clone reset', () => {
  assert.match(server, /function shareDownloadLimitDeadline\(s\)/);
  assert.match(server, /shareDownloadLimitDeadline\(s\)/);
  assert.match(server, /s\.downloadLimitReachedAt = Date\.now\(\)/);
  assert.match(server, /'downloadLimitReachedAt'/);
  assert.match(server, /'autoArchivedAt'/);
});



test('zero-byte one-time downloads still create a logical transfer and consume the claim', () => {
  assert.match(server, /if \(isFullGet && !inline && transferMeta && transferMeta\.shareId\)/);
  assert.match(server, /const emptyTransfer = startTransfer\(req, transferMeta, 0\)/);
  assert.match(server, /emptyTransfer\.notify = true/);
  assert.match(server, /if \(burnClaim\) emptyTransfer\.burnClaim = burnClaim/);
  assert.match(server, /endTransfer\(emptyTransfer, completed, reason \|\| null\)/);
});
test('photo cache restrictions use the effective smart-expiry deadline', () => {
  assert.match(server, /const restrictedCache = !!s\.pwHash \|\| Number\(s\.maxViews\) > 0 \|\| !!shareEffectiveExpiry\(s\)/);
});
