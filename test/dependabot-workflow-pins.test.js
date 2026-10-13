'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const workflows = fs.readdirSync(path.join(root, '.github', 'workflows'))
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8'));
const expected = {
  'actions/setup-node': ['949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0'],
  'actions/upload-artifact': ['cf430e030ddbb5b0abf93d22962f4752f3646cd9', 'v7.0.2'],
  'signpath/github-action-submit-signing-request': ['f6d04783b4569d051e0c80105fe66e82819d0092', 'v3.0'],
  'actions/download-artifact': ['9000827ccba6bdab643e8b6fd33ac0654aef8333', 'v8.0.2'],
  'github/codeql-action/upload-sarif': ['24c54180a607b1449ed407dd24f251e4e9147c8d', 'v4.38.3'],
  'zizmorcore/zizmor-action': ['cc914d7f3750a2d13d75c7f184a1060aa0e9d482', 'v0.6.4'],
};
test('Dependabot GitHub Actions updates retain reviewed immutable SHA pins', () => {
  const counts = {};
  for (const [action, [sha, version]] of Object.entries(expected)) {
    const needle = `${action}@${sha} # ${version}`;
    const references = workflows.flatMap((body) => body.split(/\r?\n/).filter((line) => line.trim().startsWith('uses: '+action+'@') || line.trim().startsWith('- uses: '+action+'@')));
    assert.ok(references.length, `missing action: ${action}`);
    for (const ref of references) assert.ok(ref.includes(needle), `unexpected pin: ${ref}`);
    counts[action] = references.length;
  }
  assert.deepEqual(counts, {
    'actions/setup-node': 2,
    'actions/upload-artifact': 12,
    'signpath/github-action-submit-signing-request': 2,
    'actions/download-artifact': 2,
    'github/codeql-action/upload-sarif': 5,
    'zizmorcore/zizmor-action': 1,
  });
});
test('npm lockfile metadata matches patched Express and Nodemailer releases', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  const semvers = {express:'4.22.3', nodemailer:'10.1.0'};
  assert.equal(pkg.version,lock.version);
  for (const [name,version] of Object.entries(semvers)) {
    assert.equal(pkg.dependencies[name], `^${version}`);
    assert.equal(lock.packages[''].dependencies[name], `^${version}`);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.match(lock.packages[`node_modules/${name}`].resolved, new RegExp(`${name}-${version.replaceAll('.', '\\.')}\\.tgz$`));
    assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-[a-zA-Z0-9+/]+={0,2}$/);
  }
  assert.equal(lock.packages['node_modules/qs'].version, '6.16.0');
});
