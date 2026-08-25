'use strict';

const path = require('path');
const { createServerConfig } = require('../lib/server/config');
const { loadAndVerifyEvidence, REQUIRED_DEPLOYMENT_REQUIREMENTS } = require('../lib/server/asvs-l3-evidence');

const rootDir = path.resolve(__dirname, '..');
const config = createServerConfig({ rootDir, env:process.env });
const result = loadAndVerifyEvidence(config, process.env);

console.log(`Direct-Xfer ASVS L3 deployment evidence: ${result.ok ? 'PASS' : 'FAIL'}`);
console.log(`Release: ${config.APP_VERSION}`);
console.log(`Public origin: ${config.PUBLIC_URL || '(missing)'}`);
console.log(`Required evidence rows: ${REQUIRED_DEPLOYMENT_REQUIREMENTS.length}`);
if (!result.ok) {
  for (const failure of result.failures || []) console.error(`FAIL ${failure.id}: ${failure.detail}`);
  process.exitCode = 1;
} else {
  for (const id of REQUIRED_DEPLOYMENT_REQUIREMENTS) console.log(`PASS ${id}`);
}
