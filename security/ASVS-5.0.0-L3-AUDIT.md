# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 audit

Audit date: 2026-08-25  
Target: OWASP Application Security Verification Standard 5.0.0, Level 3  
Repository: `ManixQC/Direct-Xfer`  
Release candidate: Direct-Xfer `1.70.27`  
Baseline input: Direct-Xfer `1.70.26` ASVS-L3 release  
Detailed matrix: `security/ASVS-5.0.0-L3-MATRIX.md`

## Release verification result

Direct-Xfer 1.70.27 is a deep corrective audit of the 1.70.26 ASVS-L3 closure. The status matrix remains 253 PASS / 92 N/A / 0 MANUAL / 0 PARTIAL / 0 FAIL / 0 REVIEW, but several implementation and upgrade-path defects were fixed before retaining those statuses.

### 1.70.27 deep-audit corrections

- L3 `shares.json` now **fails closed unless it is an external `dxenc:2` envelope**. Plain JSON and legacy `dxenc:1` are no longer silently accepted by the L3 runtime.
- Added offline `asvs:l3:migrate-state` and `asvs:l3:migrate-audit` commands for 1.70.25 upgrades. The audit migration verifies the entire legacy HMAC chain/head before re-signing with the external provider and updates the encrypted state audit anchor transactionally.
- Fixed a 1.70.26 regression where L3 backups, search indexes and OCR caches could be written in plaintext because encryption was still keyed off the now-forbidden local `DATA_KEY`. L3 backups are always `dxenc:2`; plaintext L3 backups are rejected, and plaintext search/OCR caches are deleted and rebuilt encrypted. `asvs:l3:migrate-backup` converts 1.70.26 plaintext backups or legacy `dxenc:1` backups offline.
- Corrected system-health/settings/diagnostics encryption reporting so an external L3 provider is reported as encrypted instead of `false`/`PLAINTEXT`.
- Evidence freshness now uses the verification clock: observations and bundle generation may not be older than seven days, `expiresAt` must follow `generatedAt`, and the signer rejects non-canonical HTTPS origins before signing.
- `TRUST_PROXY` now validates real IPv4/IPv6 literals and CIDR prefix bounds and rejects global `/0` trust in L3.
- External crypto commands may not be symlinks; historical data-key decrypt operations pass the envelope key ID to support provider-side rotation.
- WebAuthn hardware attestation now loads pinned root certificates, supports the standards-compliant case where `x5c` omits the root, verifies certificate validity/CA chaining, validates leaf key/algorithm strength and no longer treats attacker-controlled client transport strings as hardware proof.
- CSP first-paint hardening: the administrator shell no longer embeds an executable inline theme bootstrap. `public/theme-init.js` is served from the same origin, covered by the Windows critical-runtime manifest, and a regression test rejects executable inline scripts in static public/PWA HTML.

Direct-Xfer 1.70.26 closes the 26 deployment-bound `MANUAL` rows from 1.70.25 without converting operator declarations into unconditional PASS claims. External facts are now mandatory inputs to the L3 runtime policy through a current Ed25519-signed evidence bundle whose observations are requirement-specific, release-bound, public-origin-bound, SHA-256 checked and valid for at most seven days.

Repository/release gates completed for this candidate:

- ASVS regression suite: `node --test test/asvs-l3-*.test.js` — **96 passed, 0 failed, 0 skipped**.
- Full current regression tree: **1115 passed, 0 failed, 0 skipped across all 183 `test/*.test.js` files**, verified in isolated groups. The monolithic Node test-runner invocation exceeds the constrained release harness execution window because several integration tests keep process resources alive after reporting; no individual or grouped test failure was observed.
- Static ASVS audit: **PASS** — 127 production JavaScript source files, 13 reviewed decoder sites.
- PARTIAL-closure audit: **PASS** — 127 production JavaScript source files, 38 repository-verifiable controls, 0 blocking findings.
- Security inventory regenerated for 1.70.27 — **944 entries**.
- Windows ServerHost critical runtime manifest: **103 entries, 0 stale hashes** after final synchronization.
- CycloneDX SBOM root component synchronized to 1.70.27.

This document is an implementation/evidence audit, not a third-party certification. A production installation can operate in `ASVS_L3_MODE=true` only while all mandatory runtime controls and the signed deployment evidence are valid.

## Requirement status

All **345** ASVS 5.0.0 requirements are individually triaged.

| Status | Count |
|---|---:|
| PASS | 253 |
| PARTIAL | 0 |
| FAIL | 0 |
| N/A | 92 |
| REVIEW | 0 |
| MANUAL | 0 |
| **Total** | **345** |

`PASS` in this matrix means either repository/runtime evidence directly enforces the requirement, or the L3 profile fails closed unless a machine-validated signed deployment observation satisfies the requirement-specific predicate. It does **not** mean an arbitrary deployment is automatically compliant. `N/A` remains subject to independent scope review.

## 1.70.26 closure of the former MANUAL rows

Twenty-four former `MANUAL` requirements are now enforced by code plus signed deployment evidence; two are `N/A` because the relevant application mechanism is deliberately absent.

### Web edge and TLS

V3.7.4, V4.1.2, V4.1.3, V4.2.1, V4.2.3, V4.2.4, V12.1.2, V12.1.4, V12.1.5 and V12.2.2 require active, signed observations for HSTS preload, HTTP→HTTPS behavior, proxy-header authenticity, request-smuggling defenses, HTTP/2/3 header handling, forward-secret recommended TLS suites, revocation handling, ECH and public certificate/hostname trust.

L3 forbids local/private-key TLS termination inside Direct-Xfer. `TRUST_PROXY` must be an explicit IP/CIDR list; boolean and hop-count trust are rejected. Legacy Local-CA/private-key material cannot be restored while L3 is active.

### Hardware authentication and recovery

V6.3.3 and V8.4.2 are closed by direct WebAuthn attestation, configured hardware AAGUID allowlists, pinned attestation-root SHA-256 fingerprints, UV, non-backup/non-syncable credentials and continuous revalidation of stored hardware metadata.

V6.4.4 is `N/A`: after an approved hardware passkey has been enrolled in L3, Direct-Xfer exposes no weaker lost-factor identity-recovery path. Factor management remains locked behind recent hardware-passkey authentication and the last approved hardware passkey cannot be removed through the application.

### Cryptographic isolation

V13.3.1, V13.3.2 and V13.3.3 are closed by an external hardware-backed crypto provider boundary plus signed provider evidence. L3 requires non-exportable keys and opaque handles; persistent-state encryption/decryption, audit HMAC/signing and runtime HMAC operations are delegated outside the Node process. Local `DATA_KEY`, `AUDIT_HMAC_KEY` and audit signing private keys are forbidden in L3.

TOTP is disabled in L3, built-in S3 SigV4 signing is rejected in L3, and local TLS private-key use is rejected so long-lived secret-key operations do not silently fall back into the application process.

V11.6.2 is `N/A`: Direct-Xfer implements no application-layer cryptographic key-agreement protocol. TLS key establishment is owned by the verified external edge and WebAuthn is signature verification rather than application key exchange.

### Host, backends, egress, scanning, time and logs

V11.7.1, V11.7.2, V13.2.1, V13.2.2, V13.2.5, V15.2.1, V16.2.2, V16.4.2 and V16.4.3 require signed observations for host memory/process protection, in-use plaintext minimization, authenticated/least-privilege backends, default-deny host/network egress, dependency/container scanning with zero High/Critical findings, clock synchronization within ±1000 ms and immutable/retained/logically separate authenticated remote logging.

The former operator booleans (`ASVS_L3_CLOCK_SYNCED`, `ASVS_L3_MEMORY_PROTECTED`, backend/secret least-privilege declarations and in-use-data declarations) have been removed from the configuration surface and cannot satisfy L3 prerequisites.

## Signed evidence boundary

The verifier is implemented by `lib/server/asvs-l3-evidence.js`. The signing private key belongs to an independent audit/CI environment and must not be mounted into Direct-Xfer. The runtime accepts only the configured Ed25519 public verification key.

The bundle must contain all 22 externally verifiable requirement IDs, each with the required collection method, a structured observation satisfying the code predicate, a matching canonical SHA-256 digest and a valid observation timestamp. The bundle itself must match the exact current release and exact HTTPS `PUBLIC_URL` origin and expires after at most seven days.

Forged, stale, duplicated, wrong-method, wrong-release, wrong-origin, incomplete or predicate-failing evidence prevents L3 startup.

## Security artifacts

- `security/ASVS-L3-SECURITY-SPEC.md` — normative application security policy.
- `security/ASVS-L3-DEPLOYMENT.md` — L3 deployment architecture and evidence requirements.
- `security/ASVS-L3-EVIDENCE.md` — signed evidence schema and the 22 external predicates.
- `security/ASVS-5.0.0-L3-MATRIX.md` — all 345 requirements and their evidence mapping.
- `security/asvs-static-audit.json` — generated static-policy result.
- `security/asvs-l3-partial-audit.json` — generated repository-verifiable closure result.
- `security/security-inventory.json` — generated security-sensitive operation inventory.
- `security/sbom.cdx.json` — CycloneDX SBOM.
- `security/ASVS-L3-RELEASE-EVIDENCE.md` — exact release gate summary.

## Dependency/security-scan boundary

The direct dependency graph remains lockfile-pinned. V15.2.1 is no longer an operator checkbox: L3 startup requires release-bound signed evidence that both dependency and container scans passed with zero High/Critical findings. The current isolated build environment cannot contact the npm registry, so this source package does not pretend to contain a connected-registry scan result. A deployment cannot pass the V15.2.1 evidence predicate without a real scan observation signed for the exact current release.

## Final release gates

- [x] package and lockfile version synchronized to 1.70.26.
- [x] PWA version/cache generation synchronized to 1.70.26 / pwa459.
- [x] ASVS regression suite green (96/96).
- [x] Complete current test tree green (1104/1104 across 181 files in six isolated groups).
- [x] Static ASVS audit green.
- [x] PARTIAL-closure audit green.
- [x] Security inventory regenerated.
- [x] Windows runtime integrity manifest synchronized and rechecked.
- [x] Matrix has 0 MANUAL, 0 PARTIAL, 0 FAIL and 0 REVIEW.
- [x] SBOM root component synchronized to 1.70.27.
- [x] Former operator-declared manual-attestation flags removed from the L3 configuration surface.

Independent review of N/A decisions, production evidence collection and a focused penetration test remain appropriate before making an external certification/compliance representation.
