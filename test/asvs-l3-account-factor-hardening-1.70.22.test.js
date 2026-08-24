'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('ASVS V6.3.2 fresh owner bootstrap has no predictable admin default', () => {
  const source = read('lib/server/account-service.js');
  assert.doesNotMatch(source, /env\.ADMIN_USERNAME\s*\|\|\s*['"]admin['"]/);
  assert.match(source, /owner-\$\{crypto\.randomBytes\(6\)\.toString\('hex'\)\}/);
  assert.match(source, /persistedOwnerUsername/);
});

test('ASVS V7.4.3 TOTP enable and disable invalidate sibling sessions', () => {
  const source = read('lib/server/admin-account-routes.js');
  const enable = source.slice(source.indexOf("adminRouter.post('/2fa/enable'"), source.indexOf("adminRouter.post('/2fa/disable'"));
  const disable = source.slice(source.indexOf("adminRouter.post('/2fa/disable'"), source.indexOf("adminRouter.get('/accounts'"));
  assert.match(enable, /clearOtherSessionsOfAccount\(account\.id, req\.session\.sid\)/);
  assert.match(disable, /clearOtherSessionsOfAccount\(account\.id, req\.session\.sid\)/);
});
