# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 requirement matrix

Audit date: 2026-08-24  
Standard: OWASP ASVS 5.0.0 Level 3 (L3 includes applicable L1 and L2 requirements)  
Repository: `ManixQC/Direct-Xfer`  
Initial baseline: `3d2c0b5c668c9136a05490b25b76f4166a5940e8`  
Source snapshot reviewed through: `8bf1d413e81618a474ff87fc71779473f34b918a`

## Coverage

This is the requirement-by-requirement working matrix. **All 345 ASVS 5.0.0 requirements have now been individually triaged.** PASS means verified from repository evidence at this stage; MANUAL items still require production-like deployment evidence, REVIEW items require deeper path verification, and every N/A decision must be independently reviewed before any Level 3 compliance claim.

| Status | Count |
|---|---:|
| PASS | 88 |
| PARTIAL | 85 |
| FAIL | 57 |
| N/A | 86 |
| REVIEW | 18 |
| MANUAL | 11 |
| **Total** | **345** |

Status meanings and remediation priorities are defined in `security/ASVS-5.0.0-L3-AUDIT.md`.

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

## V9 — Self-contained Tokens

| Requirement | Status | Evidence / gap |
|---|---|---|
| V9.1.1 | **N/A** | Direct-Xfer does not issue or consume application self-contained authorization/session tokens such as JWTs; its sessions and capabilities are opaque server-side reference/bearer handles. |
| V9.1.2 | **N/A** | No application self-contained token algorithm negotiation exists. |
| V9.1.3 | **N/A** | No application self-contained token permits client-selected key sources such as `jku`, `x5u` or `jwk`. |
| V9.2.1 | **N/A** | No application self-contained token validity claims (`nbf`/`exp`) are consumed. |
| V9.2.2 | **N/A** | No application self-contained token types are accepted for authentication/authorization decisions. |
| V9.2.3 | **N/A** | No application self-contained token audience claim is consumed. |
| V9.2.4 | **N/A** | Direct-Xfer does not issue signed self-contained tokens to multiple audiences. |

## V10 — OAuth and OIDC

| Requirement | Status | Evidence / gap |
|---|---|---|
| V10.1.1 | **PASS** | Google access/refresh tokens and Direct-Xfer broker credentials are handled by the backend/rclone path; the browser receives only transaction/authentication-navigation data, not provider bearer tokens. |
| V10.1.2 | **PARTIAL** | Broker transactions use unpredictable state, PKCE verifier/challenge and backend-held polling credentials, but a formal same-user-agent/session binding proof across the remote-browser broker flow is not yet documented. |
| V10.2.1 | **PASS** | Google authorization uses both an unpredictable `state` value and PKCE with `S256`; callback state is validated before token exchange. |
| V10.2.2 | **N/A** | The built-in Google broker interacts with one preconfigured Google authorization server, so multi-authorization-server mix-up handling is not applicable to that flow. |
| V10.2.3 | **PASS** | Google Drive scopes are positively allowlisted and default to the least-privilege `drive.file` scope; readonly/full scopes require explicit selection. |
| V10.3.1 | **N/A** | Direct-Xfer is not an OAuth resource server accepting third-party access tokens as authorization credentials. |
| V10.3.2 | **N/A** | Direct-Xfer does not authorize application operations from third-party OAuth access-token claims. |
| V10.3.3 | **N/A** | Application users are not identified from OAuth access-token claims. |
| V10.3.4 | **N/A** | Direct-Xfer does not consume OAuth token authentication-strength claims for application sessions. |
| V10.3.5 | **N/A** | Direct-Xfer is not an OAuth resource server accepting bearer access tokens for application access. |
| V10.4.1 | **N/A** | Google is the authorization server; Direct-Xfer's broker is an OAuth client/relay and does not register arbitrary client redirect URIs. |
| V10.4.2 | **N/A** | Direct-Xfer does not operate the Google authorization server that issues authorization codes. |
| V10.4.3 | **N/A** | Authorization-code lifetime is controlled by Google, not by Direct-Xfer. |
| V10.4.4 | **N/A** | Direct-Xfer does not operate a general OAuth authorization server exposing client-selectable grant types. |
| V10.4.5 | **N/A** | Refresh-token replay semantics for Google-issued refresh tokens are controlled by Google; Direct-Xfer is the client. |
| V10.4.6 | **N/A** | PKCE enforcement by the authorization server is Google's responsibility; Direct-Xfer nevertheless sends `S256` PKCE as a client. |
| V10.4.7 | **N/A** | Direct-Xfer does not offer OAuth dynamic client registration. |
| V10.4.8 | **N/A** | Direct-Xfer does not issue OAuth refresh tokens as an authorization server. |
| V10.4.9 | **N/A** | Direct-Xfer does not operate the authorization-server consent/token-management UI. |
| V10.4.10 | **N/A** | Direct-Xfer does not expose authorization-server backchannel endpoints to arbitrary confidential OAuth clients. |
| V10.4.11 | **N/A** | Authorization-server scope assignment is managed by Google; Direct-Xfer constrains requested client scopes separately under V10.2.3. |
| V10.4.12 | **N/A** | Direct-Xfer does not operate a general authorization server with client-selected `response_mode`. |
| V10.4.13 | **N/A** | Pushed Authorization Requests are an authorization-server capability controlled by Google; Direct-Xfer is not that server. |
| V10.4.14 | **N/A** | Sender-constrained access-token issuance is controlled by Google, not Direct-Xfer. |
| V10.4.15 | **N/A** | Direct-Xfer does not operate an authorization server accepting Rich Authorization Requests from third-party clients. |
| V10.4.16 | **N/A** | Direct-Xfer does not operate the Google authorization server or its confidential-client authentication policy. |
| V10.5.1 | **N/A** | Direct-Xfer does not use OIDC ID Tokens for application login. |
| V10.5.2 | **N/A** | Direct-Xfer does not identify application users from OIDC ID Token claims. |
| V10.5.3 | **N/A** | No OIDC authorization-server metadata discovery is used for application login. |
| V10.5.4 | **N/A** | No OIDC ID Token audience is consumed. |
| V10.5.5 | **N/A** | OIDC back-channel logout is not implemented. |
| V10.6.1 | **N/A** | Direct-Xfer is not an OpenID Provider. |
| V10.6.2 | **N/A** | Direct-Xfer is not an OpenID Provider. |
| V10.7.1 | **N/A** | End-user OAuth consent is provided by Google; Direct-Xfer does not operate the authorization server. |
| V10.7.2 | **N/A** | Consent-prompt content is controlled by Google; Direct-Xfer requests an allowlisted scope and explicitly uses `prompt=consent`. |
| V10.7.3 | **N/A** | OAuth consent review/revocation is provided by Google rather than a Direct-Xfer authorization server. |

## V11 — Cryptography

| Requirement | Status | Evidence / gap |
|---|---|---|
| V11.1.1 | **FAIL** | There is no formal cryptographic key-management/lifecycle policy aligned to a standard such as NIST SP 800-57. |
| V11.1.2 | **FAIL** | There is no maintained application-wide inventory of keys, algorithms, certificates, allowed usages and protected data. |
| V11.1.3 | **FAIL** | Cryptographic discovery is performed ad hoc during review/testing rather than through a documented recurring discovery mechanism. |
| V11.1.4 | **FAIL** | No documented post-quantum cryptography migration plan is maintained. |
| V11.2.1 | **PASS** | Cryptographic operations rely on Node.js/OpenSSL Web Crypto primitives and established libraries rather than custom cipher implementations. |
| V11.2.2 | **PARTIAL** | Crypto boundaries are modular enough to migrate, but several algorithms/formats are hard-coded and there is no documented crypto-agility migration mechanism. |
| V11.2.3 | **FAIL** | Some RSA uses remain at 2048 bits (including WebAuthn RS256 acceptance and managed TLS leaf keys), below the approximately 128-bit security target represented by RSA-3072. |
| V11.2.4 | **PARTIAL** | Secret comparisons commonly use timing-safe operations and library cryptography, but a complete constant-time review of all cryptographic decisions is not yet complete. |
| V11.2.5 | **PARTIAL** | Encryption/signature failures generally fail closed, but a complete cryptographic error-path/oracle review has not yet been performed. |
| V11.3.1 | **PASS** | Application data encryption uses AES-GCM; no ECB or PKCS#1 v1.5 public-key encryption path was identified. |
| V11.3.2 | **PASS** | Application-managed symmetric encryption uses AES-256-GCM. |
| V11.3.3 | **PASS** | Encrypted application/state/broker-secret data uses authenticated encryption (AES-GCM) with integrity tags. |
| V11.3.4 | **PASS** | AES-GCM encryption paths generate a fresh 96-bit random IV for each encryption operation. |
| V11.3.5 | **N/A** | Direct-Xfer does not combine separate encryption and MAC primitives for the same encrypted payload; it uses AEAD. |
| V11.4.1 | **REVIEW** | General cryptographic hashes are SHA-256 or stronger, while standards-based TOTP uses HMAC-SHA1; the approved-algorithm policy must explicitly document this protocol-specific use. |
| V11.4.2 | **PASS** | Passwords and recovery codes are stored using salted scrypt with bounded asynchronous work. |
| V11.4.3 | **PASS** | Audit integrity/signature support uses SHA-256 digests/HMAC chaining and Ed25519 proof signatures. |
| V11.4.4 | **PARTIAL** | State encryption derives a 256-bit key with scrypt, but password-derived-key parameter policy/benchmarking is not formally documented across every derivation path. |
| V11.5.1 | **PARTIAL** | Security tokens such as sessions, CSRF, WebAuthn/OAuth challenges and PWA secrets use >=128 bits of CSPRNG entropy; a few random identifiers are shorter and require classification to prove they are not relied on as secrets. |
| V11.5.2 | **PASS** | Randomness uses operating-system backed Node/Web Crypto CSPRNG primitives designed for concurrent demand. |
| V11.6.1 | **PARTIAL** | Ed25519 and P-256 are used appropriately, and RSA generation uses exponent 65537; however 2048-bit RSA remains below the L3 strength target in some paths. |
| V11.6.2 | **MANUAL** | TLS key exchange is delegated to Node/OpenSSL or a reverse proxy; production cipher/key-exchange configuration requires runtime verification. |
| V11.7.1 | **FAIL** | Direct-Xfer does not provide full-memory encryption protecting sensitive data from other authorized host processes while data is in use. |
| V11.7.2 | **PARTIAL** | Secrets are scoped to backend services and encrypted at rest, but plaintext necessarily exists during use and no comprehensive immediate re-encryption/zeroization policy is implemented. |

## V12 — Secure Communication

| Requirement | Status | Evidence / gap |
|---|---|---|
| V12.1.1 | **PARTIAL** | Node 22 defaults provide modern TLS and native HTTPS support, but Direct-Xfer does not explicitly pin/verify TLS 1.2/1.3 only in every deployment mode. |
| V12.1.2 | **MANUAL** | Forward-secret cipher-suite enforcement depends on Node/OpenSSL or the terminating reverse proxy and requires production-like verification. |
| V12.1.3 | **N/A** | Direct-Xfer does not use mTLS client-certificate identities for application authentication/authorization. |
| V12.1.4 | **MANUAL** | OCSP stapling/revocation behavior is controlled by the externally provided certificate/terminating proxy; Local-CA deployments have no public OCSP service. |
| V12.1.5 | **MANUAL** | Encrypted Client Hello is a deployment/DNS/TLS-termination capability and is not configured by the application repository. |
| V12.2.1 | **PARTIAL** | Public deployments support HTTPS and broker traffic requires HTTPS, but Direct-Xfer intentionally supports plain HTTP on trusted LAN/local deployments. |
| V12.2.2 | **MANUAL** | Publicly trusted certificate use depends on deployment; Local-CA mode intentionally uses a private CA. |
| V12.3.1 | **PARTIAL** | Internet OAuth/update services use TLS and connector transports can be encrypted, but the application also supports administrator-selected SMB/SFTP/WebDAV configurations whose transport assurance varies. |
| V12.3.2 | **PASS** | Node HTTPS/fetch/rclone use normal certificate verification; insecure certificate bypass was not identified in built-in OAuth/update flows. |
| V12.3.3 | **N/A** | Direct-Xfer is primarily a monolithic application without internal HTTP microservices requiring a separate service-to-service TLS channel. |
| V12.3.4 | **N/A** | No internal HTTP service mesh or separate internal TLS service trust domain is present. |
| V12.3.5 | **N/A** | No microservice-to-microservice authentication channel is part of the core architecture. |

## V13 — Configuration

| Requirement | Status | Evidence / gap |
|---|---|---|
| V13.1.1 | **PARTIAL** | README/configuration document major external services and user-configurable connectors, but there is no complete communication/egress inventory. |
| V13.1.2 | **FAIL** | Maximum concurrent connections and saturation behavior are not documented for every external service. |
| V13.1.3 | **PARTIAL** | Timeouts, output caps, retries and cleanup exist in many integrations, but there is no complete resource-management policy covering every external dependency. |
| V13.1.4 | **FAIL** | Critical backend secrets and their required rotation schedules are not comprehensively documented. |
| V13.2.1 | **PARTIAL** | Backend broker/connectors authenticate, but some credentials are intentionally long-lived rather than uniformly short-term or certificate-based. |
| V13.2.2 | **PARTIAL** | The container drops privileges and connector operations are constrained, but least-privilege identities for every external backend/service are not formally verified. |
| V13.2.3 | **PASS** | No default privileged service credential such as `root/root` or `admin/admin` is embedded for backend authentication. |
| V13.2.4 | **PARTIAL** | Built-in OAuth/provider destinations are allowlisted, while user-configurable storage/notification integrations intentionally permit administrator-selected destinations. |
| V13.2.5 | **FAIL** | There is no deployment-wide egress allowlist restricting every destination the application server can contact. |
| V13.2.6 | **PARTIAL** | Many backend clients implement timeouts/concurrency/error behavior, but conformance to a complete documented connection policy is not established. |
| V13.3.1 | **FAIL** | Secrets are protected by environment variables, encrypted files and restrictive permissions, but L3 requires a hardware-backed secrets solution such as an HSM. |
| V13.3.2 | **PARTIAL** | Secret files use restrictive modes and the runtime process drops privileges, but centralized least-privilege secret-asset access controls are not present. |
| V13.3.3 | **FAIL** | Cryptographic operations are performed in the application process/OpenSSL rather than an isolated HSM/vault security module. |
| V13.3.4 | **FAIL** | A comprehensive secret expiration/rotation policy is not implemented; some broker credentials expire but other application keys do not rotate automatically. |
| V13.4.1 | **PARTIAL** | The Docker image copies only selected application directories and not `.git`, but every distribution target still requires packaging verification. |
| V13.4.2 | **PASS** | Production images set `NODE_ENV=production`; developer/debug middleware is not exposed in the normal server path. |
| V13.4.3 | **PASS** | Express static serving does not enable directory indexes and only serves selected public/PWA trees. |
| V13.4.4 | **FAIL** | TRACE and other unused HTTP methods are not explicitly rejected by a global method policy. |
| V13.4.5 | **PASS** | Diagnostics/security endpoints are authenticated; the unauthenticated health/meta endpoints intentionally expose only limited operational metadata. |
| V13.4.6 | **PARTIAL** | `x-powered-by` is disabled and backend stack versions are not broadly exposed, but application/version metadata is intentionally public and all error/tool diagnostics need final review. |
| V13.4.7 | **PASS** | The web tier serves explicit public/PWA assets/directories with dotfiles ignored rather than exposing the repository/source tree. |

## V14 — Data Protection

| Requirement | Status | Evidence / gap |
|---|---|---|
| V14.1.1 | **FAIL** | There is no complete data-classification inventory assigning all processed sensitive data to protection levels. |
| V14.1.2 | **FAIL** | Protection requirements for each sensitive-data class (encryption, retention, logging, access, privacy) are not formally documented. |
| V14.2.1 | **FAIL** | Opaque public share/access capability tokens are intentionally embedded in Direct-Xfer URLs, so sensitive bearer-style link material can appear in URL paths. |
| V14.2.2 | **PARTIAL** | Sensitive API responses commonly use `Cache-Control: no-store` and server caches are bounded, but a complete intermediary-cache/purge review is pending. |
| V14.2.3 | **PASS** | No analytics/user-tracking service was identified; sensitive data is sent externally only to explicitly configured functional integrations. |
| V14.2.4 | **PARTIAL** | Encryption, DLP, masking and retention controls exist, but there is no data-classification policy against which full implementation can be verified. |
| V14.2.5 | **PASS** | The API namespace terminates missing routes before static fallback, sensitive responses use restrictive caching, and content types are explicitly controlled. |
| V14.2.6 | **PARTIAL** | Decorators/public projections remove many internal fields, but every response has not yet been mapped against a formal sensitive-field minimum. |
| V14.2.7 | **PARTIAL** | Shares, notifications, histories and capability records have expiry/pruning in several domains, but retention is not comprehensively driven by sensitive-data classification. |
| V14.2.8 | **PARTIAL** | Direct-Xfer supports EXIF/GPS metadata removal, but repository evidence does not yet prove sensitive metadata is removed by default for every user-submitted file unless explicitly consented. |
| V14.3.1 | **PARTIAL** | Server sessions are invalidated on logout, but authenticated browser/PWA state and the optional remembered-credential vault are not comprehensively cleared with session termination. |
| V14.3.2 | **PARTIAL** | Many authenticated/security responses explicitly use `no-store`; full authenticated-response cache-control coverage remains to be verified. |
| V14.3.3 | **FAIL** | The optional login vault deliberately stores an encrypted username/password credential in IndexedDB; ASVS permits browser storage only for session tokens, not reusable passwords. |

## V15 — Secure Coding and Architecture

| Requirement | Status | Evidence / gap |
|---|---|---|
| V15.1.1 | **FAIL** | No documented risk-based remediation SLA exists for vulnerable third-party components and routine library updates. |
| V15.1.2 | **PARTIAL** | `package-lock.json`, pinned container/tool versions and OpenVEX improve inventory/provenance, but a maintained complete SBOM is not currently part of the repository evidence. |
| V15.1.3 | **PARTIAL** | OCR, ZIP, hashing, connector and upload work have explicit caps/queues/timeouts, but resource-intensive functionality is not comprehensively documented. |
| V15.1.4 | **FAIL** | Third-party libraries considered risky are not formally identified/documented. |
| V15.1.5 | **FAIL** | Dangerous functionality such as child-process/native-tool, filesystem and outbound-network boundaries is not maintained as a formal inventory. |
| V15.2.1 | **REVIEW** | Dependency/container security hardening and scanning exist, but compliance cannot be proven without a documented remediation SLA plus current scanner results. |
| V15.2.2 | **PARTIAL** | Resource-heavy paths use queues, caps and timeouts, but there is no complete documented availability strategy to verify against. |
| V15.2.3 | **PARTIAL** | The production Docker image omits tests/build tools and removes unused binaries, but some operational scripts/tooling remain and each distribution target needs minimality review. |
| V15.2.4 | **PARTIAL** | npm uses a lockfile and rclone/Go/container inputs are pinned/verified; a formal trusted-repository/dependency-confusion policy is still missing. |
| V15.2.5 | **PARTIAL** | Docker privilege dropping/no-new-privs plus constrained native-tool invocations provide isolation, but risky-component/dangerous-function controls are not formally mapped. |
| V15.3.1 | **PARTIAL** | Public/decorated projections return selected fields in many APIs, but every object response has not been exhaustively checked for over-posting/over-return. |
| V15.3.2 | **PARTIAL** | The Google OAuth broker client explicitly rejects redirects, but every backend outbound HTTP client has not yet been verified against the no-follow policy. |
| V15.3.3 | **PARTIAL** | Controllers normalize/allowlist many accepted properties rather than blindly persisting request bodies, but an exhaustive mass-assignment review is pending. |
| V15.3.4 | **PASS** | Client-IP resolution delegates to Express only under configured trusted-proxy policy and otherwise uses the socket peer, avoiding raw spoofable X-Forwarded-For use. |
| V15.3.5 | **PARTIAL** | Security boundaries perform explicit type/range checks and strict comparisons broadly, but JavaScript's dynamic type surface has not been exhaustively reviewed. |
| V15.3.6 | **PARTIAL** | Sensitive maps often use `Map`, `Set` or null-prototype objects and state is shape-validated, but a repository-wide prototype-pollution review remains pending. |
| V15.3.7 | **REVIEW** | Query/body/cookie/header parsing is separated in most handlers, but HTTP parameter-pollution behavior requires explicit duplicate-parameter testing. |
| V15.4.1 | **PARTIAL** | Node's main state is single-threaded and asynchronous race-sensitive operations increasingly use dedicated locks/generations, but all shared mutable objects are not yet mapped. |
| V15.4.2 | **PARTIAL** | Realpath/lstat checks and transactional file operations reduce filesystem TOCTOU exposure, but a complete open-by-handle/atomicity review is still required. |
| V15.4.3 | **PARTIAL** | Domain-owned lock sets/maps and deterministic lock ordering exist in high-risk paths, but consistency/deadlock behavior is not yet proven globally. |
| V15.4.4 | **PARTIAL** | Bounded password/OCR/ZIP/upload work limits starvation risk, but fairness/resource-allocation guarantees are not formally defined. |

## V16 — Security Logging and Error Handling

| Requirement | Status | Evidence / gap |
|---|---|---|
| V16.1.1 | **FAIL** | There is no formal logging inventory documenting each layer, event set, format, storage, use, access control and retention. |
| V16.2.1 | **PASS** | Security audit entries include sequence/time, action, actor/account, role, IP and detail metadata suitable for timeline reconstruction. |
| V16.2.2 | **MANUAL** | Audit timestamps are server epoch/UTC-compatible, but synchronization of the host/container clock requires deployment evidence. |
| V16.2.3 | **FAIL** | Without the required logging inventory, it cannot be verified that logs are written/broadcast only to documented sinks. |
| V16.2.4 | **PASS** | The security audit chain uses structured JSON records and stable fields suitable for machine correlation/export. |
| V16.2.5 | **PARTIAL** | Known credential/token diagnostics are redacted and audit details are bounded, but every console/audit path has not yet been classified against sensitive-data logging rules. |
| V16.3.1 | **PARTIAL** | Password/TOTP/passkey successes and failures are audited, but factor/method metadata is not yet normalized for every authentication operation. |
| V16.3.2 | **FAIL** | Failed authorization is not comprehensively logged, and L3 requires logging all authorization decisions including sensitive-data access. |
| V16.3.3 | **PARTIAL** | Many security-control events (DLP, ransomware, auth, rate-limit related activity) are logged, but every validation/business/anti-automation bypass attempt is not covered. |
| V16.3.4 | **PARTIAL** | Unexpected HTTP/service errors and several TLS/persistence failures are logged, but security-control failure logging is not centrally exhaustive. |
| V16.4.1 | **PASS** | The tamper-evident journal serializes entries as JSON/canonical fields, so attacker-controlled text cannot break the record structure through raw line injection. |
| V16.4.2 | **PARTIAL** | Audit files use restrictive permissions and HMAC chaining with signed Ed25519 export proofs, but the live log remains on the same host and is not immutable against a fully privileged compromise. |
| V16.4.3 | **FAIL** | Security logs are not securely transmitted by default to a logically separate analysis/detection system. |
| V16.5.1 | **PASS** | The final HTTP error boundary returns generic client errors and avoids stack traces/secrets. |
| V16.5.2 | **PARTIAL** | External-service failures use timeouts, bounded output and graceful error mappings in many integrations, but complete circuit-breaker/degradation behavior is not established. |
| V16.5.3 | **PASS** | Security-sensitive persistence/authentication/authorization paths generally fail closed and transactional mutations commonly roll back on error. |
| V16.5.4 | **PASS** | Express has a final error boundary and the lifecycle service installs last-resort `uncaughtException`/`unhandledRejection` handling with controlled shutdown behavior. |

## V17 — WebRTC

| Requirement | Status | Evidence / gap |
|---|---|---|
| V17.1.1 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.1.2 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.1 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.2 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.3 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.4 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.5 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.6 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.7 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.2.8 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.3.1 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
| V17.3.2 | **N/A** | No WebRTC/TURN/DTLS-SRTP media or signaling stack is present in Direct-Xfer. |
