'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const AUDIT_GATE = /npm audit --omit=dev --audit-level=moderate/;

test('dedicated npm audit workflow checks lockfile changes and the advisory database daily', () => {
  const workflow = read('.github/workflows/npm-audit.yml');
  assert.match(workflow, /name:\s*npm Audit/);
  assert.match(workflow, /package-lock\.json/);
  assert.match(workflow, /cron:\s*["']27 6 \* \* \*["']/);
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, AUDIT_GATE);
  assert.doesNotMatch(workflow, /\bnpm\s+audit\s+fix\b/);
});

test('npm audit gate fails on Moderate or more severe production advisories only', () => {
  const workflow = read('.github/workflows/npm-audit.yml');
  assert.match(workflow, /--omit=dev/);
  assert.match(workflow, /--audit-level=moderate/);
  assert.doesNotMatch(workflow, /--audit-level=high/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});

test('Windows release build uses the same npm audit threshold', () => {
  const workflow = read('.github/workflows/build-windows-csharp.yml');
  assert.match(workflow, /- name: Audit production dependencies[\s\S]*?npm audit --omit=dev --audit-level=moderate/);
  assert.doesNotMatch(workflow, /npm audit --omit=dev --audit-level=high/);
});
