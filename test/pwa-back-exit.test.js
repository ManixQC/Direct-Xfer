'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pwa = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('installed PWA requires two Back close requests without synthetic history entries', () => {
  assert.match(pwa, /PWA_BACK_EXIT_WINDOW_MS\s*=\s*2000/);
  assert.match(pwa, /new window\.CloseWatcher\(\)/);
  assert.match(pwa, /event\.preventDefault\(\)/);
  assert.match(pwa, /markPwaBackExitFirstPress\(\)/);
  assert.match(pwa, /try \{ window\.close\(\); \}/);
  assert.match(pwa, /installPwaDoubleBackExit\(\)/);
  assert.doesNotMatch(pwa, /history\.pushState\(\{\s*dxBack/);
  assert.doesNotMatch(pwa, /addEventListener\('popstate'[\s\S]{0,1200}dxBack/);
});

test('double-back guard is standalone-only and keeps normal browser history semantics', () => {
  assert.match(pwa, /if \(!isStandaloneApp\(\)\) return false/);
  assert.match(pwa, /typeof window\.CloseWatcher !== 'function'/);
  assert.doesNotMatch(pwa, /pushBackGuard/);
  assert.doesNotMatch(pwa, /pwaExitTimer/);
});

test('active transfers remain protected when the window is actually leaving', () => {
  assert.match(pwa, /function hasActiveTransferRisk\(\)/);
  assert.match(pwa, /window\.addEventListener\('beforeunload'/);
  assert.match(pwa, /if \(!hasActiveTransferRisk\(\)\) return/);
});
