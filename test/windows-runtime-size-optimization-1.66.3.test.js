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
  assert.match(workflow, /Object\.keys\(require\('\.\/package\.json'\)\.dependencies \|\| \{\}\)/);
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

test('Windows Tesseract bundle keeps executable, DLL closure and selected OCR models instead of the full install tree', () => {
  assert.doesNotMatch(workflow, /Copy-Item -Path \(Join-Path \$tesseractStage '\*'\) -Destination \$tesseract -Recurse -Force/);
  assert.match(workflow, /Copy-Item -LiteralPath \$tesseractStageExe -Destination \$tesseractExe -Force/);
  assert.match(workflow, /Get-ChildItem -LiteralPath \$tesseractStage -Recurse -Filter '\*\.dll' -File/);
  assert.match(workflow, /foreach \(\$lang in @\('eng','fra','spa'\)\)/);
  assert.match(workflow, /Bundled OCR languages: eng, fra, spa/);
  assert.match(workflow, /DX_TESSERACT_RUNTIME_BUDGET_MB/);
});

test('Windows CI enforces size budgets after functional runtime probes', () => {
  assert.match(workflow, /DX_NODE_MODULES_BUDGET_MB:\s*'35'/);
  assert.match(workflow, /DX_TESSERACT_RUNTIME_BUDGET_MB:\s*'100'/);
  assert.match(workflow, /node_modules runtime exceeds the Direct-Xfer size budget/);
  assert.match(workflow, /Tesseract runtime exceeds the Direct-Xfer size budget/);
});
