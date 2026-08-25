# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 audit

Audit date: 2026-08-24  
Target: OWASP Application Security Verification Standard 5.0.0, Level 3  
Repository: `ManixQC/Direct-Xfer`  
Release candidate: Direct-Xfer `1.70.24`  
Baseline input: Direct-Xfer `1.70.23` ASVS-updated archive  
Detailed matrix: `security/ASVS-5.0.0-L3-MATRIX.md`

## Release verification result

The 1.70.24 source release candidate is green on the repository-verifiable ASVS gates performed for this release:

- ASVS regression suite: `node --test test/asvs-l3-*.test.js` — **64 passed, 0 failed, 0 skipped**.
- Full regression suite: `npm test` — **1081 passed, 0 failed, 0 skipped**.
- Static ASVS audit: **PASS** — 124 production JavaScript source files scanned, 10 reviewed decoding sites, dynamic `eval`/`Function`/`RegExp` and legacy parser boundaries rejected by policy.
- Security inventory regenerated for 1.70.24 — **897 inventory entries** across crypto, process launch, outbound communication and filesystem-sensitive operations.
- Windows ServerHost critical runtime manifest: **102 entries, 0 stale hashes** after final synchronization.
- CycloneDX SBOM refreshed to the 1.70.24 root component.

The local `npm audit` registry call could not be completed in the release workspace because DNS resolution for `registry.npmjs.org` returned `EAI_AGAIN`. Dependency vulnerability scanning therefore remains release/deployment evidence under V15.2.1 and must be re-run in connected CI before a formal L3 verification claim. The source release is not represented as having passed a scanner that did not execute.

## Scope and interpretation

ASVS Level 3 includes all applicable Level 1 and Level 2 requirements. This repository audit distinguishes:

- controls that can be verified from source, tests, generated inventories and release artifacts; and
- controls whose truth depends on the deployed environment, such as reverse-proxy request normalization, negotiated TLS ciphers, certificate trust/revocation, ECH, host clock synchronization, actual Vault/KMS/HSM isolation, hardware authenticator provenance, remote SIEM separation and host memory protections.

This document is **not a certification claim**. Direct-Xfer 1.70.24 provides an enforceable `ASVS_L3_MODE` and a deployment preflight, but an installation must also satisfy the manual evidence in `security/ASVS-L3-DEPLOYMENT.md` before it can be described as verified against ASVS L3.

## Requirement status

All **345** ASVS 5.0.0 requirements are individually triaged.

| Status | Count |
|---|---:|
| PASS | 191 |
| PARTIAL | 43 |
| FAIL | 0 |
| N/A | 89 |
| REVIEW | 0 |
| MANUAL | 22 |
| **Total** | **345** |

Status vocabulary:

- **PASS** — repository evidence demonstrates the requirement at the current review depth.
- **PARTIAL** — relevant controls exist, but complete path-by-path assurance or a remaining design condition is not yet proven.
- **FAIL** — a confirmed applicable gap. There are none in this release candidate.
- **N/A** — the relevant technology/functionality is not present in the audited scope.
- **MANUAL** — production/deployment evidence is necessary.
- **REVIEW** — unresolved source review. There are none in this release candidate.

A formal ASVS L3 verification still requires every applicable `PARTIAL` to be closed and every `MANUAL` item to have retained production-like evidence. The zero-FAIL result means no known applicable requirement is deliberately left completely unimplemented in the L3 source profile; it does not convert incomplete assurance into PASS.

## 1.70.24 L3 security profile

`ASVS_L3_MODE=true` changes Direct-Xfer from compatibility behavior to a fail-closed security profile. The profile now includes:

- HTTPS-only application traffic, with only the explicit loopback liveness exception.
- HSTS with `includeSubDomains` and `preload` on the strict HTTPS profile.
- Administrator API access restricted to phishing-resistant passkey-authenticated sessions; password/TOTP sessions are bootstrap/recovery transition sessions only.
- Recent strong-authentication step-up for sensitive administrator mutations.
- Session rotation, absolute/inactivity expiry, per-account concurrency caps, sibling-session invalidation after factor changes, and L3 IP/User-Agent context binding.
- Self-service session listing/revocation with immediate reauthentication requirements and owner/admin controls for other accounts.
- Fresh owner identities that are non-predictable; predictable owner names are rejected when enabling L3.
- WebAuthn username anti-enumeration using normalized phantom work/response shape, UV requirements, origin/RP/challenge binding, and RSA-3072 minimum for RS256 credentials.
- Generated account-reset credentials rather than administrator-selected replacement passwords.
- Public-share independent authentication in L3, so the URL token alone is not sufficient authorization.
- Public upload extension/content correspondence checks, executable/script masquerading rejection, passive-only SVG validation, decoded-image pixel limits, L3 per-sender quota requirements and ClamAV fail-closed behavior.
- Centralized egress allowlisting for security-sensitive HTTP(S), OAuth/broker, storage/backup, SMTP/webhook and remote-audit boundaries; wildcard allowlists are not accepted by the L3 startup gate.
- Redirect refusal on security-sensitive outbound clients, reducing allowlist-to-redirect SSRF bypasses.
- SMTP CR/LF/NUL header rejection and bounded header values.
- Canonical request handling with rejection of duplicated/malformed query encodings before Express in L3.
- Central `Cache-Control: no-store` on authenticated/API responses and cross-site API read/mutation rejection through Fetch Metadata protections.
- Browser private-state purge on explicit L3 logout and prohibition on persistence of E2E destination keys in L3.
- Explicit scrypt parameters for password and DATA_KEY derivation (`N=16384`, `r=8`, `p=1`, 64 MiB maximum memory) and a 128-bit minimum entropy floor for non-guessable capability/recovery secrets.
- TLS managed leaf and Local-CA key generation at RSA-3072, with L3 rejection of weaker managed material rather than compatibility fallback.
- Structured security logging with HMAC-chain audit integrity, Ed25519 proof support, normalized authentication method/result metadata, and centralized logging of both denied and successful L3 administrator authorization decisions.
- Mandatory HTTPS remote audit sink declaration plus deployment evidence that the sink is logically separate.
- L3 startup declarations for isolated secrets/crypto provider, clock synchronization and host memory protection.

## Security documentation and generated evidence

The release contains the following normative/supporting evidence:

- `security/ASVS-L3-SECURITY-SPEC.md` — validation/business rules, browser baseline, authentication assurance, session/authorization policy, public-link model, cryptographic inventory, data classification, egress policy, dependency policy and logging inventory.
- `security/ASVS-L3-DEPLOYMENT.md` — production checklist and deployment-only verification evidence.
- `security/ASVS-5.0.0-L3-MATRIX.md` — requirement-by-requirement status and evidence.
- `security/asvs-static-audit.json` — generated static policy audit.
- `security/security-inventory.json` — generated sensitive-boundary inventory.
- `security/sbom.cdx.json` — CycloneDX component inventory.
- `security/ASVS-L3-RELEASE-EVIDENCE.md` — release-candidate gate results and outstanding manual checks.

## Remaining PARTIAL themes

The 43 remaining `PARTIAL` requirements are not hidden failures. They are intentionally retained where the source has controls but the audit does not yet claim complete assurance across every relevant path. The main themes are:

1. **Complete sink/source tracing** — contextual encoding, DOM sinks, response media types, field-level minimization, object/mass-assignment boundaries and constant-time cryptographic decisions.
2. **Application-wide invariants and concurrency assurance** — numeric ranges, resource lifecycles, deserialization shapes, multi-step business ordering, rollback/transactionality, limited-resource anti-automation and filesystem/shared-state TOCTOU/deadlock/fairness review.
3. **Authorization completeness** — object and field-level authorization maps are documented and strongly implemented in high-risk domains, but every endpoint/DTO has not been independently traced to closure.
4. **Integration assurance** — same-user-agent binding of remote-browser OAuth broker transactions and security properties of administrator-selected external storage transports remain partly environment/provider dependent.
5. **Cryptographic lifecycle depth** — constant-time/oracle review and in-use plaintext lifetime/zeroization guarantees remain broader than what JavaScript/Node can prove from source alone.
6. **Data lifecycle completeness** — metadata stripping, retention classification and minimum-field response review are not yet proven for every user-submitted file/record type.
7. **Logging/error coverage** — the central audit surface is materially stronger, but exhaustive logging of every validation/business/anti-automation bypass and every security-control failure has not been independently traced.
8. **External service degradation** — timeouts, bounded queues and retries are present widely, but application-wide circuit-breaker/failure-mode assurance is not complete.

## Deployment-only MANUAL evidence

The 22 `MANUAL` rows principally cover:

- HSTS preload registration on a stable public domain.
- Reverse-proxy canonical HTTP→HTTPS behavior, trusted proxy headers, request-smuggling defenses and HTTP/2/3 validation.
- Hardware-backed WebAuthn authenticator evidence and lost-factor identity-proofing procedures.
- Forward-secret TLS key exchange/cipher suites, OCSP/revocation, public certificate trust and ECH where applicable.
- Host/firewall enforcement of the egress allowlist.
- Actual Vault/KMS/HSM/isolated-vault custody and isolation boundaries.
- Host memory protections, core-dump/swap policy and synchronized time.
- Release dependency/container scanner evidence.
- Immutability/retention and logical separation of the remote security-log platform.

The application startup preflight validates declarations that can be checked locally, but it deliberately cannot fabricate evidence about these external systems.

## Dependency review note

The 1.70.24 direct runtime dependencies are pinned by `package-lock.json`. Current direct versions include Express 4.22.2, node-forge 1.4.0, Nodemailer 9.0.3, Archiver 8.0.0, QRCode 1.5.4 and web-push 3.6.7. The release keeps node-forge at 1.4.0, which is the patched line for several high-severity 2026 forge advisories affecting earlier versions, and Nodemailer at 9.0.3, after the 2026 fixes for multiple 8.x/9.0.0 issues. This spot review is not a substitute for a complete dependency scanner over the transitive graph; V15.2.1 remains `MANUAL` until connected CI scan evidence is retained.

## Final release gates

Source/repository gates completed for 1.70.24:

- [x] package and lockfile version are 1.70.24.
- [x] ASVS regression suite green (64/64).
- [x] Full suite green (1081/1081).
- [x] Static ASVS audit green.
- [x] Security inventory regenerated.
- [x] Windows runtime integrity manifest synchronized and rechecked.
- [x] Matrix has 0 FAIL and 0 REVIEW.
- [x] ASVS audit/matrix updated for the exact release candidate.
- [x] SBOM root component synchronized to 1.70.24.
- [x] Release archive and SHA-256 generated as companion artifacts.

Deployment/verification gates still required before claiming a specific installation is **verified ASVS L3**:

- [ ] Resolve the remaining 43 source-assurance `PARTIAL` rows or obtain sufficient independent verification evidence to promote them.
- [ ] Review and retain evidence for all 22 `MANUAL` rows.
- [ ] Independently review all 89 `N/A` decisions.
- [ ] Re-run dependency/container security scanning in connected CI and retain the report.
- [ ] Complete a production-like TLS/proxy/time/secrets/logging preflight.
- [ ] Perform a focused independent penetration test of authentication, authorization, public links/capabilities, upload/download, OAuth broker, PWA, recovery and administrator operations.

Reference requirement source: OWASP ASVS 5.0.0 stable release (`v5.0.0_release`).
