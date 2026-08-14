'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StorageConnectorService } = require('../lib/storage-connectors');

const ROOT = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

test('create-share modal remains vertically reachable on short and zoomed displays', () => {
  const css = read('public/style.css');
  assert.match(css, /#picker-overlay\s*\{[\s\S]*align-items:\s*center[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.picker-modal\s*\{[\s\S]*height:\s*var\(--dx-picker-modal-height[\s\S]*overflow:\s*hidden[\s\S]*display:\s*grid/);
  assert.match(css, /\.picker-body\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /@media \(max-height: 480px\)[\s\S]*\.picker-modal \.browser-list,[\s\S]*min-height:\s*220px/);
});

test('startup connector cleanup does not create an Imports directory', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-no-imports-'));
  const imports = path.join(parent, 'Imports');
  try {
    const service = new StorageConnectorService({ importRoot: imports });
    assert.equal(await service.cleanupStaleImports(), 0);
    assert.equal(fs.existsSync(imports), false, 'cleanup must not create the user-facing Imports folder');
  } finally {
    fs.rmSync(parent, { recursive:true, force:true });
  }
});

test('stale connector staging is cleaned and an otherwise empty Imports directory is pruned', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dx-prune-imports-'));
  const imports = path.join(parent, 'Imports');
  const staging = path.join(imports, '.dxconnector-import-staging');
  try {
    fs.mkdirSync(path.join(staging, 'job-aaaaaaaaaaaa'), { recursive:true });
    fs.writeFileSync(path.join(staging, 'job-aaaaaaaaaaaa', 'payload'), 'x');
    const service = new StorageConnectorService({ importRoot: imports });
    assert.equal(await service.cleanupStaleImports(), 1);
    assert.equal(fs.existsSync(imports), false, 'empty infrastructure-only Imports folder should be removed');
  } finally {
    fs.rmSync(parent, { recursive:true, force:true });
  }
});

test('resumable upload staging no longer lives in the reception directory', () => {
  const server = read('server.js');
  assert.match(server, /const PARTS_DIR = path\.join\(DATA_DIR, 'staging', 'upload-parts'\)/);
  assert.match(server, /const LEGACY_PARTS_DIR = path\.join\(INBOX_DIR, '\.dxparts'\)/);
  assert.match(server, /migrateLegacyUploadParts\(\)/);
  assert.doesNotMatch(server, /const PARTS_DIR = path\.join\(INBOX_DIR, '\.dxparts'\)/);
});


test('1.59.1 release metadata is synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.59.1');
  assert.equal(lock.version, '1.59.1');
  assert.equal(lock.packages[''].version, '1.59.1');
  assert.match(read('pwa/app.js'), /APP_VERSION = '1\.59\.1'/);
  assert.match(read('pwa/app.js'), /APP_BUILD = '2026\.08\.14-pwa280'/);
  assert.match(read('pwa/sw.js'), /VERSION = '2026\.08\.14-pwa280'/);
  assert.match(read('pwa/index.html'), /v1\.59\.1 · pwa280/);
  assert.match(read('pwa/index.html'), /app\.js\?v=266/);
  assert.match(read('windows-launcher/Program.cs'), /RuntimeAppBuild\s*= "1\.59\.1-launcher27-csharp"/);
});
