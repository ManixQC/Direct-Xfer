'use strict';

// Static guards for the added features' plumbing (server helpers + client wiring
// + i18n in all three languages). Behaviour is covered by the integration test
// added-features-5-9-10-13-15; this pins the wiring so a refactor can't drop it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const reception = fs.readFileSync(path.join(ROOT, 'public', 'reception.js'), 'utf8');
const collab = fs.readFileSync(path.join(ROOT, 'public', 'dxcollab.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// A key must appear once per language block (fr/en/es) → at least 3 occurrences.
function occurrences(hay, needle) { return hay.split(needle).length - 1; }

test('#5 download-goal threshold is wired in the create + edit forms and server', () => {
  assert.match(html, /id="opt-dlthreshold"/);
  assert.match(html, /id="edit-dlthreshold"/);
  assert.match(app, /notifyDownloadThreshold: parseInt\(\$\('opt-dlthreshold'\)/);
  assert.match(app, /notifyDownloadThreshold: parseInt\(\$\('edit-dlthreshold'\)/);
  assert.match(app, /\$\('edit-dlthreshold'\)\.value = s\.notifyDownloadThreshold/);
  assert.match(app, /if \(\$\('opt-dlthreshold'\)\) \$\('opt-dlthreshold'\)\.value = ''/); // reset after create
  // Card marker + i18n in all three languages.
  assert.match(app, /🎯/);
  assert.ok(occurrences(app, "'pk.dlThreshold':") >= 3, 'pk.dlThreshold missing in a language');
  assert.ok(occurrences(app, "'sh.dlThresholdTip':") >= 3, 'sh.dlThresholdTip missing in a language');
  // Server: field parsed on create, patched (with re-arm) and serialized.
  assert.match(server, /function maybeNotifyDownloadThreshold\(s\)/);
  assert.match(server, /dispatch\('download-threshold'/);
  assert.match(server, /notifyDownloadThreshold: s\.notifyDownloadThreshold \|\| 0/);
  assert.match(server, /downloadThresholdReached: !!s\.downloadThresholdNotifiedAt/);
  assert.match(server, /delete s\.downloadThresholdNotifiedAt; \/\/ re-arm for the new goal/);
});

test('#9 the public remaining-slots line is wired on every download page', () => {
  assert.match(server, /function visitorSlotsHtml\(share, L\)/);
  // Rendered on the single-file, collection and folder pages.
  assert.ok(occurrences(server, 'visitorSlotsHtml(share, L)') >= 3, 'slots line missing on a public page');
  assert.ok(occurrences(server, 'visitorSlots:') >= 3, 'visitorSlots label missing in a language');
});

test('#10 the ZIP size estimate helper is wired next to every "download all" link', () => {
  assert.match(server, /function zipSizeEstimate\(items\)/);
  assert.match(server, /function zipEstHtml\(items, L\)/);
  assert.match(server, /zipEstHtml\(items, L\)/);   // collection page
  assert.match(server, /zipEstHtml\(entries, L\)/); // folder page
  assert.ok(occurrences(server, 'zipEstTitle:') >= 3, 'zipEstTitle label missing in a language');
});

test('#13 max-files-per-upload is wired in reception + collab forms, pages and clients', () => {
  assert.match(html, /id="ib-maxfiles-upload"/);
  assert.match(html, /id="cl-maxfiles-upload"/);
  assert.match(app, /maxFilesPerUpload: parseInt\(\$\('ib-maxfiles-upload'\)/);
  assert.match(app, /maxFilesPerUpload: parseInt\(\$\('cl-maxfiles-upload'\)/);
  assert.match(app, /sh\.limFilesPerUpload/); // shown in the admin card summaries
  // Server stores it (inbox + collab create), serialises + shows it publicly.
  assert.ok(occurrences(server, 'maxFilesPerUpload: nn(body.maxFilesPerUpload)') >= 2, 'create missing for inbox or collab');
  assert.match(server, /maxFilesPerUpload: share\.maxFilesPerUpload \|\| 0/);
  assert.match(server, /L\.limitFilesPerUpload\.replace\('\{v\}', s\.maxFilesPerUpload\)/);
  assert.ok(occurrences(server, 'limitFilesPerUpload:') >= 3, 'limitFilesPerUpload label missing in a language');
  // Clients enforce the per-deposit cap.
  assert.match(reception, /cfg\.maxFilesPerUpload > 0 && acc\.count >= cfg\.maxFilesPerUpload/);
  assert.match(reception, /maxPerUpload:/);
  assert.match(collab, /cfg\.maxFilesPerUpload/);
  // i18n keys in all three languages.
  assert.ok(occurrences(app, "'inbox.maxFilesPerUpload':") >= 3, 'inbox.maxFilesPerUpload missing in a language');
  assert.ok(occurrences(app, "'sh.limFilesPerUpload':") >= 3, 'sh.limFilesPerUpload missing in a language');
});

test('#15 the received-file browser modal, button, styles and endpoints are wired', () => {
  assert.match(html, /id="received-overlay"/);
  assert.match(html, /id="received-body"/);
  assert.match(app, /async function openReceivedFiles\(s\)/);
  assert.match(app, /rcvBtn\.addEventListener\('click', \(\) => openReceivedFiles\(s\)\)/);
  assert.match(app, /received-file\?path=' \+ encodeURIComponent\(f\.path\)/);
  assert.match(css, /\.received-grid\{/);
  // Server endpoints (list + download/inline) guarded to reception/collab links.
  assert.match(server, /adminRouter\.get\('\/shares\/:id\/received'/);
  assert.match(server, /adminRouter\.get\('\/shares\/:id\/received-file'/);
  assert.match(server, /if \(inline && imgType\)/);
  assert.ok(occurrences(app, "'recv.button':") >= 3, 'recv.button missing in a language');
});
