'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('pwa/app.js');
const html = read('pwa/index.html');
const login = read('pwa/login.js');
const server = read('server.js');

test('1.51.2 exposes an explicit account-wide biometric disable action', () => {
  assert.match(html, /id="disable-biometric-btn"[^>]*disabled[^>]*data-i18n="biometricDisable"/);
  assert.match(app, /function disableBiometricIdentification\(\)/);
  assert.match(app, /askConfirmation\('biometric-disable-all', t\('biometricDisableConfirm'\)\)/);
  assert.match(app, /biometricDelete\('\/app\/webauthn\/passkeys'\)/);
  assert.match(app, /disable-biometric-btn'\)\.addEventListener\('click', disableBiometricIdentification\)/);
  assert.match(app, /biometricDisable: 'Désactiver l’identification biométrique'/);
  assert.match(app, /biometricDisable: 'Disable biometric identification'/);
  assert.match(app, /biometricDisable: 'Desactivar la identificación biométrica'/);
});

test('global disable is fresh-auth protected, audited and invalidates pending ceremonies', () => {
  assert.match(server, /app\.delete\('\/app\/webauthn\/passkeys', \(req, res\) => \{/);
  const route = server.indexOf("app.delete('/app/webauthn/passkeys',");
  const tail = server.slice(route, route + 900);
  assert.match(tail, /freshPasskeyManagementAccount\(req, res\)/);
  assert.match(tail, /acc\.passkeys = \[\]/);
  assert.match(tail, /clearWebauthnChallengesForAccount\(acc\.id\)/);
  assert.match(tail, /auditReq\(req, 'passkeys-disabled'/);
  assert.match(tail, /Cache-Control', 'no-store'/);
});

test('biometric list rendering has its own safe element builder', () => {
  const helper = app.indexOf('function el(tag, options)');
  const firstUse = app.indexOf("el('p', { class: 'muted sm'");
  assert.ok(helper >= 0 && helper < firstUse, 'element helper exists before biometric rendering');
  assert.match(app, /value !== null && value !== undefined && value !== false/);
  assert.match(app, /passkeyDevices', \{ n:deviceCount \}/);
});

test('deactivation remains possible when activation compatibility is unavailable', () => {
  const renderStart = app.indexOf('function renderPasskeySection()');
  const renderEnd = app.indexOf('function renderPasskeyList(', renderStart);
  const render = app.slice(renderStart, renderEnd);
  assert.ok(render.indexOf('deviceInfo.passkeyManagement !== true') < render.indexOf('loadPasskeys()'));
  assert.ok(render.indexOf('loadPasskeys()') < render.indexOf('detectBiometricCapability()'));
  assert.doesNotMatch(render, /if \(!biometricSecureContext\(\)\)[^{]*\{[^}]*return/);
  assert.match(app, /if \(disable\) disable\.disabled = !canManage \|\| !list\.length/);
});

test('biometric mutations and list loads cannot race each other', () => {
  assert.match(app, /biometricMutationInFlight = false/);
  assert.match(app, /function setBiometricMutationBusy\(busy\)/);
  assert.match(app, /if \(biometricMutationInFlight \|\| !passkeysLoaded \|\| !passkeyRecords\.length\) return/);
  assert.match(app, /if \(passkeysLoadPromise\) return passkeysLoadPromise/);
  assert.match(app, /passkeysLoadPromise = null/);
  assert.match(app, /if \(passkeysLoaded\) return \(list \|\| \[\]\)\.some/);
});

test('shared passkeys warn about their multi-device impact', () => {
  assert.match(app, /var count = Math\.max\(1, Number\(record\.deviceCount\) \|\| 1\)/);
  assert.match(app, /count > 1 \? t\('passkeyRemoveSharedConfirm'/);
  assert.match(server, /deviceCount: deviceIds\.length/);
});

test('WebAuthn challenges are bound to their RP context', () => {
  assert.match(server, /rpId: rp\.id, origin: rp\.origin/);
  assert.match(server, /const rp = \{ id: stored\.rpId, origin: stored\.origin \}/);
  assert.match(server, /if \(!rp\.id \|\| !rp\.origin\) throw new Error\('rp-context'\)/);
  assert.match(server, /clientData\.origin !== rp\.origin/);
});

test('WebAuthn credential and authenticator invariants are hardened', () => {
  assert.match(server, /timingSafeEqualStr\(credId, rawCredId\)/);
  assert.match(server, /if \(!stored\.accountId && !resp\.userHandle\) throw new Error\('user-handle-missing'\)/);
  assert.match(server, /if \(out\.bs && !out\.be\) throw new Error\('backup-state'\)/);
  assert.match(server, /function webauthnPublicKey\(jwk, alg\)/);
  assert.match(server, /jwk\.kty !== 'EC' \|\| jwk\.crv !== 'P-256'/);
  assert.match(server, /jwk\.kty !== 'RSA'/);
  assert.match(server, /bits && bits < 2048/);
  assert.match(server, /webauthnPublicKey\(jwk, alg\); \/\/ reject unusable, weak or algorithm-mismatched keys/);
});

test('login continues to submit id, rawId and userHandle for server validation', () => {
  assert.match(login, /id: assertion\.id, rawId: bufToB64u\(assertion\.rawId\)/);
  assert.match(login, /userHandle: r\.userHandle \? bufToB64u\(r\.userHandle\) : null/);
});
