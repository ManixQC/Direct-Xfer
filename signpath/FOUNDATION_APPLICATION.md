# SignPath Foundation application notes — Direct-Xfer

This file is a ready reference for the one-time SignPath Foundation Open Source application. Verify the public repository/release details before submitting them to SignPath.

## Project

- Project name: Direct-Xfer
- Repository: https://github.com/ManixQC/Direct-Xfer
- Homepage/download location: GitHub repository and GitHub Releases
- License: MIT
- Primary Windows artifacts: `Direct-Xfer.exe`, `Direct-Xfer.ServerHost.exe`, `Direct-Xfer-Setup-<version>.exe`
- Build system: GitHub Actions, GitHub-hosted `windows-2025` runner
- Build workflow: `.github/workflows/build-windows-csharp.yml`

## Short description

Direct-Xfer is a self-hosted file sharing, file reception, image hosting and cloud-storage integration platform for Docker and Windows. The Windows package provides a native launcher and background ServerHost for the same Direct-Xfer application.

## Code signing scope

Only binaries maintained by the Direct-Xfer project are submitted for signing:

- `Direct-Xfer.exe`
- `Direct-Xfer.ServerHost.exe`
- the final Direct-Xfer Inno Setup installer

Third-party runtimes and tools are not submitted for signing with the Direct-Xfer/SignPath Foundation certificate. The launcher and ServerHost are signed before they are embedded in the installer, then the installer is signed in a second request.

## Release provenance and approval

- Signing is initiated only by an explicit manual GitHub Actions workflow dispatch.
- The signing gate is restricted to `ManixQC/Direct-Xfer` and `main` or the exact release tag.
- Every SignPath signing request requires manual approval.
- The SignPath action uses the GitHub artifact ID so SignPath can verify the build origin.
- GitHub and SignPath MFA must remain enabled for release-signing accounts.

## Artifact metadata policy

All signed Direct-Xfer PE files enforce:

- Product name: `Direct-Xfer`
- Product version: the same current Direct-Xfer release version for every signed binary in that build
- Company: `Direct-Xfer`
- Copyright: `Copyright © Direct-Xfer 2026`
- Original filename: enforced per artifact

Launcher and ServerHost `FileVersion` values are component-scoped and may remain stable when only application/runtime content changes. Their common `ProductVersion` is always the current Direct-Xfer release for the signing build.

## Privacy and installation

- Privacy policy: `PRIVACY.md`
- Code signing policy: `CODE_SIGNING_POLICY.md`
- The Windows installer displays the privacy policy before installation.
- Automatic update checks and public-IP discovery are visible installer choices and remain configurable after installation.
- The installer provides normal Windows uninstallation support.
- Direct-Xfer does not contain advertising or application telemetry. Network access occurs for documented product functions or endpoints/services selected/configured by the operator.

## Public repository checklist before submission

- [ ] A public release exists in the form that should be signed.
- [ ] Repository description clearly describes Direct-Xfer functionality.
- [ ] README visibly links a heading named **Code signing policy**.
- [ ] `CODE_SIGNING_POLICY.md` lists committer/reviewer and signing approver roles.
- [ ] `PRIVACY.md` is public and documents outbound-network behavior.
- [ ] GitHub MFA is enabled for the maintainer/release account.
- [ ] No proprietary Direct-Xfer-owned binary is included outside the public source/build process.
- [ ] The Windows build workflow and artifact configurations are committed publicly.
