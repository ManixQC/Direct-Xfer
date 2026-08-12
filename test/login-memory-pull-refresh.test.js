'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const mobileHtml = fs.readFileSync(path.join(root, 'pwa', 'login.html'), 'utf8');
const mobileJs = fs.readFileSync(path.join(root, 'pwa', 'login.js'), 'utf8');
const loginVault = fs.readFileSync(path.join(root, 'public', 'login-vault.js'), 'utf8');
const pwaHtml = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const pwaJs = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const pwaCss = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('standard and mobile admin logins expose separate username/password memory choices', () => {
  assert.match(adminHtml, /id="remember-username"[^>]*type="checkbox"/);
  assert.match(adminHtml, /id="remember-password"[^>]*type="checkbox"/);
  assert.match(mobileHtml, /id="mobile-remember-username"[^>]*type="checkbox"/);
  assert.match(mobileHtml, /id="mobile-remember-password"[^>]*type="checkbox"/);
  assert.match(adminJs, /dx-login-remember-username/);
  assert.match(mobileJs, /dx-login-remember-password/);
});

test('password remembering uses the encrypted vault only when explicitly selected', () => {
  assert.match(adminHtml, /src="\/login-vault\.js"/);
  assert.match(mobileHtml, /src="\/app\/login-vault\.js(\?v=\d+)?"/);
  assert.match(server, /'\/login-vault\.js'/);
  assert.match(loginVault, /direct-xfer-login-vault/);
  assert.match(loginVault, /AES-GCM/);
  assert.match(loginVault, /generateKey\([\s\S]*false,[\s\S]*\['encrypt', 'decrypt'\]/);
  assert.match(loginVault, /crypto\.subtle\.encrypt/);
  assert.match(loginVault, /crypto\.subtle\.decrypt/);
  assert.match(adminJs, /DXLoginVault\.save\(username, password\)/);
  assert.match(adminJs, /DXLoginVault\.load\(\)/);
  assert.match(mobileJs, /DXLoginVault\.save\(username, secret\)/);
  assert.match(mobileJs, /DXLoginVault\.load\(\)/);
  assert.match(adminJs, /DXLoginVault\.clear\(\)/);
  assert.match(mobileJs, /DXLoginVault\.clear\(\)/);
  // Password memory must not use the browser password-credential store. A
  // WebAuthn passkey login legitimately uses navigator.credentials.get().
  assert.doesNotMatch(adminJs, /navigator\.credentials\.store\(|new PasswordCredential\(/);
  assert.doesNotMatch(mobileJs, /navigator\.credentials\.store\(|new PasswordCredential\(/);
  assert.match(adminHtml, /id="password"[\s\S]*?autocomplete="off"[\s\S]*?readonly/);
  assert.match(mobileHtml, /id="mobile-password"[^>]*autocomplete="off"[^>]*readonly/);
  assert.match(adminJs, /if \(!rememberPassword\) \{[\s\S]*DXLoginVault\.clear\(\)/);
  assert.match(mobileJs, /if \(!rememberPass\) \{[\s\S]*DXLoginVault\.clear\(\)/);
  assert.doesNotMatch(adminJs, /localStorage\.setItem\([^\n]*password/i);
  assert.doesNotMatch(mobileJs, /localStorage\.setItem\([^\n]*password/i);
});

test('mobile login and PWA support pull-to-refresh only from the top', () => {
  assert.match(mobileHtml, /id="mobile-pull-refresh"/);
  assert.match(pwaHtml, /id="pull-refresh"/);
  assert.match(mobileJs, /function installPullToRefresh\(\)/);
  assert.match(pwaJs, /function installPullToRefresh\(\)/);
  assert.match(pwaJs, /function atTop\(\) \{ return scroller\.scrollTop <= 0; \}/);
  assert.match(pwaJs, /event\.preventDefault\(\)/);
  assert.match(pwaJs, /setTimeout\(function \(\) \{ location\.reload\(\); \}, 180\)/);
  assert.match(pwaCss, /\.pull-refresh\.refreshing \.pull-refresh-icon/);
});

test('build and cache identifiers are synchronized', () => {
  const build = pwaJs.match(/APP_BUILD = '([^']+)'/)[1];
  assert.match(build, /^2026\.\d\d\.\d\d-pwa\d+$/);
  const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
  assert.match(sw, new RegExp("VERSION = '" + build.replace(/\./g, '\\.') + "'"));
});
