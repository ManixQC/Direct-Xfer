'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectDlpFindings, dlpPublicSummary } = require('../dlp-utils');

/**
 * Data-loss-prevention boundary for Direct-Xfer.
 *
 * Owns bounded local scanning, fail-closed OCR policy, severity-to-action rules,
 * quarantine durability and the HTTP decision surface. Content extraction and
 * OCR execution are delegated to search-service / ocr-service.
 */
function createDlpService(deps = {}) {
  const {
    HOST_ROOT,
    FULL_IMAGES_DIR,
    DLP_QUARANTINE_DIR,
    getState,
    getSettings,
    hostToContainer,
    assertRealWithin,
    persistNow,
    clientIp,
    maskIp,
    auditReq = () => {},
    logAudit = () => {},
    addAdminCenterNotification = () => {},
    addRequestCenterNotification = () => {},
    noteCenterServiceState = () => {},
    searchService,
    ocrService,
  } = deps;

  for (const [name, value] of Object.entries({ HOST_ROOT, FULL_IMAGES_DIR, DLP_QUARANTINE_DIR, getState, getSettings, hostToContainer, assertRealWithin, persistNow, clientIp, maskIp, searchService, ocrService })) {
    if (value == null) throw new TypeError(`createDlpService requires ${name}`);
  }

  const ACTIONS = new Set(['log','warn','quarantine','block']);
  const ACTION_RANK = { log:0, warn:1, quarantine:2, block:3 };
  let ocrUnavailableNotedAt = 0;

  function state() { return getState(); }
  function contentCap() { return Number(searchService.getConstants().CONTENT_CAP) || (2 * 1024 * 1024); }

  async function scanOneFile(abs, rel, ctx) {
    let st;
    try { st = await fs.promises.stat(abs); if (!st.isFile()) { ctx.scanErrors++; return; } }
    catch (_) { ctx.scanErrors++; return; }
    if (st.size > ctx.maxBytes) { ctx.filesSkipped++; ctx.truncated = true; return; }
    ctx.filesScanned++;
    let extracted = { kind:'metadata', text:'' };
    try { extracted = await searchService.extractUniversalSearchContent(abs, rel); } catch (_) { ctx.scanErrors++; }
    let text = String(extracted.text || '');
    const ext = (String(rel).split('.').pop() || '').toLowerCase();
    if (ext === 'zip') {
      try {
        const zip = await searchService.extractZipTextContent(abs, { maxEntries:100, maxTotalBytes:contentCap(), withMeta:true, strictCompleteness:true });
        // extractUniversalSearchContent() includes ZIP entry names as well as text.
        // Do not replace it with the second content-only extraction or DLP can miss
        // secrets/confidential markers present in archive filenames.
        if (!text && zip.text) text = zip.text;
        ctx.incompleteEntries += Number(zip.incompleteEntries) || 0;
        ctx.truncated = ctx.truncated || !!zip.truncated;
      } catch (_) { ctx.scanErrors++; }
    }

    const ocrConfig = ocrService.getConfig();
    const shouldOcr = ctx.scanOcr && (ext === 'pdf' || (ocrConfig.imageExts.has(ext) && text.trim().length < 80));
    if (shouldOcr) {
      try {
        const tools = await ocrService.detectTools();
        if (!tools.tesseract || (ext === 'pdf' && !tools.pdftoppm)) {
          ctx.ocrUnavailable = true;
          try { noteCenterServiceState('dlp', false, 'Service DLP OCR indisponible'); } catch (_) {}
        } else {
          ocrUnavailableNotedAt = 0;
          try { noteCenterServiceState('dlp', true, 'Service DLP rétabli'); } catch (_) {}
          const extra = ext === 'pdf' ? await ocrService.ocrScannedPdf(abs) : await ocrService.tesseractFileText(abs);
          if (extra) text += '\n' + extra;
        }
      } catch (_) { ctx.ocrErrors++; }
    }

    const found = detectDlpFindings((rel || '') + '\n' + text.slice(0, contentCap()), rel);
    ctx.findings.push(...found.slice(0, Math.max(0, 100 - ctx.findings.length)));
  }

  async function dlpScanResolvedItems(resolved) {
    const settings = getSettings();
    const ctx = {
      findings:[], filesScanned:0, filesSkipped:0, ocrErrors:0, ocrUnavailable:false, scanErrors:0, incompleteEntries:0,
      maxFiles:Math.max(1, Number(settings.dlpMaxFiles) || 100),
      maxBytes:Math.max(1024 * 1024, (Number(settings.dlpMaxFileMB) || 25) * 1024 * 1024),
      scanOcr:settings.dlpScanOcr !== false, truncated:false,
    };
    const walk = async (abs, rel) => {
      if (ctx.filesScanned + ctx.filesSkipped >= ctx.maxFiles) { ctx.truncated = true; return; }
      let ents;
      try { ents = await fs.promises.readdir(abs, { withFileTypes:true }); } catch (_) { ctx.scanErrors++; return; }
      for (const e of ents) {
        if (ctx.filesScanned + ctx.filesSkipped >= ctx.maxFiles) { ctx.truncated = true; return; }
        if (e.name === '.dxparts' || e.name === '.pending' || e.name.startsWith('.dx')) continue;
        const child = path.join(abs, e.name), childRel = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walk(child, childRel); else if (e.isFile()) await scanOneFile(child, childRel, ctx);
        if (ctx.findings.length >= 100) { ctx.truncated = true; return; }
      }
    };
    for (const item of (resolved || [])) {
      if (ctx.filesScanned + ctx.filesSkipped >= ctx.maxFiles || ctx.findings.length >= 100) { ctx.truncated = true; break; }
      let abs;
      try { abs = hostToContainer(item.hostPath); await assertRealWithin(HOST_ROOT, abs); } catch (_) { ctx.scanErrors++; continue; }
      if (item.type === 'folder') await walk(abs, item.name || ''); else await scanOneFile(abs, item.name || path.basename(abs), ctx);
    }
    return dlpPublicSummary(ctx);
  }

  async function dlpScanStoredFile(abs, rel) {
    const settings = getSettings();
    const ctx = {
      findings:[], filesScanned:0, filesSkipped:0, ocrErrors:0, ocrUnavailable:false, scanErrors:0, incompleteEntries:0,
      maxFiles:1, maxBytes:Math.max(1024 * 1024, (Number(settings.dlpMaxFileMB) || 25) * 1024 * 1024),
      scanOcr:settings.dlpScanOcr !== false, truncated:false,
    };
    await scanOneFile(abs, rel, ctx);
    return dlpPublicSummary(ctx);
  }

  function noteDlpOcrUnavailable(detail) {
    const now = Date.now();
    if (now - ocrUnavailableNotedAt < 6 * 3600 * 1000) return;
    ocrUnavailableNotedAt = now;
    try { logAudit('dlp-ocr-unavailable', { detail }); } catch (_) {}
    try { addAdminCenterNotification('ocr-failed', { detail:String(detail || 'OCR unavailable').slice(0,300), source:'DLP', dedupeKey:'ocr-failed:dlp-unavailable', dedupeWindowMs:6*3600*1000 }); } catch (_) {}
  }

  function stricterDlpAction(a, b) {
    const aa = ACTIONS.has(String(a || '').toLowerCase()) ? String(a).toLowerCase() : 'warn';
    const bb = ACTIONS.has(String(b || '').toLowerCase()) ? String(b).toLowerCase() : 'warn';
    return ACTION_RANK[aa] >= ACTION_RANK[bb] ? aa : bb;
  }

  function dlpEffectiveAction(settings, scan) {
    const fallback = ACTIONS.has(String(settings.dlpMode || '').toLowerCase()) ? String(settings.dlpMode).toLowerCase() : 'warn';
    if (!settings.dlpRulesEnabled || !scan || !scan.count) return fallback;
    const severity = ['low','medium','high','critical'].includes(String(scan.highest || '').toLowerCase()) ? String(scan.highest).toLowerCase() : 'medium';
    const key = 'dlpAction' + severity[0].toUpperCase() + severity.slice(1);
    const configured = String(settings[key] || '').toLowerCase();
    const action = ACTIONS.has(configured) ? configured : fallback;
    const incomplete = !!(scan.incomplete || scan.filesSkipped || scan.ocrErrors || scan.ocrUnavailable || scan.scanErrors || scan.incompleteEntries || scan.truncated);
    return incomplete ? stricterDlpAction(action, fallback) : action;
  }

  function sanitizeDlpQuarantineState() {
    const s = state();
    if (!s.meta || typeof s.meta !== 'object') s.meta = {};
    const raw = Array.isArray(s.meta.dlpQuarantine) ? s.meta.dlpQuarantine : [];
    const valid = raw.filter((r) => r && r.id && Number.isFinite(Number(r.at))).slice(-200);
    const changed = !Array.isArray(s.meta.dlpQuarantine) || valid.length !== raw.length || valid.some((r, i) => r !== raw[Math.max(0, raw.length - valid.length) + i]);
    s.meta.dlpQuarantine = valid;
    return changed;
  }

  function dlpQuarantineRecords() {
    sanitizeDlpQuarantineState();
    return state().meta.dlpQuarantine;
  }

  function dlpQuarantineFilePath(file) {
    const base = path.basename(String(file || ''));
    if (!base || base !== String(file || '')) return null;
    return path.join(DLP_QUARANTINE_DIR, base);
  }

  function reconcileDlpQuarantineFiles() {
    let changed = false;
    for (const rec of dlpQuarantineRecords()) {
      if (!rec || !rec.file) continue;
      const file = dlpQuarantineFilePath(rec.file);
      let exists = false;
      try { exists = !!file && fs.statSync(file).isFile(); } catch (_) {}
      if (!exists) { rec.file = null; rec.fileMissing = true; changed = true; }
      else if (rec.fileMissing) { delete rec.fileMissing; changed = true; }
    }
    return changed;
  }

  function removeDlpQuarantineFile(rec) {
    const file = rec && rec.file ? dlpQuarantineFilePath(rec.file) : null;
    if (!file) return;
    try { fs.unlinkSync(file); } catch (e) { if (!e || e.code !== 'ENOENT') console.error('[dlp] quarantine cleanup failed:', e && e.message); }
  }

  function cleanupDlpQuarantineOrphans() {
    const keep = new Set(dlpQuarantineRecords().map((r) => r && r.file ? path.basename(String(r.file)) : '').filter(Boolean));
    let entries = [];
    try { entries = fs.readdirSync(DLP_QUARANTINE_DIR, { withFileTypes:true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isFile() || keep.has(entry.name)) continue;
      try { fs.unlinkSync(path.join(DLP_QUARANTINE_DIR, entry.name)); }
      catch (e) { if (!e || e.code !== 'ENOENT') console.error('[dlp] orphan quarantine cleanup failed:', e && e.message); }
    }
  }

  function moveFileToDlpQuarantine(src, dst) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      if (!e || e.code !== 'EXDEV') throw e;
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      try { const fd = fs.openSync(dst, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      catch (syncErr) { try { fs.unlinkSync(dst); } catch (_) {} throw syncErr; }
      try { fs.unlinkSync(src); }
      catch (unlinkErr) { try { fs.unlinkSync(dst); } catch (_) {} throw unlinkErr; }
    }
  }

  function recordDlpQuarantine(req, scan, source, inputPath, displayName) {
    const id = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
    const session = req && (req.session || req.pwaSession);
    const rec = {
      id, at:Date.now(), source:String(source || 'share').slice(0,80),
      name:String(displayName || '').replace(/[\r\n\t]+/g,' ').slice(0,160),
      username:session && session.username ? String(session.username).slice(0,80) : (req && req.pwaDevice && req.pwaDevice.name ? ('PWA: ' + String(req.pwaDevice.name)).slice(0,80) : null),
      deviceId:req && req.pwaDevice && req.pwaDevice.id ? String(req.pwaDevice.id).slice(0,120) : null,
      ip:req ? maskIp(clientIp(req)) : null,
      dlp:scan ? { count:Number(scan.count)||0, highest:scan.highest||null, types:Array.isArray(scan.types)?scan.types.slice(0,30):[], incomplete:!!scan.incomplete,
        findings:Array.isArray(scan.findings)?scan.findings.slice(0,20).map((f)=>({type:String(f.type||'').slice(0,60),severity:String(f.severity||'').slice(0,16),file:String(f.file||'').slice(0,256),sample:String(f.sample||'').slice(0,80),detail:String(f.detail||'').slice(0,160)})):[] } : null,
      file:null,
    };
    let src = null, dst = null;
    if (inputPath) {
      src = path.resolve(inputPath);
      const managedRoot = path.resolve(FULL_IMAGES_DIR), rel = path.relative(managedRoot, src);
      let regular = false; try { regular = fs.lstatSync(src).isFile(); } catch (_) {}
      if (!regular || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        const err = new Error('dlp-quarantine-source-invalid'); err.code = 'DLP_QUARANTINE_SOURCE_INVALID'; throw err;
      }
      const ext = path.extname(String(displayName || src)).replace(/[^.a-z0-9]/gi,'').slice(0,12);
      dst = path.join(DLP_QUARANTINE_DIR, id + ext);
      try { moveFileToDlpQuarantine(src, dst); rec.file = path.basename(dst); }
      catch (e) { const err = new Error('dlp-quarantine-move-failed'); err.code = 'DLP_QUARANTINE_MOVE_FAILED'; err.cause = e; throw err; }
    }
    const list = dlpQuarantineRecords(), before = list.slice(), evicted = [];
    list.push(rec); while (list.length > 200) evicted.push(list.shift());
    if (!persistNow()) {
      state().meta.dlpQuarantine = before;
      if (dst && src) { try { moveFileToDlpQuarantine(dst, src); } catch (e) { console.error('[dlp] quarantine rollback failed:', e && e.message); } }
      const err = new Error('dlp-quarantine-persist-failed'); err.code = 'DLP_QUARANTINE_PERSIST_FAILED'; throw err;
    }
    for (const old of evicted) removeDlpQuarantineFile(old);
    try { auditReq(req, 'dlp-quarantined', `${rec.source}: ${rec.name || 'content'} · ${rec.dlp && rec.dlp.highest || 'unknown'} · ${rec.dlp && rec.dlp.count || 0} finding(s)`); } catch (_) {}
    return rec;
  }

  function dlpDecision(req, res, body, scan, source, quarantine) {
    const settings = getSettings();
    if (settings.dlpEnabled === false || !scan) return false;
    const ocrUnavailable = !!scan.ocrUnavailable;
    const otherIncomplete = !!(scan.filesSkipped || scan.ocrErrors || scan.scanErrors || scan.incompleteEntries || scan.truncated);
    const incomplete = otherIncomplete || ocrUnavailable;
    if (!scan.count && !incomplete) return false;
    const mode = dlpEffectiveAction(settings, scan), override = !!(body && body.dlpOverride === true);
    const detail = `${source || 'share'}: ${scan.count || 0} finding(s), incomplete=${incomplete ? 'yes' : 'no'}, skipped=${scan.filesSkipped || 0}, ocrErrors=${scan.ocrErrors || 0}, ocrUnavailable=${ocrUnavailable ? 'yes' : 'no'}, scanErrors=${scan.scanErrors || 0}, archiveIncomplete=${scan.incompleteEntries || 0} — ${(scan.types || []).join(', ')}`;
    const structuredDlpDetail = { code:'dlp-result', params:{ source:source || 'share', count:scan.count || 0, highest:scan.highest || 'none', incomplete:!!incomplete, types:(scan.types || []).join(', ') }, fallback:detail };
    if (scan.count) {
      addRequestCenterNotification(req, 'dlp-detected', { count:scan.count || 0, detail:`${source || 'share'} · ${(scan.types || []).join(', ') || 'sensitive'}`, source:source || 'share', dedupeKey:`dlp-detected:${source || 'share'}:${maskIp(clientIp(req))}:${(scan.types || []).join(',')}:${Math.floor(Date.now()/60000)}`, dedupeWindowMs:2*60000 });
    }
    if (ocrUnavailable && !otherIncomplete && !scan.count && mode !== 'log') {
      if (override) return false;
      noteDlpOcrUnavailable(detail);
      res.status(409).json({ error:'dlp-warning', reason:'ocr-unavailable', dlp:scan }); return true;
    }
    if (mode === 'block') {
      addRequestCenterNotification(req, 'dlp-blocked', { count:scan.count || 0, detail:`${source || 'share'} · ${(scan.types || []).join(', ') || 'sensitive'}`, source:source || 'share', dedupeKey:`dlp-blocked:${source || 'share'}:${maskIp(clientIp(req))}:${Math.floor(Date.now()/60000)}`, dedupeWindowMs:2*60000 });
      auditReq(req, 'dlp-blocked', structuredDlpDetail);
      res.status(403).json({ error:'dlp-blocked', dlp:scan }); return true;
    }
    if (mode === 'quarantine') {
      let q;
      try { q = recordDlpQuarantine(req, scan, source, quarantine && quarantine.file, quarantine && quarantine.name); }
      catch (e) {
        const failure = `${source || 'share'}: ${String(e && e.code || 'quarantine-failed')}`;
        try { auditReq(req, 'dlp-quarantine-failed', failure); } catch (_) {}
        try { addRequestCenterNotification(req, 'dlp-blocked', { count:scan.count || 0, detail:`${source || 'share'} · quarantine failed`, source:source || 'share', dedupeKey:`dlp-quarantine-failed:${source || 'share'}:${maskIp(clientIp(req))}:${Math.floor(Date.now()/60000)}`, dedupeWindowMs:2*60000 }); } catch (_) {}
        res.status(503).json({ error:'dlp-quarantine-failed', dlp:scan }); return true;
      }
      addRequestCenterNotification(req, 'dlp-blocked', { count:scan.count || 0, detail:`${source || 'share'} · quarantined · ${(scan.types || []).join(', ') || 'sensitive'}`, source:source || 'share', dedupeKey:`dlp-quarantine:${source || 'share'}:${maskIp(clientIp(req))}:${Math.floor(Date.now()/60000)}`, dedupeWindowMs:2*60000 });
      res.status(423).json({ error:'dlp-quarantined', quarantineId:q.id, dlp:scan }); return true;
    }
    if (mode === 'warn' && !override) {
      auditReq(req, 'dlp-warning', structuredDlpDetail);
      res.status(409).json({ error:'dlp-warning', reason:scan.count ? (incomplete ? 'findings-and-incomplete' : 'findings') : 'incomplete-scan', dlp:scan }); return true;
    }
    auditReq(req, mode === 'warn' ? 'dlp-overridden' : 'dlp-detected', structuredDlpDetail);
    return false;
  }

  function applyDlpSummary(share, scan) {
    if (!share || !scan || (!scan.count && !scan.incomplete)) return;
    share.dlp = { scannedAt:Date.now(), count:scan.count || 0, highest:scan.highest || null, types:scan.types || [], truncated:!!scan.truncated, incomplete:!!scan.incomplete,
      filesScanned:scan.filesScanned || 0, filesSkipped:scan.filesSkipped || 0, ocrErrors:scan.ocrErrors || 0, ocrUnavailable:!!scan.ocrUnavailable, scanErrors:scan.scanErrors || 0, incompleteEntries:scan.incompleteEntries || 0,
      findings:Array.isArray(scan.findings) ? scan.findings.slice(0,20).map((f) => ({ type:String(f.type||'').slice(0,60), severity:String(f.severity||'').slice(0,16), file:String(f.file||'').slice(0,256), sample:String(f.sample||'').slice(0,80), detail:String(f.detail||'').slice(0,160) })) : [] };
  }

  return {
    dlpScanResolvedItems,
    dlpScanStoredFile,
    dlpDecision,
    dlpEffectiveAction,
    applyDlpSummary,
    sanitizeDlpQuarantineState,
    reconcileDlpQuarantineFiles,
    cleanupDlpQuarantineOrphans,
    dlpQuarantineRecords,
    dlpQuarantineFilePath,
    removeDlpQuarantineFile,
    recordDlpQuarantine,
    stricterDlpAction,
    getOcrUnavailableNotedAt: () => ocrUnavailableNotedAt,
  };
}

module.exports = { createDlpService };
