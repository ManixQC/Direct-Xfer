'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApplicationContext } = require('../lib/server/application-context');
const {
  DIRECT_APPLICATION_DOMAINS,
  registerApplicationDomains,
} = require('../lib/server/register-application-domains');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');

function options(context) {
  const service = () => Object.freeze({});
  return {
    applicationContext:context,
    config:{ APP_NAME:'Direct-Xfer' },
    platform:{ express() {} },
    services:{
      stateStore:service(),
      settingsService:service(),
      accountService:service(),
      networkServices:service(),
      sharePresentationService:service(),
      activityPresenceService:service(),
      auditService:service(),
      restoreService:service(),
      sessionService:service(),
      authService:service(),
      tlsManager:service(),
    },
    runtimeConstants:{ DAY_MS:86_400_000 },
    earlyAdapters:{ clientIp() {} },
  };
}

test('point 4 moves direct application-context publication out of server.js', () => {
  const server = read('server.js');
  const registrar = read('lib/server/register-application-domains.js');

  const publication = read('lib/server/application-publication.js');
  assert.match(server, /publishApplicationGraph\(\{[\s\S]*?applicationContext,/);
  assert.match(publication, /createApplicationDomainEntries\(direct\)/);
  assert.doesNotMatch(server, /applicationContext\.register\('config'/);
  assert.doesNotMatch(server, /applicationContext\.register\('state-store'/);
  assert.doesNotMatch(server, /applicationContext\.register\('early-adapters'/);
  assert.match(registrar, /applicationContext\.registerMany\(entries\)/);
});

test('direct domain registrar publishes the complete declared domain set', () => {
  const context = createApplicationContext();
  const registered = registerApplicationDomains(options(context));

  assert.deepEqual(registered, DIRECT_APPLICATION_DOMAINS);
  assert.deepEqual(context.domains(), DIRECT_APPLICATION_DOMAINS);
  for (const name of DIRECT_APPLICATION_DOMAINS) assert.ok(context.current(name), `missing ${name}`);
});

test('registerMany prevalidates the complete batch before mutating the context', () => {
  const context = createApplicationContext();
  const original = { existing:true };
  context.register('tls-manager', original);

  assert.throws(
    () => registerApplicationDomains(options(context)),
    /domain already registered: tls-manager/,
  );
  assert.deepEqual(context.domains(), ['tls-manager']);
  assert.equal(context.current('tls-manager'), original);
  assert.equal(context.current('config'), null);
  assert.equal(context.current('state-store'), null);
});

test('registerMany rejects invalid late entries and duplicate names without partial publication', () => {
  const invalid = createApplicationContext();
  assert.throws(
    () => invalid.registerMany([['first', {}], ['second', null]]),
    /domain second must be an object/,
  );
  assert.deepEqual(invalid.domains(), []);

  const duplicate = createApplicationContext();
  assert.throws(
    () => duplicate.registerMany([['same', {}], ['same', {}]]),
    /batch contains duplicate domain: same/,
  );
  assert.deepEqual(duplicate.domains(), []);
});


test('registerMany aborts on re-entrant context mutation without losing the external registration', () => {
  const context = createApplicationContext();
  const external = { external:true };
  let reentered = false;
  const first = new Proxy(['first', {}], {
    get(target, property, receiver) {
      if (property === '0' && !reentered) {
        reentered = true;
        context.register('external', external);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(
    () => context.registerMany([first, ['second', {}]]),
    /changed during registration batch preflight/,
  );
  assert.deepEqual(context.domains(), ['external']);
  assert.strictEqual(context.current('external'), external);
  assert.equal(context.current('first'), null);
  assert.equal(context.current('second'), null);
});

test('feature application boundaries use atomic application-context batches', () => {
  for (const rel of [
    'lib/server/runtime-services-application.js',
    'lib/server/notification-application.js',
    'lib/server/share-media-transfer-application.js',
    'lib/server/public-http-application.js',
  ]) {
    const source = read(rel);
    assert.match(source, /applicationContext\.registerMany\(applicationDomains\)/, `${rel} must publish atomically`);
    assert.doesNotMatch(source, /for \(const \[name, service\] of domains\) applicationContext\.register\(/, `${rel} must not publish one-by-one`);
  }
  const publication = read('lib/server/application-publication.js');
  assert.match(publication, /const publishedDomains = registerMany\(entries\)/);
});
