'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { createServerConfig } = require('../lib/server/config');

test('ASVS V16.3.2 every admin authorization denial is audited via deny()', () => {
  const router = read('lib/server/admin-router.js');
  // The deny() helper records an "authz-denied" audit event (actor/role/IP derived
  // by auditReq from req.session) before returning the client response.
  assert.match(router, /function deny\(req, res, status, error, detail\)/);
  assert.match(router, /auditReq\(req, 'authz-denied',/);
  // L3 additionally records successful administrator authorization decisions at
  // the common router boundary, including reads of sensitive administration data.
  assert.match(router, /auditReq\(req, 'authz-granted',/);
  assert.match(router, /res\.once\('finish'/);
  // No raw 403 denial may bypass the audited deny() path.
  assert.doesNotMatch(router, /res\.status\(403\)\.json/);
  // Every role/ownership/read-only/password-change gate routes through deny().
  const denies = router.match(/return deny\(req, res, 403,/g) || [];
  assert.ok(denies.length >= 7, `expected >=7 audited denials, found ${denies.length}`);
  // The audit sink is injected into the admin boundary.
  assert.match(read('lib/server/admin-application.js'), /createAdminRouter\(\{ express, requireAuth, getAccountById, accountNeedsPwChange, getById, auditReq, asvsL3Mode:config\.ASVS_L3_MODE === true, hasRecentStrongAuthentication:session\.hasRecentStrongAuthentication \}\)/);
});

test('ASVS V5.2.6 decoded-pixel cap rejects pixel-flood images at every upload boundary', () => {
  const cfg = createServerConfig({ rootDir: ROOT });
  assert.equal(typeof cfg.IMAGE_MAX_PIXELS, 'number');
  assert.ok(cfg.IMAGE_MAX_PIXELS >= 1_000_000, 'a protective floor is enforced');

  // Both full-image upload modules reject images whose decoded pixel area exceeds
  // the configured cap, before any further processing, and clean up the file.
  for (const rel of ['lib/server/admin-photo-routes.js', 'lib/server/pwa-routes.js']) {
    const src = read(rel);
    const checks = src.match(/if \(dxPix && dxPix\.w \* dxPix\.h > IMAGE_MAX_PIXELS\) \{ fs\.unlink\(dest, \(\) => \{\}\); return res\.status\(413\)\.json\(\{ error:'image-too-many-pixels'/g) || [];
    assert.ok(checks.length >= 2, `${rel}: expected >=2 pixel-flood guards, found ${checks.length}`);
  }
});

test('ASVS V5.2.6 IMAGE_MAX_PIXELS honours an environment override within a safe floor', () => {
  const low = createServerConfig({ rootDir: ROOT, env: { IMAGE_MAX_PIXELS: '5' } });
  assert.equal(low.IMAGE_MAX_PIXELS, 1_000_000, 'clamped up to the protective floor');
  const custom = createServerConfig({ rootDir: ROOT, env: { IMAGE_MAX_PIXELS: '25000000' } });
  assert.equal(custom.IMAGE_MAX_PIXELS, 25_000_000);
});
