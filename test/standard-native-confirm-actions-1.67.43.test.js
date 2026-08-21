'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function blockBetween(startNeedle, endNeedle) {
  const start = app.indexOf(startNeedle);
  const end = app.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing ${startNeedle}`);
  assert.ok(end > start, `missing end ${endNeedle}`);
  return app.slice(start, end);
}

test('1.69.3 provides an in-app confirmation modal independent of browser confirm()', () => {
  const block = blockBetween('function confirmDirectXferAction(message, options)', 'function dlpWarningParts(data)');
  assert.match(block, /id:'dx-confirm-overlay'/);
  assert.match(block, /role:'dialog'/);
  assert.match(block, /activeDirectXferConfirmCancel/);
  assert.match(block, /event\.key !== 'Escape'/);
  assert.doesNotMatch(block, /window\.confirm|\bconfirm\(/);
});

test('1.69.3 single-share revoke no longer depends on native confirm()', () => {
  const block = blockBetween('async function revokeShare(s)', 'async function reactivateShare');
  assert.match(block, /await confirmDirectXferAction\(t\('sh\.revokeConfirm'/);
  assert.doesNotMatch(block, /window\.confirm|\bconfirm\(/);
});

test('1.69.3 transfer history purge uses the in-app confirmation modal', () => {
  const start = app.indexOf("if ($('history-clear-btn')) $('history-clear-btn').addEventListener('click', async () => {");
  assert.ok(start >= 0);
  const block = app.slice(start, start + 650);
  assert.match(block, /await confirmDirectXferAction\(t\('hi\.clearConfirm'/);
  assert.match(block, /api\('DELETE', '\/api\/history'\)/);
  assert.doesNotMatch(block, /window\.confirm|\bconfirm\(/);
});

test('1.69.3 bulk share/photo revoke and photo-history purge also avoid native confirm()', () => {
  for (const needle of ["if ($('bulk-revoke')) $('bulk-revoke').addEventListener", "if ($('photos-bulk-revoke')) $('photos-bulk-revoke').addEventListener", "if ($('photos-history-purge')) $('photos-history-purge').addEventListener"]) {
    const start = app.indexOf(needle);
    assert.ok(start >= 0, `missing ${needle}`);
    const block = app.slice(start, start + 750);
    assert.match(block, /confirmDirectXferAction/);
    assert.doesNotMatch(block, /window\.confirm|\bconfirm\(/);
  }
});
