'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const releaseVersion = JSON.parse(read('package.json')).version;
const releaseRe = releaseVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('CodeQL login redirect hardening never navigates directly to the next query value', () => {
  const login = read('pwa/login.js');
  const app = read('pwa/app.js');
  const standard = read('public/app.js');
  assert.doesNotMatch(login, /location\.replace\(safeNext\(\)\)/);
  assert.doesNotMatch(login, /:\s*safeNext\(\)\s*\)/);
  assert.match(login, /sessionStorage\.setItem\(POST_LOGIN_QUERY_KEY/);
  assert.match(login, /location\.replace\('\/app\/'\)/);
  assert.match(login, /target\.origin\s*!==\s*location\.origin/);
  assert.match(app, /sessionStorage\.getItem\('dx-pwa-post-login-query'\)/);
  assert.match(app, /var params = launchParams;/);
  assert.doesNotMatch(standard, /location\.replace\(safeNext\)/);
  assert.match(standard, /sessionStorage\.setItem\('dx-pwa-post-login-query'/);
  assert.match(standard, /location\.replace\('\/app\/'\)/);
});

test('CodeQL password-hash hardening removes request-time legacy SHA-256 verification', () => {
  const src = read('lib/server/public-access-service.js');
  assert.doesNotMatch(src, /createHash\(['"]sha256['"]\)/);
  assert.match(src, /Fast legacy password hashes are intentionally no longer verified/);
  assert.match(src, /return \{ ok: true, match: false \};/);
});

test('CodeQL HIBP range lookup keeps protocol SHA-1 out of the password-hash createHash sink', () => {
  const src = read('lib/auth-utils.js');
  assert.doesNotMatch(src, /createHash\(['"]sha1['"]\)/, 'auth-utils must not send password data through the createHash SHA-1 sink flagged by CodeQL');
  assert.match(src, /SHA-1 is required by the HIBP Pwned Passwords range protocol/);
  assert.match(src, /never persisted and is never accepted as[\s\S]{0,120}credential verifier/);
  assert.match(src, /async function hibpProtocolSha1Digest\(value\)/);
  assert.match(src, /crypto\.webcrypto\.subtle\.digest\('SHA-1', bytes\)/);
  assert.match(src, /const digest = await hibpProtocolSha1Digest\(plain\)/);
  assert.match(src, /const prefix = digest\.slice\(0, 5\)/);
  assert.match(src, /path: '\/range\/' \+ prefix/);
});

test('HIBP Web Crypto digest preserves the range prefix and suffix matching contract', async () => {
  const { EventEmitter } = require('node:events');
  const { checkPwnedPassword } = require('../lib/auth-utils');
  const expectedSuffix = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

  const result = await checkPwnedPassword('password', (options, onResponse) => {
    assert.equal(options.path, '/range/5BAA6');
    assert.equal(options.headers['Add-Padding'], 'true');

    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      response.destroy = () => {};
      queueMicrotask(() => {
        onResponse(response);
        response.emit('data', `${expectedSuffix}:42\n00000000000000000000000000000000000:0\n`);
        response.emit('end');
      });
    };
    return request;
  });

  assert.deepEqual(result, { ok: true, breached: true, count: 42 });
});

test('CodeQL OAuth URL boundaries validate protocols before browser URL sinks', () => {
  const app = read('public/app.js');
  const bridge = read('public/oauth-bridge.js');
  assert.match(app, /function connectorConfigSafeAuthUrl/);
  assert.match(app, /value\.startsWith\('https:\/\/'\)/);
  assert.doesNotMatch(app, /authLink\.href\s*=\s*data\.authUrl/);
  assert.match(app, /authLink\.href=safeAuthUrl/);
  assert.match(bridge, /value\.startsWith\('https:\/\/'\)/);
  assert.match(bridge, /parsed\.username\s*\|\|\s*parsed\.password/);
});

test('CodeQL generated-page hardening keeps server values out of inline JavaScript source', () => {
  const pages = read('lib/server/public-pages.js');
  const shares = read('lib/server/public-share-routes.js');
  assert.doesNotMatch(pages, /JSON\.stringify\(publicThemeMode\(\)\)/);
  assert.match(pages, /data-dx-default-theme=/);
  assert.match(pages, /getAttribute\('data-dx-default-theme'\)/);
  assert.doesNotMatch(shares, /const base=\$\{JSON\.stringify\(base\)\}/);
  assert.match(shares, /data-collab-base=/);
  assert.match(shares, /getAttribute\('data-collab-base'\)/);
});

test('CodeQL broker logs and URL tests do not expose or substring-trust sensitive configuration', () => {
  const broker = read('oauth-broker/server.js');
  const oauthTest = read('test/storage-connector-oauth-broker-1.67.20.test.js');
  assert.doesNotMatch(broker, /console\.log\([^\n]*(?:HOST|PORT|PUBLIC_URL|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)/);
  assert.match(broker, /OAuth Broker\] ready/);
  assert.match(oauthTest, /new URL\(create\[tokenUrlIndex \+ 1\]\)/);
  assert.match(oauthTest, /configuredTokenUrl\.hostname,'oauth\.example\.test'/);
  assert.doesNotMatch(oauthTest, /create\.includes\('https:\/\/oauth\.example\.test\/v1\/google\/token'\)/);
});

test('PWA security hotfix advances the shell and login cache generations without changing app version', () => {
  const sw = read('pwa/sw.js');
  const app = read('pwa/app.js');
  const loginHtml = read('pwa/login.html');
  const standardHtml = read('public/index.html');
  const bridgeHtml = read('public/oauth-bridge.html');
  assert.match(sw, /2026\.08\.26-pwa496/);
  assert.match(sw, /app\.js\?v=477/);
  assert.match(app, new RegExp(`APP_VERSION = '${releaseRe}'`));
  assert.match(app, /APP_BUILD = '2026\.08\.26-pwa496'/);
  assert.match(loginHtml, /login\.js\?v=321/);
  assert.match(loginHtml, /login-vault\.js\?v=477/);
  assert.match(standardHtml, /app\.js\?v=352/);
  assert.match(bridgeHtml, /oauth-bridge\.js\?v=4/);
});


test('OAuth callback keeps auth material server-side and stores no callback credential in cookies', () => {
  const server = read('oauth-broker/server.js');
  const worker = read('oauth-broker/cloudflare-worker/src/index.js');
  for (const src of [server, worker]) {
    assert.match(src, /browserHash/);
    assert.match(src, /state/);
    assert.match(src, /code_challenge_method/);
    assert.doesNotMatch(src, /newOAuthBrowserCookie/);
    assert.doesNotMatch(src, /oauthBrowserBinding/);
    assert.doesNotMatch(src, /callbackBinding/);
    assert.doesNotMatch(src, /callbackCookie/);
    assert.doesNotMatch(src, /set-cookie/i);
  }
});
