'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'pwa', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'pwa', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'pwa', 'sw.js'), 'utf8');

test('normal PWA file selection is explicitly generic and separate from camera capture', () => {
  assert.match(html, /id="pick-camera"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  assert.match(html, /id="pick-files-btn"[^>]*class="pick"/);
  assert.match(html, /id="pick-files"[^>]*type="file"[^>]*accept="\*\/\*"[^>]*multiple/);
  assert.doesNotMatch(html, /id="pick-files"[^>]*capture=/);
});

test('normal file button prefers File System Access and falls back to generic HTML picker', () => {
  assert.match(app, /async function openGenericFilePicker\(useFileSystemPicker\)/);
  assert.match(app, /window\.showOpenFilePicker\(\{ multiple: true \}\)/);
  assert.match(app, /input\.removeAttribute\('capture'\)/);
  assert.match(app, /input\.setAttribute\('accept', '\*\/\*'\)/);
  assert.match(app, /pick-files-btn'\)\.addEventListener\('click'/);
});

test('PWA cache build advances so installed apps receive the picker fix', () => {
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa308'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa308'/);
  assert.match(html, /app\.js\?v=290/);
  assert.match(html, /v1\.62\.4 · pwa308/);
});
