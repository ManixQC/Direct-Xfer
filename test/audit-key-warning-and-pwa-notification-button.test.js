
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('local audit key is healthy and obsolete AUDIT_HMAC_KEY recommendation is purged', () => {
  assert.match(server, /const auditKeyStatus = auditKeyMigrationStatus && auditKeyMigrationStatus\.ok === false \? 'bad' : 'ok';/);
  assert.match(server, /localKeyAccepted:auditActiveKeyMode === 'local-file'/);
  assert.doesNotMatch(server, /auditActiveKeyMode === 'local-file'\) warn\('audit-key-local'/);
  assert.match(server, /function purgeDeprecatedAuditKeyRecommendation\(\)/);
  assert.match(server, /n\.dedupeKey === 'system:audit-key-local'/);
});

test('PWA notification button stays enlarged and the obsolete Information bubble is absent', () => {
  assert.match(html, /id="pwa-notifications-menu"/);
  assert.doesNotMatch(html, /id="help-btn"/);
  assert.doesNotMatch(css, /#help-btn/);
  assert.match(css, /\.pwa-notifications-btn \{[^}]*width:60px !important;[^}]*height:60px;/s);
  assert.match(css, /\.pwa-header-actions \.pwa-notifications-btn \{[^}]*width:41px !important;[^}]*height:41px;/s);
});
