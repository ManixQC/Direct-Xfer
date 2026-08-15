const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const server = read('server.js');
const app = read('pwa', 'app.js');
const html = read('pwa', 'index.html');
const standard = read('public', 'app.js');

test('1.51.2 exposes individual and bulk permanent deletion in the PWA trash', () => {
  assert.match(html, /id="share-trash-purge-all"[\s\S]*data-i18n="sharesTrashDeleteAll"/);
  assert.match(app, /sharesTrashDelete:\s*'Supprimer définitivement'/);
  assert.match(app, /sharesTrashDeleteAll:\s*'Tout supprimer définitivement'/);
  assert.match(app, /purge\.addEventListener\('click',function\(\)\{purgePwaTrash\(item\.id,item\.name\|\|item\.shareId\);\}\)/);
  assert.match(app, /async function purgeAllPwaTrash\(\)/);
  assert.match(app, /method:'DELETE'/);
});

test('PWA permanent purge routes are admin-gated and remove records through the strict purge helper', () => {
  assert.match(server, /app\.delete\('\/app\/trash\/:id',[\s\S]*!pwaViewerIsAdmin\(req\)[\s\S]*purgeTrashRecordById\(req\.params\.id,null\)/);
  assert.match(server, /app\.delete\('\/app\/trash',[\s\S]*!pwaViewerIsAdmin\(req\)[\s\S]*purgeTrashRecordById\(id,null\)/);
  assert.match(server, /canPurge:pwaViewerIsAdmin\(req\)/);
});

test('destructive trash wording is explicit in all supported PWA languages and standard UI', () => {
  assert.match(app, /sharesTrashDeleteAll:\s*'Delete all permanently'/);
  assert.match(app, /sharesTrashDeleteAll:\s*'Eliminar todo definitivamente'/);
  assert.match(standard, /'trash\.purgeAll': 'Tout supprimer définitivement'/);
});

test('1.51.2 release identifiers are synchronized', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '1.60.0');
  assert.equal(lock.version, '1.60.0');
  assert.equal(lock.packages[''].version, '1.60.0');
  assert.match(app, /APP_BUILD = '2026\.08\.15-pwa289'/);
  assert.match(read('pwa', 'sw.js'), /VERSION = '2026\.08\.15-pwa289'/);
  assert.match(html, /v1\.60\.0 · pwa289/);
  assert.match(html, /app\.js\?v=273/);
});
