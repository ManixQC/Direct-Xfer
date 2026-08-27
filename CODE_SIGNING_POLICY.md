# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Team roles

- **Committer and reviewer:** [ManixQC](https://github.com/ManixQC)
- **Signing approver:** [ManixQC](https://github.com/ManixQC)

Changes from contributors who do not have direct commit access must be reviewed before merge. Every SignPath Foundation release signing request requires manual approval. Multi-factor authentication must remain enabled for the GitHub and SignPath accounts used for release signing.

## Build and signing rules

Windows binaries are built only by the repository's GitHub Actions workflow on GitHub-hosted Windows runners. Every build may publish clearly labelled `-UNSIGNED` preview artifacts for development/testing; those previews are intentionally not Authenticode-signed, are never presented under canonical signed-release artifact names, and receive no final-release provenance attestation. When an explicit `workflow_dispatch` requests SignPath signing, the unsigned previews are uploaded before the signing request so they remain available while manual approval is pending. Direct-Xfer's launcher and ServerHost are then signed first, copied into the portable payload, and the installer is rebuilt from those signed executables before the installer is signed in a second SignPath request. The workflow validates all three returned Authenticode signatures before publishing canonical portable/installer artifacts and before the separate provenance job can run.

The SignPath artifact configurations enforce Direct-Xfer product name, company, copyright and original-file metadata. Every Direct-Xfer binary signed in a release uses the same application release as its PE **ProductVersion**. The launcher and ServerHost keep component-scoped **FileVersion** values so unchanged component identities do not need artificial version bumps. Third-party runtimes and tools are not signed with the Direct-Xfer certificate.

The Windows installer displays `PRIVACY.md`, exposes automatic startup as a visible task, and presents explicit options for network functions that contact systems not chosen by the user (automatic update checks and public-IP discovery). These choices are applied to Direct-Xfer settings and remain editable after installation.

## Privacy

See [PRIVACY.md](PRIVACY.md). Direct-Xfer does not contain advertising or telemetry. It does make limited outbound requests for documented application functions, including update checks and public-IP discovery, and it can contact services explicitly configured or invoked by the operator (for example SMTP/webhooks, OAuth/cloud storage, optional component downloads, and reverse-proxy or storage endpoints).

## Source and releases

Source repository: https://github.com/ManixQC/Direct-Xfer

Release/download pages should link back to this **Code signing policy** so users can verify how Windows binaries are produced and signed.
