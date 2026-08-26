'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CODE_SCANNING_RULE_IDS, filterScorecardSarif } = require('../scripts/filter-scorecard-sarif');

function sample() {
  return {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'OpenSSF Scorecard', rules: [
        { id: 'CodeReviewID', name: 'Code-Review' },
        { id: 'BranchProtectionID', name: 'Branch-Protection' },
        { id: 'FuzzingID', name: 'Fuzzing' },
        { id: 'SecurityPolicyID', name: 'Security-Policy' },
        { id: 'VulnerabilitiesID', name: 'Vulnerabilities' },
        { id: 'TokenPermissionsID', name: 'Token-Permissions' },
        { id: 'PinnedDependenciesID', name: 'Pinned-Dependencies' },
        { id: 'DangerousWorkflowID', name: 'Dangerous-Workflow' },
        { id: 'ContributorsID', name: 'Contributors' },
      ] } },
      results: [
        { ruleId: 'CodeReviewID', message: { text: '0 approved changesets' } },
        { ruleId: 'BranchProtectionID', message: { text: 'branch protection disabled' } },
        { ruleId: 'FuzzingID', message: { text: 'no fuzzing' } },
        { ruleId: 'SecurityPolicyID', message: { text: 'security policy posture' } },
        { ruleId: 'VulnerabilitiesID', message: { text: 'known vulnerability' } },
        { ruleId: 'TokenPermissionsID', message: { text: 'write token permission' } },
        { ruleId: 'PinnedDependenciesID', message: { text: 'floating dependency' } },
        { ruleId: 'DangerousWorkflowID', message: { text: 'dangerous workflow pattern' } },
        { ruleId: 'ContributorsID', message: { text: 'single organization' } },
      ],
    }],
  };
}

test('Scorecard Code Scanning allowlist contains only concrete technical findings', () => {
  assert.deepEqual([...CODE_SCANNING_RULE_IDS].sort(), [
    'DangerousWorkflowID',
    'PinnedDependenciesID',
    'TokenPermissionsID',
    'VulnerabilitiesID',
  ]);
});

test('Scorecard SARIF filter keeps technical security findings and removes posture/governance', () => {
  const out = filterScorecardSarif(sample());
  assert.deepEqual(out.document.runs[0].results.map((r) => r.ruleId), [
    'VulnerabilitiesID',
    'TokenPermissionsID',
    'PinnedDependenciesID',
    'DangerousWorkflowID',
  ]);
  assert.equal(out.stats.sourceResults, 9);
  assert.equal(out.stats.uploadedResults, 4);
  assert.equal(out.stats.filteredResults, 5);
  assert.deepEqual(out.stats.filteredRuleIds, [
    'BranchProtectionID',
    'CodeReviewID',
    'ContributorsID',
    'FuzzingID',
    'SecurityPolicyID',
  ]);
});

test('Scorecard SARIF filter preserves runs even when every finding is posture-only', () => {
  const doc = sample();
  doc.runs[0].results = [{ ruleId: 'BranchProtectionID', message: { text: 'no protection' } }];
  const out = filterScorecardSarif(doc);
  assert.equal(out.document.runs.length, 1);
  assert.deepEqual(out.document.runs[0].results, []);
});

test('unknown future Scorecard rules fail closed out of GitHub Code Scanning', () => {
  const doc = sample();
  doc.runs[0].results = [{ ruleId: 'FuturePostureRuleID', message: { text: 'new posture check' } }];
  const out = filterScorecardSarif(doc);
  assert.deepEqual(out.document.runs[0].results, []);
  assert.deepEqual(out.stats.filteredRuleIds, ['FuturePostureRuleID']);
});
