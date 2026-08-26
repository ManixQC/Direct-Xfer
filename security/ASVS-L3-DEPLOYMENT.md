# Direct-Xfer — ASVS 5.0.0 Level 3 deployment

Direct-Xfer 1.71.31 has no unresolved `MANUAL`, `PARTIAL`, `FAIL`, or `REVIEW` row in its source matrix. This does **not** mean a source ZIP certifies an installation. Facts that only exist at the production edge/host/provider are now mandatory, machine-validated startup evidence rather than operator declarations. A specific deployment can use the L3 profile only while its signed evidence remains valid.

## Mandatory L3 runtime profile

Set `ASVS_L3_MODE=true` and an absolute production `PUBLIC_URL=https://...`. Configure `TRUST_PROXY` as the exact IP/CIDR list of the external TLS edge; boolean trust and hop counts are rejected. Keep `ADMIN_ALLOW_ANY` disabled. Do not configure `TLS_CERT`, `TLS_KEY`, `TLS_SELF_SIGNED`, `DATA_KEY`, `AUDIT_HMAC_KEY`, `AUDIT_SIGNING_PRIVATE_KEY`, or `AUDIT_SIGNING_PRIVATE_KEY_FILE` in the Direct-Xfer process.

Configure ClamAV using a local Unix socket or authenticated/verified TLS transport, configure the required HTTPS `AUDIT_REMOTE_URL`, and define a non-wildcard `ASVS_L3_EGRESS_ALLOWLIST` containing only the enabled external services.

Configure the cryptographic boundary with `ASVS_L3_CRYPTO_PROVIDER` (`vault`, `kms`, `hsm`, or `isolated-vault`) and an absolute `ASVS_L3_CRYPTO_COMMAND`. The command must be a restrictive local bridge to a hardware-backed provider and must pass the provider self-test: non-exportable isolated keys, hardware backing, all secret-key operations isolated, and working encrypt/decrypt/HMAC/sign operations by key handle. Direct-Xfer L3 does not accept raw long-lived data/audit signing keys in the Node process.

Configure approved hardware authenticators with `ASVS_L3_HARDWARE_AAGUIDS`, pinned trust-anchor fingerprints with `ASVS_L3_ATTESTATION_ROOT_SHA256`, and the corresponding PEM root certificate files with `ASVS_L3_ATTESTATION_ROOT_FILES`. L3 registration uses direct attestation and rejects backup/syncable credentials. After the first hardware credential is enrolled, factor management permanently requires recent hardware-passkey authentication and the last approved hardware passkey cannot be removed through Direct-Xfer.

## Signed deployment evidence

Generate current observations for all 22 externally verifiable requirements defined in `security/ASVS-L3-EVIDENCE.md`, then sign the bundle in an independent audit/CI environment with Ed25519. Keep the private signing key outside the Direct-Xfer runtime. Configure the verifier with:

- `ASVS_L3_EVIDENCE_FILE=/path/to/signed-evidence.json`
- `ASVS_L3_EVIDENCE_PUBLIC_KEY=...` **or** `ASVS_L3_EVIDENCE_PUBLIC_KEY_FILE=/path/to/evidence-public.pem`

The bundle must match the exact Direct-Xfer release and exact HTTPS public origin and can be valid for at most seven days. Every requirement has a fixed collection-method label and a structured observation predicate. Digests and the final signature are verified before startup. A stale, forged, duplicate, wrong-release, wrong-origin, wrong-method, incomplete, or predicate-failing bundle fails closed.

Run:

```text
npm run asvs:l3:evidence:verify
npm run asvs:l3:check
```

The second command is the complete startup preflight. Direct-Xfer runs the same policy during normal L3 startup.

## Evidence collection domains

The signed bundle must independently prove: public HSTS preload registration; intended HTTP→HTTPS edge behavior without API redirect ambiguity; proxy-header authenticity; request-smuggling and HTTP/2/3 header rejection; host memory/process protection and in-use plaintext minimization; forward-secret recommended TLS ciphers; revocation checking; ECH; public certificate/hostname trust; authenticated and least-privilege backend identities; host/network default-deny egress; hardware-backed non-exportable crypto isolation and ACLs; dependency plus container scans with zero High/Critical findings; clock offset within ±1000 ms; and immutable/retained/logically separate authenticated remote audit ingestion.

Exact field names and allowed methods are normative in `security/ASVS-L3-EVIDENCE.md` and `lib/server/asvs-l3-evidence.js`.

## TLS and edge architecture

L3 terminates TLS outside Direct-Xfer at the verified edge. Local-CA/self-signed/provided private-key termination in Node is prohibited, including restoration of legacy TLS key material from backups. The edge must provide the signed V3/V4/V12 observations and the app trusts only explicitly configured edge IP/CIDR peers.

Browser-facing HTTP may redirect to HTTPS only as demonstrated by V4.1.2 evidence; API/service HTTP must not be silently transformed into a security-ambiguous request. Edge/origin tests must cover CL/TE ambiguity, duplicate Content-Length, HTTP/2/3 connection-specific headers and CR/LF header injection.

## Hardware WebAuthn and factor-loss behavior

Enroll at least one approved hardware authenticator for every administrator-capable account before normal L3 operation. Hardware status is not inferred from `userVerification` or client-reported transports: AAGUID, verified packed-attestation trust and non-backup status are recorded and rechecked.

Direct-Xfer intentionally provides no application recovery path for a lost final L3 hardware factor. Keep at least two approved hardware authenticators per administrator/owner as an operational practice. The application refuses to delete the last approved credential. Recovery after loss of every authenticator is therefore an installation/account lifecycle operation outside Direct-Xfer rather than a weaker in-app identity-proofing bypass.

## Crypto/provider boundary

The provider bridge must not return key material. In L3, application-state encryption/decryption, audit HMAC/signing and runtime HMAC operations are delegated by opaque key handle. TOTP is disabled; built-in S3 SigV4 backup signing is rejected; local TLS private-key use is rejected. If S3 backup is required for an L3 installation, use an external connector/service whose credential and signing boundary satisfies the signed backend/crypto evidence.

Legacy state encrypted with an application `DATA_KEY` must be migrated outside the active L3 profile before enabling L3. For a 1.70.25 → 1.71.31 upgrade, stop Direct-Xfer and run `npm run asvs:l3:migrate-state -- /path/to/shares.json` with `ASVS_L3_LEGACY_DATA_KEY` plus `ASVS_L3_CRYPTO_COMMAND`, then run `npm run asvs:l3:migrate-audit -- /path/to/data` with `ASVS_L3_LEGACY_AUDIT_HMAC_KEY` plus the provider command. Both tools retain rollback backups and the audit tool refuses to re-sign an invalid legacy chain/head.

Backups created by 1.70.26 L3 may be plaintext because of the corrected encryption-selection bug. Convert them offline with `npm run asvs:l3:migrate-backup -- old.dxbackup` before L3 restore. The same converter accepts legacy `dxenc:1` backups when `ASVS_L3_LEGACY_DATA_KEY` is supplied. L3 itself rejects plaintext backups. Legacy local TLS backup material cannot be imported while L3 is active.

## Release/security evidence

For every release retain the release archive SHA-256, full and ASVS test output, static/partial audits, security inventory, SBOM, Windows runtime manifest check, dependency scan, container scan and the signed deployment-evidence bundle. V15.2.1 evidence is release-bound, so upgrading Direct-Xfer invalidates the previous release scan bundle until the new exact release is scanned and re-signed.

A focused independent penetration test remains recommended before representing a production installation as independently verified against ASVS L3. The source matrix is an implementation/evidence map, not a third-party certification.
