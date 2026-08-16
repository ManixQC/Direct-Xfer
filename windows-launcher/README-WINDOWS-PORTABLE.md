# Direct-Xfer 1.62.3 — Windows C# / WinForms

La distribution Windows utilise désormais **deux exécutables C#/.NET Framework 4.8 x64 distincts** :

- `Direct-Xfer.exe` : interface/systray, configuration et ouverture de l’interface web ;
- `Direct-Xfer.ServerHost.exe` : processus d’arrière-plan dédié qui supervise le backend Node.js.

Cette séparation évite que le launcher visible lance ou termine directement `node.exe`. Le ServerHost fonctionne sous le **même compte utilisateur** afin de conserver les permissions sur les dossiers de données, de réception, d’images et de fichiers hôte choisis par l’utilisateur.

## Distribution Windows

Le flux normal ne demande pas d’exécuter de fichier `.cmd`, `.bat` ou `.ps1` sur le poste cible.

- Aucun runtime Go, packer ou archive auto-extractible n’est embarqué dans les exécutables C#.
- Aucun exécutable n’est téléchargé au premier lancement.
- Le package contient le runtime applicatif visible dans `runtime\app`.
- Le package GitHub/Inno contient le Node.js officiel 24.19.0 x64 dans `runtime\node\node.exe`.
- Le ServerHost vérifie le SHA-256 du Node portable et les fichiers critiques du runtime avant le démarrage.
- Un Node externe n’est accepté que via `DX_WINDOWS_NODE` accompagné de `DX_WINDOWS_NODE_SHA256`.
- Le launcher et le ServerHost vérifient PID, chemin et heure de démarrage avant de reprendre une session existante.

Identifiants internes :

- launcher : `1.62.3-launcher44-csharp`
- server host : `1.62.3-serverhost17-csharp`

## Compilation sans script local

### GitHub Actions (recommandé)

Le workflow `.github/workflows/build-windows-csharp.yml` compile **les deux projets x64**, prépare le runtime portable puis génère :

- l’artefact `Direct-Xfer-1.62.3-Windows-CSharp` ;
- l’installateur `Direct-Xfer-Setup-1.62.3.exe`.

### Visual Studio

Ouvrir `windows-launcher\DirectXfer.Launcher.sln`, sélectionner **Release / x64**, puis **Build > Build Solution**. La solution contient le launcher et le ServerHost.

## Structure requise du package portable

Après extraction, conserver les fichiers côte à côte :

```text
Direct-Xfer.exe
Direct-Xfer.exe.config
Direct-Xfer.ServerHost.exe
Direct-Xfer.ServerHost.exe.config
runtime\
  app\
  node\node.exe
```

Ne lancez pas `Direct-Xfer.exe` directement depuis une archive ZIP et ne copiez pas seulement le launcher ailleurs.

### Démarrage du package portable

Contrairement à l’installateur Inno Setup, un ZIP portable ne peut pas enregistrer le démarrage automatique du ServerHost sans modifier Windows. Pour conserver la séparation stricte des responsabilités :

1. lancez `Direct-Xfer.ServerHost.exe` ;
2. lancez ensuite `Direct-Xfer.exe`.

Le ServerHost peut être lancé avant la première configuration : il attendra silencieusement que le launcher enregistre les dossiers. Après installation via le Setup, cette étape manuelle n’est pas nécessaire : l’installateur démarre le ServerHost et crée son entrée de démarrage à l’ouverture de session.

## Arrêt et reprise

Quitter `Direct-Xfer.exe` ferme uniquement la systray : le ServerHost et le backend continuent de fonctionner indépendamment. Les changements de configuration sont transmis au ServerHost par un événement IPC privé de reload. Lors d’une mise à jour, d’une désinstallation ou d’une fermeture de session Windows, le ServerHost reçoit sa propre demande d’arrêt, tente l’arrêt authentifié du serveur Direct-Xfer et ne termine le processus Node exact qu’en dernier recours. Si la systray plante, le ServerHost continue donc à maintenir le backend ; au prochain lancement, l’UI ne se rattache à la session que si le binaire attendu et l’IPC du ServerHost sont encore valides.

## Signature de code

Le workflow produit volontairement `Direct-Xfer.exe`, `Direct-Xfer.ServerHost.exe` et l’installateur sans signature Authenticode. Les empreintes SHA-256 restent générées pour l’intégrité.
