# Direct-Xfer OWASP ZAP DAST target

GitHub Code Scanning requires every SARIF result to have a stable repository location. Dynamic ZAP findings are anchored to this file while the actual scanned URL is retained in each alert message and SARIF location message.

The workflow scans only the ephemeral local Direct-Xfer instance started by `.github/workflows/zap.yml`.
