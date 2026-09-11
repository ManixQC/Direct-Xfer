'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const releaseVersion = readJson('package.json').version;

test(`${releaseVersion} resolves Nodemailer at the audited 9.1.1 security floor`, () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  assert.equal(pkg.version, lock.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.dependencies.nodemailer, '^9.1.1');
  assert.equal(lock.packages[''].dependencies.nodemailer, '^9.1.1');
  const resolved = lock.packages['node_modules/nodemailer'];
  assert.ok(resolved, 'Nodemailer must remain locked');
  assert.equal(resolved.version, '9.1.1');
  assert.match(resolved.resolved || '', /nodemailer-9\.1\.1\.tgz$/);
  assert.match(resolved.integrity || '', /^sha512-/);
});

test(`${releaseVersion} SBOM reports the same Nodemailer version as package-lock.json`, () => {
  const lock = readJson('package-lock.json');
  const sbom = readJson('security/sbom.cdx.json');
  const version = lock.packages['node_modules/nodemailer'].version;
  const component = (sbom.components || []).find((entry) => entry && entry.name === 'nodemailer');
  assert.ok(component, 'Nodemailer must be present in the committed SBOM');
  assert.equal(component.version, version);
  assert.equal(component['bom-ref'], `nodemailer@${version}`);
  assert.equal(component.purl, `pkg:npm/nodemailer@${version}`);
  const rootDependency = (sbom.dependencies || []).find((entry) => entry && entry.ref === `direct-xfer@${readJson('package.json').version}`);
  assert.ok(rootDependency && rootDependency.dependsOn.includes(`nodemailer@${version}`));
});


test(`${releaseVersion} OpenVEX marks the four Nodemailer advisories fixed`, () => {
  const vex = readJson('security/openvex.json');
  const statements = new Map((vex.statements || []).map((entry) => [entry && entry.vulnerability && entry.vulnerability.name, entry]));
  for (const advisory of [
    'GHSA-8m3c-c648-2xjj',
    'GHSA-wmmp-3585-3rmp',
    'GHSA-2x7j-588g-ccc2',
    'GHSA-cc9r-2j5m-2m83',
  ]) {
    const entry = statements.get(advisory);
    assert.ok(entry, `${advisory} must be documented in OpenVEX`);
    assert.equal(entry.status, 'fixed');
  }
});
