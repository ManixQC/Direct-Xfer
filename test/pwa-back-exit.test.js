'use strict';

// The installed PWA must guard the Android back button: a single press dismisses an
// open dialog/overlay; on the bare view it warns and only a SECOND press within a
// short window leaves the app ("press back again to exit"). A PWA cannot close itself
// programmatically, so the exit works by keeping one throwaway history entry as a
// guard and leaving it OFF after the warning, letting the next back reach the root.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pwa = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('the "press back again to exit" warning is translated in all three languages', () => {
  assert.match(pwa, /backExit: 'Appuyez à nouveau pour quitter'/);
  assert.match(pwa, /backExit: 'Press back again to exit'/);
  assert.match(pwa, /backExit: 'Pulsa de nuevo para salir'/);
});

test('the Android back button is guarded only in the standalone PWA', () => {
  // The whole feature is gated behind isStandaloneApp() so a normal browser tab keeps
  // its native back button untouched.
  assert.match(pwa, /if \(isStandaloneApp\(\)\) \{[\s\S]*addEventListener\('popstate'/);
  // A throwaway history entry is pushed as the guard the back press consumes.
  assert.match(pwa, /history\.pushState\(\{ dxBack: true \}/);
  assert.match(pwa, /history\.state && history\.state\.dxBack/);
});

test('a back press dismisses an open overlay before it can exit the app', () => {
  // The back handler reuses the same overlay set/priority as the Escape key.
  assert.match(pwa, /var dismissTopOverlay = function \(\)/);
  for (const closer of ['closeVoice', 'closeCmd', 'closeAnnotate', 'closePairingDialog', 'closeDestForm']) {
    assert.match(pwa, new RegExp(closer), `dismissTopOverlay must be able to close via ${closer}`);
  }
  // popstate: close a dialog if one is open, otherwise warn and re-arm the guard later.
  assert.match(pwa, /if \(dismissTopOverlay\(\)\) \{[\s\S]*?pushBackGuard\(\); return; \}/);
  assert.match(pwa, /toast\(t\('backExit'\), 'warn'\);/);
  // The second press exits by leaving the guard OFF for ~2.5s, then re-pushing it.
  assert.match(pwa, /setTimeout\(function \(\) \{ pwaExitTimer = null; pushBackGuard\(\); \}, 2500\)/);
});

test('returning from a forward navigation (e.g. viewing an image) does not warn or exit', () => {
  // Opening an image with "view" (window.open _blank) can navigate the same window in a
  // standalone PWA, pushing an entry above the guard. Backing out of it lands back ON the
  // guard entry — popstate must early-return there so it is not mistaken for an exit press
  // (which would disarm the guard and let the next back close the app).
  assert.match(pwa, /if \(history\.state && history\.state\.dxBack\) return;[\s\S]*?dismissTopOverlay\(\)/);
});
