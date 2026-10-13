# Direct-Xfer 1.72.4 — audit profond de la 1.72.3

Base : `Direct-Xfer-1.72.3-security-and-quality.zip`. Aucun changement n'a été envoyé à GitHub.

## Régression HTTPS Local CA corrigée

- **Problème confirmé et reproduit** : l'adaptateur X.509 natif conservait uniquement la première entrée d'un RDN multi-attributs lors de la lecture d'une CA existante. À l'émission d'un nouveau certificat de serveur, il reconstruisait donc un nom d'émetteur incorrect. `loadTlsOptions()` pouvait réussir et la signature RSA être valide, alors que la chaîne de confiance échouait (`openssl verify`: `unable to get local issuer certificate`).
- **Correctifs** : `lib/server/native-x509-compat.js` décode désormais chaque attribut des ensembles RDN, conserve la représentation DER originale du Distinguished Name, et autorise `setIssuer()` à préserver cette représentation. `lib/server/tls-manager.js` transmet le nom X.509 complet de la CA, et non plus une seule liste reconstruite d'attributs. Les nouveaux certificats locaux conservent ainsi le nom d'émetteur exact, y compris pour les anciens certificats OpenSSL/node-forge comportant des RDN multivalués ou des encodages ASN.1 spécifiques.
- **Non-régression** : test automatisé qui génère une CA OpenSSL RSA-3072 avec `CN+OU` dans le même RDN, initialise Direct-Xfer, exécute `openssl verify -purpose sslserver`, puis vérifie qu'aucune rotation de CA ni de certificat feuille n'a lieu au redémarrage. Le test est ignoré si OpenSSL n'est pas disponible sur la machine de tests.

## Validation du reste des modifications récentes

- Génération native X.509, corruption de CA (échec fermé), sauvegarde des ancres de confiance et réutilisation des feuilles : tests ciblés réussis.
- Audits ASVS statique et ASVS L3 partiel : **PASS**, 128 fichiers de production, 38 contrôles, zéro finding bloquant pour l'audit partiel.
- Manifeste d'intégrité Windows recalculé : **104 entrées, zéro hash périmé**.
- Métadonnées serveur, version Windows, lockfile npm, broker OAuth, SBOM, VEX et PWA synchronisées en **1.72.4**. Nouvelle génération de cache PWA : `pwa519` (`v=499`). Assertions de cache des tests mises à jour.
- **Suite complète** (`npm test`) : **1 260 réussites / 1 262 tests**, 2 échecs identiques à ceux de 1.72.3. L'environnement de test contient des `node_modules` précédents avec `qs` **6.15.3**, tandis que le lockfile final exige `qs` **6.16.0**. Le paquet distribué exclut ce répertoire obsolète.
- Relecture des correctifs npm (`proxy-addr` 2.0.8, `brace-expansion` 5.0.12, `qs` 6.16.0, Express 4.22.3, Nodemailer 10.0.10) et des verrous du Dockerfile rclone/Go : conservés, sans modifier les contrôles de vulnérabilité.

## Vérifications requises sur une machine connectée

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=moderate
node scripts/sync-windows-runtime-manifest.js --check
docker build --pull --platform=linux/amd64 -t direct-xfer:1.72.4 .
```

Le téléchargement npm récent, les tests intégrés avec dépendances réinstallées, le build Docker/rclone/Go, le build Windows, la signature SignPath et le scan Trivy de l'image créée n'ont pas pu être exécutés dans le conteneur d'audit. Les alertes Debian et les alertes privées GitHub nécessitent leur propre réévaluation ; aucun contrôle de sécurité n'a été désactivé pour forcer un résultat vert.
