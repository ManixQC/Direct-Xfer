'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const workflow = read('.github/workflows/build-windows-csharp.yml');
const launcher = read('windows-launcher/Program.cs');
const host = read('windows-server-host/Program.cs');
const installer = read('installer/Direct-Xfer.iss');

test('default Windows build cannot accidentally package optional helpers', () => {
  assert.doesNotMatch(workflow, /New-Item[^\n]+\$rclone|New-Item[^\n]+\$tesseract/);
  assert.doesNotMatch(workflow, /downloads\.rclone\.org|tesseract-ocr-w64-setup/);
  assert.match(workflow, /runtime\\rclone','runtime\\tesseract/);
  assert.match(workflow, /Optional Windows component leaked into the default payload/);
});

test('optional component activation is explicit and per-user', () => {
  assert.match(launcher, /OptionalToolsRoot.*Path\.Combine\(BaseDirectory, "tools"\)/);
  assert.match(launcher, /OptionalInstallConfirm/);
  assert.match(launcher, /MessageBoxButtons\.YesNo/);
  assert.match(launcher, /InstallOptionalToolAsync\("rclone"\)/);
  assert.match(launcher, /InstallOptionalToolAsync\("tesseract"\)/);
  assert.match(launcher, /SignalServerHostReload\(\)/);
});

test('optional downloads use HTTPS, size bounds and pinned executable/archive hashes', () => {
  assert.match(launcher, /Uri\.UriSchemeHttps/);
  assert.match(launcher, /RcloneZipSha256 = "[0-9a-f]{64}"/i);
  assert.match(launcher, /TesseractSetupSha256 = "[0-9a-f]{64}"/i);
  assert.match(launcher, /FileSha256\(destination\)/);
  assert.match(launcher, /Optional component SHA-256 verification failed/);
});

test('ServerHost prefers activated per-user helpers but preserves legacy and admin overrides', () => {
  assert.match(host, /OptionalRclonePath/);
  assert.match(host, /OptionalTesseractPath/);
  assert.match(host, /PortableRclonePath/);
  assert.match(host, /PortableTesseractPath/);
  assert.match(host, /if \(!HasNonEmptyEnvironmentVariable\(start, "RCLONE_BIN"\)\)/);
  assert.match(host, /if \(!HasNonEmptyEnvironmentVariable\(start, "SEARCH_OCR_TESSERACT_BIN"\)\)/);
});

test('upgrade cleanup removes only old app-local helper payloads', () => {
  assert.match(installer, /\{app\}\\runtime\\rclone/);
  assert.match(installer, /\{app\}\\runtime\\tesseract/);
  assert.doesNotMatch(installer, /UninstallDelete[\s\S]*?Direct-Xfer\\tools/);
});
