'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'public', 'server-health-dashboard.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'lib', 'server', 'admin-diagnostics-routes.js'), 'utf8');

const diagnosticIds = [
  'data-writable','reception-writable','images-writable','disk-space','storage-mounts',
  'audit-chain','search-index','ocr','clamav','audit-key','data-encryption','tls-certificate',
  'webhook','email','web-push','pwa-assets','pwa-install','public-port','reverse-proxy',
];

test('System Health detailed diagnostics have a human label and an information formatter for every check', () => {
  assert.match(dashboard, /const DIAG_NAMES=/);
  assert.match(dashboard, /function diagnosticDetail\(c\)/);
  assert.match(dashboard, /<small>'\+esc\(diagnosticDetail\(c\)\)/);
  for (const id of diagnosticIds) {
    assert.match(routes, new RegExp(`(?:add\\('${id}'|\\['${id}',)`), `backend check ${id} must still exist`);
    const labelCount = (dashboard.match(new RegExp(`'${id}'\\s*:`, 'g')) || []).length;
    assert.ok(labelCount >= 3, `${id} must have FR/EN/ES human labels`);
  }
});

test('diagnostic detail lines expose useful measurements instead of only group/error placeholders', () => {
  for (const token of [
    'diagWriteOk','diagDisk','diagMounts','diagAudit','diagSearch','diagOcr','diagClamav',
    'diagAuditKey','diagEncryption','diagTls','diagDelivery','diagPush','diagPwaAssets',
    'diagPwaInstall','diagPublicPort','diagProxy',
  ]) assert.match(dashboard, new RegExp(token));
  assert.doesNotMatch(dashboard, /c\.error\|\|c\.reason\|\|c\.detail\|\|c\.group/);
});
