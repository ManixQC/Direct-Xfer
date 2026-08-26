'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRootRoutes } = require('../lib/server/root-routes');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function metaFor(asvsL3) {
  let payload = null;
  const routes = createRootRoutes({
    APP_NAME:'Direct-Xfer', APP_VERSION:'1.71.14', APP_YEAR:'2026', RELEASE_DATE:'2026-08-25',
    STORAGE_SETUP:{ inboxUnconfigured:false, imagesUnconfigured:false },
    ASVS_L3_MODE:asvsL3,
    updateState:{ available:false, latest:null },
  });
  routes.handleMeta({}, { setHeader() {}, json(value) { payload = value; } });
  return payload;
}

test('remember-password server policy is enabled normally and fail-closed in ASVS L3', () => {
  assert.equal(metaFor(false).loginPasswordStorageAllowed, true);
  assert.equal(metaFor(true).loginPasswordStorageAllowed, false);
});

for (const rel of ['public/login-vault.js', 'pwa/login-vault.js']) {
  test(`${rel} stores remembered passwords only as AES-GCM ciphertext behind server policy`, () => {
    const source = read(rel);
    assert.match(source, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
    assert.match(source, /generateKey\(\{ name:'AES-GCM', length:256 \}, false, \['encrypt', 'decrypt'\]\)/);
    assert.match(source, /getRandomValues\(new Uint8Array\(12\)\)/);
    assert.match(source, /subtle\.encrypt\(\{ name:'AES-GCM',[\s\S]*additionalData:aadBytes\(\)/);
    assert.match(source, /meta\.loginPasswordStorageAllowed === true/);
    assert.match(source, /if \(!result\.allowed\) await deleteDatabase\(\)/);
    assert.doesNotMatch(source, /localStorage|sessionStorage/);
    assert.doesNotMatch(source, /put\(\s*\{[^}]*password\s*:/s);
    const saveBody = source.slice(source.indexOf('async function save('), source.indexOf('async function load('));
    assert.ok(saveBody.indexOf('policyStatus(true)') >= 0);
    assert.ok(saveBody.indexOf('policyStatus(true)') < saveBody.indexOf('subtle.encrypt'));
  });
}

test('full login starts remember-password fail-closed and reveals it only after vault policy approval', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  assert.match(html, /id="remember-password-row"[^>]*class="login-check hidden"[^>]*aria-hidden="true"/);
  assert.match(html, /id="remember-password"[^>]*disabled/);
  assert.match(app, /adminPasswordVaultStatus\(\)/);
  assert.match(app, /passwordStorageAllowed = vaultStatus\.available === true && vaultStatus\.allowed === true/);
  assert.match(app, /renderAdminPasswordRememberPolicy\(passwordStorageAllowed\)/);
  assert.match(app, /await window\.DXLoginVault\.save\(username, password\)/);
});

test('mobile login uses the same fail-closed policy and encrypted vault', () => {
  const html = read('pwa/login.html');
  const app = read('pwa/login.js');
  assert.match(html, /id="mobile-remember-password-row"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(html, /id="mobile-remember-password"[^>]*disabled/);
  assert.match(app, /mobilePasswordVaultStatus\(\)/);
  assert.match(app, /passwordStorageAllowed = vaultStatus\.available === true && vaultStatus\.allowed === true/);
  assert.match(app, /renderMobilePasswordRememberPolicy\(passwordStorageAllowed\)/);
  assert.match(app, /await window\.DXLoginVault\.save\(username, secret\)/);
});
