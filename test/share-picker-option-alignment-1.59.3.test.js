const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');

test('smart-expiry help takes a full picker row so max visitors starts aligned at the left', () => {
  assert.match(html, /class="muted sm smart-expiry-hint"[^>]*>[\s\S]*?<\/p>\s*<label>\s*<span data-i18n="pk\.maxVisitors">/);
  assert.match(css, /\.picker-modal \.share-options \.smart-expiry-hint\s*\{[^}]*flex:\s*1 0 100%;[^}]*width:\s*100%;/s);
});

test('password and password hint stay in one logical picker pair', () => {
  assert.match(html, /<div class="share-option-pair share-option-password-pair">[\s\S]*?id="opt-password"[\s\S]*?id="opt-pwhint"[\s\S]*?<\/div>/);
  assert.match(css, /\.picker-modal \.share-option-pair\s*\{[^}]*display:\s*flex;[^}]*gap:\s*14px;/s);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.picker-modal \.share-option-pair\s*\{[^}]*flex-direction:\s*column;/s);
});

test('standard stylesheet cache-bust advances for the share-picker layout hotfix', () => {
  assert.match(html, /href="\/style\.css\?v=286"/);
});
