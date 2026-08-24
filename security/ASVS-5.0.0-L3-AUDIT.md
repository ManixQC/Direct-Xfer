# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 audit

Audit baseline date: 2026-08-24  
Target: OWASP Application Security Verification Standard 5.0.0, Level 3  
Repository: `ManixQC/Direct-Xfer`  
Initial baseline commit: `3d2c0b5c668c9136a05490b25b76f4166a5940e8`  
Requirement matrix completion head: `e97405717a2cdfc1e806354e3786b477c983b12f`

## Scope and interpretation

Level 3 includes all applicable Level 1 and Level 2 requirements. The repository/static review can verify implementation properties, but deployment controls such as reverse-proxy behavior, TLS cipher negotiation, HSTS preload, OCSP/ECH, host time synchronization, HSM-backed key custody and remote log collection require operational evidence.

The detailed working matrix is `security/ASVS-5.0.0-L3-MATRIX.md`.

**All 345 ASVS 5.0.0 requirements have now been individually triaged.** This is not a certification claim. `PASS` is repository evidence at the current review depth; `REVIEW` and `MANUAL` remain open verification work, and every `N/A` decision must be independently reviewed before claiming Level 3.

## Requirement status

| Status | Count |
|---|---:|
| PASS | 88 |
| PARTIAL | 85 |
| FAIL | 57 |
| N/A | 86 |
| REVIEW | 18 |
| MANUAL | 11 |
| **Total** | **345** |

Status vocabulary:

- **PASS** — verified from repository evidence at the current review depth.
- **PARTIAL** — a relevant control exists but does not satisfy the complete requirement or every path.
- **FAIL** — an applicable confirmed gap exists.
- **N/A** — the relevant technology/functionality is not used in the audited scope.
- **MANUAL** — production/deployment evidence is required.
- **REVIEW** — deeper source/path verification is still required.

## Chapter summary

| Chapter | Area | Current status | Main remaining blockers |
|---|---|---|---|
| V1 | Encoding and Sanitization | PARTIAL | CSV leading-NUL formula injection, remaining sink/canonicalization/ReDoS/SMTP reviews. |
| V2 | Validation and Business Logic | PARTIAL | Missing formal validation/business-limit documentation and incomplete transaction/anti-automation mapping. |
| V3 | Web Frontend Security | PARTIAL | Cookie prefixes/Secure profile, HSTS subdomains/preload, CSP reporting, authenticated-resource isolation and external redirect confirmation. |
| V4 | API and Web Service | PARTIAL/MANUAL | No global HTTP method allowlist; proxy/request-smuggling and HTTP/2/3 behavior need deployment evidence. |
| V5 | File Handling | PARTIAL | Universal content/type validation, per-user storage quotas and decoded-image pixel caps; ClamAV remains optional. |
| V6 | Authentication | PARTIAL | L3 hardware-backed phishing-resistant MFA not mandatory; common/breached-password screening, enumeration and recovery/reset lifecycle gaps remain. |
| V7 | Session Management | PARTIAL | Idle/absolute expiry are fixed; factor-change session invalidation, self-service session control and step-up re-authentication remain. |
| V8 | Authorization | PARTIAL | Missing formal function/data/field/context policy and adaptive/continuous authorization controls. |
| V9 | Self-contained Tokens | N/A | No application JWT/self-contained session/token format is used; N/A rationale still needs independent review. |
| V10 | OAuth and OIDC | PARTIAL/N/A | Google client flow has state+PKCE and least-privilege scopes; same-session transaction-binding assurance needs stronger documentation/evidence. Authorization-server/OIDC requirements are N/A to Direct-Xfer's role. |
| V11 | Cryptography | PARTIAL | Formal crypto inventory/lifecycle/PQC plan absent; RSA-2048 remains in some paths; HSM/in-use protections absent. |
| V12 | Secure Communication | PARTIAL/MANUAL | TLS version/cipher/OCSP/ECH/public-cert properties depend on deployment; plain LAN HTTP remains intentionally supported. |
| V13 | Configuration | PARTIAL | No complete egress/resource/secrets policy; L3 HSM/isolated crypto module absent; unused HTTP methods not explicitly blocked. |
| V14 | Data Protection | PARTIAL | No formal data classification; capability tokens appear in share URLs; optional login vault stores reusable encrypted passwords in IndexedDB. |
| V15 | Secure Coding and Architecture | PARTIAL | Missing remediation SLA, complete SBOM/risky/dangerous component inventories and deeper concurrency/TOCTOU reviews. |
| V16 | Security Logging and Error Handling | PARTIAL | Missing log inventory, L3 all-authorization-decision logging and logically separate remote security-log sink. |
| V17 | WebRTC | N/A | No WebRTC/TURN/DTLS-SRTP stack is present. |

## High-confidence implemented controls

- Per-response cryptographic CSP nonce, `object-src 'none'`, `base-uri 'none'`, COOP, nosniff, no-referrer and frame denial.
- Timing-safe CSRF enforcement for administrator mutations and per-device CSRF controls for PWA mutations.
- Bounded upload/download/ZIP/OCR/native-tool processing and controlled filesystem paths.
- Parameterized D1 SQL queries and shell-free `spawn`/`execFile` argument arrays.
- Salted scrypt password/recovery-code hashing with bounded asynchronous work.
- One-time TOTP counters with exact current 30-second-step acceptance.
- 256-bit stateful administrator session identifiers with rotation, backend revocation, absolute expiry and independent inactivity expiry.
- WebAuthn challenges are server-generated with cryptographic randomness, origin/RP checks, user presence and user verification.
- Google OAuth broker uses random state, PKCE `S256`, constrained provider URLs and allowlisted Drive scopes with `drive.file` default.
- AES-256-GCM for application-managed state/secret encryption and Ed25519 signed audit proof exports.
- Tamper-evident security audit journal with HMAC chaining and structured records.
- Docker production runtime drops root privileges, clears supplementary groups/capabilities and enables `no-new-privs`.

## Confirmed priority gaps

### P0 — Level 3 authentication assurance

| Requirement | Gap |
|---|---|
| V6.3.3 | Password/TOTP still permits privileged access without a mandatory hardware-backed phishing-resistant factor. Current WebAuthn registration uses no attestation proof sufficient to establish approved hardware provenance. |
| V7.5.3 | Highly sensitive operations do not consistently require a fresh step-up factor. |
| V13.3.1 / V13.3.3 | L3 hardware-backed secret custody / isolated crypto module is not present. |

### P1 — security correctness and abuse resistance

| Requirement | Gap |
|---|---|
| V1.2.10 | `csvField()` does not currently prefix a leading NUL before spreadsheet export. |
| V3.3.1 / V3.3.3 | L3 HTTPS cookie prefixes and unconditional Secure semantics are not available across all modes. |
| V3.4.7 | CSP violation reporting is missing. |
| V3.7.3 | OAuth bridge external redirects do not provide a cancel/confirmation step. |
| V4.1.4 / V13.4.4 | Unused HTTP methods such as TRACE are not globally rejected. |
| V5.2.2 | Extension/content correspondence is not universally verified for all accepted files. |
| V5.2.4 | No general per-user stored-byte and file-count quota exists. |
| V5.2.6 | No uniform decoded-pixel limit protects image processing from pixel floods. |
| V6.2.4 / V6.2.11 / V6.2.12 | Common/context-specific/breached-password screening is absent. |
| V6.3.8 | Username-scoped WebAuthn options can reveal passkey/account availability. |
| V6.4.1 | Bootstrap password has forced change but no short issuance/first-use expiration. |
| V6.4.6 | Owner can choose another account's replacement password instead of initiating a user-controlled reset. |
| V7.4.3 / V7.5.1 / V7.5.2 | MFA/passkey changes and session management do not yet meet the full fresh-authentication/session-revocation requirements. |
| V11.2.3 | Managed TLS leaf and accepted RS256 WebAuthn RSA keys can be 2048-bit; L3's ~128-bit target requires RSA-3072-equivalent strength. |
| V14.3.3 | Remember-password vault stores a reusable encrypted password in IndexedDB, which ASVS disallows for browser storage. |
| V16.3.2 | L3 requires logging all authorization decisions/sensitive-data access; current audit coverage is not exhaustive. |
| V16.4.3 | No logically separate remote security-log sink is enabled by default. |

### P2 — assurance and documentation

- Application validation/business-rule specification.
- Browser support/security-feature policy.
- Authorization matrix including function/data/field/context rules.
- Cryptographic inventory, key lifecycle and PQC migration plan.
- External communication/egress/resource-management inventory.
- Sensitive-data classification and retention policy.
- Vulnerability remediation SLA, SBOM and risky/dangerous component inventory.
- Logging inventory, retention and access policy.
- Production verification checklist for TLS/proxy/HSTS/OCSP/ECH/time/log transport.

## Remediation log

| Date | Requirement(s) | Change | Commit(s) |
|---|---|---|---|
| 2026-08-24 | V6.5.1, V6.5.5 | One-time durable TOTP counters, exact 30-second acceptance window, enrollment-code consumption and replay regression tests. | `0a2ff20b`, `97a145fb`, `20175cd2`, `d3a84371` |
| 2026-08-24 | V7.3.1, V7.3.2 | Independent administrator inactivity timeout plus absolute-lifetime regression coverage. | `3b38f214`, `63dcc36f` |
| 2026-08-24 | V1–V17 | Requirement-by-requirement triage completed for all 345 ASVS 5.0.0 requirements. | `8bf1d413`, `e9740571` |

## Verification gates before any Level 3 claim

- All applicable requirements are `PASS`, with no unresolved `PARTIAL`, `FAIL`, `REVIEW` or `MANUAL`.
- Every `N/A` decision is independently reviewed and justified.
- CI/unit/integration/security scanning is green on the exact candidate commit.
- A production-like deployment is verified for TLS/proxy/time/logging/HSM controls.
- A focused independent penetration test covers authentication, authorization, public shares/capabilities, file upload/download, OAuth broker, PWA, recovery and administrative operations.
- Evidence is retained for deployment-only requirements.

Reference requirement source: official OWASP ASVS 5.0.0 CSV/JSON in the `OWASP/ASVS` repository.
