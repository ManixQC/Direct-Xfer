'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const full = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const pwa = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
const pwaHtml = fs.readFileSync(path.join(ROOT, 'pwa', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');

function sliceBetween(source, start, end) {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `missing start marker: ${start}`);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, `missing end marker: ${end}`);
  return source.slice(a, b);
}

test('server OCR index treats Images-section photos as first-class documents', () => {
  const build = sliceBetween(server, 'async function buildUniversalSearchIndex()', 'function scheduleSearchReindex');
  assert.match(build, /s\.type === 'photo'/);
  assert.match(build, /firstExistingPhotoFile\(photoOriginalPaths\(s\)\)/);
  assert.match(build, /await add\(s, abs, s\.name \|\| path\.basename\(abs\)\)/);
  assert.match(build, /Array\.isArray\(s\.tags\) \? s\.tags\.join\(' '\) : ''/);
  assert.match(build, /s\.adminNote \|\| ''/);
});

test('full Images search merges local metadata matches with server OCR matches', () => {
  assert.match(full, /photoOcrMatches:\s*new Set\(\)/);
  assert.match(full, /\/api\/search\?q=' \+ encodeURIComponent\(q\) \+ '&type=photo&limit=200'/);
  assert.match(full, /const ocr = state\.photoOcrQuery === q && state\.photoOcrMatches\.has\(s\.token\)/);
  assert.match(full, /local \|\| ocr/);
  assert.match(full, /m\.type === 'photo' \? \('\/images\?image='/);
});

test('PWA Images search uses the authenticated server OCR index and local OCR records', () => {
  assert.match(server, /app\.get\('\/app\/images\/search', async \(req, res\) =>/);
  assert.match(server, /type:\s*'photo'/);
  assert.match(server, /canManagePwaImage\(req, share\)/);
  assert.match(pwa, /fetch\('\/app\/images\/search\?q=' \+ encodeURIComponent\(q\) \+ '&limit=500'/);
  assert.match(pwa, /rec\.imageToken === token/);
  assert.match(pwa, /imageOcrServerTokens\.has\(token\)/);
});

test('PWA image cards can OCR an existing Images record and persist it under the image token', () => {
  assert.match(pwa, /class="btn ghost sm il-ocr"/);
  assert.match(pwa, /function openImageRecordOcr\(photo\)/);
  assert.match(pwa, /\/app\/image\/.*\/preview\/full/);
  assert.match(pwa, /imageToken:photo\.token/);
  assert.match(pwa, /seed = it && it\.imageToken \? \('image:' \+ it\.imageToken\)/);
  assert.match(pwa, /sourceKind: String\(it\.ocrSourceKind \|\| \(it\.imageToken \? 'image-library' : 'queue'\)\)/);
});

test('PWA shell/cache was bumped for the Images OCR integration', () => {
  assert.match(pwa, /APP_BUILD = '2026\.08\.15-pwa289'/);
  assert.match(pwaHtml, /app\.js\?v=273/);
  assert.match(sw, /pwa289/);
});
