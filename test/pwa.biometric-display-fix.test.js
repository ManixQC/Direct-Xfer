'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('pwa/app.css');
const html = read('pwa/index.html');
const app = read('pwa/app.js');
const sw = read('pwa/sw.js');

test('biometric settings keep explanatory text separate from their actions', () => {
  assert.match(html, /id="passkey-section" class="setting-row biometric-setting"/);
  assert.match(css, /\.biometric-setting\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/s);
  assert.match(css, /\.biometric-setting\s*>\s*\.button-row\s*\{[^}]*width:\s*100%;[^}]*display:\s*grid;/s);
  assert.match(css, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(180px,\s*1fr\)\)/);
  assert.match(css, /\.biometric-setting\s*>\s*\.button-row\s+\.btn\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
});

test('registered biometric metadata and actions remain readable on phones', () => {
  assert.match(css, /\.passkey-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*?\.passkey-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(css, /\.passkey-main\s+\.xs\s*\{[^}]*font-size:\s*\.75rem;[^}]*line-height:\s*1\.4;/s);
  assert.match(css, /\.passkey-row\s*>\s*\.btn\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
});

test('the corrected stylesheet is forced onto installed PWAs', () => {
  assert.equal(JSON.parse(read('package.json')).version, '1.62.2');
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa306'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa306'/);
  assert.match(html, /v1\.62\.2 · pwa306/);
  assert.match(html, /app\.css\?v=274/);
  assert.match(sw, /app\.css\?v=274/);
});
