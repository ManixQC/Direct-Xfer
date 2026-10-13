'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n');

const ATTEST_SHA = '1e69f48acb82d1966a394da916b4c1698aa569d6';
const CODEQL_SHA = '24c54180a607b1449ed407dd24f251e4e9147c8d';
const ZIZMOR_SHA = 'cc914d7f3750a2d13d75c7f184a1060aa0e9d482';

const OLD_ATTEST_SHA = '508db95dd578ae2727ebd6217d5ba78e4fbda05d';
const OLD_CODEQL_SHA = 'f205ea1c3313d32999d8d6a48b4f6530d4437b38';
const OLD_ZIZMOR_SHA = '3dc1ecc9bcb9e94e9b2c709687979e1298497054';

test('GitHub Actions security dependencies use the reviewed Dependabot pins', () => {
  const windows = read('.github/workflows/build-windows-csharp.yml');
  const codacy = read('.github/workflows/codacy.yml');
  const scorecard = read('.github/workflows/scorecard.yml');
  const trivy = read('.github/workflows/trivy.yml');
  const zap = read('.github/workflows/zap.yml');
  const zizmor = read('.github/workflows/zizmor.yml');

  assert.equal((windows.match(new RegExp(`actions/attest@${ATTEST_SHA}`, 'g')) || []).length, 2);
  assert.match(windows, /# v4\.2\.2/);
  assert.doesNotMatch(windows, new RegExp(OLD_ATTEST_SHA));

  for (const workflow of [codacy, scorecard, trivy, zap]) {
    assert.match(workflow, new RegExp(`github/codeql-action/upload-sarif@${CODEQL_SHA}`));
    assert.match(workflow, /# v4\.38\.3/);
    assert.doesNotMatch(workflow, new RegExp(OLD_CODEQL_SHA));
  }
  assert.equal((trivy.match(new RegExp(`github/codeql-action/upload-sarif@${CODEQL_SHA}`, 'g')) || []).length, 2);

  assert.match(zizmor, new RegExp(`zizmorcore/zizmor-action@${ZIZMOR_SHA}`));
  assert.match(zizmor, /# v0\.6\.4/);
  assert.doesNotMatch(zizmor, new RegExp(OLD_ZIZMOR_SHA));
});
