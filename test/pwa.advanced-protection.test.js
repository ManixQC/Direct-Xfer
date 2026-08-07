'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');

function hasId(id) {
  return new RegExp(`id=["']${id}["']`).test(html);
}

test('21. PWA images support per-link hotlink allowlists', () => {
  assert.ok(hasId('img-hotlink-hosts'));
  assert.match(js, /hotlinkHosts:\s*\$\('img-hotlink-hosts'\)/);
  assert.match(server, /function parseHotlinkHosts\(input\)/);
  assert.match(server, /Object\.prototype\.hasOwnProperty\.call\(share, 'hotlinkHosts'\)/);
  assert.match(server, /if \(!hotlinkAllowed\(req, s\)\) return sendError\(req, res, 403, 'hotlinkBlocked'\)/);
  assert.match(server, /direct navigation \/ privacy-stripped Referer/);
});

test('22. first image view can trigger owner notifications and live PWA refresh', () => {
  assert.ok(hasId('img-notify-first-view'));
  assert.match(server, /if \(s\.notifyFirstView && !s\.firstViewNotifiedAt\)/);
  assert.match(server, /notifyFirstPhotoView\(s, req, kind, ip, geo\)/);
  assert.match(server, /type: 'image-first-view'/);
  assert.match(js, /d\.type === 'image-first-view'/);
  assert.match(worker, /data\.kind === 'image-first-view'/);
});

test('24. destructive image retention is owner-scoped, disabled by default and configurable', () => {
  for (const id of ['img-retention-enabled', 'img-retention-age', 'img-retention-inactive', 'img-retention-views', 'img-retention-storage', 'img-retention-save']) {
    assert.ok(hasId(id), `missing ${id}`);
  }
  assert.match(server, /app\.get\('\/app\/images\/retention'/);
  assert.match(server, /app\.post\('\/app\/images\/retention'/);
  assert.match(server, /enabled:\s*!!b\.enabled/);
  assert.match(server, /ownerKeyForPhoto\(s\) === ownerKey/);
  assert.match(server, /setInterval\(runAllPwaImageRetention, 5 \* 60 \* 1000\)/);
  assert.match(js, /window\.confirm\(t\('imgRetentionWarning'\)\)/);
});

test('27. smart blur is local, reviewable and supports faces, plates and manual regions', () => {
  assert.ok(hasId('img-smart-blur'));
  assert.ok(hasId('ann-detect-faces'));
  assert.ok(hasId('ann-detect-plates'));
  assert.match(js, /async function openSmartBlurReview\(file, mode\)/);
  assert.match(js, /new FaceDetector/);
  assert.match(js, /function plateCandidates\(canvas\)/);
  assert.match(js, /function pixelateRect\(/);
  assert.match(js, /await openSmartBlurReview\(file, options\.smartBlurMode\)/);
  assert.match(css, /\.ann-detect-status/);
  assert.doesNotMatch(js, /fetch\([^\n]*face|fetch\([^\n]*plate/i, 'smart detection must not upload imagery to an external detector');
});

test('PWA build identifiers are synchronized', () => {
  // Derive the build tag from the app source and require the SW to match it, plus a
  // versioned manifest reference — no hardcoded version that rots on each release.
  const build = js.match(/APP_BUILD = '([^']+)'/)[1];
  assert.match(build, /^2026\.\d\d\.\d\d-pwa\d+$/);
  assert.match(worker, new RegExp("VERSION = '" + build.replace(/\./g, '\\.') + "'"));
  assert.match(html, /direct-xfer-pwa\.webmanifest\?v=\d+/);
});
