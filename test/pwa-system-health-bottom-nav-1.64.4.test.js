'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const releaseVersion = JSON.parse(read('package.json')).version;
const releaseRe = releaseVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const html = read('pwa/index.html');
const app = read('pwa/app.js');
const css = read('pwa/app.css');
const advanced = read('pwa/admin-advanced.js');
const extras = read('pwa/admin-audit-connectors.js');

test('PWA System Health tab sits between Activity and Settings and is admin-gated', () => {
  const activity = html.indexOf('data-pwa-nav="activity"');
  const health = html.indexOf('data-pwa-nav="system-health"');
  const settings = html.indexOf('data-pwa-nav="settings"');
  assert.ok(activity >= 0 && health > activity && settings > health);
  assert.match(html, /class="pwa-nav-item hidden"[^>]+data-pwa-nav="system-health"[^>]+aria-hidden="true"/);
  assert.match(app, /function syncSystemHealthNavAccess\(enabled\)/);
  assert.match(app, /dx-pwa-admin-access/);
  assert.match(app, /systemHealthAccessResolved = true/);
  assert.match(app, /systemHealthAccessEnabled = enabled/);
  assert.match(app, /pendingSystemHealthPanel = false/);
  assert.match(app, /activePwaPanel === 'system-health'\) activatePwaPanel\('settings'/);
});

test('System Health is a first-class PWA panel and opens its health card', () => {
  assert.match(app, /'system-health': \{ label: 'navSystemHealth', hint: 'navSystemHealthHint' \}/);
  assert.match(app, /panel === 'system-health'[\s\S]*?dx-admin-advanced-card[\s\S]*?open = true/);
  assert.match(app, /launchAction === 'system-health'[\s\S]*?activatePwaPanel\('system-health'/);
  assert.match(app, /systemHealthAccessEnabled[\s\S]*?\['send', 'images', 'shares', 'activity', 'system-health', 'settings'\][\s\S]*?\['send', 'images', 'shares', 'activity', 'settings'\]/);
});

test('advanced health center no longer belongs to Settings and refreshes only on its panel', () => {
  assert.match(advanced, /c\.open=true;c\.setAttribute\('data-pwa-panel','system-health'\)/);
  assert.match(advanced, /data-pwa-active-panel'\)==='system-health'/);
  assert.doesNotMatch(advanced, /setAttribute\('data-pwa-panel','settings'\)/);
  assert.match(advanced, /title:'Santé Système'/);
  assert.match(advanced, /action=system-health/);
  assert.match(extras, /data-pwa-active-panel'\)==='system-health'/);
});

test('bottom navigation expands from five to six equal columns only for owner/admin', () => {
  assert.match(css, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.pwa-bottom-nav\.has-system-health \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}/);
  assert.match(app, /nav\.classList\.toggle\('has-system-health', enabled\)/);
  assert.match(css, /text-overflow: ellipsis/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.pwa-nav-item \{ min-height: 57px; font-size: \.62rem; padding-inline: 0; \}/);
  assert.match(css, /\.pwa-nav-item \.pwa-nav-icon svg \{ width: 19px; height: 19px; \}/);
});

test('all System Health entry points are centrally access-gated and initial non-admin access is announced', () => {
  assert.match(app, /panel === 'system-health' && !systemHealthAccessEnabled/);
  assert.match(app, /pendingSystemHealthPanel = !systemHealthAccessResolved/);
  assert.match(app, /options\.userInitiated && panel !== 'system-health'/);
  assert.match(app, /shortcutPanels = systemHealthAccessEnabled/);
  assert.match(advanced, /var accessAnnounced = false/);
  assert.match(advanced, /previous!==adminAccess\|\|!accessAnnounced/);
  assert.match(advanced, /data-pwa-admin-access/);
  assert.match(app, /announcedAdminAccess = document\.body\.getAttribute\('data-pwa-admin-access'\)/);
  assert.match(app, /syncSystemHealthNavAccess\(announcedAdminAccess === '1'\)/);
});

test('PWA shell generation is pwa495 while application version stays 1.71.32', () => {
  assert.equal(JSON.parse(read('package.json')).version, releaseVersion);
  for (const file of ['pwa/index.html','pwa/app.js','pwa/sw.js','pwa/theme-init.js','pwa/admin-advanced.js','pwa/mobile-intelligence.js']) {
    assert.match(read(file), /pwa495|v=476/);
    assert.doesNotMatch(read(file), /pwa329|v=329/);
  }
});
