const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const server = read('server.js');
const admin = read('public/app.js');
const adminHtml = read('public/index.html');
const pwa = read('pwa/app.js');
const pwaHtml = read('pwa/index.html');

test('feature 31 stores account-scoped rules with four metrics and bounded trigger history', () => {
  assert.match(server, /CUSTOM_NOTIFICATION_RULE_METRICS = \['views','downloads','bytes_served','received_bytes'\]/);
  assert.match(server, /CUSTOM_NOTIFICATION_RULE_MAX = 50/);
  assert.match(server, /CUSTOM_NOTIFICATION_RULE_TRIGGER_MAX = 5000/);
  assert.match(server, /accountCustomNotificationRules\(accountId\)/);
  assert.match(server, /Return the account-owned objects/);
  assert.match(server, /return acc\.notificationRules;/);
  assert.match(server, /received_bytes'[\s\S]*pendingUsageForShare\(share\)/);
});

test('feature 31 exposes standard and PWA rule CRUD APIs', () => {
  assert.match(server, /adminRouter\.get\('\/notification-rules'/);
  assert.match(server, /adminRouter\.post\('\/notification-rules'/);
  assert.match(server, /adminRouter\.delete\('\/notification-rules\/:id'/);
  assert.match(server, /app\.get\('\/app\/notification-rules'/);
  assert.match(server, /app\.post\('\/app\/notification-rules'/);
  assert.match(server, /app\.post\('\/app\/notification-rules\/delete'/);
});

test('feature 31 fires threshold-center notifications and re-arms edits safely', () => {
  assert.match(server, /'custom-alert-rule':\['thresholds','success'\]/);
  assert.match(server, /evaluateCustomNotificationRulesForShare\(s\)/);
  assert.match(server, /rule\.triggered = \{\}; \/\/ editing a rule deliberately re-arms its threshold/);
  assert.match(server, /custom-rule:\$\{rule\.id\}:\$\{rule\.updatedAt\}:\$\{s\.id\}:\$\{rule\.threshold\}/);
});

test('feature 31 is configurable in both settings interfaces', () => {
  for (const id of ['cfg-notification-rule-metric','cfg-notification-rule-target','cfg-notification-rule-threshold','cfg-notification-rule-add','cfg-notification-rule-list']) assert.match(adminHtml, new RegExp(`id="${id}"`));
  assert.match(admin, /loadNotificationRules\(\)/);
  assert.match(admin, /\/api\/notification-rules/);
  for (const id of ['settings-notification-rule-metric','settings-notification-rule-target','settings-notification-rule-threshold','settings-notification-rule-add','settings-notification-rule-list']) assert.match(pwaHtml, new RegExp(`id="${id}"`));
  assert.match(pwa, /loadPwaNotificationRules\(\)/);
  assert.match(pwa, /\/app\/notification-rules/);
});

test('feature 35 remains enforced server-side and is now configurable from the PWA', () => {
  assert.match(server, /function rateForMeta\(meta\)/);
  assert.match(server, /rateConstraintsForMeta\(meta\)/);
  assert.match(server, /key:`link:\$\{s\.id\}`/);
  assert.match(server, /new Throttle\(\(\) => rateConstraintsForMeta\(transferMeta\)\)/);
  assert.match(server, /parseLinkRateKBps\(body\.rateKBps, \{ optional:true \}\)/);
  assert.match(server, /app\.post\('\/app\/host\/shares\/:token\/rate'/);
  assert.match(pwaHtml, /id="share-rate"/);
  assert.match(pwa, /rateKBps: rateValue/);
  assert.match(pwa, /editHostShareRate\(s\)/);
});

test('PWA cache is advanced for the new UI', () => {
  assert.match(pwa, /APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa306'/);
  assert.match(pwaHtml, /app\.js\?v=290/);
});
