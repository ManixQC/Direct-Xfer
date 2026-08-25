# Direct-Xfer — ASVS L3 deployment checklist

This checklist is required in addition to the source controls. ASVS is verified against a deployed application, not a source archive alone.

## Mandatory profile

- Set `ASVS_L3_MODE=true`.
- Set an absolute HTTPS `PUBLIC_URL` using the production host.
- Do not set `ADMIN_ALLOW_ANY=true`; constrain administrator access by network policy/allowlist.
- Provision `DATA_KEY` with >=32 bytes of high-entropy secret material.
- Provision a distinct `AUDIT_HMAC_KEY` with >=32 bytes.
- Provision the audit Ed25519 private key through `AUDIT_SIGNING_PRIVATE_KEY` or `AUDIT_SIGNING_PRIVATE_KEY_FILE` from the deployment secret manager.
- Configure ClamAV (`CLAMAV_HOST`, `CLAMAV_PORT`) and monitor it; L3 upload scanning fails closed.
- Configure a logically separate HTTPS `AUDIT_REMOTE_URL` and, where required, `AUDIT_REMOTE_TOKEN`.
- Configure and network-enforce `ASVS_L3_EGRESS_ALLOWLIST`.
- Set `ASVS_L3_CRYPTO_PROVIDER` to the actually deployed `vault`, `kms`, `hsm`, or `isolated-vault` solution.
- Verify host clock synchronization, then set `ASVS_L3_CLOCK_SYNCED=true`.
- Restrict core dumps/debug access, disable or encrypt swap, apply OS process isolation/hardening, then set `ASVS_L3_MEMORY_PROTECTED=true`.

Run `npm run asvs:l3:check` before launch. Direct-Xfer itself also fails startup when mandatory profile prerequisites are absent.

## TLS / edge evidence

Verify with the real edge/reverse proxy: TLS 1.2/1.3 only; forward-secret AEAD cipher suites; trusted certificate chain and hostname; certificate revocation/OCSP behavior where applicable; HSTS delivery on the public origin; HTTP to HTTPS redirect performed at the edge before application traffic; HTTP request normalization/smuggling defenses; HTTP/2 and HTTP/3 settings where enabled; ECH where organizational policy and client support require it.

The Direct-Xfer application rejects non-HTTPS application requests in L3, but reverse-proxy protocol/cipher behavior remains deployment evidence.

## WebAuthn / device assurance

Enroll at least one passkey for every administrator-capable account. Confirm password/TOTP sessions cannot access the administrator API in L3. Confirm a passkey-authenticated session can. Confirm sensitive mutations older than the configured strong-auth freshness window trigger a new passkey ceremony.

If the assurance target specifically requires hardware-backed authenticators, enforce the organization's trusted authenticator/AAGUID/attestation policy outside or in front of Direct-Xfer and retain evidence. Browser `userVerification=required` alone is not proof that every authenticator is hardware backed.

## Public links

Every public share in L3 must use an independent password or access-approval gate. Verify an unprotected share returns `l3-independent-auth-required`. Treat public URLs as private metadata even though the URL token alone is not sufficient authorization in this profile.

## Logging / monitoring

Confirm the remote audit system is logically separate, receives a login, failed login, authorization denial, settings change and session revocation event, and alerts when delivery stops. Restrict remote log access and set a retention period appropriate to incident-response/legal requirements. Confirm clock skew between Direct-Xfer and the analysis system is within the organization's threshold.

## Secret isolation and rotation

Validate that the declared Vault/KMS/HSM/isolated-vault implementation actually prevents unauthorized application/host users from extracting long-lived master/signing material. Record key IDs and rotation dates. Test audit-HMAC migration and backup/restore before a DATA_KEY rotation. Revoke credentials immediately after suspected disclosure.

## Host / container hardening

Run as non-root; read-only root filesystem where feasible; minimal Linux capabilities; no Docker socket; no privileged mode; restrictive `/data` and secret mounts; kernel/host security updates; outbound firewall allowlist; inbound firewall only to intended edge/admin networks; core dumps disabled; debug endpoints disabled in production; backup destination access separated from normal share access.

## Release evidence

For each release retain: source/archive SHA-256, `npm test` output, `npm run asvs:l3:check` output, `npm run security:inventory` output, SBOM, dependency vulnerability scan, matrix/audit versions, TLS scan, remote logging test and any MANUAL/N/A evidence.
