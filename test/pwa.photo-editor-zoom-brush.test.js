'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('photo editor exposes complete zoom and brush controls', () => {
  ['ann-zoom-out', 'ann-zoom', 'ann-zoom-in', 'ann-zoom-fit', 'ann-brush-size', 'ann-brush-value', 'ann-pan']
    .forEach((id) => assert.match(html, new RegExp(`id="${id}"`)));
  assert.match(html, /id="ann-zoom"[^>]*min="25"[^>]*max="400"[^>]*step="1"/);
  assert.match(html, /id="ann-brush-size"[^>]*min="2"[^>]*max="200"/);
  assert.match(app, /editorBrushSize: 'Grosseur du pinceau'/);
  assert.match(app, /editorBrushSize: 'Brush size'/);
  assert.match(app, /editorBrushSize: 'Tamaño del pincel'/);
});

test('zoom is visual only, bounded, centered and scrollable', () => {
  assert.match(app, /annZoom = Math\.max\(\.25, Math\.min\(4,/);
  assert.match(app, /fitScale = Math\.min\(1, availableWidth \/ annCanvas\.width, availableHeight \/ annCanvas\.height\)/);
  assert.match(app, /wrap\.scrollLeft = annCanvas\.offsetLeft \+ anchor\.x \* annCanvas\.offsetWidth - anchor\.viewX/);
  assert.match(app, /annTouchDistance\(e\.touches\).*annPinch\.distance/);
  assert.match(app, /String\(Math\.round\(annZoom \* 100\)\)/);
  assert.match(app, /e\.ctrlKey \|\| e\.metaKey/);
  assert.match(css, /\.annotate-canvas-wrap\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.annotate-canvas-stage\s*\{[^}]*min-width:\s*100%[^}]*min-height:\s*100%/);
});

test('selected brush size drives pen strokes and pan does not alter pixels', () => {
  assert.match(app, /annCtx\.lineWidth = updateAnnBrushSize\(\)/);
  assert.match(app, /if \(annTool === 'pan'\)[\s\S]*?wrap\.scrollLeft[\s\S]*?return;/);
  assert.match(app, /setAnnTool\('pan'\)/);
  assert.match(css, /\.annotate-canvas-wrap\.is-pan-mode #annotate-canvas\s*\{\s*cursor:\s*grab/);
});
