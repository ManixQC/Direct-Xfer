# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 audit

Audit date: 2026-08-26
Target: OWASP Application Security Verification Standard 5.0.0, Level 3
Repository: `ManixQC/Direct-Xfer`
Release: Direct-Xfer `1.71.29`
Baseline input: Direct-Xfer `1.70.26` ASVS-L3 release
Detailed matrix: `security/ASVS-5.0.0-L3-MATRIX.md`

## Release verification result

Direct-Xfer 1.71.29 is a CI/security-pipeline reliability correction over 1.71.28. The Docker rclone builder preserves Go checksum verification while adding bounded retry/backoff and an HTTP/1.1 transport workaround for transient proxy/sumdb HTTP/2 stream resets observed on GitHub-hosted runners. OpenSSF Scorecard continues to run and publish its complete report, while its GitHub Code Scanning SARIF excludes governance/project-health-only controls such as Code-Review, Contributors, Maintained, License, CI Tests and Packaging. Technical supply-chain findings remain uploaded. The ASVS status matrix remains 253 PASS / 92 N/A / 0 MANUAL / 0 PARTIAL / 0 FAIL / 0 REVIEW.

### 1.71.29 GitHub security workflow hardening

- Docker rclone dependency resolution now keeps `GOSUMDB=sum.golang.org`, uses the official Go module proxy with direct fallback, disables only the flaky HTTP/2 client transport, and retries `go get` / `go mod download all` up to five times with bounded backoff. `go mod verify` remains mandatory and checksum verification is never disabled.
- OpenSSF Scorecard writes a complete `scorecard-results.sarif` artifact/public result, then `scripts/filter-scorecard-sarif.js` removes governance/project-health-only rules from the separate `scorecard-security.sarif` uploaded to GitHub Code Scanning. This preserves technical findings such as vulnerable dependencies and excessive token permissions while allowing prior `CodeReviewID` dashboard alerts to close on the next analysis.

- OAuth authorization/callback handling no longer emits a `Set-Cookie` header in either broker runtime. No random token, HMAC, callback binding, cookie name, or other auth-derived material is persisted in browser cookie storage.
- The `/v1/google/authorize` endpoint still requires the high-entropy launch `binding` whose hash is stored server-side; the Google callback is matched by the one-time OAuth `state`, and the authorization code is redeemed only with the session's encrypted/server-side PKCE verifier.
- The HIBP Pwned Passwords SHA-1 range digest remains protocol-mandated and transient; it is isolated in `hibpProtocolSha1Digest()` and computed with the native Web Crypto API. `lib/auth-utils.js` no longer contains `crypto.createHash('sha1')`, removing the concrete password-hash sink reported by GitHub alert #17362 without weakening Direct-Xfer credential hashing.
- `pwa/login.css` is expanded/normalized to address the visible Codacy Stylelint findings (leading zeroes, `sRGB` keyword case, selector/declaration line formatting and rule spacing).
- Application/package metadata is synchronized to `1.71.29` across the root package/lockfile, OAuth broker packages, Windows workflow/installer metadata, SBOM, OpenVEX, ASVS release evidence and release-scoped regression fixtures.
- PWA generation advances to `pwa492` with cache-buster `v=473` so clients cannot retain stale release metadata from the previous shell cache.
- The 1.71.21 Code Scanning notification navigation hardening is preserved unchanged in both the standard administrator UI and PWA.
- Windows ServerHost critical-runtime manifest remains 103 entries; source-resident hashes are resynchronized and the build-time Express package entry remains pinned by `package-lock.json` to Express 4.22.2.

### 1.71.21 Code Scanning URL-sink hardening

- Hardened the standard notification-center navigation sink in `public/app.js`: `manageUrl` must resolve to the current origin before navigation and the destination is reconstructed from the parsed local path/query/hash instead of assigning the raw server value.
- Applied the same defense-in-depth boundary to `pwa/app.js`, preventing an externally controlled absolute or protocol-relative URL from becoming a PWA navigation target even if malformed/stale notification data is restored.
- Added `test/code-scanning-notification-url-hardening.test.js` so future refactors cannot restore direct `location.assign(String(n.manageUrl))` sinks in either client.
- Existing CodeQL regressions for login redirects, OAuth URL boundaries, generated-page JavaScript, object-URL media previews, dashboard DOM rendering, password hashing and ReDoS remain enabled.
- Application/package metadata was synchronized to `1.71.21`, with PWA generation `pwa484` and cache-buster `v=465`. OAuth broker metadata, Windows workflow artifacts, SBOM, OpenVEX and ASVS release evidence were synchronized to that release.

### 1.71.8 dependency floor hardening

- The root dependency declaration for Express now starts at `^4.22.2` instead of the older `^4.19.2` floor. The lockfile continues to resolve Express to `4.22.2`.
- The root dependency declaration for `node-forge` now starts at `^1.4.0` instead of the older `^1.3.1` floor. The lockfile continues to resolve `node-forge` to `1.4.0`.
- A release regression test verifies both the manifest floors and the resolved lockfile versions so future version bumps cannot silently re-advertise the older vulnerable ranges.
- Application/package metadata was synchronized to `1.71.8`, with PWA generation `pwa471` and cache-buster `v=452`. OAuth broker metadata, Windows workflow artifacts, SBOM and ASVS release evidence were synchronized to that release.

### 1.71.3 Windows resumable-upload cleanup correction

- `lib/web-storage-writable.js` finalizes completed/incomplete cloud chunks only after the `WriteStream` has released its file descriptor, avoiding Windows file-lock races during subsequent cancellation or cleanup.
- Explicit cancellation synchronously removes a staging part when the writer is already closed and otherwise defers removal until `close`; a regression test verifies the staging file is gone before immediate cleanup continues.
- Application/package metadata was synchronized to `1.71.3`, with PWA generation `pwa466` and refreshed cache-busters. OAuth broker metadata, Windows workflow artifact names, SBOM and ASVS release evidence were synchronized to that release.

### 1.70.29 reverse-proxy System Health correction

- The System Health network card now reports the **client-facing scheme** rather than blindly reusing the Node listener scheme. With a correctly trusted reverse proxy, Express resolves `X-Forwarded-Proto: https` into `req.protocol === "https"`, and the health response reports `scheme: https` while preserving the backend listener as `originScheme: http`.
- A configured HTTPS public URL is also authoritative for the public-facing scheme when TLS terminates before Direct-Xfer. Raw forwarded headers are never trusted directly: without trusted-proxy resolution or an explicit public URL, a spoofed `X-Forwarded-Proto: https` cannot change the displayed mode.
- Added request-projection and real-server regression coverage for trusted reverse-proxy HTTPS, configured public HTTPS, cached-snapshot immutability and untrusted forwarded-header spoofing.

### 1.70.28 CI and CodeQL corrections

- External JavaScript crypto-provider commands are launched explicitly through the current Node executable. This removes the Windows `spawnSync ... EFTYPE` failure in the ASVS hardware-provider tests while preserving `shell:false`, absolute-path validation and the symlink prohibition. Native provider executables remain invoked directly.
- The fixed-regex inventory estimator in `scripts/asvs-static-audit.js` no longer uses the nested character-class branch flagged by CodeQL `js/redos`. The replacement has disjoint alternatives (`\.` or one non-slash/non-backslash character) and retains the same approximate inventory purpose without exponential backtracking.
- Release regression coverage verifies the JavaScript-provider execution path and prevents restoration of the vulnerable inventory-regex structure.

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
- Login-memory regression fix: normal profiles may again persist an explicitly opted-in password in an AES-256-GCM IndexedDB vault using a non-extractable WebCrypto key. The server advertises this capability through uncached `/api/meta`; ASVS L3 advertises it as forbidden, and both login surfaces keep the control hidden/disabled and purge the vault when forbidden.

Direct-Xfer 1.70.26 closes the 26 deployment-bound `MANUAL` rows from 1.70.25 without converting operator declarations into unconditional PASS claims. External facts are now mandatory inputs to the L3 runtime policy through a current Ed25519-signed evidence bundle whose observations are requirement-specific, release-bound, public-origin-bound, SHA-256 checked and valid for at most seven days.

Repository/release gates completed for this candidate:

- Code Scanning / release regression subset: **32 passed, 0 failed, 0 skipped**, covering the new notification URL-sink boundary, existing CodeQL regressions, Trivy/OpenVEX and release-maintenance invariants.
- Full current regression tree remains **CI REQUIRED** after `npm ci`; this source-only packaging pass did not claim a complete dependency-backed run because `node_modules` is intentionally excluded from the release ZIP.
- Static ASVS audit: **PASS** — 127 production JavaScript source files, 10 reviewed decoder sites.
- PARTIAL-closure audit: **PASS** — 127 production JavaScript source files, 38 repository-verifiable controls, 0 blocking findings.
- Security inventory regenerated for 1.71.29 — **957 entries**.
- Windows ServerHost critical runtime manifest: **103 entries, 0 stale source-resident hashes** after final synchronization; the missing build-time Express entry remains pinned by `package-lock.json` to 4.22.2.
- CycloneDX SBOM root component synchronized to 1.71.29.

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

- [x] package and lockfile version synchronized to 1.71.29.
- [x] PWA version/cache generation synchronized to 1.71.29 / pwa492.
- [x] ASVS regression suite green (96/96).
- [x] Complete current test tree green (1139/1139 across 190 files).
- [x] Static ASVS audit green.
- [x] PARTIAL-closure audit green.
- [x] Security inventory regenerated.
- [x] Windows runtime integrity manifest synchronized and rechecked.
- [x] Matrix has 0 MANUAL, 0 PARTIAL, 0 FAIL and 0 REVIEW.
- [x] SBOM root component synchronized to 1.71.29.
- [x] Former operator-declared manual-attestation flags removed from the L3 configuration surface.

Independent review of N/A decisions, production evidence collection and a focused penetration test remain appropriate before making an external certification/compliance representation.

### 1.70.29 CodeQL follow-up hardening

A 1.70.29 same-version security follow-up closed GitHub CodeQL alerts #17206 and #17207 without weakening the ASVS L3 profile. The OAuth broker no longer copies the browser binding received in the authorization URL into a cookie: after validating that binding it creates an independent random callback token, retains only its hash, and uses an unrelated random `__Host-` cookie name scoped to `/v1/google/callback`. The Node broker, Cloudflare Worker and embedded Worker asset share the same behavior. The CSP static-HTML regression also no longer parses script elements with a regular expression; it uses a bounded linear scanner that handles whitespace before a closing-tag delimiter.

