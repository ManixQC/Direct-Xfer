'use strict';

const CANONICAL_REPOSITORY = 'ManixQC/Direct-Xfer';
const CANONICAL_REF = 'refs/heads/main';
const API_VERSION = '2022-11-28';
const DEFAULT_MAX_PASSES = 100;
const DEFAULT_MAX_DELETES = 2000;

// These are the exact legacy broad Codacy quality analyzers that previously
// populated GitHub Code Scanning. Current security analyzers are intentionally
// absent (CodeQL, Trivy, Scorecard, zizmor and Eslint-9).
const LEGACY_CODACY_QUALITY_TOOLS = Object.freeze([
  'CSSLint (reported by Codacy)',
  'JSHint (reported by Codacy)',
  'PSScriptAnalyzer (reported by Codacy)',
  'Remark-Lint (reported by Codacy)',
  'ShellCheck (reported by Codacy)',
  'SonarCSharp (reported by Codacy)',
  'SonarSharp (reported by Codacy)',
  'Sonarscharp (reported by Codacy)',
  'SQLint (reported by Codacy)',
  'Stylelint (reported by Codacy)',
  'TSqlLint (reported by Codacy)',
  'Hadolint (reported by Codacy)',
  'JacksonLinter (reported by Codacy)',
]);

const LEGACY_TOOL_KEYS = new Set(LEGACY_CODACY_QUALITY_TOOLS.map(normalizeToolName));

function normalizeToolName(name) {
  return String(name || '').trim().toLowerCase();
}

function isLegacyCodacyQualityTool(name) {
  return LEGACY_TOOL_KEYS.has(normalizeToolName(name));
}

function parseRepository(repository) {
  const value = String(repository || '').trim();
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) throw new Error(`Invalid GITHUB_REPOSITORY value: ${value || '(empty)'}`);
  return { owner: match[1], repo: match[2] };
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'direct-xfer-legacy-codacy-cleanup',
  };
}

async function responseBody(response) {
  try {
    const text = await response.text();
    return text ? text.slice(0, 2000) : '';
  } catch {
    return '';
  }
}

async function listCodeScanningAnalyses({ fetchImpl, token, owner, repo, ref }) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ ref, per_page: '100', page: String(page) });
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/code-scanning/analyses?${query}`;
    const response = await fetchImpl(url, { method: 'GET', headers: githubHeaders(token) });
    if (!response.ok) {
      throw new Error(`GitHub Code Scanning analyses GET failed (${response.status}): ${await responseBody(response)}`);
    }
    const pageItems = await response.json();
    if (!Array.isArray(pageItems)) throw new Error('GitHub Code Scanning analyses response is not an array.');
    all.push(...pageItems);
    if (pageItems.length < 100) break;
    if (page >= 1000) throw new Error('Refusing to paginate more than 1000 Code Scanning pages.');
  }
  return all;
}

async function deleteCodeScanningAnalysis({ fetchImpl, token, owner, repo, analysisId }) {
  if (!Number.isInteger(analysisId) || analysisId <= 0) {
    throw new Error(`Invalid Code Scanning analysis id: ${analysisId}`);
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/code-scanning/analyses/${analysisId}?confirm_delete=true`;
  const response = await fetchImpl(url, { method: 'DELETE', headers: githubHeaders(token) });
  // GitHub's analyses listing is eventually consistent after DELETE. An analysis
  // may remain visible for a few seconds even though a prior DELETE succeeded.
  // Treat 404 as an idempotent success only for the exact analysis id that this
  // tightly allowlisted cleanup already selected. All other HTTP failures stay
  // fail-closed.
  if (response.status === 404) {
    return { deleted: false, alreadyAbsent: true };
  }
  if (!response.ok) {
    throw new Error(`GitHub Code Scanning analysis DELETE failed for ${analysisId} (${response.status}): ${await responseBody(response)}`);
  }
  return { deleted: true, alreadyAbsent: false };
}

function toolNameOf(analysis) {
  return String(analysis?.tool?.name || '');
}

function categoryOf(analysis) {
  return String(analysis?.category || '');
}

function summarizeCandidates(candidates) {
  const byTool = new Map();
  for (const analysis of candidates) {
    const tool = toolNameOf(analysis) || '(unknown tool)';
    byTool.set(tool, (byTool.get(tool) || 0) + 1);
  }
  return [...byTool.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function cleanupLegacyCodacyAnalyses(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available.');

  const repository = options.repository || process.env.GITHUB_REPOSITORY || '';
  const ref = options.ref || process.env.GITHUB_REF || '';
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const apply = options.apply === true;
  const maxPasses = Number.isInteger(options.maxPasses) ? options.maxPasses : DEFAULT_MAX_PASSES;
  const maxDeletes = Number.isInteger(options.maxDeletes) ? options.maxDeletes : DEFAULT_MAX_DELETES;

  if (apply && repository !== CANONICAL_REPOSITORY) {
    throw new Error(`Refusing destructive cleanup outside ${CANONICAL_REPOSITORY}; got ${repository || '(empty)'}.`);
  }
  if (apply && ref !== CANONICAL_REF) {
    throw new Error(`Refusing destructive cleanup outside ${CANONICAL_REF}; got ${ref || '(empty)'}.`);
  }
  if (!token) throw new Error('GH_TOKEN/GITHUB_TOKEN is required to query Code Scanning analyses.');
  if (maxPasses < 1 || maxDeletes < 1) throw new Error('Cleanup bounds must be positive integers.');

  const { owner, repo } = parseRepository(repository);
  let deleted = 0;
  let alreadyAbsent = 0;
  let passes = 0;
  let lastCandidates = [];
  const completedIds = new Set();

  while (passes < maxPasses) {
    passes += 1;
    const analyses = await listCodeScanningAnalyses({ fetchImpl, token, owner, repo, ref });
    const candidates = analyses.filter((analysis) => (
      analysis?.ref === ref && isLegacyCodacyQualityTool(toolNameOf(analysis))
    ));
    lastCandidates = candidates;

    if (candidates.length === 0) {
      return { apply, deleted, alreadyAbsent, passes, remaining: 0, byTool: [] };
    }

    const byTool = summarizeCandidates(candidates);
    if (!apply) {
      return { apply, deleted: 0, passes, remaining: candidates.length, byTool };
    }

    // Ignore stale copies of analyses already completed in this process. GitHub
    // can return a just-deleted analysis again on the next list request.
    const pending = candidates.filter((analysis) => !completedIds.has(analysis?.id));
    if (pending.length === 0) {
      return { apply, deleted, alreadyAbsent, passes, remaining: 0, byTool: [] };
    }

    const deletable = pending.filter((analysis) => analysis?.deletable === true);
    if (deletable.length === 0) {
      const sample = pending.slice(0, 5).map((analysis) => (
        `${analysis.id}:${toolNameOf(analysis)}:${categoryOf(analysis) || '(no category)'}`
      )).join(', ');
      throw new Error(`Legacy Codacy analyses remain but none are deletable. Sample: ${sample}`);
    }

    for (const analysis of deletable) {
      // Defensive against duplicate items across a paginated GitHub snapshot.
      if (completedIds.has(analysis.id)) continue;
      if ((deleted + alreadyAbsent) >= maxDeletes) {
        throw new Error(`Refusing to process more than ${maxDeletes} Code Scanning analysis deletions in one run.`);
      }
      const outcome = await deleteCodeScanningAnalysis({ fetchImpl, token, owner, repo, analysisId: analysis.id });
      completedIds.add(analysis.id);
      if (outcome.alreadyAbsent) {
        alreadyAbsent += 1;
        console.log(`Legacy Codacy analysis already absent id=${analysis.id} tool=${toolNameOf(analysis)} category=${categoryOf(analysis) || '(none)'}; continuing`);
        continue;
      }
      deleted += 1;
      console.log(`Deleted legacy Codacy analysis id=${analysis.id} tool=${toolNameOf(analysis)} category=${categoryOf(analysis) || '(none)'}`);
    }
  }

  throw new Error(`Legacy Codacy cleanup exceeded ${maxPasses} passes with ${lastCandidates.length} candidate analyses still visible.`);
}

function parseArgs(argv) {
  const args = new Set(argv);
  const unknown = [...args].filter((arg) => arg !== '--apply' && arg !== '--dry-run');
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
  if (args.has('--apply') && args.has('--dry-run')) throw new Error('Choose either --apply or --dry-run, not both.');
  return { apply: args.has('--apply') };
}

async function main(argv = process.argv.slice(2)) {
  const { apply } = parseArgs(argv);
  const result = await cleanupLegacyCodacyAnalyses({ apply });
  if (!apply) {
    console.log(`Legacy Codacy cleanup dry-run: ${result.remaining} analysis(es) would be removed.`);
    for (const [tool, count] of result.byTool) console.log(`  ${tool}: ${count}`);
    return;
  }
  console.log(`Legacy Codacy cleanup complete: deleted=${result.deleted} already-absent=${result.alreadyAbsent || 0} passes=${result.passes} remaining=${result.remaining}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Legacy Codacy cleanup failed: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  API_VERSION,
  CANONICAL_REPOSITORY,
  CANONICAL_REF,
  LEGACY_CODACY_QUALITY_TOOLS,
  normalizeToolName,
  isLegacyCodacyQualityTool,
  listCodeScanningAnalyses,
  deleteCodeScanningAnalysis,
  cleanupLegacyCodacyAnalyses,
  parseArgs,
};
