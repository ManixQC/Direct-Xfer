'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-csharp.yml'), 'utf8');
const pruneScript = fs.readFileSync(path.join(root, '.github', 'scripts', 'prune-windows-node-modules.ps1'), 'utf8');

test('Windows runtime installs production-only Node dependencies instead of copying the test tree', () => {
  assert.doesNotMatch(workflow, /Copy-Item\s+@\('lib','public','pwa','scripts','security','node_modules'\)/);
  assert.match(workflow, /Copy-Item\s+@\('lib','public','pwa','scripts','security'\)\s+\$app\s+-Recurse/);
  assert.match(workflow, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /prune-windows-node-modules\.ps1/);
  assert.match(workflow, /await import\(name\)/);
});

test('Node pruning preserves licenses and only targets development metadata', () => {
  assert.match(pruneScript, /'test', 'tests', 'testing'/);
  assert.match(pruneScript, /\.Extension -eq '\.map'/);
  assert.match(pruneScript, /EndsWith\('\.D\.TS'\)/);
  assert.match(pruneScript, /StartsWith\('LICENSE'\)/);
  assert.match(pruneScript, /StartsWith\('COPYING'\)/);
  assert.match(pruneScript, /StartsWith\('NOTICE'\)/);
  assert.doesNotMatch(pruneScript, /Remove-Item[^\n]+package\.json/i);
});

test('Windows base payload excludes heavyweight optional rclone and Tesseract trees', () => {
  assert.match(workflow, /rclone\/Tesseract as opt-in post-install components/);
  assert.match(workflow, /optional rclone\/Tesseract excluded/);
  assert.match(workflow, /foreach \(\$optionalRel in @\('runtime\\rclone','runtime\\tesseract'\)\)/);
  assert.match(workflow, /Optional Windows component leaked into the default payload/);
  assert.doesNotMatch(workflow, /DX_TESSERACT_RUNTIME_BUDGET_MB|DX_TESSERACT_RUNTIME_TARGET_MB|DX_RCLONE_VERSION/);
});

test('Windows CI keeps a tight production node_modules hard budget', () => {
  assert.match(workflow, /DX_NODE_MODULES_BUDGET_MB:\s*'15'/);
  assert.match(workflow, /node_modules runtime exceeds the Direct-Xfer size budget/);
  assert.doesNotMatch(workflow, /DX_NODE_MODULES_BUDGET_MB:\s*'35'/);
});
