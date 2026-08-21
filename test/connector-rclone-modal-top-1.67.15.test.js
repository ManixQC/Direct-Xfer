const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('rclone configuration wizard is anchored to the top of the viewport', () => {
  assert.match(css, /#connector-remote-wizard\s*\{[^}]*align-items\s*:\s*flex-start/s);
  assert.match(css, /#connector-remote-wizard\s*\{[^}]*overflow-y\s*:\s*auto/s);
  assert.match(css, /#connector-remote-wizard\s+\.connector-config-modal\s*\{[^}]*margin\s*:\s*0 auto/s);
});

test('standard page cache-busts the rclone modal positioning CSS', () => {
  assert.match(html, /style\.css\?v=315/);
});
