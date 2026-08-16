
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const server = read('server.js');
const pwa = read('pwa','app.js');
const admin = read('public','app.js');
const html = read('public','index.html');
const pwaHtml = read('pwa','index.html');
const sw = read('pwa','sw.js');
const workflow = read('.github','workflows','build-windows-csharp.yml');

test('detailed share stats expose the effective lifecycle expiry and an expired status', () => {
  assert.match(server, /const effectiveExpiresAt = Number\(decorated\.effectiveExpiresAt\)/);
  assert.match(server, /expired \? 'expired' : isActive\(s\)/);
  assert.match(server, /expiresAt:s\.expiresAt\|\|0,effectiveExpiresAt,/);
  assert.match(admin, /'stats\.expired': 'Expiré'/);
  assert.match(pwa, /shareStatsExpired:'Expiré'/);
  assert.match(pwa, /sh\.effectiveExpiresAt\|\|sh\.expiresAt/);
});

test('standard and PWA stats ignore stale async responses after another modal action', () => {
  assert.match(admin, /let detailedStatsContext = \{ share: null, period: '14', requestSeq: 0 \}/);
  assert.match(admin, /seq !== detailedStatsContext\.requestSeq/);
  assert.match(admin, /closeDetailedStats\(\) \{ detailedStatsContext\.requestSeq \+= 1;/);
  assert.match(pwa, /var detailedStatsRequestSerial = 0/);
  assert.match(pwa, /requestSerial !== detailedStatsRequestSerial/);
  assert.match(pwa, /closeImageDetailedStats\(\) \{ detailedStatsRequestSerial \+= 1;/);
});

test('current shell cache keys deliver the corrected admin and PWA scripts', () => {
  assert.match(html, /style\.css\?v=286/);
  assert.match(html, /app\.js\?v=297/);
  assert.match(pwaHtml, /app\.js\?v=297/);
  assert.match(pwaHtml, /v1\.63\.4 · pwa317/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(sw, /app\/app\.js\?v=297/);
});

test('Windows workflow release-critical test paths all exist', () => {
  const refs = [...workflow.matchAll(/'((?:test\/)[^']+(?:\.test|\.integration\.test)\.js)'/g)]
    .map((m) => m[1].replace(/^'|'$/g,''));
  assert.ok(refs.length > 10);
  for (const rel of refs) assert.ok(fs.existsSync(path.join(root, rel)), 'missing workflow test: ' + rel);
});
