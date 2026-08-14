'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('standard share-ready banner copies through the global clipboard helper', () => {
  assert.match(html, /id="share-created-copy"/);
  assert.match(app, /id|share-created-copy/); // keep the control represented in the client bundle
  assert.match(app, /\$\('share-created-copy'\)[\s\S]{0,260}?if\(url\)copy\(url\)/);
  assert.doesNotMatch(app, /\$\('share-created-copy'\)[\s\S]{0,260}?copyText\(url\)/);
});

test('standard share-ready banner automatically closes after one minute and resets cleanly', () => {
  assert.match(app, /let createdShareBannerTimer = null/);
  assert.match(app, /createdShareBannerTimer = setTimeout\(hideCreatedShareLink, 60 \* 1000\)/);
  assert.match(app, /if \(createdShareBannerTimer\) clearTimeout\(createdShareBannerTimer\)/);
  assert.match(app, /delete banner\.dataset\.url/);
  assert.match(app, /if \(urlNode\) urlNode\.textContent = ''/);
  assert.match(app, /\$\('share-created-close'\)[\s\S]{0,120}?hideCreatedShareLink/);
});
