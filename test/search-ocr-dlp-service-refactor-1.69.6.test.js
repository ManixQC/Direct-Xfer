'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const { createSearchService } = require('../lib/server/search-service');
const { createOcrService } = require('../lib/server/ocr-service');
const { createDlpService } = require('../lib/server/dlp-service');

function minimalSearchDeps(tmp, overrides = {}) {
  const shares = overrides.shares || new Map();
  return {
    DATA_DIR:tmp,
    DATA_KEY:null,
    HOST_ROOT:tmp,
    INBOX_DIR:path.join(tmp, 'inbox'),
    encryptStore:(value) => value,
    deserializeStore:(value) => JSON.parse(value),
    getState:() => ({ shares:[], trash:[], history:[], audit:[], activityLog:[] }),
    getById:(id) => shares.get(id) || null,
    listShares:() => [],
    shareItems:() => [],
    hostToContainer:(value) => value,
    assertRealWithin:async () => {},
    resolveWithin:(root, rel) => path.resolve(root, rel || ''),
    firstExistingPhotoFile:() => null,
    photoOriginalPaths:() => [],
    ownsShare:() => true,
    accountList:() => [],
    trashItems:() => [],
    normUsername:(v) => String(v || '').trim().toLowerCase(),
    linkPrefix:() => '/s/',
    ocrService:overrides.ocrService || {
      detectTools:async () => ({ tesseract:false, pdftoppm:false, missingLanguages:[] }),
      beginBuild:() => {}, syncBuildStats:() => {},
      extractForIndex:async () => ({ text:'', ocr:false, source:null }),
      persistCacheSync:() => {},
      loadCacheDeferred:async () => false,
      getConfig:() => ({ enabled:false, langs:'fra+eng' }),
      getStats:() => ({ enabled:false, available:false }),
    },
    ...overrides,
  };
}

test('search, OCR and DLP concerns are extracted from server.js into explicit service boundaries', () => {
  const server = read('server.js');
  const search = read('lib/server/search-service.js');
  const ocr = read('lib/server/ocr-service.js');
  const dlp = read('lib/server/dlp-service.js');

  assert.match(server, /require\('\.\/lib\/server\/search-service'\)/);
  assert.match(server, /require\('\.\/lib\/server\/ocr-service'\)/);
  assert.match(server, /require\('\.\/lib\/server\/dlp-service'\)/);
  assert.match(server, /createSearchService\(\{/);
  assert.match(server, /createOcrService\(\{/);
  assert.match(server, /createDlpService\(\{/);

  assert.doesNotMatch(server, /function extractPdfSearchText\(/);
  assert.doesNotMatch(server, /function extractZipTextContent\(/);
  assert.doesNotMatch(server, /function runSearchOcrCommand\(/);
  assert.doesNotMatch(server, /function resolveSearchOcrTesseractBinary\(/);
  assert.doesNotMatch(server, /function dlpScanOneFile\(/);
  assert.doesNotMatch(server, /function recordDlpQuarantine\(/);

  assert.match(search, /async function extractPdfSearchText\(/);
  assert.match(search, /async function extractZipTextContent\(/);
  assert.match(search, /function semanticQuery\(/);
  assert.match(search, /\(s\.type === 'inbox' \|\| s\.type === 'collab'\) && !s\.webStorage/);
  assert.match(ocr, /function resolveTesseractBinary\(/);
  assert.match(ocr, /async function detectTools\(/);
  assert.match(ocr, /async function loadCacheDeferred\(/);
  assert.match(dlp, /async function dlpScanResolvedItems\(/);
  assert.match(dlp, /function dlpDecision\(/);
  assert.match(dlp, /function recordDlpQuarantine\(/);
});

test('search service hydrates its own index and preserves lexical visibility filtering', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-search-service-'));
  try {
    fs.mkdirSync(path.join(tmp, 'inbox'), { recursive:true });
    const share = { id:'s1', name:'Docs', type:'file', token:'abc', revoked:false, encrypted:false };
    const shares = new Map([[share.id, share]]);
    const doc = {
      id:'s1:one', shareId:'s1', shareName:'Docs', type:'file', token:'abc', file:'notes.txt',
      kind:'text', ext:'txt', size:20, mtime:1, ocr:false,
      metaText:'docs notes txt', searchText:'bonjour electricite facture client', semanticTerms:[],
    };
    fs.writeFileSync(path.join(tmp, 'search-index.json'), JSON.stringify({ version:3, builtAt:Date.now(), docs:[doc] }));
    const svc = createSearchService(minimalSearchDeps(tmp, { shares }));
    svc.loadIndexSync();

    assert.equal(svc.status().indexed, 1);
    assert.equal(svc.query('facture', {}, 10, { canAccess:() => true }).length, 1);
    assert.equal(svc.query('facture', {}, 10, { canAccess:() => false }).length, 0);
    assert.equal(svc.looksLikeTextBuffer(Buffer.from('plain UTF-8 text\n')), true);
    assert.equal(svc.looksLikeTextBuffer(Buffer.from([0, 0, 1, 2, 3, 4])), false);
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});

test('OCR service owns tool availability state without invoking native tools when OCR is disabled', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-ocr-service-'));
  const before = process.env.SEARCH_OCR_ENABLED;
  process.env.SEARCH_OCR_ENABLED = 'false';
  try {
    const svc = createOcrService({
      DATA_DIR:tmp,
      DATA_KEY:null,
      encryptStore:(value) => value,
      deserializeStore:(value) => JSON.parse(value),
    });
    assert.equal(svc.getConfig().enabled, false);
    const tools = await svc.detectTools();
    assert.deepEqual(tools, { tesseract:false, tesseractBinary:false, languages:[], missingLanguages:[], pdftotext:false, pdftoppm:false });
    assert.equal(svc.getStats().available, false);
  } finally {
    if (before == null) delete process.env.SEARCH_OCR_ENABLED; else process.env.SEARCH_OCR_ENABLED = before;
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});

test('DLP service scans through the search boundary, redacts findings and physically quarantines managed uploads', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-dlp-service-'));
  try {
    const full = path.join(tmp, 'full');
    const quarantine = path.join(tmp, 'quarantine');
    fs.mkdirSync(full, { recursive:true });
    fs.mkdirSync(quarantine, { recursive:true });
    const state = { meta:{} };
    const settings = { dlpEnabled:true, dlpScanOcr:false, dlpMode:'quarantine', dlpMaxFiles:10, dlpMaxFileMB:25 };
    const searchService = {
      getConstants:() => ({ CONTENT_CAP:2 * 1024 * 1024 }),
      extractUniversalSearchContent:async (abs) => ({ kind:'text', text:await fs.promises.readFile(abs, 'utf8') }),
      extractZipTextContent:async () => ({ text:'', incompleteEntries:0, truncated:false }),
    };
    const ocrService = {
      getConfig:() => ({ imageExts:new Set(['jpg','jpeg','png','webp','bmp','tif','tiff']) }),
      detectTools:async () => ({ tesseract:false, pdftoppm:false }),
      tesseractFileText:async () => '', ocrScannedPdf:async () => '',
    };
    const svc = createDlpService({
      HOST_ROOT:tmp, FULL_IMAGES_DIR:full, DLP_QUARANTINE_DIR:quarantine,
      getState:() => state, getSettings:() => settings,
      hostToContainer:(value) => value,
      assertRealWithin:async () => {},
      persistNow:() => true,
      clientIp:() => '127.0.0.1', maskIp:(ip) => ip,
      searchService, ocrService,
    });

    const managed = path.join(full, 'card.txt');
    fs.writeFileSync(managed, 'Customer card: 4111 1111 1111 1111');
    const scan = await svc.dlpScanStoredFile(managed, 'card.txt');
    assert.ok(scan.count >= 1);
    assert.ok(scan.types.includes('payment-card'));
    assert.ok(scan.findings.every((f) => !String(f.sample || '').includes('4111111111111111')));

    const rec = svc.recordDlpQuarantine({ session:{ username:'admin' } }, scan, 'image-upload', managed, 'card.txt');
    assert.equal(fs.existsSync(managed), false);
    assert.ok(rec.file);
    assert.equal(fs.existsSync(path.join(quarantine, rec.file)), true);
    assert.equal(state.meta.dlpQuarantine.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
});
