'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const server = read('server.js');
const app = read('public/app.js');
const reception = read('public/reception.js');
const pwa = read('pwa/app.js');
const html = read('public/index.html');

test('1.62.2 share editing and duplication retain useful config while clearing runtime state', () => {
  for (const key of ['maxFilesPerUpload','maxFilesPerSender','maxBytesPerSender','allowExt','blockExt','rejectDuplicates','requireSenderName','blockExecutables','moderated']) {
    assert.ok(server.includes(`'${key}'`) || server.includes(`editPositiveInt('${key}'`) || server.includes(`${key}:`), `missing ${key}`);
  }
  assert.match(html, /id="edit-reception-options"/);
  assert.match(app, /edit-rx-maxfilessender/);
  assert.match(server, /adminRouter\.post\('\/shares\/:id\/clone'/);
  for (const key of ['receivedHashes','senderStats','versions','editHistory','cacheRevision']) assert.ok(server.includes(`'${key}'`), `clone does not reset ${key}`);
});

test('1.62.2 standard share search covers type, files, recipients and recent client metadata', () => {
  assert.match(app, /s\.type/);
  assert.match(app, /s\.items/);
  assert.match(app, /s\.recipients/);
  assert.match(app, /lastDownload|lastUpload/);
  assert.match(app, /allowExt|blockExt/);
});

test('1.62.2 detailed stats support selectable periods, comparison, failure causes and resume visibility', () => {
  assert.match(server, /rawPeriod/);
  assert.match(server, /comparison,/);
  assert.match(server, /failureReasons:/);
  assert.match(server, /resumed:/);
  assert.match(app, /function statsPeriodToolbar/);
  for (const value of ["'1'","'7'","'14'","'30'","'all'"]) assert.ok(app.includes(value), `missing stats period ${value}`);
  assert.match(app, /stats\.failureReasons/);
  assert.match(app, /stats\.resumed/);
  assert.match(pwa, /pwaHostStatsPeriod/);
  assert.match(pwa, /failureReasons/);
});

test('1.62.2 reception shows restrictions and aggregate speed/ETA progress before and during upload', () => {
  assert.match(server, /inboxRestrictions/);
  assert.match(server, /id="up-overall"/);
  assert.match(reception, /function updateOverallProgress/);
  assert.match(reception, /avgSpeed/);
  assert.match(reception, /remaining/);
  assert.match(reception, /currentFiles/);
});

test('1.62.2 reception resumes per file and detects duplicates with replace keep or ignore choices', () => {
  assert.match(reception, /finishAlreadySent/);
  assert.match(reception, /upload-status/);
  assert.match(server, /duplicate-check/);
  assert.match(reception, /duplicateAction/);
  assert.match(reception, /duplicateReplace/);
  assert.match(reception, /duplicateKeep/);
  assert.match(reception, /duplicateIgnore/);
  assert.match(server, /duplicateAction === 'replace'/);
  assert.match(server, /hashFileSha256\(part\)/);
});

test('1.62.2 image editor keeps versions, edit history, restore and before-after comparison', () => {
  assert.match(server, /archiveCurrentPhotoVersion/);
  assert.match(server, /addPhotoEditHistory/);
  assert.match(server, /\/photos\/:id\/versions/);
  assert.match(server, /\/photos\/:id\/restore\/:versionId/);
  assert.match(app, /async function openPhotoVersions/);
  assert.match(app, /photo-ba-range/);
  assert.match(pwa, /manageImageVersions/);
  assert.match(pwa, /annOperations/);
});

test('1.62.2 admin before-after preview does not use the public view-counting image route', () => {
  assert.match(server, /adminRouter\.get\('\/photos\/:id\/preview'/);
  const start = app.indexOf('async function openPhotoVersions');
  const end = app.indexOf('\n}\n', start) + 3;
  const fn = app.slice(start, end);
  assert.match(fn, /\/api\/photos\/.*\/preview/);
  assert.doesNotMatch(fn, /cur\.src='\/i\//);
});

test('1.62.2 image variant stats include bandwidth and view share and edits bump cache revisions', () => {
  assert.match(server, /bandwidthBytes/);
  assert.match(server, /viewSharePct/);
  assert.match(app, /stats\.bandwidth/);
  assert.match(app, /stats\.viewShare/);
  assert.match(pwa, /bandwidthBytes/);
  assert.match(pwa, /viewSharePct/);
  assert.match(server, /function bumpPhotoCacheRevision/);
  assert.match(server, /\?v=' \+ encodeURIComponent\(rev\)/);
});
