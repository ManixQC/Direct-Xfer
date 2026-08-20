# Direct-Xfer OAuth Broker

This service centralizes Google OAuth for every Direct-Xfer installation. Individual Direct-Xfer servers do **not** need a Google Client ID, Client Secret, JSON key, or per-domain callback registration.


## Public broker (recommended): Cloudflare Workers

For a broker that is genuinely reachable from browsers and Direct-Xfer instances on different machines, use `cloudflare-worker/`. It deploys the same broker API to Cloudflare Workers, stores encrypted credentials in D1, and gets a stable HTTPS `workers.dev` URL without requiring a dedicated server.

On Windows:

```powershell
cd oauth-broker\cloudflare-worker
.\scripts\deploy.ps1
```

The script prints the broker URL, the single Google callback to register centrally, and the `DIRECT_XFER_OAUTH_BROKER_URL` value to use on Direct-Xfer instances.

## One-time central deployment

1. Deploy this service behind HTTPS, for example `https://oauth.example.com`.
2. In Google Cloud, create **one** OAuth client of type **Web application** for the broker.
3. Enable Google Drive API for that project.
4. Add exactly this authorized redirect URI: `https://oauth.example.com/v1/google/callback`.
5. Configure the broker environment variables shown in `docker-compose.yml`.
6. Point every Direct-Xfer instance at the broker with `DIRECT_XFER_OAUTH_BROKER_URL=https://oauth.example.com`.

Only the central broker stores the Google Web client secret and Google refresh tokens. Each Direct-Xfer remote receives a unique broker credential. Rclone refreshes Drive access tokens through the broker's OAuth-compatible `/v1/google/token` endpoint.

## Security model

- OAuth state + PKCE protect the browser authorization flow.
- Google refresh tokens are AES-256-GCM encrypted at rest.
- The Google Web client secret never leaves the broker.
- Per-remote broker credentials are randomly generated and can only refresh the one Google grant attached to them.
- Session poll tokens are short-lived and never sent to the browser.
- Rate limits are applied to session creation and token refresh.
- Use HTTPS in production and persist `/data` plus `DIRECT_XFER_OAUTH_BROKER_DATA_KEY`.

## Production checklist for the public Google broker

Since Direct-Xfer 1.67.30, the public broker defaults to the least-privilege `drive.file` scope. `drive.readonly` is requested only for explicit read-only access to all existing Drive files, and the full `drive` scope only for explicit read/write access to existing Drive content. Before exposing a restricted-scope mode broadly, move the Google OAuth app out of Testing and complete the Google verification/security requirements that apply. Keep the broker encryption key stable for the lifetime of the stored credentials; redeploying code must never rotate it implicitly. The Cloudflare deployment scripts preserve an existing `BROKER_DATA_KEY` automatically.
