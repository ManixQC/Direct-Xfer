# Direct-Xfer 1.71.12 — ASVS L3 release evidence

Release date: 2026-08-26
Profile: `ASVS_L3_MODE=true`

## Source/release gates

| Gate | Result | Evidence |
|---|---|---|
| Release-targeted regression tests | PASS | 70 passed, 0 failed, 0 skipped, including dependency floors, npm-audit CI, version/PWA synchronization, Windows metadata and SignPath release invariants |
| Complete current regression tree | CI REQUIRED | The source ZIP intentionally excludes `node_modules`; a local `npm ci` attempt timed out on registry access, so run `npm ci` + `npm test` in CI before publishing binaries |
| PARTIAL-closure audit | PASS | 127 production JS files; 38 repository-verifiable controls; 0 blocking findings |
| Static ASVS audit | PASS | 127 production JS files; 13 reviewed decoder sites |
| Security inventory | PASS | Regenerated for 1.71.12; 963 inventory entries |
| Windows runtime integrity | PASS | 103 entries; 0 stale source-resident hashes after final synchronization; build-time Express entry remains pinned to lockfile `4.22.2` |
| Matrix triage | PASS | 345/345 triaged; 253 PASS; 0 PARTIAL; 0 FAIL; 92 N/A; 0 REVIEW; 0 MANUAL |
| Signed-evidence verifier | PASS | 22 required external requirement IDs; Ed25519 signature; requirement-specific method/predicate; canonical SHA-256; release/origin binding; ≤7-day TTL |
| Isolated crypto provider gate | PASS | L3 self-test requires hardware backing, non-exportable keys, key isolation and isolated encrypt/decrypt/HMAC/sign operations |
| CycloneDX SBOM | PASS | Root component synchronized to Direct-Xfer 1.71.12 |
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

The 1.71.12 packaging pass executed 70 release-targeted tests with zero failures or skips, plus both repository-verifiable ASVS audits. A full `npm test` run must still be performed by CI after `npm ci`, because this source ZIP deliberately excludes `node_modules` and the local packaging sandbox could not complete registry access.

## Commands/gates used

```text
node --test test/dependency-security-floors-1.71.8.test.js test/npm-audit-ci-1.71.8.test.js test/windows-latest-deep-audit-1.66.6.test.js test/pwa-mobile-deep-audit-1.64.0.test.js test/signpath-foundation-pipeline-1.71.4.test.js test/project-reconstruction-1.64.0.test.js test/windows-recent-deep-audit-1.66.4.test.js test/windows-modern-dotnet-1.64.10.test.js test/release-maintenance-1.71.12.test.js
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
