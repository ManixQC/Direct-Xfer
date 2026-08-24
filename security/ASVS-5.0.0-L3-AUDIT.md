# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 audit

Audit baseline date: 2026-08-24  
Target: OWASP Application Security Verification Standard 5.0.0, Level 3  
Repository: `ManixQC/Direct-Xfer`  
Initial baseline commit: `3d2c0b5c668c9136a05490b25b76f4166a5940e8`  
Remediation tracking head: `d3a843712f10cd02465fa16c623be75cebfaf831`

## Scope and interpretation

This document is the repository/static-analysis baseline for an ASVS 5.0.0 Level 3 program. Level 3 includes all applicable Level 1 and Level 2 requirements in addition to Level 3 requirements. A repository review can prove implementation controls, but deployment-specific controls (TLS termination, HSTS preload, external log protection, operating-system hardening, time synchronization, reverse-proxy behavior, etc.) require runtime or operational evidence before a requirement can be marked fully verified.

Status vocabulary:

- **PASS** — verified from repository evidence and covered by an implementation/testable invariant.
- **PARTIAL** — a relevant control exists but does not yet satisfy the full ASVS requirement or all application paths.
- **FAIL** — an applicable requirement has a confirmed implementation gap.
- **N/A** — technology/functionality is not used by Direct-Xfer in the audited scope.
- **MANUAL** — implementation may exist, but runtime/deployment evidence is required.
- **REVIEW** — further code-path verification is required before a definitive result.

No public claim of “ASVS Level 3 compliant” should be made until every applicable requirement is PASS and every N/A decision has been reviewed.

## Chapter matrix

| Chapter | Area | Current status | Primary evidence / gap |
|---|---|---:|---|
| V1 | Encoding and Sanitization | PARTIAL | Context encoding/XSS work is extensive; SSRF/path controls exist. CSV formula injection, parser-consistency and ReDoS need complete path review. |
| V2 | Validation and Business Logic | PARTIAL | Server-side validation, quotas, locking and transaction-style rollback are common. Documentation of business invariants is incomplete. |
| V3 | Web Frontend Security | PARTIAL | Per-response CSP nonce, COOP, nosniff, no-referrer and frame denial exist. HSTS subdomain/preload behavior, CSP reporting, authenticated-resource isolation and cookie hardening remain. |
| V4 | API and Web Service | PARTIAL | Express/API boundaries and stable error handling exist. Unsupported HTTP methods and proxy/message-boundary deployment behavior require hardening/evidence. GraphQL/WebSocket are N/A unless introduced. |
| V5 | File Handling | PARTIAL | Bounded streaming, storage quotas, safe paths, executable sniffing, optional ClamAV/quarantine and moderation exist. Pixel-flood, archive/symlink and all-file type-content validation need closure. |
| V6 | Authentication | PARTIAL | scrypt password hashing, brute-force lockout, one-time 30-second TOTP, recovery codes, passkeys/WebAuthn and unusual-login notifications exist. Mandatory phishing-resistant hardware MFA is not enforced. Common/breached-password screening needs closure. |
| V7 | Session Management | PARTIAL | 256-bit random session identifiers, login rotation, CSRF, role refresh, backend invalidation, absolute expiry and independent inactivity expiry now exist. HTTPS cookie prefix/secure policy is not yet L3-strict across all deployment modes. |
| V8 | Authorization | PARTIAL | Roles, owner/operator scoping, current-account role refresh and LAN/admin network controls exist. L3 contextual/adaptive authorization is not systematically defined/enforced for all privileged operations. |
| V9 | Self-contained Tokens | REVIEW/N/A | Direct-Xfer primarily uses reference/session tokens. Any capability or connector token that is self-contained must be individually mapped before marking this chapter N/A. |
| V10 | OAuth and OIDC | PARTIAL | Google OAuth broker uses state/PKCE-style transaction material and constrained broker flows. L3 sender-constrained/PAR requirements must be scoped to Direct-Xfer’s role (client/broker), with N/A decisions documented for authorization-server-only requirements. |
| V11 | Cryptography | PARTIAL | Node crypto, WebAuthn public-key verification, scrypt and protected broker secrets exist. A formal crypto inventory, key lifecycle and post-quantum migration plan are missing. |
| V12 | Secure Communication | PARTIAL/MANUAL | HTTPS/local-CA support exists. TLS versions/ciphers, reverse proxy and certificate lifecycle require deployment evidence. |
| V13 | Configuration | PARTIAL | Production defaults and Docker hardening are significant; security configuration inventory and hardened-profile enforcement need completion. |
| V14 | Data Protection | PARTIAL | Secret/encryption stores, DLP, masking, no-store on sensitive responses and audit controls exist. Formal data classification/retention and backup/restore confidentiality evidence remain. |
| V15 | Secure Coding and Architecture | PARTIAL | Strong modularization, fail-closed boundaries, CodeQL/Codacy/Scout and dependency pinning are present. Threat model, risky-component inventory, dangerous-functionality inventory and race/TOCTOU review are incomplete. |
| V16 | Security Logging and Error Handling | PARTIAL | Authentication/audit/security events and generic HTTP error handling exist. A formal log inventory and a protected logically separate log sink are not yet established. |
| V17 | WebRTC | N/A | No WebRTC/TURN/DTLS-SRTP media stack is present in Direct-Xfer. Re-evaluate if WebRTC is introduced. |

## High-confidence requirement findings

### PASS

| Requirement | Evidence |
|---|---|
| v5.0.0-3.4.3 | `lib/server/http-application.js` creates a cryptographic per-request CSP nonce and emits CSP with `object-src 'none'` and `base-uri 'none'`. |
| v5.0.0-3.4.4 | `X-Content-Type-Options: nosniff` is emitted by the common HTTP boundary. |
| v5.0.0-3.4.8 | `Cross-Origin-Opener-Policy: same-origin` is emitted by the common HTTP boundary. |
| v5.0.0-3.5.1 | Mutating administrator requests require `X-CSRF-Token`; the token is checked with a timing-safe comparison. |
| v5.0.0-5.2.1 | Upload handling uses bounded streaming and configured maximum upload sizes. |
| v5.0.0-5.3.2 | Reception uploads reduce names to safe basenames and use managed path containment helpers. |
| v5.0.0-6.2.1 | Password changes enforce at least 8 characters. |
| v5.0.0-6.2.2 | Authenticated users can change their passwords. |
| v5.0.0-6.2.3 | Non-forced password changes require the current password. |
| v5.0.0-6.3.1 | Login failures are tracked by source IP with configurable thresholds and lockout. |
| v5.0.0-6.3.5 | New/unrecognized administrator login devices generate security-center notifications and audits. |
| v5.0.0-6.5.1 | Accepted TOTP counters are durably persisted before authentication is granted; the same counter is rejected on replay. The enrollment verification counter is also consumed atomically before enabling TOTP. Regression coverage: `test/asvs-l3-totp-1.70.22.test.js`. |
| v5.0.0-6.5.2 | Recovery codes are stored with the approved password hashing implementation rather than plaintext. |
| v5.0.0-6.5.3 | TOTP seeds and recovery codes are generated with `crypto.randomBytes`. |
| v5.0.0-6.5.4 | Recovery codes contain 40 random bits, exceeding the 20-bit minimum. |
| v5.0.0-6.5.5 | Authentication accepts only the current 30-second TOTP step; the previous ±1-step default was removed. |
| v5.0.0-6.5.8 | TOTP verification uses server `Date.now()` and never client-provided time. |
| v5.0.0-6.7.2 | WebAuthn challenges are generated server-side using cryptographic randomness and have bounded lifetime. |
| v5.0.0-7.2.1 | Session validation is performed by the backend session service. |
| v5.0.0-7.2.2 | Administrator sessions are dynamically generated reference tokens. |
| v5.0.0-7.2.3 | Session IDs are 32 random bytes (256 bits) encoded as hex. |
| v5.0.0-7.2.4 | Authentication rotates and invalidates a previously presented administrator session. |
| v5.0.0-7.3.1 | Administrator sessions now enforce an independent inactivity timeout (30 minutes by default, configurable and capped by absolute lifetime). Regression coverage: `test/asvs-l3-session-idle-1.70.22.test.js`. |
| v5.0.0-7.3.2 | Absolute session lifetime remains enforced independently of sliding activity and is covered by the ASVS session regression test. |
| v5.0.0-7.4.1 | Logout/expiry invalidates backend session state and attached session streams. |
| v5.0.0-7.4.2 | Deleted-account checks invalidate sessions; account-scoped invalidation helpers exist. |
| v5.0.0-8.3.2 | Session role/username are refreshed from the current account record on every session validation; invalid role metadata fails closed. |
| v5.0.0-16.5.1 | The final HTTP error boundary returns generic JSON errors and does not expose stack traces to clients. |
| v5.0.0-16.5.3 | Several state mutations use explicit rollback when persistence fails; security boundaries generally fail closed. |

### Confirmed gaps

| Priority | Requirement | Status | Gap |
|---:|---|---|---|
| P0 | v5.0.0-6.3.3 (L3 clause) | FAIL | Password/TOTP can authenticate privileged users; a hardware-backed, phishing-resistant factor is available through WebAuthn but is not mandatory for all privileged access paths. |
| P1 | v5.0.0-6.2.4 | FAIL | No repository evidence of rejecting at least the top 3000 common passwords during account creation/password change. |
| P1 | v5.0.0-6.2.12 | FAIL | No breached-password screening is currently enforced during account creation/password change. |
| P1 | v5.0.0-3.4.1 | PARTIAL | HTTPS responses set one-year HSTS, but the normal policy currently omits `includeSubDomains`; local-CA mode intentionally clears HSTS. |
| P1 | v5.0.0-3.4.7 | FAIL | CSP has no violation reporting endpoint/directive. |
| P1 | v5.0.0-3.3.1 / 3.3.3 | PARTIAL | Session cookie uses `HttpOnly; SameSite=Lax`; `Secure` is deployment-dependent and the cookie does not use the `__Host-` prefix. |
| P1 | v5.0.0-5.2.6 | REVIEW/likely gap | A global image byte cap exists, but repository evidence of an explicit decoded-pixel-count cap is not yet established. |
| P1 | v5.0.0-5.2.5 / 5.3.3 | REVIEW | Upload storage has path containment, but archive extraction/symlink behavior must be proven for every archive-processing path. |
| P1 | v5.0.0-16.4.3 | FAIL | No separate protected remote security-log sink is configured by default. |
| P2 | v5.0.0-3.1.1 / 3.7.5 | FAIL | Browser security capability requirements and fallback behavior are not formally documented. |
| P2 | v5.0.0-11.1.1–11.1.4 | FAIL | Formal cryptographic inventory, lifecycle, discovery and post-quantum migration documentation are missing. |
| P2 | v5.0.0-15.1.x | FAIL | Formal threat model, risky-component inventory and dangerous-functionality inventory are incomplete. |
| P2 | v5.0.0-16.1.1 | FAIL | Formal logging inventory/retention/access-control document is missing. |

## Remediation log

| Date | Requirement(s) | Change | Commit(s) |
|---|---|---|---|
| 2026-08-24 | v6.5.1, v6.5.5 | One-time durable TOTP counters, exact 30-second acceptance window, enrollment-code consumption and replay regression tests. | `0a2ff20b`, `97a145fb`, `20175cd2`, `d3a84371` |
| 2026-08-24 | v7.3.1, v7.3.2 | Independent administrator inactivity timeout plus absolute-lifetime regression coverage. | `3b38f214`, `63dcc36f` |

## Priority remediation plan

### P0 — privileged authentication

1. Define and implement an ASVS-L3 privileged authentication profile requiring a phishing-resistant WebAuthn/FIDO2 factor for `owner`, `admin` and `operator` access.
2. Ensure recovery/administrative reset paths cannot downgrade or bypass the L3 authentication strength.
3. Add regression tests covering standard password/TOTP rejection when the L3 profile is enabled and WebAuthn user-verification requirements.

### P1 — edge and file security

1. Add L3 HTTPS/cookie hardening without breaking intentionally local HTTP deployments; use a documented hardened profile rather than silently changing LAN semantics.
2. Add CSP violation reporting.
3. Complete image decoded-pixel caps and archive/symlink/zip-slip verification.
4. Add common/breached-password controls that do not disclose the candidate password to third parties.
5. Add an optional authenticated remote security-log sink and document deployment requirements.

### P2 — assurance/documentation

1. Threat model and trust-boundary/data-flow diagrams.
2. Crypto inventory and lifecycle/PQC migration plan.
3. Log inventory, retention and access policy.
4. Browser support/security-feature policy.
5. Deployment verification checklist for TLS, reverse proxy, HSTS/preload and time synchronization.

## Verification gates before claiming L3

- All applicable ASVS 5.0.0 requirements are individually mapped to PASS/N/A with evidence.
- N/A decisions have a rationale and reviewer approval.
- CI passes unit/integration tests, CodeQL, dependency/container scanning and SARIF ingestion.
- A production-like deployment is manually verified for TLS/proxy/logging/time controls.
- A focused independent penetration test covers authentication, authorization, file upload/download, OAuth broker, PWA, public shares and recovery paths.

Reference requirement source: OWASP ASVS 5.0.0 official CSV/JSON in the `OWASP/ASVS` repository.
