'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('history/device/received lists cap the grid column so long item names ellipsize instead of overflowing', () => {
  // Without an explicit template the implicit grid column is `auto` and stretches
  // to the max-content of a non-wrapping filename, pushing the row off-screen.
  const rule = css.match(/\.history-list[^{]*\{[^}]*\}/);
  assert.ok(rule, 'history-list rule must exist');
  assert.match(rule[0], /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  // The name element still relies on ellipsis truncation.
  assert.match(css, /\.history-main strong[^{]*\{[^}]*text-overflow:\s*ellipsis/);
});

test('clearing local history updates the UI before the best-effort IndexedDB clear', () => {
  const handlerStart = js.indexOf("$('history-clear-btn').addEventListener('click'");
  assert.ok(handlerStart >= 0, 'clear-history handler must exist');
  const handler = js.slice(handlerStart, handlerStart + 700);

  const emptyAt = handler.indexOf('historyEntries = []');
  const renderAt = handler.indexOf('renderHistory()');
  const idbClearAt = handler.indexOf('idbClear(HISTORY_STORE)');
  assert.ok(emptyAt >= 0 && renderAt >= 0 && idbClearAt >= 0, 'handler must clear state, repaint and clear the store');

  // The in-memory clear and repaint must run BEFORE the store clear, so a blocked
  // or slow IndexedDB (Android WebAPK openDb timeout) can never abort the clear.
  assert.ok(emptyAt < idbClearAt, 'historyEntries must be emptied before idbClear');
  assert.ok(renderAt < idbClearAt, 'renderHistory must run before idbClear');

  // The store clear is fire-and-forget: never awaited, and its rejection swallowed.
  assert.match(handler, /idbClear\(HISTORY_STORE\)\.catch\(/);
  assert.doesNotMatch(handler, /await\s+idbClear\(HISTORY_STORE\)/);
});
