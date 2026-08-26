'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function tuple(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `invalid semantic version: ${version}`);
  return match.slice(1).map(Number);
}

function atLeast(actual, minimum) {
  const a = tuple(actual), b = tuple(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function declaredFloor(spec) {
  const match = String(spec || '').match(/^(?:\^|~)?(\d+\.\d+\.\d+)$/);
  assert.ok(match, `dependency declaration must expose an auditable semver floor: ${spec}`);
  return match[1];
}

test('1.71.12 dependency declarations no longer advertise vulnerable Express/node-forge floors', () => {
  assert.ok(atLeast(declaredFloor(pkg.dependencies.express), '4.22.2'));
  assert.ok(atLeast(declaredFloor(pkg.dependencies['node-forge']), '1.4.0'));
  assert.doesNotMatch(pkg.dependencies.express, /4\.19\.2/);
  assert.doesNotMatch(pkg.dependencies['node-forge'], /1\.3\.1/);
});

test('1.71.12 lockfile resolves the dependency floors to the audited safe versions', () => {
  assert.equal(lock.version, '1.71.12');
  assert.equal(lock.packages[''].version, '1.71.12');
  assert.equal(lock.packages[''].dependencies.express, pkg.dependencies.express);
  assert.equal(lock.packages[''].dependencies['node-forge'], pkg.dependencies['node-forge']);
  assert.ok(atLeast(lock.packages['node_modules/express'].version, '4.22.2'));
  assert.ok(atLeast(lock.packages['node_modules/node-forge'].version, '1.4.0'));
});
