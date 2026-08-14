'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = app.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < app.length; i++) {
    if (app[i] === '{') { depth++; opened = true; }
    else if (app[i] === '}' && opened && --depth === 0) return app.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

test('stale async detectors cannot mutate a later editor session', () => {
  assert.match(app, /function beginAnnotateSession\(\)[\s\S]*?annSession \+= 1/);
  assert.match(app, /function annSessionMatches\(session, canvas\)/);
  assert.match(app, /faces = await detector\.detect\(canvas\);[\s\S]*?if \(!annSessionMatches\(session, canvas\)\) return 0/);
  assert.match(app, /ret=await worker\.recognize\(canvas\); if \(!annSessionMatches\(session, canvas\)\) return 0/);
  assert.match(app, /setTimeout\(async function \(\) \{[\s\S]*?if \(!annSessionMatches\(session\)\) return/);
  assert.match(app, /finishAnnotate\(result\)[\s\S]*?annSession \+= 1/);
});

test('closing always resets busy state and releases the large canvas buffer', () => {
  const finish = app.slice(app.indexOf('  function finishAnnotate(result)'), app.indexOf('  function normalizedEditorExportType', app.indexOf('  function finishAnnotate(result)')));
  assert.match(finish, /setAnnBusy\(false\)/);
  assert.match(finish, /releaseAnnotateCanvas\(\)/);
  assert.match(app, /canvas\.width = 1; canvas\.height = 1/);
  assert.match(finish, /annUndoStack = \[\]; annBaseSnapshot = null/);
  assert.match(finish, /classList\.remove\('is-panning', 'is-pan-mode'\)/);
});

test('export is single-flight and reports the encoded bytes real MIME type', () => {
  const normalize = extractFunction('normalizedEditorExportType');
  const context = {};
  vm.runInNewContext(`${normalize}\nthis.normalize = normalizedEditorExportType;`, context);
  assert.equal(context.normalize('image/webp', 'image/png'), 'image/png');
  assert.equal(context.normalize('image/jpeg', 'image/jpeg; charset=binary'), 'image/jpeg');
  assert.equal(context.normalize('image/webp', ''), 'image/webp');
  assert.match(app, /if \(annBusy \|\| annExporting\) return/);
  assert.match(app, /annExporting = true; setAnnBusy\(true\)/);
  assert.match(app, /outType = normalizedEditorExportType\(outType, blob\.type\)/);
  assert.match(app, /if \(annExporting\) return;[\s\S]*?finishAnnotate\(annSourceFile\)/);
});

test('touch cancellation cannot leave drawing or panning stuck', () => {
  const cancel = extractFunction('cancelAnnGesture');
  assert.match(cancel, /annDrawing = false/);
  assert.match(cancel, /annPinch = null; annPanning = null/);
  assert.match(cancel, /classList\.remove\('is-panning'\)/);
  assert.match(app, /if \(annDrawing \|\| annPanning \|\| annPinch\) cancelAnnGesture\(\)/);
  assert.match(app, /if \(!e\.touches && Number\(e\.button\) !== 0\) return/);
});

test('editor controls reset per image and portrait images get a proportional brush', () => {
  assert.match(app, /\$\('ann-resize-max'\)\.value = '2048'/);
  assert.match(app, /\$\('ann-output-quality'\)\.value = '99'/);
  assert.match(app, /Math\.round\(Math\.max\(canvas\.width, canvas\.height\) \/ 180\)/);
  assert.match(html, /id="ann-zoom"[^>]*min="25"[^>]*max="400"[^>]*step="1"/);
});

test('adjustments have a pixel fallback when canvas filters are unavailable', () => {
  const channel = extractFunction('adjustedEditorChannel');
  const context = {};
  vm.runInNewContext(`${channel}\nthis.adjust = adjustedEditorChannel;`, context);
  assert.equal(context.adjust(128, 1, 1), 128);
  assert.equal(context.adjust(255, 1.5, 1), 255);
  assert.equal(context.adjust(0, 1, 2), 0);
  assert.match(app, /if \(c && 'filter' in c\)/);
  assert.match(app, /else applyEditorAdjustmentsFallback\(b, c0, sat\)/);
});
