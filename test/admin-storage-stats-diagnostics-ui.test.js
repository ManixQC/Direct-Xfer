'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('features 23 and 24 are first-class dashboard panels backed by server data', () => {
  assert.match(html, /id="dash-file-type-stats"/);
  assert.match(html, /id="dash-storage-report"/);
  assert.match(app, /renderFileTypeStats\(d\.fileTypeStats \|\| \[\]\)/);
  assert.match(app, /renderStorageReport\(d\.storageReport\)/);
  assert.match(server, /fileTypeStats/);
  assert.match(server, /buildGlobalStorageReport/);
});

test('feature 30 exposes an admin-only diagnostic runner with mobile-friendly results', () => {
  assert.match(html, /id="dash-diagnostics-run"/);
  assert.match(html, /id="dash-diagnostics"/);
  assert.match(app, /api\('POST', '\/api\/diagnostics\/run', \{\}\)/);
  assert.match(server, /adminRouter\.post\('\/diagnostics\/run', requireFullAdmin/);
  assert.match(css, /\.diag-row/);
  assert.match(css, /@media \(max-width:700px\)/);
});
