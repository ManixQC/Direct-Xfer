# SignPath Foundation setup for Direct-Xfer

The repository is ready for SignPath Foundation Open Source Code Signing. The remaining steps require the repository owner to complete SignPath's external approval process once.

## 1. Apply to SignPath Foundation

Apply at https://signpath.org/ and use this repository as the source project:

- Repository: `https://github.com/ManixQC/Direct-Xfer`
- License: MIT (`LICENSE`)
- Code signing policy: `CODE_SIGNING_POLICY.md`
- Privacy policy: `PRIVACY.md`
- Windows build workflow: `.github/workflows/build-windows-csharp.yml`

Keep MFA enabled on both GitHub and SignPath. Install/authorize the SignPath GitHub App for the Direct-Xfer repository when SignPath asks for it.

## 2. Create the SignPath project configuration

After the OSS subscription is approved, create or use one project and one release signing policy. Import these two artifact configurations into that project:

- `signpath/artifact-configuration-executables.xml`
- `signpath/artifact-configuration-installer.xml`

Both configurations require a `version` signing-request parameter. The first signs only Direct-Xfer's own launcher and ServerHost. The second signs the Inno Setup EXE after it has been rebuilt with those signed executables inside.

## 3. Configure GitHub repository settings

Create this **Actions secret**:

- `SIGNPATH_API_TOKEN` — SignPath API token with submitter permission for the project/signing policy.

Create these **Actions variables**:

- `SIGNPATH_ORGANIZATION_ID`
- `SIGNPATH_PROJECT_SLUG`
- `SIGNPATH_SIGNING_POLICY_SLUG`
- `SIGNPATH_EXECUTABLES_ARTIFACT_CONFIGURATION_SLUG`
- `SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG`

The workflow deliberately does not hard-code SignPath tenant IDs/slugs and never stores the API token in source control.

## 4. Produce a signed Windows release

Open **Actions → Build Direct-Xfer Windows C# + Installer → Run workflow** and enable **Sign this Windows release with SignPath Foundation**.

The workflow will:

1. build and test the project on `windows-2025`;
2. verify the fresh Direct-Xfer executables are unsigned;
3. upload the launcher and ServerHost as a GitHub artifact and submit signing request 1;
4. wait up to one hour for the required manual SignPath approval;
5. validate and install the signed executables into the package;
6. build the Inno Setup installer containing those signed executables;
7. upload the installer and submit signing request 2;
8. wait for manual approval, validate the returned installer signature, and publish the final artifacts.

Regular push builds remain unsigned and do not consume signing requests. This prevents development commits from creating release-approval work.

## 5. Release-page requirement

Use `signpath/RELEASE_NOTES_TEMPLATE.md` for every Windows GitHub release/download page. It contains the required **Code signing policy** heading, the Foundation attribution, source/repository links and a place to record SHA-256 values and signing status.


On every GitHub release/download page for signed Windows binaries, include a link to `CODE_SIGNING_POLICY.md` and identify SignPath Foundation as the certificate publisher. This is a SignPath Foundation OSS requirement.

## 6. GitHub project metadata before Foundation review

Recommended public repository description:

`Self-hosted file sharing, reception, image hosting and cloud storage platform for Docker and Windows.`

Recommended GitHub topics: `self-hosted`, `file-sharing`, `file-transfer`, `docker`, `windows`, `pwa`, `image-hosting`.

These are repository settings rather than source files, so update them in the GitHub **About** panel before or while the Foundation application is reviewed.
