'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const workflow = read('.github/workflows/build-windows-csharp.yml');
const host = read('windows-server-host/Program.cs');
const installer = read('installer/Direct-Xfer.iss');
const readme = read('README.md');

test('Windows CI bundles pinned Tesseract x64 and validates its release checksum', () => {
  assert.match(workflow, /DX_TESSERACT_VERSION:\s*'5\.5\.3'/);
  assert.match(workflow, /DX_TESSERACT_PACKAGE_VERSION:\s*'5\.5\.3\.20260724'/);
  assert.match(workflow, /DX_TESSERACT_SETUP_SHA256:\s*'bee9e3434bd94fd65387d9be28cd467a41f61b1275383b55b0f59a1331270ae4'/i);
  assert.match(workflow, /releases\/download\/\$env:DX_TESSERACT_VERSION\/tesseract-ocr-w64-setup-/);
  assert.match(workflow, /Tesseract setup SHA-256 mismatch/);
  assert.match(workflow, /\[regex\]::Match\(\$tesseractVersionText, '\(\?im\)\^\\s\*tesseract\\s\+v\?\(\?<base>\\d\+\\\.\\d\+\\\.\\d\+\)\(\?:\\\.\\d\+\)\?\(\?:\\s\|\$\)'\)/);
  assert.match(workflow, /\$tesseractVersionMatch\.Groups\['base'\]\.Value -ne \$env:DX_TESSERACT_VERSION/);
  assert.doesNotMatch(workflow, /\$tesseractVersionOutput\[0\]\s+-match/);
  assert.match(workflow, /runtime\\tesseract/);
  assert.match(workflow, /tesseract\.exe/);
});

test('Windows Tesseract includes pinned fast English, French and Spanish models', () => {
  assert.match(workflow, /DX_TESSDATA_FAST_COMMIT:\s*'87416418657359cb625c412a48b6e1d6d41c29bd'/);
  assert.match(workflow, /raw\.githubusercontent\.com\/tesseract-ocr\/tessdata_fast\/\$env:DX_TESSDATA_FAST_COMMIT/);
  assert.match(workflow, /@\('eng','fra','spa'\)/);
  assert.match(workflow, /--list-langs/);
  assert.match(workflow, /Bundled Tesseract is missing language/);
});

test('ServerHost wires bundled Tesseract into server OCR automatically', () => {
  assert.match(host, /PortableTesseractRoot/);
  assert.match(host, /PortableTesseractPath/);
  assert.match(host, /!HasNonEmptyEnvironmentVariable\(start, "SEARCH_OCR_TESSERACT_BIN"\)[\s\S]*?EnvironmentVariables\["SEARCH_OCR_TESSERACT_BIN"\]\s*=\s*PortableTesseractPath/);
  assert.match(host, /usingBundledTesseract[\s\S]*?!HasNonEmptyEnvironmentVariable\(start, "TESSDATA_PREFIX"\)[\s\S]*?EnvironmentVariables\["TESSDATA_PREFIX"\]\s*=\s*PortableTesseractRoot/);
});

test('Installer upgrade cleanup and documentation include bundled Tesseract', () => {
  assert.match(installer, /runtime\\tesseract/);
  assert.match(readme, /Windows package now bundles Tesseract x64/);
});
