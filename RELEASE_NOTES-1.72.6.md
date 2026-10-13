# Direct-Xfer 1.72.6 — Brace-expansion Dependabot hardening

Base: `Direct-Xfer-1.72.5-Nodemailer-10.1.0.zip`. GitHub repository unchanged.

## Root cause and remediation

GitHub Dependabot alert #16 refers to **brace-expansion 5.0.9** (GHSA-6j4f-fj2g-mc7p / CVE-2026-102276), transitively imported by `archiver 8.0.0` -> `readdir-glob` -> `minimatch`. The patched minimum is 5.0.10. Both the source ZIP 1.72.5 and the currently read GitHub main branch already pin **5.0.12** under `package.json` `overrides` and resolve the only brace-expansion package to 5.0.12 in the lockfile. Therefore this is **not a newly found vulnerable dependency in the archive**; the alert describes a prior resolved revision or an unsynchronized GitHub advisory state.

Version 1.72.6 retains the patched override and its published SHA-512 npm integrity, adds a durable regression test to prevent a vulnerable nested copy, validates CycloneDX SBOM parity, does not add a VEX waiver or suppress the alert, and synchronizes application/Windows/OAuth/PWA release metadata. Security gates are unchanged (fail closed).

## Reproduction and validation

```sh
npm ls brace-expansion --all --package-lock-only
npm ci --ignore-scripts --no-audit --no-fund
npm ls brace-expansion --all
npm test
npm audit --omit=dev --audit-level=moderate
node scripts/sync-windows-runtime-manifest.js --check
```

To clear the GitHub alert, the patched `package.json` and `package-lock.json` must be present on the GitHub default branch and GitHub Dependabot must re-evaluate the dependency graph. A local ZIP cannot update or dismiss a GitHub alert. If it remains open after an updated dependency-graph scan, inspect the alert's manifest and commit in GitHub's Security tab; do not dismiss a genuine vulnerable finding.

## Verification limits

A lockfile resolution check and source tests verify this fix without installing packages. A fresh npm audit and Docker/Windows CI builds are still required after publishing; alerts concerning other packages are not addressed by this specific regression guard.
