'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('1.69.4 legacy 1.67.27 OAuth-broker test is superseded by token-verification coverage', () => {
  const deployment = read('lib/server/oauth-broker-deployment.js');
  const currentTest = read('test/oauth-broker-integrated-autodeploy-1.67.28.test.js');
  assert.match(deployment, /\/user\/tokens\/verify/);
  assert.match(currentTest, /\/user\/tokens\/verify/);
  assert.match(currentTest, /cloudflare-token-inactive/);
});
