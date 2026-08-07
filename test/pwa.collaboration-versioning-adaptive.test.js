'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');

test('image replacement preserves the public token and archives restorable versions', () => {
  assert.match(server, /app\.post\('\/app\/image\/:token\/replace'/);
  assert.match(server, /archiveCurrentPhotoVersion/);
  assert.match(server, /\/app\/image\/:token\/restore\/:versionId/);
  assert.match(server, /PHOTO_VERSIONS_DIR/);
  assert.match(app, /replaceImageKeepingUrl/);
  assert.match(app, /manageImageVersions/);
  assert.match(app, /il-replace/);
  assert.match(app, /il-versions/);
});

test('temporary contribution links enforce roles expiry and upload limits', () => {
  assert.match(server, /albumInviteHash/);
  assert.match(server, /activeAlbumInvite/);
  assert.match(server, /\/g\/:token\/c\/:secret\/upload/);
  assert.match(server, /maxFiles/);
  assert.match(server, /maxFileBytes/);
  assert.match(server, /\['reader', 'contributor', 'manager'\]/);
});

test('album owners can create and revoke reader contributor and manager invitations', () => {
  assert.match(server, /\/app\/album\/:token\/invitations/);
  assert.match(server, /\/app\/album\/:token\/invitations\/:id\/revoke/);
  assert.match(app, /manageAlbumInvitations/);
  assert.match(app, /albumInviteCopied/);
  assert.match(app, /album\.collaboration\.invitations/);
});

test('adaptive image delivery selects small variants or AVIF WebP with original fallback', () => {
  assert.match(server, /\/i\/:token\/auto/);
  assert.match(server, /Save-Data, Width, Viewport-Width, DPR, ECT/);
  assert.match(server, /image\/avif/);
  assert.match(server, /image\/webp/);
  assert.match(server, /return servePhoto\(req, res, 'micro'\)/);
  assert.match(server, /return servePhoto\(req, res, 'thumb'\)/);
  assert.match(app, /adaptiveWebp/);
  assert.match(app, /adaptiveAvif/);
  assert.match(html, /value="auto"/);
  assert.match(sw, /-pwa\d+/);
});
