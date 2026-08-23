'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPlatformDependencies } = require('../lib/server/platform-dependencies');
const { createServerConfig } = require('../lib/server/config');

const ROOT = path.resolve(__dirname, '..');

function baseLoader(overrides = Object.create(null)) {
  return (name) => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : require(name);
}

test('optional platform modules with incompatible exports degrade to null without invoking hostile accessors', () => {
  let getterReads = 0;
  const badMailer = {};
  Object.defineProperty(badMailer, 'createTransport', { enumerable:true, get() { getterReads += 1; return () => {}; } });
  const badPush = { generateVAPIDKeys() { return {}; } };
  Object.defineProperty(badPush, 'sendNotification', { enumerable:true, get() { getterReads += 1; return () => {}; } });
  const badForge = { pki:{}, md:{} };
  Object.defineProperty(badForge.pki, 'privateKeyFromPem', { enumerable:true, get() { getterReads += 1; return () => {}; } });

  const dependencies = createPlatformDependencies({
    load:baseLoader({
      nodemailer:badMailer,
      'web-push':badPush,
      'node-forge':badForge,
    }),
  });

  assert.equal(dependencies.nodemailer, null);
  assert.equal(dependencies.webpush, null);
  assert.equal(dependencies.forge, null);
  assert.equal(getterReads, 0, 'platform preflight must inspect descriptors without executing accessors');
  assert.equal(dependencies.views.notification.nodemailer, null);
  assert.equal(dependencies.views.notification.webpush, null);
});

test('required platform modules fail at the boundary when their export contract is incompatible', () => {
  assert.throws(
    () => createPlatformDependencies({ load:baseLoader({ express:() => {} }) }),
    /platform dependency express has an incompatible export/
  );
  assert.throws(
    () => createPlatformDependencies({ load:null }),
    /platform dependencies require load\(\)/
  );
  assert.throws(
    () => createPlatformDependencies({ pwaAdminHealth:{} }),
    /platform dependency pwaAdminHealth has an incompatible export/
  );
});

test('structured config groups stay additive without changing the legacy enumerable flat config surface', () => {
  const config = createServerConfig({ rootDir:ROOT, env:{} });
  const descriptor = Object.getOwnPropertyDescriptor(config, 'groups');

  assert.ok(descriptor);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.ok(Object.isFrozen(config.groups));
  assert.equal(Object.prototype.hasOwnProperty.call({ ...config }, 'groups'), false);
  assert.equal(Object.keys(config).includes('groups'), false);
  assert.strictEqual(config.groups.app.APP_VERSION, config.APP_VERSION);
  assert.strictEqual(config.groups.paths.DATA_DIR, config.DATA_DIR);
});
