const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function text(path) { return fs.readFileSync(path, 'utf8'); }

test('standard notification delete X is geometrically centered', () => {
  const css = text('public/style.css');
  assert.match(css, /\.notification-delete\s*\{[\s\S]*display:inline-flex\s*!important;[\s\S]*align-items:center;[\s\S]*justify-content:center;[\s\S]*font-size:0;/);
  assert.match(css, /\.notification-delete::before\s*\{[\s\S]*width:14px;[\s\S]*height:14px;[\s\S]*linear-gradient\(45deg/);
  assert.match(text('public/index.html'), /\/style\.css\?v=270/);
});

test('PWA notification delete X uses the same centered geometry', () => {
  const css = text('pwa/app.css');
  assert.match(css, /\.pwa-notification-delete\s*\{[\s\S]*display:inline-flex\s*!important;[\s\S]*align-items:center;[\s\S]*justify-content:center;[\s\S]*font-size:0;/);
  assert.match(css, /\.pwa-notification-delete::before\s*\{[\s\S]*width:14px;[\s\S]*height:14px;[\s\S]*linear-gradient\(-45deg/);
  assert.match(text('pwa/index.html'), /\/app\/app\.css\?v=269/);
  assert.match(text('pwa/sw.js'), /pwa284/);
});
