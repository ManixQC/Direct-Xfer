'use strict';

// Reveal the companion PWA links on phones and touch-first tablets.
// Do not rely on the user-agent alone: iPadOS desktop mode and some Android
// WebViews report a desktop UA. CSS also provides a responsive fallback.
(function initMobilePwaLinks() {
  const mobileQueries = [
    '(max-width: 900px)',
    '(pointer: coarse)',
    '(any-pointer: coarse)',
    '(hover: none)',
    '(any-hover: none)',
  ];

  function queryMatches(query) {
    try { return !!(window.matchMedia && window.matchMedia(query).matches); }
    catch (_) { return false; }
  }

  function isMobileClient() {
    try {
      const ua = navigator.userAgent || '';
      const uaDataMobile = !!(navigator.userAgentData && navigator.userAgentData.mobile);
      const mobileUa = /Android|iPhone|iPad|iPod|IEMobile|BlackBerry|Opera Mini|Mobile/i.test(ua);
      const ipadDesktopMode = /Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1;
      const touch = Number(navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
      const coarse = queryMatches('(pointer: coarse)') || queryMatches('(any-pointer: coarse)');
      const noHover = queryMatches('(hover: none)') || queryMatches('(any-hover: none)');
      const viewportWidth = Math.min(
        Number(window.innerWidth || Infinity),
        Number(window.visualViewport && window.visualViewport.width || Infinity),
        Number(window.screen && window.screen.width || Infinity),
      );
      const compact = viewportWidth <= 1024;
      return uaDataMobile || mobileUa || ipadDesktopMode || (compact && touch && (coarse || noHover));
    } catch (_) {
      return queryMatches('(max-width: 900px)');
    }
  }

  function applyMobileClientClass() {
    const mobile = isMobileClient();
    document.documentElement.classList.toggle('is-mobile', mobile);
    if (document.body) document.body.classList.toggle('is-mobile', mobile);
  }

  applyMobileClientClass();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyMobileClientClass, { once: true });
  }
  window.addEventListener('resize', applyMobileClientClass, { passive: true });
  window.addEventListener('orientationchange', applyMobileClientClass, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyMobileClientClass, { passive: true });
  }
  if (window.matchMedia) {
    mobileQueries.forEach((query) => {
      try {
        const media = window.matchMedia(query);
        if (media.addEventListener) media.addEventListener('change', applyMobileClientClass);
        else if (media.addListener) media.addListener(applyMobileClientClass);
      } catch (_) {}
    });
  }
})();

// ==================================================================
// Translations (fr / en / es)
// ==================================================================
const I18N = {
  fr: {
    // --- Client nicknames by IP (added) ---
    'ipn.prompt': 'Surnom pour {ip} :',
    'ipn.clickHint': 'Cliquer pour renommer ce client',
    'ipn.saved': 'Surnom enregistré ✓',
    'ipn.cleared': 'Surnom retiré',
    'ipn.fail': 'Enregistrement impossible',
    'auditA.ip-named': 'Client renommé',
    'auditA.ip-unnamed': 'Surnom de client retiré',
    // --- Nominative sub-links (added) ---
    'rcp.label': 'Sous-liens nominatifs ({n}) :',
    'rcp.dl': '{n} téléch.',
    'rcp.add': 'Ajouter',
    'rcp.addPh': 'Nom(s) — séparés par une virgule',
    'rcp.remove': 'Supprimer ce sous-lien',
    'rcp.limitsTitle': 'Limites propres à ce destinataire',
    'rcp.maxDlPrompt': 'Téléchargements max pour « {name} » (vide = illimité) :',
    'rcp.expiryPrompt': 'Expiration pour « {name} » en jours (vide = jamais) :',
    'rcp.limitsSaved': 'Limites du destinataire enregistrées',
    'rcp.limitsFail': 'Échec de l’enregistrement',
    'acc.title': 'Règles d’accès (géo / IP)',
    'acc.geoMode': 'Pays',
    'acc.off': 'Aucune restriction',
    'acc.allowOnly': 'Autoriser seulement',
    'acc.deny': 'Bloquer',
    'acc.countries': 'Codes pays (ISO, séparés par des virgules)',
    'acc.ipMode': 'Adresses IP',
    'acc.ips': 'IP / CIDR (séparés par des virgules)',
    'acc.hint': 'La boucle locale est toujours autorisée. Les règles par pays nécessitent la géolocalisation IP ; un visiteur dont le pays est indéterminé est autorisé (les règles IP sont la barrière stricte).',
    'rcp.removeConfirm': 'Supprimer le sous-lien de « {name} » ?\nSon lien cessera de fonctionner.',
    'rcp.added': 'Sous-lien(s) créé(s) ✓',
    'rcp.addFail': 'Création impossible',
    'rcp.exists': 'Ce destinataire existe déjà',
    'rcp.removed': 'Sous-lien supprimé',
    'rcp.removeFail': 'Suppression impossible',
    'auditA.recipients-added': 'Sous-liens ajoutés',
    'auditA.recipient-removed': 'Sous-lien supprimé',
    'dec.noCrypto': '⚠ Le déchiffrement nécessite un contexte sécurisé (HTTPS ou localhost) ; indisponible en HTTP simple.',
    // --- Decrypt received .dxe (added) ---
    'menu.decrypt': '🔓 Déchiffrer un fichier .dxe',
    'dec.title': 'Déchiffrer un fichier .dxe',
    'dec.intro': 'Choisissez un fichier .dxe reçu via un lien chiffré. Il est déchiffré ici, dans votre navigateur.',
    'dec.file': 'Fichier chiffré (.dxe)',
    'dec.key': 'Clé de déchiffrement ou lien complet',
    'dec.keyPh': '…#k=… ou la clé',
    'dec.passphrase': 'Phrase secrète',
    'dec.go': 'Déchiffrer',
    'dec.decrypting': 'Déchiffrement…',
    'dec.notDxe': 'Fichier .dxe invalide ou illisible.',
    'dec.needKey': 'Indiquez la clé (ou le lien contenant #k=).',
    'dec.needPass': 'Saisissez la phrase secrète.',
    'dec.badKey': 'Échec du déchiffrement : clé ou phrase secrète incorrecte, ou fichier corrompu.',
    'dec.done': 'Fichier déchiffré ✓',
    // --- End-to-end encryption (added) ---
    'enc.newShare': '🔒 Partage chiffré',
    'secret.new': '🔑 Note secrète',
    'secret.title': 'Nouvelle note secrète',
    'secret.intro': 'Partagez un mot de passe, une clé ou un court message. Chiffré de bout en bout dans votre navigateur et détruit à la première lecture.',
    'secret.text': 'Secret',
    'secret.textPh': 'ex. le mot de passe du Wi-Fi…',
    'secret.passLabel': 'Phrase secrète',
    'secret.passPh': 'à communiquer séparément',
    'secret.create': 'Créer le secret',
    'secret.created': '✓ Secret créé',
    'secret.createFail': '✗ Échec de la création du secret',
    'secret.needText': 'Saisissez le secret à partager.',
    'secret.noteKey': '⚠ La clé est dans le lien (après #). Il ne fonctionne qu’une fois : à la première ouverture, le secret est détruit.',
    'secret.notePass': '⚠ Communiquez la phrase secrète séparément. Le lien ne fonctionne qu’une fois : à la première ouverture, le secret est détruit.',
    'enc.title': 'Nouveau partage chiffré',
    'enc.file': 'Fichier à chiffrer',
    'enc.label': 'Libellé (affiché sur la page)',
    'enc.labelPh': 'ex. Contrat.pdf',
    'enc.mode': 'Mode de chiffrement',
    'enc.modeKey': 'Clé dans le lien',
    'enc.modePass': 'Phrase secrète',
    'enc.passphrase': 'Phrase secrète',
    'enc.expiry': 'Expiration',
    'enc.maxDl': 'Téléchargements max',
    'enc.create': 'Créer',
    'enc.encrypting': 'Chiffrement…',
    'enc.uploading': 'Envoi…',
    'enc.created': 'Partage chiffré créé ✓',
    'enc.createFail': 'Échec de la création du partage chiffré',
    'enc.needFile': 'Choisissez d’abord un fichier.',
    'enc.needPass': 'Saisissez une phrase secrète.',
    'enc.linkTitle': 'Lien chiffré prêt',
    'enc.copy': 'Copier le lien',
    'enc.done': 'Terminé',
    'enc.noteKey': '⚠ La clé n’est contenue que dans ce lien et ne peut pas être récupérée. Copiez-le maintenant.',
    'enc.notePass': 'Communiquez la phrase secrète au destinataire par un canal séparé.',
    'enc.inboxEncrypt': 'Chiffrer de bout en bout les fichiers reçus',
    'enc.inboxLinkNote': '⚠ Partagez ce lien complet : la clé qu’il contient ne peut pas être récupérée.',
    'app.name': 'Direct-Xfer',
    'app.docTitle': 'Direct-Xfer — Administration',
    'login.subtitle': 'Espace administrateur',
    'setup.warnTitle': '⚠ Stockage non configuré',
    'setup.inbox': 'Le dossier de réception « /Direct-Xfer » est encore à sa valeur par défaut (/PATH/TO/CONFIGURE) — non relié à un vrai dossier de l’hôte.',
    'setup.images': 'Le dossier d’images « /Images » est encore à sa valeur par défaut (/PATH/TO/CONFIGURE) — non relié à un vrai dossier de l’hôte.',
    'setup.hint': 'Configurez les volumes dans docker-compose.yml (remplacez /PATH/TO/CONFIGURE).',
    'pwa.openApp': '📱 App d’envoi mobile',
    'login.password': 'Mot de passe',
    'login.submit': 'Se connecter',
    'login.invalid': 'Identifiant ou mot de passe invalide.',
    'login.hint.env-owner': 'Le mot de passe owner est défini via ADMIN_PASSWORD : connectez-vous avec l’identifiant admin configuré (par défaut « admin ») et cette valeur exacte, sans guillemets ni espaces autour.',
    'login.hint.no-persist': 'Le dossier /data n’est pas inscriptible : les comptes et les changements de mot de passe ne survivent pas à un redémarrage. Seule la connexion owner via ADMIN_PASSWORD fonctionne.',
    'login.tooMany': 'Trop de tentatives. Réessayez dans {s}s.',
    'login.connError': 'Erreur de connexion au serveur.',
    'login.totp': 'Code 2FA',
    'login.totpHint': 'Saisissez le code à 6 chiffres de votre application (ou un code de secours).',
    'login.totpInvalid': 'Code 2FA invalide.',
    'login.username': 'Nom d’utilisateur',
    'pw.envManaged': 'Mot de passe géré par ADMIN_PASSWORD : modifiez-le via la variable d’environnement.',
    'menu.signedInAs': 'Connecté en tant que',
    'menu.accounts': '👥 Comptes admin',
    'menu.audit': '📋 Journal d’audit',
    'menu.config': '⚙ Configuration',
    'cfg.title': 'Configuration',
    'cfg.security': 'Sécurité',
    'cfg.idleEnable': 'Verrouiller après inactivité',
    'cfg.idleMins': 'Délai d’inactivité (minutes)',
    'cfg.idleHint': 'Verrouille l’interface d’administration (reconnexion requise) après cette durée sans activité souris ou clavier.',
    'cfg.locked': '🔒 Session verrouillée pour inactivité. Reconnectez-vous.',
    'cfg.saved': 'Configuration enregistrée ✓',
    'cfg.savedTemp': 'Configuration appliquée, mais non enregistrée sur le disque (dossier data non inscriptible).',
    'cfg.saveFail': 'Enregistrement impossible.',
    'cfg.notif': 'Notifications (webhook)',
    'cfg.webhookEnv': 'Géré par la variable d’environnement WEBHOOK_URL.',
    'cfg.webhookUrl': 'URL du webhook',
    'cfg.webhookFormat': 'Format',
    'cfg.webhookAuto': 'Détection auto',
    'cfg.notifyDownloads': 'Téléchargements',
    'cfg.notifyUploads': 'Réceptions',
    'cfg.notifyMessages': 'Messages',
    'cfg.webhookTest': 'Tester',
    'cfg.webpush': 'Notifications navigateur (Web Push)',
    'cfg.webpushHint': 'Recevez des notifications push dans ce navigateur pour les événements cochés ci-dessus — même quand la page d’administration est fermée. Chaque navigateur/appareil s’abonne séparément.',
    'cfg.webpushUnavail': 'Web Push indisponible : le module web-push n’est pas installé sur le serveur.',
    'cfg.webpushInsecure': 'Nécessite un contexte sécurisé (HTTPS, ou localhost). Activez TLS pour utiliser les notifications push.',
    'cfg.webpushNoSupport': 'Ce navigateur ne prend pas en charge Web Push.',
    'cfg.webpushEnable': 'Activer sur ce navigateur',
    'cfg.webpushDisable': 'Désactiver sur ce navigateur',
    'cfg.webpushTest': 'Envoyer un test',
    'cfg.webpushOn': 'Activé sur ce navigateur ✓',
    'cfg.webpushDenied': 'Notifications refusées par le navigateur.',
    'cfg.webpushSubscribed': 'Notifications activées ✓',
    'cfg.webpushUnsubscribed': 'Notifications désactivées',
    'cfg.webpushTestSent': 'Test envoyé ✓',
    'cfg.webpushNoSub': 'Aucun navigateur abonné.',
    'cfg.webpushFail': 'Échec de l’opération Web Push.',
    'cfg.webhookTesting': 'Test en cours…',
    'cfg.webhookOk': '✓ Appel réussi',
    'cfg.webhookFail': '✗ Échec de l’appel',
    'cfg.webhookNoUrl': 'Aucune URL de webhook.',
    'cfg.webhookInvalid': 'URL de webhook invalide (http/https).',
    'cfg.defaults': 'Valeurs par défaut des nouveaux liens',
    'cfg.privacy': 'Confidentialité',
    'cfg.geoLookup': 'Géolocaliser les IP des visiteurs',
    'cfg.geoHint': 'Désactivé = aucun appel externe ; le pays des visiteurs ne sera pas affiché.',
    'cfg.maxAttempts': 'Tentatives de connexion max',
    'cfg.lockoutMins': 'Blocage (minutes)',
    'cfg.sessionHours': 'Durée de session (heures)',
    'cfg.sessionDefault': 'défaut',
    'cfg.tokenBytes': 'Longueur des jetons de lien (octets)',
    'cfg.httpsWarn': 'Avertir si l’admin est servie en HTTP non chiffré',
    'cfg.httpsBanner': '⚠ Interface d’administration servie en HTTP non chiffré : vos identifiants circulent en clair. Utilisez HTTPS.',
    'cfg.allowPreview': 'Autoriser l’aperçu dans le navigateur',
    'cfg.reqPassword': 'Exiger un mot de passe par défaut',
    'cfg.startDelay': 'Activation différée (heures, 0 = immédiat)',
    'cfg.defaultDir': 'Dossier par défaut du sélecteur',
    'cfg.defaultDirPh': 'vide = dernier dossier utilisé',
    'cfg.defaultDirBrowse': 'Parcourir…',
    'cfg.defaultDirHint': 'Le sélecteur de fichiers « Nouveau partage » s’ouvre à cet emplacement. Laissez vide pour réutiliser le dernier dossier parcouru.',
    'pk.chooseDir': 'Choisir le dossier par défaut',
    'pk.chooseDirBtn': 'Choisir ce dossier',
    'cfg.recDefaults': 'Valeurs par défaut des liens de réception',
    'cfg.allowExt': 'Types autorisés (séparés par des virgules)',
    'cfg.blockExt': 'Types bloqués (séparés par des virgules)',
    'cfg.encrypt': 'Activer le chiffrement de bout en bout par défaut',
    'cfg.limits': 'Limites globales',
    'cfg.globalRate': 'Plafond de débit serveur (Ko/s)',
    'cfg.globalRateHint': 'Plafond appliqué à chaque téléchargement, en plus des limites par lien.',
    'cfg.schedEnable': 'Plafonner la bande passante sur une plage horaire',
    'cfg.schedRate': 'Plafond pendant la plage (Ko/s)',
    'cfg.schedStart': 'De',
    'cfg.schedEnd': 'À',
    'cfg.schedHint': 'Heure locale du serveur. La plage peut passer minuit (ex. 08:00 → 02:00). En dehors, seuls les plafonds ci-dessus s’appliquent.',
    'cfg.antiabuse': 'Protection des téléchargements publics',
    'cfg.prlEnable': 'Limiter le débit de requêtes par IP visiteur',
    'cfg.prlMax': 'Requêtes max',
    'cfg.prlWindow': 'Par fenêtre (minutes)',
    'cfg.chalEnable': 'Exiger un défi avant les gros téléchargements',
    'cfg.chalMin': 'Déclenche au-delà de (Mo)',
    'cfg.chalBits': 'Difficulté (8–24)',
    'cfg.chalHint': 'Une preuve de travail auto-hébergée, résolue dans le navigateur du visiteur (aucun tiers). Dissuade le scraping massif d’un lien qui aurait fuité ; plus la difficulté est élevée, plus l’effort par téléchargement est grand.',
    'cfg.leakEnable': 'Alerter si un lien est téléchargé depuis de nombreux pays',
    'cfg.leakCountries': 'Pays distincts',
    'cfg.leakWindow': 'En (heures)',
    'cfg.leakHint': 'Envoie une notification (via le webhook / e-mail ci-dessus) quand un même lien est téléchargé depuis au moins ce nombre de pays dans la fenêtre — signe possible d’une fuite. Nécessite la géolocalisation des IP activée.',
    'cfg.auditJson': 'Exporter le journal d’audit (JSON)',
    'cfg.auditCsv': 'Exporter le journal d’audit (CSV)',
    'cfg.auditHint': 'Le journal des actions admin (connexions, création/révocation de liens, changements de réglages, alertes).',
    'cfg.bkTitle': 'Sauvegarde complète planifiée',
    'cfg.bkIntro': 'Une sauvegarde complète regroupe tout le store (liens + réglages), le journal des transferts et les notes secrètes dans un seul fichier — chiffré avec DATA_KEY si défini. Envoyé vers un dossier, WebDAV ou S3.',
    'cfg.bkEnable': 'Lancer une sauvegarde planifiée automatiquement',
    'cfg.bkInterval': 'Fréquence',
    'cfg.bkDaily': 'Quotidienne',
    'cfg.bkWeekly': 'Hebdomadaire',
    'cfg.bkHour': 'À l’heure (0–23)',
    'cfg.bkWeekday': 'Jour de la semaine',
    'cfg.dow0': 'Dimanche', 'cfg.dow1': 'Lundi', 'cfg.dow2': 'Mardi', 'cfg.dow3': 'Mercredi', 'cfg.dow4': 'Jeudi', 'cfg.dow5': 'Vendredi', 'cfg.dow6': 'Samedi',
    'cfg.bkDest': 'Destination',
    'cfg.bkDestLocal': 'Dossier local (monté)',
    'cfg.bkDestWebdav': 'WebDAV',
    'cfg.bkDestS3': 'Compatible S3',
    'cfg.bkLocalDir': 'Chemin du dossier de sauvegarde',
    'cfg.bkLocalHint': 'Montez un dossier hôte accessible en écriture dans le conteneur (ex. /backups) pour que les sauvegardes survivent à une recréation du conteneur.',
    'cfg.bkWebdavUrl': 'URL de la collection WebDAV',
    'cfg.bkUser': 'Utilisateur',
    'cfg.bkPass': 'Mot de passe',
    'cfg.bkS3Endpoint': 'URL du endpoint',
    'cfg.bkS3Bucket': 'Bucket',
    'cfg.bkS3Region': 'Région',
    'cfg.bkS3Prefix': 'Préfixe de clé',
    'cfg.bkS3Key': 'Access key ID',
    'cfg.bkS3Secret': 'Secret access key',
    'cfg.bkRetention': 'Garder les N dernières sauvegardes (0 = toutes — local uniquement)',
    'cfg.bkEncWarn': '⚠ DATA_KEY n’est pas défini : les sauvegardes sont stockées EN CLAIR (elles contiennent des empreintes de mots de passe et les notes secrètes). Définissez DATA_KEY pour les chiffrer.',
    'cfg.bkNow': 'Sauvegarder maintenant',
    'cfg.bkTest': 'Tester la destination',
    'cfg.bkDownload': 'Télécharger une sauvegarde',
    'cfg.bkRestore': 'Restaurer depuis un fichier…',
    'cfg.bkSaveHint': 'Enregistrez vos réglages avant « Sauvegarder maintenant » / « Tester ». La restauration remplace tout et est irréversible.',
    'cfg.bkNever': 'Aucune sauvegarde effectuée pour l’instant.',
    'cfg.bkLastOk': 'Dernière sauvegarde : {when} → {dest} ✓',
    'cfg.bkLastFail': 'Dernière sauvegarde échouée : {when} — {err}',
    'cfg.bkRunning': 'Sauvegarde en cours…',
    'cfg.bkDone': 'Sauvegarde effectuée ✓',
    'cfg.bkFail': 'Échec de la sauvegarde',
    'cfg.bkTesting': 'Test en cours…',
    'cfg.bkTestOk': 'Destination accessible ✓',
    'cfg.bkTestFail': 'Test échoué',
    'cfg.bkRestoreConfirm': 'Restaurer une sauvegarde REMPLACE tous les liens, réglages, le journal et les notes secrètes actuels. Cette action est irréversible. Continuer ?',
    'cfg.bkRestoring': 'Restauration en cours…',
    'cfg.bkRestoreOk': 'Restauré ({n} lien(s)). Rechargement…',
    'cfg.bkRestoreFail': 'Échec de la restauration',
    'cfg.logo': 'Logo personnalisé',
    'cfg.logoPick': 'Choisir une image…',
    'cfg.logoClear': 'Retirer',
    'cfg.logoHint': 'Affiché dans la barre du haut des pages publiques. PNG/JPG/GIF/WebP/SVG, jusqu’à ~200 Ko.',
    'cfg.logoTooLarge': 'Image invalide ou trop lourde (max ~200 Ko).',
    'cfg.legal': 'Mention de confidentialité',
    'cfg.legalPh': 'ex. Confidentiel — ne pas rediffuser',
    'cfg.legalHint': 'Affichée en bannière sur chaque page publique de téléchargement / réception.',
    'cfg.watermark': 'Filigraner les aperçus image et vidéo',
    'cfg.watermarkHint': 'Incruste l’IP du visiteur (ou le nom du destinataire pour les liens nominatifs) sur les aperçus — dissuade la rediffusion de captures.',
    'cfg.retention': 'Rétention de l’historique (jours, 0 = tout garder)',
    'cfg.logRetention': 'Rétention du journal de transferts (jours, 0 = tout garder)',
    'cfg.inboxRetention': 'Supprimer les fichiers reçus après (jours, 0 = jamais)',
    'cfg.inboxRetentionHint': '⚠ Destructif : supprime DÉFINITIVEMENT les fichiers de réception et de collaboration plus anciens que ce délai — les fichiers perdus sont irrécupérables. Désactivé par défaut (0).',
    'cfg.inboxRetentionConfirm': '⚠ Les fichiers reçus de plus de {n} jour(s) seront supprimés DÉFINITIVEMENT et automatiquement, sans possibilité de récupération. Confirmer ?',
    'cfg.require2fa': 'Exiger la double authentification pour tous les admins',
    'cfg.adminAllowlist': 'Liste blanche d’IP admin (IP/CIDR, séparés par des virgules)',
    'cfg.allowlistEnv': 'Géré par la variable d’environnement ADMIN_ALLOWED_IPS.',
    'cfg.allowlistHint': 'Vide = comportement par défaut (réseau local). Le loopback est toujours autorisé. Une mauvaise entrée peut vous verrouiller dehors.',
    'cfg.allowlistConfirm': 'Restreindre l’accès admin à ces IP ? Une erreur peut vous empêcher d’accéder à l’administration (seul le loopback restera autorisé).',
    'cfg.qrDefault': 'Afficher le QR code juste après la création d’un lien',
    'cfg.maxUpload': 'Taille max / fichier reçu (Mo)',
    'cfg.maxZip': 'Taille max d’un .zip de dossier (Mo)',
    'cfg.maintenance': 'Maintenance',
    'cfg.updateCheck': 'Vérifier les mises à jour au démarrage',
    'cfg.updateCheckHint': 'Compare la version en cours au dernier tag publié de l’image. Rien n’est transmis au-delà de la requête de version.',
    'cfg.tfaRequired': 'La double authentification est requise — veuillez la configurer maintenant.',
    'cfg.anonIps': 'Anonymiser les IP des visiteurs (masquer la fin)',
    'cfg.keepNames': 'Conserver les surnoms de clients',
    'cfg.clearNames': 'Effacer tous les surnoms',
    'cfg.cleared': '{n} surnom(s) effacé(s)',
    'cfg.interface': 'Interface',
    'cfg.brandName': 'Nom de l’application',
    'cfg.brandPh': 'Direct-Xfer',
    'cfg.accentOn': 'Couleur d’accent personnalisée',
    'cfg.publicTheme': 'Thème des pages publiques',
    'cfg.themeAuto': 'Auto (selon l’appareil)',
    'cfg.themeDark': 'Sombre',
    'cfg.themeLight': 'Clair',
    'cfg.themeColor': 'Couleur du navigateur mobile',
    'cfg.themeColorHint': 'Teinte la barre du navigateur mobile sur les pages publiques (meta theme-color).',
    'cfg.adminLang': 'Langue de l’admin',
    'cfg.publicLang': 'Langue des pages publiques',
    'cfg.langAuto': 'Navigateur',
    'cfg.banner': 'Bannière de réception par défaut',
    'cfg.bannerPh': 'Affichée aux visiteurs sur chaque nouveau lien de réception',
    'cfg.backup': 'Sauvegarde et restauration',
    'cfg.export': 'Exporter la configuration',
    'cfg.import': 'Importer la configuration',
    'cfg.imported': '✓ {n} réglage(s) importé(s)',
    'cfg.importFail': '✗ Fichier invalide',
    'cfg.notifyExpiring': 'Alerter avant l’expiration d’un lien',
    'cfg.expiryWarnHours': 'Délai d’alerte (heures avant expiration)',
    'cfg.digestEnable': 'Envoyer un résumé d’activité périodique',
    'cfg.notifySecurity': 'Alerter sur les événements de sécurité (connexion, verrouillage, changement de réglages…)',
    'cfg.digestDays': 'Intervalle du résumé (jours)',
    'cfg.digestNow': 'Envoyer le résumé maintenant',
    'cfg.digestHint': 'Ces deux alertes utilisent le webhook ci-dessus. Enregistrez avant de tester.',
    'cfg.digestSent': '✓ Résumé envoyé',
    'cfg.noChannel': '✗ Aucun canal configuré (webhook ou e-mail)',
    'cfg.burnDefault': 'Liens à usage unique par défaut (révoqués après le 1er téléchargement)',
    'cfg.email': 'Notifications par e-mail (SMTP)',
    'cfg.emailEnv': 'Géré par la variable d’environnement SMTP_URL.',
    'cfg.emailUnavail': 'Le module nodemailer est indisponible ; l’e-mail est désactivé.',
    'cfg.emailEnable': 'Envoyer aussi les notifications par e-mail',
    'cfg.smtpHost': 'Serveur SMTP',
    'cfg.smtpPort': 'Port',
    'cfg.smtpSecure': 'TLS implicite (port 465)',
    'cfg.smtpUser': 'Utilisateur',
    'cfg.smtpPass': 'Mot de passe',
    'cfg.smtpFrom': 'Adresse d’expéditeur',
    'cfg.smtpTo': 'Destinataire(s)',
    'cfg.emailTest': 'Envoyer un e-mail de test',
    'cfg.emailTesting': 'Envoi…',
    'cfg.emailOk': '✓ E-mail envoyé',
    'cfg.emailFail': '✗ Échec de l’envoi',
    'cfg.emailNotConfigured': '✗ SMTP non configuré',
    'ed.title': 'Modifier le lien',
    'ed.editing': 'Modification :',
    'ed.rename': 'Nom',
    'ed.keep': 'Ne pas changer',
    'ed.password': 'Mot de passe',
    'ed.pwPh': 'laisser vide pour conserver',
    'ed.pwSet': '•••••• (défini — saisir pour remplacer)',
    'ed.clearPw': 'Retirer le mot de passe',
    'ed.saved': '✓ Lien mis à jour',
    'ed.saveFail': '✗ Échec : {error}',
    'sh.edit': 'Modifier',
    'sh.oneTime': 'Usage unique',
    'sh.burned': 'Brûlé',
    'rcp.viewed': 'Vu',
    'rcp.notSeen': 'Non vu',
    'rcp.downloaded': 'Téléchargé',
    'cfg.sharesExport': 'Exporter les partages',
    'cfg.sharesImport': 'Importer des partages',
    'cfg.sharesBackupHint': 'Exporte les réglages de chaque lien (chemins, quotas, expirations, mots de passe) — pas les fichiers. Pratique pour migrer les liens vers un autre serveur.',
    'cfg.sharesImportConfirm': 'Importer ces partages ? Ils s’ajouteront aux liens existants.',
    'cfg.sharesImported': '✓ {n} partage(s) importé(s), {s} ignoré(s)',
    'cfg.encOn': '🔒 Chiffrement au repos des métadonnées : activé (DATA_KEY).',
    'cfg.encOff': 'Chiffrement au repos des métadonnées : désactivé. Définissez la variable DATA_KEY pour l’activer.',
    'cfg.pwRequired': 'Un mot de passe est requis pour ce lien.',
    'acc.title': 'Comptes admin',
    'acc.addTitle': 'Ajouter un compte admin',
    'acc.username': 'Nom d’utilisateur',
    'acc.usernamePh': 'ex. alex',
    'acc.password': 'Mot de passe initial',
    'acc.passwordPh': '8 caractères min.',
    'acc.create': 'Créer le compte',
    'acc.owner': 'propriétaire',
    'acc.admin': 'admin',
    'acc.role': 'Rôle',
    'acc.role.owner': 'propriétaire',
    'acc.role.admin': 'admin',
    'acc.role.operator': 'opérateur',
    'acc.role.auditor': 'auditeur',
    'acc.roleAdmin': 'Admin (accès complet)',
    'acc.roleOperator': 'Opérateur (ses propres liens)',
    'acc.roleAuditor': 'Auditeur (lecture seule)',
    'acc.roleHint': 'Les admins gèrent tout. Les opérateurs créent et gèrent uniquement leurs propres liens. Les auditeurs consultent sans rien modifier.',
    'acc.tfOn': '🛡 2FA',
    'acc.you': 'vous',
    'acc.lastLogin': 'dernière connexion {v}',
    'acc.createdBy': 'créé par {v}',
    'acc.envManaged': 'géré par ADMIN_PASSWORD',
    'acc.rename': 'Renommer',
    'acc.renamePrompt': 'Nouveau nom d’utilisateur pour « {u} » (3–40 car. : a–z, 0–9, . _ -).',
    'acc.renamed': 'Compte renommé',
    'acc.reset': 'Réinitialiser le mot de passe',
    'acc.delete': 'Supprimer',
    'acc.confirmDelete': 'Supprimer le compte « {u} » ? Ses sessions seront déconnectées.',
    'acc.deleted': 'Compte supprimé',
    'acc.resetPrompt': 'Nouveau mot de passe pour « {u} » (8 car. min.). L’utilisateur devra le changer à la prochaine connexion.',
    'acc.resetDone': 'Mot de passe réinitialisé',
    'acc.created': 'Compte créé',
    'acc.taken': 'Ce nom d’utilisateur est déjà pris.',
    'acc.badUsername': 'Nom invalide (3–40 car. : a–z, 0–9, . _ -).',
    'acc.pwShort': 'Le mot de passe doit faire au moins 8 caractères.',
    'acc.actionFail': 'Opération impossible.',
    'acc.loadFail': 'Chargement des comptes impossible.',
    'audit.title': 'Journal d’audit',
    'audit.subtitle': 'Actions admin récentes (les plus récentes en premier).',
    'audit.none': 'Aucune entrée pour l’instant.',
    'audit.loadFail': 'Chargement du journal impossible.',
    'auditA.login': 'Connexion',
    'auditA.login-fail': 'Échec de connexion',
    'auditA.login-2fa-fail': 'Échec 2FA',
    'auditA.logout': 'Déconnexion',
    'auditA.password-changed': 'Mot de passe changé',
    'auditA.password-reset': 'Mot de passe réinitialisé',
    'auditA.2fa-enabled': '2FA activée',
    'auditA.2fa-disabled': '2FA désactivée',
    'auditA.account-created': 'Compte créé',
    'auditA.account-deleted': 'Compte supprimé',
    'auditA.account-renamed': 'Compte renommé',
    'auditA.share-created': 'Partage créé',
    'auditA.share-revoked': 'Partage révoqué',
    'auditA.inbox-created': 'Lien de réception créé',
    'auditA.enc-share-created': 'Partage chiffré créé',
    'auditA.settings-changed': 'Réglages modifiés',
    'auditA.push-subscribed': 'Notifications push activées',
    'auditA.push-unsubscribed': 'Notifications push désactivées',
    'auditA.server-shutdown': 'Extinction serveur',
    'menu.language': 'Langue',
    'menu.theme': 'Thème',
    'theme.dark': 'Sombre',
    'theme.light': 'Clair',
    'theme.auto': 'Auto',
    'menu.changePassword': '🔑 Changer le mot de passe',
    'menu.twoFactor': '🛡 Double authentification (2FA)',
    'menu.logout': '⇦ Déconnexion',
    'tfa.title': 'Double authentification (2FA)',
    'tfa.statusOn': '✅ La 2FA est activée.',
    'tfa.statusOff': 'La 2FA est désactivée.',
    'tfa.enable': 'Activer la 2FA',
    'tfa.disable': 'Désactiver la 2FA',
    'tfa.step1': 'Scannez ce QR code avec votre application (Google Authenticator, Authy…), ou saisissez la clé manuellement.',
    'tfa.secretLabel': 'Clé manuelle :',
    'tfa.codeLabel': 'Code de vérification',
    'tfa.codePh': 'Code à 6 chiffres',
    'tfa.verify': 'Vérifier et activer',
    'tfa.recoveryTitle': 'Codes de secours',
    'tfa.recoveryHint': 'Conservez ces 8 codes en lieu sûr. Chacun est utilisable une seule fois si vous perdez l’accès à votre application.',
    'tfa.recoveryDone': 'J’ai noté mes codes',
    'tfa.enabled': '2FA activée ✓',
    'tfa.disabled': '2FA désactivée',
    'tfa.wrongCode': 'Code incorrect.',
    'tfa.disablePwLabel': 'Confirmez avec votre mot de passe actuel pour désactiver la 2FA.',
    'tfa.pwPh': 'Mot de passe actuel',
    'tfa.wrongPw': 'Mot de passe incorrect.',
    'tfa.genFail': 'L’opération a échoué.',
    'dash.title': 'Tableau de bord',
    'dashboards.title': 'Tableaux de bord',
    'dashboards.transfers': 'Transferts',
    'dashboards.images': 'Images',
    'dashboards.back': 'Retour',
    'dash.exportCsv': '⬇ Export CSV',
    'dash.filterDirection': 'Direction',
    'dash.filterStatus': 'Statut',
    'dash.filterType': 'Type de lien',
    'dash.filterAllDirections': 'Toutes les directions',
    'dash.filterAllStatuses': 'Tous les statuts',
    'dash.filterAllTypes': 'Tous les types',
    'dash.filterSearchPh': 'Fichier, lien, client, IP…',
    'dash.filterReset': 'Effacer les filtres',
    'dash.filteredN': '{n} transfert(s) dans la sélection',
    'dash.volumeTrend': 'Volume transféré dans le temps',
    'dash.successTrend': 'Taux de réussite dans le temps',
    'dash.stalledTransfers': 'Transferts potentiellement bloqués',
    'dash.stalledBadge': 'BLOQUÉ',
    'dash.noStalled': 'Aucun transfert bloqué détecté',
    'dash.noStalledHelp': 'Un transfert est signalé après une période sans progression.',
    'dash.stalledFor': 'Sans progression depuis {v}',
    'dash.stopStalled': 'Arrêter',
    'dash.storageCleanup': 'Fichiers temporaires et partiels',
    'dash.storageTypes': 'Stockage par type de fichier',
    'dash.storageLargest': 'Plus gros fichiers reçus',
    'dash.managedStorage': 'Stockage géré par Direct-Xfer',
    'dash.storedFiles': 'Fichiers stockés',
    'dash.partialFilesN': '{n} fichier(s) partiel(s)',
    'dash.stalePartialN': '{n} partiel(s) de plus de 24 h',
    'dash.scanTruncated': 'Analyse limitée aux {n} premières entrées.',
    'dash.filesN': '{n} fichier(s)',
    'idash.filterStatus': 'Statut des images',
    'idash.filterFormat': 'Format',
    'idash.filterAllStatuses': 'Tous les statuts',
    'idash.filterAllFormats': 'Tous les formats',
    'idash.filterSearchPh': 'Nom de l’image ou jeton…',
    'idash.filteredN': '{n} image(s) dans la sélection',
    'idash.storageGrowth': 'Croissance du stockage Images géré',
    'idash.storageFormats': 'Stockage par format',
    'idash.storageLargest': 'Images les plus volumineuses',
    'idash.reclaimable': 'Stockage potentiellement récupérable',
    'idash.storageActive': 'Images actives',
    'idash.storageExpired': 'Images expirées',
    'idash.storageInactive': 'Images inactives',
    'idash.storageReclaimable': 'Récupérable en supprimant les inactives',
    'dash.secRealtime': "Temps réel & dernières 24 heures",
    'dash.activeTransfers': "Transferts actifs",
    'dash.liveUpdated': "Temps réel · {v}",
    'dash.noActive': "Aucun transfert actif.",
    'dash.last24h': "Résumé des dernières 24 heures",
    'dash.recentErrors': "Derniers échecs de transfert",
    'dash.noErrors': "Aucun échec récent.",
    'dash.proxy': "État du reverse proxy",
    'dash.proxyOk': "Configuration correcte",
    'dash.proxyWarn': "Configuration à vérifier",
    'dash.proxyBad': "Configuration incorrecte",
    'dash.proxyDirect': "Accès direct, sans reverse proxy",
    'dash.proxyDetected': "Proxy détecté : {v}",
    'dash.proxyTrust': "TRUST_PROXY : {v}",
    'dash.on': "activé",
    'dash.off': "désactivé",
    'dash.h24Transfers': "Transferts / 24 h",
    'dash.h24Volume': "Volume / 24 h",
    'dash.h24Success': "Réussite / 24 h",
    'dash.h24Speed': "Vitesse moyenne / 24 h",
    'dash.h24Down': "Téléchargements / 24 h",
    'dash.h24Up': "Réceptions / 24 h",
    'dash.failure.interrupted': "Interruption inconnue",
    'dash.failure.aborted': "Connexion interrompue",
    'dash.failure.stopped': "Arrêté manuellement",
    'dash.failure.timeout': "Délai dépassé",
    'dash.failure.read-error': "Erreur de lecture",
    'dash.failure.zip-error': "Erreur de création ZIP",
    'dash.failure.zip-too-large': "Archive ZIP trop volumineuse",
    'dash.failure.write-error': "Erreur d’écriture",
    'dash.failure.infected': "Fichier infecté",
    'dash.failure.too-large': "Fichier trop volumineux",
    'dash.failure.file-too-large': "Limite de taille du lien dépassée",
    'dash.failure.quota-full': "Quota du lien atteint",
    'dash.failure.inbox-dir': "Dossier de réception inaccessible",
    'dash.failure.connection-closed': "Connexion fermée avant la fin",
    'idash.secLinks': "Liens Images & disponibilité",
    'idash.linkStatus': "État des liens Images",
    'idash.activeLinks': "Liens Images actifs",
    'idash.expiredLinks': "Liens Images expirés",
    'idash.noActiveLinks': "Aucun lien Image actif.",
    'idash.noExpiredLinks': "Aucun lien Image expiré.",
    'idash.expired': "Expirés",
    'idash.inactive': "Autres inactifs",
    'idash.proxy': "Reverse proxy Images",
    'idash.kpiActive': "Actives",
    'idash.kpiExpired': "Expirées",
    'idash.open': "Ouvrir",
    'idash.neverExpires': "Sans expiration",
    'dash.refresh': '↻ Actualiser',
    'dash.updated': 'Mis à jour {v}',
    'idash.toggle': '📊 Tableau de bord',
    'idash.title': 'Tableau de bord des images',
    'idash.added': 'Images ajoutées dans le temps',
    'idash.variantViews': 'Vues par taille',
    'idash.activeRevoked': 'Actives vs révoquées',
    'idash.topViews': 'Top images (par vues)',
    'idash.topVisitors': 'Top images (par visiteurs)',
    'idash.secStorage': 'Stockage & cycle de vie',
    'idash.storageSplit': 'Stockage par taille',
    'idash.diskSpace': 'Espace disque des images',
    'idash.expiring': 'Expirent bientôt (7 jours)',
    'idash.revoked': 'Révoquées récemment',
    'idash.kpiImages': 'Images',
    'idash.kpiViews': 'Vues',
    'idash.kpiVisitors': 'Visiteurs uniques',
    'idash.kpiStorage': 'Stockage images',
    'idash.kpiAdded': 'Ajoutées (période)',
    'idash.kpiRevoked': 'Révoquées',
    'idash.kpiMini': 'Mini générées',
    'idash.kpiMicro': 'Micro générées',
    'idash.active': 'Actives',
    'idash.revokedLbl': 'Révoquées',
    'idash.viewsN': '{n} vues',
    'idash.visitorsN': '{n} visiteurs',
    'idash.addedN': '{n} ajoutée(s)',
    'dash.kpiTransfers': 'Transferts',
    'dash.kpiVolume': 'Volume total',
    'dash.kpiSuccess': 'Taux de réussite',
    'dash.kpiDown': 'Téléchargements',
    'dash.kpiUp': 'Réceptions',
    'dash.kpiVisitors': 'Visiteurs uniques',
    'dash.kpiShares': 'Liens actifs',
    'dash.activity': 'Activité',
    'dash.periodAll': 'Tout',
    'p3.insights': 'Analyses et alertes automatiques',
    'p3.alerts': 'Alertes automatiques',
    'p3.comparison': 'Comparaison avec la période précédente',
    'p3.users': 'Statistiques par utilisateur',
    'p3.duplicates': 'Détection des doublons',
    'p3.optimization': 'Optimisation WebP / AVIF',
    'p3.noAlerts': 'Aucune anomalie détectée',
    'p3.noAlertsHelp': 'Les seuils sont vérifiés automatiquement à chaque actualisation.',
    'p3.noComparison': 'La comparaison n’est pas disponible pour la période « Tout ».',
    'p3.currentPeriod': 'Période actuelle',
    'p3.previousPeriod': 'Période précédente',
    'p3.transfers': 'Transferts',
    'p3.volume': 'Volume',
    'p3.success': 'Réussite',
    'p3.speed': 'Débit moyen',
    'p3.imagesAdded': 'Images ajoutées',
    'p3.storageAdded': 'Stockage ajouté',
    'p3.averageSize': 'Taille moyenne',
    'p3.newValue': 'nouveau',
    'p3.userShares': '{n} partage(s)',
    'p3.userTransfers': '{n} transfert(s)',
    'p3.userImages': '{n} image(s)',
    'p3.userSuccess': '{n}% de réussite',
    'p3.userViews': '{n} vue(s)',
    'p3.noUsers': 'Aucune donnée par utilisateur pour cette période.',
    'p3.noDuplicates': 'Aucun doublon exact détecté',
    'p3.noDuplicatesHelp': 'Les images de même taille sont comparées par empreinte SHA-256.',
    'p3.duplicateSummary': '{n} doublon(s) dans {groups} groupe(s) · {space} récupérables',
    'p3.duplicateGroup': '{n} copies · {size} chacune · {space} récupérables',
    'p3.scanLimited': 'Analyse limitée à {n} images pour protéger les performances.',
    'p3.estimated': 'Estimation',
    'p3.eligible': '{n} image(s) admissible(s)',
    'p3.potentialSaving': 'Économie potentielle : {space}',
    'p3.optimizationNote': 'Estimation non destructive basée sur le format actuel. Aucun fichier n’est converti automatiquement.',
    'p3.noOptimization': 'Aucune image volumineuse admissible à cette conversion.',
    'p3.candidateSaving': '{format} · {size} → économie estimée {space}',
    'p3.alert.title.disk-critical': 'Espace de réception presque épuisé',
    'p3.alert.detail.disk-critical': '{pct}% utilisés; seulement {free} disponibles.',
    'p3.alert.title.disk-warning': 'Espace de réception à surveiller',
    'p3.alert.detail.disk-warning': '{pct}% utilisés; {free} disponibles.',
    'p3.alert.title.failure-rate': 'Taux d’échec élevé',
    'p3.alert.detail.failure-rate': '{pct}% d’échecs ({n} transferts interrompus).',
    'p3.alert.title.failure-increase': 'Hausse des échecs',
    'p3.alert.detail.failure-increase': '{current} échecs contre {previous} pendant la période précédente.',
    'p3.alert.title.stale-parts': 'Fichiers partiels anciens',
    'p3.alert.detail.stale-parts': '{n} fichier(s) partiel(s) de plus de 24 h occupent {space}.',
    'p3.alert.title.locked-ips': 'Adresses IP verrouillées',
    'p3.alert.detail.locked-ips': '{n} adresse(s) sont actuellement bloquées après des échecs de connexion.',
    'p3.alert.title.webhook-failed': 'Échec du dernier webhook',
    'p3.alert.detail.webhook-failed': 'La dernière notification webhook n’a pas été livrée.',
    'p3.alert.title.email-failed': 'Échec du dernier courriel',
    'p3.alert.detail.email-failed': 'La dernière notification par courriel n’a pas été livrée.',
    'p3.alert.title.stalled': 'Transferts bloqués détectés',
    'p3.alert.detail.stalled': '{n} transfert(s) ne progressent plus depuis au moins {v}.',
    'p3.alert.title.proxy-bad': 'Configuration du reverse proxy incorrecte',
    'p3.alert.detail.proxy-bad': 'Le diagnostic du proxy signale une erreur qui peut perturber les liens ou les gros transferts.',
    'p3.alert.title.proxy-warn': 'Reverse proxy à vérifier',
    'p3.alert.detail.proxy-warn': 'Le diagnostic du proxy contient au moins un avertissement.',
    'p3.alert.title.image-disk-critical': 'Espace Images presque épuisé',
    'p3.alert.detail.image-disk-critical': '{pct}% utilisés; seulement {free} disponibles.',
    'p3.alert.title.image-disk-warning': 'Espace Images à surveiller',
    'p3.alert.detail.image-disk-warning': '{pct}% utilisés; {free} disponibles.',
    'p3.alert.title.duplicates': 'Doublons d’images détectés',
    'p3.alert.detail.duplicates': '{n} copie(s) dans {groups} groupe(s) pourraient libérer {space}.',
    'p3.alert.title.optimization': 'Optimisation d’images possible',
    'p3.alert.detail.optimization': 'Une conversion WebP ou AVIF pourrait économiser environ {space}.',
    'p3.alert.title.image-reclaimable': 'Images inactives récupérables',
    'p3.alert.detail.image-reclaimable': 'Les images expirées ou inactives occupent {space}.',
    'p3.alert.title.image-growth': 'Croissance inhabituelle du stockage Images',
    'p3.alert.detail.image-growth': 'Le stockage ajouté a augmenté de {pct}% par rapport à la période précédente.',
    'dash.kpiSpeed': 'Vitesse moyenne',
    'dash.kpiDuration': 'Durée moyenne',
    'dash.secPerf': 'Vitesse & performance',
    'dash.secLinks': 'Liens & partages',
    'dash.secSecurity': 'Sécurité',
    'dash.secOps': 'Stockage & notifications',
    'dash.heatmap': 'Usage par jour / heure',
    'dash.sizeDist': 'Distribution des tailles',
    'dash.sizeSmall': 'Petits (< 10 Mo)',
    'dash.sizeMedium': 'Moyens (10 Mo–1 Go)',
    'dash.sizeLarge': 'Gros (≥ 1 Go)',
    'dash.topFiles': 'Fichiers les plus téléchargés',
    'dash.dlN': '{n} téléch.',
    'dash.protection': 'Protégés vs libres',
    'dash.protected': 'Protégés',
    'dash.open': 'Libres',
    'dash.encryption': 'Chiffrés vs en clair',
    'dash.encrypted': 'Chiffrés (E2E)',
    'dash.plain': 'En clair',
    'dash.expiring': 'Expirent bientôt (7 j)',
    'dash.expNone': 'Rien à signaler.',
    'dash.twofa': 'Adoption de la 2FA',
    'dash.twofaOn': 'Avec 2FA',
    'dash.twofaOff': 'Sans 2FA',
    'dash.adminSec': 'Sécurité des connexions admin',
    'dash.failedLogins': 'Connexions échouées',
    'dash.lockedIps': 'IP verrouillées',
    'dash.lockedNow': 'Verrouillées actuellement',
    'dash.lockAdmin': 'admin',
    'dash.lockLink': 'lien',
    'dash.recentLogins': 'Connexions admin récentes',
    'dash.storage': 'Espace disque (réception)',
    'dash.storUsed': '{v} utilisés',
    'dash.storFree': '{v} libres',
    'dash.storTotal': 'Total : {v}',
    'dash.storageNA': 'Espace disque indisponible.',
    'dash.webhook': 'État du webhook',
    'dash.whNone': 'Aucun webhook configuré.',
    'dash.whIdle': 'Configuré — aucun appel encore.',
    'dash.whOk': 'Dernier appel réussi',
    'dash.whFail': 'Dernier appel en échec',
    'dash.downloads': 'Téléchargements',
    'dash.uploads': 'Réceptions',
    'dash.direction': 'Téléchargements vs réceptions',
    'dash.status': 'Réussis vs interrompus',
    'dash.completed': 'Réussis',
    'dash.interrupted': 'Interrompus',
    'dash.topLinks': 'Liens les plus utilisés (volume)',
    'dash.topCountries': 'Principaux pays',
    'dash.topDownloaders': 'Top 5 clients (téléchargements)',
    'dash.topUploaders': 'Top 5 clients (envois)',
    'dash.empty': 'Aucune donnée pour l’instant.',
    'dash.dl': 'téléch.',
    'dash.ul': 'récept.',
    'dash.transfersN': '{n} transferts',
    'update.available': '⬆ Nouvelle version disponible : {v}',
    'menu.shutdown': '⏻ Éteindre le serveur',
    'menu.shutdownConfirm':
      "Éteindre le serveur maintenant ? L'interface deviendra inaccessible jusqu'au redémarrage du conteneur.",
    'menu.shutdownDone': 'Extinction du serveur…',
    'menu.shutdownFail': 'Extinction impossible',
    'net.title': 'Réseau',
    'net.testBtn': "Tester l'accès extérieur",
    'net.localIp': 'IP locale',
    'net.publicIp': 'IP publique',
    'net.linkBase': 'Base des liens',
    'net.extAccess': 'Accès extérieur',
    'net.notTested': 'Non testé',
    'net.testing': 'Test en cours…',
    'net.accessible': 'Accessible ✓',
    'net.unreachable': 'Inaccessible ✗',
    'net.undetermined': 'Indéterminé',
    'net.error': 'Erreur',
    'net.notDetected': 'non détectée',
    'net.domainLabel': 'Domaine des liens',
    'net.domainPlaceholder': 'ex : partage.exemple.tld',
    'net.sslTitle': "Cochez si un reverse-proxy (Nginx) sert l'application en HTTPS",
    'net.save': 'Enregistrer',
    'net.reset': 'Réinitialiser',
    'net.auto': 'Auto',
    'net.autoTitle': 'Revenir à la détection automatique',
    'net.domainHelp':
      'Utilisé pour construire les liens de partage. Laissez vide pour la détection automatique.',
    'net.hintAccessible': '{label} est accessible depuis Internet ({open}/{total} nœuds).',
    'net.hintUnreachable':
      "{label} n'est pas joignable. Vérifiez la redirection de port (NAT), le reverse-proxy et le pare-feu du système.",
    'net.hintUndetermined': 'Test impossible ({error}). Réessayez plus tard.',
    'net.proxyHint': "Reverse-proxy détecté : le test d'accès cible {label}.",
    'net.domainSaved': 'Domaine enregistré ✓',
    'net.autoRestored': 'Détection automatique rétablie',
    'net.domainInvalid': 'Domaine invalide',
    'net.saveError': 'Enregistrement impossible',
    'net.saveNoPersist':
      'Domaine appliqué, mais non enregistré sur le disque (dossier data non inscriptible — vérifiez le montage).',
    'net.unavailable': 'Réseau indisponible',
    'net.theDomain': 'le domaine',
    'net.theTarget': 'la cible',
    'proxy.testBtn': 'Tester le reverse proxy',
    'proxy.testing': 'Analyse de la requête en cours…',
    'proxy.error': 'Diagnostic impossible.',
    'proxy.verdict.ok': 'Configuration du reverse proxy correcte',
    'proxy.verdict.warn': 'Reverse proxy : points à vérifier',
    'proxy.verdict.bad': 'Reverse proxy mal configuré',
    'proxy.verdict.info': 'Diagnostic du reverse proxy',
    'proxy.trustProxy': 'TRUST_PROXY',
    'proxy.enabled': 'activé',
    'proxy.disabled': 'désactivé',
    'proxy.detected': 'Proxy détecté',
    'proxy.yes': 'oui',
    'proxy.no': 'non',
    'proxy.clientIp': 'IP visiteur retenue',
    'proxy.remoteAddr': 'Pair immédiat',
    'proxy.publicPeerTag': 'IP publique',
    'proxy.protocol': 'Protocole vu par l’app',
    'proxy.target': 'Domaine testé',
    'proxy.host': 'Host',
    'proxy.headers': 'En-têtes de transfert reçus',
    'proxy.noHeaders': 'Aucun en-tête X-Forwarded-* / de proxy reçu sur cette requête.',
    'proxy.msg.proxy-untrusted': 'Des en-têtes de reverse proxy sont reçus mais TRUST_PROXY est désactivé : l’application voit l’IP du proxy ({peer}), pas celle du visiteur. Activez TRUST_PROXY (ex. TRUST_PROXY="1").',
    'proxy.msg.trust-no-headers': 'TRUST_PROXY est activé mais aucun en-tête X-Forwarded-* n’a été reçu : soit il n’y a pas de reverse proxy devant, soit il ne les transmet pas. Un TRUST_PROXY activé sans proxy réel rend l’IP visiteur usurpable.',
    'proxy.msg.proxy-ok': 'Reverse proxy détecté et approuvé. IP visiteur retenue : {ip}.',
    'proxy.msg.direct': 'Aucun reverse proxy détecté : connexion directe. IP client : {ip}.',
    'proxy.msg.https-not-trusted': 'Le proxy annonce HTTPS (X-Forwarded-Proto: https) mais l’application le voit en HTTP : les cookies « Secure » ne seront pas posés. Activez TRUST_PROXY pour que le HTTPS soit reflété.',
    'proxy.msg.https-ok': 'Le HTTPS du proxy est correctement propagé (X-Forwarded-Proto pris en compte).',
    'proxy.msg.no-proto': 'Le proxy ne transmet pas d’en-tête X-Forwarded-Proto : impossible de détecter le HTTPS. Ajoutez-le (Nginx : proxy_set_header X-Forwarded-Proto $scheme;).',
    'proxy.msg.host-diff': 'Host public annoncé par le proxy : {pub} (Host interne : {internal}).',
    'proxy.msg.public-peer': 'La requête provient d’une IP publique ({ip}) alors que des en-têtes de proxy sont présents : vérifiez que seul le proxy peut joindre le conteneur et qu’il n’est pas exposé en direct.',
    'proxy.msg.multi-hop': '{n} sauts dans X-Forwarded-For : {chain}. Avec plusieurs proxies, réglez TRUST_PROXY sur le nombre de sauts de confiance.',
    'proxy.msg.buffering': 'Pour les envois volumineux (liens de réception), désactivez la mise en tampon des requêtes et relevez les limites de taille/délai — Nginx : client_max_body_size 0; proxy_request_buffering off; proxy_read_timeout élevé.',
    'shutdown.armed': 'Auto-extinction armée : arrêt après le prochain téléchargement.',
    'shutdown.disarmed': 'Auto-extinction désactivée.',
    'settings.saveError': 'Réglage impossible',
    'tr.title': 'Transferts en cours',
    'tr.none': 'Aucun transfert en cours.',
    'tr.locating': 'localisation…',
    'tr.localNetwork': 'Réseau local',
    'tr.remaining': 'restant',
    'tr.zip': 'archive .zip',
    'tr.zipTitle': 'Plusieurs fichiers regroupés et téléchargés dans une seule archive .zip',
    'sh.title': 'Partages en cours',
    'sh.new': '＋ Nouveau partage',
    'sh.newInbox': '＋ Lien de réception',
    'sh.newCollab': '🔁 Lien de collaboration',
    'sh.secret': 'Note secrète',
    'sh.clone': '⧉ Dupliquer',
    'sh.cloneTitle': 'Dupliquer ce partage avec un nouveau lien et des compteurs remis à zéro',
    'sh.cloneSuffix': '(copie)',
    'sh.clonePrompt': 'Nom du nouveau partage :',
    'sh.cloneBusy': 'Duplication…',
    'sh.cloned': 'Partage dupliqué ✓',
    'sh.clonedAs': 'Partage « {name} » dupliqué ✓',
    'sh.cloneFail': 'Duplication impossible',
    'sh.cloneUnsupported': 'Ce type de partage ne peut pas être dupliqué',
    'sh.cloneImageMissing': 'Le fichier source de cette image est introuvable',
    'sh.cloneInvalidName': 'Le nom du nouveau partage est invalide',
    'sh.email': '✉ E-mail',
    'sh.emailTitle': 'Envoyer ce lien par e-mail',
    'sh.emailPrompt': 'Adresse e-mail du destinataire pour « {name} » :',
    'sh.emailSent': 'E-mail envoyé à {to} ✓',
    'sh.emailInvalid': 'Adresse e-mail invalide',
    'sh.emailNotConfigured': 'SMTP non configuré',
    'sh.emailFail': 'Échec de l’envoi',
    'sh.fType': 'Tous les types',
    'sh.fStatus': 'Tous les statuts',
    'sh.fActive': 'Actifs',
    'sh.fInactive': 'Inactifs',
    'sh.sortNew': 'Plus récents',
    'sh.sortOld': 'Plus anciens',
    'sh.sortName': 'Nom A→Z',
    'sh.sortDl': 'Plus actifs',
    'sh.sortExpiry': 'Expire bientôt',
    'view.list': 'Affichage en liste',
    'view.grid': 'Affichage en grille',
    'keys.title': 'Raccourcis clavier',
    'keys.new': 'Nouveau partage',
    'keys.reception': 'Nouveau lien de réception',
    'keys.collab': 'Nouveau lien collaboratif',
    'keys.search': 'Cibler le filtre',
    'keys.help': 'Afficher cette aide',
    'keys.close': 'Fermer une fenêtre',
    'sh.filterPh': '🔍 Filtrer par nom ou étiquette…',
    'sh.noneFilter': 'Aucun lien ne correspond au filtre.',
    'sh.tagAdd': 'Étiquette',
    'sh.tagRemove': 'Retirer l’étiquette',
    'sh.tagPrompt': 'Nom de l’étiquette :',
    'sh.tagFail': 'Échec de la mise à jour des étiquettes',
    'sh.bulkCount': '{n} sélectionné(s)',
    'sh.bulkTag': '🏷 Étiqueter',
    'sh.bulkExtend': '⏱ Prolonger',
    'sh.bulkRevoke': 'Révoquer',
    'sh.bulkDone': '✓ {n} lien(s) modifié(s)',
    'sh.bulkFail': 'Échec de l’action groupée',
    'sh.bulkRevokeConfirm': 'Révoquer {n} lien(s) ? Leurs URL cesseront de fonctionner.',
    'sh.bulkExtendPrompt': 'Nouvelle expiration à partir de maintenant, en jours (0 = jamais) :',
    'sh.bulkTagPrompt': 'Étiquette à ajouter aux liens sélectionnés :',
    'mod.enable': 'Modérer les dépôts avant publication',
    'mod.pending': '⏳ En attente de modération ({n})',
    'mod.approve': '✓ Approuver',
    'mod.reject': '✕ Rejeter',
    'mod.approved': '✓ Fichier approuvé',
    'mod.rejected': 'Fichier rejeté',
    'mod.rejectConfirm': 'Rejeter et supprimer définitivement ce fichier ?',
    'mod.fail': 'Échec de la modération',
    'sh.inbox': 'réception',
    'sh.collab': 'collaboration',
    'sh.canDelete': 'suppression autorisée',
    'sh.activity': 'Activité :',
    'sh.deleteOn': 'Suppression autorisée',
    'sh.deleteOff': 'Suppression interdite',
    'sh.received': 'Reçus :',
    'inbox.namePrompt': 'Nom du lien de réception (facultatif) :',
    'inbox.created': 'Lien de réception créé ✓',
    'inbox.createFail': 'Création du lien impossible',
    'collab.title': 'Nouveau lien de collaboration',
    'collab.intro': 'Un dossier partagé bidirectionnel : les visiteurs peuvent télécharger et déposer. Les fichiers sont stockés dans un nouveau dossier de votre espace de réception.',
    'collab.namePh': 'ex. Espace projet',
    'collab.allowDelete': 'Autoriser les visiteurs à supprimer du contenu',
    'collab.deleteNeedsPw': '⚠ Nécessite un mot de passe : la suppression par les visiteurs reste désactivée tant que le lien n’est pas protégé.',
    'collab.notePh': 'ex. Déposez vos révisions ici ; téléchargez le dernier brief.',
    'collab.created': 'Lien de collaboration créé ✓',
    'collab.createFail': 'Création du lien impossible',
    'inbox.pwPrompt': "Mot de passe d'accès (facultatif) :",
    'inbox.title': 'Nouveau lien de réception',
    'inbox.name': 'Nom',
    'inbox.namePh': 'ex. Documents client',
    'inbox.expiry': 'Expiration',
    'inbox.password': 'Mot de passe (facultatif)',
    'inbox.maxFiles': 'Fichiers max',
    'inbox.maxFileSize': 'Taille max / fichier (Mo)',
    'inbox.maxTotalSize': 'Quota total (Mo)',
    'inbox.allowExt': 'Types autorisés (séparés par des virgules, facultatif)',
    'inbox.blockExt': 'Types bloqués (facultatif)',
    'inbox.extPh': 'ex. pdf, jpg, png',
    'inbox.note': 'Message affiché aux expéditeurs (facultatif)',
    'inbox.groupSender': 'Ranger les envois dans des sous-dossiers par expéditeur',
    'inbox.notePh': 'ex. Merci d’envoyer le contrat signé en PDF.',
    'inbox.create': 'Créer le lien',
    'sh.noteLabel': 'Consigne :',
    'sh.msgsLabel': 'Messages reçus ({n}) :',
    'sh.msgsMore': '+ {n} autre(s)',
    'sh.msgsClear': '🗑 Vider la liste',
    'sh.msgsClearConfirm': 'Vider la liste des messages de « {name} » ?\nLes fichiers déjà reçus sur le disque ne sont pas supprimés.',
    'sh.msgsCleared': 'Liste vidée ✓',
    'sh.msgsClearFail': 'Impossible de vider la liste',
    'hi.exportCsv': '⬇ CSV',
    'hi.exportJson': '⬇ JSON',
    'hi.exportEmpty': 'Aucun transfert à exporter.',
    'hi.exportFail': "Échec de l'export.",
    'sh.filtersLabel': 'Filtres / quotas :',
    'sh.limPerFile': 'max {v}/fichier',
    'sh.limFiles': 'max {v} fichiers',
    'sh.limQuota': 'quota {v}',
    'sh.limAllow': 'autorisés : {v}',
    'sh.limBlock': 'bloqués : {v}',
    'sh.usage': 'utilisé {v}',
    'sh.statsLabel': 'Stats :',
    'stats.button': '📊 Stats',
    'stats.title': 'Statistiques détaillées',
    'stats.loading': 'Chargement des statistiques…',
    'stats.fail': 'Impossible de charger les statistiques.',
    'stats.overview': 'Vue d’ensemble',
    'stats.details': 'Informations du partage',
    'stats.activity14': 'Activité des 14 derniers jours',
    'stats.recent': 'Activité récente',
    'stats.countries': 'Pays principaux',
    'stats.clients': 'Clients principaux',
    'stats.imageCopies': 'Copies de l’image',
    'stats.imageRecent': 'Accès récents à l’image',
    'stats.live': 'Transferts en cours',
    'stats.transfers': 'Transferts',
    'stats.volume': 'Volume',
    'stats.success': 'Réussite',
    'stats.speed': 'Vitesse moyenne',
    'stats.views': 'Vues',
    'stats.visitors': 'Visiteurs uniques',
    'stats.storage': 'Espace occupé',
    'stats.downloads': 'Téléchargements',
    'stats.completed': 'Terminés',
    'stats.interrupted': 'Interrompus',
    'stats.averageSize': 'Taille moyenne',
    'stats.lastActivity': 'Dernière activité',
    'stats.firstActivity': 'Première activité conservée',
    'stats.status': 'État',
    'stats.type': 'Type',
    'stats.owner': 'Propriétaire',
    'stats.created': 'Création',
    'stats.expiry': 'Expiration',
    'stats.items': 'Éléments',
    'stats.path': 'Chemin',
    'stats.url': 'Lien',
    'stats.tags': 'Étiquettes',
    'stats.none': 'Aucune donnée disponible.',
    'stats.noRecent': 'Aucune activité récente enregistrée.',
    'stats.noImageRecent': 'Les accès détaillés seront enregistrés à partir de cette version.',
    'stats.full': 'Originale',
    'stats.thumb': 'Mini',
    'stats.micro': 'Micro',
    'stats.dimensions': 'Dimensions',
    'stats.lastView': 'Dernière vue',
    'stats.active': 'Actif',
    'stats.inactive': 'Inactif',
    'stats.paused': 'En pause',
    'stats.scheduled': 'Programmé',
    'stats.unknown': 'Inconnu',
    'stats.quota': 'Utilisation des quotas',
    'stats.files': 'Fichiers',
    'sh.statCount': '{n} transferts · {v}',
    'sh.statOkKo': '{ok} ok / {ko} interrompus',
    'sh.statLast': 'dernier {v}',
    'sh.protected': '🔒 protégé',
    'sh.qr': 'QR',
    'sh.qrTitle': 'Afficher le QR code',
    'qr.title': 'Code QR',
    'pk.password': 'Mot de passe (facultatif)',
    'pk.passwordPh': 'aucun',
    'tr.stopTitle': 'Arrêter',
    'tr.stopConfirm': 'Arrêter ce transfert ?',
    'sh.shutdownLabel': 'Éteindre le serveur après le prochain téléchargement complet',
    'sh.shutdownHelp': "Le conteneur s'arrête ; le réglage se désarme ensuite.",
    'sh.none': 'Aucun partage. Cliquez « ＋ Nouveau partage » pour en créer un.',
    'sh.connLost': 'Serveur injoignable (peut-être arrêté après un téléchargement). Reconnexion…',
    'sh.folder': 'dossier',
    'sh.file': 'fichier',
    'sh.inactive': 'inactif',
    'sh.sizeLabel': 'Taille :',
    'sh.created': 'Créé :',
    'sh.downloads': 'Téléch. :',
    'sh.visitors': 'Visiteurs :',
    'sh.viewsTip': '{views} vue(s) · {visitors} visiteur(s) unique(s)',
    'sh.expires': 'Expire :',
    'sh.scheduled': '🕒 programmé',
    'sh.startsAt': 'Actif à partir de :',
    'pk.startsAt': 'Actif à partir de (facultatif)',
    'sh.link': 'Lien',
    'sh.lan': 'LAN',
    'sh.open': 'Ouvrir',
    'sh.revoke': 'Révoquer',
    'sh.copy': 'Copier',
    'sh.copied': 'Lien copié ✓',
    'sh.copyFail': 'Copie impossible, sélectionnez le lien manuellement',
    'sh.revokeConfirm': 'Révoquer le partage « {name} » ?\nVous pourrez le récupérer pendant 5 secondes.',
    'sh.revoked': 'Partage révoqué',
    'sh.revokeFail': 'Révocation impossible',
    'sh.revokePending': 'Suppression dans 5 s…',
    'sh.undoRevoke': 'Récupérer',
    'sh.recovered': 'Partage récupéré',
    'sh.created2': 'Partage créé ✓',
    'sh.createFail': 'Création impossible : {error}',
    'sh.loadFail': 'Chargement des partages impossible',
    'hi.title': 'Historique',
    'hi.subtitle': '(2 000 derniers transferts)',
    'hi.none': 'Aucun transfert récent.',
    'hi.noMatch': 'Aucun transfert ne correspond aux filtres.',
    'hi.filter': '🔎 Filtrer',
    'hi.searchPh': 'Rechercher par nom, IP, pays…',
    'hi.direction': 'Sens du transfert',
    'hi.status': 'État du transfert',
    'hi.allDirections': 'Tous les sens',
    'hi.downloads': 'Téléchargements',
    'hi.uploads': 'Envois',
    'hi.allStatuses': 'Tous les états',
    'hi.completedPlural': 'Complétés',
    'hi.interruptedPlural': 'Interrompus',
    'hi.resetFilter': 'Effacer',
    'hi.results': '{shown} sur {total}',
    'hi.previous': 'Page précédente',
    'hi.next': 'Page suivante',
    'hi.completed': 'complété',
    'hi.interrupted': 'interrompu',
    'hi.clear': '🗑 Purger',
    'hi.clearConfirm': 'Purger tout l’historique des transferts ?\nLa liste et le journal exportable (CSV/JSON) seront effacés. Les statistiques par lien sont conservées.',
    'hi.cleared': 'Historique purgé ✓',
    'hi.clearFail': 'Purge impossible',
    'live.online': 'en direct',
    'live.offline': 'hors ligne',
    'live.title': 'Mise à jour automatique',
    'pk.title': 'Choisir un fichier ou un dossier',
    'pk.location': 'Emplacement :',
    'pk.expiration': 'Expiration',
    'pk.never': 'Jamais',
    'pk.h1': '1 heure',
    'pk.d1': '1 jour',
    'pk.d7': '7 jours',
    'pk.d30': '30 jours',
    'pk.maxDl': 'Téléchargements max',
    'pk.maxVisitors': 'Visiteurs uniques max',
    'pk.rate': 'Débit max (Ko/s)',
    'pk.allowZip': 'Autoriser « Tout télécharger (.zip) »',
    'pk.burn': 'Lien à usage unique (révoqué après le 1er téléchargement)',
    'pk.note': 'Message affiché au visiteur (facultatif)',
    'pk.notePh': 'ex. Voici le fichier demandé.',
    'sh.speed': 'Débit : {v} Ko/s',
    'sh.zipOff': '⛔ .zip désactivé',
    'menu.about': 'ℹ️ À propos',
    'about.title': 'À propos',
    'about.author': 'Auteur :',
    'about.version': 'Version',
    'about.released': 'Dernière version',
    'about.github': 'GitHub',
    'about.docker': 'Docker Hub',
    'about.discord': 'Discord',
    'pk.addTitle': 'Ajouter des fichiers à « {name} »',
    'pk.addBtn': 'Ajouter',
    'sh.addFiles': '➕ Ajouter des fichiers',
    'sh.files': '{n} fichiers',
    'sh.added': 'Fichier ajouté au partage',
    'sh.addFail': 'Échec de l’ajout : {error}',
    'sh.removeItem': 'Retirer',
    'sh.reorder': 'Glisser pour réordonner',
    'sh.reordered': 'Ordre enregistré',
    'sh.reorderFail': 'Échec du réordonnancement',
    'sh.renameTip': 'Double-cliquez pour renommer',
    'sh.renamed': 'Lien renommé',
    'sh.renameFail': 'Échec du renommage',
    'sh.summary': '{n} lien(s) · {active} actif(s) · {size}',
    'sh.paused': 'en pause',
    'sh.pause': '⏸ Pause',
    'sh.resume': '▶ Reprendre',
    'sh.pauseTitle': 'Mettre en pause (désactiver sans supprimer)',
    'sh.resumeTitle': 'Réactiver ce lien',
    'sh.paused2': 'Lien mis en pause',
    'sh.resumed': 'Lien réactivé',
    'sh.pauseFail': 'Échec de la mise en pause',
    'sh.noteBtn': '📝 Note',
    'sh.noteTitle': 'Note privée (visible par l’admin uniquement)',
    'sh.noteEditTip': 'Cliquez pour modifier la note',
    'sh.notePh2': 'Note privée pour l’admin…',
    'sh.noteSaved': 'Note enregistrée',
    'sh.noteFail': 'Échec de l’enregistrement de la note',
    'sh.log': '🧾 Journal',
    'sh.logTitle': 'Journal d’accès de ce lien',
    'sh.exportCsv': '⬇ Liste CSV',
    'sh.exportJson': '⬇ Liste JSON',
    'sh.dupWarn': 'Ce chemin est déjà partagé par : {names}. Créer quand même un autre lien ?',
    'log.title': 'Journal d’accès',
    'log.loading': 'Chargement…',
    'log.fail': 'Échec du chargement du journal',
    'log.none': 'Aucun accès enregistré pour ce lien.',
    'log.ok': 'complet',
    'log.ko': 'interrompu',
    'pk.unitH': 'h',
    'pk.unitD': 'j',
    'pk.unitW': 'sem',
    'pk.unitMo': 'mois',
    'cfg.expiryPresets': 'Préréglages d’expiration rapides',
    'cfg.expiryPresetsHint': 'Durées séparées par des virgules proposées dans les fenêtres de lien — ex. 6h, 3d, 2w, 1mo. « Jamais » est toujours disponible.',
    'search.btn': '🔎 Recherche contenu',
    'search.ph': '🔎 Chercher dans les fichiers texte partagés & reçus…',
    'search.run': 'Chercher',
    'search.searching': 'Recherche…',
    'search.tooShort': 'Saisissez au moins 2 caractères.',
    'search.fail': 'Échec de la recherche',
    'search.count': '{n} fichier(s) · {scanned} analysé(s)',
    'search.truncated': 'résultats tronqués',
    'search.none': 'Aucun résultat.',
    'photo.title': 'Images',
    'photo.add': '🖼 Ajouter des images',
    'img.netTitle': 'Domaine des images & accès externe',
    'img.domainLabel': 'Domaine des images (optionnel)',
    'img.domainPh': 'ex. img.exemple.com',
    'img.domainHelp': 'Utilisé uniquement pour les liens d’image. Vide = même domaine que les liens principaux.',
    'img.hotlinkLabel': 'Protection anti-hotlink (optionnel)',
    'img.hotlinkPh': 'ex. example.com, forum.example.org',
    'img.hotlinkHelp': 'Sites autorisés à afficher vos images (séparés par des virgules). Vide = tous les sites. Les visites directes et les pages de ce serveur restent toujours permises ; les sous-domaines d’un hôte listé le sont aussi.',
    'img.hotlinkSaved': 'Protection anti-hotlink enregistrée.',
    'img.hotlinkCleared': 'Protection anti-hotlink désactivée.',
    'img.domainSaved': 'Domaine des images enregistré ✓',
    'img.autoRestored': 'Domaine des images réinitialisé (domaine principal)',
    'photo.intro': 'Liens d’image directs : chaque photo a une URL pleine taille, Mini et Micro qui ouvrent l’image elle-même, sans page autour — prêtes à intégrer ou hotlinker.',
    'photo.none': 'Aucune photo partagée.',
    'photo.pickTitle': 'Choisir des images',
    'photo.pickBtn': 'Créer les liens',
    'photo.createFail': 'Échec de la création',
    'photo.created': '{n} image(s) ajoutée(s)',
    'photo.skipped': '{n} ignorée(s) (non-image)',
    'photo.copyFailed': 'Échec de copie pour {n} image(s) — vérifiez le dossier Images',
    'photo.full': 'Pleine',
    'photo.thumb': 'Mini',
    'photo.micro': 'Micro',
    'photo.bbcode': 'BBCode',
    'photo.md': 'MD',
    'photo.html': 'HTML',
    'photo.renameHint': 'Double-cliquez pour renommer',
    'photo.editExpiry': 'Modifier l’expiration',
    'photo.noExpiry': 'Sans expiration',
    'photo.expiryUpdated': 'Expiration mise à jour ✓',
    'photo.expiryFail': 'Échec de la mise à jour de l’expiration',
    'photo.searchPh': 'Rechercher une image…',
    'photo.sortTitle': 'Trier',
    'photo.sortNew': 'Plus récentes',
    'photo.sortOld': 'Plus anciennes',
    'photo.sortName': 'Nom',
    'photo.sortViews': 'Plus vues',
    'photo.sortSize': 'Plus lourdes',
    'photo.sortDimensions': 'Plus grandes dimensions',
    'photo.filters': 'Filtres des images',
    'photo.filterFormat': 'Filtrer par format',
    'photo.allFormats': 'Tous les formats',
    'photo.filterOrientation': 'Filtrer par orientation',
    'photo.allOrientations': 'Toutes les orientations',
    'photo.landscape': 'Paysage',
    'photo.portrait': 'Portrait',
    'photo.square': 'Carrée',
    'photo.filterVariants': 'Filtrer par variantes',
    'photo.allVariants': 'Toutes les variantes',
    'photo.variantsReady': 'Mini + Micro prêtes',
    'photo.variantsMissing': 'Variante manquante',
    'photo.filterAlbum': 'Filtrer par galerie',
    'photo.allAlbums': 'Toutes les galeries',
    'photo.noAlbum': 'Sans galerie',
    'photo.favoritesOnly': '☆ Favoris',
    'photo.filterReset': 'Réinitialiser',
    'photo.favorite': 'Ajouter aux favoris',
    'photo.unfavorite': 'Retirer des favoris',
    'photo.rename': '✎ Renommer',
    'photo.createdAt': 'Ajoutée le {date}',
    'photo.ratio': 'ratio {ratio}',
    'photo.exportCsv': '⇩ CSV',
    'photo.exportJson': '⇩ JSON',
    'photo.copyAll': '🔗 Tout copier',
    'photo.copyAllTitle': 'Copier tous les liens pleine grandeur affichés (un par ligne)',
    'photo.lbOpen': 'Ouvrir ↗',
    'album.create': '🖼 Créer une galerie',
    'album.title': 'Galeries',
    'album.hint': 'Galeries d\'images publiques créées à partir d\'images sélectionnées. Toute personne disposant du lien peut les voir.',
    'album.count': '{n} images',
    'album.views': '{n} vues',
    'album.untitled': 'Galerie',
    'album.namePrompt': 'Nom de la galerie :',
    'album.created': 'Galerie créée.',
    'album.createFail': 'Échec de la création de la galerie.',
    'photo.dropHint': 'Glissez des images ici, collez (Ctrl+V) ou cliquez — un lien direct est créé pour chacune.',
    'photo.uploaded': '{n} image(s) ajoutée(s) ✓',
    'photo.uploadProgress': 'Import {done}/{total}',
    'photo.uploadSummary': '{ok} ajoutée(s), {failed} échec(s), {skipped} ignorée(s)',
    'photo.uploadFail': 'Échec du téléversement',
    'photo.selectHint': 'Sélectionner pour les actions groupées',
    'photo.selectedN': '{n} sélectionnée(s)',
    'photo.bulkExpiry': 'Fixer l’expiration…',
    'photo.bulkExpiryTitle': 'Fixer l’expiration des images sélectionnées',
    'photo.bulkAlbum': 'Ajouter à une galerie…',
    'photo.bulkAlbumTitle': 'Ajouter les images sélectionnées à une galerie existante',
    'photo.bulkAlbumDone': '{n} image(s) ajoutée(s) à la galerie',
    'photo.bulkFavorite': '★ Ajouter aux favoris',
    'photo.bulkUnfavorite': '☆ Retirer des favoris',
    'photo.bulkDownload': '⇩ ZIP',
    'photo.bulkRevoke': '🗑 Révoquer',
    'photo.bulkClear': 'Effacer',
    'photo.gallery': 'Galerie d’images',
    'photo.history': 'Historique',
    'photo.historyHint': 'Les 50 dernières images révoquées sont conservées ici.',
    'photo.historyEmpty': 'Aucune image révoquée.',
    'photo.revokedAt': 'Révoquée le {date}',
    'photo.histFull': 'complète {size}',
    'photo.histKept': 'conservée {size}',
    'photo.previewUnavailable': 'Aperçu indisponible',
    'photo.historyDelete': 'Supprimer de l’historique',
    'photo.historyDeleteConfirm': 'Supprimer définitivement « {name} » de l’historique ?',
    'photo.historyDeleted': 'Élément supprimé de l’historique ✓',
    'photo.historyDeleteFail': 'Échec de la suppression',
    'photo.purge': '🗑 Purger',
    'photo.purgeConfirm': 'Purger définitivement l’historique des images révoquées ?',
    'photo.purged': 'Historique des images purgé ✓',
    'photo.purgeFail': 'Échec de la purge',
    'sh.itemRemoved': 'Élément retiré',
    'sh.removeItemFail': 'Échec du retrait : {error}',
    'pk.unlimited': 'illimité',
    'pk.selection': 'Sélection :',
    'pk.cancel': 'Annuler',
    'pk.share': 'Partager',
    'pk.folderSuffix': '  (dossier)',
    'pk.fileSuffix': '  (fichier)',
    'pk.selectedN': '{n} éléments sélectionnés',
    'pk.multiHint': 'Astuce : cliquez plusieurs éléments pour les partager ensemble (même dans différents dossiers).',
    'pk.parent': '.. (dossier parent)',
    'pk.emptyFolder': 'Dossier vide',
    'pk.open': 'ouvrir ›',
    'pk.navFail': 'Navigation impossible',
    'pk.hostInaccessible': 'Système de fichiers hôte inaccessible (montez /:/host:ro).',
    'pk.preview': '👁 Prévisualiser',
    'pk.previewUnsupported': 'Aperçu impossible dans ce navigateur pour ce format — le codec n’est pas pris en charge.',
    'pw.title': 'Changer le mot de passe',
    'pw.firstTitle': 'Définissez votre mot de passe',
    'pw.firstLoginHint':
      'Pour des raisons de sécurité, choisissez un nouveau mot de passe avant de continuer.',
    'pw.current': 'Mot de passe actuel',
    'pw.new': 'Nouveau mot de passe (8 caractères min.)',
    'pw.confirm': 'Confirmer le nouveau mot de passe',
    'pw.tooShort': 'Le nouveau mot de passe doit faire au moins 8 caractères.',
    'pw.mismatch': 'La confirmation ne correspond pas.',
    'pw.changed': 'Mot de passe changé ✓',
    'pw.changedEnv':
      "Mot de passe changé (session en cours seulement : ADMIN_PASSWORD est fixé par variable d'environnement).",
    'pw.changedTemp':
      "Mot de passe changé pour cette session, mais l'enregistrement sur le disque a échoué (vérifiez les droits du dossier data).",
    'pw.currentWrong': 'Mot de passe actuel incorrect.',
    'pw.changeFail': 'Changement impossible.',
    'time.s': 's',
    'time.min': 'min',
    'time.h': 'h',
    'time.d': 'j',
    'time.ago': 'il y a {v}',
    'units.bytes': ['o', 'Ko', 'Mo', 'Go', 'To'],
  },

  en: {
    // --- Client nicknames by IP (added) ---
    'ipn.prompt': 'Nickname for {ip}:',
    'ipn.clickHint': 'Click to rename this client',
    'ipn.saved': 'Nickname saved ✓',
    'ipn.cleared': 'Nickname cleared',
    'ipn.fail': 'Could not save',
    'auditA.ip-named': 'Client renamed',
    'auditA.ip-unnamed': 'Client nickname cleared',
    // --- Nominative sub-links (added) ---
    'rcp.label': 'Nominative sub-links ({n}):',
    'rcp.dl': '{n} dl',
    'rcp.add': 'Add',
    'rcp.addPh': 'Name(s) — comma-separated',
    'rcp.remove': 'Remove this sub-link',
    'rcp.limitsTitle': 'Per-recipient limits',
    'rcp.maxDlPrompt': 'Max downloads for "{name}" (blank = unlimited):',
    'rcp.expiryPrompt': 'Expiry for "{name}" in days (blank = never):',
    'rcp.limitsSaved': 'Recipient limits saved',
    'rcp.limitsFail': 'Could not save',
    'acc.title': 'Access rules (geo / IP)',
    'acc.geoMode': 'Countries',
    'acc.off': 'No restriction',
    'acc.allowOnly': 'Allow only',
    'acc.deny': 'Block',
    'acc.countries': 'Country codes (ISO, comma-separated)',
    'acc.ipMode': 'IP addresses',
    'acc.ips': 'IP / CIDR (comma-separated)',
    'acc.hint': 'Loopback is always allowed. Country rules need IP geolocation on; visitors whose country can’t be determined are allowed (IP rules are the hard boundary).',
    'rcp.removeConfirm': 'Remove {name}\'s sub-link?\nTheir link will stop working.',
    'rcp.added': 'Sub-link(s) created ✓',
    'rcp.addFail': 'Could not add',
    'rcp.exists': 'That recipient already exists',
    'rcp.removed': 'Sub-link removed',
    'rcp.removeFail': 'Could not remove',
    'auditA.recipients-added': 'Sub-links added',
    'auditA.recipient-removed': 'Sub-link removed',
    'dec.noCrypto': '⚠ Decryption requires a secure context (HTTPS or localhost); unavailable over plain HTTP.',
    // --- Decrypt received .dxe (added) ---
    'menu.decrypt': '🔓 Decrypt a .dxe file',
    'dec.title': 'Decrypt a .dxe file',
    'dec.intro': 'Select a .dxe file received via an encrypted link. It is decrypted here, in your browser.',
    'dec.file': 'Encrypted file (.dxe)',
    'dec.key': 'Decryption key or full link',
    'dec.keyPh': '…#k=… or the key',
    'dec.passphrase': 'Passphrase',
    'dec.go': 'Decrypt',
    'dec.decrypting': 'Decrypting…',
    'dec.notDxe': 'Invalid or unreadable .dxe file.',
    'dec.needKey': 'Provide the key (or the link containing #k=).',
    'dec.needPass': 'Enter the passphrase.',
    'dec.badKey': 'Decryption failed: wrong key or passphrase, or corrupted file.',
    'dec.done': 'File decrypted ✓',
    // --- End-to-end encryption (added) ---
    'enc.newShare': '🔒 Encrypted share',
    'secret.new': '🔑 Secret note',
    'secret.title': 'New secret note',
    'secret.intro': 'Share a password, key or short message. It is end-to-end encrypted in your browser and destroyed the first time it is read.',
    'secret.text': 'Secret',
    'secret.textPh': 'e.g. the Wi-Fi password…',
    'secret.passLabel': 'Passphrase',
    'secret.passPh': 'share it separately',
    'secret.create': 'Create secret',
    'secret.created': '✓ Secret created',
    'secret.createFail': '✗ Could not create the secret',
    'secret.needText': 'Enter the secret to share.',
    'secret.noteKey': '⚠ The key is in the link (after #). It works only once: the secret is destroyed on first open.',
    'secret.notePass': '⚠ Share the passphrase separately. The link works only once: the secret is destroyed on first open.',
    'enc.title': 'New encrypted share',
    'enc.file': 'File to encrypt',
    'enc.label': 'Label (shown on the page)',
    'enc.labelPh': 'e.g. Contract.pdf',
    'enc.mode': 'Encryption mode',
    'enc.modeKey': 'Key in link',
    'enc.modePass': 'Passphrase',
    'enc.passphrase': 'Passphrase',
    'enc.expiry': 'Expiration',
    'enc.maxDl': 'Max downloads',
    'enc.create': 'Create',
    'enc.encrypting': 'Encrypting…',
    'enc.uploading': 'Uploading…',
    'enc.created': 'Encrypted share created ✓',
    'enc.createFail': 'Failed to create encrypted share',
    'enc.needFile': 'Choose a file first.',
    'enc.needPass': 'Enter a passphrase.',
    'enc.linkTitle': 'Encrypted link ready',
    'enc.copy': 'Copy link',
    'enc.done': 'Done',
    'enc.noteKey': '⚠ The key is contained only in this link and cannot be recovered. Copy it now.',
    'enc.notePass': 'Share the passphrase with the recipient through a separate channel.',
    'enc.inboxEncrypt': 'End-to-end encrypt received files',
    'enc.inboxLinkNote': '⚠ Share this full link: the key it contains cannot be recovered.',
    'app.name': 'Direct-Xfer',
    'app.docTitle': 'Direct-Xfer — Admin',
    'login.subtitle': 'Administrator area',
    'setup.warnTitle': '⚠ Storage not configured',
    'setup.inbox': 'The reception folder “/Direct-Xfer” is still at its default (/PATH/TO/CONFIGURE) — not pointed at a real host folder.',
    'setup.images': 'The images folder “/Images” is still at its default (/PATH/TO/CONFIGURE) — not pointed at a real host folder.',
    'setup.hint': 'Configure the volumes in docker-compose.yml (replace /PATH/TO/CONFIGURE).',
    'pwa.openApp': '📱 Mobile send app',
    'login.password': 'Password',
    'login.submit': 'Log in',
    'login.invalid': 'Invalid username or password.',
    'login.hint.env-owner': 'The owner password is set via ADMIN_PASSWORD: log in with the configured admin username (default “admin”) and that exact value, with no surrounding quotes or spaces.',
    'login.hint.no-persist': '/data is not writable: accounts and password changes don’t survive a restart. Only the ADMIN_PASSWORD owner login works.',
    'login.tooMany': 'Too many attempts. Try again in {s}s.',
    'login.connError': 'Server connection error.',
    'login.totp': '2FA code',
    'login.totpHint': 'Enter the 6-digit code from your authenticator app (or a recovery code).',
    'login.totpInvalid': 'Invalid 2FA code.',
    'login.username': 'Username',
    'pw.envManaged': 'Password managed via ADMIN_PASSWORD: change it through the environment variable.',
    'menu.signedInAs': 'Signed in as',
    'menu.accounts': '👥 Admin accounts',
    'menu.audit': '📋 Audit log',
    'menu.config': '⚙ Configuration',
    'cfg.title': 'Configuration',
    'cfg.security': 'Security',
    'cfg.idleEnable': 'Auto-lock after inactivity',
    'cfg.idleMins': 'Inactivity delay (minutes)',
    'cfg.idleHint': 'Locks the admin interface (requires signing in again) after this long with no mouse or keyboard activity.',
    'cfg.locked': '🔒 Session locked due to inactivity. Please sign in again.',
    'cfg.saved': 'Configuration saved ✓',
    'cfg.savedTemp': 'Configuration applied but not saved to disk (data folder not writable).',
    'cfg.saveFail': 'Could not save.',
    'cfg.notif': 'Notifications (webhook)',
    'cfg.webhookEnv': 'Managed by the WEBHOOK_URL environment variable.',
    'cfg.webhookUrl': 'Webhook URL',
    'cfg.webhookFormat': 'Format',
    'cfg.webhookAuto': 'Auto-detect',
    'cfg.notifyDownloads': 'Downloads',
    'cfg.notifyUploads': 'Uploads',
    'cfg.notifyMessages': 'Messages',
    'cfg.webhookTest': 'Test',
    'cfg.webpush': 'Browser notifications (Web Push)',
    'cfg.webpushHint': 'Receive push notifications in this browser for the events ticked above — even when the admin page is closed. Each browser/device subscribes separately.',
    'cfg.webpushUnavail': 'Web Push is unavailable: the web-push module isn’t installed on the server.',
    'cfg.webpushInsecure': 'Requires a secure context (HTTPS, or localhost). Enable TLS to use browser push.',
    'cfg.webpushNoSupport': 'This browser does not support Web Push.',
    'cfg.webpushEnable': 'Enable on this browser',
    'cfg.webpushDisable': 'Disable on this browser',
    'cfg.webpushTest': 'Send test',
    'cfg.webpushOn': 'Enabled on this browser ✓',
    'cfg.webpushDenied': 'Notifications blocked by the browser.',
    'cfg.webpushSubscribed': 'Notifications enabled ✓',
    'cfg.webpushUnsubscribed': 'Notifications disabled',
    'cfg.webpushTestSent': 'Test sent ✓',
    'cfg.webpushNoSub': 'No subscribed browser.',
    'cfg.webpushFail': 'Web Push operation failed.',
    'cfg.webhookTesting': 'Testing…',
    'cfg.webhookOk': '✓ Call succeeded',
    'cfg.webhookFail': '✗ Call failed',
    'cfg.webhookNoUrl': 'No webhook URL.',
    'cfg.webhookInvalid': 'Invalid webhook URL (http/https).',
    'cfg.defaults': 'Defaults for new links',
    'cfg.privacy': 'Privacy',
    'cfg.geoLookup': 'Geolocate visitor IPs',
    'cfg.geoHint': 'Off = no external lookups; visitor countries won’t be shown.',
    'cfg.maxAttempts': 'Max login attempts',
    'cfg.lockoutMins': 'Lockout (minutes)',
    'cfg.sessionHours': 'Session lifetime (hours)',
    'cfg.sessionDefault': 'default',
    'cfg.tokenBytes': 'Link token length (bytes)',
    'cfg.httpsWarn': 'Warn when the admin is served over plain HTTP',
    'cfg.httpsBanner': '⚠ Admin panel served over plain HTTP: your credentials travel unencrypted. Use HTTPS.',
    'cfg.allowPreview': 'Allow in-browser preview',
    'cfg.reqPassword': 'Require a password by default',
    'cfg.startDelay': 'Deferred start (hours, 0 = immediate)',
    'cfg.defaultDir': 'Default folder for the picker',
    'cfg.defaultDirPh': 'empty = last used folder',
    'cfg.defaultDirBrowse': 'Browse…',
    'cfg.defaultDirHint': 'The "New share" file picker opens here. Leave empty to reuse the last-browsed folder.',
    'pk.chooseDir': 'Choose the default folder',
    'pk.chooseDirBtn': 'Choose this folder',
    'cfg.recDefaults': 'Reception-link defaults',
    'cfg.allowExt': 'Allowed extensions (comma-separated)',
    'cfg.blockExt': 'Blocked extensions (comma-separated)',
    'cfg.encrypt': 'Enable end-to-end encryption by default',
    'cfg.limits': 'Global limits',
    'cfg.globalRate': 'Server-wide download cap (KB/s)',
    'cfg.globalRateHint': 'Hard ceiling applied to every download, on top of any per-link limit.',
    'cfg.schedEnable': 'Cap bandwidth during a time window',
    'cfg.schedRate': 'Cap during the window (KB/s)',
    'cfg.schedStart': 'From',
    'cfg.schedEnd': 'To',
    'cfg.schedHint': 'Server-local time. The window may span midnight (e.g. 08:00 → 02:00). Outside it, only the caps above apply.',
    'cfg.antiabuse': 'Public download protection',
    'cfg.prlEnable': 'Rate-limit downloads per visitor IP',
    'cfg.prlMax': 'Max requests',
    'cfg.prlWindow': 'Per window (minutes)',
    'cfg.chalEnable': 'Require a challenge before large downloads',
    'cfg.chalMin': 'Trigger over (MB)',
    'cfg.chalBits': 'Difficulty (8–24)',
    'cfg.chalHint': 'A self-hosted proof-of-work solved in the visitor’s browser (no third party). Deters mass scraping of a leaked link; higher difficulty = more work per download.',
    'cfg.leakEnable': 'Alert when a link is downloaded from many countries',
    'cfg.leakCountries': 'Distinct countries',
    'cfg.leakWindow': 'Within (hours)',
    'cfg.leakHint': 'Sends one notification (over the webhook / e-mail above) when a single link is downloaded from at least this many countries in the window — a sign the link may have leaked. Needs IP geolocation enabled.',
    'cfg.auditJson': 'Export audit log (JSON)',
    'cfg.auditCsv': 'Export audit log (CSV)',
    'cfg.auditHint': 'The admin action log (logins, link create/revoke, settings changes, alerts).',
    'cfg.bkTitle': 'Scheduled full backup',
    'cfg.bkIntro': 'A full backup bundles the whole store (links + settings), the transfer journal and the secret notes into one file — encrypted with DATA_KEY when it is set. Pushed to a folder, WebDAV or S3.',
    'cfg.bkEnable': 'Run a scheduled backup automatically',
    'cfg.bkInterval': 'Frequency',
    'cfg.bkDaily': 'Daily',
    'cfg.bkWeekly': 'Weekly',
    'cfg.bkHour': 'At hour (0–23)',
    'cfg.bkWeekday': 'Weekday',
    'cfg.dow0': 'Sunday', 'cfg.dow1': 'Monday', 'cfg.dow2': 'Tuesday', 'cfg.dow3': 'Wednesday', 'cfg.dow4': 'Thursday', 'cfg.dow5': 'Friday', 'cfg.dow6': 'Saturday',
    'cfg.bkDest': 'Destination',
    'cfg.bkDestLocal': 'Local folder (mounted)',
    'cfg.bkDestWebdav': 'WebDAV',
    'cfg.bkDestS3': 'S3-compatible',
    'cfg.bkLocalDir': 'Backup folder path',
    'cfg.bkLocalHint': 'Mount a writable host folder into the container (e.g. /backups) so backups survive a container recreation.',
    'cfg.bkWebdavUrl': 'WebDAV collection URL',
    'cfg.bkUser': 'Username',
    'cfg.bkPass': 'Password',
    'cfg.bkS3Endpoint': 'Endpoint URL',
    'cfg.bkS3Bucket': 'Bucket',
    'cfg.bkS3Region': 'Region',
    'cfg.bkS3Prefix': 'Key prefix',
    'cfg.bkS3Key': 'Access key ID',
    'cfg.bkS3Secret': 'Secret access key',
    'cfg.bkRetention': 'Keep last N backups (0 = all — local only)',
    'cfg.bkEncWarn': '⚠ DATA_KEY is not set: backups are stored in PLAINTEXT (they contain password hashes and secret notes). Set DATA_KEY to encrypt them.',
    'cfg.bkNow': 'Backup now',
    'cfg.bkTest': 'Test destination',
    'cfg.bkDownload': 'Download backup',
    'cfg.bkRestore': 'Restore from file…',
    'cfg.bkSaveHint': 'Save your settings before Backup now / Test. Restore replaces everything and cannot be undone.',
    'cfg.bkNever': 'No backup taken yet.',
    'cfg.bkLastOk': 'Last backup: {when} → {dest} ✓',
    'cfg.bkLastFail': 'Last backup failed: {when} — {err}',
    'cfg.bkRunning': 'Backing up…',
    'cfg.bkDone': 'Backup done ✓',
    'cfg.bkFail': 'Backup failed',
    'cfg.bkTesting': 'Testing…',
    'cfg.bkTestOk': 'Destination reachable ✓',
    'cfg.bkTestFail': 'Test failed',
    'cfg.bkRestoreConfirm': 'Restoring a backup REPLACES all current links, settings, journal and secret notes. This cannot be undone. Continue?',
    'cfg.bkRestoring': 'Restoring…',
    'cfg.bkRestoreOk': 'Restored ({n} link(s)). Reloading…',
    'cfg.bkRestoreFail': 'Restore failed',
    'cfg.logo': 'Custom logo',
    'cfg.logoPick': 'Choose image…',
    'cfg.logoClear': 'Remove',
    'cfg.logoHint': 'Shown in the top bar of public pages. PNG/JPG/GIF/WebP/SVG, up to ~200 KB.',
    'cfg.logoTooLarge': 'Invalid or oversized image (max ~200 KB).',
    'cfg.legal': 'Confidentiality notice',
    'cfg.legalPh': 'e.g. Confidential — do not redistribute',
    'cfg.legalHint': 'Shown as a banner on every public download / reception page.',
    'cfg.watermark': 'Watermark image & video previews',
    'cfg.watermarkHint': 'Overlays the visitor IP (or recipient name for nominative links) over previews — deters re-sharing of screenshots.',
    'cfg.retention': 'History retention (days, 0 = keep all)',
    'cfg.logRetention': 'Transfer-journal retention (days, 0 = keep all)',
    'cfg.inboxRetention': 'Delete received files after (days, 0 = never)',
    'cfg.inboxRetentionHint': '⚠ Destructive: PERMANENTLY deletes reception & collaboration files older than this — lost files cannot be recovered. Off by default (0).',
    'cfg.inboxRetentionConfirm': '⚠ Received files older than {n} day(s) will be PERMANENTLY and automatically deleted, with no way to recover them. Confirm?',
    'cfg.require2fa': 'Require two-factor authentication for all admins',
    'cfg.adminAllowlist': 'Admin IP allowlist (IP/CIDR, comma-separated)',
    'cfg.allowlistEnv': 'Managed by the ADMIN_ALLOWED_IPS environment variable.',
    'cfg.allowlistHint': 'Empty = default (local network). Loopback is always allowed. A wrong entry can lock you out.',
    'cfg.allowlistConfirm': 'Restrict admin access to these IPs? A mistake can lock you out of the admin (only loopback will remain allowed).',
    'cfg.qrDefault': 'Show the QR code right after creating a link',
    'cfg.maxUpload': 'Max size / received file (MB)',
    'cfg.maxZip': 'Max folder .zip size (MB)',
    'cfg.maintenance': 'Maintenance',
    'cfg.updateCheck': 'Check for updates at startup',
    'cfg.updateCheckHint': 'Compares the running version against the latest published image tag. No data is sent beyond the version query.',
    'cfg.tfaRequired': 'Two-factor authentication is required — please set it up now.',
    'cfg.anonIps': 'Anonymize visitor IPs (mask the last part)',
    'cfg.keepNames': 'Keep client nicknames',
    'cfg.clearNames': 'Clear all nicknames',
    'cfg.cleared': '{n} nickname(s) cleared',
    'cfg.interface': 'Interface',
    'cfg.brandName': 'App name',
    'cfg.brandPh': 'Direct-Xfer',
    'cfg.accentOn': 'Custom accent color',
    'cfg.publicTheme': 'Public pages theme',
    'cfg.themeAuto': 'Auto (follow device)',
    'cfg.themeDark': 'Dark',
    'cfg.themeLight': 'Light',
    'cfg.themeColor': 'Custom mobile browser color',
    'cfg.themeColorHint': 'Tints the mobile browser UI bar on public pages (meta theme-color).',
    'cfg.adminLang': 'Admin language',
    'cfg.publicLang': 'Public-page language',
    'cfg.langAuto': 'Browser',
    'cfg.banner': 'Default reception banner',
    'cfg.bannerPh': 'Shown to visitors on every new reception link',
    'cfg.backup': 'Backup & restore',
    'cfg.export': 'Export settings',
    'cfg.import': 'Import settings',
    'cfg.imported': '✓ {n} setting(s) imported',
    'cfg.importFail': '✗ Invalid file',
    'cfg.notifyExpiring': 'Alert before a link expires',
    'cfg.expiryWarnHours': 'Alert lead time (hours before expiry)',
    'cfg.digestEnable': 'Send a periodic activity digest',
    'cfg.notifySecurity': 'Alert on security events (login, lockout, settings change…)',
    'cfg.digestDays': 'Digest interval (days)',
    'cfg.digestNow': 'Send digest now',
    'cfg.digestHint': 'Both alerts use the webhook above. Save your changes before testing.',
    'cfg.digestSent': '✓ Digest sent',
    'cfg.noChannel': '✗ No channel configured (webhook or e-mail)',
    'cfg.burnDefault': 'One-time links by default (revoke after first download)',
    'cfg.email': 'E-mail notifications (SMTP)',
    'cfg.emailEnv': 'Managed by the SMTP_URL environment variable.',
    'cfg.emailUnavail': 'The nodemailer module is unavailable; e-mail is disabled.',
    'cfg.emailEnable': 'Also send notifications by e-mail',
    'cfg.smtpHost': 'SMTP host',
    'cfg.smtpPort': 'Port',
    'cfg.smtpSecure': 'Implicit TLS (port 465)',
    'cfg.smtpUser': 'Username',
    'cfg.smtpPass': 'Password',
    'cfg.smtpFrom': 'From address',
    'cfg.smtpTo': 'Recipient(s)',
    'cfg.emailTest': 'Send test e-mail',
    'cfg.emailTesting': 'Sending…',
    'cfg.emailOk': '✓ E-mail sent',
    'cfg.emailFail': '✗ Send failed',
    'cfg.emailNotConfigured': '✗ SMTP not configured',
    'ed.title': 'Edit link',
    'ed.editing': 'Editing:',
    'ed.rename': 'Name',
    'ed.keep': 'Keep unchanged',
    'ed.password': 'Password',
    'ed.pwPh': 'leave blank to keep',
    'ed.pwSet': '•••••• (set — type to replace)',
    'ed.clearPw': 'Remove the password',
    'ed.saved': '✓ Link updated',
    'ed.saveFail': '✗ Failed: {error}',
    'sh.edit': 'Edit',
    'sh.oneTime': 'One-time',
    'sh.burned': 'Burned',
    'rcp.viewed': 'Viewed',
    'rcp.notSeen': 'Not seen',
    'rcp.downloaded': 'Downloaded',
    'cfg.sharesExport': 'Export links config',
    'cfg.sharesImport': 'Import links config',
    'cfg.sharesBackupHint': 'Exports every link’s settings (paths, quotas, expiries, passwords) — not the files. Useful to migrate links to another server.',
    'cfg.sharesImportConfirm': 'Import these links? They will be added to the existing ones.',
    'cfg.sharesImported': '✓ {n} link(s) imported, {s} skipped',
    'cfg.encOn': '🔒 Metadata at-rest encryption: on (DATA_KEY).',
    'cfg.encOff': 'Metadata at-rest encryption: off. Set the DATA_KEY environment variable to enable it.',
    'cfg.pwRequired': 'A password is required for this link.',
    'acc.title': 'Admin accounts',
    'acc.addTitle': 'Add an admin account',
    'acc.username': 'Username',
    'acc.usernamePh': 'e.g. alex',
    'acc.password': 'Initial password',
    'acc.passwordPh': '8 chars min.',
    'acc.create': 'Create account',
    'acc.owner': 'owner',
    'acc.admin': 'admin',
    'acc.role': 'Role',
    'acc.role.owner': 'owner',
    'acc.role.admin': 'admin',
    'acc.role.operator': 'operator',
    'acc.role.auditor': 'auditor',
    'acc.roleAdmin': 'Admin (full access)',
    'acc.roleOperator': 'Operator (own links only)',
    'acc.roleAuditor': 'Auditor (read-only)',
    'acc.roleHint': 'Admins manage everything. Operators create and manage only their own links. Auditors can view but not change anything.',
    'acc.tfOn': '🛡 2FA',
    'acc.you': 'you',
    'acc.lastLogin': 'last login {v}',
    'acc.createdBy': 'created by {v}',
    'acc.envManaged': 'managed via ADMIN_PASSWORD',
    'acc.rename': 'Rename',
    'acc.renamePrompt': 'New username for “{u}” (3–40 chars: a–z, 0–9, . _ -).',
    'acc.renamed': 'Account renamed',
    'acc.reset': 'Reset password',
    'acc.delete': 'Delete',
    'acc.confirmDelete': 'Delete account “{u}”? Its sessions will be logged out.',
    'acc.deleted': 'Account deleted',
    'acc.resetPrompt': 'New password for “{u}” (8 chars min.). The user must change it at next login.',
    'acc.resetDone': 'Password reset',
    'acc.created': 'Account created',
    'acc.taken': 'That username is already taken.',
    'acc.badUsername': 'Invalid name (3–40 chars: a–z, 0–9, . _ -).',
    'acc.pwShort': 'Password must be at least 8 characters.',
    'acc.actionFail': 'Operation failed.',
    'acc.loadFail': 'Could not load accounts.',
    'audit.title': 'Audit log',
    'audit.subtitle': 'Recent admin actions (most recent first).',
    'audit.none': 'No entries yet.',
    'audit.loadFail': 'Could not load the log.',
    'auditA.login': 'Login',
    'auditA.login-fail': 'Login failed',
    'auditA.login-2fa-fail': '2FA failed',
    'auditA.logout': 'Logout',
    'auditA.password-changed': 'Password changed',
    'auditA.password-reset': 'Password reset',
    'auditA.2fa-enabled': '2FA enabled',
    'auditA.2fa-disabled': '2FA disabled',
    'auditA.account-created': 'Account created',
    'auditA.account-deleted': 'Account deleted',
    'auditA.account-renamed': 'Account renamed',
    'auditA.share-created': 'Share created',
    'auditA.share-revoked': 'Share revoked',
    'auditA.inbox-created': 'Reception link created',
    'auditA.enc-share-created': 'Encrypted share created',
    'auditA.settings-changed': 'Settings changed',
    'auditA.push-subscribed': 'Push notifications enabled',
    'auditA.push-unsubscribed': 'Push notifications disabled',
    'auditA.server-shutdown': 'Server shutdown',
    'menu.language': 'Language',
    'menu.theme': 'Theme',
    'theme.dark': 'Dark',
    'theme.light': 'Light',
    'theme.auto': 'Auto',
    'menu.changePassword': '🔑 Change password',
    'menu.twoFactor': '🛡 Two-factor authentication (2FA)',
    'menu.logout': '⇦ Log out',
    'tfa.title': 'Two-factor authentication (2FA)',
    'tfa.statusOn': '✅ 2FA is enabled.',
    'tfa.statusOff': '2FA is disabled.',
    'tfa.enable': 'Enable 2FA',
    'tfa.disable': 'Disable 2FA',
    'tfa.step1': 'Scan this QR code with your authenticator app (Google Authenticator, Authy…), or enter the key manually.',
    'tfa.secretLabel': 'Manual key:',
    'tfa.codeLabel': 'Verification code',
    'tfa.codePh': '6-digit code',
    'tfa.verify': 'Verify and enable',
    'tfa.recoveryTitle': 'Recovery codes',
    'tfa.recoveryHint': 'Save these 8 codes somewhere safe. Each can be used once if you lose access to your app.',
    'tfa.recoveryDone': 'I saved my codes',
    'tfa.enabled': '2FA enabled ✓',
    'tfa.disabled': '2FA disabled',
    'tfa.wrongCode': 'Incorrect code.',
    'tfa.disablePwLabel': 'Confirm with your current password to disable 2FA.',
    'tfa.pwPh': 'Current password',
    'tfa.wrongPw': 'Incorrect password.',
    'tfa.genFail': 'The operation failed.',
    'dash.title': 'Dashboard',
    'dashboards.title': 'Dashboards',
    'dashboards.transfers': 'Transfers',
    'dashboards.images': 'Images',
    'dashboards.back': 'Back',
    'dash.exportCsv': '⬇ Export CSV',
    'dash.filterDirection': 'Direction',
    'dash.filterStatus': 'Status',
    'dash.filterType': 'Link type',
    'dash.filterAllDirections': 'All directions',
    'dash.filterAllStatuses': 'All statuses',
    'dash.filterAllTypes': 'All types',
    'dash.filterSearchPh': 'File, link, client, IP…',
    'dash.filterReset': 'Clear filters',
    'dash.filteredN': '{n} transfer(s) in selection',
    'dash.volumeTrend': 'Transferred volume over time',
    'dash.successTrend': 'Success rate over time',
    'dash.stalledTransfers': 'Potentially stalled transfers',
    'dash.stalledBadge': 'STALLED',
    'dash.noStalled': 'No stalled transfer detected',
    'dash.noStalledHelp': 'A transfer is flagged after a period without progress.',
    'dash.stalledFor': 'No progress for {v}',
    'dash.stopStalled': 'Stop',
    'dash.storageCleanup': 'Temporary and partial files',
    'dash.storageTypes': 'Storage by file type',
    'dash.storageLargest': 'Largest received files',
    'dash.managedStorage': 'Storage managed by Direct-Xfer',
    'dash.storedFiles': 'Stored files',
    'dash.partialFilesN': '{n} partial file(s)',
    'dash.stalePartialN': '{n} partial file(s) older than 24 h',
    'dash.scanTruncated': 'Analysis limited to the first {n} entries.',
    'dash.filesN': '{n} file(s)',
    'idash.filterStatus': 'Image status',
    'idash.filterFormat': 'Format',
    'idash.filterAllStatuses': 'All statuses',
    'idash.filterAllFormats': 'All formats',
    'idash.filterSearchPh': 'Image name or token…',
    'idash.filteredN': '{n} image(s) in selection',
    'idash.storageGrowth': 'Managed Images storage growth',
    'idash.storageFormats': 'Storage by format',
    'idash.storageLargest': 'Largest images',
    'idash.reclaimable': 'Potentially reclaimable storage',
    'idash.storageActive': 'Active images',
    'idash.storageExpired': 'Expired images',
    'idash.storageInactive': 'Inactive images',
    'idash.storageReclaimable': 'Reclaimable by removing inactive images',
    'dash.secRealtime': "Real-time & last 24 hours",
    'dash.activeTransfers': "Active transfers",
    'dash.liveUpdated': "Live · {v}",
    'dash.noActive': "No active transfer.",
    'dash.last24h': "Last 24 hours summary",
    'dash.recentErrors': "Recent transfer failures",
    'dash.noErrors': "No recent failure.",
    'dash.proxy': "Reverse proxy status",
    'dash.proxyOk': "Configuration is healthy",
    'dash.proxyWarn': "Configuration needs attention",
    'dash.proxyBad': "Configuration is incorrect",
    'dash.proxyDirect': "Direct access, no reverse proxy",
    'dash.proxyDetected': "Proxy detected: {v}",
    'dash.proxyTrust': "TRUST_PROXY: {v}",
    'dash.on': "enabled",
    'dash.off': "disabled",
    'dash.h24Transfers': "Transfers / 24 h",
    'dash.h24Volume': "Volume / 24 h",
    'dash.h24Success': "Success / 24 h",
    'dash.h24Speed': "Average speed / 24 h",
    'dash.h24Down': "Downloads / 24 h",
    'dash.h24Up': "Uploads / 24 h",
    'dash.failure.interrupted': "Unknown interruption",
    'dash.failure.aborted': "Connection interrupted",
    'dash.failure.stopped': "Stopped manually",
    'dash.failure.timeout': "Timed out",
    'dash.failure.read-error': "Read error",
    'dash.failure.zip-error': "ZIP creation error",
    'dash.failure.zip-too-large': "ZIP archive too large",
    'dash.failure.write-error': "Write error",
    'dash.failure.infected': "Infected file",
    'dash.failure.too-large': "File too large",
    'dash.failure.file-too-large': "Link file-size limit exceeded",
    'dash.failure.quota-full': "Link quota reached",
    'dash.failure.inbox-dir': "Reception folder unavailable",
    'dash.failure.connection-closed': "Connection closed before completion",
    'idash.secLinks': "Image links & availability",
    'idash.linkStatus': "Image link status",
    'idash.activeLinks': "Active image links",
    'idash.expiredLinks': "Expired image links",
    'idash.noActiveLinks': "No active image link.",
    'idash.noExpiredLinks': "No expired image link.",
    'idash.expired': "Expired",
    'idash.inactive': "Other inactive",
    'idash.proxy': "Images reverse proxy",
    'idash.kpiActive': "Active",
    'idash.kpiExpired': "Expired",
    'idash.open': "Open",
    'idash.neverExpires': "Never expires",
    'dash.refresh': '↻ Refresh',
    'dash.updated': 'Updated {v}',
    'idash.toggle': '📊 Dashboard',
    'idash.title': 'Images dashboard',
    'idash.added': 'Images added over time',
    'idash.variantViews': 'Views by size',
    'idash.activeRevoked': 'Active vs revoked',
    'idash.topViews': 'Top images (by views)',
    'idash.topVisitors': 'Top images (by visitors)',
    'idash.secStorage': 'Storage & lifecycle',
    'idash.storageSplit': 'Storage by size',
    'idash.diskSpace': 'Images disk space',
    'idash.expiring': 'Expiring soon (7 days)',
    'idash.revoked': 'Recently revoked',
    'idash.kpiImages': 'Images',
    'idash.kpiViews': 'Views',
    'idash.kpiVisitors': 'Unique visitors',
    'idash.kpiStorage': 'Images storage',
    'idash.kpiAdded': 'Added (period)',
    'idash.kpiRevoked': 'Revoked',
    'idash.kpiMini': 'Mini generated',
    'idash.kpiMicro': 'Micro generated',
    'idash.active': 'Active',
    'idash.revokedLbl': 'Revoked',
    'idash.viewsN': '{n} views',
    'idash.visitorsN': '{n} visitors',
    'idash.addedN': '{n} added',
    'dash.kpiTransfers': 'Transfers',
    'dash.kpiVolume': 'Total volume',
    'dash.kpiSuccess': 'Success rate',
    'dash.kpiDown': 'Downloads',
    'dash.kpiUp': 'Uploads received',
    'dash.kpiVisitors': 'Unique visitors',
    'dash.kpiShares': 'Active links',
    'dash.activity': 'Activity',
    'dash.periodAll': 'All',
    'p3.insights': 'Insights & automatic alerts',
    'p3.alerts': 'Automatic alerts',
    'p3.comparison': 'Compared with previous period',
    'p3.users': 'Statistics by user',
    'p3.duplicates': 'Duplicate detection',
    'p3.optimization': 'WebP / AVIF optimization',
    'p3.noAlerts': 'No anomaly detected',
    'p3.noAlertsHelp': 'Thresholds are checked automatically on every refresh.',
    'p3.noComparison': 'Comparison is unavailable for the “All” period.',
    'p3.currentPeriod': 'Current period',
    'p3.previousPeriod': 'Previous period',
    'p3.transfers': 'Transfers',
    'p3.volume': 'Volume',
    'p3.success': 'Success',
    'p3.speed': 'Average throughput',
    'p3.imagesAdded': 'Images added',
    'p3.storageAdded': 'Storage added',
    'p3.averageSize': 'Average size',
    'p3.newValue': 'new',
    'p3.userShares': '{n} share(s)',
    'p3.userTransfers': '{n} transfer(s)',
    'p3.userImages': '{n} image(s)',
    'p3.userSuccess': '{n}% success',
    'p3.userViews': '{n} view(s)',
    'p3.noUsers': 'No per-user data for this period.',
    'p3.noDuplicates': 'No exact duplicate detected',
    'p3.noDuplicatesHelp': 'Equal-size images are compared using SHA-256 fingerprints.',
    'p3.duplicateSummary': '{n} duplicate(s) in {groups} group(s) · {space} reclaimable',
    'p3.duplicateGroup': '{n} copies · {size} each · {space} reclaimable',
    'p3.scanLimited': 'Analysis limited to {n} images to protect performance.',
    'p3.estimated': 'Estimate',
    'p3.eligible': '{n} eligible image(s)',
    'p3.potentialSaving': 'Potential saving: {space}',
    'p3.optimizationNote': 'Non-destructive estimate based on the current format. No file is converted automatically.',
    'p3.noOptimization': 'No large image is eligible for this conversion.',
    'p3.candidateSaving': '{format} · {size} → estimated saving {space}',
    'p3.alert.title.disk-critical': 'Reception storage almost full',
    'p3.alert.detail.disk-critical': '{pct}% used; only {free} available.',
    'p3.alert.title.disk-warning': 'Reception storage needs attention',
    'p3.alert.detail.disk-warning': '{pct}% used; {free} available.',
    'p3.alert.title.failure-rate': 'High failure rate',
    'p3.alert.detail.failure-rate': '{pct}% failures ({n} interrupted transfers).',
    'p3.alert.title.failure-increase': 'Failures increased',
    'p3.alert.detail.failure-increase': '{current} failures versus {previous} in the previous period.',
    'p3.alert.title.stale-parts': 'Old partial files',
    'p3.alert.detail.stale-parts': '{n} partial file(s) older than 24 hours use {space}.',
    'p3.alert.title.locked-ips': 'Locked IP addresses',
    'p3.alert.detail.locked-ips': '{n} address(es) are currently blocked after sign-in failures.',
    'p3.alert.title.webhook-failed': 'Latest webhook failed',
    'p3.alert.detail.webhook-failed': 'The latest webhook notification was not delivered.',
    'p3.alert.title.email-failed': 'Latest email failed',
    'p3.alert.detail.email-failed': 'The latest email notification was not delivered.',
    'p3.alert.title.stalled': 'Stalled transfers detected',
    'p3.alert.detail.stalled': '{n} transfer(s) have made no progress for at least {v}.',
    'p3.alert.title.proxy-bad': 'Reverse proxy configuration is incorrect',
    'p3.alert.detail.proxy-bad': 'The proxy diagnostic reports an error that can disrupt links or large transfers.',
    'p3.alert.title.proxy-warn': 'Reverse proxy needs review',
    'p3.alert.detail.proxy-warn': 'The proxy diagnostic contains at least one warning.',
    'p3.alert.title.image-disk-critical': 'Images storage almost full',
    'p3.alert.detail.image-disk-critical': '{pct}% used; only {free} available.',
    'p3.alert.title.image-disk-warning': 'Images storage needs attention',
    'p3.alert.detail.image-disk-warning': '{pct}% used; {free} available.',
    'p3.alert.title.duplicates': 'Duplicate images detected',
    'p3.alert.detail.duplicates': '{n} copy/copies in {groups} group(s) could free {space}.',
    'p3.alert.title.optimization': 'Image optimization available',
    'p3.alert.detail.optimization': 'WebP or AVIF conversion could save about {space}.',
    'p3.alert.title.image-reclaimable': 'Inactive images are reclaimable',
    'p3.alert.detail.image-reclaimable': 'Expired or inactive images use {space}.',
    'p3.alert.title.image-growth': 'Unusual Images storage growth',
    'p3.alert.detail.image-growth': 'Added storage increased by {pct}% versus the previous period.',
    'dash.kpiSpeed': 'Average speed',
    'dash.kpiDuration': 'Average duration',
    'dash.secPerf': 'Speed & performance',
    'dash.secLinks': 'Links & shares',
    'dash.secSecurity': 'Security',
    'dash.secOps': 'Storage & notifications',
    'dash.heatmap': 'Usage by weekday / hour',
    'dash.sizeDist': 'File-size distribution',
    'dash.sizeSmall': 'Small (< 10 MB)',
    'dash.sizeMedium': 'Medium (10 MB–1 GB)',
    'dash.sizeLarge': 'Large (≥ 1 GB)',
    'dash.topFiles': 'Top downloaded files',
    'dash.dlN': '{n} downloads',
    'dash.protection': 'Protected vs open',
    'dash.protected': 'Protected',
    'dash.open': 'Open',
    'dash.encryption': 'Encrypted vs plaintext',
    'dash.encrypted': 'Encrypted (E2E)',
    'dash.plain': 'Plaintext',
    'dash.expiring': 'Expiring soon (7 days)',
    'dash.expNone': 'Nothing to report.',
    'dash.twofa': '2FA adoption',
    'dash.twofaOn': 'With 2FA',
    'dash.twofaOff': 'Without 2FA',
    'dash.adminSec': 'Admin sign-in security',
    'dash.failedLogins': 'Failed logins',
    'dash.lockedIps': 'Locked IPs',
    'dash.lockedNow': 'Currently locked',
    'dash.lockAdmin': 'admin',
    'dash.lockLink': 'link',
    'dash.recentLogins': 'Recent admin logins',
    'dash.storage': 'Disk space (reception)',
    'dash.storUsed': '{v} used',
    'dash.storFree': '{v} free',
    'dash.storTotal': 'Total: {v}',
    'dash.storageNA': 'Disk space unavailable.',
    'dash.webhook': 'Webhook status',
    'dash.whNone': 'No webhook configured.',
    'dash.whIdle': 'Configured — no call yet.',
    'dash.whOk': 'Last call succeeded',
    'dash.whFail': 'Last call failed',
    'dash.downloads': 'Downloads',
    'dash.uploads': 'Uploads',
    'dash.direction': 'Downloads vs uploads',
    'dash.status': 'Completed vs interrupted',
    'dash.completed': 'Completed',
    'dash.interrupted': 'Interrupted',
    'dash.topLinks': 'Most used links (by volume)',
    'dash.topCountries': 'Top countries',
    'dash.topDownloaders': 'Top 5 clients (downloads)',
    'dash.topUploaders': 'Top 5 clients (uploads)',
    'dash.empty': 'No data yet.',
    'dash.dl': 'down',
    'dash.ul': 'up',
    'dash.transfersN': '{n} transfers',
    'update.available': '⬆ New version available: {v}',
    'menu.shutdown': '⏻ Shut down server',
    'menu.shutdownConfirm':
      'Shut down the server now? The interface will be unreachable until the container is restarted.',
    'menu.shutdownDone': 'Shutting down the server…',
    'menu.shutdownFail': 'Could not shut down',
    'net.title': 'Network',
    'net.testBtn': 'Test external access',
    'net.localIp': 'Local IP',
    'net.publicIp': 'Public IP',
    'net.linkBase': 'Link base',
    'net.extAccess': 'External access',
    'net.notTested': 'Not tested',
    'net.testing': 'Testing…',
    'net.accessible': 'Reachable ✓',
    'net.unreachable': 'Unreachable ✗',
    'net.undetermined': 'Undetermined',
    'net.error': 'Error',
    'net.notDetected': 'not detected',
    'net.domainLabel': 'Link domain',
    'net.domainPlaceholder': 'e.g. share.example.com',
    'net.sslTitle': 'Check if a reverse proxy (Nginx) serves the app over HTTPS',
    'net.save': 'Save',
    'net.reset': 'Reset',
    'net.auto': 'Auto',
    'net.autoTitle': 'Back to auto-detection',
    'net.domainHelp': 'Used to build share links. Leave empty for auto-detection.',
    'net.hintAccessible': '{label} is reachable from the Internet ({open}/{total} nodes).',
    'net.hintUnreachable':
      '{label} is not reachable. Check port forwarding (NAT), the reverse proxy and the system firewall.',
    'net.hintUndetermined': 'Test failed ({error}). Try again later.',
    'net.proxyHint': 'Reverse proxy detected: the access test targets {label}.',
    'net.domainSaved': 'Domain saved ✓',
    'net.autoRestored': 'Auto-detection restored',
    'net.domainInvalid': 'Invalid domain',
    'net.saveError': 'Could not save',
    'net.saveNoPersist':
      'Domain applied, but not saved to disk (data folder not writable — check the mount).',
    'net.unavailable': 'Network unavailable',
    'net.theDomain': 'the domain',
    'net.theTarget': 'the target',
    'proxy.testBtn': 'Test reverse proxy',
    'proxy.testing': 'Analyzing the request…',
    'proxy.error': 'Diagnostic failed.',
    'proxy.verdict.ok': 'Reverse proxy correctly configured',
    'proxy.verdict.warn': 'Reverse proxy: things to check',
    'proxy.verdict.bad': 'Reverse proxy misconfigured',
    'proxy.verdict.info': 'Reverse-proxy diagnostic',
    'proxy.trustProxy': 'TRUST_PROXY',
    'proxy.enabled': 'enabled',
    'proxy.disabled': 'disabled',
    'proxy.detected': 'Proxy detected',
    'proxy.yes': 'yes',
    'proxy.no': 'no',
    'proxy.clientIp': 'Resolved visitor IP',
    'proxy.remoteAddr': 'Immediate peer',
    'proxy.publicPeerTag': 'public IP',
    'proxy.protocol': 'Protocol seen by the app',
    'proxy.target': 'Tested domain',
    'proxy.host': 'Host',
    'proxy.headers': 'Forwarding headers received',
    'proxy.noHeaders': 'No X-Forwarded-* / proxy headers received on this request.',
    'proxy.msg.proxy-untrusted': 'Reverse-proxy headers are received but TRUST_PROXY is off: the app sees the proxy IP ({peer}), not the visitor’s. Enable TRUST_PROXY (e.g. TRUST_PROXY="1").',
    'proxy.msg.trust-no-headers': 'TRUST_PROXY is enabled but no X-Forwarded-* header was received: either there is no reverse proxy in front, or it doesn’t forward them. TRUST_PROXY on without a real proxy makes the visitor IP spoofable.',
    'proxy.msg.proxy-ok': 'Reverse proxy detected and trusted. Resolved visitor IP: {ip}.',
    'proxy.msg.direct': 'No reverse proxy detected: direct connection. Client IP: {ip}.',
    'proxy.msg.https-not-trusted': 'The proxy advertises HTTPS (X-Forwarded-Proto: https) but the app sees HTTP: “Secure” cookies won’t be set. Enable TRUST_PROXY so HTTPS is reflected.',
    'proxy.msg.https-ok': 'The proxy’s HTTPS is correctly propagated (X-Forwarded-Proto honored).',
    'proxy.msg.no-proto': 'The proxy doesn’t forward an X-Forwarded-Proto header: HTTPS can’t be detected. Add it (Nginx: proxy_set_header X-Forwarded-Proto $scheme;).',
    'proxy.msg.host-diff': 'Public host advertised by the proxy: {pub} (internal Host: {internal}).',
    'proxy.msg.public-peer': 'The request comes from a public IP ({ip}) while proxy headers are present: make sure only the proxy can reach the container and it isn’t exposed directly.',
    'proxy.msg.multi-hop': '{n} hops in X-Forwarded-For: {chain}. With several proxies, set TRUST_PROXY to the number of trusted hops.',
    'proxy.msg.buffering': 'For large uploads (reception links), disable request buffering and raise the proxy size/timeout limits — Nginx: client_max_body_size 0; proxy_request_buffering off; high proxy_read_timeout.',
    'shutdown.armed': 'Auto-shutdown armed: stops after the next download.',
    'shutdown.disarmed': 'Auto-shutdown disabled.',
    'settings.saveError': 'Could not save setting',
    'tr.title': 'Active transfers',
    'tr.none': 'No active transfers.',
    'tr.locating': 'locating…',
    'tr.localNetwork': 'Local network',
    'tr.remaining': 'left',
    'tr.zip': '.zip archive',
    'tr.zipTitle': 'Multiple files bundled into a single .zip archive',
    'sh.title': 'Active shares',
    'sh.new': '＋ New share',
    'sh.newInbox': '＋ Reception link',
    'sh.newCollab': '🔁 Collaboration link',
    'sh.secret': 'Secret note',
    'sh.clone': '⧉ Duplicate',
    'sh.cloneTitle': 'Duplicate this share with a new link and reset counters',
    'sh.cloneSuffix': '(copy)',
    'sh.clonePrompt': 'Name of the new share:',
    'sh.cloneBusy': 'Duplicating…',
    'sh.cloned': 'Share duplicated ✓',
    'sh.clonedAs': 'Share “{name}” duplicated ✓',
    'sh.cloneFail': 'Duplication failed',
    'sh.cloneUnsupported': 'This share type cannot be duplicated',
    'sh.cloneImageMissing': 'The source file for this image cannot be found',
    'sh.cloneInvalidName': 'The new share name is invalid',
    'sh.email': '✉ E-mail',
    'sh.emailTitle': 'E-mail this link',
    'sh.emailPrompt': 'Recipient e-mail for "{name}":',
    'sh.emailSent': 'E-mail sent to {to} ✓',
    'sh.emailInvalid': 'Invalid e-mail address',
    'sh.emailNotConfigured': 'SMTP not configured',
    'sh.emailFail': 'Send failed',
    'sh.fType': 'All types',
    'sh.fStatus': 'All statuses',
    'sh.fActive': 'Active',
    'sh.fInactive': 'Inactive',
    'sh.sortNew': 'Newest',
    'sh.sortOld': 'Oldest',
    'sh.sortName': 'Name A→Z',
    'sh.sortDl': 'Most active',
    'sh.sortExpiry': 'Expiring soon',
    'view.list': 'List view',
    'view.grid': 'Grid view',
    'keys.title': 'Keyboard shortcuts',
    'keys.new': 'New share',
    'keys.reception': 'New reception link',
    'keys.collab': 'New collaboration link',
    'keys.search': 'Focus the filter',
    'keys.help': 'Show this help',
    'keys.close': 'Close a dialog',
    'sh.filterPh': '🔍 Filter by name or tag…',
    'sh.noneFilter': 'No link matches the filter.',
    'sh.tagAdd': 'Tag',
    'sh.tagRemove': 'Remove tag',
    'sh.tagPrompt': 'Tag name:',
    'sh.tagFail': 'Failed to update tags',
    'sh.bulkCount': '{n} selected',
    'sh.bulkTag': '🏷 Tag',
    'sh.bulkExtend': '⏱ Extend',
    'sh.bulkRevoke': 'Revoke',
    'sh.bulkDone': '✓ {n} link(s) updated',
    'sh.bulkFail': 'Bulk action failed',
    'sh.bulkRevokeConfirm': 'Revoke {n} link(s)? Their URLs will stop working.',
    'sh.bulkExtendPrompt': 'New expiry from now, in days (0 = never):',
    'sh.bulkTagPrompt': 'Tag to add to the selected links:',
    'mod.enable': 'Review uploads before they are published',
    'mod.pending': '⏳ Awaiting moderation ({n})',
    'mod.approve': '✓ Approve',
    'mod.reject': '✕ Reject',
    'mod.approved': '✓ File approved',
    'mod.rejected': 'File rejected',
    'mod.rejectConfirm': 'Reject and permanently delete this file?',
    'mod.fail': 'Moderation failed',
    'sh.inbox': 'reception',
    'sh.collab': 'collaboration',
    'sh.canDelete': 'deletion allowed',
    'sh.activity': 'Activity:',
    'sh.deleteOn': 'Deletion allowed',
    'sh.deleteOff': 'Deletion disabled',
    'sh.received': 'Received:',
    'inbox.namePrompt': 'Reception link name (optional):',
    'inbox.created': 'Reception link created ✓',
    'inbox.createFail': 'Could not create the link',
    'collab.title': 'New collaboration link',
    'collab.intro': 'A two-way shared folder: visitors can download and upload. Files are stored in a new folder in your reception area.',
    'collab.namePh': 'e.g. Project workspace',
    'collab.allowDelete': 'Let visitors delete content',
    'collab.deleteNeedsPw': '⚠ Requires a password: deletion by visitors stays off unless the link is password-protected.',
    'collab.notePh': 'e.g. Drop your revisions here; download the latest brief.',
    'collab.created': 'Collaboration link created ✓',
    'collab.createFail': 'Could not create the link',
    'inbox.pwPrompt': 'Access password (optional):',
    'inbox.title': 'New reception link',
    'inbox.name': 'Name',
    'inbox.namePh': 'e.g. Client documents',
    'inbox.expiry': 'Expiration',
    'inbox.password': 'Password (optional)',
    'inbox.maxFiles': 'Max files',
    'inbox.maxFileSize': 'Max size / file (MB)',
    'inbox.maxTotalSize': 'Total quota (MB)',
    'inbox.allowExt': 'Allowed types (comma-separated, optional)',
    'inbox.blockExt': 'Blocked types (optional)',
    'inbox.extPh': 'e.g. pdf, jpg, png',
    'inbox.note': 'Message shown to senders (optional)',
    'inbox.groupSender': 'Sort uploads into per-sender subfolders',
    'inbox.notePh': 'e.g. Please send the signed contract as a PDF.',
    'inbox.create': 'Create link',
    'sh.noteLabel': 'Note:',
    'sh.msgsLabel': 'Messages received ({n}):',
    'sh.msgsMore': '+ {n} more',
    'sh.msgsClear': '🗑 Clear list',
    'sh.msgsClearConfirm': 'Clear the message list of "{name}"?\nThe files already received on disk are not deleted.',
    'sh.msgsCleared': 'List cleared ✓',
    'sh.msgsClearFail': 'Could not clear the list',
    'hi.exportCsv': '⬇ CSV',
    'hi.exportJson': '⬇ JSON',
    'hi.exportEmpty': 'No transfers to export.',
    'hi.exportFail': 'Export failed.',
    'sh.filtersLabel': 'Filters / quotas:',
    'sh.limPerFile': 'max {v}/file',
    'sh.limFiles': 'max {v} files',
    'sh.limQuota': 'quota {v}',
    'sh.limAllow': 'allowed: {v}',
    'sh.limBlock': 'blocked: {v}',
    'sh.usage': 'used {v}',
    'sh.statsLabel': 'Stats:',
    'stats.button': '📊 Stats',
    'stats.title': 'Detailed statistics',
    'stats.loading': 'Loading statistics…',
    'stats.fail': 'Could not load statistics.',
    'stats.overview': 'Overview',
    'stats.details': 'Share information',
    'stats.activity14': 'Activity over the last 14 days',
    'stats.recent': 'Recent activity',
    'stats.countries': 'Top countries',
    'stats.clients': 'Top clients',
    'stats.imageCopies': 'Image copies',
    'stats.imageRecent': 'Recent image access',
    'stats.live': 'Active transfers',
    'stats.transfers': 'Transfers',
    'stats.volume': 'Volume',
    'stats.success': 'Success',
    'stats.speed': 'Average speed',
    'stats.views': 'Views',
    'stats.visitors': 'Unique visitors',
    'stats.storage': 'Storage used',
    'stats.downloads': 'Downloads',
    'stats.completed': 'Completed',
    'stats.interrupted': 'Interrupted',
    'stats.averageSize': 'Average size',
    'stats.lastActivity': 'Last activity',
    'stats.firstActivity': 'First retained activity',
    'stats.status': 'Status',
    'stats.type': 'Type',
    'stats.owner': 'Owner',
    'stats.created': 'Created',
    'stats.expiry': 'Expires',
    'stats.items': 'Items',
    'stats.path': 'Path',
    'stats.url': 'Link',
    'stats.tags': 'Tags',
    'stats.none': 'No data available.',
    'stats.noRecent': 'No recent activity has been recorded.',
    'stats.noImageRecent': 'Detailed image access will be recorded from this version onward.',
    'stats.full': 'Full',
    'stats.thumb': 'Mini',
    'stats.micro': 'Micro',
    'stats.dimensions': 'Dimensions',
    'stats.lastView': 'Last view',
    'stats.active': 'Active',
    'stats.inactive': 'Inactive',
    'stats.paused': 'Paused',
    'stats.scheduled': 'Scheduled',
    'stats.unknown': 'Unknown',
    'stats.quota': 'Quota usage',
    'stats.files': 'Files',
    'sh.statCount': '{n} transfers · {v}',
    'sh.statOkKo': '{ok} ok / {ko} interrupted',
    'sh.statLast': 'last {v}',
    'sh.protected': '🔒 protected',
    'sh.qr': 'QR',
    'sh.qrTitle': 'Show the QR code',
    'qr.title': 'QR code',
    'pk.password': 'Password (optional)',
    'pk.passwordPh': 'none',
    'tr.stopTitle': 'Stop',
    'tr.stopConfirm': 'Stop this transfer?',
    'sh.shutdownLabel': 'Shut down the server after the next complete download',
    'sh.shutdownHelp': 'The container stops; the setting then disarms.',
    'sh.none': 'No shares. Click "＋ New share" to create one.',
    'sh.connLost': 'Server unreachable (maybe stopped after a download). Reconnecting…',
    'sh.folder': 'folder',
    'sh.file': 'file',
    'sh.inactive': 'inactive',
    'sh.sizeLabel': 'Size:',
    'sh.created': 'Created:',
    'sh.downloads': 'Downloads:',
    'sh.visitors': 'Visitors:',
    'sh.viewsTip': '{views} view(s) · {visitors} unique visitor(s)',
    'sh.expires': 'Expires:',
    'sh.scheduled': '🕒 scheduled',
    'sh.startsAt': 'Active from:',
    'pk.startsAt': 'Active from (optional)',
    'sh.link': 'Link',
    'sh.lan': 'LAN',
    'sh.open': 'Open',
    'sh.revoke': 'Revoke',
    'sh.copy': 'Copy',
    'sh.copied': 'Link copied ✓',
    'sh.copyFail': 'Copy failed, select the link manually',
    'sh.revokeConfirm': 'Revoke the share "{name}"?\nYou can restore it for 5 seconds.',
    'sh.revoked': 'Share revoked',
    'sh.revokeFail': 'Could not revoke',
    'sh.revokePending': 'Deleting in 5 seconds…',
    'sh.undoRevoke': 'Restore',
    'sh.recovered': 'Share restored',
    'sh.created2': 'Share created ✓',
    'sh.createFail': 'Could not create: {error}',
    'sh.loadFail': 'Could not load shares',
    'hi.title': 'History',
    'hi.subtitle': '(last 2,000 transfers)',
    'hi.none': 'No recent transfers.',
    'hi.noMatch': 'No transfers match the filters.',
    'hi.filter': '🔎 Filter',
    'hi.searchPh': 'Search by name, IP, country…',
    'hi.direction': 'Transfer direction',
    'hi.status': 'Transfer status',
    'hi.allDirections': 'All directions',
    'hi.downloads': 'Downloads',
    'hi.uploads': 'Uploads',
    'hi.allStatuses': 'All statuses',
    'hi.completedPlural': 'Completed',
    'hi.interruptedPlural': 'Interrupted',
    'hi.resetFilter': 'Clear',
    'hi.results': '{shown} of {total}',
    'hi.previous': 'Previous page',
    'hi.next': 'Next page',
    'hi.completed': 'completed',
    'hi.interrupted': 'interrupted',
    'hi.clear': '🗑 Purge',
    'hi.clearConfirm': 'Purge the whole transfer history?\nThe list and the exportable journal (CSV/JSON) will be erased. Per-link stats are kept.',
    'hi.cleared': 'History purged ✓',
    'hi.clearFail': 'Could not purge',
    'live.online': 'live',
    'live.offline': 'offline',
    'live.title': 'Auto-updating',
    'pk.title': 'Choose a file or folder',
    'pk.location': 'Location:',
    'pk.expiration': 'Expiration',
    'pk.never': 'Never',
    'pk.h1': '1 hour',
    'pk.d1': '1 day',
    'pk.d7': '7 days',
    'pk.d30': '30 days',
    'pk.maxDl': 'Max downloads',
    'pk.maxVisitors': 'Max unique visitors',
    'pk.rate': 'Max speed (KB/s)',
    'pk.allowZip': 'Allow "Download all (.zip)"',
    'pk.burn': 'One-time link (revoke after first download)',
    'pk.note': 'Message shown to the visitor (optional)',
    'pk.notePh': 'e.g. Here is the file you asked for.',
    'sh.speed': 'Speed: {v} KB/s',
    'sh.zipOff': '⛔ .zip disabled',
    'menu.about': 'ℹ️ About',
    'about.title': 'About',
    'about.author': 'Author:',
    'about.version': 'Version',
    'about.released': 'Latest version',
    'about.github': 'GitHub',
    'about.docker': 'Docker Hub',
    'about.discord': 'Discord',
    'pk.addTitle': 'Add files to “{name}”',
    'pk.addBtn': 'Add',
    'sh.addFiles': '➕ Add files',
    'sh.files': '{n} files',
    'sh.added': 'File added to the share',
    'sh.addFail': 'Could not add file: {error}',
    'sh.removeItem': 'Remove',
    'sh.reorder': 'Drag to reorder',
    'sh.reordered': 'Order saved',
    'sh.reorderFail': 'Could not reorder',
    'sh.renameTip': 'Double-click to rename',
    'sh.renamed': 'Link renamed',
    'sh.renameFail': 'Rename failed',
    'sh.summary': '{n} link(s) · {active} active · {size}',
    'sh.paused': 'paused',
    'sh.pause': '⏸ Pause',
    'sh.resume': '▶ Resume',
    'sh.pauseTitle': 'Pause (deactivate without deleting)',
    'sh.resumeTitle': 'Reactivate this link',
    'sh.paused2': 'Link paused',
    'sh.resumed': 'Link reactivated',
    'sh.pauseFail': 'Could not pause the link',
    'sh.noteBtn': '📝 Note',
    'sh.noteTitle': 'Private note (admin-only)',
    'sh.noteEditTip': 'Click to edit the note',
    'sh.notePh2': 'Private note for the admin…',
    'sh.noteSaved': 'Note saved',
    'sh.noteFail': 'Could not save the note',
    'sh.log': '🧾 Log',
    'sh.logTitle': 'This link’s access log',
    'sh.exportCsv': '⬇ List CSV',
    'sh.exportJson': '⬇ List JSON',
    'sh.dupWarn': 'This path is already shared by: {names}. Create another link anyway?',
    'log.title': 'Access log',
    'log.loading': 'Loading…',
    'log.fail': 'Could not load the log',
    'log.none': 'No recorded access for this link.',
    'log.ok': 'complete',
    'log.ko': 'interrupted',
    'pk.unitH': 'h',
    'pk.unitD': 'd',
    'pk.unitW': 'wk',
    'pk.unitMo': 'mo',
    'cfg.expiryPresets': 'Quick expiry presets',
    'cfg.expiryPresetsHint': 'Comma-separated durations offered in the link modals — e.g. 6h, 3d, 2w, 1mo. “Never” is always available.',
    'search.btn': '🔎 Search contents',
    'search.ph': '🔎 Search inside shared & received text files…',
    'search.run': 'Search',
    'search.searching': 'Searching…',
    'search.tooShort': 'Enter at least 2 characters.',
    'search.fail': 'Search failed',
    'search.count': '{n} file(s) · {scanned} scanned',
    'search.truncated': 'results truncated',
    'search.none': 'No results.',
    'photo.title': 'Images',
    'photo.add': '🖼 Add images',
    'img.netTitle': 'Image domain & external access',
    'img.domainLabel': 'Image domain (optional)',
    'img.domainPh': 'e.g. img.example.com',
    'img.domainHelp': 'Used for image links only. Leave empty to reuse the main link domain.',
    'img.hotlinkLabel': 'Hotlink protection (optional)',
    'img.hotlinkPh': 'e.g. example.com, forum.example.org',
    'img.hotlinkHelp': 'Comma-separated sites allowed to embed your images. Leave empty to allow any site. Direct visits and this server’s own pages are always allowed; subdomains of a listed host match too.',
    'img.hotlinkSaved': 'Hotlink protection saved.',
    'img.hotlinkCleared': 'Hotlink protection disabled.',
    'img.domainSaved': 'Image domain saved ✓',
    'img.autoRestored': 'Image domain reset (same as main)',
    'photo.intro': 'Direct image links: each photo gets Full, Mini, and Micro URLs that open the image itself, with no page around it — ready to embed or hotlink.',
    'photo.none': 'No photos shared yet.',
    'photo.pickTitle': 'Choose images',
    'photo.pickBtn': 'Create links',
    'photo.createFail': 'Could not create',
    'photo.created': '{n} image(s) added',
    'photo.skipped': '{n} skipped (not images)',
    'photo.copyFailed': 'Could not copy {n} image(s) — check the Images folder',
    'photo.full': 'Full',
    'photo.thumb': 'Thumb',
    'photo.micro': 'Micro',
    'photo.bbcode': 'BBCode',
    'photo.md': 'MD',
    'photo.html': 'HTML',
    'photo.renameHint': 'Double-click to rename',
    'photo.editExpiry': 'Change expiry',
    'photo.noExpiry': 'No expiry',
    'photo.expiryUpdated': 'Expiry updated ✓',
    'photo.expiryFail': 'Could not update the expiry',
    'photo.searchPh': 'Search images…',
    'photo.sortTitle': 'Sort',
    'photo.sortNew': 'Newest',
    'photo.sortOld': 'Oldest',
    'photo.sortName': 'Name',
    'photo.sortViews': 'Most viewed',
    'photo.sortSize': 'Largest',
    'photo.sortDimensions': 'Largest dimensions',
    'photo.filters': 'Image filters',
    'photo.filterFormat': 'Filter by format',
    'photo.allFormats': 'All formats',
    'photo.filterOrientation': 'Filter by orientation',
    'photo.allOrientations': 'All orientations',
    'photo.landscape': 'Landscape',
    'photo.portrait': 'Portrait',
    'photo.square': 'Square',
    'photo.filterVariants': 'Filter by variants',
    'photo.allVariants': 'All variants',
    'photo.variantsReady': 'Mini + Micro ready',
    'photo.variantsMissing': 'Variant missing',
    'photo.filterAlbum': 'Filter by gallery',
    'photo.allAlbums': 'All galleries',
    'photo.noAlbum': 'No gallery',
    'photo.favoritesOnly': '☆ Favorites',
    'photo.filterReset': 'Reset filters',
    'photo.favorite': 'Add to favorites',
    'photo.unfavorite': 'Remove from favorites',
    'photo.rename': '✎ Rename',
    'photo.createdAt': 'Added on {date}',
    'photo.ratio': 'ratio {ratio}',
    'photo.exportCsv': '⇩ CSV',
    'photo.exportJson': '⇩ JSON',
    'photo.copyAll': '🔗 Copy all',
    'photo.copyAllTitle': 'Copy every visible full-size link (one per line)',
    'photo.lbOpen': 'Open ↗',
    'album.create': '🖼 Create gallery',
    'album.title': 'Galleries',
    'album.hint': 'Public image galleries created from selected images. Anyone with the link can view them.',
    'album.count': '{n} images',
    'album.views': '{n} views',
    'album.untitled': 'Gallery',
    'album.namePrompt': 'Gallery name:',
    'album.created': 'Gallery created.',
    'album.createFail': 'Could not create the gallery.',
    'photo.dropHint': 'Drag & drop images here, paste (Ctrl+V), or click to browse — a direct link is created for each.',
    'photo.uploaded': '{n} image(s) added ✓',
    'photo.uploadProgress': 'Upload {done}/{total}',
    'photo.uploadSummary': '{ok} added, {failed} failed, {skipped} skipped',
    'photo.uploadFail': 'Upload failed',
    'photo.selectHint': 'Select for bulk actions',
    'photo.selectedN': '{n} selected',
    'photo.bulkExpiry': 'Set expiry…',
    'photo.bulkExpiryTitle': 'Set expiry for the selected images',
    'photo.bulkAlbum': 'Add to gallery…',
    'photo.bulkAlbumTitle': 'Add selected images to an existing gallery',
    'photo.bulkAlbumDone': '{n} image(s) added to the gallery',
    'photo.bulkFavorite': '★ Add to favorites',
    'photo.bulkUnfavorite': '☆ Remove from favorites',
    'photo.bulkDownload': '⇩ ZIP',
    'photo.bulkRevoke': '🗑 Revoke',
    'photo.bulkClear': 'Clear',
    'photo.gallery': 'Image gallery',
    'photo.history': 'History',
    'photo.historyHint': 'The last 50 revoked images are kept here.',
    'photo.historyEmpty': 'No revoked images.',
    'photo.revokedAt': 'Revoked on {date}',
    'photo.histFull': 'full {size}',
    'photo.histKept': 'kept {size}',
    'photo.previewUnavailable': 'Preview unavailable',
    'photo.historyDelete': 'Remove from history',
    'photo.historyDeleteConfirm': 'Permanently remove “{name}” from history?',
    'photo.historyDeleted': 'History item removed ✓',
    'photo.historyDeleteFail': 'Could not remove history item',
    'photo.purge': '🗑 Purge',
    'photo.purgeConfirm': 'Permanently purge the revoked-image history?',
    'photo.purged': 'Image history purged ✓',
    'photo.purgeFail': 'Could not purge',
    'sh.itemRemoved': 'Item removed',
    'sh.removeItemFail': 'Could not remove: {error}',
    'pk.unlimited': 'unlimited',
    'pk.selection': 'Selection:',
    'pk.cancel': 'Cancel',
    'pk.share': 'Share',
    'pk.folderSuffix': '  (folder)',
    'pk.selectedN': '{n} items selected',
    'pk.multiHint': 'Tip: click several items to share them together (even across different folders).',
    'pk.fileSuffix': '  (file)',
    'pk.parent': '.. (parent folder)',
    'pk.emptyFolder': 'Empty folder',
    'pk.open': 'open ›',
    'pk.navFail': 'Navigation failed',
    'pk.hostInaccessible': 'Host filesystem inaccessible (mount /:/host:ro).',
    'pk.preview': '👁 Preview',
    'pk.previewUnsupported': 'This format can’t be previewed in your browser — the codec isn’t supported.',
    'pw.title': 'Change password',
    'pw.firstTitle': 'Set your password',
    'pw.firstLoginHint': 'For security, choose a new password before continuing.',
    'pw.current': 'Current password',
    'pw.new': 'New password (8 chars min.)',
    'pw.confirm': 'Confirm the new password',
    'pw.tooShort': 'The new password must be at least 8 characters.',
    'pw.mismatch': 'The confirmation does not match.',
    'pw.changed': 'Password changed ✓',
    'pw.changedEnv':
      'Password changed (current session only: ADMIN_PASSWORD is set via environment variable).',
    'pw.changedTemp':
      'Password changed for this session, but saving to disk failed (check the data folder permissions).',
    'pw.currentWrong': 'Current password is incorrect.',
    'pw.changeFail': 'Could not change.',
    'time.s': 's',
    'time.min': 'min',
    'time.h': 'h',
    'time.d': 'd',
    'time.ago': '{v} ago',
    'units.bytes': ['B', 'KB', 'MB', 'GB', 'TB'],
  },

  es: {
    // --- Client nicknames by IP (added) ---
    'ipn.prompt': 'Apodo para {ip}:',
    'ipn.clickHint': 'Clic para renombrar este cliente',
    'ipn.saved': 'Apodo guardado ✓',
    'ipn.cleared': 'Apodo eliminado',
    'ipn.fail': 'No se pudo guardar',
    'auditA.ip-named': 'Cliente renombrado',
    'auditA.ip-unnamed': 'Apodo de cliente eliminado',
    // --- Nominative sub-links (added) ---
    'rcp.label': 'Sub-enlaces nominativos ({n}):',
    'rcp.dl': '{n} desc.',
    'rcp.add': 'Añadir',
    'rcp.addPh': 'Nombre(s) — separados por coma',
    'rcp.remove': 'Eliminar este sub-enlace',
    'rcp.limitsTitle': 'Límites por destinatario',
    'rcp.maxDlPrompt': 'Descargas máximas para «{name}» (vacío = ilimitado):',
    'rcp.expiryPrompt': 'Caducidad para «{name}» en días (vacío = nunca):',
    'rcp.limitsSaved': 'Límites del destinatario guardados',
    'rcp.limitsFail': 'No se pudo guardar',
    'acc.title': 'Reglas de acceso (geo / IP)',
    'acc.geoMode': 'Países',
    'acc.off': 'Sin restricción',
    'acc.allowOnly': 'Permitir solo',
    'acc.deny': 'Bloquear',
    'acc.countries': 'Códigos de país (ISO, separados por comas)',
    'acc.ipMode': 'Direcciones IP',
    'acc.ips': 'IP / CIDR (separados por comas)',
    'acc.hint': 'El bucle local siempre se permite. Las reglas por país requieren geolocalización IP; los visitantes cuyo país no se puede determinar se permiten (las reglas IP son la barrera estricta).',
    'rcp.removeConfirm': '¿Eliminar el sub-enlace de «{name}»?\nSu enlace dejará de funcionar.',
    'rcp.added': 'Sub-enlace(s) creado(s) ✓',
    'rcp.addFail': 'No se pudo añadir',
    'rcp.exists': 'Ese destinatario ya existe',
    'rcp.removed': 'Sub-enlace eliminado',
    'rcp.removeFail': 'No se pudo eliminar',
    'auditA.recipients-added': 'Sub-enlaces añadidos',
    'auditA.recipient-removed': 'Sub-enlace eliminado',
    'dec.noCrypto': '⚠ El descifrado requiere un contexto seguro (HTTPS o localhost); no disponible con HTTP sin cifrar.',
    // --- Decrypt received .dxe (added) ---
    'menu.decrypt': '🔓 Descifrar un archivo .dxe',
    'dec.title': 'Descifrar un archivo .dxe',
    'dec.intro': 'Elige un archivo .dxe recibido mediante un enlace cifrado. Se descifra aquí, en tu navegador.',
    'dec.file': 'Archivo cifrado (.dxe)',
    'dec.key': 'Clave de descifrado o enlace completo',
    'dec.keyPh': '…#k=… o la clave',
    'dec.passphrase': 'Frase de cifrado',
    'dec.go': 'Descifrar',
    'dec.decrypting': 'Descifrando…',
    'dec.notDxe': 'Archivo .dxe no válido o ilegible.',
    'dec.needKey': 'Indica la clave (o el enlace que contiene #k=).',
    'dec.needPass': 'Introduce la frase de cifrado.',
    'dec.badKey': 'Fallo al descifrar: clave o frase incorrecta, o archivo dañado.',
    'dec.done': 'Archivo descifrado ✓',
    // --- End-to-end encryption (added) ---
    'enc.newShare': '🔒 Compartir cifrado',
    'secret.new': '🔑 Nota secreta',
    'secret.title': 'Nueva nota secreta',
    'secret.intro': 'Comparte una contraseña, clave o mensaje corto. Se cifra de extremo a extremo en tu navegador y se destruye la primera vez que se lee.',
    'secret.text': 'Secreto',
    'secret.textPh': 'ej. la contraseña del Wi-Fi…',
    'secret.passLabel': 'Frase de contraseña',
    'secret.passPh': 'compártela por separado',
    'secret.create': 'Crear secreto',
    'secret.created': '✓ Secreto creado',
    'secret.createFail': '✗ No se pudo crear el secreto',
    'secret.needText': 'Escribe el secreto a compartir.',
    'secret.noteKey': '⚠ La clave está en el enlace (después de #). Funciona solo una vez: el secreto se destruye al abrirlo.',
    'secret.notePass': '⚠ Comparte la frase de contraseña por separado. El enlace funciona solo una vez: el secreto se destruye al abrirlo.',
    'enc.title': 'Nuevo recurso cifrado',
    'enc.file': 'Archivo a cifrar',
    'enc.label': 'Etiqueta (mostrada en la página)',
    'enc.labelPh': 'ej. Contrato.pdf',
    'enc.mode': 'Modo de cifrado',
    'enc.modeKey': 'Clave en el enlace',
    'enc.modePass': 'Frase de cifrado',
    'enc.passphrase': 'Frase de cifrado',
    'enc.expiry': 'Expiración',
    'enc.maxDl': 'Descargas máx.',
    'enc.create': 'Crear',
    'enc.encrypting': 'Cifrando…',
    'enc.uploading': 'Subiendo…',
    'enc.created': 'Recurso cifrado creado ✓',
    'enc.createFail': 'No se pudo crear el recurso cifrado',
    'enc.needFile': 'Elige un archivo primero.',
    'enc.needPass': 'Introduce una frase de cifrado.',
    'enc.linkTitle': 'Enlace cifrado listo',
    'enc.copy': 'Copiar enlace',
    'enc.done': 'Hecho',
    'enc.noteKey': '⚠ La clave solo está en este enlace y no se puede recuperar. Cópialo ahora.',
    'enc.notePass': 'Comparte la frase de cifrado con el destinatario por un canal aparte.',
    'enc.inboxEncrypt': 'Cifrar de extremo a extremo los archivos recibidos',
    'enc.inboxLinkNote': '⚠ Comparte este enlace completo: la clave que contiene no se puede recuperar.',
    'app.name': 'Direct-Xfer',
    'app.docTitle': 'Direct-Xfer — Administración',
    'login.subtitle': 'Área de administración',
    'setup.warnTitle': '⚠ Almacenamiento sin configurar',
    'setup.inbox': 'La carpeta de recepción «/Direct-Xfer» sigue con su valor por defecto (/PATH/TO/CONFIGURE): no apunta a una carpeta real del host.',
    'setup.images': 'La carpeta de imágenes «/Images» sigue con su valor por defecto (/PATH/TO/CONFIGURE): no apunta a una carpeta real del host.',
    'setup.hint': 'Configura los volúmenes en docker-compose.yml (reemplaza /PATH/TO/CONFIGURE).',
    'pwa.openApp': '📱 App de envío móvil',
    'login.password': 'Contraseña',
    'login.submit': 'Iniciar sesión',
    'login.invalid': 'Usuario o contraseña no válidos.',
    'login.hint.env-owner': 'La contraseña del propietario se define mediante ADMIN_PASSWORD: inicia sesión con el usuario admin configurado (por defecto «admin») y ese valor exacto, sin comillas ni espacios alrededor.',
    'login.hint.no-persist': '/data no admite escritura: las cuentas y los cambios de contraseña no sobreviven a un reinicio. Solo funciona el inicio de sesión del propietario mediante ADMIN_PASSWORD.',
    'login.tooMany': 'Demasiados intentos. Inténtalo de nuevo en {s} s.',
    'login.connError': 'Error de conexión con el servidor.',
    'login.totp': 'Código 2FA',
    'login.totpHint': 'Introduce el código de 6 dígitos de tu aplicación (o un código de recuperación).',
    'login.totpInvalid': 'Código 2FA no válido.',
    'login.username': 'Usuario',
    'pw.envManaged': 'Contraseña gestionada por ADMIN_PASSWORD: cámbiala mediante la variable de entorno.',
    'menu.signedInAs': 'Conectado como',
    'menu.accounts': '👥 Cuentas admin',
    'menu.audit': '📋 Registro de auditoría',
    'menu.config': '⚙ Configuración',
    'cfg.title': 'Configuración',
    'cfg.security': 'Seguridad',
    'cfg.idleEnable': 'Bloquear tras inactividad',
    'cfg.idleMins': 'Tiempo de inactividad (minutos)',
    'cfg.idleHint': 'Bloquea la interfaz de administración (requiere volver a iniciar sesión) tras este tiempo sin actividad de ratón o teclado.',
    'cfg.locked': '🔒 Sesión bloqueada por inactividad. Vuelve a iniciar sesión.',
    'cfg.saved': 'Configuración guardada ✓',
    'cfg.savedTemp': 'Configuración aplicada pero no guardada en disco (carpeta data no escribible).',
    'cfg.saveFail': 'No se pudo guardar.',
    'cfg.notif': 'Notificaciones (webhook)',
    'cfg.webhookEnv': 'Gestionado por la variable de entorno WEBHOOK_URL.',
    'cfg.webhookUrl': 'URL del webhook',
    'cfg.webhookFormat': 'Formato',
    'cfg.webhookAuto': 'Detección automática',
    'cfg.notifyDownloads': 'Descargas',
    'cfg.notifyUploads': 'Recepciones',
    'cfg.notifyMessages': 'Mensajes',
    'cfg.webhookTest': 'Probar',
    'cfg.webpush': 'Notificaciones del navegador (Web Push)',
    'cfg.webpushHint': 'Recibe notificaciones push en este navegador para los eventos marcados arriba, incluso con la página de administración cerrada. Cada navegador/dispositivo se suscribe por separado.',
    'cfg.webpushUnavail': 'Web Push no disponible: el módulo web-push no está instalado en el servidor.',
    'cfg.webpushInsecure': 'Requiere un contexto seguro (HTTPS o localhost). Activa TLS para usar las notificaciones push.',
    'cfg.webpushNoSupport': 'Este navegador no admite Web Push.',
    'cfg.webpushEnable': 'Activar en este navegador',
    'cfg.webpushDisable': 'Desactivar en este navegador',
    'cfg.webpushTest': 'Enviar prueba',
    'cfg.webpushOn': 'Activado en este navegador ✓',
    'cfg.webpushDenied': 'Notificaciones bloqueadas por el navegador.',
    'cfg.webpushSubscribed': 'Notificaciones activadas ✓',
    'cfg.webpushUnsubscribed': 'Notificaciones desactivadas',
    'cfg.webpushTestSent': 'Prueba enviada ✓',
    'cfg.webpushNoSub': 'Ningún navegador suscrito.',
    'cfg.webpushFail': 'Falló la operación de Web Push.',
    'cfg.webhookTesting': 'Probando…',
    'cfg.webhookOk': '✓ Llamada correcta',
    'cfg.webhookFail': '✗ Llamada fallida',
    'cfg.webhookNoUrl': 'Sin URL de webhook.',
    'cfg.webhookInvalid': 'URL de webhook no válida (http/https).',
    'cfg.defaults': 'Valores por defecto de los nuevos enlaces',
    'cfg.privacy': 'Privacidad',
    'cfg.geoLookup': 'Geolocalizar las IP de los visitantes',
    'cfg.geoHint': 'Desactivado = sin llamadas externas; no se mostrará el país de los visitantes.',
    'cfg.maxAttempts': 'Intentos de acceso máx.',
    'cfg.lockoutMins': 'Bloqueo (minutos)',
    'cfg.sessionHours': 'Duración de sesión (horas)',
    'cfg.sessionDefault': 'predet.',
    'cfg.tokenBytes': 'Longitud de los tokens de enlace (bytes)',
    'cfg.httpsWarn': 'Avisar si el admin se sirve por HTTP sin cifrar',
    'cfg.httpsBanner': '⚠ Panel de administración por HTTP sin cifrar: tus credenciales viajan sin protección. Usa HTTPS.',
    'cfg.allowPreview': 'Permitir vista previa en el navegador',
    'cfg.reqPassword': 'Exigir una contraseña por defecto',
    'cfg.startDelay': 'Activación diferida (horas, 0 = inmediata)',
    'cfg.defaultDir': 'Carpeta predeterminada del selector',
    'cfg.defaultDirPh': 'vacío = última carpeta usada',
    'cfg.defaultDirBrowse': 'Explorar…',
    'cfg.defaultDirHint': 'El selector de archivos «Nuevo enlace» se abre aquí. Déjalo vacío para reutilizar la última carpeta explorada.',
    'pk.chooseDir': 'Elegir la carpeta predeterminada',
    'pk.chooseDirBtn': 'Elegir esta carpeta',
    'cfg.recDefaults': 'Valores por defecto de los enlaces de recepción',
    'cfg.allowExt': 'Tipos permitidos (separados por comas)',
    'cfg.blockExt': 'Tipos bloqueados (separados por comas)',
    'cfg.encrypt': 'Activar cifrado de extremo a extremo por defecto',
    'cfg.limits': 'Límites globales',
    'cfg.globalRate': 'Límite de velocidad del servidor (KB/s)',
    'cfg.globalRateHint': 'Límite aplicado a cada descarga, además de los límites por enlace.',
    'cfg.schedEnable': 'Limitar el ancho de banda en una franja horaria',
    'cfg.schedRate': 'Límite durante la franja (KB/s)',
    'cfg.schedStart': 'Desde',
    'cfg.schedEnd': 'Hasta',
    'cfg.schedHint': 'Hora local del servidor. La franja puede cruzar la medianoche (p. ej. 08:00 → 02:00). Fuera de ella solo se aplican los límites anteriores.',
    'cfg.antiabuse': 'Protección de descargas públicas',
    'cfg.prlEnable': 'Limitar la tasa de descargas por IP de visitante',
    'cfg.prlMax': 'Solicitudes máx.',
    'cfg.prlWindow': 'Por ventana (minutos)',
    'cfg.chalEnable': 'Exigir un desafío antes de descargas grandes',
    'cfg.chalMin': 'Se activa por encima de (MB)',
    'cfg.chalBits': 'Dificultad (8–24)',
    'cfg.chalHint': 'Una prueba de trabajo autoalojada, resuelta en el navegador del visitante (sin terceros). Disuade el scraping masivo de un enlace filtrado; a mayor dificultad, más esfuerzo por descarga.',
    'cfg.leakEnable': 'Avisar cuando un enlace se descarga desde muchos países',
    'cfg.leakCountries': 'Países distintos',
    'cfg.leakWindow': 'En (horas)',
    'cfg.leakHint': 'Envía una notificación (por el webhook / correo de arriba) cuando un mismo enlace se descarga desde al menos esta cantidad de países en la ventana — posible señal de filtración. Requiere geolocalización de IP activada.',
    'cfg.auditJson': 'Exportar registro de auditoría (JSON)',
    'cfg.auditCsv': 'Exportar registro de auditoría (CSV)',
    'cfg.auditHint': 'El registro de acciones de administración (accesos, creación/revocación de enlaces, cambios de ajustes, alertas).',
    'cfg.bkTitle': 'Copia de seguridad completa programada',
    'cfg.bkIntro': 'Una copia completa agrupa todo el almacén (enlaces + ajustes), el registro de transferencias y las notas secretas en un solo archivo — cifrado con DATA_KEY si está definido. Enviado a una carpeta, WebDAV o S3.',
    'cfg.bkEnable': 'Ejecutar una copia programada automáticamente',
    'cfg.bkInterval': 'Frecuencia',
    'cfg.bkDaily': 'Diaria',
    'cfg.bkWeekly': 'Semanal',
    'cfg.bkHour': 'A la hora (0–23)',
    'cfg.bkWeekday': 'Día de la semana',
    'cfg.dow0': 'Domingo', 'cfg.dow1': 'Lunes', 'cfg.dow2': 'Martes', 'cfg.dow3': 'Miércoles', 'cfg.dow4': 'Jueves', 'cfg.dow5': 'Viernes', 'cfg.dow6': 'Sábado',
    'cfg.bkDest': 'Destino',
    'cfg.bkDestLocal': 'Carpeta local (montada)',
    'cfg.bkDestWebdav': 'WebDAV',
    'cfg.bkDestS3': 'Compatible con S3',
    'cfg.bkLocalDir': 'Ruta de la carpeta de copias',
    'cfg.bkLocalHint': 'Monta una carpeta del host con permisos de escritura en el contenedor (p. ej. /backups) para que las copias sobrevivan a una recreación del contenedor.',
    'cfg.bkWebdavUrl': 'URL de la colección WebDAV',
    'cfg.bkUser': 'Usuario',
    'cfg.bkPass': 'Contraseña',
    'cfg.bkS3Endpoint': 'URL del endpoint',
    'cfg.bkS3Bucket': 'Bucket',
    'cfg.bkS3Region': 'Región',
    'cfg.bkS3Prefix': 'Prefijo de clave',
    'cfg.bkS3Key': 'Access key ID',
    'cfg.bkS3Secret': 'Secret access key',
    'cfg.bkRetention': 'Conservar las últimas N copias (0 = todas — solo local)',
    'cfg.bkEncWarn': '⚠ DATA_KEY no está definido: las copias se guardan EN TEXTO PLANO (contienen hashes de contraseñas y notas secretas). Define DATA_KEY para cifrarlas.',
    'cfg.bkNow': 'Copiar ahora',
    'cfg.bkTest': 'Probar destino',
    'cfg.bkDownload': 'Descargar copia',
    'cfg.bkRestore': 'Restaurar desde archivo…',
    'cfg.bkSaveHint': 'Guarda tus ajustes antes de Copiar ahora / Probar. La restauración reemplaza todo y no se puede deshacer.',
    'cfg.bkNever': 'Aún no se ha hecho ninguna copia.',
    'cfg.bkLastOk': 'Última copia: {when} → {dest} ✓',
    'cfg.bkLastFail': 'Última copia fallida: {when} — {err}',
    'cfg.bkRunning': 'Realizando copia…',
    'cfg.bkDone': 'Copia realizada ✓',
    'cfg.bkFail': 'Copia fallida',
    'cfg.bkTesting': 'Probando…',
    'cfg.bkTestOk': 'Destino accesible ✓',
    'cfg.bkTestFail': 'Prueba fallida',
    'cfg.bkRestoreConfirm': 'Restaurar una copia REEMPLAZA todos los enlaces, ajustes, registro y notas secretas actuales. No se puede deshacer. ¿Continuar?',
    'cfg.bkRestoring': 'Restaurando…',
    'cfg.bkRestoreOk': 'Restaurado ({n} enlace(s)). Recargando…',
    'cfg.bkRestoreFail': 'Restauración fallida',
    'cfg.logo': 'Logotipo personalizado',
    'cfg.logoPick': 'Elegir imagen…',
    'cfg.logoClear': 'Quitar',
    'cfg.logoHint': 'Se muestra en la barra superior de las páginas públicas. PNG/JPG/GIF/WebP/SVG, hasta ~200 KB.',
    'cfg.logoTooLarge': 'Imagen no válida o demasiado grande (máx. ~200 KB).',
    'cfg.legal': 'Aviso de confidencialidad',
    'cfg.legalPh': 'p. ej. Confidencial — no redistribuir',
    'cfg.legalHint': 'Se muestra como banner en cada página pública de descarga / recepción.',
    'cfg.watermark': 'Marca de agua en vistas previas de imagen y vídeo',
    'cfg.watermarkHint': 'Superpone la IP del visitante (o el nombre del destinatario en enlaces nominativos) sobre las vistas previas — disuade de recompartir capturas.',
    'cfg.retention': 'Retención del historial (días, 0 = conservar todo)',
    'cfg.logRetention': 'Retención del registro de transferencias (días, 0 = conservar todo)',
    'cfg.inboxRetention': 'Eliminar archivos recibidos después de (días, 0 = nunca)',
    'cfg.inboxRetentionHint': '⚠ Destructivo: elimina PERMANENTEMENTE los archivos de recepción y colaboración más antiguos que este plazo — los archivos perdidos no se pueden recuperar. Desactivado por defecto (0).',
    'cfg.inboxRetentionConfirm': '⚠ Los archivos recibidos con más de {n} día(s) se eliminarán PERMANENTE y automáticamente, sin posibilidad de recuperación. ¿Confirmar?',
    'cfg.require2fa': 'Exigir doble factor a todas las cuentas admin',
    'cfg.adminAllowlist': 'Lista blanca de IP admin (IP/CIDR, separadas por comas)',
    'cfg.allowlistEnv': 'Gestionado por la variable de entorno ADMIN_ALLOWED_IPS.',
    'cfg.allowlistHint': 'Vacío = por defecto (red local). El loopback siempre está permitido. Una entrada incorrecta puede dejarte fuera.',
    'cfg.allowlistConfirm': '¿Restringir el acceso admin a estas IP? Un error puede impedirte acceder a la administración (solo el loopback seguirá permitido).',
    'cfg.qrDefault': 'Mostrar el código QR justo después de crear un enlace',
    'cfg.maxUpload': 'Tamaño máx. / archivo recibido (MB)',
    'cfg.maxZip': 'Tamaño máx. de un .zip de carpeta (MB)',
    'cfg.maintenance': 'Mantenimiento',
    'cfg.updateCheck': 'Buscar actualizaciones al iniciar',
    'cfg.updateCheckHint': 'Compara la versión en ejecución con la última etiqueta publicada de la imagen. No se envía nada más allá de la consulta de versión.',
    'cfg.tfaRequired': 'Se requiere doble factor: configúralo ahora.',
    'cfg.anonIps': 'Anonimizar las IP de los visitantes (ocultar el final)',
    'cfg.keepNames': 'Conservar los apodos de clientes',
    'cfg.clearNames': 'Borrar todos los apodos',
    'cfg.cleared': '{n} apodo(s) borrado(s)',
    'cfg.interface': 'Interfaz',
    'cfg.brandName': 'Nombre de la aplicación',
    'cfg.brandPh': 'Direct-Xfer',
    'cfg.accentOn': 'Color de acento personalizado',
    'cfg.publicTheme': 'Tema de las páginas públicas',
    'cfg.themeAuto': 'Auto (según el dispositivo)',
    'cfg.themeDark': 'Oscuro',
    'cfg.themeLight': 'Claro',
    'cfg.themeColor': 'Color del navegador móvil',
    'cfg.themeColorHint': 'Tiñe la barra del navegador móvil en las páginas públicas (meta theme-color).',
    'cfg.adminLang': 'Idioma del admin',
    'cfg.publicLang': 'Idioma de las páginas públicas',
    'cfg.langAuto': 'Navegador',
    'cfg.banner': 'Banner de recepción por defecto',
    'cfg.bannerPh': 'Mostrado a los visitantes en cada nuevo enlace de recepción',
    'cfg.backup': 'Copia de seguridad y restauración',
    'cfg.export': 'Exportar configuración',
    'cfg.import': 'Importar configuración',
    'cfg.imported': '✓ {n} ajuste(s) importado(s)',
    'cfg.importFail': '✗ Archivo no válido',
    'cfg.notifyExpiring': 'Avisar antes de que expire un enlace',
    'cfg.expiryWarnHours': 'Antelación del aviso (horas antes de expirar)',
    'cfg.digestEnable': 'Enviar un resumen de actividad periódico',
    'cfg.notifySecurity': 'Avisar sobre eventos de seguridad (acceso, bloqueo, cambio de ajustes…)',
    'cfg.digestDays': 'Intervalo del resumen (días)',
    'cfg.digestNow': 'Enviar resumen ahora',
    'cfg.digestHint': 'Ambos avisos usan el webhook de arriba. Guarde los cambios antes de probar.',
    'cfg.digestSent': '✓ Resumen enviado',
    'cfg.noChannel': '✗ Ningún canal configurado (webhook o correo)',
    'cfg.burnDefault': 'Enlaces de un solo uso por defecto (revocados tras la 1.ª descarga)',
    'cfg.email': 'Notificaciones por correo (SMTP)',
    'cfg.emailEnv': 'Gestionado por la variable de entorno SMTP_URL.',
    'cfg.emailUnavail': 'El módulo nodemailer no está disponible; el correo está desactivado.',
    'cfg.emailEnable': 'Enviar también las notificaciones por correo',
    'cfg.smtpHost': 'Servidor SMTP',
    'cfg.smtpPort': 'Puerto',
    'cfg.smtpSecure': 'TLS implícito (puerto 465)',
    'cfg.smtpUser': 'Usuario',
    'cfg.smtpPass': 'Contraseña',
    'cfg.smtpFrom': 'Dirección del remitente',
    'cfg.smtpTo': 'Destinatario(s)',
    'cfg.emailTest': 'Enviar correo de prueba',
    'cfg.emailTesting': 'Enviando…',
    'cfg.emailOk': '✓ Correo enviado',
    'cfg.emailFail': '✗ Error al enviar',
    'cfg.emailNotConfigured': '✗ SMTP no configurado',
    'ed.title': 'Editar enlace',
    'ed.editing': 'Editando:',
    'ed.rename': 'Nombre',
    'ed.keep': 'No cambiar',
    'ed.password': 'Contraseña',
    'ed.pwPh': 'dejar en blanco para conservar',
    'ed.pwSet': '•••••• (definida — escriba para reemplazar)',
    'ed.clearPw': 'Quitar la contraseña',
    'ed.saved': '✓ Enlace actualizado',
    'ed.saveFail': '✗ Error: {error}',
    'sh.edit': 'Editar',
    'sh.oneTime': 'Un solo uso',
    'sh.burned': 'Consumido',
    'rcp.viewed': 'Visto',
    'rcp.notSeen': 'No visto',
    'rcp.downloaded': 'Descargado',
    'cfg.sharesExport': 'Exportar enlaces',
    'cfg.sharesImport': 'Importar enlaces',
    'cfg.sharesBackupHint': 'Exporta los ajustes de cada enlace (rutas, cuotas, expiraciones, contraseñas) — no los archivos. Útil para migrar los enlaces a otro servidor.',
    'cfg.sharesImportConfirm': '¿Importar estos enlaces? Se añadirán a los existentes.',
    'cfg.sharesImported': '✓ {n} enlace(s) importado(s), {s} omitido(s)',
    'cfg.encOn': '🔒 Cifrado en reposo de los metadatos: activado (DATA_KEY).',
    'cfg.encOff': 'Cifrado en reposo de los metadatos: desactivado. Defina la variable DATA_KEY para activarlo.',
    'cfg.pwRequired': 'Se requiere una contraseña para este enlace.',
    'acc.title': 'Cuentas admin',
    'acc.addTitle': 'Añadir una cuenta admin',
    'acc.username': 'Usuario',
    'acc.usernamePh': 'ej. alex',
    'acc.password': 'Contraseña inicial',
    'acc.passwordPh': '8 caracteres mín.',
    'acc.create': 'Crear cuenta',
    'acc.owner': 'propietario',
    'acc.admin': 'admin',
    'acc.role': 'Rol',
    'acc.role.owner': 'propietario',
    'acc.role.admin': 'admin',
    'acc.role.operator': 'operador',
    'acc.role.auditor': 'auditor',
    'acc.roleAdmin': 'Admin (acceso completo)',
    'acc.roleOperator': 'Operador (solo sus enlaces)',
    'acc.roleAuditor': 'Auditor (solo lectura)',
    'acc.roleHint': 'Los admins gestionan todo. Los operadores crean y gestionan solo sus propios enlaces. Los auditores pueden ver pero no cambiar nada.',
    'acc.tfOn': '🛡 2FA',
    'acc.you': 'tú',
    'acc.lastLogin': 'último acceso {v}',
    'acc.createdBy': 'creada por {v}',
    'acc.envManaged': 'gestionada por ADMIN_PASSWORD',
    'acc.rename': 'Renombrar',
    'acc.renamePrompt': 'Nuevo nombre de usuario para «{u}» (3–40 car.: a–z, 0–9, . _ -).',
    'acc.renamed': 'Cuenta renombrada',
    'acc.reset': 'Restablecer contraseña',
    'acc.delete': 'Eliminar',
    'acc.confirmDelete': '¿Eliminar la cuenta «{u}»? Se cerrarán sus sesiones.',
    'acc.deleted': 'Cuenta eliminada',
    'acc.resetPrompt': 'Nueva contraseña para «{u}» (8 car. mín.). El usuario deberá cambiarla en el próximo acceso.',
    'acc.resetDone': 'Contraseña restablecida',
    'acc.created': 'Cuenta creada',
    'acc.taken': 'Ese nombre de usuario ya está en uso.',
    'acc.badUsername': 'Nombre no válido (3–40 car.: a–z, 0–9, . _ -).',
    'acc.pwShort': 'La contraseña debe tener al menos 8 caracteres.',
    'acc.actionFail': 'No se pudo realizar la operación.',
    'acc.loadFail': 'No se pudieron cargar las cuentas.',
    'audit.title': 'Registro de auditoría',
    'audit.subtitle': 'Acciones admin recientes (las más recientes primero).',
    'audit.none': 'Aún no hay entradas.',
    'audit.loadFail': 'No se pudo cargar el registro.',
    'auditA.login': 'Inicio de sesión',
    'auditA.login-fail': 'Inicio fallido',
    'auditA.login-2fa-fail': '2FA fallido',
    'auditA.logout': 'Cierre de sesión',
    'auditA.password-changed': 'Contraseña cambiada',
    'auditA.password-reset': 'Contraseña restablecida',
    'auditA.2fa-enabled': '2FA activada',
    'auditA.2fa-disabled': '2FA desactivada',
    'auditA.account-created': 'Cuenta creada',
    'auditA.account-deleted': 'Cuenta eliminada',
    'auditA.account-renamed': 'Cuenta renombrada',
    'auditA.share-created': 'Recurso creado',
    'auditA.share-revoked': 'Recurso revocado',
    'auditA.inbox-created': 'Enlace de recepción creado',
    'auditA.enc-share-created': 'Recurso cifrado creado',
    'auditA.settings-changed': 'Ajustes modificados',
    'auditA.push-subscribed': 'Notificaciones push activadas',
    'auditA.push-unsubscribed': 'Notificaciones push desactivadas',
    'auditA.server-shutdown': 'Apagado del servidor',
    'menu.language': 'Idioma',
    'menu.theme': 'Tema',
    'theme.dark': 'Oscuro',
    'theme.light': 'Claro',
    'theme.auto': 'Auto',
    'menu.changePassword': '🔑 Cambiar contraseña',
    'menu.twoFactor': '🛡 Doble factor (2FA)',
    'menu.logout': '⇦ Cerrar sesión',
    'tfa.title': 'Autenticación de doble factor (2FA)',
    'tfa.statusOn': '✅ La 2FA está activada.',
    'tfa.statusOff': 'La 2FA está desactivada.',
    'tfa.enable': 'Activar 2FA',
    'tfa.disable': 'Desactivar 2FA',
    'tfa.step1': 'Escanea este código QR con tu aplicación (Google Authenticator, Authy…), o introduce la clave manualmente.',
    'tfa.secretLabel': 'Clave manual:',
    'tfa.codeLabel': 'Código de verificación',
    'tfa.codePh': 'Código de 6 dígitos',
    'tfa.verify': 'Verificar y activar',
    'tfa.recoveryTitle': 'Códigos de recuperación',
    'tfa.recoveryHint': 'Guarda estos 8 códigos en un lugar seguro. Cada uno se puede usar una vez si pierdes el acceso a tu aplicación.',
    'tfa.recoveryDone': 'He guardado mis códigos',
    'tfa.enabled': '2FA activada ✓',
    'tfa.disabled': '2FA desactivada',
    'tfa.wrongCode': 'Código incorrecto.',
    'tfa.disablePwLabel': 'Confirma con tu contraseña actual para desactivar la 2FA.',
    'tfa.pwPh': 'Contraseña actual',
    'tfa.wrongPw': 'Contraseña incorrecta.',
    'tfa.genFail': 'La operación ha fallado.',
    'dash.title': 'Panel de control',
    'dashboards.title': 'Paneles',
    'dashboards.transfers': 'Transferencias',
    'dashboards.images': 'Imágenes',
    'dashboards.back': 'Volver',
    'dash.exportCsv': '⬇ Exportar CSV',
    'dash.filterDirection': 'Dirección',
    'dash.filterStatus': 'Estado',
    'dash.filterType': 'Tipo de enlace',
    'dash.filterAllDirections': 'Todas las direcciones',
    'dash.filterAllStatuses': 'Todos los estados',
    'dash.filterAllTypes': 'Todos los tipos',
    'dash.filterSearchPh': 'Archivo, enlace, cliente, IP…',
    'dash.filterReset': 'Borrar filtros',
    'dash.filteredN': '{n} transferencia(s) en la selección',
    'dash.volumeTrend': 'Volumen transferido con el tiempo',
    'dash.successTrend': 'Tasa de éxito con el tiempo',
    'dash.stalledTransfers': 'Transferencias posiblemente bloqueadas',
    'dash.stalledBadge': 'BLOQUEADA',
    'dash.noStalled': 'No se detectaron transferencias bloqueadas',
    'dash.noStalledHelp': 'Una transferencia se marca después de un periodo sin progreso.',
    'dash.stalledFor': 'Sin progreso durante {v}',
    'dash.stopStalled': 'Detener',
    'dash.storageCleanup': 'Archivos temporales y parciales',
    'dash.storageTypes': 'Almacenamiento por tipo de archivo',
    'dash.storageLargest': 'Archivos recibidos más grandes',
    'dash.managedStorage': 'Almacenamiento gestionado por Direct-Xfer',
    'dash.storedFiles': 'Archivos almacenados',
    'dash.partialFilesN': '{n} archivo(s) parcial(es)',
    'dash.stalePartialN': '{n} parcial(es) de más de 24 h',
    'dash.scanTruncated': 'Análisis limitado a las primeras {n} entradas.',
    'dash.filesN': '{n} archivo(s)',
    'idash.filterStatus': 'Estado de imágenes',
    'idash.filterFormat': 'Formato',
    'idash.filterAllStatuses': 'Todos los estados',
    'idash.filterAllFormats': 'Todos los formatos',
    'idash.filterSearchPh': 'Nombre de imagen o token…',
    'idash.filteredN': '{n} imagen(es) en la selección',
    'idash.storageGrowth': 'Crecimiento del almacenamiento gestionado',
    'idash.storageFormats': 'Almacenamiento por formato',
    'idash.storageLargest': 'Imágenes más grandes',
    'idash.reclaimable': 'Almacenamiento potencialmente recuperable',
    'idash.storageActive': 'Imágenes activas',
    'idash.storageExpired': 'Imágenes caducadas',
    'idash.storageInactive': 'Imágenes inactivas',
    'idash.storageReclaimable': 'Recuperable eliminando imágenes inactivas',
    'dash.secRealtime': "Tiempo real y últimas 24 horas",
    'dash.activeTransfers': "Transferencias activas",
    'dash.liveUpdated': "En vivo · {v}",
    'dash.noActive': "No hay transferencias activas.",
    'dash.last24h': "Resumen de las últimas 24 horas",
    'dash.recentErrors': "Últimos fallos de transferencia",
    'dash.noErrors': "No hay fallos recientes.",
    'dash.proxy': "Estado del proxy inverso",
    'dash.proxyOk': "Configuración correcta",
    'dash.proxyWarn': "Configuración por revisar",
    'dash.proxyBad': "Configuración incorrecta",
    'dash.proxyDirect': "Acceso directo, sin proxy inverso",
    'dash.proxyDetected': "Proxy detectado: {v}",
    'dash.proxyTrust': "TRUST_PROXY: {v}",
    'dash.on': "activado",
    'dash.off': "desactivado",
    'dash.h24Transfers': "Transferencias / 24 h",
    'dash.h24Volume': "Volumen / 24 h",
    'dash.h24Success': "Éxito / 24 h",
    'dash.h24Speed': "Velocidad media / 24 h",
    'dash.h24Down': "Descargas / 24 h",
    'dash.h24Up': "Recepciones / 24 h",
    'dash.failure.interrupted': "Interrupción desconocida",
    'dash.failure.aborted': "Conexión interrumpida",
    'dash.failure.stopped': "Detenida manualmente",
    'dash.failure.timeout': "Tiempo de espera agotado",
    'dash.failure.read-error': "Error de lectura",
    'dash.failure.zip-error': "Error al crear ZIP",
    'dash.failure.zip-too-large': "Archivo ZIP demasiado grande",
    'dash.failure.write-error': "Error de escritura",
    'dash.failure.infected': "Archivo infectado",
    'dash.failure.too-large': "Archivo demasiado grande",
    'dash.failure.file-too-large': "Límite de tamaño del enlace superado",
    'dash.failure.quota-full': "Cuota del enlace alcanzada",
    'dash.failure.inbox-dir': "Carpeta de recepción no disponible",
    'dash.failure.connection-closed': "Conexión cerrada antes de finalizar",
    'idash.secLinks': "Enlaces de imagen y disponibilidad",
    'idash.linkStatus': "Estado de enlaces de imagen",
    'idash.activeLinks': "Enlaces de imagen activos",
    'idash.expiredLinks': "Enlaces de imagen caducados",
    'idash.noActiveLinks': "No hay enlaces de imagen activos.",
    'idash.noExpiredLinks': "No hay enlaces de imagen caducados.",
    'idash.expired': "Caducados",
    'idash.inactive': "Otros inactivos",
    'idash.proxy': "Proxy inverso de Imágenes",
    'idash.kpiActive': "Activas",
    'idash.kpiExpired': "Caducadas",
    'idash.open': "Abrir",
    'idash.neverExpires': "Sin caducidad",
    'dash.refresh': '↻ Actualizar',
    'dash.updated': 'Actualizado {v}',
    'idash.toggle': '📊 Panel',
    'idash.title': 'Panel de imágenes',
    'idash.added': 'Imágenes añadidas con el tiempo',
    'idash.variantViews': 'Vistas por tamaño',
    'idash.activeRevoked': 'Activas vs revocadas',
    'idash.topViews': 'Top imágenes (por vistas)',
    'idash.topVisitors': 'Top imágenes (por visitantes)',
    'idash.secStorage': 'Almacenamiento y ciclo de vida',
    'idash.storageSplit': 'Almacenamiento por tamaño',
    'idash.diskSpace': 'Espacio en disco de imágenes',
    'idash.expiring': 'Expiran pronto (7 días)',
    'idash.revoked': 'Revocadas recientemente',
    'idash.kpiImages': 'Imágenes',
    'idash.kpiViews': 'Vistas',
    'idash.kpiVisitors': 'Visitantes únicos',
    'idash.kpiStorage': 'Almacenamiento imágenes',
    'idash.kpiAdded': 'Añadidas (periodo)',
    'idash.kpiRevoked': 'Revocadas',
    'idash.kpiMini': 'Mini generadas',
    'idash.kpiMicro': 'Micro generadas',
    'idash.active': 'Activas',
    'idash.revokedLbl': 'Revocadas',
    'idash.viewsN': '{n} vistas',
    'idash.visitorsN': '{n} visitantes',
    'idash.addedN': '{n} añadida(s)',
    'dash.kpiTransfers': 'Transferencias',
    'dash.kpiVolume': 'Volumen total',
    'dash.kpiSuccess': 'Tasa de éxito',
    'dash.kpiDown': 'Descargas',
    'dash.kpiUp': 'Recepciones',
    'dash.kpiVisitors': 'Visitantes únicos',
    'dash.kpiShares': 'Enlaces activos',
    'dash.activity': 'Actividad',
    'dash.periodAll': 'Todo',
    'p3.insights': 'Análisis y alertas automáticas',
    'p3.alerts': 'Alertas automáticas',
    'p3.comparison': 'Comparación con el período anterior',
    'p3.users': 'Estadísticas por usuario',
    'p3.duplicates': 'Detección de duplicados',
    'p3.optimization': 'Optimización WebP / AVIF',
    'p3.noAlerts': 'No se detectaron anomalías',
    'p3.noAlertsHelp': 'Los umbrales se verifican automáticamente en cada actualización.',
    'p3.noComparison': 'La comparación no está disponible para el período «Todo».',
    'p3.currentPeriod': 'Período actual',
    'p3.previousPeriod': 'Período anterior',
    'p3.transfers': 'Transferencias',
    'p3.volume': 'Volumen',
    'p3.success': 'Éxito',
    'p3.speed': 'Velocidad media',
    'p3.imagesAdded': 'Imágenes añadidas',
    'p3.storageAdded': 'Almacenamiento añadido',
    'p3.averageSize': 'Tamaño medio',
    'p3.newValue': 'nuevo',
    'p3.userShares': '{n} enlace(s)',
    'p3.userTransfers': '{n} transferencia(s)',
    'p3.userImages': '{n} imagen(es)',
    'p3.userSuccess': '{n}% de éxito',
    'p3.userViews': '{n} vista(s)',
    'p3.noUsers': 'No hay datos por usuario para este período.',
    'p3.noDuplicates': 'No se detectaron duplicados exactos',
    'p3.noDuplicatesHelp': 'Las imágenes del mismo tamaño se comparan mediante huellas SHA-256.',
    'p3.duplicateSummary': '{n} duplicado(s) en {groups} grupo(s) · {space} recuperables',
    'p3.duplicateGroup': '{n} copias · {size} cada una · {space} recuperables',
    'p3.scanLimited': 'Análisis limitado a {n} imágenes para proteger el rendimiento.',
    'p3.estimated': 'Estimación',
    'p3.eligible': '{n} imagen(es) elegible(s)',
    'p3.potentialSaving': 'Ahorro potencial: {space}',
    'p3.optimizationNote': 'Estimación no destructiva basada en el formato actual. Ningún archivo se convierte automáticamente.',
    'p3.noOptimization': 'No hay imágenes grandes elegibles para esta conversión.',
    'p3.candidateSaving': '{format} · {size} → ahorro estimado {space}',
    'p3.alert.title.disk-critical': 'Almacenamiento de recepción casi lleno',
    'p3.alert.detail.disk-critical': '{pct}% usado; solo {free} disponible.',
    'p3.alert.title.disk-warning': 'Almacenamiento de recepción a vigilar',
    'p3.alert.detail.disk-warning': '{pct}% usado; {free} disponible.',
    'p3.alert.title.failure-rate': 'Tasa de fallos alta',
    'p3.alert.detail.failure-rate': '{pct}% de fallos ({n} transferencias interrumpidas).',
    'p3.alert.title.failure-increase': 'Aumento de fallos',
    'p3.alert.detail.failure-increase': '{current} fallos frente a {previous} en el período anterior.',
    'p3.alert.title.stale-parts': 'Archivos parciales antiguos',
    'p3.alert.detail.stale-parts': '{n} archivo(s) parcial(es) de más de 24 horas ocupan {space}.',
    'p3.alert.title.locked-ips': 'Direcciones IP bloqueadas',
    'p3.alert.detail.locked-ips': '{n} dirección(es) están bloqueadas tras fallos de acceso.',
    'p3.alert.title.webhook-failed': 'Falló el último webhook',
    'p3.alert.detail.webhook-failed': 'La última notificación webhook no se entregó.',
    'p3.alert.title.email-failed': 'Falló el último correo',
    'p3.alert.detail.email-failed': 'La última notificación por correo no se entregó.',
    'p3.alert.title.stalled': 'Transferencias bloqueadas detectadas',
    'p3.alert.detail.stalled': '{n} transferencia(s) no progresan desde hace al menos {v}.',
    'p3.alert.title.proxy-bad': 'La configuración del proxy inverso es incorrecta',
    'p3.alert.detail.proxy-bad': 'El diagnóstico del proxy indica un error que puede afectar enlaces o transferencias grandes.',
    'p3.alert.title.proxy-warn': 'Proxy inverso para revisar',
    'p3.alert.detail.proxy-warn': 'El diagnóstico del proxy contiene al menos una advertencia.',
    'p3.alert.title.image-disk-critical': 'Almacenamiento de Imágenes casi lleno',
    'p3.alert.detail.image-disk-critical': '{pct}% usado; solo {free} disponible.',
    'p3.alert.title.image-disk-warning': 'Almacenamiento de Imágenes a vigilar',
    'p3.alert.detail.image-disk-warning': '{pct}% usado; {free} disponible.',
    'p3.alert.title.duplicates': 'Imágenes duplicadas detectadas',
    'p3.alert.detail.duplicates': '{n} copia(s) en {groups} grupo(s) podrían liberar {space}.',
    'p3.alert.title.optimization': 'Optimización de imágenes disponible',
    'p3.alert.detail.optimization': 'La conversión WebP o AVIF podría ahorrar unos {space}.',
    'p3.alert.title.image-reclaimable': 'Imágenes inactivas recuperables',
    'p3.alert.detail.image-reclaimable': 'Las imágenes caducadas o inactivas ocupan {space}.',
    'p3.alert.title.image-growth': 'Crecimiento inusual del almacenamiento de Imágenes',
    'p3.alert.detail.image-growth': 'El almacenamiento añadido aumentó un {pct}% frente al período anterior.',
    'dash.kpiSpeed': 'Velocidad media',
    'dash.kpiDuration': 'Duración media',
    'dash.secPerf': 'Velocidad y rendimiento',
    'dash.secLinks': 'Enlaces y recursos',
    'dash.secSecurity': 'Seguridad',
    'dash.secOps': 'Almacenamiento y notificaciones',
    'dash.heatmap': 'Uso por día / hora',
    'dash.sizeDist': 'Distribución de tamaños',
    'dash.sizeSmall': 'Pequeños (< 10 MB)',
    'dash.sizeMedium': 'Medianos (10 MB–1 GB)',
    'dash.sizeLarge': 'Grandes (≥ 1 GB)',
    'dash.topFiles': 'Archivos más descargados',
    'dash.dlN': '{n} descargas',
    'dash.protection': 'Protegidos vs libres',
    'dash.protected': 'Protegidos',
    'dash.open': 'Libres',
    'dash.encryption': 'Cifrados vs en claro',
    'dash.encrypted': 'Cifrados (E2E)',
    'dash.plain': 'En claro',
    'dash.expiring': 'Caducan pronto (7 días)',
    'dash.expNone': 'Nada que informar.',
    'dash.twofa': 'Adopción de 2FA',
    'dash.twofaOn': 'Con 2FA',
    'dash.twofaOff': 'Sin 2FA',
    'dash.adminSec': 'Seguridad de acceso admin',
    'dash.failedLogins': 'Accesos fallidos',
    'dash.lockedIps': 'IP bloqueadas',
    'dash.lockedNow': 'Bloqueadas ahora',
    'dash.lockAdmin': 'admin',
    'dash.lockLink': 'enlace',
    'dash.recentLogins': 'Accesos admin recientes',
    'dash.storage': 'Espacio en disco (recepción)',
    'dash.storUsed': '{v} usados',
    'dash.storFree': '{v} libres',
    'dash.storTotal': 'Total: {v}',
    'dash.storageNA': 'Espacio en disco no disponible.',
    'dash.webhook': 'Estado del webhook',
    'dash.whNone': 'Sin webhook configurado.',
    'dash.whIdle': 'Configurado — sin llamadas aún.',
    'dash.whOk': 'Última llamada correcta',
    'dash.whFail': 'Última llamada fallida',
    'dash.downloads': 'Descargas',
    'dash.uploads': 'Recepciones',
    'dash.direction': 'Descargas vs recepciones',
    'dash.status': 'Completadas vs interrumpidas',
    'dash.completed': 'Completadas',
    'dash.interrupted': 'Interrumpidas',
    'dash.topLinks': 'Enlaces más usados (volumen)',
    'dash.topCountries': 'Países principales',
    'dash.topDownloaders': 'Top 5 clientes (descargas)',
    'dash.topUploaders': 'Top 5 clientes (envíos)',
    'dash.empty': 'Aún no hay datos.',
    'dash.dl': 'desc.',
    'dash.ul': 'recep.',
    'dash.transfersN': '{n} transferencias',
    'update.available': '⬆ Nueva versión disponible: {v}',
    'menu.shutdown': '⏻ Apagar el servidor',
    'menu.shutdownConfirm':
      '¿Apagar el servidor ahora? La interfaz dejará de estar accesible hasta que se reinicie el contenedor.',
    'menu.shutdownDone': 'Apagando el servidor…',
    'menu.shutdownFail': 'No se pudo apagar',
    'net.title': 'Red',
    'net.testBtn': 'Probar acceso externo',
    'net.localIp': 'IP local',
    'net.publicIp': 'IP pública',
    'net.linkBase': 'Base de enlaces',
    'net.extAccess': 'Acceso externo',
    'net.notTested': 'Sin probar',
    'net.testing': 'Probando…',
    'net.accessible': 'Accesible ✓',
    'net.unreachable': 'Inaccesible ✗',
    'net.undetermined': 'Indeterminado',
    'net.error': 'Error',
    'net.notDetected': 'no detectada',
    'net.domainLabel': 'Dominio de los enlaces',
    'net.domainPlaceholder': 'ej.: compartir.ejemplo.com',
    'net.sslTitle': 'Marca si un proxy inverso (Nginx) sirve la aplicación por HTTPS',
    'net.save': 'Guardar',
    'net.reset': 'Restablecer',
    'net.auto': 'Auto',
    'net.autoTitle': 'Volver a la detección automática',
    'net.domainHelp':
      'Se usa para construir los enlaces de compartición. Déjalo vacío para la detección automática.',
    'net.hintAccessible': '{label} es accesible desde Internet ({open}/{total} nodos).',
    'net.hintUnreachable':
      '{label} no es accesible. Verifica la redirección de puertos (NAT), el proxy inverso y el firewall del sistema.',
    'net.hintUndetermined': 'Prueba fallida ({error}). Inténtalo más tarde.',
    'net.proxyHint': 'Proxy inverso detectado: la prueba de acceso apunta a {label}.',
    'net.domainSaved': 'Dominio guardado ✓',
    'net.autoRestored': 'Detección automática restablecida',
    'net.domainInvalid': 'Dominio no válido',
    'net.saveError': 'No se pudo guardar',
    'net.saveNoPersist':
      'Dominio aplicado, pero no guardado en el disco (carpeta data no escribible — revisa el montaje).',
    'net.unavailable': 'Red no disponible',
    'net.theDomain': 'el dominio',
    'net.theTarget': 'el destino',
    'proxy.testBtn': 'Probar proxy inverso',
    'proxy.testing': 'Analizando la petición…',
    'proxy.error': 'No se pudo diagnosticar.',
    'proxy.verdict.ok': 'Proxy inverso configurado correctamente',
    'proxy.verdict.warn': 'Proxy inverso: puntos a revisar',
    'proxy.verdict.bad': 'Proxy inverso mal configurado',
    'proxy.verdict.info': 'Diagnóstico del proxy inverso',
    'proxy.trustProxy': 'TRUST_PROXY',
    'proxy.enabled': 'activado',
    'proxy.disabled': 'desactivado',
    'proxy.detected': 'Proxy detectado',
    'proxy.yes': 'sí',
    'proxy.no': 'no',
    'proxy.clientIp': 'IP de visitante resuelta',
    'proxy.remoteAddr': 'Par inmediato',
    'proxy.publicPeerTag': 'IP pública',
    'proxy.protocol': 'Protocolo visto por la app',
    'proxy.target': 'Dominio probado',
    'proxy.host': 'Host',
    'proxy.headers': 'Cabeceras de reenvío recibidas',
    'proxy.noHeaders': 'No se recibió ninguna cabecera X-Forwarded-* / de proxy en esta petición.',
    'proxy.msg.proxy-untrusted': 'Se reciben cabeceras de proxy inverso pero TRUST_PROXY está desactivado: la app ve la IP del proxy ({peer}), no la del visitante. Activa TRUST_PROXY (ej. TRUST_PROXY="1").',
    'proxy.msg.trust-no-headers': 'TRUST_PROXY está activado pero no se recibió ninguna cabecera X-Forwarded-*: o no hay proxy inverso delante, o no las reenvía. TRUST_PROXY activado sin un proxy real hace que la IP del visitante sea falsificable.',
    'proxy.msg.proxy-ok': 'Proxy inverso detectado y de confianza. IP de visitante resuelta: {ip}.',
    'proxy.msg.direct': 'No se detectó proxy inverso: conexión directa. IP del cliente: {ip}.',
    'proxy.msg.https-not-trusted': 'El proxy anuncia HTTPS (X-Forwarded-Proto: https) pero la app lo ve como HTTP: las cookies «Secure» no se establecerán. Activa TRUST_PROXY para que se refleje el HTTPS.',
    'proxy.msg.https-ok': 'El HTTPS del proxy se propaga correctamente (X-Forwarded-Proto respetado).',
    'proxy.msg.no-proto': 'El proxy no reenvía la cabecera X-Forwarded-Proto: no se puede detectar el HTTPS. Añádela (Nginx: proxy_set_header X-Forwarded-Proto $scheme;).',
    'proxy.msg.host-diff': 'Host público anunciado por el proxy: {pub} (Host interno: {internal}).',
    'proxy.msg.public-peer': 'La petición viene de una IP pública ({ip}) aunque hay cabeceras de proxy: asegúrate de que solo el proxy pueda alcanzar el contenedor y que no esté expuesto directamente.',
    'proxy.msg.multi-hop': '{n} saltos en X-Forwarded-For: {chain}. Con varios proxies, ajusta TRUST_PROXY al número de saltos de confianza.',
    'proxy.msg.buffering': 'Para envíos grandes (enlaces de recepción), desactiva el almacenamiento en búfer de las peticiones y sube los límites de tamaño/tiempo — Nginx: client_max_body_size 0; proxy_request_buffering off; proxy_read_timeout alto.',
    'shutdown.armed': 'Autoapagado activado: se detiene después de la próxima descarga.',
    'shutdown.disarmed': 'Autoapagado desactivado.',
    'settings.saveError': 'No se pudo guardar el ajuste',
    'tr.title': 'Transferencias en curso',
    'tr.none': 'Ninguna transferencia en curso.',
    'tr.locating': 'localizando…',
    'tr.localNetwork': 'Red local',
    'tr.remaining': 'restante',
    'tr.zip': 'archivo .zip',
    'tr.zipTitle': 'Varios archivos agrupados en un solo archivo .zip',
    'sh.title': 'Comparticiones activas',
    'sh.new': '＋ Nueva compartición',
    'sh.newInbox': '＋ Enlace de recepción',
    'sh.newCollab': '🔁 Enlace de colaboración',
    'sh.secret': 'Nota secreta',
    'sh.clone': '⧉ Duplicar',
    'sh.cloneTitle': 'Duplicar este recurso con un enlace nuevo y contadores a cero',
    'sh.cloneSuffix': '(copia)',
    'sh.clonePrompt': 'Nombre del nuevo recurso:',
    'sh.cloneBusy': 'Duplicando…',
    'sh.cloned': 'Recurso duplicado ✓',
    'sh.clonedAs': 'Recurso «{name}» duplicado ✓',
    'sh.cloneFail': 'No se pudo duplicar',
    'sh.cloneUnsupported': 'Este tipo de recurso no se puede duplicar',
    'sh.cloneImageMissing': 'No se encuentra el archivo de origen de esta imagen',
    'sh.cloneInvalidName': 'El nombre del nuevo recurso no es válido',
    'sh.email': '✉ Correo',
    'sh.emailTitle': 'Enviar este enlace por correo',
    'sh.emailPrompt': 'Correo del destinatario para «{name}»:',
    'sh.emailSent': 'Correo enviado a {to} ✓',
    'sh.emailInvalid': 'Dirección de correo no válida',
    'sh.emailNotConfigured': 'SMTP no configurado',
    'sh.emailFail': 'Error al enviar',
    'sh.fType': 'Todos los tipos',
    'sh.fStatus': 'Todos los estados',
    'sh.fActive': 'Activos',
    'sh.fInactive': 'Inactivos',
    'sh.sortNew': 'Más recientes',
    'sh.sortOld': 'Más antiguos',
    'sh.sortName': 'Nombre A→Z',
    'sh.sortDl': 'Más activos',
    'sh.sortExpiry': 'Caduca pronto',
    'view.list': 'Vista de lista',
    'view.grid': 'Vista de cuadrícula',
    'keys.title': 'Atajos de teclado',
    'keys.new': 'Nuevo recurso compartido',
    'keys.reception': 'Nuevo enlace de recepción',
    'keys.collab': 'Nuevo enlace de colaboración',
    'keys.search': 'Enfocar el filtro',
    'keys.help': 'Mostrar esta ayuda',
    'keys.close': 'Cerrar un diálogo',
    'sh.filterPh': '🔍 Filtrar por nombre o etiqueta…',
    'sh.noneFilter': 'Ningún enlace coincide con el filtro.',
    'sh.tagAdd': 'Etiqueta',
    'sh.tagRemove': 'Quitar la etiqueta',
    'sh.tagPrompt': 'Nombre de la etiqueta:',
    'sh.tagFail': 'Error al actualizar las etiquetas',
    'sh.bulkCount': '{n} seleccionado(s)',
    'sh.bulkTag': '🏷 Etiquetar',
    'sh.bulkExtend': '⏱ Prolongar',
    'sh.bulkRevoke': 'Revocar',
    'sh.bulkDone': '✓ {n} enlace(s) actualizado(s)',
    'sh.bulkFail': 'Error en la acción por lotes',
    'sh.bulkRevokeConfirm': '¿Revocar {n} enlace(s)? Sus URL dejarán de funcionar.',
    'sh.bulkExtendPrompt': 'Nueva expiración desde ahora, en días (0 = nunca):',
    'sh.bulkTagPrompt': 'Etiqueta para añadir a los enlaces seleccionados:',
    'mod.enable': 'Revisar los archivos antes de publicarlos',
    'mod.pending': '⏳ Pendiente de moderación ({n})',
    'mod.approve': '✓ Aprobar',
    'mod.reject': '✕ Rechazar',
    'mod.approved': '✓ Archivo aprobado',
    'mod.rejected': 'Archivo rechazado',
    'mod.rejectConfirm': '¿Rechazar y eliminar permanentemente este archivo?',
    'mod.fail': 'Error de moderación',
    'sh.inbox': 'recepción',
    'sh.collab': 'colaboración',
    'sh.canDelete': 'eliminación permitida',
    'sh.activity': 'Actividad:',
    'sh.deleteOn': 'Eliminación permitida',
    'sh.deleteOff': 'Eliminación no permitida',
    'sh.received': 'Recibidos:',
    'inbox.namePrompt': 'Nombre del enlace de recepción (opcional):',
    'inbox.created': 'Enlace de recepción creado ✓',
    'inbox.createFail': 'No se pudo crear el enlace',
    'collab.title': 'Nuevo enlace de colaboración',
    'collab.intro': 'Una carpeta compartida bidireccional: los visitantes pueden descargar y subir. Los archivos se guardan en una nueva carpeta de tu área de recepción.',
    'collab.namePh': 'ej. Espacio del proyecto',
    'collab.allowDelete': 'Permitir que los visitantes eliminen contenido',
    'collab.deleteNeedsPw': '⚠ Requiere una contraseña: la eliminación por parte de los visitantes permanece desactivada mientras el enlace no esté protegido.',
    'collab.notePh': 'ej. Deja aquí tus revisiones; descarga el último resumen.',
    'collab.created': 'Enlace de colaboración creado ✓',
    'collab.createFail': 'No se pudo crear el enlace',
    'inbox.pwPrompt': 'Contraseña de acceso (opcional):',
    'inbox.title': 'Nuevo enlace de recepción',
    'inbox.name': 'Nombre',
    'inbox.namePh': 'ej. Documentos del cliente',
    'inbox.expiry': 'Expiración',
    'inbox.password': 'Contraseña (opcional)',
    'inbox.maxFiles': 'Máx. archivos',
    'inbox.maxFileSize': 'Tamaño máx. / archivo (MB)',
    'inbox.maxTotalSize': 'Cuota total (MB)',
    'inbox.allowExt': 'Tipos permitidos (separados por comas, opcional)',
    'inbox.blockExt': 'Tipos bloqueados (opcional)',
    'inbox.extPh': 'ej. pdf, jpg, png',
    'inbox.note': 'Mensaje mostrado a los remitentes (opcional)',
    'inbox.groupSender': 'Ordenar los envíos en subcarpetas por remitente',
    'inbox.notePh': 'ej. Envíe el contrato firmado en PDF.',
    'inbox.create': 'Crear enlace',
    'sh.noteLabel': 'Instrucción:',
    'sh.msgsLabel': 'Mensajes recibidos ({n}):',
    'sh.msgsMore': '+ {n} más',
    'sh.msgsClear': '🗑 Vaciar la lista',
    'sh.msgsClearConfirm': '¿Vaciar la lista de mensajes de «{name}»?\nLos archivos ya recibidos en el disco no se eliminan.',
    'sh.msgsCleared': 'Lista vaciada ✓',
    'sh.msgsClearFail': 'No se pudo vaciar la lista',
    'hi.exportCsv': '⬇ CSV',
    'hi.exportJson': '⬇ JSON',
    'hi.exportEmpty': 'No hay transferencias para exportar.',
    'hi.exportFail': 'Error al exportar.',
    'sh.filtersLabel': 'Filtros / cuotas:',
    'sh.limPerFile': 'máx {v}/archivo',
    'sh.limFiles': 'máx {v} archivos',
    'sh.limQuota': 'cuota {v}',
    'sh.limAllow': 'permitidos: {v}',
    'sh.limBlock': 'bloqueados: {v}',
    'sh.usage': 'usado {v}',
    'sh.statsLabel': 'Estadísticas:',
    'stats.button': '📊 Estadísticas',
    'stats.title': 'Estadísticas detalladas',
    'stats.loading': 'Cargando estadísticas…',
    'stats.fail': 'No se pudieron cargar las estadísticas.',
    'stats.overview': 'Resumen',
    'stats.details': 'Información del enlace',
    'stats.activity14': 'Actividad de los últimos 14 días',
    'stats.recent': 'Actividad reciente',
    'stats.countries': 'Países principales',
    'stats.clients': 'Clientes principales',
    'stats.imageCopies': 'Copias de la imagen',
    'stats.imageRecent': 'Accesos recientes a la imagen',
    'stats.live': 'Transferencias activas',
    'stats.transfers': 'Transferencias',
    'stats.volume': 'Volumen',
    'stats.success': 'Éxito',
    'stats.speed': 'Velocidad media',
    'stats.views': 'Vistas',
    'stats.visitors': 'Visitantes únicos',
    'stats.storage': 'Espacio utilizado',
    'stats.downloads': 'Descargas',
    'stats.completed': 'Completadas',
    'stats.interrupted': 'Interrumpidas',
    'stats.averageSize': 'Tamaño medio',
    'stats.lastActivity': 'Última actividad',
    'stats.firstActivity': 'Primera actividad conservada',
    'stats.status': 'Estado',
    'stats.type': 'Tipo',
    'stats.owner': 'Propietario',
    'stats.created': 'Creación',
    'stats.expiry': 'Caducidad',
    'stats.items': 'Elementos',
    'stats.path': 'Ruta',
    'stats.url': 'Enlace',
    'stats.tags': 'Etiquetas',
    'stats.none': 'No hay datos disponibles.',
    'stats.noRecent': 'No se ha registrado actividad reciente.',
    'stats.noImageRecent': 'Los accesos detallados se registrarán a partir de esta versión.',
    'stats.full': 'Original',
    'stats.thumb': 'Mini',
    'stats.micro': 'Micro',
    'stats.dimensions': 'Dimensiones',
    'stats.lastView': 'Última vista',
    'stats.active': 'Activo',
    'stats.inactive': 'Inactivo',
    'stats.paused': 'En pausa',
    'stats.scheduled': 'Programado',
    'stats.unknown': 'Desconocido',
    'stats.quota': 'Uso de cuotas',
    'stats.files': 'Archivos',
    'sh.statCount': '{n} transferencias · {v}',
    'sh.statOkKo': '{ok} ok / {ko} interrumpidas',
    'sh.statLast': 'última {v}',
    'sh.protected': '🔒 protegido',
    'sh.qr': 'QR',
    'sh.qrTitle': 'Mostrar el código QR',
    'qr.title': 'Código QR',
    'pk.password': 'Contraseña (opcional)',
    'pk.passwordPh': 'ninguna',
    'tr.stopTitle': 'Detener',
    'tr.stopConfirm': '¿Detener esta transferencia?',
    'sh.shutdownLabel': 'Apagar el servidor después de la próxima descarga completa',
    'sh.shutdownHelp': 'El contenedor se detiene; el ajuste se desactiva después.',
    'sh.none': 'Sin comparticiones. Haz clic en «＋ Nueva compartición» para crear una.',
    'sh.connLost': 'Servidor inaccesible (quizá detenido después de una descarga). Reconectando…',
    'sh.folder': 'carpeta',
    'sh.file': 'archivo',
    'sh.inactive': 'inactivo',
    'sh.sizeLabel': 'Tamaño:',
    'sh.created': 'Creado:',
    'sh.downloads': 'Descargas:',
    'sh.visitors': 'Visitantes:',
    'sh.viewsTip': '{views} vista(s) · {visitors} visitante(s) único(s)',
    'sh.expires': 'Caduca:',
    'sh.scheduled': '🕒 programado',
    'sh.startsAt': 'Activo desde:',
    'pk.startsAt': 'Activo desde (opcional)',
    'sh.link': 'Enlace',
    'sh.lan': 'LAN',
    'sh.open': 'Abrir',
    'sh.revoke': 'Revocar',
    'sh.copy': 'Copiar',
    'sh.copied': 'Enlace copiado ✓',
    'sh.copyFail': 'No se pudo copiar, selecciona el enlace manualmente',
    'sh.revokeConfirm': '¿Revocar la compartición «{name}»?\nPodrás recuperarla durante 5 segundos.',
    'sh.revoked': 'Compartición revocada',
    'sh.revokeFail': 'No se pudo revocar',
    'sh.revokePending': 'Se eliminará en 5 segundos…',
    'sh.undoRevoke': 'Recuperar',
    'sh.recovered': 'Compartición recuperada',
    'sh.created2': 'Compartición creada ✓',
    'sh.createFail': 'No se pudo crear: {error}',
    'sh.loadFail': 'No se pudieron cargar las comparticiones',
    'hi.title': 'Historial',
    'hi.subtitle': '(últimas 2.000 transferencias)',
    'hi.none': 'Ninguna transferencia reciente.',
    'hi.noMatch': 'Ninguna transferencia coincide con los filtros.',
    'hi.filter': '🔎 Filtrar',
    'hi.searchPh': 'Buscar por nombre, IP, país…',
    'hi.direction': 'Sentido de la transferencia',
    'hi.status': 'Estado de la transferencia',
    'hi.allDirections': 'Todos los sentidos',
    'hi.downloads': 'Descargas',
    'hi.uploads': 'Envíos',
    'hi.allStatuses': 'Todos los estados',
    'hi.completedPlural': 'Completadas',
    'hi.interruptedPlural': 'Interrumpidas',
    'hi.resetFilter': 'Borrar',
    'hi.results': '{shown} de {total}',
    'hi.previous': 'Página anterior',
    'hi.next': 'Página siguiente',
    'hi.clear': '🗑 Purgar',
    'hi.clearConfirm': '¿Purgar todo el historial de transferencias?\nLa lista y el registro exportable (CSV/JSON) se borrarán. Las estadísticas por enlace se conservan.',
    'hi.cleared': 'Historial purgado ✓',
    'hi.clearFail': 'No se pudo purgar',
    'hi.completed': 'completado',
    'hi.interrupted': 'interrumpido',
    'live.online': 'en vivo',
    'live.offline': 'sin conexión',
    'live.title': 'Actualización automática',
    'pk.title': 'Elegir un archivo o carpeta',
    'pk.location': 'Ubicación:',
    'pk.expiration': 'Caducidad',
    'pk.never': 'Nunca',
    'pk.h1': '1 hora',
    'pk.d1': '1 día',
    'pk.d7': '7 días',
    'pk.d30': '30 días',
    'pk.maxDl': 'Descargas máx.',
    'pk.maxVisitors': 'Visitantes únicos máx.',
    'pk.rate': 'Velocidad máx. (KB/s)',
    'pk.allowZip': 'Permitir «Descargar todo (.zip)»',
    'pk.burn': 'Enlace de un solo uso (revocado tras la 1.ª descarga)',
    'pk.note': 'Mensaje mostrado al visitante (opcional)',
    'pk.notePh': 'ej. Aquí tienes el archivo solicitado.',
    'sh.speed': 'Velocidad: {v} KB/s',
    'sh.zipOff': '⛔ .zip desactivado',
    'menu.about': 'ℹ️ Acerca de',
    'about.title': 'Acerca de',
    'about.author': 'Autor:',
    'about.version': 'Versión',
    'about.released': 'Última versión',
    'about.github': 'GitHub',
    'about.docker': 'Docker Hub',
    'about.discord': 'Discord',
    'pk.addTitle': 'Añadir archivos a «{name}»',
    'pk.addBtn': 'Añadir',
    'sh.addFiles': '➕ Añadir archivos',
    'sh.files': '{n} archivos',
    'sh.added': 'Archivo añadido al recurso',
    'sh.addFail': 'No se pudo añadir: {error}',
    'sh.removeItem': 'Quitar',
    'sh.reorder': 'Arrastra para reordenar',
    'sh.reordered': 'Orden guardado',
    'sh.reorderFail': 'No se pudo reordenar',
    'sh.renameTip': 'Doble clic para renombrar',
    'sh.renamed': 'Enlace renombrado',
    'sh.renameFail': 'No se pudo renombrar',
    'sh.summary': '{n} enlace(s) · {active} activo(s) · {size}',
    'sh.paused': 'en pausa',
    'sh.pause': '⏸ Pausar',
    'sh.resume': '▶ Reanudar',
    'sh.pauseTitle': 'Pausar (desactivar sin eliminar)',
    'sh.resumeTitle': 'Reactivar este enlace',
    'sh.paused2': 'Enlace pausado',
    'sh.resumed': 'Enlace reactivado',
    'sh.pauseFail': 'No se pudo pausar el enlace',
    'sh.noteBtn': '📝 Nota',
    'sh.noteTitle': 'Nota privada (solo admin)',
    'sh.noteEditTip': 'Haz clic para editar la nota',
    'sh.notePh2': 'Nota privada para el admin…',
    'sh.noteSaved': 'Nota guardada',
    'sh.noteFail': 'No se pudo guardar la nota',
    'sh.log': '🧾 Registro',
    'sh.logTitle': 'Registro de accesos de este enlace',
    'sh.exportCsv': '⬇ Lista CSV',
    'sh.exportJson': '⬇ Lista JSON',
    'sh.dupWarn': 'Esta ruta ya está compartida por: {names}. ¿Crear otro enlace igualmente?',
    'log.title': 'Registro de accesos',
    'log.loading': 'Cargando…',
    'log.fail': 'No se pudo cargar el registro',
    'log.none': 'Sin accesos registrados para este enlace.',
    'log.ok': 'completo',
    'log.ko': 'interrumpido',
    'pk.unitH': 'h',
    'pk.unitD': 'd',
    'pk.unitW': 'sem',
    'pk.unitMo': 'mes',
    'cfg.expiryPresets': 'Preajustes rápidos de caducidad',
    'cfg.expiryPresetsHint': 'Duraciones separadas por comas ofrecidas en las ventanas de enlace — p. ej. 6h, 3d, 2w, 1mo. «Nunca» siempre está disponible.',
    'search.btn': '🔎 Buscar contenido',
    'search.ph': '🔎 Buscar dentro de los archivos de texto compartidos y recibidos…',
    'search.run': 'Buscar',
    'search.searching': 'Buscando…',
    'search.tooShort': 'Introduce al menos 2 caracteres.',
    'search.fail': 'Error en la búsqueda',
    'search.count': '{n} archivo(s) · {scanned} analizado(s)',
    'search.truncated': 'resultados truncados',
    'search.none': 'Sin resultados.',
    'photo.title': 'Imágenes',
    'photo.add': '🖼 Añadir imágenes',
    'img.netTitle': 'Dominio de imágenes y acceso externo',
    'img.domainLabel': 'Dominio de imágenes (opcional)',
    'img.domainPh': 'ej. img.ejemplo.com',
    'img.domainHelp': 'Se usa solo para los enlaces de imagen. Vacío = mismo dominio que los enlaces principales.',
    'img.hotlinkLabel': 'Protección contra hotlinking (opcional)',
    'img.hotlinkPh': 'p. ej. example.com, forum.example.org',
    'img.hotlinkHelp': 'Sitios autorizados a incrustar tus imágenes (separados por comas). Vacío = cualquier sitio. Las visitas directas y las páginas de este servidor siempre se permiten; los subdominios de un host listado también.',
    'img.hotlinkSaved': 'Protección contra hotlinking guardada.',
    'img.hotlinkCleared': 'Protección contra hotlinking desactivada.',
    'img.domainSaved': 'Dominio de imágenes guardado ✓',
    'img.autoRestored': 'Dominio de imágenes restablecido (igual que el principal)',
    'photo.intro': 'Enlaces de imagen directos: cada foto tiene URL Completa, Mini y Micro que abren la imagen en sí, sin página alrededor — listas para incrustar o hotlink.',
    'photo.none': 'Ninguna foto compartida.',
    'photo.pickTitle': 'Elegir imágenes',
    'photo.pickBtn': 'Crear enlaces',
    'photo.createFail': 'No se pudo crear',
    'photo.created': '{n} imagen(es) añadida(s)',
    'photo.skipped': '{n} omitida(s) (no son imágenes)',
    'photo.copyFailed': 'No se pudieron copiar {n} imagen(es) — comprueba la carpeta Images',
    'photo.full': 'Completa',
    'photo.thumb': 'Mini',
    'photo.micro': 'Micro',
    'photo.bbcode': 'BBCode',
    'photo.md': 'MD',
    'photo.html': 'HTML',
    'photo.renameHint': 'Doble clic para renombrar',
    'photo.editExpiry': 'Cambiar la expiración',
    'photo.noExpiry': 'Sin expiración',
    'photo.expiryUpdated': 'Expiración actualizada ✓',
    'photo.expiryFail': 'No se pudo actualizar la expiración',
    'photo.searchPh': 'Buscar una imagen…',
    'photo.sortTitle': 'Ordenar',
    'photo.sortNew': 'Más recientes',
    'photo.sortOld': 'Más antiguas',
    'photo.sortName': 'Nombre',
    'photo.sortViews': 'Más vistas',
    'photo.sortSize': 'Más pesadas',
    'photo.sortDimensions': 'Mayores dimensiones',
    'photo.filters': 'Filtros de imágenes',
    'photo.filterFormat': 'Filtrar por formato',
    'photo.allFormats': 'Todos los formatos',
    'photo.filterOrientation': 'Filtrar por orientación',
    'photo.allOrientations': 'Todas las orientaciones',
    'photo.landscape': 'Horizontal',
    'photo.portrait': 'Vertical',
    'photo.square': 'Cuadrada',
    'photo.filterVariants': 'Filtrar por variantes',
    'photo.allVariants': 'Todas las variantes',
    'photo.variantsReady': 'Mini + Micro listas',
    'photo.variantsMissing': 'Falta una variante',
    'photo.filterAlbum': 'Filtrar por galería',
    'photo.allAlbums': 'Todas las galerías',
    'photo.noAlbum': 'Sin galería',
    'photo.favoritesOnly': '☆ Favoritas',
    'photo.filterReset': 'Restablecer filtros',
    'photo.favorite': 'Añadir a favoritas',
    'photo.unfavorite': 'Quitar de favoritas',
    'photo.rename': '✎ Renombrar',
    'photo.createdAt': 'Añadida el {date}',
    'photo.ratio': 'proporción {ratio}',
    'photo.exportCsv': '⇩ CSV',
    'photo.exportJson': '⇩ JSON',
    'photo.copyAll': '🔗 Copiar todo',
    'photo.copyAllTitle': 'Copiar todos los enlaces a tamaño completo visibles (uno por línea)',
    'photo.lbOpen': 'Abrir ↗',
    'album.create': '🖼 Crear galería',
    'album.title': 'Galerías',
    'album.hint': 'Galerías de imágenes públicas creadas a partir de imágenes seleccionadas. Cualquiera con el enlace puede verlas.',
    'album.count': '{n} imágenes',
    'album.views': '{n} vistas',
    'album.untitled': 'Galería',
    'album.namePrompt': 'Nombre de la galería:',
    'album.created': 'Galería creada.',
    'album.createFail': 'No se pudo crear la galería.',
    'photo.dropHint': 'Arrastra imágenes aquí, pega (Ctrl+V) o haz clic — se crea un enlace directo para cada una.',
    'photo.uploaded': '{n} imagen(es) añadida(s) ✓',
    'photo.uploadProgress': 'Carga {done}/{total}',
    'photo.uploadSummary': '{ok} añadida(s), {failed} fallida(s), {skipped} ignorada(s)',
    'photo.uploadFail': 'Error al subir',
    'photo.selectHint': 'Seleccionar para acciones en lote',
    'photo.selectedN': '{n} seleccionada(s)',
    'photo.bulkExpiry': 'Fijar expiración…',
    'photo.bulkExpiryTitle': 'Fijar la expiración de las imágenes seleccionadas',
    'photo.bulkAlbum': 'Añadir a galería…',
    'photo.bulkAlbumTitle': 'Añadir las imágenes seleccionadas a una galería existente',
    'photo.bulkAlbumDone': '{n} imagen(es) añadida(s) a la galería',
    'photo.bulkFavorite': '★ Añadir a favoritas',
    'photo.bulkUnfavorite': '☆ Quitar de favoritas',
    'photo.bulkDownload': '⇩ ZIP',
    'photo.bulkRevoke': '🗑 Revocar',
    'photo.bulkClear': 'Borrar',
    'photo.gallery': 'Galería de imágenes',
    'photo.history': 'Historial',
    'photo.historyHint': 'Las últimas 50 imágenes revocadas se conservan aquí.',
    'photo.historyEmpty': 'No hay imágenes revocadas.',
    'photo.revokedAt': 'Revocada el {date}',
    'photo.histFull': 'completa {size}',
    'photo.histKept': 'conservada {size}',
    'photo.previewUnavailable': 'Vista previa no disponible',
    'photo.historyDelete': 'Eliminar del historial',
    'photo.historyDeleteConfirm': '¿Eliminar definitivamente «{name}» del historial?',
    'photo.historyDeleted': 'Elemento eliminado del historial ✓',
    'photo.historyDeleteFail': 'No se pudo eliminar el elemento',
    'photo.purge': '🗑 Purgar',
    'photo.purgeConfirm': '¿Purgar definitivamente el historial de imágenes revocadas?',
    'photo.purged': 'Historial de imágenes purgado ✓',
    'photo.purgeFail': 'No se pudo purgar',
    'sh.itemRemoved': 'Elemento quitado',
    'sh.removeItemFail': 'No se pudo quitar: {error}',
    'pk.unlimited': 'ilimitado',
    'pk.selection': 'Selección:',
    'pk.cancel': 'Cancelar',
    'pk.share': 'Compartir',
    'pk.folderSuffix': '  (carpeta)',
    'pk.selectedN': '{n} elementos seleccionados',
    'pk.multiHint': 'Consejo: haz clic en varios elementos para compartirlos juntos (incluso en carpetas distintas).',
    'pk.fileSuffix': '  (archivo)',
    'pk.parent': '.. (carpeta superior)',
    'pk.emptyFolder': 'Carpeta vacía',
    'pk.open': 'abrir ›',
    'pk.navFail': 'Error de navegación',
    'pk.hostInaccessible': 'Sistema de archivos del host inaccesible (monta /:/host:ro).',
    'pk.preview': '👁 Vista previa',
    'pk.previewUnsupported': 'Este formato no se puede previsualizar en tu navegador — el códec no es compatible.',
    'pw.title': 'Cambiar contraseña',
    'pw.firstTitle': 'Establece tu contraseña',
    'pw.firstLoginHint': 'Por seguridad, elige una nueva contraseña antes de continuar.',
    'pw.current': 'Contraseña actual',
    'pw.new': 'Nueva contraseña (mín. 8 caracteres)',
    'pw.confirm': 'Confirmar la nueva contraseña',
    'pw.tooShort': 'La nueva contraseña debe tener al menos 8 caracteres.',
    'pw.mismatch': 'La confirmación no coincide.',
    'pw.changed': 'Contraseña cambiada ✓',
    'pw.changedEnv':
      'Contraseña cambiada (solo la sesión actual: ADMIN_PASSWORD está fijada por variable de entorno).',
    'pw.changedTemp':
      'Contraseña cambiada para esta sesión, pero no se pudo guardar en el disco (revisa los permisos de la carpeta data).',
    'pw.currentWrong': 'La contraseña actual es incorrecta.',
    'pw.changeFail': 'No se pudo cambiar.',
    'time.s': 's',
    'time.min': 'min',
    'time.h': 'h',
    'time.d': 'd',
    'time.ago': 'hace {v}',
    'units.bytes': ['B', 'KB', 'MB', 'GB', 'TB'],
  },
};

const LOCALES = { fr: 'fr-FR', en: 'en-US', es: 'es-419' };

// ------------------------------------------------------------------
// Persistent interface preferences
// ------------------------------------------------------------------
// Small, browser-local preferences only. No credentials, paths or private data
// are stored here. A versioned object makes future migrations safe.
const UI_PREFS_KEY = 'dx-ui-prefs-v1';
const UI_PREFS_DEFAULTS = Object.freeze({
  lang: '',
  theme: '',
  dashboardTab: 'transfers',
  dashPeriod: '30',
  dashDirection: '',
  dashStatus: '',
  dashType: '',
  dashQuery: '',
  imagesDashPeriod: '30',
  imagesDashStatus: '',
  imagesDashFormat: '',
  imagesDashQuery: '',
  shareFilter: '',
  shareType: '',
  shareStatus: '',
  shareSort: 'new',
  shareView: 'list',
  photoSearch: '',
  photoSort: 'new',
  photoFormat: '',
  photoOrientation: '',
  photoVariants: '',
  photoAlbum: '',
  photoFavoritesOnly: false,
  photoView: 'grid',
});

function readUiPrefs() {
  let parsed = {};
  try {
    parsed = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  } catch (_) { parsed = {}; }
  // Preserve the two legacy keys so existing installations migrate seamlessly.
  try {
    if (!parsed.lang) parsed.lang = localStorage.getItem('lang') || '';
    if (!parsed.theme) parsed.theme = localStorage.getItem('dx-theme') || '';
  } catch (_) {}
  return Object.assign({}, UI_PREFS_DEFAULTS, parsed);
}

let uiPrefs = readUiPrefs();
let uiPrefsSaveTimer = null;

function flushUiPrefs() {
  clearTimeout(uiPrefsSaveTimer);
  uiPrefsSaveTimer = null;
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(uiPrefs)); } catch (_) {}
}

function updateUiPrefs(patch, immediate = false) {
  if (!patch || typeof patch !== 'object') return;
  Object.assign(uiPrefs, patch);
  if (immediate) { flushUiPrefs(); return; }
  clearTimeout(uiPrefsSaveTimer);
  uiPrefsSaveTimer = setTimeout(flushUiPrefs, 120);
}

function uiPrefChoice(key, allowed, fallback) {
  const value = String(uiPrefs[key] == null ? '' : uiPrefs[key]);
  return allowed.includes(value) ? value : fallback;
}

function uiPrefText(key, max = 240) {
  const value = typeof uiPrefs[key] === 'string' ? uiPrefs[key] : '';
  return value.slice(0, max);
}

window.addEventListener('pagehide', flushUiPrefs);

function detectLang() {
  try {
    const saved = localStorage.getItem('lang') || uiPrefs.lang;
    if (saved && I18N[saved]) return saved;
  } catch (_) {}
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return I18N[nav] ? nav : 'en';
}

// ------------------------------------------------------------------
// Application state
// ------------------------------------------------------------------
const state = {
  csrf: null,
  lang: detectLang(),
  cwd: '/', // current folder in the picker (absolute host path)
  pickerMode: 'create', // 'create' | 'addTo' | 'configDir'
  addToShareId: null,
  selections: [], // [{ path, name, isDir }] — multi-select in the picker
  port: 55750,
  pollTimer: null,
  lastSharesJson: '',
  lastPhotosSig: '', // structural signature of the Images grid (excludes live view counts)
  lastSettingsJson: '', // poll no-op guards: skip re-applying unchanged settings…
  lastTransfersJson: '', // …transfers…
  lastHistoryMetaSig: '', // reload the separate history payload only when this changes
  lastPhotoHistoryMetaSig: '', // same pattern for the 50 revoked images
  historyLoadPromise: null,
  historyReloadPending: false,
  photoHistoryLoadPromise: null,
  historyRenderTimer: null,
  allShares: [], // last-rendered shares, for client-side filtering (feature 9)
  shareFilter: uiPrefText('shareFilter'), // name/tag filter text
  shareType: uiPrefChoice('shareType', ['', 'file', 'folder', 'inbox', 'collab', 'secret'], ''), // type filter
  shareStatus: uiPrefChoice('shareStatus', ['', 'active', 'inactive'], ''), // status filter
  shareSort: uiPrefChoice('shareSort', ['new', 'old', 'name', 'downloads', 'expiry'], 'new'), // sort order
  shareView: uiPrefChoice('shareView', ['list', 'grid'], 'list'),
  selShares: new Set(), // selected share ids for bulk actions
  pendingShareDeletion: null, // one recoverable deletion: { id, timer, committing, promise }
  historyPage: 0,
  historyData: [],
  historyQuery: '',
  historyDirection: '',
  historyStatus: '',
  forcedPw: false,
  settingsDirtyUntil: 0,
  settingsEpoch: 0,
  connLost: false,
  dashboardData: null,
  dashboardLiveData: null,
  dashTimer: null,
  dashLiveTimer: null,
  dashboardTab: uiPrefChoice('dashboardTab', ['transfers', 'images'], 'transfers'),
  dashPeriod: uiPrefChoice('dashPeriod', ['1', '7', '30', '90', '365', 'all'], '30'), // dashboard window
  dashDirection: uiPrefChoice('dashDirection', ['', 'down', 'up'], ''),
  dashStatus: uiPrefChoice('dashStatus', ['', 'completed', 'interrupted'], ''),
  dashType: uiPrefChoice('dashType', ['', 'file', 'folder', 'inbox', 'collab'], ''),
  dashQuery: uiPrefText('dashQuery'),
  dashFilterTimer: null,
  imagesDashData: null,
  imagesDashPeriod: uiPrefChoice('imagesDashPeriod', ['1', '7', '30', '90', '365', 'all'], '30'), // Images dashboard window
  imagesDashStatus: uiPrefChoice('imagesDashStatus', ['', 'active', 'expired', 'inactive'], ''),
  imagesDashFormat: uiPrefChoice('imagesDashFormat', ['', 'jpg', 'png', 'webp', 'gif', 'avif', 'bmp'], ''),
  imagesDashQuery: uiPrefText('imagesDashQuery'),
  imagesDashFilterTimer: null,  photosData: null,       // last photo-share list (for search/sort re-render + export)
  photoSearch: uiPrefText('photoSearch'), // gallery search query
  photoSort: uiPrefChoice('photoSort', ['new', 'old', 'name', 'views', 'size', 'dimensions'], 'new'),
  photoFormat: uiPrefChoice('photoFormat', ['', 'jpg', 'png', 'gif', 'webp', 'avif', 'bmp'], ''),
  photoOrientation: uiPrefChoice('photoOrientation', ['', 'landscape', 'portrait', 'square'], ''),
  photoVariants: uiPrefChoice('photoVariants', ['', 'ready', 'missing'], ''),
  photoAlbum: uiPrefText('photoAlbum'), // album share id | none
  photoFavoritesOnly: uiPrefs.photoFavoritesOnly === true,
  photoView: uiPrefChoice('photoView', ['grid', 'list'], 'grid'),
  photoDimsCache: {},     // token -> { w, h } (lazily fetched)
  photoSelection: new Set(), // share ids selected for bulk actions
  photoUploadBusy: false,
  albumsData: null,       // last album-share list (feature 18)
  lastAlbumsSig: '',      // structural signature of the albums list
  lastPhotoAlbumOptionsSig: '',
  meta: null,
  username: null,
  role: null, // 'owner' | 'admin'
  idleLockMinutes: 0, // auto-lock after inactivity (0 = off)
  idleTimer: null,
  idleActivityBound: false,
  idleLastReset: 0,
  settings: {}, // last settings snapshot (for the Configuration window)
};

const $ = (id) => document.getElementById(id);

function setControlValue(id, value) {
  const node = $(id);
  if (!node) return;
  if (node.tagName === 'SELECT' && ![...node.options].some((o) => o.value === value)) return;
  node.value = value;
}

function syncViewButtons(prefix, view) {
  ['list', 'grid'].forEach((mode) => {
    const button = $(prefix + '-view-' + mode);
    if (!button) return;
    const active = mode === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setShareView(view, persist = true) {
  state.shareView = view === 'grid' ? 'grid' : 'list';
  const list = $('shares-list');
  if (list) {
    list.classList.toggle('view-grid', state.shareView === 'grid');
    list.classList.toggle('view-list', state.shareView === 'list');
    list.dataset.view = state.shareView;
  }
  syncViewButtons('shares', state.shareView);
  if (persist) updateUiPrefs({ shareView: state.shareView });
}

function setPhotoView(view, persist = true) {
  state.photoView = view === 'list' ? 'list' : 'grid';
  const list = $('photos-list');
  if (list) {
    list.classList.toggle('view-list', state.photoView === 'list');
    list.classList.toggle('view-grid', state.photoView === 'grid');
    list.dataset.view = state.photoView;
  }
  syncViewButtons('photos', state.photoView);
  if (persist) updateUiPrefs({ photoView: state.photoView });
}

function applyUiPreferencesToControls() {
  setControlValue('shares-filter', state.shareFilter);
  setControlValue('shares-type', state.shareType);
  setControlValue('shares-status', state.shareStatus);
  setControlValue('shares-sort', state.shareSort);

  setControlValue('dash-direction-filter', state.dashDirection);
  setControlValue('dash-status-filter', state.dashStatus);
  setControlValue('dash-type-filter', state.dashType);
  setControlValue('dash-search-filter', state.dashQuery);
  document.querySelectorAll('#dash-period .dp-btn').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-days') === state.dashPeriod);
  });

  setControlValue('idash-status-filter', state.imagesDashStatus);
  setControlValue('idash-format-filter', state.imagesDashFormat);
  setControlValue('idash-search-filter', state.imagesDashQuery);
  document.querySelectorAll('#idash-period .dp-btn').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-days') === state.imagesDashPeriod);
  });

  setControlValue('photos-search', state.photoSearch);
  setControlValue('photos-sort', state.photoSort);
  setControlValue('photos-filter-format', state.photoFormat);
  setControlValue('photos-filter-orientation', state.photoOrientation);
  setControlValue('photos-filter-variants', state.photoVariants);
  const favorites = $('photos-favorites-toggle');
  if (favorites) {
    favorites.classList.toggle('active', state.photoFavoritesOnly);
    favorites.setAttribute('aria-pressed', state.photoFavoritesOnly ? 'true' : 'false');
  }

  setShareView(state.shareView, false);
  setPhotoView(state.photoView, false);
}
// Extensions the browser can play inline (mirrors the server's previewInfo()).
const PREVIEW_VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']);
function isPreviewableVideo(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return PREVIEW_VIDEO_EXTS.has(ext);
}
const REFRESH_MS = 3000;
const DASH_REFRESH_MS = 60000; // dashboard analytics refresh (reads the journal)
const DASH_LIVE_REFRESH_MS = 2000; // lightweight active-transfer refresh
const SHARE_DELETE_UNDO_MS = 5000;

// Translation: t('key', {param}); falls back to English, then the raw key.
function t(key, params) {
  const dict = I18N[state.lang] || I18N.en;
  let s = dict[key];
  if (s == null) s = I18N.en[key] != null ? I18N.en[key] : key;
  if (typeof s === 'string' && params) {
    for (const k in params) s = s.split('{' + k + '}').join(params[k]);
  }
  return s;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((e) => {
    e.textContent = t(e.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((e) => {
    e.placeholder = t(e.getAttribute('data-i18n-ph'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((e) => {
    e.title = t(e.getAttribute('data-i18n-title'));
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((e) => {
    e.setAttribute('aria-label', t(e.getAttribute('data-i18n-aria')));
  });
  if (state.albumsData) {
    state.lastPhotoAlbumOptionsSig = '';
    syncPhotoAlbumControls(state.albumsData);
  }
  applyBranding(); // re-apply the custom brand name over the freshly translated labels
}

// Applies the configured accent color (CSS variables) and brand name to the UI.
// Safe to call before settings load (falls back to the built-in defaults).
function applyBranding(s) {
  s = s || state.settings || {};
  const root = document.documentElement;
  if (s.accentColor && /^#[0-9a-fA-F]{6}$/.test(s.accentColor)) {
    root.style.setProperty('--accent', s.accentColor);
    root.style.setProperty('--accent-hover', s.accentColor);
    root.style.setProperty('--accent-soft', s.accentColor + '29');
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-hover');
    root.style.removeProperty('--accent-soft');
  }
  const name = (s.brandName && s.brandName.trim()) || '';
  if (name) {
    document.querySelectorAll('[data-i18n="app.name"]').forEach((el) => { el.textContent = name; });
    const an = document.querySelector('.about-name');
    if (an) an.textContent = name;
  }
}

// Applies the configured default admin language — but only once, and only when
// the user has never picked a language themselves (no stored preference).
let _adminLangApplied = false;
function maybeApplyAdminLang(s) {
  if (_adminLangApplied) return;
  _adminLangApplied = true;
  const def = s && s.adminLang;
  if (!def || !I18N[def]) return;
  let stored = null;
  try { stored = localStorage.getItem('lang'); } catch (_) {}
  if (!stored && state.lang !== def) setLang(def);
}

// One-time banner warning that the admin panel is reachable over plain HTTP from
// a non-local address (credentials would travel unencrypted).
let _httpsWarnShown = false;
function maybeShowHttpsWarning(s) {
  if (_httpsWarnShown || !s || s.httpsWarning === false) return;
  if (location.protocol !== 'http:') return;
  const h = location.hostname;
  const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
    || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /\.local$/.test(h);
  if (isLocal) return;
  _httpsWarnShown = true;
  const bar = document.createElement('div');
  bar.className = 'https-warn';
  bar.innerHTML = '<span></span><button type="button" aria-label="Dismiss">✕</button>';
  bar.querySelector('span').textContent = t('cfg.httpsBanner');
  bar.querySelector('button').addEventListener('click', () => bar.remove());
  document.body.appendChild(bar);
}

// Theme: 'dark' (default) | 'light' | 'auto'. Stored under 'dx-theme' and applied
// via the data-theme attribute (a matching pre-paint snippet in index.html sets it
// before first paint to avoid a flash).
function getTheme() {
  let theme = null;
  try { theme = localStorage.getItem('dx-theme') || uiPrefs.theme; } catch (_) {}
  return theme === 'light' || theme === 'auto' ? theme : 'dark';
}
function setTheme(theme) {
  if (theme !== 'light' && theme !== 'auto') theme = 'dark';
  try { localStorage.setItem('dx-theme', theme); } catch (_) {}
  updateUiPrefs({ theme });
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-select').forEach((s) => { s.value = theme; });
}

function setLang(lang) {
  if (!I18N[lang]) lang = 'en';
  state.lang = lang;
  try {
    localStorage.setItem('lang', lang);
  } catch (_) {}
  updateUiPrefs({ lang });
  document.documentElement.lang = lang;
  // Keep the active independent page reflected in the browser tab.
  document.title = dashboardsPageOpen()
    ? (t('app.name') + ' — ' + t('dashboards.title'))
    : imagesPageOpen()
      ? (t('app.name') + ' — ' + t('photo.title'))
      : t('app.docTitle');
  applyTranslations();
  updateLiveDot();
  document.querySelectorAll('.lang-select').forEach((s) => {
    s.value = lang;
  });
  // Re-rend le contenu dynamique dans la nouvelle langue.
  if (isLoggedIn()) {
    // Force every guarded view to re-render in the new language.
    state.lastSharesJson = state.lastSettingsJson = state.lastTransfersJson = '';
    renderHistoryPage();
    refreshShares();
    loadNetwork();
    renderDashboard(); // re-label charts/KPIs from cached data (no refetch)
    renderImagesDashboard(); // same, for the Images dashboard
    if (!$('about-overlay').classList.contains('hidden')) populateAbout(); // re-localize the date
  }
}

// ------------------------------------------------------------------
// API client (CSRF + session handling)
// ------------------------------------------------------------------
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (!['GET', 'HEAD'].includes(method) && state.csrf) {
    opts.headers['X-CSRF-Token'] = state.csrf;
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error('not-authenticated');
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || 'error');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------------
function toast(msg, kind) {
  const el2 = $('toast');
  el2.textContent = msg;
  el2.className = 'toast ' + (kind || '');
  el2.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el2.classList.add('hidden'), 2600);
}

function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '—';
  const units = (I18N[state.lang] || I18N.en)['units.bytes'];
  let n = Number(bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return n.toFixed(u === 0 ? 0 : 1) + ' ' + units[u];
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  const units = (I18N[state.lang] || I18N.en)['units.bytes'];
  let n = bps;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return n.toFixed(u === 0 ? 0 : 1) + ' ' + units[u] + '/s';
}

function formatDuration(ms) {
  const s = Math.floor((ms || 0) / 1000);
  if (s < 60) return s + ' ' + t('time.s');
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ' ' + t('time.min') + (r ? ' ' + r + ' ' + t('time.s') : '');
}

// Estimated time remaining (seconds) → "~HH:MM:SS".
function formatEta(sec) {
  sec = Math.max(0, Math.ceil(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return '~' + pad(h) + ':' + pad(m) + ':' + pad(s);
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  let v;
  if (sec < 60) v = sec + ' ' + t('time.s');
  else {
    const m = Math.floor(sec / 60);
    if (m < 60) v = m + ' ' + t('time.min');
    else {
      const h = Math.floor(m / 60);
      if (h < 24) v = h + ' ' + t('time.h');
      else v = Math.floor(h / 24) + ' ' + t('time.d');
    }
  }
  return t('time.ago', { v });
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(LOCALES[state.lang] || 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function el(tag, opts = {}) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  if (opts.text != null) e.textContent = opts.text;
  if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
  return e;
}

function isLoggedIn() {
  return ['app-view', 'images-page', 'dashboards-page'].some((id) => {
    const view = $(id);
    return !!view && !view.classList.contains('hidden');
  });
}

function countryText(country) {
  if (country === 'Local network' || country === 'Réseau local') return t('tr.localNetwork');
  return country || t('tr.locating');
}

// ------------------------------------------------------------------
// Views
// ------------------------------------------------------------------
function showLogin() {
  stopPolling();
  stopDashboardAutoRefresh();
  closeUserMenu();
  placeUserMenu('admin');
  ['images-page', 'dashboards-page'].forEach((id) => {
    const page = $(id);
    if (page) page.classList.add('hidden');
  });
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  showTotpRow(false);
  $('login-error').classList.add('hidden');
  // Prefill the last-used username for convenience.
  let last = '';
  try { last = localStorage.getItem('dxuser') || ''; } catch (_) {}
  if (last && !$('username').value) $('username').value = last;
  ($('username').value ? $('password') : $('username')).focus();
}
function showApp() {
  $('login-view').classList.add('hidden');
  ['images-page', 'dashboards-page'].forEach((id) => {
    const page = $(id);
    if (page) page.classList.add('hidden');
  });
  placeUserMenu('admin');
  $('app-view').classList.remove('hidden');
  applyRole(state.role);
  maybeRedirectNext();
}

// After sign-in, honor a ?next= return path set by the /app gate — but only for
// same-origin /app paths (defends against open-redirects / protocol-relative URLs).
function maybeRedirectNext() {
  try {
    const next = new URLSearchParams(location.search).get('next');
    if (!next || !/^\/app(\/|$)/.test(next) || next.includes('\\')) return;
    const target = new URL(next, location.origin);
    if (target.origin !== location.origin || !/^\/app(\/|$)/.test(target.pathname)) return;
    const safeNext = target.pathname + target.search + target.hash;
    // Both the normalized origin and normalized pathname are constrained above.
    location.replace(safeNext); // nosemgrep: javascript.browser.security.open-redirect.js-open-redirect
  } catch (_) {}
}

// Shows/hides owner-only controls and refreshes the current username label.
// Kept separate from applyRole(role) so the two responsibilities cannot
// overwrite each other through duplicate JavaScript function declarations.
function applySessionIdentity() {
  const isOwner = state.role === 'owner';
  const accBtn = $('accounts-btn');
  if (accBtn) accBtn.classList.toggle('hidden', !isOwner);
  document.querySelectorAll('.current-username').forEach((e) => { e.textContent = state.username || ''; });
}

// ------------------------------------------------------------------
// Login
// ------------------------------------------------------------------
function showTotpRow(show) {
  $('login-totp-row').classList.toggle('hidden', !show);
  if (!show) $('login-totp').value = '';
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('login-error');
  errEl.classList.add('hidden');
  const username = $('username').value.trim();
  const password = $('password').value;
  const totp = $('login-totp').value.trim();
  const body = { username, password };
  if (totp) body.totp = totp;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.csrf) {
      state.csrf = data.csrf;
      state.username = data.username;
      state.role = data.role;
      try { localStorage.setItem('dxuser', username); } catch (_) {} // convenience prefill
      $('password').value = '';
      showTotpRow(false);
      enterApp(data.mustChangePassword);
    } else if (res.status === 429) {
      errEl.textContent = t('login.tooMany', { s: data.retryAfter || 60 });
      errEl.classList.remove('hidden');
    } else if (data.error === 'totp-required') {
      // Password is correct; ask for the 2FA code and keep it entered.
      showTotpRow(true);
      $('login-totp').focus();
    } else if (data.error === 'invalid-totp') {
      showTotpRow(true);
      errEl.textContent = t('login.totpInvalid');
      errEl.classList.remove('hidden');
      $('login-totp').focus();
    } else {
      showTotpRow(false);
      // Base message + any server-provided diagnostic hints (config-based, so they
      // reveal nothing about which usernames exist). Built with textContent/DOM
      // nodes — no HTML injection possible.
      errEl.textContent = t('login.invalid');
      const hints = Array.isArray(data.hints) ? data.hints : [];
      for (const h of hints) {
        const key = 'login.hint.' + h;
        const msg = t(key);
        if (!msg || msg === key) continue; // unknown code: skip
        const div = document.createElement('div');
        div.textContent = msg;
        div.style.cssText = 'margin-top:6px;font-size:.85em;opacity:.85;line-height:1.35';
        errEl.appendChild(div);
      }
      errEl.classList.remove('hidden');
    }
  } catch (_) {
    errEl.textContent = t('login.connError');
    errEl.classList.remove('hidden');
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/logout');
  } catch (_) {}
  state.csrf = null;
  showLogin();
});

// --- Shut down the server (user menu) ---
$('shutdown-server-btn').addEventListener('click', async () => {
  closeUserMenu();
  if (!confirm(t('menu.shutdownConfirm'))) return;
  try {
    // The server answers before it actually closes, so this request succeeds.
    await api('POST', '/api/shutdown');
    stopPolling();
    toast(t('menu.shutdownDone'), 'warn');
    state.connLost = true;
    showBanner(t('sh.connLost'));
  } catch (e) {
    if (e.message !== 'not-authenticated') toast(t('menu.shutdownFail'), 'err');
  }
});

// --- User menu (account icon) ---
// Reuse the exact same menu on all full-page views. Moving the existing node
// keeps one set of IDs/listeners and avoids account menus drifting apart.
function placeUserMenu(view) {
  if (view === true) view = 'images'; // compatibility with the previous boolean API
  if (!view || view === false) view = 'admin';
  const menu = document.querySelector('.user-menu');
  const targets = {
    admin: '#app-view .topbar-menus',
    images: '#images-page .topbar-menus',
    dashboards: '#dashboards-page .topbar-menus',
  };
  const target = document.querySelector(targets[view] || targets.admin);
  if (menu && target && menu.parentElement !== target) target.appendChild(menu);
  applySessionIdentity();
}
function closeUserMenu() {
  $('user-dropdown').classList.add('hidden');
}
$('user-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeDashMenu();
  $('user-dropdown').classList.toggle('hidden');
});
// Close on outside clicks only — a click inside the menu (e.g. the language
// selector) must not dismiss it, otherwise the dropdown is unusable.
document.addEventListener('click', (e) => {
  if (e.target.closest && e.target.closest('.user-menu')) return;
  closeUserMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeUserMenu();
});

// --- Dashboards page — independent full admin sub-page -----------------------
const DASHBOARDS_PATH = '/dashboards';

function dashboardsPageOpen() {
  const page = $('dashboards-page');
  return !!page && !page.classList.contains('hidden');
}

function dashboardTabFromUrl() {
  try {
    const tab = new URLSearchParams(location.search).get('tab');
    if (tab === 'images' || tab === 'transfers') return tab;
  } catch (_) {}
  return state.dashboardTab;
}

function activeDashboardTab() {
  return $('dashboard-images-tab') && $('dashboard-images-tab').classList.contains('active')
    ? 'images'
    : 'transfers';
}

function stopDashboardAutoRefresh() {
  if (state.dashTimer) {
    clearInterval(state.dashTimer);
    state.dashTimer = null;
  }
  if (state.dashLiveTimer) {
    clearInterval(state.dashLiveTimer);
    state.dashLiveTimer = null;
  }
}

function startDashboardAutoRefresh(tab) {
  stopDashboardAutoRefresh();
  tab = tab === 'images' ? 'images' : 'transfers';
  if (tab === 'images') {
    loadImagesDashboard();
    state.dashTimer = setInterval(loadImagesDashboard, DASH_REFRESH_MS);
    return;
  }
  loadDashboard();
  loadDashboardLive();
  state.dashTimer = setInterval(loadDashboard, DASH_REFRESH_MS);
  state.dashLiveTimer = setInterval(loadDashboardLive, DASH_LIVE_REFRESH_MS);
}

function setDashboardTab(tab, updateUrl = true) {
  tab = tab === 'images' ? 'images' : 'transfers';
  state.dashboardTab = tab;
  updateUiPrefs({ dashboardTab: tab });
  const transfersView = $('dashboard-transfers-view');
  const imagesView = $('dashboard-images-view');
  const transfersTab = $('dashboard-transfers-tab');
  const imagesTab = $('dashboard-images-tab');
  if (!transfersView || !imagesView || !transfersTab || !imagesTab) return;

  transfersView.classList.toggle('hidden', tab !== 'transfers');
  imagesView.classList.toggle('hidden', tab !== 'images');
  transfersTab.classList.toggle('active', tab === 'transfers');
  imagesTab.classList.toggle('active', tab === 'images');
  transfersTab.setAttribute('aria-selected', tab === 'transfers' ? 'true' : 'false');
  imagesTab.setAttribute('aria-selected', tab === 'images' ? 'true' : 'false');
  startDashboardAutoRefresh(tab);

  if (updateUrl && dashboardsPageOpen() && location.pathname === DASHBOARDS_PATH) {
    const url = DASHBOARDS_PATH + (tab === 'images' ? '?tab=images' : '');
    try { history.replaceState({ dxView: 'dashboards', dashTab: tab }, '', url); } catch (_) {}
  }
}

function showDashboardsView(tab = state.dashboardTab) {
  closeUserMenu();
  const imagesPage = $('images-page');
  if (imagesPage) imagesPage.classList.add('hidden');
  $('app-view').classList.add('hidden');
  placeUserMenu('dashboards');
  $('dashboards-page').classList.remove('hidden');
  setDashboardTab(tab, false);
  document.title = t('app.name') + ' — ' + t('dashboards.title');
  window.scrollTo(0, 0);
}

function hideDashboardsView(showHome = true) {
  const page = $('dashboards-page');
  if (!page) return;
  stopDashboardAutoRefresh();
  closeUserMenu();
  page.classList.add('hidden');
  if (showHome) {
    placeUserMenu('admin');
    $('app-view').classList.remove('hidden');
    document.title = t('app.docTitle');
  }
}

function openDashboardsPage(tab = state.dashboardTab) {
  tab = tab === 'images' ? 'images' : 'transfers';
  showDashboardsView(tab);
  const url = DASHBOARDS_PATH + (tab === 'images' ? '?tab=images' : '');
  try { history.pushState({ dxView: 'dashboards', dashTab: tab }, '', url); } catch (_) {}
}

function closeDashboardsPage() {
  if (!dashboardsPageOpen()) return;
  if (history.state && history.state.dxView === 'dashboards') {
    history.back();
  } else {
    hideDashboardsView();
    if (location.pathname === DASHBOARDS_PATH) {
      try { history.replaceState({ dxView: 'home' }, '', '/'); } catch (_) {}
    }
  }
}

// Compatibility for existing callers that used to close the dropdown.
function closeDashMenu() {}

if ($('dash-btn')) $('dash-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  openDashboardsPage(state.dashboardTab);
});
if ($('dashboards-back')) $('dashboards-back').addEventListener('click', closeDashboardsPage);
if ($('dashboard-transfers-tab')) $('dashboard-transfers-tab').addEventListener('click', () => setDashboardTab('transfers'));
if ($('dashboard-images-tab')) $('dashboard-images-tab').addEventListener('click', () => setDashboardTab('images'));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !dashboardsPageOpen()) return;
  if (document.querySelector('.overlay:not(.hidden)')) return;
  closeDashboardsPage();
});

// --- Images page (topbar icon) — its own full admin sub-page (<main id="images-page">),
// swapped in place of the main admin view; not a dropdown. It is a real, URL-addressable
// page at /images: opening it pushes that path, the browser Back button and Escape close
// it, and a direct hit or reload on /images (the server serves the same index.html)
// reopens it. Direct image links, an optional separate image domain, and external-access
// / reverse-proxy tests live here. ---
const IMAGES_PATH = '/images';

function imagesPageOpen() {
  const p = $('images-page');
  return !!p && !p.classList.contains('hidden');
}
// Prefill the domain / hotlink inputs from the current settings, skipping any field
// the user is actively editing so a background poll (or a late-arriving first poll on
// a direct /images load) can't clobber a half-typed value.
function syncImageSettingsFields() {
  const s = state.settings || {};
  const baseInp = $('image-base'), sslInp = $('image-ssl'), hlInp = $('image-hotlink');
  const m = /^(https?):\/\/(.+)$/i.exec(s.imageBase || '');
  if (baseInp && document.activeElement !== baseInp) {
    const host = m ? m[2] : '';
    if (baseInp.value !== host) baseInp.value = host;
    if (sslInp) sslInp.checked = m ? m[1].toLowerCase() === 'https' : false;
  }
  if (hlInp && document.activeElement !== hlInp) {
    hlInp.value = Array.isArray(s.imageHotlinkHosts) ? s.imageHotlinkHosts.join(', ') : '';
  }
}
// DOM-only view swap (no history side effects) — used by the URL sync too.
function showImagesView() {
  syncImageSettingsFields();
  closeUserMenu();
  stopDashboardAutoRefresh();
  const dashboardsPage = $('dashboards-page');
  if (dashboardsPage) dashboardsPage.classList.add('hidden');
  $('app-view').classList.add('hidden');
  placeUserMenu('images');
  $('images-page').classList.remove('hidden');
  loadPhotoHistory();
  document.title = t('app.name') + ' — ' + t('photo.title');
  window.scrollTo(0, 0);
}
function hideImagesView(showHome = true) {
  const page = $('images-page');
  if (!page) return;
  closeUserMenu();
  page.classList.add('hidden');
  if (showHome) {
    placeUserMenu('admin');
    $('app-view').classList.remove('hidden');
    document.title = t('app.docTitle');
  }
}
// Navigate INTO the Images page: show it and push /images so it gets a real,
// shareable URL and its own history entry (Back returns to where we came from).
function openImagesPage() {
  if (imagesPageOpen()) return;
  showImagesView();
  try {
    if (location.pathname !== IMAGES_PATH) history.pushState({ dxView: 'images' }, '', IMAGES_PATH);
  } catch (_) {}
}
// Navigate OUT of the Images page. If we arrived via our own pushState, step back in
// history (keeps Forward working); otherwise (e.g. a direct load of /images) just hide
// it and rewrite the URL to the home path in place.
function closeImagesPage() {
  if (!imagesPageOpen()) return;
  if (history.state && history.state.dxView === 'images') {
    history.back(); // → popstate handler hides the view and restores the URL
  } else {
    hideImagesView();
    if (location.pathname === IMAGES_PATH) {
      try { history.replaceState({ dxView: 'home' }, '', '/'); } catch (_) {}
    }
  }
}
// Keep all independent admin pages synchronized with Back, Forward and reload.
function syncAdminRouteFromUrl() {
  if (!isLoggedIn()) return;

  if (location.pathname === DASHBOARDS_PATH) {
    showDashboardsView(dashboardTabFromUrl());
    return;
  }
  if (location.pathname === IMAGES_PATH) {
    showImagesView();
    return;
  }

  hideDashboardsView(false);
  hideImagesView(false);
  placeUserMenu('admin');
  $('app-view').classList.remove('hidden');
  document.title = t('app.docTitle');
}

window.addEventListener('popstate', syncAdminRouteFromUrl);

function maybeOpenAdminSubpageFromUrl() {
  syncAdminRouteFromUrl();
}
// Compatibility with older internal callers.
function maybeOpenImagesFromUrl() {
  maybeOpenAdminSubpageFromUrl();
}
if ($('images-btn')) $('images-btn').addEventListener('click', (e) => { e.stopPropagation(); openImagesPage(); });
if ($('images-back')) $('images-back').addEventListener('click', closeImagesPage);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Escape must reach whatever modal is stacked on top of the Images page first
  // (lightbox, file picker, QR…) instead of tearing the whole page down beneath
  // it. Only leave the page when nothing else is open.
  if (document.querySelector('.overlay:not(.hidden)')) return;
  closeImagesPage();
});

// Save / reset the optional image domain (mirrors the main link-domain field).
async function saveImageBase() {
  const host = $('image-base').value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const imageBase = host ? (($('image-ssl').checked ? 'https://' : 'http://') + host) : '';
  state.settingsDirtyUntil = Date.now() + 3000; state.settingsEpoch++;
  try {
    const s = await api('POST', '/api/settings', { imageBase });
    const m = /^(https?):\/\/(.+)$/i.exec(s.imageBase || '');
    $('image-base').value = m ? m[2] : '';
    $('image-ssl').checked = m ? m[1].toLowerCase() === 'https' : false;
    toast(s.imageBase ? t('img.domainSaved') : t('img.autoRestored'), 'ok');
    refreshShares(); // photo URLs rebuild with the new base
  } catch (e) {
    toast(e.data && e.data.error === 'invalid-domain' ? t('net.domainInvalid') : t('net.saveError'), 'err');
  }
}
if ($('image-base-save')) $('image-base-save').addEventListener('click', saveImageBase);
if ($('image-base-reset')) $('image-base-reset').addEventListener('click', () => { $('image-base').value = ''; $('image-ssl').checked = false; saveImageBase(); });

// Save / reset the anti-hotlink allowlist (feature 19). The server normalizes the
// raw comma/space list into an array of hosts and echoes it back for display.
async function saveImageHotlink() {
  const raw = $('image-hotlink').value || '';
  state.settingsDirtyUntil = Date.now() + 3000; state.settingsEpoch++;
  try {
    const s = await api('POST', '/api/settings', { imageHotlinkHosts: raw });
    const hosts = Array.isArray(s.imageHotlinkHosts) ? s.imageHotlinkHosts : [];
    if (state.settings) state.settings.imageHotlinkHosts = hosts;
    $('image-hotlink').value = hosts.join(', ');
    toast(hosts.length ? t('img.hotlinkSaved') : t('img.hotlinkCleared'), 'ok');
  } catch (e) { toast(t('net.saveError'), 'err'); }
}
if ($('image-hotlink-save')) $('image-hotlink-save').addEventListener('click', saveImageHotlink);
if ($('image-hotlink-reset')) $('image-hotlink-reset').addEventListener('click', () => { $('image-hotlink').value = ''; saveImageHotlink(); });

// External-access test for the image domain (the field value, even unsaved).
function imageBaseFromField() {
  const host = $('image-base').value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return host ? (($('image-ssl').checked ? 'https://' : 'http://') + host) : '';
}
if ($('img-port-test-btn')) $('img-port-test-btn').addEventListener('click', async () => {
  const btn = $('img-port-test-btn'), statusEl = $('img-port-status'), hint = $('img-port-hint');
  btn.disabled = true; statusEl.textContent = t('net.testing'); statusEl.className = 'net-value warn'; hint.classList.add('hidden');
  try {
    const r = await api('POST', '/api/network/port-check', { base: imageBaseFromField() });
    const label = r.label || (r.host ? r.host + ':' + r.port : t('net.theTarget'));
    if (r.open === true) { statusEl.textContent = t('net.accessible'); statusEl.className = 'net-value ok'; hint.textContent = t('net.hintAccessible', { label, open: r.openNodes, total: r.total }); }
    else if (r.open === false) { statusEl.textContent = t('net.unreachable'); statusEl.className = 'net-value bad'; hint.textContent = t('net.hintUnreachable', { label }); }
    else { statusEl.textContent = t('net.undetermined'); statusEl.className = 'net-value warn'; hint.textContent = t('net.hintUndetermined', { error: r.error || '?' }); }
    hint.classList.remove('hidden');
  } catch (e) { statusEl.textContent = t('net.error'); statusEl.className = 'net-value bad'; }
  finally { btn.disabled = false; }
});
if ($('img-proxy-test-btn')) $('img-proxy-test-btn').addEventListener('click', async () => {
  const btn = $('img-proxy-test-btn'), box = $('img-proxy-result');
  btn.disabled = true; box.classList.remove('hidden'); box.textContent = '';
  box.appendChild(el('p', { class: 'muted sm', text: t('proxy.testing') }));
  try {
    // Always send the Images-page field, including an explicit empty value.
    // The server then probes the effective image base instead of diagnosing the
    // domain used to open the admin interface.
    const base = imageBaseFromField();
    const r = await api('GET', '/api/network/proxy-check?base=' + encodeURIComponent(base));
    renderProxyResult(r, box);
  }
  catch (e) { box.textContent = ''; box.appendChild(el('p', { class: 'error', text: t('proxy.error') })); }
  finally { btn.disabled = false; }
});

// --- Language selectors ---
document.querySelectorAll('.lang-select').forEach((sel) => {
  sel.value = state.lang;
  sel.addEventListener('change', (e) => setLang(e.target.value));
});

// --- Theme selectors (dark default, persisted per browser) ---
document.querySelectorAll('.theme-select').forEach((sel) => {
  sel.value = getTheme();
  sel.addEventListener('change', (e) => setTheme(e.target.value));
});

// --- Change password ---
$('change-pw-btn').addEventListener('click', () => {
  closeUserMenu();
  openPwModal();
});
$('pw-close').addEventListener('click', closePwModal);
$('pw-cancel').addEventListener('click', closePwModal);
$('pw-overlay').addEventListener('click', (e) => {
  if (e.target === $('pw-overlay')) closePwModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('pw-overlay').classList.contains('hidden')) closePwModal();
});

// --- About dialog ---
function populateAbout() {
  const m = state.meta || {};
  $('about-version').textContent = m.version ? 'v' + m.version : '—';
  let rel = '—';
  if (m.releaseDate) {
    const d = new Date(m.releaseDate);
    if (!isNaN(d.getTime())) {
      rel = d.toLocaleDateString(state.lang, { year: 'numeric', month: 'long', day: 'numeric' });
    }
  }
  $('about-released').textContent = rel;
}
function openAboutModal() {
  closeUserMenu();
  populateAbout();
  $('about-overlay').classList.remove('hidden');
  if (!state.meta) loadMeta().then(populateAbout); // first open before meta loaded
}
function closeAboutModal() {
  $('about-overlay').classList.add('hidden');
}
$('about-btn').addEventListener('click', openAboutModal);
$('about-close').addEventListener('click', closeAboutModal);
$('about-overlay').addEventListener('click', (e) => {
  if (e.target === $('about-overlay')) closeAboutModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('about-overlay').classList.contains('hidden')) closeAboutModal();
});

function openPwModal(forced) {
  state.forcedPw = !!forced;
  $('pw-current').value = '';
  $('pw-new').value = '';
  $('pw-confirm').value = '';
  $('pw-error').classList.add('hidden');
  // Changement obligatoire au 1er login : ni annulation, ni mot de passe actuel.
  $('pw-close').classList.toggle('hidden', !!forced);
  $('pw-cancel').classList.toggle('hidden', !!forced);
  $('pw-current').classList.toggle('hidden', !!forced);
  $('pw-current').required = !forced;
  $('pw-first-hint').classList.toggle('hidden', !forced);
  $('pw-title').textContent = t(forced ? 'pw.firstTitle' : 'pw.title');
  $('pw-overlay').classList.remove('hidden');
  (forced ? $('pw-new') : $('pw-current')).focus();
}
function closePwModal() {
  if (state.forcedPw) return; // the mandatory change cannot be cancelled
  $('pw-overlay').classList.add('hidden');
}

// After authentication: either force the password change, or enter the app.
function enterApp(mustChange) {
  if (mustChange) {
    $('login-view').classList.add('hidden');
    $('app-view').classList.add('hidden');
    openPwModal(true);
  } else {
    showApp();
    init();
  }
}

$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('pw-error');
  err.classList.add('hidden');
  const current = $('pw-current').value;
  const next = $('pw-new').value;
  const confirmPw = $('pw-confirm').value;
  if (next.length < 8) {
    err.textContent = t('pw.tooShort');
    err.classList.remove('hidden');
    return;
  }
  if (next !== confirmPw) {
    err.textContent = t('pw.mismatch');
    err.classList.remove('hidden');
    return;
  }
  try {
    const r = await api('POST', '/api/password', { currentPassword: current, newPassword: next });
    const wasForced = state.forcedPw;
    state.forcedPw = false;
    closePwModal();
    if (r && r.persisted === false) toast(t('pw.changedTemp'), 'warn');
    else toast(t('pw.changed'), 'ok');
    if (wasForced) {
      showApp();
      init();
    }
  } catch (e2) {
    const code = e2.data && e2.data.error;
    err.textContent =
      code === 'invalid-current-password'
        ? t('pw.currentWrong')
        : code === 'env-managed'
          ? t('pw.envManaged')
          : code === 'too-short'
            ? t('pw.tooShort')
            : t('pw.changeFail');
    err.classList.remove('hidden');
  }
});

// ------------------------------------------------------------------
// Two-factor authentication (2FA / TOTP)
// ------------------------------------------------------------------
function tfaShowView(name) {
  ['status', 'enable', 'recovery', 'disable'].forEach((v) => {
    $('tfa-' + v + '-view').classList.toggle('hidden', v !== name);
  });
}

async function openTfaModal() {
  closeUserMenu();
  $('tfa-enable-error').classList.add('hidden');
  $('tfa-disable-error').classList.add('hidden');
  $('tfa-code').value = '';
  $('tfa-disable-pw').value = '';
  $('tfa-overlay').classList.remove('hidden');
  try {
    const st = await api('GET', '/api/2fa/status');
    $('tfa-status').textContent = t(st.enabled ? 'tfa.statusOn' : 'tfa.statusOff');
    $('tfa-enable-btn').classList.toggle('hidden', !!st.enabled);
    $('tfa-disable-btn').classList.toggle('hidden', !st.enabled);
    tfaShowView('status');
  } catch (e) {
    if (e.message !== 'not-authenticated') toast(t('tfa.genFail'), 'err');
    closeTfaModal();
  }
}
function closeTfaModal() {
  $('tfa-overlay').classList.add('hidden');
}

$('twofactor-btn').addEventListener('click', openTfaModal);
$('tfa-close').addEventListener('click', closeTfaModal);
$('tfa-overlay').addEventListener('click', (e) => {
  if (e.target === $('tfa-overlay')) closeTfaModal();
});

// Begin enrollment: fetch a fresh secret + QR, show the verify step.
$('tfa-enable-btn').addEventListener('click', async () => {
  try {
    const d = await api('POST', '/api/2fa/setup');
    $('tfa-secret').textContent = d.secret;
    $('tfa-qr').src = '/api/qr?data=' + encodeURIComponent(d.otpauth);
    $('tfa-code').value = '';
    $('tfa-enable-error').classList.add('hidden');
    // Stash the recovery codes to reveal after the code is verified.
    state.pendingRecovery = d.recoveryCodes || [];
    tfaShowView('enable');
    $('tfa-code').focus();
  } catch (e) {
    if (e.message !== 'not-authenticated') toast(t('tfa.genFail'), 'err');
  }
});
$('tfa-enable-cancel').addEventListener('click', () => tfaShowView('status'));

$('tfa-enable-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('tfa-enable-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/api/2fa/enable', { code: $('tfa-code').value.trim() });
    // Reveal the recovery codes once, then done.
    const list = $('tfa-recovery-list');
    list.textContent = '';
    (state.pendingRecovery || []).forEach((c) => list.appendChild(el('li', { text: c })));
    state.pendingRecovery = null;
    tfaShowView('recovery');
  } catch (e2) {
    if (e2.message === 'not-authenticated') return;
    err.textContent = (e2.data && e2.data.error) === 'invalid-code' ? t('tfa.wrongCode') : t('tfa.genFail');
    err.classList.remove('hidden');
  }
});

$('tfa-recovery-done').addEventListener('click', () => {
  toast(t('tfa.enabled'), 'ok');
  closeTfaModal();
});

$('tfa-disable-btn').addEventListener('click', () => {
  $('tfa-disable-pw').value = '';
  $('tfa-disable-error').classList.add('hidden');
  tfaShowView('disable');
  $('tfa-disable-pw').focus();
});
$('tfa-disable-cancel').addEventListener('click', () => tfaShowView('status'));

$('tfa-disable-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('tfa-disable-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/api/2fa/disable', { password: $('tfa-disable-pw').value });
    toast(t('tfa.disabled'), 'ok');
    closeTfaModal();
  } catch (e2) {
    if (e2.message === 'not-authenticated') return;
    err.textContent =
      (e2.data && e2.data.error) === 'invalid-current-password' ? t('tfa.wrongPw') : t('tfa.genFail');
    err.classList.remove('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('tfa-overlay').classList.contains('hidden')) closeTfaModal();
});

// ------------------------------------------------------------------
// Dashboard (analytics + hand-drawn SVG charts, no external libraries)
// ------------------------------------------------------------------
function dashEsc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function transferDashboardQuery() {
  const p = new URLSearchParams({ days: state.dashPeriod });
  if (state.dashDirection) p.set('direction', state.dashDirection);
  if (state.dashStatus) p.set('status', state.dashStatus);
  if (state.dashType) p.set('type', state.dashType);
  if (state.dashQuery) p.set('q', state.dashQuery);
  return p.toString();
}

function imagesDashboardQuery() {
  const p = new URLSearchParams({ days: state.imagesDashPeriod });
  if (state.imagesDashStatus) p.set('status', state.imagesDashStatus);
  if (state.imagesDashFormat) p.set('format', state.imagesDashFormat);
  if (state.imagesDashQuery) p.set('q', state.imagesDashQuery);
  return p.toString();
}

async function loadDashboard() {
  try {
    const [data, proxy] = await Promise.all([
      api('GET', '/api/dashboard?' + transferDashboardQuery()),
      api('GET', '/api/network/proxy-check').catch(() => null),
    ]);
    data.proxy = proxy;
    state.dashboardData = data;
    renderDashboard();
  } catch (e) {
    // A transient failure keeps the previous render rather than blanking it.
    if (e.message === 'not-authenticated') return;
  }
}

async function loadDashboardLive() {
  if (!dashboardsPageOpen() || activeDashboardTab() !== 'transfers') return;
  try {
    state.dashboardLiveData = await api('GET', '/api/dashboard/live');
    renderDashboardLive();
  } catch (e) {
    if (e.message === 'not-authenticated') return;
  }
}


function dashboardAlertIcon(level) {
  return level === 'critical' ? '⛔' : level === 'warning' ? '⚠️' : 'ℹ️';
}

function dashboardAlertKey(kind, code) {
  return `p3.alert.${kind}.${code}`;
}

function renderAutomaticAlerts(id, countId, alerts) {
  const box = $(id);
  const count = $(countId);
  if (!box) return;
  const rows = Array.isArray(alerts) ? alerts : [];
  if (count) count.textContent = String(rows.length);
  if (!rows.length) {
    box.innerHTML = `<div class="dash-health dash-health-ok"><span class="dash-health-dot"></span><div><strong>${dashEsc(t('p3.noAlerts'))}</strong><span>${dashEsc(t('p3.noAlertsHelp'))}</span></div></div>`;
    return;
  }
  box.innerHTML = rows.map((a) => {
    const level = ['critical', 'warning', 'info'].includes(a.level) ? a.level : 'info';
    const titleKey = dashboardAlertKey('title', a.code);
    const detailKey = dashboardAlertKey('detail', a.code);
    const title = t(titleKey, a.params || {});
    const detail = t(detailKey, a.params || {});
    return `<div class="dashboard-alert dashboard-alert-${level}"><span class="dashboard-alert-icon">${dashboardAlertIcon(level)}</span><div><strong>${dashEsc(title === titleKey ? a.code : title)}</strong><span>${dashEsc(detail === detailKey ? '' : detail)}</span></div></div>`;
  }).join('');
}

function transferAlerts(d) {
  const rows = [...(d.alerts || [])];
  const live = state.dashboardLiveData || {};
  if ((live.stalledCount || 0) > 0) rows.push({ level: 'critical', code: 'stalled', params: { n: live.stalledCount, v: formatDuration(live.stallThresholdMs || 45000) } });
  if (d.proxy && d.proxy.verdict === 'bad') rows.push({ level: 'critical', code: 'proxy-bad', params: {} });
  else if (d.proxy && d.proxy.verdict === 'warn') rows.push({ level: 'warning', code: 'proxy-warn', params: {} });
  return rows;
}

function imageAlerts(d) {
  const rows = [...(d.alerts || [])];
  if (d.proxy && d.proxy.verdict === 'bad') rows.push({ level: 'critical', code: 'proxy-bad', params: {} });
  else if (d.proxy && d.proxy.verdict === 'warn') rows.push({ level: 'warning', code: 'proxy-warn', params: {} });
  return rows;
}

function comparisonChange(change, suffix = '%') {
  if (!change) return '';
  if (change.pct == null) return `<span class="comparison-change up">↗ ${dashEsc(t('p3.newValue'))}</span>`;
  const n = Number(change.pct) || 0;
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  const icon = n > 0 ? '↗' : n < 0 ? '↘' : '→';
  return `<span class="comparison-change ${cls}">${icon} ${dashEsc(Math.abs(n).toLocaleString())}${suffix}</span>`;
}

function renderComparison(id, c, kind) {
  const box = $(id);
  if (!box) return;
  if (!c || !c.available) { box.innerHTML = `<div class="empty sm">${dashEsc(t('p3.noComparison'))}</div>`; return; }
  const transfer = kind === 'transfer';
  const metrics = transfer ? [
    { key: 'transfers', label: t('p3.transfers'), value: (v) => (v || 0).toLocaleString() },
    { key: 'bytes', label: t('p3.volume'), value: (v) => formatBytes(v || 0) },
    { key: 'successRate', label: t('p3.success'), value: (v) => (v || 0) + '%', points: true },
    { key: 'avgBps', label: t('p3.speed'), value: (v) => fmtBps(v || 0) },
  ] : [
    { key: 'images', label: t('p3.imagesAdded'), value: (v) => (v || 0).toLocaleString() },
    { key: 'bytes', label: t('p3.storageAdded'), value: (v) => formatBytes(v || 0) },
    { key: 'avgSize', label: t('p3.averageSize'), value: (v) => formatBytes(v || 0) },
  ];
  box.innerHTML = metrics.map((m) => {
    const cur = c.current && c.current[m.key] || 0;
    const prev = c.previous && c.previous[m.key] || 0;
    const change = c.changes && c.changes[m.key];
    const changeHtml = m.points && change ? `<span class="comparison-change ${change.delta > 0 ? 'up' : change.delta < 0 ? 'down' : 'flat'}">${change.delta > 0 ? '↗' : change.delta < 0 ? '↘' : '→'} ${dashEsc(Math.abs(change.delta))} pt</span>` : comparisonChange(change);
    return `<div class="comparison-row"><div><strong>${dashEsc(m.label)}</strong><span>${dashEsc(t('p3.currentPeriod'))}: ${dashEsc(m.value(cur))} · ${dashEsc(t('p3.previousPeriod'))}: ${dashEsc(m.value(prev))}</span></div>${changeHtml}</div>`;
  }).join('');
}

function renderTransferUsers(rows) {
  const box = $('dash-users');
  if (!box) return;
  if (!rows || !rows.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('p3.noUsers'))}</div>`; return; }
  const max = Math.max(1, ...rows.map((r) => r.bytes || 0));
  box.innerHTML = rows.map((r) => `<div class="dashboard-user-row"><div class="dashboard-user-head"><strong>${dashEsc(r.user || '—')}</strong><span>${dashEsc(formatBytes(r.bytes || 0))}</span></div><div class="dashboard-user-meta">${dashEsc(t('p3.userTransfers', { n: r.transfers || 0 }))} · ${dashEsc(t('p3.userShares', { n: r.shares || 0 }))} · ${dashEsc(t('p3.userSuccess', { n: r.successRate || 0 }))}</div><div class="dashboard-user-bar"><i style="width:${Math.max(2, Math.round(((r.bytes || 0) / max) * 100))}%"></i></div></div>`).join('');
}

function renderImageUsers(rows) {
  const box = $('idash-users');
  if (!box) return;
  if (!rows || !rows.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('p3.noUsers'))}</div>`; return; }
  const max = Math.max(1, ...rows.map((r) => r.bytes || 0));
  box.innerHTML = rows.map((r) => `<div class="dashboard-user-row"><div class="dashboard-user-head"><strong>${dashEsc(r.user || '—')}</strong><span>${dashEsc(formatBytes(r.bytes || 0))}</span></div><div class="dashboard-user-meta">${dashEsc(t('p3.userImages', { n: r.images || 0 }))} · ${dashEsc(t('p3.userViews', { n: r.views || 0 }))} · ${dashEsc(t('idash.visitorsN', { n: r.visitors || 0 }))}</div><div class="dashboard-user-bar"><i style="width:${Math.max(2, Math.round(((r.bytes || 0) / max) * 100))}%"></i></div></div>`).join('');
}

function renderDuplicates(data) {
  const box = $('idash-duplicates');
  if (!box) return;
  const d = data || {};
  const groups = Array.isArray(d.groups) ? d.groups : [];
  if (!groups.length) {
    box.innerHTML = `<div class="dash-health dash-health-ok"><span class="dash-health-dot"></span><div><strong>${dashEsc(t('p3.noDuplicates'))}</strong><span>${dashEsc(t('p3.noDuplicatesHelp'))}</span></div></div>${d.truncated ? `<p class="muted sm">${dashEsc(t('p3.scanLimited', { n: d.scanned || 0 }))}</p>` : ''}`;
    return;
  }
  const summary = `<div class="duplicate-summary"><strong>${dashEsc(t('p3.duplicateSummary', { n: d.duplicateFiles || 0, groups: d.groupCount || groups.length, space: formatBytes(d.reclaimableBytes || 0) }))}</strong></div>`;
  const body = groups.map((g) => {
    const thumbs = (g.items || []).map((r) => `<a class="duplicate-thumb" href="${dashEsc(r.url || '#')}" target="_blank" rel="noopener noreferrer" title="${dashEsc(r.name || '')}">${r.previewUrl ? `<img src="${dashEsc(r.previewUrl)}" alt="" loading="lazy">` : '<span>🖼</span>'}</a>`).join('');
    return `<div class="duplicate-group"><div class="duplicate-group-head"><strong>${dashEsc(t('p3.duplicateGroup', { n: g.count || 0, size: formatBytes(g.size || 0), space: formatBytes(g.reclaimableBytes || 0) }))}</strong></div><div class="duplicate-thumbs">${thumbs}</div></div>`;
  }).join('');
  box.innerHTML = summary + body + (d.truncated ? `<p class="muted sm">${dashEsc(t('p3.scanLimited', { n: d.scanned || 0 }))}</p>` : '');
}

function renderOptimization(data) {
  const box = $('idash-optimization');
  if (!box) return;
  const d = data || {};
  const targetHtml = (label, target) => {
    const tdata = target || {};
    const candidates = Array.isArray(tdata.candidates) ? tdata.candidates : [];
    return `<div class="optimization-target"><div class="optimization-head"><div><strong>${dashEsc(label)}</strong><span>${dashEsc(t('p3.eligible', { n: tdata.eligible || 0 }))}</span></div><div><span class="optimization-estimate">${dashEsc(t('p3.estimated'))}</span><strong>${dashEsc(t('p3.potentialSaving', { space: formatBytes(tdata.estimatedSavings || 0) }))}</strong></div></div>${candidates.length ? candidates.slice(0, 5).map((r) => `<div class="optimization-row"><div class="imgdash-thumb">${r.previewUrl ? `<img src="${dashEsc(r.previewUrl)}" alt="" loading="lazy">` : '<span>🖼</span>'}</div><div><strong title="${dashEsc(r.name)}">${dashEsc(r.name)}</strong><span>${dashEsc(t('p3.candidateSaving', { format: String(r.format || '').toUpperCase(), size: formatBytes(r.bytes || 0), space: formatBytes(r.estimatedSavings || 0) }))}</span></div></div>`).join('') : `<div class="empty sm">${dashEsc(t('p3.noOptimization'))}</div>`}</div>`;
  };
  box.innerHTML = `<div class="optimization-grid">${targetHtml('WebP', d.webp)}${targetHtml('AVIF', d.avif)}</div><p class="muted sm optimization-note">${dashEsc(t('p3.optimizationNote'))}</p>`;
}

function renderDashboard() {
  const d = state.dashboardData;
  if (!d || !$('dash-kpis')) return;
  const tot = d.totals || {};

  renderKpis(tot);
  renderAutomaticAlerts('dash-alerts', 'dash-alert-count', transferAlerts(d));
  renderComparison('dash-comparison', d.comparison, 'transfer');
  renderTransferUsers(d.users || []);
  renderDashboard24h(d.last24h || {});
  renderDashboardErrors(d.recentErrors || []);
  renderDashboardProxy(d.proxy, 'dash-proxy');
  renderDashboardLive();
  $('dash-activity').innerHTML = svgActivity(d.daily || []);
  $('dash-volume-trend').innerHTML = svgVolumeTrend(d.daily || []);
  $('dash-success-trend').innerHTML = svgSuccessTrend(d.daily || []);

  $('dash-direction').innerHTML = donutHtml(
    [
      { value: tot.down || 0, color: 'var(--accent)', label: t('dash.downloads') },
      { value: tot.up || 0, color: 'var(--ok)', label: t('dash.uploads') },
    ],
    String((tot.down || 0) + (tot.up || 0)),
    t('dash.kpiTransfers')
  );

  const okRate = tot.transfers ? Math.round((tot.completed / tot.transfers) * 100) : 0;
  $('dash-status').innerHTML = donutHtml(
    [
      { value: tot.completed || 0, color: 'var(--ok)', label: t('dash.completed') },
      { value: tot.interrupted || 0, color: 'var(--danger)', label: t('dash.interrupted') },
    ],
    okRate + '%',
    t('dash.kpiSuccess')
  );

  renderBarList(
    'dash-links',
    (d.topLinks || []).map((l) => ({
      icon: l.type === 'inbox' ? '📥' : l.type === 'folder' ? '📁' : '📄',
      label: l.name, value: l.bytes, valueText: formatBytes(l.bytes),
      sub: t('dash.transfersN', { n: l.count }),
    }))
  );
  renderBarList(
    'dash-countries',
    (d.countries || []).map((c) => ({
      icon: c.flag || '🌐', label: c.country || '—', value: c.count,
      valueText: String(c.count), sub: formatBytes(c.bytes),
    }))
  );
  renderBarList(
    'dash-downloaders',
    (d.topDownloaders || []).map((c) => ({
      icon: '⬇️', label: c.name || c.ip, ip: c.ip, ipName: c.name,
      value: c.bytes, valueText: formatBytes(c.bytes),
      sub: c.name ? `${c.ip} · ${t('dash.transfersN', { n: c.count })}` : t('dash.transfersN', { n: c.count }),
    }))
  );
  renderBarList(
    'dash-uploaders',
    (d.topUploaders || []).map((c) => ({
      icon: '⬆️', label: c.name || c.ip, ip: c.ip, ipName: c.name,
      value: c.bytes, valueText: formatBytes(c.bytes),
      sub: c.name ? `${c.ip} · ${t('dash.transfersN', { n: c.count })}` : t('dash.transfersN', { n: c.count }),
    }))
  );

  // ---- Speed & performance ----
  $('dash-heatmap').innerHTML = heatmapHtml(d.heatmap || [], d.heatMax || 0);
  const sd = d.sizeDist || { small: 0, medium: 0, large: 0 };
  $('dash-sizes').innerHTML = donutHtml(
    [
      { value: sd.small || 0, color: 'var(--ok)', label: t('dash.sizeSmall') },
      { value: sd.medium || 0, color: 'var(--accent)', label: t('dash.sizeMedium') },
      { value: sd.large || 0, color: 'var(--warn)', label: t('dash.sizeLarge') },
    ],
    String((sd.small || 0) + (sd.medium || 0) + (sd.large || 0)),
    t('dash.kpiTransfers')
  );
  renderBarList(
    'dash-files',
    (d.topFiles || []).map((f) => ({ icon: '📄', label: f.name, value: f.bytes, valueText: formatBytes(f.bytes), sub: t('dash.dlN', { n: f.count }) }))
  );

  // ---- Links & shares ----
  const sh = d.shares || {};
  $('dash-protection').innerHTML = donutHtml(
    [
      { value: sh.protected || 0, color: 'var(--accent)', label: t('dash.protected') },
      { value: sh.open || 0, color: 'var(--faint)', label: t('dash.open') },
    ],
    String(sh.total || 0), t('dash.kpiShares')
  );
  $('dash-encryption').innerHTML = donutHtml(
    [
      { value: sh.encrypted || 0, color: 'var(--ok)', label: t('dash.encrypted') },
      { value: sh.plain || 0, color: 'var(--faint)', label: t('dash.plain') },
    ],
    String(sh.total || 0), t('dash.kpiShares')
  );
  renderExpiring(sh.expiringSoon || []);

  // ---- Security ----
  const sec = d.security || {};
  const tf = sec.twoFA || { total: 0, enabled: 0 };
  $('dash-twofa').innerHTML = donutHtml(
    [
      { value: tf.enabled || 0, color: 'var(--ok)', label: t('dash.twofaOn') },
      { value: Math.max(0, (tf.total || 0) - (tf.enabled || 0)), color: 'var(--danger)', label: t('dash.twofaOff') },
    ],
    (tf.total ? Math.round((tf.enabled / tf.total) * 100) : 0) + '%',
    t('dash.twofa')
  );
  renderSecurity(sec);

  // ---- Storage & notifications ----
  renderStorage(d.storage);
  renderReceptionStorageAnalysis(d.storageAnalysis);
  renderWebhook(d.webhook);
  const summary = $('dash-filter-summary');
  if (summary) summary.textContent = t('dash.filteredN', { n: (tot.transfers || 0).toLocaleString() });

  const up = $('dash-updated');
  if (up && d.generatedAt) up.textContent = t('dash.updated', { v: new Date(d.generatedAt).toLocaleTimeString() });
}

function renderDashboardLive() {
  const box = $('dash-live-transfers');
  if (!box) return;
  const data = state.dashboardLiveData || {};
  const transfers = Array.isArray(data.transfers) ? data.transfers : [];
  box.textContent = '';
  if (!transfers.length) {
    box.appendChild(el('div', { class: 'empty sm', text: t('dash.noActive') }));
  } else {
    transfers.forEach((tf) => {
      const up = tf.direction === 'up';
      const isZip = !!tf.isZip;
      const row = el('div', { class: 'transfer dash-live-transfer' + (tf.stalled ? ' stalled' : '') });
      row.appendChild(el('span', { class: 'tflag', text: tf.flag || '🌐' }));
      const info = el('div', { class: 'tinfo' });
      const name = el('div', { class: 'tname' });
      name.appendChild(el('span', { class: 'ico', text: up ? '📥' : isZip ? '🗜️' : '📄' }));
      name.appendChild(el('span', { text: tf.name || '—' }));
      if (tf.stalled) name.appendChild(el('span', { class: 'dash-stalled-badge', text: t('dash.stalledBadge') }));
      info.appendChild(name);
      let total = tf.expectedBytes || 0;
      let done = tf.bytes || 0;
      let etaBps = tf.avgBps || 0;
      if (isZip && tf.zipTotalBytes > 0) {
        total = tf.zipTotalBytes;
        done = tf.zipProcessedBytes || 0;
        etaBps = tf.durationMs > 0 ? (done / tf.durationMs) * 1000 : 0;
      }
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
      if (pct !== null) {
        const bar = el('div', { class: 'tbar' });
        const fill = el('i'); fill.style.width = pct + '%'; bar.appendChild(fill); info.appendChild(bar);
      }
      const meta = el('div', { class: 'tmeta' });
      meta.appendChild(ipTag(tf.ip, tf.ipName));
      meta.appendChild(el('span', { class: 'tspeed', text: (up ? '↑ ' : '↓ ') + formatSpeed(tf.avgBps) }));
      meta.appendChild(el('span', { text: pct == null ? formatBytes(done) : formatBytes(done) + ' / ' + formatBytes(total) + ' (' + pct + '%)' }));
      if (pct !== null && etaBps > 0 && done < total) meta.appendChild(el('span', { class: 'teta', text: '⏳ ' + formatEta((total - done) / etaBps) + ' ' + t('tr.remaining') }));
      meta.appendChild(el('span', { text: '⏱ ' + formatDuration(tf.durationMs) }));
      info.appendChild(meta);
      row.appendChild(info);
      const stopBtn = el('button', { class: 'tstop', text: '✕', attrs: { title: t('tr.stopTitle') } });
      stopBtn.addEventListener('click', () => stopTransfer(tf));
      row.appendChild(stopBtn);
      box.appendChild(row);
    });
  }
  renderDashboardStalled(transfers.filter((tf) => tf.stalled));
  if (state.dashboardData) renderAutomaticAlerts('dash-alerts', 'dash-alert-count', transferAlerts(state.dashboardData));
  const updated = $('dash-live-updated');
  if (updated && data.generatedAt) updated.textContent = t('dash.liveUpdated', { v: new Date(data.generatedAt).toLocaleTimeString() });
}

function renderDashboardStalled(rows) {
  const box = $('dash-stalled');
  const count = $('dash-stalled-count');
  if (count) count.textContent = String(rows.length);
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="dash-health dash-health-ok"><span class="dash-health-dot"></span><div><strong>${dashEsc(t('dash.noStalled'))}</strong><span>${dashEsc(t('dash.noStalledHelp'))}</span></div></div>`;
    return;
  }
  box.textContent = '';
  rows.forEach((tf) => {
    const row = el('div', { class: 'dash-stalled-row' });
    const info = el('div', { class: 'dash-stalled-main' });
    info.appendChild(el('strong', { text: tf.name || '—' }));
    info.appendChild(el('span', { text: t('dash.stalledFor', { v: formatDuration(tf.idleMs || 0) }) + ' · ' + formatBytes(tf.bytes || 0) + ' · ' + (tf.ipName || tf.ip || '—') }));
    row.appendChild(info);
    const stop = el('button', { class: 'btn danger sm', text: t('dash.stopStalled') });
    stop.addEventListener('click', () => stopTransfer(tf));
    row.appendChild(stop);
    box.appendChild(row);
  });
}

function renderDashboard24h(s) {
  const box = $('dash-24h');
  if (!box) return;
  const cards = [
    { icon: '📊', value: (s.transfers || 0).toLocaleString(), label: t('dash.h24Transfers') },
    { icon: '💾', value: formatBytes(s.bytes || 0), label: t('dash.h24Volume') },
    { icon: '✅', value: (s.successRate || 0) + '%', label: t('dash.h24Success') },
    { icon: '⚡', value: fmtBps(s.avgBps || 0), label: t('dash.h24Speed') },
    { icon: '⬇️', value: (s.down || 0).toLocaleString(), label: t('dash.h24Down') },
    { icon: '⬆️', value: (s.up || 0).toLocaleString(), label: t('dash.h24Up') },
  ];
  box.innerHTML = cards.map((c) => `<div class="dash-mini-stat"><span class="dash-mini-ico">${c.icon}</span><div><strong>${dashEsc(c.value)}</strong><span>${dashEsc(c.label)}</span></div></div>`).join('');
}

function transferFailureLabel(reason) {
  const key = 'dash.failure.' + String(reason || 'interrupted');
  const label = t(key);
  return label === key ? String(reason || t('dash.failure.interrupted')).replace(/[-_]+/g, ' ') : label;
}

function renderDashboardErrors(rows) {
  const box = $('dash-errors');
  if (!box) return;
  if (!rows.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.noErrors'))}</div>`; return; }
  box.innerHTML = rows.map((r) => {
    const who = r.ipName ? `${r.ipName} · ${r.ip || ''}` : (r.ip || '');
    const meta = [r.direction === 'up' ? '↑' : '↓', formatBytes(r.bytes || 0), fmtDuration(r.durationMs || 0), who, timeAgo(r.at)].filter(Boolean).join(' · ');
    return `<div class="dash-error-row"><div class="dash-error-main"><span class="dash-error-name" title="${dashEsc(r.name || '—')}">${dashEsc(r.name || '—')}</span><span class="dash-error-reason">${dashEsc(transferFailureLabel(r.reason))}</span></div><div class="dash-error-meta">${dashEsc(meta)}</div></div>`;
  }).join('');
}

function renderDashboardProxy(r, id) {
  const box = $(id);
  if (!box) return;
  if (!r) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.storageNA'))}</div>`; return; }
  const verdict = r.verdict || 'warn';
  const title = !r.proxyDetected ? t('dash.proxyDirect') : t(verdict === 'ok' ? 'dash.proxyOk' : verdict === 'bad' ? 'dash.proxyBad' : 'dash.proxyWarn');
  const detail = r.proxyDetected
    ? t('dash.proxyDetected', { v: r.detectedProxy || r.host || '—' })
    : (r.host || '—');
  const issue = (r.checks || []).find((c) => c.level === 'bad') || (r.checks || []).find((c) => c.level === 'warn');
  box.innerHTML = `<div class="dash-health dash-health-${dashEsc(verdict)}"><span class="dash-health-dot"></span><div><strong>${dashEsc(title)}</strong><span>${dashEsc(detail)}</span><span>${dashEsc(t('dash.proxyTrust', { v: r.trustProxy ? t('dash.on') : t('dash.off') }))}${r.secure ? ' · HTTPS' : ''}</span>${r.testedBase ? `<span>${dashEsc(r.testedBase)}</span>` : ''}${issue ? `<span class="dash-health-issue">${dashEsc(t('proxy.msg.' + issue.code, issue.params || {}))}</span>` : ''}</div></div>`;
}

// 7×24 usage grid (day-of-week × hour), intensity by count. heat: 168 numbers.
function heatmapHtml(heat, max) {
  if (!heat.length || max <= 0) return `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`;
  const dayNames = [];
  for (let dd = 0; dd < 7; dd++) {
    const ref = new Date(2024, 0, 7 + dd); // 2024-01-07 is a Sunday → 0=Sun … 6=Sat
    dayNames.push(ref.toLocaleDateString(state.lang, { weekday: 'short' }));
  }
  let hours = '<span class="hm-day"></span><div class="hm-cells">';
  for (let h = 0; h < 24; h++) hours += `<span class="hm-hlabel">${h % 6 === 0 ? h : ''}</span>`;
  hours += '</div>';
  let rows = '';
  for (let dd = 0; dd < 7; dd++) {
    let cells = '';
    for (let h = 0; h < 24; h++) {
      const v = heat[dd * 24 + h] || 0;
      const op = v ? (0.12 + 0.88 * (v / max)) : 0;
      const bg = v ? ` style="background:rgba(59,130,246,${op.toFixed(2)})"` : '';
      cells += `<span class="hm-cell"${bg} title="${dashEsc(dayNames[dd])} ${h}h — ${v}"></span>`;
    }
    rows += `<div class="hm-row"><span class="hm-day">${dashEsc(dayNames[dd])}</span><div class="hm-cells">${cells}</div></div>`;
  }
  return `<div class="heatmap"><div class="hm-row hm-axis">${hours}</div>${rows}</div>`;
}

function renderExpiring(list) {
  const box = $('dash-expiring');
  if (!box) return;
  if (!list.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.expNone'))}</div>`; return; }
  const now = Date.now();
  box.innerHTML = list.map((s) => {
    const ms = s.expiresAt - now;
    const rem = ms >= 86400000 ? Math.round(ms / 86400000) + ' ' + t('time.d') : fmtDuration(ms);
    const ico = s.type === 'inbox' ? '📥' : s.type === 'folder' ? '📁' : '📄';
    return `<div class="blrow"><span class="bl-ico">${ico}</span><div class="bl-main">` +
      `<div class="bl-top"><span class="bl-label" title="${dashEsc(s.name)}">${dashEsc(s.name)}</span>` +
      `<span class="bl-val">${dashEsc(rem)}</span></div>` +
      `<div class="bl-sub">${dashEsc(formatDate(s.expiresAt))}</div></div></div>`;
  }).join('');
}

function renderSecurity(sec) {
  const box = $('dash-security');
  if (!box) return;
  const failed = sec.failedLogins || 0;
  const locked = sec.lockedIps || [];
  const recent = sec.recentLogins || [];
  let html = '<div class="sec-stats">' +
    `<div class="sec-stat"><span class="sec-num${failed ? ' warn' : ''}">${failed}</span><span class="sec-lbl">${dashEsc(t('dash.failedLogins'))}</span></div>` +
    `<div class="sec-stat"><span class="sec-num${locked.length ? ' bad' : ''}">${locked.length}</span><span class="sec-lbl">${dashEsc(t('dash.lockedIps'))}</span></div>` +
    '</div>';
  if (locked.length) {
    html += `<div class="sec-sub">${dashEsc(t('dash.lockedNow'))}</div><div class="sec-list">` +
      locked.map((l) => `<div class="sec-item"><span class="sec-ip">${dashEsc(l.ip)}</span>` +
        `<span class="sec-tag ${l.kind}">${dashEsc(t(l.kind === 'admin' ? 'dash.lockAdmin' : 'dash.lockLink'))}</span></div>`).join('') +
      '</div>';
  }
  html += `<div class="sec-sub">${dashEsc(t('dash.recentLogins'))}</div>`;
  if (!recent.length) html += `<div class="empty sm">${dashEsc(t('dash.expNone'))}</div>`;
  else html += '<div class="sec-list">' + recent.map((r) =>
    `<div class="sec-item"><span class="sec-actor">${dashEsc(r.actor || '—')}</span>` +
    `<span class="sec-ip">${dashEsc(r.ip || '')}</span><span class="sec-when">${dashEsc(timeAgo(r.at))}</span></div>`).join('') + '</div>';
  box.innerHTML = html;
}

function renderStorage(st) {
  const box = $('dash-storage');
  if (!box) return;
  if (!st || !st.total) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.storageNA'))}</div>`; return; }
  const pct = Math.round((st.used / st.total) * 100);
  const cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
  box.innerHTML = `<div class="stor-bar"><i class="${cls}" style="width:${pct}%"></i></div>` +
    `<div class="stor-meta"><span>${dashEsc(t('dash.storUsed', { v: formatBytes(st.used) }))} (${pct}%)</span>` +
    `<span>${dashEsc(t('dash.storFree', { v: formatBytes(st.free) }))}</span></div>` +
    `<div class="stor-total muted sm">${dashEsc(t('dash.storTotal', { v: formatBytes(st.total) }))}</div>`;
}

function renderReceptionStorageAnalysis(a) {
  const cleanup = $('dash-storage-cleanup');
  const types = $('dash-storage-types');
  const largest = $('dash-storage-largest');
  if (!cleanup || !types || !largest) return;
  if (!a) {
    const empty = `<div class="empty sm">${dashEsc(t('dash.storageNA'))}</div>`;
    cleanup.innerHTML = types.innerHTML = largest.innerHTML = empty;
    return;
  }
  cleanup.innerHTML = `<div class="dash-summary-grid"><div class="dash-mini-stat"><span class="dash-mini-ico">📦</span><div><strong>${dashEsc(formatBytes(a.managedBytes || 0))}</strong><span>${dashEsc(t('dash.managedStorage'))}</span></div></div><div class="dash-mini-stat"><span class="dash-mini-ico">📄</span><div><strong>${dashEsc((a.files || 0).toLocaleString())}</strong><span>${dashEsc(t('dash.storedFiles'))}</span></div></div><div class="dash-mini-stat"><span class="dash-mini-ico">🧩</span><div><strong>${dashEsc(formatBytes(a.partialBytes || 0))}</strong><span>${dashEsc(t('dash.partialFilesN', { n: a.partialFiles || 0 }))}</span></div></div><div class="dash-mini-stat"><span class="dash-mini-ico">🧹</span><div><strong>${dashEsc(formatBytes(a.stalePartialBytes || 0))}</strong><span>${dashEsc(t('dash.stalePartialN', { n: a.stalePartialFiles || 0 }))}</span></div></div></div>${a.truncated ? `<p class="muted sm dashboard-scan-note">${dashEsc(t('dash.scanTruncated', { n: a.scannedEntries || 0 }))}</p>` : ''}`;
  renderBarList('dash-storage-types', (a.byExtension || []).map((r) => ({ icon: '🗂', label: r.ext, value: r.bytes, valueText: formatBytes(r.bytes), sub: t('dash.filesN', { n: r.count }) })));
  renderBarList('dash-storage-largest', (a.largestFiles || []).map((r) => ({ icon: '📄', label: r.name, value: r.bytes, valueText: formatBytes(r.bytes), sub: r.modifiedAt ? formatDate(r.modifiedAt) : '' })));
}

function renderWebhook(w) {
  const box = $('dash-webhook');
  if (!box) return;
  if (!w || !w.configured) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.whNone'))}</div>`; return; }
  if (w.lastAt == null) { box.innerHTML = `<div class="wh-row"><span class="wh-dot idle"></span><span>${dashEsc(t('dash.whIdle'))}</span></div>`; return; }
  const ok = !!w.lastOk;
  box.innerHTML = `<div class="wh-row"><span class="wh-dot ${ok ? 'ok' : 'bad'}"></span><span>${dashEsc(t(ok ? 'dash.whOk' : 'dash.whFail'))}</span></div>` +
    `<div class="wh-meta muted sm">${dashEsc(timeAgo(w.lastAt))}${w.lastEvent ? ' · ' + dashEsc(w.lastEvent) : ''}` +
    `${(!ok && w.lastError) ? ' · ' + dashEsc(w.lastError) : ''}</div>`;
}

// bytes/second → "12.3 MB/s"; ms → "1 min 5 s".
function fmtBps(bps) { return bps > 0 ? formatBytes(bps) + '/s' : '—'; }
function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return m + ' min' + (rs ? ' ' + rs + ' s' : '');
  const h = Math.floor(m / 60), rm = m % 60;
  return h + ' h' + (rm ? ' ' + rm + ' min' : '');
}

function renderKpis(tot) {
  const okRate = tot.transfers ? Math.round((tot.completed / tot.transfers) * 100) : 0;
  const cards = [
    { icon: '📊', value: (tot.transfers || 0).toLocaleString(), label: t('dash.kpiTransfers') },
    { icon: '💾', value: formatBytes(tot.bytes || 0), label: t('dash.kpiVolume') },
    { icon: '✅', value: okRate + '%', label: t('dash.kpiSuccess') },
    { icon: '⚡', value: fmtBps(tot.avgBps || 0), label: t('dash.kpiSpeed') },
    { icon: '⏱️', value: fmtDuration(tot.avgDurationMs || 0), label: t('dash.kpiDuration') },
    { icon: '⬇️', value: (tot.down || 0).toLocaleString(), label: t('dash.kpiDown') },
    { icon: '⬆️', value: (tot.up || 0).toLocaleString(), label: t('dash.kpiUp') },
    { icon: '🌍', value: (tot.uniqueIps || 0).toLocaleString(), label: t('dash.kpiVisitors') },
    { icon: '🔗', value: (tot.activeShares || 0).toLocaleString(), label: t('dash.kpiShares') },
  ];
  $('dash-kpis').innerHTML = cards
    .map((c) => `<div class="kpi"><div class="kpi-ico">${c.icon}</div><div class="kpi-body">` +
      `<div class="kpi-val">${dashEsc(c.value)}</div><div class="kpi-lbl">${dashEsc(c.label)}</div></div></div>`)
    .join('');
}

// Stacked (downloads + uploads) bar chart over the last 30 days.
function svgActivity(daily) {
  if (!daily.length || !daily.some((d) => d.count > 0)) {
    return `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`;
  }
  const W = 720, H = 200, padL = 8, padR = 8, padT = 14, padB = 22;
  const n = daily.length, iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...daily.map((d) => d.count));
  const bw = iw / n, barW = Math.max(3, bw * 0.6), gap = (bw - barW) / 2;
  const base = padT + ih;
  let bars = '', labels = '';
  daily.forEach((d, i) => {
    const x = padL + i * bw + gap;
    const downH = (d.down / max) * ih, upH = (d.up / max) * ih;
    const yDown = base - downH, yUp = yDown - upH;
    const title = `${d.day} — ${t('dash.dl')}: ${d.down}, ${t('dash.ul')}: ${d.up}`;
    bars += `<g><title>${dashEsc(title)}</title>`;
    if (downH > 0) bars += `<rect x="${x.toFixed(1)}" y="${yDown.toFixed(1)}" width="${barW.toFixed(1)}" height="${downH.toFixed(1)}" rx="2" fill="var(--accent)"/>`;
    if (upH > 0) bars += `<rect x="${x.toFixed(1)}" y="${yUp.toFixed(1)}" width="${barW.toFixed(1)}" height="${upH.toFixed(1)}" rx="2" fill="var(--ok)"/>`;
    if (d.count === 0) bars += `<rect x="${x.toFixed(1)}" y="${(base - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" rx="1" fill="var(--border)"/>`;
    bars += '</g>';
    const dom = parseInt(d.day.slice(-2), 10);
    if (i === 0 || i === n - 1 || dom === 1 || dom % 5 === 0) {
      labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ax">${dom}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="barchart" preserveAspectRatio="xMidYMid meet">` +
    `<line x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}" class="axis"/>` +
    `<text x="${padL}" y="${padT + 2}" class="ax">${max}</text>${bars}${labels}</svg>`;
}

function svgVolumeTrend(daily) {
  if (!daily.length || !daily.some((d) => (d.bytes || 0) > 0)) return `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`;
  const W = 720, H = 210, padL = 10, padR = 10, padT = 18, padB = 24;
  const n = daily.length, iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...daily.map((d) => d.bytes || 0));
  const bw = iw / n, barW = Math.max(2, bw * 0.68), base = padT + ih;
  let bars = '', labels = '';
  daily.forEach((d, i) => {
    const x = padL + i * bw + (bw - barW) / 2;
    const h = ((d.bytes || 0) / max) * ih;
    bars += `<g><title>${dashEsc(d.day + ' — ' + formatBytes(d.bytes || 0))}</title><rect x="${x.toFixed(1)}" y="${(base - Math.max(2, h)).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, h).toFixed(1)}" rx="2" fill="var(--accent)"/></g>`;
    const dom = parseInt(d.day.slice(-2), 10);
    if (i === 0 || i === n - 1 || dom === 1 || dom % 5 === 0) labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ax">${dom}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="barchart" preserveAspectRatio="xMidYMid meet"><line x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}" class="axis"/><text x="${padL}" y="${padT}" class="ax">${dashEsc(formatBytes(max))}</text>${bars}${labels}</svg>`;
}

function svgSuccessTrend(daily) {
  if (!daily.length || !daily.some((d) => (d.count || 0) > 0)) return `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`;
  const W = 720, H = 210, padL = 30, padR = 10, padT = 18, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const points = daily.map((d, i) => ({
    x: padL + (daily.length === 1 ? iw / 2 : i * iw / (daily.length - 1)),
    y: padT + ih - ((d.successRate || 0) / 100) * ih,
    d,
  }));
  const poly = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dots = points.filter((_, i) => daily.length < 60 || i % Math.ceil(daily.length / 45) === 0 || i === daily.length - 1).map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="var(--ok)"><title>${dashEsc(p.d.day + ' — ' + (p.d.successRate || 0) + '% · ' + formatSpeed(p.d.avgBps || 0))}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="barchart dashboard-line-chart" preserveAspectRatio="xMidYMid meet"><line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + ih}" class="axis"/><line x1="${padL}" y1="${padT + ih}" x2="${W - padR}" y2="${padT + ih}" class="axis"/><text x="2" y="${padT + 4}" class="ax">100%</text><text x="10" y="${padT + ih}" class="ax">0%</text><polyline points="${poly}" fill="none" stroke="var(--ok)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

// Two-segment donut with a centred figure and a small legend below.
function donutHtml(parts, centerText, centerSub) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const R = 52, C = 2 * Math.PI * R, cx = 70, cy = 70, sw = 22;
  let off = 0, segs = '';
  if (total > 0) {
    parts.forEach((p) => {
      if (p.value <= 0) return;
      const len = (p.value / total) * C;
      segs += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${p.color}" stroke-width="${sw}" ` +
        `stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" ` +
        `transform="rotate(-90 ${cx} ${cy})"><title>${dashEsc(p.label)}: ${p.value}</title></circle>`;
      off += len;
    });
  } else {
    segs = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--border)" stroke-width="${sw}"/>`;
  }
  const legend = parts
    .map((p) => `<li><span class="lg" style="background:${p.color}"></span>${dashEsc(p.label)} <b>${p.value}</b></li>`)
    .join('');
  return `<svg viewBox="0 0 140 140" class="donut">${segs}` +
    `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-num">${dashEsc(centerText)}</text>` +
    `<text x="${cx}" y="${cy + 16}" text-anchor="middle" class="donut-sub">${dashEsc(centerSub || '')}</text></svg>` +
    `<ul class="donut-legend">${legend}</ul>`;
}

// Horizontal bar list (top links / countries / files / clients). Rows carrying an
// `ip` become clickable to rename that client (reuses renameIp).
function renderBarList(id, rows) {
  const box = $(id);
  if (!box) return;
  if (!rows.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`; return; }
  const max = Math.max(1, ...rows.map((r) => r.value || 0));
  box.innerHTML = rows
    .map((r) => {
      const pct = Math.round(((r.value || 0) / max) * 100);
      const clickable = r.ip
        ? ` blrow-click" data-ip="${dashEsc(r.ip)}" data-name="${dashEsc(r.ipName || '')}" title="${dashEsc(t('ipn.clickHint'))}`
        : '';
      return `<div class="blrow${clickable}"><span class="bl-ico">${dashEsc(r.icon || '')}</span><div class="bl-main">` +
        `<div class="bl-top"><span class="bl-label" title="${dashEsc(r.label)}">${dashEsc(r.label)}</span>` +
        `<span class="bl-val">${dashEsc(r.valueText)}</span></div>` +
        `<div class="bl-bar"><i style="width:${pct}%"></i></div>` +
        `<div class="bl-sub">${dashEsc(r.sub || '')}</div></div></div>`;
    })
    .join('');
  // Delegated click → rename the client behind that IP.
  if (rows.some((r) => r.ip) && !box.dataset.ipBound) {
    box.dataset.ipBound = '1';
    box.addEventListener('click', (e) => {
      const row = e.target.closest && e.target.closest('.blrow-click');
      if (row && box.contains(row)) renameIp(row.getAttribute('data-ip'), row.getAttribute('data-name'));
    });
  }
}

const dashRefreshBtn = $('dash-refresh');
if (dashRefreshBtn) dashRefreshBtn.addEventListener('click', loadDashboard);
const dashExportBtn = $('dash-export-csv');
if (dashExportBtn) dashExportBtn.addEventListener('click', () => {
  window.location.href = '/api/dashboard/export.csv?' + transferDashboardQuery();
});

function scheduleTransferDashboardReload() {
  clearTimeout(state.dashFilterTimer);
  state.dashFilterTimer = setTimeout(loadDashboard, 250);
}

document.querySelectorAll('#dash-period .dp-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = btn.getAttribute('data-days');
    if (d === state.dashPeriod) return;
    state.dashPeriod = d;
    updateUiPrefs({ dashPeriod: d });
    document.querySelectorAll('#dash-period .dp-btn').forEach((b) => b.classList.toggle('active', b === btn));
    loadDashboard();
  });
});
[['dash-direction-filter', 'dashDirection'], ['dash-status-filter', 'dashStatus'], ['dash-type-filter', 'dashType']].forEach(([id, key]) => {
  const node = $(id);
  if (node) node.addEventListener('change', () => {
    state[key] = node.value;
    updateUiPrefs({ [key]: state[key] });
    loadDashboard();
  });
});
const dashSearchFilter = $('dash-search-filter');
if (dashSearchFilter) dashSearchFilter.addEventListener('input', () => {
  state.dashQuery = dashSearchFilter.value.trim();
  updateUiPrefs({ dashQuery: state.dashQuery });
  scheduleTransferDashboardReload();
});
const dashFilterReset = $('dash-filter-reset');
if (dashFilterReset) dashFilterReset.addEventListener('click', () => {
  state.dashDirection = state.dashStatus = state.dashType = state.dashQuery = '';
  updateUiPrefs({ dashDirection: '', dashStatus: '', dashType: '', dashQuery: '' });
  ['dash-direction-filter', 'dash-status-filter', 'dash-type-filter', 'dash-search-filter'].forEach((id) => { if ($(id)) $(id).value = ''; });
  loadDashboard();
});

// ------------------------------------------------------------------
// Images dashboard (mirrors the main dashboard, scoped to image links)
// ------------------------------------------------------------------
async function loadImagesDashboard() {
  try {
    const imageBase = state.settings && state.settings.imageBase ? state.settings.imageBase : '';
    const [data, proxy] = await Promise.all([
      api('GET', '/api/photos/dashboard?' + imagesDashboardQuery()),
      api('GET', '/api/network/proxy-check?base=' + encodeURIComponent(imageBase)).catch(() => null),
    ]);
    data.proxy = proxy;
    state.imagesDashData = data;
    renderImagesDashboard();
  } catch (e) {
    if (e.message === 'not-authenticated') return; // keep the previous render
  }
}

function renderImagesDashboard() {
  const d = state.imagesDashData;
  if (!d || !$('idash-kpis')) return;
  const tot = d.totals || {};

  const kpis = [
    { icon: '🖼', value: (tot.images || 0).toLocaleString(), label: t('idash.kpiImages') },
    { icon: '✅', value: (tot.active || 0).toLocaleString(), label: t('idash.kpiActive') },
    { icon: '⌛', value: (tot.expired || 0).toLocaleString(), label: t('idash.kpiExpired') },
    { icon: '👁', value: (tot.views || 0).toLocaleString(), label: t('idash.kpiViews') },
    { icon: '👤', value: (tot.visitors || 0).toLocaleString(), label: t('idash.kpiVisitors') },
    { icon: '💾', value: formatBytes(tot.storageBytes || 0), label: t('idash.kpiStorage') },
    { icon: '➕', value: (tot.addedInPeriod || 0).toLocaleString(), label: t('idash.kpiAdded') },
    { icon: '🗑️', value: (tot.revoked || 0).toLocaleString(), label: t('idash.kpiRevoked') },
    { icon: '🔎', value: (tot.withMini || 0).toLocaleString(), label: t('idash.kpiMini') },
    { icon: '🔬', value: (tot.withMicro || 0).toLocaleString(), label: t('idash.kpiMicro') },
  ];
  $('idash-kpis').innerHTML = kpis
    .map((c) => `<div class="kpi"><div class="kpi-ico">${c.icon}</div><div class="kpi-body">` +
      `<div class="kpi-val">${dashEsc(c.value)}</div><div class="kpi-lbl">${dashEsc(c.label)}</div></div></div>`)
    .join('');

  renderAutomaticAlerts('idash-alerts', 'idash-alert-count', imageAlerts(d));
  renderComparison('idash-comparison', d.comparison, 'image');
  renderImageUsers(d.users || []);
  renderDuplicates(d.duplicates);
  renderOptimization(d.optimization);

  const ls = d.linkStatus || { active: 0, expired: 0, inactive: 0 };
  $('idash-link-status').innerHTML = donutHtml(
    [
      { value: ls.active || 0, color: 'var(--ok)', label: t('idash.active') },
      { value: ls.expired || 0, color: 'var(--warn)', label: t('idash.expired') },
      { value: ls.inactive || 0, color: 'var(--faint)', label: t('idash.inactive') },
    ],
    String((ls.active || 0) + (ls.expired || 0) + (ls.inactive || 0)), t('idash.kpiImages')
  );
  renderImageLinkRows('idash-active-links', d.activeLinks || [], false);
  renderImageLinkRows('idash-expired-links', d.expiredLinks || [], true);
  renderDashboardProxy(d.proxy, 'idash-proxy');

  $('idash-timeline').innerHTML = svgImagesTimeline(d.created || []);
  $('idash-storage-growth').innerHTML = svgImageStorageGrowth(d.created || []);

  const vv = d.variantViews || { full: 0, thumb: 0, micro: 0 };
  $('idash-variant-views').innerHTML = donutHtml(
    [
      { value: vv.full || 0, color: 'var(--accent)', label: t('photo.full') },
      { value: vv.thumb || 0, color: 'var(--ok)', label: t('photo.thumb') },
      { value: vv.micro || 0, color: 'var(--warn)', label: t('photo.micro') },
    ],
    String((vv.full || 0) + (vv.thumb || 0) + (vv.micro || 0)), t('idash.kpiViews')
  );

  const ar = d.activeVsRevoked || { active: 0, revoked: 0 };
  $('idash-active').innerHTML = donutHtml(
    [
      { value: ar.active || 0, color: 'var(--ok)', label: t('idash.active') },
      { value: ar.revoked || 0, color: 'var(--faint)', label: t('idash.revokedLbl') },
    ],
    String((ar.active || 0) + (ar.revoked || 0)), t('idash.kpiImages')
  );

  renderImageRanking('idash-top-views', d.topImages || []);
  renderBarList(
    'idash-top-visitors',
    (d.topVisitors || []).map((r) => ({
      icon: '👤', label: r.name, value: r.visitors,
      valueText: t('idash.visitorsN', { n: r.visitors }), sub: t('idash.viewsN', { n: r.views }),
    }))
  );

  const sp = d.storageByVariant;
  if (sp) {
    renderBarList('idash-storage-split', [
      { icon: '🖼', label: t('photo.full'), value: sp.full || 0, valueText: formatBytes(sp.full || 0), sub: '' },
      { icon: '🔎', label: t('photo.thumb'), value: sp.mini || 0, valueText: formatBytes(sp.mini || 0), sub: '' },
      { icon: '🔬', label: t('photo.micro'), value: sp.micro || 0, valueText: formatBytes(sp.micro || 0), sub: '' },
    ]);
  } else {
    $('idash-storage-split').innerHTML = `<div class="empty sm">${dashEsc(t('dash.storageNA'))}</div>`;
  }

  renderImagesStorage(d.storage);
  renderImageStorageAnalysis(d.storageAnalysis);
  renderImagesExpiring(d.expiringSoon || []);
  renderImagesRevoked(d.recentRevoked || []);

  const summary = $('idash-filter-summary');
  if (summary) summary.textContent = t('idash.filteredN', { n: (tot.images || 0).toLocaleString() });
  const up = $('idash-updated');
  if (up && d.generatedAt) up.textContent = t('dash.updated', { v: new Date(d.generatedAt).toLocaleTimeString() });
}

function renderImageLinkRows(id, rows, expired) {
  const box = $(id);
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<div class="empty sm">${dashEsc(t(expired ? 'idash.noExpiredLinks' : 'idash.noActiveLinks'))}</div>`;
    return;
  }
  box.innerHTML = rows.map((r) => {
    const expiry = r.expiresAt ? formatDate(r.expiresAt) : t('idash.neverExpires');
    const thumb = r.previewUrl ? `<img src="${dashEsc(r.previewUrl)}" alt="" loading="lazy">` : '<span>🖼</span>';
    const action = !expired && r.url ? `<a class="btn ghost xs" href="${dashEsc(r.url)}" target="_blank" rel="noopener noreferrer">${dashEsc(t('idash.open'))}</a>` : '';
    return `<div class="imgdash-row"><div class="imgdash-thumb">${thumb}</div><div class="imgdash-main"><div class="imgdash-name" title="${dashEsc(r.name)}">${dashEsc(r.name)}</div><div class="imgdash-meta">${dashEsc(t('idash.viewsN', { n: r.views || 0 }))} · ${dashEsc(t('idash.visitorsN', { n: r.visitors || 0 }))}</div><div class="imgdash-expiry">${dashEsc(expiry)}</div></div>${action}</div>`;
  }).join('');
}

function renderImageRanking(id, rows) {
  const box = $(id);
  if (!box) return;
  if (!rows.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`; return; }
  box.innerHTML = rows.map((r, i) => {
    const thumb = r.previewUrl ? `<img src="${dashEsc(r.previewUrl)}" alt="" loading="lazy">` : '<span>🖼</span>';
    const name = r.url && r.active ? `<a href="${dashEsc(r.url)}" target="_blank" rel="noopener noreferrer">${dashEsc(r.name)}</a>` : dashEsc(r.name);
    return `<div class="imgdash-row imgdash-ranking"><span class="imgdash-rank">${i + 1}</span><div class="imgdash-thumb">${thumb}</div><div class="imgdash-main"><div class="imgdash-name">${name}</div><div class="imgdash-meta">${dashEsc(t('idash.viewsN', { n: r.views || 0 }))} · ${dashEsc(t('idash.visitorsN', { n: r.visitors || 0 }))}</div></div></div>`;
  }).join('');
}

// Single-series bar chart: images added per day (reuses the .barchart look).
function svgImagesTimeline(created) {
  if (!created.length || !created.some((d) => d.count > 0)) {
    return `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`;
  }
  const W = 720, H = 200, padL = 8, padR = 8, padT = 14, padB = 22;
  const n = created.length, iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1, ...created.map((d) => d.count));
  const bw = iw / n, barW = Math.max(3, bw * 0.6), gap = (bw - barW) / 2, base = padT + ih;
  let bars = '', labels = '';
  created.forEach((d, i) => {
    const x = padL + i * bw + gap;
    const h = (d.count / max) * ih, y = base - h;
    bars += `<g><title>${dashEsc(d.day + ' — ' + t('idash.addedN', { n: d.count }))}</title>`;
    if (h > 0) bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--accent)"/>`;
    else bars += `<rect x="${x.toFixed(1)}" y="${(base - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" rx="1" fill="var(--border)"/>`;
    bars += '</g>';
    const dom = parseInt(d.day.slice(-2), 10);
    if (i === 0 || i === n - 1 || dom === 1 || dom % 5 === 0) {
      labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ax">${dom}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="barchart" preserveAspectRatio="xMidYMid meet">` +
    `<line x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}" class="axis"/>` +
    `<text x="${padL}" y="${padT + 2}" class="ax">${max}</text>${bars}${labels}</svg>`;
}

function svgImageStorageGrowth(created) {
  if (!created.length || !created.some((d) => (d.cumulativeBytes || 0) > 0)) return `<div class="empty sm">${dashEsc(t('dash.empty'))}</div>`;
  const W = 720, H = 210, padL = 10, padR = 10, padT = 18, padB = 24;
  const max = Math.max(1, ...created.map((d) => d.cumulativeBytes || 0));
  const iw = W - padL - padR, ih = H - padT - padB;
  const pts = created.map((d, i) => ({ x: padL + (created.length === 1 ? iw / 2 : i * iw / (created.length - 1)), y: padT + ih - ((d.cumulativeBytes || 0) / max) * ih, d }));
  const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dots = pts.filter((_, i) => created.length < 60 || i % Math.ceil(created.length / 45) === 0 || i === created.length - 1).map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="var(--accent)"><title>${dashEsc(p.d.day + ' — ' + formatBytes(p.d.cumulativeBytes || 0))}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="barchart dashboard-line-chart" preserveAspectRatio="xMidYMid meet"><line x1="${padL}" y1="${padT + ih}" x2="${W - padR}" y2="${padT + ih}" class="axis"/><text x="${padL}" y="${padT}" class="ax">${dashEsc(formatBytes(max))}</text><polyline points="${poly}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

function renderImageStorageAnalysis(a) {
  const formats = $('idash-storage-formats');
  const largest = $('idash-storage-largest');
  const reclaim = $('idash-reclaimable');
  if (!formats || !largest || !reclaim) return;
  if (!a) {
    const empty = `<div class="empty sm">${dashEsc(t('dash.storageNA'))}</div>`;
    formats.innerHTML = largest.innerHTML = reclaim.innerHTML = empty;
    return;
  }
  renderBarList('idash-storage-formats', (a.byFormat || []).map((r) => ({ icon: '🖼', label: String(r.format || '').toUpperCase(), value: r.bytes, valueText: formatBytes(r.bytes), sub: t('dash.filesN', { n: r.count }) })));
  renderBarList('idash-storage-largest', (a.largestImages || []).map((r) => ({ icon: '🖼', label: r.name, value: r.size, valueText: formatBytes(r.size), sub: String(r.ext || '').toUpperCase() + ' · ' + t('idash.viewsN', { n: r.views || 0 }) })));
  const lc = a.lifecycle || {};
  reclaim.innerHTML = `<div class="dash-summary-grid"><div class="dash-mini-stat"><span class="dash-mini-ico">✅</span><div><strong>${dashEsc(formatBytes(lc.active || 0))}</strong><span>${dashEsc(t('idash.storageActive'))}</span></div></div><div class="dash-mini-stat"><span class="dash-mini-ico">⌛</span><div><strong>${dashEsc(formatBytes(lc.expired || 0))}</strong><span>${dashEsc(t('idash.storageExpired'))}</span></div></div><div class="dash-mini-stat"><span class="dash-mini-ico">⛔</span><div><strong>${dashEsc(formatBytes(lc.inactive || 0))}</strong><span>${dashEsc(t('idash.storageInactive'))}</span></div></div><div class="dash-mini-stat"><span class="dash-mini-ico">🧹</span><div><strong>${dashEsc(formatBytes(lc.reclaimable || 0))}</strong><span>${dashEsc(t('idash.storageReclaimable'))}</span></div></div></div>`;
}

function renderImagesStorage(st) {
  const box = $('idash-storage');
  if (!box) return;
  if (!st || !st.total) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.storageNA'))}</div>`; return; }
  const pct = Math.round((st.used / st.total) * 100);
  const cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : '';
  box.innerHTML = `<div class="stor-bar"><i class="${cls}" style="width:${pct}%"></i></div>` +
    `<div class="stor-meta"><span>${dashEsc(t('dash.storUsed', { v: formatBytes(st.used) }))} (${pct}%)</span>` +
    `<span>${dashEsc(t('dash.storFree', { v: formatBytes(st.free) }))}</span></div>` +
    `<div class="stor-total muted sm">${dashEsc(t('dash.storTotal', { v: formatBytes(st.total) }))}</div>`;
}

function renderImagesExpiring(list) {
  const box = $('idash-expiring');
  if (!box) return;
  if (!list.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('dash.expNone'))}</div>`; return; }
  const now = Date.now();
  box.innerHTML = list.map((s) => {
    const ms = s.expiresAt - now;
    const rem = ms >= 86400000 ? Math.round(ms / 86400000) + ' ' + t('time.d') : fmtDuration(ms);
    return `<div class="blrow"><span class="bl-ico">🖼</span><div class="bl-main">` +
      `<div class="bl-top"><span class="bl-label" title="${dashEsc(s.name)}">${dashEsc(s.name)}</span>` +
      `<span class="bl-val">${dashEsc(rem)}</span></div>` +
      `<div class="bl-sub">${dashEsc(formatDate(s.expiresAt))}</div></div></div>`;
  }).join('');
}

function renderImagesRevoked(list) {
  const box = $('idash-revoked');
  if (!box) return;
  if (!list.length) { box.innerHTML = `<div class="empty sm">${dashEsc(t('photo.historyEmpty'))}</div>`; return; }
  box.innerHTML = list.map((r) =>
    `<div class="blrow"><span class="bl-ico">🗑️</span><div class="bl-main">` +
    `<div class="bl-top"><span class="bl-label" title="${dashEsc(r.name)}">${dashEsc(r.name)}</span>` +
    `<span class="bl-val">${dashEsc(t('idash.viewsN', { n: r.views }))}</span></div>` +
    `<div class="bl-sub">${dashEsc(timeAgo(r.revokedAt))}${r.visitors ? ' · ' + dashEsc(t('idash.visitorsN', { n: r.visitors })) : ''}</div></div></div>`
  ).join('');
}

// Open the independent dashboards page directly on the Images tab.
if ($('images-dash-btn')) $('images-dash-btn').addEventListener('click', () => {
  openDashboardsPage('images');
});
const idashRefreshBtn = $('idash-refresh');
if (idashRefreshBtn) idashRefreshBtn.addEventListener('click', loadImagesDashboard);
const idashExportBtn = $('idash-export-csv');
if (idashExportBtn) idashExportBtn.addEventListener('click', () => {
  window.location.href = '/api/photos/dashboard/export.csv?' + imagesDashboardQuery();
});
function scheduleImagesDashboardReload() {
  clearTimeout(state.imagesDashFilterTimer);
  state.imagesDashFilterTimer = setTimeout(loadImagesDashboard, 250);
}
document.querySelectorAll('#idash-period .dp-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const d = btn.getAttribute('data-days');
    if (d === state.imagesDashPeriod) return;
    state.imagesDashPeriod = d;
    updateUiPrefs({ imagesDashPeriod: d });
    document.querySelectorAll('#idash-period .dp-btn').forEach((b) => b.classList.toggle('active', b === btn));
    loadImagesDashboard();
  });
});
[['idash-status-filter', 'imagesDashStatus'], ['idash-format-filter', 'imagesDashFormat']].forEach(([id, key]) => {
  const node = $(id);
  if (node) node.addEventListener('change', () => {
    state[key] = node.value;
    updateUiPrefs({ [key]: state[key] });
    loadImagesDashboard();
  });
});
const idashSearchFilter = $('idash-search-filter');
if (idashSearchFilter) idashSearchFilter.addEventListener('input', () => {
  state.imagesDashQuery = idashSearchFilter.value.trim();
  updateUiPrefs({ imagesDashQuery: state.imagesDashQuery });
  scheduleImagesDashboardReload();
});
const idashFilterReset = $('idash-filter-reset');
if (idashFilterReset) idashFilterReset.addEventListener('click', () => {
  state.imagesDashStatus = state.imagesDashFormat = state.imagesDashQuery = '';
  updateUiPrefs({ imagesDashStatus: '', imagesDashFormat: '', imagesDashQuery: '' });
  ['idash-status-filter', 'idash-format-filter', 'idash-search-filter'].forEach((id) => { if ($(id)) $(id).value = ''; });
  loadImagesDashboard();
});

// ------------------------------------------------------------------
// Network
// ------------------------------------------------------------------
async function loadNetwork() {
  try {
    const n = await api('GET', '/api/network');
    state.port = n.port;
    $('net-local').textContent =
      n.locals && n.locals.length ? n.locals.map((l) => l.address).join(', ') : '—';
    $('net-public').textContent = n.publicIp || t('net.notDetected');
    $('net-host').textContent = n.base || '—';

    if (n.base) $('link-base').placeholder = n.base.replace(/^https?:\/\//i, '');

    const statusEl = $('net-port-status');
    if (!statusEl.dataset.tested) {
      statusEl.textContent = t('net.notTested');
      statusEl.className = 'net-value';
    }

    const hint = $('port-hint');
    if (n.behindProxy || n.publicUrl) {
      hint.textContent = t('net.proxyHint', { label: n.testLabel || t('net.theDomain') });
      hint.classList.remove('hidden');
    }
  } catch (e) {
    if (e.message !== 'not-authenticated') toast(t('net.unavailable'), 'err');
  }
}

$('port-test-btn').addEventListener('click', async () => {
  const btn = $('port-test-btn');
  const statusEl = $('net-port-status');
  const hint = $('port-hint');
  btn.disabled = true;
  statusEl.dataset.tested = '1';
  statusEl.textContent = t('net.testing');
  statusEl.className = 'net-value warn';
  hint.classList.add('hidden');
  try {
    const r = await api('POST', '/api/network/port-check');
    const label = r.label || (r.host ? r.host + ':' + r.port : t('net.theTarget'));
    if (r.open === true) {
      statusEl.textContent = t('net.accessible');
      statusEl.className = 'net-value ok';
      hint.textContent = t('net.hintAccessible', { label, open: r.openNodes, total: r.total });
    } else if (r.open === false) {
      statusEl.textContent = t('net.unreachable');
      statusEl.className = 'net-value bad';
      hint.textContent = t('net.hintUnreachable', { label });
    } else {
      statusEl.textContent = t('net.undetermined');
      statusEl.className = 'net-value warn';
      hint.textContent = t('net.hintUndetermined', { error: r.error || '?' });
    }
    hint.classList.remove('hidden');
  } catch (e) {
    statusEl.textContent = t('net.error');
    statusEl.className = 'net-value bad';
  } finally {
    btn.disabled = false;
  }
});

// --- Reverse-proxy diagnostic -------------------------------------------------
const PROXY_LEVEL_ICON = { ok: '✓', warn: '⚠', bad: '✕', info: 'ℹ' };
function renderProxyResult(r, boxEl) {
  const box = boxEl || $('proxy-result');
  box.textContent = '';
  const verdictKey = 'proxy.verdict.' + (r.verdict || 'info');
  const head = el('div', { class: 'pxr-head pxr-' + (r.verdict || 'info') });
  head.appendChild(el('span', { class: 'pxr-badge', text: PROXY_LEVEL_ICON[r.verdict] || 'ℹ' }));
  head.appendChild(el('strong', { text: t(verdictKey) }));
  box.appendChild(head);

  // Key facts grid.
  const facts = el('div', { class: 'pxr-facts' });
  const fact = (label, value) => {
    const row = el('div', { class: 'pxr-fact' });
    row.appendChild(el('span', { class: 'pxr-flabel', text: label }));
    row.appendChild(el('span', { class: 'pxr-fvalue', text: value }));
    facts.appendChild(row);
  };
  fact(t('proxy.trustProxy'), r.trustProxy ? (t('proxy.enabled') + (r.trustProxyValue ? ' (' + r.trustProxyValue + ')' : '')) : t('proxy.disabled'));
  fact(t('proxy.detected'), r.proxyDetected ? (r.detectedProxy || t('proxy.yes')) : t('proxy.no'));
  fact(t('proxy.clientIp'), r.clientIp || '—');
  fact(t('proxy.remoteAddr'), (r.remoteAddr || '—') + (r.remoteIsPrivate === false ? ' · ' + t('proxy.publicPeerTag') : ''));
  fact(t('proxy.protocol'), (r.protocol || '—') + (r.secure ? ' 🔒' : ''));
  if (r.testedBase) fact(t('proxy.target'), r.testedBase);
  fact(t('proxy.host'), r.host || '—');
  box.appendChild(facts);

  // Analysis lines.
  const list = el('ul', { class: 'pxr-checks' });
  (r.checks || []).forEach((c) => {
    const li = el('li', { class: 'pxr-check pxr-' + c.level });
    li.appendChild(el('span', { class: 'pxr-cico', text: PROXY_LEVEL_ICON[c.level] || 'ℹ' }));
    li.appendChild(el('span', { class: 'pxr-cmsg', text: t('proxy.msg.' + c.code, c.params || {}) }));
    list.appendChild(li);
  });
  box.appendChild(list);

  // Raw forwarding headers (collapsible).
  const keys = Object.keys(r.headers || {});
  const det = el('details', { class: 'pxr-headers' });
  det.appendChild(el('summary', { text: t('proxy.headers') + ' (' + keys.length + ')' }));
  if (keys.length) {
    const pre = el('pre');
    pre.textContent = keys.map((k) => k + ': ' + r.headers[k]).join('\n');
    det.appendChild(pre);
  } else {
    det.appendChild(el('p', { class: 'muted sm', text: t('proxy.noHeaders') }));
  }
  box.appendChild(det);

  box.classList.remove('hidden');
}

if ($('proxy-test-btn')) $('proxy-test-btn').addEventListener('click', async () => {
  const btn = $('proxy-test-btn');
  const box = $('proxy-result');
  btn.disabled = true;
  box.classList.remove('hidden');
  box.textContent = '';
  box.appendChild(el('p', { class: 'muted sm', text: t('proxy.testing') }));
  try {
    const r = await api('GET', '/api/network/proxy-check');
    renderProxyResult(r);
  } catch (e) {
    box.textContent = '';
    box.appendChild(el('p', { class: 'error', text: t('proxy.error') }));
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------
// Setting: auto-shutdown
// ------------------------------------------------------------------
$('shutdown-toggle').addEventListener('change', async (e) => {
  const val = e.target.checked;
  state.settingsDirtyUntil = Date.now() + 3000;
  state.settingsEpoch++;
  try {
    await api('POST', '/api/settings', { shutdownAfterDownload: val });
    toast(val ? t('shutdown.armed') : t('shutdown.disarmed'), 'ok');
  } catch (_) {
    e.target.checked = !val;
    toast(t('settings.saveError'), 'err');
  }
});

// ------------------------------------------------------------------
// Idle auto-lock (optional). Locks the admin UI after N minutes with no REAL
// user activity — background polling deliberately does not count, so a
// forgotten tab still locks. Configured in the Configuration window and stored
// server-side (settings.idleLockMinutes; 0 = off).
// ------------------------------------------------------------------
const IDLE_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];

function applyIdleLock(mins) {
  state.idleLockMinutes = mins > 0 ? mins : 0;
  if (state.idleLockMinutes > 0) {
    if (!state.idleActivityBound) {
      state.idleActivityBound = true;
      IDLE_EVENTS.forEach((ev) => document.addEventListener(ev, onUserActivity, { passive: true, capture: true }));
    }
    resetIdleTimer();
  } else if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}
function resetIdleTimer() {
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  if (state.idleLockMinutes > 0 && isLoggedIn()) {
    state.idleTimer = setTimeout(idleLockNow, state.idleLockMinutes * 60000);
  }
}
function onUserActivity() {
  if (state.idleLockMinutes <= 0 || !isLoggedIn()) return;
  const now = Date.now();
  if (now - state.idleLastReset < 3000) return; // debounce: reset at most every 3 s
  state.idleLastReset = now;
  resetIdleTimer();
}
async function idleLockNow() {
  state.idleTimer = null;
  if (!isLoggedIn()) return;
  try { await api('POST', '/api/logout'); } catch (_) {}
  state.csrf = null; state.username = null; state.role = null;
  showLogin();
  const err = $('login-error');
  if (err) { err.textContent = t('cfg.locked'); err.classList.remove('hidden'); }
}

// --- Configuration window (user menu) ---
async function openConfigModal() {
  closeUserMenu();
  const s = state.settings || {};
  // Security — inactivity lock
  const on = state.idleLockMinutes > 0;
  $('cfg-idle-enable').checked = on;
  $('cfg-idle-mins').value = on ? state.idleLockMinutes : 15;
  $('cfg-idle-mins').disabled = !on;
  // Notifications — webhook (env-managed → read-only)
  const envWh = !!s.webhookFromEnv;
  $('cfg-webhook-env').classList.toggle('hidden', !envWh);
  $('cfg-webhook-url').value = envWh ? '' : (s.webhookUrl || '');
  $('cfg-webhook-url').disabled = envWh;
  $('cfg-webhook-url').placeholder = envWh ? '••••••••' : 'https://…';
  $('cfg-webhook-format').value = s.webhookFormat || 'auto';
  $('cfg-webhook-format').disabled = envWh;
  $('cfg-notify-downloads').checked = s.notifyDownloads !== false;
  $('cfg-notify-uploads').checked = s.notifyUploads !== false;
  $('cfg-notify-messages').checked = s.notifyMessages !== false;
  $('cfg-webhook-result').textContent = '';
  refreshWebPushUI(); // browser push notifications (async, updates the button/status)
  // Notifications — expiry alert (feature 5) + periodic digest (feature 9)
  $('cfg-notify-expiring').checked = !!s.notifyExpiring;
  $('cfg-expiry-hours').value = s.expiryWarnHours || 24;
  $('cfg-expiry-hours').disabled = !s.notifyExpiring;
  $('cfg-digest-enable').checked = !!s.digestEnabled;
  $('cfg-digest-days').value = s.digestDays || 7;
  $('cfg-digest-days').disabled = !s.digestEnabled;
  $('cfg-digest-result').textContent = '';
  if ($('cfg-notify-security')) $('cfg-notify-security').checked = !!s.notifySecurity;
  // Notifications — e-mail / SMTP (feature 2)
  const envMail = !!s.emailFromEnv;
  const mailAvail = s.emailAvailable !== false;
  $('cfg-email-env').classList.toggle('hidden', !envMail);
  $('cfg-email-unavail').classList.toggle('hidden', mailAvail);
  $('cfg-email-enable').checked = !!s.emailEnabled;
  $('cfg-smtp-host').value = s.smtpHost || '';
  $('cfg-smtp-port').value = s.smtpPort || 587;
  $('cfg-smtp-secure').checked = !!s.smtpSecure;
  $('cfg-smtp-user').value = s.smtpUser || '';
  $('cfg-smtp-pass').value = ''; // never populated; blank = keep existing
  $('cfg-smtp-pass').placeholder = s.smtpPassSet ? '••••••••' : '';
  $('cfg-smtp-from').value = s.smtpFrom || '';
  $('cfg-smtp-to').value = s.smtpTo || '';
  ['cfg-email-enable','cfg-smtp-host','cfg-smtp-port','cfg-smtp-secure','cfg-smtp-user','cfg-smtp-pass','cfg-smtp-from','cfg-smtp-to']
    .forEach((id) => { const el2 = $(id); if (el2) el2.disabled = envMail || !mailAvail; });
  $('cfg-email-result').textContent = '';
  // Defaults for new links
  $('cfg-def-expiry').value = String(s.defaultExpiry || 0);
  $('cfg-def-maxdl').value = s.defaultMaxDownloads ? String(s.defaultMaxDownloads) : '';
  $('cfg-def-rate').value = s.defaultRateKBps ? String(s.defaultRateKBps) : '';
  $('cfg-def-allowzip').checked = s.defaultAllowZip !== false;
  // Security (extended)
  $('cfg-max-attempts').value = s.maxLoginAttempts || 5;
  $('cfg-lockout-mins').value = s.lockoutMinutes || 5;
  $('cfg-session-hours').value = s.sessionHours ? String(s.sessionHours) : '';
  $('cfg-token-bytes').value = s.tokenBytes || 24;
  $('cfg-https-warn').checked = s.httpsWarning !== false;
  // Force 2FA + admin IP allowlist
  $('cfg-require-2fa').checked = !!s.requireTwoFactor;
  const allowEnv = !!s.allowlistFromEnv;
  $('cfg-admin-allowlist').value = allowEnv ? '' : (s.adminAllowedIps || '');
  $('cfg-admin-allowlist').disabled = allowEnv;
  $('cfg-admin-allowlist').placeholder = allowEnv ? '••••••••' : '192.168.1.0/24, 203.0.113.5';
  $('cfg-allowlist-env').classList.toggle('hidden', !allowEnv);
  // New-link defaults (extended)
  $('cfg-def-preview').checked = s.defaultAllowPreview !== false;
  $('cfg-def-reqpw').checked = !!s.defaultRequirePassword;
  $('cfg-def-burn').checked = !!s.defaultBurnAfterDownload;
  $('cfg-def-qr').checked = !!s.defaultShowQr;
  $('cfg-def-startdelay').value = s.defaultStartDelayHours ? String(s.defaultStartDelayHours) : '';
  $('cfg-default-dir').value = s.defaultShareDir || '';
  // Reception-link defaults
  $('cfg-def-maxfiles').value = s.defaultMaxFiles ? String(s.defaultMaxFiles) : '';
  $('cfg-def-maxfile').value = s.defaultMaxFileBytes ? String(Math.round(s.defaultMaxFileBytes / (1024 * 1024))) : '';
  $('cfg-def-maxtotal').value = s.defaultMaxTotalBytes ? String(Math.round(s.defaultMaxTotalBytes / (1024 * 1024))) : '';
  $('cfg-def-allowext').value = s.defaultAllowExt || '';
  $('cfg-def-blockext').value = s.defaultBlockExt || '';
  $('cfg-def-encrypt').checked = !!s.defaultEncrypt;
  // Global limits
  $('cfg-global-rate').value = s.globalRateKBps ? String(s.globalRateKBps) : '';
  $('cfg-max-upload').value = s.maxUploadBytes ? String(Math.round(s.maxUploadBytes / (1024 * 1024))) : '';
  $('cfg-max-zip').value = s.maxZipBytes ? String(Math.round(s.maxZipBytes / (1024 * 1024))) : '';
  // Maintenance
  $('cfg-update-check').checked = s.updateCheck !== false;
  $('cfg-update-check').disabled = !!s.updateCheckEnv;
  // Scheduled bandwidth cap (feature 5)
  $('cfg-sched-enable').checked = !!s.scheduleRateEnabled;
  $('cfg-sched-rate').value = s.scheduleRateKBps ? String(s.scheduleRateKBps) : '';
  $('cfg-sched-start').value = s.scheduleStart || '08:00';
  $('cfg-sched-end').value = s.scheduleEnd || '18:00';
  ['cfg-sched-rate','cfg-sched-start','cfg-sched-end'].forEach((id) => { $(id).disabled = !s.scheduleRateEnabled; });
  // Public download protection (feature 7)
  $('cfg-prl-enable').checked = !!s.publicRateLimit;
  $('cfg-prl-max').value = s.publicRateMax || 600;
  $('cfg-prl-window').value = s.publicRateWindowMin || 1;
  ['cfg-prl-max','cfg-prl-window'].forEach((id) => { $(id).disabled = !s.publicRateLimit; });
  $('cfg-chal-enable').checked = !!s.challengeEnabled;
  $('cfg-chal-min').value = s.challengeMinMB || 200;
  $('cfg-chal-bits').value = s.challengeBits || 16;
  ['cfg-chal-min','cfg-chal-bits'].forEach((id) => { $(id).disabled = !s.challengeEnabled; });
  $('cfg-leak-enable').checked = !!s.leakAlertEnabled;
  $('cfg-leak-countries').value = s.leakAlertCountries || 3;
  $('cfg-leak-window').value = s.leakAlertWindowHours || 24;
  ['cfg-leak-countries','cfg-leak-window'].forEach((id) => { $(id).disabled = !s.leakAlertEnabled; });
  // Privacy
  $('cfg-geo').checked = s.geoLookup !== false;
  $('cfg-retention').value = s.historyRetentionDays ? String(s.historyRetentionDays) : '';
  $('cfg-log-retention').value = s.logRetentionDays ? String(s.logRetentionDays) : '';
  $('cfg-inbox-retention').value = s.inboxRetentionDays ? String(s.inboxRetentionDays) : '';
  $('cfg-anon-ip').checked = !!s.anonymizeIps;
  $('cfg-keep-names').checked = s.keepIpNames !== false;
  $('cfg-clear-names-result').textContent = '';
  // Interface
  $('cfg-brand').value = s.brandName || '';
  const hasAccent = !!(s.accentColor && /^#[0-9a-fA-F]{6}$/.test(s.accentColor));
  $('cfg-accent-on').checked = hasAccent;
  $('cfg-accent').value = hasAccent ? s.accentColor : '#3b82f6';
  $('cfg-accent').disabled = !hasAccent;
  // Public theme + mobile theme-color (features 1 & 9)
  $('cfg-public-theme').value = ['auto', 'dark', 'light'].includes(s.publicTheme) ? s.publicTheme : 'auto';
  const hasTc = !!(s.themeColor && /^#[0-9a-fA-F]{6}$/.test(s.themeColor));
  $('cfg-themecolor-on').checked = hasTc;
  $('cfg-themecolor').value = hasTc ? s.themeColor : '#0b1020';
  $('cfg-themecolor').disabled = !hasTc;
  $('cfg-admin-lang').value = s.adminLang || '';
  $('cfg-public-lang').value = s.publicLang || '';
  $('cfg-banner').value = s.receptionBanner || '';
  if ($('cfg-expiry-presets')) $('cfg-expiry-presets').value = s.expiryPresets || '1h,1d,7d,30d';
  // Branding / watermark (feature 8)
  cfgLogoData = (typeof s.publicLogo === 'string') ? s.publicLogo : '';
  renderLogoPreview();
  $('cfg-logo-result').textContent = '';
  $('cfg-legal').value = s.legalNotice || '';
  $('cfg-watermark').checked = !!s.watermarkPreviews;
  $('cfg-import-result').textContent = '';
  $('cfg-shares-import-result').textContent = '';
  // Scheduled backup
  $('cfg-bk-enable').checked = !!s.backupEnabled;
  $('cfg-bk-interval').value = s.backupInterval === 'weekly' ? 'weekly' : 'daily';
  $('cfg-bk-hour').value = (s.backupHour != null) ? s.backupHour : 3;
  $('cfg-bk-weekday').value = String(s.backupWeekday || 0);
  $('cfg-bk-dest').value = ['local', 'webdav', 's3'].includes(s.backupDestType) ? s.backupDestType : 'local';
  $('cfg-bk-localdir').value = s.backupLocalDir || '';
  $('cfg-bk-webdav-url').value = s.backupWebdavUrl || '';
  $('cfg-bk-webdav-user').value = s.backupWebdavUser || '';
  $('cfg-bk-webdav-pass').value = '';
  $('cfg-bk-webdav-pass').placeholder = s.backupWebdavPassSet ? '••••••••' : '';
  $('cfg-bk-s3-endpoint').value = s.backupS3Endpoint || '';
  $('cfg-bk-s3-bucket').value = s.backupS3Bucket || '';
  $('cfg-bk-s3-region').value = s.backupS3Region || 'us-east-1';
  $('cfg-bk-s3-prefix').value = s.backupS3Prefix || '';
  $('cfg-bk-s3-key').value = s.backupS3Key || '';
  $('cfg-bk-s3-secret').value = '';
  $('cfg-bk-s3-secret').placeholder = s.backupS3SecretSet ? '••••••••' : '';
  $('cfg-bk-retention').value = (s.backupRetention != null) ? s.backupRetention : 7;
  $('cfg-bk-encwarn').classList.toggle('hidden', !!s.dataEncrypted);
  $('cfg-bk-result').textContent = '';
  $('cfg-bk-restore-result').textContent = '';
  updateBackupDestFields();
  renderBackupStatus(s.lastBackup);
  // At-rest encryption status (feature 6, env-controlled → read-only indicator)
  const enc = $('cfg-enc-status');
  enc.textContent = s.dataEncrypted ? t('cfg.encOn') : t('cfg.encOff');
  enc.className = 'muted sm' + (s.dataEncrypted ? ' cfg-ok' : '');
  $('config-error').classList.add('hidden');
  $('config-overlay').classList.remove('hidden');
  // The periodic poll omits the custom logo (it can be ~256 KB) and sends only a
  // `publicLogoSet` flag. The modal is already visible, so fetch the full settings
  // in the background and refresh just the logo preview — opening never waits on
  // the network. Only needed when a logo exists and isn't already loaded.
  if (s.publicLogoSet && !cfgLogoData) {
    try {
      const full = await api('GET', '/api/settings');
      if (full) {
        state.settings = { ...state.settings, ...full };
        cfgLogoData = (typeof full.publicLogo === 'string') ? full.publicLogo : '';
        renderLogoPreview();
      }
    } catch (_) { /* leave the placeholder; the field is refetched on the next open */ }
  }
}
function closeConfigModal() { $('config-overlay').classList.add('hidden'); }
if ($('config-btn')) $('config-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeUserMenu();
  closeDashMenu();
  openConfigModal();
});
if ($('config-close')) $('config-close').addEventListener('click', closeConfigModal);
if ($('config-cancel')) $('config-cancel').addEventListener('click', closeConfigModal);
if ($('config-overlay')) $('config-overlay').addEventListener('click', (e) => {
  if (e.target === $('config-overlay')) closeConfigModal();
});
if ($('cfg-idle-enable')) $('cfg-idle-enable').addEventListener('change', () => {
  $('cfg-idle-mins').disabled = !$('cfg-idle-enable').checked;
});
// Accent colour: the picker is only active when "custom accent" is ticked, and
// changes preview live on the admin UI.
if ($('cfg-accent-on')) $('cfg-accent-on').addEventListener('change', () => {
  const on = $('cfg-accent-on').checked;
  $('cfg-accent').disabled = !on;
  applyBranding({ ...state.settings, accentColor: on ? $('cfg-accent').value : '' });
});
if ($('cfg-accent')) $('cfg-accent').addEventListener('input', () => {
  if ($('cfg-accent-on').checked) applyBranding({ ...state.settings, accentColor: $('cfg-accent').value });
});
if ($('cfg-themecolor-on')) $('cfg-themecolor-on').addEventListener('change', () => {
  $('cfg-themecolor').disabled = !$('cfg-themecolor-on').checked;
});
// Feature 5/7 — grey out dependent fields when their master toggle is off.
function bindToggle(masterId, fieldIds) {
  const m = $(masterId);
  if (!m) return;
  m.addEventListener('change', () => fieldIds.forEach((id) => { if ($(id)) $(id).disabled = !m.checked; }));
}
bindToggle('cfg-sched-enable', ['cfg-sched-rate', 'cfg-sched-start', 'cfg-sched-end']);
bindToggle('cfg-prl-enable', ['cfg-prl-max', 'cfg-prl-window']);
bindToggle('cfg-chal-enable', ['cfg-chal-min', 'cfg-chal-bits']);
bindToggle('cfg-leak-enable', ['cfg-leak-countries', 'cfg-leak-window']);
// Feature 4 — download the admin audit log.
if ($('cfg-audit-json')) $('cfg-audit-json').addEventListener('click', () => window.open('/api/audit/export?format=json', '_blank'));
if ($('cfg-audit-csv')) $('cfg-audit-csv').addEventListener('click', () => window.open('/api/audit/export?format=csv', '_blank'));

// --- Scheduled backup + restore ---
function updateBackupDestFields() {
  const d = $('cfg-bk-dest') ? $('cfg-bk-dest').value : 'local';
  if ($('cfg-bk-local')) $('cfg-bk-local').classList.toggle('hidden', d !== 'local');
  if ($('cfg-bk-webdav')) $('cfg-bk-webdav').classList.toggle('hidden', d !== 'webdav');
  if ($('cfg-bk-s3')) $('cfg-bk-s3').classList.toggle('hidden', d !== 's3');
  if ($('cfg-bk-weekday-row')) $('cfg-bk-weekday-row').classList.toggle('hidden', $('cfg-bk-interval').value !== 'weekly');
  // Download + restore expose/replace ALL data → owner-only.
  const owner = state.settings && state.settings.role === 'owner';
  ['cfg-bk-download', 'cfg-bk-restore'].forEach((id) => { if ($(id)) $(id).disabled = !owner; });
}
function renderBackupStatus(last) {
  const el = $('cfg-bk-status'); if (!el) return;
  if (!last || !last.at) { el.textContent = t('cfg.bkNever'); el.className = 'muted sm'; return; }
  const when = new Date(last.at).toLocaleString();
  if (last.ok) { el.textContent = t('cfg.bkLastOk', { when: when, dest: last.dest || '' }); el.className = 'sm cfg-ok'; }
  else { el.textContent = t('cfg.bkLastFail', { when: when, err: last.error || '' }); el.className = 'sm cfg-bad'; }
}
if ($('cfg-bk-dest')) $('cfg-bk-dest').addEventListener('change', updateBackupDestFields);
if ($('cfg-bk-interval')) $('cfg-bk-interval').addEventListener('change', updateBackupDestFields);
if ($('cfg-bk-now')) $('cfg-bk-now').addEventListener('click', async () => {
  const out = $('cfg-bk-result'); out.textContent = t('cfg.bkRunning'); out.className = 'muted sm';
  try {
    const r = await api('POST', '/api/backup-now', {});
    if (r && r.result && r.result.ok) { out.textContent = t('cfg.bkDone'); out.className = 'sm cfg-ok'; }
    else { out.textContent = t('cfg.bkFail') + (r && r.error ? ' (' + r.error + ')' : ''); out.className = 'sm cfg-bad'; }
    if (r && r.lastBackup) { state.settings.lastBackup = r.lastBackup; renderBackupStatus(r.lastBackup); }
  } catch (e) { out.textContent = t('cfg.bkFail') + (e.data && e.data.error ? ' (' + e.data.error + ')' : ''); out.className = 'sm cfg-bad'; }
});
if ($('cfg-bk-test')) $('cfg-bk-test').addEventListener('click', async () => {
  const out = $('cfg-bk-result'); out.textContent = t('cfg.bkTesting'); out.className = 'muted sm';
  try {
    const r = await api('POST', '/api/backup-test', {});
    if (r && r.ok) { out.textContent = t('cfg.bkTestOk'); out.className = 'sm cfg-ok'; }
    else { out.textContent = t('cfg.bkTestFail') + (r && r.error ? ' (' + r.error + ')' : ''); out.className = 'sm cfg-bad'; }
  } catch (e) { out.textContent = t('cfg.bkTestFail') + (e.data && e.data.error ? ' (' + e.data.error + ')' : ''); out.className = 'sm cfg-bad'; }
});
if ($('cfg-bk-download')) $('cfg-bk-download').addEventListener('click', () => window.open('/api/backup/download', '_blank'));
if ($('cfg-bk-restore')) $('cfg-bk-restore').addEventListener('click', () => {
  if (!confirm(t('cfg.bkRestoreConfirm'))) return;
  $('cfg-bk-restore-file').click();
});
if ($('cfg-bk-restore-file')) $('cfg-bk-restore-file').addEventListener('change', async (ev) => {
  const out = $('cfg-bk-restore-result');
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  out.textContent = t('cfg.bkRestoring'); out.className = 'muted sm';
  try {
    const buf = await file.arrayBuffer();
    // Raw octet-stream so the server's JSON parser leaves the body untouched.
    const r = await fetch('/api/restore', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': state.csrf || '' },
      body: buf,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      out.textContent = t('cfg.bkRestoreOk', { n: j.shares != null ? j.shares : '' }); out.className = 'sm cfg-ok';
      setTimeout(() => location.reload(), 1200);
    } else { out.textContent = t('cfg.bkRestoreFail') + (j && j.error ? ' (' + j.error + ')' : ''); out.className = 'sm cfg-bad'; }
  } catch (e) { out.textContent = t('cfg.bkRestoreFail'); out.className = 'sm cfg-bad'; }
});
// Feature 8 — custom logo (kept in memory as a data: URL until the form is saved).
let cfgLogoData = '';
function renderLogoPreview() {
  const img = $('cfg-logo-preview'), clr = $('cfg-logo-clear');
  if (!img) return;
  if (cfgLogoData) { img.src = cfgLogoData; img.classList.remove('hidden'); if (clr) clr.classList.remove('hidden'); }
  else { img.removeAttribute('src'); img.classList.add('hidden'); if (clr) clr.classList.add('hidden'); }
}
if ($('cfg-logo-pick')) $('cfg-logo-pick').addEventListener('click', () => $('cfg-logo-file').click());
if ($('cfg-logo-clear')) $('cfg-logo-clear').addEventListener('click', () => {
  cfgLogoData = ''; renderLogoPreview(); $('cfg-logo-result').textContent = '';
});
if ($('cfg-logo-file')) $('cfg-logo-file').addEventListener('change', (ev) => {
  const out = $('cfg-logo-result');
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (file.size > 200 * 1024) { out.textContent = t('cfg.logoTooLarge'); out.className = 'sm cfg-bad'; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const data = String(reader.result || '');
    if (data.length > 262144) { out.textContent = t('cfg.logoTooLarge'); out.className = 'sm cfg-bad'; return; }
    cfgLogoData = data; renderLogoPreview(); out.textContent = '';
  };
  reader.onerror = () => { out.textContent = t('cfg.saveFail'); out.className = 'sm cfg-bad'; };
  reader.readAsDataURL(file);
});
// Clear every stored visitor nickname.
if ($('cfg-clear-names')) $('cfg-clear-names').addEventListener('click', async () => {
  const out = $('cfg-clear-names-result');
  try {
    const r = await api('DELETE', '/api/ip-names');
    out.textContent = t('cfg.cleared', { n: (r && r.cleared) || 0 });
    out.className = 'sm cfg-ok';
  } catch (e2) { out.textContent = t('cfg.saveFail'); out.className = 'sm cfg-bad'; }
});
// Export the current settings as a JSON download.
if ($('cfg-export')) $('cfg-export').addEventListener('click', () => {
  window.open('/api/settings/export', '_blank');
});
// Import a previously exported settings file.
if ($('cfg-import')) $('cfg-import').addEventListener('click', () => $('cfg-import-file').click());
if ($('cfg-import-file')) $('cfg-import-file').addEventListener('change', async (ev) => {
  const out = $('cfg-import-result');
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const r = await api('POST', '/api/settings/import', parsed);
    if (r) { state.settings = r; applyBranding(r); }
    openConfigModal(); // re-populate every field from the imported values
    out.textContent = t('cfg.imported', { n: (r && r.imported) || 0 });
    out.className = 'sm cfg-ok';
  } catch (e2) {
    out.textContent = t('cfg.importFail');
    out.className = 'sm cfg-bad';
  }
});

// Test the webhook (uses the URL currently in the field, unless env-managed).
if ($('cfg-webhook-test')) $('cfg-webhook-test').addEventListener('click', async () => {
  const out = $('cfg-webhook-result');
  out.textContent = t('cfg.webhookTesting');
  out.className = 'muted sm';
  const body = { url: $('cfg-webhook-url').value.trim(), format: $('cfg-webhook-format').value };
  try {
    const r = await api('POST', '/api/webhook-test', body);
    if (r && r.ok) { out.textContent = t('cfg.webhookOk'); out.className = 'sm cfg-ok'; }
    else { out.textContent = t('cfg.webhookFail') + (r && r.error ? ' (' + r.error + ')' : ''); out.className = 'sm cfg-bad'; }
  } catch (e2) {
    const code = e2.data && e2.data.error;
    out.textContent = code === 'no-url' ? t('cfg.webhookNoUrl') : code === 'invalid-webhook' ? t('cfg.webhookInvalid') : t('cfg.webhookFail');
    out.className = 'sm cfg-bad';
  }
});

// ------------------------------------------------------------------
// Web Push (browser notifications). Subscribes THIS browser to the server's push
// channel (VAPID). Each browser/device is independent; the subscription is stored
// server-side and used by the notification dispatcher alongside webhook/e-mail.
// ------------------------------------------------------------------
function webPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
// Returns the active PushSubscription for the admin push SW, or null.
async function currentPushSubscription() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/pushsw.js');
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch (_) { return null; }
}
// Reflects the current state in the config UI (availability, permission, subscription).
async function refreshWebPushUI() {
  const toggle = $('cfg-webpush-toggle');
  const testBtn = $('cfg-webpush-test');
  const status = $('cfg-webpush-status');
  const unavail = $('cfg-webpush-unavail');
  const insecure = $('cfg-webpush-insecure');
  if (!toggle) return;
  const serverOk = !!(state.settings && state.settings.webPushAvailable);
  if (unavail) unavail.classList.toggle('hidden', serverOk);
  const secure = window.isSecureContext;
  if (insecure) insecure.classList.toggle('hidden', secure || !serverOk);
  if (!serverOk || !webPushSupported() || !secure) {
    toggle.disabled = true;
    if (testBtn) testBtn.classList.add('hidden');
    if (status) status.textContent = !serverOk ? '' : (!secure ? '' : t('cfg.webpushNoSupport'));
    return;
  }
  toggle.disabled = false;
  const sub = await currentPushSubscription();
  const subscribed = !!sub && Notification.permission === 'granted';
  toggle.textContent = subscribed ? t('cfg.webpushDisable') : t('cfg.webpushEnable');
  toggle.className = subscribed ? 'btn ghost sm' : 'btn sm';
  if (testBtn) testBtn.classList.toggle('hidden', !subscribed);
  if (status) {
    status.textContent = subscribed ? t('cfg.webpushOn')
      : (Notification.permission === 'denied' ? t('cfg.webpushDenied') : '');
    status.className = subscribed ? 'sm cfg-ok' : 'muted sm';
  }
}
async function enableWebPush() {
  const status = $('cfg-webpush-status');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { if (status) { status.textContent = t('cfg.webpushDenied'); status.className = 'sm cfg-bad'; } return; }
    const reg = await navigator.serviceWorker.register('/pushsw.js');
    await navigator.serviceWorker.ready;
    const { publicKey } = await api('GET', '/api/push/vapid');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
    }
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    toast(t('cfg.webpushSubscribed'), 'ok');
  } catch (e) {
    if (status) { status.textContent = t('cfg.webpushFail') + ((e && e.message) ? ' (' + e.message + ')' : ''); status.className = 'sm cfg-bad'; }
  }
  refreshWebPushUI();
}
async function disableWebPush() {
  try {
    const sub = await currentPushSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await api('POST', '/api/push/unsubscribe', { endpoint }).catch(() => {});
    }
    toast(t('cfg.webpushUnsubscribed'), 'ok');
  } catch (_) {}
  refreshWebPushUI();
}
if ($('cfg-webpush-toggle')) $('cfg-webpush-toggle').addEventListener('click', async () => {
  const sub = await currentPushSubscription();
  if (sub && Notification.permission === 'granted') disableWebPush();
  else enableWebPush();
});
if ($('cfg-webpush-test')) $('cfg-webpush-test').addEventListener('click', async () => {
  const status = $('cfg-webpush-status');
  try {
    await api('POST', '/api/push/test');
    if (status) { status.textContent = t('cfg.webpushTestSent'); status.className = 'sm cfg-ok'; }
  } catch (e) {
    const code = e && e.data && e.data.error;
    if (status) { status.textContent = code === 'no-subscription' ? t('cfg.webpushNoSub') : t('cfg.webpushFail'); status.className = 'sm cfg-bad'; }
  }
});

// Expiry alert / digest: grey out the number field when the toggle is off.
if ($('cfg-notify-expiring')) $('cfg-notify-expiring').addEventListener('change', () => {
  $('cfg-expiry-hours').disabled = !$('cfg-notify-expiring').checked;
});
if ($('cfg-digest-enable')) $('cfg-digest-enable').addEventListener('change', () => {
  $('cfg-digest-days').disabled = !$('cfg-digest-enable').checked;
});
// Send the periodic digest immediately (uses the saved webhook + settings).
if ($('cfg-digest-test')) $('cfg-digest-test').addEventListener('click', async () => {
  const out = $('cfg-digest-result');
  out.textContent = t('cfg.webhookTesting');
  out.className = 'muted sm';
  try {
    const r = await api('POST', '/api/digest-test', {});
    if (r && r.ok) { out.textContent = t('cfg.digestSent'); out.className = 'sm cfg-ok'; }
    else { out.textContent = t('cfg.webhookFail'); out.className = 'sm cfg-bad'; }
  } catch (e2) {
    const code = e2.data && e2.data.error;
    out.textContent = code === 'no-channel' ? t('cfg.noChannel') : t('cfg.webhookFail');
    out.className = 'sm cfg-bad';
  }
});

// E-mail (SMTP): send a test message using the SAVED settings.
if ($('cfg-email-enable')) $('cfg-email-enable').addEventListener('change', () => {
  // (no field toggling needed — SMTP fields stay editable; enable just gates sending)
});
if ($('cfg-email-test')) $('cfg-email-test').addEventListener('click', async () => {
  const out = $('cfg-email-result');
  out.textContent = t('cfg.emailTesting');
  out.className = 'muted sm';
  try {
    const r = await api('POST', '/api/email-test', {});
    if (r && r.ok) { out.textContent = t('cfg.emailOk'); out.className = 'sm cfg-ok'; }
    else { out.textContent = t('cfg.emailFail'); out.className = 'sm cfg-bad'; }
  } catch (e2) {
    const code = e2.data && e2.data.error;
    out.textContent = code === 'not-configured' ? t('cfg.emailNotConfigured')
      : code === 'no-module' ? t('cfg.emailUnavail')
      : t('cfg.emailFail') + (code ? ' (' + code + ')' : '');
    out.className = 'sm cfg-bad';
  }
});

// Export every link's configuration (feature 4).
if ($('cfg-shares-export')) $('cfg-shares-export').addEventListener('click', () => {
  window.open('/api/shares/export', '_blank');
});
// Import a links-config file (feature 4). Confirms before touching existing links.
if ($('cfg-shares-import')) $('cfg-shares-import').addEventListener('click', () => $('cfg-shares-import-file').click());
if ($('cfg-shares-import-file')) $('cfg-shares-import-file').addEventListener('change', async (ev) => {
  const out = $('cfg-shares-import-result');
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (!confirm(t('cfg.sharesImportConfirm'))) return;
  try {
    const parsed = JSON.parse(await file.text());
    const r = await api('POST', '/api/shares/import', parsed);
    out.textContent = t('cfg.sharesImported', { n: (r && r.added) || 0, s: (r && r.skipped) || 0 });
    out.className = 'sm cfg-ok';
    if (typeof refreshShares === 'function') refreshShares(); // refresh the links list
  } catch (e2) {
    out.textContent = t('cfg.importFail');
    out.className = 'sm cfg-bad';
  }
});

if ($('config-form')) $('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const on = $('cfg-idle-enable').checked;
  let mins = parseInt($('cfg-idle-mins').value, 10) || 0;
  if (on && mins < 1) mins = 1;
  const idleLockMinutes = on ? Math.min(1440, mins) : 0;
  const mb = (id) => { const n = parseFloat($(id).value); return Number.isFinite(n) && n > 0 ? Math.round(n * 1024 * 1024) : 0; };
  const payload = {
    idleLockMinutes,
    webhookFormat: $('cfg-webhook-format').value,
    notifyDownloads: $('cfg-notify-downloads').checked,
    notifyUploads: $('cfg-notify-uploads').checked,
    notifyMessages: $('cfg-notify-messages').checked,
    notifyExpiring: $('cfg-notify-expiring').checked,
    expiryWarnHours: parseInt($('cfg-expiry-hours').value, 10) || 24,
    digestEnabled: $('cfg-digest-enable').checked,
    notifySecurity: $('cfg-notify-security').checked,
    digestDays: parseInt($('cfg-digest-days').value, 10) || 7,
    defaultExpiry: parseInt($('cfg-def-expiry').value, 10) || 0,
    defaultMaxDownloads: parseInt($('cfg-def-maxdl').value, 10) || 0,
    defaultRateKBps: parseInt($('cfg-def-rate').value, 10) || 0,
    defaultAllowZip: $('cfg-def-allowzip').checked,
    defaultAllowPreview: $('cfg-def-preview').checked,
    defaultRequirePassword: $('cfg-def-reqpw').checked,
    defaultBurnAfterDownload: $('cfg-def-burn').checked,
    defaultShowQr: $('cfg-def-qr').checked,
    defaultStartDelayHours: parseInt($('cfg-def-startdelay').value, 10) || 0,
    defaultShareDir: $('cfg-default-dir').value.trim(),
    defaultMaxFiles: parseInt($('cfg-def-maxfiles').value, 10) || 0,
    defaultMaxFileBytes: mb('cfg-def-maxfile'),
    defaultMaxTotalBytes: mb('cfg-def-maxtotal'),
    defaultAllowExt: $('cfg-def-allowext').value,
    defaultBlockExt: $('cfg-def-blockext').value,
    defaultEncrypt: $('cfg-def-encrypt').checked,
    maxLoginAttempts: parseInt($('cfg-max-attempts').value, 10) || 5,
    lockoutMinutes: parseInt($('cfg-lockout-mins').value, 10) || 5,
    sessionHours: parseInt($('cfg-session-hours').value, 10) || 0,
    httpsWarning: $('cfg-https-warn').checked,
    tokenBytes: parseInt($('cfg-token-bytes').value, 10) || 24,
    requireTwoFactor: $('cfg-require-2fa').checked,
    globalRateKBps: parseInt($('cfg-global-rate').value, 10) || 0,
    maxUploadBytes: mb('cfg-max-upload'),
    maxZipBytes: mb('cfg-max-zip'),
    updateCheck: $('cfg-update-check').checked,
    scheduleRateEnabled: $('cfg-sched-enable').checked,
    scheduleRateKBps: parseInt($('cfg-sched-rate').value, 10) || 0,
    scheduleStart: $('cfg-sched-start').value || '08:00',
    scheduleEnd: $('cfg-sched-end').value || '18:00',
    publicRateLimit: $('cfg-prl-enable').checked,
    publicRateMax: parseInt($('cfg-prl-max').value, 10) || 600,
    publicRateWindowMin: parseInt($('cfg-prl-window').value, 10) || 1,
    challengeEnabled: $('cfg-chal-enable').checked,
    challengeMinMB: parseInt($('cfg-chal-min').value, 10) || 200,
    challengeBits: parseInt($('cfg-chal-bits').value, 10) || 16,
    leakAlertEnabled: $('cfg-leak-enable').checked,
    leakAlertCountries: parseInt($('cfg-leak-countries').value, 10) || 3,
    leakAlertWindowHours: parseInt($('cfg-leak-window').value, 10) || 24,
    publicLogo: cfgLogoData || '',
    legalNotice: $('cfg-legal').value.trim(),
    watermarkPreviews: $('cfg-watermark').checked,
    historyRetentionDays: parseInt($('cfg-retention').value, 10) || 0,
    logRetentionDays: parseInt($('cfg-log-retention').value, 10) || 0,
    inboxRetentionDays: parseInt($('cfg-inbox-retention').value, 10) || 0,
    anonymizeIps: $('cfg-anon-ip').checked,
    keepIpNames: $('cfg-keep-names').checked,
    brandName: $('cfg-brand').value.trim(),
    accentColor: $('cfg-accent-on').checked ? $('cfg-accent').value : '',
    publicTheme: $('cfg-public-theme').value,
    themeColor: $('cfg-themecolor-on').checked ? $('cfg-themecolor').value : '',
    adminLang: $('cfg-admin-lang').value,
    publicLang: $('cfg-public-lang').value,
    receptionBanner: $('cfg-banner').value,
    expiryPresets: $('cfg-expiry-presets') ? $('cfg-expiry-presets').value : undefined,
    geoLookup: $('cfg-geo').checked,
    backupEnabled: $('cfg-bk-enable').checked,
    backupInterval: $('cfg-bk-interval').value,
    backupHour: parseInt($('cfg-bk-hour').value, 10) || 0,
    backupWeekday: parseInt($('cfg-bk-weekday').value, 10) || 0,
    backupRetention: parseInt($('cfg-bk-retention').value, 10) || 0,
    backupDestType: $('cfg-bk-dest').value,
    backupLocalDir: $('cfg-bk-localdir').value.trim(),
    backupWebdavUrl: $('cfg-bk-webdav-url').value.trim(),
    backupWebdavUser: $('cfg-bk-webdav-user').value.trim(),
    backupS3Endpoint: $('cfg-bk-s3-endpoint').value.trim(),
    backupS3Bucket: $('cfg-bk-s3-bucket').value.trim(),
    backupS3Region: $('cfg-bk-s3-region').value.trim() || 'us-east-1',
    backupS3Prefix: $('cfg-bk-s3-prefix').value.trim(),
    backupS3Key: $('cfg-bk-s3-key').value.trim(),
  };
  // Blank sensitive backup fields = keep the stored value; only send when typed.
  if ($('cfg-bk-webdav-pass').value) payload.backupWebdavPass = $('cfg-bk-webdav-pass').value;
  if ($('cfg-bk-s3-secret').value) payload.backupS3Secret = $('cfg-bk-s3-secret').value;
  // Only send the webhook URL when it's editable (not env-managed).
  if (!$('cfg-webhook-url').disabled) payload.webhookUrl = $('cfg-webhook-url').value.trim();
  // Admin IP allowlist — only when editable (not env-managed). Confirm on change,
  // since a wrong entry can lock the admin out (loopback stays allowed).
  if (!$('cfg-admin-allowlist').disabled) {
    const al = $('cfg-admin-allowlist').value.trim();
    const cur = (state.settings && state.settings.adminAllowedIps) || '';
    if (al !== cur) {
      if (al && !confirm(t('cfg.allowlistConfirm'))) return;
    }
    payload.adminAllowedIps = al;
  }
  // E-mail (SMTP) — only when editable (not env-managed / module available).
  if (!$('cfg-email-enable').disabled) {
    payload.emailEnabled = $('cfg-email-enable').checked;
    payload.smtpHost = $('cfg-smtp-host').value.trim();
    payload.smtpPort = parseInt($('cfg-smtp-port').value, 10) || 587;
    payload.smtpSecure = $('cfg-smtp-secure').checked;
    payload.smtpUser = $('cfg-smtp-user').value.trim();
    payload.smtpFrom = $('cfg-smtp-from').value.trim();
    payload.smtpTo = $('cfg-smtp-to').value.trim();
    // Blank password = keep the stored one; only send when the admin typed a new one.
    const pw = $('cfg-smtp-pass').value;
    if (pw) payload.smtpPass = pw;
  }
  // Destructive setting: confirm when enabling (or raising) auto-deletion of files.
  const prevInboxRet = (state.settings && parseInt(state.settings.inboxRetentionDays, 10)) || 0;
  if (payload.inboxRetentionDays > 0 && payload.inboxRetentionDays !== prevInboxRet) {
    if (!confirm(t('cfg.inboxRetentionConfirm', { n: payload.inboxRetentionDays }))) return;
  }
  try {
    const r = await api('POST', '/api/settings', payload);
    if (r) { state.settings = r; applyBranding(r); }
    applyIdleLock(idleLockMinutes);
    closeConfigModal();
    toast(r && r.persisted === false ? t('cfg.savedTemp') : t('cfg.saved'), r && r.persisted === false ? 'warn' : 'ok');
  } catch (e2) {
    const err = $('config-error');
    const code = e2.data && e2.data.error;
    err.textContent = code === 'invalid-webhook' ? t('cfg.webhookInvalid')
      : (code === 'invalid-logo' || code === 'logo-too-large') ? t('cfg.logoTooLarge')
      : t('cfg.saveFail');
    err.classList.remove('hidden');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('config-overlay') && !$('config-overlay').classList.contains('hidden')) closeConfigModal();
  if (e.key === 'Escape' && $('edit-overlay') && !$('edit-overlay').classList.contains('hidden')) closeEditModal();
});

// Role-based UI gating (server enforces the real access; this just hides what a
// role can't use). auditor = read-only; operator = no settings/accounts.
function applyRole(role) {
  role = role || state.role || '';
  applySessionIdentity();
  document.body.dataset.role = role;
  const show = (id, on) => { const el2 = $(id); if (el2) el2.classList.toggle('hidden', !on); };
  const isFull = role === 'owner' || role === 'admin' || !role;
  const canCreate = isFull || role === 'operator'; // operators create their own links
  show('config-btn', isFull);         // global settings: owner/admin only
  show('new-share-btn', canCreate);
  show('new-inbox-btn', canCreate);
  show('new-collab-btn', canCreate);
  show('new-secret-btn', canCreate && (window.DXCrypto && window.DXCrypto.available));
  show('new-enc-btn', canCreate && (window.DXCrypto && window.DXCrypto.available));
  show('export-csv-btn', isFull);
  show('export-json-btn', isFull);
  show('history-clear-btn', isFull);
  show('photos-history-purge', canCreate);
  // Auditors are read-only: CSS (body[data-role="auditor"]) hides the remaining
  // mutating controls (shutdown toggle, per-link actions, tags, bulk bar).
}

// Feature 9 — build the quick expiry <option>s of the creation modals from the
// admin's presets ("1h,1d,7d,30d"). "Never" is always first; the edit modal keeps
// its own options (it maps an existing link's absolute expiry).
function parsePresetToken(tok) {
  const m = /^(\d{1,4})(h|d|w|mo)$/.exec(String(tok).trim().toLowerCase());
  if (!m) return null;
  const n = parseInt(m[1], 10), u = m[2];
  const secs = u === 'h' ? n * 3600 : u === 'd' ? n * 86400 : u === 'w' ? n * 604800 : n * 2592000;
  const unit = { h: t('pk.unitH'), d: t('pk.unitD'), w: t('pk.unitW'), mo: t('pk.unitMo') }[u];
  return { secs, label: n + ' ' + unit };
}
function fillExpirySelect(sel, presetsStr) {
  if (!sel) return;
  const prev = sel.value;
  const toks = String(presetsStr || '1h,1d,7d,30d').split(',').map((x) => x.trim()).filter(Boolean);
  sel.innerHTML = '';
  const never = document.createElement('option'); never.value = '0'; never.textContent = t('pk.never'); sel.appendChild(never);
  toks.forEach((tk) => {
    const p = parsePresetToken(tk); if (!p) return;
    const o = document.createElement('option'); o.value = String(p.secs); o.textContent = p.label; sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
function applyExpiryPresets(settings) {
  const ps = (settings && settings.expiryPresets) || '1h,1d,7d,30d';
  // All creation modals share the presets: file/folder, reception, collaboration,
  // encrypted share and secret note. The edit modal keeps its own options (it maps
  // an existing link's absolute expiry, plus a "keep unchanged" entry).
  ['opt-expiry', 'ib-expiry', 'cl-expiry', 'enc-expiry', 'secret-expiry'].forEach((id) => fillExpirySelect($(id), ps));
}

function syncSettings(settings) {
  if (!settings) return;
  state.settings = settings; // kept for the Configuration window
  applyBranding(settings);   // custom accent colour + app name
  applyExpiryPresets(settings); // feature 9: custom quick expiry presets
  maybeApplyAdminLang(settings); // default admin language (only if the user never chose)
  maybeShowHttpsWarning(settings);
  maybeEnforceTwoFactor(settings); // nag to set up 2FA when the policy requires it
  applyRole(settings.role); // hide controls the current role can't use
  // The idle-lock setting is applied even during the "dirty" window (it isn't an
  // input the user is editing in the main view).
  applyIdleLock(parseInt(settings.idleLockMinutes, 10) || 0);
  if (Date.now() < state.settingsDirtyUntil) return;
  $('shutdown-toggle').checked = !!settings.shutdownAfterDownload;

  const inp = $('link-base');
  if (document.activeElement !== inp) {
    const base = settings.linkBase || '';
    const m = /^(https?):\/\/(.+)$/i.exec(base);
    const host = m ? m[2] : '';
    if (inp.value !== host) inp.value = host;
    $('link-ssl').checked = m ? m[1].toLowerCase() === 'https' : false;
  }
  // A direct load of /images can open the Images page before the first settings poll
  // arrives; refresh its domain / hotlink inputs here so they aren't left blank.
  if (imagesPageOpen()) syncImageSettingsFields();
}

// When the "require 2FA" policy is on, nudge the signed-in admin to enable 2FA:
// once per session, if their account has no 2FA yet, open the setup modal and warn.
async function maybeEnforceTwoFactor(settings) {
  if (!settings || !settings.requireTwoFactor || state.tfaNagged || !isLoggedIn()) return;
  state.tfaNagged = true; // only prompt once per session
  try {
    const st = await api('GET', '/api/2fa/status');
    if (st && !st.enabled) {
      toast(t('cfg.tfaRequired'), 'warn');
      if (typeof openTfaModal === 'function') openTfaModal();
    }
  } catch (_) { /* ignore — not critical */ }
}

async function saveLinkBase() {
  const host = $('link-base').value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const ssl = $('link-ssl').checked;
  const linkBase = host ? (ssl ? 'https://' : 'http://') + host : '';
  state.settingsDirtyUntil = Date.now() + 3000;
  state.settingsEpoch++; // invalide les sondages déjà en vol (réponses périmées)
  try {
    const s = await api('POST', '/api/settings', { linkBase });
    const m = /^(https?):\/\/(.+)$/i.exec(s.linkBase || '');
    $('link-base').value = m ? m[2] : '';
    $('link-ssl').checked = m ? m[1].toLowerCase() === 'https' : false;
    if (s.persisted === false) toast(t('net.saveNoPersist'), 'warn');
    else toast(s.linkBase ? t('net.domainSaved') : t('net.autoRestored'), 'ok');
    loadNetwork();
    refreshShares();
  } catch (e) {
    toast(e.data && e.data.error === 'invalid-domain' ? t('net.domainInvalid') : t('net.saveError'), 'err');
  }
}

$('link-base-save').addEventListener('click', saveLinkBase);
// Reset the link domain to its default (auto-detection): clear the field and
// save an empty value, which the server maps back to auto-detection.
$('link-base-reset').addEventListener('click', () => {
  $('link-base').value = '';
  $('link-ssl').checked = false;
  saveLinkBase();
});
$('link-ssl').addEventListener('change', () => {
  state.settingsDirtyUntil = Date.now() + 8000;
});
$('link-base').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveLinkBase();
  }
});

// ------------------------------------------------------------------
// Shares: automatic refresh (3 s)
// ------------------------------------------------------------------
function historyMetaSignature(meta) {
  const m = meta || {};
  return [Number(m.count) || 0, m.latestId || '', Number(m.latestAt) || 0, Number(m.viewRevision) || 0].join(':');
}

function photoHistoryMetaSignature(meta) {
  const m = meta || {};
  return [Number(m.count) || 0, m.latestId || '', Number(m.latestAt) || 0].join(':');
}

async function loadPhotoHistory() {
  if (state.photoHistoryLoadPromise) return state.photoHistoryLoadPromise;
  const request = (async () => {
    try {
      const data = await api('GET', '/api/photos/history');
      state.lastPhotoHistoryMetaSig = photoHistoryMetaSignature(data.meta);
      renderPhotoHistory(Array.isArray(data.history) ? data.history : []);
    } catch (e) {
      if (e.message === 'not-authenticated') stopPolling();
    }
  })();
  state.photoHistoryLoadPromise = request;
  try { await request; }
  finally { if (state.photoHistoryLoadPromise === request) state.photoHistoryLoadPromise = null; }
}

async function loadHistory() {
  if (state.historyLoadPromise) {
    state.historyReloadPending = true;
    return state.historyLoadPromise;
  }
  const request = (async () => {
    try {
      const data = await api('GET', '/api/history');
      state.lastHistoryMetaSig = historyMetaSignature(data.meta);
      renderHistory(Array.isArray(data.history) ? data.history : []);
    } catch (e) {
      if (e.message === 'not-authenticated') stopPolling();
    }
  })();
  state.historyLoadPromise = request;
  try {
    await request;
  } finally {
    if (state.historyLoadPromise === request) state.historyLoadPromise = null;
    if (state.historyReloadPending) {
      state.historyReloadPending = false;
      loadHistory();
    }
  }
}

function startPolling() {
  if (!state.pollTimer) {
    refreshShares();
    state.pollTimer = setInterval(refreshShares, REFRESH_MS);
    state.historyRenderTimer = setInterval(renderHistoryPage, 60000);
  }
  if (dashboardsPageOpen()) startDashboardAutoRefresh(activeDashboardTab());
}
function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.dashTimer) {
    clearInterval(state.dashTimer);
    state.dashTimer = null;
  }
  if (state.dashLiveTimer) {
    clearInterval(state.dashLiveTimer);
    state.dashLiveTimer = null;
  }
  if (state.historyRenderTimer) {
    clearInterval(state.historyRenderTimer);
    state.historyRenderTimer = null;
  }
}

async function refreshShares() {
  const epoch = state.settingsEpoch;
  try {
    const data = await api('GET', '/api/shares');
    if (state.connLost) {
      state.connLost = false;
      hideBanner();
    }
    // Sondage lancé avant un enregistrement : ses réglages sont périmés, on les ignore
    // (sinon il réécrit l'ancien domaine par-dessus celui qu'on vient d'enregistrer).
    // Only re-apply settings when they actually changed — syncSettings does real
    // DOM/CSS work (branding, rebuilding the expiry <select>s, role gating), which
    // is wasteful to run on every periodic poll.
    if (epoch === state.settingsEpoch) {
      const sj = JSON.stringify(data.settings);
      if (sj !== state.lastSettingsJson) {
        state.lastSettingsJson = sj;
        syncSettings(data.settings);
      } else {
        state.settings = data.settings; // keep the reference fresh without the re-apply
      }
    }
    // Active transfers carry live speeds → re-render when they change (incl. going
    // empty once); guarding avoids rebuilding an unchanged list every second.
    const tj = JSON.stringify(data.transfers);
    if (tj !== state.lastTransfersJson) {
      state.lastTransfersJson = tj;
      renderTransfers(data.transfers);
    }
    const historySig = historyMetaSignature(data.historyMeta);
    if (historySig !== state.lastHistoryMetaSig) loadHistory();
    const photoHistorySig = photoHistoryMetaSignature(data.photoHistoryMeta);
    if (photoHistorySig !== state.lastPhotoHistoryMetaSig) loadPhotoHistory();
    // Don't rebuild the list while the user is typing in it (inline rename, adding
    // a recipient…) — a re-render would destroy the focused input mid-edit. We also
    // leave lastSharesJson stale so the render happens on the next poll after editing.
    const listEl = $('shares-list');
    const a = document.activeElement;
    const editingInList = a && listEl && listEl.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    const json = JSON.stringify(data.shares);
    if (json !== state.lastSharesJson && !editingInList) {
      state.lastSharesJson = json;
      renderShares(data.shares);
    }
  } catch (e) {
    if (e.message === 'not-authenticated') {
      stopPolling();
      return;
    }
    state.connLost = true;
    showBanner(t('sh.connLost'));
  }
}

function updateLiveDot() {
  const dot = $('live-dot');
  if (!dot) return;
  dot.textContent = '● ' + t(state.connLost ? 'live.offline' : 'live.online');
  dot.style.color = state.connLost ? 'var(--danger)' : 'var(--ok)';
}

function showBanner(msg) {
  const b = $('conn-banner');
  b.textContent = msg;
  b.classList.remove('hidden');
  updateLiveDot();
}
function hideBanner() {
  $('conn-banner').classList.add('hidden');
  updateLiveDot();
}

function renderTransfers(transfers) {
  const arr = transfers || [];
  $('transfer-count').textContent = arr.length;
  const list = $('transfers-list');
  list.textContent = '';

  if (!arr.length) {
    list.appendChild(el('div', { class: 'empty', text: t('tr.none') }));
    return;
  }

  arr.forEach((tf) => {
    const up = tf.direction === 'up';
    const isZip = !!tf.isZip;
    const row = el('div', { class: 'transfer' });
    row.appendChild(el('span', { class: 'tflag', text: tf.flag || '🌐' }));

    const info = el('div', { class: 'tinfo' });
    const name = el('div', { class: 'tname' });
    name.appendChild(el('span', { class: 'ico', text: up ? '📥' : isZip ? '🗜️' : '📄' }));
    name.appendChild(el('span', { text: tf.name }));
    if (isZip) {
      name.appendChild(el('span', { class: 'tzip', text: t('tr.zip'), attrs: { title: t('tr.zipTitle') } }));
    }
    info.appendChild(name);

    // Progress + estimated time remaining. For a regular download/upload the total
    // is the file size and progress is the bytes transferred. For a .zip (folder or
    // collection) the compressed size is never known in advance, so progress tracks
    // the combined UNCOMPRESSED size of the packaged files vs. the bytes already read
    // from disk (reported by the archiver) — that ratio is what drives the ETA.
    let total, done, etaBps;
    if (isZip && tf.zipTotalBytes > 0) {
      total = tf.zipTotalBytes;
      done = tf.zipProcessedBytes || 0;
      etaBps = tf.durationMs > 0 ? (done / tf.durationMs) * 1000 : 0;
    } else {
      total = tf.expectedBytes || 0;
      done = tf.bytes;
      etaBps = tf.avgBps;
    }
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    if (pct !== null) {
      const bar = el('div', { class: 'tbar' });
      const fill = el('i');
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      info.appendChild(bar);
    }

    const meta = el('div', { class: 'tmeta' });
    meta.appendChild(ipTag(tf.ip, tf.ipName));
    meta.appendChild(el('span', { text: countryText(tf.country) }));
    meta.appendChild(el('span', { class: 'tspeed', text: (up ? '↑ ' : '↓ ') + formatSpeed(tf.avgBps) }));
    meta.appendChild(
      el('span', {
        text:
          pct !== null
            ? formatBytes(done) + ' / ' + formatBytes(total) + ' (' + pct + '%)'
            : formatBytes(tf.bytes),
      })
    );
    if (pct !== null && etaBps > 0 && done < total) {
      meta.appendChild(
        el('span', {
          class: 'teta',
          text: '⏳ ' + formatEta((total - done) / etaBps) + ' ' + t('tr.remaining'),
        })
      );
    }
    meta.appendChild(el('span', { text: '⏱ ' + formatDuration(tf.durationMs) }));
    info.appendChild(meta);

    row.appendChild(info);

    const stopBtn = el('button', { class: 'tstop', text: '✕', attrs: { title: t('tr.stopTitle') } });
    stopBtn.addEventListener('click', () => stopTransfer(tf));
    row.appendChild(stopBtn);

    list.appendChild(row);
  });
}

async function stopTransfer(tf) {
  if (!confirm(t('tr.stopConfirm'))) return;
  try {
    await api('POST', '/api/transfers/' + encodeURIComponent(tf.id) + '/stop');
    refreshShares();
  } catch (e) {}
}

const HISTORY_PAGE_SIZE = 10;

function renderHistory(history) {
  state.historyData = history || [];
  renderHistoryPage();
}

function foldHistoryText(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

function filteredHistory() {
  const query = foldHistoryText(state.historyQuery).trim();
  return state.historyData.filter((hx) => {
    const direction = hx.direction === 'up' ? 'up' : 'down';
    if (state.historyDirection && direction !== state.historyDirection) return false;
    const status = hx.completed ? 'completed' : 'interrupted';
    if (state.historyStatus && status !== state.historyStatus) return false;
    if (!query) return true;
    const searchable = [
      hx.name,
      hx.ip,
      hx.ipName,
      hx.country,
      hx.countryCode,
      hx.type,
      hx.recipientName,
      direction,
      direction === 'up' ? t('hi.uploads') : t('hi.downloads'),
      hx.completed ? t('hi.completed') : t('hi.interrupted'),
    ].map(foldHistoryText).join(' ');
    return searchable.includes(query);
  });
}

function appendHistoryPageButton(tabs, page, label, title, markActive = true) {
  const button = el('button', {
    class: 'hi-tab' + (markActive && page === state.historyPage ? ' active' : ''),
    text: label,
    attrs: title ? { title } : null,
  });
  button.addEventListener('click', () => {
    state.historyPage = page;
    renderHistoryPage();
  });
  tabs.appendChild(button);
  return button;
}

function renderHistoryPage() {
  const arr = filteredHistory();
  const list = $('history-list');
  const tabs = $('history-tabs');
  list.textContent = '';
  tabs.textContent = '';

  const activeFilter = !!(state.historyQuery.trim() || state.historyDirection || state.historyStatus);
  const filterButton = $('history-filter-btn');
  if (filterButton) filterButton.classList.toggle('filter-active', activeFilter);
  const count = $('history-filter-count');
  if (count) count.textContent = t('hi.results', { shown: arr.length, total: state.historyData.length });

  if (!arr.length) {
    list.appendChild(el('div', {
      class: 'empty',
      text: state.historyData.length && activeFilter ? t('hi.noMatch') : t('hi.none'),
    }));
    return;
  }

  const pages = Math.ceil(arr.length / HISTORY_PAGE_SIZE);
  if (state.historyPage >= pages) state.historyPage = pages - 1;
  if (state.historyPage < 0) state.historyPage = 0;

  const start = state.historyPage * HISTORY_PAGE_SIZE;
  arr.slice(start, start + HISTORY_PAGE_SIZE).forEach((hx) => {
    const up = hx.direction === 'up';
    const isZip = hx.isZip || hx.type === 'zip' || hx.type === 'collection-zip';
    const row = el('div', { class: 'transfer' + (hx.completed ? '' : ' interrupted') });
    row.appendChild(el('span', { class: 'tflag', text: hx.flag || '🌐' }));

    const info = el('div', { class: 'tinfo' });
    const name = el('div', { class: 'tname' });
    name.appendChild(el('span', { class: 'ico', text: up ? '📥' : isZip ? '🗜️' : '📄' }));
    name.appendChild(el('span', { text: hx.name }));
    if (isZip) {
      name.appendChild(el('span', { class: 'tzip', text: t('tr.zip'), attrs: { title: t('tr.zipTitle') } }));
    }
    name.appendChild(
      el('span', {
        class: 'badge ' + (hx.completed ? 'ok-badge' : 'expired'),
        text: hx.completed ? t('hi.completed') : t('hi.interrupted'),
      })
    );
    info.appendChild(name);

    const meta = el('div', { class: 'tmeta' });
    meta.appendChild(ipTag(hx.ip, hx.ipName));
    if (hx.country) meta.appendChild(el('span', { text: countryText(hx.country) }));
    meta.appendChild(el('span', { text: formatBytes(hx.bytes) }));
    meta.appendChild(el('span', { class: 'tspeed', text: (up ? '↑ ' : '↓ ') + formatSpeed(hx.avgBps) }));
    meta.appendChild(el('span', { text: timeAgo(hx.endedAt) }));
    info.appendChild(meta);

    row.appendChild(info);
    list.appendChild(row);
  });

  if (pages > 1) {
    const previous = appendHistoryPageButton(tabs, Math.max(0, state.historyPage - 1), '‹', t('hi.previous'), false);
    previous.disabled = state.historyPage === 0;

    const visiblePages = new Set([0, pages - 1]);
    for (let i = state.historyPage - 2; i <= state.historyPage + 2; i++) {
      if (i >= 0 && i < pages) visiblePages.add(i);
    }
    let prior = -1;
    [...visiblePages].sort((a, b) => a - b).forEach((page) => {
      if (prior >= 0 && page - prior > 1) tabs.appendChild(el('span', { class: 'hi-ellipsis', text: '…' }));
      appendHistoryPageButton(tabs, page, String(page + 1));
      prior = page;
    });

    const next = appendHistoryPageButton(tabs, Math.min(pages - 1, state.historyPage + 1), '›', t('hi.next'), false);
    next.disabled = state.historyPage === pages - 1;
  }
}

// A usage progress bar for a link's most relevant quota (downloads, unique
// visitors, or a reception/collab byte-or-file quota). Returns null when the link
// has no cap to visualize.
function quotaBar(s) {
  let used = 0, max = 0, label = '';
  if (s.type === 'inbox' && s.inbox) {
    if (s.inbox.maxTotalBytes) { used = s.inbox.bytesReceived || 0; max = s.inbox.maxTotalBytes; label = formatBytes(used) + ' / ' + formatBytes(max); }
    else if (s.inbox.maxFiles) { used = s.downloads || 0; max = s.inbox.maxFiles; label = used + ' / ' + max + ' 📄'; }
  } else if (s.type === 'collab' && s.collab && s.collab.maxTotalBytes) {
    used = s.collab.bytesReceived || 0; max = s.collab.maxTotalBytes; label = formatBytes(used) + ' / ' + formatBytes(max);
  } else if (s.maxDownloads) {
    used = s.downloads || 0; max = s.maxDownloads; label = used + ' / ' + max + ' ⬇';
  } else if (s.maxVisitors) {
    used = s.uniqueVisitors || 0; max = s.maxVisitors; label = used + ' / ' + max + ' 👤';
  }
  if (!max) return null;
  const pct = Math.max(0, Math.min(100, Math.round((used / max) * 100)));
  const wrap = el('div', { class: 'quota' });
  const bar = el('div', { class: 'quota-bar' + (pct >= 100 ? ' full' : pct >= 80 ? ' high' : '') });
  const fill = el('i'); fill.style.width = pct + '%';
  bar.appendChild(fill);
  wrap.appendChild(bar);
  wrap.appendChild(el('span', { class: 'quota-label', text: label + ' · ' + pct + '%' }));
  return wrap;
}

function renderShares(shares) {
  state.allShares = shares; // keep for client-side filtering (feature 9)
  // Photos tab — render direct-image links in their own gallery and keep them out
  // of the main links list.
  // Galleries render first so their member lists are available to the image filters.
  renderAlbums(shares.filter((s) => s.type === 'album')); // feature 18: image galleries
  renderPhotos(shares.filter((s) => s.type === 'photo'));
  shares = shares.filter((s) => s.type !== 'photo' && s.type !== 'album');
  const list = $('shares-list');
  list.textContent = '';
  $('share-count').textContent = shares.length;
  // Summary line: total links, how many are active, and the total known size.
  const sm = $('shares-summary');
  if (sm) {
    let bytes = 0;
    shares.forEach((s) => {
      if (s.items && s.items.length) s.items.forEach((it) => { if (typeof it.size === 'number') bytes += it.size; });
      else if (typeof s.size === 'number') bytes += s.size;
    });
    const active = shares.filter((s) => s.active).length;
    sm.textContent = t('sh.summary', { n: shares.length, active, size: formatBytes(bytes) });
    sm.classList.toggle('hidden', !shares.length);
  }
  // Toolbar (filter + bulk actions) is shown only when there are links.
  const toolbar = $('shares-toolbar');
  if (toolbar) toolbar.classList.toggle('hidden', shares.length === 0);
  // Drop selections pointing at links that no longer exist.
  if (state.selShares) {
    const ids = new Set(shares.map((s) => s.id));
    for (const id of [...state.selShares]) if (!ids.has(id)) state.selShares.delete(id);
  }

  if (!shares.length) {
    list.appendChild(el('div', { class: 'empty', text: t('sh.none') }));
    updateBulkBar();
    return;
  }

  // Client-side filter (name/tag + type + status) and sort — all in the browser,
  // reapplied on every periodic poll so counters/quotas stay live.
  const q = (state.shareFilter || '').trim().toLowerCase();
  const typeF = state.shareType || '';
  const statusF = state.shareStatus || '';
  let shown = shares.filter((s) => {
    if (q && !((s.name || '').toLowerCase().includes(q)
        || (Array.isArray(s.tags) && s.tags.some((tg) => tg.toLowerCase().includes(q))))) return false;
    if (typeF && s.type !== typeF) return false;
    if (statusF === 'active' && !s.active) return false;
    if (statusF === 'inactive' && s.active) return false;
    return true;
  });
  const sort = state.shareSort || 'new';
  const cmp = {
    new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    old: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || '')),
    downloads: (a, b) => (b.downloads || 0) - (a.downloads || 0),
    expiry: (a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity),
  }[sort];
  if (cmp) shown = shown.slice().sort(cmp);
  if (!shown.length) {
    list.appendChild(el('div', { class: 'empty', text: t('sh.noneFilter') }));
    updateBulkBar();
    return;
  }

  shown.forEach((s) => {
    const isInbox = s.type === 'inbox';
    const isCollab = s.type === 'collab';
    const noSize = isInbox || isCollab; // types without a single "size"
    const isPendingDelete = pendingShareDeletionFor(s.id);
    const card = el('div', { class: 'share' + (s.active ? '' : ' inactive') + (isPendingDelete ? ' pending-delete' : '') });

    const top = el('div', { class: 'share-top' });
    const sel = el('input', { class: 'sh-sel', attrs: { type: 'checkbox', 'aria-label': 'select' } });
    sel.checked = state.selShares && state.selShares.has(s.id);
    sel.addEventListener('change', () => {
      if (!state.selShares) state.selShares = new Set();
      if (sel.checked) state.selShares.add(s.id); else state.selShares.delete(s.id);
      updateBulkBar();
    });
    top.appendChild(sel);
    top.appendChild(el('span', { class: 'ico', text: isInbox ? '📥' : isCollab ? '🔁' : s.type === 'folder' ? '📁' : '📄' }));
    const nameEl = el('span', { class: 'name', text: s.name, attrs: { title: t('sh.renameTip') } });
    nameEl.addEventListener('dblclick', () => startInlineRename(s, nameEl));
    top.appendChild(nameEl);
    top.appendChild(
      el('span', {
        class: 'badge ' + s.type,
        text: isInbox ? t('sh.inbox') : isCollab ? t('sh.collab') : s.type === 'folder' ? t('sh.folder') : t('sh.file'),
      })
    );
    if (s.hasPassword) top.appendChild(el('span', { class: 'badge locked', text: t('sh.protected') }));
    if (isCollab && s.collab && s.collab.allowDelete) top.appendChild(el('span', { class: 'badge burn', text: t('sh.canDelete') }));
    // Only meaningful where a .zip is actually offered (folders or multi-file collections).
    if (!noSize && s.allowZip === false && (s.type === 'folder' || s.itemCount > 1)) {
      top.appendChild(el('span', { class: 'badge zipoff', text: t('sh.zipOff') }));
    }
    if (!isInbox && s.burnAfterDownload) top.appendChild(el('span', { class: 'badge burn', text: t('sh.oneTime') }));
    if (s.burnedAt) top.appendChild(el('span', { class: 'badge expired', text: t('sh.burned') }));
    if (s.disabled) top.appendChild(el('span', { class: 'badge paused', text: t('sh.paused') }));
    else if (s.scheduled) top.appendChild(el('span', { class: 'badge scheduled', text: t('sh.scheduled') }));
    else if (!s.active) top.appendChild(el('span', { class: 'badge expired', text: t('sh.inactive') }));
    // Owner chip (feature: per-account ownership) — shown to owner/admin only.
    const viewerRole = state.settings && state.settings.role;
    if (s.ownerName && (viewerRole === 'owner' || viewerRole === 'admin')) {
      top.appendChild(el('span', { class: 'share-owner', text: '👤 ' + s.ownerName }));
    }
    card.appendChild(top);

    const meta = el('div', { class: 'share-meta' });
    if (!noSize) {
      meta.appendChild(
        el('span', {
          text: t('sh.sizeLabel') + ' ' + (s.type === 'file' ? formatBytes(s.size) : t('sh.folder')),
        })
      );
    }
    meta.appendChild(el('span', { text: t('sh.created') + ' ' + formatDate(s.createdAt) }));
    meta.appendChild(
      el('span', {
        text:
          (isInbox ? t('sh.received') : isCollab ? t('sh.activity') : t('sh.downloads')) +
          ' ' +
          s.downloads +
          (!noSize && s.maxDownloads ? ' / ' + s.maxDownloads : ''),
      })
    );
    if (s.itemCount > 1) meta.appendChild(el('span', { text: t('sh.files', { n: s.itemCount }) }));
    // Live views / unique-visitors counter (all link types), refreshed by the poll.
    meta.appendChild(el('span', {
      class: 'sh-views',
      text: '👁 ' + (s.views || 0) + ' · 👤 ' + (s.uniqueVisitors || 0),
      title: t('sh.viewsTip', { views: s.views || 0, visitors: s.uniqueVisitors || 0 }),
    }));
    if (!isInbox && s.maxVisitors > 0) meta.appendChild(el('span', { text: t('sh.visitors') + ' ' + (s.uniqueVisitors || 0) + ' / ' + s.maxVisitors }));
    if (!isInbox && s.rateKBps > 0) meta.appendChild(el('span', { text: t('sh.speed', { v: s.rateKBps }) }));
    if (s.startsAt && s.scheduled) meta.appendChild(el('span', { text: t('sh.startsAt') + ' ' + formatDate(s.startsAt) }));
    if (s.expiresAt) meta.appendChild(el('span', { text: t('sh.expires') + ' ' + formatDate(s.expiresAt) }));
    card.appendChild(meta);

    const qb = quotaBar(s); // progress bar for downloads / visitors / reception quota
    if (qb) card.appendChild(qb);

    // Collaboration link: quotas, filters & deletion policy summary.
    if (isCollab && s.collab) {
      const cb = s.collab;
      const parts = [t(cb.allowDelete ? 'sh.deleteOn' : 'sh.deleteOff')];
      if (cb.maxFileBytes) parts.push(t('sh.limPerFile', { v: formatBytes(cb.maxFileBytes) }));
      if (cb.maxTotalBytes) {
        parts.push(t('sh.limQuota', { v: formatBytes(cb.maxTotalBytes) }) +
          ' (' + t('sh.usage', { v: formatBytes(cb.bytesReceived) }) + ')');
      }
      if (cb.allowExt && cb.allowExt.length) parts.push(t('sh.limAllow', { v: cb.allowExt.join(', ') }));
      if (cb.blockExt && cb.blockExt.length) parts.push(t('sh.limBlock', { v: cb.blockExt.join(', ') }));
      const line = el('div', { class: 'share-sub' });
      line.appendChild(el('span', { class: 'sl-label', text: t('sh.filtersLabel') }));
      line.appendChild(el('span', { text: parts.join(' · ') }));
      card.appendChild(line);
      if (cb.note) {
        const nl = el('div', { class: 'share-sub' });
        nl.appendChild(el('span', { class: 'sl-label', text: t('sh.noteLabel') }));
        nl.appendChild(el('span', { text: cb.note }));
        card.appendChild(nl);
      }
    }

    // Reception link: quotas & filters summary.
    if (isInbox && s.inbox) {
      const ib = s.inbox;
      const parts = [];
      if (ib.maxFileBytes) parts.push(t('sh.limPerFile', { v: formatBytes(ib.maxFileBytes) }));
      if (ib.maxTotalBytes) {
        parts.push(
          t('sh.limQuota', { v: formatBytes(ib.maxTotalBytes) }) +
            ' (' + t('sh.usage', { v: formatBytes(ib.bytesReceived) }) + ')'
        );
      }
      if (ib.maxFiles) parts.push(t('sh.limFiles', { v: ib.maxFiles }));
      if (ib.allowExt && ib.allowExt.length) parts.push(t('sh.limAllow', { v: ib.allowExt.join(', ') }));
      if (ib.blockExt && ib.blockExt.length) parts.push(t('sh.limBlock', { v: ib.blockExt.join(', ') }));
      if (parts.length) {
        const line = el('div', { class: 'share-sub' });
        line.appendChild(el('span', { class: 'sl-label', text: t('sh.filtersLabel') }));
        line.appendChild(el('span', { text: parts.join(' · ') }));
        card.appendChild(line);
      }
      // Admin note (instructions shown to visitors on the deposit page).
      if (ib.note) {
        const line = el('div', { class: 'share-sub' });
        line.appendChild(el('span', { class: 'sl-label', text: t('sh.noteLabel') }));
        line.appendChild(el('span', { text: ib.note }));
        card.appendChild(line);
      }
      // Messages left by senders.
      if (ib.messages && ib.messages.length) {
        const box = el('div', { class: 'share-msgs' });
        const head = el('div', { class: 'msgs-head' });
        head.appendChild(el('div', { class: 'sl-label', text: t('sh.msgsLabel', { n: ib.messages.length }) }));
        const clearBtn = el('button', { class: 'btn ghost sm danger', text: t('sh.msgsClear') });
        clearBtn.addEventListener('click', () => clearInboxMessages(s));
        head.appendChild(clearBtn);
        box.appendChild(head);
        ib.messages.slice(0, 8).forEach((m) => {
          const row = el('div', { class: 'msg-row' });
          row.appendChild(el('span', { class: 'msg-flag', text: m.flag || '🌐' }));
          const bodyEl = el('div', { class: 'msg-body' });
          bodyEl.appendChild(el('div', { class: 'msg-text', text: m.text }));
          bodyEl.appendChild(el('div', {
            class: 'msg-meta',
            text: (m.file ? '📄 ' + m.file + ' · ' : '') + (m.country ? m.country + ' · ' : '') + timeAgo(m.at),
          }));
          row.appendChild(bodyEl);
          box.appendChild(row);
        });
        if (ib.messages.length > 8) {
          box.appendChild(el('div', { class: 'msg-more', text: t('sh.msgsMore', { n: ib.messages.length - 8 }) }));
        }
        card.appendChild(box);
      }
    }

    // Per-link statistics (from the persistent aggregate).
    if (s.stats && s.stats.count) {
      const st = s.stats;
      const bits = [
        t('sh.statCount', { n: st.count, v: formatBytes(st.bytes) }),
        t('sh.statOkKo', { ok: st.completed, ko: st.interrupted }),
      ];
      if (st.lastAt) bits.push(t('sh.statLast', { v: timeAgo(st.lastAt) }));
      const line = el('div', { class: 'share-sub' });
      line.appendChild(el('span', { class: 'sl-label', text: t('sh.statsLabel') }));
      line.appendChild(el('span', { text: bits.join(' · ') }));
      card.appendChild(line);
    }

    if (s.hostPath) card.appendChild(el('div', { class: 'share-path', text: s.hostPath }));
    else if ((isInbox || isCollab) && s.relDir) card.appendChild(el('div', { class: 'share-path', text: '📁 ' + s.relDir }));

    if (s.url) card.appendChild(linkRow(t('sh.link'), s.url));

    // Show the file list for any collection (a genuine multi-file bundle), and keep
    // showing it even once it's down to a single remaining file — otherwise deleting
    // one file makes the whole list vanish, which looks like everything was removed.
    // Legacy multi-item shares (created before the `collection` flag) still qualify.
    const isCollection = s.collection || (s.items && s.items.length > 1);
    if (isCollection && s.items && s.items.length) {
      const many = s.items.length > 1;
      const il = el('div', { class: 'item-list' + (many ? ' reorderable' : '') });
      let dragEl = null;
      s.items.forEach((it, idx) => {
        const row = el('div', { class: 'item-row' });
        row.dataset.idx = idx;
        // Drag & drop reorder (feature 16) — only when several items exist.
        if (many) {
          row.setAttribute('draggable', 'true');
          row.appendChild(el('span', { class: 'item-grip', text: '⠿', attrs: { title: t('sh.reorder') } }));
          row.addEventListener('dragstart', (e) => {
            dragEl = row; row.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
          });
          row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragEl = null; commitItemOrder(s, il); });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!dragEl || dragEl === row) return;
            const after = dragAfterElement(il, e.clientY);
            if (after == null) il.appendChild(dragEl); else il.insertBefore(dragEl, after);
          });
        }
        row.appendChild(el('span', { class: 'ico', text: it.type === 'folder' ? '📁' : '📄' }));
        row.appendChild(el('span', { class: 'iname', text: it.name }));
        // The last remaining file can't be removed individually (that would empty the
        // share) — use "Revoke" for that. So only offer ✕ while several files remain.
        if (many) {
          const rm = el('button', { class: 'item-x', text: '✕', attrs: { title: t('sh.removeItem') } });
          rm.addEventListener('click', () => removeItem(s, idx));
          row.appendChild(rm);
        }
        il.appendChild(row);
      });
      card.appendChild(il);
    }

    const rcp = recipientsSection(s);
    if (rcp) card.appendChild(rcp);

    if (s.pending && s.pending.length) card.appendChild(pendingSection(s));

    card.appendChild(tagsSection(s));

    // Private admin note (feature 2) — click to edit; never shown to visitors.
    if (s.adminNote) {
      const an = el('div', { class: 'share-adminnote', text: '📝 ' + s.adminNote, attrs: { title: t('sh.noteEditTip') } });
      an.addEventListener('click', () => openAdminNoteEditor(s, card));
      card.appendChild(an);
    }

    const actions = el('div', { class: 'share-actions' });
    actions.appendChild(
      el('a', {
        class: 'btn ghost sm',
        text: t('sh.open'),
        attrs: { href: s.path, target: '_blank', rel: 'noopener' },
      })
    );
    if (s.url) {
      const qrBtn = el('button', { class: 'btn ghost sm', text: t('sh.qr'), attrs: { title: t('sh.qrTitle') } });
      qrBtn.addEventListener('click', () => openQr(s));
      actions.appendChild(qrBtn);
    }
    if (s.type === 'file') {
      const addBtn = el('button', { class: 'btn ghost sm', text: t('sh.addFiles') });
      addBtn.addEventListener('click', () => openPickerForAdd(s));
      actions.appendChild(addBtn);
    }
    // The edit modal targets download shares (file/folder); inbox/collab links are
    // configured at creation time and edited by revoking + recreating.
    if (!isInbox && !isCollab) {
      const editBtn = el('button', { class: 'btn ghost sm', text: t('sh.edit') });
      editBtn.addEventListener('click', () => openEditModal(s));
      actions.appendChild(editBtn);
    }
    // Duplicate the configuration into a fresh share. Runtime counters, visitors,
    // received files and per-recipient links are intentionally not copied.
    if (!s.encrypted && s.type !== 'secret') {
      const cloneBtn = el('button', { class: 'btn ghost sm clone-btn', text: t('sh.clone'), attrs: { title: t('sh.cloneTitle') } });
      cloneBtn.addEventListener('click', () => cloneShare(s, cloneBtn));
      actions.appendChild(cloneBtn);
    }
    // E-mail this link — only when SMTP can actually send.
    if (s.url && state.settings && state.settings.emailSendable) {
      const mailBtn = el('button', { class: 'btn ghost sm', text: t('sh.email'), attrs: { title: t('sh.emailTitle') } });
      mailBtn.addEventListener('click', () => emailShare(s));
      actions.appendChild(mailBtn);
    }
    const statsBtn = el('button', { class: 'btn ghost sm stats-btn', text: t('stats.button'), attrs: { title: t('stats.title') } });
    statsBtn.addEventListener('click', () => openDetailedStats(s));
    actions.appendChild(statsBtn);
    // Access log (feature 14): who / when / from where, from the transfer journal.
    const logBtn = el('button', { class: 'btn ghost sm', text: t('sh.log'), attrs: { title: t('sh.logTitle') } });
    logBtn.addEventListener('click', () => openAccessLog(s));
    actions.appendChild(logBtn);
    // Private admin note (feature 2).
    const noteBtn = el('button', { class: 'btn ghost sm', text: t('sh.noteBtn'), attrs: { title: t('sh.noteTitle') } });
    noteBtn.addEventListener('click', () => openAdminNoteEditor(s, card));
    actions.appendChild(noteBtn);
    // Pause / resume (feature 3): temporarily deactivate without deleting.
    const pauseBtn = el('button', { class: 'btn ghost sm', text: s.disabled ? t('sh.resume') : t('sh.pause'), attrs: { title: s.disabled ? t('sh.resumeTitle') : t('sh.pauseTitle') } });
    pauseBtn.addEventListener('click', () => togglePause(s));
    actions.appendChild(pauseBtn);
    const revokeBtn = el('button', { class: 'btn danger sm', text: t('sh.revoke') });
    revokeBtn.addEventListener('click', () => revokeShare(s));
    actions.appendChild(revokeBtn);
    card.appendChild(actions);

    if (isPendingDelete) card.appendChild(pendingShareDeletionBar(s));

    list.appendChild(card);
  });
  updateBulkBar();
}

// --- Feature 8: moderation queue (files awaiting approval) ---
function pendingSection(s) {
  const box = el('div', { class: 'share-msgs pending-box' });
  const head = el('div', { class: 'msgs-head' });
  head.appendChild(el('div', { class: 'sl-label', text: t('mod.pending', { n: s.pending.length }) }));
  box.appendChild(head);
  s.pending.slice(0, 20).forEach((p) => {
    const row = el('div', { class: 'msg-row pending-row' });
    const body = el('div', { class: 'msg-body' });
    body.appendChild(el('div', { class: 'msg-text', text: '📄 ' + p.name + ' · ' + formatBytes(p.size) }));
    body.appendChild(el('div', { class: 'msg-meta', text: (p.ip ? p.ip + ' · ' : '') + timeAgo(p.at) }));
    row.appendChild(body);
    const ok = el('button', { class: 'btn ghost xs', text: t('mod.approve') });
    ok.addEventListener('click', () => moderate(p.id, 'approve'));
    const no = el('button', { class: 'btn danger xs', text: t('mod.reject') });
    no.addEventListener('click', () => moderate(p.id, 'reject'));
    row.appendChild(ok); row.appendChild(no);
    box.appendChild(row);
  });
  return box;
}
async function moderate(id, action) {
  if (action === 'reject' && !confirm(t('mod.rejectConfirm'))) return;
  try {
    await api('POST', '/api/pending/' + encodeURIComponent(id) + '/' + action, {});
    toast(t(action === 'approve' ? 'mod.approved' : 'mod.rejected'), 'ok');
    refreshShares();
  } catch (e) { toast(t('mod.fail'), 'err'); }
}

// --- Feature 9: tags + bulk actions ---
function tagsSection(s) {
  const box = el('div', { class: 'tags-row' });
  (Array.isArray(s.tags) ? s.tags : []).forEach((tg) => {
    const chip = el('span', { class: 'tag-chip', text: tg });
    const x = el('button', { class: 'tag-x', text: '✕', attrs: { title: t('sh.tagRemove') } });
    x.addEventListener('click', () => setShareTags(s, s.tags.filter((v) => v !== tg)));
    chip.appendChild(x);
    box.appendChild(chip);
  });
  const add = el('button', { class: 'tag-add', text: '＋ ' + t('sh.tagAdd') });
  add.addEventListener('click', () => {
    const v = prompt(t('sh.tagPrompt'));
    if (v && v.trim()) setShareTags(s, [...(s.tags || []), v.trim()]);
  });
  box.appendChild(add);
  return box;
}
async function setShareTags(s, tags) {
  try {
    await api('PATCH', '/api/shares/' + encodeURIComponent(s.id), { tags });
    refreshShares();
  } catch (e) { toast(t('sh.tagFail'), 'err'); }
}
function updateBulkBar() {
  const bulk = $('shares-bulk');
  if (!bulk) return;
  const n = state.selShares ? state.selShares.size : 0;
  bulk.classList.toggle('hidden', n === 0);
  const c = $('bulk-count');
  if (c) c.textContent = t('sh.bulkCount', { n });
}
async function bulkAction(action, extra) {
  const ids = state.selShares ? [...state.selShares] : [];
  if (!ids.length) return;
  try {
    // A second deletion closes the recovery window of the previous one.
    if (action === 'revoke' && state.pendingShareDeletion) {
      await commitPendingShareDeletion(state.pendingShareDeletion.id);
    }
    const r = await api('POST', '/api/shares/bulk', Object.assign({ ids, action }, extra || {}));
    toast(t('sh.bulkDone', { n: (r && r.count) || 0 }), 'ok');
    state.selShares = new Set();
    refreshShares();
  } catch (e) { toast(t('sh.bulkFail'), 'err'); }
}
if ($('shares-filter')) $('shares-filter').addEventListener('input', (e) => {
  state.shareFilter = e.target.value;
  updateUiPrefs({ shareFilter: state.shareFilter });
  if (state.allShares) renderShares(state.allShares);
});
[['shares-type', 'shareType'], ['shares-status', 'shareStatus'], ['shares-sort', 'shareSort']].forEach(([id, key]) => {
  const elx = $(id);
  if (elx) elx.addEventListener('change', () => {
    state[key] = elx.value;
    updateUiPrefs({ [key]: state[key] });
    if (state.allShares) renderShares(state.allShares);
  });
});
[['shares-view-list', 'list'], ['shares-view-grid', 'grid']].forEach(([id, mode]) => {
  if ($(id)) $(id).addEventListener('click', () => setShareView(mode));
});

// --- Feature 18: full-text content search ---
if ($('search-toggle-btn')) $('search-toggle-btn').addEventListener('click', () => {
  const p = $('search-panel');
  const nowHidden = p.classList.toggle('hidden');
  if (!nowHidden) $('search-input').focus();
});
async function runContentSearch() {
  const q = $('search-input').value.trim();
  const out = $('search-results'), st = $('search-status');
  out.textContent = '';
  if (q.length < 2) { st.textContent = t('search.tooShort'); return; }
  st.textContent = t('search.searching');
  try {
    const r = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    renderSearchResults(r);
  } catch (e) {
    st.textContent = (e.data && e.data.error === 'query-too-short') ? t('search.tooShort') : t('search.fail');
  }
}
function renderSearchResults(r) {
  const out = $('search-results'), st = $('search-status');
  out.textContent = '';
  const list = (r && r.results) || [];
  st.textContent = t('search.count', { n: list.length, scanned: (r && r.scanned) || 0 }) + (r && r.truncated ? ' · ' + t('search.truncated') : '');
  if (!list.length) { out.appendChild(el('div', { class: 'empty', text: t('search.none') })); return; }
  const prefix = { inbox: '/u/', collab: '/c/' };
  list.forEach((m) => {
    const row = el('div', { class: 'search-hit' });
    const head = el('div', { class: 'sh-hit-head' });
    head.appendChild(el('span', { class: 'sh-hit-share', text: m.shareName }));
    head.appendChild(el('span', { class: 'sh-hit-file', text: m.file + ' :' + m.line }));
    if (m.matches > 1) head.appendChild(el('span', { class: 'badge', text: '×' + m.matches }));
    const link = (prefix[m.type] || '/s/') + m.token;
    head.appendChild(el('a', { class: 'btn ghost xs sh-hit-open', text: t('sh.open'), attrs: { href: link, target: '_blank', rel: 'noopener' } }));
    row.appendChild(head);
    row.appendChild(el('div', { class: 'sh-hit-snip', text: m.snippet }));
    out.appendChild(row);
  });
}
if ($('search-run')) $('search-run').addEventListener('click', runContentSearch);
if ($('search-input')) $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runContentSearch(); } });

// Feature 8 — export the links list (state + counters) as CSV / JSON.
if ($('links-export-csv')) $('links-export-csv').addEventListener('click', () => window.open('/api/shares/list-export?format=csv', '_blank'));
if ($('links-export-json')) $('links-export-json').addEventListener('click', () => window.open('/api/shares/list-export?format=json', '_blank'));

// --- Keyboard shortcuts (feature 8) ---
function anyOverlayOpen() { return !!document.querySelector('.overlay:not(.hidden)'); }
function closeKeysHelp() { const o = $('keys-overlay'); if (o) o.classList.add('hidden'); }
function toggleKeysHelp() { const o = $('keys-overlay'); if (o) o.classList.toggle('hidden'); }
if ($('keys-close')) $('keys-close').addEventListener('click', closeKeysHelp);
if ($('keys-overlay')) $('keys-overlay').addEventListener('click', (e) => { if (e.target === $('keys-overlay')) closeKeysHelp(); });
if ($('log-close')) $('log-close').addEventListener('click', closeAccessLog);
if ($('log-overlay')) $('log-overlay').addEventListener('click', (e) => { if (e.target === $('log-overlay')) closeAccessLog(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('log-overlay') && !$('log-overlay').classList.contains('hidden')) { closeAccessLog(); return; }
  if (e.key === 'Escape' && $('keys-overlay') && !$('keys-overlay').classList.contains('hidden')) { closeKeysHelp(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser/OS combos alone
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return; // typing
  if (anyOverlayOpen()) return; // a dialog is open — don't trigger actions
  const click = (id) => { const b = $(id); if (b) { e.preventDefault(); b.click(); } };
  if (e.key === '/') { const f = $('shares-filter'); if (f) { e.preventDefault(); f.focus(); } }
  else if (e.key === '?') { e.preventDefault(); toggleKeysHelp(); }
  else if (e.key === 'n' || e.key === 'N') click('new-share-btn');
  else if (e.key === 'r' || e.key === 'R') click('new-inbox-btn');
  else if (e.key === 'c' || e.key === 'C') click('new-collab-btn');
});
if ($('bulk-revoke')) $('bulk-revoke').addEventListener('click', () => {
  const n = state.selShares ? state.selShares.size : 0;
  if (n && confirm(t('sh.bulkRevokeConfirm', { n }))) bulkAction('revoke');
});
if ($('bulk-extend')) $('bulk-extend').addEventListener('click', () => {
  const days = prompt(t('sh.bulkExtendPrompt'), '7');
  if (days === null) return;
  const d = parseInt(days, 10);
  bulkAction('extend', { expiresInSeconds: Number.isFinite(d) && d > 0 ? d * 86400 : 0 });
});
if ($('bulk-tag')) $('bulk-tag').addEventListener('click', () => {
  const tag = prompt(t('sh.bulkTagPrompt'));
  if (tag && tag.trim()) bulkAction('tag-add', { tag: tag.trim() });
});

function linkRow(label, url) {
  const row = el('div', { class: 'link-row' });
  row.appendChild(el('span', { class: 'link-label', text: label }));
  row.appendChild(el('div', { class: 'link-box', text: url }));
  const copyBtn = el('button', { class: 'btn ghost sm', text: t('sh.copy') });
  copyBtn.addEventListener('click', () => copy(url));
  row.appendChild(copyBtn);
  return row;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('sh.copied'), 'ok');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast(t('sh.copied'), 'ok');
    } catch (_) {
      toast(t('sh.copyFail'), 'err');
    }
    document.body.removeChild(ta);
  }
}

function pendingShareDeletionFor(id) {
  return !!(state.pendingShareDeletion && state.pendingShareDeletion.id === id);
}

function pendingShareDeletionBar(s) {
  const bar = el('div', { class: 'share-undo', attrs: { role: 'status' } });
  bar.appendChild(el('span', { class: 'share-undo-message', text: t('sh.revokePending') }));
  const undo = el('button', { class: 'btn sm', text: t('sh.undoRevoke') });
  undo.addEventListener('click', () => undoPendingShareDeletion(s.id));
  bar.appendChild(undo);
  return bar;
}

function rerenderShareCollections() {
  state.lastSharesJson = '';
  state.lastPhotosSig = '';
  if (state.allShares) renderShares(state.allShares);
}

function beginPendingShareDeletion(s) {
  const pending = {
    id: s.id,
    timer: null,
    committing: false,
    promise: null,
  };
  state.pendingShareDeletion = pending;
  if (state.selShares) state.selShares.delete(s.id);
  pending.timer = setTimeout(() => commitPendingShareDeletion(pending.id), SHARE_DELETE_UNDO_MS);
  rerenderShareCollections();
  toast(t('sh.revokePending'), 'warn');
}

function undoPendingShareDeletion(id) {
  const pending = state.pendingShareDeletion;
  if (!pending || pending.id !== id || pending.committing) return;
  clearTimeout(pending.timer);
  state.pendingShareDeletion = null;
  rerenderShareCollections();
  toast(t('sh.recovered'), 'ok');
}

async function commitPendingShareDeletion(id) {
  const pending = state.pendingShareDeletion;
  if (!pending || pending.id !== id) return true;
  if (pending.promise) return pending.promise;
  clearTimeout(pending.timer);
  pending.committing = true;
  pending.promise = (async () => {
    try {
      await api('DELETE', '/api/shares/' + encodeURIComponent(id));
      if (state.pendingShareDeletion === pending) state.pendingShareDeletion = null;
      state.allShares = (state.allShares || []).filter((share) => share.id !== id);
      rerenderShareCollections();
      loadPhotoHistory();
      toast(t('sh.revoked'), 'ok');
      return true;
    } catch (e) {
      if (state.pendingShareDeletion === pending) state.pendingShareDeletion = null;
      rerenderShareCollections();
      toast(t('sh.revokeFail'), 'err');
      return false;
    }
  })();
  return pending.promise;
}

async function revokeShare(s) {
  if (pendingShareDeletionFor(s.id)) return;
  if (!confirm(t('sh.revokeConfirm', { name: s.name }))) return;
  // Only one share can be recoverable at once. Starting another deletion makes
  // the previous one permanent before opening a fresh five-second window.
  if (state.pendingShareDeletion) {
    await commitPendingShareDeletion(state.pendingShareDeletion.id);
  }
  beginPendingShareDeletion(s);
}

// Duplicate a share's configuration into a fresh share. The server generates a
// new id/token, resets runtime data and safely copies managed image files.
async function cloneShare(s, button) {
  const originalName = ((s && s.name) || 'Share');
  let suggested = originalName + ' ' + t('sh.cloneSuffix');
  if (s && s.type === 'photo') {
    const match = /^(.*?)(\.(?:jpe?g|png|gif|webp|bmp|avif))$/i.exec(originalName);
    if (match) suggested = match[1] + ' ' + t('sh.cloneSuffix') + match[2];
  }
  const entered = prompt(t('sh.clonePrompt'), suggested);
  if (entered == null) return;

  const name = entered.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  if (!name) {
    toast(t('sh.cloneInvalidName'), 'err');
    return;
  }

  const previousText = button && button.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = t('sh.cloneBusy');
  }

  try {
    const data = await api('POST', '/api/shares/' + encodeURIComponent(s.id) + '/clone', { name });
    const duplicated = data && data.share;
    toast(t('sh.clonedAs', { name: (duplicated && duplicated.name) || name }), 'ok');
    await refreshShares();
  } catch (e) {
    const code = e.data && e.data.error;
    toast(code === 'cannot-clone' ? t('sh.cloneUnsupported')
      : code === 'image-missing' ? t('sh.cloneImageMissing')
      : code === 'invalid-name' ? t('sh.cloneInvalidName')
      : t('sh.cloneFail'), 'err');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText || t('sh.clone');
    }
  }
}

// E-mail a link to a recipient via the configured SMTP.
async function emailShare(s) {
  const to = prompt(t('sh.emailPrompt', { name: s.name }));
  if (to == null) return; // cancelled
  const addr = to.trim();
  if (!addr) return;
  try {
    await api('POST', '/api/shares/' + encodeURIComponent(s.id) + '/email', { to: addr });
    toast(t('sh.emailSent', { to: addr }), 'ok');
  } catch (e) {
    const code = e.data && e.data.error;
    toast(code === 'invalid-email' ? t('sh.emailInvalid')
      : code === 'email-not-configured' ? t('sh.emailNotConfigured')
      : t('sh.emailFail'), 'err');
  }
}

// Feature 11 — inline rename: turn the card's name into an input on double-click.
function startInlineRename(s, nameEl) {
  if (nameEl.querySelector('input')) return;
  const cur = s.name || '';
  const input = el('input', { class: 'name-edit', attrs: { type: 'text', maxlength: '200' } });
  input.value = cur;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus(); input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (!save || !v || v === cur) { if (state.allShares) renderShares(state.allShares); return; }
    try { await api('PATCH', '/api/shares/' + encodeURIComponent(s.id), { name: v }); toast(t('sh.renamed'), 'ok'); refreshShares(); }
    catch (e) { toast(t('sh.renameFail'), 'err'); refreshShares(); }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

// Detailed statistics modal shared by standard links, albums and direct images.
function statsMetric(icon, value, label, detail) {
  const card = el('div', { class: 'stats-metric' });
  card.appendChild(el('span', { class: 'stats-metric-icon', text: icon }));
  const body = el('div', { class: 'stats-metric-body' });
  body.appendChild(el('strong', { text: value == null || value === '' ? '—' : String(value) }));
  body.appendChild(el('span', { text: label }));
  if (detail) body.appendChild(el('small', { text: detail }));
  card.appendChild(body);
  return card;
}

function statsSection(title) {
  const section = el('section', { class: 'stats-section' });
  section.appendChild(el('h4', { text: title }));
  return section;
}

function statsDefinitionGrid(rows) {
  const grid = el('div', { class: 'stats-definition-grid' });
  rows.filter((row) => row && row[1] !== null && row[1] !== undefined && row[1] !== '').forEach(([label, value, mono]) => {
    const item = el('div', { class: 'stats-definition' });
    item.appendChild(el('span', { text: label }));
    item.appendChild(el('strong', { class: mono ? 'stats-mono' : '', text: String(value) }));
    grid.appendChild(item);
  });
  return grid;
}

function statsBreakdown(rows, valueFormatter) {
  const box = el('div', { class: 'stats-breakdown' });
  if (!rows || !rows.length) {
    box.appendChild(el('div', { class: 'empty sm', text: t('stats.none') }));
    return box;
  }
  const max = Math.max(1, ...rows.map((row) => Number(row.count) || 0));
  rows.forEach((row) => {
    const line = el('div', { class: 'stats-breakdown-row' });
    const label = el('span', { class: 'stats-breakdown-label', text: (row.flag ? row.flag + ' ' : '') + (row.name || row.label || t('stats.unknown')) });
    const bar = el('span', { class: 'stats-breakdown-bar' });
    const fill = el('i');
    fill.style.width = Math.max(4, Math.round(((Number(row.count) || 0) / max) * 100)) + '%';
    bar.appendChild(fill);
    const value = valueFormatter ? valueFormatter(row) : String(row.count || 0);
    line.append(label, bar, el('strong', { text: value }));
    box.appendChild(line);
  });
  return box;
}

function statsTimeline(points) {
  const chart = el('div', { class: 'stats-timeline' });
  const max = Math.max(1, ...(points || []).map((p) => Number(p.bytes) || Number(p.count) || 0));
  (points || []).forEach((point) => {
    const cell = el('div', { class: 'stats-timeline-cell', attrs: { title: point.day + ' · ' + (point.count || 0) + ' · ' + formatBytes(point.bytes || 0) } });
    const bar = el('i');
    const raw = Number(point.bytes) || Number(point.count) || 0;
    bar.style.height = (raw ? Math.max(6, Math.round((raw / max) * 100)) : 2) + '%';
    cell.appendChild(bar);
    cell.appendChild(el('span', { text: String(point.day || '').slice(5) }));
    chart.appendChild(cell);
  });
  return chart;
}

function statsStatusLabel(status) {
  const key = 'stats.' + String(status || 'inactive');
  const label = t(key);
  return label === key ? String(status || t('stats.unknown')) : label;
}

function statsTypeLabel(type) {
  const keys = { file: 'sh.file', folder: 'sh.folder', inbox: 'sh.inbox', collab: 'sh.collab', photo: 'photo.title', album: 'album.title' };
  const key = keys[type];
  return key ? t(key) : (type || t('stats.unknown'));
}

function renderDetailedStats(data) {
  const body = $('stats-body');
  body.textContent = '';
  if (!data || !data.share) {
    body.appendChild(el('div', { class: 'empty', text: t('stats.none') }));
    return;
  }
  const sh = data.share;
  const ag = data.aggregate || {};
  const image = data.image;

  const overview = statsSection(t('stats.overview'));
  const metrics = el('div', { class: 'stats-metrics' });
  metrics.appendChild(statsMetric('🔄', (ag.count || 0).toLocaleString(), t('stats.transfers'), (ag.completed || 0) + ' / ' + (ag.interrupted || 0)));
  metrics.appendChild(statsMetric('💾', formatBytes(ag.bytes || 0), t('stats.volume'), t('stats.averageSize') + ': ' + formatBytes(ag.averageBytes || 0)));
  metrics.appendChild(statsMetric('✅', (ag.successRate || 0) + '%', t('stats.success'), t('stats.completed') + ': ' + (ag.completed || 0)));
  metrics.appendChild(statsMetric('⚡', fmtBps(ag.averageBps || 0), t('stats.speed')));
  metrics.appendChild(statsMetric('👁', ((image && image.totalViews) || sh.views || 0).toLocaleString(), t('stats.views')));
  metrics.appendChild(statsMetric('👤', ((image && image.totalVisitors) || sh.uniqueVisitors || 0).toLocaleString(), t('stats.visitors')));
  if (image) metrics.appendChild(statsMetric('🗄', formatBytes(image.totalStorageBytes || sh.logicalBytes || 0), t('stats.storage')));
  else metrics.appendChild(statsMetric('⬇', (sh.downloads || 0).toLocaleString(), t('stats.downloads')));
  overview.appendChild(metrics);
  body.appendChild(overview);

  const details = statsSection(t('stats.details'));
  details.appendChild(statsDefinitionGrid([
    [t('stats.status'), statsStatusLabel(sh.status)],
    [t('stats.type'), statsTypeLabel(sh.type)],
    [t('stats.owner'), sh.ownerName || '—'],
    [t('stats.created'), sh.createdAt ? formatDate(sh.createdAt) : '—'],
    [t('stats.expiry'), sh.expiresAt ? formatDate(sh.expiresAt) : '—'],
    [t('stats.items'), (sh.itemCount || 0).toLocaleString()],
    [t('stats.storage'), formatBytes((image && image.totalStorageBytes) || sh.logicalBytes || 0)],
    [t('stats.lastActivity'), ag.lastAt ? formatDate(ag.lastAt) : '—'],
    [t('stats.firstActivity'), ag.firstAt ? formatDate(ag.firstAt) : '—'],
    [t('stats.tags'), Array.isArray(sh.tags) && sh.tags.length ? sh.tags.join(', ') : '—'],
    [t('stats.path'), sh.path || null, true],
    [t('stats.url'), sh.url || null, true],
  ]));
  body.appendChild(details);

  if (data.quota && data.quota.length) {
    const quotaSection = statsSection(t('stats.quota'));
    const quotaBox = el('div', { class: 'stats-quota-list' });
    data.quota.forEach((q) => {
      const pct = q.max ? Math.max(0, Math.min(100, Math.round((q.used / q.max) * 100))) : 0;
      const label = q.kind === 'bytes' ? t('stats.storage') : q.kind === 'files' ? t('stats.files') : q.kind === 'visitors' ? t('stats.visitors') : t('stats.downloads');
      const used = q.kind === 'bytes' ? formatBytes(q.used) : Number(q.used || 0).toLocaleString();
      const max = q.kind === 'bytes' ? formatBytes(q.max) : Number(q.max || 0).toLocaleString();
      const row = el('div', { class: 'stats-quota-row' });
      row.appendChild(el('div', { class: 'stats-quota-head', text: label + ' · ' + used + ' / ' + max + ' · ' + pct + '%' }));
      const bar = el('div', { class: 'stats-quota-bar' });
      const fill = el('i'); fill.style.width = pct + '%'; bar.appendChild(fill); row.appendChild(bar);
      quotaBox.appendChild(row);
    });
    quotaSection.appendChild(quotaBox);
    body.appendChild(quotaSection);
  }

  if (image && image.variants) {
    const section = statsSection(t('stats.imageCopies'));
    const variants = el('div', { class: 'stats-image-variants' });
    ['full', 'thumb', 'micro'].forEach((kind) => {
      const v = image.variants[kind] || {};
      const card = el('div', { class: 'stats-image-variant' + (v.present ? '' : ' missing') });
      card.appendChild(el('strong', { text: t('stats.' + kind) }));
      const dim = v.w && v.h ? v.w + '×' + v.h : '—';
      card.appendChild(el('span', { text: t('stats.dimensions') + ': ' + dim }));
      card.appendChild(el('span', { text: t('stats.storage') + ': ' + formatBytes(v.size || 0) }));
      card.appendChild(el('span', { text: t('stats.views') + ': ' + (v.views || 0).toLocaleString() }));
      card.appendChild(el('span', { text: t('stats.visitors') + ': ' + (v.visitors || 0).toLocaleString() }));
      card.appendChild(el('span', { text: t('stats.lastView') + ': ' + (v.lastAt ? formatDate(v.lastAt) : '—') }));
      variants.appendChild(card);
    });
    section.appendChild(variants);
    body.appendChild(section);
  }

  if (data.live && data.live.length) {
    const section = statsSection(t('stats.live'));
    const list = el('div', { class: 'stats-events' });
    data.live.forEach((event) => {
      const row = el('div', { class: 'stats-event live' });
      row.appendChild(el('span', { class: 'stats-event-icon', text: event.direction === 'up' ? '⬆' : '⬇' }));
      const main = el('div', { class: 'stats-event-main' });
      main.appendChild(el('strong', { text: event.name || sh.name }));
      main.appendChild(el('span', { text: formatBytes(event.bytes || 0) + (event.expectedBytes ? ' / ' + formatBytes(event.expectedBytes) : '') + ' · ' + (event.ipName || event.ip || '—') }));
      row.appendChild(main);
      list.appendChild(row);
    });
    section.appendChild(list);
    body.appendChild(section);
  }

  const timeline = statsSection(t('stats.activity14'));
  timeline.appendChild(statsTimeline(data.timeline || []));
  body.appendChild(timeline);

  const split = el('div', { class: 'stats-two-columns' });
  const countries = statsSection(t('stats.countries'));
  countries.appendChild(statsBreakdown(data.countries || [], (row) => (row.count || 0).toLocaleString()));
  const clients = statsSection(t('stats.clients'));
  clients.appendChild(statsBreakdown(data.clients || [], (row) => (row.count || 0).toLocaleString()));
  split.append(countries, clients);
  body.appendChild(split);

  const recentSection = statsSection(t('stats.recent'));
  const recentList = el('div', { class: 'stats-events' });
  if (!data.recent || !data.recent.length) {
    recentList.appendChild(el('div', { class: 'empty sm', text: t('stats.noRecent') }));
  } else {
    data.recent.forEach((event) => {
      const row = el('div', { class: 'stats-event' + (event.completed ? ' ok' : ' fail') });
      row.appendChild(el('span', { class: 'stats-event-icon', text: event.completed ? (event.direction === 'up' ? '⬆' : '⬇') : '⚠' }));
      const main = el('div', { class: 'stats-event-main' });
      const client = [event.flag, event.ipName || event.ip, event.country, event.recipient ? '👤 ' + event.recipient : ''].filter(Boolean).join(' · ');
      main.appendChild(el('strong', { text: event.name || sh.name }));
      main.appendChild(el('span', { text: [formatBytes(event.bytes || 0), fmtDuration(event.durationMs || 0), fmtBps(event.avgBps || 0), client].filter(Boolean).join(' · ') }));
      if (!event.completed && event.reason) main.appendChild(el('small', { text: transferFailureLabel(event.reason) }));
      row.appendChild(main);
      row.appendChild(el('time', { text: event.at ? timeAgo(event.at) : '—' }));
      recentList.appendChild(row);
    });
  }
  recentSection.appendChild(recentList);
  body.appendChild(recentSection);

  if (image) {
    const imageRecent = statsSection(t('stats.imageRecent'));
    const list = el('div', { class: 'stats-events' });
    if (!image.recentViews || !image.recentViews.length) {
      list.appendChild(el('div', { class: 'empty sm', text: t('stats.noImageRecent') }));
    } else {
      image.recentViews.forEach((event) => {
        const row = el('div', { class: 'stats-event' });
        row.appendChild(el('span', { class: 'stats-event-icon', text: event.kind === 'full' ? '🖼' : event.kind === 'thumb' ? '▣' : '▫' }));
        const main = el('div', { class: 'stats-event-main' });
        main.appendChild(el('strong', { text: t('stats.' + event.kind) }));
        main.appendChild(el('span', { text: [event.flag, event.ip, event.country].filter(Boolean).join(' · ') || '—' }));
        row.appendChild(main);
        row.appendChild(el('time', { text: event.at ? timeAgo(event.at) : '—' }));
        list.appendChild(row);
      });
    }
    imageRecent.appendChild(list);
    body.appendChild(imageRecent);
  }
}

async function openDetailedStats(s) {
  const overlay = $('stats-overlay');
  const body = $('stats-body');
  $('stats-title').textContent = t('stats.title');
  $('stats-subtitle').textContent = s && s.name ? s.name : '';
  body.textContent = t('stats.loading');
  overlay.classList.remove('hidden');
  try {
    const data = await api('GET', '/api/shares/' + encodeURIComponent(s.id) + '/stats-detail');
    renderDetailedStats(data);
  } catch (_) {
    body.textContent = t('stats.fail');
  }
}
function closeDetailedStats() { $('stats-overlay').classList.add('hidden'); }

// Feature 14 — per-link access log modal.
async function openAccessLog(s) {
  $('log-title').textContent = s.name;
  const body = $('log-body');
  body.textContent = t('log.loading');
  $('log-overlay').classList.remove('hidden');
  try {
    const r = await api('GET', '/api/shares/' + encodeURIComponent(s.id) + '/log');
    body.textContent = '';
    const entries = (r && r.entries) || [];
    if (!entries.length) { body.appendChild(el('div', { class: 'empty', text: t('log.none') })); return; }
    entries.forEach((e) => {
      const row = el('div', { class: 'log-row' });
      row.appendChild(el('span', { class: 'log-dir', text: e.direction === 'up' ? '⬆' : '⬇' }));
      const main = el('div', { class: 'log-main' });
      main.appendChild(el('div', { class: 'log-line1',
        text: (e.flag ? e.flag + ' ' : '') + (e.ip || '—') + (e.country ? ' · ' + e.country : '') + (e.recipient ? ' · 👤 ' + e.recipient : '') }));
      main.appendChild(el('div', { class: 'log-line2 muted sm',
        text: formatBytes(e.bytes) + ' · ' + (e.completed ? t('log.ok') : t('log.ko')) + ' · ' + timeAgo(e.at) + (e.name ? ' · ' + e.name : '') }));
      row.appendChild(main);
      body.appendChild(row);
    });
  } catch (e) { body.textContent = t('log.fail'); }
}
function closeAccessLog() { $('log-overlay').classList.add('hidden'); }

if ($('stats-close')) $('stats-close').addEventListener('click', closeDetailedStats);
if ($('stats-overlay')) $('stats-overlay').addEventListener('click', (e) => { if (e.target === $('stats-overlay')) closeDetailedStats(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('stats-overlay') && !$('stats-overlay').classList.contains('hidden')) closeDetailedStats();
});

// Feature 3 — pause / resume a link (reversible deactivation, unlike revoke).
async function togglePause(s) {
  try {
    await api('PATCH', '/api/shares/' + encodeURIComponent(s.id), { disabled: !s.disabled });
    toast(t(s.disabled ? 'sh.resumed' : 'sh.paused2'), 'ok');
    refreshShares();
  } catch (e) {
    toast(t('sh.pauseFail'), 'err');
  }
}

// Feature 2 — inline editor for a link's private admin note (create or edit).
function openAdminNoteEditor(s, card) {
  if (card.querySelector('.adminnote-edit')) { card.querySelector('.adminnote-input').focus(); return; }
  const existing = card.querySelector('.share-adminnote');
  if (existing) existing.remove();
  const box = el('div', { class: 'adminnote-edit' });
  const ta = el('textarea', { class: 'adminnote-input', attrs: { rows: '2', maxlength: '1000', placeholder: t('sh.notePh2') } });
  ta.value = s.adminNote || '';
  const row = el('div', { class: 'adminnote-actions' });
  const cancel = el('button', { class: 'btn ghost sm', text: t('pk.cancel') });
  const save = el('button', { class: 'btn sm', text: t('net.save') });
  cancel.addEventListener('click', () => { if (state.allShares) renderShares(state.allShares); });
  save.addEventListener('click', async () => {
    try {
      await api('PATCH', '/api/shares/' + encodeURIComponent(s.id), { adminNote: ta.value });
      toast(t('sh.noteSaved'), 'ok');
      refreshShares();
    } catch (e) { toast(t('sh.noteFail'), 'err'); refreshShares(); }
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (state.allShares) renderShares(state.allShares); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
  });
  row.appendChild(cancel); row.appendChild(save);
  box.appendChild(ta); box.appendChild(row);
  const actionsEl = card.querySelector('.share-actions');
  if (actionsEl) card.insertBefore(box, actionsEl); else card.appendChild(box);
  ta.focus();
}

// Clear the message list of a reception link (server keeps the files on disk).
async function clearInboxMessages(s) {
  if (!confirm(t('sh.msgsClearConfirm', { name: s.name }))) return;
  try {
    await api('DELETE', '/api/shares/' + encodeURIComponent(s.id) + '/messages');
    toast(t('sh.msgsCleared'), 'ok');
    refreshShares();
  } catch (e) {
    toast(t('sh.msgsClearFail'), 'err');
  }
}

async function removeItem(s, idx) {
  try {
    await api('DELETE', '/api/shares/' + encodeURIComponent(s.id) + '/items/' + idx);
    toast(t('sh.itemRemoved'), 'ok');
    refreshShares();
  } catch (e) {
    toast(t('sh.removeItemFail', { error: (e.data && e.data.error) || e.message }), 'err');
  }
}

// Feature 16 — which item row the cursor is currently above (for drop insertion).
function dragAfterElement(container, y) {
  const rows = [...container.querySelectorAll('.item-row:not(.dragging)')];
  let closest = null, closestOffset = -Infinity;
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = row; }
  }
  return closest;
}
// Reads the current DOM order and, if it changed, persists the new item order.
async function commitItemOrder(s, il) {
  const order = [...il.querySelectorAll('.item-row')].map((r) => parseInt(r.dataset.idx, 10));
  if (order.length !== (s.items || []).length) return;
  if (order.every((v, i) => v === i)) return; // unchanged
  try {
    await api('PATCH', '/api/shares/' + encodeURIComponent(s.id) + '/items/order', { order });
    toast(t('sh.reordered'), 'ok');
    refreshShares();
  } catch (e) {
    toast(t('sh.reorderFail'), 'err');
    refreshShares(); // snap back to the server's order
  }
}

// --- QR code for a link (image generated by the server, locally) ---
function openQrFor(name, url) {
  $('qr-name').textContent = name || '';
  $('qr-url').textContent = url;
  $('qr-img').src = '/api/qr?data=' + encodeURIComponent(url);
  $('qr-overlay').classList.remove('hidden');
}
function openQr(s) { openQrFor(s.name, s.url); }
function closeQr() {
  $('qr-overlay').classList.add('hidden');
  $('qr-img').removeAttribute('src');
}
$('qr-close').addEventListener('click', closeQr);
$('qr-overlay').addEventListener('click', (e) => {
  if (e.target === $('qr-overlay')) closeQr();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('qr-overlay').classList.contains('hidden')) closeQr();
});

// --- Image lightbox (feature 11): click a card preview to view the image
// full-size, with on-screen / keyboard prev-next across the visible images. ---
const lightbox = { list: [], idx: 0 };
function openLightbox(token) {
  const arr = visiblePhotos(state.photosData || []);
  lightbox.list = arr.map((s) => ({ token: s.token, name: s.name || '', ext: (s.photo || {}).ext || 'jpg' }));
  const i = lightbox.list.findIndex((it) => it.token === token);
  if (i < 0) return;
  showLightboxAt(i);
  $('lightbox-overlay').classList.remove('hidden');
}
function showLightboxAt(i) {
  if (i < 0 || i >= lightbox.list.length) return;
  lightbox.idx = i;
  const it = lightbox.list[i];
  const full = '/i/' + it.token + '.' + it.ext; // same-origin: admin browser can always reach it
  $('lightbox-img').src = full;
  $('lightbox-img').alt = it.name;
  $('lightbox-name').textContent = it.name;
  $('lightbox-counter').textContent = (i + 1) + ' / ' + lightbox.list.length;
  $('lightbox-open').href = full;
  $('lightbox-prev').disabled = i <= 0;
  $('lightbox-next').disabled = i >= lightbox.list.length - 1;
}
function lightboxStep(d) { showLightboxAt(lightbox.idx + d); }
function closeLightbox() {
  $('lightbox-overlay').classList.add('hidden');
  $('lightbox-img').removeAttribute('src');
  lightbox.list = [];
}
if ($('lightbox-close')) $('lightbox-close').addEventListener('click', closeLightbox);
if ($('lightbox-prev')) $('lightbox-prev').addEventListener('click', () => lightboxStep(-1));
if ($('lightbox-next')) $('lightbox-next').addEventListener('click', () => lightboxStep(1));
if ($('lightbox-overlay')) $('lightbox-overlay').addEventListener('click', (e) => { if (e.target === $('lightbox-overlay')) closeLightbox(); });
document.addEventListener('keydown', (e) => {
  const ov = $('lightbox-overlay');
  if (!ov || ov.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxStep(-1);
  else if (e.key === 'ArrowRight') lightboxStep(1);
});

// ------------------------------------------------------------------
// File picker (modal) — loads nothing until it is opened
// ------------------------------------------------------------------
$('new-share-btn').addEventListener('click', openPicker);

// Configuration → "Default folder": browse to pick it, or clear it back to empty.
if ($('cfg-default-dir-browse')) $('cfg-default-dir-browse').addEventListener('click', openDefaultDirPicker);
if ($('cfg-default-dir-clear')) $('cfg-default-dir-clear').addEventListener('click', () => { $('cfg-default-dir').value = ''; });

// ------------------------------------------------------------------
// Creating a reception link (modal: name, expiry, password, quotas, filters)
// ------------------------------------------------------------------
const MB = 1024 * 1024;
function mbToBytes(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * MB) : 0;
}

function openInboxModal() {
  const s = state.settings || {};
  $('ib-name').value = '';
  $('ib-expiry').value = '0';
  $('ib-startsat').value = s.defaultStartDelayHours > 0
    ? toLocalDatetime(new Date(Date.now() + s.defaultStartDelayHours * 3600000))
    : '';
  $('ib-password').value = '';
  $('ib-maxfiles').value = s.defaultMaxFiles ? String(s.defaultMaxFiles) : '';
  // Reception-link defaults from the Configuration window.
  $('ib-maxfile').value = s.defaultMaxFileBytes ? String(Math.round(s.defaultMaxFileBytes / (1024 * 1024))) : '';
  $('ib-maxtotal').value = s.defaultMaxTotalBytes ? String(Math.round(s.defaultMaxTotalBytes / (1024 * 1024))) : '';
  $('ib-allow').value = s.defaultAllowExt || '';
  $('ib-block').value = s.defaultBlockExt || '';
  $('ib-note').value = s.receptionBanner || '';
  if ($('ib-moderated')) $('ib-moderated').checked = false;
  $('inbox-error').classList.add('hidden');
  $('inbox-overlay').classList.remove('hidden');
  if (window.DXInboxEnc) window.DXInboxEnc.reset();
  // Default end-to-end encryption (applied after reset(), which clears it).
  if (s.defaultEncrypt && $('ib-encrypt') && !$('ib-encrypt').disabled) {
    $('ib-encrypt').checked = true;
    $('ib-encrypt').dispatchEvent(new Event('change'));
  }
  $('ib-name').focus();
}
function closeInboxModal() {
  $('inbox-overlay').classList.add('hidden');
}

$('new-inbox-btn').addEventListener('click', openInboxModal);
$('inbox-close').addEventListener('click', closeInboxModal);
$('inbox-cancel').addEventListener('click', closeInboxModal);
$('inbox-overlay').addEventListener('click', (e) => {
  if (e.target === $('inbox-overlay')) closeInboxModal();
});

$('inbox-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const encPlan = (window.DXInboxEnc && window.DXInboxEnc.plan) ? window.DXInboxEnc.plan() : null;
  const payload = {
    name: $('ib-name').value.trim(),
    expiresInSeconds: parseInt($('ib-expiry').value, 10) || 0,
    startsAt: startsAtMs('ib-startsat'),
    password: $('ib-password').value,
    maxFiles: parseInt($('ib-maxfiles').value, 10) || 0,
    maxFileBytes: mbToBytes($('ib-maxfile').value),
    maxTotalBytes: mbToBytes($('ib-maxtotal').value),
    allowExt: $('ib-allow').value,
    blockExt: $('ib-block').value,
    note: $('ib-note').value,
    groupBySender: $('ib-group-sender') ? $('ib-group-sender').checked : false,
    moderated: $('ib-moderated') ? $('ib-moderated').checked : false,
    geoMode: $('ib-geomode').value, geoCountries: $('ib-geocountries').value,
    ipMode: $('ib-ipmode').value, ipList: $('ib-iplist').value,
  };
  try {
    if (encPlan) Object.assign(payload, encPlan.payloadExtra);
    const resp = await api('POST', '/api/inbox', payload);
    toast(t('inbox.created'), 'ok');
    closeInboxModal();
    refreshShares();
    if (encPlan && resp && resp.share) encPlan.finalize(resp.share.url, payload.name || resp.share.name);
    if (window.DXInboxEnc) window.DXInboxEnc.reset();
  } catch (err) {
    toast(t('inbox.createFail'), 'err');
  }
});

// --- Collaboration link (two-way shared folder) ---
function openCollabModal() {
  const s = state.settings || {};
  $('cl-name').value = '';
  $('cl-expiry').value = '0';
  $('cl-startsat').value = s.defaultStartDelayHours > 0
    ? toLocalDatetime(new Date(Date.now() + s.defaultStartDelayHours * 3600000))
    : '';
  $('cl-password').value = '';
  $('cl-allow-delete').checked = false;
  syncCollabDelete(); // deletion stays off/disabled until a password is set
  $('cl-allow-zip').checked = true;
  if ($('cl-moderated')) $('cl-moderated').checked = false;
  $('cl-maxfile').value = s.defaultMaxFileBytes ? String(Math.round(s.defaultMaxFileBytes / (1024 * 1024))) : '';
  $('cl-maxtotal').value = s.defaultMaxTotalBytes ? String(Math.round(s.defaultMaxTotalBytes / (1024 * 1024))) : '';
  $('cl-allow').value = s.defaultAllowExt || '';
  $('cl-block').value = s.defaultBlockExt || '';
  $('cl-note').value = s.receptionBanner || '';
  $('collab-error').classList.add('hidden');
  $('collab-overlay').classList.remove('hidden');
  $('cl-name').focus();
}
function closeCollabModal() { $('collab-overlay').classList.add('hidden'); }
// Visitor deletion is a privileged action, so it's only offered on a
// password-protected link: with no password the checkbox is disabled, forced
// off, and a warning is shown.
function syncCollabDelete() {
  const hasPw = $('cl-password').value.trim().length > 0;
  const del = $('cl-allow-delete');
  del.disabled = !hasPw;
  if (!hasPw) del.checked = false;
  const row = $('cl-allow-delete-row');
  if (row) row.classList.toggle('is-disabled', !hasPw);
  const hint = $('cl-delete-hint');
  if (hint) hint.classList.toggle('hidden', hasPw);
}
$('cl-password').addEventListener('input', syncCollabDelete);
$('new-collab-btn').addEventListener('click', openCollabModal);
$('collab-close').addEventListener('click', closeCollabModal);
$('collab-cancel').addEventListener('click', closeCollabModal);
$('collab-overlay').addEventListener('click', (e) => {
  if (e.target === $('collab-overlay')) closeCollabModal();
});
$('collab-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: $('cl-name').value.trim(),
    expiresInSeconds: parseInt($('cl-expiry').value, 10) || 0,
    startsAt: startsAtMs('cl-startsat'),
    password: $('cl-password').value,
    allowDelete: $('cl-allow-delete').checked,
    allowZip: $('cl-allow-zip').checked,
    maxFileBytes: mbToBytes($('cl-maxfile').value),
    maxTotalBytes: mbToBytes($('cl-maxtotal').value),
    allowExt: $('cl-allow').value,
    blockExt: $('cl-block').value,
    note: $('cl-note').value,
    moderated: $('cl-moderated') ? $('cl-moderated').checked : false,
    geoMode: $('cl-geomode').value, geoCountries: $('cl-geocountries').value,
    ipMode: $('cl-ipmode').value, ipList: $('cl-iplist').value,
  };
  try {
    await api('POST', '/api/collab', payload);
    toast(t('collab.created'), 'ok');
    closeCollabModal();
    refreshShares();
  } catch (err) {
    toast(t('collab.createFail'), 'err');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('collab-overlay').classList.contains('hidden')) closeCollabModal();
});

// ------------------------------------------------------------------
// Export the persistent transfer journal (CSV / JSON)
// ------------------------------------------------------------------
async function exportTransfers(format) {
  try {
    const res = await fetch('/api/transfers/export?format=' + encodeURIComponent(format), {
      credentials: 'same-origin',
    });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error('export');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    const name = m ? m[1] : 'direct-xfer-transfers.' + format;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (_) {
    toast(t('hi.exportFail'), 'err');
  }
}
$('export-csv-btn').addEventListener('click', () => exportTransfers('csv'));
$('export-json-btn').addEventListener('click', () => exportTransfers('json'));

function updateHistoryFilters() {
  state.historyQuery = $('history-search').value;
  state.historyDirection = $('history-direction-filter').value;
  state.historyStatus = $('history-status-filter').value;
  state.historyPage = 0;
  renderHistoryPage();
}

if ($('history-filter-btn')) $('history-filter-btn').addEventListener('click', () => {
  const bar = $('history-filter-bar');
  const opening = bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !opening);
  $('history-filter-btn').setAttribute('aria-expanded', String(opening));
  if (opening) $('history-search').focus();
});
if ($('history-search')) $('history-search').addEventListener('input', updateHistoryFilters);
if ($('history-direction-filter')) $('history-direction-filter').addEventListener('change', updateHistoryFilters);
if ($('history-status-filter')) $('history-status-filter').addEventListener('change', updateHistoryFilters);
if ($('history-filter-reset')) $('history-filter-reset').addEventListener('click', () => {
  $('history-search').value = '';
  $('history-direction-filter').value = '';
  $('history-status-filter').value = '';
  updateHistoryFilters();
  $('history-search').focus();
});
if ($('history-filter-bar')) $('history-filter-bar').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('history-filter-bar').classList.add('hidden');
  $('history-filter-btn').setAttribute('aria-expanded', 'false');
  $('history-filter-btn').focus();
});

if ($('history-clear-btn')) $('history-clear-btn').addEventListener('click', async () => {
  if (!confirm(t('hi.clearConfirm'))) return;
  try {
    await api('DELETE', '/api/history');
    toast(t('hi.cleared'), 'ok');
    state.lastHistoryMetaSig = historyMetaSignature({ count: 0 });
    renderHistory([]);
    refreshShares();
  } catch (e) {
    toast(t('hi.clearFail'), 'err');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('inbox-overlay').classList.contains('hidden')) closeInboxModal();
});

$('picker-close').addEventListener('click', closePicker);
$('picker-cancel').addEventListener('click', closePicker);
$('picker-overlay').addEventListener('click', (e) => {
  if (e.target === $('picker-overlay')) closePicker();
});
document.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    !$('picker-overlay').classList.contains('hidden') &&
    $('preview-overlay').classList.contains('hidden')
  )
    closePicker();
});

$('preview-close').addEventListener('click', closePreview);
$('preview-overlay').addEventListener('click', (e) => {
  if (e.target === $('preview-overlay')) closePreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('preview-overlay').classList.contains('hidden')) closePreview();
});
$('preview-video').addEventListener('error', () => {
  $('preview-video').classList.add('hidden');
  $('preview-status').classList.remove('hidden');
});

// Opens the video-preview modal for a host file entry from the picker (not yet
// shared — streamed straight from disk via the admin-only /api/preview route).
function openPreview(entry) {
  $('preview-title').textContent = entry.name;
  const video = $('preview-video');
  $('preview-status').classList.add('hidden');
  video.classList.remove('hidden');
  video.src = '/api/preview?path=' + encodeURIComponent(entry.path);
  $('preview-overlay').classList.remove('hidden');
  video.load();
}
function closePreview() {
  $('preview-overlay').classList.add('hidden');
  const video = $('preview-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

// A datetime-local field value → epoch ms (0 when empty/invalid = "active now").
function startsAtMs(id) {
  const v = $(id).value;
  if (!v) return 0;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : 0;
}
// Date -> "YYYY-MM-DDTHH:MM" in local time, for <input type="datetime-local">.
function toLocalDatetime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function openPicker() {
  state.pickerMode = 'create';
  state.addToShareId = null;
  state.selections = [];
  // Pre-fill with the configured defaults for new links (Configuration window).
  const s = state.settings || {};
  $('opt-expiry').value = String(s.defaultExpiry || 0);
  $('opt-maxdl').value = s.defaultMaxDownloads ? String(s.defaultMaxDownloads) : '';
  $('opt-rate').value = s.defaultRateKBps ? String(s.defaultRateKBps) : '';
  $('opt-allowzip').checked = s.defaultAllowZip !== false;
  $('opt-preview').checked = s.defaultAllowPreview !== false;
  $('opt-burn').checked = !!s.defaultBurnAfterDownload;
  if ($('opt-note')) $('opt-note').value = '';
  $('opt-password').value = '';
  $('opt-password').required = !!s.defaultRequirePassword;
  // Deferred-start default: pre-fill "active from" with now + N hours.
  $('opt-startsat').value = s.defaultStartDelayHours > 0
    ? toLocalDatetime(new Date(Date.now() + s.defaultStartDelayHours * 3600000))
    : '';
  $('share-options').classList.remove('hidden');
  if ($('pk-multi-hint')) $('pk-multi-hint').classList.remove('hidden');
  $('picker-title').textContent = t('pk.title');
  $('create-share-btn').textContent = t('pk.share');
  updateSelectionUI();
  $('picker-overlay').classList.remove('hidden');
  // Start at the configured default folder (Configuration → Defaults for new links);
  // fall back to the last-browsed folder, then root. A stale/invalid default lands
  // on root rather than erroring (browse() re-validates server-side).
  browse(s.defaultShareDir || state.cwd || '/', true);
}

// Opens the picker as a folder chooser that writes the picked directory into the
// "default folder" config field (instead of creating a share).
function openDefaultDirPicker() {
  state.pickerMode = 'configDir';
  state.addToShareId = null;
  state.selections = [];
  $('share-options').classList.add('hidden');
  if ($('pk-multi-hint')) $('pk-multi-hint').classList.add('hidden');
  $('picker-title').textContent = t('pk.chooseDir');
  $('create-share-btn').textContent = t('pk.chooseDirBtn');
  // Raise the picker above the Configuration modal (both are .overlay z-index 40,
  // and the config modal comes later in the DOM, so it would otherwise sit on top
  // and swallow all clicks). Reset on close so the in-picker video preview (z-index
  // 45) still stacks correctly during normal share creation.
  $('picker-overlay').style.zIndex = '50';
  $('picker-overlay').classList.remove('hidden');
  const cur = ($('cfg-default-dir') && $('cfg-default-dir').value.trim()) || '';
  browse(cur || (state.settings && state.settings.defaultShareDir) || '/', true);
}

// Open the picker to append files to an existing (file) share.
function openPickerForAdd(share) {
  state.pickerMode = 'addTo';
  state.addToShareId = share.id;
  state.selections = [];
  $('share-options').classList.add('hidden');
  if ($('pk-multi-hint')) $('pk-multi-hint').classList.remove('hidden');
  $('picker-title').textContent = t('pk.addTitle', { name: share.name });
  $('create-share-btn').textContent = t('pk.addBtn');
  updateSelectionUI();
  $('picker-overlay').classList.remove('hidden');
  browse(state.cwd || '/');
}
function closePicker() {
  $('picker-overlay').classList.add('hidden');
  $('picker-overlay').style.zIndex = ''; // reset the folder-chooser z-index bump
}

// --- Photos tab ---------------------------------------------------------------
// Open the picker to create direct image links (non-images are rejected server-side).
function openPhotosPicker() {
  state.pickerMode = 'photos';
  state.addToShareId = null;
  state.selections = [];
  $('share-options').classList.add('hidden'); // photos need no expiry/password options
  if ($('pk-multi-hint')) $('pk-multi-hint').classList.remove('hidden');
  $('picker-title').textContent = t('photo.pickTitle');
  $('create-share-btn').textContent = t('photo.pickBtn');
  updateSelectionUI();
  $('picker-overlay').classList.remove('hidden');
  const s = state.settings || {};
  browse(s.defaultShareDir || state.cwd || '/', true);
}
if ($('photos-add-btn')) $('photos-add-btn').addEventListener('click', openPhotosPicker);

async function createPhotos(paths) {
  let r;
  try { r = await api('POST', '/api/photos', { paths }); }
  catch (e) {
    const errors = (e.data && Array.isArray(e.data.errors)) ? e.data.errors : [];
    const copyFailed = errors.filter((item) => item && item.error === 'image-copy-failed').length;
    toast(copyFailed ? t('photo.copyFailed', { n: copyFailed }) : t('photo.createFail'), 'err');
    return;
  }
  closePicker();
  const created = (r && r.created) || [];
  const errors = (r && Array.isArray(r.errors)) ? r.errors : [];
  const copyFailed = errors.filter((item) => item && item.error === 'image-copy-failed').length;
  const skipped = errors.length - copyFailed;
  const notices = [t('photo.created', { n: created.length })];
  if (skipped) notices.push(t('photo.skipped', { n: skipped }));
  if (copyFailed) notices.push(t('photo.copyFailed', { n: copyFailed }));
  toast(notices.join(' · '),
    created.length ? 'ok' : 'warn');
  refreshShares();
  // Generate + upload both smaller variants in the browser (no server image lib).
  for (const p of created) generatePhotoVariants(p).catch(() => {});
}

const photoVariantJobs = new Set();

// Generating variants for a batch of freshly added images finishes many uploads
// within a second; calling refreshShares() after each one issues a burst of
// GET /api/shares and rebuilds the whole gallery every time (visible flicker +
// re-decoded previews). Coalesce those into a single trailing refresh.
let sharesRefreshTimer = null;
function scheduleSharesRefresh(delay = 400) {
  clearTimeout(sharesRefreshTimer);
  sharesRefreshTimer = setTimeout(() => { sharesRefreshTimer = null; refreshShares(); }, delay);
}

// Draws the full image once, then creates Mini (≤ 400 px) and Micro (≤ 200 px).
// The same-origin source keeps the canvas usable with a custom image domain.
async function generatePhotoVariants(photo) {
  if (!photo || !photo.photo || photoVariantJobs.has(photo.id)) return;
  const variants = [];
  if (!photo.photo.hasThumb) variants.push('thumb');
  if (!photo.photo.hasMicro) variants.push('micro');
  if (!variants.length) return;
  photoVariantJobs.add(photo.id);
  try {
    const src = '/i/' + photo.token + '.' + (photo.photo.ext || 'jpg');
    const img = await new Promise((resolve, reject) => {
      const loaded = new Image();
      loaded.onload = () => resolve(loaded);
      loaded.onerror = () => reject(new Error('load'));
      loaded.src = src;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('dim');
    const thumbScale = Math.min(1, 400 / Math.max(w, h));
    const thumbWidth = Math.max(1, Math.round(w * thumbScale));
    const thumbHeight = Math.max(1, Math.round(h * thumbScale));
    const dimensions = {
      thumb: [thumbWidth, thumbHeight],
      micro: [Math.max(1, Math.round(thumbWidth / 2)), Math.max(1, Math.round(thumbHeight / 2))],
    };
    const makeBlob = (name) => new Promise((resolve, reject) => {
      try {
        const [cw, ch] = dimensions[name];
        const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
        cv.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('blob'))), 'image/jpeg', 0.8);
      } catch (e) { reject(e); }
    });
    await Promise.all(variants.map(async (variant) => {
      const response = await fetch('/api/photos/' + encodeURIComponent(photo.id) + '/' + variant, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': state.csrf || '' },
        body: await makeBlob(variant),
      });
      if (!response.ok) throw new Error(variant + '-upload');
    }));
    scheduleSharesRefresh();
  } finally {
    photoVariantJobs.delete(photo.id);
  }
}

// One URL row with copy buttons: raw URL plus ready-to-paste Markdown, HTML and
// BBCode snippets (each tooltip shows the exact snippet it copies).
function photoUrlRow(label, url, snippets) {
  const row = el('div', { class: 'photo-url-row' });
  const field = el('div', { class: 'photo-url-field' });
  field.appendChild(el('span', { class: 'photo-url-label', text: label }));
  const box = el('input', { class: 'photo-url-box', attrs: { type: 'text', readonly: 'readonly' } });
  box.value = url;
  box.addEventListener('focus', () => box.select());
  field.appendChild(box);
  row.appendChild(field);
  const actions = el('div', { class: 'photo-url-actions' });
  const mkbtn = (txt, payload, title) => {
    const attrs = { type: 'button' };
    if (title) attrs.title = title;
    const bt = el('button', { class: 'btn ghost xs', text: txt, attrs });
    bt.addEventListener('click', () => copy(payload));
    return bt;
  };
  actions.appendChild(mkbtn(t('sh.copy'), url, url));
  if (snippets) {
    if (snippets.md) actions.appendChild(mkbtn(t('photo.md'), snippets.md, snippets.md));
    if (snippets.html) actions.appendChild(mkbtn(t('photo.html'), snippets.html, snippets.html));
    if (snippets.bb) actions.appendChild(mkbtn(t('photo.bbcode'), snippets.bb, snippets.bb));
  }
  row.appendChild(actions);
  return row;
}

function photoFullStat(p) { return t('photo.full') + ' 👁 ' + (p.fullViews || 0) + ' · 👤 ' + (p.fullVisitors || 0); }
function photoThumbStat(p) { return t('photo.thumb') + ' 👁 ' + (p.thumbViews || 0) + ' · 👤 ' + (p.thumbVisitors || 0); }
function photoMicroStat(p) { return t('photo.micro') + ' 👁 ' + (p.microViews || 0) + ' · 👤 ' + (p.microVisitors || 0); }

// Live-patch just the view/visitor numbers on each poll — no grid rebuild, so the
// preview images don't reload and the counts tick up smoothly every second.
function updatePhotoStats(photos) {
  const list = $('photos-list');
  if (!list) return;
  // Runs every second in steady state, so resolve every card in a single DOM pass
  // and look them up by token instead of one attribute-selector scan per photo.
  const cards = new Map();
  list.querySelectorAll('.photo-card[data-token]').forEach((c) => cards.set(c.getAttribute('data-token'), c));
  photos.forEach((s) => {
    const p = s.photo || {};
    const card = cards.get(s.token);
    if (!card) return;
    const f = card.querySelector('.photo-stat-full');
    const th = card.querySelector('.photo-stat-thumb');
    const mi = card.querySelector('.photo-stat-micro');
    if (f) { f.textContent = photoFullStat(p); f.title = t('sh.viewsTip', { views: p.fullViews || 0, visitors: p.fullVisitors || 0 }); }
    if (th) { th.textContent = photoThumbStat(p); th.title = t('sh.viewsTip', { views: p.thumbViews || 0, visitors: p.thumbVisitors || 0 }); }
    if (mi) { mi.textContent = photoMicroStat(p); mi.title = t('sh.viewsTip', { views: p.microViews || 0, visitors: p.microVisitors || 0 }); }
  });
}

function renderPhotoHistory(history) {
  const list = $('photos-history-list');
  if (!list) return;
  const items = (Array.isArray(history) ? history : []).slice(0, 50);
  if ($('photos-history-count')) $('photos-history-count').textContent = items.length;
  if ($('photos-history-purge')) $('photos-history-purge').disabled = items.length === 0;
  list.textContent = '';
  if (!items.length) {
    list.appendChild(el('div', { class: 'empty', text: t('photo.historyEmpty') }));
    return;
  }
  items.forEach((record) => {
    const card = el('div', { class: 'photo-card photo-history-card' });
    if (state.role !== 'auditor') {
      const deleteLabel = t('photo.historyDelete');
      const deleteBtn = el('button', {
        class: 'photo-history-delete',
        text: '×',
        attrs: { type: 'button', title: deleteLabel, 'aria-label': deleteLabel },
      });
      deleteBtn.addEventListener('click', async () => {
        const name = record.name || '';
        if (!confirm(t('photo.historyDeleteConfirm', { name }))) return;
        deleteBtn.disabled = true;
        try {
          const result = await api('DELETE', '/api/photos/history/' + encodeURIComponent(record.id));
          state.lastPhotoHistoryMetaSig = photoHistoryMetaSignature(result.meta);
          renderPhotoHistory(items.filter((item) => item.id !== record.id));
          await loadPhotoHistory(); // refill the 50-item window when older entries exist
          toast(t('photo.historyDeleted'), 'ok');
        } catch (_) {
          deleteBtn.disabled = false;
          toast(t('photo.historyDeleteFail'), 'err');
        }
      });
      card.appendChild(deleteBtn);
    }
    const preview = el('div', { class: 'photo-thumb photo-history-thumb' });
    const showPlaceholder = () => {
      preview.textContent = '';
      preview.appendChild(el('span', { class: 'photo-history-placeholder', text: '🖼', attrs: { title: t('photo.previewUnavailable') } }));
    };
    if (record.previewUrl) {
      const img = el('img', { attrs: { loading: 'lazy', alt: record.name || '' } });
      img.src = record.previewUrl;
      img.addEventListener('error', showPlaceholder, { once: true });
      preview.appendChild(img);
    } else {
      showPlaceholder();
    }
    card.appendChild(preview);
    card.appendChild(el('div', { class: 'photo-name', text: record.name || '' }));
    const stats = el('div', { class: 'photo-stats muted sm' });
    const fullStat = el('span', { class: 'photo-stat photo-stat-full', text: photoFullStat(record) });
    fullStat.title = t('sh.viewsTip', { views: record.fullViews || 0, visitors: record.fullVisitors || 0 });
    const thumbStat = el('span', { class: 'photo-stat photo-stat-thumb', text: photoThumbStat(record) });
    thumbStat.title = t('sh.viewsTip', { views: record.thumbViews || 0, visitors: record.thumbVisitors || 0 });
    const microStat = el('span', { class: 'photo-stat photo-stat-micro', text: photoMicroStat(record) });
    microStat.title = t('sh.viewsTip', { views: record.microViews || 0, visitors: record.microVisitors || 0 });
    stats.append(fullStat, thumbStat, microStat);
    card.appendChild(stats);
    const meta = [t('photo.revokedAt', { date: formatDate(record.revokedAt) })];
    if (record.size) meta.push(t('photo.histFull', { size: formatBytes(record.size) }));
    if (record.previewSize) meta.push(t('photo.histKept', { size: formatBytes(record.previewSize) }));
    // Each segment (label + its value) stays on one line; only the " · " between
    // segments may wrap. Otherwise "complète 16.6 Ko" breaks in two on narrow cards.
    const metaEl = el('div', { class: 'photo-hist-meta muted sm' });
    meta.forEach((part, i) => {
      if (i) metaEl.appendChild(document.createTextNode(' · '));
      metaEl.appendChild(el('span', { class: 'nowrap', text: part }));
    });
    card.appendChild(metaEl);
    list.appendChild(card);
  });
}

if ($('photos-history-purge')) $('photos-history-purge').addEventListener('click', async () => {
  if (!confirm(t('photo.purgeConfirm'))) return;
  try {
    const result = await api('DELETE', '/api/photos/history');
    state.lastPhotoHistoryMetaSig = photoHistoryMetaSignature(result.meta);
    renderPhotoHistory([]);
    toast(t('photo.purged'), 'ok');
  } catch (_) {
    toast(t('photo.purgeFail'), 'err');
  }
});

function dimensionsForPhoto(s) {
  const p = s.photo || {};
  const cached = state.photoDimsCache[s.token] || {};
  return {
    w: Number(p.w || cached.w || (cached.full && cached.full.w)) || 0,
    h: Number(p.h || cached.h || (cached.full && cached.full.h)) || 0,
  };
}

function orientationForPhoto(s) {
  const d = dimensionsForPhoto(s);
  if (!d.w || !d.h) return '';
  const ratio = d.w / d.h;
  if (ratio >= 0.95 && ratio <= 1.05) return 'square';
  return ratio > 1 ? 'landscape' : 'portrait';
}

function albumHasPhoto(album, token) {
  return !!(album && album.album && Array.isArray(album.album.members) && album.album.members.includes(token));
}

// Applies the current search, filters and sort order to the photo list.
function visiblePhotos(photos) {
  const q = (state.photoSearch || '').trim().toLowerCase();
  const totalViews = (s) => { const p = s.photo || {}; return (p.fullViews || 0) + (p.thumbViews || 0) + (p.microViews || 0); };
  let arr = photos.slice();
  if (q) arr = arr.filter((s) => [s.name, s.token, s.photo && s.photo.ext]
    .some((v) => String(v || '').toLowerCase().includes(q))
    || (Array.isArray(s.tags) && s.tags.some((tg) => (tg || '').toLowerCase().includes(q))));
  if (state.photoFormat) arr = arr.filter((s) => {
    let ext = String((s.photo && s.photo.ext) || '').toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    return ext === state.photoFormat;
  });
  if (state.photoOrientation) arr = arr.filter((s) => orientationForPhoto(s) === state.photoOrientation);
  if (state.photoVariants === 'ready') arr = arr.filter((s) => s.photo && s.photo.hasThumb && s.photo.hasMicro);
  if (state.photoVariants === 'missing') arr = arr.filter((s) => !s.photo || !s.photo.hasThumb || !s.photo.hasMicro);
  if (state.photoFavoritesOnly) arr = arr.filter((s) => !!s.favorite);
  if (state.photoAlbum) {
    const albums = state.albumsData || [];
    if (state.photoAlbum === 'none') arr = arr.filter((s) => !albums.some((a) => albumHasPhoto(a, s.token)));
    else {
      const album = albums.find((a) => a.id === state.photoAlbum);
      arr = album ? arr.filter((s) => albumHasPhoto(album, s.token)) : [];
    }
  }
  const sort = state.photoSort || 'new';
  arr.sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
    if (sort === 'old') return (a.createdAt || 0) - (b.createdAt || 0);
    if (sort === 'name') return (a.name || '').localeCompare(b.name || '');
    if (sort === 'views') return totalViews(b) - totalViews(a);
    if (sort === 'size') return (b.size || 0) - (a.size || 0);
    if (sort === 'dimensions') {
      const da = dimensionsForPhoto(a), db = dimensionsForPhoto(b);
      return (db.w * db.h) - (da.w * da.h);
    }
    return (b.createdAt || 0) - (a.createdAt || 0); // 'new'
  });
  return arr;
}

function renderPhotos(photos) {
  const list = $('photos-list');
  if (!list) return;
  state.photosData = photos; // keep for search/sort re-render + export
  if (state.photoOrientation || state.photoSort === 'dimensions') photos.forEach((s) => ensurePhotoDims(s));
  // Drop any selected ids that no longer exist (revoked elsewhere / expired off).
  const presentIds = new Set(photos.map((s) => s.id));
  for (const id of [...state.photoSelection]) if (!presentIds.has(id)) state.photoSelection.delete(id);
  // The contextual favorite action also depends on the current favorite state,
  // so refresh it even when the set of selected ids itself did not change.
  updatePhotoBulkBar();
  const ordered = visiblePhotos(photos);
  if ($('photos-count')) $('photos-count').textContent = ordered.length;
  // Fast no-op path: the full structural signature (order + per-card sigs +
  // search/sort) is unchanged, so only the live counters may have moved.
  const sig = JSON.stringify(ordered.map(photoCardSig).concat([
    state.photoSearch || '', state.photoSort || 'new', state.photoFormat || '', state.photoOrientation || '',
    state.photoVariants || '', state.photoAlbum || '', !!state.photoFavoritesOnly,
  ]));
  if (sig === state.lastPhotosSig) { updatePhotoStats(ordered); return; }
  state.lastPhotosSig = sig;
  const cardMap = state.photoCards || (state.photoCards = new Map());
  if (!ordered.length) { list.textContent = ''; cardMap.clear(); list.appendChild(el('div', { class: 'empty', text: t('photo.none') })); return; }
  // Rebuild only the cards whose own signature changed; reuse the rest as-is so
  // their <img> previews stay decoded and in place (no flicker on rename / expiry
  // change / variant arrival / poll). Then reorder the DOM to match the sort.
  const seen = new Set();
  const desired = ordered.map((s) => {
    seen.add(s.token);
    const key = JSON.stringify(photoCardSig(s));
    const existing = cardMap.get(s.token);
    if (existing && existing.key === key) {
      // Selection is toggled out-of-band (bulk clear / album), so re-sync it.
      const cbx = existing.el.querySelector('.photo-select input');
      if (cbx) { const on = state.photoSelection.has(s.id); cbx.checked = on; existing.el.classList.toggle('selected', on); }
      return existing.el;
    }
    const cardEl = buildPhotoCard(s);
    cardMap.set(s.token, { el: cardEl, key });
    return cardEl;
  });
  for (const tok of [...cardMap.keys()]) if (!seen.has(tok)) cardMap.delete(tok);
  reconcileChildren(list, desired);
  updatePhotoStats(ordered);
}

// Reorders `parent`'s children to match `desired` (ordered nodes) and drops the
// rest, with the fewest DOM moves — nodes already in place are left untouched so
// their <img> previews are never re-decoded.
function reconcileChildren(parent, desired) {
  const wanted = new Set(desired);
  for (const child of [...parent.childNodes]) if (!wanted.has(child)) parent.removeChild(child);
  desired.forEach((node, i) => { if (parent.childNodes[i] !== node) parent.insertBefore(node, parent.childNodes[i] || null); });
}

// Structural signature of one gallery card. EXCLUDES the live view/visitor counts
// (patched in place by updatePhotoStats); INCLUDES everything whose change must
// rebuild the card. Selection is absent on purpose — it only toggles a class.
// Tags are joined on U+0001 so a comma inside a tag can't forge a false match.
function photoCardSig(s) {
  const p = s.photo || {};
  const d = state.photoDimsCache[s.token];
  // The per-copy size/dimension metadata (loaded lazily) is part of the signature
  // so the card rebuilds once it arrives.
  const dimSig = d
    ? [d.w, d.h, d.full && d.full.size, d.thumb && [d.thumb.w, d.thumb.h, d.thumb.size], d.micro && [d.micro.w, d.micro.h, d.micro.size]].join('/')
    : (p.w ? p.w + 'x' + p.h : '');
  return [s.token, s.name, s.active, !!s.favorite, !!p.hasThumb, !!p.hasMicro, p.ext, s.expiresAt || 0,
    dimSig, pendingShareDeletionFor(s.id), (s.tags || []).join('\u0001')];
}

// Builds a single gallery card element with all listeners wired. Kept separate
// from renderPhotos so the reconciler can rebuild only the cards that changed.
function buildPhotoCard(s) {
    const p = s.photo || {};
    if (!p.hasThumb || !p.hasMicro) generatePhotoVariants(s).catch(() => {});
    const isPendingDelete = pendingShareDeletionFor(s.id);
    const card = el('div', { class: 'photo-card' + (s.active ? '' : ' inactive') + (isPendingDelete ? ' pending-delete' : ''), attrs: { 'data-token': s.token } });
    // The gallery preview must load SAME-ORIGIN: the configured image domain
    // (imageBase) may be an external/CDN host that the admin browser can't reach.
    // The imageBase URLs are used only for the copy / embed buttons below.
    const localFull = '/i/' + s.token + '.' + (p.ext || 'jpg');
    const localThumb = '/i/' + s.token + '/thumb';
    const localMicro = '/i/' + s.token + '/micro';
    const link = el('a', { class: 'photo-thumb', attrs: { href: localFull, target: '_blank', rel: 'noopener', title: s.name } });
    const img = el('img', { attrs: { loading: 'lazy', alt: s.name } });
    img.src = p.hasMicro ? localMicro : (p.hasThumb ? localThumb : localFull);
    link.appendChild(img);
    // Click opens the in-page lightbox; modifier / middle clicks keep the
    // native "open image in a new tab" behaviour (the href stays intact).
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      openLightbox(s.token);
    });
    card.appendChild(link);
    // Selection checkbox (bulk actions), overlaid on the preview.
    const selWrap = el('label', { class: 'photo-select', attrs: { title: t('photo.selectHint') } });
    const cb = el('input', { attrs: { type: 'checkbox' } });
    cb.checked = state.photoSelection.has(s.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.photoSelection.add(s.id); else state.photoSelection.delete(s.id);
      card.classList.toggle('selected', cb.checked);
      updatePhotoBulkBar();
    });
    if (cb.checked) card.classList.add('selected');
    selWrap.appendChild(cb);
    card.appendChild(selWrap);
    const favorite = el('button', {
      class: 'photo-favorite' + (s.favorite ? ' active' : ''),
      text: s.favorite ? '★' : '☆',
      attrs: { type: 'button', title: t(s.favorite ? 'photo.unfavorite' : 'photo.favorite'), 'aria-pressed': s.favorite ? 'true' : 'false' },
    });
    favorite.addEventListener('click', async () => {
      favorite.disabled = true;
      try { await api('PATCH', '/api/shares/' + encodeURIComponent(s.id), { favorite: !s.favorite }); refreshShares(); }
      catch (_) { favorite.disabled = false; }
    });
    card.appendChild(favorite);
    // Double-click the name to rename in place.
    const nameEl = el('div', { class: 'photo-name', text: s.name, attrs: { title: t('photo.renameHint') } });
    nameEl.addEventListener('dblclick', () => startPhotoRename(s, nameEl));
    card.appendChild(nameEl);
    const urls = el('div', { class: 'photo-urls' });
    const name = s.name || '';
    // Full size → direct embed; Mini/Micro → clickable preview linking to the full image.
    urls.appendChild(photoUrlRow(t('photo.full'), p.imgUrl, {
      md: '![' + name + '](' + p.imgUrl + ')',
      html: '<img src="' + p.imgUrl + '" alt="' + name + '">',
      bb: '[img]' + p.imgUrl + '[/img]',
    }));
    urls.appendChild(photoUrlRow(t('photo.thumb'), p.thumbUrl, {
      md: '[![' + name + '](' + p.thumbUrl + ')](' + p.imgUrl + ')',
      html: '<a href="' + p.imgUrl + '"><img src="' + p.thumbUrl + '" alt="' + name + '"></a>',
      bb: '[url=' + p.imgUrl + '][img]' + p.thumbUrl + '[/img][/url]',
    }));
    urls.appendChild(photoUrlRow(t('photo.micro'), p.microUrl, {
      md: '[![' + name + '](' + p.microUrl + ')](' + p.imgUrl + ')',
      html: '<a href="' + p.imgUrl + '"><img src="' + p.microUrl + '" alt="' + name + '"></a>',
      bb: '[url=' + p.imgUrl + '][img]' + p.microUrl + '[/img][/url]',
    }));
    card.appendChild(urls);
    const stats = el('div', { class: 'photo-stats muted sm' });
    stats.appendChild(el('span', {
      class: 'photo-stat photo-stat-full',
      text: photoFullStat(p),
      attrs: { title: t('sh.viewsTip', { views: p.fullViews || 0, visitors: p.fullVisitors || 0 }) },
    }));
    stats.appendChild(el('span', {
      class: 'photo-stat photo-stat-thumb',
      text: photoThumbStat(p),
      attrs: { title: t('sh.viewsTip', { views: p.thumbViews || 0, visitors: p.thumbVisitors || 0 }) },
    }));
    stats.appendChild(el('span', {
      class: 'photo-stat photo-stat-micro',
      text: photoMicroStat(p),
      attrs: { title: t('sh.viewsTip', { views: p.microViews || 0, visitors: p.microVisitors || 0 }) },
    }));
    card.appendChild(stats);
    // Per-copy dimensions + byte size for Full / Mini / Micro. Full dims/size come
    // from the share; the Mini/Micro figures (and Full dims for host-file images)
    // are fetched lazily and read from the stored files server-side.
    const cmeta = state.photoDimsCache[s.token] || {};
    const copies = el('div', { class: 'photo-copies muted sm' });
    const copyRow = (label, info, sizeFallback, dimFallback) => {
      const bits = [];
      const dim = (info && info.w && info.h) ? info : dimFallback;
      if (dim && dim.w && dim.h) bits.push(dim.w + '×' + dim.h);
      const size = (info && info.size) || sizeFallback;
      if (size) bits.push(formatBytes(size));
      const row = el('div', { class: 'photo-copy' });
      row.appendChild(el('span', { class: 'photo-copy-label', text: label }));
      row.appendChild(el('span', { class: 'photo-copy-meta', text: bits.length ? bits.join(' · ') : '…' }));
      return row;
    };
    const fullDim = (p.w && p.h) ? { w: p.w, h: p.h } : null;
    copies.appendChild(copyRow(t('photo.full'), cmeta.full, s.size, fullDim));
    if (p.hasThumb) copies.appendChild(copyRow(t('photo.thumb'), cmeta.thumb, null, null));
    if (p.hasMicro) copies.appendChild(copyRow(t('photo.micro'), cmeta.micro, null, null));
    card.appendChild(copies);
    // Detailed metadata: format, creation date, ratio/orientation, expiry and state.
    const metaParts = [String(p.ext || '').toUpperCase()].filter(Boolean);
    if (s.createdAt) metaParts.push(t('photo.createdAt', { date: formatDate(s.createdAt) }));
    const fullDetails = dimensionsForPhoto(s);
    if (fullDetails.w && fullDetails.h) {
      const gcd = (a, b) => { while (b) { const n = a % b; a = b; b = n; } return a || 1; };
      const div = gcd(fullDetails.w, fullDetails.h);
      metaParts.push(t(orientationForPhoto(s) === 'square' ? 'photo.square' : orientationForPhoto(s) === 'portrait' ? 'photo.portrait' : 'photo.landscape'));
      metaParts.push(t('photo.ratio', { ratio: (fullDetails.w / div) + ':' + (fullDetails.h / div) }));
    }
    if (s.expiresAt) metaParts.push(t('sh.expires') + ' ' + formatDate(s.expiresAt));
    if (!s.active) metaParts.push(t('sh.inactive'));
    if (metaParts.length) card.appendChild(el('div', { class: 'photo-meta muted sm', text: metaParts.join(' · ') }));
    ensurePhotoDims(s);
    card.appendChild(tagsSection(s));
    const actions = el('div', { class: 'photo-actions' });
    if (!s.encrypted) {
      const cloneBtn = el('button', { class: 'btn ghost sm clone-btn', text: t('sh.clone'), attrs: { title: t('sh.cloneTitle') } });
      cloneBtn.addEventListener('click', () => cloneShare(s, cloneBtn));
      actions.appendChild(cloneBtn);
    }
    const statsBtn = el('button', { class: 'btn ghost sm stats-btn', text: t('stats.button'), attrs: { title: t('stats.title') } });
    statsBtn.addEventListener('click', () => openDetailedStats(s));
    actions.appendChild(statsBtn);
    const rename = el('button', { class: 'btn ghost sm', text: t('photo.rename') });
    rename.addEventListener('click', () => startPhotoRename(s, nameEl));
    actions.appendChild(rename);
    actions.appendChild(photoExpirySelect(s));
    const qrBtn = el('button', { class: 'btn ghost sm', text: t('sh.qr'), attrs: { title: t('sh.qrTitle') } });
    qrBtn.addEventListener('click', () => openQrFor(s.name, p.imgUrl));
    actions.appendChild(qrBtn);
    const rev = el('button', { class: 'btn danger sm', text: t('sh.revoke') });
    rev.addEventListener('click', () => revokeShare(s));
    actions.appendChild(rev);
    card.appendChild(actions);
    if (isPendingDelete) card.appendChild(pendingShareDeletionBar(s));
    return card;
}

// Feature 18 — public image galleries. Renders the album shares (created from a
// bulk image selection) with their shareable /g/ link, view count and controls.
function renderAlbums(albums) {
  const list = $('albums-list');
  if (!list) return;
  state.albumsData = albums;
  syncPhotoAlbumControls(albums);
  const section = $('albums-section');
  if (section) section.classList.toggle('hidden', albums.length === 0);
  if ($('albums-count')) $('albums-count').textContent = albums.length;
  const sig = JSON.stringify(albums.map((s) => {
    const a = s.album || {};
    return [s.token, s.name, s.active, a.count || 0, s.expiresAt || 0, s.views || 0, pendingShareDeletionFor(s.id)];
  }));
  if (sig === state.lastAlbumsSig) return;
  state.lastAlbumsSig = sig;
  list.textContent = '';
  albums.forEach((s) => {
    const a = s.album || {};
    const isPendingDelete = pendingShareDeletionFor(s.id);
    const card = el('div', { class: 'album-card' + (s.active ? '' : ' inactive') + (isPendingDelete ? ' pending-delete' : '') });
    const head = el('div', { class: 'album-head' });
    head.appendChild(el('span', { class: 'album-name', text: s.name || t('album.untitled') }));
    const metaBits = [t('album.count', { n: a.count || 0 })];
    if (s.views) metaBits.push(t('album.views', { n: s.views }));
    if (s.expiresAt) metaBits.push(t('sh.expires') + ' ' + formatDate(s.expiresAt));
    if (!s.active) metaBits.push(t('sh.inactive'));
    head.appendChild(el('span', { class: 'muted sm', text: metaBits.join(' · ') }));
    card.appendChild(head);
    const urlRow = el('div', { class: 'album-url' });
    urlRow.appendChild(el('code', { text: a.url || '' }));
    const copyBtn = el('button', { class: 'btn ghost sm', text: t('sh.copy') });
    copyBtn.addEventListener('click', () => copy(a.url || ''));
    urlRow.appendChild(copyBtn);
    urlRow.appendChild(el('a', { class: 'btn ghost sm', text: t('photo.lbOpen'), attrs: { href: a.url || '#', target: '_blank', rel: 'noopener' } }));
    const qrBtn = el('button', { class: 'btn ghost sm', text: t('sh.qr') });
    qrBtn.addEventListener('click', () => openQrFor(s.name, a.url || ''));
    urlRow.appendChild(qrBtn);
    const cloneBtn = el('button', { class: 'btn ghost sm clone-btn', text: t('sh.clone'), attrs: { title: t('sh.cloneTitle') } });
    cloneBtn.addEventListener('click', () => cloneShare(s, cloneBtn));
    urlRow.appendChild(cloneBtn);
    const statsBtn = el('button', { class: 'btn ghost sm stats-btn', text: t('stats.button'), attrs: { title: t('stats.title') } });
    statsBtn.addEventListener('click', () => openDetailedStats(s));
    urlRow.appendChild(statsBtn);
    const rev = el('button', { class: 'btn danger sm', text: t('sh.revoke') });
    rev.addEventListener('click', () => revokeShare(s));
    urlRow.appendChild(rev);
    card.appendChild(urlRow);
    if (isPendingDelete) card.appendChild(pendingShareDeletionBar(s));
    list.appendChild(card);
  });
}

function syncPhotoAlbumControls(albums) {
  const sig = JSON.stringify((albums || []).map((a) => [a.id, a.name, a.active]));
  if (sig === state.lastPhotoAlbumOptionsSig) return;
  state.lastPhotoAlbumOptionsSig = sig;
  const filter = $('photos-filter-album');
  const bulk = $('photos-bulk-album-add');
  if (filter) {
    const previous = state.photoAlbum || '';
    filter.textContent = '';
    filter.appendChild(el('option', { text: t('photo.allAlbums'), attrs: { value: '' } }));
    filter.appendChild(el('option', { text: t('photo.noAlbum'), attrs: { value: 'none' } }));
    (albums || []).forEach((a) => filter.appendChild(el('option', { text: a.name || t('album.untitled'), attrs: { value: a.id } })));
    filter.value = [...filter.options].some((o) => o.value === previous) ? previous : '';
    state.photoAlbum = filter.value;
    if (state.photoAlbum !== previous) updateUiPrefs({ photoAlbum: state.photoAlbum });
  }
  if (bulk) {
    bulk.textContent = '';
    bulk.appendChild(el('option', { text: t('photo.bulkAlbum'), attrs: { value: '' } }));
    (albums || []).filter((a) => a.active).forEach((a) => bulk.appendChild(el('option', { text: a.name || t('album.untitled'), attrs: { value: a.id } })));
    bulk.value = '';
    bulk.disabled = !(albums || []).some((a) => a.active);
  }
}

const photoDimsJobs = new Set();
// Coalesces the re-render that shows freshly-loaded per-copy metadata: several
// images resolve their dims within a few ms of each other, so batch them into one
// incremental renderPhotos pass instead of one per image.
let photosMetaRerenderTimer = null;
function schedulePhotosMetaRerender() {
  clearTimeout(photosMetaRerenderTimer);
  photosMetaRerenderTimer = setTimeout(() => {
    photosMetaRerenderTimer = null;
    if (state.photosData) renderPhotos(state.photosData);
  }, 150);
}
// Fetches (and caches) size + pixel dimensions for an image's three copies (Full,
// Mini, Micro). Server reads them from the stored files — no view counted. Re-runs
// once when a variant is generated after the first fetch (so its figures appear).
function ensurePhotoDims(s) {
  const p = s.photo || {};
  const cached = state.photoDimsCache[s.token];
  const stale = cached && ((p.hasThumb && !cached.thumb) || (p.hasMicro && !cached.micro));
  if ((cached && !stale) || photoDimsJobs.has(s.id)) return;
  photoDimsJobs.add(s.id);
  api('GET', '/api/photos/' + encodeURIComponent(s.id) + '/dims')
    .then((r) => {
      if (r) { state.photoDimsCache[s.token] = r; schedulePhotosMetaRerender(); }
    })
    .catch(() => {})
    .finally(() => photoDimsJobs.delete(s.id));
}

// Inline rename for a photo card (restores the name on cancel/failure).
function startPhotoRename(s, nameEl) {
  if (nameEl.querySelector('input')) return;
  const cur = s.name || '';
  const input = el('input', { class: 'name-edit', attrs: { type: 'text', maxlength: '200' } });
  input.value = cur;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus(); input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (!save || !v || v === cur) { nameEl.textContent = cur; return; }
    try { await api('PATCH', '/api/shares/' + encodeURIComponent(s.id), { name: v }); toast(t('sh.renamed'), 'ok'); refreshShares(); }
    catch (e) { nameEl.textContent = cur; toast(t('sh.renameFail'), 'err'); }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

// Per-card expiry control: the first option shows the current state; picking a
// preset PATCHes the link. Preset labels are compact and language-neutral.
function photoExpirySelect(s) {
  const sel = el('select', { class: 'photo-expiry-sel', attrs: { title: t('photo.editExpiry') } });
  sel.appendChild(el('option', {
    text: s.expiresAt ? '⏱ ' + formatDate(s.expiresAt) : '⏱ ' + t('photo.noExpiry'),
    attrs: { value: 'keep' },
  }));
  [['0', '∞'], ['3600', '1h'], ['86400', '1d'], ['604800', '7d'], ['2592000', '30d']]
    .forEach(([v, l]) => sel.appendChild(el('option', { text: l, attrs: { value: v } })));
  sel.value = 'keep';
  sel.addEventListener('change', async () => {
    if (sel.value === 'keep') return;
    const secs = parseInt(sel.value, 10);
    try {
      await api('PATCH', '/api/shares/' + encodeURIComponent(s.id), { expiresInSeconds: secs });
      toast(t('photo.expiryUpdated'), 'ok');
      refreshShares();
    } catch (e) { toast(t('photo.expiryFail'), 'err'); sel.value = 'keep'; }
  });
  return sel;
}

// Client-side export of the (filtered) image list as CSV or JSON — no server round-trip.
function exportPhotos(fmt) {
  const rows = visiblePhotos(state.photosData || []).map((s) => {
    const p = s.photo || {};
    const d = (p.w && p.h) ? { w: p.w, h: p.h } : (state.photoDimsCache[s.token] || {});
    return {
      name: s.name, ext: p.ext || '',
      full: p.imgUrl, mini: p.thumbUrl, micro: p.microUrl,
      width: d.w || '', height: d.h || '', size: s.size || 0,
      fullViews: p.fullViews || 0, fullVisitors: p.fullVisitors || 0,
      thumbViews: p.thumbViews || 0, thumbVisitors: p.thumbVisitors || 0,
      microViews: p.microViews || 0, microVisitors: p.microVisitors || 0,
      createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : '',
      expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : '',
    };
  });
  if (!rows.length) { toast(t('photo.none'), 'warn'); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  let blob, filename;
  if (fmt === 'json') {
    blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    filename = 'direct-xfer-images-' + stamp + '.json';
  } else {
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const str = String(v == null ? '' : v); return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str; };
    const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
    blob = new Blob([csv], { type: 'text/csv' });
    filename = 'direct-xfer-images-' + stamp + '.csv';
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: filename } });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if ($('photos-search')) $('photos-search').addEventListener('input', () => {
  state.photoSearch = $('photos-search').value;
  updateUiPrefs({ photoSearch: state.photoSearch });
  if (state.photosData) renderPhotos(state.photosData);
});
if ($('photos-sort')) $('photos-sort').addEventListener('change', () => {
  state.photoSort = $('photos-sort').value;
  updateUiPrefs({ photoSort: state.photoSort });
  if (state.photosData) renderPhotos(state.photosData);
});
[
  ['photos-filter-format', 'photoFormat'],
  ['photos-filter-orientation', 'photoOrientation'],
  ['photos-filter-variants', 'photoVariants'],
  ['photos-filter-album', 'photoAlbum'],
].forEach(([id, key]) => {
  if ($(id)) $(id).addEventListener('change', () => {
    state[key] = $(id).value;
    updateUiPrefs({ [key]: state[key] });
    if (state.photosData) renderPhotos(state.photosData);
  });
});
if ($('photos-favorites-toggle')) $('photos-favorites-toggle').addEventListener('click', () => {
  state.photoFavoritesOnly = !state.photoFavoritesOnly;
  updateUiPrefs({ photoFavoritesOnly: state.photoFavoritesOnly });
  const btn = $('photos-favorites-toggle');
  btn.classList.toggle('active', state.photoFavoritesOnly);
  btn.setAttribute('aria-pressed', state.photoFavoritesOnly ? 'true' : 'false');
  if (state.photosData) renderPhotos(state.photosData);
});
if ($('photos-filter-reset')) $('photos-filter-reset').addEventListener('click', () => {
  state.photoSearch = ''; state.photoSort = 'new'; state.photoFormat = ''; state.photoOrientation = '';
  state.photoVariants = ''; state.photoAlbum = ''; state.photoFavoritesOnly = false;
  updateUiPrefs({
    photoSearch: '', photoSort: 'new', photoFormat: '', photoOrientation: '',
    photoVariants: '', photoAlbum: '', photoFavoritesOnly: false,
  });
  ['photos-search', 'photos-filter-format', 'photos-filter-orientation', 'photos-filter-variants', 'photos-filter-album']
    .forEach((id) => { if ($(id)) $(id).value = ''; });
  if ($('photos-sort')) $('photos-sort').value = 'new';
  if ($('photos-favorites-toggle')) {
    $('photos-favorites-toggle').classList.remove('active');
    $('photos-favorites-toggle').setAttribute('aria-pressed', 'false');
  }
  if (state.photosData) renderPhotos(state.photosData);
});
[['photos-view-grid', 'grid'], ['photos-view-list', 'list']].forEach(([id, mode]) => {
  if ($(id)) $(id).addEventListener('click', () => setPhotoView(mode));
});
if ($('photos-export-csv')) $('photos-export-csv').addEventListener('click', () => exportPhotos('csv'));
if ($('photos-export-json')) $('photos-export-json').addEventListener('click', () => exportPhotos('json'));
// Feature 10: copy every visible image's full-size link (one per line).
if ($('photos-copy-all')) $('photos-copy-all').addEventListener('click', () => {
  const urls = visiblePhotos(state.photosData || []).map((s) => (s.photo || {}).imgUrl).filter(Boolean);
  if (!urls.length) { toast(t('photo.none'), 'warn'); return; }
  copy(urls.join('\n'));
});

// --- Feature 8: drag-drop / paste to create image links (uploads raw bytes) ---
async function uploadImageFiles(fileList) {
  if (state.photoUploadBusy) return;
  const incoming = [...fileList];
  const allowed = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
  const files = incoming.slice(0, 100).filter((f) => f && ((f.type || '').startsWith('image/') || allowed.test(f.name || '')));
  const skipped = Math.max(0, incoming.length - files.length);
  if (!files.length) { toast(t('photo.uploadFail'), 'err'); return; }
  state.photoUploadBusy = true;
  let ok = 0, failed = 0, done = 0, cursor = 0;
  const wrap = $('photos-upload-progress'), meter = $('photos-upload-meter'), status = $('photos-upload-status');
  if (wrap) wrap.classList.remove('hidden');
  if (meter) { meter.max = files.length; meter.value = 0; }
  const updateProgress = () => {
    if (meter) meter.value = done;
    if (status) status.textContent = t('photo.uploadProgress', { done, total: files.length });
  };
  updateProgress();
  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      try {
        const typeExt = ((file.type || '').split('/')[1] || '').toLowerCase().replace('jpeg', 'jpg');
        const name = (file.name && /\.[a-z0-9]+$/i.test(file.name))
          ? file.name : ('image-' + Date.now() + (typeExt ? '.' + typeExt : '.png'));
        const r = await fetch('/api/photos/upload?name=' + encodeURIComponent(name), {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': state.csrf || '' },
          body: file,
        });
        if (!r.ok) throw new Error('upload');
        const data = await r.json();
        ok += 1;
        if (data && data.share) generatePhotoVariants(data.share).catch(() => {});
      } catch (_) { failed += 1; }
      done += 1;
      updateProgress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, () => worker()));
  state.photoUploadBusy = false;
  const summary = t('photo.uploadSummary', { ok, failed, skipped });
  if (status) status.textContent = summary;
  toast(summary, failed ? (ok ? 'warn' : 'err') : 'ok');
  if (ok) refreshShares();
  setTimeout(() => { if (!state.photoUploadBusy && wrap) wrap.classList.add('hidden'); }, 4000);
}
const photosDropzone = $('photos-dropzone');
if (photosDropzone) {
  const fileInput = $('photos-file-input');
  if (fileInput) fileInput.addEventListener('change', () => { uploadImageFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => photosDropzone.addEventListener(ev, (e) => { e.preventDefault(); photosDropzone.classList.add('dragover'); }));
  ['dragleave', 'dragend', 'drop'].forEach((ev) => photosDropzone.addEventListener(ev, (e) => { e.preventDefault(); photosDropzone.classList.remove('dragover'); }));
  photosDropzone.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) uploadImageFiles(e.dataTransfer.files); });
}
// Paste an image anywhere on the Images page → create a link.
document.addEventListener('paste', (e) => {
  const page = $('images-page');
  if (!page || page.classList.contains('hidden')) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack text fields
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) { if (it.kind === 'file' && it.type.indexOf('image/') === 0) { const f = it.getAsFile(); if (f) files.push(f); } }
  if (files.length) { e.preventDefault(); uploadImageFiles(files); }
});

// --- Feature 9: multi-select + bulk actions (revoke / set expiry) ---
function updatePhotoBulkBar() {
  const bar = $('photos-bulk-bar');
  if (!bar) return;
  const n = state.photoSelection.size;
  bar.classList.toggle('hidden', n === 0);
  const cnt = $('photos-bulk-count');
  if (cnt) cnt.textContent = t('photo.selectedN', { n });
  const favorite = $('photos-bulk-favorite');
  if (favorite) {
    const photos = Array.isArray(state.photosData) ? state.photosData : [];
    const selected = photos.filter((photo) => state.photoSelection.has(photo.id));
    const allFavorites = n > 0 && selected.length === n && selected.every((photo) => !!photo.favorite);
    const action = allFavorites ? 'unfavorite' : 'favorite';
    const key = allFavorites ? 'photo.bulkUnfavorite' : 'photo.bulkFavorite';
    favorite.dataset.action = action;
    favorite.setAttribute('data-i18n', key);
    favorite.setAttribute('aria-pressed', allFavorites ? 'true' : 'false');
    favorite.textContent = t(key);
  }
}
async function photoBulk(action, extra) {
  const ids = [...state.photoSelection];
  if (!ids.length) return;
  try {
    const r = await api('POST', '/api/shares/bulk', Object.assign({ ids, action }, extra || {}));
    toast(t('sh.bulkDone', { n: (r && r.count) || 0 }), 'ok');
    state.photoSelection.clear();
    updatePhotoBulkBar();
    refreshShares();
  } catch (e) { toast(t('sh.bulkFail'), 'err'); }
}
if ($('photos-bulk-revoke')) $('photos-bulk-revoke').addEventListener('click', () => {
  const n = state.photoSelection.size;
  if (n && confirm(t('sh.bulkRevokeConfirm', { n }))) photoBulk('revoke');
});
if ($('photos-bulk-expiry')) $('photos-bulk-expiry').addEventListener('change', (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (v !== '' && state.photoSelection.size) photoBulk('extend', { expiresInSeconds: parseInt(v, 10) });
});
if ($('photos-bulk-album-add')) $('photos-bulk-album-add').addEventListener('change', (e) => {
  const albumId = e.target.value;
  e.target.value = '';
  if (albumId && state.photoSelection.size) photoBulk('album-add', { albumId });
});
if ($('photos-bulk-favorite')) $('photos-bulk-favorite').addEventListener('click', (e) => {
  photoBulk(e.currentTarget.dataset.action === 'unfavorite' ? 'unfavorite' : 'favorite');
});
if ($('photos-bulk-download')) $('photos-bulk-download').addEventListener('click', () => {
  const ids = [...state.photoSelection].slice(0, 100);
  if (ids.length) window.location.assign('/api/photos/download.zip?ids=' + encodeURIComponent(ids.join(',')));
});
if ($('photos-bulk-clear')) $('photos-bulk-clear').addEventListener('click', () => {
  state.photoSelection.clear();
  updatePhotoBulkBar();
  const list = $('photos-list');
  if (list) list.querySelectorAll('.photo-select input').forEach((cb) => { cb.checked = false; cb.closest('.photo-card').classList.remove('selected'); });
});
// Feature 18 — turn the current image selection into a shareable public gallery.
if ($('photos-bulk-album')) $('photos-bulk-album').addEventListener('click', async () => {
  const ids = [...state.photoSelection];
  if (!ids.length) return;
  const name = prompt(t('album.namePrompt'));
  if (name === null) return; // cancelled
  try {
    await api('POST', '/api/photos/album', { ids, name: name || '' });
    state.photoSelection.clear();
    updatePhotoBulkBar();
    const list = $('photos-list');
    if (list) list.querySelectorAll('.photo-select input').forEach((cb) => { cb.checked = false; cb.closest('.photo-card').classList.remove('selected'); });
    toast(t('album.created'), 'ok');
    refreshShares();
  } catch (e) { toast(t('album.createFail'), 'err'); }
});

function updateSelectionUI() {
  const btn = $('create-share-btn');
  // Folder-chooser mode: the "selection" is simply the folder currently open.
  if (state.pickerMode === 'configDir') {
    $('selection-name').textContent = state.cwd || '/';
    btn.disabled = false;
    return;
  }
  const sel = state.selections;
  if (sel.length === 0) {
    $('selection-name').textContent = '—';
    btn.disabled = true;
  } else if (sel.length === 1) {
    $('selection-name').textContent = sel[0].name + t(sel[0].isDir ? 'pk.folderSuffix' : 'pk.fileSuffix');
    btn.disabled = false;
  } else {
    $('selection-name').textContent = t('pk.selectedN', { n: sel.length });
    btn.disabled = false;
  }
}

async function browse(pathStr, fallbackToRoot) {
  try {
    const data = await api('GET', '/api/browse?path=' + encodeURIComponent(pathStr || '/'));
    state.cwd = data.cwd || '/';
    $('root-label').textContent = data.cwd || '/';
    renderBreadcrumbs(data);
    renderBrowser(data);
    if (state.pickerMode === 'configDir') updateSelectionUI(); // reflect the current folder
  } catch (e) {
    if (e.message === 'not-authenticated') return;
    // A stale default folder shouldn't dead-end the picker: retry once at the root.
    if (fallbackToRoot && (pathStr || '/') !== '/') { browse('/', false); return; }
    toast(e.data && e.data.error === 'host-inaccessible' ? t('pk.hostInaccessible') : t('pk.navFail'), 'err');
  }
}

function renderBreadcrumbs(data) {
  const box = $('breadcrumbs');
  box.textContent = '';
  const rootLink = el('a', { text: '🖥 /' });
  rootLink.addEventListener('click', () => browse('/'));
  box.appendChild(rootLink);

  const cwd = data.cwd || '/';
  if (cwd !== '/') {
    let acc = '';
    cwd.split('/').filter(Boolean).forEach((p) => {
      acc = acc + '/' + p;
      const target = acc;
      box.appendChild(el('span', { class: 'crumb-sep', text: '/' }));
      const a = el('a', { text: p });
      a.addEventListener('click', () => browse(target));
      box.appendChild(a);
    });
  }
}

function renderBrowser(data) {
  const list = $('browser-list');
  list.textContent = '';

  if (data.parent !== null && data.parent !== undefined) {
    const up = el('div', { class: 'row' });
    up.appendChild(el('span', { class: 'ico', text: '⬆' }));
    up.appendChild(el('span', { class: 'name', text: t('pk.parent') }));
    up.addEventListener('click', () => browse(data.parent));
    list.appendChild(up);
  }

  if (!data.entries.length) {
    list.appendChild(el('div', { class: 'empty', text: t('pk.emptyFolder') }));
    return;
  }

  data.entries.forEach((entry) => {
    const row = el('div', { class: 'row' });
    row.appendChild(el('span', { class: 'ico', text: entry.isDir ? '📁' : '📄' }));
    row.appendChild(el('span', { class: 'name', text: entry.name }));

    if (entry.isDir) {
      row.appendChild(el('span', { class: 'open', text: t('pk.open') }));
    } else {
      row.appendChild(el('span', { class: 'size', text: formatBytes(entry.size) }));
      if (isPreviewableVideo(entry.name)) {
        const previewBtn = el('span', { class: 'preview', text: t('pk.preview') });
        previewBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openPreview(entry);
        });
        row.appendChild(previewBtn);
      }
    }

    // Reflect an already-picked item when returning to its folder (selection
    // persists across navigation, so you can gather items from several folders).
    if (state.pickerMode !== 'configDir' && state.selections.some((x) => x.path === entry.path)) {
      row.classList.add('selected');
    }

    row.addEventListener('click', (ev) => {
      if (entry.isDir && ev.target.classList.contains('open')) {
        browse(entry.path);
        return;
      }
      // Folder-chooser mode: rows only navigate (the current folder is the pick).
      if (state.pickerMode === 'configDir') {
        if (entry.isDir) browse(entry.path);
        return;
      }
      toggleItem(entry, row);
    });
    if (entry.isDir) row.addEventListener('dblclick', () => browse(entry.path));
    list.appendChild(row);
  });
}

// Multi-select: clicking a row toggles it in/out of state.selections.
function toggleItem(entry, row) {
  const i = state.selections.findIndex((x) => x.path === entry.path);
  if (i === -1) {
    state.selections.push({ path: entry.path, name: entry.name, isDir: entry.isDir });
    row.classList.add('selected');
  } else {
    state.selections.splice(i, 1);
    row.classList.remove('selected');
  }
  updateSelectionUI();
}

$('create-share-btn').addEventListener('click', async () => {
  // Folder chooser for the "default folder" config field: take the current folder.
  if (state.pickerMode === 'configDir') {
    if ($('cfg-default-dir')) $('cfg-default-dir').value = state.cwd || '';
    closePicker();
    return;
  }
  if (!state.selections.length) return;
  const paths = state.selections.map((x) => x.path);
  // Photos tab — create direct image links from the selected image files.
  if (state.pickerMode === 'photos') {
    await createPhotos(paths);
    return;
  }
  if (state.pickerMode === 'addTo') {
    try {
      await api('POST', '/api/shares/' + encodeURIComponent(state.addToShareId) + '/items', { paths });
      toast(t('sh.added'), 'ok');
      closePicker();
      refreshShares();
    } catch (e) {
      toast(t('sh.addFail', { error: (e.data && e.data.error) || e.message }), 'err');
    }
    return;
  }
  // Feature 13 — warn if a selected path is already shared by an active link.
  const dupes = (state.allShares || []).filter((sh) => sh.active && paths.includes(sh.hostPath)).map((sh) => sh.name);
  if (dupes.length && !confirm(t('sh.dupWarn', { names: dupes.slice(0, 5).join(', ') }))) return;
  const expiry = parseInt($('opt-expiry').value, 10) || 0;
  const maxdl = parseInt($('opt-maxdl').value, 10) || 0;
  const password = $('opt-password').value;
  // Password required by default (Configuration): block creation without one.
  if ($('opt-password').required && !password) {
    toast(t('cfg.pwRequired'), 'err');
    $('opt-password').focus();
    return;
  }
  const rateKBps = parseInt($('opt-rate').value, 10) || 0;
  const allowZip = $('opt-allowzip').checked;
  const noPreview = !$('opt-preview').checked;
  const burnAfterDownload = $('opt-burn').checked;
  const note = $('opt-note') ? $('opt-note').value : '';
  const startsAt = startsAtMs('opt-startsat');
  try {
    const resp = await api('POST', '/api/shares', {
      paths,
      expiresInSeconds: expiry,
      startsAt,
      maxDownloads: maxdl,
      maxVisitors: parseInt($('opt-maxvisitors').value, 10) || 0,
      password,
      rateKBps,
      allowZip,
      noPreview,
      burnAfterDownload,
      note,
    });
    toast(t('sh.created2'), 'ok');
    $('opt-maxdl').value = '';
    $('opt-maxvisitors').value = '';
    $('opt-password').value = '';
    $('opt-rate').value = '';
    $('opt-startsat').value = '';
    $('opt-allowzip').checked = true;
    $('opt-preview').checked = true;
    $('opt-burn').checked = false;
    if ($('opt-note')) $('opt-note').value = '';
    $('opt-password').required = false;
    closePicker();
    refreshShares();
    // Auto-open the QR code when the default is enabled (Configuration).
    if (state.settings && state.settings.defaultShowQr && resp && resp.share && resp.share.url) {
      openQr(resp.share);
    }
  } catch (e) {
    toast(t('sh.createFail', { error: (e.data && e.data.error) || e.message }), 'err');
  }
});

// ------------------------------------------------------------------
// Metadata (version / year) for the footer
// ------------------------------------------------------------------
async function loadMeta() {
  try {
    const r = await fetch('/api/meta', { credentials: 'same-origin' });
    const m = await r.json();
    state.meta = m; // kept for the About dialog (version, release date)
    document.querySelectorAll('.app-version').forEach((e) => {
      e.textContent = m.version ? 'v' + m.version : '';
    });
    document.querySelectorAll('.app-year').forEach((e) => {
      e.textContent = m.year || '';
    });
    const note = document.getElementById('update-notice');
    if (note) {
      if (m.update && m.update.available && m.update.latest) {
        note.textContent = t('update.available', { v: m.update.latest });
        if (m.update.url) note.href = m.update.url;
        note.classList.remove('hidden');
      } else {
        note.classList.add('hidden');
      }
    }
    // Login-page storage warning: reception / images folders still on the
    // container's ephemeral filesystem (default, un-mapped volume). The message
    // text itself is localized via data-i18n; here we only toggle visibility.
    const sw = document.getElementById('setup-warning');
    if (sw) {
      const inbox = !!(m.setup && m.setup.inboxUnconfigured);
      const images = !!(m.setup && m.setup.imagesUnconfigured);
      const inboxEl = document.getElementById('setup-warn-inbox');
      const imagesEl = document.getElementById('setup-warn-images');
      if (inboxEl) inboxEl.classList.toggle('hidden', !inbox);
      if (imagesEl) imagesEl.classList.toggle('hidden', !images);
      sw.classList.toggle('hidden', !(inbox || images));
    }
  } catch (_) {}
}

// ------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------
async function init() {
  await loadNetwork();
  startPolling();
  maybeOpenAdminSubpageFromUrl(); // reopen /images or /dashboards after sign-in/reload
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else if (isLoggedIn()) startPolling();
});

// Restore theme, filters, periods and view modes before the first render.
setTheme(getTheme());
applyUiPreferencesToControls();
// Apply the language + load the version, then check the session.
setLang(state.lang);
loadMeta();
setTimeout(loadMeta, 12000); // re-check so a freshly-started server surfaces an update

(async function bootstrap() {
  try {
    const s = await fetch('/api/session', { credentials: 'same-origin' });
    if (s.ok) {
      const data = await s.json();
      state.csrf = data.csrf;
      state.username = data.username;
      state.role = data.role;
      enterApp(data.mustChangePassword);
      return;
    }
  } catch (_) {}
  showLogin();
})();

// ==================================================================
// End-to-end encrypted shares & reception links (browser-side crypto)
// dxcrypto.js is loaded before app.js; nothing here sends a key/passphrase
// to the server. The server only ever receives opaque ciphertext.
// ==================================================================
(function () {
  var C = window.DXCrypto;
  var hasCrypto = !!(C && C.available);

  // Without a secure context (HTTPS/localhost) WebCrypto is unavailable, so the
  // encryption controls are hidden entirely rather than shown-but-broken.
  function hideEl(id) { var el = $(id); if (el) el.classList.add('hidden'); }
  if (!hasCrypto) {
    hideEl('new-enc-btn');
    hideEl('new-secret-btn');
    hideEl('ib-encrypt-row');
    hideEl('ib-enc-mode-row');
  }

  // ---- shared "encrypted link ready" result modal ----
  function showEncLink(name, url, note) {
    $('enclink-name').textContent = name || '';
    $('enclink-url').textContent = url;
    $('enclink-note').textContent = note || '';
    $('enclink-overlay').dataset.url = url;
    $('enclink-overlay').classList.remove('hidden');
  }
  function closeEncLink() { $('enclink-overlay').classList.add('hidden'); }
  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(
        function () { toast(t('sh.copied'), 'ok'); },
        function () { fallbackCopy(txt); });
    } else { fallbackCopy(txt); }
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(t('sh.copied'), 'ok'); }
    catch (_) { toast(t('sh.copyFail'), 'err'); }
    document.body.removeChild(ta);
  }
  if ($('enclink-close')) $('enclink-close').addEventListener('click', closeEncLink);
  if ($('enclink-done')) $('enclink-done').addEventListener('click', closeEncLink);
  if ($('enclink-copy')) $('enclink-copy').addEventListener('click', function () {
    copyText($('enclink-overlay').dataset.url || $('enclink-url').textContent);
  });
  if ($('enclink-overlay')) $('enclink-overlay').addEventListener('click', function (e) {
    if (e.target === $('enclink-overlay')) closeEncLink();
  });

  function withKey(url, rawKey) { return url + '#k=' + C.b64urlEncode(rawKey); }

  // ---------------- Encrypted download share ----------------
  function openEncModal() {
    $('enc-file').value = '';
    $('enc-label').value = '';
    $('enc-mode').value = 'key';
    $('enc-pass').value = '';
    $('enc-expiry').value = '0';
    $('enc-startsat').value = '';
    $('enc-maxdl').value = '';
    $('enc-pass-row').classList.add('hidden');
    $('enc-progwrap').classList.add('hidden');
    $('enc-prog').value = 0;
    $('enc-error').classList.add('hidden');
    if (!hasCrypto) { $('enc-file').disabled = true; $('enc-submit').disabled = true; encError(t('dec.noCrypto')); }
    else { $('enc-file').disabled = false; $('enc-submit').disabled = false; }
    $('enc-overlay').classList.remove('hidden');
    $('enc-file').focus();
  }
  function closeEncModal() { $('enc-overlay').classList.add('hidden'); }
  function encModeChanged() {
    $('enc-pass-row').classList.toggle('hidden', $('enc-mode').value !== 'pass');
  }
  function encError(msg) { var e = $('enc-error'); e.textContent = msg; e.classList.remove('hidden'); }

  if ($('new-enc-btn')) $('new-enc-btn').addEventListener('click', openEncModal);
  if ($('enc-close')) $('enc-close').addEventListener('click', closeEncModal);
  if ($('enc-cancel')) $('enc-cancel').addEventListener('click', closeEncModal);
  if ($('enc-mode')) $('enc-mode').addEventListener('change', encModeChanged);
  if ($('enc-overlay')) $('enc-overlay').addEventListener('click', function (e) {
    if (e.target === $('enc-overlay')) closeEncModal();
  });
  if ($('enc-file')) $('enc-file').addEventListener('change', function () {
    if (!$('enc-label').value && $('enc-file').files[0]) $('enc-label').value = $('enc-file').files[0].name;
  });

  if ($('enc-form')) $('enc-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('enc-error').classList.add('hidden');
    var file = $('enc-file').files[0];
    if (!file) { encError(t('enc.needFile')); return; }
    var mode = $('enc-mode').value === 'pass' ? 'pass' : 'key';
    var pass = $('enc-pass').value;
    if (mode === 'pass' && !pass) { encError(t('enc.needPass')); return; }
    var label = ($('enc-label').value || file.name || 'Encrypted file').slice(0, 200);
    var expiry = parseInt($('enc-expiry').value, 10) || 0;
    var maxdl = parseInt($('enc-maxdl').value, 10) || 0;
    var startsAt = startsAtMs('enc-startsat');

    var submit = $('enc-submit');
    submit.disabled = true;
    $('enc-progwrap').classList.remove('hidden');
    $('enc-progtext').textContent = t('enc.encrypting');
    $('enc-prog').value = 0;

    var rawKey = null, salt = null, keyPromise;
    if (mode === 'pass') { salt = C.randomSalt(); keyPromise = C.deriveKey(pass, salt); }
    else { rawKey = C.genRawKey(); keyPromise = C.importRawKey(rawKey); }

    keyPromise.then(function (key) {
      return C.encryptFile(file, mode, {
        key: key, salt: salt,
        onProgress: function (f) { $('enc-prog').value = Math.max(0, Math.min(1, f)); },
      });
    }).then(function (blob) {
      $('enc-progtext').textContent = t('enc.uploading');
      var qs = '?mode=' + mode +
        '&label=' + encodeURIComponent(label) +
        '&expiresInSeconds=' + expiry +
        '&startsAt=' + startsAt +
        '&maxDownloads=' + maxdl;
      var headers = { 'Content-Type': 'application/octet-stream' };
      if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
      return fetch('/api/enc-share' + qs, {
        method: 'POST', credentials: 'same-origin', headers: headers, body: blob,
      });
    }).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error('auth'); }
      if (!res.ok) throw new Error('http');
      return res.json();
    }).then(function (data) {
      var url = data.share.url;
      var full = (mode === 'key') ? withKey(url, rawKey) : url;
      submit.disabled = false;
      closeEncModal();
      toast(t('enc.created'), 'ok');
      refreshShares();
      showEncLink(label, full, mode === 'key' ? t('enc.noteKey') : t('enc.notePass'));
    }).catch(function () {
      submit.disabled = false;
      $('enc-progwrap').classList.add('hidden');
      encError(t('enc.createFail'));
    });
  });

  // ---------------- Burn-after-read secret note (feature 5) ----------------
  function openSecretModal() {
    if (!hasCrypto) { toast(t('enc.createFail'), 'err'); return; }
    $('secret-text').value = '';
    $('secret-mode').value = 'key';
    $('secret-expiry').value = '0';
    $('secret-pass-in').value = '';
    $('secret-pass-row').classList.add('hidden');
    $('secret-error').classList.add('hidden');
    $('secret-overlay').classList.remove('hidden');
    $('secret-text').focus();
  }
  function closeSecretModal() { $('secret-overlay').classList.add('hidden'); }
  function secretError(msg) { var e = $('secret-error'); e.textContent = msg; e.classList.remove('hidden'); }
  if ($('new-secret-btn')) $('new-secret-btn').addEventListener('click', openSecretModal);
  if ($('secret-close')) $('secret-close').addEventListener('click', closeSecretModal);
  if ($('secret-cancel')) $('secret-cancel').addEventListener('click', closeSecretModal);
  if ($('secret-overlay')) $('secret-overlay').addEventListener('click', function (e) {
    if (e.target === $('secret-overlay')) closeSecretModal();
  });
  if ($('secret-mode')) $('secret-mode').addEventListener('change', function () {
    $('secret-pass-row').classList.toggle('hidden', $('secret-mode').value !== 'pass');
  });
  if ($('secret-form')) $('secret-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = $('secret-text').value;
    if (!text) { secretError(t('secret.needText')); return; }
    var mode = $('secret-mode').value === 'pass' ? 'pass' : 'key';
    var pass = $('secret-pass-in').value;
    if (mode === 'pass' && !pass) { secretError(t('enc.needPass')); return; }
    var expiry = parseInt($('secret-expiry').value, 10) || 0;
    var submit = $('secret-submit');
    submit.disabled = true;
    // Encrypt the text as a DXE container (reusing the file crypto) in-browser.
    var blob = new Blob([text], { type: 'text/plain' });
    var file = new File([blob], 'secret.txt', { type: 'text/plain' });
    var rawKey = null, salt = null, keyPromise;
    if (mode === 'pass') { salt = C.randomSalt(); keyPromise = C.deriveKey(pass, salt); }
    else { rawKey = C.genRawKey(); keyPromise = C.importRawKey(rawKey); }
    keyPromise.then(function (key) {
      return C.encryptFile(file, mode, { key: key, salt: salt });
    }).then(function (ct) {
      var headers = { 'Content-Type': 'application/octet-stream' };
      if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
      return fetch('/api/secret?mode=' + mode + '&expiresInSeconds=' + expiry, {
        method: 'POST', credentials: 'same-origin', headers: headers, body: ct,
      });
    }).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error('auth'); }
      if (!res.ok) throw new Error('http');
      return res.json();
    }).then(function (data) {
      var url = data.url || (location.origin + data.path);
      var full = (mode === 'key') ? withKey(url, rawKey) : url;
      submit.disabled = false;
      closeSecretModal();
      toast(t('secret.created'), 'ok');
      showEncLink(t('secret.title'), full, mode === 'key' ? t('secret.noteKey') : t('secret.notePass'));
    }).catch(function () {
      submit.disabled = false;
      secretError(t('secret.createFail'));
    });
  });

  // ---------------- Encrypted reception link ----------------
  function inboxEncChanged() {
    var on = $('ib-encrypt') && $('ib-encrypt').checked;
    if ($('ib-enc-mode-row')) $('ib-enc-mode-row').classList.toggle('hidden', !on);
  }
  if ($('ib-encrypt')) $('ib-encrypt').addEventListener('change', inboxEncChanged);

  // Hook called by the inbox-form submit handler.
  window.DXInboxEnc = {
    // Returns { payloadExtra, finalize(url,name) } when encrypting, else null.
    plan: function () {
      if (!$('ib-encrypt') || !$('ib-encrypt').checked) return null;
      if (!hasCrypto) { toast(t('enc.createFail'), 'err'); return null; }
      var mode = ($('ib-enc-mode') && $('ib-enc-mode').value === 'pass') ? 'pass' : 'key';
      var rawKey = mode === 'key' ? C.genRawKey() : null;
      return {
        payloadExtra: { encrypted: true, encMode: mode },
        finalize: function (shareUrl, name) {
          var full = mode === 'key' ? withKey(shareUrl, rawKey) : shareUrl;
          showEncLink(name, full, mode === 'key' ? t('enc.inboxLinkNote') : t('enc.notePass'));
        },
      };
    },
    reset: function () {
      if ($('ib-encrypt')) $('ib-encrypt').checked = false;
      if ($('ib-enc-mode')) $('ib-enc-mode').value = 'key';
      inboxEncChanged();
    },
  };

})();

// ==================================================================
// Decrypt a received .dxe file (browser-side, in the user menu)
// The ciphertext is read locally; the key/passphrase never leaves the page.
// ==================================================================
(function () {
  var C = window.DXCrypto;
  var hasCrypto = !!(C && C.available);
  var decFile = null;  // the selected .dxe File (a Blob, read in chunks — not fully loaded)
  var decMode = null;  // 'key' | 'pass'

  // No secure context → no WebCrypto → hide the "Decrypt a .dxe file" menu item.
  if (!hasCrypto) { var db = $('decrypt-btn'); if (db) db.classList.add('hidden'); }

  function decErr(msg) { var e = $('dec-error'); e.textContent = msg || ''; if (msg) e.classList.remove('hidden'); else e.classList.add('hidden'); }
  function openDecModal() {
    decFile = null; decMode = null;
    $('dec-file').value = '';
    $('dec-key').value = '';
    $('dec-pass').value = '';
    $('dec-key-row').classList.add('hidden');
    $('dec-pass-row').classList.add('hidden');
    $('dec-progwrap').classList.add('hidden');
    $('dec-prog').value = 0;
    $('dec-submit').disabled = true;
    decErr('');
    if (!hasCrypto) { $('dec-file').disabled = true; decErr(t('dec.noCrypto')); }
    else { $('dec-file').disabled = false; }
    $('dec-overlay').classList.remove('hidden');
  }
  function closeDecModal() { $('dec-overlay').classList.add('hidden'); }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name || 'decrypted';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  // Accepts a raw key or a link/text containing "#k=" / "&k=".
  function keyFromInput(v) {
    v = String(v || '').trim();
    var m = /[#&]k=([A-Za-z0-9\-_]+)/.exec(v);
    return m ? m[1] : v;
  }

  if ($('decrypt-btn')) $('decrypt-btn').addEventListener('click', function () {
    closeUserMenu();
    openDecModal();
  });
  if ($('dec-close')) $('dec-close').addEventListener('click', closeDecModal);
  if ($('dec-cancel')) $('dec-cancel').addEventListener('click', closeDecModal);
  if ($('dec-overlay')) $('dec-overlay').addEventListener('click', function (e) {
    if (e.target === $('dec-overlay')) closeDecModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && $('dec-overlay') && !$('dec-overlay').classList.contains('hidden')) closeDecModal();
  });

  // On file pick: read it and inspect the container to know which secret to ask.
  if ($('dec-file')) $('dec-file').addEventListener('change', function () {
    if (!hasCrypto) return;
    decErr('');
    decFile = null; decMode = null;
    $('dec-key-row').classList.add('hidden');
    $('dec-pass-row').classList.add('hidden');
    $('dec-submit').disabled = true;
    var f = $('dec-file').files[0];
    if (!f) return;
    // Read only the header (first bytes) to detect the mode — not the whole file.
    f.slice(0, 128).arrayBuffer().then(function (buf) {
      var info = C.inspect(buf); // throws on bad magic
      decFile = f;
      decMode = info.mode;
      if (decMode === 'pass') { $('dec-pass-row').classList.remove('hidden'); $('dec-pass').focus(); }
      else { $('dec-key-row').classList.remove('hidden'); $('dec-key').focus(); }
      $('dec-submit').disabled = false;
    }).catch(function () { decErr(t('dec.notDxe')); });
  });

  function getKey(mode, salt) {
    if (mode === 'pass') {
      var p = $('dec-pass').value;
      if (!p) return Promise.reject(new Error('nopass'));
      return C.deriveKey(p, salt);
    }
    var k = keyFromInput($('dec-key').value);
    if (!k) return Promise.reject(new Error('nokey'));
    return C.importRawKey(C.b64urlDecode(k));
  }

  if ($('dec-form')) $('dec-form').addEventListener('submit', function (e) {
    e.preventDefault();
    decErr('');
    if (!decFile) { decErr(t('dec.notDxe')); return; }
    if (decMode === 'pass' && !$('dec-pass').value) { decErr(t('dec.needPass')); return; }
    if (decMode === 'key' && !keyFromInput($('dec-key').value)) { decErr(t('dec.needKey')); return; }

    var submit = $('dec-submit');
    submit.disabled = true;
    $('dec-progwrap').classList.remove('hidden');
    $('dec-progtext').textContent = t('dec.decrypting');
    $('dec-prog').value = 0;

    C.decrypt(decFile, getKey, function (frac) {
      $('dec-prog').value = Math.max(0, Math.min(1, frac));
    }).then(function (res) {
      saveBlob(res.blob, res.name);
      submit.disabled = false;
      closeDecModal();
      toast(t('dec.done'), 'ok');
    }).catch(function (err) {
      submit.disabled = false;
      $('dec-progwrap').classList.add('hidden');
      if (err && err.message === 'nopass') { decErr(t('dec.needPass')); return; }
      if (err && err.message === 'nokey') { decErr(t('dec.needKey')); return; }
      decErr(t('dec.badKey')); // wrong key/passphrase or corrupted container
    });
  });
})();

// ==================================================================
// Admin accounts (owner only) + audit log
// ==================================================================
(function () {
  // ---------------- Accounts ----------------
  function accErr(msg) { const e = $('accounts-error'); e.textContent = msg || ''; e.classList.toggle('hidden', !msg); }
  function closeAccounts() { $('accounts-overlay').classList.add('hidden'); }

  async function openAccounts() {
    closeUserMenu();
    $('acc-username').value = '';
    $('acc-password').value = '';
    accErr('');
    $('accounts-overlay').classList.remove('hidden');
    await refreshAccounts();
  }

  async function refreshAccounts() {
    try {
      const data = await api('GET', '/api/accounts');
      renderAccounts(data.accounts || [], data.self);
    } catch (e) {
      if (e.message !== 'not-authenticated') accErr(t('acc.loadFail'));
    }
  }

  function renderAccounts(accounts, selfId) {
    const box = $('accounts-list');
    box.textContent = '';
    accounts.forEach((a) => {
      const row = el('div', { class: 'acc-row' });
      const info = el('div', { class: 'acc-info' });
      const nameLine = el('div', { class: 'acc-name' });
      nameLine.appendChild(el('strong', { text: a.username }));
      nameLine.appendChild(el('span', { class: 'acc-badge ' + a.role, text: t('acc.role.' + a.role) }));
      if (a.twoFactor) nameLine.appendChild(el('span', { class: 'acc-badge tf', text: t('acc.tfOn') }));
      if (a.id === selfId) nameLine.appendChild(el('span', { class: 'acc-badge self', text: t('acc.you') }));
      info.appendChild(nameLine);
      const meta = [];
      if (a.lastLoginAt) meta.push(t('acc.lastLogin', { v: timeAgo(a.lastLoginAt) }));
      if (a.createdBy) meta.push(t('acc.createdBy', { v: a.createdBy }));
      if (a.isEnvManaged) meta.push(t('acc.envManaged'));
      info.appendChild(el('div', { class: 'acc-meta', text: meta.join(' · ') }));
      row.appendChild(info);

      const actions = el('div', { class: 'acc-actions' });
      // Any non-env account can be renamed (owner included) and have its password reset.
      if (!a.isEnvManaged) {
        const rename = el('button', { class: 'btn ghost sm', text: t('acc.rename') });
        rename.addEventListener('click', () => renameAccount(a, a.id === selfId));
        actions.appendChild(rename);
        const reset = el('button', { class: 'btn ghost sm', text: t('acc.reset') });
        reset.addEventListener('click', () => resetAccount(a));
        actions.appendChild(reset);
      }
      if (a.role !== 'owner' && a.id !== selfId) {
        const del = el('button', { class: 'btn ghost sm danger', text: t('acc.delete') });
        del.addEventListener('click', () => deleteAccount(a));
        actions.appendChild(del);
      }
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  async function renameAccount(a, isSelf) {
    const name = prompt(t('acc.renamePrompt', { u: a.username }), a.username);
    if (name == null) return;
    const username = String(name).trim().toLowerCase();
    if (username === a.username) return;
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) { accErr(t('acc.badUsername')); return; }
    try {
      await api('POST', '/api/accounts/' + encodeURIComponent(a.id) + '/username', { username });
      accErr('');
      toast(t('acc.renamed'), 'ok');
      if (isSelf) {
        // Renamed the signed-in account: refresh the menu label + login prefill.
        state.username = username;
        document.querySelectorAll('.current-username').forEach((e) => { e.textContent = username; });
        try { localStorage.setItem('dxuser', username); } catch (_) {}
      }
      refreshAccounts();
    } catch (e2) {
      const code = e2.data && e2.data.error;
      accErr(code === 'username-taken' ? t('acc.taken') : code === 'invalid-username' ? t('acc.badUsername') : t('acc.actionFail'));
    }
  }

  async function deleteAccount(a) {
    if (!confirm(t('acc.confirmDelete', { u: a.username }))) return;
    try {
      await api('DELETE', '/api/accounts/' + encodeURIComponent(a.id));
      toast(t('acc.deleted'), 'ok');
      refreshAccounts();
    } catch (e) {
      if (e.message !== 'not-authenticated') accErr(t('acc.actionFail'));
    }
  }

  async function resetAccount(a) {
    const pw = prompt(t('acc.resetPrompt', { u: a.username }));
    if (pw == null) return;
    if (String(pw).length < 8) { accErr(t('acc.pwShort')); return; }
    try {
      await api('POST', '/api/accounts/' + encodeURIComponent(a.id) + '/password', { password: pw });
      toast(t('acc.resetDone'), 'ok');
      accErr('');
      refreshAccounts();
    } catch (e) {
      if (e.message !== 'not-authenticated') accErr(t('acc.actionFail'));
    }
  }

  if ($('accounts-btn')) $('accounts-btn').addEventListener('click', openAccounts);
  if ($('accounts-close')) $('accounts-close').addEventListener('click', closeAccounts);
  if ($('accounts-overlay')) $('accounts-overlay').addEventListener('click', (e) => {
    if (e.target === $('accounts-overlay')) closeAccounts();
  });

  if ($('account-form')) $('account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    accErr('');
    const username = $('acc-username').value.trim().toLowerCase();
    const password = $('acc-password').value;
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) { accErr(t('acc.badUsername')); return; }
    if (password.length < 8) { accErr(t('acc.pwShort')); return; }
    const role = $('acc-role') ? $('acc-role').value : 'admin';
    try {
      await api('POST', '/api/accounts', { username, password, role });
      $('acc-username').value = '';
      $('acc-password').value = '';
      if ($('acc-role')) $('acc-role').value = 'admin';
      toast(t('acc.created'), 'ok');
      refreshAccounts();
    } catch (e2) {
      const code = e2.data && e2.data.error;
      accErr(code === 'username-taken' ? t('acc.taken') : code === 'invalid-username' ? t('acc.badUsername') : code === 'too-short' ? t('acc.pwShort') : t('acc.actionFail'));
    }
  });

  // ---------------- Audit log ----------------
  function closeAudit() { $('audit-overlay').classList.add('hidden'); }
  async function openAudit() {
    closeUserMenu();
    $('audit-list').textContent = '';
    $('audit-overlay').classList.remove('hidden');
    try {
      const data = await api('GET', '/api/audit?limit=200');
      renderAudit(data.entries || []);
    } catch (e) {
      if (e.message !== 'not-authenticated') $('audit-list').appendChild(el('div', { class: 'empty', text: t('audit.loadFail') }));
    }
  }

  function actionLabel(action) {
    const key = 'auditA.' + action;
    const v = t(key);
    return v === key ? action : v; // fall back to the raw action code
  }

  function renderAudit(entries) {
    const box = $('audit-list');
    box.textContent = '';
    if (!entries.length) { box.appendChild(el('div', { class: 'empty', text: t('audit.none') })); return; }
    entries.forEach((e2) => {
      const row = el('div', { class: 'audit-row' });
      row.appendChild(el('span', { class: 'audit-act', text: actionLabel(e2.action) }));
      const mid = el('div', { class: 'audit-mid' });
      const who = el('div', { class: 'audit-who' });
      who.appendChild(el('span', { class: 'audit-actor', text: e2.actor || '—' }));
      if (e2.detail) who.appendChild(el('span', { class: 'audit-detail', text: e2.detail }));
      mid.appendChild(who);
      mid.appendChild(el('div', { class: 'audit-meta', text: (e2.ip ? e2.ip + ' · ' : '') + formatDate(e2.at) }));
      row.appendChild(mid);
      box.appendChild(row);
    });
  }

  if ($('audit-btn')) $('audit-btn').addEventListener('click', openAudit);
  if ($('audit-close')) $('audit-close').addEventListener('click', closeAudit);
  if ($('audit-overlay')) $('audit-overlay').addEventListener('click', (e) => {
    if (e.target === $('audit-overlay')) closeAudit();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('accounts-overlay') && !$('accounts-overlay').classList.contains('hidden')) closeAccounts();
    if ($('audit-overlay') && !$('audit-overlay').classList.contains('hidden')) closeAudit();
  });
})();

// ------------------------------------------------------------------
// Nominative sub-links (recipients): one token per person for a share.
// ------------------------------------------------------------------
// --- Edit an existing link (feature 3) ---
let editShareId = null;
function openEditModal(s) {
  editShareId = s.id;
  $('edit-name-label').textContent = s.name;
  $('edit-name').value = s.name || '';
  $('edit-expiry').value = 'keep'; // default: don't touch the expiry
  $('edit-startsat').value = s.startsAt ? toLocalDatetime(new Date(s.startsAt)) : '';
  $('edit-maxdl').value = s.maxDownloads ? String(s.maxDownloads) : '';
  $('edit-maxvisitors').value = s.maxVisitors ? String(s.maxVisitors) : '';
  $('edit-password').value = '';
  $('edit-password').placeholder = s.hasPassword ? t('ed.pwSet') : t('ed.pwPh');
  $('edit-clearpw').checked = false;
  $('edit-clearpw').parentElement.classList.toggle('hidden', !s.hasPassword); // only when one exists
  $('edit-rate').value = s.rateKBps ? String(s.rateKBps) : '';
  $('edit-allowzip').checked = s.allowZip !== false;
  $('edit-preview').checked = !s.noPreview;
  $('edit-burn').checked = !!s.burnAfterDownload;
  // Access rules (feature 11)
  $('edit-geomode').value = s.geoMode || 'off';
  $('edit-geocountries').value = Array.isArray(s.geoCountries) ? s.geoCountries.join(', ') : '';
  $('edit-ipmode').value = s.ipMode || 'off';
  $('edit-iplist').value = Array.isArray(s.ipList) ? s.ipList.join(', ') : '';
  if ($('edit-note')) $('edit-note').value = s.note || '';
  $('edit-error').classList.add('hidden');
  $('edit-overlay').classList.remove('hidden');
}
function closeEditModal() { $('edit-overlay').classList.add('hidden'); editShareId = null; }
if ($('edit-close')) $('edit-close').addEventListener('click', closeEditModal);
if ($('edit-cancel')) $('edit-cancel').addEventListener('click', closeEditModal);
if ($('edit-overlay')) $('edit-overlay').addEventListener('click', (e) => {
  if (e.target === $('edit-overlay')) closeEditModal();
});
if ($('edit-save')) $('edit-save').addEventListener('click', async () => {
  if (!editShareId) return;
  const payload = {
    name: $('edit-name').value,
    maxDownloads: parseInt($('edit-maxdl').value, 10) || 0,
    maxVisitors: parseInt($('edit-maxvisitors').value, 10) || 0,
    rateKBps: parseInt($('edit-rate').value, 10) || 0,
    allowZip: $('edit-allowzip').checked,
    noPreview: !$('edit-preview').checked,
    burnAfterDownload: $('edit-burn').checked,
    note: $('edit-note') ? $('edit-note').value : '',
    startsAt: startsAtMs('edit-startsat'),
    geoMode: $('edit-geomode').value,
    geoCountries: $('edit-geocountries').value,
    ipMode: $('edit-ipmode').value,
    ipList: $('edit-iplist').value,
  };
  // Expiry: 'keep' leaves it untouched; any other value re-sets it (0 = never).
  const exp = $('edit-expiry').value;
  if (exp !== 'keep') payload.expiresInSeconds = parseInt(exp, 10) || 0;
  // Password: "remove" wins; else a typed value sets/replaces; blank = keep.
  if ($('edit-clearpw').checked) payload.password = ''; // server treats '' as clear
  else { const pw = $('edit-password').value; if (pw !== '') payload.password = pw; }
  try {
    const r = await api('PATCH', '/api/shares/' + encodeURIComponent(editShareId), payload);
    toast(t('ed.saved'), 'ok');
    closeEditModal();
    refreshShares();
    return r;
  } catch (e) {
    const err = $('edit-error');
    err.textContent = t('ed.saveFail', { error: (e.data && e.data.error) || e.message });
    err.classList.remove('hidden');
  }
});

function recipientsSection(s) {
  if (s.type === 'inbox' || s.type === 'collab') return null;
  const list = Array.isArray(s.recipients) ? s.recipients : [];
  const box = el('div', { class: 'recipients' });
  box.appendChild(el('div', { class: 'sl-label', text: t('rcp.label', { n: list.length }) }));

  list.forEach((r) => {
    const row = el('div', { class: 'rcp-row' });
    row.appendChild(el('span', { class: 'rcp-name', text: r.name }));
    // Read receipt: viewed / downloaded status (feature 4).
    if (r.downloads > 0) {
      row.appendChild(el('span', { class: 'badge ok-badge rcp-status', text: t('rcp.downloaded') }));
    } else if (r.viewed) {
      row.appendChild(el('span', { class: 'badge rcp-status seen', text: t('rcp.viewed') }));
    } else {
      row.appendChild(el('span', { class: 'badge rcp-status pending', text: t('rcp.notSeen') }));
    }
    row.appendChild(el('span', { class: 'rcp-count', text: t('rcp.dl', { n: r.downloads || 0 }) }));
    const when = r.lastDownloadAt || r.lastViewAt;
    if (when) {
      const whereBits = [];
      if (r.lastViewCountry) whereBits.push(r.lastViewCountry);
      if (r.lastViewIp) whereBits.push(r.lastViewIp);
      row.appendChild(el('span', {
        class: 'rcp-when muted sm',
        text: timeAgo(when) + (whereBits.length ? ' · ' + whereBits.join(' · ') : ''),
      }));
    }
    row.appendChild(el('div', { class: 'link-box rcp-link', text: r.url || r.path }));
    const copyBtn = el('button', { class: 'btn ghost xs', text: t('sh.copy') });
    copyBtn.addEventListener('click', () => copy(r.url || r.path));
    row.appendChild(copyBtn);
    if (r.url) {
      const qrBtn = el('button', { class: 'btn ghost xs', text: t('sh.qr'), attrs: { title: t('sh.qrTitle') } });
      qrBtn.addEventListener('click', () => openQr({ name: s.name + ' \u2014 ' + r.name, url: r.url }));
      row.appendChild(qrBtn);
    }
    // Per-recipient overrides (feature 16): own expiry / download cap.
    const lim = [];
    if (r.maxDownloads) lim.push('\u2b07 ' + (r.downloads || 0) + '/' + r.maxDownloads);
    if (r.expiresAt) lim.push('\u23f3 ' + formatDate(r.expiresAt));
    if (lim.length) row.appendChild(el('span', { class: 'rcp-lim muted sm', text: lim.join(' \u00b7 ') }));
    const limBtn = el('button', { class: 'btn ghost xs', text: '\u2699', attrs: { title: t('rcp.limitsTitle') } });
    limBtn.addEventListener('click', () => editRecipientLimits(s, r));
    row.appendChild(limBtn);
    const del = el('button', { class: 'btn danger xs', text: '\u2715', attrs: { title: t('rcp.remove') } });
    del.addEventListener('click', () => removeRecipient(s, r));
    row.appendChild(del);
    box.appendChild(row);
  });

  const add = el('div', { class: 'rcp-add' });
  const input = el('input', { class: 'rcp-input', attrs: { type: 'text', placeholder: t('rcp.addPh'), maxlength: '100' } });
  const addBtn = el('button', { class: 'btn ghost sm', text: t('rcp.add') });
  const submit = () => { const v = input.value.trim(); if (v) addRecipients(s, v); };
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  add.appendChild(input);
  add.appendChild(addBtn);
  box.appendChild(add);
  return box;
}

async function addRecipients(s, names) {
  try {
    await api('POST', '/api/shares/' + encodeURIComponent(s.id) + '/recipients', { names });
    toast(t('rcp.added'), 'ok');
    refreshShares();
  } catch (e) {
    toast((e.data && e.data.error === 'exists') ? t('rcp.exists') : t('rcp.addFail'), 'err');
  }
}

// Feature 16 — set a recipient's own download cap and/or expiry (0/blank = inherit).
async function editRecipientLimits(s, r) {
  const dl = prompt(t('rcp.maxDlPrompt', { name: r.name }), r.maxDownloads ? String(r.maxDownloads) : '');
  if (dl === null) return;
  const curDays = r.expiresAt ? String(Math.max(1, Math.ceil((r.expiresAt - Date.now()) / 86400000))) : '';
  const days = prompt(t('rcp.expiryPrompt', { name: r.name }), curDays);
  if (days === null) return;
  const n = parseInt(dl, 10), d = parseInt(days, 10);
  const body = {
    maxDownloads: Number.isFinite(n) && n > 0 ? n : 0,
    expiresInSeconds: Number.isFinite(d) && d > 0 ? d * 86400 : 0,
  };
  try {
    await api('PATCH', '/api/shares/' + encodeURIComponent(s.id) + '/recipients/' + encodeURIComponent(r.token), body);
    toast(t('rcp.limitsSaved'), 'ok');
    refreshShares();
  } catch (e) { toast(t('rcp.limitsFail'), 'err'); }
}

async function removeRecipient(s, r) {
  if (!confirm(t('rcp.removeConfirm', { name: r.name }))) return;
  try {
    await api('DELETE', '/api/shares/' + encodeURIComponent(s.id) + '/recipients/' + encodeURIComponent(r.token));
    toast(t('rcp.removed'), 'ok');
    refreshShares();
  } catch (e) {
    toast(t('rcp.removeFail'), 'err');
  }
}

// ------------------------------------------------------------------
// Client nicknames: name a visitor by IP; shown next to the IP in the
// live-transfers and history views (click the IP to set/edit).
// ------------------------------------------------------------------
function ipTag(ip, ipName) {
  const span = el('span', { class: 'tip ip-tag', attrs: { title: t('ipn.clickHint') } });
  if (!ip) { span.textContent = '—'; return span; }
  if (ipName) span.appendChild(el('span', { class: 'ipn-name', text: ipName }));
  span.appendChild(el('span', { class: 'ipn-ip', text: ip }));
  span.addEventListener('click', () => renameIp(ip, ipName));
  return span;
}

async function renameIp(ip, current) {
  if (!ip) return;
  const name = prompt(t('ipn.prompt', { ip }), current || '');
  if (name === null) return; // cancelled
  const trimmed = name.trim();
  try {
    await api('POST', '/api/ip-names', { ip, name: trimmed });
    toast(trimmed ? t('ipn.saved') : t('ipn.cleared'), 'ok');
    refreshShares(); // re-fetch: nicknames refresh across transfers + history
    if (state.dashboardData) loadDashboard(); // and the dashboard's top clients
  } catch (e) {
    toast(t('ipn.fail'), 'err');
  }
}
