'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CANONICAL_REPOSITORY,
  CANONICAL_REF,
  LEGACY_CODACY_QUALITY_TOOLS,
  isLegacyCodacyQualityTool,
  listCodeScanningAnalyses,
  cleanupLegacyCodacyAnalyses,
} = require('../scripts/cleanup-legacy-codacy-analyses');

function responseJson(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return value; },
    async text() { return JSON.stringify(value); },
  };
}

function responseEmpty(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return {}; },
    async text() { return ''; },
  };
}

test('legacy cleanup targets only explicit broad Codacy quality tool identities', () => {
  for (const name of LEGACY_CODACY_QUALITY_TOOLS) {
    assert.equal(isLegacyCodacyQualityTool(name), true, name);
    assert.equal(isLegacyCodacyQualityTool(name.toLowerCase()), true, `${name} case-insensitive`);
  }
  for (const protectedTool of [
    'CodeQL',
    'Trivy',
    'Scorecard',
    'zizmor',
    'Eslint-9 (reported by Codacy)',
    'ESLint 9 (reported by Codacy)',
    'Semgrep',
  ]) {
    assert.equal(isLegacyCodacyQualityTool(protectedTool), false, `${protectedTool} must never be deleted`);
  }
});

test('analysis listing paginates until a short page', async () => {
  const pages = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET');
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    if (page === 1) return responseJson(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })));
    if (page === 2) return responseJson([{ id: 101 }]);
    throw new Error(`unexpected page ${page}`);
  };
  const analyses = await listCodeScanningAnalyses({
    fetchImpl,
    token: 'test-token',
    owner: 'ManixQC',
    repo: 'Direct-Xfer',
    ref: CANONICAL_REF,
  });
  assert.equal(analyses.length, 101);
  assert.deepEqual(pages, [1, 2]);
});

test('apply mode iteratively deletes only legacy Codacy analyses on canonical main', async () => {
  let analyses = [
    { id: 1, ref: CANONICAL_REF, tool: { name: 'CodeQL' }, category: 'javascript-typescript', deletable: true },
    { id: 2, ref: CANONICAL_REF, tool: { name: 'Eslint-9 (reported by Codacy)' }, category: 'codacy-security/eslint-9/', deletable: true },
    { id: 3, ref: CANONICAL_REF, tool: { name: 'Stylelint (reported by Codacy)' }, category: 'codacy/stylelint-reported-by-codacy-6/', deletable: true },
    { id: 4, ref: CANONICAL_REF, tool: { name: 'Stylelint (reported by Codacy)' }, category: '', deletable: false },
    { id: 5, ref: CANONICAL_REF, tool: { name: 'JSHint (reported by Codacy)' }, category: 'codacy/jshint-reported-by-codacy-8/', deletable: true },
    { id: 6, ref: 'refs/heads/old', tool: { name: 'Stylelint (reported by Codacy)' }, category: '', deletable: true },
  ];
  const deleted = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (init.method === 'GET') return responseJson(analyses);
    if (init.method === 'DELETE') {
      assert.equal(parsed.searchParams.get('confirm_delete'), 'true');
      const id = Number(parsed.pathname.split('/').pop());
      deleted.push(id);
      analyses = analyses.filter((x) => x.id !== id);
      // GitHub exposes only the latest analysis in a set as deletable. Once it is
      // removed, the previous one becomes the next deletable analysis.
      const remainingStyle = analyses.filter((x) => x.ref === CANONICAL_REF && x.tool.name === 'Stylelint (reported by Codacy)');
      if (remainingStyle.length) remainingStyle[0].deletable = true;
      return responseEmpty(200);
    }
    throw new Error(`unexpected method ${init.method}`);
  };

  const result = await cleanupLegacyCodacyAnalyses({
    fetchImpl,
    token: 'test-token',
    repository: CANONICAL_REPOSITORY,
    ref: CANONICAL_REF,
    apply: true,
  });

  assert.deepEqual(deleted.sort((a, b) => a - b), [3, 4, 5]);
  assert.equal(result.deleted, 3);
  assert.equal(result.remaining, 0);
  assert.ok(analyses.some((x) => x.id === 1), 'CodeQL analysis must remain');
  assert.ok(analyses.some((x) => x.id === 2), 'current Codacy security analysis must remain');
  assert.ok(analyses.some((x) => x.id === 6), 'legacy analyses on another ref must remain');
});

test('dry-run reports legacy analyses without deleting them', async () => {
  let deletes = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') {
      return responseJson([{ id: 10, ref: CANONICAL_REF, tool: { name: 'CSSLint (reported by Codacy)' }, deletable: true }]);
    }
    deletes += 1;
    return responseEmpty();
  };
  const result = await cleanupLegacyCodacyAnalyses({
    fetchImpl,
    token: 'test-token',
    repository: CANONICAL_REPOSITORY,
    ref: CANONICAL_REF,
    apply: false,
  });
  assert.equal(result.remaining, 1);
  assert.equal(deletes, 0);
});

test('destructive cleanup refuses non-canonical repository or ref', async () => {
  const noFetch = async () => { throw new Error('fetch should not run'); };
  await assert.rejects(
    cleanupLegacyCodacyAnalyses({ fetchImpl: noFetch, token: 'x', repository: 'fork/Direct-Xfer', ref: CANONICAL_REF, apply: true }),
    /Refusing destructive cleanup outside ManixQC\/Direct-Xfer/,
  );
  await assert.rejects(
    cleanupLegacyCodacyAnalyses({ fetchImpl: noFetch, token: 'x', repository: CANONICAL_REPOSITORY, ref: 'refs/heads/dev', apply: true }),
    /Refusing destructive cleanup outside refs\/heads\/main/,
  );
});
