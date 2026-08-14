'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function hasId(id) { assert.match(html, new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)); }

test('5. global pre-upload SHA-256 deduplication is wired into resumable uploads', () => {
  assert.match(js, /async function tryServerDedup\(it\)/);
  assert.match(js, /await sha256Blob\(it\.preparedBlob/);
  assert.match(js, /offset === 0 && !it\.preparedEncrypted/);
  assert.match(js, /\/dedupe/);
  assert.match(js, /if \(it\.contentHash\) qs \+= '&sha256='/);
  assert.match(server, /downloadRouter\.post\('\/u\/:token\/dedupe'/);
  assert.match(server, /const roots = \[INBOX_DIR, FULL_IMAGES_DIR\]/);
  assert.match(server, /COPYFILE_FICLONE/);
  assert.match(server, /clamavEnabled\(\) && !\(await scanGate\(outcome\.target, parsed\.filename, s, req\)\)/);
});

test('global dedupe requires a one-use proof of possession before cross-share materialization', () => {
  assert.match(server, /const dedupeChallenges = new Map\(\)/);
  assert.match(server, /makeDedupeRanges\(size, nonce\)/);
  assert.match(server, /verifyDedupeProof\(challenge, body\.proof\)/);
  assert.match(server, /dedupeChallenges\.delete\(challengeId\).*one attempt only/s);
  assert.match(server, /challenge\.ip !== clientIp\(req\)/);
  assert.match(js, /data\.challenge && Array\.isArray\(data\.ranges\)/);
  assert.match(js, /it\.preparedBlob\.slice\(off, off \+ len\)\.arrayBuffer\(\)/);
  assert.match(js, /payload\.challenge = data\.challenge; payload\.proof = proof/);
});

test('large-file hashing is incremental instead of requiring one giant array buffer', () => {
  assert.match(js, /function Sha256Incremental\(\)/);
  assert.match(js, /blob\.slice\(done,end\)\.arrayBuffer\(\)/);
  assert.match(js, /step = 4 \* 1024 \* 1024/);
  assert.match(js, /blob\.size <= 32 \* 1024 \* 1024/);
});

test('13. advanced photo editor exposes transforms, adjustments, resize and output controls', () => {
  for (const id of ['ann-rotate-left','ann-rotate-right','ann-flip-h','ann-flip-v','ann-brightness','ann-contrast','ann-saturation','ann-resize-max','ann-resize-apply','ann-output-format','ann-output-quality']) hasId(id);
  assert.match(js, /function rotateAnnotate\(dir\)/);
  assert.match(js, /function flipAnnotate\(horizontal\)/);
  assert.match(js, /function applyEditorAdjustments\(\)/);
  assert.match(js, /function resizeAnnotate\(\)/);
  assert.match(js, /ann-output-format/);
  assert.match(css, /\.editor-adjust-grid/);
});

test('14. privacy center inspects images, PDF and Office documents locally', () => {
  for (const id of ['privacy-overlay','privacy-findings','privacy-analyze','privacy-clean']) hasId(id);
  assert.match(js, /async function analyzePrivacyFile\(file,name,type\)/);
  assert.match(js, /privacyImageMetadata/);
  assert.match(js, /privacyPdfMetadata/);
  assert.match(js, /docProps\/core\.xml/);
  assert.match(js, /docProps\/custom\.xml/);
  assert.match(js, /docProps\\\/thumbnail/);
});

test('metadata-only image cleanup is lossless for JPEG, PNG and WebP pixels', () => {
  assert.match(js, /function stripJpegMetadataBytes\(bytes\)/);
  assert.match(js, /marker!==0xe1&&marker!==0xed&&marker!==0xfe/);
  assert.match(js, /function stripPngMetadataBytes\(bytes\)/);
  assert.match(js, /eXIf:1,tEXt:1,zTXt:1,iTXt:1,tIME:1/);
  assert.match(js, /function stripWebpMetadataBytes\(bytes\)/);
  assert.match(js, /type!=='EXIF'&&type!=='XMP '/);
  assert.match(js, /if \(!optimize && strip .*cleanImagePrivacy\(file\)/s);
});

test('PDF and OOXML cleaners remove document identity metadata before replacing queue source', () => {
  assert.match(js, /PDFDocument\.load/);
  assert.match(js, /doc\.setAuthor\(''\)/);
  assert.match(js, /doc\.catalog\.delete\(PDFLib\.PDFName\.of\('Metadata'\)\)/);
  assert.match(js, /zip\.remove\('docProps\/custom\.xml'\)/);
  assert.match(js, /lastModifiedBy/);
  assert.match(js, /await replaceItemSourceDurably\(privacyCurrentItem,cleaned\)/);
});

test('15. sensitive visual data detector combines faces, plate heuristics and local OCR text detection', () => {
  hasId('ann-detect-sensitive');
  assert.match(html, /value="faces-plates-text"/);
  assert.match(js, /async function detectAndBlurSensitiveText\(pushUndo\)/);
  assert.match(js, /looksSensitiveText\(text\)/);
  assert.match(js, /address\|adresse\|passport/);
  assert.match(js, /digits\.length>=9/);
  assert.match(js, /mode === 'faces-plates-text'.*detectAndBlurSensitiveText\(false\)/s);
});

test('16. OCR results are persisted in a dedicated local IndexedDB index', () => {
  assert.match(js, /DB_VERSION = 7/);
  assert.match(js, /OCR_INDEX_STORE = 'ocrIndex'/);
  assert.match(js, /createObjectStore\(OCR_INDEX_STORE, \{ keyPath: 'id' \}\)/);
  assert.match(js, /await saveOcrIndexRecord\(ocrCurrentItem, ocrText\)/);
  assert.match(js, /await idbPut\(OCR_INDEX_STORE, rec\)/);
  assert.match(js, /await loadOcrIndex\(\)/);
});

test('OCR index provides local full-text search, reopen, delete and clear actions', () => {
  for (const id of ['ocr-index-panel','ocr-index-search','ocr-index-clear','ocr-index-results','ocr-index-count']) hasId(id);
  assert.match(js, /function renderOcrIndex\(\)/);
  assert.match(js, /String\(r\.text \|\| ''\)\.toLocaleLowerCase\(\)\.includes\(q\)/);
  assert.match(js, /function openIndexedOcr\(rec\)/);
  assert.match(js, /idbDelete\(OCR_INDEX_STORE,rec\.id\)/);
  assert.match(js, /idbClear\(OCR_INDEX_STORE\)/);
  assert.match(css, /\.ocr-index-row/);
});

test('clearing Direct-Xfer local data also removes the private OCR index', () => {
  assert.match(js, /idbClear\(IMAGE_STORE\), idbClear\(OCR_INDEX_STORE\), purgeDirectXferCaches/);
  assert.match(js, /ocrIndexRecords = \[\]; renderOcrIndex\(\)/);
});

test('dedupe endpoint is covered by transfer rate limiting and geo\/IP access rules', () => {
  assert.match(server, /download\|enc\|upload\|dedupe/);
  assert.match(server, /list\|upload\|upload-status\|dedupe\|delete/);
});
