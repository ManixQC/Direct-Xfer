'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'pwa', 'sw.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('1.51.2 brush size drives pen, blur and redaction', () => {
  assert.match(app, /annCtx\.lineWidth = updateAnnBrushSize\(\)/);
  assert.match(app, /annTool === 'blur'\) annGestureChanged = pixelateBrushAt\(annStart, brushSize\)/);
  assert.match(app, /annTool === 'blur'\) annGestureChanged = pixelateBrushSegment\(annLastPoint, p, brushSize\)/);
  assert.match(app, /annTool === 'redact'\) annGestureChanged = paintSolidBrushSegment\(annLastPoint, p, brushSize, '#000'\)/);
  assert.match(app, /function pixelateBrushSegment\(a, b, size\)/);
  assert.match(app, /function paintSolidBrushSegment\(a, b, size, color\)/);
});

test('short taps draw and interrupted gestures roll back cleanly', () => {
  assert.match(app, /annCtx\.arc\(annStart\.x, annStart\.y, brushSize \/ 2/);
  assert.match(app, /paintSolidBrushSegment\(annStart, annStart, brushSize, '#000'\)/);
  assert.match(app, /function cancelAnnGesture\(\)[\s\S]*?restoreAnnSnapshot\(annUndoStack\[annUndoStack\.length - 1\]\)/);
  assert.match(app, /addEventListener\('touchcancel', cancelAnnGesture\)/);
  assert.match(app, /if \(annGestureChanged\) \{ pushAnnUndo\(\)/);
});

test('undo snapshots restore geometry-changing edits and clear returns to the source image', () => {
  assert.match(app, /return \{ width: annCanvas\.width, height: annCanvas\.height, pixels:/);
  assert.match(app, /annCanvas\.width !== snapshot\.width \|\| annCanvas\.height !== snapshot\.height/);
  assert.match(app, /function replaceEditorCanvas\(tmp\)[\s\S]*?pushAnnUndo\(\)/);
  assert.match(app, /annBaseSnapshot && restoreAnnSnapshot\(annBaseSnapshot\)/);
  assert.match(app, /pushAnnUndo\(annBaseSnapshot\)/);
  assert.match(app, /96 \* 1024 \* 1024/);
  assert.doesNotMatch(app, /replaceEditorCanvas\(tmp\s*,\s*(?:true|false)\)/);
});

test('editor blocks conflicting mutations while detection runs and preserves work after export failure', () => {
  assert.match(app, /'ann-crop-square'[\s\S]*?'ann-adjust-apply'[\s\S]*?'ann-undo'[\s\S]*?'ann-apply'/);
  assert.match(app, /function cropAnnotate\(ratio\)[\s\S]*?annBusy\) return/);
  assert.match(app, /if \(annBusy \|\| annExporting\) return/);
  assert.match(app, /annExporting = false; setAnnBusy\(false\); toast\(t\('error'\), 'err'\); setAnnStatus\(t\('error'\), 'err'\)/);
});

test('1.51.2 PWA build and resource identifiers stay synchronized', () => {
  assert.equal(pkg.version, '1.63.4');
  assert.match(app, /APP_VERSION = '1\.63\.4'/);
  assert.match(app, /APP_BUILD = '2026\.08\.16-pwa317'/);
  assert.match(sw, /VERSION = '2026\.08\.16-pwa317'/);
  assert.match(html, /v1\.63\.4 · pwa317/);
  assert.match(html, /\/app\/app\.js\?v=297/);
  assert.match(sw, /\/app\/app\.js\?v=297/);
});
