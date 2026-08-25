'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const routes = fs.readFileSync(path.join(root,'lib/server/admin-diagnostics-routes.js'),'utf8');
const dashboard = fs.readFileSync(path.join(root,'public/server-health-dashboard.js'),'utf8');

test('audit-key diagnostic treats absence of a migration as healthy, not as a failed migration', () => {
  assert.match(routes, /getKeyMigrationStatus\(\), null\)/);
  assert.match(routes, /auditKeyMigrationStatus && auditKeyMigrationStatus\.ok === false \? 'bad' : 'ok'/);
  assert.doesNotMatch(routes, /getKeyMigrationStatus\(\), \{ ok:false, reason:'unavailable' \}/);
});

test('audit-key detail reports migration not required when local-file key is the normal active mode', () => {
  assert.match(dashboard, /notRequired:'Non requise'/);
  assert.match(dashboard, /notRequired:'Not required'/);
  assert.match(dashboard, /notRequired:'No requerida'/);
  assert.match(dashboard, /const m=c\.migration;const migration=!m\?tr\('notRequired'\):\(m\.ok===false\?'FAIL':'OK'\)/);
});
