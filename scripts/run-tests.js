'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const RETIRED_RELEASE_TEST = /^(?:trivy-container-hardening|release-maintenance)-\d+\.\d+\.\d+\.test\.js$/;
const REQUIRED_CURRENT_TESTS = Object.freeze([
  'trivy-container-hardening.test.js',
  'release-maintenance.test.js',
]);

function selectTests(allTests) {
  const names = [...allTests].sort();
  for (const required of REQUIRED_CURRENT_TESTS) {
    if (!names.includes(required)) {
      throw new Error(`Required current release test is missing: test/${required}`);
    }
  }
  return {
    retired: names.filter((name) => RETIRED_RELEASE_TEST.test(name)),
    selected: names.filter((name) => !RETIRED_RELEASE_TEST.test(name)),
  };
}

function main() {
  const allTests = fs.readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => entry.name);
  const { retired, selected } = selectTests(allTests);

  if (retired.length) {
    process.stderr.write(
      `[Direct-Xfer] Ignoring superseded version-stamped release tests: ${retired.join(', ')}\n`,
    );
  }

  const tests = selected.map((name) => path.join(TEST_DIR, name));
  if (!tests.length) throw new Error('No Direct-Xfer tests found.');

  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.signal) {
    process.stderr.write(`Direct-Xfer tests terminated by signal ${result.signal}\n`);
    process.exit(1);
  }
  process.exit(Number.isInteger(result.status) ? result.status : 1);
}

if (require.main === module) main();

module.exports = {
  REQUIRED_CURRENT_TESTS,
  RETIRED_RELEASE_TEST,
  selectTests,
};
