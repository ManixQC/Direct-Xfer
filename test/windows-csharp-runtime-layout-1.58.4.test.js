'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');
const host = fs.readFileSync(path.join(root, 'windows-server-host', 'Program.cs'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-csharp.yml'), 'utf8');

test('runtime validation lives in ServerHost, normalizes line endings and reports the failing file', () => {
  assert.doesNotMatch(launcher, /TextFileSha256Normalized|CriticalRuntimeSha256/);
  assert.match(host, /TextFileSha256Normalized/);
  assert.match(host, /Replace\("\\r\\n", "\\n"\)\.Replace\("\\r", "\\n"\)/);
  assert.match(host, /integrity check failed for/);
  assert.match(host, /Direct-Xfer application runtime is missing or invalid/);
});

test('GitHub artifact contains launcher, ServerHost and portable directory directly', () => {
  assert.match(workflow, /path: dist\/Direct-Xfer-\$\{\{ env\.DX_VERSION \}\}-Windows-CSharp\//);
  assert.match(workflow, /include-hidden-files: true/);
  assert.doesNotMatch(workflow, /Compress-Archive/);
  assert.match(workflow, /Portable package is incomplete/);
  assert.match(workflow, /1\.59\.2-launcher28-csharp/);
  assert.match(workflow, /Direct-Xfer\.ServerHost\.exe/);
});
