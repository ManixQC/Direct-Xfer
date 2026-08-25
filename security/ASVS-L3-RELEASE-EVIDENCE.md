# Direct-Xfer 1.71.3 — ASVS L3 release evidence

Release date: 2026-08-25  
Profile: `ASVS_L3_MODE=true`

## Source/release gates

| Gate | Result | Evidence |
|---|---|---|
| ASVS regression tests | PASS | 96 passed, 0 failed, 0 skipped |
| Complete current regression tree | PASS | 1134 passed, 0 failed, 0 skipped; all 189 `test/*.test.js` files verified |
| PARTIAL-closure audit | PASS | 127 production JS files; 38 repository-verifiable controls; 0 blocking findings |
| Static ASVS audit | PASS | 127 production JS files; 13 reviewed decoder sites |
| Security inventory | PASS | Regenerated for 1.71.3; 959 inventory entries |
| Windows runtime integrity | PASS | 103 entries; 0 stale hashes after final synchronization |
| Matrix triage | PASS | 345/345 triaged; 253 PASS; 0 PARTIAL; 0 FAIL; 92 N/A; 0 REVIEW; 0 MANUAL |
| Signed-evidence verifier | PASS | 22 required external requirement IDs; Ed25519 signature; requirement-specific method/predicate; canonical SHA-256; release/origin binding; ≤7-day TTL |
| Isolated crypto provider gate | PASS | L3 self-test requires hardware backing, non-exportable keys, key isolation and isolated encrypt/decrypt/HMAC/sign operations |
| CycloneDX SBOM | PASS | Root component synchronized to Direct-Xfer 1.71.3 |
| Connected dependency/container scan | DEPLOYMENT EVIDENCE | V15.2.1 startup evidence requires real release-bound dependency + container scans with zero High/Critical findings |

## Matrix state

- PASS: 253
- PARTIAL: 0
- FAIL: 0
- N/A: 92
- REVIEW: 0
- MANUAL: 0
- Total: 345

The source matrix has no unresolved `MANUAL`, `PARTIAL`, `FAIL` or `REVIEW` rows. External facts are not assumed: the L3 runtime fails closed unless the current signed evidence bundle proves all 22 deployment-only predicates.

## Regression note

The complete suite contains 1134 tests across 189 files. All 1134 passed in the normal `npm test` run with zero failures and zero skipped tests.

## Commands/gates used

```text
node --test test/asvs-l3-*.test.js
npm run security:partial-audit
npm run security:static-audit
npm run security:inventory
node scripts/sync-windows-runtime-manifest.js --write
node scripts/sync-windows-runtime-manifest.js --check
```

Production L3 additionally requires:

```text
npm run asvs:l3:evidence:verify
npm run asvs:l3:check
```

Those commands intentionally fail closed when the installation lacks its real HTTPS origin, external hardware-backed crypto provider, approved hardware authenticator policy, ClamAV, egress policy, remote audit sink or signed deployment evidence.
