'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('pwa/index.html');
const loginHtml = read('pwa/login.html');
const app = read('pwa/app.js');
const login = read('pwa/login.js');
const server = read('server.js');

test('release and PWA caches are synchronized for 1.51.2', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.62.4');
  assert.match(app, /APP_VERSION = '1\.62\.4'/);
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa308'/);
  assert.match(html, /v1\.62\.4 · pwa308/);
  assert.match(html, /app\.js\?v=290/);
  assert.match(loginHtml, /login\.js\?v=274/);
});

test('biometric identification is a visible and explicit PWA setting', () => {
  assert.match(html, /id="passkey-section" class="setting-row biometric-setting"/);
  assert.doesNotMatch(html, /id="passkey-section"[^>]*\bhidden\b/);
  assert.match(html, /data-i18n="passkeyTitle">Identification biométrique</);
  assert.match(html, /id="biometric-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="add-passkey-btn"[^>]*disabled[^>]*data-i18n="passkeyAdd">Activer sur cet appareil</);
  assert.match(html, /id="reauth-biometric-btn"/);
});

test('settings report HTTPS, platform support and fresh-auth requirements', () => {
  assert.match(app, /function biometricSecureContext\(\)/);
  assert.match(app, /PublicKeyCredential\.isUserVerifyingPlatformAuthenticatorAvailable/);
  assert.match(app, /setBiometricStatus\('biometricHttpsRequired', 'error'\)/);
  assert.match(app, /setBiometricStatus\('biometricUnsupported', 'warn'\)/);
  assert.match(app, /deviceInfo\.passkeyManagement !== true/);
  assert.match(app, /reauthenticateForBiometric/);
  assert.match(app, /fetchWithTimeout\('\/app\/session\/lock'/);
  assert.match(app, /sessionStorage\.setItem\('dx-pwa-active-panel', 'settings'\)/);
});

test('biometric activation requests the built-in platform authenticator', () => {
  assert.match(server, /authenticatorAttachment: 'platform'/);
  assert.match(server, /userVerification: 'required'/);
  assert.match(server, /deviceId: currentDeviceId, deviceIds: \[currentDeviceId\]/);
  assert.match(server, /transports: passkeyTransports\(resp\.transports\)/);
  assert.match(server, /biometricEnabled: !!\(device && visibleAccount/);
  assert.match(app, /typeof res\.getTransports === 'function' \? res\.getTransports\(\) : \[\]/);
  assert.match(login, /transports: c\.transports/);
});

test('the PWA login page exposes a dedicated biometric action', () => {
  assert.match(loginHtml, /id="mobile-passkey-btn" class="mobile-login-passkey"/);
  assert.doesNotMatch(loginHtml, /id="mobile-passkey-btn"[^>]*class="[^"]*hidden/);
  assert.match(loginHtml, /data-i18n="passkeySignIn">👆 Identification biométrique</);
  assert.match(loginHtml, /id="mobile-biometric-hint"/);
  assert.match(login, /passkeySignIn: '👆 Identification biométrique'/);
  assert.match(login, /passkeyBtn\.disabled = false/);
  assert.match(login, /navigator\.credentials\.get\(\{ publicKey: publicKey \}\)/);
});

test('biometric UI has French, English and Spanish guidance', () => {
  assert.match(app, /passkeyTitle: 'Identification biométrique'/);
  assert.match(app, /passkeyTitle: 'Biometric identification'/);
  assert.match(app, /passkeyTitle: 'Identificación biométrica'/);
  assert.match(login, /biometricHttpsRequired: 'Utilisez une adresse HTTPS reconnue/);
  assert.match(login, /biometricHttpsRequired: 'Use a trusted HTTPS address/);
  assert.match(login, /biometricHttpsRequired: 'Usa una dirección HTTPS de confianza/);
});

test('multi-device enrollment excludes only credentials already bound here', () => {
  assert.match(server, /function passkeyDeviceIds\(passkey\)/);
  assert.match(server, /filter\(\(p\) => passkeyBoundToDevice\(p, req\.pwaDevice\.id\)\)/);
  assert.match(server, /deviceIds: \[currentDeviceId\]/);
  assert.match(server, /bindPasskeyToDevice\(pk, device\.id\)/);
  assert.match(server, /deviceId: req\.pwaDevice\.id/);
});

test('synchronized passkeys do not use a single global authenticator counter', () => {
  assert.match(server, /out\.be = !!\(out\.flags & 0x08\)/);
  assert.match(server, /backupEligible: parsed\.be/);
  assert.match(server, /if \(!parsed\.be\) \{/);
  assert.match(server, /if \(parsed\.signCount > Number\(pk\.counter \|\| 0\)\) pk\.counter = parsed\.signCount/);
});

test('the PWA explains duplicate, pairing, domain and server enrollment failures', () => {
  assert.match(app, /err\.name === 'InvalidStateError'/);
  assert.match(app, /err\.name === 'SecurityError'/);
  assert.match(app, /optError\.error === 'device-required'/);
  assert.match(app, /!deviceInfo\.paired \|\| !deviceInfo\.device/);
  assert.match(app, /deviceInfo\.biometricEnabled = passkeyRecords\.some/);
  for (const key of ['biometricPairRequired', 'biometricAlreadyEnabled', 'biometricAlreadySynced', 'biometricDomainMismatch', 'biometricServerRejected']) {
    assert.match(app, new RegExp(`${key}:`));
  }
});
