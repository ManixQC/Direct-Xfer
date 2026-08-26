'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_RESULTS_PER_RUN = 5000;
const MAX_RUNS = 20;

// These engines are code-quality/style analyzers. Their findings remain available
// in Codacy, but GitHub Security should not be used as a style/lint inbox.
const QUALITY_ONLY_TOOL_RE = /(?:^|[\s._/-])(?:stylelint|jshint|prettier|markdownlint|remark(?:-?lint)?|csslint|lizard|cloc|duplication|copy[- ]?paste|cpd)(?:$|[\s._/-])/i;

// Findings from dedicated security scanners can be forwarded as-is. Mixed or
// unknown analyzers are filtered per rule/result metadata below.
const DEDICATED_SECURITY_TOOL_RE = /(?:^|[\s._/-])(?:codeql|bandit|gosec|brakeman|checkov|kics|trivy|grype|gitleaks|njsscan|bearer|horusec|tfsec|semgrep)(?:$|[\s._/-])/i;

const SECURITY_MARKER_RE = /(?:\bsecurity\b|vulnerab|cwe[-_:/ ]?\d+|\bowasp\b|\binjection\b|cross[- ]site|\bxss\b|\bcsrf\b|\bssrf\b|path traversal|directory traversal|hardcoded (?:secret|credential|password)|credential leak|secret leak|password hash|clear.?text|weak (?:hash|crypt|cipher)|insecure (?:hash|crypt|cipher)|command injection|command execution|remote code execution|\brce\b|prototype pollution|deseriali[sz]ation|open redirect|log injection|\bredos\b|regular expression denial|denial of service|\bxxe\b|xml external entit|sensitive (?:data|information)|auth(?:entication|orization)? bypass|access control|sql injection|ldap injection|nosql injection|template injection|unsafe deserial)/i;

function slug(value) {
  const normalized = String(value || 'tool')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'tool';
}

function isQualityOnlyTool(name) {
  return QUALITY_ONLY_TOOL_RE.test(String(name || ''));
}

function isDedicatedSecurityTool(name) {
  return DEDICATED_SECURITY_TOOL_RE.test(String(name || ''));
}

function ruleFor(run, result) {
  const rules = Array.isArray(run?.tool?.driver?.rules) ? run.tool.driver.rules : [];
  if (Number.isInteger(result?.ruleIndex) && result.ruleIndex >= 0 && result.ruleIndex < rules.length) {
    return rules[result.ruleIndex] || {};
  }
  const ruleId = String(result?.ruleId || '');
  if (!ruleId) return {};
  return rules.find((rule) => String(rule?.id || '') === ruleId) || {};
}

function collectSecurityMetadata(run, result) {
  const rule = ruleFor(run, result);
  const tags = [];
  for (const candidate of [rule?.properties?.tags, result?.properties?.tags]) {
    if (Array.isArray(candidate)) tags.push(...candidate.map(String));
  }
  const securitySeverity = rule?.properties?.['security-severity'] ?? result?.properties?.['security-severity'];
  return {
    text: [
      result?.ruleId,
      rule?.id,
      rule?.name,
      rule?.shortDescription?.text,
      rule?.fullDescription?.text,
      rule?.help?.text,
      rule?.helpUri,
      result?.message?.text,
      ...tags,
    ].filter(Boolean).join(' '),
    hasSecuritySeverity: securitySeverity !== undefined && securitySeverity !== null && String(securitySeverity).trim() !== '',
  };
}

function isSecurityResult(run, result) {
  const metadata = collectSecurityMetadata(run, result);
  return metadata.hasSecuritySeverity || SECURITY_MARKER_RE.test(metadata.text);
}

function validateSarif(document) {
  if (!document || typeof document !== 'object') throw new Error('Codacy SARIF must be a JSON object.');
  if (typeof document.version !== 'string' || !document.version) throw new Error('Codacy SARIF has no version.');
  if (!Array.isArray(document.runs) || document.runs.length === 0) throw new Error('Codacy SARIF contains no runs.');
}

function filterCodacySarif(document) {
  validateSarif(document);

  const outputRuns = [];
  const summary = [];
  let sourceResults = 0;
  let uploadedResults = 0;
  let filteredResults = 0;
  let tombstoneRuns = 0;

  document.runs.forEach((run, runIndex) => {
    const toolName = String(run?.tool?.driver?.name || 'tool');
    const source = Array.isArray(run?.results) ? run.results : [];
    const chunkCount = Math.max(1, Math.ceil(source.length / MAX_RESULTS_PER_RUN));
    const qualityOnly = isQualityOnlyTool(toolName);
    const dedicatedSecurity = isDedicatedSecurityTool(toolName);
    let toolUploaded = 0;

    sourceResults += source.length;

    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const chunkResults = source.slice(chunk * MAX_RESULTS_PER_RUN, (chunk + 1) * MAX_RESULTS_PER_RUN);
      let kept;
      if (qualityOnly) {
        kept = [];
      } else if (dedicatedSecurity) {
        kept = chunkResults;
      } else {
        kept = chunkResults.filter((result) => isSecurityResult(run, result));
      }

      const automationDetails = {
        ...(run.automationDetails || {}),
        // Keep the exact category scheme used by the former normalizer. Empty
        // runs therefore act as tombstones and close previously uploaded lint
        // alerts instead of leaving 17k historical alerts stranded as "open".
        id: `codacy/${slug(toolName)}-${runIndex}${chunkCount > 1 ? `-part-${chunk + 1}` : ''}/`,
      };

      outputRuns.push({
        ...run,
        results: kept,
        automationDetails,
      });

      if (kept.length === 0 && chunkResults.length > 0) tombstoneRuns += 1;
      toolUploaded += kept.length;
      uploadedResults += kept.length;
      filteredResults += chunkResults.length - kept.length;
    }

    summary.push({
      tool: toolName,
      mode: qualityOnly ? 'quality-only' : (dedicatedSecurity ? 'security-tool' : 'metadata-filter'),
      source: source.length,
      uploaded: toolUploaded,
      filtered: source.length - toolUploaded,
      chunks: chunkCount,
    });
  });

  if (outputRuns.length === 0) throw new Error('Security SARIF contains no runs after filtering.');
  if (outputRuns.length > MAX_RUNS) {
    throw new Error(`Security SARIF contains ${outputRuns.length} runs; GitHub accepts at most ${MAX_RUNS} runs per SARIF file.`);
  }
  const maxResults = Math.max(0, ...outputRuns.map((run) => Array.isArray(run.results) ? run.results.length : 0));
  if (maxResults > MAX_RESULTS_PER_RUN) {
    throw new Error(`A filtered SARIF run contains ${maxResults} results; limit is ${MAX_RESULTS_PER_RUN}.`);
  }
  const ids = outputRuns.map((run) => String(run?.automationDetails?.id || ''));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('Filtered Codacy SARIF automationDetails.id values must be non-empty and unique.');
  }

  return {
    document: { ...document, runs: outputRuns },
    stats: { sourceResults, uploadedResults, filteredResults, tombstoneRuns, runCount: outputRuns.length, maxResults },
    summary,
  };
}

function main(argv = process.argv.slice(2)) {
  const inputPath = path.resolve(argv[0] || 'results.sarif');
  const outputPath = path.resolve(argv[1] || 'results.security.sarif');
  const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const filtered = filterCodacySarif(source);
  fs.writeFileSync(outputPath, `${JSON.stringify(filtered.document, null, 2)}\n`, 'utf8');

  const { stats } = filtered;
  console.log(`Codacy SARIF security filter: source=${stats.sourceResults} upload=${stats.uploadedResults} filtered=${stats.filteredResults} runs=${stats.runCount} tombstones=${stats.tombstoneRuns}`);
  for (const row of filtered.summary) {
    console.log(`  ${row.tool}: mode=${row.mode} source=${row.source} upload=${row.uploaded} filtered=${row.filtered} chunks=${row.chunks}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Codacy SARIF security filter failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_RESULTS_PER_RUN,
  MAX_RUNS,
  slug,
  isQualityOnlyTool,
  isDedicatedSecurityTool,
  isSecurityResult,
  filterCodacySarif,
};
