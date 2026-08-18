'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const workflow = read('.github/workflows/build-windows-csharp.yml');
const launcher = read('windows-launcher/Program.cs');
const host = read('windows-server-host/Program.cs');
const installer = read('installer/Direct-Xfer.iss');
const portable = read('windows-launcher/README-WINDOWS-PORTABLE.md');

test('Windows default payload deliberately excludes Tesseract', () => {
  assert.doesNotMatch(workflow, /DX_TESSERACT_VERSION|DX_TESSERACT_SETUP_SHA256|DX_TESSERACT_RUNTIME_BUDGET_MB/);
  assert.match(workflow, /optional rclone\/Tesseract excluded/);
  assert.match(workflow, /foreach \(\$optionalRel in @\('runtime\\node','runtime\\rclone','runtime\\tesseract'\)\)/);
  assert.match(workflow, /Optional Windows component leaked into the default payload/);
});

test('launcher owns the pinned on-demand Tesseract download and model activation', () => {
  assert.match(launcher, /TesseractVersion = "5\.5\.3"/);
  assert.match(launcher, /TesseractPackageVersion = "5\.5\.3\.20260724"/);
  assert.match(launcher, /TesseractSetupSha256 = "bee9e3434bd94fd65387d9be28cd467a41f61b1275383b55b0f59a1331270ae4"/i);
  assert.match(launcher, /TessdataFastCommit = "87416418657359cb625c412a48b6e1d6d41c29bd"/);
  assert.match(launcher, /InstallTesseractCore\(\)/);
  assert.match(launcher, /DownloadOptionalFile\(url, setup, Program\.TesseractSetupSha256/);
  assert.match(launcher, /Arguments = "\/CurrentUser \/S \/D=" \+ OptionalTesseractRoot/);
  assert.match(launcher, /foreach \(var model in new\[\]/);
  assert.match(launcher, /raw\.githubusercontent\.com\/tesseract-ocr\/tessdata_fast\//);
  assert.match(launcher, /--list-langs/);
});

test('ServerHost selects activated per-user Tesseract and leaves OCR off before activation', () => {
  assert.match(host, /OptionalTesseractPath/);
  assert.match(host, /TesseractUsable\(OptionalTesseractPath, OptionalTessdataPath, requestedOcrLanguages\)/);
  assert.match(host, /EnvironmentVariables\["SEARCH_OCR_TESSERACT_BIN"\] = selectedTesseract/);
  assert.match(host, /EnvironmentVariables\["DX_WINDOWS_TESSDATA_DIR"\] = selectedTessdata/);
  assert.match(host, /EnvironmentVariables\["SEARCH_OCR_ENABLED"\] = "false"/);
});

test('installer removes historical bundled Tesseract but does not package a new copy', () => {
  assert.match(installer, /Remove old heavyweight helpers left by <=1\.66\.4 bundled-component builds/);
  assert.match(installer, /\{app\}\\runtime\\tesseract/);
  assert.match(portable, /rclone and Tesseract are deliberately not included in the default Windows package or installer/i);
  assert.match(portable, /Optional components \/ Composants optionnels/);
});
