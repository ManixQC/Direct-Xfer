# Direct-Xfer — OWASP ASVS 5.0.0 Level 3 requirement matrix

Audit date: 2026-08-25
Standard: OWASP ASVS 5.0.0 Level 3 (L3 includes applicable L1 and L2 requirements)
Repository: `ManixQC/Direct-Xfer`
Initial historical baseline: `3d2c0b5c668c9136a05490b25b76f4166a5940e8`
Baseline input: Direct-Xfer `1.70.23` ASVS-updated archive
Current audited source snapshot: Direct-Xfer `1.71.42` release
Baseline archive SHA-256: `6ed5f230e1e73e540a00dc545d3d0098946a8a75257423041492875fe8ef59cb`
ASVS regression verification: `node --test test/asvs-l3-*.test.js` — 96 passed, 0 failed, 0 skipped
Full regression verification: all 190 `test/*.test.js` files — 1139 passed, 0 failed, 0 skipped
Static source verification: `npm run security:static-audit` — PASS (127 production JS files; 10 reviewed decoder sites)
Windows runtime integrity: `node scripts/sync-windows-runtime-manifest.js --check` — PASS (103 entries; 0 stale hashes)

## Coverage

This is the requirement-by-requirement working matrix. **All 345 ASVS 5.0.0 requirements have now been individually triaged.** PASS means the requirement is enforced by source/runtime controls or by a mandatory machine-verifiable, signed deployment-evidence predicate. A generic source archive is not itself proof that a particular deployment passed those predicates; `ASVS_L3_MODE` fails closed when required deployment evidence is missing, stale, forged, from another release/origin, or does not satisfy the requirement-specific observation. Every N/A decision remains subject to independent review before a compliance claim.

| Status | Count |
|---|---:|
| PASS | 253 |
| PARTIAL | 0 |
| FAIL | 0 |
| N/A | 92 |
| REVIEW | 0 |
| MANUAL | 0 |
| **Total** | **345** |

Status meanings and remediation priorities are defined in `security/ASVS-5.0.0-L3-AUDIT.md`.

## V1 — Encoding and Sanitization

| Requirement | Status | Evidence / gap |
|---|---|---|
| V1.1.1 | **PASS** | `scripts/asvs-static-audit.js` inventories every production `decodeURIComponent` boundary, forbids alternate/legacy URL parsers and fails on unreviewed decoder sites; canonical query parsing is enforced before Express in L3. |
| V1.1.2 | **PASS** | Repository-verifiable closure: final-step contextual encoding. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.1.2) with reviewed anchors `lib/core-utils.js`, `lib/server/public-pages.js`, `lib/text-render.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.2.1 | **PASS** | Repository-verifiable closure: HTML/header encoding and nosniff. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.2.1) with reviewed anchors `lib/server/http-application.js`, `lib/core-utils.js`, `lib/server/download-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.2.2 | **PASS** | Repository-verifiable closure: dynamic URL validation/allowlisting. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.2.2) with reviewed anchors `lib/server/asvs-l3-policy.js`, `lib/server/public-share-routes.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.2.3 | **PASS** | Repository-verifiable closure: safe JSON/script serialization. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.2.3) with reviewed anchors `lib/server/public-pages.js`, `lib/server/http-application.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.2.4 | **PASS** | Cloudflare D1 queries use `prepare(...).bind(...)`; the main application primarily uses file/in-memory state rather than query languages. |
| V1.2.5 | **PASS** | Native tools are invoked with `spawn`/`execFile` argument arrays and without a shell; connector paths/remotes are positively validated. |
| V1.2.6 | **N/A** | No LDAP query functionality is present in the audited repository. |
| V1.2.7 | **N/A** | No XPath query engine is present in the audited repository. |
| V1.2.8 | **N/A** | No LaTeX processor is present in the audited repository. |
| V1.2.9 | **PASS** | Repository-wide production-source search contains no dynamic `RegExp(...)` construction; regex patterns are fixed literals/allowlisted mappings, preventing attacker-controlled regular-expression syntax. |
| V1.2.10 | **PASS** | `csvField()` follows RFC 4180 quoting and prefixes spreadsheet-dangerous leading `=`, `+`, `-`, `@`, tab, CR and NUL characters before export. |
| V1.3.1 | **N/A** | No WYSIWYG/HTML authoring feature accepting arbitrary HTML was identified. |
| V1.3.2 | **PASS** | Repository search found no use of `eval()` or equivalent general-purpose dynamic code execution on untrusted input. |
| V1.3.3 | **PASS** | Repository-verifiable closure: dangerous-context restrictions. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.3.3) with reviewed anchors `scripts/asvs-static-audit.js`, `lib/server/asvs-l3-policy.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.3.4 | **PASS** | `lib/file-type-policy.js` treats uploaded SVG as passive content and rejects scriptable/active elements, event attributes, external references, script URLs, external CSS URLs, DOCTYPE and ENTITY declarations before acceptance in L3. |
| V1.3.5 | **PASS** | `lib/text-render.js` escapes the complete Markdown/BBCode-like source before reintroducing only allowlisted markup; generated links are limited to HTTP(S) and receive `noopener nofollow`. |
| V1.3.6 | **PASS** | L3 outbound HTTP(S), OAuth/broker, backup/storage, webhook, SMTP and remote-audit targets pass through the centralized egress allowlist; wildcard startup policy is rejected and security-sensitive HTTP redirects are refused. |
| V1.3.7 | **N/A** | No user-defined server-side template source is accepted by Direct-Xfer. |
| V1.3.8 | **N/A** | JNDI is not used. |
| V1.3.9 | **N/A** | Memcache is not used. |
| V1.3.10 | **PASS** | Source review found no attacker-controlled format-string interpreter. Logging/formatting uses fixed format strings or ordinary interpolation; deployment shell formatting uses fixed `printf` formats. |
| V1.3.11 | **PASS** | SMTP notification addresses/header values pass through `sanitizeMailHeader()`, which rejects CR/LF/NUL; L3 SMTP destinations are egress-allowlisted and TLS is required. |
| V1.3.12 | **PASS** | Repository-wide regex review completed: production code contains no dynamic `RegExp(...)`, `eval()` or `new Function()` construction; `security:static-audit` continuously gates those ReDoS-enabling patterns and complex input processors remain size-bounded. |
| V1.4.1 | **PASS** | Server code is JavaScript/Node.js and managed C# launcher code; no unsafe native memory manipulation is part of the application codebase. |
| V1.4.2 | **PASS** | Repository-verifiable closure: bounded integer/range policy. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.4.2) with reviewed anchors `security/ASVS-L3-SECURITY-SPEC.md`, `lib/server/config.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.4.3 | **PASS** | Repository-verifiable closure: resource lifecycle cleanup. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.4.3) with reviewed anchors `lib/server/lifecycle-service.js`, `lib/server/storage-connector-job-service.js`, `lib/server/network-services.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.5.1 | **N/A** | No XML parser accepting untrusted XML was identified. |
| V1.5.2 | **PASS** | Repository-verifiable closure: shape-checked restore/deserialization. Guarded by `scripts/asvs-l3-partial-audit.js` (V1.5.2) with reviewed anchors `lib/server/state-store.js`, `lib/server/restore-service.js`, `scripts/asvs-l3-partial-audit.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V1.5.3 | **PASS** | `security:static-audit` enforces the reviewed parser inventory: WHATWG URL/URLSearchParams are used for URL/query parsing, cookie decoding is centralized, alternate `querystring`/legacy URL parsers and unexpected decode sites fail the gate. |

## V2 — Validation and Business Logic

| Requirement | Status | Evidence / gap |
|---|---|---|
| V2.1.1 | **PASS** | Normative application-wide input-validation rules and expected canonical data forms are documented in `security/ASVS-L3-SECURITY-SPEC.md` §1 and enforced at backend boundaries. |
| V2.1.2 | **PASS** | Cross-field/contextual invariants for paths, dates, quotas, WebAuthn, restore/import and credential mutations are documented in `security/ASVS-L3-SECURITY-SPEC.md` §1. |
| V2.1.3 | **PASS** | Business limits, quotas, expiry, concurrency, parser/body caps and L3 mandatory upload limits are consolidated in `security/ASVS-L3-SECURITY-SPEC.md` §1. |
| V2.2.1 | **PASS** | Repository-verifiable closure: positive server-side validation. Guarded by `scripts/asvs-l3-partial-audit.js` (V2.2.1) with reviewed anchors `security/ASVS-L3-SECURITY-SPEC.md`, `lib/server/http-application.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V2.2.2 | **PASS** | Security-relevant validation is performed in trusted backend services/routes rather than relying on browser-only validation. |
| V2.2.3 | **PASS** | Repository-verifiable closure: cross-field invariants. Guarded by `scripts/asvs-l3-partial-audit.js` (V2.2.3) with reviewed anchors `security/ASVS-L3-SECURITY-SPEC.md`, `lib/server/share-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V2.3.1 | **PASS** | Repository-verifiable closure: server-side multi-step sequencing. Guarded by `scripts/asvs-l3-partial-audit.js` (V2.3.1) with reviewed anchors `lib/server/webauthn-service.js`, `oauth-broker/server.js`, `lib/server/storage-connector-config.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V2.3.2 | **PASS** | Application-wide parser, quota, expiry, concurrency, upload byte/file/pixel and per-sender L3 limits are consolidated normatively in `security/ASVS-L3-SECURITY-SPEC.md` §1 and enforced by backend services. |
| V2.3.3 | **PASS** | Repository-verifiable closure: transaction/rollback boundaries. Guarded by `scripts/asvs-l3-partial-audit.js` (V2.3.3) with reviewed anchors `lib/server/share-service.js`, `lib/server/pwa-routes.js`, `lib/server/admin-photo-routes.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V2.3.4 | **PASS** | Repository-verifiable closure: limited-resource locks. Guarded by `scripts/asvs-l3-partial-audit.js` (V2.3.4) with reviewed anchors `lib/server/photo-service.js`, `lib/auth-utils.js`, `lib/server/storage-connector-job-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V2.3.5 | **N/A** | The Direct-Xfer threat model does not define a business transaction requiring multi-person approval; high-impact administrator mutations instead require role authorization and recent phishing-resistant step-up authentication. |
| V2.4.1 | **PASS** | Repository-verifiable closure: anti-automation/cost controls. Guarded by `scripts/asvs-l3-partial-audit.js` (V2.4.1) with reviewed anchors `lib/server/public-abuse-service.js`, `lib/auth-utils.js`, `lib/server/upload-reception-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V2.4.2 | **N/A** | No Direct-Xfer security control depends on a user completing a transaction within a human timing window; protocol challenges and sessions use server-enforced expirations instead. |

## V3 — Web Frontend Security

| Requirement | Status | Evidence / gap |
|---|---|---|
| V3.1.1 | **PASS** | The L3 browser capability baseline, required secure-context features and fail-closed behavior are defined in `security/ASVS-L3-SECURITY-SPEC.md` §2. |
| V3.2.1 | **PASS** | Downloads default to attachment or `application/octet-stream` with `nosniff`; inline rendering is explicitly controlled for known preview types. |
| V3.2.2 | **PASS** | Repository-verifiable closure: safe DOM output policy. Guarded by `scripts/asvs-l3-partial-audit.js` (V3.2.2) with reviewed anchors `public/app.js`, `pwa/app.js`, `lib/server/http-application.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V3.2.3 | **PASS** | Client globals were reviewed; pinned-library resolution now requires `Object.prototype.hasOwnProperty.call(window, globalName)` before reading the global, preventing named-element DOM clobbering. Regression: `asvs-l3-review-closure-1.70.24.test.js`. |
| V3.3.1 | **PASS** | Authentication/session bearer cookies are Secure in the L3 HTTPS-only profile. Non-sensitive language/install preference cookies are not authentication cookies and do not carry session credentials. |
| V3.3.2 | **PASS** | Session/PWA cookies use `SameSite=Lax`; state-changing operations additionally require CSRF tokens and/or same-origin checks. |
| V3.3.3 | **PASS** | L3 HTTPS administrator/PWA bearer cookies use `__Host-sid`, `__Host-dxpwa` and `__Host-dxpwaid` with Path=/ and no Domain attribute; legacy bearer names are removed during migration. |
| V3.3.4 | **PASS** | Session and PWA bearer cookies are `HttpOnly`, and bearer values are not returned in normal response bodies. |
| V3.3.5 | **PASS** | Authentication cookies have fixed, small token formats far below the 4096-byte cookie limit. |
| V3.4.1 | **PASS** | `ASVS_L3_MODE` rejects application HTTP and emits one-year HSTS with `includeSubDomains; preload`; weaker Local-CA/plain-LAN compatibility behavior is outside the L3 profile. |
| V3.4.2 | **PASS** | No permissive CORS policy or reflected `Access-Control-Allow-Origin` behavior was found in the application. |
| V3.4.3 | **PASS** | The common HTTP boundary emits a per-response cryptographic CSP nonce, nonce-only `style-src` / `style-src-elem`, `script-src-attr 'none'`, `object-src 'none'` and `base-uri 'none'`. Legacy style attributes are isolated to `style-src-attr`; generated public `<style>` blocks receive the response nonce. Static administrator/PWA HTML contains no executable inline script; the first-paint theme bootstrap is served as same-origin `/theme-init.js`, with regression coverage. |
| V3.4.4 | **PASS** | The common HTTP boundary emits `X-Content-Type-Options: nosniff`. |
| V3.4.5 | **PASS** | The common HTTP boundary emits `Referrer-Policy: no-referrer`. |
| V3.4.6 | **PASS** | CSP includes `frame-ancestors 'none'` for the common web boundary. |
| V3.4.7 | **PASS** | CSP includes `report-uri /__csp-report`; the reporting endpoint is same-origin, rate-limited, body-bounded, non-cacheable and records bounded security telemetry. |
| V3.4.8 | **PASS** | The common HTTP boundary emits `Cross-Origin-Opener-Policy: same-origin`. |
| V3.5.1 | **PASS** | Mutating administrator requests require `X-CSRF-Token`; paired PWA mutations use per-device CSRF and same-origin controls. |
| V3.5.2 | **N/A** | Direct-Xfer does not rely on CORS preflight as the primary protection for sensitive same-origin functionality. |
| V3.5.3 | **PASS** | Fetch Metadata is enforced centrally: cross-site `/api` requests are rejected even for safe GET/navigation requests, while state-changing requests are rejected globally. Sensitive mutations use non-safe methods. |
| V3.5.4 | **PASS** | Origin-separation rationale is documented: admin/PWA/public routes intentionally share the Direct-Xfer origin while the OAuth broker is a separate origin; CSP, CSRF, Fetch Metadata and independent broker state/PKCE protect cross-surface transitions. |
| V3.5.5 | **PASS** | `public/oauth-bridge.js` rejects `postMessage` events unless both `event.origin === location.origin` and `event.source === window.opener`. |
| V3.5.6 | **PASS** | No JSONP implementation was found. |
| V3.5.7 | **PASS** | Authenticated data is not emitted through JavaScript resource responses. |
| V3.5.8 | **PASS** | Authenticated/API resources are protected by Fetch Metadata checks and restrictive `Cross-Origin-Resource-Policy: same-origin` behavior in the common HTTP application layer. |
| V3.6.1 | **PASS** | Client assets are self-hosted in the repository; no external CDN dependency requiring SRI was found. |
| V3.7.1 | **PASS** | The web client uses currently supported browser technologies rather than Flash/ActiveX/Silverlight/Java applets. |
| V3.7.2 | **PASS** | External OAuth destinations are never automatic: `public/oauth-bridge.js` validates HTTPS URLs and requires explicit `window.confirm()` before `location.replace()` for any external origin, satisfying the automatic-redirect restriction. |
| V3.7.3 | **PASS** | The OAuth bridge requires an explicit user confirmation before navigating to an external HTTPS destination, providing a cancel path rather than automatic redirection. |
| V3.7.4 | **PASS** | L3 startup requires a current signed deployment-evidence bundle whose V3.7.4 observation is produced by the HSTS preload check and proves the public domain is preloaded; evidence is release/origin bound, SHA-256 integrity checked and expires within seven days. |
| V3.7.5 | **PASS** | L3 administrator access fails closed when WebAuthn/passkey support is unavailable; the protected admin router will not downgrade to password/TOTP authorization. |

## V4 — API and Web Service

| Requirement | Status | Evidence / gap |
|---|---|---|
| V4.1.1 | **PASS** | Repository-verifiable closure: response content type guard. Guarded by `scripts/asvs-l3-partial-audit.js` (V4.1.1) with reviewed anchors `lib/server/http-application.js`, `lib/server/http-application.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V4.1.2 | **PASS** | L3 rejects application HTTP and requires signed active HTTP evidence proving that only intended browser endpoints redirect to HTTPS while API/service HTTP is not transparently redirected. |
| V4.1.3 | **PASS** | L3 requires an explicit IP/CIDR `TRUST_PROXY` list (boolean/hop-count trust is rejected) and signed active evidence proving untrusted forwarded headers are ignored and trusted intermediary headers are authenticated. |
| V4.1.4 | **PASS** | A global HTTP-method allowlist (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`) rejects unsupported methods such as TRACE with 405 before application routes. |
| V4.1.5 | **N/A** | Direct-Xfer has no business transaction requiring application-layer per-message digital signatures in addition to authenticated TLS/session controls; signed audit proofs are integrity evidence, not transaction authorization. |
| V4.2.1 | **PASS** | Signed active HTTP evidence is mandatory in L3 and must prove CL/TE ambiguity rejection, duplicate Content-Length rejection and consistent message-boundary handling across the deployed edge and origin. |
| V4.2.2 | **PASS** | Generated response framing is covered by regression tests: Direct-Xfer does not set conflicting `Transfer-Encoding`, and explicit `Content-Length` values are derived from exact bytes or bounded file ranges. Intermediary request-smuggling behavior is tracked separately under V4.2.1/V4.2.3/V4.2.4 as deployment evidence. |
| V4.2.3 | **PASS** | If HTTP/2 or HTTP/3 is exposed at the mandatory external TLS edge, the signed active probe must prove connection-specific headers are rejected before L3 startup succeeds. |
| V4.2.4 | **PASS** | The signed active edge probe must prove HTTP/2/3 header names/values containing CR/LF sequences are rejected before L3 startup succeeds. |
| V4.2.5 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §8 inventories outbound integrations and requires bounded timeout/body/retry/concurrency behavior; L3 egress enforcement and no-follow behavior are wired into the security-sensitive HTTP clients. |
| V4.3.1 | **N/A** | No GraphQL API is present. |
| V4.3.2 | **N/A** | No GraphQL API is present. |
| V4.4.1 | **N/A** | No WebSocket service is present; Direct-Xfer uses HTTP/SSE/push mechanisms. |
| V4.4.2 | **N/A** | No WebSocket handshake is present. |
| V4.4.3 | **N/A** | No dedicated WebSocket session tokens are used. |
| V4.4.4 | **N/A** | No transition from HTTPS sessions to WebSocket channels is implemented. |

## V5 — File Handling

| Requirement | Status | Evidence / gap |
|---|---|---|
| V5.1.1 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §1 defines the L3 file acceptance model: executable/script extensions are blocked, recognized formats must match magic/container/text structure, SVG is passive-only, ClamAV fails closed, and byte/file/pixel/per-sender limits are mandatory. |
| V5.2.1 | **PASS** | Upload paths use bounded streaming, configured maximum byte limits, concurrency limits and idle timeouts. |
| V5.2.2 | **PASS** | In `ASVS_L3_MODE`, untrusted reception uploads require extension/content correspondence through `lib/file-type-policy.js`; executable masquerading and unknown/unverifiable file types are rejected. |
| V5.2.3 | **N/A** | Direct-Xfer does not server-side extract uploaded archives; ZIP inspection is a bounded central-directory preview only. |
| V5.2.4 | **PASS** | In `ASVS_L3_MODE`, reception upload principals have mandatory file-count and byte caps via `ASVS_L3_MAX_FILES_PER_SENDER` and `ASVS_L3_MAX_BYTES_PER_SENDER`, with serialized final quota accounting. |
| V5.2.5 | **N/A** | Uploaded archives are not extracted by the application, so archive-contained symlinks are not materialized server-side. |
| V5.2.6 | **PASS** | Image upload boundaries enforce `IMAGE_MAX_PIXELS` using decoded dimensions before further image processing in both administrator and PWA image routes. |
| V5.3.1 | **PASS** | Uploaded/generated content is stored outside the static application tree and served through controlled download/preview routes, not executed as server code. |
| V5.3.2 | **PASS** | Managed storage uses generated/validated names, path containment and realpath/symlink checks on sensitive local targets. |
| V5.3.3 | **N/A** | The application does not extract user archives, so there is no server-side archive path materialization susceptible to Zip Slip. |
| V5.4.1 | **PASS** | Download responses set `Content-Disposition` and use server-selected/validated filenames. |
| V5.4.2 | **PASS** | Download filenames use RFC 6266 `filename*=UTF-8''...` with `encodeURIComponent`, while unsafe path/control characters are rejected at relevant boundaries. |
| V5.4.3 | **PASS** | ClamAV is mandatory in L3 startup policy; public upload scan errors fail closed and the upload is quarantined/removed rather than accepted. |

## V6 — Authentication

| Requirement | Status | Evidence / gap |
|---|---|---|
| V6.1.1 | **PASS** | Credential throttling, bounded password hashing, breached/context password checks and L3 authentication assurance are consolidated in `security/ASVS-L3-SECURITY-SPEC.md` §3. |
| V6.1.2 | **PASS** | The enforced context-specific password list is documented in the audit and implemented in `lib/auth-utils.js`: Direct-Xfer product-name variants plus normalized account identifiers supplied by the account context. |
| V6.1.3 | **PASS** | Authentication pathways and their L3 assurance roles are documented together in `security/ASVS-L3-SECURITY-SPEC.md` §3; only phishing-resistant passkey sessions authorize the admin API. |
| V6.2.1 | **PASS** | User-set passwords are required to be at least 8 characters. |
| V6.2.2 | **PASS** | Authenticated users can change their password. |
| V6.2.3 | **PASS** | Normal password change requires both current and new passwords; the forced first-use change is a controlled bootstrap exception. |
| V6.2.4 | **PASS** | Password creation/change checks a local obvious/common-password denylist and the HIBP Pwned Passwords corpus using k-anonymity; breach-check failures fail closed. |
| V6.2.5 | **PASS** | No composition rules require particular upper/lowercase, digit or special-character classes. |
| V6.2.6 | **PASS** | Password inputs in the shipped login/settings interfaces are masked password fields. |
| V6.2.7 | **PASS** | No code blocks paste or browser/external password-manager usage. |
| V6.2.8 | **PASS** | Password verification uses the supplied string without trimming, case transformation or truncation within the 512-character safety limit. |
| V6.2.9 | **PASS** | The password implementation accepts well over 64 characters (up to the 512-character abuse-prevention bound). |
| V6.2.10 | **PASS** | Direct-Xfer does not impose periodic password expiration. |
| V6.2.11 | **PASS** | Password validation rejects documented Direct-Xfer-specific terms and normalized account-context terms (for example username, with email/display-name/extra terms when supplied). |
| V6.2.12 | **PASS** | Password creation/change checks the HIBP Pwned Passwords corpus over HTTPS using a bounded k-anonymity query and rejects breached values; lookup failure fails closed. |
| V6.3.1 | **PASS** | Login brute-force defense combines per-source failure windows/lockout with a bounded asynchronous scrypt queue. |
| V6.3.2 | **PASS** | Fresh L3 deployments generate a random owner name and L3 startup now refuses predictable persisted owner names (`admin`, `administrator`, `root`, `owner`, `direct-xfer`, `directxfer`) until migrated. |
| V6.3.3 | **PASS** | L3 WebAuthn registration requires direct packed attestation, UV, a configured hardware AAGUID allowlist and a certificate chain anchored in pinned SHA-256 trust roots loaded from `ASVS_L3_ATTESTATION_ROOT_FILES`; certificate validity/CA structure, leaf algorithm strength and signatures are verified. Client-reported transports are informational only. Backup/syncable credentials are rejected and only stored hardware-attested passkeys authorize L3 access. |
| V6.3.4 | **PASS** | All documented authentication pathways have explicit L3 purpose/assurance; only passkey sessions can authorize the administrator API, preventing a weaker undocumented bypass. |
| V6.3.5 | **PASS** | Suspicious/new-device authentication activity is audited and can generate security-center notifications. |
| V6.3.6 | **PASS** | Email is not used as an authentication factor. |
| V6.3.7 | **PASS** | Password, TOTP and passkey additions/removals/resets create persistent `auth-credential-changed` security notifications in addition to audit records; affected sessions are invalidated as applicable. |
| V6.3.8 | **PASS** | WebAuthn login options use a fixed 20-descriptor shape for valid and unknown/ineligible usernames, pad real credentials with deterministic phantom IDs, omit transport hints, return the same 200 structure, and perform phantom-work construction on both paths. |
| V6.4.1 | **PASS** | Repository-verifiable closure: temporary credential lifecycle. Guarded by `scripts/asvs-l3-partial-audit.js` (V6.4.1) with reviewed anchors `lib/server/account-service.js`, `lib/server/admin-account-routes.js`, `lib/server/account-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V6.4.2 | **PASS** | No password hints or knowledge-based secret questions are present. |
| V6.4.3 | **PASS** | Owner-initiated reset generates a temporary random credential rather than letting the owner choose the user password, preserves factor records, revokes existing sessions, and L3 administrative access remains blocked until passkey authentication. |
| V6.4.4 | **N/A** | L3 deliberately exposes no lost-factor identity-recovery path after initial hardware enrollment: factor management is permanently locked behind recent phishing-resistant passkey authentication and deletion/unbinding of the last approved hardware passkey is refused. A lost final factor therefore cannot be recovered through Direct-Xfer and no application identity-proofing recovery process exists to verify. |
| V6.4.5 | **N/A** | Application-managed authentication factors do not have a scheduled expiration that would require renewal notices. |
| V6.4.6 | **PASS** | Administrative reset no longer lets an owner choose another user's password: the server generates a high-entropy temporary credential, forces replacement and invalidates existing sessions. |
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
| V6.7.1 | **PASS** | WebAuthn assertion public keys are stored in protected application state; private authentication keys remain authenticator-side and verification rejects malformed/weak key material. |
| V6.7.2 | **PASS** | WebAuthn challenges are 32 random bytes (256 bits), generated server-side and bounded by a challenge lifetime. |
| V6.8.1 | **N/A** | Google OAuth is used for storage connectors, not as an application-login identity provider. |
| V6.8.2 | **N/A** | Direct-Xfer does not consume external IdP authentication assertions for user login. |
| V6.8.3 | **N/A** | SAML is not used. |
| V6.8.4 | **N/A** | No external IdP is used to establish Direct-Xfer user sessions. |

## V7 — Session Management

| Requirement | Status | Evidence / gap |
|---|---|---|
| V7.1.1 | **PASS** | Absolute lifetime, inactivity timeout, concurrent-session cap and strong-auth freshness policy are documented in `security/ASVS-L3-SECURITY-SPEC.md` §4 and enforced by the session service. |
| V7.1.2 | **PASS** | Concurrent administrator sessions are capped per account: default 10, configurable within 1–100; excess creation invalidates the oldest active sessions. This policy is documented in the audit. |
| V7.1.3 | **N/A** | Direct-Xfer does not participate in a federated SSO session ecosystem. |
| V7.2.1 | **PASS** | Session validation is performed by the backend stateful session service. |
| V7.2.2 | **PASS** | Administrator sessions use dynamically generated reference tokens rather than static API secrets. |
| V7.2.3 | **PASS** | Session IDs are generated from 32 random bytes (256 bits). |
| V7.2.4 | **PASS** | Authentication invalidates any presented previous session and issues a fresh session token. |
| V7.3.1 | **PASS** | Administrator sessions enforce an independent inactivity timeout, 30 minutes by default. |
| V7.3.2 | **PASS** | Administrator sessions independently enforce an absolute maximum lifetime. |
| V7.4.1 | **PASS** | Logout/expiry removes backend session state and closes associated session streams. |
| V7.4.2 | **PASS** | Deleted-account detection and account-scoped invalidation terminate active sessions. |
| V7.4.3 | **PASS** | Password, TOTP and passkey factor changes invalidate sibling sessions for the affected account while preserving the current authenticated session where appropriate. |
| V7.4.4 | **PASS** | Authenticated web/PWA interfaces expose logout functionality. |
| V7.4.5 | **PASS** | Owner/admin security controls can revoke individual sessions, and service helpers support account/all-session invalidation. |
| V7.5.1 | **PASS** | L3 classifies password/TOTP/passkey factor mutations as sensitive routes requiring recent phishing-resistant authentication; replacing an established passkey also requires fresh passkey authentication. |
| V7.5.2 | **PASS** | Each authenticated role can view its own sessions and revoke them after immediate credential re-authentication; owner/admin may additionally revoke other users' sessions. |
| V7.5.3 | **PASS** | L3 sensitive administrator mutations require recent phishing-resistant strong authentication; the standard UI performs a fresh passkey ceremony on `reauth-required` and retries once. |
| V7.6.1 | **N/A** | No federated IdP/RP session lifecycle is used. |
| V7.6.2 | **PASS** | A new session is created only after an explicit successful user authentication action. |

## V8 — Authorization

| Requirement | Status | Evidence / gap |
|---|---|---|
| V8.1.1 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §4 defines role/function/object authorization, stable-account ownership and the centralized administrator role gate. |
| V8.1.2 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §4 defines field-level restrictions: internal secrets/security credentials are excluded from public/decorated DTOs and writable fields are route-allowlisted rather than mass-assigned. |
| V8.1.3 | **PASS** | The complete set of contextual attributes used for security decisions is documented in `security/ASVS-L3-SECURITY-SPEC.md` §4. |
| V8.1.4 | **PASS** | The L3 adaptive decision policy is documented: authentication downgrade, stale strong-auth age, IP/User-Agent drift and unapproved public-link access cause challenge or denial. |
| V8.2.1 | **PASS** | Administrative functions are protected at trusted route/service boundaries with explicit role middleware. |
| V8.2.2 | **PASS** | Repository-verifiable closure: object-level authorization. Guarded by `scripts/asvs-l3-partial-audit.js` (V8.2.2) with reviewed anchors `lib/server/admin-router.js`, `lib/server/pwa-routes.js`, `lib/server/public-access-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V8.2.3 | **PASS** | Repository-verifiable closure: field-level authorization/projections. Guarded by `scripts/asvs-l3-partial-audit.js` (V8.2.3) with reviewed anchors `lib/server/share-presentation-service.js`, `security/ASVS-L3-SECURITY-SPEC.md` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V8.2.4 | **PASS** | In L3, contextual controls are applied at authentication and continuously: admin authorization requires passkey assurance, strong-auth freshness is re-evaluated for sensitive mutations, and IP/User-Agent drift invalidates the session. |
| V8.3.1 | **PASS** | Authorization is enforced by backend route/service code rather than client-side JavaScript. |
| V8.3.2 | **PASS** | Each session validation refreshes role/username from the current account record and fails closed on invalid role metadata. |
| V8.3.3 | **PASS** | Delegated cloud reads/writes derive connector identity and root from the persisted share capability; `cleanRelativePath()` rejects traversal and out-of-root provider rows are filtered. Read/write confinement is covered by ASVS regression tests. |
| V8.4.1 | **N/A** | Direct-Xfer has multiple accounts but no separate tenant isolation domain in the audited architecture. |
| V8.4.2 | **PASS** | L3 continuously requires the stored hardware-attestation posture at authentication time: hardware-backed flag, non-backup credential, approved AAGUID and pinned attestation-root fingerprint must all still match current policy. |

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
| V10.1.2 | **PASS** | Repository-verifiable closure: OAuth same-browser/session transaction binding. Guarded by `scripts/asvs-l3-partial-audit.js` (V10.1.2) with reviewed anchors `oauth-broker/server.js`, `oauth-broker/server.js`, `lib/server/storage-connector-config.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
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
| V11.1.1 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §6 defines the cryptographic key lifecycle, custody, rotation and migration policy for application data, audit keys, sessions, WebAuthn, TLS and password hashing. |
| V11.1.2 | **PASS** | A maintained crypto inventory is documented in `security/ASVS-L3-SECURITY-SPEC.md` §6 and repository discovery output is generated in `security/security-inventory.json`. |
| V11.1.3 | **PASS** | `npm run security:inventory` provides a repeatable repository-wide discovery mechanism for cryptographic, process, network and filesystem security boundaries. |
| V11.1.4 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` defines the crypto-agility and post-quantum migration posture, including inventory-first replacement and protocol/provider migration planning. |
| V11.2.1 | **PASS** | Cryptographic operations rely on Node.js/OpenSSL Web Crypto primitives and established libraries rather than custom cipher implementations. |
| V11.2.2 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §6 defines the cryptographic inventory and a versioned backward-read/new-write crypto-agility migration rule; `security:inventory` detects cryptographic usage each release. |
| V11.2.3 | **PASS** | L3 TLS validation rejects RSA/RSA-PSS keys below 3072 bits and refuses degraded Local-CA fallback; newly generated Local-CA and leaf RSA material uses the same >=3072-bit floor. |
| V11.2.4 | **PASS** | Repository-verifiable closure: constant-time cryptographic comparisons. Guarded by `scripts/asvs-l3-partial-audit.js` (V11.2.4) with reviewed anchors `lib/core-utils.js`, `lib/server/webauthn-service.js`, `lib/auth-utils.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V11.2.5 | **PASS** | Repository-verifiable closure: fail-closed cryptographic errors. Guarded by `scripts/asvs-l3-partial-audit.js` (V11.2.5) with reviewed anchors `lib/server/state-store.js`, `lib/server/webauthn-service.js`, `security/ASVS-L3-SECURITY-SPEC.md` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V11.3.1 | **PASS** | Application data encryption uses AES-GCM; no ECB or PKCS#1 v1.5 public-key encryption path was identified. |
| V11.3.2 | **PASS** | Application-managed symmetric encryption uses AES-256-GCM. |
| V11.3.3 | **PASS** | Encrypted application/state/broker-secret data uses authenticated encryption (AES-GCM) with integrity tags. |
| V11.3.4 | **PASS** | AES-GCM encryption paths generate a fresh 96-bit random IV for each encryption operation. |
| V11.3.5 | **N/A** | Direct-Xfer does not combine separate encryption and MAC primitives for the same encrypted payload; it uses AEAD. |
| V11.4.1 | **PASS** | The cryptographic policy explicitly permits SHA-256 or stronger for general-purpose security hashing and documents HMAC-SHA1 only as the protocol-mandated TOTP exception. |
| V11.4.2 | **PASS** | Passwords and recovery codes are stored using salted scrypt with bounded asynchronous work. |
| V11.4.3 | **PASS** | Audit integrity/signature support uses SHA-256 digests/HMAC chaining and Ed25519 proof signatures. |
| V11.4.4 | **PASS** | Password and DATA_KEY derivation use approved scrypt with explicitly pinned stretching parameters (`N=16384`, `r=8`, `p=1`, 64 MiB max memory), documented in the L3 crypto policy and covered by regression tests. |
| V11.5.1 | **PASS** | All values intended to be non-guessable authorization/authentication/recovery secrets are generated with Node/Web Crypto CSPRNGs and provide at least 128 bits of entropy in the L3 profile; shorter random identifiers are explicitly classified as non-secret identifiers. Regression coverage protects the minimum entropy floor. |
| V11.5.2 | **PASS** | Randomness uses operating-system backed Node/Web Crypto CSPRNG primitives designed for concurrent demand. |
| V11.6.1 | **PASS** | L3 RSA paths enforce >=3072 bits for TLS and WebAuthn RS256; Ed25519 and approved P-256-family primitives remain within the documented >=128-bit classical-security policy. |
| V11.6.2 | **N/A** | Direct-Xfer implements no application-layer cryptographic key-agreement protocol. TLS key establishment is performed by the mandatory external TLS edge and is verified under V12.1.2; WebAuthn performs public-key signature verification rather than application key exchange. |
| V11.7.1 | **PASS** | L3 startup requires current signed host-hardening evidence whose V11.7.1 predicate proves full memory encryption and unauthorized-process isolation; unsigned, stale, wrong-release or wrong-origin evidence fails closed. |
| V11.7.2 | **PASS** | L3 delegates persistent-state encryption/key custody to the external hardware-backed provider; 1.70.27 additionally forces backups, search indexes and OCR caches through external encryption and purges inherited plaintext caches. Signed host evidence proves processing minimization and re-encryption immediately after use/as soon as feasible. |

## V12 — Secure Communication

| Requirement | Status | Evidence / gap |
|---|---|---|
| V12.1.1 | **PASS** | The application TLS manager explicitly enforces minimum TLS 1.2 and validates L3 server key strength; forward-secrecy/cipher details are enforced by the mandatory signed V12.1.2 active-TLS evidence predicate. |
| V12.1.2 | **PASS** | L3 forbids local TLS private-key termination and requires signed active TLS evidence proving only recommended cipher suites and forward-secret suites are exposed by the external TLS edge. |
| V12.1.3 | **N/A** | Direct-Xfer does not use mTLS client-certificate identities for application authentication/authorization. |
| V12.1.4 | **PASS** | L3 requires signed active TLS evidence proving certificate revocation checking/stapling is enabled at the external TLS edge. |
| V12.1.5 | **PASS** | L3 requires signed DNS/TLS-edge evidence proving ECH is enabled; missing or stale ECH evidence prevents L3 startup. |
| V12.2.1 | **PASS** | When `ASVS_L3_MODE=true`, non-HTTPS application traffic is rejected except the explicitly scoped loopback liveness exception; compatibility-mode LAN HTTP cannot be used to claim the L3 profile. |
| V12.2.2 | **PASS** | L3 requires signed active TLS evidence proving the external-facing certificate is publicly trusted and hostname-verified; local/private-CA TLS termination is not permitted in L3. |
| V12.3.1 | **PASS** | Repository-verifiable closure: encrypted L3 inbound/outbound transport. Guarded by `scripts/asvs-l3-partial-audit.js` (V12.3.1) with reviewed anchors `lib/server/asvs-l3-policy.js`, `lib/server/notification-service.js`, `lib/server/upload-reception-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V12.3.2 | **PASS** | Node HTTPS/fetch/rclone use normal certificate verification; insecure certificate bypass was not identified in built-in OAuth/update flows. |
| V12.3.3 | **N/A** | Direct-Xfer is primarily a monolithic application without internal HTTP microservices requiring a separate service-to-service TLS channel. |
| V12.3.4 | **N/A** | No internal HTTP service mesh or separate internal TLS service trust domain is present. |
| V12.3.5 | **N/A** | No microservice-to-microservice authentication channel is part of the core architecture. |

## V13 — Configuration

| Requirement | Status | Evidence / gap |
|---|---|---|
| V13.1.1 | **PASS** | The L3 external-service/egress inventory in `security/ASVS-L3-SECURITY-SPEC.md` §8 covers update/public-IP, OAuth, SMTP, webhooks, Web Push, rclone connectors, ClamAV and remote audit. |
| V13.1.2 | **PASS** | External-service concurrency/saturation policy, bounded queues, worker limits and provider sizing obligations are documented in `security/ASVS-L3-SECURITY-SPEC.md` §8. |
| V13.1.3 | **PASS** | The L3 external-service policy requires bounded timeout/body, finite retry/concurrency and cleanup; representative saturation limits are documented and implemented by the relevant clients/queues. |
| V13.1.4 | **PASS** | C3 secrets and their rotation/revocation baseline are documented in `security/ASVS-L3-SECURITY-SPEC.md` §§7–8, including immediate rotation on suspected disclosure. |
| V13.2.1 | **PASS** | L3 requires signed backend-identity evidence proving every enabled backend is authenticated and its credential is short-lived or rotated according to policy. |
| V13.2.2 | **PASS** | L3 requires signed backend-identity evidence proving all enabled backend service identities are least-privilege. |
| V13.2.3 | **PASS** | No default privileged service credential such as `root/root` or `admin/admin` is embedded for backend authentication. |
| V13.2.4 | **PASS** | L3 administrator-configurable outbound HTTP(S)/SMTP/storage destinations are constrained by `ASVS_L3_EGRESS_ALLOWLIST`; built-in provider destinations are subject to the same policy and uncontrolled redirects are rejected. |
| V13.2.5 | **PASS** | L3 requires both the application egress allowlist and signed firewall-policy evidence proving default-deny egress with a host/network allowlist equal to or narrower than the application policy. |
| V13.2.6 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §8 defines the outbound connection/resource policy and representative saturation limits; backend clients use bounded timeout/body/concurrency/error handling and L3 no-follow/allowlist controls. |
| V13.3.1 | **PASS** | L3 requires an external crypto command whose self-test proves hardware-backed isolation, non-exportable keys and explicit key handles; signed provider evidence independently confirms the hardware-backed/non-exportable boundary. |
| V13.3.2 | **PASS** | L3 requires signed crypto-provider ACL evidence proving least-privilege access and denied key extraction. |
| V13.3.3 | **PASS** | L3 removes application-process DATA_KEY/audit private keys, delegates state/backup/cache encryption/decryption and audit HMAC/signing plus runtime HMACs to the external hardware-backed provider, disables local TOTP and local S3 signing, forbids local TLS termination, and requires signed provider evidence proving all secret-key operations are isolated with key material never exported. 1.70.27 rejects plaintext/legacy state at runtime and provides offline state/audit/backup migration tools so legacy secrets never re-enter the L3 process. |
| V13.3.4 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` defines expiration/rotation classes for ephemeral credentials, user factors, audit keys, DATA_KEY, OAuth/client secrets, webhooks and connector credentials, plus immediate compromise rotation. |
| V13.4.1 | **PASS** | Repository-verifiable closure: deployment artifact excludes SCM metadata. Guarded by `scripts/asvs-l3-partial-audit.js` (V13.4.1) with reviewed anchors `Dockerfile`, `.github/workflows/build-windows-csharp.yml` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V13.4.2 | **PASS** | Production images set `NODE_ENV=production`; developer/debug middleware is not exposed in the normal server path. |
| V13.4.3 | **PASS** | Express static serving does not enable directory indexes and only serves selected public/PWA trees. |
| V13.4.4 | **PASS** | The common HTTP layer explicitly rejects methods outside the global allowlist, including TRACE, before route handling. |
| V13.4.5 | **PASS** | Diagnostics/security endpoints are authenticated; the unauthenticated health/meta endpoints intentionally expose only limited operational metadata. |
| V13.4.6 | **PASS** | L3 diagnostics suppress backend component/process version details, `x-powered-by` is disabled, and regression coverage verifies that host process/backend component versions are not disclosed. Public Direct-Xfer product release metadata is not backend-component version leakage. |
| V13.4.7 | **PASS** | The web tier serves explicit public/PWA assets/directories with dotfiles ignored rather than exposing the repository/source tree. |

## V14 — Data Protection

| Requirement | Status | Evidence / gap |
|---|---|---|
| V14.1.1 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §7 maintains a C1/C2/C3 data-classification inventory covering public, sensitive and secret Direct-Xfer data. |
| V14.1.2 | **PASS** | The same data-classification policy defines storage, logging, access, retention and rotation requirements for each class. |
| V14.2.1 | **PASS** | In L3, public URL tokens are not sufficient authorization: every public share requires an independent password or approval gate, turning the path token into a resource locator rather than a standalone bearer credential; `Referrer-Policy: no-referrer` remains enforced. |
| V14.2.2 | **PASS** | Authenticated/API responses are centrally marked `Cache-Control: no-store`; application-owned caches holding private state are bounded/lifecycle-managed. Regression coverage verifies the central no-store boundary. Deployment proxy caching is additionally constrained by the L3 deployment checklist. |
| V14.2.3 | **PASS** | No analytics/user-tracking service was identified; sensitive data is sent externally only to explicitly configured functional integrations. |
| V14.2.4 | **PASS** | The C1/C2/C3 data-classification policy defines encryption, minimization, access and retention controls. In L3, `shares.json`, backup bundles, universal-search indexes and OCR caches must be externally encrypted; plaintext state/backups fail closed and inherited plaintext caches are deleted/rebuilt. |
| V14.2.5 | **PASS** | The API namespace terminates missing routes before static fallback, sensitive responses use restrictive caching, and content types are explicitly controlled. |
| V14.2.6 | **PASS** | Repository-verifiable closure: sensitive response minimization. Guarded by `scripts/asvs-l3-partial-audit.js` (V14.2.6) with reviewed anchors `lib/server/share-presentation-service.js`, `lib/server/admin-account-routes.js`, `security/ASVS-L3-SECURITY-SPEC.md` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V14.2.7 | **PASS** | Repository-verifiable closure: classification-driven retention. Guarded by `scripts/asvs-l3-partial-audit.js` (V14.2.7) with reviewed anchors `security/ASVS-L3-SECURITY-SPEC.md`, `lib/server/maintenance-service.js`, `lib/server/notification-center-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V14.2.8 | **PASS** | Repository-verifiable closure: default metadata stripping or explicit consent. Guarded by `scripts/asvs-l3-partial-audit.js` (V14.2.8) with reviewed anchors `lib/photo-utils.js`, `lib/server/admin-photo-routes.js`, `lib/server/pwa-routes.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V14.3.1 | **PASS** | Explicit L3 logout invalidates the server session and clears PWA IndexedDB stores, OPFS queued material, private caches and sensitive local/session storage rather than checkpointing capability-bearing state. |
| V14.3.2 | **PASS** | All `/api` responses are centrally marked `Cache-Control: no-store` / `Pragma: no-cache` before route handling; administrator responses independently apply `no-store`, with regression coverage for the central boundary. |
| V14.3.3 | **PASS** | L3 does not persist reusable passwords or E2E destination keys in browser storage. `/api/meta` advertises `loginPasswordStorageAllowed=false` in L3; both login surfaces keep the remember-password control fail-closed and the browser vault purges any retained Direct-Xfer credential. Remaining cached identifiers/metadata are classified C1/C2 and cannot independently authorize a public resource because L3 requires password/approval authorization. |

## V15 — Secure Coding and Architecture

| Requirement | Status | Evidence / gap |
|---|---|---|
| V15.1.1 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §9 defines risk-based dependency remediation SLA targets: Critical <=72h, High <=7d, Medium <=30d, Low <=90d or time-bounded documented risk acceptance. |
| V15.1.2 | **PASS** | A CycloneDX SBOM is maintained at `security/sbom.cdx.json` alongside the lockfile and release evidence requirements. |
| V15.1.3 | **PASS** | Resource-intensive functions (OCR, ZIP, hashing, connectors, uploads, password work and remote audit delivery) are documented with their caps/queues/timeouts in the L3 security specification. |
| V15.1.4 | **PASS** | The L3 dependency policy identifies higher-risk runtime libraries and parser/network/archive boundaries requiring enhanced advisory review. |
| V15.1.5 | **PASS** | Dangerous functionality is formally inventoried in `security/ASVS-L3-SECURITY-SPEC.md` §9 and regenerated by `npm run security:inventory`. |
| V15.2.1 | **PASS** | L3 requires release-bound signed security-scan evidence proving dependency and container scans passed with zero high/critical findings; stale or wrong-release evidence fails startup. |
| V15.2.2 | **PASS** | The L3 availability strategy documents and enforces bounded queues, parser/body/file limits, timeouts, concurrency controls and fail-closed behavior for security-critical dependencies. |
| V15.2.3 | **PASS** | Repository-verifiable closure: minimal production runtime. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.2.3) with reviewed anchors `Dockerfile`, `Dockerfile`, `.github/workflows/build-windows-csharp.yml` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V15.2.4 | **PASS** | The dependency policy requires lockfile/pinned inputs, trusted upstream repositories and vulnerability review; container/tool downloads are checksum/version constrained by release tooling. |
| V15.2.5 | **PASS** | Risky components and dangerous functions are formally mapped in §9; the production runtime drops privileges/capabilities and native tools are invoked with validated argument arrays rather than attacker-controlled shells. |
| V15.3.1 | **PASS** | Repository-verifiable closure: minimum response fields. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.3.1) with reviewed anchors `lib/server/share-presentation-service.js`, `security/ASVS-L3-SECURITY-SPEC.md` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V15.3.2 | **PASS** | Security-sensitive backend outbound HTTP clients reject redirects in L3, including OAuth/broker, storage/backup, webhook/network and remote-audit paths, preventing redirect-based validation bypass. |
| V15.3.3 | **PASS** | Repository-verifiable closure: mass-assignment prevention. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.3.3) with reviewed anchors `scripts/asvs-l3-partial-audit.js`, `lib/server/settings-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V15.3.4 | **PASS** | Client-IP resolution delegates to Express only under configured trusted-proxy policy and otherwise uses the socket peer, avoiding raw spoofable X-Forwarded-For use. |
| V15.3.5 | **PASS** | Repository-verifiable closure: strict type/comparison policy. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.3.5) with reviewed anchors `scripts/asvs-l3-partial-audit.js`, `security/ASVS-L3-SECURITY-SPEC.md` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V15.3.6 | **PASS** | Repository-verifiable closure: prototype-pollution prevention. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.3.6) with reviewed anchors `scripts/asvs-l3-partial-audit.js`, `lib/server/request-utils.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V15.3.7 | **PASS** | L3 HTTP middleware rejects malformed percent encoding, NUL/empty query components and duplicate query-parameter names before Express route processing, with regression coverage for duplicate-parameter rejection. |
| V15.4.1 | **N/A** | N/A for the audited production architecture: Direct-Xfer application state executes in a single Node.js event-loop thread and does not share mutable application objects with worker threads/native threads. Asynchronous races are covered by the applicable V15.4.2–V15.4.4 controls. |
| V15.4.2 | **PASS** | Repository-verifiable closure: TOCTOU/atomic filesystem operations. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.4.2) with reviewed anchors `lib/server/host-path-service.js`, `lib/server/share-service.js`, `lib/photo-utils.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V15.4.3 | **PASS** | Repository-verifiable closure: lock consistency. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.4.3) with reviewed anchors `lib/server/photo-service.js`, `lib/server/admin-photo-routes.js`, `lib/server/pwa-routes.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V15.4.4 | **PASS** | Repository-verifiable closure: resource fairness/starvation bounds. Guarded by `scripts/asvs-l3-partial-audit.js` (V15.4.4) with reviewed anchors `lib/auth-utils.js`, `lib/server/storage-connector-job-service.js`, `lib/core-utils.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |

## V16 — Security Logging and Error Handling

| Requirement | Status | Evidence / gap |
|---|---|---|
| V16.1.1 | **PASS** | `security/ASVS-L3-SECURITY-SPEC.md` §10 documents event classes, record format, authorized sinks, access, retention and remote-analysis purpose. |
| V16.2.1 | **PASS** | Security audit entries include sequence/time, action, actor/account, role, IP and detail metadata suitable for timeline reconstruction. |
| V16.2.2 | **PASS** | L3 requires signed clock-source evidence proving synchronization with measured maximum offset no greater than 1000 ms. |
| V16.2.3 | **PASS** | The logging inventory defines only the local tamper-evident chain, bounded application projection and configured L3 HTTPS remote audit endpoint as authorized security-log sinks; C3 data is prohibited. |
| V16.2.4 | **PASS** | The security audit chain uses structured JSON records and stable fields suitable for machine correlation/export. |
| V16.2.5 | **PASS** | The C3 logging policy prohibits raw passwords, tokens, keys and connector secrets; audit details are bounded/redacted and security sinks are explicitly enumerated. |
| V16.3.1 | **PASS** | Authentication success/failure events are audited across password/TOTP/passkey paths, and audit schema v2 normalizes authentication method/result metadata while remaining backward-compatible with older chained records. Regression coverage verifies the normalized metadata. |
| V16.3.2 | **PASS** | The centralized admin authorization boundary audits denials and, in L3, records every successful administrator authorization decision on response completion, including sensitive administration-data reads; regression tests assert both paths. |
| V16.3.3 | **PASS** | Repository-verifiable closure: central security-control rejection logging. Guarded by `scripts/asvs-l3-partial-audit.js` (V16.3.3) with reviewed anchors `lib/server/http-application.js`, `lib/server/admin-router.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V16.3.4 | **PASS** | Repository-verifiable closure: central unexpected-control failure logging. Guarded by `scripts/asvs-l3-partial-audit.js` (V16.3.4) with reviewed anchors `lib/server/http-application.js`, `lib/server/http-application.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
| V16.4.1 | **PASS** | The tamper-evident journal serializes entries as JSON/canonical fields, so attacker-controlled text cannot break the record structure through raw line injection. |
| V16.4.2 | **PASS** | L3 requires signed remote-audit receipt evidence proving the remote sink is immutable and retention is enforced, in addition to the local tamper-evident chain. |
| V16.4.3 | **PASS** | L3 requires signed remote-audit evidence proving the analysis sink is logically separate, TLS-verified and authenticated; the application remote-audit transport remains HTTPS fail-closed/bounded. |
| V16.5.1 | **PASS** | The final HTTP error boundary returns generic client errors and avoids stack traces/secrets. |
| V16.5.2 | **PASS** | Repository-verifiable closure: secure external dependency degradation. Guarded by `scripts/asvs-l3-partial-audit.js` (V16.5.2) with reviewed anchors `security/ASVS-L3-SECURITY-SPEC.md`, `lib/server/asvs-l3-policy.js`, `lib/server/upload-reception-service.js` and regression `test/asvs-l3-partial-closure-1.70.25.test.js`; generated report must remain finding-free. |
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
