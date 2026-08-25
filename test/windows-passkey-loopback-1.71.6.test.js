'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWebauthnService } = require('../lib/server/webauthn-service');

const launcherPath = path.join(__dirname, '..', 'windows-launcher', 'Program.cs');
const launcher = fs.readFileSync(launcherPath, 'utf8');

function webauthnService(publicUrl = '') {
  return createWebauthnService({
    APP_NAME:'Direct-Xfer',
    PUBLIC_URL:publicUrl,
    crypto,
    getSession:() => null,
    getAccountById:() => null,
    pwaDevices:() => [],
    timingSafeEqualStr:(a, b) => String(a) === String(b),
  });
}

test('Windows launcher opens browser-facing Direct-Xfer URLs on localhost for WebAuthn compatibility', () => {
  assert.match(
    launcher,
    /OpenRuntimeUrl\(\)[\s\S]{0,700}?OpenUrl\(_runtimeScheme \+ ":\/\/localhost:" \+ _runtimePort/,
    'main browser URL must use localhost so passkeys can use the standards-defined loopback WebAuthn origin'
  );
  assert.match(
    launcher,
    /OpenPasswordReset\(\)[\s\S]{0,1800}?var url = scheme \+ ":\/\/localhost:" \+ _runtimePort/,
    'other launcher-opened browser pages should stay on the same canonical localhost origin'
  );
});

test('Windows launcher keeps private supervision traffic pinned to numeric loopback', () => {
  assert.match(
    launcher,
    /LauncherRequest\([\s\S]{0,900}?var url = scheme \+ ":\/\/127\.0\.0\.1:" \+ port/,
    'server-host supervision probes should remain numeric loopback and must not depend on name resolution'
  );
});

test('WebAuthn keeps the live localhost browser origin even when PUBLIC_URL points elsewhere', () => {
  const service = webauthnService('https://files.example.test');
  assert.deepEqual(
    service.webauthnRp({ protocol:'http', headers:{ host:'localhost:55750' } }),
    { id:'localhost', origin:'http://localhost:55750', name:'Direct-Xfer' }
  );
  assert.deepEqual(
    service.webauthnRp({ protocol:'https', headers:{ host:'localhost:55750' } }),
    { id:'localhost', origin:'https://localhost:55750', name:'Direct-Xfer' }
  );
});

test('WebAuthn still honors PUBLIC_URL for non-localhost deployments', () => {
  const service = webauthnService('https://dx.example.test:8443');
  assert.deepEqual(
    service.webauthnRp({ protocol:'http', headers:{ host:'10.0.0.4:55750' } }),
    { id:'dx.example.test', origin:'https://dx.example.test:8443', name:'Direct-Xfer' }
  );
});
