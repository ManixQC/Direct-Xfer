'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

test('audit verification treats a missing or unreadable signed head as an integrity failure', () => {
  assert.match(server, /return \{ missing: true \}/);
  assert.match(server, /reason = 'head-missing'/);
  assert.match(server, /chain-rollback-detected/);
  assert.match(server, /state-audit-head-mismatch/);
  assert.match(server, /reason = signedHead\.reason === 'signature' \? 'head-signature-invalid' : 'head-unreadable'/);
});

test('full audit export reads the append-only chain instead of the 500-row UI cache', () => {
  const route = server.slice(server.indexOf("adminRouter.get('/audit/export'"), server.indexOf("adminRouter.get('/shares'"));
  assert.match(route, /parseAuditChainFile\(\)\.entries/);
  assert.doesNotMatch(route, /const entries = state\.audit \|\| \[\]/);
});

test('search results re-check current share eligibility and use the live share token', () => {
  assert.match(server, /function universalSearchShareEligible\(share\)/);
  assert.match(server, /universalSearchShareEligible\(share\) && ownsShare\(req, share\)/);
  assert.match(server, /if \(!share \|\| !canAccess\(share, d\)\) continue/);
  assert.match(server, /token:share\.token \|\| d\.token/);
});

test('retention and per-file expiry schedule a search rebuild when files disappear', () => {
  const oldInbox = server.slice(server.indexOf('function purgeOldInbox()'), server.indexOf('// Per-file expiry'));
  const expired = server.slice(server.indexOf('function purgeExpiredFiles()'), server.indexOf('// --- Ransomware'));
  assert.match(oldInbox, /scheduleSearchReindex\(\)/);
  assert.match(expired, /scheduleSearchReindex\(\)/);
});

test('server OCR verifies requested Tesseract language packs before declaring OCR available', () => {
  assert.match(server, /\['--list-langs'\]/);
  assert.match(server, /missingLanguages/);
  assert.match(server, /const tesseract = !!tesseractBinary && missingLanguages\.length === 0/);
  assert.match(adminJs, /search\.ocrMissingLangs/);
});

test('search index and OCR cache follow DATA_KEY encryption at rest', () => {
  const loadIndex = server.slice(server.indexOf('function loadSearchIndex()'), server.indexOf('function xmlToSearchText'));
  const ocrCache = server.slice(server.indexOf('function loadSearchOcrCache()'), server.indexOf('function searchOcrCacheKey'));
  assert.match(loadIndex, /deserializeStore\(/);
  assert.match(loadIndex, /DATA_KEY \? encryptStore\(json\) : json/);
  assert.match(ocrCache, /deserializeStore\(/);
  assert.match(ocrCache, /DATA_KEY \? encryptStore\(json\) : json/);
});

test('searchable PDF text layers are not appended to themselves before truncation', () => {
  const ocr = server.slice(server.indexOf('async function extractServerOcrText'), server.indexOf('async function extractUniversalSearchContent'));
  assert.match(ocr, /const rec = \{ text:'', ocr:false, source:'pdf-text'/);
  assert.match(ocr, /const supplemental = String\(popplerText \|\| ''\)/);
});
