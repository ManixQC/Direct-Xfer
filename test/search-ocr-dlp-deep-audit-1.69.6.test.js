'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSearchService } = require('../lib/server/search-service');
const { createDlpService } = require('../lib/server/dlp-service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ocrDisabled() {
  return {
    detectTools:async () => ({ tesseract:false, pdftoppm:false, missingLanguages:[] }),
    beginBuild:() => {}, syncBuildStats:() => {},
    extractForIndex:async () => ({ text:'', ocr:false, source:null }),
    persistCacheSync:() => {}, loadCacheDeferred:async () => false,
    getConfig:() => ({ enabled:false, langs:'fra+eng' }),
    getStats:() => ({ enabled:false, available:false }),
  };
}

function searchDeps(tmp, overrides = {}) {
  const shareMap = overrides.shareMap || new Map();
  return {
    DATA_DIR:tmp, DATA_KEY:null, HOST_ROOT:tmp, INBOX_DIR:path.join(tmp, 'inbox'),
    encryptStore:(value) => value,
    deserializeStore:(value) => JSON.parse(value),
    getState:() => ({ shares:[], trash:[], history:[], audit:[], activityLog:[] }),
    getById:(id) => shareMap.get(id) || null,
    listShares:() => [], shareItems:() => [], hostToContainer:(v) => v,
    assertRealWithin:async () => {}, resolveWithin:(root, rel) => path.resolve(root, rel || ''),
    firstExistingPhotoFile:() => null, photoOriginalPaths:() => [], ownsShare:() => true,
    accountList:() => [], trashItems:() => [], normUsername:(v) => String(v || '').toLowerCase(),
    linkPrefix:() => '/s/', ocrService:ocrDisabled(), ...overrides,
  };
}

function makeStoredZip(name, data) {
  name = Buffer.from(String(name), 'utf8'); data = Buffer.from(data);
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30); data.copy(local, 30 + name.length);
  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
  cd.writeUInt32LE(0, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt32LE(0, 42); name.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, eocd]);
}

test('search boundary defaults are safe and useful when optional arguments are omitted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-search-safe-defaults-'));
  try {
    fs.mkdirSync(path.join(tmp, 'inbox'), { recursive:true });
    const share = { id:'s1', name:'Docs', type:'file', token:'tok', revoked:false, encrypted:false };
    const shareMap = new Map([[share.id, share]]);
    const docs = ['a.txt','b.txt'].map((file, i) => ({ id:'s1:'+i, shareId:'s1', shareName:'Docs', type:'file', token:'tok', file, kind:'text', ext:'txt', size:1, mtime:1, metaText:file, searchText:'hello world', semanticTerms:['hello'] }));
    fs.writeFileSync(path.join(tmp, 'search-index.json'), JSON.stringify({ version:3, builtAt:Date.now(), docs }));
    const svc = createSearchService(searchDeps(tmp, { shareMap }));
    svc.loadIndexSync();
    assert.equal(svc.query('hello', {}, undefined, { canAccess:() => true }).length, 2, 'undefined limit should use the service default instead of returning zero rows');
    assert.equal(svc.semanticQuery('hello', {}, undefined, { canAccess:() => true }).length, 2);
    assert.equal(svc.visibleDocs().length, 0, 'missing authorization callback must fail closed');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('restore invalidates stale search snippets immediately and preserves a rebuild requested during an active pass', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-search-restore-race-'));
  try {
    fs.mkdirSync(path.join(tmp, 'inbox'), { recursive:true });
    const oldPath = path.join(tmp, 'old.txt'), newPath = path.join(tmp, 'new.txt');
    fs.writeFileSync(oldPath, 'old private content'); fs.writeFileSync(newPath, 'new restored content');
    const share = { id:'same-id', name:'Docs', type:'file', token:'tok', revoked:false, encrypted:false };
    const shareMap = new Map([[share.id, share]]);
    let currentItem = { type:'file', name:'old.txt', hostPath:oldPath };
    let firstGateResolve;
    const firstGate = new Promise((resolve) => { firstGateResolve = resolve; });
    let firstAssertEnteredResolve;
    const firstAssertEntered = new Promise((resolve) => { firstAssertEnteredResolve = resolve; });
    let gateFirst = true;
    const svc = createSearchService(searchDeps(tmp, {
      shareMap,
      listShares:() => [share],
      shareItems:() => [currentItem],
      assertRealWithin:async () => {
        if (gateFirst) { gateFirst = false; firstAssertEnteredResolve(); await firstGate; }
      },
    }));
    fs.writeFileSync(path.join(tmp, 'search-index.json'), JSON.stringify({ version:3, builtAt:Date.now(), docs:[{ id:'same-id:stale', shareId:'same-id', shareName:'Docs', type:'file', token:'tok', file:'stale.txt', kind:'text', ext:'txt', size:1, mtime:1, metaText:'stale', searchText:'stale private snippet', semanticTerms:[] }] }));
    svc.loadIndexSync();
    assert.equal(svc.status().indexed, 1);

    const firstBuild = svc.buildIndex();
    await firstAssertEntered;
    currentItem = { type:'file', name:'new.txt', hostPath:newPath };
    svc.resetAfterRestore(1);
    assert.equal(svc.status().indexed, 0, 'pre-restore snippets must disappear synchronously');
    assert.equal(fs.existsSync(path.join(tmp, 'search-index.json')), false, 'durable stale cache must be invalidated too');

    await sleep(1100); // let the restore reindex timer fire while the old pass is still blocked
    firstGateResolve();
    await firstBuild;
    for (let i = 0; i < 30 && svc.getIndex().docs.length === 0; i++) await sleep(100);
    assert.equal(svc.getIndex().docs.length, 1, 'a follow-up pass should run after the invalidated active build');
    assert.equal(svc.getIndex().docs[0].file, 'new.txt');
    assert.match(svc.getIndex().docs[0].searchText, /new restored content/);
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('strict ZIP completeness marks opaque binary entries as unscanned for DLP', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-search-zip-complete-'));
  try {
    fs.mkdirSync(path.join(tmp, 'inbox'), { recursive:true });
    const zip = path.join(tmp, 'opaque.zip');
    fs.writeFileSync(zip, makeStoredZip('scan.bin', Buffer.from([0,0,1,2,3,4,5])));
    const svc = createSearchService(searchDeps(tmp));
    const ordinary = await svc.extractZipTextContent(zip, { withMeta:true, maxEntries:10 });
    const strict = await svc.extractZipTextContent(zip, { withMeta:true, maxEntries:10, strictCompleteness:true });
    assert.equal(ordinary.incompleteEntries, 0);
    assert.ok(strict.incompleteEntries >= 1, 'DLP strict mode must not report an opaque binary entry as fully scanned');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});

test('DLP keeps ZIP entry-name evidence instead of overwriting it with a second content-only extraction', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-dlp-zip-name-'));
  try {
    const full = path.join(tmp, 'full'), quarantine = path.join(tmp, 'quarantine');
    fs.mkdirSync(full, { recursive:true }); fs.mkdirSync(quarantine, { recursive:true });
    const zip = path.join(tmp, 'archive.zip'); fs.writeFileSync(zip, 'not parsed by mocked search boundary');
    let strictSeen = false;
    const searchService = {
      getConstants:() => ({ CONTENT_CAP:2 * 1024 * 1024 }),
      extractUniversalSearchContent:async () => ({ kind:'archive', text:'exports/AKIAABCDEFGHIJKLMNOP.txt' }),
      extractZipTextContent:async (_abs, options) => { strictSeen = !!options.strictCompleteness; return { text:'benign body', incompleteEntries:0, truncated:false }; },
    };
    const svc = createDlpService({
      HOST_ROOT:tmp, FULL_IMAGES_DIR:full, DLP_QUARANTINE_DIR:quarantine,
      getState:() => ({ meta:{} }), getSettings:() => ({ dlpEnabled:true, dlpScanOcr:false, dlpMode:'warn', dlpMaxFileMB:25 }),
      hostToContainer:(v) => v, assertRealWithin:async () => {}, persistNow:() => true,
      clientIp:() => '127.0.0.1', maskIp:(v) => v, searchService,
      ocrService:{ getConfig:() => ({ imageExts:new Set() }), detectTools:async () => ({ tesseract:false,pdftoppm:false }), tesseractFileText:async () => '', ocrScannedPdf:async () => '' },
    });
    const scan = await svc.dlpScanStoredFile(zip, 'archive.zip');
    assert.equal(strictSeen, true);
    assert.ok(scan.types.includes('aws-access-key'), 'sensitive ZIP entry names must remain part of the DLP scan');
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});
