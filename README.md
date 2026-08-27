```
██████╗ ██╗██████╗ ███████╗ ██████╗████████╗    ██╗  ██╗███████╗███████╗██████╗
██╔══██╗██║██╔══██╗██╔════╝██╔════╝╚══██╔══╝    ╚██╗██╔╝██╔════╝██╔════╝██╔══██╗
██║  ██║██║██████╔╝█████╗  ██║        ██║        ╚███╔╝ █████╗  █████╗  ██████╔╝
██║  ██║██║██╔══██╗██╔══╝  ██║        ██║        ██╔██╗ ██╔══╝  ██╔══╝  ██╔══██╗
██████╔╝██║██║  ██║███████╗╚██████╗   ██║       ██╔╝ ██╗██║     ███████╗██║  ██║
╚═════╝ ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝   ╚═╝       ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝
```

# Direct-Xfer

🚀 Direct file **sharing and receiving** — plus **image self-hosting** — over HTTP or secure **HTTPS** (built-in, or via a reverse proxy), in Docker, with no third-party service.

[English](#english) · [Français](#français) · [Español](#español) · [Docker Compose & reference](#docker-compose)

[MIT License](LICENSE) · [Code signing policy](CODE_SIGNING_POLICY.md) · [Privacy policy](PRIVACY.md) · [SignPath Foundation setup](signpath/README.md)

---

## Code signing policy

Windows release signing is prepared for **SignPath Foundation Open Source Code Signing**. Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) for team roles, build-origin rules and release approval, and [PRIVACY.md](PRIVACY.md) for outbound-network/privacy details.

> **Windows artifacts:** every Windows build publishes clearly labelled `-UNSIGNED` preview artifacts for testing. These files intentionally have no Authenticode publisher identity and may be blocked by Windows Smart App Control. Canonical artifact names without `-UNSIGNED` are reserved for the SignPath-signed release path after final Authenticode validation.

When SignPath signing is enabled after Foundation approval, GitHub Actions first publishes the unsigned portable package and unsigned installer preview, then submits Direct-Xfer's launcher and ServerHost for SignPath approval. After those executables are signed, the installer is rebuilt from the signed payload, signed separately, and all three Authenticode signatures are validated. All signed Direct-Xfer binaries carry the same release **ProductVersion**, while launcher/ServerHost component **FileVersion** values remain independently scoped. Regular development artifacts remain unsigned and are clearly distinguished from signed release artifacts.

---

## English

Share and receive files from your server through a simple link, over HTTP or secure
HTTPS. **Image self-hosting** too: direct Full/Mini/Micro links ready to embed or hotlink.
Multilingual web UI (FR/EN/ES), password-protected admin restricted to the local
network by default.

### Install

1. In `docker-compose.yml`, replace `/PATH/TO/CONFIGURE` with the host folder where received files should be written.
2. `docker compose up -d --build`
3. Admin password: shown in the startup logs (`docker compose logs`).
4. Open `http://YOUR-SERVER-IP:55750/` (from the local network).

### How it works

Your server is mounted **read-only** (`/:/host:ro`): you share any file by its real
path, no copy. Received files land in the folder mounted on `/Direct-Xfer`. Link types:
`…/s/<token>` (share), `…/u/<token>` (reception), `…/c/<token>` (collaboration),
`…/i/<token>` (direct image); the installable companion app is at `…/app`. The public
link domain is set in the UI.

### Features

- **Sharing** — a file or a folder (browsable + `.zip`). Each link is **editable in
  place** (expiry, password, quota, speed, name, toggles — same URL), can be a
  **one-time link** (auto-revoked after the first complete download), capped to a
  **max number of unique visitors**, **paused/resumed** or **cloned** in one click,
  **e-mailed** to a recipient (SMTP), and carries an optional **password** + **QR code**.
- **Resumable downloads** — regular shared files and files retrieved from the PWA are
  downloaded in verified byte ranges and kept in browser storage. Closing the tab,
  browser or installed PWA no longer discards completed chunks; changed files are
  detected with ETag/If-Range before a clean restart.
- **Nominative sub-links** — one link per recipient (own token) with **read receipts**
  (viewed/downloaded per person); remove one to revoke just that access.
- **Reception** (`…/u/`) — multi-file uploads, **chunked & resumable** (a drop or reload
  resumes where it stopped), each request bounded (survives reverse-proxy body limits),
  optional **per-sender subfolders** and upload **moderation**.
- **Collaboration** (`…/c/`) — a two-way folder: visitors browse/download the live
  contents **and** upload; visitor deletion is opt-in per link.
- **Photos** (`…/i/`) — **direct image links, no relay page**: each photo gets Full,
  **Mini**, and **Micro** URLs that open the image itself (real Content-Type, long
  immutable cache) — ready to embed or hotlink. Micro is exactly half Mini's dimensions;
  both variants are generated in the browser, so there's no server-side image library.
  Full copies and generated variants are stored under the configurable `Images` volume.
  The admin gallery keeps the last 50 revoked images in a purgeable visual history,
  including their Full, Mini, and Micro view and visitor counts.
- **Companion PWA** (`…/app`) — installable mobile "send" app served same-origin:
  capture a photo/document or pick files, receive files straight from the OS **share
  sheet** (Web Share Target), add reception links by **QR scan**, unlock password links,
  upload chunked+resumable, works offline. Needs an **admin login** and a **secure
  context** (HTTPS or `localhost`) for the camera.
- **Manage & find** — live **usage bar** per card, **sort/filters**, **keyboard
  shortcuts** (`N`/`R`/`C` new, `/` filter, `?` help), a **shares summary** (count /
  active / size), a **private admin note** per link, bounded **full-text content
  search**, a per-link **access log** (who/when/where), **inline rename**, **drag-drop
  reorder** of a collection, a **duplicate-path warning**, a **links list export**
  (CSV/JSON), and configurable **quick expiry presets**.
- **Preview** — images, video (MP4/WebM/OGV/MOV/**MKV**), audio, PDF, text; **Markdown**
  rendered, **code** highlighted, **`.zip`** listed (names+sizes, nothing extracted);
  served same-origin under a strict CSP (scriptable files stay download-only). A folder
  of media opens a **playlist player** (▶) with auto-loaded subtitles (`.vtt`/`.srt`).
- **Notifications** — **webhook** (Discord/Slack/ntfy), **e-mail (SMTP)** and **browser
  push (Web Push)** with per-event toggles + Test buttons, plus a **link-expiry alert**,
  a **periodic digest** and a **"link likely leaked" alert**.
- **End-to-end encryption** (optional) — download shares and reception links can be E2E
  encrypted in the browser (WebCrypto, AES-GCM-256); the server only holds opaque
  ciphertext. Key **in the link** (`#k=…`) or a **passphrase**; needs a secure context.
  Encrypted deposits arrive as `.dxe` files, decrypted from the admin menu.
- **Client nicknames** — name any visitor IP; shown everywhere it appears.
- **Storage connectors** — admin-managed imports and exports through rclone remotes:
  SFTP, SMB, WebDAV, Google Drive, OneDrive, Dropbox and Box. Google Drive now uses a
  standard Google account sign-in by default: click **Connect Google Drive**, choose the
  Google account and allow access. No JSON file, service-account key, Client ID/Secret or
  callback copy/paste is required on each Direct-Xfer instance when the central OAuth broker
  is configured. Google refresh tokens remain on that central broker.
- **Web storage links** — create read-only cloud shares, **web reception links** that
  deposit uploads into a selected cloud folder, and **web collaboration links** for
  browsing/downloading/uploading, folder creation and optional visitor deletion.
- **Destructive-event protection & audit proofs** — ransomware-like upload bursts and
  mass deletion suspend both the client and affected writable link. The append-only
  HMAC audit journal can be exported as an Ed25519-signed proof for offline verification.

### Configuration (in-app ⚙, no restart)

Defaults for new links; a **global download cap** plus a **time-of-day bandwidth cap**;
**public-download protection** (per-IP rate-limit + optional self-hosted proof-of-work);
**security** (auto-lock, login lockout, session lifetime, token length, HTTP warning,
force 2FA, admin IP allowlist); **branding** (app name, accent, public-page **theme**
auto/light/dark, mobile color, favicon, languages, reception banner); a custom **logo**,
a **confidentiality banner** and a **preview watermark**; **privacy** (IP geolocation /
anonymization, history retention). **Backup**: export/import settings + links config +
audit log, and a **scheduled full backup** (local folder / WebDAV / S3-compatible) with
**one-click restore**, encrypted with `DATA_KEY` when set.

### Internet & reverse proxy

Forward `55750/tcp`. For **HTTPS**, put a reverse proxy in front and add
`TRUST_PROXY: "1"`. To expose the admin, restrict it with `ADMIN_ALLOWED_IPS` (loopback
always allowed; otherwise admin stays LAN-only). If a reception link goes through the
proxy, disable request buffering for it (Nginx: `proxy_request_buffering off;`) so
uploads progress live. On **Unraid**, set `PUID: "99"` / `PGID: "100"` so data persists.

### Android PWA installation

A full Android installation (WebAPK, Share Target, standalone window) requires an
**HTTPS URL with a certificate trusted by Android/Chrome**. Opening Direct-Xfer through
`http://192.168.x.x:55750` can only create a home-screen shortcut. Prefer a reverse
proxy with a valid certificate, set `PUBLIC_URL` to that HTTPS address and
`TRUST_PROXY: "1"`, then uninstall the old shortcut and install again from Chrome.
`TLS_SELF_SIGNED` does not qualify unless the certificate is explicitly trusted by the
Android device.

When using **Cloudflare Access**, the PWA installation assets must not be redirected to
an Access sign-in page. Create a path-specific **Bypass / Everyone** policy for these
public static endpoints only: `/direct-xfer-pwa-sw.js*`,
`/direct-xfer-pwa*.webmanifest*`, `/app/launch*`, `/app/icon*`,
`/app/apple-touch-icon.png` and `/app/screenshot-*`. Keep `/app/`, `/app/login` and all
`/app/*` APIs protected by Direct-Xfer authentication. A service-worker script behind
any HTTP redirect is rejected by Chrome, even when the final response is `200 OK`.

### Security

Read-only host, password admin + LAN/allowlist, 24-byte random tokens, path-traversal &
brute-force protection, non-root container, per-IP rate-limit + optional proof-of-work
(no third party). Admin & per-link passwords are stored only as salted scrypt hashes;
`DATA_KEY` encrypts the metadata store at rest. Optional ClamAV scan quarantines
infected uploads.

---

## Français

Partagez et recevez des fichiers depuis votre serveur via un simple lien, en HTTP ou en
HTTPS sécurisé. **Auto-hébergement d'images** aussi : liens directs Pleine taille/Mini/Micro
prêts à intégrer ou hotlinker. Interface web multilingue (FR/EN/ES), admin protégée par mot
de passe et limitée au réseau local par défaut.

### Installation

1. Dans `docker-compose.yml`, remplacez `/PATH/TO/CONFIGURE` par le dossier hôte où écrire les fichiers reçus.
2. `docker compose up -d --build`
3. Mot de passe admin : affiché dans les logs de démarrage (`docker compose logs`).
4. Ouvrez `http://IP-DU-SERVEUR:55750/` (depuis le réseau local).

### Fonctionnement

Votre serveur est monté en **lecture seule** (`/:/host:ro`) : vous partagez n'importe
quel fichier par son vrai chemin, sans copie. Les fichiers reçus vont dans le dossier
monté sur `/Direct-Xfer`. Types de liens : `…/s/<token>` (partage), `…/u/<token>`
(réception), `…/c/<token>` (collaboration), `…/i/<token>` (image directe) ; l'appli
compagnon installable est à `…/app`. Le domaine des liens se règle dans l'interface.

### Fonctionnalités

- **Partage** — un fichier ou un dossier (navigable + `.zip`). Chaque lien est
  **modifiable en place** (expiration, mot de passe, quota, débit, nom, options — même
  URL), peut être **à usage unique** (révoqué après le 1er téléchargement complet),
  limité à un **nombre max de visiteurs uniques**, **mis en pause/réactivé** ou **cloné**
  en un clic, **envoyé par e-mail** (SMTP), avec **mot de passe** + **QR code** en option.
- **Téléchargements avec reprise** — les fichiers partagés ordinaires et les fichiers
  récupérés dans la PWA sont reçus par plages d’octets vérifiées et conservés dans le
  stockage du navigateur. Fermer l’onglet, le navigateur ou la PWA installée ne perd
  plus les morceaux terminés ; ETag/If-Range détecte un fichier remplacé avant reprise.
- **Sous-liens nominatifs** — un lien par destinataire (token propre) avec **accusés de
  réception** (vu/téléchargé par personne) ; en supprimer un révoque ce seul accès.
- **Réception** (`…/u/`) — envois multiples, **par morceaux avec reprise** (une coupure
  ou un rechargement reprend où ça s'est arrêté), requêtes bornées (compatibles avec les
  limites d'un reverse-proxy), **sous-dossiers par expéditeur** et **modération** en option.
- **Collaboration** (`…/c/`) — un dossier bidirectionnel : le visiteur parcourt/télécharge
  le contenu en direct **et** dépose ; la suppression par le visiteur est activable au cas par cas.
- **Photos** (`…/i/`) — **liens d'image directs, sans page relais** : chaque photo a des
  URL **Pleine**, **Mini** et **Micro** qui ouvrent l'image elle-même (vrai Content-Type,
  cache long) — prêtes à intégrer ou hotlinker. Micro mesure exactement la moitié de Mini ;
  les deux variantes sont générées dans le navigateur, sans bibliothèque d'images côté serveur.
  Les copies Pleine et les variantes générées sont stockées dans le volume `Images` configurable.
  La galerie admin conserve les 50 dernières images révoquées dans un historique purgeable,
  avec leurs compteurs de vues et visiteurs Pleine, Mini et Micro.
- **Appli compagnon (PWA)** (`…/app`) — appli mobile « envoyer » installable, même
  origine : capturez une photo/document ou choisissez des fichiers, recevez des fichiers
  directement depuis la **feuille de partage** du système (Web Share Target), ajoutez des
  liens par **scan de QR**, déverrouillez les liens protégés, téléversez par morceaux avec
  reprise, hors ligne. Exige une **connexion admin** et un **contexte sécurisé** (HTTPS
  ou `localhost`) pour la caméra.
- **Gérer & trouver** — **barre d'utilisation** par carte, **tri/filtres**, **raccourcis
  clavier** (`N`/`R`/`C`, `/` filtre, `?` aide), un **résumé** (nombre / actifs / taille),
  une **note privée admin** par lien, une **recherche plein-texte** bornée, un **journal
  d'accès** par lien (qui/quand/d'où), le **renommage en ligne**, le **réordonnancement
  par glisser-déposer** d'une collection, un **avertissement de doublon**, l'**export de
  la liste** (CSV/JSON) et des **préréglages d'expiration** configurables.
- **Aperçu** — images, vidéo (MP4/WebM/OGV/MOV/**MKV**), audio, PDF, texte ; **Markdown**
  rendu, **code** coloré, **`.zip`** listé (noms+tailles, rien n'est extrait) ; servi en
  même origine sous CSP stricte (l'exécutable reste en téléchargement seul). Un dossier
  média ouvre un **lecteur playlist** (▶) avec sous-titres auto (`.vtt`/`.srt`).
- **Notifications** — **webhook** (Discord/Slack/ntfy), **e-mail (SMTP)** et **push
  navigateur (Web Push)** avec bascules par événement + boutons Tester, plus une **alerte
  d'expiration**, un **résumé périodique** et une **alerte « lien probablement fuité »**.
- **Chiffrement de bout en bout** (optionnel) — partages et liens de réception
  chiffrables dans le navigateur (WebCrypto, AES-GCM-256) ; le serveur ne détient que du
  texte chiffré opaque. Clé **dans le lien** (`#k=…`) ou **phrase secrète** ; contexte
  sécurisé requis. Les dépôts chiffrés arrivent en `.dxe`, déchiffrés depuis le menu admin.
- **Surnoms de clients** — nommez n'importe quelle IP de visiteur ; affiché partout.
- **Connecteurs de stockage** — imports et exports administrés via des destinations
  rclone SFTP, SMB, WebDAV, Google Drive, OneDrive, Dropbox et Box. Google Drive utilise
  maintenant une connexion standard au compte Google : cliquez sur **Connecter Google
  Drive**, choisissez le compte puis autorisez l’accès. Le broker OAuth public peut être
  déployé directement depuis **Configuration → Google Drive → OAuth broker → Configurer
  automatiquement**, sans fichiers sources, PowerShell, npm ni Wrangler. Un broker central
  déjà configuré reste réutilisable par toutes les instances. Les refresh tokens Google
  restent sur le broker central.
- **Liens de stockage web** — créez des partages cloud en lecture, des **liens de
  réception web** qui déposent les fichiers dans un dossier cloud choisi et des
  **liens de collaboration web** avec navigation, téléchargement, dépôt, création de
  dossiers et suppression visiteur optionnelle.
- **Protection destructive et preuves d’audit** — les rafales typiques de rançongiciel
  et suppressions massives suspendent le client et le lien inscriptible concerné. Le
  journal HMAC append-only s’exporte en preuve Ed25519 vérifiable hors ligne.

### Configuration (⚙ dans l'appli, sans redémarrage)

Valeurs par défaut des nouveaux liens ; **plafond de débit global** + **plafond par
plage horaire** ; **protection des téléchargements publics** (limite par IP + preuve-de-
travail auto-hébergée optionnelle) ; **sécurité** (verrouillage auto, blocage après
échecs, durée de session, longueur des jetons, avertissement HTTP, 2FA forcée, liste
blanche d'IP admin) ; **personnalisation** (nom, accent, **thème** des pages publiques
auto/clair/sombre, couleur mobile, favicon, langues, bannière de réception) ; **logo**,
**bannière de confidentialité** et **filigrane d'aperçu** ; **confidentialité**
(géolocalisation/anonymisation des IP, rétention de l'historique). **Sauvegarde** :
export/import des réglages + config des liens + journal d'audit, et une **sauvegarde
complète planifiée** (dossier local / WebDAV / S3) avec **restauration en un clic**,
chiffrée avec `DATA_KEY` si défini.

### Internet & reverse-proxy

Redirigez `55750/tcp`. Pour le **HTTPS**, placez un reverse-proxy devant et ajoutez
`TRUST_PROXY: "1"`. Pour exposer l'admin, restreignez-la avec `ADMIN_ALLOWED_IPS` (le
loopback est toujours autorisé ; sinon l'admin reste limitée au LAN). Si un lien de
réception passe par le proxy, désactivez-y la mise en tampon des requêtes (Nginx :
`proxy_request_buffering off;`) pour un suivi en temps réel. Sur **Unraid**, réglez
`PUID: "99"` / `PGID: "100"` pour la persistance des données.

### Installation PWA Android

Une installation Android complète exige une URL **HTTPS** avec certificat reconnu.
Avec **Cloudflare Access**, ajoutez une application/règle de chemin avec l’action
**Bypass** et le sélecteur **Everyone**, uniquement pour les ressources statiques
suivantes : `/direct-xfer-pwa-sw.js*`, `/direct-xfer-pwa*.webmanifest*`,
`/app/launch*`, `/app/icon*`, `/app/apple-touch-icon.png` et `/app/screenshot-*`.
Conservez `/app/`, `/app/login` et toutes les API `/app/*` sous l’authentification
Direct-Xfer. Chrome refuse un service worker qui traverse la moindre redirection HTTP,
même lorsque la réponse finale est `200 OK`.

### Sécurité

Hôte en lecture seule, admin par mot de passe + réseau local/liste blanche, tokens
aléatoires de 24 octets, anti-traversée de chemin & anti-bruteforce, conteneur non-root,
limite par IP + preuve-de-travail optionnelle (sans aucun tiers). Les mots de passe
admin et des liens ne sont conservés qu'en hachages scrypt salés ; `DATA_KEY` chiffre le
magasin de métadonnées au repos. L'analyse ClamAV optionnelle met les fichiers infectés
en quarantaine.

---

## Español

Comparte y recibe archivos desde tu servidor con un simple enlace, por HTTP o HTTPS
seguro. También **autoalojamiento de imágenes**: enlaces directos Completa/Mini/Micro
listos para incrustar o hacer hotlink. Interfaz web multilingüe (FR/EN/ES), admin con
contraseña restringida a la red local por defecto.

### Instalación

1. En `docker-compose.yml`, reemplaza `/PATH/TO/CONFIGURE` por la carpeta del host donde se escribirán los archivos recibidos.
2. `docker compose up -d --build`
3. Contraseña de administrador: se muestra en los registros de inicio (`docker compose logs`).
4. Abre `http://IP-DE-TU-SERVIDOR:55750/` (desde la red local).

### Cómo funciona

Tu servidor se monta en **solo lectura** (`/:/host:ro`): compartes cualquier archivo por
su ruta real, sin copia. Los archivos recibidos van a la carpeta montada en
`/Direct-Xfer`. Tipos de enlace: `…/s/<token>` (compartir), `…/u/<token>` (recepción),
`…/c/<token>` (colaboración), `…/i/<token>` (imagen directa); la app compañera instalable
está en `…/app`. El dominio de los enlaces se ajusta en la interfaz.

### Funciones

- **Compartir** — un archivo o carpeta (navegable + `.zip`). Cada enlace es **editable en
  el sitio** (caducidad, contraseña, cuota, velocidad, nombre, opciones — misma URL),
  puede ser de **un solo uso** (revocado tras la 1ª descarga completa), limitado a un
  **máximo de visitantes únicos**, **pausado/reanudado** o **clonado** con un clic,
  **enviado por correo** (SMTP), con **contraseña** + **código QR** opcionales.
- **Descargas reanudables** — los archivos compartidos normales y los recuperados desde
  la PWA se guardan por rangos verificados en el navegador. Cerrar la pestaña, el
  navegador o la PWA no elimina los fragmentos completados; ETag/If-Range detecta cambios.
- **Subenlaces nominativos** — un enlace por destinatario (token propio) con **acuses de
  recibo** (visto/descargado por persona); elimina uno para revocar solo ese acceso.
- **Recepción** (`…/u/`) — subidas múltiples, **por fragmentos y reanudables** (un corte
  o recarga continúa donde se detuvo), peticiones acotadas (compatibles con los límites de
  un proxy inverso), **subcarpetas por remitente** y **moderación** opcionales.
- **Colaboración** (`…/c/`) — una carpeta bidireccional: el visitante explora/descarga el
  contenido en vivo **y** sube; la eliminación por el visitante es opcional por enlace.
- **Fotos** (`…/i/`) — **enlaces de imagen directos, sin página intermedia**: cada foto
  tiene URL **Completa**, **Mini** y **Micro** que abren la imagen en sí (Content-Type real,
  caché largo) — listas para incrustar o hotlink. Micro mide exactamente la mitad de Mini;
  ambas variantes se generan en el navegador, sin biblioteca de imágenes en el servidor.
  Las copias Completas y las variantes generadas se guardan en el volumen `Images` configurable.
  La galería admin conserva las últimas 50 imágenes revocadas en un historial purgable,
  con sus contadores de vistas y visitantes Completa, Mini y Micro.
- **App compañera (PWA)** (`…/app`) — app móvil «enviar» instalable, mismo origen:
  captura una foto/documento o elige archivos, recibe archivos directamente desde la
  **hoja de compartir** del sistema (Web Share Target), añade enlaces por **escaneo de
  QR**, desbloquea enlaces protegidos, sube por fragmentos y reanudable, sin conexión.
  Requiere **inicio de sesión admin** y un **contexto seguro** (HTTPS o `localhost`) para la cámara.

- **Gestionar y buscar** — **barra de uso** por tarjeta, **orden/filtros**, **atajos de
  teclado** (`N`/`R`/`C`, `/` filtro, `?` ayuda), un **resumen** (número / activos /
  tamaño), una **nota privada de admin** por enlace, una **búsqueda de texto completo**
  acotada, un **registro de accesos** por enlace (quién/cuándo/dónde), **renombrado en
  línea**, **reordenar arrastrando** una colección, un **aviso de ruta duplicada**, la
  **exportación de la lista** (CSV/JSON) y **preajustes de caducidad** configurables.
- **Vista previa** — imágenes, vídeo (MP4/WebM/OGV/MOV/**MKV**), audio, PDF, texto;
  **Markdown** renderizado, **código** resaltado, **`.zip`** listado (nombres+tamaños,
  nada se extrae); servido en el mismo origen bajo CSP estricta (lo ejecutable solo se
  descarga). Una carpeta multimedia abre un **reproductor de lista** (▶) con subtítulos
  automáticos (`.vtt`/`.srt`).
- **Notificaciones** — **webhook** (Discord/Slack/ntfy), **correo (SMTP)** y **push del
  navegador (Web Push)** con conmutadores por evento + botones Probar, más un **aviso de
  caducidad**, un **resumen periódico** y una **alerta de «enlace posiblemente filtrado»**.
- **Cifrado de extremo a extremo** (opcional) — recursos y enlaces de recepción
  cifrables en el navegador (WebCrypto, AES-GCM-256); el servidor solo guarda texto
  cifrado opaco. Clave **en el enlace** (`#k=…`) o **frase de cifrado**; requiere contexto
  seguro. Los depósitos cifrados llegan como `.dxe`, descifrados desde el menú de admin.
- **Apodos de clientes** — nombra cualquier IP de visitante; se muestra donde aparezca.
- **Conectores de almacenamiento** — importación y exportación administradas mediante
  rclone: SFTP, SMB, WebDAV, Google Drive, OneDrive, Dropbox y Box. Para Google Drive,
  la conexión normal usa el broker OAuth central de Direct-Xfer: el usuario elige su cuenta
  Google y autoriza el acceso. El broker público puede desplegarse directamente desde
  **Configuración → Google Drive → OAuth broker → Configurar automáticamente**, sin archivos
  fuente, PowerShell, npm ni Wrangler. También puede reutilizarse un broker central ya
  configurado. Los refresh tokens de Google permanecen únicamente en el broker central.
- **Enlaces de almacenamiento web** — crea recursos cloud de solo lectura, **enlaces
  de recepción web** que depositan archivos en una carpeta cloud elegida y **enlaces de
  colaboración web** con navegación, descarga, subida, creación de carpetas y borrado
  opcional por visitantes.
- **Protección destructiva y pruebas de auditoría** — las ráfagas de ransomware y los
  borrados masivos suspenden al cliente y al enlace afectado. El diario HMAC append-only
  se puede exportar como prueba Ed25519 verificable sin conexión.

### Configuración (⚙ en la app, sin reinicio)

Valores por defecto de los nuevos enlaces; **límite de descarga global** + **límite por
franja horaria**; **protección de descargas públicas** (límite por IP + prueba de trabajo
autoalojada opcional); **seguridad** (bloqueo automático, bloqueo por intentos, duración
de sesión, longitud de tokens, aviso HTTP, 2FA forzada, lista blanca de IP admin);
**personalización** (nombre, acento, **tema** de las páginas públicas auto/claro/oscuro,
color móvil, favicon, idiomas, banner de recepción); **logotipo**, **aviso de
confidencialidad** y **marca de agua**; **privacidad** (geolocalización/anonimización de
IP, retención del historial). **Copia de seguridad**: exportar/importar ajustes + config
de enlaces + registro de auditoría, y una **copia completa programada** (carpeta local /
WebDAV / S3) con **restauración en un clic**, cifrada con `DATA_KEY` si se define.

### Internet y proxy inverso

Redirige `55750/tcp`. Para **HTTPS**, coloca un proxy inverso delante y añade
`TRUST_PROXY: "1"`. Para exponer la admin, restríngela con `ADMIN_ALLOWED_IPS` (el
loopback siempre se permite; si no, la admin sigue limitada a la LAN). Si un enlace de
recepción pasa por el proxy, desactiva ahí el búfer de solicitudes (Nginx:
`proxy_request_buffering off;`) para un seguimiento en tiempo real. En **Unraid**,
configura `PUID: "99"` / `PGID: "100"` para la persistencia de datos.

### Seguridad

Host en solo lectura, admin con contraseña + red local/lista blanca, tokens aleatorios de
24 bytes, protección contra travesía de rutas y fuerza bruta, contenedor sin root, límite
por IP + prueba de trabajo opcional (sin terceros). Las contraseñas de admin y de enlaces
solo se guardan como hashes scrypt con sal; `DATA_KEY` cifra el almacén de metadatos en
reposo. El análisis ClamAV opcional pone en cuarentena los archivos infectados.

---

## Docker Compose

```yaml
services:
  direct-xfer:
    image: manixqc/direct-xfer:latest
    container_name: direct-xfer
    restart: on-failure
    # Unraid: show the logo + a clickable "WebUI" link (Docker tab). [IP] and
    # [PORT:55750] are substituted by Unraid. Use https:// if you enable TLS_* below.
    labels:
      net.unraid.docker.webui: "http://[IP]:[PORT:55750]/"
      net.unraid.docker.icon: "https://raw.githubusercontent.com/ManixQC/Direct-Xfer/refs/heads/main/unraid/direct-xfer.png"
    ports:
      - "${DX_PORT:-55750}:${DX_PORT:-55750}"
    environment:
      PORT: "${DX_PORT:-55750}"
      IMAGES_DIR: "/Images"
      # See the table below for every variable. Common ones (uncomment as needed):
      # PUID: "99"                 # Unraid appdata owner (with PGID: "100")
      # PGID: "100"
      # LOCAL_IP: "192.168.50.11"  # host LAN IP to display (not detectable behind the bridge)
      # ADMIN_ALLOW_ANY: "true"    # admin outside the local network
      # ADMIN_ALLOWED_IPS: "203.0.113.5, 198.51.100.0/24"
      # TRUST_PROXY: "1"           # behind a reverse proxy (evaluate the real visitor IP)
      # PUBLIC_URL: "https://your-domain.example"   # REQUIRED behind an HTTPS reverse proxy
      #                            # (the origin the PWA may POST to). Without it (and TRUST_PROXY),
      #                            # creating a reception link fails with 403 invalid-origin.
      # DATA_KEY: "a-long-random-secret"   # encrypt shares.json at rest (keep it SAFE & STABLE)
      # TLS_SELF_SIGNED: "true"    # native HTTPS on PORT (or TLS_CERT / TLS_KEY)
      # SMTP_URL: "smtps://user:pass@smtp.example.com:465"
      # EMAIL_FROM: "direct-xfer@example.com"
      # EMAIL_TO: "me@example.com"
      # CLAMAV_HOST: "clamav"      # antivirus scan (see the optional service below)
      # CLAMAV_PORT: "3310"
    volumes:
      - /:/host:ro         # your files (the whole server), read-only
      - ./data:/data       # generated shares + password + journal
      # ⬇ Self-hosted images — replace with a WRITABLE host folder (no :ro).
      - /PATH/TO/CONFIGURE:/Images
      # ⬇ Files RECEIVED via reception links — replace with a WRITABLE host folder (no :ro).
      - /PATH/TO/CONFIGURE:/Direct-Xfer

  # Optional on-access antivirus. Uncomment this AND CLAMAV_HOST above. First start
  # downloads the virus database (a few minutes); self-hosted, no third party.
  # clamav:
  #   image: clamav/clamav:latest
  #   container_name: direct-xfer-clamav
  #   restart: on-failure
  #   volumes:
  #     - ./clamav:/var/lib/clamav   # persist the virus database across restarts
```

### Environment variables

All optional; everything except the paths can also be set from the in-app **Configuration**
window. (Shared reference — variable names are identical in every language.)

| Variable | Default | Purpose |
|---|---|---|
| `DX_PORT` | `55750` | Host + container port. |
| `IMAGES_DIR` | `/Images` in Docker | Container path of the managed image store (Full, Mini, Micro, history). Mount a writable host folder here — see the Volumes table. |
| `ADMIN_PASSWORD` | *(generated)* | Owner password. If unset, a random one is printed at first launch. |
| `ADMIN_USERNAME` | `admin` | Owner account name. |
| `PUID` / `PGID` | `1000` | User/group the container runs as (to write `/data`, `/Images` + the reception folder). Unraid: `99`/`100`. |
| `LOCAL_IP` | *(auto)* | Your server's LAN IP for the "Local IP" display (behind Docker's bridge). |
| `ADMIN_ALLOW_ANY` | `false` | Allow the admin UI from any network (default: local network only). |
| `ADMIN_ALLOWED_IPS` | *(empty)* | Allowlist of IPs/CIDRs that may reach the admin (loopback always allowed). |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` (set behind a reverse proxy for the real visitor IP). |
| `PUBLIC_URL` / `PUBLIC_HOST` | *(auto)* | Base URL/host used to build share links. |
| `DATA_KEY` | *(empty)* | Encrypt sensitive persistent metadata at rest (AES-256-GCM): `shares.json`, the universal search index and the OCR cache. Keep it **safe & stable** — if lost/changed the main store can't be read and the container won't start. It is also used to derive the audit-chain HMAC key unless `AUDIT_HMAC_KEY` is set. |
| `AUDIT_HMAC_KEY` | *(empty)* | Optional dedicated secret for the tamper-evident audit chain. Prefer a long stable secret supplied outside `/data`; if omitted, `DATA_KEY` is used, then a local 0600 key file as fallback. **Safe automatic migration:** when `AUDIT_HMAC_KEY` is added to an existing installation, Direct-Xfer first verifies the complete journal with the key that previously protected it (`DATA_KEY`, or `/data/audit-chain.key` when no data key was configured), transactionally re-signs it with the external key, verifies it again, records `audit-key-migrated`, then retires any stale local key. A damaged chain is never migrated. Keep the new secret stable after migration. |
| `AUDIT_SIGNING_PRIVATE_KEY` / `AUDIT_SIGNING_PRIVATE_KEY_FILE` | generated under `/data` | Stable Ed25519 private key (PEM text or file) used for signed audit-proof exports. For stronger separation, mount the file read-only from a secrets store outside `/data`; keep it secret and back it up. |
| `RCLONE_CONFIG` / `RCLONE_BIN` | `/data/rclone/rclone.conf` / `rclone` | Protected rclone configuration and executable used by SFTP/SMB/WebDAV/cloud storage connectors. |
| `DIRECT_XFER_OAUTH_BROKER_URL` | *(empty)* | Optional environment-managed URL of the central Direct-Xfer OAuth Broker, for example `https://oauth.example.com`. Since 1.67.29 the same URL can instead be saved from **Configuration → Google Drive → OAuth broker**; the environment variable, when set, overrides and locks the UI value. The broker is preferred but Direct-Xfer can fall back to a local Web profile, or to local rclone OAuth when the browser runs on the Direct-Xfer host. |
| `DIRECT_XFER_GOOGLE_WEB_CLIENT_ID` / `DIRECT_XFER_GOOGLE_WEB_CLIENT_SECRET` | *(empty)* | Advanced local fallback only. Not required when `DIRECT_XFER_OAUTH_BROKER_URL` is configured. |
| `DIRECT_XFER_GOOGLE_OAUTH_CLIENT_ID` / `DIRECT_XFER_GOOGLE_OAUTH_CLIENT_SECRET` | *(empty)* | Legacy/custom **Desktop** OAuth credentials kept for compatibility with the older rclone loopback flow and advanced use. They are not used by the new automatic Google web callback. `RCLONE_DRIVE_CLIENT_ID` / `RCLONE_DRIVE_CLIENT_SECRET` remain accepted for that legacy path. |
| `CONNECTOR_IMPORT_DIR` | `/Direct-Xfer/Imports` | Confined writable destination for connector imports. Imports never overwrite an existing file. |
| `MAX_ACTIVE_CONNECTOR_JOBS` | `4` | Maximum simultaneous connector import/export processes. |
| `SEARCH_INDEX_MAX_DOCS` | `250000` | Maximum number of files kept in the persistent universal-search index. Raise carefully because postings and metadata are also held in memory. |
| `SEARCH_OCR_ENABLED` | `true` *(Docker)* / `false` until activation *(Windows host)* | Enable server-side OCR in the full Direct-Xfer universal index for supported images and scanned PDFs. Docker includes Tesseract + Poppler. The Windows installer keeps Tesseract optional and enables its private OCR engine only after the user activates the component; scanned-PDF OCR still requires Poppler (`pdftoppm`) to be available. |
| `SEARCH_OCR_LANGS` | `fra+eng` | Tesseract language set used by server OCR. Docker includes `fra`, `eng` and `spa`; the optional Windows Tesseract activation downloads those three models. A private Windows component that cannot satisfy the requested language set is not selected. |
| `SEARCH_OCR_TESSERACT_BIN` | `tesseract` | Optional Tesseract executable override. On Windows, an explicitly supplied value wins over the on-demand Direct-Xfer component. |
| `TESSDATA_PREFIX` | *(auto)* | Optional Tesseract data-root override. When the on-demand Windows component is active and this variable is not overridden, Direct-Xfer uses its per-user `tools\tesseract\5.5.3\tessdata` directory and passes `--tessdata-dir` explicitly. |
| `SEARCH_OCR_PDFTOTEXT_BIN` / `SEARCH_OCR_PDFTOPPM_BIN` | `pdftotext` / `pdftoppm` | Optional Poppler executable overrides for PDF text extraction and rasterization. Poppler is still external on Windows. |
| `SEARCH_OCR_BATCH` | `100` | Maximum number of previously uncached OCR files processed in one index rebuild. Cached files do not count; deferred files are picked up by later rebuilds. |
| `SEARCH_OCR_PDF_MAX_PAGES` | `12` | Maximum PDF pages rasterized for OCR when no usable text layer exists. |
| `SEARCH_OCR_IMAGE_MAX_MB` / `SEARCH_OCR_PDF_MAX_MB` | `50` / `100` | Safety caps for files sent to the server OCR pipeline. |
| `TLS_SELF_SIGNED` | `false` | Legacy environment switch for the managed **Direct-Xfer Local CA** HTTPS mode. When enabled, Direct-Xfer creates a stable private root CA under `/data/tls` and signs the LAN server certificate from it. Install the exported root `.cer` once on each trusted LAN device to remove browser warnings. When this variable is absent, use **Configuration → Security**. |
| `TLS_CERT` / `TLS_KEY` | *(empty)* | Paths to a PEM cert + key to serve HTTPS (takes precedence over `TLS_SELF_SIGNED`). |
| `SMTP_URL` | *(empty)* | SMTP transport for e-mail notifications (e.g. `smtps://user:pass@host:465`). Overrides the in-app fields. |
| `EMAIL_FROM` / `EMAIL_TO` | *(empty)* | Default sender / recipient for e-mail notifications. |
| `WEBHOOK_URL` / `WEBHOOK_FORMAT` | *(empty)* | Webhook for notifications (Discord / Slack / ntfy / JSON). Overrides the in-app fields. |
| `CLAMAV_HOST` / `CLAMAV_PORT` | *(empty)* / `3310` | Antivirus scan of received files via a clamd daemon; infected uploads are quarantined and never delivered. |
| `SESSION_TTL_HOURS` | `8` | Admin session lifetime (also settable in-app). |
| `MAX_UPLOAD_BYTES` / `MAX_ZIP_BYTES` | `10 GiB` / `20 GiB` | Hard caps for a received file / generated ZIP. Set either to `0` to disable that cap; also configurable in-app. |
| `MAX_CONCURRENT_UPLOADS` / `MAX_CONCURRENT_ZIPS` | `8` / `2` | Global concurrency guards for anonymous upload requests and ZIP generation. |
| `UPLOAD_IDLE_TIMEOUT_SECONDS` | `120` | Abort an upload request that stops sending data for this many seconds (minimum 15). |
| `MAX_LOG_BYTES` | `8 MB` | Soft cap on the transfer journal; trimmed to the tail on startup. |
| `UPDATE_CHECK` | `true` | Check for a newer image version at startup (also toggleable in-app). |
| `PUBLIC_IP_DISCOVERY` | `true` | Detect the public IP through documented public-IP services. Set `false` to prevent those requests; also toggleable in-app unless the environment forces it off. |

> **Migrating the audit key:** on an installation that currently shows an `Audit log key` warning, add a stable `AUDIT_HMAC_KEY` environment variable and recreate/restart the container. No manual copy of `audit-chain.key` is required. Direct-Xfer keeps temporary pre-migration backups only during the transaction, validates both the old and new chains, and removes the local key only after success. If integrity is already broken, migration is refused and the local key is preserved for investigation.


### Volumes

| Mount | Purpose |
|---|---|
| `/:/host:ro` | Your files, mounted **read-only** — ordinary file shares reference host paths directly; image links make a managed copy. |
| `./data:/data` | Persistent store: `shares.json`, generated password, transfer journal, encrypted blobs, secrets, quarantine. |
| `/PATH/TO/CONFIGURE:/Images` | **Writable** self-hosted image store: `Full/`, `Mini/`, `Micro/`, and `History/`. |
| `/PATH/TO/CONFIGURE:/Direct-Xfer` | **Writable** destination for files received via reception & collaboration links. |
| `./clamav:/var/lib/clamav` | *(optional)* Persists the ClamAV virus database across restarts. |

Back up the images folder (`/Images`) separately: scheduled `.dxbackup` files contain
metadata, not the managed image binaries.

Back up `/data/rclone/rclone.conf`, `/data/audit-signing-private.pem` and the other
`/data` contents as secrets. A signed proof stays verifiable without the private key,
but authenticity requires retaining/pinning its public-key fingerprint independently.
For protection against an attacker limited to the application data volume, provide both
`AUDIT_HMAC_KEY` and a read-only `AUDIT_SIGNING_PRIVATE_KEY_FILE` outside that volume.


## Unraid Docker icon

Direct-Xfer supplies both forms of Unraid integration:

- `docker-compose.yml` declares `net.unraid.docker.icon` for **Compose Manager**.
- `unraid/direct-xfer.xml` declares `<Icon>` for **Docker → Add Container**.
- `unraid/direct-xfer.png` is a real PNG file and is published through a direct
  `raw.githubusercontent.com` URL. Do not replace it with the application SVG: some
  Unraid versions display a question-mark fallback for SVG/WebP container icons.

After adding or changing the icon metadata, the container must be recreated because
Docker labels are immutable:

```bash
docker compose up -d --force-recreate direct-xfer
docker inspect direct-xfer --format '{{ index .Config.Labels "net.unraid.docker.icon" }}'
```

For a container managed by Unraid's standard form, enable **Advanced View**, paste this
value into **Icon URL**, then click **Apply**:

```text
https://raw.githubusercontent.com/ManixQC/Direct-Xfer/refs/heads/main/unraid/direct-xfer.png
```

If an old missing icon remains cached, use the supplied XML template or remove and
re-add the container from its saved template. Application data remains in the mapped
`/data` and `/Direct-Xfer` host folders.
