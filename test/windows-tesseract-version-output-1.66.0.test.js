'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-windows-csharp.yml'), 'utf8');

test('Windows CI parses multiline Tesseract release output instead of assuming one line', () => {
  const sample = [
    'tesseract v5.5.3.20260724 | leptonica-1.87.0 | libgif 5.2.2 | libjpeg 8d',
    'Found AVX2',
    'Found AVX',
    'libarchive 3.8.8 zlib/1.3.2'
  ].join('\n');
  const match = sample.match(/^\s*tesseract\s+v?(?<base>\d+\.\d+\.\d+)(?:\.\d+)?(?:\s|$)/im);
  assert.ok(match, 'the GitHub runner output shown by Tesseract 5.5.3 must be parseable');
  assert.equal(match.groups.base, '5.5.3');
  assert.match(workflow, /\$tesseractVersionText = \(\(\$tesseractVersionOutput \| ForEach-Object/);
  assert.match(workflow, /\$tesseractVersionMatch = \[regex\]::Match\(\$tesseractVersionText/);
  assert.match(workflow, /\$tesseractVersionMatch\.Groups\['base'\]\.Value -ne \$env:DX_TESSERACT_VERSION/);
  assert.match(workflow, /\$tesseractLangLines = @\(\$tesseractLangOutput \| ForEach-Object/);
  assert.match(workflow, /\$langLines = @\(\$langs \| ForEach-Object/);
});

test('Windows CI normalizes rclone version output before comparing it', () => {
  assert.match(workflow, /\$rcloneVersionText = \(\(\$rcloneVersionOutput \| ForEach-Object/);
  assert.match(workflow, /\$rcloneVersionMatch = \[regex\]::Match\(\$rcloneVersionText/);
  assert.match(workflow, /\$rcloneVersionMatch\.Groups\['base'\]\.Value -ne \$env:DX_RCLONE_VERSION/);
});
