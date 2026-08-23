'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');

/**
 * OCR boundary for Direct-Xfer.
 *
 * Owns native-tool discovery, Tesseract/Poppler invocation, OCR cache lifecycle
 * and the bounded OCR work used by the universal search index and DLP scanner.
 * Search/index state deliberately stays outside this module.
 */
function createOcrService(deps = {}) {
  const {
    DATA_DIR,
    DATA_KEY,
    encryptStore,
    deserializeStore,
    emitLiveActivity = () => {},
    addAdminCenterNotification = () => {},
    indexContentCap = 2 * 1024 * 1024,
    indexDocMax = 250000,
  } = deps;

  if (!DATA_DIR || typeof encryptStore !== 'function' || typeof deserializeStore !== 'function') {
    throw new TypeError('createOcrService requires DATA_DIR, encryptStore and deserializeStore');
  }

  const ENABLED = process.env.SEARCH_OCR_ENABLED == null ? true : /^(?:1|true|yes|on)$/i.test(String(process.env.SEARCH_OCR_ENABLED));
  const LANGS_RAW = String(process.env.SEARCH_OCR_LANGS || 'fra+eng').trim().toLowerCase();
  const LANGS = /^[a-z]{3}(?:\+[a-z]{3}){0,5}$/.test(LANGS_RAW) ? LANGS_RAW : 'fra+eng';
  const BATCH = Math.max(1, Number.parseInt(process.env.SEARCH_OCR_BATCH || '100', 10) || 100);
  const TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.SEARCH_OCR_TIMEOUT_MS || '60000', 10) || 60000);
  const IMAGE_MAX_BYTES = Math.max(1024 * 1024, (Number.parseInt(process.env.SEARCH_OCR_IMAGE_MAX_MB || '50', 10) || 50) * 1024 * 1024);
  const PDF_MAX_BYTES = Math.max(1024 * 1024, (Number.parseInt(process.env.SEARCH_OCR_PDF_MAX_MB || '100', 10) || 100) * 1024 * 1024);
  const PDF_MAX_PAGES = Math.max(1, Math.min(100, Number.parseInt(process.env.SEARCH_OCR_PDF_MAX_PAGES || '12', 10) || 12));
  const PDF_DPI = Math.max(96, Math.min(300, Number.parseInt(process.env.SEARCH_OCR_PDF_DPI || '160', 10) || 160));
  const IMAGE_EXTS = new Set(['jpg','jpeg','png','webp','bmp','tif','tiff']);
  const CACHE_FILE = path.join(DATA_DIR, 'search-ocr-cache.json');
  const CACHE_VERSION = 1;

  let bundledTessdataDir = String(process.env.DX_WINDOWS_TESSDATA_DIR || process.env.DX_WINDOWS_BUNDLED_TESSDATA_DIR || '').trim();
  let cache = { version: CACHE_VERSION, entries: {} };
  let toolState = null;
  let runtimeStats = { enabled:ENABLED, available:false, processed:0, cached:0, errors:0, deferred:0, eligible:0, current:'', missingLanguages:[], pdfAvailable:false };

  function resolveTesseractBinary() {
    const configured = String(process.env.SEARCH_OCR_TESSERACT_BIN || '').trim();
    if (configured) return configured;
    if (process.platform === 'win32') {
      const bundledRoot = path.resolve(__dirname, '..', '..', 'tesseract');
      const bundledTessdata = path.join(bundledRoot, 'tessdata');
      const bundled = path.join(bundledRoot, 'tesseract.exe');
      try {
        if (fs.existsSync(bundled) && fs.existsSync(bundledTessdata)) {
          const probe = spawnSync(bundled, ['--list-langs', '--tessdata-dir', bundledTessdata], {
            encoding:'utf8', windowsHide:true, timeout:5000, env:process.env,
          });
          const probeText = String((probe && probe.stdout) || '') + '\n' + String((probe && probe.stderr) || '');
          const languages = probeText.split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{3}$/.test(x));
          const requested = LANGS.split('+').filter(Boolean);
          if (!probe.error && probe.status === 0 && requested.every((lang) => languages.includes(lang))) {
            if (!String(process.env.TESSDATA_PREFIX || '').trim()) {
              bundledTessdataDir = bundledTessdata;
              process.env.TESSDATA_PREFIX = bundledTessdata;
            }
            return bundled;
          }
        }
      } catch (_) {}
    }
    return 'tesseract';
  }

  const TESSERACT_BIN = resolveTesseractBinary();
  const PDFTOTEXT_BIN = String(process.env.SEARCH_OCR_PDFTOTEXT_BIN || 'pdftotext').trim() || 'pdftotext';
  const PDFTOPPM_BIN = String(process.env.SEARCH_OCR_PDFTOPPM_BIN || 'pdftoppm').trim() || 'pdftoppm';

  function searchOcrTesseractArgs(args) {
    const dataDir = String(bundledTessdataDir || '').trim();
    return dataDir ? args.concat(['--tessdata-dir', dataDir]) : args;
  }

  function runCommand(bin, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, {
        timeout:Math.max(1000, Number(options.timeout) || TIMEOUT_MS),
        maxBuffer:Math.max(1024 * 1024, Number(options.maxBuffer) || (8 * 1024 * 1024)),
        windowsHide:true,
        encoding:options.encoding || 'utf8',
        cwd:options.cwd || undefined,
      }, (err, stdout, stderr) => {
        if (err) { err.stderr = stderr; return reject(err); }
        resolve({ stdout:stdout || '', stderr:stderr || '' });
      });
    });
  }

  async function detectTools(force = false) {
    if (toolState && !force) return toolState;
    if (!ENABLED) {
      toolState = { tesseract:false, tesseractBinary:false, languages:[], missingLanguages:[], pdftotext:false, pdftoppm:false };
      runtimeStats = { ...runtimeStats, enabled:false, available:false, missingLanguages:[], pdfAvailable:false };
      return toolState;
    }
    const probe = async (bin, args) => {
      try { await runCommand(bin, args, { timeout:5000, maxBuffer:1024 * 1024 }); return true; }
      catch (_) { return false; }
    };
    const [tesseractBinary, pdftotext, pdftoppm] = await Promise.all([
      probe(TESSERACT_BIN, ['--version']),
      probe(PDFTOTEXT_BIN, ['-v']),
      probe(PDFTOPPM_BIN, ['-v']),
    ]);
    let languages = [];
    if (tesseractBinary) {
      try {
        const r = await runCommand(TESSERACT_BIN, searchOcrTesseractArgs(['--list-langs']), { timeout:5000, maxBuffer:1024 * 1024 });
        languages = String((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{3}$/.test(x));
      } catch (_) {}
    }
    const requested = LANGS.split('+').filter(Boolean);
    const missingLanguages = tesseractBinary ? requested.filter((lang) => !languages.includes(lang)) : requested.slice();
    const tesseract = !!tesseractBinary && missingLanguages.length === 0;
    toolState = { tesseract, tesseractBinary, languages, missingLanguages, pdftotext, pdftoppm };
    runtimeStats = { ...runtimeStats, enabled:ENABLED, available:tesseract, missingLanguages, pdfAvailable:!!(tesseract && pdftoppm) };
    return toolState;
  }

  function loadCacheSync() {
    try {
      const parsed = deserializeStore(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') cache = parsed;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') console.warn('[search-ocr] cache could not be loaded; OCR entries will be rebuilt:', String((e && e.message) || e));
    }
  }

  async function loadCacheDeferred(expectedGeneration, expectedEpoch, isCurrent) {
    try {
      const parsed = deserializeStore(await fs.promises.readFile(CACHE_FILE, 'utf8'));
      if (!parsed || parsed.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return false;
      if (typeof isCurrent === 'function' && !isCurrent(expectedGeneration, expectedEpoch)) return false;
      cache = parsed;
      return true;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') console.warn('[search-ocr] cache could not be loaded; OCR entries will be rebuilt:', String((e && e.message) || e));
      return false;
    }
  }

  function persistCacheSync(usedKeys) {
    try {
      const entries = {};
      const keys = usedKeys instanceof Set ? [...usedKeys] : Object.keys(cache.entries || {});
      for (const k of keys.slice(-Math.max(1000, Number(indexDocMax) || 250000))) {
        const v = cache.entries && cache.entries[k];
        if (v) entries[k] = v;
      }
      const next = { version:CACHE_VERSION, savedAt:Date.now(), entries };
      const tmp = CACHE_FILE + '.tmp-' + process.pid;
      const json = JSON.stringify(next);
      fs.writeFileSync(tmp, DATA_KEY ? encryptStore(json) : json, { mode:0o600 });
      fs.renameSync(tmp, CACHE_FILE);
      cache = next;
    } catch (e) {
      console.warn('[search-ocr] cache persist failed:', String((e && e.message) || e));
    }
  }

  function cacheKey(abs, st) {
    const id = crypto.createHash('sha256').update(String(abs)).digest('hex').slice(0, 32);
    // ctime closes the common stale-cache hole where content is replaced but
    // size and mtime are deliberately preserved (copy/restore/sync tools can do
    // this). It is cheap metadata and changes on normal content replacement.
    return id + ':' + Number(st && st.size || 0) + ':' + Math.floor(Number(st && st.mtimeMs || 0)) + ':' + Math.floor(Number(st && st.ctimeMs || 0)) + ':' + LANGS + ':' + PDF_MAX_PAGES + ':' + PDF_DPI;
  }

  function meaningfulExtractedText(text) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    return compact.length >= 80 && (compact.match(/[\p{L}\p{N}]/gu) || []).length >= 40;
  }

  async function tesseractFileText(abs) {
    const r = await runCommand(TESSERACT_BIN, searchOcrTesseractArgs([abs, 'stdout', '-l', LANGS, '--psm', '3']), {
      timeout:TIMEOUT_MS, maxBuffer:Number(indexContentCap) * 2,
    });
    return String(r.stdout || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Number(indexContentCap));
  }

  async function extractPdfTextWithPoppler(abs) {
    try {
      const r = await runCommand(PDFTOTEXT_BIN, ['-f','1','-l',String(PDF_MAX_PAGES),'-layout','-enc','UTF-8',abs,'-'], {
        timeout:TIMEOUT_MS, maxBuffer:Number(indexContentCap) * 2,
      });
      return String(r.stdout || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Number(indexContentCap));
    } catch (_) { return ''; }
  }

  async function ocrScannedPdf(abs) {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dx-search-ocr-'));
    const prefix = path.join(tmp, 'page');
    try {
      await runCommand(PDFTOPPM_BIN, ['-f','1','-l',String(PDF_MAX_PAGES),'-r',String(PDF_DPI),'-jpeg',abs,prefix], {
        timeout:Math.max(TIMEOUT_MS, TIMEOUT_MS * Math.min(PDF_MAX_PAGES, 4)), maxBuffer:2 * 1024 * 1024,
      });
      const files = (await fs.promises.readdir(tmp)).filter((n) => /^page-\d+\.jpg$/i.test(n)).sort((a,b) => (parseInt(a.match(/\d+/)[0],10)||0) - (parseInt(b.match(/\d+/)[0],10)||0));
      const out = [];
      let chars = 0;
      for (const file of files.slice(0, PDF_MAX_PAGES)) {
        const text = await tesseractFileText(path.join(tmp, file));
        if (text) { out.push(text); chars += text.length + 1; }
        if (chars >= Number(indexContentCap)) break;
      }
      return out.join('\n').slice(0, Number(indexContentCap));
    } finally {
      try { await fs.promises.rm(tmp, { recursive:true, force:true }); } catch (_) {}
    }
  }

  function beginBuild(tools) {
    runtimeStats = {
      enabled:ENABLED,
      available:!!(tools && tools.tesseract),
      processed:0, cached:0, errors:0, deferred:0, eligible:0, current:'',
      missingLanguages:(tools && tools.missingLanguages) || [],
      pdfAvailable:!!(tools && tools.tesseract && tools.pdftoppm),
    };
  }

  function syncBuildStats(ctx, tools) {
    runtimeStats = {
      enabled:ENABLED,
      available:!!(tools && tools.tesseract),
      processed:Number(ctx && ctx.processed) || 0,
      cached:Number(ctx && ctx.cached) || 0,
      errors:Number(ctx && ctx.errors) || 0,
      deferred:Number(ctx && ctx.deferred) || 0,
      eligible:Number(ctx && ctx.eligible) || 0,
      current:String((ctx && ctx.current) || ''),
      missingLanguages:(tools && tools.missingLanguages) || [],
      pdfAvailable:!!(tools && tools.tesseract && tools.pdftoppm),
    };
  }

  async function extractForIndex(abs, name, st, buildCtx, existingText) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    const isImage = IMAGE_EXTS.has(ext), isPdf = ext === 'pdf';
    if (!ENABLED || (!isImage && !isPdf)) return { text:'', ocr:false, source:null };
    if ((isImage && st.size > IMAGE_MAX_BYTES) || (isPdf && st.size > PDF_MAX_BYTES)) return { text:'', ocr:false, source:null, skipped:'size' };
    buildCtx.eligible += 1;
    const key = cacheKey(abs, st); buildCtx.usedCacheKeys.add(key);
    const cached = cache.entries && cache.entries[key];
    if (cached && typeof cached.text === 'string') {
      buildCtx.cached += 1;
      return { text:cached.text, ocr:!!cached.ocr, source:cached.source || null, cached:true };
    }
    if (isPdf && meaningfulExtractedText(existingText)) {
      const rec = { text:'', ocr:false, source:'pdf-text', at:Date.now() };
      cache.entries[key] = rec;
      return rec;
    }
    const tools = await detectTools();
    if (isPdf && tools.pdftotext) {
      const popplerText = await extractPdfTextWithPoppler(abs);
      const mergedText = [existingText, popplerText].filter(Boolean).join(' ').trim();
      if (meaningfulExtractedText(mergedText)) {
        const supplemental = String(popplerText || '').slice(0, Number(indexContentCap));
        cache.entries[key] = { text:supplemental, ocr:false, source:'pdf-text', at:Date.now() };
        return { text:supplemental, ocr:false, source:'pdf-text' };
      }
    }
    if (buildCtx.processed >= BATCH) { buildCtx.deferred += 1; return { text:'', ocr:false, source:null, deferred:true }; }
    if (!tools.tesseract || (isPdf && !tools.pdftoppm)) { buildCtx.errors += 1; return { text:'', ocr:false, source:null, unavailable:true }; }
    buildCtx.processed += 1;
    buildCtx.current = String(name || path.basename(abs));
    syncBuildStats(buildCtx, tools);
    try {
      emitLiveActivity('ocr-start', { name:String(name || path.basename(abs)), status:isPdf ? 'pdf' : 'image' });
      const text = isPdf ? await ocrScannedPdf(abs) : await tesseractFileText(abs);
      const rec = { text:String(text || '').slice(0, Number(indexContentCap)), ocr:true, source:isPdf ? 'pdf-ocr' : 'image-ocr', at:Date.now() };
      cache.entries[key] = rec;
      emitLiveActivity('ocr-complete', { name:String(name || path.basename(abs)), status:rec.source, detail:rec.text ? `${rec.text.length} chars` : null });
      return rec;
    } catch (e) {
      buildCtx.errors += 1;
      emitLiveActivity('ocr-error', { name:String(name || path.basename(abs)), status:'error', detail:String((e && e.message) || e) });
      console.warn('[search-ocr] failed for', String(name || path.basename(abs)), String((e && e.message) || e));
      addAdminCenterNotification('ocr-failed', { name:String(name || path.basename(abs)), detail:String((e && e.message) || e).slice(0,300), source:'search-index', dedupeKey:`ocr-failed:${String(name || path.basename(abs))}`, dedupeWindowMs:6*3600*1000 });
      return { text:'', ocr:false, source:null, error:true };
    } finally {
      buildCtx.current = '';
      syncBuildStats(buildCtx, tools);
    }
  }

  function getStats() { return { ...runtimeStats, missingLanguages:[...(runtimeStats.missingLanguages || [])] }; }
  function getConfig() {
    return {
      enabled:ENABLED, langs:LANGS, batch:BATCH, timeoutMs:TIMEOUT_MS,
      imageMaxBytes:IMAGE_MAX_BYTES, pdfMaxBytes:PDF_MAX_BYTES,
      pdfMaxPages:PDF_MAX_PAGES, pdfDpi:PDF_DPI,
      imageExts:IMAGE_EXTS,
    };
  }

  return {
    detectTools,
    loadCacheSync,
    loadCacheDeferred,
    persistCacheSync,
    extractForIndex,
    tesseractFileText,
    ocrScannedPdf,
    extractPdfTextWithPoppler,
    meaningfulExtractedText,
    searchOcrTesseractArgs,
    beginBuild,
    syncBuildStats,
    getStats,
    getConfig,
    runCommand,
  };
}

module.exports = { createOcrService };
