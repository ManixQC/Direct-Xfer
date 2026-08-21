'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(ROOT, 'pwa', 'admin-audit-connectors.js'), 'utf8');
const storage = require('../lib/storage-connectors');
const writable = require('../lib/web-storage-writable');

test('1.69.0 preserves precise recent connector errors and HTTP semantics', () => {
  for (const code of ['connector-tls-ca-untrusted','connector-api-disabled','connector-token-invalid','connector-config-storage','connector-not-found']) {
    assert.equal(storage.connectorErrorCode({ code }), code);
  }
  assert.equal(storage.connectorHttpStatus('connector-not-found'), 404);
  assert.equal(storage.connectorHttpStatus('connector-config-storage'), 503);
  assert.equal(storage.connectorHttpStatus('connector-timeout', { public:true }), 503);
  assert.equal(writable.connectorStatus({ code:'connector-not-found' }), 404);
});

test('1.69.0 rclone diagnostics redact plain and JSON OAuth secrets', () => {
  const detail = storage.safeRcloneErrorDetail({
    code:'connector-failed', rcloneStage:'probe',
    message:'client_secret = superSecret refresh_token: refreshSecret {"access_token":"accessSecret"} Authorization: Bearer bearerSecret',
  });
  assert.ok(detail && detail.diagnostic);
  assert.doesNotMatch(detail.diagnostic, /superSecret|refreshSecret|accessSecret|bearerSecret/);
  assert.match(detail.diagnostic, /\[redacted\]|oauth-token-redacted/);
});

test('1.69.0 connector probe cache rejects pre-mutation stale snapshots', () => {
  assert.match(server, /let connectorProbeEpoch = 0/);
  assert.match(server, /connectorProbeEpoch \+= 1/);
  assert.match(server, /const epoch = connectorProbeEpoch/);
  assert.match(server, /epoch === connectorProbeEpoch \? value : null/);
  assert.match(server, /if \(value\) return value;[\s\S]{0,220}return connectorProbeSnapshot\(\)/);
});

test('1.69.0 web-storage modal accepts a confirmed connector while the bounded rclone probe is pending', () => {
  assert.match(app, /const available=!!capabilities\.available, pending=!!capabilities\.pending/);
  assert.match(app, /if\(!available && !pending\)/);
  assert.doesNotMatch(app, /if\(!available\) \{ webStorageToast\(t\('webStorage\.rcloneMissing'\)/);
  assert.equal((app.match(/web-storage-collab-delete-row'\)\) \$\('web-storage-collab-delete-row'\)\.classList\.toggle/g) || []).length, 1);
});

test('1.69.0 PWA preserves authoritative connector inventory and clears stale error styling', () => {
  assert.match(pwa, /connectorInventoryConfirmed/);
  assert.match(pwa, /Array\.isArray\(result&&result\.connectors\)/);
  assert.match(pwa, /if\(!connectorInventoryConfirmed&&!?\(connectorState\.connectors\|\|\[\]\)\.length\)/);
  assert.match(pwa, /text\(cap,[^\n]+,false\)/);
  assert.match(pwa, /connectorChecking/);
});

test('1.69.0 public web-storage missing connector consistently maps to not-found', () => {
  assert.match(server, /code === 'remote-not-found' \|\| code === 'connector-not-found'/);
  assert.match(server, /code==='remote-not-found'\|\|code==='connector-not-found'/);
});

test('1.69.0 server remains under the enforced modularization ceiling', () => {
  const lines = server.split(/\r?\n/).length;
  assert.ok(lines < 23000, `server.js should stay below 23000 lines, got ${lines}`);
});
