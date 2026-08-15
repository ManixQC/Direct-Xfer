const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('share bandwidth cap has translations in all supported standard UI languages', () => {
  assert.match(app, /'pk\.maxBandwidth': 'Limite totale de bande passante \(Go\)'/);
  assert.match(app, /'pk\.maxBandwidth': 'Total bandwidth cap \(GB\)'/);
  assert.match(app, /'pk\.maxBandwidth': 'Límite total de ancho de banda \(GB\)'/);
});

test('share create and edit forms both use the translated bandwidth-cap key', () => {
  const matches = html.match(/data-i18n="pk\.maxBandwidth"/g) || [];
  assert.equal(matches.length, 2);
  assert.match(html, /id="opt-maxbytesserved"/);
  assert.match(html, /id="edit-maxbytesserved"/);
});
