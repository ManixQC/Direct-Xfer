'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('standard Shares grid button is wired to the share view setter', () => {
  assert.match(app, /\[\['shares-view-list', 'list'\], \['shares-view-grid', 'grid'\]\]/);
  assert.match(app, /addEventListener\('click', \(\) => setShareView\(mode\)\)/);
  assert.match(app, /list\.classList\.toggle\('view-grid', state\.shareView === 'grid'\)/);
});

test('standard Shares grid is visibly multi-column on desktop widths', () => {
  assert.match(css, /\.shares-list\.view-list\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(css, /\.shares-list\.view-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*360px\),\s*1fr\)\);/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.shares-list\.view-grid \{ grid-template-columns: 1fr; \}/);
});

test('standard stylesheet cache key is bumped so browsers receive the fix', () => {
  assert.match(html, /\/style\.css\?v=275/);
});
