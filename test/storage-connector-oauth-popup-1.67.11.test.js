'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('1.67.26 OAuth popup uses a Direct-Xfer bridge instead of about:blank', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/oauth-bridge.html'), 'utf8');
  const bridge = fs.readFileSync(path.join(ROOT, 'public/oauth-bridge.js'), 'utf8');

  assert.doesNotMatch(app, /window\.open\(['"]about:blank/);
  assert.match(app, /const bridge=`\/oauth-bridge\.html#/);
  assert.match(app, /window\.open\(bridge,'dx-rclone-oauth'\)/);
  assert.match(html, /src="\/oauth-bridge\.js(?:\?v=\d+)?"/);
  assert.match(bridge, /\/api\/storage\/remotes\/config\/\$\{encodeURIComponent\(sessionId\)\}/);
  assert.match(bridge, /location\.replace\(parsed\.href\)/);
  assert.match(bridge, /parsed\.protocol !== 'https:'/);
  assert.match(bridge, /oauthErrorDetail\(data\.error\)/);
  assert.match(bridge, /oauth-loopback-port-unavailable/);
});

test('1.67.26 OAuth browser window is prepared synchronously for automatic Google web callback', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(ROOT, 'public/oauth-bridge.js'), 'utf8');
  const start = app.indexOf('async function startGoogleWebOAuth');
  const end = app.indexOf('async function openConnectorConfigWizard', start);
  assert.ok(start >= 0 && end > start);
  const body = app.slice(start, end);
  assert.match(body, /connectorConfigPrepareAuthWindow\(\{type:'google-drive'\},true\)/);
  assert.match(body, /\/api\/storage\/remotes\/google-oauth\/start/);
  assert.ok(body.indexOf('connectorConfigPrepareAuthWindow') < body.indexOf("api('POST'"));
  assert.match(body, /connectorConfigOpenAuthUrl\(data\.authUrl\)/);
  assert.match(bridge, /dx-oauth-url/);
  assert.match(bridge, /location\.replace\(parsed\.href\)/);
});
