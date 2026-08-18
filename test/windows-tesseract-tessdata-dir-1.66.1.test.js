
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const workflow = read('.github/workflows/build-windows-csharp.yml');
const host = read('windows-server-host/Program.cs');
const server = read('server.js');

test('Windows CI discovers bundled Tesseract languages from the exact tessdata directory', () => {
  assert.match(workflow, /\$tessdataDir = Join-Path \$tesseract 'tessdata'/);
  assert.match(workflow, /\$env:TESSDATA_PREFIX = \$tessdataDir/);
  assert.match(workflow, /\$tesseractLangOutput = @\(& \$tesseractExe --list-langs --tessdata-dir \$tessdataDir 2>&1\)/);
  assert.match(workflow, /\$langs = @\(& \$tesseractExe --list-langs --tessdata-dir \$tessdataDir 2>&1\)/);
  assert.doesNotMatch(workflow, /\$env:TESSDATA_PREFIX = \$tesseract(?:Root)?\s*$/m);
});

test('ServerHost validates and launches bundled Tesseract with the packaged tessdata directory', () => {
  assert.match(host, /PortableTessdataPath/);
  assert.match(host, /start\.ArgumentList\.Add\("--list-langs"\)/);
  assert.match(host, /start\.ArgumentList\.Add\("--tessdata-dir"\)/);
  assert.match(host, /start\.ArgumentList\.Add\(Path\.GetFullPath\(PortableTessdataPath\)\)/);
  assert.match(host, /EnvironmentVariables\["TESSDATA_PREFIX"\] = PortableTessdataPath/);
  assert.match(host, /EnvironmentVariables\["DX_WINDOWS_BUNDLED_TESSDATA_DIR"\] = PortableTessdataPath/);
});

test('server OCR uses --tessdata-dir for bundled Windows probes and OCR calls', () => {
  assert.match(server, /bundledTessdataDir = path\.join\(bundledRoot, 'tessdata'\)/);
  assert.match(server, /spawnSync\(bundled, \['--list-langs', '--tessdata-dir', bundledTessdataDir\]/);
  assert.match(server, /function searchOcrTesseractArgs\(args\)/);
  assert.match(server, /args\.concat\(\['--tessdata-dir', dataDir\]\)/);
  assert.match(server, /searchOcrTesseractArgs\(\['--list-langs'\]\)/);
  assert.match(server, /searchOcrTesseractArgs\(\[abs, 'stdout', '-l', SEARCH_OCR_LANGS, '--psm', '3'\]\)/);
});
