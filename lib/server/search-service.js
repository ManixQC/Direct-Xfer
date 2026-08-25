'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { readZipEntries, readFileCapped } = require('../file-content-utils');
const { openFd, closeFd, statFd, readFd } = require('../fd-utils');
const { SEMANTIC_GROUPS, normalizeSearchText, searchTokens, semanticTerms } = require('../search-utils');

/**
 * Universal search boundary for Direct-Xfer.
 *
 * Owns content extraction, persistent index hydration/rebuild, lexical/semantic
 * postings and metadata search. OCR is delegated to ocr-service and DLP consumes
 * only the bounded extraction surface exported here.
 */
function createSearchService(deps = {}) {
  const {
    DATA_DIR,
    DATA_KEY,
    ASVS_L3_MODE = false,
    HOST_ROOT,
    INBOX_DIR,
    encryptStore,
    deserializeStore,
    getState,
    getById,
    listShares,
    shareItems,
    hostToContainer,
    assertRealWithin,
    resolveWithin,
    firstExistingPhotoFile,
    photoOriginalPaths,
    ownsShare,
    accountList,
    trashItems,
    normUsername,
    linkPrefix,
    noteCenterServiceState = () => {},
    addAdminCenterNotification = () => {},
    emitLiveActivity = () => {},
    ocrService,
    onStateChange = () => {},
  } = deps;

  for (const [name, value] of Object.entries({ DATA_DIR, HOST_ROOT, INBOX_DIR, encryptStore, deserializeStore, getState, getById, listShares, shareItems, hostToContainer, assertRealWithin, resolveWithin, firstExistingPhotoFile, photoOriginalPaths, ocrService })) {
    if (value == null) throw new TypeError(`createSearchService requires ${name}`);
  }

  const persistenceEncrypted = ASVS_L3_MODE === true || !!DATA_KEY;
  const INDEX_FILE = path.join(DATA_DIR, 'search-index.json');
  const INDEX_VERSION = 3;
  const CONTENT_CAP = 2 * 1024 * 1024;
  const STORED_TEXT_CAP = 512 * 1024;
  const DOC_MAX = Math.max(1000, Number.parseInt(process.env.SEARCH_INDEX_MAX_DOCS || '250000', 10) || 250000);
  const TEXT_EXTS = new Set([
    'txt','md','markdown','log','csv','tsv','json','xml','yml','yaml','ini','conf','cfg','toml',
    'js','mjs','cjs','ts','tsx','jsx','css','scss','less','html','htm','py','sh','bash','zsh',
    'c','h','cpp','hpp','cc','cxx','java','go','rs','rb','php','sql','lua','pl','kt','swift','r','dart',
    'env','pem','key','properties','tf','tfvars','service','desktop',
  ]);
  const TEXT_BASENAMES = new Set(['dockerfile','makefile','gemfile','procfile','rakefile','vagrantfile','jenkinsfile']);

  let index = { version:INDEX_VERSION, builtAt:0, docs:[] };
  let docsById = new Map();
  let postings = new Map();
  let semanticPostings = new Map();
  let building = false;
  let epoch = 0;
  let generation = 0;
  let error = null;
  let timer = null;
  let rebuildPromise = null;
  let reindexPending = false;
  let reindexInterval = null;

  function publishState() {
    try { onStateChange({ building, error, index, epoch, generation }); } catch (_) {}
  }

  function isSearchableText(name) {
    const raw = String(name || '');
    const base = path.basename(raw).toLowerCase();
    if (TEXT_BASENAMES.has(base) || base === '.env' || base.startsWith('.env.')) return true;
    return TEXT_EXTS.has((raw.split('.').pop() || '').toLowerCase());
  }

  function looksLikeTextBuffer(buf) {
    if (!buf || !buf.length) return true;
    const n = Math.min(buf.length, 64 * 1024);
    let controls = 0, nul = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[i];
      if (b === 0) { nul++; if (nul > 1) return false; }
      if (b < 9 || (b > 13 && b < 32)) controls++;
    }
    return controls / n < 0.02;
  }

  function rebuildPostings() {
    docsById = new Map(); postings = new Map(); semanticPostings = new Map();
    for (const doc of index.docs || []) {
      if (!doc || !doc.id) continue;
      docsById.set(doc.id, doc);
      const toks = searchTokens((doc.metaText || '') + ' ' + (doc.searchText || ''));
      for (const tok of toks) {
        let set = postings.get(tok); if (!set) postings.set(tok, set = new Set()); set.add(doc.id);
      }
      const sem = Array.isArray(doc.semanticTerms) ? doc.semanticTerms : semanticTerms((doc.metaText || '') + ' ' + (doc.searchText || ''));
      for (const tok of sem) {
        let set = semanticPostings.get(tok); if (!set) semanticPostings.set(tok, set = new Set()); set.add(doc.id);
      }
    }
  }

  async function buildPostingsDeferred(nextIndex) {
    const nextDocs = new Map(), nextPostings = new Map(), nextSemantic = new Map();
    const docs = (nextIndex && nextIndex.docs) || [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (doc && doc.id) {
        nextDocs.set(doc.id, doc);
        for (const tok of searchTokens((doc.metaText || '') + ' ' + (doc.searchText || ''))) {
          let set = nextPostings.get(tok); if (!set) nextPostings.set(tok, set = new Set()); set.add(doc.id);
        }
        const sem = Array.isArray(doc.semanticTerms) ? doc.semanticTerms : semanticTerms((doc.metaText || '') + ' ' + (doc.searchText || ''));
        for (const tok of sem) {
          let set = nextSemantic.get(tok); if (!set) nextSemantic.set(tok, set = new Set()); set.add(doc.id);
        }
      }
      if ((i & 127) === 127) await new Promise((resolve) => setImmediate(resolve));
    }
    return { docsById:nextDocs, postings:nextPostings, semanticPostings:nextSemantic };
  }

  function deserializeIndexCache(raw) {
    if (ASVS_L3_MODE === true) {
      let envelope;
      try { envelope = JSON.parse(String(raw || '')); } catch (_) { envelope = null; }
      if (!envelope || envelope.dxenc !== 2) {
        const error = new Error('asvs-l3-plaintext-search-cache-rejected');
        error.code = 'ASVS_L3_PLAINTEXT_CACHE_REJECTED';
        throw error;
      }
    }
    return deserializeStore(raw);
  }

  function loadIndexSync() {
    try {
      const parsed = deserializeIndexCache(fs.readFileSync(INDEX_FILE, 'utf8'));
      if (parsed && parsed.version === INDEX_VERSION && Array.isArray(parsed.docs)) index = parsed;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') console.warn('[search-index] cached index could not be loaded; it will be rebuilt:', String((e && e.message) || e));
      if (e && e.code === 'ASVS_L3_PLAINTEXT_CACHE_REJECTED') try { fs.unlinkSync(INDEX_FILE); } catch (_) {}
    }
    rebuildPostings(); publishState();
  }

  async function loadIndexDeferred(expectedGeneration, expectedEpoch) {
    try {
      const parsed = deserializeIndexCache(await fs.promises.readFile(INDEX_FILE, 'utf8'));
      if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.docs)) return false;
      const built = await buildPostingsDeferred(parsed);
      if (!isHydrationCurrent(expectedGeneration, expectedEpoch)) return false;
      index = parsed; docsById = built.docsById; postings = built.postings; semanticPostings = built.semanticPostings;
      publishState();
      return true;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') console.warn('[search-index] cached index could not be loaded; it will be rebuilt:', String((e && e.message) || e));
      if (e && e.code === 'ASVS_L3_PLAINTEXT_CACHE_REJECTED') try { await fs.promises.unlink(INDEX_FILE); } catch (_) {}
      return false;
    }
  }

  function persistIndexSync(nextIndex) {
    const tmp = INDEX_FILE + '.tmp-' + process.pid;
    const json = JSON.stringify(nextIndex);
    fs.writeFileSync(tmp, persistenceEncrypted ? encryptStore(json) : json, { mode:0o600 });
    fs.renameSync(tmp, INDEX_FILE);
  }

  function decodeXmlSearchEntities(text) {
    const entities = { lt:'<', gt:'>', amp:'&', quot:'"', '#39':"'" };
    return String(text || '').replace(/&(lt|gt|amp|quot|#39);/gi, (match, name) => entities[String(name).toLowerCase()] || match);
  }

  function xmlToSearchText(xml) {
    const withoutMarkup = String(xml || '').replace(/<w:tab\/?[^>]*>/gi, ' ')
      .replace(/<a:br\/?[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
    return decodeXmlSearchEntities(withoutMarkup).replace(/\s+/g, ' ').trim();
  }

  function decodePdfLiteral(src) {
    return String(src || '').replace(/\\([nrtbf()\\])/g, (_, c) => ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', '(':'(', ')':')', '\\':'\\' }[c] || c))
      .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\\r?\n/g, '');
  }

  function extractPdfStrings(text, out) {
    let m;
    const tj = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
    while ((m = tj.exec(text)) && out.length < 20000) out.push(decodePdfLiteral(m[1]));
    const tjArr = /\[((?:.|\n|\r)*?)\]\s*TJ/g;
    while ((m = tjArr.exec(text)) && out.length < 20000) {
      const inner = m[1], re = /\(((?:\\.|[^\\)])*)\)/g; let p;
      while ((p = re.exec(inner)) && out.length < 20000) out.push(decodePdfLiteral(p[1]));
    }
    const hex = /<([0-9a-fA-F]{4,})>\s*Tj/g;
    while ((m = hex.exec(text)) && out.length < 20000) {
      try { out.push(Buffer.from(m[1], 'hex').toString('utf8')); } catch (_) {}
    }
  }

  async function extractPdfSearchText(abs) {
    let buf;
    try { buf = (await readFileCapped(abs, 8 * 1024 * 1024)).buf; } catch (_) { return ''; }
    const out = [], raw = buf.toString('latin1');
    extractPdfStrings(raw, out);
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g; let m, inflatedTotal = 0;
    while ((m = re.exec(raw)) && out.length < 20000 && inflatedTotal < 16 * 1024 * 1024) {
      const pre = raw.slice(Math.max(0, m.index - 300), m.index);
      if (!/FlateDecode/.test(pre)) continue;
      try {
        const comp = Buffer.from(m[1], 'latin1'); if (comp.length > 4 * 1024 * 1024) continue;
        const dec = zlib.inflateSync(comp, { maxOutputLength:4 * 1024 * 1024 });
        inflatedTotal += dec.length; extractPdfStrings(dec.toString('latin1'), out);
      } catch (_) {}
    }
    return out.join(' ').replace(/\s+/g, ' ').slice(0, CONTENT_CAP);
  }

  async function extractSelectedZipText(abs, wanted) {
    let fd = null;
    try {
      fd = await openFd(abs, 'r'); const st = await statFd(fd);
      if (st.size < 22 || st.size > 512 * 1024 * 1024) return '';
      const tailLen = Math.min(st.size, 65557), tail = Buffer.alloc(tailLen);
      await readFd(fd, tail, 0, tailLen, st.size - tailLen);
      let eocd = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) return '';
      const cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
      if (cdOffset === 0xffffffff || cdSize > 16 * 1024 * 1024) return '';
      const cd = Buffer.alloc(Math.min(cdSize, st.size - cdOffset)); await readFd(fd, cd, 0, cd.length, cdOffset);
      let p = 0, total = 0; const chunks = [];
      while (p + 46 <= cd.length && total < 8 * 1024 * 1024) {
        if (cd.readUInt32LE(p) !== 0x02014b50) break;
        const method = cd.readUInt16LE(p + 10), compSize = cd.readUInt32LE(p + 20), uncomp = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32), localOff = cd.readUInt32LE(p + 42);
        const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
        if (wanted(name) && compSize <= 4 * 1024 * 1024 && uncomp <= 8 * 1024 * 1024 && localOff !== 0xffffffff) {
          const lh = Buffer.alloc(30); await readFd(fd, lh, 0, 30, localOff);
          if (lh.readUInt32LE(0) === 0x04034b50) {
            const ln = lh.readUInt16LE(26), le = lh.readUInt16LE(28), data = Buffer.alloc(compSize);
            await readFd(fd, data, 0, compSize, localOff + 30 + ln + le);
            let dec = null;
            if (method === 0) dec = data; else if (method === 8) { try { dec = zlib.inflateRawSync(data, { maxOutputLength:8 * 1024 * 1024 }); } catch (_) {} }
            if (dec) { total += dec.length; chunks.push(xmlToSearchText(dec.toString('utf8'))); }
          }
        }
        p += 46 + nameLen + extraLen + commentLen;
      }
      return chunks.join(' ').slice(0, CONTENT_CAP);
    } catch (_) { return ''; }
    finally { if (fd !== null) try { await closeFd(fd); } catch (_) {} }
  }

  async function extractZipTextContent(abs, options = {}) {
    const maxEntries = Math.max(1, Math.min(500, Number(options.maxEntries) || 100));
    const maxEntryBytes = Math.max(4096, Math.min(4 * 1024 * 1024, Number(options.maxEntryBytes) || (1024 * 1024)));
    const maxTotalBytes = Math.max(16384, Math.min(CONTENT_CAP, Number(options.maxTotalBytes) || CONTENT_CAP));
    const withMeta = !!options.withMeta;
    const strictCompleteness = !!options.strictCompleteness;
    const result = (text, extra) => withMeta ? { text:String(text || ''), truncated:!!(extra && extra.truncated), incompleteEntries:Number(extra && extra.incompleteEntries) || 0, totalEntries:Number(extra && extra.totalEntries) || 0, entriesVisited:Number(extra && extra.entriesVisited) || 0 } : String(text || '');
    let fd = null;
    try {
      fd = await openFd(abs, 'r'); const st = await statFd(fd);
      if (st.size < 22 || st.size > 512 * 1024 * 1024) return result('', { truncated:true, incompleteEntries:1 });
      const tailLen = Math.min(st.size, 65557), tail = Buffer.alloc(tailLen);
      await readFd(fd, tail, 0, tailLen, st.size - tailLen);
      let eocd = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      if (eocd < 0) return result('', { truncated:true, incompleteEntries:1 });
      const diskNo = tail.readUInt16LE(eocd + 4), cdDisk = tail.readUInt16LE(eocd + 6), totalEntries = tail.readUInt16LE(eocd + 10);
      const cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
      if (diskNo !== 0 || cdDisk !== 0 || totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize > 16 * 1024 * 1024) return result('', { truncated:true, incompleteEntries:1, totalEntries });
      const cd = Buffer.alloc(Math.min(cdSize, Math.max(0, st.size - cdOffset))); await readFd(fd, cd, 0, cd.length, cdOffset);
      let p = 0, visited = 0, total = 0, incompleteEntries = 0, truncated = false; const chunks = [];
      while (p + 46 <= cd.length && visited < maxEntries && total < maxTotalBytes) {
        if (cd.readUInt32LE(p) !== 0x02014b50) { truncated = true; incompleteEntries++; break; }
        const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), compSize = cd.readUInt32LE(p + 20), uncomp = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32), localOff = cd.readUInt32LE(p + 42);
        if (p + 46 + nameLen + extraLen + commentLen > cd.length) { truncated = true; incompleteEntries++; break; }
        const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
        const isDir = name.endsWith('/'), textNamed = !isDir && isSearchableText(name);
        if (!isDir) {
          const mustAccount = textNamed || strictCompleteness;
          if ((flags & 1) && mustAccount) incompleteEntries++;
          else if ((method !== 0 && method !== 8) && mustAccount) incompleteEntries++;
          else if ((compSize > maxEntryBytes || uncomp > maxEntryBytes || localOff === 0xffffffff) && mustAccount) incompleteEntries++;
          else if (!(flags & 1) && compSize <= maxEntryBytes && uncomp <= maxEntryBytes && localOff !== 0xffffffff && (method === 0 || method === 8)) {
            try {
              const lh = Buffer.alloc(30); await readFd(fd, lh, 0, 30, localOff);
              if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip-local-header');
              const ln = lh.readUInt16LE(26), le = lh.readUInt16LE(28), data = Buffer.alloc(compSize);
              await readFd(fd, data, 0, compSize, localOff + 30 + ln + le);
              let dec = null; if (method === 0) dec = data; else { try { dec = zlib.inflateRawSync(data, { maxOutputLength:maxEntryBytes }); } catch (_) {} }
              if (!dec && mustAccount) incompleteEntries++;
              if (dec && looksLikeTextBuffer(dec)) {
                const room = Math.max(0, maxTotalBytes - total), piece = dec.subarray(0, room);
                chunks.push('[' + String(name).slice(0, 512) + ']\n' + piece.toString('utf8').replace(/\u0000/g, ' '));
                total += piece.length;
                if (piece.length < dec.length) { truncated = true; incompleteEntries++; }
              } else if (dec && strictCompleteness) {
                // DLP cannot claim a complete archive scan for opaque binary,
                // nested archive, PDF/image, encrypted or unsupported content that
                // this lightweight extractor did not inspect semantically/OCR.
                incompleteEntries++;
              }
            } catch (_) { if (mustAccount) incompleteEntries++; }
          }
        }
        visited++; p += 46 + nameLen + extraLen + commentLen;
      }
      if (visited < totalEntries) { truncated = true; incompleteEntries += Math.max(1, totalEntries - visited); }
      return result(chunks.join('\n').slice(0, maxTotalBytes), { truncated, incompleteEntries, totalEntries, entriesVisited:visited });
    } catch (_) { return result('', { truncated:true, incompleteEntries:1 }); }
    finally { if (fd !== null) try { await closeFd(fd); } catch (_) {} }
  }

  async function extractUniversalSearchContent(abs, name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    if (isSearchableText(name)) {
      try { return { kind:'text', text:(await readFileCapped(abs, CONTENT_CAP)).buf.toString('utf8') }; } catch (_) { return { kind:'text', text:'' }; }
    }
    if (ext === 'pdf') return { kind:'pdf', text:await extractPdfSearchText(abs) };
    if (['docx','docm'].includes(ext)) return { kind:'office', text:await extractSelectedZipText(abs, (n) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(n) || /^docProps\/(core|custom|app)\.xml$/i.test(n)) };
    if (['xlsx','xlsm'].includes(ext)) return { kind:'office', text:await extractSelectedZipText(abs, (n) => /^xl\/(sharedStrings|workbook)\.xml$/i.test(n) || /^xl\/worksheets\/sheet\d+\.xml$/i.test(n) || /^docProps\/(core|custom|app)\.xml$/i.test(n)) };
    if (['pptx','pptm'].includes(ext)) return { kind:'office', text:await extractSelectedZipText(abs, (n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(n) || /^docProps\/(core|custom|app)\.xml$/i.test(n)) };
    if (ext === 'zip') {
      const z = await readZipEntries(abs, 5000), names = z ? z.entries.map((e) => e.name).join('\n') : '';
      const innerText = await extractZipTextContent(abs, { maxEntries:100, maxTotalBytes:CONTENT_CAP });
      return { kind:'archive', text:[names, innerText].filter(Boolean).join('\n').slice(0, CONTENT_CAP) };
    }
    if (['jpg','jpeg','png','webp','bmp','tif','tiff','avif','gif','heic','heif'].includes(ext)) return { kind:'image', text:'' };
    try {
      const sample = await readFileCapped(abs, CONTENT_CAP);
      if (looksLikeTextBuffer(sample.buf)) return { kind:'text', text:sample.buf.toString('utf8') };
    } catch (_) {}
    return { kind:'metadata', text:'' };
  }

  async function walkUniversalFiles(absDir, relBase, onFile, budget) {
    if (budget.count >= DOC_MAX) return;
    let ents = []; try { ents = await fs.promises.readdir(absDir, { withFileTypes:true }); } catch (_) { return; }
    for (const e of ents) {
      if (budget.count >= DOC_MAX) return;
      if (e.name === '.dxparts' || e.name === '.pending' || e.name.startsWith('.dx')) continue;
      const abs = path.join(absDir, e.name), rel = relBase ? relBase + '/' + e.name : e.name;
      if (e.isDirectory()) await walkUniversalFiles(abs, rel, onFile, budget);
      else if (e.isFile()) { budget.count += 1; await onFile(abs, rel); }
    }
  }

  async function buildIndex() {
    if (building) return rebuildPromise;
    building = true; error = null; generation += 1; const buildEpoch = epoch; publishState();
    rebuildPromise = (async () => {
      const docs = [], budget = { count:0 };
      const ocrCtx = { processed:0, cached:0, errors:0, deferred:0, eligible:0, current:'', usedCacheKeys:new Set() };
      const tools = await ocrService.detectTools();
      ocrService.beginBuild(tools);
      try { noteCenterServiceState('ocr-index', !ocrService.getConfig().enabled || !!tools.tesseract, (!ocrService.getConfig().enabled || tools.tesseract) ? 'Index OCR rétabli' : 'Index OCR indisponible (Tesseract/langues manquants)'); } catch (_) {}
      const add = async (s, abs, rel) => {
        if (docs.length >= DOC_MAX) return;
        let st; try { st = await fs.promises.stat(abs); if (!st.isFile()) return; } catch (_) { return; }
        const extracted = await extractUniversalSearchContent(abs, rel);
        const ocr = await ocrService.extractForIndex(abs, rel, st, ocrCtx, extracted.text);
        ocrService.syncBuildStats(ocrCtx, tools);
        const combinedText = [extracted.text, ocr.text].filter(Boolean).join(' ').slice(0, CONTENT_CAP);
        const ext = (String(rel).split('.').pop() || '').toLowerCase();
        const metaText = [s.name, s.type, s.type === 'photo' ? 'images image photo' : '', rel, ext, st.size, Array.isArray(s.tags) ? s.tags.join(' ') : '', s.adminNote || '', s.descriptionMd || '', new Date(st.mtimeMs).toISOString()].filter(Boolean).join(' ');
        docs.push({
          id:String(s.id) + ':' + crypto.createHash('sha1').update(rel).digest('hex').slice(0,16), shareId:s.id, shareName:s.name || '', type:s.type, token:s.token || '', file:rel,
          kind:extracted.kind, ext, size:st.size, mtime:st.mtimeMs, ocr:!!ocr.ocr, ocrSource:ocr.source || null,
          metaText:normalizeSearchText(metaText).slice(0,4096), searchText:normalizeSearchText(combinedText).slice(0,STORED_TEXT_CAP), semanticTerms:semanticTerms(metaText + ' ' + combinedText).slice(0,2048),
        });
      };
      for (const s of listShares()) {
        if (!s || s.revoked || s.type === 'secret' || s.encrypted || docs.length >= DOC_MAX) continue;
        try {
          if (s.type === 'file') {
            for (const it of shareItems(s)) {
              if (docs.length >= DOC_MAX) break;
              let abs; try { abs = hostToContainer(it.hostPath); await assertRealWithin(HOST_ROOT, abs); } catch (_) { continue; }
              if ((it.type || 'file') === 'folder') await walkUniversalFiles(abs, it.name, (a,r) => add(s,a,r), budget); else { budget.count += 1; await add(s, abs, it.name); }
            }
          } else if (s.type === 'folder') {
            let abs; try { abs = hostToContainer(s.hostPath); await assertRealWithin(HOST_ROOT, abs); } catch (_) { continue; }
            await walkUniversalFiles(abs, '', (a,r) => add(s,a,r), budget);
          } else if ((s.type === 'inbox' || s.type === 'collab') && !s.webStorage) {
            let root; try { root = resolveWithin(INBOX_DIR, s.relDir || ''); await assertRealWithin(INBOX_DIR, root); } catch (_) { continue; }
            await walkUniversalFiles(root, '', (a,r) => add(s,a,r), budget);
          } else if (s.type === 'photo') {
            let abs = firstExistingPhotoFile(photoOriginalPaths(s));
            if (!abs && s.hostPath) {
              try { const hostAbs = hostToContainer(s.hostPath); await assertRealWithin(HOST_ROOT, hostAbs); if ((await fs.promises.stat(hostAbs)).isFile()) abs = hostAbs; } catch (_) { abs = null; }
            }
            if (abs) { budget.count += 1; await add(s, abs, s.name || path.basename(abs)); }
          }
        } catch (_) {}
      }
      const cfg = ocrService.getConfig();
      const next = { version:INDEX_VERSION, builtAt:Date.now(), docs, truncated:docs.length >= DOC_MAX,
        ocr:{ enabled:cfg.enabled, available:!!tools.tesseract, processed:ocrCtx.processed, cached:ocrCtx.cached, errors:ocrCtx.errors, deferred:ocrCtx.deferred, eligible:ocrCtx.eligible, langs:cfg.langs, missingLanguages:tools.missingLanguages || [], pdfAvailable:!!(tools.tesseract && tools.pdftoppm) } };
      if (buildEpoch !== epoch) return index;
      ocrService.persistCacheSync(ocrCtx.usedCacheKeys);
      persistIndexSync(next); index = next; rebuildPostings(); ocrService.syncBuildStats(ocrCtx, tools); publishState();
      return next;
    })().catch((e) => {
      error = String((e && e.message) || e); publishState();
      console.error('[search-index] rebuild failed:', error);
      addAdminCenterNotification('index-failed', { detail:error.slice(0,400), source:'universal-search', dedupeKey:`index-failed:${error.slice(0,120)}`, dedupeWindowMs:6*3600*1000 });
      emitLiveActivity('system', { name:'index-failed', status:'error', detail:error.slice(0,300) });
      throw e;
    }).finally(() => {
      building = false; rebuildPromise = null; publishState();
      if (reindexPending) {
        reindexPending = false;
        scheduleReindex(1000);
      }
    });
    return rebuildPromise;
  }

  function scheduleReindex(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // A long OCR/index pass may still be running when an upload/share mutation
      // asks for another pass. Returning the in-flight promise here used to lose
      // that mutation until the 15-minute maintenance interval. Coalesce it into
      // exactly one follow-up rebuild instead.
      if (building) { reindexPending = true; return; }
      buildIndex().catch(() => {});
    }, Math.max(1000, Number(delay) || 5000));
    if (timer.unref) timer.unref();
  }

  function status() {
    const saved = index.ocr || {}, cfg = ocrService.getConfig(), live = ocrService.getStats();
    const ocr = building ? live : { ...saved, enabled:cfg.enabled, available:saved.available != null ? !!saved.available : !!live.available, langs:cfg.langs };
    return { ready:(index.docs || []).length > 0 || !!index.builtAt, building, builtAt:index.builtAt || 0, indexed:(index.docs || []).length, truncated:!!index.truncated, error, ocr };
  }

  function universalSearchShareEligible(share) { return !!(share && !share.revoked && share.type !== 'secret' && !share.encrypted); }

  function visibleDocs(canAccess) {
    // This is an authorization boundary: a missing visibility callback must never
    // silently turn into global access for a future caller.
    const allow = typeof canAccess === 'function' ? canAccess : () => false, rows = [];
    for (const doc of (index.docs || [])) {
      if (!doc) continue;
      const share = getById(doc.shareId);
      if (!universalSearchShareEligible(share) || !allow(share, doc)) continue;
      rows.push(doc);
    }
    return rows;
  }

  function scopedStatus(canAccess, includeGlobalDiagnostics) {
    const full = status(), docs = visibleDocs(canAccess), visibleOcr = docs.reduce((n, doc) => n + (doc && doc.ocr ? 1 : 0), 0);
    const out = { ...full, indexed:docs.length };
    if (!includeGlobalDiagnostics) {
      const ocr = full.ocr || {}, cfg = ocrService.getConfig();
      out.error = full.error ? 'index-error' : '';
      out.ocr = { enabled:!!ocr.enabled, available:!!ocr.available, langs:ocr.langs || cfg.langs, pdfAvailable:ocr.pdfAvailable == null ? undefined : !!ocr.pdfAvailable,
        missingLanguages:Array.isArray(ocr.missingLanguages) ? ocr.missingLanguages.slice(0,16) : [], processed:0, cached:visibleOcr, errors:0, deferred:0, eligible:docs.length, current:'' };
    }
    return out;
  }

  function query(q, req, limit, options = {}) {
    const max = Math.max(1, Math.min(200, Number(limit) || 100));
    const typeFilter = String(options.type || '').trim().toLowerCase();
    const canAccess = typeof options.canAccess === 'function' ? options.canAccess : (share) => universalSearchShareEligible(share) && typeof ownsShare === 'function' && ownsShare(req, share);
    const normalized = normalizeSearchText(q).trim(), tokens = searchTokens(normalized);
    if (!normalized) return [];
    let candidates = null;
    for (const tok of tokens) {
      const set = postings.get(tok) || new Set();
      if (candidates == null) candidates = new Set(set); else candidates = new Set([...candidates].filter((id) => set.has(id)));
      if (!candidates.size) break;
    }
    if (candidates == null) candidates = new Set(docsById.keys());
    const out = [];
    for (const id of candidates) {
      const d = docsById.get(id); if (!d) continue;
      const share = getById(d.shareId);
      if (typeFilter && String((share && share.type) || d.type || '').toLowerCase() !== typeFilter) continue;
      if (!share || !canAccess(share, d)) continue;
      const hay = (d.metaText || '') + '\n' + (d.searchText || ''), pos = hay.indexOf(normalized);
      if (pos < 0 && (!tokens.length || tokens.some((t) => !hay.includes(t)))) continue;
      const literalPositions = tokens.map((t) => hay.indexOf(t)).filter((n) => n >= 0), p = pos >= 0 ? pos : (literalPositions.length ? Math.min(...literalPositions) : 0);
      const start = Math.max(0, p - 60), end = Math.min(hay.length, p + Math.max(normalized.length,20) + 120);
      let matches = 0, i = pos; if (normalized && i >= 0) while (i >= 0 && matches < 999) { matches++; i = hay.indexOf(normalized, i + Math.max(1, normalized.length)); }
      const fileNorm = normalizeSearchText(d.file || '').trim(), baseNorm = normalizeSearchText(path.basename(String(d.file || ''))).trim(), shareNorm = normalizeSearchText(share.name || d.shareName || '').trim();
      const filenameMatchRank = baseNorm === normalized ? 3 : baseNorm.startsWith(normalized) ? 2 : (baseNorm.includes(normalized) || fileNorm.includes(normalized)) ? 1 : 0;
      let relevanceScore = pos >= 0 ? 30 : 12;
      if (filenameMatchRank === 3) relevanceScore += 120; else if (filenameMatchRank === 2) relevanceScore += 80; else if (filenameMatchRank === 1) relevanceScore += 55;
      if (shareNorm === normalized) relevanceScore += 70; else if (shareNorm.includes(normalized)) relevanceScore += 25;
      if (d.ocr) relevanceScore -= 8;
      out.push({ shareId:d.shareId, shareName:share.name || d.shareName, type:share.type || d.type, token:share.token || d.token, file:d.file, line:0, matches:matches || 1,
        snippet:(start > 0 ? '…' : '') + hay.slice(start,end).replace(/\s+/g,' ').trim() + (end < hay.length ? '…' : ''), kind:d.kind, ext:d.ext, size:d.size, mtime:d.mtime,
        ocr:!!d.ocr, ocrSource:d.ocrSource || null, relevanceScore, filenameMatchRank, matchField:filenameMatchRank ? 'filename' : (d.ocr ? 'ocr' : 'content'), highlightTerms:[normalized].concat(tokens).filter(Boolean).slice(0,8) });
    }
    out.sort((a,b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0) || String(a.file || '').localeCompare(String(b.file || '')));
    return out.slice(0, max);
  }

  function semanticSnippetPosition(hay, qTerms, normalizedQuery) {
    let best = normalizedQuery ? hay.indexOf(normalizedQuery) : -1;
    if (best >= 0) return best;
    for (const term of qTerms) for (const alias of (SEMANTIC_GROUPS[term] || [term])) {
      const pos = hay.indexOf(normalizeSearchText(alias)); if (pos >= 0 && (best < 0 || pos < best)) best = pos;
    }
    return best;
  }

  function semanticQuery(q, req, limit, options = {}) {
    const max = Math.max(1, Math.min(200, Number(limit) || 100));
    const typeFilter = String(options.type || '').trim().toLowerCase();
    const canAccess = typeof options.canAccess === 'function' ? options.canAccess : (share) => universalSearchShareEligible(share) && typeof ownsShare === 'function' && ownsShare(req, share);
    const normalized = normalizeSearchText(q).trim(), qTerms = semanticTerms(normalized);
    if (!qTerms.length) return [];
    const ids = new Set();
    for (const term of qTerms) for (const id of (semanticPostings.get(term) || [])) ids.add(id);
    for (const tok of searchTokens(normalized)) for (const id of (postings.get(tok) || [])) ids.add(id);
    const scored = [], totalDocs = Math.max(1, docsById.size);
    for (const id of ids) {
      const d = docsById.get(id); if (!d) continue;
      const share = getById(d.shareId);
      if (typeFilter && String((share && share.type) || d.type || '').toLowerCase() !== typeFilter) continue;
      if (!share || !canAccess(share, d)) continue;
      const sem = new Set(Array.isArray(d.semanticTerms) ? d.semanticTerms : semanticTerms((d.metaText || '') + ' ' + (d.searchText || '')));
      let score = 0, matched = 0;
      for (const term of qTerms) {
        if (!sem.has(term)) continue;
        matched += 1; const df = (semanticPostings.get(term) || new Set()).size || 1; score += 1 + Math.log(1 + totalDocs / df);
      }
      if (!matched) continue;
      const hay = (d.metaText || '') + '\n' + (d.searchText || ''), exactPos = hay.indexOf(normalized);
      if (exactPos >= 0) score += 8;
      const fileNorm = normalizeSearchText(d.file || '').trim(), baseNorm = normalizeSearchText(path.basename(String(d.file || ''))).trim();
      const filenameMatchRank = baseNorm === normalized ? 3 : baseNorm.startsWith(normalized) ? 2 : (baseNorm.includes(normalized) || fileNorm.includes(normalized)) ? 1 : 0;
      if (filenameMatchRank === 3) score += 30; else if (filenameMatchRank === 2) score += 20; else if (filenameMatchRank === 1) score += 12;
      if (d.ocr) score -= 1.5;
      for (const tok of searchTokens(normalized)) if (hay.includes(tok)) score += 0.75;
      score += (matched / qTerms.length) * 4;
      const queryTokens = searchTokens(normalized), snippetHay = d.searchText || d.metaText || '';
      let p = semanticSnippetPosition(snippetHay, qTerms, normalized);
      if (p < 0) { const literalPositions = queryTokens.map((t) => snippetHay.indexOf(t)).filter((n) => n >= 0); p = literalPositions.length ? Math.min(...literalPositions) : 0; }
      const start = Math.max(0, p - 70), end = Math.min(snippetHay.length, p + Math.max(normalized.length,24) + 150);
      scored.push({ score, result:{ shareId:d.shareId, shareName:share.name || d.shareName, type:share.type || d.type, token:share.token || d.token, file:d.file, line:0, matches:matched,
        snippet:(start > 0 ? '…' : '') + snippetHay.slice(start,end).replace(/\s+/g,' ').trim() + (end < snippetHay.length ? '…' : ''), kind:d.kind, ext:d.ext, size:d.size, mtime:d.mtime,
        ocr:!!d.ocr, ocrSource:d.ocrSource || null, semantic:true, semanticScore:Math.round(score * 100) / 100, relevanceScore:Math.round(score * 100) / 100,
        filenameMatchRank, matchField:filenameMatchRank ? 'filename' : (d.ocr ? 'ocr' : 'content'), highlightTerms:[normalized].concat(queryTokens).filter(Boolean).slice(0,8) } });
    }
    scored.sort((a,b) => b.score - a.score || String(a.result.file).localeCompare(String(b.result.file)));
    return scored.slice(0, max).map((x) => x.result);
  }

  function globalSearchText(value) { return normalizeSearchText(String(value == null ? '' : value)); }
  function globalSearchIso(value) { if (value == null || value === '') return ''; const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toISOString() : ''; }
  function globalSearchMatch(hay, needle) {
    const text = globalSearchText(hay), q = globalSearchText(needle).trim(); if (!q) return null;
    const pos = text.indexOf(q); if (pos < 0) return null;
    let score = 10; if (pos === 0) score += 8; if (text === q) score += 12;
    const start = Math.max(0, pos - 70), end = Math.min(text.length, pos + q.length + 150);
    return { score, snippet:(start > 0 ? '…' : '') + text.slice(start,end).replace(/\s+/g,' ').trim() + (end < text.length ? '…' : '') };
  }

  function metadataSearch(q, req, limit, options = {}) {
    const state = getState(), max = Math.max(1, Math.min(200, Number(limit) || 100));
    const canShare = typeof options.canShare === 'function' ? options.canShare : (s) => typeof ownsShare === 'function' && ownsShare(req, s);
    const role = options.role || (req && req.session && req.session.role) || (req && req.pwaSession && req.pwaSession.role) || '';
    const username = options.username || (req && req.session && req.session.username) || (req && req.pwaSession && req.pwaSession.username) || '';
    const includeAdminMeta = options.includeAdminMeta != null ? !!options.includeAdminMeta : ['owner','admin','auditor'].includes(role);
    const scopes = new Set(Array.isArray(options.scopes) ? options.scopes : ['links','users','logs']);
    const rows = [], push = (score, row) => rows.push({ score:Number(score) || 0, row });
    if (scopes.has('links')) {
      const seen = new Set(), linkRows = [];
      for (const sh of state.shares || []) if (sh) linkRows.push({ sh, trashed:false, trashId:null });
      for (const rec of (typeof trashItems === 'function' ? trashItems() : [])) if (rec && rec.share) linkRows.push({ sh:rec.share, trashed:true, trashId:rec.id });
      for (const item of linkRows) {
        const sh = item.sh, seenKey = (item.trashed ? 'trash:' : 'live:') + (sh && sh.id);
        if (!sh || seen.has(seenKey) || !canShare(sh, item)) continue; seen.add(seenKey);
        const hay = [sh.name,sh.type,sh.token,sh.ownerName,sh.adminNote,sh.note,sh.descriptionMd,Array.isArray(sh.tags)?sh.tags.join(' '):'',item.trashed?'trash deleted revoked corbeille supprimé':'',sh.archived?'archive archived archivé':''].filter(Boolean).join(' · ');
        const hit = globalSearchMatch(hay, q); if (!hit) continue;
        const pathName = item.trashed ? 'Corbeille' : (sh.archived ? 'Archive' : 'Partage');
        push(hit.score + (globalSearchText(sh.name) === globalSearchText(q).trim() ? 20 : 0), { scope:'link', kind:'link', shareId:sh.id, shareName:sh.name || sh.id, type:sh.type || 'share', token:sh.token || '', file:pathName,
          snippet:hit.snippet, archived:!!sh.archived, revoked:!!sh.revoked, trashed:!!item.trashed, trashId:item.trashId || null, path:item.trashed ? null : (typeof linkPrefix === 'function' ? linkPrefix(sh) + sh.token : null) });
      }
    }
    if (scopes.has('users') && includeAdminMeta && typeof accountList === 'function') {
      for (const acc of accountList()) {
        if (!acc) continue; const hay = [acc.username,acc.role,globalSearchIso(acc.lastLoginAt),globalSearchIso(acc.createdAt)].filter(Boolean).join(' · '), hit = globalSearchMatch(hay, q); if (!hit) continue;
        push(hit.score + (globalSearchText(acc.username) === globalSearchText(q).trim() ? 20 : 0), { scope:'user', kind:'user', shareId:null, shareName:acc.username || 'user', type:'user', token:'', file:acc.role || 'user', snippet:hit.snippet, accountId:acc.id || null, username:acc.username || '', role:acc.role || '', lastLoginAt:Number(acc.lastLoginAt) || null });
      }
    }
    if (scopes.has('logs')) {
      const visibleShareIds = new Set((state.shares || []).filter((sh) => sh && canShare(sh)).map((sh) => sh.id));
      for (const rec of (typeof trashItems === 'function' ? trashItems() : [])) if (rec && rec.share && canShare(rec.share, rec)) visibleShareIds.add(rec.share.id);
      const canSeeGlobalLogs = includeAdminMeta;
      for (const e of (state.audit || []).slice(0,500)) {
        if (!e) continue; if (!canSeeGlobalLogs && username && typeof normUsername === 'function' && normUsername(e.actor || e.username || '') !== normUsername(username)) continue;
        const hit = globalSearchMatch([e.action,e.actor||e.username,e.role,e.ip,e.detail,globalSearchIso(e.at)].filter(Boolean).join(' · '), q); if (!hit) continue;
        push(hit.score, { scope:'log', kind:'audit', shareId:null, shareName:e.action || 'audit', type:'log', token:'', file:(e.actor || e.username || 'system'), snippet:hit.snippet, at:Number(e.at) || null, action:e.action || '', actor:e.actor || e.username || '' });
      }
      for (const h of (state.history || []).slice(0,1000)) {
        if (!h) continue; if (!canSeeGlobalLogs && (!h.shareId || !visibleShareIds.has(h.shareId))) continue;
        const hit = globalSearchMatch([h.name,h.shareId,h.direction,h.status,h.failureReason,h.sender,h.ip,h.country,globalSearchIso(h.at)].filter(Boolean).join(' · '), q); if (!hit) continue;
        const sh = h.shareId ? getById(h.shareId) : null;
        push(hit.score - 1, { scope:'log', kind:'transfer', shareId:h.shareId || null, shareName:(sh && sh.name) || h.name || 'transfer', type:'log', token:sh && sh.token || '', file:h.direction === 'up' ? 'Upload' : 'Download', snippet:hit.snippet, at:Number(h.at) || null, path:sh && typeof linkPrefix === 'function' ? linkPrefix(sh) + sh.token : null });
      }
      for (const e of (state.activityLog || []).slice(0,1000)) {
        if (!e || e.kind === 'audit') continue; if (!canSeeGlobalLogs && (!e.shareId || !visibleShareIds.has(e.shareId))) continue;
        const hit = globalSearchMatch([e.name,e.kind,e.status,e.detail,e.ip,e.actor,e.accountId,e.deviceId,e.shareId,e.direction,globalSearchIso(e.at)].filter(Boolean).join(' · '), q); if (!hit) continue;
        const sh = e.shareId ? getById(e.shareId) : null;
        push(hit.score - 0.5, { scope:'log', kind:'activity', shareId:e.shareId || null, shareName:(sh && sh.name) || e.name || 'activity', type:'log', token:sh && sh.token || '', file:'Activity', snippet:hit.snippet, at:Number(e.at) || null, path:sh && typeof linkPrefix === 'function' ? linkPrefix(sh) + sh.token : null });
      }
    }
    rows.sort((a,b) => b.score - a.score || String(a.row.shareName || '').localeCompare(String(b.row.shareName || '')));
    return rows.slice(0,max).map((x) => ({ ...x.row, relevanceScore:Number(x.score) || 0, matchField:x.row.matchField || 'metadata', highlightTerms:x.row.highlightTerms || [globalSearchText(q).trim()].filter(Boolean) }));
  }

  function isHydrationCurrent(expectedGeneration, expectedEpoch) { return generation === expectedGeneration && epoch === expectedEpoch; }

  async function init() {
    const hydrationGeneration = generation, hydrationEpoch = epoch;
    await Promise.all([
      ocrService.loadCacheDeferred(hydrationGeneration, hydrationEpoch, isHydrationCurrent),
      loadIndexDeferred(hydrationGeneration, hydrationEpoch),
    ]);
    setImmediate(() => buildIndex().catch(() => {}));
    if (!reindexInterval) {
      reindexInterval = setInterval(() => scheduleReindex(1000), 15 * 60 * 1000);
      if (reindexInterval.unref) reindexInterval.unref();
    }
  }

  function resetAfterRestore(delay = 1000) {
    epoch += 1;
    error = null;
    reindexPending = false;
    if (timer) { try { clearTimeout(timer); } catch (_) {} timer = null; }

    // A restored store can reuse share IDs. Keeping the pre-restore in-memory
    // snippets until the asynchronous rebuild completes can therefore expose stale
    // filenames/content under a newly restored share with the same ID. Invalidate
    // both memory and the durable cache immediately; the index is only a cache and
    // is rebuilt from authoritative state/files below.
    index = { version:INDEX_VERSION, builtAt:0, docs:[] };
    rebuildPostings();
    try { fs.unlinkSync(INDEX_FILE); }
    catch (e) { if (!e || e.code !== 'ENOENT') console.warn('[search-index] stale cache invalidation after restore failed:', String((e && e.message) || e)); }

    scheduleReindex(delay); publishState();
  }

  function getIndex() { return index; }
  function isBuilding() { return building; }
  function getError() { return error; }
  function getGeneration() { return generation; }
  function getEpoch() { return epoch; }
  function getConstants() { return { INDEX_FILE, INDEX_VERSION, CONTENT_CAP, STORED_TEXT_CAP, DOC_MAX }; }

  publishState();
  return {
    init,
    buildIndex,
    scheduleReindex,
    resetAfterRestore,
    status,
    scopedStatus,
    visibleDocs,
    query,
    semanticQuery,
    metadataSearch,
    universalSearchShareEligible,
    extractUniversalSearchContent,
    extractZipTextContent,
    looksLikeTextBuffer,
    isSearchableText,
    buildPostingsDeferred,
    loadIndexDeferred,
    loadIndexSync,
    getIndex,
    isBuilding,
    getError,
    getGeneration,
    getEpoch,
    getConstants,
    isHydrationCurrent,
  };
}

module.exports = { createSearchService };
