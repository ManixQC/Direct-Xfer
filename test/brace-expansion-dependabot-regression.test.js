'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const load = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const pkg = load('package.json');
const lock = load('package-lock.json');
const sbom = load('security/sbom.cdx.json');

function atLeast(version, minimum) {
  const parse = (input) => {
    const match = String(input).match(/^(\d+)\.(\d+)\.(\d+)$/);
    assert.ok(match, `Expected a pinned semver, received ${input}`);
    return match.slice(1).map(Number);
  };
  const a = parse(version), b = parse(minimum);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

const BRACE_PACKAGE_PATH = /(?:^|\/)node_modules\/brace-expansion$/;
const BRACE_MINIMUM_PATCHED = '5.0.10';

test('Dependabot brace-expansion recursion DoS cannot regress through nested transitive dependencies', () => {
  assert.equal(pkg.dependencies.archiver, '^8.0.0');
  assert.ok(atLeast(pkg.overrides['brace-expansion'], BRACE_MINIMUM_PATCHED),
    'Root npm override must force a version containing the patched parseCommaParts');
  const entries = Object.entries(lock.packages)
    .filter(([key]) => BRACE_PACKAGE_PATH.test(key));
  assert.ok(entries.length > 0, 'Expected at least one resolved brace-expansion');
  for (const [name, entry] of entries) {
    assert.ok(atLeast(entry.version, BRACE_MINIMUM_PATCHED),
      `${name} still resolves to vulnerable brace-expansion ${entry.version}`);
    assert.equal(entry.version, pkg.overrides['brace-expansion'],
      `Nested copy ${name} bypasses the root npm override`);
    assert.equal(entry.resolved, `https://registry.npmjs.org/brace-expansion/-/brace-expansion-${entry.version}.tgz`);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/,
      `${name} must have verified lockfile integrity`);
  }
});

test('CycloneDX SBOM and lockfile agree on the patched brace-expansion version', () => {
  const components = sbom.components.filter((component) => component.name === 'brace-expansion');
  const entries = Object.entries(lock.packages)
    .filter(([key]) => BRACE_PACKAGE_PATH.test(key));
  assert.equal(components.length, entries.length);
  for (const component of components) {
    assert.ok(atLeast(component.version, BRACE_MINIMUM_PATCHED));
    const pkgPath = component.properties?.find((property) => property.name === 'cdx:npm:package:path')?.value;
    assert.ok(pkgPath, 'SBOM must retain the installed npm package path');
    assert.equal(component.version, lock.packages[pkgPath]?.version);
    assert.equal(component.purl, `pkg:npm/brace-expansion@${component.version}`);
    const integrity = lock.packages[pkgPath].integrity;
    const sha512 = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
    assert.ok(component.hashes?.some((hash) => hash.alg === 'SHA-512' && hash.content.toLowerCase() === sha512));
  }
});

test('security gates remain fail-closed for advisories reported by Dependabot', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/npm-audit.yml'), 'utf8');
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=moderate/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
});
