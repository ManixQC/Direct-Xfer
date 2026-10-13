# Direct-Xfer 1.72.2 — Dependabot maintenance

Source: `Direct-Xfer latest.zip` (1.72.1). This is a source-only maintenance ZIP; no GitHub repository, pull request or release was modified.

## Updated dependencies

- Express: `^4.22.2` -> `^4.22.3` (Dependabot PR #11).
- Nodemailer: `^9.1.1` -> `^10.0.10` (PR #12); this incorporates and supersedes PR #13's `10.0.9` update. Nodemailer 10 requires Node 20+, already compatible with the project's Node engine declaration.
- `qs` remains overridden and locked to `6.16.0`; `path-to-regexp` remains locked at `0.1.13`.
- Root `package-lock.json` updates include upstream `resolved` URLs and SHA-512 integrity strings taken from the Dependabot PR lockfiles.

## GitHub Actions pins (Dependabot PR #14)

| Action | Release |
| --- | --- |
| actions/setup-node | v7.1.0 |
| actions/upload-artifact | v7.0.2 |
| signpath/github-action-submit-signing-request | v3.0 |
| actions/download-artifact | v8.0.2 |
| github/codeql-action/upload-sarif | v4.38.3 |
| zizmorcore/zizmor-action | v0.6.4 |

All 24 affected `uses:` declarations retain immutable, full-length GitHub commit SHA pins.

## Release alignment

- Application, lockfile, OAuth broker, Cloudflare Worker package, Windows installer defaults and Windows workflow: `1.72.2`.
- PWA: build `2026.10.13-pwa517`, matching service worker, app metadata and cache-buster `v=497`.
- Updated CycloneDX SBOM, OpenVEX, security inventory and automated ASVS static/partial audits.
- Updated current regression tests and retired superseded, version-stamped dependency-pin tests; retained historical files for provenance.

## Verification and remaining steps

- `npm install --package-lock-only --offline --ignore-scripts`: **passes**, exact lockfile preserved.
- Static ASVS source audit: **passes** (127 files, 0 blocking findings).
- ASVS partial closure audit: **passes** (38 checks, 0 blocking findings).
- Full local test run: **1257 passed / 2 failed**. Both failures are `qs` security regression tests because the original ZIP contained an old preinstalled `node_modules/qs` (`6.15.3`), despite the lockfile correctly resolving `6.16.0`. These old `node_modules` are intentionally **not included** here.
- Before releasing binaries, run `npm ci --ignore-scripts` then `npm test`, `npm audit --omit=dev --audit-level=moderate`, and perform actual CI Windows/SignPath signing tests. The environment used to prepare this ZIP could not reach the npm registry, so it could not freshly install the updated packages or validate SignPath's remote operation.

## ZIP contents

Complete working-source project, including `.github` workflows, tests, Windows build sources, installer, OAuth broker and PWA, excluding `.git`, stale `node_modules`, local state, and temporary audit/unsigned build artifacts.
