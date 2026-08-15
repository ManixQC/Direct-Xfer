'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');

test('server /app/receptions excludes revoked and effectively expired inbox links', () => {
  assert.match(server, /app\.get\('\/app\/receptions',[\s\S]*?if \(s\.revoked\) return false;/);
  assert.match(server, /app\.get\('\/app\/receptions',[\s\S]*?const expiry = shareEffectiveExpiry\(s\);[\s\S]*?return !\(expiry && now > expiry\);/);
  assert.match(server, /res\.json\(\{ receptions: list, activeTokens \}\);/);
});

test('PWA defensively filters expired reception records before building destinations', () => {
  assert.match(app, /var list = \(data\.receptions \|\| \[\]\)\.filter\(function \(s\) \{/);
  assert.match(app, /s\.effectiveExpiresAt \|\| s\.expiresAt/);
  assert.match(app, /return !!\(s && s\.token\) && !\(expiry && now > expiry\);/);
});

test('PWA purges stale remembered owned receptions but preserves manual/external destinations', () => {
  assert.match(app, /function pruneUnavailableOwnedReceptions\(activeTokens\)/);
  assert.match(app, /dest\.owned === true && \(!dest\.sourceOrigin \|\| dest\.sourceOrigin === location\.origin\)/);
  assert.match(app, /if \(!localOwned \|\| live\[dest\.token\]\) return true;/);
  assert.match(app, /await pruneUnavailableOwnedReceptions\(Array\.isArray\(data\.activeTokens\) \? data\.activeTokens : null\);/);
  assert.match(app, /idbDelete\(DEST_STORE, token\)/);
});

test('PWA shell revision is bumped so installed apps receive the fix', () => {
  assert.match(sw, /var VERSION = '2026\.08\.14-pwa287';/);
  assert.match(app, /var APP_BUILD = '2026\.08\.14-pwa287';/);
  assert.match(sw, /\/app\/app\.js\?v=270/);
  assert.match(index, /\/app\/app\.js\?v=270/);
});
