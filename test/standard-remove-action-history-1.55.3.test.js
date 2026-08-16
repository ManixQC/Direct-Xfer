'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('1.62.4 merges standard Action history into Activity without restoring a separate section', () => {
  const html = read('public','index.html');
  const app = read('public','app.js');
  const pwa = read('pwa','index.html');
  const server = read('server.js');
  assert.doesNotMatch(html, /undo-history-card|id="undo-card-title"|id="undo-overlay"|id="undo-btn"/);
  assert.match(html, /id="activity-page"/);
  assert.match(app, /activityEventsWithUndo/);
  assert.match(app, /runUndoFromActivity/);
  assert.match(app, /api\('GET','\/api\/undo'\)/);
  assert.match(app, /activity-row[^\n]*has-undo/);
  assert.match(pwa, /id="action-history-heading"/);
  assert.match(server, /adminRouter\.get\('\/undo'/);
  assert.match(server, /adminRouter\.post\('\/undo\/:id'/);
});

test('1.62.4 release metadata is synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.62.4');
  assert.equal(lock.version, '1.62.4');
  assert.equal(lock.packages[''].version, '1.62.4');
  assert.match(read('pwa','app.js'), /APP_VERSION = '1\.62\.4'/);
  assert.match(read('pwa','app.js'), /APP_BUILD = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa','sw.js'), /VERSION = '2026\.08\.16-pwa308'/);
  assert.match(read('pwa','index.html'), /v1\.62\.4 · pwa308/);
  assert.match(read('pwa','index.html'), /app\.js\?v=290/);
});
