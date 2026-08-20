'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8').replace(/\r\n?/g, '\n');

test('1.67.26 Configuration treats zero storage connectors as a normal neutral state', () => {
  const start = app.indexOf('async function refreshStorageConnectors(forceProbe)');
  const end = app.indexOf("if ($('connector-add'))", start);
  assert.ok(start >= 0 && end > start);
  const block = app.slice(start, end);
  const summary = block.indexOf('/api/storage/connectors/summary');
  const full = block.indexOf("/api/storage/connectors', null, 30000");
  assert.ok(summary >= 0, 'missing lightweight connector summary preflight');
  assert.ok(full > summary, 'full rclone-backed connector endpoint must run after summary');
  assert.match(block, /if \(!configured && !forceProbe[^\n]*storageConnectors\.length === 0/);
  assert.match(block, /capabilities:\{ skipped:true \}/);
});

test('1.67.26 Configuration empty connector state is actionable and not red', () => {
  assert.match(app, /connector\.noneHint/);
  assert.match(app, /Aucun connecteur configuré\. Ajoutez-en un ci-dessous/);
  assert.match(app, /No connector is configured\. Add one below/);
  assert.match(app, /No hay conectores configurados\. Añade uno abajo/);
  const start = app.indexOf('function renderStorageConnectors(data)');
  const end = app.indexOf('async function refreshStorageConnectors(forceProbe)', start);
  const block = app.slice(start, end);
  assert.match(block, /if \(skipped\)/);
  assert.match(block, /cap\.className = 'muted sm'/);
});
