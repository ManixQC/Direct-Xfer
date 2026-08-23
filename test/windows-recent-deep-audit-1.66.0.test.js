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
const server = read('server.js');
const ocrService = read('lib/server/ocr-service.js');
const portable = read('windows-launcher/README-WINDOWS-PORTABLE.md');

test('Windows ServerHost preserves explicit rclone and Tesseract environment overrides', () => {
  assert.match(host, /HasNonEmptyEnvironmentVariable\(ProcessStartInfo start, string name\)/);
  assert.match(host, /if \(!HasNonEmptyEnvironmentVariable\(start, "RCLONE_BIN"\)\)/);
  assert.match(host, /if \(!HasNonEmptyEnvironmentVariable\(start, "SEARCH_OCR_TESSERACT_BIN"\)\)/);
  assert.match(host, /if \(!HasNonEmptyEnvironmentVariable\(start, "TESSDATA_PREFIX"\)\)/);
  assert.match(portable, /Explicit `RCLONE_BIN` and `RCLONE_CONFIG` environment overrides always take precedence/);
  assert.match(portable, /Explicit `SEARCH_OCR_ENABLED`, `SEARCH_OCR_TESSERACT_BIN` and `TESSDATA_PREFIX` administrator overrides are preserved/);
});

test('direct portable Node launch retains legacy Tesseract fallback without making it installer payload', () => {
  assert.match(ocrService, /function resolveTesseractBinary\(\)/);
  assert.match(ocrService, /path\.resolve\(__dirname, '\.\.', '\.\.', 'tesseract'\)/);
  assert.match(ocrService, /spawnSync\(bundled, \['--list-langs', '--tessdata-dir', bundledTessdata\]/);
  assert.match(ocrService, /process\.env\.DX_WINDOWS_TESSDATA_DIR \|\| process\.env\.DX_WINDOWS_BUNDLED_TESSDATA_DIR/);
});

test('ServerHost validates optional and legacy helper executables before selecting them', () => {
  assert.match(host, /RcloneUsable\(string path\)/);
  assert.match(host, /TesseractUsable\(string executablePath, string tessdataPath, IEnumerable<string> requiredLanguages\)/);
  assert.match(host, /FileAttributes\.ReparsePoint[\s\S]*?!IsAmd64Pe\(full\)/);
  assert.match(host, /RcloneUsable\(OptionalRclonePath\)/);
  assert.match(host, /TesseractUsable\(OptionalTesseractPath, OptionalTessdataPath, requestedOcrLanguages\)/);
  assert.match(host, /foreach \(var language in new\[\] \{ "eng", "fra", "spa" \}\)/);
  assert.match(host, /requested\.All\(languages\.Contains\)/);
  assert.match(host, /optional rclone failed validation and will not be used/);
  assert.match(host, /optional Tesseract cannot satisfy the requested OCR languages/);
});

test('Windows CI keeps bounded core probes while optional downloads moved out of build payload', () => {
  assert.match(workflow, /WaitForExit\(15000\)/);
  assert.match(workflow, /timed out during the shared private \.NET runtime probe/);
  assert.match(workflow, /function Invoke-DxDownload/);
  assert.match(workflow, /attempt -le 3/);
  assert.match(workflow, /-TimeoutSec 180/);
  assert.match(workflow, /Inno Setup installation timed out after 120 seconds/);
  assert.doesNotMatch(workflow, /DX_TESSERACT_|DX_RCLONE_/);
  assert.match(launcher, /HttpClient\(handler\) \{ Timeout = TimeSpan\.FromMinutes\(5\) \}/);
  assert.match(launcher, /Optional component SHA-256 verification failed/);
});
