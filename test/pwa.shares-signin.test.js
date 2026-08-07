'use strict';

// Server-file share creation from the PWA requires an admin session (browsing the
// read-only host filesystem is an admin capability). In the common device-only
// state the browse endpoint returns 403 and the panel shows an "admin required"
// note. That note must carry an actionable sign-in link that returns to the shares
// panel after login, so the feature is reachable instead of a dead end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'pwa', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'pwa', 'app.js'), 'utf8');

test('the admin-required note offers an actionable sign-in link', () => {
  // The note holds a dedicated link (not the note's own data-i18n text).
  assert.match(html, /id="share-auth-note"[\s\S]*?id="share-login-link"[\s\S]*?data-i18n="sharesSignIn"/);
  // It points at the mobile login and returns to the shares panel afterwards.
  assert.match(html, /id="share-login-link"[^>]*href="\/app\/login\?next=%2Fapp%2F%3Faction%3Dshares"/);
});

test('the PWA reopens the shares panel after an admin sign-in (action=shares)', () => {
  assert.match(js, /launchAction === 'shares'[^;]*activatePwaPanel\('shares'/);
});

test('the sign-in label is translated in all three languages', () => {
  assert.match(js, /sharesSignIn: 'Se connecter en administrateur'/);
  assert.match(js, /sharesSignIn: 'Sign in as administrator'/);
  assert.match(js, /sharesSignIn: 'Iniciar sesión como administrador'/);
});
