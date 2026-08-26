# SignPath Foundation setup for Direct-Xfer

Direct-Xfer 1.71.28 is prepared for SignPath Foundation Open Source Code Signing. Source-side preparation is complete; the remaining work is the one-time external SignPath approval/configuration and GitHub secret/variable setup.

## 1. Apply to SignPath Foundation

Apply at https://signpath.org/ with this public project:

- Repository: `https://github.com/ManixQC/Direct-Xfer`
- License: MIT (`LICENSE`)
- Code signing policy: `CODE_SIGNING_POLICY.md`
- Privacy policy: `PRIVACY.md`
- Windows build workflow: `.github/workflows/build-windows-csharp.yml`
- Prepared application notes: `signpath/FOUNDATION_APPLICATION.md`

Keep MFA enabled on both GitHub and SignPath. Authorize the SignPath GitHub integration for `ManixQC/Direct-Xfer` when requested.

## 2. Create the SignPath project configuration

After the Open Source subscription is approved, create/use one SignPath project and one manually approved release signing policy. Import these artifact configurations:

- `signpath/artifact-configuration-executables.xml`
- `signpath/artifact-configuration-installer.xml`

The executable configuration signs only Direct-Xfer's own launcher and ServerHost. Its `version` parameter is the Direct-Xfer release version and is enforced as the **ProductVersion on both signed executables**, as required by the Foundation policy. Component-scoped `FileVersion` values remain separate through `launcherFileVersion` and `serverHostFileVersion`.

The installer configuration signs the final Inno Setup EXE after the already-signed launcher and ServerHost have been embedded. Third-party runtimes/tools are never signed using the Direct-Xfer certificate.

## 3. Configure GitHub repository settings

Create this **Actions secret**:

- `SIGNPATH_API_TOKEN` — SignPath API token with submitter permission for the Direct-Xfer release signing policy.

Create these **Actions variables**:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_EXECUTABLES_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG`

The workflow does not store the API token or tenant identifiers in source control. SignPath signing is fail-closed unless all settings are present.

## 4. Release-signing safety gates

A signing-enabled workflow run is accepted only when all of these are true:

1. the run was started manually with `workflow_dispatch`;
2. the repository is exactly `ManixQC/Direct-Xfer`;
3. the ref is `main` or the exact release tag `v<DX_VERSION>`;
4. package, lockfile, OAuth broker and Cloudflare Worker package versions all equal `DX_VERSION`;
5. the fresh Direct-Xfer EXEs are unsigned before submission;
6. both EXEs have `ProductName=Direct-Xfer`, `CompanyName=Direct-Xfer`, the common release `ProductVersion`, and the expected component `FileVersion`;
7. SignPath returns a Windows-trusted `Valid` Authenticode signature before any signed file is packaged or published.

Push builds remain unsigned and do not create SignPath signing requests.

## 5. Produce a signed Windows release

Open **Actions → Build Direct-Xfer Windows C# + Installer → Run workflow**, choose `main` (or the exact release tag), and enable **Sign this Windows release with SignPath Foundation**.

The workflow will:

1. build and test Direct-Xfer on `windows-2025`;
2. build the launcher and ServerHost with the current Direct-Xfer release as PE ProductVersion while preserving their component FileVersion values;
3. verify both fresh EXEs are unsigned and their metadata matches the artifact configuration;
4. upload both EXEs as a GitHub artifact and submit SignPath signing request 1;
5. wait up to one hour for the required manual SignPath approval;
6. validate the returned Authenticode signatures and install the signed EXEs into the portable tree;
7. build the Inno Setup installer from those signed EXEs;
8. upload the installer and submit SignPath signing request 2;
9. wait for manual approval and validate the signed installer;
10. publish the final portable and installer GitHub Actions artifacts.

The SignPath GitHub action receives the current GitHub artifact ID and explicit `GITHUB_TOKEN`; repository permissions are limited to `contents: read` and `actions: read`.

## 6. Release page requirement

Use `signpath/RELEASE_NOTES_TEMPLATE.md` for every Windows GitHub release/download page. Every signed Windows release page must contain a visible **Code signing policy** heading/link and the Foundation attribution:

`Free code signing provided by SignPath.io, certificate by SignPath Foundation.`

Record the final SHA-256 values from the exact signed artifacts published to the release.

## 7. Smart App Control expectation

Unsigned Direct-Xfer Windows builds can still be blocked by Windows Smart App Control because Windows cannot verify their publisher. The intended public Windows downloads are the artifacts from a successful signing-enabled workflow after SignPath Foundation approval. Do not present an unsigned development artifact as a signed release.
