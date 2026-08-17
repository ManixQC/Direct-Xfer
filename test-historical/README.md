# Tests historiques Direct-Xfer

Ce dossier archive la suite de tests historique du dépôt Direct-Xfer telle qu’elle existait au commit `2bda57280908b8b9ec8b3bc6d591438c3a5b0295`.

- `MANIFEST.json` contient les 326 noms et SHA Git originaux.
- `node scripts/restore-historical-tests.js` matérialise tous les fichiers exacts depuis `raw.githubusercontent.com`, vérifie chaque SHA Git, puis les écrit atomiquement ici.
- Les tests actifs adaptés à Direct-Xfer 1.64.0 restent dans `test/`.
- Les anciens tests peuvent contenir des assertions de version/cache qui sont volontairement obsolètes par rapport à 1.64.0 ; ils sont conservés comme historique de régression et ne font donc pas partie de `npm test`.
