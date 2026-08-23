'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');
const admin = read('lib/server/admin-application.js');

test('1.70.3 admin composition validates bootstrap and runtime contracts before wiring routes', () => {
  assert.match(admin, /requireNonNegativeInteger\(runtime\.undoLogMax, 'runtime\.undoLogMax'\)/);
  assert.match(admin, /requireNonNegativeInteger\(runtime\.visitorFeedbackMax, 'runtime\.visitorFeedbackMax'\)/);
  assert.match(admin, /requireObject\(bootstrap\.storageConnectorService, 'bootstrap\.storageConnectorService'\)/);
  assert.match(admin, /requirePromiseLike\(bootstrap\.connectorStartupCleanup, 'bootstrap\.connectorStartupCleanup'\)/);
  assert.match(admin, /requireObject\(bootstrap\.storageSetup, 'bootstrap\.storageSetup'\)/);
  assert.match(admin, /requireObject\(share\.constants, 'share\.constants'\)/);
});

test('1.70.3 admin composition keeps security-sensitive configuration fail-closed', () => {
  assert.match(admin, /requireObject\(tlsManager\.config, 'tls-manager config'\)/);
  assert.match(admin, /requireObject\(ocr\.getConfig\(\), 'OCR config'\)/);
  assert.match(admin, /requireObject\(audit\.paths, 'audit paths'\)/);
  assert.doesNotMatch(admin, /tlsManager\.config\s*\|\|\s*\{\}/);
  assert.doesNotMatch(admin, /audit\.paths\s*\|\|\s*\{\}/);
});

test('1.70.3 share-core helpers have one frozen identity across context and caller', () => {
  assert.match(admin, /const shareCoreOutput = requireObject\([\s\S]*?attachAdminShareCoreRoutes/);
  assert.match(admin, /Object\.freeze\(shareCoreOutput\);/);
  assert.match(admin, /context\.register\('share-core-output', shareCoreOutput\);/);
  assert.match(admin, /return Object\.freeze\(\{[\s\S]*?shareCoreOutput,/);
  assert.doesNotMatch(admin, /shareCoreOutput\s*:\s*Object\.freeze\(\{\s*\.\.\.shareCoreOutput\s*\}\)/);
});

test('1.70.3 late admin attachment preflights dependencies and cannot retry after partial failure', () => {
  assert.match(admin, /let lateRoutesState = 'idle';/);
  assert.match(admin, /if \(lateRoutesState !== 'idle'\)/);
  assert.match(admin, /requireDomain\(context, 'pwa-device'\);/);
  assert.match(admin, /const publicShare = requireDomain\(context, 'public-share'\);/);
  assert.match(admin, /public-share\.RENDER_MAX_BYTES to be a positive integer/);
  assert.match(admin, /lateRoutesState = 'attaching';[\s\S]*?try \{/);
  assert.match(admin, /const lateRouteDeps = Object\.freeze\(\{/);
  assert.match(admin, /attachAdminSettingsRoutes\(lateRouteDeps\.settings\)/);
  assert.match(admin, /lateRoutesState = 'attached';[\s\S]*?catch \(error\) \{[\s\S]*?lateRoutesState = 'failed';/);
});
