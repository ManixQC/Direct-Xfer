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
const portable = read('windows-launcher/README-WINDOWS-PORTABLE.md');

test('Windows ServerHost preserves explicit rclone and Tesseract environment overrides', () => {
  assert.match(host, /HasNonEmptyEnvironmentVariable\(ProcessStartInfo start, string name\)/);
  assert.match(host, /!HasNonEmptyEnvironmentVariable\(start, "RCLONE_BIN"\)[\s\S]*?RCLONE_BIN"\] = PortableRclonePath/);
  assert.match(host, /!HasNonEmptyEnvironmentVariable\(start, "RCLONE_CONFIG"\)[\s\S]*?RCLONE_CONFIG"\] = Path\.Combine\(config\.dataDir, "rclone", "rclone\.conf"\)/);
  assert.match(host, /!HasNonEmptyEnvironmentVariable\(start, "SEARCH_OCR_TESSERACT_BIN"\)[\s\S]*?SEARCH_OCR_TESSERACT_BIN"\] = PortableTesseractPath/);
  assert.match(host, /usingBundledTesseract && !HasNonEmptyEnvironmentVariable\(start, "TESSDATA_PREFIX"\)/);
  assert.match(portable, /Explicit `RCLONE_BIN` and `RCLONE_CONFIG` environment overrides are preserved/);
  assert.match(portable, /Explicit `SEARCH_OCR_TESSERACT_BIN` and `TESSDATA_PREFIX` environment overrides are preserved/);
});

test('direct Windows Node runtime can discover bundled Tesseract without ServerHost', () => {
  assert.match(server, /function resolveSearchOcrTesseractBinary\(\)/);
  assert.match(server, /path\.resolve\(__dirname, '\.\.', 'tesseract'\)/);
  assert.match(server, /path\.join\(bundledRoot, 'tesseract\.exe'\)/);
  assert.match(server, /spawnSync\(bundled, \['--list-langs', '--tessdata-dir', bundledTessdataDir\]/);
  assert.match(server, /timeout: 5000/);
  assert.match(server, /requested\.every\(\(lang\) => languages\.includes\(lang\)\)/);
  assert.match(server, /process\.env\.TESSDATA_PREFIX = bundledTessdataDir/);
  assert.match(server, /const SEARCH_OCR_TESSERACT_BIN = resolveSearchOcrTesseractBinary\(\)/);
});


test('ServerHost validates bundled helper executables before selecting them', () => {
  assert.match(host, /TesseractVersion = "5\.5\.3"/);
  assert.match(host, /PortableHelperUsable\(string path, string arguments, params string\[\] expectedPrefixes\)/);
  assert.match(host, /FileAttributes\.ReparsePoint[\s\S]*?!IsAmd64Pe\(full\)/);
  assert.match(host, /BundledRcloneUsable\(\)[\s\S]*?"rclone v" \+ Program\.RcloneVersion/);
  assert.match(host, /BundledTesseractUsable\(\)[\s\S]*?"tesseract " \+ Program\.TesseractVersion[\s\S]*?"tesseract v" \+ Program\.TesseractVersion/);
  assert.match(host, /foreach \(var language in new\[\] \{ "eng", "fra", "spa" \}\)/);
  assert.match(host, /language \+ "\.traineddata"[\s\S]*?Length < 100 \* 1024/);
  assert.match(host, /bundled rclone failed validation; falling back to PATH/);
  assert.match(host, /bundled Tesseract failed validation; falling back to PATH/);
});

test('Windows CI has bounded probes, bounded Tesseract setup and retried downloads', () => {
  assert.match(workflow, /WaitForExit\(15000\)/);
  assert.match(workflow, /timed out during the shared private \.NET runtime probe/);
  assert.match(workflow, /Get-ChildItem -LiteralPath \$entry\.Dir -Recurse -File/);
  assert.match(workflow, /WaitForExit\(120000\)/);
  assert.match(workflow, /Tesseract silent extraction\/install timed out after 120 seconds/);
  assert.match(workflow, /\$tesseractVersionText = \(\(\$tesseractVersionOutput \| ForEach-Object \{ \[string\]\$_ \}\) -join "`n"\)/);
  assert.match(workflow, /\[regex\]::Match\(\$tesseractVersionText, '\(\?im\)\^\\s\*tesseract\\s\+v\?\(\?<base>/);
  assert.match(workflow, /\$tesseractVersionMatch\.Groups\['base'\]\.Value -ne \$env:DX_TESSERACT_VERSION/);
  assert.doesNotMatch(workflow, /\$tesseractVersionOutput\[0\]\s+-match/);
  assert.match(workflow, /function Invoke-DxDownload/);
  assert.match(workflow, /attempt -le 3/);
  assert.match(workflow, /-TimeoutSec 180/);
  assert.match(workflow, /Inno Setup installation timed out after 120 seconds/);
  assert.match(workflow, /Inno Setup installation failed:/);
  assert.match(workflow, /Inno Setup compiler is missing after installation/);
  assert.doesNotMatch(workflow, /--dx-runtime-probe' -Wait -PassThru/);
  assert.doesNotMatch(workflow, /Start-Process \$installer[\s\S]*?-Wait/);
});
