'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('maintenance notifications are mandatory server-side', () => {
  const s = read('server.js');
  const mutable = /const NOTIFICATION_MUTABLE_CATEGORIES = \[([^\]]*)\]/.exec(s)?.[1] || '';
  assert.doesNotMatch(mutable, /maintenance/);
  assert.match(s, /if \(!NOTIFICATION_MUTABLE_CATEGORIES\.includes\(category\)\) return false/);
});

test('standard and PWA settings lock Maintenance as always-on', () => {
  const standard = read('public/app.js');
  const pwa = read('pwa/app.js');
  assert.match(standard, /NOTIFICATION_REQUIRED_CATEGORIES = \['security','maintenance','system_health'\]/);
  assert.match(pwa, /NOTIFICATION_REQUIRED_CATEGORIES = \['security','maintenance','system_health'\]/);
  assert.doesNotMatch(standard.match(/NOTIFICATION_MUTABLE_CATEGORIES = \[[^\]]*\]/)?.[0] || '', /maintenance/);
  assert.doesNotMatch(pwa.match(/NOTIFICATION_MUTABLE_CATEGORIES = \[[^\]]*\]/)?.[0] || '', /maintenance/);
});

test('required hints mention Maintenance in all supported languages', () => {
  const standard = read('public/app.js');
  const pwa = read('pwa/app.js');
  for (const text of ['Sécurité, Maintenance et Santé système','Security, Maintenance and System health','Seguridad, Mantenimiento y Salud del sistema']) {
    assert.match(standard, new RegExp(text));
    assert.match(pwa, new RegExp(text));
  }
});

test('PWA cache is refreshed while app version is 1.51.2', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.59.2');
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa281'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa281'/);
  assert.match(read('pwa/index.html'), /app\.js\?v=267/);
});
