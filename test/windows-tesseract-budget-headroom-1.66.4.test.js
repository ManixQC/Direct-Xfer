'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-csharp.yml'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'windows-launcher', 'Program.cs'), 'utf8');

test('Tesseract no longer consumes any base-installer size budget', () => {
  assert.doesNotMatch(workflow, /DX_TESSERACT_RUNTIME_TARGET_MB|DX_TESSERACT_RUNTIME_BUDGET_MB/);
  assert.match(workflow, /optional rclone\/Tesseract excluded/);
  assert.match(workflow, /Optional Windows component leaked into the default payload/);
});

test('on-demand downloads remain bounded and validated independently of installer size', () => {
  assert.match(launcher, /DownloadOptionalFile\(string url, string destination, string\? expectedSha256, long minimumBytes, long maximumBytes\)/);
  assert.match(launcher, /Optional component download exceeded the allowed limit/);
  assert.match(launcher, /Optional component SHA-256 verification failed/);
  assert.match(launcher, /DownloadOptionalFile\(url, setup, Program\.TesseractSetupSha256, 20L \* 1024 \* 1024, 250L \* 1024 \* 1024\)/);
});

test('node_modules hard budget stays close to the observed optimized footprint', () => {
  assert.match(workflow, /DX_NODE_MODULES_BUDGET_MB:\s*'15'/);
  assert.doesNotMatch(workflow, /DX_NODE_MODULES_BUDGET_MB:\s*'35'/);
});
