'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('optional haptic feedback is persisted and used by common actions', () => {
  assert.match(html, /id="haptic-feedback"[^>]*type="checkbox"/);
  assert.match(js, /function haptic\(kind\)/);
  assert.match(js, /dx-pwa-haptic/);
  assert.match(js, /copyText\(text\)[\s\S]*haptic\('light'\)/);
});

test('advanced sections can operate as a collapsible accordion', () => {
  assert.match(html, /id="advanced-accordion"/);
  assert.match(html, /details class="[^"]*advanced-section/);
  assert.match(js, /function bindAdvancedAccordion\(\)/);
  assert.match(js, /other\.open = false/);
});

test('image and album expirations display a live countdown', () => {
  assert.match(js, /function formatRemaining\(ms\)/);
  assert.match(js, /data-expiry-countdown/);
  assert.match(js, /setInterval\(updateExpiryCountdowns, 1000\)/);
});

test('important images and albums can be pinned', () => {
  assert.match(js, /pinnedAlbumTokens/);
  assert.match(js, /dx-pwa-pinned-albums/);
  assert.match(js, /row\.classList\.toggle\('pinned'/);
  assert.match(css, /\.imglink-row\.pinned/);
});

test('revocation deletion and replacement confirmations are configurable', () => {
  assert.match(html, /id="confirm-revoke"/);
  assert.match(html, /id="confirm-delete"/);
  assert.match(html, /id="confirm-replace"/);
  assert.match(js, /function askConfirmation\(kind, message\)/);
  assert.match(js, /askConfirmation\('replace', t\('imgDuplicateFound'\)\)/);
});

test('tag colors are customizable and persisted', () => {
  assert.match(html, /id="tag-color-list"/);
  assert.match(js, /dx-pwa-tag-colors/);
  assert.match(js, /function renderTagColorManager\(\)/);
  assert.match(js, /tagChip\.style\.background = color/);
});

test('three favorite card actions remain visible and other actions use the more menu', () => {
  assert.match(html, /id="img-action-1"/);
  assert.match(html, /id="img-action-2"/);
  assert.match(html, /id="img-action-3"/);
  assert.match(js, /function arrangeImageActions\(row\)/);
  assert.match(js, /il-more/);
  assert.match(css, /\.imglink-actions \.action-secondary \{ display: none; \}/);
});

test('copy templates support Discord Reddit forums and email', () => {
  assert.match(html, /id="img-copy-template"/);
  assert.match(html, /option value="discord"/);
  assert.match(html, /option value="reddit"/);
  assert.match(html, /option value="forum"/);
  assert.match(html, /option value="email"/);
  assert.match(js, /template === 'forum'/);
  assert.match(js, /template === 'email'/);
});

test('image statistics can be exported as CSV', () => {
  assert.match(html, /id="img-export-stats-csv"/);
  assert.match(js, /function exportImageStatsCsv\(\)/);
  assert.match(js, /totalVisitors/);
  assert.match(js, /text\/csv/);
});

test('QR codes can be downloaded together in a ZIP archive', () => {
  assert.match(html, /id="imglink-qrzip-btn"/);
  assert.match(js, /function downloadImageQrZip\(\)/);
  assert.match(js, /buildZip\(entries\)/);
  assert.match(js, /-qr\.png/);
});

test('local storage warning threshold is configurable', () => {
  assert.match(html, /id="storage-warning-threshold"/);
  assert.match(html, /id="storage-warning"/);
  assert.match(js, /dx-pwa-storage-warning-threshold/);
  assert.match(js, /ratio >= threshold/);
  assert.match(css, /\.storage-warning/);
});
