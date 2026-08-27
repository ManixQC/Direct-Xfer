# Direct-Xfer 1.71.35 — ASVS L3 release evidence

> 1.71.35 replaces incomplete legacy Codacy SARIF tombstones with an allowlisted Code Scanning analysis cleanup. The workflow deletes only historical broad quality tools on canonical `main`, while CodeQL, Trivy, Scorecard, zizmor and current `Eslint-9` remain protected from deletion. Current Codacy findings continue through the `codacy-security/*` filter, so quality debt cannot be reintroduced into GitHub Security. Existing workflow-input hardening, Scorecard filtering, immutable dependency pins, least-privilege permissions and Docker retry/checksum hardening remain active. PWA advances to pwa498 / cache-buster v=479.

Release date: 2026-08-26
Profile: `ASVS_L3_MODE=true`

## Source/release gates

| Gate | Result | Evidence |
|---|---|---|
| Release-targeted regression tests | PASS | 114 passed, 0 failed, 0 skipped, including Codacy legacy-analysis API cleanup, zizmor template-injection regression coverage, Docker Go-network resilience, Scorecard SARIF filtering, CodeQL/OAuth regressions, dependency floors, Windows metadata and SignPath release invariants |
| Complete current regression tree | CI REQUIRED | Source-only run: 1180 discovered; 1169 PASS / 11 FAIL, all 11 due to intentionally absent `node_modules/express`; run `npm ci` + `npm test` in CI before publishing binaries |
| PARTIAL-closure audit | PASS | 127 production JS files; 38 repository-verifiable controls; 0 blocking findings |
| Static ASVS audit | PASS | 127 production JS files; 10 reviewed decoder sites |
| Security inventory | PASS | Regenerated for 1.71.35; 959 inventory entries |
| Windows runtime integrity | PASS | 103 entries; 0 stale source-resident hashes after final synchronization; build-time Express entry remains pinned to lockfile `4.22.2` |
| Matrix triage | PASS | 345/345 triaged; 253 PASS; 0 PARTIAL; 0 FAIL; 92 N/A; 0 REVIEW; 0 MANUAL |
| Signed-evidence verifier | PASS | 22 required external requirement IDs; Ed25519 signature; requirement-specific method/predicate; canonical SHA-256; release/origin binding; ≤7-day TTL |
| Isolated crypto provider gate | PASS | L3 self-test requires hardware backing, non-exportable keys, key isolation and isolated encrypt/decrypt/HMAC/sign operations |
| CycloneDX SBOM | PASS | Root component synchronized to Direct-Xfer 1.71.35 |
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

The 1.71.35 packaging pass executed 114 release/security-targeted tests with zero failures or skips, plus both repository-verifiable ASVS audits. The complete source-only suite executed 1180 tests: 1169 passed and the 11 expected real-server/platform-boundary tests failed only because `express` is intentionally absent from the source ZIP and is restored by `npm ci` in CI. The source archive intentionally excludes `node_modules`; real-server tests that require `express` therefore belong to the dependency-backed `npm ci` + `npm test` CI release gate rather than the source-only packaging pass.

## Commands/gates used

```text
node --test test/dependency-security-floors-1.71.8.test.js test/npm-audit-ci-1.71.8.test.js test/docker-scout-go-runtime-hardening-1.70.22.test.js test/windows-latest-deep-audit-1.66.6.test.js test/pwa-mobile-deep-audit-1.64.0.test.js test/signpath-foundation-pipeline-1.71.4.test.js test/project-reconstruction-1.64.0.test.js test/windows-recent-deep-audit-1.66.4.test.js test/windows-modern-dotnet-1.64.10.test.js test/release-maintenance.test.js test/trivy-container-hardening.test.js test/windows-passkey-loopback-1.71.6.test.js test/historical-test-manifest-1.64.0.test.js test/code-scanning-notification-url-hardening.test.js test/codeql-security-regressions-1.70.22.test.js test/oauth-broker-service-1.67.20.test.js test/asvs-l3-partial-closure-1.70.25.test.js test/codacy-security-sarif-filter.test.js test/cleanup-legacy-codacy-analyses.test.js test/github-security-workflows.test.js test/scorecard-sarif-filter.test.js
npm run security:partial-audit
npm run security:static-audit
npm run security:inventory
node -e "const {syncProgram}=require('./scripts/sync-windows-runtime-manifest'); const allowMissing=['node_modules/express/package.json']; syncProgram({write:true,allowMissing}); if(syncProgram({allowMissing}).changed) process.exit(1)"
# CI after npm ci additionally runs: node scripts/sync-windows-runtime-manifest.js --check
```

Production L3 additionally requires:

```text
npm run asvs:l3:evidence:verify
npm run asvs:l3:check
```

Those commands intentionally fail closed when the installation lacks its real HTTPS origin, external hardware-backed crypto provider, approved hardware authenticator policy, ClamAV, egress policy, remote audit sink or signed deployment evidence.
