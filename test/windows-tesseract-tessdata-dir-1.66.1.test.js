'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const launcher = read('windows-launcher/Program.cs');
const host = read('windows-server-host/Program.cs');
const server = read('server.js');
const ocrService = read('lib/server/ocr-service.js');

test('launcher installs on-demand OCR models into the optional Tesseract tessdata directory', () => {
  assert.match(launcher, /OptionalTessdataPath/);
  assert.match(launcher, /foreach \(var model in new\[\]/);
  assert.match(launcher, /tessdata_fast\/" \+ Program\.TessdataFastCommit/);
  assert.match(launcher, /--list-langs", "--tessdata-dir", OptionalTessdataPath/);
});

test('ServerHost validates and launches selected optional Tesseract with the exact tessdata directory', () => {
  assert.match(host, /TesseractUsable\(string executablePath, string tessdataPath/);
  assert.match(host, /start\.ArgumentList\.Add\("--tessdata-dir"\)/);
  assert.match(host, /start\.ArgumentList\.Add\(tessdataFull\)/);
  assert.match(host, /EnvironmentVariables\["TESSDATA_PREFIX"\] = selectedTessdata/);
  assert.match(host, /EnvironmentVariables\["DX_WINDOWS_TESSDATA_DIR"\] = selectedTessdata/);
});

test('server OCR uses --tessdata-dir for selected Windows probes and OCR calls', () => {
  assert.match(ocrService, /process\.env\.DX_WINDOWS_TESSDATA_DIR \|\| process\.env\.DX_WINDOWS_BUNDLED_TESSDATA_DIR/);
  assert.match(ocrService, /spawnSync\(bundled, \['--list-langs', '--tessdata-dir', bundledTessdata\]/);
  assert.match(ocrService, /function searchOcrTesseractArgs\(args\)/);
  assert.match(ocrService, /args\.concat\(\['--tessdata-dir', dataDir\]\)/);
  assert.match(ocrService, /searchOcrTesseractArgs\(\['--list-langs'\]\)/);
});
