'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const app = read('public/app.js');
const server = read('server.js');

test('1.67.7 web-storage creation checks connector metadata before rclone probe', () => {
  const start = app.indexOf("async function openWebStorageModal(mode='share')");
  const end = app.indexOf("if($('new-web-storage-btn'))", start);
  assert.ok(start >= 0 && end > start);
  const block = app.slice(start, end);
  const summary = block.indexOf("/api/storage/connectors/summary");
  const list = block.indexOf("/api/storage/connectors',null,30000");
  assert.ok(summary >= 0, 'missing lightweight connector preflight');
  assert.ok(list > summary, 'full connector/rclone probe must happen after metadata preflight');
  assert.match(block, /if\(!configured\) \{ webStorageToast\(t\('webStorage\.none'\),'warn'\); return; \}/);
  assert.match(block, /if\(writable && !writableConfigured\)/);
});

test('1.67.7 connector summary endpoint never probes rclone', () => {
  const start = server.indexOf("adminRouter.get('/storage/connectors/summary'");
  const end = server.indexOf("adminRouter.get('/storage/connectors',", start);
  assert.ok(start >= 0 && end > start);
  const block = server.slice(start, end);
  assert.match(block, /connectorStore\(\)\.map\(publicConnector\)\.filter\(Boolean\)/);
  assert.match(block, /configured:connectors\.length/);
  assert.match(block, /writable:connectors\.filter/);
  assert.doesNotMatch(block, /connectorProbeSnapshot|storageConnectorService/);
});

test('1.67.7 no-connector and connector-check failures are actionable in all UI languages', () => {
  assert.match(app, /Aucun connecteur configuré\. Ajoutez-en un dans Configuration → Connecteurs de stockage\./);
  assert.match(app, /No connector is configured\. Add one under Configuration → Storage connectors\./);
  assert.match(app, /No hay conectores configurados\. Añade uno en Configuración → Conectores de almacenamiento\./);
  assert.match(app, /webStorage\.connectorCheckFail/);
  assert.match(app, /context==='connector-summary'/);
});
