# Direct-Xfer 1.72.5 — Dependabot Nodemailer 10.1.0

Baseline: Direct-Xfer 1.72.4 deep-audit fixes. This ZIP contains only local changes; GitHub was not modified.

## Update

- Applied GitHub PR #15's Nodemailer upgrade from 10.0.10 to 10.1.0, using the exact published `package-lock.json` SHA-512 integrity in Dependabot's proposed change.
- Synchronized the root `package.json` and `package-lock.json`, CycloneDX SBOM package/digest/dependency references, OpenVEX release references, and current-release npm regression assertions.
- Preserved Express 4.22.3 and audited `qs` 6.16.0, `proxy-addr` 2.0.8 and `brace-expansion` 5.0.12 overrides.
- Synchronized version metadata across Windows, OAuth broker, PWA and security metadata to 1.72.5; advanced the PWA cache to `pwa520` and asset cache generation `v=500`.
- Preserved immutable GitHub Actions pins and fail-closed CI security gates.

## Verification and limitations

The complete source tests and integrity checks should be run with installed dependencies:

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=moderate
node scripts/sync-windows-runtime-manifest.js --check
```

The build Docker, Windows/SignPath signing and production mail delivery are not certified by a local source-only test run.

## Résultats vérifiés sur l'archive source

- Mise à jour de la PR #15 vérifiée à partir de son diff GitHub : uniquement la version Nodemailer et son URL/intégrité SHA-512 sont modifiées dans les deux manifestes npm.
- Test ciblé Nodemailer, SBOM, workflow-pins, correctifs GitHub et maintenance : **12/12 PASS** après ajout d'une vérification du hash SHA-512 SBOM contre `package-lock.json`.
- Suite `npm test` (avant cet ajout purement documentaire/de validation) : **1 238 PASS / 1 249 tests, 11 échecs** dus à l'absence de `express` dans cet environnement source sans `node_modules`. Les tests cibles repassent après le changement.
- Audit ASVS statique : **PASS sur 128 fichiers de production** ; audit ASVS partiel : **38 contrôles, 0 finding bloquant**.
- Intégrité Windows ServerHost : **104 entrées**, zéro hachage périmé pour les sources présentes. L'entrée `node_modules/express/package.json` ne peut être vérifiée qu'après `npm ci`.
- **Pas de test SMTP réel**, ni de nouvelle analyse npm en ligne, ni de construction Docker/Windows/SignPath exécutés dans cet environnement.
- `npm ci --ignore-scripts` et `npm test` sur une machine connectée sont obligatoires avant publication. Aucune vulnérabilité ne doit être masquée pour obtenir une CI verte.
