'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('full Direct-Xfer universal index has a bounded persistent server OCR pipeline', () => {
  assert.match(server, /SEARCH_OCR_CACHE_FILE\s*=\s*path\.join\(DATA_DIR,\s*'search-ocr-cache\.json'\)/);
  assert.match(server, /SEARCH_OCR_BATCH/);
  assert.match(server, /SEARCH_OCR_PDF_MAX_PAGES/);
  assert.match(server, /async function extractServerOcrText\(/);
  assert.match(server, /searchOcrCacheKey\(abs, st\)/);
  assert.match(server, /persistSearchOcrCacheSync\(ocrCtx\.usedCacheKeys\)/);
});

test('server OCR uses Tesseract for images and Poppler only when a PDF needs visual OCR', () => {
  assert.match(server, /tesseractFileText\(/);
  assert.match(server, /extractPdfTextWithPoppler\(/);
  assert.match(server, /meaningfulExtractedText\(mergedText\)/);
  assert.match(server, /ocrScannedPdf\(/);
  assert.match(server, /execFile\(bin, args/);
});

test('Docker runtime includes offline OCR dependencies and French English Spanish language data', () => {
  for (const pkg of ['tesseract-ocr', 'tesseract-ocr-eng', 'tesseract-ocr-fra', 'tesseract-ocr-spa', 'poppler-utils']) {
    assert.match(docker, new RegExp(pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('full admin search exposes OCR progress and marks OCR-backed hits', () => {
  assert.match(app, /search\.ocrReady/);
  assert.match(app, /search\.ocrBuilding/);
  assert.match(app, /search\.ocrUnavailable/);
  assert.match(app, /if \(m\.ocr\).*search-ocr-badge/);
  assert.match(server, /ocr:\s*!!d\.ocr/);
  assert.match(server, /function universalSearchStatus\(\)[\s\S]*ocr/);
});

test('README documents server OCR controls for the full version', () => {
  for (const key of ['SEARCH_OCR_ENABLED', 'SEARCH_OCR_LANGS', 'SEARCH_OCR_BATCH', 'SEARCH_OCR_PDF_MAX_PAGES']) {
    assert.match(readme, new RegExp(key));
  }
});
