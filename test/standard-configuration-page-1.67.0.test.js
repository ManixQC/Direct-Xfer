'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const app = read('public/app.js');
const css = read('public/style.css');
const server = read('server.js');
const httpApplication = read('lib/server/http-application.js');
const adminStorage = read('lib/server/admin-storage-routes.js');
const connectorJobs = read('lib/server/storage-connector-job-service.js');

test('1.67.26 Configuration is a dedicated full page instead of an overlay modal', () => {
  assert.match(html, /<main id="config-page" class="app-view hidden">/);
  assert.match(html, /<form id="config-form" autocomplete="off">/);
  assert.doesNotMatch(html, /id="config-overlay"/);
  assert.match(html, /id="config-close"[\s\S]{0,300}<svg/);
  assert.match(css, /#config-page #config-form\s*\{[\s\S]*?overflow:\s*visible/);
});

test('1.67.26 Configuration has a real URL and participates in SPA history navigation', () => {
  assert.match(app, /const CONFIG_PATH = '\/configuration';/);
  assert.match(app, /function configPageOpen\(\)/);
  assert.match(app, /function showConfigView\(\)/);
  assert.match(app, /history\.pushState\(\{ dxView:'config' \}, '', CONFIG_PATH\)/);
  assert.match(app, /if \(location\.pathname === CONFIG_PATH\)/);
  assert.match(httpApplication, /'\/configuration'/);
  assert.match(httpApplication, /app\.get\(route, adminGuard/);
});

test('1.67.26 Configuration page is owner/admin only and moves shared account controls into its top bar', () => {
  assert.match(app, /if \(!\['owner','admin',''\]\.includes\(state\.role \|\| ''\)\) return false;/);
  assert.match(app, /config: '#config-page \.topbar-menus'/);
  assert.match(app, /placeUserMenu\('config'\)/);
  assert.match(app, /'config-page'(?:, 'notifications-page')?\]\.some/);
});

test('1.67.26 optional rclone absence cannot turn connector listing into an HTTP 500', () => {
  assert.match(connectorJobs, /capabilities = \{ available:false, error:/);
  assert.match(adminStorage, /adminRouter\.get\('\/storage\/connectors',[\s\S]*?probeForConfiguration\(\)[\s\S]*?capabilities:\s*\{[\s\S]*?available:\s*false/);
  assert.match(adminStorage, /connectorStore\(\)\.map\(publicConnector\)\.filter\(Boolean\)/);
  assert.match(app, /cap\.className = 'sm ' \+ \(available \? 'cfg-ok' : 'cfg-warn'\)/);
  assert.match(app, /rclone n’est pas installé ou est indisponible/);
});

test('1.67.26 connector job polling follows Configuration page visibility, not the removed modal', () => {
  assert.match(app, /\['queued','running'\]\.includes\(job\.status\)\) && configPageOpen\(\)/);
  assert.doesNotMatch(app, /config-overlay/);
});

test('1.67.26 logout clears sensitive Configuration-page fields and account-specific connector output', () => {
  assert.match(app, /#config-page input\[type=\"password\"\]/);
  assert.match(app, /#config-page input\[type=\"file\"\]/);
  assert.match(app, /#config-page textarea/);
  assert.match(app, /\['connector-list','connector-jobs','connector-capability','connector-editor-status','connector-transfer-status'\]/);
});
