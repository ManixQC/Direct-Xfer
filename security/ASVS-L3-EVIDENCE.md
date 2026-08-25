# Direct-Xfer — signed ASVS L3 deployment evidence

<<<<<<< HEAD
Direct-Xfer 1.71.3 retains the former operator-declared `MANUAL` booleans from the L3 decision path. External facts are accepted only through a current, Ed25519-signed evidence bundle. The verifier is implemented in `lib/server/asvs-l3-evidence.js` and is executed by both `npm run asvs:l3:evidence:verify` and the L3 startup policy.
=======
Direct-Xfer 1.71.4 retains the former operator-declared `MANUAL` booleans from the L3 decision path. External facts are accepted only through a current, Ed25519-signed evidence bundle. The verifier is implemented in `lib/server/asvs-l3-evidence.js` and is executed by both `npm run asvs:l3:evidence:verify` and the L3 startup policy.
>>>>>>> eb50626 (v1.71.4)

A bundle is accepted only when it is bound to `OWASP-ASVS-5.0.0-L3`, the exact Direct-Xfer release and the exact HTTPS `PUBLIC_URL` origin; its validity is at most seven days; `generatedAt` and every required `observedAt` must also be no older than seven days at verification time; every required row is `pass`; every observation matches a requirement-specific predicate; every observation digest matches its canonical SHA-256; and the whole bundle has a valid Ed25519 signature.

## Runtime configuration

Set `ASVS_L3_EVIDENCE_FILE` to the signed JSON file and configure the verifier key with exactly one of `ASVS_L3_EVIDENCE_PUBLIC_KEY` or `ASVS_L3_EVIDENCE_PUBLIC_KEY_FILE`. The signing private key belongs to the independent audit/CI environment and must not be mounted into the Direct-Xfer runtime.

`npm run asvs:l3:evidence:verify` validates only the evidence bundle. `npm run asvs:l3:check` validates the complete L3 startup profile, including the external crypto provider, hardware-authenticator policy, trusted proxy list, ClamAV, egress policy, remote audit endpoint, external TLS boundary and signed evidence.

## Bundle shape

```json
{
  "evidenceVersion": 1,
  "profile": "OWASP-ASVS-5.0.0-L3",
<<<<<<< HEAD
  "release": "1.71.3",
=======
  "release": "1.71.4",
>>>>>>> eb50626 (v1.71.4)
  "publicOrigin": "https://direct-xfer.example",
  "generatedAt": 1787659200000,
  "expiresAt": 1788264000000,
  "checks": [
    {
      "id": "V3.7.4",
      "status": "pass",
      "method": "hsts-preload-api",
      "observedAt": 1787659200000,
      "observation": { "preloaded": true, "domain": "direct-xfer.example" },
      "digest": "<sha256 of canonical observation>"
    }
  ],
  "signature": "<base64 Ed25519 signature>"
}
```

The signing helper calculates each observation digest and signs the complete bundle:

```text
node scripts/asvs-l3-evidence-sign.js unsigned.json signed.json evidence-signing-ed25519.pem
```

## Required observations

| Requirement | Method | Required observation fields |
|---|---|---|
| V3.7.4 | `hsts-preload-api` | `preloaded=true`, non-empty `domain` |
| V4.1.2 | `active-http-probe` | browser-facing HTTP redirects to HTTPS; API HTTP is not transparently redirected |
| V4.1.3 | `active-http-probe` | untrusted forwarded headers ignored; trusted proxy headers authenticated |
| V4.2.1 | `active-http-probe` | CL/TE ambiguity rejected; duplicate Content-Length rejected; message boundaries consistent |
| V4.2.3 | `active-http-probe` | HTTP/2/3 connection-specific headers rejected |
| V4.2.4 | `active-http-probe` | HTTP/2/3 CR/LF header names/values rejected |
| V11.7.1 | `host-hardening-probe` | full memory encryption; unauthorized process isolation |
| V11.7.2 | `host-hardening-probe` | sensitive processing minimized; data re-encrypted after use |
| V12.1.2 | `active-tls-probe` | forward secrecy only; recommended cipher suites only |
| V12.1.4 | `active-tls-probe` | revocation checking/stapling enabled |
| V12.1.5 | `dns-ech-probe` | ECH enabled |
| V12.2.2 | `active-tls-probe` | publicly trusted certificate; hostname verified |
| V13.2.1 | `backend-identity-probe` | all enabled backends authenticated; credentials short-lived or rotated |
| V13.2.2 | `backend-identity-probe` | backend identities least-privilege |
| V13.2.5 | `firewall-policy-probe` | egress default-deny; host/network allowlist same as or narrower than app allowlist |
| V13.3.1 | `crypto-provider-self-test` | hardware-backed; `keyExportable=false`; key isolation enabled |
| V13.3.2 | `crypto-provider-acl-probe` | least-privilege ACL; key extraction denied |
| V13.3.3 | `crypto-provider-self-test` | all secret-key operations isolated; key material never exported |
| V15.2.1 | `release-security-scan` | dependency and container scans pass; zero high and critical findings |
| V16.2.2 | `clock-source-probe` | synchronized; absolute `maxOffsetMs <= 1000` |
| V16.4.2 | `remote-audit-receipt` | remote immutability and retention enforced |
| V16.4.3 | `remote-audit-receipt` | logically separate sink; TLS verified; ingest authenticated |

A signed claim is not accepted as a substitute for the observation: each row must use the exact method above and satisfy the structured predicate in code. Forged, stale, duplicate, wrong-release, wrong-origin or wrong-method evidence fails closed.
