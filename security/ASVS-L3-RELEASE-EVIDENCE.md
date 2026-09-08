# Direct-Xfer 1.71.46 — ASVS L3 release evidence

> 1.71.46 is a targeted dependency/container-security maintenance release. Express remains on 4.22.2; npm `overrides` forces transitive `qs` to 6.16.0, closing CVE-2026-82562 / GHSA-x5fp-wj9c-mxmx and CVE-2026-82417 / GHSA-4mjr-xmp4-gh2g without an Express 5 migration. Docker rclone is pinned to security release v1.75.1, built with Go 1.26.6 and verified `golang.org/x/crypto` v0.56.0, closing CVE-2026-56854. Windows optional rclone uses the same v1.75.1 release. The 1.71.42 SignPath/CSP/ZAP/provenance controls remain the audited baseline.


Release date: 2026-09-08
Profile: `ASVS_L3_MODE=true`

## Source/release gates

| Gate | Result | Evidence |
|---|---|---|
| Release/dependency/container/version regression tests | PASS | 98 passed, 0 failed, 0 skipped in the expanded 1.71.46 maintenance gate, including both qs vulnerability regressions, rclone/Go/x-crypto pins, the reviewed GitHub Actions dependency pins, Windows optional-rclone checksum/version synchronization, lock consistency, Windows/SignPath version synchronization, PWA cache synchronization and OAuth broker release parity |
| Complete current regression tree | CI REQUIRED | The source archive omits generated `node_modules`; run `npm ci` + `npm test` in CI before publishing binaries. The 1.71.46 ASVS subset separately reports 94/96 because two pre-existing dependency-unrelated regressions remain outside this patch. |
| PARTIAL-closure audit | PASS | 127 production JS files; 38 repository-verifiable controls; 0 blocking findings |
| Static ASVS audit | PASS | 127 production JS files; 10 reviewed decoder sites; 4538 fixed-regex literals estimated |
| Security inventory | PASS | Regenerated for 1.71.46; 983 inventory entries |
| Windows runtime integrity | PASS | 103 entries; 0 stale source-resident hashes after final synchronization; build-time Express entry remains pinned to lockfile `4.22.2` |
| Matrix triage | PASS | 345/345 triaged; 253 PASS; 0 PARTIAL; 0 FAIL; 92 N/A; 0 REVIEW; 0 MANUAL |
| Signed-evidence verifier | PASS | 22 required external requirement IDs; Ed25519 signature; requirement-specific method/predicate; canonical SHA-256; release/origin binding; ≤7-day TTL |
| Isolated crypto provider gate | PASS | L3 self-test requires hardware backing, non-exportable keys, key isolation and isolated encrypt/decrypt/HMAC/sign operations |
| CycloneDX SBOM + provenance | PASS | Root component synchronized to Direct-Xfer 1.71.46 and transitive qs synchronized to 6.16.0; Windows provenance job validates the SBOM, emits build-provenance attestations for launcher, ServerHost, installer, the SHA-256 release manifest and an exact `git archive` source package, then binds the npm/source CycloneDX SBOM only to that source package so the SBOM subject accurately matches what it describes |
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

The expanded 1.71.46 maintenance gate executed 98 targeted release/dependency/container/version tests with zero failures or skips, including a regression that locks the reviewed Dependabot GitHub Actions SHAs. Express stays at 4.22.2 and `qs` is forced to 6.16.0; dependency-backed CI exercises both the bracket-key/comma `arrayLimit` regression and the attacker-controlled `constructor.isBuffer` parse→stringify regression. Docker rclone is pinned to v1.75.1 / Go 1.26.6 and the Dockerfile verifies embedded `golang.org/x/crypto` v0.56.0 plus `golang.org/x/image` v0.45.0 before publishing the binary; Windows optional rclone is pinned to the same release and verified archive hash. Static and PARTIAL audits remain green. The ASVS-specific suite executed 96 tests: 94 passed and the same two pre-existing, dependency-unrelated source regressions failed. A full dependency-backed `npm ci` + `npm test` run remains required in CI before publishing binaries.

## Commands/gates used

```text
node --test test/github-actions-dependency-pins-1.71.46.test.js test/qs-array-limit-security-1.71.46.test.js test/dependency-security-floors-1.71.8.test.js test/release-maintenance.test.js test/signpath-foundation-pipeline-1.71.4.test.js test/windows-latest-deep-audit-1.66.6.test.js test/windows-recent-deep-audit-1.66.4.test.js test/project-reconstruction-1.64.0.test.js test/oauth-broker-public-deep-audit-1.67.25.test.js test/pwa-mobile-deep-audit-1.64.0.test.js test/pwa-system-health-bottom-nav-1.64.4.test.js test/docker-scout-go-runtime-hardening-1.70.22.test.js test/docker-scout-go-runtime-hardening-deep-audit-1.70.22.test.js test/windows-modern-dotnet-1.64.10.test.js
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
