'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-csharp.yml'), 'utf8');

test('runtime validation normalizes Windows line endings and reports the failing file', () => {
  assert.match(launcher, /TextFileSha256Normalized/);
  assert.match(launcher, /Replace\("\\r\\n", "\\n"\)\.Replace\("\\r", "\\n"\)/);
  assert.match(launcher, /integrity check failed for/);
  assert.match(launcher, /Expected runtime folder/);
  assert.match(launcher, /Do not run the EXE directly from inside a ZIP/);
});

test('GitHub artifact contains the portable directory directly with hidden runtime marker', () => {
  assert.match(workflow, /path: dist\/Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp\//);
  assert.match(workflow, /include-hidden-files: true/);
  assert.doesNotMatch(workflow, /Compress-Archive/);
  assert.doesNotMatch(workflow, /path: dist\/Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp\.zip/);
  assert.match(workflow, /Portable package is incomplete/);
  assert.match(workflow, /1\.59\.0-launcher26-csharp/);
});
