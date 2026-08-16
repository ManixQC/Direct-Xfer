'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const adminCss = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const pwaHtml = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const pwaCss = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const pwaJs = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'pwa', 'login.html'), 'utf8');
const loginCss = fs.readFileSync(path.join(root, 'pwa', 'login.css'), 'utf8');
const loginJs = fs.readFileSync(path.join(root, 'pwa', 'login.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const swSource = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');

test('login mobile-app link appears only on the full admin login opened from a mobile client', () => {
  assert.match(adminHtml, /id="login-view"[\s\S]*class="pwa-cta login-pwa[^"]*"[^>]+href="\/app"/);
  assert.match(adminCss, /\.pwa-cta\s*\{\s*display:\s*none;/);
  assert.match(adminCss, /html\.is-mobile #login-view \.login-pwa,\s*\nbody\.is-mobile #login-view \.login-pwa,[\s\S]*?display:\s*inline-flex/s);
  assert.doesNotMatch(adminCss, /(?:^|\n)\.login-pwa,?\s*(?:\n|\{)/);
  assert.doesNotMatch(adminCss, /@media[^}]*max-width[^}]*\.pwa-cta[^}]*display:\s*inline-flex/s);
});

test('standard authenticated view exposes the mobile install link only to detected mobile clients', () => {
  assert.match(adminHtml, /id="app-view"[\s\S]*class="pwa-cta pwa-install-cta[^"]*"[^>]+href="\/app\/"[^>]+data-i18n="pwa\.installApp"/);
  assert.match(adminCss, /html\.is-mobile\.pwa-install-offer #app-view \.pwa-install-cta,\s*\nbody\.is-mobile\.pwa-install-offer #app-view \.pwa-install-cta\s*\{[^}]*display:\s*inline-flex/s);
  assert.doesNotMatch(adminCss, /(?:^|\n)\.pwa-install-cta\s*\{[^}]*display:\s*inline-flex/s);
});

test('mobile PWA keeps an install entry visible on secure mobile browsers while Chrome prepares the native prompt', () => {
  assert.match(pwaHtml, /id="install-btn"[^>]+class="install-logo-button hidden"/);
  assert.match(pwaHtml, /id="install-diagnostic"[^>]+class="install-diagnostic hidden"/);
  assert.match(pwaJs, /function isInstallSecureOrigin\(\)/);
  assert.match(pwaJs, /var mobileInstallEntry = secureOrigin/);
  assert.match(pwaJs, /nativePromptReady \|\| iosInstallFlow \|\| mobileInstallEntry/);
  assert.match(pwaJs, /classList\.toggle\('install-pending'/);
  assert.match(pwaJs, /setInstallDiagnostic\('installHttpsRequired', 'error'/);
  assert.match(pwaJs, /clearInstallDiagnostic\(\);[\s\S]*updateInstallButtonVisibility\(false\);/);
  assert.match(pwaCss, /@media \(display-mode:\s*standalone\)\s*\{\s*#install-btn \{ display:\s*none !important; \}/s);
});

test('mobile administrator login exposes the install logo before and after beforeinstallprompt', () => {
  assert.match(loginHtml, /id="mobile-install-btn"[^>]+class="mobile-install-button hidden"/);
  assert.match(loginHtml, /class="mobile-install-badge">⇩<\/span>/);
  assert.match(loginCss, /\.mobile-install-button\s*\{[^}]*position:\s*absolute;[^}]*width:\s*58px;[^}]*height:\s*58px;/s);
  assert.match(loginJs, /window\.addEventListener\('beforeinstallprompt'/);
  assert.match(loginJs, /var show = !isStandaloneApp\(\) && isMobileLike\(\) && isInstallSecureOrigin\(\)/);
  assert.match(loginJs, /installButton\.classList\.toggle\('hidden', !show\)/);
  assert.match(loginJs, /installButton\.addEventListener\('click', requestMobileInstall\)/);
});

test('/app uses a dedicated mobile administrator login before opening the PWA shell', () => {
  assert.match(serverSource, /const PWA_PUBLIC_ASSET_PATHS = new Set\(\[/);
  assert.match(serverSource, /app\.get\('\/app', adminGuard,[\s\S]*?\/app\/login\?next=/);
  assert.match(serverSource, /app\.get\('\/app\/login', adminGuard,[\s\S]*?pwa', 'login\.html'/);
  assert.match(serverSource, /return res\.redirect\(302, '\/app\/login\?next=' \+ encodeURIComponent\(safePwaNext\(req\.originalUrl\)\)\);/);
  assert.doesNotMatch(serverSource, /PWA_PUBLIC_ASSET_PATHS[\s\S]{0,500}'\/'/);
  assert.match(loginHtml, /<title>Direct-Xfer — Connexion mobile<\/title>/);
  assert.match(loginHtml, /id="mobile-login-form"/);
  assert.match(loginHtml, /data-i18n="title">Connexion administrateur/);
  assert.match(loginCss, /\.mobile-login-card/);
  assert.match(loginJs, /fetchWithTimeout\('\/app\/login'/);
  assert.match(loginJs, /location\.replace\(safeNext\(\)\)/);
});

test('service worker does not cache a redirected login page as the authenticated PWA shell', () => {
  const build = pwaJs.match(/APP_BUILD = '([^']+)'/)[1];
  assert.match(swSource, new RegExp("var VERSION = '" + build.replace(/\./g, '\\.') + "';"));
  assert.match(swSource, /Never cache authenticated \/app\/ HTML/);
  assert.match(swSource, /caches\.match\('\/direct-xfer-pwa-shell\.html'\)/);
  assert.doesNotMatch(swSource, /cache\.put\(request,[^)]*\/app\//);
  assert.match(swSource, /url\.pathname === '\/app\/login'[\s\S]*Connexion administrateur indisponible hors ligne/);
});
