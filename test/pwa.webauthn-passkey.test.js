'use strict';
// Feature 8 — passkey / WebAuthn. There is no browser here, so this test plays the
// authenticator with Node crypto: it generates a P-256 key, hand-builds the CBOR
// attestation and a signed assertion, and drives the real server endpoints to
// prove the register -> passwordless-login round-trip verifies, and that a tampered
// signature or a wrong origin is rejected.
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const pwaSource = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'app.js'), 'utf8');
const pwaHtml = fs.readFileSync(path.join(__dirname, '..', 'pwa', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let child, base, port, tempRoot, logs = '';
const ADMIN_USER = 'passkey-admin';
const ADMIN_PASS = 'Passkey-runtime-2026!';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close((err) => err ? reject(err) : resolve(a.port)); });
  });
}
async function waitForServer(url) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child && child.exitCode != null) throw new Error(`server exited early\n${logs}`);
    try { const r = await fetch(url, { cache: 'no-store' }); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start\n${logs}`);
}
const B64U = (b) => Buffer.from(b).toString('base64url');
const FROMB64U = (s) => Buffer.from(String(s || ''), 'base64url');

// --- Minimal CBOR encoder (ints, byte/text strings, maps) ------------------
function cborTypeLen(major, n) {
  const mt = major << 5;
  if (n < 24) return Buffer.from([mt | n]);
  if (n < 256) return Buffer.from([mt | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = mt | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = mt | 26; b.writeUInt32BE(n, 1); return b;
}
const cborInt = (n) => (n < 0 ? cborTypeLen(1, -1 - n) : cborTypeLen(0, n));
const cborBytes = (buf) => Buffer.concat([cborTypeLen(2, buf.length), buf]);
const cborText = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([cborTypeLen(3, b.length), b]); };
const cborMap = (entries) => Buffer.concat([cborTypeLen(5, entries.length), ...entries.flat()]);

// A virtual platform authenticator holding one P-256 credential.
function makeAuthenticator(rpId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  const credId = crypto.randomBytes(32);
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  const cose = cborMap([
    [cborInt(1), cborInt(2)],   // kty: EC2
    [cborInt(3), cborInt(-7)],  // alg: ES256
    [cborInt(-1), cborInt(1)],  // crv: P-256
    [cborInt(-2), cborBytes(x)],
    [cborInt(-3), cborBytes(y)],
  ]);
  return {
    credId, privateKey,
    makeAttestation(flags) {
      const authData = Buffer.concat([
        rpIdHash, Buffer.from([flags]), Buffer.alloc(4), // signCount 0
        Buffer.alloc(16), // aaguid
        (() => { const l = Buffer.alloc(2); l.writeUInt16BE(credId.length); return l; })(),
        credId, cose,
      ]);
      return cborMap([[cborText('fmt'), cborText('none')], [cborText('attStmt'), cborMap([])], [cborText('authData'), cborBytes(authData)]]);
    },
    assertion(clientDataJSON, signCount, flags = 0x05) {
      const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), (() => { const c = Buffer.alloc(4); c.writeUInt32BE(signCount || 0); return c; })()]);
      const clientHash = crypto.createHash('sha256').update(clientDataJSON).digest();
      const signature = crypto.sign('sha256', Buffer.concat([authData, clientHash]), this.privateKey);
      return { authData, signature };
    },
  };
}

// Cookie jar over undici's getSetCookie().
function updateJar(jar, response) {
  for (const raw of (response.headers.getSetCookie ? response.headers.getSetCookie() : [])) {
    const kv = raw.split(';', 1)[0]; const eq = kv.indexOf('=');
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return jar;
}
const jarHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
async function jbody(r) { return r.json().catch(() => ({})); }

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-xfer-passkey-'));
  for (const n of ['data', 'host', 'inbox', 'images']) fs.mkdirSync(path.join(tempRoot, n), { recursive: true });
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS,
      DATA_DIR: path.join(tempRoot, 'data'), HOST_ROOT: path.join(tempRoot, 'host'), INBOX_DIR: path.join(tempRoot, 'inbox'),
      IMAGES_DIR: path.join(tempRoot, 'images'), UPDATE_CHECK: 'false', PUBLIC_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });
  await waitForServer(`${base}/api/meta`);
});
after(async () => {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function passwordLogin() {
  const jar = {};
  const r = await fetch(`${base}/app/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }) });
  assert.equal(r.status, 200, logs);
  updateJar(jar, r);
  const b = await jbody(r);
  return { jar, csrf: b.csrf };
}
async function registerPasskey(auth, jar, csrf, origin, flags = 0x45) {
  const opt = await fetch(`${base}/app/webauthn/register/options`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: base, Cookie: jarHeader(jar) }, body: '{}' });
  assert.equal(opt.status, 200, logs);
  const { token, publicKey } = await jbody(opt);
  assert.equal(publicKey.authenticatorSelection.userVerification, 'required');
  assert.equal(publicKey.authenticatorSelection.authenticatorAttachment, 'platform');
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: publicKey.challenge, origin: origin || base, crossOrigin: false }));
  const attestationObject = auth.makeAttestation(flags); // UP | UV | AT
  return fetch(`${base}/app/webauthn/register/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: base, Cookie: jarHeader(jar) },
    body: JSON.stringify({ token, name: 'Test key', credential: { id: B64U(auth.credId), rawId: B64U(auth.credId), type: 'public-key', response: { clientDataJSON: B64U(clientDataJSON), attestationObject: B64U(attestationObject), transports: ['internal', 'invalid-transport'] } } }),
  });
}
async function loginWithPasskey(auth, { origin, signCount, tamper, flags } = {}) {
  const jar = {};
  const opt = await fetch(`${base}/app/webauthn/login/options`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: ADMIN_USER }) });
  assert.equal(opt.status, 200, logs);
  const { token, publicKey } = await jbody(opt);
  assert.equal(publicKey.userVerification, 'required');
  assert.ok(publicKey.allowCredentials.some((c) => c.id === B64U(auth.credId)), 'options list the registered credential');
  assert.deepEqual(publicKey.allowCredentials.find((c) => c.id === B64U(auth.credId)).transports, ['internal']);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: publicKey.challenge, origin: origin || base, crossOrigin: false }));
  const { authData, signature } = auth.assertion(clientDataJSON, signCount == null ? 1 : signCount, flags);
  const sig = tamper ? Buffer.concat([signature.subarray(0, signature.length - 1), Buffer.from([signature[signature.length - 1] ^ 0xff])]) : signature;
  const r = await fetch(`${base}/app/webauthn/login/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token, credential: { id: B64U(auth.credId), rawId: B64U(auth.credId), type: 'public-key', response: { clientDataJSON: B64U(clientDataJSON), authenticatorData: B64U(authData), signature: B64U(sig) } } }),
  });
  updateJar(jar, r);
  return { r, jar };
}

test('register a passkey, then sign in with it passwordlessly', async () => {
  const { jar, csrf } = await passwordLogin();
  const rpId = new URL(base).hostname;
  const auth = makeAuthenticator(rpId);
  const reg = await registerPasskey(auth, jar, csrf, base);
  assert.equal(reg.status, 200, JSON.stringify(await jbody(reg.clone())) + logs);
  const regBody = await jbody(reg);
  assert.ok(regBody.ok && regBody.id);
  assert.ok(regBody.passkeys.some((p) => p.name === 'Test key' && p.currentDevice === true));

  const status = await fetch(`${base}/app/device/status`, { headers: { Cookie: jarHeader(jar) }, cache: 'no-store' });
  assert.equal(status.status, 200);
  assert.equal((await jbody(status)).biometricEnabled, true);

  const { r, jar: sessionJar } = await loginWithPasskey(auth, { signCount: 5 });
  assert.equal(r.status, 200, JSON.stringify(await jbody(r.clone())) + logs);
  const body = await jbody(r);
  assert.equal(body.ok, true);
  assert.equal(body.role, 'owner');
  assert.equal(body.username, ADMIN_USER);
  assert.ok(body.csrf);

  // The session minted by the passkey login must actually work.
  const shares = await fetch(`${base}/api/shares`, { headers: { Cookie: jarHeader(sessionJar) }, cache: 'no-store' });
  assert.equal(shares.status, 200, 'passkey session authorizes API calls');

  // A paired-device capability alone must not be able to add/remove passkeys.
  assert.ok(sessionJar.dxpwa, 'passkey login also pairs the PWA device');
  const pairedOnly = await fetch(`${base}/app/webauthn/passkeys`, { headers: { Cookie: `dxpwa=${sessionJar.dxpwa}` }, cache: 'no-store' });
  assert.equal(pairedOnly.status, 401);
  assert.equal((await jbody(pairedOnly)).error, 'recent-auth-required');

  // Auto-lock revokes both the fresh session and its paired-device capability.
  const lock = await fetch(`${base}/app/session/lock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': body.csrf, Origin: base, Cookie: jarHeader(sessionJar) }, body: JSON.stringify({ reason: 'test-idle' }),
  });
  assert.equal(lock.status, 200, JSON.stringify(await jbody(lock.clone())));
  const locked = await fetch(`${base}/app/device/status`, { headers: { Cookie: jarHeader(sessionJar) }, cache: 'no-store' });
  assert.equal(locked.status, 401, 'locked device requires a new password/passkey ceremony');
});

test('a second PWA device can register its own biometric credential', async () => {
  const rpId = new URL(base).hostname;
  const firstLogin = await passwordLogin();
  const firstAuthenticator = makeAuthenticator(rpId);
  const firstRegistration = await registerPasskey(firstAuthenticator, firstLogin.jar, firstLogin.csrf, base);
  assert.equal(firstRegistration.status, 200, JSON.stringify(await jbody(firstRegistration.clone())) + logs);

  const secondLogin = await passwordLogin();
  const secondOptionsResponse = await fetch(`${base}/app/webauthn/register/options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': secondLogin.csrf, Origin: base, Cookie: jarHeader(secondLogin.jar) },
    body: '{}',
  });
  assert.equal(secondOptionsResponse.status, 200, logs);
  const secondOptions = (await jbody(secondOptionsResponse)).publicKey;
  assert.ok(!secondOptions.excludeCredentials.some((credential) => credential.id === B64U(firstAuthenticator.credId)), 'another device credential is not excluded on this device');

  const secondAuthenticator = makeAuthenticator(rpId);
  const secondRegistration = await registerPasskey(secondAuthenticator, secondLogin.jar, secondLogin.csrf, base);
  assert.equal(secondRegistration.status, 200, JSON.stringify(await jbody(secondRegistration.clone())) + logs);
  const secondBody = await jbody(secondRegistration);
  const firstRecord = secondBody.passkeys.find((passkey) => passkey.id === B64U(firstAuthenticator.credId));
  const secondRecord = secondBody.passkeys.find((passkey) => passkey.id === B64U(secondAuthenticator.credId));
  assert.ok(firstRecord && firstRecord.currentDevice === false);
  assert.ok(secondRecord && secondRecord.currentDevice === true);

  const sameDeviceOptionsResponse = await fetch(`${base}/app/webauthn/register/options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': secondLogin.csrf, Origin: base, Cookie: jarHeader(secondLogin.jar) },
    body: '{}',
  });
  const sameDeviceOptions = (await jbody(sameDeviceOptionsResponse)).publicKey;
  assert.ok(sameDeviceOptions.excludeCredentials.some((credential) => credential.id === B64U(secondAuthenticator.credId)), 'the current device credential is still protected against duplicate registration');
  assert.ok(!sameDeviceOptions.excludeCredentials.some((credential) => credential.id === B64U(firstAuthenticator.credId)));
});

test('a tampered assertion signature is rejected', async () => {
  const { jar, csrf } = await passwordLogin();
  const auth = makeAuthenticator(new URL(base).hostname);
  assert.equal((await registerPasskey(auth, jar, csrf, base)).status, 200, logs);
  const { r } = await loginWithPasskey(auth, { tamper: true });
  assert.equal(r.status, 401);
  assert.equal((await jbody(r)).error, 'passkey-failed');
});

test('an assertion for the wrong origin is rejected', async () => {
  const { jar, csrf } = await passwordLogin();
  const auth = makeAuthenticator(new URL(base).hostname);
  assert.equal((await registerPasskey(auth, jar, csrf, base)).status, 200, logs);
  const { r } = await loginWithPasskey(auth, { origin: 'https://evil.example' });
  assert.equal(r.status, 401);
});

test('registration with presence but without user verification is rejected', async () => {
  const { jar, csrf } = await passwordLogin();
  const auth = makeAuthenticator(new URL(base).hostname);
  const opt = await fetch(`${base}/app/webauthn/register/options`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: base, Cookie: jarHeader(jar) }, body: '{}' });
  const { token, publicKey } = await jbody(opt);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: publicKey.challenge, origin: base }));
  const attestationObject = auth.makeAttestation(0x41); // UP | AT but NOT UV
  const reg = await fetch(`${base}/app/webauthn/register/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: base, Cookie: jarHeader(jar) },
    body: JSON.stringify({ token, credential: { id: B64U(auth.credId), type: 'public-key', response: { clientDataJSON: B64U(clientDataJSON), attestationObject: B64U(attestationObject) } } }),
  });
  assert.equal(reg.status, 400);
});

test('an assertion without user verification is rejected', async () => {
  const { jar, csrf } = await passwordLogin();
  const auth = makeAuthenticator(new URL(base).hostname);
  assert.equal((await registerPasskey(auth, jar, csrf, base)).status, 200, logs);
  const { r } = await loginWithPasskey(auth, { flags: 0x01 }); // UP but NOT UV
  assert.equal(r.status, 401);
  assert.equal((await jbody(r)).error, 'passkey-failed');
});

test('a non-zero authenticator counter cannot reset to zero', async () => {
  const { jar, csrf } = await passwordLogin();
  const auth = makeAuthenticator(new URL(base).hostname);
  assert.equal((await registerPasskey(auth, jar, csrf, base)).status, 200, logs);
  assert.equal((await loginWithPasskey(auth, { signCount: 5 })).r.status, 200);
  const reset = await loginWithPasskey(auth, { signCount: 0 });
  assert.equal(reset.r.status, 401);
  assert.equal((await jbody(reset.r)).error, 'passkey-failed');
});

test('a synchronized multi-device passkey accepts independent counters', async () => {
  const { jar, csrf } = await passwordLogin();
  const auth = makeAuthenticator(new URL(base).hostname);
  assert.equal((await registerPasskey(auth, jar, csrf, base, 0x4d)).status, 200, logs); // UP | UV | BE | AT
  assert.equal((await loginWithPasskey(auth, { signCount: 5, flags: 0x0d })).r.status, 200);
  const fromAnotherDevice = await loginWithPasskey(auth, { signCount: 1, flags: 0x0d }); // UP | UV | BE
  assert.equal(fromAnotherDevice.r.status, 200, JSON.stringify(await jbody(fromAnotherDevice.r.clone())) + logs);
});

test('global biometric disable removes every passkey and invalidates pending challenges', async () => {
  const { jar, csrf } = await passwordLogin();
  const auth = makeAuthenticator(new URL(base).hostname);
  assert.equal((await registerPasskey(auth, jar, csrf, base)).status, 200, logs);

  const registrationOptionsResponse = await fetch(`${base}/app/webauthn/register/options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: base, Cookie: jarHeader(jar) }, body: '{}',
  });
  const registrationOptions = await jbody(registrationOptionsResponse);

  const loginOptionsResponse = await fetch(`${base}/app/webauthn/login/options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: ADMIN_USER }),
  });
  const loginOptions = await jbody(loginOptionsResponse);

  const disabled = await fetch(`${base}/app/webauthn/passkeys`, {
    method: 'DELETE', headers: { 'X-CSRF-Token': csrf, Origin: base, Cookie: jarHeader(jar) },
  });
  assert.equal(disabled.status, 200, JSON.stringify(await jbody(disabled.clone())) + logs);
  const disabledBody = await jbody(disabled);
  assert.ok(disabledBody.removed > 0);
  assert.deepEqual(disabledBody.passkeys, []);

  const staleRegistration = await fetch(`${base}/app/webauthn/register/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: base, Cookie: jarHeader(jar) },
    body: JSON.stringify({ token: registrationOptions.token }),
  });
  assert.equal(staleRegistration.status, 400);
  assert.equal((await jbody(staleRegistration)).error, 'challenge-expired');

  const staleLogin = await fetch(`${base}/app/webauthn/login/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token: loginOptions.token }),
  });
  assert.equal(staleLogin.status, 400);
  assert.equal((await jbody(staleLogin)).error, 'challenge-expired');

  const unavailable = await fetch(`${base}/app/webauthn/login/options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: ADMIN_USER }),
  });
  assert.equal(unavailable.status, 404);
  assert.equal((await jbody(unavailable)).error, 'passkey-unavailable');
});

test('passkey registration requires authentication', async () => {
  const anon = await fetch(`${base}/app/webauthn/register/options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);
});

test('a username with no passkey cannot fall through to another resident credential', async () => {
  const r = await fetch(`${base}/app/webauthn/login/options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'account-without-passkeys' }),
  });
  assert.equal(r.status, 404);
  assert.equal((await jbody(r)).error, 'passkey-unavailable');
});

test('PWA wires passkey management and configurable biometric auto-lock', () => {
  assert.match(pwaHtml, /id="auto-lock-select"/);
  assert.match(pwaHtml, /<option value="15"[^>]*selected>/);
  assert.match(pwaSource, /\$\('add-passkey-btn'\)\.addEventListener\('click', addPasskey\)/);
  assert.match(pwaSource, /function closedLaunchNeedsLock\(\)/);
  assert.match(pwaSource, /fetchWithTimeout\('\/app\/session\/lock'/);
  assert.match(pwaSource, /localStorage\.setItem\('dx-pwa-pagehide-at'/);
  assert.match(serverSource, /const PASSKEY_MANAGEMENT_FRESH_MS = 10 \* 60 \* 1000/);
  assert.match(serverSource, /authenticatedAt: Number\(s\.authenticatedAt\) \|\| 0/);
  assert.match(serverSource, /passkeyManagement: !!\(session && session\.authenticatedAt/);
  assert.match(serverSource, /stored\.accountId && String\(acc\.id\) !== String\(stored\.accountId\)/);
});
