# Direct-Xfer — Inno Setup

This directory contains the Windows installer definition for Direct-Xfer 1.59.0.

The GitHub Actions workflow `.github/workflows/build-windows-csharp.yml` performs the full Windows build:

1. Installs production Node dependencies with `npm ci`.
2. Blocks the build if `npm audit` reports a **high or critical** production advisory.
3. Runs the release-critical regression suite for the latest Windows/Firefox/Inno changes.
4. Builds `windows-launcher/DirectXfer.Launcher.csproj` in Release mode.
5. Creates the portable runtime tree.
6. Downloads the pinned official Node.js 24.19.0 x64 `node.exe` from nodejs.org and verifies its SHA-256 before packaging.
7. Downloads the official signed Inno Setup 6.7.3 compiler installer and verifies its Authenticode signature before installing it on the ephemeral GitHub runner.
8. Compiles `installer/Direct-Xfer.iss` with `ISCC.exe`.
9. Produces `Direct-Xfer-Setup-1.59.0.exe` plus SHA-256 metadata.
10. Uploads both the installer and the portable package as GitHub Actions artifacts.

## Installed layout

The installer places Direct-Xfer under `Program Files\\Direct-Xfer` and includes:

- `Direct-Xfer.exe`
- `Direct-Xfer.exe.config`
- `runtime\\app\\...`
- `runtime\\node\\node.exe`

User configuration, logs and Direct-Xfer data remain under the user's LocalAppData paths managed by the C# launcher, so the installed application directory does not need write permission.

## Upgrades

The `AppId` in `Direct-Xfer.iss` is intentionally stable. Keep it unchanged in future releases so Inno Setup recognizes upgrades of the same application. Before copying a new release, the installer deletes only the immutable `runtime\app` and `runtime\node` trees so removed dependencies or assets from an older version cannot survive an upgrade. User data under LocalAppData is not touched.

## Code signing

The generated Direct-Xfer installer is not Authenticode-signed unless a later signing stage is added to the workflow. For managed enterprise distribution, signing both `Direct-Xfer.exe` and the final Setup EXE with an approved code-signing certificate is recommended.
