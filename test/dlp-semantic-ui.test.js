'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ROOT=path.resolve(__dirname,'..');
const server=fs.readFileSync(path.join(ROOT,'server.js'),'utf8');
const html=fs.readFileSync(path.join(ROOT,'public','index.html'),'utf8');
const app=fs.readFileSync(path.join(ROOT,'public','app.js'),'utf8');
const pwa=fs.readFileSync(path.join(ROOT,'pwa','app.js'),'utf8');

test('DLP configuration and semantic mode are exposed in the full Direct-Xfer UI',()=>{
  assert.match(html,/id="search-semantic"[^>]*checked/);
  assert.match(html,/id="cfg-dlp-enable"/); assert.match(html,/id="cfg-dlp-mode"/); assert.match(html,/id="cfg-dlp-ocr"/);
  assert.match(app,/semantic=1/); assert.match(app,/dlpEnabled:/); assert.match(app,/dlpMode:/);
  assert.match(server,/dlpEnabled:\s*true/); assert.match(server,/universalSemanticSearchQuery/);
});

test('PWA image uploads and replacements honor DLP warnings without blindly retrying policy 403 responses',()=>{
  assert.match(server,/pwa-photo-create/); assert.match(server,/pwa-photo-replace/);
  assert.match(pwa,/async function imageDlpMutate/);
  assert.match(pwa,/issue && issue\.error === 'dlp-warning'/);
  assert.match(pwa,/err\.error === 'invalid-csrf'/);
  assert.match(pwa,/imageDlpMutate\(uploadUrl/);
  assert.match(pwa,/imageDlpMutate\(replaceUrl/);
});

test('DLP OCR does not skip mixed PDFs just because they already contain a searchable text layer',()=>{
  assert.match(server,/const shouldOcr = ctx\.scanOcr && \(ext === 'pdf' \|\| \(SEARCH_OCR_IMAGE_EXTS\.has\(ext\)/);
  assert.doesNotMatch(server,/ctx\.scanOcr && text\.trim\(\)\.length < 80 && \(SEARCH_OCR_IMAGE_EXTS\.has\(ext\) \|\| ext === 'pdf'\)/);
});
