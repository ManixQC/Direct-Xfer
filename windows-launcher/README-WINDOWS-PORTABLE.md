# Direct-Xfer 1.59.1 — Windows C# / WinForms

Cette édition remplace intégralement l'ancien launcher Go par une application Windows conventionnelle **C# / WinForms ciblant .NET Framework 4.8**.

## Distribution compatible avec les postes protégés

Le flux normal ne demande plus d'exécuter de fichier `.cmd`, `.bat` ou `.ps1` sur le poste cible.

- Le launcher ne contient aucun runtime Go.
- Il n'embarque aucune archive auto-extractible.
- Il ne télécharge aucun exécutable.
- Il n'appelle ni PowerShell ni `taskkill.exe`.
- L'application est visible dans `runtime\app`.
- Node.js peut provenir d'une installation Windows gérée/approuvée ou de `runtime\node\node.exe`.
- Le Node portable, lorsqu'il est utilisé, est vérifié par SHA-256.
- Les fichiers critiques de `runtime\app` sont vérifiés par SHA-256 avant démarrage.

Identifiant interne : `1.59.1-launcher27-csharp`.

## Compilation sans script local

### Option 1 — GitHub Actions (recommandée)

Le workflow `.github/workflows/build-windows-csharp.yml` compile le launcher sur un runner Windows GitHub et produit l'artefact :

`Direct-Xfer-1.59.1-Windows-CSharp` (GitHub le fournit au téléchargement sous forme d’archive ZIP)

Aucun script de compilation ne doit être exécuté sur le PC protégé.

### Option 2 — Visual Studio

1. Ouvrir `windows-launcher\DirectXfer.Launcher.sln` dans Visual Studio.
2. Choisir **Release**.
3. Menu **Build > Build Solution**.
4. Le launcher est produit dans `windows-launcher\bin\Release\Direct-Xfer.exe`.

Cette méthode utilise directement Visual Studio/MSBuild déjà approuvé sur la machine au lieu d'un script téléchargé.

## Node.js

Direct-Xfer ne télécharge plus Node.js. Le launcher accepte uniquement :

1. `runtime\node\node.exe` — runtime officiel **x64** épinglé par SHA-256 et devant correspondre exactement à Node.js 24.19.0 ;
2. un runtime externe explicitement défini par `DX_WINDOWS_NODE`, uniquement si `DX_WINDOWS_NODE_SHA256` contient aussi son SHA-256 exact.

Le launcher ne recherche plus automatiquement `node.exe` dans `PATH` ni dans `Program Files`. Un runtime externe doit être un PE AMD64 normal, ne pas être un point de réanalyse et utiliser **Node.js 20 ou Node.js 22+**. Node 18 et Node 21 sont refusés afin de rester aligné sur le contrat `engines` de l'arbre de dépendances de production.

## Signature de code

Le workflow sait signer **optionnellement** le launcher et l'installateur final via Azure Artifact Signing. Activez la variable de dépôt `DX_ARTIFACT_SIGNING_ENABLED=true`, configurez les secrets OIDC Azure (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) et les variables `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`, `AZURE_ARTIFACT_SIGNING_PROFILE`. Sans cette configuration, le build reste volontairement non signé.


## Important — extract the GitHub Artifact first

GitHub Actions already downloads the artifact as a ZIP. Use **Extract all** before launching Direct-Xfer.
Do not run `Direct-Xfer.exe` from inside the ZIP and do not copy only the EXE elsewhere.
The extracted directory must contain `Direct-Xfer.exe` and the `runtime` folder side by side.
