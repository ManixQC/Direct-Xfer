'use strict';
const { buildAsvsL3Report } = require('../lib/server/asvs-l3-policy');
const env = process.env;
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const config = {
  ASVS_L3_MODE: truthy(env.ASVS_L3_MODE),
  PUBLIC_URL: env.PUBLIC_URL || '',
  DATA_KEY: env.DATA_KEY || '',
  AUDIT_HMAC_KEY: env.AUDIT_HMAC_KEY || '',
  AUDIT_SIGNING_PRIVATE_KEY: env.AUDIT_SIGNING_PRIVATE_KEY || '',
  AUDIT_SIGNING_PRIVATE_KEY_FILE: env.AUDIT_SIGNING_PRIVATE_KEY_FILE || '',
  CLAMAV_HOST: env.CLAMAV_HOST || '',
  CLAMAV_PORT: Number(env.CLAMAV_PORT) || 3310,
  AUDIT_REMOTE_URL: env.AUDIT_REMOTE_URL || '',
  ASVS_L3_EGRESS_ALLOWLIST: env.ASVS_L3_EGRESS_ALLOWLIST || '',
  ASVS_L3_CRYPTO_PROVIDER: env.ASVS_L3_CRYPTO_PROVIDER || '',
  ADMIN_ALLOW_ANY: truthy(env.ADMIN_ALLOW_ANY),
  ASVS_L3_CLOCK_SYNCED: env.ASVS_L3_CLOCK_SYNCED || '',
  ASVS_L3_MEMORY_PROTECTED: env.ASVS_L3_MEMORY_PROTECTED || '',
};
const report = buildAsvsL3Report(config, env);
console.log(`Direct-Xfer ASVS L3 preflight: ${report.enabled ? (report.ok ? 'PASS' : 'FAIL') : 'PROFILE DISABLED'}`);
for (const row of report.checks) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.manual ? '[manual-evidence] ' : ''}${row.id}: ${row.detail}`);
if (!report.enabled) {
  console.error('Set ASVS_L3_MODE=true to validate the L3 deployment profile.');
  process.exitCode = 2;
} else if (!report.ok) process.exitCode = 1;
