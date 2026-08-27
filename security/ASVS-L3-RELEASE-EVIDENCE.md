# Direct-Xfer 1.71.37 — ASVS L3 release evidence

> 1.71.37 hardens the OWASP ZAP DAST integration introduced in the previous release. The workflow now satisfies actionlint/ShellCheck by separating ADMIN_PASSWORD assignment/export and removing the unused health-loop counter, and every Medium/High ZAP SARIF result is anchored to the stable repository artifact `security/zap-dast-target.md` so GitHub Code Scanning accepts the upload while retaining the actual observed HTTP URL in the finding message. The Medium/High gate now runs with `if: always()` so a SARIF transport failure cannot hide the underlying DAST verdict. Existing ZAP immutable pins, Artifact Attestations for Windows/SBOM/SHA-256 provenance, Codacy filtering/cleanup, CodeQL, Trivy, Scorecard, zizmor, SignPath and least-privilege token scopes remain active. PWA advances to pwa500 / cache-buster v=481.

Release date: 2026-08-26
Profile: `ASVS_L3_MODE=true`

## Source/release gates

| Gate | Result | Evidence |
|---|---|---|
| Release-targeted regression tests | PASS | 145 passed, 0 failed, 0 skipped, including OWASP ZAP DAST/SARIF gating, extended artifact provenance, Codacy legacy-analysis API cleanup, zizmor template-injection regression coverage, Docker Go-network resilience, Scorecard filtering, CodeQL/OAuth regressions, dependency floors, Windows metadata and SignPath invariants |
| Complete current regression tree | CI REQUIRED | Source-only run: 1185 discovered; 1174 PASS / 11 FAIL, all 11 due to intentionally absent `node_modules/express`; run `npm ci` + `npm test` in CI before publishing binaries |
| PARTIAL-closure audit | PASS | 127 production JS files; 38 repository-verifiable controls; 0 blocking findings |
| Static ASVS audit | PASS | 127 production JS files; 10 reviewed decoder sites |
| Security inventory | PASS | Regenerated for 1.71.37; 960 inventory entries |
| Windows runtime integrity | PASS | 103 entries; 0 stale source-resident hashes after final synchronization; build-time Express entry remains pinned to lockfile `4.22.2` |
| Matrix triage | PASS | 345/345 triaged; 253 PASS; 0 PARTIAL; 0 FAIL; 92 N/A; 0 REVIEW; 0 MANUAL |
| Signed-evidence verifier | PASS | 22 required external requirement IDs; Ed25519 signature; requirement-specific method/predicate; canonical SHA-256; release/origin binding; ≤7-day TTL |
| Isolated crypto provider gate | PASS | L3 self-test requires hardware backing, non-exportable keys, key isolation and isolated encrypt/decrypt/HMAC/sign operations |
| CycloneDX SBOM + provenance | PASS | Root component synchronized to Direct-Xfer 1.71.37; Windows provenance job validates/attests the SBOM and a four-subject SHA-256 release manifest alongside launcher, ServerHost and installer provenance |
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

The 1.71.37 packaging pass executed 145 release/security-targeted tests with zero failures or skips, including the ZAP DAST/SARIF and extended artifact-attestation regressions, plus both repository-verifiable ASVS audits. The complete source-only suite executed 1185 tests: 1174 passed and the 11 expected real-server/platform-boundary tests failed only because `express` is intentionally absent from the source ZIP and is restored by `npm ci` in CI. The source archive intentionally excludes `node_modules`; real-server tests that require `express` therefore belong to the dependency-backed `npm ci` + `npm test` CI release gate rather than the source-only packaging pass.

## Commands/gates used

```text
node --test test/dependency-security-floors-1.71.8.test.js test/npm-audit-ci-1.71.8.test.js test/docker-scout-go-runtime-hardening-1.70.22.test.js test/windows-latest-deep-audit-1.66.6.test.js test/pwa-mobile-deep-audit-1.64.0.test.js test/signpath-foundation-pipeline-1.71.4.test.js test/project-reconstruction-1.64.0.test.js test/windows-recent-deep-audit-1.66.4.test.js test/windows-modern-dotnet-1.64.10.test.js test/release-maintenance.test.js test/trivy-container-hardening.test.js test/windows-passkey-loopback-1.71.6.test.js test/historical-test-manifest-1.64.0.test.js test/code-scanning-notification-url-hardening.test.js test/codeql-security-regressions-1.70.22.test.js test/oauth-broker-service-1.67.20.test.js test/asvs-l3-partial-closure-1.70.25.test.js test/codacy-security-sarif-filter.test.js test/cleanup-legacy-codacy-analyses.test.js test/github-security-workflows.test.js test/scorecard-sarif-filter.test.js test/zap-security-workflow.test.js
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
