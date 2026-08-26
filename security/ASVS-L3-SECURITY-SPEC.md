# Direct-Xfer — ASVS 5.0.0 Level 3 security specification

Version scope: Direct-Xfer 1.71.8 and later when `ASVS_L3_MODE=true`.

This document is normative for the Direct-Xfer ASVS L3 profile. Compatibility mode may intentionally allow weaker deployment choices. A deployment must not claim the Direct-Xfer L3 profile unless the startup policy passes and the deployment checklist in `ASVS-L3-DEPLOYMENT.md` is completed.

## 1. Validation and business-logic model

All untrusted data is validated on the server at the boundary closest to its use. The canonical form is UTF-8 text unless a protocol defines a binary representation. Identifiers use bounded ASCII/base64url/hex forms; paths are normalized as relative paths and resolved under an approved root; numeric values must be finite and are clamped or rejected to the documented range; URLs are parsed with `URL` and security-sensitive destinations require an approved scheme and host; JSON bodies are size-bounded by route-specific parsers.

Cross-field invariants include: start date < expiry date; quotas and counters are non-negative safe integers; share recipient tokens cannot collide with main or other recipient tokens; uploaded paths must remain below the configured managed root after symlink-aware resolution; WebAuthn challenges are bound to RP ID, origin, account where known, credential ID and expiry; credential mutations use current persisted account state after asynchronous verification; restore/import operations validate identity/token collisions before publication.

Business limits are enforced in backend services. Relevant defaults/maximums include bounded login failures, bounded parser bodies, session absolute and idle expiry, concurrent session caps, public rate limits, proof-of-work throttling, upload byte/file limits, per-sender L3 reception quotas, image byte/pixel limits, bounded ZIP selection, bounded search/audit/history/notification collections, bounded connector concurrency, and bounded remote-audit queues. Configuration can lower limits but must not disable mandatory L3 limits.

`ASVS_L3_MODE` changes public upload acceptance to fail closed on malware scanner errors and to require content/extension correspondence for accepted public uploads. Unknown or unverifiable public upload types are rejected in this profile. Executable/script package extensions are blocked at the public-upload policy boundary; recognized images, media, documents, archives and UTF-8 text families must match their expected magic/container/text structure. SVG is accepted only as passive image content: active elements, event handlers, external references, script URLs, external CSS URLs, DOCTYPE and ENTITY declarations are rejected. Upload byte, file-count, per-sender storage and decoded-image pixel limits are enforced before expensive processing.

## 2. Browser security baseline

Required browser capabilities for the administrator application in L3 are HTTPS secure context, cookies with Secure/HttpOnly/SameSite support, CSP, Fetch Metadata, Web Crypto/WebAuthn, and modern ES support. The administrator application must block rather than silently downgrade when a phishing-resistant passkey ceremony is unavailable. L3 requires TLS termination at an independently verified external edge and rejects application HTTP except the loopback liveness exception. HSTS is emitted with `includeSubDomains` and `preload`; current signed deployment evidence must prove the public domain is actually preloaded and the deployed edge satisfies the protocol requirements.

The common web boundary emits CSP with a cryptographic nonce, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, CSP reporting, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Opener-Policy: same-origin`. State-changing administrator requests also require a CSRF token and pass same-origin / Fetch Metadata defenses.

Unsupported browsers are denied sensitive authentication/administration functionality; the UI shows a passkey-support error instead of falling back to a weaker L3 administrator login. On explicit L3 logout, authenticated PWA IndexedDB stores, queued destinations, cached private data, OPFS queue material and sensitive local/session-storage values are cleared. E2E destination keys are never persisted to browser storage in L3. Resource identifiers that may remain during an authenticated session are C1/C2 metadata, not standalone authorization credentials: the L3 public-link policy requires independent password/approval authorization.

## 3. Authentication assurance and recovery

Authentication methods are classified as follows:

| Method | Purpose in L3 | Phishing resistant | May authorize administrator API |
|---|---|---:|---:|
| Password only | first hardware-passkey bootstrap/password change only | No | No |
| Password + TOTP | disabled in L3 | No | No |
| Hardware-attested WebAuthn passkey with UV | normal administrator authentication and factor management | Yes | Yes |
| Recovery code | disabled as an L3 factor-recovery bypass | No | No |

Before the first approved hardware credential is enrolled, a password session may exist only for bootstrap activities such as initial passkey registration. After the first approved hardware passkey is enrolled, the account records a permanent L3 hardware-enrollment lock: passkey management requires recent phishing-resistant passkey authentication even if the credential list is later corrupted or emptied. The last approved hardware passkey cannot be deleted or unbound through the application. Direct-Xfer therefore exposes no lost-final-factor identity-recovery path in L3.

L3 registration requests direct attestation and `userVerification=required`. Accepted credentials must be non-backup credentials with an AAGUID in `ASVS_L3_HARDWARE_AAGUIDS` and packed attestation anchored by a SHA-256 fingerprint in `ASVS_L3_ATTESTATION_ROOT_SHA256` whose trusted root certificate is supplied through `ASVS_L3_ATTESTATION_ROOT_FILES`. Certificate validity/CA chaining, the attestation signature and leaf key strength are verified before hardware metadata is persisted; client-reported transport strings are informational and are never hardware proof. Authentication re-evaluates that stored hardware posture against the current allowlists; backup/syncable credentials cannot authorize the L3 administrator API. RS256 keys must meet the RSA-3072 floor.

The protected administrator router requires `authMethod=passkey`, `phishingResistant=true`, and the current hardware-attestation policy. Sensitive mutations additionally require recent strong authentication. Standard web UI initiates a new passkey ceremony when a protected mutation returns `reauth-required`.

## 4. Session and contextual authorization policy

Sessions have absolute and inactivity expiry, rotate on login, are concurrency-limited, and are invalidated on credential/factor changes as defined by the account routes. In L3 the administrator session is additionally bound to the source IP and User-Agent observed at authentication; context drift invalidates it. This deliberately favors assurance over roaming/NAT convenience.

Every administrator route passes through a centralized role gate. Roles are:

| Role | Global admin/settings/accounts | Own share mutations | All share read | Audit/security read | Own session revoke |
|---|---:|---:|---:|---:|---:|
| owner | Yes | Yes | Yes | Yes | Yes |
| admin | Yes | Yes | Yes | Yes | Yes |
| operator | No | Yes | Own/authorized scope | No | Yes |
| auditor | No | No | Yes/read-only | Yes/read-only | Yes |

Object authorization is based on stable account IDs and share owner IDs, never a client-supplied role. Internal secrets, password hashes, session SIDs, CSRF values, capability credentials and connector secrets are not fields in normal decorated/public objects. Public DTOs are constructed explicitly rather than serializing complete persistent records.

Contextual inputs used by security decisions include role, account ID, share owner ID, current session SID, authentication method/age, IP address, User-Agent, trusted-proxy state, network allowlist, public-link IP/geo rule, approval state, device binding, rate/abuse state, and link lifecycle state. L3 policy treats authentication-method downgrade, stale strong authentication, IP/UA drift, and unapproved public-link access as deny conditions.

## 5. Public-link credential model

In compatibility mode Direct-Xfer supports capability-style public links. In L3, the token in `/s`, `/u`, `/c`, `/i`, or `/g` is never sufficient authorization: every public share must have an independent password or explicit access-approval gate. Requests to an unprotected public link are denied with `l3-independent-auth-required`. This converts the URL token into a random resource locator rather than a standalone bearer credential and prevents URL disclosure alone from granting access.

Operators should still treat public URLs as private metadata and keep `Referrer-Policy: no-referrer`, redact them from third-party telemetry, and avoid posting them to untrusted systems.

## 6. Cryptographic policy and inventory

Approved primitives are Node/OpenSSL/Web Crypto primitives with at least 128-bit classical security unless a protocol mandates an exception. Current inventory:

| Asset / purpose | Primitive | Key source / storage | Rotation / lifecycle |
|---|---|---|---|
| Application state at rest | provider-defined authenticated encryption (test contract requires encrypt/decrypt round trip; production provider must satisfy approved cryptographic policy) | non-exportable `data` key handle in hardware-backed external provider | provider-controlled rotation/migration; application receives ciphertext only |
| Audit chain | HMAC-SHA-256 | non-exportable `audit-hmac` handle in hardware-backed external provider | independent handle; rotate by verified chain migration |
| Audit export/head proof | Ed25519 | non-exportable `audit-signing` handle in hardware-backed external provider | provider-controlled key transition with retained public-key history |
| Sessions/CSRF/challenges/tokens | CSPRNG (`crypto.randomBytes`) | memory only | short-lived/rotated by protocol |
| Non-guessable recovery/capability secrets | CSPRNG (`crypto.randomBytes`), minimum 128 bits in L3 | memory or one-way password hash as appropriate | one-time/rotated by protocol |
| WebAuthn | ES256 / RS256 (RSA >=3072) | public keys persisted; private key remains authenticator-side | credential revocation/re-enrollment |
| TLS local CA (non-L3 public trust use) | RSA >=3072 for newly generated material | protected filesystem | certificate validity/renewal policy |
| Password hashing | scrypt (`N=16384`, `r=8`, `p=1`, 64 MiB max memory), 16-byte per-record salt, 64-byte derived value | per-record salt | parameters are pinned in code; benchmark/review before any parameter migration |
| TOTP | HMAC-SHA1 only in compatibility/non-L3 deployments | encrypted application state | disabled in L3; compatibility factor rotation only |

Protocol-mandated SHA-1 inside TOTP is not approved for general hashing/signatures. MD5/SHA-1 are not to be introduced for security decisions. Cryptographic comparisons use timing-safe comparison where secrets/signatures are compared directly.

L3 requires `ASVS_L3_CRYPTO_COMMAND`, a thin local IPC/command bridge to a hardware-backed `vault`, `kms`, `hsm`, or `isolated-vault`. Its mandatory self-test must prove `hardwareBacked=true`, `keyExportable=false`, `keyIsolation=true`, `allSecretKeyOperationsIsolated=true` and support for encrypt/decrypt/HMAC/sign operations by opaque key handle. `DATA_KEY`, `AUDIT_HMAC_KEY` and an application-readable audit private signing key are forbidden in the L3 process. State encryption/decryption, audit HMAC/signing and runtime HMAC operations use provider handles; local TOTP and built-in S3 SigV4 signing are disabled in L3. Local TLS termination/Local-CA generation is also disabled so TLS private-key operations remain at the separately verified edge.

Crypto-agility rule: algorithms, key sizes and formats must be represented in this inventory and migrated through versioned code with backward-read/new-write transitions; new hard-coded legacy primitives are prohibited. Cryptographic discovery is run by `npm run security:inventory` for each release and reviewed with this inventory.

Post-quantum plan: inventory externally exposed long-lived confidentiality/signature dependencies on each annual security review; track Node/OpenSSL and browser/FIDO PQC standardization; prefer hybrid TLS/signature support once stable interoperable primitives are available; do not invent proprietary PQC; prioritize migration of data requiring confidentiality beyond the expected cryptanalytic transition horizon.

## 7. Data classification

| Class | Examples | At-rest protection | Logging | Retention/access |
|---|---|---|---|---|
| C0 Public | version, public UI assets | none required | allowed | normal |
| C1 Internal | share names, operational metrics, non-secret settings | protected application state / filesystem permissions | bounded/minimized | authenticated roles |
| C2 Sensitive | filenames/paths, IPs, user names, audit details, visitor metadata | encrypted state where persisted; restrictive files | redact/minimize; audit access controlled | configured retention and need-to-know |
| C3 Secret | passwords, password hashes, TOTP seeds/recovery material, DATA_KEY, audit HMAC/signing key, OAuth/client secrets, connector credentials, session/CSRF/bearer values | secret manager or encrypted/restrictive storage; never public DTO | never log raw value | minimum lifetime; rotate/revoke on compromise |

C3 material must never be placed in query strings, normal response payloads, analytics, exception details, or audit `detail` fields. C2 values are minimized and bounded before audit/notification storage.

## 8. External service and egress policy

External communications include update/public-IP services, Google OAuth broker/provider, SMTP, webhook endpoints, Web Push endpoints, rclone-backed cloud/storage services, ClamAV, remote audit sink, and administrator-configured storage/notification connectors. Each client must use a bounded timeout, bounded response/body handling, finite retry/concurrency behavior and cleanup on cancellation/error.

L3 startup requires a non-wildcard `ASVS_L3_EGRESS_ALLOWLIST`. The application enforces that allowlist at administrator-configurable HTTP(S), OAuth/broker, backup/storage, webhook, SMTP and remote-audit outbound boundaries; security-sensitive HTTP clients reject redirects so an approved origin cannot redirect to an unapproved target. SMTP address/header fields reject CR/LF/NUL injection. The deployment firewall/proxy must enforce the same or narrower allowlist. L3 startup accepts that external fact only through current signed V13.2.5 evidence satisfying the firewall predicate; application configuration alone is insufficient. The remote audit sink must be HTTPS and logically separate. ClamAV is mandatory and scan errors fail closed for public uploads.

Representative saturation/concurrency policy: connector jobs use the configured bounded active-job count; password work uses bounded asynchronous workers; public transfers and abuse controls are rate/concurrency limited; remote audit delivery uses a bounded queue (100–10,000, default 2,000) with exponential retry; outbound HTTP clients use timeouts and reject uncontrolled redirects where security-sensitive. Operators must size SMTP/webhook/provider connection pools below provider limits and document any reverse-proxy limits.

Secret rotation baseline: session/CSRF/challenges are ephemeral; OAuth transaction secrets expire by protocol; public share credentials are revoked by link lifecycle; password/TOTP/passkeys rotate on user/factor change; `AUDIT_HMAC_KEY`, audit Ed25519 signing material, `DATA_KEY`, OAuth client secrets, webhook secrets and connector credentials are C3 and must be rotated immediately on suspected disclosure and at least according to the organization's annual secret review. Provider-issued credentials should use shorter provider-supported lifetimes where available.

## 9. Dependency and dangerous-function policy

Dependency vulnerabilities are reviewed on every release and at least monthly for a maintained deployment. Remediation SLA from confirmed exposure: Critical <= 72 hours, High <= 7 days, Medium <= 30 days, Low <= 90 days, or a documented risk acceptance with compensating control and expiry. Unsupported/end-of-life dependencies are not permitted in the L3 release baseline.

Current direct runtime dependencies are Express, Archiver, node-forge, Nodemailer, QRCode and web-push. Higher-risk boundaries are `node-forge` (certificate/crypto parsing), Nodemailer (SMTP), Archiver (archive generation), web-push (outbound push), and all transitive packages that parse untrusted structured data. They require special attention during advisories.

Dangerous functionality inventory: child-process/native-tool launch (`rclone`, `tesseract`, malware scanner helpers), filesystem writes/deletes/restore, archive creation/extraction/introspection, outbound HTTP(S), SMTP/webhooks/Web Push, dynamic URL handling, cryptographic key import/export, and admin backup/restore/shutdown. Shell execution with attacker-controlled strings is prohibited; native tools use argument arrays and positive validation. The generated inventory is refreshed by `npm run security:inventory`.

## 10. Logging and detection inventory

Security audit events are structured records chained with HMAC-SHA-256 and a durable head, with Ed25519 proof support. Events include authentication success/failure/2FA/passkey events, authorization denials, **all successful L3 administrator authorization decisions (including sensitive administration-data reads)**, account/factor/session changes, DLP/ransomware/malware decisions, share lifecycle changes, settings/security changes, restore/backup/diagnostic actions and other administrator mutations. The centralized administrator router records the authorization outcome after the final response status so denied decisions are not double-counted as grants.

Authorized sinks are: (1) the local durable tamper-evident audit chain under the Direct-Xfer data directory; (2) the bounded in-application audit/history projection; (3) in L3, exactly the configured HTTPS `AUDIT_REMOTE_URL` separate analysis/detection endpoint. Raw C3 secrets are not authorized log fields. Console logs are operational diagnostics only and must not receive credential values.

L3 remote audit transmission validates TLS certificates, has a bounded queue, bounded timeout and retry backoff. The local chain is committed before asynchronous transmission so an unavailable SIEM cannot cause silent loss of the primary record. Deployment monitoring must alert on remote sink delivery failures and queue saturation.

Retention and access: audit retention is controlled by configured bounded history/local log lifecycle plus the organization's remote SIEM retention. Audit/security read access is owner/admin/auditor only. Production operators must configure remote retention suitable for incident investigation and applicable legal requirements. L3 startup additionally requires current signed V16.4.2/V16.4.3 evidence proving remote immutability/retention, logical separation, authenticated ingest and verified TLS, plus V16.2.2 evidence proving synchronized time with measured absolute offset no greater than 1000 ms.


## 11. Signed deployment evidence

External deployment facts are not accepted from operator booleans in 1.70.27. `lib/server/asvs-l3-evidence.js` requires 22 requirement-specific observations covering HSTS preload, proxy/HTTP normalization, host memory protection, TLS/ECH/public trust, backend identities, network egress, hardware crypto/ACL isolation, release dependency/container scans, clock synchronization and remote-log separation/immutability. Each observation has an exact allowed collection method and structured predicate, carries a canonical SHA-256 digest, and is included in an Ed25519-signed bundle.

The bundle is bound to the exact `OWASP-ASVS-5.0.0-L3` profile, Direct-Xfer release and HTTPS public origin, and may be valid for at most seven days. Wrong-release/origin, stale/future, duplicate, forged, wrong-method, predicate-failing or signature-invalid evidence causes the L3 startup preflight to fail closed. The verifier public key may be configured in the Direct-Xfer process; the signing private key belongs to the independent audit/CI environment and must not be mounted into the application runtime. Exact fields are documented in `security/ASVS-L3-EVIDENCE.md`.
