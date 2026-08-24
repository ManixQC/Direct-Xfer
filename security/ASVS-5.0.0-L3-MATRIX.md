# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 requirement matrix

Audit date: 2026-08-24  
Standard: OWASP ASVS 5.0.0 Level 3 (L3 includes applicable L1 and L2 requirements)  
Repository: `ManixQC/Direct-Xfer`  
Initial baseline: `3d2c0b5c668c9136a05490b25b76f4166a5940e8`  
Source snapshot reviewed for this tranche: `df0a5450671195de2c0bf8b46b3f8540989d5ef9`

## Coverage

This is the requirement-by-requirement working matrix. V1 through V8 are individually triaged in this tranche: **182 / 345 requirements**. V9 through V17 remain to be individually triaged. This file is audit evidence, not a certification claim.

| Status | Count |
|---|---:|
| PASS | 62 |
| PARTIAL | 37 |
| FAIL | 33 |
| N/A | 30 |
| REVIEW | 15 |
| MANUAL | 5 |
| **Total V1–V8** | **182** |

Status meanings are defined in `security/ASVS-5.0.0-L3-AUDIT.md`. `N/A` decisions remain subject to reviewer confirmation before any L3 claim.

## V1 — Encoding and Sanitization

| Requirement | Status | Evidence / gap |
|---|---|---|
| V1.1.1 | **REVIEW** | Multiple URL/cookie/JSON decoders exist; full canonicalization-order review is not yet complete. |
| V1.1.2 | **PARTIAL** | `esc()` and `jsonForScript()` provide context-aware output encoding, but every output sink has not yet been traced. |
| V1.2.1 | **PARTIAL** | HTML escaping, RFC 6266 filename encoding, and `nosniff` are present; all dynamic HTML/attribute/header contexts are not yet exhaustively mapped. |
| V1.2.2 | **PARTIAL** | `encodePath()`, `encodeURIComponent()`, and URL validation are used; every redirect and outbound URL builder has not yet been proven allowlisted. |
| V1.2.3 | **PARTIAL** | JSON serialization and `jsonForScript()` protect known dynamic JavaScript/JSON contexts; every inline/dynamic JS sink remains to be traced. |
| V1.2.4 | **PASS** | Cloudflare D1 queries use `prepare(...).bind(...)`; the main application primarily uses file/in-memory state rather than query languages. |
| V1.2.5 | **PASS** | Native tools are invoked with `spawn`/`execFile` argument arrays and without a shell; connector paths/remotes are positively validated. |
| V1.2.6 | **N/A** | No LDAP query functionality is present in the audited repository. |
| V1.2.7 | **N/A** | No XPath query engine is present in the audited repository. |
| V1.2.8 | **N/A** | No LaTeX processor is present in the audited repository. |
| V1.2.9 | **REVIEW** | Dynamic regular-expression construction still requires a complete source-to-sink review. |
| V1.2.10 | **PARTIAL** | `csvField()` follows RFC 4180 quoting and protects leading `=`, `+`, `-`, `@`, tab and CR, but currently misses a leading NUL character. |
| V1.3.1 | **N/A** | No WYSIWYG/HTML authoring feature accepting arbitrary HTML was identified. |
| V1.3.2 | **PASS** | Repository search found no use of `eval()` or equivalent general-purpose dynamic code execution on untrusted input. |
| V1.3.3 | **PARTIAL** | Dangerous contexts use bounded/validated inputs in many services, but a complete source-to-dangerous-sink inventory is still pending. |
| V1.3.4 | **REVIEW** | SVG is used by the product, but all user-supplied SVG ingestion/direct-render paths still need explicit mapping. |
| V1.3.5 | **REVIEW** | BBCode/Markdown-like rendering paths require a dedicated sanitization review before this requirement can be closed. |
| V1.3.6 | **PARTIAL** | OAuth broker URLs/provider hosts are constrained and outbound broker fetches reject redirects; all administrator-configurable outbound integrations are not yet fully proven against SSRF. |
| V1.3.7 | **N/A** | No user-defined server-side template source is accepted by Direct-Xfer. |
| V1.3.8 | **N/A** | JNDI is not used. |
| V1.3.9 | **N/A** | Memcache is not used. |
| V1.3.10 | **REVIEW** | Format-string-like uses need a complete sink review before this can be marked PASS. |
| V1.3.11 | **REVIEW** | SMTP is supported through Nodemailer; all user-controlled mail header/address fields still require explicit CRLF-injection verification. |
| V1.3.12 | **REVIEW** | A repository-wide ReDoS review of regular expressions against attacker-controlled strings is still required. |
| V1.4.1 | **PASS** | Server code is JavaScript/Node.js and managed C# launcher code; no unsafe native memory manipulation is part of the application codebase. |
| V1.4.2 | **PARTIAL** | Many numeric inputs are bounded with finite/safe-integer checks and caps, but integer/range validation has not yet been exhaustively traced. |
| V1.4.3 | **PARTIAL** | Files, child processes, streams, temporary directories and timers commonly have cleanup paths; the resource-lifecycle review is not yet complete. |
| V1.5.1 | **N/A** | No XML parser accepting untrusted XML was identified. |
| V1.5.2 | **PARTIAL** | JSON and persisted-state inputs are size/shape checked in many boundaries, but all nested object/type constraints and restore paths remain to be verified. |
| V1.5.3 | **REVIEW** | Consistency between URL, JSON, cookie, and path parsers needs a focused interoperability/canonicalization review. |

## V2 — Validation and Business Logic

| Requirement | Status | Evidence / gap |
|---|---|---|
| V2.1.1 | **FAIL** | There is no complete application-wide specification of input-validation rules and expected data structures. |
| V2.1.2 | **FAIL** | There is no complete documentation of logical/contextual validation rules for related fields. |
| V2.1.3 | **FAIL** | Business-logic limits exist in code but are not documented comprehensively per user and globally. |
| V2.2.1 | **PARTIAL** | Backend routes/services apply positive validation, ranges and allowlists broadly, but coverage of every input has not yet been established. |
| V2.2.2 | **PASS** | Security-relevant validation is performed in trusted backend services/routes rather than relying on browser-only validation. |
| V2.2.3 | **PARTIAL** | Many related values are cross-checked, but an application-wide invariant inventory is not yet available. |
| V2.3.1 | **PARTIAL** | OAuth, WebAuthn and TOTP flows use server-side state/order enforcement; remaining multi-step business flows need explicit verification. |
| V2.3.2 | **PARTIAL** | Numerous quotas/caps/expiry limits are implemented, but the documented business-limit baseline is incomplete. |
| V2.3.3 | **PARTIAL** | Many persistent mutations implement rollback on failure, but transactionality has not yet been proven for every business operation. |
| V2.3.4 | **PARTIAL** | Locks and concurrency caps protect several limited resources, but all limited-quantity operations are not yet mapped. |
| V2.3.5 | **REVIEW** | A threat model is required to determine which Direct-Xfer actions qualify as high-value operations requiring multi-user approval. |
| V2.4.1 | **PARTIAL** | Login/broker rate limits, bounded password hashing, PoW and concurrency caps exist; all costly/public functions still need anti-automation review. |
| V2.4.2 | **REVIEW** | No general human-timing requirement exists; applicability must be decided per business flow in the threat model. |

## V3 — Web Frontend Security

| Requirement | Status | Evidence / gap |
|---|---|---|
| V3.1.1 | **FAIL** | Browser security feature requirements and fallback/blocking behavior are not formally documented. |
| V3.2.1 | **PASS** | Downloads default to attachment or `application/octet-stream` with `nosniff`; inline rendering is explicitly controlled for known preview types. |
| V3.2.2 | **PARTIAL** | Key UI flows use `textContent`/safe text rendering, but every DOM sink has not yet been traced. |
| V3.2.3 | **REVIEW** | A dedicated DOM-clobbering review of client-side globals, IDs and namespace use is still pending. |
| V3.3.1 | **PARTIAL** | Sensitive cookies receive `Secure` on HTTPS, but plain-HTTP LAN deployments intentionally omit it and cookie names do not use the required secure prefix. |
| V3.3.2 | **PASS** | Session/PWA cookies use `SameSite=Lax`; state-changing operations additionally require CSRF tokens and/or same-origin checks. |
| V3.3.3 | **FAIL** | Session/PWA cookies do not use the `__Host-` prefix. |
| V3.3.4 | **PASS** | Session and PWA bearer cookies are `HttpOnly`, and bearer values are not returned in normal response bodies. |
| V3.3.5 | **PASS** | Authentication cookies have fixed, small token formats far below the 4096-byte cookie limit. |
| V3.4.1 | **PARTIAL** | HTTPS responses set one-year HSTS, but `includeSubDomains` is absent and Local-CA mode deliberately sends `max-age=0`. |
| V3.4.2 | **PASS** | No permissive CORS policy or reflected `Access-Control-Allow-Origin` behavior was found in the application. |
| V3.4.3 | **PASS** | The common HTTP boundary emits a per-response cryptographic CSP nonce and includes `object-src 'none'` and `base-uri 'none'`. |
| V3.4.4 | **PASS** | The common HTTP boundary emits `X-Content-Type-Options: nosniff`. |
| V3.4.5 | **PASS** | The common HTTP boundary emits `Referrer-Policy: no-referrer`. |
| V3.4.6 | **PASS** | CSP includes `frame-ancestors 'none'` for the common web boundary. |
| V3.4.7 | **FAIL** | CSP does not yet define a violation reporting destination. |
| V3.4.8 | **PASS** | The common HTTP boundary emits `Cross-Origin-Opener-Policy: same-origin`. |
| V3.5.1 | **PASS** | Mutating administrator requests require `X-CSRF-Token`; paired PWA mutations use per-device CSRF and same-origin controls. |
| V3.5.2 | **N/A** | Direct-Xfer does not rely on CORS preflight as the primary protection for sensitive same-origin functionality. |
| V3.5.3 | **PARTIAL** | Known sensitive state changes use non-safe HTTP methods, but a complete route inventory is still pending. |
| V3.5.4 | **REVIEW** | Admin, public and PWA surfaces share an origin while the OAuth broker is separate; a formal origin-separation rationale is required. |
| V3.5.5 | **PASS** | `public/oauth-bridge.js` rejects `postMessage` events unless both `event.origin === location.origin` and `event.source === window.opener`. |
| V3.5.6 | **PASS** | No JSONP implementation was found. |
| V3.5.7 | **PASS** | Authenticated data is not emitted through JavaScript resource responses. |
| V3.5.8 | **PARTIAL** | Authenticated resources have auth checks, but a common `Cross-Origin-Resource-Policy` or strict `Sec-Fetch-*` policy is not enforced. |
| V3.6.1 | **PASS** | Client assets are self-hosted in the repository; no external CDN dependency requiring SRI was found. |
| V3.7.1 | **PASS** | The web client uses currently supported browser technologies rather than Flash/ActiveX/Silverlight/Java applets. |
| V3.7.2 | **PARTIAL** | Google broker URLs are tightly validated, but the generic OAuth bridge can navigate to any HTTPS URL supplied by an authenticated backend response. |
| V3.7.3 | **FAIL** | The OAuth bridge automatically redirects to an external HTTPS destination without presenting a cancel/confirmation step. |
| V3.7.4 | **MANUAL** | HSTS preload requires a stable production public domain and operational registration evidence. |
| V3.7.5 | **FAIL** | Behavior for browsers lacking required security features is not formally documented/implemented. |

## V4 — API and Web Service

| Requirement | Status | Evidence / gap |
|---|---|---|
| V4.1.1 | **PARTIAL** | Most responses set appropriate media types/charset through Express or explicit headers, but the complete response surface has not been inventoried. |
| V4.1.2 | **REVIEW** | HTTP/HTTPS behavior depends on native TLS, Local-CA and reverse-proxy deployment modes; endpoint-specific redirect behavior needs runtime verification. |
| V4.1.3 | **MANUAL** | `TRUST_PROXY` is explicit and request IP logic uses trusted Express resolution, but intermediary-header authenticity depends on deployment configuration. |
| V4.1.4 | **FAIL** | There is no global allowlist/rejection layer for unsupported HTTP methods such as TRACE. |
| V4.1.5 | **REVIEW** | Signed audit proofs exist, but the threat model has not identified whether any transaction requires per-message signatures in addition to TLS. |
| V4.2.1 | **MANUAL** | Request-smuggling resistance depends on Node's HTTP parser plus any reverse proxy/load balancer and requires production-like verification. |
| V4.2.2 | **PARTIAL** | Node/Express manages framing and the broker sets exact `Content-Length` for generated JSON, but intermediary behavior still requires verification. |
| V4.2.3 | **MANUAL** | Core Direct-Xfer serves HTTP/1.x; HTTP/2/3 behavior, if exposed, belongs to the terminating proxy and must be verified there. |
| V4.2.4 | **MANUAL** | HTTP/2/3 header validation is a deployment/proxy concern for deployments that enable those protocols. |
| V4.2.5 | **PARTIAL** | Outbound broker requests have URL/header/response bounds and timeouts, but all outbound integrations are not yet fully inventoried. |
| V4.3.1 | **N/A** | No GraphQL API is present. |
| V4.3.2 | **N/A** | No GraphQL API is present. |
| V4.4.1 | **N/A** | No WebSocket service is present; Direct-Xfer uses HTTP/SSE/push mechanisms. |
| V4.4.2 | **N/A** | No WebSocket handshake is present. |
| V4.4.3 | **N/A** | No dedicated WebSocket session tokens are used. |
| V4.4.4 | **N/A** | No transition from HTTPS sessions to WebSocket channels is implemented. |

## V5 — File Handling

| Requirement | Status | Evidence / gap |
|---|---|---|
| V5.1.1 | **PARTIAL** | README/configuration document many size/type/quarantine behaviors, but there is no complete feature-by-feature permitted-type/size/safety specification. |
| V5.2.1 | **PASS** | Upload paths use bounded streaming, configured maximum byte limits, concurrency limits and idle timeouts. |
| V5.2.2 | **FAIL** | General file-transfer features intentionally accept arbitrary file types and do not universally verify extension-to-content correspondence. |
| V5.2.3 | **N/A** | Direct-Xfer does not server-side extract uploaded archives; ZIP inspection is a bounded central-directory preview only. |
| V5.2.4 | **FAIL** | There is no general per-user stored-byte quota plus maximum file-count quota for all upload features. |
| V5.2.5 | **N/A** | Uploaded archives are not extracted by the application, so archive-contained symlinks are not materialized server-side. |
| V5.2.6 | **FAIL** | Image byte limits exist, but there is no uniform decoded-pixel-count rejection before image processing. |
| V5.3.1 | **PASS** | Uploaded/generated content is stored outside the static application tree and served through controlled download/preview routes, not executed as server code. |
| V5.3.2 | **PASS** | Managed storage uses generated/validated names, path containment and realpath/symlink checks on sensitive local targets. |
| V5.3.3 | **N/A** | The application does not extract user archives, so there is no server-side archive path materialization susceptible to Zip Slip. |
| V5.4.1 | **PASS** | Download responses set `Content-Disposition` and use server-selected/validated filenames. |
| V5.4.2 | **PASS** | Download filenames use RFC 6266 `filename*=UTF-8''...` with `encodeURIComponent`, while unsafe path/control characters are rejected at relevant boundaries. |
| V5.4.3 | **PARTIAL** | ClamAV/quarantine support exists but antivirus scanning is optional and therefore not guaranteed for every untrusted file. |

## V6 — Authentication

| Requirement | Status | Evidence / gap |
|---|---|---|
| V6.1.1 | **PARTIAL** | Credential throttling/lockout and bounded scrypt work are implemented, but the complete authentication defense policy is not consolidated in documentation. |
| V6.1.2 | **FAIL** | No documented list of Direct-Xfer/context-specific words is maintained for password rejection. |
| V6.1.3 | **FAIL** | Password/TOTP, recovery-code and passkey authentication pathways are not yet documented together with equivalent assurance requirements. |
| V6.2.1 | **PASS** | User-set passwords are required to be at least 8 characters. |
| V6.2.2 | **PASS** | Authenticated users can change their password. |
| V6.2.3 | **PASS** | Normal password change requires both current and new passwords; the forced first-use change is a controlled bootstrap exception. |
| V6.2.4 | **FAIL** | Passwords are not checked against an available list of at least the top 3000 common passwords. |
| V6.2.5 | **PASS** | No composition rules require particular upper/lowercase, digit or special-character classes. |
| V6.2.6 | **PASS** | Password inputs in the shipped login/settings interfaces are masked password fields. |
| V6.2.7 | **PASS** | No code blocks paste or browser/external password-manager usage. |
| V6.2.8 | **PASS** | Password verification uses the supplied string without trimming, case transformation or truncation within the 512-character safety limit. |
| V6.2.9 | **PASS** | The password implementation accepts well over 64 characters (up to the 512-character abuse-prevention bound). |
| V6.2.10 | **PASS** | Direct-Xfer does not impose periodic password expiration. |
| V6.2.11 | **FAIL** | The required context-specific password denylist is not implemented. |
| V6.2.12 | **FAIL** | Password creation/change does not check against a breached-password corpus. |
| V6.3.1 | **PASS** | Login brute-force defense combines per-source failure windows/lockout with a bounded asynchronous scrypt queue. |
| V6.3.2 | **FAIL** | The bootstrap administrator username defaults to `admin`, so the ASVS default-account requirement is not met as written. |
| V6.3.3 | **FAIL** | Privileged password/TOTP login remains possible without mandatory hardware-backed phishing-resistant authentication. |
| V6.3.4 | **PARTIAL** | Authentication pathways have different assurance properties and there is no complete documented policy enforcing an equivalent minimum strength. |
| V6.3.5 | **PASS** | Suspicious/new-device authentication activity is audited and can generate security-center notifications. |
| V6.3.6 | **PASS** | Email is not used as an authentication factor. |
| V6.3.7 | **PARTIAL** | Authentication-detail changes are audited, but a user-facing notification is not guaranteed for every credential/identifier update. |
| V6.3.8 | **FAIL** | Password login uses a dummy hash for unknown users, but username-scoped WebAuthn options return `passkey-unavailable`, allowing account/passkey availability enumeration. |
| V6.4.1 | **FAIL** | The generated bootstrap owner password is cryptographically random and forces change, but it has no short issuance lifetime/first-use invalidation mechanism. |
| V6.4.2 | **PASS** | No password hints or knowledge-based secret questions are present. |
| V6.4.3 | **PARTIAL** | Administrative password reset does not remove the user's MFA record, but all recovery/reset pathways still require end-to-end assurance review. |
| V6.4.4 | **FAIL** | There is no defined same-assurance identity-proofing process for replacement of a lost MFA factor. |
| V6.4.5 | **N/A** | Application-managed authentication factors do not have a scheduled expiration that would require renewal notices. |
| V6.4.6 | **FAIL** | An owner can currently choose the replacement password for another account instead of only initiating a user-controlled reset process. |
| V6.5.1 | **PASS** | Accepted TOTP counters are persisted as one-time and recovery codes are consumed on successful use. |
| V6.5.2 | **PASS** | Recovery codes are stored using the salted scrypt password-hashing implementation. |
| V6.5.3 | **PASS** | TOTP seeds and recovery codes are generated with `crypto.randomBytes`. |
| V6.5.4 | **PASS** | Generated recovery codes contain 40 random bits, exceeding the 20-bit minimum. |
| V6.5.5 | **PASS** | Authentication accepts only the current 30-second TOTP time step. |
| V6.5.6 | **PASS** | TOTP, passkeys and durable PWA/device authentication factors have revocation/removal paths. |
| V6.5.7 | **PASS** | Biometric use occurs through WebAuthn/passkeys (possession credential plus user verification), not as a standalone biometric secret. |
| V6.5.8 | **PASS** | TOTP verification uses server time (`Date.now()`), not client-supplied time. |
| V6.6.1 | **N/A** | No SMS/PSTN out-of-band authentication is offered. |
| V6.6.2 | **N/A** | No out-of-band authentication-code mechanism is offered. |
| V6.6.3 | **N/A** | No code-based out-of-band authentication mechanism is offered. |
| V6.6.4 | **N/A** | Push notifications are not used to approve authentication requests. |
| V6.7.1 | **PARTIAL** | WebAuthn public keys are stored in protected application state, but an explicit tamper-protection assurance for cryptographic assertion verification keys is not yet documented. |
| V6.7.2 | **PASS** | WebAuthn challenges are 32 random bytes (256 bits), generated server-side and bounded by a challenge lifetime. |
| V6.8.1 | **N/A** | Google OAuth is used for storage connectors, not as an application-login identity provider. |
| V6.8.2 | **N/A** | Direct-Xfer does not consume external IdP authentication assertions for user login. |
| V6.8.3 | **N/A** | SAML is not used. |
| V6.8.4 | **N/A** | No external IdP is used to establish Direct-Xfer user sessions. |

## V7 — Session Management

| Requirement | Status | Evidence / gap |
|---|---|---|
| V7.1.1 | **PARTIAL** | Absolute and inactivity timeouts are implemented, but the complete documented risk/NIST re-authentication rationale is not yet present. |
| V7.1.2 | **FAIL** | There is no documented maximum concurrent-session policy and behavior per account. |
| V7.1.3 | **N/A** | Direct-Xfer does not participate in a federated SSO session ecosystem. |
| V7.2.1 | **PASS** | Session validation is performed by the backend stateful session service. |
| V7.2.2 | **PASS** | Administrator sessions use dynamically generated reference tokens rather than static API secrets. |
| V7.2.3 | **PASS** | Session IDs are generated from 32 random bytes (256 bits). |
| V7.2.4 | **PASS** | Authentication invalidates any presented previous session and issues a fresh session token. |
| V7.3.1 | **PASS** | Administrator sessions enforce an independent inactivity timeout, 30 minutes by default. |
| V7.3.2 | **PASS** | Administrator sessions independently enforce an absolute maximum lifetime. |
| V7.4.1 | **PASS** | Logout/expiry removes backend session state and closes associated session streams. |
| V7.4.2 | **PASS** | Deleted-account detection and account-scoped invalidation terminate active sessions. |
| V7.4.3 | **FAIL** | Password change clears other sessions, but MFA/passkey changes do not consistently offer/perform termination of all other active sessions. |
| V7.4.4 | **PASS** | Authenticated web/PWA interfaces expose logout functionality. |
| V7.4.5 | **PASS** | Owner/admin security controls can revoke individual sessions, and service helpers support account/all-session invalidation. |
| V7.5.1 | **PARTIAL** | Password changes and TOTP disable re-verify a password, but TOTP setup/enable and some sensitive account changes rely only on the current session. |
| V7.5.2 | **FAIL** | Session overview/revocation is an administrative function and does not provide each user a fresh-factor self-service workflow for terminating their sessions. |
| V7.5.3 | **FAIL** | Highly sensitive operations do not consistently require a dedicated step-up authentication event. |
| V7.6.1 | **N/A** | No federated IdP/RP session lifecycle is used. |
| V7.6.2 | **PASS** | A new session is created only after an explicit successful user authentication action. |

## V8 — Authorization

| Requirement | Status | Evidence / gap |
|---|---|---|
| V8.1.1 | **FAIL** | There is no complete authorization specification mapping functions/data objects to required roles/ownership. |
| V8.1.2 | **FAIL** | There is no complete field-level authorization specification for readable/writable object properties. |
| V8.1.3 | **FAIL** | Environmental/contextual attributes used for security decisions are not comprehensively documented. |
| V8.1.4 | **FAIL** | There is no documented adaptive authentication/authorization decision policy with thresholds and actions. |
| V8.2.1 | **PASS** | Administrative functions are protected at trusted route/service boundaries with explicit role middleware. |
| V8.2.2 | **PARTIAL** | Ownership/object checks are widespread and designed to prevent IDOR/BOLA, but every object endpoint has not yet been exhaustively traced. |
| V8.2.3 | **PARTIAL** | Public/decorated response objects avoid many internal fields, but a complete field-level authorization map is still missing. |
| V8.2.4 | **FAIL** | Adaptive contextual controls are not systematically applied both at login and throughout established sessions. |
| V8.3.1 | **PASS** | Authorization is enforced by backend route/service code rather than client-side JavaScript. |
| V8.3.2 | **PASS** | Each session validation refreshes role/username from the current account record and fails closed on invalid role metadata. |
| V8.3.3 | **REVIEW** | Delegated storage/proxy operations require explicit review to prove downstream access is always constrained to the originating subject's permissions. |
| V8.4.1 | **N/A** | Direct-Xfer has multiple accounts but no separate tenant isolation domain in the audited architecture. |
| V8.4.2 | **FAIL** | Administrative access combines network controls and authenticated sessions, but lacks continuous identity verification, device-posture assessment and contextual risk analysis. |
