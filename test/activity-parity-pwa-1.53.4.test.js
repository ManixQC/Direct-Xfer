'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const pwa = read('pwa/app.js');
const html = read('pwa/index.html');

test('1.54.0 gives owner/admin paired PWAs the same Activity scope as standard Direct-Xfer', () => {
  assert.match(server, /if \(pwaViewerIsAdmin\(req\) \|\| \(session && session\.role === 'auditor'\)\) return true/);
  assert.match(server, /app\.get\('\/app\/activity\/recent',[\s\S]*Math\.min\(1000,[\s\S]*pwaCanSeeActivityEvent/);
  assert.match(pwa, /fetch\('\/app\/activity\/recent\?limit=1000'/);
});

test('PWA Activity UI mirrors the standard search, categories and row fields', () => {
  assert.match(html, /id="server-activity-kind"/);
  for (const value of ['transfer','admin','security','visitor','system']) assert.match(html, new RegExp(`<option value="${value}"`));
  assert.match(html, /id="server-activity-reset"/);
  assert.match(html, /id="server-activity-summary"/);
  assert.match(pwa, /function pwaServerActivityGroup\(e\)/);
  assert.match(pwa, /if \(kind === 'audit' \|\| kind === 'share' \|\| kind === 'trash'\) return 'admin'/);
  assert.match(pwa, /\[pwaLocalizedActivityName\(e\),e && e\.kind,pwaLocalizedActivityText\(e && e\.status\),pwaLocalizedActivityText\(e && e\.detail\)/);
  assert.match(pwa, /strong\.textContent = pwaLocalizedActivityName\(e\)/);
  assert.match(pwa, /if \(e\.status\) metaParts\.push\(pwaLocalizedActivityText\(e\.status\)\)/);
  assert.match(pwa, /if \(e\.ip\) metaParts\.push\(e\.ip\)/);
  assert.match(pwa, /if \(e\.detail\) metaParts\.push\(pwaLocalizedActivityText\(e\.detail\)\)/);
});

test('local device transfer history no longer changes what the Activity tab contains', () => {
  assert.match(html, /id="server-activity-card"[^>]*data-pwa-panel="activity"/);
  assert.match(html, /id="history-card"[^>]*data-pwa-panel="send"/);
  assert.doesNotMatch(pwa, /panel === 'activity'[^\n]*history-card/);
});

test('release/cache remain on 1.59.4 with pwa283 v268', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.59.4');
  assert.equal(JSON.parse(read('package-lock.json')).version, '1.59.4');
  assert.match(pwa, /APP_VERSION = '1\.59\.4'/);
  assert.match(pwa, /APP_BUILD = '2026\.08\.14-pwa283'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa283'/);
  assert.match(html, /v1\.59\.4 · pwa283/);
  assert.match(html, /app\.js\?v=268/);
});
