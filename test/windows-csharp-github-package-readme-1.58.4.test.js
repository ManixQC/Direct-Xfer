'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-windows-csharp.yml'), 'utf8');

test('Windows C# GitHub packaging does not fail when portable README is absent', () => {
  assert.match(workflow, /if \(Test-Path \$portableReadme\)/);
  assert.match(workflow, /elseif \(Test-Path \$rootReadme\)/);
  assert.match(workflow, /Set-Content -Encoding UTF8 -Path \$destReadme/);
  assert.doesNotMatch(workflow, /^\s*Copy-Item 'windows-launcher\\README-WINDOWS-PORTABLE\.md' -Destination \$dist -Force\s*$/m);
});
