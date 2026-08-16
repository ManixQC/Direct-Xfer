const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('tablet and wide PWA keep Notifications in the compact topbar without Information/language/theme controls', () => {
  const html = read('pwa/index.html');
  const css = read('pwa/app.css');
  assert.match(html, /id="pwa-notifications-menu"/);
  assert.doesNotMatch(html, /id="help-btn"/);
  assert.doesNotMatch(css, /#help-btn/);
  assert.match(css, /\.pwa-header-actions\s*\{[^}]*display:flex;[^}]*align-items:center;/s);
});

test('PWA shell is advanced so the topbar removal is not served from stale cache', () => {
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.16-pwa306'/);
  assert.match(read('pwa/index.html'), /app\.css\?v=274/);
  assert.match(read('pwa/index.html'), /app\.js\?v=290/);
});
