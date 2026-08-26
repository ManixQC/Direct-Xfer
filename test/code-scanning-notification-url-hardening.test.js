'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('notification management navigation accepts same-origin paths only', () => {
  const web = read('public/app.js');
  const pwa = read('pwa/app.js');
  assert.match(web, /function safeNotificationManageUrl\(value\)/);
  assert.match(web, /parsed\.origin !== location\.origin/);
  assert.match(web, /raw\.startsWith\('\/\/'\)/);
  assert.doesNotMatch(web, /location\.assign\(String\(n\.manageUrl\)\)/);
  assert.match(pwa, /function safePwaNotificationManageUrl\(value\)/);
  assert.match(pwa, /parsed\.origin!==location\.origin/);
  assert.match(pwa, /raw\.indexOf\('\/\/'\)===0/);
  assert.doesNotMatch(pwa, /location\.assign\(String\(n\.manageUrl\)\)/);
});
