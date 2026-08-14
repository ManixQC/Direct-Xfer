'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('image views retain complete visitor IPs instead of masking them unconditionally', () => {
  assert.match(server, /const ip = String\(rawIp \|\| ''\)\.replace\(\/\^::ffff:\/i, ''\)/);
  assert.match(server, /ipFull: !!ip/);
  assert.doesNotMatch(server, /const rawIp = clientIp\(req\);\s*const ip = maskIp\(rawIp\);/);
  assert.match(server, /const legacyMaskedIp = maskIp\(ip\)/);
});

test('detailed image stats respect the global anonymization setting at presentation time', () => {
  assert.match(server, /ip: v\.ip \? \(v\.ipFull \? pubIp\(v\.ip\) : v\.ip\) : null/);
});

test('recent image views are enriched with geolocation and render flag, IP and country', () => {
  assert.match(server, /geolocate\(rawIp\)\.then\(\(resolved\) =>/);
  assert.match(server, /async function detailedPhotoRecentViews\(share, limit = 50\)[\s\S]*?return Promise\.all\(recentSource\.map\(async \(v\) =>/);
  assert.match(server, /flag: flag \|\| \(countryCode \? flagFromCode\(countryCode\) : null\)/);
  assert.match(app, /const visitorCountry = event\.country \? countryText\(event\.country\) : t\('stats\.unknown'\)/);
  assert.match(app, /\[event\.flag \|\| '🌐', event\.ip \|\| '—', visitorCountry\]\.join\(' · '\)/);
});
