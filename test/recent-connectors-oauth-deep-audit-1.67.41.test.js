'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const connectorJobs = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'storage-connector-job-service.js'), 'utf8');
const receptionRoutes = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'reception-collaboration-routes.js'), 'utf8');
const publicShareRoutes = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'public-share-routes.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(ROOT, 'pwa', 'admin-audit-connectors.js'), 'utf8');
const storage = require('../lib/storage-connectors');
const writable = require('../lib/web-storage-writable');

test('1.69.6 preserves precise recent connector errors and HTTP semantics', () => {
  for (const code of ['connector-tls-ca-untrusted','connector-api-disabled','connector-token-invalid','connector-config-storage','connector-not-found']) {
    assert.equal(storage.connectorErrorCode({ code }), code);
  }
  assert.equal(storage.connectorHttpStatus('connector-not-found'), 404);
  assert.equal(storage.connectorHttpStatus('connector-config-storage'), 503);
  assert.equal(storage.connectorHttpStatus('connector-timeout', { public:true }), 503);
  assert.equal(writable.connectorStatus({ code:'connector-not-found' }), 404);
});

test('1.69.6 rclone diagnostics redact plain and JSON OAuth secrets', () => {
  const detail = storage.safeRcloneErrorDetail({
    code:'connector-failed', rcloneStage:'probe',
    message:'client_secret = superSecret refresh_token: refreshSecret {"access_token":"accessSecret"} Authorization: Bearer bearerSecret',
  });
  assert.ok(detail && detail.diagnostic);
  assert.doesNotMatch(detail.diagnostic, /superSecret|refreshSecret|accessSecret|bearerSecret/);
  assert.match(detail.diagnostic, /\[redacted\]|oauth-token-redacted/);
});

test('1.69.6 connector probe cache rejects pre-mutation stale snapshots', () => {
  assert.match(connectorJobs, /let probeEpoch = 0/);
  assert.match(connectorJobs, /probeEpoch \+= 1/);
  assert.match(connectorJobs, /const epoch = probeEpoch/);
  assert.match(connectorJobs, /epoch === probeEpoch \? value : null/);
  assert.match(connectorJobs, /if \(value\) return value;[\s\S]{0,220}return probeSnapshot\(\)/);
});

test('1.69.6 web-storage modal accepts a confirmed connector while the bounded rclone probe is pending', () => {
  assert.match(app, /const available=!!capabilities\.available, pending=!!capabilities\.pending/);
  assert.match(app, /if\(!available && !pending\)/);
  assert.doesNotMatch(app, /if\(!available\) \{ webStorageToast\(t\('webStorage\.rcloneMissing'\)/);
  assert.equal((app.match(/web-storage-collab-delete-row'\)\) \$\('web-storage-collab-delete-row'\)\.classList\.toggle/g) || []).length, 1);
});

test('1.69.6 PWA preserves authoritative connector inventory and clears stale error styling', () => {
  assert.match(pwa, /connectorInventoryConfirmed/);
  assert.match(pwa, /Array\.isArray\(result&&result\.connectors\)/);
  assert.match(pwa, /if\(!connectorInventoryConfirmed&&!?\(connectorState\.connectors\|\|\[\]\)\.length\)/);
  assert.match(pwa, /text\(cap,[^\n]+,false\)/);
  assert.match(pwa, /connectorChecking/);
});

test('1.69.6 public web-storage missing connector consistently maps to not-found', () => {
  assert.match(publicShareRoutes, /code === 'remote-not-found' \|\| code === 'connector-not-found'/);
  assert.match(receptionRoutes, /code==='remote-not-found'\|\|code==='connector-not-found'/);
});

test('1.69.6 server remains under the enforced modularization ceiling', () => {
  const lines = server.split(/\r?\n/).length;
  assert.ok(lines < 23000, `server.js should stay below 23000 lines, got ${lines}`);
});
