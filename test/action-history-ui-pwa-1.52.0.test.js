'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const server = read('server.js');
const html = read('public', 'index.html');
const app = read('public', 'app.js');
const pwaHtml = read('pwa', 'index.html');
const pwaApp = read('pwa', 'app.js');
const pwaCss = read('pwa', 'app.css');

// Regression coverage for the UI follow-up requested after feature #89.
test('standard view no longer exposes the action-history section or Undo modal', () => {
  assert.doesNotMatch(html, /id="undo-card-title"/);
  assert.doesNotMatch(html, /id="undo-preview"/);
  assert.doesNotMatch(html, /id="undo-count"/);
  assert.doesNotMatch(html, /id="undo-btn"/);
  assert.doesNotMatch(html, /id="undo-overlay"/);
  // Keep the underlying standard JS tolerant/no-op so shared mutation flows remain compatible.
  assert.match(app, /function loadUndoPreview\(\)/);
});

test('PWA Shares workspace exposes server action history with refresh, status and Undo controls', () => {
  assert.match(pwaHtml, /id="action-history-heading"/);
  assert.match(pwaHtml, /id="action-history-list"/);
  assert.match(pwaHtml, /id="action-history-count"/);
  assert.match(pwaHtml, /id="action-history-refresh"/);
  assert.match(pwaApp, /async function loadPwaActionHistory\(\)/);
  assert.match(pwaApp, /fetch\('\/app\/undo'/);
  assert.match(pwaApp, /appMutate\('\/app\/undo\/'\+encodeURIComponent\(entry\.id\)/);
  assert.match(pwaApp, /actionHistoryUnavailable/);
  assert.match(pwaApp, /PWA_ACTION_HISTORY_REASONS/);
  assert.match(pwaApp, /items\.filter\(pwaActionCanUndo\)/);
  assert.match(pwaCss, /\.action-history-row\.is-undone,\.action-history-row\.is-unavailable/);
});

test('PWA server exposes the persisted Undo log with scoped execution and atomic revocation history', () => {
  assert.match(server, /app\.get\('\/app\/undo'/);
  assert.match(server, /app\.post\('\/app\/undo\/:id'/);
  assert.match(server, /softDeleteShare\(s\.id, req, true, \{ type:'share-trashed', label \}\)/);
  assert.match(server, /deviceId: req && req\.pwaDevice/);
  assert.match(server, /function undoEntryExecutable\(req, entry\)/);
  assert.match(server, /reason: 'state-changed'/);
  assert.match(server, /UNDO_DESCRIPTOR_MAX_BYTES/);
  assert.match(server, /sanitizeUndoLog\(parsed\.undoLog\)/);
  assert.match(server, /undoLog: sanitizeUndoLog\(p\.undoLog\)/);
  assert.match(server, /entry\.deviceId.*req\.pwaDevice\.id/);
  assert.match(server, /Cache-Control', 'no-store'/);
});

test('PWA shell cache is advanced so installed apps receive the new interface', () => {
  assert.match(pwaApp, /APP_BUILD = '2026\.08\.16-pwa307'/);
  assert.match(read('pwa', 'sw.js'), /VERSION = '2026\.08\.16-pwa307'/);
  assert.match(pwaHtml, /app\.js\?v=290/);
  assert.match(pwaHtml, /app\.css\?v=274/);
});
