'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const pwa = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('PWA Partages exposes a Stats action backed by an authorized PWA route', () => {
  assert.match(pwa, /sharesStatsButton:'📊 Stats'/);
  assert.match(pwa, /openHostShareDetailedStats\(s\)/);
  assert.match(pwa, /\/app\/host\/shares\/.*stats-detail/);
  assert.match(server, /app\.get\('\/app\/host\/shares\/:token\/stats-detail'/);
  assert.match(server, /pwaCanManageHostShare\(req, share\)/);
});

test('standard and PWA detailed stats share one server-side payload builder', () => {
  assert.match(server, /async function detailedShareStatsPayload\(s, req\)/);
  assert.match(server, /adminRouter\.get\('\/shares\/:id\/stats-detail'[\s\S]*detailedShareStatsPayload\(s, req\)/);
  assert.match(server, /app\.get\('\/app\/host\/shares\/:token\/stats-detail'[\s\S]*detailedShareStatsPayload\(share, req\)/);
});

test('PWA renders the standard detailed-stat datasets responsively', () => {
  for (const token of ['data.aggregate','data.quota','data.live','data.timeline','data.countries','data.clients','data.recent']) assert.ok(pwa.includes(token), `missing ${token}`);
  assert.match(css, /\.share-stats-metrics/); assert.match(css, /\.share-stats-two-columns/); assert.match(css, /\.share-stats-timeline/); assert.match(css, /@media \(max-width:620px\)/);
});

test('release and PWA cache identifiers are 1.63.4/pwa317', () => {
  assert.equal(pkg.version, '1.63.4'); assert.match(pwa, /APP_VERSION = '1\.63\.4'/); assert.match(pwa, /2026\.08\.16-pwa317/); assert.match(sw, /2026\.08\.16-pwa317/);
});
