'use strict';
/* Direct-Xfer — PWA compagnon durable.
 * - file d'attente IndexedDB + fichiers durables OPFS
 * - identifiants d'upload stables + reprise par morceaux
 * - pause/reprise, reconnexion automatique et parallélisme borné
 * - Web Share Target par lots, E2E DXE1, association d'appareil limitée à /app
 * - aucune dépendance ni service tiers
 */
(function () {
  // Build tag, shown in the footer so a user can confirm at a glance which version
  // is actually running after an update. Keep it in lock-step with sw.js VERSION.
  var APP_VERSION = '1.33.9';
  var APP_BUILD = '2026.08.07-pwa123';
  // Upload blocks are deliberately small on mobile. A number of reverse proxies
  // still default to a 1 MiB request-body limit; an 8 MiB first block can therefore
  // be rejected before the browser emits any useful progress event, which looks like
  // an upload frozen at 0 %. The client can shrink further after a 413/reset.
  var DESKTOP_CHUNK = 8 * 1024 * 1024;
  var MOBILE_CHUNK = 768 * 1024;
  var MIN_CHUNK = 256 * 1024;
  // Every upload's FIRST block is deliberately small, whatever the device. Many
  // reverse proxies (Cloudflare, Caddy, Traefik, nginx…) buffer or cap large
  // request bodies; an 8 MiB opening block can hang with no response, freezing the
  // transfer at 0 %. Starting small guarantees the first block clears the proxy,
  // then the chunk size ramps up toward the device ideal only after blocks succeed.
  var FIRST_CHUNK = 768 * 1024;
  var UPLOAD_TIMEOUT_MS = 4 * 60 * 1000;
  var OFFSET_TIMEOUT_MS = 15 * 1000;
  var MAX_RECOVERABLE_FAILURES = 8;
  var MOBILE_DURABLE_LIMIT = 32 * 1024 * 1024;
  var DESKTOP_DURABLE_LIMIT = 128 * 1024 * 1024;
  var PERSIST_DEBOUNCE_MS = 5000;
  var DB_NAME = 'direct-xfer-pwa';
  var DB_VERSION = 6;
  var QUEUE_STORE = 'queue';
  var DEST_STORE = 'destinations';
  var META_STORE = 'meta';
  var HISTORY_STORE = 'history';
  var IMAGE_STORE = 'images';
  var IMAGE_BACKUP_KEY = 'dx-pwa-images-backup-v1';
  var DEST_BACKUP_KEY = 'dx-pwa-dests-backup-v1';
  var QUEUE_BACKUP_KEY = 'dx-pwa-queue-backup-v1';
  var MAX_IMAGE_BACKUP = 500;
  var MAX_HISTORY = 50;
  var OPFS_QUEUE_DIR = 'durable-transfers-v1';
  var OPFS_COPY_CHUNK = 4 * 1024 * 1024;
  var launchParams = new URLSearchParams(location.search);
  var launchAction = launchParams.get('action') || '';
  var pairedClaim = launchParams.get('paired') === '1';
  var $ = function (id) { return document.getElementById(id); };

  var STRINGS = {
    fr: {
      title: 'Envoyer', navMain: 'Navigation principale', navSend: 'Envoyer', navSendHint: 'Préparer et envoyer des fichiers vers une destination.', navImages: 'Images', navImagesHint: 'Créer, gérer et suivre vos liens d’image.', navActivity: 'Activité', navActivityHint: 'Consulter l’historique local des transferts.', navSettings: 'Réglages', navSettingsHint: 'Configurer la PWA, la sécurité et le stockage.', navShares: 'Partages', navSharesHint: 'Créer des liens de partage depuis les fichiers du serveur.', sharesTitle: 'Partager des fichiers du serveur', sharesHint: 'Parcourez les fichiers de votre serveur et créez des liens de partage directs.', sharesAdminRequired: 'Connectez-vous avec un compte administrateur pour parcourir les fichiers du serveur.', sharesSignIn: 'Se connecter en administrateur', sharesBrowse: 'Fichiers du serveur', sharesUp: 'Dossier parent', sharesCreate: 'Créer le partage', sharesNoneSelected: 'Aucun fichier sélectionné.', sharesSelected: '{n} élément(s) sélectionné(s)', sharesExpiry: 'Expiration', sharesExpiryNever: 'Jamais', sharesExpiry1h: '1 heure', sharesExpiry1d: '1 jour', sharesExpiry7d: '7 jours', sharesExpiry30d: '30 jours', sharesMaxDownloads: 'Téléchargements max (0 = illimité)', sharesPassword: 'Mot de passe (facultatif)', sharesPasswordPlaceholder: '—', sharesCreateBtn: 'Créer le lien de partage', sharesCreating: 'Création…', sharesCreated: 'Partage créé ✓', sharesCreateFail: 'Échec de la création du partage', sharesLibrary: 'Vos partages', sharesEmpty: 'Aucun partage pour l’instant.', sharesBrowseFail: 'Impossible de lire ce dossier.', sharesLoginNeeded: 'Connexion administrateur requise.', sharesOpen: 'Ouvrir', sharesCopy: 'Copier', sharesRevoke: 'Révoquer', sharesRevoked: 'Partage révoqué ✓', sharesRevokeFail: 'Échec de la révocation', sharesRevokeConfirm: 'Révoquer ce partage ? Le lien cessera de fonctionner.', sharesItems: '{n} élément(s)', sharesReceptions: 'Liens de réception', sharesReceptionsEmpty: 'Aucun lien de réception.', sharesReceived: '{bytes} reçus', openAdmin: "Ouvrir l'administration", language: 'Langue', theme: 'Thème', copyLink: 'Copier le lien', pasteLink: 'Coller un lien', editDestination: 'Modifier la destination', addDestination: 'Ajouter une destination', passwordPlaceholder: 'Mot de passe du lien', destinationPlaceholder: 'Lien ou jeton de réception', destinationNamePlaceholder: 'Nom facultatif de la destination', senderPlaceholder: 'Nom demandé par ce lien', globalProgress: 'Progression globale', keyPlaceholder: 'Clé de chiffrement du lien', titlePlaceholder: 'Contenu partagé', pairedBadge: 'Appareil associé', themeDark: 'Sombre', themeLight: 'Clair', themeAuto: 'Auto', install: 'Installer', installIosHint: 'Pour installer Direct-Xfer : touchez le bouton Partager du navigateur, puis « Sur l’écran d’accueil ».', installBrowserHint: 'Chrome n’a pas encore validé l’installation complète. Ne choisissez pas un simple raccourci : utilisez une adresse HTTPS avec certificat reconnu, touchez la page et gardez-la ouverte quelques instants.', installHttpsRequired: 'Installation complète impossible depuis cette adresse HTTP ou ce certificat non reconnu. Android ne peut créer qu’un raccourci. Ouvrez Direct-Xfer en HTTPS avec un certificat valide.', installSecurePending: 'Installation en préparation. Dans Chrome, touchez la page et gardez-la ouverte environ 30 secondes. Si le logo n’apparaît pas, vérifiez que le certificat HTTPS est reconnu par Android.', installOpenHttps: 'Ouvrir en HTTPS',
      offline: 'Hors ligne — les envois reprendront à la reconnexion.', updateReady: 'Une nouvelle version est disponible.', updateNow: 'Actualiser', pullToRefresh: 'Glissez vers le bas pour actualiser', releaseToRefresh: 'Relâchez pour actualiser', refreshing: 'Actualisation…', backExit: 'Appuyez à nouveau pour quitter',
      destination: 'Destination', destinationHint: 'Un lien de réception Direct-Xfer de cette instance.', linkOrToken: 'Lien ou jeton', displayName: 'Nom affiché',
      rememberDestination: 'Mémoriser cette destination sur cet appareil', rememberKey: 'Mémoriser aussi la clé secrète sur cet appareil', scanQr: '📷 Scanner un QR', saveDestination: 'Ajouter', updateDestination: 'Enregistrer', createLinkTitle: 'Créer un lien de réception', newLink: 'Nouveau', createLinkName: 'Nom du nouveau lien', createLinkPlaceholder: 'Ex. Photos vacances', createLinkHint: 'Un nouveau lien de réception sera créé et ajouté à vos destinations. Partagez-le pour recevoir des fichiers.', createDo: 'Créer le lien', creating: 'Création…', createOk: 'Lien créé ✓', createFail: 'Création du lien impossible',
      imgLinksTitle: 'Liens d’image', imgLinksHint: 'Créez des liens directs vers vos images : chaque lien offre les versions Pleine, Mini et Micro, sans page relais.', imgLinksAdd: 'Ajouter des images', imgCreateTitle: 'Créer des liens', imgCreateHint: 'Choisissez vos images et le format qui sera proposé en priorité.', imgLibraryTitle: 'Vos liens', imgLibraryHint: 'Recherchez, triez et gérez les images déjà partagées.', imgGlobalActions: 'Actions globales', imgCopyActions: 'Copier un format', imgManageActions: 'Gérer le lien', imgStripExif: 'Retirer les données EXIF/GPS avant le partage', imgStripExifHint: 'Le nettoyage est effectué localement sur cet appareil avant le téléversement.', imgStrippingMetadata: 'Suppression des EXIF/GPS…', imgMetadataRemoved: 'EXIF/GPS retirés', imgUploading: 'Téléversement…', imgThumbing: 'Mini et Micro…', imgReady: 'Prêt', imgCopyFull: '🔗 Pleine grandeur', imgCopyThumb: '🔗 Mini', imgCopyMicro: '🔗 Micro', imgCopied: 'Lien copié ✓', imgLinkFail: 'Échec de la création du lien', revokeShare: 'Révoquer', revokeConfirm: 'Révoquer ce partage ? Le lien cessera de fonctionner.', revokeSuccess: 'Révoqué ✓', revokeFail: 'Échec de la révocation', imgVariantFull: 'Pleine', imgVariantMini: 'Mini', imgVariantMicro: 'Micro', imgViews: '{n} vues', imgVisitors: '{n} visiteurs', imgStatsLoading: 'Statistiques…', imgStatsUnavailable: 'Statistiques indisponibles',
      imgSearch: 'Rechercher une image…', imgSortLabel: 'Trier les images', imgSortNewest: 'Plus récentes', imgSortOldest: 'Plus anciennes', imgSortName: 'Nom', imgSortSize: 'Taille', imgSortViews: 'Vues', imgSortVisitors: 'Visiteurs', imgSortExpiry: 'Expiration', imgFilterLabel: 'Filtrer les images', imgFilterAll: 'Toutes', imgFilterActive: 'Actives', imgFilterPopular: 'Populaires', imgFilterLarge: 'Volumineuses', imgFilterExpiring: 'Bientôt expirées', imgFilterFavorite: 'Favorites', imgFilterProtected: 'Protégées', imgDefaultVariantLabel: 'Format d’image favori', imgAdvancedOptions: 'Options des images', imgCompact: 'Affichage compact', imgHideExpired: 'Masquer les images expirées', imgAutoCopy: 'Copier automatiquement après création', imgDefaultExpiry: 'Expiration favorite', imgMaxViews: 'Limite de vues', imgPassword: 'Mot de passe', imgTags: 'Tags', imgPrivateNote: 'Note privée', imgRenameTemplate: 'Modèle de renommage', imgBulkEdit: 'Modifier', imgCreateAlbum: 'Créer un album', imgDashboard: 'Statistiques graphiques', imgAlbums: 'Albums partageables', imgActionHistory: 'Historique des actions d’image', imgSelected: '{n} sélectionnée(s)', imgEditPrompt: 'Modifier les images sélectionnées', imgAlbumName: 'Nom de l’album', imgAlbumCreated: 'Album créé ✓', imgSettingsSaved: 'Réglages enregistrés ✓', imgDuplicateFound: 'Cette image a déjà été partagée. Continuer quand même ?', imgExpirySoon: 'Le lien « {name} » expire bientôt.', imgUndoRevoke: 'Image retirée — Annuler ?', imgRevokePending: 'Révocation dans quelques secondes…', imgQrDownloaded: 'QR téléchargé ✓', imgFavorite: 'Favorite', imgUnfavorite: 'Retirer des favorites', imgExpired: 'Expirée', imgInactive: 'Inactive', imgViewLimitReached: 'Limite de vues atteinte', imgProtected: 'Protégée', imgViewLimit: '{n} vues max', imgNoAlbums: 'Aucun album.', imgVariantAuto: 'Automatique', imgReplace: 'Remplacer sans changer le lien', imgVersions: 'Versions', imgReplaceDone: 'Image remplacée, URL conservée ✓', imgResizeMini: 'Redimensionner la Mini', imgResizeMiniPrompt: 'Nouvelle taille de la Mini : un nombre de pixels (côté le plus long, ex. 250) OU un pourcentage de la taille totale (ex. 50%). La Micro sera la moitié :', imgResizeMiniInvalid: 'Valeur invalide : pixels (16 à 4096) ou pourcentage (1 à 100 %).', imgResizeMiniDone: 'Mini redimensionnée en {w}×{h} ✓', imgRestoreVersion: 'Restaurer une version', imgVersionRestored: 'Version restaurée ✓', imgAdaptiveReady: 'Optimisation adaptative', albumInvites: 'Invitations', albumInviteCreate: 'Créer une invitation', albumInviteRole: 'Rôle (reader, contributor, manager)', albumInviteCopied: 'Lien d’invitation copié ✓', albumInviteRevoke: 'Révoquer une invitation', albumCollabSummary: '{n} invitation(s)', imgAlbumCopied: 'Lien de l’album copié ✓', imgChartSummary: '{images} images · {views} vues · {visitors} visiteurs · {bytes}', imgHotlinkHosts: 'Domaines autorisés pour l’intégration', imgHotlinkPlaceholder: 'forum.exemple.com, *.site.net', imgHotlinkHint: 'Vide = protection désactivée. Les visites directes restent autorisées.', imgHotlinkProtected: 'Anti-hotlink', imgNotifyFirstView: 'Notifier à la première consultation', imgFirstViewArmed: 'Alerte 1re vue', imgFirstViewSent: 'Première vue notifiée', imgFirstViewToast: '👁 Première consultation de « {name} »', imgSmartBlur: 'Floutage intelligent local', imgSmartBlurFaces: 'Visages', imgSmartBlurFacesPlates: 'Visages et plaques', imgSmartBlurHint: 'Analyse locale avec révision avant envoi; aucune image n’est envoyée à un service externe.', imgSmartBlurAnalyzing: 'Analyse locale…', imgSmartBlurReady: '{n} zone(s) masquée(s). Vérifiez puis appliquez.', imgSmartBlurUnsupported: 'Détection des visages non prise en charge par ce navigateur; ajoutez les zones manuellement.', imgSmartBlurSkip: 'Continuer sans flou', imgRetentionRules: 'Règles automatiques de rétention', imgRetentionWarning: 'Ces règles révoquent définitivement les images et suppriment leurs fichiers. Elles sont désactivées par défaut.', imgRetentionAge: 'Âge maximal (jours)', imgRetentionInactive: 'Inactivité maximale (jours)', imgRetentionViews: 'Révoquer après ce nombre de vues', imgRetentionStorage: 'Stockage maximal (Mo)', imgRetentionSave: 'Enregistrer et appliquer', imgRetentionSaved: 'Règles de rétention enregistrées ✓', imgRetentionResult: '{n} image(s) révoquée(s) · {bytes} libérés', imgRetentionSummary: '{n} image(s) · {bytes}', enabled: 'Activé', disabled: 'Désactivé', optional: 'Facultatif', refresh: 'Rafraîchir', themeSchedule: 'Selon l’heure',
      removeDestination: 'Retirer', cancel: 'Annuler', protectedLink: '🔒 Lien protégé', unlock: 'Déverrouiller', encryptedLink: '🔐 Chiffrement de bout en bout',
      encryptionKey: 'Clé du lien', passphrase: 'Phrase secrète', addFiles: 'Ajouter des fichiers', durableQueue: 'Les fichiers sont copiés dans le stockage durable avant l’envoi afin de reprendre après une fermeture de la PWA.',
      takePhoto: 'Prendre une photo', chooseFiles: 'Choisir des fichiers', chooseFolder: 'Choisir un dossier',
      optimizePhotos: 'Optimiser les photos avant envoi', parallelUploads: 'Envois parallèles', senderName: 'Votre nom', pause: 'Pause', resume: 'Reprendre',
      retryAll: '↻ Réessayer', removePending: 'Tout retirer', send: 'Envoyer', clearCompleted: 'Effacer les envois terminés', history: 'Historique local',
      clearHistory: 'Effacer l’historique', settings: 'Réglages et sécurité', autoResume: 'Reprendre automatiquement après fermeture ou reconnexion', storage: 'Stockage local',
      protectStorage: 'Protéger', deviceAccess: 'Accès de cet appareil', deviceChecking: 'Vérification de l’appareil…', deviceStatusUnavailable: 'État de l’appareil indisponible. Touchez Appairer pour réessayer.', pairDevice: 'Appairer cet appareil', unpairDevice: 'Désappairer cet appareil', pairOther: 'Appairer par QR', pairOtherTitle: 'Appairer un autre appareil', pairOtherHelp: 'Scannez ce QR sur l’autre appareil. Le lien est à usage unique et expire après cinq minutes.', pairQrAlt: 'QR d’association de l’appareil', pairLink: 'Lien d’association', pairExpires: 'Expire à {date}', pairQrFailed: 'Création du QR impossible', copy: 'Copier', revokeDevice: 'Révoquer', pairedDevices: 'Appareils associés',
      clearLocalData: 'Effacer toutes les données locales', closeSession: 'Fermer la session', closeSessionConfirm: 'Fermer la session sur cet appareil ? Les transferts, images et historiques locaux seront conservés.', closingSession: 'Fermeture…', closeSessionFailed: 'Impossible de fermer la session. Réessayez.', companionApp: 'application compagnon', qrHint: 'Visez un QR code de lien de réception…', close: 'Fermer',
      noLink: '— Aucun lien —', addLinkHint: 'Ajoutez un lien de réception avec le bouton ＋.', checking: 'Vérification…', ready: '✓ Prêt à recevoir',
      locked: '🔒 Lien protégé — déverrouillez-le', revoked: '✗ Lien révoqué ou expiré', offlineServer: '⚠ Serveur injoignable', invalid: '✗ Lien introuvable',
      e2eKeyReady: 'La clé du lien chiffrera les fichiers dans ce navigateur.', e2eKeyMissing: 'Collez le lien complet contenant #k=… ou saisissez sa clé.',
      e2ePass: 'Saisissez la phrase secrète utilisée par ce lien.', waiting: 'en attente', restoring: 'reprise prête', durableSaving: 'copie locale…', durableSaved: 'conservé après fermeture', durableMissing: 'copie locale introuvable', sending: 'envoi…', paused: 'en pause',
      waitingNetwork: 'attente réseau', encrypting: 'chiffrement…', optimizing: 'optimisation…', done: 'envoyé ✓', cancelled: 'annulé', networkError: 'échec réseau',
      otherOrigin: 'Ce lien appartient à une autre origine.', useTokenQuestion: 'Ce lien vient de {from}. Utiliser explicitement son jeton sur {to} ?', invalidLink: 'Lien ou jeton invalide',
      duplicate: '{n} doublon(s) ignoré(s)', queued: '{n} fichier(s) ajouté(s)', removedConfirm: 'Retirer cette destination mémorisée ?', clearQueueConfirm: 'Retirer tous les fichiers non terminés ?',
      clearDataConfirm: 'Effacer destinations, file d’attente, historique et réglages locaux ?', historyEmpty: 'Aucun envoi terminé sur cet appareil.',
      copied: 'Lien copié ✓', copyFailed: 'Copie impossible', pasteFailed: 'Accès au presse-papiers impossible', qrFound: 'QR détecté ✓', qrUnknown: 'QR non reconnu',
      scanUnsupported: 'Le scan QR n’est pas pris en charge ici. Collez le lien à la place.', cameraUnavailable: 'Caméra indisponible', unlockFailed: 'Échec du déverrouillage',
      senderRequired: 'Saisissez votre nom pour cette destination.', passRequired: 'Saisissez la phrase secrète.', keyRequired: 'La clé de chiffrement est manquante.', noCrypto: 'WebCrypto est indisponible.',
      quotaFile: 'Ce fichier dépasse la limite du lien.', quotaTotal: 'Le lot dépasserait le quota restant.', quotaCount: 'Le nombre maximal de fichiers serait dépassé.', typeBlocked: 'Ce type de fichier est refusé.',
      fileTooLarge: 'trop volumineux', quotaFull: 'quota atteint', maxFiles: 'nombre max atteint', unavailable: 'lien indisponible', infected: 'fichier infecté', error: 'erreur',
      batchResult: '{ok} envoyé(s){fail}', failures: ', {n} échec(s)', pauseRequested: 'Mise en pause…', resumed: 'Reprise des envois',
      queueSummary: '{waiting} en attente · {size}', queueErrors: '{n} échec(s)', queuePaused: '{n} en pause', storageUnknown: 'Estimation indisponible',
      storageUsage: '{used} utilisés sur {quota}', storageProtected: 'Stockage persistant accordé', storageDenied: 'Le navigateur n’a pas accordé le stockage persistant',
      deviceAdmin: 'Session administrateur active. Vous pouvez associer cet appareil avec un accès limité à la PWA.', devicePaired: 'Cet appareil possède un jeton limité à /app.',
      deviceUnpaired: 'Non associé. Une connexion administrateur est nécessaire une fois.', devicePairedOk: 'Appareil appairé ✓', deviceRevoked: 'Accès de l’appareil révoqué',
      devicePairFailed: 'Association impossible', deviceRevokeFailed: 'Révocation impossible', deviceCurrent: 'cet appareil', deviceLast: 'Dernière utilisation {date}',
      renameDevice: 'Renommer', renameDevicePrompt: 'Nouveau nom de l’appareil :', deviceRenamed: 'Appareil renommé ✓', deviceRenameFailed: 'Renommage impossible',
      localCleared: 'Données locales effacées', sharedTextName: 'partage.txt', sharedReceived: '{n} élément(s) partagé(s) ajouté(s) ✓',
      resumedQueue: 'File restaurée : {n} fichier(s)', optimizeFallback: 'Cette image ne peut pas être convertie ici; l’original sera envoyé.',
      heicFallback: 'La conversion HEIC dépend du décodage offert par ce navigateur.', renameLocked: 'Le nom est verrouillé dès que l’envoi commence.',
      noPending: 'Aucun fichier à envoyer.', destinationLocked: 'La destination reste verrouillée jusqu’à la fin du lot.', authExpired: 'La session a expiré; le lot partagé reste conservé.',
      retry: 'Réessayer', remove: 'Retirer', edit: 'Modifier', progress: 'Progression de {name}', clearHistoryConfirm: 'Effacer l’historique local ?',
      storageRequest: 'Demande de stockage persistant envoyée.', sessionOnly: 'Cette destination restera uniquement pour la session.',
      largeFileSessionOnly: '{n} fichier(s) n’ont pas pu être copiés dans le stockage durable. Gardez la PWA ouverte jusqu’à la fin.', fileSessionOnly: 'non conservé après fermeture',
      startingUpload: 'démarrage de l’envoi…', shrinkingChunk: 'adaptation au réseau…', rateLimited: 'trop de requêtes — pause…', uploadStalled: 'Le transfert ne démarre pas. Vérifiez la limite de taille et la mise en mémoire tampon du reverse proxy, puis réessayez.',
      diagBadgeTimeout: 'délai dépassé', diagBadgeNetwork: 'réseau (refusé)', diagBadgeNetCut: 'réseau (coupé)',
      diagNetRefused: 'la connexion a échoué avant tout envoi ({s}s) — requête bloquée/refusée : proxy inaccessible sur cette route, règle CORS/pare-feu, ou HTTPS requis.', diagNetCut: 'la connexion a été coupée pendant l’envoi du bloc ({s}s) — le proxy ou le serveur ferme sur un corps de requête trop gros (proxy-request-buffering / limite de taille).',
      diagBadgePostBlock: 'POST bloqué', diagPostBlocked: 'le serveur répond (GET OK) mais le POST d’upload est refusé — un proxy/WAF bloque les POST volumineux ou la route /u/…/upload. Vérifiez client_max_body_size, proxy-request-buffering et les règles WAF/ModSecurity.', diagNoConnect: 'aucune réponse du serveur, même à un simple GET — connectivité, DNS ou proxy hors service depuis le mobile à ce moment.',
      diagBadgeFileRead: 'fichier illisible', diagFileUnreadable: 'le fichier n’a pas pu être lu sur cet appareil (l’envoi échoue avant tout octet). Fréquent sur mobile avec un très gros fichier : rouvrez la PWA et re-sélectionnez le fichier (via « Choisir des fichiers », pas un raccourci de partage), évitez de mettre l’app en arrière-plan pendant l’envoi, ou copiez-le d’abord dans le stockage local du téléphone.',
      diagProxyLimit: 'le reverse proxy refuse la taille de la requête (client_max_body_size / limit trop bas).', diagRateLimited: 'trop de requêtes — limite de débit atteinte (Retry-After respecté).',
      diagTimeout: 'aucune réponse dans le délai — le proxy met probablement le corps de la requête en tampon.', diagGateway: 'le proxy a renvoyé une erreur de passerelle (HTTP {s}) — backend injoignable, ou timeout/buffer du proxy.',
      diagServerError: 'erreur serveur (HTTP {s}).', diagSync: 'désynchronisation du décalage entre l’app et le serveur.', diagHttp: 'réponse inattendue du serveur (HTTP {s}).', diagNetwork: 'connexion interrompue avant la réponse (Wi-Fi/données mobiles ou coupure du proxy).',
      diagServerWrite: 'écriture impossible côté serveur (disque plein ou dossier de réception).', diagServerSync: 'décalage de bloc désynchronisé.', diagServerBusy: 'trop d’envois simultanés sur le serveur.', diagServerDropped: 'connexion abandonnée côté serveur.',
      maxFile: 'max {size}/fichier', filesLeft: '{left}/{total} fichiers', spaceLeft: '{left} libres / {total}', folderUnsupported: 'La sélection de dossier n’est pas prise en charge.',
      deviceName: 'Direct-Xfer PWA sur {platform}', revokeThisDeviceConfirm: 'Révoquer l’accès limité de cet appareil ? Les données locales privées seront effacées.', revokeOtherConfirm: 'Révoquer cet appareil associé ?', revokeDeviceSharesConfirm: 'Révoquer aussi tous les liens créés par cet appareil ?',
      updateApplied: 'Mise à jour appliquée.', historyDest: 'vers {dest}', textSharedHeader: 'Contenu partagé', urlSharedHeader: 'URL partagée',
      help: 'Aide', shortcutsTitle: 'Raccourcis clavier', shortcutSend: 'Envoyer la file', shortcutEsc: 'Fermer un panneau ou une fenêtre', shortcutHelp: 'Afficher cette aide',
      sortBy: 'Trier', sortAdded: 'Ordre d’ajout', sortName: 'Nom', sortSize: 'Taille',
      imgCopyAll: '🔗 Copier tous', imgOpen: 'Ouvrir dans un onglet', allImgCopied: '{n} lien(s) copié(s) ✓', noImgLinks: 'Aucun lien à copier.', imgCopyTemplate: 'Modèle de copie', copyTemplateStandard: 'Standard', copyTemplateForum: 'Forum', copyTemplateEmail: 'Courriel', imgQrZip: '🗜 QR en ZIP', imgQrZipDone: 'Archive de QR téléchargée ✓', imgExportStatsCsv: 'CSV statistiques', imgStatsCsvDone: 'Statistiques exportées ✓', imgFavoriteAction1: 'Action favorite 1', imgFavoriteAction2: 'Action favorite 2', imgFavoriteAction3: 'Action favorite 3', imgActionCopy: 'Copier', imgActionOpen: 'Ouvrir', imgQrDownload: 'Télécharger QR', pinItem: 'Épingler', unpinItem: 'Désépingler', tagColors: 'Couleurs des tags', tagColorsReset: 'Réinitialiser les couleurs', expiresIn: 'Expire dans {time}', expiredNow: 'Expiré',
      shareLink: 'Partager le lien', qrForLink: 'QR du lien', qrTitle: 'QR du lien de réception', qrDestHelp: 'Scannez ce code sur un autre appareil pour ouvrir le lien de réception.', qrFail: 'Création du QR impossible',
      receivedTitle: 'Contenu reçu', receivedHelp: 'Fichiers reçus sur ce lien de réception, servis par le serveur.', receivedRefresh: 'Actualiser', receivedLoading: 'Chargement…', receivedEmpty: 'Aucun fichier reçu pour l’instant.', receivedFail: 'Impossible de charger le contenu reçu.', receivedCount: '{n} fichier(s) · {size}', receivedDownload: 'Télécharger',
      sessionStats: 'Cette session', sessionStatsValue: '{files} fichier(s) · {size} envoyés', sessionStatsEmpty: 'Aucun envoi durant cette session.',
      maintenance: 'Maintenance', checkUpdate: 'Rechercher une mise à jour', checkingUpdate: 'Recherche…', updateFound: 'Mise à jour trouvée — préparation…', updateNone: 'Déjà à jour ✓',
      copyDiag: 'Copier le diagnostic', diagCopied: 'Diagnostic copié ✓', diagNone: 'Aucune erreur d’envoi enregistrée.',
      vibrateFinish: 'Vibrer à la fin d’un envoi', keepAwake: 'Garder l’écran allumé pendant l’envoi', hapticFeedback: 'Retour haptique pour les actions', advancedAccordion: 'Une seule section avancée ouverte à la fois', confirmRevoke: 'Confirmer les révocations', confirmDelete: 'Confirmer les suppressions', confirmReplace: 'Confirmer les remplacements et doublons', storageWarningThreshold: 'Avertir à partir de', storageWarning: 'Stockage local utilisé à {percent} %',
      historySearch: 'Rechercher dans l’historique', historyCopy: 'Copier les détails', historyNoMatch: 'Aucun résultat.', rateAvg: '{rate}/s moy', queueEta: '~{eta}',
      sendCount: 'Envoyer · {n} · {size}', imgQualityLabel: 'Qualité', imgSizeLabel: 'Taille max', imgOriginal: 'Originale', qLow: 'Basse', qMed: 'Moyenne', qHigh: 'Haute',
      autoClearDone: 'Effacer les terminés automatiquement', imgFormatLabel: 'Format', imgDims: '{w}×{h} · {size}', exportHistory: 'Exporter', exportCsv: 'CSV', exportJson: 'JSON',
      lifetimeStats: 'Depuis toujours', histToday: 'Aujourd’hui', histYesterday: 'Hier',
      destLastUsed: 'utilisé {rel}', relNow: 'à l’instant', relMin: 'il y a {n} min', relHour: 'il y a {n} h', relDay: 'il y a {n} j',
      moveUp: '↑ Monter', moveDown: '↓ Descendre', shareApp: 'Partager l’application', appShareText: 'Envoyez-moi des fichiers avec Direct-Xfer',
      soundFinish: 'Son à la fin d’un envoi', densityLabel: 'Densité', densityNormal: 'Normale', densityCompact: 'Compacte', storageBarLabel: 'Stockage local utilisé',
      wifiOnly: 'Envoyer seulement en Wi-Fi', waitingWifi: 'attente Wi-Fi', stripExif: 'Retirer les métadonnées (EXIF/GPS)',
      zipBundle: '🗜 Regrouper en ZIP', zipDone: 'Archive ZIP créée ✓', zipNeedTwo: 'Sélectionnez au moins deux fichiers.', zipping: 'Création du ZIP…',
      voiceNote: 'Note vocale', recording: 'Enregistrement', recStop: '⏹ Arrêter', recAdd: 'Ajouter à la file', recMicFail: 'Micro indisponible',
      annotate: 'Annoter', annPen: '✏️ Stylo', annBlur: '🌫 Flou', annDetectFaces: '🙂 Détecter les visages', annDetectPlates: '▭ Détecter les plaques', annUndo: '↶ Défaire', annClear: 'Tout effacer', annApply: 'Appliquer',
      selectedN: '{n} sélectionné(s)', bulkRemove: 'Retirer', bulkRetry: 'Réessayer', selectAll: 'Tout',
      batchNote: 'Étiquette / note (facultatif)', notePlaceholder: 'Ex. Facture, Vacances…',
      multiSend: '📢 Envoyer à plusieurs…', multiSendTitle: 'Envoyer à plusieurs destinations', multiSendHelp: 'Le lot sera envoyé à chaque destination cochée. Les liens chiffrés ou exigeant un nom sont ignorés.', multiSendGo: 'Lancer les envois', multiSendNone: 'Aucune destination compatible sélectionnée.', multiSendQueued: 'Envoi vers {n} destination(s) préparé.',
      cmdPalette: 'Palette de commandes', cmdPlaceholder: 'Tapez une commande…', cmdNoMatch: 'Aucune commande.', cmdOpenSettings: 'Ouvrir les réglages', cmdOpenHistory: 'Ouvrir l’historique', cmdToggleTheme: 'Changer de thème',
      expireLabel: 'Expiration (auto-suppression)', expNever: 'Jamais', exp1h: '1 heure', exp24h: '24 heures', exp7d: '7 jours', exp30d: '30 jours',
      liveTitle: 'Réceptions en direct', liveReceived: '📥 {name} reçu sur « {dest} »', liveEnable: 'Notifications de réception', livePush: 'Notifications push (appli fermée)', livePushOn: 'Notifications push activées ✓', livePushOff: 'Notifications push désactivées', livePushFail: 'Activation des notifications impossible', liveConnected: 'En direct ✓',
      copyToken: 'Copier le jeton', tokenCopied: 'Jeton copié ✓',
      pinDestination: '⭐ Épingler', unpinDestination: '☆ Détacher', pinned: 'Destination épinglée ✓', unpinned: 'Destination détachée',
      resetBatch: '↺ Réinitialiser le lot', resetBatchDone: 'Options du lot réinitialisées ✓',
      filesPending: '{n} en attente', pasteText: 'Coller du texte', pastedTextName: 'texte-collé.txt', pasteTextEmpty: 'Aucun texte dans le presse-papiers.',
      masterSelect: 'Tout sélectionner', addFromUrl: 'Depuis une URL', urlPrompt: 'Adresse de l’image ou du fichier à ajouter :', urlFetching: 'Récupération…', urlFailed: 'Récupération impossible (bloquée par CORS ?)', urlAdded: 'Fichier ajouté ✓', urlInvalid: 'Adresse invalide.',
      bulkRename: '✎ Renommer', renamePrompt: 'Préfixe des noms (une numérotation sera ajoutée) :', renameDone: '{n} fichier(s) renommé(s)',
      hashTitle: 'Empreinte SHA-256', hashing: 'Calcul de l’empreinte…', hashCopied: 'Empreinte SHA-256 copiée ✓', hashFail: 'Calcul de l’empreinte impossible',
      exportSettings: 'Exporter les réglages', importSettings: 'Importer', settingsImported: 'Réglages importés ✓', settingsImportFail: 'Fichier de réglages invalide',
      accentLabel: 'Couleur d’accent', accentReset: 'Défaut',
      screenCapture: 'Capturer l’écran', captureFailed: 'Capture d’écran impossible', screenshotName: 'capture-ecran',
      undo: 'Annuler', fileRemoved: 'Fichier retiré', fileRestored: 'Fichier restauré ✓', lightboxAlt: 'Aperçu de l’image',
      sortType: 'Type', bulkInvert: '⇄ Inverser', expandAll: 'Tout déplier', collapseAll: 'Tout replier',
      queueSearch: 'Filtrer la file…', estOptim: '≈ {size} après optim.', rotate: 'Pivoter',
      quotaNearFull: 'Quota bientôt atteint sur cette destination.',
      imgQrAll: '▦ QR groupé', imgQrTooBig: 'Trop de liens pour tenir dans un seul QR.', bulkShare: 'Partager',
      onlineStatus: 'En ligne', offlineStatus: 'Hors ligne', networkWifi: 'Wi-Fi', networkCellular: 'Données mobiles',
      resendLastBatch: '↺ Renvoyer le dernier lot', lastBatchUnavailable: 'Le dernier lot n’est plus disponible localement.', lastBatchRestored: '{n} fichier(s) du dernier lot restauré(s) ✓',
      copySummary: '⧉ Copier le résumé', shareResult: '📤 Partager le résultat', summaryCopied: 'Résumé copié ✓', noSummary: 'Aucun résumé de transfert disponible.',
      privacyNames: 'Masquer les noms de fichiers sensibles', privacyFile: 'Fichier {n}',
      confirmMobileData: 'Confirmer les gros envois sur données mobiles', mobileDataConfirm: 'Envoyer {size} avec les données mobiles ?',
      optimizePreset: 'Préréglage', presetHigh: 'Haute qualité', presetMessaging: 'Messagerie', presetSaver: 'Économie de données', presetCustom: 'Personnalisé',
      preview: 'Aperçu du fichier', cropSquare: 'Recadrer 1:1', crop43: 'Recadrer 4:3', crop169: 'Recadrer 16:9',
      swipeRemove: 'Glisser à gauche : retirer', swipeRetry: 'Glisser à droite : réessayer', swipePause: 'Glisser à droite : pause/reprise',
      moveEarlier: 'Monter dans la file', moveLater: 'Descendre dans la file'
    },
    en: {
      title: 'Send', navMain: 'Main navigation', navSend: 'Send', navSendHint: 'Prepare and send files to a destination.', navImages: 'Images', navImagesHint: 'Create, manage and monitor image links.', navActivity: 'Activity', navActivityHint: 'Review the local transfer history.', navSettings: 'Settings', navSettingsHint: 'Configure the PWA, security and storage.', navShares: 'Shares', navSharesHint: 'Create share links from files on your server.', sharesTitle: 'Share server files', sharesHint: 'Browse the files on your server and create direct share links.', sharesAdminRequired: 'Sign in with an administrator account to browse server files.', sharesSignIn: 'Sign in as administrator', sharesBrowse: 'Server files', sharesUp: 'Parent folder', sharesCreate: 'Create the share', sharesNoneSelected: 'No file selected.', sharesSelected: '{n} item(s) selected', sharesExpiry: 'Expiry', sharesExpiryNever: 'Never', sharesExpiry1h: '1 hour', sharesExpiry1d: '1 day', sharesExpiry7d: '7 days', sharesExpiry30d: '30 days', sharesMaxDownloads: 'Max downloads (0 = unlimited)', sharesPassword: 'Password (optional)', sharesPasswordPlaceholder: '—', sharesCreateBtn: 'Create share link', sharesCreating: 'Creating…', sharesCreated: 'Share created ✓', sharesCreateFail: 'Could not create the share', sharesLibrary: 'Your shares', sharesEmpty: 'No shares yet.', sharesBrowseFail: 'Could not read this folder.', sharesLoginNeeded: 'Administrator login required.', sharesOpen: 'Open', sharesCopy: 'Copy', sharesRevoke: 'Revoke', sharesRevoked: 'Share revoked ✓', sharesRevokeFail: 'Could not revoke', sharesRevokeConfirm: 'Revoke this share? The link will stop working.', sharesItems: '{n} item(s)', sharesReceptions: 'Reception links', sharesReceptionsEmpty: 'No reception links.', sharesReceived: '{bytes} received', openAdmin: 'Open administration', language: 'Language', theme: 'Theme', copyLink: 'Copy link', pasteLink: 'Paste link', editDestination: 'Edit destination', addDestination: 'Add destination', passwordPlaceholder: 'Link password', destinationPlaceholder: 'Reception link or token', destinationNamePlaceholder: 'Optional destination name', senderPlaceholder: 'Name required by this link', globalProgress: 'Overall progress', keyPlaceholder: 'Link encryption key', titlePlaceholder: 'Shared content', pairedBadge: 'Paired device', themeDark: 'Dark', themeLight: 'Light', themeAuto: 'Auto', install: 'Install', installIosHint: 'To install Direct-Xfer, tap the browser Share button, then “Add to Home Screen”.', installBrowserHint: 'Chrome has not validated full installation yet. Do not choose a simple shortcut: use a trusted HTTPS address, interact with the page, and keep it open briefly.', installHttpsRequired: 'Full installation is impossible from this HTTP address or untrusted certificate. Android can only create a shortcut. Open Direct-Xfer over HTTPS with a valid certificate.', installSecurePending: 'Installation is being prepared. In Chrome, interact with the page and keep it open for about 30 seconds. If the logo does not appear, verify that Android trusts the HTTPS certificate.', installOpenHttps: 'Open HTTPS version',
      offline: 'Offline — uploads will resume when the connection returns.', updateReady: 'A new version is available.', updateNow: 'Update', pullToRefresh: 'Pull down to refresh', releaseToRefresh: 'Release to refresh', refreshing: 'Refreshing…', backExit: 'Press back again to exit',
      destination: 'Destination', destinationHint: 'A Direct-Xfer reception link from this instance.', linkOrToken: 'Link or token', displayName: 'Display name',
      rememberDestination: 'Remember this destination on this device', rememberKey: 'Also remember the secret key on this device', scanQr: '📷 Scan QR', saveDestination: 'Add', updateDestination: 'Save', removeDestination: 'Remove', createLinkTitle: 'Create a reception link', newLink: 'New', createLinkName: 'New link name', createLinkPlaceholder: 'e.g. Holiday photos', createLinkHint: 'A new reception link will be created and added to your destinations. Share it to receive files.', createDo: 'Create link', creating: 'Creating…', createOk: 'Link created ✓', createFail: 'Could not create the link',
      imgLinksTitle: 'Image links', imgLinksHint: 'Create direct links to your images: each link offers Full, Mini, and Micro versions, with no relay page.', imgLinksAdd: 'Add images', imgCreateTitle: 'Create links', imgCreateHint: 'Choose your images and the format to feature first.', imgLibraryTitle: 'Your links', imgLibraryHint: 'Search, sort and manage images you already shared.', imgGlobalActions: 'Global actions', imgCopyActions: 'Copy a format', imgManageActions: 'Manage link', imgStripExif: 'Remove EXIF/GPS data before sharing', imgStripExifHint: 'The cleanup is performed locally on this device before upload.', imgStrippingMetadata: 'Removing EXIF/GPS…', imgMetadataRemoved: 'EXIF/GPS removed', imgUploading: 'Uploading…', imgThumbing: 'Mini and Micro…', imgReady: 'Ready', imgCopyFull: '🔗 Full size', imgCopyThumb: '🔗 Mini', imgCopyMicro: '🔗 Micro', imgCopied: 'Link copied ✓', imgLinkFail: 'Could not create the link', revokeShare: 'Revoke', revokeConfirm: 'Revoke this share? The link will stop working.', revokeSuccess: 'Revoked ✓', revokeFail: 'Could not revoke', imgVariantFull: 'Full', imgVariantMini: 'Mini', imgVariantMicro: 'Micro', imgViews: '{n} views', imgVisitors: '{n} visitors', imgStatsLoading: 'Statistics…', imgStatsUnavailable: 'Statistics unavailable',
      imgSearch: 'Search images…', imgSortLabel: 'Sort images', imgSortNewest: 'Newest', imgSortOldest: 'Oldest', imgSortName: 'Name', imgSortSize: 'Size', imgSortViews: 'Views', imgSortVisitors: 'Visitors', imgSortExpiry: 'Expiry', imgFilterLabel: 'Filter images', imgFilterAll: 'All', imgFilterActive: 'Active', imgFilterPopular: 'Popular', imgFilterLarge: 'Large', imgFilterExpiring: 'Expiring soon', imgFilterFavorite: 'Favorites', imgFilterProtected: 'Protected', imgDefaultVariantLabel: 'Favorite image size', imgAdvancedOptions: 'Image options', imgCompact: 'Compact display', imgHideExpired: 'Hide expired images', imgAutoCopy: 'Copy automatically after creation', imgDefaultExpiry: 'Favorite expiry', imgMaxViews: 'View limit', imgPassword: 'Password', imgTags: 'Tags', imgPrivateNote: 'Private note', imgRenameTemplate: 'Rename template', imgBulkEdit: 'Edit', imgCreateAlbum: 'Create album', imgDashboard: 'Statistics chart', imgAlbums: 'Shareable albums', imgActionHistory: 'Image action history', imgSelected: '{n} selected', imgEditPrompt: 'Edit selected images', imgAlbumName: 'Album name', imgAlbumCreated: 'Album created ✓', imgSettingsSaved: 'Settings saved ✓', imgDuplicateFound: 'This image has already been shared. Continue anyway?', imgExpirySoon: 'The link “{name}” expires soon.', imgUndoRevoke: 'Image removed — Undo?', imgRevokePending: 'Revoking in a few seconds…', imgQrDownloaded: 'QR downloaded ✓', imgFavorite: 'Favorite', imgUnfavorite: 'Remove from favorites', imgExpired: 'Expired', imgInactive: 'Inactive', imgViewLimitReached: 'View limit reached', imgProtected: 'Protected', imgViewLimit: '{n} views max', imgNoAlbums: 'No albums.', imgVariantAuto: 'Automatic', imgReplace: 'Replace without changing link', imgVersions: 'Versions', imgReplaceDone: 'Image replaced, URL preserved ✓', imgResizeMini: 'Resize the Mini', imgResizeMiniPrompt: 'New Mini size: a number of pixels (longest side, e.g. 250) OR a percentage of the full size (e.g. 50%). The Micro will be half:', imgResizeMiniInvalid: 'Invalid value: pixels (16 to 4096) or percentage (1 to 100%).', imgResizeMiniDone: 'Mini resized to {w}×{h} ✓', imgRestoreVersion: 'Restore a version', imgVersionRestored: 'Version restored ✓', imgAdaptiveReady: 'Adaptive optimization', albumInvites: 'Invitations', albumInviteCreate: 'Create invitation', albumInviteRole: 'Role (reader, contributor, manager)', albumInviteCopied: 'Invitation link copied ✓', albumInviteRevoke: 'Revoke invitation', albumCollabSummary: '{n} invitation(s)', imgAlbumCopied: 'Album link copied ✓', imgChartSummary: '{images} images · {views} views · {visitors} visitors · {bytes}', imgHotlinkHosts: 'Allowed embedding domains', imgHotlinkPlaceholder: 'forum.example.com, *.site.net', imgHotlinkHint: 'Empty = protection disabled. Direct visits remain allowed.', imgHotlinkProtected: 'Hotlink protection', imgNotifyFirstView: 'Notify on first view', imgFirstViewArmed: 'First-view alert', imgFirstViewSent: 'First view notified', imgFirstViewToast: '👁 First view of “{name}”', imgSmartBlur: 'Local smart blur', imgSmartBlurFaces: 'Faces', imgSmartBlurFacesPlates: 'Faces and plates', imgSmartBlurHint: 'Local analysis with review before upload; no image is sent to an external service.', imgSmartBlurAnalyzing: 'Local analysis…', imgSmartBlurReady: '{n} area(s) hidden. Review and apply.', imgSmartBlurUnsupported: 'Face detection is not supported by this browser; add areas manually.', imgSmartBlurSkip: 'Continue without blur', imgRetentionRules: 'Automatic retention rules', imgRetentionWarning: 'These rules permanently revoke images and delete their files. They are disabled by default.', imgRetentionAge: 'Maximum age (days)', imgRetentionInactive: 'Maximum inactivity (days)', imgRetentionViews: 'Revoke after this many views', imgRetentionStorage: 'Maximum storage (MB)', imgRetentionSave: 'Save and apply', imgRetentionSaved: 'Retention rules saved ✓', imgRetentionResult: '{n} image(s) revoked · {bytes} freed', imgRetentionSummary: '{n} image(s) · {bytes}', enabled: 'Enabled', disabled: 'Disabled', optional: 'Optional', refresh: 'Refresh', themeSchedule: 'By time',
      cancel: 'Cancel', protectedLink: '🔒 Protected link', unlock: 'Unlock', encryptedLink: '🔐 End-to-end encryption', encryptionKey: 'Link key', passphrase: 'Passphrase',
      addFiles: 'Add files', durableQueue: 'Files are copied to durable storage before upload so they can resume after the PWA is closed.', takePhoto: 'Take a photo', chooseFiles: 'Choose files',
      chooseFolder: 'Choose a folder', optimizePhotos: 'Optimize photos before upload', parallelUploads: 'Parallel uploads', senderName: 'Your name', pause: 'Pause', resume: 'Resume',
      retryAll: '↻ Retry', removePending: 'Remove all', send: 'Send', clearCompleted: 'Clear completed uploads', history: 'Local history', clearHistory: 'Clear history',
      settings: 'Settings and security', autoResume: 'Resume automatically after closing or reconnecting', storage: 'Local storage', protectStorage: 'Protect', deviceAccess: 'Device access', deviceChecking: 'Checking device…', deviceStatusUnavailable: 'Device status is unavailable. Tap Pair to try again.',
      pairDevice: 'Pair this device', unpairDevice: 'Unpair this device', pairOther: 'Pair by QR', pairOtherTitle: 'Pair another device', pairOtherHelp: 'Scan this QR on the other device. The link is single-use and expires after five minutes.', pairQrAlt: 'Device pairing QR code', pairLink: 'Pairing link', pairExpires: 'Expires at {date}', pairQrFailed: 'Could not create the QR code', copy: 'Copy', revokeDevice: 'Revoke', pairedDevices: 'Paired devices', clearLocalData: 'Clear all local data', closeSession: 'Sign out', closeSessionConfirm: 'Sign out on this device? Local transfers, images and history will be kept.', closingSession: 'Signing out…', closeSessionFailed: 'Could not sign out. Try again.', companionApp: 'companion app', qrHint: 'Point at a reception-link QR code…', close: 'Close',
      noLink: '— No link —', addLinkHint: 'Add a reception link with the ＋ button.', checking: 'Checking…', ready: '✓ Ready to receive', locked: '🔒 Protected link — unlock it',
      revoked: '✗ Revoked or expired link', offlineServer: '⚠ Server unreachable', invalid: '✗ Link not found', e2eKeyReady: 'The link key will encrypt files in this browser.',
      e2eKeyMissing: 'Paste the full link containing #k=… or enter its key.', e2ePass: 'Enter the passphrase used by this link.', waiting: 'waiting', restoring: 'ready to resume', durableSaving: 'saving locally…', durableSaved: 'kept after closing', durableMissing: 'local copy missing', sending: 'uploading…',
      paused: 'paused', waitingNetwork: 'waiting for network', encrypting: 'encrypting…', optimizing: 'optimizing…', done: 'sent ✓', cancelled: 'cancelled', networkError: 'network failure',
      otherOrigin: 'This link belongs to another origin.', useTokenQuestion: 'This link comes from {from}. Explicitly use its token on {to}?', invalidLink: 'Invalid link or token',
      duplicate: '{n} duplicate(s) ignored', queued: '{n} file(s) added', removedConfirm: 'Remove this saved destination?', clearQueueConfirm: 'Remove all unfinished files?',
      clearDataConfirm: 'Clear destinations, queue, history, and local settings?', historyEmpty: 'No completed upload on this device.', copied: 'Link copied ✓', copyFailed: 'Copy failed',
      pasteFailed: 'Clipboard access failed', qrFound: 'QR detected ✓', qrUnknown: 'QR not recognized', scanUnsupported: 'QR scanning is unavailable here. Paste the link instead.',
      cameraUnavailable: 'Camera unavailable', unlockFailed: 'Unlock failed', senderRequired: 'Enter your name for this destination.', passRequired: 'Enter the passphrase.',
      keyRequired: 'The encryption key is missing.', noCrypto: 'WebCrypto is unavailable.', quotaFile: 'This file exceeds the link limit.', quotaTotal: 'The batch would exceed the remaining quota.',
      quotaCount: 'The maximum file count would be exceeded.', typeBlocked: 'This file type is refused.', fileTooLarge: 'too large', quotaFull: 'quota reached', maxFiles: 'max count reached',
      unavailable: 'link unavailable', infected: 'infected file', error: 'error', batchResult: '{ok} sent{fail}', failures: ', {n} failed', pauseRequested: 'Pausing…', resumed: 'Uploads resumed',
      queueSummary: '{waiting} waiting · {size}', queueErrors: '{n} failed', queuePaused: '{n} paused', storageUnknown: 'Estimate unavailable', storageUsage: '{used} used of {quota}',
      storageProtected: 'Persistent storage granted', storageDenied: 'Persistent storage was not granted', deviceAdmin: 'Admin session active. You can pair this device with PWA-only access.',
      devicePaired: 'This device has a token limited to /app.', deviceUnpaired: 'Not paired. One admin sign-in is required.', devicePairedOk: 'Device paired ✓', deviceRevoked: 'Device access revoked',
      devicePairFailed: 'Pairing failed', deviceRevokeFailed: 'Revocation failed', deviceCurrent: 'this device', deviceLast: 'Last used {date}', localCleared: 'Local data cleared',
      renameDevice: 'Rename', renameDevicePrompt: 'New device name:', deviceRenamed: 'Device renamed ✓', deviceRenameFailed: 'Rename failed',
      sharedTextName: 'shared.txt', sharedReceived: '{n} shared item(s) added ✓', resumedQueue: 'Queue restored: {n} file(s)', optimizeFallback: 'This image cannot be converted here; the original will be sent.',
      heicFallback: 'HEIC conversion depends on this browser’s decoder.', renameLocked: 'The name is locked once uploading starts.', noPending: 'No file to send.',
      destinationLocked: 'The destination stays locked until this batch ends.', authExpired: 'The session expired; the shared batch remains stored.', retry: 'Retry', remove: 'Remove', edit: 'Edit',
      progress: 'Progress for {name}', clearHistoryConfirm: 'Clear local history?', storageRequest: 'Persistent storage request sent.', sessionOnly: 'This destination is kept for this session only.',
      largeFileSessionOnly: '{n} file(s) could not be copied to durable storage. Keep the PWA open until completion.', fileSessionOnly: 'not kept after closing',
      startingUpload: 'starting upload…', shrinkingChunk: 'adapting to the network…', rateLimited: 'rate limited — pausing…', uploadStalled: 'The transfer cannot start. Check the reverse proxy body-size and request-buffering settings, then retry.',
      diagBadgeTimeout: 'timeout', diagBadgeNetwork: 'network (refused)', diagBadgeNetCut: 'network (dropped)',
      diagNetRefused: 'the connection failed before sending anything ({s}s) — request blocked/refused: proxy not reachable on this route, a CORS/firewall rule, or HTTPS required.', diagNetCut: 'the connection was cut while sending the block ({s}s) — the proxy or server closes on a too-large request body (proxy request buffering / size limit).',
      diagBadgePostBlock: 'POST blocked', diagPostBlocked: 'the server replies (GET OK) but the upload POST is refused — a proxy/WAF is blocking large POSTs or the /u/…/upload route. Check client_max_body_size, proxy request buffering and WAF/ModSecurity rules.', diagNoConnect: 'no reply from the server, even to a plain GET — connectivity, DNS or proxy down from the phone at that moment.',
      diagBadgeFileRead: 'file unreadable', diagFileUnreadable: 'the file could not be read on this device (the upload fails before any byte). Common on mobile with a very large file: reopen the PWA and re-pick the file (via “Choose files”, not a share shortcut), avoid backgrounding the app during the upload, or copy it to the phone’s local storage first.',
      diagProxyLimit: 'the reverse proxy is rejecting the request size (client_max_body_size / limit too low).', diagRateLimited: 'too many requests — rate limit hit (Retry-After honoured).',
      diagTimeout: 'no response within the timeout — the proxy is likely buffering the request body.', diagGateway: 'the proxy returned a gateway error (HTTP {s}) — backend unreachable, or proxy timeout/buffering.',
      diagServerError: 'server error (HTTP {s}).', diagSync: 'upload offset out of sync between the app and the server.', diagHttp: 'unexpected server response (HTTP {s}).', diagNetwork: 'connection dropped before a response (Wi-Fi/mobile data, or the proxy closed it).',
      diagServerWrite: 'the server could not write the file (disk full or reception folder).', diagServerSync: 'chunk offset out of sync.', diagServerBusy: 'too many simultaneous uploads on the server.', diagServerDropped: 'the connection was dropped on the server side.',
      maxFile: 'max {size}/file', filesLeft: '{left}/{total} files', spaceLeft: '{left} free / {total}', folderUnsupported: 'Folder selection is unavailable.',
      deviceName: 'Direct-Xfer PWA on {platform}', revokeThisDeviceConfirm: 'Revoke this device’s limited access? Private local data will be erased.', revokeOtherConfirm: 'Revoke this paired device?', revokeDeviceSharesConfirm: 'Also revoke every link created by this device?',
      updateApplied: 'Update applied.', historyDest: 'to {dest}', textSharedHeader: 'Shared content', urlSharedHeader: 'Shared URL',
      help: 'Help', shortcutsTitle: 'Keyboard shortcuts', shortcutSend: 'Send the queue', shortcutEsc: 'Close a panel or dialog', shortcutHelp: 'Show this help',
      sortBy: 'Sort', sortAdded: 'Order added', sortName: 'Name', sortSize: 'Size',
      imgCopyAll: '🔗 Copy all', imgOpen: 'Open in a tab', allImgCopied: '{n} link(s) copied ✓', noImgLinks: 'No link to copy.', imgCopyTemplate: 'Copy template', copyTemplateStandard: 'Standard', copyTemplateForum: 'Forum', copyTemplateEmail: 'Email', imgQrZip: '🗜 QR ZIP', imgQrZipDone: 'QR archive downloaded ✓', imgExportStatsCsv: 'Statistics CSV', imgStatsCsvDone: 'Statistics exported ✓', imgFavoriteAction1: 'Favorite action 1', imgFavoriteAction2: 'Favorite action 2', imgFavoriteAction3: 'Favorite action 3', imgActionCopy: 'Copy', imgActionOpen: 'Open', imgQrDownload: 'Download QR', pinItem: 'Pin', unpinItem: 'Unpin', tagColors: 'Tag colors', tagColorsReset: 'Reset colors', expiresIn: 'Expires in {time}', expiredNow: 'Expired',
      shareLink: 'Share link', qrForLink: 'Link QR', qrTitle: 'Reception link QR', qrDestHelp: 'Scan this code on another device to open the reception link.', qrFail: 'Could not create the QR code',
      receivedTitle: 'Received content', receivedHelp: 'Files received on this reception link, served by the server.', receivedRefresh: 'Refresh', receivedLoading: 'Loading…', receivedEmpty: 'No files received yet.', receivedFail: 'Could not load received content.', receivedCount: '{n} file(s) · {size}', receivedDownload: 'Download',
      sessionStats: 'This session', sessionStatsValue: '{files} file(s) · {size} sent', sessionStatsEmpty: 'No upload during this session.',
      maintenance: 'Maintenance', checkUpdate: 'Check for an update', checkingUpdate: 'Checking…', updateFound: 'Update found — preparing…', updateNone: 'Already up to date ✓',
      copyDiag: 'Copy diagnostics', diagCopied: 'Diagnostics copied ✓', diagNone: 'No upload error recorded.',
      vibrateFinish: 'Vibrate when an upload finishes', keepAwake: 'Keep the screen on during uploads', hapticFeedback: 'Haptic feedback for actions', advancedAccordion: 'Keep only one advanced section open', confirmRevoke: 'Confirm revocations', confirmDelete: 'Confirm deletions', confirmReplace: 'Confirm replacements and duplicates', storageWarningThreshold: 'Warn at', storageWarning: 'Local storage is {percent}% full',
      historySearch: 'Search the history', historyCopy: 'Copy details', historyNoMatch: 'No result.', rateAvg: '{rate}/s avg', queueEta: '~{eta}',
      sendCount: 'Send · {n} · {size}', imgQualityLabel: 'Quality', imgSizeLabel: 'Max size', imgOriginal: 'Original', qLow: 'Low', qMed: 'Medium', qHigh: 'High',
      autoClearDone: 'Clear completed automatically', imgFormatLabel: 'Format', imgDims: '{w}×{h} · {size}', exportHistory: 'Export', exportCsv: 'CSV', exportJson: 'JSON',
      lifetimeStats: 'All time', histToday: 'Today', histYesterday: 'Yesterday',
      destLastUsed: 'used {rel}', relNow: 'just now', relMin: '{n} min ago', relHour: '{n} h ago', relDay: '{n} d ago',
      moveUp: '↑ Move up', moveDown: '↓ Move down', shareApp: 'Share the app', appShareText: 'Send me files with Direct-Xfer',
      soundFinish: 'Sound when an upload finishes', densityLabel: 'Density', densityNormal: 'Normal', densityCompact: 'Compact', storageBarLabel: 'Local storage used',
      wifiOnly: 'Upload on Wi-Fi only', waitingWifi: 'waiting for Wi-Fi', stripExif: 'Remove metadata (EXIF/GPS)',
      zipBundle: '🗜 Bundle into ZIP', zipDone: 'ZIP archive created ✓', zipNeedTwo: 'Select at least two files.', zipping: 'Building ZIP…',
      voiceNote: 'Voice note', recording: 'Recording', recStop: '⏹ Stop', recAdd: 'Add to queue', recMicFail: 'Microphone unavailable',
      annotate: 'Annotate', annPen: '✏️ Pen', annBlur: '🌫 Blur', annDetectFaces: '🙂 Detect faces', annDetectPlates: '▭ Detect plates', annUndo: '↶ Undo', annClear: 'Clear all', annApply: 'Apply',
      selectedN: '{n} selected', bulkRemove: 'Remove', bulkRetry: 'Retry', selectAll: 'All',
      batchNote: 'Tag / note (optional)', notePlaceholder: 'e.g. Invoice, Holiday…',
      multiSend: '📢 Send to several…', multiSendTitle: 'Send to several destinations', multiSendHelp: 'The batch is sent to each ticked destination. Encrypted links or links requiring a name are skipped.', multiSendGo: 'Start sending', multiSendNone: 'No compatible destination selected.', multiSendQueued: 'Sending to {n} destination(s) prepared.',
      cmdPalette: 'Command palette', cmdPlaceholder: 'Type a command…', cmdNoMatch: 'No command.', cmdOpenSettings: 'Open settings', cmdOpenHistory: 'Open history', cmdToggleTheme: 'Toggle theme',
      expireLabel: 'Expiry (auto-delete)', expNever: 'Never', exp1h: '1 hour', exp24h: '24 hours', exp7d: '7 days', exp30d: '30 days',
      liveTitle: 'Live receptions', liveReceived: '📥 {name} received on “{dest}”', liveEnable: 'Reception notifications', livePush: 'Push notifications (app closed)', livePushOn: 'Push notifications enabled ✓', livePushOff: 'Push notifications disabled', livePushFail: 'Could not enable notifications', liveConnected: 'Live ✓',
      copyToken: 'Copy token', tokenCopied: 'Token copied ✓',
      pinDestination: '⭐ Pin', unpinDestination: '☆ Unpin', pinned: 'Destination pinned ✓', unpinned: 'Destination unpinned',
      resetBatch: '↺ Reset batch', resetBatchDone: 'Batch options reset ✓',
      filesPending: '{n} pending', pasteText: 'Paste text', pastedTextName: 'pasted-text.txt', pasteTextEmpty: 'No text in the clipboard.',
      masterSelect: 'Select all', addFromUrl: 'From a URL', urlPrompt: 'Address of the image or file to add:', urlFetching: 'Fetching…', urlFailed: 'Could not fetch (blocked by CORS?)', urlAdded: 'File added ✓', urlInvalid: 'Invalid address.',
      bulkRename: '✎ Rename', renamePrompt: 'Name prefix (numbering will be appended):', renameDone: '{n} file(s) renamed',
      hashTitle: 'SHA-256 fingerprint', hashing: 'Computing fingerprint…', hashCopied: 'SHA-256 fingerprint copied ✓', hashFail: 'Could not compute the fingerprint',
      exportSettings: 'Export settings', importSettings: 'Import', settingsImported: 'Settings imported ✓', settingsImportFail: 'Invalid settings file',
      accentLabel: 'Accent colour', accentReset: 'Default',
      screenCapture: 'Capture screen', captureFailed: 'Screen capture failed', screenshotName: 'screen-capture',
      undo: 'Undo', fileRemoved: 'File removed', fileRestored: 'File restored ✓', lightboxAlt: 'Image preview',
      sortType: 'Type', bulkInvert: '⇄ Invert', expandAll: 'Expand all', collapseAll: 'Collapse all',
      queueSearch: 'Filter the queue…', estOptim: '≈ {size} after optimizing', rotate: 'Rotate',
      quotaNearFull: 'This destination’s quota is almost full.',
      imgQrAll: '▦ Combined QR', imgQrTooBig: 'Too many links to fit in one QR.', bulkShare: 'Share',
      onlineStatus: 'Online', offlineStatus: 'Offline', networkWifi: 'Wi-Fi', networkCellular: 'Mobile data',
      resendLastBatch: '↺ Resend last batch', lastBatchUnavailable: 'The last batch is no longer available locally.', lastBatchRestored: '{n} file(s) from the last batch restored ✓',
      copySummary: '⧉ Copy summary', shareResult: '📤 Share result', summaryCopied: 'Summary copied ✓', noSummary: 'No transfer summary is available.',
      privacyNames: 'Hide sensitive file names', privacyFile: 'File {n}',
      confirmMobileData: 'Confirm large uploads on mobile data', mobileDataConfirm: 'Send {size} using mobile data?',
      optimizePreset: 'Preset', presetHigh: 'High quality', presetMessaging: 'Messaging', presetSaver: 'Data saver', presetCustom: 'Custom',
      preview: 'File preview', cropSquare: 'Crop 1:1', crop43: 'Crop 4:3', crop169: 'Crop 16:9',
      swipeRemove: 'Swipe left: remove', swipeRetry: 'Swipe right: retry', swipePause: 'Swipe right: pause/resume',
      moveEarlier: 'Move earlier in queue', moveLater: 'Move later in queue'
    },
    es: {
      title: 'Enviar', navMain: 'Navegación principal', navSend: 'Enviar', navSendHint: 'Preparar y enviar archivos a un destino.', navImages: 'Imágenes', navImagesHint: 'Crear, gestionar y supervisar enlaces de imagen.', navActivity: 'Actividad', navActivityHint: 'Consultar el historial local de transferencias.', navSettings: 'Ajustes', navSettingsHint: 'Configurar la PWA, la seguridad y el almacenamiento.', navShares: 'Compartir', navSharesHint: 'Crear enlaces para compartir desde archivos de tu servidor.', sharesTitle: 'Compartir archivos del servidor', sharesHint: 'Explora los archivos de tu servidor y crea enlaces directos para compartir.', sharesAdminRequired: 'Inicia sesión con una cuenta de administrador para explorar los archivos del servidor.', sharesSignIn: 'Iniciar sesión como administrador', sharesBrowse: 'Archivos del servidor', sharesUp: 'Carpeta superior', sharesCreate: 'Crear el recurso compartido', sharesNoneSelected: 'Ningún archivo seleccionado.', sharesSelected: '{n} elemento(s) seleccionado(s)', sharesExpiry: 'Caducidad', sharesExpiryNever: 'Nunca', sharesExpiry1h: '1 hora', sharesExpiry1d: '1 día', sharesExpiry7d: '7 días', sharesExpiry30d: '30 días', sharesMaxDownloads: 'Descargas máx. (0 = ilimitado)', sharesPassword: 'Contraseña (opcional)', sharesPasswordPlaceholder: '—', sharesCreateBtn: 'Crear enlace para compartir', sharesCreating: 'Creando…', sharesCreated: 'Recurso creado ✓', sharesCreateFail: 'No se pudo crear el recurso', sharesLibrary: 'Tus recursos compartidos', sharesEmpty: 'Aún no hay recursos compartidos.', sharesBrowseFail: 'No se pudo leer esta carpeta.', sharesLoginNeeded: 'Se requiere inicio de sesión de administrador.', sharesOpen: 'Abrir', sharesCopy: 'Copiar', sharesRevoke: 'Revocar', sharesRevoked: 'Recurso revocado ✓', sharesRevokeFail: 'No se pudo revocar', sharesRevokeConfirm: '¿Revocar este recurso compartido? El enlace dejará de funcionar.', sharesItems: '{n} elemento(s)', sharesReceptions: 'Enlaces de recepción', sharesReceptionsEmpty: 'No hay enlaces de recepción.', sharesReceived: '{bytes} recibidos', openAdmin: 'Abrir la administración', language: 'Idioma', theme: 'Tema', copyLink: 'Copiar enlace', pasteLink: 'Pegar enlace', editDestination: 'Editar destino', addDestination: 'Añadir destino', passwordPlaceholder: 'Contraseña del enlace', destinationPlaceholder: 'Enlace o token de recepción', destinationNamePlaceholder: 'Nombre opcional del destino', senderPlaceholder: 'Nombre solicitado por este enlace', globalProgress: 'Progreso global', keyPlaceholder: 'Clave de cifrado del enlace', titlePlaceholder: 'Contenido compartido', pairedBadge: 'Dispositivo vinculado', themeDark: 'Oscuro', themeLight: 'Claro', themeAuto: 'Auto', install: 'Instalar', installIosHint: 'Para instalar Direct-Xfer, toca el botón Compartir del navegador y luego «Añadir a pantalla de inicio».', installBrowserHint: 'Chrome todavía no ha validado la instalación completa. No elijas un simple acceso directo: usa una dirección HTTPS de confianza, interactúa con la página y mantenla abierta unos instantes.', installHttpsRequired: 'La instalación completa no es posible desde esta dirección HTTP o certificado no confiable. Android solo puede crear un acceso directo. Abre Direct-Xfer mediante HTTPS con un certificado válido.', installSecurePending: 'La instalación se está preparando. En Chrome, interactúa con la página y mantenla abierta unos 30 segundos. Si el logotipo no aparece, verifica que Android confíe en el certificado HTTPS.', installOpenHttps: 'Abrir en HTTPS',
      offline: 'Sin conexión — los envíos continuarán al reconectarse.', updateReady: 'Hay una nueva versión disponible.', updateNow: 'Actualizar', pullToRefresh: 'Desliza hacia abajo para actualizar', releaseToRefresh: 'Suelta para actualizar', refreshing: 'Actualizando…', backExit: 'Pulsa de nuevo para salir', destination: 'Destino',
      destinationHint: 'Un enlace de recepción Direct-Xfer de esta instancia.', linkOrToken: 'Enlace o token', displayName: 'Nombre visible', rememberDestination: 'Recordar este destino en el dispositivo', rememberKey: 'Recordar también la clave secreta en este dispositivo',
      scanQr: '📷 Escanear QR', saveDestination: 'Añadir', updateDestination: 'Guardar', removeDestination: 'Quitar', cancel: 'Cancelar', createLinkTitle: 'Crear un enlace de recepción', newLink: 'Nuevo', createLinkName: 'Nombre del nuevo enlace', createLinkPlaceholder: 'ej. Fotos vacaciones', createLinkHint: 'Se creará un nuevo enlace de recepción y se añadirá a tus destinos. Compártelo para recibir archivos.', createDo: 'Crear enlace', creating: 'Creando…', createOk: 'Enlace creado ✓', createFail: 'No se pudo crear el enlace',
      imgLinksTitle: 'Enlaces de imagen', imgLinksHint: 'Crea enlaces directos a tus imágenes: cada enlace ofrece las versiones Completa, Mini y Micro, sin página intermedia.', imgLinksAdd: 'Añadir imágenes', imgCreateTitle: 'Crear enlaces', imgCreateHint: 'Elige tus imágenes y el formato que se mostrará primero.', imgLibraryTitle: 'Tus enlaces', imgLibraryHint: 'Busca, ordena y administra las imágenes ya compartidas.', imgGlobalActions: 'Acciones globales', imgCopyActions: 'Copiar un formato', imgManageActions: 'Administrar enlace', imgStripExif: 'Quitar datos EXIF/GPS antes de compartir', imgStripExifHint: 'La limpieza se realiza localmente en este dispositivo antes de subir la imagen.', imgStrippingMetadata: 'Quitando EXIF/GPS…', imgMetadataRemoved: 'EXIF/GPS eliminados', imgUploading: 'Subiendo…', imgThumbing: 'Mini y Micro…', imgReady: 'Listo', imgCopyFull: '🔗 Tamaño completo', imgCopyThumb: '🔗 Mini', imgCopyMicro: '🔗 Micro', imgCopied: 'Enlace copiado ✓', imgLinkFail: 'No se pudo crear el enlace', revokeShare: 'Revocar', revokeConfirm: '¿Revocar este recurso compartido? El enlace dejará de funcionar.', revokeSuccess: 'Revocado ✓', revokeFail: 'No se pudo revocar', imgVariantFull: 'Completa', imgVariantMini: 'Mini', imgVariantMicro: 'Micro', imgViews: '{n} vistas', imgVisitors: '{n} visitantes', imgStatsLoading: 'Estadísticas…', imgStatsUnavailable: 'Estadísticas no disponibles',
      imgSearch: 'Buscar imágenes…', imgSortLabel: 'Ordenar imágenes', imgSortNewest: 'Más recientes', imgSortOldest: 'Más antiguas', imgSortName: 'Nombre', imgSortSize: 'Tamaño', imgSortViews: 'Vistas', imgSortVisitors: 'Visitantes', imgSortExpiry: 'Caducidad', imgFilterLabel: 'Filtrar imágenes', imgFilterAll: 'Todas', imgFilterActive: 'Activas', imgFilterPopular: 'Populares', imgFilterLarge: 'Grandes', imgFilterExpiring: 'Próximas a caducar', imgFilterFavorite: 'Favoritas', imgFilterProtected: 'Protegidas', imgDefaultVariantLabel: 'Tamaño de imagen favorito', imgAdvancedOptions: 'Opciones de imágenes', imgCompact: 'Vista compacta', imgHideExpired: 'Ocultar imágenes caducadas', imgAutoCopy: 'Copiar automáticamente al crear', imgDefaultExpiry: 'Caducidad favorita', imgMaxViews: 'Límite de vistas', imgPassword: 'Contraseña', imgTags: 'Etiquetas', imgPrivateNote: 'Nota privada', imgRenameTemplate: 'Plantilla de nombre', imgBulkEdit: 'Editar', imgCreateAlbum: 'Crear álbum', imgDashboard: 'Gráfico de estadísticas', imgAlbums: 'Álbumes compartibles', imgActionHistory: 'Historial de acciones de imagen', imgSelected: '{n} seleccionada(s)', imgEditPrompt: 'Editar imágenes seleccionadas', imgAlbumName: 'Nombre del álbum', imgAlbumCreated: 'Álbum creado ✓', imgSettingsSaved: 'Ajustes guardados ✓', imgDuplicateFound: 'Esta imagen ya fue compartida. ¿Continuar?', imgExpirySoon: 'El enlace «{name}» caduca pronto.', imgUndoRevoke: 'Imagen retirada — ¿Deshacer?', imgRevokePending: 'Revocación en unos segundos…', imgQrDownloaded: 'QR descargado ✓', imgFavorite: 'Favorita', imgUnfavorite: 'Quitar de favoritas', imgExpired: 'Caducada', imgInactive: 'Inactiva', imgViewLimitReached: 'Límite de vistas alcanzado', imgProtected: 'Protegida', imgViewLimit: '{n} vistas máx.', imgNoAlbums: 'No hay álbumes.', imgVariantAuto: 'Automático', imgReplace: 'Reemplazar sin cambiar el enlace', imgVersions: 'Versiones', imgReplaceDone: 'Imagen reemplazada, URL conservada ✓', imgResizeMini: 'Redimensionar la Mini', imgResizeMiniPrompt: 'Nuevo tamaño de la Mini: un número de píxeles (lado más largo, ej. 250) O un porcentaje del tamaño total (ej. 50%). La Micro será la mitad:', imgResizeMiniInvalid: 'Valor no válido: píxeles (16 a 4096) o porcentaje (1 a 100%).', imgResizeMiniDone: 'Mini redimensionada a {w}×{h} ✓', imgRestoreVersion: 'Restaurar una versión', imgVersionRestored: 'Versión restaurada ✓', imgAdaptiveReady: 'Optimización adaptativa', albumInvites: 'Invitaciones', albumInviteCreate: 'Crear invitación', albumInviteRole: 'Rol (reader, contributor, manager)', albumInviteCopied: 'Enlace de invitación copiado ✓', albumInviteRevoke: 'Revocar invitación', albumCollabSummary: '{n} invitación(es)', imgAlbumCopied: 'Enlace del álbum copiado ✓', imgChartSummary: '{images} imágenes · {views} vistas · {visitors} visitantes · {bytes}', imgHotlinkHosts: 'Dominios autorizados para integrar', imgHotlinkPlaceholder: 'foro.ejemplo.com, *.sitio.net', imgHotlinkHint: 'Vacío = protección desactivada. Las visitas directas siguen permitidas.', imgHotlinkProtected: 'Protección hotlink', imgNotifyFirstView: 'Notificar en la primera visita', imgFirstViewArmed: 'Alerta de primera visita', imgFirstViewSent: 'Primera visita notificada', imgFirstViewToast: '👁 Primera visita de «{name}»', imgSmartBlur: 'Desenfoque inteligente local', imgSmartBlurFaces: 'Rostros', imgSmartBlurFacesPlates: 'Rostros y matrículas', imgSmartBlurHint: 'Análisis local con revisión antes del envío; ninguna imagen se envía a un servicio externo.', imgSmartBlurAnalyzing: 'Análisis local…', imgSmartBlurReady: '{n} zona(s) ocultada(s). Revísalas y aplica.', imgSmartBlurUnsupported: 'Este navegador no admite la detección de rostros; añade las zonas manualmente.', imgSmartBlurSkip: 'Continuar sin desenfoque', imgRetentionRules: 'Reglas automáticas de retención', imgRetentionWarning: 'Estas reglas revocan definitivamente las imágenes y borran sus archivos. Están desactivadas por defecto.', imgRetentionAge: 'Edad máxima (días)', imgRetentionInactive: 'Inactividad máxima (días)', imgRetentionViews: 'Revocar tras este número de vistas', imgRetentionStorage: 'Almacenamiento máximo (MB)', imgRetentionSave: 'Guardar y aplicar', imgRetentionSaved: 'Reglas de retención guardadas ✓', imgRetentionResult: '{n} imagen(es) revocada(s) · {bytes} liberados', imgRetentionSummary: '{n} imagen(es) · {bytes}', enabled: 'Activado', disabled: 'Desactivado', optional: 'Opcional', refresh: 'Actualizar', themeSchedule: 'Según la hora', protectedLink: '🔒 Enlace protegido', unlock: 'Desbloquear',
      encryptedLink: '🔐 Cifrado de extremo a extremo', encryptionKey: 'Clave del enlace', passphrase: 'Frase secreta', addFiles: 'Añadir archivos',
      durableQueue: 'Los archivos se copian al almacenamiento duradero antes del envío para poder reanudarlos tras cerrar la PWA.', takePhoto: 'Tomar una foto', chooseFiles: 'Elegir archivos',
      chooseFolder: 'Elegir carpeta', optimizePhotos: 'Optimizar fotos antes de enviar', parallelUploads: 'Envíos paralelos', senderName: 'Tu nombre', pause: 'Pausa', resume: 'Continuar',
      retryAll: '↻ Reintentar', removePending: 'Quitar todo', send: 'Enviar', clearCompleted: 'Borrar envíos terminados', history: 'Historial local', clearHistory: 'Borrar historial',
      settings: 'Ajustes y seguridad', autoResume: 'Continuar automáticamente tras cerrar o reconectar', storage: 'Almacenamiento local', protectStorage: 'Proteger', deviceAccess: 'Acceso del dispositivo', deviceChecking: 'Comprobando el dispositivo…', deviceStatusUnavailable: 'El estado del dispositivo no está disponible. Toca Vincular para volver a intentarlo.',
      pairDevice: 'Vincular este dispositivo', unpairDevice: 'Desvincular este dispositivo', pairOther: 'Vincular por QR', pairOtherTitle: 'Vincular otro dispositivo', pairOtherHelp: 'Escanea este QR en el otro dispositivo. El enlace es de un solo uso y caduca en cinco minutos.', pairQrAlt: 'Código QR para vincular el dispositivo', pairLink: 'Enlace de vinculación', pairExpires: 'Caduca a las {date}', pairQrFailed: 'No se pudo crear el código QR', copy: 'Copiar', revokeDevice: 'Revocar', pairedDevices: 'Dispositivos vinculados', clearLocalData: 'Borrar todos los datos locales', closeSession: 'Cerrar sesión', closeSessionConfirm: '¿Cerrar la sesión en este dispositivo? Se conservarán las transferencias, imágenes y el historial local.', closingSession: 'Cerrando sesión…', closeSessionFailed: 'No se pudo cerrar la sesión. Inténtalo de nuevo.', companionApp: 'aplicación complementaria',
      qrHint: 'Apunta a un QR de enlace de recepción…', close: 'Cerrar', noLink: '— Sin enlace —', addLinkHint: 'Añade un enlace con el botón ＋.', checking: 'Comprobando…',
      ready: '✓ Listo para recibir', locked: '🔒 Enlace protegido — desbloquéalo', revoked: '✗ Enlace revocado o caducado', offlineServer: '⚠ Servidor inaccesible', invalid: '✗ Enlace no encontrado',
      e2eKeyReady: 'La clave cifrará los archivos en este navegador.', e2eKeyMissing: 'Pega el enlace completo con #k=… o introduce la clave.', e2ePass: 'Introduce la frase secreta del enlace.',
      waiting: 'en espera', restoring: 'listo para reanudar', durableSaving: 'guardando localmente…', durableSaved: 'conservado al cerrar', durableMissing: 'falta la copia local', sending: 'enviando…', paused: 'en pausa', waitingNetwork: 'esperando red', encrypting: 'cifrando…', optimizing: 'optimizando…',
      done: 'enviado ✓', cancelled: 'cancelado', networkError: 'fallo de red', otherOrigin: 'Este enlace pertenece a otro origen.', useTokenQuestion: 'Este enlace viene de {from}. ¿Usar explícitamente su token en {to}?',
      invalidLink: 'Enlace o token no válido', duplicate: '{n} duplicado(s) ignorado(s)', queued: '{n} archivo(s) añadido(s)', removedConfirm: '¿Quitar este destino guardado?',
      clearQueueConfirm: '¿Quitar todos los archivos sin terminar?', clearDataConfirm: '¿Borrar destinos, cola, historial y ajustes locales?', historyEmpty: 'No hay envíos terminados en este dispositivo.',
      copied: 'Enlace copiado ✓', copyFailed: 'No se pudo copiar', pasteFailed: 'No se pudo acceder al portapapeles', qrFound: 'QR detectado ✓', qrUnknown: 'QR no reconocido',
      scanUnsupported: 'El escáner QR no está disponible. Pega el enlace.', cameraUnavailable: 'Cámara no disponible', unlockFailed: 'No se pudo desbloquear', senderRequired: 'Introduce tu nombre.',
      passRequired: 'Introduce la frase secreta.', keyRequired: 'Falta la clave de cifrado.', noCrypto: 'WebCrypto no está disponible.', quotaFile: 'El archivo supera el límite.',
      quotaTotal: 'El lote superaría la cuota restante.', quotaCount: 'Se superaría el máximo de archivos.', typeBlocked: 'Este tipo de archivo está rechazado.', fileTooLarge: 'demasiado grande',
      quotaFull: 'cuota alcanzada', maxFiles: 'máximo alcanzado', unavailable: 'enlace no disponible', infected: 'archivo infectado', error: 'error', batchResult: '{ok} enviado(s){fail}',
      failures: ', {n} fallo(s)', pauseRequested: 'Pausando…', resumed: 'Envíos reanudados', queueSummary: '{waiting} en espera · {size}', queueErrors: '{n} fallo(s)', queuePaused: '{n} en pausa',
      storageUnknown: 'Estimación no disponible', storageUsage: '{used} usados de {quota}', storageProtected: 'Almacenamiento persistente concedido', storageDenied: 'No se concedió almacenamiento persistente',
      deviceAdmin: 'Sesión de administrador activa. Puedes vincular el dispositivo con acceso solo a la PWA.', devicePaired: 'Este dispositivo tiene un token limitado a /app.',
      deviceUnpaired: 'No vinculado. Se necesita una sesión de administrador una vez.', devicePairedOk: 'Dispositivo vinculado ✓', deviceRevoked: 'Acceso revocado', devicePairFailed: 'No se pudo vincular',
      deviceRevokeFailed: 'No se pudo revocar', deviceCurrent: 'este dispositivo', deviceLast: 'Último uso {date}', localCleared: 'Datos locales borrados', sharedTextName: 'compartido.txt',
      renameDevice: 'Renombrar', renameDevicePrompt: 'Nuevo nombre del dispositivo:', deviceRenamed: 'Dispositivo renombrado ✓', deviceRenameFailed: 'No se pudo renombrar',
      sharedReceived: '{n} elemento(s) compartido(s) añadido(s) ✓', resumedQueue: 'Cola restaurada: {n} archivo(s)', optimizeFallback: 'No se puede convertir esta imagen; se enviará el original.',
      heicFallback: 'La conversión HEIC depende del navegador.', renameLocked: 'El nombre se bloquea al empezar el envío.', noPending: 'No hay archivos para enviar.',
      destinationLocked: 'El destino queda bloqueado hasta terminar el lote.', authExpired: 'La sesión caducó; el lote compartido sigue guardado.', retry: 'Reintentar', remove: 'Quitar', edit: 'Editar',
      progress: 'Progreso de {name}', clearHistoryConfirm: '¿Borrar el historial local?', storageRequest: 'Solicitud de almacenamiento persistente enviada.', sessionOnly: 'Este destino solo durará esta sesión.',
      largeFileSessionOnly: '{n} archivo(s) no pudieron copiarse al almacenamiento duradero. Mantén la PWA abierta hasta terminar.', fileSessionOnly: 'no conservado al cerrar',
      startingUpload: 'iniciando envío…', shrinkingChunk: 'adaptando a la red…', rateLimited: 'demasiadas solicitudes — pausa…', uploadStalled: 'La transferencia no puede iniciarse. Revisa el límite de tamaño y el búfer de solicitudes del proxy inverso y vuelve a intentarlo.',
      diagBadgeTimeout: 'tiempo agotado', diagBadgeNetwork: 'red (rechazada)', diagBadgeNetCut: 'red (cortada)',
      diagNetRefused: 'la conexión falló antes de enviar nada ({s}s) — solicitud bloqueada/rechazada: proxy inaccesible en esta ruta, regla CORS/cortafuegos, o se requiere HTTPS.', diagNetCut: 'la conexión se cortó al enviar el bloque ({s}s) — el proxy o el servidor cierra ante un cuerpo de solicitud demasiado grande (buffering/límite de tamaño del proxy).',
      diagBadgePostBlock: 'POST bloqueado', diagPostBlocked: 'el servidor responde (GET OK) pero el POST de subida es rechazado — un proxy/WAF bloquea los POST grandes o la ruta /u/…/upload. Revisa client_max_body_size, el buffering del proxy y las reglas WAF/ModSecurity.', diagNoConnect: 'sin respuesta del servidor, ni siquiera a un GET simple — conectividad, DNS o proxy caído desde el móvil en ese momento.',
      diagBadgeFileRead: 'archivo ilegible', diagFileUnreadable: 'no se pudo leer el archivo en este dispositivo (la subida falla antes de enviar ningún byte). Frecuente en móvil con un archivo muy grande: reabre la PWA y vuelve a elegir el archivo (con “Elegir archivos”, no un acceso de compartir), evita poner la app en segundo plano durante la subida, o cópialo primero al almacenamiento local del teléfono.',
      diagProxyLimit: 'el proxy inverso rechaza el tamaño de la solicitud (client_max_body_size / límite demasiado bajo).', diagRateLimited: 'demasiadas solicitudes — límite de velocidad alcanzado (se respeta Retry-After).',
      diagTimeout: 'sin respuesta dentro del tiempo límite — el proxy probablemente almacena en búfer la solicitud.', diagGateway: 'el proxy devolvió un error de puerta de enlace (HTTP {s}) — backend inaccesible, o timeout/búfer del proxy.',
      diagServerError: 'error del servidor (HTTP {s}).', diagSync: 'desfase del offset entre la app y el servidor.', diagHttp: 'respuesta inesperada del servidor (HTTP {s}).', diagNetwork: 'conexión interrumpida antes de la respuesta (Wi-Fi/datos móviles o el proxy la cerró).',
      diagServerWrite: 'el servidor no pudo escribir el archivo (disco lleno o carpeta de recepción).', diagServerSync: 'offset de bloque desincronizado.', diagServerBusy: 'demasiados envíos simultáneos en el servidor.', diagServerDropped: 'la conexión se cortó del lado del servidor.',
      maxFile: 'máx. {size}/archivo', filesLeft: '{left}/{total} archivos', spaceLeft: '{left} libres / {total}', folderUnsupported: 'La selección de carpetas no está disponible.',
      deviceName: 'PWA Direct-Xfer en {platform}', revokeThisDeviceConfirm: '¿Revocar el acceso limitado de este dispositivo? Se borrarán los datos locales privados.', revokeOtherConfirm: '¿Revocar este dispositivo vinculado?', revokeDeviceSharesConfirm: '¿Revocar también todos los enlaces creados por este dispositivo?',
      updateApplied: 'Actualización aplicada.', historyDest: 'a {dest}', textSharedHeader: 'Contenido compartido', urlSharedHeader: 'URL compartida',
      help: 'Ayuda', shortcutsTitle: 'Atajos de teclado', shortcutSend: 'Enviar la cola', shortcutEsc: 'Cerrar un panel o ventana', shortcutHelp: 'Mostrar esta ayuda',
      sortBy: 'Ordenar', sortAdded: 'Orden de adición', sortName: 'Nombre', sortSize: 'Tamaño',
      imgCopyAll: '🔗 Copiar todos', imgOpen: 'Abrir en una pestaña', allImgCopied: '{n} enlace(s) copiado(s) ✓', noImgLinks: 'No hay enlaces para copiar.', imgCopyTemplate: 'Plantilla de copia', copyTemplateStandard: 'Estándar', copyTemplateForum: 'Foro', copyTemplateEmail: 'Correo', imgQrZip: '🗜 QR en ZIP', imgQrZipDone: 'Archivo de QR descargado ✓', imgExportStatsCsv: 'CSV de estadísticas', imgStatsCsvDone: 'Estadísticas exportadas ✓', imgFavoriteAction1: 'Acción favorita 1', imgFavoriteAction2: 'Acción favorita 2', imgFavoriteAction3: 'Acción favorita 3', imgActionCopy: 'Copiar', imgActionOpen: 'Abrir', imgQrDownload: 'Descargar QR', pinItem: 'Fijar', unpinItem: 'Desfijar', tagColors: 'Colores de etiquetas', tagColorsReset: 'Restablecer colores', expiresIn: 'Caduca en {time}', expiredNow: 'Caducado',
      shareLink: 'Compartir enlace', qrForLink: 'QR del enlace', qrTitle: 'QR del enlace de recepción', qrDestHelp: 'Escanea este código en otro dispositivo para abrir el enlace de recepción.', qrFail: 'No se pudo crear el código QR',
      receivedTitle: 'Contenido recibido', receivedHelp: 'Archivos recibidos en este enlace de recepción, servidos por el servidor.', receivedRefresh: 'Actualizar', receivedLoading: 'Cargando…', receivedEmpty: 'Aún no se ha recibido ningún archivo.', receivedFail: 'No se pudo cargar el contenido recibido.', receivedCount: '{n} archivo(s) · {size}', receivedDownload: 'Descargar',
      sessionStats: 'Esta sesión', sessionStatsValue: '{files} archivo(s) · {size} enviados', sessionStatsEmpty: 'Sin envíos durante esta sesión.',
      maintenance: 'Mantenimiento', checkUpdate: 'Buscar una actualización', checkingUpdate: 'Buscando…', updateFound: 'Actualización encontrada — preparando…', updateNone: 'Ya está actualizado ✓',
      copyDiag: 'Copiar el diagnóstico', diagCopied: 'Diagnóstico copiado ✓', diagNone: 'No se registró ningún error de envío.',
      vibrateFinish: 'Vibrar al terminar un envío', keepAwake: 'Mantener la pantalla encendida durante el envío', hapticFeedback: 'Respuesta háptica para acciones', advancedAccordion: 'Mantener una sola sección avanzada abierta', confirmRevoke: 'Confirmar revocaciones', confirmDelete: 'Confirmar eliminaciones', confirmReplace: 'Confirmar reemplazos y duplicados', storageWarningThreshold: 'Avisar a partir de', storageWarning: 'Almacenamiento local al {percent} %',
      historySearch: 'Buscar en el historial', historyCopy: 'Copiar los detalles', historyNoMatch: 'Sin resultados.', rateAvg: '{rate}/s med', queueEta: '~{eta}',
      sendCount: 'Enviar · {n} · {size}', imgQualityLabel: 'Calidad', imgSizeLabel: 'Tamaño máx.', imgOriginal: 'Original', qLow: 'Baja', qMed: 'Media', qHigh: 'Alta',
      autoClearDone: 'Borrar los terminados automáticamente', imgFormatLabel: 'Formato', imgDims: '{w}×{h} · {size}', exportHistory: 'Exportar', exportCsv: 'CSV', exportJson: 'JSON',
      lifetimeStats: 'Desde siempre', histToday: 'Hoy', histYesterday: 'Ayer',
      destLastUsed: 'usado {rel}', relNow: 'ahora mismo', relMin: 'hace {n} min', relHour: 'hace {n} h', relDay: 'hace {n} d',
      moveUp: '↑ Subir', moveDown: '↓ Bajar', shareApp: 'Compartir la aplicación', appShareText: 'Envíame archivos con Direct-Xfer',
      soundFinish: 'Sonido al terminar un envío', densityLabel: 'Densidad', densityNormal: 'Normal', densityCompact: 'Compacta', storageBarLabel: 'Almacenamiento local usado',
      wifiOnly: 'Enviar solo con Wi-Fi', waitingWifi: 'esperando Wi-Fi', stripExif: 'Quitar metadatos (EXIF/GPS)',
      zipBundle: '🗜 Agrupar en ZIP', zipDone: 'Archivo ZIP creado ✓', zipNeedTwo: 'Selecciona al menos dos archivos.', zipping: 'Creando ZIP…',
      voiceNote: 'Nota de voz', recording: 'Grabando', recStop: '⏹ Detener', recAdd: 'Añadir a la cola', recMicFail: 'Micrófono no disponible',
      annotate: 'Anotar', annPen: '✏️ Lápiz', annBlur: '🌫 Desenfoque', annDetectFaces: '🙂 Detectar rostros', annDetectPlates: '▭ Detectar matrículas', annUndo: '↶ Deshacer', annClear: 'Borrar todo', annApply: 'Aplicar',
      selectedN: '{n} seleccionado(s)', bulkRemove: 'Quitar', bulkRetry: 'Reintentar', selectAll: 'Todo',
      batchNote: 'Etiqueta / nota (opcional)', notePlaceholder: 'ej. Factura, Vacaciones…',
      multiSend: '📢 Enviar a varios…', multiSendTitle: 'Enviar a varias destinaciones', multiSendHelp: 'El lote se envía a cada destino marcado. Se omiten los enlaces cifrados o que requieren un nombre.', multiSendGo: 'Iniciar envíos', multiSendNone: 'No hay destino compatible seleccionado.', multiSendQueued: 'Envío a {n} destino(s) preparado.',
      cmdPalette: 'Paleta de comandos', cmdPlaceholder: 'Escribe un comando…', cmdNoMatch: 'Sin comandos.', cmdOpenSettings: 'Abrir ajustes', cmdOpenHistory: 'Abrir el historial', cmdToggleTheme: 'Cambiar tema',
      expireLabel: 'Caducidad (auto-borrado)', expNever: 'Nunca', exp1h: '1 hora', exp24h: '24 horas', exp7d: '7 días', exp30d: '30 días',
      liveTitle: 'Recepciones en vivo', liveReceived: '📥 {name} recibido en «{dest}»', liveEnable: 'Notificaciones de recepción', livePush: 'Notificaciones push (app cerrada)', livePushOn: 'Notificaciones push activadas ✓', livePushOff: 'Notificaciones push desactivadas', livePushFail: 'No se pudieron activar las notificaciones', liveConnected: 'En vivo ✓',
      copyToken: 'Copiar token', tokenCopied: 'Token copiado ✓',
      pinDestination: '⭐ Fijar', unpinDestination: '☆ Soltar', pinned: 'Destino fijado ✓', unpinned: 'Destino soltado',
      resetBatch: '↺ Restablecer lote', resetBatchDone: 'Opciones del lote restablecidas ✓',
      filesPending: '{n} en espera', pasteText: 'Pegar texto', pastedTextName: 'texto-pegado.txt', pasteTextEmpty: 'No hay texto en el portapapeles.',
      masterSelect: 'Seleccionar todo', addFromUrl: 'Desde una URL', urlPrompt: 'Dirección de la imagen o archivo a añadir:', urlFetching: 'Obteniendo…', urlFailed: 'No se pudo obtener (¿bloqueado por CORS?)', urlAdded: 'Archivo añadido ✓', urlInvalid: 'Dirección no válida.',
      bulkRename: '✎ Renombrar', renamePrompt: 'Prefijo de los nombres (se añadirá numeración):', renameDone: '{n} archivo(s) renombrado(s)',
      hashTitle: 'Huella SHA-256', hashing: 'Calculando huella…', hashCopied: 'Huella SHA-256 copiada ✓', hashFail: 'No se pudo calcular la huella',
      exportSettings: 'Exportar ajustes', importSettings: 'Importar', settingsImported: 'Ajustes importados ✓', settingsImportFail: 'Archivo de ajustes no válido',
      accentLabel: 'Color de acento', accentReset: 'Predeterminado',
      screenCapture: 'Capturar pantalla', captureFailed: 'No se pudo capturar la pantalla', screenshotName: 'captura-pantalla',
      undo: 'Deshacer', fileRemoved: 'Archivo retirado', fileRestored: 'Archivo restaurado ✓', lightboxAlt: 'Vista previa de la imagen',
      sortType: 'Tipo', bulkInvert: '⇄ Invertir', expandAll: 'Desplegar todo', collapseAll: 'Plegar todo',
      queueSearch: 'Filtrar la cola…', estOptim: '≈ {size} tras optimizar', rotate: 'Girar',
      quotaNearFull: 'La cuota de este destino está casi llena.',
      imgQrAll: '▦ QR combinado', imgQrTooBig: 'Demasiados enlaces para un solo QR.', bulkShare: 'Compartir',
      onlineStatus: 'En línea', offlineStatus: 'Sin conexión', networkWifi: 'Wi-Fi', networkCellular: 'Datos móviles',
      resendLastBatch: '↺ Reenviar el último lote', lastBatchUnavailable: 'El último lote ya no está disponible localmente.', lastBatchRestored: '{n} archivo(s) del último lote restaurado(s) ✓',
      copySummary: '⧉ Copiar resumen', shareResult: '📤 Compartir resultado', summaryCopied: 'Resumen copiado ✓', noSummary: 'No hay resumen de transferencia disponible.',
      privacyNames: 'Ocultar nombres de archivos sensibles', privacyFile: 'Archivo {n}',
      confirmMobileData: 'Confirmar envíos grandes con datos móviles', mobileDataConfirm: '¿Enviar {size} usando datos móviles?',
      optimizePreset: 'Preajuste', presetHigh: 'Alta calidad', presetMessaging: 'Mensajería', presetSaver: 'Ahorro de datos', presetCustom: 'Personalizado',
      preview: 'Vista previa del archivo', cropSquare: 'Recortar 1:1', crop43: 'Recortar 4:3', crop169: 'Recortar 16:9',
      swipeRemove: 'Deslizar a la izquierda: quitar', swipeRetry: 'Deslizar a la derecha: reintentar', swipePause: 'Deslizar a la derecha: pausa/reanudar',
      moveEarlier: 'Subir en la cola', moveLater: 'Bajar en la cola'
    }
  };

  var lang = 'fr';
  function detectLang() {
    var saved = '';
    try { saved = localStorage.getItem('dx-pwa-lang') || ''; } catch (_) {}
    var v = saved || (navigator.language || 'fr').slice(0, 2).toLowerCase();
    return STRINGS[v] ? v : 'fr';
  }
  function t(key, vars) {
    var s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.fr[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k])); });
    return s;
  }
  function applyLanguage(next) {
    lang = STRINGS[next] ? next : 'fr';
    document.documentElement.lang = lang;
    try { localStorage.setItem('dx-pwa-lang', lang); } catch (_) {}
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n'); if (STRINGS[lang][key]) el.textContent = STRINGS[lang][key];
    });
    [['data-i18n-placeholder', 'placeholder'], ['data-i18n-title', 'title'], ['data-i18n-aria', 'aria-label']].forEach(function (pair) {
      document.querySelectorAll('[' + pair[0] + ']').forEach(function (el) {
        var key = el.getAttribute(pair[0]); if (STRINGS[lang][key]) el.setAttribute(pair[1], STRINGS[lang][key]);
      });
    });
    var manifest = document.getElementById('app-manifest');
    if (manifest) manifest.href = (lang === 'fr' ? '/direct-xfer-pwa.webmanifest' : '/direct-xfer-pwa-' + lang + '.webmanifest') + '?v=111';
    $('lang-select').value = lang;
    $('dest-save-btn').textContent = editingToken ? t('updateDestination') : t('saveDestination');
    renderDests(); renderQueue(); renderHistory(); renderDeviceStatus();
    if (typeof updateSessionStats === 'function') updateSessionStats();
    if (typeof updateSendBtn === 'function') updateSendBtn();
    if (typeof updateToggleCardsLabel === 'function') updateToggleCardsLabel();
    if (typeof activatePwaPanel === 'function') activatePwaPanel(activePwaPanel, { keepScroll: true, instant: true });
  }

  var activePwaPanel = 'send';
  var PWA_PANEL_KEYS = {
    send: { label: 'navSend', hint: 'navSendHint' },
    images: { label: 'navImages', hint: 'navImagesHint' },
    shares: { label: 'navShares', hint: 'navSharesHint' },
    activity: { label: 'navActivity', hint: 'navActivityHint' },
    settings: { label: 'navSettings', hint: 'navSettingsHint' }
  };

  function updatePwaNavBadges() {
    var sendCount = items ? items.filter(function (item) { return item && item.status !== 'done'; }).length : 0;
    var imageCount = document.querySelectorAll('#imglink-list .imglink-row').length;
    var historyCount = historyEntries ? historyEntries.length : 0;
    [
      ['nav-send-badge', sendCount],
      ['nav-images-badge', imageCount],
      ['nav-shares-badge', activeShareCount],
      ['nav-activity-badge', historyCount]
    ].forEach(function (entry) {
      var badge = $(entry[0]);
      if (!badge) return;
      var count = Number(entry[1]) || 0;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.toggle('hidden', count < 1);
    });
  }

  function activatePwaPanel(panel, options) {
    options = options || {};
    if (!PWA_PANEL_KEYS[panel]) panel = 'send';
    activePwaPanel = panel;
    // Remember the open tab so a pull-to-refresh (location.reload) restores it instead of
    // always snapping back to Send. Session-scoped: a fresh app launch still starts on Send.
    try { sessionStorage.setItem('dx-pwa-active-panel', panel); } catch (_) {}
    document.body.setAttribute('data-pwa-active-panel', panel);
    document.querySelectorAll('[data-pwa-panel]').forEach(function (node) {
      node.classList.toggle('pwa-panel-hidden', node.getAttribute('data-pwa-panel') !== panel);
    });
    document.querySelectorAll('[data-pwa-nav]').forEach(function (button) {
      var active = button.getAttribute('data-pwa-nav') === panel;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    var meta = PWA_PANEL_KEYS[panel];
    if ($('pwa-panel-kicker')) $('pwa-panel-kicker').textContent = t(meta.label);
    if ($('pwa-panel-summary')) $('pwa-panel-summary').textContent = t(meta.hint);
    if (panel === 'activity' && $('history-card')) $('history-card').open = true;
    if (panel === 'settings' && $('settings-card')) $('settings-card').open = true;
    if (panel === 'images') {
      refreshImageStats(false).catch(function () {});
      refreshAlbums().catch(function () {});
    }
    if (panel === 'shares') { onSharesPanelShown(); }
    if (!options.keepScroll) {
      var scroller = document.querySelector('.wrap');
      if (scroller) scroller.scrollTo({ top: 0, behavior: options.instant ? 'auto' : 'smooth' });
    }
    updatePwaNavBadges();
  }

  function initPwaNavigation() {
    document.querySelectorAll('[data-pwa-nav]').forEach(function (button) {
      button.addEventListener('click', function () { activatePwaPanel(button.getAttribute('data-pwa-nav')); });
    });
    ['up-list', 'imglink-list', 'history-list'].forEach(function (id) {
      var target = $(id);
      if (target && 'MutationObserver' in window) {
        new MutationObserver(updatePwaNavBadges).observe(target, { childList: true, subtree: true });
      }
    });
    // Restore the tab that was open before a refresh; default to Send on a fresh session.
    var savedPanel = '';
    try { savedPanel = sessionStorage.getItem('dx-pwa-active-panel') || ''; } catch (_) {}
    activatePwaPanel(PWA_PANEL_KEYS[savedPanel] ? savedPanel : 'send', { keepScroll: true, instant: true });
  }

  function prefBool(key, fallback) {
    try { var value = localStorage.getItem(key); return value === null ? fallback : value === '1'; } catch (_) { return fallback; }
  }
  function haptic(kind) {
    if (!navigator.vibrate || !prefBool('dx-pwa-haptic', true)) return;
    var pattern = kind === 'success' ? [18, 24, 28] : kind === 'warning' ? [45, 35, 45] : 12;
    try { navigator.vibrate(pattern); } catch (_) {}
  }
  function confirmationEnabled(kind) {
    return prefBool('dx-pwa-confirm-' + kind, true);
  }
  function askConfirmation(kind, message) {
    return !confirmationEnabled(kind) || window.confirm(message);
  }
  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.className = ''; }, 3600);
    if (kind === 'ok') haptic('success'); else if (kind === 'warn' || kind === 'err') haptic('warning');
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  // Smoothed transfer rate (bytes/s) via an exponential moving average. `state` is a
  // plain object carrying the last sample; sampling at most ~3×/s keeps the reading
  // steady across the many tiny 768 KiB blocks (an instantaneous per-block rate is
  // far too jumpy on mobile, and often never shows at all when a block finishes in
  // under 0.4 s). Reset by passing a fresh {}.
  function emaRate(state, bytes) {
    var now = Date.now();
    if (!state.t) { state.t = now; state.b = bytes; return state.ema || 0; }
    var dt = (now - state.t) / 1000;
    if (dt < 0.35) return state.ema || 0;
    var inst = Math.max(0, bytes - state.b) / dt;
    state.ema = state.ema ? state.ema * 0.65 + inst * 0.35 : inst;
    state.t = now; state.b = bytes;
    return state.ema;
  }
  function fmtBytes(bytes) {
    if (bytes == null || !isFinite(bytes)) return '—';
    var units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
    var n = Number(bytes), i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + units[i];
  }
  function fmtEta(sec) {
    sec = Math.max(0, Math.ceil(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return '~' + (h ? h + 'h ' : '') + (m ? m + 'min ' : '') + s + 's';
  }
  function fmtDate(ms) {
    try { return new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms)); }
    catch (_) { return new Date(ms).toLocaleString(); }
  }
  function genId(bytes) {
    var alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var arr = new Uint8Array(bytes || 24);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(arr);
    else for (var j = 0; j < arr.length; j++) arr[j] = Math.floor(Math.random() * 256);
    var out = '';
    for (var i = 0; i < arr.length; i++) out += alpha[arr[i] & 63];
    return out;
  }
  function extOf(name) {
    var base = String(name || '').split('/').pop();
    var i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1).toLowerCase() : '';
  }
  function safeName(name) {
    var s = String(name || 'file').replace(/[\\\x00-\x1f]/g, '_').replace(/^\.+$/, 'file').trim();
    return s || 'file';
  }
  function copyText(text) {
    var action;
    if (navigator.clipboard && navigator.clipboard.writeText) action = navigator.clipboard.writeText(text);
    else action = new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-only';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); resolve();
      } catch (e) { reject(e); }
    });
    return action.then(function (value) { haptic('light'); return value; });
  }
  function namedFile(blob, name, type, lastModified) {
    try { return new File([blob], name, { type: type || blob.type || 'application/octet-stream', lastModified: lastModified || Date.now() }); }
    catch (_) { blob.name = name; return blob; }
  }
  function isMobileLike() {
    try {
      if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
      if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent || '')) return true;
      if (navigator.maxTouchPoints > 1 && Math.min(screen.width || innerWidth, screen.height || innerHeight) < 1100) return true;
      return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 900);
    } catch (_) { return false; }
  }
  function connectionInfo() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }
  function isCellularConnection() {
    var c = connectionInfo();
    return !!(c && String(c.type || '').toLowerCase() === 'cellular');
  }
  function installPullToRefresh() {
    var scroller = document.querySelector('.wrap');
    var indicator = $('pull-refresh');
    if (!scroller || !indicator || !('ontouchstart' in window)) return;
    var text = indicator.querySelector('.pull-refresh-text');
    var startY = 0, distance = 0, tracking = false;
    var threshold = 86, maxDistance = 145;
    function atTop() { return scroller.scrollTop <= 0; }
    function reset() {
      tracking = false; distance = 0;
      indicator.classList.remove('visible', 'ready', 'refreshing');
      indicator.style.setProperty('--pull-distance', '0px');
      indicator.setAttribute('aria-hidden', 'true');
      if (text) text.textContent = t('pullToRefresh');
    }
    scroller.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1 || !atTop() || event.target.closest('input, select, button, textarea, a, [contenteditable]')) return;
      startY = event.touches[0].clientY; distance = 0; tracking = true;
    }, { passive: true });
    scroller.addEventListener('touchmove', function (event) {
      if (!tracking || event.touches.length !== 1) return;
      var raw = event.touches[0].clientY - startY;
      if (raw <= 0 || !atTop()) { reset(); return; }
      distance = Math.min(maxDistance, raw * .62);
      if (distance < 7) return;
      event.preventDefault();
      indicator.classList.add('visible');
      indicator.classList.toggle('ready', distance >= threshold);
      indicator.style.setProperty('--pull-distance', distance + 'px');
      indicator.setAttribute('aria-hidden', 'false');
      if (text) text.textContent = t(distance >= threshold ? 'releaseToRefresh' : 'pullToRefresh');
    }, { passive: false });
    scroller.addEventListener('touchend', function () {
      if (!tracking) return;
      var shouldRefresh = distance >= threshold;
      tracking = false;
      if (!shouldRefresh) { reset(); return; }
      indicator.classList.add('refreshing');
      indicator.classList.remove('ready');
      indicator.style.setProperty('--pull-distance', '92px');
      if (text) text.textContent = t('refreshing');
      setTimeout(function () { location.reload(); }, 180);
    }, { passive: true });
    scroller.addEventListener('touchcancel', reset, { passive: true });
  }

  function updateNetworkIndicator() {
    var pill = $('network-pill'), text = $('network-text');
    if (!pill || !text) return;
    var online = navigator.onLine !== false;
    var c = connectionInfo();
    var detail = '';
    if (online && c) {
      if (String(c.type || '').toLowerCase() === 'wifi') detail = t('networkWifi');
      else if (String(c.type || '').toLowerCase() === 'cellular') detail = t('networkCellular');
      else if (c.effectiveType) detail = String(c.effectiveType).toUpperCase();
    }
    text.textContent = online ? t('onlineStatus') + (detail ? ' · ' + detail : '') : t('offlineStatus');
    pill.classList.toggle('offline', !online);
    pill.title = text.textContent;
  }
  function privateFileName(index) {
    return t('privacyFile', { n: Number(index || 0) + 1 });
  }
  function displayFileName(it, index) {
    return privacyNames ? privateFileName(index) : (it && it.name || '');
  }
  function updateAppBadge() {
    var pending = items.filter(function (it) { return ['waiting', 'paused', 'waiting-network', 'error', 'sending', 'encrypting', 'optimizing'].indexOf(it.state) !== -1; }).length;
    if (navigator.setAppBadge && pending > 0) {
      try { navigator.setAppBadge(pending); } catch (_) {}
    } else if (navigator.clearAppBadge) {
      try { navigator.clearAppBadge(); } catch (_) {}
    }
  }

  function initialChunkSize() {
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return MIN_CHUNK;
    if ((navigator.deviceMemory && navigator.deviceMemory <= 2) || isMobileLike()) return MOBILE_CHUNK;
    return DESKTOP_CHUNK;
  }
  function durablePayloadLimit() {
    if ((navigator.deviceMemory && navigator.deviceMemory <= 2) || isMobileLike()) return MOBILE_DURABLE_LIMIT;
    return DESKTOP_DURABLE_LIMIT;
  }
  function nextSmallerChunk(size) {
    size = Math.max(MIN_CHUNK, Number(size) || initialChunkSize());
    if (size <= MIN_CHUNK) return MIN_CHUNK;
    var next = Math.floor((size / 2) / (64 * 1024)) * (64 * 1024);
    return Math.max(MIN_CHUNK, next);
  }
  function fetchWithTimeout(url, options, timeoutMs) {
    options = options || {};
    if (!window.AbortController) return fetch(url, options);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || OFFSET_TIMEOUT_MS);
    options = Object.assign({}, options, { signal: ctrl.signal });
    return fetch(url, options).finally(function () { clearTimeout(timer); });
  }

  // IndexedDB ---------------------------------------------------------------
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      // A stuck indexedDB.open must never hang the app. On some Android WebAPK/WebView
      // contexts the request can fire `blocked` (another client holds the DB during a
      // version change) or simply never fire success/error at all. Without this guard,
      // the first `await idb…()` in initialize() stalls forever and the gallery, queue
      // and history never load even though the network APIs work. On timeout/blocked we
      // reject so callers fall back to their localStorage snapshot + the /app/* APIs.
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return; settled = true;
        try { console.warn('[dx] indexedDB.open timed out — using localStorage/network fallbacks'); } catch (_) {}
        reject(new Error('idb-open-timeout'));
      }, 4000);
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { clearTimeout(timer); settled = true; reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DEST_STORE)) db.createObjectStore(DEST_STORE, { keyPath: 'token' });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(HISTORY_STORE)) db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE, { keyPath: 'token' });
      };
      req.onsuccess = function () {
        if (settled) { try { req.result.close(); } catch (_) {} return; }
        settled = true; clearTimeout(timer);
        req.result.onversionchange = function () { try { req.result.close(); } catch (_) {} dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = function () { if (settled) return; settled = true; clearTimeout(timer); reject(req.error); };
      // `blocked` never resolves on its own: reject so the boot proceeds via fallbacks.
      req.onblocked = function () { if (settled) return; settled = true; clearTimeout(timer); try { console.warn('[dx] indexedDB.open blocked'); } catch (_) {} reject(new Error('idb-blocked')); };
    });
    return dbPromise;
  }
  function idbAction(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var value;
        try { value = fn(store); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(value); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('idb-abort')); };
      });
    });
  }
  function idbPut(store, value) { return idbAction(store, 'readwrite', function (s) { s.put(value); }); }
  function idbDelete(store, key) { return idbAction(store, 'readwrite', function (s) { s.delete(key); }); }
  function idbClear(store) { return idbAction(store, 'readwrite', function (s) { s.clear(); }); }
  function idbGetAll(store) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function idbReplaceAll(store, values) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite');
        var target = tx.objectStore(store);
        target.clear();
        (Array.isArray(values) ? values : []).forEach(function (value) { target.put(value); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('idb-abort')); };
      });
    });
  }
  function idbGet(store, key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function metaSet(key, value) { return idbPut(META_STORE, { key: key, value: value }); }
  function metaGet(key, fallback) { return idbGet(META_STORE, key).then(function (r) { return r ? r.value : fallback; }); }


  // Durable transfer payloads ------------------------------------------------
  // IndexedDB is reliable for metadata but large Blob records are slow and quota
  // sensitive on Android. OPFS stores the selected bytes as ordinary origin-private
  // files, while IndexedDB keeps only the lightweight resume metadata. The actual
  // network request still runs in the page; if Android closes it, the same uploadId
  // and server-side offset are reused when the PWA opens again.
  var opfsDirPromise = null;
  function opfsAvailable() {
    return !!(navigator.storage && typeof navigator.storage.getDirectory === 'function');
  }
  function opfsQueueDir() {
    if (!opfsAvailable()) return Promise.reject(new Error('opfs-unavailable'));
    if (!opfsDirPromise) {
      opfsDirPromise = navigator.storage.getDirectory().then(function (root) {
        return root.getDirectoryHandle(OPFS_QUEUE_DIR, { create: true });
      });
    }
    return opfsDirPromise;
  }
  async function protectPersistentStorage() {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') return false;
    try {
      if (typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) return true;
      return !!(await navigator.storage.persist());
    } catch (_) { return false; }
  }
  function opfsName(id, kind) { return String(id || genId(18)) + (kind === 'prepared' ? '.prepared' : '.source'); }
  async function writeOpfsBlob(path, blob, onProgress) {
    var dir = await opfsQueueDir();
    var handle = await dir.getFileHandle(path, { create: true });
    var writable = await handle.createWritable();
    var offset = 0;
    try {
      while (offset < blob.size) {
        var end = Math.min(blob.size, offset + OPFS_COPY_CHUNK);
        await writable.write({ type: 'write', position: offset, data: blob.slice(offset, end) });
        offset = end;
        if (onProgress) onProgress(blob.size ? offset / blob.size : 1);
      }
      await writable.truncate(blob.size);
      await writable.close();
      return path;
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      try { await dir.removeEntry(path); } catch (_) {}
      throw e;
    }
  }
  async function readOpfsBlob(path, type) {
    if (!path) return null;
    var dir = await opfsQueueDir();
    var handle = await dir.getFileHandle(path, { create: false });
    var file = await handle.getFile();
    return type && file.type !== type ? file.slice(0, file.size, type) : file;
  }
  async function deleteOpfsPath(path) {
    if (!path || !opfsAvailable()) return;
    try { var dir = await opfsQueueDir(); await dir.removeEntry(path); } catch (_) {}
  }
  async function purgeOpfsQueue() {
    if (!opfsAvailable()) return;
    try {
      var root = await navigator.storage.getDirectory();
      await root.removeEntry(OPFS_QUEUE_DIR, { recursive: true });
      opfsDirPromise = null;
    } catch (_) {}
  }
  function hasDurablePayload(it) {
    if (!it) return false;
    if (it.preparedBlob && it.preparedBlob !== it.file) return !!it.preparedOpfsPath || (!it.preparedVolatile && payloadBytesForPersistence(it) <= durablePayloadLimit());
    return !!it.opfsPath || (!it.volatile && !!it.file && payloadBytesForPersistence(it) <= durablePayloadLimit());
  }
  async function ensureSourceDurable(it, notifyOnFallback) {
    if (!it || !it.file || it.opfsPath) return !!(it && (it.opfsPath || !it.volatile));
    if (it.persistPromise) return it.persistPromise;
    if (!opfsAvailable()) return persistItem(it, notifyOnFallback);
    it.persisting = true;
    updateItemUi(it, t('durableSaving'));
    var path = opfsName(it.id, 'source');
    it.persistPromise = (async function () {
      await requestPersistentStorage();
      await writeOpfsBlob(path, it.file, function (fraction) {
        it.persistProgress = Math.max(0, Math.min(1, fraction || 0));
        updateItemUi(it, t('durableSaving') + ' ' + Math.round(it.persistProgress * 100) + '%');
      });
      it.opfsPath = path;
      it.volatile = false;
      it.persisting = false;
      it.persistProgress = 1;
      saveQueueBackup(); // bytes are safe in OPFS; mirror the metadata durably too
      await idbPut(QUEUE_STORE, queueRecord(it));
      updateItemUi(it, statusText(it));
      if (it.meta) it.meta.textContent = rowMetaText(it);
      return true;
    })().catch(async function () {
      it.persisting = false;
      it.persistProgress = 0;
      // Fall back to Blob-in-IndexedDB for modest files. Only mark session-only
      // when neither durable backend can hold the payload.
      if (payloadBytesForPersistence(it) <= durablePayloadLimit()) {
        try { it.volatile = false; await idbPut(QUEUE_STORE, queueRecord(it)); updateItemUi(it, statusText(it)); return true; } catch (_) {}
      }
      await markSessionOnly(it, !!notifyOnFallback);
      updateItemUi(it, statusText(it));
      return false;
    }).finally(function () { it.persistPromise = null; });
    return it.persistPromise;
  }
  async function ensurePreparedDurable(it) {
    if (!it || !it.preparedBlob || it.preparedBlob === it.file) {
      if (it) { it.preparedUsesSource = !!(it.preparedBlob && it.preparedBlob === it.file); await persistItem(it, false); }
      return true;
    }
    if (it.preparedOpfsPath) { await persistItem(it, false); return true; }
    if (opfsAvailable()) {
      var path = opfsName(it.id, 'prepared');
      try {
        await requestPersistentStorage();
        await writeOpfsBlob(path, it.preparedBlob, function (fraction) {
          it.persistProgress = Math.max(0, Math.min(1, fraction || 0));
          updateItemUi(it, t('durableSaving') + ' ' + Math.round(it.persistProgress * 100) + '%');
        });
        it.preparedOpfsPath = path;
        it.preparedVolatile = false;
        saveQueueBackup();
        await idbPut(QUEUE_STORE, queueRecord(it));
        return true;
      } catch (_) { try { await deleteOpfsPath(path); } catch (_) {} }
    }
    if (payloadBytesForPersistence(it) <= durablePayloadLimit()) {
      try { it.preparedVolatile = false; await idbPut(QUEUE_STORE, queueRecord(it)); return true; } catch (_) {}
    }
    // The source remains durable, so reopening can regenerate the prepared bytes
    // (and will ask again for an encryption secret when required).
    it.preparedVolatile = true;
    await idbPut(QUEUE_STORE, queueRecord(it)).catch(function () {});
    return false;
  }
  function invalidatePreparedPayload(it) {
    if (!it) return;
    var oldPrepared = it.preparedOpfsPath;
    it.preparedBlob = null;
    it.preparedOpfsPath = null;
    it.preparedUsesSource = false;
    it.preparedVolatile = false;
    it.upName = null;
    it.upSize = null;
    it.preparedEncrypted = false;
    if (oldPrepared) deleteOpfsPath(oldPrepared);
  }
  async function replaceItemSourceDurably(it, file) {
    if (!it || !file) return false;
    var oldSource = it.opfsPath;
    invalidatePreparedPayload(it);
    it.file = file;
    it.type = file.type || it.type || 'application/octet-stream';
    it.size = file.size || 0;
    it.lastModified = file.lastModified || Date.now();
    it.opfsPath = null;
    it.volatile = false;
    if (oldSource) await deleteOpfsPath(oldSource);
    if (opfsAvailable()) return ensureSourceDurable(it, true);
    return persistItem(it, true);
  }

  async function restoreQueueRecords(records) {
    var restored = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (!r) continue;
      if (!r.file && r.opfsPath) {
        try { r.file = await readOpfsBlob(r.opfsPath, r.type || 'application/octet-stream'); }
        catch (_) { r.file = null; r.opfsPath = null; }
      }
      if (!r.preparedBlob && r.preparedOpfsPath) {
        try { r.preparedBlob = await readOpfsBlob(r.preparedOpfsPath, r.preparedType || 'application/octet-stream'); }
        catch (_) { r.preparedBlob = null; r.preparedOpfsPath = null; }
      }
      if (!r.preparedBlob && r.preparedUsesSource && r.file) r.preparedBlob = r.file;
      if (r.preparedVolatile) { r.preparedBlob = null; r.preparedOpfsPath = null; r.upName = null; r.upSize = null; r.preparedEncrypted = false; }
      if (!r.file && !r.preparedBlob) {
        await idbDelete(QUEUE_STORE, r.id).catch(function () {});
        continue;
      }
      restored.push(makeItem(r));
    }
    return restored;
  }

  // Destinations -------------------------------------------------------------
  var persistentDests = [];
  var sessionDests = [];
  // Reception links the server reports for this device/account — INCLUDING ones created
  // outside the PWA (e.g. the admin web UI). They are surfaced as selectable destinations
  // so every reception link is reachable from the first page, not only PWA-created ones.
  // Kept separate (never persisted) since the server is their source of truth; local
  // records win on token collisions so a user's custom name/key/pin is preserved.
  var serverReceptions = [];
  var editingToken = '';
  var currentDest = null;
  var currentConfig = null;
  var currentDestOk = false;
  var destNeedsSender = false;
  var destinationLocked = false;

  function loadSessionDests() {
    try {
      var list = JSON.parse(sessionStorage.getItem('dx-session-dests') || '[]');
      return Array.isArray(list) ? list.filter(function (d) { return d && /^[A-Za-z0-9_-]{6,64}$/.test(String(d.token || '')); }).map(function (d) {
        if (d.rememberKey !== true) d.key = '';
        return d;
      }) : [];
    } catch (_) { return []; }
  }
  function destinationForStorage(dest) {
    var copy = Object.assign({}, dest || {});
    if (copy.remembered !== true || copy.rememberKey !== true) copy.key = '';
    return copy;
  }
  function persistDestination(dest) { saveDestsBackup(); return idbPut(DEST_STORE, destinationForStorage(dest)); }
  // Durable localStorage mirror of the remembered destinations. IndexedDB is the
  // primary store, but on some Android WebAPK/WebView contexts it is unopenable
  // (idb-open-timeout / idb-blocked); without this mirror a created reception link
  // — and thus access to everything uploaded to it — disappears on refresh, WebAPK
  // relaunch or reconnection. Mirrors the proven history-backup pattern.
  function localDestBackup() {
    try {
      var parsed = JSON.parse(localStorage.getItem(DEST_BACKUP_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function saveDestsBackup() {
    try { localStorage.setItem(DEST_BACKUP_KEY, JSON.stringify(persistentDests.map(destinationForStorage))); } catch (_) {}
  }
  // Merge IndexedDB + localStorage-backup destinations, de-duplicated by token
  // (IndexedDB wins when both hold a token). Keeps links alive whichever store
  // survived on this device.
  function mergeDestLists(primary, backup) {
    var seen = Object.create(null), out = [];
    (Array.isArray(primary) ? primary : []).concat(Array.isArray(backup) ? backup : []).forEach(function (d) {
      if (!d || !d.token || seen[d.token]) return;
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(d.token))) return;
      if (d.rememberKey !== true) d.key = '';
      seen[d.token] = true; out.push(d);
    });
    return out;
  }
  function persistSessionDests() {
    try { sessionStorage.setItem('dx-session-dests', JSON.stringify(sessionDests.map(destinationForStorage))); } catch (_) {}
  }
  function allDests() {
    var map = Object.create(null), out = [];
    // Local records (persistent, then session) are listed first so they win on token
    // collisions; server-reported reception links follow, adding any not saved locally.
    persistentDests.concat(sessionDests).concat(serverReceptions).forEach(function (d) {
      if (!d || !d.token || map[d.token]) return;
      map[d.token] = true; out.push(d);
    });
    // Pinned (favourite) destinations float to the top; within each group we honour
    // a user-defined order when present, and unordered entries keep creation order.
    out.sort(function (a, b) {
      var ap = a.pinned ? 0 : 1, bp = b.pinned ? 0 : 1;
      if (ap !== bp) return ap - bp;
      var ao = typeof a.order === 'number' ? a.order : 1e9, bo = typeof b.order === 'number' ? b.order : 1e9;
      return ao !== bo ? ao - bo : (a.createdAt || 0) - (b.createdAt || 0);
    });
    return out;
  }
  function destDot(status) {
    if (status === 'ok') return '🟢';
    if (status === 'locked') return '🔒';
    if (status === 'offline') return '🟠';
    if (status === 'revoked' || status === 'invalid') return '🔴';
    return '';
  }
  function moveDest(token, dir) {
    var list = allDests();
    var i = list.findIndex(function (d) { return d.token === token; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    list.forEach(function (d, idx) { d.order = idx; if (d.remembered) persistDestination(d).catch(function () {}); });
    persistSessionDests();
    renderDests(); updateDestReorderButtons();
  }
  function activeToken() {
    try { return sessionStorage.getItem('dx-active-dest') || ''; } catch (_) { return ''; }
  }
  // Last destination remembered PERSISTENTLY across visits (feature 8). The session
  // token above still wins within a session; this is the cross-session fallback.
  function persistentLastDest() {
    try { return localStorage.getItem('dx-pwa-last-dest') || ''; } catch (_) { return ''; }
  }
  function setActiveToken(token) {
    try { sessionStorage.setItem('dx-active-dest', token || ''); } catch (_) {}
    try { if (token) localStorage.setItem('dx-pwa-last-dest', token); } catch (_) {}
  }
  function findDest(token) { return allDests().find(function (d) { return d.token === token; }) || null; }
  function parseDestination(raw) {
    raw = String(raw || '').trim();
    if (/^[A-Za-z0-9_-]{6,64}$/.test(raw)) return { token: raw, sourceOrigin: location.origin, key: '' };
    var u;
    try { u = new URL(raw, location.href); } catch (_) { return null; }
    var m = /^\/u\/([A-Za-z0-9_-]{6,64})(?:\/|$)/.exec(u.pathname);
    if (!m) return null;
    var km = /(?:^#|[&#])k=([A-Za-z0-9_-]+)/.exec(u.hash || '');
    return { token: m[1], sourceOrigin: u.origin, key: km ? km[1] : '' };
  }
  function renderDests() {
    var sel = $('dest-select');
    var previous = sel.value || activeToken() || persistentLastDest();
    sel.innerHTML = '';
    var list = allDests();
    if (!list.length) {
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = t('noLink'); sel.appendChild(empty);
      sel.disabled = true;
    } else {
      sel.disabled = destinationLocked;
      list.forEach(function (d) {
        var opt = document.createElement('option'); opt.value = d.token;
        var dot = destDot(destStatusCache[d.token]);
        opt.textContent = (d.pinned ? '⭐ ' : '') + (dot ? dot + ' ' : '') + (d.name || ('…' + d.token.slice(-8)));
        sel.appendChild(opt);
      });
      var chosen = list.some(function (d) { return d.token === previous; }) ? previous : list[0].token;
      sel.value = chosen; setActiveToken(chosen);
    }
    $('dest-copy-btn').classList.toggle('hidden', !sel.value);
    if ($('dest-qr-btn')) $('dest-qr-btn').classList.toggle('hidden', !sel.value);
    var chosenDest = sel.value ? findDest(sel.value) : null;
    $('dest-revoke-btn').classList.toggle('hidden', !(chosenDest && chosenDest.owned));
    if ($('dest-received-btn')) $('dest-received-btn').classList.toggle('hidden', !(chosenDest && chosenDest.owned));
  }
  function saveDestinationRecord(dest, remember) {
    sessionDests = sessionDests.filter(function (d) { return d.token !== dest.token; });
    persistentDests = persistentDests.filter(function (d) { return d.token !== dest.token; });
    if (remember) {
      persistentDests.push(dest); persistSessionDests();
      // Persisting to IndexedDB is best-effort. On some Android WebAPK/WebView
      // contexts the DB is temporarily unopenable (idb-open-timeout / idb-blocked);
      // a reception link that the server already created must never be reported as
      // a failure. Fall back to a sessionStorage copy — visible and usable this
      // session — instead of rejecting the whole create/save flow.
      return persistDestination(dest).catch(function (err) {
        try { console.warn('[dx] destination persist failed, keeping session copy:', err && err.message); } catch (_) {}
        if (!sessionDests.some(function (d) { return d.token === dest.token; })) {
          sessionDests.push(dest); persistSessionDests();
        }
      });
    }
    sessionDests.push(dest); persistSessionDests();
    saveDestsBackup(); // reflect the removal from the persistent set in the durable mirror
    return idbDelete(DEST_STORE, dest.token).catch(function () {});
  }
  function removeDestinationRecord(token) {
    sessionDests = sessionDests.filter(function (d) { return d.token !== token; }); persistSessionDests();
    persistentDests = persistentDests.filter(function (d) { return d.token !== token; });
    // Drop the server-reported copy too so a just-revoked link vanishes immediately
    // instead of lingering until the next /app/receptions refresh.
    serverReceptions = serverReceptions.filter(function (d) { return d.token !== token; });
    saveDestsBackup();
    return idbDelete(DEST_STORE, token).catch(function () {});
  }
  function migrateLegacyDests() {
    var legacy = [];
    try { legacy = JSON.parse(localStorage.getItem('dx_dests') || '[]') || []; } catch (_) {}
    if (!legacy.length) return Promise.resolve();
    return Promise.all(legacy.filter(function (d) { return d && d.token; }).map(function (d) {
      return persistDestination({ token: d.token, name: d.name || '', key: '', rememberKey: false, sourceOrigin: location.origin, remembered: true, createdAt: Date.now() });
    })).then(function () {
      try { localStorage.removeItem('dx_dests'); localStorage.removeItem('dx_active'); } catch (_) {}
    });
  }
  function extractJson(text, marker) {
    var i = text.indexOf(marker); if (i < 0) return null;
    i = text.indexOf('{', i); if (i < 0) return null;
    var depth = 0, inString = false, escaped = false;
    for (var j = i; j < text.length; j++) {
      var c = text[j];
      if (inString) {
        if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch (_) { return null; } }
      }
    }
    return null;
  }
  function validateDest(dest) {
    return fetch('/u/' + encodeURIComponent(dest.token) + '/upload-status?id=dxcheck0000', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) return { status: 'locked' };
        if (r.status === 403) return { status: 'revoked' };
        if (!r.ok) return { status: 'invalid' };
        return fetch('/u/' + encodeURIComponent(dest.token), { credentials: 'same-origin', cache: 'no-store' })
          .then(function (page) { return page.text(); })
          .then(function (html) {
            var cfg = extractJson(html, 'DX_INBOX') || {};
            return { status: 'ok', config: cfg };
          });
      }).catch(function () { return { status: 'offline' }; });
  }
  function showLimits(cfg) {
    var parts = [];
    if (cfg && cfg.maxFiles > 0) parts.push(t('filesLeft', { left: Math.max(0, cfg.maxFiles - (cfg.filesReceived || 0)), total: cfg.maxFiles }));
    if (cfg && cfg.maxTotalBytes > 0) parts.push(t('spaceLeft', { left: fmtBytes(Math.max(0, cfg.maxTotalBytes - (cfg.bytesReceived || 0))), total: fmtBytes(cfg.maxTotalBytes) }));
    if (cfg && cfg.maxFileBytes > 0) parts.push(t('maxFile', { size: fmtBytes(cfg.maxFileBytes) }));
    $('dest-limits').textContent = parts.length ? '📊 ' + parts.join(' · ') : '';
    $('dest-limits').classList.toggle('hidden', !parts.length);
    // Visual remaining-quota bars (feature 11): a coloured gauge per limited axis.
    var bars = $('dest-limit-bars');
    if (bars) {
      bars.innerHTML = '';
      var rows = [];
      if (cfg && cfg.maxFiles > 0) {
        var usedF = cfg.filesReceived || 0;
        rows.push({ label: t('filesLeft', { left: Math.max(0, cfg.maxFiles - usedF), total: cfg.maxFiles }), value: usedF, max: cfg.maxFiles });
      }
      if (cfg && cfg.maxTotalBytes > 0) {
        var usedB = cfg.bytesReceived || 0;
        rows.push({ label: t('spaceLeft', { left: fmtBytes(Math.max(0, cfg.maxTotalBytes - usedB)), total: fmtBytes(cfg.maxTotalBytes) }), value: usedB, max: cfg.maxTotalBytes });
      }
      rows.forEach(function (r) {
        var frac = r.max > 0 ? r.value / r.max : 0;
        var wrap = document.createElement('div'); wrap.className = 'limit-bar';
        var lab = document.createElement('div'); lab.className = 'limit-label';
        var l = document.createElement('span'); l.textContent = r.label;
        var p = document.createElement('span'); p.textContent = Math.round(Math.min(1, frac) * 100) + '%';
        lab.appendChild(l); lab.appendChild(p);
        var pr = document.createElement('progress'); pr.max = r.max; pr.value = Math.min(r.max, r.value);
        if (frac >= 1) pr.className = 'full-fill'; else if (frac >= 0.85) pr.className = 'warn-fill';
        wrap.appendChild(lab); wrap.appendChild(pr); bars.appendChild(wrap);
      });
      bars.classList.toggle('hidden', rows.length === 0);
      // Warn once per destination when any axis crosses 85 % (feature 13); clear the
      // latch again if usage drops back below the threshold so it can re-fire later.
      var maxFrac = rows.reduce(function (m, r) { return Math.max(m, r.max > 0 ? r.value / r.max : 0); }, 0);
      if (currentDest) {
        if (maxFrac >= 0.85) { if (!quotaWarned.has(currentDest.token)) { quotaWarned.add(currentDest.token); toast(t('quotaNearFull'), 'warn'); } }
        else quotaWarned.delete(currentDest.token);
      }
    }
  }
  function updateEncryptionPanel() {
    var enc = currentConfig && currentConfig.enc;
    $('encryption-form').classList.toggle('hidden', !enc);
    $('enc-key-row').classList.add('hidden'); $('enc-pass-row').classList.add('hidden');
    if (!enc) return;
    if (enc.mode === 'pass') {
      $('enc-pass-row').classList.remove('hidden'); $('enc-help').textContent = t('e2ePass');
    } else {
      $('enc-key-row').classList.remove('hidden');
      if (currentDest && currentDest.key && !$('enc-key').value) $('enc-key').value = currentDest.key;
      $('enc-help').textContent = ($('enc-key').value || (currentDest && currentDest.key)) ? t('e2eKeyReady') : t('e2eKeyMissing');
    }
  }
  var refreshCounter = 0;
  function refreshDestStatus() {
    var token = $('dest-select').value;
    var requestId = ++refreshCounter;
    currentDest = findDest(token); currentConfig = null; currentDestOk = false; destNeedsSender = false;
    if ($('sender-name')) $('sender-name').value = '';
    $('unlock-form').classList.add('hidden'); $('dest-limits').classList.add('hidden'); $('sender-row').classList.add('hidden');
    if ($('dest-limit-bars')) $('dest-limit-bars').classList.add('hidden');
    $('dest-revoke-btn').classList.toggle('hidden', !(currentDest && currentDest.owned));
    if ($('dest-received-btn')) $('dest-received-btn').classList.toggle('hidden', !(currentDest && currentDest.owned));
    updateEncryptionPanel(); updateSendBtn();
    if (!currentDest) { $('dest-status').textContent = t('addLinkHint'); $('dest-status').className = 'dest-status muted'; return Promise.resolve(); }
    $('dest-status').textContent = t('checking'); $('dest-status').className = 'dest-status muted';
    return validateDest(currentDest).then(function (result) {
      if (requestId !== refreshCounter) return;
      destStatusCache[currentDest.token] = result.status;
      if (result.status === 'ok') {
        currentConfig = result.config || {}; currentDestOk = true; destNeedsSender = !!currentConfig.groupBySender;
        $('dest-status').textContent = t('ready') + (currentDest.lastUsedAt ? ' · ' + t('destLastUsed', { rel: fmtRelative(currentDest.lastUsedAt) }) : '');
        $('dest-status').className = 'dest-status ok';
        $('sender-row').classList.toggle('hidden', !destNeedsSender); if (destNeedsSender) restoreSender();
        showLimits(currentConfig); updateEncryptionPanel(); applyDestPreset(currentDest); maybeAutoResume();
      } else if (result.status === 'locked') {
        $('dest-status').textContent = t('locked'); $('dest-status').className = 'dest-status warn'; $('unlock-form').classList.remove('hidden');
      } else if (result.status === 'revoked') {
        $('dest-status').textContent = t('revoked'); $('dest-status').className = 'dest-status err';
      } else if (result.status === 'offline') {
        $('dest-status').textContent = t('offlineServer'); $('dest-status').className = 'dest-status warn';
      } else {
        $('dest-status').textContent = t('invalid'); $('dest-status').className = 'dest-status err';
      }
      renderDests(); updateSendBtn();
    });
  }
  function openDestForm(edit) {
    editingToken = edit || '';
    var d = editingToken ? findDest(editingToken) : null;
    $('dest-url').value = d ? (location.origin + '/u/' + d.token + (d.key ? '#k=' + d.key : '')) : '';
    $('dest-name').value = d ? (d.name || '') : '';
    updateCharCount($('dest-name'), $('dest-name-count'), 80);
    $('dest-remember').checked = !!(d && d.remembered);
    $('dest-remember-key').checked = !!(d && d.rememberKey && d.key);
    updateRememberKeyControl();
    $('dest-save-btn').textContent = editingToken ? t('updateDestination') : t('saveDestination');
    $('dest-remove-btn').classList.toggle('hidden', !editingToken);
    updateDestReorderButtons(); updatePinButton();
    $('dest-form').classList.remove('hidden');
    $('dest-url').focus();
  }
  function updateRememberKeyControl() {
    var parsed = parseDestination($('dest-url').value);
    var hasKey = !!(parsed && parsed.key);
    var control = $('dest-remember-key');
    control.disabled = !$('dest-remember').checked || !hasKey;
    if (control.disabled) control.checked = false;
  }
  // Show/enable the move up/down buttons only when editing an existing destination
  // that has neighbours to swap with.
  function updateDestReorderButtons() {
    var up = $('dest-up-btn'), down = $('dest-down-btn'); if (!up || !down) return;
    var list = allDests();
    var i = editingToken ? list.findIndex(function (d) { return d.token === editingToken; }) : -1;
    var show = i >= 0 && list.length > 1;
    up.classList.toggle('hidden', !show); down.classList.toggle('hidden', !show);
    up.disabled = i <= 0; down.disabled = i < 0 || i >= list.length - 1;
  }
  function closeDestForm() {
    editingToken = ''; $('dest-form').classList.add('hidden'); $('dest-url').value = ''; $('dest-name').value = ''; $('dest-remove-btn').classList.add('hidden');
    updateDestReorderButtons(); updatePinButton();
  }

  // --- Create a NEW reception link (not just associate one) via POST /app/inbox.
  // Reachable by a paired device or an admin session; the new link is stored as a
  // destination and selected, so it can be copied/shared right away. ---
  function openCreateForm() {
    closeDestForm();
    $('unlock-form').classList.add('hidden');
    $('create-error').classList.add('hidden');
    $('create-name').value = '';
    $('create-form').classList.remove('hidden');
    $('create-name').focus();
  }
  function closeCreateForm() { $('create-form').classList.add('hidden'); $('create-error').classList.add('hidden'); }
  async function createReceptionLink() {
    var btn = $('create-do-btn'), errEl = $('create-error');
    var name = String($('create-name').value || '').trim();
    errEl.classList.add('hidden');
    var prev = btn.textContent;
    btn.disabled = true; btn.textContent = t('creating');
    try {
      var r = await appMutate('/app/inbox', 'application/json', JSON.stringify({ name: name }));
      if (!r.ok) {
        var serverError = '';
        try { var ed = await r.clone().json(); serverError = ed && ed.error ? String(ed.error) : ''; } catch (_) {}
        throw new Error('http ' + r.status + (serverError ? ' · ' + serverError : ''));
      }
      var data = await r.json();
      if (!data || !data.token) throw new Error('no-token');
      var dest = { token: data.token, name: data.name || name || '', key: '', sourceOrigin: location.origin, remembered: true, owned: true, createdAt: Date.now() };
      await saveDestinationRecord(dest, true);
      setActiveToken(dest.token);
      closeCreateForm();
      renderDests();
      $('dest-select').value = dest.token;
      refreshDestStatus();
      toast(t('createOk'), 'ok');
    } catch (e) {
      // Surface the real cause (e.g. "http 403 · invalid-origin") so a failure
      // behind a reverse proxy is diagnosable instead of a bare generic message.
      var reason = (e && e.message) ? String(e.message) : '';
      errEl.textContent = reason ? t('createFail') + ' (' + reason + ')' : t('createFail');
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = prev;
    }
  }

  // Queue --------------------------------------------------------------------
  var items = [];
  var historyEntries = [];
  // True once the boot restore has loaded history/images from storage. Until then,
  // in-memory state is empty and must NOT be written back to the localStorage
  // backups — otherwise an early checkpoint (e.g. the update/pagehide path firing
  // before restore completes) would overwrite good backups with empty data and the
  // history would be lost across a PWA update.
  var hydrated = false;
  var sending = false;
  var paused = false;
  var activeXhrs = new Set();
  var batch = [];
  var batchTotal = 0;
  var batchSnapshot = null;
  var globalRate = {}; // smoothed overall transfer-rate sampler (bytes/s)
  var resumeWaiters = [];
  var onlineWaiters = [];
  var wakeLock = null;
  var persistTimers = new Map();
  // Session-only counters (feature: session stats) and a persisted average upload
  // rate used to estimate the time of a batch BEFORE it starts sending.
  var sessionFiles = 0, sessionBytes = 0;
  var avgRate = 0;
  try { avgRate = Number(localStorage.getItem('dx-pwa-avg-rate')) || 0; } catch (_) {}
  // Last upload failure, kept for the "Copy diagnostics" button.
  var lastDiag = null;
  // Full-size URLs of image links created this session, for "Copy all".
  var imageLinkUrls = [];
  var imageRowsByToken = new Map();
  var imageRecordsByToken = new Map();
  var selectedImageTokens = new Set();
  var pendingImageRevokes = new Map();
  var imageStatsTimer = null;
  var imageStatsAbortController = null;
  var imageRefreshGeneration = 0;
  var imageMissingConfirmations = new Map();
  var imageCountdownTimer = null;
  var imageAlbums = [];
  var imageRetentionRules = null;
  var tagColorMap = {};
  var pinnedAlbumTokens = new Set();
  try { tagColorMap = JSON.parse(localStorage.getItem('dx-pwa-tag-colors') || '{}') || {}; } catch (_) { tagColorMap = {}; }
  try { pinnedAlbumTokens = new Set(JSON.parse(localStorage.getItem('dx-pwa-pinned-albums') || '[]')); } catch (_) { pinnedAlbumTokens = new Set(); }
  var imageActionHistory = [];
  try { imageActionHistory = JSON.parse(localStorage.getItem('dx-pwa-image-actions') || '[]'); if (!Array.isArray(imageActionHistory)) imageActionHistory = []; } catch (_) { imageActionHistory = []; }
  var warnedImageExpiries = new Set();
  try { warnedImageExpiries = new Set(JSON.parse(localStorage.getItem('dx-pwa-image-expiry-warned') || '[]')); } catch (_) {}
  // Current queue sort ('added' | 'name' | 'size' | 'type'), an optional name filter,
  // the id being dragged (reorder), and per-destination "quota near full" warnings.
  var sortMode = 'added';
  var queueFilter = '';
  var dragId = null;
  var quotaWarned = new Set();
  var historyFilter = '';
  // Lifetime (persisted) counters and a cache of the last validation status per
  // destination token, used to colour the destination list.
  var lifetimeFiles = 0, lifetimeBytes = 0;
  var destStatusCache = Object.create(null);
  var baseTitle = document.title;
  // Multi-select (bulk actions) and "Wi-Fi only" gating state.
  var selectedIds = new Set();
  var wifiWaiters = [];
  var lastBatchRecord = null;
  var lastBatchSummary = null;
  var privacyNames = false;
  var previewUrl = '';
  var mobileDataConfirmedForBatch = false;

  function payloadBytesForPersistence(it) {
    var total = it.file && !it.opfsPath && it.file.size ? it.file.size : 0;
    if (it.preparedBlob && it.preparedBlob !== it.file && !it.preparedOpfsPath && !it.preparedVolatile) total += it.preparedBlob.size || 0;
    return total;
  }
  function queueRecord(it) {
    return {
      id: it.id,
      file: it.opfsPath ? null : it.file,
      opfsPath: it.opfsPath || null,
      name: it.name,
      originalName: it.originalName,
      type: it.type,
      size: it.size,
      lastModified: it.lastModified,
      state: ['sending', 'waiting-network', 'persisting'].indexOf(it.state) !== -1 ? 'waiting' : it.state,
      resumeOnOpen: !!(it.resumeOnOpen && it.state !== 'paused'),
      uploadId: it.uploadId,
      sentBytes: it.sentBytes || 0,
      createdAt: it.createdAt,
      snapshot: it.snapshot ? Object.assign({}, it.snapshot, { key: '', passphrase: '' }) : null,
      preparedBlob: it.preparedOpfsPath || it.preparedVolatile ? null : (it.preparedBlob && it.preparedBlob !== it.file ? it.preparedBlob : null),
      preparedOpfsPath: it.preparedOpfsPath || null,
      preparedUsesSource: !!(it.preparedBlob && it.preparedBlob === it.file),
      preparedVolatile: !!it.preparedVolatile,
      preparedType: it.preparedBlob ? (it.preparedBlob.type || 'application/octet-stream') : null,
      upName: it.upName || null,
      upSize: it.upSize || null,
      preparedEncrypted: !!it.preparedEncrypted,
      optimized: !!it.optimized,
      errorCode: it.errorCode || null,
      note: it.note || ''
    };
  }
  // Durable localStorage mirror of the transfer queue. IndexedDB is the primary
  // store, but on Android WebAPK/WebView contexts where it is unopenable the queued
  // uploads would vanish on refresh even though their bytes are safe in OPFS. Only
  // OPFS-backed records are mirrored: they carry no in-memory Blob, so they are
  // JSON-serializable and fully recoverable (restoreQueueRecords re-reads OPFS).
  function queueBackupRecord(it) {
    if (!it || it.state === 'removed' || it.state === 'done') return null;
    var rec = queueRecord(it);
    if (rec.file || rec.preparedBlob) return null; // an in-memory Blob can't be serialized
    if (!rec.opfsPath && !rec.preparedOpfsPath && !rec.preparedUsesSource) return null;
    return rec;
  }
  function saveQueueBackup() {
    try {
      var recs = items.map(queueBackupRecord).filter(Boolean);
      if (recs.length) localStorage.setItem(QUEUE_BACKUP_KEY, JSON.stringify(recs));
      else localStorage.removeItem(QUEUE_BACKUP_KEY);
    } catch (_) {}
  }
  function localQueueBackup() {
    try { var p = JSON.parse(localStorage.getItem(QUEUE_BACKUP_KEY) || '[]'); return Array.isArray(p) ? p : []; }
    catch (_) { return []; }
  }
  function mergeQueueRecords(primary, backup) {
    var seen = Object.create(null), out = [];
    (Array.isArray(primary) ? primary : []).concat(Array.isArray(backup) ? backup : []).forEach(function (r) {
      if (!r || !r.id || seen[r.id]) return;
      seen[r.id] = true; out.push(r);
    });
    return out;
  }
  function markSessionOnly(it, notify) {
    if (!it) return Promise.resolve(false);
    var changed = !it.volatile;
    it.volatile = true;
    var timer = persistTimers.get(it.id);
    if (timer) { clearTimeout(timer); persistTimers.delete(it.id); }
    void notify; void changed;
    return idbDelete(QUEUE_STORE, it.id).catch(function () {}).then(function () { saveQueueBackup(); return false; });
  }
  function persistItem(it, notifyOnFallback) {
    if (!it || it.state === 'removed' || it.state === 'done') return Promise.resolve(false);
    if (it.persistPromise) return it.persistPromise.then(function () { return idbPut(QUEUE_STORE, queueRecord(it)).then(function () { saveQueueBackup(); return true; }); });
    // OPFS-backed records contain only metadata in IndexedDB, so they can be
    // rewritten safely even for multi-gigabyte files. The localStorage mirror keeps
    // them recoverable even when IndexedDB itself is unavailable on this device.
    if (it.opfsPath || it.preparedOpfsPath) {
      saveQueueBackup();
      return idbPut(QUEUE_STORE, queueRecord(it)).then(function () { return true; }).catch(function () { return true; });
    }
    if (it.volatile || payloadBytesForPersistence(it) > durablePayloadLimit()) {
      return markSessionOnly(it, !!notifyOnFallback);
    }
    return idbPut(QUEUE_STORE, queueRecord(it)).then(function () { return true; }).catch(function () {
      return markSessionOnly(it, !!notifyOnFallback);
    });
  }
  function schedulePersistItem(it) {
    // While bytes are flowing, the server-side .part offset is authoritative.
    // Rewriting a Blob-backed IndexedDB record for every chunk is expensive on
    // mobile storage and can pause the next request for seconds.
    if (!it || it.volatile || it.state === 'sending' || it.state === 'removed' || it.state === 'done') return;
    if (persistTimers.has(it.id)) return;
    var timer = setTimeout(function () {
      persistTimers.delete(it.id);
      persistItem(it, false);
    }, PERSIST_DEBOUNCE_MS);
    persistTimers.set(it.id, timer);
  }
  function removePersistedItem(it) {
    var timer = it && persistTimers.get(it.id);
    if (timer) { clearTimeout(timer); persistTimers.delete(it.id); }
    return Promise.all([
      idbDelete(QUEUE_STORE, it.id).catch(function () {}),
      deleteOpfsPath(it && it.opfsPath),
      deleteOpfsPath(it && it.preparedOpfsPath)
    ]).then(function () { saveQueueBackup(); });
  }
  function makeItem(record) {
    return {
      id: record.id || genId(18),
      file: record.file || null,
      opfsPath: record.opfsPath || null,
      name: safeName(record.name || record.originalName || (record.file && record.file.name) || 'file'),
      originalName: record.originalName || (record.file && record.file.name) || 'file',
      type: record.type || (record.file && record.file.type) || 'application/octet-stream',
      size: Number(record.size != null ? record.size : (record.file && record.file.size) || 0),
      lastModified: record.lastModified || (record.file && record.file.lastModified) || Date.now(),
      state: record.state === 'sending' || record.state === 'waiting-network' ? 'waiting' : (record.state || 'waiting'),
      uploadId: record.uploadId || genId(24),
      sentBytes: record.sentBytes || 0,
      createdAt: record.createdAt || Date.now(),
      snapshot: record.snapshot || null,
      preparedBlob: record.preparedBlob || null,
      preparedOpfsPath: record.preparedOpfsPath || null,
      preparedUsesSource: !!record.preparedUsesSource,
      preparedVolatile: !!record.preparedVolatile,
      upName: record.upName || null,
      upSize: record.upSize || null,
      preparedEncrypted: !!record.preparedEncrypted,
      optimized: !!record.optimized,
      errorCode: record.errorCode || null,
      note: record.note || '',
      volatile: !!record.volatile,
      resumeOnOpen: !!record.resumeOnOpen,
      persisting: false,
      persistPromise: null,
      persistProgress: 0,
      chunkSize: Number(record.chunkSize) || 0,
      prepareProgress: 0,
      row: null, progress: null, status: null, meta: null, nameInput: null, xhr: null
    };
  }
  function isDuplicate(file) {
    var name = file.webkitRelativePath || file.name || '';
    return items.some(function (it) { return it.state !== 'removed' && it.size === file.size && it.originalName === name && it.lastModified === (file.lastModified || 0); });
  }
  function acceptedSoFar() {
    return items.filter(function (it) { return it.state !== 'removed' && it.state !== 'done'; }).reduce(function (acc, it) { acc.count++; acc.bytes += it.size || 0; return acc; }, { count: 0, bytes: 0 });
  }
  function rejectReason(file) {
    if (!currentConfig) return null;
    var ext = extOf(file.name);
    var allow = Array.isArray(currentConfig.allowExt) ? currentConfig.allowExt.map(function (x) { return String(x).toLowerCase(); }) : [];
    var block = Array.isArray(currentConfig.blockExt) ? currentConfig.blockExt.map(function (x) { return String(x).toLowerCase(); }) : [];
    if (block.length && block.indexOf(ext) !== -1) return 'typeBlocked';
    if (allow.length && allow.indexOf(ext) === -1) return 'typeBlocked';
    if (currentConfig.maxFileBytes > 0 && file.size > currentConfig.maxFileBytes) return 'quotaFile';
    var acc = acceptedSoFar();
    if (currentConfig.maxFiles > 0 && (currentConfig.filesReceived || 0) + acc.count >= currentConfig.maxFiles) return 'quotaCount';
    if (currentConfig.maxTotalBytes > 0 && (currentConfig.bytesReceived || 0) + acc.bytes + file.size > currentConfig.maxTotalBytes) return 'quotaTotal';
    return null;
  }
  async function durableBudget() {
    if (!navigator.storage || !navigator.storage.estimate) return Infinity;
    try {
      // Storage estimation is advisory only. Some mobile WebViews have been seen
      // to leave this promise pending; never let it hold the file picker hostage.
      var est = await Promise.race([
        navigator.storage.estimate(),
        sleep(800).then(function () { return null; })
      ]);
      if (!est || !est.quota) return Infinity;
      return Math.max(0, ((est.quota || 0) - (est.usage || 0)) * 0.75);
    } catch (_) { return Infinity; }
  }
  async function addFiles(fileList) {
    // FileList objects are live: clearing the <input> can empty them while this
    // async function is awaiting storage information. Snapshot immediately.
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var budget = await durableBudget();
    var limit = durablePayloadLimit();
    var plannedDurable = 0;
    var skipped = 0, added = 0, sessionOnlyCount = 0;
    if (opfsAvailable()) requestPersistentStorage().catch(function () {});
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (isDuplicate(file)) { skipped++; continue; }
      var reason = rejectReason(file);
      if (reason) { toast(t(reason), 'warn'); continue; }
      var rel = file.webkitRelativePath || file.name || ('file-' + Date.now());
      var canOpfs = opfsAvailable() && plannedDurable + file.size <= budget;
      var canIdb = !canOpfs && file.size <= limit && plannedDurable + file.size <= budget;
      var durable = canOpfs || canIdb;
      var item = makeItem({ file: file, name: rel, originalName: rel, type: file.type, size: file.size, lastModified: file.lastModified, state: 'waiting', volatile: !durable });
      items.push(item);
      if (durable) {
        plannedDurable += file.size;
        if (canOpfs) item.persistPromise = ensureSourceDurable(item, true);
        else persistItem(item, true);
      } else {
        sessionOnlyCount++;
      }
      added++;
    }
    renderQueue(); updateSendBtn(); updateStorageStatus(); estimateOptimizedSizes();
    if (skipped) toast(t('duplicate', { n: skipped }), 'warn');
    if (added) toast(t('queued', { n: added }), 'ok');
  }
  function statusText(it) {
    if (it.persisting) return t('durableSaving');
    if (it.state === 'waiting') return it.sentBytes > 0 ? t('restoring') : t('waiting');
    if (it.state === 'sending') return t('sending');
    if (it.state === 'paused') return t('paused');
    if (it.state === 'waiting-network') return t('waitingNetwork');
    if (it.state === 'encrypting') return t('encrypting');
    if (it.state === 'optimizing') return t('optimizing');
    if (it.state === 'done') return t('done');
    if (it.state === 'cancelled') return t('cancelled');
    if (it.state === 'error') return reasonText(it.errorCode) || t('networkError');
    return t('waiting');
  }
  // Emoji icon for a non-image queue row, chosen from the file extension/type.
  function fileIcon(name, type) {
    var e = extOf(name); type = type || '';
    if (/^video\//.test(type) || /^(mp4|mov|mkv|avi|webm|m4v)$/.test(e)) return '🎞';
    if (/^audio\//.test(type) || /^(mp3|wav|flac|aac|ogg|m4a)$/.test(e)) return '🎵';
    if (/pdf$/.test(e) || type === 'application/pdf') return '📕';
    if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(e)) return '📦';
    if (/^(doc|docx|odt|rtf)$/.test(e)) return '📝';
    if (/^(xls|xlsx|ods|csv|tsv)$/.test(e)) return '📊';
    if (/^(ppt|pptx|odp)$/.test(e)) return '📽';
    if (/^(txt|md|log)$/.test(e) || /^text\//.test(type)) return '📃';
    return '📄';
  }
  // Coarse type bucket for the "sort by type" mode (feature 2); the numeric prefix
  // groups images, then video/audio, documents, sheets, archives, then others.
  function fileTypeKey(it) {
    var e = extOf(it.name), ty = it.type || '';
    if (/^image\//.test(ty) || /^(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif|svg)$/.test(e)) return '1-image';
    if (/^video\//.test(ty) || /^(mp4|mov|mkv|avi|webm|m4v)$/.test(e)) return '2-video';
    if (/^audio\//.test(ty) || /^(mp3|wav|flac|aac|ogg|m4a)$/.test(e)) return '3-audio';
    if (/pdf/.test(ty) || e === 'pdf') return '4-pdf';
    if (/^(doc|docx|odt|rtf|txt|md|log)$/.test(e) || /^text\//.test(ty)) return '5-doc';
    if (/^(xls|xlsx|ods|csv|tsv)$/.test(e)) return '6-sheet';
    if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(e)) return '7-archive';
    return '9-' + (e || 'other');
  }
  function sortedItems() {
    var visible = items.filter(function (it) { return it.state !== 'removed'; });
    if (queueFilter) { var q = queueFilter.toLowerCase(); visible = visible.filter(function (it) { return String(it.name).toLowerCase().indexOf(q) !== -1; }); }
    if (sortMode === 'name') visible.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), lang, { numeric: true }); });
    else if (sortMode === 'size') visible.sort(function (a, b) { return (b.upSize || b.size || 0) - (a.upSize || a.size || 0); });
    else if (sortMode === 'type') visible.sort(function (a, b) { var ta = fileTypeKey(a), tb = fileTypeKey(b); return ta !== tb ? ta.localeCompare(tb) : String(a.name).localeCompare(String(b.name), lang, { numeric: true }); });
    else visible.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    return visible;
  }
  // Metadata line under a queue row (bytes · % · optional optimize estimate / session tag).
  function rowMetaText(it) {
    var base = fmtBytes(it.sentBytes || 0) + ' / ' + fmtBytes(it.upSize || it.size) + ' · ' + pctText(it.sentBytes || 0, it.upSize || it.size);
    if (it.estSize && it.state === 'waiting' && $('optimize-images') && $('optimize-images').checked && /^image\//.test(it.type)) base += ' · ' + t('estOptim', { size: fmtBytes(it.estSize) });
    return base;
  }
  function renderQueue() {
    var list = $('up-list');
    list.innerHTML = '';
    var totalVisible = items.filter(function (it) { return it.state !== 'removed'; }).length;
    var visible = sortedItems();
    if ($('queue-sort')) $('queue-sort').classList.toggle('hidden', totalVisible < 2);
    if ($('queue-search')) $('queue-search').classList.toggle('hidden', totalVisible < 4);
    if (queueFilter && !visible.length && totalVisible) {
      var none = document.createElement('p'); none.className = 'muted sm'; none.textContent = t('historyNoMatch'); list.appendChild(none);
    }
    // Drag-to-reorder only makes sense in manual "order added" mode with no active filter.
    var canDrag = sortMode === 'added' && !queueFilter && !sending;
    visible.forEach(function (it, visibleIndex) {
      if (it.state === 'removed') return;
      var row = document.createElement('div'); row.className = 'uprow' + (selectedIds.has(it.id) ? ' selected' : ''); row.dataset.id = it.id;
      row.dataset.swipeHint = t('swipeRemove') + ' · ' + (it.state === 'error' ? t('swipeRetry') : t('swipePause'));
      if (canDrag) {
        row.draggable = true;
        row.addEventListener('dragstart', function (e) { dragId = it.id; row.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.id); } catch (_) {} });
        row.addEventListener('dragend', function () { row.classList.remove('dragging'); dragId = null; var over = list.querySelectorAll('.uprow.drag-over'); for (var k = 0; k < over.length; k++) over[k].classList.remove('drag-over'); });
        row.addEventListener('dragover', function (e) { if (dragId && dragId !== it.id) { e.preventDefault(); row.classList.add('drag-over'); } });
        row.addEventListener('dragleave', function () { row.classList.remove('drag-over'); });
        row.addEventListener('drop', function (e) { e.preventDefault(); row.classList.remove('drag-over'); reorderQueue(dragId, it.id); });
      }
      var top = document.createElement('div'); top.className = 'top';
      var sel = document.createElement('input'); sel.type = 'checkbox'; sel.className = 'sel'; sel.checked = selectedIds.has(it.id); sel.setAttribute('aria-label', t('selectAll'));
      sel.addEventListener('change', function () { if (sel.checked) selectedIds.add(it.id); else selectedIds.delete(it.id); row.classList.toggle('selected', sel.checked); updateBulkBar(); });
      top.appendChild(sel);
      if (/^image\//.test(it.type) && it.file) {
        var img = document.createElement('img'); img.className = 'thumb'; img.alt = ''; img.title = t('lightboxAlt');
        try {
          var url = URL.createObjectURL(it.file); img.src = url; img.onload = img.onerror = function () { URL.revokeObjectURL(url); };
        } catch (_) {}
        (function (item) { img.addEventListener('click', function () { openPreview(item); }); })(it);
        top.appendChild(img);
      } else {
        var ico = document.createElement('span'); ico.className = 'file-ico'; ico.setAttribute('aria-hidden', 'true'); ico.textContent = fileIcon(it.name, it.type); top.appendChild(ico);
      }
      var name = document.createElement('input'); name.className = 'nm-input'; name.type = 'text'; name.value = displayFileName(it, visibleIndex); name.setAttribute('aria-label', privacyNames ? t('privacyNames') : t('edit'));
      name.disabled = privacyNames || !!(it.snapshot || ['sending', 'encrypting', 'optimizing', 'done'].indexOf(it.state) !== -1);
      name.addEventListener('change', function () {
        if (name.disabled) { toast(t('renameLocked'), 'warn'); return; }
        it.name = safeName(name.value); name.value = it.name; invalidatePreparedPayload(it); persistItem(it);
      });
      top.appendChild(name);
      var status = document.createElement('span'); status.className = 'st' + (it.state === 'done' ? ' ok' : it.state === 'error' ? ' err' : ''); status.textContent = statusText(it); top.appendChild(status);
      var actions = document.createElement('div'); actions.className = 'row-actions';
      if (it.file) {
        var pv = document.createElement('button'); pv.type = 'button'; pv.className = 'icon-action preview'; pv.textContent = '◉'; pv.title = t('preview'); pv.setAttribute('aria-label', t('preview'));
        pv.addEventListener('click', function () { openPreview(it); }); actions.appendChild(pv);
      }
      if (it.state === 'error') {
        var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'icon-action'; retry.textContent = '↻'; retry.title = t('retry'); retry.setAttribute('aria-label', t('retry'));
        retry.addEventListener('click', function () { retryItem(it); }); actions.appendChild(retry);
      }
      if (/^image\//.test(it.type) && it.file && !it.snapshot && ['sending', 'encrypting', 'optimizing', 'done'].indexOf(it.state) === -1) {
        var ann = document.createElement('button'); ann.type = 'button'; ann.className = 'icon-action annotate'; ann.textContent = '✎'; ann.title = t('annotate'); ann.setAttribute('aria-label', t('annotate'));
        ann.addEventListener('click', function () { openAnnotate(it); }); actions.appendChild(ann);
        var rot = document.createElement('button'); rot.type = 'button'; rot.className = 'icon-action rotate'; rot.textContent = '⟳'; rot.title = t('rotate'); rot.setAttribute('aria-label', t('rotate'));
        rot.addEventListener('click', function () { rotateItem(it); }); actions.appendChild(rot);
      }
      if (it.file) {
        var hb = document.createElement('button'); hb.type = 'button'; hb.className = 'icon-action hash'; hb.textContent = '⌗'; hb.title = t('hashTitle'); hb.setAttribute('aria-label', t('hashTitle'));
        hb.addEventListener('click', function () { copyFileHash(it); }); actions.appendChild(hb);
      }
      if (canDrag) {
        var up = document.createElement('button'); up.type = 'button'; up.className = 'icon-action move'; up.textContent = '↑'; up.title = t('moveEarlier'); up.setAttribute('aria-label', t('moveEarlier'));
        up.disabled = visibleIndex === 0; up.addEventListener('click', function () { moveQueueItem(it.id, -1); }); actions.appendChild(up);
        var down = document.createElement('button'); down.type = 'button'; down.className = 'icon-action move'; down.textContent = '↓'; down.title = t('moveLater'); down.setAttribute('aria-label', t('moveLater'));
        down.disabled = visibleIndex === visible.length - 1; down.addEventListener('click', function () { moveQueueItem(it.id, 1); }); actions.appendChild(down);
      }
      var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'icon-action remove'; rm.textContent = '✕'; rm.title = t('remove'); rm.setAttribute('aria-label', t('remove'));
      rm.addEventListener('click', function () { removeItem(it, true); }); actions.appendChild(rm); top.appendChild(actions);
      row.appendChild(top);
      var progress = document.createElement('progress'); progress.max = Math.max(1, it.upSize || it.size || 1); progress.value = Math.min(progress.max, it.sentBytes || 0);
      progress.setAttribute('aria-label', t('progress', { name: displayFileName(it, visibleIndex) })); row.appendChild(progress);
      var meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = rowMetaText(it); row.appendChild(meta);
      list.appendChild(row);
      attachSwipeGestures(row, it);
      it.row = row; it.progress = progress; it.status = status; it.meta = meta; it.nameInput = name;
    });
    updateBulkBar(); updateFilesCount(); updateAppBadge();
  }
  function selectedItems() {
    return items.filter(function (it) { return it.state !== 'removed' && selectedIds.has(it.id); });
  }
  function updateBulkBar() {
    // Drop ids that no longer map to a live item, then reflect the count.
    var live = Object.create(null); items.forEach(function (it) { if (it.state !== 'removed') live[it.id] = true; });
    Array.from(selectedIds).forEach(function (id) { if (!live[id]) selectedIds.delete(id); });
    var bar = $('bulk-bar'); if (!bar) return;
    var n = selectedIds.size;
    bar.classList.toggle('hidden', n === 0);
    if (n) $('bulk-count').textContent = t('selectedN', { n: n });
    updateMasterSelect();
  }
  async function bulkRemove() {
    var targets = selectedItems(); selectedIds.clear();
    for (var i = 0; i < targets.length; i++) await removeItem(targets[i]);
    updateBulkBar();
  }
  function bulkRetry() {
    selectedItems().forEach(function (it) { if (it.state === 'error') { it.state = 'waiting'; it.errorCode = null; persistItem(it); } });
    renderQueue(); updateSendBtn(); if (!sending) startBatch();
  }
  function updateItemUi(it, label, cls) {
    if (!it.status) return;
    it.status.textContent = label || statusText(it);
    it.status.className = 'st' + (cls ? ' ' + cls : '');
    var total = it.upSize || it.size || 1;
    it.progress.max = Math.max(1, total); it.progress.value = Math.min(total, it.sentBytes || 0);
  }
  async function cancelPartial(it) {
    var snap = it.snapshot;
    if (!snap || !it.uploadId) return;
    try {
      await fetch('/u/' + encodeURIComponent(snap.token) + '/upload-cancel?id=' + encodeURIComponent(it.uploadId), { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
  }
  async function removeItem(it, offerUndo) {
    // Snapshot enough to rebuild the row if the user taps "Undo" (feature 10). Only
    // offered for single, user-initiated removals — never bulk/clear sweeps.
    if (offerUndo && it.file && it.state !== 'done') {
      lastRemoved = {
        id: it.id, file: it.file, name: it.name, originalName: it.originalName, type: it.type,
        size: it.size, lastModified: it.lastModified, note: it.note || '', volatile: it.volatile,
        preparedBlob: (it.preparedBlob && it.preparedBlob !== it.file) ? it.preparedBlob : null,
        upName: it.upName || null, upSize: it.upSize || null, preparedEncrypted: !!it.preparedEncrypted,
        optimized: !!it.optimized, snapshot: it.snapshot || null
      };
      showUndo(privacyNames ? privateFileName(Math.max(0, sortedItems().indexOf(it))) : it.name);
    }
    if (it.xhr) { try { it.xhr.abort(); } catch (_) {} }
    activeXhrs.delete(it.xhr); it.state = 'removed';
    await cancelPartial(it); await removePersistedItem(it);
    items = items.filter(function (x) { return x !== it; });
    renderQueue(); updateSendBtn(); updateGlobalProgress(); updateStorageStatus();
  }
  async function clearPending() {
    if (!askConfirmation('delete', t('clearQueueConfirm'))) return;
    var targets = items.filter(function (it) { return it.state !== 'done'; });
    for (var i = 0; i < targets.length; i++) await removeItem(targets[i]);
  }
  function clearDone() {
    items = items.filter(function (it) { return it.state !== 'done'; }); renderQueue(); updateSendBtn();
  }
  function retryItem(it) {
    if (it.state === 'sending') return;
    it.state = 'waiting'; it.errorCode = null; persistItem(it); renderQueue(); updateSendBtn();
    if (!sending) startBatch([it]);
  }
  function retryAll() {
    items.filter(function (it) { return it.state === 'error'; }).forEach(function (it) { it.state = 'waiting'; it.errorCode = null; persistItem(it); });
    renderQueue(); updateSendBtn(); if (!sending) startBatch();
  }

  // Image preparation + E2E --------------------------------------------------
  function loadImageEl(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
  function loadImage(file) {
    // createImageBitmap is fastest but rejects on HEIC/HEIF in some engines; fall
    // back to an <img> element, which decodes those natively on iOS Safari.
    if ('createImageBitmap' in window) return createImageBitmap(file).catch(function () { return loadImageEl(file); });
    return loadImageEl(file);
  }
  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) { canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('encode')); }, type, quality); });
  }
  async function optimizeImage(it) {
    var file = it.file;
    var optimize = $('optimize-images').checked;
    var strip = !!($('strip-exif') && $('strip-exif').checked);
    if (!file || !/^image\//.test(it.type) || /svg|gif/i.test(it.type)) return file;
    if (!optimize && !strip) return file;
    it.state = 'optimizing'; updateItemUi(it, t('optimizing'));
    try {
      var image = await loadImage(file);
      // Optimize path: user-chosen dimension cap + JPEG quality. Strip-only path:
      // re-encode at native size (a canvas round-trip drops EXIF/GPS), keeping PNG
      // so transparency survives; the result is used even if slightly larger.
      var maxSel = $('img-maxdim') ? parseInt($('img-maxdim').value, 10) : 2560;
      var max = optimize && maxSel > 0 ? maxSel : Infinity;
      var toPng = !optimize && /png/i.test(it.type || '');
      var outType = toPng ? 'image/png' : 'image/jpeg';
      var quality = optimize ? ($('img-quality') ? (parseFloat($('img-quality').value) || 0.86) : 0.86) : 0.92;
      var width = image.width, height = image.height;
      var scale = Math.min(1, max / Math.max(width, height));
      var canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      var ctx = canvas.getContext('2d', { alpha: toPng }); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (image.close) image.close();
      var blob = await canvasBlob(canvas, outType, outType === 'image/jpeg' ? quality : undefined);
      // When only stripping, always keep the re-encoded blob (that is the whole
      // point). When optimizing, skip if it did not actually get smaller.
      if (optimize && blob.size >= file.size && !/heic|heif/i.test(it.type)) return file;
      var ext = toPng ? '.png' : '.jpg';
      var newName = it.name.replace(/\.[^.\/]+$/, '') + ext; it.name = newName; it.optimized = optimize;
      return namedFile(blob, newName, outType, it.lastModified);
    } catch (_) {
      toast(/heic|heif/i.test(it.type) ? t('heicFallback') : t('optimizeFallback'), 'warn');
      return file;
    }
  }

  // --- Image links: turn a device image into a direct /i/<token> link (full-size,
  //     Mini, and Micro), no relay page. The bytes are uploaded (a phone photo isn't
  //     on the host FS); both smaller variants are generated on-device. The
  //     returned URLs already use the Images domain when the admin configured one. ---
  async function makeImageVariants(file) {
    var image = await loadImage(file);
    var w = image.width, h = image.height;
    var thumbScale = Math.min(1, 480 / Math.max(w, h));
    var thumbWidth = Math.max(1, Math.round(w * thumbScale));
    var thumbHeight = Math.max(1, Math.round(h * thumbScale));
    async function make(width, height) {
      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
      // Near-lossless JPEG for the Mini/Micro variants: same resolution as before but
      // ~3× the file size and visibly cleaner (raised from 0.82). 1.0 is avoided as it
      // disables chroma subsampling and roughly sextuples the size for no visible gain.
      return canvasBlob(canvas, 'image/jpeg', 0.99);
    }
    try {
      var microWidth = Math.max(1, Math.round(thumbWidth / 2));
      var microHeight = Math.max(1, Math.round(thumbHeight / 2));
      var adaptiveScale = Math.min(1, 1920 / Math.max(w, h));
      var adaptiveCanvas = document.createElement('canvas');
      adaptiveCanvas.width = Math.max(1, Math.round(w * adaptiveScale)); adaptiveCanvas.height = Math.max(1, Math.round(h * adaptiveScale));
      adaptiveCanvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, adaptiveCanvas.width, adaptiveCanvas.height);
      var webp = null, avif = null;
      try { webp = await canvasBlob(adaptiveCanvas, 'image/webp', 0.86); if (!/image\/webp/i.test(webp.type || '')) webp = null; } catch (_) {}
      try { avif = await canvasBlob(adaptiveCanvas, 'image/avif', 0.78); if (!/image\/avif/i.test(avif.type || '')) avif = null; } catch (_) {}
      return {
        width: w, height: h,
        thumbWidth: thumbWidth, thumbHeight: thumbHeight,
        microWidth: microWidth, microHeight: microHeight,
        thumb: await make(thumbWidth, thumbHeight),
        micro: await make(microWidth, microHeight),
        adaptiveWebp: webp, adaptiveAvif: avif,
      };
    } finally {
      if (image.close) image.close();
    }
  }
  // POST a revocation for a PWA-created share (image link or reception link).
  // Resolves true on success. The server authorizes by device/account ownership.
  function revokeShareRequest(token) {
    return appMutate('/app/share/' + encodeURIComponent(token) + '/revoke', 'application/json', null)
      .then(function (r) { return r.ok; }).catch(function () { return false; });
  }

  // ---- Server-file shares (standard Direct-Xfer function) ------------------
  // Browse the read-only host filesystem and turn a file/folder into a public
  // /s or /f link, exactly like the desktop admin. The server restricts these to
  // an administrator session, so a bare paired device sees the "sign in" note.
  var shareCwd = '/';
  var shareSelected = Object.create(null); // hostPath -> { name, size }
  var sharesInitialised = false;
  var sharesWired = false;
  var activeShareCount = 0; // active file/folder share links, shown as the Partages nav badge

  function onSharesPanelShown() {
    initShares();
    // Re-run on every open (not only the first) so the admin-required note re-evaluates
    // whenever the session state changed since last time — it must appear immediately,
    // not only after the user pokes a button.
    sharesBrowse(sharesInitialised ? shareCwd : '/');
    loadHostShares();
    loadReceptions();
    sharesInitialised = true;
  }

  function initShares() {
    if (sharesWired) return; sharesWired = true;
    if ($('share-up')) $('share-up').addEventListener('click', function () {
      var parent = $('share-up').getAttribute('data-parent');
      if (parent) sharesBrowse(parent);
    });
    if ($('share-refresh')) $('share-refresh').addEventListener('click', function () { sharesBrowse(shareCwd); loadHostShares(); loadReceptions(); });
    if ($('share-create-btn')) $('share-create-btn').addEventListener('click', createHostShare);
    updateShareSelection();
  }

  function showSharesAuthNote(show) {
    if ($('share-auth-note')) $('share-auth-note').classList.toggle('hidden', !show);
  }

  async function sharesBrowse(path) {
    var listEl = $('share-browser-list'); if (!listEl) return;
    listEl.textContent = '…';
    try {
      var r = await fetch('/app/host/browse?path=' + encodeURIComponent(path || '/'), { credentials: 'same-origin', cache: 'no-store' });
      // Any "not an admin session" response drives the sign-in note: 403 when the device
      // is paired but has no live admin session (the reported case), 401 once the session
      // was explicitly ended/locked. Either way the browse cannot proceed, so warn.
      if (r.status === 403 || r.status === 401) { showSharesAuthNote(true); listEl.textContent = ''; return; }
      if (!r.ok) throw new Error('browse');
      showSharesAuthNote(false);
      var data = await r.json();
      shareCwd = data.cwd || '/';
      if ($('share-path')) $('share-path').value = shareCwd;
      if ($('share-up')) { $('share-up').setAttribute('data-parent', data.parent || ''); $('share-up').disabled = !data.parent; }
      renderShareBrowser(data.entries || []);
    } catch (_) { listEl.textContent = ''; toast(t('sharesBrowseFail'), 'err'); }
  }

  function renderShareBrowser(entries) {
    var listEl = $('share-browser-list'); listEl.textContent = '';
    entries.forEach(function (e) {
      var rowEl = document.createElement('div'); rowEl.className = 'share-row' + (e.isDir ? ' is-dir' : '');
      if (e.isDir) {
        // A folder can be BOTH selected (its own checkbox → a folder share) and opened
        // (the name/chevron navigates in), mirroring the standard admin multi-select.
        var dcb = document.createElement('input'); dcb.type = 'checkbox'; dcb.className = 'share-check'; dcb.checked = !!shareSelected[e.path];
        dcb.addEventListener('change', function () { toggleShareItem(e, dcb.checked); });
        rowEl.appendChild(dcb);
        var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'share-entry share-nav';
        var ico = document.createElement('span'); ico.className = 'share-ico'; ico.textContent = '📁'; btn.appendChild(ico);
        var nm = document.createElement('span'); nm.className = 'share-name'; nm.textContent = e.name; btn.appendChild(nm);
        var chev = document.createElement('span'); chev.className = 'share-chevron'; chev.textContent = '›'; btn.appendChild(chev);
        btn.addEventListener('click', function () { sharesBrowse(e.path); });
        rowEl.appendChild(btn);
      } else {
        var lab = document.createElement('label'); lab.className = 'share-entry';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!shareSelected[e.path];
        cb.addEventListener('change', function () { toggleShareItem(e, cb.checked); });
        lab.appendChild(cb);
        var ico2 = document.createElement('span'); ico2.className = 'share-ico'; ico2.textContent = '📄'; lab.appendChild(ico2);
        var nm2 = document.createElement('span'); nm2.className = 'share-name'; nm2.textContent = e.name; lab.appendChild(nm2);
        var sz = document.createElement('span'); sz.className = 'share-size muted sm'; sz.textContent = e.size != null ? fmtBytes(e.size) : ''; lab.appendChild(sz);
        rowEl.appendChild(lab);
      }
      listEl.appendChild(rowEl);
    });
    if (!entries.length) { var em = document.createElement('p'); em.className = 'muted sm'; em.textContent = '—'; listEl.appendChild(em); }
  }

  function toggleShareItem(entry, checked) {
    if (checked) shareSelected[entry.path] = { name: entry.name, size: entry.size };
    else delete shareSelected[entry.path];
    updateShareSelection();
  }

  function selectedSharePaths() { return Object.keys(shareSelected); }

  function updateShareSelection() {
    var paths = selectedSharePaths();
    if ($('share-selected')) $('share-selected').textContent = paths.length ? t('sharesSelected', { n: paths.length }) : t('sharesNoneSelected');
    if ($('share-create-btn')) $('share-create-btn').disabled = paths.length === 0;
  }

  async function createHostShare() {
    var paths = selectedSharePaths();
    if (!paths.length) return;
    var btn = $('share-create-btn'), status = $('share-create-status');
    var prev = btn.textContent; btn.disabled = true; btn.textContent = t('sharesCreating');
    if (status) { status.textContent = ''; status.className = 'dest-status muted'; }
    var payload = {
      paths: paths,
      expiresInSeconds: Number($('share-expiry') && $('share-expiry').value) || 0,
      maxDownloads: Number($('share-maxdl') && $('share-maxdl').value) || 0,
      password: ($('share-password') && $('share-password').value) || ''
    };
    try {
      var r = await appMutate('/app/host/shares', 'application/json', JSON.stringify(payload));
      if (!r.ok) throw new Error('create ' + r.status);
      var data = await r.json();
      var url = data.share && data.share.url;
      shareSelected = Object.create(null); updateShareSelection();
      if ($('share-password')) $('share-password').value = '';
      sharesBrowse(shareCwd);
      if (url) { try { await copyText(url); } catch (_) {} }
      if (status) { status.textContent = t('sharesCreated'); status.className = 'dest-status ok'; }
      toast(t('sharesCreated'), 'ok');
      loadHostShares();
    } catch (_) {
      if (status) { status.textContent = t('sharesCreateFail'); status.className = 'dest-status err'; }
      toast(t('sharesCreateFail'), 'err');
    } finally { btn.textContent = prev; btn.disabled = selectedSharePaths().length === 0; }
  }

  async function loadHostShares() {
    try {
      var r = await fetch('/app/host/shares', { credentials: 'same-origin', cache: 'no-store' });
      // The admin-required note is driven solely by the FS-browse endpoint (session-only);
      // this list works for admin devices too, so it must not toggle that note.
      if (r.status === 403) { activeShareCount = 0; updatePwaNavBadges(); return; }
      if (!r.ok) throw new Error('list');
      var data = await r.json();
      var shares = data.shares || [];
      // Badge count = active share links only (an expired / disabled link is not "active").
      activeShareCount = shares.filter(function (s) { return s && s.active !== false; }).length;
      updatePwaNavBadges();
      if ($('share-list')) renderHostShares(shares);
    } catch (_) {}
  }

  function renderHostShares(list) {
    var listEl = $('share-list'); listEl.textContent = '';
    if (!list.length) { var em = document.createElement('p'); em.className = 'muted sm'; em.textContent = t('sharesEmpty'); listEl.appendChild(em); return; }
    list.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'share-link-row';
      var main = document.createElement('div'); main.className = 'share-link-main';
      var strong = document.createElement('strong'); strong.textContent = s.name || s.token; main.appendChild(strong);
      var meta = document.createElement('div'); meta.className = 'muted sm';
      var bits = [];
      if (s.type === 'folder') bits.push('📁');
      if (s.collection && s.itemCount) bits.push(t('sharesItems', { n: s.itemCount }));
      else if (s.size != null) bits.push(fmtBytes(s.size));
      bits.push(fmtDate(s.createdAt));
      meta.textContent = bits.join(' · '); main.appendChild(meta);
      row.appendChild(main);
      var actions = document.createElement('div'); actions.className = 'share-link-actions';
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn ghost sm'; copy.textContent = '🔗 ' + t('sharesCopy');
      copy.addEventListener('click', function () { if (s.url) copyText(s.url).then(function () { toast(t('copied'), 'ok'); }); });
      actions.appendChild(copy);
      var open = document.createElement('button'); open.type = 'button'; open.className = 'btn ghost sm'; open.textContent = t('sharesOpen');
      open.addEventListener('click', function () { if (s.url) window.open(s.url, '_blank', 'noopener'); });
      actions.appendChild(open);
      var rev = document.createElement('button'); rev.type = 'button'; rev.className = 'btn danger sm'; rev.textContent = t('sharesRevoke');
      rev.addEventListener('click', function () { revokeHostShare(s.token); });
      actions.appendChild(rev);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  async function revokeHostShare(token) {
    if (!askConfirmation('revoke', t('sharesRevokeConfirm'))) return;
    var ok = await revokeShareRequest(token);
    if (ok) { toast(t('sharesRevoked'), 'ok'); loadHostShares(); }
    else toast(t('sharesRevokeFail'), 'err');
  }

  // Reception links (type inbox) — including ones created on the standard web version.
  // Map a server reception record onto the destination shape. No key/passphrase is known
  // (a plain reception link carries none), and it is never marked "remembered" so it is
  // not written to local storage — it re-derives from the server on every load.
  function receptionAsDest(s) {
    return {
      token: s.token, name: s.name || '', key: '', rememberKey: false,
      sourceOrigin: location.origin, remembered: false, owned: s.owned !== false,
      createdAt: s.createdAt || 0, fromServer: true
    };
  }
  async function loadReceptions() {
    try {
      var r = await fetch('/app/receptions', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 403) return; // note is driven by the FS-browse endpoint only
      if (!r.ok) throw new Error('receptions');
      var data = await r.json();
      var list = data.receptions || [];
      // Feed the first-page Destination picker so every reception link (any origin) is
      // selectable there, then keep the Partages panel's detailed list in sync.
      serverReceptions = list.map(receptionAsDest);
      renderDests();
      if ($('reception-list')) renderReceptions(list);
    } catch (_) {}
  }

  function renderReceptions(list) {
    var listEl = $('reception-list'); listEl.textContent = '';
    if (!list.length) { var em = document.createElement('p'); em.className = 'muted sm'; em.textContent = t('sharesReceptionsEmpty'); listEl.appendChild(em); return; }
    list.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'share-link-row';
      var main = document.createElement('div'); main.className = 'share-link-main';
      var strong = document.createElement('strong'); strong.textContent = s.name || s.token; main.appendChild(strong);
      var meta = document.createElement('div'); meta.className = 'muted sm';
      var bits = ['📥'];
      if (s.bytesReceived) bits.push(t('sharesReceived', { bytes: fmtBytes(s.bytesReceived) }));
      bits.push(fmtDate(s.createdAt));
      meta.textContent = bits.join(' · '); main.appendChild(meta);
      row.appendChild(main);
      var actions = document.createElement('div'); actions.className = 'share-link-actions';
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn ghost sm'; copy.textContent = '🔗 ' + t('sharesCopy');
      copy.addEventListener('click', function () { if (s.url) copyText(s.url).then(function () { toast(t('copied'), 'ok'); }); });
      actions.appendChild(copy);
      var open = document.createElement('button'); open.type = 'button'; open.className = 'btn ghost sm'; open.textContent = t('sharesOpen');
      open.addEventListener('click', function () { if (s.url) window.open(s.url, '_blank', 'noopener'); });
      actions.appendChild(open);
      var rev = document.createElement('button'); rev.type = 'button'; rev.className = 'btn danger sm'; rev.textContent = t('sharesRevoke');
      rev.addEventListener('click', function () { revokeReception(s.token); });
      actions.appendChild(rev);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  async function revokeReception(token) {
    if (!askConfirmation('revoke', t('sharesRevokeConfirm'))) return;
    var ok = await revokeShareRequest(token);
    if (ok) { toast(t('sharesRevoked'), 'ok'); loadReceptions(); }
    else toast(t('sharesRevokeFail'), 'err');
  }

  function imageJsonMutation(url, payload) {
    return appMutate(url, 'application/json', JSON.stringify(payload || {}));
  }
  function imageVariantUrl(photo, kind) {
    return kind === 'auto' ? (photo.autoUrl || photo.imgUrl) : kind === 'thumb' ? photo.thumbUrl : kind === 'micro' ? photo.microUrl : photo.imgUrl;
  }
  function imagePreviewUrl(photo, kind) {
    var previews = photo && photo.previewUrls || {};
    var url = previews[kind] || imageVariantUrl(photo, kind);
    if (kind === 'auto' && previews.auto && url) {
      var width = Math.max(1, Math.ceil((window.innerWidth || 0) * (window.devicePixelRatio || 1)));
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'w=' + encodeURIComponent(width);
    }
    return url;
  }
  function imageCardPreviewUrl(photo) {
    var previews = photo && photo.previewUrls || {};
    return previews.micro || previews.thumb || previews.full || photo.microUrl || photo.thumbUrl || photo.imgUrl;
  }
  function imageDefaultVariant() {
    return $('img-default-variant') ? $('img-default-variant').value : 'full';
  }
  function persistImagePreferences() {
    var ids = ['img-sort', 'img-filter', 'img-default-variant', 'img-expiry', 'img-max-views', 'img-hotlink-hosts', 'img-smart-blur', 'img-tags', 'img-note', 'img-rename-template', 'img-copy-template', 'img-action-1', 'img-action-2', 'img-action-3'];
    ids.forEach(function (id) { var el = $(id); if (el) try { localStorage.setItem('dx-pwa-' + id, el.value); } catch (_) {} });
    ['img-compact', 'img-hide-expired', 'img-auto-copy', 'img-notify-first-view'].forEach(function (id) { var el = $(id); if (el) try { localStorage.setItem('dx-pwa-' + id, el.checked ? '1' : '0'); } catch (_) {} });
  }
  function restoreImagePreferences() {
    ['img-sort', 'img-filter', 'img-default-variant', 'img-expiry', 'img-max-views', 'img-hotlink-hosts', 'img-smart-blur', 'img-tags', 'img-note', 'img-rename-template', 'img-copy-template', 'img-action-1', 'img-action-2', 'img-action-3'].forEach(function (id) {
      var el = $(id); if (!el) return;
      try { var v = localStorage.getItem('dx-pwa-' + id); if (v !== null) el.value = v; } catch (_) {}
    });
    [['img-compact', false], ['img-hide-expired', true], ['img-auto-copy', false], ['img-notify-first-view', false]].forEach(function (pair) {
      var el = $(pair[0]); if (!el) return;
      try { var v = localStorage.getItem('dx-pwa-' + pair[0]); el.checked = v === null ? pair[1] : v === '1'; } catch (_) { el.checked = pair[1]; }
    });
    if ($('imglink-list')) $('imglink-list').classList.toggle('img-compact', !!($('img-compact') && $('img-compact').checked));
    if ($('img-copy-template') && !$('img-copy-template').value) $('img-copy-template').value = 'standard';
    if ($('img-action-1') && !$('img-action-1').value) $('img-action-1').value = 'full';
    if ($('img-action-2') && !$('img-action-2').value) $('img-action-2').value = 'open';
    if ($('img-action-3') && !$('img-action-3').value) $('img-action-3').value = 'qr';
  }
  function colorForTag(tag) {
    tag = String(tag || '').trim().toLowerCase();
    if (tagColorMap[tag]) return tagColorMap[tag];
    var hash = 0; for (var i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    return 'hsl(' + (Math.abs(hash) % 360) + ' 62% 42%)';
  }
  function tagTextColor(color) {
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) return '#fff';
    var n = parseInt(color.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#101828' : '#fff';
  }
  function persistTagColors() { try { localStorage.setItem('dx-pwa-tag-colors', JSON.stringify(tagColorMap)); } catch (_) {} }
  function knownImageTags() {
    var tags = new Set();
    imageRecordsByToken.forEach(function (photo) { (photo.tags || []).forEach(function (tag) { if (tag) tags.add(String(tag).trim().toLowerCase()); }); });
    String($('img-tags') && $('img-tags').value || '').split(',').forEach(function (tag) { tag = tag.trim().toLowerCase(); if (tag) tags.add(tag); });
    return Array.from(tags).sort();
  }
  function renderTagColorManager() {
    var host = $('tag-color-list'); if (!host) return;
    host.innerHTML = '';
    var tags = knownImageTags();
    if (!tags.length) { var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = '—'; host.appendChild(empty); return; }
    tags.forEach(function (tag) {
      var row = document.createElement('label'); row.className = 'tag-color-row';
      var name = document.createElement('span'); name.textContent = '#' + tag;
      var input = document.createElement('input'); input.type = 'color'; input.value = /^#[0-9a-f]{6}$/i.test(tagColorMap[tag] || '') ? tagColorMap[tag] : '#3b6ef6'; input.setAttribute('aria-label', '#' + tag);
      input.addEventListener('input', function () { tagColorMap[tag] = input.value; persistTagColors(); imageRowsByToken.forEach(function (r, token) { var p = imageRecordsByToken.get(token); if (p) renderImageVariantStats(r, p); }); });
      row.appendChild(name); row.appendChild(input); host.appendChild(row);
    });
  }
  function favoriteImageActions() {
    var raw = ['img-action-1', 'img-action-2', 'img-action-3'].map(function (id) { return $(id) ? $(id).value : ''; }).filter(Boolean);
    return Array.from(new Set(raw.length ? raw : ['full', 'open', 'qr'])).slice(0, 3);
  }
  function arrangeImageActions(row) {
    if (!row) return;
    var mapping = { auto: '.il-auto', full: '.il-full', thumb: '.il-thumb', micro: '.il-micro', open: '.il-open', qr: '.il-qr', edit: '.il-edit', pin: '.il-favorite', qrdl: '.il-qrdl', replace: '.il-replace', versions: '.il-versions' };
    var favorites = favoriteImageActions();
    Object.keys(mapping).forEach(function (kind) { var el = row.querySelector(mapping[kind]); if (el) el.classList.toggle('action-secondary', favorites.indexOf(kind) === -1); });
    var more = row.querySelector('.il-more'); if (more) more.classList.toggle('hidden', !row.querySelector('.action-secondary'));
  }
  function formatRemaining(ms) {
    var sec = Math.max(0, Math.floor(ms / 1000));
    if (sec <= 0) return t('expiredNow');
    var d = Math.floor(sec / 86400); sec %= 86400; var h = Math.floor(sec / 3600); sec %= 3600; var m = Math.floor(sec / 60); var s = sec % 60;
    if (d) return d + (lang === 'fr' ? 'j ' : 'd ') + h + 'h'; if (h) return h + 'h ' + m + 'min'; if (m) return m + 'min ' + s + 's'; return s + 's';
  }
  function updateExpiryCountdowns() {
    if (document.visibilityState !== 'visible') return;
    document.querySelectorAll('[data-expiry-countdown]').forEach(function (el) {
      var at = Number(el.getAttribute('data-expiry-countdown')) || 0;
      el.textContent = at > Date.now() ? t('expiresIn', { time: formatRemaining(at - Date.now()) }) : t('expiredNow');
      el.classList.toggle('warn', at > 0 && at - Date.now() < 3600000);
    });
  }
  function startExpiryCountdowns() {
    clearInterval(imageCountdownTimer); imageCountdownTimer = setInterval(updateExpiryCountdowns, 1000); updateExpiryCountdowns();
  }
  function imageOptionsFromUi() {
    return {
      expiresInSeconds: Number($('img-expiry') && $('img-expiry').value) || 0,
      maxViews: Number($('img-max-views') && $('img-max-views').value) || 0,
      password: $('img-password') ? $('img-password').value : '',
      hotlinkHosts: $('img-hotlink-hosts') ? $('img-hotlink-hosts').value : '',
      notifyFirstView: !!($('img-notify-first-view') && $('img-notify-first-view').checked),
      smartBlurMode: $('img-smart-blur') ? $('img-smart-blur').value : 'off',
      tags: $('img-tags') ? $('img-tags').value.split(',').map(function (x) { return x.trim(); }).filter(Boolean) : [],
      note: $('img-note') ? $('img-note').value.trim() : ''
    };
  }
  function retentionRulesFromUi() {
    return {
      enabled: !!($('img-retention-enabled') && $('img-retention-enabled').checked),
      maxAgeDays: Number($('img-retention-age') && $('img-retention-age').value) || 0,
      inactiveDays: Number($('img-retention-inactive') && $('img-retention-inactive').value) || 0,
      maxViews: Number($('img-retention-views') && $('img-retention-views').value) || 0,
      maxStorageMB: Number($('img-retention-storage') && $('img-retention-storage').value) || 0
    };
  }
  function renderRetentionSummary(summary) {
    var el = $('img-retention-summary'); if (!el) return;
    summary = summary || {};
    el.textContent = t('imgRetentionSummary', { n: Number(summary.images) || 0, bytes: fmtBytes(Number(summary.bytes) || 0) });
  }
  async function loadImageRetentionRules() {
    try {
      var r = await fetch('/app/images/retention', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      var data = await r.json(); imageRetentionRules = data.rules || {};
      if ($('img-retention-enabled')) $('img-retention-enabled').checked = !!imageRetentionRules.enabled;
      if ($('img-retention-age')) $('img-retention-age').value = String(Number(imageRetentionRules.maxAgeDays) || 0);
      if ($('img-retention-inactive')) $('img-retention-inactive').value = String(Number(imageRetentionRules.inactiveDays) || 0);
      if ($('img-retention-views')) $('img-retention-views').value = String(Number(imageRetentionRules.maxViews) || 0);
      if ($('img-retention-storage')) $('img-retention-storage').value = String(Number(imageRetentionRules.maxStorageMB) || 0);
      renderRetentionSummary(data.summary);
    } catch (_) {}
  }
  async function saveImageRetentionRules() {
    var rules = retentionRulesFromUi();
    var destructive = rules.enabled && (rules.maxAgeDays || rules.inactiveDays || rules.maxViews || rules.maxStorageMB);
    if (destructive && !window.confirm(t('imgRetentionWarning'))) return;
    var btn = $('img-retention-save'); if (btn) btn.disabled = true;
    try {
      var payload = Object.assign({ runNow: true }, rules);
      var r = await imageJsonMutation('/app/images/retention', payload);
      if (!r.ok) throw new Error('http ' + r.status);
      var data = await r.json(); imageRetentionRules = data.rules || rules;
      var result = data.result || {};
      toast(result.revoked ? t('imgRetentionResult', { n: result.revoked, bytes: fmtBytes(result.bytesFreed || 0) }) : t('imgRetentionSaved'), result.revoked ? 'warn' : 'ok');
      await refreshImageStats(true); await loadImageRetentionRules();
    } catch (_) { toast(t('revokeFail'), 'err'); }
    finally { if (btn) btn.disabled = false; }
  }

  function imageActionLabel(action) {
    var labels = { created: 'Création', copied: 'Copie', opened: 'Ouverture', edited: 'Modification', revoked: 'Révocation', restored: 'Annulation', qr: 'QR', album: 'Album' };
    return labels[action] || action;
  }
  function mergeImageActionHistory() {
    var seen = Object.create(null), merged = [];
    Array.prototype.slice.call(arguments).forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (entry) {
        if (!entry || !entry.at) return;
        var key = [entry.at, entry.action || '', entry.token || '', entry.name || '', entry.detail || ''].join('|');
        if (seen[key]) return;
        seen[key] = true; merged.push(entry);
      });
    });
    return merged.sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); }).slice(0, 250);
  }
  function persistImageActionHistory() {
    try { localStorage.setItem('dx-pwa-image-actions', JSON.stringify(imageActionHistory)); } catch (_) {}
    return metaSet('imageActionHistory', imageActionHistory.slice(0, 250)).catch(function () {});
  }
  function recordImageAction(action, photo, detail) {
    imageActionHistory.unshift({ at: Date.now(), action: action, token: photo && photo.token || '', name: photo && photo.name || '', detail: detail || '' });
    imageActionHistory = imageActionHistory.slice(0, 250);
    persistImageActionHistory();
    renderImageActionHistory();
  }
  function renderImageActionHistory() {
    var host = $('img-action-history'); if (!host) return;
    host.innerHTML = '';
    imageActionHistory.slice(0, 80).forEach(function (entry) {
      var row = document.createElement('div'); row.className = 'image-action-row';
      var time = document.createElement('time'); time.dateTime = new Date(entry.at).toISOString(); time.textContent = new Date(entry.at).toLocaleString();
      var txt = document.createElement('span'); txt.textContent = imageActionLabel(entry.action) + ' · ' + (entry.name || entry.token || 'image') + (entry.detail ? ' · ' + entry.detail : '');
      row.appendChild(time); row.appendChild(txt); host.appendChild(row);
    });
  }
  function imageRecordBytes(photo) { return photo && photo.totals ? Number(photo.totals.bytes) || 0 : 0; }
  function imageRecordViews(photo) { return photo && photo.totals ? Number(photo.totals.views) || 0 : 0; }
  function imageRecordVisitors(photo) { return photo && photo.totals ? Number(photo.totals.visitors) || 0 : 0; }
  function updateImageBulkBar() {
    var bar = $('img-bulk-bar'); if (!bar) return;
    bar.classList.toggle('hidden', selectedImageTokens.size === 0);
    if ($('img-selected-count')) $('img-selected-count').textContent = t('imgSelected', { n: selectedImageTokens.size });
    if ($('img-select-all')) {
      var visible = Array.from(imageRowsByToken.values()).filter(function (row) { return !row.classList.contains('hidden'); });
      $('img-select-all').checked = visible.length > 0 && visible.every(function (row) { return selectedImageTokens.has(row.dataset.token); });
      $('img-select-all').indeterminate = selectedImageTokens.size > 0 && !$('img-select-all').checked;
    }
  }
  function selectImageToken(token, selected) {
    if (selected) selectedImageTokens.add(token); else selectedImageTokens.delete(token);
    var row = imageRowsByToken.get(token);
    if (row) { row.classList.toggle('selected', selected); var cb = row.querySelector('.img-select'); if (cb) cb.checked = selected; }
    updateImageBulkBar();
  }
  function applyImageView() {
    var q = String($('img-search') && $('img-search').value || '').trim().toLowerCase();
    var filter = $('img-filter') ? $('img-filter').value : 'all';
    var hideExpired = !!($('img-hide-expired') && $('img-hide-expired').checked);
    var now = Date.now();
    var rows = [];
    imageRowsByToken.forEach(function (row, token) {
      var photo = imageRecordsByToken.get(token); if (!photo) return;
      var hay = [photo.name, token, (photo.tags || []).join(' '), photo.note || ''].join(' ').toLowerCase();
      var show = !q || hay.indexOf(q) !== -1;
      if (hideExpired && photo.expired) show = false;
      if (show && filter === 'active') show = !!photo.active;
      if (show && filter === 'popular') show = imageRecordViews(photo) >= 10;
      if (show && filter === 'large') show = imageRecordBytes(photo) >= 5 * 1024 * 1024;
      if (show && filter === 'expiring') show = !!photo.expiresAt && photo.expiresAt > now && photo.expiresAt - now <= 86400000;
      if (show && filter === 'favorite') show = !!photo.favorite;
      if (show && filter === 'protected') show = !!photo.hasPassword;
      row.classList.toggle('hidden', !show);
      if (show) rows.push({ row: row, photo: photo });
    });
    var sort = $('img-sort') ? $('img-sort').value : 'date-desc';
    rows.sort(function (a, b) {
      if (!!a.photo.favorite !== !!b.photo.favorite) return a.photo.favorite ? -1 : 1;
      if (sort === 'date-asc') return (a.photo.createdAt || 0) - (b.photo.createdAt || 0);
      if (sort === 'name') return String(a.photo.name || '').localeCompare(String(b.photo.name || ''));
      if (sort === 'size') return imageRecordBytes(b.photo) - imageRecordBytes(a.photo);
      if (sort === 'views') return imageRecordViews(b.photo) - imageRecordViews(a.photo);
      if (sort === 'visitors') return imageRecordVisitors(b.photo) - imageRecordVisitors(a.photo);
      if (sort === 'expiry') return (a.photo.expiresAt || Number.MAX_SAFE_INTEGER) - (b.photo.expiresAt || Number.MAX_SAFE_INTEGER);
      return (b.photo.createdAt || 0) - (a.photo.createdAt || 0);
    });
    var host = $('imglink-list'); rows.forEach(function (item) { host.appendChild(item.row); });
    updateImageBulkBar();
  }
  function imageRename(name, index) {
    var tpl = String($('img-rename-template') && $('img-rename-template').value || '').trim();
    if (!tpl) return name;
    var dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot + 1) : '';
    var now = new Date();
    var out = tpl.replace(/\{name\}/gi, base).replace(/\{ext\}/gi, ext).replace(/\{n\}/gi, String(index + 1).padStart(3, '0'))
      .replace(/\{date\}/gi, now.toISOString().slice(0, 10)).replace(/\{time\}/gi, now.toTimeString().slice(0, 8).replace(/:/g, '-'));
    if (out.indexOf('.') === -1 && ext) out += '.' + ext;
    return safeName(out).slice(0, 120) || name;
  }
  async function sha256Blob(blob) {
    if (!(window.crypto && crypto.subtle) || !blob || blob.size > 256 * 1024 * 1024) return '';
    var buf = await blob.arrayBuffer();
    var digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function imageDuplicate(hash) {
    if (!hash) return null;
    try { var r = await fetch('/app/image/duplicate?hash=' + encodeURIComponent(hash), { credentials: 'same-origin', cache: 'no-store' }); return r.ok ? (await r.json()).image : null; } catch (_) { return null; }
  }
  async function imageQrPng(photo) {
    var url = imageVariantUrl(photo, imageDefaultVariant());
    var r = await fetch('/app/qr?data=' + encodeURIComponent(url), { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('qr');
    var svg = await r.text();
    var blob = new Blob([svg], { type: 'image/svg+xml' });
    var objectUrl = URL.createObjectURL(blob); var image = new Image();
    await new Promise(function (resolve, reject) { image.onload = resolve; image.onerror = reject; image.src = objectUrl; });
    var canvas = document.createElement('canvas'); canvas.width = image.naturalWidth || 512; canvas.height = image.naturalHeight || 512;
    var ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0);
    URL.revokeObjectURL(objectUrl);
    return canvasBlob(canvas, 'image/png');
  }
  async function downloadImageQr(photo) {
    try {
      var png = await imageQrPng(photo);
      var dl = document.createElement('a'); dl.href = URL.createObjectURL(png); dl.download = (photo.name || 'direct-xfer').replace(/\.[^.]+$/, '') + '-qr.png'; dl.click(); setTimeout(function () { URL.revokeObjectURL(dl.href); }, 1000);
      recordImageAction('qr', photo, 'PNG'); toast(t('imgQrDownloaded'), 'ok');
    } catch (_) { toast(t('qrFail'), 'err'); }
  }
  async function downloadImageQrZip() {
    var photos = Array.from(selectedImageTokens).map(function (token) { return imageRecordsByToken.get(token); }).filter(Boolean);
    if (!photos.length) photos = Array.from(imageRecordsByToken.values()).filter(function (photo) { var row = imageRowsByToken.get(photo.token); return photo.active && row && !row.classList.contains('hidden'); });
    if (!photos.length) { toast(t('noImgLinks'), 'warn'); return; }
    try {
      var entries = [], used = Object.create(null);
      for (var i = 0; i < photos.length; i++) {
        var png = await imageQrPng(photos[i]); var base = safeName((photos[i].name || 'image').replace(/\.[^.]+$/, '')) || ('image-' + (i + 1)); var name = base + '-qr.png'; var n = 2;
        while (used[name]) name = base + '-' + (n++) + '-qr.png'; used[name] = true;
        entries.push({ name: name, data: new Uint8Array(await png.arrayBuffer()) });
      }
      var zip = buildZip(entries); var a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = 'direct-xfer-qr-' + new Date().toISOString().slice(0, 10) + '.zip'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast(t('imgQrZipDone'), 'ok');
    } catch (_) { toast(t('qrFail'), 'err'); }
  }
  function csvCell(value) { var text = String(value == null ? '' : value); return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; }
  function exportImageStatsCsv() {
    var rows = [['token','name','createdAt','expiresAt','active','pinned','tags','fullWidth','fullHeight','fullBytes','fullViews','fullVisitors','miniWidth','miniHeight','miniBytes','miniViews','miniVisitors','microWidth','microHeight','microBytes','microViews','microVisitors','totalBytes','totalViews','totalVisitors']];
    Array.from(imageRecordsByToken.values()).forEach(function (photo) {
      var v = photo.variants || {}, full = v.full || {}, thumb = v.thumb || {}, micro = v.micro || {}, totals = photo.totals || {};
      rows.push([photo.token, photo.name, new Date(photo.createdAt || 0).toISOString(), photo.expiresAt ? new Date(photo.expiresAt).toISOString() : '', photo.active !== false, !!photo.favorite, (photo.tags || []).join('|'), full.w, full.h, full.bytes, full.views, full.visitors, thumb.w, thumb.h, thumb.bytes, thumb.views, thumb.visitors, micro.w, micro.h, micro.bytes, micro.views, micro.visitors, totals.bytes, totals.views, totals.visitors]);
    });
    var csv = '\ufeff' + rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'direct-xfer-images-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); toast(t('imgStatsCsvDone'), 'ok');
  }
  function scheduleImageRevoke(row, photo) {
    if (!row || !photo || pendingImageRevokes.has(photo.token)) return;
    row.classList.add('pending-revoke');
    var st = row.querySelector('.imglink-st'); if (st) st.textContent = t('imgRevokePending');
    var timer = setTimeout(function () {
      pendingImageRevokes.delete(photo.token);
      revokeShareRequest(photo.token).then(function (ok) {
        if (ok) { removeImageRow(row, photo.token, photo.imgUrl); imageRecordsByToken.delete(photo.token); recordImageAction('revoked', photo); toast(t('revokeSuccess'), 'ok'); }
        else { row.classList.remove('pending-revoke'); renderImageVariantStats(row, photo); toast(t('revokeFail'), 'err'); }
      });
    }, 8500);
    pendingImageRevokes.set(photo.token, timer);
    showUndo(photo.name, function () {
      clearTimeout(timer); pendingImageRevokes.delete(photo.token); row.classList.remove('pending-revoke'); renderImageVariantStats(row, photo); recordImageAction('restored', photo); toast(t('fileRestored'), 'ok');
    }, t('imgUndoRevoke'));
  }
  async function editSelectedImages() {
    var tokens = Array.from(selectedImageTokens); if (!tokens.length) return;
    var tags = window.prompt(t('imgTags') + ' (séparés par des virgules; vide = effacer)', $('img-tags') ? $('img-tags').value : ''); if (tags === null) return;
    var note = window.prompt(t('imgPrivateNote') + ' (vide = effacer)', $('img-note') ? $('img-note').value : ''); if (note === null) return;
    var maxViews = window.prompt(t('imgMaxViews') + ' (0 = illimité)', $('img-max-views') ? $('img-max-views').value : '0'); if (maxViews === null) return;
    var expiry = window.prompt(t('imgDefaultExpiry') + ' en secondes (0 = jamais)', $('img-expiry') ? $('img-expiry').value : '0'); if (expiry === null) return;
    var password = window.prompt(t('imgPassword') + ' (vide = retirer)', ''); if (password === null) return;
    var hotlinkHosts = window.prompt(t('imgHotlinkHosts') + ' (vide = désactiver)', $('img-hotlink-hosts') ? $('img-hotlink-hosts').value : ''); if (hotlinkHosts === null) return;
    var notifyFirstView = window.confirm(t('imgNotifyFirstView'));
    var settings = { tags: tags.split(',').map(function (x) { return x.trim(); }).filter(Boolean), note: note, maxViews: Number(maxViews) || 0, expiresInSeconds: Number(expiry) || 0, password: password, hotlinkHosts: hotlinkHosts, notifyFirstView: notifyFirstView };
    var r = await imageJsonMutation('/app/images/bulk', { tokens: tokens, action: 'settings', settings: settings });
    if (r.ok) { toast(t('imgSettingsSaved'), 'ok'); recordImageAction('edited', { name: tokens.length + ' images' }); await refreshImageStats(true); }
    else toast(t('revokeFail'), 'err');
  }
  async function createAlbumFromSelection() {
    var tokens = Array.from(selectedImageTokens); if (!tokens.length) return;
    var name = window.prompt(t('imgAlbumName'), 'Album ' + new Date().toLocaleDateString()); if (!name) return;
    var password = window.prompt(t('imgPassword') + ' (' + t('optional') + ')', ''); if (password === null) return;
    var opts = imageOptionsFromUi();
    var r = await imageJsonMutation('/app/albums', { tokens: tokens, name: name, password: password, expiresInSeconds: opts.expiresInSeconds, tags: opts.tags, note: opts.note });
    if (!r.ok) { toast(t('imgLinkFail'), 'err'); return; }
    var data = await r.json(); toast(t('imgAlbumCreated'), 'ok'); recordImageAction('album', data.album, tokens.length + ' images'); await refreshAlbums();
  }
  async function bulkRevokeImages() {
    var tokens = Array.from(selectedImageTokens); if (!tokens.length || !askConfirmation('revoke', t('revokeConfirm'))) return;
    var r = await imageJsonMutation('/app/images/bulk', { tokens: tokens, action: 'revoke' });
    if (!r.ok) { toast(t('revokeFail'), 'err'); return; }
    // Batch the local cleanup: drop DOM rows + in-memory maps in one pass, delete
    // from the localStorage journal once, and refresh the toolbars a single time —
    // instead of calling removeImageRow() (localStorage write + refresh) per token.
    var set = new Set(tokens);
    tokens.forEach(function (token) {
      var row = imageRowsByToken.get(token);
      if (row && row.parentNode) row.parentNode.removeChild(row);
      imageRowsByToken.delete(token); imageRecordsByToken.delete(token); selectedImageTokens.delete(token);
    });
    imageLinkUrls = imageLinkUrls.filter(function (o) { return !set.has(o.token); });
    deleteCachedImageRecords(set);
    recordImageAction('revoked', { name: tokens.length + ' images' });
    refreshCopyAll(); updateImageBulkBar();
    toast(t('revokeSuccess'), 'ok');
  }
  async function editAlbum(album) {
    if (!album) return;
    var name = window.prompt(t('imgAlbumName'), album.name || 'Album'); if (name === null) return;
    var expiry = window.prompt(t('imgDefaultExpiry') + ' en secondes à partir de maintenant (0 = jamais)', album.expiresAt ? String(Math.max(1, Math.round((album.expiresAt - Date.now()) / 1000))) : '0'); if (expiry === null) return;
    var password = window.prompt(t('imgPassword') + ' (vide = retirer; annuler = conserver)', '');
    var tags = window.prompt(t('imgTags') + ' (séparés par des virgules)', (album.tags || []).join(', ')); if (tags === null) return;
    var note = window.prompt(t('imgPrivateNote'), album.note || ''); if (note === null) return;
    var payload = { name: name, expiresInSeconds: Number(expiry) || 0, tags: tags.split(',').map(function (x) { return x.trim(); }).filter(Boolean), note: note };
    if (password !== null) payload.password = password;
    var r = await imageJsonMutation('/app/album/' + encodeURIComponent(album.token) + '/settings', payload);
    if (!r.ok) { toast(t('revokeFail'), 'err'); return; }
    var updated = (await r.json()).album || album;
    recordImageAction('edited', updated, 'album'); toast(t('imgSettingsSaved'), 'ok'); await refreshAlbums();
  }
  async function manageAlbumInvitations(album) {
    var r = await fetch('/app/album/' + encodeURIComponent(album.token) + '/invitations', { credentials: 'same-origin', cache: 'no-store' });
    var existing = r.ok ? ((await r.json()).invitations || []) : [];
    var summary = existing.map(function (x, i) { return (i + 1) + '. ' + x.role + ' · ' + (x.label || '') + (x.disabled ? ' · révoquée' : '') + (x.expiresAt ? ' · ' + new Date(x.expiresAt).toLocaleString() : ''); }).join('\n');
    var action = window.prompt(t('albumInvites') + '\n' + (summary || '—') + '\n\n1 = ' + t('albumInviteCreate') + '\n2 = ' + t('albumInviteRevoke'), '1');
    if (action === null) return;
    if (String(action).trim() === '2') {
      if (!existing.length) return;
      var n = window.prompt(t('albumInviteRevoke') + '\n' + summary, '1'); if (n === null) return;
      var item = existing[Math.max(0, Math.min(existing.length - 1, (parseInt(n, 10) || 1) - 1))];
      var rr = await imageJsonMutation('/app/album/' + encodeURIComponent(album.token) + '/invitations/' + encodeURIComponent(item.id) + '/revoke', {});
      if (rr.ok) { toast(t('revokeSuccess'), 'ok'); refreshAlbums(); }
      return;
    }
    var role = (window.prompt(t('albumInviteRole'), 'contributor') || 'contributor').toLowerCase();
    if (!['reader','contributor','manager'].includes(role)) role = 'contributor';
    var label = window.prompt('Libellé', role) || role;
    var hours = Number(window.prompt('Expiration en heures (0 = jamais)', '24')) || 0;
    var maxFiles = role === 'reader' ? 0 : (Number(window.prompt('Nombre maximal de fichiers (0 = illimité)', '20')) || 0);
    var maxMb = role === 'reader' ? 0 : (Number(window.prompt('Taille maximale par fichier en Mo', '20')) || 20);
    var created = await imageJsonMutation('/app/album/' + encodeURIComponent(album.token) + '/invitations', { role: role, label: label, expiresInSeconds: hours > 0 ? hours * 3600 : 0, maxFiles: maxFiles, maxFileBytes: maxMb * 1024 * 1024 });
    if (!created.ok) { toast(t('imgLinkFail'), 'err'); return; }
    var data = await created.json(); await copyText(data.url); toast(t('albumInviteCopied'), 'ok'); refreshAlbums();
  }

  async function refreshAlbums() {
    var host = $('img-album-list'); if (!host) return;
    try { var r = await fetch('/app/albums', { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) throw new Error(); imageAlbums = (await r.json()).albums || []; } catch (_) { imageAlbums = []; }
    host.innerHTML = '';
    if (!imageAlbums.length) { var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = t('imgNoAlbums'); host.appendChild(empty); return; }
    imageAlbums.sort(function (a, b) { var ap = pinnedAlbumTokens.has(a.token), bp = pinnedAlbumTokens.has(b.token); if (ap !== bp) return ap ? -1 : 1; return (b.createdAt || 0) - (a.createdAt || 0); });
    imageAlbums.forEach(function (album) {
      var pinned = pinnedAlbumTokens.has(album.token);
      var row = document.createElement('div'); row.className = 'album-row' + (pinned ? ' pinned' : '');
      var name = document.createElement('span'); name.className = 'album-name'; name.textContent = album.name;
      var meta = document.createElement('span'); meta.className = 'album-meta'; meta.textContent = album.count + ' images · 👁 ' + (album.views || 0) + (album.hasPassword ? ' · 🔒' : '') + (album.collaboration && album.collaboration.invitations ? ' · 👥 ' + album.collaboration.invitations : '');
      if (album.expiresAt) { var countdown = document.createElement('span'); countdown.className = 'album-countdown'; countdown.setAttribute('data-expiry-countdown', String(album.expiresAt)); meta.appendChild(document.createTextNode(' · ')); meta.appendChild(countdown); }
      var pin = document.createElement('button'); pin.className = 'btn ghost sm' + (pinned ? ' active' : ''); pin.type = 'button'; pin.textContent = '📌'; pin.title = pinned ? t('unpinItem') : t('pinItem'); pin.onclick = function () { if (pinnedAlbumTokens.has(album.token)) pinnedAlbumTokens.delete(album.token); else pinnedAlbumTokens.add(album.token); try { localStorage.setItem('dx-pwa-pinned-albums', JSON.stringify(Array.from(pinnedAlbumTokens))); } catch (_) {} refreshAlbums(); };
      var copy = document.createElement('button'); copy.className = 'btn ghost sm'; copy.type = 'button'; copy.textContent = t('copy'); copy.onclick = function () { copyText(album.url).then(function () { toast(t('imgAlbumCopied'), 'ok'); }); };
      var open = document.createElement('button'); open.className = 'btn ghost sm'; open.type = 'button'; open.textContent = '👁'; open.onclick = function () { window.open(album.url, '_blank', 'noopener'); };
      var edit = document.createElement('button'); edit.className = 'btn ghost sm'; edit.type = 'button'; edit.textContent = '✎'; edit.title = t('imgBulkEdit'); edit.onclick = function () { editAlbum(album); };
      var invites = document.createElement('button'); invites.className = 'btn ghost sm'; invites.type = 'button'; invites.textContent = '👥'; invites.title = t('albumInvites'); invites.onclick = function () { manageAlbumInvitations(album); };
      row.appendChild(name); row.appendChild(meta); row.appendChild(pin); row.appendChild(copy); row.appendChild(open); row.appendChild(edit); row.appendChild(invites); host.appendChild(row);
    });
    updateExpiryCountdowns();
  }
  function drawImageDashboard(data) {
    var canvas = $('img-dashboard-canvas'); if (!canvas || !data) return;
    var ctx = canvas.getContext('2d'); var w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h);
    var styles = getComputedStyle(document.documentElement); var text = styles.getPropertyValue('--text').trim() || '#fff'; var accent = styles.getPropertyValue('--accent').trim() || '#3b82f6'; var faint = styles.getPropertyValue('--border').trim() || '#334155';
    ctx.fillStyle = text; ctx.font = '13px system-ui'; ctx.fillText('Vues', 12, 20);
    var series = data.series || []; var max = Math.max(1, ...series.map(function (x) { return Math.max(x.views || 0, x.created || 0); })); var pad = 34; var cw = (w - pad * 2) / Math.max(1, series.length);
    ctx.strokeStyle = faint; ctx.beginPath(); ctx.moveTo(pad, h - 28); ctx.lineTo(w - pad, h - 28); ctx.stroke();
    series.forEach(function (point, i) {
      var x = pad + i * cw + cw * .15, barW = cw * .3; var vh = (point.views || 0) / max * (h - 70); var ch = (point.created || 0) / max * (h - 70);
      ctx.fillStyle = accent; ctx.fillRect(x, h - 28 - vh, barW, vh); ctx.globalAlpha = .45; ctx.fillRect(x + barW + 2, h - 28 - ch, barW, ch); ctx.globalAlpha = 1;
      ctx.fillStyle = text; ctx.font = '10px system-ui'; var d = new Date(point.at); ctx.fillText((d.getMonth() + 1) + '/' + d.getDate(), x - 2, h - 10);
    });
  }
  async function refreshImageDashboard() {
    try { var r = await fetch('/app/images/dashboard?days=7', { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) throw new Error(); var data = await r.json(); if ($('img-dashboard-summary')) $('img-dashboard-summary').textContent = t('imgChartSummary', { images: data.totals.images, views: data.totals.views, visitors: data.totals.visitors, bytes: fmtBytes(data.totals.bytes) }); drawImageDashboard(data); } catch (_) {}
  }
  function warnExpiringImages(photos) {
    var now = Date.now(), changed = false;
    photos.forEach(function (photo) {
      if (!photo.active || !photo.expiresAt || photo.expiresAt - now > 86400000 || photo.expiresAt <= now || warnedImageExpiries.has(photo.token)) return;
      warnedImageExpiries.add(photo.token); changed = true; toast(t('imgExpirySoon', { name: photo.name }), 'warn');
      if ('Notification' in window && Notification.permission === 'granted') try { new Notification('Direct-Xfer', { body: t('imgExpirySoon', { name: photo.name }), icon: '/app/icon-192.png' }); } catch (_) {}
    });
    if (changed) try { localStorage.setItem('dx-pwa-image-expiry-warned', JSON.stringify(Array.from(warnedImageExpiries).slice(-500))); } catch (_) {}
  }

  // Inline SVG icons for the icon-only buttons (Feather-style, 24×24, stroke=currentColor
   // so they inherit the button colour and adapt to light/dark; self-contained = CSP-safe).
  // Matches the bottom-nav icon style. Sized via CSS (.btn svg / .iv-open svg).
  function dxIcon(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var ICONS = {
    eye: dxIcon('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    star: dxIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    edit: dxIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
    grid: dxIcon('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
    refresh: dxIcon('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    clock: dxIcon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    maximize: dxIcon('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
    more: dxIcon('<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
    x: dxIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')
  };

  function imgLinkRow(name, previewUrl, previewIsObjectUrl) {
    var row = document.createElement('div'); row.className = 'imglink-row';
    row.innerHTML =
      '<div class="imglink-card-head">' +
      '<input class="img-select hidden" type="checkbox" aria-label="Sélectionner">' +
      '<img class="imglink-thumb" alt="">' +
      '<div class="imglink-main"><div class="imglink-name"></div>' +
      '<div class="imglink-st muted sm"></div>' +
      '<div class="imglink-meta"></div><div class="imglink-note hidden"></div></div>' +
      '<button class="il-revoke hidden" type="button">' + ICONS.x + '</button></div>' +
      '<div class="imglink-summary-row"><div class="imglink-total muted sm hidden" aria-label="Statistiques totales"><span class="img-total-metric it-views"><span class="img-total-icon" aria-hidden="true">👁</span><span class="img-total-text">—</span></span><span class="img-total-metric it-visitors"><span class="img-total-icon" aria-hidden="true">👤</span><span class="img-total-text">—</span></span></div></div>' +
      '<div class="imglink-variants hidden" role="list">' +
      '<div class="imgvariant" data-kind="full" role="listitem"><span class="iv-name"></span><span class="iv-dims">—</span><span class="iv-size">—</span><span class="iv-metrics"><span class="iv-metric iv-views"><span class="iv-metric-icon" aria-hidden="true">👁</span><span class="iv-metric-text">—</span></span><span class="iv-metric iv-visitors"><span class="iv-metric-icon" aria-hidden="true">👤</span><span class="iv-metric-text">—</span></span></span><button class="iv-open" type="button">' + ICONS.eye + '</button></div>' +
      '<div class="imgvariant" data-kind="thumb" role="listitem"><span class="iv-name"></span><span class="iv-dims">—</span><span class="iv-size">—</span><span class="iv-metrics"><span class="iv-metric iv-views"><span class="iv-metric-icon" aria-hidden="true">👁</span><span class="iv-metric-text">—</span></span><span class="iv-metric iv-visitors"><span class="iv-metric-icon" aria-hidden="true">👤</span><span class="iv-metric-text">—</span></span></span><button class="iv-open" type="button">' + ICONS.eye + '</button></div>' +
      '<div class="imgvariant" data-kind="micro" role="listitem"><span class="iv-name"></span><span class="iv-dims">—</span><span class="iv-size">—</span><span class="iv-metrics"><span class="iv-metric iv-views"><span class="iv-metric-icon" aria-hidden="true">👁</span><span class="iv-metric-text">—</span></span><span class="iv-metric iv-visitors"><span class="iv-metric-icon" aria-hidden="true">👤</span><span class="iv-metric-text">—</span></span></span><button class="iv-open" type="button">' + ICONS.eye + '</button></div>' +
      '</div>' +
      '<div class="imglink-actions hidden">' +
      '<div class="imglink-action-group imglink-copy-group"><span class="imglink-action-label imglink-copy-label"></span><div class="imglink-action-buttons">' +
      '<button class="btn ghost sm il-auto" type="button"></button>' +
      '<button class="btn ghost sm il-full" type="button"></button>' +
      '<button class="btn ghost sm il-thumb" type="button"></button>' +
      '<button class="btn ghost sm il-micro" type="button"></button></div></div>' +
      '<div class="imglink-action-group imglink-manage-group"><span class="imglink-action-label imglink-manage-label"></span><div class="imglink-action-buttons">' +
      '<button class="btn ghost sm il-open" type="button"></button>' +
      '<button class="btn ghost sm il-favorite" type="button">' + ICONS.star + '</button>' +
      '<button class="btn ghost sm il-edit" type="button">' + ICONS.edit + '</button>' +
      '<button class="btn ghost sm il-qr" type="button">' + ICONS.grid + '</button>' +
      '<button class="btn ghost sm il-qrdl" type="button">⇩QR</button>' +
      '<button class="btn ghost sm il-replace" type="button">' + ICONS.refresh + '</button><button class="btn ghost sm il-versions" type="button">' + ICONS.clock + '</button><button class="btn ghost sm il-resize-mini" type="button">' + ICONS.maximize + '</button><button class="btn ghost sm il-more" type="button" aria-label="Plus d’actions">' + ICONS.more + '</button></div></div></div>';
    row.querySelector('.imglink-name').textContent = name;
    if (previewUrl) {
      var im = row.querySelector('.imglink-thumb'); im.src = previewUrl;
      if (previewIsObjectUrl) im.onload = im.onerror = function () { URL.revokeObjectURL(previewUrl); };
    }
    var list = $('imglink-list'); list.insertBefore(row, list.firstChild);
    return row;
  }
  function imageVariantLabel(kind) {
    return kind === 'full' ? t('imgVariantFull') : kind === 'thumb' ? t('imgVariantMini') : t('imgVariantMicro');
  }
  function renderImageVariantStats(row, photo) {
    if (!row || !photo) return;
    var variants = photo.variants || {};
    ['full', 'thumb', 'micro'].forEach(function (kind) {
      var line = row.querySelector('.imgvariant[data-kind="' + kind + '"]');
      if (!line) return;
      var variant = variants[kind] || {};
      line.querySelector('.iv-name').textContent = imageVariantLabel(kind);
      line.querySelector('.iv-dims').textContent = variant.w && variant.h ? variant.w + '×' + variant.h : '—';
      line.querySelector('.iv-size').textContent = fmtBytes(variant.bytes);
      line.querySelector('.iv-views .iv-metric-text').textContent = t('imgViews', { n: Number(variant.views) || 0 });
      line.querySelector('.iv-visitors .iv-metric-text').textContent = t('imgVisitors', { n: Number(variant.visitors) || 0 });
      var openVariant = line.querySelector('.iv-open');
      if (openVariant) {
        var canOpen = photo.active !== false && variant.ready !== false && !!imageVariantUrl(photo, kind);
        openVariant.disabled = !canOpen;
        openVariant.title = t('imgOpen') + ' — ' + imageVariantLabel(kind);
        openVariant.setAttribute('aria-label', openVariant.title);
      }
      line.classList.toggle('not-ready', variant.ready === false);
    });
    var total = row.querySelector('.imglink-total');
    if (total && photo.totals) {
      total.querySelector('.it-views .img-total-text').textContent = t('imgViews', { n: Number(photo.totals.views) || 0 });
      total.querySelector('.it-visitors .img-total-text').textContent = t('imgVisitors', { n: Number(photo.totals.visitors) || 0 });
      total.classList.remove('hidden');
    }
    row.querySelector('.imglink-variants').classList.remove('hidden');
    row.classList.toggle('expired', !!photo.expired);
    row.classList.toggle('pinned', !!photo.favorite);
    var meta = row.querySelector('.imglink-meta');
    if (meta) {
      meta.innerHTML = '';
      function chip(text, cls) { var el = document.createElement('span'); el.className = 'img-chip' + (cls ? ' ' + cls : ''); el.textContent = text; meta.appendChild(el); return el; }
      if (photo.expired) chip(t('imgExpired'), 'warn');
      if (photo.hasPassword) chip('🔒 ' + t('imgProtected'), 'lock');
      if (photo.maxViews) chip(t('imgViewLimit', { n: photo.maxViews }));
      if (photo.hotlinkHosts && photo.hotlinkHosts.length) chip('🔗 ' + t('imgHotlinkProtected'), 'hotlink');
      if (photo.notifyFirstView) chip(photo.firstViewNotifiedAt ? ('✓ ' + t('imgFirstViewSent')) : ('🔔 ' + t('imgFirstViewArmed')), 'first-view');
      if (photo.adaptive && (photo.adaptive.webp || photo.adaptive.avif)) chip('⚡ ' + t('imgAdaptiveReady'), 'adaptive');
      if (photo.metadataRemoved) chip('🛡 ' + t('imgMetadataRemoved'), 'privacy');
      if (photo.versionCount) chip('⏱ ' + photo.versionCount + ' ' + t('imgVersions'), 'versions');
      if (photo.expiresAt && !photo.expired) { var expiryChip = chip(''); expiryChip.setAttribute('data-expiry-countdown', String(photo.expiresAt)); }
      (photo.tags || []).forEach(function (tag) { var tagChip = chip('#' + tag, 'tag-chip'); var color = colorForTag(tag); tagChip.style.background = color; tagChip.style.borderColor = color; tagChip.style.color = tagTextColor(color); });
    }
    var note = row.querySelector('.imglink-note');
    if (note) { note.textContent = photo.note || ''; note.classList.toggle('hidden', !photo.note); }
    ['.il-auto', '.il-full', '.il-thumb', '.il-micro', '.il-open', '.il-qr', '.il-qrdl', '.il-replace', '.il-versions', '.il-resize-mini'].forEach(function (selector) {
      var action = row.querySelector(selector); if (action) action.disabled = !photo.active;
    });
  }
  function imageDataUrls(data) {
    return {
      token: data.token,
      name: data.name,
      createdAt: data.createdAt || Date.now(),
      expiresAt: data.expiresAt || null,
      active: data.active !== false,
      expired: !!data.expired,
      disabled: !!data.disabled,
      status: data.status || (data.active === false ? 'inactive' : 'active'),
      imgUrl: data.imgUrl,
      thumbUrl: data.thumbUrl,
      microUrl: data.microUrl,
      autoUrl: data.autoUrl || data.imgUrl,
      previewUrls: data.previewUrls || {},
      adaptive: data.adaptive || {},
      versionCount: Number(data.versionCount) || 0,
      variants: data.variants || {},
      totals: data.totals || null,
      favorite: !!data.favorite,
      tags: Array.isArray(data.tags) ? data.tags : [],
      note: data.note || '',
      clientHash: data.clientHash || null,
      maxViews: Number(data.maxViews) || 0,
      hasPassword: !!data.hasPassword,
      hotlinkHosts: Array.isArray(data.hotlinkHosts) ? data.hotlinkHosts : [],
      notifyFirstView: !!data.notifyFirstView,
      firstViewNotifiedAt: data.firstViewNotifiedAt || null,
      retentionReason: data.retentionReason || null,
      metadataRemoved: !!data.metadataRemoved,
      localCommittedAt: Math.max(0, Number(data.localCommittedAt) || 0),
      lastServerConfirmedAt: Math.max(0, Number(data.lastServerConfirmedAt) || 0),
    };
  }
  function mergeCachedImageRecords() {
    var byToken = new Map();
    Array.prototype.slice.call(arguments).forEach(function (records) {
      (Array.isArray(records) ? records : []).forEach(function (photo) {
        if (!photo || !photo.token) return;
        var normalized = imageDataUrls(photo);
        var previous = byToken.get(normalized.token);
        var score = Math.max(normalized.lastServerConfirmedAt || 0, normalized.localCommittedAt || 0, normalized.createdAt || 0);
        var previousScore = previous ? Math.max(previous.lastServerConfirmedAt || 0, previous.localCommittedAt || 0, previous.createdAt || 0) : -1;
        if (!previous || score >= previousScore) byToken.set(normalized.token, normalized);
      });
    });
    return Array.from(byToken.values()).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).slice(0, MAX_IMAGE_BACKUP);
  }
  function readImageBackup() {
    try {
      var parsed = JSON.parse(localStorage.getItem(IMAGE_BACKUP_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter(function (photo) { return photo && photo.token; }) : [];
    } catch (_) { return []; }
  }
  function writeImageBackup(records) {
    try { localStorage.setItem(IMAGE_BACKUP_KEY, JSON.stringify(mergeCachedImageRecords(records))); } catch (_) {}
  }
  function backupImageRecord(photo) {
    if (!photo || !photo.token) return;
    writeImageBackup([photo].concat(readImageBackup()));
  }
  async function loadCachedImages() {
    var indexed = await idbGetAll(IMAGE_STORE).catch(function () { return []; });
    var merged = mergeCachedImageRecords(indexed, readImageBackup());
    writeImageBackup(merged);
    await Promise.all(merged.map(function (record) { return idbPut(IMAGE_STORE, record); })).catch(function () {});
    return merged;
  }
  function persistImageRecord(photo) {
    if (!photo || !photo.token) return Promise.resolve();
    var record = imageDataUrls(photo);
    // localStorage is a compact recovery journal for browsers that temporarily
    // fail or block IndexedDB during a service-worker update/page reload.
    backupImageRecord(record);
    return idbPut(IMAGE_STORE, record).catch(function () {});
  }
  function deleteCachedImageRecord(token) {
    if (!token) return Promise.resolve();
    // A deletion only removes an entry, so write the filtered journal straight back.
    // Do NOT round-trip through writeImageBackup()/mergeCachedImageRecords(), which
    // re-normalizes every record via imageDataUrls() — that made each deletion O(n)
    // (and a bulk revoke O(n²)), which is the lag when removing image links.
    try { localStorage.setItem(IMAGE_BACKUP_KEY, JSON.stringify(readImageBackup().filter(function (photo) { return photo && photo.token !== token; }))); } catch (_) {}
    return idbDelete(IMAGE_STORE, token).catch(function () {});
  }
  // Batched deletion for multi-select revoke: one localStorage read/write for the
  // whole set instead of one per token.
  function deleteCachedImageRecords(tokens) {
    var set = tokens instanceof Set ? tokens : new Set(tokens);
    if (!set.size) return;
    try { localStorage.setItem(IMAGE_BACKUP_KEY, JSON.stringify(readImageBackup().filter(function (photo) { return photo && !set.has(photo.token); }))); } catch (_) {}
    set.forEach(function (tk) { idbDelete(IMAGE_STORE, tk).catch(function () {}); });
  }
  function replaceCachedImages(photos) {
    // Preserve every durable source when a list response is partial. The previous
    // implementation kept IndexedDB records but overwrote the localStorage recovery
    // journal with only the latest response, so browsers with unavailable/evicted
    // IndexedDB lost a just-uploaded card on the next refresh.
    var incoming = (Array.isArray(photos) ? photos : []).filter(function (photo) { return photo && photo.token; }).map(imageDataUrls);
    var records = mergeCachedImageRecords(readImageBackup(), Array.from(imageRecordsByToken.values()), incoming);
    writeImageBackup(records);
    return Promise.all(records.map(function (record) { return idbPut(IMAGE_STORE, record); })).then(function () {
      return metaSet('imageCacheUpdatedAt', Date.now());
    }).catch(function () {});
  }
  function decodeImageBootstrap(raw) {
    try {
      var binary = atob(String(raw || '').replace(/\s+/g, ''));
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var text = typeof TextDecoder === 'function' ? new TextDecoder('utf-8').decode(bytes)
        : decodeURIComponent(Array.prototype.map.call(bytes, function (b) { return '%' + b.toString(16).padStart(2, '0'); }).join(''));
      var parsed = JSON.parse(text);
      return parsed && Array.isArray(parsed.images) ? parsed.images : [];
    } catch (_) { return []; }
  }
  function readServerImageBootstrap() {
    var node = $('dx-image-bootstrap');
    if (!node) return [];
    var raw = node.content ? node.content.textContent : node.textContent;
    try { node.remove(); } catch (_) {}
    return decodeImageBootstrap(raw);
  }
  async function bootstrapImageLibrary(serverSnapshot) {
    // Image restoration is intentionally independent from transfer-queue recovery.
    // The authenticated navigation document supplies a server snapshot before any
    // asynchronous API/IndexedDB work, making a plain refresh recover the gallery
    // even in WebView/proxy environments where one of those layers is unavailable.
    var confirmedAt = Date.now();
    var embedded = (Array.isArray(serverSnapshot) ? serverSnapshot : []).map(function (photo) {
      var record = imageDataUrls(photo);
      record.lastServerConfirmedAt = confirmedAt;
      return record;
    });
    // Fast first paint from synchronous sources only (server-embedded snapshot +
    // localStorage recovery journal). This avoids blocking on indexedDB.open(),
    // which can take several seconds to resolve or time out on some Android
    // WebView contexts — the cause of the gallery appearing only after a delay.
    var fast = mergeCachedImageRecords(embedded, readImageBackup());
    if (fast.length) restoreCachedImageRows(fast);
    // Reconcile with IndexedDB in the background and repaint any additions.
    var cached = await loadCachedImages().catch(function () { return readImageBackup(); });
    var merged = mergeCachedImageRecords(cached, embedded);
    restoreCachedImageRows(merged);
    await replaceCachedImages(merged);
    await refreshImageStats(true);
    return merged;
  }
  function restoreCachedImageRows(records) {
    var photos = (Array.isArray(records) ? records : []).filter(function (photo) { return photo && photo.token; }).map(imageDataUrls);
    photos.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    photos.forEach(function (photo) {
      // Isolate each card: a single malformed record must never abort the whole
      // gallery restore (which would leave the Images tab empty).
      try {
        imageRecordsByToken.set(photo.token, photo);
        if (!imageLinkUrls.some(function (item) { return item.token === photo.token; })) {
          imageLinkUrls.push({ token: photo.token, imgUrl: photo.imgUrl, thumbUrl: photo.thumbUrl, microUrl: photo.microUrl, name: photo.name });
        }
        if (!imageRowsByToken.has(photo.token)) {
          var row = imgLinkRow(photo.name || 'image', imageCardPreviewUrl(photo), false);
          activateImageLinkRow(row, photo, photo.name || 'image', false, false);
        }
      } catch (e) { try { console.error('[dx] image card restore failed for ' + (photo && photo.token), e); } catch (_) {} }
    });
    refreshCopyAll(); applyImageView(); updateExpiryCountdowns();
  }
  function removeImageRow(row, token, imgUrl) {
    if (row && row.parentNode) row.parentNode.removeChild(row);
    if (token) { imageRowsByToken.delete(token); imageRecordsByToken.delete(token); selectedImageTokens.delete(token); deleteCachedImageRecord(token); }
    imageLinkUrls = imageLinkUrls.filter(function (o) { return o.token !== token && o.imgUrl !== imgUrl; });
    refreshCopyAll(); updateImageBulkBar();
  }
  async function editOneImage(photo) {
    if (!photo) return;
    var name = window.prompt('Nom', photo.name || ''); if (name === null) return;
    var tags = window.prompt(t('imgTags') + ' (séparés par des virgules)', (photo.tags || []).join(', ')); if (tags === null) return;
    var note = window.prompt(t('imgPrivateNote'), photo.note || ''); if (note === null) return;
    var maxViews = window.prompt(t('imgMaxViews') + ' (0 = illimité)', String(photo.maxViews || 0)); if (maxViews === null) return;
    var expiry = window.prompt(t('imgDefaultExpiry') + ' en secondes à partir de maintenant (0 = jamais)', photo.expiresAt ? String(Math.max(1, Math.round((photo.expiresAt - Date.now()) / 1000))) : '0'); if (expiry === null) return;
    var password = window.prompt(t('imgPassword') + ' (vide = retirer; annuler = conserver)', '');
    var hotlinkHosts = window.prompt(t('imgHotlinkHosts') + ' (vide = désactiver)', (photo.hotlinkHosts || []).join(', ')); if (hotlinkHosts === null) return;
    var notifyFirstView = window.confirm(t('imgNotifyFirstView'));
    var payload = { name: name, tags: tags.split(',').map(function (x) { return x.trim(); }).filter(Boolean), note: note, maxViews: Number(maxViews) || 0, expiresInSeconds: Number(expiry) || 0, hotlinkHosts: hotlinkHosts, notifyFirstView: notifyFirstView };
    if (password !== null) payload.password = password;
    var r = await imageJsonMutation('/app/image/' + encodeURIComponent(photo.token) + '/settings', payload);
    if (!r.ok) { toast(t('revokeFail'), 'err'); return; }
    var updated = (await r.json()).image; if (updated) { imageRecordsByToken.set(updated.token, imageDataUrls(updated)); persistImageRecord(imageRecordsByToken.get(updated.token)); renderImageVariantStats(imageRowsByToken.get(updated.token), imageRecordsByToken.get(updated.token)); }
    recordImageAction('edited', updated || photo); toast(t('imgSettingsSaved'), 'ok'); applyImageView();
  }
  async function uploadGeneratedImageVariants(token, variants) {
    if (!variants) return;
    var jobs = [
      fetch('/app/image/' + encodeURIComponent(token) + '/thumb', { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/jpeg'), body: variants.thumb }),
      fetch('/app/image/' + encodeURIComponent(token) + '/micro', { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/jpeg'), body: variants.micro })
    ];
    if (variants.adaptiveWebp) jobs.push(fetch('/app/image/' + encodeURIComponent(token) + '/adaptive/webp', { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/webp'), body: variants.adaptiveWebp }));
    if (variants.adaptiveAvif) jobs.push(fetch('/app/image/' + encodeURIComponent(token) + '/adaptive/avif', { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/avif'), body: variants.adaptiveAvif }));
    await Promise.allSettled(jobs);
  }
  async function replaceImageKeepingUrl(photo) {
    if (!photo || !askConfirmation('replace', t('imgReplace') + ' ?')) return;
    var input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    input.onchange = async function () {
      var file = input.files && input.files[0]; if (!file) return;
      try {
        var prepared = await prepareImageForLink(file, !!($('imglink-strip-exif') && $('imglink-strip-exif').checked));
        var variants = null; try { variants = await makeImageVariants(prepared.blob); } catch (_) {}
        var replaceUrl = '/app/image/' + encodeURIComponent(photo.token) + '/replace?name=' + encodeURIComponent(prepared.name);
        if (prepared.metadataStripped) replaceUrl += '&metadataRemoved=1';
        var r = await appMutate(replaceUrl, prepared.type, prepared.blob);
        if (!r.ok) throw new Error('http ' + r.status);
        await uploadGeneratedImageVariants(photo.token, variants);
        var fresh = await fetch('/app/image/' + encodeURIComponent(photo.token) + '/stats', { credentials: 'same-origin', cache: 'no-store' });
        var updated = fresh.ok ? await fresh.json() : (await r.json()).image;
        if (updated) { updated = imageDataUrls(updated); imageRecordsByToken.set(updated.token, updated); var row = imageRowsByToken.get(updated.token); if (row) { row.querySelector('.imglink-thumb').src = imageCardPreviewUrl(updated) + (imageCardPreviewUrl(updated).indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now(); row.querySelector('.imglink-name').textContent = updated.name; renderImageVariantStats(row, updated); } }
        recordImageAction('edited', updated || photo, 'replace'); toast(t('imgReplaceDone'), 'ok');
      } catch (_) { toast(t('imgLinkFail'), 'err'); }
    };
    input.click();
  }
  // Regenerate the Mini (and, to keep the "Micro = half the Mini" invariant, the
  // Micro) at a new size from the FULL image, without touching the public token.
  // The full is fetched through the authenticated owner preview so it never counts
  // a public view; resizing happens entirely on-device (no server image library).
  async function resizeImageMini(photo) {
    photo = imageRecordsByToken.get(photo.token) || photo;
    if (!photo || photo.active === false) { toast(t('imgInactive'), 'warn'); return; }
    var v = photo.variants || {}, thumb = v.thumb || {};
    var currentLong = Math.max(Number(thumb.w) || 0, Number(thumb.h) || 0) || 480;
    var input = window.prompt(t('imgResizeMiniPrompt'), String(currentLong));
    if (input === null) return;
    // Accept either a max longest-side in pixels (e.g. "250") or a percentage of the
    // full size (e.g. "50%"). A trailing % switches to percentage mode.
    var raw = String(input).trim();
    var isPercent = /%\s*$/.test(raw);
    var num = Number(raw.replace(/%/g, '').trim());
    if (!isFinite(num) || num <= 0 || (isPercent ? num > 100 : (num < 16 || num > 4096))) { toast(t('imgResizeMiniInvalid'), 'err'); return; }
    try {
      var r = await fetch('/app/image/' + encodeURIComponent(photo.token) + '/preview/full', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      var full = await loadImage(await r.blob());
      var w = full.width, h = full.height;
      var tw, th;
      if (isPercent) { tw = Math.max(1, Math.round(w * num / 100)); th = Math.max(1, Math.round(h * num / 100)); }
      else { var scale = Math.min(1, num / Math.max(w, h)); tw = Math.max(1, Math.round(w * scale)); th = Math.max(1, Math.round(h * scale)); }
      var mw = Math.max(1, Math.round(tw / 2)), mh = Math.max(1, Math.round(th / 2));
      function make(cw, ch) {
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d', { alpha: false }).drawImage(full, 0, 0, cw, ch);
        return canvasBlob(c, 'image/jpeg', 0.99);
      }
      var thumbBlob = await make(tw, th), microBlob = await make(mw, mh);
      if (full.close) full.close();
      var results = await Promise.all([
        fetch('/app/image/' + encodeURIComponent(photo.token) + '/thumb', { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/jpeg'), body: thumbBlob }),
        fetch('/app/image/' + encodeURIComponent(photo.token) + '/micro', { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/jpeg'), body: microBlob })
      ]);
      if (!results.every(function (x) { return x.ok; })) throw new Error('upload');
      var fresh = await fetch('/app/image/' + encodeURIComponent(photo.token) + '/stats', { credentials: 'same-origin', cache: 'no-store' });
      if (fresh.ok) {
        var updated = imageDataUrls(await fresh.json());
        imageRecordsByToken.set(updated.token, updated); persistImageRecord(updated);
        var row = imageRowsByToken.get(updated.token);
        if (row) { var pv = imageCardPreviewUrl(updated); row.querySelector('.imglink-thumb').src = pv + (pv.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now(); renderImageVariantStats(row, updated); }
      }
      recordImageAction('edited', photo, 'resize-mini');
      toast(t('imgResizeMiniDone', { w: tw, h: th }), 'ok');
    } catch (_) { toast(t('imgLinkFail'), 'err'); }
  }
  async function manageImageVersions(photo) {
    if (!photo) return;
    var r = await fetch('/app/image/' + encodeURIComponent(photo.token) + '/versions', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) { toast(t('revokeFail'), 'err'); return; }
    var versions = (await r.json()).versions || [];
    if (!versions.length) { toast(t('imgVersions') + ': 0', 'warn'); return; }
    var lines = versions.map(function (v, i) { return (i + 1) + '. ' + new Date(v.at).toLocaleString() + ' · ' + v.name + ' · ' + fmtBytes(v.size); });
    var choice = window.prompt(t('imgRestoreVersion') + '\n' + lines.join('\n'), '1');
    if (choice === null) return;
    var idx = Math.max(0, Math.min(versions.length - 1, (parseInt(choice, 10) || 1) - 1));
    var rr = await imageJsonMutation('/app/image/' + encodeURIComponent(photo.token) + '/restore/' + encodeURIComponent(versions[idx].id), {});
    if (!rr.ok) { toast(t('revokeFail'), 'err'); return; }
    var updated = imageDataUrls((await rr.json()).image);
    imageRecordsByToken.set(updated.token, updated);
    var row = imageRowsByToken.get(updated.token);
    if (row) { row.querySelector('.imglink-thumb').src = imageCardPreviewUrl(updated) + (imageCardPreviewUrl(updated).indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now(); renderImageVariantStats(row, updated); }
    toast(t('imgVersionRestored'), 'ok');
  }

  function activateImageLinkRow(row, data, linkName, metadataStripped, trackForCopyAll) {
    data = imageDataUrls(data);
    if (metadataStripped) data.metadataRemoved = true;
    row.dataset.token = data.token;
    row.dataset.imgUrl = data.imgUrl || '';
    imageRowsByToken.set(data.token, row);
    imageRecordsByToken.set(data.token, data);
    row.querySelector('.imglink-name').textContent = linkName || data.name || 'image';
    renderImageVariantStats(row, data);

    var select = row.querySelector('.img-select');
    select.classList.remove('hidden');
    select.checked = selectedImageTokens.has(data.token);
    select.addEventListener('change', function () { selectImageToken(data.token, select.checked); });

    var rev = row.querySelector('.il-revoke');
    rev.title = t('revokeShare'); rev.setAttribute('aria-label', t('revokeShare'));
    rev.classList.remove('hidden');
    rev.addEventListener('click', function () { if (askConfirmation('revoke', t('revokeConfirm'))) scheduleImageRevoke(row, imageRecordsByToken.get(data.token) || data); });

    var ba = row.querySelector('.il-auto'), bf = row.querySelector('.il-full'), bt = row.querySelector('.il-thumb'), bm = row.querySelector('.il-micro'), bo = row.querySelector('.il-open'), fav = row.querySelector('.il-favorite'), edit = row.querySelector('.il-edit'), bq = row.querySelector('.il-qr'), qrdl = row.querySelector('.il-qrdl'), replaceBtn = row.querySelector('.il-replace'), versionsBtn = row.querySelector('.il-versions'), resizeMiniBtn = row.querySelector('.il-resize-mini'), more = row.querySelector('.il-more');
    ba.textContent = t('imgVariantAuto'); bf.textContent = t('imgCopyFull'); bt.textContent = t('imgCopyThumb'); bm.textContent = t('imgCopyMicro');
    var copyLabel = row.querySelector('.imglink-copy-label'), manageLabel = row.querySelector('.imglink-manage-label');
    if (copyLabel) copyLabel.textContent = t('imgCopyActions');
    if (manageLabel) manageLabel.textContent = t('imgManageActions');
    bo.innerHTML = ICONS.eye; bo.title = t('imgOpen') + ' — ' + t('imgVariantAuto'); bo.setAttribute('aria-label', bo.title);
    bq.title = t('qrForLink'); bq.setAttribute('aria-label', t('qrForLink'));
    qrdl.title = t('imgQrDownloaded'); qrdl.setAttribute('aria-label', t('imgQrDownloaded'));
    replaceBtn.title = t('imgReplace'); replaceBtn.setAttribute('aria-label', t('imgReplace'));
    versionsBtn.title = t('imgVersions'); versionsBtn.setAttribute('aria-label', t('imgVersions'));
    resizeMiniBtn.title = t('imgResizeMini'); resizeMiniBtn.setAttribute('aria-label', t('imgResizeMini'));
    function copyOne(kind) { return function () { var photo = imageRecordsByToken.get(data.token) || data; var url = imageVariantUrl(photo, kind); copyText(formatLink(url, photo.name, photo, kind)).then(function () { recordImageAction('copied', photo, kind); toast(t('imgCopied'), 'ok'); }); }; }
    ba.addEventListener('click', copyOne('auto'));
    bf.addEventListener('click', copyOne('full'));
    bt.addEventListener('click', copyOne('thumb'));
    bm.addEventListener('click', copyOne('micro'));
    row.querySelectorAll('.imgvariant').forEach(function (line) {
      var kind = line.dataset.kind;
      var openVariant = line.querySelector('.iv-open');
      if (!openVariant) return;
      openVariant.addEventListener('click', function () {
        var photo = imageRecordsByToken.get(data.token) || data;
        var url = imagePreviewUrl(photo, kind);
        if (!url || photo.active === false) return;
        recordImageAction('opened', photo, kind);
        openImageUrlPreview(url, photo.name);
      });
    });
    bo.addEventListener('click', function () { var photo = imageRecordsByToken.get(data.token) || data; var url = imagePreviewUrl(photo, 'auto'); if (!url) return; recordImageAction('opened', photo, 'auto'); openImageUrlPreview(url, photo.name); });
    fav.addEventListener('click', async function () {
      var photo = imageRecordsByToken.get(data.token) || data; var enabled = !photo.favorite;
      var r = await imageJsonMutation('/app/image/' + encodeURIComponent(photo.token) + '/settings', { favorite: enabled });
      if (r.ok) { var updated = (await r.json()).image; imageRecordsByToken.set(photo.token, imageDataUrls(updated)); persistImageRecord(imageRecordsByToken.get(photo.token)); fav.classList.toggle('active', enabled); row.classList.toggle('pinned', enabled); fav.title = enabled ? t('unpinItem') : t('pinItem'); fav.setAttribute('aria-label', fav.title); recordImageAction('edited', updated, enabled ? 'favorite' : 'unfavorite'); applyImageView(); }
    });
    edit.addEventListener('click', function () { editOneImage(imageRecordsByToken.get(data.token) || data); });
    bq.addEventListener('click', function () { var photo = imageRecordsByToken.get(data.token) || data; showQrOverlay(imageVariantUrl(photo, imageDefaultVariant()), photo.name); });
    qrdl.addEventListener('click', function () { downloadImageQr(imageRecordsByToken.get(data.token) || data); });
    replaceBtn.addEventListener('click', function () { replaceImageKeepingUrl(imageRecordsByToken.get(data.token) || data); });
    versionsBtn.addEventListener('click', function () { manageImageVersions(imageRecordsByToken.get(data.token) || data); });
    resizeMiniBtn.addEventListener('click', function () { resizeImageMini(imageRecordsByToken.get(data.token) || data); });
    row.querySelector('.imglink-actions').classList.remove('hidden');
    var st = row.querySelector('.imglink-st');
    var stateText = data.expired ? t('imgExpired') : !data.active ? ((data.maxViews && imageRecordViews(data) >= data.maxViews) ? t('imgViewLimitReached') : t('imgInactive')) : t('imgReady');
    st.textContent = stateText + (data.metadataRemoved ? ' · ' + t('imgMetadataRemoved') : '');
    st.className = 'imglink-st ' + (data.active ? 'ok' : 'muted') + ' sm';
    fav.classList.toggle('active', !!data.favorite); row.classList.toggle('pinned', !!data.favorite); fav.title = data.favorite ? t('unpinItem') : t('pinItem'); fav.setAttribute('aria-label', fav.title);
    var defaultKind = imageDefaultVariant();
    [['auto', ba], ['full', bf], ['thumb', bt], ['micro', bm]].forEach(function (pair) { pair[1].classList.toggle('il-primary', pair[0] === defaultKind); });
    if (more) more.addEventListener('click', function () { row.classList.toggle('show-all-actions'); more.setAttribute('aria-expanded', row.classList.contains('show-all-actions') ? 'true' : 'false'); });
    arrangeImageActions(row); updateExpiryCountdowns(); renderTagColorManager();
    if (trackForCopyAll !== false && !imageLinkUrls.some(function (o) { return o.token === data.token; })) imageLinkUrls.push({ token: data.token, imgUrl: data.imgUrl, thumbUrl: data.thumbUrl, microUrl: data.microUrl, name: data.name });
    persistImageRecord(data);
    refreshCopyAll(); applyImageView();
  }
  async function refreshImageStats(loadMissing) {
    var generation = ++imageRefreshGeneration;
    if (imageStatsAbortController && typeof imageStatsAbortController.abort === 'function') {
      try { imageStatsAbortController.abort(); } catch (_) {}
    }
    imageStatsAbortController = window.AbortController ? new AbortController() : null;
    try {
      var requestOptions = { credentials: 'same-origin', cache: 'no-store' };
      if (imageStatsAbortController) requestOptions.signal = imageStatsAbortController.signal;
      var r = await fetch('/app/images?limit=500&includeInactive=1', requestOptions);
      if (!r.ok) throw new Error('http ' + r.status);
      var payload = await r.json();
      if (generation !== imageRefreshGeneration) return;
      var now = Date.now();
      var photos = payload && Array.isArray(payload.images) ? payload.images.map(function (entry) {
        var existing = entry && entry.token ? imageRecordsByToken.get(entry.token) : null;
        entry = imageDataUrls(entry);
        entry.localCommittedAt = existing && existing.localCommittedAt || 0;
        entry.lastServerConfirmedAt = now;
        return entry;
      }) : [];
      var known = new Set(photos.map(function (photo) { return photo.token; }));

      // A list response may have started before the upload was committed. Never
      // interpret one missing token as a deletion: verify it through the dedicated
      // authenticated stats route first. This also repairs incomplete list results
      // after a service-worker update or ownership-cookie rehydration.
      var missing = Array.from(imageRecordsByToken.values()).filter(function (photo) {
        return photo && photo.token && !known.has(photo.token) && !pendingImageRevokes.has(photo.token);
      });
      if (missing.length) {
        var recovered = await Promise.all(missing.map(async function (cached) {
          try {
            var fresh = await fetch('/app/image/' + encodeURIComponent(cached.token) + '/stats', {
              credentials: 'same-origin', cache: 'no-store',
              signal: imageStatsAbortController ? imageStatsAbortController.signal : undefined,
            });
            if (fresh.status === 404 || fresh.status === 410) return { missingToken: cached.token, cached: cached };
            if (!fresh.ok) return { keepToken: cached.token };
            var record = imageDataUrls(await fresh.json());
            record.localCommittedAt = cached.localCommittedAt || 0;
            record.lastServerConfirmedAt = Date.now();
            return { record: record };
          } catch (_) { return { keepToken: cached.token }; }
        }));
        if (generation !== imageRefreshGeneration) return;
        recovered.forEach(function (result) {
          if (result && result.record) {
            imageMissingConfirmations.delete(result.record.token);
            if (!known.has(result.record.token)) { known.add(result.record.token); photos.push(result.record); }
          } else if (result && result.missingToken) {
            imageMissingConfirmations.set(result.missingToken, (imageMissingConfirmations.get(result.missingToken) || 0) + 1);
          }
        });
      }

      photos.slice().reverse().forEach(function (photo) {
        // Per-card isolation: one bad server record must not abort the render of the rest.
        try {
        known.add(photo.token); imageMissingConfirmations.delete(photo.token); imageRecordsByToken.set(photo.token, photo);
        var existingLink = imageLinkUrls.find(function (o) { return o.token === photo.token; });
        if (existingLink) Object.assign(existingLink, photo); else imageLinkUrls.push({ token: photo.token, imgUrl: photo.imgUrl, thumbUrl: photo.thumbUrl, microUrl: photo.microUrl, name: photo.name });
        var row = imageRowsByToken.get(photo.token);
        if (!row && loadMissing) {
          row = imgLinkRow(photo.name || 'image', imageCardPreviewUrl(photo), false);
          activateImageLinkRow(row, photo, photo.name || 'image', false, false);
        } else if (row) {
          row.querySelector('.imglink-name').textContent = photo.name || 'image';
          renderImageVariantStats(row, photo);
          var fav = row.querySelector('.il-favorite'); if (fav) { fav.classList.toggle('active', !!photo.favorite); fav.title = photo.favorite ? t('unpinItem') : t('pinItem'); fav.setAttribute('aria-label', fav.title); } row.classList.toggle('pinned', !!photo.favorite);
          var st = row.querySelector('.imglink-st'); if (st) { var statusText = photo.expired ? t('imgExpired') : !photo.active ? ((photo.maxViews && imageRecordViews(photo) >= photo.maxViews) ? t('imgViewLimitReached') : t('imgInactive')) : t('imgReady'); st.textContent = statusText + (photo.metadataRemoved ? ' · ' + t('imgMetadataRemoved') : ''); st.className = 'imglink-st ' + (photo.active ? 'ok' : 'muted') + ' sm'; }
        }
        } catch (e) { try { console.error('[dx] image card render failed for ' + (photo && photo.token), e); } catch (_) {} }
      });

      // A cached record is removed only after repeated direct 404/410
      // confirmations and a grace period. This prevents one stale list response
      // from deleting a freshly uploaded image while still allowing links revoked
      // from another session to disappear eventually.
      imageRowsByToken.forEach(function (row, token) {
        if (known.has(token) || pendingImageRevokes.has(token)) return;
        var cached = imageRecordsByToken.get(token);
        var age = Date.now() - Math.max(0, Number(cached && (cached.localCommittedAt || cached.createdAt)) || 0);
        if ((imageMissingConfirmations.get(token) || 0) < 3 || age < 120000) return;
        removeImageRow(row, token, row && row.dataset ? row.dataset.imgUrl || '' : '');
        imageMissingConfirmations.delete(token);
      });
      await replaceCachedImages(Array.from(imageRecordsByToken.values()));
      warnExpiringImages(photos); refreshCopyAll(); applyImageView(); renderTagColorManager(); updateExpiryCountdowns();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      if (loadMissing && !$('imglink-list').children.length) {
        // Authentication/network failures are already surfaced elsewhere in the PWA.
      }
    } finally {
      if (generation === imageRefreshGeneration) imageStatsAbortController = null;
    }
  }
  function startImageStatsPolling() {
    if (imageStatsTimer) clearInterval(imageStatsTimer);
    imageStatsTimer = setInterval(function () { if (!document.hidden) refreshImageStats(true); }, 3000);
  }
  // Server accepts only these image extensions for a direct link. Anything else
  // (notably iPhone HEIC/HEIF, or files that arrive without an extension) must be
  // transcoded to JPEG on-device first, otherwise the upload is rejected outright.
  var LINK_OK_EXT = /^(jpg|jpeg|png|gif|webp|bmp|avif)$/;
  async function prepareImageForLink(file, stripMetadata) {
    var name = file.name || '';
    var hasExt = /\.[^.\/]+$/.test(name);
    var ext = hasExt ? (name.split('.').pop() || '').toLowerCase() : '';
    var isHeic = /heic|heif/i.test(file.type || '') || /^(heic|heif)$/.test(ext);
    if (hasExt && LINK_OK_EXT.test(ext) && !isHeic && !stripMetadata) {
      return { blob: file, name: name, type: file.type || 'application/octet-stream', metadataStripped: false };
    }
    // A canvas round-trip creates fresh image bytes without EXIF, GPS, comments or
    // other source metadata. It also normalizes phone-camera orientation. This is
    // performed entirely on-device before any bytes are uploaded.
    var image;
    try { image = await loadImage(file); }
    catch (_) { var err = new Error('decode-failed'); err.dxReason = 'format non pris en charge (HEIC ?)'; throw err; }
    var w = image.width, h = image.height;
    // Preserve native dimensions for metadata-only cleaning. HEIC/HEIF and other
    // unsupported formats keep the previous 4096 px conversion cap for reliability.
    var max = isHeic || !LINK_OK_EXT.test(ext) ? 4096 : 8192;
    var scale = Math.min(1, max / Math.max(w, h));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var wantsAlpha = stripMetadata && /^(png|webp)$/.test(ext);
    var ctx = canvas.getContext('2d', { alpha: wantsAlpha });
    if (!wantsAlpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (image.close) image.close();
    var requestedType = wantsAlpha ? (ext === 'webp' ? 'image/webp' : 'image/png') : 'image/jpeg';
    var blob = await canvasBlob(canvas, requestedType, requestedType === 'image/jpeg' ? 0.94 : requestedType === 'image/webp' ? 0.94 : undefined);
    var actualType = blob.type || requestedType;
    var outExt = actualType === 'image/png' ? '.png' : actualType === 'image/webp' ? '.webp' : '.jpg';
    var base = name.replace(/\.[^.\/]+$/, '') || ('image-' + Date.now());
    return { blob: blob, name: base + outExt, type: actualType, metadataStripped: true };
  }
  async function createOneImageLink(file, stripMetadata, desiredName, options) {
    options = options || imageOptionsFromUi();
    var name = desiredName || file.name || ('image-' + Date.now() + '.jpg');
    var preview = ''; try { preview = URL.createObjectURL(file); } catch (_) {}
    var row = imgLinkRow(name, preview, true);
    var st = row.querySelector('.imglink-st');
    st.textContent = stripMetadata ? t('imgStrippingMetadata') : t('imgUploading');
    try {
      var clientHash = '';
      try { clientHash = await sha256Blob(file); } catch (_) {}
      var duplicate = await imageDuplicate(clientHash);
      if (duplicate && !askConfirmation('replace', t('imgDuplicateFound'))) { if (row.parentNode) row.parentNode.removeChild(row); return null; }
      var workingFile = file;
      var smartBlurRemovedMetadata = false;
      if (options.smartBlurMode && options.smartBlurMode !== 'off') {
        st.textContent = t('imgSmartBlurAnalyzing');
        var reviewedFile = await openSmartBlurReview(file, options.smartBlurMode);
        if (reviewedFile) { workingFile = reviewedFile; smartBlurRemovedMetadata = true; }
      }
      var prepared = await prepareImageForLink(workingFile, stripMetadata);
      var metadataRemoved = !!(prepared.metadataStripped || smartBlurRemovedMetadata);
      if (desiredName) {
        var preparedDot = prepared.name.lastIndexOf('.');
        var preparedExt = preparedDot > 0 ? prepared.name.slice(preparedDot) : '';
        var desiredBase = desiredName.replace(/\.[^.\/]+$/, '');
        prepared.name = desiredBase + preparedExt;
      }
      if (prepared.name !== name) row.querySelector('.imglink-name').textContent = prepared.name;
      var variants = null;
      try { variants = await makeImageVariants(prepared.blob); } catch (_) {}
      var uploadUrl = '/app/image?name=' + encodeURIComponent(prepared.name);
      if (variants) uploadUrl += '&w=' + variants.width + '&h=' + variants.height;
      if (clientHash) uploadUrl += '&clientHash=' + encodeURIComponent(clientHash);
      if (metadataRemoved) uploadUrl += '&metadataRemoved=1';
      var r = await appMutate(uploadUrl, prepared.type, prepared.blob);
      if (!r.ok) throw new Error('http ' + r.status);
      var data = await r.json();
      if (!data || !data.token) throw new Error('no-token');
      st.textContent = t('imgThumbing');
      try {
        if (!variants) throw new Error('variants-unavailable');
        await uploadGeneratedImageVariants(data.token, variants);
      } catch (_) {}
      var settingsPayload = Object.assign({}, options); delete settingsPayload.smartBlurMode;
      var settingsResponse = await imageJsonMutation('/app/image/' + encodeURIComponent(data.token) + '/settings', settingsPayload);
      if (settingsResponse.ok) {
        var settingsData = await settingsResponse.json(); if (settingsData.image) data = settingsData.image;
      }
      data.name = prepared.name || name;
      if (!data.variants || !data.variants.full) {
        data.variants = {
          full: { w: variants ? variants.width : null, h: variants ? variants.height : null, bytes: prepared.blob.size || null, views: 0, visitors: 0, ready: true },
          thumb: { w: variants ? variants.thumbWidth : null, h: variants ? variants.thumbHeight : null, bytes: variants && variants.thumb ? variants.thumb.size : null, views: 0, visitors: 0, ready: !!variants },
          micro: { w: variants ? variants.microWidth : null, h: variants ? variants.microHeight : null, bytes: variants && variants.micro ? variants.micro.size : null, views: 0, visitors: 0, ready: !!variants }
        };
        data.totals = { views: 0, visitors: 0, bytes: (prepared.blob.size || 0) + (variants && variants.thumb ? variants.thumb.size : 0) + (variants && variants.micro ? variants.micro.size : 0) };
      }
      data.localCommittedAt = Date.now();
      data.lastServerConfirmedAt = data.localCommittedAt;
      activateImageLinkRow(row, data, data.name, metadataRemoved);
      await persistImageRecord(imageRecordsByToken.get(data.token) || data);
      recordImageAction('created', imageDataUrls(data));
      if ($('img-auto-copy') && $('img-auto-copy').checked) {
        var photo = imageRecordsByToken.get(data.token) || imageDataUrls(data);
        await copyText(formatLink(imageVariantUrl(photo, imageDefaultVariant()), photo.name, photo, imageDefaultVariant()));
        toast(t('imgCopied'), 'ok'); recordImageAction('copied', photo, imageDefaultVariant());
      }
      refreshImageStats(false); refreshImageDashboard();
      return data;
    } catch (e) {
      var why = e && e.dxReason ? e.dxReason
        : e && /^http /i.test(e.message || '') ? e.message.replace(/^http /i, 'HTTP ')
        : e && e.message === 'no-token' ? 'réponse serveur invalide'
        : 'réseau/serveur';
      st.textContent = t('imgLinkFail') + ' — ' + why; st.className = 'imglink-st err sm';
      return null;
    }
  }
  // Render a link in the chosen copy format (raw URL, Markdown, or HTML img tag).
  function escapeMarkup(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function formatLink(url, name, photo, kind) {
    var fmt = $('img-format') ? $('img-format').value : 'url';
    var template = $('img-copy-template') ? $('img-copy-template').value : 'standard';
    var alt = (name || 'image').replace(/\.[^.]+$/, '');
    var full = photo && photo.imgUrl ? photo.imgUrl : url;
    if (template === 'discord') return url;
    if (template === 'reddit') return '[' + alt.replace(/\]/g, '\]') + '](' + url + ')';
    if (template === 'forum') return '[url=' + full + '][img]' + url + '[/img][/url]';
    if (template === 'email') return '<a href="' + full + '"><img src="' + url + '" alt="' + escapeMarkup(alt) + '"></a>';
    if (fmt === 'md') return '![' + alt + '](' + url + ')';
    if (fmt === 'html') return '<img src="' + url + '" alt="' + escapeMarkup(alt) + '">';
    if (fmt === 'bb') return '[img]' + url + '[/img]';
    return url;
  }
  function refreshCopyAll() {
    var show = imageLinkUrls.length >= 2;
    var btn = $('imglink-copyall-btn'); if (btn) btn.classList.toggle('hidden', !show);
    if ($('imglink-qrall-btn')) $('imglink-qrall-btn').classList.toggle('hidden', !show);
    if ($('imglink-qrzip-btn')) $('imglink-qrzip-btn').classList.toggle('hidden', imageLinkUrls.length < 1);
    if ($('img-format')) $('img-format').classList.toggle('hidden', imageLinkUrls.length < 1);
    if ($('img-copy-template')) $('img-copy-template').classList.toggle('hidden', imageLinkUrls.length < 1);
  }
  function copyAllImageLinks() {
    var links = imageLinkUrls.filter(function (o) { var p = imageRecordsByToken.get(o.token); return !p || p.active; });
    if (!links.length) { toast(t('noImgLinks'), 'warn'); return; }
    var kind = imageDefaultVariant();
    var text = links.map(function (o) { var photo = imageRecordsByToken.get(o.token) || o; return formatLink(imageVariantUrl(photo, kind), photo.name || o.name, photo, kind); }).join('\n');
    copyText(text).then(
      function () { links.forEach(function (o) { recordImageAction('copied', imageRecordsByToken.get(o.token) || o, kind); }); toast(t('allImgCopied', { n: links.length }), 'ok'); },
      function () { toast(t('copyFailed'), 'err'); }
    );
  }
  async function createImageLinks(fileList) {
    // Accept by MIME type OR by image extension: some Android pickers hand back
    // files with an empty type, which must not be silently dropped.
    var IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return f && (/^image\//.test(f.type || '') || IMG_EXT.test(f.name || ''));
    });
    // Snapshot the choice for the whole batch so changing the checkbox while
    // several images are processing cannot produce a mixed-privacy batch.
    var stripMetadata = !!($('imglink-strip-exif') && $('imglink-strip-exif').checked);
    var options = imageOptionsFromUi();
    persistImagePreferences();
    for (var i = 0; i < files.length; i++) { await createOneImageLink(files[i], stripMetadata, imageRename(files[i].name || ('image-' + (i + 1) + '.jpg'), i), options); }
  }

  function encryptionContext(snapshot) {
    var enc = snapshot.enc;
    if (!enc) return Promise.resolve(null);
    if (!window.DXCrypto || !window.DXCrypto.available) return Promise.reject(new Error('nocrypto'));
    if (enc.mode === 'pass') {
      if (!snapshot.passphrase) return Promise.reject(new Error('nopass'));
      var salt = window.DXCrypto.randomSalt();
      return window.DXCrypto.deriveKey(snapshot.passphrase, salt).then(function (key) { return { mode: 'pass', key: key, salt: salt }; });
    }
    if (!snapshot.key) return Promise.reject(new Error('nokey'));
    return window.DXCrypto.importRawKey(window.DXCrypto.b64urlDecode(snapshot.key)).then(function (key) { return { mode: 'key', key: key, salt: null }; });
  }
  async function prepareUpload(it) {
    if (it.preparedBlob && it.upName && it.upSize != null) return;
    var source = await optimizeImage(it);
    if (!it.snapshot.enc) {
      it.preparedBlob = source;
      it.upName = it.name;
      it.upSize = source.size;
      it.preparedEncrypted = false;
      it.state = 'waiting';
      await ensurePreparedDurable(it);
      return;
    }
    it.state = 'encrypting'; updateItemUi(it, t('encrypting'));
    var ctx = await encryptionContext(it.snapshot);
    var sourceNamed = namedFile(source, it.name, source.type || it.type, it.lastModified);
    var encrypted = await window.DXCrypto.encryptFile(sourceNamed, ctx.mode, {
      key: ctx.key,
      salt: ctx.salt,
      onProgress: function (fraction) {
        it.prepareProgress = Math.max(0, Math.min(1, fraction || 0));
        updateItemUi(it, t('encrypting') + ' ' + Math.round(it.prepareProgress * 100) + '%');
        if (it.progress) { it.progress.max = 100; it.progress.value = Math.round(it.prepareProgress * 100); }
      }
    });
    it.preparedBlob = encrypted;
    it.upName = genId(24) + '.dxe';
    it.upSize = encrypted.size;
    it.preparedEncrypted = true;
    it.sentBytes = 0;
    it.state = 'waiting';
    it.prepareProgress = 1;
    await ensurePreparedDurable(it);
  }

  // Upload protocol ----------------------------------------------------------
  var FATAL = ['ext-blocked', 'ext-not-allowed', 'file-too-large', 'too-large', 'quota-full', 'max-files', 'revoked', 'locked', 'stopped', 'infected'];
  function reasonText(code) {
    if (code === 'ext-blocked' || code === 'ext-not-allowed') return t('typeBlocked');
    if (code === 'file-too-large' || code === 'too-large') return t('fileTooLarge');
    if (code === 'quota-full') return t('quotaFull');
    if (code === 'max-files') return t('maxFiles');
    if (code === 'revoked' || code === 'locked' || code === 'stopped') return t('unavailable');
    if (code === 'infected') return t('infected');
    if (code === 'upload-stalled') return t('uploadStalled');
    return code ? t('error') : t('networkError');
  }
  // A short server error code appended to a diagnostic, when the body carried one
  // (e.g. write-error, inbox-dir, offset-mismatch, busy) — it pinpoints which side
  // failed without needing dev tools on a phone.
  function serverCodeText(code) {
    if (!code) return '';
    if (code === 'write-error' || code === 'inbox-dir') return t('diagServerWrite');
    if (code === 'offset-mismatch' || code === 'busy') return t('diagServerSync');
    if (code === 'too-many-uploads') return t('diagServerBusy');
    if (code === 'aborted' || code === 'timeout') return t('diagServerDropped');
    return code; // unknown code: show it verbatim, still useful
  }
  // Turns a failed putChunk result into a short badge (shown live in the status
  // line while retrying) and a precise, localized hint (shown when the transfer
  // finally gives up). Makes an upload that will not start diagnosable on-device.
  function describeFail(result) {
    var s = result.status || 0;
    var extra = result.serverCode ? ' — ' + serverCodeText(result.serverCode) : '';
    if (result.rateLimited || s === 429) return { badge: 'HTTP 429', hint: t('diagRateLimited') };
    if (result.proxyLimit || s === 413) return { badge: 'HTTP 413', hint: t('diagProxyLimit') };
    var secs = result.ms ? Math.round(result.ms / 1000) : 0;
    if (result.timeout) return { badge: t('diagBadgeTimeout'), hint: t('diagTimeout') };
    if (s === 502 || s === 503 || s === 504) return { badge: 'HTTP ' + s, hint: t('diagGateway', { s: s }) + extra };
    if (s >= 500) return { badge: 'HTTP ' + s, hint: t('diagServerError', { s: s }) + extra };
    if (s === 409) return { badge: 'HTTP 409', hint: t('diagSync') + extra };
    if (s > 0) return { badge: 'HTTP ' + s, hint: t('diagHttp', { s: s }) + extra };
    // Network-layer failure (no HTTP status). Split the two very different causes:
    // the body started flowing then got cut (proxy/server closed the connection on a
    // large body) vs. the request never sent a byte (blocked/refused before sending).
    if (result.sentAny) return { badge: t('diagBadgeNetCut'), hint: t('diagNetCut', { s: secs }) };
    return { badge: t('diagBadgeNetwork'), hint: t('diagNetRefused', { s: secs }) };
  }
  function senderValue() { return destNeedsSender ? String($('sender-name').value || '').trim() : ''; }
  function snapshotForCurrentDest() {
    if (!currentDest || !currentDestOk) return null;
    var enc = currentConfig && currentConfig.enc ? { on: true, mode: currentConfig.enc.mode || 'key' } : null;
    return {
      token: currentDest.token,
      name: currentDest.name || ('…' + currentDest.token.slice(-8)),
      sender: senderValue(),
      enc: enc,
      key: enc && enc.mode !== 'pass' ? String($('enc-key').value || currentDest.key || '').trim().replace(/^#?k=/, '') : '',
      passphrase: enc && enc.mode === 'pass' ? String($('enc-passphrase').value || '') : '',
      expire: expireSeconds(),
      createdAt: Date.now()
    };
  }
  function expireSeconds() { return $('expire-select') ? (parseInt($('expire-select').value, 10) || 0) : 0; }
  function validateSnapshot(snapshot) {
    if (!snapshot) { toast(t('invalidLink'), 'warn'); return false; }
    if (destNeedsSender && !snapshot.sender) { toast(t('senderRequired'), 'warn'); $('sender-name').focus(); return false; }
    if (snapshot.enc && snapshot.enc.mode === 'pass' && !snapshot.passphrase) { toast(t('passRequired'), 'warn'); $('enc-passphrase').focus(); return false; }
    if (snapshot.enc && snapshot.enc.mode !== 'pass' && !snapshot.key) { toast(t('keyRequired'), 'warn'); $('enc-key').focus(); return false; }
    if (snapshot.enc && (!window.DXCrypto || !window.DXCrypto.available)) { toast(t('noCrypto'), 'err'); return false; }
    return true;
  }
  function getOffset(snapshot, id) {
    return fetchWithTimeout('/u/' + encodeURIComponent(snapshot.token) + '/upload-status?id=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' }, OFFSET_TIMEOUT_MS)
      .then(function (r) { return r.ok ? r.json() : { offset: 0 }; })
      .then(function (d) { return Math.max(0, Number(d && d.offset) || 0); })
      .catch(function () { return 0; });
  }
  // Reachability probe: any HTTP reply (even 4xx) to a plain GET on the same origin
  // means the server is reachable and the failure was specific to the upload POST.
  // Only a network-level failure (no reply) resolves false.
  function probeReach(snapshot) {
    return fetchWithTimeout('/u/' + encodeURIComponent(snapshot.token) + '/upload-status?id=probe', { credentials: 'same-origin', cache: 'no-store' }, OFFSET_TIMEOUT_MS)
      .then(function () { return true; }).catch(function () { return false; });
  }
  // Readability probe: can the device actually read the file bytes? On mobile a very
  // large picked file (content:// URI) can become unreadable, which makes xhr.send
  // fail as a bare network error BEFORE any byte leaves — indistinguishable from a
  // proxy block unless we test the read directly. Reads just the first 64 KiB.
  function probeReadable(it) {
    var blob = it.preparedBlob;
    if (!blob || typeof blob.slice !== 'function') return Promise.resolve(false);
    var slice = blob.slice(0, 65536);
    if (slice.arrayBuffer) return slice.arrayBuffer().then(function (buf) { return !!(buf && buf.byteLength > 0); }).catch(function () { return false; });
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(!!(fr.result && fr.result.byteLength > 0)); };
      fr.onerror = function () { resolve(false); };
      try { fr.readAsArrayBuffer(slice); } catch (_) { resolve(false); }
    });
  }
  function putChunk(it, offset) {
    return new Promise(function (resolve) {
      if (it.state === 'removed') return resolve({ cancelled: true });
      var blob = it.preparedBlob;
      var chunkSize = Math.max(MIN_CHUNK, it.chunkSize || initialChunkSize());
      it.chunkSize = chunkSize;
      var end = Math.min(it.upSize, offset + chunkSize);
      var xhr = new XMLHttpRequest(); it.xhr = xhr; activeXhrs.add(xhr);
      var qs = '?path=' + encodeURIComponent(it.upName) + '&id=' + encodeURIComponent(it.uploadId) + '&size=' + it.upSize + '&offset=' + offset;
      if (it.snapshot.sender) qs += '&sender=' + encodeURIComponent(it.snapshot.sender);
      if (it.snapshot.expire) qs += '&expire=' + encodeURIComponent(it.snapshot.expire);
      xhr.open('POST', '/u/' + encodeURIComponent(it.snapshot.token) + '/upload' + qs);
      xhr.withCredentials = true;
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Cache-Control', 'no-store');
      var started = Date.now();
      var settled = false, sentAny = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        activeXhrs.delete(xhr);
        if (it.xhr === xhr) it.xhr = null;
        resolve(result);
      }
      xhr.upload.onloadstart = function () {
        if (offset === 0 && it.sentBytes === 0) updateItemUi(it, t('startingUpload'));
      };
      xhr.upload.onprogress = function (event) {
        if (!event.lengthComputable) return;
        if (event.loaded > 0) sentAny = true; // the request body actually started flowing
        var sent = offset + event.loaded; it.sentBytes = sent;
        if (it.progress) { it.progress.max = Math.max(1, it.upSize); it.progress.value = Math.min(it.upSize, sent); }
        if (it.meta) {
          // Smoothed rate for THIS transfer, carried across blocks on it.rate.
          var rate = emaRate(it.rate || (it.rate = {}), sent);
          var line = fmtBytes(sent) + ' / ' + fmtBytes(it.upSize) + ' · ' + pctText(sent, it.upSize);
          if (rate > 0) {
            line = '↑ ' + fmtBytes(rate) + '/s · ' + line;
            if (sent < it.upSize) line += ' · ⏳ ' + fmtEta((it.upSize - sent) / rate);
          }
          it.meta.textContent = line;
        }
        updateGlobalProgress();
      };
      xhr.onabort = function () {
        if (paused || it.state === 'removed') return finish({ paused: paused, cancelled: it.state === 'removed' });
        finish({ retry: true, offset: null, shrink: true });
      };
      xhr.onerror = function () { finish({ retry: true, offset: null, shrink: offset === 0, netError: true, sentAny: sentAny, ms: Date.now() - started }); };
      xhr.ontimeout = function () { finish({ retry: true, offset: null, shrink: true, timeout: true, sentAny: sentAny, ms: Date.now() - started }); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          var response = null; try { response = JSON.parse(xhr.responseText); } catch (_) {}
          return finish({ done: true, response: response });
        }
        var code = '', serverOffset = null;
        try { var body = JSON.parse(xhr.responseText) || {}; code = body.error || ''; if (body.offset != null) serverOffset = body.offset; } catch (_) {}
        if (xhr.status === 409) {
          if (serverOffset != null && serverOffset > offset) return finish({ progress: true, offset: serverOffset });
          return finish({ retry: true, offset: serverOffset, status: 409, serverCode: code });
        }
        if (FATAL.indexOf(code) !== -1) return finish({ fatal: true, code: code });
        if (xhr.status === 401) return finish({ fatal: true, code: 'locked' });
        if (xhr.status === 403) return finish({ fatal: true, code: 'revoked' });
        // 429 from the server's own per-IP limiter OR a proxy: this is not a transfer
        // failure. Honour Retry-After and wait the window out without shrinking or
        // spending the retry budget, so a large upload (hundreds of blocks) survives.
        if (xhr.status === 429) {
          var ra = parseInt(xhr.getResponseHeader('Retry-After'), 10);
          return finish({ retry: true, offset: serverOffset, rateLimited: true, retryAfter: ra > 0 ? ra : 0, status: 429, serverCode: code });
        }
        // A proxy commonly answers 413 before reading the body. Reduce the next
        // request below its body limit instead of retrying the same block forever.
        if (xhr.status === 413) return finish({ retry: true, offset: serverOffset, shrink: true, proxyLimit: true, status: 413, serverCode: code });
        finish({ retry: true, offset: serverOffset, shrink: offset === 0 && xhr.status >= 500, status: xhr.status, serverCode: code });
      };
      xhr.send(blob.slice(offset, end));
    });
  }
  function waitUntilOnline() {
    if (navigator.onLine) return Promise.resolve();
    return new Promise(function (resolve) { onlineWaiters.push(resolve); });
  }
  // True unless the "Wi-Fi only" preference is on AND the Network Information API
  // reports a metered/cellular link. Unknown connection type is treated as allowed.
  function wifiOk() {
    if (!$('wifi-only') || !$('wifi-only').checked) return true;
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c || !c.type) return true; // no info: don't block the user
    return c.type === 'wifi' || c.type === 'ethernet' || c.type === 'wimax' || c.type === 'unknown';
  }
  function waitUntilWifi() {
    if (wifiOk()) return Promise.resolve();
    return new Promise(function (resolve) { wifiWaiters.push(resolve); });
  }
  function releaseWifiWaiters() {
    if (!wifiOk()) return;
    var w = wifiWaiters.splice(0); w.forEach(function (resolve) { resolve(); });
  }
  function waitUntilResumed() {
    if (!paused) return Promise.resolve();
    return new Promise(function (resolve) { resumeWaiters.push(resolve); });
  }
  async function finishItem(it, response) {
    it.state = 'done'; it.sentBytes = it.upSize; it.errorCode = null; it.resumeOnOpen = false;
    updateItemUi(it, t('done'), 'ok'); if (it.meta) it.meta.textContent = fmtBytes(it.upSize);
    await removePersistedItem(it);
    // Average rate for THIS file (bytes actually pushed this attempt over its wall time).
    var elapsed = (Date.now() - (it.sendStartAt || Date.now())) / 1000;
    var moved = Math.max(0, (it.upSize || 0) - (it.sendStartBytes || 0));
    var rate = elapsed > 0.2 && moved > 0 ? moved / elapsed : 0;
    sessionFiles++; sessionBytes += it.upSize || 0;
    lifetimeFiles++; lifetimeBytes += it.upSize || 0;
    metaSet('lifetime', { files: lifetimeFiles, bytes: lifetimeBytes }).catch(function () {});
    updateSessionStats();
    // Stamp the destination's last-used time for the "used 2 h ago" hint.
    var usedDest = findDest(it.snapshot.token);
    if (usedDest) { usedDest.lastUsedAt = Date.now(); if (usedDest.remembered) persistDestination(usedDest).catch(function () {}); else persistSessionDests(); }
    if (it.snapshot.sender) rememberSender(it.snapshot.sender);
    await addHistory({ id: genId(18), name: it.name, size: it.size, sentSize: it.upSize, destination: it.snapshot.name, encrypted: !!it.snapshot.enc, at: Date.now(), rate: rate, note: it.note || '' });
    if (response && currentConfig && currentDest && currentDest.token === it.snapshot.token) {
      if (response.filesReceived != null) currentConfig.filesReceived = response.filesReceived;
      if (response.bytesReceived != null) currentConfig.bytesReceived = response.bytesReceived;
      showLimits(currentConfig);
    }
  }
  async function uploadOne(it) {
    if (it.state === 'removed' || it.state === 'done') return true;
    try { await prepareUpload(it); }
    catch (e) {
      it.state = 'error'; it.resumeOnOpen = false; it.errorCode = e && e.message === 'nokey' ? 'nokey' : e && e.message === 'nopass' ? 'nopass' : e && e.message === 'nocrypto' ? 'nocrypto' : 'prepare';
      updateItemUi(it, it.errorCode === 'nokey' ? t('keyRequired') : it.errorCode === 'nopass' ? t('passRequired') : it.errorCode === 'nocrypto' ? t('noCrypto') : t('error'), 'err');
      await persistItem(it, false); return false;
    }
    it.prepareProgress = 0;
    var offset = await getOffset(it.snapshot, it.uploadId);
    offset = Math.min(offset, it.upSize); it.sentBytes = offset;
    // Open with a small, proxy-safe block; ramp up (below) only after successes.
    // chunkCeil is the largest size proven to work this session — lowered whenever
    // a block is rejected so the upload never grows back into a failing size.
    if (!it.chunkSize) it.chunkSize = Math.min(FIRST_CHUNK, initialChunkSize());
    it.chunkCeil = Math.max(MIN_CHUNK, it.chunkCeil || initialChunkSize());
    it.sendStartAt = Date.now(); it.sendStartBytes = offset; // baseline for the per-file average rate
    var failures = 0;
    while (it.state !== 'removed') {
      await waitUntilResumed();
      if (!navigator.onLine) {
        it.state = 'waiting-network'; updateItemUi(it, t('waitingNetwork')); schedulePersistItem(it); await waitUntilOnline(); continue;
      }
      if (!wifiOk()) {
        it.state = 'waiting-network'; updateItemUi(it, t('waitingWifi')); schedulePersistItem(it); await waitUntilWifi(); continue;
      }
      it.state = 'sending'; updateItemUi(it, offset ? Math.round((offset / Math.max(1, it.upSize)) * 100) + '%' : t('startingUpload'));
      var result = await putChunk(it, offset);
      if (result.cancelled) return false;
      if (result.paused) { it.state = 'paused'; updateItemUi(it, t('paused')); await persistItem(it, false); continue; }
      if (result.done) { await finishItem(it, result.response); return true; }
      if (result.progress) {
        offset = Math.min(result.offset, it.upSize); it.sentBytes = offset; failures = 0; it.lastFail = null; it.lastHint = null;
        // A block went through: grow toward the device-ideal size for throughput.
        if (it.chunkSize < it.chunkCeil) it.chunkSize = Math.min(it.chunkCeil, it.chunkSize * 2);
        schedulePersistItem(it); updateGlobalProgress(); continue;
      }
      if (result.fatal) {
        it.state = 'error'; it.resumeOnOpen = false; it.errorCode = result.code; updateItemUi(it, reasonText(result.code), 'err');
        lastDiag = { name: it.name, badge: 'HTTP', hint: reasonText(result.code), code: result.code, at: Date.now() };
        await persistItem(it, false); return false;
      }
      if (result.rateLimited) {
        // Not a transfer failure: the server/proxy asked us to slow down. Wait it out
        // (Retry-After when given, else a short back-off) and retry the same block —
        // without spending the failure budget or shrinking the chunk. A big upload
        // needs hundreds of requests and must not die just for pacing.
        it.state = 'waiting-network'; updateItemUi(it, t('rateLimited'));
        if (result.offset != null) { offset = Math.min(Math.max(0, result.offset), it.upSize); it.sentBytes = offset; }
        schedulePersistItem(it);
        await sleep(Math.min(60000, Math.max(2000, (result.retryAfter || 5) * 1000)));
        continue;
      }
      failures++;
      // Record why this block failed: a short badge for the live status line and a
      // precise sentence for the final give-up message. Both make a stalled upload
      // diagnosable on a phone without dev tools.
      var diag = describeFail(result);
      it.lastFail = diag.badge; it.lastHint = diag.hint;
      // "Refused before sending a byte" is ambiguous: the upload POST may be blocked
      // (proxy/WAF/method/route) while the server is otherwise reachable, or there may
      // be no connectivity at all. A quick GET to the same origin separates the two —
      // decisive here since small files' identical first POST succeeds.
      if (result.netError && !result.sentAny) {
        var readable = await probeReadable(it);
        var reachable = await probeReach(it.snapshot);
        if (!readable) { it.lastFail = t('diagBadgeFileRead'); it.lastHint = t('diagFileUnreadable'); }
        else if (reachable) { it.lastFail = t('diagBadgePostBlock'); it.lastHint = t('diagPostBlocked'); }
        else { it.lastHint = t('diagNoConnect'); }
      }
      var stall = function () {
        it.state = 'error'; it.resumeOnOpen = false; it.errorCode = 'upload-stalled';
        var msg = it.lastHint ? t('uploadStalled') + ' — ' + it.lastHint : t('uploadStalled');
        updateItemUi(it, msg, 'err');
        if (it.meta) it.meta.textContent = it.lastHint || t('uploadStalled');
        lastDiag = { name: it.name, badge: it.lastFail || '', hint: it.lastHint || '', at: Date.now() };
      };
      var currentChunk = Math.max(MIN_CHUNK, it.chunkSize || initialChunkSize());
      if (result.shrink || (offset === 0 && failures >= 2)) {
        var smaller = nextSmallerChunk(currentChunk);
        if (smaller < currentChunk) {
          it.chunkSize = smaller;
          it.chunkCeil = smaller; // never ramp back up into a size the proxy/network rejected
          updateItemUi(it, t('shrinkingChunk') + ' · ' + it.lastFail);
          failures = Math.min(failures, 2);
        } else if (result.proxyLimit || failures >= MAX_RECOVERABLE_FAILURES) {
          stall(); await persistItem(it, false); return false;
        }
      }
      if (failures >= MAX_RECOVERABLE_FAILURES && currentChunk <= MIN_CHUNK) {
        stall(); await persistItem(it, false); return false;
      }
      it.state = navigator.onLine ? 'sending' : 'waiting-network';
      updateItemUi(it, navigator.onLine ? (t('restoring') + (it.lastFail ? ' · ' + it.lastFail : '')) : t('waitingNetwork'));
      offset = result.offset != null ? Math.max(0, result.offset) : await getOffset(it.snapshot, it.uploadId);
      if (offset > it.upSize) offset = it.upSize;
      it.sentBytes = offset; schedulePersistItem(it);
      if (!navigator.onLine) await waitUntilOnline();
      else await sleep([700, 1200, 2200, 4000, 7000][Math.min(failures - 1, 4)]);
    }
    return false;
  }
  function setDestinationLocked(locked) {
    destinationLocked = locked;
    ['dest-select', 'dest-add-btn', 'dest-create-btn', 'dest-revoke-btn', 'dest-copy-btn', 'sender-name', 'enc-key', 'enc-passphrase'].forEach(function (id) {
      if ($(id)) $(id).disabled = locked;
    });
    renderDests();
  }
  async function acquireWake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', function () { wakeLock = null; });
      }
    } catch (_) {}
  }
  function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (_) {} wakeLock = null; }
  function pauseBatch() {
    if (!sending || paused) return;
    paused = true; $('pause-btn').classList.add('hidden'); $('resume-btn').classList.remove('hidden');
    toast(t('pauseRequested'), 'warn'); activeXhrs.forEach(function (xhr) { try { xhr.abort(); } catch (_) {} });
    setTimeout(function () { items.filter(function (it) { return it.state === 'paused'; }).forEach(function (it) { it.resumeOnOpen = false; persistItem(it, false); }); }, 50);
  }
  function resumeBatch() {
    if (!paused) return;
    paused = false; $('resume-btn').classList.add('hidden'); $('pause-btn').classList.remove('hidden');
    var waiters = resumeWaiters.splice(0); waiters.forEach(function (resolve) { resolve(); }); toast(t('resumed'), 'ok');
  }
  function senderMap() {
    try { var map = JSON.parse(localStorage.getItem('dx-pwa-sender-by-destination') || '{}'); return map && typeof map === 'object' ? map : {}; }
    catch (_) { return {}; }
  }
  function saveSenderForCurrent() {
    if (!currentDest || !$('sender-name')) return;
    var map = senderMap(), value = String($('sender-name').value || '').trim();
    if (value) map[currentDest.token] = value; else delete map[currentDest.token];
    try {
      localStorage.setItem('dx-pwa-sender-by-destination', JSON.stringify(map));
      if (value) localStorage.setItem('dx_sender', value); // migration/fallback for older installations
    } catch (_) {}
  }
  function summaryForBatch(candidates, ok, fail) {
    var destination = candidates[0] && candidates[0].snapshot ? candidates[0].snapshot.name : (currentDest && currentDest.name) || '';
    return {
      at: Date.now(), destination: destination, ok: ok, fail: fail,
      totalSize: candidates.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0),
      files: candidates.map(function (it) { return { name: it.name, size: it.upSize || it.size || 0, state: it.state, note: it.note || '' }; })
    };
  }
  function summaryText(summary) {
    if (!summary) return '';
    var lines = ['Direct-Xfer', fmtDate(summary.at), summary.destination ? t('historyDest', { dest: summary.destination }) : ''];
    lines.push(t('batchResult', { ok: summary.ok || 0, fail: summary.fail ? t('failures', { n: summary.fail }) : ' ✓' }));
    lines.push(fmtBytes(summary.totalSize || 0));
    (summary.files || []).forEach(function (f, i) {
      lines.push((i + 1) + '. ' + (privacyNames ? privateFileName(i) : f.name) + ' · ' + fmtBytes(f.size || 0) + (f.note ? ' · ' + f.note : ''));
    });
    return lines.filter(Boolean).join('\n');
  }
  function updateResultActions() {
    if ($('last-batch-btn')) $('last-batch-btn').classList.toggle('hidden', !(lastBatchRecord && lastBatchRecord.files && lastBatchRecord.files.length));
    if ($('copy-summary-btn')) $('copy-summary-btn').classList.toggle('hidden', !lastBatchSummary);
    if ($('share-result-btn')) $('share-result-btn').classList.toggle('hidden', !(lastBatchSummary && navigator.share));
  }
  async function rememberLastBatch(candidates, ok, fail) {
    lastBatchSummary = summaryForBatch(candidates, ok, fail);
    metaSet('lastBatchSummary', lastBatchSummary).catch(function () {});
    var max = durablePayloadLimit();
    var successful = candidates.filter(function (it) { return it.state === 'done' && it.file; });
    var total = successful.reduce(function (sum, it) { return sum + (it.file.size || 0); }, 0);
    if (!successful.length || total > max) {
      lastBatchRecord = null;
      metaSet('lastBatch', null).catch(function () {});
      updateResultActions();
      return;
    }
    var snap = successful[0].snapshot || {};
    lastBatchRecord = {
      at: Date.now(), token: snap.token || '', destination: snap.name || '', sender: snap.sender || '',
      expire: snap.expire || 0, note: successful[0].note || '',
      files: successful.map(function (it) {
        return { file: it.file, name: it.name, originalName: it.originalName, type: it.type, size: it.size, lastModified: it.lastModified };
      })
    };
    try { await metaSet('lastBatch', lastBatchRecord); }
    catch (_) { lastBatchRecord = null; try { await idbDelete(META_STORE, 'lastBatch'); } catch (__) {} }
    updateResultActions();
  }
  async function resendLastBatch() {
    var rec = lastBatchRecord;
    if (!rec || !rec.files || !rec.files.length) { toast(t('lastBatchUnavailable'), 'warn'); updateResultActions(); return; }
    if (rec.token && findDest(rec.token)) {
      setActiveToken(rec.token); renderDests(); $('dest-select').value = rec.token; await refreshDestStatus();
    }
    if ($('batch-note')) { $('batch-note').value = rec.note || ''; updateCharCount($('batch-note'), $('note-count'), 120); }
    if ($('expire-select')) $('expire-select').value = String(rec.expire || 0);
    if ($('sender-name') && rec.sender) { $('sender-name').value = rec.sender; saveSenderForCurrent(); }
    var added = 0;
    for (var i = 0; i < rec.files.length; i++) {
      var f = rec.files[i];
      if (!f.file) continue;
      var it = makeItem({ file: f.file, name: f.name, originalName: f.originalName, type: f.type, size: f.size, lastModified: f.lastModified, state: 'waiting' });
      items.push(it); persistItem(it, false); added++;
    }
    renderQueue(); updateSendBtn(); updateStorageStatus();
    toast(t('lastBatchRestored', { n: added }), added ? 'ok' : 'warn');
  }
  function copyLastSummary() {
    if (!lastBatchSummary) { toast(t('noSummary'), 'warn'); return; }
    copyText(summaryText(lastBatchSummary)).then(function () { toast(t('summaryCopied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); });
  }
  async function shareLastSummary() {
    if (!lastBatchSummary) { toast(t('noSummary'), 'warn'); return; }
    var text = summaryText(lastBatchSummary);
    if (navigator.share) {
      try { await navigator.share({ title: 'Direct-Xfer', text: text }); return; } catch (_) {}
    }
    copyLastSummary();
  }
  function applyOptimizationPreset(value, persist) {
    value = value || 'message';
    var map = {
      original: { on: false, quality: '0.95', max: '0' },
      high: { on: true, quality: '0.95', max: '4096' },
      message: { on: true, quality: '0.86', max: '2560' },
      saver: { on: true, quality: '0.7', max: '1600' }
    };
    if (value !== 'custom' && map[value]) {
      $('optimize-images').checked = map[value].on;
      $('img-quality').value = map[value].quality;
      $('img-maxdim').value = map[value].max;
    }
    $('optimize-opts').classList.toggle('hidden', !$('optimize-images').checked);
    if ($('optimize-preset')) $('optimize-preset').value = value;
    if (persist !== false) {
      try {
        localStorage.setItem('dx-pwa-opt-preset', value);
        localStorage.setItem('dx-pwa-img-quality', $('img-quality').value);
        localStorage.setItem('dx-pwa-img-maxdim', $('img-maxdim').value);
      } catch (_) {}
    }
    clearEstimates(); renderQueue(); estimateOptimizedSizes();
  }
  function markOptimizationCustom() {
    if ($('optimize-preset')) { $('optimize-preset').value = 'custom'; try { localStorage.setItem('dx-pwa-opt-preset', 'custom'); } catch (_) {} }
  }
  function confirmMobileDataIfNeeded(candidates) {
    if (!$('confirm-mobile-data') || !$('confirm-mobile-data').checked || !isCellularConnection()) return true;
    var total = candidates.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0);
    if (total < 10 * 1024 * 1024) return true;
    return confirm(t('mobileDataConfirm', { size: fmtBytes(total) }));
  }

  async function startBatch(onlyItems) {
    if (sending) return;
    var candidates = (onlyItems || items).filter(function (it) { return it.state === 'waiting' || it.state === 'error' || it.state === 'waiting-network'; });
    if (!candidates.length) { toast(t('noPending'), 'warn'); return; }
    if (!confirmMobileDataIfNeeded(candidates)) return;
    saveSenderForCurrent();
    var snap = candidates.every(function (it) { return !!it.snapshot; }) ? null : snapshotForCurrentDest();
    if (snap && !validateSnapshot(snap)) return;
    // A transfer is not allowed to start until its source bytes have a durable
    // local copy. This guarantees that any network request visible as "sending"
    // can be reconstructed after Android closes the PWA.
    for (var d = 0; d < candidates.length; d++) {
      var durableItem = candidates[d];
      if (durableItem.persistPromise) await durableItem.persistPromise;
      else if (!durableItem.opfsPath && !durableItem.volatile && opfsAvailable()) await ensureSourceDurable(durableItem, true);
    }
    var batchNote = $('batch-note') ? String($('batch-note').value || '').trim().slice(0, 120) : '';
    for (var i = 0; i < candidates.length; i++) {
      var item = candidates[i];
      if (batchNote && !item.note) item.note = batchNote;
      if (!item.snapshot) item.snapshot = Object.assign({}, snap);
      // Secrets are intentionally never persisted in IndexedDB. Rehydrate them
      // from the selected destination only when preparation still needs them.
      if (item.snapshot.enc && !item.preparedBlob) {
        if (!currentDest || currentDest.token !== item.snapshot.token) {
          toast(t('destinationLocked'), 'warn'); return;
        }
        if (item.snapshot.enc.mode === 'pass') item.snapshot.passphrase = String($('enc-passphrase').value || '');
        else item.snapshot.key = String($('enc-key').value || currentDest.key || '').trim().replace(/^#?k=/, '');
        if (!validateSnapshot(item.snapshot)) return;
      }
      item.resumeOnOpen = true;
      await persistItem(item, false); // resume metadata must exist before the first network request
    }
    sending = true; paused = false; batch = candidates; batchTotal = candidates.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0);
    globalRate = {}; candidates.forEach(function (it) { it.rate = {}; }); // fresh smoothed-rate baselines for this batch
    batchSnapshot = candidates[0].snapshot; setDestinationLocked(true); $('send-btn').disabled = true; $('pause-btn').classList.remove('hidden'); $('resume-btn').classList.add('hidden');
    $('global-progress-wrap').classList.remove('hidden'); await acquireWake(); updateGlobalProgress();
    var queue = candidates.slice(), ok = 0, fail = 0;
    var concurrency = Math.max(1, Math.min(3, parseInt($('concurrency-select').value, 10) || 2));
    // Mobile browsers are much more reliable with one large upload at a time.
    if (isMobileLike() || candidates.some(function (it) { return (it.size || 0) >= 128 * 1024 * 1024; })) concurrency = 1;
    async function worker() {
      while (queue.length) {
        var it = queue.shift();
        var good = await uploadOne(it); if (good) ok++; else if (it.state !== 'removed') fail++;
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(concurrency, candidates.length); w++) workers.push(worker());
    await Promise.all(workers);
    // Learn the average rate for future pre-send estimates (feature: estimated time).
    var learned = emaRate(globalRate, batchTotal);
    await rememberLastBatch(candidates, ok, fail);
    if (learned > 0) { avgRate = avgRate > 0 ? avgRate * 0.5 + learned * 0.5 : learned; try { localStorage.setItem('dx-pwa-avg-rate', String(Math.round(avgRate))); } catch (_) {} }
    sending = false; paused = false; batch = []; batchTotal = 0; batchSnapshot = null; setDestinationLocked(false);
    if (!($('keep-awake') && $('keep-awake').checked)) releaseWake();
    $('pause-btn').classList.add('hidden'); $('resume-btn').classList.add('hidden'); $('global-progress-wrap').classList.add('hidden');
    if (navigator.vibrate && (!$('vibrate-finish') || $('vibrate-finish').checked)) { try { navigator.vibrate(fail ? [60, 40, 60] : 35); } catch (_) {} }
    toast(t('batchResult', { ok: ok, fail: fail ? t('failures', { n: fail }) : ' ✓' }), fail ? 'warn' : 'ok');
    renderQueue(); updateSendBtn(); renderHistory(); updateStorageStatus(); refreshDestStatus();
    if ($('sound-finish') && $('sound-finish').checked) playBeep(!!fail);
    // Scroll the first failed file into view so its error is seen without hunting.
    if (fail) {
      var firstErr = items.filter(function (it) { return it.state === 'error'; })[0];
      if (firstErr && firstErr.row) { try { firstErr.row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }
    }
    // Optionally tidy the completed rows away after a short delay.
    if (!fail && $('auto-clear-done') && $('auto-clear-done').checked) setTimeout(function () { if (!sending) clearDone(); }, 6000);
  }
  function updateGlobalProgress() {
    var source = batch.length ? batch : items.filter(function (it) { return it.state !== 'done' && it.state !== 'removed'; });
    var total = batch.length ? source.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0) : 0;
    var sent = source.reduce(function (sum, it) { return sum + Math.min(it.sentBytes || 0, it.upSize || it.size || 0); }, 0);
    var done = source.filter(function (it) { return it.state === 'done'; }).length;
    $('global-progress').max = Math.max(1, total); $('global-progress').value = Math.min(total, sent);
    var pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
    var line = pct + ' % · ' + done + '/' + source.length + ' · ' + fmtBytes(sent) + ' / ' + fmtBytes(total);
    // Overall smoothed rate + ETA across the whole batch, shown while actively sending.
    if (sending && !paused) {
      var rate = emaRate(globalRate, sent);
      if (rate > 0) {
        line += ' · ↑ ' + fmtBytes(rate) + '/s';
        var remain = Math.max(0, total - sent);
        if (remain > 0) line += ' · ⏳ ' + fmtEta(remain / rate);
      }
    }
    $('gprog-text').textContent = line;
    // Live tab title while a batch is in flight. The app badge also represents
    // queued and failed files while idle, so it is updated centrally.
    if (sending) document.title = '(' + pct + ' %) ' + baseTitle;
    else if (document.title !== baseTitle) document.title = baseTitle;
    updateAppBadge();
  }
  function updateSendBtn() {
    var waiting = items.filter(function (it) { return ['waiting', 'waiting-network'].indexOf(it.state) !== -1; });
    var pausedItems = items.filter(function (it) { return it.state === 'paused'; });
    var errors = items.filter(function (it) { return it.state === 'error'; });
    var done = items.some(function (it) { return it.state === 'done'; });
    $('send-btn').disabled = sending || !(currentDestOk && waiting.length);
    var sendBytes = waiting.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0);
    $('send-btn').textContent = (waiting.length && !sending) ? t('sendCount', { n: waiting.length, size: fmtBytes(sendBytes) }) : t('send');
    $('clear-done-btn').classList.toggle('hidden', !done);
    $('queue-summary').classList.toggle('hidden', !(waiting.length || pausedItems.length || errors.length || sending || lastBatchRecord || lastBatchSummary));
    var bytes = waiting.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0);
    var summary = waiting.length ? t('queueSummary', { waiting: waiting.length, size: fmtBytes(bytes) }) :
      pausedItems.length ? t('queuePaused', { n: pausedItems.length }) :
      errors.length ? t('queueErrors', { n: errors.length }) :
      lastBatchSummary ? t('batchResult', { ok: lastBatchSummary.ok || 0, fail: lastBatchSummary.fail ? t('failures', { n: lastBatchSummary.fail }) : ' ✓' }) : '';
    // A rough time estimate before sending, using the average rate learned from
    // previous batches on this device. Only shown once we have a usable rate.
    if (waiting.length && !sending && avgRate > 0 && bytes > 0) summary += ' · ⏳ ' + t('queueEta', { eta: fmtEta(bytes / avgRate).replace(/^~/, '') });
    $('queue-text').textContent = summary;
    $('retry-all-btn').classList.toggle('hidden', !errors.length || sending);
    $('clear-all-btn').classList.toggle('hidden', !(waiting.length || errors.length) || sending);
    // ZIP needs 2+ pending files; multi-send needs pending files and at least one link.
    var pendingLocal = items.filter(function (it) { return ['waiting', 'error', 'paused', 'waiting-network'].indexOf(it.state) !== -1 && !it.snapshot && it.file; });
    if ($('zip-btn')) $('zip-btn').classList.toggle('hidden', sending || pendingLocal.length < 2);
    if ($('multisend-btn')) $('multisend-btn').classList.toggle('hidden', sending || !pendingLocal.length || !allDests().length);
    updateFilesCount(); updateResultActions(); updateAppBadge();
  }
  function maybeAutoResume() {
    if (sending || !$('auto-resume').checked || !navigator.onLine) return;
    var resumable = items.filter(function (it) {
      return it.resumeOnOpen && it.snapshot && ['waiting', 'waiting-network'].indexOf(it.state) !== -1 && (it.file || it.preparedBlob);
    });
    if (resumable.length) setTimeout(function () { if (!sending) startBatch(resumable); }, 350);
  }

  // History -----------------------------------------------------------------
  function mergeHistoryEntries() {
    var byId = Object.create(null);
    Array.prototype.slice.call(arguments).forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (entry) {
        if (!entry || !entry.id) return;
        var previous = byId[entry.id];
        if (!previous || (Number(entry.at) || 0) >= (Number(previous.at) || 0)) byId[entry.id] = entry;
      });
    });
    return Object.keys(byId).map(function (id) { return byId[id]; })
      .sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); })
      .slice(0, MAX_HISTORY);
  }
  function localHistoryBackup() {
    try {
      var parsed = JSON.parse(localStorage.getItem('dx-pwa-history-backup') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function persistHistorySnapshot() {
    var snapshot = historyEntries.slice(0, MAX_HISTORY);
    try { localStorage.setItem('dx-pwa-history-backup', JSON.stringify(snapshot)); } catch (_) {}
    return metaSet('historySnapshot', snapshot).catch(function () {});
  }
  async function loadPersistentHistory() {
    var stored = await idbGetAll(HISTORY_STORE).catch(function () { return []; });
    var backup = await metaGet('historySnapshot', []).catch(function () { return []; });
    var merged = mergeHistoryEntries(stored, backup, localHistoryBackup());
    if (merged.length) {
      await Promise.all(merged.map(function (entry) { return idbPut(HISTORY_STORE, entry); })).catch(function () {});
      historyEntries = merged;
      await persistHistorySnapshot();
    }
    return merged;
  }
  function addHistory(entry) {
    historyEntries.unshift(entry); if (historyEntries.length > MAX_HISTORY) historyEntries.length = MAX_HISTORY;
    return idbPut(HISTORY_STORE, entry).then(function () {
      if (historyEntries.length >= MAX_HISTORY) {
        var keep = Object.create(null); historyEntries.forEach(function (h) { keep[h.id] = true; });
        return idbGetAll(HISTORY_STORE).then(function (all) { return Promise.all(all.filter(function (h) { return !keep[h.id]; }).map(function (h) { return idbDelete(HISTORY_STORE, h.id); })); });
      }
    }).then(persistHistorySnapshot).catch(function () { return persistHistorySnapshot(); });
  }
  function updateSessionStats() {
    var el = $('session-stats');
    if (el) el.textContent = sessionFiles ? t('sessionStatsValue', { files: sessionFiles, size: fmtBytes(sessionBytes) }) : t('sessionStatsEmpty');
    var life = $('lifetime-stats');
    if (life) life.textContent = lifetimeFiles ? t('lifetimeStats') + ' · ' + t('sessionStatsValue', { files: lifetimeFiles, size: fmtBytes(lifetimeBytes) }) : '';
  }
  // Coarse relative time ("just now / 4 min ago / 2 h ago / 3 d ago").
  function fmtRelative(ms) {
    var d = Math.max(0, Date.now() - (ms || 0)), s = d / 1000;
    if (s < 60) return t('relNow');
    if (s < 3600) return t('relMin', { n: Math.floor(s / 60) });
    if (s < 86400) return t('relHour', { n: Math.floor(s / 3600) });
    return t('relDay', { n: Math.floor(s / 86400) });
  }
  function historyDetailText(h) {
    return [h.name, fmtBytes(h.size), t('historyDest', { dest: h.destination }), fmtDate(h.at)].join(' · ');
  }
  function removeHistoryEntry(h) {
    historyEntries = historyEntries.filter(function (x) { return x.id !== h.id; });
    idbDelete(HISTORY_STORE, h.id).catch(function () {}); persistHistorySnapshot(); renderHistory();
  }
  // Day bucket label for grouped history: Today / Yesterday / short date.
  function dayLabel(ms) {
    var d = new Date(ms), today = new Date();
    var startOf = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((startOf(today) - startOf(d)) / 86400000);
    if (diff <= 0) return t('histToday');
    if (diff === 1) return t('histYesterday');
    try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(d); } catch (_) { return d.toLocaleDateString(); }
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function exportHistory(format) {
    if (!historyEntries.length) { toast(t('historyEmpty'), 'warn'); return; }
    var stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      downloadBlob(new Blob([JSON.stringify(historyEntries, null, 2)], { type: 'application/json' }), 'direct-xfer-history-' + stamp + '.json');
      return;
    }
    var esc = function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var rows = [['name', 'size', 'destination', 'encrypted', 'rate_bytes_s', 'date'].join(',')];
    historyEntries.forEach(function (h) {
      rows.push([esc(h.name), h.size || 0, esc(h.destination), h.encrypted ? '1' : '0', Math.round(h.rate || 0), new Date(h.at).toISOString()].join(','));
    });
    downloadBlob(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' }), 'direct-xfer-history-' + stamp + '.csv');
  }
  function renderHistory() {
    var list = $('history-list'); list.innerHTML = '';
    if (!historyEntries.length) { var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = t('historyEmpty'); list.appendChild(empty); return; }
    var q = historyFilter.trim().toLowerCase();
    var matches = historyEntries.filter(function (h) {
      return !q || String(h.name).toLowerCase().indexOf(q) !== -1 || String(h.destination).toLowerCase().indexOf(q) !== -1 || String(h.note || '').toLowerCase().indexOf(q) !== -1;
    });
    if (!matches.length) { var none = document.createElement('p'); none.className = 'muted sm'; none.textContent = t('historyNoMatch'); list.appendChild(none); return; }
    var lastDay = '';
    matches.slice(0, 30).forEach(function (h, historyIndex) {
      var day = dayLabel(h.at);
      if (day !== lastDay) {
        lastDay = day;
        var head = document.createElement('div'); head.className = 'history-day'; head.textContent = day; list.appendChild(head);
      }
      var row = document.createElement('div'); row.className = 'history-row';
      var icon = document.createElement('span'); icon.textContent = h.encrypted ? '🔐' : '✓'; row.appendChild(icon);
      var main = document.createElement('div'); main.className = 'history-main';
      var strong = document.createElement('strong'); strong.textContent = privacyNames ? privateFileName(historyIndex) : h.name; main.appendChild(strong);
      var metaText = (h.note ? '🏷 ' + h.note + ' · ' : '') + fmtBytes(h.size) + ' · ' + t('historyDest', { dest: h.destination }) + ' · ' + fmtDate(h.at);
      if (h.rate > 0) metaText += ' · ' + t('rateAvg', { rate: fmtBytes(h.rate) });
      var meta = document.createElement('div'); meta.className = 'history-meta'; meta.textContent = metaText; main.appendChild(meta);
      row.appendChild(main);
      var actions = document.createElement('div'); actions.className = 'history-actions';
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'icon-action'; copy.textContent = '⧉'; copy.title = t('historyCopy'); copy.setAttribute('aria-label', t('historyCopy'));
      copy.addEventListener('click', function () { copyText(privacyNames ? [privateFileName(historyIndex), fmtBytes(h.size), t('historyDest', { dest: h.destination }), fmtDate(h.at)].join(' · ') : historyDetailText(h)).then(function () { toast(t('copied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); }); });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'icon-action remove'; del.textContent = '✕'; del.title = t('remove'); del.setAttribute('aria-label', t('remove'));
      del.addEventListener('click', function () { removeHistoryEntry(h); });
      actions.appendChild(copy); actions.appendChild(del); row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // Service worker share target ---------------------------------------------
  async function loadSharedBatch() {
    var params = new URLSearchParams(location.search);
    var batchId = params.get('shared');
    if (!batchId || typeof caches === 'undefined') return;
    try { history.replaceState(null, '', '/app/'); } catch (_) {}
    var files = [], cache = await caches.open('dx-share-v2');
    var metaResponse = await cache.match('/app/__shared/' + batchId + '/meta');
    if (!metaResponse) { toast(t('authExpired'), 'warn'); return; }
    var meta = await metaResponse.json();
    for (var i = 0; i < (meta.files || []).length; i++) {
      var response = await cache.match('/app/__shared/' + batchId + '/file/' + i); if (!response) continue;
      var blob = await response.blob(); var info = meta.files[i];
      files.push(namedFile(blob, info.name || ('file-' + (i + 1)), info.type || blob.type, info.lastModified || Date.now()));
    }
    var textParts = [];
    if (meta.title) textParts.push(meta.title);
    if (meta.text) textParts.push(meta.text);
    if (meta.url) textParts.push(meta.url);
    if (textParts.length) files.push(namedFile(new Blob([textParts.join('\n\n')], { type: 'text/plain;charset=utf-8' }), t('sharedTextName'), 'text/plain', Date.now()));
    var keys = await cache.keys();
    await Promise.all(keys.filter(function (req) { return new URL(req.url).pathname.indexOf('/app/__shared/' + batchId + '/') === 0; }).map(function (req) { return cache.delete(req); }));
    if (files.length) { await addFiles(files); toast(t('sharedReceived', { n: files.length }), 'ok'); }
  }

  // Device pairing -----------------------------------------------------------
  var deviceInfo = null;
  function appMutationHeaders(contentType) {
    var headers = { 'Content-Type': contentType || 'application/octet-stream' };
    if (deviceInfo && deviceInfo.csrf) headers['X-CSRF-Token'] = deviceInfo.csrf;
    return headers;
  }
  function platformName() { return navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || 'mobile'; }
  async function fetchDeviceStatus() {
    try {
      var r = await fetch('/app/device/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('status');
      deviceInfo = await r.json();
      deviceInfo.unavailable = false;
    } catch (_) { deviceInfo = { paired: false, adminSession: false, devices: [], unavailable: true }; }
    renderDeviceStatus();
    return deviceInfo;
  }
  // Authenticated PWA mutation. A 403 usually means the CSRF token went stale (an
  // old value that used to get cached by the service worker, or a rotated session);
  // refresh device status once to pick up a fresh token and retry.
  async function appMutate(url, contentType, body) {
    if (!deviceInfo) await fetchDeviceStatus();
    var r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders(contentType), body: body });
    if (r.status === 403) {
      await fetchDeviceStatus();
      r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders(contentType), body: body });
    }
    return r;
  }
  function renderDeviceStatus() {
    if (!deviceInfo) return;
    var paired = !!deviceInfo.paired;
    var pairButton = $('pair-device-btn');
    var unpairButton = $('revoke-device-btn');
    $('device-badge').classList.toggle('hidden', !paired);
    if (pairButton) {
      pairButton.classList.toggle('hidden', paired);
      pairButton.disabled = false;
    }
    if ($('pair-other-btn')) $('pair-other-btn').classList.toggle('hidden', !deviceInfo.adminSession);
    if ($('rename-device-btn')) $('rename-device-btn').classList.toggle('hidden', !paired || !deviceInfo.device);
    if (unpairButton) {
      unpairButton.classList.toggle('hidden', !paired);
      unpairButton.disabled = false;
    }
    // Show the CURRENT device's name whenever it is paired — including device-only mode
    // (no live admin session), where the admin-gated device list below is hidden and the
    // name would otherwise never appear. The server returns deviceInfo.device regardless.
    var currentName = deviceInfo.device && deviceInfo.device.name;
    $('device-status').textContent = deviceInfo.unavailable ? t('deviceStatusUnavailable')
      : paired ? (currentName ? currentName + ' · ' + t('devicePaired') : t('devicePaired'))
      : deviceInfo.adminSession ? t('deviceAdmin') : t('deviceUnpaired');
    var devices = Array.isArray(deviceInfo.devices) ? deviceInfo.devices : [];
    $('device-list-wrap').classList.toggle('hidden', !deviceInfo.adminSession || !devices.length);
    var list = $('device-list'); list.innerHTML = '';
    devices.forEach(function (d) {
      var row = document.createElement('div'); row.className = 'device-row';
      var main = document.createElement('div'); main.className = 'device-main';
      var strong = document.createElement('strong'); strong.textContent = d.name + (d.current ? ' · ' + t('deviceCurrent') : ''); main.appendChild(strong);
      var meta = document.createElement('div'); meta.className = 'device-meta'; meta.textContent = t('deviceLast', { date: fmtDate(d.lastUsedAt || d.createdAt) }); main.appendChild(meta); row.appendChild(main);
      var rename = document.createElement('button'); rename.type = 'button'; rename.className = 'btn ghost sm'; rename.textContent = t('renameDevice');
      rename.addEventListener('click', function () { renameDevice(d.id, d.name, !!d.current); }); row.appendChild(rename);
      if (!d.current) {
        var revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn danger sm'; revoke.textContent = t('revokeDevice');
        revoke.addEventListener('click', function () { revokeDevice(d.id, false); }); row.appendChild(revoke);
      }
      list.appendChild(row);
    });
  }
  async function pairDevice() {
    var button = $('pair-device-btn');
    if (button) button.disabled = true;
    try {
      var response = await fetch('/app/device/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('no-session');
      var status = await response.json();
      if (!status.adminSession || !status.csrf) throw new Error('no-session');
      var name = t('deviceName', { platform: platformName() });
      var r = await fetch('/app/device/register', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf }, body: JSON.stringify({ name: name }) });
      if (!r.ok) throw new Error('pair');
      toast(t('devicePairedOk'), 'ok');
      await fetchDeviceStatus();
    } catch (_) { toast(t('devicePairFailed'), 'err'); }
    finally { if (button && (!deviceInfo || !deviceInfo.paired)) button.disabled = false; }
  }
  var pairingObjectUrl = '', pairingPreviousFocus = null;
  function closePairingDialog() {
    $('pair-overlay').classList.add('hidden');
    if (pairingObjectUrl) { URL.revokeObjectURL(pairingObjectUrl); pairingObjectUrl = ''; }
    $('pair-qr').removeAttribute('src'); $('pair-url').value = ''; $('pair-expiry').textContent = '';
    if (pairingPreviousFocus && pairingPreviousFocus.focus) pairingPreviousFocus.focus(); pairingPreviousFocus = null;
  }
  async function openPairingDialog() {
    try {
      var status = await fetch('/app/device/status', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); });
      if (!status.adminSession || !status.csrf) throw new Error('no-session');
      var r = await fetch('/app/device/pairing', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf },
        body: JSON.stringify({ name: t('deviceName', { platform: 'QR' }) })
      });
      if (!r.ok) throw new Error('pairing');
      var data = await r.json();
      pairingPreviousFocus = document.activeElement;
      if (pairingObjectUrl) URL.revokeObjectURL(pairingObjectUrl);
      pairingObjectUrl = URL.createObjectURL(new Blob([data.qrSvg], { type: 'image/svg+xml' }));
      $('pair-qr').src = pairingObjectUrl; $('pair-url').value = data.claimUrl || '';
      $('pair-expiry').textContent = t('pairExpires', { date: fmtDate(data.expiresAt) });
      $('pair-overlay').classList.remove('hidden'); $('pair-close').focus();
    } catch (_) { toast(t('pairQrFailed'), 'err'); }
  }
  async function copyPairingLink() {
    if (!$('pair-url').value) return;
    try { await copyText($('pair-url').value); toast(t('copied'), 'ok'); }
    catch (_) { toast(t('copyFailed'), 'err'); }
  }

  async function revokeDevice(id, current) {
    if (!askConfirmation('revoke', current ? t('revokeThisDeviceConfirm') : t('revokeOtherConfirm'))) return;
    var revokeShares = confirm(t('revokeDeviceSharesConfirm'));
    try {
      if (current) await disablePush().catch(function () {});
      var r = await appMutate('/app/device/revoke', 'application/json', JSON.stringify({ id: id || null, revokeShares: revokeShares }));
      if (!r.ok) throw new Error('revoke');
      if (current) await clearLocalDataInternal(false).catch(function () {});
      toast(t('deviceRevoked'), 'ok'); await fetchDeviceStatus();
    } catch (_) { toast(t('deviceRevokeFailed'), 'err'); }
  }

  async function renameDevice(id, currentName, isCurrent) {
    var suggested = currentName || (deviceInfo && deviceInfo.device && deviceInfo.device.name) || '';
    var name = prompt(t('renameDevicePrompt'), suggested);
    if (name == null) return;
    name = name.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!name || name === currentName) return;
    try {
      var r = await appMutate('/app/device/rename', 'application/json', JSON.stringify({ id: (isCurrent ? null : id) || null, name: name }));
      if (!r.ok) throw new Error('rename');
      toast(t('deviceRenamed'), 'ok'); await fetchDeviceStatus();
    } catch (_) { toast(t('deviceRenameFailed'), 'err'); }
  }

  // Received content: files that landed on a reception link this device owns. The
  // list is fetched from the server on demand, so it is durable by nature and
  // survives IndexedDB/localStorage loss, WebAPK relaunch and reconnection.
  var receivedPrevFocus = null;
  function closeReceivedDialog() {
    $('received-overlay').classList.add('hidden');
    $('received-list').innerHTML = '';
    if (receivedPrevFocus && receivedPrevFocus.focus) receivedPrevFocus.focus();
    receivedPrevFocus = null;
  }
  async function openReceivedDialog() {
    var token = $('dest-select').value;
    var dest = token ? findDest(token) : null;
    if (!dest || !dest.owned) return;
    receivedPrevFocus = document.activeElement;
    $('received-sub').textContent = dest.name || ('…' + token.slice(-8));
    $('received-overlay').classList.remove('hidden');
    $('received-close').focus();
    await loadReceivedFiles(token);
  }
  async function loadReceivedFiles(token) {
    var listEl = $('received-list'), statusEl = $('received-status');
    listEl.innerHTML = ''; statusEl.textContent = t('receivedLoading');
    try {
      var r = await fetch('/app/inbox/' + encodeURIComponent(token) + '/files', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      var data = await r.json();
      var files = Array.isArray(data.files) ? data.files : [];
      if (!files.length) { statusEl.textContent = t('receivedEmpty'); return; }
      var totalBytes = files.reduce(function (sum, f) { return sum + (Number(f.size) || 0); }, 0);
      statusEl.textContent = t('receivedCount', { n: files.length, size: fmtBytes(totalBytes) });
      files.forEach(function (f) {
        var row = document.createElement('div'); row.className = 'received-row';
        var main = document.createElement('div'); main.className = 'received-main';
        var strong = document.createElement('strong'); strong.textContent = f.name || f.path; main.appendChild(strong);
        var meta = document.createElement('div'); meta.className = 'received-meta';
        meta.textContent = fmtBytes(Number(f.size) || 0) + ' · ' + fmtDate(f.mtime); main.appendChild(meta);
        row.appendChild(main);
        var dl = document.createElement('a');
        dl.className = 'btn ghost sm'; dl.textContent = t('receivedDownload');
        dl.href = '/app/inbox/' + encodeURIComponent(token) + '/file?path=' + encodeURIComponent(f.path);
        dl.setAttribute('download', f.name || '');
        dl.rel = 'noopener';
        row.appendChild(dl);
        listEl.appendChild(row);
      });
    } catch (_) {
      statusEl.textContent = t('receivedFail');
    }
  }

  // Destination sharing: native OS share sheet and an on-screen QR (the inverse of
  // the scanner) so a reception link can reach another device without copy/paste.
  function currentDestUrl() {
    if (!currentDest) return '';
    return location.origin + '/u/' + currentDest.token + (currentDest.key ? '#k=' + currentDest.key : '');
  }
  // Paste a link/token from the clipboard into a fresh destination form. Kept reachable
  // from the command palette after the toolbar's 📋 button was removed to declutter.
  async function pasteDestination() {
    try { var text = await navigator.clipboard.readText(); openDestForm(); $('dest-url').value = text; updateRememberKeyControl(); }
    catch (_) { toast(t('pasteFailed'), 'warn'); }
  }
  var destQrObjectUrl = '', destQrPrevFocus = null;
  // Fetch a server-rendered QR (the `qrcode` package — no third-party service, no
  // client bundle; gated by the same /app auth) and show it for any URL.
  async function showQrOverlay(url, label) {
    if (!url) return;
    try {
      var r = await fetch('/app/qr?data=' + encodeURIComponent(url), { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('qr ' + r.status);
      var svg = await r.text();
      if (destQrObjectUrl) URL.revokeObjectURL(destQrObjectUrl);
      destQrObjectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      $('destqr-img').src = destQrObjectUrl;
      $('destqr-name').textContent = label || '';
      destQrPrevFocus = document.activeElement;
      $('destqr-overlay').classList.remove('hidden'); $('destqr-close').focus();
    } catch (_) { toast(t('qrFail'), 'err'); }
  }
  function showDestQr() {
    if (!currentDest) return;
    showQrOverlay(currentDestUrl(), currentDest.name || ('…' + currentDest.token.slice(-8)));
  }
  // Share the app URL itself (to install it on another device), via the OS sheet.
  async function shareApp() {
    if (!navigator.share) return;
    try { await navigator.share({ title: 'Direct-Xfer', text: t('appShareText'), url: location.origin + '/app/' }); } catch (_) {}
  }
  // Display density: adds data-density on <html>; CSS trims spacing when compact.
  function applyDensity(v) {
    v = v === 'compact' ? 'compact' : 'normal';
    document.documentElement.setAttribute('data-density', v);
    try { localStorage.setItem('dx-pwa-density', v); } catch (_) {}
  }
  function closeDestQr() {
    $('destqr-overlay').classList.add('hidden');
    if (destQrObjectUrl) { URL.revokeObjectURL(destQrObjectUrl); destQrObjectUrl = ''; }
    $('destqr-img').removeAttribute('src');
    if (destQrPrevFocus && destQrPrevFocus.focus) destQrPrevFocus.focus(); destQrPrevFocus = null;
  }

  // Short completion chime via WebAudio (no asset to bundle or cache). A higher,
  // two-note tone for success; a lower single note for a batch with failures.
  var audioCtx = null;
  function playBeep(err) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var now = audioCtx.currentTime;
      var notes = err ? [330] : [660, 880];
      notes.forEach(function (freq, i) {
        var osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        var start = now + i * 0.14;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(start); osc.stop(start + 0.14);
      });
    } catch (_) {}
  }
  // Keep-awake toggle: the wakeLock already guards uploads; this simply lets the
  // user hold it for the whole session (screen stays on while the app is open).
  function applyKeepAwake() {
    if ($('keep-awake') && $('keep-awake').checked) acquireWake();
    else if (!sending) releaseWake();
  }

  // Copy a compact diagnostic (build, environment, last upload failure) so a user
  // can paste it to support without opening dev tools on a phone.
  function copyDiagnostic() {
    var lines = ['Direct-Xfer PWA', 'build: ' + APP_BUILD, 'ua: ' + (navigator.userAgent || '-'), 'online: ' + navigator.onLine];
    if (lastDiag) {
      lines.push('last error: ' + (lastDiag.badge || '') + (lastDiag.hint ? ' — ' + lastDiag.hint : ''));
      if (lastDiag.name) lines.push('file: ' + lastDiag.name);
      lines.push('at: ' + fmtDate(lastDiag.at));
    } else {
      lines.push('last error: ' + t('diagNone'));
    }
    copyText(lines.join('\n')).then(function () { toast(t('diagCopied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); });
    $('diag-status').textContent = lastDiag ? (lastDiag.badge || '') + (lastDiag.name ? ' · ' + lastDiag.name : '') : t('diagNone');
  }

  // Manual update check (feature: "Check for an update"). Calls reg.update() and
  // adopts a waiting worker if one appears.
  async function checkForUpdate() {
    var btn = $('check-update-btn'); if (!btn) return;
    var prev = btn.textContent; btn.disabled = true; btn.textContent = t('checkingUpdate');
    try {
      if (swReg && swReg.update) await swReg.update();
      var waiting = swReg && (swReg.waiting || swReg.installing);
      if (waiting || waitingWorker) { toast(t('updateFound'), 'ok'); applyUpdate(waitingWorker || (swReg && swReg.waiting)); }
      else { toast(t('updateNone'), 'ok'); }
    } catch (_) { toast(t('updateNone'), 'warn'); }
    finally { btn.disabled = false; btn.textContent = prev; }
  }

  // Help / keyboard shortcuts overlay.
  var helpPrevFocus = null;
  function openHelp() { helpPrevFocus = document.activeElement; $('help-overlay').classList.remove('hidden'); $('help-close').focus(); }
  function closeHelp() { $('help-overlay').classList.add('hidden'); if (helpPrevFocus && helpPrevFocus.focus) helpPrevFocus.focus(); helpPrevFocus = null; }

  // --- Live inbox events (SSE) + owner-scoped Web Push -----------------------
  var liveES = null;
  function onLiveEvent(d) {
    if (!d) return;
    if (d.type === 'image-first-view') {
      toast(t('imgFirstViewToast', { name: d.name || '' }), 'ok');
      refreshImageStats(true);
      haptic('success');
      return;
    }
    if (d.type !== 'received') return;
    toast(t('liveReceived', { name: d.name || '', dest: d.dest || '' }), 'ok');
    if (navigator.vibrate && (!$('vibrate-finish') || $('vibrate-finish').checked)) { try { navigator.vibrate(20); } catch (_) {} }
  }
  function connectLive() {
    if (liveES || !window.EventSource || !($('live-enable') && $('live-enable').checked)) return;
    try {
      liveES = new EventSource('/app/events', { withCredentials: true });
      liveES.onmessage = function (e) { try { onLiveEvent(JSON.parse(e.data)); } catch (_) {} };
      // The browser auto-reconnects on transient errors; nothing to do here.
    } catch (_) { liveES = null; }
  }
  function disconnectLive() { if (liveES) { try { liveES.close(); } catch (_) {} liveES = null; } }
  function urlB64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function enablePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
      var reg = swReg || await navigator.serviceWorker.ready;
      var vp = await fetch('/app/push/vapid', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
      if (!vp || !vp.publicKey) return false;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vp.publicKey) });
      var r = await appMutate('/app/push/subscribe', 'application/json', JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }));
      return r.ok;
    } catch (_) { return false; }
  }
  async function disablePush() {
    try {
      var reg = swReg || await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (sub) { var ep = sub.endpoint; await sub.unsubscribe().catch(function () {}); await appMutate('/app/push/unsubscribe', 'application/json', JSON.stringify({ endpoint: ep })).catch(function () {}); }
    } catch (_) {}
  }

  // --- ZIP bundling (store-only, no compression) -----------------------------
  var crcTable = (function () { var tb = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); tb[n] = c >>> 0; } return tb; })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function u16(n) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }
  function u32(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
  function concatU8(parts) {
    var len = parts.reduce(function (s, p) { return s + p.length; }, 0), out = new Uint8Array(len), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }
  function buildZip(entries) {
    var enc = new TextEncoder(), locals = [], central = [], offset = 0;
    entries.forEach(function (e) {
      var nameBytes = enc.encode(e.name), data = e.data, crc = crc32(data);
      var lh = concatU8([
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data
      ]);
      locals.push(lh);
      central.push(concatU8([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes
      ]));
      offset += lh.length;
    });
    var cd = concatU8(central);
    var eocd = concatU8([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
    return new Blob(locals.concat([cd, eocd]), { type: 'application/zip' });
  }
  async function zipSelected() {
    var pool = selectedItems().length ? selectedItems() : items.filter(function (it) { return it.state !== 'removed' && it.state !== 'done' && !it.snapshot; });
    var targets = pool.filter(function (it) { return it.file; });
    if (targets.length < 2) { toast(t('zipNeedTwo'), 'warn'); return; }
    toast(t('zipping'));
    try {
      var entries = [], used = Object.create(null);
      for (var i = 0; i < targets.length; i++) {
        var buf = new Uint8Array(await targets[i].file.arrayBuffer());
        var nm = safeName(targets[i].name || targets[i].file.name || ('file-' + (i + 1))), k = 1, base = nm;
        while (used[nm]) nm = (k++) + '_' + base;
        used[nm] = true;
        entries.push({ name: nm, data: buf });
      }
      var blob = buildZip(entries);
      var file = namedFile(blob, 'archive-' + new Date().toISOString().slice(0, 10) + '.zip', 'application/zip', Date.now());
      for (var j = 0; j < targets.length; j++) await removeItem(targets[j]);
      selectedIds.clear();
      await addFiles([file]);
      toast(t('zipDone'), 'ok');
    } catch (e) { console.error(e); toast(t('error'), 'err'); }
  }

  // --- Voice note recorder ---------------------------------------------------
  var mediaRecorder = null, recChunks = [], recStream = null, recTimer = null, recStart = 0, recBlob = null, voicePrevFocus = null;
  function stopRecStream() { if (recStream) { recStream.getTracks().forEach(function (tr) { tr.stop(); }); recStream = null; } }
  function openVoice() {
    voicePrevFocus = document.activeElement; recBlob = null;
    var pv = $('voice-preview'); pv.classList.add('hidden'); pv.removeAttribute('src');
    $('voice-add-btn').classList.add('hidden'); $('voice-record-btn').classList.remove('hidden'); $('voice-record-btn').textContent = t('recording');
    $('voice-timer').textContent = '00:00'; $('voice-timer').classList.remove('rec'); $('voice-note-err').classList.add('hidden');
    $('voice-overlay').classList.remove('hidden'); $('voice-record-btn').focus();
  }
  function closeVoice() {
    try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch (_) {}
    clearInterval(recTimer); stopRecStream();
    $('voice-overlay').classList.add('hidden');
    if (voicePrevFocus && voicePrevFocus.focus) voicePrevFocus.focus(); voicePrevFocus = null;
  }
  async function toggleRec() {
    if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { $('voice-note-err').textContent = t('recMicFail'); $('voice-note-err').classList.remove('hidden'); return; }
    try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { $('voice-note-err').textContent = t('recMicFail'); $('voice-note-err').classList.remove('hidden'); return; }
    recChunks = []; recBlob = null;
    var mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    try { mediaRecorder = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream); } catch (_) { mediaRecorder = new MediaRecorder(recStream); }
    mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = function () {
      recBlob = new Blob(recChunks, { type: (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm' });
      clearInterval(recTimer); stopRecStream(); $('voice-timer').classList.remove('rec');
      var pv = $('voice-preview'); pv.src = URL.createObjectURL(recBlob); pv.classList.remove('hidden');
      $('voice-record-btn').classList.add('hidden'); $('voice-add-btn').classList.remove('hidden');
    };
    mediaRecorder.start(); recStart = Date.now();
    $('voice-timer').classList.add('rec'); $('voice-record-btn').textContent = t('recStop');
    recTimer = setInterval(function () {
      var s = Math.floor((Date.now() - recStart) / 1000);
      $('voice-timer').textContent = ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2);
    }, 250);
  }
  function addVoiceNote() {
    if (!recBlob) return;
    var ext = /mp4|m4a|aac/.test(recBlob.type || '') ? 'm4a' : 'webm';
    var name = 'note-vocale-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.' + ext;
    var file = namedFile(recBlob, name, recBlob.type || 'audio/webm', Date.now());
    closeVoice(); addFiles([file]);
  }

  // --- Image annotation + local smart privacy blur -----------------------------
  // Face detection uses Android/Chromium's local Shape Detection API when it is
  // available. Plate detection is a conservative, fully local edge/contrast
  // heuristic. Every detected area is shown in the same review canvas, where the
  // user can undo it or add manual zones before any byte is uploaded.
  var annItem = null, annCanvas = null, annCtx = null, annTool = 'pen', annUndoStack = [], annDrawing = false, annStart = null, annPrevFocus = null;
  var annResolve = null, annSourceFile = null, annSmartMode = false, annBusy = false;
  async function loadAnnotateCanvas(file) {
    var img = await loadImage(file);
    annCanvas = $('annotate-canvas'); annCtx = annCanvas.getContext('2d', { alpha: false });
    var w = img.width, h = img.height, scale = Math.min(1, 1800 / Math.max(w, h));
    annCanvas.width = Math.max(1, Math.round(w * scale)); annCanvas.height = Math.max(1, Math.round(h * scale));
    annCtx.drawImage(img, 0, 0, annCanvas.width, annCanvas.height);
    if (img.close) img.close();
    annUndoStack = []; pushAnnUndo(); setAnnTool('blur');
  }
  function setAnnStatus(text, kind) {
    var el = $('ann-detect-status'); if (!el) return;
    el.textContent = text || ''; el.className = 'muted sm ann-detect-status' + (kind ? ' ' + kind : '');
  }
  function setAnnBusy(busy) {
    annBusy = !!busy;
    var overlay = $('annotate-overlay'); if (overlay) overlay.querySelector('.annotate-dialog').classList.toggle('detecting', annBusy);
    ['ann-detect-faces','ann-detect-plates','ann-apply','ann-cancel'].forEach(function (id) { if ($(id)) $(id).disabled = annBusy; });
  }
  async function openAnnotate(it) {
    if (!it.file) return;
    try { await loadAnnotateCanvas(it.file); } catch (_) { toast(t('optimizeFallback'), 'warn'); return; }
    annItem = it; annSourceFile = it.file; annResolve = null; annSmartMode = false;
    if ($('ann-cancel')) $('ann-cancel').textContent = t('cancel');
    setAnnStatus(''); annPrevFocus = document.activeElement; $('annotate-overlay').classList.remove('hidden');
  }
  async function openSmartBlurReview(file, mode) {
    if (!file || !mode || mode === 'off') return file;
    try { await loadAnnotateCanvas(file); } catch (_) { toast(t('optimizeFallback'), 'warn'); return file; }
    annItem = null; annSourceFile = file; annSmartMode = true;
    if ($('ann-cancel')) $('ann-cancel').textContent = t('imgSmartBlurSkip');
    annPrevFocus = document.activeElement; $('annotate-overlay').classList.remove('hidden');
    setAnnStatus(t('imgSmartBlurAnalyzing'));
    return new Promise(function (resolve) {
      annResolve = resolve;
      setTimeout(async function () {
        var n = 0;
        try {
          setAnnBusy(true);
          if (mode === 'faces' || mode === 'faces-plates') n += await detectAndBlurFaces(false);
          if (mode === 'faces-plates') n += await detectAndBlurPlates(false);
          if (n) pushAnnUndo();
          setAnnStatus(n ? t('imgSmartBlurReady', { n: n }) : (('FaceDetector' in window) ? t('imgSmartBlurReady', { n: 0 }) : t('imgSmartBlurUnsupported')), n ? 'ok' : 'warn');
        } catch (_) { setAnnStatus(t('imgSmartBlurUnsupported'), 'warn'); }
        finally { setAnnBusy(false); }
      }, 30);
    });
  }
  function pushAnnUndo() { try { annUndoStack.push(annCtx.getImageData(0, 0, annCanvas.width, annCanvas.height)); if (annUndoStack.length > 15) annUndoStack.shift(); } catch (_) {} }
  function annUndo() { if (annUndoStack.length > 1) { annUndoStack.pop(); annCtx.putImageData(annUndoStack[annUndoStack.length - 1], 0, 0); setAnnStatus(''); } }
  function annClear() { if (annUndoStack.length) { annCtx.putImageData(annUndoStack[0], 0, 0); annUndoStack = [annUndoStack[0]]; setAnnStatus(''); } }
  function cropAnnotate(ratio) {
    if (!annCanvas || !annCtx || !ratio) return;
    var sw = annCanvas.width, sh = annCanvas.height, tw = sw, th = Math.round(sw / ratio);
    if (th > sh) { th = sh; tw = Math.round(sh * ratio); }
    var sx = Math.max(0, Math.round((sw - tw) / 2)), sy = Math.max(0, Math.round((sh - th) / 2));
    var tmp = document.createElement('canvas'); tmp.width = tw; tmp.height = th;
    tmp.getContext('2d').drawImage(annCanvas, sx, sy, tw, th, 0, 0, tw, th);
    annCanvas.width = tw; annCanvas.height = th; annCtx = annCanvas.getContext('2d', { alpha: false });
    annCtx.drawImage(tmp, 0, 0); annUndoStack = []; pushAnnUndo();
  }
  function setAnnTool(tool) { annTool = tool; if ($('ann-pen')) $('ann-pen').classList.toggle('is-active', tool === 'pen'); if ($('ann-blur')) $('ann-blur').classList.toggle('is-active', tool === 'blur'); }
  function annPos(e) {
    var r = annCanvas.getBoundingClientRect();
    var touch = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
    var cx = touch.clientX - r.left, cy = touch.clientY - r.top;
    return { x: cx * (annCanvas.width / r.width), y: cy * (annCanvas.height / r.height) };
  }
  function annDown(e) {
    if (annBusy) return; e.preventDefault(); annDrawing = true; annStart = annPos(e);
    if (annTool === 'pen') { annCtx.strokeStyle = '#ff3b5c'; annCtx.lineWidth = Math.max(3, annCanvas.width / 180); annCtx.lineCap = 'round'; annCtx.lineJoin = 'round'; annCtx.beginPath(); annCtx.moveTo(annStart.x, annStart.y); }
  }
  function annMove(e) { if (!annDrawing) return; e.preventDefault(); var p = annPos(e); if (annTool === 'pen') { annCtx.lineTo(p.x, p.y); annCtx.stroke(); } }
  function annUp(e) {
    if (!annDrawing) return; annDrawing = false;
    if (annTool === 'blur') { var p = annPos(e); pixelateRect(annStart, p); }
    pushAnnUndo();
  }
  function pixelateRect(a, b) {
    var x = Math.max(0, Math.min(a.x, b.x)), y = Math.max(0, Math.min(a.y, b.y));
    var w = Math.min(annCanvas.width - x, Math.abs(a.x - b.x)), h = Math.min(annCanvas.height - y, Math.abs(a.y - b.y));
    if (w < 4 || h < 4) return;
    var tmp = document.createElement('canvas'), pw = Math.max(1, Math.round(w / 18)), ph = Math.max(1, Math.round(h / 18));
    tmp.width = pw; tmp.height = ph;
    tmp.getContext('2d').drawImage(annCanvas, x, y, w, h, 0, 0, pw, ph);
    annCtx.save(); annCtx.imageSmoothingEnabled = false; annCtx.drawImage(tmp, 0, 0, pw, ph, x, y, w, h); annCtx.restore();
  }
  function blurBoxes(boxes) {
    boxes.forEach(function (box) {
      var padX = Math.max(4, box.width * .12), padY = Math.max(4, box.height * .16);
      pixelateRect({ x: box.x - padX, y: box.y - padY }, { x: box.x + box.width + padX, y: box.y + box.height + padY });
    });
  }
  async function detectAndBlurFaces(pushUndo) {
    if (!annCanvas || !('FaceDetector' in window)) { setAnnStatus(t('imgSmartBlurUnsupported'), 'warn'); return 0; }
    setAnnBusy(true); setAnnStatus(t('imgSmartBlurAnalyzing'));
    try {
      var detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 40 });
      var faces = await detector.detect(annCanvas);
      var boxes = faces.map(function (f) { var b = f.boundingBox; return { x: b.x, y: b.y, width: b.width, height: b.height }; }).filter(function (b) { return b.width > 5 && b.height > 5; });
      blurBoxes(boxes); if (boxes.length && pushUndo !== false) pushAnnUndo();
      setAnnStatus(t('imgSmartBlurReady', { n: boxes.length }), boxes.length ? 'ok' : 'warn'); return boxes.length;
    } catch (_) { setAnnStatus(t('imgSmartBlurUnsupported'), 'warn'); return 0; }
    finally { setAnnBusy(false); }
  }
  function rectIou(a, b) {
    var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
    var inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1); return inter / Math.max(1, a.width * a.height + b.width * b.height - inter);
  }
  function plateCandidates(canvas) {
    var scale = Math.min(1, 640 / Math.max(canvas.width, canvas.height));
    var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(canvas.width * scale)); c.height = Math.max(1, Math.round(canvas.height * scale));
    var cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(canvas, 0, 0, c.width, c.height);
    var data = cx.getImageData(0, 0, c.width, c.height).data, w = c.width, h = c.height, stride = w + 1;
    var gray = new Uint8Array(w * h), edgeIntegral = new Float64Array(stride * (h + 1)), brightIntegral = new Float64Array(stride * (h + 1)), sqIntegral = new Float64Array(stride * (h + 1));
    for (var i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    for (var y = 1; y <= h; y++) {
      var er = 0, br = 0, sr = 0;
      for (var x = 1; x <= w; x++) {
        var idx = (y - 1) * w + (x - 1), g = gray[idx];
        var gx = x > 1 && x < w ? Math.abs(gray[idx + 1] - gray[idx - 1]) : 0;
        var gy = y > 1 && y < h ? Math.abs(gray[idx + w] - gray[idx - w]) : 0;
        er += gx + gy; br += g; sr += g * g;
        var out = y * stride + x, up = (y - 1) * stride + x;
        edgeIntegral[out] = edgeIntegral[up] + er; brightIntegral[out] = brightIntegral[up] + br; sqIntegral[out] = sqIntegral[up] + sr;
      }
    }
    function sum(integral, x, y, ww, hh) { var x2 = x + ww, y2 = y + hh; return integral[y2 * stride + x2] - integral[y * stride + x2] - integral[y2 * stride + x] + integral[y * stride + x]; }
    var candidates = [], widths = [Math.round(w * .16), Math.round(w * .23), Math.round(w * .31)].filter(function (v, i, a) { return v >= 50 && a.indexOf(v) === i; });
    widths.forEach(function (ww) {
      var hh = Math.max(16, Math.round(ww / 3.5)), sx = Math.max(8, Math.round(ww / 5)), sy = Math.max(6, Math.round(hh / 3));
      for (var yy = Math.round(h * .12); yy + hh < h; yy += sy) for (var xx = 0; xx + ww < w; xx += sx) {
        var area = ww * hh, mean = sum(brightIntegral, xx, yy, ww, hh) / area;
        var variance = Math.max(0, sum(sqIntegral, xx, yy, ww, hh) / area - mean * mean), contrast = Math.sqrt(variance);
        var edge = sum(edgeIntegral, xx, yy, ww, hh) / area;
        if (edge < 23 || contrast < 28 || mean < 45 || mean > 235) continue;
        var score = edge + contrast * .65 + (mean > 105 && mean < 225 ? 8 : 0);
        candidates.push({ x: xx / scale, y: yy / scale, width: ww / scale, height: hh / scale, score: score });
      }
    });
    candidates.sort(function (a, b) { return b.score - a.score; });
    var picked = [];
    for (var k = 0; k < candidates.length && picked.length < 4; k++) if (candidates[k].score >= 48 && !picked.some(function (p) { return rectIou(p, candidates[k]) > .25; })) picked.push(candidates[k]);
    return picked;
  }
  async function detectAndBlurPlates(pushUndo) {
    if (!annCanvas) return 0; setAnnBusy(true); setAnnStatus(t('imgSmartBlurAnalyzing'));
    try { var boxes = plateCandidates(annCanvas); blurBoxes(boxes); if (boxes.length && pushUndo !== false) pushAnnUndo(); setAnnStatus(t('imgSmartBlurReady', { n: boxes.length }), boxes.length ? 'ok' : 'warn'); return boxes.length; }
    catch (_) { setAnnStatus(t('imgSmartBlurReady', { n: 0 }), 'warn'); return 0; }
    finally { setAnnBusy(false); }
  }
  function finishAnnotate(result) {
    $('annotate-overlay').classList.add('hidden'); setAnnStatus(''); setAnnBusy(false);
    var resolve = annResolve; annResolve = null; annSmartMode = false; annItem = null; annCanvas = null; annCtx = null;
    if ($('ann-cancel')) $('ann-cancel').textContent = t('cancel');
    if (annPrevFocus && annPrevFocus.focus) annPrevFocus.focus(); annPrevFocus = null;
    if (resolve) resolve(result || annSourceFile); annSourceFile = null;
  }
  function closeAnnotate() { if (annResolve) return finishAnnotate(annSourceFile); $('annotate-overlay').classList.add('hidden'); annItem = null; annSourceFile = null; if (annPrevFocus && annPrevFocus.focus) annPrevFocus.focus(); annPrevFocus = null; }
  async function applyAnnotate() {
    if (!annCanvas) return closeAnnotate();
    var source = annSourceFile || (annItem && annItem.file), sourceType = source && source.type || 'image/jpeg';
    var outType = sourceType === 'image/png' ? 'image/png' : sourceType === 'image/webp' ? 'image/webp' : 'image/jpeg';
    try {
      var blob = await new Promise(function (res, rej) { annCanvas.toBlob(function (b) { b ? res(b) : rej(new Error('encode')); }, outType, outType === 'image/jpeg' ? .92 : .94); });
      var ext = outType === 'image/png' ? '.png' : outType === 'image/webp' ? '.webp' : '.jpg';
      var originalName = source && source.name || (annItem && annItem.name) || ('image-' + Date.now());
      var newName = originalName.replace(/\.[^.\/]+$/, '') + ext;
      var file = namedFile(blob, newName, outType, Date.now());
      if (annResolve) return finishAnnotate(file);
      if (annItem) {
        annItem.name = newName;
        await replaceItemSourceDurably(annItem, file);
        renderQueue(); updateSendBtn();
      }
    } catch (_) { toast(t('error'), 'err'); }
    closeAnnotate();
  }

  // --- Send one batch to several destinations (fan-out) ----------------------
  var multiPrevFocus = null;
  function openMultiSend() {
    var waiting = items.filter(function (it) { return ['waiting', 'error', 'paused', 'waiting-network'].indexOf(it.state) !== -1 && !it.snapshot; });
    if (!waiting.length) { toast(t('noPending'), 'warn'); return; }
    if (!allDests().length) { toast(t('addLinkHint'), 'warn'); return; }
    var list = $('multisend-list'); list.innerHTML = '';
    allDests().forEach(function (d) {
      var row = document.createElement('label'); row.className = 'multisend-row';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = d.token; cb.checked = !!(currentDest && d.token === currentDest.token);
      var span = document.createElement('span'); var dot = destDot(destStatusCache[d.token]);
      span.textContent = (dot ? dot + ' ' : '') + (d.name || ('…' + d.token.slice(-8)));
      row.appendChild(cb); row.appendChild(span); list.appendChild(row);
    });
    multiPrevFocus = document.activeElement; $('multisend-overlay').classList.remove('hidden'); $('multisend-go').focus();
  }
  function closeMultiSend() { $('multisend-overlay').classList.add('hidden'); if (multiPrevFocus && multiPrevFocus.focus) multiPrevFocus.focus(); multiPrevFocus = null; }
  async function runMultiSend() {
    var tokens = Array.prototype.map.call($('multisend-list').querySelectorAll('input:checked'), function (cb) { return cb.value; });
    closeMultiSend();
    var originals = items.filter(function (it) { return ['waiting', 'error', 'paused', 'waiting-network'].indexOf(it.state) !== -1 && !it.snapshot; });
    if (!tokens.length || !originals.length) { toast(t('multiSendNone'), 'warn'); return; }
    var note = $('batch-note') ? String($('batch-note').value || '').trim().slice(0, 120) : '';
    var clones = [], prepared = 0;
    for (var ti = 0; ti < tokens.length; ti++) {
      var d = findDest(tokens[ti]); if (!d) continue;
      var res = await validateDest(d);
      destStatusCache[d.token] = res.status;
      // Skip anything needing a per-destination secret or a sender name — those
      // cannot be fanned out safely without prompting for each.
      if (res.status !== 'ok' || (res.config && (res.config.enc || res.config.groupBySender))) continue;
      var snap = { token: d.token, name: d.name || ('…' + d.token.slice(-8)), sender: '', enc: null, key: '', passphrase: '', expire: expireSeconds(), createdAt: Date.now() };
      originals.forEach(function (src) {
        var clone = makeItem({ file: src.file, name: src.name, originalName: src.originalName, type: src.type, size: src.size, lastModified: src.lastModified, state: 'waiting', volatile: src.volatile });
        clone.snapshot = snap; clone.note = note || src.note || '';
        items.push(clone); clones.push(clone);
        if (!clone.volatile) persistItem(clone, false);
      });
      prepared++;
    }
    renderDests();
    if (!clones.length) { toast(t('multiSendNone'), 'warn'); return; }
    // Replace the (snapshot-less) template items with the per-destination clones.
    originals.forEach(function (o) { o.state = 'removed'; removePersistedItem(o); selectedIds.delete(o.id); });
    items = items.filter(function (it) { return it.state !== 'removed'; });
    renderQueue(); updateSendBtn();
    toast(t('multiSendQueued', { n: prepared }), 'ok');
    if (!sending) startBatch(clones);
  }

  // --- Command palette (Ctrl/Cmd+K) ------------------------------------------
  var cmdPrevFocus = null, cmdItems = [], cmdActiveIdx = 0;
  function buildCommands() {
    return [
      { ico: '📤', label: t('send'), run: function () { if (!$('send-btn').disabled) startBatch(); } },
      { ico: '📄', label: t('chooseFiles'), run: function () { $('pick-files').click(); } },
      { ico: '📁', label: t('chooseFolder'), run: function () { $('pick-folder').click(); } },
      { ico: '📷', label: t('takePhoto'), run: function () { $('pick-camera').click(); } },
      { ico: '🎙', label: t('voiceNote'), run: openVoice },
      { ico: '🗜', label: t('zipBundle').replace(/^🗜\s*/, ''), run: zipSelected },
      { ico: '📢', label: t('multiSend').replace(/^📢\s*/, ''), run: openMultiSend },
      { ico: '🆕', label: t('createLinkTitle'), run: function () { if (!destinationLocked) openCreateForm(); } },
      { ico: '📋', label: t('pasteLink'), run: pasteDestination },
      { ico: '✎', label: t('editDestination'), run: function () { if (!destinationLocked && $('dest-select').value) openDestForm($('dest-select').value); } },
      { ico: '📷', label: t('scanQr').replace(/^📷\s*/, ''), run: startScan },
      { ico: '⚙️', label: t('cmdOpenSettings'), run: function () { var s = $('settings-card'); if (s) { s.open = true; s.scrollIntoView({ block: 'start' }); } } },
      { ico: '🕘', label: t('cmdOpenHistory'), run: function () { var s = $('history-card'); if (s) { s.open = true; s.scrollIntoView({ block: 'start' }); } } },
      { ico: '🎨', label: t('cmdToggleTheme'), run: function () { var el = $('theme-select'), order = ['dark', 'light', 'auto', 'schedule'], i = order.indexOf(el.value); el.value = order[(i + 1) % order.length]; el.dispatchEvent(new Event('change')); } },
      { ico: '❓', label: t('shortcutsTitle'), run: openHelp }
    ];
  }
  function openCmd() { cmdPrevFocus = document.activeElement; $('cmd-input').value = ''; renderCmd(''); $('cmd-overlay').classList.remove('hidden'); $('cmd-input').focus(); }
  function closeCmd() { $('cmd-overlay').classList.add('hidden'); if (cmdPrevFocus && cmdPrevFocus.focus) cmdPrevFocus.focus(); cmdPrevFocus = null; }
  function renderCmd(q) {
    q = (q || '').toLowerCase();
    cmdItems = buildCommands().filter(function (c) { return !q || c.label.toLowerCase().indexOf(q) !== -1; });
    cmdActiveIdx = 0;
    var list = $('cmd-list'); list.innerHTML = '';
    if (!cmdItems.length) { var e = document.createElement('div'); e.className = 'cmd-empty'; e.textContent = t('cmdNoMatch'); list.appendChild(e); return; }
    cmdItems.forEach(function (c, idx) {
      var row = document.createElement('div'); row.className = 'cmd-item' + (idx === 0 ? ' active' : ''); row.dataset.idx = idx;
      var ic = document.createElement('span'); ic.className = 'cmd-ico'; ic.textContent = c.ico;
      var lb = document.createElement('span'); lb.textContent = c.label;
      row.appendChild(ic); row.appendChild(lb);
      row.addEventListener('click', function () { runCmd(idx); });
      list.appendChild(row);
    });
  }
  function highlightCmd() {
    var rows = $('cmd-list').querySelectorAll('.cmd-item');
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('active', i === cmdActiveIdx);
    if (rows[cmdActiveIdx]) rows[cmdActiveIdx].scrollIntoView({ block: 'nearest' });
  }
  function runCmd(idx) {
    var c = cmdItems[idx != null ? idx : cmdActiveIdx];
    closeCmd();
    if (c && c.run) c.run(); // synchronous so user-gesture-only actions (file picker) still work
  }

  // Storage + settings -------------------------------------------------------
  async function updateStorageStatus() {
    var bar = $('storage-bar');
    if (!navigator.storage || !navigator.storage.estimate) { $('storage-status').textContent = t('storageUnknown'); if (bar) bar.classList.add('hidden'); return; }
    try {
      var est = await navigator.storage.estimate();
      $('storage-status').textContent = t('storageUsage', { used: fmtBytes(est.usage || 0), quota: fmtBytes(est.quota || 0) });
      var ratio = est.quota ? Math.round((est.usage || 0) / est.quota * 100) : 0;
      var threshold = Number($('storage-warning-threshold') && $('storage-warning-threshold').value) || 80;
      var warning = $('storage-warning');
      if (warning) { warning.textContent = t('storageWarning', { percent: ratio }); warning.classList.toggle('hidden', !est.quota || ratio < threshold); }
      if (bar && est.quota) { bar.max = est.quota; bar.value = Math.min(est.quota, est.usage || 0); bar.classList.remove('hidden'); bar.classList.toggle('warn', ratio >= threshold); }
      else if (bar) bar.classList.add('hidden');
    } catch (_) { $('storage-status').textContent = t('storageUnknown'); if (bar) bar.classList.add('hidden'); }
  }
  async function requestPersistentStorage() {
    try {
      var ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
      toast(ok ? t('storageProtected') : t('storageDenied'), ok ? 'ok' : 'warn'); updateStorageStatus();
    } catch (_) { toast(t('storageDenied'), 'warn'); }
  }
  async function purgeDirectXferCaches() {
    if (typeof caches === 'undefined') return;
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'PURGE_PRIVATE_DATA' });
      }
      var names = await caches.keys();
      await Promise.all(names.map(async function (name) {
        if (name.indexOf('dx-share-') === 0 || name.indexOf('dx-pwa-runtime-') === 0) return caches.delete(name);
        if (name.indexOf('dx-pwa-shell-') === 0) {
          var cache = await caches.open(name);
          return cache.delete('/app/');
        }
        return false;
      }));
    } catch (_) {}
  }
  async function clearLocalDataInternal(showToast) {
    var oldItems = items.slice();
    oldItems.forEach(function (it) { it.state = 'removed'; if (it.xhr) { try { it.xhr.abort(); } catch (_) {} } });
    activeXhrs.forEach(function (xhr) { try { xhr.abort(); } catch (_) {} });
    await Promise.all(oldItems.map(cancelPartial)).catch(function () {});
    sending = false; paused = false;
    var resume = resumeWaiters.splice(0); resume.forEach(function (resolve) { resolve(); });
    await Promise.all([idbClear(QUEUE_STORE), idbClear(DEST_STORE), idbClear(META_STORE), idbClear(HISTORY_STORE), idbClear(IMAGE_STORE), purgeDirectXferCaches(), purgeOpfsQueue()]).catch(function () {});
    persistentDests = []; sessionDests = []; serverReceptions = []; persistSessionDests(); items = []; historyEntries = [];
    sessionFiles = 0; sessionBytes = 0; lifetimeFiles = 0; lifetimeBytes = 0; imageLinkUrls = []; imageRowsByToken.clear(); imageRecordsByToken.clear(); selectedImageTokens.clear(); imageActionHistory = []; tagColorMap = {}; pinnedAlbumTokens.clear(); lastDiag = null; avgRate = 0; historyFilter = '';
    lastBatchRecord = null; lastBatchSummary = null; privacyNames = false; document.body.classList.remove('privacy-names');
    destStatusCache = Object.create(null); selectedIds.clear();
    queueFilter = ''; quotaWarned = new Set();
    if ($('history-search')) $('history-search').value = '';
    if ($('queue-search')) $('queue-search').value = '';
    try { ['dx_sender', 'dx-pwa-sender-by-destination', 'dx-pwa-senders', 'dx-pwa-sort', 'dx-pwa-auto-resume', 'dx-pwa-concurrency', 'dx-pwa-avg-rate', 'dx-pwa-vibrate', 'dx-pwa-keepawake', 'dx-pwa-last-dest', 'dx-pwa-confirm-mobile', 'dx-pwa-privacy-names', 'dx-pwa-opt-preset', 'dx-pwa-haptic', 'dx-pwa-advanced-accordion', 'dx-pwa-confirm-revoke', 'dx-pwa-confirm-delete', 'dx-pwa-confirm-replace', 'dx-pwa-storage-warning-threshold', 'dx-pwa-tag-colors', 'dx-pwa-pinned-albums', 'dx-pwa-history-backup', 'dx-pwa-image-actions', 'dx-pwa-image-expiry-warned', IMAGE_BACKUP_KEY, DEST_BACKUP_KEY, QUEUE_BACKUP_KEY].forEach(function (k) { localStorage.removeItem(k); }); } catch (_) {}
    try { sessionStorage.removeItem('dx-active-dest'); } catch (_) {}
    buildSenderList();
    renderDests(); renderQueue(); renderHistory(); refreshDestStatus(); updateSendBtn(); updateStorageStatus(); updateSessionStats(); refreshCopyAll();
    if (showToast !== false) toast(t('localCleared'), 'ok');
  }
  async function clearLocalData() {
    if (!askConfirmation('delete', t('clearDataConfirm'))) return;
    await clearLocalDataInternal(true);
  }
  function settleWithin(promise, timeoutMs, fallbackValue) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(fallbackValue);
      }, timeoutMs);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallbackValue);
      });
    });
  }
  async function fetchWithTimeout(url, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    try {
      var requestOptions = Object.assign({}, options || {});
      if (controller) requestOptions.signal = controller.signal;
      return await fetch(url, requestOptions);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  var logoutInProgress = false;
  async function closeSession() {
    if (logoutInProgress || !confirm(t('closeSessionConfirm'))) return;
    logoutInProgress = true;
    var button = $('logout-session-btn');
    var originalLabel = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = t('closingSession');
    }
    try {
      checkpointPersistentUiState();
      var localSave = Promise.allSettled([persistHistorySnapshot(), persistImageActionHistory()].concat(
        Array.from(imageRecordsByToken.values()).map(function (photo) { return persistImageRecord(photo); })
      ));
      // IndexedDB and PushManager can occasionally remain pending on Android after
      // a service-worker update. They are best-effort cleanup tasks and must never
      // prevent the actual server-side logout.
      await settleWithin(localSave, 900, null);
      disconnectLive();
      await settleWithin(disablePush(), 700, null);
      if (!deviceInfo) await settleWithin(fetchDeviceStatus(), 1200, null);
      var response = await fetchWithTimeout('/app/session/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: true,
        headers: appMutationHeaders('application/json'),
        body: '{}'
      }, 5000);
      if (!response || !response.ok) throw new Error('logout-' + (response ? response.status : 'timeout'));
      var redirected = false;
      function goToLogin() {
        if (redirected) return;
        redirected = true;
        try { location.replace('/app/login?loggedOut=1'); }
        catch (_) { location.href = '/app/login?loggedOut=1'; }
      }
      // Once the server has destroyed the session, local cache cleanup is bounded:
      // a stuck CacheStorage promise must not leave the button grey forever.
      var redirectFallback = setTimeout(goToLogin, 1200);
      await settleWithin(purgeDirectXferCaches(), 900, null);
      clearTimeout(redirectFallback);
      goToLogin();
    } catch (_) {
      logoutInProgress = false;
      if (button) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = originalLabel || t('closeSession');
      }
      toast(t('closeSessionFailed'), 'err');
    }
  }

  // QR scanner ---------------------------------------------------------------
  var scanning = false, qrPreviousFocus = null;
  async function startScan() {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) { toast(t('scanUnsupported'), 'warn'); return; }
    var detector;
    try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (_) { toast(t('scanUnsupported'), 'warn'); return; }
    var stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
    catch (_) { toast(t('cameraUnavailable'), 'err'); return; }
    qrPreviousFocus = document.activeElement;
    var video = $('qr-video'); video.srcObject = stream; $('qr-overlay').classList.remove('hidden'); $('qr-close').focus();
    try { await video.play(); } catch (_) {}
    scanning = true;
    while (scanning) {
      try { var codes = await detector.detect(video); if (codes && codes.length) { onQr(codes[0].rawValue); break; } } catch (_) {}
      await sleep(220);
    }
  }
  function stopScan() {
    scanning = false; $('qr-overlay').classList.add('hidden');
    var video = $('qr-video'); if (video.srcObject) { video.srcObject.getTracks().forEach(function (track) { track.stop(); }); video.srcObject = null; }
    if (qrPreviousFocus && qrPreviousFocus.focus) qrPreviousFocus.focus(); qrPreviousFocus = null;
  }
  function onQr(text) {
    stopScan();
    try {
      var u = new URL(String(text || ''), location.href);
      if (u.origin === location.origin && u.pathname === '/app/device/claim' && u.searchParams.get('ticket')) { location.href = u.href; return; }
    } catch (_) {}
    if (parseDestination(text)) { openDestForm(); $('dest-url').value = text; updateRememberKeyControl(); toast(t('qrFound'), 'ok'); }
    else toast(t('qrUnknown'), 'warn');
  }

  // Service worker updates ---------------------------------------------------
  var deferredPrompt = null, waitingWorker = null, swReg = null, swRefreshing = false, swReadyForInstall = false;
  var installInfo = null, installDiagnosticTimer = null;
  function isStandaloneApp() {
    try {
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        !!navigator.standalone || document.referrer.indexOf('android-app://') === 0;
    } catch (_) { return false; }
  }
  function isIosBrowser() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/i.test(ua) || (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1);
  }
  function isInstallSecureOrigin() {
    if (window.isSecureContext && location.protocol === 'https:') return true;
    var host = String(location.hostname || '').toLowerCase();
    return !!window.isSecureContext && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
  }
  function setInstallDiagnostic(key, kind, httpsUrl) {
    var box = $('install-diagnostic'), text = $('install-diagnostic-text'), link = $('install-https-link');
    if (!box || !text || isStandaloneApp()) return;
    text.textContent = t(key);
    box.classList.remove('hidden', 'error');
    if (kind === 'error') box.classList.add('error');
    if (link) {
      if (httpsUrl) { link.href = httpsUrl; link.classList.remove('hidden'); }
      else link.classList.add('hidden');
    }
  }
  function clearInstallDiagnostic() {
    var box = $('install-diagnostic');
    if (box) box.classList.add('hidden');
  }
  async function loadInstallInfo() {
    try {
      var response = await fetch('/app/install-info', { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) installInfo = await response.json();
    } catch (_) {}
    if (isStandaloneApp()) { clearInstallDiagnostic(); return; }
    if (!isInstallSecureOrigin()) {
      setInstallDiagnostic('installHttpsRequired', 'error', installInfo && installInfo.httpsUrl);
      updateInstallButtonVisibility(true);
      return;
    }
    updateInstallButtonVisibility(false);
    clearTimeout(installDiagnosticTimer);
    installDiagnosticTimer = setTimeout(function () {
      if (!deferredPrompt && !isIosBrowser() && !isStandaloneApp()) setInstallDiagnostic('installSecurePending', 'info', '');
    }, 4500);
  }
  function updateInstallButtonVisibility(forceHidden) {
    var btn = $('install-btn');
    if (!btn) return;
    var secureOrigin = isInstallSecureOrigin();
    var iosInstallFlow = isIosBrowser() && secureOrigin;
    var nativePromptReady = !!deferredPrompt;
    // Keep the install logo visible on a secure mobile browser even while Chrome is
    // still evaluating installability. A tap then shows the pending diagnostic; as
    // soon as beforeinstallprompt arrives, the same logo opens the native WebAPK UI.
    var mobileInstallEntry = secureOrigin;
    var show = !forceHidden && !isStandaloneApp() && (nativePromptReady || iosInstallFlow || mobileInstallEntry);
    btn.classList.toggle('hidden', !show);
    btn.classList.toggle('install-pending', show && !nativePromptReady && !iosInstallFlow);
  }
  async function requestPwaInstall() {
    if (deferredPrompt) {
      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } catch (_) {}
      updateInstallButtonVisibility(false);
      return;
    }
    if (isIosBrowser() && isInstallSecureOrigin()) { alert(t('installIosHint')); return; }
    if (!isInstallSecureOrigin()) {
      setInstallDiagnostic('installHttpsRequired', 'error', installInfo && installInfo.httpsUrl);
      return;
    }
    setInstallDiagnostic('installSecurePending', 'info', '');
    alert(t('installBrowserHint'));
  }
  function showUpdate(worker) { waitingWorker = worker; $('updatebar').classList.remove('hidden'); }
  // One-time reload onto the new shell. Guarded so the several signals below can all
  // call it without reloading twice.
  function refreshToNewVersion() {
    if (swRefreshing) return; swRefreshing = true;
    try { location.reload(); } catch (_) { location.href = location.href; }
  }
  // Adopt a freshly-installed worker: SKIP_WAITING makes it take control. Normally
  // that fires `controllerchange` → reload, but on iOS standalone PWAs that event is
  // unreliable (this is the classic "I tapped Update and nothing happened"). So we
  // ALSO watch the worker reach 'activated', and keep a short fallback timer — any of
  // the three triggers the single reload.
  function applyUpdate(worker) {
    worker = worker || waitingWorker || (swReg && swReg.waiting);
    if (!worker) { refreshToNewVersion(); return; } // nothing waiting: a plain reload still re-checks
    waitingWorker = worker;
    checkpointPersistentUiState();
    try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
    try {
      if (worker.state === 'activated') return refreshToNewVersion();
      worker.addEventListener('statechange', function () { if (worker.state === 'activated') refreshToNewVersion(); });
    } catch (_) {}
    setTimeout(refreshToNewVersion, 2500); // last-resort: reload even if no event fires
  }
  function registerServiceWorker() {
    if (!navigator.serviceWorker || typeof navigator.serviceWorker.register !== 'function') return;
    navigator.serviceWorker.addEventListener('controllerchange', refreshToNewVersion);
    var registrationPromise = navigator.serviceWorker.register('/direct-xfer-pwa-sw.js?v=111', { scope: '/app/' }).then(function (reg) {
      swReg = reg;
      navigator.serviceWorker.ready.then(function () {
        swReadyForInstall = true;
        updateInstallButtonVisibility(false);
      }).catch(function () {});
      // A worker left "waiting" by a previous visit. On mobile the standalone window
      // never truly closes, so a waiting worker would otherwise stay stuck forever —
      // reinstalling the PWA doesn't clear it either. We just launched with nothing
      // uploading, so adopt it right away (an invisible reload) instead of waiting for
      // a tap on a banner phone users rarely notice. This is what makes updates land.
      if (reg.waiting) {
        // Auto-adopt at launch, but guard against a reload loop: if we already tried
        // to adopt seconds ago and the worker is STILL waiting (it failed to activate),
        // fall back to the manual banner instead of reloading again and again.
        var lastAdopt = 0; try { lastAdopt = Number(sessionStorage.getItem('dx-sw-adopt')) || 0; } catch (_) {}
        if (sending || (Date.now() - lastAdopt < 10000)) { showUpdate(reg.waiting); }
        else { try { sessionStorage.setItem('dx-sw-adopt', String(Date.now())); } catch (_) {} applyUpdate(reg.waiting); }
      }
      reg.addEventListener('updatefound', function () {
        var worker = reg.installing;
        if (!worker) return;
        // Mid-session: surface the banner rather than auto-reloading, so an update
        // that installs while the user is busy never yanks the page out from under
        // them. The next launch will auto-adopt it via the reg.waiting path above.
        worker.addEventListener('statechange', function () { if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker); });
      });
      // Standalone windows can stay open for days; poll hourly so a new shell is
      // detected (and offered/adopted) without needing a full relaunch.
      setInterval(function () { reg.update().catch(function () {}); }, 60 * 60 * 1000);
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'UPDATE_READY' && e.source) showUpdate(e.source);
    });
    return registrationPromise;
  }

  // --- Added features ---------------------------------------------------------
  // Per-file percentage helper (feature 5).
  function pctText(sent, total) { total = Number(total) || 0; return (total > 0 ? Math.min(100, Math.round((Number(sent) || 0) / total * 100)) : 0) + '%'; }

  // Theme selection is handled by the explicit dropdown in the top bar.
  function setTheme(v) {
    if (v !== 'light' && v !== 'auto' && v !== 'schedule') v = 'dark';
    var actual = v === 'schedule' ? ((new Date().getHours() >= 20 || new Date().getHours() < 7) ? 'dark' : 'light') : v;
    document.documentElement.setAttribute('data-theme', actual);
    document.documentElement.setAttribute('data-theme-mode', v);
    try { localStorage.setItem('dx-theme', v); } catch (_) {}
    if ($('theme-select')) $('theme-select').value = v;
  }

  // Copy just the raw token, not the whole URL (feature 2).
  // Pin / unpin a destination as a favourite (feature 12).
  function togglePin(token) {
    var d = findDest(token); if (!d) return;
    d.pinned = !d.pinned;
    if (d.remembered) persistDestination(d).catch(function () {}); else persistSessionDests();
    renderDests(); updatePinButton();
    toast(d.pinned ? t('pinned') : t('unpinned'), 'ok');
  }
  function updatePinButton() {
    var btn = $('dest-pin-btn'); if (!btn) return;
    var d = editingToken ? findDest(editingToken) : null;
    btn.classList.toggle('hidden', !d);
    if (d) btn.textContent = d.pinned ? t('unpinDestination') : t('pinDestination');
  }

  // Reset the batch-scoped options (note, expiry, image/optimization) in one tap (feature 1).
  function resetBatch() {
    if ($('batch-note')) $('batch-note').value = '';
    if ($('expire-select')) { $('expire-select').value = '0'; try { localStorage.setItem('dx-pwa-expire', '0'); } catch (_) {} }
    if ($('optimize-images')) { $('optimize-images').checked = false; if ($('optimize-opts')) $('optimize-opts').classList.add('hidden'); }
    if ($('optimize-preset')) { $('optimize-preset').value = 'original'; try { localStorage.setItem('dx-pwa-opt-preset', 'original'); } catch (_) {} }
    if ($('strip-exif')) { $('strip-exif').checked = false; try { localStorage.setItem('dx-pwa-stripexif', '0'); } catch (_) {} }
    if ($('img-quality')) { $('img-quality').value = '0.86'; try { localStorage.setItem('dx-pwa-img-quality', '0.86'); } catch (_) {} }
    if ($('img-maxdim')) { $('img-maxdim').value = '2560'; try { localStorage.setItem('dx-pwa-img-maxdim', '2560'); } catch (_) {} }
    if ($('concurrency-select')) { var c = isMobileLike() ? '1' : '2'; $('concurrency-select').value = c; try { localStorage.setItem('dx-pwa-concurrency', c); } catch (_) {} }
    toast(t('resetBatchDone'), 'ok');
  }

  // Pending-file counter shown in the "Add files" header (feature 6).
  function updateFilesCount() {
    var el = $('files-count'); if (!el) return;
    var pending = items.filter(function (it) { return ['waiting', 'paused', 'waiting-network', 'error', 'sending', 'encrypting', 'optimizing'].indexOf(it.state) !== -1; });
    var bytes = pending.reduce(function (s, it) { return s + (it.upSize || it.size || 0); }, 0);
    el.textContent = pending.length ? t('filesPending', { n: pending.length }) + ' · ' + fmtBytes(bytes) : '';
    el.classList.toggle('hidden', pending.length === 0);
  }

  // Master "select all / none" for the queue (feature 3).
  function toggleMasterSelect(checked) {
    sortedItems().forEach(function (it) { if (checked) selectedIds.add(it.id); else selectedIds.delete(it.id); });
    renderQueue();
  }
  function updateMasterSelect() {
    var m = $('master-select'); if (!m) return;
    var vis = sortedItems();
    var selN = vis.filter(function (it) { return selectedIds.has(it.id); }).length;
    m.checked = vis.length > 0 && selN === vis.length;
    m.indeterminate = selN > 0 && selN < vis.length;
  }

  // Turn clipboard text into a sendable .txt file (feature 7).
  async function pasteTextFile() {
    var text = '';
    try { text = await navigator.clipboard.readText(); } catch (_) { toast(t('pasteFailed'), 'warn'); return; }
    if (!text || !text.trim()) { toast(t('pasteTextEmpty'), 'warn'); return; }
    var file = namedFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), t('pastedTextName'), 'text/plain', Date.now());
    addFiles([file]);
  }

  // Fetch a remote image/file by URL and queue it, CORS permitting (feature 15).
  async function addFromUrl() {
    var url = window.prompt(t('urlPrompt'), '');
    if (url == null) return;
    url = String(url).trim(); if (!url) return;
    var u;
    try { u = new URL(url); } catch (_) { toast(t('urlInvalid'), 'warn'); return; }
    if (!/^https?:$/.test(u.protocol)) { toast(t('urlInvalid'), 'warn'); return; }
    toast(t('urlFetching'));
    try {
      var r = await fetch(u.href, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      var blob = await r.blob();
      var base = decodeURIComponent((u.pathname.split('/').pop() || '').split('?')[0]) || ('fichier-' + Date.now());
      if (!/\.[^.\/]+$/.test(base)) { var ext = (String(blob.type).split('/')[1] || '').split(';')[0]; if (ext) base += '.' + ext; }
      var file = namedFile(blob, safeName(base), blob.type || 'application/octet-stream', Date.now());
      await addFiles([file]);
      toast(t('urlAdded'), 'ok');
    } catch (_) { toast(t('urlFailed'), 'err'); }
  }

  // Bulk rename selected files with a shared prefix + auto numbering (feature 13).
  function bulkRename() {
    var targets = selectedItems();
    if (!targets.length) { toast(t('noPending'), 'warn'); return; }
    var prefix = window.prompt(t('renamePrompt'), '');
    if (prefix == null) return;
    prefix = String(prefix).trim();
    var pad = Math.max(2, String(targets.length).length);
    var renamed = 0;
    targets.forEach(function (it, i) {
      if (it.snapshot || ['sending', 'encrypting', 'optimizing', 'done'].indexOf(it.state) !== -1) return; // locked once sending
      var ext = extOf(it.name);
      var num = ('0000000000' + (i + 1)).slice(-pad);
      var base = prefix ? prefix + '-' + num : num;
      it.name = safeName(base + (ext ? '.' + ext : ''));
      invalidatePreparedPayload(it); // force a fresh prepare with the new name
      persistItem(it); renamed++;
    });
    renderQueue(); updateSendBtn();
    if (renamed) toast(t('renameDone', { n: renamed }), 'ok');
  }

  // Local preview for images, video, audio, PDF and text before sending.
  var lightboxUrl = '', lightboxPrevFocus = null;
  function resetPreviewElements() {
    ['lightbox-img', 'preview-video', 'preview-audio', 'preview-frame', 'preview-text', 'preview-generic'].forEach(function (id) {
      var el = $(id); if (!el) return; el.classList.add('hidden');
      if (id === 'lightbox-img') el.removeAttribute('src');
      else if (id === 'preview-video' || id === 'preview-audio' || id === 'preview-frame') el.removeAttribute('src');
      else el.textContent = '';
    });
  }
  async function openPreview(it) {
    var file = it && it.file;
    if (!file) return;
    closeLightbox(false);
    resetPreviewElements();
    lightboxPrevFocus = document.activeElement;
    var idx = Math.max(0, sortedItems().indexOf(it));
    $('preview-name').textContent = displayFileName(it, idx);
    var type = String(it.type || file.type || '').toLowerCase(), ext = extOf(it.name);
    try {
      if (/^text\//.test(type) || /^(txt|md|csv|tsv|log|json|xml|html|css|js)$/.test(ext)) {
        var txt = await file.slice(0, 1024 * 1024).text();
        $('preview-text').textContent = txt + (file.size > 1024 * 1024 ? '\n\n…' : '');
        $('preview-text').classList.remove('hidden');
      } else {
        lightboxUrl = URL.createObjectURL(file);
        if (/^image\//.test(type)) { $('lightbox-img').src = lightboxUrl; $('lightbox-img').classList.remove('hidden'); }
        else if (/^video\//.test(type)) { $('preview-video').src = lightboxUrl; $('preview-video').classList.remove('hidden'); }
        else if (/^audio\//.test(type)) { $('preview-audio').src = lightboxUrl; $('preview-audio').classList.remove('hidden'); }
        else if (type === 'application/pdf' || ext === 'pdf') { $('preview-frame').src = lightboxUrl; $('preview-frame').classList.remove('hidden'); }
        else { $('preview-generic').textContent = fileIcon(it.name, it.type) + '  ' + fmtBytes(file.size); $('preview-generic').classList.remove('hidden'); }
      }
    } catch (_) {
      $('preview-generic').textContent = fileIcon(it.name, it.type) + '  ' + fmtBytes(file.size);
      $('preview-generic').classList.remove('hidden');
    }
    $('lightbox-overlay').classList.remove('hidden'); $('lightbox-close').focus();
  }
  function openLightbox(file) {
    if (!file) return;
    openPreview({ file: file, name: file.name || 'image', type: file.type || 'image/*' });
  }
  // View a shared image (by remote URL) inside the PWA's own overlay instead of opening a
  // new browser tab — so the top-right ✕ (or the back button) returns to the app rather
  // than forcing the user to leave it. No object URL is created, so nothing to revoke.
  function openImageUrlPreview(url, name) {
    if (!url) return;
    closeLightbox(false);
    resetPreviewElements();
    lightboxPrevFocus = document.activeElement;
    $('preview-name').textContent = name || '';
    var img = $('lightbox-img');
    img.src = url; img.classList.remove('hidden');
    $('lightbox-overlay').classList.remove('hidden');
    $('lightbox-close').focus();
  }
  function closeLightbox(restoreFocus) {
    $('lightbox-overlay').classList.add('hidden'); resetPreviewElements();
    if (lightboxUrl) { URL.revokeObjectURL(lightboxUrl); lightboxUrl = ''; }
    if (restoreFocus !== false && lightboxPrevFocus && lightboxPrevFocus.focus) lightboxPrevFocus.focus();
    lightboxPrevFocus = null;
  }

  // SHA-256 fingerprint of a file, copied to the clipboard (feature 16).
  async function copyFileHash(it) {
    var src = it.file || it.preparedBlob;
    if (!src || !(window.crypto && crypto.subtle)) { toast(t('hashFail'), 'err'); return; }
    toast(t('hashing'));
    try {
      var buf = await src.arrayBuffer();
      var digest = await crypto.subtle.digest('SHA-256', buf);
      var hex = Array.prototype.map.call(new Uint8Array(digest), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      // Copy in `sha256sum` format ("<hash>  <name>") so it drops straight into a checksum file.
      await copyText(hex + '  ' + it.name);
      toast(t('hashCopied'), 'ok');
      if (it.meta) it.meta.textContent = 'SHA-256 ' + hex.slice(0, 16) + '…';
    } catch (_) { toast(t('hashFail'), 'err'); }
  }

  // Export / import the local app settings as JSON (feature 17).
  function collectSettingKeys() {
    var keys = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k !== IMAGE_BACKUP_KEY && (k.indexOf('dx-') === 0 || k === 'dx_sender')) keys.push(k); } } catch (_) {}
    return keys;
  }
  function exportSettings() {
    var data = { app: 'direct-xfer-pwa', build: APP_BUILD, exportedAt: Date.now(), settings: {} };
    collectSettingKeys().forEach(function (k) { try { data.settings[k] = localStorage.getItem(k); } catch (_) {} });
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'direct-xfer-reglages-' + new Date().toISOString().slice(0, 10) + '.json');
  }
  async function importSettings(file) {
    if (!file) return;
    try {
      var data = JSON.parse(await file.text());
      var settings = data && data.settings;
      if (!settings || typeof settings !== 'object') throw new Error('bad');
      Object.keys(settings).forEach(function (k) {
        if ((k.indexOf('dx-') === 0 || k === 'dx_sender') && settings[k] != null) { try { localStorage.setItem(k, String(settings[k])); } catch (_) {} }
      });
      toast(t('settingsImported'), 'ok');
      setTimeout(function () { location.reload(); }, 800); // reload so every control re-reads its value cleanly
    } catch (_) { toast(t('settingsImportFail'), 'err'); }
  }

  // Custom accent colour via a CSS variable (feature 18).
  function applyAccent(color) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return;
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent-2', color);
    try { localStorage.setItem('dx-accent', color); } catch (_) {}
    if ($('accent-color')) $('accent-color').value = color;
  }
  function resetAccent() {
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-2');
    try { localStorage.removeItem('dx-accent'); } catch (_) {}
    if ($('accent-color')) $('accent-color').value = '#3b6ef6';
  }

  // Capture a screen frame via getDisplayMedia and queue it as a PNG (feature 19).
  async function captureScreen() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { toast(t('captureFailed'), 'warn'); return; }
    var stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); }
    catch (_) { return; } // user cancelled or denied the picker
    try {
      var video = document.createElement('video'); video.srcObject = stream; video.muted = true;
      await video.play().catch(function () {});
      await sleep(300); // let a frame paint
      var w = video.videoWidth || 1280, h = video.videoHeight || 720;
      var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      var blob = await new Promise(function (res, rej) { canvas.toBlob(function (b) { b ? res(b) : rej(new Error('encode')); }, 'image/png'); });
      var name = t('screenshotName') + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
      await addFiles([namedFile(blob, name, 'image/png', Date.now())]);
    } catch (_) { toast(t('captureFailed'), 'err'); }
    finally { try { stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (_) {} }
  }

  // Undo the last single file removed from the queue (feature 10).
  var lastRemoved = null, undoTimer = null, undoAction = null;
  function showUndo(name, action, customText) {
    var bar = $('undo-bar'); if (!bar) return;
    undoAction = typeof action === 'function' ? action : null;
    $('undo-text').textContent = customText || (t('fileRemoved') + ' · ' + name);
    bar.classList.remove('hidden');
    clearTimeout(undoTimer); undoTimer = setTimeout(function () { undoAction = null; hideUndo(); }, 8000);
  }
  function hideUndo() { clearTimeout(undoTimer); if ($('undo-bar')) $('undo-bar').classList.add('hidden'); }
  function undoRemove() {
    if (undoAction) { var action = undoAction; undoAction = null; hideUndo(); action(); return; }
    var rec = lastRemoved; lastRemoved = null; hideUndo();
    if (!rec) return;
    var it = makeItem(rec); it.state = 'waiting'; it.sentBytes = 0;
    items.push(it);
    if (!it.volatile) persistItem(it, false);
    renderQueue(); updateSendBtn(); updateStorageStatus();
    toast(t('fileRestored'), 'ok');
  }

  // --- Added features (batch 2) ----------------------------------------------
  // Live character counter for a length-limited input (feature 1).
  function updateCharCount(input, counter, max) {
    if (!input || !counter) return;
    var n = (input.value || '').length;
    counter.textContent = n + '/' + max;
    counter.classList.toggle('near', n >= max * 0.9);
  }

  // Invert the current multi-selection (feature 4).
  function invertSelection() {
    sortedItems().forEach(function (it) { if (selectedIds.has(it.id)) selectedIds.delete(it.id); else selectedIds.add(it.id); });
    renderQueue();
  }

  // Expand / collapse both detail cards at once (feature 8).
  function toggleAllCards() {
    var h = $('history-card'), s = $('settings-card');
    var anyClosed = (h && !h.open) || (s && !s.open);
    if (h) h.open = anyClosed; if (s) s.open = anyClosed;
    updateToggleCardsLabel();
  }
  function bindAdvancedAccordion() {
    document.querySelectorAll('details.advanced-section').forEach(function (details) {
      if (details.dataset.accordionBound === '1') return; details.dataset.accordionBound = '1';
      details.addEventListener('toggle', function () {
        if (!details.open || !($('advanced-accordion') && $('advanced-accordion').checked)) return;
        document.querySelectorAll('details.advanced-section').forEach(function (other) { if (other !== details) other.open = false; });
      });
    });
  }
  function applyAdvancedAccordion(closeNow) {
    bindAdvancedAccordion();
    if (closeNow && $('advanced-accordion') && $('advanced-accordion').checked) document.querySelectorAll('details.advanced-section').forEach(function (details) { details.open = false; });
  }
  function updateToggleCardsLabel() {
    var btn = $('toggle-cards-btn'); if (!btn) return;
    var h = $('history-card'), s = $('settings-card');
    var allOpen = (!h || h.open) && (!s || s.open);
    btn.textContent = allOpen ? t('collapseAll') : t('expandAll');
  }

  // Estimated size of each image AFTER optimization, shown before sending (feature 10).
  // Runs sequentially so a queue of photos never floods the main thread.
  var estimating = false;
  async function estimateOptimizedSizes() {
    if (estimating || !$('optimize-images') || !$('optimize-images').checked) return;
    estimating = true;
    try {
      var targets = items.filter(function (it) { return it.file && /^image\//.test(it.type) && !/svg|gif/i.test(it.type) && it.state === 'waiting' && it.estSize == null; });
      for (var i = 0; i < targets.length; i++) { await estimateOne(targets[i]); }
    } finally { estimating = false; }
  }
  async function estimateOne(it) {
    try {
      var image = await loadImage(it.file);
      var maxSel = $('img-maxdim') ? parseInt($('img-maxdim').value, 10) : 2560;
      var max = maxSel > 0 ? maxSel : Infinity;
      var q = $('img-quality') ? (parseFloat($('img-quality').value) || 0.86) : 0.86;
      var scale = Math.min(1, max / Math.max(image.width, image.height));
      var canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
      if (image.close) image.close();
      var blob = await canvasBlob(canvas, 'image/jpeg', q);
      it.estSize = Math.min(blob.size, it.size);
    } catch (_) { it.estSize = 0; }
    if (it.meta && it.state === 'waiting') it.meta.textContent = rowMetaText(it);
  }
  function clearEstimates() { items.forEach(function (it) { it.estSize = null; }); }

  // Rotate a queued image 90° clockwise before sending (feature 11).
  async function rotateItem(it) {
    if (!it.file || !/^image\//.test(it.type) || /svg/i.test(it.type)) return;
    try {
      var img = await loadImage(it.file);
      var w = img.width, h = img.height;
      var canvas = document.createElement('canvas'); canvas.width = h; canvas.height = w;
      var ctx = canvas.getContext('2d'); ctx.translate(h / 2, w / 2); ctx.rotate(Math.PI / 2); ctx.drawImage(img, -w / 2, -h / 2);
      if (img.close) img.close();
      var type = /png/i.test(it.type) ? 'image/png' : 'image/jpeg';
      var blob = await canvasBlob(canvas, type, type === 'image/jpeg' ? 0.92 : undefined);
      var rotatedFile = namedFile(blob, it.name, type, Date.now()); it.estSize = null;
      await replaceItemSourceDurably(it, rotatedFile);
      renderQueue(); updateSendBtn(); estimateOptimizedSizes();
    } catch (_) { toast(t('error'), 'err'); }
  }

  // Sender-name address book: remember names used and offer them as autocomplete (feature 12).
  function loadSenders() { try { var l = JSON.parse(localStorage.getItem('dx-pwa-senders') || '[]'); return Array.isArray(l) ? l : []; } catch (_) { return []; } }
  function rememberSender(name) {
    name = String(name || '').trim(); if (!name) return;
    var list = loadSenders().filter(function (x) { return x !== name; });
    list.unshift(name); if (list.length > 12) list.length = 12;
    try { localStorage.setItem('dx-pwa-senders', JSON.stringify(list)); } catch (_) {}
    buildSenderList();
  }
  function buildSenderList() {
    var dl = $('sender-list'); if (!dl) return;
    dl.innerHTML = '';
    loadSenders().forEach(function (n) { var o = document.createElement('option'); o.value = n; dl.appendChild(o); });
  }

  // One QR encoding every image link of the session (feature 14).
  function qrAllImageLinks() {
    if (!imageLinkUrls.length) { toast(t('noImgLinks'), 'warn'); return; }
    var text = imageLinkUrls.map(function (o) { return o.url; }).join('\n');
    if (text.length > 1024) { toast(t('imgQrTooBig'), 'warn'); return; } // server caps QR data at 1024 chars
    showQrOverlay(text, t('imgQrAll').replace(/^▦\s*/, ''));
  }

  // Share the selected files through the OS share sheet (feature 15).
  async function shareSelection() {
    var files = selectedItems().map(function (it) { return it.file; }).filter(Boolean);
    if (!files.length) return;
    if (!navigator.canShare || !navigator.canShare({ files: files })) { toast(t('copyFailed'), 'warn'); return; }
    try { await navigator.share({ files: files }); } catch (_) {}
  }

  // Per-destination presets: remember expiry + note for each link (feature 16).
  function applyDestPreset(dest) {
    if (!dest || !dest.preset) return;
    if ($('expire-select') && dest.preset.expire != null) $('expire-select').value = String(dest.preset.expire);
    if ($('batch-note') && dest.preset.note && !$('batch-note').value) { $('batch-note').value = dest.preset.note; updateCharCount($('batch-note'), $('note-count'), 120); }
  }
  function saveDestPreset() {
    if (!currentDest) return;
    currentDest.preset = { expire: expireSeconds(), note: $('batch-note') ? String($('batch-note').value || '').trim().slice(0, 120) : '' };
    if (currentDest.remembered) persistDestination(currentDest).catch(function () {}); else persistSessionDests();
  }

  // Drag-to-reorder the queue in "order added" mode (feature 17). We rewrite each
  // item's createdAt to the new position so the ordering persists in IndexedDB.
  function reorderQueue(fromId, toId) {
    if (!fromId || fromId === toId) return;
    var vis = sortedItems();
    var from = vis.findIndex(function (x) { return x.id === fromId; });
    var to = vis.findIndex(function (x) { return x.id === toId; });
    if (from < 0 || to < 0) return;
    var moved = vis.splice(from, 1)[0]; vis.splice(to, 0, moved);
    var base = Date.now();
    vis.forEach(function (it, i) { it.createdAt = base + i; if (it.state !== 'done') persistItem(it); });
    renderQueue();
  }

  function moveQueueItem(id, delta) {
    var vis = sortedItems(), index = vis.findIndex(function (x) { return x.id === id; });
    var target = index + delta;
    if (index < 0 || target < 0 || target >= vis.length) return;
    reorderQueue(id, vis[target].id);
  }
  function toggleItemPaused(it) {
    if (!it || it.state === 'done' || it.state === 'removed') return;
    if (it.state === 'error') { retryItem(it); return; }
    if (it.state === 'sending' || it.state === 'encrypting' || it.state === 'optimizing') { pauseBatch(); return; }
    it.state = it.state === 'paused' ? 'waiting' : 'paused';
    persistItem(it, false); renderQueue(); updateSendBtn();
  }
  function attachSwipeGestures(row, it) {
    if (!row || !window.PointerEvent) return;
    var startX = 0, startY = 0, active = false, moved = false;
    row.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' || e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button,input,select,a,img')) return;
      active = true; moved = false; startX = e.clientX; startY = e.clientY;
      row.classList.add('swiping');
      try { row.setPointerCapture(e.pointerId); } catch (_) {}
    });
    row.addEventListener('pointermove', function (e) {
      if (!active) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { active = false; row.classList.remove('swiping'); row.style.transform = ''; return; }
      if (Math.abs(dx) > 8) moved = true;
      if (moved) { e.preventDefault(); row.style.transform = 'translateX(' + Math.max(-96, Math.min(96, dx)) + 'px)'; }
    });
    function finish(e) {
      if (!active) return;
      active = false; var dx = e.clientX - startX;
      row.classList.remove('swiping'); row.style.transform = '';
      if (Math.abs(dx) < 68) return;
      if (dx < 0) removeItem(it, true);
      else toggleItemPaused(it);
    }
    row.addEventListener('pointerup', finish);
    row.addEventListener('pointercancel', function () { active = false; row.classList.remove('swiping'); row.style.transform = ''; });
  }

  // Events -------------------------------------------------------------------
  function bindEvents() {
    $('lang-select').addEventListener('change', function () { applyLanguage(this.value); updateNetworkIndicator(); renderQueue(); renderHistory(); });
    var savedTheme = 'dark'; try { savedTheme = localStorage.getItem('dx-theme') || document.documentElement.getAttribute('data-theme-mode') || 'dark'; } catch (_) {}
    $('theme-select').value = savedTheme;
    $('theme-select').addEventListener('change', function () { setTheme(this.value); });
    setInterval(function () { if (($('theme-select') && $('theme-select').value) === 'schedule') setTheme('schedule'); }, 60000);
    $('dest-add-btn').addEventListener('click', function () { if (!destinationLocked) openDestForm(); });
    $('dest-cancel-btn').addEventListener('click', closeDestForm);
    if ($('dest-create-btn')) $('dest-create-btn').addEventListener('click', function () { if (!destinationLocked) openCreateForm(); });
    if ($('create-cancel-btn')) $('create-cancel-btn').addEventListener('click', closeCreateForm);
    if ($('create-do-btn')) $('create-do-btn').addEventListener('click', createReceptionLink);
    if ($('create-name')) $('create-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); createReceptionLink(); } });
    $('dest-save-btn').addEventListener('click', async function () {
      var parsed = parseDestination($('dest-url').value);
      if (!parsed) { toast(t('invalidLink'), 'err'); return; }
      if (parsed.sourceOrigin !== location.origin) {
        var ok = confirm(t('useTokenQuestion', { from: parsed.sourceOrigin, to: location.origin })); if (!ok) { toast(t('otherOrigin'), 'warn'); return; }
      }
      var remember = $('dest-remember').checked;
      var rememberKey = remember && $('dest-remember-key').checked && !!parsed.key;
      var existing = findDest(parsed.token);
      var dest = { token: parsed.token, name: String($('dest-name').value || '').trim(), key: parsed.key || '', rememberKey: rememberKey, sourceOrigin: parsed.sourceOrigin, remembered: remember, owned: !!(existing && existing.owned), pinned: !!(existing && existing.pinned), order: existing ? existing.order : undefined, createdAt: (existing && existing.createdAt) || Date.now() };
      if (editingToken && editingToken !== dest.token) await removeDestinationRecord(editingToken);
      await saveDestinationRecord(dest, remember);
      setActiveToken(dest.token); closeDestForm(); renderDests(); $('dest-select').value = dest.token; refreshDestStatus();
    });
    $('dest-remove-btn').addEventListener('click', async function () {
      if (!editingToken || !askConfirmation('delete', t('removedConfirm'))) return;
      await removeDestinationRecord(editingToken); closeDestForm(); renderDests(); refreshDestStatus();
    });
    // Revoke (server-side) a reception link created from this PWA, then forget it locally.
    $('dest-revoke-btn').addEventListener('click', async function () {
      if (destinationLocked) return;
      var token = $('dest-select').value;
      var dest = token ? findDest(token) : null;
      if (!dest || !dest.owned || !askConfirmation('revoke', t('revokeConfirm'))) return;
      var btn = $('dest-revoke-btn'); btn.disabled = true;
      var ok = await revokeShareRequest(token);
      btn.disabled = false;
      if (ok) { await removeDestinationRecord(token); renderDests(); refreshDestStatus(); toast(t('revokeSuccess'), 'ok'); }
      else { toast(t('revokeFail'), 'err'); }
    });
    $('dest-select').addEventListener('change', function () { setActiveToken(this.value); $('enc-key').value = ''; $('enc-passphrase').value = ''; refreshDestStatus(); });
    $('dest-url').addEventListener('input', updateRememberKeyControl);
    $('dest-remember').addEventListener('change', updateRememberKeyControl);
    $('dest-copy-btn').addEventListener('click', function () {
      if (!currentDest) return; var url = location.origin + '/u/' + currentDest.token + (currentDest.key ? '#k=' + currentDest.key : '');
      copyText(url).then(function () { toast(t('copied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); });
    });
    if ($('dest-pin-btn')) $('dest-pin-btn').addEventListener('click', function () { if (editingToken) togglePin(editingToken); });
    $('unlock-btn').addEventListener('click', function () {
      if (!currentDest || !$('unlock-pw').value) return;
      fetch('/u/' + encodeURIComponent(currentDest.token) + '/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent($('unlock-pw').value) })
        .then(function () { $('unlock-pw').value = ''; refreshDestStatus(); }).catch(function () { toast(t('unlockFailed'), 'err'); });
    });
    $('enc-key').addEventListener('input', function () { updateEncryptionPanel(); updateSendBtn(); });
    $('enc-passphrase').addEventListener('input', updateSendBtn);
    $('sender-name').addEventListener('input', function () { saveSenderForCurrent(); updateSendBtn(); });
    ['pick-camera', 'pick-files', 'pick-folder'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    });
    if ($('pick-imglink')) $('pick-imglink').addEventListener('change', function (e) { createImageLinks(e.target.files); e.target.value = ''; });
    $('send-btn').addEventListener('click', function () { startBatch(); });
    $('pause-btn').addEventListener('click', pauseBatch); $('resume-btn').addEventListener('click', resumeBatch);
    $('retry-all-btn').addEventListener('click', retryAll); $('clear-all-btn').addEventListener('click', clearPending); $('clear-done-btn').addEventListener('click', clearDone);
    $('history-clear-btn').addEventListener('click', async function () {
      if (!askConfirmation('delete', t('clearHistoryConfirm'))) return;
      // Clear the in-memory list and repaint FIRST, so a blocked or slow IndexedDB
      // (common on Android WebAPK, where openDb can time out) can never abort the
      // clear. persistHistorySnapshot wipes the localStorage backup + meta snapshot;
      // clearing the IDB store itself is best-effort and must not block the UI.
      historyEntries = [];
      renderHistory();
      try { await persistHistorySnapshot(); } catch (_) {}
      idbClear(HISTORY_STORE).catch(function () {});
    });
    $('persist-storage-btn').addEventListener('click', requestPersistentStorage);
    $('pair-device-btn').addEventListener('click', pairDevice); $('pair-other-btn').addEventListener('click', openPairingDialog);
    $('pair-copy-btn').addEventListener('click', copyPairingLink); $('pair-close').addEventListener('click', closePairingDialog);
    $('revoke-device-btn').addEventListener('click', function () { revokeDevice(null, true); });
    if ($('rename-device-btn')) $('rename-device-btn').addEventListener('click', function () { renameDevice(null, deviceInfo && deviceInfo.device && deviceInfo.device.name, true); });
    $('clear-local-btn').addEventListener('click', clearLocalData);
    $('logout-session-btn').addEventListener('click', closeSession);
    $('dest-scan-btn').addEventListener('click', startScan); $('qr-close').addEventListener('click', stopScan);
    $('update-btn').addEventListener('click', function () { applyUpdate(waitingWorker); });
    $('auto-resume').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-auto-resume', this.checked ? '1' : '0'); } catch (_) {} });
    $('concurrency-select').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-concurrency', this.value); } catch (_) {} });
    if ($('sort-select')) $('sort-select').addEventListener('change', function () { sortMode = this.value; try { localStorage.setItem('dx-pwa-sort', this.value); } catch (_) {} renderQueue(); });
    if ($('queue-search')) $('queue-search').addEventListener('input', function () { queueFilter = this.value || ''; renderQueue(); });
    if ($('bulk-invert-btn')) $('bulk-invert-btn').addEventListener('click', invertSelection);
    if ($('bulk-share-btn')) $('bulk-share-btn').addEventListener('click', shareSelection);
    if ($('toggle-cards-btn')) $('toggle-cards-btn').addEventListener('click', toggleAllCards);
    if ($('imglink-qrall-btn')) $('imglink-qrall-btn').addEventListener('click', qrAllImageLinks);
    if ($('batch-note')) $('batch-note').addEventListener('input', function () { updateCharCount(this, $('note-count'), 120); });
    if ($('batch-note')) $('batch-note').addEventListener('change', saveDestPreset);
    if ($('dest-name')) $('dest-name').addEventListener('input', function () { updateCharCount(this, $('dest-name-count'), 80); });
    if ($('sender-name')) $('sender-name').addEventListener('change', function () { rememberSender(this.value); });
    if ($('imglink-copyall-btn')) $('imglink-copyall-btn').addEventListener('click', copyAllImageLinks);
    if ($('dest-qr-btn')) $('dest-qr-btn').addEventListener('click', showDestQr);
    if ($('destqr-close')) $('destqr-close').addEventListener('click', closeDestQr);
    if ($('dest-received-btn')) $('dest-received-btn').addEventListener('click', openReceivedDialog);
    if ($('received-close')) $('received-close').addEventListener('click', closeReceivedDialog);
    if ($('received-refresh-btn')) $('received-refresh-btn').addEventListener('click', function () { var tk = $('dest-select').value; if (tk) loadReceivedFiles(tk); });
    if ($('help-btn')) $('help-btn').addEventListener('click', openHelp);
    if ($('help-close')) $('help-close').addEventListener('click', closeHelp);
    if ($('history-search')) $('history-search').addEventListener('input', function () { historyFilter = this.value || ''; renderHistory(); });
    if ($('check-update-btn')) $('check-update-btn').addEventListener('click', checkForUpdate);
    if ($('copy-diag-btn')) $('copy-diag-btn').addEventListener('click', copyDiagnostic);
    if ($('vibrate-finish')) $('vibrate-finish').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-vibrate', this.checked ? '1' : '0'); } catch (_) {} });
    if ($('keep-awake')) $('keep-awake').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-keepawake', this.checked ? '1' : '0'); } catch (_) {} applyKeepAwake(); });
    if ($('optimize-images')) $('optimize-images').addEventListener('change', function () {
      if (!this.checked && $('optimize-preset')) $('optimize-preset').value = 'original';
      else if (this.checked && $('optimize-preset') && $('optimize-preset').value === 'original') $('optimize-preset').value = 'message';
      if ($('optimize-opts')) $('optimize-opts').classList.toggle('hidden', !this.checked);
      try { localStorage.setItem('dx-pwa-opt-preset', $('optimize-preset') ? $('optimize-preset').value : (this.checked ? 'custom' : 'original')); } catch (_) {}
      clearEstimates(); renderQueue(); if (this.checked) estimateOptimizedSizes();
    });
    if ($('optimize-preset')) $('optimize-preset').addEventListener('change', function () { applyOptimizationPreset(this.value, true); });
    if ($('img-quality')) $('img-quality').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-img-quality', this.value); } catch (_) {} markOptimizationCustom(); clearEstimates(); estimateOptimizedSizes(); });
    if ($('img-maxdim')) $('img-maxdim').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-img-maxdim', this.value); } catch (_) {} markOptimizationCustom(); clearEstimates(); estimateOptimizedSizes(); });
    if ($('img-format')) $('img-format').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-img-format', this.value); } catch (_) {} });
    if ($('img-copy-template')) $('img-copy-template').addEventListener('change', function () { persistImagePreferences(); });
    ['img-action-1','img-action-2','img-action-3'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', function () { persistImagePreferences(); imageRowsByToken.forEach(arrangeImageActions); }); });
    ['img-sort', 'img-filter', 'img-default-variant'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', function () { persistImagePreferences(); applyImageView(); if (id === 'img-default-variant') imageRowsByToken.forEach(function (row) { var p = imageRecordsByToken.get(row.dataset.token); if (p) { var buttons = { full: row.querySelector('.il-full'), thumb: row.querySelector('.il-thumb'), micro: row.querySelector('.il-micro') }; Object.keys(buttons).forEach(function (kind) { if (buttons[kind]) buttons[kind].classList.toggle('il-primary', kind === imageDefaultVariant()); }); } }); }); });
    if ($('img-search')) $('img-search').addEventListener('input', applyImageView);
    ['img-expiry', 'img-max-views', 'img-hotlink-hosts', 'img-smart-blur', 'img-tags', 'img-note', 'img-rename-template'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', persistImagePreferences); });
    ['img-compact', 'img-hide-expired', 'img-auto-copy', 'img-notify-first-view'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', function () { persistImagePreferences(); if (id === 'img-compact') $('imglink-list').classList.toggle('img-compact', this.checked); applyImageView(); }); });
    if ($('img-select-all')) $('img-select-all').addEventListener('change', function () { var checked = this.checked; imageRowsByToken.forEach(function (row, token) { if (!row.classList.contains('hidden')) selectImageToken(token, checked); }); });
    if ($('img-bulk-edit')) $('img-bulk-edit').addEventListener('click', editSelectedImages);
    if ($('img-bulk-album')) $('img-bulk-album').addEventListener('click', createAlbumFromSelection);
    if ($('img-bulk-revoke')) $('img-bulk-revoke').addEventListener('click', bulkRevokeImages);
    if ($('img-dashboard-refresh')) $('img-dashboard-refresh').addEventListener('click', refreshImageDashboard);
    if ($('img-action-history-clear')) $('img-action-history-clear').addEventListener('click', function () { imageActionHistory = []; try { localStorage.removeItem('dx-pwa-image-actions'); } catch (_) {} persistImageActionHistory(); renderImageActionHistory(); });
    if ($('tag-colors-reset')) $('tag-colors-reset').addEventListener('click', function () { tagColorMap = {}; persistTagColors(); renderTagColorManager(); imageRowsByToken.forEach(function (r, token) { var photo = imageRecordsByToken.get(token); if (photo) renderImageVariantStats(r, photo); }); });
    if ($('img-tags')) $('img-tags').addEventListener('input', renderTagColorManager);
    if ($('imglink-qrzip-btn')) $('imglink-qrzip-btn').addEventListener('click', downloadImageQrZip);
    if ($('img-retention-save')) $('img-retention-save').addEventListener('click', saveImageRetentionRules);
    if ($('img-export-stats-csv')) $('img-export-stats-csv').addEventListener('click', exportImageStatsCsv);
    if ($('imglink-strip-exif')) $('imglink-strip-exif').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-imglink-stripexif', this.checked ? '1' : '0'); } catch (_) {} });
    if ($('history-export-csv-btn')) $('history-export-csv-btn').addEventListener('click', function () { exportHistory('csv'); });
    if ($('history-export-json-btn')) $('history-export-json-btn').addEventListener('click', function () { exportHistory('json'); });
    if ($('dest-up-btn')) $('dest-up-btn').addEventListener('click', function () { if (editingToken) moveDest(editingToken, -1); });
    if ($('dest-down-btn')) $('dest-down-btn').addEventListener('click', function () { if (editingToken) moveDest(editingToken, 1); });
    if ($('share-app-btn')) $('share-app-btn').addEventListener('click', shareApp);
    if ($('sound-finish')) $('sound-finish').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-sound', this.checked ? '1' : '0'); } catch (_) {} if (this.checked) playBeep(false); });
    if ($('auto-clear-done')) $('auto-clear-done').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-autoclear', this.checked ? '1' : '0'); } catch (_) {} });
    if ($('haptic-feedback')) $('haptic-feedback').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-haptic', this.checked ? '1' : '0'); } catch (_) {} if (this.checked) haptic('light'); });
    if ($('advanced-accordion')) $('advanced-accordion').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-advanced-accordion', this.checked ? '1' : '0'); } catch (_) {} applyAdvancedAccordion(this.checked); });
    ['confirm-revoke','confirm-delete','confirm-replace'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', function () { try { localStorage.setItem('dx-pwa-' + id, this.checked ? '1' : '0'); } catch (_) {} }); });
    if ($('storage-warning-threshold')) $('storage-warning-threshold').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-storage-warning-threshold', this.value); } catch (_) {} updateStorageStatus(); });
    if ($('density-select')) $('density-select').addEventListener('change', function () { applyDensity(this.value); });
    if ($('expire-select')) $('expire-select').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-expire', this.value); } catch (_) {} saveDestPreset(); });
    if ($('live-enable')) $('live-enable').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-live', this.checked ? '1' : '0'); } catch (_) {} if (this.checked) connectLive(); else disconnectLive(); });
    if ($('live-push')) $('live-push').addEventListener('change', async function () {
      var el = this;
      if (el.checked) {
        var ok = await enablePush();
        if (ok) { toast(t('livePushOn'), 'ok'); try { localStorage.setItem('dx-pwa-push', '1'); } catch (_) {} }
        else { el.checked = false; toast(t('livePushFail'), 'err'); }
      } else {
        await disablePush(); toast(t('livePushOff'), 'warn'); try { localStorage.setItem('dx-pwa-push', '0'); } catch (_) {}
      }
    });
    if ($('wifi-only')) $('wifi-only').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-wifionly', this.checked ? '1' : '0'); } catch (_) {} releaseWifiWaiters(); maybeAutoResume(); });
    if ($('confirm-mobile-data')) $('confirm-mobile-data').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-confirm-mobile', this.checked ? '1' : '0'); } catch (_) {} });
    if ($('privacy-names')) $('privacy-names').addEventListener('change', function () {
      privacyNames = this.checked; document.body.classList.toggle('privacy-names', privacyNames);
      try { localStorage.setItem('dx-pwa-privacy-names', privacyNames ? '1' : '0'); } catch (_) {}
      renderQueue(); renderHistory(); updateResultActions();
    });
    if ($('strip-exif')) $('strip-exif').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-stripexif', this.checked ? '1' : '0'); } catch (_) {} });
    if ($('pick-voice')) $('pick-voice').addEventListener('click', openVoice);
    if ($('pick-text')) $('pick-text').addEventListener('click', pasteTextFile);
    if ($('pick-url')) $('pick-url').addEventListener('click', addFromUrl);
    if ($('pick-screen')) $('pick-screen').addEventListener('click', captureScreen);
    if ($('reset-batch-btn')) $('reset-batch-btn').addEventListener('click', resetBatch);
    if ($('last-batch-btn')) $('last-batch-btn').addEventListener('click', resendLastBatch);
    if ($('copy-summary-btn')) $('copy-summary-btn').addEventListener('click', copyLastSummary);
    if ($('share-result-btn')) $('share-result-btn').addEventListener('click', shareLastSummary);
    if ($('master-select')) $('master-select').addEventListener('change', function () { toggleMasterSelect(this.checked); });
    if ($('bulk-rename-btn')) $('bulk-rename-btn').addEventListener('click', bulkRename);
    if ($('undo-btn')) $('undo-btn').addEventListener('click', undoRemove);
    if ($('lightbox-close')) $('lightbox-close').addEventListener('click', closeLightbox);
    if ($('lightbox-x')) $('lightbox-x').addEventListener('click', closeLightbox);
    if ($('lightbox-overlay')) $('lightbox-overlay').addEventListener('click', function (e) { if (e.target === this) closeLightbox(); });
    if ($('export-settings-btn')) $('export-settings-btn').addEventListener('click', exportSettings);
    if ($('import-settings-btn')) $('import-settings-btn').addEventListener('click', function () { $('import-settings-input').click(); });
    if ($('import-settings-input')) $('import-settings-input').addEventListener('change', function (e) { if (e.target.files && e.target.files[0]) importSettings(e.target.files[0]); e.target.value = ''; });
    if ($('accent-color')) $('accent-color').addEventListener('input', function () { applyAccent(this.value); });
    if ($('accent-reset-btn')) $('accent-reset-btn').addEventListener('click', resetAccent);
    if ($('voice-record-btn')) $('voice-record-btn').addEventListener('click', toggleRec);
    if ($('voice-add-btn')) $('voice-add-btn').addEventListener('click', addVoiceNote);
    if ($('voice-close')) $('voice-close').addEventListener('click', closeVoice);
    if ($('zip-btn')) $('zip-btn').addEventListener('click', zipSelected);
    if ($('multisend-btn')) $('multisend-btn').addEventListener('click', openMultiSend);
    if ($('multisend-go')) $('multisend-go').addEventListener('click', runMultiSend);
    if ($('multisend-cancel')) $('multisend-cancel').addEventListener('click', closeMultiSend);
    if ($('bulk-remove-btn')) $('bulk-remove-btn').addEventListener('click', bulkRemove);
    if ($('bulk-retry-btn')) $('bulk-retry-btn').addEventListener('click', bulkRetry);
    if ($('ann-pen')) $('ann-pen').addEventListener('click', function () { setAnnTool('pen'); });
    if ($('ann-blur')) $('ann-blur').addEventListener('click', function () { setAnnTool('blur'); });
    if ($('ann-detect-faces')) $('ann-detect-faces').addEventListener('click', function () { detectAndBlurFaces(true); });
    if ($('ann-detect-plates')) $('ann-detect-plates').addEventListener('click', function () { detectAndBlurPlates(true); });
    if ($('ann-undo')) $('ann-undo').addEventListener('click', annUndo);
    if ($('ann-clear')) $('ann-clear').addEventListener('click', annClear);
    if ($('ann-crop-square')) $('ann-crop-square').addEventListener('click', function () { cropAnnotate(1); });
    if ($('ann-crop-43')) $('ann-crop-43').addEventListener('click', function () { cropAnnotate(4 / 3); });
    if ($('ann-crop-169')) $('ann-crop-169').addEventListener('click', function () { cropAnnotate(16 / 9); });
    if ($('ann-apply')) $('ann-apply').addEventListener('click', applyAnnotate);
    if ($('ann-cancel')) $('ann-cancel').addEventListener('click', closeAnnotate);
    if ($('annotate-canvas')) {
      var ac = $('annotate-canvas');
      ac.addEventListener('mousedown', annDown); ac.addEventListener('mousemove', annMove); window.addEventListener('mouseup', annUp);
      ac.addEventListener('touchstart', annDown, { passive: false }); ac.addEventListener('touchmove', annMove, { passive: false }); ac.addEventListener('touchend', annUp);
    }
    if ($('cmd-input')) {
      $('cmd-input').addEventListener('input', function () { renderCmd(this.value); });
      $('cmd-input').addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdActiveIdx = Math.min(cmdItems.length - 1, cmdActiveIdx + 1); highlightCmd(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); cmdActiveIdx = Math.max(0, cmdActiveIdx - 1); highlightCmd(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (cmdItems.length) runCmd(cmdActiveIdx); }
      });
    }
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.addEventListener) conn.addEventListener('change', function () { releaseWifiWaiters(); maybeAutoResume(); updateNetworkIndicator(); });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      clearTimeout(installDiagnosticTimer);
      clearInstallDiagnostic();
      updateInstallButtonVisibility(false);
    });
    if ($('install-btn')) $('install-btn').addEventListener('click', requestPwaInstall);
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      clearTimeout(installDiagnosticTimer);
      clearInstallDiagnostic();
      updateInstallButtonVisibility(true);
    });
    updateInstallButtonVisibility(false);
    window.addEventListener('online', function () {
      $('offbar').classList.add('hidden'); updateNetworkIndicator(); var waiters = onlineWaiters.splice(0); waiters.forEach(function (resolve) { resolve(); }); refreshDestStatus(); maybeAutoResume();
    });
    window.addEventListener('offline', function () { $('offbar').classList.remove('hidden'); updateNetworkIndicator(); });
    window.addEventListener('beforeunload', function (e) {
      if (!sending) return;
      e.preventDefault(); e.returnValue = '';
      return '';
    });
    // Android back button: a single press dismisses whatever dialog/overlay is open;
    // on the bare app view it shows a warning and only a SECOND press within a short
    // window actually leaves the app (the classic "press back again to exit"). We keep
    // one throwaway history entry on top as a guard — each back press pops it and fires
    // popstate, where we decide whether to restore the guard or let the app close. A PWA
    // cannot close itself programmatically (history.back() at the root entry is a no-op),
    // so the exit works by leaving the guard OFF, letting the next back reach the root
    // where Android closes the window. Only wired for the installed / standalone PWA — a
    // normal browser tab keeps its native back button untouched.
    if (isStandaloneApp()) {
      var pwaExitTimer = null;
      var pushBackGuard = function () { try { history.pushState({ dxBack: true }, ''); } catch (_) {} };
      // Dismiss the topmost open overlay, mirroring the Escape-key priority above.
      var dismissTopOverlay = function () {
        if (scanning || !$('qr-overlay').classList.contains('hidden')) { stopScan(); return true; }
        var closers = [
          ['lightbox-overlay', closeLightbox], ['cmd-overlay', closeCmd], ['annotate-overlay', closeAnnotate],
          ['voice-overlay', closeVoice], ['multisend-overlay', closeMultiSend], ['destqr-overlay', closeDestQr],
          ['help-overlay', closeHelp], ['pair-overlay', closePairingDialog], ['received-overlay', closeReceivedDialog],
          ['dest-form', closeDestForm], ['create-form', closeCreateForm]
        ];
        for (var i = 0; i < closers.length; i++) {
          var el = $(closers[i][0]);
          if (el && !el.classList.contains('hidden')) { closers[i][1](); return true; }
        }
        return false;
      };
      if (!(history.state && history.state.dxBack)) pushBackGuard();
      window.addEventListener('popstate', function () {
        // Landing back ON the guard entry means we RETURNED from a forward navigation —
        // e.g. an image opened in the same window via "view", then dismissed with back.
        // The guard is still in place and we are safely back in the app, so this is NOT
        // an exit attempt. (Treating it as one made the first back-from-image warn and
        // disarm the guard, so the next back closed the PWA instead of returning to it.)
        if (history.state && history.state.dxBack) return;
        // A back press consumed our guard and moved us to the app's base entry.
        if (dismissTopOverlay()) { if (pwaExitTimer) { clearTimeout(pwaExitTimer); pwaExitTimer = null; } pushBackGuard(); return; }
        // Bare app view: warn now. The guard is already popped, so a prompt second back
        // reaches the root entry and Android closes the PWA. If no second press arrives,
        // re-arm the guard so a later back warns again instead of exiting silently.
        toast(t('backExit'), 'warn');
        if (pwaExitTimer) clearTimeout(pwaExitTimer);
        pwaExitTimer = setTimeout(function () { pwaExitTimer = null; pushBackGuard(); }, 2500);
      });
    }
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && (sending || ($('keep-awake') && $('keep-awake').checked))) acquireWake(); });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
      // Command palette: Ctrl/Cmd+K works from anywhere.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if ($('cmd-overlay').classList.contains('hidden')) openCmd(); else closeCmd(); return; }
      if (e.key === 'Escape') {
        if (scanning) stopScan();
        else if (!$('qr-overlay').classList.contains('hidden')) stopScan();
        else if (!$('lightbox-overlay').classList.contains('hidden')) closeLightbox();
        else if (!$('cmd-overlay').classList.contains('hidden')) closeCmd();
        else if (!$('annotate-overlay').classList.contains('hidden')) closeAnnotate();
        else if (!$('voice-overlay').classList.contains('hidden')) closeVoice();
        else if (!$('multisend-overlay').classList.contains('hidden')) closeMultiSend();
        else if (!$('destqr-overlay').classList.contains('hidden')) closeDestQr();
        else if (!$('help-overlay').classList.contains('hidden')) closeHelp();
        else if (!$('pair-overlay').classList.contains('hidden')) closePairingDialog();
        else if (!$('dest-form').classList.contains('hidden')) closeDestForm();
        else if (!$('create-form').classList.contains('hidden')) closeCreateForm();
        return;
      }
      if (typing) return;
      var anyOverlay = ['pair-overlay', 'destqr-overlay', 'help-overlay', 'qr-overlay', 'cmd-overlay', 'annotate-overlay', 'voice-overlay', 'multisend-overlay', 'lightbox-overlay']
        .some(function (id) { return !$(id).classList.contains('hidden'); });
      // Ctrl/Cmd+A selects the whole queue (feature 5) when it isn't empty.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !anyOverlay && sortedItems().length) { e.preventDefault(); toggleMasterSelect(true); return; }
      // Enter sends the queue when it is ready and nothing modal is open.
      if (e.key === 'Enter' && !$('send-btn').disabled && !anyOverlay) { e.preventDefault(); startBatch(); }
      else if (e.key === '?' && !anyOverlay) { e.preventDefault(); openHelp(); }
    });
    ['dragenter', 'dragover'].forEach(function (eventName) {
      document.addEventListener(eventName, function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) { e.preventDefault(); document.body.classList.add('dragging'); } });
    });
    document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
    document.addEventListener('drop', function (e) { document.body.classList.remove('dragging'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    document.addEventListener('paste', function (e) { var files = e.clipboardData && e.clipboardData.files; if (files && files.length) addFiles(files); });
  }
  function restoreSender() {
    if (!$('sender-name')) return;
    try {
      var map = senderMap(), keys = Object.keys(map);
      var value = currentDest && map[currentDest.token] ? map[currentDest.token] : '';
      if (!value && keys.length === 0) value = localStorage.getItem('dx_sender') || '';
      $('sender-name').value = value;
    } catch (_) {}
  }

  function renderBuildTag() {
    var tag = $('build-tag');
    if (tag) tag.textContent = 'v' + APP_VERSION + ' · ' + APP_BUILD.replace(/^.*-/, '');
  }

  async function initialize() {
    // Render the release immediately. It remains visible even if restoration of a
    // legacy transfer later fails, which also makes update diagnostics reliable.
    renderBuildTag();
    lang = detectLang(); bindEvents(); initPwaNavigation(); installPullToRefresh(); registerServiceWorker(); loadInstallInfo();
    try {
      $('auto-resume').checked = localStorage.getItem('dx-pwa-auto-resume') !== '0';
      $('concurrency-select').value = localStorage.getItem('dx-pwa-concurrency') || (isMobileLike() ? '1' : '2');
      if ($('vibrate-finish')) $('vibrate-finish').checked = localStorage.getItem('dx-pwa-vibrate') !== '0';
      if ($('keep-awake')) $('keep-awake').checked = localStorage.getItem('dx-pwa-keepawake') === '1';
      if ($('sound-finish')) $('sound-finish').checked = localStorage.getItem('dx-pwa-sound') === '1';
      if ($('auto-clear-done')) $('auto-clear-done').checked = localStorage.getItem('dx-pwa-autoclear') === '1';
      if ($('haptic-feedback')) $('haptic-feedback').checked = localStorage.getItem('dx-pwa-haptic') !== '0';
      if ($('advanced-accordion')) $('advanced-accordion').checked = localStorage.getItem('dx-pwa-advanced-accordion') !== '0';
      if ($('confirm-revoke')) $('confirm-revoke').checked = localStorage.getItem('dx-pwa-confirm-revoke') !== '0';
      if ($('confirm-delete')) $('confirm-delete').checked = localStorage.getItem('dx-pwa-confirm-delete') !== '0';
      if ($('confirm-replace')) $('confirm-replace').checked = localStorage.getItem('dx-pwa-confirm-replace') !== '0';
      if ($('storage-warning-threshold')) $('storage-warning-threshold').value = localStorage.getItem('dx-pwa-storage-warning-threshold') || '80';
      if ($('wifi-only')) $('wifi-only').checked = localStorage.getItem('dx-pwa-wifionly') === '1';
      if ($('confirm-mobile-data')) $('confirm-mobile-data').checked = localStorage.getItem('dx-pwa-confirm-mobile') !== '0';
      privacyNames = localStorage.getItem('dx-pwa-privacy-names') === '1';
      if ($('privacy-names')) $('privacy-names').checked = privacyNames;
      document.body.classList.toggle('privacy-names', privacyNames);
      if ($('strip-exif')) $('strip-exif').checked = localStorage.getItem('dx-pwa-stripexif') === '1';
      if ($('expire-select')) $('expire-select').value = localStorage.getItem('dx-pwa-expire') || '0';
      if ($('live-enable')) $('live-enable').checked = localStorage.getItem('dx-pwa-live') !== '0';
      if ($('live-push')) $('live-push').checked = localStorage.getItem('dx-pwa-push') === '1';
      if ($('img-quality')) $('img-quality').value = localStorage.getItem('dx-pwa-img-quality') || '0.86';
      if ($('img-maxdim')) $('img-maxdim').value = localStorage.getItem('dx-pwa-img-maxdim') || '2560';
      if ($('optimize-preset')) applyOptimizationPreset(localStorage.getItem('dx-pwa-opt-preset') || 'original', false);
      if ($('img-format')) $('img-format').value = localStorage.getItem('dx-pwa-img-format') || 'url';
      restoreImagePreferences();
      if ($('img-copy-template')) $('img-copy-template').value = localStorage.getItem('dx-pwa-img-copy-template') || $('img-copy-template').value || 'standard';
      if ($('imglink-strip-exif')) $('imglink-strip-exif').checked = localStorage.getItem('dx-pwa-imglink-stripexif') !== '0';
      if ($('optimize-opts')) $('optimize-opts').classList.toggle('hidden', !$('optimize-images').checked);
      var dens = localStorage.getItem('dx-pwa-density') || 'normal';
      if ($('density-select')) $('density-select').value = dens; applyDensity(dens);
      if ($('share-app-btn')) $('share-app-btn').classList.toggle('hidden', !navigator.share);
      // Custom accent colour (feature 18).
      var accent = localStorage.getItem('dx-accent') || '';
      if (accent) applyAccent(accent); else if ($('accent-color')) $('accent-color').value = '#3b6ef6';
      // Remember which cards were left open (feature 9), and keep the expand/collapse label in sync.
      ['history-card', 'settings-card'].forEach(function (id) {
        var el = $(id); if (!el) return;
        var key = id === 'history-card' ? 'dx-pwa-history-open' : 'dx-pwa-settings-open';
        try { el.open = localStorage.getItem(key) === '1'; } catch (_) {}
        el.addEventListener('toggle', function () { try { localStorage.setItem(key, el.open ? '1' : '0'); } catch (_) {} updateToggleCardsLabel(); });
      });
      updateToggleCardsLabel(); applyAdvancedAccordion(false); startExpiryCountdowns(); renderTagColorManager();
      // Screen capture is desktop-only; reveal the tile only when supported (feature 19).
      if ($('pick-screen') && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) $('pick-screen').classList.remove('hidden');
      // Restore the queue sort mode (feature 3), populate the sender address book (feature 12),
      // reveal "Share selection" when the OS supports file sharing (feature 15).
      if ($('sort-select')) { sortMode = localStorage.getItem('dx-pwa-sort') || 'added'; $('sort-select').value = sortMode; }
      buildSenderList();
      if ($('bulk-share-btn') && navigator.canShare) $('bulk-share-btn').classList.remove('hidden');
      if ($('batch-note')) updateCharCount($('batch-note'), $('note-count'), 120);
    } catch (_) {}
    if (!navigator.onLine) $('offbar').classList.remove('hidden');
    if (!('webkitdirectory' in $('pick-folder'))) $('pick-folder').parentElement.classList.add('hidden');
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
      $('dest-scan-btn').classList.add('hidden'); $('scan-note').textContent = t('scanUnsupported'); $('scan-note').classList.remove('hidden');
    }
    applyLanguage(lang);
    renderBuildTag();
    // Fast first paint of destinations and history from synchronous localStorage
    // sources, BEFORE any indexedDB.open() await. On devices where IndexedDB is slow
    // to open (some Android WebViews take seconds), this makes the links and history
    // appear immediately; the IndexedDB reconciliation below then repaints if needed.
    try {
      sessionDests = loadSessionDests();
      persistentDests = mergeDestLists([], localDestBackup());
      historyEntries = localHistoryBackup().slice(0, MAX_HISTORY);
      renderDests(); renderHistory(); updatePwaNavBadges();
    } catch (_) {}
    // Pairing controls are independent of queue/image restoration. Fetch them now
    // so Appairer / Désappairer remain available even if legacy local data is bad.
    var deviceBootstrap = fetchDeviceStatus();
    // Start restoring the image library before any queue/history migration. This
    // promise keeps running even if another optional subsystem encounters bad data.
    var imageBootstrap = bootstrapImageLibrary(readServerImageBootstrap()).catch(function () { return []; });
    await migrateLegacyDests().catch(function () {});
    sessionDests = loadSessionDests();
    // Merge the IndexedDB store with the durable localStorage mirror so a created
    // link survives whichever store is available on this device (IndexedDB can be
    // unopenable in some Android WebAPK/WebView contexts). Re-heal IndexedDB with
    // any entry that only the localStorage backup still holds.
    var idbDests = await idbGetAll(DEST_STORE).catch(function () { return []; });
    var idbTokens = Object.create(null); (Array.isArray(idbDests) ? idbDests : []).forEach(function (d) { if (d && d.token) idbTokens[d.token] = true; });
    persistentDests = mergeDestLists(idbDests, localDestBackup());
    // Existing installations may have stored #k= secrets before the explicit
    // opt-in existed. Remove those keys unless the record says the user chose to
    // remember it. Also write back any backup-only record into IndexedDB.
    await Promise.all(persistentDests.map(function (d) {
      if (d && d.key && d.rememberKey !== true) { d.key = ''; return persistDestination(d); }
      if (d && d.token && !idbTokens[d.token]) return persistDestination(d);
      return Promise.resolve();
    })).catch(function () {});
    saveDestsBackup(); // ensure the mirror reflects the merged, key-stripped set
    // Merge the IndexedDB queue with its durable localStorage mirror so OPFS-backed
    // uploads survive even when IndexedDB is unavailable on this device.
    var idbQueue = await idbGetAll(QUEUE_STORE).catch(function () { return []; });
    var queueRecords = mergeQueueRecords(idbQueue, localQueueBackup());
    queueRecords.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    items = await restoreQueueRecords(queueRecords).catch(function () { return []; });
    saveQueueBackup(); // re-sync the mirror to what actually restored
    historyEntries = await loadPersistentHistory().catch(function () { return []; });
    await imageBootstrap;
    var persistedImageActions = await metaGet('imageActionHistory', []).catch(function () { return []; });
    imageActionHistory = mergeImageActionHistory(persistedImageActions, imageActionHistory);
    // History, image library and image-action history are now loaded: it is safe for
    // checkpoints to write the localStorage backups from here on.
    hydrated = true;
    persistImageActionHistory();
    protectPersistentStorage();
    var life = await metaGet('lifetime', null).catch(function () { return null; });
    if (life) { lifetimeFiles = Number(life.files) || 0; lifetimeBytes = Number(life.bytes) || 0; }
    lastBatchRecord = await metaGet('lastBatch', null).catch(function () { return null; });
    lastBatchSummary = await metaGet('lastBatchSummary', null).catch(function () { return null; });
    renderBuildTag();
    applyLanguage(lang); updateNetworkIndicator(); renderDests(); renderQueue(); renderHistory(); renderImageActionHistory(); updatePwaNavBadges(); updateSendBtn(); updateResultActions(); updateStorageStatus(); updateSessionStats(); restoreSender();
    if ($('keep-awake') && $('keep-awake').checked) applyKeepAwake();
    if (pairedClaim) { toast(t('devicePairedOk'), 'ok'); try { history.replaceState(null, '', '/app/'); } catch (_) {} }
    await loadSharedBatch();
    renderDests(); renderQueue(); updateSendBtn();
    if (items.length) toast(t('resumedQueue', { n: items.length }), 'ok');
    await Promise.allSettled([
      deviceBootstrap,
      refreshDestStatus(),
      fetchDeviceStatus(),
      refreshImageStats(true),
      refreshAlbums(),
      refreshImageDashboard(),
      loadImageRetentionRules(),
      loadHostShares(), // populate the Partages nav badge without waiting for a tab visit
      loadReceptions()  // list ALL reception links (incl. non-PWA) in the Destination picker
    ]);
    maybeAutoResume(); startImageStatsPolling();
    connectLive(); // live inbox receptions (SSE) when enabled
    if (launchAction === 'destination') { activatePwaPanel('send', { instant: true }); openDestForm(); }
    else if (launchAction === 'camera') { activatePwaPanel('send', { instant: true }); setTimeout(function () { $('pick-camera').click(); }, 150); }
    else if (launchAction === 'files') { activatePwaPanel('send', { instant: true }); setTimeout(function () { $('pick-files').click(); }, 150); }
    else if (launchAction === 'shares') { activatePwaPanel('shares', { instant: true }); }
    // OS "Open with Direct-Xfer" (manifest file_handlers): receive the launched files.
    if ('launchQueue' in window && window.launchQueue && window.launchQueue.setConsumer) {
      window.launchQueue.setConsumer(function (params) {
        if (!params || !params.files || !params.files.length) return;
        Promise.all(params.files.map(function (h) { return h.getFile().catch(function () { return null; }); }))
          .then(function (fs) { var files = fs.filter(Boolean); if (files.length) addFiles(files); });
      });
    }
  }


  function checkpointActiveTransfers() {
    items.filter(function (it) {
      return it.snapshot && ['sending', 'waiting-network', 'waiting', 'encrypting', 'optimizing'].indexOf(it.state) !== -1;
    }).forEach(function (it) {
      if (it.state !== 'paused') it.resumeOnOpen = true;
      // OPFS-backed records are metadata-only and safe to checkpoint frequently.
      if (it.opfsPath || it.preparedOpfsPath) idbPut(QUEUE_STORE, queueRecord(it)).catch(function () {});
      else persistItem(it, false);
    });
  }
  function checkpointPersistentUiState() {
    checkpointActiveTransfers();
    // Never persist the history/image snapshots before the restore has hydrated the
    // in-memory state, or an early checkpoint (update adoption, pagehide) would
    // overwrite the good localStorage backups with empty data and lose the history
    // across a PWA update.
    if (!hydrated) return;
    persistHistorySnapshot();
    persistImageActionHistory();
    Array.from(imageRecordsByToken.values()).forEach(function (photo) { persistImageRecord(photo); });
  }
  window.addEventListener('pagehide', checkpointPersistentUiState);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') checkpointPersistentUiState(); });

  // On-device diagnostic (open /app/?diag=1). Reports every layer of the image
  // pipeline so a mobile-only failure can be pinpointed without desktop dev tools.
  async function runImageDiagnostics() {
    var L = [];
    L.push('Direct-Xfer diag · v' + APP_VERSION + ' · ' + APP_BUILD);
    L.push('origin: ' + location.origin);
    L.push('standalone: ' + isStandaloneApp());
    try {
      var st = await fetch('/app/device/status', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); });
      L.push('device: paired=' + !!st.paired + ' adminSession=' + !!st.adminSession + ' csrf=' + !!st.csrf);
    } catch (e) { L.push('device: ERR ' + e); }
    try {
      var ir = await fetch('/app/images?limit=500&includeInactive=1', { credentials: 'same-origin', cache: 'no-store' });
      var body = null; try { body = await ir.json(); } catch (_) {}
      L.push('/app/images: HTTP ' + ir.status + ' · count=' + (body && body.images ? body.images.length : '(non-JSON)'));
    } catch (e) { L.push('/app/images: ERR ' + e); }
    try {
      var html = await fetch('/app/', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.text(); });
      var m = html.match(/id="dx-image-bootstrap"[^>]*>([\s\S]*?)<\/template>/);
      if (m) L.push('server bootstrap in /app/: count=' + decodeImageBootstrap(m[1]).length);
      else if (html.indexOf('DX_IMAGE_BOOTSTRAP') !== -1) L.push('server bootstrap: PLACEHOLDER NOT REPLACED');
      else L.push('server bootstrap: template ABSENT');
    } catch (e) { L.push('server bootstrap: ERR ' + e); }
    var idbState = 'ok';
    try { var idb = await idbGetAll(IMAGE_STORE); L.push('IndexedDB images: ' + (Array.isArray(idb) ? idb.length : 'n/a')); }
    catch (e) { idbState = String(e && e.message || e); L.push('IndexedDB images: FAILED (' + idbState + ')'); }
    try { var bk = JSON.parse(localStorage.getItem(IMAGE_BACKUP_KEY) || '[]'); L.push('localStorage backup: ' + (Array.isArray(bk) ? bk.length : 'n/a')); }
    catch (e) { L.push('localStorage backup: ERR ' + e); }
    try { L.push('image rows in DOM: ' + document.querySelectorAll('#imglink-list [data-token]').length); } catch (_) {}
    try { L.push('records in memory: ' + imageRecordsByToken.size); } catch (_) {}
    try { L.push('SW controlled: ' + !!(navigator.serviceWorker && navigator.serviceWorker.controller)); } catch (_) {}
    try { if (navigator.storage && navigator.storage.persisted) L.push('storage persisted: ' + (await navigator.storage.persisted())); } catch (_) {}
    var text = L.join('\n');
    try { console.log('[dx-diag]\n' + text); } catch (_) {}
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0b1020;color:#8fdc9a;font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;padding:16px;overflow:auto;';
    var pre = document.createElement('pre'); pre.textContent = text; pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0 0 14px;';
    var bcopy = document.createElement('button'); bcopy.textContent = 'Copier'; bcopy.style.cssText = 'margin:0 8px 0 0;padding:10px 16px;font:14px sans-serif;border-radius:8px;border:0;';
    bcopy.onclick = function () { copyText(text).then(function () { bcopy.textContent = 'Copié ✓'; }, function () {}); };
    var bclose = document.createElement('button'); bclose.textContent = 'Fermer'; bclose.style.cssText = 'padding:10px 16px;font:14px sans-serif;border-radius:8px;border:0;';
    bclose.onclick = function () { ov.remove(); };
    ov.appendChild(pre); ov.appendChild(bcopy); ov.appendChild(bclose);
    document.body.appendChild(ov);
  }

  initialize().catch(function (e) { console.error(e); toast(t('error'), 'err'); });
  if (launchParams.get('diag') === '1') setTimeout(function () { runImageDiagnostics().catch(function (e) { try { console.error(e); } catch (_) {} }); }, 3000);
})();
