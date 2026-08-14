'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'pwa', 'app.css'), 'utf8');

test('PWA image revoke waits exactly five seconds before server mutation', () => {
  const start = app.indexOf('function scheduleImageRevoke(row, photo)');
  assert.ok(start >= 0, 'scheduleImageRevoke must exist');
  const block = app.slice(start, app.indexOf('\n  async function editSelectedImages', start));
  assert.match(block, /deadline = Date\.now\(\) \+ 5000/);
  assert.match(block, /pending\.timer = setTimeout\(pending\.commit, 5000\);/);
  assert.ok(block.indexOf('revokeShareRequest(photo.token)') > block.indexOf('pending.commit = function ()'), 'server revoke must happen inside delayed commit');
  assert.doesNotMatch(block, /showUndo\(/, 'image revoke must not use the send-page generic undo bar');
});

test('PWA image card exposes a visible inline cancel-revocation action', () => {
  assert.ok(app.includes('class="imglink-revoke-undo hidden"'));
  assert.ok(app.includes('class="btn sm imglink-cancel-revoke"'));
  assert.ok(app.includes("imgCancelRevoke: 'Annuler révocation'"));
  assert.ok(app.includes("imgCancelRevoke: 'Cancel revocation'"));
  assert.ok(app.includes("imgCancelRevoke: 'Cancelar revocación'"));
  assert.match(css, /\.imglink-revoke-undo \{/);
  assert.match(css, /\.imglink-cancel-revoke \{/);
});

test('PWA image revoke countdown is localized and refresh cannot overwrite it', () => {
  assert.ok(app.includes("imgRevokePending: 'Révocation dans {n} s…'"));
  assert.ok(app.includes("imgRevokePending: 'Revoking in {n} s…'"));
  assert.ok(app.includes("imgRevokePending: 'Revocación en {n} s…'"));
  assert.ok(app.includes('if (!pendingImageRevokes.has(photo.token)) restoreImageRowStatus(row, photo);'));
});

test('cancelling image revoke clears timers and prevents delayed commit', () => {
  const start = app.indexOf('function scheduleImageRevoke(row, photo)');
  const block = app.slice(start, app.indexOf('\n  async function editSelectedImages', start));
  assert.match(block, /function cancelPending\(\)/);
  assert.match(block, /pending\.cancelled = true;/);
  assert.match(block, /clearTimeout\(pending\.timer\); clearInterval\(pending\.ticker\);/);
  assert.match(block, /toast\(t\('imgRevokeCancelled'\), 'ok'\)/);
  assert.match(block, /if \(pending\.cancelled \|\| pending\.committed \|\| pendingImageRevokes\.get\(photo\.token\) !== pending\) return;/);
});

test('starting a second image revoke immediately commits the first one', () => {
  const start = app.indexOf('function scheduleImageRevoke(row, photo)');
  const block = app.slice(start, app.indexOf('\n  async function editSelectedImages', start));
  assert.match(app, /var activePendingImageRevoke = null;/);
  assert.match(block, /if \(activePendingImageRevoke && activePendingImageRevoke\.commit\) activePendingImageRevoke\.commit\(\);/);
  assert.match(block, /pending\.committed = true;/);
  assert.ok(block.indexOf('activePendingImageRevoke.commit()') < block.indexOf('deadline = Date.now() + 5000'), 'the previous image must commit before the new countdown starts');
  assert.match(block, /activePendingImageRevoke = pending;\s*pending\.timer = setTimeout\(pending\.commit, 5000\);/);
});

test('second revoke runtime commits only the first and gives the second a fresh timer', async () => {
  const start = app.indexOf('function scheduleImageRevoke(row, photo)');
  const block = app.slice(start, app.indexOf('\n  async function editSelectedImages', start));
  let nextTimer = 1;
  const timeouts = new Map();
  const revoked = [];
  const removed = [];
  const makeElement = () => ({
    classList: { add() {}, remove() {} },
    textContent: '', className: '', disabled: false, onclick: null
  });
  const makeRow = () => {
    const elements = {
      '.imglink-revoke-undo': makeElement(),
      '.imglink-revoke-undo-text': makeElement(),
      '.imglink-cancel-revoke': makeElement(),
      '.imglink-st': makeElement()
    };
    return { classList: elements['.imglink-revoke-undo'].classList, querySelector: (selector) => elements[selector] };
  };
  const factory = new Function('setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'revokeShareRequest', `
    var pendingImageRevokes = new Map();
    var activePendingImageRevoke = null;
    var imageRecordsByToken = new Map();
    function t(key, vars) { return key + (vars ? ':' + vars.n : ''); }
    function restoreImageRowStatus() {}
    function recordImageAction() {}
    function toast() {}
    function renderImageVariantStats() {}
    function removeImageRow(row, token) { removed.push(token); }
    var removed = [];
    ${block}
    return { scheduleImageRevoke, pendingImageRevokes, removed,
      active: function () { return activePendingImageRevoke; } };
  `);
  const runtime = factory(
    (fn, ms) => { const id = nextTimer++; timeouts.set(id, { fn, ms }); return id; },
    (id) => timeouts.delete(id),
    () => nextTimer++,
    () => {},
    (token) => { revoked.push(token); return Promise.resolve(true); }
  );
  const first = { token: 'first', active: true };
  const second = { token: 'second', active: true };
  runtime.scheduleImageRevoke(makeRow(), first);
  assert.deepEqual(revoked, [], 'the first image still has its undo window');
  runtime.scheduleImageRevoke(makeRow(), second);
  assert.deepEqual(revoked, ['first'], 'selecting the second image commits the first immediately');
  assert.equal(runtime.active().token, 'second');
  const secondTimer = Array.from(timeouts.values()).find((timer) => timer.ms === 5000);
  assert.ok(secondTimer, 'the second image receives a fresh five-second timer');
  secondTimer.fn();
  assert.deepEqual(revoked, ['first', 'second']);
  await Promise.resolve();
});
