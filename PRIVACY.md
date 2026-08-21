# Direct-Xfer privacy

Direct-Xfer is self-hosted. It does not include advertising, analytics SDKs, or usage telemetry sent to the Direct-Xfer project. Files, link metadata, accounts, audit data, and configuration remain on systems controlled by the operator unless the operator enables or uses a feature that communicates with another system.

## Outbound network requests

Direct-Xfer may make the following documented outbound requests:

- **Update checks:** enabled by default. On Windows, the installer shows an explicit **Allow automatic update checks** option before first launch; the same setting remains editable in Direct-Xfer. When enabled, Direct-Xfer queries Docker Hub for published image tags.
- **Public IP discovery / network diagnostics:** public-IP discovery is enabled by default. On Windows, the installer shows an explicit **Allow public IP discovery at startup** option, and the setting remains editable later. When enabled, Direct-Xfer queries `api.ipify.org`, `ifconfig.me/ip`, or `icanhazip.com` to learn the server's public IP. Port/reachability checks are never run automatically; they run only after the operator requests a test for their Direct-Xfer endpoint.
- **Operator-configured integrations:** SMTP, webhooks, Google OAuth, cloud-storage/rclone remotes, reverse proxies and other destinations are contacted only when configured or used by the operator.
- **Optional Windows components:** rclone and Tesseract are downloaded only after the operator activates those optional components. The Windows build also includes the runtimes documented in the release package.
- **User-requested transfers:** sharing, reception, collaboration and cloud import/export necessarily transfer data to the endpoints selected by the operator or user.

These requests are functional application traffic, not project telemetry. Operators can disable both update checks and public-IP discovery during Windows installation or later in Direct-Xfer settings, and can choose whether to configure optional integrations. Docker/advanced deployments can also set `UPDATE_CHECK=false`; public-IP discovery is controlled by the persisted Direct-Xfer privacy setting. Direct-Xfer does not sell user data.

## Third-party services

When an operator enables a third-party service, that service's own privacy terms apply to traffic sent to it. Direct-Xfer displays or documents the relevant integration so the operator can make that choice.
