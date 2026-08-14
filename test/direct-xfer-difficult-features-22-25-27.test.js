'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

// Feature 22 — tamper-evident audit chain.
test('feature 22 persists an HMAC chained audit journal with a signed head', () => {
  assert.match(server, /AUDIT_CHAIN_FILE\s*=\s*path\.join\(DATA_DIR,\s*'audit-chain\.log'\)/);
  assert.match(server, /AUDIT_KEY_FILE\s*=\s*path\.join\(DATA_DIR,\s*'audit-chain\.key'\)/);
  assert.match(server, /AUDIT_HMAC_ENV_SECRET\s*=\s*String\(process\.env\.AUDIT_HMAC_KEY/);
  assert.match(server, /AUDIT_HMAC_SECRET\s*=\s*String\(AUDIT_HMAC_ENV_SECRET \|\| DATA_KEY/);
  assert.match(server, /migrateLocalAuditKeyToExternalIfNeeded/);
  assert.match(server, /audit-key-migrated/);
  assert.match(server, /createHmac\('sha256',\s*key\)/);
  assert.match(server, /auditChainHashWithKey/);
  assert.match(server, /prevHash/);
  assert.match(server, /auditHeadSeal\(/);
  assert.match(server, /chain-truncated-or-head-mismatch/);
});

test('feature 22 exposes verification and integrity status in the admin UI', () => {
  assert.match(server, /adminRouter\.get\('\/audit\/verify'/);
  assert.match(server, /integrity:\s*verifyAuditChain\(\)/);
  assert.match(adminHtml, /id="audit-integrity"/);
  assert.match(adminHtml, /id="audit-verify"/);
  assert.match(adminJs, /verifyAuditIntegrity/);
  assert.match(adminJs, /renderAuditIntegrity/);
});

// Feature 25 — ransomware/anomaly protection.
test('feature 25 detects destructive bursts without automatically deleting user data', () => {
  assert.match(server, /function recordRansomwareEvent\(/);
  assert.match(server, /mass-delete/);
  assert.match(server, /suspicious-upload-burst/);
  assert.match(server, /suspiciousRansomwareName\(/);
  assert.match(server, /res\.status\(423\)\.json\(\{ error: 'security-blocked'/);
  assert.doesNotMatch(server, /blockRansomwareClient[\s\S]{0,1200}(?:unlinkSync|rmSync)\(/);
});

test('feature 25 has bounded configurable thresholds and an explicit unblock route', () => {
  assert.match(server, /ransomwareDeleteThreshold:\s*25/);
  assert.match(server, /ransomwareUploadThreshold:\s*120/);
  assert.match(server, /ransomwareBlockMinutes:\s*30/);
  assert.match(server, /clampNum\(body\.ransomwareDeleteThreshold,\s*5,\s*1000,\s*25\)/);
  assert.match(server, /clampNum\(body\.ransomwareUploadThreshold,\s*20,\s*5000,\s*120\)/);
  assert.match(server, /adminRouter\.post\('\/security\/anomalies\/unblock'/);
  assert.match(adminHtml, /cfg-ransom-blocks/);
  assert.match(adminJs, /refreshRansomwareStatus/);
});

// Feature 27 — persistent universal server search.
test('feature 27 uses a persistent search index rather than a filesystem scan per query', () => {
  assert.match(server, /SEARCH_INDEX_FILE\s*=\s*path\.join\(DATA_DIR,\s*'search-index\.json'\)/);
  assert.match(server, /function rebuildSearchPostings\(/);
  assert.match(server, /async function buildUniversalSearchIndex\(/);
  assert.match(server, /function universalSearchQuery\(/);
  assert.match(server, /adminRouter\.get\('\/search',\s*async/);
  assert.match(server, /universalSearchQuery\(q,\s*req,\s*limit(?:,\s*\{[^)]*\})?\)/);
});

test('feature 27 indexes text, PDF text layers, Office XML and ZIP entry names', () => {
  assert.match(server, /ext === 'pdf'/);
  assert.match(server, /extractPdfSearchText/);
  assert.match(server, /\['docx','docm'\]/);
  assert.match(server, /\['xlsx','xlsm'\]/);
  assert.match(server, /\['pptx','pptm'\]/);
  assert.match(server, /ext === 'zip'/);
  assert.match(server, /readZipEntries\(abs,\s*5000\)/);
});

test('feature 27 excludes revoked, secret and encrypted shares from indexing', () => {
  assert.match(server, /s\.revoked\s*\|\|\s*s\.type === 'secret'\s*\|\|\s*s\.encrypted/);
  assert.match(server, /ownsShare\(req,\s*share\)/);
});

test('feature 27 exposes index status and manual rebuild controls', () => {
  assert.match(server, /adminRouter\.get\('\/search\/status'/);
  assert.match(server, /adminRouter\.post\('\/search\/reindex'/);
  assert.match(adminHtml, /id="search-index-status"/);
  assert.match(adminHtml, /id="search-reindex"/);
  assert.match(adminJs, /refreshSearchIndexStatus/);
});
