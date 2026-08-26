'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterScorecardSarif } = require('../scripts/filter-scorecard-sarif');

function sample() {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'OpenSSF Scorecard', rules: [
        { id: 'CodeReviewID', name: 'Code-Review' },
        { id: 'VulnerabilitiesID', name: 'Vulnerabilities' },
        { id: 'TokenPermissionsID', name: 'Token-Permissions' },
        { id: 'ContributorsID', name: 'Contributors' },
      ] } },
      results: [
        { ruleId: 'CodeReviewID', message: { text: '0 approved changesets' } },
        { ruleId: 'VulnerabilitiesID', message: { text: 'known vulnerability' } },
        { ruleId: 'TokenPermissionsID', message: { text: 'write token permission' } },
        { ruleId: 'ContributorsID', message: { text: 'single organization' } },
      ],
    }],
  };
}

test('Scorecard SARIF filter removes governance-only findings from GitHub Security', () => {
  const out = filterScorecardSarif(sample());
  assert.deepEqual(out.document.runs[0].results.map((r) => r.ruleId), [
    'VulnerabilitiesID',
    'TokenPermissionsID',
  ]);
  assert.equal(out.stats.sourceResults, 4);
  assert.equal(out.stats.uploadedResults, 2);
  assert.equal(out.stats.filteredResults, 2);
  assert.deepEqual(out.stats.filteredRuleIds, ['CodeReviewID', 'ContributorsID']);
});

test('Scorecard SARIF filter preserves runs even when every finding is governance-only', () => {
  const doc = sample();
  doc.runs[0].results = [{ ruleId: 'CodeReviewID', message: { text: 'no review' } }];
  const out = filterScorecardSarif(doc);
  assert.equal(out.document.runs.length, 1);
  assert.deepEqual(out.document.runs[0].results, []);
});
