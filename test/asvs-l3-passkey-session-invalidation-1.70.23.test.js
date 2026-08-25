'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('ASVS V7.4.3 passkey factor changes invalidate the account\'s other sessions', () => {
  const routes = read('lib/server/pwa-routes.js');
  // Passkey add, per-device unbind, single removal and bulk removal are all factor
  // changes and must terminate the account's other active sessions (keeping the
  // current one) so a pre-existing weaker-factor session cannot persist.
  const calls = routes.match(/clearOtherSessionsOfAccount\(acc\.id,\s*\(req\.pwaSession \|\| getSession\(req\) \|\| \{\}\)\.sid\)/g) || [];
  assert.ok(calls.length >= 4, `expected >=4 passkey-mutation session invalidations, found ${calls.length}`);

  // Each passkey mutation handler audits a distinct event; the invalidation must be
  // wired for the add path and every removal path.
  for (const audit of ['passkey-added', 'passkey-device-removed', 'passkey-removed', 'passkeys-disabled']) {
    assert.match(routes, new RegExp(audit), `${audit} handler present`);
  }
});

test('ASVS V7.4.3 clearOtherSessionsOfAccount is wired from the session domain into the PWA', () => {
  const app = read('lib/server/pwa-application.js');
  assert.match(app, /clearOtherSessionsOfAccount:\['session', 'clearOtherSessionsOfAccount'\]/);
  const session = read('lib/server/session-service.js');
  // The helper keeps the current session (keepSid) and clears the rest of the account's.
  assert.match(session, /function clearOtherSessionsOfAccount\(accountId, keepSid\)/);
  assert.match(session, /if \(sid !== keepSid && session\.accountId === accountId\) invalidateSessionSid\(sid\)/);
});
