'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-csharp.yml'), 'utf8');

test('Tesseract footprint uses a target plus a slightly higher hard ceiling', () => {
  assert.match(workflow, /DX_TESSERACT_RUNTIME_TARGET_MB:\s*'101'/);
  assert.match(workflow, /DX_TESSERACT_RUNTIME_BUDGET_MB:\s*'105'/);
  assert.match(workflow, /Write-Warning \(\"Tesseract runtime is above the optimization target:/);
  assert.match(workflow, /Tesseract runtime exceeds the Direct-Xfer hard size budget/);
});

test('Tesseract hard-budget failure prints the largest payload files for diagnosis', () => {
  assert.match(workflow, /Sort-Object Length -Descending \| Select-Object -First 12/);
  assert.match(workflow, /Largest Tesseract runtime files:/);
  assert.match(workflow, /GetRelativePath\(\$tesseract, \$file\.FullName\)/);
});

test('node_modules hard budget stays close to the observed optimized footprint', () => {
  assert.match(workflow, /DX_NODE_MODULES_BUDGET_MB:\s*'15'/);
  assert.doesNotMatch(workflow, /DX_NODE_MODULES_BUDGET_MB:\s*'35'/);
});
