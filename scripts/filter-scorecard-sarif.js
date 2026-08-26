'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Scorecard intentionally mixes technical security controls with project-health
// and governance signals. Direct-Xfer keeps the full report as an Actions
// artifact / published Scorecard result, but GitHub Code Scanning is reserved
// for findings that point to a concrete technical security control.
const GOVERNANCE_ONLY_RULE_IDS = new Set([
  'CIIBestPracticesID',
  'CITestsID',
  'CodeReviewID',
  'ContributorsID',
  'DependencyUpdateToolID',
  'LicenseID',
  'MaintainedID',
  'PackagingID',
]);

function validateSarif(document) {
  if (!document || typeof document !== 'object') throw new Error('Scorecard SARIF must be a JSON object.');
  if (typeof document.version !== 'string' || !document.version) throw new Error('Scorecard SARIF has no version.');
  if (!Array.isArray(document.runs) || document.runs.length === 0) throw new Error('Scorecard SARIF contains no runs.');
}

function filterScorecardSarif(document) {
  validateSarif(document);
  let sourceResults = 0;
  let uploadedResults = 0;
  let filteredResults = 0;
  const filteredRuleIds = new Set();

  const runs = document.runs.map((run) => {
    const results = Array.isArray(run.results) ? run.results : [];
    sourceResults += results.length;
    const kept = results.filter((result) => {
      const ruleId = String(result?.ruleId || '');
      if (!GOVERNANCE_ONLY_RULE_IDS.has(ruleId)) return true;
      filteredResults += 1;
      filteredRuleIds.add(ruleId);
      return false;
    });
    uploadedResults += kept.length;
    return { ...run, results: kept };
  });

  return {
    document: { ...document, runs },
    stats: {
      sourceResults,
      uploadedResults,
      filteredResults,
      filteredRuleIds: [...filteredRuleIds].sort(),
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const inputPath = path.resolve(argv[0] || 'scorecard-results.sarif');
  const outputPath = path.resolve(argv[1] || 'scorecard-security.sarif');
  const document = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const filtered = filterScorecardSarif(document);
  fs.writeFileSync(outputPath, `${JSON.stringify(filtered.document, null, 2)}\n`, 'utf8');
  const s = filtered.stats;
  console.log(`Scorecard SARIF security filter: source=${s.sourceResults} upload=${s.uploadedResults} filtered=${s.filteredResults}`);
  if (s.filteredRuleIds.length) console.log(`  governance-only rules omitted from Code Scanning: ${s.filteredRuleIds.join(', ')}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Scorecard SARIF security filter failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

module.exports = { GOVERNANCE_ONLY_RULE_IDS, filterScorecardSarif };
