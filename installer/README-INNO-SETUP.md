# Direct-Xfer — Inno Setup 1.60.0

Le workflow `.github/workflows/build-windows-csharp.yml` réalise la chaîne Windows complète :

1. installe les dépendances Node de production et bloque les avis npm high/critical ;
2. exécute les tests release-critical ;
3. compile `DirectXfer.ServerHost.csproj` puis `DirectXfer.Launcher.csproj` en **Release x64** ;
4. vérifie que les deux exécutables C# restent non signés par conception ;
5. crée le runtime portable ;
6. télécharge le Node.js officiel 24.19.0 x64 et vérifie son SHA-256 ;
7. télécharge Inno Setup 6.7.3 et vérifie la signature Authenticode de l’outil tiers avant de l’exécuter ;
8. compile `Direct-Xfer-Setup-1.60.0.exe` ;
9. vérifie que le Setup final reste non signé et calcule son SHA-256 ;
10. publie le Setup et le package portable comme Artifacts GitHub.

## Arborescence installée

L’installation sous `Program Files\Direct-Xfer` contient notamment :

- `Direct-Xfer.exe` / `.config` — interface et systray ;
- `Direct-Xfer.ServerHost.exe` / `.config` — supervision du backend ;
- `runtime\app\...` ;
- `runtime\node\node.exe`.

La configuration, les journaux et les données utilisateur restent sous LocalAppData / les dossiers sélectionnés par l’utilisateur. Le ServerHost est un processus d’arrière-plan **du même utilisateur**, pas un service LocalSystem, afin de préserver ces permissions.

## Mises à niveau

L’`AppId` reste stable. `AppMutex` protège à la fois `DirectXferLauncherInstance` et `DirectXferServerHostInstance` afin d’éviter une mise à niveau pendant qu’un composant Windows Direct-Xfer est actif. Seuls les arbres immuables `runtime\app` et `runtime\node` sont purgés avant recopie ; les données utilisateur ne sont pas supprimées.

## Signature

Les binaires Direct-Xfer et l’installateur sont volontairement produits **sans signature Authenticode**. La vérification Authenticode d’Inno Setup concerne uniquement l’outil tiers téléchargé pendant le build et ne signe pas Direct-Xfer.
