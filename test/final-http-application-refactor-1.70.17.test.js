'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

const server = read('server.js');
const finalHttp = read('lib/server/final-http-application.js');

function position(source, token) {
  const value = source.indexOf(token);
  assert.notEqual(value, -1, `missing composition token: ${token}`);
  return value;
}

test('priority 4 moves root, admin and final HTTP/PWA composition behind one boundary', () => {
  assert.match(server, /require\('\.\/lib\/server\/final-http-application'\)/);
  assert.match(server, /finalHttpApplication = createFinalHttpApplication\(\{/);
  assert.match(server, /finalHttpApplication\.lifecycleService\.start\(\);/);
  for (const direct of ['createRootRoutes', 'createAdminApplication', 'createHttpPwaLifecycleApplication']) {
    assert.doesNotMatch(server, new RegExp(`\\b${direct}\\(`), `${direct} should not be composed directly by server.js`);
    assert.match(finalHttp, new RegExp(`\\b${direct}\\(`), `${direct} should be owned by final-http-application`);
  }
  for (const rel of ['root-routes', 'admin-application', 'http-pwa-lifecycle-application']) {
    assert.match(finalHttp, new RegExp(`require\\('\\./${rel}'\\)`));
  }
  assert.ok(server.split('\n').length < 680, `server.js remains too large (${server.split('\n').length} lines)`);
});

test('final boundary preserves root -> admin -> bootstrap publication -> HTTP/PWA order', () => {
  const tokens = [
    'const rootRoutes = createRootRoutes({',
    'const adminApplication = createAdminApplication({',
    'bindAdmin.call(bootstrapReferences, adminApplication)',
    'const httpPwaLifecycleApplication = createHttpPwaLifecycleApplication({',
    "pwaPairTickets = ownValue(httpPwaLifecycleApplication, 'pairTickets'",
    "ownValue(httpPwaLifecycleApplication, 'lifecycleService'",
  ];
  const positions = tokens.map((token) => position(finalHttp, token));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('late state-replacement providers resolve the applications published by the final boundary', () => {
  assert.match(server, /adminApplication:\(\) => finalHttpApplication && finalHttpApplication\.adminApplication/);
  assert.match(server, /httpPwaLifecycleApplication:\(\) => finalHttpApplication && finalHttpApplication\.httpPwaLifecycleApplication/);
  assert.match(server, /function currentLifecycleService\(\)/);
  assert.match(server, /finalHttpApplication \? finalHttpApplication\.lifecycleService : null/);
});

test('Windows runtime integrity protects the new final HTTP composition boundary', () => {
  const rel = 'lib/server/final-http-application.js';
  const hash = crypto.createHash('sha256').update(read(rel)).digest('hex');
  const host = read('windows-server-host/Program.cs');
  assert.match(host, new RegExp(`\\{ "${rel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}", "${hash}" \\}`));
});
