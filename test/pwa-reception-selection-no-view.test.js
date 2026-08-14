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

test('selecting a PWA reception destination validates through upload-status only', () => {
  const start = app.indexOf('function validateDest(dest)');
  const end = app.indexOf('function showLimits', start);
  assert.ok(start >= 0 && end > start, 'validateDest block exists');
  const block = app.slice(start, end);
  assert.match(block, /upload-status\?id=dxcheck0000&config=1/);
  assert.doesNotMatch(block, /fetch\('\/u\/' \+ encodeURIComponent\(dest\.token\)\s*,/);
  assert.match(block, /r\.json\(\).*data\.config/s);
});

test('upload-status can return reception config without incrementing views', () => {
  assert.match(server, /function receptionUploadConfig\(s\)/);
  assert.match(server, /String\(req\.query\.config \|\| ''\) === '1'\) payload\.config = receptionUploadConfig\(s\)/);
  const start = server.indexOf('function handleUploadStatus(req, res)');
  const end = server.indexOf("downloadRouter.get('/u/:token/upload-status'", start);
  assert.ok(start >= 0 && end > start, 'handleUploadStatus block exists');
  assert.doesNotMatch(server.slice(start, end), /bumpViews\s*\(/);
});

test('real public reception page still counts genuine views', () => {
  assert.match(server, /downloadRouter\.get\('\/u\/:token',[\s\S]*?bumpViews\(s, req\);/);
});

test('PWA shell is advanced so installed clients receive the fix', () => {
  assert.match(app, /APP_BUILD = '2026\.08\.14-pwa280'/);
  assert.match(sw, /VERSION = '2026\.08\.14-pwa280'/);
  assert.match(sw, /\/app\/app\.js\?v=266/);
  assert.match(index, /\/app\/app\.js\?v=266/);
});
