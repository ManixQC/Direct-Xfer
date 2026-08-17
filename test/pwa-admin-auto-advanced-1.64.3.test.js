'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const advanced = read('pwa/admin-advanced.js');
const extras = read('pwa/admin-audit-connectors.js');
const loginHtml = read('pwa/login.html');
const loginJs = read('pwa/login.js');

test('PWA no longer exposes a local Advanced administration opt-in', () => {
  for (const src of [advanced, extras, loginHtml, loginJs]) {
    assert.doesNotMatch(src, /dx-pwa-advanced-admin-enabled|dx-admin-mode-toggle|dx-admin-mode-row/);
  }
  assert.doesNotMatch(advanced, /Activer le mode Administration avancée|Enable Advanced administration mode|Activar el modo Administración avanzada/);
});

test('owner/admin sessions automatically qualify for advanced administration, operators do not', () => {
  const marker = 'function hasAdminAccess';
  const start = advanced.indexOf(marker);
  assert.ok(start >= 0);
  const open = advanced.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < advanced.length; i += 1) {
    if (advanced[i] === '{') depth += 1;
    else if (advanced[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > open);
  const fn = vm.runInNewContext('(' + advanced.slice(start, end) + ')');
  assert.equal(fn({ authenticated:true, role:'owner' }), true);
  assert.equal(fn({ authenticated:true, role:'admin' }), true);
  assert.equal(fn({ authenticated:true, role:'operator' }), false);
  assert.equal(fn({ authenticated:false, role:'admin' }), false);
  assert.equal(fn(null), false);
});

test('advanced administration card is session-driven and hidden until owner/admin access is confirmed', () => {
  assert.match(advanced, /c\.hidden=true/);
  assert.match(advanced, /c\.hidden=!adminAccess/);
  assert.match(advanced, /syncAdminAccess\(true\)/);
  assert.match(advanced, /dx-pwa-admin-access/);
  assert.match(advanced, /<div id="dx-admin-advanced-body">/);
  assert.doesNotMatch(advanced, /<div id="dx-admin-advanced-body" hidden>/);
});

test('audit and connector advanced tools follow the authenticated advanced card instead of localStorage', () => {
  assert.match(extras, /card&&!card\.hidden&&card\.open/);
  assert.doesNotMatch(extras, /localStorage\.getItem\([^\n]*advanced-admin|MODE_KEY|modeEnabled/);
  assert.match(extras, /\/api\/session/);
  assert.match(extras, /dx-pwa-admin-access/);
  assert.match(extras, /clearPrivilegedData\(\);clearSession\(\)/);
});
