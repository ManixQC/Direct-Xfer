'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function tuple(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  assert.ok(m, `invalid semantic version: ${version}`);
  return m.slice(1).map(Number);
}
function atLeast(actual, minimum) {
  const a = tuple(actual), b = tuple(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

test('1.71.46 keeps Express on 4.22.2 and forces qs 6.16.0 for GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g', () => {
  assert.equal(pkg.version, '1.71.46');
  assert.equal(pkg.dependencies.express, '^4.22.2');
  assert.equal(lock.packages['node_modules/express'].version, '4.22.2');
  assert.equal(pkg.overrides && pkg.overrides.qs, '6.16.0');

  const qsEntries = Object.entries(lock.packages)
    .filter(([name, meta]) => /(?:^|\/)node_modules\/qs$/.test(name) && meta && meta.version);
  assert.ok(qsEntries.length >= 1, 'qs must be present in the lockfile');
  for (const [name, meta] of qsEntries) {
    assert.ok(atLeast(meta.version, '6.16.0'), `${name} resolves vulnerable qs ${meta.version}`);
  }
});

test('1.71.46 exercises the bracket-key comma arrayLimit regression when dependencies are installed', () => {
  let qs;
  try {
    qs = require('qs');
  } catch (error) {
    // Source archives intentionally omit node_modules. The lock/override assertion above
    // remains mandatory; dependency-backed CI executes this runtime branch after npm ci.
    assert.equal(error && error.code, 'MODULE_NOT_FOUND');
    return;
  }
  assert.throws(
    () => qs.parse('a[]=1,2,3,4', { comma: true, arrayLimit: 3, throwOnLimitExceeded: true }),
    RangeError,
  );
});


test('1.71.46 exercises the attacker-controlled isBuffer stringify regression when dependencies are installed', () => {
  let qs;
  try {
    qs = require('qs');
  } catch (error) {
    assert.equal(error && error.code, 'MODULE_NOT_FOUND');
    return;
  }
  const parsed = qs.parse('x%5Bconstructor%5D%5BisBuffer%5D=y', { plainObjects: true });
  assert.doesNotThrow(() => qs.stringify(parsed));
});
