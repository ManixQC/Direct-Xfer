'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const server = read('server.js');
const app = read('public','app.js');
const html = read('public','index.html');
const pwa = read('pwa','app.js');
const pwaHtml = read('pwa','index.html');
const pwaSw = read('pwa','sw.js');

test('1.54.0 share cards expose copy URL, usage, size/count and lifecycle badges', () => {
  assert.match(html, /id="share-created-banner"/);
  assert.match(html, /id="share-created-copy"/);
  assert.match(app, /showCreatedShareLink\(resp\.share\)/);
  assert.match(app, /Number\(s\.downloadsUsed\).*=== 0[\s\S]{0,150}?sh\.neverDownloaded/);
  assert.match(app, /sh\.totalSize/);
  assert.match(app, /s\.itemCount != null/);
  assert.match(app, /s\.hasPassword/);
  assert.match(app, /expiryRemaining > 0 && expiryRemaining <= 86400000/);
  assert.match(app, /attrs:\s*\{title:e\.at\?formatDate\(e\.at\):''\}[\s\S]{0,80}?timeAgo\(e\.at\)/);
});

test('Activity has the requested image/PWA/share/routine filters and full-detail search', () => {
  for (const id of ['activity-section-share','activity-images-only','activity-pwa-only','activity-hide-routine']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(app, /function activitySearchText\(e\)[\s\S]{0,300}?e&&e\.detail[\s\S]{0,300}?e&&e\.deviceId/);
  assert.match(app, /function activityIsImage\(e\)/);
  assert.match(app, /function activityIsPwa\(e\)/);
  assert.match(app, /function activityIsRoutineSystem\(e\)/);
  for (const id of ['server-activity-share','server-activity-images','server-activity-pwa','server-activity-hide-routine']) assert.match(pwaHtml,new RegExp(`id="${id}"`));
  assert.match(pwa, /function pwaServerActivitySearchText\(e\)[\s\S]{0,350}?e && e\.detail[\s\S]{0,350}?e && e\.deviceId/);
  assert.match(server, /\^album-\/.test\(action\)[\s\S]{0,180}?\^\(\?:image\|photo\|photos\)-\/.test\(action\)/);
});

test('organization, global search, expiry policy and disk supervision controls are wired', () => {
  assert.match(app, /pin-toggle/);
  assert.match(app, /openAdminNoteEditor\(s, card\)/);
  assert.match(html, /id="search-panel"/);
  assert.match(server, /state\.activityLog[\s\S]{0,1200}?scope:'log', kind:'activity'/);
  for (const id of ['cfg-never-expire-new','cfg-confirm-revoke','cfg-disk-warn']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(server, /newSharesNeverExpire:\s*false/);
  assert.match(server, /diskFreeWarnPercent:\s*10/);
  assert.match(server, /confirmShareRevoke:\s*true/);
  assert.match(server, /function diskFreeThresholds\(\)/);
  assert.match(app, /dash\.kpiDiskFree/);
});

test('trash count and multi-restore exist in standard and companion interfaces', () => {
  assert.match(html, /id="trash-count-badge"/);
  assert.match(html, /id="trash-restore-selected"/);
  assert.match(app, /async function restoreSelectedTrash\(\)/);
  assert.match(pwaHtml, /id="share-trash-count"/);
  assert.match(pwaHtml, /id="share-trash-restore-selected"/);
  assert.match(pwa, /async function restoreSelectedPwaTrash\(\)/);
  assert.match(pwa, /restoreSelectedPwaTrash\(\)[\s\S]{0,1100}?finally\{if\(btn\)btn\.disabled=false;\}/);
});

test('PWA share management exposes copy link, recursive metrics, pinning and lifecycle badges', () => {
  assert.match(pwaHtml, /id="share-created-link"/);
  assert.match(pwaHtml, /id="share-created-copy"/);
  assert.match(server, /metricsPending:pending\.length > 0/);
  assert.match(pwa, /hostShareMetricsTimer[\s\S]{0,300}?loadHostShares\(\)/);
  assert.match(pwa, /sharesNeverDownloaded/);
  assert.match(pwa, /sharesPasswordProtected/);
  assert.match(pwa, /sharesExpiresSoon/);
  assert.match(pwa, /toggleHostSharePin\(s\)/);
  assert.match(server, /changed\.push\('pinned'\)/);
});

test('paired-device cards report platform icon and observed PWA version/build', () => {
  assert.match(server, /function detectClientPlatform\(ua\)/);
  assert.match(server, /appVersion:\s*d\.appVersion/);
  assert.match(server, /appBuild:\s*d\.appBuild/);
  assert.match(pwa, /platformIcons = \{ android:'🤖', ios:'', windows:'⊞', macos:'', linux:'🐧', other:'📱' \}/);
  assert.match(pwa, /Direct-Xfer ' \+ d\.appVersion/);
  assert.match(pwa, /device\/status\?version=/);
  assert.match(server, /iphone\|ipad\|ipod\|macintosh\.\*mobile/);
});

test('global never-expire policy is enforced, not merely cosmetic', () => {
  assert.match(server, /function resolveNewShareExpiry\(body\) \{ return getSettings\(\)\.newSharesNeverExpire \? null/);
  assert.match(server, /const forceNeverExpire = getSettings\(\)\.newSharesNeverExpire === true/);
  assert.match(server, /const pwaFirstUseExpirySeconds = getSettings\(\)\.newSharesNeverExpire \? 0/);
  assert.match(app, /\$\('opt-firstuse'\)\.disabled = forceNeverExpire/);
  assert.match(app, /\$\('opt-inactive'\)\.disabled = forceNeverExpire/);
  assert.match(pwa, /\$\('share-first-use'\)\.disabled = forceNeverExpire/);
  assert.match(pwa, /\$\('img-expiry'\)\.disabled = forceNeverExpire/);
  assert.match(pwa, /expiresInSeconds: forceNeverExpire \? 0/);
});

test('release is 1.54.0 with a completely fresh PWA shell', () => {
  assert.equal(JSON.parse(read('package.json')).version,'1.63.4');
  assert.equal(JSON.parse(read('package-lock.json')).version,'1.63.4');
  assert.match(pwa,/APP_VERSION = '1\.63\.4'/);
  assert.match(pwa,/APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(pwaSw,/VERSION = '2026\.08\.16-pwa317'/);
  assert.match(pwaHtml,/v1\.63\.4 · pwa317/);
  assert.doesNotMatch(read('pwa','launch.html'),/\?v=245/);
  assert.doesNotMatch(read('pwa','login.html'),/\?v=245/);
  assert.doesNotMatch(read('pwa','login.js'),/\?v=245/);
  assert.doesNotMatch(pwa,/\?v=245/);
  assert.doesNotMatch(pwaSw,/\?v=245/);
  assert.match(pwaSw,/\?v=269/);
});
