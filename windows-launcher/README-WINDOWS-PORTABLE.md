# Direct-Xfer 1.58.4 — Windows C# / WinForms

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

Identifiant interne : `1.58.4-launcher24-csharp`.

## Compilation sans script local

### Option 1 — GitHub Actions (recommandée)

Le workflow `.github/workflows/build-windows-csharp.yml` compile le launcher sur un runner Windows GitHub et produit l'artefact :

`Direct-Xfer-1.58.4-Windows-CSharp.zip`

Aucun script de compilation ne doit être exécuté sur le PC protégé.

### Option 2 — Visual Studio

1. Ouvrir `windows-launcher\DirectXfer.Launcher.sln` dans Visual Studio.
2. Choisir **Release**.
3. Menu **Build > Build Solution**.
4. Le launcher est produit dans `windows-launcher\bin\Release\Direct-Xfer.exe`.

Cette méthode utilise directement Visual Studio/MSBuild déjà approuvé sur la machine au lieu d'un script téléchargé.

## Node.js

Direct-Xfer ne télécharge plus Node.js. Pour un poste géré, déployez Node.js avec la méthode approuvée par l'organisation. Le launcher cherche successivement :

1. `DX_WINDOWS_NODE` ;
2. `runtime\node\node.exe` ;
3. l'installation Node.js standard sous Program Files ;
4. `node.exe` présent dans `PATH`.

Le runtime requiert Node.js 18 ou plus récent.

## Signature de code

Le passage à C# réduit les signaux heuristiques de l'ancien launcher Go, mais un environnement Smart App Control/App Control peut toujours refuser un **EXE non signé**. Pour une distribution d'entreprise, signez `Direct-Xfer.exe` avec un certificat Authenticode approuvé par la politique de l'organisation avant déploiement.
