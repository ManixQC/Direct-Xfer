'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageConnectorService } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const app = read('public/app.js');
const server = read('server.js');

test('1.67.5 reports no configured cloud connector before optional-rclone state', () => {
  const start = app.indexOf("async function openWebStorageModal(mode='share')");
  const end = app.indexOf("if($('new-web-storage-btn'))", start);
  assert.ok(start >= 0 && end > start);
  const block = app.slice(start, end);
  const none = block.indexOf("if(!connectors.length)");
  const runtime = block.indexOf("if(!available)");
  assert.ok(none >= 0 && runtime >= 0 && none < runtime);
  assert.match(block, /webStorage\.noneWritable.*webStorage\.none/);
});

test('1.67.5 maps connector/browser failures to actionable messages instead of one generic browse error', () => {
  assert.match(app, /function webStorageBrowseErrorMessage\(error, context='browse'\)/);
  for (const [code, key] of [
    ['rclone-unavailable', 'webStorage.rcloneMissing'],
    ['remote-not-found', 'webStorage.remoteMissing'],
    ['connector-auth-failed', 'webStorage.authFailed'],
    ['connector-forbidden', 'webStorage.providerForbidden'],
    ['connector-unreachable', 'webStorage.providerUnavailable'],
    ['connector-rate-limited', 'webStorage.providerRateLimited'],
    ['connector-timeout', 'webStorage.providerTimeout'],
    ['connector-response', 'webStorage.invalidResponse'],
  ]) {
    assert.match(app, new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(app, new RegExp(key.replace('.', '\\.')));
  }
  assert.match(app, /context==='connectors'/);
  assert.match(app, /webStorage\.connectorListFail/);
  assert.match(app, /webStorage\.connectorApiMissing/);
});

async function failureCode(stderr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-rclone-error-'));
  const wrapper = path.join(dir, 'fake-rclone.js');
  fs.writeFileSync(wrapper, `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);\n`, 'utf8');
  const svc = new StorageConnectorService({ bin:wrapper, configPath:path.join(dir, 'rclone.conf') });
  try {
    await svc.list({ remote:'cloud', root:'' }, '');
    assert.fail('expected connector failure');
  } catch (error) {
    return error && error.code;
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
}

test('1.67.5 classifies common rclone authentication/config/network errors safely', async () => {
  assert.equal(await failureCode('Failed to authenticate: invalid_grant'), 'connector-auth-failed');
  assert.equal(await failureCode(`didn't find section in config file ("cloud")`), 'remote-not-found');
  assert.equal(await failureCode('403 Forbidden: access denied'), 'connector-forbidden');
  assert.equal(await failureCode('429 Too Many Requests: rate limit exceeded'), 'connector-rate-limited');
  assert.equal(await failureCode('dial tcp: connection refused'), 'connector-unreachable');
});

test('1.67.5 connector list API preserves diagnostic codes and meaningful HTTP status classes', () => {
  for (const code of ['connector-auth-failed','connector-forbidden','connector-unreachable','connector-rate-limited','connector-response']) {
    assert.match(server, new RegExp(code));
  }
  const routeStart = server.indexOf("adminRouter.get('/storage/connectors/:id/list'");
  const routeEnd = server.indexOf("adminRouter.post('/storage/connectors/:id/import'", routeStart);
  const block = server.slice(routeStart, routeEnd);
  assert.match(block, /code === 'rclone-unavailable' \? 503/);
  assert.match(block, /code === 'remote-not-found' \? 404/);
  assert.match(block, /code === 'connector-timeout' \? 504/);
  assert.match(block, /code === 'connector-rate-limited' \? 503/);
});
