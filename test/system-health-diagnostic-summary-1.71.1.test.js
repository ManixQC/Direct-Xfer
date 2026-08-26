'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'public', 'server-health-dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pwaAdmin = fs.readFileSync(path.join(root, 'pwa', 'admin-advanced.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');

test('completed diagnostic summary survives translation and periodic health refreshes', () => {
  assert.match(dashboard, /const diagSummary=\$\('server-health-diag-summary'\);/);
  assert.match(dashboard, /if\(diagSummary&&state\.diag\)/);
  assert.match(dashboard, /diagSummary\.textContent=tr\('diagSummary',sum\)/);
  assert.match(dashboard, /finally\{state\.diagRunning=false;[^}]*applyText\(\);\}/);
  assert.match(dashboard, /function render\(d\)\{state\.data=d;applyText\(\);/);
});

test('System Health JavaScript cache busters are synchronized after summary fix', () => {
  assert.match(html, /server-health-dashboard\.js\?v=7/);
  assert.match(pwaAdmin, /server-health-dashboard\.js\?v=473/);
  assert.match(sw, /server-health-dashboard\.js\?v=473/);
});
