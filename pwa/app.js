'use strict';
/* Direct-Xfer — PWA compagnon durable.
 * - file d'attente IndexedDB (fichiers inclus)
 * - identifiants d'upload stables + reprise par morceaux
 * - pause/reprise, reconnexion automatique et parallélisme borné
 * - Web Share Target par lots, E2E DXE1, association d'appareil limitée à /app
 * - aucune dépendance ni service tiers
 */
(function () {
  // Upload blocks are deliberately small on mobile. A number of reverse proxies
  // still default to a 1 MiB request-body limit; an 8 MiB first block can therefore
  // be rejected before the browser emits any useful progress event, which looks like
  // an upload frozen at 0 %. The client can shrink further after a 413/reset.
  var DESKTOP_CHUNK = 8 * 1024 * 1024;
  var MOBILE_CHUNK = 768 * 1024;
  var MIN_CHUNK = 256 * 1024;
  var UPLOAD_TIMEOUT_MS = 4 * 60 * 1000;
  var OFFSET_TIMEOUT_MS = 15 * 1000;
  var MAX_RECOVERABLE_FAILURES = 8;
  var MOBILE_DURABLE_LIMIT = 32 * 1024 * 1024;
  var DESKTOP_DURABLE_LIMIT = 128 * 1024 * 1024;
  var PERSIST_DEBOUNCE_MS = 5000;
  var DB_NAME = 'direct-xfer-pwa';
  var DB_VERSION = 4;
  var QUEUE_STORE = 'queue';
  var DEST_STORE = 'destinations';
  var META_STORE = 'meta';
  var HISTORY_STORE = 'history';
  var MAX_HISTORY = 50;
  var launchParams = new URLSearchParams(location.search);
  var launchAction = launchParams.get('action') || '';
  var pairedClaim = launchParams.get('paired') === '1';
  var $ = function (id) { return document.getElementById(id); };

  var STRINGS = {
    fr: {
      title: 'Envoyer', language: 'Langue', theme: 'Thème', copyLink: 'Copier le lien', pasteLink: 'Coller un lien', editDestination: 'Modifier la destination', addDestination: 'Ajouter une destination', passwordPlaceholder: 'Mot de passe du lien', destinationPlaceholder: 'Lien ou jeton de réception', destinationNamePlaceholder: 'Nom facultatif de la destination', senderPlaceholder: 'Nom demandé par ce lien', globalProgress: 'Progression globale', keyPlaceholder: 'Clé de chiffrement du lien', titlePlaceholder: 'Contenu partagé', pairedBadge: 'Appareil associé', themeDark: 'Sombre', themeLight: 'Clair', themeAuto: 'Auto', install: 'Installer',
      offline: 'Hors ligne — les envois reprendront à la reconnexion.', updateReady: 'Une nouvelle version est disponible.', updateNow: 'Actualiser',
      destination: 'Destination', destinationHint: 'Un lien de réception Direct-Xfer de cette instance.', linkOrToken: 'Lien ou jeton', displayName: 'Nom affiché',
      rememberDestination: 'Mémoriser cette destination sur cet appareil', scanQr: '📷 Scanner un QR', saveDestination: 'Ajouter', updateDestination: 'Enregistrer', createLinkTitle: 'Créer un lien de réception', createLinkName: 'Nom du nouveau lien', createLinkPlaceholder: 'Ex. Photos vacances', createLinkHint: 'Un nouveau lien de réception sera créé et ajouté à vos destinations. Partagez-le pour recevoir des fichiers.', createDo: 'Créer le lien', creating: 'Création…', createOk: 'Lien créé ✓', createFail: 'Création du lien impossible',
      imgLinksTitle: 'Liens d’image', imgLinksHint: 'Créez des liens directs vers vos images : chaque lien offre les versions Pleine, Mini et Micro, sans page relais.', imgLinksAdd: 'Ajouter des images', imgUploading: 'Téléversement…', imgThumbing: 'Mini et Micro…', imgReady: 'Prêt', imgCopyFull: '🔗 Pleine grandeur', imgCopyThumb: '🔗 Mini', imgCopyMicro: '🔗 Micro', imgCopied: 'Lien copié ✓', imgLinkFail: 'Échec de la création du lien',
      removeDestination: 'Retirer', cancel: 'Annuler', protectedLink: '🔒 Lien protégé', unlock: 'Déverrouiller', encryptedLink: '🔐 Chiffrement de bout en bout',
      encryptionKey: 'Clé du lien', passphrase: 'Phrase secrète', addFiles: 'Ajouter des fichiers', durableQueue: 'La file est conservée localement; les fichiers volumineux restent disponibles pendant cette session.',
      takePhoto: 'Prendre une photo', scanDocument: 'Scanner un document', chooseFiles: 'Choisir des fichiers', chooseFolder: 'Choisir un dossier',
      optimizePhotos: 'Optimiser les photos avant envoi', parallelUploads: 'Envois parallèles', senderName: 'Votre nom', pause: 'Pause', resume: 'Reprendre',
      retryAll: '↻ Réessayer', removePending: 'Tout retirer', send: 'Envoyer', clearCompleted: 'Effacer les envois terminés', history: 'Historique local',
      clearHistory: 'Effacer l’historique', settings: 'Réglages et sécurité', autoResume: 'Reprendre automatiquement à la reconnexion', storage: 'Stockage local',
      protectStorage: 'Protéger', deviceAccess: 'Accès de cet appareil', pairDevice: 'Associer cet appareil', pairOther: 'Associer par QR', pairOtherTitle: 'Associer un autre appareil', pairOtherHelp: 'Scannez ce QR sur l’autre appareil. Le lien est à usage unique et expire après cinq minutes.', pairQrAlt: 'QR d’association de l’appareil', pairLink: 'Lien d’association', pairExpires: 'Expire à {date}', pairQrFailed: 'Création du QR impossible', copy: 'Copier', revokeDevice: 'Révoquer', pairedDevices: 'Appareils associés',
      clearLocalData: 'Effacer toutes les données locales', companionApp: 'application compagnon', qrHint: 'Visez un QR code de lien de réception…', close: 'Fermer',
      noLink: '— Aucun lien —', addLinkHint: 'Ajoutez un lien de réception avec le bouton ＋.', checking: 'Vérification…', ready: '✓ Prêt à recevoir',
      locked: '🔒 Lien protégé — déverrouillez-le', revoked: '✗ Lien révoqué ou expiré', offlineServer: '⚠ Serveur injoignable', invalid: '✗ Lien introuvable',
      e2eKeyReady: 'La clé du lien chiffrera les fichiers dans ce navigateur.', e2eKeyMissing: 'Collez le lien complet contenant #k=… ou saisissez sa clé.',
      e2ePass: 'Saisissez la phrase secrète utilisée par ce lien.', waiting: 'en attente', restoring: 'à reprendre', sending: 'envoi…', paused: 'en pause',
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
      deviceUnpaired: 'Non associé. Une connexion administrateur est nécessaire une fois.', devicePairedOk: 'Appareil associé ✓', deviceRevoked: 'Accès de l’appareil révoqué',
      devicePairFailed: 'Association impossible', deviceRevokeFailed: 'Révocation impossible', deviceCurrent: 'cet appareil', deviceLast: 'Dernière utilisation {date}',
      localCleared: 'Données locales effacées', sharedTextName: 'partage.txt', sharedReceived: '{n} élément(s) partagé(s) ajouté(s) ✓',
      resumedQueue: 'File restaurée : {n} fichier(s)', optimizeFallback: 'Cette image ne peut pas être convertie ici; l’original sera envoyé.',
      heicFallback: 'La conversion HEIC dépend du décodage offert par ce navigateur.', renameLocked: 'Le nom est verrouillé dès que l’envoi commence.',
      noPending: 'Aucun fichier à envoyer.', destinationLocked: 'La destination reste verrouillée jusqu’à la fin du lot.', authExpired: 'La session a expiré; le lot partagé reste conservé.',
      retry: 'Réessayer', remove: 'Retirer', edit: 'Modifier', progress: 'Progression de {name}', clearHistoryConfirm: 'Effacer l’historique local ?',
      storageRequest: 'Demande de stockage persistant envoyée.', sessionOnly: 'Cette destination restera uniquement pour la session.',
      largeFileSessionOnly: '{n} fichier(s) volumineux seront envoyés sans copie locale. Gardez la PWA ouverte jusqu’à la fin.', fileSessionOnly: 'session uniquement',
      startingUpload: 'démarrage de l’envoi…', shrinkingChunk: 'adaptation au réseau…', uploadStalled: 'Le transfert ne démarre pas. Vérifiez la limite de taille et la mise en mémoire tampon du reverse proxy, puis réessayez.',
      maxFile: 'max {size}/fichier', filesLeft: '{left}/{total} fichiers', spaceLeft: '{left} libres / {total}', folderUnsupported: 'La sélection de dossier n’est pas prise en charge.',
      deviceName: 'Direct-Xfer PWA sur {platform}', revokeThisDeviceConfirm: 'Révoquer l’accès limité de cet appareil ?', revokeOtherConfirm: 'Révoquer cet appareil associé ?',
      updateApplied: 'Mise à jour appliquée.', historyDest: 'vers {dest}', textSharedHeader: 'Contenu partagé', urlSharedHeader: 'URL partagée'
    },
    en: {
      title: 'Send', language: 'Language', theme: 'Theme', copyLink: 'Copy link', pasteLink: 'Paste link', editDestination: 'Edit destination', addDestination: 'Add destination', passwordPlaceholder: 'Link password', destinationPlaceholder: 'Reception link or token', destinationNamePlaceholder: 'Optional destination name', senderPlaceholder: 'Name required by this link', globalProgress: 'Overall progress', keyPlaceholder: 'Link encryption key', titlePlaceholder: 'Shared content', pairedBadge: 'Paired device', themeDark: 'Dark', themeLight: 'Light', themeAuto: 'Auto', install: 'Install',
      offline: 'Offline — uploads will resume when the connection returns.', updateReady: 'A new version is available.', updateNow: 'Update',
      destination: 'Destination', destinationHint: 'A Direct-Xfer reception link from this instance.', linkOrToken: 'Link or token', displayName: 'Display name',
      rememberDestination: 'Remember this destination on this device', scanQr: '📷 Scan QR', saveDestination: 'Add', updateDestination: 'Save', removeDestination: 'Remove', createLinkTitle: 'Create a reception link', createLinkName: 'New link name', createLinkPlaceholder: 'e.g. Holiday photos', createLinkHint: 'A new reception link will be created and added to your destinations. Share it to receive files.', createDo: 'Create link', creating: 'Creating…', createOk: 'Link created ✓', createFail: 'Could not create the link',
      imgLinksTitle: 'Image links', imgLinksHint: 'Create direct links to your images: each link offers Full, Mini, and Micro versions, with no relay page.', imgLinksAdd: 'Add images', imgUploading: 'Uploading…', imgThumbing: 'Mini and Micro…', imgReady: 'Ready', imgCopyFull: '🔗 Full size', imgCopyThumb: '🔗 Mini', imgCopyMicro: '🔗 Micro', imgCopied: 'Link copied ✓', imgLinkFail: 'Could not create the link',
      cancel: 'Cancel', protectedLink: '🔒 Protected link', unlock: 'Unlock', encryptedLink: '🔐 End-to-end encryption', encryptionKey: 'Link key', passphrase: 'Passphrase',
      addFiles: 'Add files', durableQueue: 'The queue is stored locally; large files remain available for this session.', takePhoto: 'Take a photo', scanDocument: 'Scan a document', chooseFiles: 'Choose files',
      chooseFolder: 'Choose a folder', optimizePhotos: 'Optimize photos before upload', parallelUploads: 'Parallel uploads', senderName: 'Your name', pause: 'Pause', resume: 'Resume',
      retryAll: '↻ Retry', removePending: 'Remove all', send: 'Send', clearCompleted: 'Clear completed uploads', history: 'Local history', clearHistory: 'Clear history',
      settings: 'Settings and security', autoResume: 'Resume automatically when back online', storage: 'Local storage', protectStorage: 'Protect', deviceAccess: 'Device access',
      pairDevice: 'Pair this device', pairOther: 'Pair by QR', pairOtherTitle: 'Pair another device', pairOtherHelp: 'Scan this QR on the other device. The link is single-use and expires after five minutes.', pairQrAlt: 'Device pairing QR code', pairLink: 'Pairing link', pairExpires: 'Expires at {date}', pairQrFailed: 'Could not create the QR code', copy: 'Copy', revokeDevice: 'Revoke', pairedDevices: 'Paired devices', clearLocalData: 'Clear all local data', companionApp: 'companion app', qrHint: 'Point at a reception-link QR code…', close: 'Close',
      noLink: '— No link —', addLinkHint: 'Add a reception link with the ＋ button.', checking: 'Checking…', ready: '✓ Ready to receive', locked: '🔒 Protected link — unlock it',
      revoked: '✗ Revoked or expired link', offlineServer: '⚠ Server unreachable', invalid: '✗ Link not found', e2eKeyReady: 'The link key will encrypt files in this browser.',
      e2eKeyMissing: 'Paste the full link containing #k=… or enter its key.', e2ePass: 'Enter the passphrase used by this link.', waiting: 'waiting', restoring: 'resume ready', sending: 'uploading…',
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
      sharedTextName: 'shared.txt', sharedReceived: '{n} shared item(s) added ✓', resumedQueue: 'Queue restored: {n} file(s)', optimizeFallback: 'This image cannot be converted here; the original will be sent.',
      heicFallback: 'HEIC conversion depends on this browser’s decoder.', renameLocked: 'The name is locked once uploading starts.', noPending: 'No file to send.',
      destinationLocked: 'The destination stays locked until this batch ends.', authExpired: 'The session expired; the shared batch remains stored.', retry: 'Retry', remove: 'Remove', edit: 'Edit',
      progress: 'Progress for {name}', clearHistoryConfirm: 'Clear local history?', storageRequest: 'Persistent storage request sent.', sessionOnly: 'This destination is kept for this session only.',
      largeFileSessionOnly: '{n} large file(s) will be uploaded without a local copy. Keep the PWA open until completion.', fileSessionOnly: 'session only',
      startingUpload: 'starting upload…', shrinkingChunk: 'adapting to the network…', uploadStalled: 'The transfer cannot start. Check the reverse proxy body-size and request-buffering settings, then retry.',
      maxFile: 'max {size}/file', filesLeft: '{left}/{total} files', spaceLeft: '{left} free / {total}', folderUnsupported: 'Folder selection is unavailable.',
      deviceName: 'Direct-Xfer PWA on {platform}', revokeThisDeviceConfirm: 'Revoke this device’s limited access?', revokeOtherConfirm: 'Revoke this paired device?',
      updateApplied: 'Update applied.', historyDest: 'to {dest}', textSharedHeader: 'Shared content', urlSharedHeader: 'Shared URL'
    },
    es: {
      title: 'Enviar', language: 'Idioma', theme: 'Tema', copyLink: 'Copiar enlace', pasteLink: 'Pegar enlace', editDestination: 'Editar destino', addDestination: 'Añadir destino', passwordPlaceholder: 'Contraseña del enlace', destinationPlaceholder: 'Enlace o token de recepción', destinationNamePlaceholder: 'Nombre opcional del destino', senderPlaceholder: 'Nombre solicitado por este enlace', globalProgress: 'Progreso global', keyPlaceholder: 'Clave de cifrado del enlace', titlePlaceholder: 'Contenido compartido', pairedBadge: 'Dispositivo vinculado', themeDark: 'Oscuro', themeLight: 'Claro', themeAuto: 'Auto', install: 'Instalar',
      offline: 'Sin conexión — los envíos continuarán al reconectarse.', updateReady: 'Hay una nueva versión disponible.', updateNow: 'Actualizar', destination: 'Destino',
      destinationHint: 'Un enlace de recepción Direct-Xfer de esta instancia.', linkOrToken: 'Enlace o token', displayName: 'Nombre visible', rememberDestination: 'Recordar este destino en el dispositivo',
      scanQr: '📷 Escanear QR', saveDestination: 'Añadir', updateDestination: 'Guardar', removeDestination: 'Quitar', cancel: 'Cancelar', createLinkTitle: 'Crear un enlace de recepción', createLinkName: 'Nombre del nuevo enlace', createLinkPlaceholder: 'ej. Fotos vacaciones', createLinkHint: 'Se creará un nuevo enlace de recepción y se añadirá a tus destinos. Compártelo para recibir archivos.', createDo: 'Crear enlace', creating: 'Creando…', createOk: 'Enlace creado ✓', createFail: 'No se pudo crear el enlace',
      imgLinksTitle: 'Enlaces de imagen', imgLinksHint: 'Crea enlaces directos a tus imágenes: cada enlace ofrece las versiones Completa, Mini y Micro, sin página intermedia.', imgLinksAdd: 'Añadir imágenes', imgUploading: 'Subiendo…', imgThumbing: 'Mini y Micro…', imgReady: 'Listo', imgCopyFull: '🔗 Tamaño completo', imgCopyThumb: '🔗 Mini', imgCopyMicro: '🔗 Micro', imgCopied: 'Enlace copiado ✓', imgLinkFail: 'No se pudo crear el enlace', protectedLink: '🔒 Enlace protegido', unlock: 'Desbloquear',
      encryptedLink: '🔐 Cifrado de extremo a extremo', encryptionKey: 'Clave del enlace', passphrase: 'Frase secreta', addFiles: 'Añadir archivos',
      durableQueue: 'La cola se guarda localmente; los archivos grandes quedan disponibles durante esta sesión.', takePhoto: 'Tomar una foto', scanDocument: 'Escanear documento', chooseFiles: 'Elegir archivos',
      chooseFolder: 'Elegir carpeta', optimizePhotos: 'Optimizar fotos antes de enviar', parallelUploads: 'Envíos paralelos', senderName: 'Tu nombre', pause: 'Pausa', resume: 'Continuar',
      retryAll: '↻ Reintentar', removePending: 'Quitar todo', send: 'Enviar', clearCompleted: 'Borrar envíos terminados', history: 'Historial local', clearHistory: 'Borrar historial',
      settings: 'Ajustes y seguridad', autoResume: 'Continuar automáticamente al reconectar', storage: 'Almacenamiento local', protectStorage: 'Proteger', deviceAccess: 'Acceso del dispositivo',
      pairDevice: 'Vincular este dispositivo', pairOther: 'Vincular por QR', pairOtherTitle: 'Vincular otro dispositivo', pairOtherHelp: 'Escanea este QR en el otro dispositivo. El enlace es de un solo uso y caduca en cinco minutos.', pairQrAlt: 'Código QR para vincular el dispositivo', pairLink: 'Enlace de vinculación', pairExpires: 'Caduca a las {date}', pairQrFailed: 'No se pudo crear el código QR', copy: 'Copiar', revokeDevice: 'Revocar', pairedDevices: 'Dispositivos vinculados', clearLocalData: 'Borrar todos los datos locales', companionApp: 'aplicación complementaria',
      qrHint: 'Apunta a un QR de enlace de recepción…', close: 'Cerrar', noLink: '— Sin enlace —', addLinkHint: 'Añade un enlace con el botón ＋.', checking: 'Comprobando…',
      ready: '✓ Listo para recibir', locked: '🔒 Enlace protegido — desbloquéalo', revoked: '✗ Enlace revocado o caducado', offlineServer: '⚠ Servidor inaccesible', invalid: '✗ Enlace no encontrado',
      e2eKeyReady: 'La clave cifrará los archivos en este navegador.', e2eKeyMissing: 'Pega el enlace completo con #k=… o introduce la clave.', e2ePass: 'Introduce la frase secreta del enlace.',
      waiting: 'en espera', restoring: 'listo para continuar', sending: 'enviando…', paused: 'en pausa', waitingNetwork: 'esperando red', encrypting: 'cifrando…', optimizing: 'optimizando…',
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
      sharedReceived: '{n} elemento(s) compartido(s) añadido(s) ✓', resumedQueue: 'Cola restaurada: {n} archivo(s)', optimizeFallback: 'No se puede convertir esta imagen; se enviará el original.',
      heicFallback: 'La conversión HEIC depende del navegador.', renameLocked: 'El nombre se bloquea al empezar el envío.', noPending: 'No hay archivos para enviar.',
      destinationLocked: 'El destino queda bloqueado hasta terminar el lote.', authExpired: 'La sesión caducó; el lote compartido sigue guardado.', retry: 'Reintentar', remove: 'Quitar', edit: 'Editar',
      progress: 'Progreso de {name}', clearHistoryConfirm: '¿Borrar el historial local?', storageRequest: 'Solicitud de almacenamiento persistente enviada.', sessionOnly: 'Este destino solo durará esta sesión.',
      largeFileSessionOnly: '{n} archivo(s) grande(s) se enviarán sin copia local. Mantén la PWA abierta hasta terminar.', fileSessionOnly: 'solo esta sesión',
      startingUpload: 'iniciando envío…', shrinkingChunk: 'adaptando a la red…', uploadStalled: 'La transferencia no puede iniciarse. Revisa el límite de tamaño y el búfer de solicitudes del proxy inverso y vuelve a intentarlo.',
      maxFile: 'máx. {size}/archivo', filesLeft: '{left}/{total} archivos', spaceLeft: '{left} libres / {total}', folderUnsupported: 'La selección de carpetas no está disponible.',
      deviceName: 'PWA Direct-Xfer en {platform}', revokeThisDeviceConfirm: '¿Revocar el acceso limitado de este dispositivo?', revokeOtherConfirm: '¿Revocar este dispositivo vinculado?',
      updateApplied: 'Actualización aplicada.', historyDest: 'a {dest}', textSharedHeader: 'Contenido compartido', urlSharedHeader: 'URL compartida'
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
    if (manifest) manifest.href = '/app/' + (lang === 'fr' ? 'manifest.webmanifest' : 'manifest-' + lang + '.webmanifest');
    $('lang-select').value = lang;
    $('dest-save-btn').textContent = editingToken ? t('updateDestination') : t('saveDestination');
    renderDests(); renderQueue(); renderHistory(); renderDeviceStatus();
  }

  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.className = ''; }, 3600);
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
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
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr-only';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); resolve();
      } catch (e) { reject(e); }
    });
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
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(QUEUE_STORE)) db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DEST_STORE)) db.createObjectStore(DEST_STORE, { keyPath: 'token' });
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(HISTORY_STORE)) db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
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

  // Destinations -------------------------------------------------------------
  var persistentDests = [];
  var sessionDests = [];
  var editingToken = '';
  var currentDest = null;
  var currentConfig = null;
  var currentDestOk = false;
  var destNeedsSender = false;
  var destinationLocked = false;

  function loadSessionDests() {
    try {
      var list = JSON.parse(sessionStorage.getItem('dx-session-dests') || '[]');
      return Array.isArray(list) ? list.filter(function (d) { return d && /^[A-Za-z0-9_-]{6,64}$/.test(String(d.token || '')); }) : [];
    } catch (_) { return []; }
  }
  function persistSessionDests() {
    try { sessionStorage.setItem('dx-session-dests', JSON.stringify(sessionDests)); } catch (_) {}
  }
  function allDests() {
    var map = Object.create(null), out = [];
    persistentDests.concat(sessionDests).forEach(function (d) {
      if (!d || !d.token || map[d.token]) return;
      map[d.token] = true; out.push(d);
    });
    return out;
  }
  function activeToken() {
    try { return sessionStorage.getItem('dx-active-dest') || ''; } catch (_) { return ''; }
  }
  function setActiveToken(token) {
    try { sessionStorage.setItem('dx-active-dest', token || ''); } catch (_) {}
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
    var previous = sel.value || activeToken();
    sel.innerHTML = '';
    var list = allDests();
    if (!list.length) {
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = t('noLink'); sel.appendChild(empty);
      sel.disabled = true;
    } else {
      sel.disabled = destinationLocked;
      list.forEach(function (d) {
        var opt = document.createElement('option'); opt.value = d.token; opt.textContent = d.name || ('…' + d.token.slice(-8)); sel.appendChild(opt);
      });
      var chosen = list.some(function (d) { return d.token === previous; }) ? previous : list[0].token;
      sel.value = chosen; setActiveToken(chosen);
    }
    $('dest-copy-btn').classList.toggle('hidden', !sel.value);
    $('dest-edit-btn').classList.toggle('hidden', !sel.value);
  }
  function saveDestinationRecord(dest, remember) {
    sessionDests = sessionDests.filter(function (d) { return d.token !== dest.token; });
    persistentDests = persistentDests.filter(function (d) { return d.token !== dest.token; });
    if (remember) {
      persistentDests.push(dest); persistSessionDests();
      return idbPut(DEST_STORE, dest);
    }
    sessionDests.push(dest); persistSessionDests();
    return idbDelete(DEST_STORE, dest.token).catch(function () {});
  }
  function removeDestinationRecord(token) {
    sessionDests = sessionDests.filter(function (d) { return d.token !== token; }); persistSessionDests();
    persistentDests = persistentDests.filter(function (d) { return d.token !== token; });
    return idbDelete(DEST_STORE, token).catch(function () {});
  }
  function migrateLegacyDests() {
    var legacy = [];
    try { legacy = JSON.parse(localStorage.getItem('dx_dests') || '[]') || []; } catch (_) {}
    if (!legacy.length) return Promise.resolve();
    return Promise.all(legacy.filter(function (d) { return d && d.token; }).map(function (d) {
      return idbPut(DEST_STORE, { token: d.token, name: d.name || '', key: '', sourceOrigin: location.origin, remembered: true, createdAt: Date.now() });
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
    $('unlock-form').classList.add('hidden'); $('dest-limits').classList.add('hidden'); $('sender-row').classList.add('hidden');
    updateEncryptionPanel(); updateSendBtn();
    if (!currentDest) { $('dest-status').textContent = t('addLinkHint'); $('dest-status').className = 'dest-status muted'; return Promise.resolve(); }
    $('dest-status').textContent = t('checking'); $('dest-status').className = 'dest-status muted';
    return validateDest(currentDest).then(function (result) {
      if (requestId !== refreshCounter) return;
      if (result.status === 'ok') {
        currentConfig = result.config || {}; currentDestOk = true; destNeedsSender = !!currentConfig.groupBySender;
        $('dest-status').textContent = t('ready'); $('dest-status').className = 'dest-status ok';
        $('sender-row').classList.toggle('hidden', !destNeedsSender); if (destNeedsSender) restoreSender();
        showLimits(currentConfig); updateEncryptionPanel(); maybeAutoResume();
      } else if (result.status === 'locked') {
        $('dest-status').textContent = t('locked'); $('dest-status').className = 'dest-status warn'; $('unlock-form').classList.remove('hidden');
      } else if (result.status === 'revoked') {
        $('dest-status').textContent = t('revoked'); $('dest-status').className = 'dest-status err';
      } else if (result.status === 'offline') {
        $('dest-status').textContent = t('offlineServer'); $('dest-status').className = 'dest-status warn';
      } else {
        $('dest-status').textContent = t('invalid'); $('dest-status').className = 'dest-status err';
      }
      updateSendBtn();
    });
  }
  function openDestForm(edit) {
    editingToken = edit || '';
    var d = editingToken ? findDest(editingToken) : null;
    $('dest-url').value = d ? (location.origin + '/u/' + d.token + (d.key ? '#k=' + d.key : '')) : '';
    $('dest-name').value = d ? (d.name || '') : '';
    $('dest-remember').checked = !!(d && d.remembered);
    $('dest-save-btn').textContent = editingToken ? t('updateDestination') : t('saveDestination');
    $('dest-remove-btn').classList.toggle('hidden', !editingToken);
    $('dest-form').classList.remove('hidden');
    $('dest-url').focus();
  }
  function closeDestForm() {
    editingToken = ''; $('dest-form').classList.add('hidden'); $('dest-url').value = ''; $('dest-name').value = ''; $('dest-remove-btn').classList.add('hidden');
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
      if (!deviceInfo) await fetchDeviceStatus();
      var r = await fetch('/app/inbox', {
        method: 'POST', credentials: 'same-origin',
        headers: appMutationHeaders('application/json'), body: JSON.stringify({ name: name }),
      });
      if (!r.ok) throw new Error('http ' + r.status);
      var data = await r.json();
      if (!data || !data.token) throw new Error('no-token');
      var dest = { token: data.token, name: data.name || name || '', key: '', sourceOrigin: location.origin, remembered: true, createdAt: Date.now() };
      await saveDestinationRecord(dest, true);
      setActiveToken(dest.token);
      closeCreateForm();
      renderDests();
      $('dest-select').value = dest.token;
      refreshDestStatus();
      toast(t('createOk'), 'ok');
    } catch (e) {
      errEl.textContent = t('createFail'); errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = prev;
    }
  }

  // Queue --------------------------------------------------------------------
  var items = [];
  var historyEntries = [];
  var sending = false;
  var paused = false;
  var activeXhrs = new Set();
  var batch = [];
  var batchTotal = 0;
  var batchSnapshot = null;
  var resumeWaiters = [];
  var onlineWaiters = [];
  var wakeLock = null;
  var persistTimers = new Map();

  function payloadBytesForPersistence(it) {
    var total = it.file && it.file.size ? it.file.size : 0;
    if (it.preparedBlob && it.preparedBlob !== it.file) total += it.preparedBlob.size || 0;
    return total;
  }
  function queueRecord(it) {
    return {
      id: it.id,
      file: it.file,
      name: it.name,
      originalName: it.originalName,
      type: it.type,
      size: it.size,
      lastModified: it.lastModified,
      state: ['sending', 'waiting-network'].indexOf(it.state) !== -1 ? 'waiting' : it.state,
      uploadId: it.uploadId,
      sentBytes: it.sentBytes || 0,
      createdAt: it.createdAt,
      snapshot: it.snapshot ? Object.assign({}, it.snapshot, { key: '', passphrase: '' }) : null,
      preparedBlob: it.preparedBlob && it.preparedBlob !== it.file ? it.preparedBlob : null,
      upName: it.upName || null,
      upSize: it.upSize || null,
      preparedEncrypted: !!it.preparedEncrypted,
      optimized: !!it.optimized,
      errorCode: it.errorCode || null
    };
  }
  function markSessionOnly(it, notify) {
    if (!it) return Promise.resolve(false);
    var changed = !it.volatile;
    it.volatile = true;
    var timer = persistTimers.get(it.id);
    if (timer) { clearTimeout(timer); persistTimers.delete(it.id); }
    if (notify && changed) toast(t('largeFileSessionOnly', { n: 1 }), 'warn');
    return idbDelete(QUEUE_STORE, it.id).catch(function () {}).then(function () { return false; });
  }
  function persistItem(it, notifyOnFallback) {
    if (!it || it.state === 'removed' || it.state === 'done') return Promise.resolve(false);
    if (it.volatile || payloadBytesForPersistence(it) > durablePayloadLimit()) {
      return markSessionOnly(it, !!notifyOnFallback);
    }
    return idbPut(QUEUE_STORE, queueRecord(it)).then(function () { return true; }).catch(function () {
      // Storage quota and slow mobile IndexedDB must never prevent the network
      // upload from starting. Fall back to an in-memory, session-only queue item.
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
    return idbDelete(QUEUE_STORE, it.id).catch(function () {});
  }
  function makeItem(record) {
    return {
      id: record.id || genId(18),
      file: record.file,
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
      upName: record.upName || null,
      upSize: record.upSize || null,
      preparedEncrypted: !!record.preparedEncrypted,
      optimized: !!record.optimized,
      errorCode: record.errorCode || null,
      volatile: !!record.volatile,
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
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (isDuplicate(file)) { skipped++; continue; }
      var reason = rejectReason(file);
      if (reason) { toast(t(reason), 'warn'); continue; }
      var rel = file.webkitRelativePath || file.name || ('file-' + Date.now());
      var durable = file.size <= limit && plannedDurable + file.size <= budget;
      var item = makeItem({ file: file, name: rel, originalName: rel, type: file.type, size: file.size, lastModified: file.lastModified, state: 'waiting', volatile: !durable });
      items.push(item);
      if (durable) {
        plannedDurable += file.size;
        // Persist in the background. The upload UI must appear immediately even
        // when Android/iOS storage is slow or almost full.
        persistItem(item, true);
      } else {
        sessionOnlyCount++;
      }
      added++;
    }
    renderQueue(); updateSendBtn(); updateStorageStatus();
    if (skipped) toast(t('duplicate', { n: skipped }), 'warn');
    if (added) toast(t('queued', { n: added }), 'ok');
    if (sessionOnlyCount) toast(t('largeFileSessionOnly', { n: sessionOnlyCount }), 'warn');
  }
  function statusText(it) {
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
  function renderQueue() {
    var list = $('up-list');
    list.innerHTML = '';
    items.forEach(function (it) {
      if (it.state === 'removed') return;
      var row = document.createElement('div'); row.className = 'uprow'; row.dataset.id = it.id;
      var top = document.createElement('div'); top.className = 'top';
      if (/^image\//.test(it.type) && it.file) {
        var img = document.createElement('img'); img.className = 'thumb'; img.alt = '';
        try {
          var url = URL.createObjectURL(it.file); img.src = url; img.onload = img.onerror = function () { URL.revokeObjectURL(url); };
        } catch (_) {}
        top.appendChild(img);
      }
      var name = document.createElement('input'); name.className = 'nm-input'; name.type = 'text'; name.value = it.name; name.setAttribute('aria-label', t('edit'));
      name.disabled = !!(it.snapshot || ['sending', 'encrypting', 'optimizing', 'done'].indexOf(it.state) !== -1);
      name.addEventListener('change', function () {
        if (name.disabled) { toast(t('renameLocked'), 'warn'); return; }
        it.name = safeName(name.value); name.value = it.name; it.preparedBlob = null; it.upName = null; it.upSize = null; persistItem(it);
      });
      top.appendChild(name);
      var status = document.createElement('span'); status.className = 'st' + (it.state === 'done' ? ' ok' : it.state === 'error' ? ' err' : ''); status.textContent = statusText(it); top.appendChild(status);
      var actions = document.createElement('div'); actions.className = 'row-actions';
      if (it.state === 'error') {
        var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'icon-action'; retry.textContent = '↻'; retry.title = t('retry'); retry.setAttribute('aria-label', t('retry'));
        retry.addEventListener('click', function () { retryItem(it); }); actions.appendChild(retry);
      }
      var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'icon-action remove'; rm.textContent = '✕'; rm.title = t('remove'); rm.setAttribute('aria-label', t('remove'));
      rm.addEventListener('click', function () { removeItem(it); }); actions.appendChild(rm); top.appendChild(actions);
      row.appendChild(top);
      var progress = document.createElement('progress'); progress.max = Math.max(1, it.upSize || it.size || 1); progress.value = Math.min(progress.max, it.sentBytes || 0);
      progress.setAttribute('aria-label', t('progress', { name: it.name })); row.appendChild(progress);
      var meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = fmtBytes(it.sentBytes || 0) + ' / ' + fmtBytes(it.upSize || it.size) + (it.volatile ? ' · ' + t('fileSessionOnly') : ''); row.appendChild(meta);
      list.appendChild(row);
      it.row = row; it.progress = progress; it.status = status; it.meta = meta; it.nameInput = name;
    });
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
  async function removeItem(it) {
    if (it.xhr) { try { it.xhr.abort(); } catch (_) {} }
    activeXhrs.delete(it.xhr); it.state = 'removed';
    await cancelPartial(it); await removePersistedItem(it);
    items = items.filter(function (x) { return x !== it; });
    renderQueue(); updateSendBtn(); updateGlobalProgress(); updateStorageStatus();
  }
  async function clearPending() {
    if (!confirm(t('clearQueueConfirm'))) return;
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
  function loadImage(file) {
    if ('createImageBitmap' in window) return createImageBitmap(file);
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
  function canvasBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) { canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('encode')); }, type, quality); });
  }
  async function optimizeImage(it) {
    var file = it.file;
    if (!$('optimize-images').checked || !file || !/^image\//.test(it.type) || /svg|gif/i.test(it.type)) return file;
    it.state = 'optimizing'; updateItemUi(it, t('optimizing'));
    try {
      var image = await loadImage(file);
      var width = image.width, height = image.height, max = 2560;
      var scale = Math.min(1, max / Math.max(width, height));
      var canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      var ctx = canvas.getContext('2d', { alpha: false }); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (image.close) image.close();
      var blob = await canvasBlob(canvas, 'image/jpeg', 0.86);
      if (blob.size >= file.size && !/heic|heif/i.test(it.type)) return file;
      var newName = it.name.replace(/\.[^.\/]+$/, '') + '.jpg'; it.name = newName; it.optimized = true;
      return namedFile(blob, newName, 'image/jpeg', it.lastModified);
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
      return canvasBlob(canvas, 'image/jpeg', 0.82);
    }
    try {
      return {
        thumb: await make(thumbWidth, thumbHeight),
        micro: await make(Math.max(1, Math.round(thumbWidth / 2)), Math.max(1, Math.round(thumbHeight / 2))),
      };
    } finally {
      if (image.close) image.close();
    }
  }
  function imgLinkRow(name, previewUrl) {
    var row = document.createElement('div'); row.className = 'imglink-row';
    row.innerHTML =
      '<img class="imglink-thumb" alt="">' +
      '<div class="imglink-main"><div class="imglink-name"></div>' +
      '<div class="imglink-st muted sm"></div>' +
      '<div class="imglink-actions hidden">' +
      '<button class="btn ghost sm il-full" type="button"></button>' +
      '<button class="btn ghost sm il-thumb" type="button"></button>' +
      '<button class="btn ghost sm il-micro" type="button"></button></div></div>';
    row.querySelector('.imglink-name').textContent = name;
    if (previewUrl) { var im = row.querySelector('.imglink-thumb'); im.src = previewUrl; im.onload = im.onerror = function () { URL.revokeObjectURL(previewUrl); }; }
    var list = $('imglink-list'); list.insertBefore(row, list.firstChild);
    return row;
  }
  async function createOneImageLink(file) {
    var name = file.name || ('image-' + Date.now() + '.jpg');
    var preview = ''; try { preview = URL.createObjectURL(file); } catch (_) {}
    var row = imgLinkRow(name, preview);
    var st = row.querySelector('.imglink-st');
    st.textContent = t('imgUploading');
    try {
      if (!deviceInfo) await fetchDeviceStatus();
      var r = await fetch('/app/image?name=' + encodeURIComponent(name), {
        method: 'POST', credentials: 'same-origin',
        headers: appMutationHeaders(file.type || 'application/octet-stream'), body: file,
      });
      if (!r.ok) throw new Error('http ' + r.status);
      var data = await r.json();
      if (!data || !data.token) throw new Error('no-token');
      st.textContent = t('imgThumbing');
      try {
        var variants = await makeImageVariants(file);
        await Promise.all([
          fetch('/app/image/' + encodeURIComponent(data.token) + '/thumb', {
            method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/jpeg'), body: variants.thumb,
          }),
          fetch('/app/image/' + encodeURIComponent(data.token) + '/micro', {
            method: 'POST', credentials: 'same-origin', headers: appMutationHeaders('image/jpeg'), body: variants.micro,
          }),
        ]);
      } catch (_) {} // generated sizes are best-effort; their URLs fall back to a larger image
      var bf = row.querySelector('.il-full'), bt = row.querySelector('.il-thumb'), bm = row.querySelector('.il-micro');
      bf.textContent = t('imgCopyFull'); bt.textContent = t('imgCopyThumb'); bm.textContent = t('imgCopyMicro');
      bf.addEventListener('click', function () { copyText(data.imgUrl).then(function () { toast(t('imgCopied'), 'ok'); }); });
      bt.addEventListener('click', function () { copyText(data.thumbUrl).then(function () { toast(t('imgCopied'), 'ok'); }); });
      bm.addEventListener('click', function () { copyText(data.microUrl).then(function () { toast(t('imgCopied'), 'ok'); }); });
      row.querySelector('.imglink-actions').classList.remove('hidden');
      st.textContent = t('imgReady'); st.className = 'imglink-st ok sm';
    } catch (e) {
      st.textContent = t('imgLinkFail'); st.className = 'imglink-st err sm';
    }
  }
  async function createImageLinks(fileList) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) { return f && /^image\//.test(f.type); });
    for (var i = 0; i < files.length; i++) { await createOneImageLink(files[i]); }
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
      persistItem(it, true); // never block the first network request on IndexedDB
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
    persistItem(it, true); // encrypted blobs can be large; do not delay upload on IDB
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
      createdAt: Date.now()
    };
  }
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
      xhr.open('POST', '/u/' + encodeURIComponent(it.snapshot.token) + '/upload' + qs);
      xhr.withCredentials = true;
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Cache-Control', 'no-store');
      var started = Date.now();
      var settled = false;
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
        var sent = offset + event.loaded; it.sentBytes = sent;
        if (it.progress) { it.progress.max = Math.max(1, it.upSize); it.progress.value = Math.min(it.upSize, sent); }
        var elapsed = (Date.now() - started) / 1000;
        if (it.meta) {
          if (elapsed > 0.4 && event.loaded > 0) {
            var speed = event.loaded / elapsed;
            it.meta.textContent = '↑ ' + fmtBytes(speed) + '/s · ' + fmtBytes(sent) + ' / ' + fmtBytes(it.upSize) + (sent < it.upSize ? ' · ' + fmtEta((it.upSize - sent) / speed) : '');
          } else it.meta.textContent = fmtBytes(sent) + ' / ' + fmtBytes(it.upSize);
        }
        updateGlobalProgress();
      };
      xhr.onabort = function () {
        if (paused || it.state === 'removed') return finish({ paused: paused, cancelled: it.state === 'removed' });
        finish({ retry: true, offset: null, shrink: true });
      };
      xhr.onerror = function () { finish({ retry: true, offset: null, shrink: offset === 0 }); };
      xhr.ontimeout = function () { finish({ retry: true, offset: null, shrink: true, timeout: true }); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          var response = null; try { response = JSON.parse(xhr.responseText); } catch (_) {}
          return finish({ done: true, response: response });
        }
        var code = '', serverOffset = null;
        try { var body = JSON.parse(xhr.responseText) || {}; code = body.error || ''; if (body.offset != null) serverOffset = body.offset; } catch (_) {}
        if (xhr.status === 409) {
          if (serverOffset != null && serverOffset > offset) return finish({ progress: true, offset: serverOffset });
          return finish({ retry: true, offset: serverOffset });
        }
        if (FATAL.indexOf(code) !== -1) return finish({ fatal: true, code: code });
        if (xhr.status === 401) return finish({ fatal: true, code: 'locked' });
        if (xhr.status === 403) return finish({ fatal: true, code: 'revoked' });
        // A proxy commonly answers 413 before reading the body. Reduce the next
        // request below its body limit instead of retrying the same block forever.
        if (xhr.status === 413) return finish({ retry: true, offset: serverOffset, shrink: true, proxyLimit: true });
        finish({ retry: true, offset: serverOffset, shrink: offset === 0 && xhr.status >= 500 });
      };
      xhr.send(blob.slice(offset, end));
    });
  }
  function waitUntilOnline() {
    if (navigator.onLine) return Promise.resolve();
    return new Promise(function (resolve) { onlineWaiters.push(resolve); });
  }
  function waitUntilResumed() {
    if (!paused) return Promise.resolve();
    return new Promise(function (resolve) { resumeWaiters.push(resolve); });
  }
  async function finishItem(it, response) {
    it.state = 'done'; it.sentBytes = it.upSize; it.errorCode = null;
    updateItemUi(it, t('done'), 'ok'); if (it.meta) it.meta.textContent = fmtBytes(it.upSize);
    await removePersistedItem(it);
    await addHistory({ id: genId(18), name: it.name, size: it.size, sentSize: it.upSize, destination: it.snapshot.name, encrypted: !!it.snapshot.enc, at: Date.now() });
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
      it.state = 'error'; it.errorCode = e && e.message === 'nokey' ? 'nokey' : e && e.message === 'nopass' ? 'nopass' : e && e.message === 'nocrypto' ? 'nocrypto' : 'prepare';
      updateItemUi(it, it.errorCode === 'nokey' ? t('keyRequired') : it.errorCode === 'nopass' ? t('passRequired') : it.errorCode === 'nocrypto' ? t('noCrypto') : t('error'), 'err');
      await persistItem(it, false); return false;
    }
    it.prepareProgress = 0;
    var offset = await getOffset(it.snapshot, it.uploadId);
    offset = Math.min(offset, it.upSize); it.sentBytes = offset;
    var failures = 0;
    while (it.state !== 'removed') {
      await waitUntilResumed();
      if (!navigator.onLine) {
        it.state = 'waiting-network'; updateItemUi(it, t('waitingNetwork')); schedulePersistItem(it); await waitUntilOnline(); continue;
      }
      it.state = 'sending'; updateItemUi(it, offset ? Math.round((offset / Math.max(1, it.upSize)) * 100) + '%' : t('startingUpload'));
      var result = await putChunk(it, offset);
      if (result.cancelled) return false;
      if (result.paused) { it.state = 'paused'; updateItemUi(it, t('paused')); await persistItem(it, false); continue; }
      if (result.done) { await finishItem(it, result.response); return true; }
      if (result.progress) {
        offset = Math.min(result.offset, it.upSize); it.sentBytes = offset; failures = 0; schedulePersistItem(it); updateGlobalProgress(); continue;
      }
      if (result.fatal) {
        it.state = 'error'; it.errorCode = result.code; updateItemUi(it, reasonText(result.code), 'err'); await persistItem(it, false); return false;
      }
      failures++;
      var currentChunk = Math.max(MIN_CHUNK, it.chunkSize || initialChunkSize());
      if (result.shrink || (offset === 0 && failures >= 2)) {
        var smaller = nextSmallerChunk(currentChunk);
        if (smaller < currentChunk) {
          it.chunkSize = smaller;
          updateItemUi(it, t('shrinkingChunk'));
          failures = Math.min(failures, 2);
        } else if (result.proxyLimit || failures >= MAX_RECOVERABLE_FAILURES) {
          it.state = 'error'; it.errorCode = 'upload-stalled';
          updateItemUi(it, t('uploadStalled'), 'err');
          if (it.meta) it.meta.textContent = t('uploadStalled');
          await persistItem(it, false); return false;
        }
      }
      if (failures >= MAX_RECOVERABLE_FAILURES && currentChunk <= MIN_CHUNK) {
        it.state = 'error'; it.errorCode = 'upload-stalled';
        updateItemUi(it, t('uploadStalled'), 'err');
        if (it.meta) it.meta.textContent = t('uploadStalled');
        await persistItem(it, false); return false;
      }
      it.state = navigator.onLine ? 'sending' : 'waiting-network'; updateItemUi(it, navigator.onLine ? t('restoring') : t('waitingNetwork'));
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
    ['dest-select', 'dest-add-btn', 'dest-create-btn', 'dest-edit-btn', 'dest-paste-btn', 'dest-copy-btn', 'sender-name', 'enc-key', 'enc-passphrase'].forEach(function (id) {
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
  }
  function resumeBatch() {
    if (!paused) return;
    paused = false; $('resume-btn').classList.add('hidden'); $('pause-btn').classList.remove('hidden');
    var waiters = resumeWaiters.splice(0); waiters.forEach(function (resolve) { resolve(); }); toast(t('resumed'), 'ok');
  }
  async function startBatch(onlyItems) {
    if (sending) return;
    var candidates = (onlyItems || items).filter(function (it) { return it.state === 'waiting' || it.state === 'error' || it.state === 'paused' || it.state === 'waiting-network'; });
    if (!candidates.length) { toast(t('noPending'), 'warn'); return; }
    var snap = candidates.every(function (it) { return !!it.snapshot; }) ? null : snapshotForCurrentDest();
    if (snap && !validateSnapshot(snap)) return;
    for (var i = 0; i < candidates.length; i++) {
      var item = candidates[i];
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
      persistItem(item, false); // snapshot persistence must not delay the upload
    }
    sending = true; paused = false; batch = candidates; batchTotal = candidates.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0);
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
    sending = false; paused = false; batch = []; batchTotal = 0; batchSnapshot = null; setDestinationLocked(false); releaseWake();
    $('pause-btn').classList.add('hidden'); $('resume-btn').classList.add('hidden'); $('global-progress-wrap').classList.add('hidden');
    if (navigator.vibrate) { try { navigator.vibrate(fail ? [60, 40, 60] : 35); } catch (_) {} }
    toast(t('batchResult', { ok: ok, fail: fail ? t('failures', { n: fail }) : ' ✓' }), fail ? 'warn' : 'ok');
    renderQueue(); updateSendBtn(); renderHistory(); updateStorageStatus(); refreshDestStatus();
  }
  function updateGlobalProgress() {
    var source = batch.length ? batch : items.filter(function (it) { return it.state !== 'done' && it.state !== 'removed'; });
    var total = batch.length ? source.reduce(function (sum, it) { return sum + (it.upSize || it.size || 0); }, 0) : 0;
    var sent = source.reduce(function (sum, it) { return sum + Math.min(it.sentBytes || 0, it.upSize || it.size || 0); }, 0);
    var done = source.filter(function (it) { return it.state === 'done'; }).length;
    $('global-progress').max = Math.max(1, total); $('global-progress').value = Math.min(total, sent);
    $('gprog-text').textContent = done + '/' + source.length + ' · ' + fmtBytes(sent) + ' / ' + fmtBytes(total);
  }
  function updateSendBtn() {
    var waiting = items.filter(function (it) { return ['waiting', 'paused', 'waiting-network'].indexOf(it.state) !== -1; });
    var errors = items.filter(function (it) { return it.state === 'error'; });
    var done = items.some(function (it) { return it.state === 'done'; });
    $('send-btn').disabled = sending || !(currentDestOk && waiting.length);
    $('clear-done-btn').classList.toggle('hidden', !done);
    $('queue-summary').classList.toggle('hidden', !(waiting.length || errors.length || sending));
    var bytes = waiting.reduce(function (sum, it) { return sum + (it.size || 0); }, 0);
    $('queue-text').textContent = waiting.length ? t('queueSummary', { waiting: waiting.length, size: fmtBytes(bytes) }) : t('queueErrors', { n: errors.length });
    $('retry-all-btn').classList.toggle('hidden', !errors.length || sending);
    $('clear-all-btn').classList.toggle('hidden', !(waiting.length || errors.length) || sending);
  }
  function maybeAutoResume() {
    if (sending || !currentDestOk || !$('auto-resume').checked || !navigator.onLine) return;
    var resumable = items.filter(function (it) {
      return it.snapshot && it.snapshot.token === currentDest.token && ['waiting', 'waiting-network', 'paused'].indexOf(it.state) !== -1 && it.sentBytes > 0;
    });
    if (resumable.length) setTimeout(function () { if (!sending) startBatch(resumable); }, 250);
  }

  // History -----------------------------------------------------------------
  function addHistory(entry) {
    historyEntries.unshift(entry); if (historyEntries.length > MAX_HISTORY) historyEntries.length = MAX_HISTORY;
    return idbPut(HISTORY_STORE, entry).then(function () {
      if (historyEntries.length >= MAX_HISTORY) {
        var keep = Object.create(null); historyEntries.forEach(function (h) { keep[h.id] = true; });
        return idbGetAll(HISTORY_STORE).then(function (all) { return Promise.all(all.filter(function (h) { return !keep[h.id]; }).map(function (h) { return idbDelete(HISTORY_STORE, h.id); })); });
      }
    }).catch(function () {});
  }
  function renderHistory() {
    var list = $('history-list'); list.innerHTML = '';
    if (!historyEntries.length) { var empty = document.createElement('p'); empty.className = 'muted sm'; empty.textContent = t('historyEmpty'); list.appendChild(empty); return; }
    historyEntries.slice(0, 20).forEach(function (h) {
      var row = document.createElement('div'); row.className = 'history-row';
      var icon = document.createElement('span'); icon.textContent = h.encrypted ? '🔐' : '✓'; row.appendChild(icon);
      var main = document.createElement('div'); main.className = 'history-main';
      var strong = document.createElement('strong'); strong.textContent = h.name; main.appendChild(strong);
      var meta = document.createElement('div'); meta.className = 'history-meta'; meta.textContent = fmtBytes(h.size) + ' · ' + t('historyDest', { dest: h.destination }) + ' · ' + fmtDate(h.at); main.appendChild(meta);
      row.appendChild(main); list.appendChild(row);
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
      if (!r.ok) throw new Error('status'); deviceInfo = await r.json();
    } catch (_) { deviceInfo = { paired: false, adminSession: false, devices: [] }; }
    renderDeviceStatus();
  }
  function renderDeviceStatus() {
    if (!deviceInfo) return;
    $('device-badge').classList.toggle('hidden', !deviceInfo.paired);
    $('pair-device-btn').classList.toggle('hidden', !(deviceInfo.adminSession && !deviceInfo.paired));
    $('pair-other-btn').classList.toggle('hidden', !deviceInfo.adminSession);
    $('revoke-device-btn').classList.toggle('hidden', !deviceInfo.paired);
    $('device-status').textContent = deviceInfo.paired ? t('devicePaired') : deviceInfo.adminSession ? t('deviceAdmin') : t('deviceUnpaired');
    var devices = Array.isArray(deviceInfo.devices) ? deviceInfo.devices : [];
    $('device-list-wrap').classList.toggle('hidden', !deviceInfo.adminSession || !devices.length);
    var list = $('device-list'); list.innerHTML = '';
    devices.forEach(function (d) {
      var row = document.createElement('div'); row.className = 'device-row';
      var main = document.createElement('div'); main.className = 'device-main';
      var strong = document.createElement('strong'); strong.textContent = d.name + (d.current ? ' · ' + t('deviceCurrent') : ''); main.appendChild(strong);
      var meta = document.createElement('div'); meta.className = 'device-meta'; meta.textContent = t('deviceLast', { date: fmtDate(d.lastUsedAt || d.createdAt) }); main.appendChild(meta); row.appendChild(main);
      if (!d.current) {
        var revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'btn danger sm'; revoke.textContent = t('revokeDevice');
        revoke.addEventListener('click', function () { revokeDevice(d.id, false); }); row.appendChild(revoke);
      }
      list.appendChild(row);
    });
  }
  async function pairDevice() {
    try {
      var status = await fetch('/app/device/status', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); });
      if (!status.adminSession || !status.csrf) throw new Error('no-session');
      var name = t('deviceName', { platform: platformName() });
      var r = await fetch('/app/device/register', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrf }, body: JSON.stringify({ name: name }) });
      if (!r.ok) throw new Error('pair'); toast(t('devicePairedOk'), 'ok'); await fetchDeviceStatus();
    } catch (_) { toast(t('devicePairFailed'), 'err'); }
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
    if (!confirm(current ? t('revokeThisDeviceConfirm') : t('revokeOtherConfirm'))) return;
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (deviceInfo && deviceInfo.csrf) headers['X-CSRF-Token'] = deviceInfo.csrf;
      var r = await fetch('/app/device/revoke', { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify({ id: id || null }) });
      if (!r.ok) throw new Error('revoke'); toast(t('deviceRevoked'), 'ok'); await fetchDeviceStatus();
    } catch (_) { toast(t('deviceRevokeFailed'), 'err'); }
  }

  // Storage + settings -------------------------------------------------------
  async function updateStorageStatus() {
    if (!navigator.storage || !navigator.storage.estimate) { $('storage-status').textContent = t('storageUnknown'); return; }
    try {
      var est = await navigator.storage.estimate(); $('storage-status').textContent = t('storageUsage', { used: fmtBytes(est.usage || 0), quota: fmtBytes(est.quota || 0) });
    } catch (_) { $('storage-status').textContent = t('storageUnknown'); }
  }
  async function requestPersistentStorage() {
    try {
      var ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
      toast(ok ? t('storageProtected') : t('storageDenied'), ok ? 'ok' : 'warn'); updateStorageStatus();
    } catch (_) { toast(t('storageDenied'), 'warn'); }
  }
  async function clearLocalData() {
    if (!confirm(t('clearDataConfirm'))) return;
    var oldItems = items.slice();
    oldItems.forEach(function (it) { it.state = 'removed'; if (it.xhr) { try { it.xhr.abort(); } catch (_) {} } });
    activeXhrs.forEach(function (xhr) { try { xhr.abort(); } catch (_) {} });
    await Promise.all(oldItems.map(cancelPartial)).catch(function () {});
    sending = false; paused = false;
    var resume = resumeWaiters.splice(0); resume.forEach(function (resolve) { resolve(); });
    await Promise.all([idbClear(QUEUE_STORE), idbClear(DEST_STORE), idbClear(META_STORE), idbClear(HISTORY_STORE)]).catch(function () {});
    persistentDests = []; sessionDests = []; persistSessionDests(); items = []; historyEntries = [];
    try { localStorage.removeItem('dx_sender'); localStorage.removeItem('dx-pwa-auto-resume'); localStorage.removeItem('dx-pwa-concurrency'); } catch (_) {}
    renderDests(); renderQueue(); renderHistory(); refreshDestStatus(); updateSendBtn(); updateStorageStatus(); toast(t('localCleared'), 'ok');
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
    if (parseDestination(text)) { openDestForm(); $('dest-url').value = text; toast(t('qrFound'), 'ok'); }
    else toast(t('qrUnknown'), 'warn');
  }

  // Service worker updates ---------------------------------------------------
  var deferredPrompt = null, waitingWorker = null;
  function showUpdate(worker) { waitingWorker = worker; $('updatebar').classList.remove('hidden'); }
  function registerServiceWorker() {
    if (!navigator.serviceWorker || typeof navigator.serviceWorker.register !== 'function') return;
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).then(function (reg) {
      if (reg.waiting) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var worker = reg.installing;
        worker.addEventListener('statechange', function () { if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker); });
      });
    }).catch(function () {});
    navigator.serviceWorker.addEventListener('controllerchange', function () { location.reload(); });
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'UPDATE_READY' && e.source) showUpdate(e.source);
    });
  }

  // Events -------------------------------------------------------------------
  function bindEvents() {
    $('lang-select').addEventListener('change', function () { applyLanguage(this.value); });
    $('theme-select').value = document.documentElement.getAttribute('data-theme') || 'dark';
    $('theme-select').addEventListener('change', function () {
      var v = this.value; if (v !== 'light' && v !== 'auto') v = 'dark';
      try { localStorage.setItem('dx-theme', v); } catch (_) {} document.documentElement.setAttribute('data-theme', v);
    });
    $('dest-add-btn').addEventListener('click', function () { if (!destinationLocked) openDestForm(); });
    $('dest-edit-btn').addEventListener('click', function () { if (!destinationLocked) openDestForm($('dest-select').value); });
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
      var dest = { token: parsed.token, name: String($('dest-name').value || '').trim(), key: parsed.key || '', sourceOrigin: parsed.sourceOrigin, remembered: remember, createdAt: Date.now() };
      if (editingToken && editingToken !== dest.token) await removeDestinationRecord(editingToken);
      await saveDestinationRecord(dest, remember); if (!remember) toast(t('sessionOnly'), 'warn');
      setActiveToken(dest.token); closeDestForm(); renderDests(); $('dest-select').value = dest.token; refreshDestStatus();
    });
    $('dest-remove-btn').addEventListener('click', async function () {
      if (!editingToken || !confirm(t('removedConfirm'))) return;
      await removeDestinationRecord(editingToken); closeDestForm(); renderDests(); refreshDestStatus();
    });
    $('dest-select').addEventListener('change', function () { setActiveToken(this.value); $('enc-key').value = ''; $('enc-passphrase').value = ''; refreshDestStatus(); });
    $('dest-copy-btn').addEventListener('click', function () {
      if (!currentDest) return; var url = location.origin + '/u/' + currentDest.token + (currentDest.key ? '#k=' + currentDest.key : '');
      copyText(url).then(function () { toast(t('copied'), 'ok'); }, function () { toast(t('copyFailed'), 'err'); });
    });
    $('dest-paste-btn').addEventListener('click', async function () {
      try { var text = await navigator.clipboard.readText(); openDestForm(); $('dest-url').value = text; }
      catch (_) { toast(t('pasteFailed'), 'warn'); }
    });
    $('unlock-btn').addEventListener('click', function () {
      if (!currentDest || !$('unlock-pw').value) return;
      fetch('/u/' + encodeURIComponent(currentDest.token) + '/unlock', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent($('unlock-pw').value) })
        .then(function () { $('unlock-pw').value = ''; refreshDestStatus(); }).catch(function () { toast(t('unlockFailed'), 'err'); });
    });
    $('enc-key').addEventListener('input', function () { updateEncryptionPanel(); updateSendBtn(); });
    $('enc-passphrase').addEventListener('input', updateSendBtn);
    $('sender-name').addEventListener('input', function () { try { localStorage.setItem('dx_sender', this.value.trim()); } catch (_) {} updateSendBtn(); });
    ['pick-camera', 'pick-scan', 'pick-files', 'pick-folder'].forEach(function (id) {
      $(id).addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    });
    if ($('pick-imglink')) $('pick-imglink').addEventListener('change', function (e) { createImageLinks(e.target.files); e.target.value = ''; });
    $('send-btn').addEventListener('click', function () { startBatch(); });
    $('pause-btn').addEventListener('click', pauseBatch); $('resume-btn').addEventListener('click', resumeBatch);
    $('retry-all-btn').addEventListener('click', retryAll); $('clear-all-btn').addEventListener('click', clearPending); $('clear-done-btn').addEventListener('click', clearDone);
    $('history-clear-btn').addEventListener('click', async function () { if (!confirm(t('clearHistoryConfirm'))) return; await idbClear(HISTORY_STORE); historyEntries = []; renderHistory(); });
    $('persist-storage-btn').addEventListener('click', requestPersistentStorage);
    $('pair-device-btn').addEventListener('click', pairDevice); $('pair-other-btn').addEventListener('click', openPairingDialog);
    $('pair-copy-btn').addEventListener('click', copyPairingLink); $('pair-close').addEventListener('click', closePairingDialog);
    $('revoke-device-btn').addEventListener('click', function () { revokeDevice(null, true); });
    $('clear-local-btn').addEventListener('click', clearLocalData);
    $('dest-scan-btn').addEventListener('click', startScan); $('qr-close').addEventListener('click', stopScan);
    $('update-btn').addEventListener('click', function () { if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' }); });
    $('auto-resume').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-auto-resume', this.checked ? '1' : '0'); } catch (_) {} });
    $('concurrency-select').addEventListener('change', function () { try { localStorage.setItem('dx-pwa-concurrency', this.value); } catch (_) {} });
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; $('install-btn').classList.remove('hidden'); });
    $('install-btn').addEventListener('click', function () {
      if (!deferredPrompt) return; deferredPrompt.prompt(); deferredPrompt.userChoice.finally(function () { deferredPrompt = null; $('install-btn').classList.add('hidden'); });
    });
    window.addEventListener('appinstalled', function () { $('install-btn').classList.add('hidden'); });
    window.addEventListener('online', function () {
      $('offbar').classList.add('hidden'); var waiters = onlineWaiters.splice(0); waiters.forEach(function (resolve) { resolve(); }); refreshDestStatus(); maybeAutoResume();
    });
    window.addEventListener('offline', function () { $('offbar').classList.remove('hidden'); });
    window.addEventListener('beforeunload', function (e) {
      if (!sending) return;
      e.preventDefault(); e.returnValue = '';
      return '';
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && sending) acquireWake(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (scanning) stopScan();
      else if (!$('pair-overlay').classList.contains('hidden')) closePairingDialog();
    });
    ['dragenter', 'dragover'].forEach(function (eventName) {
      document.addEventListener(eventName, function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) { e.preventDefault(); document.body.classList.add('dragging'); } });
    });
    document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
    document.addEventListener('drop', function (e) { document.body.classList.remove('dragging'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    document.addEventListener('paste', function (e) { var files = e.clipboardData && e.clipboardData.files; if (files && files.length) addFiles(files); });
  }
  function restoreSender() { try { if (!$('sender-name').value) $('sender-name').value = localStorage.getItem('dx_sender') || ''; } catch (_) {} }

  async function initialize() {
    lang = detectLang(); bindEvents();
    try {
      $('auto-resume').checked = localStorage.getItem('dx-pwa-auto-resume') !== '0';
      $('concurrency-select').value = localStorage.getItem('dx-pwa-concurrency') || (isMobileLike() ? '1' : '2');
    } catch (_) {}
    if (!navigator.onLine) $('offbar').classList.remove('hidden');
    if (!('webkitdirectory' in $('pick-folder'))) $('pick-folder').parentElement.classList.add('hidden');
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
      $('dest-scan-btn').classList.add('hidden'); $('scan-note').textContent = t('scanUnsupported'); $('scan-note').classList.remove('hidden');
    }
    await migrateLegacyDests();
    sessionDests = loadSessionDests();
    persistentDests = await idbGetAll(DEST_STORE).catch(function () { return []; });
    var queueRecords = await idbGetAll(QUEUE_STORE).catch(function () { return []; });
    items = queueRecords.filter(function (r) { return r && r.file; }).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); }).map(makeItem);
    historyEntries = (await idbGetAll(HISTORY_STORE).catch(function () { return []; })).sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).slice(0, MAX_HISTORY);
    applyLanguage(lang); renderDests(); renderQueue(); renderHistory(); updateSendBtn(); updateStorageStatus(); restoreSender();
    if (pairedClaim) { toast(t('devicePairedOk'), 'ok'); try { history.replaceState(null, '', '/app/'); } catch (_) {} }
    await loadSharedBatch();
    renderDests(); renderQueue(); updateSendBtn();
    if (items.length) toast(t('resumedQueue', { n: items.length }), 'ok');
    await refreshDestStatus(); await fetchDeviceStatus(); registerServiceWorker();
    if (launchAction === 'destination') openDestForm();
    else if (launchAction === 'camera') setTimeout(function () { $('pick-camera').click(); }, 150);
    else if (launchAction === 'files') setTimeout(function () { $('pick-files').click(); }, 150);
  }

  initialize().catch(function (e) { console.error(e); toast(t('error'), 'err'); });
})();
