'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPlatformDependencies, PLATFORM_VIEW_KEYS } = require('../lib/server/platform-dependencies');
const { createServerConfig } = require('../lib/server/config');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

test('priority 6 moves process/platform package loading out of server.js', () => {
  const server = read('server.js');
  const platform = read('lib/server/platform-dependencies.js');

  assert.match(server, /createPlatformDependencies\(\)/);
  for (const request of ['fs', 'path', 'crypto', 'os', 'net', 'tls', 'events', 'async_hooks', 'express', 'qrcode', 'node-forge', 'nodemailer', 'web-push']) {
    assert.doesNotMatch(server, new RegExp(`require\\(['\"]${request.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['\"]\\)`));
    assert.match(platform, new RegExp(`[\"']${request.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\"']`));
  }
  assert.ok(server.split('\n').length < 600, `server.js should stay compact after priority 6 (${server.split('\n').length} lines)`);
});

test('platform boundary exposes frozen exact dependency views and preserves optional degradation', () => {
  const optional = new Set(['node-forge', 'nodemailer', 'web-push']);
  const dependencies = createPlatformDependencies({
    load(name) {
      if (optional.has(name)) throw new Error(`missing ${name}`);
      return require(name);
    },
    pwaAdminHealth:{
      healthPayload() {}, recordHealthHistory() {}, bucketHealthHistory() {}, attachHealthRoute() {},
    },
  });

  assert.equal(dependencies.forge, null);
  assert.equal(dependencies.nodemailer, null);
  assert.equal(dependencies.webpush, null);
  assert.ok(Object.isFrozen(dependencies));
  assert.ok(Object.isFrozen(dependencies.views));

  for (const [viewName, keys] of Object.entries(PLATFORM_VIEW_KEYS)) {
    const view = dependencies.views[viewName];
    assert.ok(Object.isFrozen(view), `${viewName} must be frozen`);
    assert.deepEqual(Object.keys(view), [...keys], `${viewName} drifted from its platform contract`);
    for (const key of keys) assert.strictEqual(view[key], dependencies[key]);
  }
});

test('server config structured groups are frozen aliases over the backward-compatible flat contract', () => {
  const config = createServerConfig({ rootDir:ROOT, env:{} });
  assert.ok(Object.isFrozen(config.groups));

  const checks = {
    app:['APP_NAME', 'APP_VERSION', 'APP_YEAR', 'RELEASE_DATE'],
    http:['PORT', 'BIND', 'PUBLIC_HOST', 'PUBLIC_URL', 'LOCAL_IP', 'TRUST_PROXY'],
    paths:['HOST_ROOT', 'DATA_DIR', 'PENDING_DIR', 'IMAGE_STORE_DIR', 'QUARANTINE_DIR'],
    security:['SESSION_TTL_MS', 'FAIL_WINDOW_MS', 'DATA_KEY', 'ADMIN_ALLOWED_IPS'],
    notifications:['WEBHOOK_URL', 'WEBHOOK_FORMAT', 'SMTP_URL', 'EMAIL_FROM', 'EMAIL_TO'],
    updates:['UPDATE_IMAGE', 'UPDATE_CHECK', 'PUBLIC_IP_DISCOVERY', 'UPDATE_REPO', 'UPDATE_TAG'],
    limits:['MAX_ZIP_BYTES', 'MAX_UPLOAD_BYTES', 'TRANSFER_STALL_MS', 'MAX_STORAGE_CONNECTORS'],
    connectors:['GOOGLE_OAUTH_BROKER_URL_ENV', 'RCLONE_BIN', 'CLAMAV_HOST', 'CLAMAV_PORT', 'clamavEnabled'],
    features:['SHUTDOWN_AFTER_DOWNLOAD'],
  };

  for (const [groupName, names] of Object.entries(checks)) {
    const group = config.groups[groupName];
    assert.ok(Object.isFrozen(group), `${groupName} must be frozen`);
    for (const name of names) {
      assert.ok(Object.prototype.hasOwnProperty.call(group, name), `${groupName}.${name} missing`);
      assert.strictEqual(group[name], config[name], `${groupName}.${name} must alias the flat config value`);
    }
  }
});

test('Windows runtime integrity protects the platform/config composition boundary', () => {
  const host = read('windows-server-host/Program.cs');
  for (const rel of ['server.js', 'lib/server/config.js', 'lib/server/platform-dependencies.js']) {
    const hash = crypto.createHash('sha256').update(read(rel)).digest('hex');
    assert.match(host, new RegExp(`\\{ "${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", "${hash}" \\}`));
  }
});
