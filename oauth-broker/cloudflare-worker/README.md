# Direct-Xfer Public OAuth Broker — Cloudflare Workers

Ce dossier déploie le broker OAuth central Direct-Xfer sur **Cloudflare Workers** avec une URL HTTPS publique stable et **D1** pour la persistance.

## Ce que le broker centralise

- Le Client ID / Client Secret Google Web existent uniquement sur le Worker.
- Les installations Direct-Xfer ne reçoivent jamais le Client Secret Google.
- Le callback Google est unique : `https://<worker>.<compte>.workers.dev/v1/google/callback` (ou votre domaine personnalisé).
- Les refresh tokens Google sont chiffrés avec AES-GCM avant stockage D1.
- Chaque remote rclone reçoit un identifiant/secret opaque propre et renouvelle son access token via `/v1/google/token`.
- Les sessions OAuth expirent rapidement et les credentials ont une durée de vie limitée.

## Déploiement Windows (PowerShell)

Depuis ce dossier :

```powershell
.\scripts\deploy.ps1
```

Le script :

1. connecte Wrangler à votre compte Cloudflare ;
2. crée/réutilise la base D1 `direct-xfer-oauth-broker` ;
3. applique les migrations ;
4. demande le Client ID / Secret Google **une seule fois pour le broker** ;
5. génère une clé de chiffrement forte ;
6. enregistre les trois valeurs comme **secrets Cloudflare** ;
7. déploie le Worker sur `workers.dev` ;
8. affiche l'URL à mettre dans `DIRECT_XFER_OAUTH_BROKER_URL`.

## Google Cloud — configuration unique du broker

Créez un client OAuth **Application Web** pour le broker. Après le premier déploiement, ajoutez exactement l'URI affichée par le script dans **URI de redirection autorisés** :

```text
https://VOTRE-WORKER.VOTRE-SOUS-DOMAINE.workers.dev/v1/google/callback
```

Pour un domaine personnalisé, utilisez son origine HTTPS à la place.

## Direct-Xfer

Sur chaque instance :

```text
DIRECT_XFER_OAUTH_BROKER_URL=https://VOTRE-WORKER.VOTRE-SOUS-DOMAINE.workers.dev
```

Aucune configuration Google supplémentaire n'est nécessaire sur cette instance.

## Domaine personnalisé (production)

`workers.dev` convient pour démarrer. Pour une installation durable, vous pouvez affecter un Custom Domain Cloudflare au Worker et enregistrer son callback auprès de Google.

## Endpoints

- `GET /healthz`
- `GET /v1/info`
- `POST /v1/google/sessions`
- `GET /v1/google/callback`
- `GET /v1/google/sessions/:id`
- `DELETE /v1/google/sessions/:id`
- `POST /v1/google/token`

## Sécurité

Ne commitez jamais `wrangler.jsonc`, `.dev.vars`, les secrets Google ou `BROKER_DATA_KEY`. Le fichier `.gitignore` de ce dossier les exclut.

## Production Google — points obligatoires

Depuis Direct-Xfer 1.67.30, le broker applique le **moindre privilège**. Le scope par défaut est `https://www.googleapis.com/auth/drive.file`, qui limite Direct-Xfer aux fichiers et dossiers créés ou explicitement ouverts pour l’application. Deux élévations explicites restent disponibles dans l’interface : `drive.readonly` pour parcourir/importer tous les fichiers existants sans modification, et `drive` pour lire et modifier l’ensemble du Drive. Ces deux derniers scopes sont classés **restreints** par Google.

Pour une publication destinée à des utilisateurs externes :

1. placez l'application OAuth Google en **Production** lorsque vous êtes prêt ;
2. utilisez `drive.file` pour le mode recommandé ;
3. ne demandez `drive.readonly` ou `drive` que si les fonctions correspondantes sont réellement nécessaires ;
4. si vous utilisez un scope restreint, complétez la vérification OAuth et, le cas échéant, l’évaluation de sécurité demandées par Google ;
5. ne laissez pas le projet en mode **Testing** pour un service durable ;
6. conservez `BROKER_DATA_KEY` de façon permanente. La perdre ou la remplacer rend les refresh tokens déjà chiffrés dans D1 illisibles.

Les scripts `deploy.ps1` et `deploy.sh` détectent maintenant un secret `BROKER_DATA_KEY` existant et **ne le régénèrent pas lors d'un redeploy**. Une rotation de cette clé nécessite une migration explicite des données ; ne la faites pas avec un simple `wrangler secret put`.

## Redéploiement sûr

Relancer le script de déploiement est supporté : la base D1 existante est réutilisée, les migrations sont rejouées de façon idempotente et la clé de chiffrement existante est conservée. Les identifiants Google peuvent être remplacés sans rotation de `BROKER_DATA_KEY`.

L'URL du broker configurée dans Direct-Xfer doit être une **origine HTTPS sans sous-chemin**, par exemple :

```text
https://direct-xfer-oauth-broker.example.workers.dev
```

et non `https://example.com/oauth-broker`.

### Remplacement des identifiants Google

Par sécurité, les scripts refusent de remplacer le Client ID / Secret Google lorsqu'il existe déjà des credentials broker dans D1 : les refresh tokens existants pourraient devenir inutilisables. Si une rotation est réellement planifiée et que les remotes seront reconnectés, l'administrateur peut explicitement définir `DX_OAUTH_BROKER_FORCE_GOOGLE_CREDENTIAL_REPLACE=1` pour ce déploiement. N'utilisez pas cet override pour une mise à jour normale du code.
