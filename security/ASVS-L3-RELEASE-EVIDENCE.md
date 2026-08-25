# Direct-Xfer 1.70.24 — ASVS L3 release evidence

Release date: 2026-08-24  
Profile: `ASVS_L3_MODE=true`

## Source gates

| Gate | Result | Evidence |
|---|---|---|
| ASVS regression tests | PASS | 64 passed, 0 failed, 0 skipped |
| Full regression tests | PASS | 1081 passed, 0 failed, 0 skipped |
| Static ASVS audit | PASS | 124 production JS files; 10 reviewed decoder sites; dynamic eval/Function/RegExp and legacy parser policy enforced |
| Security inventory | PASS | Regenerated for 1.70.24; 897 sensitive-boundary inventory entries |
| Windows runtime integrity | PASS | 102 entries; 0 stale hashes after final sync |
| Matrix triage | PASS for release bookkeeping | 345/345 triaged; 0 FAIL; 0 REVIEW |
| L3 policy preflight logic | PASS with synthetic declarations | All 11 startup checks passed using non-production placeholder values; this validates the gate logic only, not deployment evidence |
| CycloneDX SBOM | PASS | Root component synchronized to Direct-Xfer 1.70.24 |
| npm registry vulnerability scan | NOT EXECUTED | `npm audit` failed after retries because `registry.npmjs.org` DNS resolution returned `EAI_AGAIN`; must run in connected CI |

## Matrix state

- PASS: 191
- PARTIAL: 43
- FAIL: 0
- N/A: 89
- REVIEW: 0
- MANUAL: 22
- Total: 345

This release is **ASVS L3-profile capable / L3-ready**, not a blanket certification of every deployment. The remaining PARTIAL and MANUAL evidence is retained explicitly rather than being converted to PASS without proof.

## Exact commands used for the final source candidate

```text
node --test test/asvs-l3-*.test.js
npm test
npm run security:static-audit
npm run security:inventory
node scripts/sync-windows-runtime-manifest.js --check
```

The Windows manifest required one final synchronization after the last source changes; after `--write`, a second `--check` reported 102 entries and 0 updates. A synthetic `ASVS_L3_MODE=true` preflight also passed all startup checks; placeholder values were used intentionally and are not claimed as production proof.

## Deployment preflight

Before deploying in L3 mode, provide real values for the mandatory profile settings and run:

```text
npm run asvs:l3:check
```

Do not treat placeholder/dummy secret values as deployment evidence. Complete `security/ASVS-L3-DEPLOYMENT.md`, including TLS/proxy, hardware authenticator, egress firewall, Vault/KMS/HSM isolation, time synchronization, memory protection and remote SIEM verification.
