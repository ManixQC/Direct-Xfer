'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('search status is viewer-scoped and hides raw global diagnostics from operators', () => {
  assert.match(server, /function universalSearchScopedStatus\(canAccess, includeGlobalDiagnostics\)/);
  assert.match(server, /out\.error = status\.error \? 'index-error' : ''/);
  assert.match(server, /indexed:docs\.length/);
  assert.match(server, /adminRouter\.get\('\/search\/status'[\s\S]*universalSearchScopedStatus\(canAccess, globalView\)/);
});

test('PWA universal search isolates result families instead of failing the whole request', () => {
  const start = server.indexOf("app.get('/app/search', async (req, res) => {");
  const end = server.indexOf('// Live "downloading now" presence', start);
  assert.ok(start > 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /try \{[\s\S]*universalSemanticSearchQuery[\s\S]*warnings\.push\('content-index'\)/);
  assert.match(route, /try \{[\s\S]*globalMetadataSearch[\s\S]*warnings\.push\('metadata'\)/);
  assert.match(route, /degraded:warnings\.length>0,warnings/);
  assert.match(route, /indexed:scopedStatus\.indexed/);
});

test('startup banner uses the same configured public-base priority as generated links', () => {
  assert.match(server, /const startupPublicUrl = startupSettings\.linkBase \|\| PUBLIC_URL \|\| ''/);
  assert.match(server, /const publicImgUrl = startupSettings\.imageBase \|\| startupPublicUrl/);
});
