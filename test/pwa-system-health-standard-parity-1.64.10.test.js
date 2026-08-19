'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pwa = read('pwa/admin-advanced.js');
const app = read('pwa/app.js');
const sw = read('pwa/sw.js');
const standardHtml = read('public/index.html');

const standardIds = [
  'server-health-title','server-health-subtitle','server-health-range','server-health-auto','server-health-export',
  'server-health-diagnostics','server-health-refresh','server-health-score','server-health-status','server-health-updated',
  'server-health-kpis','server-health-alert-count','server-health-alerts','server-health-cpu','server-health-ram',
  'server-health-disk','server-health-process','server-health-event-loop','server-health-uptime','server-health-history-meta',
  'server-health-history','server-health-volumes','server-health-backup','server-health-search','server-health-shares',
  'server-health-transfers','server-health-connectors','server-health-network','server-health-tls','server-health-notifications',
  'server-health-security','server-health-audit','server-health-runtime','server-health-diag-summary','server-health-diag'
];

test('PWA System Health reuses the standard dashboard markup and renderer', () => {
  for (const id of standardIds) {
    assert.match(standardHtml, new RegExp(`id=["']${id}["']`), `standard has ${id}`);
    assert.match(pwa, new RegExp(`id="${id}"`), `PWA clone has ${id}`);
  }
  assert.match(pwa, /server-health-dashboard\.css\?v=360/);
  assert.match(pwa, /server-health-dashboard\.js\?v=360/);
  assert.match(pwa, /window\.DirectXferServerHealth/);
  assert.match(pwa, /server-health-grid/);
  assert.match(pwa, /server-health-table-wrap/);
  assert.match(pwa, /data-health-text="storageSection"/);
  assert.match(pwa, /data-health-text="integritySection"/);
  assert.match(sw, /server-health-dashboard\.css\?v=360/);
  assert.match(sw, /server-health-dashboard\.js\?v=360/);
});

test('System Health tab independently revalidates the current admin session', () => {
  assert.match(app, /async function refreshSystemHealthNavAccess\(force\)/);
  assert.match(app, /fetch\('\/api\/session'/);
  assert.match(app, /session\.role === 'owner' \|\| session\.role === 'admin'/);
  assert.match(app, /startSystemHealthAccessWatch\(\)/);
  assert.match(app, /window\.addEventListener\('pageshow'/);
  assert.match(app, /window\.addEventListener\('online'/);
  assert.match(app, /document\.addEventListener\('visibilitychange'/);
  assert.match(app, /setInterval[\s\S]*30000/);
  assert.match(app, /scheduleSystemHealthAccessRetry\(systemHealthAccessResolved \? 5000 : 1500\)/);
});

test('transient session lookup failures do not revoke already confirmed admin access', () => {
  const start = app.indexOf('async function refreshSystemHealthNavAccess');
  const end = app.indexOf('function startSystemHealthAccessWatch', start);
  const fn = app.slice(start, end);
  assert.doesNotMatch(fn, /catch[\s\S]*syncSystemHealthNavAccess\(false\)/);
  assert.match(fn, /response\.status === 401 \|\| response\.status === 403/);
});
