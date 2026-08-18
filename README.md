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

---

## English

Share and receive files from your server through a simple link, over HTTP or secure
HTTPS. **Image self-hosting** too: direct Full/Mini/Micro links ready to embed or hotlink.
Multilingual web UI (FR/EN/ES), password-protected admin restricted to the local
network by default.

### Install

1. In `docker-compose.yml`, replace `/PATH/TO/CONFIGURE` with the host folder where received files should be written.
2. `docker compose up -d --build`
3. Admin password: `cat ./data/admin-password.txt`
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
  SFTP, SMB, WebDAV, Google Drive, OneDrive, Dropbox and Box. Credentials remain in
  the protected rclone configuration, outside Direct-Xfer metadata and browser APIs.
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
3. Mot de passe admin : `cat ./data/admin-password.txt`
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
  rclone SFTP, SMB, WebDAV, Google Drive, OneDrive, Dropbox et Box. Les identifiants
  restent dans la configuration rclone protégée, hors des métadonnées et du navigateur.
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
3. Contraseña de administrador: `cat ./data/admin-password.txt`
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
  rclone: SFTP, SMB, WebDAV, Google Drive, OneDrive, Dropbox y Box. Las credenciales no
  entran en los metadatos de Direct-Xfer ni en el navegador.
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
| `AUDIT_HMAC_KEY` | *(empty)* | Optional dedicated secret for the tamper-evident audit chain. Prefer a long stable secret supplied outside `/data`; if omitted, `DATA_KEY` is used, then a local 0600 key file as fallback. **Safe automatic migration:** when an existing installation still uses `/data/audit-chain.key`, adding `AUDIT_HMAC_KEY` causes Direct-Xfer to verify the complete old chain first, transactionally re-sign it with the external key, verify it again, record `audit-key-migrated`, then retire the local key. A damaged chain is never migrated. Keep the new secret stable after migration. |
| `AUDIT_SIGNING_PRIVATE_KEY` / `AUDIT_SIGNING_PRIVATE_KEY_FILE` | generated under `/data` | Stable Ed25519 private key (PEM text or file) used for signed audit-proof exports. For stronger separation, mount the file read-only from a secrets store outside `/data`; keep it secret and back it up. |
| `RCLONE_CONFIG` / `RCLONE_BIN` | `/data/rclone/rclone.conf` / `rclone` | Protected rclone configuration and executable used by SFTP/SMB/WebDAV/cloud storage connectors. |
| `CONNECTOR_IMPORT_DIR` | `/Direct-Xfer/Imports` | Confined writable destination for connector imports. Imports never overwrite an existing file. |
| `MAX_ACTIVE_CONNECTOR_JOBS` | `4` | Maximum simultaneous connector import/export processes. |
| `SEARCH_INDEX_MAX_DOCS` | `250000` | Maximum number of files kept in the persistent universal-search index. Raise carefully because postings and metadata are also held in memory. |
| `SEARCH_OCR_ENABLED` | `true` | Enable server-side OCR in the full Direct-Xfer universal index for supported images and scanned PDFs. Docker includes Tesseract + Poppler. The Windows package now bundles Tesseract x64 with `fra`, `eng` and `spa`; scanned-PDF OCR still requires Poppler (`pdftoppm`) to be available. |
| `SEARCH_OCR_LANGS` | `fra+eng` | Tesseract language set used by the server OCR (`fra`, `eng`, `spa` are bundled in Docker and in the Windows package). |
| `SEARCH_OCR_TESSERACT_BIN` | `tesseract` *(auto-bundled on Windows)* | Optional Tesseract executable override. The Windows package automatically uses its validated bundled x64 binary unless this variable is explicitly set. |
| `TESSDATA_PREFIX` | *(auto)* | Optional Tesseract data-root override. The Windows package points this to its bundled `tessdata` parent when the bundled engine is selected. |
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





## 1.57.4 — HTTPS LAN avec autorité locale de confiance

- Remplace l’option auto-signée de l’interface par **« Activer HTTPS avec une autorité locale Direct-Xfer (LAN uniquement) »**.
- Direct-Xfer crée une **CA racine locale stable** une seule fois (`data/tls/local-ca-cert.pem` + `local-ca-key.pem`) puis émet un certificat serveur séparé (`server-cert.pem` + `server-key.pem`).
- Le certificat serveur contient automatiquement `localhost`, le nom de la machine et les IP privées/loopback détectées ; un changement d’IP LAN peut régénérer le certificat serveur **sans changer la CA racine déjà approuvée**.
- La configuration affiche l’**empreinte SHA-256** de la CA et fournit un bouton pour télécharger `Direct-Xfer-Local-CA.cer`.
- Après installation de cette racine dans le magasin de confiance de chaque appareil du LAN, les navigateurs ne doivent plus afficher d’avertissement tant que l’URL utilise un nom/IP présent dans le certificat.
- Les IP publiques ne sont jamais ajoutées automatiquement au certificat de ce mode : il est conçu uniquement pour le réseau local.
- Une CA existante corrompue ou proche de l’expiration n’est **jamais remplacée silencieusement**, afin de ne pas casser la confiance installée sur les appareils.
- `TLS_CERT`/`TLS_KEY` gardent la priorité ; `TLS_SELF_SIGNED=true` reste accepté comme alias d’environnement historique pour le mode CA locale.
- Bump **1.57.4**, PWA **pwa273**, ressources **v259**.

### Audit TLS/CA approfondi (1.57.4)

- Renforce le profil X.509 : racine RSA-3072 / SHA-256 avec `pathLen=0`, certificats serveur RSA-2048 d’environ 90 jours, SAN exacts, EKU serveur et Authority Key Identifier.
- Renouvelle automatiquement le certificat serveur et ses SAN quand les interfaces/IP LAN changent, sans remplacer la racine déjà approuvée ; les IPv6 sont normalisées pour éviter les rotations inutiles.
- Force TLS 1.2 minimum et recharge à chaud les certificats fournis par `TLS_CERT`/`TLS_KEY`, y compris lorsqu’une chaîne intermédiaire change sans modifier la feuille.
- Rend la création initiale de la CA et la restauration de `data/tls` résistantes aux crashs grâce à des transactions durables et à une récupération au redémarrage.
- Une sauvegarde complète ne contient la clé privée de la CA que lorsque le bundle est chiffré par `DATA_KEY`; une sauvegarde non chiffrée n’exporte jamais cette clé.
- Le téléchargement initial de la racine est disponible sans authentification sur `/direct-xfer-local-ca.cer` uniquement via HTTPS natif ou depuis la boucle locale ; l’empreinte SHA-256 doit être comparée avant installation.
- En mode CA locale, Direct-Xfer envoie `Strict-Transport-Security: max-age=0` pour supprimer une ancienne politique HSTS qui pourrait empêcher un retour volontaire à HTTP.
- Si la clé de signature de la CA est perdue mais qu’un certificat serveur encore valide subsiste, HTTPS reste disponible en mode dégradé et l’interface avertit que le renouvellement est impossible.


## 1.57.3 — HTTPS natif configurable

- Ajoute dans **Configuration → Sécurité** l’option **« Activer HTTPS avec un certificat auto-signé »**.
- Le certificat et sa clé sont générés localement sous le dossier de données (`tls/cert.pem` et `tls/key.pem`) puis réutilisés jusqu’à leur renouvellement.
- Le changement HTTP/HTTPS est appliqué au **prochain redémarrage** afin de ne pas interrompre une sauvegarde de configuration en cours.
- Le portable Windows détecte automatiquement si le serveur redémarré écoute en HTTP ou HTTPS ; ses sondes privées, la réinitialisation admin et l’arrêt gracieux restent fonctionnels avec le certificat auto-signé.
- `TLS_CERT`/`TLS_KEY` et `TLS_SELF_SIGNED` restent prioritaires lorsqu’ils sont définis dans l’environnement.
- Un certificat auto-signé doit être explicitement approuvé sur l’appareil pour supprimer l’avertissement navigateur et pour les fonctions PWA qui exigent un contexte HTTPS de confiance.
- Bump **1.57.3**, PWA **pwa272**, ressources **v258**.

## 1.57.2 — Portable Windows : port + réinitialisation admin

- Conserve la libération vérifiée du port TCP à la fermeture du portable Windows.
- Ajoute « Réinitialiser le mot de passe admin… » au menu systray avec ticket local éphémère à usage unique.
- Invalide les sessions du propriétaire après réinitialisation sans modifier les partages, statistiques ou réglages.
- Synchronise la PWA sur **pwa271** et les ressources sur **v257**.

## 1.57.1 — Audit approfondi des ajouts récents

- Validation renforcée de la règle Windows Defender Firewall du portable : Direct-Xfer vérifie maintenant qu’elle est réellement activée, entrante, en TCP, sur le bon port et limitée à `LocalSubnet`.
- Une règle Direct-Xfer périmée ou incorrecte est remplacée proprement au lieu d’être acceptée uniquement parce que son nom existe.
- Tests de reprise de téléchargement réalignés sur le protocole sécurisé `X-Direct-Xfer-Resume-Id`, sans réintroduire le contournement de quota par un simple en-tête `Range`.
- Test d’export d’audit corrigé pour tenir compte de l’événement `audit-exported` inclus volontairement dans l’instantané exporté.
- Cache PWA **pwa270**, ressources **v256**.

## 1.57.0 — Stabilisation et nouveau jalon de version

- Bump de Direct-Xfer vers **1.57.0** sans changement fonctionnel supplémentaire.
- Cache PWA **pwa269**, ressources **v255** pour forcer le rafraîchissement des installations existantes.
- Inclut les derniers correctifs de sélection Shift+clic, traductions Activité/logs et accès réseau du portable Windows.

## 1.56.0 — Historique d’actions fusionné dans Activité

- L’**Historique d’actions / Undo** revient dans la vue standard, sans recréer de carte ni de modale séparée.
- Les actions réversibles enrichissent directement les lignes correspondantes de l’onglet **Activité**, avec leur état et un bouton **Annuler** lorsqu’elles sont encore réversibles.
- Si l’événement Activité d’origine n’est plus dans la fenêtre retenue, une ligne d’action synthétique est insérée à sa position chronologique afin de ne pas perdre l’historique Undo.
- Les filtres, la recherche et l’ordre chronologique de l’onglet Activité s’appliquent aussi aux actions Undo.
- Version **1.56.0**, cache PWA **pwa267**, ressources **v253**.

## 1.55.3 — retrait de l’historique d’actions de la vue standard

- La section visible **Historique d’actions** a été retirée de l’interface standard, ainsi que sa modale standard associée.
- Le moteur Undo, son historique persistant et l’interface PWA restent disponibles et inchangés.
- Version **1.55.3**, cache PWA **pwa265**, ressources **v251**.

## 1.55.2 — modale « Créer un partage » responsive

- La modale standard **Créer un partage** est maintenant limitée à la hauteur de la fenêtre et son contenu central défile indépendamment.
- Les boutons **Annuler / Partager** restent toujours accessibles dans un pied de modale fixe, même sur les écrans courts.
- La zone de sélection des fichiers/dossiers a été nettement agrandie pour faciliter la navigation.
- Mise en page responsive renforcée sur mobile et sur les écrans à faible hauteur.
- Version **1.55.2**, cache PWA **pwa264**, ressources **v250**.

## 1.55.1 — audit ultra approfondi des ajouts 1.55.x

- Durcissement DLP : une analyse incomplète applique la réaction la plus stricte entre la règle de gravité et la politique de secours; les erreurs de lecture ne sont plus ignorées.
- Quarantaine rendue transactionnelle et sûre : rollback sur erreur de persistance, nettoyage des orphelins, réconciliation au démarrage et protection contre toute injection de chemin de fichier.
- La quarantaine physique n’accepte que des fichiers réguliers fraîchement stockés dans `Images/Full`; les requêtes clientes ne peuvent plus fournir de chemin interne.
- Déduplication SHA-256 étendue à la corbeille, courses concurrentes verrouillées et DLP évalué avant la réponse de doublon.
- Aperçus texte/code alignés (`.cfg` inclus), indication des aperçus tronqués et identité de reprise média renforcée.
- Reprise audio/vidéo corrigée lors d’un retour au début, d’une lecture presque terminée, d’un état corrompu et des changements de piste.
- Réactions DLP de la PWA alignées sur le serveur, y compris Quarantaine pour les analyses incomplètes; messages d’erreur DLP plus précis.
- Version **1.55.1**, cache PWA **pwa263**, ressources **v249**.

## 1.55.0 — aperçus multimédias, DLP automatisé et déduplication renforcée

- Prévisualisation intégrée des **PDF**, fichiers **texte/code** et fichiers **audio**, dans l’administration et les parcours compatibles de la PWA.
- Lecteurs audio/vidéo avec **reprise automatique de lecture** persistante et expiration prudente des positions anciennes.
- Règles DLP automatiques par gravité (**faible / moyenne / élevée / critique**) avec actions **Journaliser, Avertir, Quarantaine ou Bloquer**.
- La **PWA** permet maintenant de modifier ces réactions automatiques directement dans Réglages; le cache de politique conserve correctement `rulesEnabled`, les quatre actions et le mode Quarantaine.
- Quarantaine DLP persistante, consultable et supprimable depuis Configuration, avec déplacement sûr des fichiers gérés même lorsque le stockage Images et DATA_DIR sont sur des volumes distincts.
- Détection SHA-256 des doublons renforcée pour les images gérées (standard + PWA + remplacement + sélection serveur), en complément de la déduplication déjà présente sur les réceptions. Les uploads identiques concurrents sont sérialisés pour éviter les courses.
- Les anciens médias gérés sans empreinte SHA-256 sont hachés à la demande afin de conserver la compatibilité avec les versions précédentes.
- Version **1.55.0**, cache PWA **pwa262**, ressources **v248**.

## 1.54.0 — productivité, recherche et supervision

- Cartes de partage enrichies : copie d’URL immédiatement visible, dates relatives dans Activité, nombre de fichiers, taille totale, « Jamais téléchargé », protection par mot de passe et expiration imminente.
- Activité : filtres Images/PWA/partage, masquage du système routinier et recherche plein texte dans les détails.
- Organisation : épingles/favoris et notes privées administrateur disponibles dans les flux de gestion standard et PWA.
- Recherche universelle étendue aux partages, images, réceptions, activité/journaux et contenu indexé.
- Configuration : confirmation facultative avant révocation, politique globale « nouveaux liens sans expiration » et seuil configurable d’espace disque libre.
- Dashboard/corbeille : espace disque disponible, alertes de capacité, compteur de corbeille et restauration multi-sélection.
- PWA : icônes de plateforme et version/build observé pour chaque appareil appairé, métriques récursives de dossiers et lien créé avec copie explicite.
- Version **1.54.0**, cache PWA **pwa260**, ressources **v246**.

## 1.53.4 — parité Activité standard / PWA (build pwa259)

- L’onglet **Activité** de la PWA utilise désormais le même périmètre que l’onglet Activité standard pour les appareils appairés par un propriétaire/administrateur : mêmes événements persistants, même limite de 1 000 lignes et même rétention serveur.
- L’affichage PWA est aligné sur la version standard : mêmes groupes **Transferts / Administration / Sécurité / Visiteurs / Système**, même recherche, mêmes champs et même ordre des métadonnées.
- L’ancien historique local des transferts de l’appareil est déplacé vers **Envoyer** afin que l’onglet Activité ne mélange plus deux historiques différents.
- L’onglet Activité PWA se rafraîchit périodiquement lorsqu’il est visible, en plus du chargement à l’ouverture et du rafraîchissement manuel.
- Version **1.53.4**, cache PWA **pwa259**, ressources **v245**.

## 1.53.2 — activité moins bruyante + navigation PWA épurée (build pwa258)

- Les événements techniques **`push-subscribed`** restent dans le journal d’audit inviolable, mais sont exclus de l’historique **Activité**, y compris les anciennes entrées persistées lors d’une mise à niveau.
- Suppression complète de la bulle/compteur sur l’onglet **Activité** de la PWA; les autres badges de navigation restent inchangés.
- Version **1.53.2**, cache PWA **pwa258**, ressources **v244**.

## 1.53.1 — onglet Activité standard + activité serveur dans la PWA (build pwa257)

- La carte **Activité** a été retirée du tableau principal standard et remplacée par un **onglet/page Activité** accessible depuis un bouton dédié dans la topbar. La page est disponible à `/activity`, fonctionne avec Retour/Forward et peut être rechargée directement.
- La page Activité standard conserve la recherche, les filtres, le compteur, le rafraîchissement et le flux temps réel SSE, mais peut maintenant afficher jusqu’à 1 000 événements chargés au lieu d’un simple aperçu de 30 lignes.
- Dans la PWA, l’onglet **Activité** consulte désormais le véritable historique persistant du serveur via `/app/activity/recent`; l’ancien historique local des transferts reste présent séparément.
- Une révocation/suppression d’image depuis la PWA apparaît donc dans Activité dès que le serveur confirme l’opération; l’historique est aussi rechargé à l’ouverture de l’onglet et via un bouton de rafraîchissement.
- Les appareils PWA appairés ne reçoivent pas des événements administratifs sans rapport : l’API limite les événements aux éléments que l’appareil peut gérer, tandis qu’une session owner/admin/auditor peut consulter l’historique complet.
- Version **1.53.1**, cache PWA **pwa257**, ressources **v243**.


## 1.53.0 — section Activité dans la version standard (build pwa256)

- La version standard dispose maintenant d’une section **Activité** visible directement sur le tableau principal, alimentée par le même historique persistant que la vue complète.
- La section affiche les événements récents en temps réel, le nombre d’événements retenus, une recherche plein texte et des filtres Transferts / Administration / Sécurité / Visiteurs / Système.
- Le bouton **Ouvrir l’historique complet** conserve la vue détaillée existante; les deux vues partagent le même flux SSE et évitent les connexions en double.
- L’historique est chargé à la connexion puis maintenu en direct; il est vidé côté client lors d’une déconnexion/changement de compte pour éviter toute fuite entre sessions.
- Accès cohérent avec le journal d’audit : propriétaires, administrateurs et auditeurs peuvent consulter Activité; les opérateurs n’y ont pas accès.
- Version **1.53.0**, cache PWA **pwa256**, ressources **v242**.

## 1.52.2 — connexions administrateur sur appareils reconnus (build pwa255)

- Les reconnexions administrateur provenant d’un **appareil déjà reconnu** ne génèrent plus la notification « Nouvelle connexion administrateur ». Cela couvre les navigateurs déjà connus et les PWA déjà appairées au même compte, même si leur User-Agent change.
- La connexion reste consignée dans le **journal d’audit**; un appareil réellement nouveau ou non reconnu continue de déclencher les alertes de sécurité.
- L’ancien flux **Activité en direct** est devenu un véritable **Historique d’activité persistant** : jusqu’à 2 000 événements sont conservés dans l’état, sauvegardés/restaurés avec Direct-Xfer et continuent d’être diffusés en direct dans l’interface.
- Lors de la première migration, l’historique est automatiquement amorcé depuis les entrées d’audit et l’historique des transferts déjà présents afin de ne pas repartir avec un journal vide.
- La couverture comprend maintenant les changements de préférences/règles de notifications, tests webhook/e-mail/digest/Push, arrêt manuel de transfert, test de port, opérations PWA sur albums/images/rétention/Push, restauration/remplacement d’image, réponses aux réceptions, demandes d’accès/feedback/messages visiteurs et événements système pertinents (redémarrage, arrêt, crash récupéré, mise à jour, erreur d’indexation).
- Les opérations de faible valeur (lectures, marquage de notifications comme lues, miniatures/adaptatifs automatiques) restent volontairement exclues pour éviter de noyer le journal.
- Version **1.52.2**, cache PWA **pwa255**, ressources **v241**.

## 1.52.1 — audit approfondi de l’historique d’actions / Undo (build pwa254)

- Durcissement des permissions : une PWA appairée sans session administrateur active ne peut plus transformer son cookie d’appareil en capacité d’Undo globale. Elle ne peut annuler que ses propres révocations récupérables; les actions d’un autre appareil et les réglages restent en lecture seule.
- Les mutations Undo sensibles sont désormais **atomiques** avec leur entrée d’historique : configuration, surnoms IP, statistiques, destinataires et mises en corbeille ne peuvent plus être validés durablement sans leur journal d’annulation correspondant.
- Détection des **conflits d’état** : un ancien Undo ne peut plus écraser une modification plus récente. Les entrées devenues dangereuses sont conservées et affichées comme non annulables.
- Restauration stricte depuis la corbeille : l’Undo refuse les collisions d’identifiant/token plutôt que de restaurer silencieusement une URL différente; les éléments déjà restaurés ou purgés sont distingués.
- Le journal chargé depuis disque ou depuis une **sauvegarde restaurée** est assaini, borné à 25 entrées et limité en taille; les snapshots Undo sont clonés pour empêcher toute mutation indirecte.
- L’interface standard et la PWA affichent des raisons précises (*état modifié*, *déjà restauré*, *purgé*, *lecture seule*, etc.), rafraîchissent l’état après un conflit et empêchent le cache HTTP de servir un historique obsolète.
- Version **1.52.1**, cache PWA **pwa254**, ressources **v240**.

## 1.52.0 — historique d’actions avec annulation (build pwa253)

- Nouveau journal chronologique des **actions administratives destructives**, avec une carte **Historique d’actions** visible dans l’interface standard : aperçu des 3 dernières actions, compteur, rafraîchissement et accès à l’historique complet pour lancer **Undo**.
- La **PWA** dispose maintenant de la même fonctionnalité dans l’espace **Partages** : historique persistant, rafraîchissement, états *Annulée* / *Plus annulable* et bouton **Annuler** sur chaque action encore réversible. Les révocations réalisées depuis la PWA alimentent aussi ce journal unifié.
- Sont annulables : **changement de configuration**, **réinitialisation des statistiques** d’un lien, **retrait d’un destinataire nominatif**, **effacement des surnoms client** et **suppression d’un partage** (restauré depuis la corbeille). Une entrée dont la cible a déjà été purgée reste visible mais est marquée **Plus annulable**.
- Le journal est **borné aux 25 dernières actions**, persistant dans le store, et filtré par compte/permissions. Il complète — sans les remplacer — la corbeille récupérable et l’annulation éphémère de 5 s après révocation.
- Version **1.52.0**, cache PWA **pwa253**, ressources **v239**.

## 1.51.2 — suppression définitive depuis la corbeille PWA (build pwa251)

- Ajout de **Supprimer définitivement** sur chaque élément de la corbeille PWA, avec confirmation irréversible.
- Ajout de **Tout supprimer définitivement** pour purger la corbeille en une opération, avec confirmation explicite et résultat comptabilisé.
- Les purges définitives PWA sont réservées aux comptes/appareils **owner/admin**; les droits de restauration existants des opérateurs ne sont pas élargis.
- L’interface standard conserve ses fonctions de purge existantes avec le libellé harmonisé **Tout supprimer définitivement**.
- Version **1.51.2**, cache PWA **pwa251**, ressources **v238**.

## 1.51.1 — persistance de session PWA (build pwa250)

- Version corrective portée à **1.51.1** sans changement fonctionnel supplémentaire.
- Conserve le correctif empêchant une fermeture/réouverture rapide de la PWA de provoquer un verrouillage immédiat.
- Le délai d’auto-verrouillage configuré est désormais respecté sur la durée réellement écoulée hors de l’application.
- Cache PWA **pwa250** et ressources **v237** pour forcer le renouvellement des installations existantes.

## 1.51.0 — organisation, cycle de vie et recherche globale (build pwa249)

- Correctif PWA : la fermeture/réouverture ne verrouille plus immédiatement la session. Le verrouillage automatique respecte maintenant réellement le délai configuré (5/15/30/60 min).

- **Couleur par lien** et **note privée administrateur** disponibles dans les flux de création/gestion, avec parité PWA pour les partages du serveur.
- **Duplication** d’un partage depuis l’administration et la PWA, avec nouveau jeton et remise à zéro des compteurs/états d’exécution.
- **Réactivation sûre** d’un lien révoqué lorsque ses données existent encore, sans réinitialiser expiration, quotas, mot de passe ou état de pause.
- **Archivage/désarchivage** conservé et exposé dans la bibliothèque PWA avec filtre des archives.
- **Corbeille globale** restaurable dans la PWA pour les éléments gérés par le compte/appareil, en complément de l’administration standard.
- **Recherche globale** étendue aux contenus indexés, liens, utilisateurs et journaux, avec filtrage par portée et respect des droits du rôle.
- Version **1.51.0**, cache PWA **pwa249**, ressources **v236**.

## 1.50.0 — refactorisation structurelle sans changement fonctionnel (build pwa247)

- Refactorisation conservatrice du backend : `server.js` reste le point d’entrée et les routes/API restent inchangées.
- Extraction des utilitaires généraux vers `lib/core-utils.js` et des primitives de hachage d’authentification vers `lib/auth-utils.js`.
- Extraction des helpers d’images/EXIF vers `lib/photo-utils.js`, du rendu Markdown/code vers `lib/text-render.js` et des sous-titres vers `lib/subtitle-utils.js`.
- Extraction des lectures de fichiers/ZIP bornées vers `lib/file-content-utils.js`, des primitives de recherche sémantique vers `lib/search-utils.js` et des détecteurs DLP vers `lib/dlp-utils.js`.
- Aucun format de données, endpoint, option, chaîne UI ou comportement utilisateur n’est volontairement modifié.
- Version **1.50.0**, cache PWA **pwa247**, ressources **v234**.

## 1.49.3 — descriptions système pleine largeur sur tablette (build pwa246)

- Correction PWA tablette : les **descriptions des notifications système** utilisent maintenant toute la largeur disponible dans leur carte.
- Le titre et l’état (dont **Toujours activée**) restent sur la première ligne, tandis que la description occupe une seconde ligne pleine largeur.
- Conservation de la grille responsive introduite en 1.49.2 pour empêcher tout débordement horizontal du Centre de notifications.
- Version **1.49.3**, cache PWA **pwa246**, ressources **v234**.

## 1.49.2 — correction tablette du centre de notifications (build pwa244)

- Correction PWA tablette : les paramètres du **Centre de notifications** ne débordent plus horizontalement de la carte ni de l'écran.
- La section utilise maintenant une grille responsive bornée : présentation et catégories sur deux colonnes quand l'espace le permet, puis une seule colonne sur téléphone.
- Le constructeur **Alertes personnalisées** occupe toute la largeur de la section au lieu d'être forcé à côté de la grille des catégories.
- Les champs, libellés et descriptions de notifications sont contraints à la largeur disponible et peuvent se replier proprement.
- Version **1.49.2**, cache PWA **pwa244**, ressources **v232**.

## 1.49.1 — audit approfondi des ajouts majeurs (build pwa243)

- **Téléchargements reprenables** : verrou inter-onglets avec bail renouvelé, délais
  d'attente IndexedDB, validation stricte de `Content-Range` et de l'identifiant de
  reprise, redémarrage sans charger une réponse complète inattendue en mémoire,
  purge via « Effacer toutes les données locales » et détection renforcée du
  remplacement d'un fichier (`ctime` incluse).
- **Quotas et sécurité des reprises** : le quota par IP n'est validé qu'après la
  réception complète, une plage HTTP nue ne contourne plus le quota, `HEAD` ne peut
  plus créer de session persistante et un identifiant déjà finalisé n'est plus
  réutilisable pour télécharger sans comptabilisation.
- **Connecteurs de stockage** : chemins de réponse rclone invalides rejetés, caractères
  de contrôle interdits, environnement enfant réduit à une liste sûre, staging
  aléatoire isolé et nettoyage après arrêt. Les tâches interrompues sont détectées,
  les processus récalcitrants sont forcés à s'arrêter, les sondes rclone sont mises en
  cache et l'interface empêche l'export vers un connecteur en lecture seule.
- **Protection antirançongiciel** : événements associés à leur lien réel, aucune
  suspension erronée d'un second lien utilisé par la même IP, contrôle répété avant
  publication des téléversements concurrents et normalisation IPv4/IPv6 au déblocage.
- **Audit infalsifiable** : écriture du journal synchronisée, retour arrière après une
  écriture partielle, refus d'ajouter à une chaîne déjà invalide, création atomique de
  la clé Ed25519 et vérificateur hors ligne exigeant une empreinte ou clé publique de
  confiance (sauf option explicite `--allow-embedded-key`).
- Version **1.49.1**, cache PWA **pwa243**, ressources **v231**.

## 1.49.0 — ajouts majeurs 13, 17, 30 et 33 (build pwa242)

- **13 — téléchargements avec reprise** : gestionnaire partagé aux pages publiques et
  à la PWA, morceaux de 8 Mio persistés dans IndexedDB, reprise après fermeture,
  validation ETag/If-Range et redémarrage propre si la source change. Les plages sont
  enregistrées côté serveur pendant 7 jours et un téléchargement repris ne produit
  qu’un seul historique/compteur logique. Les ZIP, contenus E2E et liens à usage unique
  conservent le téléchargement natif afin de respecter leur sémantique.
- **17 — connecteurs de stockage** : création, modification, test, import, export,
  annulation et suivi des tâches depuis Configuration. SFTP, SMB, WebDAV, Google Drive,
  OneDrive, Dropbox et Box utilisent le `rclone` inclus dans l’image. Les secrets restent
  dans `/data/rclone/rclone.conf`; les imports sont atomiques, sans écrasement, bornés à
  `/Direct-Xfer/Imports`, protégés contre les symlinks et analysés par ClamAV lorsqu’il
  est activé. Les exports restent confinés aux fichiers hôte, Réceptions et Images.
- **30 — protection anti-rançongiciel** : une rafale de noms suspects, d’uploads ou de
  suppressions bloque l’IP et suspend aussi les écritures du lien Réception/Collaboration
  concerné. Le blocage persiste après redémarrage, produit une alerte critique et peut
  être levé séparément pour l’IP ou le lien depuis Configuration.
- **33 — journal d’audit infalsifiable** : la chaîne HMAC et sa tête scellée sont
  conservées, avec export complet signé Ed25519. Un export est refusé si l’intégrité de
  la chaîne est déjà en échec. Le paquet contient le journal, son SHA-256, la tête signée
  et la clé publique; l’empreinte SHA-256 complète peut être épinglée séparément.
- La version applicative reste **1.49.0**; cache PWA **pwa242**, ressources **v230**.

Configurez d’abord les destinations, puis utilisez leurs noms dans Configuration →
Connecteurs de stockage. Docker continue d’utiliser le rclone de l’image :

```bash
docker exec -it direct-xfer rclone config
```

La distribution Windows inclut maintenant rclone directement sous
`runtime\rclone\rclone.exe`. Aucune installation rclone séparée ni modification du
`PATH` n’est nécessaire. Pour créer les remotes Windows manuellement :

```powershell
& "$env:ProgramFiles\Direct-Xfer\runtime\rclone\rclone.exe" config --config "$env:LOCALAPPDATA\Direct-Xfer\data\rclone\rclone.conf"
```

Vérifiez une preuve téléchargée avec l’empreinte affichée par Direct-Xfer (ou avec une
copie épinglée de la clé publique) :

```bash
node scripts/verify-audit-proof.js direct-xfer-audit-proof-AAAA-MM-JJ.json --key-id EMPREINTE_SHA256
node scripts/verify-audit-proof.js direct-xfer-audit-proof-AAAA-MM-JJ.json --public-key audit-signing-public.pem
```

Sans `--key-id` ou `--public-key`, l’outil valide l’intégrité interne et la signature,
mais une empreinte conservée indépendamment est nécessaire pour authentifier l’instance.


## 1.49.0 — mise à jour de sécurité des dépendances du conteneur (build pwa241)

- L’image Docker passe d’Alpine à **Debian 13 Trixie slim**, tout en conservant Node.js 22, afin d’utiliser les rétroportages de sécurité officiels de Debian pour `giflib`.
- Le build refuse une version de `libgif7` antérieure à `5.2.2-1+deb13u1`, qui corrige CVE-2026-23868 et CVE-2026-26740.
- Les paquets système sont mis à niveau avant l’installation de Tesseract et Poppler; les jeux de données OCR français, anglais et espagnol restent inclus hors ligne.
- Les exécutables inutilisés `pdftocairo` et `text2image`, seuls chemins Cairo pertinents pour Direct-Xfer, sont retirés. Les commandes réellement utilisées (`tesseract`, `pdftotext`, `pdftoppm`) sont vérifiées pendant le build.
- Le passage aux privilèges réduits utilise maintenant `gosu`; les conventions `PUID`/`PGID` et les volumes Unraid restent inchangés.
- Un document OpenVEX décrit le statut exact des cinq alertes signalées, notamment le faux positif NSS limité à Solaris et l’outil `gif2rgb` absent de l’image.
- Pour reconstruire avec les derniers correctifs de sécurité : `docker compose build --pull --no-cache` puis recréer le conteneur.
- Version portée à **1.49.0**, PWA **pwa241**, ressources **v229**.


## 1.48.4 — correctif d’affichage biométrique (build pwa240)

- Le correctif de mise en page de la section **Identification biométrique** est maintenant publié dans une version applicative distincte.
- Les explications, les actions et la liste des identifications enregistrées conservent une disposition lisible sur mobile et tablette.
- Version portée à **1.48.4**, PWA **pwa240**, ressources **v228**.


## 1.48.3 — désactivation et audit biométriques (build pwa239)

- Les paramètres PWA offrent un bouton explicite pour désactiver toutes les identifications biométriques du compte, sur tous les appareils, avec confirmation et état d’exécution.
- La désactivation reste accessible depuis un navigateur sans biométrie ou lorsque l’activation WebAuthn est bloquée par HTTPS; ces contraintes ne bloquent plus les opérations de révocation côté serveur.
- La liste des identifications biométriques se rend correctement, affiche le nombre d’appareils associés et avertit avant de supprimer une passkey partagée par plusieurs appareils.
- Les activations et suppressions biométriques sont sérialisées pour empêcher les doubles actions, les réponses asynchrones obsolètes et les états d’interface contradictoires.
- Une désactivation globale invalide aussi les défis WebAuthn en attente afin qu’un onglet ou une invite plus ancienne ne puisse pas réactiver la fonction.
- Les cérémonies WebAuthn lient désormais le domaine et l’origine au défi émis, vérifient la cohérence `id`/`rawId`, l’état de sauvegarde, le `userHandle` des connexions sans nom et la compatibilité entre algorithme et clé publique.
- Version portée à **1.48.3**, PWA **pwa239**, ressources **v227**.

### Correctif d’affichage biométrique (build pwa239)

- La section biométrique des paramètres place désormais ses explications et ses actions sur des rangées distinctes; les longs textes ne sont plus comprimés à côté des boutons sur les téléphones de 400 à 560 px.
- Les boutons d’activation, de désactivation et de réauthentification occupent une grille fluide, avec retour à la ligne lisible quelle que soit la langue.
- Chaque identification enregistrée empile son bouton de désactivation sous ses métadonnées sur petit écran; les noms, dates et nombres d’appareils restent lisibles sans débordement.
- Version applicative maintenue à **1.48.3**, PWA **pwa239**, ressources **v227**.


## 1.48.2 — identification biométrique multi-appareils (build pwa237)

- L’enregistrement sur un deuxième appareil n’est plus bloqué par les passkeys déjà créées ou synchronisées sur le compte; seules les identifications déjà associées à l’appareil courant sont exclues.
- Une même passkey synchronisée peut être associée à plusieurs appareils Direct-Xfer après une authentification réussie, tout en conservant l’affichage fiable de l’appareil courant.
- Les compteurs WebAuthn des passkeys multi-appareils sont traités selon leur indicateur de sauvegarde, sans faux rejet lorsque deux appareils synchronisés utilisent des compteurs indépendants; les passkeys mono-appareil conservent la détection stricte de clonage.
- Les défis d’enregistrement sont liés à l’appareil qui les a demandés et les collisions de clés entre comptes sont refusées.
- La PWA distingue désormais une identification déjà synchronisée, un appareil non associé, une incohérence de domaine HTTPS et un refus serveur au lieu d’afficher une erreur générique.
- Version portée à **1.48.2**, PWA **pwa237**, ressources **v225**.

## 1.48.1 — identification biométrique explicite dans la PWA (build pwa236)

- Les paramètres PWA proposent désormais une section **Identification biométrique** toujours visible, avec activation sur l’appareil et liste des identifications enregistrées.
- L’interface explique clairement lorsqu’une connexion HTTPS reconnue, un appareil compatible ou une nouvelle authentification par mot de passe est nécessaire; la réauthentification ramène ensuite aux paramètres.
- L’activation utilise WebAuthn avec l’authentificateur intégré de l’appareil, vérification utilisateur obligatoire et conservation sécurisée des transports compatibles.
- La page de connexion PWA affiche un bouton **Identification biométrique** dédié en français, anglais et espagnol; il reste désactivé avec une explication précise si le contexte n’est pas compatible.
- Les identifications nouvellement créées sont associées à l’appareil PWA courant pour afficher un état fiable et permettre leur désactivation individuelle sans toucher aux autres appareils.
- Version portée à **1.48.1**, PWA **pwa236**, ressources **v224**.

## 1.48.0 — audit approfondi de l’éditeur photo PWA (build pwa235)

- Les analyses asynchrones (visages, plaques et OCR sensible) sont isolées par session : une analyse fermée ne peut plus modifier l’image ouverte ensuite ni laisser l’éditeur bloqué.
- L’application d’une édition est atomique et à déclenchement unique; une erreur d’encodage ou de persistance conserve le travail dans l’éditeur.
- Le type réel produit par le navigateur est utilisé à l’export, ce qui évite les fichiers PNG incorrectement nommés WebP lorsqu’un encodeur n’est pas disponible.
- Le canevas et l’historique libèrent leur mémoire à la fermeture; la profondeur d’annulation s’adapte à la résolution pour éviter les pannes sur les très grandes photos.
- Les annulations tactiles réinitialisent aussi le déplacement et le pincement, le zoom continu reste synchronisé, et les clics secondaires ne dessinent plus.
- La taille initiale du pinceau tient compte du côté le plus long, les contrôles sont réinitialisés entre les images et les réglages disposent d’un repli pixel par pixel sans filtre Canvas.
- Version portée à **1.48.0**, PWA **pwa235**, ressources **v223**.

## 1.47.4 — conservation des tailles Mini et Micro après édition (build pwa234)

- L’éditeur et le remplacement d’une image conservent la résolution personnalisée actuelle des variantes Mini et Micro lors de leur régénération.
- Le ratio est recalculé après une rotation ou un recadrage; les dimensions par défaut ne servent que lorsque la taille existante est absente ou invalide.
- Version portée à **1.47.4**, PWA **pwa234**, ressources **v222**.

## 1.47.3 — retrait du format d’image favori dans la PWA (build pwa232)

- Le sélecteur « Format d’image favori » a été retiré de la page Images avec ses traductions, styles et branchements devenus inutiles.
- Les copies automatiques, les QR et les copies groupées utilisent désormais systématiquement la variante automatique, qui était déjà le choix initial.
- L’ancienne préférence enregistrée localement est supprimée au prochain démarrage de la PWA.
- Version portée à **1.47.3**, PWA **pwa232**, ressources **v220**.

## 1.47.2 — qualité d’export de l’éditeur photo PWA (build pwa231)

- La qualité d’export par défaut de l’éditeur photo est maintenant réglée à **99 %**.
- La valeur initiale de l’interface, la réinitialisation à chaque ouverture et la valeur de secours à l’export utilisent toutes le même réglage.
- Version portée à **1.47.2**, PWA **pwa231**, ressources **v219**.

## 1.47.1 — correctifs du pinceau et de l’éditeur photo PWA (build pwa230)

- La grosseur du pinceau agit maintenant réellement sur les trois outils manuels : **Stylo**, **Flou** et **Caviarder**, y compris pendant les traits continus.
- Un simple toucher/clic produit maintenant un point avec la grosseur choisie; les gestes annulés ou interrompus ne laissent plus de modification partielle.
- Flou et Caviarder fonctionnent comme de vrais pinceaux continus plutôt que comme des sélections rectangulaires ignorant la réglette.
- Défaire restaure aussi correctement les dimensions après une rotation, un recadrage ou un redimensionnement; « Tout effacer » revient à l’image originale.
- Les commandes qui mutent l’image sont verrouillées pendant une détection locale, et un échec d’export conserve désormais l’éditeur et les modifications à l’écran.
- Version portée à **1.47.1**, PWA **pwa230**, ressources **v218**.

## 1.47.0 — zoom, déplacement et pinceau réglable dans l’éditeur photo PWA (build pwa229)

- Le zoom de l’éditeur est réglable de **25 % à 400 %** avec une réglette, des boutons +/− et une commande d’ajustement à l’espace disponible.
- Le pincement à deux doigts et `Ctrl`/`Cmd` + molette permettent de zoomer autour du point visé sans modifier la résolution de l’image exportée.
- Un outil **Déplacer** permet de parcourir précisément une image agrandie sur écran tactile ou à la souris.
- La grosseur du pinceau est maintenant réglable de **2 à 200 px** et appliquée directement aux traits du stylo.
- L’interface reste adaptative sur téléphone, tablette et grand écran, avec commandes traduites en français, anglais et espagnol.
- Version portée à **1.47.0**, PWA **pwa229**, ressources **v217**.

## 1.46.4 — éditeur photo PWA agrandi et édition après téléversement (build pwa228)

- L’image utilise maintenant toute la zone utile de l’éditeur sans être rognée; les outils défilent séparément et l’affichage s’adapte aux téléphones, tablettes et grands écrans.
- Chaque image déjà téléversée propose « Modifier avec l’éditeur photo » : la version Pleine est chargée par l’aperçu privé, modifiée localement, puis remplacée sur le même lien.
- Annuler ne modifie rien. Appliquer archive la version précédente, conserve le jeton public, les statistiques et les réglages, puis régénère Mini/Micro et les variantes adaptatives.
- Les Mini/Micro JPEG des images transparentes sont désormais aplaties sur blanc plutôt que sur noir.
- Version portée à **1.46.4**, PWA **pwa228**, ressources **v216**.

## 1.46.3 — accès explicite à l’éditeur photo PWA (build pwa227)

- La section Images propose maintenant « Modifier avant partage » pour ouvrir l’éditeur avant de créer un lien.
- Chaque image de la file d’envoi affiche un bouton explicite « Éditeur photo », y compris sur mobile grâce au retour à la ligne des actions.
- Annuler l’éditeur ne crée aucun lien; appliquer une modification partage uniquement la version modifiée.
- Version portée à **1.46.3**, PWA **pwa227**, ressources **v215**.

## 1.46.2 — révocation successive des images PWA (build pwa226)

- Une seule révocation d’image reste annulable à la fois : révoquer une seconde image valide immédiatement la première, puis accorde à la seconde un nouveau délai complet de 5 secondes.
- Les protections contre les doubles requêtes et les minuteries orphelines restent actives pendant les rafraîchissements de la galerie.
- Version portée à **1.46.2**, PWA **pwa226**, ressources **v214**.

## 1.46.1 — correctif de révocation PWA (build pwa224)

- La révocation des liens de partage, collaborations et images envoie maintenant un corps JSON valide, y compris derrière les reverse proxies stricts.
- Une nouvelle tentative après une réponse réseau perdue reconnaît une révocation déjà appliquée au lieu d’afficher un faux échec.
- Le délai d’annulation de 5 secondes pour les images reste disponible.
- Les éléments révoqués demeurent récupérables depuis la corbeille.
- Version portée à **1.46.1**, PWA **pwa224**, ressources **v212**.

## 1.46.0 — transferts en arrière-plan, passkeys, caviardage et présence SSE (build pwa222)

- La PWA peut maintenant terminer en arrière-plan les transferts durables déjà validés, transformés et chiffrés, y compris après fermeture; la reprise gère les fichiers vides, les fenêtres suspendues, les réponses finales perdues et les résultats mixtes sans doubler un téléversement.
- La connexion **Passkey/WebAuthn** et le déverrouillage biométrique exigent la vérification utilisateur; la gestion des passkeys requiert une authentification administrateur récente et les compteurs d’authentificateur sont protégés contre les retours en arrière.
- L’éditeur photo permet de flouter ou caviarder des zones sensibles avant envoi en conservant la résolution originale par défaut, la transparence PNG/WebP et des sélections strictement limitées au canevas.
- L’indicateur SSE « téléchargement en cours » est disponible par lien dans les interfaces standard et PWA, avec contrôle continu des sessions et appareils révoqués.
- La révocation PWA des partages, collaborations et images traverse correctement les reverse proxies, reste récupérable dans la corbeille et reconnaît sans faux échec une nouvelle tentative après une réponse réseau perdue.
- Version portée à **1.46.0**, PWA **pwa222**, ressources **v210**.

## 1.45.5 — correctifs d’audit : historique, taille des dossiers et notifications (build pwa219)

- L’**historique des modifications** d’un lien ne commence plus par une entrée « créé » superflue : un lien neuf démarre avec un historique vide, sa première vraie modification devient l’entrée n°1 (le clone/import conservent leur entrée de création explicite).
- Les **liens de dossier** affichent désormais leur taille réelle dès le premier listing au lieu de `0 octet` : le cache de taille logique est préchauffé une fois à la création, sans jamais bloquer le polling haute fréquence.
- **Fuite de notifications corrigée** : sur `/app/notifications`, un navigateur portant à la fois une session admin et un appareil PWA appairé d’un *autre* compte recevait les notifications du propriétaire dans la PWA de l’enfant ; l’appareil appairé est maintenant le principal résolu directement depuis son cookie.
- Correctifs partagés par la version standard **et** la PWA (endpoints serveur communs). Audit PWA vérifié en direct : aucune erreur console sur la connexion, les cinq panneaux et le centre de notifications.
- Version portée à **1.45.5**, PWA **pwa219**, ressources **v207**.

## 1.45.4 — audit ultra-approfondi de la version standard (build pwa218)

- Le client standard possède maintenant des **timeouts réseau**, un coffre de mot de passe IndexedDB borné et une protection contre les réponses arrivant après un changement de compte; logout/expiration de session purge aussi modales, SSE et données authentifiées du DOM.
- Le polling des liens, tableaux de bord et notifications est dédupliqué/ordonné; le démarrage n’attend plus le diagnostic réseau et le calcul récursif des gros dossiers s’effectue en arrière-plan.
- Les opérations critiques du dashboard (liens, corbeille, comptes/2FA, préférences, historique, Images, modération et réceptions) ne répondent plus succès avant une **persistance durable**, avec rollback ou staging de fichiers en cas d’erreur.
- Les remplacements Images et variantes Mini/Micro sont sérialisés pour éviter les courses; l’export CSV Images protège désormais aussi contre l’**injection de formules tableur**.
- Les uploads de réception standard et la validation manuelle partagent une comptabilité durable et l’expiration individuelle; les rejets/approbations sont retentables sans perdre les fichiers ou métadonnées.
- Les demandes d’accès publiques réessayées après perte de réponse réutilisent la demande existante au lieu de créer un doublon.
- Les réglages de sécurité sont plus stricts : allowlist IP invalide refusée, limites négatives/non numériques refusées au lieu de devenir `0 = illimité`, et les Opérateurs ne peuvent plus lire les réglages d’infrastructure globaux.
- Le centre de notifications standard n’offre plus de copie d’un lien historique après sa révocation/expiration et ignore les réponses `stale-auth` comme erreurs de connexion.
- Version portée à **1.45.4**, PWA **pwa218**, ressources **v206**.

## 1.45.3 — audit ultra-approfondi PWA, reprise mobile et cache (build pwa217)

- IndexedDB et OPFS récupèrent automatiquement après une panne/lock temporaire au lieu de mémoriser une promesse rejetée jusqu’au prochain rechargement; les transactions IndexedDB sont désormais bornées dans le temps.
- Une seule implémentation `fetchWithTimeout()` est utilisée dans la PWA; elle conserve les signaux d’annulation existants et possède aussi un fallback de timeout sans `AbortController`.
- Le démarrage PWA ne lance plus deux `/app/device/status` en parallèle et ne peut plus rester bloqué indéfiniment sur les chargements réseau initiaux.
- Le coffre du mot de passe et le formulaire de connexion mobile possèdent des timeouts; une panne IndexedDB ne peut plus empêcher la redirection après une connexion serveur réussie.
- Web Share Target rendu crash-safe : métadonnée `complete`, reprise via identifiant local persistant, identité stable du texte partagé, purge des lots incomplets/corrompus et nettoyage des anciens caches `dx-share-*`.
- Le service worker ne met plus en cache le document HTML authentifié `/app/`; le mode hors ligne utilise un shell public sans bootstrap privé.
- Les métadonnées Push `openCenter` / `panel` / `destinationUrl` sont conservées jusqu’au service worker et le clic sur une notification peut réellement ouvrir le panneau attendu.
- Les bibliothèques Images de plus de 500 éléments sont chargées par pages; le polling léger ne considère plus les pages non chargées comme supprimées et ne peut plus interrompre un inventaire complet en cours.
- Les requêtes d’inventaire/statistiques Images, la validation des destinations et la connexion mobile sont bornées afin d’éviter les états « chargement infini » sur Android/réseaux instables.
- Une exception synchrone de `XMLHttpRequest.send()` passe maintenant par le chemin de retry/nettoyage normal et ne laisse plus un transfert fantôme dans `activeXhrs`.
- La première installation du service worker n’affiche plus à tort « nouvelle version disponible »; les mises à jour réelles conservent le mécanisme d’adoption explicite.
- Version portée à **1.45.3**, PWA **pwa217**, ressources **v205**.

## 1.45.2 — audit ultra-approfondi fiabilité, sécurité et atomicité (build pwa216)

- Durcissement de la **rétention Réceptions** : les zones techniques `.dxparts` / `.dxpending` sont exclues, les octets supprimés libèrent réellement les quotas, et les suppressions ratées sont retentées sans perdre leur suivi.
- Isolation **PWA multi-compte** renforcée : session et appareil doivent appartenir au même compte; supprimer un compte révoque appareils, Push, SSE et tickets d'appairage; un ancien `accountId` ne peut pas être réadopté par un compte recréé avec le même nom.
- **Web Push** cloisonné par propriétaire/compte pour empêcher l'envoi d'événements privés aux souscriptions d'autres comptes.
- Sauvegarde/restauration **v2** : chaîne d'audit complète incluse, re-signée avec la clé active; secrets et journal sont préparés avant bascule; rollback des artefacts externes et invalidation des sessions/caches après restauration.
- Les sauvegardes échouent explicitement si un secret référencé est illisible au lieu de produire silencieusement une archive incomplète.
- Le démarrage refuse désormais un `shares.json` existant mais corrompu/invalide, évitant son écrasement par un état vide.
- Les notes **burn-after-read** ne sont remises qu'après suppression physique réussie du ciphertext; création et expiration sont transactionnelles et retentables en cas d'erreur disque.
- Contrôles anti-symlink renforcés pour manifeste SHA-256, navigation/réception et chemins de fichiers gérés.
- Les purges de corbeille/images, suppressions d'album et opérations de rétention n'annoncent plus un faux succès lorsque l'état durable ne peut pas être écrit.
- Les mutations critiques (**mot de passe, 2FA, comptes, paramètres, préférences de notifications, règles personnalisées, rétention Images, import de configuration, appairage PWA et invitations d'album**) utilisent rollback ou refus explicite si la persistance échoue.
- L'import de configuration ne peut plus injecter de chemins `encPath`/`containerPath` arbitraires; le mode remplacement conserve les anciens liens dans la corbeille récupérable.
- Les remplacements et **restaurations de versions d'images** valident la nouvelle métadonnée sur disque avant de supprimer l'ancienne image; rollback complet en cas d'échec.
- Les fichiers de modération refusés ne perdent plus leur métadonnée si la suppression physique échoue, ce qui évite les `.dxpending` orphelins et les quotas incohérents.
- Les suppressions définitives nettoient aussi les références d'albums, états de règles d'alertes et données gérées uniquement après destruction physique réussie.
- Version portée à **1.45.2**, PWA **pwa216**, ressources **v204**.

## 1.45.1 — audit fiabilité transferts, alertes et rétention (build pwa215)

- Correction du coordinateur de débit partagé : une limite lente par lien ne réserve plus abusivement le budget global des autres liens.
- Les changements de limite par lien/globale et les fenêtres planifiées s’appliquent maintenant aux téléchargements déjà en cours, sans conserver de réservation calculée avec un ancien débit.
- Les alertes personnalisées refusent les nouvelles cibles expirées/inactives et affichent clairement une cible devenue indisponible au lieu de la présenter comme « tous les liens ».
- Les purges définitives nettoient les règles d’alerte ciblées, leurs états de déclenchement et les références d’albums devenues orphelines.
- Les révocations groupées d’images et celles liées à la révocation d’un appareil passent par la corbeille récupérable.
- La rétention automatique des images supprime désormais réellement les fichiers gérés avant de comptabiliser l’espace libéré.
- Suppression d’une image contribuée à un album : les fichiers gérés sont maintenant purgés avec le lien.
- Version portée à **1.45.1**, PWA **pwa215**, ressources **v203**.

## 1.45.0 — fiabilité des alertes personnalisées et limites de débit (build pwa214)

- Les règles d’alertes personnalisées sont désormais strictement **une fois par lien et par révision de règle** : une baisse ultérieure de la métrique (par exemple après rejet/rétention de fichiers reçus) ne les réarme plus silencieusement.
- Les règles « tous les liens » et les sélecteurs de cible ignorent les liens historiques déjà inactifs/expirés lors des balayages périodiques.
- La création d’une règle identique est idempotente afin d’éviter les doublons lors d’un double clic ou d’une reprise réseau; un ID explicite déjà supprimé retourne 404 au lieu de recréer une règle.
- L’historique de déclenchement par règle est porté à 5000 liens afin d’éviter les ré-alertes artificielles sur les grandes bibliothèques.
- Les limites de débit par lien sont maintenant **agrégées entre toutes les connexions parallèles** du même lien. Les plafonds global et planifié utilisent également des budgets partagés à l’échelle du serveur.
- Les valeurs de débit invalides/négatives ne sont plus converties silencieusement en « illimité »; le dashboard standard et la PWA appliquent la même validation stricte.
- Le streaming à très faible débit utilise des blocs plus petits pour éviter des pauses inutilement longues.
- Version portée à **1.45.0**, PWA **pwa214**, ressources **v202**.

## 1.44.5 — productivité des liens et pagination (build pwa211)

- Ajout d’une **pagination configurable des liens actifs** (10 / 25 / 50 / 100 par page), avec préférence mémorisée et navigation précédent/suivant.
- Ajout d’un **badge visible « Expire bientôt »** et d’un compte à rebours directement sur les liens arrivant à échéance; la PWA affiche aussi ce badge sur les images.
- Les outils déjà présents (tri mémorisé, copie multi-sélection, actions groupées, duplication, épinglage et historique) sont consolidés avec sélection de page et historique de cycle de vie **créé → modifié → révoqué → restauré** consultable depuis la corbeille.
- Cache PWA courant incrémenté à **pwa211** et ressources versionnées **v199**.
- Correctifs de robustesse du pack : historique de création attribué au bon compte/appareil, duplication sans état de notifications hérité, déduplication et verrouillage des actions groupées, contrôles de sélection masqués aux auditeurs et expiration effective correctement affichée dans la PWA.

### Historique du bump 1.44.5 précédent

- Version du projet portée à **1.44.5**.
- Le bloc **Test notifications push** est placé immédiatement au-dessus de **Centre de notifications** dans les réglages de la PWA.
- Le fonctionnement du test Push et des préférences de notifications reste inchangé.
- Cache PWA incrémenté à **pwa208** et ressources versionnées **v196**.

### Cycle de vie, usage unique, modération et comparatifs

- Corbeille récupérable harmonisée : les révocations depuis la PWA passent maintenant par la même corbeille que le dashboard standard.
- Archivage automatique optionnel des liens expirés après un délai configurable (`autoArchiveExpiredDays`).
- Nettoyage définitif optionnel après expiration (`expiredDataRetentionDays`), incluant les données Direct-Xfer gérées et les fichiers en attente de modération.
- Règles d’expiration combinables : date, nombre maximal de téléchargements, première utilisation et inactivité; la première limite atteinte désactive le lien.
- PWA : expiration après première utilisation et mode usage unique renforcé disponibles à la création des partages serveur.
- Usage unique renforcé par un verrou serveur : une deuxième récupération complète concurrente est refusée et un transfert interrompu libère le verrou pour permettre une reprise.
- PWA : création de liens de réception avec validation manuelle, puis approbation/rejet des fichiers en attente depuis le contenu reçu.
- Statistiques comparatives : le dashboard standard conserve ses périodes comparées et la PWA Images propose désormais 7 ou 30 jours comparés à la période précédente.

## 1.44.4 — correctifs des préférences et catégories de notifications (build pwa207)

- Version du projet portée à **1.44.4**.
- PWA : les notifications **Santé système**, **Maintenance**, **Réseau**, **Redémarrages**, **Mises à jour** et **PWA** ouvrent désormais directement les **Réglages** au lieu du panneau Activité; le dashboard standard ouvre la **Configuration** pour ces mêmes catégories.
- Redémarrages : un arrêt propre ne crée plus une seconde notification distincte avant la notification de redémarrage; un cycle arrêt/démarrage produit une seule alerte utile avec la durée d’indisponibilité lorsqu’elle est connue.
- Préférences : les anciennes valeurs devenues invalides (dont `maintenance` lorsqu’elle avait été désactivable) sont maintenant nettoyées et persistées dans le compte, au lieu d’être seulement ignorées en mémoire.
- Migration : les anciennes notifications `activity` / `system` sont renormalisées même si une sauvegarde les réintroduit après le passage du marqueur de schéma.
- Interface : dans les préférences du centre de notifications, **Maintenance** est déplacée au bas de la liste, immédiatement au-dessus de **Sécurité**, dans le dashboard standard et la PWA.
- PWA : le **Test notifications push** est déplacé juste au-dessus de la section **Centre de notifications** dans les réglages.
- Cache PWA incrémenté à **pwa207** et ressources versionnées **v195**.

## 1.44.3 — sous-catégories des notifications système (build pwa204)

- Version du projet portée à **1.44.3**.
- La catégorie **Système** du centre de notifications est séparée en **Santé système**, **Maintenance**, **Réseau**, **Redémarrages** et **Mises à jour**.
- **Redémarrages** et **Mises à jour** sont désormais optionnels et peuvent être désactivés indépendamment dans les paramètres standard et PWA.
- **Santé système** reste toujours activée afin de conserver les alertes importantes (pannes de service, erreurs de configuration et reprise après crash).
- **Maintenance** est désormais toujours activée afin que les nettoyages automatiques et suppressions par rétention restent visibles.
- Les anciennes notifications stockées sous **Système** sont automatiquement reclassées vers la nouvelle sous-catégorie appropriée.
- Cache PWA incrémenté à **pwa204** et ressources versionnées **v192**.

## 1.44.2 — descriptifs des catégories de notifications (build pwa202)

- Version du projet portée à **1.44.2**.
- Ajout de descriptifs sous chaque catégorie de notifications dans la configuration standard et la PWA.
- Conservation de la séparation **Visiteurs / Seuils / Trafic** introduite en 1.44.1.
- Cache PWA incrémenté à **pwa202** et ressources versionnées **v190**.

## 1.44.1 — catégories d’activité détaillées et simplification PWA (build pwa201)

- Version du projet portée à **1.44.1**.
- PWA : retrait du bouton global **« Tout déplier »** au-dessus des réglages; les sections avancées restent contrôlées individuellement et par l’option d’accordéon.
- Centre de notifications : la préférence générale **Activité** est remplacée par **Visiteurs**, **Seuils** et **Trafic** pour un contrôle plus précis.
- Les événements « nouveau pays / nouvel appareil visiteur » sont classés dans **Visiteurs**; les seuils de vues/téléchargements dans **Seuils**; le volume élevé et les liens viraux dans **Trafic**.
- Migration automatique : une ancienne préférence **Activité désactivée** désactive les trois nouvelles catégories, et les notifications historiques `activity` sont reclassées selon leur type.
- Paramètres de notifications : chaque catégorie affiche maintenant un descriptif de ses événements dans le dashboard standard et la PWA, avec traductions français/anglais/espagnol.
- Cache PWA incrémenté à **pwa201** et ressources versionnées **v189**.

## 1.44.0 — préférences du centre de notifications (build pwa199)

- Version du projet portée à **1.44.0**.
- Ajoute une section **Centre de notifications** à la configuration standard et aux réglages de la PWA.
- Permet à chaque compte de choisir les catégories de notifications reçues : Partages, Réceptions, Images, Transferts, Activité, Recherche/OCR et PWA.
- Les catégories **Sécurité** et **Système** restent toujours actives afin de préserver les alertes essentielles.
- Les préférences sont partagées et synchronisées entre le dashboard standard, la PWA et le panneau ⚙️ du centre de notifications.
- Cache PWA incrémenté à **pwa199** et ressources versionnées **v187** pour forcer le déploiement de cette interface sur les installations existantes.

## 1.43.5 — sélection des liens de réception sans fausser les vues (build pwa197)

- Version du projet portée à **1.43.5**.
- La sélection d’un lien de réception dans la PWA n’ouvre plus silencieusement sa page publique `/u/<token>` et n’incrémente donc plus son compteur de vues.
- La PWA récupère maintenant la configuration nécessaire via la sonde `upload-status?config=1`, sans effet sur les statistiques, tout en conservant quotas, extensions, chiffrement et contraintes de destination.
- Une ouverture réelle de la page publique continue de compter normalement comme une vue.
- Cache PWA incrémenté à **pwa197** et ressources versionnées **v185** afin de forcer le déploiement du correctif sur les installations existantes.

## 1.43.4 — correctifs du centre de notification (build pwa196)

- Corrige la gestion lecture/non-lu pour ne marquer comme lues que les notifications réellement visibles, y compris après filtrage et « Afficher plus ».
- Autorise les comptes Auditeur à gérer leur propre état de notification sans élargir leurs autres permissions.
- Corrige les catégories Réceptions/Images, l’ouverture du bon panneau PWA et la copie fiable des liens publics actifs.
- Sérialise la sauvegarde des préférences de notification et permet leur rechargement après une erreur réseau.
- Corrige la PWA : sélectionner un lien de réception ne charge plus sa page publique et ne gonfle donc plus son compteur de vues/visiteurs.
- Version applicative et PWA : **1.43.4**.
- Cache PWA : **pwa196 / v184**.

## 1.43.3 — nettoyage des liens de réception PWA (build pwa193)

- Les liens de réception révoqués ou expirés ne sont plus proposés dans les sélecteurs de destination de la PWA.
- Le nettoyage couvre aussi les copies de destinations persistées localement, tout en préservant les destinations manuelles ou externes.
- Version applicative et PWA : **1.43.3**.
- Cache PWA : **pwa193 / v181**.

## 1.43.2 — consolidation de l’identification des visiteurs (build pwa191)

- Consolide le correctif qui distingue clairement le nom du lien du nom du visiteur dans le centre de notifications.
- Les visites effectuées depuis un appareil PWA appairé au compte propriétaire ne génèrent plus de fausses alertes « nouveau visiteur », « nouveau pays » ou « nouveau navigateur/appareil ».
- Le cookie d’authentification PWA secret reste limité à `/app`; seul un identifiant d’appareil sans privilège est utilisable sur les routes publiques pour cette reconnaissance.
- Version applicative et PWA : **1.43.2**.
- Cache PWA : **pwa191 / v179**.
- Validation complète : **481/481 tests réussis sur 95 fichiers de tests**.

## 1.43.1 — annulation différée de la révocation d’image PWA (build pwa190)


### Correctif Notifications — identification des visites de l’appareil propriétaire
- Le nom affiché dans « Nouveau visiteur » est explicitement présenté comme le **nom du lien**, et non comme le nom du visiteur/appareil.
- Un appareil PWA appairé possède maintenant un marqueur d’identité public **sans privilège d’authentification** (`dxpwaid`) distinct du cookie secret `dxpwa`, qui reste limité à `/app`.
- Une visite d’un lien appartenant au même compte depuis cet appareil appairé (ou une session administrateur du propriétaire) ne génère plus de fausse alerte « nouveau visiteur », « nouveau pays » ou « nouveau navigateur/appareil visiteur ».
- Les visiteurs externes continuent d’être signalés et reçoivent un libellé navigateur/plateforme générique dans les métadonnées.
- Cache PWA : **pwa190 / v178**.

- Consolide le délai d’annulation de 5 secondes lors de la révocation individuelle d’une image depuis la PWA.
- Après confirmation, la carte affiche un compte à rebours et le bouton « Annuler révocation » avant toute mutation serveur.
- Le rafraîchissement périodique des statistiques ne peut pas écraser l’état d’annulation pendant le délai.
- Version applicative et PWA : **1.43.1**.
- Cache PWA : **pwa190 / v178**.
- Validation complète : **481/481 tests réussis sur 95 fichiers de tests**.

## 1.43.0 — consolidation de l’interface PWA (build pwa188)

- Consolide les derniers ajustements d’interface PWA issus de la série 1.42.x.
- La topbar PWA est simplifiée : suppression de la bulle Informations, des sélecteurs Langue/Thème et des mentions secondaires sous le logo.
- Les réglages Langue et Thème restent disponibles en tête de la page Configuration/Réglages.
- Les correctifs tablette récents pour la PWA et l’interface standard sont conservés.
- La révocation individuelle d’une image dans la PWA attend désormais exactement 5 secondes après confirmation et affiche un bouton visible « Annuler révocation » directement dans la carte pendant ce délai.
- Version applicative et PWA : **1.43.0**.
- Cache PWA : **pwa188 / v176**.
- Validation complète : **479/479 tests réussis sur 94 fichiers de tests**.

## 1.42.3 — consolidation de la topbar PWA tablette/large (build pwa186)

- Consolide le correctif de topbar PWA pour tablette et écrans larges : la cloche Notifications reste alignée avec les autres options.
- Le bouton/bulle Informations (?) a été retiré de la topbar PWA sur toutes les tailles d’écran ; l’aide reste accessible au clavier avec `?` et via la palette de commandes.
- Langue et Thème ont été retirés de la topbar et déplacés tout en haut de la page Réglages/Configuration de la PWA.
- Le texte « Envoyer » sous le logo et la mention « Appareil associé » ont été retirés de la topbar PWA.
- Version applicative et PWA : **1.42.3**.
- Cache PWA : **pwa186 / v174**.
- Validation complète : **475/475 tests réussis sur 93 fichiers de tests**.

## 1.42.2 — consolidation des correctifs tablette (build pwa183)

- Consolide les derniers correctifs d’interface tablette de Direct-Xfer 1.42.1.
- PWA : boutons des cartes Images adaptés aux largeurs tablette sans chevaucher la résolution.
- Interface standard : logo et contrôles de la topbar alignés verticalement sur tablette.
- Version applicative et PWA : **1.42.2**.
- Cache PWA : **pwa183 / v171**.
- PWA tablette/écrans larges : la cloche Notifications est maintenant sur la même ligne que Langue, Thème et Informations ; la disposition téléphone reste inchangée.
- Validation complète : **470/470 tests réussis sur 91 fichiers de tests**.

## 1.42.1 — consolidation de la topbar PWA (build pwa181)

- Publication stable du réalignement de la topbar PWA mobile : **Langue**, **Thème** et **Informations** restent ensemble sur la ligne 2, tandis que **Notifications** reste sur la ligne 1.
- Le bouton **Installer**, lorsqu’il apparaît, utilise une ligne dédiée afin de ne plus déplacer les contrôles de la topbar.
- Version applicative et PWA : **1.42.1**.
- Cache PWA : **pwa181 / v169**.
- PWA : suppression du deuxième bouton « Renommer » pour l’appareil courant; les autres appareils restent renommables avec une session administrateur.
- PWA tablette : les quatre actions des variantes d’image utilisent un bloc 2×2 réservé afin de ne plus chevaucher la résolution dans les cartes Pleine/Mini/Micro.
- Interface standard sur tablette : le logo/nom Direct-Xfer et les contrôles de droite restent sur la même rangée et sont centrés verticalement; le raccourci PWA conserve une rangée dédiée en dessous.
- Validation : **468/468 tests réussis sur 90 fichiers de tests**.

## 1.42.0 — centre de notifications actionnable (build pwa177)

- PWA : topbar mobile réalignée — Langue, Thème et Informations partagent désormais la ligne 2; Notifications reste en ligne 1 et le bouton Installer temporaire ne peut plus déplacer ces contrôles.
- Cache PWA : pwa178 / v166.
- Sept ajouts au centre de notifications, dans les interfaces standard et PWA :
  - **Lignes cliquables** : chaque notification renvoie vers sa section (Images, Partages, Réceptions, Activité…).
  - **Horodatage relatif** (« il y a 5 min ») avec la date absolue en infobulle au survol.
  - **Alerte à l’arrivée** quand le panneau est fermé : notification éphémère, cloche qui pulse et **son optionnel** (mémorisé localement, désactivé par défaut).
  - **Préférences par catégorie** propres à chaque compte : couper certaines catégories (Sécurité et Système restent toujours actives). La coupe est appliquée côté serveur avant création.
  - **Actions contextuelles** par notification : copier le lien public, et révoquer un lien devenu viral/abusé (interface standard).
  - **Pagination** « Afficher plus » (20 par page) au lieu de rendre les 500 entrées d’un coup.
  - **Push → centre** : toucher une notification Push ouvre l’application sur le bon panneau avec le centre déployé; les Push répétées se regroupent (`tag`/`renotify`).
- Correction (audit préalable) : la boucle de « marquage lu » ne s’emballe plus en cas d’échec réseau persistant du panneau ouvert.
- Cache PWA `pwa177` / assets `v165`.
- Validation : **462/464 tests réussis** (les 2 seuls échecs sont les tests OCR nécessitant tesseract, dépendants de l’environnement).

## 1.41.2 — filtres et recherche du centre de notifications (build pwa176)
- Publication stable des filtres par catégorie et gravité ainsi que de la recherche plein texte du centre de notifications dans les interfaces standard et PWA.
- Le système Lu / Non-lu reste synchronisé côté serveur; les filtres et la recherche sont purement visuels et ne modifient pas le compteur de notifications non lues.
- Le panneau conserve son compteur contextuel affiché/total et son état dédié lorsqu’aucune notification ne correspond.
- Audit post-release du centre : correction d’une course GET↔Lu qui pouvait réinjecter un ancien état non-lu et provoquer des tentatives répétées de marquage; la réponse de lecture fournit désormais les IDs lus et existants autoritaires et invalide tout GET plus ancien.
- La fin d’un marquage Lu reste appliquée même si le panneau a été refermé entre-temps, afin que le badge ne reste pas temporairement faux.
- Recherche améliorée : les libellés traduits de catégories et gravités sont indexés (ex. « Sécurité », « Avertissement », « Crítica »), pas seulement leurs codes internes anglais.
- Isolation d’interface standard : filtres et texte de recherche sont remis à zéro à la déconnexion/session expirée afin qu’un autre compte dans le même onglet n’hérite pas des critères du précédent.
- PWA : le nom de l’appareil est désormais affiché dans les métadonnées des alertes Push lorsqu’il n’est pas déjà présent dans le titre; le libellé générique espagnol utilise « Enlace » au lieu de « Link ».
- Cache PWA `pwa176` / assets `v164`.
- Validation : **459/459 tests réussis sur 87 fichiers de tests** après audit correctif de la version 1.41.2.

## 1.41.1 — centre de notifications étendu et audit approfondi (build pwa174)
- Audit correctif des ajouts récents : les alertes de téléchargements simultanés ignorent désormais prévisualisations/Range, et les transferts interrompus utilisent une seule alerte « abandonné » au lieu de doubler « échoué » + « abandonné » ou de qualifier à tort un rejet DLP/antivirus.
- Réceptions modérées : « Fichier reçu disponible » n’est plus créé pendant l’attente de modération; il apparaît seulement après approbation effective du fichier.
- Push : « abonnement réparé » est limité au même appareil (un deuxième appareil du même compte n’est plus un faux repair), les anciens endpoints du même appareil sont purgés, et « permission Notifications retirée » n’est émise que lors de la transition accordée→refusée.
- Mot de passe : la récupération après plusieurs échecs reste détectée même après déclenchement du verrou anti-bruteforce.
- Liens inutilisés : une même période d’inactivité ne recrée plus l’alerte chaque semaine après suppression; une nouvelle alerte nécessite une nouvelle période d’activité puis d’inactivité.
- Remplacement de fichier partagé : comparaison légère du contenu (début/fin + taille) pour ne plus confondre un simple changement de mtime avec un remplacement réel.
- Cycle serveur/réseau : une reprise après crash n’affiche plus l’ancienne durée d’uptime comme durée d’indisponibilité, et la détection d’IP publique accepte maintenant IPv4 et IPv6.
- Isolation multi-compte renforcée dans la PWA : lorsqu’un navigateur possède à la fois une session web et un appareil PWA appairé, le centre Notifications suit désormais exclusivement le principal PWA actif; lecture, suppression et alertes DLP ne peuvent plus viser le compte de la session web par erreur.
- Les détecteurs « activité inhabituelle » et « téléchargements répétés » utilisent l’IP exacte lorsque l’anonymisation est désactivée, et la forme masquée uniquement lorsque l’anonymisation est active; cela évite les faux regroupements de plusieurs appareils d’un même /24.
- Les notifications de connexion administrateur sont enrichies en arrière-plan avec pays/drapeau lorsque le cache GeoIP était froid au moment de la connexion, sans recréer une notification supprimée entre-temps.
- Le nettoyage d’un registre Notifications restauré/invalide ou supérieur à 500 entrées par compte est désormais persisté, empêchant les anciennes entrées supprimées par normalisation de revenir après redémarrage.
- Polling standard optimisé : pause dans les onglets masqués, rafraîchissement immédiat au retour, annulation du GET Notifications lors d’un logout et suppression du délai possible lors d’un logout→relogin rapide.
- Les alertes « lien désactivé automatiquement » distinguent maintenant les nouveaux cycles de limite (ex. 10 puis 20 téléchargements) afin qu’une seconde désactivation légitime ne soit pas silencieusement dédupliquée.
- Centre étendu : fichier reçu disponible, téléchargements/uploads abandonnés, reprise impossible, premier accès protégé, récupération après échecs de mot de passe, nouvel appareil visiteur, téléchargements simultanés, volume élevé et lien viral.
- Images/stockage : fichier source remplacé, image pleine remplacée, Mini/Micro régénérée, suppression automatique par rétention et résumé de nettoyage.
- Supervision : services Push/reverse proxy/GeoIP/OCR/DLP indisponibles ou rétablis, échec de sauvegarde de configuration, redémarrage/arrêt propre/reprise après crash, changement d’IP publique.
- PWA Push : abonnement expiré, réparation automatique et permission Notifications retirée.
- **Lu / Non-lu persistant et synchronisé** : le badge compte seulement les non-lues; ouvrir le panneau les marque immédiatement lues côté serveur dans l’interface standard et la PWA.
- Migration sûre : les notifications créées avant l’ajout Lu/Non-lu sont considérées déjà lues afin de ne pas gonfler artificiellement le badge après mise à jour.
- Filtres du centre de notifications : filtrage local par catégorie et gravité dans les interfaces standard et PWA, sans modifier le badge Lu/Non-lu.
- Recherche plein texte dans le centre : titres, métadonnées, type, catégorie, gravité, nom, détail, raison, appareil, utilisateur et source; recherche insensible à la casse et aux accents.
- Le compteur du panneau indique le nombre affiché par rapport au total lorsqu’un filtre ou une recherche est actif, et affiche un état dédié lorsqu’aucune notification ne correspond.
- Cache PWA `pwa174` / assets `v162`.
- Robustesse : les trackers de volume/viral sont bornés en mémoire, GeoIP ne signale plus une panne pour une IP simplement non géolocalisable, et le rétablissement Push est confirmé par un envoi fournisseur réellement réussi après erreur.
- Validation après ajout Lu/Non-lu : **450/450 tests réussis sur 85 fichiers de tests**.
- Validation après filtres/recherche Notifications : **453/453 tests réussis sur 86 fichiers de tests**.

## 1.41.0 — consolidation du centre de notifications (build pwa170)
- Correctif interface standard : le badge Notifications charge désormais son compteur dès toute entrée authentifiée (session restaurée ou connexion manuelle), sans nécessiter un premier clic sur la cloche. Le polling Notifications est aussi arrêté proprement à la déconnexion.

- Publication de la série de correctifs du centre de notifications sous une nouvelle version stable.
- La clé d’audit locale par défaut est considérée comme valide et ne génère plus l’avertissement `AUDIT_HMAC_KEY recommandé`.
- Centre de notifications renforcé : synchronisation standard/PWA, déduplication persistante, isolation par compte, protection contre les réponses réseau obsolètes et corrections de routage DLP.
- Bouton Notifications PWA repositionné au-dessus du bouton Informations et agrandi d’environ 40 %.
- Cache PWA forcé en `pwa170` / `v158`.
- Validation : 418/418 tests réussis après le bump 1.41.0.

## 1.40.3 — correctifs Notifications et interface PWA (build pwa169)
- La clé d’audit locale `/data/audit-chain.key` est désormais considérée comme une configuration normale : plus d’avertissement `AUDIT_HMAC_KEY recommandé` dans le diagnostic ou le centre, et les anciennes alertes sont purgées automatiquement.
- Dans la PWA, le bouton Notifications est placé au-dessus du bouton Aide/Informations et agrandi d’environ 40 % (60 px hors mobile, 41 px sur mobile).

- Audits successifs du centre : limite de 500 notifications par compte, anonymisation IP appliquée à la lecture, alerte d’expiration indépendante des canaux externes, saturation du registre visiteurs corrigée et protection contre les réponses de polling arrivant dans le désordre.
- Déduplication séparée de la liste visible : supprimer une alerte persistante ne la fait plus réapparaître immédiatement au contrôle suivant; le registre est borné par compte et survit aux redémarrages.
- Correction « Nouveau pays » et première vue : GeoIP résolu en arrière-plan lorsque nécessaire, faux pays/réseaux locaux exclus et notification de première vue enrichie après résolution tardive du pays/drapeau.
- Polling standard/PWA non empilable et non mis en cache, purge de la liste après perte de session, et invalidation des réponses GET antérieures lors d’une suppression individuelle ou d’un « Tout supprimer ».
- Les événements DLP liés à une requête ne retombent plus sur tous les administrateurs lorsqu’aucun propriétaire n’est résolu; les clés internes DLP respectent aussi l’anonymisation IP.
- Nettoyage des notifications et de leur déduplication à la suppression d’un compte; trackers d’activité/téléchargements répétés bornés et purgés périodiquement pour éviter une croissance mémoire continue.
- Les liens déjà révoqués n’émettent plus ensuite d’alertes d’expiration; les quotas de réception ne sont signalés « atteints » que lorsque le quota du lien est réellement plein, et les quotas en octets sont formatés correctement.
- Une requête Range/prévisualisation interrompue n’est plus prise pour un vrai « transfert échoué »; seuls les téléchargements complets et les uploads de réception alimentent cette alerte.
- Restauration de `notificationsForAccount(accountId)` et validation runtime des routes `/api/notifications` et `/app/notifications` depuis la version standard et une PWA appairée.
- Version du projet conservée à `1.40.3`; cache PWA `pwa169` et ressources `v=157`. Validation : **418/418 tests automatisés réussis**.

## 1.40.2 — liste complète des appareils appairés dans la PWA (build pwa165)

- Les paramètres de la PWA affichent désormais tous les appareils appairés au même compte, même lorsque la session administrateur web n’est plus ouverte sur l’appareil courant.
- L’appareil actuellement utilisé reste clairement identifié comme « cet appareil » et peut toujours se renommer ou se désappairer lui-même.
- Les autres appareils sont visibles en lecture seule depuis une PWA appairée; les actions de gestion sur un autre appareil restent réservées à une session administrateur afin de conserver la séparation de privilèges.
- L’API `/app/device/status` filtre maintenant explicitement la liste par compte propriétaire afin qu’aucun appareil d’un autre compte ne puisse être exposé.
- Version du projet portée à `1.40.2`; cache PWA `pwa165` et ressources `v=153`. Validation : **394/394 tests automatisés réussis**.

## 1.40.1 — stabilisation du centre de notifications (build pwa164)

- Version du projet portée à `1.40.1`.
- Publication de l’extension du centre de notifications synchronisé comme release de maintenance distincte après les ajouts de 1.40.0.
- Aucun changement fonctionnel supplémentaire : conservation du stockage partagé standard/PWA, des suppressions synchronisées, des catégories, gravités, seuils et mécanismes de déduplication.
- Cache PWA incrémenté à `pwa164` et ressources versionnées `v=152` afin de forcer le chargement uniforme de cette révision sur les installations existantes.
- Validation : **390/390 tests automatisés réussis**.

## 1.40.0 — centre de notifications synchronisé

- Ajout d’un menu **Notifications** dans l’interface standard, immédiatement à gauche du menu utilisateur.
- Ajout du même centre de notifications dans l’en-tête de la PWA.
- Les premières vues d’images créent désormais une notification persistante liée au compte propriétaire.
- La version standard et la PWA lisent la même liste côté serveur : suppression individuelle et **Tout supprimer** sont synchronisés entre les deux interfaces.
- Ajout d’un badge de nombre de notifications et d’un rafraîchissement périodique / temps réel côté PWA.
- Extension du centre aux événements de transferts, quotas, visiteurs/pays, seuils, sécurité, DLP, OCR/indexation, appareils PWA, connexions admin, diagnostic système et mises à jour.
- Les notifications structurées portent maintenant une catégorie et une gravité, affichées de façon cohérente dans la version standard et la PWA.
- Déduplication/cooldown des alertes répétitives (activité inhabituelle, téléchargements répétés, problèmes système, erreurs OCR/indexation).
- Version maintenue à `1.40.0` ; cache PWA `pwa163` / assets `v151`.
- Validation : **390/390 tests automatisés réussis**.

## 1.39.10 — langue des notifications Push PWA (build pwa160)
- PWA Images : les BBCode Mini/Micro utilisent désormais la petite image comme miniature cliquable avec redirection vers la version Pleine.

- Version du projet portée à `1.39.10`.
- Ajout dans les paramètres PWA d’un choix **Français / English / Español** indépendant de la langue de l’interface pour les notifications Push.
- La langue choisie est enregistrée avec l’abonnement Push de chaque appareil afin que le serveur puisse localiser les notifications même lorsque la PWA est complètement fermée.
- Les notifications **première vue**, **réception** et **test Push** utilisent désormais la langue propre à chaque abonnement.
- Un changement de langue resynchronise immédiatement l’abonnement actif côté serveur.
- Cache PWA incrémenté à `pwa160` et ressources versionnées `v=148`.

## 1.39.9 — fiabilisation des notifications première vue Images (build pwa159)

- Version du projet portée à `1.39.9`.
- Correction des notifications **première vue** pour les anciennes images standard : les enregistrements hérités qui ne possèdent que `ownerName` retrouvent automatiquement leur compte propriétaire et les appareils PWA appairés correspondants.
- Les alertes première vue ne sont plus considérées comme envoyées au simple fait de trouver un abonnement : elles restent en attente jusqu’à ce qu’au moins un service Push accepte explicitement le message, via le même transport vérifié que le bouton de test.
- Un abonnement absent, expiré ou rejeté ne consomme donc plus définitivement l’alerte unique ; celle-ci reste récupérable lors d’une réinscription Push.
- Cache PWA incrémenté à `pwa159` et ressources versionnées `v=147` afin de forcer le renouvellement du shell/service worker Android après la mise à jour.
- Validation : **380/380 tests automatisés réussis**.

## 1.39.8 — diagnostic de livraison Push Android (build pwa158)

- Version du projet portée à `1.39.8`.
- Le test Push mesure désormais la livraison Android à partir de l’envoi réel au service Push, et non depuis le clic utilisateur ou la préparation de l’abonnement.
- L’horodatage d’envoi serveur est propagé dans le payload jusqu’au service worker afin de calculer la latence réelle **service Push → Android**.
- La fenêtre de diagnostic passe à 30 s sans inclure le temps de vérification, réparation ou recréation de l’abonnement.
- Une réception tardive peut encore mettre à jour le diagnostic afin d’éviter les faux négatifs liés à un démarrage lent de la chaîne Push.
- Cache PWA incrémenté à `pwa158` et ressources versionnées `v=146` afin de déployer le diagnostic corrigé sur les installations existantes.
- Validation : **377/377 tests automatisés réussis**.

## 1.39.7 — fiabilisation de la réactivation Push Android (build pwa156)

- Version du projet portée à `1.39.7`.
- La réactivation **OFF → ON** des notifications Push recrée explicitement un abonnement Android neuf et resynchronise son endpoint côté serveur.
- Les alertes **première vue** déclenchées alors qu’aucun abonnement Push utilisable n’est disponible sont conservées en attente puis envoyées dès qu’un appareil se réabonne.
- Le bouton **« Test notifications push »** distingue désormais l’acceptation par le service Push de la réception effective par le service worker et affiche la latence réellement observée sur l’appareil.
- Le nettoyage côté serveur retire les anciens endpoints même si le désabonnement navigateur échoue ou répond tardivement.
- Cache PWA incrémenté à `pwa156` et ressources versionnées `v=144` pour forcer le déploiement du correctif sur les installations existantes.
- Validation : **374/374 tests automatisés réussis**.

## 1.39.6 — fiabilisation du Push Android et test de notifications (build pwa155)

- Version du projet portée à `1.39.6`.
- Réparation automatique des abonnements Android conservés avec une ancienne clé VAPID : la PWA compare désormais l’`applicationServerKey` de l’abonnement à la clé courante et recrée l’abonnement si nécessaire.
- Resynchronisation renforcée de l’abonnement Push courant avec le serveur.
- Les Web Push temps réel utilisent l’urgence `high` et un timeout réseau explicite afin de limiter les envois différés ou pendants sur mobile.
- Ajout du bouton **« Test notifications push »** dans les paramètres PWA : il effectue un vrai aller-retour serveur → service Push → appareil, cible uniquement l’abonnement courant et tente une réinscription automatique si l’abonnement est expiré ou rejeté.
- Réactivation Push renforcée : un OFF → ON recrée désormais explicitement un abonnement Android neuf et réenregistre son endpoint côté serveur.
- Les alertes de première vue survenues sans abonnement Push actif sont conservées puis expédiées automatiquement lors de la prochaine réactivation.
- Le test Push distingue maintenant une acceptation par le service Push d’une réception réelle par le service worker et affiche la latence observée sur l’appareil.
- Cache PWA incrémenté à `pwa155` et ressources versionnées `v=143` afin de forcer le déploiement du correctif sur les installations existantes.
- Validation : **370/370 tests automatisés réussis**.

## 1.39.5 — fiabilisation des notifications première vue Images (build pwa152)

- Version du projet portée à `1.39.5`.
- Correction du ciblage Web Push pour les alertes **première vue** des Images : les appareils PWA appairés au même compte sont maintenant associés aux images créées depuis l’interface standard.
- Resynchronisation automatique de l’abonnement Push PWA au démarrage lorsqu’une autorisation existe déjà côté navigateur mais que l’abonnement n’est plus enregistré côté serveur.
- L’activation de « Notifier à la première consultation » tente désormais d’activer ou de restaurer le Web Push si nécessaire.
- Les appareils verrouillés ou révoqués restent exclus des destinataires.
- Cache PWA incrémenté à `pwa152` et ressources versionnées `v=140` afin de forcer le déploiement du correctif sur les installations existantes.
- Validation : **366/366 tests automatisés réussis**.

## 1.39.4 — correctifs PWA T/OCR et notifications (build pwa151)

- Version du projet portée à `1.39.4`.
- Correction du chargement du moteur T/OCR dans la PWA : prise en charge explicite du WebAssembly dans la CSP, chemins Tesseract worker/core épinglés et gestion robuste des erreurs d'initialisation.
- Ajout de délais d'échec contrôlés pour empêcher l'interface de rester bloquée indéfiniment sur « Chargement du moteur OCR… ».
- Cache PWA incrémenté à `pwa151` et ressources versionnées `v=139` pour forcer le déploiement des correctifs sur les installations existantes.
- Correction des alertes **première vue** Images dans la PWA : les images créées depuis l’admin standard notifient désormais aussi les appareils PWA appairés au même compte.
- L’abonnement Web Push de la PWA est resynchronisé silencieusement au démarrage lorsqu’il était déjà autorisé, afin de réparer un abonnement navigateur encore valide mais absent de l’état serveur après une restauration/migration.
- Activer « Notifier à la première consultation » tente maintenant d’activer le Web Push si celui-ci n’est pas encore configuré sur l’appareil.

## 1.39.3 — synchronisation des variantes Images, nettoyage PWA et correctif OCR (build pwa149)

- Version du projet portée à `1.39.3`.
- Synchronisation fiable des dimensions et tailles **Mini/Micro** après redimensionnement dans l’interface standard, avec réparation automatique des métadonnées déjà obsolètes.
- Suppression du groupe redondant **« Copier un format »** dans les cartes Images de la PWA : la copie reste disponible directement à côté de Pleine/Mini/Micro.
- Les actions favorites ne proposent plus l’ancien bouton de copie dupliqué ; les préférences héritées sont remappées vers des actions valides.
- Correction du bouton **T/OCR** de la PWA qui pouvait rester bloqué sur « Chargement du moteur OCR… » : autorisation CSP WebAssembly, worker/cœur Tesseract 7 épinglés, remontée des erreurs du worker et délais de sécurité sur le chargement/initialisation.
- Cache PWA incrémenté à `pwa149` et ressources versionnées `v=137` afin de forcer le déploiement des correctifs sur les installations existantes.
- Validation : **364/364 tests automatisés réussis**.

## 1.39.2 — statistiques Images dans la PWA (build pwa146)

- Version du projet portée à `1.39.2`.
- Ajout du bouton **Stats** sur chaque carte de la section **Images** de la PWA, à l’instar de l’interface standard.
- La modale mobile affiche le résumé des vues/visiteurs, les variantes Pleine/Mini/Micro et les accès récents avec drapeau, IP et pays selon le réglage d’anonymisation.
- La consultation des statistiques passe par une route de gestion authentifiée et n’ajoute aucune vue artificielle à l’image.
- Cache PWA incrémenté à `pwa146` et ressources versionnées `v=134` afin de déployer la nouvelle interface sur les installations existantes.
- Validation : **359/359 tests automatisés réussis**.

## 1.39.1 — correctifs admin Images/Partages et PWA (build pwa144)

- Version du projet portée à `1.39.1`.
- Correctifs de robustesse de la page admin **Partages** : le rafraîchissement périodique ne reste plus suspendu après interaction avec une case à cocher ou un sélecteur.
- Correctifs de la page admin **Images** : la sélection multiple est resynchronisée après filtrage et les exports Markdown/HTML échappent correctement les noms contenant des caractères spéciaux.
- Correctifs PWA : les sélections invisibles après filtrage sont retirées des actions de masse, les erreurs HTTP de génération Mini/Micro ne sont plus considérées comme des succès, et la copie Markdown est correctement échappée.
- Affichage des statistiques Images conservé avec IP complète + drapeau + pays lorsque l’anonymisation des IP est désactivée.
- La version affichée par la PWA est réalignée sur la version du projet (`1.39.1`). Cache PWA incrémenté à `pwa144` et ressources versionnées `v=132` afin de déployer les correctifs PWA sur les installations existantes.
- Validation : **355/355 tests automatisés réussis** après le bump et le renouvellement du cache PWA.

## 1.39.0 — demande d'accès (28) + retour visiteur modéré (38) (interface admin/serveur, PWA inchangée pwa143)

- Version du projet portée à `1.39.0`.
- **Fonctionnalité 28 — flux « demander l'accès »** : un lien peut être verrouillé
  en mode « approbation requise ». Le visiteur voit un formulaire (nom, e-mail
  facultatif, message) au lieu du contenu ; sa demande est liée à son navigateur
  par un cookie `dxreq_<token>`. L'admin approuve/refuse depuis la carte du lien
  (bouton **Modération**) ; à l'approbation, ce navigateur est débloqué
  automatiquement (la page « en attente » se rafraîchit). Par visiteur (pas
  d'ouverture globale), évalué avant le plafond de visiteurs. E-mail de courtoisie
  au demandeur si SMTP est configuré. Agrégation admin via `GET /api/access-requests`.
- **Fonctionnalité 38 — commentaires/retour visiteur modérés** : formulaire de
  commentaire sur la page d'un fichier partagé (activable par lien). Les retours
  sont **privés à l'admin** (jamais affichés aux autres visiteurs), consultables,
  marquables lus et supprimables depuis **Modération**, avec compteur de non-lus.
  POST sans JavaScript (formulaire + redirection). Anti-spam via le limiteur de
  messages publics existant.
- UI admin : deux cases à cocher (création + édition), badge de file d'attente sur
  les cartes, une modale de modération par lien (demandes d'accès + commentaires),
  i18n fr/en/es et styles dédiés. Correction au passage : collision de clé i18n
  `mod.approve` (feature 8) — la clé « approuver l'accès » est renommée `mod.grant`.
- Tests d'intégration ajoutés : formulaire → cookie → approbation → déblocage auto
  (et isolation par visiteur) ; refus ; retour visiteur privé ; refus si désactivé.
- Aucun changement d'actifs PWA : cache `pwa143` / ressources `v=131` inchangés.

## 1.38.1 — correctifs de la revue (interface admin/serveur, PWA inchangée pwa143)

- Version du projet portée à `1.38.1`.
- **Plafond de bande passante contournable en ZIP** : les téléchargements ZIP
  (dossier `/s/:token/zip`, collection `/all.zip`, sélection `/zip-select`,
  sous-dossier `/item/:idx/zip`) ne comptaient pas les octets servis — la limite ne
  s'appliquait donc jamais à un partage téléchargé en ZIP. Chaque octet ZIP est
  désormais comptabilisé et déclenche l'auto-révocation, et `zip-select` /
  `item/:idx/zip` appliquent aussi le quota de téléchargement par IP.
- **Emoji de lien** multi-points-de-code (ZWJ, drapeaux, teintes de peau) tronqué en
  glyphe cassé → conservation par *graphème* (2 max).
- Info-bulle d'expiration affichant « expiré » pour un lien déjà échu.
- Test d'intégration ajouté pour le plafond de bande passante servi en ZIP.

## 1.38.0 — finition du lot « liens admin » (interface admin, PWA inchangée pwa143)

- Version du projet portée à `1.38.0`.
- **Emoji/icône par lien enfin affiché** : l'emoji défini par lien (déjà saisi,
  stocké et renvoyé par le serveur) remplace désormais réellement le glyphe de
  type dans la liste admin — le type reste indiqué par le badge coloré. Survolable
  (« Emoji du lien »).
- **Info-bulles de temps relatif** dans la liste admin : « Créé il y a X » et
  « expire dans X » au survol des champs *Créé* / *Expire* (calcul jour/heure
  correct, indépendant de l'ancien `formatDuration` limité aux minutes).
- **Bascule de densité** (compact / confortable) de la table des liens admin :
  bouton dédié, préférence mémorisée comme la vue liste/grille et restaurée au
  rechargement.
- **Extension d'expiration en 1 clic** complétée : bouton **« +30 j »** ajouté à
  côté de « +1 j » / « +7 j ».
- Revue de validation des fonctionnalités récentes : déduplication de réception par
  empreinte, notification à *chaque* téléchargement, alerte de connexion depuis un
  nouvel appareil, et bandeau d'annonce global (échappement anti-XSS vérifié).
- Aucun changement d'actifs PWA : cache `pwa143` / ressources `v=131` inchangés.

## 1.37.0 — ajouts pratiques liens / réception / sécurité (build pwa143)

- Version du projet portée à `1.37.0`.
- **Expiration à date/heure exacte** : en plus des durées prédéfinies, chaque
  partage/réception/collaboration accepte une date d'expiration absolue
  (`expiresAt`), y compris à l'édition (elle a priorité sur le préréglage).
- **Générateur de mot de passe fort** (dans le navigateur, RNG cryptographique,
  sans glyphes ambigus) et **indicateur de robustesse** sur les champs mot de
  passe des liens et du compte admin.
- **Modale QR enrichie** : bouton **« Copier lien + mot de passe »** (uniquement
  quand le mot de passe vient d'être défini dans la session) et **partage rapide**
  vers e-mail / WhatsApp / Telegram / SMS (liens profonds, 100 % côté client).
- **Réception — nom d'expéditeur requis** : option par lien qui impose au visiteur
  de saisir un nom ; celui-ci est enregistré avec le dépôt (journal des transferts,
  activité en direct, notifications).
- **Réception — refus des exécutables** : option par lien qui inspecte les
  premiers octets (PE Windows, ELF, Mach-O/Java, shebang) et rejette un binaire
  déguisé même si l'extension est autorisée (ex. malware renommé `.jpg`).
- **Plafond de stockage de réception global** : nouvelle limite serveur (en Go,
  fractions acceptées) sur le total reçu par l'ensemble des liens de réception et
  de collaboration, en complément des quotas par lien existants.
- **Sonde `/healthz`** : endpoint public minimal (200 + version + uptime, sans
  secret) pour le `HEALTHCHECK` Docker et les moniteurs d'uptime.
- **Arrêt d'urgence** (owner/admin) : « Suspendre tous les liens » coupe
  immédiatement tout accès public (réversible, sans toucher aux fichiers) et
  « Réactiver tous les liens » lève la suspension. Chaque action est auditée.

Note : le **partage de texte/URL vers la PWA** (Web Share Target « text ») était
déjà pris en charge — un texte ou une URL partagé devient une note `.txt` ajoutée
à la file d'envoi.

Correctifs livrés avec ces ajouts :

- Édition d'un lien : une durée ou « Jamais » choisie dans le menu n'est plus
  neutralisée par la date exacte (le champ date démarre vide ; seule une date
  réellement saisie a priorité).
- Le **nom d'expéditeur** requis apparaît désormais réellement dans les
  notifications de réception (webhook / e-mail / push), pas seulement dans le
  journal.
- **« Réactiver tous les liens »** ne relève que les liens suspendus par l'arrêt
  d'urgence : un lien mis en pause manuellement auparavant le reste.
- Cache PWA incrémenté à `pwa143` et ressources versionnées `v=131`.

## PWA — fonctions avancées ajoutées (build pwa80)

- **Remplacement d’image sans changer le lien** : la nouvelle image conserve le même jeton public. Les dix versions précédentes peuvent être restaurées depuis la carte de l’image.
- **Liens de contribution temporaires** : un album peut recevoir des images via un lien limité dans le temps, en nombre de fichiers et en taille par fichier.
- **Albums collaboratifs avec rôles** : invitations `reader`, `contributor` et `manager`. Un lecteur consulte, un contributeur ajoute des images et un gestionnaire peut aussi retirer des éléments de l’album.
- **Optimisation adaptative** : l’URL `/i/<token>/auto` choisit Micro, Mini ou Pleine selon la largeur demandée et l’économie de données, puis privilégie AVIF ou WebP lorsque le navigateur les accepte et que la PWA a pu les générer.

Les secrets des invitations ne sont jamais stockés en clair : seul leur hachage SHA-256 est conservé dans les métadonnées du serveur.

## 1.36.1 — durcissement DLP PWA et serveur (build pwa142)

- Version du projet portée à `1.36.1`.
- Les analyses DLP incomplètes sont maintenant traitées de façon sûre : en mode `Bloquer` elles arrêtent le transfert, et en mode `Avertir` elles exigent une confirmation explicite.
- La PWA ne considère plus comme sûrs les fichiers trop volumineux, les fichiers au-delà de `dlpMaxFiles`, les ZIP tronqués/chiffrés ou utilisant une compression non inspectable.
- Les PDF mixtes sont OCRisés page par page pour la DLP locale, même lorsqu'une couche texte incorporée est déjà présente.
- Les résultats DLP persistés sont invalidés par une version du moteur afin qu'une mise à jour ne réutilise jamais un ancien `DLP ✓`.
- Le worker OCR est réutilisé pendant tout un lot DLP puis libéré, ce qui réduit fortement les rechargements Tesseract sur mobile.
- Si la PWA ne peut pas récupérer la politique DLP authentifiée du serveur, un nouvel upload est refusé jusqu'au retour du statut au lieu de retomber sur une politique potentiellement moins stricte.
- Côté serveur, une analyse partielle (taille, OCR, erreur de lecture ou ZIP borné) participe maintenant elle aussi aux décisions `Avertir/Bloquer`; les résumés exposent les causes d'incomplétude sans exposer de donnée sensible.
- Correction d'un cas où un lot PWA dépassant `dlpMaxFiles` pouvait continuer en mode `Avertir` sans confirmation lorsque tous les fichiers effectivement inspectés étaient sûrs. Les fichiers omis sont désormais marqués individuellement `DLP ?`.
- Cache PWA incrémenté à `pwa142` et ressources versionnées `v=130`.

## 1.36.0 — audit DLP et recherche sémantique (build pwa141)

- Version du projet portée à `1.36.0`.
- La DLP inspecte maintenant les fichiers texte courants auparavant invisibles (`.env`, `.pem`, `.key`, `Dockerfile`, fichiers sans extension) grâce à une détection de contenu texte bornée.
- Les archives ZIP sont inspectées de façon bornée : les petits membres textuels sont extraits pour la DLP et deviennent aussi indexables par la recherche globale/sémantique.
- Les PDF mixtes ne peuvent plus contourner la DLP OCR : si l'OCR DLP est activé, les pages rasterisées sont vérifiées même lorsqu'une couche texte est déjà présente ailleurs dans le PDF.
- Lors d'une création Images par lot, chaque image conserve uniquement son propre résumé DLP; une image sûre n'hérite plus du badge d'une autre image sensible du lot.
- La recherche sémantique recanonicalise les synonymes après stemming (`factures`, `contrats`, etc.), ce qui rétablit les correspondances multilingues sur les formes infléchies.
- Les extraits de résultats sémantiques privilégient désormais le passage de contenu qui a réellement déclenché le concept, plutôt que le début du document ou une correspondance de nom de fichier.
- La file principale de la PWA exécute maintenant un test DLP local avant tout upload vers un lien de réception, avec boutons de test par fichier, sélection ou lot complet, et indicateur par fichier.
- La PWA reprend la politique DLP du serveur (`Avertir`, `Bloquer`, `Journaliser`), analyse localement texte/configuration/ZIP et réutilise l’OCR local pour les images/PDF. En mode Bloquer, aucun octet n’est envoyé si une détection est trouvée; en mode Avertir, l’accord est mémorisé uniquement pour l’empreinte courante du fichier.
- Les résultats DLP locaux persistés ne contiennent que des échantillons masqués. Un OCR impossible est affiché comme analyse incomplète et ne peut pas apparaître comme un faux succès vert.
- Cache PWA incrémenté à `pwa141` et ressources versionnées `v=129`.

## 1.35.5 — sécurité DLP, recherche sémantique et correctifs (build pwa139)

- Version du projet portée à `1.35.5`.
- Correction du ZIP sélectif des liens de collaboration stockés hors de `/host`, avec conservation des chemins relatifs imbriqués.
- La purge de la corbeille ne supprime plus un dossier de réception/collaboration encore référencé par un autre lien actif ou restaurable.
- L’historique par fichier continue d’agréger au-delà des 1 000 événements détaillés affichés et signale lorsqu’une fenêtre de journal ou une liste de membres ZIP est tronquée.
- Correction des liens Télécharger/Afficher du lecteur PDF lorsque d’autres paramètres de requête sont présents.
- Correction du flux SSE « Activité en direct » : connexion maintenue après le snapshot, puis révoquée si la session admin expire ou se déconnecte.
- **DLP avancé avant publication** : analyse locale des fichiers et images avant création/extension d’un partage, avec politiques `Avertir + confirmer`, `Bloquer` ou `Journaliser`. Détection notamment des cartes Luhn, NAS/SIN canadien, IBAN, clés privées, clés AWS, jetons GitHub/Slack/JWT, secrets API/mots de passe, pièces d’identité contextualisées et marqueurs confidentiels. Les échantillons exposés au navigateur et à l’audit sont masqués.
- La DLP peut utiliser l’OCR serveur sur images/PDF scannés, avec limites configurables de fichiers et de taille. Elle couvre aussi la création et le remplacement d’images depuis la PWA; un refus n’écrase jamais l’image publique existante.
- **Recherche sémantique globale locale** : mode hybride au-dessus de l’index persistant (texte, OCR, PDF, Office, ZIP, Images), avec expansion multilingue français/anglais/espagnol, normalisation/stemming léger, pondération par rareté et classement par pertinence. Aucun contenu n’est envoyé à un service d’embeddings externe.
- Cache PWA incrémenté à `pwa139` et ressources versionnées `v=127`.

## 1.35.4 — correctifs des règles de partage et maintenance (build pwa137)

- Version du projet portée à `1.35.4`.
- Séparation de l'expiration fixe et de l'expiration après première utilisation : modifier/désactiver cette règle ne laisse plus une ancienne échéance bloquée dans `expiresAt`.
- Migration automatique et conservative des échéances « première utilisation » créées par les versions 1.35.3 et antérieures.
- Le dashboard expose et utilise maintenant l'**échéance effective** (date fixe, première utilisation ou inactivité) pour le tri, les cartes, la barre de progression et les statistiques détaillées.
- Les rappels d'expiration sont correctement réarmés après changement de configuration, y compris pour les règles première utilisation et inactivité.
- Les liens sans aucune échéance n'affichent plus un trompeur « rappel global ».
- Les valeurs par défaut d'expiration/rappel invalides sont refusées au lieu d'être silencieusement converties en zéro.
- Le résumé de stockage des partages utilise `logicalBytes`, ce qui inclut correctement les dossiers.
- Cache PWA incrémenté à `pwa137` et ressources versionnées `v=125` afin de forcer le renouvellement des installations existantes.
- **Corbeille restaurable** : les suppressions manuelles et les liens expirés après leur délai de grâce restent récupérables pendant la durée configurée (30 jours par défaut, 0 = conservation illimitée). Les sauvegardes Direct-Xfer conservent aussi la corbeille.
- **ZIP sélectif renforcé** : Tout/Aucun, sélection bornée à 2 000 entrées, chemins/indices strictement validés et dédupliqués, avec journalisation des membres téléchargés.
- **Prévisualisation PDF intégrée** : les PDF s'ouvrent dans le shell Direct-Xfer au lieu d'un onglet brut, avec affichage same-origin compatible avec le lecteur PDF du navigateur.
- **Historique des téléchargements par fichier** : vue groupée par fichier avec réussites/interruption, volume, date, IP/pays/destinataire et prise en compte des fichiers inclus dans les ZIP (jusqu'à 500 membres journalisés par ZIP).
- **Activité en direct** : flux SSE authentifié du dashboard pour uploads, téléchargements, OCR, antivirus, erreurs, corbeille et actions auditées, avec heartbeat compatible reverse proxy.

## 1.35.3 — maintenance

- Version du projet portée à `1.35.3`.
- Cache PWA incrémenté à `pwa136` et ressources versionnées `v=124` afin de forcer le renouvellement des installations existantes.
- Conserve les correctifs et fonctionnalités de la branche 1.35.2.
- Migration automatique et sûre de la clé locale du journal d’audit vers `AUDIT_HMAC_KEY` : vérification préalable, sauvegardes transactionnelles temporaires, re-signature complète, vérification finale, trace `audit-key-migrated`, reprise après interruption et refus de migrer une chaîne altérée.

- Pack de gestion des partages : QR directement dépliable sur chaque carte, ouverture dans un nouvel onglet, couleur et étiquettes personnalisées, description Markdown publique et commentaires administrateur privés datés.
- Valeurs par défaut configurables pour couleur, étiquettes, description Markdown, rappel d'expiration, expiration après première utilisation et expiration après inactivité.
- Réinitialisation des statistiques visibles sans remettre à zéro les compteurs servant aux quotas; la modale de statistiques détaillées respecte la même ligne de base.
- Les cartes affichent le dernier téléchargement et le dernier envoi réussis, ainsi qu'une barre de progression vers la prochaine expiration (date fixe ou inactivité).
- Rappels d'expiration configurables par partage, y compris pour une échéance d'inactivité; une nouvelle activité repousse l'échéance et réarme proprement le rappel.
- Expiration optionnelle après la première utilisation complète et expiration après une période d'inactivité, avec conservation de l'activité historique lors de l'activation sur un ancien partage.

## 1.35.2 — maintenance

- Version du projet portée à `1.35.2`.
- Cache PWA incrémenté à `pwa135` et ressources versionnées `v=123` afin de forcer le renouvellement des installations existantes.
- Inclut l’ensemble des ajouts et correctifs livrés dans la série 1.35.1.

## 1.28.0 — correctifs de connexion et installation mobile

- Le mot de passe administrateur n’est conservé dans le coffre chiffré que lorsque la case correspondante est cochée.
- Direct-Xfer n’enregistre plus les identifiants dans le gestionnaire de mots de passe du navigateur, ce qui permet à la case de rester l’unique source de vérité.
- Les anciens secrets du coffre local sont supprimés automatiquement lorsque la mémorisation est désactivée.
- Le logo Installer est de nouveau disponible sur la connexion mobile et reste visible pendant la préparation de l’invite native.
- Cache PWA de la version 1.28.0 : `pwa82`.


## PWA — reprise après fermeture (build pwa80)

- Avant le premier bloc réseau, chaque fichier est copié dans l’**Origin Private File System (OPFS)** du navigateur lorsque cette API est disponible.
- IndexedDB ne conserve que les métadonnées légères : destination, identifiant stable d’envoi, état et intention de reprise.
- Si Android ferme la PWA, le fichier et l’identifiant d’envoi restent présents. À la prochaine ouverture, Direct-Xfer interroge le serveur pour connaître le dernier octet reçu et reprend automatiquement à cet endroit.
- Les versions préparées (optimisation, nettoyage EXIF/GPS ou chiffrement) sont elles aussi conservées localement lorsqu’il reste assez d’espace.
- Les transferts actifs sont enregistrés lors de `pagehide` et lorsque l’application passe en arrière-plan.
- La suppression d’un transfert, sa réussite ou l’effacement des données locales supprime également ses fichiers OPFS.

Une PWA ne peut pas garantir que le réseau continue à travailler après sa fermeture complète par Android. Cette fonction garantit la **conservation et la reprise automatique à la réouverture**.


## 1.29.0 — interface « Liens d’image » réorganisée (build pwa85)

- La création de liens, les options avancées et la bibliothèque d’images sont maintenant séparées en zones distinctes.
- Le sélecteur de format favori et le nettoyage EXIF/GPS sont regroupés avec l’ajout d’images.
- La recherche, le tri et les filtres sont réunis dans une barre de gestion adaptée au mobile.
- Les actions globales (copie groupée, QR et export CSV) sont rangées dans un panneau repliable.
- Chaque carte d’image distingue clairement l’identité, les statistiques globales, les variantes Pleine/Mini/Micro et les actions.
- Sur petit écran, les variantes et les groupes d’actions passent automatiquement sur une seule colonne.
- Les aperçus ouverts depuis la PWA utilisent maintenant une route propriétaire authentifiée et ne modifient plus les vues ni les visiteurs publics.
- Après une mise à jour, un appareil jumelé retrouve aussi les images des versions précédentes appartenant au compte qui l’a jumelé; les anciens enregistrements sans identifiant moderne restent récupérables par un appareil d’administrateur.
- Cache PWA de la version 1.29.0 : `pwa85`, afin de forcer la mise à jour des installations existantes.


## 1.30.0 — appareil d’origine, EXIF/GPS et indicateurs de confidentialité (build pwa87)

- La page Images standard affiche le nom de l’appareil ayant téléversé chaque nouvelle image.
- Les images envoyées par la PWA conservent le nom de l’appareil jumelé; les ajouts Web, les fichiers choisis sur l’hôte et les contributions d’album reçoivent aussi une origine lisible.
- Un bouton **EXIF / GPS** ouvre une fenêtre d’information à la demande avec l’appareil photo, l’objectif, la date, l’exposition, les dimensions et les coordonnées disponibles.
- Les coordonnées GPS ne sont jamais ajoutées aux réponses périodiques de la galerie : elles sont lues uniquement après un clic, via une route administrateur authentifiée.
- La lecture prend en charge les blocs TIFF/EXIF intégrés aux fichiers JPEG, PNG et WebP, sans nouvelle dépendance serveur.
- Un lien OpenStreetMap est proposé lorsque des coordonnées valides sont présentes.
- Cache PWA de la version 1.30.0 : `pwa87`.


- Indicateur persistant « EXIF/GPS supprimés » sur toutes les interfaces d’images.


## 1.30.1 — version de maintenance et persistance PWA (build pwa89)

- Version du projet et du verrou de dépendances conservée à `1.30.1`.
- Les fiches des images mises en ligne sont mises en cache dans IndexedDB et restaurées immédiatement au redémarrage, même hors ligne, avant la resynchronisation avec le serveur.
- L’historique local des transferts dispose maintenant d’une sauvegarde redondante dans IndexedDB et `localStorage`; l’historique des actions d’image est migré vers IndexedDB.
- L’état persistant est enregistré avant la fermeture de la PWA et avant l’activation d’une nouvelle version du service worker.
- La PWA demande silencieusement au navigateur de protéger son stockage contre l’éviction automatique lorsqu’il le permet.
- Cache PWA incrémenté à `pwa89` pour déployer le correctif sur les installations existantes.

## 1.30.2 — version de maintenance (build pwa90)

- Version du projet et du verrou de dépendances portée à `1.30.2`.
- Les correctifs de persistance des images et des historiques introduits en 1.30.1 sont inclus sans changement de format de données.
- Cache PWA incrémenté à `pwa90` pour forcer le déploiement de cette version sur les installations existantes.


## 1.30.2 — fermeture de session PWA (build pwa91)

- Ajout d’un bouton **Fermer la session** au bas des réglages de la PWA.
- La fermeture conserve les transferts, images et historiques locaux persistants.
- L’appareil jumelé est verrouillé plutôt que supprimé afin de préserver l’accès futur aux images qu’il a créées.
- Une nouvelle connexion administrateur déverrouille automatiquement le même appareil.
- Les flux en direct, notifications push et caches de navigation privés sont arrêtés ou purgés à la fermeture.

## 1.30.3 — persistance des images après actualisation (build pwa92)

- La synchronisation de la bibliothèque PWA fusionne désormais les réponses du serveur avec le cache IndexedDB au lieu d’effacer entièrement ce cache.
- Une réponse `/app/images` ancienne ou momentanément incomplète ne peut plus supprimer une image qui vient d’être téléversée.
- Les requêtes de statistiques concurrentes sont annulées lorsqu’une synchronisation plus récente démarre.
- Toute image absente de la liste générale est vérifiée individuellement par sa route authentifiée avant d’être considérée supprimée.
- Trois confirmations directes et un délai de grâce sont requis avant d’effacer une fiche locale; les révocations demandées dans la PWA restent immédiates.
- Version du projet portée à `1.30.3` et cache PWA incrémenté à `pwa92`.


## 1.30.4 — restauration robuste des images et version PWA (build pwa93)

- La version `1.30.4` est affichée directement dans le pied de page, avant toute restauration asynchrone, avec une valeur HTML de secours si JavaScript s'interrompt.
- La bibliothèque d'images est restaurée avant les transferts et l'historique afin qu'un ancien enregistrement de file d'attente invalide ne puisse plus bloquer les images.
- Une copie compacte des fiches d'images est conservée dans `localStorage` en plus d'IndexedDB et fusionnée au démarrage.
- La synchronisation réseau des images, des albums et des réglages est isolée avec `Promise.allSettled`, de sorte qu'une erreur d'un sous-système n'empêche plus les autres de démarrer.
- Cache PWA incrémenté à `pwa93`.

## Correctif 1.30.6 — identité PWA durable par compte (build pwa98)

- La connexion mobile passe maintenant par `/app/login` et associe automatiquement le navigateur à une identité PWA persistante.
- Les images, albums et liens de réception créés depuis un appareil sont également rattachés au compte qui a autorisé cet appareil.
- Si Android supprime ou remplace le cookie d’appareil, une nouvelle connexion au même compte récupère automatiquement l’espace de travail précédent.
- Une table de correspondance durable conserve le compte propriétaire des anciennes identités d’appareil afin de migrer les enregistrements existants sans élargir l’accès aux autres comptes.
- Cache PWA `pwa98` et manifeste `v=86`.

## 1.30.6 — déconnexion, appairage, logo et persistance PWA (build pwa98)

- Le bouton « Fermer la session » exécute désormais les sauvegardes locales, PushManager et CacheStorage avec des délais maximums afin qu’une promesse Android bloquée ne puisse plus laisser le bouton grisé indéfiniment.
- Après confirmation du serveur, la redirection vers la connexion est garantie même si le nettoyage local du cache tarde à répondre; en cas d’échec réseau réel, le bouton est réactivé avec un message clair.
- Les boutons « Appairer cet appareil » et « Désappairer cet appareil » sont de nouveau explicites dans les réglages et leur état est chargé indépendamment de la restauration des transferts et des images.
- Le logo de la page de connexion utilise désormais la ressource SVG valide; les icônes PNG 192, 512, maskables et Apple Touch ont aussi été régénérées avec des en-têtes PNG conformes.
- Correction définitive du rafraîchissement de la galerie : `/app/` embarque maintenant un instantané authentifié des images dans le document HTML, avant IndexedDB et avant l'appel secondaire à `/app/images`.
- Le journal local des images est fusionné avec IndexedDB, la mémoire active et la réponse serveur; une réponse partielle ne peut plus écraser la copie de secours d'une image fraîchement téléversée.
- Version du projet maintenue à `1.30.6`, cache PWA incrémenté à `pwa98` et manifeste versionné `v=86`.

## 1.31.0 — version de consolidation PWA (build pwa99)

- Version du projet portée à `1.31.0`.
- Tous les correctifs de persistance de l’espace de travail, d’images, de session, d’appairage et de logo de la branche 1.30.x sont conservés.
- Cache PWA incrémenté à `pwa99` et manifeste versionné `v=87` afin de forcer le renouvellement des ressources sur les installations existantes.

## 1.31.2 — galerie d’images restaurée sur la PWA installée (build pwa101)

- Correction d’un blocage où **rien ne s’affichait dans l’onglet Images de la PWA installée sur Android** après un rafraîchissement, une déconnexion/reconnexion ou un relancement, alors que le serveur renvoyait bien les images (visibles sur navigateur de bureau).
- Cause : `indexedDB.open()` pouvait rester **bloqué indéfiniment** dans certains contextes WebAPK/WebView Android (événement `blocked`, ou aucune réponse). Le premier `await` IndexedDB de l’initialisation restait alors suspendu et l’étape qui charge les images depuis `/app/images` n’était jamais atteinte.
- `openDb()` gère désormais `onblocked` et un **délai maximum** : en cas de blocage, l’initialisation se poursuit via la sauvegarde `localStorage` et les API réseau au lieu de figer la galerie.
- Le rendu de chaque carte d’image est isolé (`try/catch`) : une seule fiche défaillante ne peut plus vider toute la liste.
- Nouveau **panneau de diagnostic** accessible via `/app/?diag=1` (bootstrap serveur, IndexedDB, `/app/images`, cartes en mémoire/DOM) pour diagnostiquer un souci d’affichage directement sur l’appareil.
- Version portée à `1.31.2`, cache PWA `pwa101`, manifeste `v=89`.

## 1.31.1 — session PWA préservée au relancement (build pwa100)

- Les cookies d’authentification `sid` (session admin) et `dxpwa` (appareil PWA) passent de `SameSite=Strict` à `SameSite=Lax`. Un cookie `Strict` n’est pas transmis lors d’une navigation de haut niveau *cross-site* — c’est précisément le cas d’une PWA installée lancée depuis l’écran d’accueil (WebAPK) et d’un partage système (Web Share Target). L’application arrivait alors non authentifiée et l’espace de travail paraissait réinitialisé après une déconnexion/reconnexion ou un relancement.
- Le correctif ne réduit pas la protection CSRF : chaque mutation exige toujours un jeton `X-CSRF-Token` (`requireAuth` / `requireAppAuth`) et, sous `/app`, un contrôle d’origine exacte même sur les sous-domaines frères.
- Version du projet portée à `1.31.1`, cache PWA incrémenté à `pwa100` et manifeste versionné `v=88` afin de forcer le renouvellement des ressources sur les installations existantes.


## 1.35.0 — audit, protection et recherche universelle (build pwa132)

- Version du projet portée à `1.35.0`.
- Inclut le journal d’audit cryptographiquement vérifiable, la protection contre les comportements de type ransomware et la recherche serveur universelle persistante.
- La recherche universelle de la version complète indexe maintenant aussi l’OCR serveur des images et PDF scannés. Les résultats OCR sont mis en cache dans `/data/search-ocr-cache.json`; les PDF ayant déjà une couche texte ne sont pas rasterisés inutilement.
- Correctifs de robustesse de l’index/audit : l’index OCR et son cache suivent désormais `DATA_KEY` au repos, les packs de langues Tesseract sont vérifiés avant d’annoncer l’OCR disponible, les couches texte PDF ne sont plus dupliquées, les purges déclenchent une réindexation, et l’audit détecte une tête manquante ainsi que les rollbacks/troncatures par rapport à l’ancre mémorisée.
- Cache PWA incrémenté à `pwa132` et ressources versionnées `v=120` pour forcer le renouvellement des installations existantes.


## 1.35.0 — OCR de la section Images (build pwa133)

- La recherche de la section Images de la version complète interroge aussi l’index OCR serveur persistant.
- Les photos gérées par Images sont indexées comme documents OCR de premier niveau et les anciens liens host-backed restent indexables si leur copie Full manque.
- La PWA recherche également le texte OCR serveur dans ses images et permet de lancer un OCR local directement depuis une carte Images; le résultat est ajouté à l’index OCR IndexedDB avec le token de l’image.
- Cache PWA `pwa133`, ressources `v=121`.


## 1.35.1 — maintenance OCR Images (build pwa134)

- Version du projet portée à `1.35.1`.
- Conserve les correctifs d’indexation OCR de la section Images sur la version complète et la PWA.
- Cache PWA incrémenté à `pwa134` et ressources versionnées `v=122` afin de forcer le renouvellement des installations existantes.

## 1.35.1 — statistiques stockage et diagnostic intégré

- Le tableau de bord regroupe maintenant le **stockage et le trafic par grande catégorie de fichier** (images, vidéo, audio, documents, archives, code, autres), avec volume stocké, nombre de fichiers, trafic et nombre de transferts.
- Nouveau **rapport de stockage Direct-Xfer** : réception, originaux Images, Mini/Micro, historique/versions/adaptatif, partages E2E, secrets, quarantaine, index/OCR, journaux, métadonnées et fichiers temporaires/partiels récupérables.
- Nouvel **assistant de diagnostic intégré** (owner/admin) : tests réels d’écriture des volumes, espace disque, persistance Docker, intégrité de l’audit, index de recherche, OCR/Tesseract/Poppler, ClamAV, chiffrement, notifications, ressources PWA, port public et reverse proxy.
- Ces ajouts concernent l’interface complète et ne nécessitent pas de changement du shell PWA; le build reste `pwa134` / ressources `v=122`.

## 1.35.1 — Productivité des partages (ajouts 1 à 15)

- Duplication d’un partage existant avec remise à zéro de son état d’utilisation.
- Renommage direct depuis la liste et notes privées d’administration.
- Épinglage/favoris et archivage manuel sans désactiver le lien public.
- Filtres avancés par taille et date, avec période personnalisée, et tri par activité récente.
- Sélection multiple enrichie : copie des liens, épinglage, archivage, tags, expiration et révocation.
- Expiration rapide par partage : 1 h, 24 h, 7 j, 30 j ou jamais.
- Prolongation réelle d’un partage existant (+1 j / +7 j ou action en masse), calculée à partir de son expiration actuelle lorsqu’elle est encore future.
- Badges « Jamais utilisé » et « Très actif » fondés sur l’activité réelle du partage.
- Historique borné des changements administratifs (100 entrées par partage) avec acteur, date et champs modifiés. Les mots de passe ne sont jamais inscrits dans cet historique ; seule leur présence peut être enregistrée.
- Les volumes des liens de réception/collaboration utilisent les octets réellement reçus pour les filtres par taille.
- Validation : 234/234 tests automatisés réussis pour cette livraison.

## 1.58.2 — Modale de partage Firefox / écrans 4K

- Corrige le défilement de « Créer un lien de partage » sous Mozilla Firefox, y compris avec écran 3840×2160, mise à l’échelle Windows élevée et zoom navigateur.
- La hauteur de la modale est calculée en pixels à partir du viewport réellement utilisable plutôt que de dépendre uniquement de `vh`/`dvh`.
- Le corps de la modale possède désormais un défilement vertical explicite et permanent ; l’overlay ne participe plus au scroll.
- Le navigateur de fichiers conserve au minimum environ 6–7 lignes sur les viewports courts au lieu de tomber à ~3 lignes, et monte jusqu’à 720 px sur les grands écrans.
- Ajoute un transfert explicite de la molette du navigateur de fichiers vers le corps de la modale lorsque la liste atteint son début ou sa fin, pour contourner les différences de scroll chaining de Firefox.
- Bump **1.58.2**, PWA **pwa276**, ressources **v262**, runtime Windows **launcher20**.

## 1.58.1 — Modale de partage et stockage interne propre

- La modale **Créer un lien de partage** reste entièrement défilable sur les écrans courts, en paysage, avec zoom élevé et sur les navigateurs mobiles à viewport dynamique.
- Le dialogue est ancré dans le viewport et son corps central possède son propre défilement tactile, tandis que l’en-tête et les actions restent accessibles.
- Les fichiers partiels des téléversements reprenables ne sont plus écrits dans le dossier de réception utilisateur (`.dxparts`) : ils vivent désormais sous le dossier de données interne de Direct-Xfer.
- Migration sûre des anciens fichiers `.dxparts` vers le stockage interne au premier démarrage, avec suppression du dossier legacy uniquement s’il est vide.
- Le nettoyage des connecteurs de stockage ne crée plus un dossier `Imports` vide au démarrage. Les anciens dossiers `Imports` contenant uniquement le staging interne vide sont automatiquement nettoyés.
- Bump **1.58.1**, PWA **pwa275**, ressources **v260**, runtime Windows **launcher19**.

## 1.58.3 — Modale de partage et sélecteur 10 fichiers

- La modale **Créer un lien de partage** utilise désormais une structure stricte en trois zones (en-tête, corps défilable, pied fixe) afin d'éviter le dépassement vertical sous Firefox, y compris avec écran 4K, mise à l'échelle Windows et zoom navigateur.
- Le sélecteur de fichiers réserve **10 lignes de fichiers visibles simultanément** sur les écrans disposant d'une hauteur suffisante.
- Lorsqu'un dossier parent est disponible, sa ligne obtient une hauteur supplémentaire afin de conserver 10 entrées de fichiers/dossiers visibles en plus du bouton parent.
- Les noms très longs restent sur une ligne avec ellipse pour qu'ils ne réduisent plus artificiellement le nombre de fichiers visibles.
- Sur les petites hauteurs, le sélecteur reste adaptatif et la zone d'options défile sans masquer les boutons Annuler/Partager.
- Bump **1.58.3**, PWA **pwa277**, ressources PWA **v263**, runtime Windows **launcher21**.

## 1.59.3 — Supervision Windows séparée et favicon admin

- La supervision du backend Node.js est sortie de `Direct-Xfer.exe` et confiée à un nouvel exécutable dédié **`Direct-Xfer.ServerHost.exe`**.
- `Direct-Xfer.exe` redevient essentiellement l’interface/systray : il ne lance plus directement `node.exe`, ne redirige plus ses flux et ne termine plus le processus Node.
- `Direct-Xfer.ServerHost.exe` fonctionne sous le même compte utilisateur, conserve donc les permissions sur les dossiers choisis dans Direct-Xfer, et possède seul la validation du runtime/Node, le démarrage, la journalisation, l’arrêt propre et le dernier recours de terminaison du child Node exact.
- Le ServerHost protège la reprise du processus Node avec PID, chemin et heure de démarrage ; le launcher valide le binaire ServerHost attendu, exige que son IPC nommé soit vivant et n’utilise aucune API de supervision de processus.
- L’installateur protège le launcher avec `AppMutex`, arrête explicitement le ServerHost via son événement IPC avant mise à jour/désinstallation, et GitHub Actions compile, vérifie et package les deux exécutables x64.
- L’interface d’administration expose maintenant le **logo rond principal Direct-Xfer** comme favicon de l’onglet du navigateur (`/favicon.png`).
- Les deux exécutables Windows et le Setup restent volontairement **non signés Authenticode** ; le workflow vérifie ce choix explicitement et conserve les empreintes SHA-256.
- Bump **1.59.3**, PWA **pwa282**, ressources **v268**, launcher **launcher29-csharp**, ServerHost **serverhost2-csharp**.
- Hotfix UI : les boutons `×` du centre de notifications sont maintenant dessinés géométriquement et parfaitement centrés dans leur zone cliquable, dans la vue standard comme dans la PWA. La feuille CSS PWA utilise `app.css?v=269` pour forcer le rafraîchissement du correctif sans changer la version applicative.

## 1.59.1 — Durcissement du launcher Windows

- Le launcher C#/.NET 10 est compilé explicitement en **x64**, aligné avec le runtime Node.js x64 fourni.
- Le manifeste Windows utilise l’identité **DirectXfer.WindowsLauncher 1.59.1.0**, `asInvoker`, DPI-aware et long-path-aware au lieu de l’identité générique `MyApplication.app`.
- Les requêtes HTTPS privées du launcher vers `127.0.0.1` n’acceptent plus tous les certificats : la validation Windows reste prioritaire et le mode Local CA n’autorise une chaîne non approuvée que si elle remonte exactement vers la racine Direct-Xfer locale et sans erreur de nom.
- Le fallback automatique vers un `node.exe` trouvé dans `PATH` ou `Program Files` est retiré. Un Node externe doit être explicitement configuré avec `DX_WINDOWS_NODE` **et** épinglé avec `DX_WINDOWS_NODE_SHA256`, être un PE AMD64 normal et utiliser une version supportée.
- Le runtime Node embarqué reste vérifié par SHA-256 et doit correspondre exactement à **Node.js 24.19.0 x64**.
- Le workflow GitHub Actions produit volontairement `Direct-Xfer.exe` et le Setup Inno sans signature Authenticode et génère leurs empreintes SHA-256.
- Bump **1.59.1**, PWA **pwa280**, ressources **v266**, runtime Windows **launcher27-csharp**.

## 1.59.0 — Audit approfondi du launcher C# et de l’installateur Windows

- Le launcher Windows reste entièrement **C# / WinForms / .NET 10** ; aucun launcher Go, packer ou archive applicative auto-extraite n’est réintroduit.
- Les écritures de configuration utilisent un fichier temporaire unique et un remplacement atomique ; un backup valide laissé par une interruption Windows est maintenant récupéré automatiquement avant de considérer le démarrage comme une nouvelle installation.
- La reprise d’une ancienne session Windows vérifie le **PID, le chemin exact de `node.exe` et l’heure de démarrage du processus** avant tout arrêt forcé, ce qui empêche de viser un processus Node sans rapport après réutilisation d’un PID.
- La détection de Node préfère le runtime officiel embarqué et haché ; la sonde `node --version` est bornée dans le temps et les fallbacks système sont alignés sur le contrat courant **Node 20 ou Node 22+**.
- Le démarrage du serveur dispose désormais d’un délai de disponibilité explicite de **30 secondes**. En cas de processus vivant mais jamais prêt, le launcher affiche le journal puis ferme proprement le child au lieu de laisser une systray inutilisable.
- L’installateur Inno Setup purge les arbres immuables `runtime\\app` et `runtime\\node` avant une mise à niveau pour empêcher qu’un ancien module ou asset supprimé survive à la nouvelle version.
- Le lancement post-installation est explicitement effectué avec l’utilisateur d’origine lorsque le contexte Inno le permet.
- Le workflow GitHub Actions utilise Node.js **24.19.0** de façon reproductible, bloque les avis npm de gravité élevée/critique et exécute les tests de régression des changements récents avant MSBuild/Inno Setup.
- Les noms d’artefacts GitHub sont dérivés de `DX_VERSION` afin de limiter les désynchronisations de version.
- Bump **1.59.0**, PWA **pwa279**, ressources **v265**, runtime Windows **launcher26-csharp**.
