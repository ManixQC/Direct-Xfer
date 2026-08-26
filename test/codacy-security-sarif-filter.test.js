'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  filterCodacySarif,
  isQualityOnlyTool,
  isDedicatedSecurityTool,
} = require('../scripts/filter-codacy-sarif');

const ROOT = path.resolve(__dirname, '..');

function run(name, results, rules = []) {
  return {
    tool: { driver: { name, rules } },
    results,
  };
}

function result(ruleId, message = 'finding', extra = {}) {
  return { ruleId, message: { text: message }, ...extra };
}

test('Codacy filter classifies explicit quality and security tools', () => {
  assert.equal(isQualityOnlyTool('Stylelint'), true);
  assert.equal(isQualityOnlyTool('JSHint'), true);
  assert.equal(isQualityOnlyTool('Prettier'), true);
  assert.equal(isQualityOnlyTool('ESLint'), false, 'mixed analyzers must be filtered per rule, not discarded wholesale');
  assert.equal(isDedicatedSecurityTool('Trivy'), true);
  assert.equal(isDedicatedSecurityTool('Bandit'), true);
});

test('quality-only runs become empty stable-category tombstones so prior alerts close', () => {
  const styleResults = Array.from({ length: 6001 }, (_, i) => result(`style-${i}`, 'formatting warning'));
  const filtered = filterCodacySarif({ version: '2.1.0', runs: [run('Stylelint', styleResults)] });
  assert.equal(filtered.document.runs.length, 2);
  assert.deepEqual(filtered.document.runs.map((r) => r.automationDetails.id), [
    'codacy/stylelint-0-part-1/',
    'codacy/stylelint-0-part-2/',
  ]);
  assert.deepEqual(filtered.document.runs.map((r) => r.results.length), [0, 0]);
  assert.equal(filtered.stats.filteredResults, 6001);
  assert.equal(filtered.stats.tombstoneRuns, 2);
});

test('mixed analyzers retain security metadata findings and drop ordinary quality warnings', () => {
  const rules = [
    { id: 'no-unused-vars', shortDescription: { text: 'unused variable' } },
    { id: 'detect-object-injection', properties: { tags: ['security', 'external/cwe/cwe-94'] } },
  ];
  const filtered = filterCodacySarif({
    version: '2.1.0',
    runs: [run('ESLint', [
      result('no-unused-vars', 'unused variable', { ruleIndex: 0 }),
      result('detect-object-injection', 'Possible command injection', { ruleIndex: 1 }),
    ], rules)],
  });
  assert.equal(filtered.document.runs.length, 1);
  assert.equal(filtered.document.runs[0].automationDetails.id, 'codacy/eslint-0/');
  assert.deepEqual(filtered.document.runs[0].results.map((r) => r.ruleId), ['detect-object-injection']);
});

test('dedicated security scanners keep their complete result set', () => {
  const filtered = filterCodacySarif({
    version: '2.1.0',
    runs: [run('Trivy', [result('AVD-001', 'generic wording')])],
  });
  assert.equal(filtered.document.runs[0].results.length, 1);
  assert.equal(filtered.stats.filteredResults, 0);
});

test('codacy workflow uploads only the filtered SARIF file', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'codacy.yml'), 'utf8');
  assert.match(workflow, /Filter Codacy SARIF for GitHub Security/);
  assert.match(workflow, /node scripts\/filter-codacy-sarif\.js results\.sarif results\.security\.sarif/);
  assert.match(workflow, /sarif_file:\s*results\.security\.sarif/);
  assert.doesNotMatch(workflow, /sarif_file:\s*results\.sarif\s*$/m);
  assert.match(workflow, /tombstone runs for Stylelint\/JSHint/);
});
