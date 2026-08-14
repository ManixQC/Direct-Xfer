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

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

test('25. OCR action is limited to local image/PDF queue items', () => {
  assert.match(js, /function canOcrItem\(it\)/);
  assert.match(js, /\^image\\\//);
  assert.match(js, /type === 'application\/pdf'/);
  assert.match(js, /if \(canOcrItem\(it\)\)/);
  assert.match(js, /ocr\.addEventListener\('click', function \(\) \{ openOcr\(it\); \}\)/);
});

test('OCR dialog exposes language, progress, search, copy and send-as-text controls', () => {
  for (const id of ['ocr-overlay', 'ocr-language', 'ocr-progress', 'ocr-status', 'ocr-search', 'ocr-result', 'ocr-copy', 'ocr-add-txt', 'ocr-cancel-run']) {
    assert.match(html, new RegExp(`id="${esc(id)}"`));
  }
  for (const lang of ['fra+eng', 'fra', 'eng', 'spa']) assert.match(html, new RegExp(`value="${esc(lang)}"`));
  assert.match(css, /\.ocr-dialog/);
  assert.match(css, /\.ocr-result/);
});

test('image OCR uses one Tesseract worker and terminates it after recognition', () => {
  assert.match(js, /tesseract\.js@7\.0\.0\/dist\/tesseract\.min\.js/);
  assert.match(js, /workerPath: OCR_TESSERACT_WORKER_URL/);
  assert.match(js, /corePath: OCR_TESSERACT_CORE_URL/);
  assert.match(js, /withOcrTimeout\(createPromise, OCR_ENGINE_INIT_TIMEOUT_MS\)/);
  assert.match(js, /errorHandler:/);
  assert.match(js, /await worker\.recognize\(file\)/);
  assert.match(js, /async function terminateOcrWorker\(\)/);
  assert.match(js, /await terminateOcrWorker\(\)/);
});

test('PDF OCR extracts embedded text first and renders only scanned pages', () => {
  assert.match(js, /pdfjs-dist@6\.2\.108\/build\/pdf\.min\.mjs/);
  assert.match(js, /await page\.getTextContent\(\)/);
  assert.match(js, /embedded\.replace\(\/\\s\/g, ''\)\.length >= 20/);
  assert.match(js, /await page\.render\(\{ canvasContext: ctx, viewport: viewport \}\)\.promise/);
  assert.match(js, /await worker\.recognize\(canvas\)/);
});

test('OCR output can be searched, copied and re-queued as a text file', () => {
  assert.match(js, /function updateOcrSearch\(reset, focusResult\)/);
  assert.match(js, /function stepOcrSearch\(dir\)/);
  assert.match(js, /copyText\(ocrText\)/);
  assert.match(js, /safeName\(base \+ '-ocr\.txt'\)/);
  assert.match(js, /await addFiles\(\[file\]\)/);
});

test('OCR cancellation is wired into the modal and Escape handling', () => {
  assert.match(js, /function cancelOcr\(\) \{ ocrAbort = true;/);
  assert.match(js, /if \(ocrAbort\) throw new Error\('OCR_CANCELLED'\)/);
  assert.match(js, /\$\('ocr-cancel-run'\).*cancelOcr/);
  assert.match(js, /\$\('ocr-overlay'\)\.classList\.contains\('hidden'\).*closeOcr\(\)/s);
});

test('PWA CSP permits only the pinned OCR CDN in addition to self', () => {
  const pwaCsp = /script-src 'self' 'wasm-unsafe-eval' https:\/\/cdn\.jsdelivr\.net;[\s\S]{0,180}connect-src 'self' https:\/\/cdn\.jsdelivr\.net;[\s\S]{0,180}worker-src 'self' blob: https:\/\/cdn\.jsdelivr\.net;/;
  assert.match(server, pwaCsp);
  assert.doesNotMatch(js, /fetch\(['"]\/app\/ocr/);
  assert.match(html, /votre document n’est envoyé à aucun service OCR/);
});


test('OCR engine bootstrap cannot remain stuck forever and pins worker/core resources', () => {
  assert.match(js, /OCR_ENGINE_SCRIPT_TIMEOUT_MS = 20000/);
  assert.match(js, /OCR_ENGINE_INIT_TIMEOUT_MS = 90000/);
  assert.match(js, /tesseract\.js@7\.0\.0\/dist\/worker\.min\.js/);
  assert.match(js, /tesseract\.js-core@7\.0\.0/);
  assert.match(js, /ocrEngineTimeout:/);
  assert.match(js, /Promise\.resolve\(createPromise\)\.then/);
});
