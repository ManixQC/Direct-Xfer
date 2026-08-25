'use strict';

const path = require('path');
const { createServerConfig } = require('../lib/server/config');
const { buildAsvsL3Report } = require('../lib/server/asvs-l3-policy');

const rootDir = path.resolve(__dirname, '..');
const config = createServerConfig({ rootDir, env:process.env });
const report = buildAsvsL3Report(config, process.env);

console.log(`Direct-Xfer ASVS L3 preflight: ${report.enabled ? (report.ok ? 'PASS' : 'FAIL') : 'PROFILE DISABLED'}`);
for (const row of report.checks) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.id}: ${row.detail}`);
if (!report.enabled) {
  console.error('Set ASVS_L3_MODE=true to validate the L3 deployment profile.');
  process.exitCode = 2;
} else if (!report.ok) {
  process.exitCode = 1;
}
