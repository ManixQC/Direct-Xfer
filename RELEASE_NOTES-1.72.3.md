# Direct-Xfer 1.72.3 — corrections Security and quality

Base de travail : Direct-Xfer 1.72.2 (archive Dependabot). Aucune modification effectuée sur le dépôt GitHub distant.

## Dépendances Node.js

- `proxy-addr` 2.0.8 (override npm) : correction de l'usurpation d'adresse IP par IPv4-mapped IPv6 (GHSA-jqcg-44mw-7w3h / CVE-2026-90711).
- `brace-expansion` 5.0.12 (override npm) : trois correctifs de déni de service (CVE-2026-102276, CVE-2026-102278 et CVE-2026-102277).
- `nodemailer` 10.0.10 et Express 4.22.3 : mises à jour 1.72.2 conservées ; `qs` 6.16.0 reste verrouillé.
- `node-forge` 1.4.0 supprimé de la dépendance runtime (CVE-2026-85393, pas de correctif npm disponible lors de cet audit). Pour préserver HTTPS Local CA, les certificats X.509 sont désormais générés en DER et **signés et vérifiés cryptographiquement** par `node:crypto` / OpenSSL via `lib/server/native-x509-compat.js`. Aucun CA existant n'est régénéré silencieusement en cas de certificat invalide. Le gestionnaire TLS, la sauvegarde/restauration et les points d'administration utilisent la même interface validée.
- Lockfile, CycloneDX SBOM, inventaire sécurité et manifeste Windows synchronisés.

## Construction de l'image Docker et rclone

- Construction Docker de rclone mise à jour à **rclone v1.75.2**, avec **Go 1.26.9**, `golang.org/x/crypto` **v0.57.0**, `golang.org/x/net` **v0.60.0**, `golang.org/x/image` **v0.45.0** et gRPC vérifié.
- L'image de base Go demeure figée par digest. Le compilateur Go 1.26.9 officiel est téléchargé uniquement depuis `dl.google.com`, soumis à un contrôle SHA-256 **par architecture** à partir des sommes publiées par `docker-library/golang`, puis installé dans le builder. Un binaire rclone dont les versions intégrées ne correspondent pas aux versions imposées fait échouer la construction.
- Les 11 avis Trivy portant sur l'ancien binaire rclone sont visés par les mises à jour 1.75.2 / Go 1.26.9 / x/net 0.60.0 ; leur disparition du rapport exige une reconstruction Docker et un nouveau scan CI.

## Vérifications effectuées

- `npm test` (avec les anciennes dépendances préinstallées de l'archive 1.72.1, **non livrées**) : **1 259 / 1 261 réussis**. Deux échecs proviennent de `qs` 6.15.3 ancien dans les `node_modules` locaux, alors que `package-lock.json` verrouille `qs` 6.16.0.
- Tests de création/validation native des certificats HTTPS : réussis, incluant redémarrage et CA corrompu.
- Audit statique ASVS : PASS, 128 fichiers de production et 10 sites de décodage examinés.
- Audit partiel ASVS L3 : PASS, 128 fichiers, 38 contrôles, 0 finding bloquant.
- Manifeste d'intégrité Windows : 104 entrées, 0 hash obsolète.
- Tests statiques Docker/rclone et synchronisation PWA : réussis.

## Points restant à confirmer / limites de l'audit

1. Une installation **fraîche** avec `npm ci --ignore-scripts`, puis `npm audit --omit=dev --audit-level=moderate` et `npm test`, est obligatoire avant publication. Le conteneur d'analyse ne dispose pas de l'accès au registre npm pour exécuter cette vérification avec les modules récents.
2. La construction Docker et le scan Trivy de l'image finale doivent être exécutés par CI. Le rapport précédent contenait **182 alertes sur les paquets système Debian 13** sans version corrective indiquée ; aucune n'a été masquée, et leur état doit être réévalué après reconstruction.
3. Le rclone Windows optionnel est toujours épinglé à **v1.75.1** (hash de l'archive Windows signé et validé par le projet). Son passage à v1.75.2 nécessite la validation du nouvel artefact binaire officiel et de ses empreintes SHA-256. Cela n'est pas inclus dans les corrections Docker.
4. Les alertes privées Code Scanning, Secret Scanning et Dependabot du tableau GitHub « Security and quality » n'étaient pas disponibles via le connecteur utilisé : cet audit est fondé sur les journaux GitHub Actions et les rapports Trivy et npm publiés par ces workflows.
5. Le pipeline Windows, la signature SignPath, l'installation npm fraîche et le build Docker n'ont **pas** été exécutés dans cet environnement. Ne pas affirmer que les scans CI sont déjà verts.

## Vérifications à lancer après intégration

```sh
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=moderate
npm test
node scripts/sync-windows-runtime-manifest.js --check
docker build --pull --platform=linux/amd64 -t direct-xfer:security-audit .
```

La publication sur GitHub est laissée entièrement à l'utilisateur.
