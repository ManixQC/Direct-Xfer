# Direct-Xfer VERSION

Official Windows release of Direct-Xfer.

## Windows downloads

- `Direct-Xfer-Setup-VERSION.exe` — Windows x64 installer
- `Direct-Xfer-VERSION-Windows-CSharp.zip` — portable Windows package
- SHA-256: add the published hashes here

Signing status: **replace with either “Signed with SignPath Foundation” or “Unsigned release candidate — SignPath Foundation application pending”.**

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Source: https://github.com/ManixQC/Direct-Xfer

Code signing policy: https://github.com/ManixQC/Direct-Xfer/blob/main/CODE_SIGNING_POLICY.md

Privacy policy: https://github.com/ManixQC/Direct-Xfer/blob/main/PRIVACY.md

When the release is signed, `Direct-Xfer.exe`, `Direct-Xfer.ServerHost.exe` and `Direct-Xfer-Setup-VERSION.exe` are built by GitHub Actions and verified with Authenticode before publication.

## Installation / system changes

The installer requests administrator privileges to install Direct-Xfer under Program Files. It explicitly offers startup registration, automatic update checks and public-IP discovery as visible choices, and provides automated uninstallation through Windows Installed apps.
