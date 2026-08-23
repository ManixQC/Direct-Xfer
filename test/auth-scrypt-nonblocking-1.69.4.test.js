'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = path.join(ROOT, 'lib', 'auth-utils.js');
const SERVER_PATH = path.join(ROOT, 'server.js');
const AUTH_SERVICE_PATH = path.join(ROOT, 'lib', 'server', 'auth-service.js');
const SESSION_SERVICE_PATH = path.join(ROOT, 'lib', 'server', 'session-service.js');
const PUBLIC_SHARE_ROUTES_PATH = path.join(ROOT, 'lib', 'server', 'public-share-routes.js');
const PUBLIC_ACCESS_SERVICE_PATH = path.join(ROOT, 'lib', 'server', 'public-access-service.js');
const SECURITY_AUTH_APPLICATION_PATH = path.join(ROOT, 'lib', 'server', 'security-auth-application.js');
const ROOT_ROUTES_PATH = path.join(ROOT, 'lib', 'server', 'root-routes.js');

function freshAuthModule() {
  delete require.cache[require.resolve(AUTH_PATH)];
  return require(AUTH_PATH);
}

test('request-time password hashing and verification use async scrypt, never scryptSync', async () => {
  const originalScrypt = crypto.scrypt;
  const originalScryptSync = crypto.scryptSync;
  try {
    crypto.scryptSync = () => { throw new Error('scryptSync must not run in request-time auth'); };
    crypto.scrypt = (plain, salt, keyLength, callback) => {
      setImmediate(() => callback(null, Buffer.alloc(keyLength, 0x5a)));
    };

    const auth = freshAuthModule();
    const hashed = await auth.hashPassword('correct horse battery staple');
    assert.equal(hashed.ok, true);
    const record = auth.parseHash(hashed.hash);
    assert.ok(record);

    const verified = await auth.verifyPassword('correct horse battery staple', record);
    assert.equal(verified.ok, true);
    // The fake worker result is deterministic, so the generated record verifies.
    assert.equal(verified.match, true);
  } finally {
    crypto.scrypt = originalScrypt;
    crypto.scryptSync = originalScryptSync;
    delete require.cache[require.resolve(AUTH_PATH)];
  }
});

test('scrypt work queue is concurrency-bounded and rejects overload before unbounded queuing', async () => {
  const originalScrypt = crypto.scrypt;
  const oldConcurrency = process.env.DIRECT_XFER_AUTH_SCRYPT_CONCURRENCY;
  const oldQueue = process.env.DIRECT_XFER_AUTH_SCRYPT_QUEUE;
  const callbacks = [];
  try {
    process.env.DIRECT_XFER_AUTH_SCRYPT_CONCURRENCY = '1';
    process.env.DIRECT_XFER_AUTH_SCRYPT_QUEUE = '1';
    crypto.scrypt = (plain, salt, keyLength, callback) => {
      callbacks.push(() => callback(null, Buffer.alloc(keyLength, 0x33)));
    };
    const auth = freshAuthModule();

    const first = auth.hashPassword('first-password');
    const second = auth.hashPassword('second-password');
    const third = await auth.hashPassword('third-password');

    assert.deepEqual(third, { ok: false, error: 'auth-busy' });
    assert.deepEqual(auth.authScryptStatus(), { active: 1, queued: 1, concurrency: 1, maxQueue: 1 });

    callbacks.shift()();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    // Completing the first task starts the queued second task synchronously.
    assert.equal(callbacks.length, 1);
    callbacks.shift()();
    const secondResult = await second;
    assert.equal(secondResult.ok, true);
    assert.equal(auth.authScryptStatus().active, 0);
    assert.equal(auth.authScryptStatus().queued, 0);
  } finally {
    crypto.scrypt = originalScrypt;
    if (oldConcurrency === undefined) delete process.env.DIRECT_XFER_AUTH_SCRYPT_CONCURRENCY;
    else process.env.DIRECT_XFER_AUTH_SCRYPT_CONCURRENCY = oldConcurrency;
    if (oldQueue === undefined) delete process.env.DIRECT_XFER_AUTH_SCRYPT_QUEUE;
    else process.env.DIRECT_XFER_AUTH_SCRYPT_QUEUE = oldQueue;
    delete require.cache[require.resolve(AUTH_PATH)];
  }
});

test('oversized passwords are rejected before expensive scrypt work', async () => {
  const originalScrypt = crypto.scrypt;
  let calls = 0;
  try {
    crypto.scrypt = (...args) => { calls += 1; originalScrypt(...args); };
    const auth = freshAuthModule();
    const tooLong = 'x'.repeat(auth.MAX_PASSWORD_CHARS + 1);
    const hashed = await auth.hashPassword(tooLong);
    assert.deepEqual(hashed, { ok: false, error: 'password-too-long' });
    const verified = await auth.verifyPassword(tooLong, { salt: Buffer.alloc(16), hash: Buffer.alloc(64) });
    assert.deepEqual(verified, { ok: true, match: false });
    assert.equal(calls, 0);
  } finally {
    crypto.scrypt = originalScrypt;
    delete require.cache[require.resolve(AUTH_PATH)];
  }
});

test('request auth is isolated behind async auth/session services and synchronous scrypt stays bootstrap-only', () => {
  const authSource = fs.readFileSync(AUTH_PATH, 'utf8');
  const authServiceSource = fs.readFileSync(AUTH_SERVICE_PATH, 'utf8');
  const sessionServiceSource = fs.readFileSync(SESSION_SERVICE_PATH, 'utf8');
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
  const securityAuthSource = fs.readFileSync(SECURITY_AUTH_APPLICATION_PATH, 'utf8');
  const stateBootstrapSource = fs.readFileSync(path.join(path.dirname(SERVER_PATH), 'lib/server/state-bootstrap-service.js'), 'utf8');
  const coreStateSource = fs.readFileSync(path.join(path.dirname(SERVER_PATH), 'lib/server/core-state-application.js'), 'utf8');
  const publicShareSource = fs.readFileSync(PUBLIC_SHARE_ROUTES_PATH, 'utf8');
  const publicAccessSource = fs.readFileSync(PUBLIC_ACCESS_SERVICE_PATH, 'utf8');
  const rootRoutesSource = fs.readFileSync(ROOT_ROUTES_PATH, 'utf8');

  assert.match(authSource, /crypto\.scrypt\(/);
  assert.match(authSource, /function hashPasswordSyncForStartup\(/);
  assert.equal((authSource.match(/crypto\.scryptSync\(/g) || []).length, 1);

  assert.match(authServiceSource, /async function attemptLogin\(/);
  assert.match(authServiceSource, /await passwordVerifier\(/);
  assert.match(authServiceSource, /async function verifyTotpOrRecoveryFor\(/);
  assert.match(sessionServiceSource, /function requireAuth\(/);
  assert.match(sessionServiceSource, /x-csrf-token/);
  assert.match(sessionServiceSource, /timingSafeEqualStr\(token, session\.csrf\)/);

  assert.match(serverSource, /createSecurityAuthApplication\(\{/);
  assert.match(securityAuthSource, /createAuthService\(\{/);
  assert.match(securityAuthSource, /createSessionService\(\{/);
  assert.doesNotMatch(serverSource, /createAuthService\(\{/);
  assert.doesNotMatch(serverSource, /createSessionService\(\{/);
  assert.match(authServiceSource, /const loginInFlight = new Set\(\)/);
  assert.match(authServiceSource, /passwordRecordsEqual\(verifiedRecord, currentRecord\)/);
  assert.match(securityAuthSource, /createPublicAccessService\(\{/);
  assert.doesNotMatch(serverSource, /createPublicAccessService\(\{/);
  assert.match(publicAccessSource, /const unlockAuthInFlight = new Set\(\)/);
  assert.doesNotMatch(serverSource, /const sessions = new Map\(/);
  assert.doesNotMatch(serverSource, /const loginAttempts = new Map\(/);
  assert.match(publicShareSource, /async function unlockHandler\(/);
  assert.match(publicShareSource, /const passwordCheck\s*=\s*await checkSharePassword\(s,\s*entered\)/);
  // The admin login handler (busy/503 handling) now lives in the extracted
  // entry-point route module; server.js only registers the route.
  assert.match(rootRoutesSource, /if \(result\.busy\)[\s\S]{0,180}status\(503\)/);

  assert.match(coreStateSource, /stateBootstrapService\.initialize\(\)/);
  const bootstrapEnd = stateBootstrapSource.indexOf('initAccounts();');
  assert.ok(bootstrapEnd > 0);
  const afterBootstrap = stateBootstrapSource.slice(bootstrapEnd + 'initAccounts();'.length);
  assert.doesNotMatch(afterBootstrap, /hashPasswordSyncForStartup\(/);
});
