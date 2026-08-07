# Direct-Xfer Android Companion 1.3.0

Application Android native complémentaire à Direct-Xfer. Elle peut être installée en parallèle de la PWA.

## Nouveautés 1.3.0

- interface entièrement redessinée à l'image exacte de la PWA : palette Direct-Xfer (fond `#0b1020`, accent `#3b6ef6`), en-tête avec logo, badge « Appareil associé » et pilule réseau;
- navigation basse à quatre panneaux identiques à la PWA — **Envoyer**, **Images**, **Activité**, **Réglages** — avec cartes, boutons et dialogues au même style sombre;
- fonctionnalités inchangées sous le capot : file WorkManager durable, reprise par blocs et uploads en arrière-plan conservés.

## Nouveautés 1.2.0

- interface multilingue (français, anglais, espagnol) avec sélecteur intégré et prise en charge du choix de langue par application (Android 13+);
- icône adaptative avec couche monochrome (icône thématisée Android 13+) et raccourcis d'application (« Choisir des fichiers », « Ouvrir la PWA »);
- option « Envoyer uniquement en Wi-Fi », suspension/reprise globale de la file, et priorisation d'un envoi;
- réglages d'image configurables (dimensions Pleine/Mini/Micro et qualité JPEG);
- fiche détaillée d'un transfert avec QR du lien, débit et temps restant estimé, canal de notification dédié aux résultats;
- gestion des destinations (renommer, supprimer), effacement groupé des transferts terminés, invitation à exclure l'app de l'optimisation de batterie;
- lectures de la file hors du thread principal, plafond de transferts simultanés et persistance de progression optimisée.

## Fonctions incluses

- cible de partage Android (`ACTION_SEND` et `ACTION_SEND_MULTIPLE`) pour photos et fichiers;
- création native de liens d'image Pleine/Mini/Micro;
- envois persistants vers un lien de réception Direct-Xfer;
- file locale durable, reprise exacte par blocs et contraintes réseau avec WorkManager;
- reprise après extinction de l’écran, fermeture de l’interface, arrêt du processus, redémarrage du téléphone et mise à jour de l’application;
- points de contrôle persistants pour les images Pleine/Mini/Micro, sans recréer un lien déjà validé par le serveur;
- surveillance périodique des tâches interrompues et réassociation automatique avec WorkManager;
- service de premier plan et notifications de progression, réussite, échec et annulation;
- nettoyage EXIF/GPS local facultatif;
- verrouillage de l'interface par biométrie ou code de l'appareil;
- jeton d'appareil révocable et secrets chiffrés avec Android Keystore;
- ouverture de la PWA, test de connexion et révocation de l'appareil depuis l'application.

## Prérequis serveur

Déploie le `server.js` inclus dans cette archive. Le compagnon utilise `POST /app/companion/login` pour transformer une authentification administrateur réussie en jeton d'appareil limité aux routes mobiles `/app`. Le mot de passe et le code 2FA ne sont jamais conservés par l'application.

Le serveur doit être accessible par une URL HTTPS avec un certificat reconnu par Android. Les règles `ADMIN_ALLOWED_IPS` et le contrôle d'accès du reverse proxy s'appliquent aussi à la connexion initiale.

## Construction dans Android Studio

1. Ouvre le dossier `android-companion`.
2. Installe le SDK Android 36 et Java 17 lorsque demandé.
3. Laisse Gradle synchroniser le projet.
4. Utilise **Build > Generate Signed App Bundle / APK**.
5. Conserve soigneusement le keystore : toutes les mises à jour futures doivent être signées avec la même clé.

Le projet utilise Gradle 8.13. Les scripts `gradlew` et `gradlew.bat` téléchargent au premier lancement le JAR officiel du wrapper et vérifient son SHA-256 avant exécution. La distribution Gradle est elle aussi verrouillée par checksum.

### Construction PowerShell

```powershell
cd .\android-companion
.\build-apk.ps1
```

Le résultat non signé est produit dans :

```text
app\build\outputs\apk\release\app-release-unsigned.apk
```

Pour un APK de test installable sans configuration de signature :

```powershell
.\gradlew.bat assembleDebug
```

### Construction automatique sur GitHub

Le workflow `.github/workflows/android-companion.yml` construit aussi un APK de débogage à chaque modification du dossier Android. Dans GitHub, ouvre **Actions > Android Companion APK > Run workflow**, puis télécharge l'artifact `Direct-Xfer-Android-Companion-debug`.

## Première connexion

À la première ouverture, saisis :

- l'URL HTTPS Direct-Xfer;
- le nom d'utilisateur administrateur;
- le mot de passe;
- le code 2FA ou de récupération si le compte en exige un.

Le serveur renvoie un jeton révocable propre à l'appareil. Le jeton et son secret CSRF sont chiffrés avec Android Keystore.

## Envoi depuis Android

Dans Photos, Fichiers ou une autre application, choisis **Partager**, puis **Direct-Xfer — Envoyer**. Les photos créent par défaut un lien d'image. Les autres fichiers utilisent le lien de réception sélectionné dans le compagnon. Les fichiers sont d'abord copiés dans le stockage privé de l'application afin que l'envoi puisse reprendre même après la fermeture de l'écran source. La file conserve son état dans SQLite et utilise un identifiant stable côté serveur. Pour les liens d'image, les étapes Pleine, Mini et Micro sont enregistrées séparément; après une interruption, seules les étapes manquantes sont reprises.

## Limites Android

- Les liens de réception chiffrés E2E et protégés par mot de passe restent gérés par la PWA. Le compagnon natif accepte les liens de réception standards.
- Les images animées sont aplaties lorsque le nettoyage EXIF/GPS est activé.
- Le projet source est fourni, mais aucun APK signé n'est inclus : la clé de signature doit appartenir au propriétaire de l'application.
- L'action Android **Forcer l'arrêt** bloque volontairement WorkManager et les récepteurs jusqu'à la prochaine ouverture manuelle de l'application. Une fermeture normale, un balayage depuis les applications récentes, un écran éteint ou un redémarrage ne suppriment pas la file.
