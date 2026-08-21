'use strict';
/* Direct-Xfer — PWA compagnon durable.
 * - file d'attente IndexedDB + fichiers durables OPFS
 * - identifiants d'upload stables + reprise par morceaux
 * - pause/reprise, reconnexion automatique et parallélisme borné
 * - Web Share Target par lots, E2E DXE1, association d'appareil limitée à /app
 * - OCR local: les documents restent sur l’appareil; moteurs OCR/PDF chargés à la demande
 */
(function () {
  // Build tag, shown in the footer so a user can confirm at a glance which version
  // is actually running after an update. Keep it in lock-step with sw.js VERSION.
  var APP_VERSION = '1.69.0';
  var APP_BUILD = '2026.08.20-pwa407';
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
  var LARGE_TRANSFER_TEST_BYTES = 100 * 1024 * 1024;
  var NETWORK_TEST_MAX_AGE_MS = 10 * 60 * 1000;
  var NETWORK_GRAPH_POINTS = 72;
  // OCR #25: the recognition happens in-browser. Only engine/model files are fetched
  // from the pinned CDN on first use; the selected image/PDF bytes are never uploaded.
  var OCR_TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
  var OCR_TESSERACT_WORKER_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js';
  var OCR_TESSERACT_CORE_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0';
  var OCR_ENGINE_SCRIPT_TIMEOUT_MS = 20000;
  var OCR_ENGINE_INIT_TIMEOUT_MS = 90000;
  var OCR_PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.min.mjs';
  var OCR_PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs';
  var PRIVACY_PDFLIB_URL = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  var PRIVACY_JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  var MOBILE_DURABLE_LIMIT = 32 * 1024 * 1024;
  var DESKTOP_DURABLE_LIMIT = 128 * 1024 * 1024;
  var PERSIST_DEBOUNCE_MS = 5000;
  var DB_NAME = 'direct-xfer-pwa';
  var DB_VERSION = 7;
  var QUEUE_STORE = 'queue';
  var DEST_STORE = 'destinations';
  var META_STORE = 'meta';
  var HISTORY_STORE = 'history';
  var IMAGE_STORE = 'images';
  var OCR_INDEX_STORE = 'ocrIndex';
  var IMAGE_BACKUP_KEY = 'dx-pwa-images-backup-v1';
  var DEST_BACKUP_KEY = 'dx-pwa-dests-backup-v1';
  var QUEUE_BACKUP_KEY = 'dx-pwa-queue-backup-v1';
  var MAX_IMAGE_BACKUP = 500;
  var MAX_HISTORY = 50;
  var OPFS_QUEUE_DIR = 'durable-transfers-v1';
  var OPFS_COPY_CHUNK = 4 * 1024 * 1024;
  var launchParams = new URLSearchParams(location.search);
  var launchAction = launchParams.get('action') || '';
  var launchFocusToken = launchParams.get('focus') || '';
  var launchDestinationUrl = launchParams.get('dest') || '';
  var launchOpenCenter = launchParams.get('opencenter') === '1'; // cold start
  var launchCenterPanel = launchParams.get('panel') || '';
  var pairedClaim = launchParams.get('paired') === '1';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, options) {
    options = options || {};
    var node = document.createElement(tag);
    if (options.class) node.className = options.class;
    if (options.text != null) node.textContent = options.text;
    if (options.attrs) Object.keys(options.attrs).forEach(function (name) {
      var value = options.attrs[name];
      if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? '' : String(value));
    });
    return node;
  }

  var STRINGS = {
    fr: {
      imgEditUploaded: 'Modifier avec l’éditeur photo', imgEditUploadedDone: 'Image modifiée, URL conservée ✓',
      notificationsTitle: 'Notifications', notificationsLoading: 'Chargement…', notificationsEmpty: 'Aucune notification.', notificationsFirstView: 'Première vue de « {name} »', notificationsDelete: 'Supprimer cette notification', notificationsClearAll: 'Tout supprimer', notificationsClearConfirm: 'Supprimer toutes les notifications ?', notificationsLoadMore: 'Afficher plus ({n})', notificationsLinkCopied: 'Lien copié ✓', notificationsSound: 'Son à la réception', notificationsSoundOn: 'Son activé', notificationsSoundOff: 'Son désactivé', notificationsPrefs: 'Préférences', notificationsPrefsHint: 'Décochez une catégorie pour ne plus créer ses notifications.', notificationsPrefsSaved: 'Préférences enregistrées ✓', notificationsSettingsTitle: 'Centre de notifications', notificationsSettingsHint: 'Choisissez les catégories de notifications à recevoir dans le centre de notifications pour ce compte.', notificationsSettingsRequired: 'Toujours activée', notificationsSettingsRequiredHint: 'Les notifications Sécurité, Maintenance et Santé système restent toujours activées.', notificationsSettingsSaving: 'Enregistrement…', notificationsSettingsError: 'Impossible d’enregistrer les préférences.', notificationsRulesTitle: 'Alertes personnalisées', notificationsRulesHint: 'Créez jusqu’à 50 règles qui déclenchent une notification lorsqu’un seuil est atteint.', notificationsRuleMetric: 'Mesure', notificationsRuleTarget: 'Lien', notificationsRuleThreshold: 'Seuil', notificationsRuleLabel: 'Nom (facultatif)', notificationsRuleAdd: 'Ajouter la règle', notificationsRuleAllTargets: 'Tous mes liens compatibles', notificationsRuleTargetUnavailable: 'Lien indisponible ou supprimé', notificationsRuleEmpty: 'Aucune règle personnalisée.', notificationsRuleSaved: 'Règle enregistrée ✓', notificationsRuleDeleted: 'Règle supprimée', notificationsRuleError: 'Impossible d’enregistrer la règle.', notificationsRuleEnable: 'Activer', notificationsRuleDisable: 'Désactiver', notificationsRuleDelete: 'Supprimer', notificationsRuleMetricViews: 'Vues', notificationsRuleMetricDownloads: 'Téléchargements', notificationsRuleMetricBytesServed: 'Données servies (Go)', notificationsRuleMetricReceivedBytes: 'Données reçues (Go)', notificationsRuleCustomTitle: 'Alerte personnalisée : {name}', notificationsTimeAgo: 'il y a {v}', notificationsCount: '{n} notification(s)', notificationsFilteredCount: '{shown} / {total} notification(s)', notificationsNoMatch: 'Aucune notification ne correspond aux filtres.', notificationsFilters: 'Filtres de notifications', notificationsCategoryFilter: 'Filtrer par catégorie', notificationsSeverityFilter: 'Filtrer par gravité', notificationsAllCategories: 'Toutes les catégories', notificationsAllSeverities: 'Toutes les gravités', notificationsSearch: 'Rechercher…', notificationsSearchAria: 'Rechercher dans les notifications', notificationsCategoryActivity: 'Activité', notificationsCategoryVisitors: 'Visiteurs', notificationsCategoryThresholds: 'Seuils', notificationsCategoryTraffic: 'Trafic', notificationsCategoryImages: 'Images', notificationsCategoryPwa: 'PWA', notificationsCategoryReceptions: 'Réceptions', notificationsCategorySearch: 'Recherche / OCR', notificationsCategorySecurity: 'Sécurité', notificationsCategoryShares: 'Partages', notificationsCategorySystemHealth: 'Santé système', notificationsCategoryMaintenance: 'Maintenance', notificationsCategoryNetwork: 'Réseau', notificationsCategoryRestarts: 'Redémarrages', notificationsCategoryUpdates: 'Mises à jour', notificationsCategoryTransfers: 'Transferts', notificationsCategoryDescShares: 'Téléchargements, expiration, limites et changements concernant les liens de partage.', notificationsCategoryDescReceptions: 'Dépôts reçus, fichiers disponibles et quotas des liens de réception.', notificationsCategoryDescImages: 'Premières vues, remplacements d’images et régénération des variantes.', notificationsCategoryDescTransfers: 'Transferts terminés ou échoués, abandons et reprises impossibles.', notificationsCategoryDescVisitors: 'Nouveaux pays et nouveaux navigateurs ou appareils visiteurs.', notificationsCategoryDescThresholds: 'Seuils de vues et de téléchargements atteints sur vos liens.', notificationsCategoryDescTraffic: 'Volume de téléchargement inhabituel et liens devenant viraux.', notificationsCategoryDescSearch: 'Échecs OCR et problèmes d’indexation pour la recherche.', notificationsCategoryDescPwa: 'Appareils PWA, abonnements Push et permissions de notifications.', notificationsCategoryDescSecurity: 'Connexions inhabituelles, mots de passe, DLP et autres alertes de sécurité.', notificationsCategoryDescSystemHealth: 'Pannes de service, erreurs de configuration et problèmes système importants.', notificationsCategoryDescMaintenance: 'Nettoyages automatiques et suppressions de fichiers selon les règles de rétention.', notificationsCategoryDescNetwork: 'Changements d’adresse IP publique et événements réseau du service.', notificationsCategoryDescRestarts: 'Redémarrages détectés de Direct-Xfer, avec durée d’indisponibilité lorsque disponible.', notificationsCategoryDescUpdates: 'Mises à jour disponibles et confirmation après installation.', notificationsSeverityInfo: 'Information', notificationsSeveritySuccess: 'Succès', notificationsSeverityWarning: 'Avertissement', notificationsSeverityCritical: 'Critique',
      title: 'Envoyer', navMain: 'Navigation principale', navSend: 'Envoyer', navSendHint: 'Préparer et envoyer des fichiers vers une destination.', navImages: 'Images', navImagesHint: 'Créer, gérer et suivre vos liens d’image.', navActivity: 'Activité', navActivityHint: 'Consulter le même historique d’activité persistant que dans Direct-Xfer standard.', navSystemHealth: 'Santé', navSystemHealthHint: 'Surveiller la santé système, les performances et les diagnostics du serveur.', serverActivity: 'Activité', serverActivityHint: 'Historique persistant des événements pertinents de Direct-Xfer.', serverActivitySearch: 'Rechercher une activité…', serverActivityLoading: 'Chargement de l’activité…', serverActivityEmpty: 'Aucune activité enregistrée.', serverActivityLoadFail: 'Impossible de charger l’historique d’activité.', serverActivityFiltersAria: 'Filtres d’activité', serverActivityKindAria: 'Type d’activité', serverActivityKindAll: 'Tous les types', serverActivityKindTransfer: 'Transferts', serverActivityKindAdmin: 'Administration', serverActivityKindSecurity: 'Sécurité', serverActivityKindVisitor: 'Visiteurs', serverActivityKindSystem: 'Système', serverActivityShareAll:'Tous les partages', serverActivityImagesOnly:'Images seulement', serverActivityPwaOnly:'PWA seulement', serverActivityHideRoutine:'Masquer système routinier', serverActivityReset: 'Effacer les filtres', serverActivitySummary: '{shown} affichée(s) sur {total}', localTransferHistory: 'Historique des transferts de cet appareil', activityImageDeleted: 'Image supprimée : {name}', activityShareDeleted: 'Partage supprimé : {name}', activityImagePurged: 'Image supprimée définitivement : {name}', activitySharePurged: 'Partage supprimé définitivement : {name}', activityImageRestored: 'Image restaurée : {name}', activityShareRestored: 'Partage restauré : {name}', activityTransferDone: 'Transfert terminé : {name}', activityTransferFailed: 'Transfert interrompu : {name}', navSettings: 'Réglages', navSettingsHint: 'Configurer la PWA, la sécurité et le stockage.', navShares: 'Partages', navSharesHint: 'Créer des liens de partage depuis les fichiers du serveur.', sharesTitle: 'Partager des fichiers du serveur', sharesHint: 'Parcourez les fichiers de votre serveur et créez des liens de partage directs.', sharesAdminRequired: 'Connectez-vous avec un compte administrateur pour parcourir les fichiers du serveur.', sharesSignIn: 'Se connecter en administrateur', sharesBrowse: 'Fichiers du serveur', sharesUp: 'Dossier parent', sharesCreate: 'Créer le partage', sharesNoneSelected: 'Aucun fichier sélectionné.', sharesSelected: '{n} élément(s) sélectionné(s)', sharesExpiry: 'Expiration', sharesExpiryNever: 'Jamais', sharesExpiry1h: '1 heure', sharesExpiry1d: '1 jour', sharesExpiry7d: '7 jours', sharesExpiry30d: '30 jours', sharesExpiryForcedNever: 'L’administrateur a configuré les nouveaux partages pour ne jamais expirer.', sharesMaxDownloads: 'Téléchargements max (0 = illimité)', sharesRateLimit: 'Débit maximal (Ko/s, 0 = illimité)', sharesRateEdit: 'Débit', sharesRatePrompt: 'Débit maximal en Ko/s (0 = illimité) :', sharesRateSaved: 'Débit mis à jour ✓', sharesRateFail: 'Impossible de modifier le débit', sharesPassword: 'Mot de passe (facultatif)', sharesPasswordPlaceholder: '—', sharesCreateBtn: 'Créer le lien de partage', sharesCreating: 'Création…', sharesCreated: 'Partage créé ✓', sharesCreatedLink:'Lien prêt à partager', sharesCreateFail: 'Échec de la création du partage', sharesDlpWarning: 'DLP : {n} détection(s) sensible(s) ({level}). Publier quand même ?', sharesDlpBlocked: 'Publication bloquée par la politique DLP.', dlpTest: 'Tester DLP', dlpTestQueue: '🛡 Tester DLP', dlpTestSelected: '🛡 Tester DLP', dlpTesting: 'Analyse DLP…', dlpSafe: 'DLP ✓ aucun contenu sensible détecté', dlpFound: 'DLP : {n} détection(s) ({level})', dlpLocalBlocked: 'Envoi bloqué par la politique DLP avant transfert.', dlpLocalConfirm: 'DLP a détecté {n} élément(s) sensible(s) ({level}) dans {files} fichier(s). Envoyer quand même ?', dlpScanSkipped: 'DLP : {n} fichier(s) trop volumineux/non analysé(s)', dlpScanFailed: 'Test DLP impossible : {error}', dlpOcrIncomplete: 'DLP incomplet : OCR impossible pour {n} fichier(s)', dlpPolicyLoading: 'Chargement de la politique DLP…', dlpPolicyDisabled: 'DLP désactivé sur le serveur', dlpPolicyText: 'Politique {mode} · {mb} Mo/fichier · OCR {ocr}', dlpAutoRules:'Réaction automatique selon la gravité', dlpAutoRulesHint:'Choisissez l’action appliquée automatiquement pour chaque niveau de gravité détecté.', dlpAutoReadOnly:'Les réactions automatiques DLP sont modifiables uniquement depuis un appareil owner/admin.', dlpSeverityLow:'Faible', dlpSeverityMedium:'Moyenne', dlpSeverityHigh:'Élevée', dlpSeverityCritical:'Critique', dlpAutoSave:'Enregistrer les réactions DLP', dlpAutoSaved:'Réactions DLP enregistrées ✓', dlpAutoSaveFail:'Impossible d’enregistrer les réactions DLP', dlpModeWarn: 'Avertir', dlpModeBlock: 'Bloquer', dlpModeQuarantine:'Quarantaine', dlpModeLog: 'Journaliser', dlpLocalQuarantined:'Envoi retenu par la politique de quarantaine DLP ; aucun octet n’a été envoyé.', dlpIncompleteQuarantined:'Envoi retenu : l’analyse DLP est incomplète et la politique impose la quarantaine.', dlpServerQuarantined:'Contenu placé en quarantaine par la politique DLP.', dlpQuarantineFailed:'La mise en quarantaine DLP a échoué; aucun contenu n’a été publié.', dlpOcrOn: 'activé', dlpOcrOff: 'désactivé', dlpIncompleteBlocked: 'Envoi bloqué : l’analyse DLP est incomplète.', dlpIncompleteConfirm: 'L’analyse DLP est incomplète pour {files} fichier(s) et a trouvé {n} détection(s). Envoyer quand même ?', dlpPolicyUnavailable: 'Politique DLP indisponible : envoi suspendu par sécurité.', dlpScanIncomplete: 'DLP incomplet : {n} élément(s) non analysé(s)', sharesLibrary: 'Vos partages', sharesEmpty: 'Aucun partage pour l’instant.', sharesBrowseFail: 'Impossible de lire ce dossier.', sharesLoginNeeded: 'Connexion administrateur requise.', sharesOpen: 'Ouvrir', sharesCopy: 'Copier', sharesRevoke: 'Révoquer', sharesRevoked: 'Partage révoqué ✓', sharesRevokeFail: 'Échec de la révocation', sharesRevokeConfirm: 'Révoquer ce partage ? Le lien cessera de fonctionner.', sharesColor: 'Couleur de la carte (facultatif)', sharesAdminNote: 'Note privée (facultatif)', sharesAdminNotePlaceholder: 'Visible uniquement par les administrateurs', sharesEditMeta: 'Couleur / note', sharesArchive: 'Archiver', sharesUnarchive: 'Désarchiver', sharesShowArchived: '🗄 Archives', sharesDuplicate: 'Dupliquer', sharesDuplicatePrompt: 'Nom du partage dupliqué :', sharesDuplicated: 'Partage dupliqué ✓', sharesDuplicateFail: 'Duplication impossible', sharesReactivate: 'Réactiver', sharesReactivated: 'Lien réactivé ✓', sharesReactivateMissing: 'Les données du lien ne sont plus disponibles', sharesTrash: 'Corbeille globale', sharesTrashHint: 'Images, réceptions et partages supprimés peuvent être restaurés ici tant qu’ils sont conservés.', sharesTrashEmpty: 'La corbeille est vide.', sharesTrashRestore: 'Restaurer', sharesTrashRestoreSelected:'Restaurer la sélection', sharesTrashSelected:'{n} sélectionné(s)', sharesTrashRestoreSelectedOk:'{n} élément(s) restauré(s) ✓', sharesTrashRestored: 'Élément restauré ✓', sharesTrashDelete: 'Supprimer définitivement', sharesTrashDeleteAll: 'Tout supprimer définitivement', sharesTrashDeleteConfirm: 'Supprimer définitivement « {name} » ? Cette action est irréversible.', sharesTrashDeleteAllConfirm: 'Supprimer définitivement tous les éléments de la corbeille ? Cette action est irréversible.', sharesTrashDeleted: 'Élément supprimé définitivement ✓', sharesTrashAllDeleted: '{n} élément(s) supprimé(s) définitivement ✓', sharesTrashDeleteFail: 'Suppression définitive impossible', sharesGlobalSearch: 'Rechercher', sharesGlobalSearchPlaceholder: 'Rechercher liens, utilisateurs, journaux et contenu…', sharesGlobalSearchEmpty: 'Aucun résultat.', sharesGlobalSearchFail: 'Recherche impossible', sharesArchivedBadge: 'Archivé', sharesPinnedBadge:'Épinglé', sharesPin:'Épingler', sharesUnpin:'Désépingler', sharesNeverDownloaded:'Jamais téléchargé', sharesPasswordProtected:'Mot de passe', sharesExpiresSoon:'Expire bientôt', sharesTotalSize:'Taille totale : {size}', sharesRevokedBadge: 'Révoqué', sharesItems: '{n} élément(s)', sharesReceptions: 'Liens de réception', sharesReceptionsEmpty: 'Aucun lien de réception.', sharesReceived: '{bytes} reçus', sharesDownloadingNow: '{n} téléchargement(s) en cours', threadTitle: 'Discussion', threadEmpty: 'Aucun message.', threadReplyPh: 'Répondre au visiteur…', threadSend: 'Envoyer', threadSending: 'Envoi…', threadError: 'Envoi impossible, réessayez.', threadYou: 'Vous', threadVisitor: 'Visiteur', openAdmin: "Ouvrir l'administration", language: 'Langue', theme: 'Thème', copyLink: 'Copier le lien', pasteLink: 'Coller un lien', editDestination: 'Modifier la destination', addDestination: 'Ajouter une destination', passwordPlaceholder: 'Mot de passe du lien', destinationPlaceholder: 'Lien ou jeton de réception', destinationNamePlaceholder: 'Nom facultatif de la destination', senderPlaceholder: 'Nom demandé par ce lien', globalProgress: 'Progression globale', keyPlaceholder: 'Clé de chiffrement du lien', titlePlaceholder: 'Contenu partagé', themeDark: 'Sombre', themeLight: 'Clair', themeAuto: 'Auto', install: 'Installer', installIosHint: 'Pour installer Direct-Xfer : touchez le bouton Partager du navigateur, puis « Sur l’écran d’accueil ».', installBrowserHint: 'Chrome n’a pas encore validé l’installation complète. Ne choisissez pas un simple raccourci : utilisez une adresse HTTPS avec certificat reconnu, touchez la page et gardez-la ouverte quelques instants.', installHttpsRequired: 'Installation complète impossible depuis cette adresse HTTP ou ce certificat non reconnu. Android ne peut créer qu’un raccourci. Ouvrez Direct-Xfer en HTTPS avec un certificat valide.', installSecurePending: 'Installation en préparation. Dans Chrome, touchez la page et gardez-la ouverte environ 30 secondes. Si le logo n’apparaît pas, vérifiez que le certificat HTTPS est reconnu par Android.', installOpenHttps: 'Ouvrir en HTTPS',
      offline: 'Hors ligne — les envois reprendront à la reconnexion.', updateReady: 'Une nouvelle version est disponible.', updateNow: 'Actualiser', pullToRefresh: 'Glissez vers le bas pour actualiser', releaseToRefresh: 'Relâchez pour actualiser', refreshing: 'Actualisation…', backExit: 'Appuyez à nouveau pour quitter',
      destination: 'Destination', destinationHint: 'Un lien de réception Direct-Xfer de cette instance.', linkOrToken: 'Lien ou jeton', displayName: 'Nom affiché',
      rememberDestination: 'Mémoriser cette destination sur cet appareil', rememberKey: 'Mémoriser aussi la clé secrète sur cet appareil', scanQr: '📷 Scanner un QR', saveDestination: 'Ajouter', updateDestination: 'Enregistrer', createLinkTitle: 'Créer un lien de réception', newLink: 'Nouveau', createLinkName: 'Nom du nouveau lien', createLinkPlaceholder: 'Ex. Photos vacances', createLinkHint: 'Un nouveau lien de réception sera créé et ajouté à vos destinations. Partagez-le pour recevoir des fichiers.', createDo: 'Créer le lien', creating: 'Création…', createOk: 'Lien créé ✓', createFail: 'Création du lien impossible',
      imgLinksTitle: 'Liens d’image', imgLinksHint: 'Créez des liens directs vers vos images : chaque lien offre les versions Pleine, Mini et Micro, sans page relais.', imgLinksAdd: 'Ajouter des images', imgCreateTitle: 'Créer des liens', imgCreateHint: 'Choisissez les images à partager ou modifiez-en une avant l’envoi.', imgLibraryTitle: 'Vos liens', imgLibraryHint: 'Recherchez, triez et gérez les images déjà partagées.', imgGlobalActions: 'Actions globales', imgManageActions: 'Gérer le lien', imgStripExif: 'Retirer les données EXIF/GPS avant le partage', imgStripExifHint: 'Le nettoyage est effectué localement sur cet appareil avant le téléversement.', imgStrippingMetadata: 'Suppression des EXIF/GPS…', imgMetadataRemoved: 'EXIF/GPS retirés', imgUploading: 'Téléversement…', imgThumbing: 'Mini et Micro…', imgReady: 'Prêt', imgCopyBBCode: 'Copier le BBCode', imgCopied: 'Lien copié ✓', clearSearch: 'Effacer la recherche', imgListEmpty: 'Aucune image partagée pour l’instant. Utilisez « Ajouter des images » pour créer votre premier lien.', imgNoMatch: 'Aucune image ne correspond à votre recherche.', destEmptyHint: 'Aucune destination. Ajoutez un lien de réception (＋) ou créez-en un avec « Nouveau ».', destEmoji: 'Emoji (repère visuel)', imgCopyImage: 'Copier l’image', imgCompare: 'Comparer', imgCompareTitle: 'Comparer les formats', pwStrengthLabel: 'Force du mot de passe', pwWeak: 'Faible', pwMedium: 'Moyen', pwStrong: 'Fort', historyResend: 'Renvoyer', historyDestGone: 'Destination introuvable — ajoutez-la à nouveau.', resendReady: 'Destination sélectionnée — ajoutez vos fichiers.', imgLinkFail: 'Échec de la création du lien', imgVariantsFailed: 'Image enregistrée, mais Mini/Micro n’ont pas pu être mises à jour.', revokeShare: 'Révoquer', revokeConfirm: 'Révoquer ce partage ? Le lien cessera de fonctionner.', revokeSuccess: 'Révoqué ✓', revokeFail: 'Échec de la révocation', imgVariantFull: 'Pleine', imgVariantMini: 'Mini', imgVariantMicro: 'Micro', imgViews: '{n} vues', imgVisitors: '{n} visiteurs', imgStatsLoading: 'Statistiques…', imgStatsUnavailable: 'Statistiques indisponibles', imgStatsButton: '📊 Stats', imgStatsTitle: 'Statistiques détaillées', imgStatsOverview: 'Vue d’ensemble', imgStatsCopies: 'Copies de l’image', imgStatsRecent: 'Accès récents à l’image', imgStatsStorage: 'Stockage', imgStatsDimensions: 'Dimensions', imgStatsLastView: 'Dernière vue', imgStatsCreated: 'Créée', imgStatsExpiry: 'Expiration', imgStatsStatus: 'État', imgStatsActive: 'Active', imgStatsInactive: 'Inactive', imgStatsExpired: 'Expirée', imgStatsNoRecent: 'Aucun accès récent enregistré.', imgStatsNever: 'Jamais', imgStatsUnknown: 'Inconnu',
      imgSearch: 'Rechercher nom, tag ou texte OCR…', imgSortLabel: 'Trier les images', imgSortNewest: 'Plus récentes', imgSortOldest: 'Plus anciennes', imgSortName: 'Nom', imgSortSize: 'Taille', imgSortViews: 'Vues', imgSortVisitors: 'Visiteurs', imgSortExpiry: 'Expiration', imgFilterLabel: 'Filtrer les images', imgFilterAll: 'Toutes', imgFilterActive: 'Actives', imgFilterPopular: 'Populaires', imgFilterLarge: 'Volumineuses', imgFilterExpiring: 'Bientôt expirées', imgFilterFavorite: 'Favorites', imgFilterProtected: 'Protégées', imgAdvancedOptions: 'Options des images', imgCompact: 'Affichage compact', imgHideExpired: 'Masquer les images expirées', imgAutoCopy: 'Copier automatiquement après création', imgDefaultExpiry: 'Expiration favorite', imgMaxViews: 'Limite de vues', imgPassword: 'Mot de passe', imgTags: 'Tags', imgPrivateNote: 'Note privée', imgRenameTemplate: 'Modèle de renommage', imgBulkEdit: 'Modifier', imgCreateAlbum: 'Créer un album', imgDashboard: 'Statistiques graphiques', imgAlbums: 'Albums partageables', imgActionHistory: 'Historique des actions d’image', imgSelected: '{n} sélectionnée(s)', imgEditPrompt: 'Modifier les images sélectionnées', imgAlbumName: 'Nom de l’album', imgAlbumCreated: 'Album créé ✓', imgSettingsSaved: 'Réglages enregistrés ✓', imgDuplicateFound: 'Cette image a déjà été partagée. Continuer quand même ?', imgExpirySoon: 'Le lien « {name} » expire bientôt.', imgUndoRevoke: 'Image retirée — Annuler ?', imgRevokePending: 'Révocation dans {n} s…', imgCancelRevoke: 'Annuler révocation', imgRevokeCancelled: 'Révocation annulée ✓', imgQrDownloaded: 'QR téléchargé ✓', imgFavorite: 'Favorite', imgUnfavorite: 'Retirer des favorites', imgExpired: 'Expirée', imgInactive: 'Inactive', imgViewLimitReached: 'Limite de vues atteinte', imgProtected: 'Protégée', imgViewLimit: '{n} vues max', imgNoAlbums: 'Aucun album.', imgVariantAuto: 'Automatique', imgReplace: 'Remplacer sans changer le lien', imgVersions: 'Versions', imgReplaceDone: 'Image remplacée, URL conservée ✓', imgResizeMini: 'Redimensionner la Mini', imgResizeMiniPrompt: 'Nouvelle taille de la Mini : un nombre de pixels (côté le plus long, ex. 250) OU un pourcentage de la taille totale (ex. 50%). La Micro sera la moitié :', imgResizeMiniInvalid: 'Valeur invalide : pixels (16 à 4096) ou pourcentage (1 à 100 %).', imgResizeMiniDone: 'Mini redimensionnée en {w}×{h} ✓', imgRestoreVersion: 'Restaurer une version', imgVersionRestored: 'Version restaurée ✓', imgAdaptiveReady: 'Optimisation adaptative', albumInvites: 'Invitations', albumInviteCreate: 'Créer une invitation', albumInviteRole: 'Rôle (reader, contributor, manager)', albumInviteCopied: 'Lien d’invitation copié ✓', albumInviteRevoke: 'Révoquer une invitation', albumCollabSummary: '{n} invitation(s)', imgAlbumCopied: 'Lien de l’album copié ✓', imgChartSummary: '{images} images · {views} vues · {visitors} visiteurs · {bytes}', imgComparePeriod: 'Période comparative', imgCompare7d: '7 jours', imgCompare30d: '30 jours', imgCompareSummary: '{days} j vs période précédente : {views} vues · {created} images créées', imgCompareNew: 'nouveau', imgHotlinkHosts: 'Domaines autorisés pour l’intégration', imgHotlinkPlaceholder: 'forum.exemple.com, *.site.net', imgHotlinkHint: 'Vide = protection désactivée. Les visites directes restent autorisées.', imgHotlinkProtected: 'Anti-hotlink', imgNotifyFirstView: 'Notifier à la première consultation', imgFirstViewArmed: 'Alerte 1re vue', imgFirstViewSent: 'Première vue notifiée', imgFirstViewToast: '👁 Première consultation de « {name} »', imgSmartBlur: 'Floutage intelligent local', imgSmartBlurFaces: 'Visages', imgSmartBlurFacesPlates: 'Visages et plaques', imgSmartBlurAll: 'Visages, plaques et texte sensible', imgSmartBlurHint: 'Analyse locale avec révision avant envoi; aucune image n’est envoyée à un service externe.', imgSmartBlurAnalyzing: 'Analyse locale…', imgSmartBlurReady: '{n} zone(s) masquée(s). Vérifiez puis appliquez.', imgSmartBlurUnsupported: 'Détection des visages non prise en charge par ce navigateur; ajoutez les zones manuellement.', imgSmartBlurSkip: 'Continuer sans flou', imgRetentionRules: 'Règles automatiques de rétention', imgRetentionWarning: 'Ces règles révoquent définitivement les images et suppriment leurs fichiers. Elles sont désactivées par défaut.', imgRetentionAge: 'Âge maximal (jours)', imgRetentionInactive: 'Inactivité maximale (jours)', imgRetentionViews: 'Révoquer après ce nombre de vues', imgRetentionStorage: 'Stockage maximal (Mo)', imgRetentionSave: 'Enregistrer et appliquer', imgRetentionSaved: 'Règles de rétention enregistrées ✓', imgRetentionResult: '{n} image(s) révoquée(s) · {bytes} libérés', imgRetentionSummary: '{n} image(s) · {bytes}', enabled: 'Activé', disabled: 'Désactivé', optional: 'Facultatif', refresh: 'Rafraîchir', themeSchedule: 'Selon l’heure',
      removeDestination: 'Retirer', cancel: 'Annuler', protectedLink: '🔒 Lien protégé', unlock: 'Déverrouiller', encryptedLink: '🔐 Chiffrement de bout en bout',
      encryptionKey: 'Clé du lien', passphrase: 'Phrase secrète', addFiles: 'Ajouter des fichiers', durableQueue: 'Les fichiers sont copiés dans le stockage durable avant l’envoi afin de reprendre après une fermeture de la PWA.',
      takePhoto: 'Prendre une photo', chooseFiles: 'Choisir des fichiers', chooseFolder: 'Choisir un dossier',
      optimizePhotos: 'Optimiser les photos avant envoi', parallelUploads: 'Envois parallèles', senderName: 'Votre nom', pause: 'Pause', resume: 'Reprendre',
      retryAll: '↻ Réessayer', removePending: 'Tout retirer', send: 'Envoyer', clearCompleted: 'Effacer les envois terminés', history: 'Historique local',
      clearHistory: 'Effacer l’historique', settings: 'Réglages et sécurité', autoResume: 'Reprendre automatiquement après fermeture ou reconnexion', storage: 'Stockage local',
      protectStorage: 'Protéger', passkeyTitle: 'Identification biométrique', passkeyHint: 'Utilisez l’empreinte, la reconnaissance faciale ou le verrouillage sécurisé de cet appareil pour vous connecter sans mot de passe.', passkeyAdd: 'Activer sur cet appareil', passkeyAdding: 'Activation…', passkeyAdded: 'Identification biométrique activée ✓', passkeyFailed: 'Impossible de modifier l’identification biométrique.', passkeyEmpty: 'Aucune identification biométrique enregistrée.', passkeyRemove: 'Désactiver celle-ci', passkeyRemoveConfirm: 'Désactiver cette identification biométrique ?', passkeyRemoveSharedConfirm: 'Cette identification est associée à {n} appareils. La désactiver partout ?', passkeyRemoved: 'Identification biométrique désactivée', passkeyDevices: '{n} appareil(s)', biometricDisable: 'Désactiver l’identification biométrique', biometricDisabling: 'Désactivation…', biometricDisableConfirm: 'Désactiver toutes les identifications biométriques de ce compte sur tous les appareils ?', biometricDisabled: 'Identification biométrique entièrement désactivée ✓', passkeyNamePrompt: 'Nom de la passkey (facultatif) :', passkeyCreated: 'Activée {date}', passkeyUsed: 'utilisée {date}', passkeyNeverUsed: 'jamais utilisée', passkeyCurrent: 'cet appareil', biometricChecking: 'Vérification de la compatibilité…', biometricReady: 'Compatible — vous pouvez l’activer sur cet appareil.', biometricEnabled: 'Identification biométrique activée sur cet appareil.', biometricConfigured: '{n} identification(s) biométrique(s) configurée(s) pour ce compte.', biometricUnsupported: 'La biométrie sécurisée n’est pas disponible sur cet appareil ou ce navigateur. Vous pouvez tout de même désactiver les identifications existantes.', biometricHttpsRequired: 'L’activation biométrique exige une connexion HTTPS reconnue. La désactivation reste disponible.', biometricRecentAuth: 'Reconnectez-vous pour modifier ce réglage sensible.', biometricReauth: 'Se reconnecter pour modifier', biometricReauthFailed: 'Impossible de relancer l’authentification.', biometricStatusUnavailable: 'État biométrique momentanément indisponible.', biometricCredentialName: 'Biométrie · {device}', biometricLoadFailed: 'Impossible de charger les identifications enregistrées.', autoLock: 'Verrouillage automatique', autoLockNever: 'Jamais', autoLock5: 'Après 5 minutes', autoLock15: 'Après 15 minutes', autoLock30: 'Après 30 minutes', autoLock60: 'Après 1 heure', autoLocking: 'Session verrouillée — authentifiez-vous pour continuer.',
      deviceAccess: 'Accès de cet appareil', deviceChecking: 'Vérification de l’appareil…', deviceStatusUnavailable: 'État de l’appareil indisponible. Touchez Appairer pour réessayer.', pairDevice: 'Appairer cet appareil', unpairDevice: 'Désappairer cet appareil', pairOther: 'Appairer par QR', pairOtherTitle: 'Appairer un autre appareil', pairOtherHelp: 'Scannez ce QR sur l’autre appareil. Le lien est à usage unique et expire après cinq minutes.', pairQrAlt: 'QR d’association de l’appareil', pairLink: 'Lien d’association', pairExpires: 'Expire à {date}', pairQrFailed: 'Création du QR impossible', copy: 'Copier', revokeDevice: 'Révoquer', pairedDevices: 'Appareils associés',
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
      devicePairFailed: 'Association impossible', deviceRevokeFailed: 'Révocation impossible', deviceCurrent: 'cet appareil', deviceLast: 'Dernière utilisation {date}', devicePlatformOther:'Autre', deviceVersionUnknown:'Version PWA inconnue',
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
      imgCopyAll: '🔗 Copier tous', imgOpen: 'Ouvrir dans un onglet', allImgCopied: '{n} lien(s) copié(s) ✓', noImgLinks: 'Aucun lien à copier.', imgCopyTemplate: 'Modèle de copie', copyTemplateStandard: 'Standard', copyTemplateForum: 'Forum', copyTemplateEmail: 'Courriel', imgQrZip: '🗜 QR en ZIP', imgQrZipDone: 'Archive de QR téléchargée ✓', imgExportStatsCsv: 'CSV statistiques', imgStatsCsvDone: 'Statistiques exportées ✓', imgFavoriteAction1: 'Action favorite 1', imgFavoriteAction2: 'Action favorite 2', imgFavoriteAction3: 'Action favorite 3', imgActionOpen: 'Ouvrir', imgQrDownload: 'Télécharger QR', pinItem: 'Épingler', unpinItem: 'Désépingler', tagColors: 'Couleurs des tags', tagColorsReset: 'Réinitialiser les couleurs', expiresIn: 'Expire dans {time}', expiredNow: 'Expiré',
      shareLink: 'Partager le lien', qrForLink: 'QR du lien', qrTitle: 'QR du lien de réception', qrDestHelp: 'Scannez ce code sur un autre appareil pour ouvrir le lien de réception.', qrFail: 'Création du QR impossible',
      receivedTitle: 'Contenu reçu', receivedHelp: 'Fichiers reçus sur ce lien de réception, servis par le serveur.', receivedRefresh: 'Actualiser', receivedLoading: 'Chargement…', receivedEmpty: 'Aucun fichier reçu pour l’instant.', receivedFail: 'Impossible de charger le contenu reçu.', receivedCount: '{n} fichier(s) · {size}', receivedDownload: 'Télécharger',
      receivedPendingTitle: 'En attente d’approbation', receivedApprove: 'Approuver', receivedReject: 'Rejeter', receivedPendingCount: '{n} fichier(s) en attente', createModerated: 'Validation manuelle : garder les fichiers en attente jusqu’à approbation', sharesFirstUseExpiry: 'Expiration après première utilisation (heures, 0 = désactivé)', sharesOneTime: 'Usage unique renforcé (révoquer après la première récupération complète)', sharesSmartExpiryHint: 'Expiration intelligente : les limites actives sont combinées avec « OU »; la première atteinte désactive le lien.',
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
      wifiOnly: 'Envoyer seulement en Wi-Fi', largeWifiOnly: 'Gros transferts uniquement en Wi-Fi', largeWifiThreshold: 'Seuil gros transfert', persistentTransferNotification: 'Notification Android pendant les transferts actifs', transferNotifPermissionDenied: 'Les notifications sont bloquées pour ce site.', waitingWifi: 'attente Wi-Fi', stripExif: 'Retirer les métadonnées (EXIF/GPS)',
      zipBundle: '🗜 Regrouper en ZIP', zipDone: 'Archive ZIP créée ✓', zipNeedTwo: 'Sélectionnez au moins deux fichiers.', zipping: 'Création du ZIP…',
      voiceNote: 'Note vocale', recording: 'Enregistrement', recStop: '⏹ Arrêter', recAdd: 'Ajouter à la file', recMicFail: 'Micro indisponible',
      annotate: 'Annoter', editorBeforeShare: 'Modifier avant partage', annPan: '✋ Déplacer', annPen: '✏️ Stylo', annBlur: '🌫 Flou', annRedact: '⬛ Caviarder', annDetectFaces: '🙂 Détecter les visages', annDetectPlates: '▭ Détecter les plaques', annUndo: '↶ Défaire', annClear: 'Tout effacer', annApply: 'Appliquer',
      selectedN: '{n} sélectionné(s)', bulkRemove: 'Retirer', bulkRetry: 'Réessayer', selectAll: 'Tout',
      batchNote: 'Étiquette / note (facultatif)', notePlaceholder: 'Ex. Facture, Vacances…',
      multiSend: '📢 Envoyer à plusieurs…', multiSendTitle: 'Envoyer à plusieurs destinations', multiSendHelp: 'Le lot sera envoyé à chaque destination cochée. Les liens chiffrés ou exigeant un nom sont ignorés.', multiSendGo: 'Lancer les envois', multiSendNone: 'Aucune destination compatible sélectionnée.', multiSendQueued: 'Envoi vers {n} destination(s) préparé.',
      cmdPalette: 'Palette de commandes', cmdPlaceholder: 'Tapez une commande…', cmdNoMatch: 'Aucune commande.', cmdOpenSettings: 'Ouvrir les réglages', cmdOpenHistory: 'Ouvrir l’historique', cmdToggleTheme: 'Changer de thème',
      expireLabel: 'Expiration (auto-suppression)', expNever: 'Jamais', exp1h: '1 heure', exp24h: '24 heures', exp7d: '7 jours', exp30d: '30 jours',
      liveTitle: 'Réceptions en direct', liveReceived: '📥 {name} reçu sur « {dest} »', liveEnable: 'Notifications de réception', livePush: 'Notifications push (appli fermée)', pushLanguage: 'Langue des notifications push', pushLanguageSaved: 'Langue des notifications push enregistrée ✓', livePushOn: 'Notifications push activées ✓', livePushOff: 'Notifications push désactivées', livePushFail: 'Activation des notifications impossible', liveConnected: 'En direct ✓', pushTestBtn: 'Test notifications push', pushTestHelp: 'Envoie une vraie notification via le serveur vers cet appareil.', pushTestSending: 'Test push en cours…', pushTestPreparing: 'Préparation de l’abonnement push…', pushTestAccepted: 'Service Push accepté en {ms} ms · attente d’Android…', pushTestSent: 'Notification de test envoyée ✓', pushTestDenied: 'Notifications refusées dans Android/le navigateur.', pushTestUnsupported: 'Web Push n’est pas disponible sur cet appareil.', pushTestNoSub: 'Aucun abonnement push valide pour cet appareil.', pushTestRepairing: 'Abonnement push expiré : réparation et nouvel essai…', pushTestFailed: 'Échec du test push.', pushTestDelivered: 'Notification reçue par Android {ms} ms après l’envoi ✓', pushTestAcceptedDelayed: 'Acceptée par le service Push, mais pas reçue par Android après {seconds} s.',
      copyToken: 'Copier le jeton', tokenCopied: 'Jeton copié ✓',
      pinDestination: '⭐ Épingler', unpinDestination: '☆ Détacher', pinned: 'Destination épinglée ✓', unpinned: 'Destination détachée',
      resetBatch: '↺ Réinitialiser le lot', resetBatchDone: 'Options du lot réinitialisées ✓',
      filesPending: '{n} en attente', filesTotalSummary: '{n} fichier(s) · {total} · {sent} envoyés', clipboardQueue: 'Presse-papiers', clipboardQueued: '{n} élément(s) du presse-papiers ajouté(s) ✓', clipboardEmpty: 'Le presse-papiers ne contient aucun fichier, image ou texte utilisable.', clipboardUrlFallback: 'URL ajoutée comme texte (le téléchargement direct est bloqué).', pasteText: 'Coller du texte', pastedTextName: 'texte-collé.txt', pasteTextEmpty: 'Aucun texte dans le presse-papiers.',
      masterSelect: 'Tout sélectionner', addFromUrl: 'Depuis une URL', urlPrompt: 'Adresse de l’image ou du fichier à ajouter :', urlFetching: 'Récupération…', urlFailed: 'Récupération impossible (bloquée par CORS ?)', urlAdded: 'Fichier ajouté ✓', urlInvalid: 'Adresse invalide.',
      bulkRename: '✎ Renommer', renamePrompt: 'Préfixe des noms (une numérotation sera ajoutée) :', renameDone: '{n} fichier(s) renommé(s)',
      hashTitle: 'Empreinte SHA-256', hashing: 'Calcul de l’empreinte…', hashCopied: 'Empreinte SHA-256 copiée ✓', hashFail: 'Calcul de l’empreinte impossible',
      exportSettings: 'Exporter les réglages', importSettings: 'Importer', settingsImported: 'Réglages importés ✓', settingsImportFail: 'Fichier de réglages invalide',
      accentLabel: 'Couleur d’accent', accentReset: 'Défaut',
      screenCapture: 'Capturer l’écran', captureFailed: 'Capture d’écran impossible', screenshotName: 'capture-ecran',
      undo: 'Annuler', fileRemoved: 'Fichier retiré', fileRestored: 'Fichier restauré ✓', lightboxAlt: 'Aperçu de l’image',
      sortType: 'Type', bulkInvert: '⇄ Inverser',
      ocrTitle: 'OCR local', ocrAction: 'Extraire le texte (OCR)', ocrPrivacy: 'Traitement sur cet appareil. Seuls les moteurs et modèles OCR/PDF sont téléchargés; votre document n’est envoyé à aucun service OCR.', ocrLanguage: 'Langue', ocrLangFrEn: 'Français + anglais', ocrLangFr: 'Français', ocrLangEn: 'Anglais', ocrLangEs: 'Espagnol', ocrRun: 'Extraire le texte', ocrCancel: 'Annuler l’OCR', ocrCopy: 'Copier le texte', ocrAddTxt: 'Ajouter .txt à la file', ocrSearch: 'Rechercher dans le texte…', ocrPrev: 'Précédent', ocrNext: 'Suivant', ocrReady: 'Prêt à extraire le texte.', ocrLoadingEngine: 'Chargement du moteur OCR…', ocrLoadingPdf: 'Lecture du PDF…', ocrEmbedded: 'Texte PDF incorporé détecté', ocrScanningPage: 'OCR de la page {page}/{total}…', ocrReadingPage: 'Lecture de la page {page}/{total}…', ocrComplete: 'OCR terminé · {chars} caractères', ocrNoText: 'Aucun texte détecté.', ocrFailed: 'OCR impossible : {error}', ocrCanceled: 'OCR annulé.', ocrCopied: 'Texte OCR copié ✓', ocrQueued: 'Fichier texte ajouté à la file ✓', ocrMatches: '{current}/{total}', ocrNoMatch: '0 résultat', ocrUnsupported: 'OCR disponible pour les images et les PDF.', ocrEngineNetwork: 'Le premier OCR nécessite Internet pour télécharger le moteur et les modèles.', ocrEngineTimeout: 'Le moteur OCR ne répond pas. Vérifiez la connexion Internet puis réessayez.',
      dedupeChecking: 'Recherche d’un doublon sur le serveur…', dedupeHit: 'Déjà présent sur le serveur · envoi évité ✓', dedupeUnavailable: 'Déduplication indisponible — envoi normal.',
      editorTitle: 'Éditeur photo', editorAdjust: 'Réglages', editorBrightness: 'Luminosité', editorContrast: 'Contraste', editorSaturation: 'Saturation', editorApplyAdjust: 'Appliquer les réglages', editorRotateLeft: '↶ 90°', editorRotateRight: '↷ 90°', editorFlipH: '↔ Miroir', editorFlipV: '↕ Retourner', editorResizeMax: 'Dimension max', editorResizeApply: 'Redimensionner', editorFormat: 'Format de sortie', editorQuality: 'Qualité', editorZoom: 'Zoom', editorZoomOut: 'Dézoomer', editorZoomIn: 'Zoomer', editorZoomFit: 'Ajuster', editorBrushSize: 'Grosseur du pinceau', editorLargeConfirm: 'Cette image est très grande ({w}×{h}). OK : utiliser une copie de travail de 1800 px. Annuler : conserver la résolution originale (plus de mémoire).',
      privacyInspect: 'Confidentialité', privacyTitle: 'Nettoyage des métadonnées', privacyLocal: 'Analyse et nettoyage effectués localement sur cet appareil.', privacyAnalyze: 'Analyser', privacyClean: 'Nettoyer et remplacer', privacyCleaned: 'Métadonnées sensibles nettoyées ✓', privacyNoFindings: 'Aucune métadonnée sensible évidente détectée.', privacyFindings: '{n} élément(s) sensible(s) détecté(s)', privacyImageMetadata: 'Métadonnées image (EXIF/XMP/IPTC)', privacyPdfMetadata: 'Métadonnées PDF', privacyOfficeMetadata: 'Propriétés Office', privacyThumbnail: 'Miniature incorporée', privacyAuthor: 'Auteur / dernier auteur', privacyGps: 'Coordonnées GPS', privacyCustom: 'Propriétés personnalisées', privacyUnsupported: 'Nettoyage automatique non pris en charge pour ce format.', privacyAnalyzing: 'Analyse locale…', privacyCleaning: 'Nettoyage local…',
      annDetectSensitive: '🔐 Texte sensible', sensitiveScanning: 'Recherche locale de texte sensible…', sensitiveFound: '{n} zone(s) de texte sensible masquée(s). Vérifiez le résultat.',
      ocrIndexTitle: 'Index OCR local', ocrIndexHint: 'Recherchez dans tous les documents OCR traités sur cet appareil.', ocrIndexSearch: 'Rechercher dans tous les OCR…', ocrIndexEmpty: 'Aucun document OCR indexé.', ocrIndexSaved: 'Document ajouté à l’index OCR local ✓', ocrIndexCount: '{n} document(s) indexé(s)', ocrIndexOpen: 'Ouvrir', ocrIndexDelete: 'Supprimer de l’index', ocrIndexClear: 'Vider l’index', ocrIndexClearConfirm: 'Supprimer tout l’index OCR local ?', ocrIndexMeta: '{size} · {date} · {chars} caractères',
      queueSearch: 'Filtrer la file…', estOptim: '≈ {size} après optim.', optimizationEstimate: '{before} → ≈ {after} · économie {saved} ({pct} %) {eta}', optimizationEstimating: 'Estimation de l’optimisation…', copyQueueNames: 'Copier les noms', queueNamesCopied: '{n} nom(s) copié(s) ✓', quickFilters: 'Filtres rapides', filterAll: 'Tous', filterImages: 'Images', filterVideos: 'Vidéos', filterDocuments: 'Documents', filterWaiting: 'En attente', filterDone: 'Terminés', filterErrors: 'Erreurs', dragHandle: 'Déplacer dans la file', batchElapsed: '⏱ {time}', avgPerFile: 'moy. {time}/fichier', transferActiveExit: 'Un transfert est en cours. Terminez-le ou mettez-le en pause avant de quitter.', lowBatteryConfirm: 'Batterie à {level} % et non branchée. Continuer avec 1 envoi parallèle ? Annuler pour brancher l’appareil.', notifUploadTitle: 'Transfert Direct-Xfer terminé', notifUploadBody: '{ok} réussi(s){fail}', notifOpen: 'Ouvrir', notifCopyLink: 'Copier le lien', notifResend: 'Renvoyer', notifLinkCopied: 'Lien de destination copié ✓', rotate: 'Pivoter',
      quotaNearFull: 'Quota bientôt atteint sur cette destination.',
      imgQrAll: '▦ QR groupé', imgQrTooBig: 'Trop de liens pour tenir dans un seul QR.', bulkShare: 'Partager',
      onlineStatus: 'En ligne', offlineStatus: 'Hors ligne', networkWifi: 'Wi-Fi', networkCellular: 'Données mobiles',
      networkDashboard: 'Réseau en direct', networkDashboardHint: 'Débit, latence, chunks et reprises pendant les transferts.', networkTestNow: 'Tester la connexion', networkTesting: 'Test réseau…', networkTestDone: 'Réseau : {quality} · ↑ {up} · ↓ {down} · {latency} ms', networkTestFailed: 'Test réseau impossible — réglages automatiques conservés.', networkTestAuto: 'Gros transfert détecté : test réseau avant envoi…', networkLatency: 'Latence', networkUpload: 'Montant', networkDownload: 'Descendant', networkLiveRate: 'Débit actuel', networkChunk: 'Chunk', networkParallel: 'Parallèles', networkRetries: 'Reprises', networkActive: 'Actifs', networkAdaptive: 'Adaptation', networkAdaptiveAuto: 'Auto', networkAdaptiveSlow: 'Réseau lent · 1 flux', networkAdaptiveRecovering: 'Récupération', networkQualityExcellent: 'excellent', networkQualityGood: 'bon', networkQualityFair: 'moyen', networkQualityPoor: 'faible', networkNotTested: 'Non testé', networkLastTest: 'Dernier test : {when}', networkGraphLabel: 'Historique du débit montant',
      errorCenter: 'Centre d’erreurs', errorCenterHint: 'Diagnostic regroupé des échecs récents et des fichiers en erreur.', errorCenterEmpty: 'Aucune erreur récente.', errorCenterClear: 'Effacer le journal', errorCenterCopy: 'Copier le rapport', errorCenterRetry: 'Réessayer', errorCenterRetryAll: 'Réessayer toutes', errorCategoryProxy: 'Reverse proxy', errorCategoryQuota: 'Quota / stockage', errorCategoryNetwork: 'Connexion', errorCategoryServer: 'Serveur', errorCategoryAuth: 'Autorisation', errorCategoryFile: 'Fichier', errorCategoryOther: 'Autre', errorLogCleared: 'Journal d’erreurs effacé ✓', errorReportCopied: 'Rapport d’erreurs copié ✓', errorLocalStorage: 'Stockage local insuffisant ou indisponible.',
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
      imgEditUploaded: 'Edit with the photo editor', imgEditUploadedDone: 'Image edited, URL preserved ✓',
      notificationsTitle: 'Notifications', notificationsLoading: 'Loading…', notificationsEmpty: 'No notifications.', notificationsFirstView: 'First view of “{name}”', notificationsDelete: 'Delete this notification', notificationsClearAll: 'Delete all', notificationsClearConfirm: 'Delete all notifications?', notificationsLoadMore: 'Show more ({n})', notificationsLinkCopied: 'Link copied ✓', notificationsSound: 'Sound on arrival', notificationsSoundOn: 'Sound on', notificationsSoundOff: 'Sound off', notificationsPrefs: 'Preferences', notificationsPrefsHint: 'Uncheck a category to stop creating its notifications.', notificationsPrefsSaved: 'Preferences saved ✓', notificationsSettingsTitle: 'Notification center', notificationsSettingsHint: 'Choose which notification categories this account receives in the notification center.', notificationsSettingsRequired: 'Always on', notificationsSettingsRequiredHint: 'Security, Maintenance and System health notifications always remain enabled.', notificationsSettingsSaving: 'Saving…', notificationsSettingsError: 'Could not save notification preferences.', notificationsRulesTitle: 'Custom alerts', notificationsRulesHint: 'Create up to 50 rules that trigger a notification when a threshold is reached.', notificationsRuleMetric: 'Metric', notificationsRuleTarget: 'Link', notificationsRuleThreshold: 'Threshold', notificationsRuleLabel: 'Name (optional)', notificationsRuleAdd: 'Add rule', notificationsRuleAllTargets: 'All my compatible links', notificationsRuleTargetUnavailable: 'Link unavailable or deleted', notificationsRuleEmpty: 'No custom rules.', notificationsRuleSaved: 'Rule saved ✓', notificationsRuleDeleted: 'Rule deleted', notificationsRuleError: 'Could not save the rule.', notificationsRuleEnable: 'Enable', notificationsRuleDisable: 'Disable', notificationsRuleDelete: 'Delete', notificationsRuleMetricViews: 'Views', notificationsRuleMetricDownloads: 'Downloads', notificationsRuleMetricBytesServed: 'Data served (GB)', notificationsRuleMetricReceivedBytes: 'Data received (GB)', notificationsRuleCustomTitle: 'Custom alert: {name}', notificationsTimeAgo: '{v} ago', notificationsCount: '{n} notification(s)', notificationsFilteredCount: '{shown} / {total} notification(s)', notificationsNoMatch: 'No notifications match the filters.', notificationsFilters: 'Notification filters', notificationsCategoryFilter: 'Filter by category', notificationsSeverityFilter: 'Filter by severity', notificationsAllCategories: 'All categories', notificationsAllSeverities: 'All severities', notificationsSearch: 'Search…', notificationsSearchAria: 'Search notifications', notificationsCategoryActivity: 'Activity', notificationsCategoryVisitors: 'Visitors', notificationsCategoryThresholds: 'Thresholds', notificationsCategoryTraffic: 'Traffic', notificationsCategoryImages: 'Images', notificationsCategoryPwa: 'PWA', notificationsCategoryReceptions: 'Receptions', notificationsCategorySearch: 'Search / OCR', notificationsCategorySecurity: 'Security', notificationsCategoryShares: 'Shares', notificationsCategorySystemHealth: 'System health', notificationsCategoryMaintenance: 'Maintenance', notificationsCategoryNetwork: 'Network', notificationsCategoryRestarts: 'Restarts', notificationsCategoryUpdates: 'Updates', notificationsCategoryTransfers: 'Transfers', notificationsCategoryDescShares: 'Downloads, expiry, limits and changes affecting shared links.', notificationsCategoryDescReceptions: 'Received deposits, available files and reception-link quotas.', notificationsCategoryDescImages: 'First views, image replacements and variant regeneration.', notificationsCategoryDescTransfers: 'Completed or failed transfers, abandoned transfers and impossible resumes.', notificationsCategoryDescVisitors: 'New countries and new visitor browsers or devices.', notificationsCategoryDescThresholds: 'View and download thresholds reached on your links.', notificationsCategoryDescTraffic: 'Unusually high download volume and links becoming viral.', notificationsCategoryDescSearch: 'OCR failures and search-indexing problems.', notificationsCategoryDescPwa: 'PWA devices, Push subscriptions and notification permissions.', notificationsCategoryDescSecurity: 'Unusual logins, password events, DLP and other security alerts.', notificationsCategoryDescSystemHealth: 'Service outages, configuration errors and important system problems.', notificationsCategoryDescMaintenance: 'Automatic cleanups and file removals performed by retention rules.', notificationsCategoryDescNetwork: 'Public IP address changes and service network events.', notificationsCategoryDescRestarts: 'Detected Direct-Xfer restarts, including downtime when available.', notificationsCategoryDescUpdates: 'Available updates and confirmation after installation.', notificationsSeverityInfo: 'Information', notificationsSeveritySuccess: 'Success', notificationsSeverityWarning: 'Warning', notificationsSeverityCritical: 'Critical',
      title: 'Send', navMain: 'Main navigation', navSend: 'Send', navSendHint: 'Prepare and send files to a destination.', navImages: 'Images', navImagesHint: 'Create, manage and monitor image links.', navActivity: 'Activity', navActivityHint: 'View the same persistent activity history as in standard Direct-Xfer.', navSystemHealth: 'Health', navSystemHealthHint: 'Monitor system health, performance and server diagnostics.', serverActivity: 'Activity', serverActivityHint: 'Persistent history of relevant Direct-Xfer events.', serverActivitySearch: 'Search activity…', serverActivityLoading: 'Loading activity…', serverActivityEmpty: 'No recorded activity.', serverActivityLoadFail: 'Could not load activity history.', serverActivityFiltersAria: 'Activity filters', serverActivityKindAria: 'Activity type', serverActivityKindAll: 'All types', serverActivityKindTransfer: 'Transfers', serverActivityKindAdmin: 'Administration', serverActivityKindSecurity: 'Security', serverActivityKindVisitor: 'Visitors', serverActivityKindSystem: 'System', serverActivityShareAll:'All shares', serverActivityImagesOnly:'Images only', serverActivityPwaOnly:'PWA only', serverActivityHideRoutine:'Hide routine system events', serverActivityReset: 'Clear filters', serverActivitySummary: '{shown} shown of {total}', localTransferHistory: 'Transfer history on this device', activityImageDeleted: 'Image deleted: {name}', activityShareDeleted: 'Share deleted: {name}', activityImagePurged: 'Image permanently deleted: {name}', activitySharePurged: 'Share permanently deleted: {name}', activityImageRestored: 'Image restored: {name}', activityShareRestored: 'Share restored: {name}', activityTransferDone: 'Transfer completed: {name}', activityTransferFailed: 'Transfer interrupted: {name}', navSettings: 'Settings', navSettingsHint: 'Configure the PWA, security and storage.', navShares: 'Shares', navSharesHint: 'Create share links from files on your server.', sharesTitle: 'Share server files', sharesHint: 'Browse the files on your server and create direct share links.', sharesAdminRequired: 'Sign in with an administrator account to browse server files.', sharesSignIn: 'Sign in as administrator', sharesBrowse: 'Server files', sharesUp: 'Parent folder', sharesCreate: 'Create the share', sharesNoneSelected: 'No file selected.', sharesSelected: '{n} item(s) selected', sharesExpiry: 'Expiry', sharesExpiryNever: 'Never', sharesExpiry1h: '1 hour', sharesExpiry1d: '1 day', sharesExpiry7d: '7 days', sharesExpiry30d: '30 days', sharesExpiryForcedNever: 'The administrator configured new shares to never expire.', sharesMaxDownloads: 'Max downloads (0 = unlimited)', sharesRateLimit: 'Maximum rate (KB/s, 0 = unlimited)', sharesRateEdit: 'Rate', sharesRatePrompt: 'Maximum rate in KB/s (0 = unlimited):', sharesRateSaved: 'Rate updated ✓', sharesRateFail: 'Could not update the rate', sharesPassword: 'Password (optional)', sharesPasswordPlaceholder: '—', sharesCreateBtn: 'Create share link', sharesCreating: 'Creating…', sharesCreated: 'Share created ✓', sharesCreatedLink:'Link ready to share', sharesCreateFail: 'Could not create the share', sharesDlpWarning: 'DLP: {n} sensitive finding(s) ({level}). Publish anyway?', sharesDlpBlocked: 'Publishing blocked by the DLP policy.', dlpTest: 'Test DLP', dlpTestQueue: '🛡 Test DLP', dlpTestSelected: '🛡 Test DLP', dlpTesting: 'DLP scan…', dlpSafe: 'DLP ✓ no sensitive content detected', dlpFound: 'DLP: {n} finding(s) ({level})', dlpLocalBlocked: 'Upload blocked by the DLP policy before transfer.', dlpLocalConfirm: 'DLP found {n} sensitive item(s) ({level}) in {files} file(s). Send anyway?', dlpScanSkipped: 'DLP: {n} file(s) too large/not scanned', dlpScanFailed: 'DLP test failed: {error}', dlpOcrIncomplete: 'DLP incomplete: OCR failed for {n} file(s)', dlpPolicyLoading: 'Loading DLP policy…', dlpPolicyDisabled: 'DLP disabled on the server', dlpPolicyText: '{mode} policy · {mb} MB/file · OCR {ocr}', dlpAutoRules:'Automatic reaction by severity', dlpAutoRulesHint:'Choose the action automatically applied for each detected severity level.', dlpAutoReadOnly:'Automatic DLP reactions can only be changed from an owner/admin device.', dlpSeverityLow:'Low', dlpSeverityMedium:'Medium', dlpSeverityHigh:'High', dlpSeverityCritical:'Critical', dlpAutoSave:'Save DLP reactions', dlpAutoSaved:'DLP reactions saved ✓', dlpAutoSaveFail:'Could not save DLP reactions', dlpModeWarn: 'Warn', dlpModeBlock: 'Block', dlpModeQuarantine:'Quarantine', dlpModeLog: 'Log', dlpLocalQuarantined:'Upload held by the DLP quarantine policy; no bytes were sent.', dlpIncompleteQuarantined:'Upload held: the DLP scan is incomplete and policy requires quarantine.', dlpServerQuarantined:'Content was quarantined by DLP policy.', dlpQuarantineFailed:'DLP quarantine failed; no content was published.', dlpOcrOn: 'enabled', dlpOcrOff: 'disabled', dlpIncompleteBlocked: 'Upload blocked: the DLP scan is incomplete.', dlpIncompleteConfirm: 'The DLP scan is incomplete for {files} file(s) and found {n} finding(s). Send anyway?', dlpPolicyUnavailable: 'DLP policy unavailable: upload paused for safety.', dlpScanIncomplete: 'DLP incomplete: {n} item(s) not scanned', sharesLibrary: 'Your shares', sharesEmpty: 'No shares yet.', sharesBrowseFail: 'Could not read this folder.', sharesLoginNeeded: 'Administrator login required.', sharesOpen: 'Open', sharesCopy: 'Copy', sharesRevoke: 'Revoke', sharesRevoked: 'Share revoked ✓', sharesRevokeFail: 'Could not revoke', sharesRevokeConfirm: 'Revoke this share? The link will stop working.', sharesColor: 'Card color (optional)', sharesAdminNote: 'Private note (optional)', sharesAdminNotePlaceholder: 'Visible to administrators only', sharesEditMeta: 'Color / note', sharesArchive: 'Archive', sharesUnarchive: 'Unarchive', sharesShowArchived: '🗄 Archives', sharesDuplicate: 'Duplicate', sharesDuplicatePrompt: 'Name of the duplicated share:', sharesDuplicated: 'Share duplicated ✓', sharesDuplicateFail: 'Could not duplicate', sharesReactivate: 'Reactivate', sharesReactivated: 'Link reactivated ✓', sharesReactivateMissing: 'The link data is no longer available', sharesTrash: 'Global trash', sharesTrashHint: 'Deleted images, receptions and shares can be restored here while retained.', sharesTrashEmpty: 'Trash is empty.', sharesTrashRestore: 'Restore', sharesTrashRestoreSelected:'Restore selected', sharesTrashSelected:'{n} selected', sharesTrashRestoreSelectedOk:'{n} item(s) restored ✓', sharesTrashRestored: 'Item restored ✓', sharesTrashDelete: 'Delete permanently', sharesTrashDeleteAll: 'Delete all permanently', sharesTrashDeleteConfirm: 'Permanently delete “{name}”? This action cannot be undone.', sharesTrashDeleteAllConfirm: 'Permanently delete every item in the trash? This action cannot be undone.', sharesTrashDeleted: 'Item permanently deleted ✓', sharesTrashAllDeleted: '{n} item(s) permanently deleted ✓', sharesTrashDeleteFail: 'Permanent deletion failed', sharesGlobalSearch: 'Search', sharesGlobalSearchPlaceholder: 'Search links, users, logs and content…', sharesGlobalSearchEmpty: 'No results.', sharesGlobalSearchFail: 'Search failed', sharesArchivedBadge: 'Archived', sharesPinnedBadge:'Pinned', sharesPin:'Pin', sharesUnpin:'Unpin', sharesNeverDownloaded:'Never downloaded', sharesPasswordProtected:'Password protected', sharesExpiresSoon:'Expires soon', sharesTotalSize:'Total size: {size}', sharesRevokedBadge: 'Revoked', sharesItems: '{n} item(s)', sharesReceptions: 'Reception links', sharesReceptionsEmpty: 'No reception links.', sharesReceived: '{bytes} received', sharesDownloadingNow: '{n} download(s) in progress', threadTitle: 'Conversation', threadEmpty: 'No messages.', threadReplyPh: 'Reply to the visitor…', threadSend: 'Send', threadSending: 'Sending…', threadError: 'Could not send, try again.', threadYou: 'You', threadVisitor: 'Visitor', openAdmin: 'Open administration', language: 'Language', theme: 'Theme', copyLink: 'Copy link', pasteLink: 'Paste link', editDestination: 'Edit destination', addDestination: 'Add destination', passwordPlaceholder: 'Link password', destinationPlaceholder: 'Reception link or token', destinationNamePlaceholder: 'Optional destination name', senderPlaceholder: 'Name required by this link', globalProgress: 'Overall progress', keyPlaceholder: 'Link encryption key', titlePlaceholder: 'Shared content', themeDark: 'Dark', themeLight: 'Light', themeAuto: 'Auto', install: 'Install', installIosHint: 'To install Direct-Xfer, tap the browser Share button, then “Add to Home Screen”.', installBrowserHint: 'Chrome has not validated full installation yet. Do not choose a simple shortcut: use a trusted HTTPS address, interact with the page, and keep it open briefly.', installHttpsRequired: 'Full installation is impossible from this HTTP address or untrusted certificate. Android can only create a shortcut. Open Direct-Xfer over HTTPS with a valid certificate.', installSecurePending: 'Installation is being prepared. In Chrome, interact with the page and keep it open for about 30 seconds. If the logo does not appear, verify that Android trusts the HTTPS certificate.', installOpenHttps: 'Open HTTPS version',
      offline: 'Offline — uploads will resume when the connection returns.', updateReady: 'A new version is available.', updateNow: 'Update', pullToRefresh: 'Pull down to refresh', releaseToRefresh: 'Release to refresh', refreshing: 'Refreshing…', backExit: 'Press back again to exit',
      destination: 'Destination', destinationHint: 'A Direct-Xfer reception link from this instance.', linkOrToken: 'Link or token', displayName: 'Display name',
      rememberDestination: 'Remember this destination on this device', rememberKey: 'Also remember the secret key on this device', scanQr: '📷 Scan QR', saveDestination: 'Add', updateDestination: 'Save', removeDestination: 'Remove', createLinkTitle: 'Create a reception link', newLink: 'New', createLinkName: 'New link name', createLinkPlaceholder: 'e.g. Holiday photos', createLinkHint: 'A new reception link will be created and added to your destinations. Share it to receive files.', createDo: 'Create link', creating: 'Creating…', createOk: 'Link created ✓', createFail: 'Could not create the link',
      imgLinksTitle: 'Image links', imgLinksHint: 'Create direct links to your images: each link offers Full, Mini, and Micro versions, with no relay page.', imgLinksAdd: 'Add images', imgCreateTitle: 'Create links', imgCreateHint: 'Choose images to share or edit one before uploading.', imgLibraryTitle: 'Your links', imgLibraryHint: 'Search, sort and manage images you already shared.', imgGlobalActions: 'Global actions', imgManageActions: 'Manage link', imgStripExif: 'Remove EXIF/GPS data before sharing', imgStripExifHint: 'The cleanup is performed locally on this device before upload.', imgStrippingMetadata: 'Removing EXIF/GPS…', imgMetadataRemoved: 'EXIF/GPS removed', imgUploading: 'Uploading…', imgThumbing: 'Mini and Micro…', imgReady: 'Ready', imgCopyBBCode: 'Copy BBCode', imgCopied: 'Link copied ✓', clearSearch: 'Clear search', imgListEmpty: 'No shared images yet. Use “Add images” to create your first link.', imgNoMatch: 'No image matches your search.', destEmptyHint: 'No destination yet. Add a reception link (＋) or create one with “New”.', destEmoji: 'Emoji (visual cue)', imgCopyImage: 'Copy image', imgCompare: 'Compare', imgCompareTitle: 'Compare formats', pwStrengthLabel: 'Password strength', pwWeak: 'Weak', pwMedium: 'Fair', pwStrong: 'Strong', historyResend: 'Resend', historyDestGone: 'Destination not found — add it again.', resendReady: 'Destination selected — add your files.', imgLinkFail: 'Could not create the link', imgVariantsFailed: 'Image saved, but Mini/Micro could not be updated.', revokeShare: 'Revoke', revokeConfirm: 'Revoke this share? The link will stop working.', revokeSuccess: 'Revoked ✓', revokeFail: 'Could not revoke', imgVariantFull: 'Full', imgVariantMini: 'Mini', imgVariantMicro: 'Micro', imgViews: '{n} views', imgVisitors: '{n} visitors', imgStatsLoading: 'Statistics…', imgStatsUnavailable: 'Statistics unavailable', imgStatsButton: '📊 Stats', imgStatsTitle: 'Detailed statistics', imgStatsOverview: 'Overview', imgStatsCopies: 'Image copies', imgStatsRecent: 'Recent image access', imgStatsStorage: 'Storage', imgStatsDimensions: 'Dimensions', imgStatsLastView: 'Last view', imgStatsCreated: 'Created', imgStatsExpiry: 'Expiry', imgStatsStatus: 'Status', imgStatsActive: 'Active', imgStatsInactive: 'Inactive', imgStatsExpired: 'Expired', imgStatsNoRecent: 'No recent access recorded.', imgStatsNever: 'Never', imgStatsUnknown: 'Unknown',
      imgSearch: 'Search name, tag or OCR text…', imgSortLabel: 'Sort images', imgSortNewest: 'Newest', imgSortOldest: 'Oldest', imgSortName: 'Name', imgSortSize: 'Size', imgSortViews: 'Views', imgSortVisitors: 'Visitors', imgSortExpiry: 'Expiry', imgFilterLabel: 'Filter images', imgFilterAll: 'All', imgFilterActive: 'Active', imgFilterPopular: 'Popular', imgFilterLarge: 'Large', imgFilterExpiring: 'Expiring soon', imgFilterFavorite: 'Favorites', imgFilterProtected: 'Protected', imgAdvancedOptions: 'Image options', imgCompact: 'Compact display', imgHideExpired: 'Hide expired images', imgAutoCopy: 'Copy automatically after creation', imgDefaultExpiry: 'Favorite expiry', imgMaxViews: 'View limit', imgPassword: 'Password', imgTags: 'Tags', imgPrivateNote: 'Private note', imgRenameTemplate: 'Rename template', imgBulkEdit: 'Edit', imgCreateAlbum: 'Create album', imgDashboard: 'Statistics chart', imgAlbums: 'Shareable albums', imgActionHistory: 'Image action history', imgSelected: '{n} selected', imgEditPrompt: 'Edit selected images', imgAlbumName: 'Album name', imgAlbumCreated: 'Album created ✓', imgSettingsSaved: 'Settings saved ✓', imgDuplicateFound: 'This image has already been shared. Continue anyway?', imgExpirySoon: 'The link “{name}” expires soon.', imgUndoRevoke: 'Image removed — Undo?', imgRevokePending: 'Revoking in {n} s…', imgCancelRevoke: 'Cancel revocation', imgRevokeCancelled: 'Revocation cancelled ✓', imgQrDownloaded: 'QR downloaded ✓', imgFavorite: 'Favorite', imgUnfavorite: 'Remove from favorites', imgExpired: 'Expired', imgInactive: 'Inactive', imgViewLimitReached: 'View limit reached', imgProtected: 'Protected', imgViewLimit: '{n} views max', imgNoAlbums: 'No albums.', imgVariantAuto: 'Automatic', imgReplace: 'Replace without changing link', imgVersions: 'Versions', imgReplaceDone: 'Image replaced, URL preserved ✓', imgResizeMini: 'Resize the Mini', imgResizeMiniPrompt: 'New Mini size: a number of pixels (longest side, e.g. 250) OR a percentage of the full size (e.g. 50%). The Micro will be half:', imgResizeMiniInvalid: 'Invalid value: pixels (16 to 4096) or percentage (1 to 100%).', imgResizeMiniDone: 'Mini resized to {w}×{h} ✓', imgRestoreVersion: 'Restore a version', imgVersionRestored: 'Version restored ✓', imgAdaptiveReady: 'Adaptive optimization', albumInvites: 'Invitations', albumInviteCreate: 'Create invitation', albumInviteRole: 'Role (reader, contributor, manager)', albumInviteCopied: 'Invitation link copied ✓', albumInviteRevoke: 'Revoke invitation', albumCollabSummary: '{n} invitation(s)', imgAlbumCopied: 'Album link copied ✓', imgChartSummary: '{images} images · {views} views · {visitors} visitors · {bytes}', imgComparePeriod: 'Comparison period', imgCompare7d: '7 days', imgCompare30d: '30 days', imgCompareSummary: '{days} d vs previous period: {views} views · {created} images created', imgCompareNew: 'new', imgHotlinkHosts: 'Allowed embedding domains', imgHotlinkPlaceholder: 'forum.example.com, *.site.net', imgHotlinkHint: 'Empty = protection disabled. Direct visits remain allowed.', imgHotlinkProtected: 'Hotlink protection', imgNotifyFirstView: 'Notify on first view', imgFirstViewArmed: 'First-view alert', imgFirstViewSent: 'First view notified', imgFirstViewToast: '👁 First view of “{name}”', imgSmartBlur: 'Local smart blur', imgSmartBlurFaces: 'Faces', imgSmartBlurFacesPlates: 'Faces and plates', imgSmartBlurAll: 'Faces, plates and sensitive text', imgSmartBlurHint: 'Local analysis with review before upload; no image is sent to an external service.', imgSmartBlurAnalyzing: 'Local analysis…', imgSmartBlurReady: '{n} area(s) hidden. Review and apply.', imgSmartBlurUnsupported: 'Face detection is not supported by this browser; add areas manually.', imgSmartBlurSkip: 'Continue without blur', imgRetentionRules: 'Automatic retention rules', imgRetentionWarning: 'These rules permanently revoke images and delete their files. They are disabled by default.', imgRetentionAge: 'Maximum age (days)', imgRetentionInactive: 'Maximum inactivity (days)', imgRetentionViews: 'Revoke after this many views', imgRetentionStorage: 'Maximum storage (MB)', imgRetentionSave: 'Save and apply', imgRetentionSaved: 'Retention rules saved ✓', imgRetentionResult: '{n} image(s) revoked · {bytes} freed', imgRetentionSummary: '{n} image(s) · {bytes}', enabled: 'Enabled', disabled: 'Disabled', optional: 'Optional', refresh: 'Refresh', themeSchedule: 'By time',
      cancel: 'Cancel', protectedLink: '🔒 Protected link', unlock: 'Unlock', encryptedLink: '🔐 End-to-end encryption', encryptionKey: 'Link key', passphrase: 'Passphrase',
      addFiles: 'Add files', durableQueue: 'Files are copied to durable storage before upload so they can resume after the PWA is closed.', takePhoto: 'Take a photo', chooseFiles: 'Choose files',
      chooseFolder: 'Choose a folder', optimizePhotos: 'Optimize photos before upload', parallelUploads: 'Parallel uploads', senderName: 'Your name', pause: 'Pause', resume: 'Resume',
      retryAll: '↻ Retry', removePending: 'Remove all', send: 'Send', clearCompleted: 'Clear completed uploads', history: 'Local history', clearHistory: 'Clear history',
      settings: 'Settings and security', autoResume: 'Resume automatically after closing or reconnecting', storage: 'Local storage', protectStorage: 'Protect', passkeyTitle: 'Biometric identification', passkeyHint: 'Use your fingerprint, face recognition or this device’s secure unlock to sign in without a password.', passkeyAdd: 'Enable on this device', passkeyAdding: 'Enabling…', passkeyAdded: 'Biometric identification enabled ✓', passkeyFailed: 'Could not change biometric identification.', passkeyEmpty: 'No biometric identification registered.', passkeyRemove: 'Disable this one', passkeyRemoveConfirm: 'Disable this biometric identification?', passkeyRemoveSharedConfirm: 'This identification is linked to {n} devices. Disable it everywhere?', passkeyRemoved: 'Biometric identification disabled', passkeyDevices: '{n} device(s)', biometricDisable: 'Disable biometric identification', biometricDisabling: 'Disabling…', biometricDisableConfirm: 'Disable every biometric identification for this account on all devices?', biometricDisabled: 'Biometric identification fully disabled ✓', passkeyNamePrompt: 'Passkey name (optional):', passkeyCreated: 'Enabled {date}', passkeyUsed: 'used {date}', passkeyNeverUsed: 'never used', passkeyCurrent: 'this device', biometricChecking: 'Checking compatibility…', biometricReady: 'Compatible — you can enable it on this device.', biometricEnabled: 'Biometric identification is enabled on this device.', biometricConfigured: '{n} biometric identification(s) configured for this account.', biometricUnsupported: 'Secure biometrics are not available on this device or browser. Existing identifications can still be disabled.', biometricHttpsRequired: 'Biometric activation requires a trusted HTTPS connection. Disabling remains available.', biometricRecentAuth: 'Sign in again to change this sensitive setting.', biometricReauth: 'Sign in again to change', biometricReauthFailed: 'Could not restart authentication.', biometricStatusUnavailable: 'Biometric status is temporarily unavailable.', biometricCredentialName: 'Biometrics · {device}', biometricLoadFailed: 'Could not load registered identifications.', autoLock: 'Automatic lock', autoLockNever: 'Never', autoLock5: 'After 5 minutes', autoLock15: 'After 15 minutes', autoLock30: 'After 30 minutes', autoLock60: 'After 1 hour', autoLocking: 'Session locked — authenticate to continue.',
      deviceAccess: 'Device access', deviceChecking: 'Checking device…', deviceStatusUnavailable: 'Device status is unavailable. Tap Pair to try again.',
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
      devicePairFailed: 'Pairing failed', deviceRevokeFailed: 'Revocation failed', deviceCurrent: 'this device', deviceLast: 'Last used {date}', devicePlatformOther:'Other', deviceVersionUnknown:'PWA version unknown', localCleared: 'Local data cleared',
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
      imgCopyAll: '🔗 Copy all', imgOpen: 'Open in a tab', allImgCopied: '{n} link(s) copied ✓', noImgLinks: 'No link to copy.', imgCopyTemplate: 'Copy template', copyTemplateStandard: 'Standard', copyTemplateForum: 'Forum', copyTemplateEmail: 'Email', imgQrZip: '🗜 QR ZIP', imgQrZipDone: 'QR archive downloaded ✓', imgExportStatsCsv: 'Statistics CSV', imgStatsCsvDone: 'Statistics exported ✓', imgFavoriteAction1: 'Favorite action 1', imgFavoriteAction2: 'Favorite action 2', imgFavoriteAction3: 'Favorite action 3', imgActionOpen: 'Open', imgQrDownload: 'Download QR', pinItem: 'Pin', unpinItem: 'Unpin', tagColors: 'Tag colors', tagColorsReset: 'Reset colors', expiresIn: 'Expires in {time}', expiredNow: 'Expired',
      shareLink: 'Share link', qrForLink: 'Link QR', qrTitle: 'Reception link QR', qrDestHelp: 'Scan this code on another device to open the reception link.', qrFail: 'Could not create the QR code',
      receivedTitle: 'Received content', receivedHelp: 'Files received on this reception link, served by the server.', receivedRefresh: 'Refresh', receivedLoading: 'Loading…', receivedEmpty: 'No files received yet.', receivedFail: 'Could not load received content.', receivedCount: '{n} file(s) · {size}', receivedDownload: 'Download',
      receivedPendingTitle: 'Awaiting approval', receivedApprove: 'Approve', receivedReject: 'Reject', receivedPendingCount: '{n} file(s) pending', createModerated: 'Manual approval: keep files pending until you approve them', sharesFirstUseExpiry: 'Expire after first use (hours, 0 = off)', sharesOneTime: 'Reinforced one-time use (revoke after the first complete retrieval)', sharesSmartExpiryHint: 'Smart expiry: enabled limits are combined with OR; the first limit reached disables the link.',
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
      wifiOnly: 'Upload on Wi-Fi only', largeWifiOnly: 'Large transfers on Wi-Fi only', largeWifiThreshold: 'Large-transfer threshold', persistentTransferNotification: 'Android notification during active transfers', transferNotifPermissionDenied: 'Notifications are blocked for this site.', waitingWifi: 'waiting for Wi-Fi', stripExif: 'Remove metadata (EXIF/GPS)',
      zipBundle: '🗜 Bundle into ZIP', zipDone: 'ZIP archive created ✓', zipNeedTwo: 'Select at least two files.', zipping: 'Building ZIP…',
      voiceNote: 'Voice note', recording: 'Recording', recStop: '⏹ Stop', recAdd: 'Add to queue', recMicFail: 'Microphone unavailable',
      annotate: 'Annotate', editorBeforeShare: 'Edit before sharing', annPan: '✋ Pan', annPen: '✏️ Pen', annBlur: '🌫 Blur', annRedact: '⬛ Redact', annDetectFaces: '🙂 Detect faces', annDetectPlates: '▭ Detect plates', annUndo: '↶ Undo', annClear: 'Clear all', annApply: 'Apply',
      selectedN: '{n} selected', bulkRemove: 'Remove', bulkRetry: 'Retry', selectAll: 'All',
      batchNote: 'Tag / note (optional)', notePlaceholder: 'e.g. Invoice, Holiday…',
      multiSend: '📢 Send to several…', multiSendTitle: 'Send to several destinations', multiSendHelp: 'The batch is sent to each ticked destination. Encrypted links or links requiring a name are skipped.', multiSendGo: 'Start sending', multiSendNone: 'No compatible destination selected.', multiSendQueued: 'Sending to {n} destination(s) prepared.',
      cmdPalette: 'Command palette', cmdPlaceholder: 'Type a command…', cmdNoMatch: 'No command.', cmdOpenSettings: 'Open settings', cmdOpenHistory: 'Open history', cmdToggleTheme: 'Toggle theme',
      expireLabel: 'Expiry (auto-delete)', expNever: 'Never', exp1h: '1 hour', exp24h: '24 hours', exp7d: '7 days', exp30d: '30 days',
      liveTitle: 'Live receptions', liveReceived: '📥 {name} received on “{dest}”', liveEnable: 'Reception notifications', livePush: 'Push notifications (app closed)', pushLanguage: 'Push notification language', pushLanguageSaved: 'Push notification language saved ✓', livePushOn: 'Push notifications enabled ✓', livePushOff: 'Push notifications disabled', livePushFail: 'Could not enable notifications', liveConnected: 'Live ✓', pushTestBtn: 'Test push notifications', pushTestHelp: 'Sends a real notification from the server to this device.', pushTestSending: 'Testing push…', pushTestPreparing: 'Preparing the push subscription…', pushTestAccepted: 'Push service accepted in {ms} ms · waiting for Android…', pushTestSent: 'Test notification sent ✓', pushTestDenied: 'Notifications are blocked in Android/the browser.', pushTestUnsupported: 'Web Push is not available on this device.', pushTestNoSub: 'No valid push subscription for this device.', pushTestRepairing: 'Expired push subscription: repairing and retrying…', pushTestFailed: 'Push test failed.', pushTestDelivered: 'Notification received by Android {ms} ms after send ✓', pushTestAcceptedDelayed: 'Accepted by the push service, but not received by Android after {seconds} s.',
      copyToken: 'Copy token', tokenCopied: 'Token copied ✓',
      pinDestination: '⭐ Pin', unpinDestination: '☆ Unpin', pinned: 'Destination pinned ✓', unpinned: 'Destination unpinned',
      resetBatch: '↺ Reset batch', resetBatchDone: 'Batch options reset ✓',
      filesPending: '{n} pending', filesTotalSummary: '{n} file(s) · {total} · {sent} sent', clipboardQueue: 'Clipboard', clipboardQueued: '{n} clipboard item(s) added ✓', clipboardEmpty: 'The clipboard contains no usable file, image or text.', clipboardUrlFallback: 'URL added as text (direct download is blocked).', pasteText: 'Paste text', pastedTextName: 'pasted-text.txt', pasteTextEmpty: 'No text in the clipboard.',
      masterSelect: 'Select all', addFromUrl: 'From a URL', urlPrompt: 'Address of the image or file to add:', urlFetching: 'Fetching…', urlFailed: 'Could not fetch (blocked by CORS?)', urlAdded: 'File added ✓', urlInvalid: 'Invalid address.',
      bulkRename: '✎ Rename', renamePrompt: 'Name prefix (numbering will be appended):', renameDone: '{n} file(s) renamed',
      hashTitle: 'SHA-256 fingerprint', hashing: 'Computing fingerprint…', hashCopied: 'SHA-256 fingerprint copied ✓', hashFail: 'Could not compute the fingerprint',
      exportSettings: 'Export settings', importSettings: 'Import', settingsImported: 'Settings imported ✓', settingsImportFail: 'Invalid settings file',
      accentLabel: 'Accent colour', accentReset: 'Default',
      screenCapture: 'Capture screen', captureFailed: 'Screen capture failed', screenshotName: 'screen-capture',
      undo: 'Undo', fileRemoved: 'File removed', fileRestored: 'File restored ✓', lightboxAlt: 'Image preview',
      sortType: 'Type', bulkInvert: '⇄ Invert',
      ocrTitle: 'Local OCR', ocrAction: 'Extract text (OCR)', ocrPrivacy: 'Processed on this device. Only OCR/PDF engines and models are downloaded; your document is not sent to an OCR service.', ocrLanguage: 'Language', ocrLangFrEn: 'French + English', ocrLangFr: 'French', ocrLangEn: 'English', ocrLangEs: 'Spanish', ocrRun: 'Extract text', ocrCancel: 'Cancel OCR', ocrCopy: 'Copy text', ocrAddTxt: 'Add .txt to queue', ocrSearch: 'Search extracted text…', ocrPrev: 'Previous', ocrNext: 'Next', ocrReady: 'Ready to extract text.', ocrLoadingEngine: 'Loading OCR engine…', ocrLoadingPdf: 'Reading PDF…', ocrEmbedded: 'Embedded PDF text detected', ocrScanningPage: 'OCR page {page}/{total}…', ocrReadingPage: 'Reading page {page}/{total}…', ocrComplete: 'OCR complete · {chars} characters', ocrNoText: 'No text detected.', ocrFailed: 'OCR failed: {error}', ocrCanceled: 'OCR canceled.', ocrCopied: 'OCR text copied ✓', ocrQueued: 'Text file added to queue ✓', ocrMatches: '{current}/{total}', ocrNoMatch: '0 matches', ocrUnsupported: 'OCR is available for images and PDFs.', ocrEngineNetwork: 'The first OCR needs Internet to download the engine and language models.',
      dedupeChecking: 'Checking for a server-side duplicate…', dedupeHit: 'Already on the server · upload skipped ✓', dedupeUnavailable: 'Deduplication unavailable — normal upload.',
      editorTitle: 'Photo editor', editorAdjust: 'Adjustments', editorBrightness: 'Brightness', editorContrast: 'Contrast', editorSaturation: 'Saturation', editorApplyAdjust: 'Apply adjustments', editorRotateLeft: '↶ 90°', editorRotateRight: '↷ 90°', editorFlipH: '↔ Mirror', editorFlipV: '↕ Flip', editorResizeMax: 'Max dimension', editorResizeApply: 'Resize', editorFormat: 'Output format', editorQuality: 'Quality', editorZoom: 'Zoom', editorZoomOut: 'Zoom out', editorZoomIn: 'Zoom in', editorZoomFit: 'Fit', editorBrushSize: 'Brush size', editorLargeConfirm: 'This image is very large ({w}×{h}). OK: use an 1800 px working copy. Cancel: preserve the original resolution (uses more memory).',
      privacyInspect: 'Privacy', privacyTitle: 'Metadata cleaner', privacyLocal: 'Analysis and cleanup happen locally on this device.', privacyAnalyze: 'Analyze', privacyClean: 'Clean and replace', privacyCleaned: 'Sensitive metadata cleaned ✓', privacyNoFindings: 'No obvious sensitive metadata detected.', privacyFindings: '{n} sensitive item(s) detected', privacyImageMetadata: 'Image metadata (EXIF/XMP/IPTC)', privacyPdfMetadata: 'PDF metadata', privacyOfficeMetadata: 'Office properties', privacyThumbnail: 'Embedded thumbnail', privacyAuthor: 'Author / last author', privacyGps: 'GPS coordinates', privacyCustom: 'Custom properties', privacyUnsupported: 'Automatic cleanup is not supported for this format.', privacyAnalyzing: 'Local analysis…', privacyCleaning: 'Local cleanup…',
      annDetectSensitive: '🔐 Sensitive text', sensitiveScanning: 'Locally scanning for sensitive text…', sensitiveFound: '{n} sensitive text area(s) hidden. Review the result.',
      ocrIndexTitle: 'Local OCR index', ocrIndexHint: 'Search every OCR document processed on this device.', ocrIndexSearch: 'Search all OCR text…', ocrIndexEmpty: 'No OCR document indexed.', ocrIndexSaved: 'Document added to the local OCR index ✓', ocrIndexCount: '{n} indexed document(s)', ocrIndexOpen: 'Open', ocrIndexDelete: 'Remove from index', ocrIndexClear: 'Clear index', ocrIndexClearConfirm: 'Delete the entire local OCR index?', ocrIndexMeta: '{size} · {date} · {chars} characters',
      queueSearch: 'Filter the queue…', estOptim: '≈ {size} after optimizing', optimizationEstimate: '{before} → ≈ {after} · saved {saved} ({pct}%) {eta}', optimizationEstimating: 'Estimating optimized size…', copyQueueNames: 'Copy names', queueNamesCopied: '{n} name(s) copied ✓', quickFilters: 'Quick filters', filterAll: 'All', filterImages: 'Images', filterVideos: 'Videos', filterDocuments: 'Documents', filterWaiting: 'Waiting', filterDone: 'Done', filterErrors: 'Errors', dragHandle: 'Reorder in queue', batchElapsed: '⏱ {time}', avgPerFile: 'avg {time}/file', transferActiveExit: 'A transfer is active. Finish or pause it before leaving.', lowBatteryConfirm: 'Battery is at {level}% and not charging. Continue with 1 parallel upload? Cancel to plug the device in.', notifUploadTitle: 'Direct-Xfer transfer finished', notifUploadBody: '{ok} succeeded{fail}', notifOpen: 'Open', notifCopyLink: 'Copy link', notifResend: 'Resend', notifLinkCopied: 'Destination link copied ✓', rotate: 'Rotate',
      quotaNearFull: 'This destination’s quota is almost full.',
      imgQrAll: '▦ Combined QR', imgQrTooBig: 'Too many links to fit in one QR.', bulkShare: 'Share',
      onlineStatus: 'Online', offlineStatus: 'Offline', networkWifi: 'Wi-Fi', networkCellular: 'Mobile data',
      networkDashboard: 'Live network', networkDashboardHint: 'Throughput, latency, chunks and retries during transfers.', networkTestNow: 'Test connection', networkTesting: 'Network test…', networkTestDone: 'Network: {quality} · ↑ {up} · ↓ {down} · {latency} ms', networkTestFailed: 'Network test failed — automatic defaults kept.', networkTestAuto: 'Large transfer detected: testing the network before upload…', networkLatency: 'Latency', networkUpload: 'Upload', networkDownload: 'Download', networkLiveRate: 'Live rate', networkChunk: 'Chunk', networkParallel: 'Parallel', networkRetries: 'Retries', networkActive: 'Active', networkAdaptive: 'Adaptation', networkAdaptiveAuto: 'Auto', networkAdaptiveSlow: 'Slow network · 1 stream', networkAdaptiveRecovering: 'Recovering', networkQualityExcellent: 'excellent', networkQualityGood: 'good', networkQualityFair: 'fair', networkQualityPoor: 'poor', networkNotTested: 'Not tested', networkLastTest: 'Last test: {when}', networkGraphLabel: 'Upload throughput history',
      errorCenter: 'Error center', errorCenterHint: 'Grouped diagnostics for recent failures and files currently in error.', errorCenterEmpty: 'No recent error.', errorCenterClear: 'Clear log', errorCenterCopy: 'Copy report', errorCenterRetry: 'Retry', errorCenterRetryAll: 'Retry all', errorCategoryProxy: 'Reverse proxy', errorCategoryQuota: 'Quota / storage', errorCategoryNetwork: 'Connection', errorCategoryServer: 'Server', errorCategoryAuth: 'Authorization', errorCategoryFile: 'File', errorCategoryOther: 'Other', errorLogCleared: 'Error log cleared ✓', errorReportCopied: 'Error report copied ✓', errorLocalStorage: 'Local storage is insufficient or unavailable.',
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
      imgEditUploaded: 'Modificar con el editor de fotos', imgEditUploadedDone: 'Imagen modificada, URL conservada ✓',
      notificationsTitle: 'Notificaciones', notificationsLoading: 'Cargando…', notificationsEmpty: 'No hay notificaciones.', notificationsFirstView: 'Primera vista de «{name}»', notificationsDelete: 'Eliminar esta notificación', notificationsClearAll: 'Eliminar todas', notificationsClearConfirm: '¿Eliminar todas las notificaciones?', notificationsLoadMore: 'Mostrar más ({n})', notificationsLinkCopied: 'Enlace copiado ✓', notificationsSound: 'Sonido al recibir', notificationsSoundOn: 'Sonido activado', notificationsSoundOff: 'Sonido desactivado', notificationsPrefs: 'Preferencias', notificationsPrefsHint: 'Desmarca una categoría para dejar de crear sus notificaciones.', notificationsPrefsSaved: 'Preferencias guardadas ✓', notificationsSettingsTitle: 'Centro de notificaciones', notificationsSettingsHint: 'Elige qué categorías de notificaciones recibirá esta cuenta en el centro de notificaciones.', notificationsSettingsRequired: 'Siempre activada', notificationsSettingsRequiredHint: 'Las notificaciones de Seguridad, Mantenimiento y Salud del sistema permanecen siempre activadas.', notificationsSettingsSaving: 'Guardando…', notificationsSettingsError: 'No se pudieron guardar las preferencias de notificación.', notificationsRulesTitle: 'Alertas personalizadas', notificationsRulesHint: 'Crea hasta 50 reglas que generan una notificación al alcanzar un umbral.', notificationsRuleMetric: 'Métrica', notificationsRuleTarget: 'Enlace', notificationsRuleThreshold: 'Umbral', notificationsRuleLabel: 'Nombre (opcional)', notificationsRuleAdd: 'Añadir regla', notificationsRuleAllTargets: 'Todos mis enlaces compatibles', notificationsRuleTargetUnavailable: 'Enlace no disponible o eliminado', notificationsRuleEmpty: 'No hay reglas personalizadas.', notificationsRuleSaved: 'Regla guardada ✓', notificationsRuleDeleted: 'Regla eliminada', notificationsRuleError: 'No se pudo guardar la regla.', notificationsRuleEnable: 'Activar', notificationsRuleDisable: 'Desactivar', notificationsRuleDelete: 'Eliminar', notificationsRuleMetricViews: 'Vistas', notificationsRuleMetricDownloads: 'Descargas', notificationsRuleMetricBytesServed: 'Datos servidos (GB)', notificationsRuleMetricReceivedBytes: 'Datos recibidos (GB)', notificationsRuleCustomTitle: 'Alerta personalizada: {name}', notificationsTimeAgo: 'hace {v}', notificationsCount: '{n} notificación(es)', notificationsFilteredCount: '{shown} / {total} notificación(es)', notificationsNoMatch: 'Ninguna notificación coincide con los filtros.', notificationsFilters: 'Filtros de notificaciones', notificationsCategoryFilter: 'Filtrar por categoría', notificationsSeverityFilter: 'Filtrar por gravedad', notificationsAllCategories: 'Todas las categorías', notificationsAllSeverities: 'Todas las gravedades', notificationsSearch: 'Buscar…', notificationsSearchAria: 'Buscar en las notificaciones', notificationsCategoryActivity: 'Actividad', notificationsCategoryVisitors: 'Visitantes', notificationsCategoryThresholds: 'Umbrales', notificationsCategoryTraffic: 'Tráfico', notificationsCategoryImages: 'Imágenes', notificationsCategoryPwa: 'PWA', notificationsCategoryReceptions: 'Recepciones', notificationsCategorySearch: 'Búsqueda / OCR', notificationsCategorySecurity: 'Seguridad', notificationsCategoryShares: 'Compartidos', notificationsCategorySystemHealth: 'Salud del sistema', notificationsCategoryMaintenance: 'Mantenimiento', notificationsCategoryNetwork: 'Red', notificationsCategoryRestarts: 'Reinicios', notificationsCategoryUpdates: 'Actualizaciones', notificationsCategoryTransfers: 'Transferencias', notificationsCategoryDescShares: 'Descargas, caducidad, límites y cambios relacionados con los enlaces compartidos.', notificationsCategoryDescReceptions: 'Depósitos recibidos, archivos disponibles y cuotas de los enlaces de recepción.', notificationsCategoryDescImages: 'Primeras vistas, reemplazos de imágenes y regeneración de variantes.', notificationsCategoryDescTransfers: 'Transferencias completadas o fallidas, abandonos y reanudaciones imposibles.', notificationsCategoryDescVisitors: 'Nuevos países y nuevos navegadores o dispositivos visitantes.', notificationsCategoryDescThresholds: 'Umbrales de vistas y descargas alcanzados en tus enlaces.', notificationsCategoryDescTraffic: 'Volumen de descarga inusualmente alto y enlaces que se vuelven virales.', notificationsCategoryDescSearch: 'Fallos de OCR y problemas de indexación para la búsqueda.', notificationsCategoryDescPwa: 'Dispositivos PWA, suscripciones Push y permisos de notificaciones.', notificationsCategoryDescSecurity: 'Inicios de sesión inusuales, contraseñas, DLP y otras alertas de seguridad.', notificationsCategoryDescSystemHealth: 'Caídas de servicio, errores de configuración y problemas importantes del sistema.', notificationsCategoryDescMaintenance: 'Limpiezas automáticas y eliminaciones de archivos según las reglas de retención.', notificationsCategoryDescNetwork: 'Cambios de la dirección IP pública y eventos de red del servicio.', notificationsCategoryDescRestarts: 'Reinicios detectados de Direct-Xfer, incluida la indisponibilidad cuando está disponible.', notificationsCategoryDescUpdates: 'Actualizaciones disponibles y confirmación después de la instalación.', notificationsSeverityInfo: 'Información', notificationsSeveritySuccess: 'Éxito', notificationsSeverityWarning: 'Advertencia', notificationsSeverityCritical: 'Crítica',
      title: 'Enviar', navMain: 'Navegación principal', navSend: 'Enviar', navSendHint: 'Preparar y enviar archivos a un destino.', navImages: 'Imágenes', navImagesHint: 'Crear, gestionar y supervisar enlaces de imagen.', navActivity: 'Actividad', navActivityHint: 'Consultar el mismo historial de actividad persistente que en Direct-Xfer estándar.', navSystemHealth: 'Salud', navSystemHealthHint: 'Supervisar la salud del sistema, el rendimiento y los diagnósticos del servidor.', serverActivity: 'Actividad', serverActivityHint: 'Historial persistente de los eventos relevantes de Direct-Xfer.', serverActivitySearch: 'Buscar actividad…', serverActivityLoading: 'Cargando actividad…', serverActivityEmpty: 'Sin actividad registrada.', serverActivityLoadFail: 'No se pudo cargar el historial de actividad.', serverActivityFiltersAria: 'Filtros de actividad', serverActivityKindAria: 'Tipo de actividad', serverActivityKindAll: 'Todos los tipos', serverActivityKindTransfer: 'Transferencias', serverActivityKindAdmin: 'Administración', serverActivityKindSecurity: 'Seguridad', serverActivityKindVisitor: 'Visitantes', serverActivityKindSystem: 'Sistema', serverActivityShareAll:'Todas las comparticiones', serverActivityImagesOnly:'Solo imágenes', serverActivityPwaOnly:'Solo PWA', serverActivityHideRoutine:'Ocultar sistema rutinario', serverActivityReset: 'Limpiar filtros', serverActivitySummary: '{shown} mostrada(s) de {total}', localTransferHistory: 'Historial de transferencias de este dispositivo', activityImageDeleted: 'Imagen eliminada: {name}', activityShareDeleted: 'Enlace eliminado: {name}', activityImagePurged: 'Imagen eliminada definitivamente: {name}', activitySharePurged: 'Enlace eliminado definitivamente: {name}', activityImageRestored: 'Imagen restaurada: {name}', activityShareRestored: 'Enlace restaurado: {name}', activityTransferDone: 'Transferencia completada: {name}', activityTransferFailed: 'Transferencia interrumpida: {name}', navSettings: 'Ajustes', navSettingsHint: 'Configurar la PWA, la seguridad y el almacenamiento.', navShares: 'Compartir', navSharesHint: 'Crear enlaces para compartir desde archivos de tu servidor.', sharesTitle: 'Compartir archivos del servidor', sharesHint: 'Explora los archivos de tu servidor y crea enlaces directos para compartir.', sharesAdminRequired: 'Inicia sesión con una cuenta de administrador para explorar los archivos del servidor.', sharesSignIn: 'Iniciar sesión como administrador', sharesBrowse: 'Archivos del servidor', sharesUp: 'Carpeta superior', sharesCreate: 'Crear el recurso compartido', sharesNoneSelected: 'Ningún archivo seleccionado.', sharesSelected: '{n} elemento(s) seleccionado(s)', sharesExpiry: 'Caducidad', sharesExpiryNever: 'Nunca', sharesExpiry1h: '1 hora', sharesExpiry1d: '1 día', sharesExpiry7d: '7 días', sharesExpiry30d: '30 días', sharesExpiryForcedNever: 'El administrador configuró los nuevos recursos para que no caduquen.', sharesMaxDownloads: 'Descargas máx. (0 = ilimitado)', sharesRateLimit: 'Velocidad máxima (KB/s, 0 = ilimitado)', sharesRateEdit: 'Velocidad', sharesRatePrompt: 'Velocidad máxima en KB/s (0 = ilimitado):', sharesRateSaved: 'Velocidad actualizada ✓', sharesRateFail: 'No se pudo modificar la velocidad', sharesPassword: 'Contraseña (opcional)', sharesPasswordPlaceholder: '—', sharesCreateBtn: 'Crear enlace para compartir', sharesCreating: 'Creando…', sharesCreated: 'Recurso creado ✓', sharesCreatedLink:'Enlace listo para compartir', sharesCreateFail: 'No se pudo crear el recurso', sharesDlpWarning: 'DLP: {n} detección(es) sensible(s) ({level}). ¿Publicar de todos modos?', sharesDlpBlocked: 'Publicación bloqueada por la política DLP.', dlpTest: 'Probar DLP', dlpTestQueue: '🛡 Probar DLP', dlpTestSelected: '🛡 Probar DLP', dlpTesting: 'Análisis DLP…', dlpSafe: 'DLP ✓ no se detectó contenido sensible', dlpFound: 'DLP: {n} detección(es) ({level})', dlpLocalBlocked: 'Carga bloqueada por la política DLP antes de transferir.', dlpLocalConfirm: 'DLP detectó {n} elemento(s) sensible(s) ({level}) en {files} archivo(s). ¿Enviar igualmente?', dlpScanSkipped: 'DLP: {n} archivo(s) demasiado grandes/no analizados', dlpScanFailed: 'No se pudo ejecutar DLP: {error}', dlpOcrIncomplete: 'DLP incompleto: OCR falló para {n} archivo(s)', dlpPolicyLoading: 'Cargando política DLP…', dlpPolicyDisabled: 'DLP desactivado en el servidor', dlpPolicyText: 'Política {mode} · {mb} MB/archivo · OCR {ocr}', dlpAutoRules:'Reacción automática por gravedad', dlpAutoRulesHint:'Elige la acción que se aplica automáticamente para cada nivel de gravedad detectado.', dlpAutoReadOnly:'Las reacciones DLP automáticas solo se pueden cambiar desde un dispositivo owner/admin.', dlpSeverityLow:'Baja', dlpSeverityMedium:'Media', dlpSeverityHigh:'Alta', dlpSeverityCritical:'Crítica', dlpAutoSave:'Guardar reacciones DLP', dlpAutoSaved:'Reacciones DLP guardadas ✓', dlpAutoSaveFail:'No se pudieron guardar las reacciones DLP', dlpModeWarn: 'Avisar', dlpModeBlock: 'Bloquear', dlpModeQuarantine:'Cuarentena', dlpModeLog: 'Registrar', dlpLocalQuarantined:'Envío retenido por la política de cuarentena DLP; no se enviaron bytes.', dlpIncompleteQuarantined:'Envío retenido: el análisis DLP está incompleto y la política exige cuarentena.', dlpServerQuarantined:'El contenido fue puesto en cuarentena por la política DLP.', dlpQuarantineFailed:'Falló la cuarentena DLP; no se publicó ningún contenido.', dlpOcrOn: 'activado', dlpOcrOff: 'desactivado', dlpIncompleteBlocked: 'Carga bloqueada: el análisis DLP está incompleto.', dlpIncompleteConfirm: 'El análisis DLP está incompleto para {files} archivo(s) y encontró {n} detección(es). ¿Enviar igualmente?', dlpPolicyUnavailable: 'Política DLP no disponible: carga suspendida por seguridad.', dlpScanIncomplete: 'DLP incompleto: {n} elemento(s) sin analizar', sharesLibrary: 'Tus recursos compartidos', sharesEmpty: 'Aún no hay recursos compartidos.', sharesBrowseFail: 'No se pudo leer esta carpeta.', sharesLoginNeeded: 'Se requiere inicio de sesión de administrador.', sharesOpen: 'Abrir', sharesCopy: 'Copiar', sharesRevoke: 'Revocar', sharesRevoked: 'Recurso revocado ✓', sharesRevokeFail: 'No se pudo revocar', sharesRevokeConfirm: '¿Revocar este recurso compartido? El enlace dejará de funcionar.', sharesColor: 'Color de la tarjeta (opcional)', sharesAdminNote: 'Nota privada (opcional)', sharesAdminNotePlaceholder: 'Visible solo para administradores', sharesEditMeta: 'Color / nota', sharesArchive: 'Archivar', sharesUnarchive: 'Desarchivar', sharesShowArchived: '🗄 Archivos', sharesDuplicate: 'Duplicar', sharesDuplicatePrompt: 'Nombre del recurso duplicado:', sharesDuplicated: 'Recurso duplicado ✓', sharesDuplicateFail: 'No se pudo duplicar', sharesReactivate: 'Reactivar', sharesReactivated: 'Enlace reactivado ✓', sharesReactivateMissing: 'Los datos del enlace ya no están disponibles', sharesTrash: 'Papelera global', sharesTrashHint: 'Las imágenes, recepciones y recursos eliminados pueden restaurarse aquí mientras se conserven.', sharesTrashEmpty: 'La papelera está vacía.', sharesTrashRestore: 'Restaurar', sharesTrashRestoreSelected:'Restaurar selección', sharesTrashSelected:'{n} seleccionado(s)', sharesTrashRestoreSelectedOk:'{n} elemento(s) restaurado(s) ✓', sharesTrashRestored: 'Elemento restaurado ✓', sharesTrashDelete: 'Eliminar definitivamente', sharesTrashDeleteAll: 'Eliminar todo definitivamente', sharesTrashDeleteConfirm: '¿Eliminar definitivamente «{name}»? Esta acción es irreversible.', sharesTrashDeleteAllConfirm: '¿Eliminar definitivamente todos los elementos de la papelera? Esta acción es irreversible.', sharesTrashDeleted: 'Elemento eliminado definitivamente ✓', sharesTrashAllDeleted: '{n} elemento(s) eliminado(s) definitivamente ✓', sharesTrashDeleteFail: 'No se pudo eliminar definitivamente', sharesGlobalSearch: 'Buscar', sharesGlobalSearchPlaceholder: 'Buscar enlaces, usuarios, registros y contenido…', sharesGlobalSearchEmpty: 'Sin resultados.', sharesGlobalSearchFail: 'No se pudo buscar', sharesArchivedBadge: 'Archivado', sharesPinnedBadge:'Fijado', sharesPin:'Fijar', sharesUnpin:'Desfijar', sharesNeverDownloaded:'Nunca descargado', sharesPasswordProtected:'Con contraseña', sharesExpiresSoon:'Caduca pronto', sharesTotalSize:'Tamaño total: {size}', sharesRevokedBadge: 'Revocado', sharesItems: '{n} elemento(s)', sharesReceptions: 'Enlaces de recepción', sharesReceptionsEmpty: 'No hay enlaces de recepción.', sharesReceived: '{bytes} recibidos', sharesDownloadingNow: '{n} descarga(s) en curso', threadTitle: 'Conversación', threadEmpty: 'Sin mensajes.', threadReplyPh: 'Responder al visitante…', threadSend: 'Enviar', threadSending: 'Enviando…', threadError: 'No se pudo enviar, inténtalo de nuevo.', threadYou: 'Tú', threadVisitor: 'Visitante', openAdmin: 'Abrir la administración', language: 'Idioma', theme: 'Tema', copyLink: 'Copiar enlace', pasteLink: 'Pegar enlace', editDestination: 'Editar destino', addDestination: 'Añadir destino', passwordPlaceholder: 'Contraseña del enlace', destinationPlaceholder: 'Enlace o token de recepción', destinationNamePlaceholder: 'Nombre opcional del destino', senderPlaceholder: 'Nombre solicitado por este enlace', globalProgress: 'Progreso global', keyPlaceholder: 'Clave de cifrado del enlace', titlePlaceholder: 'Contenido compartido', themeDark: 'Oscuro', themeLight: 'Claro', themeAuto: 'Auto', install: 'Instalar', installIosHint: 'Para instalar Direct-Xfer, toca el botón Compartir del navegador y luego «Añadir a pantalla de inicio».', installBrowserHint: 'Chrome todavía no ha validado la instalación completa. No elijas un simple acceso directo: usa una dirección HTTPS de confianza, interactúa con la página y mantenla abierta unos instantes.', installHttpsRequired: 'La instalación completa no es posible desde esta dirección HTTP o certificado no confiable. Android solo puede crear un acceso directo. Abre Direct-Xfer mediante HTTPS con un certificado válido.', installSecurePending: 'La instalación se está preparando. En Chrome, interactúa con la página y mantenla abierta unos 30 segundos. Si el logotipo no aparece, verifica que Android confíe en el certificado HTTPS.', installOpenHttps: 'Abrir en HTTPS',
      offline: 'Sin conexión — los envíos continuarán al reconectarse.', updateReady: 'Hay una nueva versión disponible.', updateNow: 'Actualizar', pullToRefresh: 'Desliza hacia abajo para actualizar', releaseToRefresh: 'Suelta para actualizar', refreshing: 'Actualizando…', backExit: 'Pulsa de nuevo para salir', destination: 'Destino',
      destinationHint: 'Un enlace de recepción Direct-Xfer de esta instancia.', linkOrToken: 'Enlace o token', displayName: 'Nombre visible', rememberDestination: 'Recordar este destino en el dispositivo', rememberKey: 'Recordar también la clave secreta en este dispositivo',
      scanQr: '📷 Escanear QR', saveDestination: 'Añadir', updateDestination: 'Guardar', removeDestination: 'Quitar', cancel: 'Cancelar', createLinkTitle: 'Crear un enlace de recepción', newLink: 'Nuevo', createLinkName: 'Nombre del nuevo enlace', createLinkPlaceholder: 'ej. Fotos vacaciones', createLinkHint: 'Se creará un nuevo enlace de recepción y se añadirá a tus destinos. Compártelo para recibir archivos.', createDo: 'Crear enlace', creating: 'Creando…', createOk: 'Enlace creado ✓', createFail: 'No se pudo crear el enlace',
      imgLinksTitle: 'Enlaces de imagen', imgLinksHint: 'Crea enlaces directos a tus imágenes: cada enlace ofrece las versiones Completa, Mini y Micro, sin página intermedia.', imgLinksAdd: 'Añadir imágenes', imgCreateTitle: 'Crear enlaces', imgCreateHint: 'Elige las imágenes que quieres compartir o edita una antes de subirla.', imgLibraryTitle: 'Tus enlaces', imgLibraryHint: 'Busca, ordena y administra las imágenes ya compartidas.', imgGlobalActions: 'Acciones globales', imgManageActions: 'Administrar enlace', imgStripExif: 'Quitar datos EXIF/GPS antes de compartir', imgStripExifHint: 'La limpieza se realiza localmente en este dispositivo antes de subir la imagen.', imgStrippingMetadata: 'Quitando EXIF/GPS…', imgMetadataRemoved: 'EXIF/GPS eliminados', imgUploading: 'Subiendo…', imgThumbing: 'Mini y Micro…', imgReady: 'Listo', imgCopyBBCode: 'Copiar BBCode', imgCopied: 'Enlace copiado ✓', clearSearch: 'Borrar búsqueda', imgListEmpty: 'Aún no hay imágenes compartidas. Usa «Añadir imágenes» para crear tu primer enlace.', imgNoMatch: 'Ninguna imagen coincide con tu búsqueda.', destEmptyHint: 'Aún no hay destino. Añade un enlace de recepción (＋) o crea uno con «Nuevo».', destEmoji: 'Emoji (indicador visual)', imgCopyImage: 'Copiar imagen', imgCompare: 'Comparar', imgCompareTitle: 'Comparar formatos', pwStrengthLabel: 'Fuerza de la contraseña', pwWeak: 'Débil', pwMedium: 'Media', pwStrong: 'Fuerte', historyResend: 'Reenviar', historyDestGone: 'Destino no encontrado — vuelve a añadirlo.', resendReady: 'Destino seleccionado — añade tus archivos.', imgLinkFail: 'No se pudo crear el enlace', imgVariantsFailed: 'Imagen guardada, pero no se pudieron actualizar Mini/Micro.', revokeShare: 'Revocar', revokeConfirm: '¿Revocar este recurso compartido? El enlace dejará de funcionar.', revokeSuccess: 'Revocado ✓', revokeFail: 'No se pudo revocar', imgVariantFull: 'Completa', imgVariantMini: 'Mini', imgVariantMicro: 'Micro', imgViews: '{n} vistas', imgVisitors: '{n} visitantes', imgStatsLoading: 'Estadísticas…', imgStatsUnavailable: 'Estadísticas no disponibles', imgStatsButton: '📊 Stats', imgStatsTitle: 'Estadísticas detalladas', imgStatsOverview: 'Resumen', imgStatsCopies: 'Copias de la imagen', imgStatsRecent: 'Accesos recientes a la imagen', imgStatsStorage: 'Almacenamiento', imgStatsDimensions: 'Dimensiones', imgStatsLastView: 'Última vista', imgStatsCreated: 'Creada', imgStatsExpiry: 'Caducidad', imgStatsStatus: 'Estado', imgStatsActive: 'Activa', imgStatsInactive: 'Inactiva', imgStatsExpired: 'Caducada', imgStatsNoRecent: 'No hay accesos recientes registrados.', imgStatsNever: 'Nunca', imgStatsUnknown: 'Desconocido',
      imgSearch: 'Buscar imágenes…', imgSortLabel: 'Ordenar imágenes', imgSortNewest: 'Más recientes', imgSortOldest: 'Más antiguas', imgSortName: 'Nombre', imgSortSize: 'Tamaño', imgSortViews: 'Vistas', imgSortVisitors: 'Visitantes', imgSortExpiry: 'Caducidad', imgFilterLabel: 'Filtrar imágenes', imgFilterAll: 'Todas', imgFilterActive: 'Activas', imgFilterPopular: 'Populares', imgFilterLarge: 'Grandes', imgFilterExpiring: 'Próximas a caducar', imgFilterFavorite: 'Favoritas', imgFilterProtected: 'Protegidas', imgAdvancedOptions: 'Opciones de imágenes', imgCompact: 'Vista compacta', imgHideExpired: 'Ocultar imágenes caducadas', imgAutoCopy: 'Copiar automáticamente al crear', imgDefaultExpiry: 'Caducidad favorita', imgMaxViews: 'Límite de vistas', imgPassword: 'Contraseña', imgTags: 'Etiquetas', imgPrivateNote: 'Nota privada', imgRenameTemplate: 'Plantilla de nombre', imgBulkEdit: 'Editar', imgCreateAlbum: 'Crear álbum', imgDashboard: 'Gráfico de estadísticas', imgAlbums: 'Álbumes compartibles', imgActionHistory: 'Historial de acciones de imagen', imgSelected: '{n} seleccionada(s)', imgEditPrompt: 'Editar imágenes seleccionadas', imgAlbumName: 'Nombre del álbum', imgAlbumCreated: 'Álbum creado ✓', imgSettingsSaved: 'Ajustes guardados ✓', imgDuplicateFound: 'Esta imagen ya fue compartida. ¿Continuar?', imgExpirySoon: 'El enlace «{name}» caduca pronto.', imgUndoRevoke: 'Imagen retirada — ¿Deshacer?', imgRevokePending: 'Revocación en {n} s…', imgCancelRevoke: 'Cancelar revocación', imgRevokeCancelled: 'Revocación cancelada ✓', imgQrDownloaded: 'QR descargado ✓', imgFavorite: 'Favorita', imgUnfavorite: 'Quitar de favoritas', imgExpired: 'Caducada', imgInactive: 'Inactiva', imgViewLimitReached: 'Límite de vistas alcanzado', imgProtected: 'Protegida', imgViewLimit: '{n} vistas máx.', imgNoAlbums: 'No hay álbumes.', imgVariantAuto: 'Automático', imgReplace: 'Reemplazar sin cambiar el enlace', imgVersions: 'Versiones', imgReplaceDone: 'Imagen reemplazada, URL conservada ✓', imgResizeMini: 'Redimensionar la Mini', imgResizeMiniPrompt: 'Nuevo tamaño de la Mini: un número de píxeles (lado más largo, ej. 250) O un porcentaje del tamaño total (ej. 50%). La Micro será la mitad:', imgResizeMiniInvalid: 'Valor no válido: píxeles (16 a 4096) o porcentaje (1 a 100%).', imgResizeMiniDone: 'Mini redimensionada a {w}×{h} ✓', imgRestoreVersion: 'Restaurar una versión', imgVersionRestored: 'Versión restaurada ✓', imgAdaptiveReady: 'Optimización adaptativa', albumInvites: 'Invitaciones', albumInviteCreate: 'Crear invitación', albumInviteRole: 'Rol (reader, contributor, manager)', albumInviteCopied: 'Enlace de invitación copiado ✓', albumInviteRevoke: 'Revocar invitación', albumCollabSummary: '{n} invitación(es)', imgAlbumCopied: 'Enlace del álbum copiado ✓', imgChartSummary: '{images} imágenes · {views} vistas · {visitors} visitantes · {bytes}', imgComparePeriod: 'Período comparativo', imgCompare7d: '7 días', imgCompare30d: '30 días', imgCompareSummary: '{days} d vs período anterior: {views} vistas · {created} imágenes creadas', imgCompareNew: 'nuevo', imgHotlinkHosts: 'Dominios autorizados para integrar', imgHotlinkPlaceholder: 'foro.ejemplo.com, *.sitio.net', imgHotlinkHint: 'Vacío = protección desactivada. Las visitas directas siguen permitidas.', imgHotlinkProtected: 'Protección hotlink', imgNotifyFirstView: 'Notificar en la primera visita', imgFirstViewArmed: 'Alerta de primera visita', imgFirstViewSent: 'Primera visita notificada', imgFirstViewToast: '👁 Primera visita de «{name}»', imgSmartBlur: 'Desenfoque inteligente local', imgSmartBlurFaces: 'Rostros', imgSmartBlurFacesPlates: 'Rostros y matrículas', imgSmartBlurAll: 'Rostros, matrículas y texto sensible', imgSmartBlurHint: 'Análisis local con revisión antes del envío; ninguna imagen se envía a un servicio externo.', imgSmartBlurAnalyzing: 'Análisis local…', imgSmartBlurReady: '{n} zona(s) ocultada(s). Revísalas y aplica.', imgSmartBlurUnsupported: 'Este navegador no admite la detección de rostros; añade las zonas manualmente.', imgSmartBlurSkip: 'Continuar sin desenfoque', imgRetentionRules: 'Reglas automáticas de retención', imgRetentionWarning: 'Estas reglas revocan definitivamente las imágenes y borran sus archivos. Están desactivadas por defecto.', imgRetentionAge: 'Edad máxima (días)', imgRetentionInactive: 'Inactividad máxima (días)', imgRetentionViews: 'Revocar tras este número de vistas', imgRetentionStorage: 'Almacenamiento máximo (MB)', imgRetentionSave: 'Guardar y aplicar', imgRetentionSaved: 'Reglas de retención guardadas ✓', imgRetentionResult: '{n} imagen(es) revocada(s) · {bytes} liberados', imgRetentionSummary: '{n} imagen(es) · {bytes}', enabled: 'Activado', disabled: 'Desactivado', optional: 'Opcional', refresh: 'Actualizar', themeSchedule: 'Según la hora', protectedLink: '🔒 Enlace protegido', unlock: 'Desbloquear',
      encryptedLink: '🔐 Cifrado de extremo a extremo', encryptionKey: 'Clave del enlace', passphrase: 'Frase secreta', addFiles: 'Añadir archivos',
      durableQueue: 'Los archivos se copian al almacenamiento duradero antes del envío para poder reanudarlos tras cerrar la PWA.', takePhoto: 'Tomar una foto', chooseFiles: 'Elegir archivos',
      chooseFolder: 'Elegir carpeta', optimizePhotos: 'Optimizar fotos antes de enviar', parallelUploads: 'Envíos paralelos', senderName: 'Tu nombre', pause: 'Pausa', resume: 'Continuar',
      retryAll: '↻ Reintentar', removePending: 'Quitar todo', send: 'Enviar', clearCompleted: 'Borrar envíos terminados', history: 'Historial local', clearHistory: 'Borrar historial',
      settings: 'Ajustes y seguridad', autoResume: 'Continuar automáticamente tras cerrar o reconectar', storage: 'Almacenamiento local', protectStorage: 'Proteger', passkeyTitle: 'Identificación biométrica', passkeyHint: 'Usa la huella, el reconocimiento facial o el desbloqueo seguro del dispositivo para iniciar sesión sin contraseña.', passkeyAdd: 'Activar en este dispositivo', passkeyAdding: 'Activando…', passkeyAdded: 'Identificación biométrica activada ✓', passkeyFailed: 'No se pudo modificar la identificación biométrica.', passkeyEmpty: 'No hay ninguna identificación biométrica registrada.', passkeyRemove: 'Desactivar esta', passkeyRemoveConfirm: '¿Desactivar esta identificación biométrica?', passkeyRemoveSharedConfirm: 'Esta identificación está vinculada a {n} dispositivos. ¿Desactivarla en todos?', passkeyRemoved: 'Identificación biométrica desactivada', passkeyDevices: '{n} dispositivo(s)', biometricDisable: 'Desactivar la identificación biométrica', biometricDisabling: 'Desactivando…', biometricDisableConfirm: '¿Desactivar todas las identificaciones biométricas de esta cuenta en todos los dispositivos?', biometricDisabled: 'Identificación biométrica desactivada por completo ✓', passkeyNamePrompt: 'Nombre de la passkey (opcional):', passkeyCreated: 'Activada {date}', passkeyUsed: 'usada {date}', passkeyNeverUsed: 'nunca usada', passkeyCurrent: 'este dispositivo', biometricChecking: 'Comprobando compatibilidad…', biometricReady: 'Compatible: puedes activarla en este dispositivo.', biometricEnabled: 'La identificación biométrica está activada en este dispositivo.', biometricConfigured: '{n} identificación(es) biométrica(s) configurada(s) para esta cuenta.', biometricUnsupported: 'La biometría segura no está disponible en este dispositivo o navegador. Aun así, puedes desactivar las identificaciones existentes.', biometricHttpsRequired: 'La activación biométrica requiere una conexión HTTPS de confianza. La desactivación sigue disponible.', biometricRecentAuth: 'Vuelve a iniciar sesión para modificar este ajuste sensible.', biometricReauth: 'Volver a iniciar sesión para modificar', biometricReauthFailed: 'No se pudo reiniciar la autenticación.', biometricStatusUnavailable: 'El estado biométrico no está disponible temporalmente.', biometricCredentialName: 'Biometría · {device}', biometricLoadFailed: 'No se pudieron cargar las identificaciones registradas.', autoLock: 'Bloqueo automático', autoLockNever: 'Nunca', autoLock5: 'Después de 5 minutos', autoLock15: 'Después de 15 minutos', autoLock30: 'Después de 30 minutos', autoLock60: 'Después de 1 hora', autoLocking: 'Sesión bloqueada — autentícate para continuar.',
      deviceAccess: 'Acceso del dispositivo', deviceChecking: 'Comprobando el dispositivo…', deviceStatusUnavailable: 'El estado del dispositivo no está disponible. Toca Vincular para volver a intentarlo.',
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
      deviceRevokeFailed: 'No se pudo revocar', deviceCurrent: 'este dispositivo', deviceLast: 'Último uso {date}', devicePlatformOther:'Otro', deviceVersionUnknown:'Versión PWA desconocida', localCleared: 'Datos locales borrados', sharedTextName: 'compartido.txt',
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
      imgCopyAll: '🔗 Copiar todos', imgOpen: 'Abrir en una pestaña', allImgCopied: '{n} enlace(s) copiado(s) ✓', noImgLinks: 'No hay enlaces para copiar.', imgCopyTemplate: 'Plantilla de copia', copyTemplateStandard: 'Estándar', copyTemplateForum: 'Foro', copyTemplateEmail: 'Correo', imgQrZip: '🗜 QR en ZIP', imgQrZipDone: 'Archivo de QR descargado ✓', imgExportStatsCsv: 'CSV de estadísticas', imgStatsCsvDone: 'Estadísticas exportadas ✓', imgFavoriteAction1: 'Acción favorita 1', imgFavoriteAction2: 'Acción favorita 2', imgFavoriteAction3: 'Acción favorita 3', imgActionOpen: 'Abrir', imgQrDownload: 'Descargar QR', pinItem: 'Fijar', unpinItem: 'Desfijar', tagColors: 'Colores de etiquetas', tagColorsReset: 'Restablecer colores', expiresIn: 'Caduca en {time}', expiredNow: 'Caducado',
      shareLink: 'Compartir enlace', qrForLink: 'QR del enlace', qrTitle: 'QR del enlace de recepción', qrDestHelp: 'Escanea este código en otro dispositivo para abrir el enlace de recepción.', qrFail: 'No se pudo crear el código QR',
      receivedTitle: 'Contenido recibido', receivedHelp: 'Archivos recibidos en este enlace de recepción, servidos por el servidor.', receivedRefresh: 'Actualizar', receivedLoading: 'Cargando…', receivedEmpty: 'Aún no se ha recibido ningún archivo.', receivedFail: 'No se pudo cargar el contenido recibido.', receivedCount: '{n} archivo(s) · {size}', receivedDownload: 'Descargar',
      receivedPendingTitle: 'Pendiente de aprobación', receivedApprove: 'Aprobar', receivedReject: 'Rechazar', receivedPendingCount: '{n} archivo(s) pendientes', createModerated: 'Validación manual: mantener los archivos pendientes hasta aprobarlos', sharesFirstUseExpiry: 'Caducar tras el primer uso (horas, 0 = desactivado)', sharesOneTime: 'Uso único reforzado (revocar tras la primera recuperación completa)', sharesSmartExpiryHint: 'Caducidad inteligente: los límites activos se combinan con O; el primero alcanzado desactiva el enlace.',
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
      wifiOnly: 'Enviar solo con Wi-Fi', largeWifiOnly: 'Transferencias grandes solo por Wi-Fi', largeWifiThreshold: 'Umbral de transferencia grande', persistentTransferNotification: 'Notificación Android durante transferencias activas', transferNotifPermissionDenied: 'Las notificaciones están bloqueadas para este sitio.', waitingWifi: 'esperando Wi-Fi', stripExif: 'Quitar metadatos (EXIF/GPS)',
      zipBundle: '🗜 Agrupar en ZIP', zipDone: 'Archivo ZIP creado ✓', zipNeedTwo: 'Selecciona al menos dos archivos.', zipping: 'Creando ZIP…',
      voiceNote: 'Nota de voz', recording: 'Grabando', recStop: '⏹ Detener', recAdd: 'Añadir a la cola', recMicFail: 'Micrófono no disponible',
      annotate: 'Anotar', editorBeforeShare: 'Editar antes de compartir', annPan: '✋ Mover', annPen: '✏️ Lápiz', annBlur: '🌫 Desenfoque', annRedact: '⬛ Censurar', annDetectFaces: '🙂 Detectar rostros', annDetectPlates: '▭ Detectar matrículas', annUndo: '↶ Deshacer', annClear: 'Borrar todo', annApply: 'Aplicar',
      selectedN: '{n} seleccionado(s)', bulkRemove: 'Quitar', bulkRetry: 'Reintentar', selectAll: 'Todo',
      batchNote: 'Etiqueta / nota (opcional)', notePlaceholder: 'ej. Factura, Vacaciones…',
      multiSend: '📢 Enviar a varios…', multiSendTitle: 'Enviar a varias destinaciones', multiSendHelp: 'El lote se envía a cada destino marcado. Se omiten los enlaces cifrados o que requieren un nombre.', multiSendGo: 'Iniciar envíos', multiSendNone: 'No hay destino compatible seleccionado.', multiSendQueued: 'Envío a {n} destino(s) preparado.',
      cmdPalette: 'Paleta de comandos', cmdPlaceholder: 'Escribe un comando…', cmdNoMatch: 'Sin comandos.', cmdOpenSettings: 'Abrir ajustes', cmdOpenHistory: 'Abrir el historial', cmdToggleTheme: 'Cambiar tema',
      expireLabel: 'Caducidad (auto-borrado)', expNever: 'Nunca', exp1h: '1 hora', exp24h: '24 horas', exp7d: '7 días', exp30d: '30 días',
      liveTitle: 'Recepciones en vivo', liveReceived: '📥 {name} recibido en «{dest}»', liveEnable: 'Notificaciones de recepción', livePush: 'Notificaciones push (app cerrada)', pushLanguage: 'Idioma de las notificaciones push', pushLanguageSaved: 'Idioma de las notificaciones push guardado ✓', livePushOn: 'Notificaciones push activadas ✓', livePushOff: 'Notificaciones push desactivadas', livePushFail: 'No se pudieron activar las notificaciones', liveConnected: 'En vivo ✓', pushTestBtn: 'Probar notificaciones push', pushTestHelp: 'Envía una notificación real desde el servidor a este dispositivo.', pushTestSending: 'Probando push…', pushTestPreparing: 'Preparando la suscripción push…', pushTestAccepted: 'Servicio push aceptado en {ms} ms · esperando Android…', pushTestSent: 'Notificación de prueba enviada ✓', pushTestDenied: 'Las notificaciones están bloqueadas en Android/el navegador.', pushTestUnsupported: 'Web Push no está disponible en este dispositivo.', pushTestNoSub: 'No hay una suscripción push válida para este dispositivo.', pushTestRepairing: 'Suscripción push caducada: reparando y reintentando…', pushTestFailed: 'Falló la prueba push.', pushTestDelivered: 'Notificación recibida por Android {ms} ms después del envío ✓', pushTestAcceptedDelayed: 'Aceptada por el servicio push, pero no recibida por Android después de {seconds} s.',
      copyToken: 'Copiar token', tokenCopied: 'Token copiado ✓',
      pinDestination: '⭐ Fijar', unpinDestination: '☆ Soltar', pinned: 'Destino fijado ✓', unpinned: 'Destino soltado',
      resetBatch: '↺ Restablecer lote', resetBatchDone: 'Opciones del lote restablecidas ✓',
      filesPending: '{n} en espera', filesTotalSummary: '{n} archivo(s) · {total} · {sent} enviados', clipboardQueue: 'Portapapeles', clipboardQueued: '{n} elemento(s) del portapapeles añadido(s) ✓', clipboardEmpty: 'El portapapeles no contiene archivos, imágenes ni texto utilizables.', clipboardUrlFallback: 'URL añadida como texto (la descarga directa está bloqueada).', pasteText: 'Pegar texto', pastedTextName: 'texto-pegado.txt', pasteTextEmpty: 'No hay texto en el portapapeles.',
      masterSelect: 'Seleccionar todo', addFromUrl: 'Desde una URL', urlPrompt: 'Dirección de la imagen o archivo a añadir:', urlFetching: 'Obteniendo…', urlFailed: 'No se pudo obtener (¿bloqueado por CORS?)', urlAdded: 'Archivo añadido ✓', urlInvalid: 'Dirección no válida.',
      bulkRename: '✎ Renombrar', renamePrompt: 'Prefijo de los nombres (se añadirá numeración):', renameDone: '{n} archivo(s) renombrado(s)',
      hashTitle: 'Huella SHA-256', hashing: 'Calculando huella…', hashCopied: 'Huella SHA-256 copiada ✓', hashFail: 'No se pudo calcular la huella',
      exportSettings: 'Exportar ajustes', importSettings: 'Importar', settingsImported: 'Ajustes importados ✓', settingsImportFail: 'Archivo de ajustes no válido',
      accentLabel: 'Color de acento', accentReset: 'Predeterminado',
      screenCapture: 'Capturar pantalla', captureFailed: 'No se pudo capturar la pantalla', screenshotName: 'captura-pantalla',
      undo: 'Deshacer', fileRemoved: 'Archivo retirado', fileRestored: 'Archivo restaurado ✓', lightboxAlt: 'Vista previa de la imagen',
      sortType: 'Tipo', bulkInvert: '⇄ Invertir',
      ocrTitle: 'OCR local', ocrAction: 'Extraer texto (OCR)', ocrPrivacy: 'Procesado en este dispositivo. Solo se descargan los motores y modelos OCR/PDF; el documento no se envía a ningún servicio OCR.', ocrLanguage: 'Idioma', ocrLangFrEn: 'Francés + inglés', ocrLangFr: 'Francés', ocrLangEn: 'Inglés', ocrLangEs: 'Español', ocrRun: 'Extraer texto', ocrCancel: 'Cancelar OCR', ocrCopy: 'Copiar texto', ocrAddTxt: 'Añadir .txt a la cola', ocrSearch: 'Buscar en el texto…', ocrPrev: 'Anterior', ocrNext: 'Siguiente', ocrReady: 'Listo para extraer texto.', ocrLoadingEngine: 'Cargando motor OCR…', ocrLoadingPdf: 'Leyendo PDF…', ocrEmbedded: 'Texto PDF incorporado detectado', ocrScanningPage: 'OCR de la página {page}/{total}…', ocrReadingPage: 'Leyendo página {page}/{total}…', ocrComplete: 'OCR terminado · {chars} caracteres', ocrNoText: 'No se detectó texto.', ocrFailed: 'No se pudo hacer OCR: {error}', ocrCanceled: 'OCR cancelado.', ocrCopied: 'Texto OCR copiado ✓', ocrQueued: 'Archivo de texto añadido a la cola ✓', ocrMatches: '{current}/{total}', ocrNoMatch: '0 resultados', ocrUnsupported: 'OCR disponible para imágenes y PDF.', ocrEngineNetwork: 'El primer OCR necesita Internet para descargar el motor y los modelos.',
      dedupeChecking: 'Buscando un duplicado en el servidor…', dedupeHit: 'Ya está en el servidor · subida evitada ✓', dedupeUnavailable: 'Deduplicación no disponible — subida normal.',
      editorTitle: 'Editor de fotos', editorAdjust: 'Ajustes', editorBrightness: 'Brillo', editorContrast: 'Contraste', editorSaturation: 'Saturación', editorApplyAdjust: 'Aplicar ajustes', editorRotateLeft: '↶ 90°', editorRotateRight: '↷ 90°', editorFlipH: '↔ Espejo', editorFlipV: '↕ Voltear', editorResizeMax: 'Dimensión máx.', editorResizeApply: 'Redimensionar', editorFormat: 'Formato de salida', editorQuality: 'Calidad', editorZoom: 'Zoom', editorZoomOut: 'Alejar', editorZoomIn: 'Acercar', editorZoomFit: 'Ajustar', editorBrushSize: 'Tamaño del pincel', editorLargeConfirm: 'Esta imagen es muy grande ({w}×{h}). Aceptar: usar una copia de 1800 px. Cancelar: conservar la resolución original (usa más memoria).',
      privacyInspect: 'Privacidad', privacyTitle: 'Limpieza de metadatos', privacyLocal: 'El análisis y la limpieza se realizan localmente en este dispositivo.', privacyAnalyze: 'Analizar', privacyClean: 'Limpiar y reemplazar', privacyCleaned: 'Metadatos sensibles limpiados ✓', privacyNoFindings: 'No se detectaron metadatos sensibles evidentes.', privacyFindings: '{n} elemento(s) sensible(s) detectado(s)', privacyImageMetadata: 'Metadatos de imagen (EXIF/XMP/IPTC)', privacyPdfMetadata: 'Metadatos PDF', privacyOfficeMetadata: 'Propiedades Office', privacyThumbnail: 'Miniatura incorporada', privacyAuthor: 'Autor / último autor', privacyGps: 'Coordenadas GPS', privacyCustom: 'Propiedades personalizadas', privacyUnsupported: 'La limpieza automática no es compatible con este formato.', privacyAnalyzing: 'Análisis local…', privacyCleaning: 'Limpieza local…',
      annDetectSensitive: '🔐 Texto sensible', sensitiveScanning: 'Buscando texto sensible localmente…', sensitiveFound: '{n} zona(s) de texto sensible ocultada(s). Revisa el resultado.',
      ocrIndexTitle: 'Índice OCR local', ocrIndexHint: 'Busca en todos los documentos OCR procesados en este dispositivo.', ocrIndexSearch: 'Buscar en todos los OCR…', ocrIndexEmpty: 'No hay documentos OCR indexados.', ocrIndexSaved: 'Documento añadido al índice OCR local ✓', ocrIndexCount: '{n} documento(s) indexado(s)', ocrIndexOpen: 'Abrir', ocrIndexDelete: 'Eliminar del índice', ocrIndexClear: 'Vaciar índice', ocrIndexClearConfirm: '¿Eliminar todo el índice OCR local?', ocrIndexMeta: '{size} · {date} · {chars} caracteres',
      queueSearch: 'Filtrar la cola…', estOptim: '≈ {size} tras optimizar', optimizationEstimate: '{before} → ≈ {after} · ahorro {saved} ({pct} %) {eta}', optimizationEstimating: 'Estimando el tamaño optimizado…', copyQueueNames: 'Copiar nombres', queueNamesCopied: '{n} nombre(s) copiado(s) ✓', quickFilters: 'Filtros rápidos', filterAll: 'Todos', filterImages: 'Imágenes', filterVideos: 'Vídeos', filterDocuments: 'Documentos', filterWaiting: 'En espera', filterDone: 'Terminados', filterErrors: 'Errores', dragHandle: 'Mover en la cola', batchElapsed: '⏱ {time}', avgPerFile: 'prom. {time}/archivo', transferActiveExit: 'Hay una transferencia en curso. Termínala o ponla en pausa antes de salir.', lowBatteryConfirm: 'La batería está al {level}% y no está cargando. ¿Continuar con 1 envío paralelo? Cancela para conectar el dispositivo.', notifUploadTitle: 'Transferencia Direct-Xfer terminada', notifUploadBody: '{ok} correcto(s){fail}', notifOpen: 'Abrir', notifCopyLink: 'Copiar enlace', notifResend: 'Reenviar', notifLinkCopied: 'Enlace de destino copiado ✓', rotate: 'Girar',
      quotaNearFull: 'La cuota de este destino está casi llena.',
      imgQrAll: '▦ QR combinado', imgQrTooBig: 'Demasiados enlaces para un solo QR.', bulkShare: 'Compartir',
      onlineStatus: 'En línea', offlineStatus: 'Sin conexión', networkWifi: 'Wi-Fi', networkCellular: 'Datos móviles',
      networkDashboard: 'Red en directo', networkDashboardHint: 'Velocidad, latencia, bloques y reintentos durante las transferencias.', networkTestNow: 'Probar conexión', networkTesting: 'Prueba de red…', networkTestDone: 'Red: {quality} · ↑ {up} · ↓ {down} · {latency} ms', networkTestFailed: 'No se pudo probar la red — se conservan los ajustes automáticos.', networkTestAuto: 'Transferencia grande detectada: probando la red antes del envío…', networkLatency: 'Latencia', networkUpload: 'Subida', networkDownload: 'Bajada', networkLiveRate: 'Velocidad actual', networkChunk: 'Bloque', networkParallel: 'Paralelos', networkRetries: 'Reintentos', networkActive: 'Activos', networkAdaptive: 'Adaptación', networkAdaptiveAuto: 'Auto', networkAdaptiveSlow: 'Red lenta · 1 flujo', networkAdaptiveRecovering: 'Recuperación', networkQualityExcellent: 'excelente', networkQualityGood: 'buena', networkQualityFair: 'media', networkQualityPoor: 'baja', networkNotTested: 'Sin probar', networkLastTest: 'Última prueba: {when}', networkGraphLabel: 'Historial de velocidad de subida',
      errorCenter: 'Centro de errores', errorCenterHint: 'Diagnóstico agrupado de fallos recientes y archivos con error.', errorCenterEmpty: 'No hay errores recientes.', errorCenterClear: 'Borrar registro', errorCenterCopy: 'Copiar informe', errorCenterRetry: 'Reintentar', errorCenterRetryAll: 'Reintentar todos', errorCategoryProxy: 'Proxy inverso', errorCategoryQuota: 'Cuota / almacenamiento', errorCategoryNetwork: 'Conexión', errorCategoryServer: 'Servidor', errorCategoryAuth: 'Autorización', errorCategoryFile: 'Archivo', errorCategoryOther: 'Otro', errorLogCleared: 'Registro de errores borrado ✓', errorReportCopied: 'Informe de errores copiado ✓', errorLocalStorage: 'El almacenamiento local es insuficiente o no está disponible.',
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
  // 1.48.2 — enrollment diagnostics shared by the multi-device biometric flow.
  Object.assign(STRINGS.fr, {
    biometricPairRequired: 'Associez d’abord cet appareil à Direct-Xfer avant d’activer la biométrie.',
    biometricAlreadyEnabled: 'Identification biométrique déjà disponible et associée à cet appareil ✓',
    biometricAlreadySynced: 'Cette identification est déjà synchronisée sur l’appareil. Déconnectez-vous puis utilisez le bouton biométrique une fois pour l’associer.',
    biometricDomainMismatch: 'Le domaine HTTPS de la PWA ne correspond pas à celui configuré pour la biométrie.',
    biometricServerRejected: 'Le serveur a refusé l’identification créée. Réessayez après avoir rouvert les paramètres.'
  });
  Object.assign(STRINGS.en, {
    biometricPairRequired: 'Pair this device with Direct-Xfer before enabling biometrics.',
    biometricAlreadyEnabled: 'Biometric identification is already available and linked to this device ✓',
    biometricAlreadySynced: 'This identification is already synchronized on the device. Sign out, then use the biometric button once to link it.',
    biometricDomainMismatch: 'The PWA HTTPS domain does not match the domain configured for biometrics.',
    biometricServerRejected: 'The server rejected the created identification. Reopen settings and try again.'
  });
  Object.assign(STRINGS.es, {
    biometricPairRequired: 'Vincula primero este dispositivo con Direct-Xfer antes de activar la biometría.',
    biometricAlreadyEnabled: 'La identificación biométrica ya está disponible y vinculada a este dispositivo ✓',
    biometricAlreadySynced: 'Esta identificación ya está sincronizada en el dispositivo. Cierra la sesión y usa una vez el botón biométrico para vincularla.',
    biometricDomainMismatch: 'El dominio HTTPS de la PWA no coincide con el configurado para la biometría.',
    biometricServerRejected: 'El servidor rechazó la identificación creada. Vuelve a abrir los ajustes e inténtalo de nuevo.'
  });

  // 1.52.1 follow-up — unified server-side action history + Undo in the PWA.
  Object.assign(STRINGS.fr, {
    actionHistoryTitle: 'Historique d’actions',
    actionHistoryHint: 'Consultez les dernières actions administratives et annulez celles qui sont encore réversibles.',
    actionHistoryEmpty: 'Aucune action récente.',
    actionHistoryUndo: '↶ Annuler',
    actionHistoryUndone: 'Annulée',
    actionHistoryUnavailable: 'Plus annulable',
    actionHistoryConfirm: 'Annuler « {label} » ?',
    actionHistorySuccess: 'Action annulée ✓',
    actionHistoryFail: 'Impossible d’annuler cette action.',
    actionHistorySettings: 'Configuration modifiée',
    actionHistoryStats: 'Statistiques réinitialisées',
    actionHistoryRecipient: 'Destinataire retiré',
    actionHistoryIpNames: 'Surnoms client effacés',
    actionHistoryShare: 'Partage supprimé',
    actionHistoryLoadFail: 'Impossible de charger l’historique.',
    actionHistoryChanged: 'État modifié depuis',
    actionHistoryRestored: 'Déjà restaurée',
    actionHistoryPurged: 'Élément supprimé définitivement',
    actionHistoryLegacy: 'Ancienne entrée non sûre',
    actionHistoryForbidden: 'Lecture seule',
    actionHistoryGone: 'Partage introuvable',
    actionHistoryUnsupported: 'Annulation non prise en charge',
    actionHistoryRestoreConflict: 'Conflit avec un lien actif',
      actionHistoryTooLarge: 'Données d’annulation trop volumineuses'
  });
  Object.assign(STRINGS.en, {
    actionHistoryTitle: 'Action history',
    actionHistoryHint: 'Review recent administrative actions and undo the ones that are still reversible.',
    actionHistoryEmpty: 'No recent actions.',
    actionHistoryUndo: '↶ Undo',
    actionHistoryUndone: 'Undone',
    actionHistoryUnavailable: 'No longer undoable',
    actionHistoryConfirm: 'Undo “{label}”?',
    actionHistorySuccess: 'Action undone ✓',
    actionHistoryFail: 'Could not undo this action.',
    actionHistorySettings: 'Settings changed',
    actionHistoryStats: 'Stats reset',
    actionHistoryRecipient: 'Recipient removed',
    actionHistoryIpNames: 'Client nicknames cleared',
    actionHistoryShare: 'Share deleted',
    actionHistoryLoadFail: 'Could not load action history.',
    actionHistoryChanged: 'State changed since',
    actionHistoryRestored: 'Already restored',
    actionHistoryPurged: 'Item permanently deleted',
    actionHistoryLegacy: 'Legacy entry is unsafe',
    actionHistoryForbidden: 'Read-only',
    actionHistoryGone: 'Share no longer exists',
    actionHistoryUnsupported: 'Undo not supported',
    actionHistoryRestoreConflict: 'Conflicts with an active link',
      actionHistoryTooLarge: 'Undo data is too large'
  });
  Object.assign(STRINGS.es, {
    actionHistoryTitle: 'Historial de acciones',
    actionHistoryHint: 'Consulta las acciones administrativas recientes y deshaz las que aún sean reversibles.',
    actionHistoryEmpty: 'No hay acciones recientes.',
    actionHistoryUndo: '↶ Deshacer',
    actionHistoryUndone: 'Deshecha',
    actionHistoryUnavailable: 'Ya no se puede deshacer',
    actionHistoryConfirm: '¿Deshacer « {label} »?',
    actionHistorySuccess: 'Acción deshecha ✓',
    actionHistoryFail: 'No se pudo deshacer esta acción.',
    actionHistorySettings: 'Configuración modificada',
    actionHistoryStats: 'Estadísticas reiniciadas',
    actionHistoryRecipient: 'Destinatario eliminado',
    actionHistoryIpNames: 'Apodos de cliente borrados',
    actionHistoryShare: 'Compartición eliminada',
    actionHistoryLoadFail: 'No se pudo cargar el historial.',
    actionHistoryChanged: 'El estado cambió después',
    actionHistoryRestored: 'Ya restaurada',
    actionHistoryPurged: 'Elemento eliminado definitivamente',
    actionHistoryLegacy: 'Entrada antigua no segura',
    actionHistoryForbidden: 'Solo lectura',
    actionHistoryGone: 'La compartición ya no existe',
    actionHistoryUnsupported: 'Deshacer no compatible',
    actionHistoryRestoreConflict: 'Conflicto con un enlace activo',
      actionHistoryTooLarge: 'Los datos para deshacer son demasiado grandes'
  });

  // 1.60.0 — detailed statistics for PWA host shares.
  Object.assign(STRINGS.fr, {
    sharesStatsButton:'📊 Stats', shareStatsTitle:'Statistiques détaillées', shareStatsLoading:'Chargement des statistiques…', shareStatsUnavailable:'Statistiques indisponibles',
    shareStatsOverview:'Vue d’ensemble', shareStatsTransfers:'Transferts', shareStatsVolume:'Volume', shareStatsAverageSize:'Taille moyenne', shareStatsSuccess:'Taux de réussite', shareStatsCompleted:'Terminés', shareStatsInterrupted:'Interrompus', shareStatsSpeed:'Vitesse moyenne', shareStatsViews:'Vues', shareStatsVisitors:'Visiteurs', shareStatsStorage:'Stockage', shareStatsDownloads:'Téléchargements',
    shareStatsDetails:'Informations du partage', shareStatsStatus:'État', shareStatsType:'Type', shareStatsOwner:'Propriétaire', shareStatsCreated:'Créé', shareStatsExpiry:'Expiration', shareStatsItems:'Éléments', shareStatsLastActivity:'Dernière activité', shareStatsFirstActivity:'Première activité', shareStatsTags:'Tags', shareStatsPath:'Chemin', shareStatsUrl:'URL', shareStatsQuota:'Quotas', shareStatsFiles:'Fichiers', shareStatsLive:'Transferts en cours', shareStatsActivity14:'Activité — 14 derniers jours', shareStatsCountries:'Pays', shareStatsClients:'Clients', shareStatsRecent:'Transferts récents', shareStatsNoRecent:'Aucun transfert récent.', shareStatsUnknown:'Inconnu', shareStatsNever:'Jamais', shareStatsActive:'Actif', shareStatsInactive:'Inactif', shareStatsPaused:'En pause', shareStatsScheduled:'Planifié', shareStatsExpired:'Expiré', shareStatsRevoked:'Révoqué', shareStatsNoData:'Aucune donnée disponible.', shareStatsFile:'Fichier', shareStatsFolder:'Dossier', shareStatsCollab:'Collaboration', shareStatsWebStorage:'Stockage web'
  });
  Object.assign(STRINGS.en, {
    sharesStatsButton:'📊 Stats', shareStatsTitle:'Detailed statistics', shareStatsLoading:'Loading statistics…', shareStatsUnavailable:'Statistics unavailable',
    shareStatsOverview:'Overview', shareStatsTransfers:'Transfers', shareStatsVolume:'Volume', shareStatsAverageSize:'Average size', shareStatsSuccess:'Success rate', shareStatsCompleted:'Completed', shareStatsInterrupted:'Interrupted', shareStatsSpeed:'Average speed', shareStatsViews:'Views', shareStatsVisitors:'Visitors', shareStatsStorage:'Storage', shareStatsDownloads:'Downloads',
    shareStatsDetails:'Share information', shareStatsStatus:'Status', shareStatsType:'Type', shareStatsOwner:'Owner', shareStatsCreated:'Created', shareStatsExpiry:'Expiry', shareStatsItems:'Items', shareStatsLastActivity:'Last activity', shareStatsFirstActivity:'First activity', shareStatsTags:'Tags', shareStatsPath:'Path', shareStatsUrl:'URL', shareStatsQuota:'Quotas', shareStatsFiles:'Files', shareStatsLive:'Active transfers', shareStatsActivity14:'Activity — last 14 days', shareStatsCountries:'Countries', shareStatsClients:'Clients', shareStatsRecent:'Recent transfers', shareStatsNoRecent:'No recent transfers.', shareStatsUnknown:'Unknown', shareStatsNever:'Never', shareStatsActive:'Active', shareStatsInactive:'Inactive', shareStatsPaused:'Paused', shareStatsScheduled:'Scheduled', shareStatsExpired:'Expired', shareStatsRevoked:'Revoked', shareStatsNoData:'No data available.', shareStatsFile:'File', shareStatsFolder:'Folder', shareStatsCollab:'Collaboration', shareStatsWebStorage:'Web storage'
  });
  Object.assign(STRINGS.es, {
    sharesStatsButton:'📊 Stats', shareStatsTitle:'Estadísticas detalladas', shareStatsLoading:'Cargando estadísticas…', shareStatsUnavailable:'Estadísticas no disponibles',
    shareStatsOverview:'Resumen', shareStatsTransfers:'Transferencias', shareStatsVolume:'Volumen', shareStatsAverageSize:'Tamaño medio', shareStatsSuccess:'Tasa de éxito', shareStatsCompleted:'Completadas', shareStatsInterrupted:'Interrumpidas', shareStatsSpeed:'Velocidad media', shareStatsViews:'Vistas', shareStatsVisitors:'Visitantes', shareStatsStorage:'Almacenamiento', shareStatsDownloads:'Descargas',
    shareStatsDetails:'Información del recurso', shareStatsStatus:'Estado', shareStatsType:'Tipo', shareStatsOwner:'Propietario', shareStatsCreated:'Creado', shareStatsExpiry:'Caducidad', shareStatsItems:'Elementos', shareStatsLastActivity:'Última actividad', shareStatsFirstActivity:'Primera actividad', shareStatsTags:'Etiquetas', shareStatsPath:'Ruta', shareStatsUrl:'URL', shareStatsQuota:'Cuotas', shareStatsFiles:'Archivos', shareStatsLive:'Transferencias activas', shareStatsActivity14:'Actividad — últimos 14 días', shareStatsCountries:'Países', shareStatsClients:'Clientes', shareStatsRecent:'Transferencias recientes', shareStatsNoRecent:'No hay transferencias recientes.', shareStatsUnknown:'Desconocido', shareStatsNever:'Nunca', shareStatsActive:'Activo', shareStatsInactive:'Inactivo', shareStatsPaused:'En pausa', shareStatsScheduled:'Programado', shareStatsExpired:'Caducado', shareStatsRevoked:'Revocado', shareStatsNoData:'No hay datos disponibles.', shareStatsFile:'Archivo', shareStatsFolder:'Carpeta', shareStatsCollab:'Colaboración', shareStatsWebStorage:'Almacenamiento web'
  });


  // 1.62.0 — selectable/comparative host-share statistics.
  Object.assign(STRINGS.fr, {
    shareStatsPeriod:'Période', shareStats24h:'24 heures', shareStats7d:'7 jours', shareStats14d:'14 jours', shareStats30d:'30 jours', shareStatsAll:'Durée complète', shareStatsActivity:'Activité', shareStatsComparison:'Comparaison avec la période précédente', shareStatsFailures:'Causes des interruptions', shareStatsResumed:'Repris', shareStatsResumedFrom:'Repris depuis', shareStatsBandwidth:'Bande passante estimée', shareStatsViewShare:'Part des vues', shareStatsImageCopies:'Copies de l’image', shareStatsDimensions:'Dimensions', shareStatsChangeTransfers:'Transferts', shareStatsChangeVolume:'Volume', shareStatsChangeSuccess:'Réussite', shareStatsChangeSpeed:'Vitesse'
  });
  Object.assign(STRINGS.en, {
    shareStatsPeriod:'Period', shareStats24h:'24 hours', shareStats7d:'7 days', shareStats14d:'14 days', shareStats30d:'30 days', shareStatsAll:'Lifetime', shareStatsActivity:'Activity', shareStatsComparison:'Compared with previous period', shareStatsFailures:'Interruption reasons', shareStatsResumed:'Resumed', shareStatsResumedFrom:'Resumed from', shareStatsBandwidth:'Estimated bandwidth', shareStatsViewShare:'View share', shareStatsImageCopies:'Image copies', shareStatsDimensions:'Dimensions', shareStatsChangeTransfers:'Transfers', shareStatsChangeVolume:'Volume', shareStatsChangeSuccess:'Success', shareStatsChangeSpeed:'Speed'
  });
  Object.assign(STRINGS.es, {
    shareStatsPeriod:'Período', shareStats24h:'24 horas', shareStats7d:'7 días', shareStats14d:'14 días', shareStats30d:'30 días', shareStatsAll:'Duración completa', shareStatsActivity:'Actividad', shareStatsComparison:'Comparación con el período anterior', shareStatsFailures:'Causas de interrupción', shareStatsResumed:'Reanudados', shareStatsResumedFrom:'Reanudado desde', shareStatsBandwidth:'Ancho de banda estimado', shareStatsViewShare:'Proporción de vistas', shareStatsImageCopies:'Copias de la imagen', shareStatsDimensions:'Dimensiones', shareStatsChangeTransfers:'Transferencias', shareStatsChangeVolume:'Volumen', shareStatsChangeSuccess:'Éxito', shareStatsChangeSpeed:'Velocidad'
  });

  Object.assign(STRINGS.fr, {
  bgSyncTitle:'Synchronisation en arrière-plan', bgSyncRefresh:'Actualiser le diagnostic', bgSyncRun:'Relancer maintenant', bgSyncSupported:'Prise en charge', bgSyncPermission:'Autorisation périodique', bgSyncRegistered:'Enregistrée', bgSyncPending:'Transferts en attente', bgSyncLast:'Dernière exécution', bgSyncFailure:'Dernier échec', bgSyncNever:'jamais',
  installDiagTitle:'État de l’application', installDiagRefresh:'Vérifier', installDiagInstalled:'Installée sur cet appareil', installDiagDetected:'Installation détectée sur cet appareil', installDiagBrowser:'Ouverte dans le navigateur — PWA non détectée', installDiagUnknown:'État d’installation indéterminé', installDiagSecure:'Contexte sécurisé', installDiagSw:'Service worker',
  longOpWorking:'Traitement…', longOpDlp:'Analyse DLP', longOpHash:'Calcul SHA-256', longOpPrepare:'Préparation du fichier', longOpOcr:'OCR local',
  passkeyDeviceRemove:'Révoquer cet appareil', passkeyDeviceRemoved:'Appareil révoqué de cette passkey', passkeyDeviceCurrent:'Cet appareil', passkeyDeviceUnavailable:'Appareil révoqué',
  serverActivityActor:'Utilisateur', serverActivityIp:'IP', serverActivityDevice:'Appareil/source', serverActivityResult:'Résultat', serverActivityPeriod:'Période', serverActivityDirection:'Sens', serverActivityCorrelate:'Regrouper par partage', serverActivity24h:'24 h', serverActivity7d:'7 jours', serverActivity30d:'30 jours',
  sharesTrashImpact:'Impact : {count} élément(s) · {bytes}', sharesTrashDependencies:'Dépendances : {value}', sharesTrashNoDependencies:'aucune', sharesTrashSmartRestore:'Emplacement original absent. Utiliser « {path} » ?', sharesTrashChooseRestore:'Autre chemin hôte à restaurer :'
});
Object.assign(STRINGS.en, {
  bgSyncTitle:'Background synchronization', bgSyncRefresh:'Refresh diagnostic', bgSyncRun:'Retry now', bgSyncSupported:'Supported', bgSyncPermission:'Periodic permission', bgSyncRegistered:'Registered', bgSyncPending:'Pending transfers', bgSyncLast:'Last run', bgSyncFailure:'Last failure', bgSyncNever:'never',
  installDiagTitle:'Application status', installDiagRefresh:'Check', installDiagInstalled:'Installed on this device', installDiagDetected:'Installation detected on this device', installDiagBrowser:'Opened in browser — PWA not detected', installDiagUnknown:'Installation status unknown', installDiagSecure:'Secure context', installDiagSw:'Service worker',
  longOpWorking:'Working…', longOpDlp:'DLP scan', longOpHash:'SHA-256 calculation', longOpPrepare:'Preparing file', longOpOcr:'Local OCR',
  passkeyDeviceRemove:'Revoke this device', passkeyDeviceRemoved:'Device revoked from this passkey', passkeyDeviceCurrent:'This device', passkeyDeviceUnavailable:'Revoked device',
  serverActivityActor:'User', serverActivityIp:'IP', serverActivityDevice:'Device/source', serverActivityResult:'Result', serverActivityPeriod:'Period', serverActivityDirection:'Direction', serverActivityCorrelate:'Group by share', serverActivity24h:'24 h', serverActivity7d:'7 days', serverActivity30d:'30 days',
  sharesTrashImpact:'Impact: {count} item(s) · {bytes}', sharesTrashDependencies:'Dependencies: {value}', sharesTrashNoDependencies:'none', sharesTrashSmartRestore:'Original location is missing. Use “{path}”?', sharesTrashChooseRestore:'Other host path to restore:'
});
Object.assign(STRINGS.es, {
  bgSyncTitle:'Sincronización en segundo plano', bgSyncRefresh:'Actualizar diagnóstico', bgSyncRun:'Reintentar ahora', bgSyncSupported:'Compatible', bgSyncPermission:'Permiso periódico', bgSyncRegistered:'Registrada', bgSyncPending:'Transferencias pendientes', bgSyncLast:'Última ejecución', bgSyncFailure:'Último fallo', bgSyncNever:'nunca',
  installDiagTitle:'Estado de la aplicación', installDiagRefresh:'Comprobar', installDiagInstalled:'Instalada en este dispositivo', installDiagDetected:'Instalación detectada en este dispositivo', installDiagBrowser:'Abierta en el navegador — PWA no detectada', installDiagUnknown:'Estado de instalación indeterminado', installDiagSecure:'Contexto seguro', installDiagSw:'Service worker',
  longOpWorking:'Procesando…', longOpDlp:'Análisis DLP', longOpHash:'Cálculo SHA-256', longOpPrepare:'Preparación del archivo', longOpOcr:'OCR local',
  passkeyDeviceRemove:'Revocar este dispositivo', passkeyDeviceRemoved:'Dispositivo revocado de esta passkey', passkeyDeviceCurrent:'Este dispositivo', passkeyDeviceUnavailable:'Dispositivo revocado',
  serverActivityActor:'Usuario', serverActivityIp:'IP', serverActivityDevice:'Dispositivo/origen', serverActivityResult:'Resultado', serverActivityPeriod:'Período', serverActivityDirection:'Dirección', serverActivityCorrelate:'Agrupar por recurso', serverActivity24h:'24 h', serverActivity7d:'7 días', serverActivity30d:'30 días',
  sharesTrashImpact:'Impacto: {count} elemento(s) · {bytes}', sharesTrashDependencies:'Dependencias: {value}', sharesTrashNoDependencies:'ninguna', sharesTrashSmartRestore:'Falta la ubicación original. ¿Usar «{path}»?', sharesTrashChooseRestore:'Otra ruta del host:'
});
// 1.64.2 — audited live server transfers inside the PWA Activity section.
Object.assign(STRINGS.fr, {
  liveTransfersTitle:'Transferts en cours', liveTransfersHint:'Suivi en direct des transferts actifs sur le serveur.', liveTransfersLoading:'Chargement des transferts en cours…', liveTransfersEmpty:'Aucun transfert en cours.', liveTransfersLoadFail:'Impossible de charger les transferts en cours.', liveTransfersUpdated:'Mis à jour à {time}', liveTransfersStalled:'Inactif', liveTransfersResumed:'Repris', liveTransfersStopping:'Arrêt…', liveTransfersOffline:'Flux en direct indisponible', liveTransfersStale:'Dernières données connues', liveTransfersRemaining:'restant', liveTransfersStop:'Arrêter le transfert', liveTransfersStopConfirm:'Arrêter ce transfert en cours ?', liveTransfersStopOk:'Transfert arrêté', liveTransfersStopFail:'Impossible d’arrêter le transfert'
});
Object.assign(STRINGS.en, {
  liveTransfersTitle:'Transfers in progress', liveTransfersHint:'Live view of active transfers on the server.', liveTransfersLoading:'Loading active transfers…', liveTransfersEmpty:'No transfer in progress.', liveTransfersLoadFail:'Could not load active transfers.', liveTransfersUpdated:'Updated at {time}', liveTransfersStalled:'Stalled', liveTransfersResumed:'Resumed', liveTransfersStopping:'Stopping…', liveTransfersOffline:'Live feed unavailable', liveTransfersStale:'Last known data', liveTransfersRemaining:'remaining', liveTransfersStop:'Stop transfer', liveTransfersStopConfirm:'Stop this transfer in progress?', liveTransfersStopOk:'Transfer stopped', liveTransfersStopFail:'Could not stop the transfer'
});
Object.assign(STRINGS.es, {
  liveTransfersTitle:'Transferencias en curso', liveTransfersHint:'Seguimiento en directo de las transferencias activas del servidor.', liveTransfersLoading:'Cargando transferencias activas…', liveTransfersEmpty:'No hay transferencias en curso.', liveTransfersLoadFail:'No se pudieron cargar las transferencias activas.', liveTransfersUpdated:'Actualizado a las {time}', liveTransfersStalled:'Inactiva', liveTransfersResumed:'Reanudada', liveTransfersStopping:'Deteniendo…', liveTransfersOffline:'Flujo en directo no disponible', liveTransfersStale:'Últimos datos conocidos', liveTransfersRemaining:'restante', liveTransfersStop:'Detener transferencia', liveTransfersStopConfirm:'¿Detener esta transferencia en curso?', liveTransfersStopOk:'Transferencia detenida', liveTransfersStopFail:'No se pudo detener la transferencia'
});

Object.assign(STRINGS.fr, { imgVersionHistory:'Historique des modifications', imgCompareBeforeAfter:'Comparer avant/après', imgRestoreOriginal:'Revenir à l’original', imgCurrentVersion:'Version actuelle', imgVersionOperations:'Opérations', imgClose:'Fermer', imgRestoreConfirm:'Restaurer cette version ?', imgOriginal:'Originale' });
  Object.assign(STRINGS.en, { imgVersionHistory:'Edit history', imgCompareBeforeAfter:'Compare before/after', imgRestoreOriginal:'Revert to original', imgCurrentVersion:'Current version', imgVersionOperations:'Operations', imgClose:'Close', imgRestoreConfirm:'Restore this version?', imgOriginal:'Original' });
  Object.assign(STRINGS.es, { imgVersionHistory:'Historial de modificaciones', imgCompareBeforeAfter:'Comparar antes/después', imgRestoreOriginal:'Volver al original', imgCurrentVersion:'Versión actual', imgVersionOperations:'Operaciones', imgClose:'Cerrar', imgRestoreConfirm:'¿Restaurar esta versión?', imgOriginal:'Original' });

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
    if (manifest) manifest.href = (lang === 'fr' ? '/direct-xfer-pwa.webmanifest' : '/direct-xfer-pwa-' + lang + '.webmanifest') + '?v=397';
    $('lang-select').value = lang;
    $('dest-save-btn').textContent = editingToken ? t('updateDestination') : t('saveDestination');
    renderDests(); renderQueue(); renderHistory(); renderDeviceStatus();
    if (typeof renderPwaServerActivity === 'function') renderPwaServerActivity();
    if (typeof renderPwaLiveTransfers === 'function') renderPwaLiveTransfers();
    if (notificationPrefsLoaded) renderPwaNotificationPrefs();
    if (typeof updateSessionStats === 'function') updateSessionStats();
    if (typeof updateSendBtn === 'function') updateSendBtn();
    if (typeof activatePwaPanel === 'function') activatePwaPanel(activePwaPanel, { keepScroll: true, instant: true });
    if (typeof updatePwaNotificationsSoundBtn === 'function') updatePwaNotificationsSoundBtn();
    if (typeof sendLangToSw === 'function') sendLangToSw(); // keep the SW's resume prompt localized
  }

  var activePwaPanel = 'send';
  var systemHealthAccessEnabled = false;
  var systemHealthAccessResolved = false;
  var pendingSystemHealthPanel = false;
  var systemHealthAccessRequestSeq = 0;
  var systemHealthAccessRetryTimer = 0;
  var systemHealthAccessPollTimer = 0;
  var serverActivityEvents = [];
  var serverActivityRetained = 0;
  var serverActivityLoading = false;
  var pwaLiveTransfers = [];
  var pwaLiveTransfersLoading = false;
  var pwaLiveTransfersGeneratedAt = 0;
  var pwaLiveTransfersError = false;
  var pwaLiveTransfersRequestSeq = 0;
  var pwaLiveTransfersRequestController = null;
  var pwaLiveTransferSamples = Object.create(null);
  var PWA_PANEL_KEYS = {
    send: { label: 'navSend', hint: 'navSendHint' },
    images: { label: 'navImages', hint: 'navImagesHint' },
    shares: { label: 'navShares', hint: 'navSharesHint' },
    activity: { label: 'navActivity', hint: 'navActivityHint' },
    'system-health': { label: 'navSystemHealth', hint: 'navSystemHealthHint' },
    settings: { label: 'navSettings', hint: 'navSettingsHint' }
  };

  function updatePwaNavBadges() {
    var sendCount = items ? items.filter(function (item) { return item && item.status !== 'done'; }).length : 0;
    var imageCount = document.querySelectorAll('#imglink-list .imglink-row').length;
    [
      ['nav-send-badge', sendCount],
      ['nav-images-badge', imageCount],
      ['nav-shares-badge', activeShareCount]
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
    var previousPanel = activePwaPanel;
    if (!PWA_PANEL_KEYS[panel]) panel = 'send';
    if (panel === 'system-health' && !systemHealthAccessEnabled) {
      pendingSystemHealthPanel = !systemHealthAccessResolved;
      panel = 'settings';
    } else if (options.userInitiated && panel !== 'system-health') {
      pendingSystemHealthPanel = false;
    }
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
    if (panel === 'activity') { loadPwaServerActivity(false).catch(function () {}); loadPwaLiveTransfers(false).catch(function () {}); startPwaActivityRefresh(); } else stopPwaActivityRefresh();
    if (panel === 'system-health') {
      var healthCard = $('dx-admin-advanced-card');
      if (healthCard) healthCard.open = true;
      if (window.DirectXferServerHealth && typeof window.DirectXferServerHealth.start === 'function') window.DirectXferServerHealth.start();
    } else if (previousPanel === 'system-health' && window.DirectXferServerHealth && typeof window.DirectXferServerHealth.stop === 'function') {
      window.DirectXferServerHealth.stop();
    }
    if (panel === 'settings' && $('settings-card')) { $('settings-card').open = true; if (!notificationPrefsLoaded) loadPwaNotificationPrefs(); else renderPwaNotificationPrefs(); if(!notificationRulesLoaded)loadPwaNotificationRules(); else renderPwaNotificationRules(); }
    if (panel === 'images') {
      refreshImageStats(false).catch(function () {});
      refreshAlbums().catch(function () {});
    }
    if (panel === 'shares') { onSharesPanelShown(); startSharesPresence(); }
    else stopSharesPresence();
    if (!options.keepScroll) {
      var scroller = document.querySelector('.wrap');
      if (scroller) scroller.scrollTo({ top: 0, behavior: options.instant ? 'auto' : 'smooth' });
    }
    updatePwaNavBadges();
  }

  function syncSystemHealthNavAccess(enabled) {
    enabled = !!enabled;
    systemHealthAccessResolved = true;
    systemHealthAccessEnabled = enabled;
    var nav = $('pwa-bottom-nav');
    var button = document.querySelector('[data-pwa-nav="system-health"]');
    if (nav) nav.classList.toggle('has-system-health', enabled);
    if (button) {
      button.classList.toggle('hidden', !enabled);
      if (enabled) button.removeAttribute('aria-hidden');
      else button.setAttribute('aria-hidden', 'true');
    }
    if (!enabled) {
      pendingSystemHealthPanel = false;
      if (activePwaPanel === 'system-health') activatePwaPanel('settings', { instant: true });
      if (button && document.activeElement === button) {
        var settingsButton = document.querySelector('[data-pwa-nav="settings"]');
        if (settingsButton) settingsButton.focus();
      }
      return;
    }
    if (pendingSystemHealthPanel) {
      pendingSystemHealthPanel = false;
      activatePwaPanel('system-health', { instant: true });
    }
  }

  function scheduleSystemHealthAccessRetry(delay) {
    clearTimeout(systemHealthAccessRetryTimer);
    systemHealthAccessRetryTimer = setTimeout(function () { refreshSystemHealthNavAccess(true).catch(function () {}); }, Math.max(500, Number(delay) || 2000));
  }

  async function refreshSystemHealthNavAccess(force) {
    var seq = ++systemHealthAccessRequestSeq;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : 0;
    try {
      var response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined });
      if (timeout) clearTimeout(timeout);
      if (seq !== systemHealthAccessRequestSeq) return;
      if (response.status === 401 || response.status === 403) {
        syncSystemHealthNavAccess(false);
        return;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var session = await response.json().catch(function () { return {}; });
      if (seq !== systemHealthAccessRequestSeq) return;
      var enabled = !!(session && session.authenticated && (session.role === 'owner' || session.role === 'admin'));
      syncSystemHealthNavAccess(enabled);
      clearTimeout(systemHealthAccessRetryTimer);
    } catch (_) {
      if (timeout) clearTimeout(timeout);
      if (seq !== systemHealthAccessRequestSeq) return;
      // A transient network/bootstrap failure must not revoke a previously confirmed
      // admin UI. On first resolution, retry quickly until the real session is known.
      if (!systemHealthAccessResolved || force) scheduleSystemHealthAccessRetry(systemHealthAccessResolved ? 5000 : 1500);
    }
  }

  function startSystemHealthAccessWatch() {
    clearInterval(systemHealthAccessPollTimer);
    refreshSystemHealthNavAccess(true).catch(function () {});
    systemHealthAccessPollTimer = setInterval(function () {
      if (!document.hidden) refreshSystemHealthNavAccess(false).catch(function () {});
    }, 30000);
  }

  function initPwaNavigation() {
    document.querySelectorAll('[data-pwa-nav]').forEach(function (button) {
      button.addEventListener('click', function () { activatePwaPanel(button.getAttribute('data-pwa-nav'), { userInitiated: true }); });
    });
    ['up-list', 'imglink-list', 'history-list', 'server-activity-list'].forEach(function (id) {
      var target = $(id);
      if (target && 'MutationObserver' in window) {
        new MutationObserver(updatePwaNavBadges).observe(target, { childList: true, subtree: true });
      }
    });
    document.addEventListener('dx-pwa-admin-access', function (event) {
      syncSystemHealthNavAccess(!!(event && event.detail && event.detail.enabled));
    });
    // The admin module is loaded asynchronously. If it resolved access just before this
    // listener was installed, recover the published state instead of waiting for a later poll.
    var announcedAdminAccess = document.body.getAttribute('data-pwa-admin-access');
    if (announcedAdminAccess === '1' || announcedAdminAccess === '0') {
      syncSystemHealthNavAccess(announcedAdminAccess === '1');
    }
    // Do not depend on the asynchronously loaded health module for navigation access.
    // Resolve the authenticated role directly and keep it fresh across PWA lifecycle events.
    startSystemHealthAccessWatch();
    window.addEventListener('pageshow', function () { refreshSystemHealthNavAccess(true).catch(function () {}); });
    window.addEventListener('online', function () { refreshSystemHealthNavAccess(true).catch(function () {}); });
    window.addEventListener('focus', function () { refreshSystemHealthNavAccess(false).catch(function () {}); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshSystemHealthNavAccess(true).catch(function () {}); });
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
  // Robust moving upload rate (bytes/s). Keep a time-bounded rolling window and
  // ignore zero-byte samples caused by pauses/back-off. Instantaneous outliers are
  // clamped around the recent median before a time-weighted average is calculated;
  // this makes ETA stable across chunk boundaries, Android scheduling jitter and
  // short proxy retries without making it sluggish after a real network change.
  function emaRate(state, bytes) {
    // Upload-rate timing must be monotonic: wall-clock/NTP changes must not freeze
    // ETA calculations or manufacture a giant rate sample.
    var now = (window.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
    bytes = Math.max(0, Number(bytes) || 0);
    if (!state.t) { state.t = now; state.b = bytes; state.samples = []; return Number(state.ema) || 0; }
    var dt = (now - state.t) / 1000, delta = bytes - (Number(state.b) || 0);
    if (dt < 0.30) return Number(state.ema) || 0;
    state.t = now; state.b = bytes;
    if (!(delta > 0) || !(dt > 0)) return Number(state.ema) || 0;
    var inst = delta / dt, samples = Array.isArray(state.samples) ? state.samples : (state.samples = []);
    var recentRates = samples.slice(-9).map(function (x) { return x.rate; }).filter(function (x) { return x > 0 && isFinite(x); }).sort(function (a,b) { return a-b; });
    if (recentRates.length >= 3) {
      var median = recentRates[Math.floor(recentRates.length / 2)];
      inst = Math.max(median * 0.25, Math.min(median * 4, inst));
    }
    samples.push({ at: now, rate: inst, dt: Math.min(3, dt) });
    var cutoff = now - 15000;
    while (samples.length > 28 || (samples[0] && samples[0].at < cutoff)) samples.shift();
    var weighted = 0, weight = 0;
    samples.forEach(function (x) { var w = Math.max(.15, Math.min(3, Number(x.dt) || .35)); weighted += x.rate * w; weight += w; });
    var rolling = weight > 0 ? weighted / weight : inst;
    state.ema = state.ema ? state.ema * 0.35 + rolling * 0.65 : rolling;
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
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
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
        document.body.appendChild(ta); ta.select(); var copied=document.execCommand('copy')===true; ta.remove(); if(copied)resolve();else reject(new Error('clipboard-denied'));
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
    timeoutMs = timeoutMs || OFFSET_TIMEOUT_MS;
    if (!window.AbortController) {
      var fallbackTimer = null;
      return Promise.race([
        fetch(url, options),
        new Promise(function (_, reject) { fallbackTimer = setTimeout(function () { reject(new Error('fetch-timeout')); }, timeoutMs); })
      ]).finally(function () { if (fallbackTimer) clearTimeout(fallbackTimer); });
    }
    var ctrl = new AbortController();
    var upstream = options.signal || null;
    var relayAbort = function () { try { ctrl.abort(); } catch (_) {} };
    if (upstream) {
      if (upstream.aborted) relayAbort();
      else try { upstream.addEventListener('abort', relayAbort, { once: true }); } catch (_) {}
    }
    var timer = setTimeout(relayAbort, timeoutMs);
    var requestOptions = Object.assign({}, options, { signal: ctrl.signal });
    return fetch(url, requestOptions).finally(function () {
      clearTimeout(timer);
      if (upstream) try { upstream.removeEventListener('abort', relayAbort); } catch (_) {}
    });
  }

  // Account notification center -----------------------------------------------
  var accountNotifications = [];
  var notificationPollTimer = null;
  var notificationRequestSeq = 0;
  var notificationRequestInFlight = false;
  var notificationRequestController = null;
  // Arrival detection + on-demand paging state.
  var notificationSeenIds = null; // null until first load so the backlog never toasts
  var notificationSoundOn = false;
  try { notificationSoundOn = localStorage.getItem('dx-notif-sound') === '1'; } catch (_) {}
  var NOTIFICATIONS_PAGE_SIZE = 20;
  var notificationsShown = NOTIFICATIONS_PAGE_SIZE;
  // Category opt-outs (Security/System health are always-on server-side).
  var NOTIFICATION_MUTABLE_CATEGORIES = ['images','shares','receptions','transfers','search','pwa','visitors','thresholds','traffic','network','restarts','updates'];
  var NOTIFICATION_REQUIRED_CATEGORIES = ['security','maintenance','system_health'];
  var NOTIFICATION_SETTINGS_CATEGORIES = ['shares','receptions','images','transfers','visitors','thresholds','traffic','search','pwa','network','restarts','updates','maintenance','security','system_health'];
  var notificationMutedCategories = [];
  var notificationPrefsLoaded = false;
  var notificationPrefsSaving = false;
  var notificationPrefsSaveQueued = false;
  function pwaNotificationVariant(v) {
    if (v === 'thumb') return 'Mini'; if (v === 'micro') return 'Micro';
    return lang === 'fr' ? 'Pleine' : lang === 'es' ? 'Completa' : 'Full';
  }
  // Relative timestamp; the absolute date is the row's hover tooltip.
  function pwaTimeAgo(ts) {
    var s = Math.floor((Date.now() - Number(ts || 0)) / 1000); if (s < 0) s = 0;
    var v;
    if (s < 60) v = s + ' s';
    else { var m = Math.floor(s / 60); if (m < 60) v = m + ' min'; else { var h = Math.floor(m / 60); if (h < 24) v = h + ' h'; else v = Math.floor(h / 24) + ' ' + (lang === 'fr' ? 'j' : 'd'); } }
    return t('notificationsTimeAgo', { v: v });
  }
  function pwaNotificationIcon(n) {
    if (n.severity === 'critical') return '🚨'; if (n.severity === 'warning') return '⚠️'; if (n.severity === 'success') return '✅';
    var icons={images:'👁️',shares:'🔗',receptions:'📥',transfers:'↕️',security:'🔐',search:'🔎',pwa:'📱',system_health:'🩺',maintenance:'🧹',network:'🌐',restarts:'🔄',updates:'⬆️',visitors:'👥',thresholds:'🎯',traffic:'📈',activity:'📊',system:'⚙️'};
    return icons[n.category] || '🔔';
  }
  function pwaNotificationTitle(n) {
    var name=n.name || (lang==='fr'?'Lien':lang==='es'?'Enlace':'Link'), count=Number(n.count)||0, threshold=Number(n.threshold)||Number(n.limit)||count;
    if(n.type==='security-anomaly')return lang==='en'?'Ransomware protection: '+name:lang==='es'?'Protección antiransomware: '+name:'Protection antirançongiciel : '+name;
    var maps={
      fr:{'image-first-view':'Première vue de « '+name+' »','share-first-download':'Premier téléchargement de « '+name+' »','inbox-first-deposit':'Premier dépôt sur « '+name+' »','transfer-complete':'Transfert terminé : '+name,'transfer-failed':'Transfert échoué : '+name,'link-expired':'Lien expiré : '+name,'link-expiring-soon':'Lien bientôt expiré : '+name,'download-limit-reached':'Limite de téléchargements atteinte : '+name,'reception-quota-reached':'Quota de réception atteint : '+name,'link-new-visitor':'Nouveau visiteur sur « '+name+' »','new-country':'Nouveau pays pour '+name,'view-threshold':threshold+' vues atteintes : '+name,'download-threshold':threshold+' téléchargements atteints : '+name,'unusual-activity':'Activité inhabituelle : '+name,'repeated-downloads':'Téléchargements répétés : '+name,'password-failures':'Échecs de mot de passe répétés : '+name,'link-auto-disabled':'Lien désactivé automatiquement : '+name,'dlp-detected':'DLP : contenu sensible détecté','dlp-blocked':'DLP : publication bloquée','ocr-failed':'Échec OCR'+(n.name?' : '+n.name:''),'index-failed':'Échec de l’indexation','pwa-device-paired':'Nouvel appareil PWA : '+(n.device||''),'pwa-device-revoked':'Appareil PWA révoqué : '+(n.device||''),'admin-login':'Connexion administrateur : '+(n.username||''),'admin-login-unusual':'Connexion administrateur inhabituelle : '+(n.username||''),'system-problem':'Problème système détecté','update-available':'Mise à jour disponible : '+(n.latest||''),'update-installed':'Mise à jour installée : '+(n.version||'')},
      en:{'image-first-view':'First view of “'+name+'”','share-first-download':'First download of “'+name+'”','inbox-first-deposit':'First deposit on “'+name+'”','transfer-complete':'Transfer completed: '+name,'transfer-failed':'Transfer failed: '+name,'link-expired':'Link expired: '+name,'link-expiring-soon':'Link expiring soon: '+name,'download-limit-reached':'Download limit reached: '+name,'reception-quota-reached':'Reception quota reached: '+name,'link-new-visitor':'New visitor on “'+name+'”','new-country':'New country for '+name,'view-threshold':threshold+' views reached: '+name,'download-threshold':threshold+' downloads reached: '+name,'unusual-activity':'Unusual activity: '+name,'repeated-downloads':'Repeated downloads: '+name,'password-failures':'Repeated password failures: '+name,'link-auto-disabled':'Link automatically disabled: '+name,'dlp-detected':'DLP: sensitive content detected','dlp-blocked':'DLP: publication blocked','ocr-failed':'OCR failed'+(n.name?' : '+n.name:''),'index-failed':'Indexing failed','pwa-device-paired':'New PWA device: '+(n.device||''),'pwa-device-revoked':'PWA device revoked: '+(n.device||''),'admin-login':'Administrator login: '+(n.username||''),'admin-login-unusual':'Unusual administrator login: '+(n.username||''),'system-problem':'System problem detected','update-available':'Update available: '+(n.latest||''),'update-installed':'Update installed: '+(n.version||'')},
      es:{'image-first-view':'Primera vista de «'+name+'»','share-first-download':'Primera descarga de «'+name+'»','inbox-first-deposit':'Primer depósito en «'+name+'»','transfer-complete':'Transferencia completada: '+name,'transfer-failed':'Transferencia fallida: '+name,'link-expired':'Enlace caducado: '+name,'link-expiring-soon':'Enlace próximo a caducar: '+name,'download-limit-reached':'Límite de descargas alcanzado: '+name,'reception-quota-reached':'Cuota de recepción alcanzada: '+name,'link-new-visitor':'Nuevo visitante en «'+name+'»','new-country':'Nuevo país para '+name,'view-threshold':threshold+' vistas alcanzadas: '+name,'download-threshold':threshold+' descargas alcanzadas: '+name,'unusual-activity':'Actividad inusual: '+name,'repeated-downloads':'Descargas repetidas: '+name,'password-failures':'Fallos de contraseña repetidos: '+name,'link-auto-disabled':'Enlace desactivado automáticamente: '+name,'dlp-detected':'DLP: contenido sensible detectado','dlp-blocked':'DLP: publicación bloqueada','ocr-failed':'Error OCR'+(n.name?' : '+n.name:''),'index-failed':'Error de indexación','pwa-device-paired':'Nuevo dispositivo PWA: '+(n.device||''),'pwa-device-revoked':'Dispositivo PWA revocado: '+(n.device||''),'admin-login':'Inicio de sesión administrador: '+(n.username||''),'admin-login-unusual':'Inicio de sesión administrador inusual: '+(n.username||''),'system-problem':'Problema del sistema detectado','update-available':'Actualización disponible: '+(n.latest||''),'update-installed':'Actualización instalada: '+(n.version||'')}
    };
    var extra={
      fr:{'received-file-ready':'Fichier reçu disponible : '+name,'download-abandoned':'Téléchargement abandonné : '+name,'upload-abandoned':'Upload abandonné : '+name,'resume-impossible':'Reprise impossible : '+name,'protected-link-first-access':'Premier accès au lien protégé : '+name,'password-recovered':'Mot de passe accepté après des échecs : '+name,'visitor-device-new':'Nouveau navigateur/appareil visiteur sur « '+name+' »','simultaneous-downloads':'Téléchargements simultanés inhabituels : '+name,'high-download-volume':'Volume téléchargé inhabituellement élevé : '+name,'link-viral':'Lien devenu viral : '+name,'link-unused':'Lien inutilisé depuis longtemps : '+name,'shared-file-replaced':'Fichier source remplacé : '+name,'image-full-replaced':'Image pleine remplacée : '+name,'image-variant-regenerated':pwaNotificationVariant(n.variant)+' régénérée : '+name,'retention-file-deleted':'Fichier supprimé par rétention : '+name,'cleanup-complete':'Nettoyage automatique terminé','service-unavailable':'Service indisponible : '+(n.source||''),'service-restored':'Service rétabli : '+(n.source||''),'config-save-failed':'Échec de sauvegarde de la configuration','server-restarted':'Direct-Xfer redémarré : v'+(n.version||''),'server-clean-shutdown':'Arrêt propre de Direct-Xfer','server-crash-recovered':'Reprise après arrêt non propre','public-ip-changed':'Adresse IP publique modifiée','push-subscription-expired':'Abonnement Push expiré','push-subscription-repaired':'Abonnement Push réparé automatiquement','push-permission-revoked':'Permission Notifications retirée','custom-alert-rule':t('notificationsRuleCustomTitle',{name:name})},
      en:{'received-file-ready':'Received file available: '+name,'download-abandoned':'Download abandoned: '+name,'upload-abandoned':'Upload abandoned: '+name,'resume-impossible':'Resume impossible: '+name,'protected-link-first-access':'First access to protected link: '+name,'password-recovered':'Password accepted after failures: '+name,'visitor-device-new':'New visitor browser/device on “'+name+'”','simultaneous-downloads':'Unusual simultaneous downloads: '+name,'high-download-volume':'Unusually high download volume: '+name,'link-viral':'Link is going viral: '+name,'link-unused':'Link unused for a long time: '+name,'shared-file-replaced':'Shared source file replaced: '+name,'image-full-replaced':'Full image replaced: '+name,'image-variant-regenerated':pwaNotificationVariant(n.variant)+' regenerated: '+name,'retention-file-deleted':'File deleted by retention: '+name,'cleanup-complete':'Automatic cleanup completed','service-unavailable':'Service unavailable: '+(n.source||''),'service-restored':'Service restored: '+(n.source||''),'config-save-failed':'Configuration save failed','server-restarted':'Direct-Xfer restarted: v'+(n.version||''),'server-clean-shutdown':'Direct-Xfer shut down cleanly','server-crash-recovered':'Recovered after unclean shutdown','public-ip-changed':'Public IP address changed','push-subscription-expired':'Push subscription expired','push-subscription-repaired':'Push subscription repaired automatically','push-permission-revoked':'Notification permission removed','custom-alert-rule':t('notificationsRuleCustomTitle',{name:name})},
      es:{'received-file-ready':'Archivo recibido disponible: '+name,'download-abandoned':'Descarga abandonada: '+name,'upload-abandoned':'Carga abandonada: '+name,'resume-impossible':'Reanudación imposible: '+name,'protected-link-first-access':'Primer acceso al enlace protegido: '+name,'password-recovered':'Contraseña aceptada tras fallos: '+name,'visitor-device-new':'Nuevo navegador/dispositivo visitante en «'+name+'»','simultaneous-downloads':'Descargas simultáneas inusuales: '+name,'high-download-volume':'Volumen de descarga inusualmente alto: '+name,'link-viral':'Enlace viral: '+name,'link-unused':'Enlace sin uso desde hace mucho: '+name,'shared-file-replaced':'Archivo fuente reemplazado: '+name,'image-full-replaced':'Imagen completa reemplazada: '+name,'image-variant-regenerated':pwaNotificationVariant(n.variant)+' regenerada: '+name,'retention-file-deleted':'Archivo eliminado por retención: '+name,'cleanup-complete':'Limpieza automática terminada','service-unavailable':'Servicio no disponible: '+(n.source||''),'service-restored':'Servicio restablecido: '+(n.source||''),'config-save-failed':'Error al guardar la configuración','server-restarted':'Direct-Xfer reiniciado: v'+(n.version||''),'server-clean-shutdown':'Direct-Xfer se apagó correctamente','server-crash-recovered':'Recuperado tras un cierre incorrecto','public-ip-changed':'La IP pública cambió','push-subscription-expired':'Suscripción Push caducada','push-subscription-repaired':'Suscripción Push reparada automáticamente','push-permission-revoked':'Permiso de notificaciones retirado','custom-alert-rule':t('notificationsRuleCustomTitle',{name:name})}
    };
    return ((extra[lang]||extra.fr)[n.type]) || ((maps[lang]||maps.fr)[n.type]) || n.detail || n.type || t('notificationsTitle');
  }
  function pwaNotificationMeta(n) {
    var parts=[];
    if(n.type==='image-first-view')parts.push(pwaNotificationVariant(n.variant));
    if(n.flag&&n.flag!=='🌐')parts.push(n.flag); if(n.ip)parts.push(n.ip); if(n.country)parts.push(n.country);
    var byteQuota=n.type==='reception-quota-reached'&&n.reason==='bytes';
    if(n.type==='custom-alert-rule'){
      var metricKey={views:'notificationsRuleMetricViews',downloads:'notificationsRuleMetricDownloads',bytes_served:'notificationsRuleMetricBytesServed',received_bytes:'notificationsRuleMetricReceivedBytes'}[n.reason];
      if(metricKey)parts.push(t(metricKey));
      if(n.reason==='bytes_served'||n.reason==='received_bytes')parts.push(fmtBytes(n.bytes||0)+' / '+fmtBytes(n.limit||0));
      else if(n.threshold)parts.push(String(Number(n.count)||0)+' / '+String(Number(n.threshold)||0));
      if(n.source)parts.push(n.source);
    }else if(byteQuota&&n.limit)parts.push(fmtBytes(n.bytes||n.count||0)+' / '+fmtBytes(n.limit));
    else { if(n.bytes)parts.push(fmtBytes(n.bytes)); if(n.count&&!['view-threshold','download-threshold'].includes(n.type))parts.push(String(n.count)); if(n.limit)parts.push((lang==='fr'?'limite ':lang==='es'?'límite ':'limit ')+n.limit); }
    if(n.expiresAt)parts.push(fmtDate(n.expiresAt));
    if(n.reason&&n.type!=='custom-alert-rule')parts.push(String(n.reason).replace(/-/g,' ')); if(n.sender)parts.push(n.sender); if(n.device&&pwaNotificationTitle(n).indexOf(String(n.device))===-1)parts.push(n.device);
    if(n.version&&n.latest)parts.push(n.version+' → '+n.latest); if(n.previous&&n.current)parts.push(n.previous+' → '+n.current); if(n.durationMs)parts.push(Math.round(n.durationMs/1000)+' s'); if(n.detail)parts.push(n.detail); if(n.at)parts.push(pwaTimeAgo(n.at));
    return parts.filter(Boolean).join(' · ');
  }
  function normalizePwaNotificationSearch(value){var text=String(value==null?'':value).toLocaleLowerCase();try{text=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'');}catch(_){}return text.trim();}
  function pwaNotificationCategorySearchLabel(category){var key=String(category||'system_health');var map={activity:'notificationsCategoryActivity',visitors:'notificationsCategoryVisitors',thresholds:'notificationsCategoryThresholds',traffic:'notificationsCategoryTraffic',images:'notificationsCategoryImages',pwa:'notificationsCategoryPwa',receptions:'notificationsCategoryReceptions',search:'notificationsCategorySearch',security:'notificationsCategorySecurity',shares:'notificationsCategoryShares',system_health:'notificationsCategorySystemHealth',maintenance:'notificationsCategoryMaintenance',network:'notificationsCategoryNetwork',restarts:'notificationsCategoryRestarts',updates:'notificationsCategoryUpdates',system:'notificationsCategorySystemHealth',transfers:'notificationsCategoryTransfers'};return map[key]?t(map[key]):key;}
  function pwaNotificationSeveritySearchLabel(severity){var key=String(severity||'info');var map={info:'notificationsSeverityInfo',success:'notificationsSeveritySuccess',warning:'notificationsSeverityWarning',critical:'notificationsSeverityCritical'};return map[key]?t(map[key]):key;}
  function pwaNotificationMatchesFilters(n){
    var category=$('pwa-notifications-category-filter')?$('pwa-notifications-category-filter').value:'';
    var severity=$('pwa-notifications-severity-filter')?$('pwa-notifications-severity-filter').value:'';
    var query=normalizePwaNotificationSearch($('pwa-notifications-search')?$('pwa-notifications-search').value:'');
    if(category&&String(n&&n.category||'system_health')!==category)return false;
    if(severity&&String(n&&n.severity||'info')!==severity)return false;
    if(!query)return true;
    var haystack=normalizePwaNotificationSearch([n&&n.type,n&&n.category,n&&n.severity,pwaNotificationCategorySearchLabel(n&&n.category),pwaNotificationSeveritySearchLabel(n&&n.severity),pwaNotificationTitle(n||{}),pwaNotificationMeta(n||{}),n&&n.name,n&&n.detail,n&&n.reason,n&&n.sender,n&&n.device,n&&n.username,n&&n.source].filter(Boolean).join(' '));
    return haystack.indexOf(query)!==-1;
  }
  // Deep-link a notification to its bottom-nav panel.
  function pwaNotificationPanel(n){
    var cat=String(n&&n.category||''), type=String(n&&n.type||'');
    if(cat==='images'||type.indexOf('image')===0||type==='ocr-failed') return 'images';
    if(cat==='shares'||cat==='receptions') return 'shares';
    if(['system','system_health','maintenance','network','restarts','updates','pwa'].indexOf(cat)!==-1) return 'settings';
    return 'activity';
  }
  function openPwaNotificationTarget(n){ closePwaNotifications(); if(n&&n.manageUrl){try{location.assign(String(n.manageUrl));return;}catch(_){}} activatePwaPanel(pwaNotificationPanel(n)); }
  // Public link for a notification's share, by category (download /s/,
  // reception /u/, image /i/). Only shown when a token is present.
  function pwaNotificationLink(n){
    // The server resolves this against the CURRENT managed share and configured
    // public/image base. No linkUrl means the share is gone/expired or not owned,
    // so do not offer a stale local-origin URL.
    return n&&n.linkUrl?String(n.linkUrl):null;
  }
  function pwaNotificationActions(n){
    var out=[]; if(!n) return out;
    var link=pwaNotificationLink(n);
    if(link) out.push({label:t('copyLink'),run:function(){ copyText(link).then(function(){toast(t('notificationsLinkCopied'),'ok');},function(){toast(t('copyFailed'),'err');}); }});
    return out;
  }
  function markOnePwaNotificationRead(n){
    if(!n||!(n.unread===true||!(Number(n.readAt)>0))) return;
    var at=Date.now();
    accountNotifications=accountNotifications.map(function(x){return x&&x.id===n.id?Object.assign({},x,{readAt:at,unread:false}):x;});
    renderPwaNotifications();
    appMutate('/app/notifications/read','application/json',JSON.stringify({ids:[String(n.id)]})).catch(function(){});
  }
  // Optional arrival sound + bell pulse.
  function playPwaNotificationSound(){
    try{
      var AC=window.AudioContext||window.webkitAudioContext; if(!AC) return;
      var ctx=playPwaNotificationSound._ctx||(playPwaNotificationSound._ctx=new AC());
      if(ctx.state==='suspended')ctx.resume().catch(function(){});
      var now=ctx.currentTime,o=ctx.createOscillator(),g=ctx.createGain();
      o.type='sine';o.frequency.setValueAtTime(880,now);o.frequency.setValueAtTime(1245,now+0.09);
      g.gain.setValueAtTime(0.0001,now);g.gain.exponentialRampToValueAtTime(0.14,now+0.02);g.gain.exponentialRampToValueAtTime(0.0001,now+0.3);
      o.connect(g).connect(ctx.destination);o.start(now);o.stop(now+0.32);
    }catch(_){}
  }
  function pulsePwaBell(){var b=$('pwa-notifications-btn');if(!b)return;b.classList.remove('notif-pulse');void b.offsetWidth;b.classList.add('notif-pulse');setTimeout(function(){b.classList.remove('notif-pulse');},2600);}
  function announcePwaNotifications(fresh){
    if(!fresh||!fresh.length)return;
    pulsePwaBell();
    var actionable=fresh.filter(function(n){return n&&n.priority!=='low';});
    if(!actionable.length)return;
    var newest=actionable.slice().sort(function(a,b){return Number(b.at||0)-Number(a.at||0);})[0];
    if(newest)toast('🔔 '+pwaNotificationTitle(newest),(newest.severity==='critical'||newest.severity==='warning')?'warn':'ok');
    if(notificationSoundOn)playPwaNotificationSound();
  }
  function renderPwaNotifications() {
    var list=$('pwa-notifications-list'), badge=$('pwa-notifications-badge'), count=$('pwa-notifications-count'), clear=$('pwa-notifications-clear');
    if (!list) return;
    var rows=Array.isArray(accountNotifications)?accountNotifications:[];
    var visibleRows=rows.filter(pwaNotificationMatchesFilters);
    var filtersActive=!!(($('pwa-notifications-category-filter')&&$('pwa-notifications-category-filter').value)||($('pwa-notifications-severity-filter')&&$('pwa-notifications-severity-filter').value)||normalizePwaNotificationSearch($('pwa-notifications-search')?$('pwa-notifications-search').value:''));
    var unreadCount=rows.reduce(function(total,n){return total+((n&&(n.unread===true||!(Number(n.readAt)>0)))?1:0);},0);
    if (badge) { badge.textContent=unreadCount>99?'99+':String(unreadCount); badge.classList.toggle('hidden',!unreadCount); }
    if (count) count.textContent=rows.length?(filtersActive?t('notificationsFilteredCount',{shown:visibleRows.length,total:rows.length}):t('notificationsCount',{n:rows.length})):'';
    if (clear) clear.classList.toggle('hidden',!rows.length);
    list.textContent='';
    if (!rows.length) { var empty=document.createElement('span'); empty.className='muted sm'; empty.textContent=t('notificationsEmpty'); list.appendChild(empty); return; }
    if (!visibleRows.length) { var none=document.createElement('span'); none.className='muted sm'; none.textContent=t('notificationsNoMatch'); list.appendChild(none); return; }
    var shown=Math.min(visibleRows.length, Math.max(NOTIFICATIONS_PAGE_SIZE, notificationsShown));
    visibleRows.slice(0,shown).forEach(function(n){
      var row=document.createElement('div'); var isUnread=n&&(n.unread===true||!(Number(n.readAt)>0)); row.className='pwa-notification-item notification-'+(n.severity||'info')+(isUnread?' notification-unread':'');
      var main=document.createElement('div'); main.className='pwa-notification-main notification-clickable'; main.setAttribute('role','button'); main.setAttribute('tabindex','0');
      var title=document.createElement('div'); title.className='pwa-notification-title'; title.textContent=pwaNotificationIcon(n)+' '+pwaNotificationTitle(n)+(Number(n.groupCount)>1?' ×'+Number(n.groupCount):'');
      if(n.priority==='urgent'||n.priority==='high'){var pr=document.createElement('span');pr.className='notification-priority '+n.priority;pr.textContent=n.priority==='urgent'?'⚠':'↑';title.appendChild(pr);}
      var meta=document.createElement('div'); meta.className='pwa-notification-meta'; meta.textContent=pwaNotificationMeta(n); if(n.at)meta.title=fmtDate(n.at);
      main.appendChild(title); main.appendChild(meta);
      var go=function(){markOnePwaNotificationRead(n);openPwaNotificationTarget(n);};
      main.addEventListener('click',go);
      main.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();go();}});
      var acts=pwaNotificationActions(n);
      if(acts.length){var wrap=document.createElement('div');wrap.className='pwa-notification-actions';acts.forEach(function(a){var b=document.createElement('button');b.type='button';b.className='btn ghost sm pwa-notification-action';b.textContent=a.label;b.addEventListener('click',function(ev){ev.stopPropagation();markOnePwaNotificationRead(n);a.run();});wrap.appendChild(b);});main.appendChild(wrap);}
      var del=document.createElement('button'); del.type='button'; del.className='btn ghost sm pwa-notification-delete'; del.title=t('notificationsDelete'); del.setAttribute('aria-label',t('notificationsDelete'));
      del.addEventListener('click',async function(e){e.stopPropagation();del.disabled=true;try{var r=await appMutate('/app/notifications/delete','application/json',JSON.stringify({id:n.id}));if(!r.ok)throw new Error('delete');notificationRequestSeq+=1;accountNotifications=accountNotifications.filter(function(x){return x&&x.id!==n.id;});renderPwaNotifications();if(!notificationRequestInFlight)await refreshPwaNotifications();}catch(_){del.disabled=false;}});
      row.appendChild(main); row.appendChild(del); list.appendChild(row);
    });
    if(visibleRows.length>shown){var more=document.createElement('button');more.type='button';more.className='btn ghost sm pwa-notification-loadmore';more.textContent=t('notificationsLoadMore',{n:visibleRows.length-shown});more.addEventListener('click',function(ev){ev.stopPropagation();notificationsShown=shown+NOTIFICATIONS_PAGE_SIZE;renderPwaNotifications();if(pwaNotificationsOpen())void markPwaNotificationsRead();});list.appendChild(more);}
  }
  var notificationReadInFlight=false;
  var notificationReadSeq=0;
  function pwaNotificationsOpen(){var d=$('pwa-notifications-dropdown');return !!(d&&!d.classList.contains('hidden'));}
  function visiblePwaNotificationReadIds(){
    var visible=accountNotifications.filter(pwaNotificationMatchesFilters);
    var shown=Math.min(visible.length,Math.max(NOTIFICATIONS_PAGE_SIZE,notificationsShown));
    return visible.slice(0,shown).filter(function(n){return n&&(n.unread===true||!(Number(n.readAt)>0));}).map(function(n){return String(n.id);});
  }
  async function markPwaNotificationsRead(){
    if(notificationReadInFlight||!pwaNotificationsOpen())return;
    var readIds=visiblePwaNotificationReadIds();
    if(!readIds.length)return;
    notificationReadInFlight=true;
    var readSeq=++notificationReadSeq;
    var succeeded=false;
    try{
      var r=await appMutate('/app/notifications/read','application/json',JSON.stringify({ids:readIds}));
      if(!r.ok)throw new Error('read');
      var data={};try{data=await r.json();}catch(_){}
      if(readSeq!==notificationReadSeq)return;
      invalidatePwaNotificationFetch();
      var at=Math.max(1,Number(data&&data.readAt)||Date.now());
      var markedIds=new Set(Array.isArray(data&&data.ids)?data.ids.map(String):[]);
      var existingIds=Array.isArray(data&&data.existingIds)?new Set(data.existingIds.map(String)):null;
      if(existingIds)accountNotifications=accountNotifications.filter(function(n){return n&&existingIds.has(String(n.id));});
      accountNotifications=accountNotifications.map(function(n){if(n&&markedIds.has(String(n.id))){n=Object.assign({},n,{readAt:at,unread:false});}return n;});
      renderPwaNotifications();
      succeeded=true;
    }catch(_){}finally{if(readSeq===notificationReadSeq){notificationReadInFlight=false;
      // Only re-run to catch a notification that arrived during a SUCCESSFUL read.
      // Re-scheduling on failure would busy-loop POSTs at request latency while the
      // panel stays open; the next 4 s poll (or a reopen) is the intended retry.
      if(succeeded&&pwaNotificationsOpen()&&accountNotifications.some(function(n){return n&&(n.unread===true||!(Number(n.readAt)>0));}))setTimeout(function(){void markPwaNotificationsRead();},0);}}
  }
  function invalidatePwaNotificationFetch(){notificationRequestSeq+=1;if(notificationRequestController){try{notificationRequestController.abort();}catch(_){}}}

  async function refreshPwaNotifications() {
    if(notificationRequestInFlight)return;
    notificationRequestInFlight=true;
    var seq=++notificationRequestSeq;
    var ctrl=window.AbortController?new AbortController():null;
    notificationRequestController=ctrl;
    var timer=ctrl?setTimeout(function(){ctrl.abort();},15000):null;
    try {
      var r=await fetch('/app/notifications',{credentials:'same-origin',cache:'no-store',signal:ctrl?ctrl.signal:undefined});
      if(seq!==notificationRequestSeq)return;
      if(r.status===401||r.status===403){accountNotifications=[];renderPwaNotifications();return;}
      if(!r.ok)throw new Error('notifications-'+r.status);
      var d=await r.json();
      if(seq!==notificationRequestSeq)return; // ignore an older poll that arrived late
      var incoming=(d&&d.notifications)||[];
      // Announce new, still-unread rows when the panel is closed.
      if(notificationSeenIds){var fresh=incoming.filter(function(n){return n&&!notificationSeenIds.has(String(n.id))&&(n.unread===true||!(Number(n.readAt)>0));});if(fresh.length&&!pwaNotificationsOpen())announcePwaNotifications(fresh);}
      notificationSeenIds=new Set(incoming.map(function(n){return String(n&&n.id);}));
      accountNotifications=incoming; renderPwaNotifications(); if(pwaNotificationsOpen())void markPwaNotificationsRead();
    }
    catch (_) { if(seq!==notificationRequestSeq)return; }
    finally { if(timer)clearTimeout(timer); if(notificationRequestController===ctrl)notificationRequestController=null; notificationRequestInFlight=false; }
  }
  function closePwaNotifications(){var d=$('pwa-notifications-dropdown'),b=$('pwa-notifications-btn'),prefs=$('pwa-notifications-prefs'),prefsBtn=$('pwa-notifications-prefs-btn');if(d)d.classList.add('hidden');if(b)b.setAttribute('aria-expanded','false');if(prefs)prefs.classList.add('hidden');if(prefsBtn)prefsBtn.setAttribute('aria-expanded','false');}
  // A push tap (or ?opencenter=1 cold start) lands on the right panel
  // and opens the notification center so the matching alert is right there.
  function openPwaNotificationCenter(panel){
    if(panel)activatePwaPanel(panel);
    var d=$('pwa-notifications-dropdown'); if(!d)return;
    d.classList.remove('hidden');
    var b=$('pwa-notifications-btn'); if(b)b.setAttribute('aria-expanded','true');
    notificationsShown=NOTIFICATIONS_PAGE_SIZE;
    renderPwaNotifications(); void markPwaNotificationsRead(); refreshPwaNotifications();
  }
  function startNotificationPolling(){ if(notificationPollTimer)return; refreshPwaNotifications(); notificationPollTimer=setInterval(function(){if(!document.hidden)refreshPwaNotifications();},4000); }
  // Optional arrival sound toggle, remembered locally (default off).
  function updatePwaNotificationsSoundBtn(){
    var b=$('pwa-notifications-sound'); if(!b) return;
    b.classList.toggle('notification-sound-on',notificationSoundOn);
    b.classList.toggle('notification-sound-off',!notificationSoundOn);
    b.setAttribute('aria-pressed',notificationSoundOn?'true':'false');
    var label=t('notificationsSound')+' — '+(notificationSoundOn?t('notificationsSoundOn'):t('notificationsSoundOff'));
    b.title=label; b.setAttribute('aria-label',label);
  }
  // Per-account category opt-outs. The dropdown and Settings panel
  // intentionally share one state/store so changing either surface immediately updates
  // the other. Security/System are always enabled by the server and shown read-only.
  function pwaNotificationCategoryLabel(cat){
    var labels={activity:'notificationsCategoryActivity',visitors:'notificationsCategoryVisitors',thresholds:'notificationsCategoryThresholds',traffic:'notificationsCategoryTraffic',images:'notificationsCategoryImages',pwa:'notificationsCategoryPwa',receptions:'notificationsCategoryReceptions',search:'notificationsCategorySearch',security:'notificationsCategorySecurity',shares:'notificationsCategoryShares',system_health:'notificationsCategorySystemHealth',maintenance:'notificationsCategoryMaintenance',network:'notificationsCategoryNetwork',restarts:'notificationsCategoryRestarts',updates:'notificationsCategoryUpdates',system:'notificationsCategorySystemHealth',transfers:'notificationsCategoryTransfers'};
    return labels[cat]?t(labels[cat]):cat;
  }
  function pwaNotificationCategoryDescription(cat){
    var descriptions={shares:'notificationsCategoryDescShares',receptions:'notificationsCategoryDescReceptions',images:'notificationsCategoryDescImages',transfers:'notificationsCategoryDescTransfers',visitors:'notificationsCategoryDescVisitors',thresholds:'notificationsCategoryDescThresholds',traffic:'notificationsCategoryDescTraffic',search:'notificationsCategoryDescSearch',pwa:'notificationsCategoryDescPwa',security:'notificationsCategoryDescSecurity',system_health:'notificationsCategoryDescSystemHealth',maintenance:'notificationsCategoryDescMaintenance',network:'notificationsCategoryDescNetwork',restarts:'notificationsCategoryDescRestarts',updates:'notificationsCategoryDescUpdates',system:'notificationsCategoryDescSystemHealth'};
    return descriptions[cat]?t(descriptions[cat]):'';
  }
  function setPwaNotificationPrefsStatus(key,kind){
    var node=$('settings-notification-status'); if(!node)return;
    node.textContent=key?t(key):'';
    node.className='muted sm notification-settings-status'+(kind?' '+kind:'');
  }
  function setPwaNotificationCategoryPreference(cat,enabled){
    cat=String(cat||''); if(NOTIFICATION_MUTABLE_CATEGORIES.indexOf(cat)===-1)return;
    var next=new Set(notificationMutedCategories);
    if(enabled)next.delete(cat);else next.add(cat);
    notificationMutedCategories=NOTIFICATION_MUTABLE_CATEGORIES.filter(function(value){return next.has(value);});
    renderPwaNotificationPrefs();
    setPwaNotificationPrefsStatus('notificationsSettingsSaving');
    savePwaNotificationPrefs();
  }
  function appendPwaNotificationPrefRow(box,cat,required,showDescription){
    var lab=document.createElement('label'); lab.className='notification-pref-row'+(required?' notification-pref-required':'');
    var cb=document.createElement('input'); cb.type='checkbox'; cb.checked=required||notificationMutedCategories.indexOf(cat)===-1; cb.setAttribute('data-cat',cat);
    if(required){cb.disabled=true;cb.setAttribute('aria-label',pwaNotificationCategoryLabel(cat)+' — '+t('notificationsSettingsRequired'));}
    else cb.addEventListener('change',function(){setPwaNotificationCategoryPreference(cat,cb.checked);});
    lab.appendChild(cb);
    if(showDescription){
      var copy=document.createElement('span');copy.className='notification-pref-copy';
      var title=document.createElement('span');title.className='notification-pref-title';title.textContent=pwaNotificationCategoryLabel(cat);copy.appendChild(title);
      var desc=document.createElement('small');desc.className='muted notification-pref-description';desc.textContent=pwaNotificationCategoryDescription(cat);copy.appendChild(desc);
      lab.appendChild(copy);
    }else{
      var span=document.createElement('span'); span.textContent=pwaNotificationCategoryLabel(cat);lab.appendChild(span);
    }
    if(required){var badge=document.createElement('small');badge.className='muted notification-pref-required-label';badge.textContent=t('notificationsSettingsRequired');lab.appendChild(badge);}
    box.appendChild(lab);
  }
  function renderPwaNotificationPrefs(){
    var popup=$('pwa-notifications-prefs');
    if(popup){
      popup.textContent='';
      var hint=document.createElement('div'); hint.className='muted sm notification-prefs-hint'; hint.textContent=t('notificationsPrefsHint'); popup.appendChild(hint);
      NOTIFICATION_MUTABLE_CATEGORIES.forEach(function(cat){appendPwaNotificationPrefRow(popup,cat,false);});
    }
    var settings=$('settings-notification-prefs');
    if(settings){
      settings.textContent='';
      NOTIFICATION_SETTINGS_CATEGORIES.forEach(function(cat){appendPwaNotificationPrefRow(settings,cat,NOTIFICATION_REQUIRED_CATEGORIES.indexOf(cat)!==-1,true);});
      var requiredHint=document.createElement('div');requiredHint.className='muted sm notification-settings-required-hint';requiredHint.textContent=t('notificationsSettingsRequiredHint');settings.appendChild(requiredHint);
    }
    if(notificationRulesLoaded)renderPwaNotificationRules();
  }
  async function loadPwaNotificationPrefs(preserveStatus){
    var loaded=false;
    try{
      var r=await fetch('/app/notifications/prefs',{credentials:'same-origin',cache:'no-store'});
      if(r.ok){var d=await r.json();notificationMutedCategories=Array.isArray(d&&d.mutedCategories)?d.mutedCategories.map(String).filter(function(cat){return NOTIFICATION_MUTABLE_CATEGORIES.indexOf(cat)!==-1;}):[];loaded=true;if(!preserveStatus)setPwaNotificationPrefsStatus('');}
      else throw new Error('prefs-'+r.status);
    }catch(_){setPwaNotificationPrefsStatus('notificationsSettingsError','setting-error');}
    // A failed GET must stay retryable the next time Preferences/Settings is opened.
    notificationPrefsLoaded=loaded; renderPwaNotificationPrefs();
  }
  async function savePwaNotificationPrefs(){
    if(notificationPrefsSaving){notificationPrefsSaveQueued=true;return;}
    notificationPrefsSaving=true;
    try{
      do{
        notificationPrefsSaveQueued=false;
        var desired=notificationMutedCategories.slice();
        var r=await appMutate('/app/notifications/prefs','application/json',JSON.stringify({mutedCategories:desired}));
        if(!r.ok)throw new Error('prefs-'+r.status);
        var data={};try{data=await r.json();}catch(_){}
        if(!notificationPrefsSaveQueued){notificationMutedCategories=Array.isArray(data&&data.mutedCategories)?data.mutedCategories.map(String).filter(function(cat){return NOTIFICATION_MUTABLE_CATEGORIES.indexOf(cat)!==-1;}):desired;notificationPrefsLoaded=true;renderPwaNotificationPrefs();setPwaNotificationPrefsStatus('notificationsPrefsSaved','setting-ok');toast(t('notificationsPrefsSaved'),'ok');}
      }while(notificationPrefsSaveQueued);
    }catch(_){notificationPrefsLoaded=false;setPwaNotificationPrefsStatus('notificationsSettingsError','setting-error');await loadPwaNotificationPrefs(true);}
    finally{notificationPrefsSaving=false;if(notificationPrefsSaveQueued){notificationPrefsSaveQueued=false;savePwaNotificationPrefs();}}
  }

  // Custom notification threshold rules, shared with the standard UI.
  var notificationRules=[], notificationRuleTargets=[], notificationRulesLoaded=false, notificationRulesRequestSeq=0, notificationRuleMutationBusy=false;
  function pwaRuleMetricLabel(metric){var key={views:'notificationsRuleMetricViews',downloads:'notificationsRuleMetricDownloads',bytes_served:'notificationsRuleMetricBytesServed',received_bytes:'notificationsRuleMetricReceivedBytes'}[metric];return key?t(key):metric;}
  function pwaRuleIsBytes(metric){return metric==='bytes_served'||metric==='received_bytes';}
  function pwaRuleThresholdForInput(metric,value){return pwaRuleIsBytes(metric)?Math.round((Number(value)||0)/1073741824*100)/100:Math.max(0,Number(value)||0);}
  function pwaRuleThresholdFromInput(metric,value){var n=Math.max(0,Number(value)||0);return pwaRuleIsBytes(metric)?Math.round(n*1073741824):Math.floor(n);}
  function pwaRuleTargetName(id){var row=notificationRuleTargets.find(function(x){return String(x.id)===String(id);});return row?row.name:t('notificationsRuleTargetUnavailable');}
  function updatePwaRuleTargets(){var metric=$('settings-notification-rule-metric')?$('settings-notification-rule-metric').value:'views';var target=$('settings-notification-rule-target');if(!target)return;var prev=target.value;target.textContent='';var all=document.createElement('option');all.value='';all.textContent=t('notificationsRuleAllTargets');target.appendChild(all);notificationRuleTargets.filter(function(x){return Array.isArray(x.metrics)&&x.metrics.indexOf(metric)!==-1;}).forEach(function(x){var o=document.createElement('option');o.value=x.id;o.textContent=x.name;target.appendChild(o);});for(var i=0;i<target.options.length;i++)if(target.options[i].value===prev){target.value=prev;break;}var input=$('settings-notification-rule-threshold');if(input){input.step=pwaRuleIsBytes(metric)?'0.1':'1';input.min=pwaRuleIsBytes(metric)?'0.01':'1';}}
  function renderPwaNotificationRules(){var metric=$('settings-notification-rule-metric');if(metric){var prev=metric.value;metric.textContent='';['views','downloads','bytes_served','received_bytes'].forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=pwaRuleMetricLabel(m);metric.appendChild(o);});if(prev)metric.value=prev;}updatePwaRuleTargets();var box=$('settings-notification-rule-list');if(!box)return;box.textContent='';if(!notificationRules.length){var empty=document.createElement('p');empty.className='muted sm';empty.textContent=t('notificationsRuleEmpty');box.appendChild(empty);return;}notificationRules.forEach(function(rule){var row=document.createElement('div');row.className='notification-rule-row';if(rule.enabled===false)row.classList.add('muted');var main=document.createElement('div');main.className='notification-rule-row-main';var title=document.createElement('strong');var threshold=pwaRuleThresholdForInput(rule.metric,rule.threshold);title.textContent=(rule.label?rule.label+' — ':'')+pwaRuleMetricLabel(rule.metric)+' ≥ '+threshold;var sub=document.createElement('small');sub.className='muted';sub.textContent=rule.shareId?pwaRuleTargetName(rule.shareId):t('notificationsRuleAllTargets');main.appendChild(title);main.appendChild(sub);row.appendChild(main);var actions=document.createElement('div');actions.className='notification-rule-row-actions';var toggle=document.createElement('button');toggle.type='button';toggle.className='btn ghost sm';toggle.textContent=rule.enabled!==false?t('notificationsRuleDisable'):t('notificationsRuleEnable');toggle.addEventListener('click',function(){savePwaNotificationRule({id:rule.id,metric:rule.metric,threshold:rule.threshold,shareId:rule.shareId||null,label:rule.label||'',enabled:rule.enabled===false});});var del=document.createElement('button');del.type='button';del.className='btn danger sm';del.textContent=t('notificationsRuleDelete');del.addEventListener('click',function(){deletePwaNotificationRule(rule.id);});actions.appendChild(toggle);actions.appendChild(del);row.appendChild(actions);box.appendChild(row);});}
  async function loadPwaNotificationRules(){var seq=++notificationRulesRequestSeq;try{var r=await fetch('/app/notification-rules',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('rules-'+r.status);var data=await r.json();if(seq!==notificationRulesRequestSeq)return false;notificationRules=Array.isArray(data.rules)?data.rules:[];notificationRuleTargets=Array.isArray(data.targets)?data.targets:[];notificationRulesLoaded=true;renderPwaNotificationRules();return true;}catch(_){if(seq!==notificationRulesRequestSeq)return false;notificationRulesLoaded=false;var st=$('settings-notification-rule-status');if(st)st.textContent=t('notificationsRuleError');return false;}}
  function setPwaNotificationRuleBusy(busy){notificationRuleMutationBusy=!!busy;var add=$('settings-notification-rule-add');if(add)add.disabled=!!busy;var box=$('settings-notification-rule-list');if(box)Array.prototype.forEach.call(box.querySelectorAll('button'),function(btn){btn.disabled=!!busy;});}
  async function savePwaNotificationRule(payload){var st=$('settings-notification-rule-status');if(notificationRuleMutationBusy)return false;setPwaNotificationRuleBusy(true);try{var r=await appMutate('/app/notification-rules','application/json',JSON.stringify(payload));if(!r.ok)throw new Error('rule-'+r.status);if(st)st.textContent=t('notificationsRuleSaved');await loadPwaNotificationRules();return true;}catch(_){if(st)st.textContent=t('notificationsRuleError');return false;}finally{setPwaNotificationRuleBusy(false);}}
  async function addPwaNotificationRule(){var metric=$('settings-notification-rule-metric')?$('settings-notification-rule-metric').value:'views';var threshold=pwaRuleThresholdFromInput(metric,$('settings-notification-rule-threshold')&&$('settings-notification-rule-threshold').value);var st=$('settings-notification-rule-status');if(!threshold){if(st)st.textContent=t('notificationsRuleError');return;}var saved=await savePwaNotificationRule({metric:metric,threshold:threshold,shareId:$('settings-notification-rule-target')&&$('settings-notification-rule-target').value||null,label:$('settings-notification-rule-label')&&$('settings-notification-rule-label').value||'',enabled:true});if(saved){if($('settings-notification-rule-threshold'))$('settings-notification-rule-threshold').value='';if($('settings-notification-rule-label'))$('settings-notification-rule-label').value='';}}
  async function deletePwaNotificationRule(id){var st=$('settings-notification-rule-status');if(notificationRuleMutationBusy)return false;setPwaNotificationRuleBusy(true);try{var r=await appMutate('/app/notification-rules/delete','application/json',JSON.stringify({id:id}));if(!r.ok)throw new Error('rule-delete-'+r.status);if(st)st.textContent=t('notificationsRuleDeleted');await loadPwaNotificationRules();return true;}catch(_){if(st)st.textContent=t('notificationsRuleError');return false;}finally{setPwaNotificationRuleBusy(false);}}
  if($('settings-notification-rule-metric'))$('settings-notification-rule-metric').addEventListener('change',updatePwaRuleTargets);
  if($('settings-notification-rule-add'))$('settings-notification-rule-add').addEventListener('click',addPwaNotificationRule);

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
        if (!db.objectStoreNames.contains(OCR_INDEX_STORE)) db.createObjectStore(OCR_INDEX_STORE, { keyPath: 'id' });
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
    }).catch(function (error) {
      // A transient Android/WebView IndexedDB outage must not poison the whole page
      // lifetime. Clearing the memoized rejected promise lets the next operation retry
      // once the old tab/upgrade lock disappears, without requiring a full reload.
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }
  function idbAction(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var value, settled = false;
        var timer = setTimeout(function () {
          if (settled) return; settled = true;
          try { tx.abort(); } catch (_) {}
          dbPromise = null;
          reject(new Error('idb-transaction-timeout'));
        }, 8000);
        function finish(error) {
          if (settled) return; settled = true; clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        }
        try { value = fn(store); } catch (e) { clearTimeout(timer); settled = true; reject(e); return; }
        tx.oncomplete = function () { finish(null); };
        tx.onerror = function () { finish(tx.error || new Error('idb-error')); };
        tx.onabort = function () { finish(tx.error || new Error('idb-abort')); };
      });
    });
  }
  function idbPut(store, value) { return idbAction(store, 'readwrite', function (s) { s.put(value); }); }
  function idbDelete(store, key) { return idbAction(store, 'readwrite', function (s) { s.delete(key); }); }
  function idbClear(store) { return idbAction(store, 'readwrite', function (s) { s.clear(); }); }
  function idbGetAll(store) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readonly'), req = tx.objectStore(store).getAll(), settled = false;
        var timer = setTimeout(function () { if (settled) return; settled = true; try { tx.abort(); } catch (_) {} dbPromise = null; reject(new Error('idb-read-timeout')); }, 8000);
        req.onsuccess = function () { if (settled) return; settled = true; clearTimeout(timer); resolve(req.result || []); };
        req.onerror = function () { if (settled) return; settled = true; clearTimeout(timer); reject(req.error); };
        tx.onabort = function () { if (settled) return; settled = true; clearTimeout(timer); reject(tx.error || new Error('idb-abort')); };
      });
    });
  }
  function idbReplaceAll(store, values) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readwrite'), settled = false;
        var timer = setTimeout(function () { if (settled) return; settled = true; try { tx.abort(); } catch (_) {} dbPromise = null; reject(new Error('idb-transaction-timeout')); }, 8000);
        var target = tx.objectStore(store);
        target.clear();
        (Array.isArray(values) ? values : []).forEach(function (value) { target.put(value); });
        function finish(error) { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); }
        tx.oncomplete = function () { finish(null); };
        tx.onerror = function () { finish(tx.error || new Error('idb-error')); };
        tx.onabort = function () { finish(tx.error || new Error('idb-abort')); };
      });
    });
  }
  function idbGet(store, key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, 'readonly'), req = tx.objectStore(store).get(key), settled = false;
        var timer = setTimeout(function () { if (settled) return; settled = true; try { tx.abort(); } catch (_) {} dbPromise = null; reject(new Error('idb-read-timeout')); }, 8000);
        req.onsuccess = function () { if (settled) return; settled = true; clearTimeout(timer); resolve(req.result || null); };
        req.onerror = function () { if (settled) return; settled = true; clearTimeout(timer); reject(req.error); };
        tx.onabort = function () { if (settled) return; settled = true; clearTimeout(timer); reject(tx.error || new Error('idb-abort')); };
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
      }).catch(function (error) {
        // Storage availability can change after quota pressure / WebView resume.
        // Never memoize a rejected OPFS promise for the rest of the page lifetime.
        opfsDirPromise = null;
        throw error;
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
      recordTransferError(it, { code: 'local-storage', badge: 'storage', hint: t('errorLocalStorage') });
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
  function preparedPayloadIsDurable(it) {
    var uploadSize = Number(it && it.upSize);
    if (!it || !it.preparedBlob || !Number.isFinite(uploadSize) || uploadSize < 0) return false;
    if (it.preparedOpfsPath) return true;
    if (it.preparedBlob === it.file || it.preparedUsesSource) {
      return !!it.opfsPath || (!it.volatile && !!it.file && payloadBytesForPersistence(it) <= durablePayloadLimit());
    }
    return !it.preparedVolatile && payloadBytesForPersistence(it) <= durablePayloadLimit();
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
    it.contentHash = '';
    it.deduped = false;
    it.dlpLocal = null;
    it.dlpApprovedFingerprint = '';
    it.backgroundReady = false;
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
      if (r.state === 'done-background') {
        restoredBackgroundCompletions.push(r);
        await idbDelete(QUEUE_STORE, r.id).catch(function () {});
        continue;
      }
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

  async function importBackgroundCompletions() {
    var completed = restoredBackgroundCompletions.splice(0);
    for (var i = 0; i < completed.length; i++) {
      var r = completed[i], historyId = 'background-' + String(r.id || '');
      if (!r.id || historyEntries.some(function (h) { return h.id === historyId; })) continue;
      var snap = r.snapshot || {}, bytes = Number(r.upSize) || Number(r.size) || 0;
      await addHistory({
        id: historyId, name: r.name || r.upName || 'file', size: Number(r.size) || bytes,
        sentSize: bytes, destination: snap.name || ('…' + String(snap.token || '').slice(-8)),
        destToken: snap.token || '', encrypted: !!(r.preparedEncrypted || snap.enc),
        at: Number(r.backgroundCompletedAt) || Date.now(), rate: 0, note: r.note || '', background: true
      });
      sessionFiles++; sessionBytes += bytes; lifetimeFiles++; lifetimeBytes += bytes;
    }
    if (completed.length) {
      await metaSet('lifetime', { files: lifetimeFiles, bytes: lifetimeBytes }).catch(function () {});
      updateSessionStats();
    }
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
  // Last destination remembered PERSISTENTLY across visits. The session
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
        opt.textContent = (d.emoji ? d.emoji + ' ' : '') + (d.pinned ? '⭐ ' : '') + (dot ? dot + ' ' : '') + (d.name || ('…' + d.token.slice(-8)));
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
    if ($('dest-empty-hint')) $('dest-empty-hint').classList.toggle('hidden', !!list.length);
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
  function validateDest(dest) {
    // IMPORTANT: never GET the public /u/:token page just to validate a destination.
    // That route represents a real visitor page view and intentionally increments the
    // share's view/unique-visitor counters. The upload-status probe is side-effect-free;
    // ?config=1 asks it to return the small public upload configuration the PWA needs.
    return fetchWithTimeout('/u/' + encodeURIComponent(dest.token) + '/upload-status?id=dxcheck0000&config=1', { credentials: 'same-origin', cache: 'no-store' }, 10000)
      .then(function (r) {
        if (r.status === 401) return { status: 'locked' };
        if (r.status === 403) return { status: 'revoked' };
        if (!r.ok) return { status: 'invalid' };
        return r.json().then(function (data) {
          return { status: 'ok', config: (data && data.config) || {} };
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
    // Visual remaining-quota bars: a coloured gauge per limited axis.
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
      // Warn once per destination when any axis crosses 85 %; clear the
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
    if ($('dest-emoji')) $('dest-emoji').value = d ? (d.emoji || '') : '';
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
    editingToken = ''; $('dest-form').classList.add('hidden'); $('dest-url').value = ''; $('dest-name').value = ''; if ($('dest-emoji')) $('dest-emoji').value = ''; $('dest-remove-btn').classList.add('hidden');
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
    if ($('create-moderated')) $('create-moderated').checked = false;
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
      var r = await appMutate('/app/inbox', 'application/json', JSON.stringify({ name: name, moderated: !!($('create-moderated') && $('create-moderated').checked) }));
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
  // Session-only counters (session stats) and a persisted average upload
  // rate used to estimate the time of a batch BEFORE it starts sending.
  var sessionFiles = 0, sessionBytes = 0;
  var avgRate = 0;
  try { avgRate = Number(localStorage.getItem('dx-pwa-avg-rate')) || 0; } catch (_) {}
  // Last upload failure, kept for the "Copy diagnostics" button.
  var lastDiag = null;
  var recentErrors = [];
  try { recentErrors = JSON.parse(localStorage.getItem('dx-pwa-error-log') || '[]'); if (!Array.isArray(recentErrors)) recentErrors = []; } catch (_) { recentErrors = []; }
  recentErrors = recentErrors.slice(-30);
  var networkErrorHistory = [];
  try { networkErrorHistory = JSON.parse(localStorage.getItem('dx-pwa-network-errors-v1') || '[]'); if (!Array.isArray(networkErrorHistory)) networkErrorHistory = []; } catch (_) { networkErrorHistory = []; }
  networkErrorHistory = networkErrorHistory.slice(-100);
  var lastNetworkTest = null;
  try { lastNetworkTest = JSON.parse(localStorage.getItem('dx-pwa-network-test') || 'null'); } catch (_) { lastNetworkTest = null; }
  var networkTestPromise = null;
  var networkRecommendedChunk = 0;
  var networkRecommendedConcurrency = 0;
  var networkConfiguredConcurrency = 0;
  var networkRetryCount = 0;
  var networkActiveTransfers = 0;
  var networkRateSamples = [];
  var networkLastSampleAt = 0;
  var networkAdaptiveConcurrencyLimit = 0;
  var networkAdaptiveState = 'auto';
  var networkSlowSince = 0;
  var networkGoodSince = 0;
  var networkLastRetryAt = 0;
  var transferNotificationLastAt = 0;
  var transferNotificationLastPayload = null;
  // Full-size URLs of image links created this session, for "Copy all".
  var imageLinkUrls = [];
  var imageRowsByToken = new Map();
  var imageRecordsByToken = new Map();
  var selectedImageTokens = new Set();
  var pendingImageRevokes = new Map();
  // Only the most recently selected image keeps the five-second undo window.
  // Older entries may remain in the map briefly while their server mutation is
  // in flight, which also prevents a refresh from rendering them again.
  var activePendingImageRevoke = null;
  var imageStatsTimer = null;
  var imageStatsAbortController = null;
  var imageFullRefreshInFlight = false;
  var imageRefreshGeneration = 0;
  var imageMissingConfirmations = new Map();
  var imageCountdownTimer = null;
  // OCR matches for already-shared images. Server tokens come from the persistent
  // global OCR index; local records come from this device's IndexedDB OCR index.
  var imageOcrServerTokens = new Set();
  var imageOcrServerQuery = '';
  var imageOcrSearchTimer = null;
  var imageOcrSearchRequest = 0;
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
  var queueKindFilter = 'all';
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
  var batchStartedAt = 0;
  var batchClockTimer = null;
  var restoredBackgroundCompletions = [];

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
      note: it.note || '',
      contentHash: it.contentHash || '',
      deduped: !!it.deduped,
      dlpLocal: it.dlpLocal || null,
      dlpApprovedFingerprint: it.dlpApprovedFingerprint || '',
      backgroundReady: !!it.backgroundReady,
      // Persist the transport policy with the prepared payload. The service worker
      // must not bypass a Wi-Fi-only rule after the page is closed.
      wifiRequired: !!it.wifiRequired,
      backgroundFailedAt: Math.max(0, Number(it.backgroundFailedAt) || 0),
      backgroundCompletedAt: Math.max(0, Number(it.backgroundCompletedAt) || 0),
      backgroundResponse: it.backgroundResponse || null,
      lastCheckpointAt: Math.max(0, Number(it.lastCheckpointAt) || 0),
      lastServerOffset: Math.max(0, Number(it.lastServerOffset) || 0),
      recoveryAttempts: Math.max(0, Number(it.recoveryAttempts) || 0),
      recoveredAt: Math.max(0, Number(it.recoveredAt) || 0),
      recoveryReason: it.recoveryReason || null
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
  function queueRecordFreshness(r) {
    if (!r) return 0;
    return Math.max(
      Number(r.backgroundCompletedAt) || 0, Number(r.backgroundFailedAt) || 0,
      Number(r.lastCheckpointAt) || 0, Number(r.recoveredAt) || 0, Number(r.createdAt) || 0
    );
  }
  function mergeQueueRecords(primary, backup) {
    var best = Object.create(null), order = [];
    (Array.isArray(primary) ? primary : []).concat(Array.isArray(backup) ? backup : []).forEach(function (r) {
      if (!r || !r.id) return;
      var previous = best[r.id];
      if (!previous) { best[r.id] = r; order.push(r.id); return; }
      var newer = queueRecordFreshness(r) - queueRecordFreshness(previous);
      if (newer > 0 || (newer === 0 && Number(r.sentBytes || 0) > Number(previous.sentBytes || 0))) best[r.id] = r;
    });
    return order.map(function (id) { return best[id]; }).filter(Boolean);
  }
  function markSessionOnly(it, notify) {
    if (!it) return Promise.resolve(false);
    var changed = !it.volatile;
    it.volatile = true;
    // A service worker cannot read an in-memory/session-only payload. Keep the
    // normal foreground queue usable, but never advertise it as background-safe.
    it.backgroundReady = false;
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
      return idbPut(QUEUE_STORE, queueRecord(it)).then(function () { return true; }).catch(function () {
        // localStorage can restore OPFS metadata when the page reopens, but the
        // service worker has no localStorage access and therefore cannot resume it.
        it.backgroundReady = false; saveQueueBackup(); return true;
      });
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
      contentHash: record.contentHash || '',
      deduped: !!record.deduped,
      dlpLocal: record.dlpLocal || null,
      dlpApprovedFingerprint: record.dlpApprovedFingerprint || '',
      backgroundFailedAt: Math.max(0, Number(record.backgroundFailedAt) || 0),
      backgroundCompletedAt: Math.max(0, Number(record.backgroundCompletedAt) || 0),
      backgroundResponse: record.backgroundResponse || null,
      backgroundReady: !!record.backgroundReady,
      wifiRequired: !!record.wifiRequired,
      lastCheckpointAt: Math.max(0, Number(record.lastCheckpointAt) || 0),
      lastServerOffset: Math.max(0, Number(record.lastServerOffset) || 0),
      recoveryAttempts: Math.max(0, Number(record.recoveryAttempts) || 0),
      recoveredAt: Math.max(0, Number(record.recoveredAt) || 0),
      recoveryReason: record.recoveryReason || null,
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
    if (!files.length) return [];
    var budget = await durableBudget();
    var limit = durablePayloadLimit();
    var plannedDurable = 0;
    var skipped = 0, added = 0, sessionOnlyCount = 0, addedItems = [];
    if (opfsAvailable()) requestPersistentStorage().catch(function () {});
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (isDuplicate(file)) { skipped++; continue; }
      var reason = rejectReason(file);
      if (reason) { toast(t(reason), 'warn'); recordTransferError(null, { name: file.name || '', code: reason, hint: t(reason) }); continue; }
      var rel = file.webkitRelativePath || file.name || ('file-' + Date.now());
      var canOpfs = opfsAvailable() && plannedDurable + file.size <= budget;
      var canIdb = !canOpfs && file.size <= limit && plannedDurable + file.size <= budget;
      var durable = canOpfs || canIdb;
      var item = makeItem({ file: file, name: rel, originalName: rel, type: file.type, size: file.size, lastModified: file.lastModified, state: 'waiting', volatile: !durable });
      items.push(item); addedItems.push(item);
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
    return addedItems;
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
  // Coarse type bucket for the "sort by type" mode; the numeric prefix
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
  function queueKindMatches(it) {
    if (!it || queueKindFilter === 'all') return true;
    var type = String(it.type || ''), key = fileTypeKey(it);
    if (queueKindFilter === 'images') return /^image\//.test(type) || key === '1-image';
    if (queueKindFilter === 'videos') return /^video\//.test(type) || key === '2-video';
    if (queueKindFilter === 'documents') return !/^image\//.test(type) && !/^video\//.test(type) && !/^audio\//.test(type);
    if (queueKindFilter === 'waiting') return ['waiting', 'paused', 'waiting-network', 'sending', 'encrypting', 'optimizing'].indexOf(it.state) !== -1;
    if (queueKindFilter === 'done') return it.state === 'done';
    if (queueKindFilter === 'errors') return it.state === 'error';
    return true;
  }
  function sortedItems() {
    var visible = items.filter(function (it) { return it.state !== 'removed' && queueKindMatches(it); });
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
    // Bulk actions are scoped to the visible queue. Without pruning here, changing
    // a quick filter/search left hidden files selected and bulk remove/retry/DLP
    // could unexpectedly act on rows the user could no longer see.
    var visibleIds = new Set(visible.map(function (it) { return it.id; }));
    Array.from(selectedIds).forEach(function (id) { if (!visibleIds.has(id)) selectedIds.delete(id); });
    if ($('queue-sort')) $('queue-sort').classList.toggle('hidden', totalVisible < 2);
    if ($('queue-quick-filters')) $('queue-quick-filters').classList.toggle('hidden', totalVisible === 0);
    Array.prototype.forEach.call(document.querySelectorAll('[data-queue-kind]'), function (btn) { btn.classList.toggle('active', btn.dataset.queueKind === queueKindFilter); });
    if ($('queue-search-wrap')) $('queue-search-wrap').classList.toggle('hidden', totalVisible < 4 && !queueFilter);
    if ((queueFilter || queueKindFilter !== 'all') && !visible.length && totalVisible) {
      var none = document.createElement('p'); none.className = 'muted sm'; none.textContent = t('historyNoMatch'); list.appendChild(none);
    }
    // Drag-to-reorder only makes sense in manual "order added" mode with no active filter.
    var canDrag = sortMode === 'added' && !queueFilter && queueKindFilter === 'all' && !sending;
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
      if (canDrag) {
        var grip = document.createElement('button'); grip.type = 'button'; grip.className = 'drag-handle'; grip.textContent = '↕'; grip.title = t('dragHandle'); grip.setAttribute('aria-label', t('dragHandle'));
        top.appendChild(grip); attachTouchReorderHandle(grip, row, it, list);
      }
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
      if (it.dlpLocal) {
        var dlpChip = document.createElement('span');
        dlpChip.className = 'dlp-chip' + (it.dlpLocal.scanning ? ' scanning' : it.dlpLocal.count ? ' finding' : pwaDlpIncomplete(it.dlpLocal) ? ' warn' : ' safe');
        dlpChip.textContent = it.dlpLocal.scanning ? 'DLP…' : it.dlpLocal.count ? ('DLP ' + it.dlpLocal.count) : pwaDlpIncomplete(it.dlpLocal) ? 'DLP ?' : 'DLP ✓';
        dlpChip.title = pwaDlpChipText(it); top.appendChild(dlpChip);
      }
      var actions = document.createElement('div'); actions.className = 'row-actions';
      if (it.file) {
        var pv = document.createElement('button'); pv.type = 'button'; pv.className = 'icon-action preview'; pv.textContent = '◉'; pv.title = t('preview'); pv.setAttribute('aria-label', t('preview'));
        pv.addEventListener('click', function () { openPreview(it); }); actions.appendChild(pv);
        if (pwaDlpPolicy().enabled) {
          var dlpBtn = document.createElement('button'); dlpBtn.type = 'button'; dlpBtn.className = 'icon-action dlp-test'; dlpBtn.textContent = 'DLP'; dlpBtn.title = t('dlpTest'); dlpBtn.setAttribute('aria-label', t('dlpTest'));
          dlpBtn.addEventListener('click', function () { runPwaDlpForItem(it, { force:true }); }); actions.appendChild(dlpBtn);
        }
      }
      if (canOcrItem(it)) {
        var ocr = document.createElement('button'); ocr.type = 'button'; ocr.className = 'icon-action ocr'; ocr.textContent = 'T'; ocr.title = t('ocrAction'); ocr.setAttribute('aria-label', t('ocrAction'));
        ocr.addEventListener('click', function () { openOcr(it); }); actions.appendChild(ocr);
      }
      if (canPrivacyInspectItem(it)) {
        var priv = document.createElement('button'); priv.type = 'button'; priv.className = 'icon-action privacy'; priv.textContent = '🛡'; priv.title = t('privacyInspect'); priv.setAttribute('aria-label', t('privacyInspect'));
        priv.addEventListener('click', function () { openPrivacyInspector(it); }); actions.appendChild(priv);
      }
      if (it.state === 'error') {
        var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'icon-action'; retry.textContent = '↻'; retry.title = t('retry'); retry.setAttribute('aria-label', t('retry'));
        retry.addEventListener('click', function () { retryItem(it); }); actions.appendChild(retry);
      }
      if (/^image\//.test(it.type) && it.file && !it.snapshot && ['sending', 'encrypting', 'optimizing', 'done'].indexOf(it.state) === -1) {
        var ann = document.createElement('button'); ann.type = 'button'; ann.className = 'btn ghost sm queue-editor-action annotate'; ann.textContent = '🎨 ' + t('editorTitle'); ann.title = t('annotate'); ann.setAttribute('aria-label', t('editorTitle'));
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
    if ($('dlp-test-queue-btn')) $('dlp-test-queue-btn').classList.toggle('hidden', !totalVisible || !pwaDlpPolicy().enabled || sending);
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
    if ($('bulk-dlp-btn')) $('bulk-dlp-btn').disabled = !n || !pwaDlpPolicy().enabled || sending;
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
    // Snapshot enough to rebuild the row if the user taps "Undo". Only
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
      // Metadata-only mode keeps JPEG/PNG/WebP pixel data byte-for-byte intact.
      // This avoids the quality loss and huge-memory canvas round-trip of the old path.
      if (!optimize && strip && (/^image\/(jpeg|png|webp)$/i.test(it.type || '') || /\.(jpe?g|png|webp)$/i.test(it.name || ''))) {
        return await cleanImagePrivacy(file);
      }
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
  function imageVariantLongSide(variant, fallback) {
    var width = Math.max(0, Math.round(Number(variant && variant.w) || 0));
    var height = Math.max(0, Math.round(Number(variant && variant.h) || 0));
    var current = Math.max(width, height);
    return current > 0 ? current : Math.max(1, Math.round(Number(fallback) || 1));
  }
  function imageVariantDimensions(width, height, longestSide) {
    width = Math.max(1, Math.round(Number(width) || 1));
    height = Math.max(1, Math.round(Number(height) || 1));
    longestSide = Math.max(1, Math.round(Number(longestSide) || 1));
    var scale = Math.min(1, longestSide / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  async function makeImageVariants(file, currentVariants) {
    var image = await loadImage(file);
    var w = image.width, h = image.height;
    // Existing images can have custom Mini/Micro sizes. Preserve each variant's
    // current longest side when the Full is edited or replaced, while deriving the
    // other side again from the edited image so rotations/crops never get stretched.
    // New images (or old records without dimensions) still use 480/240 defaults.
    var thumbTarget = imageVariantLongSide(currentVariants && currentVariants.thumb, 480);
    var thumbDimensions = imageVariantDimensions(w, h, thumbTarget);
    var thumbWidth = thumbDimensions.width;
    var thumbHeight = thumbDimensions.height;
    async function make(width, height) {
      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      var context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // Near-lossless JPEG for the Mini/Micro variants: same resolution as before but
      // ~3× the file size and visibly cleaner (raised from 0.82). 1.0 is avoided as it
      // disables chroma subsampling and roughly sextuples the size for no visible gain.
      return canvasBlob(canvas, 'image/jpeg', 0.99);
    }
    try {
      var microFallback = Math.max(1, Math.round(Math.max(thumbWidth, thumbHeight) / 2));
      var microTarget = imageVariantLongSide(currentVariants && currentVariants.micro, microFallback);
      var microDimensions = imageVariantDimensions(w, h, microTarget);
      var microWidth = microDimensions.width;
      var microHeight = microDimensions.height;
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
    // Always send a valid JSON document. Some reverse proxies reject a POST that
    // advertises application/json with a zero-length body before Express sees it.
    return appMutate('/app/share/' + encodeURIComponent(token) + '/revoke', 'application/json', '{}')
      .then(function (r) { if (r.ok) { try { setTimeout(loadPwaTrash, 0); setTimeout(loadPwaActionHistory, 0); setTimeout(function(){ loadPwaServerActivity(true).catch(function(){}); }, 0); } catch (_) {} } return r.ok; }).catch(function () { return false; });
  }

  // ---- Server-file shares (standard Direct-Xfer function) ------------------
  // Browse the read-only host filesystem and turn a file/folder into a public
  // /s or /f link, exactly like the desktop admin. The server restricts these to
  // an administrator session, so a bare paired device sees the "sign in" note.
  var shareCwd = '/';
  var shareSelected = Object.create(null); // hostPath -> { name, size }
  var shareRangeAnchorIndex = null;
  var shareRangeCwd = null;
  var sharesInitialised = false;
  var sharesWired = false;
  var hostSharesCache = [];
  var shareShowArchived = false;
  var activeShareCount = 0; // active file/folder share links, shown as the Partages nav badge
  var pwaTrashSelection = Object.create(null);

  function onSharesPanelShown() {
    initShares();
    // Re-run on every open (not only the first) so the admin-required note re-evaluates
    // whenever the session state changed since last time — it must appear immediately,
    // not only after the user pokes a button.
    sharesBrowse(sharesInitialised ? shareCwd : '/');
    loadHostShares();
    loadReceptions();
    loadPwaTrash();
    loadPwaActionHistory();
    sharesInitialised = true;
  }

  function initShares() {
    if (sharesWired) return; sharesWired = true;
    if ($('share-up')) $('share-up').addEventListener('click', function () {
      var parent = $('share-up').getAttribute('data-parent');
      if (parent) sharesBrowse(parent);
    });
    if ($('share-refresh')) $('share-refresh').addEventListener('click', function () { sharesBrowse(shareCwd); loadHostShares(); loadReceptions(); loadPwaTrash(); loadPwaActionHistory(); });
    if ($('share-create-btn')) $('share-create-btn').addEventListener('click', createHostShare);
  if ($('share-created-copy')) $('share-created-copy').addEventListener('click', function () { var box=$('share-created-link'), url=box&&box.dataset.url; if(url) copyText(url).then(function(){toast(t('copied'),'ok');}); });
    if ($('share-archived-toggle')) $('share-archived-toggle').addEventListener('click', function () { shareShowArchived=!shareShowArchived; this.classList.toggle('active',shareShowArchived); this.setAttribute('aria-pressed',shareShowArchived?'true':'false'); renderHostShares(hostSharesCache); });
    if ($('share-trash-refresh')) $('share-trash-refresh').addEventListener('click', loadPwaTrash);
    if ($('share-trash-restore-selected')) $('share-trash-restore-selected').addEventListener('click', restoreSelectedPwaTrash);
    if ($('action-history-refresh')) $('action-history-refresh').addEventListener('click', loadPwaActionHistory);
    if ($('share-trash-purge-all')) $('share-trash-purge-all').addEventListener('click', purgeAllPwaTrash);
    if ($('share-global-search-btn')) $('share-global-search-btn').addEventListener('click', runPwaGlobalSearch);
    if ($('share-global-search')) $('share-global-search').addEventListener('keydown', function(e){if(e.key==='Enter'){e.preventDefault();runPwaGlobalSearch();}});
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
      var nextCwd = data.cwd || '/';
      if (shareRangeCwd !== nextCwd) { shareRangeAnchorIndex = null; shareRangeCwd = nextCwd; }
      shareCwd = nextCwd;
      if ($('share-path')) $('share-path').value = shareCwd;
      if ($('share-up')) { $('share-up').setAttribute('data-parent', data.parent || ''); $('share-up').disabled = !data.parent; }
      renderShareBrowser(data.entries || []);
    } catch (_) { listEl.textContent = ''; toast(t('sharesBrowseFail'), 'err'); }
  }

  function renderShareBrowser(entries) {
    var listEl = $('share-browser-list'); listEl.textContent = '';
    entries.forEach(function (e, entryIndex) {
      var rowEl = document.createElement('div'); rowEl.className = 'share-row' + (e.isDir ? ' is-dir' : '');
      rowEl.setAttribute('data-share-index', String(entryIndex));
      if (e.isDir) {
        // A folder can be BOTH selected (its own checkbox → a folder share) and opened
        // (the name/chevron navigates in), mirroring the standard admin multi-select.
        var dcb = document.createElement('input'); dcb.type = 'checkbox'; dcb.className = 'share-check'; dcb.checked = !!shareSelected[e.path];
        dcb.addEventListener('click', function (ev) { handleSharePickerClick(entries, e, entryIndex, dcb, ev); });
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
        cb.addEventListener('click', function (ev) { handleSharePickerClick(entries, e, entryIndex, cb, ev); });
        lab.addEventListener('click', function (ev) {
          if (!ev.shiftKey || ev.target === cb) return;
          ev.preventDefault();
          cb.checked = true;
          handleSharePickerClick(entries, e, entryIndex, cb, ev);
        });
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

  function handleSharePickerClick(entries, entry, entryIndex, checkbox, ev) {
    var checked = !!checkbox.checked;
    if (ev && ev.shiftKey && shareRangeAnchorIndex !== null && shareRangeCwd === shareCwd) {
      var lo = Math.min(shareRangeAnchorIndex, entryIndex), hi = Math.max(shareRangeAnchorIndex, entryIndex);
      // Shift+click always selects the contiguous range. Existing selections in
      // other directories remain intact, matching the standard file picker.
      for (var i = lo; i <= hi; i++) toggleShareItem(entries[i], true, false);
      renderShareBrowser(entries);
      updateShareSelection();
      return;
    }
    toggleShareItem(entry, checked);
    shareRangeAnchorIndex = entryIndex;
    shareRangeCwd = shareCwd;
  }

  function toggleShareItem(entry, checked, update) {
    if (checked) shareSelected[entry.path] = { name: entry.name, size: entry.size };
    else delete shareSelected[entry.path];
    if (update !== false) updateShareSelection();
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
    var rateRaw = String($('share-rate') && $('share-rate').value || '').trim();
    var rateValue = rateRaw === '' ? 0 : Number(rateRaw);
    if (!Number.isFinite(rateValue) || !Number.isInteger(rateValue) || rateValue < 0) { toast(t('sharesRateFail'),'err'); if($('share-rate'))$('share-rate').focus(); return; }
    var btn = $('share-create-btn'), status = $('share-create-status');
    var prev = btn.textContent; btn.disabled = true; btn.textContent = t('sharesCreating');
    if (status) { status.textContent = ''; status.className = 'dest-status muted'; }
    var payload = {
      paths: paths,
      expiresInSeconds: Number($('share-expiry') && $('share-expiry').value) || 0,
      maxDownloads: Number($('share-maxdl') && $('share-maxdl').value) || 0,
      rateKBps: rateValue,
      firstUseExpirySeconds: Math.max(0, Math.round((Number($('share-first-use') && $('share-first-use').value) || 0) * 3600)),
      burnAfterDownload: !!($('share-one-time') && $('share-one-time').checked),
      password: ($('share-password') && $('share-password').value) || '',
      color: String($('share-color') && $('share-color').value || '').trim(),
      adminNote: String($('share-admin-note') && $('share-admin-note').value || '')
    };
    try {
      var r = await appMutate('/app/host/shares', 'application/json', JSON.stringify(payload));
      if (r.status === 409) {
        var warning = await r.clone().json().catch(function () { return {}; });
        if (warning.error === 'dlp-warning' && warning.dlp && window.confirm(pwaServerDlpWarningText(warning.dlp))) {
          payload.dlpOverride = true;
          r = await appMutate('/app/host/shares', 'application/json', JSON.stringify(payload));
        }
      }
      if (!r.ok) {
        var denied = await r.clone().json().catch(function () { return {}; });
        var createFailure = new Error('create ' + r.status);
        if (denied.error === 'dlp-blocked') createFailure.dxReason = t('sharesDlpBlocked');
        else if (denied.error === 'dlp-quarantined') createFailure.dxReason = t('dlpServerQuarantined');
        else if (denied.error === 'dlp-quarantine-failed') createFailure.dxReason = t('dlpQuarantineFailed');
        throw createFailure;
      }
      var data = await r.json();
      var url = data.share && data.share.url;
      shareSelected = Object.create(null); updateShareSelection();
      if ($('share-password')) $('share-password').value = '';
      if ($('share-first-use')) $('share-first-use').value = '0';
      if ($('share-rate')) $('share-rate').value = '0';
      if ($('share-color')) $('share-color').value = '';
      if ($('share-admin-note')) $('share-admin-note').value = '';
      if ($('share-one-time')) $('share-one-time').checked = false;
      sharesBrowse(shareCwd);
      if (url) {
        var created=$('share-created-link'), createdUrl=$('share-created-url');
        if(created&&createdUrl){createdUrl.textContent=url;created.dataset.url=url;created.classList.remove('hidden');}
        try { await copyText(url); } catch (_) {}
      }
      if (status) { status.textContent = t('sharesCreated'); status.className = 'dest-status ok'; }
      toast(t('sharesCreated'), 'ok');
      loadHostShares();
    } catch (e) {
      var createMessage = e && e.dxReason ? e.dxReason : t('sharesCreateFail');
      if (status) { status.textContent = createMessage; status.className = 'dest-status err'; }
      toast(createMessage, 'err');
    } finally { btn.textContent = prev; btn.disabled = selectedSharePaths().length === 0; }
  }

  // Live "downloading now" presence. A single SSE stream, open only
  // while the Shares panel is visible, reports how many downloads are in progress
  // on each of the viewer's links. The payload is authoritative full state, so any
  // link absent from `counts` is cleared.
  var presenceSource = null;
  var presenceCounts = Object.create(null);
  function applyPresenceToCards() {
    var nodes = document.querySelectorAll('.share-live-badge[data-share-id]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], id = node.getAttribute('data-share-id');
      var n = (id && presenceCounts[id]) || 0;
      if (n > 0) {
        node.textContent = '⬇ ' + n;
        node.setAttribute('title', t('sharesDownloadingNow', { n: n }));
        node.setAttribute('aria-label', t('sharesDownloadingNow', { n: n }));
        node.classList.remove('hidden');
      } else {
        node.textContent = '';
        node.classList.add('hidden');
      }
    }
  }
  function startSharesPresence() {
    if (presenceSource || typeof EventSource !== 'function') return;
    try { presenceSource = new EventSource('/app/shares/presence/stream', { withCredentials: true }); }
    catch (_) { presenceSource = null; return; }
    presenceSource.addEventListener('presence', function (e) {
      try {
        var data = JSON.parse(e.data);
        presenceCounts = (data && data.counts && typeof data.counts === 'object') ? data.counts : Object.create(null);
      } catch (_) { presenceCounts = Object.create(null); }
      applyPresenceToCards();
    });
    // EventSource reconnects on its own; a hard error (e.g. 403 after logout) closes
    // it for good, so drop our handle and clear the badges.
    presenceSource.addEventListener('error', function () {
      if (presenceSource && presenceSource.readyState === 2) stopSharesPresence();
    });
  }
  function stopSharesPresence() {
    if (presenceSource) { try { presenceSource.close(); } catch (_) {} presenceSource = null; }
    presenceCounts = Object.create(null);
    applyPresenceToCards();
  }

  var hostShareMetricsTimer = null;
  async function loadHostShares() {
    try {
      var r = await fetch('/app/host/shares', { credentials: 'same-origin', cache: 'no-store' });
      // The admin-required note is driven solely by the FS-browse endpoint (session-only);
      // this list works for admin devices too, so it must not toggle that note.
      if (r.status === 403) { activeShareCount = 0; updatePwaNavBadges(); return; }
      if (!r.ok) throw new Error('list');
      var data = await r.json();
      var shares = data.shares || [];
      hostSharesCache = shares;
      if (data.metricsPending && !hostShareMetricsTimer) hostShareMetricsTimer = setTimeout(function () { hostShareMetricsTimer = null; loadHostShares(); }, 900);
      // Badge count = active share links only (an expired / disabled link is not "active").
      activeShareCount = shares.filter(function (s) { return s && s.active !== false; }).length;
      updatePwaNavBadges();
      if ($('share-list')) { renderHostShares(shares); applyPresenceToCards(); }
    } catch (_) {}
  }

  function focusPwaLaunchObject(){if(!launchFocusToken)return false;try{var node=document.querySelector('[data-token="'+CSS.escape(String(launchFocusToken))+'"]');if(!node)return false;node.classList.add('notification-focus');node.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(function(){node.classList.remove('notification-focus');},5000);launchFocusToken='';return true;}catch(_){return false;}}
  function schedulePwaLaunchFocus(){if(!launchFocusToken)return;var attempts=0,timer=setInterval(function(){attempts++;if(focusPwaLaunchObject()||attempts>=40)clearInterval(timer);},250);}
  function renderHostShares(list) {
    var listEl = $('share-list'); listEl.textContent = '';
    var visible=(list||[]).filter(function(s){return shareShowArchived||!s.archived;});
    if (!visible.length) { var em = document.createElement('p'); em.className = 'muted sm'; em.textContent = t('sharesEmpty'); listEl.appendChild(em); return; }
    visible.forEach(function (s) {
      var row = document.createElement('div'); row.className = 'share-link-row'; if(s.token)row.dataset.token=String(s.token);
      if(/^#[0-9a-f]{6}$/i.test(String(s.color||''))){row.style.borderLeftColor=s.color;row.style.borderLeftWidth='4px';}
      var main = document.createElement('div'); main.className = 'share-link-main';
      var strong = document.createElement('strong'); strong.textContent = s.name || s.token; main.appendChild(strong);
      var meta = document.createElement('div'); meta.className = 'muted sm';
      var bits = [];
      if (s.type === 'folder') bits.push('📁');
      if (s.type === 'web-storage') bits.push('☁');
      if (s.type === 'collab') bits.push('🔁');
      if (s.itemCount != null) bits.push(t('sharesItems', { n: s.itemCount }));
      var totalBytes = Number(s.logicalBytes);
      if (s.logicalBytesReady !== false && Number.isFinite(totalBytes) && totalBytes >= 0) bits.push(t('sharesTotalSize', { size: fmtBytes(totalBytes) }));
      else if (s.logicalBytesReady !== false && s.size != null) bits.push(t('sharesTotalSize', { size: fmtBytes(s.size) }));
      if ((s.type === 'file' || s.type === 'folder' || s.type === 'web-storage') && (Number(s.downloadsUsed) || 0) === 0) bits.push('◌ ' + t('sharesNeverDownloaded'));
      if (s.hasPassword) bits.push('🔒 ' + t('sharesPasswordProtected'));
      var expiry = Number(s.effectiveExpiresAt) || 0;
      if (expiry > Date.now() && expiry - Date.now() <= 86400000) bits.push('⏳ ' + t('sharesExpiresSoon'));
      if (Number(s.rateKBps) > 0) bits.push('⚡ ' + Number(s.rateKBps) + ' KB/s');
      if(s.pinned)bits.push('📌 '+t('sharesPinnedBadge'));
      if(s.archived)bits.push('🗄 '+t('sharesArchivedBadge'));
      if(s.revoked)bits.push('⛔ '+t('sharesRevokedBadge'));
      bits.push(fmtDate(s.createdAt));
      meta.textContent = bits.join(' · '); main.appendChild(meta);
      if(s.adminNote){var note=document.createElement('div');note.className='muted sm share-private-note';note.textContent='📝 '+s.adminNote;main.appendChild(note);}
      if (s.id) {
        var live = document.createElement('span');
        live.className = 'share-live-badge hidden';
        live.setAttribute('data-share-id', String(s.id));
        live.setAttribute('role', 'status');
        main.appendChild(live);
      }
      row.appendChild(main);
      var actions = document.createElement('div'); actions.className = 'share-link-actions';
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn ghost sm'; copy.textContent = '🔗 ' + t('sharesCopy');
      copy.addEventListener('click', function () { if (s.url) copyText(s.url).then(function () { toast(t('copied'), 'ok'); }); }); actions.appendChild(copy);
      var open = document.createElement('button'); open.type = 'button'; open.className = 'btn ghost sm'; open.textContent = t('sharesOpen');
      open.addEventListener('click', function () { if (s.url) window.open(s.url, '_blank', 'noopener'); }); actions.appendChild(open);
      if (s.token) {
        var statsBtn = document.createElement('button'); statsBtn.type = 'button'; statsBtn.className = 'btn ghost sm'; statsBtn.textContent = t('sharesStatsButton');
        statsBtn.addEventListener('click', function () { openHostShareDetailedStats(s); }); actions.appendChild(statsBtn);
      }
      var metaBtn=document.createElement('button');metaBtn.type='button';metaBtn.className='btn ghost sm';metaBtn.textContent=t('sharesEditMeta');metaBtn.addEventListener('click',function(){editHostShareMeta(s);});actions.appendChild(metaBtn);
      var clone=document.createElement('button');clone.type='button';clone.className='btn ghost sm';clone.textContent=t('sharesDuplicate');clone.addEventListener('click',function(){cloneHostShare(s);});actions.appendChild(clone);
      var pin=document.createElement('button');pin.type='button';pin.className='btn ghost sm';pin.textContent=t(s.pinned?'sharesUnpin':'sharesPin');pin.addEventListener('click',function(){toggleHostSharePin(s);});actions.appendChild(pin);
      var archive=document.createElement('button');archive.type='button';archive.className='btn ghost sm';archive.textContent=t(s.archived?'sharesUnarchive':'sharesArchive');archive.addEventListener('click',function(){toggleHostShareArchive(s);});actions.appendChild(archive);
      if(s.revoked){var react=document.createElement('button');react.type='button';react.className='btn ghost sm';react.textContent=t('sharesReactivate');react.addEventListener('click',function(){reactivateHostShare(s);});actions.appendChild(react);}
      if (s.type === 'file' || s.type === 'folder' || s.type === 'web-storage') {
        var rate = document.createElement('button'); rate.type='button'; rate.className='btn ghost sm'; rate.textContent='⚡ '+t('sharesRateEdit');
        rate.addEventListener('click', function(){ editHostShareRate(s); }); actions.appendChild(rate);
      }
      var rev = document.createElement('button'); rev.type = 'button'; rev.className = 'btn danger sm'; rev.textContent = t('sharesRevoke');
      rev.addEventListener('click', function () { revokeHostShare(s.token); }); actions.appendChild(rev);
      row.appendChild(actions); listEl.appendChild(row);
    });
    if(launchFocusToken)schedulePwaLaunchFocus();
  }

  function shareStatsNumber(value) {
    var locale = lang === 'fr' ? 'fr-CA' : lang === 'es' ? 'es-ES' : 'en-US';
    return (Number(value) || 0).toLocaleString(locale);
  }
  function shareStatsBps(value) { return fmtBytes(Math.max(0, Number(value) || 0)) + '/s'; }
  function shareStatsDuration(ms) {
    ms = Math.max(0, Number(ms) || 0);
    if (ms < 1000) return Math.round(ms) + ' ms';
    var sec = ms / 1000;
    if (sec < 60) return sec.toFixed(sec < 10 ? 1 : 0) + ' s';
    var min = Math.floor(sec / 60), rest = Math.round(sec % 60);
    if (min < 60) return min + ' min ' + rest + ' s';
    return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
  }
  function shareStatsStatusLabel(status) {
    var map = { active:'shareStatsActive', inactive:'shareStatsInactive', paused:'shareStatsPaused', scheduled:'shareStatsScheduled', expired:'shareStatsExpired', revoked:'shareStatsRevoked' };
    return t(map[String(status || '').toLowerCase()] || 'shareStatsUnknown');
  }
  function shareStatsTypeLabel(type) {
    var map = { file:'shareStatsFile', folder:'shareStatsFolder', collab:'shareStatsCollab', 'web-storage':'shareStatsWebStorage' };
    return t(map[String(type || '').toLowerCase()] || 'shareStatsUnknown');
  }
  function shareStatsMetric(icon, value, label, detail) {
    var card = imageStatsMetric(icon, value, label);
    if (detail) {
      var main = card.querySelector('div');
      var small = document.createElement('small'); small.className = 'share-stats-metric-detail'; small.textContent = detail;
      if (main) main.appendChild(small);
    }
    return card;
  }
  function shareStatsBreakdown(rows) {
    var box = document.createElement('div'); box.className = 'share-stats-breakdown'; rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) { var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = t('shareStatsNoData'); box.appendChild(empty); return box; }
    var max = Math.max.apply(null, [1].concat(rows.map(function (row) { return Number(row && row.count) || 0; })));
    rows.forEach(function (entry) {
      var row = document.createElement('div'); row.className = 'share-stats-breakdown-row';
      var label = document.createElement('span'); label.className = 'share-stats-breakdown-label'; label.textContent = (entry.flag ? entry.flag + ' ' : '') + (entry.name || entry.label || t('shareStatsUnknown'));
      var bar = document.createElement('span'); bar.className = 'share-stats-breakdown-bar'; var fill = document.createElement('i'); fill.style.width = Math.max(4, Math.round(((Number(entry.count) || 0) / max) * 100)) + '%'; bar.appendChild(fill);
      var value = document.createElement('strong'); value.textContent = shareStatsNumber(entry.count);
      row.appendChild(label); row.appendChild(bar); row.appendChild(value); box.appendChild(row);
    });
    return box;
  }
  function shareStatsTimeline(points) {
    var chart = document.createElement('div'); chart.className = 'share-stats-timeline'; points = Array.isArray(points) ? points : [];
    var max = Math.max.apply(null, [1].concat(points.map(function (p) { return Number(p && p.bytes) || Number(p && p.count) || 0; })));
    points.forEach(function (point) {
      var raw = Number(point.bytes) || Number(point.count) || 0;
      var cell = document.createElement('div'); cell.className = 'share-stats-timeline-cell'; cell.title = String(point.day || '') + ' · ' + shareStatsNumber(point.count) + ' · ' + fmtBytes(point.bytes || 0);
      var bar = document.createElement('i'); bar.style.height = (raw ? Math.max(6, Math.round((raw / max) * 100)) : 2) + '%';
      var label = document.createElement('span'); var rawLabel=String(point.day || ''); label.textContent = /^\d{2}:\d{2}$/.test(rawLabel) ? rawLabel : rawLabel.slice(5); cell.appendChild(bar); cell.appendChild(label); chart.appendChild(cell);
    });
    return chart;
  }
  function shareStatsAppendEvent(list, event, shareName, live) {
    var row = document.createElement('div'); row.className = 'image-stats-event' + (live ? ' share-stats-live' : '');
    var icon = document.createElement('span'); icon.className = 'image-stats-event-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = live ? (event.direction === 'up' ? '⬆' : '⬇') : (event.completed ? (event.direction === 'up' ? '⬆' : '⬇') : '⚠');
    var main = document.createElement('div'); main.className = 'image-stats-event-main'; var title = document.createElement('strong'); title.textContent = event.name || shareName || '—';
    var client = [event.flag, event.ipName || event.ip, event.country, event.recipient ? '👤 ' + event.recipient : ''].filter(Boolean).join(' · ');
    var detail = document.createElement('span');
    var resumed = event.resumed ? ('↻ ' + t('shareStatsResumed') + (event.resumeOffset ? ' · ' + t('shareStatsResumedFrom') + ' ' + fmtBytes(event.resumeOffset) : '')) : '';
    detail.textContent = live ? [fmtBytes(event.bytes || 0) + (event.expectedBytes ? ' / ' + fmtBytes(event.expectedBytes) : ''), resumed, client].filter(Boolean).join(' · ') : [fmtBytes(event.bytes || 0), shareStatsDuration(event.durationMs || 0), shareStatsBps(event.avgBps || 0), resumed, client].filter(Boolean).join(' · ');
    main.appendChild(title); main.appendChild(detail);
    if (!live && !event.completed && event.reason) { var reason = document.createElement('small'); reason.className = 'share-stats-event-reason'; reason.textContent = String(event.reason); main.appendChild(reason); }
    row.appendChild(icon); row.appendChild(main);
    if (!live) { var time = document.createElement('time'); time.textContent = event.at ? fmtDate(event.at) : '—'; row.appendChild(time); }
    list.appendChild(row);
  }
  var pwaHostStatsCurrentShare = null;
  var pwaHostStatsPeriod = '14';
  function shareStatsDelta(value, suffix) {
    var n = Number(value) || 0; return (n > 0 ? '+' : '') + n + (suffix || '%');
  }
  function shareStatsPeriodToolbar() {
    var bar = document.createElement('div'); bar.className = 'share-stats-period-toolbar';
    var label = document.createElement('label'); label.textContent = t('shareStatsPeriod') + ' ';
    var sel = document.createElement('select'); sel.className = 'input sm';
    [['1','shareStats24h'],['7','shareStats7d'],['14','shareStats14d'],['30','shareStats30d'],['all','shareStatsAll']].forEach(function (entry) {
      var o=document.createElement('option'); o.value=entry[0]; o.textContent=t(entry[1]); if(entry[0]===pwaHostStatsPeriod)o.selected=true; sel.appendChild(o);
    });
    sel.addEventListener('change', function () { pwaHostStatsPeriod=sel.value; if(pwaHostStatsCurrentShare) openHostShareDetailedStats(pwaHostStatsCurrentShare, pwaHostStatsPeriod, true); });
    label.appendChild(sel); bar.appendChild(label); return bar;
  }
  function shareStatsComparisonSection(comp) {
    if (!comp || !comp.available) return null;
    var sec=imageStatsSection(t('shareStatsComparison')), grid=document.createElement('div'); grid.className='image-stats-metrics share-stats-comparison';
    var d=comp.delta||{};
    grid.appendChild(shareStatsMetric('🔄',shareStatsDelta(d.countPct),t('shareStatsChangeTransfers')));
    grid.appendChild(shareStatsMetric('💾',shareStatsDelta(d.bytesPct),t('shareStatsChangeVolume')));
    grid.appendChild(shareStatsMetric('✅',shareStatsDelta(d.successRatePoints,' pt'),t('shareStatsChangeSuccess')));
    grid.appendChild(shareStatsMetric('⚡',shareStatsDelta(d.speedPct),t('shareStatsChangeSpeed')));
    sec.appendChild(grid); return sec;
  }
  function shareStatsFailureSection(rows) {
    rows=Array.isArray(rows)?rows:[]; if(!rows.length)return null;
    var sec=imageStatsSection(t('shareStatsFailures')), box=document.createElement('div'); box.className='share-stats-breakdown';
    var max=Math.max.apply(null,[1].concat(rows.map(function(x){return Number(x.count)||0;})));
    rows.forEach(function(x){var row=document.createElement('div');row.className='share-stats-breakdown-row';var lab=document.createElement('span');lab.className='share-stats-breakdown-label';lab.textContent=x.reason||t('shareStatsUnknown');var bar=document.createElement('span');bar.className='share-stats-breakdown-bar';var fill=document.createElement('i');fill.style.width=Math.max(4,Math.round((Number(x.count)||0)/max*100))+'%';bar.appendChild(fill);var val=document.createElement('strong');val.textContent=shareStatsNumber(x.count);row.append(lab,bar,val);box.appendChild(row);});
    sec.appendChild(box); return sec;
  }

  function renderHostShareDetailedStats(data) {
    var body = $('image-stats-body'); if (!body) return; body.innerHTML = '';
    if (!data || !data.share) { body.textContent = t('shareStatsUnavailable'); return; }
    var sh = data.share, ag = data.aggregate || {}, image = data.image || null;
    body.appendChild(shareStatsPeriodToolbar());
    var overview = imageStatsSection(t('shareStatsOverview')); var metrics = document.createElement('div'); metrics.className = 'image-stats-metrics share-stats-metrics';
    metrics.appendChild(shareStatsMetric('🔄', shareStatsNumber(ag.count), t('shareStatsTransfers'), shareStatsNumber(ag.completed) + ' ' + t('shareStatsCompleted') + ' · ' + shareStatsNumber(ag.interrupted) + ' ' + t('shareStatsInterrupted')));
    metrics.appendChild(shareStatsMetric('💾', fmtBytes(ag.bytes || 0), t('shareStatsVolume'), t('shareStatsAverageSize') + ' : ' + fmtBytes(ag.averageBytes || 0)));
    metrics.appendChild(shareStatsMetric('✅', (Number(ag.successRate) || 0) + '%', t('shareStatsSuccess')));
    metrics.appendChild(shareStatsMetric('⚡', shareStatsBps(ag.averageBps || 0), t('shareStatsSpeed')));
    metrics.appendChild(shareStatsMetric('👁', shareStatsNumber((image && image.totalViews) || sh.views || 0), t('shareStatsViews')));
    metrics.appendChild(shareStatsMetric('👤', shareStatsNumber((image && image.totalVisitors) || sh.uniqueVisitors || 0), t('shareStatsVisitors')));
    if (image) metrics.appendChild(shareStatsMetric('🗄', fmtBytes(image.totalStorageBytes || sh.logicalBytes || 0), t('shareStatsStorage')));
    else metrics.appendChild(shareStatsMetric('⬇', shareStatsNumber(sh.downloads || 0), t('shareStatsDownloads')));
    metrics.appendChild(shareStatsMetric('↻', shareStatsNumber(ag.resumed || 0), t('shareStatsResumed')));
    overview.appendChild(metrics); body.appendChild(overview);
    var comparisonSection = shareStatsComparisonSection(data.comparison); if (comparisonSection) body.appendChild(comparisonSection);

    var detailsSection = imageStatsSection(t('shareStatsDetails')); var details = document.createElement('div'); details.className = 'image-stats-details share-stats-details';
    [[t('shareStatsStatus'),shareStatsStatusLabel(sh.status)],[t('shareStatsType'),shareStatsTypeLabel(sh.type)],[t('shareStatsOwner'),sh.ownerName||'—'],[t('shareStatsCreated'),sh.createdAt?fmtDate(sh.createdAt):'—'],[t('shareStatsExpiry'),(sh.effectiveExpiresAt||sh.expiresAt)?fmtDate(sh.effectiveExpiresAt||sh.expiresAt):t('shareStatsNever')],[t('shareStatsItems'),shareStatsNumber(sh.itemCount)],[t('shareStatsStorage'),fmtBytes(sh.logicalBytes||0)],[t('shareStatsLastActivity'),ag.lastAt?fmtDate(ag.lastAt):'—'],[t('shareStatsFirstActivity'),ag.firstAt?fmtDate(ag.firstAt):'—'],[t('shareStatsTags'),Array.isArray(sh.tags)&&sh.tags.length?sh.tags.join(', '):'—'],[t('shareStatsPath'),sh.path||'—'],[t('shareStatsUrl'),sh.url||'—']].forEach(function (entry) { details.appendChild(imageStatsDetail(entry[0], entry[1])); });
    detailsSection.appendChild(details); body.appendChild(detailsSection);

    if (Array.isArray(data.quota) && data.quota.length) {
      var quotaSection = imageStatsSection(t('shareStatsQuota')); var quotaList = document.createElement('div'); quotaList.className = 'share-stats-quota-list';
      data.quota.forEach(function (q) {
        var pct = q.max ? Math.max(0, Math.min(100, Math.round((Number(q.used || 0) / Number(q.max)) * 100))) : 0;
        var label = q.kind === 'bytes' ? t('shareStatsStorage') : q.kind === 'files' ? t('shareStatsFiles') : q.kind === 'visitors' ? t('shareStatsVisitors') : t('shareStatsDownloads');
        var used = q.kind === 'bytes' ? fmtBytes(q.used || 0) : shareStatsNumber(q.used), max = q.kind === 'bytes' ? fmtBytes(q.max || 0) : shareStatsNumber(q.max);
        var row = document.createElement('div'); row.className = 'share-stats-quota-row'; var head = document.createElement('div'); head.className = 'share-stats-quota-head'; head.textContent = label + ' · ' + used + ' / ' + max + ' · ' + pct + '%';
        var bar = document.createElement('div'); bar.className = 'share-stats-quota-bar'; var fill = document.createElement('i'); fill.style.width = pct + '%'; bar.appendChild(fill); row.appendChild(head); row.appendChild(bar); quotaList.appendChild(row);
      });
      quotaSection.appendChild(quotaList); body.appendChild(quotaSection);
    }
    if (Array.isArray(data.live) && data.live.length) { var liveSection = imageStatsSection(t('shareStatsLive')); var liveList = document.createElement('div'); liveList.className = 'image-stats-recent'; data.live.forEach(function (e) { shareStatsAppendEvent(liveList,e,sh.name,true); }); liveSection.appendChild(liveList); body.appendChild(liveSection); }
    if (data.image && data.image.variants) {
      var variantsSection=imageStatsSection(t('shareStatsImageCopies')||'Image'); var variants=document.createElement('div'); variants.className='image-stats-variants';
      ['full','thumb','micro'].forEach(function(kind){var v=data.image.variants[kind]||{};var card=document.createElement('div');card.className='image-stats-variant'+(v.present===false?' missing':'');var title=document.createElement('strong');title.textContent=imageVariantLabel(kind);card.appendChild(title);[
        t('shareStatsDimensions')+' : '+(v.w&&v.h?v.w+'×'+v.h:'—'), t('shareStatsStorage')+' : '+fmtBytes(v.size||0), t('shareStatsViews')+' : '+shareStatsNumber(v.views), t('shareStatsVisitors')+' : '+shareStatsNumber(v.visitors), t('shareStatsBandwidth')+' : '+fmtBytes(v.bandwidthBytes||0), t('shareStatsViewShare')+' : '+(Number(v.viewSharePct)||0)+'%'
      ].forEach(function(txt){var line=document.createElement('span');line.textContent=txt;card.appendChild(line);});variants.appendChild(card);}); variantsSection.appendChild(variants);body.appendChild(variantsSection);
    }
    var timelineSection = imageStatsSection(t('shareStatsActivity')); timelineSection.appendChild(shareStatsTimeline(data.timeline || [])); body.appendChild(timelineSection);
    var failureSection=shareStatsFailureSection(data.failureReasons); if(failureSection)body.appendChild(failureSection);
    var split = document.createElement('div'); split.className = 'share-stats-two-columns'; var countries=imageStatsSection(t('shareStatsCountries')); countries.appendChild(shareStatsBreakdown(data.countries||[])); var clients=imageStatsSection(t('shareStatsClients')); clients.appendChild(shareStatsBreakdown(data.clients||[])); split.appendChild(countries); split.appendChild(clients); body.appendChild(split);
    var recentSection=imageStatsSection(t('shareStatsRecent')); var recentList=document.createElement('div'); recentList.className='image-stats-recent';
    if (!Array.isArray(data.recent) || !data.recent.length) { var empty=document.createElement('p'); empty.className='muted sm'; empty.textContent=t('shareStatsNoRecent'); recentList.appendChild(empty); } else data.recent.forEach(function(e){shareStatsAppendEvent(recentList,e,sh.name,false);});
    recentSection.appendChild(recentList); body.appendChild(recentSection);
  }
  var detailedStatsRequestSerial = 0;
  async function openHostShareDetailedStats(share, period, keepOpen) {
    var overlay = $('image-stats-overlay'), body = $('image-stats-body'); if (!share || !share.token || !overlay || !body) return;
    pwaHostStatsCurrentShare=share; if(period)pwaHostStatsPeriod=period;
    var requestSerial = ++detailedStatsRequestSerial;
    overlay.classList.add('share-stats-mode'); $('image-stats-title').textContent = t('shareStatsTitle'); $('image-stats-subtitle').textContent = share.name || share.token || ''; body.textContent = t('shareStatsLoading'); body.scrollTop = 0; if(!keepOpen)overlay.classList.remove('hidden');
    if (!keepOpen && $('image-stats-close')) $('image-stats-close').focus();
    try {
      var response = await fetch('/app/host/shares/' + encodeURIComponent(share.token) + '/stats-detail?period=' + encodeURIComponent(pwaHostStatsPeriod), { credentials:'same-origin', cache:'no-store', headers:{ Accept:'application/json' } });
      if (!response.ok) throw new Error('http ' + response.status);
      var payload = await response.json();
      if (requestSerial !== detailedStatsRequestSerial || overlay.classList.contains('hidden') || !overlay.classList.contains('share-stats-mode')) return;
      renderHostShareDetailedStats(payload); body.scrollTop = 0;
    } catch (_) { if (requestSerial === detailedStatsRequestSerial && !overlay.classList.contains('hidden') && overlay.classList.contains('share-stats-mode')) body.textContent = t('shareStatsUnavailable'); }
  }

  async function editHostShareMeta(share){
    var color=window.prompt(t('sharesColor'),String(share&&share.color||''));if(color===null)return;
    var note=window.prompt(t('sharesAdminNote'),String(share&&share.adminNote||''));if(note===null)return;
    try{var r=await appMutate('/app/host/shares/'+encodeURIComponent(share.token)+'/meta','application/json',JSON.stringify({color:String(color).trim(),adminNote:String(note)}));if(!r.ok)throw new Error('meta');await loadHostShares();}
    catch(_){toast(t('sharesCreateFail'),'err');}
  }
  async function toggleHostShareArchive(share){
    try{var r=await appMutate('/app/host/shares/'+encodeURIComponent(share.token)+'/meta','application/json',JSON.stringify({archived:!share.archived}));if(!r.ok)throw new Error('archive');await loadHostShares();}
    catch(_){toast(t('sharesCreateFail'),'err');}
  }
  async function toggleHostSharePin(share){
    try{var r=await appMutate('/app/host/shares/'+encodeURIComponent(share.token)+'/meta','application/json',JSON.stringify({pinned:!share.pinned}));if(!r.ok)throw new Error('pin');await loadHostShares();}
    catch(_){toast(t('sharesCreateFail'),'err');}
  }
  async function cloneHostShare(share){
    var name=window.prompt(t('sharesDuplicatePrompt'),String((share&&share.name)||'Share')+' (copy)');if(name===null)return;name=String(name).trim();if(!name)return;
    try{var r=await appMutate('/app/host/shares/'+encodeURIComponent(share.token)+'/clone','application/json',JSON.stringify({name:name}));if(!r.ok)throw new Error('clone');toast(t('sharesDuplicated'),'ok');await loadHostShares();}
    catch(_){toast(t('sharesDuplicateFail'),'err');}
  }
  async function reactivateHostShare(share){
    try{var r=await appMutate('/app/host/shares/'+encodeURIComponent(share.token)+'/reactivate','application/json','{}');if(!r.ok){var d=await r.clone().json().catch(function(){return{};});if(d.error==='data-missing')throw Object.assign(new Error('missing'),{missing:true});throw new Error('reactivate');}toast(t('sharesReactivated'),'ok');await loadHostShares();}
    catch(e){toast(e&&e.missing?t('sharesReactivateMissing'):t('sharesRevokeFail'),'err');}
  }

  function updatePwaTrashSelectionUi(){
    var ids=Object.keys(pwaTrashSelection), btn=$('share-trash-restore-selected'), label=$('share-trash-selected-count');
    if(btn){btn.classList.toggle('hidden',!ids.length);btn.disabled=!ids.length;}
    if(label)label.textContent=ids.length?t('sharesTrashSelected',{n:ids.length}):'';
  }
  var pwaTrashPurgeSummary=null;
  async function loadPwaTrash(){
    var box=$('share-trash-list'),purgeAll=$('share-trash-purge-all');if(!box)return;box.textContent='…';if(purgeAll)purgeAll.classList.add('hidden');
    try{
      var r=await fetch('/app/trash',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('trash');var data=await r.json();var items=data.items||[],canPurge=!!data.canPurge;pwaTrashPurgeSummary=data.purgeSummary||null;box.textContent='';
      var count=$('share-trash-count');if(count)count.textContent=String(items.length);
      var liveIds=Object.create(null);items.forEach(function(item){liveIds[item.id]=true;});Object.keys(pwaTrashSelection).forEach(function(id){if(!liveIds[id])delete pwaTrashSelection[id];});updatePwaTrashSelectionUi();
      if(purgeAll)purgeAll.classList.toggle('hidden',!canPurge||!items.length);if(!items.length){var em=document.createElement('p');em.className='muted sm';em.textContent=t('sharesTrashEmpty');box.appendChild(em);return;}
      items.forEach(function(item){var row=document.createElement('div');row.className='share-link-row';var main=document.createElement('div');main.className='share-link-main';
        var select=document.createElement('label');select.className='trash-select';var cb=document.createElement('input');cb.type='checkbox';cb.checked=!!pwaTrashSelection[item.id];cb.setAttribute('aria-label',t('sharesTrashRestore')+' '+(item.name||item.shareId));cb.addEventListener('change',function(){if(cb.checked)pwaTrashSelection[item.id]=true;else delete pwaTrashSelection[item.id];updatePwaTrashSelectionUi();});select.appendChild(cb);main.appendChild(select);
        var strong=document.createElement('strong');strong.textContent=item.name||item.shareId;var meta=document.createElement('div');meta.className='muted sm';meta.textContent=[item.type||'',fmtBytes(item.logicalBytes||0),fmtDate(item.deletedAt)].filter(Boolean).join(' · ');main.appendChild(strong);main.appendChild(meta);var impact=item.purgeImpact||{},impactLine=document.createElement('div');impactLine.className='muted xs trash-impact';impactLine.textContent=t('sharesTrashImpact',{count:impact.itemCount||1,bytes:fmtBytes(impact.bytes||item.logicalBytes||0)})+' · '+t('sharesTrashDependencies',{value:(impact.dependencies&&impact.dependencies.length)?impact.dependencies.join(', '):t('sharesTrashNoDependencies')});main.appendChild(impactLine);var actions=document.createElement('div');actions.className='share-link-actions';var restore=document.createElement('button');restore.type='button';restore.className='btn ghost sm';restore.textContent=t('sharesTrashRestore');restore.addEventListener('click',function(){restorePwaTrash(item.id);});actions.appendChild(restore);if(canPurge){var purge=document.createElement('button');purge.type='button';purge.className='btn danger sm';purge.textContent=t('sharesTrashDelete');purge.addEventListener('click',function(){purgePwaTrash(item.id,item.name||item.shareId,item);});actions.appendChild(purge);}row.appendChild(main);row.appendChild(actions);box.appendChild(row);});
    }catch(_){
      pwaTrashPurgeSummary=null;
      if(purgeAll)purgeAll.classList.add('hidden');
      Object.keys(pwaTrashSelection).forEach(function(id){delete pwaTrashSelection[id];});
      updatePwaTrashSelectionUi();
      if($('share-trash-count'))$('share-trash-count').textContent='—';
      box.textContent=t('sharesTrashEmpty');
    }
  }
  async function pwaTrashRestoreRequest(id){var r=await appMutate('/app/trash/'+encodeURIComponent(id)+'/restore','application/json','{}');if(r.status===409){var d=await r.clone().json().catch(function(){return{};}),alts=d.assessment&&Array.isArray(d.assessment.alternatives)?d.assessment.alternatives:[],path=alts[0]||'';if(path&&!confirm(t('sharesTrashSmartRestore',{path:path})))path='';if(!path)path=window.prompt(t('sharesTrashChooseRestore'),alts[0]||'')||'';if(!path)throw new Error('restore-cancel');r=await appMutate('/app/trash/'+encodeURIComponent(id)+'/restore','application/json',JSON.stringify({alternativePath:path}));}if(!r.ok)throw new Error('restore');return r;}
  async function restoreSelectedPwaTrash(){
    var ids=Object.keys(pwaTrashSelection);if(!ids.length)return;var btn=$('share-trash-restore-selected');if(btn)btn.disabled=true;var ok=0,fail=0;
    try{
      for(var i=0;i<ids.length;i++){try{await pwaTrashRestoreRequest(ids[i]);delete pwaTrashSelection[ids[i]];ok++;}catch(_){fail++;}}
      if(ok)toast(t('sharesTrashRestoreSelectedOk',{n:ok}),fail?'warn':'ok');else if(fail)toast(t('sharesRevokeFail'),'err');
      await Promise.all([loadPwaTrash(),loadPwaActionHistory(),loadHostShares(),loadReceptions(),refreshImageStats(true)]);
    }finally{if(btn)btn.disabled=false;}
  }
  var PWA_ACTION_HISTORY_TYPES = {
    'settings-changed':'actionHistorySettings',
    'share-stats-reset':'actionHistoryStats',
    'recipient-removed':'actionHistoryRecipient',
    'ip-names-cleared':'actionHistoryIpNames',
    'share-trashed':'actionHistoryShare'
  };
  var PWA_ACTION_HISTORY_REASONS = {
    'state-changed':'actionHistoryChanged',
    'already-restored':'actionHistoryRestored',
    'already-purged':'actionHistoryPurged',
    'legacy-unsafe':'actionHistoryLegacy',
    'forbidden':'actionHistoryForbidden',
    'share-gone':'actionHistoryGone',
    'undo-unsupported':'actionHistoryUnsupported',
    'restore-conflict':'actionHistoryRestoreConflict',
    'undo-too-large':'actionHistoryTooLarge'
  };
  function pwaActionHistoryLabel(entry){var key=entry&&PWA_ACTION_HISTORY_TYPES[entry.type];return key?t(key):String(entry&&entry.type||'—');}
  function pwaActionConfirmLabel(entry){return [pwaActionHistoryLabel(entry),entry&&entry.label||''].filter(Boolean).join(' — ');}
  function pwaActionStatus(entry){if(entry&&entry.undone)return t('actionHistoryUndone');var key=entry&&PWA_ACTION_HISTORY_REASONS[entry.unavailableReason];return key?t(key):t('actionHistoryUnavailable');}
  function pwaActionCanUndo(entry){return !!(entry&&!entry.undone&&entry.canUndo!==false);}
  async function loadPwaActionHistory(){
    var box=$('action-history-list'),count=$('action-history-count');if(!box)return;box.textContent='…';
    try{
      var r=await fetch('/app/undo',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('undo-history');
      var data=await r.json(),items=Array.isArray(data.items)?data.items:[];box.textContent='';if(count)count.textContent=String(items.filter(pwaActionCanUndo).length);
      if(!items.length){var empty=document.createElement('p');empty.className='muted sm';empty.textContent=t('actionHistoryEmpty');box.appendChild(empty);return;}
      items.forEach(function(entry){
        var row=document.createElement('div');row.className='share-link-row action-history-row'+(entry.undone?' is-undone':entry.canUndo===false?' is-unavailable':'');
        var main=document.createElement('div');main.className='share-link-main';
        var strong=document.createElement('strong');strong.textContent=pwaActionHistoryLabel(entry);main.appendChild(strong);
        var meta=document.createElement('div');meta.className='muted sm';meta.textContent=[entry.label||'',entry.at?fmtDate(entry.at):'',entry.actor||''].filter(Boolean).join(' · ');main.appendChild(meta);
        var actions=document.createElement('div');actions.className='share-link-actions';
        if(entry.undone||entry.canUndo===false){var state=document.createElement('span');state.className='muted sm action-history-state';state.textContent=pwaActionStatus(entry);actions.appendChild(state);}
        if(pwaActionCanUndo(entry)){var undo=document.createElement('button');undo.type='button';undo.className='btn sm';undo.textContent=t('actionHistoryUndo');undo.addEventListener('click',function(){undoPwaAction(entry,undo);});actions.appendChild(undo);}
        row.appendChild(main);row.appendChild(actions);box.appendChild(row);
      });
    }catch(_){box.textContent=t('actionHistoryLoadFail');if(count)count.textContent='0';}
  }
  async function undoPwaAction(entry,button){
    var label=pwaActionConfirmLabel(entry);if(!window.confirm(t('actionHistoryConfirm',{label:label})))return;if(button)button.disabled=true;
    try{
      var r=await appMutate('/app/undo/'+encodeURIComponent(entry.id),'application/json','{}');
      if(!r.ok)throw new Error('undo-'+r.status);
      toast(t('actionHistorySuccess'),'ok');
      await Promise.all([loadPwaActionHistory(),loadPwaTrash(),loadHostShares(),loadReceptions(),refreshImageStats(true)]);
    }catch(_){toast(t('actionHistoryFail'),'err');if(button)button.disabled=false;loadPwaActionHistory();}
  }

  async function restorePwaTrash(id){try{await pwaTrashRestoreRequest(id);toast(t('sharesTrashRestored'),'ok');await Promise.all([loadPwaTrash(),loadPwaActionHistory(),loadHostShares(),loadReceptions(),refreshImageStats(true)]);}catch(_){toast(t('sharesRevokeFail'),'err');}}
  async function appDeleteMutate(url){if(!deviceInfo)await fetchDeviceStatus();var r=await fetch(url,{method:'DELETE',credentials:'same-origin',cache:'no-store',headers:appMutationHeaders()});if(r.status===403){var e=await r.clone().json().catch(function(){return{};});if(e.error==='invalid-csrf'){await fetchDeviceStatus();r=await fetch(url,{method:'DELETE',credentials:'same-origin',cache:'no-store',headers:appMutationHeaders()});}}return r;}
  async function purgePwaTrash(id,name,item){var imp=item&&item.purgeImpact||{},deps=imp.dependencyCount?' · '+t('sharesTrashDependencies',{value:(imp.dependencies||[]).join(', ')}):'';if(!window.confirm(t('sharesTrashDeleteConfirm',{name:name||''})+'\n'+t('sharesTrashImpact',{count:imp.itemCount||1,bytes:fmtBytes(imp.bytes!=null?imp.bytes:((item&&item.logicalBytes)||0))})+deps))return;try{var r=await appDeleteMutate('/app/trash/'+encodeURIComponent(id));if(!r.ok)throw new Error('purge');toast(t('sharesTrashDeleted'),'ok');await Promise.all([loadPwaTrash(),loadPwaActionHistory(),loadHostShares(),loadReceptions(),refreshImageStats(true)]);}catch(_){toast(t('sharesTrashDeleteFail'),'err');}}
  async function purgeAllPwaTrash(){var sum=pwaTrashPurgeSummary||{};if(!window.confirm(t('sharesTrashDeleteAllConfirm')+'\n'+t('sharesTrashImpact',{count:sum.items||0,bytes:fmtBytes(sum.bytes||0)})+(sum.dependencies?' · '+t('sharesTrashDependencies',{value:String(sum.dependencies)}):'')))return;var btn=$('share-trash-purge-all'),label=btn&&btn.textContent;if(btn)btn.disabled=true;try{var r=await appDeleteMutate('/app/trash');if(!r.ok&&r.status!==207)throw new Error('purge-all');var data=await r.json().catch(function(){return{};});toast(t('sharesTrashAllDeleted',{n:Number(data.count)||0}),data.failed?'warn':'ok');await Promise.all([loadPwaTrash(),loadPwaActionHistory(),loadHostShares(),loadReceptions(),refreshImageStats(true)]);}catch(_){toast(t('sharesTrashDeleteFail'),'err');}finally{if(btn){btn.disabled=false;if(label)btn.textContent=label;}}}
  function pwaHighlightMap(text){var locale=lang==='fr'?'fr-CA':lang==='es'?'es-ES':'en-US',map=[],parts=[],offset=0;Array.from(String(text||'')).forEach(function(ch){var folded=ch.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase(locale);for(var i=0;i<folded.length;i++){parts.push(folded[i]);map.push({start:offset,end:offset+ch.length});}offset+=ch.length;});return {text:parts.join(''),map:map};}
  function appendPwaHighlighted(node,text,terms){text=String(text||'');var locale=lang==='fr'?'fr-CA':lang==='es'?'es-ES':'en-US',folded=pwaHighlightMap(text);terms=(Array.isArray(terms)?terms:[]).map(function(x){return String(x||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLocaleLowerCase(locale);}).filter(Boolean).sort(function(a,b){return b.length-a.length;});if(!terms.length||!folded.text){node.textContent=text;return;}var ranges=[];terms.forEach(function(term){var from=0;while(from<=folded.text.length-term.length){var at=folded.text.indexOf(term,from);if(at<0)break;var first=folded.map[at],last=folded.map[at+term.length-1];if(first&&last)ranges.push([first.start,last.end]);from=at+Math.max(1,term.length);}});if(!ranges.length){node.textContent=text;return;}ranges.sort(function(a,b){return a[0]-b[0]||b[1]-a[1];});var merged=[];ranges.forEach(function(r){var last=merged[merged.length-1];if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else merged.push(r.slice());});var pos=0;merged.forEach(function(r){if(r[0]>pos)node.appendChild(document.createTextNode(text.slice(pos,r[0])));var mark=document.createElement('mark');mark.textContent=text.slice(r[0],r[1]);node.appendChild(mark);pos=r[1];});if(pos<text.length)node.appendChild(document.createTextNode(text.slice(pos)));}

  async function runPwaGlobalSearch(){
    var input=$('share-global-search'),box=$('share-global-search-results');if(!input||!box)return;var q=String(input.value||'').trim();box.textContent='';if(q.length<2)return;
    try{var r=await fetch('/app/search?q='+encodeURIComponent(q)+'&semantic=1',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error('search');var data=await r.json();var results=data.results||[];if(!results.length){box.textContent=t('sharesGlobalSearchEmpty');return;}results.slice(0,60).forEach(function(m){var row=document.createElement('div');row.className='share-search-hit';var title=document.createElement('strong');title.textContent=(m.scope==='user'?'👤 ':m.scope==='log'?'📜 ':m.scope==='link'?'🔗 ':'📄 ')+(m.shareName||'');if(m.file){title.appendChild(document.createTextNode(' · '));appendPwaHighlighted(title,m.file,m.highlightTerms);}var meta=document.createElement('span');meta.className='muted sm';appendPwaHighlighted(meta,[m.type,m.snippet].filter(Boolean).join(' · '),m.highlightTerms);row.appendChild(title);row.appendChild(meta);if(m.path||m.token){var open=document.createElement('button');open.type='button';open.className='btn ghost xs';open.textContent=t('sharesOpen');open.addEventListener('click',function(){var path=m.path||(m.type==='photo'?('/images?image='+encodeURIComponent(m.token)):('/s/'+encodeURIComponent(m.token)));window.open(path,'_blank','noopener');});row.appendChild(open);}box.appendChild(row);});}
    catch(_){box.textContent=t('sharesGlobalSearchFail');}
  }

  async function editHostShareRate(share) {
    var current=Math.max(0,Number(share&&share.rateKBps)||0); var raw=window.prompt(t('sharesRatePrompt'),String(current)); if(raw===null)return;
    raw=String(raw).trim(); var next=raw===''?0:Number(raw);
    if(!Number.isFinite(next)||!Number.isInteger(next)||next<0){toast(t('sharesRateFail'),'err');return;}
    try{var r=await appMutate('/app/host/shares/'+encodeURIComponent(share.token)+'/rate','application/json',JSON.stringify({rateKBps:next}));if(!r.ok)throw new Error('rate-'+r.status);toast(t('sharesRateSaved'),'ok');loadHostShares();}
    catch(_){toast(t('sharesRateFail'),'err');}
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
  function pruneUnavailableOwnedReceptions(activeTokens) {
    if (!Array.isArray(activeTokens)) return Promise.resolve();
    var live = Object.create(null);
    activeTokens.forEach(function (token) { if (token) live[String(token)] = true; });
    var stale = Object.create(null);
    function keep(dest) {
      if (!dest || !dest.token) return true;
      // Only purge reception links this PWA knows it owns on THIS instance. Manual
      // or external destinations must remain untouched even when the server does not
      // list them in /app/receptions.
      var localOwned = dest.owned === true && (!dest.sourceOrigin || dest.sourceOrigin === location.origin);
      if (!localOwned || live[dest.token]) return true;
      stale[dest.token] = true;
      delete destStatusCache[dest.token];
      return false;
    }
    persistentDests = persistentDests.filter(keep);
    sessionDests = sessionDests.filter(keep);
    var staleTokens = Object.keys(stale);
    if (!staleTokens.length) return Promise.resolve();
    persistSessionDests();
    saveDestsBackup();
    try { if (stale[sessionStorage.getItem('dx-active-dest') || '']) sessionStorage.removeItem('dx-active-dest'); } catch (_) {}
    try { if (stale[localStorage.getItem('dx-pwa-last-dest') || '']) localStorage.removeItem('dx-pwa-last-dest'); } catch (_) {}
    return Promise.all(staleTokens.map(function (token) { return idbDelete(DEST_STORE, token).catch(function () {}); }));
  }
  async function loadReceptions() {
    try {
      var r = await fetch('/app/receptions', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 403) return; // note is driven by the FS-browse endpoint only
      if (!r.ok) throw new Error('receptions');
      var data = await r.json();
      var now = Date.now();
      // Defensive client-side filter too: even if an older server response contains an
      // expired record, never expose it as a selectable PWA destination.
      var list = (data.receptions || []).filter(function (s) {
        var expiry = Number(s && (s.effectiveExpiresAt || s.expiresAt)) || 0;
        return !!(s && s.token) && !(expiry && now > expiry);
      });
      await pruneUnavailableOwnedReceptions(Array.isArray(data.activeTokens) ? data.activeTokens : null);
      // Feed the first-page Destination picker so every still-valid reception link
      // (any origin) is selectable there, then keep the Partages panel in sync.
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
      // Open the two-way conversation with this link's visitors.
      var chat = document.createElement('button'); chat.type = 'button'; chat.className = 'btn ghost sm reception-thread-btn';
      chat.textContent = '💬' + (Number(s.threadUnread) > 0 ? ' ' + s.threadUnread : '');
      if (Number(s.threadUnread) > 0) chat.classList.add('has-unread');
      chat.setAttribute('aria-label', t('threadTitle'));
      chat.addEventListener('click', function () { openReceptionThread(s); });
      actions.appendChild(chat);
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

  // Owner-side reception thread modal. Reads the conversation, lets
  // the owner reply, and clears the unread flag. Text is inserted via textContent
  // only, so a visitor message can never inject markup.
  function openReceptionThread(s) {
    var tk = s.token;
    var overlay = document.createElement('div'); overlay.className = 'thread-overlay';
    var modal = document.createElement('div'); modal.className = 'thread-modal';
    var head = document.createElement('div'); head.className = 'thread-modal-head';
    var title = document.createElement('h3'); title.textContent = '💬 ' + (s.name || t('sharesReceptions')); head.appendChild(title);
    var closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'icon-btn'; closeBtn.textContent = '✕'; closeBtn.setAttribute('aria-label', 'Close'); head.appendChild(closeBtn);
    modal.appendChild(head);
    var listEl = document.createElement('div'); listEl.className = 'thread-list'; modal.appendChild(listEl);
    var form = document.createElement('div'); form.className = 'thread-form';
    var textEl = document.createElement('textarea'); textEl.rows = 2; textEl.maxLength = 2000; textEl.placeholder = t('threadReplyPh'); form.appendChild(textEl);
    var sendEl = document.createElement('button'); sendEl.type = 'button'; sendEl.className = 'btn sm'; sendEl.textContent = t('threadSend'); form.appendChild(sendEl);
    modal.appendChild(form);
    overlay.appendChild(modal); document.body.appendChild(overlay);

    var closed = false, lastKey = '', timer = null, sending = false;
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function fmt(at) { try { var d = new Date(at); return pad(d.getHours()) + ':' + pad(d.getMinutes()); } catch (_) { return ''; } }
    function render(messages) {
      var key = messages.map(function (m) { return m.id; }).join(',');
      if (key === lastKey) return;
      lastKey = key;
      listEl.textContent = '';
      if (!messages.length) { var em = document.createElement('p'); em.className = 'muted sm'; em.textContent = t('threadEmpty'); listEl.appendChild(em); return; }
      messages.forEach(function (m) {
        var rowm = document.createElement('div'); rowm.className = 'thread-msg ' + (m.from === 'owner' ? 'from-owner' : 'from-visitor');
        var meta = document.createElement('div'); meta.className = 'thread-meta';
        meta.textContent = (m.from === 'owner' ? t('threadYou') : (m.name || t('threadVisitor'))) + (m.flag ? (' ' + m.flag) : '') + ' · ' + fmt(m.at);
        var body = document.createElement('div'); body.className = 'thread-text'; body.textContent = m.text;
        rowm.appendChild(meta); rowm.appendChild(body); listEl.appendChild(rowm);
      });
      listEl.scrollTop = listEl.scrollHeight;
    }
    function load() {
      fetch('/app/receptions/' + encodeURIComponent(tk) + '/thread', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (!closed && d && Array.isArray(d.messages)) render(d.messages); })
        .catch(function () {});
    }
    function post() {
      if (sending) return;
      var text = String(textEl.value || '').trim();
      if (!text) return;
      sending = true; sendEl.disabled = true; var lbl = sendEl.textContent; sendEl.textContent = t('threadSending');
      appMutate('/app/receptions/' + encodeURIComponent(tk) + '/thread', 'application/json', JSON.stringify({ text: text }))
        .then(function (r) { if (!r.ok) throw new Error('post'); return r.json(); })
        .then(function (d) { if (d && Array.isArray(d.messages)) { textEl.value = ''; lastKey = ''; render(d.messages); } })
        .catch(function () { toast(t('threadError'), 'err'); })
        .then(function () { sending = false; sendEl.disabled = false; sendEl.textContent = lbl; });
    }
    function markRead() {
      appMutate('/app/receptions/' + encodeURIComponent(tk) + '/thread/read', 'application/json', '{}')
        .then(function () { loadReceptions(); }).catch(function () {});
    }
    function close() { if (closed) return; closed = true; if (timer) clearInterval(timer); document.removeEventListener('keydown', onKey); overlay.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    sendEl.addEventListener('click', post);
    textEl.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); post(); } });
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    load();
    if (Number(s.threadUnread) > 0) markRead();
    timer = setInterval(function () { if (document.visibilityState !== 'hidden') load(); }, 10000);
  }

  function imageJsonMutation(url, payload) {
    return appMutate(url, 'application/json', JSON.stringify(payload || {}));
  }
  var IMAGE_PRIMARY_VARIANT = 'auto';
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
  function persistImagePreferences() {
    var ids = ['img-sort', 'img-filter', 'img-expiry', 'img-max-views', 'img-hotlink-hosts', 'img-smart-blur', 'img-tags', 'img-note', 'img-rename-template', 'img-copy-template', 'img-action-1', 'img-action-2', 'img-action-3'];
    ids.forEach(function (id) { var el = $(id); if (el) try { localStorage.setItem('dx-pwa-' + id, el.value); } catch (_) {} });
    ['img-compact', 'img-hide-expired', 'img-auto-copy', 'img-notify-first-view'].forEach(function (id) { var el = $(id); if (el) try { localStorage.setItem('dx-pwa-' + id, el.checked ? '1' : '0'); } catch (_) {} });
  }
  function restoreImagePreferences() {
    try { localStorage.removeItem('dx-pwa-img-default-variant'); } catch (_) {}
    ['img-sort', 'img-filter', 'img-expiry', 'img-max-views', 'img-hotlink-hosts', 'img-smart-blur', 'img-tags', 'img-note', 'img-rename-template', 'img-copy-template', 'img-action-1', 'img-action-2', 'img-action-3'].forEach(function (id) {
      var el = $(id); if (!el) return;
      try { var v = localStorage.getItem('dx-pwa-' + id); if (v !== null) el.value = v; } catch (_) {}
    });
    [['img-compact', false], ['img-hide-expired', true], ['img-auto-copy', false], ['img-notify-first-view', false]].forEach(function (pair) {
      var el = $(pair[0]); if (!el) return;
      try { var v = localStorage.getItem('dx-pwa-' + pair[0]); el.checked = v === null ? pair[1] : v === '1'; } catch (_) { el.checked = pair[1]; }
    });
    if ($('imglink-list')) $('imglink-list').classList.toggle('img-compact', !!($('img-compact') && $('img-compact').checked));
    if ($('img-copy-template') && !$('img-copy-template').value) $('img-copy-template').value = 'standard';
    if ($('img-action-1') && !$('img-action-1').value) $('img-action-1').value = 'open';
    if ($('img-action-2') && !$('img-action-2').value) $('img-action-2').value = 'qr';
    if ($('img-action-3') && !$('img-action-3').value) $('img-action-3').value = 'edit';
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
    return Array.from(new Set(raw.length ? raw : ['open', 'qr', 'edit'])).slice(0, 3);
  }
  function arrangeImageActions(row) {
    if (!row) return;
    var mapping = { open: '.il-open', qr: '.il-qr', edit: '.il-edit', ocr: '.il-ocr', pin: '.il-favorite', qrdl: '.il-qrdl', replace: '.il-replace', versions: '.il-versions' };
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
    var forceNeverExpire = !!(deviceInfo && deviceInfo.shareDefaults && deviceInfo.shareDefaults.newSharesNeverExpire);
    return {
      expiresInSeconds: forceNeverExpire ? 0 : (Number($('img-expiry') && $('img-expiry').value) || 0),
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
  async function refreshImageOcrSearch(query) {
    var q = String(query || '').trim().toLowerCase();
    var request = ++imageOcrSearchRequest;
    if (q.length < 2) {
      imageOcrServerQuery = q; imageOcrServerTokens = new Set(); applyImageView(); return;
    }
    try {
      var r = await fetch('/app/images/search?q=' + encodeURIComponent(q) + '&limit=500', { credentials:'same-origin', cache:'no-store' });
      if (!r.ok) throw new Error('search');
      var data = await r.json();
      if (request !== imageOcrSearchRequest || q !== String($('img-search') && $('img-search').value || '').trim().toLowerCase()) return;
      imageOcrServerQuery = q;
      imageOcrServerTokens = new Set(Array.isArray(data.tokens) ? data.tokens : []);
    } catch (_) {
      if (request !== imageOcrSearchRequest) return;
      imageOcrServerQuery = q; imageOcrServerTokens = new Set();
    }
    applyImageView();
  }
  function scheduleImageOcrSearch(query) {
    if (imageOcrSearchTimer) clearTimeout(imageOcrSearchTimer);
    var q = String(query || '').trim().toLowerCase();
    if (imageOcrServerQuery !== q) imageOcrServerTokens = new Set();
    imageOcrSearchTimer = setTimeout(function () { imageOcrSearchTimer = null; refreshImageOcrSearch(q); }, q.length >= 2 ? 180 : 0);
  }
  function imageExpiryDeadline(photo) {
    return Math.max(0, Number(photo && (photo.effectiveExpiresAt || photo.expiresAt)) || 0);
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
      var localOcrMatch = !!q && ocrIndexRecords.some(function (rec) {
        return rec && rec.imageToken === token && (String(rec.name || '').toLowerCase().indexOf(q) !== -1 || String(rec.text || '').toLowerCase().indexOf(q) !== -1);
      });
      var serverOcrMatch = !!q && imageOcrServerQuery === q && imageOcrServerTokens.has(token);
      var show = !q || hay.indexOf(q) !== -1 || localOcrMatch || serverOcrMatch;
      row.classList.toggle('ocr-search-match', !!(localOcrMatch || serverOcrMatch));
      if (hideExpired && photo.expired) show = false;
      if (show && filter === 'active') show = !!photo.active;
      if (show && filter === 'popular') show = imageRecordViews(photo) >= 10;
      if (show && filter === 'large') show = imageRecordBytes(photo) >= 5 * 1024 * 1024;
      if (show && filter === 'expiring') show = imageExpiryDeadline(photo) > now && imageExpiryDeadline(photo) - now <= 86400000;
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
      if (sort === 'expiry') return (imageExpiryDeadline(a.photo) || Number.MAX_SAFE_INTEGER) - (imageExpiryDeadline(b.photo) || Number.MAX_SAFE_INTEGER);
      return (b.photo.createdAt || 0) - (a.photo.createdAt || 0);
    });
    // A filter/search changes the scope of bulk actions. Clear any selection that
    // is no longer visible so a later revoke/edit cannot affect an unseen image.
    var visibleTokens = new Set(rows.map(function (item) { return item.photo.token; }));
    Array.from(selectedImageTokens).forEach(function (token) {
      if (visibleTokens.has(token)) return;
      selectedImageTokens.delete(token);
      var hiddenRow = imageRowsByToken.get(token);
      if (hiddenRow) {
        hiddenRow.classList.remove('selected');
        var hiddenCb = hiddenRow.querySelector('.img-select'); if (hiddenCb) hiddenCb.checked = false;
      }
    });
    var host = $('imglink-list'); rows.forEach(function (item) { host.appendChild(item.row); });
    // Empty state: distinguish "no images at all" from "none match the search/filter".
    var emptyEl = $('imglink-empty');
    if (emptyEl) {
      var emptyMsg = imageRecordsByToken.size === 0 ? t('imgListEmpty') : (rows.length === 0 ? t('imgNoMatch') : '');
      emptyEl.textContent = emptyMsg; emptyEl.classList.toggle('hidden', !emptyMsg);
    }
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
  // Incremental SHA-256 used by global deduplication. WebCrypto.digest requires
  // one contiguous ArrayBuffer, which is unsuitable for multi-gigabyte mobile files.
  // This implementation consumes 4 MiB slices and keeps only one SHA block in memory.
  var SHA256_K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function Sha256Incremental() {
    this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    this.buf = new Uint8Array(64); this.bufLen = 0; this.bytes = 0; this.w = new Uint32Array(64);
  }
  function rotr32(x, n) { return (x >>> n) | (x << (32 - n)); }
  Sha256Incremental.prototype.block = function (data, off) {
    var w = this.w, i;
    for (i = 0; i < 16; i++) { var j = off + i * 4; w[i] = ((data[j] << 24) | (data[j+1] << 16) | (data[j+2] << 8) | data[j+3]) >>> 0; }
    for (i = 16; i < 64; i++) { var a0 = w[i-15], b0 = w[i-2]; var s0 = rotr32(a0,7)^rotr32(a0,18)^(a0>>>3), s1=rotr32(b0,17)^rotr32(b0,19)^(b0>>>10); w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0; }
    var a=this.h[0],b=this.h[1],c=this.h[2],d=this.h[3],e=this.h[4],f=this.h[5],g=this.h[6],h=this.h[7];
    for (i=0;i<64;i++){ var S1=rotr32(e,6)^rotr32(e,11)^rotr32(e,25), ch=(e&f)^((~e)&g), t1=(h+S1+ch+SHA256_K[i]+w[i])>>>0, S0=rotr32(a,2)^rotr32(a,13)^rotr32(a,22), maj=(a&b)^(a&c)^(b&c), t2=(S0+maj)>>>0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    this.h[0]=(this.h[0]+a)>>>0;this.h[1]=(this.h[1]+b)>>>0;this.h[2]=(this.h[2]+c)>>>0;this.h[3]=(this.h[3]+d)>>>0;this.h[4]=(this.h[4]+e)>>>0;this.h[5]=(this.h[5]+f)>>>0;this.h[6]=(this.h[6]+g)>>>0;this.h[7]=(this.h[7]+h)>>>0;
  };
  Sha256Incremental.prototype.update = function (bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes); this.bytes += bytes.length; var pos=0;
    if (this.bufLen) { var need=64-this.bufLen, take=Math.min(need,bytes.length); this.buf.set(bytes.subarray(0,take),this.bufLen); this.bufLen+=take;pos+=take; if(this.bufLen===64){this.block(this.buf,0);this.bufLen=0;} }
    while(pos+64<=bytes.length){this.block(bytes,pos);pos+=64;}
    if(pos<bytes.length){this.buf.set(bytes.subarray(pos),0);this.bufLen=bytes.length-pos;}
    return this;
  };
  Sha256Incremental.prototype.hex = function () {
    var tailLen=this.bufLen<56?64:128, tail=new Uint8Array(tailLen); tail.set(this.buf.subarray(0,this.bufLen));tail[this.bufLen]=0x80;
    var hi=Math.floor(this.bytes/0x20000000)>>>0, lo=(this.bytes*8)>>>0, n=tail.length; tail[n-8]=(hi>>>24)&255;tail[n-7]=(hi>>>16)&255;tail[n-6]=(hi>>>8)&255;tail[n-5]=hi&255;tail[n-4]=(lo>>>24)&255;tail[n-3]=(lo>>>16)&255;tail[n-2]=(lo>>>8)&255;tail[n-1]=lo&255;
    for(var off=0;off<tail.length;off+=64)this.block(tail,off);
    return Array.prototype.map.call(this.h,function(v){return ('00000000'+v.toString(16)).slice(-8);}).join('');
  };
  async function sha256Blob(blob, onProgress) {
    if (!blob || typeof blob.slice !== 'function') return '';
    // Fast native path for modest files; the streaming path avoids a giant contiguous
    // allocation for large uploads and is also used where WebCrypto is unavailable.
    if (window.crypto && crypto.subtle && blob.size <= 32 * 1024 * 1024) {
      var nativeBuf = await blob.arrayBuffer(); var nativeDigest = await crypto.subtle.digest('SHA-256', nativeBuf);
      if (onProgress) onProgress(1);
      return Array.from(new Uint8Array(nativeDigest)).map(function (b) { return b.toString(16).padStart(2,'0'); }).join('');
    }
    var hash = new Sha256Incremental(), step = 4 * 1024 * 1024, done = 0;
    while (done < blob.size) {
      var end = Math.min(blob.size, done + step), part = new Uint8Array(await blob.slice(done,end).arrayBuffer()); hash.update(part); done=end;
      if (onProgress) onProgress(blob.size ? done/blob.size : 1);
      if ((done / step) % 8 === 0) await sleep(0); // keep Android's UI responsive while hashing GBs
    }
    if (onProgress) onProgress(1); return hash.hex();
  }
  async function imageDuplicate(hash) {
    if (!hash) return null;
    try { var r = await fetch('/app/image/duplicate?hash=' + encodeURIComponent(hash), { credentials: 'same-origin', cache: 'no-store' }); return r.ok ? (await r.json()).image : null; } catch (_) { return null; }
  }
  async function imageQrPng(photo) {
    var url = imageVariantUrl(photo, IMAGE_PRIMARY_VARIANT);
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
  function restoreImageRowStatus(row, photo) {
    if (!row || !photo) return;
    var st = row.querySelector('.imglink-st');
    if (!st) return;
    var stateText = photo.expired ? t('imgExpired') : !photo.active ? ((photo.maxViews && imageRecordViews(photo) >= photo.maxViews) ? t('imgViewLimitReached') : t('imgInactive')) : t('imgReady');
    st.textContent = stateText + (photo.metadataRemoved ? ' · ' + t('imgMetadataRemoved') : '');
    st.className = 'imglink-st ' + (photo.active ? 'ok' : 'muted') + ' sm';
  }
  function scheduleImageRevoke(row, photo) {
    if (!row || !photo || pendingImageRevokes.has(photo.token)) return;
    // Starting a second undo window commits the previous image immediately.
    // Do not await the network request: the new image must receive its full five
    // seconds even if the first revocation is slow behind a reverse proxy.
    if (activePendingImageRevoke && activePendingImageRevoke.commit) activePendingImageRevoke.commit();
    var undoBar = row.querySelector('.imglink-revoke-undo');
    var undoText = row.querySelector('.imglink-revoke-undo-text');
    var undoButton = row.querySelector('.imglink-cancel-revoke');
    var st = row.querySelector('.imglink-st');
    var deadline = Date.now() + 5000;
    var pending = { token: photo.token, timer: null, ticker: null, cancelled: false, committed: false, commit: null };
    function renderCountdown() {
      var seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      var text = t('imgRevokePending', { n: seconds });
      if (st) { st.textContent = text; st.className = 'imglink-st muted sm'; }
      if (undoText) undoText.textContent = text;
    }
    function clearPending(restoreStatus) {
      clearTimeout(pending.timer); clearInterval(pending.ticker);
      if (pendingImageRevokes.get(photo.token) === pending) pendingImageRevokes.delete(photo.token);
      if (activePendingImageRevoke === pending) activePendingImageRevoke = null;
      row.classList.remove('pending-revoke');
      if (undoBar) undoBar.classList.add('hidden');
      if (undoButton) undoButton.onclick = null;
      if (restoreStatus) restoreImageRowStatus(row, imageRecordsByToken.get(photo.token) || photo);
    }
    function cancelPending() {
      if (pending.cancelled || pending.committed || pendingImageRevokes.get(photo.token) !== pending) return;
      pending.cancelled = true;
      clearPending(true);
      recordImageAction('restored', photo, 'revoke-cancelled');
      toast(t('imgRevokeCancelled'), 'ok');
    }
    row.classList.add('pending-revoke');
    if (undoBar) undoBar.classList.remove('hidden');
    if (undoButton) { undoButton.textContent = t('imgCancelRevoke'); undoButton.onclick = cancelPending; }
    renderCountdown();
    pending.ticker = setInterval(renderCountdown, 250);
    pending.commit = function () {
      if (pending.cancelled || pending.committed || pendingImageRevokes.get(photo.token) !== pending) return;
      pending.committed = true;
      clearTimeout(pending.timer);
      clearInterval(pending.ticker);
      if (undoButton) { undoButton.disabled = true; undoButton.onclick = null; }
      revokeShareRequest(photo.token).then(function (ok) {
        if (ok) {
          clearPending(false);
          removeImageRow(row, photo.token, photo.imgUrl); imageRecordsByToken.delete(photo.token); recordImageAction('revoked', photo); toast(t('revokeSuccess'), 'ok');
        } else {
          if (undoButton) undoButton.disabled = false;
          clearPending(true); renderImageVariantStats(row, photo); toast(t('revokeFail'), 'err');
        }
      });
    };
    pendingImageRevokes.set(photo.token, pending);
    activePendingImageRevoke = pending;
    pending.timer = setTimeout(pending.commit, 5000);
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
    try { setTimeout(loadPwaTrash, 0); setTimeout(loadPwaActionHistory, 0); } catch (_) {}
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
  function comparisonMetricText(change) {
    if (!change) return '—';
    var delta = Number(change.delta) || 0;
    if (change.pct == null) return (delta > 0 ? '+' : '') + delta + ' (' + t('imgCompareNew') + ')';
    var pct = Number(change.pct) || 0;
    return (delta > 0 ? '+' : '') + delta + ' (' + (pct > 0 ? '+' : '') + pct + '%)';
  }
  async function refreshImageDashboard() {
    try {
      var days = Math.max(1, Math.min(30, Number($('img-dashboard-period') && $('img-dashboard-period').value) || 7));
      var r = await fetch('/app/images/dashboard?days=' + encodeURIComponent(days), { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) throw new Error();
      var data = await r.json();
      if ($('img-dashboard-summary')) $('img-dashboard-summary').textContent = t('imgChartSummary', { images: data.totals.images, views: data.totals.views, visitors: data.totals.visitors, bytes: fmtBytes(data.totals.bytes) });
      if ($('img-dashboard-comparison')) $('img-dashboard-comparison').textContent = data.comparison ? t('imgCompareSummary', { days: data.comparison.days, views: comparisonMetricText(data.comparison.changes && data.comparison.changes.views), created: comparisonMetricText(data.comparison.changes && data.comparison.changes.created) }) : '';
      drawImageDashboard(data);
    } catch (_) {}
  }
  function warnExpiringImages(photos) {
    var now = Date.now(), changed = false;
    photos.forEach(function (photo) {
      var deadline = imageExpiryDeadline(photo);
      if (!photo.active || !deadline || deadline - now > 86400000 || deadline <= now || warnedImageExpiries.has(photo.token)) return;
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
    link: dxIcon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    clipboard: dxIcon('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>'),
    star: dxIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    edit: dxIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
    grid: dxIcon('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
    refresh: dxIcon('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    clock: dxIcon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    maximize: dxIcon('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
    more: dxIcon('<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
    x: dxIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')
  };

  // Copy an image (by same-origin URL) to the clipboard as a bitmap. The Clipboard API
  // accepts image/png across browsers, so a non-PNG variant is re-encoded via a canvas.
  function blobToPng(blob) {
    if (blob.type === 'image/png') return Promise.resolve(blob);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob(function (out) { URL.revokeObjectURL(url); out ? resolve(out) : reject(new Error('encode')); }, 'image/png');
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }
  async function copyImageToClipboard(url) {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('unsupported');
    var resp = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!resp.ok) throw new Error('fetch');
    var png = await blobToPng(await resp.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }
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
      '<div class="imglink-revoke-undo hidden" role="status" aria-live="polite"><span class="imglink-revoke-undo-text"></span><button class="btn sm imglink-cancel-revoke" type="button"></button></div>' +
      '<div class="imglink-summary-row"><div class="imglink-total muted sm hidden" aria-label="Statistiques totales"><span class="img-total-metric it-views"><span class="img-total-icon" aria-hidden="true">👁</span><span class="img-total-text">—</span></span><span class="img-total-metric it-visitors"><span class="img-total-icon" aria-hidden="true">👤</span><span class="img-total-text">—</span></span></div><div class="imglink-summary-actions"><button class="btn ghost sm il-stats" type="button">📊 Stats</button><button class="btn ghost sm il-compare" type="button">⇄</button></div></div>' +
      '<div class="imglink-variants hidden" role="list">' +
      '<div class="imgvariant" data-kind="full" role="listitem"><span class="iv-name"></span><span class="iv-dims">—</span><span class="iv-size">—</span><span class="iv-metrics"><span class="iv-metric iv-views"><span class="iv-metric-icon" aria-hidden="true">👁</span><span class="iv-metric-text">—</span></span><span class="iv-metric iv-visitors"><span class="iv-metric-icon" aria-hidden="true">👤</span><span class="iv-metric-text">—</span></span></span><span class="iv-actions"><button class="iv-copy" type="button">' + ICONS.link + '</button><button class="iv-bb" type="button">BB</button><button class="iv-img" type="button">' + ICONS.clipboard + '</button><button class="iv-open" type="button">' + ICONS.eye + '</button></span></div>' +
      '<div class="imgvariant" data-kind="thumb" role="listitem"><span class="iv-name"></span><span class="iv-dims">—</span><span class="iv-size">—</span><span class="iv-metrics"><span class="iv-metric iv-views"><span class="iv-metric-icon" aria-hidden="true">👁</span><span class="iv-metric-text">—</span></span><span class="iv-metric iv-visitors"><span class="iv-metric-icon" aria-hidden="true">👤</span><span class="iv-metric-text">—</span></span></span><span class="iv-actions"><button class="iv-copy" type="button">' + ICONS.link + '</button><button class="iv-bb" type="button">BB</button><button class="iv-img" type="button">' + ICONS.clipboard + '</button><button class="iv-open" type="button">' + ICONS.eye + '</button></span></div>' +
      '<div class="imgvariant" data-kind="micro" role="listitem"><span class="iv-name"></span><span class="iv-dims">—</span><span class="iv-size">—</span><span class="iv-metrics"><span class="iv-metric iv-views"><span class="iv-metric-icon" aria-hidden="true">👁</span><span class="iv-metric-text">—</span></span><span class="iv-metric iv-visitors"><span class="iv-metric-icon" aria-hidden="true">👤</span><span class="iv-metric-text">—</span></span></span><span class="iv-actions"><button class="iv-copy" type="button">' + ICONS.link + '</button><button class="iv-bb" type="button">BB</button><button class="iv-img" type="button">' + ICONS.clipboard + '</button><button class="iv-open" type="button">' + ICONS.eye + '</button></span></div>' +
      '</div>' +
      '<div class="imglink-actions hidden">' +
      '<div class="imglink-action-group imglink-manage-group"><span class="imglink-action-label imglink-manage-label"></span><div class="imglink-action-buttons">' +
      '<button class="btn ghost sm il-open" type="button"></button>' +
      '<button class="btn ghost sm il-favorite" type="button">' + ICONS.star + '</button>' +
      '<button class="btn ghost sm il-edit" type="button">' + ICONS.edit + '</button>' +
      '<button class="btn ghost sm il-ocr" type="button">T/OCR</button>' +
      '<button class="btn ghost sm il-qr" type="button">' + ICONS.grid + '</button>' +
      '<button class="btn ghost sm il-qrdl" type="button">⇩QR</button>' +
      '<button class="btn ghost sm il-photo-edit" type="button">🎨</button>' +
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
      // A variant's link can be used (viewed or copied) only once its file is ready and
      // the share is still active; open and copy share the exact same gate.
      var canUse = photo.active !== false && variant.ready !== false && !!imageVariantUrl(photo, kind);
      var openVariant = line.querySelector('.iv-open');
      if (openVariant) {
        openVariant.disabled = !canUse;
        openVariant.title = t('imgOpen') + ' — ' + imageVariantLabel(kind);
        openVariant.setAttribute('aria-label', openVariant.title);
      }
      var copyVariant = line.querySelector('.iv-copy');
      if (copyVariant) {
        copyVariant.disabled = !canUse;
        copyVariant.title = t('copyLink') + ' — ' + imageVariantLabel(kind);
        copyVariant.setAttribute('aria-label', copyVariant.title);
      }
      var bbVariant = line.querySelector('.iv-bb');
      if (bbVariant) {
        bbVariant.disabled = !canUse;
        bbVariant.title = t('imgCopyBBCode') + ' — ' + imageVariantLabel(kind);
        bbVariant.setAttribute('aria-label', bbVariant.title);
      }
      var imgBtn = line.querySelector('.iv-img');
      if (imgBtn) {
        // The clipboard-image API is not universal; hide the button where unsupported.
        imgBtn.classList.toggle('hidden', !(window.ClipboardItem && navigator.clipboard));
        imgBtn.disabled = !canUse;
        imgBtn.title = t('imgCopyImage') + ' — ' + imageVariantLabel(kind);
        imgBtn.setAttribute('aria-label', imgBtn.title);
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
      else if (imageExpiryDeadline(photo) > Date.now() && imageExpiryDeadline(photo) - Date.now() <= 86400000) chip('⏳ ' + t('imgFilterExpiring'), 'warn');
      if (photo.hasPassword) chip('🔒 ' + t('imgProtected'), 'lock');
      if (photo.maxViews) chip(t('imgViewLimit', { n: photo.maxViews }));
      if (photo.hotlinkHosts && photo.hotlinkHosts.length) chip('🔗 ' + t('imgHotlinkProtected'), 'hotlink');
      if (photo.notifyFirstView) chip(photo.firstViewNotifiedAt ? ('✓ ' + t('imgFirstViewSent')) : ('🔔 ' + t('imgFirstViewArmed')), 'first-view');
      if (photo.adaptive && (photo.adaptive.webp || photo.adaptive.avif)) chip('⚡ ' + t('imgAdaptiveReady'), 'adaptive');
      if (photo.metadataRemoved) chip('🛡 ' + t('imgMetadataRemoved'), 'privacy');
      if (photo.versionCount) chip('⏱ ' + photo.versionCount + ' ' + t('imgVersions'), 'versions');
      if (imageExpiryDeadline(photo) && !photo.expired) { var expiryChip = chip(''); expiryChip.setAttribute('data-expiry-countdown', String(imageExpiryDeadline(photo))); }
      (photo.tags || []).forEach(function (tag) { var tagChip = chip('#' + tag, 'tag-chip'); var color = colorForTag(tag); tagChip.style.background = color; tagChip.style.borderColor = color; tagChip.style.color = tagTextColor(color); });
    }
    var note = row.querySelector('.imglink-note');
    if (note) { note.textContent = photo.note || ''; note.classList.toggle('hidden', !photo.note); }
    ['.il-open', '.il-ocr', '.il-qr', '.il-qrdl', '.il-photo-edit', '.il-replace', '.il-versions', '.il-resize-mini', '.il-compare'].forEach(function (selector) {
      var action = row.querySelector(selector); if (action) action.disabled = !photo.active;
    });
  }
  function imageStatsStatusLabel(data) {
    if (data && data.expired) return t('imgStatsExpired');
    return data && data.active !== false ? t('imgStatsActive') : t('imgStatsInactive');
  }
  function imageStatsCountryName(code, fallback) {
    code = String(code || '').toUpperCase();
    if (code && typeof Intl !== 'undefined' && Intl.DisplayNames) {
      try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || fallback || code; } catch (_) {}
    }
    return fallback || code || t('imgStatsUnknown');
  }
  function imageStatsSection(title) {
    var section = document.createElement('section'); section.className = 'image-stats-section';
    var h = document.createElement('h3'); h.textContent = title; section.appendChild(h);
    return section;
  }
  function imageStatsMetric(icon, value, label) {
    var card = document.createElement('div'); card.className = 'image-stats-metric';
    var ico = document.createElement('span'); ico.className = 'image-stats-metric-icon'; ico.setAttribute('aria-hidden', 'true'); ico.textContent = icon;
    var main = document.createElement('div');
    var strong = document.createElement('strong'); strong.textContent = value;
    var small = document.createElement('span'); small.textContent = label;
    main.appendChild(strong); main.appendChild(small); card.appendChild(ico); card.appendChild(main); return card;
  }
  function imageStatsDetail(label, value) {
    var row = document.createElement('div'); row.className = 'image-stats-detail';
    var dt = document.createElement('span'); dt.textContent = label;
    var dd = document.createElement('strong'); dd.textContent = value;
    row.appendChild(dt); row.appendChild(dd); return row;
  }
  function renderImageDetailedStats(data) {
    var body = $('image-stats-body');
    if (!body) return;
    body.innerHTML = '';
    if (!data) { body.textContent = t('imgStatsUnavailable'); return; }
    var totals = data.totals || {};
    var overview = imageStatsSection(t('imgStatsOverview'));
    var metrics = document.createElement('div'); metrics.className = 'image-stats-metrics';
    metrics.appendChild(imageStatsMetric('👁', String(Number(totals.views) || 0), t('imgViews', { n: Number(totals.views) || 0 }).replace(/^\d+\s*/, '')));
    metrics.appendChild(imageStatsMetric('👤', String(Number(totals.visitors) || 0), t('imgVisitors', { n: Number(totals.visitors) || 0 }).replace(/^\d+\s*/, '')));
    metrics.appendChild(imageStatsMetric('🗄', fmtBytes(Number(totals.bytes) || 0), t('imgStatsStorage')));
    metrics.appendChild(imageStatsMetric('↕', fmtBytes(Number(totals.bandwidthBytes) || 0), t('shareStatsBandwidth')));
    overview.appendChild(metrics);
    var details = document.createElement('div'); details.className = 'image-stats-details';
    details.appendChild(imageStatsDetail(t('imgStatsStatus'), imageStatsStatusLabel(data)));
    details.appendChild(imageStatsDetail(t('imgStatsCreated'), data.createdAt ? fmtDate(data.createdAt) : '—'));
    details.appendChild(imageStatsDetail(t('imgStatsExpiry'), data.expiresAt ? fmtDate(data.expiresAt) : t('imgStatsNever')));
    overview.appendChild(details); body.appendChild(overview);

    var copies = imageStatsSection(t('imgStatsCopies'));
    var variantGrid = document.createElement('div'); variantGrid.className = 'image-stats-variants';
    ['full', 'thumb', 'micro'].forEach(function (kind) {
      var variant = data.variants && data.variants[kind] || {};
      var card = document.createElement('div'); card.className = 'image-stats-variant' + (variant.present === false ? ' missing' : '');
      var title = document.createElement('strong'); title.textContent = imageVariantLabel(kind); card.appendChild(title);
      var dims = variant.w && variant.h ? variant.w + '×' + variant.h : '—';
      [
        [t('imgStatsDimensions'), dims],
        [t('imgStatsStorage'), fmtBytes(variant.bytes)],
        [t('imgViews', { n: Number(variant.views) || 0 }), ''],
        [t('imgVisitors', { n: Number(variant.visitors) || 0 }), ''],
        [t('shareStatsBandwidth'), fmtBytes(Number(variant.bandwidthBytes) || 0)],
        [t('shareStatsViewShare'), (Number(variant.viewSharePct) || 0) + '%'],
        [t('imgStatsLastView'), variant.lastAt ? fmtDate(variant.lastAt) : '—']
      ].forEach(function (entry) {
        var line = document.createElement('span');
        line.textContent = entry[1] === '' ? entry[0] : entry[0] + ' : ' + entry[1];
        card.appendChild(line);
      });
      variantGrid.appendChild(card);
    });
    copies.appendChild(variantGrid); body.appendChild(copies);

    var recentSection = imageStatsSection(t('imgStatsRecent'));
    var recent = document.createElement('div'); recent.className = 'image-stats-recent';
    var recentViews = Array.isArray(data.recentViews) ? data.recentViews : [];
    if (!recentViews.length) {
      var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = t('imgStatsNoRecent'); recent.appendChild(empty);
    } else recentViews.forEach(function (event) {
      var row = document.createElement('div'); row.className = 'image-stats-event';
      var icon = document.createElement('span'); icon.className = 'image-stats-event-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = event.kind === 'full' ? '🖼' : event.kind === 'thumb' ? '▣' : '▫';
      var main = document.createElement('div'); main.className = 'image-stats-event-main';
      var title = document.createElement('strong'); title.textContent = imageVariantLabel(event.kind || 'full');
      var meta = document.createElement('span');
      meta.textContent = [event.flag || '🌐', event.ip || '—', imageStatsCountryName(event.countryCode, event.country)].join(' · ');
      main.appendChild(title); main.appendChild(meta);
      var time = document.createElement('time'); time.textContent = event.at ? fmtDate(event.at) : '—';
      row.appendChild(icon); row.appendChild(main); row.appendChild(time); recent.appendChild(row);
    });
    recentSection.appendChild(recent); body.appendChild(recentSection);
  }
  async function openImageDetailedStats(photo) {
    var overlay = $('image-stats-overlay'), body = $('image-stats-body');
    if (!photo || !photo.token || !overlay || !body) return;
    var requestSerial = ++detailedStatsRequestSerial;
    overlay.classList.remove('share-stats-mode');
    $('image-stats-title').textContent = t('imgStatsTitle');
    $('image-stats-subtitle').textContent = photo.name || '';
    body.textContent = t('imgStatsLoading'); body.scrollTop = 0;
    overlay.classList.remove('hidden');
    if ($('image-stats-close')) $('image-stats-close').focus();
    try {
      var response = await fetch('/app/image/' + encodeURIComponent(photo.token) + '/stats-detail', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('http ' + response.status);
      var payload = await response.json();
      if (requestSerial !== detailedStatsRequestSerial || overlay.classList.contains('hidden') || overlay.classList.contains('share-stats-mode')) return;
      renderImageDetailedStats(payload); body.scrollTop = 0;
    } catch (_) { if (requestSerial === detailedStatsRequestSerial && !overlay.classList.contains('hidden') && !overlay.classList.contains('share-stats-mode')) body.textContent = t('imgStatsUnavailable'); }
  }
  function closeImageDetailedStats() { detailedStatsRequestSerial += 1; var overlay = $('image-stats-overlay'); if (overlay) { overlay.classList.add('hidden'); overlay.classList.remove('share-stats-mode'); } }

  function imageDataUrls(data) {
    return {
      token: data.token,
      name: data.name,
      createdAt: data.createdAt || Date.now(),
      expiresAt: data.expiresAt || null,
      effectiveExpiresAt: data.effectiveExpiresAt || data.expiresAt || null,
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
      cacheRevision: Math.max(1, Number(data.cacheRevision) || 1),
      versionCount: Number(data.versionCount) || 0,
      editHistoryCount: Number(data.editHistoryCount) || 0,
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
    if (!variants || !variants.thumb || !variants.micro) return false;
    var jobs = [
      appMutate('/app/image/' + encodeURIComponent(token) + '/thumb', 'image/jpeg', variants.thumb),
      appMutate('/app/image/' + encodeURIComponent(token) + '/micro', 'image/jpeg', variants.micro)
    ];
    if (variants.adaptiveWebp) jobs.push(appMutate('/app/image/' + encodeURIComponent(token) + '/adaptive/webp', 'image/webp', variants.adaptiveWebp));
    if (variants.adaptiveAvif) jobs.push(appMutate('/app/image/' + encodeURIComponent(token) + '/adaptive/avif', 'image/avif', variants.adaptiveAvif));
    var settled = await Promise.allSettled(jobs);
    // fetch() resolves even for HTTP 4xx/5xx. Mini + Micro are required; adaptive
    // formats remain best-effort and must not turn a valid full image into failure.
    return settled.slice(0, 2).every(function (result) {
      return result.status === 'fulfilled' && result.value && result.value.ok;
    });
  }
  function applyUpdatedImageRecord(updated) {
    if (!updated || !updated.token) return null;
    updated = imageDataUrls(updated);
    imageRecordsByToken.set(updated.token, updated);
    persistImageRecord(updated);
    var linked = imageLinkUrls.find(function (entry) { return entry.token === updated.token; });
    if (linked) Object.assign(linked, { imgUrl: updated.imgUrl, thumbUrl: updated.thumbUrl, microUrl: updated.microUrl, name: updated.name });
    var row = imageRowsByToken.get(updated.token);
    if (row) {
      row.dataset.imgUrl = updated.imgUrl || '';
      var preview = imageCardPreviewUrl(updated);
      var thumb = row.querySelector('.imglink-thumb');
      if (thumb && preview) thumb.src = preview + (preview.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now();
      var name = row.querySelector('.imglink-name'); if (name) name.textContent = updated.name;
      renderImageVariantStats(row, updated); restoreImageRowStatus(row, updated);
    }
    refreshCopyAll();
    return updated;
  }
  async function commitImageReplacement(photo, prepared, metadataRemoved, operations) {
    var variants = null; try { variants = await makeImageVariants(prepared.blob, photo && photo.variants); } catch (_) {}
    var replaceUrl = '/app/image/' + encodeURIComponent(photo.token) + '/replace?name=' + encodeURIComponent(prepared.name);
    if (metadataRemoved || prepared.metadataStripped) replaceUrl += '&metadataRemoved=1';
    var ops = Array.isArray(operations) ? operations.filter(Boolean).slice(0,30) : [];
    if (ops.length) replaceUrl += '&ops=' + encodeURIComponent(ops.join(','));
    var response = await imageDlpMutate(replaceUrl, prepared.type, prepared.blob);
    if (!response) return null;
    if (!response.ok) {
      var replaceErr = null; try { replaceErr = await response.clone().json(); } catch (_) {}
      var replaceFailure = new Error('http ' + response.status);
      if (replaceErr && replaceErr.error === 'dlp-blocked') replaceFailure.dxReason = t('sharesDlpBlocked');
      else if (replaceErr && replaceErr.error === 'dlp-quarantined') replaceFailure.dxReason = t('dlpServerQuarantined');
      else if (replaceErr && replaceErr.error === 'dlp-quarantine-failed') replaceFailure.dxReason = t('dlpQuarantineFailed');
      throw replaceFailure;
    }
    var responseData = await response.json();
    var variantsOk = await uploadGeneratedImageVariants(photo.token, variants);
    var fresh = await fetch('/app/image/' + encodeURIComponent(photo.token) + '/stats', { credentials: 'same-origin', cache: 'no-store' });
    var updated = fresh.ok ? await fresh.json() : responseData.image;
    return { updated: applyUpdatedImageRecord(updated), variantsOk: variantsOk };
  }
  async function editUploadedImage(photo) {
    photo = photo && (imageRecordsByToken.get(photo.token) || photo);
    if (!photo || photo.active === false) { toast(t('imgInactive'), 'warn'); return; }
    try {
      var sourceUrl = photo.previewUrls && photo.previewUrls.full || ('/app/image/' + encodeURIComponent(photo.token) + '/preview/full');
      var sourceResponse = await fetch(sourceUrl, { credentials: 'same-origin', cache: 'no-store' });
      if (!sourceResponse.ok) throw new Error('http ' + sourceResponse.status);
      var sourceBlob = await sourceResponse.blob();
      var sourceFile = namedFile(sourceBlob, photo.name || ('image-' + Date.now()), sourceBlob.type || 'image/jpeg', Date.now());
      var edited = await openImageLinkEditor(sourceFile);
      // Cancel/Escape returns the exact source object. No server mutation or new
      // version is created until the user explicitly applies an edit.
      if (!edited || edited === sourceFile) return;
      var result = await commitImageReplacement(photo, { blob: edited, name: edited.name, type: edited.type || 'image/jpeg', metadataStripped: true }, true, edited.dxEditOperations || ['photo-editor']);
      if (!result) return;
      recordImageAction('edited', result.updated || photo, 'photo-editor');
      toast(t(result.variantsOk ? 'imgEditUploadedDone' : 'imgVariantsFailed'), result.variantsOk ? 'ok' : 'warn');
    } catch (e) { toast(e && e.dxReason ? e.dxReason : t('imgLinkFail'), 'err'); }
  }
  async function replaceImageKeepingUrl(photo) {
    if (!photo || !askConfirmation('replace', t('imgReplace') + ' ?')) return;
    var input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
    input.onchange = async function () {
      var file = input.files && input.files[0]; if (!file) return;
      try {
        var prepared = await prepareImageForLink(file, !!($('imglink-strip-exif') && $('imglink-strip-exif').checked));
        var result = await commitImageReplacement(photo, prepared, prepared.metadataStripped, ['replace']);
        if (!result) return;
        recordImageAction('edited', result.updated || photo, 'replace');
        toast(t(result.variantsOk ? 'imgReplaceDone' : 'imgVariantsFailed'), result.variantsOk ? 'ok' : 'warn');
      } catch (e) { toast(e && e.dxReason ? e.dxReason : t('imgLinkFail'), 'err'); }
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
        appMutate('/app/image/' + encodeURIComponent(photo.token) + '/thumb', 'image/jpeg', thumbBlob),
        appMutate('/app/image/' + encodeURIComponent(photo.token) + '/micro', 'image/jpeg', microBlob)
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
    var payload = await r.json(), versions = payload.versions || [], history = payload.history || [];
    if (!versions.length) { toast(t('imgVersions') + ': 0', 'warn'); return; }
    var old = document.getElementById('pwa-version-overlay'); if (old) old.remove();
    var overlay=document.createElement('div'); overlay.id='pwa-version-overlay'; overlay.className='pair-overlay pwa-version-overlay';
    var dialog=document.createElement('div'); dialog.className='pair-dialog pwa-version-dialog'; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
    var head=document.createElement('div'); head.className='pwa-version-head'; var title=document.createElement('h3'); title.textContent=t('imgVersions')+' — '+(photo.name||''); var close=document.createElement('button');close.type='button';close.className='btn ghost';close.textContent='✕';close.title=t('imgClose');head.append(title,close);dialog.appendChild(head);
    var compare=document.createElement('div');compare.className='pwa-version-compare hidden';compare.innerHTML='<div class="pwa-version-compare-stage"><img class="pwa-version-current" alt=""><div class="pwa-version-before-wrap"><img class="pwa-version-before" alt=""></div><input class="pwa-version-slider" type="range" min="0" max="100" value="50" aria-label="'+t('imgCompareBeforeAfter')+'"></div>';
    dialog.appendChild(compare);
    var list=document.createElement('div');list.className='pwa-version-list';
    async function restore(v){ if(!window.confirm(t('imgRestoreConfirm')))return; var rr=await imageJsonMutation('/app/image/'+encodeURIComponent(photo.token)+'/restore/'+encodeURIComponent(v.id),{}); if(!rr.ok){toast(t('revokeFail'),'err');return;} var updated=applyUpdatedImageRecord((await rr.json()).image); toast(t('imgVersionRestored'),'ok'); overlay.remove(); if(updated)manageImageVersions(updated); }
    function showCompare(v){var current=compare.querySelector('.pwa-version-current'),before=compare.querySelector('.pwa-version-before'),wrap=compare.querySelector('.pwa-version-before-wrap'),slider=compare.querySelector('.pwa-version-slider');current.src=(photo.previewUrls&&photo.previewUrls.full)||('/app/image/'+encodeURIComponent(photo.token)+'/preview/full');before.src='/app/image/'+encodeURIComponent(photo.token)+'/versions/'+encodeURIComponent(v.id)+'/preview';compare.classList.remove('hidden');var apply=function(){wrap.style.width=slider.value+'%';};slider.oninput=apply;apply();compare.scrollIntoView({behavior:'smooth',block:'nearest'});}
    versions.forEach(function(v,i){var row=document.createElement('div');row.className='pwa-version-row';var meta=document.createElement('div');var strong=document.createElement('strong');strong.textContent=(v.original?t('imgOriginal')+' · ':'')+new Date(v.at).toLocaleString();var sub=document.createElement('span');sub.textContent=[v.w&&v.h?v.w+'×'+v.h:'',fmtBytes(v.size||0),(v.operations||[]).join(', ')].filter(Boolean).join(' · ');meta.append(strong,sub);var actions=document.createElement('div');var cmp=document.createElement('button');cmp.type='button';cmp.className='btn ghost sm';cmp.textContent=t('imgCompareBeforeAfter');cmp.onclick=function(){showCompare(v);};var rst=document.createElement('button');rst.type='button';rst.className='btn ghost sm';rst.textContent=v.original?t('imgRestoreOriginal'):t('imgRestoreVersion');rst.onclick=function(){restore(v);};actions.append(cmp,rst);row.append(meta,actions);list.appendChild(row);});
    dialog.appendChild(list);
    if(history.length){var hs=document.createElement('section');hs.className='pwa-version-history';var ht=document.createElement('h4');ht.textContent=t('imgVersionHistory');hs.appendChild(ht);history.slice(0,30).forEach(function(h){var line=document.createElement('div');line.textContent=new Date(h.at).toLocaleString()+' · '+(h.action||'edit')+(h.operations&&h.operations.length?' · '+h.operations.join(', '):'');hs.appendChild(line);});dialog.appendChild(hs);}
    overlay.appendChild(dialog);document.body.appendChild(overlay);close.onclick=function(){overlay.remove();};overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove();});
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

    var bo = row.querySelector('.il-open'), fav = row.querySelector('.il-favorite'), edit = row.querySelector('.il-edit'), ocrBtn = row.querySelector('.il-ocr'), bq = row.querySelector('.il-qr'), qrdl = row.querySelector('.il-qrdl'), photoEditBtn = row.querySelector('.il-photo-edit'), replaceBtn = row.querySelector('.il-replace'), versionsBtn = row.querySelector('.il-versions'), resizeMiniBtn = row.querySelector('.il-resize-mini'), more = row.querySelector('.il-more');
    var manageLabel = row.querySelector('.imglink-manage-label');
    if (manageLabel) manageLabel.textContent = t('imgManageActions');
    bo.innerHTML = ICONS.eye; bo.title = t('imgOpen') + ' — ' + t('imgVariantAuto'); bo.setAttribute('aria-label', bo.title);
    bq.title = t('qrForLink'); bq.setAttribute('aria-label', t('qrForLink'));
    qrdl.title = t('imgQrDownloaded'); qrdl.setAttribute('aria-label', t('imgQrDownloaded'));
    photoEditBtn.title = t('imgEditUploaded'); photoEditBtn.setAttribute('aria-label', t('imgEditUploaded'));
    replaceBtn.title = t('imgReplace'); replaceBtn.setAttribute('aria-label', t('imgReplace'));
    versionsBtn.title = t('imgVersions'); versionsBtn.setAttribute('aria-label', t('imgVersions'));
    resizeMiniBtn.title = t('imgResizeMini'); resizeMiniBtn.setAttribute('aria-label', t('imgResizeMini'));
    var statsBtn = row.querySelector('.il-stats');
    if (statsBtn) {
      statsBtn.textContent = t('imgStatsButton'); statsBtn.title = t('imgStatsTitle'); statsBtn.setAttribute('aria-label', statsBtn.title);
      statsBtn.addEventListener('click', function () { openImageDetailedStats(imageRecordsByToken.get(data.token) || data); });
    }
    var cmp = row.querySelector('.il-compare');
    if (cmp) {
      cmp.textContent = '⇄ ' + t('imgCompare'); cmp.title = t('imgCompareTitle'); cmp.setAttribute('aria-label', cmp.title);
      cmp.addEventListener('click', function () { openVariantCompare(imageRecordsByToken.get(data.token) || data); });
    }
    function copyOne(kind) { return function () { var photo = imageRecordsByToken.get(data.token) || data; var url = imageVariantUrl(photo, kind); copyText(formatLink(url, photo.name, photo, kind)).then(function () { recordImageAction('copied', photo, kind); toast(t('imgCopied'), 'ok'); }); }; }
    // Always copy forum-friendly BBCode for this exact variant, regardless of the
    // selected copy format/template. Mini/Micro are clickable thumbnails that open
    // the Full image, matching the standard Direct-Xfer interface.
    function copyBB(kind) { return function () { var photo = imageRecordsByToken.get(data.token) || data; var url = imageVariantUrl(photo, kind); copyText(imageVariantBBCode(photo, kind, url)).then(function () { recordImageAction('copied', photo, kind); toast(t('imgCopied'), 'ok'); }); }; }
    // Copy this variant's actual pixels to the clipboard (paste an image into chat/docs).
    function copyImageBitmap(kind) { return function () { var photo = imageRecordsByToken.get(data.token) || data; var url = imagePreviewUrl(photo, kind); if (!url) return; copyImageToClipboard(url).then(function () { recordImageAction('copied', photo, kind); toast(t('imgCopied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); }); }; }
    row.querySelectorAll('.imgvariant').forEach(function (line) {
      var kind = line.dataset.kind;
      var openVariant = line.querySelector('.iv-open');
      if (openVariant) openVariant.addEventListener('click', function () {
        var photo = imageRecordsByToken.get(data.token) || data;
        var url = imagePreviewUrl(photo, kind);
        if (!url || photo.active === false) return;
        recordImageAction('opened', photo, kind);
        openImageUrlPreview(url, photo.name);
      });
      // Copy this exact variant's link, reusing the same copy behaviour (formatLink +
      // "copied" action + toast) as the grouped copy buttons below.
      var copyVariant = line.querySelector('.iv-copy');
      if (copyVariant) copyVariant.addEventListener('click', copyOne(kind));
      // Copy this variant as BBCode, forced regardless of the selected copy format.
      var bbVariant = line.querySelector('.iv-bb');
      if (bbVariant) bbVariant.addEventListener('click', copyBB(kind));
      // Copy this variant's pixels to the clipboard as a bitmap.
      var imgBtn = line.querySelector('.iv-img');
      if (imgBtn) imgBtn.addEventListener('click', copyImageBitmap(kind));
    });
    bo.addEventListener('click', function () { var photo = imageRecordsByToken.get(data.token) || data; var url = imagePreviewUrl(photo, 'auto'); if (!url) return; recordImageAction('opened', photo, 'auto'); openImageUrlPreview(url, photo.name); });
    fav.addEventListener('click', async function () {
      var photo = imageRecordsByToken.get(data.token) || data; var enabled = !photo.favorite;
      var r = await imageJsonMutation('/app/image/' + encodeURIComponent(photo.token) + '/settings', { favorite: enabled });
      if (r.ok) { var updated = (await r.json()).image; imageRecordsByToken.set(photo.token, imageDataUrls(updated)); persistImageRecord(imageRecordsByToken.get(photo.token)); fav.classList.toggle('active', enabled); row.classList.toggle('pinned', enabled); fav.title = enabled ? t('unpinItem') : t('pinItem'); fav.setAttribute('aria-label', fav.title); recordImageAction('edited', updated, enabled ? 'favorite' : 'unfavorite'); applyImageView(); }
    });
    edit.addEventListener('click', function () { editOneImage(imageRecordsByToken.get(data.token) || data); });
    if (ocrBtn) {
      ocrBtn.title = t('ocrAction'); ocrBtn.setAttribute('aria-label', t('ocrAction'));
      ocrBtn.addEventListener('click', function () { openImageRecordOcr(imageRecordsByToken.get(data.token) || data); });
    }
    bq.addEventListener('click', function () { var photo = imageRecordsByToken.get(data.token) || data; showQrOverlay(imageVariantUrl(photo, IMAGE_PRIMARY_VARIANT), photo.name); });
    qrdl.addEventListener('click', function () { downloadImageQr(imageRecordsByToken.get(data.token) || data); });
    photoEditBtn.addEventListener('click', async function () {
      if (photoEditBtn.disabled) return;
      photoEditBtn.disabled = true;
      try { await editUploadedImage(imageRecordsByToken.get(data.token) || data); }
      finally { var current = imageRecordsByToken.get(data.token) || data; photoEditBtn.disabled = current.active === false; }
    });
    replaceBtn.addEventListener('click', function () { replaceImageKeepingUrl(imageRecordsByToken.get(data.token) || data); });
    versionsBtn.addEventListener('click', function () { manageImageVersions(imageRecordsByToken.get(data.token) || data); });
    resizeMiniBtn.addEventListener('click', function () { resizeImageMini(imageRecordsByToken.get(data.token) || data); });
    row.querySelector('.imglink-actions').classList.remove('hidden');
    restoreImageRowStatus(row, data);
    fav.classList.toggle('active', !!data.favorite); row.classList.toggle('pinned', !!data.favorite); fav.title = data.favorite ? t('unpinItem') : t('pinItem'); fav.setAttribute('aria-label', fav.title);
    if (more) more.addEventListener('click', function () { row.classList.toggle('show-all-actions'); more.setAttribute('aria-expanded', row.classList.contains('show-all-actions') ? 'true' : 'false'); });
    arrangeImageActions(row); updateExpiryCountdowns(); renderTagColorManager();
    if (trackForCopyAll !== false && !imageLinkUrls.some(function (o) { return o.token === data.token; })) imageLinkUrls.push({ token: data.token, imgUrl: data.imgUrl, thumbUrl: data.thumbUrl, microUrl: data.microUrl, name: data.name });
    persistImageRecord(data);
    refreshCopyAll(); applyImageView();
  }
  async function refreshImageStats(loadMissing) {
    // Never let the lightweight 3-second poll abort a full paginated inventory
    // restore on a large library. This previously made libraries >500 entries
    // repeatedly restart page 1 on slower phones/proxies.
    if (!loadMissing && imageFullRefreshInFlight) return;
    if (loadMissing) imageFullRefreshInFlight = true;
    var generation = ++imageRefreshGeneration;
    if (imageStatsAbortController && typeof imageStatsAbortController.abort === 'function') {
      try { imageStatsAbortController.abort(); } catch (_) {}
    }
    imageStatsAbortController = window.AbortController ? new AbortController() : null;
    try {
      var requestOptions = { credentials: 'same-origin', cache: 'no-store' };
      if (imageStatsAbortController) requestOptions.signal = imageStatsAbortController.signal;
      var r = await fetchWithTimeout('/app/images?limit=500&offset=0&includeInactive=1', requestOptions, 15000);
      if (!r.ok) throw new Error('http ' + r.status);
      var payload = await r.json();
      if (generation !== imageRefreshGeneration) return;
      var rawImages = payload && Array.isArray(payload.images) ? payload.images.slice() : [];
      var inventoryComplete = !(payload && payload.hasMore);
      // A first/full refresh paginates the inventory so a new device can restore
      // libraries larger than 500 images. The 3-second poll intentionally stays on
      // page 1: it sees every newly-created image without hammering the server with
      // hundreds of follow-up /stats requests for older records.
      if (loadMissing && payload && payload.hasMore) {
        var nextOffset = Math.max(0, Number(payload.offset) || 0) + rawImages.length;
        var pages = 1;
        while (payload.hasMore && pages < 20) {
          var pageResponse = await fetchWithTimeout('/app/images?limit=500&offset=' + encodeURIComponent(nextOffset) + '&includeInactive=1', requestOptions, 15000);
          if (!pageResponse.ok) { inventoryComplete = false; break; }
          payload = await pageResponse.json();
          if (generation !== imageRefreshGeneration) return;
          var pageImages = payload && Array.isArray(payload.images) ? payload.images : [];
          rawImages = rawImages.concat(pageImages);
          nextOffset = Math.max(nextOffset, Number(payload.offset) || nextOffset) + pageImages.length;
          pages += 1;
          if (!payload.hasMore) { inventoryComplete = true; break; }
          if (!pageImages.length) { inventoryComplete = false; break; }
        }
        if (payload && payload.hasMore) inventoryComplete = false;
      }
      var now = Date.now();
      var photos = rawImages.map(function (entry) {
        var existing = entry && entry.token ? imageRecordsByToken.get(entry.token) : null;
        entry = imageDataUrls(entry);
        entry.localCommittedAt = existing && existing.localCommittedAt || 0;
        entry.lastServerConfirmedAt = now;
        return entry;
      });
      var known = new Set(photos.map(function (photo) { return photo.token; }));

      // Missing records are meaningful only after a COMPLETE inventory. A truncated
      // page-1 poll must never turn the 501st cached image into a deletion candidate.
      var missing = inventoryComplete ? Array.from(imageRecordsByToken.values()).filter(function (photo) {
        return photo && photo.token && !known.has(photo.token) && !pendingImageRevokes.has(photo.token);
      }) : [];
      if (missing.length) {
        var recovered = await Promise.all(missing.map(async function (cached) {
          try {
            var fresh = await fetchWithTimeout('/app/image/' + encodeURIComponent(cached.token) + '/stats', {
              credentials: 'same-origin', cache: 'no-store',
              signal: imageStatsAbortController ? imageStatsAbortController.signal : undefined,
            }, 10000);
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
        if (!row) {
          row = imgLinkRow(photo.name || 'image', imageCardPreviewUrl(photo), false);
          activateImageLinkRow(row, photo, photo.name || 'image', false, false);
        } else if (row) {
          row.querySelector('.imglink-name').textContent = photo.name || 'image';
          renderImageVariantStats(row, photo);
          var fav = row.querySelector('.il-favorite'); if (fav) { fav.classList.toggle('active', !!photo.favorite); fav.title = photo.favorite ? t('unpinItem') : t('pinItem'); fav.setAttribute('aria-label', fav.title); } row.classList.toggle('pinned', !!photo.favorite);
          if (!pendingImageRevokes.has(photo.token)) restoreImageRowStatus(row, photo);
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
      if (loadMissing) imageFullRefreshInFlight = false;
      if (generation === imageRefreshGeneration) imageStatsAbortController = null;
    }
  }
  function startImageStatsPolling() {
    if (imageStatsTimer) clearInterval(imageStatsTimer);
    imageStatsTimer = setInterval(function () { if (!document.hidden) refreshImageStats(false); }, 3000);
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
      var workingFile = file;
      var smartBlurRemovedMetadata = false;
      if (options.smartBlurMode && options.smartBlurMode !== 'off') {
        st.textContent = t('imgSmartBlurAnalyzing');
        var reviewedFile = await openSmartBlurReview(file, options.smartBlurMode);
        // Skip/cancel resolves with the exact original File. Only an applied canvas
        // result has actually removed metadata and changed the bytes to deduplicate.
        if (reviewedFile) { workingFile = reviewedFile; smartBlurRemovedMetadata = reviewedFile !== file; }
      }
      var prepared = await prepareImageForLink(workingFile, stripMetadata);
      // Hash the final privacy-reviewed payload source, not the pre-redaction photo.
      // Otherwise an unredacted original (or a different redaction of it) is falsely
      // reported as a duplicate of the already-censored image.
      try { clientHash = await sha256Blob(workingFile); } catch (_) {}
      var duplicate = await imageDuplicate(clientHash);
      if (duplicate && !askConfirmation('replace', t('imgDuplicateFound'))) { if (row.parentNode) row.parentNode.removeChild(row); return null; }
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
      var r = await imageDlpMutate(uploadUrl, prepared.type, prepared.blob);
      if (!r) { if (row.parentNode) row.parentNode.removeChild(row); return null; }
      if (!r.ok) {
        var uploadErr = null; try { uploadErr = await r.clone().json(); } catch (_) {}
        var uploadFailure = new Error('http ' + r.status);
        if (uploadErr && uploadErr.error === 'dlp-blocked') uploadFailure.dxReason = t('sharesDlpBlocked');
        else if (uploadErr && uploadErr.error === 'dlp-quarantined') uploadFailure.dxReason = t('dlpServerQuarantined');
        else if (uploadErr && uploadErr.error === 'dlp-quarantine-failed') uploadFailure.dxReason = t('dlpQuarantineFailed');
        throw uploadFailure;
      }
      var data = await r.json();
      if (!data || !data.token) throw new Error('no-token');
      st.textContent = t('imgThumbing');
      var variantsOk = false;
      try { variantsOk = await uploadGeneratedImageVariants(data.token, variants); } catch (_) { variantsOk = false; }
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
        await copyText(formatLink(imageVariantUrl(photo, IMAGE_PRIMARY_VARIANT), photo.name, photo, IMAGE_PRIMARY_VARIANT));
        toast(t('imgCopied'), 'ok'); recordImageAction('copied', photo, IMAGE_PRIMARY_VARIANT);
      }
      if (!variantsOk) toast(t('imgVariantsFailed'), 'warn');
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
  function escapeMarkdownLabel(value) { return String(value || '').replace(/\\/g, '\\\\').replace(/\]/g, '\\]'); }
  function imageVariantBBCode(photo, kind, url) {
    var variantUrl = url || imageVariantUrl(photo || {}, kind);
    var fullUrl = photo && photo.imgUrl ? photo.imgUrl : variantUrl;
    if ((kind === 'thumb' || kind === 'micro') && fullUrl && variantUrl) {
      return '[url=' + fullUrl + '][img]' + variantUrl + '[/img][/url]';
    }
    return '[img]' + variantUrl + '[/img]';
  }
  function formatLink(url, name, photo, kind) {
    var fmt = $('img-format') ? $('img-format').value : 'url';
    var template = $('img-copy-template') ? $('img-copy-template').value : 'standard';
    var alt = (name || 'image').replace(/\.[^.]+$/, '');
    var full = photo && photo.imgUrl ? photo.imgUrl : url;
    if (template === 'discord') return url;
    if (template === 'reddit') return '[' + escapeMarkdownLabel(alt) + '](' + url + ')';
    if (template === 'forum') return '[url=' + full + '][img]' + url + '[/img][/url]';
    if (template === 'email') return '<a href="' + full + '"><img src="' + url + '" alt="' + escapeMarkup(alt) + '"></a>';
    if (fmt === 'md') return '![' + escapeMarkdownLabel(alt) + '](' + url + ')';
    if (fmt === 'html') return '<img src="' + url + '" alt="' + escapeMarkup(alt) + '">';
    if (fmt === 'bb') return imageVariantBBCode(photo, kind, url);
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
    var kind = IMAGE_PRIMARY_VARIANT;
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
  async function editImageBeforeLink(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    var file = files.find(function (candidate) { return candidate && (/^image\//.test(candidate.type || '') || /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i.test(candidate.name || '')); });
    if (!file) return;
    var edited = await openImageLinkEditor(file);
    // Cancel, Escape and tapping outside the dialog all return the original object.
    if (!edited || edited === file) return;
    var stripMetadata = !!($('imglink-strip-exif') && $('imglink-strip-exif').checked);
    var options = imageOptionsFromUi();
    // The manual editor already presented every privacy tool. Do not immediately
    // reopen it because the optional smart-blur preference is enabled.
    options.smartBlurMode = 'off';
    persistImagePreferences();
    await createOneImageLink(edited, stripMetadata, imageRename(edited.name || ('image-' + Date.now() + '.jpg'), 0), options);
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
  var longOperationToken = 0, longOperations = new Map();
  function renderLongOperation() {
    var box=$('long-operation'), label=$('long-operation-label'), detail=$('long-operation-detail'), progress=$('long-operation-progress');
    if (!box) return;
    if (!longOperations.size) { box.classList.add('hidden'); return; }
    var rec=null; longOperations.forEach(function (candidate) { if (!rec || Number(candidate.updatedAt||0) >= Number(rec.updatedAt||0)) rec=candidate; });
    box.classList.remove('hidden');
    if (label) label.textContent=rec.label||t('longOpWorking');
    if (detail) detail.textContent=rec.detail||'';
    if (progress) {
      if (Number.isFinite(Number(rec.percent))) progress.value=Math.max(0,Math.min(100,Number(rec.percent)));
      else { progress.value=0; progress.removeAttribute('value'); }
    }
  }
  function beginLongOperation(label, detail) {
    var token=++longOperationToken, rec={token:token,label:label||t('longOpWorking'),detail:detail||'',percent:null,updatedAt:Date.now(),timer:null};
    rec.timer=setTimeout(function(){endLongOperation(token);},10*60*1000);
    longOperations.set(token,rec); renderLongOperation(); return token;
  }
  function updateLongOperation(token, percent, detail) {
    var rec=longOperations.get(token); if(!rec)return;
    if(Number.isFinite(Number(percent)))rec.percent=Math.max(0,Math.min(100,Number(percent)));
    if(detail!=null)rec.detail=String(detail); rec.updatedAt=Date.now(); renderLongOperation();
  }
  function endLongOperation(token) {
    var rec=longOperations.get(token); if(!rec)return; clearTimeout(rec.timer); longOperations.delete(token); renderLongOperation();
  }
  async function prepareUpload(it) {
    var longOp = beginLongOperation(t('longOpPrepare'), it && it.name || '');
    try {
      if (it.preparedBlob && it.upName && it.upSize != null) {
        it.backgroundReady = !!($('auto-resume') && $('auto-resume').checked && preparedPayloadIsDurable(it));
        return;
      }
      var source = await optimizeImage(it);
      if (!it.snapshot.enc) {
        it.preparedBlob = source;
        it.upName = it.name;
        it.upSize = source.size;
        it.preparedEncrypted = false;
        it.state = 'waiting';
        await ensurePreparedDurable(it);
        it.backgroundReady = !!($('auto-resume') && $('auto-resume').checked && preparedPayloadIsDurable(it));
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
          updateItemUi(it, t('encrypting') + ' ' + Math.round(it.prepareProgress * 100) + '%'); updateLongOperation(longOp, Math.round(it.prepareProgress * 100), it.name || '');
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
      it.backgroundReady = !!($('auto-resume') && $('auto-resume').checked && preparedPayloadIsDurable(it));
    } finally { endLongOperation(longOp); }
  }

  function persistErrorLog() {
    try { localStorage.setItem('dx-pwa-error-log', JSON.stringify(recentErrors.slice(-30))); } catch (_) {}
  }
  function networkConnectionSnapshot() {
    var c = connectionInfo();
    return {
      online: navigator.onLine !== false,
      type: c && c.type ? String(c.type) : '',
      effectiveType: c && c.effectiveType ? String(c.effectiveType) : '',
      downlink: c && isFinite(Number(c.downlink)) ? Number(c.downlink) : null,
      rtt: c && isFinite(Number(c.rtt)) ? Number(c.rtt) : null,
      saveData: !!(c && c.saveData)
    };
  }
  function persistNetworkErrorHistory() {
    try { localStorage.setItem('dx-pwa-network-errors-v1', JSON.stringify(networkErrorHistory.slice(-100))); } catch (_) {}
  }
  function recordNetworkIncident(it, detail) {
    detail = detail || {};
    var rec = {
      id: genId(12), itemId: it && it.id || '', name: it && it.name || '', at: Date.now(),
      code: detail.code || 'network', badge: detail.badge || '', hint: detail.hint || '',
      attempt: Math.max(1, Number(detail.attempt) || 1), offset: Math.max(0, Number(it && it.sentBytes) || 0),
      total: Math.max(0, Number(it && (it.upSize || it.size)) || 0), connection: networkConnectionSnapshot()
    };
    networkErrorHistory.push(rec); networkErrorHistory = networkErrorHistory.slice(-100); persistNetworkErrorHistory();
    try { window.dispatchEvent(new CustomEvent('dx-network-incident', { detail: rec })); } catch (_) {}
    return rec;
  }
  function errorCategory(code, badge, hint) {
    var text = [code, badge, hint].join(' ').toLowerCase();
    if (/413|proxy|gateway|502|503|504|post.*block|body.size|buffer/.test(text)) return 'proxy';
    if (/quota|max-files|storage|disk|space|opfs|indexeddb/.test(text)) return 'quota';
    if (/network|connect|timeout|offline|wifi|net.cut|refused|429|rate/.test(text)) return 'network';
    if (/401|403|locked|revoked|auth|permission|csrf|origin/.test(text)) return 'auth';
    if (/file-too-large|too-large|ext-|infected|read|prepare|nocrypto|nokey|nopass/.test(text)) return 'file';
    if (/500|server|write-error|inbox-dir|busy|offset/.test(text)) return 'server';
    return 'other';
  }
  function errorCategoryLabel(category) {
    return t({ proxy: 'errorCategoryProxy', quota: 'errorCategoryQuota', network: 'errorCategoryNetwork', server: 'errorCategoryServer', auth: 'errorCategoryAuth', file: 'errorCategoryFile', other: 'errorCategoryOther' }[category] || 'errorCategoryOther');
  }
  function recordTransferError(it, detail) {
    detail = detail || {};
    var rec = {
      id: genId(12), itemId: it && it.id || '', name: it && it.name || detail.name || '',
      code: detail.code || (it && it.errorCode) || '', badge: detail.badge || (it && it.lastFail) || '',
      hint: detail.hint || (it && it.lastHint) || reasonText(detail.code || (it && it.errorCode) || '') || '', at: Date.now()
    };
    rec.category = errorCategory(rec.code, rec.badge, rec.hint);
    recentErrors.push(rec); recentErrors = recentErrors.slice(-30); persistErrorLog();
    lastDiag = { name: rec.name, badge: rec.badge, hint: rec.hint, code: rec.code, at: rec.at };
    renderErrorCenter();
    return rec;
  }
  function clearErrorLog() { recentErrors = []; lastDiag = null; persistErrorLog(); renderErrorCenter(); if ($('diag-status')) $('diag-status').textContent = t('diagNone'); toast(t('errorLogCleared'), 'ok'); }
  function currentErrorRecords() {
    var records = recentErrors.slice().reverse(), seen = new Set(records.map(function (r) { return r.itemId; }).filter(Boolean));
    items.filter(function (it) { return it.state === 'error' && !seen.has(it.id); }).forEach(function (it) {
      records.unshift({ id: 'live-' + it.id, itemId: it.id, name: it.name, code: it.errorCode || '', badge: it.lastFail || '', hint: it.lastHint || reasonText(it.errorCode), category: errorCategory(it.errorCode, it.lastFail, it.lastHint), at: Date.now() });
    });
    return records.slice(0, 20);
  }
  function renderErrorCenter() {
    var center = $('error-center'), list = $('error-center-list'), count = $('error-center-count');
    if (!center || !list) return;
    var records = currentErrorRecords();
    center.classList.toggle('hidden', !records.length);
    if (count) count.textContent = String(records.length);
    list.innerHTML = '';
    if (!records.length) { var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = t('errorCenterEmpty'); list.appendChild(empty); return; }
    records.forEach(function (rec, recIndex) {
      var row = document.createElement('div'); row.className = 'error-center-row';
      var icon = document.createElement('span'); icon.className = 'error-center-icon'; icon.textContent = rec.category === 'proxy' ? '🧱' : rec.category === 'quota' ? '💾' : rec.category === 'network' ? '📡' : rec.category === 'server' ? '🖥' : rec.category === 'auth' ? '🔐' : rec.category === 'file' ? '📄' : '⚠️'; row.appendChild(icon);
      var main = document.createElement('div'); main.className = 'error-center-main';
      var top = document.createElement('div'); top.className = 'error-center-top';
      var cat = document.createElement('strong'); cat.textContent = errorCategoryLabel(rec.category); top.appendChild(cat);
      var when = document.createElement('span'); when.className = 'muted sm'; when.textContent = fmtDate(rec.at); top.appendChild(when); main.appendChild(top);
      if (rec.name) { var name = document.createElement('div'); name.className = 'error-center-name'; name.textContent = privacyNames ? t('privacyFile', { n: recIndex + 1 }) : rec.name; main.appendChild(name); }
      var hint = document.createElement('div'); hint.className = 'muted sm'; hint.textContent = [rec.badge, rec.hint].filter(Boolean).join(' — ') || t('error'); main.appendChild(hint); row.appendChild(main);
      var item = rec.itemId ? items.find(function (it) { return it.id === rec.itemId && it.state === 'error'; }) : null;
      if (item) { var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn ghost sm error-retry'; retry.textContent = t('errorCenterRetry'); retry.addEventListener('click', function () { retryItem(item); }); row.appendChild(retry); }
      list.appendChild(row);
    });
  }
  function errorReportText() {
    var records = currentErrorRecords();
    var lines = ['Direct-Xfer PWA · ' + APP_BUILD, 'online: ' + navigator.onLine, 'errors: ' + records.length];
    if (lastNetworkTest) lines.push('network: ' + Math.round(lastNetworkTest.latency || 0) + ' ms · up ' + fmtBytes(lastNetworkTest.uploadBps || 0) + '/s · down ' + fmtBytes(lastNetworkTest.downloadBps || 0) + '/s');
    records.forEach(function (r, index) {
      var reportName = privacyNames && r.name ? t('privacyFile', { n: index + 1 }) : (r.name || '-');
      lines.push('[' + errorCategoryLabel(r.category) + '] ' + fmtDate(r.at) + ' · ' + reportName + ' · ' + [r.badge, r.code, r.hint].filter(Boolean).join(' — '));
    });
    return lines.join('\n');
  }
  function copyErrorReport() { copyText(errorReportText()).then(function () { toast(t('errorReportCopied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); }); }

  function networkQuality(result) {
    if (!result) return 'unknown';
    var up = result.uploadBps || 0, latency = result.latency || 9999;
    if (up >= 12 * 1024 * 1024 && latency < 80) return 'excellent';
    if (up >= 3 * 1024 * 1024 && latency < 180) return 'good';
    if (up >= 768 * 1024 && latency < 450) return 'fair';
    return 'poor';
  }
  function networkQualityLabel(q) { return t(q === 'excellent' ? 'networkQualityExcellent' : q === 'good' ? 'networkQualityGood' : q === 'fair' ? 'networkQualityFair' : q === 'poor' ? 'networkQualityPoor' : 'networkNotTested'); }
  function applyNetworkRecommendation(result) {
    if (!result) return;
    var q = networkQuality(result), mobile = isMobileLike();
    if (q === 'poor') { networkRecommendedChunk = MIN_CHUNK; networkRecommendedConcurrency = 1; }
    else if (q === 'fair') { networkRecommendedChunk = mobile ? MOBILE_CHUNK : 1024 * 1024; networkRecommendedConcurrency = 1; }
    else if (q === 'good') { networkRecommendedChunk = mobile ? MOBILE_CHUNK : 2 * 1024 * 1024; networkRecommendedConcurrency = mobile ? 1 : 2; }
    else { networkRecommendedChunk = mobile ? 1536 * 1024 : DESKTOP_CHUNK; networkRecommendedConcurrency = mobile ? 2 : 3; }
  }
  function updateAdaptiveNetwork(rate) {
    rate = Math.max(0, Number(rate) || 0);
    var now = Date.now(), c = connectionInfo();
    var apiSlow = !!(c && (/slow-2g|2g/.test(String(c.effectiveType || '')) || c.saveData));
    var retrySlow = networkRetryCount >= 3 && now - networkLastRetryAt < 15000;
    var rateSlow = rate > 0 && rate < 512 * 1024;
    if (apiSlow || retrySlow || rateSlow) {
      if (!networkSlowSince) networkSlowSince = now;
      networkGoodSince = 0;
      if (apiSlow || retrySlow || now - networkSlowSince >= 7000) {
        networkAdaptiveState = 'slow';
        networkAdaptiveConcurrencyLimit = 1;
        networkRecommendedConcurrency = 1;
        networkRecommendedChunk = Math.min(networkRecommendedChunk || MOBILE_CHUNK, MOBILE_CHUNK);
        batch.forEach(function (it) {
          if (!it) return;
          if (!it.networkAdaptiveCeilBeforeSlow) it.networkAdaptiveCeilBeforeSlow = Math.max(MIN_CHUNK, it.chunkCeil || initialChunkSize());
          it.chunkCeil = Math.min(Math.max(MIN_CHUNK, it.chunkCeil || MOBILE_CHUNK), MOBILE_CHUNK);
        });
      }
    } else if (rate >= 1536 * 1024) {
      networkSlowSince = 0;
      if (!networkGoodSince) networkGoodSince = now;
      if (networkAdaptiveState === 'slow' && now - networkGoodSince >= 12000 && now - networkLastRetryAt >= 12000) {
        networkAdaptiveState = 'recovering';
        var configured = Math.max(1, Math.min(3, parseInt($('concurrency-select') && $('concurrency-select').value, 10) || 1));
        networkAdaptiveConcurrencyLimit = Math.max(1, Math.min(configured, isMobileLike() ? 2 : 3));
        batch.forEach(function (it) {
          var previous = it && Number(it.networkAdaptiveCeilBeforeSlow) || 0;
          // If another failure reduced the ceiling below MOBILE_CHUNK, keep that safer
          // proxy/network limit instead of restoring the old value.
          if (it && previous > 0 && Number(it.chunkCeil || 0) >= MOBILE_CHUNK) it.chunkCeil = Math.max(it.chunkCeil || 0, previous);
          if (it) it.networkAdaptiveCeilBeforeSlow = 0;
        });
        if (now - networkGoodSince >= 22000) networkAdaptiveState = 'auto';
      } else if (networkAdaptiveState !== 'slow') networkAdaptiveState = 'auto';
    }
  }
  function recordNetworkRate(rate) {
    rate = Number(rate) || 0; if (rate <= 0) return;
    var now = Date.now(); if (now - networkLastSampleAt < 450) return; networkLastSampleAt = now;
    networkRateSamples.push({ at: now, rate: rate }); if (networkRateSamples.length > NETWORK_GRAPH_POINTS) networkRateSamples.shift();
    updateAdaptiveNetwork(rate); renderNetworkDashboard();
  }
  function drawNetworkGraph() {
    var canvas = $('network-rate-chart'); if (!canvas || !canvas.getContext) return;
    var rect = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(260, Math.round(rect.width || 300)), h = 96;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var samples = networkRateSamples.slice(); if (!samples.length) return;
    var max = Math.max.apply(null, samples.map(function (x) { return x.rate; }).concat([1]));
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-2').trim() || '#5b8dff'; ctx.lineWidth = 2; ctx.beginPath();
    samples.forEach(function (x, i) { var px = samples.length === 1 ? w : (i / (samples.length - 1)) * w; var py = h - 8 - (x.rate / max) * (h - 16); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke();
  }
  function renderNetworkDashboard() {
    var c = connectionInfo(), test = lastNetworkTest || null;
    var set = function (id, text) { if ($(id)) $(id).textContent = text; };
    set('net-latency', test ? Math.round(test.latency || 0) + ' ms' : '—');
    set('net-upload', test ? fmtBytes(test.uploadBps || 0) + '/s' : '—');
    set('net-download', test ? fmtBytes(test.downloadBps || 0) + '/s' : '—');
    var live = globalRate && globalRate.ema ? globalRate.ema : 0; set('net-live-rate', live > 0 ? fmtBytes(live) + '/s' : '—');
    var liveChunk = batch.length ? Math.max.apply(null, batch.map(function (it) { return it.chunkSize || 0; })) : networkRecommendedChunk; set('net-chunk', liveChunk ? fmtBytes(liveChunk) : fmtBytes(initialChunkSize()));
    set('net-parallel', String(networkConfiguredConcurrency || networkRecommendedConcurrency || (parseInt($('concurrency-select') && $('concurrency-select').value, 10) || 1)));
    set('net-active', String(networkActiveTransfers));
    set('net-retries', String(networkRetryCount));
    set('net-adaptive', t(networkAdaptiveState === 'slow' ? 'networkAdaptiveSlow' : networkAdaptiveState === 'recovering' ? 'networkAdaptiveRecovering' : 'networkAdaptiveAuto'));
    var q = networkQuality(test), quality = $('network-quality'); if (quality) { quality.textContent = networkQualityLabel(q); quality.dataset.quality = q; }
    if ($('network-last-test')) $('network-last-test').textContent = test && test.at ? t('networkLastTest', { when: fmtDate(test.at) }) : t('networkNotTested');
    if ($('network-connection-detail')) $('network-connection-detail').textContent = c ? [c.type || '', c.effectiveType || '', c.downlink ? c.downlink + ' Mb/s' : ''].filter(Boolean).join(' · ') : (navigator.onLine ? t('onlineStatus') : t('offlineStatus'));
    drawNetworkGraph();
  }
  async function runNetworkTest(options) {
    options = options || {}; if (networkTestPromise) return networkTestPromise;
    networkTestPromise = (async function () {
      var btn = $('network-test-btn'); if (btn) btn.disabled = true;
      if (!options.silent) toast(t('networkTesting'));
      try {
        if (navigator.onLine === false) throw new Error('offline');
        if (!deviceInfo || !deviceInfo.csrf) await fetchDeviceStatus();
        var pings = [];
        for (var i = 0; i < 3; i++) { var p0 = performance.now(); var pr = await fetchWithTimeout('/app/network-test?probe=1&_=' + Date.now() + '-' + i, { credentials: 'same-origin', cache: 'no-store' }, 6000); if (!pr.ok) throw new Error('ping-' + pr.status); await pr.text(); pings.push(performance.now() - p0); }
        pings.sort(function (a,b) { return a-b; }); var latency = pings[1];
        var downBytes = 384 * 1024, d0 = performance.now(); var dr = await fetchWithTimeout('/app/network-test?bytes=' + downBytes + '&_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' }, 10000); if (!dr.ok) throw new Error('down-' + dr.status); var dbuf = await dr.arrayBuffer(); var dsec = Math.max(.001, (performance.now() - d0) / 1000); var downloadBps = dbuf.byteLength / dsec;
        var upBytes = 512 * 1024, payload = new Uint8Array(upBytes), u0 = performance.now(); var ur = await fetchWithTimeout('/app/network-test', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: appMutationHeaders('application/octet-stream'), body: payload }, 12000); if (!ur.ok) throw new Error('up-' + ur.status); var uj = await ur.json(); var sent = Number(uj.bytes) || upBytes; var usec = Math.max(.001, (performance.now() - u0) / 1000); var uploadBps = sent / usec;
        lastNetworkTest = { at: Date.now(), latency: latency, uploadBps: uploadBps, downloadBps: downloadBps }; applyNetworkRecommendation(lastNetworkTest);
        try { localStorage.setItem('dx-pwa-network-test', JSON.stringify(lastNetworkTest)); } catch (_) {}
        renderNetworkDashboard();
        if (!options.silent) toast(t('networkTestDone', { quality: networkQualityLabel(networkQuality(lastNetworkTest)), up: fmtBytes(uploadBps) + '/s', down: fmtBytes(downloadBps) + '/s', latency: Math.round(latency) }), 'ok');
        return lastNetworkTest;
      } catch (e) { if (!options.silent) toast(t('networkTestFailed'), 'warn'); return null; }
      finally { if (btn) btn.disabled = false; networkTestPromise = null; }
    })();
    return networkTestPromise;
  }
  async function maybeTestNetworkForLargeTransfer(candidates) {
    // Do not consume mobile data merely to benchmark files that are explicitly
    // blocked until Wi-Fi. Only currently transport-eligible candidates count.
    var eligible = (candidates || []).filter(function (it) { return !wifiPolicyRequired(it) || wifiOk(it); });
    var bytes = eligible.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0);
    if (bytes < LARGE_TRANSFER_TEST_BYTES) return lastNetworkTest;
    if (lastNetworkTest && Date.now() - (lastNetworkTest.at || 0) < NETWORK_TEST_MAX_AGE_MS) { applyNetworkRecommendation(lastNetworkTest); return lastNetworkTest; }
    toast(t('networkTestAuto'));
    var tested = await runNetworkTest({ silent: true });
    if (tested) toast(t('networkTestDone', { quality: networkQualityLabel(networkQuality(tested)), up: fmtBytes(tested.uploadBps || 0) + '/s', down: fmtBytes(tested.downloadBps || 0) + '/s', latency: Math.round(tested.latency || 0) }), 'ok');
    else toast(t('networkTestFailed'), 'warn');
    return tested;
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
      if (it.contentHash) qs += '&sha256=' + encodeURIComponent(it.contentHash);
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
      try { xhr.send(blob.slice(offset, end)); }
      catch (_) { finish({ retry: true, offset: null, shrink: offset === 0, netError: true, sentAny: false, ms: Date.now() - started }); }
    });
  }
  function waitUntilOnline() {
    if (navigator.onLine) return Promise.resolve();
    return new Promise(function (resolve) { onlineWaiters.push(resolve); });
  }
  function largeWifiThresholdBytes() {
    var mb = Math.max(1, Number($('large-wifi-threshold') && $('large-wifi-threshold').value) || 100);
    return mb * 1024 * 1024;
  }
  function wifiPolicyRequired(it) {
    if ($('wifi-only') && $('wifi-only').checked) return true;
    if (!($('large-wifi-only') && $('large-wifi-only').checked)) return false;
    return Math.max(0, Number(it && (it.upSize || it.size)) || 0) >= largeWifiThresholdBytes();
  }
  // A Wi-Fi-only policy must fail closed when the browser cannot prove the
  // transport type. The user can explicitly disable the policy on browsers that do
  // not expose NetworkInformation.type; silently allowing an unknown transport can
  // otherwise consume cellular data while claiming Wi-Fi-only enforcement.
  function wifiOk(it) {
    if (!wifiPolicyRequired(it)) return true;
    var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c || !c.type) return false;
    var type = String(c.type).toLowerCase();
    return type === 'wifi' || type === 'ethernet' || type === 'wimax';
  }
  function waitUntilWifi(it) {
    if (wifiOk(it)) return Promise.resolve();
    return new Promise(function (resolve) { wifiWaiters.push({ resolve: resolve, item: it || null }); });
  }
  function releaseWifiWaiters() {
    var keep = [];
    wifiWaiters.splice(0).forEach(function (entry) {
      if (typeof entry === 'function') { if (wifiOk(null)) entry(); else keep.push({ resolve: entry, item: null }); return; }
      if (entry && wifiOk(entry.item)) entry.resolve(); else if (entry) keep.push(entry);
    });
    Array.prototype.push.apply(wifiWaiters, keep);
  }
  function persistWifiPolicies() {
    items.forEach(function (it) {
      if (!it || it.state === 'done' || it.state === 'removed') return;
      it.wifiRequired = wifiPolicyRequired(it);
      if (!it.volatile) persistItem(it, false).catch(function () {});
    });
  }
  function waitUntilResumed() {
    if (!paused) return Promise.resolve();
    return new Promise(function (resolve) { resumeWaiters.push(resolve); });
  }
  async function finishItem(it, response) {
    it.state = 'done'; it.sentBytes = it.upSize; it.errorCode = null; it.resumeOnOpen = false; it.backgroundReady = false;
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
    await addHistory({ id: genId(18), name: it.name, size: it.size, sentSize: it.upSize, destination: it.snapshot.name, destToken: it.snapshot.token, encrypted: !!it.snapshot.enc, at: Date.now(), rate: rate, note: it.note || '' });
    if (response && currentConfig && currentDest && currentDest.token === it.snapshot.token) {
      if (response.filesReceived != null) currentConfig.filesReceived = response.filesReceived;
      if (response.bytesReceived != null) currentConfig.bytesReceived = response.bytesReceived;
      showLimits(currentConfig);
    }
  }
  async function tryServerDedup(it) {
    // End-to-end encryption intentionally uses fresh ciphertext, so content
    // deduplication is meaningful only for the exact unencrypted payload.
    if (!it || !it.preparedBlob || !it.snapshot || !it.snapshot.token || it.snapshot.enc) return null;
    try {
      updateItemUi(it, t('dedupeChecking'));
      if (!it.contentHash) {
        var hashOp=beginLongOperation(t('longOpHash'),it.name||'');
        try {
          it.contentHash = await sha256Blob(it.preparedBlob, function (fraction) {
            if (it.meta) it.meta.textContent = t('hashing') + ' ' + Math.round(fraction * 100) + '%';
            updateLongOperation(hashOp,Math.round(fraction*100),it.name||'');
          });
        } finally { endLongOperation(hashOp); }
      }
      if (!it.contentHash || it.state === 'removed') return null;
      await persistItem(it, false).catch(function () {});
      var payload = { path: it.upName, size: it.upSize, sha256: it.contentHash, id: it.uploadId, sender: it.snapshot.sender || '', expire: it.snapshot.expire || 0 };
      var dedupeUrl = '/u/' + encodeURIComponent(it.snapshot.token) + '/dedupe';
      if (it.snapshot.sender) dedupeUrl += '?sender=' + encodeURIComponent(it.snapshot.sender);
      var r = await fetchWithTimeout(dedupeUrl, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(payload)
      }, 20000);
      if (!r.ok) return null;
      var data = await r.json().catch(function () { return null; });
      if (data && data.deduped) return data;
      // A global hash match is followed by a proof-of-possession challenge. This
      // prevents a known SHA-256 from becoming a cross-share content oracle.
      if (data && data.challenge && Array.isArray(data.ranges) && data.ranges.length) {
        var proof = [];
        for (var pi = 0; pi < data.ranges.length; pi++) {
          var rr = data.ranges[pi] || {}, off = Number(rr.offset) || 0, len = Number(rr.length) || 0;
          if (off < 0 || len < 1 || len > 4096 || off + len > it.preparedBlob.size) return null;
          var bytes = new Uint8Array(await it.preparedBlob.slice(off, off + len).arrayBuffer()), binary = '';
          for (var bi = 0; bi < bytes.length; bi++) binary += String.fromCharCode(bytes[bi]);
          proof.push(btoa(binary));
        }
        payload.challenge = data.challenge; payload.proof = proof;
        var r2 = await fetchWithTimeout(dedupeUrl, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(payload)
        }, 20000);
        if (!r2.ok) return null;
        var data2 = await r2.json().catch(function () { return null; });
        return data2 && data2.deduped ? data2 : null;
      }
      return null;
    } catch (_) { return null; }
  }

  async function acquireAdaptiveTransferSlot() {
    // Reserve a slot atomically between chunks. Reducing concurrency therefore
    // takes effect after the currently active chunks rather than waiting for an
    // entire large file to finish.
    while (true) {
      await waitUntilResumed();
      var limit = Math.max(1, Number(networkAdaptiveConcurrencyLimit || networkConfiguredConcurrency || 1));
      if (networkActiveTransfers < limit) {
        networkActiveTransfers++; renderNetworkDashboard(); return;
      }
      await sleep(120);
    }
  }
  function releaseAdaptiveTransferSlot() {
    networkActiveTransfers = Math.max(0, networkActiveTransfers - 1); renderNetworkDashboard();
  }

  async function uploadOne(it) {
    if (it.state === 'removed' || it.state === 'done') return true;
    try { await prepareUpload(it); }
    catch (e) {
      it.state = 'error'; it.resumeOnOpen = false; it.backgroundReady = false; it.errorCode = e && e.message === 'nokey' ? 'nokey' : e && e.message === 'nopass' ? 'nopass' : e && e.message === 'nocrypto' ? 'nocrypto' : 'prepare';
      updateItemUi(it, it.errorCode === 'nokey' ? t('keyRequired') : it.errorCode === 'nopass' ? t('passRequired') : it.errorCode === 'nocrypto' ? t('noCrypto') : t('error'), 'err');
      recordTransferError(it, { code: it.errorCode, badge: 'prepare', hint: statusText(it) });
      await persistItem(it, false); return false;
    }
    it.prepareProgress = 0;
    var offset = await getOffset(it.snapshot, it.uploadId);
    offset = Math.min(offset, it.upSize); it.sentBytes = offset; it.lastServerOffset=offset; if(offset>0){it.recoveryAttempts=Math.max(0,Number(it.recoveryAttempts)||0)+1;it.recoveredAt=Date.now();it.recoveryReason='server-offset';}
    if (offset === 0 && !it.preparedEncrypted) {
      var dedupe = await tryServerDedup(it);
      if (dedupe) {
        it.deduped = true; it.sendStartAt = Date.now(); it.sendStartBytes = it.upSize;
        await finishItem(it, dedupe);
        updateItemUi(it, t('dedupeHit'), 'ok');
        if (it.row) it.row.classList.add('deduped');
        if (it.meta) it.meta.textContent = t('dedupeHit') + ' · ' + fmtBytes(it.upSize);
        return true;
      }
    }
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
        it.state = 'waiting-network'; updateItemUi(it, t('waitingNetwork')); schedulePersistItem(it); registerBackgroundSync(); await waitUntilOnline(); continue;
      }
      if (!wifiOk(it)) {
        it.state = 'waiting-network'; updateItemUi(it, t('waitingWifi')); schedulePersistItem(it); await waitUntilWifi(it); continue;
      }
      it.state = 'sending'; updateItemUi(it, offset ? Math.round((offset / Math.max(1, it.upSize)) * 100) + '%' : t('startingUpload'));
      await acquireAdaptiveTransferSlot();
      var result;
      try { result = await putChunk(it, offset); }
      finally { releaseAdaptiveTransferSlot(); }
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
        it.state = 'error'; it.resumeOnOpen = false; it.backgroundReady = false; it.errorCode = result.code; updateItemUi(it, reasonText(result.code), 'err');
        recordTransferError(it, { badge: 'HTTP', hint: reasonText(result.code), code: result.code });
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
        networkRetryCount++; networkLastRetryAt = Date.now();
        recordNetworkIncident(it, { code:'rate-limited', badge:'HTTP 429', hint:t('rateLimited'), attempt:Math.max(1, failures + 1) });
        updateAdaptiveNetwork(globalRate && globalRate.ema || 0); renderNetworkDashboard();
        await sleep(Math.min(60000, Math.max(2000, (result.retryAfter || 5) * 1000)));
        continue;
      }
      failures++; networkRetryCount++; networkLastRetryAt = Date.now(); renderNetworkDashboard();
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
      recordNetworkIncident(it, { code: result.timeout ? 'timeout' : result.netError ? 'network-error' : result.status ? 'http-' + result.status : 'retry', badge:it.lastFail || '', hint:it.lastHint || '', attempt:failures });
      updateAdaptiveNetwork(globalRate && globalRate.ema || 0);
      var stall = function () {
        it.state = 'error'; it.resumeOnOpen = false; it.backgroundReady = false; it.errorCode = 'upload-stalled';
        var msg = it.lastHint ? t('uploadStalled') + ' — ' + it.lastHint : t('uploadStalled');
        updateItemUi(it, msg, 'err');
        if (it.meta) it.meta.textContent = it.lastHint || t('uploadStalled');
        recordTransferError(it, { badge: it.lastFail || '', hint: it.lastHint || '', code: 'upload-stalled' });
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
    postTransferNotification({ paused:true }, true); toast(t('pauseRequested'), 'warn'); activeXhrs.forEach(function (xhr) { try { xhr.abort(); } catch (_) {} });
    setTimeout(function () { items.filter(function (it) { return it.state === 'paused'; }).forEach(function (it) { it.resumeOnOpen = false; persistItem(it, false); }); }, 50);
  }
  function resumeBatch() {
    if (!paused) return;
    paused = false; $('resume-btn').classList.add('hidden'); $('pause-btn').classList.remove('hidden');
    var waiters = resumeWaiters.splice(0); waiters.forEach(function (resolve) { resolve(); }); postTransferNotification({ paused:false }, true); toast(t('resumed'), 'ok');
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
    var firstSnapshot = candidates[0] && candidates[0].snapshot ? candidates[0].snapshot : null;
    var destination = firstSnapshot ? firstSnapshot.name : (currentDest && currentDest.name) || '';
    return {
      at: Date.now(), destination: destination, token: firstSnapshot ? (firstSnapshot.token || '') : (currentDest && currentDest.token) || '', ok: ok, fail: fail,
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
    if (!rec || !rec.files || !rec.files.length) { toast(t('lastBatchUnavailable'), 'warn'); updateResultActions(); return []; }
    if (rec.token && findDest(rec.token)) {
      setActiveToken(rec.token); renderDests(); $('dest-select').value = rec.token; await refreshDestStatus();
    }
    if ($('batch-note')) { $('batch-note').value = rec.note || ''; updateCharCount($('batch-note'), $('note-count'), 120); }
    if ($('expire-select')) $('expire-select').value = String(rec.expire || 0);
    if ($('sender-name') && rec.sender) { $('sender-name').value = rec.sender; saveSenderForCurrent(); }
    var restored = [];
    for (var i = 0; i < rec.files.length; i++) {
      var f = rec.files[i];
      if (!f.file) continue;
      var it = makeItem({ file: f.file, name: f.name, originalName: f.originalName, type: f.type, size: f.size, lastModified: f.lastModified, state: 'waiting' });
      items.push(it); persistItem(it, false); restored.push(it);
    }
    renderQueue(); updateSendBtn(); updateStorageStatus();
    toast(t('lastBatchRestored', { n: restored.length }), restored.length ? 'ok' : 'warn');
    return restored;
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
    // Files covered by a Wi-Fi-only policy will wait rather than consume mobile data,
    // so exclude them from the mobile-data confirmation volume.
    var total = candidates.reduce(function (sum, it) { return sum + (wifiPolicyRequired(it) ? 0 : (it.upSize || it.size || 0)); }, 0);
    if (total < 10 * 1024 * 1024) return true;
    return confirm(t('mobileDataConfirm', { size: fmtBytes(total) }));
  }
  function estimatedCandidateBytes(candidates) {
    var optimize = $('optimize-images') && $('optimize-images').checked;
    return candidates.reduce(function (sum, it) {
      var size = it.upSize || it.size || 0;
      if (optimize && /^image\//.test(it.type || '') && it.estSize > 0) size = it.estSize;
      return sum + size;
    }, 0);
  }
  async function checkBatteryBeforeBatch(candidates) {
    if (!navigator.getBattery || !candidates || !candidates.length) return true;
    try {
      var battery = await navigator.getBattery();
      var level = Math.round((Number(battery.level) || 0) * 100);
      var bytes = estimatedCandidateBytes(candidates);
      var longByRate = avgRate > 0 && bytes / avgRate >= 180;
      if (battery.charging || level > 20 || (bytes < 100 * 1024 * 1024 && !longByRate)) return true;
      var proceed = confirm(t('lowBatteryConfirm', { level: level }));
      if (!proceed) return false;
      if ($('concurrency-select')) { $('concurrency-select').value = '1'; try { localStorage.setItem('dx-pwa-concurrency', '1'); } catch (_) {} }
      return true;
    } catch (_) { return true; }
  }
  function startBatchClock() {
    batchStartedAt = Date.now();
    if (batchClockTimer) clearInterval(batchClockTimer);
    batchClockTimer = setInterval(function () { if (sending) updateGlobalProgress(); }, 1000);
  }
  function stopBatchClock() {
    if (batchClockTimer) clearInterval(batchClockTimer);
    batchClockTimer = null;
    batchStartedAt = 0;
  }
  function activeTransferNotificationsEnabled() {
    return !!($('persistent-transfer-notification') && $('persistent-transfer-notification').checked && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker);
  }
  function postTransferNotification(message, force) {
    if (!activeTransferNotificationsEnabled()) return;
    var now = Date.now(); if (!force && now - transferNotificationLastAt < 1400) return; transferNotificationLastAt = now;
    transferNotificationLastPayload = Object.assign({}, transferNotificationLastPayload || {}, message || {});
    message = Object.assign({ type:'TRANSFER_PROGRESS', build:APP_BUILD, lang:lang }, transferNotificationLastPayload);
    try {
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(message);
      else navigator.serviceWorker.ready.then(function (reg) { if (reg && reg.active) reg.active.postMessage(message); }).catch(function () {});
    } catch (_) {}
  }
  function clearTransferNotification() {
    transferNotificationLastAt = 0; transferNotificationLastPayload = null;
    try {
      var msg = { type:'TRANSFER_PROGRESS_CLEAR' };
      if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(msg);
      else if (navigator.serviceWorker) navigator.serviceWorker.ready.then(function (reg) { if (reg && reg.active) reg.active.postMessage(msg); }).catch(function () {});
    } catch (_) {}
  }
  async function configureActiveTransferNotifications(enabled) {
    try { localStorage.setItem('dx-pwa-transfer-notification', enabled ? '1' : '0'); } catch (_) {}
    metaSet('transferNotificationEnabled', !!enabled).catch(function () {});
    if (!enabled) { clearTransferNotification(); return true; }
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    if (Notification.permission !== 'granted') {
      if ($('persistent-transfer-notification')) $('persistent-transfer-notification').checked = false;
      try { localStorage.setItem('dx-pwa-transfer-notification', '0'); } catch (_) {}
      metaSet('transferNotificationEnabled', false).catch(function () {});
      toast(t('transferNotifPermissionDenied'), 'warn'); return false;
    }
    return true;
  }

  async function showBatchCompletionNotification(ok, fail, summary) {
    if (!summary || !('Notification' in window) || Notification.permission !== 'granted' || !navigator.serviceWorker) return;
    try {
      var reg = await navigator.serviceWorker.ready;
      if (!reg || !reg.showNotification) return;
      var actions = [
        { action: 'open', title: t('notifOpen') },
        { action: 'copy-link', title: t('notifCopyLink') },
        { action: 'resend-last', title: t('notifResend') }
      ];
      if (typeof Notification.maxActions === 'number' && Notification.maxActions > 0) actions = actions.slice(0, Notification.maxActions);
      var failText = fail ? ' · ' + t('failures', { n: fail }) : '';
      var token = summary.token || '';
      await reg.showNotification(t('notifUploadTitle'), {
        body: t('notifUploadBody', { ok: ok, fail: failText }),
        icon: '/app/icon-192.png', badge: '/app/icon-192.png', tag: 'dx-upload-complete', renotify: true, actions: actions,
        data: { kind: 'upload-complete', url: '/app/?action=send', destinationUrl: token ? (location.origin + '/u/' + encodeURIComponent(token)) : '' }
      });
    } catch (_) {}
  }

  async function startBatch(onlyItems) {
    if (sending) return;
    var candidates = (onlyItems || items).filter(function (it) { return it.state === 'waiting' || it.state === 'error' || it.state === 'waiting-network'; });
    if (!candidates.length) { toast(t('noPending'), 'warn'); return; }
    if (!await ensurePwaDlpBeforeBatch(candidates)) return;
    if (!confirmMobileDataIfNeeded(candidates)) return;
    if (!await checkBatteryBeforeBatch(candidates)) return;
    await maybeTestNetworkForLargeTransfer(candidates);
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
    var preparedCandidates = [];
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
      // Prepare the exact bytes before the first network request. This page-side
      // step owns DLP, transformations and encryption; the service worker is allowed
      // to resume only the resulting durable payload and never receives a secret.
      try {
        await prepareUpload(item);
        item.wifiRequired = wifiPolicyRequired(item);
        if (item.snapshot) { item.snapshot.key = ''; item.snapshot.passphrase = ''; }
        await persistItem(item, false); // metadata + final payload precede all upload traffic
        preparedCandidates.push(item);
      } catch (e) {
        item.state = 'error'; item.resumeOnOpen = false; item.backgroundReady = false;
        item.errorCode = e && e.message === 'nokey' ? 'nokey' : e && e.message === 'nopass' ? 'nopass' : e && e.message === 'nocrypto' ? 'nocrypto' : 'prepare';
        updateItemUi(item, reasonText(item.errorCode), 'err');
        recordTransferError(item, { code: item.errorCode, badge: 'prepare', hint: statusText(item) });
        await persistItem(item, false).catch(function () {});
      }
    }
    candidates = preparedCandidates;
    if (!candidates.length) { renderQueue(); updateSendBtn(); return; }
    if (candidates.some(function (it) { return it.backgroundReady; })) registerBackgroundSync();
    sending = true; paused = false; batch = candidates; batchTotal = candidates.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0);
    startBatchClock();
    globalRate = {}; networkRetryCount = 0; networkRateSamples = []; networkLastSampleAt = 0; networkAdaptiveState = 'auto'; networkSlowSince = 0; networkGoodSince = 0; networkLastRetryAt = 0;
    candidates.forEach(function (it) { it.rate = {}; if (networkRecommendedChunk > 0) it.chunkCeil = Math.max(MIN_CHUNK, networkRecommendedChunk); }); // fresh smoothed-rate baselines for this batch
    renderNetworkDashboard();
    batchSnapshot = candidates[0].snapshot; setDestinationLocked(true); $('send-btn').disabled = true; $('pause-btn').classList.remove('hidden'); $('resume-btn').classList.add('hidden');
    $('global-progress-wrap').classList.remove('hidden'); await acquireWake(); updateGlobalProgress();
    var queue = candidates.slice().sort(function (a, b) {
      return (wifiOk(a) ? 0 : 1) - (wifiOk(b) ? 0 : 1);
    }), ok = 0, fail = 0;
    var concurrency = Math.max(1, Math.min(3, parseInt($('concurrency-select').value, 10) || 2));
    if (networkRecommendedConcurrency > 0) concurrency = Math.min(concurrency, networkRecommendedConcurrency);
    // Without a fresh network recommendation, keep the conservative mobile rule.
    // A successful test may explicitly allow 2 parallel streams on a strong mobile link,
    // while any individual 128 MiB+ file remains single-stream for Android reliability.
    if ((!lastNetworkTest || Date.now() - (lastNetworkTest.at || 0) >= NETWORK_TEST_MAX_AGE_MS) && isMobileLike()) concurrency = 1;
    if (candidates.some(function (it) { return (it.size || 0) >= 128 * 1024 * 1024; })) concurrency = 1;
    networkConfiguredConcurrency = concurrency; networkAdaptiveConcurrencyLimit = concurrency; renderNetworkDashboard();
    async function worker(workerIndex) {
      while (queue.length) {
        if (workerIndex >= Math.max(1, networkAdaptiveConcurrencyLimit || concurrency)) { await sleep(500); continue; }
        var it = queue.shift(); if (!it) continue;
        var good = await uploadOne(it); if (good) ok++; else if (it.state !== 'removed') fail++;
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(concurrency, candidates.length); w++) workers.push(worker(w));
    await Promise.all(workers);
    // Learn the average rate for future pre-send estimates (estimated time).
    var learned = emaRate(globalRate, batchTotal);
    await rememberLastBatch(candidates, ok, fail);
    if (learned > 0) { avgRate = avgRate > 0 ? avgRate * 0.5 + learned * 0.5 : learned; try { localStorage.setItem('dx-pwa-avg-rate', String(Math.round(avgRate))); } catch (_) {} }
    stopBatchClock();
    sending = false; paused = false; networkConfiguredConcurrency = 0; networkAdaptiveConcurrencyLimit = 0; networkAdaptiveState = 'auto'; networkActiveTransfers = 0; batch = []; batchTotal = 0; batchSnapshot = null; setDestinationLocked(false);
    clearTransferNotification();
    await showBatchCompletionNotification(ok, fail, lastBatchSummary);
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
    if (sending && batchStartedAt) {
      var elapsedSec = Math.max(0, (Date.now() - batchStartedAt) / 1000);
      line += ' · ' + t('batchElapsed', { time: fmtClock(elapsedSec) });
      if (done > 0) line += ' · ' + t('avgPerFile', { time: fmtClock(elapsedSec / done) });
    }
    // Overall rolling rate + ETA across the whole batch, shown while actively sending.
    var liveRate = 0, liveEtaSec = 0;
    if (sending && !paused) {
      liveRate = emaRate(globalRate, sent);
      if (liveRate > 0) { recordNetworkRate(liveRate);
        line += ' · ↑ ' + fmtBytes(liveRate) + '/s';
        var remain = Math.max(0, total - sent);
        if (remain > 0) { liveEtaSec = remain / liveRate; line += ' · ⏳ ' + fmtEta(liveEtaSec); }
      }
    }
    if (sending) postTransferNotification({ sent:sent, total:total, percent:pct, done:done, count:source.length, rate:liveRate, etaSeconds:liveEtaSec, paused:!!paused }, false);
    $('gprog-text').textContent = line;
    // Live tab title while a batch is in flight. The app badge also represents
    // queued and failed files while idle, so it is updated centrally.
    if (sending) document.title = '(' + pct + ' %) ' + baseTitle;
    else if (document.title !== baseTitle) document.title = baseTitle;
    updateFilesCount();
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
    updateFilesCount(); updateOptimizationEstimate(); updateResultActions(); updateAppBadge(); renderErrorCenter(); renderNetworkDashboard();
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
  // Re-select the destination a past batch used and jump to the Send tab, ready to
  // re-add files. The sent bytes are not retained, so this restores the target and
  // settings, not the files. Matches by stored token, falling back to the saved
  // destination name for entries created before destToken existed.
  function pwaServerActivityIcon(e) {
    var kind = String(e && e.kind || '');
    var status = String(e && e.status || '');
    if (kind === 'transfer-start') return '⇄';
    if (kind === 'transfer-complete') return '✓';
    if (kind === 'transfer-error') return '⚠';
    if (kind === 'ocr-start' || kind === 'ocr-complete') return 'T';
    if (kind === 'ocr-error') return '⚠';
    if (kind === 'antivirus') return status === 'infected' ? '🦠' : '🛡';
    if (kind === 'trash') return '🗑';
    if (kind === 'security') return '🔐';
    if (kind === 'visitor') return '👥';
    if (kind === 'system') return '⚙';
    if (kind === 'share') return '🔗';
    if (kind === 'audit') return '🧾';
    return '•';
  }
  function pwaServerActivityGroup(e) {
    var kind = String(e && e.kind || '').toLowerCase();
    if (kind.indexOf('transfer-') === 0) return 'transfer';
    if (kind === 'audit' || kind === 'share' || kind === 'trash') return 'admin';
    if (kind === 'security' || kind === 'antivirus') return 'security';
    if (kind === 'visitor') return 'visitor';
    if (kind === 'system' || kind.indexOf('ocr-') === 0) return 'system';
    return 'admin';
  }
  var PWA_ACTIVITY_ACTIONS = {
    fr:{'action-undone':'Action annulée','album-created':'Album créé','audit-exported':'Journal d’audit exporté','backup-download':'Sauvegarde téléchargée','backup-failed':'Sauvegarde échouée','backup-ok':'Sauvegarde réussie','diagnostics-run':'Diagnostics exécutés','dlp-blocked':'DLP : publication bloquée','dlp-detected':'DLP : contenu détecté','dlp-ocr-unavailable':'DLP : OCR indisponible','dlp-overridden':'DLP : avertissement outrepassé','dlp-quarantine-deleted':'Élément de quarantaine supprimé','dlp-quarantine-failed':'DLP : mise en quarantaine échouée','dlp-quarantined':'DLP : contenu mis en quarantaine','dlp-warning':'DLP : avertissement','download-threshold':'Seuil de téléchargements atteint','email-tested':'Courriel de test envoyé','expired-share-purged':'Partage expiré purgé','feedback-deleted':'Feedback supprimé','history-cleared':'Historique effacé','image-created':'Image créée','image-first-view':'Première vue d’image','image-retention-revoked':'Image révoquée par rétention','inbox-created':'Lien de réception créé','inbox-messages-cleared':'Messages de réception effacés','ip-named':'Client renommé','ip-names-cleared':'Surnoms IP effacés','ip-unnamed':'Surnom de client retiré','items-reordered':'Éléments réordonnés','link-preset-deleted':'Préréglage de lien supprimé','link-preset-saved':'Préréglage de lien enregistré','links-exported':'Liens exportés','login':'Connexion','login-fail':'Échec de connexion','logout':'Déconnexion','network-port-tested':'Port réseau testé','notification-prefs-changed':'Préférences de notifications modifiées','passkey-added':'Clé d’accès ajoutée','passkey-login':'Connexion par clé d’accès','pending-approved':'Dépôt approuvé','pending-rejected':'Dépôt rejeté','photo-edited':'Image modifiée','photo-uploaded':'Image téléversée','photos-created':'Images créées','photos-downloaded':'Images téléchargées','push-tested':'Notification push testée','pwa-auto-lock':'PWA verrouillée automatiquement','pwa-device-paired':'Appareil PWA appairé','pwa-device-renamed':'Appareil PWA renommé','pwa-device-revoked':'Appareil PWA révoqué','reception-thread-cleared':'Discussion de réception effacée','reception-thread-reply':'Réponse à une discussion de réception','recipients-added':'Sous-liens ajoutés','recipient-removed':'Sous-lien supprimé','recipient-updated':'Sous-lien modifié','restore':'Sauvegarde restaurée','search-reindex':'Réindexation recherche','server-shutdown':'Extinction serveur','settings-changed':'Réglages modifiés','settings-exported':'Réglages exportés','settings-imported':'Réglages importés','share-auto-archived':'Partage archivé automatiquement','share-cloned':'Partage dupliqué','share-created':'Partage créé','share-edited':'Partage modifié','share-extended':'Expiration prolongée','share-reactivated':'Partage réactivé','share-restored':'Partage restauré','share-revoked':'Partage révoqué','share-stats-reset':'Statistiques réinitialisées','share-trashed':'Partage mis à la corbeille','shares-exported':'Partages exportés','shares-imported':'Partages importés','shares-paused-all':'Partages mis en pause','shares-resumed-all':'Partages réactivés','transfer-stopped':'Transfert arrêté','trash-purged':'Élément supprimé définitivement','trash-purged-all':'Corbeille vidée','upload-deduped':'Doublon détecté','upload-folder-created':'Dossier de téléversement créé','upload-infected':'Téléversement infecté','webhook-tested':'Webhook testé'},
    en:{'action-undone':'Action undone','album-created':'Album created','audit-exported':'Audit log exported','backup-download':'Backup downloaded','backup-failed':'Backup failed','backup-ok':'Backup completed','diagnostics-run':'Diagnostics run','dlp-blocked':'DLP: publication blocked','dlp-detected':'DLP: content detected','dlp-ocr-unavailable':'DLP: OCR unavailable','dlp-overridden':'DLP: warning overridden','dlp-quarantine-deleted':'Quarantine item deleted','dlp-quarantine-failed':'DLP: quarantine failed','dlp-quarantined':'DLP: content quarantined','dlp-warning':'DLP: warning','download-threshold':'Download threshold reached','email-tested':'Test email sent','expired-share-purged':'Expired share purged','feedback-deleted':'Feedback deleted','history-cleared':'History cleared','image-created':'Image created','image-first-view':'First image view','image-retention-revoked':'Image revoked by retention','inbox-created':'Reception link created','inbox-messages-cleared':'Reception messages cleared','ip-named':'Client renamed','ip-names-cleared':'IP nicknames cleared','ip-unnamed':'Client nickname cleared','items-reordered':'Items reordered','link-preset-deleted':'Link preset deleted','link-preset-saved':'Link preset saved','links-exported':'Links exported','login':'Login','login-fail':'Login failed','logout':'Logout','network-port-tested':'Network port tested','notification-prefs-changed':'Notification preferences changed','passkey-added':'Passkey added','passkey-login':'Passkey login','pending-approved':'Pending upload approved','pending-rejected':'Pending upload rejected','photo-edited':'Image edited','photo-uploaded':'Image uploaded','photos-created':'Images created','photos-downloaded':'Images downloaded','push-tested':'Push notification tested','pwa-auto-lock':'PWA automatically locked','pwa-device-paired':'PWA device paired','pwa-device-renamed':'PWA device renamed','pwa-device-revoked':'PWA device revoked','reception-thread-cleared':'Reception thread cleared','reception-thread-reply':'Reception thread reply','recipients-added':'Sub-links added','recipient-removed':'Sub-link removed','recipient-updated':'Sub-link updated','restore':'Backup restored','search-reindex':'Search reindex','server-shutdown':'Server shutdown','settings-changed':'Settings changed','settings-exported':'Settings exported','settings-imported':'Settings imported','share-auto-archived':'Share automatically archived','share-cloned':'Share duplicated','share-created':'Share created','share-edited':'Share edited','share-extended':'Share expiration extended','share-reactivated':'Share reactivated','share-restored':'Share restored','share-revoked':'Share revoked','share-stats-reset':'Share statistics reset','share-trashed':'Share moved to trash','shares-exported':'Shares exported','shares-imported':'Shares imported','shares-paused-all':'Shares paused','shares-resumed-all':'Shares resumed','transfer-stopped':'Transfer stopped','trash-purged':'Item permanently deleted','trash-purged-all':'Trash emptied','upload-deduped':'Duplicate upload detected','upload-folder-created':'Upload folder created','upload-infected':'Infected upload','webhook-tested':'Webhook tested'},
    es:{'action-undone':'Acción deshecha','album-created':'Álbum creado','audit-exported':'Registro de auditoría exportado','backup-download':'Copia de seguridad descargada','backup-failed':'Copia de seguridad fallida','backup-ok':'Copia de seguridad completada','diagnostics-run':'Diagnósticos ejecutados','dlp-blocked':'DLP: publicación bloqueada','dlp-detected':'DLP: contenido detectado','dlp-ocr-unavailable':'DLP: OCR no disponible','dlp-overridden':'DLP: advertencia ignorada','dlp-quarantine-deleted':'Elemento de cuarentena eliminado','dlp-quarantine-failed':'DLP: cuarentena fallida','dlp-quarantined':'DLP: contenido en cuarentena','dlp-warning':'DLP: advertencia','download-threshold':'Umbral de descargas alcanzado','email-tested':'Correo de prueba enviado','expired-share-purged':'Recurso caducado purgado','feedback-deleted':'Comentario eliminado','history-cleared':'Historial borrado','image-created':'Imagen creada','image-first-view':'Primera vista de imagen','image-retention-revoked':'Imagen revocada por retención','inbox-created':'Enlace de recepción creado','inbox-messages-cleared':'Mensajes de recepción borrados','ip-named':'Cliente renombrado','ip-names-cleared':'Alias de IP borrados','ip-unnamed':'Alias de cliente eliminado','items-reordered':'Elementos reordenados','link-preset-deleted':'Preajuste de enlace eliminado','link-preset-saved':'Preajuste de enlace guardado','links-exported':'Enlaces exportados','login':'Inicio de sesión','login-fail':'Inicio fallido','logout':'Cierre de sesión','network-port-tested':'Puerto de red probado','notification-prefs-changed':'Preferencias de notificación modificadas','passkey-added':'Clave de acceso añadida','passkey-login':'Inicio con clave de acceso','pending-approved':'Carga pendiente aprobada','pending-rejected':'Carga pendiente rechazada','photo-edited':'Imagen editada','photo-uploaded':'Imagen subida','photos-created':'Imágenes creadas','photos-downloaded':'Imágenes descargadas','push-tested':'Notificación push probada','pwa-auto-lock':'PWA bloqueada automáticamente','pwa-device-paired':'Dispositivo PWA emparejado','pwa-device-renamed':'Dispositivo PWA renombrado','pwa-device-revoked':'Dispositivo PWA revocado','reception-thread-cleared':'Conversación de recepción borrada','reception-thread-reply':'Respuesta en conversación de recepción','recipients-added':'Subenlaces añadidos','recipient-removed':'Subenlace eliminado','recipient-updated':'Subenlace modificado','restore':'Copia de seguridad restaurada','search-reindex':'Reindexación de búsqueda','server-shutdown':'Apagado del servidor','settings-changed':'Ajustes modificados','settings-exported':'Ajustes exportados','settings-imported':'Ajustes importados','share-auto-archived':'Recurso archivado automáticamente','share-cloned':'Recurso duplicado','share-created':'Recurso creado','share-edited':'Recurso modificado','share-extended':'Caducidad ampliada','share-reactivated':'Recurso reactivado','share-restored':'Recurso restaurado','share-revoked':'Recurso revocado','share-stats-reset':'Estadísticas reiniciadas','share-trashed':'Recurso movido a la papelera','shares-exported':'Recursos exportados','shares-imported':'Recursos importados','shares-paused-all':'Recursos pausados','shares-resumed-all':'Recursos reactivados','transfer-stopped':'Transferencia detenida','trash-purged':'Elemento eliminado definitivamente','trash-purged-all':'Papelera vaciada','upload-deduped':'Carga duplicada detectada','upload-folder-created':'Carpeta de carga creada','upload-infected':'Carga infectada','webhook-tested':'Webhook probado'}
  };
  var PWA_ACTIVITY_ACTIONS_EXTRA = {"fr":{"2fa-disabled":"2FA désactivée","2fa-enabled":"2FA activée","access-request-deleted":"Demande d’accès supprimée","account-created":"Compte créé","account-deleted":"Compte supprimé","account-renamed":"Compte renommé","collab-created":"Collaboration créée","collab-delete":"Fichier collaboratif supprimé","digest-tested":"Digest testé","enc-share-created":"Partage chiffré créé","leak-alert":"Alerte de fuite","login-2fa-fail":"Échec 2FA","notification-rule-created":"Règle de notification créée","notification-rule-deleted":"Règle de notification supprimée","notification-rule-reused":"Règle de notification réutilisée","notification-rule-updated":"Règle de notification modifiée","passkey-device-added":"Appareil biométrique ajouté","passkey-login-fail":"Échec de connexion par clé d’accès","passkey-removed":"Clé d’accès supprimée","passkeys-disabled":"Clés d’accès désactivées","password-changed":"Mot de passe changé","password-reset":"Mot de passe réinitialisé","pending-orphans-cleaned":"Dépôts orphelins nettoyés","photo-history-deleted":"Historique d’image supprimé","photo-history-purged":"Historique d’images purgé","push-subscribed":"Notifications push activées","push-unsubscribed":"Notifications push désactivées","pwa-login-bound":"Session PWA associée","ransomware-blocked":"Client bloqué (anomalie)","ransomware-unblocked":"Client débloqué","secret-created":"Secret créé","share-bandwidth-limit":"Limite de bande passante atteinte","share-burned":"Lien à usage unique consommé","share-comment-added":"Commentaire privé ajouté","share-comment-deleted":"Commentaire privé supprimé","share-emailed":"Partage envoyé par courriel","share-first-use-expiry-started":"Expiration au premier usage démarrée","share-visitor-limit":"Limite de visiteurs atteinte","shares-bulk":"Action en lot sur les partages","storage-connector-cancelled":"Opération de stockage annulée","storage-connector-created":"Connecteur de stockage créé","storage-connector-deleted":"Connecteur de stockage supprimé","storage-connector-done":"Opération de stockage terminée","storage-connector-download":"Téléchargement depuis le stockage terminé","storage-connector-failed":"Opération de stockage échouée","storage-connector-tested":"Connecteur de stockage testé","storage-connector-updated":"Connecteur de stockage modifié","storage-connector-upload":"Téléversement vers le stockage terminé","session-revoked":"Session déconnectée","diagnostic-fix-requested":"Correction diagnostic demandée","diagnostic-fix":"Correction diagnostic","diagnostic-fix-failed":"Échec de correction diagnostic","tls-refresh":"Renouvellement TLS","image-version-restored":"Version d’image restaurée","passkey-device-removed":"Appareil biométrique retiré"},"en":{"2fa-disabled":"2FA disabled","2fa-enabled":"2FA enabled","access-request-deleted":"Access request deleted","account-created":"Account created","account-deleted":"Account deleted","account-renamed":"Account renamed","collab-created":"Collaboration created","collab-delete":"Collaborative file deleted","digest-tested":"Digest tested","enc-share-created":"Encrypted share created","leak-alert":"Leak alert","login-2fa-fail":"2FA failed","notification-rule-created":"Notification rule created","notification-rule-deleted":"Notification rule deleted","notification-rule-reused":"Notification rule reused","notification-rule-updated":"Notification rule updated","passkey-device-added":"Biometric device added","passkey-login-fail":"Passkey login failed","passkey-removed":"Passkey removed","passkeys-disabled":"Passkeys disabled","password-changed":"Password changed","password-reset":"Password reset","pending-orphans-cleaned":"Orphan pending uploads cleaned","photo-history-deleted":"Image history deleted","photo-history-purged":"Image history purged","push-subscribed":"Push notifications enabled","push-unsubscribed":"Push notifications disabled","pwa-login-bound":"PWA session bound","ransomware-blocked":"Client blocked (anomaly)","ransomware-unblocked":"Client unblocked","secret-created":"Secret created","share-bandwidth-limit":"Share bandwidth limit reached","share-burned":"One-time link consumed","share-comment-added":"Private comment added","share-comment-deleted":"Private comment deleted","share-emailed":"Share emailed","share-first-use-expiry-started":"First-use expiry started","share-visitor-limit":"Visitor limit reached","shares-bulk":"Bulk share action","storage-connector-cancelled":"Storage operation cancelled","storage-connector-created":"Storage connector created","storage-connector-deleted":"Storage connector deleted","storage-connector-done":"Storage operation completed","storage-connector-download":"Storage download completed","storage-connector-failed":"Storage operation failed","storage-connector-tested":"Storage connector tested","storage-connector-updated":"Storage connector updated","storage-connector-upload":"Storage upload completed","session-revoked":"Session signed out","diagnostic-fix-requested":"Diagnostic fix requested","diagnostic-fix":"Diagnostic fix","diagnostic-fix-failed":"Diagnostic fix failed","tls-refresh":"TLS refresh","image-version-restored":"Image version restored","passkey-device-removed":"Biometric device removed"},"es":{"2fa-disabled":"2FA desactivada","2fa-enabled":"2FA activada","access-request-deleted":"Solicitud de acceso eliminada","account-created":"Cuenta creada","account-deleted":"Cuenta eliminada","account-renamed":"Cuenta renombrada","collab-created":"Colaboración creada","collab-delete":"Archivo colaborativo eliminado","digest-tested":"Resumen probado","enc-share-created":"Recurso cifrado creado","leak-alert":"Alerta de fuga","login-2fa-fail":"2FA fallido","notification-rule-created":"Regla de notificación creada","notification-rule-deleted":"Regla de notificación eliminada","notification-rule-reused":"Regla de notificación reutilizada","notification-rule-updated":"Regla de notificación modificada","passkey-device-added":"Dispositivo biométrico añadido","passkey-login-fail":"Fallo de inicio con clave de acceso","passkey-removed":"Clave de acceso eliminada","passkeys-disabled":"Claves de acceso desactivadas","password-changed":"Contraseña cambiada","password-reset":"Contraseña restablecida","pending-orphans-cleaned":"Cargas pendientes huérfanas limpiadas","photo-history-deleted":"Historial de imagen eliminado","photo-history-purged":"Historial de imágenes purgado","push-subscribed":"Notificaciones push activadas","push-unsubscribed":"Notificaciones push desactivadas","pwa-login-bound":"Sesión PWA vinculada","ransomware-blocked":"Cliente bloqueado (anomalía)","ransomware-unblocked":"Cliente desbloqueado","secret-created":"Secreto creado","share-bandwidth-limit":"Límite de ancho de banda alcanzado","share-burned":"Enlace de un solo uso consumido","share-comment-added":"Comentario privado añadido","share-comment-deleted":"Comentario privado eliminado","share-emailed":"Recurso enviado por correo","share-first-use-expiry-started":"Caducidad tras primer uso iniciada","share-visitor-limit":"Límite de visitantes alcanzado","shares-bulk":"Acción masiva sobre recursos","storage-connector-cancelled":"Operación de almacenamiento cancelada","storage-connector-created":"Conector de almacenamiento creado","storage-connector-deleted":"Conector de almacenamiento eliminado","storage-connector-done":"Operación de almacenamiento completada","storage-connector-download":"Descarga desde el almacenamiento completada","storage-connector-failed":"Operación de almacenamiento fallida","storage-connector-tested":"Conector de almacenamiento probado","storage-connector-updated":"Conector de almacenamiento modificado","storage-connector-upload":"Carga al almacenamiento completada","session-revoked":"Sesión cerrada","diagnostic-fix-requested":"Corrección de diagnóstico solicitada","diagnostic-fix":"Corrección de diagnóstico","diagnostic-fix-failed":"Error de corrección de diagnóstico","tls-refresh":"Renovación TLS","image-version-restored":"Versión de imagen restaurada","passkey-device-removed":"Dispositivo biométrico eliminado"}};
  function pwaActivityActionLabel(action){var key=String(action||''),dict=PWA_ACTIVITY_ACTIONS[lang]||PWA_ACTIVITY_ACTIONS.en,extra=PWA_ACTIVITY_ACTIONS_EXTRA[lang]||PWA_ACTIVITY_ACTIONS_EXTRA.en;return dict[key]||extra[key]||key.replace(/-/g,' ');}
  var PWA_ACTIVITY_TEXT_EXTRA = {"fr":{"queued":"en file","pending":"en attente","paused-all":"tous mis en pause","resumed-all":"tous réactivés","thread-reply":"réponse à la discussion","access-request":"demande d’accès","feedback":"commentaire","message":"message"},"en":{"queued":"queued","pending":"pending","paused-all":"all paused","resumed-all":"all resumed","thread-reply":"thread reply","access-request":"access request","feedback":"feedback","message":"message"},"es":{"queued":"en cola","pending":"pendiente","paused-all":"todos pausados","resumed-all":"todos reanudados","thread-reply":"respuesta a la conversación","access-request":"solicitud de acceso","feedback":"comentario","message":"mensaje"}};

  var PWA_STRUCTURED_LOG_TEXT = {
    fr:{'session-revoked':'Session de {username} déconnectée ({device})','diagnostic-fix-requested':'Correction diagnostic « {action} » demandée','dlp-result':'DLP {source} : {count} détection(s), niveau {highest} · {types}','diagnostics-run':'Diagnostic : {ok} OK, {warn} avertissement(s), {bad} erreur(s)','diagnostic-fix':'Correction diagnostic « {action} » appliquée','diagnostic-fix-failed':'Correction diagnostic « {action} » échouée : {error}'},
    en:{'session-revoked':'Signed out {username} session ({device})','diagnostic-fix-requested':'Diagnostic fix “{action}” requested','dlp-result':'DLP {source}: {count} finding(s), severity {highest} · {types}','diagnostics-run':'Diagnostics: {ok} OK, {warn} warning(s), {bad} error(s)','diagnostic-fix':'Diagnostic fix “{action}” applied','diagnostic-fix-failed':'Diagnostic fix “{action}” failed: {error}'},
    es:{'session-revoked':'Sesión de {username} cerrada ({device})','diagnostic-fix-requested':'Corrección de diagnóstico «{action}» solicitada','dlp-result':'DLP {source}: {count} detección(es), gravedad {highest} · {types}','diagnostics-run':'Diagnóstico: {ok} OK, {warn} aviso(s), {bad} error(es)','diagnostic-fix':'Corrección de diagnóstico «{action}» aplicada','diagnostic-fix-failed':'Corrección de diagnóstico «{action}» fallida: {error}'}
  };
  function pwaStructuredLogParams(code, params) {
    var out = Object.assign({}, params && typeof params === 'object' ? params : {}), sev;
    if (code === 'dlp-result') {
      sev = { low:'dlpSeverityLow', medium:'dlpSeverityMedium', high:'dlpSeverityHigh', critical:'dlpSeverityCritical' };
      if (out.highest === 'none') out.highest = '—'; else if (sev[String(out.highest || '')]) out.highest = t(sev[String(out.highest)]);
      if (out.types) out.types = String(out.types).split(/,\s*/).filter(Boolean).map(function (v) { return pwaDlpRuleLabel(v); }).join(', ');
    }
    if ((code === 'diagnostic-fix-requested' || code === 'diagnostic-fix' || code === 'diagnostic-fix-failed') && out.action) out.action = pwaActivityActionLabel(String(out.action));
    return out;
  }
  function pwaStructuredLogText(raw) {
    if (String(raw || '').indexOf('@dxlog:') !== 0) return null;
    try {
      var rec = JSON.parse(String(raw).slice(7)), code = String(rec.code || ''), params = pwaStructuredLogParams(code, rec.params || {}), template = (PWA_STRUCTURED_LOG_TEXT[lang] || PWA_STRUCTURED_LOG_TEXT.en)[code];
      if (template) return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, function (_, key) { var v = params[key]; return v === null || v === undefined ? '' : String(v); });
      if (rec.fallback) return String(rec.fallback);
    } catch (_) {}
    return null;
  }
  function pwaLocalizedActivityText(value){
    if(value===null||value===undefined)return '';
    var raw=String(value), structured=pwaStructuredLogText(raw); if(structured!==null)return structured;
    var maps={
      fr:{active:'actif',completed:'terminé',interrupted:'interrompu',deleted:'supprimé',restored:'restauré',purged:'supprimé définitivement',reactivated:'réactivé',clean:'sain',infected:'infecté',error:'erreur',restarted:'redémarré',recovered:'récupéré',updated:'mis à jour','locked-out':'verrouillé après trop d’essais','paired device':'appareil appairé','new device':'nouvel appareil','known device':'appareil connu','device renamed':'appareil renommé','PWA session locked':'session PWA verrouillée','manual rebuild requested':'réindexation manuelle demandée','visitor message':'message visiteur','visitor thread reply':'réponse du visiteur','access request submitted':'demande d’accès envoyée','feedback submitted':'feedback envoyé','Content modified':'Contenu modifié',failed:'échec',open:'ouvert',closed:'fermé',unknown:'inconnu'},
      en:{active:'active',completed:'completed',interrupted:'interrupted',deleted:'deleted',restored:'restored',purged:'permanently deleted',reactivated:'reactivated',clean:'clean',infected:'infected',error:'error',restarted:'restarted',recovered:'recovered',updated:'updated','locked-out':'locked after too many attempts','paired device':'paired device','new device':'new device','known device':'known device','device renamed':'device renamed','PWA session locked':'PWA session locked','manual rebuild requested':'manual reindex requested','visitor message':'visitor message','visitor thread reply':'visitor thread reply','access request submitted':'access request submitted','feedback submitted':'feedback submitted','Contenu modifié':'Content modified',failed:'failed',open:'open',closed:'closed',unknown:'unknown'},
      es:{active:'activo',completed:'completado',interrupted:'interrumpido',deleted:'eliminado',restored:'restaurado',purged:'eliminado definitivamente',reactivated:'reactivado',clean:'limpio',infected:'infectado',error:'error',restarted:'reiniciado',recovered:'recuperado',updated:'actualizado','locked-out':'bloqueado tras demasiados intentos','paired device':'dispositivo emparejado','new device':'nuevo dispositivo','known device':'dispositivo conocido','device renamed':'dispositivo renombrado','PWA session locked':'sesión PWA bloqueada','manual rebuild requested':'reindexación manual solicitada','visitor message':'mensaje del visitante','visitor thread reply':'respuesta del visitante','access request submitted':'solicitud de acceso enviada','feedback submitted':'comentario enviado','Content modified':'Contenido modificado','Contenu modifié':'Contenido modificado',failed:'fallido',open:'abierto',closed:'cerrado',unknown:'desconocido'}
    }, exact=maps[lang]||maps.en, extra=PWA_ACTIVITY_TEXT_EXTRA[lang]||PWA_ACTIVITY_TEXT_EXTRA.en;
    if(Object.prototype.hasOwnProperty.call(exact,raw))return exact[raw];
    if(Object.prototype.hasOwnProperty.call(extra,raw))return extra[raw];
    var via=raw.match(/^via PWA\s*[—-]\s*(.*)$/i); if(via)return (lang==='fr'?'via PWA — ':lang==='es'?'vía PWA — ':'via PWA — ')+pwaLocalizedActivityText(via[1]);
    var count=raw.match(/^(\d+) (link|share|image|message|record|key|credential)\(s\)$/i); if(count){var nouns={fr:{link:'lien',share:'partage',image:'image',message:'message',record:'entrée',key:'clé',credential:'identifiant'},en:{link:'link',share:'share',image:'image',message:'message',record:'record',key:'key',credential:'credential'},es:{link:'enlace',share:'recurso',image:'imagen',message:'mensaje',record:'registro',key:'clave',credential:'credencial'}},noun=(nouns[lang]||nouns.en)[count[2].toLowerCase()]||count[2];return count[1]+' '+noun+'(s)';}
    var sent=raw.match(/^sent=(\d+)$/i); if(sent)return lang==='fr'?sent[1]+' envoyé(s)':lang==='es'?sent[1]+' enviado(s)':sent[1]+' sent';
    var diag=raw.match(/^ok=(\d+)\s+warn=(\d+)\s+bad=(\d+)$/i); if(diag)return lang==='fr'?diag[1]+' OK · '+diag[2]+' avertissement(s) · '+diag[3]+' erreur(s)':lang==='es'?diag[1]+' OK · '+diag[2]+' advertencia(s) · '+diag[3]+' error(es)':diag[1]+' OK · '+diag[2]+' warning(s) · '+diag[3]+' error(s)';
    var failedCount=raw.match(/^(\d+);\s*failed=(\d+)$/i); if(failedCount)return lang==='fr'?failedCount[1]+' traité(s) · '+failedCount[2]+' échec(s)':lang==='es'?failedCount[1]+' procesado(s) · '+failedCount[2]+' fallo(s)':failedCount[1]+' processed · '+failedCount[2]+' failed';
    var migrated=raw.match(/^migrated=(\d+)$/i); if(migrated)return lang==='fr'?migrated[1]+' migré(s)':lang==='es'?migrated[1]+' migrado(s)':migrated[1]+' migrated';
    raw=raw.replace(/\bPLAINTEXT\b/g,lang==='fr'?'NON CHIFFRÉ':lang==='es'?'SIN CIFRAR':'PLAINTEXT');
    raw=raw.replace(/\bencrypted\b/gi,lang==='fr'?'chiffré':lang==='es'?'cifrado':'encrypted');
    raw=raw.replace(/\bfailed=(\d+)\b/gi,function(_,n){return lang==='fr'?'échecs='+n:lang==='es'?'fallos='+n:'failed='+n;});
    raw=raw.replace(/\btransferredShares=(\d+)\b/gi,function(_,n){return lang==='fr'?'partages transférés='+n:lang==='es'?'recursos transferidos='+n:'transferred shares='+n;});
    raw=raw.replace(/\bpwaDevices=(\d+)\b/gi,function(_,n){return lang==='fr'?'appareils PWA='+n:lang==='es'?'dispositivos PWA='+n:'PWA devices='+n;});
    raw=raw.replace(/\bpairingTickets=(\d+)\b/gi,function(_,n){return lang==='fr'?'tickets d’appairage='+n:lang==='es'?'tickets de emparejamiento='+n:'pairing tickets='+n;});
    raw=raw.replace(/\bpush-scopes=(\d+)\b/gi,function(_,n){return lang==='fr'?'portées push='+n:lang==='es'?'ámbitos push='+n:'push scopes='+n;});
    raw=raw.replace(/\bone-time link\b/gi,lang==='fr'?'lien à usage unique':lang==='es'?'enlace de un solo uso':'one-time link');
    raw=raw.replace(/\bfinding\(s\)\b/gi,lang==='fr'?'détection(s)':lang==='es'?'detección(es)':'finding(s)');
    return raw;
  }
  function pwaLocalizedActivityName(e){var raw=String(e&&e.name||e&&e.kind||'event'), known={'server-restarted':{fr:'Serveur redémarré',en:'Server restarted',es:'Servidor reiniciado'},'server-shutdown':{fr:'Serveur arrêté',en:'Server shutdown',es:'Servidor detenido'},'server-crash-recovered':{fr:'Récupération après arrêt anormal',en:'Recovered after abnormal shutdown',es:'Recuperación tras cierre anómalo'},'update-installed':{fr:'Mise à jour installée',en:'Update installed',es:'Actualización instalada'},'index-failed':{fr:'Échec de l’indexation',en:'Indexing failed',es:'Error de indexación'},'feedback submitted':{fr:'Feedback envoyé',en:'Feedback submitted',es:'Comentario enviado'},'visitor thread reply':{fr:'Réponse du visiteur',en:'Visitor thread reply',es:'Respuesta del visitante'}};if(known[raw])return known[raw][lang]||known[raw].en;if((e&&e.kind)==='audit'||PWA_ACTIVITY_ACTIONS.fr[raw]||PWA_ACTIVITY_ACTIONS.en[raw]||PWA_ACTIVITY_ACTIONS_EXTRA.fr[raw]||PWA_ACTIVITY_ACTIONS_EXTRA.en[raw])return pwaActivityActionLabel(raw);return raw;}

  function pwaServerActivitySearchText(e) {
    return [pwaLocalizedActivityName(e),e && e.kind,pwaLocalizedActivityText(e && e.status),pwaLocalizedActivityText(e && e.detail),e && e.ip,e && e.direction,e && e.shareId,e && e.actor,e && e.accountId,e && e.deviceId].filter(Boolean).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase(lang === 'fr' ? 'fr-CA' : lang === 'es' ? 'es-ES' : 'en-US');
  }
  function pwaServerActivityIsPwa(e){return !!(e&&(e.source==='pwa'||e.deviceId||/^PWA(?::|$)/i.test(String(e.actor||''))||/via PWA/i.test(String(e.detail||''))));}
  function pwaServerActivityIsImage(e){if(!e)return false;var action=String(e.name||e.status||'');if(/^(photo|photos|image|album)(?:-|$)/i.test(action))return true;if(/^(photo|album)$/i.test(String(e.resourceType||e.detail||'')))return true;return false;}
  function pwaServerActivityIsRoutine(e){var n=String(e&&e.name||'').toLowerCase(),k=String(e&&e.kind||'').toLowerCase();return k==='ocr-start'||k==='ocr-complete'||n==='server-restarted'||n==='server-shutdown';}
  function refreshPwaActivityShareOptions(){var sel=$('server-activity-share');if(!sel)return;var current=sel.value,map={};serverActivityEvents.forEach(function(e){if(e&&e.shareId&&!map[e.shareId])map[e.shareId]=e.shareName||e.name||e.shareId;});sel.innerHTML='';var all=document.createElement('option');all.value='';all.textContent=t('serverActivityShareAll');sel.appendChild(all);Object.keys(map).sort(function(a,b){return String(map[a]).localeCompare(String(map[b]));}).forEach(function(id){var o=document.createElement('option');o.value=id;o.textContent=map[id]+' · '+id.slice(0,8);sel.appendChild(o);});if([].slice.call(sel.options).some(function(o){return o.value===current;}))sel.value=current;}
  function pwaActivityResultMatches(e,want){if(!want)return true;var text=String([e&&e.status,e&&e.detail,e&&e.name].filter(Boolean).join(' ')).toLowerCase();if(want==='ok')return /ok|done|complete|completed|success|created|updated|sent|ready/.test(text);if(want==='error')return /error|fail|failed|interrupt|abandon|blocked|denied|impossible/.test(text);if(want==='restored')return /restor|reactivat/.test(text);if(want==='deleted')return /delete|deleted|purge|purged|revok|trash/.test(text);return text.indexOf(String(want).toLowerCase())!==-1;}
  function pwaLiveTransferDuration(ms) {
    return fmtClock(Math.max(0, Number(ms) || 0) / 1000);
  }
  function samplePwaLiveTransfers(rows, generatedAt) {
    var at = Math.max(1, Number(generatedAt) || Date.now());
    var next = Object.create(null);
    rows.forEach(function (tf) {
      if (!tf || !tf.id) return;
      var bytes = Math.max(0, Number(tf.bytes) || 0);
      var zipBytes = Math.max(0, Number(tf.zipProcessedBytes) || 0);
      var prev = pwaLiveTransferSamples[tf.id];
      var liveBps = Math.max(0, Number(tf.avgBps) || 0);
      var liveZipBps = Number(tf.durationMs) > 0 ? (zipBytes / Number(tf.durationMs)) * 1000 : 0;
      if (prev && at > prev.at) {
        var elapsed = (at - prev.at) / 1000;
        if (elapsed >= 0.2 && bytes >= prev.bytes) liveBps = Math.max(0, Math.round((bytes - prev.bytes) / elapsed));
        if (elapsed >= 0.2 && zipBytes >= prev.zipBytes) liveZipBps = Math.max(0, Math.round((zipBytes - prev.zipBytes) / elapsed));
      }
      if (tf.stalled) { liveBps = 0; liveZipBps = 0; }
      tf.liveBps = liveBps;
      tf.liveZipBps = liveZipBps;
      next[tf.id] = { at:at, bytes:bytes, zipBytes:zipBytes };
    });
    pwaLiveTransferSamples = next;
    return rows;
  }
  function renderPwaLiveTransfers() {
    var list = $('pwa-live-transfers-list'); if (!list) return;
    // The list refreshes every two seconds. Preserve keyboard focus across DOM
    // replacement and keep the rapidly changing rows out of ARIA live regions,
    // otherwise a focused Stop control vanishes and screen readers re-announce the
    // complete transfer list on every poll.
    var focusedTransferId = '';
    var focused = document.activeElement;
    if (focused && focused.classList && focused.classList.contains('pwa-live-stop') && focused.closest) {
      var focusedRow = focused.closest('.pwa-live-transfer');
      if (focusedRow) focusedTransferId = String(focusedRow.getAttribute('data-transfer-id') || '');
    }
    list.innerHTML = '';
    list.setAttribute('aria-busy', pwaLiveTransfersLoading ? 'true' : 'false');
    var count = $('pwa-live-transfers-count'); if (count) count.textContent = String(pwaLiveTransfers.length);
    var section = list.closest ? list.closest('.pwa-live-transfers') : null;
    var liveDot = section && section.querySelector ? section.querySelector('.live-dot') : null;
    if (liveDot) {
      liveDot.classList.toggle('offline', !!pwaLiveTransfersError);
      liveDot.title = pwaLiveTransfersError ? t('liveTransfersOffline') : t('liveTransfersTitle');
    }
    var updated = $('pwa-live-transfers-updated');
    if (updated) {
      if (pwaLiveTransfersError) updated.textContent = t('liveTransfersLoadFail');
      else if (pwaLiveTransfersGeneratedAt) {
        var stamp = '—'; try { stamp = new Date(pwaLiveTransfersGeneratedAt).toLocaleTimeString(lang === 'fr' ? 'fr-CA' : lang === 'es' ? 'es-ES' : 'en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' }); } catch (_) {}
        updated.textContent = t('liveTransfersUpdated', { time:stamp });
      } else updated.textContent = '';
    }
    if (!pwaLiveTransfers.length) {
      var empty = document.createElement('div'); empty.className = 'pwa-live-transfers-empty sm'; empty.textContent = pwaLiveTransfersError ? t('liveTransfersLoadFail') : (pwaLiveTransfersLoading ? t('liveTransfersLoading') : t('liveTransfersEmpty')); list.appendChild(empty); return;
    }
    pwaLiveTransfers.forEach(function (tf) {
      var up = tf.direction === 'up', isZip = !!tf.isZip, feedOffline = !!pwaLiveTransfersError;
      var total = Math.max(0, Number(tf.expectedBytes) || 0), done = Math.max(0, Number(tf.bytes) || 0);
      // A failed poll leaves the last successful snapshot visible for context, but
      // stale throughput/ETA and mutation controls must not masquerade as live data.
      var displayBps = feedOffline ? 0 : Math.max(0, Number(tf.liveBps != null ? tf.liveBps : tf.avgBps) || 0);
      var etaBps = displayBps;
      if (isZip && Number(tf.zipTotalBytes) > 0) { total = Number(tf.zipTotalBytes) || 0; done = Math.max(0, Number(tf.zipProcessedBytes) || 0); etaBps = Math.max(0, Number(tf.liveZipBps) || 0); }
      var pct = total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : null;
      var row = document.createElement('div'); row.className = 'pwa-live-transfer' + (tf.stalled ? ' stalled' : '') + (tf.stopping ? ' stopping' : '') + (feedOffline ? ' offline' : ''); row.setAttribute('data-transfer-id', String(tf.id || ''));
      var flag = document.createElement('span'); flag.className = 'pwa-live-flag'; flag.textContent = tf.flag || '🌐'; row.appendChild(flag);
      var main = document.createElement('div'); main.className = 'pwa-live-main';
      var name = document.createElement('div'); name.className = 'pwa-live-name';
      var ico = document.createElement('span'); ico.textContent = up ? '📥' : (isZip ? '🗜️' : '📄'); name.appendChild(ico);
      var nameText = document.createElement('span'); nameText.className = 'pwa-live-name-text'; nameText.textContent = tf.name || '—'; name.appendChild(nameText);
      if (tf.resumed) { var resumed = document.createElement('span'); resumed.className = 'pwa-live-resumed'; resumed.textContent = t('liveTransfersResumed'); name.appendChild(resumed); }
      if (tf.stalled) { var stalled = document.createElement('span'); stalled.className = 'pwa-live-stalled'; stalled.textContent = t('liveTransfersStalled'); name.appendChild(stalled); }
      if (tf.stopping) { var stopping = document.createElement('span'); stopping.className = 'pwa-live-stopping'; stopping.textContent = t('liveTransfersStopping'); name.appendChild(stopping); }
      if (feedOffline) { var stale = document.createElement('span'); stale.className = 'pwa-live-stale'; stale.textContent = t('liveTransfersStale'); name.appendChild(stale); }
      main.appendChild(name);
      if (pct !== null) {
        var bar = document.createElement('div'); bar.className = 'pwa-live-progress'; bar.setAttribute('role','progressbar'); bar.setAttribute('aria-valuemin','0'); bar.setAttribute('aria-valuemax','100'); bar.setAttribute('aria-valuenow',String(pct));
        var fill = document.createElement('i'); fill.style.width = pct + '%'; bar.appendChild(fill); main.appendChild(bar);
      }
      var meta = document.createElement('div'); meta.className = 'pwa-live-meta';
      var who = [tf.ipName, tf.ip].filter(Boolean).join(' · '); if (who) { var ip = document.createElement('span'); ip.textContent = who; meta.appendChild(ip); }
      if (tf.country) { var country = document.createElement('span'); country.textContent = tf.country; meta.appendChild(country); }
      var speed = document.createElement('span'); speed.textContent = (up ? '↑ ' : '↓ ') + fmtBytes(displayBps) + '/s'; meta.appendChild(speed);
      var volume = document.createElement('span'); volume.textContent = pct === null ? fmtBytes(done) : fmtBytes(done) + ' / ' + fmtBytes(total) + ' (' + pct + '%)'; meta.appendChild(volume);
      if (pct !== null && etaBps > 0 && done < total) { var eta = document.createElement('span'); eta.textContent = '⏳ ' + fmtEta((total - done) / etaBps) + ' ' + t('liveTransfersRemaining'); meta.appendChild(eta); }
      var elapsed = document.createElement('span'); elapsed.textContent = '⏱ ' + pwaLiveTransferDuration(tf.durationMs); meta.appendChild(elapsed);
      main.appendChild(meta); row.appendChild(main);
      if (tf.canStop && !feedOffline) { var stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn danger pwa-live-stop'; stop.textContent = '✕'; stop.title = t('liveTransfersStop'); stop.setAttribute('aria-label', t('liveTransfersStop')); stop.addEventListener('click', function () { stopPwaLiveTransfer(tf, stop); }); row.appendChild(stop); }
      list.appendChild(row);
    });
    if (focusedTransferId) {
      var candidates = list.querySelectorAll('.pwa-live-transfer');
      for (var fi = 0; fi < candidates.length; fi += 1) {
        if (String(candidates[fi].getAttribute('data-transfer-id') || '') !== focusedTransferId) continue;
        var restored = candidates[fi].querySelector('.pwa-live-stop');
        if (restored) { try { restored.focus({ preventScroll:true }); } catch (_) { try { restored.focus(); } catch (_) {} } }
        break;
      }
    }
  }
  function cancelPwaLiveTransferLoad() {
    pwaLiveTransfersRequestSeq += 1;
    if (pwaLiveTransfersRequestController) { try { pwaLiveTransfersRequestController.abort(); } catch (_) {} }
    pwaLiveTransfersRequestController = null;
    pwaLiveTransfersLoading = false;
  }
  async function loadPwaLiveTransfers(force) {
    if (pwaLiveTransfersLoading && !force) return false;
    if (force && pwaLiveTransfersRequestController) { try { pwaLiveTransfersRequestController.abort(); } catch (_) {} }
    var seq = ++pwaLiveTransfersRequestSeq;
    var controller = window.AbortController ? new AbortController() : null;
    pwaLiveTransfersRequestController = controller;
    pwaLiveTransfersLoading = true;
    if (force || !pwaLiveTransfers.length) renderPwaLiveTransfers();
    try {
      var r = await fetchWithTimeout('/app/activity/transfers', { credentials:'same-origin', cache:'no-store', signal:controller ? controller.signal : undefined }, 7000);
      if (seq !== pwaLiveTransfersRequestSeq) return false;
      if (!r.ok) throw new Error('transfers-' + r.status);
      var data = await r.json();
      if (seq !== pwaLiveTransfersRequestSeq) return false;
      pwaLiveTransfersGeneratedAt = Math.max(0, Number(data.generatedAt) || Date.now());
      pwaLiveTransfers = samplePwaLiveTransfers(Array.isArray(data.transfers) ? data.transfers : [], pwaLiveTransfersGeneratedAt);
      pwaLiveTransfersError = false;
      return true;
    } catch (_) {
      if (seq === pwaLiveTransfersRequestSeq) {
        pwaLiveTransfersError = true;
        // Do not calculate an apparent "instantaneous" speed across an outage.
        // The first good snapshot after reconnect starts a fresh sampling window.
        pwaLiveTransferSamples = Object.create(null);
      }
      return false;
    } finally {
      if (seq === pwaLiveTransfersRequestSeq) {
        pwaLiveTransfersLoading = false;
        pwaLiveTransfersRequestController = null;
        renderPwaLiveTransfers();
      }
    }
  }
  async function stopPwaLiveTransfer(tf, button) {
    if (!tf || !tf.id || !window.confirm(t('liveTransfersStopConfirm'))) return;
    var previousCanStop = !!tf.canStop;
    tf.canStop = false; tf.stopping = true;
    if (button) button.disabled = true;
    renderPwaLiveTransfers();
    try {
      var r = await appMutate('/app/activity/transfers/' + encodeURIComponent(tf.id) + '/stop', 'application/json', '{}', { timeoutMs:8000 });
      if (r.status === 404) { await loadPwaLiveTransfers(true); return; }
      if (!r.ok) throw new Error('stop-' + r.status);
      toast(t('liveTransfersStopOk'), 'ok');
      await loadPwaLiveTransfers(true);
      loadPwaServerActivity(true).catch(function () {});
    } catch (_) {
      tf.stopping = false; tf.canStop = previousCanStop;
      toast(t('liveTransfersStopFail'), 'err');
      if (button) button.disabled = false;
      renderPwaLiveTransfers();
    }
  }

  function renderPwaServerActivity() {
    var list = $('server-activity-list'); if (!list) return;
    refreshPwaActivityShareOptions(); list.innerHTML = '';
    var locale = lang === 'fr' ? 'fr-CA' : lang === 'es' ? 'es-ES' : 'en-US';
    var q = String($('server-activity-search') && $('server-activity-search').value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLocaleLowerCase(locale);
    var kind = String($('server-activity-kind') && $('server-activity-kind').value || '');
    var normActivity=function(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLocaleLowerCase(locale);};
    var share = String($('server-activity-share') && $('server-activity-share').value || ''), actor=normActivity($('server-activity-actor')&&$('server-activity-actor').value), ip=normActivity($('server-activity-ip')&&$('server-activity-ip').value), device=String($('server-activity-device')&&$('server-activity-device').value||''), result=normActivity($('server-activity-result')&&$('server-activity-result').value), direction=String($('server-activity-direction')&&$('server-activity-direction').value||''), period=Math.max(0,Number($('server-activity-period')&&$('server-activity-period').value||0)), cutoff=period?Date.now()-period*3600000:0;
    var imagesOnly=!!($('server-activity-images')&&$('server-activity-images').checked), pwaOnly=!!($('server-activity-pwa')&&$('server-activity-pwa').checked), hideRoutine=!!($('server-activity-hide-routine')&&$('server-activity-hide-routine').checked);
    var rows = serverActivityEvents.filter(function (e) { return (!kind || pwaServerActivityGroup(e) === kind) && (!share || String(e.shareId||'')===share) && (!device||String(e.source||'')===device) && (!direction||e.direction===direction) && (!cutoff||Number(e.at)>=cutoff) && (!actor||normActivity((e.actor||'')+' '+(e.accountId||'')).indexOf(actor)!==-1) && (!ip||normActivity(e.ip).indexOf(ip)!==-1) && pwaActivityResultMatches(e,result) && (!imagesOnly || pwaServerActivityIsImage(e)) && (!pwaOnly || pwaServerActivityIsPwa(e)) && (!hideRoutine || !pwaServerActivityIsRoutine(e)) && (!q || pwaServerActivitySearchText(e).indexOf(q) !== -1); });
    if (!rows.length) { var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = t('serverActivityEmpty'); list.appendChild(empty); }
    var correlate=!!($('server-activity-correlate')&&$('server-activity-correlate').checked), rendered=rows.slice(0,1000),lastCorrelation=null,correlationCounts=Object.create(null);
    if(correlate){var latestByCorrelation=Object.create(null);rendered.forEach(function(e){var k=String(e.correlationId||e.shareId||('single:'+e.id)),at=Number(e.at)||0;latestByCorrelation[k]=Math.max(latestByCorrelation[k]||0,at);var visibleKey=String(e.correlationId||e.shareId||'');if(visibleKey)correlationCounts[visibleKey]=(correlationCounts[visibleKey]||0)+1;});rendered.sort(function(a,b){var ak=String(a.correlationId||a.shareId||('single:'+a.id)),bk=String(b.correlationId||b.shareId||('single:'+b.id));if(ak===bk)return Number(a.at)-Number(b.at);return Number(latestByCorrelation[bk]||0)-Number(latestByCorrelation[ak]||0)||ak.localeCompare(bk);});}
    rendered.forEach(function (e) {
      var correlation=String(e.correlationId||e.shareId||'');if(correlate&&correlation&&correlation!==lastCorrelation){var gh=document.createElement('div');gh.className='server-activity-group-head';gh.textContent=(e.shareName||e.name||correlation)+' · '+String(correlationCounts[correlation]||1);list.appendChild(gh);lastCorrelation=correlation;}
      var row = document.createElement('div'); row.className = 'history-row server-activity-row ' + String(e.kind || '');
      var icon = document.createElement('span'); icon.className = 'server-activity-icon'; icon.textContent = pwaServerActivityIcon(e); row.appendChild(icon);
      var main = document.createElement('div'); main.className = 'history-main';
      var strong = document.createElement('strong'); strong.textContent = pwaLocalizedActivityName(e); main.appendChild(strong);
      var metaParts = [];
      if (e.direction === 'up') metaParts.push('⬆'); else if (e.direction === 'down') metaParts.push('⬇');
      if (e.bytes) metaParts.push(fmtBytes(e.bytes));
      if (e.status) metaParts.push(pwaLocalizedActivityText(e.status));
      if (e.ip) metaParts.push(e.ip);
      if (e.detail) metaParts.push(pwaLocalizedActivityText(e.detail));
      var meta = document.createElement('div'); meta.className = 'history-meta'; meta.textContent = metaParts.filter(Boolean).join(' · '); main.appendChild(meta);
      row.appendChild(main);
      var time = document.createElement('time');
      if (e.at) { time.textContent = fmtRelative(e.at); try { time.title = new Date(Number(e.at)).toLocaleString(locale); } catch (_) {} } else time.textContent = '—';
      row.appendChild(time);
      list.appendChild(row);
    });
    var count = $('server-activity-count'); if (count) count.textContent = String(Number(serverActivityRetained) || serverActivityEvents.length || 0);
    var summary = $('server-activity-summary'); if (summary) summary.textContent = t('serverActivitySummary', { shown: Math.min(rows.length, 1000), total: serverActivityEvents.length });
    updatePwaNavBadges();
  }
  async function loadPwaServerActivity(force) {
    if (serverActivityLoading && !force) return;
    serverActivityLoading = true;
    var status = $('server-activity-status'); if (status) status.textContent = t('serverActivityLoading');
    try {
      var r = await fetch('/app/activity/recent?limit=1000', { credentials:'same-origin', cache:'no-store' });
      if (!r.ok) throw new Error('activity-' + r.status);
      var data = await r.json();
      serverActivityEvents = Array.isArray(data.events) ? data.events.slice(0, 1000) : [];
      serverActivityRetained = Math.max(0, Number(data.retained) || serverActivityEvents.length);
      if (status) status.textContent = '';
      renderPwaServerActivity();
    } catch (_) {
      if (status) status.textContent = t('serverActivityLoadFail');
      if (!serverActivityEvents.length) renderPwaServerActivity();
    } finally { serverActivityLoading = false; }
  }
  var pwaActivityRefreshTimer = null;
  var pwaLiveTransfersTimer = null;
  var PWA_LIVE_TRANSFERS_POLL_MS = 5000;
  function startPwaActivityRefresh() {
    if (!pwaActivityRefreshTimer) pwaActivityRefreshTimer = setInterval(function () {
      if (activePwaPanel === 'activity' && document.visibilityState !== 'hidden') loadPwaServerActivity(false).catch(function () {});
    }, 10000);
    if (!pwaLiveTransfersTimer) pwaLiveTransfersTimer = setInterval(function () {
      if (activePwaPanel === 'activity' && document.visibilityState !== 'hidden') loadPwaLiveTransfers(false).catch(function () {});
    }, PWA_LIVE_TRANSFERS_POLL_MS);
  }
  function stopPwaActivityRefresh() {
    if (pwaActivityRefreshTimer) { clearInterval(pwaActivityRefreshTimer); pwaActivityRefreshTimer = null; }
    if (pwaLiveTransfersTimer) { clearInterval(pwaLiveTransfersTimer); pwaLiveTransfersTimer = null; }
    cancelPwaLiveTransferLoad();
  }

  function resendFromHistory(h) {
    var dest = (h.destToken && findDest(h.destToken)) ||
      (h.destination && allDests().find(function (d) { return (d.name || '') === h.destination; })) || null;
    if (!dest) { toast(t('historyDestGone'), 'warn'); return; }
    activatePwaPanel('send');
    var sel = $('dest-select');
    if (sel) { sel.value = dest.token; setActiveToken(sel.value); $('enc-key').value = ''; $('enc-passphrase').value = ''; refreshDestStatus(); }
    toast(t('resendReady'), 'ok');
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
      var metaText = (h.note ? '🏷 ' + h.note + ' · ' : '') + fmtBytes(h.size) + ' · ' + t('historyDest', { dest: h.destination }) + ' · ' + fmtRelative(h.at);
      if (h.rate > 0) metaText += ' · ' + t('rateAvg', { rate: fmtBytes(h.rate) });
      var meta = document.createElement('div'); meta.className = 'history-meta'; meta.textContent = metaText; main.appendChild(meta);
      row.appendChild(main);
      var actions = document.createElement('div'); actions.className = 'history-actions';
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'icon-action'; copy.textContent = '⧉'; copy.title = t('historyCopy'); copy.setAttribute('aria-label', t('historyCopy'));
      copy.addEventListener('click', function () { copyText(privacyNames ? [privateFileName(historyIndex), fmtBytes(h.size), t('historyDest', { dest: h.destination }), fmtDate(h.at)].join(' · ') : historyDetailText(h)).then(function () { toast(t('copied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); }); });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'icon-action remove'; del.textContent = '✕'; del.title = t('remove'); del.setAttribute('aria-label', t('remove'));
      del.addEventListener('click', function () { removeHistoryEntry(h); });
      var resend = document.createElement('button'); resend.type = 'button'; resend.className = 'icon-action'; resend.textContent = '↻'; resend.title = t('historyResend'); resend.setAttribute('aria-label', t('historyResend'));
      resend.addEventListener('click', function () { resendFromHistory(h); });
      actions.appendChild(resend); actions.appendChild(copy); actions.appendChild(del); row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // Service worker share target ---------------------------------------------
  async function loadSharedBatch() {
    var params = new URLSearchParams(location.search);
    var batchId = params.get('shared');
    if (!batchId) { try { batchId = localStorage.getItem('dx-pwa-pending-shared-batch') || ''; } catch (_) {} }
    if (!batchId || typeof caches === 'undefined') return;
    try { localStorage.setItem('dx-pwa-pending-shared-batch', batchId); } catch (_) {}
    if (params.get('shared')) { try { history.replaceState(null, '', '/app/'); } catch (_) {} }
    var files = [], cache, meta;
    try {
      cache = await caches.open('dx-share-v2');
      var metaResponse = await cache.match('/app/__shared/' + batchId + '/meta');
      if (!metaResponse) { try { localStorage.removeItem('dx-pwa-pending-shared-batch'); } catch (_) {} return; }
      meta = await metaResponse.json();
      var batchAge = Date.now() - Math.max(0, Number(meta && meta.createdAt) || 0);
      if (!meta || meta.complete !== true) {
        // An incomplete batch can only come from a worker/browser interruption.
        // Keep it briefly for diagnostics/retry, but never pin broken CacheStorage
        // data forever on mobile devices with tight storage quotas.
        if (batchAge > 10 * 60 * 1000) {
          var partialKeys = await cache.keys();
          await Promise.all(partialKeys.filter(function (req) { return new URL(req.url).pathname.indexOf('/app/__shared/' + batchId + '/') === 0; }).map(function (req) { return cache.delete(req); }));
          try { localStorage.removeItem('dx-pwa-pending-shared-batch'); } catch (_) {}
        }
        return;
      }
      if (batchAge > 24 * 60 * 60 * 1000) {
        var staleKeys = await cache.keys();
        await Promise.all(staleKeys.filter(function (req) { return new URL(req.url).pathname.indexOf('/app/__shared/' + batchId + '/') === 0; }).map(function (req) { return cache.delete(req); }));
        try { localStorage.removeItem('dx-pwa-pending-shared-batch'); } catch (_) {}
        return;
      }
      for (var i = 0; i < (meta.files || []).length; i++) {
        var response = await cache.match('/app/__shared/' + batchId + '/file/' + i);
        if (!response) return; // incomplete batch: never silently drop a shared file
        var blob = await response.blob(); var info = meta.files[i];
        files.push(namedFile(blob, info.name || ('file-' + (i + 1)), info.type || blob.type, info.lastModified || meta.createdAt || Date.now()));
      }
      var textParts = [];
      if (meta.title) textParts.push(meta.title);
      if (meta.text) textParts.push(meta.text);
      if (meta.url) textParts.push(meta.url);
      // Use the batch timestamp, not Date.now(), so a crash/retry produces the
      // same logical File identity and cannot duplicate shared text in the queue.
      if (textParts.length) files.push(namedFile(new Blob([textParts.join('\n\n')], { type: 'text/plain;charset=utf-8' }), t('sharedTextName'), 'text/plain', meta.createdAt || Date.now()));
      if (!files.length) return;
    } catch (_) {
      // Share Target recovery must never abort the rest of PWA initialization.
      // Keep the pending batch id so a later launch can retry once CacheStorage
      // or the browser storage subsystem recovers.
      return;
    }
    var added;
    try { added = await addFiles(files); }
    catch (_) { return; }
    // Do not delete the Share Target cache until every newly-added payload has a
    // durable OPFS/IndexedDB copy. If local storage is full, keeping the batch + ID
    // is the only crash-safe source and the next launch can try again.
    var durable = true;
    for (var j = 0; j < (added || []).length; j++) {
      var it = added[j];
      if (it.persistPromise) await it.persistPromise.catch(function () {});
      else if (!it.volatile) await persistItem(it, false).catch(function () {});
      if (!hasDurablePayload(it)) durable = false;
    }
    if ((added || []).length === 0) {
      // A retry can legitimately find every file already queued. Only consume the
      // cache if matching live queue entries are durable.
      durable = files.every(function (file) {
        var name = file.webkitRelativePath || file.name || '';
        var match = items.find(function (it) { return it.state !== 'removed' && it.size === file.size && it.originalName === name && it.lastModified === (file.lastModified || 0); });
        return !!(match && hasDurablePayload(match));
      });
    }
    if (durable) {
      var keys = await cache.keys();
      await Promise.all(keys.filter(function (req) { return new URL(req.url).pathname.indexOf('/app/__shared/' + batchId + '/') === 0; }).map(function (req) { return cache.delete(req); }));
      try { localStorage.removeItem('dx-pwa-pending-shared-batch'); } catch (_) {}
    }
    toast(t('sharedReceived', { n: files.length }), 'ok');
  }

  // Device pairing -----------------------------------------------------------
  var deviceInfo = null, deviceStatusPromise = null;
  var DLP_POLICY_CACHE_KEY = 'dx-pwa-dlp-policy-v1';
  function sanitizePwaDlpAction(value, fallback) {
    return ['log','warn','quarantine','block'].indexOf(String(value || '').toLowerCase()) !== -1 ? String(value).toLowerCase() : fallback;
  }
  function sanitizePwaDlpPolicy(d) {
    if (!d || typeof d !== 'object') return null;
    var actions = d.actions && typeof d.actions === 'object' ? d.actions : {};
    return {
      enabled:d.enabled !== false,
      mode:['warn','block','log','quarantine'].indexOf(String(d.mode || '').toLowerCase()) !== -1 ? String(d.mode).toLowerCase() : 'warn',
      rulesEnabled:d.rulesEnabled === true,
      actions:{
        low:sanitizePwaDlpAction(actions.low,'log'),
        medium:sanitizePwaDlpAction(actions.medium,'warn'),
        high:sanitizePwaDlpAction(actions.high,'quarantine'),
        critical:sanitizePwaDlpAction(actions.critical,'block')
      },
      maxFiles:Math.max(1, Number(d.maxFiles) || 100),
      maxFileMB:Math.max(1, Number(d.maxFileMB) || 25),
      scanOcr:d.scanOcr !== false,
      editable:d.editable === true
    };
  }
  function cachedPwaDlpPolicy() {
    try { return sanitizePwaDlpPolicy(JSON.parse(localStorage.getItem(DLP_POLICY_CACHE_KEY) || 'null')); } catch (_) { return null; }
  }
  function cachePwaDlpPolicy(d) {
    var clean = sanitizePwaDlpPolicy(d); if (!clean) return;
    // A cached policy is context only. Never persist edit authority across an
    // offline/revoked session; the current server status must grant it again.
    clean.editable = false;
    try { localStorage.setItem(DLP_POLICY_CACHE_KEY, JSON.stringify(clean)); } catch (_) {}
  }
  function appMutationHeaders(contentType) {
    var headers = { 'Content-Type': contentType || 'application/octet-stream' };
    if (deviceInfo && deviceInfo.csrf) headers['X-CSRF-Token'] = deviceInfo.csrf;
    return headers;
  }
  function platformName() { return navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || 'mobile'; }
  function fetchDeviceStatus() {
    // Coalesce concurrent callers (startup used to issue this request twice) and
    // bound the request so a half-open mobile connection cannot freeze the entire
    // PWA initialization sequence forever.
    if (deviceStatusPromise) return deviceStatusPromise;
    deviceStatusPromise = (async function () {
      try {
        var r = await fetchWithTimeout('/app/device/status?version=' + encodeURIComponent(APP_VERSION) + '&build=' + encodeURIComponent(APP_BUILD) + (isStandaloneApp() ? '&standalone=1' : ''), { credentials: 'same-origin', cache: 'no-store' }, 10000);
        if (r.status === 401 || r.status === 403) { accountNotifications = []; renderPwaNotifications(); }
        if (!r.ok) throw new Error('status');
        deviceInfo = await r.json();
        deviceInfo.unavailable = false;
        if (deviceInfo.dlp) { deviceInfo.dlp = sanitizePwaDlpPolicy(deviceInfo.dlp); cachePwaDlpPolicy(deviceInfo.dlp); }
      } catch (_) {
        // Never downgrade an unknown server policy to the permissive default. Reuse
        // the last authenticated policy when available; on a first-run status failure
        // the upload preflight fails closed until Direct-Xfer can fetch the policy.
        deviceInfo = { paired: false, adminSession: false, devices: [], unavailable: true, dlp: cachedPwaDlpPolicy() };
      }
      renderDeviceStatus();
      return deviceInfo;
    })().finally(function () { deviceStatusPromise = null; });
    return deviceStatusPromise;
  }
  // Authenticated PWA mutation. A 403 usually means the CSRF token went stale (an
  // old value that used to get cached by the service worker, or a rotated session);
  // refresh device status once to pick up a fresh token and retry.
  async function appMutate(url, contentType, body, requestOptions) {
    if (!deviceInfo) await fetchDeviceStatus();
    requestOptions = requestOptions || {};
    // Keep every JSON mutation syntactically valid, including action-only routes.
    // This avoids proxy/browser differences around Content-Type: application/json
    // combined with an absent request body.
    if (/^application\/json(?:\s*;|$)/i.test(String(contentType || '')) && body == null) body = '{}';
    var sendMutation = function () {
      var opts = { method: 'POST', credentials: 'same-origin', headers: appMutationHeaders(contentType), body: body };
      return requestOptions.timeoutMs ? fetchWithTimeout(url, opts, requestOptions.timeoutMs) : fetch(url, opts);
    };
    var r = await sendMutation();
    // Only retry an actual stale-CSRF response. Other 403s (DLP block, role,
    // origin, revoked capability, etc.) are deliberate policy decisions and must
    // never cause the same upload to be sent a second time.
    if (r.status === 403) {
      var err = null; try { err = await r.clone().json(); } catch (_) {}
      if (err && err.error === 'invalid-csrf') {
        await fetchDeviceStatus();
        r = await sendMutation();
      }
    }
    return r;
  }
  function pwaDlpRuleLabel(type) {
    var maps = {
      fr:{'private-key':'Clé privée','aws-access-key':'Identifiant de clé AWS','github-token':'Jeton GitHub','slack-token':'Jeton Slack','jwt':'Jeton JWT','password':'Mot de passe assigné','api-secret':'Secret / jeton API','payment-card':'Numéro de carte de paiement','canadian-sin':'NAS canadien','iban':'IBAN','identity-document':'Document d’identité','confidential-marker':'Marqueur de confidentialité'},
      en:{'private-key':'Private key','aws-access-key':'AWS access-key ID','github-token':'GitHub token','slack-token':'Slack token','jwt':'JWT token','password':'Password assignment','api-secret':'API secret/token','payment-card':'Payment-card number','canadian-sin':'Canadian SIN','iban':'IBAN','identity-document':'Identity document','confidential-marker':'Confidentiality marker'},
      es:{'private-key':'Clave privada','aws-access-key':'ID de clave AWS','github-token':'Token GitHub','slack-token':'Token Slack','jwt':'Token JWT','password':'Asignación de contraseña','api-secret':'Secreto/token API','payment-card':'Número de tarjeta','canadian-sin':'SIN/NAS canadiense','iban':'IBAN','identity-document':'Documento de identidad','confidential-marker':'Marcador de confidencialidad'}
    };
    return (maps[lang] && maps[lang][String(type || '')]) || String(type || 'DLP').replace(/-/g, ' ');
  }
  function pwaDlpRuleReason(f) {
    var maps = {
      fr:{'private-key':'Du matériel de clé privée a été détecté.','aws-access-key':'Un identifiant de clé d’accès AWS correspond au format connu.','github-token':'Un jeton GitHub correspond à un format de secret connu.','slack-token':'Un jeton Slack correspond à un format de secret connu.','jwt':'Une chaîne au format JSON Web Token a été détectée.','password':'Une valeur de mot de passe assignée a été détectée.','api-secret':'Une valeur ressemblant à une clé API ou un jeton secret a été détectée.','payment-card':'Le numéro correspond à un format de carte et passe la validation de Luhn.','canadian-sin':'Le numéro est présenté comme NAS/SIN et passe la validation de Luhn.','iban':'La valeur correspond à un IBAN valide selon le contrôle mod-97.','identity-document':'Un identifiant de document officiel a été trouvé avec un contexte explicite.','confidential-marker':'Un marqueur de confidentialité explicite est présent.'},
      en:{'private-key':'Private-key material was detected.','aws-access-key':'An AWS access-key identifier matches the known format.','github-token':'A GitHub token matches a known secret format.','slack-token':'A Slack token matches a known secret format.','jwt':'A JSON Web Token-shaped value was detected.','password':'An assigned password value was detected.','api-secret':'A value resembling an API key or secret token was detected.','payment-card':'The number matches a payment-card shape and passes the Luhn check.','canadian-sin':'The number is presented as a SIN/NAS and passes the Luhn check.','iban':'The value matches an IBAN and passes the mod-97 check.','identity-document':'An official-document identifier was found with explicit context.','confidential-marker':'An explicit confidentiality marker is present.'},
      es:{'private-key':'Se detectó material de clave privada.','aws-access-key':'Un identificador de clave AWS coincide con el formato conocido.','github-token':'Un token de GitHub coincide con un formato secreto conocido.','slack-token':'Un token de Slack coincide con un formato secreto conocido.','jwt':'Se detectó un valor con formato JSON Web Token.','password':'Se detectó un valor asignado a una contraseña.','api-secret':'Se detectó un valor parecido a una clave API o token secreto.','payment-card':'El número tiene formato de tarjeta y supera la validación de Luhn.','canadian-sin':'El número se presenta como SIN/NAS y supera la validación de Luhn.','iban':'El valor coincide con un IBAN y supera la comprobación mod-97.','identity-document':'Se encontró un identificador de documento oficial con contexto explícito.','confidential-marker':'Hay un marcador explícito de confidencialidad.'}
    };
    return (maps[lang] && maps[lang][String(f && f.type || '')]) || String(f && f.detail || '');
  }
  function pwaDlpFindingLines(d, limit) {
    return (d && Array.isArray(d.findings) ? d.findings : []).slice(0, limit || 5).map(function (f) {
      return [pwaDlpRuleLabel(f.type), f.file || '—', f.sample || '—', pwaDlpRuleReason(f)].filter(Boolean).join(' · ');
    });
  }
  function pwaServerDlpWarningText(d) {
    var msg;
    if (d && (d.incomplete || d.filesSkipped || d.ocrErrors || d.scanErrors || d.truncated)) {
      msg = t('dlpIncompleteConfirm', { n:d.count || 0, files:Math.max(1, (Number(d.filesScanned)||0) + (Number(d.filesSkipped)||0)) });
    } else msg = t('sharesDlpWarning', { n:d && d.count || 0, level:d && d.highest || '—' });
    var lines = pwaDlpFindingLines(d, 5); if (lines.length) msg += '\n\n' + lines.join('\n');
    return msg;
  }
  async function imageDlpMutate(url, contentType, body) {
    var requestUrl = url, duplicateApproved = false, dlpApproved = false;
    var r = await appMutate(requestUrl, contentType, body);
    for (var guard = 0; r && r.status === 409 && guard < 3; guard++) {
      var issue = null; try { issue = await r.clone().json(); } catch (_) {}
      if (issue && issue.error === 'duplicate-content' && !duplicateApproved) {
        if (!askConfirmation('replace', t('imgDuplicateFound'))) return null;
        duplicateApproved = true; requestUrl += (requestUrl.indexOf('?') >= 0 ? '&' : '?') + 'duplicateOverride=1'; r = await appMutate(requestUrl, contentType, body); continue;
      }
      if (issue && issue.error === 'dlp-warning' && issue.dlp && !dlpApproved) {
        if (!window.confirm(pwaServerDlpWarningText(issue.dlp))) return null;
        dlpApproved = true; requestUrl += (requestUrl.indexOf('?') >= 0 ? '&' : '?') + 'dlpOverride=1'; r = await appMutate(requestUrl, contentType, body); continue;
      }
      break;
    }
    return r;
  }

  // PWA main-queue DLP -------------------------------------------------------
  // Server-side DLP already protects shares and image publication. Reception
  // uploads are a streaming endpoint, so the PWA performs a matching local
  // preflight before the first upload byte. Findings are redacted and remain on
  // this device; only the active policy knobs are read from /app/device/status.
  function pwaDlpPolicy() {
    var d = deviceInfo && deviceInfo.dlp;
    return {
      known: !!d && !(deviceInfo && deviceInfo.unavailable),
      enabled: !d || d.enabled !== false,
      // Unknown/unreachable policy is deliberately fail-closed. A cached policy may be
      // shown for context, but it is never trusted to authorize a new upload.
      mode: d && ['warn','block','log','quarantine'].indexOf(d.mode) !== -1 ? d.mode : 'block',
      rulesEnabled: !!(d && d.rulesEnabled),
      actions: d && d.actions ? d.actions : { low:'log', medium:'warn', high:'quarantine', critical:'block' },
      maxFiles: Math.max(1, Number(d && d.maxFiles) || 100),
      maxFileMB: Math.max(1, Number(d && d.maxFileMB) || 25),
      scanOcr: !d || d.scanOcr !== false,
      editable: !!(d && d.editable) && !(deviceInfo && deviceInfo.unavailable)
    };
  }
  function pwaDlpEffectiveAction(policy, result) {
    if (!policy) policy = pwaDlpPolicy();
    var fallback = ['log','warn','quarantine','block'].indexOf(policy.mode) >= 0 ? policy.mode : 'warn';
    var action = fallback;
    if (policy.rulesEnabled && result && result.count) {
      var level = ['low','medium','high','critical'].indexOf(String(result.highest || '').toLowerCase()) >= 0 ? String(result.highest).toLowerCase() : 'medium';
      var configured = policy.actions && policy.actions[level];
      if (['log','warn','quarantine','block'].indexOf(configured) >= 0) action = configured;
    }
    if (result && pwaDlpIncomplete(result)) {
      var rank = { log:0, warn:1, quarantine:2, block:3 };
      return rank[action] >= rank[fallback] ? action : fallback;
    }
    return action;
  }
  var dlpAutoSaveBusy = false;
  function pwaDlpActionOptions(select, value) {
    if (!select) return;
    var actions = [
      ['log', t('dlpModeLog')],
      ['warn', t('dlpModeWarn')],
      ['quarantine', t('dlpModeQuarantine')],
      ['block', t('dlpModeBlock')]
    ];
    select.textContent = '';
    actions.forEach(function (entry) { var option = document.createElement('option'); option.value = entry[0]; option.textContent = entry[1]; select.appendChild(option); });
    select.value = sanitizePwaDlpAction(value, 'warn');
  }
  function syncPwaDlpAutoControls(policy) {
    policy = policy || pwaDlpPolicy();
    var enabled = !!(policy.known && policy.editable) && !dlpAutoSaveBusy;
    var rules = $('dlp-auto-rules');
    var selectIds = ['dlp-action-low','dlp-action-medium','dlp-action-high','dlp-action-critical'];
    if (rules) rules.disabled = !enabled;
    var severityEnabled = enabled && !!(rules && rules.checked);
    selectIds.forEach(function (id) { if ($(id)) $(id).disabled = !severityEnabled; });
    if ($('dlp-auto-save')) $('dlp-auto-save').disabled = !enabled;
    if ($('dlp-auto-readonly')) $('dlp-auto-readonly').classList.toggle('hidden', !policy.known || policy.editable);
  }
  function renderPwaDlpPolicy() {
    var el = $('dlp-pwa-policy'); if (!el) return;
    var p = pwaDlpPolicy();
    var actionValues = p.actions || { low:'log', medium:'warn', high:'quarantine', critical:'block' };
    pwaDlpActionOptions($('dlp-action-low'), actionValues.low);
    pwaDlpActionOptions($('dlp-action-medium'), actionValues.medium);
    pwaDlpActionOptions($('dlp-action-high'), actionValues.high);
    pwaDlpActionOptions($('dlp-action-critical'), actionValues.critical);
    if ($('dlp-auto-rules')) $('dlp-auto-rules').checked = !!p.rulesEnabled;
    syncPwaDlpAutoControls(p);
    if (!p.known) { el.textContent = deviceInfo && deviceInfo.unavailable ? t('dlpPolicyUnavailable') : t('dlpPolicyLoading'); return; }
    if (!p.enabled) { el.textContent = t('dlpPolicyDisabled'); return; }
    var modeKey = p.mode === 'block' ? 'dlpModeBlock' : p.mode === 'quarantine' ? 'dlpModeQuarantine' : p.mode === 'log' ? 'dlpModeLog' : 'dlpModeWarn';
    el.textContent = t('dlpPolicyText', { mode:t(modeKey), mb:p.maxFileMB, ocr:t(p.scanOcr ? 'dlpOcrOn' : 'dlpOcrOff') });
  }
  async function savePwaDlpAutomaticRules() {
    var policy = pwaDlpPolicy(), status = $('dlp-auto-status');
    if (!policy.known || !policy.editable || dlpAutoSaveBusy) return;
    var payload = {
      dlpRulesEnabled: !!($('dlp-auto-rules') && $('dlp-auto-rules').checked),
      dlpActionLow: $('dlp-action-low') ? $('dlp-action-low').value : 'log',
      dlpActionMedium: $('dlp-action-medium') ? $('dlp-action-medium').value : 'warn',
      dlpActionHigh: $('dlp-action-high') ? $('dlp-action-high').value : 'quarantine',
      dlpActionCritical: $('dlp-action-critical') ? $('dlp-action-critical').value : 'block'
    };
    dlpAutoSaveBusy = true; syncPwaDlpAutoControls(policy); if (status) status.textContent = '';
    try {
      var response = await appMutate('/app/dlp/settings', 'application/json', JSON.stringify(payload));
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || 'save');
      if (deviceInfo && data.dlp) { deviceInfo.dlp = sanitizePwaDlpPolicy(data.dlp); cachePwaDlpPolicy(deviceInfo.dlp); }
      if (status) status.textContent = t('dlpAutoSaved');
      toast(t('dlpAutoSaved'), 'ok');
    } catch (_) {
      if (status) status.textContent = t('dlpAutoSaveFail');
      toast(t('dlpAutoSaveFail'), 'err');
    } finally {
      dlpAutoSaveBusy = false;
      renderPwaDlpPolicy();
    }
  }
  if ($('dlp-auto-rules')) $('dlp-auto-rules').addEventListener('change', function () { syncPwaDlpAutoControls(pwaDlpPolicy()); });
  if ($('dlp-auto-save')) $('dlp-auto-save').addEventListener('click', savePwaDlpAutomaticRules);
  function pwaDlpFingerprint(it, policy) {
    policy = policy || pwaDlpPolicy();
    var engine = window.DirectXferDlp && window.DirectXferDlp.version || '0';
    return [engine, String(it && it.name || ''), Number(it && it.size || 0), Number(it && it.lastModified || 0), policy.maxFiles, policy.maxFileMB, policy.scanOcr ? 1 : 0].join(':');
  }
  function pwaDlpMerge(summaries) {
    var findings = [], scanned = 0, skipped = 0, ocrErrors = 0, scanErrors = 0, incompleteEntries = 0, truncated = false, seen = new Set();
    (summaries || []).forEach(function (r) {
      if (!r) return;
      scanned += Number(r.filesScanned) || 0; skipped += Number(r.filesSkipped) || 0; ocrErrors += Number(r.ocrErrors) || 0; scanErrors += Number(r.scanErrors) || 0; incompleteEntries += Number(r.incompleteEntries) || 0; truncated = truncated || !!r.truncated;
      (r.findings || []).forEach(function (f) { var k = String(f.type || '') + ':' + String(f.sample || '') + ':' + String(f.file || ''); if (!seen.has(k) && findings.length < 100) { seen.add(k); findings.push(f); } });
    });
    var D = window.DirectXferDlp;
    return D && D.summarize ? D.summarize(findings, { filesScanned:scanned, filesSkipped:skipped, ocrErrors:ocrErrors, scanErrors:scanErrors, incompleteEntries:incompleteEntries, truncated:truncated }) : { count:findings.length, findings:findings, filesScanned:scanned, filesSkipped:skipped, ocrErrors:ocrErrors, scanErrors:scanErrors, incompleteEntries:incompleteEntries, truncated:truncated, incomplete:!!(skipped || ocrErrors || scanErrors || incompleteEntries || truncated) };
  }
  function pwaDlpIncomplete(d) {
    var D = window.DirectXferDlp;
    return D && typeof D.isIncomplete === 'function' ? D.isIncomplete(d) : !!(d && (d.incomplete || d.filesSkipped || d.ocrErrors || d.scanErrors || d.incompleteEntries || d.truncated || d.error));
  }
  async function pwaDlpPdfText(file, withOcr) {
    var pdfjs = await ensureOcrPdfLib(), bytes = new Uint8Array(await file.arrayBuffer());
    var loading = pdfjs.getDocument({ data:bytes, isEvalSupported:false }), pdf = await loading.promise, pages = [], failedPages = 0;
    var total = pdf.numPages || 0, limit = withOcr ? Math.min(total, 40) : total;
    try {
      for (var n = 1; n <= limit; n++) {
        var page = await pdf.getPage(n), embedded = '';
        try { embedded = normalizePdfText((await page.getTextContent()).items); } catch (_) {}
        var visual = '';
        if (withOcr) {
          var canvas = null;
          try {
            canvas = await renderPdfPageForOcr(page);
            var worker = await getOcrWorker();
            if (ocrAbort) throw new Error('OCR_CANCELLED');
            var ret = await worker.recognize(canvas); visual = ret && ret.data ? String(ret.data.text || '').trim() : '';
          } catch (err) {
            failedPages++;
            if (err && err.message === 'OCR_CANCELLED') throw err;
          } finally { if (canvas) { canvas.width = 1; canvas.height = 1; } }
        }
        if (embedded || visual) pages.push('--- Page ' + n + ' ---\n' + [embedded, visual].filter(Boolean).join('\n'));
        if (page.cleanup) try { page.cleanup(); } catch (_) {}
      }
    } finally { if (pdf && pdf.destroy) try { await pdf.destroy(); } catch (_) {} }
    if (!withOcr) return pages.join('\n\n');
    return { text:pages.join('\n\n'), incompletePages:failedPages + Math.max(0, total - limit), truncated:failedPages > 0 || total > limit };
  }
  function pwaDlpChipText(it) {
    var d = it && it.dlpLocal;
    if (!d) return '';
    if (d.scanning) return t('dlpTesting');
    if (d.count) return t('dlpFound', { n:d.count, level:d.highest || '—' }) + (pwaDlpIncomplete(d) ? ' · ' + t('dlpScanIncomplete', { n:(Number(d.filesSkipped)||0) + (Number(d.ocrErrors)||0) + (Number(d.scanErrors)||0) + (Number(d.incompleteEntries)||0) }) : '');
    if (pwaDlpIncomplete(d)) return t('dlpScanIncomplete', { n:Math.max(1, (Number(d.filesSkipped)||0) + (Number(d.ocrErrors)||0) + (Number(d.scanErrors)||0) + (Number(d.incompleteEntries)||0)) });
    return t('dlpSafe');
  }
  async function runPwaDlpForItem(it, options) {
    options = options || {};
    if (!it || !it.file) return null;
    var policy = pwaDlpPolicy(), D = window.DirectXferDlp;
    if (!policy.enabled || !D || typeof D.scanFile !== 'function') return null;
    var fingerprint = pwaDlpFingerprint(it, policy);
    if (!options.force && it.dlpLocal && it.dlpLocal.fingerprint === fingerprint && !it.dlpLocal.scanning) return it.dlpLocal;
    it.dlpLocal = { scanning:true, fingerprint:fingerprint, count:0, findings:[] }; renderQueue();
    try {
      if (policy.scanOcr && canOcrItem(it) && ocrRunning) {
        var busy = { fingerprint:fingerprint, scanning:false, count:0, findings:[], filesScanned:0, filesSkipped:0, ocrErrors:1, scanErrors:0, incompleteEntries:0, incomplete:true, error:'ocr-busy', scannedAt:Date.now() };
        it.dlpLocal = busy; await persistItem(it, false).catch(function () {}); renderQueue();
        if (options.toast !== false) toast(t('dlpOcrIncomplete', { n:1 }), 'warn');
        return busy;
      }
      if (policy.scanOcr && canOcrItem(it)) ocrAbort = false;
      var result = await D.scanFile(it.file, {
        name:it.name || it.file.name,
        type:it.type || it.file.type,
        maxBytes:policy.maxFileMB * 1024 * 1024,
        scanOcr:policy.scanOcr,
        ocrImage:policy.scanOcr ? recognizeOcrImage : null,
        extractPdfText:pwaDlpPdfText,
        maxZipEntries:60,
        maxZipTextBytes:2 * 1024 * 1024
      });
      result.fingerprint = fingerprint; result.scanning = false; result.scannedAt = Date.now();
      it.dlpLocal = result;
      if (it.dlpApprovedFingerprint && it.dlpApprovedFingerprint !== fingerprint) it.dlpApprovedFingerprint = '';
      await persistItem(it, false).catch(function () {}); renderQueue();
      if (options.toast !== false) {
        if (result.count) toast(t('dlpFound', { n:result.count, level:result.highest || '—' }), policy.mode === 'block' ? 'err' : 'warn');
        if (pwaDlpIncomplete(result)) toast(t('dlpScanIncomplete', { n:Math.max(1, (Number(result.filesSkipped)||0) + (Number(result.ocrErrors)||0) + (Number(result.scanErrors)||0) + (Number(result.incompleteEntries)||0)) }), 'warn');
        else if (!result.count) toast(t('dlpSafe'), 'ok');
      }
      return result;
    } catch (err) {
      it.dlpLocal = { scanning:false, fingerprint:fingerprint, count:0, findings:[], filesScanned:0, filesSkipped:0, ocrErrors:0, scanErrors:1, incompleteEntries:0, incomplete:true, error:String(err && err.message || err || 'scan') };
      await persistItem(it, false).catch(function () {}); renderQueue();
      if (options.toast !== false) toast(t('dlpScanFailed', { error:it.dlpLocal.error.slice(0,120) }), 'warn');
      return it.dlpLocal;
    } finally {
      // A DLP OCR pass uses the same lazy worker as the OCR tool. Free it after a
      // headless batch so Android does not keep hundreds of MB resident.
      if (!options.keepOcrWorker && !ocrRunning) await terminateOcrWorker().catch(function () {});
    }
  }
  async function runPwaDlpForItems(targets, options) {
    options = options || {}; targets = (targets || []).filter(function (it) { return it && it.file && it.state !== 'removed'; });
    var policy = pwaDlpPolicy(), max = Math.min(targets.length, policy.maxFiles), results = [], dlpOp=beginLongOperation(t('longOpDlp'), '0 / '+max);
    try {
      for (var i = 0; i < max; i++) { updateLongOperation(dlpOp,max?Math.round(i/max*100):100,(i+1)+' / '+max); results.push(await runPwaDlpForItem(targets[i], { force:!!options.force, toast:false, keepOcrWorker:true })); }
      // Files beyond the configured batch inspection cap were previously represented
      // only in the merged summary. In warn mode that left no item requiring approval,
      // so a large all-safe batch could continue without acknowledging the unscanned
      // files. Mark every omitted item explicitly as incomplete and fingerprint it so
      // a later policy increase invalidates the cached result and scans it for real.
      for (var j = max; j < targets.length; j++) {
        var skipped = targets[j], skippedFingerprint = pwaDlpFingerprint(skipped, policy);
        skipped.dlpLocal = { scanning:false, fingerprint:skippedFingerprint, count:0, findings:[], filesScanned:0, filesSkipped:1, ocrErrors:0, scanErrors:0, incompleteEntries:0, truncated:true, incomplete:true, error:'max-files', scannedAt:Date.now() };
        if (skipped.dlpApprovedFingerprint && skipped.dlpApprovedFingerprint !== skippedFingerprint) skipped.dlpApprovedFingerprint = '';
        await persistItem(skipped, false).catch(function () {});
        results.push(skipped.dlpLocal);
      }
    } finally {
      endLongOperation(dlpOp);
      if (!ocrRunning) await terminateOcrWorker().catch(function () {});
    }
    var merged = pwaDlpMerge(results);
    if (options.toast !== false) {
      if (merged.count) toast(t('dlpFound', { n:merged.count, level:merged.highest || '—' }), policy.mode === 'block' ? 'err' : 'warn');
      if (pwaDlpIncomplete(merged)) toast(t('dlpScanIncomplete', { n:Math.max(1, (Number(merged.filesSkipped)||0) + (Number(merged.ocrErrors)||0) + (Number(merged.scanErrors)||0) + (Number(merged.incompleteEntries)||0)) }), 'warn');
      else if (!merged.count) toast(t('dlpSafe'), 'ok');
    }
    return merged;
  }
  async function ensurePwaDlpBeforeBatch(candidates) {
    await fetchDeviceStatus().catch(function () {});
    var policy = pwaDlpPolicy();
    if (!policy.known) { toast(t('dlpPolicyUnavailable'), 'err'); return false; }
    if (!policy.enabled) return true;
    if (!window.DirectXferDlp) { toast(t('dlpScanFailed', { error:'module' }), 'err'); return false; }
    var result = await runPwaDlpForItems(candidates, { toast:false });
    var incomplete = pwaDlpIncomplete(result);
    var action = pwaDlpEffectiveAction(policy, result);
    if (result.count) toast(t('dlpFound', { n:result.count, level:result.highest || '—' }), (action === 'block' || action === 'quarantine') ? 'err' : 'warn');
    if (incomplete) toast(t('dlpScanIncomplete', { n:Math.max(1, (Number(result.filesSkipped)||0) + (Number(result.ocrErrors)||0) + (Number(result.scanErrors)||0) + (Number(result.incompleteEntries)||0)) }), action === 'block' ? 'err' : 'warn');
    if (action === 'quarantine' && (result.count || incomplete)) { toast(incomplete ? t('dlpIncompleteQuarantined') : t('dlpLocalQuarantined'), 'err'); renderQueue(); return false; }
    if (action === 'block' && (result.count || incomplete)) { toast(incomplete ? t('dlpIncompleteBlocked') : t('dlpLocalBlocked'), 'err'); renderQueue(); return false; }
    if (action === 'log') return true;
    if (!result.count && !incomplete) return true;
    var needsApproval = candidates.filter(function (it) { return it.dlpLocal && (it.dlpLocal.count || pwaDlpIncomplete(it.dlpLocal)) && it.dlpApprovedFingerprint !== it.dlpLocal.fingerprint; });
    if (!needsApproval.length) return true;
    var msg = incomplete ? t('dlpIncompleteConfirm', { n:result.count || 0, files:needsApproval.length }) : t('dlpLocalConfirm', { n:result.count, level:result.highest || '—', files:needsApproval.length });
    var findingLines = pwaDlpFindingLines(result, 5); if (findingLines.length) msg += '\n\n' + findingLines.join('\n');
    if (!window.confirm(msg)) return false;
    needsApproval.forEach(function (it) { it.dlpApprovedFingerprint = it.dlpLocal.fingerprint; persistItem(it, false); });
    return true;
  }
  function testPwaDlpQueue() { return runPwaDlpForItems(items.filter(function (it) { return it.state !== 'removed' && it.state !== 'done'; }), { force:true }); }
  function testPwaDlpSelected() { return runPwaDlpForItems(selectedItems(), { force:true }); }
  function renderDeviceStatus() {
    if (!deviceInfo) return;
    var paired = !!deviceInfo.paired;
    var pairButton = $('pair-device-btn');
    var unpairButton = $('revoke-device-btn');
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
    var forceNeverExpire = !!(deviceInfo.shareDefaults && deviceInfo.shareDefaults.newSharesNeverExpire);
    if ($('share-expiry')) {
      if (forceNeverExpire) $('share-expiry').value = '0';
      $('share-expiry').disabled = forceNeverExpire;
      $('share-expiry').title = forceNeverExpire ? t('sharesExpiryForcedNever') : '';
    }
    if ($('share-first-use')) { if (forceNeverExpire) $('share-first-use').value = '0'; $('share-first-use').disabled = forceNeverExpire; $('share-first-use').title = forceNeverExpire ? t('sharesExpiryForcedNever') : ''; }
    if ($('img-expiry')) { if (forceNeverExpire) $('img-expiry').value = '0'; $('img-expiry').disabled = forceNeverExpire; $('img-expiry').title = forceNeverExpire ? t('sharesExpiryForcedNever') : ''; }
    var devices = Array.isArray(deviceInfo.devices) ? deviceInfo.devices : [];
    $('device-list-wrap').classList.toggle('hidden', !devices.length);
    var list = $('device-list'); list.innerHTML = '';
    devices.forEach(function (d) {
      var row = document.createElement('div'); row.className = 'device-row';
      var main = document.createElement('div'); main.className = 'device-main';
      var platformIcons = { android:'🤖', ios:'', windows:'⊞', macos:'', linux:'🐧', other:'📱' };
      var platformLabels = { android:'Android', ios:'iOS', windows:'Windows', macos:'macOS', linux:'Linux', other:t('devicePlatformOther') };
      var platform = String(d.platform || 'other');
      var strong = document.createElement('strong'); strong.textContent = (platformIcons[platform] || '📱') + ' ' + d.name + (d.current ? ' · ' + t('deviceCurrent') : ''); main.appendChild(strong);
      var meta = document.createElement('div'); meta.className = 'device-meta';
      var versionText = d.appVersion ? ('Direct-Xfer ' + d.appVersion + (d.appBuild ? ' · ' + d.appBuild.replace(/^.*-/, '') : '')) : t('deviceVersionUnknown');
      meta.textContent = (platformLabels[platform] || platformLabels.other) + ' · ' + versionText + ' · ' + t('deviceLast', { date: fmtDate(d.lastUsedAt || d.createdAt) }); main.appendChild(meta); row.appendChild(main);
      // The current device already has the primary Rename action above in
      // "Accès de cet appareil". Keep list actions only for OTHER devices so the
      // settings panel never shows two Rename buttons for the same device.
      if (!d.current && deviceInfo.adminSession) {
        var rename = document.createElement('button'); rename.type = 'button'; rename.className = 'btn ghost sm'; rename.textContent = t('renameDevice');
        rename.addEventListener('click', function () { renameDevice(d.id, d.name, false); }); row.appendChild(rename);
      }
      if (!d.current && deviceInfo.adminSession) {
        var revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn danger sm'; revoke.textContent = t('revokeDevice');
        revoke.addEventListener('click', function () { revokeDevice(d.id, false); }); row.appendChild(revoke);
      }
      list.appendChild(row);
    });
    renderPwaDlpPolicy();
    renderPasskeySection();
  }

  // Biometric sign-in is implemented with a device-bound WebAuthn credential. Keep
  // the setting visible even when unavailable so HTTP/browser/session problems are
  // explained instead of making the feature appear to be missing.
  var passkeysLoaded = false, passkeysLoading = false, passkeyRecords = [], passkeysLoadPromise = null;
  var biometricCapability = null, biometricCapabilityPromise = null, biometricMutationInFlight = false;
  function passkeySupported() { return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }
  function biometricSecureContext() {
    var host = String(location.hostname || '').toLowerCase();
    return !!window.isSecureContext && (location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
  }
  function detectBiometricCapability() {
    if (biometricCapabilityPromise) return biometricCapabilityPromise;
    biometricCapabilityPromise = (async function () {
      if (!biometricSecureContext() || !passkeySupported()) return false;
      if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return true;
      try { return !!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
      catch (_) { return false; }
    })().then(function (available) {
      biometricCapability = available;
      renderPasskeySection();
      return available;
    });
    return biometricCapabilityPromise;
  }
  function bufToB64u(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uToBuf(value) {
    var s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function setBiometricStatus(key, kind, vars) {
    var status = $('biometric-status'); if (!status) return;
    status.textContent = t(key, vars);
    status.classList.remove('ok', 'warn', 'error');
    if (kind) status.classList.add(kind);
  }
  function currentDeviceHasPasskey(list) {
    // Once the server list has loaded it is authoritative. Falling back to the
    // earlier device-status snapshot after that point made a remotely deleted
    // credential continue to appear enabled until the PWA was restarted.
    if (passkeysLoaded) return (list || []).some(function (p) { return p && p.currentDevice; });
    return !!(deviceInfo && deviceInfo.biometricEnabled);
  }
  function updateBiometricSummary(list) {
    list = list || passkeyRecords;
    var add = $('add-passkey-btn'), disable = $('disable-biometric-btn');
    var enabledHere = currentDeviceHasPasskey(list);
    var canManage = !!(deviceInfo && deviceInfo.passkeyManagement === true && !deviceInfo.unavailable && !biometricMutationInFlight);
    if (add) add.disabled = !canManage || enabledHere || biometricCapability !== true;
    if (disable) disable.disabled = !canManage || !list.length;
    if (!biometricSecureContext()) { setBiometricStatus('biometricHttpsRequired', 'error'); return; }
    if (biometricCapability === null) { setBiometricStatus('biometricChecking', ''); detectBiometricCapability(); return; }
    if (!biometricCapability) { setBiometricStatus('biometricUnsupported', 'warn'); return; }
    if (enabledHere) setBiometricStatus('biometricEnabled', 'ok');
    else if (list.length) setBiometricStatus('biometricConfigured', '', { n:list.length });
    else setBiometricStatus('biometricReady', 'ok');
  }
  function setBiometricMutationBusy(busy) {
    biometricMutationInFlight = !!busy;
    document.querySelectorAll('#passkey-section button').forEach(function (button) { button.disabled = !!busy; });
    if (!busy) {
      renderPasskeyList(passkeyRecords);
      renderPasskeySection();
    }
  }
  function renderPasskeySection() {
    var section = $('passkey-section'); if (!section) return;
    section.classList.remove('hidden');
    var add = $('add-passkey-btn'), disable = $('disable-biometric-btn'), reauth = $('reauth-biometric-btn');
    if (add) add.disabled = true;
    if (disable) disable.disabled = true;
    if (reauth) reauth.classList.add('hidden');
    if (!deviceInfo || deviceInfo.unavailable) { setBiometricStatus('biometricStatusUnavailable', 'warn'); return; }
    if (!deviceInfo.paired || !deviceInfo.device) { setBiometricStatus('biometricPairRequired', 'warn'); return; }
    if (deviceInfo.passkeyManagement !== true) {
      setBiometricStatus('biometricRecentAuth', 'warn');
      if (reauth) reauth.classList.remove('hidden');
      return;
    }
    if (!passkeysLoaded && !passkeysLoading) { loadPasskeys(); return; }
    updateBiometricSummary(passkeyRecords);
    // Compatibility gates activation only. Server-side deactivation must remain
    // available even if biometrics or HTTPS stopped working on this browser.
    if (biometricCapability === null) detectBiometricCapability();
  }
  function renderPasskeyList(list) {
    var box = $('passkey-list'); if (!box) return; box.innerHTML = '';
    passkeyRecords = Array.isArray(list) ? list : [];
    if (!passkeyRecords.length) { box.appendChild(el('p', { class: 'muted sm', text: t('passkeyEmpty') })); updateBiometricSummary(passkeyRecords); return; }
    passkeyRecords.forEach(function (p) {
      var row = el('div', { class: 'passkey-row' });
      var main = el('div', { class: 'passkey-main' });
      main.appendChild(el('strong', { text: (p.name || t('passkeyTitle')) + (p.currentDevice ? ' · ' + t('passkeyCurrent') : ''), class: p.currentDevice ? 'passkey-current' : '' }));
      var used = p.lastUsedAt ? t('passkeyUsed', { date: fmtDate(p.lastUsedAt) }) : t('passkeyNeverUsed');
      var deviceCount = Math.max(1, Number(p.deviceCount) || 1);
      main.appendChild(el('span', { class: 'muted xs', text: t('passkeyCreated', { date: fmtDate(p.createdAt) }) + ' · ' + used + ' · ' + t('passkeyDevices', { n:deviceCount }) }));
      row.appendChild(main);
      var rm = el('button', { class: 'btn danger sm', attrs: { type: 'button' }, text: t('passkeyRemove') });
      rm.disabled = biometricMutationInFlight || !(deviceInfo && deviceInfo.passkeyManagement === true);
      rm.addEventListener('click', function () { removePasskey(p); });
      row.appendChild(rm);
      var devices=Array.isArray(p.devices)?p.devices:[];
      if(devices.length){var devList=el('div',{class:'passkey-device-list'});devices.forEach(function(d){var dr=el('div',{class:'passkey-device-row'+(d.current?' current':'')}),dm=el('div',{class:'passkey-device-main'});dm.appendChild(el('strong',{text:(d.name||t('passkeyDeviceUnavailable'))+(d.current?' · '+t('passkeyDeviceCurrent'):'')}));dm.appendChild(el('span',{class:'muted xs',text:[d.createdAt?t('passkeyCreated',{date:fmtDate(d.createdAt)}):'',d.lastUsedAt?t('passkeyUsed',{date:fmtDate(d.lastUsedAt)}):t('passkeyNeverUsed')].filter(Boolean).join(' · ')}));dr.appendChild(dm);if(d.available!==false){var rb=el('button',{class:'btn danger xs',attrs:{type:'button'},text:t('passkeyDeviceRemove')});rb.disabled=biometricMutationInFlight||!(deviceInfo&&deviceInfo.passkeyManagement===true);rb.addEventListener('click',function(){removePasskeyDevice(p,d,rb);});dr.appendChild(rb);}devList.appendChild(dr);});row.appendChild(devList);}
      box.appendChild(row);
    });
    updateBiometricSummary(passkeyRecords);
  }
  async function removePasskeyDevice(passkey,device,button){if(!passkey||!device||!confirm(t('passkeyDeviceRemove')+' — '+(device.name||'')))return;if(button)button.disabled=true;try{var r=await appDeleteMutate('/app/webauthn/passkeys/'+encodeURIComponent(passkey.id)+'/devices/'+encodeURIComponent(device.id));if(!r.ok)throw new Error('remove-device');var data=await r.json();renderPasskeyList(data.passkeys||[]);toast(t('passkeyDeviceRemoved'),'ok');}catch(_){if(button)button.disabled=false;toast(t('biometricDisableFail'),'err');}}
  async function loadPasskeys() {
    if (passkeysLoadPromise) return passkeysLoadPromise;
    passkeysLoading = true;
    passkeysLoadPromise = (async function () {
      try {
      var r = await fetch('/app/webauthn/passkeys', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) {
        var failed = await r.clone().json().catch(function () { return {}; });
        if (r.status === 401 && failed.error === 'recent-auth-required' && deviceInfo) { deviceInfo.passkeyManagement = false; renderPasskeySection(); return; }
        throw new Error('load');
      }
      var data = await r.json();
      passkeysLoaded = true;
      renderPasskeyList(data.passkeys || []);
      return passkeyRecords;
      } catch (_) {
        passkeysLoaded = false;
        setBiometricStatus('biometricLoadFailed', 'error');
        return null;
      } finally {
        passkeysLoading = false;
        passkeysLoadPromise = null;
      }
    })();
    return passkeysLoadPromise;
  }
  async function addPasskey() {
    if (biometricMutationInFlight || biometricCapability !== true || !deviceInfo || deviceInfo.passkeyManagement !== true) { renderPasskeySection(); return; }
    var btn = $('add-passkey-btn'); if (!btn) return;
    var label = btn.textContent; setBiometricMutationBusy(true); btn.textContent = t('passkeyAdding');
    try {
      var optResp = await appMutate('/app/webauthn/register/options', 'application/json', '{}');
      if (!optResp.ok) {
        var optError = await optResp.clone().json().catch(function () { return {}; });
        if (optResp.status === 401 && optError.error === 'recent-auth-required') { deviceInfo.passkeyManagement = false; renderPasskeySection(); return; }
        if (optError.error === 'device-required') { setBiometricStatus('biometricPairRequired', 'warn'); toast(t('biometricPairRequired'), 'warn'); return; }
        var optionFailure = new Error('options'); optionFailure.serverError = optError.error || ''; throw optionFailure;
      }
      var opt = await optResp.json(), pk = opt.publicKey || {};
      var publicKey = {
        challenge: b64uToBuf(pk.challenge),
        rp: pk.rp,
        user: { id: b64uToBuf(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
        pubKeyCredParams: pk.pubKeyCredParams,
        authenticatorSelection: pk.authenticatorSelection,
        timeout: pk.timeout,
        attestation: pk.attestation,
        excludeCredentials: (pk.excludeCredentials || []).map(function (c) { return { type: 'public-key', id: b64uToBuf(c.id), transports: c.transports }; })
      };
      var cred = await navigator.credentials.create({ publicKey: publicKey });
      if (!cred) throw new Error('cancelled');
      var res = cred.response;
      var verify = await appMutate('/app/webauthn/register/verify', 'application/json', JSON.stringify({
        token: opt.token, name: t('biometricCredentialName', { device:platformName() }).slice(0, 60),
        credential: { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, response: { clientDataJSON: bufToB64u(res.clientDataJSON), attestationObject: bufToB64u(res.attestationObject), transports: typeof res.getTransports === 'function' ? res.getTransports() : [] } }
      }));
      var data = await verify.json().catch(function () { return {}; });
      if (!verify.ok || !data.ok) { var verifyFailure = new Error('verify'); verifyFailure.serverError = data.error || ''; throw verifyFailure; }
      passkeyRecords = Array.isArray(data.passkeys) ? data.passkeys : [];
      if (deviceInfo) deviceInfo.biometricEnabled = passkeyRecords.some(function (p) { return p && p.currentDevice; });
      toast(t(data.already ? 'biometricAlreadyEnabled' : 'passkeyAdded'), 'ok');
      renderPasskeyList(passkeyRecords);
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
      if (err && err.name === 'InvalidStateError') {
        // A synchronized passkey already present in the platform authenticator can
        // trigger this before the server receives anything. It remains usable for
        // login; explain the one-time association instead of reporting corruption.
        await loadPasskeys().catch(function () {});
        toast(t('biometricAlreadySynced'), 'warn');
      } else if (err && err.name === 'SecurityError') {
        toast(t('biometricDomainMismatch'), 'err');
      } else if (err && err.serverError) {
        toast(t('biometricServerRejected'), 'err');
      } else {
        toast(t('passkeyFailed'), 'err');
      }
    } finally {
      btn.textContent = label;
      setBiometricMutationBusy(false);
    }
  }
  async function biometricDelete(url) {
    var r = await fetch(url, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: appMutationHeaders() });
    if (r.status === 403) {
      var e = await r.clone().json().catch(function () { return {}; });
      if (e.error === 'invalid-csrf') {
        await fetchDeviceStatus();
        r = await fetch(url, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: appMutationHeaders() });
      }
    }
    return r;
  }
  async function removePasskey(record) {
    if (!record || !record.id || biometricMutationInFlight) return;
    var count = Math.max(1, Number(record.deviceCount) || 1);
    var confirmText = count > 1 ? t('passkeyRemoveSharedConfirm', { n:count }) : t('passkeyRemoveConfirm');
    if (!askConfirmation('passkey-remove', confirmText)) return;
    setBiometricMutationBusy(true);
    try {
      var r = await biometricDelete('/app/webauthn/passkeys/' + encodeURIComponent(record.id));
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        if (r.status === 401 && data.error === 'recent-auth-required' && deviceInfo) { deviceInfo.passkeyManagement = false; renderPasskeySection(); toast(t('biometricRecentAuth'), 'warn'); return; }
        throw new Error('delete');
      }
      passkeyRecords = data.passkeys || [];
      if (deviceInfo) deviceInfo.biometricEnabled = passkeyRecords.some(function (p) { return p && p.currentDevice; });
      toast(t('passkeyRemoved'), 'ok');
      renderPasskeyList(passkeyRecords);
    } catch (_) { toast(t('passkeyFailed'), 'err'); }
    finally { setBiometricMutationBusy(false); }
  }
  async function disableBiometricIdentification() {
    if (biometricMutationInFlight || !passkeysLoaded || !passkeyRecords.length) return;
    if (!askConfirmation('biometric-disable-all', t('biometricDisableConfirm'))) return;
    var btn = $('disable-biometric-btn'), label = btn ? btn.textContent : '';
    setBiometricMutationBusy(true);
    if (btn) btn.textContent = t('biometricDisabling');
    try {
      var r = await biometricDelete('/app/webauthn/passkeys');
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        if (r.status === 401 && data.error === 'recent-auth-required' && deviceInfo) {
          deviceInfo.passkeyManagement = false;
          toast(t('biometricRecentAuth'), 'warn');
          return;
        }
        throw new Error('disable');
      }
      passkeyRecords = [];
      passkeysLoaded = true;
      if (deviceInfo) {
        deviceInfo.biometricEnabled = false;
        deviceInfo.biometricCredentialCount = 0;
      }
      toast(t('biometricDisabled'), 'ok');
    } catch (_) { toast(t('passkeyFailed'), 'err'); }
    finally {
      if (btn) btn.textContent = label;
      setBiometricMutationBusy(false);
    }
  }
  async function reauthenticateForBiometric() {
    var btn = $('reauth-biometric-btn'); if (btn) btn.disabled = true;
    try {
      try { sessionStorage.setItem('dx-pwa-active-panel', 'settings'); } catch (_) {}
      if (!deviceInfo || !deviceInfo.csrf) await fetchDeviceStatus();
      if (!deviceInfo || !deviceInfo.csrf) throw new Error('status');
      var response = await fetchWithTimeout('/app/session/lock', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: appMutationHeaders('application/json'), body: JSON.stringify({ reason:'biometric-settings' })
      }, 5000);
      if (!response.ok) throw new Error('lock');
      location.replace('/app/login?next=' + encodeURIComponent('/app/'));
    } catch (_) {
      if (btn) btn.disabled = false;
      toast(t('biometricReauthFailed'), 'err');
    }
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
  var pendingModerationActions = new Set();
  async function moderateReceivedPending(token, id, action, rowEl) {
    if (!token || !id || (action !== 'approve' && action !== 'reject')) return;
    var key = token + ':' + id;
    if (pendingModerationActions.has(key)) return;
    pendingModerationActions.add(key);
    var buttons = rowEl ? Array.from(rowEl.querySelectorAll('button')) : [];
    buttons.forEach(function(btn){ btn.disabled = true; });
    try {
      var r = await appMutate('/app/inbox/' + encodeURIComponent(token) + '/pending/' + encodeURIComponent(id) + '/' + action, 'application/json', '{}');
      if (!r.ok) throw new Error('moderation');
      await loadReceivedFiles(token); loadReceptions();
      toast((action === 'approve' ? t('receivedApprove') : t('receivedReject')) + ' ✓', 'ok');
    } catch (_) { toast(t('receivedFail'), 'err'); }
    finally {
      pendingModerationActions.delete(key);
      if (rowEl && rowEl.isConnected) buttons.forEach(function(btn){ btn.disabled = false; });
    }
  }
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
    var pendingWrap = $('received-pending-wrap'), pendingList = $('received-pending-list');
    listEl.innerHTML = ''; if (pendingList) pendingList.innerHTML = ''; if (pendingWrap) pendingWrap.classList.add('hidden'); statusEl.textContent = t('receivedLoading');
    try {
      var pendingReq = fetch('/app/inbox/' + encodeURIComponent(token) + '/pending', { credentials: 'same-origin', cache: 'no-store' }).then(function(resp){ return resp.ok ? resp.json() : { pending: [] }; }).catch(function(){ return { pending: [] }; });
      var r = await fetch('/app/inbox/' + encodeURIComponent(token) + '/files', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      var data = await r.json();
      var pendingData = await pendingReq;
      var pending = Array.isArray(pendingData.pending) ? pendingData.pending : [];
      if (pending.length && pendingWrap && pendingList) {
        pendingWrap.classList.remove('hidden');
        pending.forEach(function(pendingFile){
          var prow=document.createElement('div'); prow.className='received-row';
          var pmain=document.createElement('div'); pmain.className='received-main';
          var pstrong=document.createElement('strong'); pstrong.textContent=pendingFile.name||'—'; pmain.appendChild(pstrong);
          var pmeta=document.createElement('div'); pmeta.className='received-meta'; pmeta.textContent=[fmtBytes(pendingFile.size||0), pendingFile.sender||'', pendingFile.at?fmtDate(pendingFile.at):''].filter(Boolean).join(' · '); pmain.appendChild(pmeta); prow.appendChild(pmain);
          var pacts=document.createElement('div'); pacts.className='share-link-actions';
          var approve=document.createElement('button'); approve.type='button'; approve.className='btn sm'; approve.textContent=t('receivedApprove'); approve.addEventListener('click',function(){ moderateReceivedPending(token,pendingFile.id,'approve',prow); }); pacts.appendChild(approve);
          var reject=document.createElement('button'); reject.type='button'; reject.className='btn danger sm'; reject.textContent=t('receivedReject'); reject.addEventListener('click',function(){ moderateReceivedPending(token,pendingFile.id,'reject',prow); }); pacts.appendChild(reject);
          prow.appendChild(pacts); pendingList.appendChild(prow);
        });
      }
      var files = Array.isArray(data.files) ? data.files : [];
      if (!files.length) { statusEl.textContent = pending.length ? t('receivedPendingCount', { n: pending.length }) : t('receivedEmpty'); return; }
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
    if (lastNetworkTest) lines.push('network: ' + Math.round(lastNetworkTest.latency || 0) + ' ms · up ' + fmtBytes(lastNetworkTest.uploadBps || 0) + '/s · down ' + fmtBytes(lastNetworkTest.downloadBps || 0) + '/s');
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

  // Manual update check ("Check for an update"). Calls reg.update() and
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
      refreshPwaNotifications();
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
  var lastPushFailure = null;
  function pushPromiseTimeout(promise, ms) {
    var timer = null;
    return Promise.race([
      promise,
      new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('push-timeout')); }, ms); })
    ]).finally(function () { if (timer) clearTimeout(timer); });
  }
  function pushApplicationKeyMatches(sub, expectedKey) {
    try {
      var actual = sub && sub.options && sub.options.applicationServerKey;
      if (!actual) return true; // older engines do not expose the subscription option
      var a = new Uint8Array(actual), b = expectedKey instanceof Uint8Array ? expectedKey : new Uint8Array(expectedKey);
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    } catch (_) { return true; }
  }
  async function retireBrowserPushSubscription(sub) {
    if (!sub) return;
    var endpoint = sub.endpoint || '';
    try { await pushPromiseTimeout(sub.unsubscribe(), 12000); } catch (_) {}
    if (endpoint) {
      try { await appMutate('/app/push/unsubscribe', 'application/json', JSON.stringify({ endpoint: endpoint })); } catch (_) {}
    }
  }
  function selectedPushLanguage() {
    var value = '';
    try { value = ($('push-language') && $('push-language').value) || localStorage.getItem('dx-pwa-push-lang') || lang || 'fr'; } catch (_) { value = lang || 'fr'; }
    value = String(value || '').toLowerCase().slice(0, 2);
    return value === 'en' || value === 'es' ? value : 'fr';
  }
  async function registerPushSubscription(allowPermissionPrompt, forceRenew) {
    lastPushFailure = null;
    try {
      if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { lastPushFailure = 'unsupported'; return false; }
      var perm = Notification.permission;
      if (perm !== 'granted' && allowPermissionPrompt) perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        if (perm === 'denied') { try { await appMutate('/app/push/permission-state', 'application/json', JSON.stringify({ permission:'denied' })); } catch (_) {} }
        lastPushFailure = perm === 'denied' ? 'denied' : 'permission'; return false;
      }
      var reg = swReg || await pushPromiseTimeout(navigator.serviceWorker.ready, 20000);
      var vr = await fetchWithTimeout('/app/push/vapid', { credentials: 'same-origin', cache: 'no-store' }, 15000);
      var vp = await vr.json().catch(function () { return null; });
      if (!vr.ok || !vp || !vp.publicKey) { lastPushFailure = 'vapid'; return false; }
      var serverKey = urlB64ToUint8Array(vp.publicKey);
      var sub = await pushPromiseTimeout(reg.pushManager.getSubscription(), 15000);
      var repairedPush = false;
      // Push subscriptions are bound to the VAPID/application server public key.
      // A restored/recreated Direct-Xfer instance can have a new VAPID key while
      // Android still holds the old subscription. Replace it instead of silently
      // re-posting an endpoint that the current VAPID identity cannot use.
      if (sub && (forceRenew || !pushApplicationKeyMatches(sub, serverKey))) {
        repairedPush = true;
        await retireBrowserPushSubscription(sub);
        sub = null;
      }
      if (!sub) sub = await pushPromiseTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey }), 25000);
      var r = await appMutate('/app/push/subscribe', 'application/json', JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub, language: selectedPushLanguage(), repaired: repairedPush }));
      if (!r.ok) { lastPushFailure = 'server-register'; return false; }
      return true;
    } catch (e) { lastPushFailure = e && e.message ? e.message : 'push-error'; return false; }
  }
  async function enablePush(forceRenew) { return registerPushSubscription(true, forceRenew === true); }
  async function syncPushSubscription() { return registerPushSubscription(false, false); }
  async function disablePush() {
    var endpoint = '';
    try {
      var reg = swReg || await pushPromiseTimeout(navigator.serviceWorker.ready, 20000);
      var sub = await pushPromiseTimeout(reg.pushManager.getSubscription(), 15000);
      if (sub) {
        endpoint = sub.endpoint || '';
        try { await pushPromiseTimeout(sub.unsubscribe(), 12000); } catch (_) {}
      }
    } catch (_) {}
    // Always remove the server-side record even when Android/Chrome hangs while
    // unsubscribing locally. Re-enabling Push force-creates a fresh browser
    // subscription, so a half-failed disable cannot resurrect a stale endpoint.
    if (endpoint) { try { await appMutate('/app/push/unsubscribe', 'application/json', JSON.stringify({ endpoint: endpoint })); } catch (_) {} }
  }

  function setPushTestStatus(key, tone, vars) {
    var el = $('push-test-status'); if (!el) return;
    el.textContent = key ? t(key, vars || {}) : '';
    el.className = 'muted sm' + (tone === 'ok' ? ' ok' : tone === 'err' ? ' err' : '');
  }
  var pushReceiptWaiters = new Map();
  var pushReceiptSeen = new Map();
  var activePushTest = null;
  function pushDeliveryMs(receipt, fallbackSentAt) {
    if (!receipt) return 0;
    var receivedAt = Number(receipt.receivedAt) || Date.now();
    var sentAt = Number(receipt.sentAt) || Number(fallbackSentAt) || receivedAt;
    return Math.max(0, receivedAt - sentAt);
  }
  function notePushReceipt(data) {
    var id = data && data.testId ? String(data.testId) : '';
    if (!id) return;
    var receipt = {
      receivedAt: Number(data.receivedAt) || Date.now(),
      sentAt: Number(data.sentAt) || 0,
      swVersion: data.swVersion ? String(data.swVersion) : ''
    };
    pushReceiptSeen.set(id, receipt);
    var waiter = pushReceiptWaiters.get(id);
    if (waiter) { pushReceiptWaiters.delete(id); clearTimeout(waiter.timer); waiter.resolve(receipt); }
    if (activePushTest && activePushTest.id === id) {
      setPushTestStatus('pushTestDelivered', 'ok', { ms: pushDeliveryMs(receipt, activePushTest.sentAt) });
    }
    // Keep only a tiny recent receipt cache; this is diagnostic state, not history.
    if (pushReceiptSeen.size > 12) pushReceiptSeen.delete(pushReceiptSeen.keys().next().value);
  }
  function waitForPushReceipt(id, ms) {
    if (pushReceiptSeen.has(id)) return Promise.resolve(pushReceiptSeen.get(id));
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { pushReceiptWaiters.delete(id); resolve(null); }, ms);
      pushReceiptWaiters.set(id, { resolve: resolve, timer: timer });
    });
  }
  async function currentPushSubscription() {
    var reg = swReg || await pushPromiseTimeout(navigator.serviceWorker.ready, 20000);
    return { reg: reg, sub: await pushPromiseTimeout(reg.pushManager.getSubscription(), 15000) };
  }
  async function postPushTest(endpoint, testId) {
    var r = await appMutate('/app/push/test', 'application/json', JSON.stringify({ endpoint: endpoint, testId: testId }));
    var data = null; try { data = await r.clone().json(); } catch (_) {}
    return { response: r, data: data || {} };
  }
  async function testPushNotifications() {
    var btn = $('push-test-btn'); if (!btn) return;
    var old = btn.textContent; btn.disabled = true; setPushTestStatus('pushTestPreparing');
    var testId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('dx-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    activePushTest = { id: testId, sentAt: 0 };
    try {
      if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { setPushTestStatus('pushTestUnsupported', 'err'); return; }
      if (Notification.permission === 'denied') { setPushTestStatus('pushTestDenied', 'err'); return; }
      var ok = await registerPushSubscription(true, false);
      if (!ok) { setPushTestStatus(lastPushFailure === 'denied' ? 'pushTestDenied' : 'pushTestFailed', 'err'); return; }
      var current = await currentPushSubscription();
      if (!current.sub) { setPushTestStatus('pushTestNoSub', 'err'); return; }
      setPushTestStatus('pushTestSending');
      var requestStartedAt = Date.now();
      var result = await postPushTest(current.sub.endpoint, testId);
      // A stale endpoint or a vendor rejection commonly means Android kept a
      // subscription tied to an older VAPID identity. Recreate it once and retry.
      if (!result.response.ok && (result.data.error === 'stale-subscription' || result.data.error === 'push-service-rejected')) {
        setPushTestStatus('pushTestRepairing');
        ok = await registerPushSubscription(false, true);
        if (ok) {
          current = await currentPushSubscription();
          if (current.sub) {
            requestStartedAt = Date.now();
            result = await postPushTest(current.sub.endpoint, testId);
          }
        }
      }
      if (result.response.ok) {
        if ($('live-push')) $('live-push').checked = true;
        try { localStorage.setItem('dx-pwa-push', '1'); } catch (_) {}
        var acceptedAt = Date.now();
        var sentAt = Number(result.data.sentAt) || requestStartedAt;
        activePushTest.sentAt = sentAt;
        setPushTestStatus('pushTestAccepted', '', { ms: Math.max(0, acceptedAt - requestStartedAt) });
        // Start the Android delivery window ONLY after the push service accepted the
        // message. Subscription repair / VAPID negotiation can take many seconds and
        // must not consume the delivery timeout before a push was even sent.
        var receipt = await waitForPushReceipt(testId, 30000);
        if (receipt) {
          var deliveryMs = pushDeliveryMs(receipt, sentAt);
          setPushTestStatus('pushTestDelivered', 'ok', { ms: deliveryMs });
          toast(t('pushTestDelivered', { ms: deliveryMs }), 'ok');
        } else {
          // HTTP success only means the push service accepted the message. Delivery
          // can still be deferred downstream; keep listening so a late receipt from
          // the service worker updates this status when it eventually arrives.
          setPushTestStatus('pushTestAcceptedDelayed', 'warn', { seconds: 30 });
          toast(t('pushTestAcceptedDelayed', { seconds: 30 }), 'warn');
        }
      } else {
        setPushTestStatus(result.data.error === 'no-subscription' ? 'pushTestNoSub' : 'pushTestFailed', 'err');
        toast(t('pushTestFailed'), 'err');
      }
    } catch (_) { setPushTestStatus('pushTestFailed', 'err'); toast(t('pushTestFailed'), 'err'); }
    finally { btn.disabled = false; btn.textContent = old; }
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
  var annItem = null, annCanvas = null, annCtx = null, annTool = 'pen', annUndoStack = [], annBaseSnapshot = null, annAtBase = true, annDrawing = false, annStart = null, annLastPoint = null, annGestureChanged = false, annPrevFocus = null, annOperations = [];
  var annResolve = null, annSourceFile = null, annSmartMode = false, annBusy = false, annExporting = false;
  var annZoom = 1, annPanning = null, annPinch = null, annResizeFrame = 0, annSession = 0, annOcrInFlight = false;
  function beginAnnotateSession() {
    annSession += 1; annExporting = false; setAnnBusy(false); return annSession;
  }
  function annSessionMatches(session, canvas) {
    return session === annSession && !!annCanvas && (!canvas || canvas === annCanvas);
  }
  async function loadAnnotateCanvas(file, session) {
    var img = await loadImage(file);
    try {
      if (session !== annSession) return false;
      var canvas = $('annotate-canvas'), context = canvas && canvas.getContext('2d');
      if (!canvas || !context) throw new Error('canvas-unavailable');
      var w = Number(img.naturalWidth || img.width) || 0, h = Number(img.naturalHeight || img.height) || 0, scale = 1;
      if (!(w > 0 && h > 0)) throw new Error('invalid-image-size');
      // Preserve normal phone/camera resolution. Only exceptionally large canvases
      // offer an explicit memory-saving working copy; cancelling keeps every pixel.
      if ((Math.max(w, h) > 8192 || w * h > 40000000) && window.confirm(t('editorLargeConfirm', { w: w, h: h }))) {
        scale = Math.min(1, 1800 / Math.max(w, h));
      }
      if (session !== annSession) return false;
      canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
      context.drawImage(img, 0, 0, canvas.width, canvas.height);
      annCanvas = canvas; annCtx = context;
      annUndoStack = []; annBaseSnapshot = null; annAtBase = true;
      pushAnnUndo(); annBaseSnapshot = annUndoStack[0] || null; annAtBase = true; updateAnnHistoryControls(); setAnnTool('blur');
      if ($('ann-brightness')) $('ann-brightness').value = '100';
      if ($('ann-contrast')) $('ann-contrast').value = '100';
      if ($('ann-saturation')) $('ann-saturation').value = '100';
      if ($('ann-resize-max')) $('ann-resize-max').value = '2048';
      if ($('ann-output-format')) $('ann-output-format').value = 'keep';
      if ($('ann-output-quality')) $('ann-output-quality').value = '99';
      if ($('ann-brush-size')) $('ann-brush-size').value = String(Math.max(2, Math.min(200, Math.round(Math.max(canvas.width, canvas.height) / 180))));
      updateAnnBrushSize(); annZoom = 1; annPanning = null; annPinch = null;
      refreshEditorDimensions();
      return true;
    } finally {
      if (img && img.close) try { img.close(); } catch (_) {}
    }
  }
  function setAnnStatus(text, kind) {
    var el = $('ann-detect-status'); if (!el) return;
    el.textContent = text || ''; el.className = 'muted sm ann-detect-status' + (kind ? ' ' + kind : '');
  }
  function setAnnBusy(busy) {
    annBusy = !!busy;
    var overlay = $('annotate-overlay'); if (overlay) overlay.querySelector('.annotate-dialog').classList.toggle('detecting', annBusy);
    ['ann-pan','ann-pen','ann-blur','ann-redact','ann-detect-faces','ann-detect-plates','ann-detect-sensitive','ann-rotate-left','ann-rotate-right','ann-flip-h','ann-flip-v','ann-crop-square','ann-crop-43','ann-crop-169','ann-adjust-apply','ann-resize-apply','ann-apply','ann-cancel'].forEach(function (id) { if ($(id)) $(id).disabled = annBusy; });
    updateAnnHistoryControls();
  }
  function showAnnotateOverlay() {
    $('annotate-overlay').classList.remove('hidden');
    requestAnimationFrame(function () {
      setEditorZoom(1);
      var activeTool = $('ann-' + annTool); if (activeTool && !activeTool.disabled) activeTool.focus();
    });
  }
  async function openAnnotate(it) {
    if (!it.file) return;
    var session = beginAnnotateSession(), loaded = false;
    try { loaded = await loadAnnotateCanvas(it.file, session); } catch (_) { if (session === annSession) toast(t('optimizeFallback'), 'warn'); return; }
    if (!loaded || session !== annSession) return;
    annItem = it; annSourceFile = it.file; annResolve = null; annSmartMode = false;
    if ($('ann-cancel')) $('ann-cancel').textContent = t('cancel');
    setAnnStatus(''); annPrevFocus = document.activeElement; showAnnotateOverlay();
  }
  async function openImageLinkEditor(file) {
    if (!file) return null;
    var session = beginAnnotateSession(), loaded = false;
    try { loaded = await loadAnnotateCanvas(file, session); } catch (_) { if (session === annSession) toast(t('optimizeFallback'), 'warn'); return null; }
    if (!loaded || session !== annSession) return null;
    annItem = null; annSourceFile = file; annResolve = null; annSmartMode = false; annOperations = [];
    if ($('ann-cancel')) $('ann-cancel').textContent = t('cancel');
    setAnnStatus(''); annPrevFocus = document.activeElement; showAnnotateOverlay();
    // closeAnnotate resolves with the original File, which lets the caller
    // distinguish Cancel/Escape from an image exported with Apply.
    return new Promise(function (resolve) { annResolve = resolve; });
  }
  async function openSmartBlurReview(file, mode) {
    if (!file || !mode || mode === 'off') return file;
    var session = beginAnnotateSession(), loaded = false;
    try { loaded = await loadAnnotateCanvas(file, session); } catch (_) { if (session === annSession) toast(t('optimizeFallback'), 'warn'); return file; }
    if (!loaded || session !== annSession) return file;
    annItem = null; annSourceFile = file; annSmartMode = true;
    if ($('ann-cancel')) $('ann-cancel').textContent = t('imgSmartBlurSkip');
    annPrevFocus = document.activeElement; showAnnotateOverlay();
    setAnnStatus(t('imgSmartBlurAnalyzing'));
    return new Promise(function (resolve) {
      annResolve = resolve;
      setTimeout(async function () {
        if (!annSessionMatches(session)) return;
        var n = 0;
        try {
          setAnnBusy(true);
          if (mode === 'faces' || mode === 'faces-plates' || mode === 'faces-plates-text') n += await detectAndBlurFaces(false);
          if (mode === 'faces-plates' || mode === 'faces-plates-text') n += await detectAndBlurPlates(false);
          if (mode === 'faces-plates-text') n += await detectAndBlurSensitiveText(false);
          if (!annSessionMatches(session)) return;
          if (n) pushAnnUndo();
          setAnnStatus(n ? t('imgSmartBlurReady', { n: n }) : (('FaceDetector' in window) ? t('imgSmartBlurReady', { n: 0 }) : t('imgSmartBlurUnsupported')), n ? 'ok' : 'warn');
        } catch (_) { if (annSessionMatches(session)) setAnnStatus(t('imgSmartBlurUnsupported'), 'warn'); }
        finally { if (annSessionMatches(session)) setAnnBusy(false); }
      }, 30);
    });
  }
  function captureAnnSnapshot() {
    if (!annCanvas || !annCtx) return null;
    try { return { width: annCanvas.width, height: annCanvas.height, pixels: annCtx.getImageData(0, 0, annCanvas.width, annCanvas.height) }; }
    catch (_) { return null; }
  }
  function restoreAnnSnapshot(snapshot) {
    if (!snapshot || !annCanvas) return false;
    try {
      if (annCanvas.width !== snapshot.width || annCanvas.height !== snapshot.height) { annCanvas.width = snapshot.width; annCanvas.height = snapshot.height; }
      annCtx = annCanvas.getContext('2d'); annCtx.putImageData(snapshot.pixels, 0, 0);
      annAtBase = snapshot === annBaseSnapshot;
      refreshEditorDimensions(); scheduleEditorZoomLayout(); updateAnnHistoryControls(); return true;
    } catch (_) { return false; }
  }
  function updateAnnHistoryControls() {
    if ($('ann-undo')) $('ann-undo').disabled = annBusy || annUndoStack.length <= 1;
    if ($('ann-clear')) $('ann-clear').disabled = annBusy || !annBaseSnapshot || annAtBase;
  }
  function pushAnnUndo(existingSnapshot) {
    var snapshot = existingSnapshot || captureAnnSnapshot(); if (!snapshot) { updateAnnHistoryControls(); return false; }
    // Bound exact ImageData history by both count and an approximate 96 MiB budget.
    // This prevents a 12–40 MP phone photo from allocating fifteen full-size copies.
    var bytes = Math.max(1, snapshot.width * snapshot.height * 4);
    var maxUndo = Math.max(2, Math.min(15, Math.floor((96 * 1024 * 1024) / bytes)));
    annUndoStack.push(snapshot);
    while (annUndoStack.length > maxUndo) annUndoStack.shift();
    annAtBase = !!annBaseSnapshot && snapshot === annBaseSnapshot;
    updateAnnHistoryControls(); return true;
  }
  function annUndo() { if (!annBusy && annUndoStack.length > 1) { annUndoStack.pop(); restoreAnnSnapshot(annUndoStack[annUndoStack.length - 1]); setAnnStatus(''); updateAnnHistoryControls(); } }
  function annClear() {
    if (!annBusy && !annAtBase && annBaseSnapshot && restoreAnnSnapshot(annBaseSnapshot)) {
      // Reuse the immutable base snapshot rather than allocating an identical full
      // ImageData copy. Clear remains undoable while using far less memory.
      if (!pushAnnUndo(annBaseSnapshot)) annUndoStack = [annBaseSnapshot];
      annAtBase = true; updateAnnHistoryControls();
      setAnnStatus('');
    }
  }
  function refreshEditorDimensions() {
    if ($('editor-dimensions') && annCanvas) $('editor-dimensions').textContent = annCanvas.width + '×' + annCanvas.height;
  }
  function readAnnBrushSize() {
    var input = $('ann-brush-size'); return input ? Math.max(2, Math.min(200, Number(input.value) || 20)) : 20;
  }
  function updateAnnBrushSize() {
    var input = $('ann-brush-size'), value = readAnnBrushSize();
    if (input) input.value = String(value);
    if ($('ann-brush-value')) $('ann-brush-value').textContent = Math.round(value) + ' px';
    if (annDrawing && annCtx && (annTool === 'pen' || annTool === 'redact')) annCtx.lineWidth = value;
    return value;
  }
  function editorZoomAnchor(clientX, clientY) {
    var wrap = $('annotate-canvas-wrap');
    if (!wrap || !annCanvas) return null;
    var wrapRect = wrap.getBoundingClientRect(), canvasRect = annCanvas.getBoundingClientRect();
    if (!(canvasRect.width > 0 && canvasRect.height > 0)) return null;
    if (!Number.isFinite(clientX)) clientX = wrapRect.left + wrap.clientWidth / 2;
    if (!Number.isFinite(clientY)) clientY = wrapRect.top + wrap.clientHeight / 2;
    return {
      x: Math.max(0, Math.min(1, (clientX - canvasRect.left) / canvasRect.width)),
      y: Math.max(0, Math.min(1, (clientY - canvasRect.top) / canvasRect.height)),
      viewX: clientX - wrapRect.left,
      viewY: clientY - wrapRect.top
    };
  }
  function setEditorZoom(nextZoom, point) {
    if (!annCanvas) return;
    var wrap = $('annotate-canvas-wrap'), stage = $('annotate-canvas-stage');
    if (!wrap || !stage || !wrap.clientWidth || !wrap.clientHeight) return;
    var anchor = editorZoomAnchor(point && point.clientX, point && point.clientY);
    annZoom = Math.max(.25, Math.min(4, Number(nextZoom) || 1));
    var availableWidth = Math.max(1, wrap.clientWidth - 12), availableHeight = Math.max(1, wrap.clientHeight - 12);
    var fitScale = Math.min(1, availableWidth / annCanvas.width, availableHeight / annCanvas.height);
    var displayWidth = Math.max(1, annCanvas.width * fitScale * annZoom);
    var displayHeight = Math.max(1, annCanvas.height * fitScale * annZoom);
    annCanvas.style.width = displayWidth + 'px'; annCanvas.style.height = displayHeight + 'px';
    stage.style.width = Math.max(wrap.clientWidth, displayWidth + 12) + 'px';
    stage.style.height = Math.max(wrap.clientHeight, displayHeight + 12) + 'px';
    if ($('ann-zoom')) $('ann-zoom').value = String(Math.round(annZoom * 100));
    if ($('ann-zoom-value')) $('ann-zoom-value').textContent = Math.round(annZoom * 100) + ' %';
    if ($('ann-zoom-out')) $('ann-zoom-out').disabled = annZoom <= .25;
    if ($('ann-zoom-in')) $('ann-zoom-in').disabled = annZoom >= 4;
    if (anchor) requestAnimationFrame(function () {
      wrap.scrollLeft = annCanvas.offsetLeft + anchor.x * annCanvas.offsetWidth - anchor.viewX;
      wrap.scrollTop = annCanvas.offsetTop + anchor.y * annCanvas.offsetHeight - anchor.viewY;
    });
  }
  function stepEditorZoom(direction, point) {
    setEditorZoom(Math.round((annZoom + direction * .25) * 4) / 4, point);
  }
  function scheduleEditorZoomLayout() {
    if (!annCanvas || $('annotate-overlay').classList.contains('hidden')) return;
    cancelAnimationFrame(annResizeFrame);
    annResizeFrame = requestAnimationFrame(function () { annResizeFrame = 0; setEditorZoom(annZoom); });
  }
  function replaceEditorCanvas(tmp) {
    annCanvas.width = tmp.width; annCanvas.height = tmp.height; annCtx = annCanvas.getContext('2d'); annCtx.drawImage(tmp, 0, 0);
    pushAnnUndo();
    refreshEditorDimensions(); scheduleEditorZoomLayout(); setAnnStatus('');
  }
  function rotateAnnotate(dir) {
    if (!annCanvas || annBusy) return;
    var tmp=document.createElement('canvas'); tmp.width=annCanvas.height; tmp.height=annCanvas.width; var c=tmp.getContext('2d');
    if (dir < 0) { c.translate(0,tmp.height); c.rotate(-Math.PI/2); } else { c.translate(tmp.width,0); c.rotate(Math.PI/2); }
    c.drawImage(annCanvas,0,0); replaceEditorCanvas(tmp); annOperations.push(dir < 0 ? 'rotate-left' : 'rotate-right');
  }
  function flipAnnotate(horizontal) {
    if (!annCanvas || annBusy) return;
    var tmp=document.createElement('canvas'); tmp.width=annCanvas.width; tmp.height=annCanvas.height; var c=tmp.getContext('2d');
    c.save(); c.translate(horizontal ? tmp.width : 0, horizontal ? 0 : tmp.height); c.scale(horizontal ? -1 : 1, horizontal ? 1 : -1); c.drawImage(annCanvas,0,0); c.restore(); replaceEditorCanvas(tmp); annOperations.push(horizontal ? 'flip-horizontal' : 'flip-vertical');
  }
  function adjustedEditorChannel(value, brightness, contrast) {
    return Math.max(0, Math.min(255, (value * brightness - 128) * contrast + 128));
  }
  function applyEditorAdjustmentsFallback(brightness, contrast, saturation) {
    var imageData = annCtx.getImageData(0, 0, annCanvas.width, annCanvas.height), data = imageData.data;
    var b = brightness / 100, c = contrast / 100, s = saturation / 100;
    for (var i = 0; i < data.length; i += 4) {
      var r = adjustedEditorChannel(data[i], b, c), g = adjustedEditorChannel(data[i + 1], b, c), blue = adjustedEditorChannel(data[i + 2], b, c);
      var luminance = r * .2126 + g * .7152 + blue * .0722;
      data[i] = Math.max(0, Math.min(255, luminance + (r - luminance) * s));
      data[i + 1] = Math.max(0, Math.min(255, luminance + (g - luminance) * s));
      data[i + 2] = Math.max(0, Math.min(255, luminance + (blue - luminance) * s));
    }
    annCtx.putImageData(imageData, 0, 0);
  }
  function applyEditorAdjustments() {
    if (!annCanvas || annBusy) return;
    var b=Number($('ann-brightness')&&$('ann-brightness').value)||100, c0=Number($('ann-contrast')&&$('ann-contrast').value)||100, sat=Number($('ann-saturation')&&$('ann-saturation').value)||100;
    if (b===100 && c0===100 && sat===100) return;
    try {
      var tmp=document.createElement('canvas'); tmp.width=annCanvas.width; tmp.height=annCanvas.height; var c=tmp.getContext('2d');
      if (c && 'filter' in c) {
        c.filter='brightness('+b+'%) contrast('+c0+'%) saturate('+sat+'%)'; c.drawImage(annCanvas,0,0); c.filter='none'; annCtx.clearRect(0,0,annCanvas.width,annCanvas.height); annCtx.drawImage(tmp,0,0);
      } else applyEditorAdjustmentsFallback(b, c0, sat);
      pushAnnUndo();
    } catch (_) { toast(t('error'), 'err'); setAnnStatus(t('error'), 'err'); return; }
    $('ann-brightness').value='100'; $('ann-contrast').value='100'; $('ann-saturation').value='100';
    annOperations.push('adjustments'); setAnnStatus('');
  }
  function resizeAnnotate() {
    if (!annCanvas || annBusy) return;
    var max=Math.max(128,Math.min(8192,Number($('ann-resize-max')&&$('ann-resize-max').value)||2048));
    if ($('ann-resize-max')) $('ann-resize-max').value = String(Math.round(max));
    if (Math.max(annCanvas.width,annCanvas.height)<=max) return;
    var scale=max/Math.max(annCanvas.width,annCanvas.height), tmp=document.createElement('canvas'); tmp.width=Math.max(1,Math.round(annCanvas.width*scale)); tmp.height=Math.max(1,Math.round(annCanvas.height*scale));
    var c=tmp.getContext('2d'); c.imageSmoothingEnabled=true; c.imageSmoothingQuality='high'; c.drawImage(annCanvas,0,0,tmp.width,tmp.height); replaceEditorCanvas(tmp); annOperations.push('resize-'+tmp.width+'x'+tmp.height);
  }
  function cropAnnotate(ratio) {
    if (!annCanvas || !annCtx || !ratio || annBusy) return;
    var sw = annCanvas.width, sh = annCanvas.height, tw = sw, th = Math.round(sw / ratio);
    if (th > sh) { th = sh; tw = Math.round(sh * ratio); }
    if (tw === sw && th === sh) return;
    var sx = Math.max(0, Math.round((sw - tw) / 2)), sy = Math.max(0, Math.round((sh - th) / 2));
    var tmp = document.createElement('canvas'); tmp.width = tw; tmp.height = th;
    tmp.getContext('2d').drawImage(annCanvas, sx, sy, tw, th, 0, 0, tw, th);
    replaceEditorCanvas(tmp); annOperations.push('crop-'+tw+'x'+th);
  }
  function setAnnTool(tool) {
    if (annBusy) return;
    annTool = tool;
    ['pan','pen','blur','redact'].forEach(function (name) { if ($('ann-' + name)) { $('ann-' + name).classList.toggle('is-active', tool === name); $('ann-' + name).setAttribute('aria-pressed', tool === name ? 'true' : 'false'); } });
    if ($('annotate-canvas-wrap')) $('annotate-canvas-wrap').classList.toggle('is-pan-mode', tool === 'pan');
  }
  function annClientPoint(e) {
    var touch = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
    return { clientX: Number(touch && touch.clientX) || 0, clientY: Number(touch && touch.clientY) || 0 };
  }
  function annTouchDistance(touches) {
    var dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY;
    return Math.max(1, Math.hypot(dx, dy));
  }
  function annTouchMidpoint(touches) {
    return { clientX: (touches[0].clientX + touches[1].clientX) / 2, clientY: (touches[0].clientY + touches[1].clientY) / 2 };
  }
  function annPos(e) {
    var r = annCanvas.getBoundingClientRect();
    var touch = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
    if (!(r.width > 0 && r.height > 0)) return null;
    var cx = Math.max(0, Math.min(r.width, touch.clientX - r.left)), cy = Math.max(0, Math.min(r.height, touch.clientY - r.top));
    return { x: cx * (annCanvas.width / r.width), y: cy * (annCanvas.height / r.height) };
  }
  function paintSolidBrushSegment(a, b, size, color) {
    if (!a || !b || !annCtx) return false;
    annCtx.save(); annCtx.strokeStyle = color; annCtx.fillStyle = color; annCtx.lineWidth = size; annCtx.lineCap = 'round'; annCtx.lineJoin = 'round';
    annCtx.beginPath(); annCtx.moveTo(a.x, a.y); annCtx.lineTo(b.x, b.y); annCtx.stroke();
    if (a.x === b.x && a.y === b.y) { annCtx.beginPath(); annCtx.arc(a.x, a.y, size / 2, 0, Math.PI * 2); annCtx.fill(); }
    annCtx.restore(); return true;
  }
  function pixelateBrushAt(point, size) {
    if (!point || !annCanvas || !annCtx) return false;
    var radius = Math.max(1, size / 2), x = Math.max(0, Math.floor(point.x - radius)), y = Math.max(0, Math.floor(point.y - radius));
    var right = Math.min(annCanvas.width, Math.ceil(point.x + radius)), bottom = Math.min(annCanvas.height, Math.ceil(point.y + radius));
    var w = right - x, h = bottom - y; if (w < 1 || h < 1) return false;
    var block = Math.max(3, Math.min(24, Math.round(size / 8))), tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w / block)); tmp.height = Math.max(1, Math.round(h / block));
    tmp.getContext('2d').drawImage(annCanvas, x, y, w, h, 0, 0, tmp.width, tmp.height);
    annCtx.save(); annCtx.beginPath(); annCtx.arc(point.x, point.y, radius, 0, Math.PI * 2); annCtx.clip(); annCtx.imageSmoothingEnabled = false;
    annCtx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h); annCtx.restore(); return true;
  }
  function pixelateBrushSegment(a, b, size) {
    if (!a || !b) return false;
    var distance = Math.hypot(b.x - a.x, b.y - a.y), spacing = Math.max(1, size / 5), steps = Math.max(1, Math.ceil(distance / spacing)), changed = false;
    for (var i = 0; i <= steps; i++) changed = pixelateBrushAt({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, size) || changed;
    return changed;
  }
  function annDown(e) {
    if (annBusy) return;
    if (!e.touches && Number(e.button) !== 0) return;
    if (e.touches && e.touches.length > 1) {
      e.preventDefault();
      if (annDrawing && annUndoStack.length) restoreAnnSnapshot(annUndoStack[annUndoStack.length - 1]);
      annDrawing = false; annLastPoint = null; annGestureChanged = false; annPanning = null;
      if ($('annotate-canvas-wrap')) $('annotate-canvas-wrap').classList.remove('is-panning');
      annPinch = { distance: annTouchDistance(e.touches), zoom: annZoom };
      return;
    }
    e.preventDefault();
    if (annTool === 'pan') {
      var wrap = $('annotate-canvas-wrap'), point = annClientPoint(e);
      annPanning = { clientX: point.clientX, clientY: point.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
      wrap.classList.add('is-panning'); return;
    }
    annDrawing = true; annStart = annPos(e); annLastPoint = annStart; annGestureChanged = false;
    if (!annStart) { annDrawing = false; return; }
    var brushSize = readAnnBrushSize();
    if (annTool === 'pen') {
      annCtx.strokeStyle = '#ff3b5c'; annCtx.fillStyle = '#ff3b5c'; annCtx.lineWidth = updateAnnBrushSize(); brushSize = annCtx.lineWidth; annCtx.lineCap = 'round'; annCtx.lineJoin = 'round'; annCtx.beginPath(); annCtx.moveTo(annStart.x, annStart.y);
      annCtx.beginPath(); annCtx.arc(annStart.x, annStart.y, brushSize / 2, 0, Math.PI * 2); annCtx.fill(); annCtx.beginPath(); annCtx.moveTo(annStart.x, annStart.y); annGestureChanged = true;
    } else if (annTool === 'blur') annGestureChanged = pixelateBrushAt(annStart, brushSize);
    else if (annTool === 'redact') annGestureChanged = paintSolidBrushSegment(annStart, annStart, brushSize, '#000');
  }
  function annMove(e) {
    if (annPinch && e.touches && e.touches.length > 1) {
      e.preventDefault(); setEditorZoom(annPinch.zoom * annTouchDistance(e.touches) / annPinch.distance, annTouchMidpoint(e.touches)); return;
    }
    if (annPanning) {
      e.preventDefault(); var wrap = $('annotate-canvas-wrap'), point = annClientPoint(e);
      wrap.scrollLeft = annPanning.left - (point.clientX - annPanning.clientX);
      wrap.scrollTop = annPanning.top - (point.clientY - annPanning.clientY); return;
    }
    if (!annDrawing) return; e.preventDefault(); var p = annPos(e); if (!p) return;
    var brushSize = readAnnBrushSize();
    if (annTool === 'pen') { annCtx.lineTo(p.x, p.y); annCtx.stroke(); annGestureChanged = true; }
    else if (annTool === 'blur') annGestureChanged = pixelateBrushSegment(annLastPoint, p, brushSize) || annGestureChanged;
    else if (annTool === 'redact') annGestureChanged = paintSolidBrushSegment(annLastPoint, p, brushSize, '#000') || annGestureChanged;
    annLastPoint = p;
  }
  function annUp(e) {
    if (annPinch) { if (!e.touches || e.touches.length < 2) annPinch = null; annDrawing = false; return; }
    if (annPanning) { annPanning = null; if ($('annotate-canvas-wrap')) $('annotate-canvas-wrap').classList.remove('is-panning'); return; }
    if (!annDrawing) return;
    var p = annPos(e), brushSize = readAnnBrushSize();
    if (p && annLastPoint && (p.x !== annLastPoint.x || p.y !== annLastPoint.y)) {
      if (annTool === 'pen') { annCtx.lineTo(p.x, p.y); annCtx.stroke(); annGestureChanged = true; }
      else if (annTool === 'blur') annGestureChanged = pixelateBrushSegment(annLastPoint, p, brushSize) || annGestureChanged;
      else if (annTool === 'redact') annGestureChanged = paintSolidBrushSegment(annLastPoint, p, brushSize, '#000') || annGestureChanged;
    }
    annDrawing = false; annStart = null; annLastPoint = null;
    if (annGestureChanged) { pushAnnUndo(); annOperations.push(annTool === 'pen' ? 'draw' : annTool === 'blur' ? 'blur' : annTool === 'redact' ? 'redact' : annTool); } annGestureChanged = false;
  }
  function cancelAnnGesture() {
    if (annDrawing && annUndoStack.length) restoreAnnSnapshot(annUndoStack[annUndoStack.length - 1]);
    annDrawing = false; annStart = null; annLastPoint = null; annGestureChanged = false; annPinch = null; annPanning = null;
    if ($('annotate-canvas-wrap')) $('annotate-canvas-wrap').classList.remove('is-panning');
  }
  function normalizedAnnRect(a, b) {
    var ax = Math.max(0, Math.min(annCanvas.width, Number(a && a.x) || 0));
    var ay = Math.max(0, Math.min(annCanvas.height, Number(a && a.y) || 0));
    var bx = Math.max(0, Math.min(annCanvas.width, Number(b && b.x) || 0));
    var by = Math.max(0, Math.min(annCanvas.height, Number(b && b.y) || 0));
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) };
  }
  function redactRect(a, b) {
    var rect = normalizedAnnRect(a, b), x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    if (w < 4 || h < 4) return;
    annCtx.save(); annCtx.fillStyle = '#000'; annCtx.fillRect(x, y, w, h); annCtx.restore();
  }
  function pixelateRect(a, b) {
    var rect = normalizedAnnRect(a, b), x = rect.x, y = rect.y, w = rect.w, h = rect.h;
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
    var session = annSession, canvas = annCanvas;
    if (!canvas || !('FaceDetector' in window)) { if (annSessionMatches(session, canvas)) setAnnStatus(t('imgSmartBlurUnsupported'), 'warn'); return 0; }
    setAnnBusy(true); setAnnStatus(t('imgSmartBlurAnalyzing'));
    try {
      var detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 40 });
      var faces = await detector.detect(canvas);
      if (!annSessionMatches(session, canvas)) return 0;
      var boxes = faces.map(function (f) { var b = f.boundingBox; return { x: b.x, y: b.y, width: b.width, height: b.height }; }).filter(function (b) { return b.width > 5 && b.height > 5; });
      blurBoxes(boxes); if (boxes.length && pushUndo !== false) pushAnnUndo();
      setAnnStatus(t('imgSmartBlurReady', { n: boxes.length }), boxes.length ? 'ok' : 'warn'); return boxes.length;
    } catch (_) { if (annSessionMatches(session, canvas)) setAnnStatus(t('imgSmartBlurUnsupported'), 'warn'); return 0; }
    finally { if (annSessionMatches(session, canvas)) setAnnBusy(false); }
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
    var session = annSession, canvas = annCanvas;
    if (!canvas) return 0; setAnnBusy(true); setAnnStatus(t('imgSmartBlurAnalyzing'));
    try {
      var boxes = plateCandidates(canvas); if (!annSessionMatches(session, canvas)) return 0;
      blurBoxes(boxes); if (boxes.length && pushUndo !== false) pushAnnUndo(); setAnnStatus(t('imgSmartBlurReady', { n: boxes.length }), boxes.length ? 'ok' : 'warn'); return boxes.length;
    }
    catch (_) { if (annSessionMatches(session, canvas)) setAnnStatus(t('imgSmartBlurReady', { n: 0 }), 'warn'); return 0; }
    finally { if (annSessionMatches(session, canvas)) setAnnBusy(false); }
  }
  function flattenOcrWordBoxes(data) {
    var out=[];
    if (data && Array.isArray(data.words)) data.words.forEach(function(w){ if(w&&w.bbox&&w.text) out.push(w); });
    if (out.length) return out;
    function walk(node) { if (!node || typeof node!=='object') return; if (node.bbox && node.text && !node.words) out.push(node); ['blocks','paragraphs','lines','words'].forEach(function(k){ if(Array.isArray(node[k])) node[k].forEach(walk); }); }
    walk(data); return out;
  }
  function looksSensitiveText(text) {
    text=String(text||'').trim(); if(!text) return false;
    var digits=text.replace(/\D/g,'');
    return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) || /^\+?[\d().\- ]{8,}$/.test(text) || digits.length>=9 || /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/i.test(text);
  }
  async function detectAndBlurSensitiveText(pushUndo) {
    var session = annSession, canvas = annCanvas, worker = null;
    if (!canvas || ocrRunning || annOcrInFlight) return 0;
    // The OCR worker is shared with the document OCR screen. Mark it globally busy
    // so closing/reopening the editor cannot start a second recognition on it.
    annOcrInFlight = true; ocrRunning = true; ocrAbort = false;
    setAnnBusy(true); setAnnStatus(t('sensitiveScanning'));
    try {
      worker=await getOcrWorker(); if (!annSessionMatches(session, canvas)) return 0;
      var ret=await worker.recognize(canvas); if (!annSessionMatches(session, canvas)) return 0;
      var words=flattenOcrWordBoxes(ret&&ret.data), picked=[];
      var keyword=/^(address|adresse|passport|passeport|driver|permis|license|licence|ssn|sin|nas|iban|account|compte|card|carte|birth|naissance)$/i;
      words.forEach(function(w,i){ var text=String(w.text||'').trim(); if(looksSensitiveText(text)||keyword.test(text)){ for(var k=i;k<Math.min(words.length,i+(keyword.test(text)?4:1));k++){var b=words[k].bbox;if(b)picked.push({x:b.x0,y:b.y0,width:Math.max(1,b.x1-b.x0),height:Math.max(1,b.y1-b.y0)});} } });
      // De-duplicate overlapping OCR boxes before pixelation.
      var boxes=[]; picked.forEach(function(b){ if(!boxes.some(function(x){return rectIou(x,b)>.72;})) boxes.push(b); });
      blurBoxes(boxes); if(boxes.length&&pushUndo!==false)pushAnnUndo(); setAnnStatus(t('sensitiveFound',{n:boxes.length}),boxes.length?'ok':'warn'); return boxes.length;
    } catch (_) { if (annSessionMatches(session, canvas)) setAnnStatus(t('imgSmartBlurUnsupported'),'warn'); return 0; }
    finally {
      await terminateOcrWorker(); annOcrInFlight = false; ocrRunning = false;
      if (annSessionMatches(session, canvas)) setAnnBusy(false);
    }
  }
  function releaseAnnotateCanvas() {
    var canvas = annCanvas || $('annotate-canvas'), stage = $('annotate-canvas-stage');
    // Resetting width/height releases the backing pixel buffer immediately. Keeping a
    // closed 40 MP canvas alive is enough to evict or crash a mobile PWA.
    if (canvas) { canvas.width = 1; canvas.height = 1; canvas.style.width = ''; canvas.style.height = ''; }
    if (stage) { stage.style.width = ''; stage.style.height = ''; }
  }
  function finishAnnotate(result) {
    var resolve = annResolve, source = annSourceFile, previousFocus = annPrevFocus;
    // Invalidate every pending detector/export before releasing the shared canvas.
    annSession += 1; annExporting = false;
    $('annotate-overlay').classList.add('hidden'); setAnnStatus(''); setAnnBusy(false);
    cancelAnimationFrame(annResizeFrame); annResizeFrame = 0; annPanning = null; annPinch = null; annDrawing = false; annStart = null; annLastPoint = null; annGestureChanged = false;
    if ($('annotate-canvas-wrap')) $('annotate-canvas-wrap').classList.remove('is-panning', 'is-pan-mode');
    releaseAnnotateCanvas();
    annResolve = null; annSmartMode = false; annItem = null; annCanvas = null; annCtx = null; annUndoStack = []; annBaseSnapshot = null; annAtBase = true; annSourceFile = null; annPrevFocus = null;
    if ($('ann-cancel')) $('ann-cancel').textContent = t('cancel');
    updateAnnHistoryControls();
    if (previousFocus && previousFocus.focus) try { previousFocus.focus(); } catch (_) {}
    if (resolve) resolve(result || source);
  }
  function closeAnnotate() {
    // Once encoding/persistence has begun, closing would claim the edit was cancelled
    // even though bytes may already be committed. Keep the short operation atomic.
    if (annExporting) return;
    return finishAnnotate(annSourceFile);
  }
  function normalizedEditorExportType(requestedType, encodedType) {
    var actual = String(encodedType || '').toLowerCase().split(';')[0];
    return ['image/jpeg', 'image/png', 'image/webp'].indexOf(actual) !== -1 ? actual : requestedType;
  }
  async function applyAnnotate() {
    if (!annCanvas) return closeAnnotate();
    if (annBusy || annExporting) return;
    var session = annSession, canvas = annCanvas, item = annItem, resolve = annResolve;
    var source = annSourceFile || (item && item.file), sourceType = source && source.type || 'image/jpeg';
    var selectedType = $('ann-output-format') && $('ann-output-format').value || 'keep';
    var outType = selectedType !== 'keep' ? selectedType : (sourceType === 'image/png' ? 'image/png' : sourceType === 'image/webp' ? 'image/webp' : 'image/jpeg');
    var outQuality = Math.max(.55, Math.min(1, (Number($('ann-output-quality') && $('ann-output-quality').value) || 99) / 100));
    annExporting = true; setAnnBusy(true); setAnnStatus('');
    try {
      var exportCanvas = canvas;
      // Preserve transparency for PNG/WebP. JPEG has no alpha channel, so flatten
      // explicitly onto white instead of allowing transparent pixels to become black.
      if (outType === 'image/jpeg') {
        exportCanvas = document.createElement('canvas'); exportCanvas.width = canvas.width; exportCanvas.height = canvas.height;
        var exportCtx = exportCanvas.getContext('2d', { alpha: false }); exportCtx.fillStyle = '#fff'; exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height); exportCtx.drawImage(canvas, 0, 0);
      }
      var blob = await new Promise(function (res, rej) { exportCanvas.toBlob(function (b) { b ? res(b) : rej(new Error('encode')); }, outType, outType === 'image/png' ? undefined : outQuality); });
      if (!annSessionMatches(session, canvas)) return;
      // Browsers may silently fall back to PNG when WebP encoding is unavailable.
      // Use the bytes' real MIME type so the extension and Content-Type never lie.
      outType = normalizedEditorExportType(outType, blob.type);
      var ext = outType === 'image/png' ? '.png' : outType === 'image/webp' ? '.webp' : '.jpg';
      var originalName = source && source.name || (item && item.name) || ('image-' + Date.now());
      var newName = originalName.replace(/\.[^.\/]+$/, '') + ext;
      var file = namedFile(blob, newName, outType, Date.now());
      try { file.dxEditOperations = annOperations.slice(0, 30); } catch (_) {}
      if (resolve && resolve === annResolve) { annExporting = false; return finishAnnotate(file); }
      if (item && item === annItem) {
        await replaceItemSourceDurably(item, file);
        if (!annSessionMatches(session, canvas)) return;
        item.name = newName;
        renderQueue(); updateSendBtn();
      }
    } catch (_) {
      if (annSessionMatches(session, canvas)) { annExporting = false; setAnnBusy(false); toast(t('error'), 'err'); setAnnStatus(t('error'), 'err'); }
      return;
    }
    if (annSessionMatches(session, canvas)) { annExporting = false; finishAnnotate(); }
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

  // --- Generic file picker ---------------------------------------------------
  // Keep camera capture separate from normal file selection. On Chromium-based
  // Android browsers that expose File System Access, showOpenFilePicker() opens
  // the system file chooser and lets the user select actual documents/files.
  // Other browsers fall back to a generic */* input with no capture hint.
  async function openGenericFilePicker(useFileSystemPicker) {
    var input = $('pick-files');
    if (!input) return;
    var canUseFsa = useFileSystemPicker !== false && window.isSecureContext && typeof window.showOpenFilePicker === 'function';
    if (canUseFsa) {
      try {
        var handles = await window.showOpenFilePicker({ multiple: true });
        var files = [];
        for (var i = 0; i < handles.length; i++) {
          try { files.push(await handles[i].getFile()); } catch (_) {}
        }
        if (files.length) await addFiles(files);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        // Some browsers expose the API before their platform implementation is
        // fully usable. Remember the failure for this session and use the plain
        // HTML picker on the next click instead of repeatedly failing.
        try { sessionStorage.setItem('dx-force-html-file-picker', '1'); } catch (_) {}
      }
    }
    input.removeAttribute('capture');
    input.setAttribute('accept', '*/*');
    input.click();
  }
  function shouldUseFileSystemPicker() {
    try { if (sessionStorage.getItem('dx-force-html-file-picker') === '1') return false; } catch (_) {}
    return true;
  }

  // --- Command palette (Ctrl/Cmd+K) ------------------------------------------
  var cmdPrevFocus = null, cmdItems = [], cmdActiveIdx = 0;
  function buildCommands() {
    return [
      { ico: '📤', label: t('send'), run: function () { if (!$('send-btn').disabled) startBatch(); } },
      { ico: '📄', label: t('chooseFiles'), run: function () { openGenericFilePicker(shouldUseFileSystemPicker()); } },
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
    var clearDownloads = window.DirectXferDownloads && typeof window.DirectXferDownloads.clearAll === 'function'
      ? window.DirectXferDownloads.clearAll() : Promise.resolve();
    await Promise.all([idbClear(QUEUE_STORE), idbClear(DEST_STORE), idbClear(META_STORE), idbClear(HISTORY_STORE), idbClear(IMAGE_STORE), idbClear(OCR_INDEX_STORE), purgeDirectXferCaches(), purgeOpfsQueue(), clearDownloads]).catch(function () {});
    persistentDests = []; sessionDests = []; serverReceptions = []; persistSessionDests(); items = []; historyEntries = [];
    sessionFiles = 0; sessionBytes = 0; lifetimeFiles = 0; lifetimeBytes = 0; imageLinkUrls = []; imageRowsByToken.clear(); imageRecordsByToken.clear(); selectedImageTokens.clear(); imageActionHistory = []; tagColorMap = {}; pinnedAlbumTokens.clear(); lastDiag = null; avgRate = 0; historyFilter = '';
    lastBatchRecord = null; lastBatchSummary = null; ocrIndexRecords = []; renderOcrIndex(); privacyNames = false; document.body.classList.remove('privacy-names');
    destStatusCache = Object.create(null); selectedIds.clear();
    queueFilter = ''; queueKindFilter = 'all'; quotaWarned = new Set();
    if ($('history-search')) $('history-search').value = '';
    if ($('queue-search')) $('queue-search').value = '';
    try { ['dx_sender', 'dx-pwa-sender-by-destination', 'dx-pwa-senders', 'dx-pwa-sort', 'dx-pwa-auto-resume', 'dx-pwa-concurrency', 'dx-pwa-avg-rate', 'dx-pwa-vibrate', 'dx-pwa-keepawake', 'dx-pwa-last-dest', 'dx-pwa-confirm-mobile', 'dx-pwa-privacy-names', 'dx-pwa-opt-preset', 'dx-pwa-haptic', 'dx-pwa-advanced-accordion', 'dx-pwa-confirm-revoke', 'dx-pwa-confirm-delete', 'dx-pwa-confirm-replace', 'dx-pwa-storage-warning-threshold', 'dx-pwa-auto-lock-minutes', 'dx-pwa-last-active-at', 'dx-pwa-pagehide-at', 'dx-pwa-tag-colors', 'dx-pwa-pinned-albums', 'dx-pwa-history-backup', 'dx-pwa-image-actions', 'dx-pwa-image-expiry-warned', 'dx-pwa-pending-shared-batch', IMAGE_BACKUP_KEY, DEST_BACKUP_KEY, QUEUE_BACKUP_KEY].forEach(function (k) { localStorage.removeItem(k); }); } catch (_) {}
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
  var logoutInProgress = false;
  var autoLockInProgress = false;
  var lastSessionActivityAt = Date.now();
  var autoLockTimer = null;
  function autoLockMinutes() {
    var value = $('auto-lock-select') ? Number($('auto-lock-select').value) : 15;
    return [0, 5, 15, 30, 60].indexOf(value) !== -1 ? value : 15;
  }
  function rememberSessionActivity() {
    lastSessionActivityAt = Date.now();
    try { localStorage.setItem('dx-pwa-last-active-at', String(lastSessionActivityAt)); } catch (_) {}
  }
  function closedLaunchNeedsLock() {
    var closedAt = 0, navType = '';
    try {
      closedAt = Number(localStorage.getItem('dx-pwa-pagehide-at')) || 0;
      localStorage.removeItem('dx-pwa-pagehide-at');
      var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      navType = nav && nav.type || '';
    } catch (_) {}
    var minutes = autoLockMinutes();
    if (!minutes || navType === 'reload' || closedAt <= 0) return false;
    // Closing/backgrounding the installed PWA must not be treated as an immediate
    // logout. Honour the configured auto-lock delay exactly: a 15-minute setting
    // keeps a quick close/reopen authenticated, and only requires authentication
    // again once the app has actually remained away for at least 15 minutes.
    var elapsed = Date.now() - closedAt;
    return elapsed >= minutes * 60000;
  }
  async function lockSessionAutomatically(reason) {
    if (autoLockInProgress || logoutInProgress) return false;
    autoLockInProgress = true;
    stopSharesPresence(); disconnectLive();
    try {
      if (!deviceInfo || !deviceInfo.csrf) await settleWithin(fetchDeviceStatus(), 2500, null);
      if (!deviceInfo || !deviceInfo.csrf || deviceInfo.unavailable) throw new Error('status');
      var response = await fetchWithTimeout('/app/session/lock', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
        headers: appMutationHeaders('application/json'), body: JSON.stringify({ reason: reason || 'idle' })
      }, 5000);
      if (!response || !response.ok) throw new Error('lock');
      try { localStorage.removeItem('dx-pwa-pagehide-at'); } catch (_) {}
      try { location.replace('/app/login?locked=1&next=' + encodeURIComponent('/app/')); }
      catch (_) { location.href = '/app/login?locked=1&next=' + encodeURIComponent('/app/'); }
      return true;
    } catch (_) {
      autoLockInProgress = false;
      return false;
    }
  }
  function checkSessionAutoLock() {
    var minutes = autoLockMinutes();
    if (!minutes || document.visibilityState === 'hidden' || autoLockInProgress || logoutInProgress) return;
    if (Date.now() - lastSessionActivityAt >= minutes * 60000) lockSessionAutomatically('idle');
  }
  function startSessionAutoLock() {
    try { lastSessionActivityAt = Number(localStorage.getItem('dx-pwa-last-active-at')) || Date.now(); } catch (_) { lastSessionActivityAt = Date.now(); }
    if (autoLockTimer) clearInterval(autoLockTimer);
    autoLockTimer = setInterval(checkSessionAutoLock, 30000);
  }
  async function closeSession() {
    if (logoutInProgress || !confirm(t('closeSessionConfirm'))) return;
    logoutInProgress = true;
    stopSharesPresence(); // never let the presence stream outlive the session
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
      accountNotifications = [];
      renderPwaNotifications();
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

  // Installed-PWA exit guard: require two Back close requests within a short window.
  // CloseWatcher handles Android's Back gesture/button directly, so unlike the old
  // history-based pattern this does not manufacture session-history entries that can
  // accumulate and force extra Back presses. Chrome/Chromium has supported this close
  // request primitive on Android since Chrome 126.
  var PWA_BACK_EXIT_WINDOW_MS = 2000;
  var pwaBackExitWatcher = null;
  var pwaBackExitLastAt = 0;
  var pwaBackExitResetTimer = null;
  var pwaBackExitClosing = false;

  function markPwaBackExitFirstPress() {
    pwaBackExitLastAt = Date.now();
    if (pwaBackExitResetTimer) clearTimeout(pwaBackExitResetTimer);
    pwaBackExitResetTimer = setTimeout(function () { pwaBackExitLastAt = 0; pwaBackExitResetTimer = null; }, PWA_BACK_EXIT_WINDOW_MS);
    toast(t('backExit'), 'warn');
  }

  function armPwaDoubleBackExitWatcher() {
    if (pwaBackExitClosing || pwaBackExitWatcher || !isStandaloneApp() || typeof window.CloseWatcher !== 'function') return false;
    var watcher;
    try { watcher = new window.CloseWatcher(); } catch (_) { return false; }
    pwaBackExitWatcher = watcher;
    watcher.addEventListener('cancel', function (event) {
      var recent = pwaBackExitLastAt > 0 && (Date.now() - pwaBackExitLastAt) <= PWA_BACK_EXIT_WINDOW_MS;
      // A recent first press means this is the confirmation press: do not cancel it.
      if (recent) return;
      // When the platform permits cancellation, consume this Back request as press #1.
      if (event.cancelable) {
        event.preventDefault();
        markPwaBackExitFirstPress();
      }
    });
    watcher.addEventListener('close', function () {
      if (pwaBackExitWatcher === watcher) pwaBackExitWatcher = null;
      var recent = pwaBackExitLastAt > 0 && (Date.now() - pwaBackExitLastAt) <= PWA_BACK_EXIT_WINDOW_MS;
      if (recent) {
        pwaBackExitClosing = true;
        pwaBackExitLastAt = 0;
        if (pwaBackExitResetTimer) { clearTimeout(pwaBackExitResetTimer); pwaBackExitResetTimer = null; }
        try { window.close(); } catch (_) {}
        // If the browser refuses script-close, keep the PWA usable instead of leaving
        // it with no close watcher. A subsequent Back request can start a fresh pair.
        setTimeout(function () {
          if (!window.closed && document.visibilityState !== 'hidden') {
            pwaBackExitClosing = false;
            armPwaDoubleBackExitWatcher();
          }
        }, 250);
        return;
      }
      // Some launches have no cancellable history-action activation yet. In that case
      // the first Back request closes the watcher itself; treat it as press #1 and re-arm.
      markPwaBackExitFirstPress();
      setTimeout(armPwaDoubleBackExitWatcher, 0);
    });
    return true;
  }

  function installPwaDoubleBackExit() {
    // Non-standalone browser tabs keep their normal browser Back semantics.
    if (!isStandaloneApp()) return false;
    return armPwaDoubleBackExitWatcher();
  }
  function rememberInstalledPwa() {
    try { localStorage.setItem('dx-pwa-installed', String(Date.now())); } catch (_) {}
    try {
      document.cookie = 'dx_pwa_installed=' + encodeURIComponent(String(Date.now())) + '; Path=/; Max-Age=15552000; SameSite=Lax' +
        (location.protocol === 'https:' ? '; Secure' : '');
    } catch (_) {}
  }
  if (isStandaloneApp()) rememberInstalledPwa();
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
  function handleNotificationAction(action, data) {
    data = data || {};
    if (action === 'copy-link') {
      var url = data.destinationUrl || launchDestinationUrl || '';
      activatePwaPanel('send', { instant: true });
      if (!url) { toast(t('copyFailed'), 'warn'); return; }
      copyText(url).then(function () { toast(t('notifLinkCopied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); });
      return;
    }
    if (action === 'resend-last') {
      activatePwaPanel('send', { instant: true });
      Promise.resolve(resendLastBatch()).then(function (restored) {
        if (!restored || !restored.length || sending) return;
        // Never let a notification resend unrelated pending files, and never silently
        // redirect the last batch to whichever destination happens to be selected now.
        if (lastBatchRecord && lastBatchRecord.token && (!currentDest || currentDest.token !== lastBatchRecord.token || !currentDestOk)) {
          toast(t('historyDestGone'), 'warn'); return;
        }
        startBatch(restored);
      });
      return;
    }
    if (action === 'open') activatePwaPanel('send', { instant: true });
  }

  function registerServiceWorker() {
    if (!navigator.serviceWorker || typeof navigator.serviceWorker.register !== 'function') return;
    navigator.serviceWorker.addEventListener('controllerchange', refreshToNewVersion);
    var registrationPromise = navigator.serviceWorker.register('/direct-xfer-pwa-sw.js?v=397', { scope: '/app/' }).then(function (reg) {
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
      else if (e.data && e.data.type === 'NOTIFICATION_ACTION') handleNotificationAction(e.data.action || 'open', e.data);
      else if (e.data && e.data.type === 'OPEN_NOTIFICATION_CENTER') openPwaNotificationCenter(e.data.panel || '');
      else if (e.data && e.data.type === 'PUSH_RECEIVED') notePushReceipt(e.data);
      // A Background Sync fired (connectivity returned while the app was
      // backgrounded/closed): resume anything still pending.
      else if (e.data && e.data.type === 'RESUME_TRANSFERS') maybeAutoResume();
    });
    navigator.serviceWorker.ready.then(function () { sendLangToSw(); }).catch(function () {});
    return registrationPromise;
  }

  // Register both one-shot Background Sync and Periodic Sync. The
  // one-shot handles a disconnect/close promptly; Periodic Sync is a recovery path
  // when Android consumed the one-shot while a window was still alive. Unsupported
  // APIs or denied permissions remain harmless no-ops.
  function registerBackgroundSync() {
    try {
      if (!navigator.serviceWorker) return;
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg && reg.sync && typeof reg.sync.register === 'function') reg.sync.register('dx-resume-uploads').catch(function () {});
        if (reg && reg.periodicSync && typeof reg.periodicSync.register === 'function') {
          reg.periodicSync.register('dx-periodic-uploads', { minInterval: 60 * 60 * 1000 }).catch(function () {});
        }
      }).catch(function () {});
    } catch (_) {}
  }
  async function refreshBackgroundSyncDiagnostic() {
    var out=$('background-sync-status'); if(!out)return;
    var parts=[], reg=null, syncTags=[], periodicTags=[];
    try{reg=navigator.serviceWorker?await navigator.serviceWorker.ready:null;}catch(_){}
    var syncSupported=!!(reg&&reg.sync&&typeof reg.sync.register==='function'), periodicSupported=!!(reg&&reg.periodicSync&&typeof reg.periodicSync.register==='function'), permission='unknown';
    try{if(syncSupported&&reg.sync.getTags)syncTags=await reg.sync.getTags();}catch(_){}
    try{if(periodicSupported&&reg.periodicSync.getTags)periodicTags=await reg.periodicSync.getTags();}catch(_){}
    try{if(periodicSupported&&navigator.permissions&&navigator.permissions.query){var ps=await navigator.permissions.query({name:'periodic-background-sync'});permission=ps&&ps.state||'unknown';}}catch(_){}
    var pending=items.filter(function(it){return it&&it.state!=='done'&&it.state!=='removed'&&(it.resumeOnOpen||it.backgroundReady);});
    var lastOk=0,lastFail=0,lastReason='';
    items.concat(restoredBackgroundCompletions||[]).forEach(function(it){lastOk=Math.max(lastOk,Number(it.backgroundCompletedAt)||0);if(Number(it.backgroundFailedAt)>lastFail){lastFail=Number(it.backgroundFailedAt)||0;lastReason=it.errorCode||it.recoveryReason||'';}});
    (Array.isArray(historyEntries)?historyEntries:[]).forEach(function(entry){if(entry&&entry.background)lastOk=Math.max(lastOk,Number(entry.at)||0);});
    parts.push(t('bgSyncSupported')+': '+(syncSupported?'✓':'—')+(periodicSupported?' + périodique':''));
    parts.push(t('bgSyncRegistered')+': '+((syncTags.indexOf('dx-resume-uploads')!==-1||periodicTags.indexOf('dx-periodic-uploads')!==-1)?'✓':'—'));
    if(periodicSupported)parts.push(t('bgSyncPermission')+': '+permission);
    parts.push(t('bgSyncPending')+': '+pending.length);
    parts.push(t('bgSyncLast')+': '+(lastOk?fmtDate(lastOk):t('bgSyncNever')));
    if(lastFail)parts.push(t('bgSyncFailure')+': '+fmtDate(lastFail)+(lastReason?' · '+lastReason:''));
    out.textContent=parts.join(' · ');
  }
  async function refreshPwaInstallDiagnostic() {
    var out=$('pwa-install-diagnostic');if(!out)return;var installed=isStandaloneApp(),detected=false,server=false;
    if(!installed&&navigator.getInstalledRelatedApps){try{var apps=await navigator.getInstalledRelatedApps();detected=Array.isArray(apps)&&apps.some(function(a){return a&&a.platform==='webapp';});}catch(_){}}
    try{var r=await fetch('/pwa/install-state',{credentials:'same-origin',cache:'no-store'});if(r.ok){var d=await r.json();server=!!d.installed;}}catch(_){}
    var stateText=installed?t('installDiagInstalled'):(detected||server)?t('installDiagDetected'):(window.isSecureContext?t('installDiagBrowser'):t('installDiagUnknown'));
    out.textContent=stateText+' · '+t('installDiagSecure')+': '+(window.isSecureContext?'✓':'✕')+' · '+t('installDiagSw')+': '+(navigator.serviceWorker&&navigator.serviceWorker.controller?'✓':'—');
  }
  // Give the SW the current language so its closed-app "resume pending" prompt is localized.
  function sendLangToSw() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SET_LANG', lang: lang });
      }
    } catch (_) {}
  }

  // Per-file percentage helper.
  function pctText(sent, total) { total = Number(total) || 0; return (total > 0 ? Math.min(100, Math.round((Number(sent) || 0) / total * 100)) : 0) + '%'; }

  // Theme selection is handled by the explicit dropdown at the top of Settings.
  function setTheme(v) {
    if (v !== 'light' && v !== 'auto' && v !== 'schedule') v = 'dark';
    var actual = v === 'schedule' ? ((new Date().getHours() >= 20 || new Date().getHours() < 7) ? 'dark' : 'light') : v;
    document.documentElement.setAttribute('data-theme', actual);
    document.documentElement.setAttribute('data-theme-mode', v);
    try { localStorage.setItem('dx-theme', v); } catch (_) {}
    if ($('theme-select')) $('theme-select').value = v;
  }

  // Copy just the raw token, not the whole URL.
  // Pin / unpin a destination as a favourite.
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

  // Reset the batch-scoped options (note, expiry, image/optimization) in one tap.
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

  // Always-visible batch counter: file count, total payload and bytes already sent.
  function updateFilesCount() {
    var el = $('files-count'); if (!el) return;
    var live = items.filter(function (it) { return it.state !== 'removed'; });
    var total = live.reduce(function (s, it) { return s + (it.upSize || it.size || 0); }, 0);
    var sent = live.reduce(function (s, it) { var n = it.upSize || it.size || 0; return s + Math.min(n, it.sentBytes || (it.state === 'done' ? n : 0)); }, 0);
    el.textContent = live.length ? t('filesTotalSummary', { n: live.length, total: fmtBytes(total), sent: fmtBytes(sent) }) : '';
    el.classList.toggle('hidden', live.length === 0);
  }

  // Master "select all / none" for the queue.
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

  function clipboardExt(type) {
    var map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
    return map[String(type || '').toLowerCase()] || 'bin';
  }
  function clipboardFileName(type, index) {
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/T/, '-').replace(/\..*$/, '');
    return 'clipboard-' + stamp + (index > 0 ? '-' + (index + 1) : '') + '.' + clipboardExt(type);
  }
  async function queueRemoteUrl(rawUrl, silent) {
    var u;
    try { u = new URL(String(rawUrl || '').trim()); } catch (_) { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (!silent) toast(t('urlFetching'));
    try {
      var r = await fetch(u.href, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      var blob = await r.blob();
      var base = decodeURIComponent((u.pathname.split('/').pop() || '').split('?')[0]) || ('fichier-' + Date.now());
      if (!/\.[^.\/]+$/.test(base)) { var ext = (String(blob.type).split('/')[1] || '').split(';')[0]; if (ext) base += '.' + ext; }
      var file = namedFile(blob, safeName(base), blob.type || 'application/octet-stream', Date.now());
      await addFiles([file]);
      if (!silent) toast(t('urlAdded'), 'ok');
      return true;
    } catch (_) {
      if (!silent) toast(t('urlFailed'), 'err');
      return false;
    }
  }

  // Empty the clipboard into the queue. Modern ClipboardItem data can contain an
  // image/file; text is converted to a .txt file, while a lone HTTP(S) URL is first
  // fetched as the actual remote file (with a text fallback when CORS blocks it).
  async function emptyClipboardIntoQueue() {
    if (!navigator.clipboard) { toast(t('pasteFailed'), 'warn'); return; }
    var added = 0, text = '';
    try {
      if (typeof navigator.clipboard.read === 'function') {
        var entries = await navigator.clipboard.read();
        var files = [];
        for (var i = 0; i < entries.length; i++) {
          var ci = entries[i], imageType = (ci.types || []).find(function (ty) { return /^image\//.test(ty); });
          if (imageType) {
            var blob = await ci.getType(imageType);
            files.push(namedFile(blob, clipboardFileName(imageType, files.length), imageType, Date.now()));
          }
          if (!text && (ci.types || []).indexOf('text/plain') !== -1) {
            try { text = await (await ci.getType('text/plain')).text(); } catch (_) {}
          }
        }
        if (files.length) { await addFiles(files); added += files.length; }
      }
      if (!text && typeof navigator.clipboard.readText === 'function') text = await navigator.clipboard.readText();
    } catch (_) {
      try { if (typeof navigator.clipboard.readText === 'function') text = await navigator.clipboard.readText(); }
      catch (__) { toast(t('pasteFailed'), 'warn'); return; }
    }
    text = String(text || '').trim();
    if (text) {
      var isUrl = /^https?:\/\/\S+$/i.test(text);
      if (isUrl && await queueRemoteUrl(text, true)) added++;
      else {
        var name = isUrl ? 'clipboard-url.txt' : t('pastedTextName');
        var file = namedFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), name, 'text/plain', Date.now());
        await addFiles([file]); added++;
        if (isUrl) toast(t('clipboardUrlFallback'), 'warn');
      }
    }
    if (!added) toast(t('clipboardEmpty'), 'warn');
  }

  // Legacy helper retained for keyboard/tests and older UI references.
  async function pasteTextFile() {
    var text = '';
    try { text = await navigator.clipboard.readText(); } catch (_) { toast(t('pasteFailed'), 'warn'); return; }
    if (!text || !text.trim()) { toast(t('pasteTextEmpty'), 'warn'); return; }
    var file = namedFile(new Blob([text], { type: 'text/plain;charset=utf-8' }), t('pastedTextName'), 'text/plain', Date.now());
    addFiles([file]);
  }

  // Fetch a remote image/file by URL and queue it, CORS permitting.
  async function addFromUrl() {
    var url = window.prompt(t('urlPrompt'), '');
    if (url == null) return;
    url = String(url).trim(); if (!url) return;
    var u;
    try { u = new URL(url); } catch (_) { toast(t('urlInvalid'), 'warn'); return; }
    if (!/^https?:$/.test(u.protocol)) { toast(t('urlInvalid'), 'warn'); return; }
    await queueRemoteUrl(u.href, false);
  }

  function copyQueueNames() {
    var live = items.filter(function (it) { return it.state !== 'removed'; }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    if (!live.length) { toast(t('noPending'), 'warn'); return; }
    var names = live.map(function (it, i) { return privacyNames ? privateFileName(i) : it.name; });
    copyText(names.join('\n')).then(function () { toast(t('queueNamesCopied', { n: names.length }), 'ok'); }, function () { toast(t('copyFailed'), 'err'); });
  }

  // Bulk rename selected files with a shared prefix + auto numbering.
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

  // Metadata privacy center (#14). JPEG/PNG/WebP metadata chunks are stripped
  // without re-encoding pixels; PDFs use pdf-lib and OOXML containers use JSZip.
  // The selected document bytes never leave the browser; only pinned JS libraries are fetched.
  var privacyCurrentItem=null, privacyCurrentFindings=[], privacyBusy=false, pinnedLibraryPromises=Object.create(null);
  function canPrivacyInspectItem(it) {
    if (!it || !it.file) return false;
    var type=String(it.type||it.file.type||'').toLowerCase(), ext=extOf(it.name||it.file.name||'');
    return /^image\//.test(type) || type==='application/pdf' || ext==='pdf' || /^(docx|xlsx|pptx)$/.test(ext);
  }
  function privacyCanClean(it) {
    if (!it || !it.file) return false;
    var type=String(it.type||it.file.type||'').toLowerCase(), ext=extOf(it.name||it.file.name||'');
    return /^(image\/(jpeg|png|webp))$/.test(type) || /^(jpe?g|png|webp)$/.test(ext) || type==='application/pdf' || ext==='pdf' || /^(docx|xlsx|pptx)$/.test(ext);
  }
  function loadPinnedGlobal(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (pinnedLibraryPromises[globalName]) return pinnedLibraryPromises[globalName];
    pinnedLibraryPromises[globalName]=new Promise(function(resolve,reject){
      var tag=document.createElement('script');tag.src=src;tag.async=true;tag.crossOrigin='anonymous';
      tag.onload=function(){window[globalName]?resolve(window[globalName]):reject(new Error(globalName+' unavailable'));};
      tag.onerror=function(){reject(new Error(t('ocrEngineNetwork')));};document.head.appendChild(tag);
    }).catch(function(err){delete pinnedLibraryPromises[globalName];throw err;});
    return pinnedLibraryPromises[globalName];
  }
  async function blobPrivacySample(file) {
    var max=2*1024*1024, head=await file.slice(0,Math.min(file.size,max)).arrayBuffer(), text='';
    try{text=new TextDecoder('latin1').decode(head);}catch(_){text=String.fromCharCode.apply(null,new Uint8Array(head).subarray(0,65535));}
    if(file.size>max){var tail=await file.slice(Math.max(0,file.size-max)).arrayBuffer();try{text+='\n'+new TextDecoder('latin1').decode(tail);}catch(_){}}
    return text;
  }
  function finding(key,label,detail){return{key:key,label:label,detail:detail||''};}
  async function analyzePrivacyFile(file,name,type) {
    var ext=extOf(name||file.name||''), findings=[];
    if(/^image\//.test(type||file.type||'')||/^(jpe?g|png|webp|bmp|avif|gif)$/.test(ext)){
      var sample=await blobPrivacySample(file);
      if(/Exif\x00\x00|xmpmeta|photoshop:|iptc|XML:com\.adobe\.xmp/i.test(sample))findings.push(finding('image',t('privacyImageMetadata')));
      if(/GPSLatitude|GPSLongitude|GPSInfo|GPSVersionID|gps:/i.test(sample))findings.push(finding('gps',t('privacyGps')));
      if(/Artist\x00|Copyright\x00|CameraOwnerName|OwnerName/i.test(sample))findings.push(finding('author',t('privacyAuthor')));
    } else if((type||file.type)==='application/pdf'||ext==='pdf'){
      var pdfSample=await blobPrivacySample(file), meta=[];
      if(/\/Author\s*[<(]/i.test(pdfSample))meta.push(t('privacyAuthor'));
      if(/\/(Creator|Producer|Title|Subject|Keywords|CreationDate|ModDate)\s*[<(]/i.test(pdfSample)||/<x:xmpmeta|\/Metadata\b/i.test(pdfSample))meta.push(t('privacyPdfMetadata'));
      if(meta.length)findings.push(finding('pdf',t('privacyPdfMetadata'),Array.from(new Set(meta)).join(' · ')));
    } else if(/^(docx|xlsx|pptx)$/.test(ext)){
      var JSZip=await loadPinnedGlobal(PRIVACY_JSZIP_URL,'JSZip'), zip=await JSZip.loadAsync(file);
      var core=zip.file('docProps/core.xml'), app=zip.file('docProps/app.xml'), custom=zip.file('docProps/custom.xml');
      if(core){var x=await core.async('text');if(/<dc:creator[^>]*>\s*[^<]/i.test(x)||/<cp:lastModifiedBy[^>]*>\s*[^<]/i.test(x))findings.push(finding('author',t('privacyAuthor')));if(/<dcterms:(created|modified)|<cp:revision/i.test(x))findings.push(finding('office',t('privacyOfficeMetadata')));}
      if(app){var ax=await app.async('text');if(/<(Company|Manager)>\s*[^<]/i.test(ax))findings.push(finding('office-app',t('privacyOfficeMetadata')));}
      if(custom)findings.push(finding('custom',t('privacyCustom')));
      if(Object.keys(zip.files).some(function(k){return /^docProps\/thumbnail\./i.test(k);}))findings.push(finding('thumb',t('privacyThumbnail')));
    }
    var seen=Object.create(null);return findings.filter(function(f){if(seen[f.key])return false;seen[f.key]=1;return true;});
  }
  function renderPrivacyFindings() {
    var box=$('privacy-findings'); if(!box)return; box.innerHTML='';
    if(!privacyCurrentFindings.length){var p=document.createElement('p');p.className='muted sm';p.textContent=t('privacyNoFindings');box.appendChild(p);return;}
    privacyCurrentFindings.forEach(function(f){var row=document.createElement('div');row.className='privacy-finding';var ico=document.createElement('span');ico.className='privacy-icon';ico.textContent='🛡';var body=document.createElement('div');var strong=document.createElement('strong');strong.textContent=f.label;body.appendChild(strong);if(f.detail){var d=document.createElement('span');d.className='muted sm';d.textContent=f.detail;body.appendChild(d);}row.appendChild(ico);row.appendChild(body);box.appendChild(row);});
  }
  function setPrivacyBusy(busy,status){privacyBusy=!!busy;if($('privacy-analyze'))$('privacy-analyze').disabled=busy;if($('privacy-clean'))$('privacy-clean').disabled=busy||!privacyCanClean(privacyCurrentItem);if(status&&$('privacy-status'))$('privacy-status').textContent=status;}
  async function analyzePrivacyCurrent(){if(!privacyCurrentItem||privacyBusy)return;setPrivacyBusy(true,t('privacyAnalyzing'));try{privacyCurrentFindings=await analyzePrivacyFile(privacyCurrentItem.file,privacyCurrentItem.name,privacyCurrentItem.type);renderPrivacyFindings();$('privacy-status').textContent=privacyCurrentFindings.length?t('privacyFindings',{n:privacyCurrentFindings.length}):t('privacyNoFindings');}catch(e){privacyCurrentFindings=[];renderPrivacyFindings();$('privacy-status').textContent=t('privacyUnsupported');}finally{setPrivacyBusy(false);}}
  function xmlBlankTag(xml,tag){var esc=tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return xml.replace(new RegExp('<'+esc+'([^>]*)>[\\s\\S]*?<\\/'+esc+'>','gi'),'<'+tag+'$1></'+tag+'>');}
  function xmlRemoveRelationship(xml,needle){return xml.replace(new RegExp('<Relationship\\b[^>]*Type="[^"]*'+needle+'[^"]*"[^>]*/>','gi'),'');}
  function concatUint8(parts,total) { var out=new Uint8Array(total),pos=0;parts.forEach(function(part){out.set(part,pos);pos+=part.length;});return out; }
  function stripJpegMetadataBytes(bytes) {
    if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)throw new Error('jpeg');
    var parts=[bytes.slice(0,2)],total=2,pos=2;
    while(pos+1<bytes.length){
      if(bytes[pos]!==0xff){parts.push(bytes.slice(pos));total+=bytes.length-pos;break;}
      var marker=bytes[pos+1];
      if(marker===0xda){parts.push(bytes.slice(pos));total+=bytes.length-pos;break;}
      if(marker===0xd9||marker===0x01||(marker>=0xd0&&marker<=0xd7)){var bare=bytes.slice(pos,pos+2);parts.push(bare);total+=bare.length;pos+=2;continue;}
      if(pos+3>=bytes.length)throw new Error('jpeg');var segLen=(bytes[pos+2]<<8)|bytes[pos+3],end=pos+2+segLen;if(segLen<2||end>bytes.length)throw new Error('jpeg');
      // APP1 = EXIF/XMP, APP13 = IPTC/Photoshop, COM = comments. Preserve APP2
      // because it commonly contains the ICC colour profile rather than identity data.
      if(marker!==0xe1&&marker!==0xed&&marker!==0xfe){var seg=bytes.slice(pos,end);parts.push(seg);total+=seg.length;}
      pos=end;
    }
    return concatUint8(parts,total);
  }
  function stripPngMetadataBytes(bytes) {
    var sig=[137,80,78,71,13,10,26,10];for(var si=0;si<8;si++)if(bytes[si]!==sig[si])throw new Error('png');
    var parts=[bytes.slice(0,8)],total=8,pos=8,remove={eXIf:1,tEXt:1,zTXt:1,iTXt:1,tIME:1};
    while(pos+12<=bytes.length){var len=((bytes[pos]<<24)|(bytes[pos+1]<<16)|(bytes[pos+2]<<8)|bytes[pos+3])>>>0,end=pos+12+len;if(end>bytes.length)throw new Error('png');var type=String.fromCharCode(bytes[pos+4],bytes[pos+5],bytes[pos+6],bytes[pos+7]);if(!remove[type]){var chunk=bytes.slice(pos,end);parts.push(chunk);total+=chunk.length;}pos=end;if(type==='IEND')break;}
    return concatUint8(parts,total);
  }
  function stripWebpMetadataBytes(bytes) {
    function text4(at){return String.fromCharCode(bytes[at],bytes[at+1],bytes[at+2],bytes[at+3]);}
    if(bytes.length<12||text4(0)!=='RIFF'||text4(8)!=='WEBP')throw new Error('webp');
    var chunks=[],total=12,pos=12;
    while(pos+8<=bytes.length){var type=text4(pos),len=(bytes[pos+4]|(bytes[pos+5]<<8)|(bytes[pos+6]<<16)|(bytes[pos+7]<<24))>>>0,end=pos+8+len+(len&1);if(end>bytes.length)throw new Error('webp');if(type!=='EXIF'&&type!=='XMP '){var chunk=bytes.slice(pos,end);if(type==='VP8X'&&len>=1){chunk=chunk.slice();chunk[8]&=~0x0c;}chunks.push(chunk);total+=chunk.length;}pos=end;}
    var out=new Uint8Array(total);out.set(bytes.slice(0,12),0);var riffSize=total-8;out[4]=riffSize&255;out[5]=(riffSize>>>8)&255;out[6]=(riffSize>>>16)&255;out[7]=(riffSize>>>24)&255;var at=12;chunks.forEach(function(c){out.set(c,at);at+=c.length;});return out;
  }
  async function cleanImagePrivacy(file) {
    var bytes=new Uint8Array(await file.arrayBuffer()),type=String(file.type||'').toLowerCase(),ext=extOf(file.name||'');var cleaned;
    if(type==='image/jpeg'||/jpe?g/.test(ext))cleaned=stripJpegMetadataBytes(bytes);
    else if(type==='image/png'||ext==='png')cleaned=stripPngMetadataBytes(bytes);
    else if(type==='image/webp'||ext==='webp')cleaned=stripWebpMetadataBytes(bytes);
    else throw new Error('unsupported');
    return namedFile(new Blob([cleaned],{type:type||file.type||'application/octet-stream'}),file.name,type||file.type||'application/octet-stream',Date.now());
  }
  async function cleanPdfPrivacy(file) {
    var PDFLib=await loadPinnedGlobal(PRIVACY_PDFLIB_URL,'PDFLib'), doc=await PDFLib.PDFDocument.load(await file.arrayBuffer(),{updateMetadata:false});
    try{doc.setTitle('');doc.setAuthor('');doc.setSubject('');doc.setKeywords([]);doc.setCreator('');doc.setProducer('');doc.setCreationDate(new Date(0));doc.setModificationDate(new Date(0));}catch(_){}
    try{if(PDFLib.PDFName&&doc.catalog)doc.catalog.delete(PDFLib.PDFName.of('Metadata'));}catch(_){}
    var bytes=await doc.save({useObjectStreams:true,addDefaultPage:false,objectsPerTick:50});return namedFile(new Blob([bytes],{type:'application/pdf'}),file.name,'application/pdf',Date.now());
  }
  async function cleanOfficePrivacy(file) {
    var JSZip=await loadPinnedGlobal(PRIVACY_JSZIP_URL,'JSZip'), zip=await JSZip.loadAsync(file), core=zip.file('docProps/core.xml'), app=zip.file('docProps/app.xml');
    if(core){var x=await core.async('text');['dc:creator','cp:lastModifiedBy','cp:revision','dcterms:created','dcterms:modified'].forEach(function(tag){x=xmlBlankTag(x,tag);});zip.file('docProps/core.xml',x);}
    if(app){var ax=await app.async('text');['Company','Manager'].forEach(function(tag){ax=xmlBlankTag(ax,tag);});zip.file('docProps/app.xml',ax);}
    zip.remove('docProps/custom.xml');Object.keys(zip.files).filter(function(k){return /^docProps\/thumbnail\./i.test(k);}).forEach(function(k){zip.remove(k);});
    var rel=zip.file('_rels/.rels');if(rel){var rx=await rel.async('text');rx=xmlRemoveRelationship(rx,'custom-properties');rx=xmlRemoveRelationship(rx,'thumbnail');zip.file('_rels/.rels',rx);}
    var ct=zip.file('[Content_Types].xml');if(ct){var cx=await ct.async('text');cx=cx.replace(/<Override\b[^>]*PartName="\/docProps\/custom\.xml"[^>]*\/>/gi,'');zip.file('[Content_Types].xml',cx);}
    var blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});return namedFile(blob,file.name,file.type||'application/vnd.openxmlformats-officedocument',Date.now());
  }
  async function cleanPrivacyCurrent(){if(!privacyCurrentItem||privacyBusy||!privacyCanClean(privacyCurrentItem))return;setPrivacyBusy(true,t('privacyCleaning'));try{var file=privacyCurrentItem.file,type=String(privacyCurrentItem.type||file.type||'').toLowerCase(),ext=extOf(privacyCurrentItem.name||file.name||''),cleaned;if(/^(image\/(jpeg|png|webp))$/.test(type)||/^(jpe?g|png|webp)$/.test(ext))cleaned=await cleanImagePrivacy(file);else if(type==='application/pdf'||ext==='pdf')cleaned=await cleanPdfPrivacy(file);else if(/^(docx|xlsx|pptx)$/.test(ext))cleaned=await cleanOfficePrivacy(file);else throw new Error('unsupported');await replaceItemSourceDurably(privacyCurrentItem,cleaned);privacyCurrentFindings=[];renderPrivacyFindings();$('privacy-status').textContent=t('privacyCleaned');renderQueue();updateSendBtn();toast(t('privacyCleaned'),'ok');}catch(e){$('privacy-status').textContent=t('privacyUnsupported');toast(t('privacyUnsupported'),'warn');}finally{setPrivacyBusy(false);}}
  function openPrivacyInspector(it){if(!canPrivacyInspectItem(it))return;privacyCurrentItem=it;privacyCurrentFindings=[];renderPrivacyFindings();$('privacy-source').textContent=(it.name||it.file.name||'')+' · '+fmtBytes(it.file.size||0);$('privacy-status').textContent=t('privacyAnalyzing');$('privacy-overlay').classList.remove('hidden');setPrivacyBusy(false);setTimeout(analyzePrivacyCurrent,0);}
  function closePrivacyInspector(){if(privacyBusy)return;$('privacy-overlay').classList.add('hidden');privacyCurrentItem=null;privacyCurrentFindings=[];}

  // Local OCR for images and PDFs (#25). The file never leaves this browser. The
  // pinned OCR/PDF engines are fetched only as code/model dependencies on first use.
  var ocrCurrentItem = null, ocrWorker = null, ocrPdfLib = null, ocrRunning = false, ocrAbort = false;
  var ocrText = '', ocrSearchPos = -1, ocrPrevFocus = null, ocrScriptPromise = null, ocrIndexedRecord = null, ocrIndexRecords = [];
  function canOcrItem(it) {
    if (!it || !it.file) return false;
    var type = String(it.type || it.file.type || '').toLowerCase(), ext = extOf(it.name || it.file.name || '');
    return /^image\//.test(type) || type === 'application/pdf' || ext === 'pdf';
  }
  function ocrTimeoutError() { return new Error(t('ocrEngineTimeout')); }
  function loadExternalScript(src) {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (ocrScriptPromise) return ocrScriptPromise;
    ocrScriptPromise = new Promise(function (resolve, reject) {
      var settled = false, timer = 0;
      var tag = document.createElement('script'); tag.src = src; tag.async = true; tag.crossOrigin = 'anonymous';
      function finish(err, value) {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer);
        tag.onload = null; tag.onerror = null;
        if (err) reject(err); else resolve(value);
      }
      tag.onload = function () { window.Tesseract ? finish(null, window.Tesseract) : finish(new Error('Tesseract unavailable')); };
      tag.onerror = function () { finish(new Error(t('ocrEngineNetwork'))); };
      timer = setTimeout(function () { finish(ocrTimeoutError()); }, OCR_ENGINE_SCRIPT_TIMEOUT_MS);
      document.head.appendChild(tag);
    }).catch(function (err) { ocrScriptPromise = null; throw err; });
    return ocrScriptPromise;
  }
  function withOcrTimeout(promise, ms) {
    var timer = 0;
    return Promise.race([
      Promise.resolve(promise),
      new Promise(function (_, reject) { timer = setTimeout(function () { reject(ocrTimeoutError()); }, ms); })
    ]).finally(function () { if (timer) clearTimeout(timer); });
  }
  async function ensureOcrPdfLib() {
    if (ocrPdfLib) return ocrPdfLib;
    try {
      ocrPdfLib = await import(OCR_PDFJS_URL);
      if (ocrPdfLib && ocrPdfLib.GlobalWorkerOptions) ocrPdfLib.GlobalWorkerOptions.workerSrc = OCR_PDF_WORKER_URL;
      return ocrPdfLib;
    } catch (_) { throw new Error(t('ocrEngineNetwork')); }
  }
  function ocrSetStatus(text, progress) {
    var status = $('ocr-status'), bar = $('ocr-progress');
    if (status) status.textContent = text || '';
    if (bar && typeof progress === 'number' && isFinite(progress)) bar.value = Math.max(0, Math.min(1, progress));
  }
  function ocrLogger(m) {
    if (!m || ocrAbort) return;
    var p = typeof m.progress === 'number' ? m.progress : 0;
    var status = String(m.status || '');
    // During recognition the caller owns the translated page label and overall PDF
    // progress. Do not replace it with Tesseract's English internal status string.
    if (/recogniz/i.test(status)) return;
    if (/language|traineddata/i.test(status)) ocrSetStatus(t('ocrLoadingEngine'), Math.min(.45, p * .45));
    else ocrSetStatus(t('ocrLoadingEngine'), Math.min(.25, p * .25));
  }
  async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    ocrSetStatus(t('ocrLoadingEngine'), .03);
    var T = await loadExternalScript(OCR_TESSERACT_URL);
    if (ocrAbort) throw new Error('OCR_CANCELLED');
    var raw = ($('ocr-language') && $('ocr-language').value) || (lang === 'en' ? 'eng' : lang === 'es' ? 'spa' : 'fra+eng');
    try { localStorage.setItem('dx-pwa-ocr-lang', raw); } catch (_) {}
    var languages = raw.split('+').filter(Boolean);
    var oem = T.OEM && T.OEM.LSTM_ONLY != null ? T.OEM.LSTM_ONLY : 1;
    var initError = null;
    var createPromise = T.createWorker(languages, oem, {
      logger: ocrLogger,
      workerPath: OCR_TESSERACT_WORKER_URL,
      corePath: OCR_TESSERACT_CORE_URL,
      errorHandler: function (err) { initError = err instanceof Error ? err : new Error(String(err || 'Tesseract worker error')); }
    });
    try {
      ocrWorker = await withOcrTimeout(createPromise, OCR_ENGINE_INIT_TIMEOUT_MS);
      if (initError) throw initError;
      if (ocrAbort) throw new Error('OCR_CANCELLED');
      return ocrWorker;
    } catch (err) {
      ocrWorker = null;
      // A failed worker bootstrap can leave Tesseract's internal worker alive. If
      // it eventually resolves after our timeout, terminate it rather than leaking
      // memory or letting a stale worker serve the next OCR request.
      Promise.resolve(createPromise).then(function (lateWorker) {
        if (lateWorker && lateWorker.terminate) return lateWorker.terminate();
      }).catch(function () {});
      throw initError || err;
    }
  }
  async function terminateOcrWorker() {
    var worker = ocrWorker; ocrWorker = null;
    if (worker && worker.terminate) { try { await worker.terminate(); } catch (_) {} }
  }
  function normalizePdfText(items) {
    var out = [], lastY = null;
    (items || []).forEach(function (item) {
      var str = String(item && item.str || ''); if (!str) return;
      var y = item && item.transform ? Math.round(item.transform[5] || 0) : null;
      if (lastY != null && y != null && Math.abs(y - lastY) > 4) out.push('\n');
      else if (out.length && out[out.length - 1] !== '\n') out.push(' ');
      out.push(str); lastY = y;
    });
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  async function renderPdfPageForOcr(page) {
    var base = page.getViewport({ scale: 1 });
    var scale = Math.min(2.2, 2200 / Math.max(base.width || 1, base.height || 1));
    scale = Math.max(1.35, scale);
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
    var ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    return canvas;
  }
  function setOcrResult(text) {
    ocrText = String(text || '').trim(); ocrSearchPos = -1;
    var result = $('ocr-result'); if (result) result.value = ocrText;
    var has = !!ocrText;
    if ($('ocr-copy')) $('ocr-copy').disabled = !has;
    if ($('ocr-add-txt')) $('ocr-add-txt').disabled = !has;
    updateOcrSearch(true);
  }
  async function recognizeOcrImage(file) {
    var worker = await getOcrWorker();
    if (ocrAbort) throw new Error('OCR_CANCELLED');
    ocrSetStatus(t('ocrScanningPage', { page: 1, total: 1 }), .45);
    var ret = await worker.recognize(file);
    return ret && ret.data ? String(ret.data.text || '') : '';
  }
  async function recognizeOcrPdf(file) {
    ocrSetStatus(t('ocrLoadingPdf'), .02);
    var pdfjs = await ensureOcrPdfLib();
    if (ocrAbort) throw new Error('OCR_CANCELLED');
    var bytes = new Uint8Array(await file.arrayBuffer());
    var loading = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
    var pdf = await loading.promise, total = pdf.numPages || 0, pages = [];
    try {
      for (var n = 1; n <= total; n++) {
        if (ocrAbort) throw new Error('OCR_CANCELLED');
        ocrSetStatus(t('ocrReadingPage', { page: n, total: total }), (n - 1) / Math.max(1, total));
        var page = await pdf.getPage(n), embedded = '';
        try { embedded = normalizePdfText((await page.getTextContent()).items); } catch (_) {}
        if (embedded.replace(/\s/g, '').length >= 20) {
          pages.push('--- Page ' + n + ' ---\n' + embedded);
          ocrSetStatus(t('ocrEmbedded') + ' · ' + n + '/' + total, n / Math.max(1, total));
        } else {
          var canvas = await renderPdfPageForOcr(page);
          try {
            var worker = await getOcrWorker();
            if (ocrAbort) throw new Error('OCR_CANCELLED');
            ocrSetStatus(t('ocrScanningPage', { page: n, total: total }), (n - .6) / Math.max(1, total));
            var ret = await worker.recognize(canvas);
            var text = ret && ret.data ? String(ret.data.text || '').trim() : '';
            pages.push('--- Page ' + n + ' ---\n' + text);
          } finally { canvas.width = 1; canvas.height = 1; }
        }
        if (page.cleanup) try { page.cleanup(); } catch (_) {}
      }
    } finally { if (pdf && pdf.destroy) try { await pdf.destroy(); } catch (_) {} }
    return pages.join('\n\n');
  }
  async function openImageRecordOcr(photo) {
    if (!photo || !photo.token || photo.active === false) { toast(t('imgInactive'), 'warn'); return; }
    try {
      ocrSetStatus(t('ocrLoadingEngine'), 0);
      var r = await fetch('/app/image/' + encodeURIComponent(photo.token) + '/preview/full', { credentials:'same-origin', cache:'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var blob = await r.blob();
      var type = blob.type || 'image/' + (extOf(photo.name || '') || 'jpeg');
      var name = photo.name || ('image-' + photo.token);
      var file;
      if (typeof File === 'function') file = new File([blob], name, { type:type, lastModified:Number(photo.createdAt) || Date.now() });
      else {
        file = blob;
        try { Object.defineProperty(file, 'name', { value:name, configurable:true }); } catch (_) { file.name = name; }
        try { Object.defineProperty(file, 'lastModified', { value:Number(photo.createdAt) || Date.now(), configurable:true }); } catch (_) {}
      }
      openOcr({ file:file, name:name, type:type, imageToken:photo.token, ocrSourceKind:'image-library', contentHash:photo.clientHash || '' });
    } catch (err) { toast(t('ocrFailed', { error:String(err && err.message || err || '').slice(0, 120) }), 'err'); }
  }
  async function runOcr() {
    if (ocrRunning || !ocrCurrentItem || !canOcrItem(ocrCurrentItem)) return;
    var ocrOp=beginLongOperation(t('longOpOcr'),ocrCurrentItem.name||'');
    ocrAbort = false; ocrRunning = true; setOcrResult('');
    if ($('ocr-run')) $('ocr-run').disabled = true;
    if ($('ocr-cancel-run')) $('ocr-cancel-run').disabled = false;
    try {
      var file = ocrCurrentItem.file, type = String(ocrCurrentItem.type || file.type || '').toLowerCase(), ext = extOf(ocrCurrentItem.name || file.name || '');
      var text = (type === 'application/pdf' || ext === 'pdf') ? await recognizeOcrPdf(file) : await recognizeOcrImage(file);
      if (ocrAbort) throw new Error('OCR_CANCELLED');
      setOcrResult(text);
      if (ocrText) await saveOcrIndexRecord(ocrCurrentItem, ocrText).catch(function () {});
      ocrSetStatus(ocrText ? t('ocrComplete', { chars: ocrText.length }) : t('ocrNoText'), 1);
    } catch (err) {
      if (ocrAbort || (err && err.message === 'OCR_CANCELLED')) ocrSetStatus(t('ocrCanceled'), 0);
      else { var msg = String(err && err.message || err || ''); ocrSetStatus(t('ocrFailed', { error: msg.slice(0, 180) }), 0); }
    } finally {
      endLongOperation(ocrOp);
      await terminateOcrWorker();
      ocrRunning = false;
      if ($('ocr-run')) $('ocr-run').disabled = false;
      if ($('ocr-cancel-run')) $('ocr-cancel-run').disabled = true;
    }
  }
  function cancelOcr() { ocrAbort = true; terminateOcrWorker(); ocrSetStatus(t('ocrCanceled'), 0); }
  function openOcr(it) {
    if (!canOcrItem(it)) { toast(t('ocrUnsupported'), 'warn'); return; }
    ocrCurrentItem = it; ocrIndexedRecord = null; ocrPrevFocus = document.activeElement; ocrAbort = false; setOcrResult('');
    var idx = Math.max(0, sortedItems().indexOf(it));
    var sourceName = it.imageToken ? String(it.name || it.file.name || 'image') : displayFileName(it, idx);
    $('ocr-source').textContent = sourceName + ' · ' + fmtBytes(it.file.size || 0);
    var saved = ''; try { saved = localStorage.getItem('dx-pwa-ocr-lang') || ''; } catch (_) {}
    if ($('ocr-language')) $('ocr-language').value = saved || (lang === 'en' ? 'eng' : lang === 'es' ? 'spa' : 'fra+eng');
    ocrSetStatus(t('ocrReady'), 0);
    $('ocr-overlay').classList.remove('hidden'); $('ocr-run').focus();
    // Clicking OCR is explicit consent to start local processing; launch immediately.
    setTimeout(runOcr, 0);
  }
  async function closeOcr() {
    ocrAbort = true; await terminateOcrWorker(); ocrRunning = false;
    if ($('ocr-overlay')) $('ocr-overlay').classList.add('hidden');
    ocrCurrentItem = null; ocrIndexedRecord = null; setOcrResult('');
    if ($('ocr-run')) $('ocr-run').disabled = false;
    if (ocrPrevFocus && ocrPrevFocus.focus) try { ocrPrevFocus.focus(); } catch (_) {}
    ocrPrevFocus = null;
  }
  function updateOcrSearch(reset, focusResult) {
    var q = String($('ocr-search') && $('ocr-search').value || '');
    var label = $('ocr-match-count'), area = $('ocr-result');
    if (!q || !ocrText) { if (label) label.textContent = ''; ocrSearchPos = -1; return; }
    var hay = ocrText.toLocaleLowerCase(), needle = q.toLocaleLowerCase(), starts = [], pos = 0;
    while (needle && (pos = hay.indexOf(needle, pos)) !== -1 && starts.length < 5000) { starts.push(pos); pos += Math.max(1, needle.length); }
    if (!starts.length) { if (label) label.textContent = t('ocrNoMatch'); ocrSearchPos = -1; return; }
    if (reset || ocrSearchPos < 0 || starts.indexOf(ocrSearchPos) === -1) ocrSearchPos = starts[0];
    var current = Math.max(0, starts.indexOf(ocrSearchPos));
    if (label) label.textContent = t('ocrMatches', { current: current + 1, total: starts.length });
    if (area && area.setSelectionRange) { area.setSelectionRange(ocrSearchPos, ocrSearchPos + q.length); if (focusResult) area.focus(); }
  }
  function stepOcrSearch(dir) {
    var q = String($('ocr-search') && $('ocr-search').value || ''); if (!q || !ocrText) return;
    var hay = ocrText.toLocaleLowerCase(), needle = q.toLocaleLowerCase(), starts = [], pos = 0;
    while ((pos = hay.indexOf(needle, pos)) !== -1 && starts.length < 5000) { starts.push(pos); pos += Math.max(1, needle.length); }
    if (!starts.length) { updateOcrSearch(true); return; }
    var idx = starts.indexOf(ocrSearchPos); if (idx < 0) idx = 0;
    idx = (idx + dir + starts.length) % starts.length; ocrSearchPos = starts[idx]; updateOcrSearch(false, true);
  }
  function copyOcrText() {
    if (!ocrText) return;
    copyText(ocrText).then(function () { toast(t('ocrCopied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); });
  }
  async function addOcrTextToQueue() {
    if (!ocrText || (!ocrCurrentItem && !ocrIndexedRecord)) return;
    var original = String(ocrCurrentItem ? (ocrCurrentItem.name || ocrCurrentItem.file.name || 'document') : (ocrIndexedRecord.name || 'document'));
    var base = original.replace(/\.[^.]+$/, '') || 'document';
    var file = namedFile(new Blob([ocrText + '\n'], { type: 'text/plain;charset=utf-8' }), safeName(base + '-ocr.txt'), 'text/plain', Date.now());
    await addFiles([file]); toast(t('ocrQueued'), 'ok');
  }

  // Persistent local OCR index (#16). Records live only in this browser's
  // IndexedDB and contain the recognized text + enough source metadata to find it.
  // Search is deliberately performed locally; no query or OCR text is sent out.
  function ocrIndexStableId(it) {
    var f = it && it.file, seed = it && it.imageToken ? ('image:' + it.imageToken) : (String(it && it.contentHash || '') || [it && it.name || f && f.name || '', f && f.size || 0, f && f.lastModified || 0].join('|'));
    var h1 = 2166136261 >>> 0, h2 = 0x9e3779b9 >>> 0;
    for (var i = 0; i < seed.length; i++) { h1 ^= seed.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0; h2 ^= (seed.charCodeAt(i) + i); h2 = Math.imul(h2, 2246822519) >>> 0; }
    return 'ocr-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }
  async function saveOcrIndexRecord(it, text) {
    text = String(text || '').trim(); if (!it || !it.file || !text) return;
    var f = it.file, rec = {
      id: ocrIndexStableId(it), name: String(it.name || f.name || 'document'), type: String(it.type || f.type || ''),
      size: Number(f.size) || 0, lastModified: Number(f.lastModified) || 0, language: String($('ocr-language') && $('ocr-language').value || ''),
      text: text, chars: text.length, indexedAt: Date.now(), sourceHash: String(it.contentHash || ''),
      sourceKind: String(it.ocrSourceKind || (it.imageToken ? 'image-library' : 'queue')), imageToken: String(it.imageToken || '')
    };
    await idbPut(OCR_INDEX_STORE, rec);
    var replaced = false;
    ocrIndexRecords = ocrIndexRecords.map(function (row) { if (row.id === rec.id) { replaced = true; return rec; } return row; });
    if (!replaced) ocrIndexRecords.push(rec);
    ocrIndexRecords.sort(function (a, b) { return (b.indexedAt || 0) - (a.indexedAt || 0); });
    renderOcrIndex();
    if (!replaced) toast(t('ocrIndexSaved'), 'ok');
  }
  async function loadOcrIndex() {
    ocrIndexRecords = await idbGetAll(OCR_INDEX_STORE).catch(function () { return []; });
    if (!Array.isArray(ocrIndexRecords)) ocrIndexRecords = [];
    ocrIndexRecords = ocrIndexRecords.filter(function (r) { return r && r.id && typeof r.text === 'string'; }).sort(function (a,b){return (b.indexedAt||0)-(a.indexedAt||0);});
    renderOcrIndex();
    if (imageRecordsByToken && imageRecordsByToken.size) applyImageView();
    return ocrIndexRecords;
  }
  function ocrIndexSnippet(text, query) {
    text = String(text || '').replace(/\s+/g, ' ').trim(); if (!text) return '';
    if (!query) return text.slice(0, 220) + (text.length > 220 ? '…' : '');
    var low = text.toLocaleLowerCase(), q = query.toLocaleLowerCase(), at = low.indexOf(q);
    if (at < 0) return text.slice(0, 220) + (text.length > 220 ? '…' : '');
    var start = Math.max(0, at - 85), end = Math.min(text.length, at + q.length + 115);
    return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }
  function renderOcrIndex() {
    var root = $('ocr-index-results'), badge = $('ocr-index-count'); if (!root) return;
    var q = String($('ocr-index-search') && $('ocr-index-search').value || '').trim().toLocaleLowerCase();
    var rows = ocrIndexRecords.filter(function (r) { return !q || String(r.name || '').toLocaleLowerCase().includes(q) || String(r.text || '').toLocaleLowerCase().includes(q); });
    if (badge) badge.textContent = String(ocrIndexRecords.length); root.innerHTML = '';
    if (!rows.length) { var empty=document.createElement('p'); empty.className='muted sm'; empty.textContent=t('ocrIndexEmpty'); root.appendChild(empty); return; }
    rows.slice(0, 250).forEach(function (rec) {
      var row=document.createElement('article'); row.className='ocr-index-row';
      var main=document.createElement('div'); main.className='ocr-index-main';
      var title=document.createElement('strong'); title.textContent=rec.name||'document'; main.appendChild(title);
      var meta=document.createElement('span'); meta.className='muted sm'; meta.textContent=t('ocrIndexMeta',{size:fmtBytes(rec.size||0),date:new Date(rec.indexedAt||Date.now()).toLocaleString(),chars:String(rec.chars||String(rec.text||'').length)}); main.appendChild(meta);
      var snip=document.createElement('p'); snip.className='ocr-index-snippet'; snip.textContent=ocrIndexSnippet(rec.text,q); main.appendChild(snip);
      var actions=document.createElement('div'); actions.className='ocr-index-actions';
      var open=document.createElement('button'); open.type='button'; open.className='btn ghost sm'; open.textContent=t('ocrIndexOpen'); open.addEventListener('click',function(){openIndexedOcr(rec);}); actions.appendChild(open);
      var del=document.createElement('button'); del.type='button'; del.className='btn ghost sm danger'; del.textContent='×'; del.title=t('ocrIndexDelete'); del.setAttribute('aria-label',t('ocrIndexDelete')); del.addEventListener('click',async function(){await idbDelete(OCR_INDEX_STORE,rec.id).catch(function(){});ocrIndexRecords=ocrIndexRecords.filter(function(r){return r.id!==rec.id;});renderOcrIndex();}); actions.appendChild(del);
      row.appendChild(main); row.appendChild(actions); root.appendChild(row);
    });
  }
  function openIndexedOcr(rec) {
    if (!rec) return; ocrCurrentItem=null; ocrIndexedRecord=rec; ocrPrevFocus=document.activeElement; ocrAbort=false;
    $('ocr-source').textContent=String(rec.name||'document')+' · '+fmtBytes(rec.size||0); setOcrResult(rec.text||'');
    ocrSetStatus(t('ocrComplete',{chars:String(rec.text||'').length}),1);
    if ($('ocr-language') && rec.language) $('ocr-language').value=rec.language;
    if ($('ocr-run')) $('ocr-run').disabled=true; if ($('ocr-cancel-run')) $('ocr-cancel-run').disabled=true;
    $('ocr-overlay').classList.remove('hidden'); if ($('ocr-search')) $('ocr-search').focus();
  }
  async function clearOcrIndex() {
    if (!ocrIndexRecords.length) return;
    if (!window.confirm(t('ocrIndexClearConfirm'))) return;
    await idbClear(OCR_INDEX_STORE).catch(function () {}); ocrIndexRecords=[]; renderOcrIndex();
  }

  // Local preview for images, video, audio, PDF and text/code before sending.
  // Audio/video positions are persisted by file identity so reopening the PWA or
  // closing the preview resumes near the last position instead of starting over.
  var lightboxUrl = '', lightboxPrevFocus = null, previewResumeMedia = null, previewResumeKey = '';
  var PWA_MEDIA_RESUME_MAX_AGE = 90 * 24 * 60 * 60 * 1000;
  function pwaPreviewResumeKey(it) {
    var f = it && it.file;
    return 'dx-pwa-media-v1:' + [String(it && it.contentHash || ''), String(it && it.name || f && f.name || ''), Number(f && f.size || 0), Number(f && f.lastModified || 0)].join(':');
  }
  function savePwaPreviewResume(force) {
    var m = previewResumeMedia, key = previewResumeKey; if (!m || !key) return;
    var now = Date.now(), t0 = Number(m.currentTime) || 0, d = Number(m.duration) || 0;
    if (t0 < 1 || (d && d - t0 < 5)) { try { localStorage.removeItem(key); } catch (_) {} return; }
    if (!force && m.__dxSavedAt && now - m.__dxSavedAt < 2500) return;
    m.__dxSavedAt = now;
    try { localStorage.setItem(key, JSON.stringify({time:t0,at:now})); } catch (_) {}
  }
  function bindPwaPreviewResume(media, it) {
    previewResumeMedia = media; previewResumeKey = pwaPreviewResumeKey(it);
    media.onloadedmetadata = function () {
      try {
        var v=JSON.parse(localStorage.getItem(previewResumeKey)||'null'), d=Number(media.duration)||0;
        if(v&&(!Number(v.at)||Date.now()-Number(v.at)>PWA_MEDIA_RESUME_MAX_AGE)){localStorage.removeItem(previewResumeKey);return;}
        if(v&&Number(v.time)>=5&&(!d||Number(v.time)<d-8)) media.currentTime=Number(v.time);
        else if(v&&d&&Number(v.time)>=d-8) localStorage.removeItem(previewResumeKey);
      } catch (_) { try { localStorage.removeItem(previewResumeKey); } catch (__) {} }
    };
    media.ontimeupdate = function () { savePwaPreviewResume(false); };
    media.onpause = function () { savePwaPreviewResume(true); };
    media.onended = function () { try { localStorage.removeItem(previewResumeKey); } catch (_) {} };
  }
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
      if (/^text\//.test(type) || /^(txt|md|markdown|csv|tsv|log|json|xml|yml|yaml|ini|conf|cfg|toml|html|htm|css|scss|less|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|c|h|cpp|hpp|java|go|rs|rb|php|sql|lua|pl|kt|swift|r|dart|env|properties)$/.test(ext)) {
        var txt = await file.slice(0, 1024 * 1024).text();
        $('preview-text').textContent = txt + (file.size > 1024 * 1024 ? '\n\n…' : '');
        $('preview-text').classList.remove('hidden');
      } else {
        lightboxUrl = URL.createObjectURL(file);
        if (/^image\//.test(type)) { $('lightbox-img').src = lightboxUrl; $('lightbox-img').classList.remove('hidden'); }
        else if (/^video\//.test(type)) { $('preview-video').src = lightboxUrl; $('preview-video').classList.remove('hidden'); bindPwaPreviewResume($('preview-video'), it); }
        else if (/^audio\//.test(type)) { $('preview-audio').src = lightboxUrl; $('preview-audio').classList.remove('hidden'); bindPwaPreviewResume($('preview-audio'), it); }
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
  // Side-by-side comparison of the three variants (Full / Mini / Micro) for one image:
  // preview + dimensions + byte size in one glance, inside a dismissible overlay.
  var comparePrevFocus = null;
  function openVariantCompare(photo) {
    var grid = $('compare-grid'); if (!photo || !grid) return;
    grid.innerHTML = '';
    ['full', 'thumb', 'micro'].forEach(function (kind) {
      var variant = (photo.variants || {})[kind] || {};
      var url = imagePreviewUrl(photo, kind);
      var col = document.createElement('div'); col.className = 'compare-col';
      var name = document.createElement('div'); name.className = 'compare-name'; name.textContent = imageVariantLabel(kind); col.appendChild(name);
      var wrap = document.createElement('div'); wrap.className = 'compare-imgwrap';
      if (url) { var im = document.createElement('img'); im.className = 'compare-img'; im.alt = imageVariantLabel(kind); im.loading = 'lazy'; im.src = url; wrap.appendChild(im); }
      col.appendChild(wrap);
      var meta = document.createElement('div'); meta.className = 'compare-meta muted sm';
      meta.textContent = (variant.w && variant.h ? variant.w + '×' + variant.h : '—') + ' · ' + fmtBytes(variant.bytes);
      col.appendChild(meta);
      grid.appendChild(col);
    });
    $('compare-title').textContent = t('imgCompareTitle') + (photo.name ? ' — ' + photo.name : '');
    comparePrevFocus = document.activeElement;
    $('compare-overlay').classList.remove('hidden');
    $('compare-close').focus();
  }
  function closeCompare() {
    $('compare-overlay').classList.add('hidden');
    var grid = $('compare-grid'); if (grid) grid.innerHTML = '';
    if (comparePrevFocus && comparePrevFocus.focus) { try { comparePrevFocus.focus(); } catch (_) {} }
    comparePrevFocus = null;
  }
  function closeLightbox(restoreFocus) {
    savePwaPreviewResume(true); previewResumeMedia = null; previewResumeKey = '';
    $('lightbox-overlay').classList.add('hidden'); resetPreviewElements();
    if (lightboxUrl) { URL.revokeObjectURL(lightboxUrl); lightboxUrl = ''; }
    if (restoreFocus !== false && lightboxPrevFocus && lightboxPrevFocus.focus) lightboxPrevFocus.focus();
    lightboxPrevFocus = null;
  }

  // SHA-256 fingerprint of a file, copied to the clipboard.
  async function copyFileHash(it) {
    var src = it.file || it.preparedBlob;
    if (!src || !(window.crypto && crypto.subtle)) { toast(t('hashFail'), 'err'); return; }
    toast(t('hashing'));
    try {
      var hex = await sha256Blob(src, function (fraction) { if (it.meta) it.meta.textContent = t('hashing') + ' ' + Math.round(fraction * 100) + '%'; });
      if (!hex) throw new Error('hash');
      // Copy in `sha256sum` format ("<hash>  <name>") so it drops straight into a checksum file.
      await copyText(hex + '  ' + it.name);
      toast(t('hashCopied'), 'ok');
      if (it.meta) it.meta.textContent = 'SHA-256 ' + hex.slice(0, 16) + '…';
    } catch (_) { toast(t('hashFail'), 'err'); }
  }

  // Export / import the local app settings as JSON.
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

  // Custom accent colour via a CSS variable.
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

  // Capture a screen frame via getDisplayMedia and queue it as a PNG.
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

  // Undo the last single file removed from the queue.
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

  // Live character counter for a length-limited input.
  function updateCharCount(input, counter, max) {
    if (!input || !counter) return;
    var n = (input.value || '').length;
    counter.textContent = n + '/' + max;
    counter.classList.toggle('near', n >= max * 0.9);
  }

  // Invert the current multi-selection.
  function invertSelection() {
    sortedItems().forEach(function (it) { if (selectedIds.has(it.id)) selectedIds.delete(it.id); else selectedIds.add(it.id); });
    renderQueue();
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
  // Estimated size of each image AFTER optimization, plus a batch-wide preview
  // (before → after, savings and approximate upload time at the learned rate).
  var estimating = false;
  function updateOptimizationEstimate() {
    var el = $('optimization-estimate'); if (!el) return;
    if (!$('optimize-images') || !$('optimize-images').checked) { el.classList.add('hidden'); el.textContent = ''; return; }
    var pending = items.filter(function (it) { return ['waiting', 'error', 'paused', 'waiting-network'].indexOf(it.state) !== -1; });
    var optimizable = pending.filter(function (it) { return it.file && /^image\//.test(it.type) && !/svg|gif/i.test(it.type); });
    if (!optimizable.length) { el.classList.add('hidden'); el.textContent = ''; return; }
    var before = pending.reduce(function (sum, it) { return sum + (it.size || 0); }, 0);
    var after = pending.reduce(function (sum, it) {
      var eligible = it.file && /^image\//.test(it.type) && !/svg|gif/i.test(it.type);
      return sum + (eligible && it.estSize > 0 ? it.estSize : (it.size || 0));
    }, 0);
    var saved = Math.max(0, before - after);
    var pct = before > 0 ? Math.round(saved / before * 100) : 0;
    var eta = avgRate > 0 && after > 0 ? '· ⏳ ' + fmtEta(after / avgRate) : '';
    var unknown = optimizable.filter(function (it) { return it.estSize == null; }).length;
    var text = t('optimizationEstimate', { before: fmtBytes(before), after: fmtBytes(after), saved: fmtBytes(saved), pct: pct, eta: eta });
    if (unknown && estimating) text = t('optimizationEstimating') + ' · ' + text;
    el.textContent = text; el.classList.remove('hidden');
  }
  async function estimateOptimizedSizes() {
    if (estimating || !$('optimize-images') || !$('optimize-images').checked) { updateOptimizationEstimate(); return; }
    estimating = true; updateOptimizationEstimate();
    try {
      var targets = items.filter(function (it) { return it.file && /^image\//.test(it.type) && !/svg|gif/i.test(it.type) && ['waiting', 'error', 'paused', 'waiting-network'].indexOf(it.state) !== -1 && it.estSize == null; });
      for (var i = 0; i < targets.length; i++) { await estimateOne(targets[i]); updateOptimizationEstimate(); }
    } finally { estimating = false; updateOptimizationEstimate(); }
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
    if (it.meta && ['waiting', 'error', 'paused', 'waiting-network'].indexOf(it.state) !== -1) it.meta.textContent = rowMetaText(it);
  }
  function clearEstimates() { items.forEach(function (it) { it.estSize = null; }); updateOptimizationEstimate(); }

  // Rotate a queued image 90° clockwise before sending.
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

  // Sender-name address book: remember names used and offer them as autocomplete.
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

  // One QR encoding every image link of the session.
  function qrAllImageLinks() {
    if (!imageLinkUrls.length) { toast(t('noImgLinks'), 'warn'); return; }
    var text = imageLinkUrls.map(function (o) { return o.url; }).join('\n');
    if (text.length > 1024) { toast(t('imgQrTooBig'), 'warn'); return; } // server caps QR data at 1024 chars
    showQrOverlay(text, t('imgQrAll').replace(/^▦\s*/, ''));
  }

  // Share the selected files through the OS share sheet.
  async function shareSelection() {
    var files = selectedItems().map(function (it) { return it.file; }).filter(Boolean);
    if (!files.length) return;
    if (!navigator.canShare || !navigator.canShare({ files: files })) { toast(t('copyFailed'), 'warn'); return; }
    try { await navigator.share({ files: files }); } catch (_) {}
  }

  // Per-destination presets: remember expiry + note for each link.
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

  // Touch/pen drag handle for mobile. HTML5 `draggable` is still unreliable in
  // installed Android PWAs, so Pointer Events drive the same persistent reorder path.
  function attachTouchReorderHandle(handle, row, it, list) {
    if (!handle || !window.PointerEvent) return;
    var active = false, targetId = '';
    function clearTargets() {
      Array.prototype.forEach.call(list.querySelectorAll('.uprow.drag-over'), function (el) { el.classList.remove('drag-over'); });
    }
    handle.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' || e.button !== 0) return;
      active = true; targetId = ''; dragId = it.id; row.classList.add('dragging', 'touch-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!active) return;
      e.preventDefault();
      var hit = document.elementFromPoint(e.clientX, e.clientY);
      var target = hit && hit.closest ? hit.closest('.uprow') : null;
      clearTargets();
      if (target && target.dataset && target.dataset.id && target.dataset.id !== it.id) { targetId = target.dataset.id; target.classList.add('drag-over'); }
    });
    function finish() {
      if (!active) return;
      active = false; row.classList.remove('dragging', 'touch-dragging'); clearTargets(); dragId = null;
      if (targetId) reorderQueue(it.id, targetId);
      targetId = '';
    }
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  // Drag-to-reorder the queue in "order added" mode. We rewrite each
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
    $('lang-select').addEventListener('change', function () { applyLanguage(this.value); updateNetworkIndicator(); renderQueue(); renderHistory(); renderErrorCenter(); renderNetworkDashboard(); renderOcrIndex(); renderPwaNotifications(); });
    var netConn = connectionInfo(); if (netConn && netConn.addEventListener) netConn.addEventListener('change', function () { updateNetworkIndicator(); renderNetworkDashboard(); });
    var savedTheme = 'dark'; try { savedTheme = localStorage.getItem('dx-theme') || document.documentElement.getAttribute('data-theme-mode') || 'dark'; } catch (_) {}
    $('theme-select').value = savedTheme;
    $('theme-select').addEventListener('change', function () { setTheme(this.value); });
    setInterval(function () { if (($('theme-select') && $('theme-select').value) === 'schedule') setTheme('schedule'); }, 60000);
    function onPwaNotificationFilterChanged(){ notificationsShown=NOTIFICATIONS_PAGE_SIZE; renderPwaNotifications(); if(pwaNotificationsOpen())void markPwaNotificationsRead(); }
    ['pwa-notifications-category-filter','pwa-notifications-severity-filter'].forEach(function(id){var node=$(id);if(node)node.addEventListener('change',onPwaNotificationFilterChanged);});
    if ($('pwa-notifications-search')) $('pwa-notifications-search').addEventListener('input',onPwaNotificationFilterChanged);
    if ($('pwa-notifications-btn')) $('pwa-notifications-btn').addEventListener('click', function (e) {
      e.stopPropagation(); var d=$('pwa-notifications-dropdown'); if(!d)return; var opening=d.classList.contains('hidden'); d.classList.toggle('hidden'); this.setAttribute('aria-expanded',opening?'true':'false'); if(opening){notificationsShown=NOTIFICATIONS_PAGE_SIZE;renderPwaNotifications();void markPwaNotificationsRead();refreshPwaNotifications();}
    });
    if ($('pwa-notifications-clear')) $('pwa-notifications-clear').addEventListener('click', async function(e){e.stopPropagation();if(!accountNotifications.length||!confirm(t('notificationsClearConfirm')))return;var r=await appMutate('/app/notifications/clear','application/json','{}');if(r.ok){notificationRequestSeq+=1;accountNotifications=[];renderPwaNotifications();if(!notificationRequestInFlight)await refreshPwaNotifications();}});
    if ($('pwa-notifications-sound')) { updatePwaNotificationsSoundBtn(); $('pwa-notifications-sound').addEventListener('click', function(e){ e.stopPropagation(); notificationSoundOn=!notificationSoundOn; try{localStorage.setItem('dx-notif-sound',notificationSoundOn?'1':'0');}catch(_){} updatePwaNotificationsSoundBtn(); if(notificationSoundOn)playPwaNotificationSound(); }); }
    if ($('pwa-notifications-prefs-btn')) { var pb=$('pwa-notifications-prefs-btn'); pb.title=t('notificationsPrefs'); pb.setAttribute('aria-label',t('notificationsPrefs')); pb.addEventListener('click', function(e){ e.stopPropagation(); var box=$('pwa-notifications-prefs'); if(!box)return; var opening=box.classList.contains('hidden'); box.classList.toggle('hidden'); pb.setAttribute('aria-expanded',opening?'true':'false'); if(opening&&!notificationPrefsLoaded)loadPwaNotificationPrefs(); }); }
    document.addEventListener('click', function(e){if(e.target.closest&&e.target.closest('#pwa-notifications-menu'))return;closePwaNotifications();});
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
      var dest = { token: parsed.token, name: String($('dest-name').value || '').trim(), emoji: String(($('dest-emoji') && $('dest-emoji').value) || '').trim().slice(0, 8), key: parsed.key || '', rememberKey: rememberKey, sourceOrigin: parsed.sourceOrigin, remembered: remember, owned: !!(existing && existing.owned), pinned: !!(existing && existing.pinned), order: existing ? existing.order : undefined, createdAt: (existing && existing.createdAt) || Date.now() };
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
    if ($('pick-files-btn')) $('pick-files-btn').addEventListener('click', function () { openGenericFilePicker(shouldUseFileSystemPicker()); });
    ['pick-camera', 'pick-files', 'pick-folder'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    });
    if ($('pick-imglink')) $('pick-imglink').addEventListener('change', function (e) { createImageLinks(e.target.files); e.target.value = ''; });
    if ($('pick-imglink-edit')) $('pick-imglink-edit').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []); e.target.value = '';
      editImageBeforeLink(files);
    });
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
    if ($('background-sync-refresh')) $('background-sync-refresh').addEventListener('click', refreshBackgroundSyncDiagnostic);
    if ($('background-sync-run')) $('background-sync-run').addEventListener('click', function(){registerBackgroundSync();maybeAutoResume();setTimeout(refreshBackgroundSyncDiagnostic,300);});
    if ($('pwa-install-refresh')) $('pwa-install-refresh').addEventListener('click', refreshPwaInstallDiagnostic);
    refreshBackgroundSyncDiagnostic(); refreshPwaInstallDiagnostic();
    if ($('add-passkey-btn')) $('add-passkey-btn').addEventListener('click', addPasskey);
    if ($('disable-biometric-btn')) $('disable-biometric-btn').addEventListener('click', disableBiometricIdentification);
    if ($('reauth-biometric-btn')) $('reauth-biometric-btn').addEventListener('click', reauthenticateForBiometric);
    $('dest-scan-btn').addEventListener('click', startScan); $('qr-close').addEventListener('click', stopScan);
    $('update-btn').addEventListener('click', function () { applyUpdate(waitingWorker); });
    $('auto-resume').addEventListener('change', function () {
      var enabled = !!this.checked;
      try { localStorage.setItem('dx-pwa-auto-resume', enabled ? '1' : '0'); } catch (_) {}
      items.forEach(function (it) {
        if (!it || !it.snapshot || !it.preparedBlob || ['done', 'removed', 'paused'].indexOf(it.state) !== -1) return;
        it.backgroundReady = enabled && preparedPayloadIsDurable(it);
        persistItem(it, false).catch(function () {});
      });
      if (enabled) registerBackgroundSync();
    });
    $('concurrency-select').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-concurrency', this.value); } catch (_) {} });
    if ($('sort-select')) $('sort-select').addEventListener('change', function () { sortMode = this.value; try { localStorage.setItem('dx-pwa-sort', this.value); } catch (_) {} renderQueue(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-queue-kind]'), function (btn) {
      btn.addEventListener('click', function () { queueKindFilter = this.dataset.queueKind || 'all'; try { localStorage.setItem('dx-pwa-queue-kind', queueKindFilter); } catch (_) {} renderQueue(); });
    });
    if ($('copy-queue-names-btn')) $('copy-queue-names-btn').addEventListener('click', copyQueueNames);
    if ($('queue-search')) $('queue-search').addEventListener('input', function () { queueFilter = this.value || ''; renderQueue(); });
    // ✕ clear buttons for the search fields (image library + upload queue). The button
    // shows only when the field holds text; clicking it empties the field, re-runs the
    // matching filter and returns focus so typing can continue immediately.
    function wireClearButton(inputId, clearId, onClear) {
      var input = $(inputId), btn = $(clearId); if (!input || !btn) return;
      var sync = function () { btn.classList.toggle('hidden', !input.value); };
      input.addEventListener('input', sync);
      btn.addEventListener('click', function (e) { e.preventDefault(); input.value = ''; sync(); if (onClear) onClear(); input.focus(); });
      sync();
    }
    wireClearButton('img-search', 'img-search-clear', applyImageView);
    wireClearButton('queue-search', 'queue-search-clear', function () { queueFilter = ''; renderQueue(); });
    // Live password-strength meter for link passwords (image link + server-file share).
    // Coarse 0–4 score → weak / fair / strong; hidden while the field is empty.
    function passwordScore(v) {
      v = String(v || ''); if (!v) return 0;
      var s = 0;
      if (v.length >= 8) s++;
      if (v.length >= 12) s++;
      if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
      if (/\d/.test(v)) s++;
      if (/[^A-Za-z0-9]/.test(v)) s++;
      return Math.min(4, s);
    }
    function attachPwStrength(inputId, meterId) {
      var input = $(inputId), meter = $(meterId); if (!input || !meter) return;
      var bar = meter.querySelector('.pw-bar > i'), label = meter.querySelector('.pw-label');
      var update = function () {
        if (!input.value) { meter.className = 'pw-strength hidden'; return; }
        var s = passwordScore(input.value), tier = s <= 1 ? 0 : (s <= 3 ? 1 : 2);
        meter.className = 'pw-strength ' + ['pw-weak', 'pw-medium', 'pw-strong'][tier];
        if (bar) bar.style.width = [22, 40, 60, 82, 100][s] + '%';
        if (label) label.textContent = [t('pwWeak'), t('pwMedium'), t('pwStrong')][tier];
      };
      input.addEventListener('input', update);
      update();
    }
    attachPwStrength('img-password', 'img-password-strength');
    attachPwStrength('share-password', 'share-password-strength');
    if ($('bulk-invert-btn')) $('bulk-invert-btn').addEventListener('click', invertSelection);
    if ($('bulk-share-btn')) $('bulk-share-btn').addEventListener('click', shareSelection);
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
    if ($('help-close')) $('help-close').addEventListener('click', closeHelp);
    if ($('server-activity-refresh')) $('server-activity-refresh').addEventListener('click', function () { loadPwaServerActivity(true).catch(function () {}); });
    if ($('server-activity-search')) $('server-activity-search').addEventListener('input', renderPwaServerActivity);
    if ($('server-activity-kind')) $('server-activity-kind').addEventListener('change', renderPwaServerActivity);
    ['server-activity-share','server-activity-device','server-activity-result','server-activity-period','server-activity-direction','server-activity-correlate','server-activity-images','server-activity-pwa','server-activity-hide-routine'].forEach(function(id){if($(id))$(id).addEventListener('change',function(){if(id==='server-activity-hide-routine')try{localStorage.setItem('dxpwa-activity-hide-routine',this.checked?'1':'0');}catch(_){}renderPwaServerActivity();});});
    ['server-activity-actor','server-activity-ip'].forEach(function(id){if($(id))$(id).addEventListener('input',renderPwaServerActivity);});
    if($('server-activity-hide-routine'))try{$('server-activity-hide-routine').checked=localStorage.getItem('dxpwa-activity-hide-routine')==='1';}catch(_){}
    if ($('server-activity-reset')) $('server-activity-reset').addEventListener('click', function () { if ($('server-activity-search')) $('server-activity-search').value = ''; if ($('server-activity-kind')) $('server-activity-kind').value = ''; if($('server-activity-share'))$('server-activity-share').value=''; ['server-activity-actor','server-activity-ip'].forEach(function(x){if($(x))$(x).value='';}); ['server-activity-device','server-activity-result','server-activity-period','server-activity-direction'].forEach(function(x){if($(x))$(x).value='';}); if($('server-activity-correlate'))$('server-activity-correlate').checked=true; if($('server-activity-images'))$('server-activity-images').checked=false;if($('server-activity-pwa'))$('server-activity-pwa').checked=false;if($('server-activity-hide-routine'))$('server-activity-hide-routine').checked=false;try{localStorage.removeItem('dxpwa-activity-hide-routine');}catch(_){}renderPwaServerActivity(); });
    if ($('history-search')) $('history-search').addEventListener('input', function () { historyFilter = this.value || ''; renderHistory(); });
    if ($('check-update-btn')) $('check-update-btn').addEventListener('click', checkForUpdate);
    if ($('copy-diag-btn')) $('copy-diag-btn').addEventListener('click', copyDiagnostic);
    if ($('network-test-btn')) $('network-test-btn').addEventListener('click', function () { runNetworkTest({ silent: false }); });
    if ($('network-dashboard')) $('network-dashboard').addEventListener('toggle', function () { if (this.open) renderNetworkDashboard(); });
    if ($('error-center-copy')) $('error-center-copy').addEventListener('click', copyErrorReport);
    if ($('error-center-clear')) $('error-center-clear').addEventListener('click', clearErrorLog);
    if ($('error-center-retry-all')) $('error-center-retry-all').addEventListener('click', retryAll);
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
    ['img-sort', 'img-filter'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', function () { persistImagePreferences(); applyImageView(); }); });
    if ($('img-search')) $('img-search').addEventListener('input', function () { scheduleImageOcrSearch(this.value); applyImageView(); });
    ['img-expiry', 'img-max-views', 'img-hotlink-hosts', 'img-smart-blur', 'img-tags', 'img-note', 'img-rename-template'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', persistImagePreferences); });
    ['img-compact', 'img-hide-expired', 'img-auto-copy', 'img-notify-first-view'].forEach(function (id) { if ($(id)) $(id).addEventListener('change', function () {
      persistImagePreferences();
      if (id === 'img-compact') $('imglink-list').classList.toggle('img-compact', this.checked);
      if (id === 'img-notify-first-view' && this.checked && $('live-push') && !$('live-push').checked) {
        var pushToggle = $('live-push');
        pushToggle.checked = true;
        enablePush(false).then(function (ok) {
          if (ok) {
            try { localStorage.setItem('dx-pwa-push', '1'); } catch (_) {}
            toast(t('livePushOn'), 'ok');
          } else {
            pushToggle.checked = false;
            try { localStorage.setItem('dx-pwa-push', '0'); } catch (_) {}
            toast(t('livePushFail'), 'warn');
          }
        });
      }
      applyImageView();
    }); });
    if ($('img-select-all')) $('img-select-all').addEventListener('change', function () { var checked = this.checked; imageRowsByToken.forEach(function (row, token) { if (!row.classList.contains('hidden')) selectImageToken(token, checked); }); });
    if ($('img-bulk-edit')) $('img-bulk-edit').addEventListener('click', editSelectedImages);
    if ($('img-bulk-album')) $('img-bulk-album').addEventListener('click', createAlbumFromSelection);
    if ($('img-bulk-revoke')) $('img-bulk-revoke').addEventListener('click', bulkRevokeImages);
    if ($('img-dashboard-refresh')) $('img-dashboard-refresh').addEventListener('click', refreshImageDashboard);
    if ($('img-dashboard-period')) $('img-dashboard-period').addEventListener('change', refreshImageDashboard);
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
    if ($('auto-lock-select')) $('auto-lock-select').addEventListener('change', function () {
      try { localStorage.setItem('dx-pwa-auto-lock-minutes', this.value); } catch (_) {}
      rememberSessionActivity(); checkSessionAutoLock();
    });
    if ($('density-select')) $('density-select').addEventListener('change', function () { applyDensity(this.value); });
    if ($('expire-select')) $('expire-select').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-expire', this.value); } catch (_) {} saveDestPreset(); });
    if ($('live-enable')) $('live-enable').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-live', this.checked ? '1' : '0'); } catch (_) {} if (this.checked) connectLive(); else disconnectLive(); });
    if ($('push-test-btn')) $('push-test-btn').addEventListener('click', testPushNotifications);
    if ($('live-push')) $('live-push').addEventListener('change', async function () {
      var el = this;
      if (el.checked) {
        // A manual OFF -> ON is an explicit repair action: retire any surviving
        // Android subscription and request a brand-new endpoint before registering
        // it server-side. This prevents a stale browser subscription from making the
        // toggle look enabled while real event pushes still go nowhere.
        var ok = await enablePush(true);
        if (ok) { toast(t('livePushOn'), 'ok'); try { localStorage.setItem('dx-pwa-push', '1'); } catch (_) {} }
        else { el.checked = false; try { localStorage.setItem('dx-pwa-push', '0'); } catch (_) {} toast(t('livePushFail'), 'err'); }
      } else {
        await disablePush(); toast(t('livePushOff'), 'warn'); try { localStorage.setItem('dx-pwa-push', '0'); } catch (_) {}
      }
    });
    if ($('push-language')) $('push-language').addEventListener('change', async function () {
      var value = selectedPushLanguage();
      try { localStorage.setItem('dx-pwa-push-lang', value); } catch (_) {}
      if ($('live-push') && $('live-push').checked) {
        var ok = await syncPushSubscription();
        if (!ok) { toast(t('livePushFail'), 'err'); return; }
      }
      toast(t('pushLanguageSaved'), 'ok');
    });
    if ($('wifi-only')) $('wifi-only').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-wifionly', this.checked ? '1' : '0'); } catch (_) {} persistWifiPolicies(); releaseWifiWaiters(); maybeAutoResume(); });
    if ($('large-wifi-only')) $('large-wifi-only').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-large-wifi-only', this.checked ? '1' : '0'); } catch (_) {} persistWifiPolicies(); releaseWifiWaiters(); maybeAutoResume(); });
    if ($('large-wifi-threshold')) $('large-wifi-threshold').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-large-wifi-threshold', this.value); } catch (_) {} persistWifiPolicies(); releaseWifiWaiters(); });
    if ($('persistent-transfer-notification')) $('persistent-transfer-notification').addEventListener('change', function () { configureActiveTransferNotifications(this.checked); });
    if ($('confirm-mobile-data')) $('confirm-mobile-data').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-confirm-mobile', this.checked ? '1' : '0'); } catch (_) {} });
    if ($('privacy-names')) $('privacy-names').addEventListener('change', function () {
      privacyNames = this.checked; document.body.classList.toggle('privacy-names', privacyNames);
      try { localStorage.setItem('dx-pwa-privacy-names', privacyNames ? '1' : '0'); } catch (_) {}
      renderQueue(); renderHistory(); updateResultActions();
    });
    if ($('strip-exif')) $('strip-exif').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-stripexif', this.checked ? '1' : '0'); } catch (_) {} });
    if ($('pick-voice')) $('pick-voice').addEventListener('click', openVoice);
    if ($('pick-text')) $('pick-text').addEventListener('click', emptyClipboardIntoQueue);
    if ($('pick-url')) $('pick-url').addEventListener('click', addFromUrl);
    if ($('pick-screen')) $('pick-screen').addEventListener('click', captureScreen);
    if ($('reset-batch-btn')) $('reset-batch-btn').addEventListener('click', resetBatch);
    if ($('last-batch-btn')) $('last-batch-btn').addEventListener('click', resendLastBatch);
    if ($('copy-summary-btn')) $('copy-summary-btn').addEventListener('click', copyLastSummary);
    if ($('share-result-btn')) $('share-result-btn').addEventListener('click', shareLastSummary);
    if ($('master-select')) $('master-select').addEventListener('change', function () { toggleMasterSelect(this.checked); });
    if ($('bulk-rename-btn')) $('bulk-rename-btn').addEventListener('click', bulkRename);
    if ($('undo-btn')) $('undo-btn').addEventListener('click', undoRemove);
    if ($('ocr-run')) $('ocr-run').addEventListener('click', runOcr);
    if ($('ocr-cancel-run')) $('ocr-cancel-run').addEventListener('click', cancelOcr);
    if ($('ocr-copy')) $('ocr-copy').addEventListener('click', copyOcrText);
    if ($('ocr-add-txt')) $('ocr-add-txt').addEventListener('click', addOcrTextToQueue);
    if ($('ocr-search')) $('ocr-search').addEventListener('input', function () { updateOcrSearch(true, false); });
    if ($('ocr-search-prev')) $('ocr-search-prev').addEventListener('click', function () { stepOcrSearch(-1); });
    if ($('ocr-search-next')) $('ocr-search-next').addEventListener('click', function () { stepOcrSearch(1); });
    if ($('ocr-close')) $('ocr-close').addEventListener('click', closeOcr);
    if ($('ocr-overlay')) $('ocr-overlay').addEventListener('click', function (e) { if (e.target === this) closeOcr(); });
    if ($('ocr-index-search')) $('ocr-index-search').addEventListener('input', renderOcrIndex);
    if ($('ocr-index-clear')) $('ocr-index-clear').addEventListener('click', clearOcrIndex);
    if ($('privacy-analyze')) $('privacy-analyze').addEventListener('click', analyzePrivacyCurrent);
    if ($('privacy-clean')) $('privacy-clean').addEventListener('click', cleanPrivacyCurrent);
    if ($('privacy-close')) $('privacy-close').addEventListener('click', closePrivacyInspector);
    if ($('privacy-cancel')) $('privacy-cancel').addEventListener('click', closePrivacyInspector);
    if ($('privacy-overlay')) $('privacy-overlay').addEventListener('click', function (e) { if (e.target === this) closePrivacyInspector(); });
    if ($('lightbox-close')) $('lightbox-close').addEventListener('click', closeLightbox);
    if ($('lightbox-x')) $('lightbox-x').addEventListener('click', closeLightbox);
    if ($('lightbox-overlay')) $('lightbox-overlay').addEventListener('click', function (e) { if (e.target === this) closeLightbox(); });
    if ($('image-stats-close')) $('image-stats-close').addEventListener('click', closeImageDetailedStats);
    if ($('image-stats-overlay')) $('image-stats-overlay').addEventListener('click', function (e) { if (e.target === this) closeImageDetailedStats(); });
    if ($('compare-close')) $('compare-close').addEventListener('click', closeCompare);
    if ($('compare-overlay')) $('compare-overlay').addEventListener('click', function (e) { if (e.target === this) closeCompare(); });
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
    if ($('bulk-dlp-btn')) $('bulk-dlp-btn').addEventListener('click', testPwaDlpSelected);
    if ($('dlp-test-queue-btn')) $('dlp-test-queue-btn').addEventListener('click', testPwaDlpQueue);
    if ($('ann-pan')) $('ann-pan').addEventListener('click', function () { setAnnTool('pan'); });
    if ($('ann-pen')) $('ann-pen').addEventListener('click', function () { setAnnTool('pen'); });
    if ($('ann-blur')) $('ann-blur').addEventListener('click', function () { setAnnTool('blur'); });
    if ($('ann-redact')) $('ann-redact').addEventListener('click', function () { setAnnTool('redact'); });
    if ($('ann-detect-faces')) $('ann-detect-faces').addEventListener('click', function () { detectAndBlurFaces(true); });
    if ($('ann-detect-plates')) $('ann-detect-plates').addEventListener('click', function () { detectAndBlurPlates(true); });
    if ($('ann-detect-sensitive')) $('ann-detect-sensitive').addEventListener('click', function () { detectAndBlurSensitiveText(true); });
    if ($('ann-rotate-left')) $('ann-rotate-left').addEventListener('click', function () { rotateAnnotate(-1); });
    if ($('ann-rotate-right')) $('ann-rotate-right').addEventListener('click', function () { rotateAnnotate(1); });
    if ($('ann-flip-h')) $('ann-flip-h').addEventListener('click', function () { flipAnnotate(true); });
    if ($('ann-flip-v')) $('ann-flip-v').addEventListener('click', function () { flipAnnotate(false); });
    if ($('ann-adjust-apply')) $('ann-adjust-apply').addEventListener('click', applyEditorAdjustments);
    if ($('ann-resize-apply')) $('ann-resize-apply').addEventListener('click', resizeAnnotate);
    if ($('ann-undo')) $('ann-undo').addEventListener('click', annUndo);
    if ($('ann-clear')) $('ann-clear').addEventListener('click', annClear);
    if ($('ann-crop-square')) $('ann-crop-square').addEventListener('click', function () { cropAnnotate(1); });
    if ($('ann-crop-43')) $('ann-crop-43').addEventListener('click', function () { cropAnnotate(4 / 3); });
    if ($('ann-crop-169')) $('ann-crop-169').addEventListener('click', function () { cropAnnotate(16 / 9); });
    if ($('ann-zoom-out')) $('ann-zoom-out').addEventListener('click', function () { stepEditorZoom(-1); });
    if ($('ann-zoom-in')) $('ann-zoom-in').addEventListener('click', function () { stepEditorZoom(1); });
    if ($('ann-zoom-fit')) $('ann-zoom-fit').addEventListener('click', function () { setEditorZoom(1); });
    if ($('ann-zoom')) $('ann-zoom').addEventListener('input', function () { setEditorZoom(Number(this.value) / 100); });
    if ($('ann-brush-size')) $('ann-brush-size').addEventListener('input', updateAnnBrushSize);
    if ($('ann-apply')) $('ann-apply').addEventListener('click', applyAnnotate);
    if ($('ann-cancel')) $('ann-cancel').addEventListener('click', closeAnnotate);
    if ($('annotate-overlay')) $('annotate-overlay').addEventListener('click', function (e) { if (e.target === this) closeAnnotate(); });
    if ($('annotate-canvas')) {
      var ac = $('annotate-canvas');
      ac.addEventListener('mousedown', annDown); ac.addEventListener('mousemove', annMove); window.addEventListener('mouseup', annUp);
      ac.addEventListener('touchstart', annDown, { passive: false }); ac.addEventListener('touchmove', annMove, { passive: false }); ac.addEventListener('touchend', annUp); ac.addEventListener('touchcancel', cancelAnnGesture);
    }
    if ($('annotate-canvas-wrap')) $('annotate-canvas-wrap').addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || $('annotate-overlay').classList.contains('hidden')) return;
      e.preventDefault(); stepEditorZoom(e.deltaY < 0 ? 1 : -1, { clientX: e.clientX, clientY: e.clientY });
    }, { passive: false });
    window.addEventListener('resize', scheduleEditorZoomLayout);
    window.addEventListener('blur', function () { if (annDrawing || annPanning || annPinch) cancelAnnGesture(); });
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
      rememberInstalledPwa();
      clearTimeout(installDiagnosticTimer);
      clearInstallDiagnostic();
      updateInstallButtonVisibility(true);
    });
    updateInstallButtonVisibility(false);
    window.addEventListener('online', function () {
      $('offbar').classList.add('hidden'); updateNetworkIndicator(); var waiters = onlineWaiters.splice(0); waiters.forEach(function (resolve) { resolve(); }); refreshDestStatus(); maybeAutoResume();
    });
    window.addEventListener('offline', function () { $('offbar').classList.remove('hidden'); updateNetworkIndicator(); registerBackgroundSync(); });
    function hasActiveTransferRisk() {
      if (sending || activeXhrs.size) return true;
      return items.some(function (it) { return ['sending', 'encrypting', 'optimizing', 'waiting-network'].indexOf(it.state) !== -1 && it.resumeOnOpen; });
    }
    window.addEventListener('beforeunload', function (e) {
      if (!hasActiveTransferRisk()) return;
      e.preventDefault(); e.returnValue = '';
      return '';
    });
    // Installed PWA navigation deliberately uses the platform-native Back behavior.
    // Older builds inserted a synthetic history guard and required a second Back press
    // to leave the app; repeated guard entries could make exiting require even more
    // presses. Do not add artificial history entries at the app root. Existing history
    // is left to Android/Chrome, while beforeunload above still protects active transfers.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        if (sending || ($('keep-awake') && $('keep-awake').checked)) acquireWake();
        checkSessionAutoLock();
        if (activePwaPanel === 'activity') {
          loadPwaLiveTransfers(true).catch(function () {});
          loadPwaServerActivity(false).catch(function () {});
        }
      }
    });
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (eventName) {
      document.addEventListener(eventName, rememberSessionActivity, { passive: true });
    });
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
      // Command palette: Ctrl/Cmd+K works from anywhere.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if ($('cmd-overlay').classList.contains('hidden')) openCmd(); else closeCmd(); return; }
      if (e.key === 'Escape') {
        if (scanning) stopScan();
        else if (!$('qr-overlay').classList.contains('hidden')) stopScan();
        else if (!$('privacy-overlay').classList.contains('hidden')) closePrivacyInspector();
        else if (!$('ocr-overlay').classList.contains('hidden')) closeOcr();
        else if (!$('image-stats-overlay').classList.contains('hidden')) closeImageDetailedStats();
        else if (!$('compare-overlay').classList.contains('hidden')) closeCompare();
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
      var anyOverlay = ['pair-overlay', 'destqr-overlay', 'help-overlay', 'qr-overlay', 'cmd-overlay', 'annotate-overlay', 'voice-overlay', 'multisend-overlay', 'lightbox-overlay', 'image-stats-overlay', 'compare-overlay', 'ocr-overlay', 'privacy-overlay']
        .some(function (id) { return $(id) && !$(id).classList.contains('hidden'); });
      // Number keys follow the visible bottom-nav order: 1–5 for regular users,
      // 1–6 when the owner/admin-only System Health tab is available.
      var shortcutPanels = systemHealthAccessEnabled
        ? ['send', 'images', 'shares', 'activity', 'system-health', 'settings']
        : ['send', 'images', 'shares', 'activity', 'settings'];
      var shortcutIndex = Number(e.key) - 1;
      if (!anyOverlay && !e.ctrlKey && !e.metaKey && !e.altKey && shortcutIndex >= 0 && shortcutIndex < shortcutPanels.length) {
        e.preventDefault(); activatePwaPanel(shortcutPanels[shortcutIndex], { userInitiated: true }); return;
      }
      // Ctrl/Cmd+A selects the whole queue when it isn't empty.
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
    lang = detectLang(); bindEvents(); initPwaNavigation(); installPwaDoubleBackExit(); installPullToRefresh(); registerServiceWorker(); loadInstallInfo();
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
      if ($('auto-lock-select')) $('auto-lock-select').value = localStorage.getItem('dx-pwa-auto-lock-minutes') || '15';
      if ($('wifi-only')) $('wifi-only').checked = localStorage.getItem('dx-pwa-wifionly') === '1';
      if ($('large-wifi-only')) $('large-wifi-only').checked = localStorage.getItem('dx-pwa-large-wifi-only') === '1';
      if ($('large-wifi-threshold')) $('large-wifi-threshold').value = localStorage.getItem('dx-pwa-large-wifi-threshold') || '100';
      if ($('persistent-transfer-notification')) {
        $('persistent-transfer-notification').checked = localStorage.getItem('dx-pwa-transfer-notification') !== '0';
        metaSet('transferNotificationEnabled', $('persistent-transfer-notification').checked).catch(function () {});
      }
      if ($('confirm-mobile-data')) $('confirm-mobile-data').checked = localStorage.getItem('dx-pwa-confirm-mobile') !== '0';
      privacyNames = localStorage.getItem('dx-pwa-privacy-names') === '1';
      if ($('privacy-names')) $('privacy-names').checked = privacyNames;
      document.body.classList.toggle('privacy-names', privacyNames);
      if ($('strip-exif')) $('strip-exif').checked = localStorage.getItem('dx-pwa-stripexif') === '1';
      if ($('expire-select')) $('expire-select').value = localStorage.getItem('dx-pwa-expire') || '0';
      if ($('live-enable')) $('live-enable').checked = localStorage.getItem('dx-pwa-live') !== '0';
      if ($('live-push')) $('live-push').checked = localStorage.getItem('dx-pwa-push') === '1';
      if ($('push-language')) {
        var savedPushLang = localStorage.getItem('dx-pwa-push-lang') || lang || 'fr';
        $('push-language').value = savedPushLang === 'en' || savedPushLang === 'es' ? savedPushLang : 'fr';
      }
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
      // Custom accent colour.
      var accent = localStorage.getItem('dx-accent') || '';
      if (accent) applyAccent(accent); else if ($('accent-color')) $('accent-color').value = '#3b6ef6';
      // Remember which cards were left open, and keep the expand/collapse label in sync.
      ['history-card', 'settings-card'].forEach(function (id) {
        var el = $(id); if (!el) return;
        var key = id === 'history-card' ? 'dx-pwa-history-open' : 'dx-pwa-settings-open';
        try { el.open = localStorage.getItem(key) === '1'; } catch (_) {}
        el.addEventListener('toggle', function () { try { localStorage.setItem(key, el.open ? '1' : '0'); } catch (_) {} });
      });
      applyAdvancedAccordion(false); startExpiryCountdowns(); renderTagColorManager();
      // Screen capture is desktop-only; reveal the tile only when supported.
      if ($('pick-screen') && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) $('pick-screen').classList.remove('hidden');
      // Restore the queue sort mode, populate the sender address book,
      // reveal "Share selection" when the OS supports file sharing.
      if ($('sort-select')) { sortMode = localStorage.getItem('dx-pwa-sort') || 'added'; $('sort-select').value = sortMode; }
      queueKindFilter = localStorage.getItem('dx-pwa-queue-kind') || 'all';
      if (['all', 'images', 'videos', 'documents', 'waiting', 'done', 'errors'].indexOf(queueKindFilter) === -1) queueKindFilter = 'all';
      buildSenderList();
      if ($('bulk-share-btn') && navigator.canShare) $('bulk-share-btn').classList.remove('hidden');
      if ($('batch-note')) updateCharCount($('batch-note'), $('note-count'), 120);
    } catch (_) {}
    startSessionAutoLock();
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
    var lockAfterClosedLaunch = closedLaunchNeedsLock();
    var deviceBootstrap = fetchDeviceStatus();
    if (lockAfterClosedLaunch) {
      await settleWithin(deviceBootstrap, 3000, null);
      if (deviceInfo && !deviceInfo.unavailable && deviceInfo.csrf) {
        var locked = await lockSessionAutomatically('closed');
        if (locked) return;
      }
    }
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
    await importBackgroundCompletions().catch(function () {});
    lastBatchRecord = await metaGet('lastBatch', null).catch(function () { return null; });
    lastBatchSummary = await metaGet('lastBatchSummary', null).catch(function () { return null; });
    await loadOcrIndex().catch(function () { ocrIndexRecords = []; renderOcrIndex(); });
    renderBuildTag();
    applyLanguage(lang); updateNetworkIndicator(); renderDests(); renderQueue(); renderHistory(); renderImageActionHistory(); updatePwaNavBadges(); updateSendBtn(); updateResultActions(); updateStorageStatus(); updateSessionStats(); restoreSender(); renderErrorCenter(); applyNetworkRecommendation(lastNetworkTest); renderNetworkDashboard();
    if ($('keep-awake') && $('keep-awake').checked) applyKeepAwake();
    if (pairedClaim) { toast(t('devicePairedOk'), 'ok'); try { history.replaceState(null, '', '/app/'); } catch (_) {} }
    await loadSharedBatch();
    renderDests(); renderQueue(); updateSendBtn();
    if (items.length) toast(t('resumedQueue', { n: items.length }), 'ok');
    // Network bootstraps are useful but must never hold the whole PWA hostage on
    // a half-open mobile connection. Let slow requests continue in the background,
    // while startup proceeds after a bounded window so resume/actions/navigation
    // remain usable offline or behind a flaky reverse proxy.
    await Promise.allSettled([
      settleWithin(deviceBootstrap, 12000, null),
      settleWithin(refreshDestStatus(), 12000, null),
      settleWithin(refreshImageStats(true), 12000, null),
      settleWithin(refreshAlbums(), 12000, null),
      settleWithin(refreshImageDashboard(), 12000, null),
      settleWithin(loadImageRetentionRules(), 12000, null),
      settleWithin(loadHostShares(), 12000, null), // populate the Partages nav badge without waiting for a tab visit
      settleWithin(loadReceptions(), 12000, null)  // list ALL reception links (incl. non-PWA) in the Destination picker
    ]);
    maybeAutoResume(); startImageStatsPolling(); startNotificationPolling();
    connectLive(); // live inbox receptions + image first-view events (SSE) when enabled
    // Keep the server-side subscription registry in sync with the browser. This is
    // intentionally silent (no permission prompt at launch): if permission is still
    // granted, an existing/missing subscription is healed; otherwise the toggle is
    // corrected so the UI never claims closed-app push is active when it is not.
    if ($('live-push') && $('live-push').checked) {
      syncPushSubscription().then(function (ok) {
        if (ok) return;
        $('live-push').checked = false;
        try { localStorage.setItem('dx-pwa-push', '0'); } catch (_) {}
      });
    }
    if (launchAction === 'destination') { activatePwaPanel('send', { instant: true }); openDestForm(); }
    else if (launchAction === 'camera') { activatePwaPanel('send', { instant: true }); setTimeout(function () { $('pick-camera').click(); }, 150); }
    else if (launchAction === 'files') { activatePwaPanel('send', { instant: true }); setTimeout(function () { openGenericFilePicker(false); }, 150); }
    else if (launchAction === 'shares') { activatePwaPanel('shares', { instant: true }); schedulePwaLaunchFocus(); }
    else if (launchAction === 'images') { activatePwaPanel('images', { instant: true }); schedulePwaLaunchFocus(); }
    else if (launchAction === 'system-health') { activatePwaPanel('system-health', { instant: true }); schedulePwaLaunchFocus(); }
    else if (launchAction === 'copy-link') { setTimeout(function () { handleNotificationAction('copy-link', { destinationUrl: launchDestinationUrl }); }, 150); }
    else if (launchAction === 'resend-last') { setTimeout(function () { handleNotificationAction('resend-last', {}); }, 150); }
    else if (launchAction === 'send') { activatePwaPanel('send', { instant: true }); }
    if (launchOpenCenter) { setTimeout(function () { openPwaNotificationCenter(launchCenterPanel); }, 250); } // cold start
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
      it.lastCheckpointAt=Date.now();
      // persistItem also refreshes the localStorage OPFS mirror, so an IndexedDB
      // failure cannot silently leave the only recoverable checkpoint stale.
      persistItem(it, false).catch(function () {});
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
  var transferCheckpointTimer=setInterval(function(){if(document.visibilityState!=='hidden'&&items.some(function(it){return it&&['sending','waiting-network','waiting','encrypting','optimizing'].indexOf(it.state)!==-1;}))checkpointActiveTransfers();},15000);
  window.addEventListener('pagehide', function () {
    checkpointPersistentUiState();
    if (items.some(function (it) { return it.backgroundReady && it.resumeOnOpen; })) registerBackgroundSync();
    if (!logoutInProgress && !autoLockInProgress && autoLockMinutes() > 0) {
      try { localStorage.setItem('dx-pwa-pagehide-at', String(Date.now())); } catch (_) {}
    }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      checkpointPersistentUiState();
      if (items.some(function (it) { return it.backgroundReady && it.resumeOnOpen; })) registerBackgroundSync();
    }
  });

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
