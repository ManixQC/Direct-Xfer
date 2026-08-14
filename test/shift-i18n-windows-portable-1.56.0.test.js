'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pub = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(root, 'pwa/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pwaIndex = fs.readFileSync(path.join(root, 'pwa/index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa/sw.js'), 'utf8');

test('standard host picker supports contiguous Shift+click selection', () => {
  assert.match(pub, /ev\.shiftKey\s*&&\s*state\.pickerRangeAnchor/);
  assert.match(pub, /function selectPickerRange\(entries, fromIndex, toIndex, list\)/);
  assert.match(pub, /for \(let i = lo; i <= hi; i\+\+\)/);
  assert.match(pub, /setPickerItemSelected\(entry, true, row\)/);
});

test('PWA host picker mirrors Shift+click range selection', () => {
  assert.match(pwa, /shareRangeAnchorIndex/);
  assert.match(pwa, /ev && ev\.shiftKey/);
  assert.match(pwa, /for \(var i = lo; i <= hi; i\+\+\) toggleShareItem\(entries\[i\], true, false\)/);
});

test('Audit and Activity machine descriptions are localized instead of rendered raw', () => {
  assert.match(pub, /function localizedAuditAction\(action\)/);
  assert.match(pub, /function localizedLogText\(value\)/);
  assert.match(pub, /text: localizedLogText\(e2\.detail\)/);
  assert.match(pub, /text:localizedActivityName\(e\)/);
  assert.match(pub, /'known device':'appareil connu'/);
  assert.match(pub, /'known device':'dispositivo conocido'/);
  assert.match(pwa, /function pwaLocalizedActivityText\(value\)/);
  assert.match(pwa, /strong\.textContent = pwaLocalizedActivityName\(e\)/);
  assert.match(pwa, /metaParts\.push\(pwaLocalizedActivityText\(e\.detail\)\)/);
});

test('Windows portable server listens on LAN and provisions a scoped firewall rule', () => {
  assert.match(server, /const BIND = process\.env\.BIND \|\| '0\.0\.0\.0'/);
  assert.match(server, /function ensureWindowsPortableFirewallAccess\(\)/);
  assert.match(server, /Direct-Xfer-TCP-\$\{PORT\}/);
  assert.match(server, /-Profile Any/);
  assert.match(server, /-RemoteAddress LocalSubnet/);
  assert.match(server, /DX_WINDOWS_LAUNCHER_TOKEN/);
  assert.match(server, /ensureWindowsPortableFirewallAccess\(\)/);
  assert.match(server, /\/__dx_launcher\/shutdown/);
});

test('PWA cache is refreshed for this hotfix', () => {
  assert.match(pwa, /2026\.08\.14-pwa279/);
  assert.match(sw, /2026\.08\.14-pwa279/);
  assert.match(pwaIndex, /v1\.59\.0 · pwa279/);
  assert.match(pwaIndex, /app\.js\?v=265/);
});
