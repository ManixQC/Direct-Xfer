# Direct-Xfer 1.64.0

Direct-Xfer is a self-hosted application for direct file sharing and reception, collaboration links, image hosting, encrypted shares, administration, and an installable companion PWA. It is designed to run locally or behind an HTTPS reverse proxy, with Docker/Unraid and Windows packaging included in this source tree.

## Main interfaces

- **Standard administration** — shares, reception links, collaborations, image links, activity, notifications, search, configuration and dashboards.
- **Images** — Full/Mini/Micro self-hosted image links, statistics, editor and revocation history.
- **PWA (`/app`)** — mobile sending, share target, resumable transfers, background synchronization, biometrics/passkeys, notifications and administration tools.
- **Server Health dashboard** — CPU/RAM/storage/process/event-loop metrics, 24 h/7 d/30 d history, volumes, backups, network/reverse proxy, TLS/CA, audit, connectors, search/OCR and security state.

## Highlights in 1.64.0

- Standard view productivity: three display densities, side detail drawer, pinned shares, colored labels, quick duplication and configurable quick actions.
- Standard operations: context menu, undoable action center, “To handle” center, daily summary, visitor-side link test, missing-source detection, customizable dashboard and guided diagnostics.
- PWA administration: server health/history, reverse-proxy and TLS diagnostics, local CA management, global pause/resume, signed audit viewer and remote storage connectors/imports.
- PWA transfer intelligence: persistent Android transfer notifications, moving ETA, network error history, dynamic parallelism, large-file Wi-Fi policy, unified timeline, Android shortcuts/quick widget surface and voice universal search.
- Signed append-only audit journal with Ed25519 proof export and offline verifier.
- Storage connectors through rclone: SFTP, SMB, WebDAV, Google Drive, OneDrive, Dropbox and Box.
- Server-to-server remote import into the Direct-Xfer reception/import area.

## Docker

1. Copy `docker-compose.yml` and update the host paths for `/Images` and `/Direct-Xfer`.
2. Start the application:

```bash
docker compose up -d --build
```

3. Open `http://SERVER-IP:55750/` from an allowed administration network.

The default container port is `55750`. Persistent metadata is stored under `/data`. Host files are mounted read-only under `/host` by the reference compose file.

### Important environment variables

- `PORT` / `DX_PORT`
- `DATA_DIR`
- `HOST_ROOT`
- `IMAGES_DIR`
- `INBOX_DIR`
- `PUBLIC_URL`
- `TRUST_PROXY`
- `ADMIN_ALLOWED_IPS`
- `DATA_KEY`
- `AUDIT_HMAC_KEY`
- `TLS_SELF_SIGNED`, `TLS_CERT`, `TLS_KEY`
- `RCLONE_CONFIG`
- `PUID`, `PGID`

See the comments in `docker-compose.yml` for the complete deployment reference.

## HTTPS and PWA

A real installed Android PWA/WebAPK requires a secure context. Use a trusted HTTPS reverse proxy, or Direct-Xfer native HTTPS with a certificate trusted by the device. Configure `PUBLIC_URL` to the public HTTPS origin. When a reverse proxy is used, configure `TRUST_PROXY` appropriately so Direct-Xfer can validate origins and client addresses correctly.

## Windows

The complete Windows source is included again:

- `windows-launcher/` — .NET Framework 4.8 tray launcher.
- `windows-server-host/` — .NET Framework 4.8 background supervisor for Node.js.
- `installer/` — Inno Setup installer definition.
- The Windows runtime is generated into `dist/.../runtime/` by CI from the root application sources; no redundant prebuilt `runtime/` copy is kept in the source tree.
- The pinned `node.exe` is downloaded during the Windows build and SHA-256 verified before packaging.

The Windows executables are intentionally unsigned. The GitHub Actions workflow verifies they remain unsigned and produces the portable package and installer artifacts.

## Unraid

`unraid/direct-xfer.xml` and `unraid/direct-xfer.png` provide the Unraid template metadata and icon. The Docker compose labels also expose the WebUI and icon when Compose Manager is used.

## Security

Direct-Xfer includes, among other controls:

- salted password hashing and role-based administration;
- LAN/admin-IP restrictions and reverse-proxy awareness;
- encrypted metadata support through `DATA_KEY`;
- HMAC audit-chain integrity and Ed25519 proof signing;
- DLP rules and destructive-event protections;
- optional ClamAV integration;
- TLS/local CA diagnostics;
- bounded uploads, ZIP generation, OCR/indexing and remote connector jobs;
- path traversal/reparse-point/symlink protections in sensitive storage operations.

## Audit proof verification

```bash
node scripts/verify-audit-proof.js proof.json --public-key audit-public.pem
```

or, for integrity-only verification without establishing signer identity:

```bash
node scripts/verify-audit-proof.js proof.json --allow-embedded-key
```

## Development and tests

Install dependencies:

```bash
npm ci
```

Run the tests shipped with this reconstructed 1.64.0 tree:

```bash
npm test
```

The build workflow additionally validates JavaScript syntax, generates the Windows runtime from the root application sources, and validates C# packaging metadata and installer inputs.

## Repository layout

```text
.github/workflows/      CI / Windows build
installer/              Inno Setup
lib/                    backend modules
public/                 standard administration UI
pwa/                    companion PWA
scripts/                administrative/offline utilities
security/               security metadata
server.js               Direct-Xfer server entry point
test/                    current validation suite
unraid/                  Unraid template and icon
windows-launcher/        C# tray launcher
windows-server-host/     C# background Node supervisor
```

## Version

- Direct-Xfer: **1.64.0**
- PWA build: **2026.08.16-pwa325**
- Windows launcher runtime marker: **1.64.0-launcher53-csharp**
- Windows ServerHost: **1.64.0-serverhost26-csharp**
