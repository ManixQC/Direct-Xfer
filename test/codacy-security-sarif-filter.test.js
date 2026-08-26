'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  LEGACY_BROAD_CODACY_CATEGORIES,
  filterCodacySarif,
  buildLegacyCodacyTombstoneSarif,
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

test('quality-only runs are excluded from the current security namespace', () => {
  const styleResults = Array.from({ length: 6001 }, (_, i) => result(`style-${i}`, 'formatting warning'));
  const filtered = filterCodacySarif({ version: '2.1.0', runs: [run('Stylelint (reported by Codacy)', styleResults)] });
  assert.equal(filtered.document.runs.length, 1, 'quality-only input still emits one harmless empty security run');
  assert.equal(filtered.document.runs[0].automationDetails.id, 'codacy-security/empty/');
  assert.deepEqual(filtered.document.runs[0].results, []);
  assert.equal(filtered.stats.filteredResults, 6001);
});

test('legacy tombstones reproduce the exact ff5ccb27 broad Codacy categories', () => {
  const legacy = buildLegacyCodacyTombstoneSarif({ version: '2.1.0' });
  assert.equal(legacy.runs.length, 13);
  assert.deepEqual(legacy.runs.map((r) => r.automationDetails.id), [
    'codacy/sqlint-reported-by-codacy-0/',
    'codacy/hadolint-reported-by-codacy-1/',
    'codacy/csslint-reported-by-codacy-2/',
    'codacy/sonarscharp-reported-by-codacy-3/',
    'codacy/remark-lint-reported-by-codacy-4/',
    'codacy/jacksonlinter-reported-by-codacy-5/',
    'codacy/stylelint-reported-by-codacy-6-part-1/',
    'codacy/stylelint-reported-by-codacy-6-part-2/',
    'codacy/shellcheck-reported-by-codacy-7/',
    'codacy/jshint-reported-by-codacy-8-part-1/',
    'codacy/jshint-reported-by-codacy-8-part-2/',
    'codacy/psscriptanalyzer-reported-by-codacy-9/',
    'codacy/tsqllint-reported-by-codacy-10/',
  ]);
  assert.deepEqual(legacy.runs.map((r) => r.results.length), Array(13).fill(0));
  assert.equal(LEGACY_BROAD_CODACY_CATEGORIES.length, 13);
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
  assert.equal(filtered.document.runs[0].automationDetails.id, 'codacy-security/eslint/');
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

test('codacy workflow uploads legacy cleanup and current security SARIF, never raw Codacy output', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'codacy.yml'), 'utf8');
  assert.match(workflow, /Filter Codacy SARIF for GitHub Security/);
  assert.match(workflow, /node scripts\/filter-codacy-sarif\.js results\.sarif results\.security\.sarif results\.legacy-tombstones\.sarif/);
  assert.match(workflow, /Close legacy Codacy quality alerts/);
  assert.match(workflow, /sarif_file:\s*results\.legacy-tombstones\.sarif/);
  assert.match(workflow, /Upload filtered Codacy security results/);
  assert.match(workflow, /sarif_file:\s*results\.security\.sarif/);
  assert.doesNotMatch(workflow, /sarif_file:\s*results\.sarif\s*$/m);
});
