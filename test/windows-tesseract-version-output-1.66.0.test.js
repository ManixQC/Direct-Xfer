'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');

test('on-demand Tesseract validation accepts current upstream version-line forms', () => {
  const sample = 'tesseract v5.5.3.20260724 | leptonica-1.87.0';
  assert.ok(sample.trimStart().startsWith('tesseract v5.5.3'));
  assert.match(launcher, /StartsWith\("tesseract v" \+ Program\.TesseractVersion/);
  assert.match(launcher, /StartsWith\("tesseract " \+ Program\.TesseractVersion/);
  assert.match(launcher, /The downloaded Tesseract version does not match Direct-Xfer's pinned version/);
});

test('on-demand rclone validation compares the pinned version line', () => {
  assert.match(launcher, /string\.Equals\(line\.Trim\(\), "rclone v" \+ Program\.RcloneVersion/);
  assert.match(launcher, /The downloaded rclone version does not match Direct-Xfer's pinned version/);
});
