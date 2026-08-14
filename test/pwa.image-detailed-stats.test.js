'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('every PWA image card exposes a visible Stats action', () => {
  assert.match(js, /class="btn ghost sm il-stats"[^>]*>📊 Stats<\/button>/);
  assert.match(js, /statsBtn\.textContent = t\('imgStatsButton'\)/);
  assert.match(js, /statsBtn\.addEventListener\('click',[\s\S]*?openImageDetailedStats/);
  assert.match(js, /\['\.il-open', '\.il-ocr', '\.il-qr', '\.il-qrdl', '\.il-photo-edit', '\.il-replace', '\.il-versions', '\.il-resize-mini', '\.il-compare'\]\.forEach/);
});

test('PWA detailed image stats modal renders overview, variants and recent visitors', () => {
  assert.match(html, /id="image-stats-overlay"/);
  assert.match(html, /id="image-stats-body"/);
  assert.match(js, /function renderImageDetailedStats\(data\)/);
  assert.match(js, /\['full', 'thumb', 'micro'\]\.forEach/);
  assert.match(js, /event\.flag \|\| '🌐'/);
  assert.match(js, /event\.ip \|\| '—'/);
  assert.match(js, /imageStatsCountryName\(event\.countryCode, event\.country\)/);
  assert.match(css, /\.image-stats-variants \{ display: grid;/);
  assert.match(css, /\.image-stats-event \{ display: grid;/);
});

test('PWA requests a management-only detailed stats endpoint without counting a public image view', () => {
  assert.match(js, /fetch\('\/app\/image\/' \+ encodeURIComponent\(photo\.token\) \+ '\/stats-detail'/);
  assert.match(server, /app\.get\('\/app\/image\/:token\/stats-detail', async \(req, res\) =>/);
  assert.match(server, /const share = pwaPhotoByToken\(req, req\.params\.token\)/);
  assert.match(server, /recentViews: await detailedPhotoRecentViews\(share, 50\)/);
});

test('standard and PWA image stats share the same full-IP/country enrichment path', () => {
  assert.match(server, /async function detailedPhotoRecentViews\(share, limit = 50\)/);
  assert.match(server, /ip: v\.ip \? \(v\.ipFull \? pubIp\(v\.ip\) : v\.ip\) : null/);
  assert.match(server, /flag: flag \|\| \(countryCode \? flagFromCode\(countryCode\) : null\)/);
  assert.match(server, /const recentViews = await detailedPhotoRecentViews\(s, 50\)/);
});
